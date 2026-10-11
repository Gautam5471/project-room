#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { agentConnectionFromEnvironment } from "../client/agent-connection.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { openRequestJournal } from "../client/request-runner.mjs";
import { openCodexStdio, validateCodexRuntimeConfig, checkCodexProtocol } from "../client/codex-stdio.mjs";
import { runCodexSharedAssistant } from "../client/codex-shared-assistant.mjs";

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] === "--help") {
    console.log(`Usage:
  ROOM_AGENT_CONFIG="/path/room.json" node scripts/run-codex-room.mjs --list
  node scripts/run-codex-room.mjs --check /absolute/runtime.json
  ROOM_AGENT_CONFIG="/path/room.json" node scripts/run-codex-room.mjs RUN_ID /absolute/journal.sqlite /absolute/runtime.json

Runtime JSON requires command (absolute Codex executable), cwd (real workspace), codexHome (dedicated private directory outside workspace and operator Codex home), policy {approvalPolicy:"never",sandbox:"read-only"|"workspace-write"}; optional model, requestTimeoutMs, turnTimeoutMs.
Authenticate the dedicated Codex home explicitly using Codex login with CODEX_HOME set to that directory and cli_auth_credentials_store="file". No operator credentials or sessions are imported.
--check starts the isolated-home App Server protocol only; it performs no model turn and does not prove provider authentication.
Normal invocation executes one already-created public Room assistant run assigned to this member. Keep the private journal and Codex home for exact retries and reconciliation. Interactive approvals/questions are denied with an attention notice. No unsandboxed fallback is used.`);
    return;
  }
  if (argv.length === 1 && argv[0] === "--list") {
    const connection = agentConnectionFromEnvironment();
    const { runs } = await new RoomAgentClient(connection).assistant();
    console.log(JSON.stringify(runs.filter(run => run.coordinatorMemberId === connection.memberId).map(run => ({ runId: run.id, status: run.status, sourceMessageId: run.sourceMessageId }))));
    return;
  }
  const check = argv[0] === "--check";
  const [runId, journal, configPath] = check ? [null, null, argv[1]] : argv;
  if (argv.length !== (check ? 2 : 3) || !isAbsolute(configPath ?? "") || !check && (!runId || !isAbsolute(journal ?? "")))
    throw new Error("Invalid arguments; use --help");
  const settings = validateCodexRuntimeConfig(JSON.parse(readFileSync(configPath, "utf8")));
  const connection = check ? null : agentConnectionFromEnvironment();
  const db = check ? null : openRequestJournal(journal);
  const threads = db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_runtime_attempts'").get()
    ? db.prepare("SELECT binding,thread_id FROM codex_runtime_attempts WHERE thread_id IS NOT NULL").all().filter(row => {
      const binding = JSON.parse(row.binding);
      return ["origin", "roomId", "memberId"].every(key => binding[key] === connection[key]);
    }).map(row => row.thread_id) : [];
  let rpc;
  const controller = new AbortController(), stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    rpc = openCodexStdio(settings, { allowedThreadIds: threads, onAttention: event => {
      console.error(JSON.stringify({ ...event, message: "Interactive request denied: this host has no connected approval/input UI." }));
    } });
    const qualified = await checkCodexProtocol(rpc, settings, { threadId: threads[0] });
    if (check) {
      console.log(JSON.stringify(qualified));
    } else {
      const result = await runCodexSharedAssistant({ connection, db, rpc, cwd: settings.cwd, policy: settings.policy,
        runId, signal: controller.signal, timeoutMs: settings.turnTimeoutMs,
        emit: event => console.log(JSON.stringify(event)) });
      console.log(JSON.stringify({ status: result.result.status, runId, resultMessageId: result.result.resultMessageId ?? null }));
    }
  } finally { await rpc?.close(); db?.close(); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main().catch(error => {
  console.error(error.message); process.exitCode = 1;
});
