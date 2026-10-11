// QA8 (2026-10-08, live prod): a brand-new account invited a guest by link.
// The join dialog promised "Read history and join the conversation" and the
// access line said "Read the room and its history", but the room was on the
// default PRIV-2 policy (link guests see only messages from after they join),
// so the guest landed on "No messages yet" in a room with four messages.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { previewAccessText } from "../server/share-links.mjs";
import { HISTORY_DEFAULTS_VERSION } from "../src/events.js";

const room = historyVisibility => ({ room: { ownerId: "owner", historyDefaultsVersion: HISTORY_DEFAULTS_VERSION, ...(historyVisibility ? { historyVisibility: { value: historyVisibility, revision: 1 } } : {}) }, members: {} });
const legacy = { room: { ownerId: "owner" }, members: {} };

test("guest link preview names since-join history when the room keeps the guest default", () => {
  assert.match(previewAccessText("guest", room(null)), /^Read messages posted after you join/);
  assert.doesNotMatch(previewAccessText("guest", room(null)), /history/);
  assert.match(previewAccessText("guest", room("since_join")), /after you join/);
});

test("full history is still promised where the guest will really see it", () => {
  assert.match(previewAccessText("guest", room("all")), /its history/);
  // Oct 10 2026: a legacy room (no historyDefaultsVersion) keeps the guest default too.
  assert.match(previewAccessText("guest", legacy), /^Read messages posted after you join/);
  assert.match(previewAccessText("member", room(null)), /^Read and post/);
  assert.match(previewAccessText("member", room("since_join")), /after you join/);
  assert.match(previewAccessText("co_admin", room("since_join")), /^Every room permission/);
});

test("the join dialog scope line no longer promises history unconditionally", () => {
  const source = readFileSync(new URL("../src/share-links.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Read history and join the conversation/);
  assert.match(source, /Join the conversation\. Everyone in the room can read your messages\./);
});
