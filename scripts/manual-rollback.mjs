#!/usr/bin/env node
// Manual rollback admission. Never execute a historical bundle to discover its
// source: read the immutable version's module bytes, parse its top-level stamp,
// and use deploy-recovery's exact Git schema and allocation checks.
//
// COMPATIBILITY_FILE names a committed JSON receipt, read from HEAD, with:
// { format: 1, current: {prod: {versionId, sourceRevision}, entry: {...}},
//   targets: {prod: {versionId, sourceRevision}, entry: {...} | null},
//   checks: {oldCodeNewData: {result: "passed", evidence: "https://..."},
//            retainedRuntime: {...}, workerBindings: {...}} }
// Review the linked qualification before dispatch and explicitly acknowledge
// that manual review with COMPATIBILITY_REVIEWED. It must cover
// the exact current/target pair, including semantic changes and all intervening
// writes. This gate checks its scope, not whether a claimed test really ran.
// Equal schemas alone never qualify a rollback. No qualifying receipt is shipped
// by this repair; unknown targets or missing evidence require a roll forward.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Linter } from 'eslint';
import { command, deploymentStatus, observeWorker, readVersion, rollbackDecision, schemaAt } from './deploy-recovery.mjs';

const names = ['prod', 'entry'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha = /^[0-9a-f]{40}$/;
const workerNames = { prod: 'project-room', entry: 'project-room-staging' };
const origin = name => name === 'prod' ? process.env.PROD_ORIGIN : process.env.ENTRY_ORIGIN;
const matches = (a, b) => a?.versionId === b?.versionId && a?.sourceRevision === b?.sourceRevision;

function bundleStamp(version, versionId) {
  if (version?.id !== versionId || !Array.isArray(version.modules)) throw new Error('target immutable version/modules unknown');
  const modules = version.modules.filter(module => module.name === version.main_module);
  if (modules.length !== 1 || modules[0].content_type !== 'application/javascript+module' ||
      typeof modules[0].content_base64 !== 'string') throw new Error('target main module unknown');
  const code = Buffer.from(modules[0].content_base64, 'base64').toString('utf8');
  // ESLint is already a locked repository dev dependency. Its parser visits
  // code as data; no historical imports, getters, or top-level code can run.
  let stamp = null;
  let messages;
  try { messages = new Linter().verify(code, {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    plugins: { stamp: { rules: { inspect: { create(context) { return {
      'Program:exit'() {
        const scope = context.sourceCode.scopeManager.scopes.find(value => value.type === 'module');
        const values = {};
        for (const name of ['SOURCE_REVISION', 'STORE_SCHEMA_VERSION']) {
          const variable = scope?.set.get(name), definitions = variable?.defs;
          if (definitions?.length !== 1 || definitions[0].type !== 'Variable' ||
              definitions[0].node.init?.type !== 'Literal' || variable.references.some(ref => ref.isWrite() && !ref.init)) return;
          values[name] = definitions[0].node.init.value;
        }
        if (sha.test(values.SOURCE_REVISION) && Number.isSafeInteger(values.STORE_SCHEMA_VERSION) && values.STORE_SCHEMA_VERSION > 0)
          stamp = { sourceRevision: values.SOURCE_REVISION, codeSchemaVersion: values.STORE_SCHEMA_VERSION };
      }
    }; } } } } },
    rules: { 'stamp/inspect': 'error' }
  }); } catch { throw new Error('target module could not be parsed'); }
  if (messages.some(message => message.fatal) || !stamp) throw new Error('target source/schema stamp unknown or mutable');
  return stamp;
}

function accountId() {
  let id = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!id) {
    const text = command(['pnpm', 'exec', 'wrangler', 'whoami', '--json'], 'cloudflare');
    const result = JSON.parse(text.slice(text.indexOf('{')));
    if (result.loggedIn === true && result.accounts?.length === 1) id = result.accounts[0].id;
  }
  if (!/^[0-9a-f]{32}$/.test(id ?? '')) throw new Error('one exact Cloudflare account is required');
  return id;
}

async function targetVersion(name, versionId, account) {
  if (!uuid.test(versionId) || !workerNames[name]) throw new Error('target Worker/version unknown');
  // Documented read-only API; names are supported Worker identifiers. Never
  // fetch a caller-supplied URL with the token or log the response's bindings.
  // https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/subresources/versions/methods/get/
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/workers/${workerNames[name]}/versions/${versionId}?include=modules`;
  const response = await fetch(url, { redirect: 'error', headers: {
    authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, accept: 'application/json'
  }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${name}: immutable version read HTTP ${response.status}`);
  let body;
  try { body = await response.json(); } catch { throw new Error(`${name}: immutable version response is not JSON`); }
  if (body?.success !== true) throw new Error(`${name}: immutable version read failed`);
  const stamp = bundleStamp(body.result, versionId), proof = schemaAt(stamp.sourceRevision);
  if (!proof || proof.version !== stamp.codeSchemaVersion) throw new Error(`${name}: target Git schema/source unknown or disagrees with bundle`);
  return { known: true, versionId, ...stamp, schemaSource: proof };
}

function qualification(current, targets) {
  if (process.env.COMPATIBILITY_REVIEWED !== 'true' || !process.env.GITHUB_ACTOR)
    throw new Error('manual review of exact-pair compatibility evidence must be acknowledged by the dispatcher');
  const path = process.env.COMPATIBILITY_FILE;
  if (typeof path !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_./-]*\.json$/.test(path) || path.split('/').some(part => ['.', '..', ''].includes(part)))
    throw new Error('COMPATIBILITY_FILE must name a committed JSON qualification receipt');
  const reference = `HEAD:${path}`;
  const evidence = JSON.parse(command(['git', 'show', reference]));
  if (evidence.format !== 1) throw new Error('compatibility qualification format unknown');
  for (const name of names) {
    if (!matches(evidence.current?.[name], current[name]) ||
        (targets[name] ? !matches(evidence.targets?.[name], targets[name]) : evidence.targets?.[name] !== null))
      throw new Error(`${name}: compatibility evidence does not cover this exact current/target pair`);
  }
  for (const name of ['oldCodeNewData', 'retainedRuntime', 'workerBindings']) {
    const check = evidence.checks?.[name];
    let link;
    try { link = new URL(check?.evidence); } catch { /* rejected below */ }
    if (check?.result !== 'passed' || !link || link.protocol !== 'https:' || link.username || link.password || link.hash ||
        !/\/(?:actions\/runs\/\d+(?:\/attempts\/\d+)?|blob\/[0-9a-f]{40}\/[^?#]+)$/.test(link.pathname) || link.hostname !== 'github.com' || link.search)
      throw new Error(`${name}: exact-source qualification evidence required; schema equality is insufficient`);
  }
  return { path, blob: command(['git', 'rev-parse', reference]).trim(), reviewedBy: process.env.GITHUB_ACTOR, checks: evidence.checks };
}

async function observeBoth() {
  const current = {};
  for (const name of names) {
    current[name] = await observeWorker({ status: () => deploymentStatus(name), readVersion: () => readVersion(origin(name)) });
    if (!current[name].known) throw new Error(`${name}: current source/schema or exact stable allocation unknown`);
  }
  return current;
}

async function preflight(output) {
  if (!process.env.CLOUDFLARE_API_TOKEN) throw new Error('Cloudflare token missing; nothing rolled back');
  if (!uuid.test(process.env.PROD_ID ?? '') || (process.env.ENTRY_ID && !uuid.test(process.env.ENTRY_ID))) throw new Error('rollback target must be a full version UUID');
  const account = accountId(), current = await observeBoth(), targets = {};
  for (const name of names) {
    const id = name === 'prod' ? process.env.PROD_ID : process.env.ENTRY_ID;
    targets[name] = id ? await targetVersion(name, id, account) : null;
  }
  // Both doors share production storage. Never use a lower entry schema to
  // lower the canonical worker's floor (or vice versa).
  const floor = Math.max(...names.map(name => current[name].codeSchemaVersion));
  for (const name of names) {
    if (!targets[name]) continue;
    const decision = rollbackDecision(targets[name], floor);
    if (!decision.eligible) throw new Error(`${name}: ${decision.reason}; roll forward required`);
  }
  const evidence = qualification(current, targets);
  const report = { format: 1, current, targets, schemaFloor: floor, evidence, recordedAt: new Date().toISOString(),
    compatibilityLimit: 'Schema floor plus exact-pair reviewed qualification receipt; the gate does not execute or independently verify the referenced qualification.' };
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, names.map(name => `${name}=${current[name].versionId}\n`).join(''));
  console.log(`Manual rollback preflight passed: schema floor ${floor}; manual qualification review acknowledged by ${evidence.reviewedBy}; receipt ${evidence.path} blob ${evidence.blob}`);
}

async function execute(path) {
  if (!process.env.CLOUDFLARE_API_TOKEN) throw new Error('Cloudflare token missing; nothing rolled back');
  const report = JSON.parse(readFileSync(path, 'utf8'));
  if (report.format !== 1 || report.targets?.prod?.versionId !== process.env.PROD_ID ||
      (report.targets?.entry?.versionId ?? '') !== (process.env.ENTRY_ID ?? '')) throw new Error('preflight targets do not match this request');
  // Re-observe ALL workers before the first mutation, not only the first target.
  const current = await observeBoth();
  for (const name of names) if (!matches(current[name], report.current?.[name])) throw new Error(`${name}: deployment changed after preflight; nothing rolled back`);
  const evidence = qualification(current, report.targets);
  if (evidence.blob !== report.evidence?.blob) throw new Error('qualification changed after preflight');
  const account = accountId(), targets = {};
  for (const name of names) {
    const target = report.targets[name];
    if (!target) continue;
    // The saved file is a receipt, not authority to substitute a typed schema
    // or an invented UUID-to-source mapping on a direct execute invocation.
    targets[name] = await targetVersion(name, target.versionId, account);
    if (!matches(targets[name], target)) throw new Error(`${name}: target source differs from preflight`);
    const decision = rollbackDecision(targets[name], Math.max(...names.map(worker => current[worker].codeSchemaVersion)));
    if (!decision.eligible) throw new Error(`${name}: ${decision.reason}`);
  }
  for (const name of names) {
    if (!targets[name]) continue;
    command(['pnpm', 'exec', 'wrangler', 'rollback', targets[name].versionId, ...(name === 'prod' ? ['--env', 'production'] : []),
      '--message', `rollback-prod run ${process.env.GITHUB_RUN_ID}: ${(process.env.REASON ?? '').slice(0, 150)}`, '--yes'], 'cloudflare');
  }
}

async function main() {
  const [mode, path] = process.argv.slice(2);
  if (!path) throw new Error('Usage: manual-rollback.mjs preflight <report> | execute <report>');
  if (mode === 'preflight') await preflight(path);
  else if (mode === 'execute') await execute(path);
  else throw new Error('unknown manual rollback mode');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); }
  catch (error) { console.error(`Manual rollback refused or failed: ${error.message}`); process.exitCode = 1; }
}
