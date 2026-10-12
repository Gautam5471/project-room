import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { dmConsentSchema } from "../server/dm-consents.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

// A room with owner, alice, bob and carol. Alice asks Bob for DM consent;
// carol and the visibility filter are the watchers.
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-dm-consent-events-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(dmConsentSchema);
  const ownerKey = store.issueAccessKey("commons", "owner");
  const command = (type, data) => store.command(ownerKey, "commons", { id: randomUUID(), type, data });
  command(T.MEMBER_ADDED, { memberId: "alice", displayName: "Alice", kind: "human", permissions: [] });
  command(T.MEMBER_ADDED, { memberId: "bob", displayName: "Bob", kind: "human", permissions: [] });
  command(T.MEMBER_ADDED, { memberId: "carol", displayName: "Carol", kind: "human", permissions: [] });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

const consentEvents = rows => rows.filter(({ event }) => event?.type === "dm.consent_changed").map(({ event }) => event.data);

test("fail-first: a DM consent request and its decision append sequenced pair events", t => {
  const store = fixture(t);
  const aliceKey = store.issueAccessKey("commons", "alice");
  const bobKey = store.issueAccessKey("commons", "bob");
  const before = store.room("commons").sequence;

  const request = store.dmConsents.request("commons", "alice", "bob", "quick question");
  assert.equal(request.status, "pending");

  const page = store.eventsAfter(aliceKey, "commons", before, 100);
  const events = consentEvents(page.events);
  assert.equal(events.length, 1, "request() must append exactly one dm.consent_changed event");
  assert.equal(events[0].requesterId, "alice");
  assert.equal(events[0].targetId, "bob");
  assert.equal(events[0].status, "pending");
  assert.equal(store.room("commons").sequence, before + 1, "the event must advance the room sequence");

  store.dmConsents.decide("commons", "bob", "alice", "approve");
  const afterDecision = consentEvents(store.eventsAfter(bobKey, "commons", before, 100).events);
  assert.equal(afterDecision.length, 2, "decide() must append a second dm.consent_changed event");
  assert.deepEqual([afterDecision[1].status, afterDecision[1].requesterId, afterDecision[1].targetId],
    ["approved", "alice", "bob"]);
  assert.equal(store.room("commons").sequence, before + 2);
});

test("a dm.consent_changed event is pair-visible: parties and owner see it, other members do not", t => {
  const store = fixture(t);
  const aliceKey = store.issueAccessKey("commons", "alice");
  const bobKey = store.issueAccessKey("commons", "bob");
  const carolKey = store.issueAccessKey("commons", "carol");
  const ownerKey = store.issueAccessKey("commons", "owner");
  const before = store.room("commons").sequence;

  store.dmConsents.request("commons", "alice", "bob", "quick question");
  store.dmConsents.decide("commons", "bob", "alice", "approve");

  const aliceView = consentEvents(store.eventsAfter(aliceKey, "commons", before, 100).events);
  const bobView = consentEvents(store.eventsAfter(bobKey, "commons", before, 100).events);
  const carolView = consentEvents(store.eventsAfter(carolKey, "commons", before, 100).events);
  assert.equal(aliceView.length, 2);
  assert.equal(bobView.length, 2);
  assert.equal(consentEvents(store.eventsAfter(ownerKey, "commons", before, 100).events).length, 2, "the owner sees pair metadata for moderation");
  assert.equal(carolView.length, 0, "a non-party member must not see the pair's consent events");
});

test("fail-first: revoke, block and unblock append pair events; a repeat block appends none", t => {
  const store = fixture(t);
  const aliceKey = store.issueAccessKey("commons", "alice");
  const before = store.room("commons").sequence;

  store.dmConsents.request("commons", "alice", "bob", "quick question");
  store.dmConsents.decide("commons", "bob", "alice", "approve");
  store.dmConsents.request("commons", "bob", "alice");
  store.dmConsents.decide("commons", "alice", "bob", "approve");
  const afterApprovals = consentEvents(store.eventsAfter(aliceKey, "commons", before, 100).events);
  assert.equal(afterApprovals.length, 4);

  store.dmConsents.revoke("commons", "alice", "bob");
  const afterRevoke = consentEvents(store.eventsAfter(aliceKey, "commons", before, 100).events);
  assert.equal(afterRevoke.length, 6, "revoke() must append one event per approved directional row");
  assert.deepEqual(afterRevoke.slice(4).map(e => [e.status, e.requesterId, e.targetId]).sort(),
    [["revoked", "alice", "bob"], ["revoked", "bob", "alice"]]);
  assert.equal(store.room("commons").sequence, before + 6);

  store.dmConsents.block("commons", "bob", "alice");
  store.dmConsents.block("commons", "bob", "alice");
  const afterBlock = consentEvents(store.eventsAfter(aliceKey, "commons", before, 100).events);
  assert.equal(afterBlock.length, 7, "block() must append once; a repeat block is idempotent and appends nothing");
  assert.deepEqual([afterBlock[6].status, afterBlock[6].requesterId, afterBlock[6].targetId],
    ["blocked", "alice", "bob"]);

  store.dmConsents.unblock("commons", "bob", "alice");
  const afterUnblock = consentEvents(store.eventsAfter(aliceKey, "commons", before, 100).events);
  assert.equal(afterUnblock.length, 8);
  assert.deepEqual([afterUnblock[7].status, afterUnblock[7].requesterId, afterUnblock[7].targetId],
    ["rejected", "alice", "bob"]);
  assert.equal(store.room("commons").sequence, before + 8);
});
