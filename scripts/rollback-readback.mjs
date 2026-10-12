#!/usr/bin/env node
// Verify a rollback using fresh `wrangler deployments status --json` records.
// stdin / --status-file: {prod: <production status>, entry: <entry status>}.
// A single raw status is also accepted when only --prod-id is requested.
// No deployment or credentials: this CLI only validates records and GETs both
// doors. --preflight binds both Worker stamps and the shared Durable Object's
// public source readback to admitted targets. It does not establish data restore.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const report = { ok: false, prod: null, entry: null, doors: {}, errors: [] };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function allocation(name, status, expected) {
  if (!Array.isArray(status?.versions) || status.versions.length === 0) {
    throw new Error(`${name}: missing or empty versions`);
  }
  const seen = new Set();
  for (const row of status.versions) {
    if (!row || typeof row.version_id !== "string" || !row.version_id || seen.has(row.version_id)) {
      throw new Error(`${name}: invalid or duplicate version id`);
    }
    seen.add(row.version_id);
    if (typeof row.percentage !== "number" || !Number.isFinite(row.percentage) || row.percentage < 0 || row.percentage > 100) {
      throw new Error(`${name}: invalid traffic percentage`);
    }
  }
  const expectedRow = status.versions.find(row => row.version_id === expected);
  if (!expectedRow) throw new Error(`${name}: expected version ${expected} is not deployed`);
  if (expectedRow.percentage !== 100 || status.versions.some(row => row !== expectedRow && row.percentage !== 0)) {
    throw new Error(`${name}: expected version ${expected} must receive 100% of traffic exclusively`);
  }
  return { version: expected, percentage: expectedRow.percentage, verified: true };
}
function doorUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("door URL must be an HTTP(S) origin/path without credentials, query or fragment");
  }
  return `${url.href.replace(/\/+$/, "")}/api/version`;
}
async function readDoor(name, url, expected, worker = false) {
  const result = { status: 0, sourceRevision: null };
  report.doors[name] = result;
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "Mozilla/5.0 project-room-rollback-readback" },
      redirect: "error", signal: AbortSignal.timeout(15000),
    });
    result.status = res.status;
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (typeof body?.sourceRevision !== "string" || !/^[0-9a-f]{40}$/.test(body.sourceRevision)) {
      throw new Error("missing or invalid sourceRevision");
    }
    result.sourceRevision = body.sourceRevision;
    if (expected && body.sourceRevision !== expected) throw new Error('sourceRevision differs from preflight target');
    if (worker && (body.status !== 'ok' || body.servedBy !== 'worker')) throw new Error('not a verified Worker version response');
  } catch (error) {
    report.errors.push(`${name} /api/version: ${error.message}`);
  }
}
try {
  const { values } = parseArgs({ options: {
    "prod-id": { type: "string" }, "entry-id": { type: "string" },
    origin: { type: "string", default: "https://room.trydemigod.com" },
    entry: { type: "string", default: "https://www.getdasha.com/room" },
    "status-file": { type: "string" },
    preflight: { type: "string" },
  } });
  if (!uuid.test(values["prod-id"] ?? "")) throw new Error("--prod-id must be a version UUID");
  if (values["entry-id"] && !uuid.test(values["entry-id"])) throw new Error("--entry-id must be a version UUID");
  const originUrl = doorUrl(values.origin), entryUrl = doorUrl(values.entry);
  let recorded;
  try { recorded = JSON.parse(readFileSync(values["status-file"] ?? 0, "utf8")); }
  catch { throw new Error("deployment status is unreadable or unparseable JSON"); }
  if (recorded?.versions) recorded = { prod: recorded };
  let preflight;
  if (values.preflight) {
    preflight = JSON.parse(readFileSync(values.preflight, 'utf8'));
    if (preflight.format !== 1 || preflight.targets?.prod?.versionId !== values['prod-id'] ||
        (preflight.targets?.entry?.versionId ?? '') !== (values['entry-id'] ?? '') ||
        ![preflight.targets?.prod?.sourceRevision, (preflight.targets?.entry ?? preflight.current?.entry)?.sourceRevision].every(value => /^[0-9a-f]{40}$/.test(value ?? '')))
      throw new Error('preflight source/target receipt missing or mismatched');
  }
  report.prod = allocation("prod", recorded?.prod, values["prod-id"]);
  report.entry = values["entry-id"]
    ? allocation("entry", recorded?.entry, values["entry-id"])
    : { version: null, percentage: null, verified: false, unchanged: true };
  // /api/version on both doors is served by the canonical Durable Object;
  // /api/version/worker identifies each independent edge bundle.
  const expected = preflight?.targets.prod.sourceRevision;
  const reads = [readDoor("origin", originUrl, expected), readDoor("entry", entryUrl, expected)];
  if (preflight) reads.push(
    readDoor('originWorker', `${originUrl}/worker`, expected, true),
    readDoor('entryWorker', `${entryUrl}/worker`, (preflight.targets.entry ?? preflight.current.entry).sourceRevision, true)
  );
  await Promise.all(reads);
  report.ok = report.errors.length === 0;
} catch (error) {
  report.errors.push(error.message);
}
console.log(JSON.stringify(report));
process.exitCode = report.ok ? 0 : 1;
