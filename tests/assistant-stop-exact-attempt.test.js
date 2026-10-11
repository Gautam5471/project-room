// Fail-first contract for an exact-attempt Stop (design note: johnstab r37, coordinated with Codex's #2510 lane).
// A human Stop names the attempt the person saw. Host progress on that same attempt must not void the Stop,
// and a Stop aimed at an attempt that is no longer current must never stop a newer one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';

async function setup(t) {
  const f = createAcceptanceFixture({ dmConsent: true });
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const api = async (actor, input) => {
    const response = await fetch(`${origin}/api/rooms/commons/assistant`, { method: input ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${f.keys[actor]}`, ...(input ? { 'content-type': 'application/json' } : {}) }, ...(input ? { body: JSON.stringify({ requestId: randomUUID(), ...input }) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const message = (actor, id, body) => f.store.command(f.keys[actor], 'commons', { id: randomUUID(), type: 'message.posted', data: { messageId: id, body } });
  await api('owner', { action: 'configure', expectedRevision: 0, name: 'Room', coordinatorMemberId: 'producer' });
  message('owner', 'exact-opening', 'Work on this.');
  await api('owner', { action: 'invoke', runId: 'exact', sourceMessageId: 'exact-opening' });
  const claimed = await api('producer', { action: 'claim', runId: 'exact', attemptId: 'host-1', expectedRevision: 0 });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  return { f, api };
}

test('Stop names the attempt it stops: host progress on that attempt does not void it', async t => {
  const { api } = await setup(t);
  const seen = (await api('owner')).body.runs[0];
  assert.equal(seen.attemptId, 'host-1');
  // While the person reaches for Stop, the same attempt reports progress.
  const progress = await api('producer', { action: 'report', runId: 'exact', attemptId: 'host-1', expectedRevision: seen.revision, state: 'working', summary: 'Reading sources' });
  assert.equal(progress.status, 200, JSON.stringify(progress.body));
  const stop = await api('owner', { action: 'cancel', runId: 'exact', expectedRevision: seen.revision, expectedAttemptId: 'host-1' });
  assert.equal(stop.status, 200, `a Stop for the attempt the person saw must land, got ${stop.status} ${JSON.stringify(stop.body).slice(0, 160)}`);
  assert.equal(stop.body.result.status, 'cancel_requested');
});

test('Stop aimed at an attempt that is no longer current never stops the newer attempt', async t => {
  const { api } = await setup(t);
  const run = (await api('owner')).body.runs[0];
  const stale = await api('owner', { action: 'cancel', runId: 'exact', expectedRevision: run.revision, expectedAttemptId: 'host-0' });
  assert.equal(stale.status, 409, `expected 409 for a Stop naming a different attempt, got ${stale.status}`);
  assert.equal(stale.body.error?.code, 'assistant_attempt_changed');
  assert.equal((await api('owner')).body.runs[0].status, 'working', 'the current attempt keeps running');
});

test('exact-attempt pause survives progress, is replayable, and still requires controller authority', async t => {
  const { api } = await setup(t);
  await api('producer', { action: 'report', runId: 'exact', attemptId: 'host-1', expectedRevision: 1, state: 'working', summary: 'Still working' });
  const input = { action: 'pause', requestId: 'pause-stable', runId: 'exact', expectedRevision: 1, expectedAttemptId: 'host-1' };
  assert.equal((await api('guest', input)).status, 403);
  assert.equal((await api('producer', input)).status, 403);
  const paused = await api('owner', input);
  assert.equal(paused.status, 200);
  assert.equal(paused.body.result.status, 'pause_requested');
  assert.deepEqual(await api('owner', input), paused);
  const ack = await api('producer', { action: 'report', runId: 'exact', attemptId: 'host-1', expectedRevision: paused.body.result.revision, state: 'paused', summary: 'Execution paused' });
  assert.equal(ack.status, 200);
});

test('legacy Stop remains revision-fenced and malformed attempt bindings are refused', async t => {
  const { api } = await setup(t);
  await api('producer', { action: 'report', runId: 'exact', attemptId: 'host-1', expectedRevision: 1, state: 'working', summary: 'Progress' });
  const legacy = await api('owner', { action: 'cancel', runId: 'exact', expectedRevision: 1 });
  assert.equal(legacy.body.error.code, 'assistant_revision_conflict');
  for (const expectedAttemptId of ['', {}, 3, false]) {
    assert.equal((await api('owner', { action: 'cancel', runId: 'exact', expectedAttemptId })).status, 422);
  }
  assert.equal((await api('owner')).body.runs[0].status, 'working');
});

test('an explicit unclaimed binding cannot cancel an attempt acquired while Stop is in flight', async t => {
  const { api, f } = await setup(t);
  f.store.command(f.keys.owner, 'commons', { id: randomUUID(), type: 'message.posted', data: { messageId: 'queued-opening', body: 'Queued work' } });
  await api('owner', { action: 'invoke', runId: 'queued', sourceMessageId: 'queued-opening' });
  await api('producer', { action: 'claim', runId: 'queued', attemptId: 'replacement', expectedRevision: 0 });
  const stale = await api('owner', { action: 'cancel', runId: 'queued', expectedAttemptId: null });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'assistant_attempt_changed');
  assert.equal((await api('owner')).body.runs.find(run => run.id === 'queued').status, 'working');
  f.store.command(f.keys.owner, 'commons', { id: randomUUID(), type: 'message.posted', data: { messageId: 'unclaimed-opening', body: 'Unclaimed work' } });
  await api('owner', { action: 'invoke', runId: 'unclaimed', sourceMessageId: 'unclaimed-opening' });
  const stopped = await api('owner', { action: 'cancel', runId: 'unclaimed', expectedAttemptId: null });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.result.status, 'cancelled');
});

test('a delayed Pause for the same attempt cannot downgrade a requested Stop', async t => {
  const { api } = await setup(t);
  assert.equal((await api('owner', { action: 'cancel', runId: 'exact', expectedAttemptId: 'host-1' })).status, 200);
  const pause = await api('owner', { action: 'pause', runId: 'exact', expectedAttemptId: 'host-1' });
  assert.equal(pause.status, 409);
  assert.equal(pause.body.error.code, 'assistant_stop_pending');
  assert.equal((await api('owner')).body.runs[0].status, 'cancel_requested');
});
