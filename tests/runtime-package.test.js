import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer, request } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { createRuntimePackage, verifyRuntimePackage, publicAssets, allowed } from "../scripts/runtime-package.mjs";
import { importClosure } from "../scripts/runtime-import-closure.mjs";
import { assetPaths } from "../cloudflare/build-assets.mjs";
import { candidateRuntimeFixture } from "../scripts/candidate-runtime-fixture.mjs";
import { frozenRecoveryFixture } from "../scripts/frozen-runtime-fixture.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));

test("exact-commit runtime package verifies cold, excludes private state and preserves populated committed-schema data", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-package-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
  const destination = join(directory, "runtime");
  let receipt = createRuntimePackage({ repository, commit, destination });
  for (const name of ["LICENSE", "NOTICE", "THIRD_PARTY.md"]) {
    assert.deepEqual(readFileSync(join(destination, name)),
      execFileSync("git", ["show", `${commit}:${name}`], { cwd: repository }),
      `runtime package retains the committed ${name}`);
  }
  const committedSchema = Number(/STORE_SCHEMA_VERSION = (\d+)/.exec(execFileSync("git", ["show", commit + ":server/writer-fence.mjs"], { cwd: repository, encoding: "utf8" }))[1]);
  assert.equal(receipt.schemaVersion, committedSchema); assert.deepEqual(publicAssets, assetPaths);
  // The package must contain exactly the allowlisted files that exist at this commit.
  // The allowlist (scripts/runtime-package.mjs) is the single source of truth;
  // the import-closure test below guarantees it covers every imported module,
  // so no hand-maintained file list or count lives here.
  assert.equal(receipt.files, [...allowed].filter(path => existsSync(join(destination, path))).length);
  assert.equal(existsSync(join(destination, ".git")), false);
  assert.equal(existsSync(join(destination, "node_modules")), false);
  for (const path of ["server.mjs", "src/app.js", "cloudflare/room.mjs"]) {
    assert.deepEqual(readFileSync(join(destination, path)), execFileSync("git", ["show", `${commit}:${path}`], { cwd: repository }));
  }
  assert.throws(() => createRuntimePackage({ repository, commit, destination }));
  assert.throws(() => createRuntimePackage({ repository, commit: "HEAD", destination: join(directory, "alias-refused") }));
  const verifier = join(directory, "verify.mjs");
  cpSync(fileURLToPath(new URL("../scripts/runtime-package.mjs", import.meta.url)), verifier);
  const verified = spawnSync(process.execPath, [verifier, "verify", destination, commit], { cwd: directory, env: { PATH: "/unavailable" }, encoding: "utf8" });
  assert.equal(verified.status, 0, verified.stderr); assert.deepEqual(JSON.parse(verified.stdout), receipt);
  // Cold import from the exact package, with neither checkout dependencies nor a
  // working PATH. This module is absent from genuine historical packages.
  if (existsSync(join(destination, "client/work-actions.mjs"))) {
    const program = `import { roomTools } from ${JSON.stringify(pathToFileURL(join(destination, "client/mcp-stdio.mjs")).href)};
      import { buildWorkCommand } from ${JSON.stringify(pathToFileURL(join(destination, "client/work-actions.mjs")).href)};
      import { RoomAgentClient } from ${JSON.stringify(pathToFileURL(join(destination, "client/room-agent.mjs")).href)};
      console.log(JSON.stringify({ tools: roomTools.length, assistantTools: roomTools.filter(tool => tool.name.startsWith("room_assistant_")).map(tool => tool.name), helper: typeof RoomAgentClient.prototype.workAction,
        command: buildWorkCommand("room_accept_work", { requestId: "cold-package", workItemId: "work", expectedRevision: 0 }) }));`;
    const cold = spawnSync(process.execPath, ["--input-type=module", "-e", program], { cwd: directory, env: { PATH: "/unavailable" }, encoding: "utf8" });
    assert.equal(cold.status, 0, cold.stderr);
    const packagedTools = readFileSync(join(destination, "client/mcp-stdio.mjs"), "utf8");
    const packagedWorkActions = existsSync(join(destination, "client/work-actions.mjs"))
      ? readFileSync(join(destination, "client/work-actions.mjs"), "utf8") : "";
    const toolCount = !existsSync(join(destination, "client/help-actions.mjs")) ? 27
      : packagedTools.includes("\"room_close_work_claim\"") ? 44
      : packagedTools.includes("...assistantTools") ? 43
      : packagedTools.includes('"room_link_work_claim_pr"') ? 41
      : packagedTools.includes('"room_set_member_claim_cap"') ? 40
      : packagedTools.includes('"room_list_outside_agents"') ? 39
      : packagedTools.includes('"room_begin_work"') ? 37
      : packagedWorkActions.includes('"renew_claim"') ? 36
      : packagedTools.includes('"get_room_context"') && packagedTools.includes('"room_read_inbox"') ? 35
      : packagedTools.includes('"room_read_inbox"') ? 34
      : packagedTools.includes('"get_room_context"') ? 33
      : 32;
    assert.deepEqual(JSON.parse(cold.stdout), { tools: toolCount, assistantTools: packagedTools.includes("...assistantTools") ? ["room_assistant_context", "room_assistant_action"] : [], helper: "function",
      command: { id: "cold-package", type: "work.accepted", data: { workItemId: "work", expectedRevision: 0 } } });
  }
  if (existsSync(join(destination, "scripts/run-codex-room.mjs"))) {
    const cold = spawnSync(process.execPath, [join(destination, "scripts/run-codex-room.mjs"), "--help"], {
      cwd: directory, env: { PATH: "/unavailable" }, encoding: "utf8"
    });
    assert.equal(cold.status, 0, cold.stderr);
    assert.match(cold.stdout, /RUN_ID/);
    assert.equal(existsSync(join(destination, "docs/CODEX-ROOM-HOST.md")), true);
    assert.equal(existsSync(join(destination, "scripts/room-assistant-scratch.mjs")), false);
    assert.equal(existsSync(join(destination, "scripts/acceptance-fixture.mjs")), false);
  }
  assert.throws(() => verifyRuntimePackage(destination, { expectedCommit: "0".repeat(40) }));
  const { buildAssets, assetPaths: committedAssets } = await import(pathToFileURL(join(destination, "cloudflare/build-assets.mjs")));
  const { templateAssetPaths: committedTemplates } = await import(pathToFileURL(join(destination, "deploy/public-assets.mjs")));
  // Templates such as join.html are copied for the worker loader and are not raw URLs.
  const packagedAssets = [...committedAssets, ...committedTemplates];
  const assets = join(directory, "assets");
  assert.equal(await buildAssets(pathToFileURL(assets + "/")), packagedAssets.length);
  for (const path of packagedAssets) assert.deepEqual(readFileSync(join(assets, path)), readFileSync(join(destination, path)));
  const committedFixture = await frozenRecoveryFixture(repository, destination, commit);
  // The fail-loud boot gate (server/boot-config.mjs) refuses a production boot
  // with an unsigned card. This synthetic package is built from an unsigned dev
  // tree, so fixture-sign the packaged card for the packaged revision (the
  // candidate's version.mjs is unstamped, so packaged deployedInfo().revision
  // is "dev") and update the manifest hash. A real production build goes
  // through scripts/sign-agent-card.mjs, which fails closed without the key.
  {
    const signedPath = "deploy/agent-card-signed.mjs";
    const module = `// Fixture-signed by tests/runtime-package.test.js for the packaged\n// production boot probe — not a real signature (see scripts/sign-agent-card.mjs).\nexport const AGENT_CARD_SIGNATURE = "fixture-signature";\nexport const AGENT_CARD_SIGNED_REVISION = "dev";\nexport const AGENT_CARD_UNSIGNED_REASON = null;\nexport const AGENT_CARD_JWS_SIGNATURES = null;\n`;
    writeFileSync(join(destination, signedPath), module);
    const manifestPath = join(destination, "runtime-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const entry = manifest.files.find(file => file.path === signedPath);
    entry.bytes = Buffer.byteLength(module);
    entry.sha256 = createHash("sha256").update(module, "utf8").digest("hex");
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  }
  // Re-baseline: the boot/data probes below must not mutate the package
  // relative to this fixture-signed state.
  receipt = verifyRuntimePackage(destination);
  const { auditRecovery } = await import(pathToFileURL(join(destination, "server/recovery.mjs")));
  const f = committedFixture(join(directory, "fixture.sqlite"));
  try {
    const helpRetries = [];
    for (const status of ["open", "withdrawn"]) {
      const workItemId = `packaged-help-${status}`;
      for (const command of [
        { id: `${workItemId}-propose`, type: "work.proposed", data: { workItemId, title: "Help with an agenda", definitionOfDone: "Two ideas", accountableMemberId: "owner" } },
        { id: `${workItemId}-accept`, type: "work.accepted", data: { workItemId, expectedRevision: 0 } },
        { id: `${workItemId}-open`, type: "work.help_updated", data: { workItemId, expectedRevision: 1, expectedHelpRevision: 0, status: "open",
          scope: "Suggest two agenda items 🪷", expiresAt: new Date(f.now() + 3600000).toISOString() } },
        ...(status === "withdrawn" ? [{ id: `${workItemId}-withdraw`, type: "work.help_updated", data: { workItemId, expectedRevision: 1, expectedHelpRevision: 1, status: "withdrawn" } }] : [])
      ]) helpRetries.push({ command, receipt: f.store.command(f.keys.owner, "commons", command) });
    }
    const before = auditRecovery(f.store);
    const { RoomStore } = await import(pathToFileURL(join(destination, "server/store.mjs")));
    const restored = new RoomStore(f.filename, { now: f.now });
    try {
      assert.deepEqual(auditRecovery(restored), before);
      for (const [index, request] of (f.inboxRequests ?? []).entries()) {
        const result = restored.inbox.apply(f.owner.token, request, f.owner.session.sessionBinding);
        assert.equal(result.duplicate, true);
        assert.deepEqual(result.receipt, f.inboxReceipts[index]);
      }
      if (f.inboxRequests) assert.equal(restored.inbox.read(f.owner.token, "recovery-source", f.owner.session.sessionBinding).draft.body, f.inboxDraftBody ?? "Private recovery reply");
      for (const [index, request] of (f.transportRequests ?? []).entries()) {
        assert.deepEqual(restored.inbox.transport(f.owner.token, request, f.owner.session.sessionBinding).receipt, f.transportReceipts[index]);
      }
      if (f.transportRequests) assert.equal(restored.inbox.sends(f.owner.token, "recovery-source", f.owner.session.sessionBinding).sends[0].status, "accepted");
      for (const { command, receipt } of helpRetries) assert.equal(restored.command(f.keys.owner, "commons", command).event.id, receipt.event.id);
      for (const status of ["open", "withdrawn"]) assert.equal(restored.room("commons").state.workItems[`packaged-help-${status}`].helpWanted.status, status);
      assert.deepEqual(auditRecovery(restored), before, "Cold exact-package help retries preserve every table");
      assert.equal(restored.command(f.keys.owner, "commons", f.command).duplicate, true);
      assert.equal(restored.command(f.keys.owner, "commons", f.nativeCommand).event.id, f.nativeCompletion.event.id);
      assert.equal(restored.workResult(f.keys.owner, "commons", "native-evidence").result.text.body, f.nativeBody);
      assert.equal(restored.command(f.keys.owner, "commons", f.charterCommand).event.id, f.charterSaved.event.id);
      assert.equal(restored.charter(f.keys.owner, "commons").charter.purpose, f.charterCommand.data.purpose);
      if (existsSync(join(destination, "server/work-discussion.mjs"))) {
        const discussion = restored.workDiscussion(f.keys.owner, "commons", "evidence");
        assert.equal(discussion.workItemId, "evidence");
        assert.equal(discussion.viewerId, "owner");
        assert.deepEqual(discussion.discussion.items, []);
        assert.equal(discussion.discussion.checkpoint, restored.room("commons").sequence);
        assert.deepEqual(auditRecovery(restored), before, "packaged discussion reader is read-only");
      }
    } finally { restored.close(); }
    const probe = createServer(); await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const modes = existsSync(join(destination, "server/maintenance.mjs")) ? ["1", "0"] : ["0"];
    for (const pause of modes) {
      const child = spawn(process.execPath, [join(destination, "server.mjs")], { cwd: directory,
        env: { PATH: "/unavailable", NODE_ENV: "production", ROOM_DEPLOYMENT: "invite-only", ROOM_DB: f.filename,
          ROOM_ORIGIN: "https://room.example.test", ROOM_MAINTENANCE: pause, HOST: "127.0.0.1", PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
      const stopped = new Promise(resolve => child.once("exit", resolve));
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Packaged service did not start")), 10000);
          child.stdout.once("data", () => { clearTimeout(timer); resolve(); });
          child.once("error", error => { clearTimeout(timer); reject(error); });
          child.once("exit", () => { clearTimeout(timer); reject(new Error("Packaged service exited before readiness")); });
        });
        const response = await new Promise((resolve, reject) => {
          const req = request({ hostname: "127.0.0.1", port, path: "/api/rooms/commons", headers: { host: "room.example.test",
            "x-real-ip": "192.0.2.1", authorization: `Bearer ${f.keys.owner}` } }, res => {
            let body = ""; res.on("data", chunk => { body += chunk; }); res.on("end", () => resolve({ status: res.statusCode, body }));
          }); req.on("error", reject); req.end();
        });
        assert.equal(response.status, pause === "1" ? 503 : 200);
        if (pause === "0") assert.equal(JSON.parse(response.body).viewerId, "owner");
        assert.deepEqual(auditRecovery(f.store), before);
      } finally { child.kill("SIGTERM"); await stopped; }
    }
  } finally { f.store.close(); }
  assert.deepEqual(verifyRuntimePackage(destination), receipt, "all generated state stays outside the immutable package");

  for (const fault of ["missing", "changed", "extra", "symlink", "duplicate", "partial", "empty-directory"]) {
    const damaged = join(directory, fault); cpSync(destination, damaged, { recursive: true });
    const path = join(damaged, "server.mjs");
    if (fault === "missing") rmSync(path);
    else if (fault === "changed") writeFileSync(path, "// changed\n");
    else if (fault === "extra") writeFileSync(join(damaged, "room.sqlite"), "private fixture sentinel");
    else if (fault === "symlink") { rmSync(path); symlinkSync(join(destination, "server.mjs"), path); }
    else if (fault === "partial") rmSync(join(damaged, "runtime-manifest.json"));
    else if (fault === "empty-directory") mkdirSync(join(damaged, "unexpected"));
    else {
      const manifest = JSON.parse(readFileSync(join(damaged, "runtime-manifest.json"))); manifest.files.push(manifest.files[0]);
      writeFileSync(join(damaged, "runtime-manifest.json"), JSON.stringify(manifest));
    }
    assert.throws(() => verifyRuntimePackage(damaged), fault);
  }
});

test("every module in the server import closure is in the runtime-package allowlist", () => {
  // Regression guard for #590/#592/#606: a new server/*.mjs imported by
  // server/http.mjs (transitively from server.mjs) must be registered in
  // scripts/runtime-package.mjs, or the browser gate's createRuntimePackage
  // silently ships a runtime with a missing module. This computes the import
  // graph from source, so the allowlist can never drift from the code.
  const closure = importClosure("server.mjs", repository);
  const missing = [...closure].filter(path => !allowed.has(path)).sort();
  assert.deepEqual(missing, [],
    `Imported but not allowlisted for the runtime package. Add to scripts/runtime-package.mjs: ${missing.join(", ")}`);
});

test("uncommitted candidate packages cold in an isolated synthetic commit, including request observer dependencies", t => {
  const directory = mkdtempSync(join(tmpdir(), "room-candidate-package-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const candidate = candidateRuntimeFixture(repository, directory), destination = join(directory, "runtime");
  const receipt = createRuntimePackage({ repository: candidate.repository, commit: candidate.commit, destination });
  // The allowlist (scripts/runtime-package.mjs) is the single source of truth.
  // The expected file count derives from the fixture's packaged paths
  // intersected with the allowlist, so registering a new module never requires
  // a hand-bumped count here (regression guard for #590/#592/#606, which broke
  // clean main on a stale number).
  const expectedFiles = [...candidate.packagedPaths].filter(path => allowed.has(path)).length;
  assert.equal(receipt.files, expectedFiles,
    `candidate package ships ${receipt.files} files but the allowlisted fixture set has ${expectedFiles}`);
  // Cold imports below exercise the host runner, process adapter and CLI.
  for (const file of ["client/request-runner.mjs", "client/host-process.mjs", "client/host-context-policy.mjs", "client/host-result.mjs", "client/host-subprocess.mjs", "client/host-verification.mjs", "client/agent-setup.mjs", "client/setup-journal.mjs", "scripts/connect-room.mjs", "scripts/run-room-request.mjs"]) assert.ok(existsSync(join(destination, file)), file);
  const program = `
    import { RoomStore } from ${JSON.stringify(pathToFileURL(join(destination, "server/store.mjs")).href)};
    import { configuredHost } from ${JSON.stringify(pathToFileURL(join(destination, "client/host-process.mjs")).href)};
    import { runRequestOnce } from ${JSON.stringify(pathToFileURL(join(destination, "client/request-runner.mjs")).href)};
    if (typeof configuredHost !== "function" || typeof runRequestOnce !== "function") throw new Error("Missing host bridge");
    import { SyntheticInboxTransport } from ${JSON.stringify(pathToFileURL(join(destination, "server/inbox-transport.mjs")).href)};
    import { initialRoom } from ${JSON.stringify(pathToFileURL(join(destination, "server/bootstrap.mjs")).href)};
    import { currentAttention } from ${JSON.stringify(pathToFileURL(join(destination, "client/attention-inbox.mjs")).href)};
    import { helpTools, buildHelpCommand } from ${JSON.stringify(pathToFileURL(join(destination, "client/help-actions.mjs")).href)};
    import { RoomAgentClient } from ${JSON.stringify(pathToFileURL(join(destination, "client/room-agent.mjs")).href)};
    if (helpTools.length !== 5 || typeof RoomAgentClient.prototype.helpAction !== "function") throw new Error("Missing help tools");
    const offer = buildHelpCommand("room_offer_help", { requestId: "cold-offer", workItemId: "work", offerId: "offer", expectedRevision: 1,
      expectedHelpRevision: 1, helpEventId: "invitation", plan: "Two agenda items" });
    if (offer.type !== "work.help_offer_opened") throw new Error("Incorrect offer command");
    const store = new RoomStore(":memory:"); store.initialize(initialRoom());
    if (typeof SyntheticInboxTransport !== "function" || typeof store.inbox.sendContext !== "function") throw new Error("Missing outbox runtime");
    if (typeof store.email.apply !== "function" || store.email.verify().sources !== 0) throw new Error("Missing email import runtime");
    const key = store.issueAccessKey("commons", "owner"), client = {
      snapshot: async () => store.snapshot(key, "commons"), changes: async (after, limit) => store.eventsAfter(key, "commons", after, limit)
    };
    const config = { client, origin: "http://127.0.0.1:12345", roomId: "commons", directory: ${JSON.stringify(join(directory, "observer"))}, version: 3 };
    const first = await currentAttention(config), second = await currentAttention(config);
    console.log(JSON.stringify({ version: second.schemaVersion, pending: second.pending, unchanged: JSON.stringify(first.items) === JSON.stringify(second.items) }));
    store.close();`;
  const cold = spawnSync(process.execPath, ["--input-type=module", "-e", program], { cwd: directory, env: { PATH: "/unavailable" }, encoding: "utf8" });
  assert.equal(cold.status, 0, cold.stderr); assert.deepEqual(JSON.parse(cold.stdout), { version: 3, pending: 0, unchanged: true });
  assert.deepEqual(verifyRuntimePackage(destination), receipt);
});


test("Codex host entrypoint and every dependency ship without scratch demo fixtures", () => {
  const entry = "scripts/run-codex-room.mjs";
  const closure = new Set([entry, ...importClosure(entry, repository)]);
  assert.deepEqual([...closure].filter(path => !allowed.has(path)), []);
  assert.equal(closure.has("client/codex-runtime.mjs"), true);
  assert.equal(closure.has("client/codex-shared-assistant.mjs"), true);
  assert.equal(closure.has("client/codex-stdio.mjs"), true);
  assert.equal(closure.has("scripts/room-assistant-scratch.mjs"), false);
  assert.equal(closure.has("scripts/acceptance-fixture.mjs"), false);
});
