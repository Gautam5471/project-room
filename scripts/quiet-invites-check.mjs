import { clickChrome } from "./room-chrome.mjs";
// Synthetic UI regressions; no human-participant findings are inferred.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { signInFixture } from "./auth-signin.mjs";

for (const touch of [false, true]) {
  test(`quiet invitations ${touch ? 'touch' : 'desktop'}: disclosure, truthful limits, late-list ordering and retry`, { timeout: 60000 }, async t => {
    const fixture = createAcceptanceFixture();
    const server = createRoomServer({ store: fixture.store, streamInterval: 60 });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const oldList = Promise.withResolvers(), releaseList = Promise.withResolvers(), listDelivered = Promise.withResolvers();
    let browser;
    t.after(async () => {
      releaseList.resolve(); await browser?.close();
      server.closeStreams(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true });
    });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: touch ? { width: 390, height: 844 } : { width: 1360, height: 900 }, hasTouch: touch, isMobile: touch, reducedMotion: 'reduce' });
    await context.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: async value => { window.testClipboard = value; } } }));
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await signInFixture(page, fixture.keys.owner);
    await page.locator('#main').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#connection-status').textContent === 'Connected');
    assert.equal(await page.locator('#connection-details').evaluate(el => el.open), false);
    await page.locator('#session-menu-button').click();
    await page.locator('#connection-details > summary').click();
    assert.match(await page.locator('#connection-explanation').textContent(), /no peer read or processing receipt/);
    await page.locator('#connection-details > summary').click();
    await page.keyboard.press('Escape');

    let firstGet = true, loseCreate = true;
    const creates = [];
    await page.route('**/api/rooms/commons/share-links', async route => {
      if (route.request().method() === 'POST') {
        creates.push(route.request().postDataJSON());
        if (loseCreate) { loseCreate = false; await route.fetch(); await route.abort('failed'); }
        else await route.continue();
      } else if (firstGet) {
        firstGet = false;
        const response = await route.fetch(); oldList.resolve(); await releaseList.promise;
        await route.fulfill({ response }); listDelivered.resolve();
      } else await route.continue();
    });
    await clickChrome(page, "#invite-people-button"); await oldList.promise;
    assert.equal(await page.locator('#share-settings').evaluate(el => el.open), false);
    assert.equal(await page.locator('#share-management').evaluate(el => el.open), false);
    assert.equal(await page.locator('#share-settings-summary').textContent(), '24 hours · 10 guests');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'share-link-create');
    mkdirSync('test-results', { recursive: true });
    await page.screenshot({ path: `test-results/quiet-invite-${touch ? 'touch' : 'desktop'}-start.png` });
    await page.locator('#share-settings > summary').click();
    await page.locator('#share-link-limit').fill('0');
    await page.locator('#share-settings > summary').click();
    await page.locator('#share-link-create').click();
    assert.equal(await page.locator('#share-settings').evaluate(el => el.open), true, 'invalid hidden field is revealed');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'share-link-limit');
    assert.equal(creates.length, 0);
    await page.locator('#share-link-limit').fill('3');
    await page.locator('#share-link-expiry').selectOption('1');
    assert.equal(await page.locator('#share-settings-summary').textContent(), '1 hour · 3 guests');
    await page.locator('#share-settings > summary').click();
    await page.locator('#share-link-create').click();
    await page.waitForFunction(() => document.querySelector('#share-link-status').textContent.includes('could not confirm the result'));
    assert.equal(await page.locator('#share-link-limit').isDisabled(), false);
    // Opening limits alone must not create a different retry request.
    await page.locator('#share-settings > summary').click(); await page.locator('#share-settings > summary').click();
    await page.locator('#share-link-create').click();
    await page.locator('#share-link-result').waitFor({ state: 'visible' });
    assert.deepEqual(creates[1], creates[0]);
    assert.equal(creates[0].maxJoins, 3);
    const invitation = await page.locator('#share-link-url').inputValue();
    const linkId = await page.locator('#share-link-url').getAttribute('data-link-id');
    await page.locator('#share-link-copy').click();
    assert.equal(await page.evaluate(() => window.testClipboard), invitation);
    await page.waitForFunction(() => document.querySelector('#share-link-status').textContent === 'Link copied.');
    releaseList.resolve(); await listDelivered.promise;
    // Allow the fulfilled old response to settle before checking the rendered state.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('#share-link-status').textContent(), 'Link copied.');
    assert.equal(await page.locator('#share-link-form').isVisible(), false);
    await page.locator('#share-management > summary').click();
    const row = page.locator(`#share-link-list li[data-link-id="${linkId}"]`);
    await row.waitFor();
    assert.match(await row.textContent(), /Guest · 0\/3 joined/, "invitation shows its access role and exact occupancy");
    await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('Synthetic unavailable clipboard'); }; });
    await page.locator('#share-link-copy').click();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'share-link-url');
    assert.deepEqual(await page.locator('#share-link-url').evaluate(el => [el.selectionStart, el.selectionEnd]), [0, invitation.length]);
    await page.screenshot({ path: `test-results/quiet-invite-${touch ? 'touch' : 'desktop'}-copy.png`, mask: [page.locator('#share-link-url')] });
    await row.getByRole('button', { name: /^Cancel link/ }).click();
    await page.waitForFunction(() => document.querySelector('#share-management-status').textContent.startsWith('Link cancelled.'));
    await page.waitForFunction(() => document.activeElement.id === 'share-management-summary');
    assert.equal(await page.locator('#share-link-result').isVisible(), false);
    assert.equal(await page.locator('#share-link-url').inputValue(), '');
    await page.locator('#share-link-close').click();
    await clickChrome(page, "#invite-people-button");
    assert.equal(await page.locator('#share-settings-summary').textContent(), '1 hour · 3 guests', 'retained choices have an accurate summary');
    assert.equal(await page.locator('#share-settings').evaluate(el => el.open), false);
    assert.equal(await page.locator('#share-management').evaluate(el => el.open), false);
    await page.locator('#share-link-close').click();
    await page.unroute('**/api/rooms/commons/share-links');

    const guest = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })).newPage();
    guest.setDefaultTimeout(10000);
    await guest.goto(`${origin}/#join/${fixture.links.valid}`);
    await guest.locator('#join-link-form').waitFor({ state: 'visible' });
    assert.equal(await guest.locator('#identity-label').textContent(), 'Room not open');
    assert.equal(await guest.locator('#connection-status').textContent(), 'Not connected · invitation preview');
    assert.equal(await guest.locator('#join-switch-warning').isVisible(), false);
    assert.equal(await guest.locator('#join-access-details').evaluate(el => el.open), false);
    assert.match(await guest.locator('#join-link-form').textContent(), /8 hours/);
    await guest.screenshot({ path: `test-results/quiet-invite-${touch ? 'touch' : 'desktop'}-join.png` });
    await guest.locator('#join-access-details > summary').click();
    assert.match(await guest.locator('#join-link-permissions').textContent(), /No membership administration or work approvals/);
    assert.match(await guest.locator('#join-link-expiry').textContent(), /Invitation expires/);
    await guest.locator('#join-link-close').click();
    // HTMLDialogElement.close queues its close event; wait for the handler,
    // not merely the click dispatch, before asserting the resulting state.
    await guest.waitForFunction(() => document.querySelector('#connection-explanation').textContent === 'Not connected · open an invitation link to join');
    assert.equal(await guest.locator('#connection-explanation').textContent(), 'Not connected · open an invitation link to join');

    await page.locator('#message-input').fill('Keep this room draft');
    await page.evaluate(token => { location.hash = '#join/' + token; }, fixture.links.valid);
    await page.locator('#join-link-form').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#join-switch-warning').isVisible(), false, 'same-room invitation does not warn about an identity switch');
    await page.locator('#join-link-name').fill('Ignored for existing membership');
    await page.locator('#join-link-submit').click();
    await page.locator('#join-link-dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#message-input').inputValue(), 'Keep this room draft');
    assert.equal(await page.locator('#identity-label').textContent(), 'Room owner');
    assert.deepEqual(errors, []);
  });
}

test('the Invite dialog still opens when the creator-only Access control is missing from the page', { timeout: 40000 }, async t => {
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await signInFixture(page, fixture.keys.owner);
  await page.locator('#main').waitFor({ state: 'visible' });
  await page.evaluate(() => document.querySelector('#share-link-access-label').remove());
  await clickChrome(page, '#invite-people-button');
  await page.locator('#share-link-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#share-link-create').evaluate(node => node === document.activeElement), true, 'focus lands on Create');
  assert.deepEqual(errors, [], 'opening the dialog throws nothing');
});

test('two submits while a link is being created make one link request', { timeout: 40000 }, async t => {
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const creates = [], release = Promise.withResolvers();
  t.after(() => release.resolve());
  await page.route('**/api/rooms/commons/share-links', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    creates.push(route.request().postDataJSON());
    await release.promise; await route.continue();
  });
  await page.goto(origin);
  await signInFixture(page, fixture.keys.owner);
  await page.locator('#main').waitFor({ state: 'visible' });
  await clickChrome(page, '#invite-people-button');
  await page.locator('#share-link-dialog').waitFor({ state: 'visible' });
  // A native click cannot do this (the button is disabled), but a script or an
  // extension can submit the form again while the first request is in flight.
  await page.evaluate(() => { const form = document.querySelector('#share-link-form'); form.requestSubmit(); form.requestSubmit(); });
  await page.waitForTimeout(300);
  release.resolve();
  await page.locator('#share-link-result').waitFor({ state: 'visible' });
  await page.waitForTimeout(300);
  assert.equal(creates.length, 1, 'one request for two submits');
  assert.deepEqual(errors, []);
});
