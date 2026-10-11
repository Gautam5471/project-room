// Room-hosted wake poll (RC-2026-09-28-3602): wakeable-by-default.
// An agent host with no public endpoint waits on GET /api/agent-wakes/poll
// for mention/DM wake signals instead of needing a wakeUrl.
//
// Authoring gate (repo test-audit): each test below names the observable
// contract, the credible regression, why existing coverage misses it, and
// confirms no test-only production seam was added.
//
// 1. notePoll refuses unregistered agents — contract: only heartbeat-
//    registered identities can wait. Regression: a refactor that lets
//    unknown agents wait (or throws instead of returning the shape).
// 2. notePoll is non-consuming — contract: waiting never acknowledges;
//    signals leave the queue only via ackWakes. Regression: a "read =
//    delivered" optimization silently dropping wakes.
// 3. enqueueWake releases waiters only on genuinely new signals —
//    contract: wake-on-enqueue with per-message coalescing. Regression:
//    waking on duplicates (wake storms) or never waking (dead poll).
// 4. waiter replacement + roomId scoping + idempotent release — contract:
//    one live waiter per host; room-key waiters see only their room.
//    Regression: wedged slots on reconnect; cross-room signal leaks.
//    (Per-agent replacement was tried and rejected: two hosts under one
//    identity livelocked, each poll releasing the other.)
// 4b. two hosts wait side by side — contract: a signal releases every
//    waiting host, and one host's poll never disturbs another's.
//    Regression: the per-agent livelock above.
// 5. heartbeat mode/wakeUrl defaults — contract: omitted mode means
//    wakeable, omitted wakeUrl means null, pull-only + wakeUrl is 422.
//    Regression: the destructuring default only covers undefined, not
//    null — the null branch is a distinct path worth pinning.
// 6. poll route auth/validation/shape — contract: 401/403/404/422
//    boundaries and the response shape. Regression: scope or shape drift.
// 7. end-to-end wake over HTTP — contract: heartbeat without a wakeUrl,
//    poll waits, a mention releases it, ack drains it. Regression: the
//    feature's whole reason for existing; nothing else covers the wait.
// 8. poll replacement over HTTP — contract: a reconnect with the same
//    hostId releases the first poll instead of wedging; a different host's
//    poll leaves the first waiting. Regression: reconnecting hosts hanging;
//    the two-host livelock.
// 9. aborted poll — contract: a client that disconnects mid-wait releases
//    its host slot. Regression: dead connections wedging the slot so the
//    next poll misbehaves.
//
// Synthetic fixtures only — loopback HTTP, no external calls or real credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import {
  AgentHeartbeats, HeartbeatError, agentHeartbeatSchema,
  HEARTBEAT_STALE_AFTER_MS,
} from "../server/agent-heartbeats.mjs";

const T0 = 1_750_000_000_000;

function unit(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  let at = T0;
  const hb = new AgentHeartbeats({ db, now: () => at, transaction: fn => { db.exec("BEGIN IMMEDIATE"); try { const result = fn(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; } } }, { staleAfterMs: HEARTBEAT_STALE_AFTER_MS });
  t.after(() => db.close());
  return { hb, advance: ms => { at += ms; } };
}

// ---- Store unit tests ----

test("notePoll refuses unregistered agents with the registered:false shape", t => {
  const { hb } = unit(t);
  const poll = hb.notePoll({ agentId: "ai_nobody" });
  assert.equal(poll.registered, false);
  assert.deepEqual(poll.pendingWakes, []);
});

test("notePoll returns pending signals immediately and never consumes them", t => {
  const { hb } = unit(t);
  hb.heartbeat({ agentId: "ai_poller", hostId: "h" });
  assert.deepEqual(hb.notePoll({ agentId: "ai_poller" }).pendingWakes, [], "nothing queued yet");
  hb.enqueueWake({ agentId: "ai_poller", kind: "mention", roomId: "commons", messageId: "m-1" });
  const first = hb.notePoll({ agentId: "ai_poller" });
  assert.equal(first.registered, true);
  assert.equal(first.pendingWakes.length, 1);
  assert.equal(first.pendingWakes[0].messageId, "m-1");
  // Waiting is a pure read: the signal is still there on the next poll.
  assert.equal(hb.notePoll({ agentId: "ai_poller" }).pendingWakes.length, 1);
  // Only an explicit ack drains it.
  hb.ackWakes({ agentId: "ai_poller", signalIds: [first.pendingWakes[0].signalId] });
  assert.deepEqual(hb.notePoll({ agentId: "ai_poller" }).pendingWakes, []);
});

test("enqueueWake releases the waiter only for genuinely new signals", t => {
  const { hb } = unit(t);
  hb.heartbeat({ agentId: "ai_waiter", hostId: "h" });
  let wakes = 0;
  const release = hb.addWakeWaiter("ai_waiter", "h", { roomId: null, onWake: () => { wakes++; } });
  t.after(release);
  hb.enqueueWake({ agentId: "ai_waiter", kind: "dm", roomId: "commons", messageId: "m-1" });
  assert.equal(wakes, 1, "new signal releases the waiter");
  // The waiter is single-shot: re-register, then a coalesced duplicate for
  // the same message must NOT wake again.
  let second = 0;
  const release2 = hb.addWakeWaiter("ai_waiter", "h", { roomId: null, onWake: () => { second++; } });
  t.after(release2);
  const dup = hb.enqueueWake({ agentId: "ai_waiter", kind: "dm", roomId: "commons", messageId: "m-1" });
  assert.equal(dup.enqueued, false, "coalesced duplicate");
  assert.equal(second, 0, "duplicate signal does not wake");
});

test("waiter replacement is per host: same hostId replaces, other hosts coexist", t => {
  const { hb } = unit(t);
  hb.heartbeat({ agentId: "ai_scoped", hostId: "h" });
  let first = 0, second = 0;
  const releaseFirst = hb.addWakeWaiter("ai_scoped", "h", { roomId: null, onWake: () => { first++; } });
  // Reconnecting with the same hostId replaces only that host's waiter.
  const releaseSecond = hb.addWakeWaiter("ai_scoped", "h", { roomId: "room-a", onWake: () => { second++; } });
  assert.equal(first, 1, "replaced waiter is released");
  assert.equal(second, 0);
  // A signal in another room does not release a room-scoped waiter.
  hb.enqueueWake({ agentId: "ai_scoped", kind: "mention", roomId: "room-b", messageId: "m-1" });
  assert.equal(second, 0, "room-b signal must not wake a room-a waiter");
  hb.enqueueWake({ agentId: "ai_scoped", kind: "mention", roomId: "room-a", messageId: "m-2" });
  assert.equal(second, 1, "room-a signal wakes the room-a waiter");
  // Release is idempotent and safe after the waiter already fired.
  releaseFirst(); releaseSecond(); releaseSecond();
});

test("two hosts wait side by side; one signal releases both", t => {
  const { hb } = unit(t);
  hb.heartbeat({ agentId: "ai_multi", hostId: "h-a" });
  hb.heartbeat({ agentId: "ai_multi", hostId: "h-b" });
  let a = 0, b = 0;
  const releaseA = hb.addWakeWaiter("ai_multi", "h-a", { roomId: null, onWake: () => { a++; } });
  const releaseB = hb.addWakeWaiter("ai_multi", "h-b", { roomId: null, onWake: () => { b++; } });
  t.after(releaseA); t.after(releaseB);
  assert.equal(a, 0, "second host must not release the first");
  assert.equal(b, 0);
  hb.enqueueWake({ agentId: "ai_multi", kind: "mention", roomId: "commons", messageId: "m-9" });
  assert.equal(a, 1, "signal releases host a");
  assert.equal(b, 1, "signal releases host b");
});

test("heartbeat defaults: omitted mode is wakeable, omitted wakeUrl is null", t => {
  const { hb } = unit(t);
  // undefined hits the destructuring default; null hits the effectiveMode branch.
  for (const mode of [undefined, null]) {
    const { host } = hb.heartbeat({ agentId: "ai_default", hostId: `h-${String(mode)}`, mode, wakeUrl: null });
    assert.equal(host.mode, "wakeable");
    assert.equal(host.wakeUrl, null);
  }
  assert.throws(() => hb.heartbeat({ agentId: "ai_default", hostId: "bad", mode: "pull-only", wakeUrl: "https://x.test/w" }),
    err => err instanceof HeartbeatError && /pull-only/.test(err.message));
});

// ---- HTTP integration ----

async function startServer(t, f) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (origin, path, body, secret = null) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
  body: JSON.stringify(body),
});
const get = (origin, path, secret = null) => fetch(`${origin}${path}`, {
  headers: secret ? { authorization: `Bearer ${secret}` } : {},
});
const errorCode = async res => (await res.json()).error?.code;

async function keyedAgent(t, f, origin) {
  const identity = f.store.identities.create("wake-poll-agent");
  const scoped = await (await post(origin, "/api/agent-keys",
    { scopes: ["heartbeats:report", "heartbeats:read"] }, identity.secret)).json();
  return { identity, credential: scoped.credential };
}

test("poll route: auth, scope, registration, and waitMs validation", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const { identity, credential } = await keyedAgent(t, f, origin);
  const readOnly = await (await post(origin, "/api/agent-keys",
    { scopes: ["heartbeats:read"] }, identity.secret)).json();
  const wrongScope = await (await post(origin, "/api/agent-keys",
    { scopes: ["directory:publish"] }, identity.secret)).json();

  assert.equal((await get(origin, "/api/agent-wakes/poll")).status, 401);
  assert.equal((await get(origin, "/api/agent-wakes/poll", wrongScope.credential)).status, 403);
  assert.equal(await errorCode(await get(origin, "/api/agent-wakes/poll?hostId=h", credential)), "agent_not_registered");

  // Register with no wakeUrl at all — the wakeable-by-default shape.
  const reported = await post(origin, "/api/agent-heartbeats", { hostId: "h" }, credential);
  assert.equal(reported.status, 200);
  assert.equal((await reported.json()).host.wakeUrl, null);

  assert.equal(await errorCode(await get(origin, "/api/agent-wakes/poll?hostId=h&waitMs=nope", credential)), "invalid_wake_poll");
  assert.equal(await errorCode(await get(origin, "/api/agent-wakes/poll?hostId=h&waitMs=-5", credential)), "invalid_wake_poll");

  // hostId is required: one waiter per host.
  assert.equal(await errorCode(await get(origin, "/api/agent-wakes/poll?waitMs=0", credential)), "invalid_wake_poll");
  assert.equal(await errorCode(await get(origin, "/api/agent-wakes/poll?hostId=nope!&waitMs=0", credential)), "invalid_wake_poll");

  // waitMs=0 short-poll with nothing queued: immediate empty return.
  const empty = await (await get(origin, "/api/agent-wakes/poll?hostId=h&waitMs=0", readOnly.credential)).json();
  assert.deepEqual(empty.pendingWakes, []);
  assert.equal(empty.timedOut, false);
  assert.equal(empty.waitedMs, 0);
});

test("poll times out cleanly when nothing arrives", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const { credential } = await keyedAgent(t, f, origin);
  await post(origin, "/api/agent-heartbeats", { hostId: "h" }, credential);
  const started = Date.now();
  const doc = await (await get(origin, "/api/agent-wakes/poll?hostId=h&waitMs=300", credential)).json();
  const elapsed = Date.now() - started;
  assert.deepEqual(doc.pendingWakes, []);
  assert.equal(doc.timedOut, true);
  assert.ok(elapsed >= 250 && elapsed < 5000, `waited ~300ms, got ${elapsed}ms`);
  assert.ok(doc.next.some(n => n.action === "poll-wakes"), "teaches the next poll");
});

test("a real mention releases a waiting poll: the wakeable-by-default loop", async t => {
  const f = createAcceptanceFixture();
  let at = Date.now();
  f.store.now = () => at;
  const origin = await startServer(t, f);
  const identity = f.store.identities.create("wake-poll-agent");
  f.store.identities.link(f.keys.owner, "commons", {
    identityId: identity.identityId, memberId: "wakeagent",
    displayName: "Wake Agent", permissions: ["accept_work"],
  });
  const scoped = await (await post(origin, "/api/agent-keys",
    { scopes: ["heartbeats:report", "heartbeats:read"] }, identity.secret)).json();
  const credential = scoped.credential;

  // Register with no wakeUrl at all — the wakeable-by-default shape.
  await post(origin, "/api/agent-heartbeats", { hostId: "h" }, credential);
  // A mention only queues a wake for an offline agent: let the host go stale.
  at += HEARTBEAT_STALE_AFTER_MS + 1000;

  const pollPromise = get(origin, "/api/agent-wakes/poll?hostId=h&waitMs=10000", credential).then(r => r.json());
  // Let the poll register its waiter, then post a real mention while it waits.
  await new Promise(resolve => setTimeout(resolve, 150));
  f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: "message.posted",
    data: { messageId: "m-live", body: "hey @wakeagent, take a look when you are back" } });

  const doc = await pollPromise;
  assert.equal(doc.pendingWakes.length, 1, "the waiting poll released with the signal");
  assert.equal(doc.pendingWakes[0].messageId, "m-live");
  assert.equal(doc.pendingWakes[0].kind, "mention");
  assert.equal(doc.timedOut, false);
  assert.ok(doc.waitedMs < 9000, "released by the signal, not the timeout");
  assert.ok(doc.next.some(n => n.action === "ack-wakes"), "teaches the ack");

  // Ack drains the queue; the next poll is quiet.
  await post(origin, "/api/agent-heartbeats/ack",
    { signalIds: doc.pendingWakes.map(s => s.signalId) }, credential);
  const quiet = await (await get(origin, "/api/agent-wakes/poll?hostId=h&waitMs=0", credential)).json();
  assert.deepEqual(quiet.pendingWakes, []);
});

test("a reconnect with the same hostId releases the first poll", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const { credential } = await keyedAgent(t, f, origin);
  await post(origin, "/api/agent-heartbeats", { hostId: "h" }, credential);

  const started = Date.now();
  const firstPromise = get(origin, "/api/agent-wakes/poll?hostId=h&waitMs=10000", credential).then(r => r.json());
  await new Promise(resolve => setTimeout(resolve, 150));
  // The reconnecting host polls again with the same hostId; the first
  // request must resolve now.
  const second = await (await get(origin, "/api/agent-wakes/poll?hostId=h&waitMs=0", credential)).json();
  const first = await firstPromise;
  const elapsed = Date.now() - started;
  assert.deepEqual(second.pendingWakes, []);
  assert.deepEqual(first.pendingWakes, []);
  assert.ok(elapsed < 9000, `first poll released by replacement in ${elapsed}ms, not by timeout`);
});

test("an aborted poll releases the host slot instead of wedging it", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const { credential } = await keyedAgent(t, f, origin);
  await post(origin, "/api/agent-heartbeats", { hostId: "h" }, credential);

  const controller = new AbortController();
  const doomed = fetch(`${origin}/api/agent-wakes/poll?hostId=h&waitMs=10000`, {
    headers: { authorization: `Bearer ${credential}` }, signal: controller.signal,
  }).then(r => r.json()).catch(() => null);
  await new Promise(resolve => setTimeout(resolve, 200));
  controller.abort(); // client vanishes mid-wait, like a dropped mobile radio
  await doomed;
  await new Promise(resolve => setTimeout(resolve, 300)); // let the server notice the close

  // The slot is free and clean: a fresh poll waits out its own timeout.
  const started = Date.now();
  const doc = await (await get(origin, "/api/agent-wakes/poll?hostId=h&waitMs=600", credential)).json();
  assert.equal(doc.timedOut, true);
  assert.deepEqual(doc.pendingWakes, []);
  assert.ok(Date.now() - started >= 500, "fresh poll waited its timeout — no wedged slot");
});

test("a different host's poll leaves the first host's wait alone", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const { credential } = await keyedAgent(t, f, origin);
  await post(origin, "/api/agent-heartbeats", { hostId: "h-a" }, credential);
  await post(origin, "/api/agent-heartbeats", { hostId: "h-b" }, credential);

  const started = Date.now();
  const firstPromise = get(origin, "/api/agent-wakes/poll?hostId=h-a&waitMs=2000", credential).then(r => r.json());
  await new Promise(resolve => setTimeout(resolve, 150));
  // Host b polls: must not disturb host a's wait. No livelock.
  const second = await (await get(origin, "/api/agent-wakes/poll?hostId=h-b&waitMs=0", credential)).json();
  assert.deepEqual(second.pendingWakes, []);
  const first = await firstPromise;
  const elapsed = Date.now() - started;
  assert.equal(first.timedOut, true, "host a waited out its own timeout, not a release");
  assert.ok(elapsed >= 1500, `host a actually waited (${elapsed}ms), not released early`);
});


// Authoring gate: HTTP wait completion must use current authority and cannot
// let a room credential replace an identity-owned waiter. Existing initial-auth
// and distinct-host tests do not cross revocation or credential namespaces.
// The pre-fix route returns wakes to a revoked key and releases the other
// credential's waiter; both cases use existing public routes, no test seam.
test("held wake poll rejects a key revoked before a new signal", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const identity = f.store.identities.create("revoked-poll-agent");
  const key = await (await post(origin, "/api/agent-keys",
    { scopes: ["heartbeats:read", "heartbeats:report"] }, identity.secret)).json();
  assert.equal((await post(origin, "/api/agent-heartbeats", { hostId: "h" }, key.credential)).status, 200);
  const held = get(origin, "/api/agent-wakes/poll?hostId=h&waitMs=2000", key.credential);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal((await post(origin, `/api/agent-keys/${key.keyId}/revoke`, { confirm: true }, identity.secret)).status, 200);
  f.store.agentHeartbeats.enqueueWake({ agentId: identity.identityId, roomId: "commons", kind: "mention", messageId: "after-revoke" });
  const response = await held;
  assert.equal(response.status, 401, "revoked credential must not receive newly queued wake pointers");
  assert.equal((await response.json()).pendingWakes, undefined);
});

test("room-key poll cannot replace an identity-owned host wait", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const identity = f.store.identities.create("isolated-poll-agent");
  f.store.identities.link(f.keys.owner, "commons", {
    identityId: identity.identityId, memberId: identity.identityId,
    displayName: "Isolated poll agent", permissions: ["accept_work"],
  });
  const roomKey = f.store.issueAccessKey("commons", identity.identityId);
  assert.equal((await post(origin, "/api/agent-heartbeats", { hostId: "h", mode: "pull-only" }, roomKey)).status, 200);
  assert.equal((await post(origin, "/api/agent-heartbeats", { hostId: "h" }, identity.secret)).status, 200);
  const started = Date.now();
  const held = get(origin, "/api/agent-wakes/poll?hostId=h&waitMs=700", identity.secret);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal((await get(origin, "/api/agent-wakes/poll?hostId=h&waitMs=0", roomKey)).status, 200);
  const response = await held;
  assert.equal(response.status, 200);
  assert.equal((await response.json()).timedOut, true, "other credential does not release identity-owned wait");
  assert.ok(Date.now() - started >= 550, "identity-owned request retains its own wait interval");
});


// Authoring gate: a fresh heartbeat must not suppress delivery to a real
// waiting host. The prior end-to-end test only covers an artificially stale
// host. Removing active-wait handling makes this actual HTTP task time out;
// the fixture uses the existing message command and adds no production seam.
test("fresh heartbeating host receives a mention through its active poll", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const identity = f.store.identities.create("online-poll-agent");
  f.store.identities.link(f.keys.owner, "commons", {
    identityId: identity.identityId, memberId: identity.identityId,
    displayName: "Online poll agent", permissions: ["accept_work"],
  });
  assert.equal((await post(origin, "/api/agent-heartbeats", { hostId: "h" }, identity.secret)).status, 200);
  const held = get(origin, "/api/agent-wakes/poll?hostId=h&waitMs=1000", identity.secret);
  await new Promise(resolve => setTimeout(resolve, 150));
  f.store.command(f.keys.owner, "commons", {
    id: randomUUID(), type: "message.posted",
    data: { messageId: "online-mention", body: `hey @${identity.identityId} please respond` },
  });
  const response = await held;
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.timedOut, false, "fresh presence does not suppress a waiting host's wake");
  assert.deepEqual(result.pendingWakes.map(w => w.messageId), ["online-mention"]);
});


// A completed/aborted poll has no active waiter. Presence must not erase the
// interval's wake. Real HTTP post/poll plus cold DB reopen pin the durable
// contract; existing active-wait tests cannot observe this gap.
test("fresh wakeable host retains between-poll mention across database restart until explicit ack", async t => {
  const directory = mkdtempSync(join(tmpdir(), "wake-poll-gap-"));
  const filename = join(directory, "room.sqlite");
  let store = new RoomStore(filename), server;
  const owner = store.identities.create("Gap owner"), worker = store.identities.create("Gap worker");
  new AgentRooms(store).create(owner.secret, { roomId: "gap-room", title: "Gap", purpose: "Wake interval", kind: "personal" });
  store.identities.link(owner.secret, "gap-room", { identityId: worker.identityId, memberId: "gap-worker", permissions: [] });
  const linksBefore = store.db.prepare("SELECT * FROM identity_links ORDER BY room_id,identity_id").all();
  const open = async () => {
    server = createRoomServer({ store });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const close = async () => {
    server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close();
  };
  t.after(async () => { await close(); rmSync(directory, { recursive: true, force: true }); });
  let origin = await open();
  const heartbeat = await post(origin, "/api/agent-heartbeats", { hostId: "gap-host" }, worker.secret);
  assert.equal(heartbeat.status, 200); const registered = await heartbeat.json();
  assert.equal(registered.host.mode, "wakeable"); assert.equal(registered.host.wakeUrl, null);
  const pollPath = "/api/agent-wakes/poll?hostId=gap-host&waitMs=0";
  assert.deepEqual((await (await get(origin, pollPath, worker.secret)).json()).pendingWakes, []);
  assert.equal(store.agentHeartbeats.statusOf(worker.identityId).status, "online");
  const command = { id: "gap-post", type: "message.posted", data: { messageId: "gap-message", body: "@gap-worker please review" } };
  assert.equal((await post(origin, "/api/rooms/gap-room/commands", command, owner.secret)).status, 201);
  const first = await (await get(origin, pollPath, worker.secret)).json();
  assert.deepEqual(first.pendingWakes.map(row => row.messageId), ["gap-message"]);
  const repeated = await (await get(origin, pollPath, worker.secret)).json();
  assert.deepEqual(repeated.pendingWakes, first.pendingWakes, "reads never consume the signal");
  assert.equal((await post(origin, "/api/rooms/gap-room/commands", command, owner.secret)).status, 200);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM agent_wake_signals").get().n, 1, "exact post replay creates no extra wake");
  await close(); store = new RoomStore(filename); origin = await open();
  assert.deepEqual((await (await get(origin, pollPath, worker.secret)).json()).pendingWakes, first.pendingWakes, "cold restart retains exact wake receipt");
  assert.equal((await post(origin, "/api/agent-heartbeats/ack", { signalIds: first.pendingWakes.map(row => row.signalId) }, worker.secret)).status, 200);
  assert.deepEqual((await (await get(origin, pollPath, worker.secret)).json()).pendingWakes, []);
  assert.deepEqual(store.db.prepare("SELECT * FROM identity_links ORDER BY room_id,identity_id").all(), linksBefore);
  // A pull-only host is still registered, so the mention is queued. The
  // wake poll reads that same queue; the next heartbeat returns it too.
  assert.equal((await post(origin, "/api/agent-heartbeats", { hostId: "gap-host", mode: "pull-only" }, worker.secret)).status, 200);
  assert.equal((await post(origin, "/api/rooms/gap-room/commands", { id: "pull-post", type: "message.posted", data: { messageId: "pull-message", body: "@gap-worker on your cadence" } }, owner.secret)).status, 201);
  assert.deepEqual((await (await get(origin, pollPath, worker.secret)).json()).pendingWakes.map(row => row.messageId), ["pull-message"]);
  const pullBeat = await (await post(origin, "/api/agent-heartbeats", { hostId: "gap-host", mode: "pull-only" }, worker.secret)).json();
  assert.deepEqual(pullBeat.pendingWakes.map(row => row.messageId), ["pull-message"]);
  assert.equal(pullBeat.more, false);
  const attention = await (await get(origin, "/api/needs-me", worker.secret)).json();
  assert.ok(attention.items.some(item => item.id === "pull-message"));
});
