// Consent-bound direct messages.
//
// DMs travel as message.posted events with data.toMemberId (see
// RC-2026-09-18-012 in server/store.mjs). This module adds the consent
// layer on top of that transport: nobody may DM a member who has not
// approved them, in that direction.
//
// Model: one row per (room, requester → target) direction. Consent is
// directional, with one implication: when B approves A's request, A asked
// for the conversation, so B may answer A without asking A back. That
// answer path lives only as long as A → B stays approved; any explicit row
// in the B → A direction (pending, rejected, revoked, blocked) still wins.
// States:
//   pending  — requester asked, target has not decided
//   approved — target approved; DMs flow requester → target
//   rejected — target declined; requester may ask again
//   blocked  — target blocked; requester may not ask again (until unblocked)
//   revoked  — consent was approved, then either party revoked it;
//              forward-looking only: history stays readable, new DMs need a
//              fresh request
//
// Visibility: consent rows live in this side table, never as room events,
// so there are no room-visible indicators of DM activity. Participants see
// their own pairs; the room owner sees every pair's metadata (handles +
// status + timestamps) for moderation — never message contents (contents
// are not stored here at all).
//
// The module is storage-shaped like AccessRequests/ShareLinks: it takes the
// RoomStore (db handle, transactions, room state) and exports its schema
// for store.mjs to apply. Local ServiceError avoids the store.mjs import
// cycle (Workers-bundle-safe).
import { enforceAutonomyTierForAction } from "./autonomy-tiers.mjs";
import { randomUUID } from "node:crypto";
import { EVENT_TYPES as T } from "../src/events.js";

class ServiceError extends Error {
  constructor(status, code, message, headers = null) { super(message); this.status = status; this.code = code; this.headers = headers; }
}

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

export const dmConsentSchema = `
  CREATE TABLE IF NOT EXISTS dm_consents (
    room_id TEXT NOT NULL,
    requester_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','blocked','revoked')),
    reason TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    decided_at INTEGER,
    PRIMARY KEY (room_id, requester_id, target_id)
  );
  CREATE INDEX IF NOT EXISTS dm_consents_target ON dm_consents(room_id, target_id, status);
  CREATE INDEX IF NOT EXISTS dm_consents_requester ON dm_consents(room_id, requester_id, status);
`;

export const DM_CONSENT_STATUSES = Object.freeze(["pending", "approved", "rejected", "blocked", "revoked"]);
export const DM_CONSENT_DECISIONS = Object.freeze(["approve", "reject", "block"]);
export const MAX_DM_REASON_CHARS = 500;

const nowMs = () => Date.now();

const rowToPair = row => row ? Object.freeze({
  roomId: row.room_id,
  requesterId: row.requester_id,
  targetId: row.target_id,
  status: row.status,
  reason: row.reason,
  createdAt: row.created_at,
  decidedAt: row.decided_at
}) : null;

export class DmConsents {
  constructor(store) {
    if (!store || !store.db) fail(500, "dm_store_missing", "DmConsents requires a store with a db handle");
    this.store = store;
    this.db = store.db;
  }

  // ---- internals -------------------------------------------------------
  _roomState(roomId) {
    const room = this.store.room(roomId);
    if (!room) fail(404, "room_not_found", "No such room");
    return room.state;
  }

  _activeMember(state, memberId) {
    const member = state?.members?.[memberId];
    return member && member.active !== false ? member : null;
  }

  _requireActiveMember(state, memberId, code = "member_not_found") {
    const member = this._activeMember(state, memberId);
    if (!member) fail(404, code, "No such active member in this room");
    return member;
  }

  _get(roomId, requesterId, targetId) {
    return this.db.prepare(
      "SELECT * FROM dm_consents WHERE room_id=? AND requester_id=? AND target_id=?"
    ).get(roomId, requesterId, targetId);
  }

  _handleOf(state, memberId) {
    const member = state?.members?.[memberId];
    if (!member) return null;
    const name = typeof member.displayName === "string" && member.displayName.trim()
      ? member.displayName.trim() : memberId;
    return name;
  }

  _isOwner(state, memberId) {
    return memberId === state?.room?.ownerId;
  }

  // ---- pair receipt ------------------------------------------------------
  // Consent rows bypass store.command(), so this module appends its own
  // thin receipt event (dm.consent_changed) through the store's side-table
  // append rail, in the caller's transaction. A throw rolls the consent row
  // change back with the event. New/restarted pending states, decisions,
  // revokes, blocks and unblocks append: a pending re-ask with an updated
  // reason is a refresh of the same outreach, not new state, so it does not
  // log again. Revoke/block/unblock append because live refresh on the other
  // participant's screen is driven by these receipts.
  _appendPairEvent(roomId, actorId, requesterId, targetId, status, reason = "") {
    this.store.appendSideTableEvent(roomId, {
      id: randomUUID(),
      idempotencyKey: randomUUID(),
      roomId,
      type: T.DM_CONSENT_CHANGED,
      actorId,
      at: new Date(nowMs()).toISOString(),
      data: { requesterId, targetId, status }
    });
  }

  // ---- request ----------------------------------------------------------
  // requesterId asks targetId for DM consent with an optional reason.
  // Idempotent-ish: a live pending/approved row is returned as-is (409 for
  // approved, 200 for pending re-ask with updated reason); rejected/revoked
  // rows restart at pending; blocked rows refuse with 403.
  request(roomId, requesterId, targetId, reason = "") {
    if (typeof roomId !== "string" || !roomId) fail(422, "invalid_dm_request", "roomId is required");
    if (typeof requesterId !== "string" || !requesterId) fail(422, "invalid_dm_request", "requesterId is required");
    if (typeof targetId !== "string" || !targetId) fail(422, "invalid_dm_request", "targetMemberId is required");
    if (requesterId === targetId) fail(422, "invalid_dm_request", "You do not need consent to message yourself");
    if (typeof reason !== "string") fail(422, "invalid_dm_request", "reason must be text");
    const cleanReason = reason.trim().slice(0, MAX_DM_REASON_CHARS);

    return this.store.transaction(() => {
      const state = this._roomState(roomId);
      const requester = this._requireActiveMember(state, requesterId, "requester_not_found");
      this._requireActiveMember(state, targetId, "target_not_found");
      // Issue #995: a DM request is new outbound contact, and this write
      // bypasses store.command(), so the command-hook tier gate never sees
      // it. A t1_readonly agent may not initiate; the protective actions
      // below (decide/block/revoke/unblock) stay open because they only
      // protect the caller.
      enforceAutonomyTierForAction({
        db: this.db, roomId, state, actor: { id: requesterId, kind: requester.kind },
        action: "dm_consent_request", fail,
      });
      const existing = this._get(roomId, requesterId, targetId);
      if (existing) {
        if (existing.status === "blocked") fail(403, "dm_blocked", "This member is not accepting DM requests from you");
        if (existing.status === "approved") fail(409, "dm_already_approved", "DM consent is already approved for this direction");
        if (existing.status === "pending") {
          this.db.prepare(
            "UPDATE dm_consents SET reason=?, created_at=? WHERE room_id=? AND requester_id=? AND target_id=?"
          ).run(cleanReason, nowMs(), roomId, requesterId, targetId);
          return rowToPair(this._get(roomId, requesterId, targetId));
        }
        // rejected | revoked → fresh request
        this.db.prepare(
          "UPDATE dm_consents SET status='pending', reason=?, created_at=?, decided_at=NULL WHERE room_id=? AND requester_id=? AND target_id=?"
        ).run(cleanReason, nowMs(), roomId, requesterId, targetId);
        this._appendPairEvent(roomId, requesterId, requesterId, targetId, "pending", cleanReason);
        return rowToPair(this._get(roomId, requesterId, targetId));
      }
      const at = nowMs();
      this.db.prepare(
        "INSERT INTO dm_consents (room_id, requester_id, target_id, status, reason, created_at, decided_at) VALUES (?,?,?,?,?,?,NULL)"
      ).run(roomId, requesterId, targetId, "pending", cleanReason, at);
      this._appendPairEvent(roomId, requesterId, requesterId, targetId, "pending", cleanReason);
      return rowToPair(this._get(roomId, requesterId, targetId));
    });
  }

  // ---- decide ------------------------------------------------------------
  // Only the target decides on a pending request.
  decide(roomId, targetId, requesterId, decision) {
    if (!DM_CONSENT_DECISIONS.includes(decision)) fail(422, "invalid_dm_decision", "decision must be approve, reject, or block");
    return this.store.transaction(() => {
      const state = this._roomState(roomId);
      this._requireActiveMember(state, targetId, "target_not_found");
      this._requireActiveMember(state, requesterId, "requester_not_found");
      const existing = this._get(roomId, requesterId, targetId);
      if (!existing || existing.status !== "pending") fail(409, "dm_no_pending_request", "There is no pending DM request in this direction");
      const status = decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "blocked";
      this.db.prepare(
        "UPDATE dm_consents SET status=?, decided_at=? WHERE room_id=? AND requester_id=? AND target_id=?"
      ).run(status, nowMs(), roomId, requesterId, targetId);
      this._appendPairEvent(roomId, targetId, requesterId, targetId, status);
      return rowToPair(this._get(roomId, requesterId, targetId));
    });
  }

  // ---- revoke -------------------------------------------------------------
  // Either participant may unilaterally revoke an approved consent.
  // Forward-looking: past messages stay readable.
  revoke(roomId, memberId, otherId) {
    if (typeof otherId !== "string" || !otherId) fail(422, "invalid_dm_request", "otherMemberId is required");
    return this.store.transaction(() => {
      const state = this._roomState(roomId);
      this._requireActiveMember(state, memberId, "member_not_found");
      const forward = this._get(roomId, memberId, otherId);
      const backward = this._get(roomId, otherId, memberId);
      const live = [forward, backward].filter(r => r && r.status === "approved");
      if (live.length === 0) fail(409, "dm_nothing_to_revoke", "There is no approved DM consent between these members");
      // Revoke every approved directional row: with both directions
      // approved, revoking only one would leave the other live,
      // contradicting the "unilaterally revoke" contract.
      this.db.prepare(
        "UPDATE dm_consents SET status='revoked', decided_at=? WHERE room_id=? AND status='approved' AND ((requester_id=? AND target_id=?) OR (requester_id=? AND target_id=?))"
      ).run(nowMs(), roomId, memberId, otherId, otherId, memberId);
      for (const row of live) {
        this._appendPairEvent(roomId, memberId, row.requester_id, row.target_id, "revoked");
      }
      return rowToPair(this._get(roomId, live[0].requester_id, live[0].target_id));
    });
  }

  // ---- unblock --------------------------------------------------------------
  // Only the target that blocked may unblock. The row returns to rejected:
  // history is kept, and the requester may ask again.
  unblock(roomId, targetId, requesterId) {
    return this.store.transaction(() => {
      const state = this._roomState(roomId);
      this._requireActiveMember(state, targetId, "target_not_found");
      const existing = this._get(roomId, requesterId, targetId);
      if (!existing || existing.status !== "blocked") fail(409, "dm_not_blocked", "This member is not blocked");
      this.db.prepare(
        "UPDATE dm_consents SET status='rejected', decided_at=? WHERE room_id=? AND requester_id=? AND target_id=?"
      ).run(nowMs(), roomId, requesterId, targetId);
      this._appendPairEvent(roomId, targetId, requesterId, targetId, "rejected");
      return rowToPair(this._get(roomId, requesterId, targetId));
    });
  }

  // ---- block ----------------------------------------------------------------
  // Proactive block: blockerId refuses DMs from blockedId without waiting
  // for a pending request. Recorded as (blockedId → blockerId, 'blocked')
  // so the request path's 403 dm_blocked refusal applies and the requester
  // cannot ask again until unblocked. Directional: the reverse direction
  // (blocker → blocked) is untouched. Idempotent on an existing block.
  block(roomId, blockerId, blockedId) {
    if (typeof blockedId !== "string" || !blockedId) fail(422, "invalid_dm_block", "blockedMemberId is required");
    if (blockerId === blockedId) fail(422, "invalid_dm_block", "You cannot block yourself");
    return this.store.transaction(() => {
      const state = this._roomState(roomId);
      this._requireActiveMember(state, blockerId, "member_not_found");
      this._requireActiveMember(state, blockedId, "blocked_not_found");
      const existing = this._get(roomId, blockedId, blockerId);
      const at = nowMs();
      if (existing) {
        if (existing.status === "blocked") return rowToPair(existing);
        this.db.prepare(
          "UPDATE dm_consents SET status='blocked', decided_at=? WHERE room_id=? AND requester_id=? AND target_id=?"
        ).run(at, roomId, blockedId, blockerId);
        this._appendPairEvent(roomId, blockerId, blockedId, blockerId, "blocked");
      } else {
        this.db.prepare(
          "INSERT INTO dm_consents (room_id, requester_id, target_id, status, reason, created_at, decided_at) VALUES (?,?,?,'blocked','',?,?)"
        ).run(roomId, blockedId, blockerId, at, at);
        this._appendPairEvent(roomId, blockerId, blockedId, blockerId, "blocked");
      }
      return rowToPair(this._get(roomId, blockedId, blockerId));
    });
  }

  // ---- read -----------------------------------------------------------------
  // list: participants see pairs involving them (both directions); the room
  // owner additionally sees every pair's metadata for moderation. Rows carry
  // display handles for rendering plus the authoritative member ids, because
  // display names are not unique per room and browser actions must never
  // guess an ambiguous target. Member ids are not a new disclosure: every
  // room member already sees them in presence and message events.
  list(roomId, viewerId) {
    const state = this._roomState(roomId);
    this._requireActiveMember(state, viewerId, "viewer_not_found");
    const owner = this._isOwner(state, viewerId);
    const rows = owner
      ? this.db.prepare("SELECT * FROM dm_consents WHERE room_id=? ORDER BY created_at DESC").all(roomId)
      : this.db.prepare(
        "SELECT * FROM dm_consents WHERE room_id=? AND (requester_id=? OR target_id=?) ORDER BY created_at DESC"
      ).all(roomId, viewerId, viewerId);
    return Object.freeze(rows.map(row => Object.freeze({
      requester: this._handleOf(state, row.requester_id),
      target: this._handleOf(state, row.target_id),
      requesterId: row.requester_id,
      targetId: row.target_id,
      status: row.status,
      reason: row.reason,
      createdAt: row.created_at,
      decidedAt: row.decided_at,
      outgoing: row.requester_id === viewerId
    })));
  }

  // pendingFor: incoming pending requests for a member (agentInbox surface).
  pendingFor(roomId, memberId) {
    const state = this._roomState(roomId);
    this._requireActiveMember(state, memberId, "member_not_found");
    const rows = this.db.prepare(
      "SELECT * FROM dm_consents WHERE room_id=? AND target_id=? AND status='pending' ORDER BY created_at ASC"
    ).all(roomId, memberId);
    return Object.freeze(rows.map(row => Object.freeze({
      requester: this._handleOf(state, row.requester_id),
      requesterId: row.requester_id,
      reason: row.reason,
      at: row.created_at,
      // RC-2026-09-24-001: the approver needs the authoritative requester id
      // and the decide path — display handles are not unique per room and the
      // decide endpoint is otherwise undiscoverable (F-13 dogfood).
      decide: Object.freeze({
        method: "POST",
        path: `/api/rooms/${roomId}/dm-consents/${row.requester_id}/decide`,
        description: "Approve, reject, or block this request: send { decision: \"approve\" } (or \"reject\" / \"block\"). Only the target decides; a reverse POST creates a duplicate pending row instead of approving."
      })
    })));
  }

  // ---- enforcement ------------------------------------------------------------
  // requireDmAllowed: DMs are open by default (2026-09-24 standing rule).
  // Throws 403 only when the recipient has EXPLICITLY denied this direction
  // (blocked, rejected, or revoked). No row, pending, or approved all allow:
  // nobody needs permission to start a conversation; abuse is handled with
  // block/mute, per-pair rate limits, and journal accountability.
  // Self-DMs are always allowed.
  requireDmAllowed(roomId, requesterId, targetId) {
    if (requesterId === targetId) return true;
    return this.store.transaction(() => {
      // NB: no member-active check here — an inactive recipient (or
      // requester) is rejected downstream by message posting ("Member
      // access revoked"), preserving that long-standing error contract.
      const existing = this._get(roomId, requesterId, targetId);
      if (existing) {
        if (existing.status === "blocked") {
          fail(403, "dm_blocked", "This member is not accepting direct messages from you");
        }
        if (existing.status === "rejected" || existing.status === "revoked") {
          fail(403, "dm_consent_required",
            "This member declined direct messages from you — ask in the room or have them unblock you");
        }
        // approved or pending: an explicit or default-open direction allows.
      }
      // No row, or a non-denying row: DMs are open by default.
      return true;
    });
  }

}
