// HS2 3a: the ask card face picks the request people are waiting on and says
// plainly where it is, including "not picked up" at 10 s and "stalled".
import test from 'node:test';
import assert from 'node:assert/strict';
import { askFaceStatus, faceRun, soloUnaddressed, NOT_PICKED_UP_MS } from '../src/human-experience.js';

test('a queued ask reads Asked, then Not picked up at 10 s', () => {
  const run = { id: 'r', status: 'queued', createdAt: 1_000 };
  assert.equal(askFaceStatus(run, 1_000 + NOT_PICKED_UP_MS - 1).key, 'asked');
  assert.equal(askFaceStatus(run, 1_000 + NOT_PICKED_UP_MS).key, 'not_picked_up');
  assert.match(askFaceStatus(run, 1_000 + NOT_PICKED_UP_MS).text, /Your request will wait/);
  assert.equal(askFaceStatus({ ...run, createdAt: 5_000 }, 1_000).key, 'asked', 'a clock behind the server never reads as late');
});

test('a host silent past the window reads Stalled with a way out; other states keep honest words', () => {
  assert.equal(askFaceStatus({ status: 'unknown', createdAt: 0 }, 1e9).key, 'stalled');
  assert.match(askFaceStatus({ status: 'unknown' }).text, /You can stop it/);
  assert.equal(askFaceStatus({ status: 'cancelled' }).text, 'Stopped');
  assert.equal(askFaceStatus({ status: 'done' }).text, 'Result ready');
  assert.equal(askFaceStatus(null), null);
});

test('the face shows the newest open ask; with none open, the newest finished one', () => {
  const runs = { a: { id: 'a', status: 'done', createdAt: 30 }, b: { id: 'b', status: 'working', createdAt: 10 }, c: { id: 'c', status: 'queued', createdAt: 20 }, d: { id: 'd', status: 'queued', createdAt: 40, sourceDeleted: true } };
  assert.equal(faceRun(runs).id, 'c', 'open beats finished, newest open first, deleted prompts never surface');
  assert.equal(faceRun({ a: runs.a, x: { id: 'x', status: 'cancelled', createdAt: 5 } }).id, 'a');
  assert.equal(faceRun({}), null);
});

test('a one-person room asks Room only for messages addressed to no one else', () => {
  const members = { me: { id: 'me', displayName: 'Jon' }, room: { id: 'room', displayName: 'Producer' }, helper: { id: 'helper', displayName: 'Helper46c' }, gone: { id: 'gone', displayName: 'Old', active: false } };
  const messages = [{ id: 'mine', authorId: 'me' }, { id: 'answer', authorId: 'room' }, { id: 'theirs', authorId: 'helper' }];
  const ctx = (body, replyToId) => soloUnaddressed({ body, replyToId, members, messages, selfId: 'me', assistantId: 'room' });
  assert.equal(ctx('what changed today?'), true);
  assert.equal(ctx('@Helper46c please review'), false, 'a mention of another member is not a Room request');
  assert.equal(ctx('thanks @Helper46c, and what next?'), false);
  assert.equal(ctx('@Nobody what now?'), true, 'an unknown @name is unaddressed');
  assert.equal(ctx('@Old are you there?'), true, 'an inactive member is not addressed');
  assert.equal(ctx('and then?', 'mine'), true, 'a follow-up on my own message still asks Room');
  assert.equal(ctx('and then?', 'answer'), true, 'a follow-up on the assistant answer still asks Room');
  assert.equal(ctx('agreed', 'theirs'), false, 'a reply to another agent is addressed to that agent');
});
