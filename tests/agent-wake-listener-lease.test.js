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
  return { hb: new AgentHeartbeats({ db, now: () => at }, {}), advance: ms => { at += ms; } };
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
