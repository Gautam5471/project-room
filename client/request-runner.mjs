import { hostReplyBody } from "./host-result.mjs";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, openSync, closeSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { RoomAgentClient } from "./room-agent.mjs";

// The caller selects a private local file and one configured host. This is not
// a watcher or permission to run arbitrary room messages. SQLite serializes
// concurrent intent claims; a crash after claiming never silently reruns a host.
export function openRequestJournal(filename) {
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  closeSync(openSync(filename, "a", 0o600)); chmodSync(filename, 0o600);
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS request_runs (id TEXT PRIMARY KEY, response TEXT, delivered INTEGER NOT NULL DEFAULT 0)");
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!db.prepare("PRAGMA table_info(request_runs)").all().some(column => column.name === "attempt_id"))
      db.exec("ALTER TABLE request_runs ADD COLUMN attempt_id TEXT");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); db.close(); throw error; }
  return db;
}

// execute receives no connection secret: only the selected conversation and
// preparation. It returns { body, codeResult? }, not commands. Room validates the exact
// original answer basis on delivery; no automatic rebase after clarification.
export async function runRequestOnce({ connection, requestMessageId, db, execute, signal }) {
  if (typeof execute !== "function" || !connection.memberId) throw new Error("A configured host and pinned member are required");
  const client = new RoomAgentClient(connection);
  let context = await client.replyContext(requestMessageId, { limit: 50, signal });
  if (context.viewerId !== connection.memberId || context.request.recipientId !== connection.memberId)
    throw new Error("Request must be addressed to the configured member");
  const id = "host-" + createHash("sha256").update(JSON.stringify([
    connection.origin, connection.roomId, connection.memberId, requestMessageId,
    context.roomCreatedEventId, context.request.openingEventId
  ])).digest("hex");
  const report = (attemptId, action, basis = {}, reportSignal = signal) => client.requestRuns({ requestMessageId, attemptId, action,
    ...basis }, { signal: reportSignal });
  const deliver = async record => {
    const input = JSON.parse(record.response);
    let receipt;
    try { receipt = await client.replyAction("room_respond_to_request", input, { signal }); }
    catch (error) {
      if (record.attempt_id && [409, 422].includes(error?.status))
        await report(record.attempt_id, "needs_attention", {}, AbortSignal.timeout(5000)).catch(() => {});
      throw error;
    }
    if (receipt.status !== "recorded") throw new Error("Reply delivery is unconfirmed; retain the journal and retry unchanged");
    db.prepare("UPDATE request_runs SET delivered=1 WHERE id=?").run(id);
    if (record.attempt_id) await report(record.attempt_id, "delivered").catch(() => {});
    return { status: "delivered", requestId: id, receipt, hostExecuted: false };
  };
  const prior = db.prepare("SELECT * FROM request_runs WHERE id=?").get(id);
  if (prior) {
    if (!prior.response) throw new Error("Host outcome is unknown; reconcile the original attempt before proceeding");
    // Even an already delivered response is reconciled through the service's
    // idempotent command path, never a stale local assertion of current access.
    return deliver(prior);
  }
  const messages = [...context.page.items];
  let pages = 1;
  while (context.page.hasMore) {
    if (++pages > 10) throw new Error("Request exceeds the automatic preparation limit; inspect it directly");
    context = await client.replyContext(requestMessageId, { cursor: context.page.nextCursor, limit: 50, signal });
    if (context.viewerId !== connection.memberId || context.request.recipientId !== connection.memberId)
      throw new Error("Request identity changed while preparing");
    messages.push(...context.page.items);
  }
  if (!context.current.answerBasis || !context.preparation) throw new Error("Request is not ready or service lacks prepared context");
  if (Buffer.byteLength(JSON.stringify({ messages, preparation: context.preparation })) > 262144)
    throw new Error("Request exceeds the automatic preparation limit; inspect it directly");
  signal?.throwIfAborted();
  const attemptId = randomUUID();
  const claimed = db.prepare("INSERT OR IGNORE INTO request_runs(id,attempt_id) VALUES (?,?)").run(id, attemptId).changes;
  if (!claimed) throw new Error("Another runner owns this attempt; reconcile before proceeding");
  const basis = { expectedRequestRevision: context.current.answerBasis.expectedRequestRevision,
    contextEventId: context.current.answerBasis.contextEventId };
  // Persist intent first. An ambiguous reservation response never starts a host.
  try { await report(attemptId, "claim", basis); }
  catch (error) {
    // A definite refusal happened before invocation. Network uncertainty keeps
    // the intent: even a retry must not infer that a reservation was absent.
    if (error?.status >= 400 && error.status < 500) db.prepare("DELETE FROM request_runs WHERE id=? AND response IS NULL").run(id);
    throw error;
  }
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let heartbeat = null;
  const timer = setInterval(() => {
    if (heartbeat) return;
    heartbeat = report(attemptId, "working", basis, AbortSignal.timeout(10000))
      .catch(error => controller.abort(error)).finally(() => { heartbeat = null; });
  }, 30000);
  try {
    controller.signal.throwIfAborted();
    const result = await execute({ requestId: id, request: structuredClone(context.request), messages,
      preparation: context.preparation, signal: controller.signal }, { binding: Object.freeze({
        origin: connection.origin, roomId: connection.roomId, memberId: connection.memberId,
        requestMessageId, requestId: id, attemptId, roomCreatedEventId: context.roomCreatedEventId,
        openingEventId: context.request.openingEventId, ...basis }) });
    controller.signal.throwIfAborted();
    const body = hostReplyBody(result);
    const response = { requestId: id, responseToRequestId: requestMessageId,
      ...context.current.answerBasis, responseOutcome: "answered", toMemberId: context.request.requesterId,
      workItemId: context.request.workItemId, body };
    db.prepare("UPDATE request_runs SET response=? WHERE id=?").run(JSON.stringify(response), id);
    clearInterval(timer); await heartbeat;
    await report(attemptId, "result_ready");
    const delivered = await deliver({ response: JSON.stringify(response), attempt_id: attemptId });
    return { ...delivered, hostExecuted: true };
  } catch (error) {
    clearInterval(timer); await heartbeat;
    const saved = db.prepare("SELECT response FROM request_runs WHERE id=?").get(id)?.response;
    const state = saved && ![409, 422].includes(error?.status) ? "result_ready" : "needs_attention";
    await report(attemptId, state, {}, AbortSignal.timeout(5000)).catch(() => {});
    throw error;
  } finally {
    clearInterval(timer); signal?.removeEventListener("abort", abort);
  }
}

// Explicit execution mode, separate from the notify-only watcher. Each scan is
// bounded; work is serialized and every invocation re-reads its eligibility.

/**
 * Whether a reply request is eligible to be (re)run. The second disjunct
 * covers retrying a locally-saved response — it must still require the
 * request to be open, or closed/cancelled requests would be re-run (G-L2).
 */
export function isRequestEligible(request, { owned, runState, hasPendingDelivery }) {
  if (request?.status !== "open") return false;
  if (!owned) return true;
  return runState !== "needs_attention" && hasPendingDelivery;
}

export async function runRequestQueue({ connection, db, execute, signal, emit = () => {}, intervalMs = 10000, stream = true }) {
  if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 60000) throw new Error("Invalid polling interval");
  const client = new RoomAgentClient(connection);
  let delay = intervalMs, connectionUnavailable = false;
  while (!signal?.aborted) {
    let cursor = null;
    try {
      const { requests, evaluatedThrough } = await client.replyRequests({ status: "all", signal });
      cursor = evaluatedThrough;
      const { runs } = await client.requestRuns(undefined, { signal });
      const pending = request => db.prepare("SELECT 1 FROM request_runs WHERE delivered=0 AND json_extract(response,'$.responseToRequestId')=?").get(request.id);
      const owned = request => Object.hasOwn(runs, request.id);
      const eligible = requests.filter(request => isRequestEligible(request, {
        owned: owned(request),
        runState: runs[request.id]?.state,
        hasPendingDelivery: Boolean(pending(request)),
      }));
      for (const request of eligible.slice(0, 50)) {
        signal?.throwIfAborted();
        // A saved response may be retried only by its original local journal.
        // Another host's ownership is never a lease that can be stolen.
        if (owned(request) && !pending(request)) continue;
        try { emit(await runRequestOnce({ connection, requestMessageId: request.id, db, execute, signal })); }
        catch (error) {
          emit({ status: "needs_attention", requestMessageId: request.id });
          if ([401, 429].includes(error?.status) || error?.status >= 500
            || ["TypeError", "TimeoutError"].includes(error?.name)) throw error;
        }
      }
      delay = intervalMs;
      connectionUnavailable = false;
    } catch {
      if (!signal?.aborted && !connectionUnavailable) emit({ status: "connection_unavailable" });
      connectionUnavailable = true;
      delay = Math.min(delay * 2, 60000);
    }
    const waitingAt = Date.now(); let changed = false;
    if (stream && Number.isSafeInteger(cursor) && !signal?.aborted) {
      try { ({ changed } = await client.waitForChange(cursor, { signal, timeoutMs: delay })); }
      catch { /* Polling remains the bounded fallback for unavailable streams. */ }
    }
    const remaining = Math.max(0, delay - (Date.now() - waitingAt));
    if (!changed && !signal?.aborted && remaining > 0) await new Promise(resolve => {
      const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, remaining); signal?.addEventListener("abort", done, { once: true });
    });
  }
}
