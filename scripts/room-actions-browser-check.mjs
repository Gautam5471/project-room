import { clickChrome, ensureSidebarOpen, ensureSidebarClosed, openComposerOptions } from "./room-chrome.mjs";
// Simulated-human navigation checks. Disposable data; no outside services.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { signInFixture } from "./auth-signin.mjs";

async function setup(t, { mobile = false, role = "owner", expectedMessageWrites = 0 } = {}) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 50 });
  let browser;
  t.after(async () => {
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce" });
  const page = await context.newPage(), external = [], errors = [], writes = [];
  page.setDefaultTimeout(8000);
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin); await signInFixture(page, f.keys[role]); await page.locator("#main").waitFor({ state: "visible" });
  page.on("request", request => { if (request.method() !== "GET" && new URL(request.url()).pathname.startsWith("/api/rooms/")) writes.push(new URL(request.url()).pathname); });
  t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(external, []);
    // The attention lane syncs the read horizon (a write) on room entry by
    // design; it is not "creating anything" in the room-actions sense, so it is
    // excluded while every other non-GET room request still fails the check.
    const effects = writes.filter(path => !path.endsWith("/read-horizon") && !path.endsWith("/typing"));
    assert.equal(effects.filter(path => path.endsWith("/commands")).length, expectedMessageWrites);
    assert.deepEqual(effects.filter(path => !path.endsWith("/commands")), []); });
  const open = async () => { await clickChrome(page, "#room-actions-open"); await page.locator("#room-actions-query").waitFor(); };
  const action = id => page.locator(`[data-room-action="${id}"]`);
  const capture = async name => {
    mkdirSync("test-results/room-actions-20260908", { recursive: true });
    await page.screenshot({ path: `test-results/room-actions-20260908/${name}.png` });
  };
  return { ...f, page, origin, open, action, capture };
}

for (const mobile of [false, true]) test(`room actions ${mobile ? "mobile" : "desktop"}: quiet entry, draft preservation, no implicit writes`, { timeout: 30000 }, async t => {
  const f = await setup(t, { mobile }), p = f.page, input = p.locator("#message-input");
  await f.capture(mobile ? "mobile-room" : "desktop-room");
  await input.fill("Keep this unfinished thought. 🪷");
  await input.evaluate(node => node.setSelectionRange(5, 9, "backward"));
  if (mobile) await f.open(); else await input.press("Control+k");
  assert.equal(await p.locator("#room-actions-dialog").isVisible(), true);
  assert.equal(await f.action("write").textContent(), "Continue writing");
  assert.equal(await p.locator("#room-actions-query").evaluate(node => node === document.activeElement), true);
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await f.capture(mobile ? "mobile" : "desktop");
  await p.keyboard.press("Escape");
  assert.equal(await input.inputValue(), "Keep this unfinished thought. 🪷");
  if (!mobile) assert.deepEqual(await input.evaluate(node => [node === document.activeElement, node.selectionStart, node.selectionEnd, node.selectionDirection]), [true, 5, 9, "backward"]);
  await f.open(); await f.action("write").click();
  assert.equal(await input.evaluate(node => node === document.activeElement), true);
  assert.equal(await input.inputValue(), "Keep this unfinished thought. 🪷");
});

test("room actions filter by intent, support keyboard selection, empty state and focus wrapping", { timeout: 30000 }, async t => {
  const f = await setup(t), p = f.page; await f.open();
  await p.locator("#room-actions-query").fill("find work");
  assert.equal(await p.locator("[data-room-action]").count(), 1);
  await p.locator("#room-actions-query").press("Enter");
  assert.equal(await p.locator("#message-search").evaluate(node => node === document.activeElement), true);
  await f.open(); await p.locator("#room-actions-query").fill("not a real action");
  await p.locator("#room-actions-empty").waitFor(); await p.keyboard.press("Enter");
  assert.equal(await p.locator("#room-actions-dialog").isVisible(), true);
  await f.capture("no-match");
  await p.locator("#room-actions-query").fill(""); await p.keyboard.press("ArrowDown");
  assert.equal(await p.locator('[data-room-channel="general"]').evaluate(node => node === document.activeElement), true);
  await p.keyboard.press("ArrowDown");
  assert.equal(await p.locator("[data-room-task]").first().evaluate(node => node === document.activeElement), true);
  await p.keyboard.press("ArrowDown");
  assert.equal(await f.action("write").evaluate(node => node === document.activeElement), true);
  await p.keyboard.press("ArrowDown"); await p.keyboard.press("Enter");
  assert.equal(await p.locator("#message-search").evaluate(node => node === document.activeElement), true);
  await f.open();
  await p.locator("#room-actions-close").focus(); await p.keyboard.press("Shift+Tab");
  assert.equal(await p.locator("[data-room-action]").last().evaluate(node => node === document.activeElement), true);
  await p.keyboard.press("Tab");
  assert.equal(await p.locator("#room-actions-close").evaluate(node => node === document.activeElement), true);
});

test("room actions open existing work and catch-up flows; shortcuts do not interrupt another dialog", { timeout: 30000 }, async t => {
  const f = await setup(t), p = f.page;
  await f.open(); await f.action("catch-up").click();
  assert.equal(await p.locator("#updates-dialog").isVisible(), true);
  assert.equal(await p.locator("[data-update-filter=needs]").getAttribute("aria-selected"), "true");
  await p.locator("#updates-close").click();
  await p.locator("#updates-dialog").waitFor({ state: "hidden" });
  await f.open(); await f.action("new-work").click();
  await p.locator("#work-dialog").waitFor(); await p.locator("#work-title-input").fill("An unsaved idea");
  await p.keyboard.press("Control+k");
  assert.equal(await p.locator("#room-actions-dialog").isVisible(), false);
  assert.equal(await p.locator("#work-title-input").inputValue(), "An unsaved idea");
  await p.locator("#cancel-work-button").click();
  await f.open(); await f.action("people").click();
  assert.equal(await p.locator("#people-panel").evaluate(node => node.open), true);
  await f.open(); await f.action("how-invite").click();
  assert.equal(await p.locator("#share-link-dialog").isVisible(), true);
  await p.locator("#share-link-close").click();
  await f.open(); await f.action("how-agent").click();
  assert.equal(await p.locator("#people-panel").evaluate(node => node.open), true);
  assert.equal(await p.locator("#connect-agent-button").evaluate(node => node === document.activeElement), true);
});

test("room actions offer only the current member's available flows", { timeout: 30000 }, async t => {
  const f = await setup(t, { role: "guest" }); await f.open();
  for (const id of ["new-work", "agent"]) assert.equal(await f.action(id).count(), 0);
  assert.equal(await f.action("invite").count(), 1, "an in-room member can invite");
  for (const id of ["write", "search", "catch-up", "people", "results", "how-invite", "how-agent", "how-inbox"]) assert.equal(await f.action(id).count(), 1);
  await f.action("how-inbox").click();
  assert.match(await f.page.locator("#status").textContent(), /Sign in with Google or email to open your Inbox/);
  await f.capture("guest");
});

test("room actions recheck stale controls and clear the menu when room access ends", { timeout: 30000 }, async t => {
  const f = await setup(t), p = f.page; await f.open();
  // Hold the visible menu while the backing control changes, as during a refresh.
  await p.locator("#new-work-button").evaluate(node => { node.disabled = true; });
  await f.action("new-work").click();
  assert.equal(await p.locator("#work-dialog").isVisible(), false);
  assert.equal(await f.action("new-work").count(), 0);
  // Trigger the actual sign-out path while the dialog is modal.
  await p.locator("#signout-button").evaluate(node => node.click());
  await p.locator("#room-actions-dialog").waitFor({ state: "hidden" });
  assert.equal(await p.locator("#room-actions-list").textContent(), "");
  assert.equal(await p.locator("#room-actions-query").inputValue(), "");
  await p.keyboard.press("Control+k"); assert.equal(await p.locator("#room-actions-dialog").isVisible(), false);
});

test("room actions ignore composition and held Enter without changing drafts", { timeout: 30000 }, async t => {
  const f = await setup(t), p = f.page; await f.open();
  await p.locator("#room-actions-query").fill("new work");
  await p.locator("#room-actions-query").dispatchEvent("keydown", { key: "Enter", isComposing: true, bubbles: true });
  await p.locator("#room-actions-query").dispatchEvent("keydown", { key: "Enter", repeat: true, bubbles: true });
  assert.equal(await p.locator("#work-dialog").isVisible(), false);
  assert.equal(await p.locator("#room-actions-dialog").isVisible(), true);
  await p.keyboard.press("Control+k"); assert.equal(await p.locator("#room-actions-dialog").isVisible(), false);
});

test("room actions reach work, invitation, agent and instructions without creating anything", { timeout: 30000 }, async t => {
  const f = await setup(t), p = f.page;
  await f.open(); await f.action("results").click();
  assert.equal(await p.locator("#settings-dialog").isVisible(), true);
  assert.equal(await p.locator("#results-panel").evaluate(node => node.open), true);
  await p.locator("#settings-close").click();
  for (const [action, dialog, close] of [
    ["invite", "#share-link-dialog", "#share-link-close"],
    ["agent", "#agent-connect-dialog", "#agent-connect-close"],
    ["instructions", "#room-instructions-dialog", "#room-instructions-close"]
  ]) {
    await f.open(); await f.action(action).click(); await p.locator(dialog).waitFor();
    assert.equal(await p.locator("#room-actions-dialog").isVisible(), false);
    await p.locator(close).click();
  }
});

// R27-2: on a phone the people list lives in the sidebar drawer. Choosing a
// room action re-renders the menu, so by the time the click reaches the
// document's outside-click handler its target is detached, reads as "outside"
// and shuts the drawer that the action just opened. Focus then falls to <body>.
test("room actions on a phone: People and How to add an agent leave the drawer open with focus inside it", { timeout: 30000 }, async t => {
  const f = await setup(t, { mobile: true }), p = f.page;
  for (const [id, focused] of [["people", "#people-panel > summary"], ["how-agent", "#connect-agent-button"]]) {
    await f.open(); await f.action(id).click();
    await p.waitForTimeout(100);
    assert.equal(await p.locator("#main").evaluate(node => node.classList.contains("sidebar-open")), true, `${id}: the sidebar drawer stays open`);
    assert.equal(await p.locator("#people-panel").evaluate(node => node.open), true, `${id}: people panel open`);
    assert.equal(await p.locator(focused).isVisible(), true, `${id}: ${focused} is visible`);
    assert.equal(await p.locator(focused).evaluate(node => node === document.activeElement), true, `${id}: focus lands on ${focused}, not <body>`);
    await p.keyboard.press("Escape");
    await p.waitForFunction(() => !document.querySelector("#main").classList.contains("sidebar-open"));
  }
});

test("room actions fit a small touch viewport and keep the last action reachable", { timeout: 30000 }, async t => {
  const f = await setup(t, { mobile: true }), p = f.page;
  await p.setViewportSize({ width: 320, height: 568 });
  await f.open();
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await f.action("instructions").scrollIntoViewIfNeeded();
  const box = await f.action("instructions").boundingBox();
  assert.ok(box.y >= 0 && box.y + box.height <= 568 && box.width >= 44 && box.height >= 44);
  await f.capture("small-touch");
  await f.action("instructions").click(); await p.locator("#room-instructions-dialog").waitFor();
});

for (const mobile of [false, true]) test(`channel finder ${mobile ? "touch" : "keyboard"}: bounded destinations, scoped drafts and stale refusal`, { timeout: 45000 }, async t => {
  const f = await setup(t, { mobile, expectedMessageWrites: mobile ? 0 : 1 }), p = f.page;
  for (const [id, name] of [['design', 'design'], ['notes', 'design-notes'], ['redesign', 'redesign'], ...Array.from({ length: 26 }, (_, i) => [`design-${i}`, `design-${String(i).padStart(2, '0')}`])]) {
    f.store.command(f.keys.owner, 'commons', { id: crypto.randomUUID(), type: 'channel.created', data: { channelId: id, name } });
  }
  f.store.command(f.keys.owner, 'commons', { id: crypto.randomUUID(), type: 'message.posted', data: { messageId: 'finder-thread-root', body: 'General discussion', channelId: 'general' } });
  f.store.command(f.keys.owner, 'commons', { id: crypto.randomUUID(), type: 'message.posted', data: { messageId: 'finder-thread-reply', body: 'Thread reply', replyToId: 'finder-thread-root' } });
  await p.locator('#channel-list [data-channel="design-25"]').waitFor({ state: 'attached' });
  const input = p.locator('#message-input'), query = p.locator('#room-actions-query');
  await input.fill('Unsent general thought'); await input.focus();
  await input.evaluate(node => node.setSelectionRange(2, 7, 'backward'));
  const began = performance.now(); if (mobile) await f.open(); else await input.press("Control+k");
  assert.equal(await p.locator('[data-room-channel]').count(), 20);
  assert.match(await p.locator('#room-actions-count').textContent(), /Showing 20 of 30 channels/);
  assert.match(await p.locator('[data-room-channel="general"]').textContent(), /Current/);
  await query.fill('# design');
  assert.equal(await p.locator('[data-room-action]').count(), 0);
  assert.equal(await p.locator('[data-room-channel]').first().getAttribute('data-room-channel'), 'design');
  assert.match(await p.locator('#room-actions-count').textContent(), /Showing 20 of 29 channels/);
  t.diagnostic(`30-channel local fixture open+filter ${Math.round(performance.now() - began)}ms; browser orchestration included`);
  await query.fill('# no-channel'); await p.keyboard.press('Enter');
  assert.equal(await p.locator('#room-actions-dialog').isVisible(), true);
  await p.keyboard.press('Escape'); await p.locator('#room-actions-dialog').waitFor({ state: 'hidden' });
  assert.equal(await input.inputValue(), 'Unsent general thought');
  if (!mobile) assert.deepEqual(await input.evaluate(node => [node === document.activeElement, node.selectionStart, node.selectionEnd, node.selectionDirection]), [true, 2, 7, 'backward']);
  await f.open(); await query.fill('# design');
  await query.dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true });
  assert.equal(await p.locator('#conversation-title').textContent(), '# general');
  if (mobile) await p.locator('[data-room-channel="design"]').tap(); else await query.press('Enter');
  assert.equal(await p.locator('#conversation-title').textContent(), '# design');
  assert.equal(await p.locator('#conversation-title').evaluate(node => node === document.activeElement), true);
  assert.equal(await input.inputValue(), '');
  assert.equal(await p.locator('#main').evaluate(node => node.classList.contains('sidebar-open')), false);
  await input.fill('Unsent design thought'); await f.open(); await query.fill('# general'); await query.press('Enter');
  assert.equal(await input.inputValue(), 'Unsent general thought');
  await p.locator('[data-message-record-id="finder-thread-root"] .thread-link').click();
  await input.fill('Unsent thread thought'); await f.open(); await query.fill('# general'); await query.press('Enter');
  await p.locator('#thread-bar').waitFor({ state: 'hidden' });
  assert.equal(await input.inputValue(), 'Unsent general thought', 'same-channel finder selection leaves the thread and restores its channel draft');
  await p.locator('[data-message-record-id="finder-thread-root"] .thread-link').click();
  assert.equal(await input.inputValue(), 'Unsent thread thought', 'finder exit preserves the independent thread reply draft');
  await f.open(); await query.fill('# general'); await query.press('Enter');
  await f.open(); await query.fill('# design');
  f.store.command(f.keys.owner, 'commons', { id: crypto.randomUUID(), type: 'channel.renamed', data: { channelId: 'design', name: 'studio' } });
  await p.locator('#channel-list [data-channel="design"]').filter({ hasText: 'studio' }).waitFor({ state: 'attached' });
  await p.locator('[data-room-channel="design"]').click();
  assert.equal(await p.locator('#conversation-title').textContent(), '# studio');
  assert.equal(await input.inputValue(), 'Unsent design thought');
  await f.open(); await query.fill('# design-notes');
  f.store.command(f.keys.owner, 'commons', { id: crypto.randomUUID(), type: 'channel.archived', data: { channelId: 'notes' } });
  await p.locator('#channel-list [data-channel="notes"]').waitFor({ state: 'detached' });
  await p.locator('[data-room-channel="notes"]').click();
  assert.match(await p.locator('#room-actions-status').textContent(), /unavailable/i);
  assert.equal(await p.locator('#conversation-title').textContent(), '# studio');
  assert.equal(await input.inputValue(), 'Unsent design thought');
  await p.keyboard.press('Escape');
  if (!mobile) {
    let release, seen;
    const held = new Promise(resolve => { seen = resolve; });
    const released = new Promise(resolve => { release = resolve; });
    await p.route('**/api/rooms/commons/commands', async route => { seen(); await released; await route.continue(); });
    await input.fill('Deliberate pending send'); await p.locator('#message-form button[type="submit"]').click(); await held;
    await f.open(); await query.fill('# general'); await query.press('Enter');
    assert.match(await p.locator('#room-actions-status').textContent(), /send.*finish|sending/i);
    assert.equal(await p.locator('#conversation-title').textContent(), '# studio');
    release(); await p.locator('#message-list .message-body').filter({ hasText: 'Deliberate pending send' }).waitFor();
    await query.press('Enter');
    assert.equal(await p.locator('#conversation-title').textContent(), '# general');
    await p.unroute('**/api/rooms/commons/commands');
  }
  await f.open(); await query.fill('# design-');
  for (const theme of ['dark', 'light']) {
    await p.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const box = await p.locator('[data-room-channel]').first().boundingBox();
    assert.ok(box.height >= 44); assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const feedback = await p.locator('#room-actions-count').boundingBox();
    assert.ok(feedback.y >= 0 && feedback.y + feedback.height <= (mobile ? 844 : 1000), 'bounded-result feedback remains visible above the choices');
    await f.capture(`finder-${mobile ? 'mobile' : 'desktop'}-${theme}`);
  }
});

for (const mobile of [false, true]) test(`task finder ${mobile ? 'touch' : 'keyboard'}: typed destinations preserve their conversation origin`, { timeout: 45000 }, async t => {
  const f = await setup(t, { mobile, expectedMessageWrites: mobile ? 0 : 1 }), p = f.page;
  const send = (type, data) => f.store.command(f.keys.owner, 'commons', { id: crypto.randomUUID(), type, data });
  send('channel.created', { channelId: 'design', name: 'design' });
  send('channel.created', { channelId: 'archivable', name: 'archivable' });
  const pair = 'finder:shared';
  send('message.posted', { messageId: pair, channelId: 'design', body: 'Discussion with the same ID as its task.' });
  send('message.posted', { messageId: 'finder-origin-reply', replyToId: pair, body: 'Keep the thread context.' });
  const propose = (id, title) => send('work.proposed', { workItemId: id, title, definitionOfDone: 'Inspectable destination', accountableMemberId: 'owner', independentVerificationRequired: false, ownerDecisionRequired: false });
  propose(pair, 'Orbit <b>agenda</b>'); propose('finder:duplicate', 'Orbit <b>agenda</b>');
  for (let i = 0; i < 28; i++) propose(`finder-${i}`, `Orbit ${String(i).padStart(2, '0')} notes`);
  send('message.posted', { messageId: 'finder-canonical-proposal', channelId: 'general', workItemId: pair, packetId: 'finder-packet', basisRevision: 0, body: 'Canonical task proposal.' });
  propose('archivable-work', 'Archive target');
  await p.locator('#channel-list [data-channel="design"]').waitFor({ state: 'attached' });
  await f.open(); const query = p.locator('#room-actions-query'); await query.fill('> Orbit');
  assert.equal(await p.locator('[data-room-task]').count(), 20, 'task destinations are bounded');
  assert.equal(await p.locator('[data-room-channel], [data-room-action]').count(), 0, 'task prefix narrows the finder');
  assert.match(await p.locator('#room-actions-count').textContent(), /Showing 20 of 30 tasks/);
  assert.match(await p.locator('#room-actions-count').textContent(), /Loaded in this room/);
  await query.fill('> Orbit <b>agenda</b>');
  assert.equal(await p.locator('[data-room-task]').count(), 2);
  assert.equal(await p.locator('[data-room-task] b').count(), 0, 'titles are literal text');
  assert.match(await p.locator(`[data-room-task="${pair}"]`).textContent(), /finder:shared/);
  assert.match(await p.locator(`[data-room-task="${pair}"]`).textContent(), /#general/);
  await p.keyboard.press('Escape'); await p.locator('#room-actions-dialog').waitFor({ state: 'hidden' });
  await ensureSidebarOpen(p); await p.locator('#channel-list [data-channel="design"]').click(); await ensureSidebarClosed(p);
  await p.locator(`[data-message-id="${pair}"][data-message-action="reply"]`).click();
  await openComposerOptions(p); await p.locator('#request-reply').click();
  const input = p.locator('#message-input'); await p.locator('#message-to-select').selectOption('producer');
  await input.fill('Preserve this thread request.'); await input.focus();
  await input.evaluate(node => node.setSelectionRange(3, 11, 'backward'));
  if (mobile) { await ensureSidebarOpen(p); await p.keyboard.press('Control+k'); } else await input.press('Control+k');
  await query.fill('> Orbit <b>agenda</b>');
  await p.locator(`[data-room-task="${pair}"]`).click();
  const card = p.locator(`[data-work-record-id="${pair}"]`), back = p.locator('#work-navigation-return');
  await card.waitFor(); assert.equal(await card.locator('.work-details').evaluate(node => node.open), true);
  assert.equal(await card.evaluate(node => node === document.activeElement), true);
  assert.equal(new URL(p.url()).hash, `#pr-record/work/${encodeURIComponent(pair)}`);
  assert.equal(await p.locator('#conversation-title').textContent(), '# general');
  assert.equal(await p.locator('#thread-bar').isVisible(), false);
  assert.equal(await p.locator('#main').evaluate(node => node.classList.contains('sidebar-open')), false);
  assert.equal(await p.locator('#sidebar-toggle').getAttribute('aria-expanded'), 'false');
  const inspectedHistory = await p.evaluate(() => history.length);
  await card.press('Control+k'); await query.fill('> Orbit <b>agenda</b>');
  await p.locator(`[data-room-task="${pair}"]`).click();
  assert.equal(await p.evaluate(() => history.length), inspectedHistory, 'reopening the inspected task does not add history');
  await back.click(); await p.locator('#thread-bar').waitFor({ state: 'visible' });
  await p.waitForFunction(id => document.activeElement?.id === id, mobile ? 'conversation-title' : 'message-input');
  assert.equal(await p.locator('#conversation-title').textContent(), '# design');
  assert.equal(await input.inputValue(), 'Preserve this thread request.');
  assert.equal(await p.locator('#message-to-select').inputValue(), 'producer');
  assert.equal(await p.locator('#request-mode-label').textContent(), 'Request a reply');
  assert.deepEqual(await input.evaluate(node => [node.selectionStart, node.selectionEnd, node.selectionDirection]), [3, 11, 'backward']);
  await input.press('Control+k'); await query.fill('> Archive target');
  const beforeUrl = p.url(), beforeHistory = await p.evaluate(() => history.length);
  const moved = send('message.posted', { messageId: 'finder-archive-proposal', channelId: 'archivable', workItemId: 'archivable-work', packetId: 'finder-archive-packet', basisRevision: 0, body: 'Proposal moves the loaded destination to an archivable source.' });
  await p.waitForFunction(seq => document.querySelector('#event-count').textContent === String(seq), moved.sequence);
  send('channel.archived', { channelId: 'archivable' });
  await p.locator('#channel-list [data-channel="archivable"]').waitFor({ state: 'detached' });
  await p.locator('[data-room-task="archivable-work"]').click();
  assert.match(await p.locator('#room-actions-status').textContent(), /unavailable/i);
  assert.equal(p.url(), beforeUrl); assert.equal(await p.evaluate(() => history.length), beforeHistory);
  assert.equal(await input.inputValue(), 'Preserve this thread request.');
  await p.keyboard.press('Escape'); await p.locator('#room-actions-dialog').waitFor({ state: 'hidden' });
  if (!mobile) {
    await p.locator('#request-exit').click();
    let release, seen; const held = new Promise(resolve => { seen = resolve; }), released = new Promise(resolve => { release = resolve; });
    await p.route('**/api/rooms/commons/commands', async route => { seen(); await released; await route.continue(); });
    await input.fill('Deliberate task-finder busy probe'); await p.locator('#message-form button[type="submit"]').click(); await held;
    await f.open(); await query.fill('> Orbit <b>agenda</b>');
    const busyUrl = p.url(), busyHistory = await p.evaluate(() => history.length);
    await p.locator(`[data-room-task="${pair}"]`).click();
    assert.match(await p.locator('#room-actions-status').textContent(), /send.*finish/);
    assert.equal(p.url(), busyUrl); assert.equal(await p.evaluate(() => history.length), busyHistory);
    release(); await p.locator('#message-list .message-body').filter({ hasText: 'Deliberate task-finder busy probe' }).waitFor();
    await p.locator(`[data-room-task="${pair}"]`).click(); await card.waitFor();
    assert.equal(new URL(p.url()).hash, `#pr-record/work/${encodeURIComponent(pair)}`);
    await p.unroute('**/api/rooms/commons/commands');
  }
  if (await p.locator('#room-actions-dialog').isVisible()) await p.keyboard.press('Escape');
  await f.open(); await query.fill('> Orbit');
  for (const theme of ['dark', 'light']) {
    await p.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    assert.ok((await p.locator('[data-room-task]').first().boundingBox()).height >= 44);
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await f.capture(`task-finder-${mobile ? 'mobile' : 'desktop'}-${theme}`);
  }
});
