import { createHash } from "node:crypto";
import { createHostEnvelope } from "./host-context-policy.mjs";
import { RoomAgentClient } from "./room-agent.mjs";

// Protocol fields checked against Codex rust-v0.162.1 (092d3acd), not the
// experimental UI protocol. Transport is supplied by the operator's isolated
// runtime integration: this module never launches processes or reads Codex HOME.
export const CODEX_RUNTIME_PROTOCOL = "rust-v0.162.1";
const connections = new WeakMap();
const terminal = new Set(["completed", "interrupted", "failed"]);
const fields = ["origin", "roomId", "memberId", "requestMessageId", "requestId", "attemptId", "roomCreatedEventId", "openingEventId"];
const textInput = text => [{ type: "text", text, text_elements: [] }];
const bindingFields = binding => binding?.kind === "shared-assistant"
  ? ["origin", "roomId", "memberId", "runId", "attemptId", "roomCreatedAt", "runCreatedAt", ...(binding.continuationId ? ["continuationId"] : [])] : fields;
const keyFor = binding => createHash("sha256").update(JSON.stringify([binding.kind ?? "addressed-request", ...bindingFields(binding).map(key => binding[key])])).digest("hex");

// `rpc` implements request(method, params), notify(method, params), and
// subscribe(listener) -> unsubscribe. It must reject requests on disconnect;
// transport retries are forbidden for turn/start and turn/steer.
// `authorize` revalidates Room ownership and exact attempt before each control.
export function createCodexRuntimeHost({ db, rpc, scope, authorize, cwd, policy, emit = () => {}, timeoutMs = 300000 }) {
  if (!db || !rpc?.request || !rpc?.notify || !rpc?.subscribe || typeof authorize !== "function"
    || typeof cwd !== "string" || !cwd.startsWith("/") || !Number.isInteger(timeoutMs) || timeoutMs < 10)
    throw new Error("Explicit journal, scoped transport, authorization and workspace are required");
  if (!["never", "on-request"].includes(policy?.approvalPolicy) || !["read-only", "workspace-write"].includes(policy?.sandbox))
    throw new Error("Explicit runtime approval and sandbox policy required");
  const selectedPolicy = { approvalPolicy: policy.approvalPolicy, sandbox: policy.sandbox };
  if (!["origin", "roomId", "memberId"].every(key => typeof scope?.[key] === "string" && scope[key]))
    throw new Error("Runtime needs a pinned Room identity");
  db.exec(`CREATE TABLE IF NOT EXISTS codex_runtime_attempts (
    id TEXT PRIMARY KEY, binding TEXT NOT NULL, thread_id TEXT, turn_id TEXT,
    state TEXT NOT NULL, result TEXT);
    CREATE TABLE IF NOT EXISTS codex_runtime_inputs (
    attempt_id TEXT NOT NULL, input_id TEXT NOT NULL, text TEXT NOT NULL,
    state TEXT NOT NULL, PRIMARY KEY(attempt_id,input_id));
    CREATE TABLE IF NOT EXISTS codex_runtime_outputs (
    attempt_id TEXT NOT NULL, item_id TEXT NOT NULL, text TEXT NOT NULL,
    PRIMARY KEY(attempt_id,item_id));`);
  if (!db.prepare("PRAGMA table_info(codex_runtime_outputs)").all().some(column => column.name === "phase"))
    db.exec("ALTER TABLE codex_runtime_outputs ADD COLUMN phase TEXT");
  const get = id => db.prepare("SELECT * FROM codex_runtime_attempts WHERE id=?").get(id);
  const patch = (id, state) => db.prepare("UPDATE codex_runtime_attempts SET state=? WHERE id=?").run(state, id);
  const ready = () => {
    if (!connections.has(rpc)) connections.set(rpc, (async () => {
      await rpc.request("initialize", { clientInfo: { name: "project_room", title: "Project Room", version: "0.1.0" } });
      rpc.notify("initialized", {});
    })());
    return connections.get(rpc);
  };
  const checked = async (binding, action) => {
    if (!bindingFields(binding).every(key => typeof binding?.[key] === "string" && binding[key])
      || ["origin", "roomId", "memberId"].some(key => binding[key] !== scope[key]))
      throw new Error("Runtime binding has the wrong Room identity");
    await authorize(binding, action);
    return keyFor(binding);
  };
  const saveItem = (id, item) => {
    if (item?.type !== "agentMessage" || typeof item.id !== "string" || typeof item.text !== "string") return;
    db.prepare("INSERT INTO codex_runtime_outputs VALUES(?,?,?,?) ON CONFLICT(attempt_id,item_id) DO UPDATE SET text=excluded.text,phase=excluded.phase")
      .run(id, item.id, item.text, item.phase ?? null);
  };
  const recordTurn = (id, turn) => {
    if (!turn || typeof turn.id !== "string" || ![...terminal, "inProgress"].includes(turn.status))
      throw new Error("Invalid runtime turn");
    const saved = get(id);
    if (saved.turn_id && saved.turn_id !== turn.id) throw new Error("Runtime returned a different turn");
    for (const item of turn.items ?? []) saveItem(id, item);
    const outputs = db.prepare("SELECT text,phase FROM codex_runtime_outputs WHERE attempt_id=? ORDER BY rowid").all(id);
    const final = outputs.some(item => item.phase === "final_answer")
      ? outputs.filter(item => item.phase === "final_answer") : outputs.filter(item => item.phase === null);
    const result = turn.status === "completed" ? final.map(item => item.text).join("\n") : null;
    db.prepare("UPDATE codex_runtime_attempts SET turn_id=?,state=?,result=? WHERE id=?")
      .run(turn.id, saved.state === "stopping" && turn.status === "inProgress" ? "stopping" : turn.status, result, id);
    return { status: get(id).state, ...(result === null ? {} : { body: result }) };
  };
  const reconcile = async binding => {
    const id = await checked(binding, "read"), saved = get(id);
    if (!saved) return { status: "not_started" };
    if (!saved.thread_id || !saved.turn_id) throw new Error("Runtime start is uncertain; do not start another turn");
    // Exact-bound terminal notifications are durable facts. A later transport
    // loss must not erase them or require another provider request to prove them.
    if (terminal.has(saved.state)) return { status: saved.state,
      ...(saved.state === "completed" ? { body: saved.result } : {}) };
    await ready();
    const value = await rpc.request("thread/read", { threadId: saved.thread_id, includeTurns: true });
    if (value?.thread?.id !== saved.thread_id) throw new Error("Runtime returned a different thread");
    const turn = value.thread.turns?.find(item => item.id === saved.turn_id);
    if (!turn) throw new Error("Original runtime turn is unavailable; reconcile manually");
    return recordTurn(id, turn);
  };
  const stopOwned = async id => {
    const saved = get(id);
    if (!saved?.turn_id) throw new Error("Runtime turn is unknown");
    if (terminal.has(saved.state)) return { status: saved.state };
    patch(id, "stopping");
    await ready();
    await rpc.request("turn/interrupt", { threadId: saved.thread_id, turnId: saved.turn_id });
    // An RPC acknowledgement is not proof of terminal execution.
    return { status: get(id).state };
  };
  const interrupt = async binding => stopOwned(await checked(binding, "interrupt"));
  const steer = async (binding, inputId, text) => {
    const id = await checked(binding, "steer"), saved = get(id);
    if (!saved?.turn_id || saved.state !== "inProgress") throw new Error("Runtime turn is not accepting input");
    if (typeof inputId !== "string" || !inputId || typeof text !== "string" || !text.trim() || text.length > 65536)
      throw new Error("Contribution needs an identity and bounded text");
    const prior = db.prepare("SELECT * FROM codex_runtime_inputs WHERE attempt_id=? AND input_id=?").get(id, inputId);
    if (prior) {
      if (prior.text !== text) throw new Error("Contribution identity was reused with different text");
      return { status: prior.state };
    }
    db.prepare("INSERT INTO codex_runtime_inputs VALUES(?,?,?,'uncertain')").run(id, inputId, text);
    await ready();
    const result = await rpc.request("turn/steer", { threadId: saved.thread_id, expectedTurnId: saved.turn_id,
      clientUserMessageId: inputId, input: textInput(text) });
    if (result?.turnId !== saved.turn_id) throw new Error("Steering acknowledgement targets a different turn");
    db.prepare("UPDATE codex_runtime_inputs SET state='received' WHERE attempt_id=? AND input_id=?").run(id, inputId);
    return { status: "received" }; // Never infer that the model applied it.
  };
  const execute = async (input, { binding, previousBinding } = {}) => {
    const id = await checked(binding, "start");
    if (get(id)) throw new Error("Runtime attempt already exists; reconcile instead of rerunning");
    let previous;
    if (previousBinding) {
      if (binding.kind !== "shared-assistant" || previousBinding.kind !== binding.kind || !binding.continuationId
        || ["origin", "roomId", "memberId", "runId", "attemptId", "roomCreatedAt", "runCreatedAt"].some(key => binding[key] !== previousBinding[key]))
        throw new Error("Continuation must retain the exact Room execution binding");
      previous = get(await checked(previousBinding, "read"));
      if (!["completed", "interrupted"].includes(previous?.state) || !previous.thread_id || !previous.turn_id
        || previous.state === "interrupted" && input.continuation?.previousTurnStatus !== "interrupted")
        throw new Error("Only a known completed or explicitly interrupted turn can continue");
    } else if (binding.continuationId) throw new Error("Continuation needs its original completed turn");
    const cleanInput = Object.fromEntries(Object.entries(input).filter(([key]) => key !== "signal"));
    if (binding.kind === "shared-assistant" && (input.run?.id !== binding.runId || !Array.isArray(input.inputs)))
      throw new Error("Shared runtime input does not match its run");
    const envelope = binding.kind === "shared-assistant"
      ? { version: 1, kind: "project-room-shared-assistant", context: { trust: "untrusted-room-data", ...structuredClone(cleanInput) } }
      : createHostEnvelope(cleanInput);
    await ready(); input.signal?.throwIfAborted();
    db.prepare("INSERT INTO codex_runtime_attempts(id,binding,state) VALUES(?,?,'starting')").run(id, JSON.stringify(binding));
    const started = previous
      ? await rpc.request("thread/resume", { threadId: previous.thread_id, cwd, ...selectedPolicy })
      : await rpc.request("thread/start", { cwd, ...selectedPolicy });
    if (previous && started?.thread?.id !== previous.thread_id) throw new Error("Continuation returned a different thread");
    if (typeof started?.thread?.id !== "string" || !started.thread.id) throw new Error("Runtime thread start is unconfirmed");
    db.prepare("UPDATE codex_runtime_attempts SET thread_id=? WHERE id=?").run(started.thread.id, id);
    input.signal?.throwIfAborted();
    let finish, fail;
    const completed = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    // The response and notifications may race; only accept exact thread+turn.
    const early = [];
    const receive = event => {
      const saved = get(id), params = event.params;
      if (params?.threadId !== saved.thread_id) return;
      if (!saved.turn_id) { if (early.length < 1000) early.push(event); return; }
      const turnId = params.turnId ?? params.turn?.id;
      if (turnId !== saved.turn_id) return;
      try {
        if (event.method === "turn/completed") {
          const result = recordTurn(id, params.turn);
          if (result.status === "completed") finish({ body: result.body });
          else fail(new Error(`Runtime turn ${result.status}`));
        } else if (event.method === "item/started" && params.item?.type === "agentMessage") saveItem(id, { ...params.item, text: params.item.text ?? "" });
        else if (event.method === "item/completed") saveItem(id, params.item);
        else if (event.method === "item/agentMessage/delta") {
          const phase = params.phase ?? db.prepare("SELECT phase FROM codex_runtime_outputs WHERE attempt_id=? AND item_id=?").get(id, params.itemId)?.phase ?? null;
          if (phase === null || phase === "final_answer") emit({ type: "answer_delta", requestId: binding.requestId ?? binding.runId,
            attemptId: binding.attemptId, itemId: params.itemId, delta: params.delta, phase });
        }
      } catch (error) { fail(error); }
    };
    const unsubscribe = rpc.subscribe(receive);
    const timer = setTimeout(() => fail(new Error("Runtime outcome uncertain; reconcile original turn")), timeoutMs);
    const abort = () => { stopOwned(id).catch(() => {}); fail(new Error("Runtime cancellation requested; reconcile settlement")); };
    input.signal?.addEventListener("abort", abort, { once: true });
    // Attach rejection handler before awaiting turn/start (notifications may race).
    completed.catch(() => {});
    try {
      await checked(binding, "start");
      input.signal?.throwIfAborted();
      const value = await rpc.request("turn/start", { threadId: started.thread.id, input: textInput(JSON.stringify(envelope)) });
      recordTurn(id, value?.turn);
      for (const event of early) receive(event);
      if (terminal.has(value.turn.status)) receive({ method: "turn/completed", params: { threadId: started.thread.id, turn: value.turn } });
      if (input.signal?.aborted) abort();
      return await completed;
    } finally { clearTimeout(timer); unsubscribe(); input.signal?.removeEventListener("abort", abort); }
  };
  return Object.assign(execute, { steer, interrupt, reconcile });
}

// Connected entry point for runRequestOnce/runRequestQueue. Rechecks the Room
// reservation before steering; no credentials enter the runtime's prompt.
export function roomCodexHost({ connection, ...options }) {
  const client = new RoomAgentClient(connection);
  return createCodexRuntimeHost({ ...options, scope: connection, authorize: async (binding, action) => {
    const context = await client.replyContext(binding.requestMessageId);
    if (context.viewerId !== binding.memberId || context.request.recipientId !== binding.memberId
      || context.roomCreatedEventId !== binding.roomCreatedEventId || context.request.openingEventId !== binding.openingEventId)
      throw new Error("Room request identity changed");
    if (action === "start" || action === "steer") await client.requestRuns({ requestMessageId: binding.requestMessageId, attemptId: binding.attemptId,
      action: "working", expectedRequestRevision: binding.expectedRequestRevision, contextEventId: binding.contextEventId });
  } });
}
