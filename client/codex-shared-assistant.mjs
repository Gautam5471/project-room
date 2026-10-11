import { createHash, randomUUID } from "node:crypto";
import { RoomAgentClient } from "./room-agent.mjs";
import { createCodexRuntimeHost } from "./codex-runtime.mjs";
import { createRoomClient } from "../scripts/room-assistant-scratch.mjs";

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const stops = new Set(["pause_requested", "cancel_requested"]);

// One explicitly selected public assistant run, not an addressed reply request.
// Caller supplies the same durable journal and isolated RPC transport as the
// runtime adapter. No ambient sessions, process launch, or provider credentials.
export async function runCodexSharedAssistant({ connection, db, rpc, cwd, policy, runId,
  emit, signal, pollMs = 1000, timeoutMs = 300000 }) {
  if (!Number.isInteger(pollMs) || pollMs < 10 || pollMs > 30000) throw new Error("Invalid control polling interval");
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
  let record = db.prepare("SELECT * FROM codex_shared_runs WHERE id=?").get(key);
  if (!record) {
    if (run.status !== "queued" || run.attemptId) throw new Error("Shared attempt is already owned; reconcile original runtime");
    const attemptId = randomUUID();
    db.prepare("INSERT INTO codex_shared_runs(id,attempt_id,publish) VALUES(?,?,NULL)").run(key, attemptId);
    record = { attempt_id: attemptId, publish: null };
  }
  const attemptId = record.attempt_id;
  const act = data => client.assistant({ runId, attemptId, ...data }, { signal });
  if (record.publish) return act(JSON.parse(record.publish)); // Exact atomic publication retry; no model rerun.
  if (run.attemptId && run.attemptId !== attemptId) throw new Error("Another host owns this shared attempt");
  if (!run.attemptId) run = (await act({ action: "claim", requestId: `codex-claim-${key}`, expectedRevision: run.revision })).result;
  if (run.status !== "working" && !(record.inputs && ["unknown", ...stops].includes(run.status)))
    throw new Error("Shared attempt is not working");
  const binding = { kind: "shared-assistant", origin: connection.origin, roomId: connection.roomId, memberId: connection.memberId,
    runId, attemptId, roomCreatedAt, runCreatedAt: String(run.createdAt) };
  const runtime = createCodexRuntimeHost({ db, rpc, cwd, policy, emit, timeoutMs, scope: connection,
    authorize: async (bound, action) => {
      const current = await read();
      if (current.attemptId !== bound.attemptId || String(current.createdAt) !== bound.runCreatedAt || current.sourceDeleted)
        throw new Error("Shared runtime attempt was revoked");
      if (["start", "steer"].includes(action) && current.status !== "working") throw new Error("Shared runtime is stopping");
    } });
  const inputs = async current => Promise.all(current.inputs.map(async entry => {
    const message = await room.message(entry.sourceMessageId);
    if (!message || message.deletedAt) throw new Error("Shared input is unavailable");
    return { messageId: entry.sourceMessageId, memberId: entry.memberId, body: message.body,
      conflict: Boolean(entry.conflict), resolution: Boolean(entry.resolution) };
  }));
  const recovering = Boolean(record.inputs);
  const selected = recovering ? JSON.parse(record.inputs) : await inputs(run), basis = digest(selected);
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
      if (stops.has(run.status) && !["completed", "interrupted", "failed"].includes(recovered.status)) {
        await runtime.interrupt(binding);
        recovered = await runtime.reconcile(binding);
      }
      if (recovered.status !== "completed") throw new Error("Shared runtime recovery required; original turn is not completed");
      result = { body: recovered.body };
    } else result = await runtime({ run: { id: runId, sourceMessageId: run.sourceMessageId }, inputs: selected, signal: controller.signal }, { binding });
  } catch (error) {
    // Only observed terminal runtime state permits acknowledging a human Stop.
    const current = await read().catch(() => null);
    if (current && current.attemptId === attemptId && stops.has(current.status)) {
      const settled = await runtime.reconcile(binding).catch(() => null);
      if (settled && ["interrupted", "completed", "failed"].includes(settled.status))
        return act({ action: "report", requestId: `codex-stop-${key}`, expectedRevision: current.revision,
          state: current.status === "cancel_requested" ? "cancelled" : "paused", summary: "Execution stopped." });
    }
    throw error;
  } finally { clearInterval(timer); await polling; signal?.removeEventListener("abort", abort); }
  const current = await read();
  if (current.attemptId === attemptId && stops.has(current.status))
    return act({ action: "report", requestId: `codex-stop-${key}`, expectedRevision: current.revision,
      state: current.status === "cancel_requested" ? "cancelled" : "paused", summary: "Execution stopped." });
  if (current.attemptId !== attemptId || !["working", "unknown"].includes(current.status) || current.sourceDeleted)
    throw new Error("Shared result is withheld: attempt stopped or changed");
  if (basis !== digest(await inputs(current))) throw new Error("Shared inputs changed; reconcile result before publishing");
  const publish = { action: "publish", requestId: `codex-publish-${key}`, expectedRevision: current.revision,
    body: result.body, summary: "Completed the shared request.", appliedInputMessageIds: selected.map(item => item.messageId) };
  db.prepare("UPDATE codex_shared_runs SET publish=? WHERE id=?").run(JSON.stringify(publish), key);
  return act(publish); // Server transaction fences late Stop, input changes and replacement attempts.
}
