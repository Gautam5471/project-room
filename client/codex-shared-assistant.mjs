import { createHash, randomUUID } from "node:crypto";
import { RoomAgentClient } from "./room-agent.mjs";
import { createCodexRuntimeHost } from "./codex-runtime.mjs";
import { createRoomClient } from "./room-assistant-client.mjs";

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const stops = new Set(["pause_requested", "cancel_requested"]);

// Best-effort public answer previews. The final result still uses atomic publish.
// Full snapshots are bounded/throttled; no tool arguments or private reasoning.
export function assistantDraftSink({ read, act, attemptId, requestKey, inputIds, isCurrent = async () => true, emit = () => {}, intervalMs = 500 }) {
  const parts = new Map(); let timer = null, pending = null, closed = false, sequence = 0, sent = "", checkedRevision = null;
  const send = async () => {
    const body = [...parts.values()].join("\n").slice(0, 65536).toWellFormed();
    if (!body.trim() || body === sent) return;
    try {
      const current = await read();
      if (current.attemptId !== attemptId || current.status !== "working" || current.sourceDeleted
        || JSON.stringify(current.inputs.map(item => item.sourceMessageId)) !== JSON.stringify(typeof inputIds === "function" ? inputIds() : inputIds)) return;
      if (current.revision !== checkedRevision) {
        if (!await isCurrent(current)) return;
        checkedRevision = current.revision;
      }
      sequence = Math.max(sequence, current.answerDraftSequence ?? current.answerDraft?.sequence ?? 0) + 1;
      await act({ action: "draft", requestId: `codex-draft-${requestKey}-${sequence}`, sequence, body, expectedRevision: current.revision });
      sent = body;
    } catch { /* Preview failure cannot rerun or invalidate completed work. */ }
  };
  const flush = () => pending ??= send().finally(() => { pending = null; });
  return {
    emit(event) {
      emit(event);
      if (closed || event.type !== "answer_delta" || event.attemptId !== attemptId
        || event.phase != null && event.phase !== "final_answer" || typeof event.itemId !== "string" || typeof event.delta !== "string") return;
      if (!parts.has(event.itemId) && parts.size >= 32) return;
      parts.set(event.itemId, `${parts.get(event.itemId) ?? ""}${event.delta}`.slice(0, 65536));
      if (!timer) timer = setTimeout(() => { timer = null; void flush(); }, intervalMs);
    },
    async close() { closed = true; clearTimeout(timer); await pending; await flush(); }
  };
}

// One explicitly selected public assistant run, not an addressed reply request.
// Caller supplies the same durable journal and isolated RPC transport as the
// runtime adapter. No ambient sessions, process launch, or provider credentials.
export async function runCodexSharedAssistant({ connection, db, rpc, cwd, policy, runId,
  emit, signal, pollMs = 1000, timeoutMs = 300000, maxContinuations = 8 }) {
  if (!Number.isInteger(pollMs) || pollMs < 10 || pollMs > 30000) throw new Error("Invalid control polling interval");
  if (!Number.isInteger(maxContinuations) || maxContinuations < 0 || maxContinuations > 32) throw new Error("Invalid continuation limit");
  const client = new RoomAgentClient(connection), room = createRoomClient(connection);
  const snapshot = await client.snapshot({ signal });
  if (snapshot.viewerId !== connection.memberId) throw new Error("Wrong Room identity");
  const roomCreatedAt = snapshot.state.room.createdAt;
  const read = async () => {
    const state = await client.assistant(undefined, { signal });
    const run = state.runs.find(item => item.id === runId);
    if (!run || run.coordinatorMemberId !== connection.memberId) throw new Error("Shared run is not assigned to this member");
    return run;
  };
  let run = await read();
  const key = digest([connection.origin, connection.roomId, connection.memberId, roomCreatedAt, run.id, run.createdAt]);
  db.exec("CREATE TABLE IF NOT EXISTS codex_shared_runs (id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, publish TEXT)");
  if (!db.prepare("PRAGMA table_info(codex_shared_runs)").all().some(column => column.name === "inputs"))
    db.exec("ALTER TABLE codex_shared_runs ADD COLUMN inputs TEXT");
  for (const column of ["continuation", "previous_binding", "prior_result"])
    if (!db.prepare("PRAGMA table_info(codex_shared_runs)").all().some(entry => entry.name === column))
      db.exec(`ALTER TABLE codex_shared_runs ADD COLUMN ${column} TEXT`);
  let record = db.prepare("SELECT * FROM codex_shared_runs WHERE id=?").get(key);
  if (!record) {
    if (run.status !== "queued" || run.attemptId) throw new Error("Shared attempt is already owned; reconcile original runtime");
    const attemptId = randomUUID();
    db.prepare("INSERT INTO codex_shared_runs(id,attempt_id,publish) VALUES(?,?,NULL)").run(key, attemptId);
    record = { attempt_id: attemptId, publish: null };
  }
  const attemptId = record.attempt_id;
  const act = data => client.assistant({ runId, attemptId, ...data }, { signal });
  if (record.publish) {
    try { return await act(JSON.parse(record.publish)); } // Exact atomic retry; no model rerun.
    catch (error) {
      if (error.code !== "assistant_revision_conflict") throw error;
      db.prepare("UPDATE codex_shared_runs SET publish=NULL WHERE id=? AND publish=?").run(key, record.publish);
      record.publish = null;
      run = await read();
    }
  }
  if (run.attemptId && run.attemptId !== attemptId) throw new Error("Another host owns this shared attempt");
  if (!run.attemptId) run = (await act({ action: "claim", requestId: `codex-claim-${key}`, expectedRevision: run.revision })).result;
  if (run.status !== "working" && !(record.inputs && ["unknown", "resume_requested", ...stops].includes(run.status)))
    throw new Error("Shared attempt is not working");
  const binding = { kind: "shared-assistant", origin: connection.origin, roomId: connection.roomId, memberId: connection.memberId,
    runId, attemptId, roomCreatedAt, runCreatedAt: String(run.createdAt), ...(record.continuation ? { continuationId: record.continuation } : {}) };
  // The sink reads current scope before each snapshot, including after a
  // contribution clears the previous preview. Each continuation has fresh text.
  const draft = assistantDraftSink({ read, act, attemptId, requestKey: key,
    inputIds: () => selected.map(item => item.messageId), isCurrent: async current => basis === digest(await inputs(current)), emit });
  const runtime = createCodexRuntimeHost({ db, rpc, cwd, policy, emit: event => draft.emit(event), timeoutMs, scope: connection,
    authorize: async (bound, action) => {
      const current = await read();
      if (current.attemptId !== bound.attemptId || String(current.createdAt) !== bound.runCreatedAt || current.sourceDeleted)
        throw new Error("Shared runtime attempt was revoked");
      if (["start", "steer"].includes(action)) {
        if (current.status !== "working") throw new Error("Shared runtime is stopping");
        // Server rechecks current coordinator, permissions and autonomy tier.
        // A run projection alone does not authorize another external action.
        await act({ action: "report", requestId: `codex-authorize-${randomUUID()}`, expectedRevision: current.revision,
          state: "working", summary: "Working on the shared request." });
      }
    } });
  const inputs = async current => Promise.all(current.inputs.map(async entry => {
    const message = await room.message(entry.sourceMessageId);
    if (!message || message.deletedAt) throw new Error("Shared input is unavailable");
    return { messageId: entry.sourceMessageId, memberId: entry.memberId, body: message.body,
      conflict: Boolean(entry.conflict), resolution: Boolean(entry.resolution) };
  }));
  if (run.status === "resume_requested") {
    const prior = record.prior_result ? JSON.parse(record.prior_result) : null;
    if (prior?.resumeRevision !== run.revision) {
      const settled = await runtime.reconcile(binding);
      if (!["completed", "interrupted"].includes(settled.status)) throw new Error("Original turn is not confirmed stopped; reconcile before resuming");
      const round = Number(record.continuation ?? 0) + 1;
      if (round > maxContinuations) throw new Error("Shared continuation limit reached; request remains paused");
      const selected = await inputs(run);
      db.prepare("UPDATE codex_shared_runs SET inputs=?,continuation=?,previous_binding=?,prior_result=?,publish=NULL WHERE id=? AND continuation IS ?")
        .run(JSON.stringify(selected), String(round), JSON.stringify(binding), JSON.stringify({
          body: settled.body ?? "", previousTurnStatus: settled.status, resumeRevision: run.revision,
          changes: selected, priorInputMessageIds: JSON.parse(record.inputs).map(item => item.messageId)
        }), key, record.continuation ?? null);
      record = db.prepare("SELECT * FROM codex_shared_runs WHERE id=?").get(key);
      binding.continuationId = record.continuation;
    }
    run = (await act({ action: "report", requestId: `codex-resume-${key}-${record.continuation}`, expectedRevision: run.revision,
      state: "working", summary: "Continuing the shared request." })).result;
  }
  const previousBinding = record.previous_binding ? JSON.parse(record.previous_binding) : null;
  const recovering = Boolean(record.inputs);
  const selected = recovering ? JSON.parse(record.inputs) : await inputs(run), basis = digest(selected);
  const continuation = record.prior_result ? JSON.parse(record.prior_result) : null;
  const executionInput = { run: { id: runId, sourceMessageId: run.sourceMessageId },
    inputs: continuation ? continuation.changes : selected,
    ...(continuation ? { continuation: { previousTurnCompleted: (continuation.previousTurnStatus ?? "completed") === "completed",
      previousTurnStatus: continuation.previousTurnStatus ?? "completed", priorResult: continuation.body,
      priorInputMessageIds: continuation.priorInputMessageIds,
      instruction: "Address these current inputs using the existing thread. Inspect the prior turn and its recorded outcome before taking action: it may have completed external actions even if interrupted. Do not blindly repeat them; reconcile their results and explain any additional action required." } } : {}) };
  if (!recovering) db.prepare("UPDATE codex_shared_runs SET inputs=? WHERE id=?").run(JSON.stringify(selected), key);
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let polling = null, requestedStop = false, lastHeartbeat = Date.now();
  const timer = setInterval(() => {
    if (polling) return;
    polling = (async () => {
      const current = await read();
      if (current.attemptId !== attemptId || current.sourceDeleted
        || !["working", "unknown", "pause_requested", "cancel_requested"].includes(current.status)) { controller.abort(); return; }
      if (stops.has(current.status) && !requestedStop) { requestedStop = true; await runtime.interrupt(binding); }
      else if (["working", "unknown"].includes(current.status) && Date.now() - lastHeartbeat >= 30000) {
        await act({ action: "report", requestId: `codex-heartbeat-${key}-${current.revision}`,
          expectedRevision: current.revision, state: "working", summary: "Working on the shared request." });
        lastHeartbeat = Date.now();
      }
    })().catch(error => { if (error.code !== "assistant_revision_conflict") controller.abort(); }).finally(() => { polling = null; });
  }, pollMs);
  let result;
  try {
    if (recovering) {
      let recovered = await runtime.reconcile(binding);
      if (stops.has(run.status) && !["completed", "interrupted", "failed", "not_started"].includes(recovered.status)) {
        await runtime.interrupt(binding);
        recovered = await runtime.reconcile(binding);
      }
      if (recovered.status === "not_started" && run.status === "working")
        result = await runtime({ ...executionInput, signal: controller.signal }, { binding, previousBinding });
      else {
        if (recovered.status !== "completed") throw new Error("Shared runtime recovery required; original turn is not completed");
        result = { body: recovered.body };
      }
    } else result = await runtime({ ...executionInput, signal: controller.signal }, { binding, previousBinding });
  } catch (error) {
    // Only observed terminal runtime state permits acknowledging a human Stop.
    const current = await read().catch(() => null);
    const settled = current?.attemptId === attemptId ? await runtime.reconcile(binding).catch(() => null) : null;
    if (current && current.attemptId === attemptId && stops.has(current.status)) {
      if (settled && ["interrupted", "completed", "failed", "not_started"].includes(settled.status))
        return act({ action: "report", requestId: `codex-stop-${key}-${record.continuation ?? 0}-${current.revision}`, expectedRevision: current.revision,
          state: current.status === "cancel_requested" ? "cancelled" : "paused", summary: "Execution stopped." });
    }
    if (current && ["working", "unknown"].includes(current.status) && settled?.status === "failed")
      return act({ action: "report", requestId: `codex-failed-${key}-${record.continuation ?? 0}`, expectedRevision: current.revision,
        state: "failed", summary: "The agent could not finish. Check the agent host for the error, then retry." });
    throw error;
  } finally { clearInterval(timer); await polling; await draft.close(); signal?.removeEventListener("abort", abort); }
  const current = await read();
  if (current.attemptId === attemptId && stops.has(current.status))
    return act({ action: "report", requestId: `codex-stop-${key}-${record.continuation ?? 0}-${current.revision}`, expectedRevision: current.revision,
      state: current.status === "cancel_requested" ? "cancelled" : "paused", summary: "Execution stopped." });
  if (current.attemptId !== attemptId || !["working", "unknown"].includes(current.status) || current.sourceDeleted)
    throw new Error("Shared result is withheld: attempt stopped or changed");
  const currentInputs = await inputs(current);
  if (basis !== digest(currentInputs)) {
    const round = Number(record.continuation ?? 0) + 1;
    if (round > maxContinuations) throw new Error("Shared continuation limit reached; new inputs remain pending");
    const before = new Map(selected.map(item => [item.messageId, digest(item)]));
    const changes = currentInputs.filter(item => before.get(item.messageId) !== digest(item));
    if (!changes.length) throw new Error("Shared input history changed; reconcile before continuing");
    // Persist the next exact input set before starting its turn. A lost start
    // response remains uncertain in the runtime journal and is never resent.
    db.prepare("UPDATE codex_shared_runs SET inputs=?,continuation=?,previous_binding=?,prior_result=?,publish=NULL WHERE id=? AND continuation IS ?")
      .run(JSON.stringify(currentInputs), String(round), JSON.stringify(binding),
        JSON.stringify({ body: result.body, changes, priorInputMessageIds: selected.map(item => item.messageId) }), key, record.continuation ?? null);
    return runCodexSharedAssistant({ connection, db, rpc, cwd, policy, runId, emit, signal, pollMs, timeoutMs, maxContinuations });
  }
  const publish = { action: "publish", requestId: `codex-publish-${key}-${record.continuation ?? 0}`, expectedRevision: current.revision,
    body: result.body, summary: "Completed the shared request.", appliedInputMessageIds: selected.map(item => item.messageId) };
  db.prepare("UPDATE codex_shared_runs SET publish=? WHERE id=?").run(JSON.stringify(publish), key);
  try { return await act(publish); } // Server transaction fences Stop, changed inputs and replacement attempts.
  catch (error) {
    if (error.code !== "assistant_revision_conflict") throw error;
    // A contribution can land between the final read and atomic publish. Drop
    // only this unaccepted publication, then reconcile the completed turn.
    db.prepare("UPDATE codex_shared_runs SET publish=NULL WHERE id=? AND publish=?").run(key, JSON.stringify(publish));
    throw new Error("Shared inputs changed during publication; resume to reconcile the completed turn", { cause: error });
  }
}
