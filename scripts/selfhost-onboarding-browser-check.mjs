// Owns empty-database startup + browser persistence across the actual server
// process boundary. Fixture-based auth tests do not exercise boot configuration,
// disk persistence or process restart. No production seam or model is involved.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));

test("self-host: empty database signup, chat, restart and fresh-browser login preserve the same room", { timeout: 60000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-selfhost-onboarding-"));
  let child, exited, browser;
  const stop = async () => {
    if (!child) return;
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => child?.kill("SIGKILL"), 5000);
    try { await exited; } finally { clearTimeout(killTimer); child = null; }
  };
  t.after(async () => {
    try { await browser?.close(); } finally {
      try { await stop(); } finally { rmSync(directory, { recursive: true, force: true }); }
    }
  });
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const start = async () => {
    // Do not inherit local deployment credentials, mailers, model keys or jobs.
    child = spawn(process.execPath, ["server.mjs"], { cwd: root, stdio: "ignore", env: {
      PATH: process.env.PATH, TMPDIR: directory, NODE_ENV: "development",
      HOST: "127.0.0.1", PORT: String(port), ROOM_ORIGIN: origin,
      ROOM_DB: join(directory, "room.sqlite"),
    } });
    let startupError;
    exited = new Promise(resolve => {
      child.once("exit", resolve);
      child.once("error", error => { startupError = error; resolve(); });
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (startupError) throw startupError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("Self-host service exited before readiness");
      try {
        const response = await fetch(origin, { signal: AbortSignal.timeout(500) });
        await response.arrayBuffer();
        if (response.ok) return;
      } catch { /* Wait for the real HTTP listener, not the first log line. */ }
      await delay(100);
    }
    throw new Error("Self-host service did not become ready");
  };
  await start();
  browser = await chromium.launch({ headless: true,
    ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  const form = page.locator('#auth-signin-ui [data-signin-form="password"]');
  const email = "selfhost-contributor@example.invalid", password = crypto.randomUUID();
  await form.locator('[name="email"]').fill(email);
  await form.locator('[name="password"]').fill(password);
  await form.locator('button[type="submit"]').click();
  await page.locator("#main").waitFor({ state: "visible" });
  const roomId = new URL(page.url()).searchParams.get("room");
  assert.match(roomId, /^personal-/);
  const message = "I can reproduce the invitation bug and share a fix.";
  await page.locator("#message-input").fill(message);
  await page.locator("#message-input").press("Enter");
  const sent = page.locator("[data-message-record-id]").filter({ hasText: message });
  await sent.waitFor();
  assert.equal(await sent.count(), 1);
  await page.goto("about:blank");
  await stop();
  await start();
  await page.goto(`${origin}/?room=${roomId}`);
  await page.locator("#main").waitFor({ state: "visible" });
  await sent.waitFor();
  assert.equal(await sent.count(), 1, "the committed message survives server restart exactly once");
  assert.equal(new URL(page.url()).searchParams.get("room"), roomId);
  assert.deepEqual(errors, []);
  await context.close();

  const fresh = await browser.newContext();
  const returning = await fresh.newPage();
  returning.setDefaultTimeout(10000);
  await returning.goto(`${origin}/?room=${roomId}`);
  await returning.getByRole("button", { name: "Log in", exact: true }).click();
  const login = returning.locator('#auth-signin-ui [data-signin-form="password"]');
  await login.locator('[name="email"]').fill(email);
  await login.locator('[name="password"]').fill(password);
  await login.locator('button[type="submit"]').click();
  await returning.locator("#main").waitFor({ state: "visible" });
  await returning.locator("[data-message-record-id]").filter({ hasText: message }).waitFor();
  assert.equal(new URL(returning.url()).searchParams.get("room"), roomId, "login returns to the original room");
  await fresh.close();
});
