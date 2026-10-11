// A room page lists five receipts. Owner-hidden rows must not fill those
// slots: five newer receipts whose origin room turned public receipts off,
// plus one older receipt that stayed public, must still show the public one.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { publicRoomView } from "../server/public-rooms.mjs";

const hex = n => n.toString(16).padStart(32, "0");
const hiddenId = n => `wcr_${hex(n)}`;
const visibleId = `wcr_${hex(9)}`;

function seed(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-receipt-fill-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const now = "2026-10-11T00:00:00.000Z";
  store.db.prepare(`INSERT INTO public_rooms
      (slug, title, purpose, humans, agents, names_json, tasks_json, members_json, receipts_enabled, join_mode, join_token, owner_member_id, set_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "commons", "Commons", "A public room", 0, 1, "[]", "[]", "[]", 1, "request", null, "owner", now, now);
  store.db.prepare(`INSERT INTO room_directory_settings
      (room_id, discoverable, listed_at, updated_at, opportunities_enabled, public_receipts)
      VALUES (?, 0, NULL, 1, 1, 0)`).run("secret");
  const insert = store.db.prepare(`INSERT INTO public_receipts
      (id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json, pull_request, merged_at, hashes_json, at, start_href)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (let i = 1; i <= 5; i++) {
    insert.run(hiddenId(i), `Hidden ${i}`, "work-claim", "secret", "commons", "Commons",
      "[]", "[]", null, null, "[]", `2026-10-11T00:0${i}:00.000Z`, "https://room.trydemigod.com/?start=room");
  }
  insert.run(visibleId, "Visible payroll fix", "work-claim", "commons", "commons", "Commons",
    "[]", "[]", null, null, "[]", "2026-10-10T00:00:00.000Z", "https://room.trydemigod.com/?start=room");
  return store;
}

test("a room page keeps a public receipt that follows a page of owner-hidden receipts", t => {
  const store = seed(t);
  const view = publicRoomView(store, "commons");
  const ids = view.document.receipts.map(receipt => receipt.id);
  assert.deepEqual(ids, [visibleId]);
  assert.equal(view.document.receipts[0].title, "Visible payroll fix");
  assert.equal(view.html.includes("Hidden 1"), false);
  assert.equal(view.html.includes(hiddenId(1)), false);
});
