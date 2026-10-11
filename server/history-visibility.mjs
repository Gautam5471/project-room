// PRIV-2: history visibility.
//
// A member under "since_join" reads messages and events from their own join
// onward. The join point is the member's latest move to active: the LATEST
// member.added / member.joined_via_invitation, or a member.access_changed
// that reactivates a removed member (#1523): a guest who
// is removed and later reactivated must not read messages posted during the
// removal gap. The event's sequence bounds event-log reads, and its timestamp
// bounds reads over the message projection, which carries createdAt but no
// sequence. Members who read everything get a null floor, so their reads take
// no extra work.

import { randomUUID } from "node:crypto";
import { EVENT_TYPES as T, historyVisibility, memberHistoryVisibility, isRoomArchived } from "../src/events.js";


// Invite copy for link guests and guest-agent members. Without an owner
// choice, every room (v1 or older) hides earlier messages from those guests.
// "since_join" hides them for every non-owner member. Only an explicit "all"
// includes earlier messages.
export function guestReadsHistoryFromJoin(room) {
  const setting = historyVisibility({ room });
  return setting.value === "since_join" || (setting.value === null && setting.guestsSinceJoin);
}

export function guestHistoryAccessLead(room) {
  return guestReadsHistoryFromJoin(room)
    ? "Read messages posted after you join"
    : "Read the room and its history";
}

const JOIN_TYPES = [T.MEMBER_ADDED, T.MEMBER_JOINED_VIA_INVITATION];

// Returns null (no limit) or { sequence, at, sameInstant } for the member's
// join event. Timestamps have millisecond precision, so `sameInstant` lists
// the ids of messages and events that share the join's millisecond but come
// before it in the log; they stay hidden. A since_join member whose join
// event cannot be found reads nothing older than the room head (fail closed).
export function historyFloor(db, state, roomId, memberId, headSequence = null) {
  if (memberHistoryVisibility(state, memberId) !== "since_join") return null;
  // The reducer refuses a second member.added for a known id, so a removed
  // member comes back through member.access_changed { active: true }. The
  // floor is the member's most recent move from absent-or-inactive to active,
  // whichever event made it; role/permission edits while active do not move it.
  const rows = db.prepare(
    `SELECT sequence, json_extract(body,'$.at') AS at, json_extract(body,'$.type') AS type,
            json_extract(body,'$.data.active') AS active FROM events
     WHERE room_id=? AND json_extract(body,'$.type') IN (${[...JOIN_TYPES, T.MEMBER_ACCESS_CHANGED].map(() => "?").join(",")})
       AND json_extract(body,'$.data.memberId')=?
     ORDER BY sequence`
  ).all(roomId, ...JOIN_TYPES, T.MEMBER_ACCESS_CHANGED, memberId);
  let row = null, active = false;
  for (const entry of rows) {
    let nowActive;
    if (JOIN_TYPES.includes(entry.type)) nowActive = true;
    else if (entry.active === 1 || entry.active === true) nowActive = true;
    else if (entry.active === 0 || entry.active === false) nowActive = false;
    else continue; // access_changed without an explicit active flag says nothing about activation
    if (nowActive && !active) row = entry;
    active = nowActive;
  }
  if (!row || !Number.isSafeInteger(row.sequence) || typeof row.at !== "string") {
    const head = Number.isSafeInteger(headSequence) ? headSequence : 0;
    return { sequence: head + 1, at: "9999-12-31T23:59:59.999Z", sameInstant: new Set() };
  }
  const sameInstant = new Set();
  const earlier = db.prepare(
    `SELECT json_extract(body,'$.id') AS id, json_extract(body,'$.data.messageId') AS messageId FROM events
     WHERE room_id=? AND sequence<? AND json_extract(body,'$.at')=?`
  ).all(roomId, row.sequence, row.at);
  for (const entry of earlier) {
    for (const id of [entry.id, entry.messageId]) {
      if (typeof id !== "string") continue;
      sameInstant.add(id);
      sameInstant.add(`${id}:channel`);
    }
  }
  return { sequence: row.sequence, at: row.at, sameInstant };
}

// Projection messages: visible when created after the join point.
export function messageInHistory(message, floor) {
  if (!floor) return true;
  const createdAt = message?.createdAt;
  if (typeof createdAt !== "string" || createdAt < floor.at) return false;
  return createdAt > floor.at || !floor.sameInstant?.has(message.id);
}

// QA4 Q4-SEC-1: one predicate for summary surfaces (orient, activation pack)
// that read projection messages directly instead of through the store's
// filtered reads. A targeted message (data.toMemberId, a DM) is visible only to
// its author and its addressee; the room owner is not exempt (RC-2026-09-19-070).
// The PRIV-2 floor applies on top. `floor` comes from store.historyFloor().
export function messageVisibleToViewer(message, viewerId, floor) {
  if (!message || message.body == null || message.deletedAt) return false;
  if (message.toMemberId && message.authorId !== viewerId && message.toMemberId !== viewerId) return false;
  return messageInHistory(message, floor);
}

// The floor for a summary read. Fails closed: if the floor cannot be read,
// the viewer sees no message text rather than all of it.
export function summaryHistoryFloor(store, roomId, viewerId, headSequence = null) {
  // A store that cannot report a floor (a mock, a custom adapter) is the same
  // "cannot be read" case as a floor that throws: deny all message text.
  const denyAll = () => ({ sequence: Number.MAX_SAFE_INTEGER, at: "9999-12-31T23:59:59.999Z", sameInstant: new Set() });
  if (typeof store?.historyFloor !== "function") return denyAll();
  try { return store.historyFloor(roomId, viewerId, headSequence); }
  catch { return denyAll(); }
}

// Later events can carry an earlier message's text or reference it (edits,
// reactions, pins). They follow the message: hidden when it is hidden.
function targetsHiddenMessage(event, floor, messagesById) {
  if (!messagesById || event?.type === T.MESSAGE_POSTED) return false;
  const messageId = event?.data?.messageId ?? event?.data?.requestMessageId;
  if (typeof messageId !== "string") return false;
  const message = messagesById.get(messageId);
  return Boolean(message) && !messageInHistory(message, floor);
}

export function indexMessages(messages) {
  return new Map((messages ?? []).filter(m => m && typeof m.id === "string").map(m => [m.id, m]));
}

// Event-log rows ({ sequence, event }): visible from the join event onward.
export function rowInHistory(row, floor, messagesById = null) {
  if (!floor) return true;
  return Number.isSafeInteger(row?.sequence) && row.sequence >= floor.sequence
    && !targetsHiddenMessage(row.event, floor, messagesById);
}

// Bare events (snapshot eventLog entries carry no sequence): by timestamp,
// with the same-millisecond tie broken by log order.
export function eventInHistory(event, floor, messagesById = null) {
  if (!floor) return true;
  const at = event?.at;
  if (typeof at !== "string" || at < floor.at) return false;
  return (at > floor.at || !floor.sameInstant?.has(event.id)) && !targetsHiddenMessage(event, floor, messagesById);
}

// Export authority: only the room owner exports, and every export of a live
// room appends room.exported (format only, no content) through the normal
// command path. An archived room records nothing new, so its exports leave
// no event; they stay owner-only.
export function requireExportOwner(store, roomId, memberId, fail) {
  if (memberId !== store.room(roomId).state.room.ownerId) fail(403, "owner_required", "Only the room owner can export the room");
}

export function recordRoomExport(store, token, roomId, format, expectedSessionBinding = null) {
  if (isRoomArchived(store.room(roomId).state)) return null;
  return store.command(token, roomId, { id: randomUUID(), type: T.ROOM_EXPORTED, data: { format } }, expectedSessionBinding);
}
