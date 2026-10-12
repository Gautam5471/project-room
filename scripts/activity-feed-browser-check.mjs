// Attention: Activity feed, Later (saved messages), Mark unread, and the
// read-horizon "New messages" divider. Real browser + local HTTP service;
// all identities, messages, and keys are disposable fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { createRoomServer } from "../server/http.mjs";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { signInFixture } from "./auth-signin.mjs";
import { clickChrome } from "./room-chrome.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

for (const mobile of [false, true]) {
  const label = mobile ? "mobile" : "desktop";
  test(`activity feed ${label}: badge, filters, open-and-read, save/unsave, mark unread divider`, { timeout: 120000 }, async t => {
    const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 60 });
    let browser;
    t.after(async () => { await browser?.close(); server.closeStreams(); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
    const send = (actor, type, data) => f.store.command(f.keys[actor], "commons", { id: randomUUID(), type, data });
    // Before the owner arrives: one @mention and one reply to the owner's welcome.
    send("guest", T.MESSAGE_POSTED, { messageId: "mention-owner", body: "@owner could you confirm the agenda?" });
    send("guest", T.MESSAGE_POSTED, { messageId: "reply-owner", body: "Thanks for the welcome.", replyToId: "test-welcome" });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const capture = async name => { mkdirSync("test-results", { recursive: true }); await page.screenshot({ path: `test-results/activity-feed-${label}-${name}.png` }); };

    await page.goto(origin);
    await signInFixture(page, f.keys.owner);
    await page.locator("#main").waitFor({ state: "visible" });

    // Secondary navigation stays collapsed while chat is immediately usable.
    assert.equal(await page.locator("#room-more").evaluate(node => node.open), false);
    assert.equal(await page.locator("#topbar-activity").isVisible(), false);
    await page.locator("#room-more > summary").focus();
    await page.keyboard.press("Enter");
    await page.locator("#topbar-activity").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#room-more > summary").evaluate(node => node === document.activeElement), true);
    await page.locator("#room-more > summary").click();
    // The Activity badge counts the two unread items.
    const activityBadge = page.locator("#activity-count");
    await activityBadge.waitFor({ state: "visible" });
    assert.equal(await activityBadge.textContent(), "2");

    // The dialog lists both items; the Mentions filter narrows to one.
    await clickChrome(page, "#topbar-activity");
    const dialog = page.locator("#activity-dialog");
    await dialog.waitFor({ state: "visible" });
    await page.locator("#activity-list .activity-item").first().waitFor();
    assert.equal(await page.locator("#activity-list .activity-item").count(), 2);
    await page.locator('#activity-filters [data-activity-filter="mention"]').click();
    await page.waitForFunction(() => document.querySelectorAll("#activity-list .activity-item").length === 1);
    assert.match(await page.locator("#activity-list .activity-item").first().textContent(), /mentioned you/);
    await page.locator('#activity-filters [data-activity-filter=""]').click();
    await page.waitForFunction(() => document.querySelectorAll("#activity-list .activity-item").length === 2);

    // Opening an item jumps to the message and marks that item read.
    await page.locator('#activity-list .activity-item a[data-open-message="mention-owner"]').click();
    await page.waitForFunction(() => location.hash.startsWith("#pr-record/message/mention-owner"));
    await dialog.waitFor({ state: "hidden" });
    // Mark all read clears the badge.
    await clickChrome(page, "#topbar-activity");
    await dialog.waitFor({ state: "visible" });
    await page.locator("#activity-read-all").click();
    await page.waitForFunction(() => document.querySelector("#activity-count").hidden);
    await page.keyboard.press("Escape");
    await capture("read");

    // Save from the message overflow menu; Later badge counts it.
    const target = page.locator('[data-message-record-id="test-request"]');
    await target.locator(".message-more > summary").click();
    const saveButton = target.locator('[data-message-action="save"]');
    await saveButton.click();
    const laterBadge = page.locator("#later-count");
    await page.waitForFunction(() => document.querySelector("#later-count").textContent === "1");
    assert.equal(await laterBadge.textContent(), "1");
    // The menu label flips to Unsave while the message is saved.
    await target.locator(".message-more > summary").click();
    assert.equal(await target.locator('[data-message-action="save"]').textContent(), "Unsave");
    await page.keyboard.press("Escape");

    // The Later dialog lists the saved message; Unsave clears it.
    await clickChrome(page, "#topbar-later");
    const laterDialog = page.locator("#later-dialog");
    await laterDialog.waitFor({ state: "visible" });
    await page.locator("#later-list .later-item").first().waitFor();
    assert.equal(await page.locator("#later-list .later-item").count(), 1);
    await page.locator('#later-list [data-unsave-message]').click();
    await page.waitForFunction(() => document.querySelector("#later-count").hidden);
    await page.keyboard.press("Escape");

    // Mark unread rewinds the read horizon: the "New messages" divider
    // appears above the chosen message.
    const unreadTarget = page.locator('[data-message-record-id="mention-owner"]');
    await unreadTarget.locator(".message-more > summary").click();
    await unreadTarget.locator('[data-message-action="mark-unread"]').click();
    // Another unread divider may already exist before the asynchronous horizon
    // write finishes. Wait for this action's specific message, not that old one.
    await unreadTarget.locator('.chat-divider.unread', { hasText: "New messages" }).waitFor({ state: "visible" });
    // The divider renders at the top of the marked message's own element.
    const dividerInside = await page.evaluate(() => {
      const node = document.querySelector('[data-message-record-id="mention-owner"]');
      return node ? node.querySelector(".chat-divider.unread") !== null : false;
    });
    assert.ok(dividerInside, "unread divider renders inside the marked message's element");
    await capture("unread");

    // Scrolling to the bottom advances the horizon (debounced): the divider
    // clears because everything in view now counts as read. Only a reader's
    // scroll counts, so a real wheel comes first; synthetic scroll events then
    // cover viewports where the list has no scrollable overflow.
    const listBox = await page.locator("#message-list").boundingBox();
    await page.mouse.move(listBox.x + listBox.width / 2, listBox.y + Math.min(listBox.height, page.viewportSize().height - listBox.y) / 2);
    await page.mouse.wheel(0, 100000);
    await page.evaluate(() => {
      const list = document.querySelector("#message-list");
      if (list) { list.scrollTop = list.scrollHeight; list.dispatchEvent(new Event("scroll")); }
      window.scrollTo(0, document.body.scrollHeight);
      window.dispatchEvent(new Event("scroll"));
    });
    await page.waitForFunction(() => !document.querySelector(".chat-divider.unread"), undefined, { timeout: 15000 });
    await capture("read-again");

    assert.deepEqual(errors, [], "no page errors");
  });
}

for (const mobile of [false, true]) {
  const label = mobile ? "mobile" : "desktop";
  test(`activity shortcuts ${label}: keyboard open, mark-unread key, room-actions entries`, { timeout: 120000 }, async t => {
    const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 60 });
    let browser;
    t.after(async () => { await browser?.close(); server.closeStreams(); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
    const send = (actor, type, data) => f.store.command(f.keys[actor], "commons", { id: randomUUID(), type, data });
    send("guest", T.MESSAGE_POSTED, { messageId: "mention-owner", body: "@owner could you confirm the agenda?" });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));

    await page.goto(origin);
    await signInFixture(page, f.keys.owner);
    await page.locator("#main").waitFor({ state: "visible" });

    // `g a` opens Activity from the keyboard.
    await page.locator("#message-list").click();
    await page.keyboard.press("g");
    await page.keyboard.press("a");
    const dialog = page.locator("#activity-dialog");
    await dialog.waitFor({ state: "visible" });
    await page.locator("#activity-list .activity-item").first().waitFor();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });

    // `g l` opens Later.
    await page.keyboard.press("g");
    await page.keyboard.press("l");
    const laterDialog = page.locator("#later-dialog");
    await laterDialog.waitFor({ state: "visible" });
    await page.keyboard.press("Escape");

    // `u` with a message focused marks it unread: the divider appears.
    const target = page.locator('[data-message-record-id="mention-owner"]');
    await target.focus();
    await page.keyboard.press("u");
    await page.locator('.chat-divider.unread', { hasText: "New messages" }).first().waitFor({ state: "visible" });

    // The room-actions palette lists Activity and Later entries (desktop:
    // the palette button is hidden on small screens).
    if (!mobile) {
      await clickChrome(page, "#room-actions-open");
      const actionsDialog = page.locator("#room-actions-dialog");
      await actionsDialog.waitFor({ state: "visible" });
      await page.locator("#room-actions-query").fill("activity");
      await page.waitForFunction(() => [...document.querySelectorAll("#room-actions-list [data-room-action]")].some(el => el.textContent.toLowerCase().includes("activity")));
      await page.locator("#room-actions-list [data-room-action]").first().click();
      await dialog.waitFor({ state: "visible" });
      await page.keyboard.press("Escape");
    }

    assert.deepEqual(errors, [], "no page errors");
  });
}
