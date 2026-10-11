// MCP front door: opt-in lean profile, room_search_actions and room_run_action.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { listedMcpTools } from "../server/mcp-discovery.mjs";
import { LEAN_MCP_TOOLS, searchActions, isRunnableAction } from "../server/mcp-action-search.mjs";
import { hostedMcpToolDefs } from "../server/mcp-hosted-tools.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-mcp-search-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const rooms = new AgentRooms(store);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, store, rooms };
}

async function rpc(origin, method, params, secret) {
  const response = await fetch(`${origin}/room/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method, params })
  });
  return response.json();
}

async function member(t) {
  const env = await serve(t);
  const ada = env.store.identities.create("Ada");
  env.rooms.create(ada.secret, { roomId: "ada-den", title: "Ada den", purpose: "Search actions", kind: "personal", displayName: "Ada" });
  return { ...env, secret: ada.secret };
}

// operationId is minted per call; everything else must match.
const stable = body => JSON.parse(JSON.stringify(body, (key, value) => key === "operationId" ? undefined : value));
const size = tools => JSON.stringify(tools).length;

test("lean is opt-in: default core and full lists are unchanged, lean is short and much smaller", () => {
  const core = listedMcpTools("core"), full = listedMcpTools("full"), lean = listedMcpTools("lean");
  assert.equal(core.length, 23, "default core is unchanged until the flip is agreed");
  assert.equal(full.length, 118, "full is unchanged");
  assert.ok(!core.some(tool => tool.name === "room_search_actions"), "meta tools are not added to core");
  const names = lean.map(tool => tool.name);
  for (const name of LEAN_MCP_TOOLS) assert.ok(names.includes(name), `lean lists ${name}`);
  assert.ok(lean.every(Boolean) && names.every(name => typeof name === "string"));
  assert.ok(size(lean) < size(core) * 0.75, `lean ${size(lean)} B should be well under core ${size(core)} B`);
});

test("every lean name is a real definition or join tool", () => {
  for (const tool of listedMcpTools("lean")) assert.ok(tool.inputSchema && tool.description, tool.name);
});

test("search finds long-tail tools with their exact schema and REST route", () => {
  const close = searchActions("close board claim");
  assert.equal(close.matches[0].name, "room_close_work_claim");
  const def = hostedMcpToolDefs.find(tool => tool.name === "room_close_work_claim");
  assert.deepEqual(close.matches[0].inputSchema, def.inputSchema);
  const land = searchActions("land queue remove", { limit: 3 });
  assert.ok(land.matches.some(match => match.name === "remove_land_item"));
  assert.ok(land.matches.length <= 3);
  const withRest = searchActions("squads list").matches.find(match => match.name === "squads_list");
  assert.match(withRest.rest, /^GET \/api\/rooms\/:roomId\/squads/);
  assert.deepEqual(searchActions("zzzz qqqq").matches, []);
});

test("run_action refuses itself, search, join and public-work tools, and unknown names", () => {
  for (const name of ["room_run_action", "room_search_actions", "room_join_packet", "public_work_claim", "nope"]) {
    assert.equal(isRunnableAction(name), false, name);
  }
  assert.equal(isRunnableAction("squads_list"), true);
});

test("over MCP: lean list, search, then run a long-tail action with the same result as a direct call", async t => {
  const { origin, secret } = await member(t);
  const listed = await rpc(origin, "tools/list", { profile: "lean" }, secret);
  assert.equal(listed.result.profile, "lean");
  assert.ok(listed.result.tools.some(tool => tool.name === "room_search_actions"));

  const found = await rpc(origin, "tools/call", { name: "room_search_actions", arguments: { query: "list squads" } }, secret);
  assert.equal(found.result.isError, undefined);
  assert.ok(found.result.structuredContent.matches.some(match => match.name === "squads_list"));

  const direct = await rpc(origin, "tools/call", { name: "squads_list", arguments: { roomId: "ada-den" } }, secret);
  const viaRun = await rpc(origin, "tools/call", { name: "room_run_action", arguments: { name: "squads_list", arguments: { roomId: "ada-den" } } }, secret);
  assert.deepEqual(stable(viaRun.result), stable(direct.result), "run_action returns exactly what the direct call returns");

  // Argument checks still apply inside run_action.
  const badInner = await rpc(origin, "tools/call", { name: "room_run_action", arguments: { name: "squads_list", arguments: { roomId: "ada-den", bogus: 1 } } }, secret);
  const badDirect = await rpc(origin, "tools/call", { name: "squads_list", arguments: { roomId: "ada-den", bogus: 1 } }, secret);
  assert.deepEqual(stable(badInner), stable(badDirect));

  // Room access is still checked: a room this identity is not in.
  const foreign = await rpc(origin, "tools/call", { name: "room_run_action", arguments: { name: "squads_list", arguments: { roomId: "not-my-room" } } }, secret);
  const foreignDirect = await rpc(origin, "tools/call", { name: "squads_list", arguments: { roomId: "not-my-room" } }, secret);
  assert.deepEqual(stable(foreign), stable(foreignDirect));

  const recursion = await rpc(origin, "tools/call", { name: "room_run_action", arguments: { name: "room_run_action", arguments: {} } }, secret);
  assert.ok(recursion.error || recursion.result?.isError, "run_action cannot call itself");

  const badSearch = await rpc(origin, "tools/call", { name: "room_search_actions", arguments: { query: "" } }, secret);
  assert.ok(badSearch.error || badSearch.result?.isError, "empty query is refused");

  const badProfile = await rpc(origin, "tools/list", { profile: "tiny" }, secret);
  assert.ok(badProfile.error || badProfile.result?.isError);
});

test("meta tools need an identity: anonymous calls are refused", async t => {
  const { origin } = await serve(t);
  const response = await fetch(`${origin}/room/mcp`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method: "tools/call", params: { name: "room_search_actions", arguments: { query: "squads" } } })
  });
  const body = await response.json();
  assert.ok(body.error || body.result?.isError, "no anonymous search");
});
