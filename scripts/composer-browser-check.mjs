// Synthetic browser fixtures. These checks do not stand in for physical-device or human AT runs.
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
import { openSearch } from "./room-chrome.mjs";

for (const [label, viewport] of [["desktop", { width: 1440, height: 1000 }], ["narrow", { width: 320, height: 780 }]]) {
  test(`composer ${label}: keyboard recovery, discussion errors, composition, and access cleanup`, { timeout: 60000 }, async t => {
    const directory = mkdtempSync(join(tmpdir(), "room-composer-"));
    const store = new RoomStore(join(directory, "room.sqlite"));
    store.initialize(initialRoom());
    const owner = store.issueAccessKey("commons", "owner");
    const send = (type, data) => store.command(owner, "commons", { id: crypto.randomUUID(), type, data });
    send(T.MEMBER_ADDED, { memberId: "maya", displayName: "Maya", kind: "human", permissions: [] });
    send(T.MEMBER_ADDED, { memberId: "nova", displayName: "Nova", kind: "agent", permissions: [] });
    // Consent-bound DMs: the owner addresses maya in this flow.
    store.dmConsents.request("commons", "owner", "maya", "browser test");
    store.dmConsents.decide("commons", "maya", "owner", "approve");
    send(T.MESSAGE_POSTED, { messageId: "topic", body: "Which book should we read?" });
    send(T.MESSAGE_POSTED, { messageId: "reply", body: "A short story collection?", replyToId: "topic" });
    send(T.MESSAGE_POSTED, { messageId: "ping", body: "Ping @Room owner" });
    const server = createRoomServer({ store, streamInterval: 50 });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    let browser;
    t.after(async () => {
      await browser?.close(); server.closeStreams(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true });
    });
    browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
    const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin);
    const login = async key => {
      await page.locator("#auth-panel").waitFor({ state: "visible" });
      await signInFixture(page, key);
      await page.locator("#main").waitFor({ state: "visible" });
    };
    await login(owner);
    const input = page.locator("#message-input"), status = page.locator("#composer-status");
    assert.match(await input.getAttribute("placeholder"), /Message #/);

    // Paste must retain overflow rather than silently send a truncated message.
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    const overflow = "x".repeat(65537), lengthStatus = page.locator("#message-length-status");
    await page.evaluate(text => navigator.clipboard.writeText(text), overflow);
    await input.focus(); await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
    assert.ok(await input.inputValue() === overflow, "clipboard paste retains every UTF-16 unit");
    assert.equal(await input.getAttribute("aria-invalid"), "true");
    assert.match(await lengthStatus.innerText(), /65,536/);
    await lengthStatus.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/composer-overflow-${label}.png` });
    const beforeOverflow = store.room("commons").sequence;
    await input.press("Enter");
    assert.equal(store.room("commons").sequence, beforeOverflow);
    await page.reload(); await page.locator("#main").waitFor({ state: "visible" });
    assert.ok(await input.inputValue() === overflow, "reload retains the complete overflow draft");
    assert.equal(await page.locator('#message-form button[type="submit"]').isDisabled(), true);
    await input.fill("😀".repeat(32768) + "x");
    assert.equal(await input.getAttribute("aria-invalid"), "true", "astral emoji count as two UTF-16 units");
    await input.fill("😀".repeat(32768));
    assert.equal(await lengthStatus.isVisible(), false);
    assert.equal(await page.locator('#message-form button[type="submit"]').isDisabled(), false);
    await input.fill("x".repeat(65531) + " :fire");
    assert.equal(await input.getAttribute("aria-invalid"), "true");
    await page.locator('#emoji-list [data-emoji="🔥"]').click();
    assert.equal((await input.inputValue()).length, 65535);
    assert.equal(await input.getAttribute("aria-invalid"), null, "picker replacement clears the derived overflow error");
    assert.equal(await page.locator('#message-form button[type="submit"]').isDisabled(), false);
    const longValid = "a".repeat(4001);
    await input.fill(longValid);
    assert.equal(await lengthStatus.isVisible(), false, "ordinary valid text stays quiet");
    await page.route("**/api/rooms/commons/commands", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "storage_unavailable", message: "Try later" } }) }));
    await input.press("Enter");
    await page.waitForFunction(() => document.querySelector("#composer-status").classList.contains("error") && !document.querySelector("#message-input").disabled);
    await page.unroute("**/api/rooms/commons/commands");
    await page.reload(); await page.locator("#main").waitFor({ state: "visible" });
    assert.equal(await input.inputValue(), longValid, "failed long send survives reload");
    await input.press("Enter");
    await page.waitForFunction(() => document.querySelector("#message-input").value === "");
    assert.equal(store.room("commons").state.messages.filter(message => message.body === longValid).length, 1);

    await input.scrollIntoViewIfNeeded();
    const inputBounds = await input.boundingBox();
    assert.ok(inputBounds.y >= 0 && inputBounds.y + inputBounds.height <= viewport.height, "composer remains reachable after a long message");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "long text does not widen the viewport");
    await page.screenshot({ path: `test-results/composer-options-${process.env.ROOM_COMPOSER_SCREENSHOT_STAGE || "after"}-${label}.png` });
    console.log(`composer ${label} visible buttons: ${await page.locator('#message-form button:visible').count()}`);
    const optionsDisclosure = page.locator("#composer-options");
    assert.equal(await page.locator("#new-work-button").isVisible(), false, "secondary work creation is disclosed on demand");
    await page.locator("#composer-options > summary").focus();
    await page.keyboard.press("Enter");
    assert.equal(await optionsDisclosure.evaluate(node => node.open), true);
    assert.equal(await page.locator("#new-work-button").isVisible(), true);
    await page.screenshot({ path: `test-results/composer-options-open-${label}.png` });
    await page.keyboard.press("Escape");
    assert.equal(await optionsDisclosure.evaluate(node => node.open), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), "composer-options-toggle");

    await page.locator("#composer-options > summary").click();
    const chooserPromise = page.waitForEvent("filechooser");
    await page.locator("#composer-attach").click();
    const chooser = await chooserPromise;
    assert.equal(await optionsDisclosure.evaluate(node => node.open), false);
    await chooser.setFiles({ name: "options-note.txt", mimeType: "text/plain", buffer: Buffer.from("Disposable attachment") });
    await page.locator("#composer-attachments .file-chip").getByText("options-note.txt", { exact: true }).waitFor();
    await input.fill("Keep this attached draft");
    await page.locator("#composer-options > summary").click();
    await page.locator("#conversation-title").click();
    assert.equal(await optionsDisclosure.evaluate(node => node.open), false);
    assert.equal(await input.inputValue(), "Keep this attached draft");
    assert.equal(await page.locator("#composer-attachments .file-chip").isVisible(), true);
    await page.getByRole("button", { name: "Remove options-note.txt", exact: true }).click();
    await input.fill("");

    // An explicit agent request stays discoverable without making ordinary Send a request.
    const recipient = page.locator("#message-to-select"), requestButton = page.locator("#request-reply");
    await recipient.selectOption("nova", { force: true });
    assert.equal(await requestButton.isVisible(), true);
    assert.equal(await requestButton.evaluate(node => node.parentElement.id), "composer-toolbar");
    await input.fill("Ordinary chat to Nova");
    await page.locator('#message-form button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector("#message-input").value === "");
    const ordinary = store.room("commons").state.messages.find(message => message.body === "Ordinary chat to Nova");
    assert.equal(ordinary.toMemberId, "nova");
    assert.equal(Object.hasOwn(store.room("commons").state.replyRequests ?? {}, ordinary.id), false);
    await requestButton.click();
    assert.equal(await page.locator("#request-mode-bar").isVisible(), true);
    assert.equal(await requestButton.isVisible(), false);
    await page.locator("#request-exit").click();
    await recipient.selectOption("", { force: true });
    assert.equal(await requestButton.isVisible(), false);
    assert.equal(await requestButton.evaluate(node => node.parentElement.className), "composer-options-panel");
    await recipient.selectOption("owner", { force: true });
    assert.equal(await requestButton.isVisible(), false);
    await recipient.selectOption("nova", { force: true });
    send(T.MEMBER_ACCESS_CHANGED, { memberId: "nova", expectedMemberRevision: 0, permissions: [], active: false });
    await page.waitForFunction(() => document.querySelector('#message-to-select option[value="nova"]')?.disabled);
    assert.equal(await requestButton.isVisible(), false);
    await recipient.selectOption("", { force: true });

    // @-mention autocomplete is a real listbox: rows are options, the textarea points at the active one.
    // aria-expanded is not allowed on a textbox, so the open state is the list plus aria-activedescendant.
    const mentionList = page.locator("#mention-list");
    assert.equal(await input.getAttribute("aria-expanded"), null);
    assert.equal(await input.getAttribute("aria-autocomplete"), "list");
    await input.click();
    await page.keyboard.type("Hi @");
    await mentionList.waitFor({ state: "visible" });
    assert.equal(await mentionList.getAttribute("role"), "listbox");
    const options = mentionList.locator('[role="option"]');
    assert.ok(await options.count() >= 2, "an empty @ query lists every active member");
    assert.equal(await mentionList.locator("button, [aria-selected]:not([role='option'])").count(), 0, "aria-selected only on options, no nested buttons");
    assert.equal(await options.first().getAttribute("aria-selected"), "true");
    assert.equal(await options.first().getAttribute("id"), "mention-option-0");
    assert.equal(await input.getAttribute("aria-expanded"), null);
    assert.equal(await input.getAttribute("aria-activedescendant"), "mention-option-0");
    await page.keyboard.press("ArrowDown");
    assert.equal(await input.getAttribute("aria-activedescendant"), "mention-option-1");
    assert.equal(await options.nth(1).getAttribute("aria-selected"), "true");
    assert.equal(await options.first().getAttribute("aria-selected"), "false");
    await page.keyboard.press("Escape");
    await mentionList.waitFor({ state: "hidden" });
    assert.equal(await input.getAttribute("aria-expanded"), null);
    assert.equal(await input.getAttribute("aria-activedescendant"), null);
    assert.equal(await input.inputValue(), "Hi @");
    await page.keyboard.type("may");
    await mentionList.waitFor({ state: "visible" });
    assert.equal(await options.count(), 1);
    await mentionList.locator("[data-mention-id='maya']").click();
    await mentionList.waitFor({ state: "hidden" });
    assert.match(await input.inputValue(), /@Maya/);
    assert.equal(await page.locator("#message-to-select").inputValue(), "", "an inserted @mention is text-only and never selects a DM recipient");
    assert.equal(await page.evaluate(() => document.activeElement.id), "message-input");
    await input.fill("");
    await input.click();
    await page.keyboard.type(":fire");
    const emojiList = page.locator("#emoji-list");
    await emojiList.waitFor({ state: "visible" });
    assert.equal(await emojiList.getAttribute("role"), "listbox");
    assert.equal(await emojiList.locator('[role="option"]').first().getAttribute("aria-selected"), "true");
    await page.keyboard.press("Enter");
    assert.equal(await input.inputValue(), "🔥 ");
    assert.equal((await input.inputValue()).includes(":fire"), false);
    assert.equal(await emojiList.isHidden(), true);
    assert.equal(await mentionList.isHidden(), true);
    await input.fill("");
    const topic = page.locator('[data-message-record-id="topic"]');
    assert.equal(await topic.locator('.reactions button').count(), 0, "no unused reaction pills beneath messages");
    assert.equal(await topic.locator('.reaction-options').count(), 0, "no always-visible reaction picker");
    // Add Reaction lives in the ⋯ menu and opens a reaction sheet (long-press /
    // right-click open it too). Tapping a reaction toggles it and closes the sheet.
    const moreActions = topic.locator('summary[aria-label="More actions for this message"]');
    await moreActions.focus();
    await page.keyboard.press("Enter");
    await topic.locator('button[data-message-action="add-reaction"]').click();
    const sheet = page.locator("#reaction-sheet");
    const THINKING = "\u{1F914}";
    const LIKE = "\u{1F44D}";
    await sheet.waitFor({ state: "visible" });
    assert.equal(await page.evaluate(() => document.activeElement.id), "reaction-search");
    send(T.MESSAGE_REACTION_SET, { messageId: "topic", reaction: "thinking", active: true });
    await topic.locator(`.reactions [data-reaction="${THINKING}"]`).waitFor();
    assert.equal(await sheet.isVisible(), true, "live changes keep the open sheet");
    send(T.MESSAGE_REACTION_SET, { messageId: "topic", reaction: "thinking", active: false });
    await topic.locator(`.reactions [data-reaction="${THINKING}"]`).waitFor({ state: "detached" });
    const sheetLike = sheet.locator(`[data-reaction="${LIKE}"]`).first();
    assert.equal(await sheetLike.isVisible(), true);
    const sheetBounds = await sheet.boundingBox();
    assert.ok(sheetBounds.x >= 0 && sheetBounds.x + sheetBounds.width <= viewport.width, "sheet fits narrow and desktop screens");
    await sheetLike.click();
    await sheet.waitFor({ state: "hidden" });
    await page.waitForFunction(glyph => document.querySelector(`[data-message-record-id="topic"] [data-reaction="${glyph}"]`).getAttribute("aria-pressed") === "true", "\u{1F44D}");

    assert.equal(await topic.locator('.reactions button').count(), 1, "only the used reaction remains visible");
    assert.equal(await page.evaluate(() => document.activeElement.closest("li.message")?.dataset.messageRecordId), "topic", "closing the sheet returns focus to the message");
    const like = topic.locator('[data-reaction="\u{1F44D}"]');

    // Error toasts persist until dismissed and can be selected/copied; successes still auto-clear.
    await page.route("**/api/rooms/commons/commands", route => route.fulfill({
      status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "unavailable", message: "Reaction store unavailable" } })
    }));
    const toast = page.locator("#status");
    await like.click();
    await page.waitForFunction(() => document.querySelector("#status").classList.contains("error"));
    assert.match(await toast.locator(".status-text").textContent(), /Reaction store unavailable/);
    assert.equal(await toast.getAttribute("role"), "alert");
    assert.equal(await toast.getAttribute("aria-live"), "assertive");
    assert.deepEqual(await toast.evaluate(node => [getComputedStyle(node).pointerEvents, getComputedStyle(node).userSelect]), ["auto", "text"]);
    const dismiss = toast.getByRole("button", { name: "Dismiss error" });
    assert.equal(await dismiss.isVisible(), true);
    assert.equal(await toast.evaluate(node => { const range = document.createRange(); range.selectNodeContents(node.querySelector(".status-text")); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); const text = selection.toString(); selection.removeAllRanges(); return text; }).then(t => /Reaction store unavailable/.test(t)), true, "error text is selectable");
    await dismiss.click();
    assert.equal(await toast.textContent(), "");
    assert.equal(await toast.evaluate(node => node.classList.contains("visible")), false);
    assert.equal(await toast.getAttribute("role"), "status");
    await page.unroute("**/api/rooms/commons/commands");
    await page.locator('[data-message-record-id="topic"] button[data-reaction="\u{1F44D}"]').click();
    // A cleared reaction detaches its chip (only used reactions stay visible),
    // so wait for detachment rather than an aria-pressed=false state that the
    // new UI never renders.
    await topic.locator('button[data-reaction="\u{1F44D}"]').waitFor({ state: "detached" });
    await openSearch(page);
    await page.locator("#search-mentions").click();
    assert.equal(await page.locator("#search-mentions").getAttribute("aria-pressed"), "true");
    assert.match(await page.locator("#search-results").textContent(), /Ping @Room owner/);
    await page.locator("#clear-search").click();
    assert.equal(await page.locator("#search-results").isHidden(), true);
    assert.equal(await page.locator("#search-mentions").getAttribute("aria-pressed"), "false");
    await page.locator('[data-message-record-id="topic"] [data-message-action="thread"]').click();
    assert.match(await input.getAttribute("placeholder"), /Reply in thread/);
    await page.locator("#thread-back").click();
    assert.match(await input.getAttribute("placeholder"), /Message #/);
    assert.equal(await page.locator("#composer-options").count(), 1);
    assert.equal(await page.locator("#remember-drafts").count(), 0);
    const waitForFailure = () => page.waitForFunction(() => !document.querySelector("#message-input").disabled && document.querySelector("#composer-status").classList.contains("error"));
    const waitForSaved = () => page.waitForFunction(() => !document.querySelector("#message-input").disabled && document.querySelector("#message-input").value === "");

    // A live membership change must never turn a private draft into a public post.
    await page.locator("#message-to-select").selectOption("maya", { force: true });
    await input.fill("Private draft retained while Maya is unavailable");
    send(T.MEMBER_ACCESS_CHANGED, { memberId: "maya", expectedMemberRevision: 0, permissions: [], active: false });
    await page.waitForFunction(() => document.querySelector('#message-to-select option[value="maya"]')?.disabled);
    assert.equal(await page.locator("#message-to-select").inputValue(), "maya");
    await page.locator("#composer-options > summary").click();
    await page.locator("#conversation-title").click();
    assert.equal(await optionsDisclosure.evaluate(node => node.open), false, "clicking outside closes only the options");
    assert.equal(await input.inputValue(), "Private draft retained while Maya is unavailable");
    assert.equal(await page.locator("#message-to-select").inputValue(), "maya");
    const beforeUnavailableSend = store.room("commons").sequence;
    const privateRequest = page.waitForRequest(request => request.url().endsWith("/commands") && request.method() === "POST");
    await input.focus(); await page.keyboard.press("Control+Enter");
    assert.equal((await privateRequest).postDataJSON().data.toMemberId, "maya");
    await waitForFailure();
    assert.equal(await input.inputValue(), "Private draft retained while Maya is unavailable");
    assert.equal(store.room("commons").sequence, beforeUnavailableSend, "unavailable private recipient creates no public or private message");
    send(T.MEMBER_ACCESS_CHANGED, { memberId: "maya", expectedMemberRevision: 1, permissions: [], active: true });
    await page.waitForFunction(() => document.querySelector('#message-to-select option[value="maya"]')?.disabled === false);
    await input.focus(); await page.keyboard.press("Control+Enter");
    await waitForSaved();
    const recoveredPrivate = store.room("commons").state.messages.filter(message => message.body === "Private draft retained while Maya is unavailable");
    assert.equal(recoveredPrivate.length, 1); assert.equal(recoveredPrivate[0].toMemberId, "maya");
    await page.locator("#message-to-select").selectOption("", { force: true });

    await input.fill("A separate room draft");
    await page.locator('[data-message-record-id="topic"] [data-message-action="thread"]').click();
    await page.locator('[data-message-record-id="reply"] [data-message-action="reply"]').click();
    await page.locator("#message-to-select").selectOption("maya", { force: true });
    await input.fill("Keep this thread reply");
    await input.focus();
    await input.evaluate(e => e.setSelectionRange(5, 9, "backward"));
    const commandIds = [];
    let loseResponse = true;
    await page.route("**/api/rooms/commons/commands", async route => {
      commandIds.push(route.request().postDataJSON().id);
      if (loseResponse) { loseResponse = false; await route.fetch(); await route.abort("failed"); }
      else await route.continue();
    });
    await page.keyboard.press("Control+Enter");
    await waitForFailure();
    assert.equal(await page.evaluate(() => document.activeElement.id), "message-input", "failed keyboard send restores its initiating field");
    assert.deepEqual(await input.evaluate(e => [e.selectionStart, e.selectionEnd, e.selectionDirection]), [5, 9, "backward"]);
    const threadError = await status.textContent();
    assert.ok(threadError.length > 0);
    assert.equal(await page.locator("#status").textContent().then(s => s.includes("Draft kept")), false, "one send-error announcement region");
    await page.locator("#thread-back").click();
    assert.equal(await input.inputValue(), "A separate room draft");
    assert.equal(await status.textContent(), "", "a thread's send error cannot describe a different draft");
    await page.locator('[data-message-record-id="topic"] [data-message-action="thread"]').click();
    assert.equal(await status.textContent(), threadError, "returning to the failed draft restores its recovery message");
    assert.equal(await input.inputValue(), "Keep this thread reply");
    assert.equal(await page.locator("#message-to-select").inputValue(), "maya");
    assert.match(await page.locator("#reply-context").textContent(), /short story/);
    page.once("dialog", dialog => dialog.accept());
    await page.reload();
    await page.locator("#main").waitFor({ state: "visible" });
    assert.equal(await input.inputValue(), "Keep this thread reply");
    await input.focus();
    await page.keyboard.press("Control+Enter");
    await waitForSaved();
    assert.equal(await page.evaluate(() => document.activeElement.id), "message-input", "successful keyboard send leaves the composer usable");
    assert.equal(await status.textContent(), "");
    assert.equal(commandIds.length, 2); assert.equal(commandIds[0], commandIds[1]);
    const messages = store.snapshot(owner, "commons").state.messages.filter(m => m.body === "Keep this thread reply");
    assert.equal(messages.length, 1); assert.equal(messages[0].replyToId, "reply"); assert.equal(messages[0].toMemberId, "maya");
    await page.unroute("**/api/rooms/commons/commands");

    // Explicit opt-in survives reload only after authenticating the same room.
    await input.fill("Recover this thread after reload");
    page.once("dialog", dialog => dialog.accept());
    await page.reload();
    await page.locator("#main").waitFor({ state: "visible" });
    assert.equal(await input.inputValue(), "Recover this thread after reload");
    await page.locator("#thread-back").click();
    assert.equal(await input.inputValue(), "A separate room draft");
    const stored = await page.evaluate(() => sessionStorage.getItem("project-room:drafts:v3"));
    assert.match(stored, /A separate room draft/);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("project-room:drafts:v2")), null);

    // Moving to search while a send is waiting is intentional focus movement.
    const intercepted = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    await page.route("**/api/rooms/commons/commands", async route => {
      const response = await route.fetch(); intercepted.resolve(); await release.promise;
      await route.fulfill({ response });
    });
    await input.fill("Saved while I search");
    await page.keyboard.press("Control+Enter");
    await intercepted.promise;
    assert.equal(await page.locator("#message-form").getAttribute("aria-busy"), "true");
    await page.locator("#topbar-search-toggle").click();
    await page.locator("#message-search").fill("short story");
    release.resolve();
    await waitForSaved();
    assert.equal(await page.evaluate(() => document.activeElement.id), "message-search", "completion does not steal focus from search");
    assert.equal(await page.locator("#message-form").getAttribute("aria-busy"), null);
    await page.unroute("**/api/rooms/commons/commands");
    await page.locator("#clear-search").click();

    // A composition-confirmation key is not a send shortcut, including the legacy IME signal.
    await input.fill("検討中の文章");
    await input.focus();
    for (const options of [{ isComposing: true, keyCode: 13 }, { isComposing: false, keyCode: 229 }, { repeat: true, keyCode: 13 }]) {
      const prevented = await input.evaluate((e, options) => {
        const key = new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true, ...options });
        e.dispatchEvent(key); return key.defaultPrevented;
      }, options);
      assert.equal(prevented, false, "composition/repeated key is left to text entry");
      assert.equal(await input.inputValue(), "検討中の文章");
    }
    await page.keyboard.press("End");
    await page.keyboard.press("Shift+Enter");
    assert.equal(await input.inputValue(), "検討中の文章\n", "Shift+Enter inserts a line");
    await page.keyboard.press("Enter");
    await waitForSaved();
    assert.equal(store.snapshot(owner, "commons").state.messages.filter(m => m.body === "検討中の文章").length, 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);

    // Access loss clears both visible error text and the errors saved with other drafts.
    await page.route("**/api/rooms/commons/commands", route => route.abort("failed"));
    await input.fill("Unsent before access ended");
    await page.keyboard.press("Control+Enter");
    await waitForFailure();
    const rotated = store.issueAccessKey("commons", "owner");
    await page.locator("#auth-panel").waitFor({ state: "visible" });
    assert.equal(await status.textContent(), "", "access loss clears the former session's send error");
    // E-H2: unexpected access loss preserves the in-flight draft (was: cleared).
    assert.equal(await input.inputValue(), "Unsent before access ended",
      "unexpected access loss preserves the in-flight draft for re-authentication");
    assert.equal(await page.locator("#message-form").getAttribute("aria-busy"), null);
    await page.unroute("**/api/rooms/commons/commands");
    await login(rotated);
    await page.locator('[data-message-record-id="topic"] [data-message-action="thread"]').click();
    assert.equal(await input.inputValue(), ""); assert.equal(await status.textContent(), "");
    assert.deepEqual(errors, []);
  });
}

// R26-1 (QA loop r26, 2026-10-10): a member who is reading a little above the
// newest message (on a phone the Room card alone leaves a fresh load ~150 px off
// the bottom) sends a message. Their own message must come into view, and the
// "N new messages · jump to latest" pill must not count it.
const OWN_SEND_SIZES = [["phone 390", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }], ["desktop 1280", { viewport: { width: 1280, height: 860 } }]];
for (const [label, size] of OWN_SEND_SIZES) {
  test(`(${label}) after returning to unread history, sending brings your own message into view, with no "new message" pill for it`, { timeout: 60000 }, async t => {
    const directory = mkdtempSync(join(tmpdir(), "room-own-send-"));
    const store = new RoomStore(join(directory, "room.sqlite"));
    store.initialize(initialRoom());
    const owner = store.issueAccessKey("commons", "owner");
    const send = (type, data) => store.command(owner, "commons", { id: crypto.randomUUID(), type, data });
    send(T.MEMBER_ADDED, { memberId: "maya", displayName: "Maya", kind: "human", permissions: [] });
    send(T.MESSAGE_POSTED, { messageId: "hello", body: "Welcome, Maya" });
    const maya = store.issueAccessKey("commons", "maya");
    const server = createRoomServer({ store, streamInterval: 40 });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
    t.after(async () => {
      await browser.close(); server.closeStreams(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true });
    });
    const page = await (await browser.newContext({ ...size, reducedMotion: "reduce" })).newPage();
    page.setDefaultTimeout(10000);
    const errors = []; page.on("pageerror", e => errors.push(e.message));
    await page.goto(origin);
    await page.locator("#auth-panel").waitFor({ state: "visible" });
    await signInFixture(page, maya);
    await page.locator("#main").waitFor({ state: "visible" });
    await page.locator("#message-list").getByText("Welcome, Maya").waitFor();
    await page.waitForTimeout(1500); // Maya has read the room; her read cursor is saved.
    // While Maya is away the room moves on: she comes back to unread history.
    for (let i = 0; i < 24; i++) send(T.MESSAGE_POSTED, { messageId: `m${i}`, body: `While you were away ${i}` });
    await page.reload();
    await page.locator("#main").waitFor({ state: "visible" });
    await page.locator("#message-list").getByText("While you were away 23").waitFor({ state: "attached" });
    await page.waitForTimeout(500);
    // Maya reads a little above the newest message (on a phone the Room card and
    // composer status alone push the list ~150 px off the bottom after load).
    await page.locator("#message-list").evaluate(l => { l.scrollTop = Math.max(0, l.scrollHeight - l.clientHeight - 200); });
    await page.waitForTimeout(200);
    const list = page.locator("#message-list");
    for (const [n, body] of [[1, "first thing I say here"], [2, "and a second one"]]) {
      await page.locator("#message-input").fill(body);
      await page.locator('#message-form button[type="submit"]').click();
      const mine = list.locator("li").filter({ hasText: body }).last();
      await mine.waitFor({ state: "visible" });
      await page.waitForTimeout(400);
      const box = await list.boundingBox(), row = await mine.boundingBox();
      assert.ok(row.y + row.height <= box.y + box.height + 1 && row.y >= box.y - 1,
        `send ${n}: own message is inside the visible message list (row ${Math.round(row.y)}-${Math.round(row.y + row.height)}, list ${Math.round(box.y)}-${Math.round(box.y + box.height)})`);
      assert.equal(await page.locator("#new-messages-button").isVisible(), false, `send ${n}: no "jump to latest" pill for your own message`);
    }
    assert.deepEqual(errors, []);
  });
}
