import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
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
  message('owner', 'stream-opening', 'Work on this.');
  await api('owner', { action: 'invoke', runId: 'stream', sourceMessageId: 'stream-opening' });
  const claimed = await api('producer', { action: 'claim', runId: 'stream', attemptId: 'host-1', expectedRevision: 0 });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  return { f, api, origin };
}


const draft = (sequence, body, extra = {}) => ({ action:'draft', runId:'stream', attemptId:'host-1', expectedRevision:1, sequence, body, ...extra });
test('answer snapshots are monotonic, bounded and replace one stored value without token history', async t => {
  const {api,f} = await setup(t);
  const before = f.store.db.prepare('SELECT count(*) n FROM room_assistant_ops').get().n;
  for (const sequence of [1,2,3]) assert.equal((await api('producer',draft(sequence,`Answer ${sequence}`))).status,200);
  assert.equal((await api('producer',draft(3,'Answer 3'))).status,200);
  assert.equal((await api('producer',draft(2,'Older answer'))).body.error.code,'assistant_retry_conflict');
  assert.equal((await api('producer',draft(3,'Changed retry'))).status,409);
  const run=(await api('owner')).body.runs[0];
  assert.deepEqual(run.answerDraft,{attemptId:'host-1',sequence:3,body:'Answer 3'});
  assert.equal(run.revision,1);assert.equal(run.answerDraftSequence,3);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM room_assistant_ops').get().n,before);
  assert.equal(f.store.room('commons').state.messages.filter(m=>m.body.startsWith('Answer ')).length,0);
  for (const input of [draft(0,'x'),draft(4,'x'.repeat(65537)),draft(1.5,'x')]) assert.ok([413,422].includes((await api('producer',input)).status));
});
test('answer drafts require the current authorized attempt, and Stop fences all late output', async t => {
  const {api}=await setup(t);
  assert.equal((await api('owner',draft(1,'human spoof'))).status,403);
  assert.equal((await api('producer',draft(1,'old host',{attemptId:'other'}))).body.error.code,'assistant_run_owned');
  await api('producer',draft(1,'Partial answer'));
  const stop=await api('owner',{action:'cancel',runId:'stream',expectedAttemptId:'host-1'});
  assert.equal(stop.status,200);assert.equal(stop.body.result.answerDraft,undefined);
  assert.equal((await api('producer',draft(2,'Late output',{expectedRevision:2}))).body.error.code,'assistant_stop_pending');
  assert.equal((await api('producer',{action:'publish',runId:'stream',attemptId:'host-1',expectedRevision:2,summary:'Late result',body:'Must not publish',appliedInputMessageIds:['stream-opening']})).status,409);
});
test('publishing atomically replaces the draft and late snapshots cannot overwrite the result', async t => {
  const {api,f}=await setup(t);await api('producer',draft(1,'Partial answer'));
  const result=await api('producer',{action:'publish',runId:'stream',attemptId:'host-1',expectedRevision:1,summary:'Ready',body:'Final answer',appliedInputMessageIds:['stream-opening']});
  assert.equal(result.status,200);assert.equal(result.body.result.answerDraft,undefined);
  assert.equal(result.body.result.status,'done');
  assert.equal((await api('producer',draft(2,'Late overwrite',{expectedRevision:2}))).body.error.code,'assistant_run_closed');
  assert.equal(f.store.room('commons').state.messages.filter(m=>m.body==='Final answer').length,1);
  const read=(await api('guest')).body.runs[0];assert.equal(read.answerDraft,undefined);assert.equal(read.resultMessageId,result.body.result.resultMessageId);
});
test('new human input clears obsolete text but retains the monotonic draft sequence', async t => {
  const {api,f}=await setup(t);await api('producer',draft(4,'Old scope answer'));
  f.store.command(f.keys.owner,'commons',{id:randomUUID(),type:'message.posted',data:{messageId:'steer',body:'New direction',replyToId:'stream-opening'}});
  const added=await api('owner',{action:'contribute',runId:'stream',sourceMessageId:'steer',expectedRevision:1});
  assert.equal(added.status,200);assert.equal(added.body.result.answerDraft,undefined);assert.equal(added.body.result.answerDraftSequence,4);
  assert.equal((await api('producer',draft(3,'Reordered old text',{expectedRevision:2}))).status,409);
  assert.equal((await api('producer',draft(5,'New scope answer',{expectedRevision:2}))).status,200);
});

test('an unrelated room never reads or mutates another rooms answer draft', async t => {
  const {api,f,origin}=await setup(t);await api('producer',draft(1,'Only this room may see this draft'));
  f.store.initialize(initialRoom('unrelated'));
  const key=f.store.issueAccessKey('unrelated','owner');
  const read=await fetch(`${origin}/api/rooms/unrelated/assistant`,{headers:{authorization:`Bearer ${key}`}});
  assert.equal(read.status,200);assert.deepEqual((await read.json()).runs,[]);
  const wrong=await fetch(`${origin}/api/rooms/commons/assistant`,{headers:{authorization:`Bearer ${key}`}});
  assert.ok([401,403].includes(wrong.status));assert.equal((await wrong.text()).includes('Only this room'),false);
  assert.equal((await api('owner')).body.runs[0].answerDraft.body,'Only this room may see this draft');
});
