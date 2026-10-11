import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { runCodexSharedAssistant } from "../client/codex-shared-assistant.mjs";

async function setup(t, during) {
  const f = createAcceptanceFixture({ dmConsent: true }), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const db = new DatabaseSync(":memory:");
  t.after(async () => { db.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const api = async (actor, input) => {
    const response = await fetch(`${origin}/api/rooms/commons/assistant`, { method: input ? "POST" : "GET",
      headers: { authorization: `Bearer ${f.keys[actor]}`, "content-type": "application/json" },
      ...(input ? { body: JSON.stringify({ requestId: randomUUID(), ...input }) } : {}) });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
  };
  const message = (actor, id, body) => f.store.command(f.keys[actor], "commons", { id: randomUUID(), type: "message.posted", data: { messageId: id, body } });
  await api("owner", { action: "configure", expectedRevision: 0, name: "Room", coordinatorMemberId: "producer" });
  message("owner", "shared-question", "Improve the login flow"); message("guest", "shared-friend", "Keep the page simple");
  await api("owner", { action: "invoke", runId: "shared", sourceMessageId: "shared-question" });
  await api("guest", { action: "contribute", runId: "shared", sourceMessageId: "shared-friend", expectedRevision: 0 });
  const calls = [], listeners = new Set(); let state = "inProgress";
  const currentTurn = () => ({ id: "shared-turn", status: state, items: state === "completed" ? [{ id: "final", type: "agentMessage", phase: "final_answer", text: "A simple login for both friends." }] : [] });
  const finish = status => { state = status; for (const fn of listeners) fn({ method: "turn/completed", params: { threadId: "shared-thread", turn: currentTurn() } }); };
  const rpc = { notify() {}, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, async request(method, params) {
    calls.push({ method, params });
    if (method === "initialize") return {};
    if (method === "thread/start") return { thread: { id: "shared-thread" } };
    if (method === "turn/start") {
      setTimeout(async () => { await during?.({ api, message, finish }); if (!during) finish("completed"); }, 5);
      return { turn: currentTurn() };
    }
    if (method === "turn/interrupt") { finish("interrupted"); return {}; }
    if (method === "thread/read") return { thread: { id: "shared-thread", turns: [currentTurn()] } };
    throw new Error(`Unexpected RPC ${method}`);
  } };
  const connection = { version: 1, origin, roomId: "commons", memberId: "producer", token: f.keys.producer };
  const run = (options = {}) => runCodexSharedAssistant({ connection, db, rpc, cwd: f.directory,
    policy: { approvalPolicy: "never", sandbox: "read-only" }, runId: "shared", pollMs: 10, timeoutMs: 2000, ...options });
  return { f, db, api, calls, run };
}
test("two humans' public ask runs through Codex and atomic publication without private requests", async t => {
  const f = await setup(t);
  const result = await f.run(); assert.equal(result.result.status, "done");
  const envelope = JSON.parse(f.calls.find(x => x.method === "turn/start").params.input[0].text);
  assert.equal(envelope.kind, "project-room-shared-assistant");
  assert.deepEqual(envelope.context.inputs.map(x => x.memberId), ["owner", "guest"]);
  assert.equal(Object.keys(f.f.store.room("commons").state.replyRequests ?? {}).length, 0);
  const retry = await f.run(); assert.equal(retry.result.resultMessageId, result.result.resultMessageId);
  assert.equal(f.calls.filter(x => x.method === "turn/start").length, 1);
  const binding = JSON.parse(f.db.prepare("SELECT binding FROM codex_runtime_attempts").get().binding);
  assert.equal(binding.kind, "shared-assistant"); assert.equal(binding.runId, "shared");
});
test("Stop interrupts runtime and acknowledges only its observed terminal state", async t => {
  const f = await setup(t, async ({ api }) => {
    const current = (await api("owner")).runs[0];
    await api("owner", { action: "cancel", runId: "shared", expectedRevision: current.revision });
  });
  assert.equal((await f.run()).result.status, "cancelled");
  assert.equal(f.calls.filter(x => x.method === "turn/interrupt").length, 1);
  assert.equal((await f.api("owner")).runs[0].resultMessageId ?? null, null);
});
test("a contribution racing execution prevents publication and is not falsely marked applied", async t => {
  const f = await setup(t, async ({ api, message, finish }) => {
    message("guest", "late", "Also fix the desktop return");
    const current = (await api("guest")).runs[0];
    await api("guest", { action: "contribute", runId: "shared", sourceMessageId: "late", expectedRevision: current.revision });
    finish("completed");
  });
  await assert.rejects(f.run(), /inputs changed/);
  const current = (await f.api("owner")).runs[0];
  assert.equal(current.resultMessageId ?? null, null); assert.equal(current.inputs.find(x => x.sourceMessageId === "late").status, "pending");
  await assert.rejects(f.run(), /inputs changed/);
  assert.equal(f.calls.filter(x => x.method === "turn/start").length, 1);
});
test("restart reconciles a completed timed-out shared turn and publishes once", async t => {
  let complete;
  const f = await setup(t, async ({ finish }) => { complete = finish; });
  await assert.rejects(f.run({ timeoutMs: 30 }), /uncertain/);
  complete("completed");
  assert.equal((await f.run()).result.status, "done");
  assert.equal(f.calls.filter(x => x.method === "turn/start").length, 1);
});
