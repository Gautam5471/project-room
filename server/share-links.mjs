import { createHash, randomBytes, randomUUID } from "node:crypto";
import { validId, event, EVENT_TYPES as T, MEMBERSHIP_AUTHORITY_POLICY_VERSION, INVITATION_ROLE_POLICY_VERSION, INVITATION_ROLES, PERMISSIONS, canInviteMembers, historyVisibility } from "../src/events.js";
import { applyEventWithGrowth, growthCollector } from "../src/growth-emit.js";
import { invitationJoinedEvent } from "./invitation-evidence.mjs";
import { canonicalInvitationData } from "./invitation-journal.mjs";
import { ServiceError, PILOT_LIMITS, activeMemberCount } from "./store.mjs";
import { enforceAutonomyTierForAction } from "./autonomy-tiers.mjs";
import { refuseArchivedWrite } from "./room-lifecycle.mjs";
import { classifyJoinToken } from "./guest-agent-links.mjs";
import { normalizeShareInviteCode, parseShareInviteCode } from "../src/share-invite-code.js";
import { assertAdmissibleMemberName } from "./display-name-guard.mjs";
import { PERSONAL_INVITE_PREFIX, PERSONAL_INVITE_TTL_MS, personalInviteToken, rememberReferee } from "./growth-loop.mjs";

// Agent admissions reuse the durable membership event as their receipt. The
// link ID is public metadata; neither the invitation token nor its hash is exposed.
const agentJoinPrefix = row => `sj_${row.id.replaceAll("-", "")}_`;
const hash = value => createHash("sha256").update(value).digest("hex");
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
const unavailable = () => fail(410, "link_unavailable", "This invite link has expired, been cancelled, or reached its join limit. Ask for a new invite link.");
export const shareLinkSchema = `
  CREATE TABLE IF NOT EXISTS share_links (
    id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
    room_id TEXT NOT NULL REFERENCES rooms(id), issuer_account_id TEXT REFERENCES accounts(id),
    issuer_member_id TEXT NOT NULL, issuer_auth_epoch INTEGER CHECK((issuer_account_id IS NULL) = (issuer_auth_epoch IS NULL)), issuer_member_revision INTEGER NOT NULL,
    request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL CHECK(expires_at>created_at), max_joins INTEGER NOT NULL CHECK(max_joins BETWEEN 1 AND 25),
    revoked_at INTEGER, revoked_by_member_id TEXT,
    CHECK((revoked_at IS NULL AND revoked_by_member_id IS NULL) OR (revoked_at IS NOT NULL AND revoked_by_member_id IS NOT NULL)),
    UNIQUE(room_id,issuer_account_id,request_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS share_links_agent_request ON share_links(room_id,issuer_member_id,request_id) WHERE issuer_account_id IS NULL;
  CREATE INDEX IF NOT EXISTS share_links_room ON share_links(room_id,created_at);
  CREATE TABLE IF NOT EXISTS share_link_joins (
    link_id TEXT NOT NULL REFERENCES share_links(id), invitation_id TEXT NOT NULL UNIQUE REFERENCES membership_invitations(id),
    slot_hash TEXT NOT NULL REFERENCES account_session_slots(hash), redemption_id TEXT NOT NULL,
    session_revision INTEGER NOT NULL, fingerprint TEXT NOT NULL,
    PRIMARY KEY(link_id,slot_hash,redemption_id)
  );
  -- Redemption idempotency for joins that write no share_link_joins row: the
  -- membership-reuse path (an existing member re-joining via a link) returns
  -- duplicate:true without an invitation, so the #770 cross-session replay
  -- check has nothing to key on. One row per (link, redemptionId) names the
  -- account that consumed it; a lost-cookie retry from another session is
  -- rejected as join_session_lost instead of minting a second guest.
  CREATE TABLE IF NOT EXISTS share_link_join_redemptions (
    link_id TEXT NOT NULL REFERENCES share_links(id), redemption_id TEXT NOT NULL,
    account_id TEXT NOT NULL REFERENCES accounts(id), created_at INTEGER NOT NULL,
    PRIMARY KEY(link_id,redemption_id)
  );
  CREATE TRIGGER IF NOT EXISTS share_link_scope_immutable BEFORE UPDATE OF id,token_hash,room_id,issuer_account_id,issuer_member_id,issuer_auth_epoch,issuer_member_revision,request_id,fingerprint,created_at,expires_at,max_joins ON share_links BEGIN SELECT RAISE(ABORT,'link scope is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS share_link_revocation_final BEFORE UPDATE ON share_links WHEN OLD.revoked_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'link cancellation is final'); END;
  CREATE TRIGGER IF NOT EXISTS share_links_no_delete BEFORE DELETE ON share_links BEGIN SELECT RAISE(ABORT,'link history is retained'); END;
  CREATE TRIGGER IF NOT EXISTS share_link_joins_no_update BEFORE UPDATE ON share_link_joins BEGIN SELECT RAISE(ABORT,'join history is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS share_link_joins_no_delete BEFORE DELETE ON share_link_joins BEGIN SELECT RAISE(ABORT,'join history is retained'); END;
  CREATE TRIGGER IF NOT EXISTS share_link_join_redemptions_no_update BEFORE UPDATE ON share_link_join_redemptions BEGIN SELECT RAISE(ABORT,'redemption history is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS share_link_join_redemptions_no_delete BEFORE DELETE ON share_link_join_redemptions BEGIN SELECT RAISE(ABORT,'redemption history is retained'); END;
`;

// Retained legacy human invite codes alias existing share_links rows. New
// invitations issue links only. Preserve historical alias redemption. Purely additive
// and unfenced (older writers have no code path here). The plaintext code is
// shown once at mint; only the hash is stored.
export const shareLinkCodeSchema = `
  CREATE TABLE IF NOT EXISTS share_link_codes (
    code_hash TEXT PRIMARY KEY CHECK(length(code_hash)=64),
    link_id TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS share_link_codes_link ON share_link_codes(link_id);
`;

// Link access (John, 2026-10-06). A link without a row here is a guest link,
// exactly as before. "member" grants the member role's work permissions.
// "co_admin" grants every room permission (PERMISSIONS) to whoever joins,
// human or agent. Owner-only settings stay owner-only. It is a room key:
// only the room owner can mint one. The row is written
// with the link and can never change.
export const LINK_ACCESS = Object.freeze(["guest", "member", "co_admin"]);
export const shareLinkAccessSchema = `
  CREATE TABLE IF NOT EXISTS share_link_access (
    link_id TEXT PRIMARY KEY, access TEXT NOT NULL CHECK(access IN ('member','co_admin')), created_at INTEGER NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS share_link_access_immutable BEFORE UPDATE ON share_link_access BEGIN SELECT RAISE(ABORT,'link access is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS share_link_access_no_delete BEFORE DELETE ON share_link_access BEGIN SELECT RAISE(ABORT,'link access is retained'); END;
`;
function roleMatchesLink(record, access) {
  const role = access === "co_admin" ? "moderator" : access === "member" ? "member" : "guest";
  return record?.intended_role === role && record.intended_permissions_json === JSON.stringify(INVITATION_ROLES[role]);
}
export function linkPermissions(access) {
  return access === "co_admin" ? [...PERMISSIONS] : access === "member" ? [...INVITATION_ROLES.member] : [];
}
const ACCESS_TEXT = Object.freeze({
  guest: "Read the room and its history, post messages, and react. No membership administration or work approvals.",
  member: "Read and post, take work, complete it and verify others' work. No membership administration.",
  co_admin: "Every room permission: invite and remove members, change access, decide and approve work. Room settings such as instructions, history visibility, export, publishing, archive and ownership stay with the room creator."
});
// QA8 (2026-10-08, live prod): a link guest in a room on the default
// history policy (PRIV-2: guests see only messages from after they join)
// was told "Read the room and its history", then landed on "No messages
// yet" in a room with history. Say what the guest will actually see.
const GUEST_SINCE_JOIN_TEXT = "Read messages posted after you join, post messages, and react. No membership administration or work approvals.";
export function previewAccessText(access, roomState) {
  const setting = historyVisibility(roomState);
  const sinceJoin = setting.value === "since_join" || (setting.value === null && setting.guestsSinceJoin && access === "guest");
  if (access === "guest" && sinceJoin) return GUEST_SINCE_JOIN_TEXT;
  if (access === "member" && setting.value === "since_join") return "Read messages posted after you join and post, take work, complete it and verify others' work. No membership administration.";
  return ACCESS_TEXT[access];
}

// Reusable links delegate only the existing, immutable guest invitation policy.
// Each redemption creates an ordinary audited account-bound invitation and its
// acceptance in ONE transaction. Existing targeted invitations stay unchanged.
export class ShareLinks {
  constructor(store) { this.store = store; this.db = store.db; }
  accessOf(row) {
    try { return this.db.prepare("SELECT access FROM share_link_access WHERE link_id=?").get(row.id)?.access ?? "guest"; }
    catch (error) { if (/no such table/i.test(error?.message ?? "")) return "guest"; throw error; }
  }
  administrator(token, roomId, binding) {
    const auth = this.store.authenticate(token, roomId, binding);
    // Ownership implies full authority (mirrors validatePermissions in
    // src/events.js): the room owner administers invitation links on any
    // credential, including an agent identity bearer that has no account.
    if (this.store.roomAuthority(roomId).ownerId === auth.member?.id) return auth;
    // #643: an owner-delegated administrator (server-stamped
    // member.delegatedAdmin holding manage_members) administers links too —
    // managing invitation links is membership administration, the operation
    // class the owner delegated. Other owner-capability surfaces stay
    // owner-only.
    if (auth.member?.delegatedAdmin === true && auth.member.permissions.includes("manage_members")) return auth;
    if (!auth.account || auth.member.kind !== "human" || !auth.member.permissions.includes("manage_members")) {
      fail(403, "access_denied", "Only a human room administrator can manage invitation links");
    }
    return auth;
  }
  // Cancelled, expired, and full rows stay (link history is retained) and do
  // not consume the 200 live links a room may hold.
  roomLinkCount(roomId) {
    const now = this.store.now();
    const rows = this.db.prepare("SELECT id, max_joins FROM share_links WHERE room_id=? AND revoked_at IS NULL AND expires_at > ?").all(roomId, now);
    let live = 0;
    for (const row of rows) {
      if (this.count(row) >= row.max_joins) continue;
      live += 1;
      if (live >= 200) return live;
    }
    return live;
  }
  count(row) {
    const humans = this.db.prepare("SELECT count(*) n FROM share_link_joins WHERE link_id=?").get(row.id).n;
    // Use the event-ID index for this link's receipts, not the whole room history.
    const agents = this.db.prepare("SELECT room_id, json_extract(body,'$.type') AS type FROM events WHERE id GLOB ?")
      .all(agentJoinPrefix(row) + "*").filter(receipt => receipt.room_id === row.room_id && receipt.type === T.MEMBER_ADDED).length;
    return humans + agents;
  }
  authority(row) {
    const members = this.store.room(row.room_id).state.members;
    // A truthy map lookup treats toString as the issuer and then throws on permissions.includes.
    const member = members && Object.hasOwn(members, row.issuer_member_id) ? members[row.issuer_member_id] : undefined;
    // A personal growth invite belongs to every active member, not only
    // membership administrators. It stays valid while that member is active
    // at the revision stamped when the link was issued.
    if (typeof row.request_id === "string" && row.request_id.startsWith(PERSONAL_INVITE_PREFIX)) {
      return member?.active !== false && member?.revision === row.issuer_member_revision;
    }
    const ownerId = this.store.roomAuthority(row.room_id).ownerId;
    // Agent-issued links carry no account. An explicit owner-granted admin
    // keeps issuance authority only while its grant and revision remain current.
    if (row.issuer_account_id === null) {
      return (ownerId === row.issuer_member_id || member?.delegatedAdmin === true && member.permissions.includes("manage_members")) && member?.active !== false
        && member?.revision === row.issuer_member_revision;
    }
    // Human-issued links stay authoritative while the issuer owns the room or
    // still holds manage_members; ownership implies full authority even when
    // the grant itself was never recorded on the member.
    const privileged = ownerId === row.issuer_member_id || member?.permissions.includes("manage_members");
    const memberOk = member?.active !== false && member?.revision === row.issuer_member_revision && privileged;
    const account = this.db.prepare("SELECT active,auth_epoch FROM accounts WHERE id=?").get(row.issuer_account_id);
    const binding = this.db.prepare("SELECT account_id FROM member_accounts WHERE room_id=? AND member_id=?").get(row.room_id, row.issuer_member_id);
    return account?.active === 1 && account.auth_epoch === row.issuer_auth_epoch && binding?.account_id === row.issuer_account_id
      && memberOk;
  }
  view(row) {
    const joins = this.count(row);
    const status = row.revoked_at !== null ? "cancelled" : row.expires_at <= this.store.now() ? "expired"
      : !this.authority(row) ? "authority_changed" : joins >= row.max_joins ? "full" : "active";
    const access = this.accessOf(row);
    return { id: row.id, roomId: row.room_id, role: access === "guest" ? "guest" : access, access, permissions: linkPermissions(access), createdAt: row.created_at,
      expiresAt: row.expires_at, maxJoins: row.max_joins, joins, remainingJoins: Math.max(0, row.max_joins - joins), status };
  }
  find(token) {
    if (classifyJoinToken(token) === "guest-agent") fail(422, "wrong_link_kind", "Guest invites are not human invite links.");
    const code = parseShareInviteCode(token);
    if (code) {
      const alias = this.db.prepare("SELECT link_id FROM share_link_codes WHERE code_hash=?").get(hash(normalizeShareInviteCode(code)));
      const row = alias && this.db.prepare("SELECT * FROM share_links WHERE id=?").get(alias.link_id);
      if (!row) unavailable();
      return row;
    }
    if (typeof token !== "string" || !tokenPattern.test(token)) unavailable();
    const row = this.db.prepare("SELECT * FROM share_links WHERE token_hash=?").get(hash(token));
    if (!row) unavailable();
    return row;
  }
  preview(token, accountToken = null, binding = null) {
    return this.store.readTransaction(() => {
      const row = this.find(token), link = this.view(row);
      if (link.status !== "active") {
        if (!accountToken || !binding) unavailable();
        try { this.store.authenticateAccountSession(accountToken, row.room_id, binding); }
        catch (error) { if ([401, 403, 409].includes(error.status)) unavailable(); throw error; }
      }
      const members = this.store.room(row.room_id).state.members;
      const issuer = members && Object.hasOwn(members, row.issuer_member_id) ? members[row.issuer_member_id] : null;
      const inviterDisplayName = typeof issuer?.displayName === "string" && issuer.displayName.trim() ? issuer.displayName.trim() : "A member";
      const roomState = this.store.room(row.room_id).state;
      return { link, room: { id: row.room_id, title: roomState.room.title },
        access: previewAccessText(link.access, roomState),
        identity: "Names are self-chosen, not verified. New guest sessions last up to 8 hours in this browser.",
        inviterDisplayName };
    });
  }
  joinAgent(identitySecret, linkToken, displayName, trace = {}) {
    if (typeof displayName !== "string" || !displayName.trim() || displayName.length > 80)
      fail(422, "invalid_join", "Choose an agent name of 1–80 characters");
    return this.store.transaction(() => {
      const identity = this.store.identities.resolveGlobalIdentitySecret(identitySecret);
      if (!identity) fail(401, "unauthenticated", "Active agent identity required");
      const row = this.find(linkToken), room = this.store.room(row.room_id);
      const linked = this.db.prepare("SELECT member_id FROM identity_links WHERE room_id=? AND identity_id=?").get(row.room_id, identity.identityId);
      const member = linked && room.state.members[linked.member_id];
      // Recovery never consumes another place or restores removed membership.
      if (linked || room.state.members[identity.identityId]) {
        if (!member?.active) fail(403, "access_ended", "Membership is no longer active");
        return { roomId: row.room_id, identityId: identity.identityId, memberId: member.id, permissions: member.permissions, duplicate: true };
      }
      if (this.view(row).status !== "active") unavailable();
      refuseArchivedWrite(room.state);
      const plugin = this.store.agentPlugin;
      if (plugin?.roomVerificationPolicy(row.room_id).requireVerified && plugin.verificationLevel(identity.identityId) !== "verified")
        fail(403, "unverified_identity", "This room only admits verified agents");
      if (room.sequence >= PILOT_LIMITS.eventsPerRoom || activeMemberCount(room.state.members) >= PILOT_LIMITS.membersPerRoom) fail(409, "pilot_limit", "This room is full");
      assertAdmissibleMemberName(displayName.trim(), room.state.members); // Q3-D: roster check plus role names
      const id = agentJoinPrefix(row) + hash(identity.identityId).slice(0, 28), now = this.store.now();
      // A personal invite whose issuer cannot invite members is dead: the
      // journal records the true issuer as actor (never the owner as a
      // stand-in), so the reducer's canInviteMembers check applies honestly.
      // Links minted before the mint-time gate fail closed here.
      const growth = typeof row.request_id === "string" && row.request_id.startsWith(PERSONAL_INVITE_PREFIX);
      if (growth && !canInviteMembers(room.state, row.issuer_member_id)) {
        fail(403, "invite_not_authorized", "This invite was issued by a member who cannot invite new members");
      }
      const actorId = row.issuer_member_id;
      const incoming = event({ id, idempotencyKey: id, roomId: row.room_id, actorId,
        type: T.MEMBER_ADDED, at: new Date(now).toISOString(), data: { memberId: identity.identityId,
          identityId: identity.identityId, displayName: displayName.trim(), kind: "agent", permissions: linkPermissions(this.accessOf(row)),
          // A guest link admits the agent as a link guest: it reads from its join
          // under the room's default history setting, like a human link guest.
          ...(this.accessOf(row) === "guest" ? { historyGuest: true } : {}),
          authorityPolicyVersion: MEMBERSHIP_AUTHORITY_POLICY_VERSION } });
      const state = { ...applyEventWithGrowth(room.state, incoming, growthCollector).state, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} };
      const projection = this.store.storedProjection(row.room_id, state), sequence = room.sequence + 1;
      if (Buffer.byteLength(projection) > PILOT_LIMITS.projectionBytes) fail(409, "pilot_limit", "Room storage limit reached; no data was changed. Ask the room owner to raise the room's limit, or try again later.");
      this.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(row.room_id, sequence, id, JSON.stringify(incoming));
      this.db.prepare("UPDATE rooms SET sequence=?,projection=? WHERE id=?").run(sequence, projection, row.room_id);
      this.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)")
        .run(row.room_id, identity.identityId, identity.identityId, now);
      this.creditReferral(row, identity.identityId, now, trace);
      return { roomId: row.room_id, identityId: identity.identityId, memberId: identity.identityId, permissions: linkPermissions(this.accessOf(row)), duplicate: false };
    });
  }
  list(token, roomId, binding) {
    return this.store.readTransaction(() => {
      this.administrator(token, roomId, binding);
      return { links: this.db.prepare("SELECT * FROM share_links WHERE room_id=? ORDER BY created_at DESC,id DESC").all(roomId).map(row => this.view(row)) };
    });
  }
  create(token, roomId, details, binding, { emailVerificationUnachievable = false } = {}) {
    const { requestId, linkToken, expiresAt, maxJoins, expectedMemberRevision, access = "guest" } = details;
    if (!LINK_ACCESS.includes(access)) fail(422, "invalid_link_access", "Choose guest, member or co_admin access");
    if (!validId(requestId) || typeof linkToken !== "string" || !tokenPattern.test(linkToken)
      || !Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(maxJoins) || maxJoins < 1 || maxJoins > 25
      || !Number.isSafeInteger(expectedMemberRevision) || expectedMemberRevision < 0) {
      fail(422, "invalid_link", "Choose a join limit between 1 and 25 and a current room membership");
    }
    return this.store.transaction(() => {
      const auth = this.administrator(token, roomId, binding), tokenHash = hash(linkToken);
      // Invitation issuance carries the f520ca69 email-verification gate:
      // sibling issuance paths (agent-invites.create, membership invitation
      // issue) refuse unverified accounts, and share links are invitations
      // too. Accountless issuers (owner on an identity bearer, delegated
      // admin agents) have no account to verify and are unaffected.
      // Skipped only when the deployment cannot deliver a verification code
      // (no mailer): the gate would otherwise deadlock link creation forever,
      // as agent-invites.create already avoids. The HTTP layer derives the
      // flag from the mailer, never from the request.
      if (auth.account && !emailVerificationUnachievable) this.store.accountLogins.assertEmailVerified(auth.account.id);
      // Creating share links is a membership write: the read-only autonomy
      // tier applies even for delegated-admin agents (issue #996).
      enforceAutonomyTierForAction({ db: this.store.db, roomId, state: this.store.room(roomId).state, actor: auth.member, action: "share_link_create", fail });
      if (access !== "guest" && this.store.roomAuthority(roomId).ownerId !== auth.member.id) {
        fail(403, "link_access_denied", "Only the room creator can make member or co-admin links");
      }
      const fingerprint = hash(JSON.stringify(access === "guest" ? [tokenHash, expiresAt, maxJoins, expectedMemberRevision]
        : [tokenHash, expiresAt, maxJoins, expectedMemberRevision, access]));
      // Agent issuers have no account: idempotency keys on the member instead.
      // (SQLite UNIQUE treats NULLs as distinct, so the partial unique index
      // share_links_agent_request backs this lookup at the storage layer.)
      const prior = auth.account
        ? this.db.prepare("SELECT * FROM share_links WHERE room_id=? AND issuer_account_id=? AND request_id=?").get(roomId, auth.account.id, requestId)
        : this.db.prepare("SELECT * FROM share_links WHERE room_id=? AND issuer_account_id IS NULL AND issuer_member_id=? AND request_id=?").get(roomId, auth.member.id, requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) fail(409, "idempotency_conflict", "This request was already used for different link settings");
        return { link: this.view(prior), duplicate: true };
      }
      const now = this.store.now();
      if (expiresAt <= now || expiresAt > now + 7 * 86400000) fail(422, "invalid_expiry", "Choose an expiry within seven days");
      if (expectedMemberRevision !== auth.member.revision) fail(409, "stale_member_revision", "Your room permissions changed; refresh before creating a link");
      if (this.roomLinkCount(roomId) >= 200) fail(409, "pilot_limit", "Room link retention limit reached");
      for (const table of ["credentials", "account_credentials", "account_session_slots"]) {
        if (this.db.prepare(`SELECT 1 FROM ${table} WHERE hash=?`).get(tokenHash)) fail(409, "token_conflict", "Generate a new link");
      }
      for (const table of ["membership_invitations", "share_links"]) {
        if (this.db.prepare(`SELECT 1 FROM ${table} WHERE token_hash=?`).get(tokenHash)) fail(409, "token_conflict", "Generate a new link");
      }
      const id = randomUUID();
      this.db.prepare(`INSERT INTO share_links(id,token_hash,room_id,issuer_account_id,issuer_member_id,issuer_auth_epoch,issuer_member_revision,request_id,fingerprint,created_at,expires_at,max_joins)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, tokenHash, roomId, auth.account?.id ?? null, auth.member.id, auth.account?.authEpoch ?? null, auth.member.revision, requestId, fingerprint, now, expiresAt, maxJoins);
      if (access !== "guest") this.db.prepare("INSERT INTO share_link_access(link_id,access,created_at) VALUES(?,?,?)").run(id, access, now);
      return { link: this.view(this.db.prepare("SELECT * FROM share_links WHERE id=?").get(id)), duplicate: false };
    });
  }
  // One attributed invite per member. The plaintext token is an HMAC of the
  // room seed, so it can be shown again without storing it. Joins still credit
  // the issuer through creditReferral. A read-only agent gets no link; the
  // board itself still loads.
  personalInvite(auth, roomId, maxJoins) {
    const cap = Math.min(25, Math.max(1, Math.floor(maxJoins)));
    try {
      enforceAutonomyTierForAction({ db: this.store.db, roomId, state: this.store.room(roomId).state, actor: auth.member, action: "share_link_create", fail });
    } catch (error) {
      if (error.code === "agent_readonly") return null;
      throw error;
    }
    // Minting admits a new member: same gate as referral-invite mint
    // (referral-invites.mjs) — the owner, or a member with invite_member or
    // manage_members. Guests and other members without invite rights get no
    // link; the board itself still loads.
    if (!canInviteMembers(this.store.room(roomId).state, auth.member.id)) return null;
    // Same f520ca69 email gate as create(): an unverified account gets no
    // personal link (the board still loads, as for a member without invite
    // rights). Without this the Invite dialog handed out a working guest
    // link while "Create invite link" answered 403 email_unverified.
    if (auth.account && this.store.accountLogins.emailGateBlocks(auth.account.id)) return null;
    const memberId = auth.member.id;
    const rows = auth.account
      ? this.db.prepare("SELECT * FROM share_links WHERE room_id=? AND issuer_account_id=? AND issuer_member_id=? AND request_id LIKE ? ORDER BY created_at DESC, id DESC")
        .all(roomId, auth.account.id, memberId, `${PERSONAL_INVITE_PREFIX}%`)
      : this.db.prepare("SELECT * FROM share_links WHERE room_id=? AND issuer_account_id IS NULL AND issuer_member_id=? AND request_id LIKE ? ORDER BY created_at DESC, id DESC")
        .all(roomId, memberId, `${PERSONAL_INVITE_PREFIX}%`);
    const generationOf = row => {
      const n = Number(String(row.request_id).slice(PERSONAL_INVITE_PREFIX.length));
      return Number.isSafeInteger(n) && n >= 0 ? n : null;
    };
    const present = row => {
      const generation = generationOf(row);
      if (generation === null) return null;
      const invite = personalInviteToken(this.store.referralInvites.roomKeys(roomId).privateSeed, roomId, memberId, generation);
      if (hash(invite) !== row.token_hash) return null;
      return { token: invite, link: this.view(row) };
    };
    const latest = rows[0];
    const usable = row => {
      if (!row || row.max_joins !== cap || row.issuer_member_revision !== auth.member.revision) return false;
      return this.view(row).status === "active";
    };
    if (usable(latest)) {
      const current = present(latest);
      if (current) return current;
    }
    if (this.roomLinkCount(roomId) >= 200) {
      return latest ? present(latest) : null;
    }
    const generation = latest ? (generationOf(latest) ?? 0) + 1 : 0;
    if (!Number.isSafeInteger(generation)) return latest ? present(latest) : null;
    const invite = personalInviteToken(this.store.referralInvites.roomKeys(roomId).privateSeed, roomId, memberId, generation);
    const tokenHash = hash(invite);
    const requestId = `${PERSONAL_INVITE_PREFIX}${generation}`;
    const now = this.store.now();
    const expiresAt = now + PERSONAL_INVITE_TTL_MS;
    const fingerprint = hash(JSON.stringify([tokenHash, expiresAt, cap, auth.member.revision]));
    for (const table of ["credentials", "account_credentials", "account_session_slots", "membership_invitations", "share_links"]) {
      if (this.db.prepare(`SELECT 1 FROM ${table} WHERE ${table === "credentials" || table === "account_credentials" || table === "account_session_slots" ? "hash" : "token_hash"}=?`).get(tokenHash)) {
        return latest ? present(latest) : null;
      }
    }
    const id = randomUUID();
    try {
      this.db.prepare(`INSERT INTO share_links(id,token_hash,room_id,issuer_account_id,issuer_member_id,issuer_auth_epoch,issuer_member_revision,request_id,fingerprint,created_at,expires_at,max_joins)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, tokenHash, roomId, auth.account?.id ?? null, memberId, auth.account?.authEpoch ?? null, auth.member.revision, requestId, fingerprint, now, expiresAt, cap);
    } catch (error) {
      if (!/UNIQUE|constraint/i.test(String(error?.message))) throw error;
      const prior = auth.account
        ? this.db.prepare("SELECT * FROM share_links WHERE room_id=? AND issuer_account_id=? AND request_id=?").get(roomId, auth.account.id, requestId)
        : this.db.prepare("SELECT * FROM share_links WHERE room_id=? AND issuer_account_id IS NULL AND issuer_member_id=? AND request_id=?").get(roomId, memberId, requestId);
      return prior ? present(prior) : (latest ? present(latest) : null);
    }
    return { token: invite, link: this.view(this.db.prepare("SELECT * FROM share_links WHERE id=?").get(id)) };
  }
  cancel(token, roomId, id, binding) {
    if (!validId(id)) unavailable();
    return this.store.transaction(() => {
      const auth = this.administrator(token, roomId, binding);
      const row = this.db.prepare("SELECT * FROM share_links WHERE id=? AND room_id=?").get(id, roomId);
      if (!row) unavailable();
      if (row.revoked_at === null) this.db.prepare("UPDATE share_links SET revoked_at=?,revoked_by_member_id=? WHERE id=? AND revoked_at IS NULL").run(this.store.now(), auth.member.id, id);
      return { link: this.view(this.db.prepare("SELECT * FROM share_links WHERE id=?").get(id)) };
    });
  }
  join(slotToken, linkToken, { displayName, redemptionId, expectedSessionRevision, expectedSessionBinding, revokeRoomToken = null, clientAddress = null, clientSession = null }) {
    if (typeof displayName !== "string" || !displayName.trim() || displayName.length > 80
      || typeof redemptionId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(redemptionId)
      || !Number.isSafeInteger(expectedSessionRevision)) fail(422, "invalid_join", "Enter a name of 1–80 characters and try joining again");
    return this.store.transaction(() => {
      const slot = this.store.accountSessionSlot(slotToken);
      if (slot.sessionRevision !== expectedSessionRevision || slot.sessionBinding !== expectedSessionBinding) fail(409, "session_binding_changed", "Your browser identity changed. Review the invitation again.");
      const row = this.find(linkToken), fingerprint = hash(displayName.trim());
      let auth = null;
      try { auth = this.store.authenticateAccountSession(slotToken); }
      catch (error) { if (error.status !== 401) throw error; }
      const prior = this.db.prepare("SELECT j.*,i.intended_account_id FROM share_link_joins j JOIN membership_invitations i ON i.id=j.invitation_id WHERE j.link_id=? AND j.slot_hash=? AND j.redemption_id=?")
        .get(row.id, slot.credentialHash, redemptionId);
      if (prior) {
        if (prior.fingerprint !== fingerprint || prior.session_revision !== slot.sessionRevision || prior.intended_account_id !== auth?.account.id) fail(409, "join_changed", "This join belongs to an earlier browser identity or name");
        this.verifyJoin(prior);
        return this.result(slotToken, row.room_id, true);
      }
      // A retried operation must not become a fresh guest just because its
      // browser cookie disappeared. The request ID is an idempotency key, not
      // a credential: never hand another session the original guest's access.
      // The membership-reuse path below writes no share_link_joins row, so a
      // lost-cookie retry of it is invisible to the otherSession check; the
      // redemption record closes that gap — one (link, redemptionId) admits
      // one account, however the first join was recorded.
      const redemption = this.db.prepare("SELECT account_id FROM share_link_join_redemptions WHERE link_id=? AND redemption_id=?").get(row.id, redemptionId);
      if (redemption && redemption.account_id !== auth?.account.id) {
        fail(409, "join_session_lost", "Your earlier join used another browser session. Return to that session or sign in with the same account. No additional guest was created. Agents should reuse their saved agent identity.");
      }
      const otherSession = this.db.prepare("SELECT i.intended_account_id FROM share_link_joins j JOIN membership_invitations i ON i.id=j.invitation_id WHERE j.link_id=? AND j.redemption_id=? AND j.slot_hash<>?")
        .get(row.id, redemptionId, slot.credentialHash);
      if (otherSession && otherSession.intended_account_id !== auth?.account.id) {
        fail(409, "join_session_lost", "Your earlier join used another browser session. Return to that session or sign in with the same account. No additional guest was created. Agents should reuse their saved agent identity.");
      }
      if (auth && this.db.prepare("SELECT 1 FROM member_accounts WHERE room_id=? AND account_id=?").get(row.room_id, auth.account.id)) {
        // Record the redemption: this path returns duplicate:true without an
        // invitation or share_link_joins row, so without this record a
        // lost-cookie retry of the same redemptionId would mint a second
        // guest. INSERT OR IGNORE keeps concurrent reuses of one
        // redemptionId from 500ing on the primary key; the loser re-reads
        // and either reuses (same account) or is rejected (another account).
        const recorded = this.db.prepare("INSERT OR IGNORE INTO share_link_join_redemptions(link_id,redemption_id,account_id,created_at) VALUES(?,?,?,?)")
          .run(row.id, redemptionId, auth.account.id, this.store.now()).changes;
        if (!recorded) {
          const owner = this.db.prepare("SELECT account_id FROM share_link_join_redemptions WHERE link_id=? AND redemption_id=?").get(row.id, redemptionId);
          if (owner?.account_id !== auth.account.id) {
            fail(409, "join_session_lost", "Your earlier join used another browser session. Return to that session or sign in with the same account. No additional guest was created. Agents should reuse their saved agent identity.");
          }
        }
        const bound = this.db.prepare("SELECT member_id FROM member_accounts WHERE room_id=? AND account_id=?").get(row.room_id, auth.account.id);
        if (this.store.room(row.room_id).state.members[bound.member_id]?.active === false) this.reactivateSelfLeft(row, bound.member_id, auth, redemptionId);
        return this.result(slotToken, row.room_id, true); // Existing membership survives a full or expired invitation; removed members still fail authentication.
      }
      if (this.view(row).status !== "active") unavailable();
      if (!auth && revokeRoomToken) {
        let existingRoom = null;
        try { existingRoom = this.store.authenticate(revokeRoomToken, row.room_id, null, { allowAccountSession: false }); }
        catch (error) { if (![401, 403].includes(error.status)) throw error; }
        if (existingRoom?.kind === "session" && existingRoom.member.kind === "human") {
          return { roomId: row.room_id, duplicate: true, roomMode: true, session: this.store.sessionOwnership(existingRoom) };
        }
      }
      const room = this.store.room(row.room_id), now = this.store.now();
      assertAdmissibleMemberName(displayName.trim(), room.state.members); // Q3-D: roster check plus role names
      if (room.sequence >= PILOT_LIMITS.eventsPerRoom || activeMemberCount(room.state.members) >= PILOT_LIMITS.membersPerRoom) fail(409, "pilot_limit", "This room is full; ask its owner for help");
      const access = this.accessOf(row);
      const role = access === "co_admin" ? "moderator" : access === "member" ? "member" : "guest";
      // An elevated link is not handed to an 8-hour throwaway guest account.
      if (!auth && access !== "guest") fail(401, "sign_in_required", "Sign in or create an account, then open this link again.");
      if (!auth) {
        // An expired/revoked prior identity needs an explicit sign-out before a
        // fresh guest can be created. A link is never recovery for another account.
        if (this.db.prepare("SELECT account_id FROM account_session_slots WHERE hash=?").get(slot.credentialHash).account_id !== null) {
          fail(409, "guest_session_ended", "Your previous browser identity expired. Sign out before joining as a new guest.");
        }
        const account = this.store.createAccount(`guest-${randomUUID()}`, "share-link-guest");
        const accessKey = this.store.insertAccountCredential(account.id, now + 8 * 3600000);
        auth = this.store.loginAccountSession(slotToken, accessKey, expectedSessionRevision, { revokeRoomToken });
      }
      const invitationId = randomUUID(), memberId = `${access === "guest" ? "guest" : "member"}-${randomUUID()}`;
      const privateTokenHash = hash(randomBytes(32).toString("base64url"));
      const admission = this.admissionIssuer(row, room);
      const issueFingerprint = hash(canonicalInvitationData({ roomId: row.room_id, requestId: `link-${invitationId}`, tokenHash: privateTokenHash,
        intendedAccountId: auth.account.id, intendedMemberId: memberId, displayName: displayName.trim(), role, permissions: [...INVITATION_ROLES[role]],
        expiresAt: row.expires_at, expectedIssuerMemberRevision: admission.revision }));
      // Scope is copied from the link, never supplied by the joining browser.
      // A personal invite from a member who cannot invite members is refused
      // above; creditReferral still names the link issuer.
      this.db.prepare(`INSERT INTO membership_invitations(id,token_hash,room_id,intended_account_id,intended_member_id,intended_display_name,intended_role,intended_permissions_json,role_policy_version,
        issuer_account_id,issuer_member_id,issuer_account_auth_epoch,issuer_member_revision,issue_request_id,issue_fingerprint,revision,status,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,'pending',?,?)`).run(invitationId, privateTokenHash, row.room_id, auth.account.id, memberId, displayName.trim(), role, JSON.stringify(INVITATION_ROLES[role]), INVITATION_ROLE_POLICY_VERSION,
          admission.accountId, admission.memberId, admission.authEpoch, admission.revision, `link-${invitationId}`, issueFingerprint, now, row.expires_at);
      // Revision zero is the legacy audit envelope's neutral value for this
      // delegated issuance, NOT evidence of an interactive issuer account login.
      // The private share_link_joins record identifies the actual authority source.
      this.db.prepare(`INSERT INTO membership_invitation_events(invitation_id,sequence,type,actor_account_id,actor_member_id,actor_auth_epoch,actor_session_revision,invitation_revision,at,room_event_id,reason)
        VALUES(?,1,'issued',?,?,?,0,0,?,NULL,NULL)`).run(invitationId, admission.accountId, admission.memberId, admission.authEpoch, now);
      let record = this.db.prepare("SELECT * FROM membership_invitations WHERE id=?").get(invitationId);
      this.store.appendInvitationJournal(record, "issued");
      const incoming = invitationJoinedEvent({ ...record, joined_event_id: randomUUID(), accepted_at: now, redemption_id: redemptionId });
      refuseArchivedWrite(room.state);
      let state = { ...applyEventWithGrowth(room.state, incoming, growthCollector).state, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} };
      // Co-admin: the room creator, who minted the link, raises the new
      // member from moderator to every permission in the same transaction.
      const grant = access === "co_admin" ? event({ id: `la_${invitationId.replaceAll("-", "")}`, idempotencyKey: `link-access:${invitationId}`,
        roomId: row.room_id, actorId: row.issuer_member_id, type: T.MEMBER_ACCESS_CHANGED, at: new Date(now).toISOString(),
        data: { memberId, expectedMemberRevision: state.members[memberId].revision, permissions: linkPermissions("co_admin"), active: true,
          authorityPolicyVersion: MEMBERSHIP_AUTHORITY_POLICY_VERSION } }) : null;
      if (grant) state = { ...applyEventWithGrowth(state, grant, growthCollector).state, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} };
      const projection = this.store.storedProjection(row.room_id, state), sequence = room.sequence + (grant ? 2 : 1);
      if (Buffer.byteLength(projection) > PILOT_LIMITS.projectionBytes) fail(409, "pilot_limit", "This room has reached its storage limit; no data was changed. Ask the room owner to raise the room's limit, or try again later.");
      this.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(row.room_id, room.sequence + 1, incoming.id, JSON.stringify(incoming));
      if (grant) this.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(row.room_id, sequence, grant.id, JSON.stringify(grant));
      this.db.prepare("UPDATE rooms SET sequence=?,projection=? WHERE id=?").run(sequence, projection, row.room_id);
      this.db.prepare("INSERT INTO member_accounts(room_id,member_id,account_id,origin) VALUES(?,?,?,?)").run(row.room_id, memberId, auth.account.id, `invitation:${invitationId}`);
      this.store.markAccountHadRoom(auth.account.id);
      this.db.prepare("UPDATE membership_invitations SET revision=1,status='accepted',accepted_at=?,accepted_by_account_id=?,redemption_id=?,joined_event_id=? WHERE id=?").run(now, auth.account.id, redemptionId, incoming.id, invitationId);
      this.db.prepare(`INSERT INTO membership_invitation_events(invitation_id,sequence,type,actor_account_id,actor_member_id,actor_auth_epoch,actor_session_revision,invitation_revision,at,room_event_id,reason)
        VALUES(?,2,'accepted',?,?,?,?,1,?,?,NULL)`).run(invitationId, auth.account.id, memberId, auth.account.authEpoch, auth.sessionRevision, now, incoming.id);
      record = this.db.prepare("SELECT * FROM membership_invitations WHERE id=?").get(invitationId);
      this.store.appendInvitationJournal(record, "accepted");
      this.db.prepare("INSERT INTO share_link_joins VALUES(?,?,?,?,?,?)").run(row.id, invitationId, slot.credentialHash, redemptionId, auth.sessionRevision, fingerprint);
      this.verifyJoin({ link_id: row.id, invitation_id: invitationId, fingerprint });
      this.creditReferral(row, memberId, now, { address: clientAddress, session: clientSession ?? slotToken });
      return this.result(slotToken, row.room_id, false);
    });
  }
  // A member who left on their own (Leave room) comes back with a fresh valid
  // invitation, which grants the permissions THAT invitation carries. One
  // transaction, no second member_accounts row. A member the owner removed
  // stays out: the link is not a way around a removal.
  reactivateSelfLeft(row, memberId, auth, redemptionId) {
    const room = this.store.room(row.room_id), member = room.state.members[memberId];
    const last = this.db.prepare("SELECT body FROM events WHERE room_id=? AND json_extract(body,'$.type')=? AND json_extract(body,'$.data.memberId')=? ORDER BY sequence DESC LIMIT 1")
      .get(row.room_id, T.MEMBER_ACCESS_CHANGED, memberId);
    const lastEvent = last ? JSON.parse(last.body) : null;
    if (!lastEvent || lastEvent.data?.active !== false || lastEvent.actorId !== memberId) {
      fail(403, "membership_removed", "Your access to this room was ended by its owner. Ask the owner to restore it; an invitation link can't bring you back.");
    }
    if (this.view(row).status !== "active") unavailable();
    refuseArchivedWrite(room.state);
    if (room.sequence >= PILOT_LIMITS.eventsPerRoom || activeMemberCount(room.state.members) >= PILOT_LIMITS.membersPerRoom) fail(409, "pilot_limit", "This room is full; ask its owner for help");
    const access = this.accessOf(row), role = access === "co_admin" ? "moderator" : access === "member" ? "member" : "guest";
    const admission = this.admissionIssuer(row, room), now = this.store.now();
    const rejoin = event({ id: randomUUID(), idempotencyKey: `link-rejoin:${row.id}:${redemptionId}`, roomId: row.room_id, actorId: admission.memberId, type: T.MEMBER_ACCESS_CHANGED, at: new Date(now).toISOString(),
      data: { memberId, expectedMemberRevision: member.revision, permissions: access === "co_admin" ? linkPermissions("co_admin") : [...INVITATION_ROLES[role]], active: true, authorityPolicyVersion: MEMBERSHIP_AUTHORITY_POLICY_VERSION } });
    const state = { ...applyEventWithGrowth(room.state, rejoin, growthCollector).state, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} };
    const projection = this.store.storedProjection(row.room_id, state), sequence = room.sequence + 1;
    if (Buffer.byteLength(projection) > PILOT_LIMITS.projectionBytes) fail(409, "pilot_limit", "This room has reached its storage limit; no data was changed. Ask the room owner to raise the room's limit, or try again later.");
    this.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(row.room_id, sequence, rejoin.id, JSON.stringify(rejoin));
    this.db.prepare("UPDATE rooms SET sequence=?,projection=? WHERE id=?").run(sequence, projection, row.room_id);
  }
  // A share link is an invite link: a first join credits the link's issuer on
  // the room's referral board (via "invite"), in the join's transaction, the
  // same way agent-invite redemption does. Retries return the duplicate path
  // before reaching here, and the referrals primary key keeps it exactly-once.
  creditReferral(row, refereeMemberId, at, trace = {}) {
    const issuer = this.store.room(row.room_id).state.members?.[row.issuer_member_id];
    if (!this.store.referrals || !issuer || issuer.active === false || row.issuer_member_id === refereeMemberId) return;
    this.store.referrals.record({ roomId: row.room_id, referrerMemberId: row.issuer_member_id, refereeMemberId, via: "invite", at });
    rememberReferee(this.store, row.room_id, refereeMemberId, trace);
  }
  result(slotToken, roomId, duplicate) {
    const auth = this.store.authenticateAccountSession(slotToken, roomId);
    return { roomId, duplicate, session: this.store.sessionOwnership(auth) };
  }
  // Human joins require invite rights on the invitation issuer. A personal
  // growth link from an issuer without manage_members keeps the member as the
  // share-link issuer (and the referrer) and records the room owner as the
  // admission authority (the sponsored flow); an issuer with no invite rights
  // at all is refused above.
  admissionIssuer(row, room) {
    const growth = typeof row.request_id === "string" && row.request_id.startsWith(PERSONAL_INVITE_PREFIX);
    // A personal invite whose issuer cannot invite members is dead: fail
    // closed instead of laundering the admission through the owner. The
    // sponsored flow below stays for issuers who can invite.
    if (growth && !canInviteMembers(room.state, row.issuer_member_id)) {
      fail(403, "invite_not_authorized", "This invite was issued by a member who cannot invite new members");
    }
    const ownerId = this.store.roomAuthority(row.room_id).ownerId;
    const issuer = room.state.members?.[row.issuer_member_id];
    const canAdmit = row.issuer_member_id === ownerId || issuer?.permissions?.includes("manage_members") === true;
    if (!growth || canAdmit) {
      return { accountId: row.issuer_account_id, memberId: row.issuer_member_id, authEpoch: row.issuer_auth_epoch, revision: row.issuer_member_revision };
    }
    const owner = room.state.members?.[ownerId];
    const binding = this.db.prepare("SELECT account_id FROM member_accounts WHERE room_id=? AND member_id=?").get(row.room_id, ownerId);
    const account = binding ? this.db.prepare("SELECT auth_epoch FROM accounts WHERE id=? AND active=1").get(binding.account_id) : null;
    return {
      accountId: account ? binding.account_id : null,
      memberId: ownerId,
      authEpoch: account ? account.auth_epoch : null,
      revision: owner?.revision ?? 0,
    };
  }
  verifyJoin(join) {
    const link = this.db.prepare("SELECT * FROM share_links WHERE id=?").get(join.link_id);
    const { record } = this.store.verifyInvitationRecord(join.invitation_id);
    const growth = typeof link?.request_id === "string" && link.request_id.startsWith(PERSONAL_INVITE_PREFIX);
    const sponsored = growth && record?.issuer_member_id !== link.issuer_member_id;
    const issuerMatch = sponsored || (
      record?.issuer_account_id === link?.issuer_account_id
      && record?.issuer_member_id === link?.issuer_member_id
      && record?.issuer_account_auth_epoch === link?.issuer_auth_epoch
      && record?.issuer_member_revision === link?.issuer_member_revision
    );
    if (!link || !issuerMatch || record.status !== "accepted" || record.room_id !== link.room_id
      || !roleMatchesLink(record, this.accessOf(link))
      || record.expires_at !== link.expires_at || record.accepted_at < link.created_at || record.accepted_at >= link.expires_at
      || (link.revoked_at !== null && record.accepted_at > link.revoked_at) || join.fingerprint !== hash(record.intended_display_name)) {
      fail(503, "link_integrity_error", "Invitation link history requires operator reconciliation");
    }
  }
  verify() {
    for (const row of this.db.prepare("SELECT * FROM share_links").all()) {
      if (this.count(row) > row.max_joins) fail(503, "link_integrity_error", "Invitation link usage requires operator reconciliation");
    }
    for (const join of this.db.prepare("SELECT * FROM share_link_joins").all()) this.verifyJoin(join);
    for (const redemption of this.db.prepare("SELECT * FROM share_link_join_redemptions").all()) {
      if (!this.db.prepare("SELECT 1 FROM share_links WHERE id=?").get(redemption.link_id)
        || !this.db.prepare("SELECT 1 FROM accounts WHERE id=?").get(redemption.account_id)) {
        fail(503, "link_integrity_error", "Invitation link usage requires operator reconciliation");
      }
    }
  }
}
