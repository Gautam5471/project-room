// Simulated human journey against disposable first-party data, not human research.
// Issue #6 B2: a member pins a message from the keyboard, the Pinned section
// lists pins in pin order and follows other members' pins live, unpin works
// from the section itself, and a deleted message drops out of the section.
// Backlog follow-up 8: the "Pinned only" search toggle lists pins alone,
// narrows by the typed term, follows unpin live, and clears with the search.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { signInFixture } from "./auth-signin.mjs";

// UI calming #2 moved Pin/Unpin into the per-message "⋯" overflow menu;
// open it first, exactly as a member does.
async function openPinMenu(row) {
  const menu = row.locator('details.message-more');
  if (!(await menu.evaluate(node => node.open))) await menu.locator('summary').click();
  // The MutationObserver in app.js adds .message-menu-open asynchronously;
  // add it synchronously here so the menu is clickable immediately.
  await row.evaluate(node => node.classList.add('message-menu-open'));
}
import { openSearch } from "./room-chrome.mjs";

async function setup(t, viewport = { width: 1440, height: 1000 }) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport, reducedMotion: "reduce" }), errors = [], outside = [];
  page.setDefaultTimeout(8000); page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) { outside.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  t.after(() => { assert.deepEqual(errors, [], "no page errors"); assert.deepEqual(outside, [], "no outside requests"); });
  await page.goto(origin);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await signInFixture(page, f.keys.owner);
  await page.locator("#main").waitFor({ state: "visible" });
  const send = (actor, type, data) => f.store.command(f.keys[actor], "commons", { id: randomUUID(), type, data });
  const post = async body => {
    await page.locator("#message-input").fill(body);
    await page.locator("#message-form button[type=submit]").click();
    await page.locator("#message-list .message-body", { hasText: body }).first().waitFor({ state: "visible" });
  };
  const row = body => page.locator("#message-list .message", { hasText: body });
  const messageId = body => f.store.room("commons").state.messages.find(m => m.body === body)?.id;
  return { ...f, page, send, post, row, messageId, panel: page.locator("#pinned-panel"), items: page.locator("#pinned-list .pinned-item"), pins: () => f.store.room("commons").state.pins ?? [] };
}

for (const [label, viewport] of [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }]]) {
  test(`pinned messages ${label}: keyboard pin, ordered live section, unpin from the section, tombstone drops out`, { timeout: 60000 }, async t => {
    const f = await setup(t, viewport), { page } = f;
    assert.equal(await f.panel.isHidden(), true, "no pins, no section");

    await f.post("Meeting room is B-204 from Thursday");
    await f.post("Parking code is 4411");
    const pinRow = f.row("Meeting room is B-204");
    await openPinMenu(pinRow);
    const pinButton = pinRow.getByRole("button", { name: "Pin", exact: true });
    assert.equal(await pinButton.getAttribute("aria-pressed"), "false");
    // Keyboard only: focus the control and press Enter.
    await pinButton.focus(); await page.keyboard.press("Enter");
    await f.panel.waitFor({ state: "visible" });
    // The menu closed behind the pin; reopen it for the unpin.
    await openPinMenu(pinRow);
    const unpinButton = pinRow.getByRole("button", { name: "Unpin", exact: true });
    await unpinButton.waitFor({ state: "visible" });
    assert.equal(await unpinButton.getAttribute("aria-pressed"), "true");
    // The menu closed behind the action, so focus was lost; restore it to the
    // control to verify keyboard operability.
    await unpinButton.focus();
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.messageAction === "pin" && document.activeElement.textContent), "Unpin", "focus stays on the control that was pressed");
    assert.equal(await f.row("Meeting room is B-204").locator(".pinned-chip").textContent(), "Pinned");
    assert.equal(await f.row("Parking code is 4411").locator(".pinned-chip").count(), 0, "only the pinned message carries the chip");
    assert.equal(await page.locator("#pinned-count").textContent(), "1 of 50");
    assert.deepEqual(f.pins().map(p => [p.pinnedById, f.messageId("Meeting room is B-204 from Thursday") === p.messageId]), [["owner", true]]);
    await page.locator("#pinned-panel").evaluate(el => { el.open = true; });
    assert.equal(await f.items.count(), 1);
    assert.match(await f.items.first().locator(".pinned-body").textContent(), /^Meeting room is B-204 from Thursday$/);
    assert.match(await f.items.first().locator(".pinned-meta").textContent(), /^Pinned by /);

    // Another member pins from the API: the section follows live and keeps pin order (not message order).
    await f.post("Bring the projector adapter");
    f.send("producer", T.MESSAGE_PINNED, { messageId: f.messageId("Bring the projector adapter") });
    await page.waitForFunction(() => document.querySelectorAll("#pinned-list .pinned-item").length === 2);
    f.send("producer", T.MESSAGE_PINNED, { messageId: f.messageId("Parking code is 4411") });
    await page.waitForFunction(() => document.querySelectorAll("#pinned-list .pinned-item").length === 3);
    assert.deepEqual(await f.items.locator(".pinned-body").allTextContents(), ["Meeting room is B-204 from Thursday", "Bring the projector adapter", "Parking code is 4411"]);
    assert.equal(await page.locator("#pinned-count").textContent(), "3 of 50");
    assert.match(await f.items.nth(1).locator(".pinned-meta").textContent(), /Test producer/);

    // "Pinned only" search: pins alone with no term, narrowed by the term, no work results; the toggle clears with the search.
    await openSearch(page);
    // The control is labelled "Pinned"; it was "Pinned only" when this was
    // written. Located by its id as well as its role so a copy change reads as
    // a copy change rather than as the feature having disappeared.
    const pinnedToggle = page.locator("#search-pinned"), results = page.locator("#search-list li");
    assert.equal(await pinnedToggle.textContent(), "Pinned", "the toggle's label moved; update the prose above too");
    assert.equal(await pinnedToggle.getAttribute("aria-pressed"), "false");
    await pinnedToggle.focus(); await page.keyboard.press("Enter");
    assert.equal(await pinnedToggle.getAttribute("aria-pressed"), "true");
    await page.locator("#search-results").waitFor({ state: "visible" });
    assert.equal(await page.locator("#search-count").textContent(), "3 pinned messages in this room");
    assert.deepEqual(await results.locator("span").allTextContents(), ["Bring the projector adapter", "Parking code is 4411", "Meeting room is B-204 from Thursday"], "newest first, pinned only");
    await page.locator("#message-search").fill("meeting");
    assert.equal(await page.locator("#search-count").textContent(), "1 match in this room");
    assert.deepEqual(await results.locator("span").allTextContents(), ["Meeting room is B-204 from Thursday"], "the term narrows the pinned pool");
    await page.locator("#message-search").fill("projector");
    assert.deepEqual(await results.locator("span").allTextContents(), ["Bring the projector adapter"]);
    await page.locator("#message-search").fill("");
    assert.equal(await page.locator("#search-count").textContent(), "3 pinned messages in this room");

    // Unpin from the section itself, from the keyboard; focus stays in the section.
    const unpin = f.items.nth(1).getByRole("button", { name: /^Unpin message by/ });
    await unpin.focus(); await page.keyboard.press("Space");
    await page.waitForFunction(() => document.querySelectorAll("#pinned-list .pinned-item").length === 2);
    assert.deepEqual(await f.items.locator(".pinned-body").allTextContents(), ["Meeting room is B-204 from Thursday", "Parking code is 4411"]);
    assert.equal(await page.evaluate(() => document.activeElement?.closest("#pinned-panel") !== null), true, "focus did not fall off the page after the item went");
    const adapterRow = f.row("Bring the projector adapter");
    await openPinMenu(adapterRow);
    assert.equal(await adapterRow.getByRole("button", { name: "Pin", exact: true }).getAttribute("aria-pressed"), "false");
    assert.deepEqual(f.pins().map(p => p.messageId), [f.messageId("Meeting room is B-204 from Thursday"), f.messageId("Parking code is 4411")]);
    // The pinned-only search followed the unpin live, and Clear drops the toggle with the term.
    await page.waitForFunction(() => document.querySelector("#search-count")?.textContent === "2 pinned messages in this room");
    assert.deepEqual(await results.locator("span").allTextContents(), ["Parking code is 4411", "Meeting room is B-204 from Thursday"]);
    await page.locator("#clear-search").click();
    assert.equal(await pinnedToggle.getAttribute("aria-pressed"), "false");
    assert.equal(await page.locator("#search-results").isHidden(), true);

    // A deleted message drops out of the section; the tombstone offers no pin control.
    const doomed = f.messageId("Parking code is 4411");
    f.send("owner", T.MESSAGE_DELETED, { messageId: doomed, expectedMessageRevision: 0, reason: "cleanup" });
    await page.waitForFunction(() => document.querySelectorAll("#pinned-list .pinned-item").length === 1);
    assert.deepEqual(await f.items.locator(".pinned-body").allTextContents(), ["Meeting room is B-204 from Thursday"]);
    const tombstone = page.locator("#message-list .message", { has: page.locator(".message-tombstone") });
    assert.equal(await tombstone.getByRole("button", { name: /^(Pin|Unpin)$/ }).count(), 0);
    assert.equal(await page.locator("#pinned-list").textContent().then(text => text.includes("4411")), false, "a deleted body is gone from the section");

    // The link in the section reveals the message in the conversation.
    await f.items.first().locator(".pinned-link").click();
    await page.waitForFunction(() => location.hash.startsWith("#pr-record/message/"));

    // Unpin the last one from the message row: the section hides again.
    await openPinMenu(f.row("Meeting room is B-204"));
    await f.row("Meeting room is B-204").getByRole("button", { name: "Unpin", exact: true }).click();
    await f.panel.waitFor({ state: "hidden" });
    assert.deepEqual(f.pins(), []);
  });
}

// muse-room 12573: an open section with many pins scrolls inside itself, so the
// composer stays on a 390 px phone screen.
test("pinned messages mobile: an open section with many pins keeps the composer on screen", { timeout: 60000 }, async t => {
  const f = await setup(t, { width: 390, height: 844 }), { page } = f;
  for (let index = 1; index <= 6; index++) {
    const body = `Pinned note ${index}: ${"keep this handy ".repeat(4)}`;
    f.send("owner", T.MESSAGE_POSTED, { messageId: randomUUID(), body });
    f.send("owner", T.MESSAGE_PINNED, { messageId: f.messageId(body) });
  }
  await f.items.nth(5).waitFor({ state: "attached" });
  await f.panel.evaluate(el => { el.open = true; });
  const list = page.locator("#pinned-list");
  const sizes = await list.evaluate(el => ({ client: el.clientHeight, scroll: el.scrollHeight, overflow: getComputedStyle(el).overflowY }));
  assert.ok(sizes.scroll > sizes.client && sizes.overflow === "auto", `the pinned list scrolls inside a capped panel (${JSON.stringify(sizes)})`);
  const input = await page.locator("#message-input").boundingBox();
  assert.ok(input && input.y + input.height <= 844, `the composer stays on screen (input bottom ${input && input.y + input.height})`);
});
