import { uiText } from './strings.js';
import { currentResult } from './work-selectors.js';
// Human presentation and explicitly PUBLIC assistant invocation. No private request reuse.
// HS2 3a: the ask card face. The request people are waiting on shows its
// state on the card itself, not only under the collapsed Activity list.
export const NOT_PICKED_UP_MS = 10000;
const CLOSED = ['done', 'failed', 'cancelled'];
export function faceRun(runs) {
  const list = Object.values(runs ?? {}).filter(run => !run.sourceDeleted);
  const latest = items => items.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0] ?? null;
  return latest(list.filter(run => !CLOSED.includes(run.status))) ?? latest(list);
}
export function askFaceStatus(run, now = Date.now()) {
  if (!run) return null;
  if (run.stopOutcome === 'attempt_revoked') return { key: 'unknown', text: uiText('human.face.connectionInterrupted') };
  const waited = Math.max(0, now - (run.createdAt ?? now));
  const key = run.status === 'queued' ? (waited >= NOT_PICKED_UP_MS ? 'not_picked_up' : 'asked') : run.status === 'unknown' ? 'stalled' : run.status;
  const textKey = ({ asked: 'asked', not_picked_up: 'notPickedUp', stalled: 'stalled', working: 'working', paused: 'paused', pause_requested: 'pausing', resume_requested: 'resuming', cancel_requested: 'stopping', needs_input: 'needsDecision', done: 'done', failed: 'failed', cancelled: 'stopped' })[key];
  return { key, text: textKey ? uiText(`human.face.${textKey}`) : run.status };
}
export function installHumanExperience({ getState, getSession, client, notice, openWork, openMessage, startContribution, getContribution, endContribution, selectResult, refreshTranscript }) {
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const human = () => getSession()?.member?.kind === 'human';
  let boundary = '', projection = null, reading = false, selected = false, contribution = null, operation = null, rejectedOperation = null, configureOperation = null, error = '', lastRead = 0;
  const key = () => ["", client.generation, ":", getState()?.room.id, ":", getSession()?.member.id, ""].join('');
  const pendingKey = () => ["room-assistant-pending:", getState()?.room.id, ":", getSession()?.member.id, ""].join('');
  function persistOperation() { try { if (operation) sessionStorage.setItem(pendingKey(), JSON.stringify(operation)); else sessionStorage.removeItem(pendingKey()); } catch { /* the current tab still has the exact retry */ } }
  const path = () => `/api/rooms/${encodeURIComponent(getState().room.id)}/assistant`;
  const section = document.createElement('section'); section.id = 'room-assistant'; section.hidden = true;
  section.setAttribute('aria-label', 'Room assistant');
  section.innerHTML = uiText("human.copy.001");
  $('#typing-indicator').before(section);
  // The status line is a persistent polite live region, so each state change
  // is announced once (R5-2); request text and buttons are rebuilt quietly.
  const face = document.createElement('div'); face.id = 'assistant-face'; face.hidden = true;
  const faceRequest = document.createElement('p'); faceRequest.className = 'assistant-face-request';
  const faceStatus = document.createElement('p'); faceStatus.className = 'assistant-face-status'; faceStatus.setAttribute('role', 'status'); faceStatus.setAttribute('aria-live', 'polite'); faceStatus.tabIndex = -1;
  const faceActions = document.createElement('div'); faceActions.className = 'assistant-face-actions';
  const faceAnswer = document.createElement('p'); faceAnswer.id = 'assistant-answer'; faceAnswer.className = 'assistant-run-result';
  faceAnswer.style.whiteSpace = 'pre-wrap'; faceAnswer.hidden = true;
  const answerText = document.createTextNode(''); faceAnswer.append(answerText);
  face.append(faceRequest, faceStatus, faceAnswer, faceActions);
  $('#assistant-activity').before(face);
  const faceButton = (label, data) => { const button = document.createElement('button'); button.type = 'button'; button.className = 'text-button'; button.textContent = label; Object.assign(button.dataset, data); return button; };
  const ask = document.createElement('button'); ask.type = 'button'; ask.id = 'ask-room'; ask.className = 'button ghost';
  ask.textContent = 'Ask Room'; ask.setAttribute('aria-pressed', 'false'); ask.title = uiText("human.copy.002");
  const composerActions = document.createElement('div'); composerActions.className = 'human-composer-actions';
  composerActions.append($('#composer-options'), ask); $('.composer-row').append(composerActions);
  ask.addEventListener('click', () => { selected = !selected; if (!selected) { contribution = null; endContribution?.(); ask.textContent = 'Ask Room'; } ask.setAttribute('aria-pressed', String(selected)); $('#message-input').focus(); });
  const advanced = document.createElement('label'); advanced.className = 'check';
  advanced.innerHTML = uiText("human.copy.003");
  $('#settings-dialog').append(advanced);
  $('#human-advanced').addEventListener('change', () => {
    document.body.classList.toggle('human-advanced', $('#human-advanced').checked);
    refreshTranscript();
    try { sessionStorage.setItem(`room-human-advanced:${boundary}`, String($('#human-advanced').checked)); } catch { /* session only */ }
  });
  const dialog = document.createElement('dialog'); dialog.id = 'human-project-dialog'; dialog.setAttribute('aria-labelledby', 'human-project-title');
  dialog.innerHTML = '<div class="dialog-head"><h2 id="human-project-title">Project</h2><button type="button" class="button ghost" data-close-project>Close</button></div><div id="human-project-content"></div>';
  document.body.append(dialog); dialog.querySelector('[data-close-project]').onclick = () => dialog.close();
  $('#human-project-open').onclick = () => {
    const state = getState();
    $('#human-project-content').innerHTML = [`<p>${esc(state.room.purpose || uiText("human.copy.004"))}</p>`, Object.values(state.workItems ?? {}).filter(w => !w.supersededBy).map(w => {
      const label = w.state === 'completed' ? (currentResult(w) ? 'Done' : 'Needs review') : w.state === 'working' ? uiText("human.copy.005") : w.state === 'blocked' ? 'Needs input' : 'Planned';
      return ["<button type=\"button\" class=\"human-project-item\" data-project-work=\"", esc(w.id), "\"><strong>", esc(w.title), "</strong><span>", esc(label), "</span></button>"].join('');
    }).join('')].join('');
    if (!Object.keys(state.workItems ?? {}).length) $('#human-project-content').insertAdjacentHTML('beforeend', uiText("human.copy.006"));
    dialog.showModal();
  };
  dialog.addEventListener('click', event => { const button = event.target.closest('[data-project-work]'); if (button) { dialog.close(); openWork(button.dataset.projectWork); } });
  const setup = document.createElement('dialog'); setup.id = 'room-assistant-setup'; setup.setAttribute('aria-labelledby', 'assistant-setup-title');
  setup.innerHTML = uiText("human.copy.007");
  document.body.append(setup); setup.querySelector('[data-close-setup]').onclick = () => setup.close();
  setup.querySelector('#assistant-enroll').onclick = () => { setup.close(); $('#connect-agent-button').click(); };
  $('#assistant-setup').onclick = () => {
    const state = getState();
    setup.querySelector('select').innerHTML = uiText("human.copy.008") + Object.values(state.members).filter(m => m.kind === 'agent' && m.active !== false && m.permissions.includes('accept_work')).map(m => ["<option value=\"", esc(m.id), "\">", esc(m.displayName), "</option>"].join('')).join('');
    if (configureOperation) setup.querySelector('select').value = configureOperation.coordinatorMemberId;
    setup.querySelector('select').disabled = Boolean(configureOperation);
    $('#assistant-setup-error').textContent = ''; setup.showModal();
  };
  setup.querySelector('form').onsubmit = async event => {
    event.preventDefault(); const stamp = key(); const button = setup.querySelector('[type=submit]'); button.disabled = true;
    try {
      configureOperation ??= { action: 'configure', requestId: crypto.randomUUID(), expectedRevision: projection?.assistant.revision ?? 0, name: 'Room', coordinatorMemberId: setup.querySelector('select').value };
      await client.request(path(), { method: 'POST', data: configureOperation });
      if (stamp !== key()) return; configureOperation = null; setup.close(); lastRead = 0; await refresh();
    } catch (failure) { if (stamp === key()) { $('#assistant-setup-error').textContent = failure.message; if (failure.status >= 400 && failure.status < 500) { configureOperation = null; lastRead = 0; await refresh(); } else setup.querySelector('select').disabled = true; } }
    finally { button.disabled = false; }
  };
  function paint() {
    if (!human() || !projection) return;
    const assistant = projection.assistant;
    section.querySelector('strong').textContent = assistant.name || 'Room';
    $('#room-assistant-status').textContent = assistant.availability === 'connected' ? 'Connected' : assistant.availability === 'awaiting_host' ? uiText("human.copy.009") : 'Not connected';
    $('#assistant-setup').hidden = getState().room.ownerId !== getSession().member.id;
    $('#assistant-setup').textContent = assistant.availability === 'connected' ? uiText('human.assistantChange') : 'Connect';
    const runs = Object.values(projection.runs ?? {});
    $('#assistant-activity').hidden = !runs.length;
    const openRuns = new Set([...document.querySelectorAll('#assistant-runs details.assistant-run[open]')].map(d => d.dataset.assistantRun));
    const runsHtml = runs.map(run => {
      const source = getState().messages.find(m => m.id === run.sourceMessageId);
      const sourceDeleted = run.sourceDeleted || Boolean(source?.deletedAt);
      const controls = getState().room.ownerId === getSession().member.id || run.initiatorId === getSession().member.id;
      const inputs = (sourceDeleted ? [] : run.inputs).slice(1).map(input => {
        const message = getState().messages.find(m => m.id === input.sourceMessageId);
        return ["<p>", esc(getState().members[input.memberId]?.displayName || 'Participant'), ": ", esc(message?.body?.slice(0,100) || 'Context'), " · ", input.status === 'applied' ? 'Applied' : 'Pending', "</p>"].join('');
      }).join('');
      const editable = !sourceDeleted && !['done','failed','cancelled','cancel_requested'].includes(run.status);
      const resultMessage = !sourceDeleted && run.status === 'done' && run.resultMessageId ? getState().messages.find(m => m.id === run.resultMessageId) : null;
      const statusLabel = ({ queued: uiText("human.copy.010"), not_picked_up: uiText("human.askNotPickedUp"), working: 'Working', stalled: uiText("human.askStalled"), unknown: 'Connection interrupted', paused: 'Paused', resume_requested: uiText("human.copy.011"), pause_requested: uiText("human.copy.012"), cancel_requested: uiText("human.copy.013"), done: 'Result ready', failed: "Couldn't finish", needs_input: 'Needs input', cancelled: 'Cancelled' })[run.displayStatus ?? run.status] || run.status;
      const promptLabel = sourceDeleted ? uiText('human.deletedRequest') : source?.body?.slice(0,160) || 'Shared request';
      const pauseButton = controls && ['queued', 'working', 'unknown', 'not_picked_up', 'stalled'].includes(run.status) ? ["<button type=\"button\" class=\"text-button\" data-pause-run=\"", esc(run.id), "\" data-revision=\"", run.revision, "\">Pause</button>"].join('') : controls && !sourceDeleted && run.status === 'paused' ? ["<button type=\"button\" class=\"text-button\" data-pause-run=\"", esc(run.id), "\" data-resume=\"true\" data-revision=\"", run.revision, "\">Resume</button>"].join('') : '';
      const stopButton = controls && !['done','failed','cancelled','cancel_requested'].includes(run.status) ? uiText("human.stopRequest", { runId: esc(run.id), revision: run.revision }) : '';
      // One foldable row per ask: the summary is the whole ask at a glance
      // (prompt, status, result snippet, stop controls); the detail holds the
      // full card. Open rows stay open across repaints.
      return ["<details class=\"assistant-run\" data-assistant-run=\"", esc(run.id), "\" data-attempt-id=\"", esc(run.attemptId ?? ''), "\"", openRuns.has(run.id) ? " open" : "", ">",
        "<summary><strong>", esc(promptLabel.slice(0, 90)), "</strong>",
        "<span class=\"assistant-run-status\">", esc(statusLabel), "</span>",
        resultMessage?.body ? ["<span class=\"assistant-run-resultline\">", esc(resultMessage.body.slice(0, 120)), "</span>"].join('') : '',
        pauseButton, stopButton, "</summary>",
        "<div class=\"assistant-run-detail\">",
        "<p>", esc(statusLabel), "</p>",
        resultMessage?.body ? ["<p class=\"assistant-run-result\"><strong>", uiText("human.askResult"), "</strong> ", esc(resultMessage.body.slice(0,400)), "</p>"].join('') : '',
        sourceDeleted ? '' : ["<button type=\"button\" class=\"text-button\" data-assistant-message=\"", esc(run.sourceMessageId), "\">Original prompt</button>"].join(''),
        !sourceDeleted && run.resultMessageId ? `<button type="button" class="text-button" data-assistant-message="${esc(run.resultMessageId)}">Open result</button>` : '',
        (sourceDeleted ? [] : run.activity ?? []).slice(-5).map(a => `<p>${esc(a.summary)}</p>`).join(''),
        inputs,
        editable ? ["<button type=\"button\" class=\"text-button\" data-contribute-run=\"", esc(run.id), "\" data-revision=\"", run.revision, "\">Add context</button>"].join('') : '',
        editable && run.status !== 'needs_input' ? ["<button type=\"button\" class=\"text-button\" data-contribute-run=\"", esc(run.id), "\" data-conflict=\"true\" data-revision=\"", run.revision, "\">Change direction</button>"].join('') : '',
        controls && !sourceDeleted && run.status === 'needs_input' ? ["<button type=\"button\" class=\"text-button\" data-contribute-run=\"", esc(run.id), "\" data-resolve=\"true\" data-revision=\"", run.revision, "\">Resolve direction</button>"].join('') : '',
        "</div></details>"].join('');
    }).join('');
    const current = faceRun(Object.values(projection.runs ?? {}).filter(run => !getState().messages.find(m => m.id === run.sourceMessageId)?.deletedAt)), status = askFaceStatus(current);
    const faceSource = current && getState().messages.find(m => m.id === current.sourceMessageId);
    const faceControls = current && (getState().room.ownerId === getSession().member.id || current.initiatorId === getSession().member.id);
    const faceKey = current ? JSON.stringify([current.id, current.revision, current.status, current.attemptId, current.stopOutcome, current.resultMessageId, faceControls, faceSource?.body?.slice(0, 120)]) : '';
    if (face._key !== faceKey) {
      face._key = faceKey;
      face.dataset.attemptId = current?.attemptId ?? '';
      const focusedData = faceActions.contains(document.activeElement) ? { ...document.activeElement.dataset } : null;
      faceActions.replaceChildren();
      if (current) {
        faceRequest.textContent = faceSource?.body?.slice(0, 120) || uiText('human.face.sharedRequest');
        if (current.resultMessageId) faceActions.append(faceButton(uiText('human.face.openResult'), { assistantMessage: current.resultMessageId }));
        if (!CLOSED.includes(current.status) && !['cancel_requested', 'needs_input'].includes(current.status)) faceActions.append(faceButton(uiText('human.face.addContext'), { contributeRun: current.id, revision: String(current.revision) }));
        if (faceControls && !CLOSED.includes(current.status)) faceActions.insertAdjacentHTML('beforeend', uiText('human.stopRequest', { runId: esc(current.id), revision: current.revision }));
        // R5-1: keep keyboard focus on the same control (or the card) across a repaint.
        if (focusedData) ([...faceActions.querySelectorAll('button')].find(button => button.dataset.pauseRun === focusedData.pauseRun && button.dataset.cancel === focusedData.cancel && button.dataset.contributeRun === focusedData.contributeRun) || faceStatus).focus({ preventScroll: true });
      }
    }
    if (current && faceStatus.dataset.faceStatus !== status.key) { faceStatus.dataset.faceStatus = status.key; faceStatus.textContent = status.text; }
    const draft = current && current.answerDraft && current.answerDraft.attemptId === current.attemptId && !CLOSED.includes(current?.status) ? current.answerDraft : null;
    const answer = draft?.body ?? '';
    // Keep one stable text node on the card; no per-token live announcements,
    // HTML execution, extra timeline messages or forced scrolling.
    if (answer.startsWith(answerText.data)) answerText.appendData(answer.slice(answerText.length));
    else if (answerText.data !== answer) answerText.replaceData(0, answerText.length, answer);
    faceAnswer.hidden = !answer;
    face.hidden = !current;
    if ($('#assistant-runs')._html !== runsHtml) {
      const panel = $('#assistant-runs'), focused = panel.contains(document.activeElement) ? document.activeElement : null;
      const runId = focused?.closest('[data-assistant-run]')?.dataset.assistantRun, label = focused?.textContent, scroll = panel.scrollTop;
      panel.innerHTML = runsHtml; panel._html = runsHtml; panel.scrollTop = scroll;
      if (focused) { const replacement = [...panel.querySelectorAll('button')].find(b => b.closest('[data-assistant-run]').dataset.assistantRun === runId && b.textContent === label); (replacement || $('#assistant-activity summary')).focus({preventScroll:true}); }
    }
    $('#assistant-error').textContent = error; $('#assistant-retry').hidden = !operation; $('#assistant-review').hidden = !rejectedOperation; $('#assistant-discard').hidden = !operation && !rejectedOperation; ask.disabled = Boolean(operation);
  }
  function syncContribution() {
    const scoped = getContribution?.();
    if (scoped) {
      contribution = { action: scoped.action, runId: scoped.runId, expectedRevision: scoped.expectedRevision, ...(scoped.action === 'resolve' ? {} : { conflict: scoped.conflict }) };
      selected = true; ask.textContent = scoped.action === 'resolve' ? 'Resolve direction' : scoped.conflict ? 'Change direction' : 'Add context';
      ask.setAttribute('aria-pressed', 'true');
    } else if (contribution) {
      contribution = null; selected = false; ask.textContent = 'Ask Room'; ask.setAttribute('aria-pressed', 'false');
    }
  }
  async function refresh() {
    if (!human() || !getState() || reading || document.hidden || Date.now() - lastRead < (projection?.runs?.some(run => run.status === 'working') ? 500 : 3000)) return;
    const stamp = key(); reading = true; lastRead = Date.now();
    try { const next = await client.request(path()); if (stamp !== key()) return; const changed = projection?.assistant.coordinatorMemberId !== next.assistant.coordinatorMemberId || projection?.assistant.name !== next.assistant.name; projection = next; paint(); if (changed) refreshTranscript(); }
    catch (failure) { if (stamp === key()) { error = failure.status === 404 ? uiText("human.copy.014") : failure.message; $('#assistant-error').textContent = error; } }
    finally { reading = false; }
  }
  async function invoke() {
    if (!operation || !getState()) return;
    const owned = operation, stamp = key();
    try { await client.request(path(), { method: 'POST', data: owned }); if (stamp !== key() || operation !== owned) return; operation = null; persistOperation(); contribution = null; selected = false; ask.textContent = 'Ask Room'; ask.setAttribute('aria-pressed', 'false'); error = ''; lastRead = 0; await refresh(); }
    catch (failure) { if (stamp === key()) {
      const rejected = failure.status >= 400 && failure.status < 500;
      error = ["", owned.sourceMessageId && ['invoke','contribute','resolve'].includes(owned.action) ? 'Message sent. ' : '', "Assistant request ", rejected ? 'was rejected' : 'not confirmed', ": ", failure.message, ""].join('');
      if (rejected) { rejectedOperation = owned; operation = null; persistOperation(); }
      paint();
    } }
  }
  $('#assistant-retry').onclick = invoke;
  $('#assistant-discard').onclick = () => { operation = null; rejectedOperation = null; persistOperation(); error = ''; contribution = null; selected = false; ask.textContent = 'Ask Room'; ask.setAttribute('aria-pressed','false'); paint(); };
  $('#assistant-review').onclick = async () => {
    const original = rejectedOperation, stamp = key(); if (!original) return;
    try {
      const latest = await client.request(path()); if (stamp !== key() || original !== rejectedOperation) return;
      const run = latest.runs.find(r => r.id === original.runId);
      if (original.action !== 'invoke' && (!run || ['done','failed','cancelled'].includes(run.status))) { error = uiText("human.copy.015"); paint(); return; }
      operation = { ...original, requestId: crypto.randomUUID(), ...(original.action !== 'invoke' ? { expectedRevision: run.revision } : {}) }; rejectedOperation = null; projection = latest; persistOperation();
      error = uiText("human.copy.016"); paint();
    } catch (failure) { if (stamp === key()) { error = failure.message; paint(); } }
  };
  $('#assistant-runs').onclick = async event => {
    // Controls in a run's summary row must not toggle the fold.
    if (event.target.closest('summary button')) event.preventDefault();
    const message = event.target.closest('[data-assistant-message]'); if (message) { openMessage(message.dataset.assistantMessage); return; }
    const context = event.target.closest('[data-contribute-run]');
    if (context) {
      const run = projection?.runs?.find(run => run.id === context.dataset.contributeRun);
      if (!run) return;
      const wanted = { action: context.dataset.resolve ? 'resolve' : 'contribute', runId: context.dataset.contributeRun, expectedRevision: Number(context.dataset.revision), ...(context.dataset.resolve ? {} : { conflict: context.dataset.conflict === 'true' }) };
      if (!startContribution?.(run.sourceMessageId, wanted)) return;
      syncContribution(); $('#message-input').focus(); return;
    }
    const button = event.target.closest('[data-pause-run]'); if (!button) return;
    if (operation) return;
    operation = { action: button.dataset.cancel ? 'cancel' : button.dataset.resume ? 'resume' : 'pause', requestId: crypto.randomUUID(), runId: button.dataset.pauseRun, expectedRevision: Number(button.dataset.revision), ...(button.dataset.resume ? {} : { expectedAttemptId: button.closest('[data-attempt-id]')?.dataset.attemptId || null }) };
    // Save the exact operation before dispatch; a lost response cannot create a second stop/resume.
    persistOperation(); button.setAttribute('aria-disabled', 'true'); await invoke(); // aria-disabled keeps focus (R5-1); `if (operation)` already blocks a second submit

  };
  face.onclick = $('#assistant-runs').onclick;
  const resultDialog = document.createElement('dialog'); resultDialog.id = 'human-share-result'; resultDialog.setAttribute('aria-labelledby', 'human-share-title');
  resultDialog.innerHTML = uiText("human.copy.017");
  document.body.append(resultDialog); let resultEntry = null;
  resultDialog.querySelector('[data-close-share]').onclick = () => { if (resultEntry?.rejected) resultEntry = null; resultDialog.close(); };
  $('#human-share-refresh').onclick = async () => {
    const entry = resultEntry, stamp = key(); if (!entry?.rejected || entry.boundary !== stamp) return;
    const review = $('#human-share-refresh'); review.disabled = true;
    try {
      await client.refresh(); if (stamp !== key() || resultEntry !== entry) return;
      const item = getState().workItems[entry.workId];
      if (!item || item.supersededBy) { $('#human-share-error').textContent = uiText("human.copy.018"); return; }
      entry.revision = item.revision; entry.command = null; entry.rejected = false;
      resultDialog.querySelector('textarea').disabled = false;
      const submit = resultDialog.querySelector('[type=submit]'); submit.disabled = false; submit.textContent = 'Review result'; review.hidden = true;
      $('#human-share-error').textContent = uiText("human.copy.019", { fragmentA: item.title });
      resultDialog.querySelector('textarea').focus();
    } catch (failure) { if (stamp === key() && resultEntry === entry) $('#human-share-error').textContent = failure.message; }
    finally { review.disabled = false; }
  };
  resultDialog.querySelector('form').onsubmit = async event => {
    event.preventDefault(); const entry = resultEntry, stamp = key(), body = resultDialog.querySelector('textarea').value;
    if (!entry || entry.boundary !== stamp || entry.rejected) return;
    const button = resultDialog.querySelector('[type=submit]'); button.disabled = true;
    entry.command ??= { id: crypto.randomUUID(), type: 'message.posted', data: { messageId: crypto.randomUUID(), workItemId: entry.workId,
      packetId: crypto.randomUUID(), basisRevision: entry.revision, body } };
    try {
      await client.send(entry.command); if (stamp !== key() || resultEntry !== entry) return;
      const messageId = entry.command.data.messageId; resultEntry = null; resultDialog.close(); selectResult(entry.workId, messageId);
    } catch (failure) {
      if (stamp !== key() || resultEntry !== entry) return;
      entry.rejected = failure.status >= 400 && failure.status < 500;
      $('#human-share-error').textContent = entry.rejected
        ? uiText("human.copy.020", { fragmentA: failure.message })
        : uiText("human.copy.021", { fragmentA: failure.message });
      resultDialog.querySelector('textarea').disabled = true;
      $('#human-share-refresh').hidden = !entry.rejected;
      button.textContent = entry.rejected ? 'Review result' : uiText("human.copy.022");
    } finally { if (stamp === key() && resultEntry === entry) button.disabled = Boolean(entry.rejected); }
  };
  $('#human-existing-drafts').onclick = event => {
    const button = event.target.closest('[data-result-draft]'); if (!button || resultEntry?.boundary !== key()) return;
    resultDialog.close(); selectResult(resultEntry.workId, button.dataset.resultDraft);
  };
  setInterval(() => { void refresh(); }, 500);
  return {
    assistantName(id) { return human() && !document.body.classList.contains('human-advanced') && projection?.assistant.coordinatorMemberId === id ? projection.assistant.name : null; },
    sync() {
      const active = human() && Boolean(getState()); document.body.classList.toggle('human-experience', active);
      document.body.classList.toggle('human-single-conversation', active && Object.values(getState()?.channels ?? {}).filter(c => !c.archivedAt).length <= 1);
      section.hidden = !active; ask.hidden = !active; advanced.hidden = !active;
      if (active) {
        for (const button of document.querySelectorAll('[data-action="complete"]')) { button.textContent = 'Share result'; const parent = button.closest('.work-actions'); if (parent && button.parentNode !== parent) parent.insertBefore(button, parent.querySelector('.work-more')); }
        $('#work-options-summary').textContent = $('#require-verification').checked ? 'Advanced options' : uiText('human.workNoReview');
      }
      if (!active) { projection = null; operation = null; rejectedOperation = null; configureOperation = null; boundary = ''; selected = false; section.querySelector('#assistant-runs').replaceChildren(); delete $('#assistant-runs')._html; if (setup.open) setup.close(); if (dialog.open) dialog.close(); if (resultDialog.open) resultDialog.close(); resultEntry = null; document.body.classList.remove('human-advanced'); return; }
      if (boundary !== key()) {
        for (const modal of [setup, dialog, resultDialog]) if (modal.open) modal.close();
        resultEntry = null; resultDialog.querySelector('form').reset(); setup.querySelector('form').reset(); $('#human-project-content').replaceChildren(); $('#assistant-runs').replaceChildren(); delete $('#assistant-runs')._html;
        boundary = key(); projection = null; operation = null; rejectedOperation = null; configureOperation = null; contribution = null; error = ''; lastRead = 0; selected = false; ask.textContent = 'Ask Room'; ask.setAttribute('aria-pressed', 'false');
        try {
          const pending = JSON.parse(sessionStorage.getItem(pendingKey()) || 'null');
          if (pending && ['invoke','contribute','resolve','pause','resume','cancel'].includes(pending.action) && typeof pending.requestId === 'string' && typeof pending.runId === 'string'
            && (['pause','resume','cancel'].includes(pending.action) || getState().messages.some(m => m.id === pending.sourceMessageId && m.authorId === getSession().member.id && !m.toMemberId))) { operation = pending; error = uiText("human.copy.023"); }
        } catch { /* corrupt/unavailable saved state is not executed */ }
        let enabled = false; try { enabled = sessionStorage.getItem(`room-human-advanced:${boundary}`) === 'true'; } catch { /* defaults */ }
        $('#human-advanced').checked = enabled; document.body.classList.toggle('human-advanced', enabled);
        $('#people-panel').open = false;
      }
      // Message tombstones must hide cached activity even if assistant reads fail.
      paint(); void refresh();
    },
    syncContribution,
    intent(content) {
      syncContribution();
      if (contribution) {
        const run = projection?.runs?.find(run => run.id === contribution.runId);
        const sourceId = getContribution?.()?.sourceMessageId ?? run?.sourceMessageId;
        const source = getState()?.messages.find(message => message.id === sourceId);
        if (!source || content.replyToId !== source.id || (content.channelId ?? 'general') !== (source.channelId ?? 'general')) {
          return null;
        }
      }
      const solo = Object.values(getState()?.members ?? {}).filter(m => m.active !== false && m.kind === 'human').length === 1 && projection?.assistant.coordinatorMemberId; return !operation && human() && !content.toMemberId && (contribution || selected || /^@Room\b/i.test(content.body) || solo) ? { ...(contribution || { action: 'invoke' }) } : null; },
    shareResult(item) {
      if (!human() || document.body.classList.contains('human-advanced')) return false;
      if (!resultEntry?.command || resultEntry.workId !== item.id || resultEntry.boundary !== key()) {
        resultEntry = { workId: item.id, revision: item.revision, boundary: key(), command: null };
        resultDialog.querySelector('form').reset(); resultDialog.querySelector('textarea').disabled = false;
        resultDialog.querySelector('[type=submit]').textContent = 'Review result'; resultDialog.querySelector('[type=submit]').disabled = false; $('#human-share-refresh').hidden = true; $('#human-share-error').textContent = '';
      }
      const drafts = getState().messages.filter(m => m.workItemId === item.id && !m.deletedAt && !m.toMemberId);
      $('#human-existing-drafts').innerHTML = drafts.map(m => ["<button type=\"button\" class=\"text-button\" data-result-draft=\"", esc(m.id), "\">", esc(m.body.slice(0,100)), "</button>"].join('')).join('') || uiText("human.copy.024");
      resultDialog.showModal(); return true;
    },
    async posted(messageId, wanted) {
      if (!wanted || !human()) return;
      operation = { ...wanted, requestId: `ask-${messageId}`, ...(wanted.action === 'invoke' ? { runId: `run-${messageId}` } : {}), sourceMessageId: messageId }; persistOperation(); await invoke();
    }
  };
}
