import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { assistantDraftSink, runCodexSharedAssistant } from "../client/codex-shared-assistant.mjs";

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
  const calls = [], listeners = new Set(); let state = "inProgress", turnNumber = 0; const pastTurns = [];
  const currentTurn = () => ({ id: `shared-turn-${turnNumber}`, status: state, items: state === "completed" ? [{ id: "final", type: "agentMessage", phase: "final_answer", text: "A simple login for both friends." }] : [] });
  const finish = status => { state = status; for (const fn of listeners) fn({ method: "turn/completed", params: { threadId: "shared-thread", turn: currentTurn() } }); };
  const rpc = { notify() {}, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, async request(method, params) {
    calls.push({ method, params });
    if (method === "initialize") return {};
    if (["thread/start", "thread/resume"].includes(method)) return { thread: { id: "shared-thread" } };
    if (method === "turn/start") {
      if (turnNumber) pastTurns.push(currentTurn());
      turnNumber++; state = "inProgress";
      setTimeout(async () => { await during?.({ api, message, finish, turnNumber, event: (method, params) => { for (const fn of listeners) fn({ method, params }); } }); if (!during) finish("completed"); }, 5);
      return { turn: currentTurn() };
    }
    if (method === "turn/interrupt") { finish("interrupted"); return {}; }
    if (method === "thread/read") return { thread: { id: "shared-thread", turns: [...pastTurns, currentTurn()] } };
    throw new Error(`Unexpected RPC ${method}`);
  } };
  const connection = { version: 1, origin, roomId: "commons", memberId: "producer", token: f.keys.producer };
  const run = (options = {}) => runCodexSharedAssistant({ connection, db, rpc, cwd: f.directory,
    policy: { approvalPolicy: "never", sandbox: "read-only" }, runId: "shared", pollMs: 10, timeoutMs: 2000, ...options });
  return { f, db, api, calls, run, rpc };
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
test("late group input continues the known completed thread before publication", async t => {
  const f = await setup(t, async ({ api, message, finish, turnNumber }) => {
    if (turnNumber === 1) {
      message("guest", "late", "Also fix the desktop return");
      const current = (await api("guest")).runs[0];
      await api("guest", { action: "contribute", runId: "shared", sourceMessageId: "late", expectedRevision: current.revision });
      assert.equal((await api("guest")).runs[0].inputs.find(x => x.sourceMessageId === "late").status, "pending");
    }
    finish("completed");
  });
  const result = await f.run();
  assert.equal(result.result.status, "done");
  assert.equal(f.calls.filter(x => x.method === "thread/start").length, 1);
  assert.equal(f.calls.filter(x => x.method === "thread/resume").length, 1);
  const starts = f.calls.filter(x => x.method === "turn/start");
  assert.equal(starts.length, 2); assert.equal(starts[0].params.threadId, starts[1].params.threadId);
  const followup = JSON.parse(starts[1].params.input[0].text).context;
  assert.deepEqual(followup.inputs.map(x => x.messageId), ["late"]);
  assert.match(followup.continuation.priorResult, /simple login/);
  assert.equal(followup.continuation.previousTurnCompleted, true);
  assert.deepEqual(result.result.inputs.map(x => x.status), ["applied", "applied", "applied"]);
  await f.run(); assert.equal(f.calls.filter(x => x.method === "turn/start").length, 2);
});
test("restart reconciles a completed timed-out shared turn and publishes once", async t => {
  let complete;
  const f = await setup(t, async ({ finish }) => { complete = finish; });
  await assert.rejects(f.run({ timeoutMs: 30 }), /uncertain/);
  complete("completed");
  assert.equal((await f.run()).result.status, "done");
  assert.equal(f.calls.filter(x => x.method === "turn/start").length, 1);
});
test("restart settles Stop received while the runtime was disconnected", async t => {
  let complete;
  const f = await setup(t, async ({ finish }) => { complete = finish; });
  await assert.rejects(f.run({ timeoutMs: 30 }), /uncertain/);
  complete("completed");
  const current = (await f.api("owner")).runs[0];
  await f.api("owner", { action: "cancel", runId: "shared", expectedRevision: current.revision });
  assert.equal((await f.run()).result.status, "cancelled");
  assert.equal(f.calls.filter(x => x.method === "turn/start").length, 1);
});
test("stale heartbeat state permits completed recovery but never starts a new turn", async t => {
  let complete;
  const f = await setup(t, async ({ finish }) => { complete = finish; });
  await assert.rejects(f.run({ timeoutMs: 30 }), /uncertain/);
  complete("completed");
  const now = f.f.store.now(); f.f.store.now = () => now + 180000;
  assert.equal((await f.api("owner")).runs[0].status, "unknown");
  assert.equal((await f.run()).result.status, "done");
  assert.equal(f.calls.filter(x => x.method === "turn/start").length, 1);
});

const appendLate = async ({ api, message }, id) => {
  message("guest", id, `New instruction ${id}`);
  const current = (await api("guest")).runs[0];
  await api("guest", { action: "contribute", runId: "shared", sourceMessageId: id, expectedRevision: current.revision });
};
test("completed continuation recovers without rerunning either turn", async t => {
  let complete;
  const f = await setup(t, async context => {
    if (context.turnNumber === 1) { await appendLate(context, "late-recovery"); context.finish("completed"); }
    else complete = context.finish;
  });
  // The budget has to cover the whole first turn (a late-input write over HTTP)
  // even on a loaded runner, so only the held second turn is what times out.
  await assert.rejects(f.run({ timeoutMs: 1000 }), /uncertain/);
  assert.equal(typeof complete, "function", "the continuation turn was held open when the run timed out");
  complete("completed");
  const result = await f.run(); assert.equal(result.result.status, "done");
  assert.equal(f.calls.filter(x => x.method === "turn/start").length, 2);
  assert.equal(f.calls.filter(x => x.method === "initialize").length, 1);
});
test("an unknown continuation start never retries model execution", async t => {
  const f = await setup(t, async context => {
    if (context.turnNumber === 1) await appendLate(context, "late-unknown");
    context.finish("completed");
  });
  const request = f.rpc.request.bind(f.rpc); let starts = 0;
  f.rpc.request = async (method, params) => {
    const result = await request(method, params);
    if (method === "turn/start" && ++starts === 2) throw new Error("Start response lost");
    return result;
  };
  await assert.rejects(f.run(), /response lost/);
  await new Promise(resolve => setTimeout(resolve, 20));
  await assert.rejects(f.run(), /start is uncertain/);
  assert.equal(starts, 2);
  assert.equal((await f.api("owner")).runs[0].resultMessageId ?? null, null);
});
test("continuation budget leaves further authored input pending", async t => {
  const f = await setup(t, async context => { await appendLate(context, `late-${context.turnNumber}`); context.finish("completed"); });
  await assert.rejects(f.run({ maxContinuations: 1 }), /continuation limit/);
  assert.equal(f.calls.filter(x => x.method === "turn/start").length, 2);
  const current = (await f.api("owner")).runs[0];
  assert.equal(current.inputs.find(x => x.sourceMessageId === "late-2").status, "pending");
  assert.equal(current.resultMessageId ?? null, null);
});
test("Stop during a continuation interrupts the exact second turn", async t => {
  const f = await setup(t, async context => {
    if (context.turnNumber === 1) { await appendLate(context, "late-stop"); context.finish("completed"); }
    else {
      const current = (await context.api("owner")).runs[0];
      await context.api("owner", { action: "cancel", runId: "shared", expectedAttemptId: current.attemptId });
    }
  });
  assert.equal((await f.run()).result.status, "cancelled");
  assert.equal(f.calls.find(x => x.method === "turn/interrupt").params.turnId, "shared-turn-2");
  assert.equal((await f.api("owner")).runs[0].resultMessageId ?? null, null);
});
test("conflicting directions never automatically continue a completed turn", async t => {
  const f = await setup(t, async ({ api, message, finish }) => {
    message("guest", "conflicting", "Actually do the opposite");
    const current = (await api("guest")).runs[0];
    await api("guest", { action: "contribute", runId: "shared", sourceMessageId: "conflicting", conflict: true, expectedRevision: current.revision });
    finish("completed");
  });
  await assert.rejects(f.run(), /stopped or changed|recovery|cancellation/);
  assert.equal((await f.api("owner")).runs[0].status, "needs_input");
  assert.equal(f.calls.filter(x => x.method === "turn/start").length, 1);
});

test("observed runtime failure becomes a truthful failed shared run", async t => {
  const f = await setup(t, ({ finish }) => finish("failed"));
  assert.equal((await f.run()).result.status, "failed");
  const run = (await f.api("owner")).runs[0];
  assert.equal(run.resultMessageId ?? null, null);
  assert.equal(f.calls.filter(x => x.method === "turn/start").length, 1);
});
test("lost runtime connection never falsely reports terminal failure", async t => {
  const f = await setup(t, () => {});
  await assert.rejects(f.run({ timeoutMs: 20 }), /uncertain/);
  assert.equal((await f.api("owner")).runs[0].status, "working");
});
test("draft sink streams only public final text and respects cleared sequence", async () => {
  const sent = [], run = { attemptId: "a", status: "working", revision: 4, answerDraftSequence: 9, inputs: [{ sourceMessageId: "m" }] };
  const sink = assistantDraftSink({ read: async () => run, act: async value => sent.push(value), attemptId: "a", requestKey: "k", inputIds: ["m"] });
  sink.emit({ type: "answer_delta", attemptId: "a", itemId: "comment", phase: "commentary", delta: "private progress" });
  sink.emit({ type: "answer_delta", attemptId: "a", itemId: "final", phase: "final_answer", delta: "Hello " });
  sink.emit({ type: "answer_delta", attemptId: "a", itemId: "final", phase: "final_answer", delta: "friends" });
  await sink.close();
  assert.equal(sent.length, 1); assert.equal(sent[0].body, "Hello friends"); assert.equal(sent[0].sequence, 10);
});
test("draft sink cannot revive stale text after new input or Stop", async () => {
  for (const change of [run => run.inputs.push({ sourceMessageId: "new" }), run => run.status = "cancel_requested"]) {
    const sent = [], run = { attemptId: "a", status: "working", revision: 4, inputs: [{ sourceMessageId: "m" }] };
    const sink = assistantDraftSink({ read: async () => run, act: async value => sent.push(value), attemptId: "a", requestKey: "k", inputIds: ["m"] });
    sink.emit({ type: "answer_delta", attemptId: "a", itemId: "final", delta: "Old answer" }); change(run); await sink.close();
    assert.equal(sent.length, 0);
  }
});

test("public answer deltas reach the real draft route before one final message", async t => {
  let observed;
  const f = await setup(t, async ({ api, event, finish }) => {
    event("item/started", { threadId: "shared-thread", turnId: "shared-turn-1", item: { id: "draft", type: "agentMessage", phase: "final_answer" } });
    event("item/agentMessage/delta", { threadId: "shared-thread", turnId: "shared-turn-1", itemId: "draft", delta: "Working answer" });
    await new Promise(resolve => setTimeout(resolve, 650));
    observed = (await api("owner")).runs[0]; finish("completed");
  });
  const final = await f.run();
  assert.equal(observed.answerDraft.body, "Working answer");
  assert.equal(observed.answerDraftSequence, 1);
  assert.equal(final.result.status, "done");
  assert.equal(final.result.answerDraft ?? null, null);
});
test("same-ID amendments also invalidate public preview text", async () => {
  const sent = [], run = { attemptId: "a", status: "working", revision: 4, inputs: [{ sourceMessageId: "m" }] };
  const sink = assistantDraftSink({ read: async () => run, act: async value => sent.push(value), attemptId: "a", requestKey: "k", inputIds: ["m"], isCurrent: async () => false });
  sink.emit({ type: "answer_delta", attemptId: "a", itemId: "final", delta: "Old answer" }); await sink.close();
  assert.equal(sent.length, 0);
});

test("contribution racing atomic publication recovers without replaying completed work", async t => {
  const f = await setup(t), original = globalThis.fetch; let raced = false;
  globalThis.fetch = async (url, options) => {
    const body = options?.body && JSON.parse(options.body);
    if (!raced && body?.action === "publish") {
      raced = true;
      f.f.store.command(f.f.keys.guest, "commons", { id: randomUUID(), type: "message.posted", data: { messageId: "publish-race", body: "Include keyboard access" } });
      const current = (await f.api("guest")).runs[0];
      await f.api("guest", { action: "contribute", runId: "shared", sourceMessageId: "publish-race", expectedRevision: current.revision });
    }
    return original(url, options);
  };
  try { await assert.rejects(f.run(), /resume to reconcile/); }
  finally { globalThis.fetch = original; }
  assert.equal(f.db.prepare("SELECT publish FROM codex_shared_runs").get().publish, null);
  assert.equal((await f.run()).result.status, "done");
  assert.equal(f.calls.filter(x => x.method === "thread/start").length, 1);
  assert.equal(f.calls.filter(x => x.method === "thread/resume").length, 1);
  assert.equal(f.calls.filter(x => x.method === "turn/start").length, 2);
});
test("human Pause and Resume starts a fresh turn in the original thread", async t => {
  const f = await setup(t, async ({ api, turnNumber, finish }) => {
    if (turnNumber > 1) { finish("completed"); return; }
    const current = (await api("owner")).runs[0];
    await api("owner", { action: "pause", runId: "shared", expectedAttemptId: current.attemptId });
  });
  assert.equal((await f.run()).result.status, "paused");
  const paused = (await f.api("owner")).runs[0];
  await f.api("owner", { action: "resume", runId: "shared", expectedRevision: paused.revision });
  assert.equal((await f.run()).result.status, "done");
  const starts = f.calls.filter(x => x.method === "turn/start");
  assert.equal(starts.length, 2);
  assert.equal(f.calls.filter(x => x.method === "thread/start").length, 1);
  assert.equal(JSON.parse(starts[1].params.input[0].text).context.continuation.previousTurnStatus, "interrupted");
});
test("resolved conflicting direction pauses then resumes with every human input", async t => {
  const f = await setup(t, async ({ api, message, turnNumber, finish }) => {
    if (turnNumber > 1) { finish("completed"); return; }
    message("guest", "conflict-resume", "Change the whole design");
    const current = (await api("guest")).runs[0];
    await api("guest", { action: "contribute", runId: "shared", sourceMessageId: "conflict-resume", conflict: true, expectedRevision: current.revision });
  });
  await assert.rejects(f.run(), /cancellation/);
  const conflict = (await f.api("owner")).runs[0];
  f.f.store.command(f.f.keys.owner, "commons", { id: randomUUID(), type: "message.posted", data: { messageId: "resolution", body: "Keep the simple design and fix login only" } });
  await f.api("owner", { action: "resolve", runId: "shared", sourceMessageId: "resolution", expectedRevision: conflict.revision });
  assert.equal((await f.run()).result.status, "paused");
  const paused = (await f.api("owner")).runs[0];
  await f.api("owner", { action: "resume", runId: "shared", expectedRevision: paused.revision });
  const done = (await f.run()).result;
  assert.equal(done.status, "done"); assert.ok(done.inputs.every(x => x.status === "applied"));
  const starts = f.calls.filter(x => x.method === "turn/start");
  assert.equal(starts.length, 2);
  assert.equal(JSON.parse(starts[1].params.input[0].text).context.inputs.at(-1).resolution, true);
});
test("Stop acknowledgement identities do not collide across human resume", async t => {
  const f = await setup(t, async ({ api, turnNumber }) => {
    const current = (await api("owner")).runs[0];
    await api("owner", { action: turnNumber === 1 ? "pause" : "cancel", runId: "shared", expectedAttemptId: current.attemptId });
  });
  assert.equal((await f.run()).result.status, "paused");
  const paused = (await f.api("owner")).runs[0];
  await f.api("owner", { action: "resume", runId: "shared", expectedRevision: paused.revision });
  assert.equal((await f.run()).result.status, "cancelled");
  assert.equal(f.calls.filter(x => x.method === "turn/interrupt").length, 2);
});
test("coordinator demotion prevents a new continuation turn", async t => {
  const { setTier } = await import("../server/autonomy-tiers.mjs");
  const f = await setup(t, async context => {
    if (context.turnNumber === 1) {
      await appendLate(context, "demotion-input");
      setTier(f.f.store.db, "commons", "producer", "t1_readonly", { updatedBy: "owner", nowMs: f.f.store.now() });
    }
    context.finish("completed");
  });
  await assert.rejects(f.run(), /read.only|autonomy|tier/i);
  assert.equal(f.calls.filter(x => x.method === "turn/start").length, 1);
});
test("observed failed turn remains failed if the transport disconnects immediately afterward", async t => {
  const f = await setup(t, ({ finish }) => finish("failed"));
  const request = f.rpc.request;
  f.rpc.request = async (method, params) => {
    if (method === "thread/read") throw new Error("Transport disconnected after terminal notification");
    return request(method, params);
  };
  assert.equal((await f.run()).result.status, "failed");
  assert.equal(f.calls.filter(x => x.method === "turn/start").length, 1);
});
