import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

// R48-1 followup: each edit appended the previous body to message.editHistory
// with no cap, so enough edits of a long message drove the room projection
// into the 4 MiB pilot cap and every later write in the room was refused
// (muse-room 12457 item 3, evidence 12458). The reducer must bound the
// history so edits can never stop the room accepting writes.

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-edit-hist-cap-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const ownerKey = store.issueAccessKey("commons", "owner");
  const post = (body) => store.command(ownerKey, "commons",
    { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: randomUUID(), body } }).event.data.messageId;
  return { store, ownerKey, post };
}

test("edit history is bounded and cannot trigger the room projection cap", async t => {
  const { store, ownerKey, post } = fixture(t);
  const messageId = post("x".repeat(16000));
  for (let i = 0; i < 270; i++) {
    store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_EDITED,
      data: { messageId, body: `v${i} ${"y".repeat(16000)}`, expectedMessageRevision: i } });
  }
  // The room must still accept a normal write after heavy editing.
  const next = store.command(ownerKey, "commons",
    { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: randomUUID(), body: "still writable" } });
  assert.equal(next.event.type, T.MESSAGE_POSTED);
  const message = store.room("commons").state.messages.find(m => m.id === messageId);
  assert.ok(message.editHistory.length <= 25, `editHistory should be bounded, got ${message.editHistory.length}`);
  assert.equal(message.body, "v269 " + "y".repeat(16000));
});
