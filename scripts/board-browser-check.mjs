// Tasks › Board: claim actions, linked work and return journeys, 390px, and axe.
// The room page and the work-claim HTTP API are the boundary. No test doubles.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { signInFixture } from "./auth-signin.mjs";
import { clickChrome, openSearch } from "./room-chrome.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

async function openBoard(page) {
  await page.keyboard.press("Control+k");
  await page.locator("#room-actions-query").fill("board");
  await page.locator('[data-room-action="board"]').press("Enter");
  await page.locator("#board-dialog").waitFor({ state: "visible" });
}

const shots = process.env.ROOM_TEST_SCREENSHOT_DIR || "test-results/board";

function github() {
  const body = JSON.stringify({ sha: "c".repeat(40) });
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => body,
    json: async () => JSON.parse(body)
  });
}

async function post(page, origin, path, data, status = 200) {
  const session = await page.request.get(`${origin}/api/session`);
  assert.equal(session.ok(), true);
  const { csrf } = await session.json();
  const response = await page.request.post(`${origin}/api/rooms/commons${path}`, {
    headers: { Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": csrf },
    data
  });
  assert.equal(response.status(), status, await response.text());
}

// Each caller owns all routes on its page. Always open its gates before
// removing interception; the cleanup must retain the original test failure.
async function drainBoardRoutes(page, ...releases) {
  for (const release of releases) release.resolve();
  await page.unrouteAll({ behavior: "wait" });
}

// Authoring gate: a real Playwright callback must finish before fixture cleanup
// returns, including after an assertion fails. Existing happy-path journeys
// release their responses before cleanup and cannot establish this ordering.
// This uses a real local HTTP response, with no product export or fetch double.
test("Board route cleanup drains a held callback and preserves the original failure", { timeout: 20000 }, async t => {
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(request.url === "/held" ? "held response" : "fixture");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin);
  const arrived = Promise.withResolvers(), release = Promise.withResolvers();
  const resumed = Promise.withResolvers(), finish = Promise.withResolvers();
  let callbackFinished = false, cleanupFinished = false;
  await page.route(`${origin}/held`, async route => {
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    arrived.resolve();
    await release.promise;
    resumed.resolve();
    await finish.promise;
    await route.fulfill({ response });
    callbackFinished = true;
  });
  await page.evaluate(() => {
    window.heldResponse = fetch("/held").then(response => response.text());
  });
  await arrived.promise;
  const sentinel = new Error("original Board assertion failure");
  const journey = (async () => {
    try {
      throw sentinel;
    } finally {
      await drainBoardRoutes(page, release);
      cleanupFinished = true;
    }
  })();
  // Observe rather than discard the rejection so the identical original error
  // can be asserted after cleanup, without an unhandled rejection in this test.
  const outcome = journey.then(() => ({ fulfilled: true }), error => ({ error }));
  try {
    await resumed.promise;
    // A same-page protocol/HTTP round trip orders this check after cleanup
    // started, while the first callback remains explicitly held by finish.
    assert.equal(await page.evaluate(() => fetch("/probe").then(response => response.text())), "fixture");
    assert.equal(callbackFinished, false);
    assert.equal(cleanupFinished, false, "cleanup must remain pending until the held callback ends");
  } finally {
    finish.resolve();
    await outcome;
  }
  assert.equal(await page.evaluate(() => window.heldResponse), "held response");
  assert.equal(callbackFinished, true);
  assert.equal(cleanupFinished, true);
  assert.equal((await outcome).error, sentinel, "cleanup preserves the original assertion failure");
});

async function axe(page) {
  const result = await new AxeBuilder({ page })
    .include("#board-dialog")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const serious = result.violations.filter(item => item.impact === "serious" || item.impact === "critical");
  assert.deepEqual(serious.map(item => `${item.impact} ${item.id}`), []);
}

test("board columns, keyboard claim, linked work returns, chat line, 390px, and axe", { timeout: 120000 }, async t => {
  mkdirSync(shots, { recursive: true });
  mkdirSync("test-results", { recursive: true });
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store, streamInterval: 40, fetchPullRequest: github() });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const errors = [];
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
    rmSync(fixture.directory, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  await signInFixture(page, fixture.keys.owner);
  await page.locator("#main").waitFor({ state: "visible" });
  await openBoard(page);
  await page.locator("#board-dialog").waitFor({ state: "visible" });
  await page.locator(".board-empty").waitFor();
  assert.equal(await page.locator(".board-empty").innerText(), "Claim work here so people and agents don't collide.");
  assert.equal(await page.locator("#board-new-item").count(), 1);
  assert.match(await page.locator(".live-chip").innerText(), /Deploy status unknown|Live matches main|Live differs from main|Live is behind main/);
  await page.locator("#board-new-item [name=title]").fill("Fix login copy");
  await page.locator("#board-new-item [name=files]").fill("src/board-ui.js");
  await page.locator("#board-new-item button[type=submit]").click();
  await page.locator("article h4", { hasText: "Fix login copy" }).waitFor();
  assert.equal(await page.locator("#board-status").innerText(), "Opened 'Fix login copy'");
  assert.equal(await page.evaluate(() => document.activeElement?.closest("article")?.querySelector("h4")?.textContent), "Fix login copy");
  await page.screenshot({ path: `${shots}/board-before.png` });
  await page.screenshot({ path: "test-results/board-before.png" });
  await page.locator("#board-close").click();

  await post(page, origin, "/work-claims", { id: "notes", title: "Write the notes" }, 201);
  await post(page, origin, "/work-claims", {
    id: "copy", title: "Write the copy", files: ["src/board-ui.js", "src/board.css", "docs/WORK-CLAIMS.md"]
  }, 201);
  await post(page, origin, "/work-claims/copy/claim", {});
  await post(page, origin, "/work-claims", {
    id: "reviewpr", title: "Review the pull", pullRequest: "https://github.com/Uuriko/project-room/pull/1303"
  }, 201);
  await post(page, origin, "/work-claims/reviewpr/claim", {});
  await post(page, origin, "/work-claims", { id: "stuck", title: "Stuck on a check" }, 201);
  await post(page, origin, "/work-claims/stuck/claim", {});
  await post(page, origin, "/work-claims/stuck/update", { state: "blocked" });
  await post(page, origin, "/work-claims", { id: "shipped", title: "Shipped the notes" }, 201);
  await post(page, origin, "/work-claims/shipped/claim", {});
  await post(page, origin, "/work-claims/shipped/update", { state: "in_progress" });
  await post(page, origin, "/work-claims/shipped/update", { state: "done" });
  await post(page, origin, "/work-claims", { id: "waiting", title: "After the copy", dependsOn: ["copy"] }, 201);

  const copyLine = page.locator("[data-claim-update='copy']");
  await copyLine.waitFor();
  assert.equal(await copyLine.count(), 1);
  assert.match(await copyLine.innerText(), /claimed Write the copy · 3 files · lease \d+h/);

  await page.keyboard.press("Control+k");
  await page.locator("#room-actions-query").waitFor();
  await page.locator("#room-actions-query").fill("board");
  await page.locator('[data-room-action="board"]').press("Enter");
  await page.locator("#board-dialog").waitFor({ state: "visible" });
  await page.locator("article[data-claim-id='notes']").waitFor();
  const card = (name, id) => page.locator(`[aria-labelledby='board-col-${name}'] > article[data-claim-id='${id}']`);
  assert.equal(await card("ready", "notes").count(), 1);
  assert.equal(await card("ready", "waiting").count(), 0);
  assert.equal(await card("claimed", "copy").count(), 1);
  assert.equal(await card("blocked", "stuck").count(), 1);
  assert.equal(await card("review", "reviewpr").count(), 1);
  assert.match(await card("review", "reviewpr").innerText(), /PR #1303/);
  assert.equal(await card("landed", "shipped").count(), 1);
  assert.equal(await page.locator("#board-close-stale").count(), 1);

  for (let step = 0; step < 40; step += 1) {
    if (await page.evaluate(() => document.activeElement?.dataset?.claimAction === "claim" && document.activeElement?.dataset?.claimId === "notes")) break;
    await page.keyboard.press("Tab");
  }
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.claimId), "notes");
  await page.keyboard.press("Enter");
  await page.locator("[aria-labelledby='board-col-claimed'] article[data-claim-id='notes']").waitFor();
  assert.equal(await page.locator("[aria-labelledby='board-col-ready'] article[data-claim-id='notes']").count(), 0);
  assert.equal(await page.locator("#board-status").innerText(), "Claimed 'Write the notes'");
  assert.equal(await page.evaluate(() => document.activeElement?.closest("article")?.dataset.claimId), "notes");
  const follow = async (id, action, status) => {
    await page.locator(`article[data-claim-id='${id}'] [data-claim-action='${action}']`).click();
    await page.waitForFunction(expected => document.querySelector("#board-status")?.textContent === expected, status);
    assert.equal(await page.evaluate(claimId => document.activeElement?.closest("article")?.dataset.claimId, id), id);
  };
  await follow("notes", "renew", "Renewed 'Write the notes'");
  await follow("notes", "progress", "Marked 'Write the notes' in progress");
  await follow("notes", "done", "Done 'Write the notes'");
  assert.equal(await page.locator("article[data-claim-id='notes'] .claim-lease").count(), 0);
  await follow("copy", "release", "Released 'Write the copy'");
  await page.screenshot({ path: `${shots}/board-after.png` });
  await page.screenshot({ path: `${shots}/board-1280.png` });
  await page.screenshot({ path: "test-results/board-after.png" });
  await axe(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#board-dialog").waitFor({ state: "visible" });
  assert.equal(await page.locator("#board-dialog").evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
  await page.screenshot({ path: `${shots}/board-after-390.png` });
  await page.screenshot({ path: "test-results/board-after-390.png" });
  await axe(page);

  await page.locator("#board-close").click();
  const workId = "board:canonical", claimId = "board-linked";
  const propose = (id, title) => fixture.store.command(fixture.keys.owner, "commons", {
    id: crypto.randomUUID(), type: "work.proposed",
    data: { workItemId: id, title, definitionOfDone: "Open the existing work without changing it.",
      accountableMemberId: "owner", independentVerificationRequired: false, ownerDecisionRequired: false }
  });
  propose(workId, "Canonical work behind the Board card");
  propose(claimId, "Different work with the claim's ID");
  propose("board-coincidence", "Unlinked work with a coincidentally equal ID");
  const updatedAt = new Date().toISOString();
  // REST creation does not accept workItemId. These persisted legacy rows
  // exercise the real list response, including absent and unresolved links.
  for (const item of [
    { id: claimId, title: "Z linked Board card", workItemId: workId },
    { id: "board-null", title: "Legacy card without a work link", workItemId: null },
    { id: "board-dangling", title: "Legacy card with a missing target", workItemId: "board:missing" },
    { id: "board-coincidence", title: "Legacy card whose ID matches work", workItemId: null },
    ...Array.from({ length: 6 }, (_, index) => ({ id: `board-context-${index}`, title: `Navigation context ${index}` }))
  ]) seedClaim(fixture.store, { state: "unclaimed", updatedAt, ...item });
  // A normal claim event makes the already-open client refresh its Board list.
  await post(page, origin, "/work-claims", { id: "board-refresh", title: "Navigation refresh" }, 201);
  await page.waitForFunction(sequence => document.querySelector("#event-count")?.textContent === String(sequence),
    fixture.store.room("commons").sequence);
  const navigationState = () => {
    const room = fixture.store.room("commons");
    return {
      sequence: room.sequence,
      workItems: structuredClone(room.state.workItems),
      events: fixture.store.db.prepare("SELECT sequence, id, body FROM events WHERE room_id=? ORDER BY sequence").all("commons"),
      claims: fixture.store.db.prepare("SELECT claim_id, item_json, updated_at FROM work_claims WHERE room_id=? ORDER BY claim_id").all("commons")
    };
  };
  const beforeNavigation = navigationState();
  const dialog = page.locator("#board-dialog");
  const linked = page.locator(`article[data-claim-id='${claimId}'] h4 a[data-open-work]`);
  const record = page.locator(`[data-work-record-id='${workId}']`);
  const canonicalHash = `#pr-record/work/${encodeURIComponent(workId)}`;
  const assertWork = async () => {
    await record.waitFor({ state: "visible" });
    await page.waitForFunction(id => document.activeElement?.dataset.workRecordId === id, workId);
    assert.equal(new URL(page.url()).hash, canonicalHash);
    assert.equal(await dialog.evaluate(node => node.open), false, "the Board no longer traps focus over work");
    assert.equal(await record.locator("h3").innerText(), "Canonical work behind the Board card");
    assert.equal(await record.locator(".work-details").evaluate(node => node.open), true);
    assert.equal(await page.locator("#work-navigation-return").innerText(), "Back to Board");
  };
  const assertBoardReturn = async (url, scrollTop) => {
    await dialog.waitFor({ state: "visible" });
    await page.waitForFunction(id => document.activeElement?.closest("article")?.dataset.claimId === id, claimId);
    assert.equal(page.url(), url);
    assert.equal(await linked.evaluate(node => node === document.activeElement), true, "return restores the exact title link");
    assert.ok(Math.abs(await dialog.evaluate(node => node.scrollTop) - scrollTop) <= 1, "return preserves Board scroll");
  };
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.keyboard.press("Control+k");
    await page.locator("#room-actions-query").fill("board");
    await page.locator('[data-room-action="board"]').press("Enter");
    await linked.waitFor({ state: "visible" });
    assert.equal(await linked.getAttribute("href"), canonicalHash);
    assert.equal(await linked.getAttribute("data-open-work"), workId);
    const boardUrl = page.url();
    for (const id of ["board-null", "board-dangling", "board-coincidence"]) {
      const heading = page.locator(`article[data-claim-id='${id}'] h4`);
      assert.equal(await heading.count(), 1);
      assert.equal(await heading.locator("a, [data-open-work]").count(), 0, `${id} is not a fabricated work link`);
      await heading.click();
      assert.equal(page.url(), boardUrl);
      assert.equal(await dialog.evaluate(node => node.open), true);
    }
    await page.locator("#board-close").focus();
    for (let step = 0; step < 100; step += 1) {
      if (await linked.evaluate(node => node === document.activeElement)) break;
      await page.keyboard.press("Tab");
    }
    assert.equal(await linked.evaluate(node => node === document.activeElement), true, `${viewport.width}px title is keyboard reachable`);
    const scrollTop = await dialog.evaluate(node => node.scrollTop);
    assert.ok(scrollTop > 0, "the return journey starts from a scrolled Board");
    await page.keyboard.press("Enter");
    await assertWork();
    await page.locator("#work-navigation-return").focus();
    await page.keyboard.press("Enter");
    await assertBoardReturn(boardUrl, scrollTop);

    await page.keyboard.press("Enter");
    await assertWork();
    await page.goBack();
    await assertBoardReturn(boardUrl, scrollTop);
    await page.goForward();
    await assertWork();
    await page.locator("#work-navigation-return").focus();
    await page.keyboard.press("Enter");
    await assertBoardReturn(boardUrl, scrollTop);
    assert.deepEqual(navigationState(), beforeNavigation, "Board/work navigation changes no Room events, work items, or claim rows");
    assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    await page.screenshot({ path: `test-results/board-work-return-${viewport.width}.png` });
    await axe(page);
    await page.locator("#board-close").click();
  }

  // Same task, new source surface: Search -> task A -> Board -> task A.
  // The Board must close and become the return destination without pushing A twice.
  await page.setViewportSize({ width: 1280, height: 800 });
  await openSearch(page);
  await page.locator("#message-search").fill("Canonical work behind the Board card");
  await page.locator(`#search-list [data-open-work="${workId}"]`).press("Enter");
  await page.waitForFunction(id => document.activeElement?.dataset.workRecordId === id, workId);
  assert.equal(await page.locator("#work-navigation-return").innerText(), "Back to conversation");
  const sameTargetHistoryLength = await page.evaluate(() => history.length);
  await page.keyboard.press("Control+k");
  await page.locator("#room-actions-query").fill("board");
  await page.locator('[data-room-action="board"]').press("Enter");
  await linked.press("Enter");
  await assertWork();
  assert.equal(await page.evaluate(() => history.length), sameTargetHistoryLength);
  await page.locator("#work-navigation-return").press("Enter");
  await dialog.waitFor({ state: "visible" });
  await page.waitForFunction(id => document.activeElement?.closest("article")?.dataset.claimId === id, claimId);
  assert.equal(await linked.evaluate(node => node === document.activeElement), true);
  assert.deepEqual(navigationState(), beforeNavigation);

  // A delayed Back return belongs to one opening of the dialog. Closing or
  // cancelling it must not let that return steal focus from a later opening.
  for (const dismiss of ["Close", "Escape"]) {
    await linked.focus();
    const abandonedScroll = await dialog.evaluate(node => node.scrollTop);
    assert.ok(abandonedScroll > 0, `${dismiss}: the abandoned origin is scrolled`);
    await linked.press("Enter");
    await assertWork();
    const refreshId = `board-delayed-${dismiss.toLowerCase()}`;
    await post(page, origin, "/work-claims", { id: refreshId, title: `A delayed Board refresh after ${dismiss}` }, 201);
    await page.waitForFunction(sequence => document.querySelector("#event-count")?.textContent === String(sequence),
      fixture.store.room("commons").sequence);
    const beforeDelayedReturn = navigationState();
    const arrived = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    const listPattern = "**/api/rooms/commons/work-claims?*";
    let captured = null;
    const holdList = async route => {
      if (captured || route.request().method() !== "GET") return route.continue();
      captured = route.request();
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      arrived.resolve();
      await release.promise;
      await route.fulfill({ response });
    };
    await page.route(listPattern, holdList);
    try {
      await page.goBack();
      await arrived.promise;
      await dialog.waitFor({ state: "visible" });
      assert.equal(await page.locator(`article[data-claim-id='${refreshId}']`).count(), 0, "the actual list response is still held");
      if (dismiss === "Close") await page.locator("#board-close").click();
      else await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      await openBoard(page);
      await dialog.waitFor({ state: "visible" });
      await page.locator("#board-close").focus();
      const reopenedUrl = page.url();
      const reopenedScroll = await dialog.evaluate(node => node.scrollTop);
      assert.ok(Math.abs(reopenedScroll - abandonedScroll) > 1, `${dismiss}: the new opening has its own scroll position`);
      const delivered = page.waitForResponse(response => response.request() === captured);
      release.resolve();
      await (await delivered).finished();
      // This new, persisted claim proves the unmodified held response painted.
      // Give its promise continuations a rendered frame before checking focus.
      await page.locator(`article[data-claim-id='${refreshId}']`).waitFor({ state: "attached" });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      assert.equal(await dialog.evaluate(node => node.open), true);
      assert.equal(page.url(), reopenedUrl);
      assert.equal(await page.evaluate(() => document.activeElement?.id), "board-close", `${dismiss}: an abandoned return cannot steal the new opening's focus`);
      assert.ok(Math.abs(await dialog.evaluate(node => node.scrollTop) - reopenedScroll) <= 1, `${dismiss}: an abandoned return cannot restore its old scroll`);
      assert.deepEqual(navigationState(), beforeDelayedReturn, `${dismiss}: returning and reopening change no Room state`);
    } finally {
      await drainBoardRoutes(page, release);
    }
  }

  // A persisted origin may disappear while its canonical work is open.
  // The durable registry is also used by land-queue removal; there is no
  // standalone claim DELETE route. A real HTTP claim event refreshes the UI.
  const removedOriginUrl = page.url();
  await linked.press("Enter");
  await assertWork();
  fixture.store.workClaims.delete("commons", claimId);
  await post(page, origin, "/work-claims/board-refresh/claim", {});
  await page.waitForFunction(sequence => document.querySelector("#event-count")?.textContent === String(sequence),
    fixture.store.room("commons").sequence);
  await assertWork();
  const missingClaim = await page.request.get(`${origin}/api/rooms/commons/work-claims/${claimId}`);
  assert.equal(missingClaim.status(), 404, "the origin is absent from the public claim API");
  const afterOriginRemoval = navigationState();
  assert.deepEqual(afterOriginRemoval.workItems, beforeNavigation.workItems, "removing the claim leaves canonical work intact");
  const assertRemovedOriginReturn = async () => {
    await dialog.waitFor({ state: "visible" });
    // The lazy Board refreshes when reopened. Wait for actual detachment,
    // not merely a hidden dialog, before checking the final fallback focus.
    await page.locator(`article[data-claim-id='${claimId}']`).waitFor({ state: "detached" });
    await page.waitForFunction(() => document.activeElement?.id === "board-close");
    assert.equal(page.url(), removedOriginUrl);
    assert.equal(await page.locator("#board-close").isVisible(), true, "the missing origin falls back to the Board close control");
    assert.equal(await page.locator("#board-close").evaluate(node => {
      const box = node.getBoundingClientRect(), board = node.closest("dialog");
      const bounds = board.getBoundingClientRect();
      const top = Math.max(0, bounds.top + board.clientTop);
      const left = Math.max(0, bounds.left + board.clientLeft);
      const bottom = Math.min(innerHeight, bounds.top + board.clientTop + board.clientHeight);
      const right = Math.min(innerWidth, bounds.left + board.clientLeft + board.clientWidth);
      return box.width > 0 && box.height > 0 && box.top >= top - 1 && box.left >= left - 1
        && box.bottom <= bottom + 1 && box.right <= right + 1;
    }), true, "fallback focus is fully visible inside the Board viewport");
    assert.equal(await page.locator(`article[data-claim-id='${claimId}']`).count(), 0, "return does not recreate the removed card");
    assert.deepEqual(navigationState(), afterOriginRemoval, "removed-origin return creates no work, events, or claim rows");
  };
  await page.locator("#work-navigation-return").press("Enter");
  await assertRemovedOriginReturn();
  await page.goForward();
  await assertWork();
  await page.goBack();
  await assertRemovedOriginReturn();
});

function seedClaim(store, item) {
  store.workClaims.set("commons", {
    files: [], dependsOn: [], reviews: [], tags: [], blobs: [], attestations: [],
    owner: null, history: [{ at: item.updatedAt, agentId: "owner", action: "created", note: null }],
    ...item
  });
}

// Rendering, dependency navigation and readiness are the UI boundary here.
// The projection matrix separately owns classification/old-completion filtering.
// Quarantined flakes (tests/quarantine.json): both browser tests below fail
// intermittently on green main. They run in the non-blocking lane
// (`npm run test:quarantined`, QUARANTINE_RUN=1).
const QUARANTINED_BOARD_FLAKES = process.env.QUARANTINE_RUN !== "1";
test("waiting prerequisites stay visible, link by keyboard, and become claimable only when ready", { timeout: 120000, skip: QUARANTINED_BOARD_FLAKES ? "quarantined: tests/quarantine.json (browser timing flake; repair by 2026-10-20)" : false }, async t => {
  mkdirSync("test-results", { recursive: true });
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store, streamInterval: 40, fetchPullRequest: github() });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const errors = [];
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
    rmSync(fixture.directory, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  const workId = "waiting:prerequisite", missingId = `unavailable-${"prerequisite-".repeat(7)}`;
  fixture.store.command(fixture.keys.owner, "commons", {
    id: crypto.randomUUID(), type: "work.proposed",
    data: { workItemId: workId, title: "Prepare the handoff", definitionOfDone: "Record the prerequisite result.",
      accountableMemberId: "owner", independentVerificationRequired: false, ownerDecisionRequired: false }
  });
  const updatedAt = new Date().toISOString();
  // Mirrored/legacy claim links are persisted through the existing registry;
  // the browser still consumes the real HTTP list response and navigation.
  for (const item of [
    { id: "prerequisite", title: "Prepare the handoff", workItemId: workId },
    { id: "dependent", title: "Continue after the handoff", dependsOn: ["old-completion", "prerequisite"],
      chain: [{ kind: "handoff", targetId: "prerequisite", at: updatedAt, actorId: "owner" }] },
    { id: "unknown", title: "Find the missing prerequisite", dependsOn: [missingId] },
    { id: "available", title: "Unrelated ready task" },
    { id: "old-completion", title: "Earlier completed prerequisite", state: "done", owner: "owner",
      updatedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() }
  ]) seedClaim(fixture.store, { state: "unclaimed", updatedAt, ...item });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  await signInFixture(page, fixture.keys.owner);
  await page.locator("#main").waitFor({ state: "visible" });
  const snapshot = () => ({
    sequence: fixture.store.room("commons").sequence,
    workItems: structuredClone(fixture.store.room("commons").state.workItems),
    claims: fixture.store.db.prepare("SELECT claim_id, item_json, updated_at FROM work_claims WHERE room_id=? ORDER BY claim_id").all("commons")
  });
  const beforeNavigation = snapshot();
  const dialog = page.locator("#board-dialog");
  const openBoard = async () => {
    await page.keyboard.press("Control+k");
    await page.locator("#room-actions-query").waitFor({ state: "visible" });
    await page.locator("#room-actions-query").fill("board");
    await page.locator('[data-room-action="board"]').press("Enter");
    await dialog.waitFor({ state: "visible" });
  };
  const dependent = page.locator("article[data-claim-id='dependent']");
  const unknown = page.locator("article[data-claim-id='unknown']");
  const link = dependent.locator(".claim-deps [data-open-work]");
  const boardIds = () => page.locator("#work-board article").evaluateAll(nodes => nodes.map(node => node.dataset.claimId).sort());
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    await openBoard();
    await dependent.waitFor({ state: "visible" });
    assert.equal(await dependent.evaluate(node => node.parentElement.getAttribute("aria-labelledby")), "board-col-blocked");
    assert.equal(await page.locator("#board-col-blocked").innerText(), "Blocked · 2 waiting");
    assert.match(await dependent.innerText(), /Waiting for 1 prerequisite before claiming/);
    assert.match(await dependent.innerText(), /Earlier completed prerequisite.*Completed/);
    assert.match(await dependent.innerText(), /Prepare the handoff.*Unclaimed; needs an owner/);
    assert.equal(await dependent.locator("[data-claim-action='claim']").count(), 0);
    assert.match(await unknown.innerText(), /Not loaded or unavailable; status unknown/);
    assert.equal(await unknown.locator("a, [data-claim-action='claim']").count(), 0);
    assert.deepEqual(await boardIds(), ["available", "dependent", "prerequisite", "unknown"]);
    assert.equal(await link.getAttribute("href"), `#pr-record/work/${encodeURIComponent(workId)}`);
    assert.equal(await dependent.locator(".claim-chain [data-open-work]").getAttribute("href"), await link.getAttribute("href"));
    await page.locator("#board-close").focus();
    for (let step = 0; step < 80; step += 1) {
      if (await link.evaluate(node => node === document.activeElement)) break;
      await page.keyboard.press("Tab");
    }
    assert.equal(await link.evaluate(node => node === document.activeElement), true, `${width}px prerequisite is keyboard reachable`);
    const scrollTop = await dialog.evaluate(node => node.scrollTop);
    await page.keyboard.press("Enter");
    await page.locator(`[data-work-record-id='${workId}']`).waitFor({ state: "visible" });
    assert.equal(await dialog.evaluate(node => node.open), false);
    await page.locator("#work-navigation-return").press("Enter");
    await dialog.waitFor({ state: "visible" });
    await page.waitForFunction(() => document.activeElement?.dataset.focusKey === "claim-dependency:dependent:1");
    assert.ok(Math.abs(await dialog.evaluate(node => node.scrollTop) - scrollTop) <= 1);

    // Same claim and target, different control: preserve the most recent
    // dependency/chain link and Board scroll without another history entry.
    await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "hidden" });
    const targetUrl = page.url();
    const historyLength = await page.evaluate(() => history.length);
    await openBoard();
    await dialog.waitFor({ state: "visible" });
    const chainLink = dependent.locator(".claim-chain [data-open-work]");
    await chainLink.focus();
    const latestScroll = await dialog.evaluate(node => {
      const maximum = node.scrollHeight - node.clientHeight;
      node.scrollTop = node.scrollTop > maximum / 2 ? 0 : maximum;
      return node.scrollTop;
    });
    await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(page.url(), targetUrl);
    assert.equal(await page.evaluate(() => history.length), historyLength);
    await page.locator("#work-navigation-return").press("Enter");
    await dialog.waitFor({ state: "visible" });
    await page.waitForFunction(() => document.activeElement?.dataset.focusKey === "claim-chain:dependent:0");
    assert.ok(Math.abs(await dialog.evaluate(node => node.scrollTop) - latestScroll) <= 1, "same-target return keeps the latest Board scroll");
    assert.deepEqual(snapshot(), beforeNavigation, "reading and following prerequisites writes no work, claim or Room event");
    assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
    await dependent.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/board-waiting-${width}.png` });
    await axe(page);
    await page.locator("#board-close").click();
  }
  await openBoard();
  await post(page, origin, "/work-claims/prerequisite/claim", {});
  await post(page, origin, "/work-claims/prerequisite/update", { state: "in_progress" });
  await post(page, origin, "/work-claims/prerequisite/update", { state: "done" });
  await page.locator("[aria-labelledby='board-col-ready'] article[data-claim-id='dependent']").waitFor();
  assert.equal(await dependent.locator(".claim-waiting").count(), 0);
  assert.equal(await page.locator("#board-col-blocked").innerText(), "Blocked · 1 waiting");
  assert.deepEqual(await boardIds(), ["available", "dependent", "prerequisite", "unknown"]);
  // Authoring gate: an enabled keyboard action must survive a concurrent
  // background refresh. The existing happy path never forces this ordering.
  // Hold real HTTP responses, without replacing their status/body or adding
  // production seams. The old shared busy flag loses this Claim entirely.
  const listPattern = "**/api/rooms/commons/work-claims?*";
  const claimPattern = "**/api/rooms/commons/work-claims/dependent/claim";
  const readArrived = Promise.withResolvers(), releaseRead = Promise.withResolvers();
  const actionArrived = Promise.withResolvers(), releaseAction = Promise.withResolvers();
  const reconcileArrived = Promise.withResolvers(), releaseReconcile = Promise.withResolvers();
  let heldRead = null, holdReconcile = false, heldReconcile = false;
  const posts = [], responses = [];
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/work-claims/dependent/claim")) {
      posts.push({ method: request.method(), path: new URL(request.url()).pathname });
    }
  });
  page.on("response", response => {
    if (response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/work-claims/dependent/claim")) {
      responses.push({ status: response.status() });
    }
  });
  const holdRead = async route => {
    if (heldRead) {
      if (!holdReconcile || heldReconcile) { await route.continue(); return; }
      heldReconcile = true;
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      reconcileArrived.resolve();
      await releaseReconcile.promise;
      await route.fulfill({ response });
      return;
    }
    heldRead = route.request();
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    const body = await response.json();
    assert.equal(body.claims.find(item => item.id === "dependent").owner, null, "held data predates the claim");
    readArrived.resolve();
    await releaseRead.promise;
    await route.fulfill({ response });
  };
  const holdAction = async route => {
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    actionArrived.resolve();
    await releaseAction.promise;
    await route.fulfill({ response });
  };
  await page.route(listPattern, holdRead);
  await page.route(claimPattern, holdAction);
  let keyboardTarget = null;
  try {
    await post(page, origin, "/work-claims", { id: "refresh-race", title: "Trigger a real background refresh" }, 201);
    await readArrived.promise;
    const claim = dependent.locator("[data-claim-action='claim']");
    assert.equal(await claim.isEnabled(), true);
    await claim.focus();
    keyboardTarget = await page.evaluate(() => ({
      tag: document.activeElement?.tagName, action: document.activeElement?.dataset.claimAction,
      claimId: document.activeElement?.dataset.claimId, focusKey: document.activeElement?.dataset.focusKey
    }));
    assert.equal(keyboardTarget.action, "claim");
    assert.equal(keyboardTarget.claimId, "dependent");
    // Register before Enter: the pending read cannot make this enabled action
    // vanish. A timeout here records the actual keyboard target and zero POSTs.
    const accepted = page.waitForRequest(request => request.method() === "POST"
      && new URL(request.url()).pathname.endsWith("/work-claims/dependent/claim"));
    await page.keyboard.press("Enter");
    await accepted;
    await actionArrived.promise;
    assert.equal(fixture.store.workClaims.get("commons", "dependent").owner, "owner");
    // The first write is persisted but its response is still held. Repeated
    // activation must not send a second mutation from the unchanged control.
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    holdReconcile = true;
    releaseAction.resolve();
    await reconcileArrived.promise;
    await page.keyboard.press("Enter");
    releaseReconcile.resolve();
    await page.locator("[aria-labelledby='board-col-claimed'] article[data-claim-id='dependent']").waitFor();
    assert.equal(await page.locator("#board-status").innerText(), "Claimed 'Continue after the handoff'");
    assert.equal(await page.evaluate(() => document.activeElement?.closest("article")?.dataset.claimId), "dependent");
    await page.locator("#board-close").focus();
    const settled = page.waitForResponse(response => response.request() === heldRead);
    releaseRead.resolve();
    await (await settled).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.equal(await page.locator("[aria-labelledby='board-col-claimed'] article[data-claim-id='dependent']").count(), 1,
      "the older list cannot repaint the just-claimed card as Ready");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "board-close", "stale reads cannot retake keyboard focus");
    assert.equal(posts.length, 1, "repeated Enter while the mutation is in flight sends exactly one POST");
    assert.deepEqual(responses, [{ status: 200 }]);
    assert.equal(fixture.store.workClaims.get("commons", "dependent").history.filter(item => item.action === "claimed").length, 1);
    assert.equal(fixture.store.workClaims.get("commons", "unknown").owner, null);
    assert.equal(await unknown.locator("[data-claim-action='claim']").count(), 0);
    await page.screenshot({ path: "test-results/board-refresh-action.png" });
  } catch (error) {
    const diagnostic = { keyboardTarget, posts, responses,
      active: await page.evaluate(() => ({ id: document.activeElement?.id, tag: document.activeElement?.tagName,
        action: document.activeElement?.dataset.claimAction, claimId: document.activeElement?.dataset.claimId })),
      notice: await page.locator("#board-status").textContent(),
      persisted: fixture.store.workClaims.get("commons", "dependent") };
    writeFileSync("test-results/board-refresh-action-diagnostic.json", JSON.stringify(diagnostic, null, 2));
    console.error("Board Claim diagnostic:", JSON.stringify(diagnostic));
    throw error;
  } finally {
    await drainBoardRoutes(page, releaseRead, releaseAction, releaseReconcile);
  }
});

// Authoring gate: the real browser owns form availability, approval copy and
// submit/readback lifecycle. Core/route tests own append preservation and CAS;
// these checks add no render-only exports or fabricated successful responses.
test("owners link a draft PR, reconcile held responses, and refresh a changed claim without resending", { timeout: 120000, skip: QUARANTINED_BOARD_FLAKES ? "quarantined: tests/quarantine.json (browser timing flake; repair by 2026-10-20)" : false }, async t => {
  mkdirSync("test-results", { recursive: true });
  const fixture = createAcceptanceFixture();
  fixture.store.command(fixture.keys.owner, "commons", {
    id: crypto.randomUUID(), type: "member.added",
    data: { memberId: "pr-reviewer", displayName: "PR reviewer", kind: "human", permissions: ["verify"] }
  });
  const reviewerKey = fixture.store.issueAccessKey("commons", "pr-reviewer");
  const server = createRoomServer({ store: fixture.store, streamInterval: 40, fetchPullRequest: github() });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  await signInFixture(page, fixture.keys.owner);
  await page.locator("#main").waitFor({ state: "visible" });
  await post(page, origin, "/work-claims", { id: "link-draft", title: "Attach the draft", files: ["draft.js"] }, 201);
  await post(page, origin, "/work-claims/link-draft/claim", {});
  await post(page, origin, "/work-claims/link-draft/update", { state: "in_progress" });
  const reviewed = await fetch(`${origin}/api/rooms/commons/work-claims/link-draft/review`, {
    method: "POST", headers: { Authorization: `Bearer ${reviewerKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ verdict: "approve", summary: "Checked the current work" })
  });
  assert.equal(reviewed.status, 200, await reviewed.text());
  const before = fixture.store.workClaims.get("commons", "link-draft");
  // Registry fixtures represent persisted cards that have no public creation
  // field for supersession. They exercise only permission/rendering decisions.
  const updatedAt = new Date().toISOString();
  for (const item of [
    { id: "link-foreign", owner: "pr-reviewer", state: "claimed" },
    { id: "link-ready", owner: null, state: "unclaimed" },
    { id: "link-done", owner: "owner", state: "done" },
    { id: "link-superseded", owner: "owner", state: "blocked", supersededBy: "replacement" },
    { id: "link-expired", owner: "owner", state: "claimed", leaseExpiresAt: new Date(Date.now() - 60000).toISOString() },
    { id: "link-blocked", owner: "owner", state: "blocked" }
  ]) seedClaim(fixture.store, { title: item.id, updatedAt, claimedAt: updatedAt, leaseExpiresAt: new Date(Date.now() + 3600000).toISOString(), ...item });
  // Human chrome keeps the technical board out of the sidebar by default;
  // the actual command finder remains an explicit way to open it.
  await page.keyboard.press("Control+k");
  await page.locator("#room-actions-query").fill("board");
  await page.locator('[data-room-action="board"]').press("Enter");
  await page.locator("#board-dialog").waitFor({ state: "visible" });
  const card = page.locator("article[data-claim-id='link-draft']");
  const form = card.locator("[data-claim-link-pr]");
  const input = form.locator("input");
  await input.waitFor({ state: "visible" });
  assert.equal(await card.locator(".claim-reviews").innerText(), "PR reviewer approve");
  for (const id of ["link-foreign", "link-ready", "link-done", "link-superseded", "link-expired"]) {
    assert.equal(await page.locator(`article[data-claim-id='${id}'] [data-claim-link-pr]`).count(), 0, `${id} cannot append`);
  }
  assert.equal(await page.locator("article[data-claim-id='link-blocked'] [data-claim-link-pr]").count(), 1);
  const pullRequest = "https://github.com/Uuriko/project-room/pull/1303";
  const pattern = "**/api/rooms/commons/work-claims/link-draft/update";
  const listPattern = "**/api/rooms/commons/work-claims?*";
  const arrived = Promise.withResolvers(), release = Promise.withResolvers();
  const readArrived = Promise.withResolvers(), releaseRead = Promise.withResolvers();
  const requests = [];
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/work-claims/link-draft/update")) requests.push(request.postDataJSON());
  });
  const holdWrite = async route => {
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    arrived.resolve();
    await release.promise;
    await route.fulfill({ response });
  };
  let capturedRead = false;
  const holdRead = async route => {
    if (capturedRead) return route.continue();
    capturedRead = true;
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    readArrived.resolve();
    await releaseRead.promise;
    await route.fulfill({ response });
  };
  await page.route(pattern, holdWrite);
  try {
    await input.fill(pullRequest);
    await input.press("Enter");
    await arrived.promise;
    assert.equal(await form.getAttribute("aria-busy"), "true");
    assert.match(await page.locator("#board-status").innerText(), /Linking PR/);
    assert.equal(await form.locator("button").isDisabled(), true);
    await input.press("Enter");
    await input.press("Enter");
    await page.route(listPattern, holdRead);
    release.resolve();
    await readArrived.promise;
    assert.equal(await card.locator(".claim-pr").count(), 0, "a persisted write stays pending until readback");
    await input.press("Enter");
    releaseRead.resolve();
    await page.waitForFunction(() => document.querySelector("#board-status")?.textContent === "PR linked to 'Attach the draft'");
    assert.equal(await card.evaluate(node => node.parentElement.getAttribute("aria-labelledby")), "board-col-review");
    assert.equal(await card.locator(".claim-pr a").getAttribute("href"), pullRequest);
    assert.match(await card.locator(".claim-reviews").innerText(), /previous approval.*does not qualify for current work/);
    // Query the current input and active element in one browser turn: SSE
    // refresh may replace an element handle while restoring focus correctly.
    assert.equal(await page.evaluate(() => document.querySelector("article[data-claim-id='link-draft'] [data-claim-link-pr] input") === document.activeElement), true);
    assert.deepEqual(requests, [{ appendPullRequest: pullRequest, expectedClaimedAt: before.claimedAt, expectedHistoryLength: before.history.length }]);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
      await card.scrollIntoViewIfNeeded();
      assert.equal(await page.locator("#board-dialog").evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      await page.screenshot({ path: `test-results/board-link-pr-${width}.png` });
      await axe(page);
    }
  } finally {
    await drainBoardRoutes(page, release, releaseRead);
  }

  // Keep the old form visible while a real release/reclaim changes its round.
  // A 409 must refresh the card and explain the change, never resend the URL.
  const refreshArrived = Promise.withResolvers(), refreshRelease = Promise.withResolvers();
  let heldRefresh = null;
  const holdRefresh = async route => {
    if (heldRefresh) return route.continue();
    heldRefresh = route.request();
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    refreshArrived.resolve();
    await refreshRelease.promise;
    await route.fulfill({ response });
  };
  await page.route(listPattern, holdRefresh);
  try {
    // E5/D4 (QA-200 2026-10-08): /release binds the claim round — send the
    // round the script read, like the board UI does.
    const held = fixture.store.workClaims.get("commons", "link-draft");
    await post(page, origin, "/work-claims/link-draft/release", {
      expectedClaimedAt: held.claimedAt,
      expectedHistoryLength: held.history.length + (held.historyOmitted ?? 0) });
    await refreshArrived.promise;
    await post(page, origin, "/work-claims/link-draft/claim", {});
    const newRound = fixture.store.workClaims.get("commons", "link-draft");
    assert.notEqual(newRound.claimedAt, before.claimedAt);
    const secondPull = "https://github.com/Uuriko/project-room/pull/1304";
    await input.fill(secondPull);
    const rejected = page.waitForResponse(response => response.request().method() === "POST"
      && new URL(response.url()).pathname.endsWith("/work-claims/link-draft/update"));
    await input.press("Enter");
    assert.equal((await rejected).status(), 409);
    await page.waitForFunction(() => document.querySelector("#board-status")?.textContent.startsWith("Claim changed. The board is refreshed"));
    await page.waitForFunction(() => document.querySelector("article[data-claim-id='link-draft'] [data-claim-link-pr] input") === document.activeElement);
    // A locator handle can retire between resolution and evaluation during
    // an SSE paint. The current visible control must retain actual focus.
    assert.equal(await page.evaluate(() => document.querySelector("article[data-claim-id='link-draft'] [data-claim-link-pr] input") === document.activeElement), true);
    await page.locator("#board-close").focus();
    const delivered = page.waitForResponse(response => response.request() === heldRefresh);
    refreshRelease.resolve();
    await (await delivered).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.equal(await page.evaluate(() => document.activeElement?.id), "board-close", "retired refresh cannot steal focus");
    assert.equal(requests.length, 2, "a changed claim round does not trigger an automatic retry");
    assert.equal(fixture.store.workClaims.get("commons", "link-draft").pullRequests.some(pull => pull.url === secondPull), false);
    assert.equal(await form.count(), 1, "the retired unclaimed response cannot replace the fresh held claim");
  } finally {
    await drainBoardRoutes(page, refreshRelease);
  }
});

// Authoring gate: lifecycle ownership of real Board HTTP continuations.
// A late page must not carry its cursor into a new room, and a late mutation
// must not repaint, refocus or refresh after its room/session has retired.
// Existing navigation tests own return tickets, not these Board continuations.
// All payloads and writes below pass through the actual fixture HTTP server.
test("held Board reads and mutations retire on room switch and sign-out", { timeout: 120000 }, async t => {
  const fixture = createAcceptanceFixture();
  const accountId = "board-lifecycle-account", memberId = "board-reader";
  fixture.store.command(fixture.keys.owner, "commons", {
    id: crypto.randomUUID(), type: "member.added",
    data: { memberId, displayName: "Board reader", kind: "human", permissions: ["accept_work", "complete_work"] }
  });
  fixture.store.createAccount(accountId); fixture.store.completeOnboarding(accountId);
  fixture.store.bindHumanAccount("commons", memberId, accountId);
  fixture.store.initialize(initialRoom("board-other", memberId));
  fixture.store.bindHumanAccount("board-other", memberId, accountId);
  const accountKey = fixture.store.issueAccountAccessKey(accountId);
  const memberKey = fixture.store.issueAccessKey("commons", memberId);
  const updatedAt = new Date().toISOString();
  // More than one page makes a retired continuation's next request observable.
  for (let index = 0; index < 201; index += 1) {
    seedClaim(fixture.store, { id: `retirement-${index}`, title: `Retirement fixture ${index}`, state: "done", owner: "owner", updatedAt });
  }
  const server = createRoomServer({ store: fixture.store, streamInterval: 40, fetchPullRequest: github() });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true });
  });
  for (const boundary of ["room", "sign-out"]) for (const operation of ["read", "mutation", "link-pr"]) {
    const id = `retired-${boundary}-${operation}`;
    seedClaim(fixture.store, { id, title: `Original ${id}`, state: "unclaimed", updatedAt: new Date().toISOString() });
    fixture.store.workClaims.set("board-other", { ...fixture.store.workClaims.get("commons", id), title: `Other room ${id}` });
    if (operation === "link-pr") {
      const claimed = await fetch(`${origin}/api/rooms/commons/work-claims/${id}/claim`, {
        method: "POST", headers: { Authorization: `Bearer ${memberKey}`, "Content-Type": "application/json" }, body: "{}"
      });
      assert.equal(claimed.status, 200, await claimed.text());
    }
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const requests = [], errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.pathname.includes("/work-claims")) requests.push({ method: request.method(), path: url.pathname, search: url.search });
    });
    await page.goto(`${origin}/?account=1`);
    await signInFixture(page, accountKey);
    await page.locator("#inbox-panel").waitFor({ state: "visible" });
    const chooseRoom = async roomId => {
      await clickChrome(page, await page.locator("#main").isVisible() ? "#choose-room" : "#nav-rooms");
      await page.locator(`[data-account-room="${roomId}"]`).click();
      await page.locator("#main").waitFor({ state: "visible" });
      await page.waitForFunction(expected => new URL(location.href).searchParams.get("room") === expected, roomId);
    };
    const openCurrentBoard = async () => {
      await openBoard(page);
      await page.locator(`#work-board article[data-claim-id='${id}']`).waitFor({ state: "attached" });
    };
    await chooseRoom("commons"); await openCurrentBoard();
    const documentOrigin = await page.evaluate(() => performance.timeOrigin);
    const arrived = Promise.withResolvers(), release = Promise.withResolvers();
    const pattern = operation === "read" ? "**/api/rooms/commons/work-claims?*"
      : `**/api/rooms/commons/work-claims/${id}/${operation === "link-pr" ? "update" : "claim"}`;
    let captured = null;
    const hold = async route => {
      if (captured) { await route.continue(); return; }
      captured = route.request();
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      if (operation === "read") assert.ok((await response.json()).nextCursor, "the held real list has another page");
      arrived.resolve();
      await release.promise;
      await route.fulfill({ response });
    };
    await page.route(pattern, hold);
    try {
      if (operation === "read") {
        // This page has an account session, not a legacy Room cookie. A
        // separate fixture bearer write supplies a real event without using
        // the browser's current identity or fabricating a list response.
        const created = await fetch(`${origin}/api/rooms/commons/work-claims`, {
          method: "POST", headers: { Origin: origin, "Content-Type": "application/json", Authorization: `Bearer ${fixture.keys.owner}` },
          body: JSON.stringify({ id: `refresh-${id}`, title: `Refresh ${id}` })
        });
        assert.equal(created.status, 201, await created.text());
      } else if (operation === "link-pr") {
        const input = page.locator(`article[data-claim-id='${id}'] [data-claim-link-pr] input`);
        await input.fill("https://github.com/Uuriko/project-room/pull/1303");
        await input.press("Enter");
      } else await page.locator(`article[data-claim-id='${id}'] [data-claim-action='claim']`).click();
      await arrived.promise;
      await page.locator("#board-close").click();
      if (boundary === "room") {
        await chooseRoom("board-other"); await openCurrentBoard();
        await page.locator("#board-close").focus();
        assert.match(await page.locator(`article[data-claim-id='${id}'] h4`).innerText(), /^Other room /);
      } else {
        await clickChrome(page, "#signout-button");
        await page.locator("#auth-panel").waitFor({ state: "visible" });
        if (!await page.locator('#auth-signin-ui [data-signin-form="password"]').isVisible()) await page.getByRole("button", { name: "Log in", exact: true }).click();
        await page.locator('#auth-signin-ui [data-signin-form="password"] [name="email"]').focus();
      }
      assert.equal(await page.evaluate(() => performance.timeOrigin), documentOrigin, "the old callback survives in the same document");
      const destination = page.url();
      const beforeRelease = requests.length;
      const focus = await page.evaluate(() => ({ id: document.activeElement?.id, name: document.activeElement?.getAttribute("name") }));
      const delivered = page.waitForResponse(response => response.request() === captured);
      release.resolve();
      await (await delivered).finished();
      await page.waitForLoadState("networkidle");
      assert.equal(requests.length, beforeRelease, `${boundary}/${operation}: retired continuation sends no further Board request`);
      assert.equal(page.url(), destination);
      assert.deepEqual(await page.evaluate(() => ({ id: document.activeElement?.id, name: document.activeElement?.getAttribute("name") })), focus);
      assert.equal(fixture.store.workClaims.get("board-other", id).owner, null, "same-ID work in the new room is untouched");
      assert.equal(fixture.store.workClaims.get("commons", id).owner, operation === "read" ? null : memberId,
        "only the one mutation already accepted before retirement persists");
      assert.equal(requests.filter(request => request.method === "POST").length, operation === "read" ? 0 : 1);
      if (operation === "link-pr") {
        assert.equal(fixture.store.workClaims.get("commons", id).pullRequests.length, 1);
        assert.equal(fixture.store.workClaims.get("board-other", id).pullRequests?.length ?? 0, 0);
      }
      if (boundary === "room") {
        assert.equal(await page.locator(`[aria-labelledby='board-col-ready'] article[data-claim-id='${id}']`).count(), 1);
        assert.equal(await page.locator("#board-status").textContent(), "");
      } else {
        assert.equal(await page.locator("#board-dialog").evaluate(node => node.open), false);
        assert.equal(await page.locator("#work-board article").count(), 0);
      }
      assert.deepEqual(errors, []);
    } finally {
      await drainBoardRoutes(page, release);
      await context.close();
    }
  }
});

test("first board open requests at most two list pages when most claims are old", { timeout: 60000 }, async t => {
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store, streamInterval: 40, fetchPullRequest: github() });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const recent = new Date().toISOString();
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  for (let index = 0; index < 100; index += 1) seedClaim(fixture.store, { id: `open-${index}`, title: `Open ${index}`, state: "unclaimed", updatedAt: recent });
  for (let index = 0; index < 500; index += 1) seedClaim(fixture.store, { id: `old-${index}`, title: `Old ${index}`, state: "done", owner: "owner", updatedAt: old });
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(8000);
  let lists = 0;
  page.on("request", request => {
    const url = new URL(request.url());
    if (request.method() === "GET" && /\/work-claims$/.test(url.pathname)) lists += 1;
  });
  await page.goto(origin);
  await signInFixture(page, fixture.keys.owner);
  await page.locator("#main").waitFor({ state: "visible" });
  await openBoard(page);
  await page.locator(".board-older").waitFor();
  await page.locator("article[data-claim-id='open-0']").waitFor();
  assert.equal(lists <= 2, true, `list requests: ${lists}`);
  assert.equal(await page.locator(".board-older").innerText(), "Older landed work is in the API");
});

test("a read-only member does not see the new item form", { timeout: 60000 }, async t => {
  const fixture = createAcceptanceFixture();
  fixture.store.command(fixture.keys.owner, "commons", {
    id: crypto.randomUUID(), type: "member.added",
    data: { memberId: "reader", displayName: "Reader", kind: "human", permissions: [] }
  });
  const reader = fixture.store.issueAccessKey("commons", "reader");
  seedClaim(fixture.store, { id: "reader-held", title: "Previously held work", state: "claimed", owner: "reader",
    claimedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), leaseExpiresAt: new Date(Date.now() + 3600000).toISOString() });
  const server = createRoomServer({ store: fixture.store, streamInterval: 40, fetchPullRequest: github() });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(8000);
  await page.goto(origin);
  await signInFixture(page, reader);
  await page.locator("#main").waitFor({ state: "visible" });
  await openBoard(page);
  await page.locator("#board-dialog").waitFor({ state: "visible" });
  await page.locator(".live-chip").waitFor();
  assert.equal(await page.locator("#board-new-item").count(), 0);
  assert.equal(await page.locator("article[data-claim-id='reader-held']").count(), 1);
  assert.equal(await page.locator("[data-claim-link-pr]").count(), 0, "a held claim does not restore revoked Board-write authority");
});

// Real-browser guards for the two #2476 repairs. Unit tests model the
// controller; these hold the actual GET list response in Chromium. On the
// pre-#2476 board-ui.js both parts fail: focus falls off Save cap when the
// first read repaints, and "Done" is announced over the stale lease.
test("held Board reads keep Save cap focus and announce Done only after fresh claims", { timeout: 60000 }, async t => {
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store, streamInterval: 40, fetchPullRequest: github() });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.setDefaultTimeout(8000);
  await page.goto(origin);
  await signInFixture(page, fixture.keys.owner);
  await page.locator("#main").waitFor({ state: "visible" });
  await post(page, origin, "/work-claims", { id: "held-done", title: "Finish behind a held read" }, 201);
  await post(page, origin, "/work-claims/held-done/claim", {});
  await post(page, origin, "/work-claims/held-done/update", { state: "in_progress" });

  const isList = request => request.method() === "GET" && /\/api\/rooms\/commons\/work-claims$/.test(new URL(request.url()).pathname);
  const holds = [];
  const hold = () => {
    const arrived = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    holds.push({ arrived, release, captured: null });
    return holds.at(-1);
  };
  await page.route("**/api/rooms/commons/work-claims*", async route => {
    const current = holds.find(entry => !entry.captured);
    if (!current || !isList(route.request())) return route.continue();
    current.captured = route.request();
    const response = await route.fetch();
    current.arrived.resolve();
    await current.release.promise;
    await route.fulfill({ response });
  });
  try {
    // 1. Keyboard focus on Save cap survives the first list read replacing it.
    const first = hold();
    await openBoard(page);
    await first.arrived.promise;
    assert.equal(await page.locator("article[data-claim-id='held-done']").count(), 0, "the first list read is still held");
    for (let step = 0; step < 25; step += 1) {
      if (await page.evaluate(() => document.activeElement?.matches("form[data-claim-cap] button[type='submit']"))) break;
      await page.keyboard.press("Shift+Tab");
    }
    const onSaveCap = () => page.evaluate(() => document.activeElement?.matches("form[data-claim-cap] button[type='submit']") === true);
    assert.equal(await onSaveCap(), true, "Shift+Tab reaches Save cap while the first read is held");
    first.release.resolve();
    await page.locator("article[data-claim-id='held-done'] .claim-lease").waitFor();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.equal(await onSaveCap(), true, "the first read's repaint keeps keyboard focus on Save cap");

    // 2. "Done" is announced only once the refreshed claim (no lease) renders.
    await page.evaluate(() => {
      const dialog = document.querySelector("#board-dialog");
      window.__boardDoneAnnounce = null;
      new MutationObserver(() => {
        const status = document.querySelector("#board-status")?.textContent;
        if (window.__boardDoneAnnounce || status !== "Done 'Finish behind a held read'") return;
        const card = document.querySelector("article[data-claim-id='held-done']");
        window.__boardDoneAnnounce = { leases: card?.querySelectorAll(".claim-lease").length ?? -1,
          column: card?.closest("[aria-labelledby]")?.getAttribute("aria-labelledby") ?? null };
      }).observe(dialog, { childList: true, characterData: true, subtree: true });
    });
    const second = hold();
    await page.locator("article[data-claim-id='held-done'] [data-claim-action='done']").click();
    await second.arrived.promise;
    await page.waitForTimeout(900);
    assert.equal(await page.evaluate(() => window.__boardDoneAnnounce), null, "no Done announcement while the refreshed list is held");
    second.release.resolve();
    await page.waitForFunction(() => window.__boardDoneAnnounce !== null);
    assert.deepEqual(await page.evaluate(() => window.__boardDoneAnnounce), { leases: 0, column: "board-col-landed" },
      "Done is announced over the refreshed claim, not the stale lease");
  } finally {
    await drainBoardRoutes(page, ...holds.map(entry => entry.release));
  }
});
