import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { getReadHorizon, setReadHorizon } from "../server/activity.mjs";

test("setReadHorizon refuses a message from before a since_join reactivation", t => {
  const directory = mkdtempSync(join(tmpdir(), "read-horizon-floor-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  let now = Date.parse("2026-10-08T00:00:00.000Z");
  store.now = () => (now += 1000);
  const owner = store.issueAccessKey("commons", "owner");
  const cmd = (type, data) => store.command(owner, "commons", { id: randomUUID(), type, data });
  cmd(T.ROOM_HISTORY_VISIBILITY_SET, { historyVisibility: "since_join" });
  cmd(T.MEMBER_ADDED, { memberId: "late", displayName: "Late", kind: "human", permissions: [] });
  cmd(T.MESSAGE_POSTED, { messageId: "gap-msg", body: "gap secret horizon" });
  const gapRevision = store.snapshot(owner, "commons").state.members.late.revision;
  cmd(T.MEMBER_ACCESS_CHANGED, { memberId: "late", expectedMemberRevision: gapRevision, permissions: [], active: false });
  const removedRevision = store.snapshot(owner, "commons").state.members.late.revision;
  cmd(T.MEMBER_ACCESS_CHANGED, { memberId: "late", expectedMemberRevision: removedRevision, permissions: [], active: true });
  const late = store.issueAccessKey("commons", "late");
  cmd(T.MESSAGE_POSTED, { messageId: "after-msg", body: "welcome back" });

  const missing = () => setReadHorizon(store, late, "commons", { lastReadMessageId: "no-such" });
  assert.throws(missing, { status: 404, code: "message_not_found" });
  assert.throws(
    () => setReadHorizon(store, late, "commons", { lastReadMessageId: "gap-msg" }),
    { status: 404, code: "message_not_found" }
  );
  assert.equal(store.db.prepare("SELECT 1 FROM read_horizons WHERE room_id=? AND member_id=? AND last_read_message_id=?").get("commons", "late", "gap-msg"), undefined);
  assert.equal(getReadHorizon(store, late, "commons").lastReadMessageId, null);

  const saved = setReadHorizon(store, late, "commons", { lastReadMessageId: "after-msg" });
  assert.equal(saved.lastReadMessageId, "after-msg");
  assert.equal(getReadHorizon(store, late, "commons").lastReadMessageId, "after-msg");
  assert.equal(setReadHorizon(store, owner, "commons", { lastReadMessageId: "gap-msg" }).lastReadMessageId, "gap-msg");
});
