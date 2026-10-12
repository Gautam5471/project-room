import { replyDraftKey, validReplyDraft, replyDraftData } from "./reply-requests.js";
import { LEGACY_REACTIONS, foldedReactionMap, renderEmojiShortcodes } from "./emoji.js";
// Conversation structure is derived from immutable reply links, including older logs.
// Legacy names remain the input aliases. Pills render the Unicode key.
export const REACTIONS = LEGACY_REACTIONS;

export function reactionPills(reactions = {}) {
  return Object.entries(foldedReactionMap(reactions)).map(([key, memberIds]) => (
    { key, symbol: key, memberIds, count: memberIds.length, used: memberIds.length > 0 }
  ));
}

// Composition, key repeat, and touch Return must never accidentally submit.
export function sendsOnEnter(event, touchKeyboard = false) {
  return event.key === "Enter" && !event.shiftKey && !event.altKey
    && !event.isComposing && event.keyCode !== 229 && !event.repeat
    && Boolean(!touchKeyboard || event.ctrlKey || event.metaKey);
}

export function escapeChatAction({ dialogOpen = false, mentionOpen = false, emojiOpen = false, replyOpen = false, inThread = false } = {}) {
  if (dialogOpen) return null;
  if (emojiOpen) return "hide-emoji";
  if (mentionOpen) return "hide-mentions";
  if (replyOpen) return "clear-reply";
  if (inThread) return "leave-thread";
  return null;
}

export const GROUP_WINDOW_MS = 7 * 60 * 1000;

export function dayKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function dayLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(d);
}

export function messageCluster(messages, index) {
  const m = messages[index], prev = index > 0 ? messages[index - 1] : null;
  const dayStart = !prev || dayKey(prev.createdAt) !== dayKey(m.createdAt);
  const grouped = Boolean(!dayStart && prev && prev.authorId === m.authorId
    && Math.abs(Date.parse(m.createdAt) - Date.parse(prev.createdAt)) <= GROUP_WINDOW_MS);
  return { grouped, dayStart, dayLabel: dayStart ? dayLabel(m.createdAt) : "" };
}

// Whether a message overflow menu should open upward: it does not fit between
// its trigger and the bottom limit (the composer's top edge, else the window),
// and there is more room above than below.
export function menuOpensUp({ triggerTop, triggerBottom, menuHeight, limitTop, limitBottom }) {
  const below = limitBottom - triggerBottom, above = triggerTop - limitTop;
  return menuHeight > below && above > below;
}
export function mentionQuery(text, caret) {
  const value = String(text ?? "");
  const pos = Number.isInteger(caret) ? Math.min(Math.max(caret, 0), value.length) : value.length;
  const before = value.slice(0, pos);
  const match = /(^|[\s])@([^\s@]{0,80})$/.exec(before);
  if (!match) return null;
  return { start: before.length - match[2].length - 1, query: match[2] };
}

export function mentionMatches(members, query) {
  const q = String(query ?? "").trim().toLocaleLowerCase();
  return (members || []).filter(m => m && m.active !== false && m.displayName
    && (!q || m.displayName.toLocaleLowerCase().includes(q) || String(m.id).toLocaleLowerCase().includes(q)))
    .slice(0, 8);
}

export function kindLabel(kind) {
  return kind === "agent" ? "Agent" : "Person";
}

// A People-row click addresses that member. The panel itself is a <details>;
// only disclosures *inside* the row (Room capabilities) should swallow the click.
export function shouldAddressPresenceClick(target) {
  const row = target?.closest?.(".presence-member");
  if (!row) return false;
  const block = target.closest("details, summary, button, a");
  return !(block && row.contains(block));
}

const PRESENCE_ONLINE_MS = 15 * 60 * 1000;
const RUNNING_SESSION = new Set(["processing", "active"]);
const ENGAGED_WORK = new Set(["accepted", "working", "blocked"]);

function workList(workItems) {
  return Object.values(workItems ?? {}).filter(item => item && typeof item === "object" && !item.supersededBy && item.state !== "superseded");
}

function waitingOnMember(item, memberId) {
  if (!item || item.supersededBy || item.state === "superseded") return false;
  if (item.accountableMemberId === memberId && (item.state === "proposed" || ENGAGED_WORK.has(item.state))) return true;
  if (item.independentVerificationRequired && item.verifierMemberId === memberId
    && item.state === "completed" && item.receipt?.eventId && !item.verification?.result) return true;
  if (item.ownerDecisionRequired && item.humanDecisionMakerId === memberId
    && item.state === "completed" && item.receipt?.eventId && !item.decision?.decision) return true;
  return false;
}

function latestStamp(item) {
  return item?.updatedAt || item?.heartbeat_at || item?.createdAt || "";
}

function byLatest(a, b) {
  return latestStamp(b).localeCompare(latestStamp(a)) || String(a.id).localeCompare(String(b.id));
}

// Loud @agent handle. Humans keep a readable name; IDs stay in details.
export function memberHandle(member, label) {
  const name = String(label ?? member?.displayName ?? "").trim();
  if (!name) return "";
  if (member?.kind !== "agent") return name;
  return name.startsWith("@") ? name : `@${name}`;
}

export function presenceLabel(presence) {
  // #660: server-derived states first, then the legacy local derivation.
  if (presence === "working") return "Working";
  if (presence === "listening") return "Listening";
  if (presence === "idle") return "Idle";
  if (presence === "unknown") return "No live signal";
  if (presence === "unreachable") return "Unreachable";
  return presence === "online" ? "Online" : presence === "offline" ? "Offline" : "Away";
}

// Presence is derived from room work + recent chat. No extra people-data store.
// #660: when the member carries a server-provided `state` (from the presence
// API), it wins — the server is authoritative. Otherwise fall back to the
// local online/offline/away derivation.
export function memberPresence(member, { workItems, messages, now } = {}) {
  if (!member || member.active === false) return "offline";
  if (member.state === "working" || member.state === "listening"
    || member.state === "idle" || member.state === "unreachable" || member.state === "unknown") return member.state;
  // Assignment and old chat are not observations of a reachable agent host.
  if (member.kind === "agent") return "unknown";
  const clock = Number.isFinite(now) ? now : Date.now();
  const items = workList(workItems);
  if (items.some(item => item.accountableMemberId === member.id
    && (ENGAGED_WORK.has(item.state) || RUNNING_SESSION.has(item.status)))) return "online";
  if (items.some(item => waitingOnMember(item, member.id))) return "online";
  const last = [...(messages || [])].reverse().find(message => message?.authorId === member.id);
  const at = last && Date.parse(last.createdAt ?? last.at);
  if (Number.isFinite(at) && clock - at < PRESENCE_ONLINE_MS) return "online";
  return "away";
}

// One-line “what they’re on”: current work title, else kind. Not a profile.
export function memberOnLine(member, { workItems, now } = {}) {
  if (!member || member.active === false) return "";
  const items = workList(workItems);
  const waiting = items.filter(item => waitingOnMember(item, member.id)).sort(byLatest);
  if (waiting[0]?.title) return waiting[0].title;
  const own = items.filter(item => item.accountableMemberId === member.id && item.state !== "completed").sort(byLatest);
  if (own[0]?.title) return own[0].title;
  return "";
}

export function memberStatus(member, context) {
  if (!member || member.active === false) return "access revoked";
  const line = context ? memberOnLine(member, context) : "";
  return line ? member.kind === "agent" ? `Assigned: ${line}` : line : kindLabel(member.kind);
}

// Compact Done receipt for an agent who posted completion. Not chat spam.
export function memberDoneChip(member, { workItems } = {}) {
  if (!member || member.kind !== "agent" || member.active === false) return null;
  const done = workList(workItems)
    .filter(item => item.receipt?.eventId && (item.accountableMemberId === member.id || item.receipt.producerId === member.id))
    .sort(byLatest)[0];
  if (!done) return null;
  const title = String(done.receipt.summary || done.title || "").trim();
  return { label: "Done", title, workItemId: done.id };
}

// Mentions are text only: inserting "@DisplayName" never changes a message's
// audience. A message becomes a direct message only when the sender
// explicitly picks a recipient in the composer ("Everyone" -> a member).
// Replying to or @-mentioning someone in the room stays public, room-visible
// chat; the @mention is just a highlight/notification for that member.
export function addressMember(text, caret, member) {
  if (!member?.displayName) return { body: String(text ?? ""), caret: Number.isInteger(caret) ? caret : String(text ?? "").length, toMemberId: "" };
  const found = mentionQuery(text, caret);
  if (found) return insertMention(text, caret, found.start, member);
  const value = String(text ?? "");
  const pos = Number.isInteger(caret) ? Math.min(Math.max(caret, 0), value.length) : value.length;
  const before = value.slice(0, pos), after = value.slice(pos);
  const padBefore = before && !/[\s]$/.test(before) ? " " : "";
  const label = `@${member.displayName}`;
  const padAfter = after.startsWith(" ") ? "" : " ";
  return { body: `${before}${padBefore}${label}${padAfter}${after}`, caret: before.length + padBefore.length + label.length + (padAfter ? 1 : 0), toMemberId: "" };
}

export function insertMention(text, caret, start, member) {
  const value = String(text ?? "");
  const pos = Number.isInteger(caret) ? caret : value.length;
  const at = Number.isInteger(start) ? start : 0;
  const label = `@${member.displayName}`;
  const after = value.slice(pos);
  const body = `${value.slice(0, at)}${label}${after.startsWith(" ") ? after : ` ${after}`}`;
  return { body, caret: at + label.length + (after.startsWith(" ") ? 0 : 1), toMemberId: "" };
}

const mentionRegExpSpecial = new Set(".*+?^${}()|[]\\");
const escapeMentionName = value => [...String(value)].map(ch => mentionRegExpSpecial.has(ch) ? `\\${ch}` : ch).join("");

// Presentation only: the original body remains the source for copy, search and
// message links. Native details keeps expansion usable without another handler.
export function messageBodyHtml(body, members, esc, messageId) {
  const text = String(body ?? "");
  const lines = text.split("\n");
  const full = mentionHtml(text, members, esc);
  if (text.length <= 1200 && lines.length <= 12) return full;
  const preview = renderEmojiShortcodes([...lines.slice(0, 6).join("\n")].slice(0, 600).join(""));
  return `<details class="message-expansion"><summary data-focus-key="message-expand:${esc(messageId)}"><span class="message-preview" aria-hidden="true">${esc(preview)}…</span><span class="message-show-more">Show more · ${lines.length} ${lines.length === 1 ? "line" : "lines"}</span><span class="message-show-less">Show less</span></summary><div class="message-full">${full}</div></details>`;
}

// Chat renders run on every arrival and used to rebuild every body's HTML
// (emoji, @mention chips, markdown): about 200 ms of each render at 3,000
// messages. The output is pure in (body, message id, mentionable members), so
// one entry per message id is kept and the whole cache resets when the members
// change. Callers pass a fresh members array per render pass (state.members is
// mutated in place), and the members key is recomputed only when that array
// or esc changes.
export function createBodyHtmlCache(render = messageBodyHtml, limit = 20000) {
  const entries = new Map();
  let lastMembers = null, lastEsc = null, membersKey = null;
  return {
    html(body, members, esc, messageId) {
      if (members !== lastMembers || esc !== lastEsc) {
        const key = [...(members || [])].map(m => [m?.id, m?.displayName ?? "", m?.kind ?? ""].join("\u0001")).join("\u0002");
        if (key !== membersKey || esc !== lastEsc) entries.clear();
        lastMembers = members; lastEsc = esc; membersKey = key;
      }
      const text = String(body ?? ""), hit = entries.get(messageId);
      if (hit && hit.body === text) return hit.html;
      if (entries.size >= limit) entries.clear();
      const html = render(text, members, esc, messageId);
      entries.set(messageId, { body: text, html });
      return html;
    }
  };
}

export function mentionHtml(body, members, esc) {
  const text = renderEmojiShortcodes(body);
  const names = [...(members || [])].filter(m => m?.displayName).sort((a, b) => b.displayName.length - a.displayName.length);
  if (!names.length) return markdownHtml(esc(text));
  const pattern = new RegExp(`@(?:${names.map(m => escapeMentionName(m.displayName)).join("|")})(?=\\s|$)`, "g");
  let out = "", last = 0, match;
  while ((match = pattern.exec(text))) {
    out += markdownHtml(esc(text.slice(last, match.index)));
    const label = match[0].slice(1);
    const member = names.find(m => m.displayName === label);
    const kind = member?.kind === "agent" ? " agent" : "";
    const chip = member?.id
      ? `<button type="button" class="mention${kind}" data-mention-id="${esc(member.id)}">${esc(match[0])}</button>`
      : `<span class="mention${kind}">${esc(match[0])}</span>`;
    out += chip;
    last = match.index + match[0].length;
  }
  return out + markdownHtml(esc(text.slice(last)));
}

// Discord-style markdown for message bodies. Input MUST already be HTML-escaped
// (esc() applied); output is safe HTML. Store raw, render at view — no server change.
const mdSlot = "\u0000md";
export function markdownHtml(escaped) {
  let text = String(escaped ?? "");
  const saved = [];
  const stash = html => {
    const key = `${mdSlot}${saved.length}${mdSlot}`;
    saved.push(html);
    return key;
  };
  // Fenced code blocks first (may span lines; inner markdown is literal).
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (m, lang, code) =>
    stash(`<code class="md-fence"${lang ? ` data-lang="${lang}"` : ""}>${code.replace(/\n$/, "")}</code>`));
  // Inline code (inner markdown is literal).
  text = text.replace(/`([^`\n]+)`/g, (m, code) => stash(`<code>${code}</code>`));
  // Bold: **x** and __x__ (underscore form needs boundaries so some_variable survives).
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[\s(])__([^_]+)__([\s).,;:!?]|$)/g, "$1<strong>$2</strong>$3");
  // Italic: *x* and _x_ with boundary guards.
  text = text.replace(/(^|[\s(])\*([^*\n]+)\*([\s).,;:!?]|$)/g, "$1<em>$2</em>");
  text = text.replace(/(^|[\s(])_([^_\n]+)_([\s).,;:!?]|$)/g, "$1<em>$2</em>");
  // Strikethrough and spoiler.
  text = text.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  text = text.replace(/\|\|([^|]+)\|\|/g, '<details class="md-spoiler"><summary>spoiler</summary>$1</details>');
  // Quotes: escaped &gt; at line start (esc() runs before this).
  text = text.replace(/^&gt; ?(.*)$/gm, '<span class="md-quote">$1</span>');
  // Autolink bare URLs (after code extraction so code spans stay literal).
  // The URL text is already escaped: quotes are &quot; so no attribute breakout.
  text = text.replace(/(^|[\s(])(https?:\/\/[^\s<>"')]+)/g, (m, pre, url) => {
    const clean = url.replace(/[.,;:!?]+$/, "");
    const tail = url.slice(clean.length);
    return `${pre}<a href="${clean}" target="_blank" rel="noopener noreferrer">${clean}</a>${tail}`;
  });
  // Simple lists, after inline marks so **bold** inside an item still works,
  // and before code is restored so a fence that contains "- item" stays literal.
  text = renderMarkdownLists(text);
  // Restore stashed code (placeholders carry no markdown-significant characters).
  for (let i = 0; i < saved.length; i++) text = text.split(`${mdSlot}${i}${mdSlot}`).join(saved[i]);
  return text;
}


// One level only. A marker is "- ", "* ", or "1. " at the start of a line,
// so "*italic*" and mid-line dashes stay as they are. Runs of the same
// marker kind become one list; a blank line or a different marker ends it.
function renderMarkdownLists(text) {
  const lines = text.split("\n");
  const bullet = /^[-*] (.+)$/;
  const ordered = /^\d+\. (.+)$/;
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const kind = bullet.test(lines[i]) ? "ul" : ordered.test(lines[i]) ? "ol" : "";
    if (!kind) { out.push(lines[i]); i += 1; continue; }
    const pattern = kind === "ul" ? bullet : ordered;
    const items = [];
    while (i < lines.length && pattern.test(lines[i])) {
      items.push(pattern.exec(lines[i])[1]);
      i += 1;
    }
    const lis = items.map(item => ["<li>", item, "</li>"].join("")).join("");
    out.push(["<", kind, " class=\"md-list\">", lis, "</", kind, ">"].join(""));
  }
  return out.join("\n");
}

export function composerPlaceholder({ workKind = null, inThread = false, channelName = "general" } = {}) {
  if (workKind === "request") return "What do you need?";
  if (workKind === "cancelled") return "Reason…";
  if (workKind) return "Your reply…";
  return inThread
    ? "Reply in thread"
    : `Message #${channelName}`;
}

export function removeMention(text, member) {
  if (!member?.displayName) return String(text ?? "");
  const label = `@${member.displayName}`;
  const value = String(text ?? "");
  let from = 0;
  while (from <= value.length) {
    const i = value.indexOf(label, from);
    if (i === -1) return value;
    const after = value[i + label.length];
    if (after == null || /\s/.test(after)) {
      let start = i, end = i + label.length;
      const spaceBefore = start > 0 && /\s/.test(value[start - 1]);
      const spaceAfter = end < value.length && /\s/.test(value[end]);
      if (spaceBefore && spaceAfter) end += 1;
      else if (spaceBefore) start -= 1;
      else if (spaceAfter) end += 1;
      return `${value.slice(0, start)}${value.slice(end)}`;
    }
    from = i + 1;
  }
  return value;
}

export function replyAuthorToAddress(viewerId, author) {
  if (!author?.id || author.active === false || author.id === viewerId) return null;
  return author;
}

export function messageMentionsMember(body, member) {
  if (!member?.displayName) return false;
  const label = `@${member.displayName}`;
  const text = String(body ?? "");
  let from = 0;
  while (from <= text.length) {
    const i = text.indexOf(label, from);
    if (i === -1) return false;
    const after = text[i + label.length];
    if (after == null || /\s/.test(after)) return true;
    from = i + 1;
  }
  return false;
}

export function conversationIndex(messages) {
  const byId = new Map(messages.map(message => [message.id, message]));
  const rootById = new Map(), threads = new Map(), roots = [];
  for (const message of messages) {
    // Parents must already exist when a message is committed. No recursive walk is needed.
    const rootId = rootById.get(message.replyToId) || message.id;
    rootById.set(message.id, rootId);
    if (rootId === message.id) { roots.push(message); threads.set(rootId, []); }
    threads.get(rootId).push(message);
  }
  return { byId, rootById, threads, roots };
}

export function parseSearchQuery(query) {
  const raw = String(query ?? "").trim().slice(0, 200);
  const match = /^(?:mentions:me|to:me|@me)(?:\s+(.*))?$/i.exec(raw);
  if (!match) return { term: raw, mentionsOnly: false };
  return { term: (match[1] || "").trim(), mentionsOnly: true };
}

export function messageAddressesMember(message, member) {
  if (!member?.id) return false;
  if (message?.toMemberId === member.id) return true;
  return messageMentionsMember(message?.body, member);
}

// The input is the current authenticated room snapshot, never a cross-room index.
// pinnedOnly (backlog follow-up 8) narrows the pool to state.pins before the
// term applies, so the 50-result cap never hides a pinned match; with no term
// it lists every pinned message, newest first like any other result.
export function searchMessages(state, query, limit = 50, { viewer = null, mentionsOnly = false, pinnedOnly = false } = {}) {
  const parsed = parseSearchQuery(query);
  const term = parsed.term.toLocaleLowerCase();
  const only = Boolean(mentionsOnly || parsed.mentionsOnly);
  let pool = (state.messages || []).filter(message => !message.deletedAt);
  if (pinnedOnly) { const pins = new Set((state.pins ?? []).map(pin => pin.messageId)); pool = pool.filter(message => pins.has(message.id)); }
  if (only) {
    if (!viewer?.id) return { messages: [], total: 0, mentionsOnly: true };
    pool = pool.filter(message => messageAddressesMember(message, viewer));
  }
  if (!term && !only && !pinnedOnly) return { messages: [], total: 0, mentionsOnly: false };
  const matches = !term ? pool : pool.filter(message =>
    message.body.toLocaleLowerCase().includes(term) ||
    (state.members[message.authorId]?.displayName || "").toLocaleLowerCase().includes(term));
  return { messages: matches.slice(-limit).reverse(), total: matches.length, mentionsOnly: only };
}

// E-H2: decides whether an access-end should preserve in-flight drafts.
// A session that died unexpectedly (401/403 expiry — the credential died,
// the user didn't leave) preserves drafts so re-authentication restores
// them. Intentional leaves — sign-out, room/account switch, page unload —
// clear drafts as before.
export function shouldPreserveDrafts({ leavingPage, pendingSignout, endedContext }) {
  return !leavingPage && !pendingSignout && !endedContext;
}

// In-memory only: every thread has its own text, recipient, reply target, retry ID,
// and submission error. Moving between discussions must not leak local composer state.
// The containing session discards the entire instance on sign-out or revoked access.
// JSON keys cannot collide with canonical thread message IDs. Retain the
// historical null key for #general so existing tab drafts remain recoverable.
export function channelDraftKey(channelId = "general") {
  return channelId === "general" ? null : JSON.stringify(["channel", channelId]);
}
function isChannelDraftKey(key) {
  try { const value = JSON.parse(key); return Array.isArray(value) && value.length === 2 && value[0] === "channel" && typeof value[1] === "string"; }
  catch { return false; }
}
export class ConversationDrafts {
  constructor() { this.entries = new Map(); }
  get(threadId = null) {
    if (!this.entries.has(threadId)) this.entries.set(threadId, { body: "", toMemberId: "", replyToId: isChannelDraftKey(threadId) ? null : threadId, pending: null, error: "" });
    return this.entries.get(threadId);
  }
  save(threadId, values) { Object.assign(this.get(threadId), values); }
  clear(threadId) { this.entries.delete(threadId); }
  hasText() { return [...this.entries.values()].some(draft => draft.body.trim()); }
}

// Restore only into the same authenticated account, membership and browser session.
// Room IDs already identify the pilot's room namespace; there is no separate tenant model.
export function draftRecoveryScope(identity) {
  if (!identity?.account?.id || !Number.isInteger(identity.account.authEpoch)
    || !identity.roomId || !identity.member?.id || !identity.sessionBinding) return null;
  return JSON.stringify([identity.roomId, identity.account.id, identity.account.authEpoch,
    identity.member.id, identity.sessionBinding]);
}

// Tab-scoped recovery. The composer used to hide this behind a checkbox; drafts
// now save for this tab until the 12-hour expiry or sign-out. Read only after
// an authenticated room snapshot.
// No credentials or server receipts are stored. Browser storage is untrusted.
export class DraftRecovery {
  constructor(storage, now = Date.now) { this.storage = storage; this.now = now; this.key = "project-room:drafts:v3"; }
  clear() { try { for (const v of [1, 2, 3]) this.storage?.removeItem(`project-room:drafts:v${v}`); } catch {} }
  write(scope, drafts, threadId, activeKey = threadId) {
    try {
      if (typeof scope !== "string" || !scope) { this.clear(); return false; }
      const entries = [...drafts.entries].filter(([, d]) => d.body.trim()).slice(-50).map(([id, d]) =>
        [id, { body: d.body, toMemberId: d.toMemberId, replyToId: d.replyToId,
          ...(typeof d.channelId === "string" ? { channelId: d.channelId } : {}),
          ...(d.mode ? { mode: d.mode, threadId: d.threadId } : {}),
          ...(d.assistantDraft ? { assistantDraft: d.assistantDraft } : {}),
          pending: d.pending ? { id: d.pending.command.id, messageId: d.pending.command.data.messageId, contents: d.pending.contents } : null }]);
      this.storage.setItem(this.key, JSON.stringify({ scope, expires: this.now() + 12 * 60 * 60 * 1000, threadId, activeKey, entries }));
      this.storage.removeItem("project-room:drafts:v2");
      return true;
    } catch { this.clear(); return false; }
  }
  read(scope, state) {
    try {
      if (typeof scope !== "string" || !scope) { this.clear(); return null; }
      const raw = this.storage?.getItem(this.key) ?? this.storage?.getItem("project-room:drafts:v2");
      if (!raw) return null;
      if (raw.length > 500000) throw new Error("size");
      const saved = JSON.parse(raw);
      if (saved.scope !== scope || !Number.isFinite(saved.expires) || saved.expires <= this.now() || saved.expires > this.now() + 12 * 60 * 60 * 1000 || !Array.isArray(saved.entries) || saved.entries.length > 50) throw new Error("scope or expiry");
      const index = conversationIndex(state.messages), drafts = new ConversationDrafts(), restoredKeys = new Map();
      for (const [id, d] of saved.entries) {
        let channelId = typeof d?.channelId === "string" ? d.channelId : undefined;
        // The old writer saved channel only inside the pending command. Recover
        // that field, then validate the entire reconstructed payload below.
        if (channelId === undefined && d?.pending?.contents) {
          try {
            const previous = JSON.parse(d.pending.contents);
            if (typeof previous.data?.channelId === "string") channelId = previous.data.channelId;
          } catch { /* malformed contents never become a retained command */ }
        }
        if (d?.mode) {
          if (!validReplyDraft(d.mode, state) || replyDraftKey(d.mode, d.threadId) !== id
            || d.threadId !== null && !index.threads.has(d.threadId)
            || typeof d.body !== "string" || typeof d.toMemberId !== "string"
            || d.replyToId !== null && (!index.byId.has(d.replyToId) || index.rootById.get(d.replyToId) !== d.threadId)) continue;
          if (d.mode.kind === "request" && d.toMemberId && !state.members[d.toMemberId]) continue;
          if (d.mode.followUpRequestId && (d.replyToId !== d.mode.responseMessageId || d.toMemberId !== d.mode.recipientId)) continue;
          if (d.mode.kind === "request" && d.mode.resultEventId && d.replyToId !== d.mode.resultMessageId) continue;
          if (d.mode.kind !== "request" && (d.replyToId !== d.mode.requestMessageId || d.toMemberId !== d.mode.requesterId)) continue;
          let pending = null;
          try {
            const data = replyDraftData(d.mode, { body: d.body.trim(), toMemberId: d.toMemberId || null,
              replyToId: d.replyToId, messageId: d.pending?.messageId,
              ...(channelId === undefined ? {} : { channelId }) });
            const type = d.mode.kind === "cancelled" ? "reply_request.cancelled" : "message.posted";
            const contents = JSON.stringify({ type, data, causationId: null });
            if (d.pending?.contents === contents && typeof d.pending.id === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(d.pending.id))
              pending = { contents, command: { id: d.pending.id, type, data } };
          } catch {}
          // A malformed retained operation must never become a new automatic send.
          if (d.pending && !pending) continue;
          drafts.save(id, { body: d.body, toMemberId: d.toMemberId, replyToId: d.replyToId,
            mode: d.mode, threadId: d.threadId, channelId, pending });
          continue;
        }
        let assistantDraft = null;
        if (d.assistantDraft) {
          const input = d.assistantDraft, source = index.byId.get(input.sourceMessageId);
          if (!source || source.deletedAt || source.toMemberId || d.toMemberId || d.replyToId !== source.id
            || channelId !== (source.channelId ?? "general") || !['contribute', 'resolve'].includes(input.action)
            || typeof input.runId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.runId)
            || id !== ['assistant', input.runId].join(':') || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
            || input.action === 'contribute' && typeof input.conflict !== 'boolean') continue;
          assistantDraft = { action: input.action, runId: input.runId, sourceMessageId: source.id,
            expectedRevision: input.expectedRevision, ...(input.action === 'contribute' ? { conflict: input.conflict } : {}) };
        }
        const channelRoot = id === null || isChannelDraftKey(id);
        const draftId = channelRoot ? channelDraftKey(channelId ?? "general") : id;
        if (isChannelDraftKey(id) && id !== draftId) continue;
        if (channelId && channelId !== "general" && !state.channels?.[channelId]) continue;
        if (!channelRoot && !assistantDraft && !index.threads.has(id)) continue;
        if (typeof d.body !== "string" || typeof d.toMemberId !== "string") continue;
        if (d.toMemberId && (!state.members[d.toMemberId] || state.members[d.toMemberId].active === false)) continue;
        if (d.replyToId !== null && (!index.byId.has(d.replyToId) || !channelRoot && !assistantDraft && index.rootById.get(d.replyToId) !== id
          || channelRoot && (index.byId.get(d.replyToId).channelId ?? "general") !== (channelId ?? "general"))) continue;
        // The current client has separate command and message identities. Preserve
        // both, then recompute the entire permitted payload before accepting a retry.
        // Older saved commands without a messageId keep their original payload.
        const messageId = d.pending?.messageId;
        const messageIdValid = messageId === undefined || (typeof messageId === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(messageId));
        const data = { ...(messageId === undefined ? {} : { messageId }), body: d.body.trim(), toMemberId: d.toMemberId || null, replyToId: d.replyToId,
          ...(channelId ? { channelId } : {}) };
        const contents = JSON.stringify({ type: "message.posted", data, causationId: null });
        const pending = messageIdValid && d.pending?.contents === contents && typeof d.pending.id === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(d.pending.id)
          ? { contents, command: { id: d.pending.id, type: "message.posted", data } } : null;
        drafts.save(draftId, { ...data, body: d.body, toMemberId: d.toMemberId, pending, ...(assistantDraft ? { assistantDraft } : {}) });
        restoredKeys.set(id, draftId);
      }
      let activeKey = restoredKeys.has(saved.activeKey) ? restoredKeys.get(saved.activeKey)
        : drafts.entries.has(saved.activeKey) ? saved.activeKey : drafts.entries.has(saved.threadId) ? saved.threadId : null;
      const active = drafts.entries.get(activeKey);
      if (active?.channelId && state.channels?.[active.channelId]?.archivedAt) activeKey = null;
      const selected = drafts.entries.get(activeKey);
      return { drafts, activeKey, channelId: selected?.channelId ?? "general",
        threadId: selected?.assistantDraft ? index.rootById.get(selected.assistantDraft.sourceMessageId) : selected?.mode ? selected.threadId : isChannelDraftKey(activeKey) ? null : activeKey };
    } catch { this.clear(); return null; }
  }
}

// Timeline windowing: a room with thousands of messages renders only its
// newest `limit` root messages; the pager widens the window a page at a time.
export const TIMELINE_WINDOW = 200;
export function windowTimeline(messages, limit = TIMELINE_WINDOW) {
  const hidden = Math.max(0, messages.length - limit);
  return { messages: hidden ? messages.slice(hidden) : messages, hidden };
}
// The window size that renders message `id`, never smaller than `current`.
export function windowToInclude(messages, id, current = TIMELINE_WINDOW, page = TIMELINE_WINDOW) {
  const index = messages.findIndex(message => message.id === id);
  if (index < 0) return current;
  const needed = messages.length - index;
  return needed > current ? Math.ceil(needed / page) * page : current;
}

// R68-1: keep a timeline that opened (or was brought) to its newest message
// there while the layout around it settles, and tell real arrivals from
// older history filling in above them.

// The pin holds while nobody has scrolled since it was set: scrollTop is the
// value the pin saw, or the list is still flush with its bottom (a taller list
// clamps scrollTop without anyone scrolling). A list that only got shorter, or
// whose content grew, keeps its pin, so the next layout or render can re-stick.
export function createTimelinePin() {
  let pin = null;
  const flush = list => list.scrollHeight - list.scrollTop - list.clientHeight <= 1;
  return {
    set(view, list) { pin = { view, top: list.scrollTop }; },
    holds(view, list) { return Boolean(pin && pin.view === view && (list.scrollTop === pin.top || flush(list))); },
    clear() { pin = null; },
  };
}

// Messages after the newest one already on screen. Older history rendered in
// above it is not news, so it never counts toward "N new messages".
export function arrivalsAfterShown(messages, isShown) {
  let last = -1;
  messages.forEach((message, index) => { if (isShown(message)) last = index; });
  return messages.slice(last + 1).filter(message => !isShown(message));
}
