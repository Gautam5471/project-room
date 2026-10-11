// One-time agent invite codes: the self-serve half of the plug-in loop.
//
// An owner mints a short single-use code bound to a room with an explicit
// agent permission scope and an expiry. Any agent redeems the code without
// an owner round-trip: redemption mints a fresh agent identity, links it
// into the room as an agent member with exactly the code's permissions, and
// burns the code. Redeeming never creates an account session and can never
// grant manage_members/decide — rejected at issuance, and re-checked by the
// member.added event validator for kind:"agent".
//
// The code itself is the bearer credential, so only a hash of it is stored:
// a deterministic scrypt (so lookup by hash still works, and no deployment
// secret is needed) that costs orders of magnitude more per guess than a
// bare sha256. Codes minted before the v2 format (8 symbols, sha256 stored)
// keep redeeming until they expire. Audit is the table: created_by/at,
// expires_at, redeemed_at/by, revoked_at, all queryable through list().

import { createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { ServiceError, PILOT_LIMITS, activeMemberCount } from "./store.mjs";
import { enforceAutonomyTierForAction } from "./autonomy-tiers.mjs";
import { refuseArchivedWrite } from "./room-lifecycle.mjs";
import { event, EVENT_TYPES as T, memberCan, canInviteMembers, MEMBERSHIP_AUTHORITY_POLICY_VERSION, PERMISSIONS, AGENT_INVITE_SAFE_PERMISSIONS, validId } from "../src/events.js";
import { nextActionsForInviteRedeem } from "./discoverability.mjs";
import { applyEventWithGrowth, growthCollector } from "../src/growth-emit.js";
import { agentAccessProfiles } from "./agent-connections.mjs";
import { assertAdmissibleMemberName } from "./display-name-guard.mjs";
import { connectFields, starterFor } from "./routes/agent-connect.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
const hash = text => createHash("sha256").update(text).digest("hex");
// Mirrors the projection compaction in store.mjs: strip replay-only caches.
const compactState = state => ({ ...state, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} });

const CODE_PREFIX = "RM-";
// v2 codes: 16 symbols from a 32-symbol alphabet = 80 bits of entropy.
// Crockford base32 (no I/L/O/U); redeem() folds the confusable I/L -> 1 and
// O -> 0 so a transcribed code still works.
const CODE_LENGTH = 16;
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
// v1 codes (pre-v2 rows, sha256 stored): 8 symbols from a 31-symbol alphabet.
const LEGACY_CODE_LENGTH = 8;
const LEGACY_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_PATTERN = new RegExp(`^${CODE_PREFIX}(?:[${CODE_ALPHABET}]{${CODE_LENGTH}}|[${LEGACY_CODE_ALPHABET}]{${LEGACY_CODE_LENGTH}})$`);
const CODE_HASH_SALT = "project-room-agent-invite-v2";
const CODE_HASH_PARAMS = { N: 16384, r: 8, p: 1 };

// Uniform symbols without modulo bias: a byte is used only when it falls in
// the largest multiple of the alphabet size, otherwise it is rejected and a
// fresh byte drawn. (For a 32-symbol alphabet nothing is ever rejected; the
// guard keeps the sampler correct if the alphabet changes.)
const randomSymbols = (length, alphabet) => {
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  let out = "";
  while (out.length < length) {
    for (const b of randomBytes(length - out.length)) {
      if (b < limit && out.length < length) out += alphabet[b % alphabet.length];
    }
  }
  return out;
};
// Deterministic slow hash for invite codes. Legacy 8-symbol codes were stored
// as bare unsalted sha256 (~40 bits, offline-invertible by anyone with DB read
// access); the sha256 fallback is removed, so those rows no longer redeem.
const codeHash = code => scryptSync(code, CODE_HASH_SALT, 32, CODE_HASH_PARAMS).toString("hex");
const NEVER_GRANT = ["manage_members", "decide", "invite_member"];

// Human descriptions for the standing invite profiles, surfaced by
// vocabulary() so a minting agent never has to guess what a profile grants.
const PROFILE_DESCRIPTIONS = Object.freeze({
  chat: "Read-only: the agent can observe the room but holds no work permissions.",
  contribute: "Accept and complete assigned work.",
  review: "Verify evidence on completed work.",
  collaborate: "Steer, accept, complete, and verify — default agent autonomy. Not manage_members, decide, or invite_member.",
});
const DEFAULT_TTL_MINUTES = 1440; // 24h
const MIN_TTL_MINUTES = 5;
const MAX_TTL_MINUTES = 43200; // 30d
const MEMBER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
// Public handle for a stored code: the first 8 hex digits (32 bits) of the
// stored hash. Enough to pick one row within a room; too short to confirm a
// guessed legacy 8-symbol code offline (about 2^40 candidates map onto 2^32
// handles), so the full hash never leaves the server.
const INVITE_ID_LENGTH = 8;
const INVITE_ID_PATTERN = new RegExp(`^[a-f0-9]{${INVITE_ID_LENGTH}}$`);
const inviteId = storedHash => storedHash.slice(0, INVITE_ID_LENGTH);

export const agentInviteSchema = `
  CREATE TABLE IF NOT EXISTS agent_invite_codes (
    code_hash TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    created_by TEXT NOT NULL,
    permissions_json TEXT NOT NULL,
    display_name TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    redeemed_at INTEGER,
    redeemed_identity_id TEXT,
    revoked_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS agent_invite_codes_room ON agent_invite_codes(room_id);
  -- G1 idempotent redeem (PRODUCT-200 D7): a client-kept requestId makes an
  -- uncertain retry safe. The receipt is written in the same transaction as
  -- the code burn, so a retry after a lost 201 replays the membership
  -- instead of 409ing on the burned code. Purely additive: older writers
  -- never read or write it.
  CREATE TABLE IF NOT EXISTS agent_invite_redeem_receipts (
    request_id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    identity_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    permissions_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`;

const inviteStatus = (row, now) =>
  row.revoked_at != null ? "revoked"
  : row.redeemed_at != null ? "redeemed"
  : now >= row.expires_at ? "expired" : "active";

const view = (row, now) => ({
  inviteId: inviteId(row.code_hash),
  roomId: row.room_id,
  createdBy: row.created_by,
  permissions: JSON.parse(row.permissions_json),
  displayName: row.display_name,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  redeemedAt: row.redeemed_at,
  redeemedIdentityId: row.redeemed_identity_id,
  revokedAt: row.revoked_at,
  status: inviteStatus(row, now),
});

// G1 idempotent redeem replay (PRODUCT-200 D7): replays a journaled
// redemption for an uncertain retry. No new identity, no new member event,
// no second burn — the same membership, a fresh onboarding token,
// duplicate:true. Mirrors the duplicate-identity path's active-membership
// check so a removed member's receipt cannot resurrect the grant.
const replayRedeemReceipt = (invites, receipt) => {
  const store = invites.store;
  const linked = invites.db.prepare("SELECT member_id FROM identity_links WHERE room_id=? AND identity_id=?")
    .get(receipt.room_id, receipt.identity_id);
  const member = linked && store.room(receipt.room_id).state.members[linked.member_id];
  if (!member?.active) fail(403, "access_ended", "Membership is no longer active");
  const mcpToken = store.agentPlugin.issueOnboardingMcpToken({
    identityId: receipt.identity_id, roomId: receipt.room_id, label: member.displayName
  });
  return withConnect(store, receipt.room_id, linked.member_id, {
    identityId: receipt.identity_id, roomId: receipt.room_id, memberId: linked.member_id,
    displayName: member.displayName, permissions: JSON.parse(receipt.permissions_json),
    duplicate: true, mcpToken,
    next: redeemNext(receipt.room_id, member.displayName), nextActions: nextActionsForInviteRedeem(receipt.room_id)
  });
};

export class AgentInvites {
  constructor(store) { this.store = store; this.db = store.db; }

  // Hash-free public shape of one stored row (inviteId handle, never the
  // stored hash), shared with the access review.
  view(row, now = this.store.now()) { return view(row, now); }

  // Machine-readable invite vocabulary for the minter (RC-2026-09-18-020).
  // An agent owner reads this before minting so it never has to guess
  // profile or permission names: profiles map server-side to fixed sets,
  // raw permissions are the room PERMISSIONS vocabulary, and neverGrant
  // names the bits an invite can never carry. (A dedicated
  // GET /api/agent-invites/vocabulary endpoint is queued behind the
  // server/http.mjs freeze; until then the 422s below teach the same
  // vocabulary on every miss.)
  vocabulary() {
    return {
      profiles: Object.fromEntries(Object.entries(agentAccessProfiles).map(
        ([name, permissions]) => [name, { permissions: [...permissions], description: PROFILE_DESCRIPTIONS[name] }])),
      permissions: [...PERMISSIONS],
      agentSafePermissions: [...AGENT_INVITE_SAFE_PERMISSIONS],
      neverGrant: [...NEVER_GRANT],
    };
  }

  // Owner, manage_members, or invite_member (agents may hold invite_member
  // without manage_members/decide): mint a one-time code. The raw code is
  // returned once; only its hash is stored. Callers may pass an explicit
  // permissions list or a standing profile name
  // (chat/contribute/review/collaborate); the profile maps server-side to
  // a fixed set, so editing the request cannot widen authority.
  create(token, roomId, { permissions, profile, expiresInMinutes = DEFAULT_TTL_MINUTES, displayName } = {}, expectedSessionBinding = null,
    { emailVerificationUnachievable = false } = {}) {
    // Owner delegates (server/owner-delegates.mjs) arrive via
    // store.authenticate with the delegate flag stamped on the member copy.
    const auth = this.store.authenticate(token, roomId, expectedSessionBinding);
    // The email gate bites only when verification is achievable. A deployment
    // whose mailer is unconfigured can never verify an account (the sign-in UI
    // says so honestly: "this account stays unverified"), so blocking invite
    // mint on it would deadlock the onboarding funnel permanently instead of
    // nudging the owner to verify. The HTTP route passes
    // emailVerificationUnachievable from the deployment mailer's isConfigured().
    if (auth.account && !emailVerificationUnachievable) this.store.accountLogins.assertEmailVerified(auth.account.id);
    const authority = this.store.roomAuthority(roomId);
    if (!auth.delegate && !canInviteMembers(authority, auth.member.id)) fail(403, "access_denied", "Invite grant required");
    // Minting invites is a membership write: the read-only autonomy tier
    // applies even when the agent holds an invite grant (issue #996).
    enforceAutonomyTierForAction({ db: this.store.db, roomId, state: this.store.room(roomId).state, actor: auth.member, action: "agent_invite_create", fail });
    let profileName = null;
    if (profile !== undefined) {
      if (typeof profile !== "string" || !Object.hasOwn(agentAccessProfiles, profile))
        fail(422, "invalid_invite_scope", `profile must be one of: ${Object.keys(agentAccessProfiles).join(", ")}`);
      if (permissions !== undefined)
        fail(422, "invalid_invite_scope", "Choose a profile or explicit permissions, not both");
      profileName = profile;
      permissions = [...agentAccessProfiles[profile]];
    }
    if (!Array.isArray(permissions) || (profileName === null && !permissions.length) || new Set(permissions).size !== permissions.length
      || permissions.some(p => !PERMISSIONS.includes(p))) {
      // RC-2026-09-18-020: the error teaches the vocabulary — a minter that
      // guesses "read"/"write" learns the real names instead of retrying blind.
      fail(422, "invalid_invite_scope",
        `permissions must be a non-empty list of unique room permissions (valid: ${PERMISSIONS.join(", ")}; or use a profile: ${Object.keys(agentAccessProfiles).join(", ")})`);
    }
    if (permissions.some(p => NEVER_GRANT.includes(p))) {
      fail(422, "invalid_invite_scope", "Agent invite codes cannot grant manage_members, decide, or invite_member");
    }
    // Non-owner issuers: manage_members may only grant bits they hold;
    // invite_member-only may grant the standing agent-safe set.
    const issuer = auth.delegate ? auth.member : authority.members[auth.member.id];
    if (!issuer || issuer.active === false) fail(403, "access_denied", "Active membership required");
    if (!auth.delegate && auth.member.id !== authority.ownerId) {
      const admin = issuer.permissions.includes("manage_members");
      if (admin && permissions.some(p => !issuer.permissions.includes(p))) {
        fail(403, "invite_scope_exceeded", "A membership administrator cannot grant authority they do not hold");
      }
      if (!admin && permissions.some(p => !AGENT_INVITE_SAFE_PERMISSIONS.includes(p))) {
        fail(403, "invite_scope_exceeded", "invite_member can only grant standing agent-safe permissions");
      }
    }
    if (!Number.isInteger(expiresInMinutes) || expiresInMinutes < MIN_TTL_MINUTES || expiresInMinutes > MAX_TTL_MINUTES) {
      fail(422, "invalid_invite_ttl", `expiresInMinutes must be ${MIN_TTL_MINUTES}-${MAX_TTL_MINUTES}`);
    }
    if (displayName !== undefined && typeof displayName !== "string") fail(422, "invalid_invite", "displayName must be text");
    const name = displayName === undefined ? null : displayName.trim();
    if (name !== null && (!name || name.length > 80)) fail(422, "invalid_invite_name", "displayName must be 1-80 characters");
    // Generate and hash before taking the write lock: scrypt is deliberately slow.
    const code = CODE_PREFIX + randomSymbols(CODE_LENGTH, CODE_ALPHABET);
    const stored = codeHash(code);
    return this.store.transaction(() => {
      const now = this.store.now();
      const expiresAt = now + expiresInMinutes * 60000;
      this.db.prepare(`INSERT INTO agent_invite_codes(code_hash,room_id,created_by,permissions_json,display_name,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?)`).run(stored, roomId, auth.member.id, JSON.stringify(permissions), name, now, expiresAt);
      return { code, inviteId: inviteId(stored), roomId, permissions, profile: profileName, displayName: name, createdAt: now, expiresAt, next: createNext(roomId, code) };
    });
  }

  // Unauthenticated: the code is the bearer credential. Burns the code,
  // mints an identity, and links it as an agent member — all atomically.
  //
  // G1 idempotent redeem (PRODUCT-200 D7): an opt-in client-kept `requestId`
  // makes an uncertain retry safe. The receipt is journaled in the same
  // transaction as the burn, so redeem → timeout → retry replays the same
  // membership (duplicate:true, fresh onboarding token) instead of 409ing
  // `invite_already_used` on the burned code with no recovery path. Same
  // key + different code/displayName is a 409
  // `invite_redeem_idempotency_conflict` (mirrors the direct-send
  // idempotency convention). Without a requestId the legacy behavior is
  // unchanged.
  redeem(code, { displayName, identitySecret = null, requestId = null } = {}) {
    const existingIdentity = identitySecret === null ? null : this.store.identities.resolveGlobalIdentitySecret(identitySecret);
    if (identitySecret !== null && !existingIdentity) fail(401, "unauthenticated", "Active identity credential required");
    if (requestId !== null && !validId(requestId)) fail(422, "invalid_invite", "Send a valid request id for retry-safe redemption.");
    // Legacy codes never contain I/L/O, so folding the confusables is safe
    // for both formats.
    const normalized = typeof code === "string" ? code.trim().toUpperCase().replace(/[IL]/g, "1").replace(/O/g, "0") : "";
    if (!CODE_PATTERN.test(normalized)) {
      fail(404, "invite_unavailable", "Invite code has the wrong format: invite codes are two letters, a dash, then 16 characters (no I, L, O, or U). Check for typos or ask the inviter for a fresh code");
    }
    // Hash outside the write transaction: scrypt is deliberately slow.
    const lookup = codeHash(normalized);
    return this.store.transaction(() => {
      const row = this.db.prepare("SELECT * FROM agent_invite_codes WHERE code_hash=?").get(lookup);
      if (!row) fail(404, "invite_unavailable", "No invite was issued for this code. Ask the inviter for a fresh code");
      // G1 idempotent redeem: the receipt check comes before the revoked /
      // expiry / already-used gates — a retry replays the membership the
      // first attempt committed, even if the code has since expired.
      if (requestId !== null) {
        const receipt = this.db.prepare("SELECT * FROM agent_invite_redeem_receipts WHERE request_id=?").get(requestId);
        if (receipt) {
          const name = typeof displayName === "string" && displayName.trim() ? displayName.trim()
            : row.display_name || DEFAULT_INVITE_NAME;
          if (receipt.code_hash !== row.code_hash || receipt.display_name !== name)
            fail(409, "invite_redeem_idempotency_conflict", "This request id already redeemed a different invite.");
          // A caller that presents an identity credential must be the identity
          // that redeemed: the replay mints a fresh onboarding token for it.
          if (existingIdentity && existingIdentity.identityId !== receipt.identity_id)
            fail(403, "invite_redeem_identity_mismatch", "This request id belongs to a different identity.");
          return replayRedeemReceipt(this, receipt);
        }
      }
      if (row.redeemed_at != null && existingIdentity?.identityId === row.redeemed_identity_id) {
        const linked = this.db.prepare("SELECT member_id FROM identity_links WHERE room_id=? AND identity_id=?").get(row.room_id, existingIdentity.identityId);
        const member = linked && this.store.room(row.room_id).state.members[linked.member_id];
        if (!member?.active) fail(403, "access_ended", "Membership is no longer active");
        const mcpToken = this.store.agentPlugin.issueOnboardingMcpToken({
          identityId: existingIdentity.identityId, roomId: row.room_id, label: member.displayName
        });
        return withConnect(this.store, row.room_id, member.id, { identityId: existingIdentity.identityId, roomId: row.room_id, memberId: member.id,
          displayName: member.displayName, permissions: member.permissions, duplicate: true, mcpToken,
          next: redeemNext(row.room_id, member.displayName), nextActions: nextActionsForInviteRedeem(row.room_id) });
      }
      if (row.revoked_at != null) fail(410, "invite_revoked", "Invite code was revoked");
      const now = this.store.now();
      if (now >= row.expires_at) fail(410, "invite_expired", "Invite code expired");
      if (row.redeemed_at != null) fail(409, "invite_already_used", "Invite code was already used");
      const room = this.store.room(row.room_id);
      // The inviter's authority is re-checked at redemption, like invitation
      // acceptance: a demoted issuer's outstanding codes stop working.
      if (!canInviteMembers(room.state, row.created_by)) {
        fail(409, "invite_authority_changed", "Inviter authority changed; ask for a new invite code");
      }
      // Reserve two event slots: member.added plus the referral.completed
      // journal event written in the same transaction. A one-slot check would
      // admit the member at the last slot and then fail journaling the
      // referral, rolling the whole join back after the fact.
      if (room.sequence + 1 >= PILOT_LIMITS.eventsPerRoom || activeMemberCount(room.state.members) >= PILOT_LIMITS.membersPerRoom) {
        fail(409, "pilot_limit", "Bounded pilot capacity reached; no data was changed");
      }
      const name = typeof displayName === "string" && displayName.trim() ? displayName.trim()
        : row.display_name || DEFAULT_INVITE_NAME;
      if (name.length > 80) fail(422, "invalid_invite_name", "displayName must be 1-80 characters");
      // The name becomes this room's member name. Refuse reserved labels,
      // hidden characters, and skeletons that match someone already here
      // before an identity or membership row is written.
      try {
        assertAdmissibleMemberName(name, room.state.members); // Q3-D: roster check plus role names
      } catch (error) {
        if (error?.code === "display_name_unavailable") {
          error.detail = {
            ...(error.detail && typeof error.detail === "object" ? error.detail : {}),
            displayName: error.suggestion,
            displayNameReason: error.reason,
          };
        }
        throw error;
      }
      const identity = existingIdentity ?? this.store.identities.create(name);
      if (this.db.prepare("SELECT 1 FROM identity_links WHERE room_id=? AND identity_id=?").get(row.room_id, identity.identityId))
        fail(409, "identity_already_linked", "Identity already joined; reuse its saved connection");
      const memberId = identity.identityId;
      if (!MEMBER_ID_PATTERN.test(memberId)) fail(500, "invite_failed", "Generated member id is invalid");
      const permissions = JSON.parse(row.permissions_json);
      const incoming = event({
        id: randomUUID(),
        idempotencyKey: hash(`agent-invite-redeem:${row.code_hash}`),
        type: T.MEMBER_ADDED,
        roomId: row.room_id,
        actorId: row.created_by,
        at: new Date(now).toISOString(),
        data: {
          memberId,
          displayName: name,
          kind: "agent",
          permissions,
          identityId: identity.identityId,
          authorityPolicyVersion: MEMBERSHIP_AUTHORITY_POLICY_VERSION,
          // Referral attribution: the invite minter is the referrer. The
          // member.added validator re-checks the shape and the self rule.
          referredBy: row.created_by,
          joinedVia: "one-time-code",
        },
      });
      let state;
      refuseArchivedWrite(room.state);
      try { state = compactState(applyEventWithGrowth(room.state, incoming, growthCollector).state); }
      catch (error) { fail(409, "invite_rejected", error.message); }
      const projection = this.store.storedProjection(row.room_id, state);
      if (Buffer.byteLength(projection) > PILOT_LIMITS.projectionBytes) fail(409, "pilot_limit", "Room projection limit reached; no data was changed. Ask the room owner to raise the room's limit, or try again later.");
      const sequence = room.sequence + 1;
      this.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(row.room_id, sequence, incoming.id, JSON.stringify(incoming));
      this.db.prepare("UPDATE rooms SET sequence=?,projection=? WHERE id=?").run(sequence, projection, row.room_id);
      this.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)")
        .run(row.room_id, identity.identityId, memberId, now);
      // Compare-and-swap burn: exactly one redemption wins under concurrency.
      const burned = this.db.prepare(`UPDATE agent_invite_codes SET redeemed_at=?,redeemed_identity_id=?
        WHERE code_hash=? AND redeemed_at IS NULL AND revoked_at IS NULL`).run(now, identity.identityId, row.code_hash);
      if (burned.changes !== 1) fail(409, "invite_already_used", "Invite code was already used");
      // G1 idempotent redeem: journal the receipt in the SAME transaction as
      // the burn, so an uncertain retry replays this exact membership.
      if (requestId !== null) {
        this.db.prepare(`INSERT INTO agent_invite_redeem_receipts
          (request_id, code_hash, identity_id, room_id, member_id, display_name, permissions_json, created_at)
          VALUES (?,?,?,?,?,?,?,?)`)
          .run(requestId, row.code_hash, identity.identityId, row.room_id, memberId, name, JSON.stringify(permissions), now);
      }
      // Referral attribution, same transaction, after the winning burn: the
      // minter is the referrer. Exactly-once per referee via the referrals
      // table primary key; a retry of this same redemption returns the
      // duplicate path above and never reaches here. Self-joins (minter
      // redeeming their own code) record nothing — no self-referrals.
      if (row.created_by !== memberId) {
        this.store.referrals.record({ roomId: row.room_id, referrerMemberId: row.created_by, refereeMemberId: memberId, via: "invite", at: now });
      }
      // Onboarding returns a room-scoped MCP token. The identity credential
      // stays in the store and is not included in this response. Connect
      // steps name the MCP URL; they do not carry the token.
      const mcpToken = this.store.agentPlugin.issueOnboardingMcpToken({
        identityId: identity.identityId, roomId: row.room_id, label: name
      });
      return withConnect(this.store, row.room_id, memberId, { identityId: identity.identityId, ...(existingIdentity ? { duplicate: false } : {}), mcpToken,
        roomId: row.room_id, memberId, displayName: name, permissions,
        next: redeemNext(row.room_id, name), nextActions: nextActionsForInviteRedeem(row.room_id) });
    });
  }

  // Read-only invite preview for the pre-redemption consent screen. Mirrors
  // redeem()'s lookup, folding and failure codes exactly, but consumes
  // nothing: the code stays live. Returns the room, the granted
  // permissions, the matching standing profile (or "custom"), the expiry
  // timestamp, and the inviter's display name. Never reveals member ids or
  // identity data.
  preview(code) {
    const normalized = typeof code === "string" ? code.trim().toUpperCase().replace(/[IL]/g, "1").replace(/O/g, "0") : "";
    if (!CODE_PATTERN.test(normalized)) {
      fail(404, "invite_unavailable", "Invite code has the wrong format: invite codes are two letters, a dash, then 16 characters (no I, L, O, or U). Check for typos or ask the inviter for a fresh code");
    }
    // Hash outside the transaction like redeem(): scrypt is deliberately slow.
    const lookup = codeHash(normalized);
    const row = this.db.prepare("SELECT * FROM agent_invite_codes WHERE code_hash=?").get(lookup);
    if (!row) fail(404, "invite_unavailable", "No invite was issued for this code. Ask the inviter for a fresh code");
    if (row.revoked_at != null) fail(410, "invite_revoked", "Invite code was revoked");
    const now = this.store.now();
    if (now >= row.expires_at) fail(410, "invite_expired", "Invite code expired");
    if (row.redeemed_at != null) fail(409, "invite_already_used", "Invite code was already used");
    const room = this.store.room(row.room_id);
    // The inviter's authority is re-checked like redemption: a demoted
    // issuer's outstanding codes stop working.
    if (!canInviteMembers(room.state, row.created_by)) {
      fail(409, "invite_authority_changed", "Inviter authority changed; ask for a new invite code");
    }
    const permissions = JSON.parse(row.permissions_json);
    const profile = Object.keys(agentAccessProfiles).find(name => {
      const set = agentAccessProfiles[name];
      return set.length === permissions.length && set.every(p => permissions.includes(p));
    }) ?? "custom";
    // Inviter display name for the consent screen ("Invited by …"). The
    // member id is never exposed — display name only, so no identity leaks.
    const inviter = room.state?.members?.[row.created_by];
    const inviterDisplayName = typeof inviter?.displayName === "string" && inviter.displayName ? inviter.displayName : null;
    return { roomId: row.room_id, roomTitle: room.state?.room?.title ?? row.room_id,
      permissions, profile, expiresAt: row.expires_at, inviterDisplayName };
  }

  // Owner-only: revoke an unredeemed code by the handle list() and create()
  // return. Already-redeemed members are unaffected; unlink those with
  // identity-unlink.
  revoke(token, roomId, id, expectedSessionBinding = null) {
    const auth = this.store.authenticate(token, roomId, expectedSessionBinding);
    const authority = this.store.roomAuthority(roomId);
    if (!memberCan(authority, auth.member.id, "manage_members")) fail(403, "access_denied", "Membership administration grant required");
    // Revoking invites is a membership write: the read-only autonomy tier
    // applies even when the agent holds a manage_members grant (issue #996).
    enforceAutonomyTierForAction({ db: this.store.db, roomId, state: this.store.room(roomId).state, actor: auth.member, action: "agent_invite_revoke", fail });
    if (typeof id !== "string" || !INVITE_ID_PATTERN.test(id)) fail(422, "invalid_invite", "inviteId is required");
    return this.store.transaction(() => {
      const rows = this.db.prepare(`SELECT code_hash FROM agent_invite_codes
        WHERE room_id=? AND substr(code_hash,1,?)=? AND redeemed_at IS NULL AND revoked_at IS NULL`).all(roomId, INVITE_ID_LENGTH, id);
      if (!rows.length) fail(404, "invite_unavailable", "Invite code not found, already used, or already revoked");
      if (rows.length > 1) fail(409, "invite_ambiguous", "More than one active invite matches this handle; revoke it from the database");
      this.db.prepare("UPDATE agent_invite_codes SET revoked_at=? WHERE code_hash=?").run(this.store.now(), rows[0].code_hash);
      return { inviteId: id, revoked: true };
    });
  }

  // Owner-only: audit view. Raw codes are never stored and the stored hash
  // stays server-side; rows carry the inviteId handle that revoke() takes.
  list(token, roomId, expectedSessionBinding = null) {
    const auth = this.store.authenticate(token, roomId, expectedSessionBinding);
    const authority = this.store.roomAuthority(roomId);
    if (!memberCan(authority, auth.member.id, "manage_members")) fail(403, "access_denied", "Membership administration grant required");
    const now = this.store.now();
    return this.db.prepare("SELECT * FROM agent_invite_codes WHERE room_id=? ORDER BY created_at DESC").all(roomId)
      .map(row => view(row, now));
  }
}

// Machine-readable next steps for an agent that just redeemed an invite.
// Same shape and vocabulary as SIGNUP_NEXT in agent-identities.mjs
// (RC-2026-09-18-018) so the two entry paths feel like one product; the
// steps are tailored to the invite path: this agent already has a room and
// a member id, so the guidance is the room's first moves (meet the
// members, say hello, advertise what you can do, find work). Room-scoped
// paths are built with the joined room's id so every step is immediately
// actionable — no room lookup first. A redeem cannot rename a member, so
// when the name fell back to the default the first step explains how to
// redo the redeem with the wanted displayName.
const withConnect = (store, roomId, memberId, body) => {
  const starter = starterFor(store, roomId, memberId);
  return { ...body, connect: connectFields(), ...(starter ? { starter } : {}) };
};

const DEFAULT_INVITE_NAME = "Invited agent";
const redeemNext = (roomId, displayName) => {
  const room = `/api/rooms/${encodeURIComponent(roomId)}`;
  const steps = [
    Object.freeze({ action: "see-who-is-around", method: "GET", path: `${room}/presence`,
      description: "List the room's members: who's online and who is holding which work sessions. Read this before you grab work." }),
    Object.freeze({ action: "post-first-message", method: "POST", path: `${room}/commands`,
      description: "Say hello to the room. Authenticate with your identity credential as the Bearer token, and send { id: <uuid>, type: \"message.posted\", data: { messageId: <uuid>, body: \"hello\" } }; omit toMemberId to post to everyone." }),
    Object.freeze({ action: "advertise-capabilities", method: "POST", path: `${room}/commands`,
      description: "Publish your agent card: send { id: <uuid>, type: \"capabilities.advertised\", data: { capabilities: [\"web-research\", \"code-review\"] } } so other members know what to delegate to you." }),
    Object.freeze({ action: "find-work", method: "GET", path: `${room}/work-sessions`,
      description: "Work cards with status and holder. Claim a queued item by driving its session to processing; the claim is structural, not a convention." }),
    Object.freeze({ action: "read-quickstart", doc: "docs/AGENT-QUICKSTART.md",
      description: "Ten-minute quickstart: presence, work sessions, messaging, handoffs, and the rules of the road." }),
  ];
  if (displayName === DEFAULT_INVITE_NAME) {
    steps.unshift(Object.freeze({ action: "choose-display-name", method: "POST", path: "/api/agent-invites/redeem",
      description: "Joined as 'Invited agent'? Ask the inviter for a fresh one-time code and redeem again with { code, displayName: \"Your Name\" } — the displayName you pass becomes your member name." }));
  }
  return Object.freeze(steps);
};

// Machine-readable next steps for an owner that just minted an invite code.
// Same shape as redeemNext: the concrete owner moves — share the code with
// the invitee out-of-band, preview what the invitee will see, and list or
// revoke outstanding invites.
const createNext = (roomId, code) => {
  const room = `/api/rooms/${encodeURIComponent(roomId)}`;
  return Object.freeze([
    Object.freeze({ action: "share-code", description:
      `Share this one-time code with the invitee out-of-band (chat, email, DM). The invitee joins at POST /api/agent-invites/redeem with { code: "${code}", displayName: "Their Name" } — the code burns on redeem.` }),
    Object.freeze({ action: "preview-invite", method: "GET",
      path: `/api/agent-invites/preview?code=${encodeURIComponent(code)}`,
      description: "See exactly what the invitee sees before redeeming: the room's consent screen (room name, inviter, permissions). No identity data is revealed." }),
    Object.freeze({ action: "list-invites", method: "GET", path: `${room}/agent-invites`,
      description: "List this room's outstanding invite codes with their permissions and expiry. Revoke one with DELETE on the same path and { inviteId }." }),
  ]);
};
