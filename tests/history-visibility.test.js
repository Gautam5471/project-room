import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { MESSAGE_BODY_READS } from "../server/routes/table.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { messageInHistory, eventInHistory, rowInHistory, indexMessages, historyFloor } from "../server/history-visibility.mjs";
import { DatabaseSync } from "node:sqlite";
import { EVENT_TYPES as T, event, replay, memberHistoryVisibility, historyVisibility, PERMISSIONS } from "../src/events.js";

// PRIV-2: an owner who chooses "since_join" keeps earlier messages away from
// members who join later. Every read that can carry a message body
// (MESSAGE_BODY_READS) is walked as a late joiner over HTTP and MCP.

const BEFORE = "history-before-4c1a";
const BEFORE_EDIT = "history-before-edit-4c1b";
const AFTER = "history-after-4c1c";

function fill(path, vars) {
  return path.replace(/\{(\w+)\}/g, (_, key) => encodeURIComponent(vars[key] ?? ""));
}

async function readStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let streamed = "";
  const started = Date.now();
  while (Date.now() - started < 1200) {
    const chunk = await reader.read();
    if (chunk.done) break;
    streamed += decoder.decode(chunk.value, { stream: true });
    if (streamed.length > 0 && Date.now() - started > 200) break;
  }
  await reader.cancel();
  return streamed;
}

async function mcp(origin, name, args, secret) {
  const response = await fetch(`${origin}/room/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method: "tools/call", params: { name, arguments: args } })
  });
  return { status: response.status, text: JSON.stringify(await response.json()) };
}

async function setup(t, { preJoinEvents = 0 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "history-visibility-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  // Every write lands in the same millisecond: the join point must still be
  // decided by log order, not by the clock.
  const frozen = Date.parse("2026-10-03T12:00:00.000Z");
  store.now = () => frozen;
  const ownerKey = store.issueAccessKey("commons", "owner");
  const cmd = (type, data, key = ownerKey) => store.command(key, "commons", { id: randomUUID(), type, data });
  cmd(T.MEMBER_ADDED, { memberId: "early-agent", displayName: "Early agent", kind: "agent", permissions: [], accountableHumanId: "owner" });
  cmd(T.MESSAGE_POSTED, { messageId: "before-root", body: BEFORE });
  cmd(T.MESSAGE_POSTED, { messageId: "before-reply", body: `${BEFORE} reply`, replyToId: "before-root" });
  cmd(T.MESSAGE_PINNED, { messageId: "before-root" });
  cmd(T.MESSAGE_POSTED, { messageId: "before-question", body: `${BEFORE} open question?` });
  cmd(T.CHANNEL_CREATED, { channelId: "filler", name: "filler" });
  for (let i = 0; i < preJoinEvents; i++) cmd(T.CHANNEL_RENAMED, { channelId: "filler", name: `filler-${i}` });
  cmd(T.ROOM_HISTORY_VISIBILITY_SET, { historyVisibility: "since_join" });
  cmd(T.MEMBER_ADDED, { memberId: "late-agent", displayName: "Late agent", kind: "agent", permissions: [], accountableHumanId: "owner" });
  const lateKey = store.issueAccessKey("commons", "late-agent");
  const identity = store.identities.create("Late reader");
  store.identities.link(ownerKey, "commons", { identityId: identity.identityId, displayName: "Late reader", permissions: [] });
  // An edit after the join still belongs to a message from before it.
  cmd(T.MESSAGE_EDITED, { messageId: "before-question", body: `${BEFORE_EDIT}?`, expectedMessageRevision: 0 });
  cmd(T.MESSAGE_POSTED, { messageId: "after-root", body: AFTER });
  const earlyKey = store.issueAccessKey("commons", "early-agent");
  const server = createRoomServer({ store, streamInterval: 50 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const get = (path, token) => fetch(origin + path, { headers: { Origin: origin, Authorization: `Bearer ${token}` } });
  return { store, origin, ownerKey, lateKey, earlyKey, identity, cmd, get };
}

test("a since_join member reads nothing from before their join on any message read", async t => {
  const f = await setup(t);
  const vars = { roomId: "commons", messageId: "after-root", needle: "history-", workItemId: "none" };
  const seen = new Set();
  for (const row of MESSAGE_BODY_READS) {
    if (row.group === "receipt") continue;
    seen.add(row.id);
    if (row.tool) {
      const result = await mcp(f.origin, row.tool, { roomId: "commons", after: 0, limit: 100 }, f.identity.secret);
      assert.equal(result.status, 200, result.text);
      assert.equal(result.text.includes(BEFORE), false, `${row.id} leaked earlier text`);
      assert.equal(result.text.includes(BEFORE_EDIT), false, `${row.id} leaked an edit of earlier text`);
      continue;
    }
    const response = await f.get(fill(row.path, vars), f.lateKey);
    const text = row.stream ? await readStream(response) : await response.text();
    if (row.id.startsWith("export")) {
      // Export is owner-only.
      assert.equal(response.status, 403, `${row.id} ${text.slice(0, 200)}`);
      continue;
    }
    assert.equal(response.status, 200, `${row.id} ${text.slice(0, 300)}`);
    const readable = row.id === "search" ? JSON.stringify({ ...JSON.parse(text), query: "" }) : text;
    assert.equal(readable.includes(BEFORE), false, `${row.id} leaked earlier text`);
    assert.equal(readable.includes(BEFORE_EDIT), false, `${row.id} leaked an edit of earlier text`);
  }
  assert.deepEqual([...seen].sort(), MESSAGE_BODY_READS.filter(row => row.group !== "receipt").map(row => row.id).sort());

  // Positive control: what came after the join is readable.
  const snapshot = await (await f.get("/api/rooms/commons", f.lateKey)).json();
  assert.deepEqual(snapshot.state.messages.map(message => message.id), ["after-root"]);
  assert.deepEqual(snapshot.state.pins, []);
  const events = await (await f.get("/api/rooms/commons/events?after=0&limit=100", f.lateKey)).json();
  assert.ok(JSON.stringify(events).includes(AFTER));
  assert.equal(events.events[0].event.type, T.MEMBER_ADDED, "the reader's own join is the first visible event");
  const search = await (await f.get(`/api/rooms/commons/search?q=${AFTER}`, f.lateKey)).json();
  assert.deepEqual(search.messages.map(hit => hit.id), ["after-root"]);
  // A thread rooted before the join reads as missing.
  const thread = await f.get("/api/rooms/commons/messages/before-root/thread", f.lateKey);
  assert.equal(thread.status, 404);
  assert.equal((await thread.json()).error.code, "message_not_found");
  const mcpEvents = await mcp(f.origin, "room_list_events", { roomId: "commons", after: 0, limit: 100 }, f.identity.secret);
  assert.ok(mcpEvents.text.includes(AFTER));
});

test("the owner, membership admins and members who joined earlier keep their reads; the setting is owner-only and reversible", async t => {
  const f = await setup(t);
  // The owner always reads the full history.
  const owner = await (await f.get("/api/rooms/commons", f.ownerKey)).json();
  assert.ok(owner.state.messages.some(message => message.id === "before-root"));
  assert.equal(owner.state.room.historyVisibility.value, "since_join");
  // A member who joined before those messages still sees them.
  const early = await (await f.get("/api/rooms/commons", f.earlyKey)).json();
  assert.ok(early.state.messages.some(message => message.id === "before-root"));
  // Only the owner changes the setting.
  assert.throws(() => f.cmd(T.ROOM_HISTORY_VISIBILITY_SET, { historyVisibility: "all" }, f.lateKey), { code: "command_rejected" });
  assert.throws(() => f.cmd(T.ROOM_HISTORY_VISIBILITY_SET, { historyVisibility: "everyone" }), { code: "command_rejected" });
  // A membership admin reads everything.
  const late = f.store.room("commons").state.members["late-agent"];
  assert.equal(memberHistoryVisibility(f.store.room("commons").state, "late-agent"), "since_join");
  assert.equal(memberHistoryVisibility({ ...f.store.room("commons").state,
    members: { ...f.store.room("commons").state.members, "late-agent": { ...late, permissions: ["manage_members"] } } }, "late-agent"), "all");
  // Switching back to "all" restores the late member's history.
  f.cmd(T.ROOM_HISTORY_VISIBILITY_SET, { historyVisibility: "all" });
  const restored = await (await f.get("/api/rooms/commons", f.lateKey)).json();
  assert.ok(restored.state.messages.some(message => message.id === "before-root"));
  const events = await (await f.get("/api/rooms/commons/events?after=0&limit=100", f.lateKey)).json();
  assert.ok(JSON.stringify(events).includes(BEFORE));
  assert.doesNotThrow(() => auditRecovery(f.store));
});

test("new and older rooms start link guests and agent guests at their join; explicit choices keep their setting", () => {
  const at = "2026-10-03T12:00:00.000Z";
  const created = (data = {}) => [
    event({ type: T.ROOM_CREATED, actorId: "owner", roomId: "r1", at, data: { roomId: "r1", ownerId: "owner", title: "R", purpose: "P", ...data } }),
    event({ type: T.MEMBER_ADDED, actorId: "owner", roomId: "r1", at, data: { memberId: "owner", displayName: "Owner", kind: "human", permissions: [...PERMISSIONS] } })
  ];
  const linkGuest = `guest-${randomUUID()}`;
  const fresh = replay(created({ historyDefaultsVersion: 1 }));
  assert.equal(historyVisibility(fresh).guestsSinceJoin, true);
  assert.equal(memberHistoryVisibility(fresh, linkGuest), "since_join");
  assert.equal(memberHistoryVisibility(fresh, "guest-agent-0123456789abcdef01234567"), "since_join");
  assert.equal(memberHistoryVisibility(fresh, "agent-1"), "all");
  assert.equal(memberHistoryVisibility(fresh, "owner"), "all");
  // Rooms created before historyDefaultsVersion 1 get the same computed guest
  // default (Potter, Oct 10 2026). Non-guest members still read all.
  const legacy = replay(created());
  assert.equal(historyVisibility(legacy).guestsSinceJoin, true);
  assert.equal(memberHistoryVisibility(legacy, linkGuest), "since_join");
  assert.equal(memberHistoryVisibility(legacy, "agent-1"), "all");
  assert.equal(memberHistoryVisibility(legacy, "owner"), "all");
  assert.equal("historyVisibility" in legacy.room, false, "older logs replay without the new field");
  // The owner's explicit choice replaces the guest default.
  const chosen = replay([...created({ historyDefaultsVersion: 1 }),
    event({ type: T.ROOM_HISTORY_VISIBILITY_SET, actorId: "owner", roomId: "r1", at, data: { historyVisibility: "all" } })]);
  assert.equal(memberHistoryVisibility(chosen, linkGuest), "all");
  assert.throws(() => replay(created({ historyDefaultsVersion: 2 })), /history defaults version/);
});

test("the join point is exact: same-millisecond entries before the join stay hidden, and later edits follow their message", () => {
  const at = "2026-10-03T12:00:00.000Z";
  const floor = { sequence: 10, at, sameInstant: new Set(["m-early", "e-early"]) };
  assert.equal(messageInHistory({ id: "m-early", createdAt: at }, floor), false);
  assert.equal(messageInHistory({ id: "m-late", createdAt: at }, floor), true);
  assert.equal(messageInHistory({ id: "m-old", createdAt: "2026-10-03T11:59:59.999Z" }, floor), false);
  assert.equal(messageInHistory({ id: "m-new", createdAt: "2026-10-03T12:00:00.001Z" }, floor), true);
  assert.equal(messageInHistory({ id: "m-any" }, null), true, "no floor reads everything");
  assert.equal(eventInHistory({ id: "e-early", at }, floor), false);
  assert.equal(eventInHistory({ id: "e-late", at }, floor), true);
  const messages = indexMessages([{ id: "m-old", createdAt: "2026-10-03T11:00:00.000Z" }, { id: "m-new", createdAt: "2026-10-03T12:00:01.000Z" }]);
  const edit = messageId => ({ sequence: 11, event: { id: `edit-${messageId}`, type: T.MESSAGE_EDITED, at: "2026-10-03T12:00:02.000Z", data: { messageId } } });
  assert.equal(rowInHistory(edit("m-old"), floor, messages), false);
  assert.equal(rowInHistory(edit("m-new"), floor, messages), true);
  assert.equal(rowInHistory({ sequence: 9, event: { type: T.MESSAGE_POSTED, at } }, floor, messages), false);
  assert.equal(eventInHistory(edit("m-old").event, floor, messages), false);
});

// Authoring gate: the shared since_join privacy contract has no500-event
// exception. Existing same-millisecond examples never cross that boundary.
// Real HTTP/SQLite positive and negative controls, no production test seam.
test("same-millisecond prejoin history stays private beyond500 intervening events", async t => {
  const f = await setup(t, { preJoinEvents: 501 });
  const snapshot = await (await f.get("/api/rooms/commons", f.lateKey)).json();
  assert.deepEqual(snapshot.state.messages.map(m => m.id), ["after-root"]);
  assert.equal((await f.get("/api/rooms/commons/conversation?messageId=before-root", f.lateKey)).status, 404);
  const visible = await (await f.get("/api/rooms/commons/conversation?limit=2", f.lateKey)).json();
  assert.deepEqual(visible.messages.map(m => m.id), ["after-root"]);
  while (!f.store.backfillMessages({ limit: 1000 }).done) {}
  f.store.checkMessagesParity();
  const indexed = await (await f.get("/api/rooms/commons/conversation?limit=2", f.lateKey)).json();
  assert.deepEqual(indexed.messages.map(m => m.id), ["after-root"]);
  assert.equal((await f.get("/api/rooms/commons/conversation?messageId=before-root", f.lateKey)).status, 404);
});

// #1523: a since_join guest removed and later reactivated must not read
// messages posted during the removal gap. The history floor is the LATEST
// join event for the member id, not the first-ever one.
test("a removed-then-reactivated guest reads nothing from the removal gap", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE events (room_id TEXT, sequence INTEGER, body TEXT)");
  const at = s => `2026-10-06T12:${s}:00.000Z`;
  const rows = [
    [1, { id: "e1", type: T.MEMBER_ADDED, at: at("00"), data: { memberId: "gap-agent" } }],
    [2, { id: "e2", type: T.MESSAGE_POSTED, at: at("01"), data: { messageId: "m-early" } }],
    [3, { id: "e3", type: T.MEMBER_ACCESS_CHANGED, at: at("02"), data: { memberId: "gap-agent", active: false } }],
    [4, { id: "e4", type: T.MESSAGE_POSTED, at: at("03"), data: { messageId: "m-gap" } }],
    [5, { id: "e5", type: T.MEMBER_ADDED, at: at("04"), data: { memberId: "gap-agent" } }],
    [6, { id: "e6", type: T.MESSAGE_POSTED, at: at("05"), data: { messageId: "m-late" } }],
  ];
  const insert = db.prepare("INSERT INTO events (room_id, sequence, body) VALUES (?, ?, ?)");
  for (const [sequence, body] of rows) insert.run("commons", sequence, JSON.stringify(body));
  const state = {
    room: { ownerId: "owner", historyVisibility: { value: "since_join" } },
    members: { "gap-agent": { id: "gap-agent", kind: "agent", active: true, permissions: [] } },
  };
  const floor = historyFloor(db, state, "commons", "gap-agent");
  assert.equal(floor.sequence, 5, "floor is the reactivation join, not the first join");
  assert.equal(messageInHistory({ id: "m-early", createdAt: at("01") }, floor), false);
  assert.equal(messageInHistory({ id: "m-gap", createdAt: at("03") }, floor), false, "removal-gap message stays hidden");
  assert.equal(messageInHistory({ id: "m-late", createdAt: at("05") }, floor), true);
  assert.equal(eventInHistory({ id: "e4", at: at("03") }, floor), false);
  assert.equal(eventInHistory({ id: "e6", at: at("05") }, floor), true);
  db.close();
});

// The reducer refuses a second member.added, so real reactivation is a
// member.access_changed { active: true }. The floor must follow it, and a
// permission edit while already active must not move it.
test("a guest reactivated through member.access_changed gets a new floor", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE events (room_id TEXT, sequence INTEGER, body TEXT)");
  const at = s => `2026-10-06T12:${s}:00.000Z`;
  const rows = [
    [1, { id: "e1", type: T.MEMBER_ADDED, at: at("00"), data: { memberId: "g" } }],
    [2, { id: "e2", type: T.MEMBER_ACCESS_CHANGED, at: at("01"), data: { memberId: "g", active: false } }],
    [3, { id: "e3", type: T.MESSAGE_POSTED, at: at("02"), data: { messageId: "m-gap" } }],
    [4, { id: "e4", type: T.MEMBER_ACCESS_CHANGED, at: at("03"), data: { memberId: "g", active: true } }],
    [5, { id: "e5", type: T.MESSAGE_POSTED, at: at("04"), data: { messageId: "m-late" } }],
    [6, { id: "e6", type: T.MEMBER_ACCESS_CHANGED, at: at("05"), data: { memberId: "g", active: true } }],
  ];
  const insert = db.prepare("INSERT INTO events (room_id, sequence, body) VALUES (?, ?, ?)");
  for (const [sequence, body] of rows) insert.run("commons", sequence, JSON.stringify(body));
  const state = {
    room: { ownerId: "owner", historyVisibility: { value: "since_join" } },
    members: { g: { id: "g", kind: "agent", active: true, permissions: [] } },
  };
  const floor = historyFloor(db, state, "commons", "g");
  assert.equal(floor.sequence, 4, "floor is the reactivation, not the first join or a later edit");
  assert.equal(messageInHistory({ id: "m-gap", createdAt: at("02") }, floor), false);
  assert.equal(messageInHistory({ id: "m-late", createdAt: at("04") }, floor), true);
  db.close();
});

test("a permission-only member.access_changed (no active field) does not move the floor", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE events (room_id TEXT, sequence INTEGER, body TEXT)");
  const at = s => `2026-10-06T12:${s}:00.000Z`;
  const rows = [
    [1, { id: "e1", type: T.MEMBER_ADDED, at: at("00"), data: { memberId: "g" } }],
    [2, { id: "e2", type: T.MESSAGE_POSTED, at: at("01"), data: { messageId: "m-after-join" } }],
    [3, { id: "e3", type: T.MEMBER_ACCESS_CHANGED, at: at("02"), data: { memberId: "g", permissions: ["read"] } }],
    [4, { id: "e4", type: T.MEMBER_ACCESS_CHANGED, at: at("03"), data: { memberId: "g", permissions: [] } }],
    [5, { id: "e5", type: T.MEMBER_ACCESS_CHANGED, at: at("04"), data: { memberId: "g", active: true, permissions: [] } }],
  ];
  const insert = db.prepare("INSERT INTO events (room_id, sequence, body) VALUES (?, ?, ?)");
  for (const [sequence, body] of rows) insert.run("commons", sequence, JSON.stringify(body));
  const state = {
    room: { ownerId: "owner", historyVisibility: { value: "since_join" } },
    members: { g: { id: "g", kind: "agent", active: true, permissions: [] } },
  };
  const floor = historyFloor(db, state, "commons", "g");
  assert.equal(floor.sequence, 1, "permission-only edits keep the original join floor");
  assert.equal(messageInHistory({ id: "m-after-join", createdAt: at("01") }, floor), true);
  db.close();
});
