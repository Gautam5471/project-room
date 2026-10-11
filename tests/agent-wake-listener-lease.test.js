// Bolter steal #5: single-listener leases with fencing tokens, atomic
// batch claims, and redelivery flags on the wake-signal queue.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  AgentHeartbeats, HeartbeatError, agentHeartbeatSchema,
} from "../server/agent-heartbeats.mjs";

const T0 = 1_750_000_000_000;
const ROOM = "muse-room";

function unit(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  let at = T0;
  t.after(() => db.close());
  // The store's transaction runner: join an open transaction, else BEGIN IMMEDIATE.
  const transaction = fn => {
    if (db.isTransaction) return fn();
    db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); db.exec("COMMIT"); return result; }
    catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  };
  return { hb: new AgentHeartbeats({ db, now: () => at, transaction }, {}), advance: ms => { at += ms; }, db };
}

const wakeable = (agentId = "ai_lease", hostId = "host-1") =>
  ({ agentId, hostId, mode: "pull-only" });

function enqueue(hb, agentId, n, roomId = ROOM) {
  for (let i = 0; i < n; i++) hb.enqueueWake({ agentId, kind: "mention", roomId, messageId: `m${i}` });
}

// Heartbeat + one live lease held by listenerId.
function leased(t, listenerId = "listener-a") {
  const { hb, advance } = unit(t);
  hb.heartbeat(wakeable());
  return { hb, advance, lease: hb.acquireListenerLease({ agentId: "ai_lease", roomId: ROOM, listenerId, ttlMs: 60000 }) };
}

const claim = (hb, token, limit = 5) =>
  hb.claimWakeBatch({ agentId: "ai_lease", roomId: ROOM, fencingToken: token, limit });

test("a second listener is refused and the running listener is named", t => {
  const { hb } = leased(t);
  const b = hb.acquireListenerLease({ agentId: "ai_lease", roomId: ROOM, listenerId: "listener-b", ttlMs: 60000 });
  assert.equal(b.acquired, false, "second listener refused while the lease is live");
  assert.equal(b.activeListenerId, "listener-a", "refusal names the running listener");
});

test("the same listener renews its own lease and keeps its fencing token", t => {
  const { hb, advance, lease } = leased(t);
  assert.ok(lease.fencingToken.length > 0, "fencing token issued");
  advance(30000);
  const renewed = hb.acquireListenerLease({ agentId: "ai_lease", roomId: ROOM, listenerId: "listener-a", ttlMs: 60000 });
  assert.equal(renewed.acquired, true);
  assert.equal(renewed.fencingToken, lease.fencingToken, "renewal keeps the token so in-flight acks stay valid");
});

test("an expired lease can be re-acquired by another listener", t => {
  const { hb, advance } = leased(t);
  advance(60001);
  const b = hb.acquireListenerLease({ agentId: "ai_lease", roomId: ROOM, listenerId: "listener-b", ttlMs: 60000 });
  assert.equal(b.acquired, true, "expired lease is free for another listener");
  assert.ok(b.fencingToken.length > 0);
});

test("claimWakeBatch claims atomically; acks are fenced by the token", t => {
  const { hb, lease } = leased(t);
  enqueue(hb, "ai_lease", 3);
  const batch = claim(hb, lease.fencingToken, 2);
  assert.equal(batch.signals.length, 2, "batch claims the two oldest signals");
  assert.deepEqual(batch.signals.map(s => s.redelivered), [false, false], "first claim is not a redelivery");
  const ids = batch.signals.map(s => s.signalId);
  const ack = extra => ({ agentId: "ai_lease", signalIds: ids, roomId: ROOM, ...extra });
  assert.throws(() => hb.ackWakes(ack({ fencingToken: "bogus" })),
    err => err instanceof HeartbeatError && err.status === 409 && err.code === "listener_fenced");
  assert.throws(() => hb.ackWakes(ack()),
    err => err instanceof HeartbeatError && err.status === 409 && err.code === "listener_fenced");
  const ok = hb.ackWakes(ack({ fencingToken: lease.fencingToken }));
  assert.equal(ok.acknowledged.length, 2, "the fencing token holder drains the batch");
  assert.equal(hb.pendingWakes("ai_lease", { roomId: ROOM }).length, 1, "one signal left unclaimed");
});

test("a stale fencing token is rejected by claimWakeBatch", t => {
  const { hb, advance, lease } = leased(t);
  enqueue(hb, "ai_lease", 1);
  advance(60001);
  const b = hb.acquireListenerLease({ agentId: "ai_lease", roomId: ROOM, listenerId: "listener-b", ttlMs: 60000 });
  assert.equal(b.acquired, true);
  assert.throws(() => claim(hb, lease.fencingToken),
    err => err instanceof HeartbeatError && err.status === 409 && err.code === "stale_listener");
  assert.equal(claim(hb, b.fencingToken).signals.length, 1);
});

test("a dead listener's batch is redelivered with the flag set", t => {
  const { hb, advance, lease } = leased(t);
  enqueue(hb, "ai_lease", 2);
  const first = claim(hb, lease.fencingToken);
  assert.equal(first.signals.length, 2);
  advance(60001); // listener-a dies mid-batch: lease lapses, nothing acked.
  const b = hb.acquireListenerLease({ agentId: "ai_lease", roomId: ROOM, listenerId: "listener-b", ttlMs: 60000 });
  const redelivered = claim(hb, b.fencingToken);
  assert.deepEqual(redelivered.signals.map(s => s.signalId).sort(), first.signals.map(s => s.signalId).sort(),
    "the same batch comes back");
  assert.deepEqual(redelivered.signals.map(s => s.redelivered), [true, true], "redelivery is flagged");
});

test("releaseListenerLease frees the batch for prompt redelivery", t => {
  const { hb, lease } = leased(t);
  enqueue(hb, "ai_lease", 1);
  const first = claim(hb, lease.fencingToken);
  assert.equal(hb.releaseListenerLease({ agentId: "ai_lease", roomId: ROOM, fencingToken: lease.fencingToken }).released, true);
  const b = hb.acquireListenerLease({ agentId: "ai_lease", roomId: ROOM, listenerId: "listener-b", ttlMs: 60000 });
  const again = claim(hb, b.fencingToken);
  assert.equal(again.signals.length, 1, "released claims are immediately reclaimable");
  assert.equal(again.signals[0].redelivered, true, "re-claim after release is flagged redelivered");
  assert.equal(again.signals[0].signalId, first.signals[0].signalId);
});

test("without any lease, ackWakes keeps its old behavior", t => {
  const { hb } = unit(t);
  hb.heartbeat(wakeable());
  enqueue(hb, "ai_lease", 2);
  const pending = hb.pendingWakes("ai_lease", { roomId: ROOM });
  const ok = hb.ackWakes({ agentId: "ai_lease", signalIds: pending.map(s => s.signalId), roomId: ROOM });
  assert.equal(ok.acknowledged.length, 2, "no lease: unfenced acks still drain, exactly as before");
});

test("leases are room-scoped", t => {
  const { hb } = unit(t);
  hb.heartbeat(wakeable());
  const a = hb.acquireListenerLease({ agentId: "ai_lease", roomId: "room-one", listenerId: "listener-a", ttlMs: 60000 });
  const b = hb.acquireListenerLease({ agentId: "ai_lease", roomId: "room-two", listenerId: "listener-b", ttlMs: 60000 });
  assert.equal(a.acquired && b.acquired, true, "a different room gets its own lease");
  assert.notEqual(a.fencingToken, b.fencingToken);
});

test("lease inputs are validated", t => {
  const { hb } = leased(t);
  const bad = [
    () => hb.acquireListenerLease({ agentId: "ai_lease", roomId: ROOM, listenerId: "bad id!", ttlMs: 60000 }),
    () => hb.acquireListenerLease({ agentId: "ai_lease", roomId: ROOM, listenerId: "listener-a", ttlMs: 0 }),
    () => claim(hb, "x", 0),
  ];
  for (const fn of bad) assert.throws(fn, err => err instanceof HeartbeatError && err.status === 422);
});

// WAVE-500 g2 ack-fencing remediation (Dot's #2536 review): the fence must
// key off the SIGNALS' actual live holder, not the ack call's roomId. A
// null roomId acks across rooms, so the old lookup (by the ack's own room
// key) let a wrong token bypass a live room-scoped lease.
test("ackWakes fences a wrong token against the signals' live holder, whatever the ack's roomId", t => {
  const { hb, lease } = leased(t);
  enqueue(hb, "ai_lease", 1);
  const ids = claim(hb, lease.fencingToken, 1).signals.map(s => s.signalId);
  assert.throws(() => hb.ackWakes({ agentId: "ai_lease", signalIds: ids, fencingToken: "not-the-holder" }),
    err => err instanceof HeartbeatError && err.status === 409 && err.code === "listener_fenced",
    "broadcast ack with a wrong token is fenced by the room-scoped live lease");
  assert.throws(() => hb.ackWakes({ agentId: "ai_lease", signalIds: ids, roomId: ROOM, fencingToken: "not-the-holder" }),
    err => err instanceof HeartbeatError && err.status === 409 && err.code === "listener_fenced",
    "room-matching ack with a wrong token stays fenced");
  const ok = hb.ackWakes({ agentId: "ai_lease", signalIds: ids, fencingToken: lease.fencingToken });
  assert.equal(ok.acknowledged.length, 1, "the live holder's own token still drains");
});

// After lease expiry + reacquisition by a different listener, the stale
// token must not ack — even via the broadcast form.
test("a stale token cannot ack after expiry and reacquisition by another listener", t => {
  const { hb, advance, lease } = leased(t);
  enqueue(hb, "ai_lease", 1);
  const ids = claim(hb, lease.fencingToken, 1).signals.map(s => s.signalId);
  advance(60001);
  const b = hb.acquireListenerLease({ agentId: "ai_lease", roomId: ROOM, listenerId: "listener-b", ttlMs: 60000 });
  assert.equal(b.acquired, true, "the lease changed hands");
  assert.throws(() => hb.ackWakes({ agentId: "ai_lease", signalIds: ids, fencingToken: lease.fencingToken }),
    err => err instanceof HeartbeatError && err.status === 409 && err.code === "listener_fenced",
    "stale holder's broadcast ack is fenced after reacquisition");
  assert.throws(() => hb.ackWakes({ agentId: "ai_lease", signalIds: ids, fencingToken: b.fencingToken }),
    err => err instanceof HeartbeatError && err.status === 409 && err.code === "wake_signal_fenced",
    "the new holder must claim the abandoned batch before it can ack it");
  assert.equal(claim(hb, b.fencingToken, 1).signals[0].redelivered, true, "the takeover replays the batch, flagged");
  const ok = hb.ackWakes({ agentId: "ai_lease", signalIds: ids, fencingToken: b.fencingToken });
  assert.equal(ok.acknowledged.length, 1, "the new live holder drains the batch after claiming it");
});

// Owner fence and atomic claim: a signal belongs to the lease that claimed it.
function twoScopes(t) {
  const { hb, advance } = unit(t);
  hb.heartbeat(wakeable());
  const room = hb.acquireListenerLease({ agentId: "ai_lease", roomId: ROOM, listenerId: "room-listener", ttlMs: 60000 });
  const all = hb.acquireListenerLease({ agentId: "ai_lease", roomId: null, listenerId: "all-listener", ttlMs: 60000 });
  assert.ok(room.acquired && all.acquired);
  return { hb, advance, room, all };
}
const fenced = code => err => err instanceof HeartbeatError && err.status === 409 && err.code === code;

test("a second live scope does not take over signals claimed by a live lease", t => {
  const { hb, room, all } = twoScopes(t);
  enqueue(hb, "ai_lease", 1);
  assert.equal(claim(hb, room.fencingToken, 5).signals.length, 1);
  const second = hb.claimWakeBatch({ agentId: "ai_lease", roomId: null, fencingToken: all.fencingToken });
  assert.equal(second.signals.length, 0, "the room scope's live claim is not replayed to the all-rooms scope");
});

test("a lapsed claim must be claimed again before another lease can ack it", t => {
  const { hb, advance, room, all } = twoScopes(t);
  enqueue(hb, "ai_lease", 1);
  const ids = claim(hb, room.fencingToken, 1).signals.map(s => s.signalId);
  advance(60001);
  const fresh = hb.acquireListenerLease({ agentId: "ai_lease", roomId: null, listenerId: "all-listener", ttlMs: 60000 });
  assert.equal(fresh.fencingToken !== all.fencingToken, true, "the all-rooms lease was re-issued after expiry");
  assert.throws(() => hb.ackWakes({ agentId: "ai_lease", signalIds: ids, fencingToken: fresh.fencingToken }),
    fenced("wake_signal_fenced"), "another live lease cannot delete work it never claimed");
  assert.throws(() => hb.ackWakes({ agentId: "ai_lease", signalIds: ids }),
    fenced("wake_signal_fenced"), "a tokenless ack cannot either");
  const replay = hb.claimWakeBatch({ agentId: "ai_lease", roomId: null, fencingToken: fresh.fencingToken });
  assert.deepEqual(replay.signals.map(s => [s.signalId, s.redelivered]), [[ids[0], true]], "re-claiming replays it, flagged");
  assert.equal(hb.ackWakes({ agentId: "ai_lease", signalIds: ids, fencingToken: fresh.fencingToken }).acknowledged.length, 1);
});

test("re-acking a delivered signal stays idempotent whatever the token", t => {
  const { hb, room } = twoScopes(t);
  enqueue(hb, "ai_lease", 1);
  const ids = claim(hb, room.fencingToken, 1).signals.map(s => s.signalId);
  assert.equal(hb.ackWakes({ agentId: "ai_lease", signalIds: ids, fencingToken: room.fencingToken }).acknowledged.length, 1);
  assert.deepEqual(hb.ackWakes({ agentId: "ai_lease", signalIds: ids, fencingToken: room.fencingToken }).acknowledged, []);
  assert.deepEqual(hb.ackWakes({ agentId: "ai_lease", signalIds: ids, roomId: ROOM, fencingToken: room.fencingToken }).acknowledged, []);
});

test("the claim is fenced against the live lease inside the claiming statement", t => {
  const { hb, room } = twoScopes(t);
  enqueue(hb, "ai_lease", 1);
  // Another process lets the lease lapse after the up-front check but before the insert.
  const prepare = hb.db.prepare.bind(hb.db);
  hb.db.prepare = sql => {
    if (/^\s*INSERT INTO agent_wake_signal_claims/.test(sql)) {
      hb.db.exec("UPDATE agent_wake_listener_leases SET lease_expires_at = 1 WHERE room_key = '" + ROOM + "'");
    }
    return prepare(sql);
  };
  const batch = hb.claimWakeBatch({ agentId: "ai_lease", roomId: ROOM, fencingToken: room.fencingToken });
  assert.equal(batch.signals.length, 0, "a lapsed lease claims nothing");
  assert.equal(hb.db.prepare("SELECT COUNT(*) AS n FROM agent_wake_signal_claims").get().n, 0, "and records no claim row");
});

// Durable Objects reject raw BEGIN/SAVEPOINT/COMMIT/ROLLBACK SQL; the store's
// runner owns the transaction there. Ack must not issue any of it itself.
test("ackWakes issues no raw transaction SQL (Durable Object SQL rejects it)", t => {
  const { hb, lease } = leased(t);
  enqueue(hb, "ai_lease", 1);
  const ids = claim(hb, lease.fencingToken, 1).signals.map(s => s.signalId);
  // Stand in for a Durable Object: the injected runner does not touch SQL, and raw
  // transaction statements are counted (a real DO throws on them).
  hb.store.transaction = fn => fn();
  let raw = 0;
  const exec = hb.db.exec.bind(hb.db);
  hb.db.exec = sql => { if (/^\s*(BEGIN|SAVEPOINT|RELEASE|COMMIT|ROLLBACK)\b/i.test(sql)) raw++; return exec(sql); };
  assert.equal(hb.ackWakes({ agentId: "ai_lease", signalIds: ids, fencingToken: lease.fencingToken }).acknowledged.length, 1);
  assert.equal(raw, 0, "ackWakes left transaction control to the store's runner");
});
