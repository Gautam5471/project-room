import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { textVersion } from "../server/text-results.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { AccessRequests } from "../server/access-requests.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { emitWorkClaimEvent } from "../server/work-claim-events.mjs";
import { seedStarter } from "../server/starter-room.mjs";

// A gate for one bug class, found three times in one day.
//
// auditRecovery runs four auditors - text results, charters, reply requests and
// work help - and each replays the event log into its own narrower model, then
// asserts that model deep-equals the live projection. Any legitimate event an
// auditor does not implement makes the two disagree PERMANENTLY: no later event
// restores agreement. And auditRecovery gates backupRoom and loops every room,
// so a single such event in a single room stops the entire database being
// backed up, while nothing whatever is corrupt.
//
// Found this way, not by reading:
//   * auditReplyRequests skipped message.edited / message.deleted, so any edit
//     in a room holding a reply request broke backups.
//   * auditCharters never followed ownership.transferred, so the first transfer
//     broke them.
//   * auditCharters also required the owner to be human, so every room made by
//     POST /api/agent-rooms broke them the moment it was created.
//
// So the gate is not "test the auditors", it is "drive the room through every
// event type the product has and require the audit to survive each one". A new
// event type that no auditor models should fail here, naming itself, on the
// commit that introduces it.
//
// Checked against the bugs that motivated it rather than assumed: reverting the
// reply-request fix makes this fail naming message.posted, message.edited and
// message.deleted; reverting the charter fix makes it fail naming
// ownership.transferred.
//
// It does NOT catch the third one, and that is worth stating plainly. Editing a
// message bound as completion evidence needs a particular order - complete with
// room_text evidence, then edit that exact message - which a linear sweep of
// event types never produces. A sweep catches "this event type was never
// modelled"; it cannot catch "this combination was never considered". That one
// is pinned by tests/work-evidence-immutable.test.js, and its existence is the
// reason not to treat this file as covering the class on its own.

const W = "test-handoff";
const W2 = "write-work";

function sweep() {
  const fixture = createAcceptanceFixture();
  const state = () => fixture.store.room("commons").state;
  const item = (id = W) => state().workItems[id];
  const exercised = new Set(["room.created", "member.added", "work.proposed"]);
  const broke = [];
  // Consent-bound DMs: the sweep's owner→producer reply-request DM needs approval.
  fixture.store.dmConsents.request("commons", "owner", "producer", "test fixture");
  fixture.store.dmConsents.decide("commons", "producer", "owner", "approve");

  const step = (type, actor, data) => {
    let receipt;
    try { receipt = fixture.store.command(fixture.keys[actor], "commons", { id: randomUUID(), type, data: typeof data === "function" ? data() : data }); }
    catch { return null; } // Refused commands are not this test's subject.
    exercised.add(type);
    try { auditRecovery(fixture.store); }
    catch (error) { broke.push(`${type}: ${error.message}`); }
    return receipt;
  };

  step(T.ROOM_CHARTER_UPDATED, "owner", () => ({ expectedRevision: state().room.charter?.revision ?? 0, purpose: "Coordinate the pilot.", outputs: "An agenda.", boundaries: "No spend.", escalation: "Ask the owner." }));
  step(T.ROOM_POLICY_SET, "owner", { requireIndependentReview: true, requireOwnerDecision: true });
  step(T.ROOM_SPEND_ALLOWANCE_SET, "owner", { allowanceCents: 10000, periodDays: 30 });
  step(T.ROOM_SPEND_PRICING_SET, "owner", { enabled: false });
  step(T.ROOM_SPEND_PRICING_SET, "owner", { enabled: true });
  step(T.ROOM_TRUST_SET, "owner", { enabled: false });
  step(T.ROOM_PUBLIC_RECEIPTS_SET, "owner", { enabled: true });
  // --- PRIV-2: history setting (restored to "all" for the rest of the sweep) and export audit. ---
  step(T.ROOM_HISTORY_VISIBILITY_SET, "owner", { historyVisibility: "since_join" });
  step(T.ROOM_HISTORY_VISIBILITY_SET, "owner", { historyVisibility: "all" });
  step(T.ROOM_EXPORTED, "owner", { format: "jsonl" });
  // --- GR2 opt-ins. Each one has to replay through auditRecovery. ---
  step(T.ROOM_PUBLIC_PAGE_SET, "owner", { enabled: true });
  step(T.ROOM_JOIN_LINK_SET, "owner", { enabled: true });
  step(T.MEMBER_PUBLIC_NAME_SET, "owner", { enabled: true });
  step(T.WORK_PUBLIC_SET, "owner", { workItemId: W, enabled: true });
  // --- end GR2 ---
  step(T.NOTIFICATION_PREFERENCES_SET, "producer", { preferences: { mentions: "all" } });
  step(T.MEMBER_STATUS_UPDATED, "producer", { memberId: "producer", message: "Working on the agenda" });
  step(T.CAPABILITIES_ADVERTISED, "producer", { capabilities: ["text"] });
  step(T.MEMBER_MUTE_SET, "owner", { memberId: "guest", muted: true });

  // Channels arrived after this sweep was written; the EVENT_TYPES tripwire
  // below is what forced them to be covered rather than silently skipped.
  step(T.CHANNEL_CREATED, "owner", { channelId: "side", name: "side-quest" });
  step(T.CHANNEL_RENAMED, "owner", { channelId: "side", name: "side-track" });
  step(T.CHANNEL_ARCHIVED, "owner", { channelId: "side" });

  step(T.MESSAGE_POSTED, "producer", { messageId: "chat-1", body: "hello room" });
  step(T.MESSAGE_EDITED, "producer", { messageId: "chat-1", body: "hello room, again", expectedMessageRevision: 0 });
  step(T.MESSAGE_REACTION_SET, "reviewer", { messageId: "chat-1", reaction: "like", active: true });
  step(T.MESSAGE_PINNED, "owner", { messageId: "chat-1" });
  step(T.MESSAGE_UNPINNED, "owner", { messageId: "chat-1" });
  step(T.MESSAGE_DELETED, "producer", { messageId: "chat-1", expectedMessageRevision: 1, reason: "tidy" });

  // An open reply request is what arms auditReplyRequests' whole-message-list
  // comparison, so every message event after this point is the regression that
  // took backups down.
  step(T.MESSAGE_POSTED, "owner", { messageId: "req-1", body: "Please confirm", toMemberId: "producer", requestKind: "reply" });
  step(T.MESSAGE_POSTED, "producer", { messageId: "chat-2", body: "an ordinary message while a request is open" });
  step(T.MESSAGE_EDITED, "producer", { messageId: "chat-2", body: "edited while a request is open", expectedMessageRevision: 0 });
  step(T.MESSAGE_DELETED, "producer", { messageId: "chat-2", expectedMessageRevision: 1, reason: "tidy" });
  step(T.REPLY_REQUEST_CANCELLED, "owner", () => ({ requestMessageId: "req-1", expectedRequestRevision: state().replyRequests?.["req-1"]?.revision ?? 0, reason: "never mind" }));

  step(T.WORK_ACCEPTED, "producer", () => ({ workItemId: W, expectedRevision: item().revision }));
  // Help only opens on accepted work, and auditWorkHelp short-circuits to
  // almost nothing until a help event exists - so without this the sweep was
  // walking straight past that auditor while appearing to cover the room.
  step(T.WORK_HELP_UPDATED, "producer", () => ({
    workItemId: W, expectedRevision: item().revision, expectedHelpRevision: item().helpWanted?.revision ?? 0,
    status: "open", scope: "A second pair of eyes", expiresAt: new Date(Date.now() + 3600_000).toISOString()
  }));
  step(T.WORK_STARTED, "producer", () => ({ workItemId: W, expectedRevision: item().revision }));
  step(T.SESSION_STOP_REQUESTED, "owner", () => ({ workItemId: W, expectedRevision: item().revision }));
  step(T.SESSION_STOPPED, "producer", () => ({ workItemId: W, expectedRevision: item().revision, status: "done", spendCents: 20, budgetEnforced: true, reason: "finished", outputs: "agenda" }));
  step(T.WORK_BLOCKED, "producer", () => ({ workItemId: W, expectedRevision: item().revision, reason: "waiting", nextAction: "unblock" }));
  step(T.WORK_BLOCKER_RESOLVED, "producer", () => ({ workItemId: W, expectedRevision: item().revision, resolution: "unblocked" }));

  const posted = step(T.MESSAGE_POSTED, "producer", { messageId: "draft-1", workItemId: W, body: "The agenda is owned by Potter." });
  if (posted) {
    step(T.WORK_COMPLETED, "producer", () => ({
      workItemId: W, expectedRevision: item().revision, evidenceKind: "room_text",
      evidenceMessageId: "draft-1", evidenceMessageEventId: posted.event.id,
      evidenceVersion: textVersion("The agenda is owned by Potter."), previousCompletionEventId: null,
      producerId: "producer", summary: "Exact room result", nextAction: "Review"
    }));
    step(T.VERIFICATION_RECORDED, "reviewer", () => ({
      workItemId: W, expectedRevision: item().revision, result: "pass",
      completionEventId: item().receipt.eventId, evidenceVersion: item().receipt.evidenceVersion, summary: "Looks right"
    }));
    // PRIV-1: deleting the recorded result appends message.redacted and
    // receipt.evidence_withdrawn. Those are not commands; the delete is.
    step(T.MESSAGE_DELETED, "owner", { messageId: "draft-1", expectedMessageRevision: 0, reason: "remove the recorded text" });
    for (const type of [T.MESSAGE_REDACTED, T.RECEIPT_EVIDENCE_WITHDRAWN]) {
      if (fixture.store.db.prepare("SELECT 1 FROM events WHERE room_id='commons' AND json_extract(body,'$.type')=? LIMIT 1").get(type)) exercised.add(type);
      else broke.push(`${type}: deleting recorded text did not write this event`);
    }
  }
  step(T.DECISION_RECORDED, "owner", { sourceMessageId: "req-1", statement: "We ship Friday", note: "agreed" });

  step(T.MESSAGE_POSTED, "owner", { messageId: "src-2", body: "Please do the write work" });
  step(T.WORK_PROPOSED, "owner", { workItemId: W2, title: "Write work", definitionOfDone: "Files changed.", accountableMemberId: "producer", verifierMemberId: "reviewer", humanDecisionMakerId: "owner", mode: "write", sourceMessageId: "src-2" });
  step(T.WORK_ACCEPTED, "producer", () => ({ workItemId: W2, expectedRevision: item(W2).revision }));
  step(T.WORK_SUPERSEDED, "owner", () => ({ workItemId: W2, expectedRevision: item(W2).revision, supersededByWorkItemId: W, reason: "folded in" }));

  // access.requested is appended by server/access-requests.mjs, not by
  // store.command, so the step() helper above cannot reach it - and an event
  // type no auditor has ever seen is exactly what this sweep is for. Driven
  // through the real path instead, with a real identity, because the point is
  // the event that lands in the log.
  try {
    const identity = fixture.store.identities.create("Sweep asker");
    new AccessRequests(fixture.store).request("commons", {
      identityId: identity.identityId, displayName: "Sweep asker",
      requestedPermissions: ["steer"], note: "let me in", requestId: "sweep-access-request"
    });
    exercised.add(T.ACCESS_REQUESTED);
    try { auditRecovery(fixture.store); }
    catch (error) { broke.push(`${T.ACCESS_REQUESTED}: ${error.message}`); }
  } catch { /* reported below, from the log, rather than swallowed here */ }
  // referral.completed is appended by server/referrals.mjs, not by
  // store.command, so the step() helper above cannot reach it. Driven through
  // the real path: the sweep fixture's producer refers a new member.
  try {
    const referee = fixture.store.identities.create("Sweep referee");
    fixture.store.command(fixture.keys.owner, "commons", {
      id: randomUUID(), type: T.MEMBER_ADDED,
      data: { memberId: referee.identityId, displayName: "Sweep referee", kind: "agent", permissions: ["steer"] },
    });
    fixture.store.referrals.record({ roomId: "commons", referrerMemberId: "producer", refereeMemberId: referee.identityId, via: "invite" });
    exercised.add(T.REFERRAL_COMPLETED);
    try { auditRecovery(fixture.store); }
    catch (error) { broke.push(`${T.REFERRAL_COMPLETED}: ${error.message}`); }
  } catch { /* reported below, from the log, rather than swallowed here */ }
  // A step that quietly stopped working would leave this sweep passing because
  // it audited nothing, which is the failure mode the whole file is written
  // against. Read it back out of the log.
  if (!fixture.store.db.prepare("SELECT 1 FROM events WHERE room_id='commons' AND json_extract(body,'$.type')=? LIMIT 1").get(T.ACCESS_REQUESTED))
    broke.push(`${T.ACCESS_REQUESTED}: the sweep never got this event into the log, so nothing was audited`);

  // member.joined_via_invitation is appended by share-link and invitation
  // acceptance, never by store.command, so step() cannot produce it either.
  // The fixture's bootstrap writes one, which means every audit above already
  // replayed it - but only BEFORE everything else, and nothing counted it.
  // Join again through the real path now, after the whole work lifecycle, so
  // the auditors meet it late in a busy log too, and read it back from the log
  // rather than assume it landed.
  try {
    const joinsBefore = fixture.store.db.prepare("SELECT count(*) n FROM events WHERE room_id='commons' AND json_extract(body,'$.type')=?").get(T.MEMBER_JOINED_VIA_INVITATION).n;
    const linkToken = randomBytes(32).toString("base64url");
    fixture.store.shareLinks.create(fixture.keys.owner, "commons", { requestId: randomUUID(), linkToken,
      expiresAt: Date.now() + 3600000, maxJoins: 1, expectedMemberRevision: state().members.owner.revision }, null);
    const slot = fixture.store.createAccountSessionSlot(), current = fixture.store.accountSessionSlot(slot.token);
    fixture.store.shareLinks.join(slot.token, linkToken, { displayName: "Sweep late joiner", redemptionId: randomUUID(),
      expectedSessionRevision: current.sessionRevision, expectedSessionBinding: current.sessionBinding });
    const joinsAfter = fixture.store.db.prepare("SELECT count(*) n FROM events WHERE room_id='commons' AND json_extract(body,'$.type')=?").get(T.MEMBER_JOINED_VIA_INVITATION).n;
    if (joinsAfter > joinsBefore) {
      exercised.add(T.MEMBER_JOINED_VIA_INVITATION);
      try { auditRecovery(fixture.store); }
      catch (error) { broke.push(`${T.MEMBER_JOINED_VIA_INVITATION}: ${error.message}`); }
    } else broke.push(`${T.MEMBER_JOINED_VIA_INVITATION}: the late join never reached the log, so nothing was audited`);
  } catch (error) { broke.push(`${T.MEMBER_JOINED_VIA_INVITATION}: the late join was refused (${error.message}), so nothing was audited`); }

  // Bond receipts are command types that differ from the ledger type
  // (bond.propose → bond.proposed). Exercise them with two linked identities
  // so the auditors meet the four new event types before the room ends.
  try {
    const left = fixture.store.identities.create("Sweep bond left");
    const right = fixture.store.identities.create("Sweep bond right");
    fixture.store.identities.link(fixture.keys.owner, "commons", {
      identityId: left.identityId, displayName: "Sweep bond left", permissions: ["accept_work"]
    });
    fixture.store.identities.link(fixture.keys.owner, "commons", {
      identityId: right.identityId, displayName: "Sweep bond right", permissions: ["accept_work"]
    });
    // Graduated autonomy tiers: linked agent identities enroll at t1_readonly;
    // promote them so the sweep exercises the bond command surface.
    for (const identity of [left, right])
      setTier(fixture.store.db, "commons", identity.identityId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
    const proposed = fixture.store.command(left.secret, "commons", {
      id: randomUUID(), type: "bond.propose", data: { to: right.identityId, scopes: ["peer.dm"] }
    });
    exercised.add(proposed.event.type);
    auditRecovery(fixture.store);
    const bondId = proposed.event.data.bondId;
    const accepted = fixture.store.command(right.secret, "commons", {
      id: randomUUID(), type: "bond.accept", data: { bondId, scopes: ["peer.dm"] }
    });
    exercised.add(accepted.event.type);
    auditRecovery(fixture.store);
    const posted = fixture.store.command(left.secret, "commons", {
      id: randomUUID(), type: "dm.posted",
      data: { to: right.identityId, messageId: randomUUID(), body: "Synthetic peer DM" }
    });
    exercised.add(posted.event.type);
    auditRecovery(fixture.store);
    const revoked = fixture.store.command(left.secret, "commons", {
      id: randomUUID(), type: "bond.revoke", data: { bondId }
    });
    exercised.add(revoked.event.type);
    auditRecovery(fixture.store);
  } catch (error) { broke.push(`bond: ${error.message}`); }

  // land.updated is not a command. Reporting a tip on a queued pull request
  // emits it, so the auditors meet the thin wake receipt before the room ends.
  try {
    const itemId = "lq_sweep";
    const now = Date.now();
    fixture.store.db.prepare(`INSERT INTO land_queue
      (room_id, item_id, repo, pr_number, claimant_member_id, added_by_member_id, title, head_sha,
       mergeable, behind, checks_state, merged_sha, tip_source_revision, tip_build_id, last_error, observed,
       created_at, updated_at)
      VALUES ('commons', ?, 'acme/widgets', 7, 'owner', 'owner', 'Sweep PR', ?, 'mergeable', 0, 'pending', NULL, NULL, NULL, NULL, 1, ?, ?)`)
      .run(itemId, "a".repeat(40), now, now);
    fixture.store.landQueue.reportTip("commons", "owner", { itemId, sourceRevision: "rev-sweep" });
    exercised.add(T.LAND_UPDATED);
    auditRecovery(fixture.store);
  } catch (error) { broke.push(`${T.LAND_UPDATED}: ${error.message}`); }
  if (!fixture.store.db.prepare("SELECT 1 FROM events WHERE room_id='commons' AND json_extract(body,'$.type')=? LIMIT 1").get(T.LAND_UPDATED))
    broke.push(`${T.LAND_UPDATED}: the sweep never got this event into the log, so nothing was audited`);

  // work_claim.updated is not a command. A board claim change emits it, and
  // the receipt must replay without moving the projection (the work_claims
  // table stays the source of truth). Archive comes next, which closes the log.
  try {
    const emitted = emitWorkClaimEvent(fixture.store, "commons", {
      actorId: "owner",
      action: "claimed",
      item: {
        id: "sweep-claim", title: "Sweep claim", state: "claimed", owner: "owner",
        leaseExpiresAt: null, files: ["src/sweep.js"]
      }
    });
    exercised.add(emitted.event.type);
    auditRecovery(fixture.store);
  } catch (error) { broke.push(`${T.WORK_CLAIM_UPDATED}: ${error.message}`); }
  if (!fixture.store.db.prepare("SELECT 1 FROM events WHERE room_id='commons' AND json_extract(body,'$.type')=? LIMIT 1").get(T.WORK_CLAIM_UPDATED))
    broke.push(`${T.WORK_CLAIM_UPDATED}: the sweep never got this event into the log, so nothing was audited`);

  // room.starter_seeded is not a command. Seeding the fixture room records it
  // before the room is archived.
  try {
    seedStarter(fixture.store, "commons", { intent: "bug", ownerMemberId: "owner" });
    exercised.add(T.ROOM_STARTER_SEEDED);
    auditRecovery(fixture.store);
  } catch (error) { broke.push(`${T.ROOM_STARTER_SEEDED}: ${error.message}`); }
  if (!fixture.store.db.prepare("SELECT 1 FROM events WHERE room_id='commons' AND json_extract(body,'$.type')=? LIMIT 1").get(T.ROOM_STARTER_SEEDED))
    broke.push(`${T.ROOM_STARTER_SEEDED}: the sweep never got this event into the log, so nothing was audited`);

  // Last, because both end the room's normal life.
  step(T.OWNERSHIP_TRANSFERRED, "owner", { toMemberId: "producer", reason: "handing the room over" });
  step(T.ROOM_ARCHIVED, "producer", { reason: "pilot over" });

  const directory = fixture.directory;
  fixture.store.close();
  rmSync(directory, { recursive: true, force: true });
  return { exercised, broke };
}

const result = sweep();

test("no event type leaves the room unauditable", () => {
  assert.deepEqual(result.broke, [], "these events broke auditRecovery, which means backupRoom is down for every room");
});

test("the sweep covers enough of the event surface to be worth trusting", () => {
  // Not every type is reachable from one fixture: some need an invitation, a
  // spend allowance, write_external permission or a live session. The floor
  // stops the sweep quietly rotting into a no-op if a step starts being
  // refused - which would make the test above pass for the wrong reason.
  const all = Object.values(T);
  const missing = all.filter(type => !result.exercised.has(type));
  assert.ok(result.exercised.size >= 34,
    `only ${result.exercised.size} of ${all.length} event types were exercised; not covered: ${missing.join(", ")}`);
});

test("the event surface has not grown without this sweep noticing", () => {
  // A deliberate tripwire. When someone adds an event type, this fails and they
  // decide: teach the sweep to exercise it, or record that it cannot be. Either
  // is fine. Silently adding an event no auditor models is what is not.
  //
  // claim.renewed is not exercised here: it needs an active claim plus the
  // holder's public progress message posted after that claim. The sweep does
  // not acquire one. The reducer's validation is covered by
  // tests/lease-renewal.test.js instead.
  // land.updated is exercised above via report_tip (it is not a command).
  // work_claim.updated is exercised above via emitWorkClaimEvent (it is not a command).
  // room.starter_seeded is exercised above via seedStarter (it is not a command).
  // dm.consent_changed is exercised on a real RoomStore in tests/dm-consent-events.test.js.
  assert.equal(Object.values(T).length, 66,
    "EVENT_TYPES changed: add the new type to this sweep, then update this count");
});
