// Real-browser proof for fragment-secret handling, non-mutating preview, account-bound
// acceptance, stale-tab fencing, exact replay, draft preservation, and mobile access.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { signInFixture } from "./auth-signin.mjs";
import { createMagicLinkMailer } from "../server/magic-links.mjs";

const fixtureLogins = new Map();
const fixtureDelivery = new Map();

const secret = () => randomBytes(32).toString("base64url");
const chromiumOptions = process.env.ROOM_TEST_CHROMIUM_PATH
  ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH }
  : {};
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function counts(store, invitationId) {
  return {
    roomSequence: store.room("studio").sequence,
    invitation: { ...store.db.prepare("SELECT revision,status,accepted_at,redemption_id,joined_event_id FROM membership_invitations WHERE id=?").get(invitationId) },
    audits: store.db.prepare("SELECT count(*) AS n FROM membership_invitation_events WHERE invitation_id=?").get(invitationId).n,
    bindings: store.db.prepare("SELECT count(*) AS n FROM member_accounts WHERE room_id='studio' AND account_id='account-target'").get().n
  };
}

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-invitation-browser-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const lobby = initialRoom("lobby", "lobby-owner");
  lobby[0].data.title = "Lobby";
  lobby[0].data.purpose = "A familiar conversation to preserve while an invitation is reviewed.";
  store.initialize(lobby);
  const lobbyOwner = store.issueAccessKey("lobby", "lobby-owner");
  store.command(lobbyOwner, "lobby", {
    id: "add-target-to-lobby", type: T.MEMBER_ADDED,
    data: { memberId: "target-member", displayName: "Target human", kind: "human", permissions: ["accept_work", "complete_work", "verify"] }
  });
  const targetRoomKey = store.issueAccessKey("lobby", "target-member", 7 * 86400000, "account-target");

  const studio = initialRoom("studio", "studio-owner");
  studio[0].data.title = "Studio";
  studio[0].data.purpose = "A focused Room for making the next version together.";
  store.initialize(studio);
  store.bindHumanAccount("studio", "studio-owner", "account-studio-owner");
  const ownerAccountKey = store.issueAccountAccessKey("account-studio-owner");
  const targetAccountKey = store.issueAccountAccessKey("account-target");
  store.createAccount("account-other"); store.completeOnboarding("account-other");
  const otherAccountKey = store.issueAccountAccessKey("account-other");
  const targetEmail = "target-invitation@example.invalid", otherEmail = "other-invitation@example.invalid";
  store.accountLogins.linkMagicMethod("account-target", { email: targetEmail });
  store.accountLogins.linkMagicMethod("account-other", { email: otherEmail });
  fixtureLogins.set(targetAccountKey, targetEmail); fixtureLogins.set(otherAccountKey, otherEmail);
  t.after(() => { fixtureLogins.delete(targetAccountKey); fixtureLogins.delete(otherAccountKey); fixtureDelivery.delete(targetEmail); fixtureDelivery.delete(otherEmail); });
  const ownerSlot = store.createAccountSessionSlot();
  const ownerSession = store.loginAccountSession(ownerSlot.token, ownerAccountKey, ownerSlot.session.sessionRevision);
  const invitationToken = secret();
  const issued = store.issueInvitation(ownerSlot.token, "studio", {
    requestId: "browser-invitation",
    token: invitationToken,
    intendedAccountId: "account-target",
    intendedMemberId: "target-member",
    displayName: "Target human",
    role: "member",
    expiresAt: Date.now() + 3600000,
    expectedIssuerMemberRevision: 0,
    expectedSessionBinding: ownerSession.sessionBinding
  });

  let mailer;
  // createRoomServer asks isConfigured() while it is built (#2463), before the
  // mailer below exists. This fixture always installs a configured synthetic
  // sender right after bind, so "configured" is the truthful answer now.
  const deliveryProxy = { isConfigured: () => true, sendMagicLink: payload => mailer.sendMagicLink(payload) };
  const server = createRoomServer({ store, streamInterval: 30, magicLinkMailer: deliveryProxy });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  mailer = createMagicLinkMailer({ baseUrl: origin, send: async payload => fixtureDelivery.set(payload.to, payload) });
  let browser;
  t.after(async () => {
    await browser?.close();
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true, ...chromiumOptions });
  return { browser, store, origin, targetRoomKey, targetAccountKey, otherAccountKey, invitationToken, invitationId: issued.invitation.id,
    revoke: () => store.revokeInvitation(ownerSlot.token, issued.invitation.id, { expectedRevision: 0, reason: "Offer withdrawn", expectedSessionBinding: ownerSession.sessionBinding }) };
}

async function fillInvitationEmail(page, fixtureKey) {
  const email = fixtureLogins.get(fixtureKey);
  assert.ok(email, "test account has a synthetic email login");
  await page.locator("#invitation-email").click();
  await page.locator("#invitation-methods [data-forgot-password]").click();
  await page.locator('#invitation-methods [data-email-method="magic"]').click();
  const request = page.locator('#invitation-methods [data-signin-form="magic-request"]');
  await request.locator('[name="email"]').fill(email);
  await request.locator('button[type="submit"]').click();
  const form = page.locator('#invitation-methods [data-signin-form="magic-code"]');
  await form.locator('[data-magic-manual-code]').click();
  const delivery = fixtureDelivery.get(email);
  assert.ok(delivery?.code, "synthetic mailer captured a real issued verification code");
  await form.locator('[name="code"]').fill(delivery.code);
}

async function switchAccount(page, key) {
  return page.evaluate(async accountAccessKey => {
    const restored = await fetch("/api/account-session");
    const account = await restored.json();
    const response = await fetch("/api/account-session", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": account.csrf },
      body: JSON.stringify({ accountAccessKey, expectedSessionRevision: account.sessionRevision })
    });
    return { status: response.status, body: await response.json() };
  }, key);
}

test("targeted invitation preview retries its retained secret without accepting or losing the opener", { timeout: 45000 }, async t => {
  const { browser, store, origin, targetRoomKey, invitationToken, invitationId } = await fixture(t);
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(10000);
  await page.goto(origin);
  await signInFixture(page, targetRoomKey);
  await page.locator("#main").waitFor({ state: "visible" });
  await page.locator("#message-input").fill("Preserve this selected draft.");
  await page.locator("#message-input").evaluate(el => { el.focus(); el.setSelectionRange(0, 8); el.dispatchEvent(new Event("select")); });
  const before = counts(store, invitationId), secrets = [];
  await page.route("**/api/invitations/preview", async route => {
    secrets.push(route.request().postDataJSON().invitationToken);
    if (secrets.length === 1) await route.abort("failed");
    else if (secrets.length === 2) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "temporary", message: "Try later." } }) });
    else await route.continue();
  });
  await page.evaluate(token => { location.hash = "#invite/" + token; }, invitationToken);
  await page.locator("#invitation-retry").waitFor({ state: "visible" });
  assert.equal(new URL(page.url()).hash, "");
  assert.doesNotMatch(await page.locator("#invitation-error").textContent(), /invalid|expired|revoked/);
  await page.locator("#invitation-retry").click();
  await page.locator("#invitation-retry").waitFor({ state: "visible" });
  await page.locator("#invitation-retry").click();
  await page.locator("#invitation-details").waitFor({ state: "visible" });
  assert.deepEqual(secrets, [invitationToken, invitationToken, invitationToken]);
  assert.deepEqual(counts(store, invitationId), before, "preview retries do not accept membership");
  assert.equal(await page.locator("#invitation-retry").isVisible(), false);
  await page.waitForFunction(() => document.activeElement.id === "invitation-email");
  await page.locator("#invitation-dismiss").click();
  await page.waitForFunction(() => document.activeElement.id === "message-input");
  assert.equal(await page.locator("#message-input").inputValue(), "Preserve this selected draft.");
  assert.deepEqual(await page.locator("#message-input").evaluate(el => [el.selectionStart, el.selectionEnd]), [0, 8]);
});

test("invitation preview and acceptance preserve privacy, drafts, authority, and stale-tab ownership", { timeout: 90000 }, async t => {
  const { browser, store, origin, targetRoomKey, targetAccountKey, otherAccountKey, invitationToken, invitationId } = await fixture(t);
  const context = await browser.newContext({ viewport: { width: 1100, height: 850 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const requestEvidence = [];
  page.on("request", request => requestEvidence.push({ url: request.url(), referer: request.headers().referer ?? "", body: request.postData() ?? "" }));
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await signInFixture(page, targetRoomKey);
  await page.locator("#main").waitFor({ state: "visible" });
  assert.match(await page.locator("#identity-label").textContent(), /^Target human/);

  const composer = page.locator("#message-input");
  await composer.fill("Keep this private lobby draft");
  page.locator("#message-to-select").evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event("change", { bubbles: true })); }, "lobby-owner");
  await composer.focus();
  await composer.evaluate(element => element.setSelectionRange(12, 12));
  for (let index = 0; index < 7; index++) await page.keyboard.press("Shift+ArrowLeft");
  assert.deepEqual(await composer.evaluate(element => [element === document.activeElement, element.selectionStart, element.selectionEnd, element.selectionDirection]), [true, 5, 12, "backward"]);
  await composer.dispatchEvent("select");
  const beforePreview = counts(store, invitationId);
  await page.evaluate(token => { location.hash = `invite/${token}`; }, invitationToken);
  await page.locator("#invitation-dialog").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector("#invitation-details")?.hidden === false);

  assert.equal(page.url().includes(invitationToken), false, "the fragment is replaced before invitation work continues");
  const browserLeak = await page.evaluate(token => ({
    dom: document.documentElement.outerHTML.includes(token),
    local: Object.values(localStorage).some(value => value.includes(token)),
    session: Object.values(sessionStorage).some(value => value.includes(token)),
    resources: performance.getEntriesByType("resource").some(entry => entry.name.includes(token))
  }), invitationToken);
  assert.deepEqual(browserLeak, { dom: false, local: false, session: false, resources: false });
  assert.equal(requestEvidence.some(item => item.url.includes(invitationToken) || item.referer.includes(invitationToken)), false);
  assert.equal(requestEvidence.filter(item => item.body.includes(invitationToken)).length, 1, "only the preview POST body carries the invitation secret");
  assert.match(await page.locator("#invitation-boundary").textContent(), /haven’t joined.*no notification or read receipt is sent/i);
  assert.match(await page.locator("#invitation-room").textContent(), /Studio/);
  assert.deepEqual(counts(store, invitationId), beforePreview, "preview creates no event, membership, audit, or status write");
  mkdirSync("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/invitation-desktop.png" });

  await page.locator("#invitation-dismiss").click();
  await page.locator("#invitation-dialog").waitFor({ state: "hidden" });
  assert.equal(await composer.inputValue(), "Keep this private lobby draft");
  assert.equal(await page.locator("#message-to-select").inputValue(), "lobby-owner");
  assert.deepEqual(await composer.evaluate(element => [element === document.activeElement, element.selectionStart, element.selectionEnd, element.selectionDirection]), [true, 5, 12, "backward"]);

  await page.setViewportSize({ width: 390, height: 844 });
  await composer.focus();
  await page.evaluate(token => { location.hash = `invite/${token}`; }, invitationToken);
  await page.locator("#invitation-dialog").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector("#invitation-details")?.hidden === false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: "test-results/invitation-mobile.png" });
  for (const button of await page.locator("#invitation-dialog button:visible").all()) {
    await button.scrollIntoViewIfNeeded();
    const box = await button.boundingBox();
    assert.ok(box.height >= 44, `invitation control height ${box.height} is at least 44px`);
    assert.ok(box.y >= 0 && box.y + box.height <= 844, "each invitation control can be brought fully into the mobile viewport");
  }
  await page.screenshot({ path: "test-results/invitation-mobile-actions.png" });

  await fillInvitationEmail(page, targetAccountKey);
  page.once("dialog", dialog => dialog.accept());
  await page.locator('#invitation-methods [data-signin-form="magic-code"] button[type="submit"]').click();
  await page.getByRole("button", { name: "Accept and open as Personal account", exact: true }).waitFor();
  assert.equal(await composer.inputValue(), "", "confirmed invitation sign-in clears the old room draft before membership review");
  const cookiesBeforeAccept = new Map((await context.cookies()).map(cookie => [cookie.name, cookie.value]));
  assert.ok(cookiesBeforeAccept.has("room_session"));
  assert.ok(cookiesBeforeAccept.has("account_session"));

  const roomBeforeHeldAcceptance = new URL(page.url()).searchParams.get("room");
  const committed = deferred(), release = deferred();
  let acceptSetCookie;
  t.after(() => release.resolve());
  await page.route("**/api/invitations/accept", async route => {
    const response = await route.fetch();
    acceptSetCookie = response.headers()["set-cookie"];
    committed.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Accept and open as Personal account", exact: true }).click();
  await committed.promise;
  const afterCommit = counts(store, invitationId);
  assert.equal(afterCommit.invitation.status, "accepted");
  assert.equal(afterCommit.bindings, 1);
  assert.equal(acceptSetCookie, undefined, "acceptance never rotates either browser cookie");

  const otherTab = await context.newPage();
  await otherTab.goto(origin);
  const switched = await switchAccount(otherTab, otherAccountKey);
  assert.equal(switched.status, 201);
  assert.equal(switched.body.account.id, "account-other");
  release.resolve();
  await page.waitForFunction(() => document.querySelector("#invitation-error")?.textContent.includes("browser account changed"));
  assert.equal(new URL(page.url()).searchParams.get("room"), roomBeforeHeldAcceptance, "a held old-account response cannot navigate the replacement account");
  assert.equal(await page.locator("#status").textContent(), "", "a held response cannot announce acceptance into the replacement account UI");
  assert.deepEqual(counts(store, invitationId), afterCommit, "the held response causes no duplicate membership or audit write");

  await fillInvitationEmail(page, targetAccountKey);
  await page.locator('#invitation-methods [data-signin-form="magic-code"] button[type="submit"]').click();
  await page.locator('#invitation-methods [data-magic-switch]').waitFor();
  page.once("dialog", dialog => dialog.accept());
  await page.locator('#invitation-methods [data-magic-switch]').click();
  await page.getByRole("button", { name: "Accept and open as Personal account", exact: true }).waitFor();
  // Magic link logins rotate the account slot, so the
  // account cookie legitimately changed at each sign-in above. The property
  // under test is that *acceptance itself* never rotates either cookie.
  const cookiesBeforeFinalAccept = new Map((await context.cookies()).map(cookie => [cookie.name, cookie.value]));
  await page.getByRole("button", { name: "Accept and open as Personal account", exact: true }).click();
  await page.waitForURL(`${origin}/?room=studio`);
  await page.locator("#main").waitFor({ state: "visible" });
  assert.match(await page.locator("#identity-label").textContent(), /^Target human/);
  assert.equal(await page.locator("#room-title").textContent(), "Studio");
  assert.equal(await page.locator("#conversation-title").textContent(), "# general");
  assert.equal(await composer.inputValue(), "", "private drafts clear only after the confirmed account/Room switch");
  assert.deepEqual(counts(store, invitationId), afterCommit, "the exact lost-response replay is a no-write receipt");
  const cookiesAfterAccept = new Map((await context.cookies()).map(cookie => [cookie.name, cookie.value]));
  assert.equal(cookiesAfterAccept.get("room_session"), cookiesBeforeFinalAccept.get("room_session"));
  assert.equal(cookiesAfterAccept.get("account_session"), cookiesBeforeFinalAccept.get("account_session"),
    "acceptance never rotates the account cookie");
  assert.deepEqual(errors, []);
});

test("malformed invitation fragments are scrubbed locally and never sent", { timeout: 90000 }, async t => {
  const { browser, origin } = await fixture(t);
  const page = await (await browser.newContext()).newPage();
  const bodies = [];
  page.on("request", request => bodies.push(request.postData() ?? ""));
  const malformed = "not-a-valid-invitation-secret";
  await page.goto(`${origin}/#invite/${malformed}`);
  await page.locator("#invitation-dialog").waitFor({ state: "visible" });
  assert.equal(page.url().includes(malformed), false);
  assert.match(await page.locator("#invitation-error").textContent(), /unavailable/i);
  assert.equal(await page.locator("#invitation-summary").textContent(), "This invitation is unavailable.");
  assert.equal(bodies.some(body => body.includes(malformed)), false);
});

test("cancelled authentication preserves drafts and committed email upgrade fences revoked room access", { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const page = await (await f.browser.newContext()).newPage();
  await page.goto(f.origin);
  await signInFixture(page, f.targetRoomKey);
  await page.locator("#main").waitFor({ state: "visible" });
  await page.locator("#message-input").fill("Retain this draft until I choose to switch");
  await page.evaluate(token => { location.hash = `invite/${token}`; }, f.invitationToken);
  await page.locator("#invitation-email").waitFor({ state: "visible" });
  assert.match(await page.locator("#invitation-account-warning").textContent(), /Switching accounts clears.*drafts.*Save a copy first/i);
  for (let index = 0; index < 6; index++) {
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.querySelector("#invitation-dialog").contains(document.activeElement)), true);
  }
  await fillInvitationEmail(page, f.targetAccountKey);
  let confirmations = 0, consumeRequests = 0;
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/auth/magic/consume") consumeRequests++; });
  page.once("dialog", async dialog => { confirmations++; assert.match(dialog.message(), /clears.*unsent drafts/i); await dialog.dismiss(); });
  await page.locator('#invitation-methods [data-signin-form="magic-code"] button[type="submit"]').click();
  assert.equal(confirmations, 1); assert.equal(consumeRequests, 0, "cancelled confirmation never posts authentication");
  assert.equal(await page.locator("#message-input").inputValue(), "Retain this draft until I choose to switch");
  const held = deferred(), release = deferred();
  t.after(() => release.resolve());
  await page.route("**/api/auth/magic/consume", async route => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    assert.equal((await response.json()).account.id, "account-target", "real magic upgrade resolves the intended existing account");
    held.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  page.once("dialog", dialog => dialog.accept());
  await page.locator('#invitation-methods [data-signin-form="magic-code"] button[type="submit"]').click();
  await held.promise;
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#invitation-dialog").evaluate(element => element.open), true);
  assert.equal(await page.locator("#invitation-dismiss").isDisabled(), true);
  release.resolve();
  await page.getByRole("button", { name: "Accept and open as Personal account", exact: true }).waitFor();
  await page.waitForFunction(() => document.activeElement?.id === "invitation-accept");
  assert.equal(await page.locator("#message-input").inputValue(), "", "committed magic authentication revokes the old room credential and clears its private draft");
});

test("an invalidated offer removes acceptance controls and returns keyboard focus to dismissal", { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const page = await (await f.browser.newContext()).newPage();
  await page.goto(`${f.origin}/#invite/${f.invitationToken}`);
  await fillInvitationEmail(page, f.targetAccountKey);
  await page.locator('#invitation-methods [data-signin-form="magic-code"] button[type="submit"]').click();
  await page.getByRole("button", { name: "Accept and open as Personal account", exact: true }).waitFor();
  f.revoke();
  await page.locator("#invitation-accept").click();
  await page.waitForFunction(() => document.querySelector("#invitation-error").textContent.includes("revoked"));
  assert.equal(await page.locator("#invitation-accept").isVisible(), false);
  assert.equal(await page.locator("#invitation-signin").isVisible(), false);
  assert.equal(await page.locator("#invitation-summary").textContent(), "This invitation is unavailable.");
  await page.waitForFunction(() => document.activeElement?.id === "invitation-dismiss");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#invitation-dialog").evaluate(element => element.open), false);
});

test("account mismatch focuses the account field for recovery", { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const page = await (await f.browser.newContext()).newPage();
  await page.goto(`${f.origin}/#invite/${f.invitationToken}`);
  await fillInvitationEmail(page, f.otherAccountKey);
  await page.locator('#invitation-methods [data-signin-form="magic-code"] button[type="submit"]').click();
  await page.getByRole("button", { name: "Accept and open as Personal account", exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.id === "invitation-email" && document.querySelector("#invitation-error").textContent.includes("another account"));
  assert.equal(await page.locator("#invitation-accept").isVisible(), false);
});

test("uncertain acceptance retains its retry on cancelled dismissal and accepted Room-load failure stays neutral", { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const page = await (await f.browser.newContext()).newPage();
  await page.goto(`${f.origin}/#invite/${f.invitationToken}`);
  await fillInvitationEmail(page, f.targetAccountKey);
  await page.locator('#invitation-methods [data-signin-form="magic-code"] button[type="submit"]').click();
  await page.route("**/api/invitations/accept", route => route.abort());
  await page.getByRole("button", { name: "Accept and open as Personal account", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#invitation-error").textContent.includes("could not confirm"));
  await page.waitForFunction(() => document.activeElement?.id === "invitation-accept");
  page.once("dialog", async dialog => { assert.match(dialog.message(), /clears this tab’s retry information/); await dialog.dismiss(); });
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#invitation-dialog").evaluate(element => element.open), true);
  await page.unroute("**/api/invitations/accept");
  await page.getByRole("button", { name: "Check acceptance again", exact: true }).click();
  await page.locator("#main").waitFor({ state: "visible" });
  await page.goto(`${f.origin}/#invite/${f.invitationToken}`);
  await page.getByRole("button", { name: "Open room as Personal account", exact: true }).waitFor();
  await page.route("**/api/session?room=studio", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "temporarily_unavailable", message: "Room temporarily unavailable" } }) }));
  await page.getByRole("button", { name: "Open room as Personal account", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#auth-error").textContent.includes("already accepted, but the Room could not be loaded"));
  assert.equal(await page.locator("#auth-error").textContent().then(text => text.includes("account that accepted")), false);
});

for (const responseBody of ["{", "{}"] ) test(`committed email response ${JSON.stringify(responseBody)} fences the old room and reconciles the actual cookie`, { timeout: 45000 }, async t => {
  const f = await fixture(t);
  const page = await (await f.browser.newContext()).newPage();
  await page.goto(f.origin); await signInFixture(page, f.targetRoomKey);
  await page.locator("#message-input").fill("Old private room draft must be fenced after uncertain authentication");
  await page.evaluate(token => { location.hash = `invite/${token}`; }, f.invitationToken);
  await fillInvitationEmail(page, f.targetAccountKey);
  let loginCommitted = false;
  await page.route("**/api/auth/magic/consume", async route => {
    const response = await route.fetch();
    assert.equal(response.status(), 201);
    loginCommitted = true;
    await route.fulfill({ response, body: responseBody }); // actual cookie arrives with unreadable/invalid success data
  });
  const reconciliation = page.waitForResponse(response => loginCommitted && new URL(response.url()).pathname === "/api/account-session" && response.request().method() === "GET");
  page.once("dialog", dialog => dialog.accept());
  await page.locator('#invitation-methods [data-signin-form="magic-code"] button[type="submit"]').click();
  const reconciled = await (await reconciliation).json();
  assert.equal(reconciled.authenticated, true);
  assert.equal(reconciled.account.id, "account-target", "host restoration reads the rotated cookie before any manual fixture GET");
  await page.locator("#main").waitFor({ state: "hidden" });
  assert.equal(loginCommitted, true);
  assert.equal(await page.locator("#main").isVisible(), false, "uncertain identity never retains the old room UI");
  assert.equal(await page.locator("#message-input").inputValue(), "", "old private draft cannot cross the unknown identity boundary");
  assert.equal(f.store.db.prepare("SELECT status FROM membership_invitations WHERE id=?").get(f.invitationId).status, "pending", "sign-in never accepts membership");
  const restored = await page.context().request.get(`${f.origin}/api/account-session`);
  const actual = await restored.json();
  assert.equal(actual.authenticated, true);
  assert.equal(actual.account.id, "account-target", "reconciliation reads the actual cookie, not the missing POST body");
});

test("successful email POST followed by a failed account restore fences private room state", { timeout: 45000 }, async t => {
  const f = await fixture(t);
  const page = await (await f.browser.newContext()).newPage();
  await page.goto(f.origin); await signInFixture(page, f.targetRoomKey);
  await page.locator("#message-input").fill("Private draft before failed identity confirmation");
  await page.evaluate(token => { location.hash = `invite/${token}`; }, f.invitationToken);
  await fillInvitationEmail(page, f.targetAccountKey);
  let loginCommitted = false, restoreFailed = false, restoredFailure;
  const failedRestore = new Promise(resolve => { restoredFailure = resolve; });
  await page.route("**/api/auth/magic/consume", async route => {
    const response = await route.fetch(); assert.equal(response.status(), 201);
    loginCommitted = true; await route.fulfill({ response });
  });
  await page.route("**/api/account-session", async route => {
    if (loginCommitted && route.request().method() === "GET") {
      restoreFailed = true; await route.abort("failed"); restoredFailure();
    } else await route.continue();
  });
  page.once("dialog", dialog => dialog.accept());
  await page.locator('#invitation-methods [data-signin-form="magic-code"] button[type="submit"]').click();
  await page.locator("#main").waitFor({ state: "hidden" });
  await failedRestore;
  assert.equal(loginCommitted, true); assert.equal(restoreFailed, true);
  assert.equal(await page.locator("#message-input").inputValue(), "");
  assert.equal(f.store.db.prepare("SELECT status FROM membership_invitations WHERE id=?").get(f.invitationId).status, "pending");
  assert.equal(await page.locator("#invitation-accept").isVisible(), false, "unconfirmed identity cannot accept invitation");
});

test("delivered email link opens its intended invitation in a fresh browser tab", { timeout: 45000 }, async t => {
  const f = await fixture(t);
  const context = await f.browser.newContext(); const opener = await context.newPage();
  await opener.goto(`${f.origin}/#invite/${f.invitationToken}`);
  await opener.locator('#invitation-email').click();
  await opener.locator('#invitation-methods [data-forgot-password]').click();
  await opener.locator('#invitation-methods [data-email-method="magic"]').click();
  const form = opener.locator('#invitation-methods [data-signin-form="magic-request"]');
  const email = fixtureLogins.get(f.targetAccountKey);
  await form.locator('[name="email"]').fill(email);
  await form.locator('button[type="submit"]').click();
  await opener.locator('[data-magic-manual-code]').waitFor();
  const delivery = fixtureDelivery.get(email);
  assert.ok(delivery?.link, "configured synthetic mailer captures the actual delivered URL");
  assert.equal(new URL(delivery.link).hash, `#invite/${f.invitationToken}`);
  const receiver = await context.newPage(); await receiver.goto(delivery.link);
  await receiver.getByRole('button', { name: 'Accept and open as Personal account', exact: true }).waitFor();
  assert.doesNotMatch(receiver.url(), /magic=|email=|#invite/);
  assert.equal(f.store.db.prepare('SELECT status FROM membership_invitations WHERE id=?').get(f.invitationId).status, 'pending');
  await receiver.locator('#invitation-accept').click();
  await receiver.waitForURL(`${f.origin}/?room=studio`);
  await receiver.locator('#main').waitFor({ state: 'visible' });
});

test("a shared invitation retains its pending account signup across Escape and navigation controls", { timeout: 45000 }, async t => {
  const f = await fixture(t), token = secret();
  f.store.shareLinks.create(f.store.issueAccessKey("studio", "studio-owner"), "studio", {
    requestId: "pending-account-signup", linkToken: token, expiresAt: Date.now() + 3600000, maxJoins: 2, expectedMemberRevision: 0
  });
  const page = await (await f.browser.newContext()).newPage(); page.setDefaultTimeout(10000);
  await page.goto(`${f.origin}/#join/${token}`);
  if (await page.locator("#join-account-signin").isVisible()) await page.locator("#join-account-signin").click();
  const form = page.locator('#join-account-auth [data-signin-form="password"]');
  await form.locator('[data-password-mode="signup"]').click();
  await form.locator('[name="email"]').fill("shared-pending-signup@example.invalid");
  await form.locator('[name="password"]').fill("synthetic-shared-signup-password");
  const committed = deferred(), release = deferred(); t.after(() => release.resolve());
  await page.route("**/api/auth/password/signup", async route => {
    const response = await route.fetch(); assert.equal(response.status(), 202);
    committed.resolve(); await release.promise; await route.fulfill({ response });
  });
  await form.locator('button[type="submit"]').click(); await committed.promise;
  assert.equal(await page.locator("#join-link-dialog").getAttribute("aria-busy"), "true");
  for (const id of ["join-account-back", "join-link-close", "join-link-submit"]) assert.equal(await page.locator(`#${id}`).isDisabled(), true);
  assert.equal(await page.locator("#join-account-google").getAttribute("aria-disabled"), "true");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#join-link-dialog").evaluate(dialog => dialog.open), true);
  assert.equal(await page.locator("#join-account-auth").isVisible(), true);
  await page.locator("#join-account-google").evaluate(anchor => anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
  assert.equal(new URL(page.url()).pathname, "/", "pending auth cannot start Google navigation");
  assert.equal(await page.evaluate(() => sessionStorage.getItem("pr-pending-join")), `#join/${token}`, "pending auth keeps this dialog's own link stashed");
  const another = secret();
  await page.evaluate(value => { location.hash = `#join/${value}`; }, another);
  await page.locator("#join-link-status").filter({ hasText: "Finish signing in" }).waitFor();
  assert.equal(await page.locator("#join-account-auth").isVisible(), true);
  release.resolve();
  await page.locator("#join-link-submit").filter({ hasText: /^Join room$/ }).waitFor();
  await page.waitForFunction(() => document.querySelector("#join-link-dialog").getAttribute("aria-busy") === "false");
  assert.equal(await page.locator("#join-link-close").isDisabled(), false);
  await page.locator("#join-link-name").fill("Signed-in shared participant");
  await page.locator("#join-link-submit").click();
  await page.waitForURL(`${f.origin}/?room=studio`); await page.locator("#main").waitFor({ state: "visible" });
});
