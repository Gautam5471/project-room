import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
test('real PR receiver rejects unauthorized requests and links a signed PR exactly once', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'room-pr-receiver-'));
  const store = new RoomStore(join(directory, 'room.sqlite')); store.initialize(initialRoom());
  const server = createRoomServer({ store }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const oldFlag = process.env.ROOM_PR_WEBHOOK, oldSecret = process.env.GITHUB_PR_WEBHOOK_SECRET;
  t.after(() => { server.closeStreams(); server.closeAllConnections(); server.close(); store.close(); rmSync(directory, {recursive:true,force:true});
    if(oldFlag===undefined) delete process.env.ROOM_PR_WEBHOOK; else process.env.ROOM_PR_WEBHOOK=oldFlag;
    if(oldSecret===undefined) delete process.env.GITHUB_PR_WEBHOOK_SECRET; else process.env.GITHUB_PR_WEBHOOK_SECRET=oldSecret;
  });
  const url = `http://127.0.0.1:${server.address().port}/api/github/pr-webhook`;
  const body = JSON.stringify({zen:'receipt test'});
  const send = signature => fetch(url,{method:'POST',headers:{'content-type':'application/json','x-github-event':'ping',...(signature?{'x-hub-signature-256':signature}:{})},body});
  delete process.env.ROOM_PR_WEBHOOK; delete process.env.GITHUB_PR_WEBHOOK_SECRET;
  assert.equal((await send()).status,404);
  process.env.ROOM_PR_WEBHOOK='1'; assert.equal((await send()).status,503);
  process.env.GITHUB_PR_WEBHOOK_SECRET='isolated-http-fixture'; assert.equal((await send('sha256='+'0'.repeat(64))).status,401);
  const signature = 'sha256='+createHmac('sha256','isolated-http-fixture').update(body).digest('hex');
  const response=await send(signature); assert.equal(response.status,200); assert.deepEqual(await response.json(),{ok:true,ignored:true});
  // Exercise actual body reading, route dispatch and durable claim mutation.
  // Direct-handler tests cannot detect a mounted route dropping this payload.
  const origin = new URL(url).origin;
  const token = store.issueAccessKey('commons', 'owner');
  const call = async (path, data) => {
    const result = await fetch(`${origin}/api/rooms/commons/work-claims${path}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, Origin: origin, 'Content-Type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: result.status, body: await result.json() };
  };
  assert.equal((await call('', { id: 'contributor-fix', repo: 'example/project', files: ['src/fix.js'] })).status, 201);
  assert.equal((await call('/contributor-fix/claim', { leaseHours: 1 })).status, 200);
  const payload = JSON.stringify({ action: 'opened', repository: { full_name: 'example/project' },
    pull_request: { html_url: 'https://github.com/example/project/pull/7', number: 7,
      head: { ref: 'contributor-fix' }, title: 'Fix the reported issue', body: 'claim: contributor-fix', state: 'open', merged: false } });
  const prSignature = 'sha256=' + createHmac('sha256', 'isolated-http-fixture').update(payload).digest('hex');
  const deliver = raw => fetch(url, { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-GitHub-Event': 'pull_request', 'X-Hub-Signature-256': prSignature,
  }, body: raw });
  assert.equal((await deliver(payload + ' ')).status, 401, 'signature covers exact request bytes');
  assert.equal((await call('/contributor-fix')).body.pullRequests.length, 0);
  const accepted = await deliver(payload);
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).linked, 'contributor-fix');
  const linked = await call('/contributor-fix');
  assert.equal(linked.status, 200);
  assert.equal(linked.body.pullRequests.length, 1);
  assert.equal(linked.body.pullRequests[0].url, 'https://github.com/example/project/pull/7');
  const repeated = await deliver(payload);
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).linked, null);
  const replayed = await call('/contributor-fix');
  assert.equal(replayed.body.pullRequests.length, 1, 'redelivery does not add another PR');
  assert.equal(replayed.body.history.length, linked.body.history.length, 'redelivery does not add another claim update');

});
