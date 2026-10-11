#!/usr/bin/env node
// Scratch-room host for the shared Room assistant (HS-0).
//
// This is a small, real host loop for POST/GET /api/rooms/{roomId}/assistant:
// it claims queued runs for its coordinator identity, reads every human input
// by message id, publishes one public result in the request conversation and
// reports done with every applied input. It honours pause/cancel/resume and a
// contribution that races completion (assistant_inputs_pending).
//
// What it is not: a model runtime. The default executor is scripted and says
// so in every result. Pass --exec "<command>" to pipe a JSON brief to a real
// model CLI on stdin and publish its stdout instead.
//
//   node scripts/room-assistant-scratch.mjs host --config <dir> [--member <id>] [--once] [--exec "<cmd>"]
//   node scripts/room-assistant-scratch.mjs demo      (local server, two humans, one host)
//
// <dir>/connection.json holds { origin, roomId, token, memberId? }. The token
// is read from disk and never printed.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createRoomClient } from "../client/room-assistant-client.mjs";
export { createRoomClient } from "../client/room-assistant-client.mjs";

export const SCRIPTED_LABEL = "Scripted scratch host (no model)";
const TERMINAL = new Set(["done", "failed", "cancelled"]);
const stable = (...parts) => createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);

// Default executor: deterministic, labelled, and honest that nothing reasoned.
export async function scriptedExecute(brief) {
  const lines = brief.inputs.map(input => `- ${input.author}: ${input.body}`);
  return [`${SCRIPTED_LABEL}. I read ${brief.inputs.length} input${brief.inputs.length === 1 ? "" : "s"} from ${new Set(brief.inputs.map(i => i.author)).size} people:`, ...lines].join("\n");
}

// Real-runtime hook: pipe the brief as JSON on stdin; stdout is the answer.
export function commandExecutor(command, { timeoutMs = 120000 } = {}) {
  return brief => new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`executor timed out after ${timeoutMs} ms`)); }, timeoutMs);
    child.stdout.on("data", d => { out += d; }); child.stderr.on("data", d => { err += d; });
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`executor exited ${code}: ${err.trim().slice(0, 200)}`));
      else if (!out.trim()) reject(new Error("executor printed no answer"));
      else resolve(out.trim().slice(0, 8000));
    });
    child.stdin.end(JSON.stringify(brief));
  });
}

async function brief(client, run, names) {
  const opening = await client.message(run.sourceMessageId);
  const inputs = [];
  for (const input of run.inputs) {
    const message = input.sourceMessageId === run.sourceMessageId ? opening : await client.message(input.sourceMessageId);
    inputs.push({ messageId: input.sourceMessageId, memberId: input.memberId, author: await names(input.memberId, message), body: message?.body ?? "", conflict: Boolean(input.conflict), resolution: Boolean(input.resolution) });
  }
  return { roomId: client.roomId, runId: run.id, requestMessageId: run.sourceMessageId, initiatorId: run.initiatorId, inputs, opening };
}

// One pass over every run this host coordinates. Safe to repeat: claims and
// reports use stable request ids, and result message ids derive from the
// exact input set, so a retry never posts a second copy.
// People are named by their room display name, read once per pass from the
// room's member list; an unreadable list or a missing name falls back to the
// member id so a brief is never blocked on naming.
export function memberNames(client) {
  let directory;
  return async (id, message) => {
    if (message?.authorName) return message.authorName;
    if (directory === undefined) directory = client.members ? await client.members().catch(() => null) : null;
    const name = directory?.[id]?.displayName;
    return typeof name === "string" && name.trim() ? name.replace(/\s+/g, " ").trim() : id;
  };
}

export async function runHostOnce(client, { memberId, hostId = memberId, execute = scriptedExecute, log = () => {}, names = memberNames(client) } = {}) {
  const outcomes = [];
  const { runs, assistant } = await client.assistant();
  if (assistant.coordinatorMemberId !== memberId) return { outcomes, skipped: "not_coordinator" };
  for (let run of runs) {
    if (run.coordinatorMemberId !== memberId || TERMINAL.has(run.status) || run.sourceDeleted) continue;
    const attemptId = `${hostId}-${run.id}`.slice(0, 128);
    const report = (state, summary, extra = {}) => client.act({ action: "report", requestId: stable("report", run.id, run.revision, state, extra.resultMessageId ?? ""), runId: run.id, attemptId, expectedRevision: run.revision, state, summary, ...extra });
    if (run.attemptId && run.attemptId !== attemptId) { outcomes.push({ runId: run.id, skipped: "other_attempt" }); continue; }
    if (run.status === "queued" && !run.attemptId) {
      run = (await client.act({ action: "claim", requestId: stable("claim", run.id, attemptId), runId: run.id, attemptId, expectedRevision: run.revision })).result;
      log(`claimed ${run.id}`);
    }
    const acknowledge = async current => {
      run = current;
      if (run.status === "pause_requested") return (await report("paused", "Paused at the requester's ask.")).result.status;
      if (run.status === "cancel_requested") return (await report("cancelled", "Stopped at the requester's ask.")).result.status;
      return null;
    };
    const stopped = await acknowledge(run);
    if (stopped) { outcomes.push({ runId: run.id, state: stopped }); continue; }
    if (run.status === "resume_requested") run = (await report("working", "Resumed.")).result;
    // A run this host reserved reads "unknown" once its reports go quiet for two
    // minutes (a crash or restart). The attempt id is stable, so pick it back up.
    if (run.status === "unknown" && run.attemptId === attemptId) run = (await report("working", "Picked up again after a host restart.")).result;
    if (run.status !== "working") { outcomes.push({ runId: run.id, waiting: run.status }); continue; }
    const reread = async () => (await client.assistant()).runs.find(r => r.id === run.id);
    // Each attempt: brief, execute, re-read, then publish only if the run is
    // still working at the same revision. A Stop or Pause during execution
    // publishes nothing; a late addition re-briefs before anything is posted.
    // The server has no run-bound publication yet, so a Stop that lands in
    // the instant between the final read and the post can still leave one
    // answer in chat; the host then acknowledges the stop and says so.
    let outcome = null;
    for (let attempt = 0; attempt < 4 && !outcome; attempt++) {
      const input = await brief(client, run, names);
      let answer;
      try { answer = await execute(input); }
      catch (failure) {
        const current = await reread();
        const state = current?.status === "working" ? (run = current, (await report("failed", `Couldn't finish: ${failure.message}`.slice(0, 2000))).result.status) : await acknowledge(current);
        outcome = { runId: run.id, state: state ?? current?.status }; break;
      }
      const current = await reread();
      if (!current || current.status !== "working") { outcome = { runId: run.id, state: (current && await acknowledge(current)) ?? current?.status ?? "missing", published: false }; break; }
      if (current.revision !== run.revision) { run = current; log(`run ${run.id} changed while composing; answering again`); continue; }
      const applied = run.inputs.map(i => i.sourceMessageId);
      const resultMessageId = `result-${stable(run.id, ...applied)}`;
      await client.post(resultMessageId, answer, { replyToId: run.sourceMessageId, ...(input.opening?.channelId ? { channelId: input.opening.channelId } : {}) });
      try {
        const done = await report("done", `Answered with ${applied.length} input${applied.length === 1 ? "" : "s"}.`, { resultMessageId, appliedInputMessageIds: applied });
        outcome = { runId: run.id, state: done.result.status, resultMessageId, applied }; log(`done ${run.id}`);
      } catch (failure) {
        if (!["assistant_inputs_pending", "assistant_revision_conflict"].includes(failure.code)) throw failure;
        const latest = await reread();
        if (!latest || latest.status !== "working") { outcome = { runId: run.id, state: (latest && await acknowledge(latest)) ?? latest?.status ?? "missing", postedBeforeStop: resultMessageId }; break; }
        run = latest; log(`late input on ${run.id}; answering again`);
      }
    }
    outcomes.push(outcome ?? { runId: run.id, waiting: "retry_limit" });
  }
  return { outcomes };
}

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) { const key = argv[i].slice(2); out[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true; }
    else out._.push(argv[i]);
  }
  return out;
}

async function host(opts) {
  if (!opts.config) throw new Error("host needs --config <dir> with connection.json");
  const connection = JSON.parse(readFileSync(join(opts.config, "connection.json"), "utf8"));
  const memberId = opts.member || connection.memberId;
  if (!connection.origin || !connection.roomId || !connection.token || !memberId) throw new Error("connection.json needs origin, roomId, token and memberId (or pass --member)");
  const client = createRoomClient(connection);
  const execute = opts.exec ? commandExecutor(String(opts.exec)) : scriptedExecute;
  if (!opts.exec) console.error(`${SCRIPTED_LABEL}: results prove the run contract, not a model runtime.`);
  const interval = Math.max(2, Number(opts.interval) || 5) * 1000;
  for (;;) {
    try { const { outcomes, skipped } = await runHostOnce(client, { memberId, execute, log: m => console.error(m) }); if (skipped) console.error(`not the configured coordinator (${skipped})`); else for (const o of outcomes) console.log(JSON.stringify(o)); }
    catch (failure) { console.error(`host pass failed: ${failure.code || failure.status || ""} ${failure.message}`); }
    if (opts.once) return;
    await new Promise(r => setTimeout(r, interval));
  }
}

// Two humans and one host against a disposable local server, all over HTTP.
export async function demo({ print = console.log } = {}) {
  const { createAcceptanceFixture } = await import("./acceptance-fixture.mjs");
  const { createRoomServer } = await import("../server/http.mjs");
  const f = createAcceptanceFixture({ dmConsent: true });
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const as = actor => createRoomClient({ origin, roomId: "commons", token: f.keys[actor] });
    const owner = as("owner"), friend = as("guest"), producer = as("producer");
    await owner.act({ action: "configure", requestId: "demo-configure", expectedRevision: 0, name: "Room", coordinatorMemberId: "producer" });
    await owner.post("demo-ask", "@Room plan dinner for four on Friday");
    let run = (await owner.act({ action: "invoke", requestId: "demo-invoke", runId: "demo-run", sourceMessageId: "demo-ask" })).result;
    print(`owner asked: ${run.status}`);
    await friend.post("demo-add", "Make it 8pm, outdoor seating", { replyToId: "demo-ask" });
    run = (await friend.act({ action: "contribute", requestId: "demo-contribute", runId: "demo-run", sourceMessageId: "demo-add", expectedRevision: run.revision })).result;
    print(`friend added: ${run.inputs.map(i => `${i.memberId}:${i.status}`).join(", ")}`);
    const { outcomes } = await runHostOnce(producer, { memberId: "producer" });
    const final = (await friend.assistant()).runs.find(r => r.id === "demo-run");
    const answer = await friend.message(final.resultMessageId);
    print(`host: ${JSON.stringify(outcomes)}`);
    print(`friend sees ${final.status}, inputs ${final.inputs.map(i => `${i.memberId}:${i.status}`).join(", ")}`);
    print(`result (${answer?.replyToId === "demo-ask" ? "in the request thread" : "elsewhere"}):\n${answer?.body}`);
    return { final, answer };
  } finally { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); f.store.close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const opts = args(process.argv.slice(2));
  const command = opts._[0];
  (command === "host" ? host(opts) : command === "demo" ? demo() : Promise.reject(new Error("usage: room-assistant-scratch.mjs host --config <dir> [--member <id>] [--once] [--exec <cmd>] | demo")))
    .catch(failure => { console.error(failure.message); process.exitCode = 1; });
}
