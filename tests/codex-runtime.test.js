import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createCodexRuntimeHost, roomCodexHost } from "../client/codex-runtime.mjs";
import { openRequestJournal, runRequestOnce } from "../client/request-runner.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { rmSync } from "node:fs";
import { join } from "node:path";

const binding = { origin: "http://room", roomId: "commons", memberId: "producer", requestMessageId: "question",
  requestId: "host-question", attemptId: "attempt-one", roomCreatedEventId: "room-created", openingEventId: "question-opened" };
const input = { requestId: binding.requestId, request: { id: "question" }, messages: [], preparation: {} };
const turn = (status = "inProgress") => ({ id: "turn-one", status, items: status === "completed" ? [{ type: "agentMessage", id: "answer-one", text: "Reviewed result" }] : [] });
function transport({ complete = true, loseSteer = false, early = false } = {}) {
  const calls = [], listeners = new Set(); let state = "inProgress";
  const event = (method, params) => listeners.forEach(fn => fn({ method, params }));
  const finish = () => { state = "completed"; event("turn/completed", { threadId: "thread-one", turn: turn(state) }); };
  return { calls, finish, event, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    notify(method, params) { assert.equal(method, "initialized"); assert.deepEqual(params, {}); },
    async request(method, params) {
      calls.push({ method, params });
      switch (method) {
        case "initialize": assert.deepEqual(Object.keys(params), ["clientInfo"]); return {};
        case "thread/start": assert.deepEqual(Object.keys(params).sort(), ["approvalPolicy", "cwd", "sandbox"]); return { thread: { id: "thread-one" } };
        case "turn/start":
          assert.deepEqual(Object.keys(params).sort(), ["input", "threadId"]);
          assert.equal(params.threadId, "thread-one");
          assert.deepEqual(Object.keys(params.input[0]).sort(), ["text", "text_elements", "type"]);
          if (complete) { if (early) finish(); else setTimeout(finish, 5); }
          return { turn: turn() };
        case "turn/steer":
          assert.deepEqual(Object.keys(params).sort(), ["clientUserMessageId", "expectedTurnId", "input", "threadId"]);
          assert.equal(params.expectedTurnId, "turn-one");
          if (loseSteer) throw new Error("Disconnected after accepting input");
          return { turnId: "turn-one" };
        case "turn/interrupt":
          assert.deepEqual(params, { threadId: "thread-one", turnId: "turn-one" }); return {};
        case "thread/read":
          assert.deepEqual(params, { threadId: "thread-one", includeTurns: true });
          return { thread: { id: "thread-one", turns: [turn(state)] } };
        default: throw new Error(`Unexpected method ${method}`);
      }
    } };
}
const waitUntil = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 2)); } throw new Error("Condition not reached"); };
function setup(t, options = {}) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const rpc = transport(options), events = [], authorized = [];
  const host = createCodexRuntimeHost({ db, rpc, scope: binding, cwd: "/tmp/project", policy: { approvalPolicy: "never", sandbox: "read-only" }, timeoutMs: 1000,
    authorize: async (b, action) => authorized.push(action), emit: event => events.push(event) });
  return { db, rpc, host, events, authorized };
}
test("exact thread/turn events complete despite notification preceding start response", async t => {
  const { host, rpc } = setup(t, { early: true });
  assert.deepEqual(await host(input, { binding }), { body: "Reviewed result" });
  await assert.rejects(host(input, { binding }), /already exists/);
  assert.deepEqual(await host.reconcile(binding), { status: "completed", body: "Reviewed result" });
  assert.equal(rpc.calls.filter(x => x.method === "turn/start").length, 1);
});
test("lost steering response is uncertain and never automatically sent twice", async t => {
  const { host, rpc, events } = setup(t, { complete: false, loseSteer: true });
  const executing = host(input, { binding });
  await waitUntil(() => rpc.calls.some(x => x.method === "turn/start"));
  rpc.event("item/agentMessage/delta", { threadId: "foreign-thread", turnId: "turn-one", delta: "secret" });
  rpc.event("item/agentMessage/delta", { threadId: "thread-one", turnId: "foreign-turn", delta: "secret" });
  rpc.event("item/agentMessage/delta", { threadId: "thread-one", turnId: "turn-one", itemId: "answer", delta: "Hi" });
  await assert.rejects(host.steer(binding, "contribution", "Keep it simple"), /Disconnected/);
  assert.deepEqual(await host.steer(binding, "contribution", "Keep it simple"), { status: "uncertain" });
  await assert.rejects(host.steer(binding, "contribution", "Different"), /reused/);
  assert.equal(rpc.calls.filter(x => x.method === "turn/steer").length, 1);
  assert.equal(events.length, 1); assert.equal(events[0].delta, "Hi");
  rpc.finish(); await executing;
});
test("interrupt acknowledgement remains stopping until terminal observation", async t => {
  const { host, rpc } = setup(t, { complete: false });
  const executing = host(input, { binding });
  await waitUntil(() => rpc.calls.some(x => x.method === "turn/start"));
  assert.deepEqual(await host.interrupt(binding), { status: "stopping" });
  rpc.event("turn/completed", { threadId: "thread-one", turn: turn("interrupted") });
  await assert.rejects(executing, /interrupted/);
  await assert.rejects(host.steer(binding, "later", "No"), /not accepting/);
});
test("foreign room identity fails before authorization or runtime access", async t => {
  const { host, rpc, authorized } = setup(t);
  await assert.rejects(host(input, { binding: { ...binding, roomId: "foreign" } }), /wrong Room/);
  assert.equal(rpc.calls.length, 0); assert.equal(authorized.length, 0);
});
test("uncertain thread start is journaled before side effects and never retried", async t => {
  const { db } = setup(t);
  let starts = 0;
  const rpc = transport();
  const request = rpc.request;
  rpc.request = (method, params) => { if (method === "thread/start") { starts++; throw new Error("lost"); } return request(method, params); };
  const host = createCodexRuntimeHost({ db, rpc, scope: binding, cwd: "/tmp/project", policy: { approvalPolicy: "never", sandbox: "read-only" }, authorize: async () => {} });
  await assert.rejects(host(input, { binding }), /lost/);
  await assert.rejects(host(input, { binding }), /already exists/);
  await assert.rejects(host.reconcile(binding), /uncertain/);
  assert.equal(starts, 1);
});
test("authenticated Room runner uses the adapter, persists result and retries delivery without runtime execution", async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const db = openRequestJournal(join(f.directory, "runtime.sqlite"));
  t.after(async () => { db.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.store.dmConsents.request("commons", "owner", "producer", "fixture");
  f.store.dmConsents.decide("commons", "producer", "owner", "approve");
  f.store.dmConsents.request("commons", "producer", "owner", "fixture");
  f.store.dmConsents.decide("commons", "owner", "producer", "approve");
  const requestMessageId = "question-runtime";
  f.store.command(f.keys.owner, "commons", { id: "ask-runtime", type: "message.posted", data: { messageId: requestMessageId,
    requestKind: "reply", toMemberId: "producer", body: "Review this plan" } });
  const connection = { version: 1, origin: `http://127.0.0.1:${server.address().port}`, roomId: "commons", memberId: "producer", token: f.keys.producer };
  const rpc = transport(), execute = roomCodexHost({ connection, db, rpc, cwd: f.directory, policy: { approvalPolicy: "never", sandbox: "read-only" } });
  const result = await runRequestOnce({ connection, requestMessageId, db, execute });
  assert.equal(result.status, "delivered"); assert.equal(result.hostExecuted, true);
  const saved = db.prepare("SELECT * FROM codex_runtime_attempts").get();
  const mapping = JSON.parse(saved.binding);
  assert.equal(mapping.attemptId, db.prepare("SELECT attempt_id FROM request_runs").get().attempt_id);
  assert.equal(mapping.memberId, "producer"); assert.equal(saved.turn_id, "turn-one");
  assert.equal(JSON.stringify(rpc.calls).includes(f.keys.producer), false);
  const retry = await runRequestOnce({ connection, requestMessageId, db, execute });
  assert.equal(retry.hostExecuted, false);
  assert.equal(rpc.calls.filter(x => x.method === "turn/start").length, 1);
});
test("local revocation cancellation still interrupts the originally owned turn", async t => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const rpc = transport({ complete: false }); let revoked = false;
  const host = createCodexRuntimeHost({ db, rpc, scope: binding, cwd: "/tmp/project", policy: { approvalPolicy: "never", sandbox: "read-only" }, authorize: async () => {
    if (revoked) throw new Error("Membership revoked");
  } });
  const controller = new AbortController();
  const executing = host({ ...input, signal: controller.signal }, { binding });
  await waitUntil(() => rpc.calls.some(x => x.method === "turn/start"));
  revoked = true;
  await assert.rejects(host.steer(binding, "blocked", "Do more"), /revoked/);
  controller.abort();
  await assert.rejects(executing, /cancellation requested/);
  await waitUntil(() => rpc.calls.some(x => x.method === "turn/interrupt"));
  assert.equal(db.prepare("SELECT state FROM codex_runtime_attempts").get().state, "stopping");
});
test("terminal notification can omit items: durable item completions supply the result", async t => {
  const { host, rpc, db } = setup(t, { complete: false });
  const executing = host(input, { binding });
  await waitUntil(() => rpc.calls.some(x => x.method === "turn/start"));
  rpc.event("item/completed", { threadId: "thread-one", turnId: "turn-one", item: { id: "final", type: "agentMessage", text: "Durable answer" } });
  rpc.event("turn/completed", { threadId: "thread-one", turn: { id: "turn-one", status: "completed", items: [] } });
  assert.deepEqual(await executing, { body: "Durable answer" });
  assert.equal(db.prepare("SELECT result FROM codex_runtime_attempts").get().result, "Durable answer");
});
test("a new adapter reconciles the original timed-out turn without another execution", async t => {
  const { db, rpc } = setup(t, { complete: false });
  const options = { db, rpc, scope: binding, cwd: "/tmp/project", policy: { approvalPolicy: "never", sandbox: "read-only" }, authorize: async () => {}, timeoutMs: 10 };
  const original = createCodexRuntimeHost(options);
  await assert.rejects(original(input, { binding }), /uncertain/);
  rpc.finish();
  const resumed = createCodexRuntimeHost(options);
  assert.deepEqual(await resumed.reconcile(binding), { status: "completed", body: "Reviewed result" });
  assert.equal(rpc.calls.filter(x => x.method === "turn/start").length, 1);
});
test("final answer excludes commentary phase output", async t => {
  const { host, rpc } = setup(t, { complete: false });
  const executing = host(input, { binding });
  await waitUntil(() => rpc.calls.some(x => x.method === "turn/start"));
  rpc.event("item/completed", { threadId: "thread-one", turnId: "turn-one", item: { id: "progress", type: "agentMessage", phase: "commentary", text: "Checking now" } });
  rpc.event("item/completed", { threadId: "thread-one", turnId: "turn-one", item: { id: "final", type: "agentMessage", phase: "final_answer", text: "Only this is the answer" } });
  rpc.event("turn/completed", { threadId: "thread-one", turn: { id: "turn-one", status: "completed", items: [] } });
  assert.deepEqual(await executing, { body: "Only this is the answer" });
});
test("stream deltas use started item phase and exclude commentary and reasoning", async t => {
  const { host, rpc, events } = setup(t, { complete: false });
  const executing = host(input, { binding });
  await waitUntil(() => rpc.calls.some(x => x.method === "turn/start"));
  for (const [id, phase] of [["progress", "commentary"], ["answer", "final_answer"]]) {
    rpc.event("item/started", { threadId: "thread-one", turnId: "turn-one", item: { id, type: "agentMessage", phase } });
    rpc.event("item/agentMessage/delta", { threadId: "thread-one", turnId: "turn-one", itemId: id, delta: id });
  }
  rpc.event("item/reasoning/textDelta", { threadId: "thread-one", turnId: "turn-one", itemId: "thought", delta: "not public" });
  rpc.finish(); await executing;
  assert.deepEqual(events.filter(x => x.type === "answer_delta").map(x => [x.delta, x.phase]), [["answer", "final_answer"]]);
});
test("durable completed reconciliation keeps only final answer after disconnect", async t => {
  const { host, rpc } = setup(t, { complete: false });
  const executing = host(input, { binding });
  await waitUntil(() => rpc.calls.some(x => x.method === "turn/start"));
  rpc.event("item/completed", { threadId: "thread-one", turnId: "turn-one", item: { id: "progress", type: "agentMessage", phase: "commentary", text: "Checking" } });
  rpc.event("turn/completed", { threadId: "thread-one", turn: { id: "turn-one", status: "completed", items: [{ id: "final", type: "agentMessage", phase: "final_answer", text: "Verified answer" }] } });
  await executing;
  rpc.request = async () => { throw new Error("Disconnected"); };
  assert.deepEqual(await host.reconcile(binding), { status: "completed", body: "Verified answer" });
  assert.deepEqual(await host.reconcile({ ...binding, attemptId: "another" }), { status: "not_started" });
});
