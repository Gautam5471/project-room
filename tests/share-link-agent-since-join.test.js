import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T, HISTORY_DEFAULTS_VERSION } from "../src/events.js";

// priv-share-link-agent-reads-full-history-20261011 (found on prod dd0a2d52):
// an agent that joins through a guest share link (POST /api/share-links/join-agent)
// is a link guest, the same as a human who joins through that link. Without an
// owner choice it reads only from its join. Its member id is its identity id,
// so the rule keys on how it joined (recorded on member.added), not on the id.

const BEFORE = "sla-before-4b1c";
const AFTER = "sla-after-4b1d";

async function setup(t, { v1 = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "share-agent-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const seed = initialRoom(); // no historyDefaultsVersion: older-style room
  if (v1) seed[0].data.historyDefaultsVersion = HISTORY_DEFAULTS_VERSION;
  store.initialize(seed);
  const ownerKey = store.issueAccessKey("commons", "owner");
  const cmd = (type, data) => store.command(ownerKey, "commons", { id: randomUUID(), type, data });
  cmd(T.MESSAGE_POSTED, { messageId: "before", body: BEFORE });
  const joinLink = (access, name) => {
    const linkToken = randomBytes(32).toString("base64url");
    store.shareLinks.create(ownerKey, "commons", {
      requestId: randomUUID(), linkToken, expiresAt: Date.now() + 3600000, maxJoins: 2,
      expectedMemberRevision: store.room("commons").state.members.owner.revision,
      ...(access ? { access } : {}),
    }, null);
    const identity = store.identities.create(name);
    const joined = store.shareLinks.joinAgent(identity.secret, linkToken, name);
    return { memberId: joined.memberId, secret: identity.secret };
  };
  const guestAgent = joinLink(null, "Link agent");
  const memberAgent = joinLink("member", "Member agent");
  cmd(T.MESSAGE_POSTED, { messageId: "after", body: AFTER });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const read = async secret => {
    const get = path => fetch(origin + path, { headers: { Origin: origin, Authorization: `Bearer ${secret}` } });
    const snapshot = await (await get("/api/rooms/commons")).json();
    const events = await (await get("/api/rooms/commons/events?after=0&limit=200")).text();
    const search = await (await get(`/api/rooms/commons/search?q=${BEFORE}`)).json();
    return { ids: snapshot.state.messages.map(m => m.id).filter(id => id === "before" || id === "after"),
      eventsLeak: events.includes(BEFORE), searchHits: search.messages.length };
  };
  return { store, cmd, guestAgent, memberAgent, read };
}

test("an agent that joins by guest share link reads only from its join", async t => {
  const f = await setup(t);
  const seen = await f.read(f.guestAgent.secret);
  assert.deepEqual(seen.ids, ["after"], "snapshot");
  assert.equal(seen.eventsLeak, false, "event log");
  assert.equal(seen.searchHits, 0, "search");
});

test("an agent that joins by a member-access share link keeps full history", async t => {
  const f = await setup(t);
  assert.deepEqual((await f.read(f.memberAgent.secret)).ids, ["before", "after"]);
});

test("the owner's explicit 'all' restores the link agent's history; 'since_join' hides it again", async t => {
  const f = await setup(t);
  f.cmd(T.ROOM_HISTORY_VISIBILITY_SET, { historyVisibility: "all" });
  assert.deepEqual((await f.read(f.guestAgent.secret)).ids, ["before", "after"]);
  f.cmd(T.ROOM_HISTORY_VISIBILITY_SET, { historyVisibility: "since_join" });
  assert.deepEqual((await f.read(f.guestAgent.secret)).ids, ["after"]);
});

test("v1 room (historyDefaultsVersion set): the guest-link agent also reads only from its join", async t => {
  const f = await setup(t, { v1: true });
  assert.equal(f.store.room("commons").state.room.historyDefaultsVersion, HISTORY_DEFAULTS_VERSION);
  assert.deepEqual((await f.read(f.guestAgent.secret)).ids, ["after"]);
  assert.deepEqual((await f.read(f.memberAgent.secret)).ids, ["before", "after"]);
});
