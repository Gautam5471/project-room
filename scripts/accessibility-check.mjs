import AxeBuilder from "@axe-core/playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { emailContractFixture } from "./email-contract-fixture.mjs";
import { normalizeGraphEmail } from "../server/graph-email.mjs";
import { openMagicSignin } from "./signin-browser-journey.mjs";
import { openComposerOptions } from "./room-chrome.mjs";
import { clickChrome, clickWorkAction, enableHumanAdvanced } from "./room-chrome.mjs";
// Cross-session return-brief isolation and bounded accessibility regressions.
// Real browser + disposable loopback service; no external identity or agent runtime.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { signInFixture } from "./auth-signin.mjs";
import { openCatchUp } from "./room-chrome.mjs";
import { makeTestSigner } from "./helpers/signed-evidence.mjs";

test("stale return brief cannot cross a session; skip, local alerts, focus return, and AA primary controls hold", { timeout: 90000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-accessibility-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  const signEvidence = makeTestSigner(store);
  const send = (key, type, data) => {
    // External completions require signed evidence under the new contract.
    if (type === T.WORK_COMPLETED && data.evidenceUrl && !data.signedEvidence) {
      data = { ...data, signedEvidence: signEvidence() };
    }
    return store.command(key, "commons", { id: crypto.randomUUID(), type, data });
  };
  send(owner, T.MEMBER_ADDED, { memberId: "maya", displayName: "Maya", kind: "human", permissions: ["accept_work", "complete_work", "verify"] });
  const maya = store.issueAccessKey("commons", "maya");
  send(owner, T.WORK_PROPOSED, { workItemId: "owner-only", title: "Owner-only return item", definitionOfDone: "Owner accepts", accountableMemberId: "owner" });
  send(owner, T.WORK_PROPOSED, { workItemId: "maya-only", title: "Maya-only return item", definitionOfDone: "Maya accepts", accountableMemberId: "maya" });
  send(owner, T.WORK_PROPOSED, { workItemId: "producer-choice", title: "Explicit producer choice", definitionOfDone: "Reporter records producer separately", accountableMemberId: "owner", verifierMemberId: "maya", independentVerificationRequired: true, mode: "read" });
  send(owner, T.WORK_ACCEPTED, { workItemId: "producer-choice", expectedRevision: 0 });
  send(owner, T.WORK_PROPOSED, { workItemId: "producer-unknown-choice", title: "Explicit unknown producer choice", definitionOfDone: "Unknown is chosen, never inferred", accountableMemberId: "owner", verifierMemberId: "maya", independentVerificationRequired: true, mode: "read" });
  send(owner, T.WORK_ACCEPTED, { workItemId: "producer-unknown-choice", expectedRevision: 0 });
  send(owner, T.WORK_PROPOSED, { workItemId: "unknown-producer", title: "Unknown producer evidence", definitionOfDone: "Attribution stays explicit", accountableMemberId: "owner", verifierMemberId: "maya", independentVerificationRequired: true, ownerDecisionRequired: true, humanDecisionMakerId: "owner" });
  send(owner, T.WORK_ACCEPTED, { workItemId: "unknown-producer", expectedRevision: 0 });
  const completed = send(owner, T.WORK_COMPLETED, { workItemId: "unknown-producer", expectedRevision: 1, summary: "Completion was reported without producer attribution", evidenceUrl: "https://example.com/unknown-producer", evidenceVersion: "v1", nextAction: "Establish producer identity" });
  send(maya, T.VERIFICATION_RECORDED, { workItemId: "unknown-producer", expectedRevision: 2, result: "pass", completionEventId: completed.event.id, evidenceVersion: "v1", summary: "Evidence content checked" });
  send(owner, T.WORK_PROPOSED, { workItemId: "producer-conflict", title: "Verifier produced this result", definitionOfDone: "Independent producer is required", accountableMemberId: "owner", verifierMemberId: "maya", independentVerificationRequired: true, mode: "read" });
  send(owner, T.WORK_ACCEPTED, { workItemId: "producer-conflict", expectedRevision: 0 });
  send(owner, T.WORK_COMPLETED, { workItemId: "producer-conflict", expectedRevision: 1, producerId: "maya", summary: "Maya produced the result", evidenceUrl: "https://example.com/conflict", evidenceVersion: "conflict-v1", nextAction: "Find an independent verifier" });

  const server = createRoomServer({ store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser, page, releaseHeld;
  t.after(async () => {
    releaseHeld?.();
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" })).newPage();

  await page.goto(origin);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  const completionCommands = [];
  page.on("request", request => {
    if (request.method() !== "POST" || !request.url().endsWith("/api/rooms/commons/commands")) return;
    const command = request.postDataJSON();
    if (command.type === T.WORK_COMPLETED) completionCommands.push(command);
  });

  // Login skips to its heading, not the redundant signed-out connection strip.
  await page.locator("#skip-link").focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement.id), "auth-title");

  // Email delivery failure has one local announcement owner through the
  // actual email sign-in screen; this local fixture has no mail provider.
  await openMagicSignin(page);
  await page.locator('#auth-signin-ui [name=email]').fill("a11y@example.test");
  await page.locator('#auth-signin-ui button[type=submit]').click();
  const emailError = page.locator('#auth-signin-ui [data-signin-status]');
  await emailError.filter({ hasText: /not configured|isn.t configured/i }).waitFor();
  assert.equal(await emailError.getAttribute("role"), "alert");
  assert.equal(await page.locator("#status").textContent(), "", "no duplicate global authentication alert");
  assert.equal(await page.locator("#auth-panel").isVisible(), true);

  await signInFixture(page, owner);
  await page.locator("#main").waitFor({ state: "visible" });
  await enableHumanAdvanced(page);

  const receipt = page.locator('[data-work-record-id="unknown-producer"] .receipt');
  assert.match(await receipt.textContent(), /Completion reporter\s*Room owner/);
  assert.match(await receipt.textContent(), /Producer\s*Unknown — no producer was reported/);
  assert.match(await receipt.textContent(), /PASS reported by Maya \(maya\) · independence not confirmed/);
  assert.doesNotMatch(await receipt.textContent(), /INDEPENDENT PASS/);
  assert.equal(await page.locator('[data-work-record-id="unknown-producer"] [data-action="decide"]').count(), 0, "unconfirmed independence cannot expose approval");

  // Primary controls meet 4.5:1 in both ordinary and hover states.
  const sendButton = page.locator('#message-form button[type="submit"]');
  const contrast = async () => sendButton.evaluate(element => {
    const rgb = value => value.match(/[\d.]+/g).slice(0, 3).map(Number).map(channel => {
      const c = channel / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    const luminance = value => { const [r, g, b] = rgb(value); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const style = getComputedStyle(element), foreground = luminance(style.color), background = luminance(style.backgroundColor);
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  });
  assert.ok(await contrast() >= 4.5, "primary control contrast at rest");
  await sendButton.hover();
  assert.ok(await contrast() >= 4.5, "primary control contrast on hover");

  // Canceling the inline work form returns focus to the control that opened it.
  await openComposerOptions(page); await page.locator("#new-work-button").click();
  await page.locator("#cancel-work-button").click();
  await page.waitForFunction(() => document.activeElement.id === "composer-options-toggle");

  // Result sharing remains a visible primary action; Advanced exposes its protocol form.
  const producerCard = page.locator('[data-work-record-id="producer-choice"]');
  assert.equal(await producerCard.locator('.button.primary').isVisible(), true);
  assert.equal(await producerCard.locator('[data-action="complete"]').isVisible(), true);
  // Completion requires a deliberate producer choice, including an explicit unknown option.
  await clickWorkAction(page.locator('[data-work-record-id="producer-choice"]'), "complete", { keyboard: true });
  const producerSelect = page.locator('#action-form select[name="producerId"]');
  assert.equal(await producerSelect.inputValue(), "", "producer is never inferred from the completion reporter");
  assert.deepEqual(await producerSelect.locator("option").allTextContents(), [
    "Choose producer",
    "I produced this — Room owner (owner)",
    "Outside person or AI",
    "Unknown / not reported",
    "Maya (maya) · Person"
  ]);
  await producerSelect.selectOption("owner");
  await page.locator('#action-form textarea[name="summary"]').fill("Reporter submitted the result");
  await page.locator('#action-form input[name="evidenceUrl"]').fill("https://example.com/reporter-result");
  await page.locator('#action-form input[name="evidenceVersion"]').fill("producer-v1");
  await page.locator('#action-form textarea[name="nextAction"]').fill("Maya verifies independently");
  // Slice 5: the complete form requires signed evidence JSON; native validation blocks submission without it.
  await page.locator('#action-form textarea[name="signedEvidence"]').fill(JSON.stringify(signEvidence()));
  await page.locator('#action-form button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('[data-work-record-id="producer-choice"] .receipt')?.textContent.includes("Room owner"));
  const knownReceipt = await page.locator('[data-work-record-id="producer-choice"] .receipt').textContent();
  assert.equal(completionCommands.at(-1).data.producerId, "owner", "self-produced choice sends the authenticated member id");
  assert.match(knownReceipt, /Completion reporter\s*Room owner/);
  assert.match(knownReceipt, /Producer\s*Room owner/);

  await clickWorkAction(page.locator('[data-work-record-id="producer-unknown-choice"]'), "complete", { keyboard: true });
  await page.locator('#action-form select[name="producerId"]').selectOption("__unknown__");
  await page.locator('#action-form textarea[name="summary"]').fill("Reporter cannot establish who produced the result");
  await page.locator('#action-form input[name="evidenceUrl"]').fill("https://example.com/unknown-result");
  await page.locator('#action-form input[name="evidenceVersion"]').fill("unknown-v1");
  await page.locator('#action-form textarea[name="nextAction"]').fill("Establish provenance before verification");
  await page.locator('#action-form textarea[name="signedEvidence"]').fill(JSON.stringify(signEvidence()));
  await page.locator('#action-form button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('[data-work-record-id="producer-unknown-choice"] .receipt')?.textContent.includes("Unknown"));
  assert.equal(completionCommands.at(-1).data.producerId, null, "unknown is an explicit submitted choice");
  assert.match(await page.locator('[data-work-record-id="producer-unknown-choice"] .receipt').textContent(), /Producer\s*Unknown — no producer was reported/);

  // Start the held response immediately before the session switch so it cannot
  // expire under the client's request deadline on a slower CI runner.
  let capturedResolve;
  const captured = new Promise(resolve => { capturedResolve = resolve; });
  const held = new Promise(resolve => { releaseHeld = resolve; });
  // The return-brief panel now lives inside the Catch up dialog: opening the
  // dialog issues the fetch (openCatchUp calls loadReturnBrief directly and the
  // panel toggle fires once more), so more than one owner request can be in
  // flight. Hold all of the owner's brief requests; the next session's
  // requests must pass through untouched.
  let holdOwnerBrief = true, capturedOwnerBrief = false;
  await page.route("**/api/rooms/commons/return-brief**", async route => {
    if (!holdOwnerBrief) { await route.continue(); return; }
    const response = await route.fetch();
    if (!capturedOwnerBrief) { capturedOwnerBrief = true; capturedResolve(); }
    await held;
    await route.fulfill({ response });
  });
  if (await page.locator("#return-brief-panel").evaluate(node => node.open)
    && await page.locator("#catchup-dialog").evaluate(node => node.open)) {
    await page.locator("#rb-refresh-button").click();
  } else {
    await openCatchUp(page);
  }
  await captured;
  assert.equal(await page.locator("#return-brief-panel").getAttribute("aria-busy"), "true");
  assert.equal(await page.locator("#rb-ack-button").isDisabled(), true, "stale-horizon actions stay disabled during a fresh brief request");

  // End the owner session while its newly fetched brief is still in flight.
  // The modal dialog would otherwise intercept the sign-out click.
  await page.locator("#catchup-close").click();
  await page.locator("#catchup-dialog").waitFor({ state: "hidden" });
  // From here the next session's brief requests must pass through unheld.
  holdOwnerBrief = false;
  if (await page.locator("#session-menu-button").isVisible()) await page.locator("#session-menu-button").click(); await clickChrome(page, "#signout-button");
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  assert.equal(await page.locator('[data-signin-form="password"] [name="email"]').evaluate(node => node === document.activeElement), true, "access end moves focus to the first visible account entry");
  assert.match(await page.locator("#auth-error").textContent(), /Session ended; private drafts were cleared/);
  assert.equal(await page.locator("#status").textContent(), "", "sign-out has one local announcement owner");
  await signInFixture(page, maya);
  await page.locator("#main").waitFor({ state: "visible" });
  await enableHumanAdvanced(page);
  assert.equal(await page.locator('[data-work-record-id="producer-choice"] [data-action="verify"]').textContent(), "Record independent check", "known distinct producer exposes independent verification");
  assert.equal(await page.locator('[data-work-record-id="producer-unknown-choice"] [data-action="verify"]').textContent(), "Record evidence check", "unknown producer exposes only a non-independent evidence check");
  assert.equal(await page.locator('[data-work-record-id="producer-conflict"] [data-action="verify"]').count(), 0, "verifier-as-producer does not expose a misleading independent-check action");
  await clickWorkAction(page.locator('[data-work-record-id="producer-unknown-choice"]'), "verify", { keyboard: true });
  assert.equal(await page.locator("#action-title").textContent(), "Record an evidence check");
  assert.match(await page.locator("#action-fields").textContent(), /Producer identity is unknown.*cannot satisfy independent verification or unlock approval/s);
  await page.locator("#cancel-action").click();
  await page.waitForFunction(() => document.querySelector("#rb-attention-list")?.textContent.includes("Maya-only return item"));
  releaseHeld();
  await page.waitForTimeout(100);
  const attention = await page.locator("#rb-attention-list").textContent();
  assert.match(attention, /Maya-only return item/);
  assert.doesNotMatch(attention, /Owner-only return item/, "late owner response cannot overwrite Maya's brief");
  assert.match(await page.locator("#rb-history-list").textContent(), /work completed reporter Room owner.*producer unknown — not reported/i, "return history separates reporter from unknown producer");
});

async function seriousAxe(page, include) {
  const result = await new AxeBuilder({ page }).include(include).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const serious = result.violations.filter(item => item.impact === "serious" || item.impact === "critical");
  assert.deepEqual(serious.map(item => `${item.impact} ${item.id} ${item.nodes?.[0]?.target?.join(" ")}`), []);
}

test("board, settings, and join error have no serious axe findings; pages do not violate CSP", { timeout: 90000 }, async t => {
  const fixture = createAcceptanceFixture();
  const account = fixture.store.accountForMember("commons", "owner");
  const accountKey = fixture.store.issueAccountAccessKey(account.id);
  const slot = fixture.store.createAccountSessionSlot();
  const session = fixture.store.loginAccountSession(slot.token, accountKey, 0);
  const raw = emailContractFixture();
  raw.connection.accountId = account.id;
  const apply = request => fixture.store.email.apply(slot.token, request, session.sessionBinding);
  apply({ action: "connection.configure", requestId: crypto.randomUUID(), connectionId: raw.connection.id, expectedRevision: 0, profile: raw.connection });
  const parent = structuredClone(raw.message);
  parent.id = "AQMkCspParent="; parent.changeKey = "CQAAcsp-parent=";
  parent.internetMessageId = "<csp-parent@example.test>"; parent.conversationId = "AAQkCspConv=";
  parent.subject = "CSP thread"; parent.body.content = "Parent."; parent.internetMessageHeaders = [];
  const parentOptions = structuredClone(raw.options);
  parentOptions.attachmentObservation.messageId = parent.id;
  parentOptions.attachmentObservation.messageRevision = parent.changeKey;
  const importMessage = (message, options) => {
    const envelope = normalizeGraphEmail(raw.connection, message, options);
    const state = fixture.store.email.state(slot.token, raw.connection.id, message.parentFolderId, session.sessionBinding);
    apply({ action: "page.apply", requestId: crypto.randomUUID(), connectionId: raw.connection.id, connectionRevision: 1,
      folderId: message.parentFolderId, expectedRevision: state.folder?.revision ?? 0, expectedCursor: state.expectedCursor,
      cursor: crypto.randomUUID(), complete: true, reset: state.needsReset, observations: [{ kind: "message", expectedSourceRevision: 0, envelope }] });
    return envelope.sourceId;
  };
  const parentId = importMessage(parent, parentOptions);
  const child = structuredClone(raw.message);
  child.id = "AQMkCspChild="; child.changeKey = "CQAAcsp-child=";
  child.internetMessageId = "<csp-child@example.test>"; child.conversationId = "AAQkCspConv=";
  child.subject = "Re: CSP thread"; child.body.content = "Reply."; child.hasAttachments = false;
  child.internetMessageHeaders = [{ name: "In-Reply-To", value: "<csp-parent@example.test>" }];
  importMessage(child, { idType: "immutable", attachmentObservation: { messageId: child.id, messageRevision: child.changeKey, complete: true, items: [] } });
  const server = createRoomServer({ store: fixture.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); fixture.store.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  page.setDefaultTimeout(8000);
  const csp = [];
  const sessionProbes = [];
  page.on("console", message => { if (/violates the following Content Security Policy/i.test(message.text())) csp.push(message.text()); });
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/session") sessionProbes.push(request.method()); });
  await page.goto(origin + "/");
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "skip-link");
  assert.deepEqual(sessionProbes, []);
  await page.goto(origin + "/?account=1");
  await signInFixture(page, accountKey);
  await clickChrome(page, "#account-settings-button");
  await page.locator("#account-settings[open]").waitFor();
  await page.locator("[data-action='delete-account']").waitFor();
  await seriousAxe(page, "#account-settings");
  await page.goto(origin + "/?room=commons");
  await page.locator("#main").waitFor({ state: "visible" });
  await page.keyboard.press("Control+k");
  await page.locator("#room-actions-query").fill("board");
  await page.keyboard.press("Enter");
  await page.locator("#board-dialog").waitFor({ state: "visible" });
  await seriousAxe(page, "#board-dialog");
  await page.locator("#board-close").click();
  await clickChrome(page, "#nav-inbox");
  await page.locator(`[data-source-id="${parentId}"]`).click();
  await page.locator("#inbox-thread-toggle").click();
  await page.locator("#inbox-thread-list button").first().waitFor();
  await page.goto(origin + "/join?code=x");
  await page.locator("#join-error").waitFor({ state: "visible" });
  await seriousAxe(page, "main");
  assert.deepEqual(csp, []);
});

test("board dialog traps Tab in both directions (QA2-A11Y focus trap)", { timeout: 90000 }, async t => {
  const fixture = createAcceptanceFixture();
  const account = fixture.store.accountForMember("commons", "owner");
  const accountKey = fixture.store.issueAccountAccessKey(account.id);
  const server = createRoomServer({ store: fixture.store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); fixture.store.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await page.goto(origin + "/?account=1");
  await signInFixture(page, accountKey);
  await page.goto(origin + "/?room=commons");
  await page.locator("#main").waitFor({ state: "visible" });
  await page.keyboard.press("Control+k");
  await page.locator("#room-actions-query").fill("board");
  await page.keyboard.press("Enter");
  await page.locator("#board-dialog").waitFor({ state: "visible" });
  const focusEdge = async edge => page.evaluate(which => {
    const dialog = document.getElementById("board-dialog");
    const controls = [...dialog.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, a[href], [tabindex]:not([tabindex='-1'])")]
      .filter(element => element.getClientRects().length > 0);
    (which === "last" ? controls.at(-1) : controls[0]).focus();
  }, edge);
  await focusEdge("last");
  await page.keyboard.press("Tab");
  assert.ok(await page.evaluate(() => document.getElementById("board-dialog").contains(document.activeElement)),
    "Tab from the last control stays inside the board dialog");
  await focusEdge("first");
  await page.keyboard.press("Shift+Tab");
  assert.ok(await page.evaluate(() => document.getElementById("board-dialog").contains(document.activeElement)),
    "Shift+Tab from the first control stays inside the board dialog");
});

test("light-theme chat divider keeps 4.5:1 and coarse pointers get 16px/44px controls (QA2-A11Y D-fo-2, D-fo-3)", { timeout: 90000 }, async t => {
  const fixture = createAcceptanceFixture();
  const account = fixture.store.accountForMember("commons", "owner");
  const accountKey = fixture.store.issueAccountAccessKey(account.id);
  const server = createRoomServer({ store: fixture.store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); fixture.store.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await page.goto(origin + "/?account=1");
  await signInFixture(page, accountKey);
  await page.goto(origin + "/?room=commons");
  await page.locator("#main").waitFor({ state: "visible" });
  const dividerRatio = await page.evaluate(() => {
    document.documentElement.setAttribute("data-theme", "light");
    let el = document.querySelector(".chat-divider:not(.unread)");
    if (!el) {
      el = document.createElement("div");
      el.className = "chat-divider";
      el.textContent = "Today";
      (document.querySelector("#messages") ?? document.body).appendChild(el);
    }
    const channel = v => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const luminance = rgb => { const [r, g, b] = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(channel); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const style = getComputedStyle(el);
    const background = getComputedStyle(el.parentElement).backgroundColor;
    const [a, b] = [luminance(style.color), luminance(background)].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  });
  assert.ok(dividerRatio >= 4.5, `light-theme chat divider contrast ${dividerRatio.toFixed(2)}:1 meets 4.5:1`);
  const coarse = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })).newPage();
  await coarse.goto(origin + "/");
  await coarse.locator("#auth-panel").waitFor({ state: "visible" });
  const control = await coarse.evaluate(() => {
    const el = document.querySelector('#auth-signin-ui input[name="email"]') ?? document.querySelector("input");
    const style = getComputedStyle(el);
    return { fontPx: parseFloat(style.fontSize), minHeightPx: parseFloat(style.minHeight) };
  });
  assert.ok(control.fontPx >= 16, `coarse-pointer input font-size ${control.fontPx}px does not trigger iOS zoom`);
  assert.ok(control.minHeightPx >= 44, `coarse-pointer input min-height ${control.minHeightPx}px meets the 44px target`);
  await coarse.close();
});

// R33-1: on a phone the Menu drawer covers the Menu button. Opening it must
// move focus into the drawer; leaving focus on the covered button sends Tab
// through the hidden chat behind the drawer first.
test("phone Menu moves focus into the drawer and Escape brings it back", { timeout: 90000 }, async t => {
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); fixture.store.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" })).newPage();
  await page.goto(origin);
  await signInFixture(page, fixture.keys.owner);
  await page.locator("#main").waitFor({ state: "visible" });
  await page.locator("#sidebar-toggle").focus();
  await page.keyboard.press("Enter");
  await page.locator("#room-sidebar").waitFor({ state: "visible" });
  const focusInDrawer = () => page.evaluate(() => {
    const active = document.activeElement, rect = active.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return document.getElementById("room-sidebar").contains(active) && rect.width > 0 && Boolean(hit && (active === hit || active.contains(hit)));
  });
  assert.equal(await focusInDrawer(), true, "focus lands on a visible control inside the open drawer");
  await page.keyboard.press("Tab");
  assert.equal(await focusInDrawer(), true, "the next Tab stays in the drawer, not the chat behind it");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.getElementById("main").classList.contains("sidebar-open"));
  assert.equal(await page.evaluate(() => document.activeElement.id), "sidebar-toggle", "Escape returns focus to Menu");
});
