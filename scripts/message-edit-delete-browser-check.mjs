// R48-1: people can edit and delete their own messages from the web app.
// Red before the patch (no controls exist), green after. Disposable rooms only.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { signInFixture } from "./auth-signin.mjs";

async function setup(t) {
  const f = createAcceptanceFixture({ managedProducer: false }), server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" }), errors = [], outside = [];
  page.setDefaultTimeout(8000); page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) { outside.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  await page.goto(origin);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await signInFixture(page, f.keys.owner); await page.locator("#main").waitFor({ state: "visible" });
  t.after(() => { assert.deepEqual(errors, [], "no page errors"); assert.deepEqual(outside, []); });
  return { ...f, page };
}
async function post(page, body) {
  await page.locator("#message-input").fill(body);
  await page.locator("#message-form button[type=submit]").click();
  await page.locator("#message-list .message-body", { hasText: body.slice(0, 40) }).first().waitFor({ state: "visible" });
}
const row = (page, text) => page.locator("#message-list li.message", { hasText: text }).first();
async function openMenu(page, text) { await row(page, text).locator("details.message-more > summary").click(); }

test("own messages can be edited and deleted from the overflow menu", { timeout: 60000 }, async t => {
  const { page, store } = await setup(t);
  await post(page, "first draft of the plan");

  await openMenu(page, "first draft of the plan");
  const menu = row(page, "first draft of the plan").locator(".message-more-menu");
  assert.equal(await menu.getByRole("button", { name: "Edit message" }).count(), 1, "own message offers Edit message");
  assert.equal(await menu.getByRole("button", { name: "Delete message" }).count(), 1, "own message offers Delete message");

  // Edit, including an HTML injection probe: it must render as text, never run.
  await menu.getByRole("button", { name: "Edit message" }).click();
  const dialog = page.locator("#message-edit-dialog");
  await dialog.waitFor({ state: "visible" });
  assert.equal(await page.locator("#message-edit-input").inputValue(), "first draft of the plan");
  const probe = `second draft <img src=x onerror="window.__pwn=1"> <script>window.__pwn=2</script>`;
  await page.locator("#message-edit-input").fill(probe);
  await dialog.getByRole("button", { name: "Save" }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.locator("#message-list .message-body", { hasText: "second draft" }).first().waitFor({ state: "visible" });
  assert.equal(await page.evaluate(() => window.__pwn), undefined, "edit body is never executed");
  assert.equal(await page.locator("#message-list .message-body img, #message-list .message-body script").count(), 0, "edit body is escaped, not parsed");
  assert.match(await row(page, "second draft").locator(".message-body").innerText(), /<img src=x/);
  const edited = store.room("commons").state.messages.find(m => m.body === probe);
  assert.ok(edited && edited.revision === 1 && edited.editedAt, "server recorded one edit at the expected revision");

  // Empty edit is refused client-side and nothing is sent.
  await openMenu(page, "second draft");
  await row(page, "second draft").locator(".message-more-menu").getByRole("button", { name: "Edit message" }).click();
  await page.locator("#message-edit-input").fill("   ");
  await dialog.getByRole("button", { name: "Save" }).click();
  await page.locator("#message-edit-status").getByText("empty").waitFor();
  assert.equal(store.room("commons").state.messages.find(m => m.id === edited.id).revision, 1);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await dialog.waitFor({ state: "hidden" });

  // Delete asks first; Cancel leaves the message alone, Delete tombstones it.
  await openMenu(page, "second draft");
  await row(page, "second draft").locator(".message-more-menu").getByRole("button", { name: "Delete message" }).click();
  const del = page.locator("#message-delete-dialog");
  await del.waitFor({ state: "visible" });
  await del.getByRole("button", { name: "Cancel" }).click();
  await del.waitFor({ state: "hidden" });
  assert.equal(store.room("commons").state.messages.find(m => m.id === edited.id).deletedAt, undefined);
  await openMenu(page, "second draft");
  await row(page, "second draft").locator(".message-more-menu").getByRole("button", { name: "Delete message" }).click();
  await del.getByRole("button", { name: "Delete", exact: true }).click();
  await del.waitFor({ state: "hidden" });
  await page.locator("#message-list .message-tombstone").first().waitFor({ state: "visible" });
  const gone = store.room("commons").state.messages.find(m => m.id === edited.id);
  assert.ok(gone.deletedAt && gone.body == null, "server tombstoned the message");
  assert.equal(await page.locator("#message-list li.message", { hasText: "second draft" }).count(), 0, "text is gone from the DOM");
});

test("edit and delete dialogs: long edits are bounded by the server limit, Delete is destructive, previews do not split emoji", { timeout: 60000 }, async t => {
  const { page, store } = await setup(t);
  const emoji = "\u{1F600}";
  await post(page, emoji.repeat(150) + " tail");
  await openMenu(page, "tail");
  await row(page, "tail").locator(".message-more-menu").getByRole("button", { name: "Delete message" }).click();
  const del = page.locator("#message-delete-dialog");
  await del.waitFor({ state: "visible" });
  const preview = await page.locator("#message-delete-source").textContent();
  assert.doesNotMatch(preview, /[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/, "preview never ends on half an emoji");
  assert.match(await del.getByRole("button", { name: "Delete", exact: true }).getAttribute("class"), /\bdestructive\b/);
  assert.doesNotMatch(await del.getByRole("button", { name: "Delete", exact: true }).getAttribute("class"), /\bprimary\b/);
  await del.getByRole("button", { name: "Cancel" }).click();
  await openMenu(page, "tail");
  await row(page, "tail").locator(".message-more-menu").getByRole("button", { name: "Edit message" }).click();
  const input = page.locator("#message-edit-input");
  assert.equal(await input.getAttribute("maxlength"), null, "no 16000 cap shorter than the server limit");
  const long = "a".repeat(20000);
  await input.fill(long);
  await page.locator("#message-edit-dialog").getByRole("button", { name: "Save" }).click();
  await page.locator("#message-edit-dialog").waitFor({ state: "hidden" });
  assert.equal(store.room("commons").state.messages.find(m => m.body === long)?.revision, 1, "a 20k edit saves");
  await openMenu(page, "aaaa");
  await row(page, "aaaa").locator(".message-more-menu").getByRole("button", { name: "Edit message" }).click();
  await input.fill("b".repeat(65537));
  await page.locator("#message-edit-dialog").getByRole("button", { name: "Save" }).click();
  await page.locator("#message-edit-status").getByText("too long").waitFor();
  assert.equal(store.room("commons").state.messages.find(m => m.body === long).revision, 1, "over-limit edit is refused before sending");
});
