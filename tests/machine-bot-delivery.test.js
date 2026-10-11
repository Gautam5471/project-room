import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { MachineBot } from '../machine/bot/loop.mjs';
import { createRoomApi } from '../machine/bot/room-api.mjs';

for (const failure of ['message-rejected', 'message-lost', 'claim-lost', 'receipt-rejected', 'halt-during-receipt', 'update-not-found', 'halt-during-claim']) {
  test(`finished machine work survives restart after ${failure}`, async t => {
    const f = createAcceptanceFixture(), home = mkdtempSync(join(tmpdir(), 'machine-delivery-'));
    const server = createRoomServer({ store: f.store });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      f.store.close(); rmSync(f.directory, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const api = createRoomApi({ origin, secret: f.keys.owner });
    for (const id of ['delivery-work', 'delivery-lease']) {
      assert.equal((await api.createClaim('commons', { id, title: id, reviewPolicy: 'self_attested' })).ok, true);
      assert.equal((await api.takeClaim('commons', id, {})).ok, true);
    }
    const setup = bot => {
      bot.config = { roomOrigin: origin, label: 'Test machine' }; bot.secret = f.keys.owner; bot.api = api;
      bot.provider = { next: async () => { assert.fail('completed work must never call the provider again'); } };
      return bot;
    };
    const bot = setup(new MachineBot({ home, env: {} }));
    bot.active = { roomId: 'commons', workId: 'delivery-work', leaseId: 'delivery-lease', slot: 'desk', messageId: null, observations: [] };
    if (failure === 'update-not-found') Object.assign(bot.active, { updateId: 'gone-update', basisToken: `ub1_${'0'.repeat(64)}` });
    const realFetch = globalThis.fetch;
    let failed = false;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      const target = failure === 'halt-during-claim' ? String(url).endsWith('/delivery-work/update') && JSON.parse(options.body).state === 'in_progress' : ['receipt-rejected', 'halt-during-receipt'].includes(failure) ? String(url).endsWith('/files') : failure === 'claim-lost'
        ? String(url).endsWith('/delivery-work/update') && JSON.parse(options.body).state === 'done'
        : String(url).endsWith('/commands');
      if (!failed && target) {
        failed = true;
        if (['halt-during-receipt', 'halt-during-claim'].includes(failure)) { const response = await realFetch(url, options); bot.daemon = { state: { halted: true } }; return response; }
        if (!['message-rejected', 'receipt-rejected'].includes(failure)) await realFetch(url, options);
        return new Response('{}', { status: 503 });
      }
      return realFetch(url, options);
    });
    const first = await bot.finish('The finished result.');
    if (failure.startsWith('halt-during')) assert.equal(f.store.room('commons').state.messages.filter(m => m.body.startsWith('The finished result.')).length, 0);
    assert.notEqual(first.done, true, 'a missing delivery acknowledgement is not done');
    const resumed = setup(new MachineBot({ home, env: {} }));
    resumed.daemon = { state: { halted: true, slots: { desk: { claimId: 'another-lease' } } } };
    await resumed.haltActive();
    assert.equal((await resumed.continueActive()).deliveryPending, true, 'halt keeps the finished result');
    resumed.daemon.state.halted = false;
    const result = await resumed.continueActive();
    assert.equal(result.done, true);
    const messages = f.store.room('commons').state.messages.filter(m => m.body.startsWith('The finished result.'));
    assert.equal(messages.length, 1, 'retry must publish exactly one result');
    assert.ok((await api.claim('commons', 'delivery-work')).value.blobs.length > 0, 'completion includes its acknowledged receipt');
    assert.equal(resumed.active, null);
    assert.equal(resumed.daemon.state.slots.desk.claimId, 'another-lease', 'delayed delivery does not clear a new slot holder');
  });
}

for (const throws of [false, true]) {
  test(`a ${throws ? 'thrown transport error' : 'failed poll'} does not busy-loop`, async t => {
    const home = mkdtempSync(join(tmpdir(), 'machine-backoff-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const bot = new MachineBot({ home, env: {} });
    let calls = 0;
    bot.once = async () => {
      if (++calls === 2) await bot.stop();
      if (throws) throw new Error('offline');
      return { polled: false };
    };
    // Keep the process alive while the production loop's unref'ed timer waits.
    const keepAlive = setInterval(() => {}, 100);
    const started = performance.now();
    try { await bot.run(); } finally { clearInterval(keepAlive); }
    assert.ok(performance.now() - started >= 800, 'wait before retrying a failed request');
    assert.equal(calls, 2);
  });
}
