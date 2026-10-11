// Real createRoomServer HTTP requests below own public assistant revision, membership, and host authority boundaries for server/routes/room-assistant.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { RoomStore } from '../server/store.mjs';
import { join } from 'node:path';
import { RoomAssistant } from '../server/room-assistant.mjs';
import { demoteToReadonly } from '../server/autonomy-tiers.mjs';

async function setup(t) {
  const f = createAcceptanceFixture({ dmConsent: true });
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const api = async (actor, input, expected = 200) => {
    const response = await fetch(`${origin}/api/rooms/commons/assistant`, { method: input ? 'POST' : 'GET', headers: { authorization: `Bearer ${f.keys[actor]}`, ...(input ? {'content-type': 'application/json'} : {}) }, ...(input ? {body: JSON.stringify({ requestId: randomUUID(), ...input })} : {}) });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
  };
  const message = (actor, id, body = 'Shared input', extra = {}) => f.store.command(f.keys[actor], 'commons', { id: randomUUID(), type: 'message.posted', data: { messageId: id, body, ...extra } });
  return { f, api, message, origin };
}

test('unfinished assistant work stays discoverable after more than 100 newer terminal requests', async t => {
  const { f, api, message } = await setup(t);
  const assistant = new RoomAssistant(f.store);
  let clock = f.store.now();
  f.store.now = () => clock;
  // Exercise production transitions to create history without exhausting the
  // HTTP write limiter; the externally observable read uses the actual route.
  const apply = (actor, input) => assistant.apply('commons', { requestId: randomUUID(), ...input }, () => f.store.authenticate(f.keys[actor], 'commons')).result;
  apply('owner', { action: 'configure', expectedRevision: 0, name: 'Room', coordinatorMemberId: 'producer' });
  for (const id of ['queued', 'working', 'paused', 'needs-input', 'stopping']) {
    message('owner', `prompt-${id}`);
    apply('owner', { action: 'invoke', runId: id, sourceMessageId: `prompt-${id}` });
    if (id === 'paused') apply('owner', { action: 'pause', runId: id, expectedRevision: 0 });
    else if (id !== 'queued') {
      apply('producer', { action: 'claim', runId: id, attemptId: `host-${id}`, expectedRevision: 0 });
      if (id === 'needs-input') apply('producer', { action: 'report', runId: id, attemptId: `host-${id}`, expectedRevision: 1, state: 'needs_input', summary: 'Choose a direction.' });
      if (id === 'stopping') apply('owner', { action: 'cancel', runId: id, expectedRevision: 1 });
    }
  }
  for (let n = 0; n < 105; n++) {
    clock += 2000; // Historical requests respect the normal chat refill budget.
    message('owner', `terminal-prompt-${n}`);
    apply('owner', { action: 'invoke', runId: `terminal-${n}`, sourceMessageId: `terminal-prompt-${n}` });
    apply('owner', { action: 'cancel', runId: `terminal-${n}`, expectedRevision: 0 });
  }
  apply('producer', { action: 'report', runId: 'working', attemptId: 'host-working', expectedRevision: 1, state: 'working', summary: 'Still processing the original request.' });
  const context = await api('owner');
  const statuses = new Map(context.runs.map(run => [run.id, run.status]));
  for (const [id, status] of [['queued', 'queued'], ['working', 'working'], ['paused', 'paused'], ['needs-input', 'needs_input'], ['stopping', 'cancel_requested']])
    assert.equal(statuses.get(id), status, `older ${id} remains visible and actionable`);
  assert.equal(context.runs.length, 100, 'history remains bounded');
  assert.equal(statuses.get('terminal-104'), 'cancelled', 'recent outcomes remain available');
  assert.equal(statuses.has('terminal-0'), false, 'older terminal history yields to unfinished work');
  assert.equal(context.assistant.availability, 'connected', 'recent active host is not hidden by terminal history');
  const pending = context.runs.find(run => run.id === 'queued');
  const claimed = await api('producer', { action: 'claim', runId: pending.id, attemptId: 'recovered-host', expectedRevision: pending.revision });
  assert.equal(claimed.result.status, 'working');
});

test('two humans share one durable run, host claims and publishes a real public result', async t => {
  const { f, api, message } = await setup(t);
  assert.equal((await api('guest')).assistant.availability, 'not_connected');
  await api('owner', { action: 'configure', expectedRevision: 0, name: 'Room', coordinatorMemberId: 'producer' });
  assert.equal((await api('guest')).assistant.availability, 'awaiting_host');
  message('owner', 'question'); message('guest', 'constraint');
  const invocation = { action: 'invoke', requestId: 'same-invocation', runId: 'shared', sourceMessageId: 'question' };
  const first = await api('owner', invocation);
  assert.equal(first.result.status, 'queued');
  assert.deepEqual(await api('owner', invocation), first);
  await api('owner', { ...invocation, sourceMessageId: 'test-welcome' }, 409);
  const added = await api('guest', { action: 'contribute', runId: 'shared', sourceMessageId: 'constraint', expectedRevision: 0 });
  assert.deepEqual(added.result.inputs.map(i => i.memberId), ['owner', 'guest']);
  assert.equal(added.result.inputs[1].status, 'pending');
  await api('producer', {action:'claim', runId:'shared', attemptId:'host-a', expectedRevision:0},409);
  const claim = { action:'claim', requestId:'claim-once', runId:'shared', attemptId:'host-a', expectedRevision:1 };
  await api('producer', claim); await api('producer', claim);
  await api('producer', {...claim, requestId:'another', attemptId:'host-b', expectedRevision:2},409);
  assert.equal((await api('owner')).runs[0].status, 'working');
  await api('producer', {action:'report', runId:'shared', attemptId:'host-a', expectedRevision:2, state:'done', summary:'Ready'},422);
  message('producer', 'public-answer', 'Here is the combined result.');
  await api('producer', {action:'report', runId:'shared', attemptId:'host-a', expectedRevision:2, state:'done', summary:'Combined both inputs; result ready.', resultMessageId:'public-answer', appliedInputMessageIds:['question','constraint']});
  const owner = await api('owner'), friend = await api('guest');
  assert.deepEqual(owner.runs, friend.runs);
  assert.equal(friend.runs[0].resultMessageId, 'public-answer');
  assert.equal(friend.runs[0].activity[0].kind, 'reported');
  // Close SQLite and reopen its durable database, as on coordinator restart.
  f.store.close();
  f.store = new RoomStore(join(f.directory, 'room.sqlite'));
  const reopened = new RoomAssistant(f.store).list('commons', () => f.store.authenticate(f.keys.guest, 'commons'));
  assert.equal(reopened.runs[0].status, 'done');
});

test('completion accounts for late group contributions and refuses partial completion atomically', async t => {
  const { api, message } = await setup(t);
  await api('owner', {action:'configure',expectedRevision:0,name:'Room',coordinatorMemberId:'producer'});
  message('owner','initial-goal');
  await api('owner',{action:'invoke',runId:'late-input',sourceMessageId:'initial-goal'});
  await api('producer',{action:'claim',runId:'late-input',attemptId:'host',expectedRevision:0});
  await api('producer',{action:'report',runId:'late-input',attemptId:'host',expectedRevision:1,state:'working',summary:'Read the initial request.',appliedInputMessageIds:['initial-goal']});
  message('guest','late-constraint','Also preserve the draft.');
  await api('guest',{action:'contribute',runId:'late-input',sourceMessageId:'late-constraint',expectedRevision:2});
  message('producer','late-answer','Result incorporating the shared request.');
  const completion={action:'report',requestId:'finish-late-input',runId:'late-input',attemptId:'host',expectedRevision:3,state:'done',summary:'Ready.',resultMessageId:'late-answer'};
  const rejected=await api('producer',completion,409);
  assert.equal(rejected.error.code,'assistant_inputs_pending');
  const unchanged=(await api('owner')).runs[0];
  assert.equal(unchanged.revision,3);
  assert.equal(unchanged.status,'working');
  assert.equal(unchanged.resultMessageId,undefined);
  assert.equal(unchanged.activity.length,1);
  assert.deepEqual(unchanged.inputs.map(i=>i.status),['applied','pending']);
  // A refused write has no successful retry receipt. Correcting the same request
  // accounts for the new contribution without losing the earlier acknowledgment.
  const corrected={...completion,appliedInputMessageIds:['late-constraint']};
  const done=await api('producer',corrected);
  assert.equal(done.result.status,'done');
  assert.deepEqual(done.result.inputs.map(i=>i.status),['applied','applied']);
  assert.deepEqual(await api('producer',corrected),done);
  assert.equal((await api('guest')).runs[0].activity.length,2);
});

test('shared assistant inputs and results stay in the originating channel and thread', async t => {
  for (const scenario of [
    { name: 'another channel', threaded: false, foreign: { channelId: 'design' } },
    { name: 'another thread in the same channel', threaded: false, foreign: { replyToId: 'foreign-root' } },
    { name: 'outside the originating thread', threaded: true, foreign: {} },
    { name: 'another thread from a threaded request', threaded: true, foreign: { replyToId: 'foreign-root' } }
  ]) await t.test(scenario.name, async t => {
    const { f, api, message } = await setup(t);
    await api('owner', { action: 'configure', expectedRevision: 0, name: 'Room', coordinatorMemberId: 'producer' });
    f.store.command(f.keys.owner, 'commons', { id: randomUUID(), type: 'channel.created', data: { channelId: 'design', name: 'design' } });
    message('owner', 'root'); message('owner', 'foreign-root');
    message('owner', 'question', 'Help with this conversation', scenario.threaded ? { replyToId: 'root' } : {});
    await api('owner', { action: 'invoke', runId: 'bound-run', sourceMessageId: 'question' });
    message('guest', 'foreign-input', 'An unrelated conversation', scenario.foreign);
    const refusal = await api('guest', { action: 'contribute', runId: 'bound-run', sourceMessageId: 'foreign-input', expectedRevision: 0 }, 409);
    assert.equal(refusal.error.code, 'assistant_conversation_mismatch');
    assert.equal((await api('owner')).runs[0].revision, 0);
    assert.deepEqual((await api('owner')).runs[0].inputs.map(input => input.sourceMessageId), ['question']);
    const replyToId = scenario.threaded ? 'root' : 'question';
    message('guest', 'context', 'Relevant context', { replyToId: 'question' });
    await api('guest', { action: 'contribute', runId: 'bound-run', sourceMessageId: 'context', expectedRevision: 0 });
    await api('producer', { action: 'claim', runId: 'bound-run', attemptId: 'host', expectedRevision: 1 });
    message('producer', 'foreign-result', 'Unrelated result', scenario.foreign);
    const completion = { action: 'report', requestId: 'complete-bound-run', runId: 'bound-run', attemptId: 'host', expectedRevision: 2, state: 'done', summary: 'Result ready', resultMessageId: 'foreign-result', appliedInputMessageIds: ['question', 'context'] };
    const rejected = await api('producer', completion, 409);
    assert.equal(rejected.error.code, 'assistant_conversation_mismatch');
    const unchanged = (await api('owner')).runs[0];
    assert.equal(unchanged.status, 'working'); assert.equal(unchanged.revision, 2);
    assert.equal(unchanged.resultMessageId, undefined);
    assert.deepEqual(unchanged.inputs.map(input => input.status), ['pending', 'pending']);
    message('producer', 'result', 'The actual answer', { replyToId });
    // A refused completion never consumes the retry ID or changes the run.
    const corrected = { ...completion, resultMessageId: 'result' };
    const done = await api('producer', corrected);
    assert.equal(done.result.status, 'done'); assert.equal(done.result.resultMessageId, 'result');
    assert.deepEqual(await api('producer', corrected), done);
  });
});

test('conflict is explicit, decision is authorized, and cancellation awaits host confirmation', async t => {
  const { api, message } = await setup(t);
  await api('owner', {action:'configure',expectedRevision:0, name:'Room', coordinatorMemberId:'producer'});
  message('owner','green','Use green'); message('guest','blue','Use blue'); message('guest','bad-decision'); message('owner','decision','Use green first');
  await api('owner', {action:'invoke', runId:'colors', sourceMessageId:'green'});
  await api('guest', {action:'contribute',runId:'colors',sourceMessageId:'blue',conflict:true,expectedRevision:0});
  await api('producer',{action:'claim',runId:'colors',attemptId:'host',expectedRevision:1},409);
  await api('guest',{action:'resolve',runId:'colors',sourceMessageId:'bad-decision',expectedRevision:1},403);
  await api('owner',{action:'resolve',runId:'colors',sourceMessageId:'decision',expectedRevision:1});
  await api('producer',{action:'claim',runId:'colors',attemptId:'host',expectedRevision:2});
  const pause = await api('owner',{action:'pause',runId:'colors',expectedRevision:3});
  assert.equal(pause.result.status,'pause_requested');
  await api('producer',{action:'report',runId:'colors',attemptId:'host',expectedRevision:4,state:'working',summary:'Still working'},409);
  await api('producer',{action:'report',runId:'colors',attemptId:'host',expectedRevision:4,state:'paused',summary:'Host stopped execution.'});
  const cancel = await api('owner',{action:'cancel',runId:'colors',expectedRevision:5});
  assert.equal(cancel.result.status,'cancel_requested');
  await api('producer',{action:'report',runId:'colors',attemptId:'host',expectedRevision:6,state:'cancelled',summary:'Cancellation confirmed.'});
  assert.equal((await api('guest')).runs[0].status,'cancelled');
});

test('private context, other authors, unauthorized publishers and unauthenticated readers are refused', async t => {
  const { api, message, origin } = await setup(t);
  await api('guest',{action:'configure',expectedRevision:0,name:'Room',coordinatorMemberId:'producer'},403);
  await api('owner',{action:'configure',expectedRevision:0,name:'Room',coordinatorMemberId:'producer'});
  message('owner','private','Private context',{toMemberId:'producer'});
  await api('owner',{action:'invoke',runId:'hidden',sourceMessageId:'private'},403);
  await api('guest',{action:'invoke',runId:'stolen',sourceMessageId:'test-welcome'},403);
  await api('producer',{action:'invoke',runId:'self',sourceMessageId:'test-welcome'},403);
  await api('owner',{action:'invoke',runId:'public',sourceMessageId:'test-welcome'});
  await api('reviewer',{action:'claim',runId:'public',attemptId:'host',expectedRevision:0},403);
  await api('guest',{action:'claim',runId:'public',attemptId:'host',expectedRevision:0},403);
  await api('producer',{action:'claim',runId:'public',attemptId:'host',expectedRevision:0});
  await api('producer',{action:'report',runId:'public',attemptId:'wrong-host',expectedRevision:1,state:'working',summary:'Forged'},409);
  await api('producer',{action:'report',runId:'public',attemptId:'host',expectedRevision:1,state:'done',summary:'Private output',resultMessageId:'private'},403);
  assert.equal((await fetch(`${origin}/api/rooms/commons/assistant`)).status,401);
});

test('a saved invocation does not imply execution, stale execution is unknown, membership revocation blocks host', async t => {
  const { f, api } = await setup(t);
  await api('owner',{action:'invoke',runId:'no-host',sourceMessageId:'test-welcome'},409);
  assert.equal((await api('owner')).runs.length,0);
  assert.equal((await api('owner')).assistant.availability,'not_connected');
  await api('owner',{action:'configure',expectedRevision:0,name:'Room',coordinatorMemberId:'producer'});
  await api('owner',{action:'invoke',runId:'connected',sourceMessageId:'test-welcome'});
  assert.equal((await api('owner')).runs[0].status,'queued');
  assert.equal((await api('owner')).assistant.availability,'awaiting_host');
  await api('producer',{action:'claim',runId:'connected',attemptId:'host',expectedRevision:0});
  const now = f.store.now(); f.store.now = () => now + 121000;
  assert.equal((await api('owner')).runs[0].status,'unknown');
  f.store.command(f.keys.owner,'commons',{id:randomUUID(),type:'member.access_changed',data:{memberId:'producer',expectedMemberRevision:0,permissions:['accept_work','complete_work'],active:false}});
  await api('producer',{action:'report',runId:'connected',attemptId:'host',expectedRevision:1,state:'working',summary:'Not authorized'},401);
});

test('human browser sessions enforce same-origin CSRF and separate shared authorship', async t => {
  const { f, api, origin } = await setup(t);
  await api('owner',{action:'configure',expectedRevision:0,name:'Room',coordinatorMemberId:'producer'});
  const owner = f.store.createSession(f.keys.owner), friend = f.store.createSession(f.keys.guest);
  const send = (session,input,csrf=true) => fetch(`${origin}/api/rooms/commons/assistant`,{method:'POST',headers:{Cookie:`room_session=${session.token}`,Origin:origin,'content-type':'application/json',...(csrf ? {'X-CSRF-Token':session.session.csrf} : {})},body:JSON.stringify({requestId:randomUUID(),...input})});
  assert.equal((await send(owner,{action:'invoke',runId:'cookie',sourceMessageId:'test-welcome'},false)).status,403);
  assert.equal((await send(owner,{action:'invoke',runId:'cookie',sourceMessageId:'test-welcome'})).status,200);
  assert.equal((await send(friend,{action:'contribute',runId:'cookie',sourceMessageId:'test-request',expectedRevision:0})).status,200);
  assert.deepEqual((await api('owner')).runs[0].inputs.map(i=>i.memberId),['owner','guest']);
});

test('operator backup roundtrip preserves run ownership and room purge inventory includes summaries and retries', async t => {
  const { f, api } = await setup(t);
  const { exportNdjsonText, replayNdjson } = await import('../server/room-export.mjs');
  const { countPurge } = await import('../server/operator-purge.mjs');
  await api('owner',{action:'configure',expectedRevision:0,name:'Room',coordinatorMemberId:'producer'});
  await api('owner',{action:'invoke',runId:'durable',sourceMessageId:'test-welcome'});
  await api('producer',{action:'claim',runId:'durable',attemptId:'original-host',expectedRevision:0});
  await api('producer',{action:'report',runId:'durable',attemptId:'original-host',expectedRevision:1,state:'working',summary:'Checking the shared draft.',appliedInputMessageIds:['test-welcome']});
  const referralsBefore=f.store.db.prepare('SELECT * FROM referrals ORDER BY room_id,referee_member_id').all();
  assert.ok(referralsBefore.length > 0, 'full fixture retains its seeded referral data');
  const filename=join(f.directory,'restored.sqlite');
  assert.equal(replayNdjson(exportNdjsonText(f.store.db),filename).verified,true);
  const restored=new RoomStore(filename); t.after(()=>restored.close());
  assert.deepEqual(restored.db.prepare('SELECT * FROM referrals ORDER BY room_id,referee_member_id').all(),referralsBefore);
  const run=JSON.parse(restored.db.prepare('SELECT value FROM room_assistant_runs WHERE room_id=? AND run_id=?').get('commons','durable').value);
  assert.equal(run.attemptId,'original-host'); assert.equal(run.inputs[0].status,'applied');
  const inventory=countPurge(f.store,[{kind:'room',id:'commons'}]).filter(row=>row.table.startsWith('room_assistant_'));
  assert.deepEqual(inventory.map(row=>[row.table,row.rows,row.action]),[['room_assistant_config',1,'delete'],['room_assistant_ops',4,'delete'],['room_assistant_runs',1,'delete']]);
});

test('disconnect fences ongoing execution while its original host can acknowledge stopping', async t => {
  const { api }=await setup(t);
  await api('owner',{action:'configure',expectedRevision:0,name:'Room',coordinatorMemberId:'producer'});
  await api('owner',{action:'invoke',runId:'switch',sourceMessageId:'test-welcome'});
  await api('producer',{action:'claim',runId:'switch',attemptId:'host',expectedRevision:0});
  await api('owner',{action:'configure',expectedRevision:0,name:'Other',coordinatorMemberId:null},409);
  await api('owner',{action:'configure',expectedRevision:1,name:'Room',coordinatorMemberId:null});
  const current=(await api('owner')).runs[0];
  assert.equal(current.status,'pause_requested'); assert.equal(current.attemptId,'host');
  await api('producer',{action:'report',runId:'switch',attemptId:'host',expectedRevision:2,state:'working',summary:'Ignored disconnect'},403);
  await api('producer',{action:'report',runId:'switch',attemptId:'host',expectedRevision:2,state:'paused',summary:'Host acknowledged disconnect.'});
  assert.equal((await api('owner')).runs[0].status,'paused');
});

test('hosted MCP discovers scoped coordinator tools and executes the real public claim/report contract', async t => {
  const { f, api, origin }=await setup(t);
  const { setTier }=await import('../server/autonomy-tiers.mjs');
  const identity=f.store.identities.create('Connected lead');
  const memberId=identity.identityId;
  f.store.identities.link(f.keys.owner,'commons',{identityId:memberId,permissions:['accept_work','complete_work']});
  setTier(f.store.db,'commons',memberId,'t2_standard',{updatedBy:'owner',nowMs:f.store.now()});
  await api('owner',{action:'configure',expectedRevision:0,name:'Room',coordinatorMemberId:memberId});
  await api('owner',{action:'invoke',runId:'mcp-shared',sourceMessageId:'test-welcome'});
  const rpc=async(method,params)=>{
    const response=await fetch(`${origin}/mcp`,{method:'POST',headers:{authorization:`Bearer ${identity.secret}`,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method,params})});
    assert.equal(response.status,200); return response.json();
  };
  const call=(name,args)=>rpc('tools/call',{name,arguments:{roomId:'commons',...args}});
  const catalog=await rpc('tools/list',{focus:'work'});
  assert.ok(catalog.result.tools.some(tool=>tool.name==='room_assistant_context'));
  const action=catalog.result.tools.find(tool=>tool.name==='room_assistant_action');
  assert.deepEqual(action.inputSchema.properties.action.enum,['claim','report','publish','draft']);
  assert.equal(action.inputSchema.additionalProperties,false);
  assert.ok(action.inputSchema.allOf.length>0);
  const context=await call('room_assistant_context',{});
  assert.equal(context.result.structuredContent.runs[0].status,'queued');
  assert.equal(context.result.structuredContent.assistant.availability,'awaiting_host');
  const args={action:'claim',requestId:'mcp-claim-once',runId:'mcp-shared',attemptId:'saved-host-attempt',expectedRevision:0};
  const claimed=await call('room_assistant_action',args);
  assert.equal(claimed.result.structuredContent.result.status,'working');
  assert.deepEqual((await call('room_assistant_action',args)).result.structuredContent,claimed.result.structuredContent);
  const drafted=await call('room_assistant_action',{...args,action:'draft',requestId:'mcp-draft',expectedRevision:1,sequence:1,body:'A shared answer is forming.'});
  assert.equal(drafted.result.structuredContent.result.answerDraft.body,'A shared answer is forming.');
  assert.equal(drafted.result.structuredContent.result.revision,1);
  assert.ok((await call('room_assistant_action',{...args,action:'configure'})).error);
  assert.ok((await call('room_assistant_action',{...args,summary:'Cannot sneak report fields into claim'})).error);
  const posted=await call('room_post_message',{id:'shared-result-command',messageId:'mcp-result',body:'Combined shared answer.'});
  assert.notEqual(posted.result?.isError,true);
  const completed=await call('room_assistant_action',{action:'report',requestId:'mcp-complete',runId:'mcp-shared',attemptId:'saved-host-attempt',expectedRevision:1,state:'done',summary:'Shared answer ready.',resultMessageId:'mcp-result',appliedInputMessageIds:['test-welcome']});
  assert.equal(completed.result.structuredContent.result.status,'done');
  assert.equal(completed.result.structuredContent.result.answerDraft,undefined);
  assert.equal((await api('guest')).runs[0].resultMessageId,'mcp-result');
  setTier(f.store.db,'commons',memberId,'t1_readonly',{updatedBy:'owner',nowMs:f.store.now()});
  const readonly=await rpc('tools/list',{focus:'work'});
  assert.ok(readonly.result.tools.some(tool=>tool.name==='room_assistant_context'));
  assert.equal(readonly.result.tools.some(tool=>tool.name==='room_assistant_action'),false);
  const denied=await call('room_assistant_action',{...args,requestId:'readonly-new'});
  assert.equal(denied.result.isError,true);
});

test('human contributions never revive stale host status or availability', async t => {
  const { f,api,message }=await setup(t);
  await api('owner',{action:'configure',expectedRevision:0,name:'Room',coordinatorMemberId:'producer'});
  await api('owner',{action:'invoke',runId:'stale',sourceMessageId:'test-welcome'});
  await api('producer',{action:'claim',runId:'stale',attemptId:'host',expectedRevision:0});
  const before=(await api('owner')).runs[0].hostReportedAt;
  const now=f.store.now(); f.store.now=()=>now+121000;
  message('guest','fresh-contribution');
  await api('guest',{action:'contribute',runId:'stale',sourceMessageId:'fresh-contribution',expectedRevision:1});
  const stale=await api('owner');
  assert.equal(stale.runs[0].status,'unknown');
  assert.equal(stale.runs[0].hostReportedAt,before);
  assert.equal(stale.assistant.availability,'awaiting_host');
  await api('producer',{action:'report',runId:'stale',attemptId:'host',expectedRevision:2,state:'working',summary:'Host is responsive again.'});
  const fresh=await api('owner');
  assert.equal(fresh.runs[0].status,'working');
  assert.equal(fresh.assistant.availability,'connected');
});

test('resume is requester/owner controlled, revision fenced and acknowledged by the same reserved host', async t => {
  const {api}=await setup(t);
  await api('owner',{action:'configure',expectedRevision:0,name:'Room',coordinatorMemberId:'producer'});
  await api('owner',{action:'invoke',runId:'resume',sourceMessageId:'test-welcome'});
  await api('owner',{action:'pause',runId:'resume',expectedRevision:0});
  await api('guest',{action:'resume',runId:'resume',expectedRevision:1},403);
  await api('owner',{action:'resume',runId:'resume',expectedRevision:0},409);
  const queued=await api('owner',{action:'resume',runId:'resume',expectedRevision:1});
  assert.equal(queued.result.status,'queued');
  await api('producer',{action:'claim',runId:'resume',attemptId:'original',expectedRevision:2});
  await api('owner',{action:'pause',runId:'resume',expectedRevision:3});
  await api('owner',{action:'resume',runId:'resume',expectedRevision:4},409);
  await api('producer',{action:'report',runId:'resume',attemptId:'original',expectedRevision:4,state:'paused',summary:'Stopped.'});
  await api('producer',{action:'report',runId:'resume',attemptId:'original',expectedRevision:5,state:'working',summary:'Unauthorized resume'},409);
  const resumed=await api('owner',{action:'resume',runId:'resume',expectedRevision:5});
  assert.equal(resumed.result.status,'resume_requested'); assert.equal(resumed.result.attemptId,'original');
  await api('producer',{action:'report',runId:'resume',attemptId:'new-host',expectedRevision:6,state:'working',summary:'New host'},409);
  await api('producer',{action:'report',runId:'resume',attemptId:'original',expectedRevision:6,state:'working',summary:'Original host confirmed resume.'});
  assert.equal((await api('guest')).runs[0].status,'working');
});

for (const stopBeforeDelete of [false, true]) test(`deleted opening retains content-free authorized stop controls (stop before deletion: ${stopBeforeDelete})`, async t => {
  const { f, api, message, origin } = await setup(t);
  const erased = 'ERASED-OPENING-CONTENT';
  await api('owner',{action:'configure',expectedRevision:0,name:'Room',coordinatorMemberId:'producer'});
  message('guest','deleted-opening',erased);
  await api('guest',{action:'invoke',runId:'deleted-run',sourceMessageId:'deleted-opening'});
  await api('producer',{action:'claim',runId:'deleted-run',attemptId:'reserved-host',expectedRevision:0});
  const earlier = { action:'report',requestId:'pre-delete-report',runId:'deleted-run',attemptId:'reserved-host',expectedRevision:1,state:'working',summary:erased };
  await api('producer',earlier);
  if (stopBeforeDelete) await api('guest',{action:'cancel',runId:'deleted-run',expectedRevision:2});
  const deleted = await fetch(`${origin}/api/rooms/commons/commands`,{method:'POST',headers:{authorization:`Bearer ${f.keys.owner}`,'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),type:'message.deleted',data:{messageId:'deleted-opening',expectedMessageRevision:0}})});
  assert.equal(deleted.status,201,await deleted.text());
  const storedMessage=f.store.room('commons').state.messages.find(m=>m.id==='deleted-opening');
  assert.equal(storedMessage.body,null); assert.deepEqual(storedMessage.editHistory,[]);
  for (const actor of ['owner','guest','producer']) {
    const view=await api(actor); assert.equal(view.runs.length,1,'authorized participants retain a stop handle for the deleted request');
    const control=view.runs[0]; assert.equal(control.sourceDeleted,true); assert.equal(control.attemptId,'reserved-host');
    assert.deepEqual(control.inputs,[]); assert.deepEqual(control.activity,[]);
    assert.doesNotMatch(JSON.stringify(view),new RegExp(erased));
  }
  const replay=await api('producer',earlier);
  assert.equal(replay.result.revision,2,'retry preserves the original committed receipt');
  assert.equal(replay.result.sourceDeleted,true); assert.doesNotMatch(JSON.stringify(replay),new RegExp(erased));
  assert.equal((await api('reviewer')).runs.length,0,'unrelated member sees no deleted run handle');
  let revision=stopBeforeDelete?3:2;
  await api('reviewer',{action:'cancel',runId:'deleted-run',expectedRevision:revision},404);
  await api('producer',{action:'report',runId:'deleted-run',attemptId:'reserved-host',expectedRevision:revision,state:'working',summary:'Not a stop'},404);
  await api('producer',{action:'report',runId:'deleted-run',attemptId:'reserved-host',expectedRevision:revision,state:'done',summary:'Not a stop',resultMessageId:'test-welcome'},404);
  await api('guest',{action:'resume',runId:'deleted-run',expectedRevision:revision},404);
  if (!stopBeforeDelete) {
    const paused=await api('guest',{action:'pause',runId:'deleted-run',expectedRevision:revision++});
    assert.equal(paused.result.status,'pause_requested'); assert.deepEqual(paused.result.activity,[]);
    await api('producer',{action:'report',runId:'deleted-run',attemptId:'wrong-host',expectedRevision:revision,state:'paused',summary:'Wrong attempt'},409);
    const ack=await api('producer',{action:'report',runId:'deleted-run',attemptId:'reserved-host',expectedRevision:revision++,state:'paused',summary:'Stopped'});
    assert.equal(ack.result.status,'paused');
    await api('owner',{action:'cancel',runId:'deleted-run',expectedRevision:revision++});
  }
  const cancellation={action:'report',requestId:'deleted-stop-once',runId:'deleted-run',attemptId:'reserved-host',expectedRevision:revision,state:'cancelled',summary:'Cancellation acknowledged'};
  const ack=await api('producer',cancellation); assert.equal(ack.result.status,'cancelled');
  assert.deepEqual(await api('producer',cancellation),ack,'exact acknowledgment retry remains idempotent');
  assert.deepEqual(ack.result.activity,[]); assert.doesNotMatch(JSON.stringify(ack),new RegExp(erased));
  assert.equal(JSON.parse(f.store.db.prepare('SELECT value FROM room_assistant_runs WHERE run_id=?').get('deleted-run').value).status,'cancelled');
  const member=f.store.room('commons').state.members.producer;
  f.store.command(f.keys.owner,'commons',{id:randomUUID(),type:'member.access_changed',data:{memberId:'producer',expectedMemberRevision:member.revision??0,permissions:['accept_work','complete_work'],active:false}});
  await api('producer',cancellation,401);
});

test('deleted stop handles and historical receipts remain behind the original history floor', async t => {
  const { f, api, message, origin }=await setup(t);
  const frozen=f.store.now(); f.store.now=()=>frozen;
  message('owner','before-host','ERASED-HISTORY');
  const command=(type,data)=>f.store.command(f.keys.owner,'commons',{id:randomUUID(),type,data});
  command('member.added',{memberId:'late-host',displayName:'Late host',kind:'agent',permissions:['accept_work','complete_work'],accountableHumanId:'owner'});
  f.keys['late-host']=f.store.issueAccessKey('commons','late-host');
  await api('owner',{action:'configure',expectedRevision:0,name:'Room',coordinatorMemberId:'late-host'});
  await api('owner',{action:'invoke',runId:'older-run',sourceMessageId:'before-host'});
  const claim={action:'claim',requestId:'old-claim',runId:'older-run',attemptId:'late-attempt',expectedRevision:0};
  await api('late-host',claim);
  command('room.history_visibility_set',{historyVisibility:'since_join'});
  assert.equal((await api('late-host')).runs.length,0,'live pre-join source is outside the current history floor');
  await api('late-host',claim,404);
  const response=await fetch(`${origin}/api/rooms/commons/commands`,{method:'POST',headers:{authorization:`Bearer ${f.keys.owner}`,'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),type:'message.deleted',data:{messageId:'before-host',expectedMessageRevision:0}})});
  assert.equal(response.status,201,await response.text());
  assert.equal((await api('late-host')).runs.length,0,'reserved host does not gain access to pre-join source metadata');
  await api('late-host',claim,404);
  const stopped=await api('owner',{action:'cancel',runId:'older-run',expectedRevision:1});
  assert.equal(stopped.result.sourceDeleted,true); assert.doesNotMatch(JSON.stringify(stopped),/ERASED-HISTORY/);
  await api('late-host',{action:'report',runId:'older-run',attemptId:'late-attempt',expectedRevision:2,state:'cancelled',summary:'Stopped'},404);
});

test('completed historical report replay after deletion strips result links and activity without reviving execution', async t => {
  const {api,message,origin,f}=await setup(t);
  await api('owner',{action:'configure',expectedRevision:0,name:'Room',coordinatorMemberId:'producer'});
  message('owner','done-opening','ERASED-DONE-PROMPT');
  await api('owner',{action:'invoke',runId:'done-deleted',sourceMessageId:'done-opening'});
  await api('producer',{action:'claim',runId:'done-deleted',attemptId:'done-host',expectedRevision:0});
  message('producer','done-result','ERASED-DONE-RESULT');
  const completed={action:'report',requestId:'done-before-delete',runId:'done-deleted',attemptId:'done-host',expectedRevision:1,state:'done',summary:'ERASED-DONE-SUMMARY',resultMessageId:'done-result',appliedInputMessageIds:['done-opening']};
  await api('producer',completed);
  const deleted=await fetch(`${origin}/api/rooms/commons/commands`,{method:'POST',headers:{authorization:`Bearer ${f.keys.owner}`,'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),type:'message.deleted',data:{messageId:'done-opening',expectedMessageRevision:0}})});
  assert.equal(deleted.status,201,await deleted.text());
  const replay=await api('producer',completed);
  assert.equal(replay.result.status,'done');assert.equal(replay.result.revision,2);assert.equal(replay.result.attemptId,'done-host');
  assert.equal(replay.result.sourceDeleted,true);assert.equal(Object.hasOwn(replay.result,'resultMessageId'),false);
  assert.deepEqual(replay.result.inputs,[]);assert.deepEqual(replay.result.activity,[]);assert.doesNotMatch(JSON.stringify(replay),/ERASED-DONE/);
  await api('producer',{...completed,requestId:'new-done',expectedRevision:2},404);
  await api('owner',{action:'resume',runId:'done-deleted',expectedRevision:2},404);
  assert.equal(JSON.parse(f.store.db.prepare('SELECT value FROM room_assistant_runs WHERE run_id=?').get('done-deleted').value).revision,2);
});

test('publish posts the answer and completes the run atomically (SV-1 fence)', async t => {
  const { f, api, message } = await setup(t);
  await api('owner',{action:'configure',expectedRevision:0,name:'Room',coordinatorMemberId:'producer'});
  message('owner','ask-opening','What should we build?');
  await api('owner',{action:'invoke',runId:'fenced',sourceMessageId:'ask-opening'});
  await api('producer',{action:'claim',runId:'fenced',attemptId:'host-1',expectedRevision:0});
  const published = await api('producer',{action:'publish',requestId:'publish-once',runId:'fenced',attemptId:'host-1',expectedRevision:1,summary:'Answered.',body:'Build the fence.',appliedInputMessageIds:['ask-opening']});
  assert.equal(published.result.status,'done');
  assert.ok(published.result.resultMessageId);
  const posted = f.store.room('commons').state.messages.find(m => m.id === published.result.resultMessageId);
  assert.equal(posted?.body,'Build the fence.');
  assert.equal(posted?.replyToId,'ask-opening');
  assert.equal(posted?.authorId,'producer');
  assert.deepEqual(published.result.inputs.map(i=>i.status),['applied']);
  // An exact retry replays the recorded receipt: no second message is posted.
  const replay = await api('producer',{action:'publish',requestId:'publish-once',runId:'fenced',attemptId:'host-1',expectedRevision:1,summary:'Answered.',body:'Build the fence.',appliedInputMessageIds:['ask-opening']});
  assert.deepEqual(replay,published);
  assert.equal(f.store.room('commons').state.messages.filter(m => m.body === 'Build the fence.').length,1);
  assert.equal((await api('owner')).runs[0].status,'done');
});

test('a stop that lands before publish fences the answer out of chat (SV-1)', async t => {
  const { f, api, message } = await setup(t);
  await api('owner',{action:'configure',expectedRevision:0,name:'Room',coordinatorMemberId:'producer'});
  message('owner','stop-opening','Work on this.');
  await api('owner',{action:'invoke',runId:'stopped',sourceMessageId:'stop-opening'});
  await api('producer',{action:'claim',runId:'stopped',attemptId:'host-1',expectedRevision:0});
  const cancel = await api('owner',{action:'cancel',runId:'stopped',expectedRevision:1});
  assert.equal(cancel.result.status,'cancel_requested');
  await api('producer',{action:'publish',runId:'stopped',attemptId:'host-1',expectedRevision:2,summary:'Late answer.',body:'Too late.',appliedInputMessageIds:['stop-opening']},409);
  assert.equal(f.store.room('commons').state.messages.some(m => m.body === 'Too late.'),false,'no answer may appear in chat after a stop');
  assert.equal((await api('owner')).runs[0].status,'cancel_requested');
});

test('publish with a stale revision is rejected before anything is posted', async t => {
  const { f, api, message } = await setup(t);
  await api('owner',{action:'configure',expectedRevision:0,name:'Room',coordinatorMemberId:'producer'});
  message('owner','rev-opening','Work on this.'); message('guest','rev-input','More context.');
  await api('owner',{action:'invoke',runId:'revved',sourceMessageId:'rev-opening'});
  await api('producer',{action:'claim',runId:'revved',attemptId:'host-1',expectedRevision:0});
  await api('guest',{action:'contribute',runId:'revved',sourceMessageId:'rev-input',expectedRevision:1});
  await api('producer',{action:'publish',runId:'revved',attemptId:'host-1',expectedRevision:1,summary:'Stale.',body:'Stale answer.',appliedInputMessageIds:['rev-opening','rev-input']},409);
  assert.equal(f.store.room('commons').state.messages.some(m => m.body === 'Stale answer.'),false);
  assert.equal((await api('owner')).runs[0].status,'working');
});

test('cancel on a silent host completes immediately and revokes the attempt (independent stop)', async t => {
  const { f, api, message } = await setup(t);
  await api('owner',{action:'configure',expectedRevision:0,name:'Room',coordinatorMemberId:'producer'});
  message('owner','silent-opening','Work on this.');
  await api('owner',{action:'invoke',runId:'silent',sourceMessageId:'silent-opening'});
  await api('producer',{action:'claim',runId:'silent',attemptId:'host-1',expectedRevision:0});
  const now = f.store.now(); f.store.now = () => now + 121000;
  const stopped = await api('owner',{action:'cancel',runId:'silent',expectedRevision:1});
  assert.equal(stopped.result.status,'cancelled');
  assert.equal(stopped.result.attemptId,null);
  assert.equal(stopped.result.stopOutcome,'attempt_revoked');
  assert.equal((await api('owner')).runs[0].displayStatus,'unknown');
  assert.match(stopped.result.activity.at(-1).summary,/execution could not be confirmed/i);
  // The revoked attempt can no longer report or publish.
  await api('producer',{action:'report',runId:'silent',attemptId:'host-1',expectedRevision:2,state:'cancelled',summary:'Late ack'},409);
  await api('producer',{action:'publish',runId:'silent',attemptId:'host-1',expectedRevision:2,summary:'Late.',body:'Late answer.',appliedInputMessageIds:['silent-opening']},409);
  assert.equal((await api('owner')).runs[0].status,'cancelled');
});

test('cancel on a live host still waits for host acknowledgment', async t => {
  const { api, message } = await setup(t);
  await api('owner',{action:'configure',expectedRevision:0,name:'Room',coordinatorMemberId:'producer'});
  message('owner','live-opening','Work on this.');
  await api('owner',{action:'invoke',runId:'live',sourceMessageId:'live-opening'});
  await api('producer',{action:'claim',runId:'live',attemptId:'host-1',expectedRevision:0});
  const requested = await api('owner',{action:'cancel',runId:'live',expectedRevision:1});
  assert.equal(requested.result.status,'cancel_requested');
  assert.equal(requested.result.attemptId,'host-1');
  const ack = await api('producer',{action:'report',runId:'live',attemptId:'host-1',expectedRevision:2,state:'cancelled',summary:'Stopping.'});
  assert.equal(ack.result.status,'cancelled');
});

test('ask card statuses: 10s-not-picked-up and 2min-stalled', async t => {
  const { f, api, message } = await setup(t);
  await api('owner',{action:'configure',expectedRevision:0,name:'Room',coordinatorMemberId:'producer'});
  message('owner','slow-prompt','Take your time.');
  await api('owner',{action:'invoke',runId:'slow',sourceMessageId:'slow-prompt'});
  message('owner','work-prompt','Do the thing.');
  await api('owner',{action:'invoke',runId:'busy',sourceMessageId:'work-prompt'});
  await api('producer',{action:'claim',runId:'busy',attemptId:'host-1',expectedRevision:0});
  const statuses = async () => new Map((await api('owner')).runs.map(r => [r.id, r.displayStatus]));
  const raw = async () => new Map((await api('owner')).runs.map(r => [r.id, r.status]));
  assert.deepEqual([...await statuses()].sort(),[['busy','working'],['slow','queued']]);
  const now = f.store.now(); f.store.now = () => now + 11000;
  assert.equal((await statuses()).get('slow'),'not_picked_up','queued 11s with no claim reads not picked up');
  assert.equal((await raw()).get('slow'),'queued','the raw status stays queued so a host can still claim it');
  assert.equal((await statuses()).get('busy'),'working','claimed 11s ago with a fresh host report still reads working');
  f.store.now = () => now + 121000;
  assert.equal((await statuses()).get('slow'),'not_picked_up');
  assert.equal((await statuses()).get('busy'),'stalled','working with no host update for 2min reads stalled');
  assert.equal((await raw()).get('busy'),'unknown');
  await api('producer',{action:'claim',runId:'slow',attemptId:'host-2',expectedRevision:0});
  assert.equal((await raw()).get('slow'),'working','a long-unclaimed run is still claimable');
  // A fresh host report clears the stall.
  await api('producer',{action:'report',runId:'busy',attemptId:'host-1',expectedRevision:1,state:'working',summary:'Still on it.'});
  assert.equal((await statuses()).get('busy'),'working');
});

// R36-2 (repro for the owner; expected behaviour, red on 1e8982e2). The
// autonomy-tier contract says a read-only agent's stops always land
// (server/autonomy-tiers.mjs T1_READONLY_ALLOWED_COMMANDS), but the shared
// assistant refuses every coordinator report from a t1_readonly host, and
// resume does not check the tier at all.
const r36Paused = async (api, runId) => {
  await api('owner',{action:'configure',expectedRevision:0,name:'Room',coordinatorMemberId:'producer'});
  await api('owner',{action:'invoke',runId,sourceMessageId:'test-welcome'});
  await api('producer',{action:'claim',runId,attemptId:'original',expectedRevision:0});
};
test('R36-2: a coordinator demoted to read-only can still acknowledge a stop', async t => {
  const { f, api } = await setup(t);
  await r36Paused(api, 'r36-stop');
  demoteToReadonly(f.store.db, 'commons', 'producer', { updatedBy: 'owner' });
  const stop = await api('owner',{action:'cancel',runId:'r36-stop',expectedRevision:1});
  assert.equal(stop.result.status, 'cancel_requested');
  await api('producer',{action:'report',runId:'r36-stop',attemptId:'original',expectedRevision:2,state:'cancelled',summary:'Stopped.'});
});
test('R36-2: resume is refused up front when the coordinator was demoted to read-only while paused', async t => {
  const { f, api } = await setup(t);
  await r36Paused(api, 'r36-resume');
  await api('owner',{action:'pause',runId:'r36-resume',expectedRevision:1});
  await api('producer',{action:'report',runId:'r36-resume',attemptId:'original',expectedRevision:2,state:'paused',summary:'Paused.'});
  demoteToReadonly(f.store.db, 'commons', 'producer', { updatedBy: 'owner' });
  await api('owner',{action:'resume',runId:'r36-resume',expectedRevision:3}, 409);
});


test('demoted Stop acknowledgment is exact-attempt and cannot acknowledge inputs or keep working', async t => {
  const { f, api } = await setup(t);
  await r36Paused(api, 'restricted-stop');
  demoteToReadonly(f.store.db, 'commons', 'producer', { updatedBy: 'owner' });
  const report={action:'report',runId:'restricted-stop',attemptId:'original',expectedRevision:1,state:'cancelled',summary:'Stopped.'};
  await api('producer',report,403);
  await api('owner',{action:'pause',runId:'restricted-stop',expectedRevision:1});
  await api('producer',{...report,expectedRevision:2,attemptId:'foreign'},403);
  await api('producer',{...report,expectedRevision:2,state:'working'},403);
  await api('producer',{...report,expectedRevision:2,state:'paused',appliedInputMessageIds:['test-welcome']},403);
  await api('producer',{...report,expectedRevision:2,state:'paused',resultMessageId:'test-welcome'},403);
  await api('producer',{action:'draft',runId:'restricted-stop',attemptId:'original',expectedRevision:2,sequence:1,body:'Must not stream'},403);
  const paused=await api('producer',{...report,expectedRevision:2,state:'paused'});
  assert.equal(paused.result.status,'paused');
  assert.equal(paused.result.inputs[0].status,'pending');
  await api('owner',{action:'resume',runId:'restricted-stop',expectedRevision:3},409);
});
