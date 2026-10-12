// Schema-aware recovery for deploy-prod. Reading /api/version/worker does not
// open a Durable Object; schemas are parsed from exact Git blobs, never evaluated.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const shaPattern = /^[0-9a-f]{40}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const knownSchema = value => Number.isSafeInteger(value) && value > 0;
const diagnostic = value => {
  let text = String(value ?? '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  // Redact before bounding: truncation must not expose fragments of a known
  // credential. These are diagnostics, never a dump of the child environment.
  for (const [name, secret] of Object.entries(process.env)) {
    if (secret && /TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|API_KEY|SIGNING_KEY|ACCOUNT_ID/i.test(name))
      text = text.split(secret).join('[REDACTED]');
  }
  text = text.replace(/\b(Bearer|Basic)\s+[^\s"']+/gi, '$1 [REDACTED]');
  return text.length <= 4096 ? text : `${text.slice(0, 2048)}\n[diagnostic truncated]\n${text.slice(-2048)}`;
};
export const command = (args, cwd) => {
  const result = spawnSync(args[0], args.slice(1), { cwd, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    const detail = [result.error?.message && `spawn: ${diagnostic(result.error.message)}`,
      result.stderr && `stderr: ${diagnostic(result.stderr)}`, result.stdout && `stdout: ${diagnostic(result.stdout)}`].filter(Boolean).join('\n');
    throw new Error(`${diagnostic(args.join(' '))} failed (${result.status ?? 'spawn'})${detail ? `\n${detail}` : ''}`);
  }
  return result.stdout;
};
export function schemaAt(revision, git = args => command(['git', ...args])) {
  if (!shaPattern.test(revision ?? '')) return null;
  try {
    const text = git(['show', `${revision}:server/writer-fence.mjs`]);
    const matches = [...text.matchAll(/^export const STORE_SCHEMA_VERSION = (\d+);\s*$/gm)];
    if (matches.length !== 1 || !knownSchema(Number(matches[0][1]))) return null;
    return { version: Number(matches[0][1]), revision, path: 'server/writer-fence.mjs', blob: git(['rev-parse', `${revision}:server/writer-fence.mjs`]).trim() };
  } catch { return null; }
}
export function allocation(status) {
  const versions = Array.isArray(status?.versions) ? status.versions : [];
  const seen = new Set();
  const valid = versions.length > 0 && versions.every(row => {
    if (!row || !uuidPattern.test(row.version_id ?? '') || seen.has(row.version_id) ||
        typeof row.percentage !== 'number' || !Number.isFinite(row.percentage) || row.percentage < 0 || row.percentage > 100) return false;
    seen.add(row.version_id);
    return true;
  });
  const rows = versions.filter(row => row && Number(row.percentage) > 0);
  const known = valid && rows.length === 1 && rows[0].percentage === 100;
  return { known, versions: rows.map(row => ({ versionId: row.version_id, percentage: row.percentage })), versionId: known ? rows[0].version_id : null };
}
export function rollbackDecision(previous, candidateSchema) {
  if (!knownSchema(candidateSchema) || previous?.known !== true || !uuidPattern.test(previous.versionId ?? '') || !shaPattern.test(previous.sourceRevision ?? '') || !knownSchema(previous.codeSchemaVersion)) return { eligible: false, reason: 'previous or candidate code schema/source/allocation unknown' };
  if (previous.codeSchemaVersion < candidateSchema) return { eligible: false, reason: `previous code schema ${previous.codeSchemaVersion} cannot read candidate schema ${candidateSchema}` };
  return { eligible: true, reason: 'schema floor satisfied; same-schema data compatibility is not established by this check' };
}
export async function observeWorker({ status, readVersion, schema = schemaAt }) {
  const before = allocation(await status());
  let signal = null, error = null;
  try { signal = await readVersion(); } catch (failure) { error = failure.message; }
  const after = allocation(await status());
  const sourceRevision = signal?.servedBy === 'worker' && signal?.status === 'ok' && shaPattern.test(signal?.sourceRevision ?? '') ? signal.sourceRevision : null;
  const proof = schema(sourceRevision);
  const known = before.known && after.known && before.versionId === after.versionId && !!proof;
  return { known, versionId: before.versionId, sourceRevision, codeSchemaVersion: proof?.version ?? null, schemaSource: proof, allocationBefore: before, allocationAfter: after, error };
}
export async function recoverWorkers(snapshot, attempted, { status, rollback, readVersion }) {
  const workers = {};
  for (const name of ['prod', 'entry']) {
    const previous = snapshot[name];
    const result = workers[name] = { previousVersionId: previous?.versionId ?? null, previousSourceRevision: previous?.sourceRevision ?? null, previousCodeSchemaVersion: previous?.codeSchemaVersion ?? null, candidateCodeSchemaVersion: snapshot.candidateCodeSchemaVersion, disposition: 'unchanged', rollbackAttempted: false };
    if (!attempted[name]) continue;
    try {
      result.observedBefore = allocation(await status(name));
      if (result.observedBefore.known && result.observedBefore.versionId === previous?.versionId) continue;
      const decision = rollbackDecision(previous, snapshot.candidateCodeSchemaVersion);
      result.reason = decision.reason;
      if (!decision.eligible) { result.disposition = 'roll_forward_required'; continue; }
      result.rollbackAttempted = true;
      await rollback(name, previous.versionId);
      result.observedAfter = allocation(await status(name));
      const signal = await readVersion(name);
      if (!result.observedAfter.known || result.observedAfter.versionId !== previous.versionId || signal?.status !== 'ok' || signal?.servedBy !== 'worker' || signal?.sourceRevision !== previous.sourceRevision) throw new Error('rollback command completed but version/source readback is not verified');
      result.disposition = 'rollback_verified';
    } catch (failure) {
      result.disposition = result.rollbackAttempted ? 'rollback_unverified' : 'roll_forward_required';
      result.reason = failure.message;
    }
  }
  const rows = Object.values(workers);
  const statusValue = rows.some(row => row.disposition === 'roll_forward_required') ? 'ROLL FORWARD REQUIRED' : rows.some(row => row.disposition === 'rollback_unverified') ? 'ROLLBACK NOT VERIFIED' : rows.some(row => row.disposition === 'rollback_verified') ? 'ROLLBACK VERIFIED' : 'NO DEPLOYMENT CHANGE OBSERVED';
  return { status: statusValue, targetSha: snapshot.targetSha, candidateCodeSchemaVersion: snapshot.candidateCodeSchemaVersion, compatibilityLimit: 'Code-schema floor only; this does not prove prior code understands new rows, semantics or retained runtime.', recordedAt: new Date().toISOString(), workers };
}
export function recoveryDescription(report) {
  if (!report) return 'Recovery not attempted or report unavailable; no rollback is claimed.';
  return `${report.status} · ${Object.entries(report.workers).map(([name, row]) => `${name}: ${row.disposition} (previous schema ${row.previousCodeSchemaVersion ?? 'unknown'}, candidate schema ${row.candidateCodeSchemaVersion ?? 'unknown'}, target ${row.previousVersionId ?? 'unknown'})${row.reason ? `: ${row.reason}` : ''}`).join(' · ')}`;
}
const workerUrl = origin => `${origin.replace(/\/+$/, '')}/api/version/worker`;
export async function readVersion(origin) {
  const response = await fetch(workerUrl(origin), { redirect: 'error', headers: { 'user-agent': 'Mozilla/5.0 project-room-schema-recovery', accept: 'application/json', 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(15000) });
  if (response.status !== 200) throw new Error(`Worker version HTTP ${response.status}`);
  return response.json();
}
// Cloudflare's API sometimes answers a read with HTTP 200 and a body wrangler
// cannot parse ("Received a malformed response from the API"). That is a
// transient read failure, not a statement about the deployment, so retry it a
// few times with backoff. Any other failure, an empty or non-JSON result, and
// exhausting the attempts all still fail closed: nothing is deployed on a guess.
export const transientApiFailure = message => /malformed response from the API|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|HTTP 5\d\d/i.test(String(message ?? ''));
export async function withApiRetry(read, { attempts = 5, delayMs = 2000, sleep = ms => new Promise(done => setTimeout(done, ms)), log = message => console.error(message) } = {}) {
  let failure;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { return await read(); } catch (error) {
      failure = error;
      if (attempt === attempts || !transientApiFailure(error?.message)) break;
      const wait = delayMs * 2 ** (attempt - 1);
      log(`Cloudflare API read failed (attempt ${attempt}/${attempts}); retrying in ${wait}ms: ${String(error.message).split('\n')[0]}`);
      await sleep(wait);
    }
  }
  throw failure;
}
export function parseDeploymentStatus(text) {
  const start = String(text ?? '').indexOf('{');
  if (start < 0) throw new Error('wrangler deployments status printed no JSON object');
  try { return JSON.parse(text.slice(start)); } catch { throw new Error('wrangler deployments status printed unparseable JSON'); }
}
// Fallback when wrangler keeps rejecting the deployments response: read the same
// endpoint wrangler reads (GET .../workers/scripts/<name>/deployments, newest
// first, wrangler takes deployments[0]) with the CI token and parse it strictly.
// The result has the shape `wrangler deployments status --json` prints.
const workerScriptName = (name, config = JSON.parse(readFileSync('cloudflare/wrangler.jsonc', 'utf8'))) => {
  const script = name === 'prod' ? config?.env?.production?.name : config?.name;
  if (typeof script !== 'string' || !/^[A-Za-z0-9_-]+$/.test(script)) throw new Error(`no Worker script name for ${name} in cloudflare/wrangler.jsonc`);
  return script;
};
export async function restDeploymentStatus(name, { env = process.env, fetcher = fetch, config } = {}) {
  const token = env.CLOUDFLARE_API_TOKEN, account = env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !/^[0-9a-f]{32}$/i.test(account ?? '')) throw new Error('REST deployment fallback needs CLOUDFLARE_API_TOKEN and a 32-hex CLOUDFLARE_ACCOUNT_ID');
  const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${workerScriptName(name, config)}/deployments`, { redirect: 'error', headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (response.status !== 200) throw new Error(`Cloudflare deployments REST HTTP ${response.status}`);
  let body;
  try { body = JSON.parse(await response.text()); } catch { throw new Error('Cloudflare deployments REST returned unparseable JSON'); }
  const latest = body?.success === true && Array.isArray(body?.result?.deployments) ? body.result.deployments[0] : null;
  if (!latest || !Array.isArray(latest.versions)) throw new Error('Cloudflare deployments REST reported no usable latest deployment');
  const total = latest.versions.reduce((sum, row) => sum + Number(row?.percentage), 0);
  if (latest.versions.some(row => typeof row?.version_id !== 'string') || total !== 100) throw new Error('Cloudflare deployments REST latest deployment does not allocate exactly 100%');
  return latest;
}
export async function deploymentStatus(name, run = command, retry = {}, rest = restDeploymentStatus) {
  try {
    return await withApiRetry(async () => parseDeploymentStatus(run(['pnpm', 'exec', 'wrangler', 'deployments', 'status', ...(name === 'prod' ? ['--env', 'production'] : []), '--json'], 'cloudflare')), retry);
  } catch (failure) {
    if (!/malformed response from the API/i.test(failure?.message ?? '')) throw failure;
    (retry.log ?? console.error)('wrangler cannot parse the deployments response; reading it over the REST API instead');
    return rest(name);
  }
}
async function main() {
  const [mode, path, output] = process.argv.slice(2);
  if (mode === 'snapshot') {
    const revision = process.env.SHA;
    if (command(['git', 'rev-parse', 'HEAD']).trim() !== revision) throw new Error('checkout does not match requested deployment revision');
    const proof = schemaAt(revision);
    if (!proof) throw new Error('candidate code schema is unknown; nothing deployed');
    const report = { targetSha: revision, candidateCodeSchemaVersion: proof.version, candidateSchemaSource: proof, recordedAt: new Date().toISOString() };
    for (const name of ['prod', 'entry']) {
      report[name] = await observeWorker({ status: () => deploymentStatus(name), readVersion: () => readVersion(name === 'prod' ? process.env.PROD_ORIGIN : process.env.ENTRY_ORIGIN) });
      report[name].automaticRollback = rollbackDecision(report[name], proof.version);
    }
    report.run = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null;
    // A split/unknown allocation has no exact rollback target; refuse before upload.
    if (!report.prod.versionId || !report.entry.versionId || report.prod.versionId !== report.prod.allocationAfter.versionId || report.entry.versionId !== report.entry.allocationAfter.versionId) throw new Error('exact previous 100% deployment version is unknown; nothing deployed');
    report.liveSourceRevisionBefore = report.prod.sourceRevision;
    report.prodRollbackVersionId = report.prod.versionId; report.entryRollbackVersionId = report.entry.versionId;
    writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `prod=${report.prod.versionId}\nentry=${report.entry.versionId}\n`);
    console.log(JSON.stringify(report));
  } else if (mode === 'recover') {
    const snapshot = JSON.parse(readFileSync(path, 'utf8'));
    const attempted = { prod: !['', undefined, 'skipped'].includes(process.env.PROD_OUTCOME), entry: !['', undefined, 'skipped'].includes(process.env.ENTRY_OUTCOME) };
    const report = await recoverWorkers(snapshot, attempted, { status: deploymentStatus, readVersion: name => readVersion(name === 'prod' ? process.env.PROD_ORIGIN : process.env.ENTRY_ORIGIN), rollback: async (name, id) => command(['pnpm', 'exec', 'wrangler', 'rollback', id, ...(name === 'prod' ? ['--env', 'production'] : []), '--message', `deploy-prod run ${process.env.GITHUB_RUN_ID} failed for ${snapshot.targetSha}`, '--yes'], 'cloudflare') });
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(recoveryDescription(report));
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${recoveryDescription(report)}\n\n${report.compatibilityLimit}\n`);
    process.exitCode = ['ROLL FORWARD REQUIRED', 'ROLLBACK NOT VERIFIED'].includes(report.status) ? 1 : 0;
  } else throw new Error('Usage: deploy-recovery.mjs snapshot <output> | recover <pre-deploy> <output>');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
