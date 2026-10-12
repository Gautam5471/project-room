import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { generateKeyPair, signCard, signCardJws } from "../server/agent-card-signing.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = join(root, "scripts/rollback-readback.mjs");
const prodId = "11111111-1111-1111-1111-111111111111";
const entryId = "22222222-2222-2222-2222-222222222222";
const otherId = "33333333-3333-3333-3333-333333333333";
const revision = "a".repeat(40);
const status = (id, percentage = 100) => ({ id: "deployment", source: "rollback", versions: [{ version_id: id, percentage }] });
const statuses = () => ({ prod: status(prodId), entry: status(entryId) });
// The rollback workflow's post-rollback shell runs the real
// prod-deploy-smoke.mjs, which now asserts the agent card on both doors.
// The fixture serves a signed card and the workflow env injects the matching
// test key through the smoke's SMOKE_AGENT_CARD_* seams (the suite cannot
// sign for the production pinned key).
const cardKeyPair = generateKeyPair();
const cardKeyId = "test-card-key-rollback";
const cardAgentId = "project-room";
const buildFixtureCard = () => {
  const card = { name: "Test Room", description: "rollback-readback fixture", url: null,
    capabilities: { streaming: false }, skills: [], version: "1" };
  const signature = signCard({ agentId: cardAgentId, card, privateKey: cardKeyPair.privateKey });
  const withEnvelope = { ...card, keyId: cardKeyId, signatureAgentId: cardAgentId,
    publicKey: cardKeyPair.publicKey, cardSignature: signature, signedRevision: revision };
  withEnvelope.signatures = [signCardJws({ card: withEnvelope, privateKey: cardKeyPair.privateKey,
    keyId: cardKeyId, jku: "https://example.test/.well-known/jwks.json" })];
  return withEnvelope;
};
const fixtureCard = buildFixtureCard();
function directory(t) {
  const path = mkdtempSync(join(tmpdir(), "rollback-readback-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
async function doors(t, failure) {
  const requests = [], receipts = [];
  const server = createServer(async (req, res) => {
    requests.push(req.url);
    if (req.method === "POST" && req.url === "/canonical/api/rooms/local-room/commands") {
      let body = "";
      for await (const part of req) body += part;
      receipts.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    const match = req.url.match(/^\/(canonical|room)(\/api\/(version(?:\/worker)?|health|ready)|\/terms|\/privacy|\/|\/\.well-known\/agent-card\.json)$/);
    if (req.method !== "GET" || !match) return res.writeHead(404).end("Unexpected request");
    if (match[2] === "/.well-known/agent-card.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(fixtureCard));
      return;
    }
    let body = { sourceRevision: revision }, code = 200;
    if (match[3] === 'version/worker') body = { ...body, status: 'ok', servedBy: 'worker' };
    if (match[3] === "health") body = { status: "ok" };
    if (match[3] === "ready") body = { status: "ready" };
    if (!match[3]) body = "<!doctype html><title>Room</title>";
    if (failure && match[1] === failure.door && match[3] === (failure.worker ? 'version/worker' : 'version')) {
      code = failure.status ?? 200;
      body = failure.body ?? body;
    }
    res.writeHead(code, { "content-type": typeof body === "string" ? "text/html" : "application/json" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { origin: `${base}/canonical`, entry: `${base}/room`, requests, receipts };
}
function run(command, args, options = {}, input = "") {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { timeout: 20000, ...options }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") return reject(error);
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
    child.stdin.on("error", error => { if (error.code !== "EPIPE") reject(error); });
    child.stdin.end(input);
  });
}
async function cli(t, recorded, { failure, withoutEntry = false, file = false, preflight } = {}) {
  const http = await doors(t, failure);
  const args = [script, "--prod-id", prodId, "--origin", `${http.origin}/`, "--entry", `${http.entry}/`];
  if (!withoutEntry) args.push("--entry-id", entryId);
  if (preflight) {
    const path = join(directory(t), 'preflight.json');
    writeFileSync(path, JSON.stringify(preflight)); args.push('--preflight', path);
  }
  const input = typeof recorded === "string" ? recorded : JSON.stringify(recorded);
  if (file) {
    const path = join(directory(t), "status.json");
    writeFileSync(path, input);
    args.push("--status-file", path);
  }
  const result = await run(process.execPath, args, {}, file ? "" : input);
  assert.equal(result.stdout.trim().split("\n").length, 1, "one machine-readable receipt");
  return { ...result, report: JSON.parse(result.stdout), http };
}

for (const file of [false, true]) {
  test(`CLI verifies both allocations and both door revisions from ${file ? "file" : "stdin"}`, async t => {
    const { code, report, http } = await cli(t, statuses(), { file });
    assert.equal(code, 0);
    assert.equal(report.ok, true);
    assert.deepEqual(report.prod, { version: prodId, percentage: 100, verified: true });
    assert.deepEqual(report.entry, { version: entryId, percentage: 100, verified: true });
    assert.deepEqual(report.doors, { origin: { status: 200, sourceRevision: revision }, entry: { status: 200, sourceRevision: revision } });
    assert.deepEqual(http.requests.toSorted(), ["/canonical/api/version", "/room/api/version"]);
  });
}
for (const worker of ["prod", "entry"]) {
  const cases = [
    ["90/10 split", { versions: [{ version_id: worker === "prod" ? prodId : entryId, percentage: 90 }, { version_id: otherId, percentage: 10 }] }, /100%/],
    ["wrong version", status(otherId), /expected/],
    ["empty versions", { versions: [] }, /versions/],
    ["contradictory allocation", { versions: [{ version_id: worker === "prod" ? prodId : entryId, percentage: 100 }, { version_id: otherId, percentage: 10 }] }, /100%/],
    ["string percentage", status(worker === "prod" ? prodId : entryId, "100"), /percentage/],
  ];
  for (const [label, value, error] of cases) test(`CLI rejects ${worker} ${label} before reading doors`, async t => {
    const recorded = statuses(); recorded[worker] = value;
    const { code, report, http } = await cli(t, recorded);
    assert.equal(code, 1);
    assert.equal(report.ok, false);
    assert.match(report.errors.join(" "), error);
    assert.match(report.errors.join(" "), new RegExp(worker));
    assert.deepEqual(http.requests, []);
  });
}
for (const recorded of ["not JSON", "", "null", "{}", JSON.stringify({ prod: status(prodId) })]) {
  test(`CLI fails closed for missing/unparseable status ${JSON.stringify(recorded)}`, async t => {
    const { code, report, http } = await cli(t, recorded);
    assert.equal(code, 1);
    assert.equal(report.ok, false);
    assert.ok(report.errors.length > 0);
    assert.deepEqual(http.requests, []);
  });
}
for (const door of ["canonical", "room"]) {
  for (const failure of [{ status: 503 }, { body: "not JSON" }, { body: {} }]) {
    test(`CLI rejects ${door} version response ${JSON.stringify(failure)}`, async t => {
      const { code, report, http } = await cli(t, statuses(), { failure: { door, ...failure } });
      assert.equal(code, 1);
      assert.equal(report.ok, false);
      assert.match(report.errors.join(" "), new RegExp(door === "canonical" ? "origin" : "entry"));
      assert.deepEqual(http.requests.toSorted(), ["/canonical/api/version", "/room/api/version"]);
    });
  }
}
test("omitting the entry target records unchanged / not verified, but still reads both doors", async t => {
  const { code, report, http } = await cli(t, { prod: status(prodId) }, { withoutEntry: true });
  assert.equal(code, 0);
  assert.deepEqual(report.entry, { version: null, percentage: null, verified: false, unchanged: true });
  assert.deepEqual(http.requests.toSorted(), ["/canonical/api/version", "/room/api/version"]);
});

// Distinct release-wiring contract: execute the actual post-rollback shell with
// strict Wrangler fixtures. No rollback/deploy commands or production HTTP run.
async function workflow(t, { recorded = statuses(), commandFailure = false, failure, withoutEntry = false } = {}) {
  const work = directory(t), http = await doors(t, failure);
  writeFileSync(join(work, 'rollback-preflight.json'), JSON.stringify({ format: 1,
    targets: { prod: { versionId: prodId, sourceRevision: revision }, entry: withoutEntry ? null : { versionId: entryId, sourceRevision: revision } },
    current: { entry: { versionId: otherId, sourceRevision: revision } } }));
  writeFileSync(join(work, "pnpm"), `#!/usr/bin/env node
const args = process.argv.slice(2);
const production = ["exec", "wrangler", "deployments", "status", "--env", "production", "--json"];
const entry = ["exec", "wrangler", "deployments", "status", "--json"];
const same = expected => JSON.stringify(expected) === JSON.stringify(args);
if (!same(production) && !same(entry)) { console.error("Unexpected Wrangler command", args); process.exit(98); }
if (same(entry) && !process.env.ENTRY_ID) { console.error("Entry allocation must not be queried without a rollback target"); process.exit(96); }
if (process.env.COMMAND_FAILURE === "true") process.exit(17);
const recorded = JSON.parse(process.env.RECORDED_STATUS);
console.log(JSON.stringify(same(production) ? recorded.prod : recorded.entry));
`, { mode: 0o755 });
  writeFileSync(join(work, "sleep"), "#!/bin/bash\n[[ $# == 1 && $1 == 15 ]] || exit 98\n", { mode: 0o755 });
  const env = { ...process.env, PATH: `${work}:${process.env.PATH}`, RUNNER_TEMP: work,
    PROD_ID: prodId, ENTRY_ID: withoutEntry ? "" : entryId, PROD_ORIGIN: http.origin, ENTRY_ORIGIN: http.entry,
    RECORDED_STATUS: JSON.stringify(recorded), COMMAND_FAILURE: String(commandFailure), GITHUB_STEP_SUMMARY: join(work, "summary"),
    CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "",
    // The rollback shell runs the literal prod-deploy-smoke step, so the
    // card-check test seams arrive through the env fallbacks. One fetch per
    // door keeps the smoke inside this suite's 20s CLI timeout.
    SMOKE_AGENT_CARD_PUBLIC_KEY: cardKeyPair.publicKey,
    SMOKE_AGENT_CARD_KEY_ID: cardKeyId,
    SMOKE_AGENT_CARD_AGENT_ID: cardAgentId,
    SMOKE_AGENT_CARD_FETCHES: "1" };
  const job = parse(readFileSync(join(root, ".github/workflows/rollback-prod.yml"), "utf8")).jobs.rollback;
  const start = job.steps.findIndex(step => step.name === "Roll back") + 1;
  const end = job.steps.findIndex(step => step.name === "Receipt to muse-room");
  assert.ok(start > 0 && end >= start, "known post-rollback boundary");
  let result = { code: 0 }, readbackOutcome = "skipped";
  for (const step of job.steps.slice(start, end).filter(step => step.run)) {
    const flags = step.shell === "bash" ? ["--noprofile", "--norc", "-e", "-o", "pipefail"] : ["-e"];
    result = await run("bash", [...flags, "-c", step.run], { env, cwd: join(root, step["working-directory"] ?? "") });
    if (step.id === "readback") readbackOutcome = result.code === 0 ? "success" : "failure";
    if (result.code !== 0) break;
  }
  const receipt = await run("bash", ["-e", "-c", job.steps[end].run], { cwd: root, env: { ...env,
    ROOM_RECEIPT_TOKEN: "synthetic-local-token", RECEIPT_ROOM: "local-room", OUTCOME: result.code === 0 ? "success" : "failure",
    READBACK_OUTCOME: readbackOutcome, PREFLIGHT_OUTCOME: 'success', REASON: "local rollback verification test", RUN_URL: "https://example.invalid/run/1" } });
  assert.equal(receipt.code, 0, receipt.stderr);
  return { ...result, work, http };
}
test("workflow rejects 90/10 production traffic instead of reporting rollback success", async t => {
  const recorded = statuses(); recorded.prod.versions[0].percentage = 90;
  recorded.prod.versions.push({ version_id: otherId, percentage: 10 });
  const result = await workflow(t, { recorded });
  assert.equal(result.code, 1, "post-rollback workflow must reject a partial rollback");
  assert.match(result.http.receipts[0].data.body, /readback not verified/);
});
test("workflow publishes verified allocations and both revisions in the receipt", async t => {
  const result = await workflow(t);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(readFileSync(join(result.work, "rollback-readback.json"), "utf8"));
  assert.equal(report.ok, true);
  assert.match(result.http.receipts[0].data.body, /verified readback/);
  assert.ok(result.http.receipts[0].data.body.includes(JSON.stringify(report)));
});
test("workflow preserves a failed Wrangler read, without a verified receipt", async t => {
  const result = await workflow(t, { commandFailure: true });
  assert.notEqual(result.code, 0, "Wrangler failure must survive shell pipelines");
  assert.match(result.http.receipts[0].data.body, /readback not verified/);
});
for (const door of ["canonical", "room"]) test(`workflow preserves ${door} HTTP 503 through tee`, async t => {
  const result = await workflow(t, { failure: { door, status: 503 } });
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(readFileSync(join(result.work, "rollback-readback.json"), "utf8")).ok, false);
  assert.match(result.http.receipts[0].data.body, /readback not verified/);
});
test("workflow with no entry rollback says unchanged and does not claim entry allocation verification", async t => {
  const result = await workflow(t, { withoutEntry: true });
  assert.equal(result.code, 0, result.stderr);
  const body = result.http.receipts[0].data.body;
  assert.match(body, /entry unchanged/);
  const report = JSON.parse(readFileSync(join(result.work, "rollback-readback.json"), "utf8"));
  assert.equal(report.entry.verified, false);
  assert.equal(report.entry.unchanged, true);
});

for (const door of ['canonical', 'room']) for (const worker of [false, true]) {
  test(`workflow refuses ${door} ${worker ? 'Worker' : 'Durable Object'} source mismatch after successful allocation`, async t => {
    const result = await workflow(t, { failure: { door, worker, body: { status: 'ok', servedBy: 'worker', sourceRevision: 'b'.repeat(40) } } });
    assert.equal(result.code, 1);
    const report = JSON.parse(readFileSync(join(result.work, 'rollback-readback.json'), 'utf8'));
    assert.equal(report.ok, false);
    assert.match(report.errors.join(' '), /sourceRevision differs from preflight target/);
    assert.match(result.http.receipts[0].data.body, /readback not verified/);
    assert.ok(!result.http.requests.some(path => path.endsWith('/api/health')), 'failed readback cannot proceed to smoke');
  });
}
test('readback refuses a mismatched preflight target before reading any door', async t => {
  const { code, report, http } = await cli(t, statuses(), { preflight: { format: 1,
    targets: { prod: { versionId: otherId, sourceRevision: revision }, entry: { versionId: entryId, sourceRevision: revision } } } });
  assert.equal(code, 1); assert.equal(report.ok, false);
  assert.match(report.errors.join(' '), /preflight source\/target receipt missing or mismatched/);
  assert.deepEqual(http.requests, []);
});
