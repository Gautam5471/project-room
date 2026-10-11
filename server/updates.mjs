// One projection of "what needs me now?" over the journals that already exist.
// There is no second queue and no handled flag on those records. Read, done,
// and clear are private marks keyed to the source revision; a new revision
// or clarification stops matching the mark and the item is actionable again.
// Answered comes from a reply linked to the request, or from a mention the
// reply journal already moved to responded. Handled also comes from a wake
// the member already acked. Claim signals stay behind claimAttentionFromEvents
// and are empty until a work_claim.updated event carries an attention field.

import { createHash } from "node:crypto";
import { ServiceError } from "./store.mjs";
import { nextWorkStep } from "../src/workflow.js";
import { validId } from "../src/events.js";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
const ACTIONABLE = new Set(["unread", "read"]);
export const UPDATE_KINDS = Object.freeze([
  "request", "mention", "dm", "review_requested", "handoff",
  "claim_lease_expiring", "claim_ci_failed", "claim_changes_requested",
  "invite_pending", "access_request", "agent_joined"
]);
const CLAIM_ATTENTION = Object.freeze({
  lease_expiring: "claim_lease_expiring",
  ci_failed: "claim_ci_failed",
  changes_requested: "claim_changes_requested"
});
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
export const updatesSchema = `
  CREATE TABLE IF NOT EXISTS private_update_marks (
    room_id TEXT NOT NULL, member_id TEXT NOT NULL, item_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('read','done','clear')),
    basis TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(room_id, member_id, item_id)
  );
  CREATE TABLE IF NOT EXISTS private_update_commands (
    room_id TEXT NOT NULL, member_id TEXT NOT NULL, request_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, response TEXT NOT NULL,
    PRIMARY KEY(room_id, member_id, request_id)
  );
`;

const clip = text => {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > 140 ? `${value.slice(0, 139)}…` : value;
};
const iso = value => {
  const ms = typeof value === "number" ? value : Date.parse(value ?? "");
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date(0).toISOString();
};
const itemIdOf = (kind, key) => `upd_${createHash("sha256").update(`${kind}|${key}`).digest("hex").slice(0, 20)}`;
const encode = value => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
// An observed source precondition, not a credential or an authorization grant.
// Keep the old fingerprint only for exact pre-upgrade committed receipt retries.
const basisTokenOf = item => `ub1_${createHash("sha256").update(JSON.stringify([1, item.roomId, item.id, item.basis])).digest("hex")}`;
const validBasis = value => typeof value === "string" && /^ub1_[a-f0-9]{64}$/.test(value);
const fingerprintOf = (action, itemId, requestId, expectedBasis) => createHash("sha256")
  .update(expectedBasis === undefined ? `${action}|${itemId}|${requestId}`
    : JSON.stringify([1, action, itemId, requestId, expectedBasis])).digest("hex");

function ensureSchema(store) {
  if (store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='private_update_marks'").get()) return true;
  if (store.db.isTransaction) return false;
  store.transaction(() => store.db.exec(updatesSchema));
  return true;
}

function marksFor(store, roomId, memberId) {
  if (!ensureSchema(store)) return new Map();
  try {
    const rows = store.db.prepare(
      "SELECT item_id AS itemId, action, basis FROM private_update_marks WHERE room_id=? AND member_id=?"
    ).all(roomId, memberId);
    return new Map(rows.map(row => [row.itemId, row]));
  } catch (error) {
    if (/no such table/i.test(error?.message ?? "")) return new Map();
    throw error;
  }
}

function tableMissing(error) {
  return /no such table/i.test(error?.message ?? "");
}

// Board batch: work_claim.updated.data.attention is lease_expiring, ci_failed,
// or changes_requested. Events without that field contribute nothing.
export function claimAttentionFromEvents(events, memberId) {
  const items = [];
  for (const event of events ?? []) {
    if (event?.type !== "work_claim.updated") continue;
    const data = event.data ?? {};
    const kind = CLAIM_ATTENTION[data.attention];
    if (!kind) continue;
    const who = data.attentionMemberId ?? data.ownerId;
    if (who !== memberId) continue;
    const claimId = typeof data.workClaim === "string" ? data.workClaim : "";
    if (!claimId) continue;
    const at = iso(event.at);
    items.push(draft({
      kind, roomId: event.roomId, key: `${kind}|${claimId}|${data.attention}`,
      title: clip(data.title || claimId), actor: event.actorId ?? null,
      createdAt: at, updatedAt: at, basis: `${data.attention}|${event.id ?? at}`,
      sourceRef: { claimId },
      next: { method: "GET", path: `/api/rooms/${encodeURIComponent(event.roomId)}/work-claims/${encodeURIComponent(claimId)}` }
    }));
  }
  return items;
}

function draft(fields) {
  return {
    id: itemIdOf(fields.kind, fields.key),
    roomId: fields.roomId,
    kind: fields.kind,
    title: fields.title,
    sourceRef: fields.sourceRef,
    actor: fields.actor ?? null,
    createdAt: fields.createdAt,
    updatedAt: fields.updatedAt,
    basis: fields.basis,
    terminal: fields.terminal ?? null,
    untrusted: true,
    next: fields.next ?? null
  };
}

function sourceState(item, mark, wakes) {
  const marked = mark && mark.basis === item.basis ? mark.action : null;
  if (marked === "clear") return "cleared";
  if (item.terminal === "answered") return "answered";
  if (item.terminal === "cleared") return "cleared";
  if (marked === "done") return "handled";
  const wake = wakes.get(item.id) ?? wakes.get(item.sourceRef.requestId) ?? wakes.get(item.sourceRef.messageId)
    ?? wakes.get(item.sourceRef.claimId) ?? wakes.get(item.sourceRef.workItemId);
  if (wake && wake >= Date.parse(item.updatedAt)) return "handled";
  if (marked === "read" || item.terminal === "read") return "read";
  return "unread";
}

function ackedWakes(store, roomId, memberId, flags) {
  const wakes = new Map();
  try {
    const rows = store.db.prepare(
      "SELECT intent, updated_at AS updatedAt FROM wake_queue WHERE room_id=? AND member_id=? AND state='done'"
    ).all(roomId, memberId);
    for (const row of rows) {
      let intent = {};
      try { intent = JSON.parse(row.intent); } catch { continue; }
      const ids = [intent.itemId, intent.messageId, intent.requestId, intent.claimId, intent.workItemId, intent.updateId, intent.queueKey];
      for (const id of ids) if (typeof id === "string" && id) wakes.set(id, row.updatedAt);
    }
  } catch (error) {
    if (!tableMissing(error)) throw error;
    flags.wakes = true;
  }
  return wakes;
}

function projectRoom(store, roomId, memberId, identityId) {
  const flags = { mentions: false, peerDms: false, claims: false, invites: false, accessRequests: false, wakes: false };
  const room = store.room(roomId);
  const state = room.state;
  const member = state.members?.[memberId];
  if (!member || member.active === false) return { items: [], flags, skipped: true };
  const ownerId = state.room?.ownerId ?? null;
  const owner = memberId === ownerId;
  const now = store.now();
  const items = [];
  const requests = state.replyRequests ?? {};
  const messages = state.messages ?? [];
  const byId = new Map(messages.map(message => [message.id, message]));

  for (const request of Object.values(requests)) {
    if (!request || request.recipientId !== memberId) continue;
    const latest = byId.get(request.contextMessageId) ?? byId.get(request.id);
    // Same rule as reply-context (server/reply-requests.mjs): a private message is
    // visible only to its author and recipient, so never echo it as the title.
    const context = latest?.toMemberId && latest.authorId !== memberId && latest.toMemberId !== memberId ? null : latest;
    const updatedAt = iso(context?.createdAt ?? request.closedAt ?? request.createdAt);
    const terminal = request.status === "answered" || request.status === "declined" ? "answered"
      : request.status === "cancelled" ? "cleared" : null;
    items.push(draft({
      kind: "request", roomId, key: `request|${request.id}`,
      title: clip(context?.body || `Reply requested by ${request.requesterId}`),
      actor: request.requesterId, createdAt: iso(request.createdAt), updatedAt,
      basis: `${request.status}|${request.revision}|${request.contextEventId ?? ""}`,
      sourceRef: { requestId: request.id, ...(request.workItemId ? { workItemId: request.workItemId } : {}) },
      terminal,
      next: { method: "GET", path: `/api/rooms/${encodeURIComponent(roomId)}/reply-context?requestMessageId=${encodeURIComponent(request.id)}` }
    }));
  }

  const requestIds = new Set(Object.keys(requests));
  try {
    const rows = store.db.prepare(
      `SELECT m.message_event_id AS messageEventId, m.state, m.created_at AS createdAt,
              json_extract(e.body,'$.actorId') AS actorId, json_extract(e.body,'$.data.messageId') AS messageId,
              json_extract(e.body,'$.data.body') AS body
       FROM mention_states m JOIN events e ON e.room_id=m.room_id AND e.id=m.message_event_id
       WHERE m.room_id=? AND m.mentioned_member_id=? AND json_extract(e.body,'$.type')='message.posted'`
    ).all(roomId, memberId);
    for (const row of rows) {
      const messageId = row.messageId || row.messageEventId;
      if (requestIds.has(messageId)) continue;
      const terminal = row.state === "responded" ? "answered" : row.state === "acknowledged" ? "read" : null;
      const at = iso(row.createdAt);
      items.push(draft({
        kind: "mention", roomId, key: `mention|${messageId}`,
        title: clip(row.body || "Mentioned you"), actor: row.actorId, createdAt: at, updatedAt: at,
        basis: `${row.state}|${messageId}`,
        sourceRef: { messageId }, terminal,
        next: { method: "GET", path: `/api/rooms/${encodeURIComponent(roomId)}/events?after=0` }
      }));
    }
  } catch (error) {
    if (!tableMissing(error)) throw error;
    flags.mentions = true;
  }

  const replied = new Set(messages.filter(message => message.authorId === memberId && message.replyToId).map(message => message.replyToId));
  for (const message of messages) {
    if (!message || message.toMemberId !== memberId || message.authorId === memberId) continue;
    if (requestIds.has(message.id)) continue;
    const at = iso(message.createdAt);
    items.push(draft({
      kind: "dm", roomId, key: `dm|${message.id}`,
      title: clip(message.body || "Direct message"), actor: message.authorId, createdAt: at, updatedAt: at,
      basis: message.id, sourceRef: { messageId: message.id },
      terminal: replied.has(message.id) ? "answered" : null,
      next: { method: "POST", path: `/api/rooms/${encodeURIComponent(roomId)}/commands` }
    }));
  }

  if (identityId) {
    try {
      const rows = store.db.prepare(
        `SELECT message_id AS messageId, body, created_at AS createdAt, from_identity_id AS actorId
         FROM peer_dm_messages WHERE to_identity_id=? AND room_id=?`
      ).all(identityId, roomId);
      for (const row of rows) {
        const at = iso(row.createdAt);
        items.push(draft({
          kind: "dm", roomId, key: `peer|${row.messageId}`,
          title: clip(row.body || "Direct message"), actor: row.actorId ?? null, createdAt: at, updatedAt: at,
          basis: row.messageId, sourceRef: { messageId: row.messageId },
          next: { method: "GET", path: `/api/rooms/${encodeURIComponent(roomId)}/peer-dms` }
        }));
      }
    } catch (error) {
      if (!tableMissing(error)) throw error;
      flags.peerDms = true;
    }
  }

  for (const item of Object.values(state.workItems ?? {})) {
    if (!item?.id) continue;
    const next = nextWorkStep(item, now, ownerId);
    if (next.memberId !== memberId || !next.needsAttention) continue;
    // An open handoff triaged to this member is a reply owed: someone handed
    // work over and is waiting on this member's response. It stays owed until
    // the handoff closes or the member marks it read/done/clear.
    if (next.action === "triaged_handoff" && item.handoff?.open) {
      const handoffAt = iso(item.handoff.at ?? item.updatedAt ?? item.createdAt ?? now);
      items.push(draft({
        kind: "handoff", roomId, key: `handoff|${item.id}`,
        title: clip(item.handoff.nextAction || item.title || item.id), actor: item.handoff.actorId ?? null,
        createdAt: iso(item.handoff.at ?? item.createdAt ?? handoffAt), updatedAt: handoffAt,
        basis: `${item.revision}|handoff|${item.handoff.eventId ?? ""}`,
        sourceRef: { workItemId: item.id },
        next: { method: "GET", path: `/api/rooms/${encodeURIComponent(roomId)}/work-context?workItemId=${encodeURIComponent(item.id)}` }
      }));
      continue;
    }
    if (!["verify", "decide"].includes(next.action)) continue;
    const at = iso(item.updatedAt ?? item.createdAt ?? now);
    items.push(draft({
      kind: "review_requested", roomId, key: `review|${item.id}|${next.action}`,
      title: clip(item.title || item.id), actor: item.accountableMemberId ?? null,
      createdAt: iso(item.createdAt ?? at), updatedAt: at,
      basis: `${item.revision}|${item.receipt?.eventId ?? ""}|${next.action}`,
      sourceRef: { workItemId: item.id },
      next: { method: "GET", path: `/api/rooms/${encodeURIComponent(roomId)}/work-context?workItemId=${encodeURIComponent(item.id)}` }
    }));
  }

  try {
    const rows = store.db.prepare(
      `SELECT body FROM events WHERE room_id=? AND json_extract(body,'$.type')='work_claim.updated' ORDER BY sequence DESC LIMIT 200`
    ).all(roomId);
    const events = rows.map(row => ({ roomId, ...JSON.parse(row.body) }));
    items.push(...claimAttentionFromEvents(events, memberId));
  } catch (error) {
    if (!tableMissing(error)) throw error;
    flags.claims = true;
  }

  // An agent redeemed a one-time code this member minted. Private to the minter; the event
  // is in the shared log, so the viewer check is here, not in the event.
  try {
    const rows = store.db.prepare(
      `SELECT body FROM events WHERE room_id=? AND json_extract(body,'$.type')='member.added'
         AND json_extract(body,'$.data.joinedVia')='one-time-code' AND json_extract(body,'$.data.referredBy')=? ORDER BY sequence DESC LIMIT 20`
    ).all(roomId, memberId);
    for (const row of rows) {
      const event = JSON.parse(row.body), data = event.data ?? {};
      const joined = state.members?.[data.memberId];
      if (!joined || joined.active === false) continue;
      const at = iso(event.at);
      items.push(draft({
        kind: "agent_joined", roomId, key: `joined|${data.memberId}`,
        title: clip(`${joined.displayName} joined with a one-time code`), actor: data.memberId, createdAt: at, updatedAt: at,
        basis: data.memberId, sourceRef: { memberId: data.memberId },
        next: null
      }));
    }
  } catch (error) {
    if (!tableMissing(error)) throw error;
  }

  if (owner) {
    try {
      const rows = store.db.prepare(
        `SELECT id, intended_display_name AS name, created_at AS createdAt, issuer_member_id AS actor
         FROM membership_invitations WHERE room_id=? AND status='pending' AND expires_at>?`
      ).all(roomId, now);
      for (const row of rows) {
        const at = iso(row.createdAt);
        items.push(draft({
          kind: "invite_pending", roomId, key: `invite|${row.id}`,
          title: clip(`${row.name} is invited`), actor: row.actor, createdAt: at, updatedAt: at,
          basis: row.id, sourceRef: { requestId: row.id },
          next: { method: "GET", path: `/api/rooms/${encodeURIComponent(roomId)}/invitations` }
        }));
      }
    } catch (error) {
      if (!tableMissing(error)) throw error;
      flags.invites = true;
    }
    try {
      const rows = store.db.prepare(
        `SELECT request_id AS requestId, display_name AS name, created_at AS createdAt, identity_id AS actor
         FROM access_requests WHERE room_id=? AND status='pending'`
      ).all(roomId);
      for (const row of rows) {
        const at = iso(row.createdAt);
        items.push(draft({
          kind: "access_request", roomId, key: `access|${row.requestId}`,
          title: clip(`${row.name} asks to join`), actor: row.actor, createdAt: at, updatedAt: at,
          basis: row.requestId, sourceRef: { requestId: row.requestId },
          next: { method: "POST", path: `/api/rooms/${encodeURIComponent(roomId)}/access-requests/${encodeURIComponent(row.requestId)}/decide` }
        }));
      }
    } catch (error) {
      if (!tableMissing(error)) throw error;
      flags.accessRequests = true;
    }
  }

  const marks = marksFor(store, roomId, memberId);
  const wakes = ackedWakes(store, roomId, memberId, flags);
  const view = items.map(item => ({ ...item, state: sourceState(item, marks.get(item.id), wakes) }));
  return { items: view, flags, skipped: false };
}

function publish(item) {
  const { basis, terminal, ...rest } = item;
  return { ...rest, basisToken: basisTokenOf(item) };
}

function parseListQuery({ state = "actionable", kinds = null, cursor = null, limit = DEFAULT_LIMIT } = {}) {
  if (!["actionable", "all"].includes(state)) fail(422, "invalid_updates_query", "state must be actionable or all");
  let kindList = null;
  if (kinds != null && kinds !== "") {
    kindList = String(kinds).split(",").map(kind => kind.trim()).filter(Boolean);
    if (!kindList.length || kindList.some(kind => !UPDATE_KINDS.includes(kind))) {
      fail(422, "invalid_updates_query", "kinds must name update kinds");
    }
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) fail(422, "invalid_updates_query", "limit must be an integer from 1 to 100");
  let decoded = null;
  if (cursor != null && cursor !== "") {
    try {
      decoded = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    } catch { fail(422, "invalid_cursor", "Invalid updates cursor"); }
    if (!decoded || decoded.v !== 1 || typeof decoded.viewer !== "string" || typeof decoded.id !== "string" || typeof decoded.updatedAt !== "string") {
      fail(422, "invalid_cursor", "Invalid updates cursor");
    }
  }
  return { state, kindList, limit, cursor: decoded };
}

function page(items, query, viewer) {
  const parsed = parseListQuery(query);
  if (parsed.cursor && parsed.cursor.viewer !== viewer) fail(422, "invalid_cursor", "That cursor belongs to a different reader");
  let selected = items;
  if (parsed.state === "actionable") selected = selected.filter(item => ACTIONABLE.has(item.state));
  if (parsed.kindList) {
    const allowed = new Set(parsed.kindList);
    selected = selected.filter(item => allowed.has(item.kind));
  }
  selected.sort((a, b) => a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  let start = 0;
  if (parsed.cursor) {
    const index = selected.findIndex(item => item.id === parsed.cursor.id && item.updatedAt === parsed.cursor.updatedAt);
    if (index < 0) fail(409, "cursor_stale", "The list changed; start again without a cursor");
    start = index + 1;
  }
  const slice = selected.slice(start, start + parsed.limit);
  const last = slice.at(-1);
  const hasMore = start + parsed.limit < selected.length;
  return {
    items: slice.map(publish), hasMore, limit: parsed.limit, state: parsed.state,
    cursor: hasMore ? encode({ v: 1, viewer, updatedAt: last.updatedAt, id: last.id }) : null
  };
}

function mergeFlags(list) {
  const flags = { mentions: false, peerDms: false, claims: false, invites: false, accessRequests: false, wakes: false, rooms: false };
  for (const flagsOf of list) for (const key of Object.keys(flags)) if (flagsOf?.[key]) flags[key] = true;
  return flags;
}

export function projectRoomUpdates(store, roomId, memberId, identityId = null) {
  return projectRoom(store, roomId, memberId, identityId);
}

export function listRoomUpdates(store, token, roomId, query = {}, binding = null) {
  return store.readTransaction(() => {
    const auth = store.authenticate(token, roomId, binding);
    const projected = projectRoom(store, roomId, auth.member.id, auth.identityId ?? store.bonds?.identityForMember?.(roomId, auth.member.id) ?? null);
    const viewer = `member:${roomId}:${auth.member.id}`;
    return {
      ...viewerEcho(auth, roomId), untrusted: true,
      incompleteSources: mergeFlags([projected.flags]),
      ...page(projected.items, query, viewer)
    };
  });
}

function identityRooms(store, identityId) {
  return store.identities.roomsForIdentity(identityId).map(row => ({ roomId: row.roomId, memberId: row.memberId }));
}

function accountRooms(store, accountId) {
  const rows = store.db.prepare("SELECT room_id AS roomId, member_id AS memberId FROM member_accounts WHERE account_id=?").all(accountId);
  return rows.filter(row => {
    try {
      const member = store.roomAuthority(row.roomId).members?.[row.memberId];
      return member && member.active !== false;
    } catch { return false; }
  });
}

function viewerEcho(auth, roomId) {
  // The browser treats a room read without this echo as a session change and signs out.
  return {
    roomId,
    viewerId: auth.member.id,
    viewerAccountId: auth.account?.id ?? null,
    viewerAuthEpoch: auth.account?.authEpoch ?? null,
    viewerSessionBinding: auth.sessionBinding,
    viewerSessionRevision: auth.sessionRevision ?? null
  };
}

function listAcross(store, rooms, identityId, viewer, query) {
  const flags = [];
  const items = [];
  for (const room of rooms) {
    try {
      const projected = projectRoom(store, room.roomId, room.memberId, identityId);
      if (!projected.skipped) items.push(...projected.items);
      flags.push(projected.flags);
    } catch {
      flags.push({ rooms: true });
    }
  }
  return { untrusted: true, incompleteSources: mergeFlags(flags), ...page(items, query, viewer) };
}

export function listIdentityUpdates(store, secret, query = {}) {
  const identity = store.identities.resolveGlobalIdentitySecret(secret);
  if (!identity) fail(401, "unauthenticated", "Unknown or revoked identity secret");
  return store.readTransaction(() => listAcross(
    store, identityRooms(store, identity.identityId), identity.identityId, `identity:${identity.identityId}`, query
  ));
}

export function listAccountUpdates(store, token, binding, query = {}) {
  return store.readTransaction(() => {
    const auth = store.authenticateAccountSession(token, null, binding);
    return listAcross(store, accountRooms(store, auth.account.id), null, `account:${auth.account.id}`, query);
  });
}

// Owed-replies inbox: the return trigger. One poll answers "what replies are
// owed to ME right now" across every room this identity is linked to.
// Owed kinds: direct questions (request), mentions awaiting reply, DMs,
// review requests naming the viewer, and open handoffs addressed to the
// viewer. Only unread/read items are owed; answered, handled, and cleared
// items leave the list. Ordered by waiting time, oldest first, so the most
// overdue reply surfaces first. Each entry carries who asked (actor), what
// they asked (title excerpt), where (roomId plus the sourceRef ids, echoed
// in `where`), how long it has been waiting (waitingMs), and the suggested
// next read or reply (next). Reading never acknowledges or resolves items;
// use the updates mark endpoints for that.
const OWED_KINDS = Object.freeze(["request", "mention", "dm", "review_requested", "handoff"]);

function parseOwedQuery({ limit = DEFAULT_LIMIT, cursor = null } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) fail(422, "invalid_owed_query", "limit must be an integer from 1 to 100");
  let decoded = null;
  if (cursor != null && cursor !== "") {
    try {
      decoded = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    } catch { fail(422, "invalid_cursor", "Invalid owed-replies cursor"); }
    if (!decoded || decoded.v !== 2 || typeof decoded.viewer !== "string"
      || typeof decoded.createdAt !== "string" || typeof decoded.id !== "string") {
      fail(422, "invalid_cursor", "Invalid owed-replies cursor");
    }
  }
  return { limit, cursor: decoded };
}

function owedWhere(item) {
  const ref = item.sourceRef ?? {};
  const where = { roomId: item.roomId };
  if (typeof ref.messageId === "string") where.messageId = ref.messageId;
  if (typeof ref.requestId === "string") where.requestId = ref.requestId;
  if (typeof ref.workItemId === "string") where.workItemId = ref.workItemId;
  return where;
}

export function listOwedReplies(store, secret, query = {}) {
  const identity = store.identities.resolveGlobalIdentitySecret(secret);
  if (!identity) fail(401, "unauthenticated", "Unknown or revoked identity secret");
  const parsed = parseOwedQuery(query);
  return store.readTransaction(() => {
    const viewer = `identity:${identity.identityId}`;
    const now = store.now();
    const items = [];
    for (const room of identityRooms(store, identity.identityId)) {
      let projected;
      try {
        projected = projectRoom(store, room.roomId, room.memberId, identity.identityId);
      } catch {
        continue;
      }
      if (projected.skipped) continue;
      for (const item of projected.items) {
        if (!OWED_KINDS.includes(item.kind) || !ACTIONABLE.has(item.state)) continue;
        items.push(item);
      }
    }
    items.sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    let start = 0;
    if (parsed.cursor) {
      if (parsed.cursor.viewer !== viewer) fail(422, "invalid_cursor", "That cursor belongs to a different reader");
      const index = items.findIndex(item => item.id === parsed.cursor.id && item.createdAt === parsed.cursor.createdAt);
      if (index < 0) fail(409, "cursor_stale", "The list changed; start again without a cursor");
      start = index + 1;
    }
    const slice = items.slice(start, start + parsed.limit);
    const last = slice.at(-1);
    const hasMore = start + parsed.limit < items.length;
    return {
      untrusted: true,
      items: slice.map(item => {
        const waited = now - Date.parse(item.createdAt);
        return {
          ...publish(item),
          where: owedWhere(item),
          waitingMs: Number.isFinite(waited) ? Math.max(0, waited) : 0
        };
      }),
      hasMore,
      limit: parsed.limit,
      cursor: hasMore ? encode({ v: 2, viewer, createdAt: last.createdAt, id: last.id }) : null
    };
  });
}

export function markUpdate(store, token, roomId, itemId, action, requestId, binding = null, expectedBasis = undefined) {
  if (!["read", "done", "clear"].includes(action)) fail(422, "invalid_update", "Choose read, done, or clear");
  if (!validId(requestId) || !validId(itemId)) fail(422, "invalid_update", "Supply the item id and a request id");
  if (expectedBasis !== undefined && !validBasis(expectedBasis)) fail(422, "invalid_update", "expectedBasis must be an Updates basis token");
  ensureSchema(store);
  return store.transaction(() => {
    const auth = store.authenticate(token, roomId, binding);
    const fingerprint = fingerprintOf(action, itemId, requestId, expectedBasis);
    const prior = store.db.prepare(
      "SELECT fingerprint, response FROM private_update_commands WHERE room_id=? AND member_id=? AND request_id=?"
    ).get(roomId, auth.member.id, requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) fail(409, "idempotency_conflict", "Request id already used for a different update");
      return { ...JSON.parse(prior.response), ...viewerEcho(auth, roomId), duplicate: true };
    }
    // New unbound operations must never acknowledge a revision the caller did
    // not see. Old committed receipts above remain retryable under current auth.
    if (expectedBasis === undefined) fail(422, "update_basis_required", "Read the update and supply its basisToken as expectedBasis");
    const projected = projectRoom(store, roomId, auth.member.id, auth.identityId ?? null);
    const raw = projected.items.find(item => item.id === itemId);
    if (!raw) fail(404, "update_not_found", "That update is not in your list");
    if (expectedBasis !== basisTokenOf(raw)) fail(409, "update_changed", "This update changed; read it again before acting");
    let next = raw.state;
    if (action === "read" && raw.state === "unread") next = "read";
    if (action === "done" && ACTIONABLE.has(raw.state)) next = "handled";
    if (action === "clear" && raw.state !== "answered") next = "cleared";
    const storedAction = next === "read" ? "read" : next === "handled" ? "done" : next === "cleared" ? "clear" : null;
    if (storedAction) {
      store.db.prepare(
        `INSERT INTO private_update_marks (room_id,member_id,item_id,action,basis,updated_at) VALUES(?,?,?,?,?,?)
         ON CONFLICT(room_id,member_id,item_id) DO UPDATE SET action=excluded.action, basis=excluded.basis, updated_at=excluded.updated_at`
      ).run(roomId, auth.member.id, itemId, storedAction, raw.basis, store.now());
    }
    const response = {
      ...viewerEcho(auth, roomId), requestId, duplicate: false,
      item: publish({ ...raw, state: next })
    };
    store.db.prepare("INSERT INTO private_update_commands (room_id,member_id,request_id,fingerprint,response) VALUES(?,?,?,?,?)")
      .run(roomId, auth.member.id, requestId, fingerprint, JSON.stringify(response));
    return response;
  });
}

export function retiredNeedsMeKeys(store, roomId, memberId) {
  try {
    const projected = projectRoom(store, roomId, memberId, null);
    const keys = new Set();
    for (const item of projected.items) {
      if (ACTIONABLE.has(item.state)) continue;
      const ref = item.sourceRef ?? {};
      if (item.kind === "request" && ref.requestId) keys.add(`direct_ask:${ref.requestId}`);
      if (item.kind === "mention" && ref.messageId) keys.add(`mention:${ref.messageId}`);
      if (item.kind === "dm" && ref.messageId) keys.add(`dm:${ref.messageId}`);
      if (item.kind === "handoff" && ref.workItemId) keys.add(`handoff:${ref.workItemId}`);
    }
    return keys;
  } catch {
    return new Set();
  }
}

export function orientSections(store, roomId, memberId, { limit = 10 } = {}) {
  const projected = projectRoom(store, roomId, memberId, null);
  const cap = Number.isSafeInteger(limit) && limit > 0 ? limit : 10;
  const actionable = projected.items.filter(item => ACTIONABLE.has(item.state))
    .sort((a, b) => a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0)
    .slice(0, cap)
    .map(publish);
  let uncertain = [];
  try {
    if (store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='request_runs'").get()) {
      const rows = store.db.prepare(
        "SELECT request_id AS requestId, state, updated_at AS updatedAt, attempt_id AS attemptId FROM request_runs WHERE room_id=? AND member_id=?"
      ).all(roomId, memberId);
      const now = store.now();
      uncertain = rows.filter(row => row.state === "needs_attention" || (row.state === "working" && now - row.updatedAt > 120000))
        .map(row => ({
          requestId: row.requestId, attemptId: row.attemptId,
          state: row.state === "working" ? "unknown" : row.state,
          updatedAt: iso(row.updatedAt)
        }));
    }
  } catch (error) {
    if (!tableMissing(error)) throw error;
  }
  return { updates: actionable, uncertain, incompleteSources: mergeFlags([projected.flags]) };
}

export function readEventTail(store, token, roomId, tail, binding = null) {
  if (!Number.isSafeInteger(tail) || tail < 1 || tail > 200) fail(422, "invalid_event_cursor", "tail must be an integer from 1 to 200");
  const sequence = store.roomAuthority(roomId).sequence;
  const start = Math.max(0, sequence - tail);
  const events = [];
  let after = start;
  let next = start;
  let guard = 0;
  while (after < sequence && guard < 4) {
    const limit = Math.min(100, sequence - after);
    const page = store.eventsAfter(token, roomId, after, Math.max(1, limit), { expectedSessionBinding: binding });
    events.push(...page.events);
    next = page.next;
    if (!page.hasMore || page.next <= after) break;
    after = page.next;
    guard += 1;
  }
  return { events, next, hasMore: next < sequence };
}
