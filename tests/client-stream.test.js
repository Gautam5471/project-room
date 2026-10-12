import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomClient } from '../src/client.js';

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(Math, 'random', () => 0);
  const streams = [], statuses = [];
  class Events extends EventTarget {
    constructor(url) { super(); this.url = url; this.readyState = 0; streams.push(this); }
    close() { this.readyState = 2; }
    emit(type, readyState) { this.readyState = readyState; this.dispatchEvent(new Event(type)); }
  }
  const session = { roomId: 'commons', member: { id: 'human' }, account: { id: 'account-human', authEpoch: 0 }, sessionBinding: 'binding-one' };
  const client = new RoomClient({ events: Events, onStatus: status => statuses.push(status), fetcher: async () => ({
    ok: true, json: async () => ({ sequence: 7, roomId: 'commons', viewerId: 'human',
      viewerAccountId: session.account.id, viewerAuthEpoch: 0, viewerSessionBinding: session.sessionBinding,
      viewerSessionRevision: session.sessionRevision })
  }) });
  client.session = session;
  t.after(() => client.disconnect());
  const emit = async (type, state) => { streams.at(-1).emit(type, state); await client.flight?.promise; };
  return { client, streams, statuses, emit };
}

test('native reconnect is preserved; closed streams retry once with bounded backoff and the current cursor', async t => {
  const { client, streams, statuses, emit } = fixture(t);
  client.connect();
  await emit('error', 0);
  t.mock.timers.tick(60000);
  assert.equal(streams.length, 1, 'CONNECTING remains owned by the browser');
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    const before = streams.length;
    await emit('error', 2); await emit('error', 2);
    t.mock.timers.tick(delay - 1);
    assert.equal(streams.length, before, 'duplicate errors cannot accelerate the retry');
    t.mock.timers.tick(1);
    assert.equal(streams.length, before + 1);
    assert.match(streams.at(-1).url, /after=7$/);
    assert.ok(!statuses.some(status => status.startsWith('Connected')));
  }
  await emit('open', 1);
  assert.match(statuses.at(-1), /^Connected/);
  await emit('error', 2);
  const before = streams.length;
  t.mock.timers.tick(1000);
  assert.equal(streams.length, before + 1, 'a real open resets backoff');
});

test('disconnect, access end, manual reconnect, and identity replacement invalidate pending stream retries', async t => {
  const { client, streams, emit } = fixture(t);
  for (const change of [
    () => client.disconnect(), () => client.endAccess(), () => client.connect(),
    () => { client.session = { ...client.session, sessionBinding: 'replacement' }; }
  ]) {
    client.session = { roomId: 'commons', member: { id: 'human' }, account: { id: 'account-human', authEpoch: 0 }, sessionBinding: 'binding-one' };
    client.connect(); await emit('error', 2);
    const obsolete = streams.at(-1);
    change();
    const before = streams.length;
    t.mock.timers.tick(60000);
    obsolete.emit('error', 2);
    t.mock.timers.tick(60000);
    assert.equal(streams.length, before, 'obsolete work cannot reopen another identity');
    client.disconnect();
  }
});

test('expired authorization ends access and cancels a queued closed-stream retry', async t => {
  const { client, streams } = fixture(t);
  client.connect();
  client.fetcher = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Session ended' } }) });
  streams[0].emit('error', 2);
  await client.flight.promise.catch(() => {});
  await Promise.resolve();
  t.mock.timers.tick(60000);
  assert.equal(client.session, null);
  assert.equal(streams.length, 1);
});

test('a queued reconnect rechecks account ownership without signing out the replacement account', async t => {
  const { client, streams, emit } = fixture(t);
  const session = client.session;
  session.authMode = 'account'; session.sessionRevision = 1;
  const account = { generation: 1, session: { ...session } };
  client.accountClient = account;
  client.accountOwnership = { client: account, generation: 1, session: account.session };
  client.connect();
  assert.match(streams[0].url, /auth=account&binding=binding-one$/);
  await emit('error', 2);
  assert.equal(client.session, session);
  assert.ok(client.streamRetry, 'the original account owns a pending retry');
  const replacement = { account: { id: 'other', authEpoch: 0 }, sessionBinding: 'other-binding' };
  account.session = replacement; account.generation++;
  t.mock.timers.tick(1000);
  assert.equal(client.session, null);
  assert.equal(streams.length, 1);
  assert.equal(account.session, replacement);
});

test('a late stream-refresh rejection cannot clear a replacement session', async t => {
  const { client, streams } = fixture(t);
  client.fetcher = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Old session ended' } }) });
  client.connect(); streams[0].emit('error', 0);
  const oldFlight = client.flight.promise;
  // Let request/refresh reject, but switch identity before the stream's outer catch.
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  client.disconnect();
  const replacement = { roomId: 'commons', member: { id: 'replacement' },
    account: { id: 'replacement-account', authEpoch: 0 }, sessionBinding: 'replacement-binding' };
  client.session = replacement; client.connect();
  await oldFlight.catch(() => {}); await Promise.resolve();
  assert.equal(client.session, replacement);
  assert.equal(streams.length, 2);
});

test('a transient unavailable stream and failed refresh preserve identity and reconnect without ending access', async t => {
  const { client, streams, emit } = fixture(t);
  const session = client.session, healthyFetch = client.fetcher;
  let ended = 0;
  client.onAccessEnded = () => ended++;
  client.connect(); await emit('open', 1);
  client.fetcher = async () => ({ ok: false, status: 503, json: async () => ({ error: { code: 'storage_unavailable', message: 'Temporarily unavailable' } }) });
  streams[0].emit('unavailable', 1);
  await emit('error', 2).catch(() => {});
  await Promise.resolve();
  assert.equal(client.session, session);
  assert.equal(ended, 0);
  client.fetcher = healthyFetch;
  t.mock.timers.tick(1000);
  assert.equal(streams.length, 2);
  assert.match(streams[1].url, /after=7$/);
  await emit('open', 1);
  assert.equal(client.session, session);
  assert.equal(ended, 0);
});

function followUpSnapshot(client, sequence) {
  return {
    ok: true,
    json: async () => ({
      sequence, roomId: 'commons', viewerId: 'human',
      viewerAccountId: client.session.account.id, viewerAuthEpoch: 0,
      viewerSessionBinding: client.session.sessionBinding,
      state: { messages: [{ id: `m-${sequence}` }] },
    }),
  };
}

function postEvent(stream, sequence) {
  stream.readyState = 1;
  stream.dispatchEvent(new MessageEvent('room-event', {
    data: JSON.stringify({ sequence, event: { type: 'message.posted', roomId: 'commons' } }),
  }));
}

test('a later successful read clears an interrupted open stream without replacing it', async t => {
  const { client, streams, statuses, emit } = fixture(t);
  client.connect();
  await emit('open', 1);
  client.fetcher = async () => ({ ok: false, status: 503, json: async () => ({ error: { code: 'storage_unavailable', message: 'Temporarily unavailable' } }) });
  postEvent(streams[0], 8);
  await client.flight.promise.catch(() => {});
  assert.match(statuses.at(-1), /Connection interrupted/);
  assert.equal(client.sequence, 7);
  client.fetcher = async () => followUpSnapshot(client, 9);
  postEvent(streams[0], 9);
  await client.flight.promise;
  assert.equal(streams.length, 1, 'the live stream stays open');
  assert.equal(client.sequence, 9);
  assert.match(statuses.at(-1), /^Connected/);
});

test('a failed follow-up read on an open stream is retried without replacing the stream', async t => {
  const { client, streams, statuses, emit } = fixture(t);
  client.connect();
  await emit('open', 1);
  let reads = 0;
  client.fetcher = async () => {
    reads += 1;
    if (reads === 1) return { ok: false, status: 503, json: async () => ({ error: { code: 'storage_unavailable', message: 'Temporarily unavailable' } }) };
    return followUpSnapshot(client, 8);
  };
  postEvent(streams[0], 8);
  await client.flight.promise.catch(() => {});
  assert.equal(reads, 1);
  assert.equal(client.sequence, 7);
  assert.equal(streams.length, 1);
  assert.equal(streams[0].readyState, 1);
  assert.match(statuses.at(-1), /Connection interrupted/);
  t.mock.timers.tick(1000);
  await client.flight?.promise;
  assert.equal(reads, 2, 'the failed read is retried while the stream stays open');
  assert.equal(streams.length, 1);
  assert.equal(client.sequence, 8);
  assert.match(statuses.at(-1), /^Connected/);
});

test('a dm.consent_changed stream receipt fires onConsentChange; other receipts do not', async t => {
  const { client, streams, emit } = fixture(t);
  const fires = [];
  client.onConsentChange = () => fires.push(1);
  client.connect();
  await emit('open', 1);
  client.fetcher = async () => followUpSnapshot(client, 8);
  streams[0].dispatchEvent(new MessageEvent('room-event', {
    data: JSON.stringify({ sequence: 8, event: { type: 'dm.consent_changed', roomId: 'commons' } }),
  }));
  await client.flight.promise.catch(() => {});
  assert.equal(fires.length, 1, 'the consent receipt fires the hook');
  client.fetcher = async () => followUpSnapshot(client, 9);
  streams[0].dispatchEvent(new MessageEvent('room-event', {
    data: JSON.stringify({ sequence: 9, event: { type: 'message.posted', roomId: 'commons' } }),
  }));
  await client.flight.promise.catch(() => {});
  assert.equal(fires.length, 1, 'other receipts leave the hook alone');
});
