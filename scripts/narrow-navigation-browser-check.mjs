// Synthetic browser fixtures. These checks do not stand in for physical-device or human AT runs.
// Pins three navigation fixes from muse-room bug hunt r1 (12724): switching
// channel keeps focus on the channel list, a phone thread keeps room for its
// replies, and opening a search result on a phone hands the screen back to
// the conversation.
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
import { ensureSidebarClosed, ensureSidebarOpen, openSearch } from "./room-chrome.mjs";

test("narrow navigation: channel focus, thread room, search hands back the screen", { timeout: 60000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-narrow-nav-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  const send = (type, data) => store.command(owner, "commons", { id: crypto.randomUUID(), type, data });
  send(T.CHANNEL_CREATED, { channelId: "design", name: "design" });
  send(T.MESSAGE_POSTED, { messageId: "root", body: "Thread root for the layout check" });
  for (let index = 1; index <= 6; index++) send(T.MESSAGE_POSTED, { messageId: `reply-${index}`, body: `Reply ${index}`, replyToId: "root" });
  for (let index = 1; index <= 14; index++) send(T.MESSAGE_POSTED, { messageId: `filler-${index}`, body: index === 7 ? "the needle is here" : `Filler ${index}` });
  const server = createRoomServer({ store, streamInterval: 50 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  t.after(async () => {
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: "reduce" })).newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await signInFixture(page, owner);
  await page.locator("#main").waitFor({ state: "visible" });

  // Channel switch by keyboard keeps focus on the picked channel.
  await ensureSidebarOpen(page);
  await page.locator('#channel-list [data-channel="design"]').focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("#conversation-title")?.textContent === "# design");
  // The drawer closes on a phone, so focus lands on the channel heading.
  assert.equal(await page.evaluate(() => document.activeElement?.id), "conversation-title", "focus lands on the picked channel, not <body>");
  await ensureSidebarOpen(page);
  await page.locator('#channel-list [data-channel="general"]').click();
  await page.waitForFunction(() => document.querySelector("#conversation-title")?.textContent === "# general");
  await ensureSidebarClosed(page);

  // A thread's bar is one row at 390, so replies keep most of the screen.
  await page.locator('[data-message-record-id="root"] [data-message-action="thread"]').click();
  await page.locator("#thread-bar").waitFor({ state: "visible" });
  const bar = await page.locator("#thread-bar").boundingBox();
  assert.ok(bar.height <= 90, `thread bar is one row (${bar.height}px)`);
  const backBox = await page.locator("#thread-back").boundingBox(), muteBox = await page.locator("#thread-mute").boundingBox();
  assert.ok(Math.abs(backBox.y - muteBox.y) < 4, "Back and Mute share a row");
  assert.ok(backBox.height >= 44 && muteBox.height >= 44, "both keep a 44px tap target");
  await page.locator("#thread-back").click();
  await page.locator("#thread-bar").waitFor({ state: "hidden" });

  // Opening a search result on a phone collapses the results panel.
  await openSearch(page);
  await page.locator("#message-search").fill("needle");
  const result = page.locator('#search-results [data-open-message="filler-7"]');
  await result.waitFor({ state: "visible" });
  await result.click();
  await page.waitForFunction(() => location.hash.startsWith("#pr-record/message/"));
  assert.equal(await page.locator("#search-results").isHidden(), true, "results step aside after opening one");
  const list = await page.locator("#message-list").boundingBox();
  assert.ok(list.height > 250, `the conversation gets the screen back (${list.height}px)`);
  await page.locator("#message-search").focus();
  await page.locator("#search-results").waitFor({ state: "visible" });
  assert.equal(await result.isVisible(), true, "focusing the field brings back the same results");
  assert.deepEqual(errors, []);
});
