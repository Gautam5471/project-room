// MEMBER-PERMS PR2: simulated browser journeys against a disposable real server.
// Authoring gate: these own UI wiring, selection, retry and session lifecycle.
// Credible regressions are posting admission instead of an authenticated upgrade,
// sending unselected grants, duplicating a committed request after response loss,
// or painting the previous member's callback into a new session. HTTP tests do
// not mount the UI; these use no production test seams or fabricated API replies.
// The two happy-path viewports additionally guard mobile reachability and native
// keyboard activation; Escape review dismissal must restore the initiating focus.
// Additional regressions own prelookup-throttle retry continuity, live ownership
// loss with an open review, and keyboard focus across real stream-driven refreshes.
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AccessRequests } from "../server/access-requests.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { signInFixture } from "./auth-signin.mjs";
import { signInFixtureInPlace } from "./in-place-fixture-signin.mjs";
import { clickChrome, openMemberProfile } from "./room-chrome.mjs";

const requestPath = "/api/rooms/commons/members/me/permission-requests";
const isPermissionRequest = request => request.method() === "POST" && new URL(request.url()).pathname === requestPath;
const ownRow = (page, memberId = "requester") => page.locator(`#presence-list [data-member-record-id="${memberId}"]`);
const attentionRow = (page, name = "Permission Requester") => page.locator("#attention-list > li").filter({ hasText: name });

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function setup(t, { width = 1440 } = {}) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom());
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  for (const [id, displayName, permissions] of [
    ["requester", "Permission Requester", []],
    ["other", "Other Member", []],
    ["admin", "Permission Admin", ["manage_members", "accept_work"]],
  ]) {
    store.command(keys.owner, "commons", { id: crypto.randomUUID(), type: T.MEMBER_ADDED,
      data: { memberId: id, displayName, kind: "human", permissions } });
    keys[id] = store.issueAccessKey("commons", id);
  }
  const server = createRoomServer({ store, streamInterval: 40 });
  let browser;
  const errors = [], releases = [];
  t.after(async () => {
    releases.forEach(release => release());
    await browser?.close();
    server.closeStreams(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    store.close();
    assert.deepEqual(errors, [], "browser runtime has no uncaught errors");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true,
    ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const login = async memberId => {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin);
    await signInFixture(page, keys[memberId]);
    await page.locator("#main").waitFor({ state: "visible" });
    return page;
  };
  const api = async (path, memberId = "owner", data) => {
    const response = await fetch(`${origin}${path}`, {
      method: data === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${keys[memberId]}`, ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const access = new AccessRequests(store);
  return { store, keys, login, api, access,
    pending: () => access.list(keys.owner, "commons"),
    permissions: memberId => store.roomAuthority("commons").members[memberId].permissions,
    hold: () => { const gate = deferred(); releases.push(gate.resolve); return gate; },
  };
}

async function ask(page, memberId = "requester", { keyboard = false } = {}) {
  await openMemberProfile(page, memberId);
  const reply = page.waitForResponse(response => isPermissionRequest(response.request()));
  const button = ownRow(page, memberId).getByRole("button", { name: "Ask to take work", exact: true });
  if (keyboard) { await button.focus(); await button.press("Enter"); }
  else await button.click();
  const response = await reply;
  assert.equal(response.status(), 201, await response.text());
  return response.json();
}

async function decide(page, label, expectedStatus = 200) {
  const reply = page.waitForResponse(response => response.request().method() === "POST"
    && /\/access-requests\/[^/]+\/decide$/.test(new URL(response.url()).pathname));
  await attentionRow(page).getByRole("button", { name: label, exact: true }).click();
  const response = await reply;
  assert.equal(response.status(), expectedStatus, await response.text());
  return response.json();
}

for (const width of [390, 1280]) test(`a basic member requests by keyboard at ${width}px, the owner approves, and the member can claim work`, { timeout: 60000 }, async t => {
  const f = await setup(t, { width });
  assert.equal((await f.api("/api/rooms/commons/work-claims", "owner", { id: "permission-work", title: "Permission browser work" })).status, 201);
  assert.equal((await f.api("/api/rooms/commons/work-claims/permission-work/claim", "requester", {})).status, 403);
  const page = await f.login("requester");
  await openMemberProfile(page, "requester");
  assert.equal(await ownRow(page).getByRole("button", { name: "Ask to take work", exact: true }).count(), 1);
  assert.equal((await ownRow(page).locator("[data-permission-request-status]").textContent()).trim(),
    "Ask for: Accept work, Complete work. A room owner or admin reviews the request.", "members see permission names, not ids");
  assert.equal(await ownRow(page, "other").getByRole("button", { name: "Ask to take work", exact: true }).count(), 0,
    "a member cannot file a request as somebody else");
  const request = await ask(page, "requester", { keyboard: true });
  assert.equal(request.kind, "permissions");
  assert.equal(request.memberId, "requester");
  assert.deepEqual(request.requestedPermissions, ["accept_work", "complete_work"]);
  await ownRow(page).locator("[data-permission-request-status]").filter({ hasText: "Waiting for review." }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, "request controls fit the viewport");
  assert.equal(f.pending().length, 1);
  assert.deepEqual(f.permissions("requester"), [], "asking does not grant authority");
  assert.equal(await ownRow(page).getByRole("button", { name: "Ask to take work", exact: true }).count(), 0);

  const joiner = f.store.identities.create("Ordinary Joiner");
  f.access.request("commons", { identityId: joiner.identityId, displayName: "Ordinary Joiner",
    requestedPermissions: [], requestId: "browser_join_request" });
  const owner = await f.login("owner"), row = attentionRow(owner);
  await row.waitFor();
  assert.equal(await row.locator(".attention-kind").textContent(), "Permission request");
  assert.match(await row.locator(".attention-detail").textContent(), /accept_work/);
  assert.match(await row.locator(".attention-detail").textContent(), /complete_work/);
  assert.equal(await attentionRow(owner, "Ordinary Joiner").locator(".attention-kind").textContent(), "Join request");
  assert.equal(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, "review controls fit the viewport");
  await decide(owner, "Approve");
  await row.waitFor({ state: "detached" });
  await page.locator("#message-list").getByText(new RegExp(`Approved permission request ${request.requestId}`)).waitFor();
  assert.deepEqual(f.permissions("requester"), ["accept_work", "complete_work"]);
  await ownRow(page).locator("[data-permission-request-status]").filter({ hasText: "You can take work now." }).waitFor();
  await page.keyboard.press("Control+k");
  await page.locator("#room-actions-query").fill("board");
  await page.locator('[data-room-action="board"]').press("Enter");
  const card = page.locator('article[data-claim-id="permission-work"]');
  await card.getByRole("button", { name: "Claim", exact: true }).click();
  await page.locator('[aria-labelledby="board-col-claimed"] article[data-claim-id="permission-work"]').waitFor();
  assert.equal(await page.locator("#board-status").textContent(), "Claimed 'Permission browser work'");
  assert.equal(f.store.workClaims.get("commons", "permission-work").owner, "requester");
  assert.equal(await page.locator("#board-dialog").evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, "the claim dialog fits its viewport");
});

test("an admin can cancel partial review, approve only selected permissions, and decline the remainder", { timeout: 60000 }, async t => {
  const f = await setup(t), member = await f.login("requester");
  await ask(member);
  const admin = await f.login("admin"), row = attentionRow(admin);
  await row.waitFor();
  assert.equal(await row.locator(".attention-kind").textContent(), "Permission request");
  assert.equal(await row.getByRole("button", { name: "Approve", exact: true }).isDisabled(), true,
    "an admin is not offered a grant it does not hold");
  assert.match(await row.textContent(), /You cannot grant: complete_work/);
  assert.deepEqual(f.permissions("requester"), []);
  let writes = 0;
  admin.on("request", request => { if (request.method() === "POST" && /\/decide$/.test(new URL(request.url()).pathname)) writes++; });
  const sequence = f.store.room("commons").sequence;
  await row.getByRole("button", { name: "Approve partial", exact: true }).click();
  const selection = row.locator("fieldset");
  await selection.waitFor();
  assert.equal(await selection.getByRole("checkbox").count(), 2);
  assert.equal(await selection.getByRole("checkbox", { name: "complete_work", exact: true }).isDisabled(), true);
  assert.equal(await selection.getByRole("checkbox", { name: "complete_work", exact: true }).isChecked(), false);
  await selection.getByRole("checkbox", { name: "accept_work", exact: true }).uncheck();
  assert.equal(await row.getByRole("button", { name: "Approve selected", exact: true }).isDisabled(), true);
  await row.getByRole("button", { name: "Cancel", exact: true }).click();
  await selection.waitFor({ state: "detached" });
  assert.equal(writes, 0, "opening, selecting and cancelling sends no decision");
  assert.equal(f.store.room("commons").sequence, sequence, "cancel appends no room event");
  assert.equal(f.pending().length, 1);
  const partialButton = row.getByRole("button", { name: "Approve partial", exact: true });
  assert.equal(await partialButton.evaluate(node => node === document.activeElement), true, "Cancel returns focus to partial review");

  await partialButton.click();
  await selection.getByRole("checkbox", { name: "accept_work", exact: true }).focus();
  await admin.keyboard.press("Escape");
  await selection.waitFor({ state: "detached" });
  assert.equal(await partialButton.evaluate(node => node === document.activeElement), true, "Escape returns focus to partial review");
  assert.equal(writes, 0, "Escape dismisses without submitting a decision");
  assert.equal(f.store.room("commons").sequence, sequence, "Escape appends no room event");

  await partialButton.click();
  await selection.getByRole("checkbox", { name: "accept_work", exact: true }).check();
  assert.equal(await selection.getByRole("checkbox", { name: "complete_work", exact: true }).isChecked(), false);
  const approved = await decide(admin, "Approve selected");
  await row.waitFor({ state: "detached" });
  assert.deepEqual(approved.grantedPermissions, ["accept_work"]);
  assert.deepEqual(f.permissions("requester"), ["accept_work"]);
  await member.locator("#message-list").getByText(new RegExp(`Approved permission request ${approved.requestId}`)).waitFor();
  const checked = member.waitForResponse(response => isPermissionRequest(response.request()));
  await ownRow(member).getByRole("button", { name: "Check request", exact: true }).click();
  assert.equal((await (await checked).json()).status, "approved");
  const remainder = await ask(member);
  assert.deepEqual(remainder.requestedPermissions, ["complete_work"], "the next request asks only for missing permissions");
  await row.waitFor();
  assert.match(await row.locator(".attention-detail").textContent(), /complete_work/);
  assert.doesNotMatch(await row.locator(".attention-detail").textContent(), /accept_work/);
  await decide(admin, "Decline");
  await row.waitFor({ state: "detached" });
  await member.locator("#message-list").getByText(new RegExp(`Declined permission request ${remainder.requestId}`)).waitFor();
  const declineChecked = member.waitForResponse(response => isPermissionRequest(response.request()));
  await ownRow(member).getByRole("button", { name: "Check request", exact: true }).click();
  assert.equal((await (await declineChecked).json()).status, "denied");
  await ownRow(member).locator("[data-permission-request-status]").filter({ hasText: "The request was declined. Your permissions are unchanged." }).waitFor();
  assert.deepEqual(f.permissions("requester"), ["accept_work"], "decline keeps previously granted access");
  assert.equal(f.pending().length, 0);
});

for (const scenario of ["lost response", "lost response then 429", "confirmed pending then 429"]) test(`permission request recovery: ${scenario} retains one request and its grants`, { timeout: 60000 }, async t => {
  const f = await setup(t), page = await f.login("requester");
  const confirmed = scenario.startsWith("confirmed"), throttle = scenario.endsWith("429");
  const held = f.hold(), committed = deferred(), sent = [];
  await page.route(`**${requestPath}`, async route => {
    sent.push(route.request().postDataJSON());
    // Simulate only the prelookup limiter's error. Original and recovery writes
    // still reach the real HTTP handler, authentication, database and event log.
    if (throttle && sent.length === 2) return route.fulfill({ status: 429,
      json: { error: { code: "rate_limited", message: "Synthetic prelookup rate limit" } } });
    if (sent.length !== 1) return route.continue();
    const response = await route.fetch();
    assert.equal(response.status(), 201);
    committed.resolve();
    await held.promise;
    if (confirmed) await route.fulfill({ response });
    else await route.abort("failed");
  });
  await openMemberProfile(page, "requester");
  await ownRow(page).getByRole("button", { name: "Ask to take work", exact: true }).dblclick();
  await committed.promise;
  assert.equal(sent.length, 1, "an impatient double click submits once");
  assert.equal(f.pending().length, 1, "the original request was committed");
  const sequence = f.store.room("commons").sequence;
  held.resolve();
  const firstRecovery = ownRow(page).getByRole("button", { name: confirmed ? "Check request" : "Retry request", exact: true });
  await firstRecovery.waitFor();
  let reply = page.waitForResponse(response => isPermissionRequest(response.request()));
  await firstRecovery.click();
  let response = await reply;
  if (throttle) {
    assert.equal(response.status(), 429);
    const retry = ownRow(page).getByRole("button", { name: "Retry request", exact: true });
    await retry.waitFor();
    assert.equal(f.pending().length, 1);
    assert.equal(f.store.room("commons").sequence, sequence, "the prelookup throttle did not write");
    reply = page.waitForResponse(response => isPermissionRequest(response.request()));
    await retry.click();
    response = await reply;
  }
  assert.equal(response.status(), 201);
  const recovered = await response.json();
  await ownRow(page).locator("[data-permission-request-status]").filter({ hasText: "Waiting for review." }).waitFor();
  assert.equal(sent.length, throttle ? 3 : 2);
  assert.ok(sent[0].requestId);
  for (const retry of sent.slice(1)) {
    assert.equal(retry.requestId, sent[0].requestId, "every retry retains the original idempotency key");
    assert.deepEqual(retry.permissions, sent[0].permissions, "every retry retains the exact requested grants");
  }
  assert.equal(recovered.requestId, sent[0].requestId);
  assert.equal(f.pending().length, 1);
  assert.equal(f.store.room("commons").sequence, sequence, "recovering a committed request appends no duplicate event");
  assert.deepEqual(f.permissions("requester"), []);
});

test("a late permission-request response cannot move request state into a different member's session", { timeout: 60000 }, async t => {
  const f = await setup(t), page = await f.login("requester");
  const held = f.hold(), committed = deferred();
  let firstRequest;
  await page.route(`**${requestPath}`, async route => {
    if (firstRequest) return route.continue();
    firstRequest = route.request().postDataJSON();
    const response = await route.fetch();
    assert.equal(response.status(), 201);
    committed.resolve();
    await held.promise;
    await route.fulfill({ response });
  });
  await openMemberProfile(page, "requester");
  await ownRow(page).getByRole("button", { name: "Ask to take work", exact: true }).click();
  await committed.promise;
  await clickChrome(page, "#signout-button");
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await signInFixtureInPlace(page, f.store, f.keys.other);
  await openMemberProfile(page, "other");
  const delivered = page.waitForResponse(response => isPermissionRequest(response.request()));
  held.resolve(); await delivered;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await ownRow(page, "other").getByRole("button", { name: "Ask to take work", exact: true }).count(), 1);
  assert.equal(await ownRow(page, "other").getByRole("button", { name: "Retry request", exact: true }).count(), 0);
  assert.equal(await page.locator("#attention-list > li").count(), 0);
  const otherRequest = await ask(page, "other");
  assert.equal(otherRequest.memberId, "other");
  assert.notEqual(otherRequest.requestId, firstRequest.requestId);
  assert.deepEqual(f.pending().map(request => request.memberId).sort(), ["other", "requester"]);
  assert.deepEqual(f.permissions("other"), []);
});


test("ownership transfer closes a partial review and clears the owner-only rollup before the admin queue returns", { timeout: 60000 }, async t => {
  const f = await setup(t);
  const send = (type, data) => f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type, data });
  const workId = "owner-lease-reminder", title = "Owner-only lease reminder";
  send(T.WORK_PROPOSED, { workItemId: workId, title, definitionOfDone: "Return evidence",
    accountableMemberId: "owner", mode: "write", independentVerificationRequired: false, ownerDecisionRequired: false });
  const revision = () => f.store.room("commons").state.workItems[workId].revision;
  send(T.WORK_ACCEPTED, { workItemId: workId, expectedRevision: revision() });
  send(T.CLAIM_ACQUIRED, { workItemId: workId, expectedRevision: revision(), repository: "fixture/repository",
    ref: "local-fixture", paths: ["fixture.txt"], expiresAt: new Date(Date.now() + 3600000).toISOString() });
  const request = f.access.requestForMember(f.keys.requester, "commons", {
    permissions: ["accept_work", "complete_work"], requestId: "ownership-browser-request" });
  const page = await f.login("owner"), row = attentionRow(page);
  await row.waitFor();
  const ownerDetail = page.locator("#attention-list > li").filter({ hasText: title });
  await ownerDetail.waitFor();
  await row.getByRole("button", { name: "Approve partial", exact: true }).click();
  await row.locator("fieldset").waitFor();
  const held = f.hold(), captured = deferred();
  await page.route("**/api/rooms/commons/access-requests?status=pending", async route => {
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    captured.resolve();
    await held.promise;
    await route.fulfill({ response });
  });
  send(T.OWNERSHIP_TRANSFERRED, { toMemberId: "other", reason: "Disposable browser ownership handoff" });
  const authority = f.store.roomAuthority("commons");
  assert.equal(authority.ownerId, "other");
  assert.equal(authority.members.owner.active, true);
  assert.ok(authority.members.owner.permissions.includes("manage_members"));
  await ownerDetail.waitFor({ state: "detached" });
  await page.locator("#attention-list fieldset").waitFor({ state: "detached" });
  await captured.promise;
  assert.equal(await page.locator("#attention-list > li").count(), 0, "old owner details clear while the authorized replacement queue is loading");
  const delivered = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/access-requests"));
  held.resolve(); await delivered;
  await row.waitFor();
  assert.equal(await page.locator("#attention-list > li").count(), 1);
  assert.equal(await row.getAttribute("data-access-request-id"), request.requestId);
  assert.equal(await row.locator(".attention-kind").textContent(), "Permission request");
  assert.equal(await ownerDetail.count(), 0, "an active ex-owner admin receives no owner-only work reminder");
  assert.equal(await page.locator("#attention-list fieldset").count(), 0, "the previous owner's unsent partial editor does not survive");
  assert.equal(f.pending().length, 1, "ownership transition never submits the partial approval");
  assert.deepEqual(f.permissions("requester"), []);
});

test("stream-driven request refresh preserves action focus but never takes it back from the composer", { timeout: 60000 }, async t => {
  const f = await setup(t);
  f.access.requestForMember(f.keys.requester, "commons", {
    permissions: ["accept_work", "complete_work"], requestId: "focus-browser-request" });
  const page = await f.login("owner"), row = attentionRow(page);
  await row.waitFor();
  const isQueue = response => response.request().method() === "GET"
    && new URL(response.url()).pathname === "/api/rooms/commons/access-requests";
  const refreshDone = () => page.waitForFunction(() => !document.querySelector("#attention-refresh").disabled);
  const unrelatedMessage = body => f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(),
    type: T.MESSAGE_POSTED, data: { body } });
  let decisions = 0;
  page.on("request", request => {
    if (request.method() === "POST" && /\/access-requests\/[^/]+\/decide$/.test(new URL(request.url()).pathname)) decisions++;
  });
  for (const label of ["Approve", "Decline", "Approve partial"]) {
    const action = row.getByRole("button", { name: label, exact: true });
    await action.focus();
    const refreshed = page.waitForResponse(isQueue);
    unrelatedMessage(`Unrelated activity while focused on ${label}`);
    await (await refreshed).finished();
    await refreshDone();
    assert.equal(await action.evaluate(node => node === document.activeElement), true,
      `${label} keeps keyboard focus on the same request after refresh`);
  }
  const held = f.hold(), captured = deferred();
  await page.route("**/api/rooms/commons/access-requests?status=pending", async route => {
    const response = await route.fetch();
    captured.resolve();
    await held.promise;
    await route.fulfill({ response });
  });
  await row.getByRole("button", { name: "Approve", exact: true }).focus();
  unrelatedMessage("The reader moves away during a pending refresh");
  await captured.promise;
  const composer = page.locator("#message-input");
  await composer.focus();
  const delivered = page.waitForResponse(isQueue);
  held.resolve(); await (await delivered).finished();
  await refreshDone();
  assert.equal(await composer.evaluate(node => node === document.activeElement), true,
    "a completed refresh does not steal focus after the reader moves elsewhere");
  assert.equal(decisions, 0, "focusing and refreshing never submits a decision");
  assert.equal(f.pending().length, 1);
});
