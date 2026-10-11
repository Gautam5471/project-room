import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { summarizeCodexEvidence, LIMITS } from "../scripts/codex-evidence-summary.mjs";

const usage = { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 };
const start = { type: "turn.started" };
const done = { type: "turn.completed", usage };
const evidence = (events, overrides = {}) => JSON.stringify({ host: "codex", code: 0, signal: null,
  timedOut: false, outputLimited: false, stdout: events.map(e => typeof e === "string" ? e : JSON.stringify(e)).join("\n"), ...overrides });
const summarize = (events, overrides) => summarizeCodexEvidence(evidence(events, overrides));
const tool = (status = "in_progress") => ({ id: "private-id", type: "mcp_tool_call", server: "private-server", tool: "private-tool", arguments: { secret: "private-argument" }, status });

test("completed exec evidence separates process, turn and unproven Room verification", () => {
  const result = summarize([start, done]);
  assert.equal(result.process.disposition, "exited_zero");
  assert.equal(result.turn.disposition, "completed");
  assert.deepEqual(result.verification, { roomAcceptance: "not_established", tests: "not_established", independentReview: "not_established", deployment: "not_established" });
});

test("failure evidence and absent terminal cannot be laundered by exit zero", () => {
  for (const terminal of [{ type: "turn.failed", error: { message: "secret" } }, { type: "error", message: "secret" }]) {
    assert.equal(summarize([start, terminal, done]).turn.disposition, "failed");
  }
  assert.equal(summarize([start]).turn.disposition, "incomplete");
  assert.equal(summarize([]).turn.disposition, "incomplete");
});

test("process boundaries remain independent of observed completion", () => {
  for (const [override, disposition] of [
    [{ timedOut: true }, "timed_out"], [{ outputLimited: true }, "output_limited"],
    [{ code: 4 }, "exited_nonzero"], [{ code: null, signal: "PRIVATE_SIGNAL" }, "signaled"],
    [{ code: null, hostUnresolved: "PRIVATE_PATH" }, "host_unresolved"], [{ code: null }, "unknown"],
  ]) {
    const result = summarize([start, done], override);
    assert.equal(result.process.disposition, disposition);
    assert.equal(result.turn.disposition, "completed");
    assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  }
});

test("lifecycle counts deduplicate snapshots while preserving recovered tool failures", () => {
  const result = summarize([start,
    { type: "item.started", item: tool() },
    { type: "item.updated", item: tool() }, { type: "item.updated", item: tool() },
    { type: "item.completed", item: tool("failed") }, { type: "item.completed", item: tool("failed") }, done]);
  assert.equal(result.turn.disposition, "completed");
  assert.equal(result.items.unique, 1);
  assert.equal(result.items.tools, 1);
  assert.equal(result.items.failed, 1);
  assert.equal(result.items.terminal, 1);
  assert.equal(result.items.duplicateTerminals, 1);
  assert.equal(result.events.itemUpdated, 2);
});

test("conflicting terminals and reopened items are conservatively flagged", () => {
  const result = summarize([start, { type: "item.completed", item: tool("failed") },
    { type: "item.completed", item: tool("completed") }, { type: "item.updated", item: tool() }, done, done]);
  assert.equal(result.items.failed, 1);
  assert.equal(result.turn.disposition, "incomplete");
  assert.ok(result.warnings.includes("item_terminal_conflict"));
  assert.ok(result.warnings.includes("item_after_terminal"));
  assert.ok(result.warnings.includes("turn_terminal_without_start"));
});

test("malformed known records invalidate completion; optional extensions only warn", () => {
  for (const bad of ["not-json-private", {}, { type: "turn.completed" },
    { type: "turn.failed", error: {} }, { type: "item.completed", item: tool("bogus") },
    { type: "item.completed", item: { id: "x", type: "agent_message", text: 8 } }]) {
    assert.equal(summarize([start, bad, done]).turn.disposition, "incomplete");
  }
  const result = summarize([start, { type: "future.optional", secret: "private" },
    { type: "item.completed", item: { id: "x", type: "future_item" } }, done]);
  assert.equal(result.turn.disposition, "completed");
  assert.deepEqual(result.warnings, ["unknown_event", "unknown_item"]);
  assert.equal(result.items.unknown, 1);
});

test("explicit non-exec dialect and unsupported hosts fail closed", () => {
  for (const events of [[{ jsonrpc: "2.0", method: "turn/completed", params: {} }], [{ type: "assistant", message: {} }]]) {
    assert.equal(summarize(events).input.accepted, false);
  }
  assert.equal(summarize([], { host: "claude" }).input.accepted, false);
  assert.equal(summarizeCodexEvidence("[]").input.accepted, false);
});

test("CRLF and final line without newline are recognized without input mutation", () => {
  const text = evidence([], { stdout: `${JSON.stringify(start)}\r\n${JSON.stringify(done)}` });
  assert.equal(summarizeCodexEvidence(text).turn.disposition, "completed");
  assert.equal(JSON.parse(text).stdout.endsWith("}"), true);
});

test("resource limits report bounded closed reasons", () => {
  assert.deepEqual(summarizeCodexEvidence(" ".repeat(LIMITS.fileBytes + 1)).warnings, ["file_limit"]);
  assert.ok(summarize(["x".repeat(LIMITS.lineBytes + 1)]).warnings.includes("line_limit"));
  const result = summarize(Array(LIMITS.events + 1).fill({ type: "future" }));
  assert.ok(result.warnings.includes("event_limit"));
  assert.equal(result.events.total, LIMITS.events);
  assert.equal(result.turn.disposition, "incomplete");
});

test("CLI is offline, redacted, read-only, and distinguishes invalid input from negative evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-summary-"));
  const path = join(dir, "private-path.json");
  const script = new URL("../scripts/codex-evidence-summary.mjs", import.meta.url);
  const run = (...args) => spawnSync(process.execPath, [script.pathname, ...args], { encoding: "utf8" });
  try {
    const bytes = evidence([start, { type: "item.completed", item: { ...tool("completed"), result: { content: [{ text: "private-result" }] } } }, done],
      { prompt: "private-prompt", stderr: "private-stderr" });
    writeFileSync(path, bytes);
    const ok = run(path);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(readFileSync(path, "utf8"), bytes);
    assert.ok(!`${ok.stdout}${ok.stderr}`.includes("private-"));
    writeFileSync(path, evidence([start]));
    assert.equal(run(path).status, 1);
    writeFileSync(path, "private-malformed-json");
    for (const result of [run(path), run(join(dir, "private-missing")), run(), run(path, "private-extra"), run(dir)]) {
      assert.equal(result.status, 2);
      assert.ok(!`${result.stdout}${result.stderr}`.includes("private-"));
      assert.doesNotThrow(() => JSON.parse(result.stdout));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Rust-side variants and nonfatal error items stay visible without failing a recovered turn", () => {
  const items = [
    { id: "command", type: "command_execution", command: "secret", aggregated_output: "secret", exit_code: null, status: "declined" },
    { id: "patch", type: "file_change", changes: [{ path: "secret", kind: "update" }], status: "failed" },
    { id: "collab", type: "collab_tool_call", tool: "wait", sender_thread_id: "secret", receiver_thread_ids: ["secret"], agents_states: {}, status: "completed" },
    { id: "error", type: "error", message: "secret" },
    { id: "plan", type: "todo_list", items: [{ text: "secret", completed: true }] },
    { id: "web", type: "web_search", query: "secret" },
    { id: "reason", type: "reasoning", text: "secret" },
    { id: "mcp", type: "mcp_tool_call", server: "secret", tool: "secret", status: "completed" },
  ];
  const result = summarize([start, ...items.map(item => ({ type: "item.completed", item })), done]);
  assert.equal(result.turn.disposition, "completed");
  assert.equal(result.items.tools, 5);
  assert.equal(result.items.failed, 1);
  assert.equal(result.items.declined, 1);
  assert.equal(result.items.errors, 1);
  assert.ok(!JSON.stringify(result).includes("secret"));
});

test("missing or inconsistent lifecycle evidence never yields a clean completed turn", () => {
  for (const events of [
    [done], [start, done, start], [start, start, done],
    [{ type: "item.completed", item: tool("completed") }, start, done],
    [start, { type: "item.started", item: tool() }, done, start, { type: "item.completed", item: tool("completed") }, done],
    [start, done, { type: "item.completed", item: tool("completed") }],
    [{ type: "thread.started", thread_id: "one" }, start, { type: "thread.started", thread_id: "two" }, done],
    [start, { type: "item.started", item: tool() }, done],
    [start, { type: "item.completed", item: tool() }, done],
    [start, { type: "item.started", item: tool() }, { type: "item.completed", item: { id: "private-id", type: "agent_message", text: "secret" } }, done],
  ]) assert.equal(summarize(events).turn.disposition, "incomplete");
  assert.equal(summarize([start, done, start, done]).turn.completed, 2);
});

test("envelope types, UTF-8 and on-disk size limits fail safely at the CLI boundary", () => {
  for (const override of [{ code: "0" }, { signal: {} }, { timedOut: "false" }, { outputLimited: null }, { stdout: [] }, { hostUnresolved: {} }]) {
    assert.equal(summarize([], override).input.accepted, false);
  }
  const dir = mkdtempSync(join(tmpdir(), "codex-summary-bounds-"));
  const path = join(dir, "secret.json");
  try {
    for (const [bytes, reason] of [[Buffer.from([0xff]), "invalid_utf8"], [Buffer.alloc(LIMITS.fileBytes + 1), "file_limit"]]) {
      writeFileSync(path, bytes);
      const result = spawnSync(process.execPath, [new URL("../scripts/codex-evidence-summary.mjs", import.meta.url).pathname, path], { encoding: "utf8" });
      assert.equal(result.status, 2);
      assert.deepEqual(JSON.parse(result.stdout).warnings, [reason]);
      assert.equal(readFileSync(path).length, bytes.length);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
