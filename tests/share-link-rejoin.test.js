// r104: a member who leaves a room comes back with a fresh valid invitation;
// a member the owner removed does not.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T, INVITATION_ROLES } from "../src/events.js";

function setup(t) {
  const directory = mkdtempSync(pathJoin(tmpdir(), "room-rejoin-"));
  const store = new RoomStore(pathJoin(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const ownerKey = store.issueAccessKey("commons", "owner");
  const slot = store.createAccountSessionSlot();
  const link = (extra = {}) => {
    const linkToken = randomBytes(32).toString("base64url");
    store.shareLinks.create(ownerKey, "commons", { requestId: randomUUID(), linkToken, expiresAt: Date.now() + 3600000, maxJoins: 5,
      expectedMemberRevision: store.room("commons").state.members.owner.revision, ...extra }, null);
    return linkToken;
  };
  const join = linkToken => {
    const s = store.accountSessionSlot(slot.token);
    return store.shareLinks.join(slot.token, linkToken, { displayName: "Friend", redemptionId: randomUUID(), expectedSessionRevision: s.sessionRevision, expectedSessionBinding: s.sessionBinding });
  };
  const members = () => store.room("commons").state.members;
  const setActive = (actorKey, memberId, active) => {
    const m = members()[memberId];
    store.command(actorKey, "commons", { id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED, data: { memberId, expectedMemberRevision: m.revision, permissions: [...m.permissions], active } });
  };
  const bindings = () => store.db.prepare("SELECT count(*) AS n FROM member_accounts WHERE room_id='commons'").get().n;
  return { store, ownerKey, link, join, members, setActive, bindings };
}

test("a member who left comes back with a fresh invitation: reactivated once, no second binding", t => {
  const { store, ownerKey, link, join, members, setActive, bindings } = setup(t);
  const first = join(link()), id = first.session.member.id, before = bindings();
  // The member leaves with their own session credential, like the Leave room button.
  const memberKey = store.issueAccessKey("commons", id);
  setActive(memberKey, id, false);
  assert.equal(members()[id].active, false);
  const back = join(link());
  assert.equal(back.session.member.id, id);
  assert.equal(members()[id].active, true);
  assert.equal(bindings(), before, "no duplicate member_accounts row");
  assert.equal(Object.values(members()).filter(m => m.displayName === "Friend").length, 1, "no second roster entry");
  // Joining again while active is the ordinary duplicate path.
  assert.equal(join(link()).duplicate, true);
  assert.ok(ownerKey);
});

test("the permissions of the new invitation apply, not the old membership's", t => {
  const { store, link, join, members, setActive } = setup(t);
  const id = join(link()).session.member.id, guestPermissions = [...members()[id].permissions];
  setActive(store.issueAccessKey("commons", id), id, false);
  const back = join(link({ access: "member" }));
  assert.equal(back.session.member.id, id);
  assert.equal(members()[id].active, true);
  assert.notDeepEqual([...members()[id].permissions].sort(), guestPermissions.sort());
});

test("a member the owner removed stays blocked, with a clear error, and is not reactivated", t => {
  const { ownerKey, link, join, members, setActive, bindings } = setup(t);
  const id = join(link()).session.member.id, before = bindings();
  setActive(ownerKey, id, false);
  assert.throws(() => join(link()), error => error.status === 403 && error.code === "membership_removed");
  assert.equal(members()[id].active, false);
  assert.equal(bindings(), before);
});

test("a self-left member cannot use a cancelled or expired link", t => {
  const { store, ownerKey, link, join, members, setActive } = setup(t);
  const id = join(link()).session.member.id;
  setActive(store.issueAccessKey("commons", id), id, false);
  const token = link(), row = store.shareLinks.find(token);
  store.shareLinks.cancel(ownerKey, "commons", row.id, null);
  assert.throws(() => join(token), error => error.status === 410);
  assert.equal(members()[id].active, false);
});

// Targeted invitations (issueInvitation / acceptInvitation).
function targeted(t) {
  const directory = mkdtempSync(pathJoin(tmpdir(), "room-rejoin-targeted-"));
  const now = Date.now();
  const store = new RoomStore(pathJoin(directory, "room.sqlite"), { now: () => now });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const session = accountId => { const accessKey = store.issueAccountAccessKey(accountId), slot = store.createAccountSessionSlot(); return { token: slot.token, session: store.loginAccountSession(slot.token, accessKey, slot.session.sessionRevision) }; };
  const owner = session(store.authenticate(store.issueAccessKey("commons", "owner")).account.id);
  store.createAccount("account-friend");
  const friend = session("account-friend");
  const invite = (requestId, memberId, role = "member") => {
    const token = randomBytes(32).toString("base64url");
    store.issueInvitation(owner.token, "commons", { requestId, token, intendedAccountId: "account-friend", intendedMemberId: memberId, displayName: "Target human", role,
      expiresAt: now + 3600000, expectedIssuerMemberRevision: store.room("commons").state.members.owner.revision, expectedSessionBinding: owner.session.sessionBinding });
    return token;
  };
  const accept = token => store.acceptInvitation(friend.token, token, { redemptionId: randomUUID(), expectedRevision: 0, expectedSessionBinding: friend.session.sessionBinding });
  const members = () => store.room("commons").state.members;
  const setActive = (actorKey, memberId, active) => { const m = members()[memberId]; store.command(actorKey, "commons", { id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED, data: { memberId, expectedMemberRevision: m.revision, permissions: [...m.permissions], active } }); };
  return { store, invite, accept, members, setActive };
}

test("targeted invitation: a member who left is invited again, accepts, and the audit stays consistent", t => {
  const { store, invite, accept, members, setActive } = targeted(t);
  accept(invite("first", "friend-1"));
  setActive(store.issueAccessKey("commons", "friend-1"), "friend-1", false);
  const token = invite("second", "friend-2", "guest");
  const back = accept(token);
  assert.equal(back.session.member.id, "friend-2");
  assert.equal(members()["friend-2"].active, true);
  assert.equal(members()["friend-1"].active, false, "the old member keeps its history and stays inactive");
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM member_accounts WHERE room_id='commons' AND account_id='account-friend'").get().n, 1);
  assert.equal(store.verifyInvitationAudit().consistent, true);
  assert.deepEqual([...members()["friend-2"].permissions], [...INVITATION_ROLES.guest], "the new invitation's permissions apply");
});

test("targeted invitation: an owner-removed member stays blocked at issuance and at accept", t => {
  const { store, invite, accept, members, setActive } = targeted(t);
  accept(invite("first", "friend-1"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  setActive(ownerKey, "friend-1", false);
  assert.throws(() => invite("second", "friend-2"), error => error.status === 409 && error.code === "membership_conflict");
  assert.equal(members()["friend-1"].active, false);
});

test("the integrity audit refuses a released binding when the old member was removed by the owner", t => {
  const { store, invite, accept, setActive } = targeted(t);
  accept(invite("first", "friend-1"));
  setActive(store.issueAccessKey("commons", "owner"), "friend-1", false);
  // Forge what a rebound invitee looks like: the old binding released, the account bound to another member.
  store.db.prepare("DELETE FROM member_accounts WHERE room_id='commons' AND member_id='friend-1'").run();
  store.db.prepare("INSERT INTO member_accounts(room_id,member_id,account_id,origin) VALUES('commons','friend-x','account-friend','forged')").run();
  assert.throws(() => store.verifyInvitationAudit(), /operator reconciliation/);
});
