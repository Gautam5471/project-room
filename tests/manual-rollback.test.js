import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const job = parse(readFileSync(join(root, '.github/workflows/rollback-prod.yml'), 'utf8')).jobs.rollback;
const prodCurrent = '11111111-1111-4111-8111-111111111111';
const entryCurrent = '22222222-2222-4222-8222-222222222222';
const prodTarget = '33333333-3333-4333-8333-333333333333';
const entryTarget = '44444444-4444-4444-8444-444444444444';
const another = '55555555-5555-4555-8555-555555555555';
const account = 'a'.repeat(32);
const allocation = id => ({ versions: [{ version_id: id, percentage: 100 }] });
const stamp = (revision, schema) => `var SOURCE_REVISION = "${revision}";\nvar STORE_SCHEMA_VERSION = ${schema};\nthrow new Error('historical code must never execute');\n`;
const moduleVersion = (id, source) => ({ id, main_module: 'room.js', modules: [{ name: 'room.js', content_type: 'application/javascript+module', content_base64: Buffer.from(source).toString('base64') }] });
const check = () => ({ result: 'passed', evidence: 'https://github.com/Uuriko/project-room/actions/runs/123/attempts/1' });

async function fixture(t, { currentSchema = 38, targetSchema = 38, withoutEntry = false, restFallback = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'manual-rollback-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ['server', 'cloudflare', 'bin']) mkdirSync(join(dir, name));
  // Keep command source local to the fixture but execute the actual repository
  // helper and actual workflow shell; every external operation is a strict fake.
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  writeFileSync(join(dir, 'cloudflare/wrangler.jsonc'), JSON.stringify({ name: 'project-room-staging', env: { production: { name: 'project-room' } } }));
  const git = async args => (await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: dir })).stdout.trim();
  await git(['init', '--quiet']);
  writeFileSync(join(dir, 'server/writer-fence.mjs'), `export const STORE_SCHEMA_VERSION = ${targetSchema};\n`);
  await git(['add', '.']); await git(['commit', '--quiet', '-m', 'target']);
  const oldSha = await git(['rev-parse', 'HEAD']);
  writeFileSync(join(dir, 'server/writer-fence.mjs'), `export const STORE_SCHEMA_VERSION = ${currentSchema};\n// current source\n`);
  await git(['add', '.']); await git(['commit', '--quiet', '-m', 'current']);
  const currentSha = await git(['rev-parse', 'HEAD']);
  const evidence = { format: 1,
    current: { prod: { versionId: prodCurrent, sourceRevision: currentSha }, entry: { versionId: entryCurrent, sourceRevision: currentSha } },
    targets: { prod: { versionId: prodTarget, sourceRevision: oldSha }, entry: withoutEntry ? null : { versionId: entryTarget, sourceRevision: oldSha } },
    checks: { oldCodeNewData: check(), retainedRuntime: check(), workerBindings: check() }
  };
  const state = { current: { prod: allocation(prodCurrent), entry: allocation(entryCurrent) },
    signals: { prod: { status: 'ok', servedBy: 'worker', sourceRevision: currentSha }, entry: { status: 'ok', servedBy: 'worker', sourceRevision: currentSha } },
    targets: { prod: moduleVersion(prodTarget, stamp(oldSha, targetSchema)), entry: moduleVersion(entryTarget, stamp(oldSha, targetSchema)) },
    rolled: [], statusCalls: {}, restFallback };
  const save = () => writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  save();
  const commitEvidence = async () => { writeFileSync(join(dir, 'qualification.json'), JSON.stringify(evidence)); await git(['add', 'qualification.json']); await git(['commit', '--quiet', '--allow-empty', '-m', 'qualification']); };
  await commitEvidence();
  writeFileSync(join(dir, 'bin/pnpm'), `#!/usr/bin/env node
const fs=require('node:fs'),a=process.argv.slice(2),p=process.env.FIXTURE_STATE,s=JSON.parse(fs.readFileSync(p));
const name=a.includes('production')?'prod':'entry';
const is=expected=>JSON.stringify(a)===JSON.stringify(expected);
fs.appendFileSync(process.env.COMMAND_LOG,JSON.stringify(a)+'\\n');
if(is(['exec','wrangler','whoami','--json'])) { console.log(JSON.stringify({loggedIn:true,accounts:[{id:'${account}'}]})); process.exit(0); }
if(is(['exec','wrangler','deployments','status',...(name==='prod'?['--env','production']:[]),'--json'])) {
  if(s.restFallback) { console.error('Received a malformed response from the API'); process.exit(1); }
  s.statusCalls[name]=(s.statusCalls[name]??0)+1;
  if(s.race && name===s.race.name && s.statusCalls[name]>=s.race.after) s.current[name]={versions:[{version_id:'${another}',percentage:100}]};
  fs.writeFileSync(p,JSON.stringify(s)); console.log(JSON.stringify(s.current[name])); process.exit(0);
}
const id=name==='prod'?process.env.PROD_ID:process.env.ENTRY_ID;
if(is(['exec','wrangler','rollback',id,...(name==='prod'?['--env','production']:[]),'--message','rollback-prod run 1: synthetic test','--yes'])) {
  s.rolled.push(name); s.current[name]={versions:[{version_id:id,percentage:100}]}; fs.writeFileSync(p,JSON.stringify(s)); process.exit(s.rollbackFailure?17:0);
}
console.error('Unexpected command'); process.exit(98);
`, { mode: 0o755 });
  writeFileSync(join(dir, 'network.mjs'), `import {readFileSync,appendFileSync} from 'node:fs';
// Accelerate only the known retry backoffs in this isolated fixture. Their
// attempt count and real doubling schedule have coverage in deploy-checks.
const realTimeout=globalThis.setTimeout;
globalThis.setTimeout=(callback,delay,...args)=>realTimeout(callback,[2000,4000,8000,16000].includes(delay)?0:delay,...args);
globalThis.fetch=async(url,options={})=>{
  const s=JSON.parse(readFileSync(process.env.FIXTURE_STATE));
  appendFileSync(process.env.FETCH_LOG,String(url)+'\\n');
  if(options.method && options.method!=='GET') throw new Error('Unexpected method');
  const u=new URL(url);
  if(u.hostname==='api.cloudflare.com') {
    if(options.redirect!=='error'||options.headers.authorization!=='Bearer synthetic-token') throw new Error('Unsafe version read');
    const deploymentPaths={prod:'/client/v4/accounts/${account}/workers/scripts/project-room/deployments',entry:'/client/v4/accounts/${account}/workers/scripts/project-room-staging/deployments'};
    const deployment=Object.keys(deploymentPaths).find(name=>u.pathname===deploymentPaths[name]);
    if(deployment && !u.search && s.restFallback) return Response.json({success:true,result:{deployments:[s.current[deployment]]}});
    const match=u.pathname.match(/^\\/client\\/v4\\/accounts\\/${account}\\/workers\\/workers\\/(project-room|project-room-staging)\\/versions\\/([a-f0-9-]+)$/);
    if(!match||u.search!=='?include=modules') throw new Error('Unexpected Cloudflare request');
    const name=match[1]==='project-room'?'prod':'entry';
    if(match[2]!==process.env[name==='prod'?'PROD_ID':'ENTRY_ID']) throw new Error('Wrong target');
    if(s.apiFailure) return new Response(s.apiFailure.body??'{}',{status:s.apiFailure.status??200});
    return Response.json({success:true,result:s.targets[name]});
  }
  if(u.origin==='https://rollback-fixture.invalid' && ['/prod/api/version/worker','/entry/api/version/worker'].includes(u.pathname)) {
    if(options.headers.authorization) throw new Error('Credential sent to public probe');
    return Response.json(s.signals[u.pathname.startsWith('/prod/')?'prod':'entry']);
  }
  throw new Error('Network forbidden outside exact synthetic fixture');
};
`);
  const env = { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, NODE_OPTIONS: `--import=${pathToFileURL(join(dir, 'network.mjs')).href}`,
    FIXTURE_STATE: join(dir, 'state.json'), COMMAND_LOG: join(dir, 'commands.log'), FETCH_LOG: join(dir, 'fetch.log'),
    CLOUDFLARE_API_TOKEN: 'synthetic-token', CLOUDFLARE_ACCOUNT_ID: account, PROD_ID: prodTarget, ENTRY_ID: withoutEntry ? '' : entryTarget,
    PROD_ORIGIN: 'https://rollback-fixture.invalid/prod', ENTRY_ORIGIN: 'https://rollback-fixture.invalid/entry', COMPATIBILITY_FILE: 'qualification.json',
    COMPATIBILITY_REVIEWED: 'true', GITHUB_ACTOR: 'synthetic-reviewer',
    RUNNER_TEMP: dir, GITHUB_OUTPUT: join(dir, 'outputs'), GITHUB_RUN_ID: '1', REASON: 'synthetic test' };
  delete env.GITHUB_STEP_SUMMARY;
  // Replace only the helper location, leaving actual workflow command arguments
  // and shell failure behavior intact. The helper's cwd is the synthetic Git repo.
  const run = async step => {
    const shell = step.run.replaceAll('node scripts/manual-rollback.mjs', `node ${JSON.stringify(join(root, 'scripts/manual-rollback.mjs'))}`);
    try { return { code: 0, ...await exec('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', shell], { cwd: dir, env, timeout: 20000 }) }; }
    catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  };
  const preStep = job.steps.find(step => step.id === 'pre'), rollbackStep = job.steps.find(step => step.name === 'Roll back');
  assert.ok(preStep && rollbackStep && job.steps.indexOf(preStep) < job.steps.indexOf(rollbackStep));
  return { dir, env, state, save, evidence, commitEvidence, oldSha, currentSha,
    preflight: () => run(preStep), execute: () => run(rollbackStep),
    attempt: async () => { const pre = await run(preStep); return pre.code === 0 ? run(rollbackStep) : pre; },
    rolled: () => JSON.parse(readFileSync(join(dir, 'state.json'))).rolled,
    commands: () => { try { return readFileSync(join(dir, 'commands.log'), 'utf8'); } catch { return ''; } },
    report: () => JSON.parse(readFileSync(join(dir, 'rollback-preflight.json'), 'utf8')) };
}

for (const [label, mutate, error] of [
  ['unknown source', f => { f.state.targets.prod = moduleVersion(prodTarget, stamp('unstamped', 38)); }, /stamp unknown/],
  ['unknown Git source', f => { f.state.targets.prod = moduleVersion(prodTarget, stamp('f'.repeat(40), 38)); }, /Git schema\/source unknown/],
  ['bundle and Git schema disagree', f => { f.state.targets.prod = moduleVersion(prodTarget, stamp(f.oldSha, 50)); }, /disagrees with bundle/],
  ['wrong immutable version', f => { f.state.targets.prod.id = another; }, /immutable version\/modules unknown/],
  ['no immutable modules', f => { delete f.state.targets.prod.modules; }, /immutable version\/modules unknown/],
  ['mutable stamp', f => { f.state.targets.prod = moduleVersion(prodTarget, `${stamp(f.oldSha, 38)}SOURCE_REVISION='${f.currentSha}';`); }, /stamp unknown or mutable/],
  ['comment masquerading as source', f => { f.state.targets.prod = moduleVersion(prodTarget, `/*\n${stamp(f.oldSha, 38)}*/\nexport default {};`); }, /stamp unknown/],
  ['invalid allocation', f => { f.state.current.prod.versions.push({ version_id: another, percentage: -1 }); }, /current source\/schema or exact stable allocation unknown/],
  ['split allocation', f => { f.state.current.prod.versions[0].percentage = 90; f.state.current.prod.versions.push({ version_id: another, percentage: 10 }); }, /allocation unknown/],
  ['duplicate allocation', f => { f.state.current.prod.versions.push({ version_id: prodCurrent, percentage: 0 }); }, /allocation unknown/],
  ['string percentage', f => { f.state.current.prod.versions[0].percentage = '100'; }, /allocation unknown/],
  ['unstamped current worker', f => { f.state.signals.entry.sourceRevision = 'unstamped'; }, /entry: current source\/schema/],
  ['current allocation moved during observation', f => { f.state.race = { name: 'prod', after: 2 }; }, /allocation unknown/],
  ['API failure', f => { f.state.apiFailure = { status: 403 }; }, /HTTP 403/],
  ['malformed API response', f => { f.state.apiFailure = { body: 'private-module-fragment-not-json' }; }, /response is not JSON/],
]) test(`manual workflow refuses ${label} before any mutation`, async t => {
  const f = await fixture(t); mutate(f); f.save();
  const result = await f.attempt();
  assert.deepEqual(f.rolled(), [], 'ineligible workflow must never invoke rollback');
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, error);
  assert.doesNotMatch(result.stderr, /private-module-fragment-not-json|synthetic-token|historical code must never execute/);
  assert.deepEqual(f.rolled(), []);
  assert.doesNotMatch(f.commands(), /"rollback"/);
});

for (const [currentSchema, targetSchema] of [[38, 37], [39, 38], [105, 104]]) test(`manual workflow refuses schema ${targetSchema} under ${currentSchema} before any mutation`, async t => {
  const f = await fixture(t, { currentSchema, targetSchema });
  const result = await f.attempt();
  assert.deepEqual(f.rolled(), [], 'ineligible workflow must never invoke rollback');
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /cannot read candidate schema/);
  assert.deepEqual(f.rolled(), []);
});

for (const [label, mutate] of [
  ['missing compatibility check', f => { delete f.evidence.checks.oldCodeNewData; }],
  ['failed retained-runtime qualification', f => { f.evidence.checks.retainedRuntime.result = 'failed'; }],
  ['unqualified bindings', f => { f.evidence.checks.workerBindings.evidence = 'same schema'; }],
  ['wrong source pair', f => { f.evidence.targets.prod.sourceRevision = f.currentSha; }],
  ['wrong allocation pair', f => { f.evidence.current.entry.versionId = another; }],
  ['mutable evidence reference', f => { f.evidence.checks.oldCodeNewData.evidence = 'https://github.com/Uuriko/project-room/blob/main/report.md'; }],
]) test(`equal schemas still refuse ${label} before any mutation`, async t => {
  const f = await fixture(t); mutate(f); await f.commitEvidence();
  const result = await f.attempt();
  assert.deepEqual(f.rolled(), [], 'ineligible workflow must never invoke rollback');
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /qualification|compatibility evidence/);
  assert.deepEqual(f.rolled(), []);
});

test('working-tree-only qualification cannot admit a rollback', async t => {
  const f = await fixture(t);
  f.evidence.current.prod.versionId = another;
  await f.commitEvidence();
  f.evidence.current.prod.versionId = prodCurrent;
  writeFileSync(join(f.dir, 'qualification.json'), JSON.stringify(f.evidence));
  assert.equal((await f.attempt()).code, 1);
  assert.deepEqual(f.rolled(), []);
});

for (const withoutEntry of [false, true]) test(`qualified exact-pair workflow reaches only intended mutation commands (entry omitted=${withoutEntry})`, async t => {
  const f = await fixture(t, { currentSchema: 105, targetSchema: 105, withoutEntry });
  f.env.CLOUDFLARE_ACCOUNT_ID = ''; // exercise existing single-account token fallback
  let result = await f.preflight();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.report().schemaFloor, 105);
  assert.equal(f.report().targets.prod.sourceRevision, f.oldSha);
  assert.deepEqual(f.rolled(), [], 'preflight itself is read-only');
  result = await f.execute();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(f.rolled(), withoutEntry ? ['prod'] : ['prod', 'entry']);
});

test('qualified manual workflow retains REST fallback after exhausted Wrangler reads', async t => {
  const f = await fixture(t, { restFallback: true });
  const preflight = await f.preflight();
  assert.equal(preflight.code, 0, preflight.stderr);
  assert.deepEqual(f.rolled(), [], 'REST fallback admission remains read-only');
  const result = await f.execute();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(f.rolled(), ['prod', 'entry']);
});

for (const duplicate of [false, true]) test(`manual workflow rejects malformed REST fallback allocation (duplicate=${duplicate})`, async t => {
  const f = await fixture(t, { restFallback: true });
  if (duplicate) f.state.current.prod.versions.push({ version_id: prodCurrent, percentage: 0 });
  else f.state.current.prod.versions[0].percentage = '100';
  f.save();
  const result = await f.attempt();
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /exact stable allocation unknown/);
  assert.deepEqual(f.rolled(), []);
  assert.doesNotMatch(f.commands(), /"rollback"/);
});

for (const name of ['prod', 'entry']) test(`allocation changed on ${name} after preflight blocks both mutations`, async t => {
  const f = await fixture(t);
  assert.equal((await f.preflight()).code, 0);
  const state = JSON.parse(readFileSync(join(f.dir, 'state.json')));
  state.current[name] = allocation(another);
  writeFileSync(join(f.dir, 'state.json'), JSON.stringify(state));
  const result = await f.execute();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /deployment changed after preflight/);
  assert.deepEqual(f.rolled(), []);
});

test('a rejected second target prevents the first Worker mutation', async t => {
  const f = await fixture(t);
  f.state.targets.entry = moduleVersion(entryTarget, stamp('unstamped', 38)); f.save();
  const result = await f.attempt();
  assert.deepEqual(f.rolled(), [], 'ineligible workflow must never invoke rollback');
  assert.equal(result.code, 1);
  assert.deepEqual(f.rolled(), []);
  assert.doesNotMatch(f.commands(), /"rollback"/);
});

for (const value of ['', 'false']) test(`manual compatibility acknowledgement ${JSON.stringify(value)} cannot authorize mutation`, async t => {
  const f = await fixture(t); f.env.COMPATIBILITY_REVIEWED = value;
  const result = await f.attempt();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /manual review.*must be acknowledged/);
  assert.deepEqual(f.rolled(), []);
});

test('malformed committed qualification is rejected before mutation', async t => {
  const f = await fixture(t);
  writeFileSync(join(f.dir, 'qualification.json'), '{');
  await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-am', 'malformed'], { cwd: f.dir });
  const result = await f.attempt();
  assert.equal(result.code, 1);
  assert.deepEqual(f.rolled(), []);
});

test('preflight file cannot substitute a different target on execute', async t => {
  const f = await fixture(t);
  assert.equal((await f.preflight()).code, 0);
  const report = f.report(); report.targets.prod.versionId = another;
  writeFileSync(join(f.dir, 'rollback-preflight.json'), JSON.stringify(report));
  const result = await f.execute();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /preflight targets do not match/);
  assert.deepEqual(f.rolled(), []);
});

for (const kind of ['higher current entry schema', 'lower target entry schema']) test(`${kind} blocks production mutation too`, async t => {
  const f = await fixture(t);
  const version = kind.startsWith('higher') ? 39 : 37;
  writeFileSync(join(f.dir, 'server/writer-fence.mjs'), `export const STORE_SCHEMA_VERSION = ${version};\n`);
  await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-am', kind], { cwd: f.dir });
  const revision = (await exec('git', ['rev-parse', 'HEAD'], { cwd: f.dir })).stdout.trim();
  if (kind.startsWith('higher')) {
    f.state.signals.entry.sourceRevision = revision; f.evidence.current.entry.sourceRevision = revision;
  } else {
    f.state.targets.entry = moduleVersion(entryTarget, stamp(revision, 37)); f.evidence.targets.entry.sourceRevision = revision;
  }
  f.save(); await f.commitEvidence();
  const result = await f.attempt();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /cannot read candidate schema/);
  assert.deepEqual(f.rolled(), []);
});

test('a manufactured preflight schema cannot bypass immutable target qualification', async t => {
  const f = await fixture(t, { currentSchema: 39, targetSchema: 38 });
  const evidenceBlob = (await exec('git', ['rev-parse', 'HEAD:qualification.json'], { cwd: f.dir })).stdout.trim();
  const report = { format: 1, current: f.evidence.current, evidence: { blob: evidenceBlob }, targets: {
    prod: { ...f.evidence.targets.prod, known: true, codeSchemaVersion: 999 },
    entry: { ...f.evidence.targets.entry, known: true, codeSchemaVersion: 999 }
  } };
  writeFileSync(join(f.dir, 'rollback-preflight.json'), JSON.stringify(report));
  const result = await f.execute();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /cannot read candidate schema/);
  assert.deepEqual(f.rolled(), []);
});
