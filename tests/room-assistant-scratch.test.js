// HS-0: the scratch-room host drives real createRoomServer HTTP routes for
// /assistant, /commands and /conversation. Two humans and one coordinator use
// their own fixture credentials. The default executor is scripted, so these
// tests prove the shared-run contract and host behaviour, not a model runtime.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createRoomClient, runHostOnce, commandExecutor, scriptedExecute, demo, SCRIPTED_LABEL, memberNames } from "../scripts/room-assistant-scratch.mjs";

async function setup(t) {
  const f = createAcceptanceFixture({ dmConsent: true });
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const as = actor => createRoomClient({ origin, roomId: "commons", token: f.keys[actor] });
  const owner = as("owner"), friend = as("guest"), producer = as("producer");
  await owner.act({ action: "configure", requestId: "configure", expectedRevision: 0, name: "Room", coordinatorMemberId: "producer" });
  return { owner, friend, producer };
}

async function ask(owner, friend) {
  await owner.post("ask", "@Room plan dinner for four on Friday");
  let run = (await owner.act({ action: "invoke", requestId: "invoke", runId: "run", sourceMessageId: "ask" })).result;
  await friend.post("add", "Make it 8pm, outdoor seating", { replyToId: "ask" });
  run = (await friend.act({ action: "contribute", requestId: "contribute", runId: "run", sourceMessageId: "add", expectedRevision: run.revision })).result;
  return run;
}

const runOf = async (client, id = "run") => (await client.assistant()).runs.find(r => r.id === id);

test("two people share one request; the host answers once in its thread with both inputs applied", async t => {
  const { owner, friend, producer } = await setup(t);
  assert.equal((await friend.assistant()).assistant.availability, "awaiting_host");
  const asked = await ask(owner, friend);
  assert.deepEqual(asked.inputs.map(i => [i.memberId, i.status]), [["owner", "pending"], ["guest", "pending"]]);
  const briefs = [];
  const { outcomes } = await runHostOnce(producer, { memberId: "producer", execute: async brief => { briefs.push(brief); return scriptedExecute(brief); } });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].state, "done");
  assert.deepEqual(briefs[0].inputs.map(i => [i.memberId, i.body]), [["owner", "@Room plan dinner for four on Friday"], ["guest", "Make it 8pm, outdoor seating"]]);
  const seenByFriend = await runOf(friend), seenByOwner = await runOf(owner);
  assert.deepEqual(seenByFriend, seenByOwner, "both people see the same run");
  assert.equal(seenByFriend.status, "done");
  assert.deepEqual(seenByFriend.inputs.map(i => i.status), ["applied", "applied"]);
  const answer = await friend.message(seenByFriend.resultMessageId);
  assert.equal(answer.replyToId, "ask", "result lands in the request conversation");
  assert.equal(answer.authorId, "producer");
  assert.ok(answer.body.startsWith(SCRIPTED_LABEL), "scripted output says it is scripted");
  assert.match(answer.body, /Make it 8pm/);
  assert.equal((await friend.assistant()).assistant.availability, "awaiting_host", "no unfinished run, so no live host is claimed");
  // A second pass is a no-op: no duplicate claim, report or result post.
  assert.deepEqual((await runHostOnce(producer, { memberId: "producer" })).outcomes, []);
});

test("the answer names people by their room display name, not their member id", async t => {
  const { owner, friend, producer } = await setup(t);
  const members = await owner.members();
  const ownerName = members.owner?.displayName, guestName = members.guest?.displayName;
  assert.ok(ownerName && guestName && ownerName !== "owner" && guestName !== "guest", "fixture members carry display names distinct from ids");
  await ask(owner, friend);
  const { outcomes } = await runHostOnce(producer, { memberId: "producer" });
  const answer = await friend.message(outcomes[0].resultMessageId);
  assert.ok(answer.body.includes(`- ${ownerName}: @Room plan dinner`), answer.body);
  assert.ok(answer.body.includes(`- ${guestName}: Make it 8pm`), answer.body);
  assert.doesNotMatch(answer.body, /^- (owner|guest):/m, "no raw member ids in the answer");
});

test("naming falls back to the member id when the member list can't be read", async () => {
  const names = memberNames({ members: async () => { throw new Error("403"); } });
  assert.equal(await names("guest-4e29", null), "guest-4e29");
  const named = memberNames({ members: async () => ({ m1: { displayName: "  Ana\n Lee " }, m2: { displayName: "" } }) });
  assert.equal(await named("m1", null), "Ana Lee");
  assert.equal(await named("m2", null), "m2");
  assert.equal(await named("m3", { authorName: "Given" }), "Given");
});

test("an addition that lands after the answer is drafted is answered, never dropped", async t => {
  const { owner, friend, producer } = await setup(t);
  await ask(owner, friend);
  let calls = 0;
  const execute = async brief => {
    calls++;
    if (calls === 1) {
      // The friend adds while the host is composing (the done/attach race).
      const current = await runOf(friend);
      await friend.post("late", "Vegetarian options too", { replyToId: "ask" });
      await friend.act({ action: "contribute", requestId: "late-contribute", runId: "run", sourceMessageId: "late", expectedRevision: current.revision });
    }
    return scriptedExecute(brief);
  };
  const { outcomes } = await runHostOnce(producer, { memberId: "producer", execute });
  assert.equal(calls, 2, "host re-read the run and answered again");
  assert.equal(outcomes[0].state, "done");
  assert.deepEqual(outcomes[0].applied, ["ask", "add", "late"]);
  const final = await runOf(owner);
  assert.deepEqual(final.inputs.map(i => i.status), ["applied", "applied", "applied"]);
  assert.match((await owner.message(final.resultMessageId)).body, /Vegetarian options too/);
  assert.equal((await owner.recent()).filter(m => m.authorId === "producer").length, 1, "the late addition is folded in before anything is posted");
});

// Wrap a client so a step runs just before the host's public post: the
// narrowest boundary a client can reach without a server publication fence.
const beforePost = (client, step) => ({ ...client, post: async (...args) => { await step(); return client.post(...args); } });

test("an addition at the publication boundary is refused for done and answered again", async t => {
  const { owner, friend, producer } = await setup(t);
  await ask(owner, friend);
  let once = false;
  const host = beforePost(producer, async () => {
    if (once) return; once = true;
    const current = await runOf(friend);
    await friend.post("edge", "Somewhere quiet", { replyToId: "ask" });
    await friend.act({ action: "contribute", requestId: "edge-contribute", runId: "run", sourceMessageId: "edge", expectedRevision: current.revision });
  });
  const { outcomes } = await runHostOnce(host, { memberId: "producer" });
  assert.equal(outcomes[0].state, "done");
  assert.deepEqual(outcomes[0].applied, ["ask", "add", "edge"]);
  assert.deepEqual((await runOf(owner)).inputs.map(i => i.status), ["applied", "applied", "applied"]);
});

test("Stop or Pause while the executor is still running publishes nothing", async t => {
  for (const stop of ["cancel", "pause"]) await t.test(stop, async t => {
    const { owner, friend, producer } = await setup(t);
    await ask(owner, friend);
    let release, started;
    const running = new Promise(r => { started = r; });
    let calls = 0;
    // First call waits for the Stop; any later call answers at once, so a
    // host that ignored the Stop would publish rather than hang.
    const execute = brief => ++calls > 1 ? scriptedExecute(brief) : new Promise(resolve => { release = () => resolve(scriptedExecute(brief)); started(); });
    const pass = runHostOnce(producer, { memberId: "producer", execute });
    await running;
    const current = await runOf(owner);
    assert.equal(current.status, "working");
    await owner.act({ action: stop, requestId: `${stop}-during`, runId: "run", expectedRevision: current.revision });
    release();
    const { outcomes } = await pass;
    const expected = stop === "cancel" ? "cancelled" : "paused";
    assert.deepEqual(outcomes, [{ runId: "run", state: expected, published: false }]);
    const final = await runOf(friend);
    assert.equal(final.status, expected);
    assert.equal(final.resultMessageId, undefined);
    const page = await friend.recent();
    assert.equal(page.filter(m => m.authorId === "producer").length, 0, "no answer reached the chat");
  });
});

test("a Stop at the publication boundary is acknowledged and the posted answer is reported", async t => {
  const { owner, friend, producer } = await setup(t);
  await ask(owner, friend);
  const host = beforePost(producer, async () => {
    const current = await runOf(owner);
    await owner.act({ action: "cancel", requestId: "edge-cancel", runId: "run", expectedRevision: current.revision });
  });
  const { outcomes } = await runHostOnce(host, { memberId: "producer" });
  assert.equal(outcomes[0].state, "cancelled");
  assert.match(outcomes[0].postedBeforeStop, /^result-/, "the residual race is surfaced, not hidden");
  const final = await runOf(friend);
  assert.equal(final.status, "cancelled");
  assert.equal(final.resultMessageId, undefined, "a stopped run never claims a result");
});

test("the host reports executor failure and acknowledges pause, resume and cancel", async t => {
  const { owner, friend, producer } = await setup(t);
  await ask(owner, friend);
  // An executor failure is reported as failed, never as done.
  const broken = async () => { throw new Error("model unavailable"); };
  assert.deepEqual((await runHostOnce(producer, { memberId: "producer", execute: broken })).outcomes, [{ runId: "run", state: "failed" }]);
  let run = await runOf(owner);
  assert.equal(run.status, "failed");
  assert.match(run.activity.at(-1).summary, /model unavailable/);
  // Fresh request for the stop controls.
  await owner.post("ask-2", "@Room second request");
  run = (await owner.act({ action: "invoke", requestId: "invoke-2", runId: "run-2", sourceMessageId: "ask-2" })).result;
  await producer.act({ action: "claim", requestId: "claim-2", runId: "run-2", attemptId: "producer-run-2", expectedRevision: run.revision });
  run = await runOf(owner, "run-2");
  await owner.act({ action: "pause", requestId: "pause-2", runId: "run-2", expectedRevision: run.revision });
  await runHostOnce(producer, { memberId: "producer" });
  run = await runOf(friend, "run-2");
  assert.equal(run.status, "paused");
  await owner.act({ action: "resume", requestId: "resume-2", runId: "run-2", expectedRevision: run.revision });
  run = await runOf(owner, "run-2");
  assert.equal(run.status, "resume_requested");
  await owner.act({ action: "cancel", requestId: "cancel-2", runId: "run-2", expectedRevision: run.revision });
  const { outcomes } = await runHostOnce(producer, { memberId: "producer" });
  assert.deepEqual(outcomes, [{ runId: "run-2", state: "cancelled" }]);
  run = await runOf(friend, "run-2");
  assert.equal(run.status, "cancelled");
  assert.equal(run.resultMessageId, undefined, "a cancelled run publishes no result");
});

test("a host that is not the configured coordinator does nothing", async t => {
  const { owner, friend } = await setup(t);
  await ask(owner, friend);
  const result = await runHostOnce(owner, { memberId: "owner" });
  assert.equal(result.skipped, "not_coordinator");
  assert.equal((await runOf(friend)).status, "queued");
});

test("--exec pipes the brief to a command and publishes its stdout", async t => {
  const { owner, friend, producer } = await setup(t);
  await ask(owner, friend);
  const script = "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const b=JSON.parse(s);console.log('EXEC saw '+b.inputs.map(i=>i.memberId).join('+'))})";
  const execute = commandExecutor(`${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`, { timeoutMs: 20000 });
  const { outcomes } = await runHostOnce(producer, { memberId: "producer", execute });
  assert.equal(outcomes[0].state, "done");
  assert.equal((await friend.message(outcomes[0].resultMessageId)).body, "EXEC saw owner+guest");
  const failing = commandExecutor(`${JSON.stringify(process.execPath)} -e "process.exit(3)"`, { timeoutMs: 20000 });
  await assert.rejects(failing({ inputs: [] }), /exited 3/);
});

test("demo runs the two-person flow end to end", async () => {
  const lines = [];
  const { final, answer } = await demo({ print: line => lines.push(line) });
  assert.equal(final.status, "done");
  assert.equal(answer.replyToId, "demo-ask");
  assert.ok(lines.some(line => line.includes("guest:applied")));
});

test("a host restarted after a crash picks its own stalled run back up and answers once", async t => {
  const f = createAcceptanceFixture({ dmConsent: true });
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const as = actor => createRoomClient({ origin, roomId: "commons", token: f.keys[actor] });
  const owner = as("owner"), friend = as("guest"), producer = as("producer");
  await owner.act({ action: "configure", requestId: "configure", expectedRevision: 0, name: "Room", coordinatorMemberId: "producer" });
  const asked = await ask(owner, friend);
  // The first host process claimed with its stable attempt id, then died.
  await producer.act({ action: "claim", requestId: "claim-before-crash", runId: "run", attemptId: "producer-run", expectedRevision: asked.revision });
  const realNow = f.store.now;
  f.store.now = () => realNow.call(f.store) + 130000;
  assert.equal((await runOf(owner)).status, "unknown", "a silent host reads as unknown after two minutes");
  const { outcomes } = await runHostOnce(producer, { memberId: "producer" });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].state, "done", JSON.stringify(outcomes));
  assert.equal((await friend.recent()).filter(m => m.authorId === "producer").length, 1, "answered exactly once");
  assert.deepEqual((await runHostOnce(producer, { memberId: "producer" })).outcomes, []);
});
