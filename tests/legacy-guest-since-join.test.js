import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

// Potter, Oct 10 2026: a link guest (or guest agent) in a room created before
// historyDefaultsVersion 1 reads only from their join, the same as a v1 room.
// The default is computed, never written: old logs replay unchanged, and an
// owner's explicit "all" still restores full history.

const BEFORE = "legacy-before-7d2e";
const AFTER = "legacy-after-7d2f";

async function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "legacy-guest-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom()); // bootstrap room: no historyDefaultsVersion
  const ownerKey = store.issueAccessKey("commons", "owner");
  const cmd = (type, data) => store.command(ownerKey, "commons", { id: randomUUID(), type, data });
  assert.equal(store.room("commons").state.room.historyDefaultsVersion ?? null, null, "fixture is a legacy room");
  cmd(T.MESSAGE_POSTED, { messageId: "before", body: BEFORE });
  const guest = `guest-${randomUUID()}`, guestAgent = "guest-agent-0123456789abcdef01234567";
  cmd(T.MEMBER_ADDED, { memberId: guest, displayName: "Link guest", kind: "human", permissions: [] });
  cmd(T.MEMBER_ADDED, { memberId: guestAgent, displayName: "Guest agent", kind: "agent", permissions: [], accountableHumanId: "owner" });
  cmd(T.MEMBER_ADDED, { memberId: "teammate-agent", displayName: "Teammate", kind: "agent", permissions: [], accountableHumanId: "owner" });
  cmd(T.MESSAGE_POSTED, { messageId: "after", body: AFTER });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const read = async member => {
    const key = store.issueAccessKey("commons", member);
    const get = path => fetch(origin + path, { headers: { Origin: origin, Authorization: `Bearer ${key}` } });
    const snapshot = await (await get("/api/rooms/commons")).json();
    const events = await (await get("/api/rooms/commons/events?after=0&limit=200")).text();
    const search = await (await get(`/api/rooms/commons/search?q=${BEFORE}`)).json();
    return { ids: snapshot.state.messages.map(m => m.id).filter(id => id === "before" || id === "after"),
      eventsLeak: events.includes(BEFORE), searchHits: search.messages.length };
  };
  return { store, cmd, guest, guestAgent, read };
}

test("legacy room: link guests and guest agents read only from their join", async t => {
  const f = await setup(t);
  for (const member of [f.guest, f.guestAgent]) {
    const seen = await f.read(member);
    assert.deepEqual(seen.ids, ["after"], `${member} snapshot`);
    assert.equal(seen.eventsLeak, false, `${member} event log`);
    assert.equal(seen.searchHits, 0, `${member} search`);
  }
});

test("legacy room: the owner and non-guest members keep full history", async t => {
  const f = await setup(t);
  assert.deepEqual((await f.read("owner")).ids, ["before", "after"]);
  assert.deepEqual((await f.read("teammate-agent")).ids, ["before", "after"]);
});

test("legacy room: an explicit 'all' from the owner restores guest history; 'since_join' keeps it hidden", async t => {
  const f = await setup(t);
  f.cmd(T.ROOM_HISTORY_VISIBILITY_SET, { historyVisibility: "all" });
  assert.deepEqual((await f.read(f.guest)).ids, ["before", "after"]);
  f.cmd(T.ROOM_HISTORY_VISIBILITY_SET, { historyVisibility: "since_join" });
  assert.deepEqual((await f.read(f.guest)).ids, ["after"]);
  assert.equal("historyDefaultsVersion" in f.store.room("commons").state.room, false, "no defaults field is written by the change");
});
