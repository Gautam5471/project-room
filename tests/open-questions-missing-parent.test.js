// A sibling answer under a parent that is not in the projection must close
// the question. threadRootOf used to stop on the child, so the two replies
// no longer shared a root.
import test from "node:test";
import assert from "node:assert/strict";
import { findOpenQuestions } from "../server/open-questions.mjs";

const msg = (id, authorId, body, extra = {}) => ({
  id, authorId, body, createdAt: "2026-10-10T00:00:00.000Z", ...extra,
});

test("a later sibling under a missing parent closes the question", () => {
  const rows = findOpenQuestions({
    viewerId: "a",
    messages: [
      msg("q", "a", "Is the deploy ready?", { replyToId: "gone" }),
      msg("ans", "b", "Yes, it shipped.", { replyToId: "gone", createdAt: "2026-10-10T00:01:00.000Z" }),
    ],
  });
  assert.deepEqual(rows.map(row => row.messageId), []);
});

test("a question whose parent is missing stays open until someone else answers", () => {
  const rows = findOpenQuestions({
    viewerId: "a",
    messages: [msg("q", "a", "Is the deploy ready?", { replyToId: "gone" })],
  });
  assert.deepEqual(rows.map(row => row.messageId), ["q"]);
  assert.equal(rows[0].threadRootId, "gone");
});

test("a different missing parent does not close the question", () => {
  const rows = findOpenQuestions({
    viewerId: "a",
    messages: [
      msg("q", "a", "Is the deploy ready?", { replyToId: "gone" }),
      msg("other", "b", "Unrelated.", { replyToId: "elsewhere", createdAt: "2026-10-10T00:01:00.000Z" }),
    ],
  });
  assert.deepEqual(rows.map(row => row.messageId), ["q"]);
});

test("an earlier sibling under the missing parent does not close the question", () => {
  const rows = findOpenQuestions({
    viewerId: "a",
    messages: [
      msg("earlier", "b", "Starting.", { replyToId: "gone", createdAt: "2026-10-09T23:00:00.000Z" }),
      msg("q", "a", "Is the deploy ready?", { replyToId: "gone" }),
    ],
  });
  assert.deepEqual(rows.map(row => row.messageId), ["q"]);
});

test("an unreadable sibling under the missing parent does not close the question", () => {
  const rows = findOpenQuestions({
    viewerId: "a",
    messages: [
      msg("q", "a", "Is the deploy ready?", { replyToId: "gone" }),
      msg("dm", "b", "Yes.", { replyToId: "gone", toMemberId: "c", createdAt: "2026-10-10T00:01:00.000Z" }),
    ],
  });
  assert.deepEqual(rows.map(row => row.messageId), ["q"]);
});
