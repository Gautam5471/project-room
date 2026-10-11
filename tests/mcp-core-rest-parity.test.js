// Every core MCP tool has a REST twin (Potter's MCP front-door principle,
// 2026-10-10): MCP stays the easy door, and anything an agent does through it
// can also be done over plain HTTP. This pins the twin for each tool in the
// default core list against docs/openapi.yaml (path and method) and, for the
// command-shaped tools, against the event catalog. The openapi served-routes
// tests already prove each documented path is really served.
// Adding a tool to the core list without a twin (or an explicit exemption
// with a reason) fails here.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { listedMcpTools } from "../server/mcp-discovery.mjs";
import { EVENT_TYPES } from "../src/events.js";
import { Bonds } from "../server/bonds.mjs";

const commands = "POST /api/rooms/{roomId}/commands";
export const CORE_REST_TWINS = Object.freeze({
  room_needs_me: ["GET /api/needs-me"],
  room_read_messages: ["GET /api/rooms/{roomId}/events"],
  room_post_message: [commands, { event: "message.posted" }],
  room_reply: [commands, { event: "message.posted" }],
  room_respond_to_request: [commands, { event: "message.posted" }],
  room_react: [commands, { event: "message.reaction_set" }],
  dm_posted: [commands, { event: "dm.posted" }],
  bond_propose: [commands, { event: "bond.propose" }],
  room_list_requests: ["GET /api/rooms/{roomId}/reply-requests"],
  room_read_request: ["GET /api/rooms/{roomId}/reply-context"],
  room_check_access: ["GET /api/agent-rooms"],
  room_create: ["POST /api/agent-rooms"],
  room_join: ["POST /api/share-links/join-agent", "POST /api/agent-invites/redeem"],
  room_put_file: ["POST /api/rooms/{roomId}/files"],
  room_commit_file: ["POST /api/rooms/{roomId}/files/{id}/commit"],
  add_land_item: ["POST /api/rooms/{roomId}/add_land_item"],
  list_land_queue: ["GET /api/rooms/{roomId}/list_land_queue"],
  wake_pause: ["POST /api/rooms/{roomId}/agent-pause"],
  wake_resume: ["POST /api/rooms/{roomId}/agent-pause"]
});

// Static join documents, served as plain files rather than API routes.
export const CORE_REST_EXEMPT = Object.freeze({
  room_join_packet: "the llms.txt enrollment packet, a static document",
  room_join_kits: "the kits catalog, a static document",
  room_join_prompt: "the one-paste door prompt (/join.txt), a static document",
  room_mcp_snippet: "host config snippets for this MCP URL, a static document",
  room_search_actions: "MCP-only discovery aid; REST discovery is docs/openapi.yaml itself",
  room_run_action: "MCP-only wrapper that re-enters tools/call; every wrapped tool has its own twin"
});

function documentedOperations() {
  const lines = readFileSync(new URL("../docs/openapi.yaml", import.meta.url), "utf8").split("\n");
  const operations = new Set();
  let path = null;
  for (const line of lines) {
    const pathMatch = /^  (\/[^:]+):\s*$/.exec(line);
    if (pathMatch) { path = pathMatch[1]; continue; }
    if (/^\S/.test(line)) path = null;
    const methodMatch = /^    (get|post|put|patch|delete):/.exec(line);
    if (path && methodMatch) operations.add(`${methodMatch[1].toUpperCase()} ${path}`);
  }
  return operations;
}

test("every tool in the default core list has a REST twin or a stated exemption", () => {
  const core = listedMcpTools("core").map(tool => tool.name);
  assert.ok(core.length >= 10, "core list is real");
  const missing = core.filter(name => !CORE_REST_TWINS[name] && !CORE_REST_EXEMPT[name]);
  assert.deepEqual(missing, [], `core MCP tools without a REST twin: ${missing.join(", ")}`);
});

test("each REST twin is a documented operation, and command twins name a real event", () => {
  const operations = documentedOperations();
  assert.ok(operations.size > 100, "openapi parsed");
  const events = new Set(Object.values(EVENT_TYPES));
  // Bond commands are handled by the bond service, not stored under their own event name.
  const accepted = type => events.has(type) || Bonds.prototype.handles.call(null, type);
  for (const [tool, twin] of Object.entries(CORE_REST_TWINS)) {
    for (const entry of twin) {
      if (typeof entry === "string") assert.ok(operations.has(entry), `${tool}: ${entry} is not in docs/openapi.yaml`);
      else assert.ok(accepted(entry.event), `${tool}: command ${entry.event} is not an accepted command type`);
    }
  }
});

test("exemptions stay honest: an exempt tool is not given a twin, and nothing stale is listed", () => {
  const full = new Set(listedMcpTools("full").map(tool => tool.name));
  for (const name of [...Object.keys(CORE_REST_TWINS), ...Object.keys(CORE_REST_EXEMPT)]) {
    if (name === "room_search_actions" || name === "room_run_action") continue; // lean-only meta tools
    assert.ok(full.has(name), `${name} is no longer a served tool; drop it from the parity table`);
  }
  for (const name of Object.keys(CORE_REST_EXEMPT)) assert.ok(!CORE_REST_TWINS[name], `${name} is both exempt and twinned`);
});
