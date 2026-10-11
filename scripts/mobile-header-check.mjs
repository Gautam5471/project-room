// Automated usability checks with synthetic identities, not human participant research.
// C1: mobile actions stay readable and reflow as whole controls; infrequent actions live in an
// accessible menu; identity and connection recovery are available in the account menu.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { signInFixture } from "./auth-signin.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { openCatchUp, closeCatchUp } from "./room-chrome.mjs";

async function setup(t, viewport) {
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store, streamInterval: 60 });
  let browser;
  t.after(async () => {
    await browser?.close();
    server.closeStreams(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({ viewport, hasTouch: viewport.width <= 520, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  return { fixture, page, errors, server, context, origin: `http://127.0.0.1:${server.address().port}` };
}

async function signIn(fixture, page, origin) {
  await page.goto(origin);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await signInFixture(page, fixture.keys.owner);
  await page.locator("#main").waitFor({ state: "visible" });
}

// The old header fits inside the viewport while breaking More into a column
// of characters, so an overflow-only check cannot own this regression.
async function assertMoreLabel(page) {
  const lines = await page.locator("#room-more > summary").evaluate(node => {
    const text = [...node.childNodes].find(child => child.nodeType === Node.TEXT_NODE && child.textContent.includes("More"));
    const range = document.createRange();
    range.selectNodeContents(text);
    return [...range.getClientRects()].map(rect => Math.round(rect.top));
  });
  assert.equal(new Set(lines).size, 1, `More must remain one readable line, not stacked characters (line tops: ${lines})`);
}

const headerControls = ["#sidebar-toggle", "#topbar-updates", "#topbar-search-toggle", "#topbar-catchup", "#room-more > summary", "#session-menu-button"];
const longRoomName = "Project Room — A deliberately long research and delivery room name";

async function assertReadableWords(page, selectors) {
  const brokenWords = await page.evaluate(selectors => {
    const broken = [];
    for (const selector of selectors) {
      const walker = document.createTreeWalker(document.querySelector(selector), NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        for (const match of text.textContent.matchAll(/\S+/g)) {
          const range = document.createRange();
          range.setStart(text, match.index); range.setEnd(text, match.index + match[0].length);
          const lines = [...range.getClientRects()].map(rect => Math.round(rect.top));
          if (new Set(lines).size !== 1) broken.push(`${selector}: ${match[0]}`);
        }
      }
    }
    return broken;
  }, selectors);
  assert.deepEqual(brokenWords, [], "visible labels, counts and connection status words are never split into characters");
}

async function assertHeader(page, count) {
  await assertMoreLabel(page);
  assert.equal(await page.getByRole("button", { name: `Catch up ${count}`, exact: true }).count(), 1, "the full count meaning remains in the accessible name");
  const layout = await page.evaluate(selectors => ({
    name: document.querySelector("#mobile-room-name").textContent,
    boxes: selectors.map(selector => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    })
  }), headerControls);
  assert.equal(layout.name, longRoomName, "the long-name stress fixture survives throughout the layout check");
  const boxes = layout.boxes;
  for (const [index, selector] of headerControls.entries()) {
    const control = page.locator(selector);
    assert.equal(await control.isVisible(), true, `${selector} remains visible`);
    const box = boxes[index];
    assert.ok(box.width >= 44 && box.height >= 44, `${selector} retains a 44px target: ${JSON.stringify(box)}`);
    assert.ok(box.x >= 0 && box.x + box.width <= page.viewportSize().width + 1, `${selector} stays within the viewport`);
    for (const prior of boxes.slice(0, index)) assert.ok(box.x + box.width <= prior.x + 1 || prior.x + prior.width <= box.x + 1 || box.y + box.height <= prior.y + 1 || prior.y + prior.height <= box.y + 1, "header hit areas never overlap");
  }
  if (await page.evaluate(() => getComputedStyle(document.documentElement).fontSize === "16px")) {
    const actions = boxes.slice(1);
    // Native details and an inline-grid account button can have different
    // baselines within one flex row. Require a substantial shared band instead
    // of pixel-identical centers; a control on the next row cannot satisfy it.
    const sharedBand = Math.min(...actions.map(box => box.y + box.height)) - Math.max(...actions.map(box => box.y));
    assert.ok(sharedBand >= Math.min(...actions.map(box => box.height)) * .75, `default-size actions share one compact row (shared ${sharedBand}px): ${JSON.stringify(actions)}`);
  }
  // Compare geometry before scrolling, then test each target's actual hit
  // area. Enlarged text may need vertical scrolling; it must remain usable.
  for (const selector of headerControls) {
    const control = page.locator(selector);
    await control.scrollIntoViewIfNeeded();
    assert.equal(await control.evaluate(node => {
      const rect = node.getBoundingClientRect();
      return node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    }), true, `${selector} is reachable and not covered by another surface`);
  }
  // Independently measure words, not CSS declarations: overflow can remain
  // contained even when a label or count has become a stack of characters.
  await assertReadableWords(page, ["#topbar-updates", "#topbar-catchup"]);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true, "no horizontal document overflow");
}

async function exerciseHeader(page) {
  // Tab order stays the authored reading order even when whole controls wrap.
  await page.locator("#topbar-updates").focus();
  for (const selector of headerControls.slice(2)) {
    await page.keyboard.press("Tab");
    assert.equal(await page.locator(selector).evaluate(node => node === document.activeElement), true, `Tab reaches ${selector}`);
  }
  for (const mode of ["keyboard", "touch"]) {
    const activate = async selector => {
      const target = page.locator(selector);
      if (mode === "keyboard") { await target.focus(); await page.keyboard.press("Enter"); }
      else await target.tap();
    };
    for (const [trigger, dialog] of [["#topbar-updates", "#updates-dialog"], ["#topbar-catchup", "#catchup-dialog"]]) {
      await activate(trigger); await page.locator(dialog).waitFor({ state: "visible" });
      await page.keyboard.press("Escape"); await page.locator(dialog).waitFor({ state: "hidden" });
    }
    await activate("#topbar-search-toggle");
    assert.equal(await page.locator("#message-search").isVisible(), true);
    await activate("#topbar-search-toggle");
    await activate("#room-more > summary");
    assert.equal(await page.locator("#topbar-settings").isVisible(), true);
    const menu = await page.locator(".room-more-actions").boundingBox();
    assert.ok(menu.x >= 0 && menu.x + menu.width <= page.viewportSize().width + 1, "More popover stays inside the narrow viewport");
    if (mode === "keyboard") {
      for (const selector of ["#topbar-activity", "#topbar-later", "#room-actions-open", "#topbar-settings"]) {
        await page.keyboard.press("Tab");
        assert.equal(await page.locator(selector).evaluate(node => node === document.activeElement), true, `More menu Tab reaches ${selector}`);
      }
      await page.keyboard.press("Enter");
    } else {
      await page.locator("#topbar-settings").tap({ trial: true });
      await page.screenshot({ path: `test-results/mobile-header-more-${page.viewportSize().width}-${await page.evaluate(() => document.documentElement.style.fontSize)}.png` });
      await page.locator("#topbar-settings").tap();
    }
    await page.locator("#settings-dialog").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await page.locator("#settings-dialog").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#room-more > summary").evaluate(node => node === document.activeElement), true);
    await activate("#session-menu-button");
    assert.equal(await page.locator("#refresh-button").isVisible(), true);
    const account = await page.locator(".session-menu-panel").boundingBox();
    assert.ok(account.x >= 0 && account.x + account.width <= page.viewportSize().width + 1, "account popover stays inside the narrow viewport");
    // Connection details is a native summary between the session buttons and
    // Refresh, so it participates in the real Tab order too.
    for (const item of await page.locator(".session-menu-panel button:visible:not(:disabled), .session-menu-panel summary:visible").all()) {
      if (mode === "keyboard") {
        await page.keyboard.press("Tab");
        const focus = await item.evaluate(node => ({ expected: node.id || node.getAttribute("aria-label") || node.textContent, actual: document.activeElement.id || document.activeElement.getAttribute("aria-label") || document.activeElement.textContent, matches: node === document.activeElement }));
        assert.equal(focus.matches, true, `account menu Tab reaches ${focus.expected}, actual: ${focus.actual}`);
      }
      await item.tap({ trial: true });
    }
    if (mode === "touch") await page.screenshot({ path: `test-results/mobile-header-account-${page.viewportSize().width}-${await page.evaluate(() => document.documentElement.style.fontSize)}.png` });
    await page.keyboard.press("Escape");
  }
}

test("mobile header: session actions fold into an accessible menu, conversation stays close", { timeout: 90000 }, async t => {
  const { fixture, page, errors, server, context, origin } = await setup(t, { width: 390, height: 844 });
  await signIn(fixture, page, origin);
  await page.waitForFunction(() => document.querySelector("#catchup-count").textContent === "4 updates"); // R28-1: the owner's own setup events are not news to the owner
  await assertMoreLabel(page);
  const layouts = async (name, count, { interact = false, recovery = false } = {}) => {
    for (const width of [390, 320]) for (const font of [100, 200]) {
      await page.setViewportSize({ width, height: 844 });
      // Only the long name is a DOM text-size stress fixture. Counts below are
      // rendered from real commands and the actual acknowledgement flow.
      await page.evaluate(([size, roomName]) => {
        document.documentElement.style.fontSize = `${size}%`;
        document.querySelector("#mobile-room-name").textContent = roomName;
        scrollTo(0, 0);
      }, [font, longRoomName]);
      mkdirSync("test-results", { recursive: true });
      try {
        await assertHeader(page, count);
        if (interact) await exerciseHeader(page);
        if (recovery) {
          await assertReadableWords(page, ["#connection-status", "#connection-details > summary", "#refresh-button"]);
          const details = page.locator("#connection-details > summary");
          for (const control of [details, page.locator("#refresh-button")]) {
            const box = await control.boundingBox();
            assert.ok(box.width >= 44 && box.height >= 44, "disconnected recovery controls retain44px targets");
            await control.tap({ trial: true });
          }
          await details.focus(); await page.keyboard.press("Enter");
          assert.equal(await page.locator("#connection-explanation").isVisible(), true, "the unchanged connection explanation remains reachable");
          await page.keyboard.press("Enter");
          await page.locator("#refresh-button").tap({ trial: true });
        }
        await page.evaluate(() => scrollTo(0, 0));
        await assertHeader(page, count);
      } catch (error) {
        // A diagnostic after a failed assertion is explicitly separate from
        // the success evidence below and never turns the test into a pass.
        await page.screenshot({ path: `test-results/mobile-header-failure-${width}-${font}-${name}.png` });
        throw error;
      }
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: `test-results/mobile-header-${width}-${font}-${name}.png` });
    }
  };
  await layouts("4-updates", "4 updates");
  await openCatchUp(page);
  await page.waitForFunction(() => !document.querySelector("#rb-ack-button").disabled && Boolean(document.querySelector("#rb-ack-button").dataset.horizon));
  await page.locator("#rb-ack-button").click();
  await page.waitForFunction(() => document.querySelector("#catchup-count").textContent === "No new updates");
  await closeCatchUp(page);
  await layouts("0-updates", "No new updates");
  let now = Date.now(); fixture.store.now = () => now;
  const send = (type, data, key = fixture.keys.owner) => { now += 2100; return fixture.store.command(key, "commons", { id: crypto.randomUUID(), type, data }); };
  // The guest's mention comes first: an unbroken run of the owner's own events right
  // after the marker is not news to the owner (R28-1), so this keeps all 77 counted.
  send(T.MESSAGE_POSTED, { messageId: "header-mention", body: "@owner Please check this synthetic header update." }, fixture.keys.guest);
  for (let n = 0; n < 7; n++) send(T.WORK_PROPOSED, { workItemId: `header-work-${n}`, title: `Synthetic header task ${n + 1}`, definitionOfDone: "Exercise the visible current-needs count.", accountableMemberId: "owner", independentVerificationRequired: false, ownerDecisionRequired: false, mode: "read" });
  for (let n = 0; n < 69; n++) send(T.MESSAGE_POSTED, { messageId: `header-message-${n}`, body: `Synthetic header update ${n + 1}.` });
  await page.waitForFunction(() => document.querySelector("#catchup-count").textContent === "7 need you · 77 updates");
  // Catch-up proposals are not actionable Updates. Load a real mention so
  // the compact-row contract also exercises the Updates badge, not an empty span.
  await page.locator("#topbar-updates").click();
  await page.waitForFunction(() => !document.querySelector("#updates-count").hidden && document.querySelector("#updates-count").textContent === "1");
  await page.keyboard.press("Escape");
  await page.locator("#updates-dialog").waitFor({ state: "hidden" });
  await layouts("77-updates", "7 need you · 77 updates", { interact: true });
  await context.setOffline(true); server.closeStreams();
  await page.waitForFunction(() => document.querySelector("#connection-status").textContent.startsWith("Connection interrupted"));
  await layouts("disconnected", "7 need you · 77 updates", { recovery: true });
  // CLOSED EventSource recovery backs off to30s plus up to25% jitter.
  // Require a new successful stream response after the observed interrupted
  // state, not just a status string or an arbitrary extra sleep.
  const reconnected = page.waitForResponse(response => new URL(response.url()).pathname === "/api/rooms/commons/stream" && response.status() === 200, { timeout: 40000 });
  await context.setOffline(false);
  await reconnected;
  await page.waitForFunction(() => document.querySelector("#connection-status").textContent.startsWith("Connected"));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { document.documentElement.style.fontSize = ""; scrollTo(0, 0); });
  assert.equal(await page.locator("#session-menu-button").isVisible(), true, "menu affordance present on mobile");
  assert.equal(await page.locator("#signout-button").isVisible(), false, "sign out folded into the closed menu");
  assert.equal(await page.locator("#identity-label").isVisible(), false, "identity is in the account menu");
  assert.equal(await page.locator("#refresh-button").isVisible(), false, "healthy connection recovery is secondary");
  const titleBox = await page.locator("#conversation-title").boundingBox();
  assert.ok(titleBox && titleBox.y < 844, `conversation is reachable in the first viewport (y=${titleBox && titleBox.y})`);
  await page.locator("#session-menu-button").click();
  assert.equal(await page.locator("#signout-button").isVisible(), true, "menu opens to reveal session actions");
  assert.equal(await page.locator("#identity-label").isVisible(), true);
  assert.equal(await page.locator("#refresh-button").isVisible(), true);
  assert.equal(await page.locator("#session-menu-button").getAttribute("aria-expanded"), "true");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#signout-button").isVisible(), false, "Escape closes the menu");
  assert.equal(await page.evaluate(() => document.activeElement.id), "session-menu-button", "Escape returns focus to the menu button");
  await page.locator("#session-menu-button").click();
  await page.locator("#signout-button").click();
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  assert.deepEqual(errors, []);
});

test("desktop header: account actions use the same discoverable menu", { timeout: 60000 }, async t => {
  const { fixture, page, errors, origin } = await setup(t, { width: 1280, height: 900 });
  await signIn(fixture, page, origin);
  assert.equal(await page.locator("#session-menu-button").isVisible(), true);
  assert.equal(await page.locator("#signout-button").isVisible(), false);
  await page.locator("#session-menu-button").click();
  assert.equal(await page.locator("#signout-button").isVisible(), true, "sign out is reachable in the account menu");
  await page.locator("#signout-button").click();
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  assert.deepEqual(errors, []);
});
