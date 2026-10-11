import { clickChrome } from "./room-chrome.mjs";
// Full synthetic browser journey. No human research or autonomous-agent claims.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { textVersion } from "../server/text-results.mjs";
import { openCatchUp } from "./room-chrome.mjs";

for (const touch of [false, true]) test(`contribution journey ${touch ? "touch" : "desktop"}: join, answer, return, review`, { timeout: 60000 }, async t => {
  const f = createAcceptanceFixture({ dmConsent: true }), server = createRoomServer({ store: f.store, streamInterval: 50 });
  let browser;
  t.after(async () => {
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: touch, hasTouch: touch, reducedMotion: "reduce" });
  const origin = `http://127.0.0.1:${server.address().port}`, errors = [];
  context.on("page", page => { page.setDefaultTimeout(8000); page.on("pageerror", error => errors.push(error.message)); });
  const state = () => f.store.room("commons").state;
  const send = (type, data) => f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type, data });
  // This journey tests the contribution flow, not history. It pins "all" so it
  // doesn't depend on the room's default. Since-join rooms have their own focus
  // bug (bug-sincejoin-catchup-focus-steal-20261011): background activity moves
  // focus to the return brief.
  send("room.history_visibility_set", { historyVisibility: "all" });
  let page = await context.newPage();
  await page.goto(`${origin}/#join/${f.links.valid}`);
  await page.locator("#join-link-name").fill("Journey guest"); await page.locator("#join-link-submit").click();
  await page.locator("#main").waitFor({ state: "visible" });
  const member = Object.values(state().members).find(person => person.displayName === "Journey guest");
  assert.ok(member); assert.deepEqual(member.permissions, []);
  // Consent-bound DMs: the owner sends a reply-request DM to the joined guest,
  // and the guest replies. Consent is directional — approve both ways.
  f.store.dmConsents.request("commons", "owner", member.id, "browser test");
  f.store.dmConsents.decide("commons", member.id, "owner", "approve");
  f.store.dmConsents.request("commons", member.id, "owner", "browser test");
  f.store.dmConsents.decide("commons", "owner", member.id, "approve");
  await openCatchUp(page);
  await page.locator("#contribution-open").focus();
  send("message.posted", { messageId: "journey-background", body: "A little more room context." });
  await page.locator('[data-message-record-id="journey-background"]').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.id), "contribution-open", "background activity preserves next-step focus");
  await page.getByRole("button", { name: "Say hello", exact: true }).click();
  assert.equal(await page.evaluate(() => document.activeElement.id), "message-input");
  await page.locator("#message-input").fill("I can help review the agenda.");
  await page.locator('#message-form button[type="submit"]').click();
  await page.locator("#contribution-next").waitFor({ state: "hidden" });
  send("message.posted", { messageId: "journey-question", body: "Should the agenda include a review?", toMemberId: member.id, requestKind: "reply" });
  await openCatchUp(page);
  await page.getByRole("button", { name: "Open request", exact: true }).waitFor();
  // Full-page capture currently resets Chromium's touch media emulation. Keep
  // mobile captures viewport-sized so subsequent Return checks remain touch checks.
  await page.screenshot({ path: `test-results/contribution-${touch ? "touch" : "desktop"}-request.png`, fullPage: !touch });
  await page.locator('#rb-attention-list [data-open-message="journey-question"]').waitFor();
  await page.waitForFunction(() => !document.querySelector("#rb-ack-button").disabled);
  await page.locator("#rb-ack-button").click();
  await page.waitForFunction(() => document.querySelector("#rb-ack-button").textContent === "Already caught up");
  assert.equal(await page.getByRole("button", { name: "Open request", exact: true }).isVisible(), true, "read is not resolved");
  await page.locator("#contribution-open").click();
  await page.locator('[data-message-id="journey-question"][data-message-action="request-answered"]').click();
  await page.waitForFunction(() => !document.querySelector("#message-input").disabled);
  await page.locator("#message-input").fill("Yes. End with a review and name its owner.");
  if (touch) {
    assert.equal(await page.evaluate(() => matchMedia("(hover: none) and (pointer: coarse)").matches), true, "touch media is active");
    await page.locator("#message-input").press("Enter");
    assert.equal(state().replyRequests["journey-question"].status, "open", "touch Return does not send");
    await page.locator('#message-form button[type="submit"]').click();
  } else await page.locator("#message-input").press("Enter");
  await page.locator("#request-mode-bar").waitFor({ state: "hidden" });
  assert.equal(state().replyRequests["journey-question"].status, "answered");
  await page.close();

  // A synthetic owner explicitly grants review and posts a stored result while
  // the guest is away. These service calls are not an actual agent test.
  send("member.access_changed", { memberId: member.id, expectedMemberRevision: 0, permissions: ["verify"], active: true });
  send("work.proposed", { workItemId: "journey-work", title: "An agenda we can use", definitionOfDone: "End with a review and name its owner.",
    accountableMemberId: "owner", verifierMemberId: member.id, independentVerificationRequired: true, ownerDecisionRequired: true, humanDecisionMakerId: "owner", mode: "read" });
  send("work.accepted", { workItemId: "journey-work", expectedRevision: 0 });
  const body = "1. Agree on the goal.\n2. Review the result.\nReview owner: Room owner.";
  const posted = send("message.posted", { messageId: "journey-result", workItemId: "journey-work", body });
  send("work.completed", { workItemId: "journey-work", expectedRevision: 1, evidenceKind: "room_text", evidenceMessageId: "journey-result",
    evidenceMessageEventId: posted.event.id, evidenceVersion: textVersion(body), previousCompletionEventId: null, producerId: "owner", summary: "A short agenda", nextAction: "Check the final step and owner." });
  page = await context.newPage(); await page.goto(`${origin}/?room=commons`); await page.locator("#main").waitFor({ state: "visible" });
  await openCatchUp(page);
  await page.getByRole("button", { name: "Review result", exact: true }).waitFor();
  assert.equal(await page.locator("#contribution-title").textContent(), "An agenda we can use");
  await page.screenshot({ path: `test-results/contribution-${touch ? "touch" : "desktop"}-return.png`, fullPage: !touch });
  await page.locator("#contribution-open").click();
  await page.waitForFunction(body => document.querySelector("#action-text-body").textContent === body, body);
  assert.equal(await page.locator("#review-criteria").textContent(), "End with a review and name its owner.");
  assert.equal(await page.locator("#review-notes").evaluate(node => node.open), false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  assert.equal(await page.locator("#action-dialog").evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await page.screenshot({ path: `test-results/contribution-${touch ? "touch" : "desktop"}-review.png` });
  await page.locator('#action-fields [name="result"]').selectOption("pass");
  await page.locator('#action-fields [name="summary"]').fill("The final step is review; its owner is named.");
  await page.locator('#action-form button[type="submit"]').click();
  await page.locator("#action-dialog").waitFor({ state: "hidden" });
  assert.equal(state().workItems["journey-work"].verification.independenceConfirmed, true);
  assert.equal(state().workItems["journey-work"].decision, null);
  assert.equal(await page.locator("#contribution-next").isVisible(), false);
  if (await page.locator("#session-menu-button").isVisible()) await page.locator("#session-menu-button").click(); await clickChrome(page, "#signout-button"); await page.locator("#auth-panel").waitFor({ state: "visible" });
  assert.equal(await page.locator("#review-criteria").textContent(), "");
  assert.equal(await page.locator("#contribution-title").textContent(), "");
  assert.deepEqual(errors, []);
});
