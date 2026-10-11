// MCP front door (Potter, 2026-10-10): a short default list plus a way to
// reach the long tail without loading the whole catalog into the model.
//
// room_search_actions finds hosted tools by words in their name and
// description and returns each match's exact inputSchema, so an agent can
// call it directly. room_run_action calls one of those tools by name for
// clients that only let the model use listed tools. It re-enters the same
// tools/call path, so argument checks, scopes, autonomy tiers, spend and
// receipts are exactly what a direct call gets. Neither tool grants anything.
// Search is filtered by the same capabilityVisibleTo predicate as tools/list:
// a tool this agent may not use is absent, never present-but-denying.
import { hostedMcpToolDefs } from "./mcp-hosted-tools.mjs";
import { capabilityVisibleTo } from "./capability-visibility.mjs";

export const SEARCH_ACTIONS_TOOL = "room_search_actions";
export const RUN_ACTION_TOOL = "room_run_action";
export const ACTION_META_TOOL_NAMES = Object.freeze([SEARCH_ACTIONS_TOOL, RUN_ACTION_TOOL]);

const MAX_RESULTS = 10;
const DEFAULT_RESULTS = 5;

export const actionMetaToolDefs = Object.freeze([
  {
    name: SEARCH_ACTIONS_TOOL,
    description: "Find a Room action that isn't in this short list. Pass query (plain words, for example \"close board claim\" or \"upload file\"). Returns up to limit matches with each tool's exact inputSchema and its REST route when there is one. Call a match directly, or through room_run_action. Read only; grants nothing.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 200 },
        limit: { type: "integer", minimum: 1, maximum: MAX_RESULTS }
      },
      required: ["query"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: RUN_ACTION_TOOL,
    description: "Run one Room action found with room_search_actions. Pass name and arguments exactly as its inputSchema says. Same checks, scopes, costs and receipts as calling that tool directly; retry unchanged with the same ids.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 64 },
        arguments: { type: "object" }
      },
      required: ["name"],
      additionalProperties: false
    },
    // The wrapped action decides what happens; this wrapper can write.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }
]);

// The lean default under discussion: read, post, needs-me, answer a formal
// request, access, join, stop wakes, plus search and run for everything else.
export const LEAN_MCP_TOOLS = Object.freeze([
  "room_needs_me",
  "room_read_messages",
  "room_post_message",
  "room_read_request",
  "room_respond_to_request",
  "room_check_access",
  "room_join",
  "wake_pause",
  SEARCH_ACTIONS_TOOL,
  RUN_ACTION_TOOL
]);

const words = text => String(text ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 1);
const REST_ROUTE = /\b(GET|POST|PUT|PATCH|DELETE) (\/api\/[A-Za-z0-9_:{}\/.-]+)/;

export function restRouteOf(tool) {
  const match = REST_ROUTE.exec(tool.description ?? "");
  return match ? `${match[1]} ${match[2]}` : null;
}

function firstSentence(text) {
  const value = String(text ?? "");
  const end = value.search(/\.(\s|$)/);
  return end === -1 ? value.slice(0, 200) : value.slice(0, end + 1);
}

export function validSearchActionsArgs(args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return false;
  if (!Object.keys(args).every(key => key === "query" || key === "limit")) return false;
  if (typeof args.query !== "string" || args.query.trim().length === 0 || args.query.length > 200) return false;
  return args.limit === undefined || Number.isInteger(args.limit) && args.limit >= 1 && args.limit <= MAX_RESULTS;
}

export function validRunActionArgs(args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return false;
  if (!Object.keys(args).every(key => key === "name" || key === "arguments")) return false;
  if (typeof args.name !== "string" || args.name.length === 0 || args.name.length > 64) return false;
  return args.arguments === undefined || args.arguments !== null && typeof args.arguments === "object" && !Array.isArray(args.arguments);
}

// Name words count three times as much as description words; ties keep
// catalog order, so the result is deterministic.
export function searchActions(query, { agent = null, limit = DEFAULT_RESULTS, tools = hostedMcpToolDefs } = {}) {
  const terms = [...new Set(words(query))];
  const visible = agent ? tools.filter(tool => capabilityVisibleTo(agent, tool)) : tools;
  const scored = [];
  visible.forEach((tool, index) => {
    const nameWords = new Set(words(tool.name));
    const descriptionWords = new Set(words(tool.description));
    let score = 0;
    for (const term of terms) {
      if (nameWords.has(term)) score += 3;
      else if ([...nameWords].some(word => word.startsWith(term) || term.startsWith(word) && word.length > 3)) score += 2;
      if (descriptionWords.has(term)) score += 1;
    }
    if (score > 0) scored.push({ score, index, tool });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const matches = scored.slice(0, limit).map(({ tool }) => ({
    name: tool.name,
    summary: firstSentence(tool.description),
    readOnly: tool.annotations?.readOnlyHint === true,
    rest: restRouteOf(tool),
    inputSchema: tool.inputSchema
  }));
  return {
    query,
    matches,
    totalMatches: scored.length,
    next: matches.length === 0
      ? "No match. Try other words, or list everything with tools/list profile=full."
      : "Call a match directly with its inputSchema, or use room_run_action { name, arguments }."
  };
}

export function isRunnableAction(name) {
  return typeof name === "string" && !ACTION_META_TOOL_NAMES.includes(name) && hostedMcpToolDefs.some(tool => tool.name === name);
}
