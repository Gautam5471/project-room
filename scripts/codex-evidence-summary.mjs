#!/usr/bin/env node
// Offline, allowlisted evidence projection. Never print values from the input.
import { openSync, closeSync, fstatSync, readSync, constants } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LIMITS = Object.freeze({ fileBytes: 16 * 1024 * 1024, lineBytes: 256 * 1024, events: 20000 });
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const string = value => typeof value === "string";
const integer = value => Number.isSafeInteger(value);
const message = value => object(value) && string(value.message);
const toolTypes = new Set(["mcp_tool_call", "command_execution", "file_change", "web_search", "collab_tool_call"]);
const itemTypes = new Set([...toolTypes, "agent_message", "reasoning", "todo_list", "error"]);
const statusTypes = new Set(["mcp_tool_call", "command_execution", "file_change", "collab_tool_call"]);

function blank() {
  return {
    version: 1, input: { accepted: false, complete: false },
    process: { disposition: "unknown", timedOut: false, outputLimited: false },
    turn: { disposition: "incomplete", started: 0, completed: 0, failed: 0, streamErrors: 0 },
    events: { total: 0, unknown: 0, malformed: 0, itemStarted: 0, itemUpdated: 0, itemCompleted: 0 },
    items: { unique: 0, tools: 0, terminal: 0, pending: 0, failed: 0, declined: 0, errors: 0, unknown: 0, duplicateTerminals: 0 },
    verification: { roomAcceptance: "not_established", tests: "not_established", independentReview: "not_established", deployment: "not_established" },
    warnings: [],
  };
}
function invalid(reason) {
  const result = blank();
  result.warnings.push(reason);
  return result;
}

// Validate fields that define the pinned item contract; opaque tool payloads
// remain opaque, are never executed, and are never copied to the summary.
function validItem(item) {
  if (!object(item) || !string(item.id) || !item.id || !string(item.type)) return false;
  if (!itemTypes.has(item.type)) return true;
  if (statusTypes.has(item.type) && !["in_progress", "completed", "failed", ...(item.type === "command_execution" ? ["declined"] : [])].includes(item.status)) return false;
  switch (item.type) {
    case "agent_message": case "reasoning": return string(item.text);
    case "error": return string(item.message);
    case "web_search": return string(item.query);
    case "command_execution": return string(item.command) && string(item.aggregated_output)
      && (item.exit_code == null || integer(item.exit_code));
    case "file_change": return Array.isArray(item.changes) && item.changes.every(change => object(change)
      && string(change.path) && ["add", "delete", "update"].includes(change.kind));
    case "todo_list": return Array.isArray(item.items) && item.items.every(entry => object(entry)
      && string(entry.text) && typeof entry.completed === "boolean");
    case "mcp_tool_call": return string(item.server) && string(item.tool)
      && (item.error == null || message(item.error))
      && (item.result == null || (object(item.result) && Array.isArray(item.result.content)));
    case "collab_tool_call": return ["spawn_agent", "send_input", "wait", "close_agent"].includes(item.tool)
      && string(item.sender_thread_id) && Array.isArray(item.receiver_thread_ids) && item.receiver_thread_ids.every(string)
      && (item.prompt == null || string(item.prompt)) && object(item.agents_states)
      && Object.values(item.agents_states).every(state => object(state)
        && ["pending_init", "running", "interrupted", "completed", "errored", "shutdown", "not_found"].includes(state.status)
        && (state.message == null || string(state.message)));
    default: return false;
  }
}
function validUsage(usage) {
  return object(usage) && ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"].every(key => integer(usage[key]) && usage[key] >= 0)
    && (usage.cache_write_input_tokens === undefined || (integer(usage.cache_write_input_tokens) && usage.cache_write_input_tokens >= 0));
}

/** Pure projection of a native-host-request-run.mjs JSON string. No I/O. */
export function summarizeCodexEvidence(text) {
  if (!string(text)) return invalid("invalid_input");
  if (Buffer.byteLength(text, "utf8") > LIMITS.fileBytes) return invalid("file_limit");
  let evidence;
  try { evidence = JSON.parse(text); } catch { return invalid("invalid_json"); }
  if (!object(evidence) || evidence.host !== "codex") return invalid("unsupported_envelope");
  if (!(evidence.code === null || integer(evidence.code)) || !(evidence.signal === null || string(evidence.signal))
    || typeof evidence.timedOut !== "boolean" || typeof evidence.outputLimited !== "boolean"
    || (evidence.hostUnresolved !== undefined && !string(evidence.hostUnresolved))
    || (evidence.stdout !== undefined && !string(evidence.stdout))
    || (evidence.stdout === undefined && !evidence.hostUnresolved)) return invalid("malformed_envelope");
  const result = blank();
  result.input.accepted = true;
  const warn = code => { if (!result.warnings.includes(code)) result.warnings.push(code); };
  let damaged = false;
  const damage = code => { damaged = true; warn(code); };
  result.process.timedOut = evidence.timedOut;
  result.process.outputLimited = evidence.outputLimited;
  result.process.disposition = evidence.hostUnresolved ? "host_unresolved" : evidence.timedOut ? "timed_out"
    : evidence.outputLimited ? "output_limited" : evidence.signal ? "signaled"
      : evidence.code === 0 ? "exited_zero" : evidence.code !== null ? "exited_nonzero" : "unknown";
  const items = new Map();
  let openTurn = false, threadId;
  const malformed = () => { result.events.malformed++; damage("malformed_record"); };
  const stdout = evidence.stdout ?? "";
  let offset = 0;
  while (offset < stdout.length) {
    let end = stdout.indexOf("\n", offset);
    if (end === -1) end = stdout.length;
    const line = stdout.slice(offset, end);
    offset = end + 1;
    if (Buffer.byteLength(line, "utf8") > LIMITS.lineBytes) { damage("line_limit"); break; }
    if (!line.trim()) continue;
    if (result.events.total === LIMITS.events) { damage("event_limit"); break; }
    result.events.total++;
    let event;
    try { event = JSON.parse(line); } catch { malformed(); continue; }
    if (object(event) && (Object.hasOwn(event, "jsonrpc") || Object.hasOwn(event, "method")
      || ["assistant", "user", "system", "result"].includes(event.type))) {
      result.input.accepted = false; damage("unsupported_dialect"); continue;
    }
    if (!object(event) || !string(event.type)) { malformed(); continue; }
    switch (event.type) {
      case "thread.started":
        if (!string(event.thread_id) || !event.thread_id) malformed();
        else if (threadId !== undefined && threadId !== event.thread_id) damage("thread_identity_conflict");
        else threadId = event.thread_id;
        break;
      case "turn.started":
        if (openTurn) damage("turn_started_while_open");
        openTurn = true; result.turn.started++;
        break;
      case "turn.completed": case "turn.failed": {
        if (event.type === "turn.completed" ? !validUsage(event.usage) : !message(event.error)) { malformed(); break; }
        if (!openTurn) damage("turn_terminal_without_start");
        if ([...items.values()].some(item => !item.terminal)) damage("pending_items_at_turn_terminal");
        openTurn = false;
        if (event.type === "turn.completed") result.turn.completed++;
        else result.turn.failed++;
        break;
      }
      case "error":
        if (!string(event.message)) { malformed(); break; }
        result.turn.streamErrors++;
        break;
      case "item.started": case "item.updated": case "item.completed": {
        if (!validItem(event.item)) { malformed(); break; }
        if (!openTurn) damage("item_outside_turn");
        const item = event.item;
        const terminal = event.type === "item.completed";
        const key = event.type === "item.started" ? "itemStarted" : event.type === "item.updated" ? "itemUpdated" : "itemCompleted";
        result.events[key]++;
        if (!itemTypes.has(item.type)) warn("unknown_item");
        if (terminal && statusTypes.has(item.type) && item.status === "in_progress") { malformed(); break; }
        let seen = items.get(item.id);
        if (!seen) {
          seen = { type: item.type, terminal: false, status: null, failed: false, declined: false };
          items.set(item.id, seen);
        } else if (seen.type !== item.type) { damage("item_type_conflict"); break; }
        if (seen.terminal) {
          if (!terminal) damage("item_after_terminal");
          else if (seen.status !== (item.status ?? null)) damage("item_terminal_conflict");
          else result.items.duplicateTerminals++;
        }
        seen.failed ||= item.status === "failed";
        seen.declined ||= item.status === "declined";
        if (terminal) { seen.terminal = true; seen.status = item.status ?? null; }
        break;
      }
      default: result.events.unknown++; warn("unknown_event");
    }
  }
  for (const item of items.values()) {
    result.items.unique++;
    if (toolTypes.has(item.type)) result.items.tools++;
    if (item.terminal) result.items.terminal++; else result.items.pending++;
    if (item.failed) result.items.failed++;
    if (item.declined) result.items.declined++;
    if (item.type === "error") result.items.errors++;
    if (!itemTypes.has(item.type)) result.items.unknown++;
  }
  if (result.items.pending) damage("pending_items");
  result.input.complete = !damaged;
  if (result.turn.failed || result.turn.streamErrors) result.turn.disposition = "failed";
  else if (!damaged && !openTurn && result.turn.completed > 0) result.turn.disposition = "completed";
  if (!result.turn.completed && !result.turn.failed && !result.turn.streamErrors) warn("no_terminal_turn");
  return result;
}

function readEvidence(path) {
  let fd;
  try {
    // Nonblocking open prevents accidental FIFO hangs; accept regular files only.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return invalid("not_regular_file");
    if (stat.size > LIMITS.fileBytes) return invalid("file_limit");
    const bytes = Buffer.alloc(LIMITS.fileBytes + 1);
    let length = 0, count;
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
    if (length > LIMITS.fileBytes) return invalid("file_limit");
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)); }
    catch { return invalid("invalid_utf8"); }
    return summarizeCodexEvidence(text);
  } catch { return invalid("read_failed"); }
  finally { if (fd !== undefined) closeSync(fd); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const result = args.length === 1 && args[0] !== "-" ? readEvidence(args[0]) : invalid("usage_one_evidence_file");
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exitCode = !result.input.accepted ? 2
    : result.process.disposition === "exited_zero" && result.turn.disposition === "completed" ? 0 : 1;
}
