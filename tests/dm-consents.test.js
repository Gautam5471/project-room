import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DmConsents, dmConsentSchema } from "../server/dm-consents.mjs";
import { AUTONOMY_TIERS_SCHEMA, setTier } from "../server/autonomy-tiers.mjs";

const member = (id, displayName, active = true) => ({ id, displayName, active, kind: "agent", permissions: [] });

function makeStore(states) {
  const db = new DatabaseSync(":memory:");
  db.exec(dmConsentSchema);
  // The real RoomStore boot path creates the autonomy-tier table (the
  // request path now reads it — issue #995), so the stub carries it too.
  db.exec(AUTONOMY_TIERS_SCHEMA);
  const events = [];
  return {
    db,
    transaction(fn) {
      if (db.isTransaction) return fn();
      db.exec("BEGIN IMMEDIATE");
      try { const out = fn(); db.exec("COMMIT"); return out; }
      catch (e) { if (db.isTransaction) db.exec("ROLLBACK"); throw e; }
    },
    room(id) {
      const state = states[id];
      return state ? { state } : null;
    },
    // The real RoomStore persists consent decisions as sequenced
    // dm.consent_changed events (RC-2026-09-19-070). The stub records the
    // append contract only; the full reducer path (envelope dedupe, state
    // advance, visibility) is verified on a real RoomStore in
    // dm-consent-events.test.js.
    appendSideTableEvent(roomId, event) {
      events.push(event);
    },
    events
  };
}

const baseState = () => ({
  room: { id: "r1", title: "Room", purpose: "work", ownerId: "owner", createdAt: 1000 },
  members: {
    owner: member("owner", "Olivia Owner"),
    alice: member("alice", "Alice"),
    bob: member("bob", "Bob"),
    zed: member("zed", "Zed", false)
  },
  messages: []
});

const errOf = fn => { try { fn(); } catch (e) { return e; } return null; };

test("request creates a pending pair; re-request updates the reason", () => {
  const store = makeStore({ r1: baseState() });
  const dms = new DmConsents(store);
  const first = dms.request("r1", "alice", "bob", "need to sync");
  assert.equal(first.status, "pending");
  assert.equal(first.reason, "need to sync");
  const second = dms.request("r1", "alice", "bob", "updated reason");
  assert.equal(second.status, "pending");
  assert.equal(second.reason, "updated reason");
  const rows = store.db.prepare("SELECT COUNT(*) AS n FROM dm_consents").get();
  assert.equal(rows.n, 1);
  // Append contract (RC-2026-09-19-070): a new pending request logs one
  // dm.consent_changed event; a pending re-ask with an updated reason is a
  // refresh of the same outreach and logs nothing.
  assert.deepEqual(store.events.map(e => e.data.status), ["pending"]);
});

test("request rejects self, unknown members, inactive members", () => {
  const store = makeStore({ r1: baseState() });
  const dms = new DmConsents(store);
  assert.equal(errOf(() => dms.request("r1", "alice", "alice")).code, "invalid_dm_request");
  assert.equal(errOf(() => dms.request("r1", "alice", "ghost")).code, "target_not_found");
  assert.equal(errOf(() => dms.request("r1", "alice", "zed")).code, "target_not_found");
  assert.equal(errOf(() => dms.request("nope", "alice", "bob")).code, "room_not_found");
});

test("decide: only the recorded target's approval flips to approved", () => {
  const store = makeStore({ r1: baseState() });
  const dms = new DmConsents(store);
  dms.request("r1", "alice", "bob", "hi");
  assert.equal(errOf(() => dms.decide("r1", "bob", "alice", "maybe")).code, "invalid_dm_decision");
  const decided = dms.decide("r1", "bob", "alice", "approve");
  assert.equal(decided.status, "approved");
  assert.ok(decided.decidedAt > 0);
  assert.equal(errOf(() => dms.decide("r1", "bob", "alice", "approve")).code, "dm_no_pending_request");
});

test("reject then re-request restarts at pending; block refuses new requests", () => {
  const store = makeStore({ r1: baseState() });
  const dms = new DmConsents(store);
  dms.request("r1", "alice", "bob");
  dms.decide("r1", "bob", "alice", "reject");
  const again = dms.request("r1", "alice", "bob", "second try");
  assert.equal(again.status, "pending");
  dms.decide("r1", "bob", "alice", "block");
  const blocked = errOf(() => dms.request("r1", "alice", "bob"));
  assert.equal(blocked.status, 403);
  assert.equal(blocked.code, "dm_blocked");
  const unblocked = dms.unblock("r1", "bob", "alice");
  assert.equal(unblocked.status, "rejected");
  const fresh = dms.request("r1", "alice", "bob");
  assert.equal(fresh.status, "pending");
});

test("requireDmAllowed: DMs are open by default; only explicit denial refuses", () => {
  const store = makeStore({ r1: baseState() });
  const dms = new DmConsents(store);
  assert.equal(dms.requireDmAllowed("r1", "alice", "alice"), true);
  // No row ever existed: default open.
  assert.equal(dms.requireDmAllowed("r1", "alice", "bob"), true);
  // A pending request does not gate: the recipient hasn't said no.
  dms.request("r1", "alice", "bob");
  assert.equal(dms.requireDmAllowed("r1", "alice", "bob"), true);
  dms.decide("r1", "bob", "alice", "approve");
  assert.equal(dms.requireDmAllowed("r1", "alice", "bob"), true);
  // Either direction flows on default-open, no answer-path bookkeeping needed.
  assert.equal(dms.requireDmAllowed("r1", "bob", "alice"), true);
  // Explicit denial states refuse.
  dms.revoke("r1", "alice", "bob");
  let err = errOf(() => dms.requireDmAllowed("r1", "alice", "bob"));
  assert.equal(err.code, "dm_consent_required");
  // A fresh request that the recipient rejects also refuses.
  dms.request("r1", "alice", "owner");
  dms.decide("r1", "owner", "alice", "reject");
  err = errOf(() => dms.requireDmAllowed("r1", "alice", "owner"));
  assert.equal(err.code, "dm_consent_required");
  dms.block("r1", "bob", "alice");
  err = errOf(() => dms.requireDmAllowed("r1", "alice", "bob"));
  assert.equal(err.status, 403); assert.equal(err.code, "dm_blocked");
});

test("revoke is unilateral: either participant may revoke", () => {
  const store = makeStore({ r1: baseState() });
  const dms = new DmConsents(store);
  dms.request("r1", "alice", "bob");
  dms.decide("r1", "bob", "alice", "approve");
  const revoked = dms.revoke("r1", "bob", "alice"); // target revokes
  assert.equal(revoked.status, "revoked");
  assert.equal(errOf(() => dms.revoke("r1", "bob", "alice")).code, "dm_nothing_to_revoke");
});

test("default-open: no consent row is ever seeded; explicit revoke still refuses", () => {
  const state = baseState();
  state.messages.push({ id: "m1", authorId: "alice", toMemberId: "bob", body: "old dm", createdAt: 5 });
  const store = makeStore({ r1: state });
  const dms = new DmConsents(store);
  assert.equal(dms.requireDmAllowed("r1", "alice", "bob"), true); // default open
  const row = store.db.prepare("SELECT status FROM dm_consents WHERE room_id='r1' AND requester_id='alice'").get();
  assert.equal(row, undefined, "default-open never writes a consent row");
  dms.block("r1", "bob", "alice");
  const err = errOf(() => dms.requireDmAllowed("r1", "alice", "bob"));
  assert.equal(err.code, "dm_blocked"); // explicit denial wins over history
});

test("list: participants see own pairs; owner sees all metadata; ids alongside handles", () => {
  const store = makeStore({ r1: baseState() });
  const dms = new DmConsents(store);
  dms.request("r1", "alice", "bob", "sync?");
  const aliceList = dms.list("r1", "alice");
  assert.equal(aliceList.length, 1);
  assert.equal(aliceList[0].requester, "Alice");
  assert.equal(aliceList[0].target, "Bob");
  assert.equal(aliceList[0].outgoing, true);
  // Display names are not unique per room: rows carry the authoritative
  // member ids so browser actions never guess an ambiguous target. Member
  // ids are not a new disclosure — members already see them in presence.
  assert.equal(aliceList[0].requesterId, "alice");
  assert.equal(aliceList[0].targetId, "bob");
  const ownerList = dms.list("r1", "owner");
  assert.equal(ownerList.length, 1);
  const bobList = dms.list("r1", "bob");
  assert.equal(bobList.length, 1);
  assert.equal(bobList[0].outgoing, false);
  // A third party sees nothing.
  const store2 = makeStore({ r1: { ...baseState(), members: { ...baseState().members, cara: member("cara", "Cara") } } });
  const dms2 = new DmConsents(store2);
  dms2.request("r1", "alice", "bob");
  assert.equal(dms2.list("r1", "cara").length, 0);
});

test("pendingFor feeds the inbox with handles, reasons, and the decide path", () => {
  const store = makeStore({ r1: baseState() });
  const dms = new DmConsents(store);
  dms.request("r1", "alice", "bob", "please?");
  const pending = dms.pendingFor("r1", "bob");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].requester, "Alice");
  assert.equal(pending[0].reason, "please?");
  assert.equal(pending[0].requesterId, "alice");
  assert.equal(pending[0].decide.method, "POST");
  assert.equal(pending[0].decide.path, "/api/rooms/r1/dm-consents/alice/decide");
  assert.equal(dms.pendingFor("r1", "alice").length, 0);
});

test("default-open against a real RoomStore projection: DM posts without consent", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { randomUUID } = await import("node:crypto");
  const { RoomStore } = await import("../server/store.mjs");
  const { initialRoom } = await import("../server/bootstrap.mjs");
  const directory = mkdtempSync(join(tmpdir(), "dm-open-"));
  try {
    const store = new RoomStore(join(directory, "room.sqlite"));
    store.initialize(initialRoom("commons"));
    const ownerKey = store.issueAccessKey("commons", "owner");
    for (const [id, name] of [["alice", "Alice"], ["bob", "Bob"]]) {
      store.command(ownerKey, "commons", { id: randomUUID(), type: "member.added",
        data: { memberId: id, displayName: name, kind: "agent", permissions: [] } });
      // Graduated autonomy tiers: the fixture agent is operator-promoted so the
      // migration test exercises it as a working agent.
      setTier(store.db, "commons", id, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
    }
    const aliceKey = store.issueAccessKey("commons", "alice");
    // No consent row at all: the DM posts on default-open.
    store.command(aliceKey, "commons", { id: randomUUID(), type: "message.posted",
      data: { messageId: "open-dm-1", body: "hello bob", toMemberId: "bob" } });
    const projected = store.room("commons").state.messages.some(
      m => m.authorId === "alice" && m.toMemberId === "bob" && m.body === "hello bob");
    assert.ok(projected, "the DM must reach the real projection without consent");
    assert.equal(store.dmConsents.requireDmAllowed("commons", "alice", "bob"), true);
    const row = store.db.prepare(
      "SELECT status FROM dm_consents WHERE room_id='commons' AND requester_id='alice' AND target_id='bob'").get();
    assert.equal(row, undefined, "default-open never seeds a consent row");
    // Both directions flow; a bystander pair with no history flows too.
    assert.equal(store.dmConsents.requireDmAllowed("commons", "bob", "alice"), true);
    store.command(ownerKey, "commons", { id: randomUUID(), type: "member.added",
      data: { memberId: "carol", displayName: "Carol", kind: "agent", permissions: [] } });
    assert.equal(store.dmConsents.requireDmAllowed("commons", "carol", "alice"), true);
    // But an explicit block still refuses through the real command path.
    store.dmConsents.block("commons", "alice", "carol");
    const carolKey = store.issueAccessKey("commons", "carol");
    const err = errOf(() => store.command(carolKey, "commons", { id: randomUUID(), type: "message.posted",
      data: { messageId: "blocked-dm-1", body: "nope", toMemberId: "alice" } }));
    assert.equal(err.code, "dm_blocked");
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("block proactively refuses future requests; unblock reopens the flow", () => {
  const store = makeStore({ r1: baseState() });
  const dms = new DmConsents(store);
  const blocked = dms.block("r1", "bob", "alice");
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.requesterId, "alice");
  assert.equal(blocked.targetId, "bob");
  // Alice cannot even ask now.
  assert.equal(errOf(() => dms.request("r1", "alice", "bob")).code, "dm_blocked");
  assert.equal(errOf(() => dms.requireDmAllowed("r1", "alice", "bob")).code, "dm_blocked");
  // Idempotent.
  assert.equal(dms.block("r1", "bob", "alice").status, "blocked");
  // Unblock returns the row to rejected; an explicit rejection still refuses
  // (the recipient said no), but the request flow reopens.
  assert.equal(dms.unblock("r1", "bob", "alice").status, "rejected");
  assert.equal(errOf(() => dms.requireDmAllowed("r1", "alice", "bob")).code, "dm_consent_required");
  assert.equal(dms.request("r1", "alice", "bob").status, "pending");
});

test("block flips an existing approved consent to blocked", () => {
  const store = makeStore({ r1: baseState() });
  const dms = new DmConsents(store);
  dms.request("r1", "alice", "bob");
  dms.decide("r1", "bob", "alice", "approve");
  assert.equal(dms.block("r1", "bob", "alice").status, "blocked");
  assert.equal(errOf(() => dms.requireDmAllowed("r1", "alice", "bob")).code, "dm_blocked");
  // Directional: bob → alice has no row — default open, untouched by the block.
  assert.equal(dms.requireDmAllowed("r1", "bob", "alice"), true);
});

test("block rejects self, unknown and inactive members", () => {
  const store = makeStore({ r1: baseState() });
  const dms = new DmConsents(store);
  assert.equal(errOf(() => dms.block("r1", "bob", "bob")).code, "invalid_dm_block");
  assert.equal(errOf(() => dms.block("r1", "bob", "ghost")).code, "blocked_not_found");
  assert.equal(errOf(() => dms.block("r1", "bob", "zed")).code, "blocked_not_found");
  assert.equal(errOf(() => dms.block("nope", "bob", "alice")).code, "room_not_found");
});

test("default-open: strangers may DM; an explicit block the other way still wins", () => {
  const store = makeStore({ r1: baseState() });
  const dms = new DmConsents(store);
  dms.request("r1", "alice", "bob");
  // No gate: bob may write to alice even before deciding the request.
  assert.equal(dms.requireDmAllowed("r1", "bob", "alice"), true);
  dms.decide("r1", "bob", "alice", "approve");
  assert.equal(dms.requireDmAllowed("r1", "bob", "alice"), true);
  // Alice blocks bob: the explicit bob -> alice block wins over default-open.
  dms.block("r1", "alice", "bob");
  assert.equal(errOf(() => dms.requireDmAllowed("r1", "bob", "alice")).code, "dm_blocked");
  // A bystander pair with no row at all flows on default-open.
  assert.equal(dms.requireDmAllowed("r1", "carol", "alice"), true);
});
