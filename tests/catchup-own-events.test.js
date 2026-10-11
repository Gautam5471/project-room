// QA8 (qa8-catchup-counts-own): your own writes are not news. A fresh room
// showed "Catch up 2 updates" with no messages, and every message you posted
// added one more, because the count is evaluatedThrough - cursor and the
// cursor only moved on an explicit "Mark caught up". The marker a reader sees
// now skips the unbroken run of events that reader authored right after
// their stored marker. Fetching still never writes a marker, and anything
// another member did stays new.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const command = (type, data) => ({ id: crypto.randomUUID(), type, data });
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-catchup-own-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  for (const id of ["human", "other"]) store.command(owner, "commons", command(T.MEMBER_ADDED, { memberId: id, displayName: id, kind: "human", permissions: [] }));
  const human = store.issueAccessKey("commons", "human");
  const other = store.issueAccessKey("commons", "other");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, owner, human, other };
}
const post = (store, token, body) => store.command(token, "commons", command(T.MESSAGE_POSTED, { body }));
const changes = brief => brief.history.evaluatedThrough - brief.history.cursor;
const storedCursor = (store, memberId) =>
  store.db.prepare("SELECT sequence FROM cursors WHERE room_id='commons' AND member_id=?").get(memberId)?.sequence ?? null;

// The real brief count and paging must start at the same visibility boundary.
// Existing body-privacy tests strip hidden rows but do not guard H - cursor.
test("since-join catch-up excludes the hidden prefix without acknowledging or rewinding visible history", t => {
  const { store, owner } = fixture(t);
  const now = Date.parse("2026-10-09T12:00:00Z");
  store.now = () => now;
  for (let i = 0; i < 4; i++) post(store, owner, `hidden ${i}`);
  store.command(owner, "commons", command(T.ROOM_HISTORY_VISIBILITY_SET, { historyVisibility: "since_join" }));
  store.command(owner, "commons", command(T.MEMBER_ADDED, {
    memberId: "late-reader", displayName: "Late reader", kind: "human", permissions: []
  }));
  const key = store.issueAccessKey("commons", "late-reader");
  const joinSequence = store.room("commons").sequence;
  post(store, owner, "visible after joining");
  const first = store.returnBrief(key, "commons", { limit: 1 });
  assert.equal(first.history.cursor, joinSequence - 1, "the joining event is within visible history");
  assert.equal(changes(first), 2, "prejoin events do not inflate the count");
  assert.deepEqual(first.history.items.map(row => row.sequence), [joinSequence]);
  assert.equal(storedCursor(store, "late-reader"), null, "reading does not acknowledge");
  const next = store.returnBrief(key, "commons", { ...first.history.continuation, limit: 1 });
  assert.equal(next.history.cursor, first.history.cursor, "paging freezes the same effective marker");
  assert.equal(next.history.items[0].event.data.body, "visible after joining");

  store.markCaughtUp(key, "commons", next.history.evaluatedThrough);
  const acknowledged = storedCursor(store, "late-reader");
  post(store, owner, "new after acknowledgement");
  const returned = store.returnBrief(key, "commons");
  assert.equal(returned.history.cursor, acknowledged, "the visibility floor cannot rewind a later marker");
  assert.equal(changes(returned), 1);
  assert.equal(storedCursor(store, "late-reader"), acknowledged);
});

test("a room you created and only wrote in yourself has nothing to catch up on", t => {
  const { store, owner } = fixture(t);
  assert.equal(changes(store.returnBrief(owner, "commons")), 0, "room setup by the owner is not news to the owner");
  for (let i = 1; i <= 4; i++) post(store, owner, `mine ${i}`);
  const brief = store.returnBrief(owner, "commons");
  assert.equal(changes(brief), 0);
  assert.deepEqual(brief.history.items, []);
  assert.equal(brief.history.cursor, brief.history.evaluatedThrough);
  assert.equal(storedCursor(store, "owner"), null, "reading never writes a caught-up marker");
});

test("your own posts after you caught up do not count; another member's post still does", t => {
  const { store, human, other } = fixture(t);
  const first = store.returnBrief(human, "commons");
  assert.ok(changes(first) > 0, "the owner's setup events are news to someone else");
  store.markCaughtUp(human, "commons", first.history.evaluatedThrough);
  post(store, human, "mine 1"); post(store, human, "mine 2");
  assert.equal(changes(store.returnBrief(human, "commons")), 0);
  const theirs = post(store, other, "theirs").sequence;
  post(store, human, "mine 3");
  const brief = store.returnBrief(human, "commons");
  assert.equal(brief.history.cursor, theirs - 1, "the marker stops right before the other member's event");
  assert.deepEqual(brief.history.items.map(i => i.event.data.body), ["theirs", "mine 3"]);
  // The other member sees every message the human wrote as new.
  assert.equal(store.returnBrief(other, "commons").history.items.filter(i => i.event.data.body?.startsWith("mine")).length, 3);
});

// R28-1: the top-bar chip ("Catch up N updates") is client.sequence minus the
// snapshot's cursor. That cursor stays the stored marker (event resume must not
// skip your own events), so the chip kept counting the room's own setup and
// every message you sent while Catch up itself said "Already caught up". The
// snapshot now also carries the catch-up boundary the brief uses.
test("the snapshot carries the same catch-up boundary as the brief, and keeps the stored resume cursor", t => {
  const { store, owner, human, other } = fixture(t);
  const boundary = token => store.snapshot(token, "commons").catchUpCursor;
  assert.equal(boundary(owner), store.returnBrief(owner, "commons").history.cursor, "room setup by the owner is not news to the owner");
  post(store, owner, "mine 1"); post(store, owner, "mine 2");
  const snap = store.snapshot(owner, "commons");
  assert.equal(snap.catchUpCursor, snap.sequence, "your own posts are not news");
  assert.equal(snap.cursor, 0, "the resume cursor is still the stored marker");
  const theirs = post(store, other, "theirs").sequence;
  post(store, owner, "mine 3");
  assert.equal(boundary(owner), theirs - 1, "another member's event stays new");
  assert.equal(boundary(owner), store.returnBrief(owner, "commons").history.cursor);
  assert.ok(boundary(human) < store.snapshot(human, "commons").sequence, "someone else's setup and posts are news to a member who wrote nothing");
  assert.equal(storedCursor(store, "owner"), null, "reading a snapshot never writes a caught-up marker");
});

test("explicit acknowledgement still moves the marker and never goes backwards", t => {
  const { store, human, other } = fixture(t);
  const H = store.returnBrief(human, "commons").history.evaluatedThrough;
  store.markCaughtUp(human, "commons", H);
  const mine = post(store, human, "mine").sequence;
  assert.equal(store.markCaughtUp(human, "commons", H).cursor, H, "the stored marker is only what was acknowledged");
  assert.equal(store.returnBrief(human, "commons").history.cursor, mine, "the visible marker skips your own post");
  post(store, other, "theirs");
  const brief = store.returnBrief(human, "commons");
  assert.equal(changes(brief), 1);
  store.markCaughtUp(human, "commons", brief.history.evaluatedThrough);
  assert.equal(changes(store.returnBrief(human, "commons")), 0);
  assert.equal(storedCursor(store, "human"), brief.history.evaluatedThrough);
});

test("GET /return-brief over HTTP reports zero changes after only your own posts", async t => {
  const { store, owner } = fixture(t);
  for (let i = 1; i <= 3; i++) post(store, owner, `mine ${i}`);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/rooms/commons/return-brief`, { headers: { Authorization: `Bearer ${owner}` } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.history.evaluatedThrough - body.history.cursor, 0);
  assert.deepEqual(body.history.items, []);
});
