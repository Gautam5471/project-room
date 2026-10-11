import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T, replay } from "../src/events.js";
import { setTier } from "../server/autonomy-tiers.mjs";
import { menuOpensUp, conversationIndex, searchMessages, ConversationDrafts, DraftRecovery, messageCluster, mentionQuery, mentionMatches, insertMention, mentionHtml, GROUP_WINDOW_MS, kindLabel, memberStatus, memberHandle, memberPresence, memberOnLine, memberDoneChip, presenceLabel, addressMember, shouldAddressPresenceClick, messageMentionsMember, replyAuthorToAddress, escapeChatAction, composerPlaceholder, removeMention, parseSearchQuery, messageAddressesMember, reactionPills, REACTIONS } from "../src/conversation.js";
import { draftCommand } from "../src/client.js";

function room(t) {
  const directory = mkdtempSync(join(tmpdir(), "conversation-")), filename = join(directory, "room.sqlite");
  let store = new RoomStore(filename);
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  const send = (key, type, data, id = crypto.randomUUID()) => store.command(key, "commons", { id, type, data });
  for (const kind of ["human", "agent"]) send(owner, T.MEMBER_ADDED, { memberId: kind, displayName: kind, kind, permissions: [] });
  // Graduated autonomy tiers: the fixture agent is operator-promoted so the
  // conversation tests exercise it as a posting member.
  setTier(store.db, "commons", "agent", "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  const human = store.issueAccessKey("commons", "human"), agent = store.issueAccessKey("commons", "agent");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { get store() { return store; }, owner, human, agent, send, restart() { store.close(); store = new RoomStore(filename); } };
}

test("historical reply chains form one thread and survive restart without copying messages", t => {
  const f = room(t);
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "topic", body: "A place to hang out" });
  f.send(f.agent, T.MESSAGE_POSTED, { messageId: "reply", body: "A reading club?", replyToId: "topic" });
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "nested", body: "Yes, science fiction", replyToId: "reply" });
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "other-topic", body: "Coffee?" });
  const before = f.store.snapshot(f.human, "commons").state;
  f.restart();
  const after = f.store.snapshot(f.human, "commons").state;
  assert.deepEqual(after, before);
  const index = conversationIndex(after.messages);
  assert.deepEqual(index.roots.map(m => m.id), ["topic", "other-topic"]);
  assert.deepEqual(index.threads.get("topic").map(m => m.id), ["topic", "reply", "nested"]);
  assert.equal(index.rootById.get("nested"), "topic");
  assert.equal(after.messages.length, 4);
  assert.equal(Object.keys(after.workItems).length, 0);
  assert.deepEqual(replay(after.eventLog).messages, after.messages);
  f.send(f.owner, T.WORK_PROPOSED, { workItemId: "reading", title: "Choose a book", definitionOfDone: "A shortlist", accountableMemberId: "owner", sourceMessageId: "nested" });
  assert.equal(f.store.snapshot(f.owner, "commons").state.workItems.reading.sourceMessageId, "nested");
});

test("reaction choices belong to their actors and old retries never reverse a later removal", t => {
  const f = room(t);
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "topic", body: "Friday gathering" });
  const before = f.store.snapshot(f.owner, "commons").state;
  const choice = { messageId: "topic", reaction: "heart", active: true };
  const first = f.send(f.human, T.MESSAGE_REACTION_SET, choice, "like-once");
  f.send(f.agent, T.MESSAGE_REACTION_SET, choice);
  f.send(f.human, T.MESSAGE_REACTION_SET, choice);
  assert.deepEqual(f.store.snapshot(f.owner, "commons").state.messages[0].reactions["❤️"], ["agent", "human"]);
  f.send(f.human, T.MESSAGE_REACTION_SET, { ...choice, active: false });
  f.restart();
  const retry = f.send(f.human, T.MESSAGE_REACTION_SET, choice, "like-once");
  assert.equal(retry.duplicate, true); assert.equal(retry.sequence, first.sequence);
  const after = f.store.snapshot(f.owner, "commons").state;
  assert.deepEqual(after.messages[0].reactions["❤️"], ["agent"]);
  assert.deepEqual(after.members, before.members); assert.deepEqual(after.workItems, before.workItems);
  assert.deepEqual(replay(after.eventLog).messages, after.messages);
});

test("invalid or unauthorized conversation references leave both history and projection unchanged", t => {
  const f = room(t);
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "topic", body: "Local discussion" });
  f.store.initialize(initialRoom("separate", "elsewhere"));
  const elsewhere = f.store.issueAccessKey("separate", "elsewhere");
  f.store.command(elsewhere, "separate", { id: "foreign-message", type: T.MESSAGE_POSTED, data: { messageId: "foreign", body: "Other room" } });
  const before = f.store.snapshot(f.owner, "commons");
  for (const data of [
    { messageId: "foreign", reaction: "heart", active: true },
    { messageId: "topic", reaction: "unbounded-choice", active: true },
    { messageId: "topic", reaction: "heart", active: "yes" },
    { messageId: "topic", reaction: "heart", active: true, memberId: "owner" }
  ]) assert.throws(() => f.send(f.human, T.MESSAGE_REACTION_SET, data));
  assert.throws(() => f.send(f.human, T.MESSAGE_POSTED, { body: "Reply", replyToId: "foreign" }));
  assert.throws(() => f.store.snapshot(elsewhere, "commons"), /does not grant access/);
  assert.deepEqual(f.store.snapshot(f.owner, "commons"), before);
  f.send(f.owner, T.MEMBER_ACCESS_CHANGED, { memberId: "human", expectedMemberRevision: 0, permissions: [], active: false });
  const removed = f.store.snapshot(f.owner, "commons");
  assert.throws(() => f.send(f.human, T.MESSAGE_REACTION_SET, { messageId: "topic", reaction: "heart", active: true }), /revoked/);
  assert.deepEqual(f.store.snapshot(f.owner, "commons"), removed);
});

test("search finds older replies outside the audit tail, is literal, bounded, and does not mutate the room", t => {
  const f = room(t);
  f.send(f.human, T.MESSAGE_POSTED, { messageId: "topic", body: "Book club" });
  f.send(f.agent, T.MESSAGE_POSTED, { messageId: "target", body: "Dune [edition] <paperback>", replyToId: "topic" });
  let at = Date.now();
  f.store.now = () => at;
  for (let i = 0; i < 110; i++) { at += 2000; f.send(f.human, T.MESSAGE_POSTED, { body: `Update ${i}` }); }
  const snapshot = f.store.snapshot(f.human, "commons"), before = JSON.stringify(snapshot);
  assert.equal(snapshot.state.eventLog.length, 100);
  assert.equal(searchMessages(snapshot.state, "DUNE [edition]").messages[0].id, "target");
  assert.equal(searchMessages(snapshot.state, "<paperback>").total, 1);
  assert.equal(searchMessages(snapshot.state, "agent").total, 1);
  assert.equal(searchMessages(snapshot.state, ".*").total, 0);
  assert.equal(searchMessages(snapshot.state, "  ").total, 0);
  assert.equal(searchMessages(snapshot.state, "update").messages.length, 50);
  assert.equal(searchMessages(snapshot.state, "update").total, 110);
  assert.equal(JSON.stringify(snapshot), before);
});

test("search can list messages that address you without a new inbox", () => {
  assert.deepEqual(parseSearchQuery("  "), { term: "", mentionsOnly: false });
  assert.deepEqual(parseSearchQuery("@me"), { term: "", mentionsOnly: true });
  assert.deepEqual(parseSearchQuery("mentions:me book"), { term: "book", mentionsOnly: true });
  assert.deepEqual(parseSearchQuery("to:me"), { term: "", mentionsOnly: true });
  assert.equal(parseSearchQuery("@meow").mentionsOnly, false);
  assert.equal(parseSearchQuery("@Maya").mentionsOnly, false);
  const maya = { id: "human", displayName: "Maya" };
  const instinct = { id: "agent", displayName: "Instinct" };
  assert.equal(messageAddressesMember({ body: "hi @Maya", toMemberId: null }, maya), true);
  assert.equal(messageAddressesMember({ body: "quiet", toMemberId: "human" }, maya), true);
  assert.equal(messageAddressesMember({ body: "@Mayafoo", toMemberId: null }, maya), false);
  assert.equal(messageAddressesMember({ body: "hi @Maya" }, instinct), false);
  const state = {
    members: { human: maya, agent: instinct },
    messages: [
      { id: "ping", body: "hi @Maya", authorId: "agent", toMemberId: null },
      { id: "to", body: "quiet note", authorId: "agent", toMemberId: "human" },
      { id: "noise", body: "unrelated", authorId: "agent" },
      { id: "false", body: "@Mayafoo", authorId: "agent" }
    ]
  };
  const hits = searchMessages(state, "", 50, { viewer: maya, mentionsOnly: true });
  assert.deepEqual(hits.messages.map(m => m.id), ["to", "ping"]);
  assert.equal(hits.total, 2);
  assert.equal(hits.mentionsOnly, true);
  assert.equal(searchMessages(state, "@me quiet", 50, { viewer: maya }).messages[0].id, "to");
  assert.equal(searchMessages(state, "unrelated", 50, { viewer: maya }).total, 1);
  assert.equal(searchMessages(state, "", 50, { viewer: maya }).total, 0);
  assert.equal(searchMessages(state, "@meow", 50, { viewer: maya }).total, 0);
});

test("navigation preserves independent reply targets and retry IDs; a new session has no old drafts", () => {
  const drafts = new ConversationDrafts();
  const pending = draftCommand(null, T.MESSAGE_POSTED, { body: "Thread thought", replyToId: "reply" });
  drafts.save(null, { body: "Room thought", toMemberId: "human", error: "Room send failed" });
  drafts.save("topic", { body: "Thread thought", toMemberId: "agent", replyToId: "reply", pending, error: "Thread send failed" });
  drafts.save("second", { body: "Another thought" });
  assert.equal(drafts.get("topic").pending.command.id, pending.command.id);
  assert.equal(drafts.get("topic").replyToId, "reply");
  assert.equal(drafts.get("topic").error, "Thread send failed");
  assert.equal(drafts.get(null).error, "Room send failed");
  assert.equal(drafts.get(null).toMemberId, "human");
  drafts.clear("topic");
  assert.equal(drafts.get("topic").replyToId, "topic");
  assert.equal(drafts.get("topic").error, "");
  assert.equal(drafts.get(null).error, "Room send failed");
  assert.equal(drafts.get(null).body, "Room thought");
  const nextSession = new ConversationDrafts();
  assert.equal(nextSession.hasText(), false);
  assert.equal(nextSession.get(null).error, "");
});

test("consecutive same-author messages cluster until a new day or a different person", () => {
  const t0 = "2026-09-09T18:00:00.000Z";
  const t1 = new Date(Date.parse(t0) + GROUP_WINDOW_MS / 2).toISOString();
  const tLate = new Date(Date.parse(t0) + GROUP_WINDOW_MS + 1000).toISOString();
  const tNextDay = "2026-09-10T18:00:00.000Z";
  const messages = [
    { id: "a", authorId: "maya", createdAt: t0 },
    { id: "b", authorId: "maya", createdAt: t1 },
    { id: "c", authorId: "jordan", createdAt: t1 },
    { id: "d", authorId: "maya", createdAt: tLate },
    { id: "e", authorId: "maya", createdAt: tNextDay }
  ];
  assert.equal(messageCluster(messages, 0).grouped, false);
  assert.equal(messageCluster(messages, 0).dayStart, true);
  assert.equal(messageCluster(messages, 1).grouped, true);
  assert.equal(messageCluster(messages, 2).grouped, false);
  assert.equal(messageCluster(messages, 3).grouped, false);
  assert.equal(messageCluster(messages, 4).dayStart, true);
  assert.equal(messageCluster(messages, 4).grouped, false);
});

test("composer @ query picks people and agents and mention HTML stays escaped", () => {
  assert.equal(mentionQuery("hello", 5), null);
  assert.deepEqual(mentionQuery("hi @In", 6), { start: 3, query: "In" });
  const members = [
    { id: "instinct", displayName: "Instinct", kind: "agent", active: true },
    { id: "maya", displayName: "Maya", kind: "human", active: true },
    { id: "gone", displayName: "Gone", kind: "human", active: false }
  ];
  assert.deepEqual(mentionMatches(members, "in").map(m => m.id), ["instinct"]);
  assert.equal(mentionMatches(members, "").length, 2);
  const inserted = insertMention("hi @In", 6, 3, members[0]);
  assert.equal(inserted.body, "hi @Instinct ");
  assert.equal(inserted.toMemberId, "");
  const esc = value => String(value).replaceAll("<", "&lt;");
  assert.match(mentionHtml("Ask @Instinct tomorrow", members, esc), /mention agent/);
  assert.match(mentionHtml("Ask @Instinct tomorrow", members, esc), /data-mention-id="instinct"/);
  assert.equal(mentionHtml("Ask <script> @Maya", members, esc).includes("<script>"), false);
  assert.match(mentionHtml("Ask <script> @Maya", members, esc), /mention"/);
  assert.equal(messageMentionsMember("Ask @Maya tomorrow", members[1]), true);
  assert.equal(messageMentionsMember("Ask @Mayafoo", members[1]), false);
  assert.equal(messageMentionsMember("@Maya", members[1]), true);
  assert.equal(messageMentionsMember("Ask @Instinct", members[1]), false);
  assert.equal(replyAuthorToAddress("maya", members[0])?.id, "instinct");
  assert.equal(replyAuthorToAddress("instinct", members[0]), null);
  assert.equal(replyAuthorToAddress("maya", members[2]), null);
  assert.equal(replyAuthorToAddress("potter", members[1])?.kind, "human");
  assert.equal(kindLabel("agent"), "Agent");
  assert.equal(kindLabel("human"), "Person");
  assert.equal(kindLabel("agent") === kindLabel("human"), false);
  assert.equal(memberStatus({ kind: "agent", active: true }), "Agent");
  assert.equal(memberStatus({ kind: "human", active: true }), "Person");
  assert.equal(memberStatus({ kind: "agent", active: false }), "access revoked");
  assert.equal(memberHandle({ kind: "agent", displayName: "Codex" }), "@Codex");
  assert.equal(memberHandle({ kind: "human", displayName: "Maya" }), "Maya");
  assert.equal(memberHandle({ kind: "agent", displayName: "Codex" }, "Codex (codex)"), "@Codex (codex)");
  assert.equal(presenceLabel("online"), "Online");
  const fromClick = addressMember("hello", 5, members[0]);
  assert.equal(fromClick.body, "hello @Instinct ");
  assert.equal(fromClick.toMemberId, "");
  const fromAt = addressMember("hi @In", 6, members[0]);
  assert.equal(fromAt.body, "hi @Instinct ");
  assert.equal(fromAt.toMemberId, insertMention("hi @In", 6, 3, members[0]).toMemberId);
});

function presenceTree() {
  const matches = (node, selector) => selector.split(",").map(part => part.trim()).some(part => {
    if (part.startsWith(".")) return (node.className || "").split(/\s+/).includes(part.slice(1));
    if (part.startsWith("#")) return node.id === part.slice(1);
    return node.tagName === part.toUpperCase();
  });
  const make = (tag, attrs = {}) => {
    const node = {
      tagName: tag.toUpperCase(), className: attrs.className || "", id: attrs.id || "", parentNode: null,
      closest(selector) { let n = this; while (n) { if (matches(n, selector)) return n; n = n.parentNode; } return null; },
      contains(other) { let n = other; while (n) { if (n === this) return true; n = n.parentNode; } return false; }
    };
    return node;
  };
  const panel = make("details", { id: "people-panel" });
  const panelSummary = make("summary", { id: "presence-title" });
  const list = make("div", { id: "presence-list" });
  const row = make("div", { className: "presence-member" });
  const name = make("strong");
  const inner = make("details");
  const innerSummary = make("summary");
  panelSummary.parentNode = panel;
  list.parentNode = panel;
  row.parentNode = list;
  name.parentNode = row;
  inner.parentNode = row;
  innerSummary.parentNode = inner;
  return { panel, panelSummary, name, innerSummary };
}

test("composer placeholder names the room, the thread, or the work mode", () => {
  assert.equal(composerPlaceholder({}), "Message #general");
  assert.equal(composerPlaceholder({ channelName: "design" }), "Message #design");
  assert.equal(composerPlaceholder({ inThread: true }), "Reply in thread");
  assert.equal(composerPlaceholder({ workKind: "request", inThread: true }), "What do you need?");
  assert.equal(composerPlaceholder({ workKind: "cancelled" }), "Reason…");
  assert.equal(composerPlaceholder({ workKind: "answered", inThread: true }), "Your reply…");
  assert.equal(composerPlaceholder({ workKind: null, inThread: false }).includes("Message…"), false);
});

test("removeMention strips one @Name token without eating longer names", () => {
  const maya = { id: "maya", displayName: "Maya" };
  assert.equal(removeMention("Ask @Maya tomorrow", maya), "Ask tomorrow");
  assert.equal(removeMention("@Maya hello", maya), "hello");
  assert.equal(removeMention("hi @Maya", maya), "hi");
  assert.equal(removeMention("@Maya", maya), "");
  assert.equal(removeMention("Ask @Mayafoo", maya), "Ask @Mayafoo");
  assert.equal(removeMention("Ask @Maya @Maya", maya), "Ask @Maya");
  assert.equal(removeMention("hello", null), "hello");
  assert.equal(removeMention("Ask @Maya tomorrow", {}), "Ask @Maya tomorrow");
});

test("reaction pills list used emoji and fold legacy aliases into the same glyph", () => {
  assert.deepEqual(reactionPills(), []);
  assert.deepEqual(Object.keys(REACTIONS), ["like", "heart", "celebrate", "thinking"]);
  const used = reactionPills({ like: ["maya"], heart: ["maya", "instinct"], "🔥": ["ada"] });
  assert.equal(used.find(p => p.key === "👍").count, 1);
  assert.equal(used.find(p => p.key === "👍").symbol, "👍");
  assert.deepEqual(used.find(p => p.key === "❤️").memberIds, ["instinct", "maya"]);
  assert.equal(used.find(p => p.key === "🔥").count, 1);
  assert.equal(used.some(p => p.key === "🤔"), false);
  assert.equal(reactionPills({ like: ["maya"], "👍": ["maya"] }).find(p => p.key === "👍").count, 1);
});

test("Escape peels mention picker, then reply quote, then thread, and never implies clearing a draft", () => {
  assert.equal(escapeChatAction({ dialogOpen: true, mentionOpen: true, replyOpen: true, inThread: true }), null);
  assert.equal(escapeChatAction({ mentionOpen: true, replyOpen: true, inThread: true }), "hide-mentions");
  assert.equal(escapeChatAction({ replyOpen: true, inThread: true }), "clear-reply");
  assert.equal(escapeChatAction({ inThread: true }), "leave-thread");
  assert.equal(escapeChatAction({}), null);
  assert.equal(escapeChatAction({ mentionOpen: true, replyOpen: true }).includes("draft"), false);
});

test("People-panel wrapping details does not swallow a name click; inner capabilities summary does", () => {
  const { name, innerSummary, panelSummary } = presenceTree();
  assert.equal(shouldAddressPresenceClick(name), true);
  assert.equal(shouldAddressPresenceClick(innerSummary), false);
  assert.equal(shouldAddressPresenceClick(panelSummary), false);
});

test("People rail derives presence, one-line status, and Done chips from room work", () => {
  const now = Date.parse("2026-09-12T02:00:00.000Z");
  const codex = { id: "codex", displayName: "Codex", kind: "agent", active: true };
  const instinct = { id: "instinct", displayName: "Instinct", kind: "agent", active: true };
  const potter = { id: "potter", displayName: "Potter", kind: "human", active: true };
  const maya = { id: "maya", displayName: "Maya", kind: "human", active: true };
  const revoked = { id: "gone", displayName: "Gone", kind: "agent", active: false };
  const workItems = {
    review: {
      id: "work-spec-review",
      title: "Review the Project Room v0 contract",
      state: "completed",
      accountableMemberId: "codex",
      verifierMemberId: "instinct",
      independentVerificationRequired: true,
      ownerDecisionRequired: true,
      humanDecisionMakerId: "potter",
      receipt: { eventId: "evt-done", summary: "Four consistency corrections before implementation." },
      verification: { result: "pass" },
      updatedAt: "2026-09-05T09:30:00.000Z"
    },
    build: {
      id: "work-vertical-slice",
      title: "Build the first executable Room slice",
      state: "working",
      accountableMemberId: "codex",
      updatedAt: "2026-09-05T09:36:00.000Z"
    }
  };
  const messages = [{ id: "m1", authorId: "maya", createdAt: "2026-09-12T01:50:00.000Z" }];
  const ctx = { workItems, messages, now };
  assert.equal(memberPresence(codex, ctx), "unknown");
  assert.equal(memberPresence(potter, ctx), "online");
  assert.equal(memberPresence(instinct, ctx), "unknown");
  assert.equal(memberPresence(maya, ctx), "online");
  assert.equal(memberPresence(revoked, ctx), "offline");
  assert.equal(memberPresence({ ...codex, state: "unknown" }, ctx), "unknown");
  assert.equal(presenceLabel("unknown"), "No live signal");
  assert.equal(memberOnLine(codex, ctx), "Build the first executable Room slice");
  assert.equal(memberStatus(codex, ctx), "Assigned: Build the first executable Room slice");
  assert.equal(memberStatus(potter, ctx), "Review the Project Room v0 contract");
  assert.equal(memberStatus(instinct, ctx), "Agent");
  assert.equal(memberDoneChip(codex, ctx)?.label, "Done");
  assert.equal(memberDoneChip(codex, ctx)?.workItemId, "work-spec-review");
  assert.match(memberDoneChip(codex, ctx)?.title, /consistency corrections/);
  assert.equal(memberDoneChip(instinct, ctx), null);
  assert.equal(memberDoneChip(potter, ctx), null);
  assert.equal(memberDoneChip(revoked, { workItems }), null);
});

test("timeline window renders the newest messages and widens a page at a time", async () => {
  const { windowTimeline, windowToInclude, TIMELINE_WINDOW } = await import("../src/conversation.js");
  const rows = Array.from({ length: 5691 }, (_, index) => ({ id: `m${index}` }));
  const first = windowTimeline(rows);
  assert.equal(first.messages.length, TIMELINE_WINDOW);
  assert.equal(first.hidden, 5691 - TIMELINE_WINDOW);
  assert.equal(first.messages.at(-1).id, "m5690", "the newest message is always shown");
  assert.equal(first.messages[0].id, `m${5691 - TIMELINE_WINDOW}`);
  const small = windowTimeline(rows.slice(0, 50));
  assert.equal(small.hidden, 0);
  assert.equal(small.messages.length, 50);
  assert.equal(windowToInclude(rows, "m5690"), TIMELINE_WINDOW, "a visible message needs no widening");
  assert.equal(windowToInclude(rows, "nope"), TIMELINE_WINDOW, "an unknown id changes nothing");
  const widened = windowToInclude(rows, "m0");
  assert.ok(widened >= 5691 && widened % TIMELINE_WINDOW === 0, `window ${widened} must include the oldest message`);
  assert.equal(windowTimeline(rows, widened).hidden, 0);
  const mid = windowToInclude(rows, "m5000");
  assert.ok(windowTimeline(rows, mid).messages.some(row => row.id === "m5000"));
});


test("assistant drafts recover independently of the destination thread and reject changed scope", () => {
  const state = { members: { owner: {}, peer: {} }, channels: { design: { id: 'design' } }, messages: [
    { id: 'root', channelId: 'design', replyToId: null, toMemberId: null, body: 'Design' },
    { id: 'ask', channelId: 'design', replyToId: 'root', toMemberId: null, body: 'Help us' }
  ] };
  const memory = new Map(), recovery = new DraftRecovery({ getItem: k => memory.get(k), setItem: (k,v) => memory.set(k,v), removeItem: k => memory.delete(k) }, () => 1000);
  const drafts = new ConversationDrafts(), key = 'assistant:run';
  const assistantDraft = { action: 'contribute', runId: 'run', sourceMessageId: 'ask', expectedRevision: 4, conflict: false };
  const data = { messageId: 'addition', body: 'Keep it simple', toMemberId: null, replyToId: 'ask', channelId: 'design' };
  const pending = draftCommand(null, 'message.posted', data);
  drafts.save('root', { body: 'Private unfinished thought', toMemberId: 'peer', replyToId: 'root', channelId: 'design' });
  drafts.save(key, { ...data, toMemberId: '', assistantDraft, pending });
  recovery.write('scope', drafts, 'root', key);
  const saved = memory.get(recovery.key), restored = recovery.read('scope', state);
  assert.equal(restored.activeKey, key); assert.equal(restored.threadId, 'root');
  assert.deepEqual(restored.drafts.get(key).assistantDraft, assistantDraft);
  assert.deepEqual(restored.drafts.get(key).pending, pending);
  assert.equal(restored.drafts.get('root').body, 'Private unfinished thought');
  assert.equal(restored.drafts.get('root').toMemberId, 'peer');
  assert.equal(restored.drafts.get('root').replyToId, 'root');
  for (const patch of [{ toMemberId: 'peer' }, { replyToId: 'root' }, { channelId: 'general' },
    { assistantDraft: { ...assistantDraft, action: 'cancel' } }, { assistantDraft: { ...assistantDraft, runId: 'other' } }]) {
    const changed = JSON.parse(saved); Object.assign(changed.entries.find(([id]) => id === key)[1], patch);
    memory.set(recovery.key, JSON.stringify(changed));
    assert.equal(recovery.read('scope', state).drafts.entries.has(key), false);
  }
});

test("a message overflow menu opens upward only when it does not fit below and fits better above", () => {
  const box = { limitTop: 0, limitBottom: 600, menuHeight: 213 };
  assert.equal(menuOpensUp({ ...box, triggerTop: 100, triggerBottom: 120 }), false, "room below keeps it downward");
  assert.equal(menuOpensUp({ ...box, triggerTop: 440, triggerBottom: 460 }), true, "newest message by the composer flips up");
  assert.equal(menuOpensUp({ ...box, triggerTop: 40, triggerBottom: 60, limitBottom: 200 }), false, "no better room above stays downward");
});
