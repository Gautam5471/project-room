// R32-2 repro: on a phone, tapping a person in People puts "@Name " into the
// composer and focuses it, but the drawer stays open over the composer, so
// nothing visible happens. Local server, synthetic fixture only.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { signInFixture } from "./auth-signin.mjs";

test("phone 390: tapping a person in People shows the composer with their mention", { timeout: 60000 }, async t => {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const errors = [];
  t.after(async () => {
    await browser.close();
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" })).newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin); await page.locator("#auth-panel").waitFor({ state: "visible" });
  await signInFixture(page, f.keys.owner); await page.locator("#main").waitFor({ state: "visible" });
  await page.locator("#sidebar-toggle").click();
  const panel = page.locator("#people-panel");
  await panel.waitFor({ state: "visible" });
  if (!(await panel.evaluate(node => node.open))) await page.locator("#people-panel > summary").click();
  const row = page.locator('#people-panel [data-member-record-id="guest"] .member-handle');
  await row.tap();
  await assert.doesNotReject(page.waitForFunction(() => document.querySelector("#message-input").value.includes("@Test guest")));
  // The mention is only useful if the person can see where it went.
  await page.waitForTimeout(400);
  const composerOnTop = await page.locator("#message-input").evaluate(input => {
    const r = input.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + Math.min(40, r.width / 2), r.top + r.height / 2);
    return input === hit || input.contains(hit);
  });
  assert.equal(composerOnTop, true, "the composer holding the new mention is not covered by the People drawer");
});
