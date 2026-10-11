import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { setImmediate as tick } from "node:timers/promises";
import { serveRoomMcp, MCP_VERSION } from "../client/mcp-stdio.mjs";
import { RoomAgentClient, RoomClientError } from "../client/room-agent.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { WatchJournal } from "../client/watch-journal.mjs";

function harness(t, client = {}, options = {}) {
  const input = new PassThrough(), output = new PassThrough(), replies = [], pending = new Map();
  const server = serveRoomMcp({ client, roomId: "commons", memberId: "agent", input, output, ...options });
  let text = "", next = 0;
  output.on("data", chunk => { text += chunk; let end; while ((end = text.indexOf("\n")) >= 0) {
    const reply = JSON.parse(text.slice(0, end)); text = text.slice(end + 1); replies.push(reply); pending.get(reply.id)?.(reply); pending.delete(reply.id);
  } });
  const send = message => input.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  const rpc = (method, params = {}, id = ++next) => new Promise(resolve => { pending.set(id, resolve); send({ id, method, params }); });
  const ready = async () => {
    const result = await rpc("initialize", { protocolVersion: "2099-01-01", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.equal(result.result.protocolVersion, MCP_VERSION); send({ method: "notifications/initialized" });
  };
  t.after(() => { server.stop(); input.destroy(); output.destroy(); });
  return { input, output, server, replies, send, rpc, ready, pending };
}
const args = { requestId: "draft-one", workItemId: "work", packetId: "packet", basisRevision: 0, body: "A draft ☀️" };
const receipt = command => ({ sequence: 4, duplicate: false, event: { id: "event", type: "message.posted", roomId: "commons", actorId: "agent", data: { ...command.data } } });

test("MCP draft reply links are strict and must match the returned receipt", async t => {
  let sent;
  const h = harness(t, { command: async command => { sent = command; const result = receipt(command); delete result.event.data.replyToId; return result; } });
  await h.ready();
  for (const replyToId of [null, true, "", "constructor", "../wrong"]) {
    assert.equal((await h.rpc("tools/call", { name: "room_post_draft", arguments: { ...args, replyToId } })).error.code, -32602);
  }
  assert.equal(sent, undefined);
  const response = await h.rpc("tools/call", { name: "room_post_draft", arguments: { ...args, replyToId: "original" } });
  assert.equal(sent.data.replyToId, "original"); assert.equal(response.result.structuredContent.status, "unconfirmed");
});

test("attention deadline before first authentication creates no state or late response", async t => {
  const f = createAcceptanceFixture(), directory = join(f.directory, "attention");
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const h = harness(t, { snapshot: ({ signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) },
    { timeoutMs: 20, attention: { directory, origin: "http://127.0.0.1:1234" } });
  await h.ready();
  const reply = (await h.rpc("tools/call", { name: "room_read_attention", arguments: {} })).result;
  assert.equal(reply.isError, true); assert.equal(reply.structuredContent.code, "request_timeout");
  assert.equal(existsSync(directory), false);
  const count = h.replies.length; await tick(); assert.equal(h.replies.length, count);
});

test("lost MCP acknowledgement response retains an exact idempotent local outcome across adapter restart", async t => {
  const f = createAcceptanceFixture(), directory = join(f.directory, "attention");
  const client = { snapshot: async () => f.store.snapshot(f.keys.producer, "commons"), changes: async (after, limit) => f.store.eventsAfter(f.keys.producer, "commons", after, limit) };
  const options = { memberId: "producer", attention: { directory, origin: "http://127.0.0.1:1234" } };
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const h = harness(t, client, options); await h.ready();
  const notice = (await h.rpc("tools/call", { name: "room_read_attention", arguments: {} })).result.structuredContent.items[0];
  h.output.pause();
  h.send({ id: "lost-ack", method: "tools/call", params: { name: "room_acknowledge_attention", arguments: { noticeId: notice.id } } });
  let pending = 1;
  for (let i = 0; i < 30 && pending; i++) {
    await tick(); const observer = new WatchJournal(directory, { acquire: false }); pending = observer.status().pending; observer.close();
  }
  assert.equal(pending, 0); assert.ok(!h.replies.some(r => r.id === "lost-ack"));
  h.server.stop(); h.input.destroy(); h.output.destroy();
  const resumed = harness(t, client, options); await resumed.ready();
  const ack = (await resumed.rpc("tools/call", { name: "room_acknowledge_attention", arguments: { noticeId: notice.id } })).result.structuredContent;
  assert.equal(ack.status, "already_acknowledged");
  assert.equal((await resumed.rpc("tools/call", { name: "room_read_attention", arguments: {} })).result.structuredContent.pending, 0);
});

test("stdio version negotiation, discovery fallback, tools and notification silence", async t => {
  const h = harness(t, { checkConnection: async () => ({ status: "credential_accepted" }) });
  assert.equal((await h.rpc("server/discover")).error.code, -32601);
  assert.equal((await h.rpc("tools/list")).error.code, -32000);
  await h.ready();
  const tools = (await h.rpc("tools/list")).result.tools;
  assert.deepEqual(tools.filter(tool => tool.name.includes("outside_agent")).map(tool => tool.name), ["room_list_outside_agents", "room_introduce_outside_agent"]);
  assert.equal(tools.length, 44);
  const assistant = tools.filter(tool => tool.name.startsWith("room_assistant_"));
  assert.deepEqual(assistant.map(tool => tool.name), ["room_assistant_context", "room_assistant_action"]);
  assert.equal(assistant[0].annotations.readOnlyHint, true);
  assert.deepEqual(assistant[1].inputSchema.properties.action.enum, ["claim", "report", "publish", "draft"]); assert.ok(tools.every(tool => tool.inputSchema.additionalProperties === false));
  assert.equal((await h.rpc("tools/call", { name: "room_check_access", arguments: {} }, "typed-id")).result.structuredContent.status, "credential_accepted");
  const count = h.replies.length; h.send({ method: "unknown-notification" }); await tick(); assert.equal(h.replies.length, count);
  assert.equal((await h.rpc("tools/call", { name: "room_read_work", arguments: { workItemId: "work", token: "not-allowed" } })).error.code, -32602);
  h.input.write("not-json\n"); await tick(); assert.equal(h.replies.at(-1).error.code, -32700);
  h.send({ id: null, method: "ping" }); await tick(); assert.equal(h.replies.at(-1).error.code, -32600);
});

test("MCP offer reads preserve explicit negotiation and reject malformed options before calling the client", async t => {
  const seen = [], h = harness(t, { workContext: async (id, options) => { seen.push({ id, options }); return { work: { id } }; } }); await h.ready();
  for (const args of [{ workItemId: "work" }, { workItemId: "work", includeOffers: true }, { workItemId: "work", includeOffers: true, includeSource: true }]) {
    await h.rpc("tools/call", { name: "room_read_work", arguments: args });
    assert.equal(seen.at(-1).options.includeOffers, args.includeOffers ?? false);
    assert.equal(seen.at(-1).options.includeSource, args.includeSource ?? false);
    assert.ok(seen.at(-1).options.signal instanceof AbortSignal);
  }
  assert.equal((await h.rpc("tools/call", { name: "room_read_work", arguments: { workItemId: "work", includeOffers: "yes" } })).error.code, -32602);
  assert.equal(seen.length, 3);
  const older = harness(t, { workContext: async () => { throw new RoomClientError(0, "offer_context_unavailable", "PRIVATE SECRET"); } }); await older.ready();
  const result = (await older.rpc("tools/call", { name: "room_read_work", arguments: { workItemId: "work", includeOffers: true } })).result;
  assert.equal(result.isError, true); assert.equal(result.structuredContent.code, "offer_context_unavailable");
  assert.equal(JSON.stringify(result).includes("PRIVATE SECRET"), false);
});

test("fragmented UTF-8 draft keeps business identity across transport retries and validates exact receipts", async t => {
  const commands = [];
  const h = harness(t, { command: async command => { commands.push(command); return receipt(command); } }); await h.ready();
  const message = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: "fragment", method: "tools/call", params: { name: "room_post_draft", arguments: args } }) + "\n");
  const got = new Promise(resolve => h.pending.set("fragment", resolve));
  for (const byte of message) h.input.write(Buffer.from([byte]));
  assert.equal((await got).result.structuredContent.status, "draft_posted");
  assert.equal((await h.rpc("tools/call", { name: "room_post_draft", arguments: args })).result.structuredContent.status, "draft_posted");
  assert.deepEqual(commands[0], commands[1]); assert.equal(commands[0].data.body, args.body); assert.ok(commands[0].data.messageId);
  for (const mutate of [r => r.sequence = 0, r => delete r.event.id, r => r.event.roomId = "wrong", r => r.event.actorId = "wrong", r => r.event.data.extra = "unexpected", r => r.event.data.allowOlderBasis = true]) {
    const bad = harness(t, { command: async command => { const result = receipt(command); mutate(result); return result; } }); await bad.ready();
    const rejected = (await bad.rpc("tools/call", { name: "room_post_draft", arguments: args })).result;
    assert.equal(rejected.isError, true); assert.equal(rejected.structuredContent.status, "unconfirmed");
  }
});

test("cancelled reads emit no late result; deadlines emit a fixed error; EOF stops pending work", async t => {
  let entered, aborted = false;
  const started = new Promise(resolve => entered = resolve);
  const h = harness(t, { workContext: async (_, { signal }) => { entered(); await new Promise((resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); })); } });
  await h.ready(); const count = h.replies.length;
  h.send({ id: "cancel-me", method: "tools/call", params: { name: "room_read_work", arguments: { workItemId: "work" } } });
  await started; h.send({ method: "notifications/cancelled", params: { requestId: "cancel-me" } }); await tick(); await tick();
  assert.equal(aborted, true); assert.equal(h.replies.length, count);
  const timeout = harness(t, { checkConnection: () => new Promise(() => {}) }, { timeoutMs: 10 }); await timeout.ready();
  const result = (await timeout.rpc("tools/call", { name: "room_check_access" })).result;
  assert.equal(result.isError, true); assert.equal(result.structuredContent.code, "request_timeout");
  h.input.end(); await h.server.done;
});

test("draft refusals are distinct from unknown saves and private diagnostics are never echoed", async t => {
  for (const [status, code, expected] of [[409, "idempotency_conflict", "idempotency_conflict"], [409, "command_rejected", "review_required"], [503, "private-error", "service_unavailable"]]) {
    const h = harness(t, { command: async () => { throw new RoomClientError(status, code, "PRIVATE SECRET"); } }); await h.ready();
    const result = (await h.rpc("tools/call", { name: "room_post_draft", arguments: args })).result;
    assert.equal(result.isError, true); assert.equal(result.structuredContent.code, expected); assert.equal(JSON.stringify(result).includes("PRIVATE SECRET"), false);
  }
});

test("oversized input and ambiguous in-flight IDs close the bounded transport", async t => {
  const h = harness(t); h.input.write("x".repeat(65537)); await h.server.done;
  const duplicate = harness(t, { checkConnection: () => new Promise(() => {}) }); await duplicate.ready();
  const message = { id: "same", method: "tools/call", params: { name: "room_check_access" } };
  duplicate.send(message); duplicate.send(message); await duplicate.server.done;
});

test("discussion refusals explain safe next steps without echoing service diagnostics", async t => {
  for (const code of ["invalid_discussion", "discussion_ahead", "discussion_history_changed", "discussion_entry_too_large"]) {
    const h = harness(t, { workDiscussion: async () => { throw new RoomClientError(409, code, "PRIVATE SECRET"); } }); await h.ready();
    const result = (await h.rpc("tools/call", { name: "room_read_work_discussion", arguments: { workItemId: "work" } })).result;
    assert.equal(result.isError, true); assert.equal(result.structuredContent.type, "discussion_refused");
    assert.equal(result.structuredContent.code, code); assert.equal(JSON.stringify(result).includes("PRIVATE SECRET"), false);
    assert.ok(result.structuredContent.message.length > 40);
  }
});

test("schema-valid oversized work input is a local refusal, not an unknown save", async t => {
  let calls = 0; const h = harness(t, { command: async () => { calls++; } }); await h.ready();
  const result = (await h.rpc("tools/call", { name: "room_record_completion", arguments: {
    requestId: "large", workItemId: "work", expectedRevision: 2, summary: "☀".repeat(4096), evidenceUrl: "https://example.invalid/artifact",
    evidenceVersion: "v1", nextAction: "Review", checksClaimed: Array(20).fill("a".repeat(512))
  } })).result;
  assert.equal(calls, 0); assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, "work_action_too_large"); assert.equal(result.structuredContent.outcome, "this_attempt_not_sent");
});

for (const [tool, args] of [
  ["room_accept_work", { requestId: "accept", workItemId: "work", expectedRevision: 0 }],
  ["room_offer_help", { requestId: "offer", workItemId: "work", offerId: "offer-one", expectedRevision: 1,
    expectedHelpRevision: 1, helpEventId: "help-event", plan: "Two agenda items" }]
]) test(`cancelled ${tool} output cannot imply rollback; exact retry retains the committed operation`, async t => {
  let started, release, saved;
  const entered = new Promise(resolve => { started = resolve; }), delayed = new Promise(resolve => { release = resolve; });
  const client = { command: async command => {
    if (saved) return { ...saved, duplicate: true };
    saved = { sequence: 5, duplicate: false, event: { id: "accepted-event", type: command.type, data: command.data,
      roomId: "commons", actorId: "agent", at: new Date().toISOString(), causationId: null,
      idempotencyKey: createHash("sha256").update(`agent:${command.id}`).digest("hex") } };
    started(); await delayed; return saved;
  } };
  const h = harness(t, client); await h.ready(); const count = h.replies.length;
  h.send({ id: "cancel-work", method: "tools/call", params: { name: tool, arguments: args } });
  await entered; h.send({ method: "notifications/cancelled", params: { requestId: "cancel-work" } }); release(); await tick(); await tick();
  assert.equal(h.replies.length, count); assert.ok(saved);
  const next = harness(t, client); await next.ready();
  const retried = (await next.rpc("tools/call", { name: tool, arguments: args })).result.structuredContent;
  assert.equal(retried.status, "recorded"); assert.equal(retried.duplicate, true); assert.equal(retried.eventId, saved.event.id);
});

test("draft body matches the 4000 UTF-16 proposal boundary before any client command", async t => {
  const sent = [], h = harness(t, { command: async command => { sent.push(command); return receipt(command); } });
  await h.ready();
  const draft = (await h.rpc("tools/list")).result.tools.find(tool => tool.name === "room_post_draft");
  assert.equal(draft.inputSchema.properties.body.maxLength, 4000);
  assert.match(draft.inputSchema.properties.body.description, /UTF-16/);
  for (const body of ["x".repeat(4000), "🌱".repeat(2000)]) {
    const response = await h.rpc("tools/call", { name: "room_post_draft", arguments: { ...args, body } });
    assert.equal(response.result.structuredContent.status, "draft_posted");
    assert.equal(sent.at(-1).data.body, body);
  }
  const before = sent.length;
  for (const body of ["x".repeat(4001), "🌱".repeat(2000) + "x", "x".repeat(4096), "x".repeat(4097), "\ud800", "   ", null]) {
    const response = await h.rpc("tools/call", { name: "room_post_draft", arguments: { ...args, body } });
    assert.equal(response.error.code, -32602);
    assert.match(response.error.message, /body.*1.*4000.*UTF-16/i);
    assert.equal(response.error.message.includes("review_required"), false);
  }
  assert.equal(sent.length, before, "invalid drafts must not reach the service");
});


test("4000-unit MCP draft reaches the real Room proposal store intact", async t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  let calls = 0;
  const h = harness(t, { command: async command => { calls++; return f.store.command(f.keys.producer, "commons", command); } }, { memberId: "producer" });
  await h.ready();
  const body = "🌱".repeat(2000), arguments_ = { ...args, workItemId: "test-handoff", body };
  const result = (await h.rpc("tools/call", { name: "room_post_draft", arguments: arguments_ })).result;
  assert.equal(result.structuredContent.status, "draft_posted");
  const stored = f.store.snapshot(f.keys.producer, "commons").state.messages.find(message => message.id === result.structuredContent.messageId);
  assert.equal(stored.body, body);
  const rejected = await h.rpc("tools/call", { name: "room_post_draft", arguments: { ...arguments_, requestId: "draft-too-long", body: body + "x" } });
  assert.ok(rejected.error, "4001-unit draft must fail locally instead of reaching a misleading service refusal");
  assert.equal(rejected.error.code, -32602);
  assert.match(rejected.error.message, /body.*4000.*UTF-16/i);
  assert.equal(calls, 1);
});

// This JSON-RPC boundary owns the new tool's advertised schema, rejection before
// dispatch, unchanged argument forwarding, cancellation signal and error copy.
test("MCP claim PR links validate URL-only arguments and forward the complete claim basis", async t => {
  const seen = [], saved = { id: "_claim", state: "claimed", pullRequests: [{ url: "https://github.com/Uuriko/project-room/pull/18" }] };
  const h = harness(t, { linkWorkItemPullRequest: async (id, options) => { seen.push({ id, options }); return saved; } });
  await h.ready();
  const definition = (await h.rpc("tools/list")).result.tools.find(tool => tool.name === "room_link_work_claim_pr");
  assert.equal(definition.annotations.readOnlyHint, false);
  assert.equal(definition.annotations.destructiveHint, false);
  assert.equal(definition.annotations.idempotentHint, true);
  assert.equal(definition.inputSchema.properties.pullRequest.type, "string");
  assert.equal(definition.inputSchema.properties.pullRequest.maxLength, 300);
  assert.match(definition.description, /historyOmitted/);
  assert.match(definition.inputSchema.properties.expectedHistoryLength.description, /historyOmitted/);
  const args = { claimId: "_claim", pullRequest: saved.pullRequests[0].url + "/",
    expectedClaimedAt: "2026-10-03T13:00:00.000Z", expectedHistoryLength: 2 };
  for (const invalid of [
    { ...args, pullRequest: { url: args.pullRequest, outcome: "merged" } },
    { ...args, pullRequest: "https://github.com/Uuriko/project-room/pull/18?fake=1" },
    { ...args, pullRequest: "https://github.com:444/Uuriko/project-room/pull/18" },
    { ...args, expectedHistoryLength: "2" }, { ...args, expectedHistoryLength: -1 },
    { ...args, expectedClaimedAt: null }, { ...args, expectedClaimedAt: "not-a-date" },
    { ...args, state: "done" }, { ...args, claimId: "claim.with.dots" },
    Object.fromEntries(Object.entries(args).filter(([key]) => key !== "expectedHistoryLength"))
  ]) {
    assert.equal((await h.rpc("tools/call", { name: definition.name, arguments: invalid })).error.code, -32602);
  }
  assert.equal(seen.length, 0);
  const result = (await h.rpc("tools/call", { name: definition.name, arguments: args })).result;
  assert.deepEqual(result.structuredContent, saved);
  assert.equal(result.isError, undefined);
  assert.equal(seen.length, 1);
  const { signal, ...sent } = seen[0].options;
  assert.ok(signal instanceof AbortSignal);
  assert.deepEqual({ claimId: seen[0].id, ...sent }, args);
});

test("MCP claim PR refusals preserve specific codes and reconcile unknown writes without leaking diagnostics", async t => {
  const args = { claimId: "claim", pullRequest: "https://github.com/Uuriko/project-room/pull/18",
    expectedClaimedAt: "2026-10-03T13:00:00.000Z", expectedHistoryLength: 2 };
  for (const [status, code] of [[409, "work_claim_conflict"], [403, "work_not_owner"], [409, "claim_lease_lapsed"], [503, "internal"]]) {
    const h = harness(t, { linkWorkItemPullRequest: async () => { throw new RoomClientError(status, code, "PRIVATE SECRET"); } });
    await h.ready();
    const result = (await h.rpc("tools/call", { name: "room_link_work_claim_pr", arguments: args })).result;
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, status === 503 ? "service_unavailable" : code);
    assert.equal(result.structuredContent.outcome, status === 503 ? "not_confirmed" : "this_attempt_refused");
    assert.deepEqual(result.structuredContent.next, [{ path: "/api/rooms/commons/work-claims/claim" }]);
    assert.match(result.structuredContent.hint, /never reacquire automatically/);
    assert.equal(JSON.stringify(result).includes("PRIVATE SECRET"), false);
  }
});

async function boardHttpFixture(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const token = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store }), requests = [];
  server.on("request", req => requests.push(req.url));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, token, requests, client: new RoomAgentClient({ origin, roomId: "commons", token }) };
}

// Stdio owns schema validation and dispatch: SDK tests cannot detect arguments
// discarded by callTool or JSON-RPC success manufactured after an HTTP refusal.
test("stdio Board reads forward canonical selections through the real SDK and HTTP route", async t => {
  const { client, requests } = await boardHttpFixture(t);
  for (const id of ["a-ready", "b-ready", "held"]) await client.workClaimCreate({ id, title: id });
  const held = await client.claimWorkItem("held", { leaseHours: 2 });
  const h = harness(t, client, { memberId: "owner" });
  await h.ready();
  const definition = (await h.rpc("tools/list")).result.tools.find(tool => tool.name === "room_read_board");
  assert.equal(definition.annotations.readOnlyHint, true);
  assert.equal(definition.inputSchema.properties.limit.default, 50);
  assert.equal(definition.inputSchema.properties.limit.maximum, 200);
  const before = requests.length;
  for (const selection of [{ queue: "all" }, { state: "released" }, { queue: "ready", state: "done" },
    { limit: 0 }, { limit: 201 }, { limit: 1.5 }, { limit: "1" }, { cursor: "" }, { cursor: null },
    { cursor: "x".repeat(2049) }, { swept: true }]) {
    assert.equal((await h.rpc("tools/call", { name: definition.name, arguments: selection })).error.code, -32602);
  }
  assert.equal(requests.length, before, "invalid local arguments must not initiate an HTTP read");
  const read = async selection => (await h.rpc("tools/call", { name: definition.name, arguments: selection })).result;
  const first = await read({ queue: "ready", limit: 1 });
  assert.equal(first.isError, undefined);
  assert.deepEqual(first.structuredContent.claims.map(item => item.id), ["a-ready"]);
  assert.equal(first.structuredContent.claimsPage.queue, "ready");
  assert.equal(first.structuredContent.claimsPage.limit, 1);
  assert.equal(first.structuredContent.claimsPage.hasMore, true);
  const second = await read({ queue: "ready", limit: 1, cursor: first.structuredContent.claimsPage.nextCursor });
  assert.deepEqual(second.structuredContent.claims.map(item => item.id), ["b-ready"]);
  assert.equal(second.structuredContent.claimsPage.hasMore, false);
  const claimed = await read({ state: "claimed", limit: 200 });
  const [item] = claimed.structuredContent.claims;
  assert.equal(claimed.structuredContent.claims.length, 1);
  assert.deepEqual([item.id, item.state, item.owner, item.leaseExpiresAt], [held.id, held.state, held.owner, held.leaseExpiresAt]);
  assert.equal(claimed.structuredContent.claimsPage.state, "claimed");
  assert.equal(claimed.structuredContent.claimsPage.limit, 200);
  const refused = await read({ state: "claimed", cursor: first.structuredContent.claimsPage.nextCursor });
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.code, "invalid_claim_input");
  assert.equal(Object.hasOwn(refused.structuredContent, "claims"), false);
  assert.equal(requests.slice(before).some(path => /^\/api\/rooms\/commons\/work-claims(?:\?|$)/.test(path)), false);
});

// JSON-RPC cancellation must reach the second SDK fetch and suppress its late
// output. The delayed bytes come from the real canonical route, not a mock client.
test("stdio Board cancellation closes the canonical HTTP read and emits no late result", async t => {
  const { origin, token } = await boardHttpFixture(t);
  let entered, closed, release;
  const started = new Promise(resolve => { entered = resolve; });
  const disconnected = new Promise(resolve => { closed = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const proxy = createServer(async (req, res) => {
    if (req.method !== "GET" || !["/api/rooms/commons", "/api/rooms/commons/work-claims-read"].includes(req.url)) {
      res.writeHead(500).end(); return;
    }
    const response = await fetch(origin + req.url, { headers: { authorization: req.headers.authorization } });
    const body = await response.text();
    if (req.url.endsWith("/work-claims-read")) {
      res.on("close", closed);
      entered();
      await gate;
    }
    res.writeHead(response.status, { "content-type": "application/json" }).end(body);
  });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  t.after(async () => { release(); proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); });
  const client = new RoomAgentClient({ origin: `http://127.0.0.1:${proxy.address().port}`, roomId: "commons", token });
  const h = harness(t, client, { memberId: "owner" });
  await h.ready();
  h.send({ id: "cancel-board", method: "tools/call", params: { name: "room_read_board", arguments: {} } });
  await started;
  h.send({ method: "notifications/cancelled", params: { requestId: "cancel-board" } });
  await disconnected;
  release();
  assert.deepEqual((await h.rpc("ping")).result, {});
  assert.equal(h.replies.some(reply => reply.id === "cancel-board"), false);
});
