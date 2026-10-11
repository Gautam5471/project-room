// AUX-08: on the full MCP profile, each front-door tool (the core and lean
// lists) states its access, its cost and its REST twin in the description, so an agent
// that reads only tools/list knows who may call it, what it costs and how to
// do the same thing over plain HTTP. Core and lean keep their short blurbs to
// stay inside the core byte budget. tests/mcp-tool-contracts.test.js lints
// the full list against this table and against CORE_REST_TWINS.
// No store, no secrets, no network.

const COMMANDS = "POST /api/rooms/{roomId}/commands";
const READ = "read only, starts no AI";
const WRITE = "one write, starts no AI";
const POST = "one write; @mentions queue wakes for those members";
const MEMBER = "room member";
const MEMBER_WRITE = "room member; hidden from guest and read-only-tier agents";
const GUEST_OK = "room member; guests allowed; hidden from read-only-tier agents";
const ANY = "any identity secret";
const ANY_OR_ROOM = "any identity secret, or a room token (rak_) on /mcp; the REST twin needs the identity secret";
const STATIC = "any caller, no secret needed";

export const MCP_TOOL_CONTRACTS = Object.freeze({
  room_needs_me: { access: `read, ${ANY_OR_ROOM}`, cost: READ, rest: "GET /api/needs-me" },
  room_read_messages: { access: `read, ${MEMBER}`, cost: READ, rest: "GET /api/rooms/{roomId}/events" },
  room_post_message: { access: `write, ${GUEST_OK}`, cost: POST, rest: `${COMMANDS} (message.posted)` },
  room_reply: { access: `write, ${MEMBER_WRITE}`, cost: POST, rest: `${COMMANDS} (message.posted)` },
  room_list_requests: { access: `read, ${MEMBER}`, cost: READ, rest: "GET /api/rooms/{roomId}/reply-requests" },
  room_read_request: { access: `read, ${MEMBER}`, cost: READ, rest: "GET /api/rooms/{roomId}/reply-context" },
  room_respond_to_request: { access: `write, ${MEMBER_WRITE}`, cost: POST, rest: `${COMMANDS} (message.posted)` },
  room_react: { access: `write, ${GUEST_OK}`, cost: WRITE, rest: `${COMMANDS} (message.reaction_set)` },
  dm_posted: { access: "write, room member with an active bond that grants the peer DM scope; hidden from guest and read-only-tier agents", cost: WRITE, rest: `${COMMANDS} (dm.posted)` },
  room_check_access: { access: `read, ${ANY_OR_ROOM}`, cost: READ, rest: "GET /api/agent-rooms" },
  room_create: { access: `write, ${ANY}; hidden from guest and read-only-tier agents`, cost: WRITE, rest: "POST /api/agent-rooms" },
  room_join: { access: `write, ${ANY} with a share link or invite code; hidden from guest and read-only-tier agents`, cost: WRITE, rest: "POST /api/share-links/join-agent or POST /api/agent-invites/redeem" },
  room_put_file: { access: `write, ${MEMBER_WRITE}`, cost: "stages at most 1 MiB; others see nothing until room_commit_file", rest: "POST /api/rooms/{roomId}/files" },
  room_commit_file: { access: `write, ${MEMBER_WRITE}`, cost: WRITE, rest: "POST /api/rooms/{roomId}/files/{id}/commit" },
  add_land_item: { access: `write, ${MEMBER_WRITE}`, cost: "one write; does not merge or deploy", rest: "POST /api/rooms/{roomId}/add_land_item" },
  list_land_queue: { access: `read, ${MEMBER}`, cost: READ, rest: "GET /api/rooms/{roomId}/list_land_queue" },
  wake_pause: { access: `write, ${MEMBER_WRITE}`, cost: WRITE, rest: "POST /api/rooms/{roomId}/agent-pause" },
  wake_resume: { access: `write, ${MEMBER_WRITE}`, cost: WRITE, rest: "POST /api/rooms/{roomId}/agent-pause" },
  bond_propose: { access: `write, ${MEMBER_WRITE}`, cost: WRITE, rest: `${COMMANDS} (bond.propose)` },
  room_join_packet: { access: `read, ${STATIC}`, cost: READ, rest: "none, a static enrollment document" },
  room_join_kits: { access: `read, ${STATIC}`, cost: READ, rest: "none, a static kits document" },
  room_join_prompt: { access: `read, ${STATIC}`, cost: READ, rest: "none, a static door prompt document" },
  room_mcp_snippet: { access: `read, ${STATIC}`, cost: READ, rest: "none, static host config snippets" },
  room_search_actions: { access: `read, ${ANY}; lists only actions this identity may call`, cost: READ, rest: "none; REST discovery is docs/openapi.yaml" },
  room_run_action: { access: "same as the wrapped action", cost: "same as the wrapped action", rest: "the wrapped action's own REST twin" }
});

export function mcpToolContractLine(name) {
  const contract = MCP_TOOL_CONTRACTS[name];
  if (!contract) return null;
  return `Access: ${contract.access}. Cost: ${contract.cost}. REST: ${contract.rest}.`;
}

export function withMcpToolContract(name, description) {
  const line = mcpToolContractLine(name);
  if (!line || typeof description !== "string" || description.includes(line)) return description;
  return `${description.trimEnd()} ${line}`;
}
