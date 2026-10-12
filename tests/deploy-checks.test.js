// F007: tests for scripts/deploy-checks.mjs — reproducible deploy checks.
//
// Pure functions are tested directly with temp-dir fixtures; the CLI gets a
// small spawn smoke test (--write round-trip, --check pass/fail, usage errors).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  sha256Hex,
  hashFile,
  computeAssetHashes,
  diffManifests,
  buildManifest,
  readManifest,
  writeManifest,
  checkLockfileSync,
  runDeployChecks,
  DEFAULT_MANIFEST_NAME,
} from "../scripts/deploy-checks.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL("../scripts/deploy-checks.mjs", import.meta.url));

function tempDir(t, prefix = "deploy-checks-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

function writeJson(dir, name, value) {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value, null, 2));
  return path;
}

// Minimal in-sync package.json + lockfileVersion-3 lockfile fixture.
function syncFixtures() {
  const pkg = {
    name: "fixture-room",
    version: "1.2.3",
    dependencies: { leftpad: "1.3.0" },
    devDependencies: { eslint: "10.10.0" },
  };
  const lock = {
    name: "fixture-room",
    version: "1.2.3",
    lockfileVersion: 3,
    packages: {
      "": {
        name: "fixture-room",
        version: "1.2.3",
        dependencies: { leftpad: "1.3.0" },
        devDependencies: { eslint: "10.10.0" },
      },
      "node_modules/leftpad": { version: "1.3.0" },
      "node_modules/eslint": { version: "10.10.0" },
    },
  };
  return { pkg, lock };
}

function checkByName(result, name) {
  const found = result.checks.find(c => c.name === name);
  assert.ok(found, `expected a ${name} check`);
  return found;
}

// --- sha256Hex / hashFile ----------------------------------------------------

test("sha256Hex matches known vectors", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256Hex(Buffer.from("abc")), sha256Hex("abc"));
});

test("hashFile hashes file bytes and differs on content change", t => {
  const dir = tempDir(t);
  const path = join(dir, "a.txt");
  writeFileSync(path, "hello deploy");
  assert.equal(hashFile(path), createHash("sha256").update("hello deploy").digest("hex"));
  writeFileSync(path, "hello deploy!");
  assert.notEqual(hashFile(path), sha256Hex("hello deploy"));
  assert.throws(() => hashFile(join(dir, "nope.txt")));
});

// --- computeAssetHashes ------------------------------------------------------

test("computeAssetHashes hashes files with sorted posix keys", t => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "b.txt"), "b-content");
  writeFileSync(join(dir, "a.txt"), "a-content");
  const { hashes, missing, skipped } = computeAssetHashes(["b.txt", "a.txt"], { root: dir });
  assert.deepEqual(Object.keys(hashes), ["a.txt", "b.txt"]);
  assert.equal(hashes["a.txt"], sha256Hex("a-content"));
  assert.equal(hashes["b.txt"], sha256Hex("b-content"));
  assert.deepEqual(missing, []);
  assert.deepEqual(skipped, []);
});

test("computeAssetHashes reports missing files", t => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "present.txt"), "x");
  const { hashes, missing } = computeAssetHashes(["present.txt", "gone.txt", "also/gone.txt"], { root: dir });
  assert.deepEqual(Object.keys(hashes), ["present.txt"]);
  assert.deepEqual(missing, ["also/gone.txt", "gone.txt"]);
});

test("computeAssetHashes expands directories recursively", t => {
  const dir = tempDir(t);
  mkdirSync(join(dir, "deploy", "sub"), { recursive: true });
  writeFileSync(join(dir, "deploy", "room-entry.mjs"), "entry");
  writeFileSync(join(dir, "deploy", "sub", "Caddyfile"), "caddy");
  writeFileSync(join(dir, "deploy", "sub", "deep.txt"), "deep");
  const { hashes, missing } = computeAssetHashes(["deploy"], { root: dir });
  assert.deepEqual(Object.keys(hashes), ["deploy/room-entry.mjs", "deploy/sub/Caddyfile", "deploy/sub/deep.txt"]);
  assert.equal(hashes["deploy/sub/deep.txt"], sha256Hex("deep"));
  assert.deepEqual(missing, []);
});

test("computeAssetHashes skips symlinks inside expanded directories", t => {
  const dir = tempDir(t);
  mkdirSync(join(dir, "deploy"));
  writeFileSync(join(dir, "deploy", "real.txt"), "real");
  try {
    symlinkSync(join(dir, "deploy", "real.txt"), join(dir, "deploy", "link.txt"));
  } catch {
    t.skip("symlinks not permitted on this platform");
    return;
  }
  const { hashes, skipped } = computeAssetHashes(["deploy"], { root: dir });
  assert.deepEqual(Object.keys(hashes), ["deploy/real.txt"]);
  assert.deepEqual(skipped, ["deploy/link.txt"]);
});

// --- diffManifests -----------------------------------------------------------

test("diffManifests passes on identical maps", () => {
  const expected = { "a.txt": "h1", "b.txt": "h2" };
  const actual = { "b.txt": "h2", "a.txt": "h1" };
  const diff = diffManifests(expected, actual);
  assert.equal(diff.ok, true);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.changed, []);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.missing, []);
});

test("diffManifests reports added, changed, removed, and missing", () => {
  const expected = { "keep.txt": "h1", "mod.txt": "old", "del.txt": "h3" };
  const actual = { "keep.txt": "h1", "mod.txt": "new", "new.txt": "h4" };
  const diff = diffManifests(expected, actual, ["unreadable.txt"]);
  assert.equal(diff.ok, false);
  assert.deepEqual(diff.added, ["new.txt"]);
  assert.deepEqual(diff.changed, ["mod.txt"]);
  assert.deepEqual(diff.removed, ["del.txt"]);
  assert.deepEqual(diff.missing, ["unreadable.txt"]);
});

test("diffManifests is not fooled by Object.prototype keys", () => {
  const diff = diffManifests({}, { constructor: "h", toString: "h2" });
  assert.equal(diff.ok, false);
  assert.deepEqual(diff.added, ["constructor", "toString"]);
});

// --- manifest IO -------------------------------------------------------------

test("writeManifest/readManifest round-trip", t => {
  const dir = tempDir(t);
  const path = join(dir, DEFAULT_MANIFEST_NAME);
  const manifest = buildManifest({ "a.txt": "a".repeat(64) }, { generatedAt: "2026-09-16T00:00:00.000Z" });
  assert.equal(manifest.version, 1);
  assert.equal(manifest.assetCount, 1);
  writeManifest(path, manifest);
  const back = readManifest(path);
  assert.deepEqual(back.assets, { "a.txt": "a".repeat(64) });
  assert.equal(back.version, 1);
});

test("readManifest rejects missing, invalid, and shapeless manifests", t => {
  const dir = tempDir(t);
  assert.throws(() => readManifest(join(dir, "nope.json")), /run with --write first/);
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{not json");
  assert.throws(() => readManifest(bad), /not valid JSON/);
  const shapeless = join(dir, "shapeless.json");
  writeFileSync(shapeless, JSON.stringify({ version: 1 }));
  assert.throws(() => readManifest(shapeless), /no "assets" object/);
});

// --- checkLockfileSync -------------------------------------------------------

test("checkLockfileSync passes for an in-sync v3 lockfile", t => {
  const dir = tempDir(t);
  const { pkg, lock } = syncFixtures();
  writeJson(dir, "package.json", pkg);
  writeJson(dir, "package-lock.json", lock);
  const result = checkLockfileSync({ root: dir });
  assert.equal(result.ok, true);
  for (const name of ["lockfile-present", "package-json-parseable", "lockfile-parseable",
    "lockfile-name", "lockfile-version", "dependencies-in-sync", "no-extraneous-root-deps"]) {
    assert.equal(checkByName(result, name).ok, true, name);
  }
});

test("checkLockfileSync flags an out-of-sync spec", t => {
  const dir = tempDir(t);
  const { pkg, lock } = syncFixtures();
  lock.packages[""].devDependencies.eslint = "10.9.0";
  writeJson(dir, "package.json", pkg);
  writeJson(dir, "package-lock.json", lock);
  const result = checkLockfileSync({ root: dir });
  assert.equal(result.ok, false);
  const syncCheck = checkByName(result, "dependencies-in-sync");
  assert.equal(syncCheck.ok, false);
  assert.match(syncCheck.detail, /devDependencies\.eslint/);
  assert.match(syncCheck.detail, /"10\.10\.0".*"10\.9\.0"/);
});

test("checkLockfileSync flags a missing dependency entry", t => {
  const dir = tempDir(t);
  const { pkg, lock } = syncFixtures();
  delete lock.packages[""].dependencies.leftpad;
  writeJson(dir, "package.json", pkg);
  writeJson(dir, "package-lock.json", lock);
  const result = checkLockfileSync({ root: dir });
  assert.equal(result.ok, false);
  assert.match(checkByName(result, "dependencies-in-sync").detail, /dependencies\.leftpad/);
});

test("checkLockfileSync flags extraneous lockfile entries", t => {
  const dir = tempDir(t);
  const { pkg, lock } = syncFixtures();
  lock.packages[""].devDependencies.surprise = "9.9.9";
  writeJson(dir, "package.json", pkg);
  writeJson(dir, "package-lock.json", lock);
  const result = checkLockfileSync({ root: dir });
  assert.equal(result.ok, false);
  assert.match(checkByName(result, "no-extraneous-root-deps").detail, /devDependencies\.surprise/);
});

test("checkLockfileSync flags version and name drift", t => {
  const dir = tempDir(t);
  const { pkg, lock } = syncFixtures();
  lock.version = "9.9.9";
  lock.name = "other";
  lock.packages[""].version = "9.9.9";
  lock.packages[""].name = "other";
  writeJson(dir, "package.json", pkg);
  writeJson(dir, "package-lock.json", lock);
  const result = checkLockfileSync({ root: dir });
  assert.equal(result.ok, false);
  assert.equal(checkByName(result, "lockfile-version").ok, false);
  assert.equal(checkByName(result, "lockfile-name").ok, false);
});

test("checkLockfileSync fails cleanly on missing or broken lockfiles", t => {
  const dir = tempDir(t);
  writeJson(dir, "package.json", { name: "x", version: "1.0.0" });
  let result = checkLockfileSync({ root: dir });
  assert.equal(result.ok, false);
  assert.equal(checkByName(result, "lockfile-present").ok, false);

  writeFileSync(join(dir, "package-lock.json"), "{oops");
  result = checkLockfileSync({ root: dir });
  assert.equal(result.ok, false);
  assert.equal(checkByName(result, "lockfile-present").ok, true);
  assert.equal(checkByName(result, "lockfile-parseable").ok, false);
});

test("checkLockfileSync handles legacy v1 lockfiles", t => {
  const dir = tempDir(t);
  const pkg = { name: "legacy", version: "0.1.0", dependencies: { leftpad: "1.3.0" }, devDependencies: { tap: "^16.0.0" } };
  const lock = {
    name: "legacy", version: "0.1.0", lockfileVersion: 1,
    dependencies: { leftpad: { version: "1.3.0" }, tap: { version: "16.3.1" } },
  };
  writeJson(dir, "package.json", pkg);
  writeJson(dir, "package-lock.json", lock);
  assert.equal(checkLockfileSync({ root: dir }).ok, true);

  lock.dependencies.leftpad.version = "1.2.9";
  writeJson(dir, "package-lock.json", lock);
  const result = checkLockfileSync({ root: dir });
  assert.equal(result.ok, false);
  assert.match(checkByName(result, "dependencies-in-sync").detail, /leftpad/);
});

// --- runDeployChecks ----------------------------------------------------------

test("runDeployChecks passes on a fully in-sync fixture", t => {
  const dir = tempDir(t);
  const { pkg, lock } = syncFixtures();
  writeJson(dir, "package.json", pkg);
  writeJson(dir, "package-lock.json", lock);
  mkdirSync(join(dir, "deploy"));
  writeFileSync(join(dir, "deploy", "app.mjs"), "app");
  const manifestPath = join(dir, ".asset-hashes.json");
  writeManifest(manifestPath, buildManifest(computeAssetHashes(["deploy"], { root: dir }).hashes));
  const result = runDeployChecks({ root: dir, assets: ["deploy"], manifestPath });
  assert.equal(result.ok, true);
  assert.equal(result.lockfile.ok, true);
  assert.equal(result.assets.ok, true);
  assert.equal(result.assets.compared.ok, true);
});

test("runDeployChecks reports tampered assets with a clear diff", t => {
  const dir = tempDir(t);
  const { pkg, lock } = syncFixtures();
  writeJson(dir, "package.json", pkg);
  writeJson(dir, "package-lock.json", lock);
  mkdirSync(join(dir, "deploy"));
  writeFileSync(join(dir, "deploy", "app.mjs"), "app");
  writeFileSync(join(dir, "deploy", "cfg.txt"), "cfg");
  const manifestPath = join(dir, ".asset-hashes.json");
  writeManifest(manifestPath, buildManifest(computeAssetHashes(["deploy"], { root: dir }).hashes));
  // Tamper one file, delete another, add a third.
  writeFileSync(join(dir, "deploy", "app.mjs"), "app TAMPERED");
  rmSync(join(dir, "deploy", "cfg.txt"));
  writeFileSync(join(dir, "deploy", "extra.txt"), "extra");
  const result = runDeployChecks({ root: dir, assets: ["deploy"], manifestPath });
  assert.equal(result.ok, false);
  assert.equal(result.lockfile.ok, true);
  assert.deepEqual(result.assets.compared.changed, ["deploy/app.mjs"]);
  assert.deepEqual(result.assets.compared.removed, ["deploy/cfg.txt"]);
  assert.deepEqual(result.assets.compared.added, ["deploy/extra.txt"]);
});

test("runDeployChecks fails with a --write hint when the manifest is missing", t => {
  const dir = tempDir(t);
  const { pkg, lock } = syncFixtures();
  writeJson(dir, "package.json", pkg);
  writeJson(dir, "package-lock.json", lock);
  mkdirSync(join(dir, "deploy"));
  writeFileSync(join(dir, "deploy", "app.mjs"), "app");
  const result = runDeployChecks({ root: dir, assets: ["deploy"], manifestPath: join(dir, ".asset-hashes.json") });
  assert.equal(result.ok, false);
  assert.match(result.assets.note, /--write/);
});

test("runDeployChecks supports lockfile-only and assets-only runs", t => {
  const dir = tempDir(t);
  const { pkg, lock } = syncFixtures();
  writeJson(dir, "package.json", pkg);
  writeJson(dir, "package-lock.json", lock);
  let result = runDeployChecks({ root: dir, checkAssets: false });
  assert.equal(result.ok, true);
  assert.equal(result.assets, null);
  result = runDeployChecks({ root: dir, assets: [], checkLockfile: false });
  assert.equal(result.ok, true);
  assert.equal(result.lockfile, null);
  assert.match(result.assets.note, /no deploy assets configured/);
});

// --- CLI smoke -----------------------------------------------------------------

async function cli(args, { cwd } = {}) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [scriptPath, ...args], {
      cwd: cwd || process.cwd(), encoding: "utf8", timeout: 30000,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return { status: error.code ?? 1, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
  }
}

test("CLI --write then --check round-trip in a fixture root", async t => {
  const dir = tempDir(t);
  const { pkg, lock } = syncFixtures();
  writeJson(dir, "package.json", pkg);
  writeJson(dir, "package-lock.json", lock);
  mkdirSync(join(dir, "deploy"));
  writeFileSync(join(dir, "deploy", "app.mjs"), "app");

  const written = await cli(["--write", "--root", dir, "--assets", "deploy"]);
  assert.equal(written.status, 0);
  assert.match(written.stdout, /"mode":"write"/);
  assert.match(written.stdout, /"assetCount":1/);

  const checked = await cli(["--check", "--root", dir, "--assets", "deploy"]);
  assert.equal(checked.status, 0);
  assert.match(checked.stdout, /"ok":true/);

  writeFileSync(join(dir, "deploy", "app.mjs"), "app TAMPERED");
  const failed = await cli(["--check", "--root", dir, "--assets", "deploy"]);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /deploy-checks: FAILED/);
  assert.match(failed.stderr, /changed: deploy\/app\.mjs/);
});

test("CLI --write refuses missing assets and rejects conflicting flags", async t => {
  const dir = tempDir(t);
  const missing = await cli(["--write", "--root", dir, "--assets", "nope/"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /missing or unreadable/);

  const conflict = await cli(["--check", "--write", "--root", dir]);
  assert.equal(conflict.status, 2);
  assert.match(conflict.stderr, /mutually exclusive/);

  const help = await cli(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /reproducible deploy checks/);
});

// Actual deployment recovery owner: no live credentials or writes in fixtures.
import { rollbackDecision, recoverWorkers, recoveryDescription, observeWorker, schemaAt, withApiRetry, transientApiFailure, deploymentStatus, parseDeploymentStatus, restDeploymentStatus, allocation } from "../scripts/deploy-recovery.mjs";
import { parse as parseYaml } from "yaml";
const recoveryOld = "11111111-1111-4111-8111-111111111111";
const recoveryNew = "22222222-2222-4222-8222-222222222222";
const recoveryRevision = "a".repeat(40);
const recoveryAllocation = id => ({ versions: [{ version_id: id, percentage: 100 }] });
const previousWorker = schema => ({ known: true, versionId: recoveryOld, sourceRevision: recoveryRevision, codeSchemaVersion: schema });

test("failed allocation subprocess exposes bounded API diagnostics without credentials and prevents snapshot", async t => {
  const directory = tempDir(t, "recovery-command-");
  const executable = join(directory, "pnpm");
  writeFileSync(executable, `#!/usr/bin/env node
process.stdout.write('allocation request account=' + process.env.CLOUDFLARE_ACCOUNT_ID + '\\n');
process.stderr.write('Cloudflare API error 10000: Authentication error\\nBearer ' + process.env.CLOUDFLARE_API_TOKEN + '\\n' + 'x'.repeat(20000) + '\\nrequest trace: fixture-trace\\n');
process.exit(17);
`, { mode: 0o755 });
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const { stdout: revision } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
  const snapshot = join(directory, "pre-deploy.json");
  await assert.rejects(execFileAsync(process.execPath, ["scripts/deploy-recovery.mjs", "snapshot", snapshot], {
    cwd, env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, SHA: revision.trim(),
      CLOUDFLARE_API_TOKEN: "fixture-sensitive-token", CLOUDFLARE_ACCOUNT_ID: "fixture-sensitive-account" }
  }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /wrangler deployments status --env production --json/);
    assert.match(error.stderr, /failed \(17\)/);
    assert.match(error.stderr, /Cloudflare API error 10000: Authentication error/);
    assert.match(error.stderr, /fixture-trace/);
    assert.doesNotMatch(error.stderr, /fixture-sensitive-token|fixture-sensitive-account/);
    assert.ok(error.stderr.length < 12000, "subprocess diagnostics must be bounded");
    return true;
  });
  assert.throws(() => readFileSync(snapshot), { code: "ENOENT" });
});

test("rollback schema gate rejects lower and unknown schemas without executing old code", async () => {
  for (const previous of [previousWorker(37), previousWorker(null), { ...previousWorker(38), known: false }, { ...previousWorker(38), sourceRevision: "unstamped" }]) {
    let calls = 0;
    const report = await recoverWorkers({ targetSha: "b".repeat(40), candidateCodeSchemaVersion: 38, prod: previous, entry: previous }, { prod: true, entry: true }, {
      status: async () => recoveryAllocation(recoveryNew), rollback: async () => { calls++; }, readVersion: async () => { throw new Error("must not read back unattempted rollback"); },
    });
    assert.equal(calls, 0);
    assert.equal(report.status, "ROLL FORWARD REQUIRED");
    assert.equal(report.workers.prod.rollbackAttempted, false);
    assert.doesNotMatch(recoveryDescription(report), /rolled back|ROLLBACK VERIFIED/);
  }
  assert.equal(rollbackDecision(previousWorker(38), 38).eligible, true);
  assert.match(rollbackDecision(previousWorker(38), 38).reason, /compatibility is not established/);
});

test("recovery distinguishes no upload, verified rollback and failed/unverified commands", async () => {
  const snapshot = { targetSha: "b".repeat(40), candidateCodeSchemaVersion: 38, prod: previousWorker(38), entry: previousWorker(37) };
  let calls = 0;
  const noChange = await recoverWorkers(snapshot, { prod: true, entry: false }, {
    status: async () => recoveryAllocation(recoveryOld), rollback: async () => { calls++; }, readVersion: async () => { throw new Error("no upload needs no readback"); },
  });
  assert.equal(noChange.status, "NO DEPLOYMENT CHANGE OBSERVED");
  assert.equal(calls, 0);
  for (const kind of ["verified", "command-failed", "wrong-source", "wrong-allocation"]) {
    let rolled = false;
    const report = await recoverWorkers(snapshot, { prod: true, entry: false }, {
      status: async () => recoveryAllocation(rolled && kind !== "wrong-allocation" ? recoveryOld : recoveryNew),
      rollback: async () => { rolled = true; if (kind === "command-failed") throw new Error("rollback failed"); },
      readVersion: async () => ({ status: "ok", servedBy: "worker", sourceRevision: kind === "wrong-source" ? "c".repeat(40) : recoveryRevision }),
    });
    assert.equal(report.status, kind === "verified" ? "ROLLBACK VERIFIED" : "ROLLBACK NOT VERIFIED");
    assert.equal(report.workers.entry.disposition, "unchanged");
    if (kind !== "verified") assert.doesNotMatch(recoveryDescription(report), /ROLLBACK VERIFIED|rolled back/);
  }
});

test("prior source proof requires one stable exact deployment and parses Git schema without evaluation", async () => {
  const git = args => args[0] === "show" ? "export const STORE_SCHEMA_VERSION = 37;\nthrow new Error('source must never execute');" : "d".repeat(40);
  const proof = schemaAt(recoveryRevision, git);
  assert.equal(proof.version, 37);
  assert.equal(proof.revision, recoveryRevision);
  const observed = await observeWorker({ status: async () => recoveryAllocation(recoveryOld), readVersion: async () => ({ status: "ok", servedBy: "worker", sourceRevision: recoveryRevision }), schema: sha => schemaAt(sha, git) });
  assert.equal(observed.known, true);
  assert.equal(observed.codeSchemaVersion, 37);
  for (const bad of ["unstamped", "../wrong", "a".repeat(39)]) assert.equal(schemaAt(bad, git), null);
  let query = 0;
  const moved = await observeWorker({ status: async () => recoveryAllocation(query++ ? recoveryNew : recoveryOld), readVersion: async () => ({ status: "ok", servedBy: "worker", sourceRevision: recoveryRevision }), schema: sha => schemaAt(sha, git) });
  assert.equal(moved.known, false);
  const split = await observeWorker({ status: async () => ({ versions: [{ version_id: recoveryOld, percentage: 50 }, { version_id: recoveryNew, percentage: 50 }] }), readVersion: async () => ({ status: "ok", servedBy: "worker", sourceRevision: recoveryRevision }), schema: sha => schemaAt(sha, git) });
  assert.equal(split.known, false);
});

test("actual production workflow captures schemas before uploads and uses guarded recovery and truthful receipts", () => {
  const source = readFileSync(new URL("../.github/workflows/deploy-prod.yml", import.meta.url), "utf8");
  const workflow = parseYaml(source), steps = workflow.jobs.deploy.steps;
  const snapshot = steps.findIndex(step => step.id === "pre"), prod = steps.findIndex(step => step.id === "prod");
  assert.ok(snapshot >= 0 && snapshot < prod);
  assert.match(steps[snapshot].run, /deploy-recovery\.mjs snapshot/);
  const recovery = steps.find(step => step.id === "rollback");
  assert.match(recovery.run, /deploy-recovery\.mjs recover/);
  assert.doesNotMatch(recovery.run, /wrangler rollback/);
  assert.match(recovery.if, /steps\.pre\.outcome == 'success'/);
  assert.match(steps.find(step => step.name === "Receipt to muse-room").run, /recoveryDescription/);
  assert.doesNotMatch(steps.find(step => step.name === "Receipt to muse-room").run, /FAILED · rolled back/);
  for (const step of steps.filter(step => ["prod", "entry"].includes(step.id))) {
    assert.match(step.run, /--keep-vars --var ROOM_BODIES_AT_REST:1/);
    assert.ok(step.env.ROOM_AGENT_CARD_SIGNING_KEY);
  }
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.match(steps.find(step => step.name === "Summary").run, /Code schemas/);
});

import { createServer } from "node:http";
test("actual recovery CLI records independent exact source schemas and refuses a 37-to-38 fallback", async t => {
  const dir = tempDir(t, "deploy-recovery-cli-");
  mkdirSync(join(dir, "server")); mkdirSync(join(dir, "cloudflare")); mkdirSync(join(dir, "bin"));
  // The extensionless fake pnpm is CommonJS even under repository-local TMPDIR.
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "commonjs" }));
  const git = args => execFileAsync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: dir });
  await git(["init", "--quiet"]);
  writeFileSync(join(dir, "server/writer-fence.mjs"), "export const STORE_SCHEMA_VERSION = 37;\n");
  await git(["add", "."]); await git(["commit", "--quiet", "-m", "previous37"]);
  const oldSha = (await git(["rev-parse", "HEAD"])).stdout.trim();
  writeFileSync(join(dir, "server/writer-fence.mjs"), "export const STORE_SCHEMA_VERSION = 38;\n");
  await git(["add", "."]); await git(["commit", "--quiet", "-m", "candidate38"]);
  const targetSha = (await git(["rev-parse", "HEAD"])).stdout.trim();
  writeFileSync(join(dir, "bin/pnpm"), `#!/usr/bin/env node
const fs=require('node:fs'),a=process.argv.slice(2);fs.appendFileSync(process.env.COMMAND_LOG,JSON.stringify(a)+'\\n');if(a.includes('rollback'))throw new Error('unsafe rollback invoked');const prod=a.includes('production');console.log(JSON.stringify({versions:[{version_id:prod&&process.env.STATUS_PHASE!=='new'?'${recoveryOld}':'${recoveryNew}',percentage:100}]}));
`, { mode: 0o755 });
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url); res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "ok", servedBy: "worker", sourceRevision: req.url.startsWith("/prod/") ? oldSha : targetSha }));
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise(done => server.close(done)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const cli = fileURLToPath(new URL("../scripts/deploy-recovery.mjs", import.meta.url));
  const pre = join(dir, "pre.json"), recovery = join(dir, "recovery.json"), log = join(dir, "commands.log");
  const env = { ...process.env, SHA: targetSha, PROD_ORIGIN: `${origin}/prod`, ENTRY_ORIGIN: `${origin}/entry`, PATH: `${join(dir, "bin")}:${process.env.PATH}`, COMMAND_LOG: log };
  delete env.GITHUB_OUTPUT; delete env.GITHUB_STEP_SUMMARY;
  await execFileAsync(process.execPath, [cli, "snapshot", pre], { cwd: dir, env });
  const snapshot = JSON.parse(readFileSync(pre, "utf8"));
  assert.equal(snapshot.candidateCodeSchemaVersion, 38);
  assert.equal(snapshot.prod.versionId, recoveryOld);
  assert.equal(snapshot.prod.sourceRevision, oldSha);
  assert.equal(snapshot.prod.codeSchemaVersion, 37);
  assert.equal(snapshot.prod.automaticRollback.eligible, false);
  assert.equal(snapshot.entry.sourceRevision, targetSha);
  assert.equal(snapshot.entry.codeSchemaVersion, 38);
  assert.ok(snapshot.prod.schemaSource.blob);
  await assert.rejects(execFileAsync(process.execPath, [cli, "recover", pre, recovery], { cwd: dir, env: { ...env, PROD_OUTCOME: "success", ENTRY_OUTCOME: "skipped", STATUS_PHASE: "new" } }), error => error.code === 1);
  const report = JSON.parse(readFileSync(recovery, "utf8"));
  assert.equal(report.status, "ROLL FORWARD REQUIRED");
  assert.equal(report.workers.prod.rollbackAttempted, false);
  assert.equal(report.workers.entry.disposition, "unchanged");
  assert.ok(requests.every(path => path.endsWith("/api/version/worker")), "predeployment probes must never instantiate room storage");
  assert.ok(!readFileSync(log, "utf8").includes('"rollback"'));
});

// Cloudflare sometimes answers a read with HTTP 200 and a body wrangler cannot
// parse. That read is retried with backoff; every other failure stays fail-closed.
const malformed = () => new Error("pnpm exec wrangler deployments status --env production --json failed (1)\nstderr: Received a malformed response from the API");
const noWait = { sleep: async () => {}, log: () => {} };

test("a malformed Cloudflare API response is retried with doubling backoff and then succeeds", async () => {
  const waits = []; let calls = 0;
  const value = await withApiRetry(async () => { if (++calls < 3) throw malformed(); return "ok"; }, { ...noWait, sleep: async ms => { waits.push(ms); } });
  assert.equal(value, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(waits, [2000, 4000]);
});

test("API retry fails closed: exhausted attempts and non-transient errors rethrow without further tries", async () => {
  let calls = 0;
  await assert.rejects(withApiRetry(async () => { calls++; throw malformed(); }, { ...noWait, attempts: 4 }), /malformed response/);
  assert.equal(calls, 4);
  calls = 0;
  await assert.rejects(withApiRetry(async () => { calls++; throw new Error("Cloudflare API error 10000: Authentication error"); }, noWait), /Authentication error/);
  assert.equal(calls, 1, "an authentication error is not retried");
  assert.equal(transientApiFailure("Cloudflare API error 10000: Authentication error"), false);
  assert.equal(transientApiFailure("Received a malformed response from the API"), true);
});

test("deploymentStatus retries the wrangler read and still refuses output that is not a JSON object", async () => {
  let calls = 0;
  const run = args => {
    calls++;
    assert.deepEqual(args.slice(0, 5), ["pnpm", "exec", "wrangler", "deployments", "status"]);
    if (calls === 1) throw malformed();
    return `banner\n${JSON.stringify(recoveryAllocation(recoveryOld))}`;
  };
  assert.deepEqual(await deploymentStatus("prod", run, noWait), recoveryAllocation(recoveryOld));
  assert.equal(calls, 2);
  assert.throws(() => parseDeploymentStatus("no json here"), /no JSON object/);
  assert.throws(() => parseDeploymentStatus("{not json"), /unparseable JSON/);
  await assert.rejects(deploymentStatus("entry", () => "", noWait), /no JSON object/);
});

// REST fallback, with a ~4KB deployments body like the one wrangler rejected.
const restEnv = { CLOUDFLARE_API_TOKEN: "tok", CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef" };
const restConfig = { name: "project-room-staging", env: { production: { name: "project-room" } } };
const restDeployment = (id, versions) => ({ id: `d-${id}`, source: "wrangler", strategy: "percentage", created_on: "2026-10-12T09:55:00Z", annotations: { "workers/triggered_by": "deployment", note: "x".repeat(150) }, versions });
const restBody = (deployments, success = true) => JSON.stringify({ success, errors: [], messages: [], result: { deployments } });
const restFetch = (status, text, seen = []) => async (url, init) => { seen.push({ url, init }); return { status, text: async () => text }; };
const fourKb = Array.from({ length: 12 }, (_, i) => restDeployment(i, [{ version_id: recoveryOld, percentage: 100 }]));

test("REST fallback reads the newest deployment of the right script and returns the wrangler status shape", async () => {
  const text = restBody(fourKb);
  assert.ok(text.length > 3900, `fixture is ${text.length} bytes`);
  const seen = [];
  const status = await restDeploymentStatus("prod", { env: restEnv, config: restConfig, fetcher: restFetch(200, text, seen) });
  assert.equal(seen[0].url, "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/workers/scripts/project-room/deployments");
  assert.equal(seen[0].init.headers.authorization, "Bearer tok");
  assert.deepEqual(allocation(status), { known: true, versions: [{ versionId: recoveryOld, percentage: 100 }], versionId: recoveryOld });
  await restDeploymentStatus("entry", { env: restEnv, config: restConfig, fetcher: restFetch(200, text, seen) });
  assert.match(seen[1].url, /workers\/scripts\/project-room-staging\/deployments$/);
});

test("REST fallback fails closed on every unusable answer", async () => {
  const good = restBody(fourKb);
  const cases = [["HTTP 502", 502, good], ["non-JSON", 200, "<html>504</html>"], ["truncated", 200, good.slice(0, 3000)], ["success false", 200, restBody(fourKb, false)],
    ["no deployments", 200, restBody([])], ["split allocation", 200, restBody([restDeployment(1, [{ version_id: recoveryOld, percentage: 50 }, { version_id: recoveryNew, percentage: 40 }])])],
    ["missing version id", 200, restBody([restDeployment(1, [{ percentage: 100 }])])]];
  for (const [label, status, text] of cases) await assert.rejects(restDeploymentStatus("prod", { env: restEnv, config: restConfig, fetcher: restFetch(status, text) }), /REST/, label);
  await assert.rejects(restDeploymentStatus("prod", { env: { CLOUDFLARE_API_TOKEN: "tok" }, config: restConfig, fetcher: restFetch(200, good) }), /needs CLOUDFLARE_API_TOKEN/);
});

test("deploymentStatus uses REST only after wrangler keeps returning a malformed response", async () => {
  let runs = 0, rests = 0;
  const rest = async () => { rests++; return recoveryAllocation(recoveryOld); };
  assert.deepEqual(await deploymentStatus("prod", () => { runs++; throw malformed(); }, { ...noWait, attempts: 3 }, rest), recoveryAllocation(recoveryOld));
  assert.deepEqual([runs, rests], [3, 1]);
  runs = rests = 0;
  await assert.rejects(deploymentStatus("prod", () => { runs++; throw new Error("Authentication error"); }, noWait, rest), /Authentication/);
  assert.deepEqual([runs, rests], [1, 0], "other failures never fall back");
  runs = rests = 0;
  await assert.rejects(deploymentStatus("prod", () => { runs++; throw malformed(); }, { ...noWait, attempts: 2 }, async () => { throw new Error("Cloudflare deployments REST HTTP 502"); }), /REST HTTP 502/);
});
