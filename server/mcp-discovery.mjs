import { anonymousPublicWorkMcpTools, publicWorkMcpDefinitions } from './mcp-public-work.mjs';
import { anonymousIdentityMintMcpTools } from './mcp-identity-mint.mjs';
// Binds the one server card to the tool lists the hosted MCP actually serves.
import { MCP_SUPPORTED_VERSIONS } from "../client/mcp-stdio.mjs";
import { ROOM_ORIGIN, ROOM_SOURCE, bindLiveMcpServerCard } from "../deploy/agent-discovery.mjs";
import { ROOM_MCP_PUBLIC_URL, ROOM_MCP_SERVER_VERSION, CORE_MCP_TOOLS, CORE_MCP_BLURBS, mcpToolAlias } from "../src/room-mcp-join.js";
import { renderMcpServerCardJson } from "../src/mcp-server-card.mjs";
import { MCP_JOIN_TOOLS } from "./mcp-http.mjs";
import { hostedMcpToolDefs } from "./mcp-hosted-tools.mjs";
import { capabilityVisibleTo } from "./capability-visibility.mjs";
import { withOpenWorldHint } from "./content-trust.mjs";
import { LEAN_MCP_TOOLS, actionMetaToolDefs } from "./mcp-action-search.mjs";

export function livePublicMcpTools() {
  return [...MCP_JOIN_TOOLS, ...anonymousPublicWorkMcpTools, ...anonymousIdentityMintMcpTools].map(withOpenWorldHint);
}

// Same list tools/list returns. Default is the core profile (short blurbs,
// snake_case names). profile "full" is the whole catalog. aliases adds the
// hidden dotted names. The server card uses the default so it matches a
// bearer tools/list with no profile argument.
// The optional agent descriptor (see server/capability-visibility.mjs)
// filters BEFORE listing: withheld, never refused. A capability the
// agent's grants/tiers do not admit is ABSENT from the returned catalog —
// never present-but-denying. Omit it for the public/unfiltered lists
// (server card, join surface), which stay full by design.
const FOCUS_COMMON_TOOLS = [
  "room_assistant_context", "room_check_access", "room_needs_me", "get_room_context", "room_read_request",
  "room_list_requests", "room_reply", "room_respond_to_request", "room_request_reply", "room_post_message"
];

// Actor-selected discovery views, not permission or execution profiles. Include
// advanced tools from the full catalog without changing direct-call availability.
export const MCP_TOOL_FOCUSES = Object.freeze({
  public_work: [],
  conversation: ["room_read_inbox", "room_read_messages", "room_react", "room_request_history", "room_cancel_request", "bond_list", "bond_accept", "bond_decline", "bond_revoke", "room_list_peer_dms", "dm_posted"],
  work: ["room_assistant_action", "room_list_work", "room_read_work", "room_read_work_discussion", "room_read_result",
    "room_propose_work", "room_begin_work", "room_accept_work", "room_start_work", "room_block_work",
    "room_resolve_blocker", "room_post_draft", "room_submit_text_result", "room_record_completion",
    "room_record_handoff", "room_acquire_claim", "room_renew_claim", "room_release_claim", "room_link_work_claim_pr",
    "room_work_claim_provenance",
    "room_list_files", "room_get_file", "room_put_file", "room_commit_file"],
  review: ["room_list_work", "room_read_work", "room_read_work_discussion", "room_read_result",
    "room_record_verification", "room_list_files", "room_get_file", "list_land_queue"],
  automation: ["wake_register", "wake_clear", "wake_pause", "wake_resume", "heartbeat_set",
    "heartbeat_get", "heartbeat_ack", "webhook_subscribe", "webhook_list", "webhook_unsubscribe"]
});

export function listedMcpTools(profile = "core", aliases = false, agent = null, focus = undefined) {
  const outside = focus === "public_work" || (profile === "core" && focus === undefined && agent && !(agent.memberships ?? []).some(member => member.active !== false));
  if (outside) return [...MCP_JOIN_TOOLS, ...publicWorkMcpDefinitions].map(withOpenWorldHint);
  const focusedNames = focus === undefined ? null : new Set([...FOCUS_COMMON_TOOLS, ...MCP_TOOL_FOCUSES[focus]]);
  // profile "lean" (opt-in): a short front door plus room_search_actions and
  // room_run_action for the long tail. The meta tools are listed only here;
  // they stay callable on every profile.
  const leanDefs = [...hostedMcpToolDefs, ...actionMetaToolDefs];
  const source = focusedNames
    ? hostedMcpToolDefs.filter(entry => focusedNames.has(entry.name))
    : profile === "lean"
    ? LEAN_MCP_TOOLS.map(name => leanDefs.find(entry => entry.name === name))
    : profile === "full"
    ? hostedMcpToolDefs
    : CORE_MCP_TOOLS.map(name => hostedMcpToolDefs.find(entry => entry.name === name));
  const tools = source.map(entry => {
    const description = (profile === "core" || profile === "lean") && CORE_MCP_BLURBS[entry.name] ? CORE_MCP_BLURBS[entry.name] : entry.description;
    const alias = mcpToolAlias(entry.name);
    return {
      ...entry,
      description,
      ...(aliases && alias ? { aliases: [alias] } : {})
    };
  });
  const listed = [...tools, ...MCP_JOIN_TOOLS];
  return [...(agent ? listed.filter(tool => capabilityVisibleTo(agent, tool)) : listed), ...(profile === "full" ? publicWorkMcpDefinitions : [])].map(withOpenWorldHint);
}

export function liveEnrolledMcpTools() {
  return listedMcpTools("core", false, null, "public_work");
}

export function liveMcpServerCardJson() {
  return renderMcpServerCardJson({
    publicTools: livePublicMcpTools(),
    enrolledTools: liveEnrolledMcpTools(),
    url: ROOM_MCP_PUBLIC_URL,
    mint: `${ROOM_ORIGIN}/api/agent-identities`,
    version: ROOM_MCP_SERVER_VERSION,
    protocolVersions: MCP_SUPPORTED_VERSIONS,
    websiteUrl: ROOM_ORIGIN,
    repositoryUrl: ROOM_SOURCE
  });
}

bindLiveMcpServerCard(liveMcpServerCardJson);
