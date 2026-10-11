// RC-2026-09-19-078 — account-deletion wiring.
//
// src/account-deletion.mjs plans WHAT to purge in WHAT order but never
// touches the store. This module is the execution side: it builds the
// purge inventory from the live store, signs short-lived confirmation
// tokens (confirm-then-delete), and executes the plan — actually deleting
// the account's data. The retention policy is documented in
// RETENTION_POLICY and served at GET /api/account/retention.
//
// Deletion flow:
//   1. GET /api/account/deletion/plan -> inventoryFromStore + planDeletion
//      + summarizePurge + a confirmation token bound to (account, plan, 10m).
//   2. POST /api/account/delete { confirmationToken } -> the token is
//      verified against a freshly rebuilt plan (changed data 409s as
//      plan_changed), then executeAccountDeletion runs the purge steps in
//      order inside one transaction.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { EVENT_TYPES, applyEvent, event, isRoomArchived, roomKind } from "../src/events.js";
import { commitMessageRedaction, redactRemainingMessageBodies } from "./message-redaction.mjs";
import { ServiceError } from "./store.mjs";
import {
  ACTIONS,
  DEFAULT_LEGAL_HOLD_REASON,
  planDeletion,
  summarizePurge,
  validatePurgePlan,
} from "../src/account-deletion.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

// What deletion removes vs retains, and why. Served verbatim at
// GET /api/account/retention and attached to every deletion plan.
export const RETENTION_POLICY = Object.freeze({
  version: "1.5.0",
  summary: "Account deletion purges the account's sign-in credentials, "
    + "sessions, room memberships, connected Gmail data, private inbox content "
    + "(imported messages, drafts, read state), connected email data, derived "
    + "stitch data, inbox handoff packets, SLA breach alerts, channel update journals, account setup answers, "
    + "terms-of-service acceptance, and profile data. Guest invites, share links, "
    + "membership invitations, and agent and referral invites issued by the account are revoked, and agent "
    + "connections the account sponsored are disconnected. Personal rooms this account solely owns are archived "
    + "and their messages and files are purged. Security audit rows, inbox/email "
    + "command receipts, abuse "
    + "reports, operator unpublish records, and "
    + "the deactivated account tombstone are retained under legal hold; "
    + "room history already shared with other members is room-owned and is "
    + "not rewritten. A shared room with other members and no other owner "
    + "blocks deletion until ownership is transferred.",
  purged: Object.freeze([
    Object.freeze({ category: "personal_room_content", description: "Messages and files in personal rooms this account solely owns are purged, and those rooms are archived." }),
    Object.freeze({ category: "credentials", description: "Account access keys (account_credentials) are deleted; outstanding keys stop working immediately." }),
    Object.freeze({ category: "sessions", description: "Browser account-session slots (account_session_slots) are deleted; every signed-in browser session ends." }),
    Object.freeze({ category: "login_methods", description: "All linked sign-in methods are deleted: password verifiers, magic codes, and recovery codes." }),
    Object.freeze({ category: "passkeys", description: "All registered passkey credentials are deleted." }),
    Object.freeze({ category: "memberships", description: "Room membership bindings (member_accounts) are deleted; the account leaves every room." }),
    Object.freeze({ category: "connected_data", description: "Connected Gmail data (gmail_mailboxes, gmail_linked_mailboxes, gmail_pending, gmail_operations) and account setup answers (account_setup) are permanently deleted." }),
    Object.freeze({ category: "private_inbox", description: "Private inbox content is permanently deleted: imported message versions (private_inbox_versions), drafts (private_inbox_drafts), sources (private_inbox_sources), and read state (private_inbox_reads)." }),
    Object.freeze({ category: "private_email", description: "Connected email data is permanently deleted: connections (private_email_connections) and folders (private_email_folders)." }),
    Object.freeze({ category: "stitch", description: "Derived cross-channel stitch data (stitch_identities, stitch_links, stitch_suggestions, stitch_receipts, stitch_revocations) is permanently deleted." }),
    Object.freeze({ category: "derived_inbox", description: "Account-keyed inbox and channel rows are permanently deleted: handoff packets (inbox_handoffs), SLA breach alerts (sla_breach_alerts), the channel update journal (pending_channel_updates), and channel live status (telegram_live_status)." }),
    Object.freeze({ category: "member_issued_invites", description: "Unredeemed agent invites (agent_invite_codes) and referral invites (referral_invites) minted by the account's room members are revoked before the account leaves its rooms; their history stays for audit." }),
    Object.freeze({ category: "issued_access", description: "Access granted by the account is revoked: active guest invites (guest_invites), share links (share_links), and pending membership invitations it issued or that were issued to it." }),
    Object.freeze({ category: "sponsored_agents", description: "Agent connections sponsored by the account are disconnected: their room credentials are revoked (agentConnections.revokeAccount), the same revocation a deactivation performs." }),
    Object.freeze({ category: "terms", description: "The terms-of-service acceptance record (account_terms) is deleted." }),
    Object.freeze({ category: "oauth_tokens", description: "Third-party OAuth grants (authorization codes, access and refresh tokens) are deleted and revoked; connectors lose access immediately." }),
    Object.freeze({ category: "analytics", description: "Analytics events attributed to the account (analytics_events) are permanently deleted." }),
    Object.freeze({ category: "profile", description: "The account row is deactivated (active=0), its auth epoch is rotated so no residual credential can authenticate, and display name / avatar are scrubbed." }),
  ]),
  retained: Object.freeze([
    Object.freeze({ category: "audit", reason: "account_access_events rows are retained for security auditing, fraud prevention, and dispute resolution." }),
    Object.freeze({ category: "inbox_receipts", reason: "private_inbox_commands and private_email_commands rows are tamper-evident command receipts retained for dispute resolution, like security audit rows; their triggers forbid deletion." }),
    Object.freeze({ category: "abuse_reports", reason: "public_abuse_reports rows are retained as safety evidence under the same legal hold; deleting them would destroy abuse investigations." }),
    Object.freeze({ category: "unpublish_records", reason: "public_unpublish rows are the live unpublish state consulted by the public read model; deleting them would re-expose unpublished content." }),
    Object.freeze({ category: "profile_tombstone", reason: "The account id remains as a deactivated tombstone (active=0, profile scrubbed) so retained audit rows stay attributable. It can never sign in again." }),
    Object.freeze({ category: "room_history", reason: "Room events already shared with other members (messages, work history) are room-owned history and are not rewritten when another owner remains; only the member binding is removed. Sole ownership of a shared room blocks deletion until that ownership is transferred." }),
  ]),
});

const countWhere = (store, table, accountId) =>
  store.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE account_id=?`).get(accountId)?.n ?? 0;

const countWhereColumn = (store, table, column, accountId) =>
  store.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column}=?`).get(accountId)?.n ?? 0;

const tableExists = (db, name) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

// SEC-04: account-keyed inbox/channel tables outside the private_inbox set.
const DERIVED_INBOX_TABLES = Object.freeze(["inbox_handoffs", "sla_breach_alerts", "pending_channel_updates", "telegram_live_status"]);

const countDerivedInbox = (store, accountId) => DERIVED_INBOX_TABLES
  .filter(table => tableExists(store.db, table))
  .reduce((sum, table) => sum + countWhere(store, table, accountId), 0);

// SEC-04: invites are keyed by (room, member), not account. member_accounts
// maps the account to its member id in each room.
const memberBindings = (store, accountId) =>
  store.db.prepare("SELECT room_id, member_id FROM member_accounts WHERE account_id=?").all(accountId);

const countMemberIssuedInvites = (store, accountId) => {
  const db = store.db;
  const agent = tableExists(db, "agent_invite_codes")
    ? db.prepare("SELECT count(*) AS n FROM agent_invite_codes WHERE room_id=? AND created_by=? AND redeemed_at IS NULL AND revoked_at IS NULL")
    : null;
  const referral = tableExists(db, "referral_invites")
    ? db.prepare("SELECT count(*) AS n FROM referral_invites WHERE room_id=? AND inviter_member_id=? AND status='minted'")
    : null;
  let n = 0;
  for (const { room_id: roomId, member_id: memberId } of memberBindings(store, accountId)) {
    if (agent) n += agent.get(roomId, memberId)?.n ?? 0;
    if (referral) n += referral.get(roomId, memberId)?.n ?? 0;
  }
  return n;
};

// Access grants issued by (or pending for) the account that revocation must retire.
const countIssuedAccess = (store, accountId) => {
  const db = store.db;
  const guests = db.prepare("SELECT count(*) AS n FROM guest_invites WHERE minted_by_account_id=? AND status='active'").get(accountId)?.n ?? 0;
  const links = db.prepare("SELECT count(*) AS n FROM share_links WHERE issuer_account_id=? AND revoked_at IS NULL").get(accountId)?.n ?? 0;
  const issued = db.prepare("SELECT count(*) AS n FROM membership_invitations WHERE issuer_account_id=? AND status='pending'").get(accountId)?.n ?? 0;
  const intended = db.prepare("SELECT count(*) AS n FROM membership_invitations WHERE intended_account_id=? AND status='pending'").get(accountId)?.n ?? 0;
  return guests + links + issued + intended;
};

// Some tables are created on first use; count them only when they exist.
// A genuinely missing table reads as 0. A real DB error MUST propagate:
// executeAccountDeletion runs inside one transaction, and a swallowed error
// here would commit a partial deletion while the receipt reports removed: 0
// with no error surfaced.
const countWhereIfExists = (store, table, idColumn, accountId) => {
  const exists = store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!exists) return 0;
  return store.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${idColumn}=?`).get(accountId)?.n ?? 0;
};

const deleteWhereIfExists = (store, table, idColumn, accountId) => {
  const exists = store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!exists) return 0;
  return store.db.prepare(`DELETE FROM ${table} WHERE ${idColumn}=?`).run(accountId).changes;
};


const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const freezeList = list => Object.freeze(list.map(entry => Object.freeze({ ...entry })));

function fileCount(store, roomId) {
  try {
    return store.db.prepare(
      "SELECT count(*) AS n FROM room_attachments WHERE room_id=? AND state IN ('staged','committed')"
    ).get(roomId)?.n ?? 0;
  } catch { return 0; }
}

// Another owner is an active human member bound to a different live account.
// Agents stay with their sponsor, so they cannot receive the room.
function otherHumanOwners(store, state, roomId, accountId, ownerMemberId) {
  const heirs = [];
  for (const member of Object.values(state.members ?? {})) {
    if (!member || member.active === false || member.kind !== "human" || member.id === ownerMemberId) continue;
    const row = store.db.prepare(
      "SELECT account_id AS accountId FROM member_accounts WHERE room_id=? AND member_id=?"
    ).get(roomId, member.id);
    if (!row || row.accountId === accountId) continue;
    const account = store.db.prepare("SELECT active FROM accounts WHERE id=?").get(row.accountId);
    if (!account || account.active !== 1) continue;
    heirs.push(member.id);
  }
  heirs.sort();
  return heirs;
}

// QA2 finding P2-11: rooms this account owns, classified so deletion cannot
// leave an ownerless room full of their content.
export function classifyOwnedRooms(store, accountId) {
  const memberships = store.db.prepare(
    "SELECT room_id AS roomId, member_id AS memberId FROM member_accounts WHERE account_id=? ORDER BY room_id"
  ).all(accountId);
  const archive = [], transfer = [], blocked = [], retained = [];
  for (const membership of memberships) {
    let loaded;
    try { loaded = store.room(membership.roomId); }
    catch { continue; }
    const state = loaded.state;
    const ownerMemberId = state.room?.ownerId;
    const entry = {
      id: membership.roomId,
      title: typeof state.room?.title === "string" && state.room.title ? state.room.title : membership.roomId,
      kind: roomKind(state.room),
      memberId: membership.memberId,
      toMemberId: null,
      messages: Array.isArray(state.messages) ? state.messages.length : 0,
      files: fileCount(store, membership.roomId),
    };
    if (ownerMemberId !== membership.memberId) {
      retained.push(entry);
      continue;
    }
    const heirs = otherHumanOwners(store, state, membership.roomId, accountId, membership.memberId);
    const otherMembers = Object.values(state.members ?? {})
      .filter(member => member && member.active !== false && member.id !== membership.memberId);
    if (heirs.length) transfer.push({ ...entry, toMemberId: heirs[0] });
    else if (entry.kind === "personal" || otherMembers.length === 0) archive.push(entry);
    else blocked.push(entry);
  }
  for (const list of [archive, transfer, blocked, retained]) list.sort(byId);
  return {
    archive: freezeList(archive),
    transfer: freezeList(transfer),
    blocked: freezeList(blocked),
    retained: freezeList(retained),
  };
}

function refuseOwnershipTransfer(rooms) {
  const listed = rooms.map(room => `${room.title} (${room.id})`).join(", ");
  const error = new ServiceError(409, "transfer_ownership_required",
    `Transfer ownership of these shared rooms before deleting this account: ${listed}`);
  error.detail = { rooms: rooms.map(room => ({ id: room.id, title: room.title, kind: room.kind })) };
  throw error;
}

const compactState = state => ({ ...state, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} });

function saveRoomProjection(store, roomId, sequence, state) {
  const compact = compactState(state);
  const archivedAt = typeof compact.room?.archivedAt === "string" ? compact.room.archivedAt : null;
  // Checkpoints keep full bodies: replay edits from them. Only the room row
  // goes through the Phase 1a serializer.
  const projection = store.storedProjection(roomId, compact);
  store.db.prepare("UPDATE rooms SET sequence=?, projection=?, archived_at=? WHERE id=?").run(sequence, projection, archivedAt, roomId);
  store.db.prepare(`INSERT INTO projection_checkpoints(room_id, sequence, projection) VALUES(?,?,?)
    ON CONFLICT(room_id) DO UPDATE SET sequence=excluded.sequence, projection=excluded.projection`).run(roomId, sequence, JSON.stringify(compact));
}

function appendRoomEvent(store, roomId, actorId, type, data) {
  const current = store.room(roomId);
  const incoming = event({ type, actorId, roomId, at: new Date(store.now()).toISOString(), data });
  let next;
  try { next = applyEventOnRoom(current.state, incoming); }
  catch (error) { fail(409, "plan_changed", `Room changed during account deletion; request a fresh plan (${error.message})`); }
  const sequence = current.sequence + 1;
  store.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(roomId, sequence, incoming.id, JSON.stringify(incoming));
  saveRoomProjection(store, roomId, sequence, next);
}

function applyEventOnRoom(state, incoming) {
  // A compacted projection already has empty seen-event maps, so one new
  // event applies cleanly without replaying the room from scratch.
  const base = {
    ...state,
    eventLog: Array.isArray(state.eventLog) ? state.eventLog : [],
    seenEvents: state.seenEvents && typeof state.seenEvents === "object" ? state.seenEvents : {},
    seenIdempotencyKeys: state.seenIdempotencyKeys && typeof state.seenIdempotencyKeys === "object" ? state.seenIdempotencyKeys : {},
  };
  return applyEvent(base, incoming);
}

function redactRoomMessages(store, roomId, actorId) {
  const room = store.room(roomId);
  const messages = room.state.messages ?? [];
  const ids = [];
  for (const message of messages) {
    if (typeof message.id !== "string") continue;
    if (message.id.endsWith(":channel")) {
      const source = message.id.slice(0, -":channel".length);
      if (messages.some(entry => entry.id === source)) continue;
    }
    ids.push(message.id);
  }
  let state = room.state;
  let removed = 0;
  const at = new Date(store.now()).toISOString();
  for (const messageId of ids) {
    const result = commitMessageRedaction(store.db, { roomId, state, actorId, at, messageId, bodiesAtRest: store.bodiesAtRest });
    state = result.state;
    removed += result.rewritten;
  }
  removed += redactRemainingMessageBodies(store.db, roomId);
  let files = 0;
  try {
    files = store.db.prepare(
      "UPDATE room_attachments SET state='deleted', bytes=NULL, filename='purged' WHERE room_id=? AND state IN ('staged','committed')"
    ).run(roomId).changes;
  } catch { files = 0; }
  try {
    store.db.prepare("DELETE FROM room_code_checks WHERE room_id=?").run(roomId);
    files += store.db.prepare("DELETE FROM room_code_drops WHERE room_id=?").run(roomId).changes;
  } catch { /* no code drop tables on this file */ }
  return removed + files;
}

function rebuildRoom(store, roomId) {
  store.db.prepare("DELETE FROM projection_checkpoints WHERE room_id=?").run(roomId);
  const rebuilt = store.rebuildProjection(roomId);
  saveRoomProjection(store, roomId, rebuilt.sequence, rebuilt.state);
}

// Archive a solely owned personal room and strip message and file bytes.
// Events are redacted, then the projection is rebuilt so recovery matches.
function archivePersonalRoom(store, room) {
  // Public activity summaries and retry responses can contain room text too.
  for (const table of ["room_assistant_config", "room_assistant_runs", "room_assistant_ops", "room_trial_tasks", "room_trial_requests", "room_vetting_keys", "room_vetting_receipts", "demigod_offer_profiles", "demigod_offer_requests", "demigod_contracts", "demigod_contract_requests", "buyer_signoff_loops", "buyer_signoff_requests"]) {
    if (store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
      store.db.prepare(`DELETE FROM ${table} WHERE room_id=?`).run(room.id);
  }
  const removed = redactRoomMessages(store, room.id, room.memberId);
  const state = store.room(room.id).state;
  if (!isRoomArchived(state)) {
    const current = store.room(room.id);
    const incoming = event({
      type: EVENT_TYPES.ROOM_ARCHIVED, actorId: room.memberId, roomId: room.id,
      at: new Date(store.now()).toISOString(), data: { reason: "Account deletion" },
    });
    const sequence = current.sequence + 1;
    store.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(room.id, sequence, incoming.id, JSON.stringify(incoming));
    store.db.prepare("UPDATE rooms SET sequence=? WHERE id=?").run(sequence, room.id);
  }
  rebuildRoom(store, room.id);
  return removed;
}

function disposeOwnedRooms(store, plan) {
  let removed = 0;
  for (const room of plan.rooms?.transfer ?? []) {
    appendRoomEvent(store, room.id, room.memberId, EVENT_TYPES.OWNERSHIP_TRANSFERRED, {
      toMemberId: room.toMemberId, reason: "Account deletion",
    });
    removed += 1;
  }
  for (const room of plan.rooms?.archive ?? []) removed += archivePersonalRoom(store, room);
  return removed;
}

// Build the planner inventory from the live store. Audit rows are legal
// hold (retained, never purged); everything else purges. Sessions purge
// before credentials: account_session_slots.parent_credential_hash is a
// foreign key into account_credentials, so deleting credentials first
// violates it. Owned rooms are part of the signed plan (QA2 P2-11).
export function inventoryFromStore(store, accountId, rooms = null) {
  if (typeof accountId !== "string" || accountId.length === 0) fail(422, "invalid_account", "Invalid account id");
  store.account(accountId); // 404 when missing
  const owned = rooms ?? classifyOwnedRooms(store, accountId);
  const roomWork = owned.archive.length + owned.transfer.length + owned.blocked.length;
  const inventory = {
    sessions: { itemCount: countWhere(store, "account_session_slots", accountId), dependsOn: [] },
    credentials: { itemCount: countWhere(store, "account_credentials", accountId), dependsOn: ["sessions"] },
    login_methods: { itemCount: store.accountLogins.listMethods(accountId).length },
    passkeys: { itemCount: store.accountLogins.listPasskeyCredentials(accountId).length },
    memberships: {
      itemCount: countWhere(store, "member_accounts", accountId),
      ...(roomWork ? { dependsOn: ["owned_rooms"] } : {}),
    },
    audit: {
      itemCount: countWhere(store, "account_access_events", accountId),
      legalHold: true,
      legalHoldReason: "Access history is retained for security auditing, fraud prevention, and dispute resolution.",
    },
    profile: { itemCount: 1 },
    // Connected Gmail data and account setup answers: purged by their own
    // executor so the signed plan, the retention policy, and the
    // confirmation summary all disclose them (M-1).
    connected_data: {
      itemCount: ["gmail_mailboxes", "gmail_linked_mailboxes", "gmail_pending", "gmail_operations", "account_setup"]
        .reduce((sum, table) => sum + countWhere(store, table, accountId), 0),
    },
    // QA2-SECREG: the terms acceptance row is per-account data and must be
    // disclosed in the signed plan like every other purged category (M-1).
    terms: {
      itemCount: countWhere(store, "account_terms", accountId),
    },
    // QA slice D (2026-10-04): the private inbox, connected email data, and
    // derived stitch rows are account-owned personal data and must purge.
    private_inbox: {
      itemCount: ["private_inbox_sources", "private_inbox_versions", "private_inbox_drafts", "private_inbox_reads"]
        .reduce((sum, table) => sum + countWhere(store, table, accountId), 0),
    },
    private_email: {
      itemCount: ["private_email_connections", "private_email_folders"]
        .reduce((sum, table) => sum + countWhere(store, table, accountId), 0),
    },
    stitch: {
      itemCount: ["stitch_identities", "stitch_links", "stitch_suggestions", "stitch_receipts", "stitch_revocations"]
        .reduce((sum, table) => sum + countWhere(store, table, accountId), 0),
    },
    // Command journals are tamper-evident receipts: retained under legal
    // hold like security audit rows, disclosed in the confirmation summary.
    inbox_receipts: {
      itemCount: ["private_inbox_commands", "private_email_commands"]
        .reduce((sum, table) => sum + countWhere(store, table, accountId), 0),
      legalHold: true,
      legalHoldReason: "Inbox and email command journals are tamper-evident receipts retained for dispute resolution, like security audit rows.",
    },
    // Access the account granted must not outlive it: revoke invites, share
    // links, and pending invitations instead of deleting their history.
    issued_access: {
      itemCount: countIssuedAccess(store, accountId),
    },
    // Agents the account sponsored lose their room credentials on deletion,
    // mirroring changeAccountAccess (the deactivation path).
    sponsored_agents: {
      itemCount: countWhereColumn(store, "agent_connections", "sponsor_account_id", accountId),
    },
    // OAuth provider tokens (third-party connector grants): without this a
    // deleted user's refresh tokens stay valid for up to 30 days.
    oauth_tokens: {
      itemCount: ["oauth_provider_codes", "oauth_provider_access_tokens", "oauth_provider_refresh_tokens"]
        .reduce((sum, table) => sum + countWhereIfExists(store, table, "user_id", accountId), 0),
    },
    // Analytics events attributed to the account.
    analytics: {
      itemCount: countWhereIfExists(store, "analytics_events", "account_id", accountId),
    },
    // SEC-04: handoff packets, SLA alerts, and channel journals carry private
    // thread content and metadata keyed by account.
    derived_inbox: {
      itemCount: countDerivedInbox(store, accountId),
    },
    // SEC-04: agent and referral invites minted by the account's members.
    member_issued_invites: {
      itemCount: countMemberIssuedInvites(store, accountId),

    },
  };
  if (roomWork) inventory.owned_rooms = { itemCount: owned.archive.length + owned.transfer.length, dependsOn: [] };
  return inventory;
}

function retentionLines() {
  return "Retention categories purged: " + RETENTION_POLICY.purged.map(entry => entry.category).join(", ") + ".\n"
    + "Retention categories retained: " + RETENTION_POLICY.retained.map(entry => entry.category).join(", ") + ".";
}

// Plan + human-readable confirmation summary for an account. The plan's
// rooms field is part of the confirmation-token digest.
export function planAccountDeletion(store, accountId) {
  const rooms = classifyOwnedRooms(store, accountId);
  const planned = planDeletion({ id: accountId }, inventoryFromStore(store, accountId, rooms));
  const plan = Object.freeze({ ...planned, rooms: Object.freeze({ ...rooms }) });
  const summary = summarizePurge(plan);
  return {
    plan,
    summary: Object.freeze({ ...summary, rooms: plan.rooms, text: `${summary.text}\n${retentionLines()}` }),
  };
}

function deactivateBoundMembers(store, accountId) {
  for (const { room_id: roomId, member_id: memberId } of memberBindings(store, accountId)) {
    const state = store.room(roomId).state;
    const member = state.members?.[memberId];
    if (!member || member.active === false || isRoomArchived(state)) continue;
    if (store.roomAuthority(roomId).ownerId === memberId) continue;
    const key = store.issueAccessKey(roomId, memberId, 60000, accountId);
    store.command(key, roomId, {
      id: `account-delete-leave-${createHash("sha256").update(`${roomId}:${memberId}:${accountId}`).digest("hex").slice(0, 32)}`,
      type: EVENT_TYPES.MEMBER_ACCESS_CHANGED,
      data: { memberId, expectedMemberRevision: member.revision, permissions: member.permissions, active: false },
    });
  }
}

// One purge executor per inventory category. Each returns the number of
// rows removed. The "profile" step runs last (planner priority 100): it
// scrubs the account row and deactivates it, which also retires any
// credential the earlier steps somehow missed via the auth-epoch check.
const EXECUTORS = {
  credentials: (store, accountId) =>
    store.db.prepare("DELETE FROM account_credentials WHERE account_id=?").run(accountId).changes,
  // A slot that redeemed a share link is referenced by share_link_joins, which is
  // immutable history (no UPDATE/DELETE) with a foreign key to the slot. Deleting
  // it 500s (FOREIGN KEY constraint failed) for every account that joined via a
  // link. Same rule as sign-out: delete unreferenced slots, and leave the
  // referenced ones as expired, unauthenticated tombstones that cannot resolve
  // or authenticate again while the historical receipt stays valid.
  sessions: (store, accountId) => {
    const db = store.db, now = typeof store.now === "function" ? store.now() : Date.now();
    const kept = db.prepare(`UPDATE account_session_slots SET revision=revision+1,account_id=NULL,account_auth_epoch=NULL,
      parent_credential_hash=NULL,authenticated_until=NULL,expires_at=?
      WHERE account_id=? AND EXISTS (SELECT 1 FROM share_link_joins WHERE slot_hash=account_session_slots.hash)`).run(now, accountId).changes;
    return kept + db.prepare("DELETE FROM account_session_slots WHERE account_id=?").run(accountId).changes;
  },
  login_methods: (store, accountId) => {
    let removed = 0;
    for (const table of ["account_login_methods", "account_magic_codes", "account_recovery_codes", "account_security_events"]) {
      removed += store.db.prepare(`DELETE FROM ${table} WHERE account_id=?`).run(accountId).changes;
    }
    return removed;
  },
  passkeys: (store, accountId) =>
    store.db.prepare("DELETE FROM account_passkey_credentials WHERE account_id=?").run(accountId).changes,
  // bug-deleted-account-member-stays-active-20261010: dropping the binding
  // alone left the room member active, so the roster kept the deleted
  // person and their display name stayed reserved. Each bound member is
  // deactivated first, as a self-leave through the event-sourced path.
  // Owners are skipped (owned_rooms archives or transfers those rooms).
  memberships: (store, accountId) => {
    deactivateBoundMembers(store, accountId);
    return store.db.prepare("DELETE FROM member_accounts WHERE account_id=?").run(accountId).changes;
  },
  connected_data: (store, accountId) => {
    let removed = 0;
    for (const table of ["gmail_mailboxes", "gmail_linked_mailboxes", "gmail_pending", "gmail_operations", "account_setup"]) {
      removed += store.db.prepare(`DELETE FROM ${table} WHERE account_id=?`).run(accountId).changes;
    }
    return removed;
  },
  // QA2-SECREG: account_terms was missing from self-serve deletion — the
  // terms acceptance row survived account deletion. Purged like every
  // other per-account row. public_unpublish and public_abuse_reports stay
  // retained (see RETENTION_POLICY): they are safety records, not account data.
  terms: (store, accountId) =>
    store.db.prepare("DELETE FROM account_terms WHERE account_id=?").run(accountId).changes,
  // QA slice D (2026-10-04): private inbox content survived account deletion.
  // private_inbox_versions carries no-delete/no-update triggers (immutability
  // for the sync protocol); account deletion is the one sanctioned exception,
  // so the triggers are dropped and recreated inside this transaction.
  private_inbox: (store, accountId) => {
    const db = store.db;
    let removed = 0;
    removed += db.prepare("DELETE FROM private_inbox_drafts WHERE account_id=?").run(accountId).changes;
    removed += db.prepare("DELETE FROM private_inbox_reads WHERE account_id=?").run(accountId).changes;
    const triggers = ["private_inbox_versions_no_delete", "private_inbox_versions_no_update"]
      .filter(name => db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name));
    for (const name of triggers) db.exec(`DROP TRIGGER ${name}`);
    try {
      removed += db.prepare("DELETE FROM private_inbox_versions WHERE account_id=?").run(accountId).changes;
      removed += db.prepare("DELETE FROM private_inbox_sources WHERE account_id=?").run(accountId).changes;
    } finally {
      if (triggers.includes("private_inbox_versions_no_update")) db.exec("CREATE TRIGGER private_inbox_versions_no_update BEFORE UPDATE ON private_inbox_versions BEGIN SELECT RAISE(ABORT,'source versions are immutable'); END");
      if (triggers.includes("private_inbox_versions_no_delete")) db.exec("CREATE TRIGGER private_inbox_versions_no_delete BEFORE DELETE ON private_inbox_versions BEGIN SELECT RAISE(ABORT,'source versions are retained'); END");
    }
    return removed;
  },
  private_email: (store, accountId) => {
    const db = store.db;
    let removed = 0;
    removed += db.prepare("DELETE FROM private_email_folders WHERE account_id=?").run(accountId).changes;
    removed += db.prepare("DELETE FROM private_email_connections WHERE account_id=?").run(accountId).changes;
    return removed;
  },
  stitch: (store, accountId) => {
    const db = store.db;
    let removed = 0;
    for (const table of ["stitch_revocations", "stitch_receipts", "stitch_suggestions", "stitch_links", "stitch_identities"]) {
      removed += db.prepare(`DELETE FROM ${table} WHERE account_id=?`).run(accountId).changes;
    }
    return removed;
  },
  // SEC-04: delete account-keyed inbox and channel rows. Tables are created
  // by their own modules, so skip any table this store does not have.
  derived_inbox: (store, accountId) => {
    const db = store.db;
    let removed = 0;
    for (const table of DERIVED_INBOX_TABLES) {
      if (tableExists(db, table)) removed += db.prepare(`DELETE FROM ${table} WHERE account_id=?`).run(accountId).changes;
    }
    return removed;
  },
  // SEC-04: revoke, never delete. Runs before memberships (priority 47 < 50)
  // so the member bindings still exist.
  member_issued_invites: (store, accountId) => {
    const db = store.db;
    const now = typeof store.now === "function" ? store.now() : Date.now();
    const agent = tableExists(db, "agent_invite_codes")
      ? db.prepare("UPDATE agent_invite_codes SET revoked_at=? WHERE room_id=? AND created_by=? AND redeemed_at IS NULL AND revoked_at IS NULL")
      : null;
    const referral = tableExists(db, "referral_invites")
      ? db.prepare("UPDATE referral_invites SET status='rejected', rejected_at=?, reject_reason='inviter_account_deleted' WHERE room_id=? AND inviter_member_id=? AND status='minted'")
      : null;
    let revoked = 0;
    for (const { room_id: roomId, member_id: memberId } of memberBindings(store, accountId)) {
      if (agent) revoked += agent.run(now, roomId, memberId).changes;
      if (referral) revoked += referral.run(now, roomId, memberId).changes;
    }
    return revoked;
  },
  // Revoke, never delete: invite/link history stays for audit, but nothing
  // issued by a deleted account may still grant access.
  issued_access: (store, accountId) => {
    const db = store.db;
    const now = typeof store.now === "function" ? store.now() : Date.now();
    let revoked = 0;
    revoked += db.prepare("UPDATE guest_invites SET status='revoked' WHERE minted_by_account_id=? AND status='active'").run(accountId).changes;
    // share_link_scope_immutable forbids touching scope columns; revoked_at /
    // revoked_by_member_id are outside it. Self-revocation attribution.
    revoked += db.prepare("UPDATE share_links SET revoked_at=?, revoked_by_member_id=issuer_member_id WHERE issuer_account_id=? AND revoked_at IS NULL").run(now, accountId).changes;
    revoked += store.revokePendingInvitationsForAccount(accountId);
    return revoked;
  },
  sponsored_agents: (store, accountId) => {
    // revokeAccount returns nothing; count the live credentials it retires.
    const db = store.db;
    const live = db.prepare("SELECT count(*) AS n FROM credentials WHERE revoked=0 AND hash IN (SELECT credential_hash FROM agent_connections WHERE sponsor_account_id=?)").get(accountId)?.n ?? 0;
    store.agentConnections.revokeAccount(accountId);
    return live;
  },
  // Third-party connector grants: delete the durable rows directly so no
  // provider instance needs to be threaded through the deletion planner.
  // The provider's isAccountActive check (below) is the second layer.
  oauth_tokens: (store, accountId) => {
    let removed = 0;
    for (const table of ["oauth_provider_codes", "oauth_provider_access_tokens", "oauth_provider_refresh_tokens"]) {
      removed += deleteWhereIfExists(store, table, "user_id", accountId);
    }
    return removed;
  },
  analytics: (store, accountId) =>
    deleteWhereIfExists(store, "analytics_events", "account_id", accountId),
  profile: (store, accountId) => {
    return store.db.prepare(`UPDATE accounts SET active=0, auth_epoch=auth_epoch+1,
      display_name=NULL, avatar_url=NULL, onboarded=1 WHERE id=?`).run(accountId).changes;
  },
  owned_rooms: (store, accountId, plan) => disposeOwnedRooms(store, plan),
};

// Execute a validated plan inside one transaction: every PURGE step runs
// its executor in planner order; RETAIN steps are reported, never run.
export function executeAccountDeletion(store, plan) {
  const check = validatePurgePlan(plan);
  if (!check.valid) fail(422, "invalid_purge_plan", `Purge plan failed validation: ${check.errors.join("; ")}`);
  if (plan.accountId == null) fail(422, "invalid_purge_plan", "Purge plan is not attributable to an account");
  if (plan.rooms?.blocked?.length) refuseOwnershipTransfer(plan.rooms.blocked);
  return store.transaction(() => {
    const purged = [];
    for (const step of plan.steps) {
      if (step.action !== ACTIONS.PURGE) continue;
      const executor = EXECUTORS[step.category];
      if (!executor) fail(422, "unknown_purge_category", `No purge executor for category "${step.category}"`);
      purged.push({ category: step.category, removed: executor(store, plan.accountId, plan) });
    }
    return {
      accountId: plan.accountId,
      purged,
      retained: plan.steps
        .filter(step => step.action === ACTIONS.RETAIN)
        .map(step => ({ category: step.category, reason: step.reason ?? DEFAULT_LEGAL_HOLD_REASON })),
    };
  });
}

// ---- Confirm-then-delete tokens ----
//
// The plan endpoint signs a short-lived token bound to (accountId, plan
// digest). The delete endpoint re-plans from the live store and verifies
// the token against the fresh plan: data that changed after confirmation
// 409s as plan_changed instead of deleting something unconfirmed.

const TOKEN_TTL_MS = 10 * 60 * 1000;

const planDigest = plan => createHash("sha256").update(JSON.stringify({
  steps: plan.steps,
  rooms: plan.rooms ?? null,
})).digest("hex");

export function createDeletionSecret() {
  return randomBytes(32);
}

export function issueDeletionToken(secret, accountId, plan, { now = Date.now, ttlMs = TOKEN_TTL_MS } = {}) {
  if (plan.accountId !== accountId) fail(422, "invalid_purge_plan", "Purge plan is not attributable to this account");
  const payload = JSON.stringify({ accountId, digest: planDigest(plan), exp: now() + ttlMs });
  const signature = createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${signature}`;
}

export function verifyDeletionToken(secret, accountId, plan, token, { now = Date.now } = {}) {
  const invalid = () => fail(401, "invalid_confirmation", "That deletion confirmation is not valid; request a fresh plan");
  if (typeof token !== "string" || !token.includes(".")) invalid();
  const [encoded, signature] = token.split(".");
  let payload;
  try {
    payload = Buffer.from(encoded, "base64url").toString("utf8");
  } catch { invalid(); }
  const expected = createHmac("sha256", secret).update(payload, "utf8").digest();
  let presented;
  try {
    presented = Buffer.from(signature, "hex");
  } catch { invalid(); }
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) invalid();
  let claims;
  try {
    claims = JSON.parse(payload);
  } catch { invalid(); }
  if (claims?.accountId !== accountId || typeof claims?.exp !== "number" || claims.exp <= now()) invalid();
  if (claims.digest !== planDigest(plan) || plan.accountId !== accountId) {
    fail(409, "plan_changed", "Account data changed after the deletion plan was confirmed; request a fresh plan");
  }
  return true;
}
