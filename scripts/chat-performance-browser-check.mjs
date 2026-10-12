import { openMemberProfile } from "./room-chrome.mjs";
// Observable chat cost contract: ordinary arrivals leave historical DOM and
// hidden logs untouched and do not poll unchanged request-run subscriptions.
// Existing chat suites check focus/content, not redundant mutations or reads.
// Real Chromium + local server; no production hooks or timing threshold.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { signInFixture } from './auth-signin.mjs';
import { openSettings, clickChrome } from './room-chrome.mjs';
import { signInFixtureInPlace } from './in-place-fixture-signin.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { admitHistoricalMember } from './unstamped-member.mjs';
import { RoomStore } from '../server/store.mjs';
import { EVENT_TYPES as T, event } from '../src/events.js';

test('ordinary chat arrivals preserve historical DOM and fetch only changed request subscriptions', { timeout: 30000 }, async t => {
  const f = createAcceptanceFixture({ dmConsent: true });
  let clock = Date.now();
  f.store.now = () => clock;
  const post = (actor, id, extra = {}) => {
    clock += 2100;
    return f.store.command(f.keys[actor], 'commons', { id, type: 'message.posted', data: {
      messageId: id, body: `Chat message ${id}`, ...extra
    } });
  };
  for (let i = 0; i < 60; i++) post('owner', `history-${i}`);
  post('owner', 'first-question', { toMemberId: 'producer', requestKind: 'reply' });
  const server = createRoomServer({ store: f.store, streamInterval: 50 });
  let browser;
  t.after(async () => {
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; let runReads = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/request-runs')) runReads++; });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await signInFixture(page, f.keys.owner);
  const initialRuns = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/request-runs'));
  await page.locator('[data-message-record-id="first-question"]').waitFor();
  await initialRuns;
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const stable = document.querySelector('[data-message-record-id="history-0"]');
    globalThis.chatCost = { stable, mutations: 0, hiddenLogMutations: 0 };
    new MutationObserver(rows => { globalThis.chatCost.mutations += rows.length; })
      .observe(stable, { attributes: true, childList: true, subtree: true, characterData: true });
    new MutationObserver(rows => { globalThis.chatCost.hiddenLogMutations += rows.length; })
      .observe(document.getElementById('event-list'), { childList: true, subtree: true });
  });
  const before = runReads;
  post('producer', 'ordinary-arrival');
  await page.locator('[data-message-record-id="ordinary-arrival"]').waitFor();
  await page.waitForTimeout(200);
  const cost = await page.evaluate(() => ({
    stableRetained: globalThis.chatCost.stable === document.querySelector('[data-message-record-id="history-0"]'),
    mutations: globalThis.chatCost.mutations,
    hiddenLogMutations: globalThis.chatCost.hiddenLogMutations
  }));
  assert.deepEqual(cost, { stableRetained: true, mutations: 0, hiddenLogMutations: 0 });
  assert.equal(runReads, before, 'unrelated chat must not re-read run state');
  const newRuns = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/request-runs'));
  const questionReceipt = post('owner', 'second-question', { toMemberId: 'producer', requestKind: 'reply' });
  await page.locator('[data-message-record-id="second-question"]').waitFor();
  await newRuns;
  assert.equal(runReads, before + 1, 'new request immediately refreshes run labels');
  await openSettings(page, 'record-panel');
  await page.locator(`#event-list [data-event-record-id="${questionReceipt.event.id}"]`).waitFor({ state: 'visible' });
  const visibleReceipt = post('producer', 'visible-record-arrival');
  await page.locator(`#event-list [data-event-record-id="${visibleReceipt.event.id}"]`).waitFor({ state: 'visible' });
  assert.deepEqual(errors, []);
});

// Board claim lines ("X claimed Y") sit between messages and carry no data-key.
// renderMessages used to keep every one of them but the last in place and then
// move each message row after the first claim line, on every arrival.
test('chat arrivals in a room with board claim lines move no message rows', { timeout: 30000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'project-room-claim-rows-'));
  const store = new RoomStore(join(directory, 'room.sqlite'));
  const start = Date.now() - 3600000, events = [];
  const at = minute => new Date(start + minute * 60000).toISOString();
  for (let index = 0; index < 40; index++) events.push(event({ roomId: 'commons', actorId: 'owner', type: T.MESSAGE_POSTED, at: at(index),
    data: { messageId: `claim-row-history-${index}`, body: `History ${index}` } }));
  for (const [index, minute] of [[0, 10.5], [1, 22.5], [2, 33.5]]) events.push(event({ roomId: 'commons', actorId: 'owner',
    type: 'work_claim.updated', at: at(minute), data: { workClaim: `claim-row-${index}`, action: 'claimed', title: `Claim ${index}`, claimState: 'claimed', ownerId: 'owner', leaseExpiresAt: null, paths: [] } }));
  events.sort((a, b) => a.at.localeCompare(b.at));
  store.initialize([...initialRoom('commons', 'owner'), ...events]);
  const ownerKey = store.issueAccessKey('commons', 'owner');
  const server = createRoomServer({ store, streamInterval: 50 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await signInFixture(page, ownerKey);
  await page.locator('[data-message-record-id="claim-row-history-39"]').waitFor();
  await page.locator('#message-list > [data-claim-update]').nth(2).waitFor({ state: 'attached' });
  await page.evaluate(() => {
    globalThis.claimRowMoves = 0;
    new MutationObserver(rows => { for (const row of rows) for (const node of row.removedNodes) if (node.classList?.contains('message')) globalThis.claimRowMoves++; })
      .observe(document.getElementById('message-list'), { childList: true });
  });
  for (const id of ['claim-row-arrival-1', 'claim-row-arrival-2']) {
    store.command(ownerKey, 'commons', { id, type: 'message.posted', data: { messageId: id, body: `Arrival ${id}` } });
    await page.locator(`[data-message-record-id="${id}"]`).waitFor();
  }
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => globalThis.claimRowMoves), 0, 'message rows stay in place when board claim lines are in the timeline');
  const order = await page.locator('#message-list > *').evaluateAll(nodes => nodes.map(node => node.dataset.claimUpdate ? `claim:${node.dataset.claimUpdate}` : node.dataset.messageRecordId).filter(Boolean));
  const after = id => order[order.indexOf(id) + 1];
  assert.deepEqual([after('claim-row-history-10'), after('claim-row-history-22'), after('claim-row-history-33')], ['claim:claim-row-0', 'claim:claim-row-1', 'claim:claim-row-2']);
  assert.equal(order.filter(entry => entry.startsWith('claim:')).length, 3, 'each claim line is painted once');
  assert.deepEqual(order.slice(-2), ['claim-row-arrival-1', 'claim-row-arrival-2']);
  assert.deepEqual(errors, []);
});

test('snapshot labels update duplicates while preserving focus and selection, and late old-room data cannot replace new labels', { timeout: 45000 }, async t => {
  const f = createAcceptanceFixture(), other = initialRoom('other', 'owner');
  other[0].data.title = 'Another private room'; other[1].data.displayName = 'Another private owner';
  f.store.initialize(other); f.store.createAccount('other-private-account'); f.store.bindHumanAccount('other', 'owner', 'other-private-account');
  const otherKey = f.store.issueAccessKey('other', 'owner');
  f.store.command(otherKey, 'other', { id: 'other-message', type: 'message.posted', data: { messageId: 'other-message', body: 'New room private content' } });
  const server = createRoomServer({ store: f.store, streamInterval: 30 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  let release; t.after(async () => { release?.(); await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin); await signInFixture(page, f.keys.owner);
  const original = page.locator('[data-message-record-id="test-welcome"]');
  assert.equal(await original.locator('.message-meta strong').textContent(), 'Room owner');
  const profile = page.locator('[data-member-record-id="owner"] .member-profile');
  await openMemberProfile(page, 'owner');
  await page.evaluate(() => {
    const body = document.querySelector('[data-message-record-id="test-welcome"] .message-body');
    globalThis.retainedAuditBody = body;
    const range = document.createRange(); range.selectNodeContents(body); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    globalThis.auditSelectedText = selection.toString();
    document.querySelector('[data-member-record-id="owner"] .member-profile > summary').focus();
  });
  admitHistoricalMember(f.store, 'commons', 'owner', { memberId: 'duplicate-owner', displayName: ' room OWNER ', kind: 'human', permissions: [] });
  await original.locator('.message-meta strong').filter({ hasText: /^Room owner \(owner\)$/ }).waitFor();
  assert.equal(await profile.evaluate(el => el.open), true);
  const preserved = await page.evaluate(() => ({ body: globalThis.retainedAuditBody === document.querySelector('[data-message-record-id="test-welcome"] .message-body'), selected: getSelection().toString() === globalThis.auditSelectedText, focus: document.activeElement?.dataset.focusKey }));
  assert.deepEqual(preserved, { body: true, selected: true, focus: 'member-profile:owner' });
  let captured, delivered;
  const held = new Promise(resolve => captured = resolve), unblock = new Promise(resolve => release = resolve), finished = new Promise(resolve => delivered = resolve);
  await page.route(/\/api\/rooms\/commons(?:\?|$)/, async route => {
    const response = await route.fetch(); captured(); await unblock; await route.fulfill({ response }); delivered();
  });
  f.store.command(f.keys.owner, 'commons', { id: 'held-private-old', type: 'message.posted', data: { messageId: 'held-private-old', body: 'Old private message must not return' } });
  await held;
  await clickChrome(page, '#signout-button'); await page.locator('#auth-panel').waitFor();
  assert.equal(await page.locator('#presence-list').textContent(), '');
  await signInFixtureInPlace(page, f.store, otherKey, 'other');
  await page.locator('[data-message-record-id="other-message"]').waitFor();
  release(); await finished;
  assert.equal(await page.locator('[data-message-record-id="other-message"] .message-meta strong').textContent(), 'Another private owner');
  assert.equal(await page.locator('#identity-label').textContent(), 'Another private owner');
  assert.equal(await page.locator('[data-message-record-id="test-welcome"]').count(), 0);
  assert.equal(await page.locator('[data-message-record-id="held-private-old"]').count(), 0);
  assert.equal(await page.locator('#presence-list').textContent().then(text => text.includes('Room owner')), false);
  assert.deepEqual(errors, []);
});

// QA-2026-10-07: measurable regression target for the unbounded renderMessages
// finding. Keep opt-in while the renderer is unwindowed; remove the gate when
// the fix lands. Workload retains 2,000 total history records and about 1.7 MB
// of body text, including ten patch-dump-sized messages.
test('large room history completes initial render with a bounded live message DOM', {
  timeout: 90000,
  skip: process.env.ROOM_ENABLE_RENDER_WINDOW_REGRESSION !== '1'
    ? 'TODO(QA-2026-10-07): enable when renderMessages windowing lands; finding: unbounded full-room DOM render.'
    : false
}, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'project-room-render-window-'));
  const store = new RoomStore(join(directory, 'room.sqlite'));
  const base = initialRoom('commons', 'owner');
  const heavy = 'patch dump line with representative source text\n'.repeat(800); // 40 KB each
  const normal = 'ordinary synthetic room history entry '.padEnd(650, 'x');
  const createdAt = Date.now();
  const messages = [];
  for (let index = 1; index <= 2000; index++) {
    messages.push(event({ roomId: 'commons', actorId: 'owner',
      type: T.MESSAGE_POSTED, at: new Date(createdAt + index * 1000).toISOString(),
      data: { messageId: `render-window-message-${String(index).padStart(4, '0')}`, body: index <= 10 ? heavy : normal } }));
  }
  store.initialize([...base, ...messages]);
  const ownerKey = store.issueAccessKey('commons', 'owner');
  const historyCount = store.snapshot(ownerKey, 'commons').state.messages.length;
  assert.equal(historyCount, 2000, 'synthetic workload must remain full room history');

  const server = createRoomServer({ store, streamInterval: 50 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await signInFixture(page, ownerKey);
  const started = performance.now();
  await page.locator('[data-message-record-id="render-window-message-1998"] .message-body').waitFor({ state: 'attached' });
  const initialRenderMs = performance.now() - started;
  const rendered = await page.locator('#message-list .message').count();
  assert.ok(rendered <= 250, `expected <= 250 live message nodes, got ${rendered}`);
  assert.equal(store.snapshot(ownerKey, 'commons').state.messages.length, 2000, 'DOM windowing must not discard room history');
  assert.deepEqual(errors, [], 'initial render completes without browser errors');
  console.log(`render window workload: 2,000 messages, ~1.7 MB text, ${rendered} live nodes, ${initialRenderMs.toFixed(0)} ms until sentinel`);
});

test('typing in the composer leaves unchanged reply text untouched', { timeout: 30000 }, async t => {
  // Every keystroke runs updateReply(). Rewriting an unchanged text node there
  // forced a layout of the whole timeline per key (~600 ms per key at 5,000
  // messages on a throttled phone CPU), so typing lagged in big rooms.
  const f = createAcceptanceFixture();
  for (let i = 0; i < 20; i++) f.store.command(f.keys[i % 2 ? 'producer' : 'owner'], 'commons', { id: `typing-${i}`, type: 'message.posted', data: { messageId: `typing-${i}`, body: `Message ${i}` } });
  const server = createRoomServer({ store: f.store, streamInterval: 50 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await signInFixture(page, f.keys.owner);
  await page.locator('[data-message-record-id="typing-19"]').waitFor();
  const watch = () => page.evaluate(() => {
    globalThis.replyWrites = 0;
    globalThis.replyObserver?.disconnect();
    globalThis.replyObserver = new MutationObserver(rows => { globalThis.replyWrites += rows.length; });
    for (const id of ['reply-context', 'reply-mention']) globalThis.replyObserver.observe(document.getElementById(id), { childList: true, characterData: true, subtree: true });
  });
  const writes = () => page.evaluate(() => globalThis.replyWrites);
  const input = page.locator('#message-input');
  await input.click(); await input.pressSequentially('a'); await watch();
  await input.pressSequentially('nother thought', { delay: 5 });
  assert.equal(await writes(), 0, 'no reply target: typing rewrites no reply text');
  await page.locator('[data-message-record-id="typing-19"] [data-message-action="reply"]').evaluate(node => node.click());
  await page.waitForFunction(() => document.getElementById('reply-mention').textContent.startsWith('Also @ '));
  await input.pressSequentially(' x'); await watch();
  await input.pressSequentially(' and more', { delay: 5 });
  assert.equal(await writes(), 0, 'replying: plain typing rewrites no reply text');
  assert.match(await page.locator('#reply-mention').textContent(), /^Also @ /);
  assert.deepEqual(errors, []);
});

test('a long room opens at its newest message on a phone, and older history filling in is not counted as new', { timeout: 90000 }, async t => {
  // R68-1: at 390px the open landed 125-196 px above the bottom and the
  // history fill that followed showed "N new messages" for old messages.
  const directory = mkdtempSync(join(tmpdir(), 'project-room-long-open-'));
  const store = new RoomStore(join(directory, 'room.sqlite'));
  const createdAt = Date.now() - 3_600_000;
  const messages = [];
  for (let index = 1; index <= 600; index++) {
    messages.push(event({ roomId: 'commons', actorId: 'owner', type: T.MESSAGE_POSTED, at: new Date(createdAt + index * 1000).toISOString(),
      data: { messageId: `long-open-${String(index).padStart(3, '0')}`, body: index % 50 === 0 ? `long ${index} `.repeat(400) : `short ${index}` } }));
  }
  store.initialize([...initialRoom('commons', 'owner'), ...messages]);
  const ownerKey = store.issueAccessKey('commons', 'owner');
  const server = createRoomServer({ store, streamInterval: 50 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
    const mobile = viewport.width < 500;
    const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    // Chrome above the timeline that mounts after the first paint (the room
    // assistant panel does this on prod) shrinks the list under the reader.
    await page.addInitScript(() => new MutationObserver((_, observer) => {
      const list = document.querySelector('#message-list');
      if (!list?.children.length) return;
      observer.disconnect();
      const late = document.createElement('div'); late.style.height = '220px'; late.dataset.lateChrome = '';
      list.before(late);
    }).observe(document, { childList: true, subtree: true }));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await signInFixture(page, ownerKey);
    await page.locator('[data-message-record-id="long-open-600"] .message-body').waitFor({ state: 'attached' });
    await page.waitForFunction(() => document.querySelectorAll('#message-list > li').length > 150);
    await page.waitForTimeout(1500);
    const seen = await page.evaluate(() => {
      const list = document.querySelector('#message-list'), pill = document.querySelector('#new-messages-button');
      const last = document.querySelector('[data-message-record-id="long-open-600"]').getBoundingClientRect(), box = list.getBoundingClientRect();
      return { gap: Math.round(list.scrollHeight - list.scrollTop - list.clientHeight), lastOnScreen: last.bottom <= Math.min(box.bottom, innerHeight) + 1 && last.top < innerHeight, pill: pill.hidden ? null : pill.textContent };
    });
    assert.deepEqual(seen, { gap: 0, lastOnScreen: true, pill: null }, `${viewport.width}px open lands on the newest message with no new-messages pill`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

test('the open-at-newest pin never marks messages read by itself; a reader scroll still does', { timeout: 90000 }, async t => {
  // #2815 CI (calm-return mobile): after a layout change took the list off the
  // bottom, the pin's ResizeObserver put it back and a read-horizon advance
  // that was already pending then posted with no reader scroll. Without the
  // pin that advance finds the list off the bottom and does nothing.
  const directory = mkdtempSync(join(tmpdir(), 'project-room-pin-read-'));
  const store = new RoomStore(join(directory, 'room.sqlite'));
  const createdAt = Date.now() - 3_600_000;
  const messages = [];
  for (let index = 1; index <= 120; index++) {
    messages.push(event({ roomId: 'commons', actorId: 'owner', type: T.MESSAGE_POSTED, at: new Date(createdAt + index * 1000).toISOString(),
      data: { messageId: `pin-read-${String(index).padStart(3, '0')}`, body: `short ${index}` } }));
  }
  store.initialize([...initialRoom('commons', 'owner'), ...messages]);
  const ownerKey = store.issueAccessKey('commons', 'owner');
  const server = createRoomServer({ store, streamInterval: 50 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
    const mobile = viewport.width < 500, latest = `pin-read-${viewport.width}`;
    // A newest message the owner has not read yet in this pass.
    store.command(ownerKey, 'commons', { id: latest, type: 'message.posted', data: { messageId: latest, body: `newest at ${viewport.width}` } });
    const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const reads = []; page.on('request', request => { if (request.method() !== 'GET' && request.url().endsWith('/read-horizon')) reads.push(request.url()); });
    await page.clock.install(); // the read-horizon debounce only runs when the test says so
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await signInFixture(page, ownerKey);
    await page.locator(`[data-message-record-id="${latest}"] .message-body`).waitFor({ state: 'attached' });
    await page.waitForTimeout(500);
    // Chrome mounts above the timeline and shrinks it by 220px.
    await page.evaluate(() => {
      const late = document.createElement('div'); late.style.height = '220px'; late.dataset.lateChrome = '';
      document.querySelector('#message-list').before(late);
    });
    await page.waitForTimeout(300);
    await page.clock.fastForward(3000);
    await page.waitForTimeout(300);
    assert.deepEqual(reads, [], `${viewport.width}px: the pin keeping the newest message in view posts no read horizon`);
    // A reader who scrolls up and back down to the newest message marks it read.
    const listBox = await page.locator('#message-list').boundingBox();
    await page.mouse.move(listBox.x + listBox.width / 2, listBox.y + Math.min(listBox.height, viewport.height - listBox.y) / 2);
    await page.mouse.wheel(0, -100000);
    await page.waitForTimeout(100);
    await page.mouse.wheel(0, 100000);
    await page.waitForTimeout(100);
    await page.clock.fastForward(3000);
    for (let waited = 0; !reads.length && waited < 3000; waited += 100) await page.waitForTimeout(100);
    assert.equal(reads.length, 1, `${viewport.width}px: scrolling back to the newest message marks it read`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

test('Mark unread survives a reload: layout scrolls never mark read; a reader wheel still does', { timeout: 90000 }, async t => {
  // r115 on prod 24ddb13d: after Mark unread and a reload, the app's own layout
  // scrolls (the list growing as chrome settles) reached the list's scroll
  // handler "at bottom" and posted /read-horizon 2.5-2.9 s after load with no
  // wheel, touch, pointer or key input, wiping the unread mark.
  const directory = mkdtempSync(join(tmpdir(), 'project-room-unread-reload-'));
  const store = new RoomStore(join(directory, 'room.sqlite'));
  const createdAt = Date.now() - 3_600_000;
  const messages = [];
  for (let index = 1; index <= 40; index++) {
    messages.push(event({ roomId: 'commons', actorId: 'owner', type: T.MESSAGE_POSTED, at: new Date(createdAt + index * 1000).toISOString(),
      data: { messageId: `unread-reload-${String(index).padStart(3, '0')}`, body: `short ${index}` } }));
  }
  store.initialize([...initialRoom('commons', 'owner'), ...messages]);
  const ownerKey = store.issueAccessKey('commons', 'owner');
  const server = createRoomServer({ store, streamInterval: 50 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
    const mobile = viewport.width < 500, latest = `unread-reload-${viewport.width}`;
    store.command(ownerKey, 'commons', { id: latest, type: 'message.posted', data: { messageId: latest, body: `newest at ${viewport.width}` } });
    const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const reads = []; page.on('request', request => { if (request.method() !== 'GET' && request.url().endsWith('/read-horizon')) reads.push(request.url()); });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await signInFixture(page, ownerKey);
    const newest = page.locator(`[data-message-record-id="${latest}"]`);
    await newest.locator('.message-body').waitFor({ state: 'attached' });
    await newest.locator('.message-more > summary').click();
    await newest.locator('[data-message-action="mark-unread"]').click();
    await newest.locator('.chat-divider.unread').waitFor({ state: 'attached' });
    for (let waited = 0; !reads.length && waited < 3000; waited += 100) await page.waitForTimeout(100);
    await page.waitForTimeout(3000);
    assert.equal(reads.length, 1, `${viewport.width}px: Mark unread writes the read horizon once and nothing undoes it without a reader scroll`);
    const readUrl = reads[0], lastRead = () => page.evaluate(async url => (await (await fetch(url)).json()).lastReadMessageId, readUrl);
    reads.length = 0;
    await page.reload();
    await newest.locator('.message-body').waitFor({ state: 'attached' });
    // The app's own layout settles: chrome mounts above the list, then goes
    // away, and the list's scroll position moves with no reader input.
    await page.evaluate(() => {
      const late = document.createElement('div'); late.style.height = '220px'; late.dataset.lateChrome = '';
      document.querySelector('#message-list').before(late);
    });
    await page.waitForTimeout(300);
    await page.evaluate(() => document.querySelector('[data-late-chrome]')?.remove());
    await page.waitForTimeout(4000);
    assert.deepEqual(reads, [], `${viewport.width}px: no read horizon is posted after a reload with no reader input`);
    assert.notEqual(await lastRead(), latest, `${viewport.width}px: the message is still unread`);
    // A reader who scrolls up and back down to the newest message marks it read.
    const box = await page.locator('#message-list').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height, viewport.height - box.y) / 2);
    await page.mouse.wheel(0, -2000);
    await page.waitForTimeout(200);
    await page.mouse.wheel(0, 6000);
    for (let waited = 0; !reads.length && waited < 5000; waited += 100) await page.waitForTimeout(100);
    assert.equal(reads.length, 1, `${viewport.width}px: a reader scroll back to the newest message marks it read`);
    for (let waited = 0; await lastRead() !== latest && waited < 3000; waited += 200) await page.waitForTimeout(200);
    assert.equal(await lastRead(), latest);
    assert.deepEqual(errors, []);
    await context.close();
  }
});
