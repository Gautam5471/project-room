// F1: open-questions radar. A pure derivation over the room's message list:
// an "open question" is a non-deleted message whose body contains "?" with
// no reply from a different author — neither a direct replyToId reply nor a
// later message in the same thread by someone other than the asker. The
// asker's own follow-ups never count as answers. Frozen outputs; malformed
// inputs throw OpenQuestionsError.
//
// DM scoping: a DM belongs to its two parties, so a viewer sees their own
// DMs plus public messages; everyone else's DMs are invisible to the radar.
// An answer the asker could not read (a DM to someone else) does not close
// the question.
import { ServiceError } from "./store.mjs";
import { messageInHistory } from "./history-visibility.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

export const OPEN_QUESTIONS_DEFAULT_LIMIT = 50;
export const OPEN_QUESTIONS_MAX_LIMIT = 100;
const EXCERPT_LENGTH = 160;

// A message's thread root: itself when top-level. Walks the reply chain so
// every message in one conversation shares a root. A parent that is not in
// this projection is still the shared root — two replies to the same missing
// id are one thread. Stopping on the child splits that thread and leaves an
// answered question open.
function threadRootOf(byId, messageId) {
  let node = byId.get(messageId);
  const seen = new Set();
  while (node?.replyToId && !seen.has(node.id)) {
    seen.add(node.id);
    const parent = byId.get(node.replyToId);
    if (!parent) return node.replyToId;
    node = parent;
  }
  return node?.id ?? messageId;
}

const excerptOf = body => String(body).replace(/\s+/g, " ").trim().slice(0, EXCERPT_LENGTH);

// Pure derivation. `messages` is the room state's message list (plain
// objects with id/authorId/body/replyToId/toMemberId/createdAt/deletedAt).
// `viewerId` scopes DMs; null means public messages only.
export function findOpenQuestions({ messages, viewerId = null }) {
  if (!Array.isArray(messages)) throw new Error("messages must be an array");
  const byId = new Map();
  for (const message of messages) {
    if (message && typeof message.id === "string") byId.set(message.id, message);
  }
  const rootOf = id => threadRootOf(byId, id);
  const visible = message => {
    if (!message || message.deletedAt) return false;
    if (!message.toMemberId) return true; // public
    if (!viewerId) return false;
    return message.toMemberId === viewerId || message.authorId === viewerId;
  };
  const isQuestion = message => typeof message.body === "string" && message.body.includes("?");
  // True when someone other than the asker spoke in the question's thread at
  // or after the question, or replied to it directly. A reply the asker
  // cannot read (someone else's DM) never closes the question. Response
  // candidates must also be visible to the viewer of this projection.
  const answered = question => {
    const root = rootOf(question.id);
    const askedAt = Date.parse(question.createdAt) || 0;
    for (const message of messages) {
      if (!message || message.id === question.id || message.deletedAt) continue;
      if (message.authorId === question.authorId) continue; // own follow-up
      if (message.toMemberId && message.toMemberId !== question.authorId) continue; // unreadable answer
      if (!visible(message)) continue;
      if (message.replyToId === question.id) return true;
      if (rootOf(message.id) === root && (Date.parse(message.createdAt) || 0) >= askedAt) return true;
    }
    return false;
  };
  const open = [];
  for (const message of messages) {
    if (!visible(message) || !isQuestion(message) || answered(message)) continue;
    open.push(Object.freeze({
      messageId: message.id,
      authorId: message.authorId,
      excerpt: excerptOf(message.body),
      askedAt: message.createdAt ?? null,
      threadRootId: rootOf(message.id),
    }));
  }
  open.sort((a, b) => String(b.askedAt ?? "").localeCompare(String(a.askedAt ?? "")));
  return Object.freeze(open.slice(0, OPEN_QUESTIONS_MAX_LIMIT));
}

// HTTP-facing read: membership is re-checked on every call; DMs outside the
// caller's parties are excluded by the pure derivation above.
export function listOpenQuestions(store, token, roomId, params = {}, expectedSessionBinding = null) {
  const auth = store.authenticate(token, roomId, expectedSessionBinding);
  if (!auth.member || auth.member.active === false) fail(403, "access_denied", "Room membership is inactive");
  const { limit = OPEN_QUESTIONS_DEFAULT_LIMIT } = params ?? {};
  const count = Number(limit);
  if (!Number.isInteger(count) || count < 1 || count > OPEN_QUESTIONS_MAX_LIMIT) {
    fail(422, "invalid_open_questions_limit", `Choose a limit between 1 and ${OPEN_QUESTIONS_MAX_LIMIT}`);
  }
  return store.readTransaction(() => {
    const room = store.room(roomId);
    const member = room.state.members[auth.member.id] ?? auth.member;
    // PRIV-2: questions from before a since_join reader joined stay out.
    const floor = store.historyFloor(roomId, member.id);
    const messages = (room.state.messages ?? []).filter(message => messageInHistory(message, floor));
    const questions = findOpenQuestions({ messages, viewerId: member.id });
    return {
      roomId,
      viewerId: member.id,
      evaluatedAt: store.now(),
      openQuestions: questions.slice(0, count),
    };
  });
}
