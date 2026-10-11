import test from 'node:test';
import assert from 'node:assert/strict';
import { roomOrientation } from '../src/work-selectors.js';

const base = () => ({ room: { purpose: 'Original purpose' }, workItems: {}, eventLog: [] });
test('orientation follows current instructions and clearing restores the room purpose', () => {
  const state = base();
  state.room.charter = { purpose: 'Current purpose', revision: 2, eventId: 'charter-2', updatedById: 'owner', updatedAt: '2026-09-20T00:00:00Z' };
  const view = roomOrientation(state);
  assert.equal(view.purpose, 'Current purpose');
  assert.deepEqual(view.purposeSource, { kind: 'instructions', revision: 2, eventId: 'charter-2', authorId: 'owner', updatedAt: '2026-09-20T00:00:00Z' });
  state.room.charter.purpose = null;
  assert.equal(roomOrientation(state).purpose, 'Original purpose');
  assert.deepEqual(roomOrientation(state).purposeSource, { kind: 'room' });
});
test('orientation bounds current work, excludes history and retains source identities without mutating state', () => {
  const state = base();
  for (const [id, status] of [['a', 'working'], ['b', 'blocked'], ['c', 'accepted'], ['d', 'proposed'], ['e', 'completed'], ['f', 'superseded']]) {
    state.workItems[id] = { id, title: id, state: status, revision: 1, updatedAt: '2026-09-20T00:00:00Z', receipt: { summary: 'not included' } };
  }
  state.workItems.a.supersededBy = 'replacement';
  state.eventLog = Array.from({ length: 5 }, (_, i) => ({ id: `event-${i}`, type: 'decision.recorded', actorId: 'owner', at: `time-${i}`, data: { statement: `decision-${i}`, sourceMessageId: `message-${i}` } }));
  const before = JSON.stringify(state), view = roomOrientation(state);
  assert.deepEqual(view.activeWork.map(w => w.id), ['b', 'c', 'd']);
  assert.equal(view.activeWorkTotal, 3);
  assert.equal(view.activeWork[0].receipt, undefined);
  assert.deepEqual(view.recentDecisions.map(d => d.sourceMessageId), ['message-4', 'message-3', 'message-2']);
  view.activeWork[0].title = 'changed';
  view.recentDecisions[0].statement = 'changed';
  assert.equal(JSON.stringify(state), before);
  delete state.workItems.a.supersededBy;
  assert.equal(roomOrientation(state).activeWorkTotal, 4);
  assert.equal(roomOrientation(state).activeWork.length, 3);
});

test('orientation keeps a submitted result that still waits on verification or a decision as active work', () => {
  const state = base();
  const receipt = { eventId: 'complete-1', evidenceVersion: 'v1', summary: 'Three venues' };
  const at = '2026-10-11T00:00:00Z';
  state.workItems.review = { id: 'review', title: 'Awaiting verification', state: 'completed', revision: 3, updatedAt: at, receipt, independentVerificationRequired: true, verifications: [] };
  state.workItems.decide = { id: 'decide', title: 'Awaiting decision', state: 'completed', revision: 3, updatedAt: at, receipt, ownerDecisionRequired: true };
  state.workItems.done = { id: 'done', title: 'Done', state: 'completed', revision: 3, updatedAt: at, receipt };
  state.workItems.bare = { id: 'bare', title: 'No receipt', state: 'completed', revision: 1, updatedAt: at, receipt: { summary: 'not a submission' } };
  const view = roomOrientation(state);
  assert.deepEqual(view.activeWork.map(w => w.id).sort(), ['decide', 'review']);
  assert.equal(view.activeWorkTotal, 2);
});
