// Synthetic browser fixtures. These checks do not stand in for physical-device or human AT runs.
// Pins two composer fixes from muse-room QA: another member's file chips
// appear live (12650), and the composer grows with its text (12680).
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

test("composer: live file chips for other members, autosize", { timeout: 60000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-live-files-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  store.command(owner, "commons", { id: crypto.randomUUID(), type: T.MEMBER_ADDED, data: { memberId: "maya", displayName: "Maya", kind: "human", permissions: [] } });
  const maya = store.issueAccessKey("commons", "maya");
  const server = createRoomServer({ store, streamInterval: 50 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  t.after(async () => {
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const errors = [];
  const open = async key => {
    const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })).newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin);
    await page.locator("#auth-panel").waitFor({ state: "visible" });
    await signInFixture(page, key);
    await page.locator("#main").waitFor({ state: "visible" });
    return page;
  };
  const ownerPage = await open(owner), mayaPage = await open(maya);
  const input = ownerPage.locator("#message-input");

  // 12680: eight pasted lines grow the composer instead of hiding six of them.
  const before = await input.evaluate(el => el.getBoundingClientRect().height);
  await input.fill(Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"));
  const grown = await input.evaluate(el => ({ height: el.getBoundingClientRect().height, hidden: el.scrollHeight - el.clientHeight }));
  assert.ok(grown.height > before + 40, `composer grows with its text (${before} -> ${grown.height})`);
  await input.fill("");
  assert.ok(await input.evaluate(el => el.getBoundingClientRect().height) <= before + 1, "an empty composer shrinks back");

  // 12650: Maya sees the owner's file chip without reloading.
  await ownerPage.locator("#composer-file").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await ownerPage.locator(".composer-files .file-chip, #composer-files .file-chip").first().waitFor({ state: "visible" }).catch(() => {});
  await ownerPage.waitForFunction(() => !document.querySelector("[aria-busy='true']#message-form"), null, { timeout: 5000 }).catch(() => {});
  await input.fill("with a file");
  await ownerPage.locator('#message-form button[type="submit"]').click();
  await mayaPage.locator('#message-list [data-download-file]', { hasText: "notes.txt" }).waitFor({ state: "visible", timeout: 10000 });

  // A blocked file type reads as plain copy.
  await ownerPage.locator("#composer-file").setInputFiles({ name: "tool.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") });
  await ownerPage.waitForFunction(() => /isn’t allowed/.test(document.querySelector("#composer-status")?.textContent || ""), null, { timeout: 5000 });
  assert.doesNotMatch(await ownerPage.locator("#composer-status").innerText(), /blocked for security/);
  assert.deepEqual(errors, []);
});
