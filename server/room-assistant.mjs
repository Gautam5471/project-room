import { enforceAutonomyTierForAction, getTier } from './autonomy-tiers.mjs';
import { validId, messageChannelId, MAX_MESSAGE_BODY_CHARS } from '../src/events.js';
import { conversationIndex } from '../src/conversation.js';
import { isGuestAgentMemberId } from './guest-agent-links.mjs';
import { historyFloor, messageInHistory, messageVisibleToViewer } from './history-visibility.mjs';
import { createHash } from 'node:crypto';

// Coordination records reserve one publisher. A host claim is an observation,
// not a hosted execution service, and never grants that host additional rights.
export const roomAssistantSchema = `
CREATE TABLE IF NOT EXISTS room_assistant_config (room_id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS room_assistant_runs (room_id TEXT NOT NULL, run_id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(room_id,run_id));
CREATE TABLE IF NOT EXISTS room_assistant_ops (room_id TEXT NOT NULL, actor_id TEXT NOT NULL, request_id TEXT NOT NULL, input TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(room_id,actor_id,request_id));`;
const fail = (code, message, status = 409) => { throw Object.assign(new Error(message), { code, status }); };
const terminal = new Set(['done', 'cancelled', 'failed']);
// A host that has not reported within this window is treated as silent: the
// run reads stalled/unknown. Stop revokes publication but cannot confirm execution ended.
const hostStaleAfterMs = 120000;
// A queued run nobody claimed within this window reads not picked up.
const notPickedUpAfterMs = 10000;
const keys = {
  configure: ['name', 'coordinatorMemberId', 'expectedRevision'], invoke: ['runId', 'sourceMessageId'],
  contribute: ['runId', 'sourceMessageId', 'expectedRevision', 'conflict'],
  resolve: ['runId', 'sourceMessageId', 'expectedRevision'],
  claim: ['runId', 'attemptId', 'expectedRevision'],
  draft: ['runId', 'attemptId', 'expectedRevision', 'sequence', 'body'],
  report: ['runId', 'attemptId', 'expectedRevision', 'state', 'summary', 'resultMessageId', 'appliedInputMessageIds'],
  // publish is the SV-1 fence: the server posts the run's answer in the same
  // transaction that completes the run, so a stop that landed first rejects
  // the publish and a stopped run can never leave its answer in chat.
  publish: ['runId', 'attemptId', 'expectedRevision', 'summary', 'body', 'appliedInputMessageIds'],
  resume: ['runId', 'expectedRevision'], pause: ['runId', 'expectedRevision', 'expectedAttemptId'], cancel: ['runId', 'expectedRevision', 'expectedAttemptId']
};
// Deleted prompts retain only a stop handle for their existing controllers.
// The history floor still applies: deletion cannot reveal older work to newcomers.
// Display-only status for the ask card, returned as run.displayStatus next to
// the raw run.status (hosts key their claim loop on status === 'queued', so
// status must never be rewritten to a label). queued past the pickup window reads
// not_picked_up; a working run whose host went silent reads stalled; a
// working run that never reported reads unknown (legacy rows only — claim
// always stamps hostReportedAt).
const derivedRunStatus = (run, now) => {
  if (run.stopOutcome === 'attempt_revoked') return 'unknown';
  if (run.status === 'queued' && now - run.createdAt > notPickedUpAfterMs) return 'not_picked_up';
  if (run.status === 'working') {
    if (!Number.isFinite(run.hostReportedAt)) return 'unknown';
    if (now - run.hostReportedAt > hostStaleAfterMs) return 'stalled';
  }
  return run.status;
};
const controlsDeletedSource = (run, opening, actor, state, floor) => Boolean(
  opening?.deletedAt && opening.body == null && !opening.toMemberId && messageInHistory(opening, floor)
  && (actor.kind === 'human' && (actor.id === run.initiatorId || actor.id === state.room.ownerId)
    || actor.kind === 'agent' && actor.id === run.coordinatorMemberId && run.attemptId && actor.permissions.includes('accept_work')));
const deletedControl = run => Object.fromEntries([
  ...['id', 'sourceMessageId', 'initiatorId', 'coordinatorMemberId', 'status', 'revision', 'attemptId', 'createdAt', 'updatedAt', 'hostReportedAt', 'stopOutcome'].map(key => [key, run[key]]),
  ['sourceDeleted', true], ['inputs', []], ['activity', []]
]);
// Reads and receipt replays share current visibility. A committed operation
// remains idempotent, but its old receipt is not a grant to hidden history.
const visibleRun = (run, state, actor, floor) => {
  const opening = state.messages.find(message => message.id === run.sourceMessageId);
  if (messageVisibleToViewer(opening, actor.id, floor)) return run;
  return controlsDeletedSource(run, opening, actor, state, floor) ? deletedControl(run) : null;
};
// Called only after a validated message edit, inside the command transaction.
// The run revision fences both publication and acknowledgements: an ID still
// refers to the same message after editing, but no longer to the same input.
export function invalidateEditedAssistantInput(db, roomId, messageId, at) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='room_assistant_runs'").get()) return;
  const rows = db.prepare(`SELECT runs.run_id,runs.value FROM room_assistant_runs AS runs
    WHERE runs.room_id=? AND json_extract(runs.value,'$.status') NOT IN ('done','cancelled','failed')
    AND EXISTS (SELECT 1 FROM json_each(json_extract(runs.value,'$.inputs')) AS entry
      WHERE json_extract(entry.value,'$.sourceMessageId')=?)`).all(roomId, messageId);
  for (const row of rows) {
    const run = JSON.parse(row.value);
    for (const input of run.inputs) if (input.sourceMessageId === messageId) input.status = 'pending';
    delete run.answerDraft;
    run.revision++;
    run.updatedAt = at;
    db.prepare('UPDATE room_assistant_runs SET value=? WHERE room_id=? AND run_id=?')
      .run(JSON.stringify(run), roomId, row.run_id);
  }
}

export class RoomAssistant {
  constructor(store) { this.store = store; }
  init() { this.store.db.exec(roomAssistantSchema); }
  config(roomId) {
    const row = this.store.db.prepare('SELECT value FROM room_assistant_config WHERE room_id=?').get(roomId);
    return row ? JSON.parse(row.value) : { name: 'Room', coordinatorMemberId: null, revision: 0 };
  }
  list(roomId, authorize) {
    return this.store.readTransaction(() => {
      const auth = authorize();
      // Fresh installations have no configuration; reads must not mutate storage.
      if (!this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='room_assistant_config'").get())
        return { contractVersion: 1, roomId, assistant: { name: 'Room', coordinatorMemberId: null, revision: 0, availability: 'not_connected' }, runs: [] };
      const state = this.store.room(roomId).state;
      const config = this.config(roomId), coordinator = state.members[config.coordinatorMemberId];
      const floor = historyFloor(this.store.db, state, roomId, auth.member.id);
      // Keep unfinished requests discoverable by their host and controllers;
      // newer terminal history must not push pending work out of this window.
      const runs = this.store.db.prepare("SELECT value FROM room_assistant_runs WHERE room_id=? ORDER BY json_extract(value,'$.status') IN ('done','cancelled','failed'), rowid DESC LIMIT 100").all(roomId)
        .map(row => visibleRun(JSON.parse(row.value), state, auth.member, floor)).filter(Boolean)
        .map(run => ({ ...run, status: run.status === 'working' && (!Number.isFinite(run.hostReportedAt) || this.store.now() - run.hostReportedAt > hostStaleAfterMs) ? 'unknown' : run.status,
          displayStatus: derivedRunStatus(run, this.store.now()) }));
      const recent = runs.some(run => run.coordinatorMemberId === config.coordinatorMemberId && run.attemptId && Number.isFinite(run.hostReportedAt) && this.store.now() - run.hostReportedAt <= 120000 && !terminal.has(run.status));
      return { contractVersion: 1, roomId, assistant: { ...config, availability: !coordinator?.active || !coordinator.permissions.includes('accept_work') ? 'not_connected' : recent ? 'connected' : 'awaiting_host' }, runs };
    });
  }
  // postToken is the host's own credential, threaded from the route or MCP
  // dispatch. publish is the only action that needs it: the server posts the
  // run's answer as the coordinator inside the run transaction (SV-1 fence).
  apply(roomId, input, authorize, postToken = null) {
    if (!input || Array.isArray(input) || !Object.hasOwn(keys, input.action) || !validId(input.requestId)
      || Object.keys(input).some(key => !['action', 'requestId', ...keys[input.action]].includes(key)))
      fail('invalid_assistant_action', 'Choose an assistant action and stable request ID', 422);
    for (const key of ['runId', 'sourceMessageId', 'attemptId', 'resultMessageId'])
      if (input[key] !== undefined && !validId(input[key])) fail('invalid_assistant_action', `Invalid ${key}`, 422);
    if (Object.hasOwn(input, 'expectedAttemptId') && input.expectedAttemptId !== null && !validId(input.expectedAttemptId))
      fail('invalid_assistant_action', 'Invalid expectedAttemptId', 422);
    return this.store.transaction(() => {
      const auth = authorize(), state = this.store.room(roomId).state, actor = auth.member;
      if (isGuestAgentMemberId(actor.id) || actor.permissions?.some(p => p.startsWith('guest:')))
        fail('assistant_denied', 'Guests cannot coordinate shared work', 403);
      if (state.room.archivedAt) fail('assistant_archived', 'This room is archived');
      this.init();
      const config = this.config(roomId);
      const isOwner = state.room.ownerId === actor.id;
      const isHuman = actor.kind === 'human';
      const floor = historyFloor(this.store.db, state, roomId, actor.id);
      const canonical = JSON.stringify(Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b))));
      const old = input.action !== 'draft' && this.store.db.prepare('SELECT input,result FROM room_assistant_ops WHERE room_id=? AND actor_id=? AND request_id=?').get(roomId, actor.id, input.requestId);
      if (old) {
        if (old.input !== canonical) fail('assistant_retry_conflict', 'Retry ID already records different input');
        const response = JSON.parse(old.result);
        if (input.action === 'configure') return response;
        const result = visibleRun(response.result, state, actor, floor);
        if (!result) fail('assistant_run_missing', 'Request not found', 404);
        return { ...response, result };
      }
      const source = id => {
        const message = state.messages.find(m => m.id === id);
        if (!message || message.toMemberId || !messageVisibleToViewer(message, actor.id, floor) || message.authorId !== actor.id)
          fail('assistant_source_denied', 'Choose your own visible shared message', 403);
        return message;
      };
      const conversationSource = (id, opening) => {
        const message = source(id), { rootById } = conversationIndex(state.messages);
        // A channel prompt may receive a channel reply or a thread rooted in
        // that prompt. A prompt already inside a thread stays in that thread.
        const sameThread = opening.replyToId
          ? rootById.get(message.id) === rootById.get(opening.id)
          : !message.replyToId || rootById.get(message.id) === opening.id;
        if (messageChannelId(message) !== messageChannelId(opening) || !sameThread)
          fail('assistant_conversation_mismatch', 'Choose a message in the request conversation');
        return message;
      };
      let result;
      if (input.action === 'configure') {
        if (!isOwner) fail('assistant_denied', 'Only the room owner configures its assistant', 403);
        if (input.expectedRevision !== config.revision) fail('assistant_revision_conflict', 'Assistant settings changed; read them before retrying');
        if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 64
          || input.coordinatorMemberId !== null && (!validId(input.coordinatorMemberId) || state.members[input.coordinatorMemberId]?.kind !== 'agent' || !state.members[input.coordinatorMemberId]?.active || !state.members[input.coordinatorMemberId]?.permissions.includes('accept_work')))
          fail('invalid_assistant_config', 'Choose a name and an active room agent, or disconnect', 422);
        result = { name: input.name.trim(), coordinatorMemberId: input.coordinatorMemberId, revision: config.revision + 1 };
        this.store.db.prepare('INSERT INTO room_assistant_config VALUES(?,?) ON CONFLICT(room_id) DO UPDATE SET value=excluded.value').run(roomId, JSON.stringify(result));
        if (result.coordinatorMemberId !== config.coordinatorMemberId) {
          for (const row of this.store.db.prepare('SELECT run_id,value FROM room_assistant_runs WHERE room_id=?').all(roomId)) {
            const pending = JSON.parse(row.value);
            if (terminal.has(pending.status)) continue;
            if (!pending.attemptId) pending.coordinatorMemberId = result.coordinatorMemberId;
            else if (!['paused', 'cancel_requested', 'needs_input'].includes(pending.status)) pending.status = 'pause_requested';
            delete pending.answerDraft;
            pending.revision++;
            this.store.db.prepare('UPDATE room_assistant_runs SET value=? WHERE room_id=? AND run_id=?').run(JSON.stringify(pending), roomId, row.run_id);
          }
        }
      } else {
        if (!validId(input.runId)) fail('invalid_assistant_action', 'Choose a run ID', 422);
        const row = this.store.db.prepare('SELECT value FROM room_assistant_runs WHERE room_id=? AND run_id=?').get(roomId, input.runId);
        let run = row && JSON.parse(row.value);
        if (input.action === 'invoke') {
          if (!isHuman) fail('assistant_denied', 'A human explicitly asks the shared assistant', 403);
          source(input.sourceMessageId);
          const coordinator = state.members[config.coordinatorMemberId];
          if (!coordinator?.active || coordinator.kind !== 'agent' || !coordinator.permissions.includes('accept_work')) fail('assistant_not_connected', 'Connect an authorized room assistant before asking for work');
          if (run || this.store.db.prepare("SELECT 1 FROM room_assistant_runs WHERE room_id=? AND json_extract(value,'$.sourceMessageId')=?").get(roomId, input.sourceMessageId)) fail('assistant_run_exists', 'This message already has a shared request');
          run = { id: input.runId, sourceMessageId: input.sourceMessageId, initiatorId: actor.id,
            coordinatorMemberId: config.coordinatorMemberId, status: 'queued', revision: 0, attemptId: null,
            createdAt: this.store.now(), updatedAt: this.store.now(), hostReportedAt: null, inputs: [{ memberId: actor.id, sourceMessageId: input.sourceMessageId, status: 'pending' }], activity: [] };
        } else {
          if (!run) fail('assistant_run_missing', 'Request not found', 404);
          const opening = state.messages.find(m => m.id === run.sourceMessageId);
          if (!messageVisibleToViewer(opening, actor.id, floor)
            && !(controlsDeletedSource(run, opening, actor, state, floor)
              && (isHuman && ['pause', 'cancel'].includes(input.action)
                || actor.kind === 'agent' && input.action === 'report' && ['paused', 'cancelled', 'failed'].includes(input.state))))
            fail('assistant_run_missing', 'Request not found', 404);
          // Human controls bind to the execution they observed, not incidental
          // progress revisions. Explicit null binds a queued, unclaimed request.
          // Older clients retain their revision fence; never guess the attempt.
          const exactControl = ['pause', 'cancel'].includes(input.action) && Object.hasOwn(input, 'expectedAttemptId');
          if (exactControl) {
            if (input.expectedAttemptId !== run.attemptId) fail('assistant_attempt_changed', 'The execution changed; read it before controlling it');
          } else if (input.expectedRevision !== run.revision) fail('assistant_revision_conflict', 'The request changed; read it before retrying');
          if (terminal.has(run.status)) fail('assistant_run_closed', 'This request has finished');
          if (['contribute', 'resolve'].includes(input.action)) {
            if (!isHuman) fail('assistant_denied', 'Shared inputs preserve human authorship', 403);
            conversationSource(input.sourceMessageId, opening);
            if (input.conflict !== undefined && typeof input.conflict !== 'boolean') fail('invalid_assistant_action', 'Conflict must be a boolean', 422);
            if (input.action === 'resolve' && !isOwner && actor.id !== run.initiatorId)
              fail('assistant_denied', 'The requester or room owner resolves conflicting scope', 403);
            if (input.action === 'resolve' && run.status !== 'needs_input') fail('assistant_no_conflict', 'There is no pending scope decision');
            if (run.inputs.length >= 100) fail('assistant_input_limit', 'Start a new request after 100 contributions', 422);
            run.inputs.push({ memberId: actor.id, sourceMessageId: input.sourceMessageId, status: 'pending', conflict: input.conflict === true, resolution: input.action === 'resolve' });
            if (input.conflict) run.status = 'needs_input';
            else if (input.action === 'resolve') run.status = run.attemptId ? 'pause_requested' : 'queued';
          } else if (input.action === 'resume') {
            if (!isHuman || (!isOwner && actor.id !== run.initiatorId)) fail('assistant_denied', 'The requester or owner resumes this request', 403);
            if (run.status !== 'paused') fail('assistant_not_paused', 'Wait for the host to confirm pausing before resuming');
            const coordinator = state.members[config.coordinatorMemberId];
            if (!coordinator?.active || !coordinator.permissions.includes('accept_work') || run.coordinatorMemberId !== config.coordinatorMemberId
              || run.coordinatorMemberId !== state.room.ownerId && getTier(this.store.db, roomId, run.coordinatorMemberId)?.autonomyTier === 't1_readonly')
              fail('assistant_not_connected', 'Reconnect the original authorized assistant before resuming');
            run.status = run.attemptId ? 'resume_requested' : 'queued';
          } else if (['pause', 'cancel'].includes(input.action)) {
            if (!isHuman || (!isOwner && actor.id !== run.initiatorId)) fail('assistant_denied', 'The requester or owner controls this request', 403);
            if (input.action === 'pause' && run.status === 'cancel_requested')
              fail('assistant_stop_pending', 'Wait for the host to confirm stopping');
            if (input.action === 'cancel' && run.attemptId
              && (!Number.isFinite(run.hostReportedAt) || this.store.now() - run.hostReportedAt > hostStaleAfterMs)) {
              // Revoke a silent host's publication rights immediately. This
              // does not establish that its external execution has stopped.
              run.status = 'cancelled';
              run.attemptId = null;
              run.stopOutcome = 'attempt_revoked';
              run.activity.push({ at: this.store.now(), memberId: actor.id, kind: 'attempt_revoked', summary: 'Host disconnected; publication was revoked, but execution could not be confirmed stopped.' });
              run.activity = run.activity.slice(-100);
            } else {
              run.status = run.attemptId ? input.action === 'pause' ? 'pause_requested' : 'cancel_requested' : input.action === 'pause' ? 'paused' : 'cancelled';
            }
          } else {
            // Revoked execution authority must not prevent the exact reserved
            // host from confirming an already requested stop. This exception
            // cannot acknowledge inputs, publish a result, or resume execution.
            const stopAck = input.action === 'report' && validId(input.attemptId) && run.attemptId === input.attemptId
              && (run.status === 'cancel_requested' && ['cancelled', 'failed'].includes(input.state)
                || run.status === 'pause_requested' && ['paused', 'cancelled', 'failed'].includes(input.state))
              && input.appliedInputMessageIds === undefined && input.resultMessageId === undefined;
            if (actor.kind !== 'agent' || actor.id !== run.coordinatorMemberId
              || !actor.permissions.includes('accept_work') && !stopAck
              || actor.id !== config.coordinatorMemberId && !(input.action === 'report' && ['paused', 'cancelled', 'failed'].includes(input.state))) fail('assistant_denied', 'Only the configured authorized coordinator reports its host', 403);
            if (!stopAck) enforceAutonomyTierForAction({ db: this.store.db, roomId, state, actor, action: 'coordinate the shared assistant' });
            if ((input.action === 'claim' || input.action === 'publish' || input.action === 'draft' || input.state === 'working') && this.store.wakeQueue.pauseStatus(roomId, actor.id)) fail('assistant_host_paused', 'This coordinator is paused');
            if (!validId(input.attemptId)) fail('invalid_assistant_action', 'Choose a stable execution attempt', 422);
            if (input.action === 'draft') {
              if (run.attemptId !== input.attemptId) fail('assistant_run_owned', 'Only the reserved host attempt may report');
              if (run.status !== 'working') fail('assistant_stop_pending', 'A stop or scope decision must be acknowledged first');
              if (!Number.isSafeInteger(input.sequence) || input.sequence < 1
                || typeof input.body !== 'string' || !input.body.isWellFormed() || input.body.length > MAX_MESSAGE_BODY_CHARS)
                fail('invalid_assistant_report', 'Report a bounded answer draft and positive sequence', 422);
              const previous = run.answerDraft;
              if (input.sequence <= (run.answerDraftSequence ?? previous?.sequence ?? 0)) {
                if (!previous || input.sequence !== previous.sequence || input.body !== previous.body)
                  fail('assistant_retry_conflict', 'Retry ID already records different input');
              } else {
                run.answerDraftSequence = input.sequence;
                run.answerDraft = { attemptId: input.attemptId, sequence: input.sequence, body: input.body };
              }
              // Only the latest snapshot is retained. Token updates neither
              // create ops/history rows nor invalidate human input revisions.
              run.hostReportedAt = this.store.now();
            } else if (input.action === 'publish') {
              // SV-1 publish fence, enforced in code: the server posts the
              // run's answer in the same transaction that completes the run.
              // The fence checks the reserved attempt, the run revision and
              // that no stop is pending; a stop that landed first rejects the
              // publish, so a stopped run never leaves its answer in chat.
              // Hosts must publish instead of posting then reporting done.
              if (run.attemptId !== input.attemptId) fail('assistant_run_owned', 'Only the reserved host attempt may publish', 409);
              if (terminal.has(run.status)) fail('assistant_run_closed', 'This request has finished');
              if (run.status !== 'working') fail('assistant_stop_pending', 'A stop or scope decision must be acknowledged before publishing', 409);
              if (typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 2000)
                fail('invalid_assistant_report', 'Report a short public activity summary', 422);
              if (typeof input.body !== 'string' || !input.body.trim() || input.body.length > MAX_MESSAGE_BODY_CHARS)
                fail('invalid_assistant_publish', 'Publish a non-empty answer within the message body limit', 422);
              if (!postToken) fail('invalid_assistant_publish', 'Publish requires the host credential', 422);
              if (input.appliedInputMessageIds !== undefined) {
                if (!Array.isArray(input.appliedInputMessageIds) || input.appliedInputMessageIds.length > 100
                  || input.appliedInputMessageIds.some(id => !run.inputs.some(entry => entry.sourceMessageId === id)))
                  fail('invalid_assistant_report', 'Applied inputs must name existing shared contributions', 422);
                for (const entry of run.inputs) if (input.appliedInputMessageIds.includes(entry.sourceMessageId)) entry.status = 'applied';
              }
              if (run.inputs.some(entry => entry.status !== 'applied'))
                fail('assistant_inputs_pending', 'Read and account for every shared contribution before publishing', 409);
              // Deterministic ids keep a retried publish idempotent at the
              // command layer as well; the ops record above replays the receipt.
              const stamp = createHash('sha256').update(`assistant-publish:${input.requestId}`).digest('hex').slice(0, 32);
              const messageId = `assistant-publish-${stamp}`;
              this.store.command(postToken, roomId, { id: `assistant-publish-cmd-${stamp}`, type: 'message.posted',
                data: { messageId, body: input.body, replyToId: run.sourceMessageId,
                  ...(opening?.channelId ? { channelId: opening.channelId } : {}) } });
              run.resultMessageId = messageId;
              run.hostReportedAt = this.store.now();
              run.status = 'done';
              run.activity.push({ at: this.store.now(), memberId: actor.id, kind: 'published', summary: input.summary.trim(), state: 'done' });
              run.activity = run.activity.slice(-100);
            } else if (input.action === 'claim') {
              if (run.attemptId) fail('assistant_run_owned', 'This request already has an execution owner; reconcile that attempt');
              if (run.status !== 'queued') fail('assistant_not_queued', 'Resolve or resume the request before execution');
              run.attemptId = input.attemptId; run.answerDraftSequence = 0; run.status = 'working'; run.hostReportedAt = this.store.now();
            } else {
              if (run.attemptId !== input.attemptId) fail('assistant_run_owned', 'Only the reserved host attempt may report');
              if (!['working', 'needs_input', 'paused', 'cancelled', 'done', 'failed'].includes(input.state)
                || typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 2000)
                fail('invalid_assistant_report', 'Report a short public activity summary and supported state', 422);
              if (run.status === 'cancel_requested' && !['cancelled', 'failed'].includes(input.state)
                || run.status === 'pause_requested' && !['paused', 'cancelled', 'failed'].includes(input.state)
                || run.status === 'paused' && input.state === 'working'
                || run.status === 'needs_input' && !['needs_input', 'paused', 'cancelled', 'failed'].includes(input.state)) fail('assistant_stop_pending', 'A stop or scope decision must be acknowledged first');
              if (input.state === 'done') {
                if (!input.resultMessageId) fail('assistant_result_missing', 'Publish a shared result message before reporting done', 422);
                conversationSource(input.resultMessageId, opening); run.resultMessageId = input.resultMessageId;
              }
              if (input.appliedInputMessageIds !== undefined) {
                if (!Array.isArray(input.appliedInputMessageIds) || input.appliedInputMessageIds.length > 100
                  || input.appliedInputMessageIds.some(id => !run.inputs.some(entry => entry.sourceMessageId === id)))
                  fail('invalid_assistant_report', 'Applied inputs must name existing shared contributions', 422);
                for (const entry of run.inputs) if (input.appliedInputMessageIds.includes(entry.sourceMessageId)) entry.status = 'applied';
              }
              // A current revision alone does not establish that the host handled
              // every human contribution. Preserve earlier acknowledgments and
              // include this report's acknowledgments before closing the run.
              if (input.state === 'done' && run.inputs.some(entry => entry.status !== 'applied'))
                fail('assistant_inputs_pending', 'Read and account for every shared contribution before reporting done');
              run.hostReportedAt = this.store.now();
              run.status = input.state;
              run.activity.push({ at: this.store.now(), memberId: actor.id, kind: 'reported', summary: input.summary.trim(), state: input.state });
              run.activity = run.activity.slice(-100);
            }
          }
          if (input.action !== 'draft') run.revision++;
        }
        if (input.action !== 'draft' && (run.status !== 'working' || ['contribute', 'resolve'].includes(input.action))) delete run.answerDraft;
        run.updatedAt = this.store.now();
        this.store.db.prepare('INSERT INTO room_assistant_runs VALUES(?,?,?) ON CONFLICT(room_id,run_id) DO UPDATE SET value=excluded.value').run(roomId, run.id, JSON.stringify(run));
        result = state.messages.find(m => m.id === run.sourceMessageId)?.deletedAt ? deletedControl(run) : run;
      }
      const response = { contractVersion: 1, roomId, action: input.action, result };
      if (input.action !== 'draft') this.store.db.prepare('INSERT INTO room_assistant_ops VALUES(?,?,?,?,?)').run(roomId, actor.id, input.requestId, canonical, JSON.stringify(response));
      return response;
    });
  }
}
