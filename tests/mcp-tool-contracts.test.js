// AUX-08 lint: on the full MCP profile, each front-door tool (core and lean
// lists) says its access, its cost and its REST twin in the served
// description. The REST twin must agree with the parity table in
// tests/mcp-core-rest-parity.test.js. Core and lean keep short blurbs; their
// byte budget is pinned in tests/mcp-core-profile.test.js.
// KNOWN_UNCOVERED is a ratchet: a new full-profile tool must ship with a
// contract, and a tool that gains one must leave this list (AUX-08b).
import test from "node:test";
import assert from "node:assert/strict";
import { listedMcpTools } from "../server/mcp-discovery.mjs";
import { MCP_TOOL_CONTRACTS, mcpToolContractLine, withMcpToolContract } from "../server/mcp-tool-contracts.mjs";
import { CORE_REST_TWINS, CORE_REST_EXEMPT } from "./mcp-core-rest-parity.test.js";

export const KNOWN_UNCOVERED = Object.freeze(new Set([
  "bond_accept", "bond_decline", "bond_list", "bond_revoke", "bounty_accept", "bounty_claim", "bounty_dispute",
  "bounty_finalize", "bounty_fund", "bounty_list", "bounty_post", "bounty_read_balances", "bounty_read_history",
  "bounty_submit", "bounty_transfer", "bounty_watch", "get_room_context", "heartbeat_ack", "heartbeat_get",
  "heartbeat_set", "identity_list_verified", "identity_read_verification", "inbox_discard_attachment",
  "inbox_get_attachment", "inbox_list_attachments", "inbox_put_attachment", "public_work_claim",
  "public_work_finish", "public_work_my_review", "public_work_read_task", "public_work_recommend",
  "public_work_release", "public_work_renew", "remove_land_item", "report_tip", "room_accept_work",
  "room_acquire_claim", "room_activation_pack", "room_assistant_action", "room_assistant_context",
  "room_begin_work", "room_block_work", "room_cancel_request", "room_clear_halt", "room_close_work_claim",
  "room_create_agent_invite", "room_decide_access_request", "room_decline_help_offer", "room_discard_file",
  "room_get_file", "room_introduce_outside_agent", "room_link_work_claim_pr", "room_list_access_requests",
  "room_list_agent_invites", "room_list_events", "room_list_files", "room_list_outside_agents",
  "room_list_peer_dms", "room_list_work", "room_member_card", "room_offer_help", "room_post_draft",
  "room_propose_work", "room_read_board", "room_read_inbox", "room_read_result", "room_read_work",
  "room_read_work_discussion", "room_record_completion", "room_record_handoff", "room_record_verification",
  "room_release_claim", "room_release_help_offer", "room_renew_claim", "room_request_history",
  "room_request_reply", "room_resolve_blocker", "room_revoke_agent_invite", "room_select_help_offer",
  "room_set_member_claim_cap", "room_start_work", "room_submit_text_result", "room_supersede_work",
  "room_withdraw_help_offer", "room_work_claim_provenance", "squads_create", "squads_disband",
  "squads_get", "squads_list", "squads_update_members", "wake_clear", "wake_register", "webhook_list",
  "webhook_subscribe", "webhook_unsubscribe"
]));

const CONTRACT_RE = /Access: (read|write|same as)[^.]*\. Cost: [^.]+\. REST: .+\.$/s;

test("full: every contracted tool states access, cost and REST twin", () => {
  const tools = listedMcpTools("full").filter(tool => MCP_TOOL_CONTRACTS[tool.name]);
  assert.ok(tools.length >= 20, "front door is real");
  const bad = tools.filter(tool => !CONTRACT_RE.test(tool.description) || !tool.description.endsWith(mcpToolContractLine(tool.name)));
  assert.deepEqual(bad.map(tool => tool.name), []);
});

test("full: every front-door tool on core and lean has a contract", () => {
  const front = new Set([...listedMcpTools("core"), ...listedMcpTools("lean")].map(tool => tool.name));
  assert.deepEqual([...front].filter(name => !MCP_TOOL_CONTRACTS[name]), []);
});

test("ratchet: no new full-profile tool without a contract, no stale exemption", () => {
  const names = listedMcpTools("full").map(tool => tool.name);
  const missing = names.filter(name => !MCP_TOOL_CONTRACTS[name] && !KNOWN_UNCOVERED.has(name));
  assert.deepEqual(missing, [], "new tools need an entry in server/mcp-tool-contracts.mjs");
  const stale = [...KNOWN_UNCOVERED].filter(name => MCP_TOOL_CONTRACTS[name] || !names.includes(name));
  assert.deepEqual(stale, [], "drop these from KNOWN_UNCOVERED");
});

test("core and lean stay short: no contract line", () => {
  for (const tool of [...listedMcpTools("core"), ...listedMcpTools("lean")]) {
    assert.ok(!tool.description.includes("Access: "), `${tool.name} carries the contract line on a short profile`);
  }
});

test("access word matches readOnlyHint", () => {
  for (const tool of listedMcpTools("full").filter(tool => MCP_TOOL_CONTRACTS[tool.name])) {
    const access = MCP_TOOL_CONTRACTS[tool.name].access;
    const read = tool.annotations?.readOnlyHint !== false;
    assert.equal(access.startsWith("read"), read, `${tool.name}: access "${access}" vs readOnlyHint ${tool.annotations?.readOnlyHint}`);
  }
});

test("REST twin agrees with the parity table", () => {
  for (const [name, twin] of Object.entries(CORE_REST_TWINS)) {
    const rest = MCP_TOOL_CONTRACTS[name]?.rest;
    assert.ok(rest, `${name} has no contract`);
    for (const entry of twin) {
      const needle = typeof entry === "string" ? entry : `(${entry.event})`;
      assert.ok(rest.includes(needle), `${name}: contract REST "${rest}" does not name ${needle}`);
    }
  }
  for (const name of Object.keys(CORE_REST_EXEMPT)) {
    assert.ok(/^(none|the wrapped action)/.test(MCP_TOOL_CONTRACTS[name]?.rest ?? ""), `${name} is exempt and must not claim a twin`);
  }
});

test("no stale contracts and the line is added once", () => {
  const served = new Set([...listedMcpTools("full"), ...listedMcpTools("lean")].map(tool => tool.name));
  for (const name of Object.keys(MCP_TOOL_CONTRACTS)) assert.ok(served.has(name), `${name} is not served; drop its contract`);
  const once = withMcpToolContract("room_react", withMcpToolContract("room_react", "Set a reaction."));
  assert.equal(once.split("Access:").length, 2);
  assert.equal(withMcpToolContract("not_a_tool", "x"), "x");
});
