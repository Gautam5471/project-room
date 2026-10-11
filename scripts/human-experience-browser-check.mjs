import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { clickChrome, openCatchUpPanel, openSettings, closeSettings, ensureSidebarClosed } from './room-chrome.mjs';
import { signInFixture } from './auth-signin.mjs';

function deferredResultResponse() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function openHumanResult(page, workId) {
  const task = page.locator(`[data-work-record-id="${workId}"]`), details = task.locator('details.work-details');
  if (!await details.evaluate(node => node.open)) await details.locator(':scope > summary').click();
  await task.locator('[data-action="complete"]').click();
  await page.locator('#human-share-result').waitFor({state:'visible'});
}

async function holdResultResponse(page, body, { offline = false, roomId = 'commons' } = {}) {
  const captured = deferredResultResponse(), release = deferredResultResponse();
  let intercepted = false;
  await page.route(`**/api/rooms/${roomId}/commands`, async route => {
    const command = route.request().postDataJSON();
    if (intercepted || command?.data?.body !== body) { await route.fallback(); return; }
    intercepted = true;
    const response = offline ? null : await route.fetch();
    captured.resolve({ command, response });
    await release.promise;
    if (offline) await route.abort('connectionfailed');
    else await route.fulfill({ response });
  });
  return {
    captured: captured.promise, release: release.resolve,
    async deliver() {
      const finished = offline
        ? page.waitForEvent('requestfailed', request => request.postDataJSON()?.data?.body === body)
        : page.waitForResponse(response => response.request().postDataJSON()?.data?.body === body);
      release.resolve();
      const response = await finished;
      if (!offline) await response.finished();
      // Let the response's promise handlers and the resulting paint finish.
      // Successful receipts are already visible in the stream before release.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
  };
}

test('two humans share public assistant prompts, constraints, confirmed activity and results; banter stays quiet', { timeout: 60000 }, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 40 });
  for (const [type,data] of [
    ['work.proposed',{workItemId:'human-result-task',title:'Write a short result',definitionOfDone:'A readable result is saved',accountableMemberId:'owner',mode:'read',independentVerificationRequired:false,ownerDecisionRequired:false}],
    ['work.accepted',{workItemId:'human-result-task',expectedRevision:0}],
    ['work.started',{workItemId:'human-result-task',expectedRevision:1}]
  ]) f.store.command(f.keys.owner,'commons',{id:crypto.randomUUID(),type,data});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch({headless:true});
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); f.store.close(); rmSync(f.directory,{recursive:true,force:true}); });
  const errors = [], pages = [];
  for(const member of ['owner','guest']) {
    const context = await browser.newContext({viewport:{width:1280,height:900}}), page = await context.newPage();
    page.on('pageerror', e=>errors.push(e.message)); await page.goto(origin); await signInFixture(page,f.keys[member]);
    await page.locator('#main').waitFor({state:'visible'}); await page.waitForFunction(()=>document.body.classList.contains('human-experience')); pages.push(page);
  }
  const [owner,peer] = pages;
  const api = async (actor, input) => {
    const response = await fetch(`${origin}/api/rooms/commons/assistant`, {method:input?'POST':'GET',headers:{Authorization:`Bearer ${f.keys[actor]}`,...(input?{'Content-Type':'application/json'}:{})},...(input?{body:JSON.stringify({requestId:crypto.randomUUID(),...input})}:{})});
    const json=await response.json(); assert.ok(response.ok,JSON.stringify(json));return json;
  };
  assert.equal(await owner.locator('#tasks-destination').isVisible(),false);
  await owner.locator('#assistant-setup').click(); await owner.locator('#room-assistant-setup select').selectOption('producer');
  await owner.locator('#room-assistant-setup button[type=submit]').click(); await owner.locator('#room-assistant-setup').waitFor({state:'hidden'});
  await owner.waitForFunction(()=>document.querySelector('#room-assistant-status').textContent==='Waiting for connection');
  const send = async (page, body) => { await page.locator('#message-input').fill(body); await page.locator('#message-form button[type=submit]').click(); await page.waitForFunction(()=>document.querySelector('#message-input').value===''); };
  await send(peer,'Hey friends, good to see you!'); assert.equal((await api('owner')).runs.length,0);
  await owner.locator('#ask-room').click(); await send(owner,'Compare our launch ideas.');
  await owner.waitForFunction(()=>document.querySelector('#assistant-runs').textContent.includes('Compare our launch ideas.'));
  await peer.waitForFunction(()=>document.querySelector('#assistant-runs').textContent.includes('Compare our launch ideas.'));
  let run=(await api('producer')).runs[0]; assert.equal(run.status,'queued');
  // HS2 3a: the request and its state are on the card face, with Activity still closed.
  for(const page of pages) {
    await page.locator('#assistant-face .assistant-face-request').getByText('Compare our launch ideas.').waitFor();
    assert.match(await page.locator('#assistant-face .assistant-face-status').textContent(), /^(Asked|Not picked up yet)/);
    assert.equal(await page.locator('#assistant-activity').evaluate(n=>n.open), false);
  }
  await peer.locator('#assistant-face').getByRole('button',{name:'Add context',exact:true}).click(); await send(peer,'Keep the design mobile first.');
  await peer.waitForFunction(()=>document.querySelector('#assistant-runs').textContent.includes('mobile first'));
  run=(await api('producer')).runs[0]; assert.equal(run.inputs.length,2); assert.equal(run.inputs[1].status,'pending');
  run=(await api('producer',{action:'claim',runId:run.id,attemptId:'test-host',expectedRevision:run.revision})).result;
  run=(await api('producer',{action:'report',runId:run.id,attemptId:'test-host',expectedRevision:run.revision,state:'working',summary:'Comparing mobile readability.',appliedInputMessageIds:run.inputs.map(i=>i.sourceMessageId)})).result;
  await peer.waitForFunction(()=>document.querySelector('#assistant-runs').textContent.includes('Comparing mobile readability.'));
  const post = await fetch(`${origin}/api/rooms/commons/commands`,{method:'POST',headers:{Authorization:`Bearer ${f.keys.producer}`,'Content-Type':'application/json'},body:JSON.stringify({id:'public-result-command',type:'message.posted',data:{messageId:'public-result',body:'Recommendation: choose the simpler mobile layout.'}})});assert.ok(post.ok);
  await api('producer',{action:'report',runId:run.id,attemptId:'test-host',expectedRevision:run.revision,state:'done',summary:'The recommendation is ready.',resultMessageId:'public-result'});
  for(const page of pages) { await page.waitForFunction(()=>document.querySelector('#assistant-runs').textContent.includes('Result ready')); await page.locator('#assistant-face [data-assistant-message="public-result"]').click(); await page.locator('[data-message-record-id="public-result"]').waitFor(); }
  for(const page of pages) {
    await page.locator('#assistant-face .assistant-face-status').getByText('Result ready',{exact:true}).waitFor();
    assert.equal(await page.locator('#assistant-face').getByRole('button',{name:'Open result',exact:true}).count(), 1, 'the result is one tap from the card face');
    assert.equal(await page.locator('#assistant-face').getByRole('button',{name:'Stop',exact:true}).count(), 0, 'a finished ask has no Stop');
  }
  await owner.locator('#room-more > summary').click(); await owner.locator('#topbar-settings').click();
  await owner.locator('#human-advanced').check(); assert.equal(await owner.locator('#human-advanced').isChecked(),true);
  await owner.locator('#human-advanced').uncheck();
  await owner.keyboard.press('Escape');
  const resultTask = owner.locator('[data-work-record-id="human-result-task"]');
  await resultTask.locator('details.work-details > summary').click();
  await resultTask.locator('[data-action="complete"]').click();
  const humanResultBody = 'A result written by a human, without protocol fields.';
  await owner.locator('#human-share-result textarea').fill(humanResultBody);
  // The task changes after opening the result editor. The real server rejects
  // the old proposal revision; recovery must preserve text and require review.
  f.store.command(f.keys.owner,'commons',{id:crypto.randomUUID(),type:'work.blocked',data:{workItemId:'human-result-task',expectedRevision:2,reason:'New requirement',nextAction:'Review the updated task'}});
  f.store.command(f.keys.owner,'commons',{id:crypto.randomUUID(),type:'work.started',data:{workItemId:'human-result-task',expectedRevision:3,resolvedBlocker:'Requirement reviewed'}});
  const rejectedDraft = owner.waitForResponse(response => response.url().endsWith('/commands') && response.request().postDataJSON()?.data?.body === humanResultBody);
  await owner.locator('#human-share-result button[type=submit]').click();
  assert.equal((await rejectedDraft).status(),409);
  assert.equal(f.store.room('commons').state.messages.filter(m=>m.body===humanResultBody).length,0);
  await owner.locator('#human-share-refresh').waitFor({state:'visible',timeout:3000});
  assert.equal(await owner.locator('#human-share-result textarea').inputValue(),humanResultBody);
  await owner.locator('#human-share-refresh').click();
  await owner.waitForFunction(()=>!document.querySelector('#human-share-result textarea').disabled);
  assert.equal(await owner.locator('#human-share-result textarea').isEnabled(),true);
  assert.equal(await owner.locator('#human-share-result textarea').inputValue(),humanResultBody);
  // A committed draft with a lost response is a different case: retry the
  // same immutable command, even if transport confirmation is unavailable.
  const draftCommands = [], draftPending = deferredResultResponse(), releaseDraft = deferredResultResponse();
  await owner.route('**/api/rooms/commons/commands',async route=>{
    const command=route.request().postDataJSON();
    if(command?.data?.body===humanResultBody) {
      draftCommands.push(command);
      if(draftCommands.length===1) { await route.fetch(); draftPending.resolve(); await releaseDraft.promise; await route.abort(); return; }
    }
    await route.continue();
  });
  await owner.locator('#human-share-result button[type=submit]').click();
  await draftPending.promise;
  try {
    await owner.locator('#human-share-result [data-close-share]').click();
    await openHumanResult(owner,'human-result-task');
    assert.equal(await owner.locator('#human-share-result textarea').inputValue(),humanResultBody);
    assert.equal(await owner.locator('#human-share-result button[type=submit]').isDisabled(),true,'reopening the same task keeps its pending send locked');
  } finally { releaseDraft.resolve(); }
  await owner.locator('#human-share-result button[type=submit]').filter({hasText:'Retry original draft'}).waitFor();
  await owner.locator('#human-share-result [data-close-share]').click();
  await openHumanResult(owner,'human-result-task');
  assert.equal(await owner.locator('#human-share-result textarea').isDisabled(),true);
  assert.equal(await owner.locator('#human-share-result textarea').inputValue(),humanResultBody);
  assert.match(await owner.locator('#human-share-result button[type=submit]').textContent(),/Retry original draft/);
  assert.equal(await owner.locator('#human-share-refresh').isVisible(),false);
  await owner.locator('#human-share-result button[type=submit]').click();
  await owner.locator('#action-dialog').waitFor({state:'visible'});
  await owner.unroute('**/api/rooms/commons/commands');
  assert.equal(draftCommands.length,2); assert.deepEqual(draftCommands[1],draftCommands[0]);
  assert.equal(draftCommands[0].data.basisRevision,4);
  assert.equal(f.store.room('commons').state.messages.filter(m=>m.body===humanResultBody).length,1);
  assert.equal(await owner.locator('#action-fields [name=signedEvidence]').count(),0);
  await owner.locator('#action-fields [name=producerId]').selectOption('owner');
  await owner.locator('#action-fields [name=summary]').fill('Simple human result');
  await owner.locator('#action-fields [name=nextAction]').fill('Discuss together');
  await owner.locator('#action-form button[type=submit]').click(); await owner.locator('#action-dialog').waitFor({state:'hidden'});
  assert.ok(f.store.room('commons').state.workItems['human-result-task'].receipt.nativeText);
  // An invocation committed on the server but its response was lost. Reload + exact retry
  // must recover one run, while keeping the already-posted prompt in the transcript.
  await owner.route('**/api/rooms/commons/assistant', async route => {
    const payload = route.request().postDataJSON();
    if (route.request().method() === 'POST' && payload?.action === 'invoke') {
      await route.fetch(); await route.abort(); await owner.unroute('**/api/rooms/commons/assistant');
    } else await route.continue();
  });
  await owner.locator('#ask-room').click(); await send(owner,'Recover this request exactly once.');
  await owner.locator('#assistant-retry').waitFor({state:'visible'});
  const beforeRetry = (await api('owner')).runs;
  assert.equal(beforeRetry.length,2);
  await owner.reload(); await owner.locator('#main').waitFor({state:'visible'});
  await owner.locator('#assistant-retry').waitFor({state:'visible'}); await owner.locator('#assistant-retry').click();
  await owner.locator('#assistant-retry').waitFor({state:'hidden'});
  assert.equal((await api('owner')).runs.length,2);
  // Select context at revision N; the host claims N+1 before the human sends.
  // A rejected stale write needs review and a new explicit confirmation, not an endless retry.
  await peer.waitForFunction(()=>document.querySelector('#assistant-runs').textContent.includes('Recover this request exactly once.'));
  let recovery = (await api('producer')).runs.find(r=>r.id!==run.id);
  await peer.locator(`#assistant-face [data-contribute-run="${recovery.id}"]`).click(); // the newest open ask is on the card face
  recovery = (await api('producer',{action:'claim',runId:recovery.id,attemptId:'recovery-host',expectedRevision:recovery.revision})).result;
  await send(peer,'Please include our latest constraint.');
  await peer.locator('#assistant-review').waitFor({state:'visible'});
  assert.equal((await api('producer')).runs.find(r=>r.id===recovery.id).inputs.length,1);
  await peer.locator('#assistant-review').click(); await peer.locator('#assistant-retry').click();
  await peer.locator('#assistant-retry').waitFor({state:'hidden'});
  assert.equal((await api('producer')).runs.find(r=>r.id===recovery.id).inputs.length,2);
  // Stop is available for ordinary requests, without deleting the prompt.
  // Losing the committed response must preserve one exact cancellation for retry.
  const ownerRun = owner.locator(`[data-assistant-run="${recovery.id}"]`);
  const peerRun = peer.locator(`[data-assistant-run="${recovery.id}"]`);
  await owner.locator('#assistant-activity').evaluate(n => { n.open = true; });
  await ownerRun.getByRole('button', {name:'Stop', exact:true}).waitFor({timeout:3000});
  assert.equal(await peerRun.getByRole('button', {name:'Stop', exact:true}).count(), 0);
  recovery = (await api('producer')).runs.find(r => r.id === recovery.id);
  await owner.waitForFunction(({id, revision}) => Number(document.querySelector(`[data-assistant-run="${id}"] [data-cancel]`)?.dataset.revision) === revision, {id:recovery.id, revision:recovery.revision});
  const stops = [];
  await owner.route('**/api/rooms/commons/assistant', async route => {
    const payload = route.request().postDataJSON();
    if (payload?.action !== 'cancel') { await route.continue(); return; }
    stops.push(payload);
    if (stops.length === 1) { await route.fetch(); await route.abort(); }
    else await route.continue();
  });
  await ownerRun.getByRole('button', {name:'Stop', exact:true}).click();
  await owner.locator('#assistant-retry').waitFor({state:'visible'});
  recovery = (await api('producer')).runs.find(r => r.id === recovery.id);
  assert.equal(recovery.status, 'cancel_requested');
  await ownerRun.getByText('Stopping · waiting for confirmation', {exact:true}).waitFor();
  assert.equal(await ownerRun.getByRole('button', {name:'Add context', exact:true}).count(), 0);
  assert.equal(await ownerRun.getByRole('button', {name:'Stop', exact:true}).count(), 0);
  await owner.locator('#assistant-retry').click();
  await owner.locator('#assistant-retry').waitFor({state:'hidden'});
  assert.equal(stops.length, 2);
  assert.deepEqual(stops[1], stops[0]);
  await api('producer', {action:'report', runId:recovery.id, attemptId:'recovery-host', expectedRevision:recovery.revision, state:'cancelled', summary:'Stopped.'});
  await owner.waitForFunction(id => document.querySelector(`[data-assistant-run="${id}"]`).textContent.includes('Cancelled'), recovery.id);
  assert.equal(await ownerRun.getByRole('button', {name:'Stop', exact:true}).count(), 0);
  // The result link returns to the exact public answer, rather than a different run.
  await peer.locator('#assistant-activity').evaluate(n=>{n.open=true;}); // an older request's result lives in Activity
  await peer.locator('#assistant-runs [data-assistant-message="public-result"]').click();
  assert.equal(await peer.locator('[data-message-record-id="public-result"]').count(),1);
  mkdirSync('test-results',{recursive:true}); await peer.screenshot({path:'test-results/human-shared-conversation.png',fullPage:false});
  assert.deepEqual(errors,[]);
});

// Result-editor ownership belongs at this real browser boundary. The active-entry
// conflict and exact-retry cases above cannot detect a closed editor's delayed
// catch/finally mutating its replacement. Routes delay real responses, without
// exposing production state or adding an alternate implementation of the editor.
test('a closed result editor cannot mutate its replacement after a delayed response', {timeout:90000}, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({store:f.store,streamInterval:40});
  const memberId = 'result-race-human', accountId = 'result-race-account', otherRoom = 'result-race-other';
  f.store.command(f.keys.owner,'commons',{id:crypto.randomUUID(),type:'member.added',data:{memberId,displayName:'Result reader',kind:'human',permissions:f.store.room('commons').state.members.owner.permissions}});
  f.store.createAccount(accountId); f.store.completeOnboarding(accountId);
  f.store.bindHumanAccount('commons',memberId,accountId);
  const other = initialRoom(otherRoom,memberId);
  other[0].data.title = 'Other result room';
  f.store.initialize(other);
  f.store.bindHumanAccount(otherRoom,memberId,accountId);
  const roomKeys = {commons:f.store.issueAccessKey('commons',memberId),[otherRoom]:f.store.issueAccessKey(otherRoom,memberId)};
  for (const [roomId,key] of Object.entries(roomKeys)) for (const workItemId of ['result-race-a','result-race-b']) {
    for (const [type,data] of [
      ['work.proposed',{workItemId,title:workItemId,definitionOfDone:'Save a readable result',accountableMemberId:memberId,mode:'read',independentVerificationRequired:false,ownerDecisionRequired:false}],
      ['work.accepted',{workItemId,expectedRevision:0}],
      ['work.started',{workItemId,expectedRevision:1}]
    ]) f.store.command(key,roomId,{id:crypto.randomUUID(),type,data});
  }
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser = null;
  t.after(async () => { await browser?.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); f.store.close(); rmSync(f.directory,{recursive:true,force:true}); });
  browser = await chromium.launch({headless:true});
  for (const outcome of ['offline','conflict','success','new session','new room']) {
    await t.test(`late ${outcome} leaves the current result editor owned by its own request`, async t => {
      const context = await browser.newContext({viewport:{width:1280,height:900}}), page = await context.newPage(), held = [], errors = [];
      t.after(async () => { for (const response of held) response.release(); await page.unrouteAll({behavior:'wait'}); await context.close(); });
      page.on('pageerror', failure => errors.push(failure.message));
      await page.goto(origin); await signInFixture(page,roomKeys.commons);
      await page.waitForFunction(() => document.body.classList.contains('human-experience'));
      const oldBody = `Old result: ${outcome}`, currentBody = `Current result: ${outcome}`;
      const crossesBoundary = outcome === 'new session' || outcome === 'new room', pendingReplacement = outcome === 'success' || crossesBoundary;
      const currentRoom = outcome === 'new room' ? otherRoom : 'commons';
      await openHumanResult(page,'result-race-a');
      await page.locator('#human-share-result textarea').fill(oldBody);
      if (outcome === 'conflict') {
        const revision = f.store.room('commons').state.workItems['result-race-a'].revision;
        f.store.command(roomKeys.commons,'commons',{id:crypto.randomUUID(),type:'work.blocked',data:{workItemId:'result-race-a',expectedRevision:revision,reason:'Changed requirement',nextAction:'Review the task'}});
        f.store.command(roomKeys.commons,'commons',{id:crypto.randomUUID(),type:'work.started',data:{workItemId:'result-race-a',expectedRevision:revision+1,resolvedBlocker:'Requirement reviewed'}});
      }
      const old = await holdResultResponse(page,oldBody,{offline:outcome === 'offline'}); held.push(old);
      await page.locator('#human-share-result button[type=submit]').click();
      const captured = await old.captured;
      if (captured.response) assert.equal(captured.response.status(),outcome === 'conflict' ? 409 : 201);
      assert.equal(await page.locator('#human-share-result button[type=submit]').isDisabled(),true);
      if (pendingReplacement) {
        await page.locator(`[data-message-record-id="${captured.command.data.messageId}"]`).waitFor({state:'attached'});
      }
      await page.locator('#human-share-result [data-close-share]').click();
      if (crossesBoundary) {
        // Restore the same human, optionally in another room, without reloading:
        // the old callback must survive to exercise the actual boundary guard.
        await clickChrome(page,'#signout-button');
        await page.locator('#auth-panel').waitFor({state:'visible'});
        const restored = await context.request.post(`${origin}/api/session`,{headers:{Origin:origin},data:{accessKey:roomKeys[currentRoom]},maxRedirects:0});
        assert.equal(restored.status(),201);
        assert.equal((await restored.json()).roomId,currentRoom);
        await page.evaluate(() => history.replaceState(null,'','/'));
        await page.locator('#refresh-button').evaluate(button => button.click());
        await page.locator('#main').waitFor({state:'visible'});
        await page.waitForFunction(title => document.querySelector('#room-title').textContent === title,f.store.room(currentRoom).state.room.title);
      }
      const currentWork = crossesBoundary ? 'result-race-a' : 'result-race-b';
      await openHumanResult(page,currentWork);
      await page.locator('#human-share-result textarea').fill(currentBody);
      let current;
      if (pendingReplacement) {
        current = await holdResultResponse(page,currentBody,{roomId:currentRoom}); held.push(current);
        await page.locator('#human-share-result button[type=submit]').click();
        const pending = await current.captured;
        assert.equal(pending.response.status(),201);
        await page.locator(`[data-message-record-id="${pending.command.data.messageId}"]`).waitFor({state:'attached'});
        assert.equal(await page.locator('#human-share-result button[type=submit]').isDisabled(),true);
      }
      await old.deliver();
      assert.equal(await page.locator('#human-share-result').isVisible(),true);
      assert.equal(await page.locator('#human-share-result textarea').inputValue(),currentBody);
      assert.equal(await page.locator('#human-share-result textarea').isEnabled(),true,'an obsolete failure must not lock the current draft');
      assert.equal(await page.locator('#human-share-error').textContent(),'','an obsolete failure must not replace the current error');
      assert.equal(await page.locator('#human-share-refresh').isVisible(),false);
      assert.equal(await page.locator('#human-share-result button[type=submit]').textContent(),'Review result');
      assert.equal(await page.locator('#human-share-result button[type=submit]').isDisabled(),Boolean(current),'an obsolete completion must not unlock a newer pending send');
      assert.equal(await page.locator('#action-dialog').isVisible(),false,'an obsolete success must not select its result');
      if (current) {
        await current.deliver();
        await page.locator('#human-share-result').waitFor({state:'hidden'});
        await page.locator('#action-dialog').waitFor({state:'visible'});
        assert.equal(f.store.room(currentRoom).state.messages.find(message => message.body === currentBody).workItemId,currentWork);
      }
      assert.deepEqual(errors,[]);
    });
  }
});

// Owns post-login discovery, preference persistence, draft recovery and first-screen simplicity.
test('human Advanced tools stay out of the door and preserve squad drafts and saved preferences', { timeout: 60000 }, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({store:f.store, streamInterval:40});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, browser=await chromium.launch({headless:true});
  t.after(async()=>{await browser.close();server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));f.store.close();rmSync(f.directory,{recursive:true,force:true});});
  const page=await browser.newPage(), errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/#join-agent');
  await page.locator('#auth-panel').waitFor({state:'visible'});
  assert.equal(await page.getByRole('button',{name:'Agent sign in',exact:true}).count(),1);
  assert.equal(await page.locator('#static-hero').count(),0);
  assert.equal(await page.locator('#connect-guide-dialog').isVisible(),false);
  assert.equal(await page.locator('#connect-guide-open').isVisible(),false);
  assert.equal(await page.getByRole('link',{name:'Demo conversation'}).isVisible(),false);
  await signInFixture(page,f.keys.owner);
  await page.locator('#connect-guide-dialog').waitFor({state:'visible'});
  assert.match(await page.locator('#connect-guide-copy').innerText(),/running host/);
  await page.locator('#connect-guide-close').click();
  assert.equal(await page.locator('#squads-open').isVisible(),false);
  await page.locator('#room-more > summary').click(); await page.locator('#topbar-settings').click();
  await page.keyboard.press('Escape'); await openCatchUpPanel(page,'notification-panel');
  await page.locator('#human-push-prefs').waitFor({state:'visible'});
  await page.route('**/api/rooms/commons/human-push', async route => {
    if (route.request().method() === 'PATCH') await new Promise(resolve=>setTimeout(resolve,250));
    await route.continue();
  });
  await page.locator('#human-push-pref-dm').uncheck();
  f.store.command(f.keys.guest,'commons',{id:crypto.randomUUID(),type:'message.posted',data:{messageId:crypto.randomUUID(),body:'chat during preference save'}});
  await page.waitForFunction(()=>document.querySelector('#human-push-note').textContent==='Notification preferences saved.');
  assert.equal(f.store.humanPush.preferences(f.keys.owner,'commons').preferences.dm,false);
  assert.equal(await page.locator('#human-push-pref-dm').isEnabled(),true);
  await page.keyboard.press('Escape'); await page.locator('#room-more > summary').click(); await page.locator('#topbar-settings').click();
  await page.locator('#advanced-room-tools > summary').click();
  assert.equal(await page.getByRole('link',{name:'Demo conversation'}).isVisible(),true);
  await page.locator('#connect-guide-open').click(); await page.locator('#connect-guide-close').click();
  await page.locator('#human-advanced').check(); await page.keyboard.press('Escape');
  await page.locator('#squads-open').click();
  await page.locator('#squads-list input[name=name]').fill('team');
  await page.locator('#squads-list input[name=goal]').fill('Ship together');
  await page.locator('#squads-list input[name=memberId][value=guest]').check();
  f.store.command(f.keys.guest,'commons',{id:crypto.randomUUID(),type:'message.posted',data:{messageId:crypto.randomUUID(),body:'chat while drafting'}});
  await page.waitForTimeout(200);
  assert.equal(await page.locator('#squads-list input[name=goal]').inputValue(),'Ship together');
  await page.locator('#squads-list button[type=submit]').click();
  await page.locator('#squads-list .squad-card').waitFor();
  assert.match(f.store.db.prepare("SELECT members_json FROM squads WHERE name='team'").get().members_json,/guest/);
  await page.locator('#squads-list input[name=name]').fill('team');
  await page.locator('#squads-list input[name=goal]').fill('Keep this rejected draft');
  await page.locator('#squads-list button[type=submit]').click();
  await page.locator('#squads-list [role=alert]').waitFor();
  assert.equal(await page.locator('#squads-list input[name=goal]').inputValue(),'Keep this rejected draft');
  assert.deepEqual(errors,[]);
});

test('deleted assistant prompt shows only content-free stop controls and preserves the conversation draft', {timeout:60000}, async t => {
  const f=createAcceptanceFixture(), server=createRoomServer({store:f.store,streamInterval:40});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`, browser=await chromium.launch({headless:true});
  t.after(async()=>{await browser.close();server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));f.store.close();rmSync(f.directory,{recursive:true,force:true});});
  const api=async(actor,input)=>{
    const response=await fetch(`${origin}/api/rooms/commons/assistant`,{method:'POST',headers:{authorization:`Bearer ${f.keys[actor]}`,'content-type':'application/json'},body:JSON.stringify({requestId:crypto.randomUUID(),...input})});
    const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value.result;
  };
  await api('owner',{action:'configure',expectedRevision:0,name:'Room',coordinatorMemberId:'producer'});
  f.store.command(f.keys.owner,'commons',{id:crypto.randomUUID(),type:'message.posted',data:{messageId:'erase-browser-prompt',body:'ERASED-BROWSER-PROMPT'}});
  await api('owner',{action:'invoke',runId:'deleted-browser-run',sourceMessageId:'erase-browser-prompt'});
  await api('producer',{action:'claim',runId:'deleted-browser-run',attemptId:'browser-host',expectedRevision:0});
  await api('producer',{action:'report',runId:'deleted-browser-run',attemptId:'browser-host',expectedRevision:1,state:'working',summary:'ERASED-BROWSER-PROMPT'});
  const page=await browser.newPage();await page.goto(origin);await signInFixture(page,f.keys.owner);
  await page.locator('#main').waitFor({state:'visible'});
  await page.locator('#assistant-activity > summary').click();
  const panel=page.locator('[data-assistant-run="deleted-browser-run"]');
  await panel.getByRole('button',{name:'Original prompt',exact:true}).waitFor();
  await page.locator('#message-input').fill('Keep my unsent conversation draft.');
  // Keep the old assistant projection cached while real message deletion arrives.
  await page.route('**/api/rooms/commons/assistant',route=>route.request().method()==='GET'?route.abort():route.continue());
  const deletion=await fetch(`${origin}/api/rooms/commons/commands`,{method:'POST',headers:{authorization:`Bearer ${f.keys.owner}`,'content-type':'application/json'},body:JSON.stringify({id:crypto.randomUUID(),type:'message.deleted',data:{messageId:'erase-browser-prompt',expectedMessageRevision:0}})});
  assert.equal(deletion.status,201,await deletion.text());
  await panel.getByText('Deleted request',{exact:true}).waitFor({timeout:5000});
  assert.doesNotMatch(await panel.textContent(),/ERASED-BROWSER-PROMPT/);
  await page.unroute('**/api/rooms/commons/assistant');
  for(const name of ['Original prompt','Add context','Change direction','Resolve direction','Resume']) assert.equal(await panel.getByRole('button',{name,exact:true}).count(),0);
  await panel.getByRole('button',{name:'Pause',exact:true}).click();
  await panel.getByText('Pausing · waiting for confirmation',{exact:true}).waitFor();
  await api('producer',{action:'report',runId:'deleted-browser-run',attemptId:'browser-host',expectedRevision:3,state:'paused',summary:'Stopped'});
  await panel.getByText('Paused',{exact:true}).waitFor();
  assert.equal(await panel.getByRole('button',{name:'Resume',exact:true}).count(),0);
  await panel.getByRole('button',{name:'Stop',exact:true}).click();
  await panel.getByText('Stopping · waiting for confirmation',{exact:true}).waitFor();
  await api('producer',{action:'report',runId:'deleted-browser-run',attemptId:'browser-host',expectedRevision:5,state:'cancelled',summary:'Cancelled'});
  await panel.getByText('Cancelled',{exact:true}).waitFor();
  assert.equal(await panel.getByRole('button').count(),0);
  assert.equal(await page.locator('#message-input').inputValue(),'Keep my unsent conversation draft.');
});

test('keyboard Stop on the card face keeps focus and the status change is announced (R5-1, R5-2)', {timeout:60000}, async t => {
  const f=createAcceptanceFixture(), server=createRoomServer({store:f.store,streamInterval:40});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`, browser=await chromium.launch({headless:true});
  t.after(async()=>{await browser.close();server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));f.store.close();rmSync(f.directory,{recursive:true,force:true});});
  const api=async(actor,input)=>{
    const response=await fetch(`${origin}/api/rooms/commons/assistant`,{method:'POST',headers:{authorization:`Bearer ${f.keys[actor]}`,'content-type':'application/json'},body:JSON.stringify({requestId:crypto.randomUUID(),...input})});
    const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value.result;
  };
  await api('owner',{action:'configure',expectedRevision:0,name:'Room',coordinatorMemberId:'producer'});
  f.store.command(f.keys.owner,'commons',{id:crypto.randomUUID(),type:'message.posted',data:{messageId:'kbd-ask',body:'Plan the offsite'}});
  await api('owner',{action:'invoke',runId:'kbd-run',sourceMessageId:'kbd-ask'});
  await api('producer',{action:'claim',runId:'kbd-run',attemptId:'kbd-host',expectedRevision:0});
  const page=await browser.newPage({viewport:{width:390,height:844}});await page.goto(origin);await signInFixture(page,f.keys.owner);
  await page.locator('#main').waitFor({state:'visible'});
  const status=page.locator('#assistant-face [role=status]');
  await status.getByText('Working',{exact:true}).waitFor();
  assert.equal(await status.getAttribute('aria-live'),'polite');
  assert.equal(await page.locator('#assistant-setup').textContent(),'Change','a connected assistant offers Change, not Connect');
  const snapshot = await (await fetch(`${origin}/api/rooms/commons/assistant`, {headers:{authorization:`Bearer ${f.keys.owner}`}})).json();
  let frozen = true, stopPayload;
  await page.route('**/api/rooms/commons/assistant', async route => {
    if (route.request().method() === 'GET' && frozen) { await route.fulfill({json:snapshot}); return; }
    if (route.request().method() === 'POST' && route.request().postDataJSON()?.action === 'cancel') {
      stopPayload = route.request().postDataJSON(); frozen = false;
    }
    await route.continue();
  });
  // A progress event advances revision after this human saw the card. The same
  // attempt must remain stoppable without an extra Review/retry interaction.
  await api('producer',{action:'report',runId:'kbd-run',attemptId:'kbd-host',expectedRevision:1,state:'working',summary:'More progress.'});
  await page.locator('#assistant-face [data-cancel]').focus(); await page.keyboard.press('Enter');
  await status.getByText('Stopping…',{exact:true}).waitFor();
  assert.equal(stopPayload.expectedAttemptId, 'kbd-host');
  assert.equal(stopPayload.expectedRevision, 1, 'the UI sent its observed revision rather than silently refreshing the control');
  const focus=await page.evaluate(()=>({ body: document.activeElement===document.body, inCard: Boolean(document.activeElement?.closest('#room-assistant')) }));
  assert.deepEqual(focus,{body:false,inCard:true},'focus stays on the Room card after a keyboard Stop');
  await api('producer',{action:'report',runId:'kbd-run',attemptId:'kbd-host',expectedRevision:3,state:'cancelled',summary:'Stopped.'});
  await status.getByText('Stopped',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>document.activeElement===document.body),false,'focus survives the Stop button disappearing');
});
test('ask card shows not-picked-up and stalled statuses with the result on the card', { timeout: 60000 }, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch({headless:true});
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); f.store.close(); rmSync(f.directory,{recursive:true,force:true}); });
  const errors = [];
  const context = await browser.newContext({viewport:{width:1280,height:900}}), page = await context.newPage();
  page.on('pageerror', e=>errors.push(e.message)); await page.goto(origin); await signInFixture(page,f.keys.owner);
  await page.locator('#main').waitFor({state:'visible'}); await page.waitForFunction(()=>document.body.classList.contains('human-experience'));
  const api = async (actor, input) => {
    const response = await fetch(`${origin}/api/rooms/commons/assistant`, {method:input?'POST':'GET',headers:{Authorization:`Bearer ${f.keys[actor]}`,...(input?{'Content-Type':'application/json'}:{})},...(input?{body:JSON.stringify({requestId:crypto.randomUUID(),...input})}:{})});
    const json=await response.json(); assert.ok(response.ok,JSON.stringify(json));return json;
  };
  await page.locator('#assistant-setup').click(); await page.locator('#room-assistant-setup select').selectOption('producer');
  await page.locator('#room-assistant-setup button[type=submit]').click(); await page.locator('#room-assistant-setup').waitFor({state:'hidden'});
  await page.locator('#ask-room').click();
  await page.locator('#message-input').fill('What is the plan?');
  await page.locator('#message-form button[type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('#message-input').value==='');
  await page.waitForFunction(()=>document.querySelector('#assistant-runs').textContent.includes('What is the plan?'));
  // A queued run nobody claims for 10s reads not picked up on the card.
  const base = f.store.now(); f.store.now = () => base + 11000;
  await page.waitForFunction(()=>document.querySelector('#assistant-runs').textContent.includes('Not picked up'));
  let run = (await api('producer')).runs[0]; assert.equal(run.status,'queued'); assert.equal(run.displayStatus,'not_picked_up');
  run = (await api('producer',{action:'claim',runId:run.id,attemptId:'host-3a',expectedRevision:run.revision})).result;
  assert.equal(run.status,'working');
  // A working run whose host goes silent for 2min reads stalled on the card.
  const claimedAt = f.store.now(); f.store.now = () => claimedAt + 121000;
  await page.waitForFunction(()=>document.querySelector('#assistant-runs').textContent.includes('Stalled'));
  assert.equal((await api('producer')).runs[0].displayStatus,'stalled');
  // The published answer lands on the card itself.
  run = (await api('producer',{action:'publish',runId:run.id,attemptId:'host-3a',expectedRevision:run.revision,summary:'Plan ready.',body:'The plan is to ship the fence first.',appliedInputMessageIds:run.inputs.map(i=>i.sourceMessageId)})).result;
  assert.equal(run.status,'done');
  await page.waitForFunction(()=>document.querySelector('#assistant-runs').textContent.includes('The plan is to ship the fence first.'));
  assert.equal(await page.locator('.assistant-run-result').count(),1);
  assert.deepEqual(errors,[]);
});

for (const [width, colorScheme] of [[1280, 'dark'], [390, 'light']]) {
  test(`a shared ask keeps additions in its own conversation (${width}, ${colorScheme})`, { timeout: 45000 }, async t => {
    const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 40 });
    const command = (type, data) => f.store.command(f.keys.owner, 'commons', { id: crypto.randomUUID(), type, data });
    command('channel.created', { name: 'design' });
    const channelId = Object.values(f.store.room('commons').state.channels).find(c => c.name === 'design').id;
    command('message.posted', { messageId: 'design-root', body: 'Our design conversation', channelId });
    command('message.posted', { messageId: 'shared-ask', body: 'Compare our launch ideas.', channelId, replyToId: 'design-root' });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const api = async (actor, input) => {
      const res = await fetch(`${origin}/api/rooms/commons/assistant`, {
        method: input ? 'POST' : 'GET', headers: { Authorization: `Bearer ${f.keys[actor]}`, 'Content-Type': 'application/json' },
        ...(input ? { body: JSON.stringify({ requestId: crypto.randomUUID(), ...input }) } : {})
      });
      const value = await res.json(); assert.equal(res.status, 200, JSON.stringify(value)); return value;
    };
    await api('owner', { action: 'configure', name: 'Room', coordinatorMemberId: 'producer', expectedRevision: 0 });
    await api('owner', { action: 'invoke', runId: 'shared', sourceMessageId: 'shared-ask' });
    const browser = await chromium.launch({ headless: true });
    t.after(async () => {
      await browser.close(); server.closeStreams(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true });
    });
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme, reducedMotion: 'reduce' });
    page.setDefaultTimeout(8000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin); await signInFixture(page, f.keys.guest);
    await page.locator('#assistant-face').waitFor({ state: 'visible' });
    await page.locator('#assistant-activity > summary').click();
    await page.locator('#assistant-runs [data-assistant-message="shared-ask"]').click();
    await page.locator('#message-input').fill('Keep the existing design thread draft.');
    if (width === 390) {
      await page.locator('#composer-options > summary').click();
      await page.locator('#message-to-select').selectOption('producer');
      await page.locator('#composer-options > summary').click();
    }
    await openSettings(page); await page.locator('#advanced-room-tools > summary').click();
    await page.locator('#human-advanced').check(); await closeSettings(page);
    if (width < 700) await page.locator('#sidebar-toggle').click();
    await page.locator('#channel-list [data-channel="general"]').click(); await ensureSidebarClosed(page);
    await page.locator('#message-input').fill('Keep this unrelated general draft.');
    await page.locator('#assistant-face [data-contribute-run="shared"]').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#message-input').evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator('#message-input').inputValue(), '', 'adding context does not repurpose the destination draft');
    assert.equal(await page.locator('#message-to-select').isDisabled(), true, 'shared context cannot silently become private');
    await page.locator('#message-input').fill('Keep the design mobile first.');
    await page.locator('#cancel-reply').click();
    assert.equal(await page.locator('#message-input').inputValue(), 'Keep the existing design thread draft.');
    await page.locator('#assistant-face [data-contribute-run="shared"]').click();
    assert.equal(await page.locator('#message-input').inputValue(), 'Keep the design mobile first.', 'cancelling the contribution preserves its own draft');
    const response = page.waitForResponse(res => res.url().endsWith('/assistant') && res.request().method() === 'POST');
    await page.locator('#message-form button[type=submit]').click();
    const sent = await response;
    assert.equal(sent.status(), 200, await sent.text());
    const run = (await api('producer')).runs.find(r => r.id === 'shared');
    assert.equal(run.inputs.length, 2);
    const added = f.store.room('commons').state.messages.find(m => m.id === run.inputs[1].sourceMessageId);
    assert.equal(added.authorId, 'guest');
    assert.equal(added.channelId, channelId);
    assert.equal(added.replyToId, 'shared-ask');
    assert.equal(added.toMemberId, null);
    assert.equal(await page.locator('#message-input').inputValue(), 'Keep the existing design thread draft.');
    assert.equal(await page.locator('#message-to-select').inputValue(), width === 390 ? 'producer' : '');
    assert.equal(await page.locator('#reply-bar').isVisible(), false, 'the restored thread draft still replies to its original root');
    if (width < 700) await page.locator('#sidebar-toggle').click();
    await page.locator('#channel-list [data-channel="general"]').click();
    await ensureSidebarClosed(page);
    assert.equal(await page.locator('#message-input').inputValue(), 'Keep this unrelated general draft.');
    await page.locator('#assistant-face [data-contribute-run="shared"]').click();
    await page.locator('#message-input').fill('Unsent additional context.');
    if (width < 700) await page.locator('#sidebar-toggle').click();
    await page.locator('#channel-list [data-channel="general"]').click(); await ensureSidebarClosed(page);
    assert.equal(await page.locator('#ask-room').textContent(), 'Ask Room');
    await page.locator('#message-input').fill('Ordinary group banter.');
    const posted = page.waitForResponse(res => res.url().endsWith('/commands') && res.request().postDataJSON()?.data?.body === 'Ordinary group banter.');
    await page.locator('#message-form button[type=submit]').click(); assert.equal((await posted).status(), 201);
    await page.waitForFunction(() => document.querySelector('#message-input').value === '');
    assert.equal((await api('producer')).runs.length, 1, 'leaving context mode does not turn ordinary chat into a new ask');
    await page.locator('#assistant-face [data-contribute-run="shared"]').click();
    assert.equal(await page.locator('#message-input').inputValue(), 'Unsent additional context.');
    assert.deepEqual(errors, []);
  });
}
