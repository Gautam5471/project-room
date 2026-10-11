// tests/shed-loop-attention.test.js — the shed loop actually polls attention.
//
// Authoring gate answers:
// 1. Protects: the loop's poll path end to end — with a real room server and a
//    saved agent connection, the first tick must succeed (heartbeat "ok" with
//    an item count), not fail closed on every tick.
// 2. Credible regression: the 2026-10-04 bug this guards — the loop passed
//    `directory: config.directory` to currentAttention, but the connection
//    config carries no directory field, so every tick threw
//    "private_state_required" and the shed journaled nothing while reporting
//    "degraded". This test fails on that code (heartbeat stays "degraded")
//    and passes with the loop's own state dir.
// 3. Existing coverage: shed-loop.test.js only covers fail-closed startup.
//    Nothing exercises a successful tick.
// 4. Production seams: none. Real loop process, real room server, real client
//    modules; the only fixture is the repo's own acceptance fixture.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const loop = join(root, "shed", "shed-loop.mjs");

test("shed loop polls attention against a real room (regression: watch directory)", { timeout: 60000 }, async t => {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;

  const dir = mkdtempSync(join(tmpdir(), "shed-loop-attn-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configDirectory = join(dir, "config");
  const stateDir = join(dir, "state");
  saveAgentConnection(configDirectory, { version: 1, origin, roomId: "commons", memberId: "producer", token: f.keys.producer });

  const child = spawn(process.execPath, [loop], {
    env: { ...process.env, ROOM_AGENT_CONFIG: configDirectory, SHED_STATE_DIR: stateDir, SHED_POLL_SECS: "15" },
    stdio: "ignore",
  });
  t.after(() => child.kill("SIGKILL"));

  // Wait for a post-tick heartbeat: the startup write has detail.note, the
  // tick write has detail.items. A broken poll path writes "degraded" here.
  const heartbeatPath = join(stateDir, "heartbeat.json");
  const start = Date.now();
  let heartbeat = null;
  while (Date.now() - start < 45000) {
    if (existsSync(heartbeatPath)) {
      // The loop rewrites this file in place, so a read can land mid-write: retry on a partial file.
      let parsed = null;
      try { parsed = JSON.parse(readFileSync(heartbeatPath, "utf8")); } catch { /* partial write, poll again */ }
      if (parsed?.detail && (typeof parsed.detail.items === "number" || parsed.status !== "ok")) { heartbeat = parsed; break; }
    }
    await new Promise(r => setTimeout(r, 250));
  }
  assert.ok(heartbeat, "loop wrote a post-tick heartbeat within 45s");
  assert.equal(heartbeat.status, "ok", `first tick succeeded (got ${heartbeat.status}: ${JSON.stringify(heartbeat.detail)})`);
  assert.equal(typeof heartbeat.detail.items, "number", "heartbeat reports the polled item count");
});
