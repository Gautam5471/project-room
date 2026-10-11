// The minter of a one-time agent code sees "<name> joined with a one-time code" in Updates.
// Nobody else does, and joinedVia accepts nothing but that one value.
import test from "node:test";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-agent-joined-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = "GET", token, data } = {}) => {
    const res = await fetch(origin + path, { method, headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { "Content-Type": "application/json" } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  return { store, ownerKey, call };
}

test("the owner who minted a one-time code sees the agent that joined with it, and only they do", async t => {
  const { store, ownerKey, call } = await serve(t);
  const minted = await call("/api/rooms/commons/agent-invites", { method: "POST", token: ownerKey, data: { permissions: ["accept_work"], expiresInMinutes: 60, displayName: "Plug Bot" } });
  assert.equal(minted.status, 201, JSON.stringify(minted.json));
  const before = await call("/api/rooms/commons/updates", { token: ownerKey });
  assert.equal(before.json.items.filter(item => item.kind === "agent_joined").length, 0, "nothing before the code is used");
  const redeemed = await call("/api/agent-invites/redeem", { method: "POST", data: { code: minted.json.code, displayName: "Plug Bot" } });
  assert.equal(redeemed.status, 201, JSON.stringify(redeemed.json));
  const listed = await call("/api/rooms/commons/updates", { token: ownerKey });
  const joined = listed.json.items.filter(item => item.kind === "agent_joined");
  assert.equal(joined.length, 1, JSON.stringify(listed.json.items.map(u => u.kind)));
  assert.equal(joined[0].title, "Plug Bot joined with a one-time code");
  assert.equal(joined[0].state, "unread");
  // The item names the member, not the code or any credential.
  const text = JSON.stringify(joined[0]);
  assert.ok(!text.includes(minted.json.code) && !text.includes("RM-"), "no code value in the item");
  // Another member never gets it (the event is in the shared log; the viewer check is in Updates).
  store.command(ownerKey, "commons", { id: "11111111-1111-4111-8111-111111111111", type: "member.added", data: { memberId: "other", displayName: "Other Person", kind: "human", permissions: [] } });
  const otherKey = store.issueAccessKey("commons", "other");
  const otherView = await call("/api/rooms/commons/updates", { token: otherKey });
  assert.equal(otherView.status, 200, JSON.stringify(otherView.json));
  assert.equal(otherView.json.items.filter(item => item.kind === "agent_joined").length, 0);
  // The owner can mark it done like any other update.
  const done = await call(`/api/rooms/commons/updates/${joined[0].id}/done`, { method: "POST", token: ownerKey, data: { requestId: "done-1", expectedBasis: joined[0].basisToken } });
  assert.ok([200, 201].includes(done.status), JSON.stringify(done.json));
  const after = await call("/api/rooms/commons/updates", { token: ownerKey });
  assert.equal(after.json.items.filter(item => item.kind === "agent_joined").length, 0, "handled items leave the actionable list");
  assert.equal(store.room("commons").state.members[joined[0].sourceRef.memberId].joinedVia, undefined, "the projection does not grow a field");
});

test("joinedVia accepts only the one-time-code value", async t => {
  const { store, ownerKey } = await serve(t);
  const add = joinedVia => store.command(ownerKey, "commons", { id: crypto.randomUUID(), type: "member.added", data: { memberId: "x-agent", displayName: "X", kind: "agent", permissions: ["accept_work"], joinedVia } });
  assert.throws(() => add("somewhere-else"), /joinedVia/);
  assert.doesNotThrow(() => add("one-time-code"));
});
