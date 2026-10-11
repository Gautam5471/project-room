import { openComposerOptions } from "./room-chrome.mjs";
import { ensureSidebarClosed } from "./room-chrome.mjs";
import { clickChrome } from "./room-chrome.mjs";
// Agent-operated usability regression, not evidence from human participants.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { RoomStore } from '../server/store.mjs';
import { createRoomServer } from '../server/http.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { EVENT_TYPES as T } from '../src/events.js';
import { signInFixture } from "./auth-signin.mjs";

// UI calming #2 moved "Make this work" into the per-message "⋯" overflow menu;
// open it first, exactly as a member does.
async function openMessageMenu(message) {
  const menu = message.locator('details.message-more');
  if (!(await menu.evaluate(node => node.open))) await menu.locator('summary').click();
  await message.evaluate(node => node.classList.add('message-menu-open'));
}

for (const touch of [false, true]) {
  test(`first use ${touch ? 'touch' : 'desktop'}: guest suggestion becomes accountable work`, { timeout: 60000 }, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'room-first-use-'));
    const store = new RoomStore(join(directory, 'room.sqlite'));
    store.initialize(initialRoom());
    const ownerKey = store.issueAccessKey('commons', 'owner');
    const server = createRoomServer({ store, streamInterval: 50 });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    let browser;
    t.after(async () => {
      await browser?.close(); server.closeStreams(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve)); store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    browser = await chromium.launch({ headless: true });
    const settings = { viewport: touch ? { width: 390, height: 844 } : { width: 1360, height: 900 }, hasTouch: touch, isMobile: touch, reducedMotion: 'reduce' };
    const owner = await (await browser.newContext(settings)).newPage();
    const guest = await (await browser.newContext(settings)).newPage();
    const errors = [];
    for (const page of [owner, guest]) { page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); }
    await owner.goto(origin);
    await owner.locator('#auth-panel').waitFor({ state: 'visible' });
    assert.equal(await owner.locator('#identity-label').textContent(), 'Not signed in');
    assert.equal(await owner.locator('#auth-error').textContent(), '', 'a normal signed-out visit is not an error');
    await signInFixture(owner, ownerKey);
    await owner.locator('#main').waitFor({ state: 'visible' });
    assert.equal(await owner.getByRole('button', { name: 'Got it', exact: true }).count(), 0, 'chat opens without a redundant tutorial dismissal');
    const firstMessage = owner.getByRole('button', { name: 'Write the first one', exact: true });
    await firstMessage.focus(); await owner.keyboard.press('Enter');
    assert.equal(await owner.evaluate(() => document.activeElement.id), 'message-input');
    await owner.locator('#message-input').fill('Keep this first draft');
    await owner.screenshot({ path: `test-results/first-minute-quiet-${touch ? 'touch' : 'desktop'}.png` });
    await clickChrome(owner, "#invite-people-button");
    await owner.locator('#share-link-create').click();
    await owner.locator('#share-link-result').waitFor({ state: 'visible' });
    const invitation = await owner.locator('#share-link-url').inputValue();
    await owner.locator('#share-link-close').click();
    assert.equal(await owner.locator('#message-input').inputValue(), 'Keep this first draft');
    await owner.locator('#message-input').fill('');
    await ensureSidebarClosed(owner);
    await guest.goto(invitation);
    await guest.locator('#join-link-name').fill('Maya');
    await guest.locator('#join-link-submit').click();
    await guest.locator('#main').waitFor({ state: 'visible' });
    assert.equal(await guest.locator('#identity-label').textContent(), 'Maya');
    assert.equal(await guest.locator('#new-work-button').isVisible(), false);
    await clickChrome(guest, '#topbar-settings');
    assert.match(await guest.locator('#room-results-list').textContent(), /No completed results yet/);
    await guest.locator('#settings-close').click();
    if (touch) assert.equal(await guest.locator('#message-input').evaluate(input => input.getBoundingClientRect().bottom <= innerHeight), true, 'new mobile guest can see the composer without scrolling');
    const suggestion = 'Prepare a short agenda for Friday';
    await guest.locator('#message-input').fill(suggestion);
    if (touch) {
      await guest.locator('#message-input').press('Enter');
      assert.equal(await guest.locator('#message-input').inputValue(), suggestion + '\n');
      await guest.getByRole('button', { name: 'Send', exact: true }).click();
    } else await guest.locator('#message-input').press('Enter');
    const message = owner.locator('[data-message-record-id]').filter({ hasText: suggestion });
    await message.waitFor();
    assert.equal(await message.locator('.message-meta strong').textContent(), 'Maya');
    await openMessageMenu(message);
    await message.locator('[data-message-action="work"]').click();
    assert.equal(await owner.locator('#work-title-input').inputValue(), suggestion);
    await owner.locator('#work-done-input').fill('Three agenda items with an owner for each.');
    await owner.locator('#work-options > summary').click();
    await owner.locator('#assignee-select').selectOption('owner');
    await owner.locator('#reviewer-unavailable').waitFor({ state: 'visible' });
    assert.equal(await owner.locator('#require-verification').isChecked(), true, 'review is never silently disabled');
    assert.equal(await owner.locator('#new-work-form').evaluate(form => form.checkValidity()), false);
    await owner.locator('#review-settings-button').click();
    assert.equal(await owner.evaluate(() => document.activeElement.id), 'require-verification');
    assert.equal(await owner.locator('#require-verification').isChecked(), true);
    mkdirSync('test-results', { recursive: true });
    // Capture only after touch Return/Send behavior has been exercised.
    await owner.screenshot({ path: `test-results/first-use-${touch ? 'touch' : 'desktop'}-review-choice.png`, fullPage: true });
    await owner.locator('#require-verification').uncheck();
    assert.equal(await owner.locator('#require-decision').isChecked(), true, 'owner approval remains required');
    assert.equal(await owner.locator('#reviewer-unavailable').isVisible(), false);
    await owner.getByRole('button', { name: 'Create', exact: true }).click();
    const card = owner.locator('[data-work-record-id]').filter({ hasText: suggestion });
    await card.waitFor();
    const item = Object.values(store.snapshot(ownerKey, 'commons').state.workItems)[0];
    assert.equal(item.independentVerificationRequired, false);
    assert.equal(item.ownerDecisionRequired, true);
    assert.equal(item.accountableMemberId, 'owner');
    assert.equal(item.sourceMessageId, await message.getAttribute('data-message-record-id'));
    for (const action of ['accept', 'start']) {
      await card.locator(`[data-action="${action}"]`).click();
      await owner.getByRole('button', { name: 'Save record', exact: true }).click();
      await owner.locator('#action-dialog').waitFor({ state: 'hidden' });
    }
    await guest.locator('[data-work-record-id]').filter({ hasText: suggestion }).waitFor();
    assert.equal(await guest.locator('[data-work-record-id] [data-action]').count(), 0);
    assert.equal(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.equal(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    const inputWidth = await guest.locator('#message-input').evaluate(node => node.getBoundingClientRect().width);
    const composerWidth = await guest.locator('.composer-row').evaluate(node => node.getBoundingClientRect().width);
    assert.ok(inputWidth > composerWidth / 2, 'guest message input retains the flexible column when New work is hidden');
    await guest.locator('#message-input').scrollIntoViewIfNeeded();
    await guest.screenshot({ path: `test-results/first-use-${touch ? 'touch' : 'desktop'}-guest.png`, fullPage: true });
    await owner.screenshot({ path: `test-results/first-use-${touch ? 'touch' : 'desktop'}-work.png`, fullPage: true });
    await owner.evaluate(() => document.documentElement.style.fontSize = '200%');
    assert.equal(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'large text reflows');
    await owner.evaluate(() => document.documentElement.style.fontSize = '100%');

    // Suggested titles stay editable and never survive cancelling a new-work form.
    await openMessageMenu(message);
    await message.locator('[data-message-action="work"]').click();
    await owner.locator('#work-title-input').fill('An edited suggestion');
    await owner.locator('#cancel-work-button').click();
    await openComposerOptions(owner); await owner.locator('#new-work-button').click();
    assert.equal(await owner.locator('#work-title-input').inputValue(), '');
    assert.equal(await owner.locator('#source-message-id').inputValue(), '');
    await owner.locator('#assignee-select').selectOption('owner');
    await owner.locator('#reviewer-unavailable').waitFor({ state: 'visible' });
    store.command(ownerKey, 'commons', { id: crypto.randomUUID(), type: T.MEMBER_ADDED,
      data: { memberId: 'review-helper', displayName: 'Rae', kind: 'human', permissions: ['verify', 'accept_work', 'complete_work'] } });
    await owner.locator('#reviewer-unavailable').waitFor({ state: 'hidden' });
    assert.equal(await owner.locator('#require-verification').isChecked(), true, 'available reviewer never changes the review requirement');
    await owner.locator('#assignee-select').selectOption('review-helper');
    assert.equal(await owner.locator('#verifier-select option[value="owner"]').count(), 1);
    assert.equal(await owner.locator('#reviewer-unavailable').isVisible(), false);
    await owner.locator('#cancel-work-button').click();
    store.command(ownerKey, 'commons', { id: crypto.randomUUID(), type: T.MESSAGE_POSTED,
      data: { messageId: 'emoji-title', body: 'a'.repeat(99) + '🚀 next' } });
    const emojiMessage = owner.locator('[data-message-record-id="emoji-title"]');
    await openMessageMenu(emojiMessage);
    await emojiMessage.locator('[data-message-action="work"]').click();
    assert.equal(await owner.locator('#work-title-input').inputValue(), 'a'.repeat(99), 'title limit does not split an emoji');
    await owner.locator('#cancel-work-button').click();

    // A second live member cannot take the guest's exact name. The label stays
    // the name they chose, because the duplicate never joins.
    assert.throws(() => store.command(ownerKey, 'commons', { id: crypto.randomUUID(), type: T.MEMBER_ADDED,
      data: { memberId: 'second-maya', displayName: 'Maya', kind: 'human', permissions: [] } }),
      error => error.code === 'display_name_unavailable');
    assert.equal(await guest.locator('#identity-label').textContent(), 'Maya');
    if (await guest.locator("#session-menu-button").isVisible()) await guest.locator("#session-menu-button").click(); await clickChrome(guest, "#signout-button");
    await guest.locator('#auth-panel').waitFor({ state: 'visible' });
    assert.equal(await guest.locator('#identity-label').getAttribute('title'), null, 'sign-out clears private attribution');
    assert.deepEqual(errors, []);
  });
}

// R28-1: a brand-new owner's top-bar chip must agree with Catch up. It used to
// read "2 updates" in an empty room (the owner's own room setup) and grow with
// every message the owner sent, while Catch up said "Already caught up".
for (const touch of [false, true]) {
  test(`first use ${touch ? 'touch' : 'desktop'}: your own room setup and messages are not updates to catch up on`, { timeout: 60000 }, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'room-first-use-chip-'));
    const store = new RoomStore(join(directory, 'room.sqlite'));
    store.initialize(initialRoom());
    const ownerKey = store.issueAccessKey('commons', 'owner');
    const server = createRoomServer({ store, streamInterval: 50 });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ headless: true });
    t.after(async () => {
      await browser?.close(); server.closeStreams(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve)); store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const settings = { viewport: touch ? { width: 390, height: 844 } : { width: 1360, height: 900 }, hasTouch: touch, isMobile: touch, reducedMotion: 'reduce' };
    const owner = await (await browser.newContext(settings)).newPage();
    owner.setDefaultTimeout(10000);
    const errors = []; owner.on('pageerror', e => errors.push(e.message));
    await owner.goto(origin);
    await signInFixture(owner, ownerKey);
    await owner.locator('#main').waitFor({ state: 'visible' });
    const chip = () => owner.locator('#catchup-count').textContent();
    assert.equal(await chip(), 'No new updates', 'the room you just created has nothing new for you');
    for (const body of ['First note to myself', 'Second note']) {
      await owner.locator('#message-input').fill(body);
      if (touch) await owner.getByRole('button', { name: 'Send', exact: true }).click();
      else await owner.locator('#message-input').press('Enter');
      await owner.locator('li.message', { hasText: body }).first().waitFor();
    }
    await owner.waitForTimeout(300); // let the post-send snapshot settle before reading the chip
    assert.equal(await chip(), 'No new updates', 'messages you sent are not updates for you');
    await clickChrome(owner, '#topbar-catchup');
    await owner.locator('#catchup-dialog').waitFor({ state: 'visible' });
    await owner.waitForFunction(() => /changes? since your marker/.test(document.querySelector('#summary-grid').textContent));
    assert.match(await owner.locator('#summary-grid').textContent(), /^0 changes since your marker/, 'the chip and Catch up agree');
    assert.deepEqual(errors, []);
  });
}
