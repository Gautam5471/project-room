import { clickChrome, ensureSidebarClosed } from "./room-chrome.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { signInFixture } from "./auth-signin.mjs";

async function setup(t, mobile = false) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile });
  page.setDefaultTimeout(8000);
  const errors = [], outside = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) { outside.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true }); assert.deepEqual(errors, []); assert.deepEqual(outside, []);
  });
  await page.goto(origin); await signInFixture(page, f.keys.owner);
  await page.locator("#main").waitFor({ state: "visible" });
  const reveal = async () => {
    if (!(await page.locator("#room-sidebar").isVisible())) {
      await page.locator("#sidebar-toggle").click();
      await page.locator("#room-sidebar").waitFor({ state: "visible" });
    }
    if (!(await page.locator("#invite-navigation").evaluate(node => node.open))) await page.locator("#invite-navigation > summary").click();
    await page.locator("#connect-agent-button").waitFor({ state: "visible" });
  };
  await reveal();
  const open = async () => { await reveal(); await clickChrome(page, "#connect-agent-button"); await page.locator("#agent-connect-dialog").waitFor({ state: "visible" }); };
  const create = async () => { await page.locator("#agent-connect-name").fill("Synthetic Claude"); await page.locator("#agent-create").click(); };
  const config = async () => { await page.locator("#agent-private-details > summary").click(); await page.waitForFunction(() => document.querySelector("#agent-private-config").value.length > 0); return JSON.parse(await page.locator("#agent-private-config").inputValue()); };
  const capture = async name => { mkdirSync("test-results", { recursive: true }); await page.screenshot({ path: `test-results/agent-connect-${name}.png` }); };
  return { ...f, page, origin, open, create, config, capture };
}

test("Invite reveals agent setup independently of the People disclosure", { timeout: 20000 }, async t => {
  const f = await setup(t);
  assert.equal(await f.page.locator("#connect-agent-button").isVisible(), true);
  assert.equal(await f.page.locator("#people-panel").evaluate(node => node.contains(document.getElementById("connect-agent-button"))), false);
  await f.page.locator("#people-panel").evaluate(node => { node.open = false; });
  assert.equal(await f.page.locator("#connect-agent-button").isVisible(), true, "Add agent must not live behind the People disclosure");
  await f.capture("add-agent-visible");
});

test("Invite reveals agent setup from the mobile sidebar", { timeout: 20000 }, async t => {
  const f = await setup(t, true);
  assert.equal(await f.page.locator("#room-sidebar").isVisible(), true);
  assert.equal(await f.page.locator("#connect-agent-button").isVisible(), true);
  await f.page.locator("#people-panel").evaluate(node => { node.open = false; });
  assert.equal(await f.page.locator("#connect-agent-button").isVisible(), true);
  await f.capture("add-agent-visible-mobile");
});

test("browser owner issues digest-only setup; a real external client imports, reads, rotates and loses access", { timeout: 30000 }, async t => {
  const f = await setup(t), requests = [];
  f.page.on("request", request => { if (request.url().endsWith("/agent-connections") && request.method() === "POST") requests.push(request.postDataJSON()); });
  await f.open();
  assert.equal(await f.page.evaluate(() => document.activeElement?.dataset.agentType), "claude-code", "keyboard setup begins with the app choice");
  await f.page.keyboard.press("Enter");
  assert.equal(await f.page.locator("#agent-connect-name").inputValue(), "Claude Code");
  assert.equal(requests.length, 0, "choosing a host grants no access");
  await f.capture("desktop-form"); await f.create();
  await f.page.locator("#agent-setup").waitFor({ state: "visible" });
  assert.equal(await f.page.evaluate(() => document.activeElement?.id), "agent-setup-title");
  assert.match(await f.page.locator("#agent-setup").innerText(), /Host connection and replies have not been verified/);
  assert.equal(await f.page.locator("#agent-all-steps").evaluate(node => node.open), false, "full instructions wait until requested");
  assert.match(await f.page.locator("#agent-import-route").innerText(), /room_check_access/);
  // Owner-boundary regression: creating access must leave the host instructions
  // reachable. Previously they were inside the form hidden after issuance;
  // no existing test tried to open them from the actual setup screen.
  assert.equal(await f.page.locator("#agent-host-snippets > summary").isVisible(), true,
    "MCP host instructions remain reachable after access is created");
  await f.page.locator("#agent-host-snippets > summary").click();
  assert.equal(await f.page.locator("#agent-mcp-cli").isVisible(), true);
  assert.match(await f.page.locator("#agent-mcp-cli").innerText(), /claude mcp add/);
  await f.page.locator("#agent-host-snippets > summary").click();
  assert.equal(await f.page.locator("#agent-private-config").inputValue(), "", "reading instructions never reveals the key");
  await f.page.locator("#agent-all-steps > summary").click();
  assert.match(await f.page.locator("#agent-import-checklist").innerText(), /room_check_access/);
  assert.match(await f.page.locator("#agent-import-checklist").innerText(), /linked Room reply/);
  await f.page.locator("#agent-all-steps > summary").click();
  await f.capture("desktop-ready");
  assert.equal(await f.page.locator("#agent-local-client").evaluate(node => node.open), false);
  await f.page.locator("#agent-local-client > summary").click();
  assert.match(await f.page.locator("#agent-local-command").innerText(), /pbpaste \| node scripts\/agent-inbox\.mjs import/);
  const config = await f.config();
  await f.page.locator("#agent-private-details > summary").click();
  await f.page.waitForFunction(() => document.querySelector("#agent-private-config").value === "");
  await f.page.locator("#agent-host-snippets > summary").click();
  assert.equal((await f.page.locator("#agent-host-snippets").innerText()).includes(config.token), false,
    "placeholder host instructions never include the issued credential");
  assert.equal((await f.page.locator("body").innerText()).includes(config.token), false,
    "the private credential stays out of visible text after concealment");
  assert.equal(await f.page.locator("#agent-private-config").inputValue(), "");
  await f.page.locator("#agent-host-snippets > summary").click();
  assert.equal(JSON.stringify(requests).includes(config.token), false); assert.equal(requests[0].keyHash.length, 64);
  const env = { PATH: process.env.PATH }, directory = join(f.directory, "connection");
  const imported = await new Promise(resolve => {
    const child = spawn(process.execPath, ["scripts/agent-inbox.mjs", "import", directory], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
    child.on("exit", code => resolve({ code, stdout, stderr })); child.stdin.end(JSON.stringify(config));
  });
  assert.equal(imported.code, 0, imported.stderr); assert.equal(JSON.parse(imported.stdout).configurationSaved, true);
  assert.equal(imported.stdout.includes(config.token), false);
  assert.equal(statSync(join(directory, "connection.json")).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, "connection.json"))), config);
  const agent = new RoomAgentClient(config), before = f.store.room("commons").sequence;
  assert.equal((await agent.checkConnection()).status, "credential_accepted");
  const work = await agent.workContext("test-handoff"); assert.equal(work.work.id, "test-handoff");
  assert.equal(f.store.room("commons").sequence, before);
  await f.page.locator("#agent-connect-done").click();
  await f.page.locator("#agent-connect-advanced > summary").click();
  await f.page.getByText("Manage connections", { exact: true }).click();
  f.page.on("dialog", dialog => dialog.accept());
  await f.page.getByRole("button", { name: /Replace key/ }).click();
  await f.page.locator("#agent-setup").waitFor({ state: "visible" }); const replacement = await f.config();
  await assert.rejects(agent.checkConnection(), { status: 401 });
  const current = new RoomAgentClient(replacement); assert.equal((await current.checkConnection()).memberId, config.memberId);
  await f.page.locator("#agent-connect-done").click(); await f.page.getByRole("button", { name: /Disconnect/ }).click();
  await f.page.getByText("Room access ended.", { exact: true }).waitFor(); await assert.rejects(current.checkConnection(), { status: 401 });
  assert.equal(f.store.room("commons").state.members[config.memberId].active, false);
  assert.doesNotThrow(() => f.store.agentConnections.verify());
});

test("agent type catalog renders and click fills the same join path", { timeout: 25000 }, async t => {
  const f = await setup(t);
  await f.open();
  assert.equal(await f.page.locator("#agent-connect-advanced").evaluate(node => node.open), false);
  assert.equal(await f.page.locator("#agent-connect-access").isVisible(), true);
  assert.equal(await f.page.locator("#agent-connect-access").inputValue(), "contribute");
  const shots = process.env.ROOM_TEST_SCREENSHOT_DIR || "test-results/agent-connect";
  mkdirSync(shots, { recursive: true });
  await f.page.setViewportSize({ width: 1280, height: 800 });
  await f.page.screenshot({ path: `${shots}/add-agent-1280.png` });
  await f.page.setViewportSize({ width: 390, height: 844 });
  await f.page.screenshot({ path: `${shots}/add-agent-390.png` });
  await f.page.setViewportSize({ width: 1440, height: 1000 });
  const catalog = f.page.locator("#agent-type-catalog");
  await catalog.waitFor({ state: "visible" });
  for (const id of ["claude-code", "codex", "cursor", "hermes", "opencode", "pi", "grok-bot", "grok-build", "instinct", "muse"]) {
    assert.equal(await catalog.locator(`[data-agent-type="${id}"]`).count(), 1, id);
  }
  // UI calming #8 simplified the agent-type descriptions ("Best for local coding
  // sessions with MCP tools" became "Best for local coding sessions"). The
  // catalog text comes from innerText, which never contains markup, so assert
  // the shortened copy positively and the old suffix negatively instead.
  assert.equal(await f.page.locator("#agent-other-types").evaluate(node => node.open), false);
  assert.equal(await catalog.locator("button:visible").count(), 4);
  const catalogText = await catalog.innerText();
  assert.match(catalogText, /Best for local coding sessions/, 'the agent catalog keeps the shortened agent-type copy');
  assert.doesNotMatch(catalogText, /with MCP tools/, 'the old verbose agent-type suffix is gone');
  await f.page.locator('#agent-type-catalog button[data-agent-type="claude-code"]').click();
  assert.equal(await f.page.locator("#agent-connect-name").inputValue(), "Claude Code");
  assert.equal(await f.page.locator("#agent-connect-access").inputValue(), "contribute");
  assert.equal(await f.page.locator("#agent-connect-route").inputValue(), "mcp");
  assert.equal(await f.page.locator("#agent-roster-hint").isVisible(), false, "technical host guidance starts collapsed");
  await f.page.locator("#agent-connect-advanced > summary").click();
  assert.match(await f.page.locator("#agent-roster-hint").innerText(), /room_check_access/);
  await f.page.locator("#agent-connect-advanced > summary").click();
  assert.equal(await f.page.locator("#agent-create").isHidden(), false);
  const requests = [];
  f.page.on("request", request => { if (request.url().endsWith("/agent-connections") && request.method() === "POST") requests.push(request.postDataJSON()); });
  await f.page.locator("#agent-create").click();
  await f.page.locator("#agent-setup").waitFor({ state: "visible" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].agentType, "claude-code");
  assert.equal(requests[0].displayName, "Claude Code");
  assert.equal(requests[0].access, "contribute");
  assert.match(await f.page.locator("#agent-import-route").innerText(), /room_check_access/);
  assert.equal(f.store.room("commons").state.members[requests[0].memberId].agentType, "claude-code");
  await f.capture("catalog-claude-code");
  // Keep duplicate identity caution visible even with technical guidance closed.
  await f.page.waitForFunction(() => document.querySelector("#presence-list").textContent.includes("Claude Code"));
  await f.page.locator("#agent-connect-done").click();
  await f.page.locator('#agent-type-catalog button[data-agent-type="claude-code"]').click();
  assert.equal(await f.page.locator("#agent-connect-advanced").evaluate(node => node.open), false);
  assert.equal(await f.page.locator("#agent-name-warning").isVisible(), true);
  assert.match(await f.page.locator("#agent-name-warning").innerText(), /second identity/);
  await f.page.locator("#agent-connect-name").fill("Another assistant");
  assert.equal(await f.page.locator("#agent-name-warning").isVisible(), false);
  assert.equal(requests.length, 1, "the warning and name edit never create a second identity");
});

test("named roster fills Muse and Grok Build; Grok Build shows import checklist", { timeout: 25000 }, async t => {
  const f = await setup(t);
  await f.open();
  await f.page.locator("#agent-other-types > summary").click();
  await f.page.locator('[data-roster="muse"]').click();
  assert.equal(await f.page.locator("#agent-connect-name").inputValue(), "Muse");
  assert.equal(await f.page.locator("#agent-connect-access").inputValue(), "chat");
  assert.equal(await f.page.locator("#agent-connect-route").inputValue(), "packet");
  assert.equal(await f.page.locator("#agent-packet-today").isVisible(), true);
  assert.equal(await f.page.locator("#agent-create").isHidden(), true);
  // "Need a Room key later" moved into the collapsed Advanced group (UI calming #5).
  await f.page.locator("#agent-connect-advanced > summary").click();
  assert.equal(await f.page.locator("#agent-key-later").isVisible(), true);
  assert.match(await f.page.locator("#agent-roster-hint").innerText(), /has not contributed/);
  await f.page.locator('[data-roster="grok-build"]').click();
  assert.equal(await f.page.locator("#agent-connect-name").inputValue(), "Grok Build");
  assert.equal(await f.page.locator("#agent-connect-access").inputValue(), "contribute");
  assert.equal(await f.page.locator("#agent-connect-route").inputValue(), "mcp");
  assert.equal(await f.page.locator("#agent-packet-today").isHidden(), true);
  assert.equal(await f.page.locator("#agent-create").isHidden(), false);
  assert.match(await f.page.locator("#agent-capabilities").innerText(), /work drafts/);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM agent_connections").get().n, 0);
  await f.page.locator("#agent-create").click();
  await f.page.locator("#agent-setup").waitFor({ state: "visible" });
  assert.match(await f.page.locator("#agent-import-route").innerText(), /room_check_access/);
  await f.page.locator("#agent-all-steps > summary").click();
  assert.match(await f.page.locator("#agent-import-checklist").innerText(), /room_check_access/);
  await f.page.locator("#agent-copy-checklist").click();
  await f.page.waitForFunction(() => /plug-in steps|Select and copy/.test(document.querySelector("#agent-connect-status")?.textContent || ""));
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM agent_connections").get().n, 1);
});

test("unknown enrollment survives close and retries the original digest and identity", { timeout: 30000 }, async t => {
  const f = await setup(t), attempts = [];
  await f.page.route("**/agent-connections", async route => {
    if (route.request().method() !== "POST") return route.continue();
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 1) { await route.fetch(); return route.fulfill({ status: 200, json: {} }); }
    return route.continue();
  });
  await f.open(); await f.create(); await f.page.getByText("Change not confirmed. Retry the original.", { exact: true }).waitFor();
  assert.equal(await f.page.locator("#agent-connect-name").isDisabled(), true);
  await f.page.locator("#agent-connect-close").click(); await f.open(); await f.page.locator("#agent-create").click();
  await f.page.locator("#agent-setup").waitFor({ state: "visible" }); const config = await f.config();
  assert.deepEqual(attempts[0], attempts[1]); assert.equal(f.store.db.prepare("SELECT count(*) n FROM agent_connections").get().n, 1);
  assert.equal(f.store.authenticate(config.token).member.id, attempts[0].memberId);
});

test("mobile disclosure stays lightweight, fits the viewport and conceals setup on close", { timeout: 30000 }, async t => {
  const f = await setup(t, true); await f.open(); await f.capture("mobile-form"); await f.create();
  await f.page.locator("#agent-setup").waitFor({ state: "visible" });
  for (const selector of ["#agent-connect-title", "#agent-connect-close", "#agent-setup-title", "#agent-connect-done"]) {
    const box = await f.page.locator(selector).boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= 844, `${selector} stays in the mobile viewport after issuance`);
  }
  assert.equal(await f.page.locator("#agent-host-snippets > summary").isVisible(), true);
  await f.capture("mobile-ready");
  await f.page.locator("#agent-all-steps > summary").click();
  assert.equal(await f.page.locator('#agent-import-checklist').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true,
    'setup commands wrap within the mobile dialog');
  const config = await f.config();
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await f.page.keyboard.press("Escape");
  await f.page.locator("#agent-connect-dialog").waitFor({ state: "hidden" });
  await f.open();
  assert.equal(await f.page.locator("#agent-private-config").inputValue(), "");
  assert.equal(await f.page.locator("#agent-private-details").evaluate(node => node.open), false);
  assert.equal(await f.page.locator("#agent-host-snippets > summary").isVisible(), true, "safe host instructions survive closing and reopening setup");
  assert.equal((await new RoomAgentClient(config).checkConnection()).status, "credential_accepted");
  assert.match(await f.page.locator("#agent-setup").innerText(), /Host connection and replies have not been verified/,
    "a read-only credential check does not claim a running host or verified reply");
});

test("owned list access denial clears previously revealed setup", { timeout: 30000 }, async t => {
  const f = await setup(t); await f.open(); await f.create(); await f.page.locator("#agent-setup").waitFor({ state: "visible" }); await f.config();
  await f.page.locator("#agent-connect-close").click();
  await f.page.route("**/agent-connections", route => route.fulfill({ status: 403, json: { error: { code: "owner_required", message: "Access changed" } } }));
  await clickChrome(f.page, "#connect-agent-button"); await f.page.locator("#agent-connect-dialog").waitFor({ state: "hidden" });
  assert.equal(await f.page.locator("#agent-private-config").inputValue(), ""); assert.equal(await f.page.locator("#agent-setup").isVisible(), false);
});

test("snapshot access changes conceal a held private key", { timeout: 30000 }, async t => {
  const f = await setup(t); await f.open(); await f.create(); await f.page.locator("#agent-setup").waitFor({ state: "visible" }); const config = await f.config();
  f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type: T.MEMBER_ACCESS_CHANGED, data: {
    memberId: config.memberId, expectedMemberRevision: 0, permissions: [], active: false
  } });
  await f.page.getByText("Agent access changed. Review its connection.", { exact: true }).waitFor();
  assert.equal(await f.page.locator("#agent-private-config").inputValue(), ""); assert.equal(await f.page.locator("#agent-setup").isVisible(), false);
});

test("retained setup warns before sign-out; expiry prevents reveal or copy", { timeout: 30000 }, async t => {
  const f = await setup(t); await f.open(); await f.create(); await f.page.locator("#agent-setup").waitFor({ state: "visible" }); await f.config();
  await f.page.locator("#agent-connect-close").click();
  let warning;
  f.page.once("dialog", dialog => { warning = dialog.message(); return dialog.dismiss(); });
  if (await f.page.locator("#session-menu-button").isVisible()) await f.page.locator("#session-menu-button").click(); await clickChrome(f.page, "#signout-button"); assert.match(warning, /private setup/);
  await f.open();
  await f.page.evaluate(() => { const now = Date.now(); Date.now = () => now + 31 * 86400000; });
  await f.page.locator("#agent-private-details > summary").click();
  await f.page.getByText("This key expired. Replace it to reconnect.", { exact: true }).waitFor();
  assert.equal(await f.page.locator("#agent-private-config").inputValue(), "");
});

test("a rotation ahead of an older inactive snapshot keeps the new private setup", { timeout: 30000 }, async t => {
  const f = await setup(t); await f.open(); await f.create();
  await f.page.locator("#agent-setup").waitFor({ state: "visible" }); const original = await f.config();
  await f.page.locator("#agent-connect-done").click();
  let frozen, ready;
  const frozenReady = new Promise(resolve => { ready = resolve; });
  await f.page.route(`${f.origin}/api/rooms/commons`, async route => {
    if (!frozen) {
      const result = await (await route.fetch()).json();
      if (result.state.members[original.memberId]?.revision === 1) { frozen = result; ready(); }
      return route.fulfill({ json: result });
    }
    return route.fulfill({ json: frozen });
  });
  const change = (revision, active) => f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type: T.MEMBER_ACCESS_CHANGED,
    data: { memberId: original.memberId, expectedMemberRevision: revision, permissions: [], active } });
  change(0, false); await frozenReady; change(1, true);
  await f.page.locator("#agent-connect-close").click(); await f.open();
  await f.page.locator("#agent-connect-advanced > summary").click();
  await f.page.getByText("Manage connections", { exact: true }).click();
  f.page.once("dialog", dialog => dialog.accept());
  await f.page.getByRole("button", { name: /Replace key/ }).click();
  await f.page.locator("#agent-setup").waitFor({ state: "visible" }); const replacement = await f.config();
  await f.page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await f.page.locator("#agent-setup").isVisible(), true);
  assert.equal((await new RoomAgentClient(replacement).checkConnection()).memberId, original.memberId);
  assert.equal(f.store.authenticate(replacement.token).member.revision, 2);
});

test("incomplete 2xx enrollment metadata preserves the exact pending retry", { timeout: 30000 }, async t => {
  const f = await setup(t), attempts = [];
  await f.page.route("**/agent-connections", async route => {
    if (route.request().method() !== "POST") return route.continue();
    attempts.push(route.request().postDataJSON());
    const result = await (await route.fetch()).json();
    if (attempts.length === 1) result.receipt.membershipEventId = "";
    if (attempts.length === 2) delete result.connection.memberRevision;
    if (attempts.length === 3) result.connection.expiresAt++;
    return route.fulfill({ json: result });
  });
  await f.open(); await f.create();
  for (let attempt = 0; attempt < 3; attempt++) {
    await f.page.getByText("Change not confirmed. Retry the original.", { exact: true }).waitFor();
    assert.equal(await f.page.locator("#agent-setup").isVisible(), false);
    assert.equal(await f.page.locator("#agent-connect-name").isDisabled(), true);
    await f.page.locator("#agent-create").click();
  }
  await f.page.locator("#agent-setup").waitFor({ state: "visible" });
  assert.equal(attempts.length, 4); for (const attempt of attempts) assert.deepEqual(attempt, attempts[0]);
  const config = await f.config(); assert.equal(f.store.authenticate(config.token).member.id, attempts[0].memberId);
});

test("a delayed enrollment receipt cannot restore setup after owner access ends", { timeout: 30000 }, async t => {
  const f = await setup(t); let captured, release;
  const committed = new Promise(resolve => { captured = resolve; }), held = new Promise(resolve => { release = resolve; });
  await f.page.route("**/agent-connections", async route => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch(); captured(); await held; return route.fulfill({ response });
  });
  await f.open(); await f.create(); await committed;
  const account = f.store.authenticate(f.keys.owner).account;
  f.store.changeAccountAccess(account.id, { expectedRevision: account.revision, active: false, reason: "Synthetic access ended" });
  await f.page.locator("#main").waitFor({ state: "hidden" });
  const response = f.page.waitForResponse(result => result.url().endsWith("/agent-connections") && result.request().method() === "POST");
  release(); await response; await f.page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await f.page.locator("#agent-connect-dialog").isVisible(), false);
  assert.equal(await f.page.locator("#agent-private-config").inputValue(), "");
  assert.equal(await f.page.locator("#agent-setup").isVisible(), false);
});

test("a just-created connection reads as ready, not as a missing member, without a reload (R29-1)", { timeout: 30000 }, async t => {
  // The connections list is fetched right after Create access, before the room
  // stream has applied the new agent's member event. It used to keep saying
  // "Member record missing" until the owner reloaded the page.
  const f = await setup(t, true);
  // The first-time path: composer "Connect" -> "Add an agent", not the sidebar.
  await ensureSidebarClosed(f.page);
  await f.page.locator("#assistant-setup").click();
  await f.page.locator("#room-assistant-setup button", { hasText: "Add an agent" }).click();
  await f.page.locator("#agent-connect-dialog").waitFor({ state: "visible" });
  await f.create();
  await f.page.locator("#agent-setup").waitFor({ state: "visible" });
  const row = () => f.page.evaluate(() => [...document.querySelectorAll("#agent-connect-list li")]
    .map(li => li.textContent).find(text => text.includes("Synthetic Claude")) ?? "");
  await f.page.waitForFunction(() => [...document.querySelectorAll("#agent-connect-list li")].some(li => li.textContent.includes("Synthetic Claude")));
  const member = Object.values(f.store.room("commons").state.members).find(m => m.displayName === "Synthetic Claude");
  assert.equal(member?.active, true, "the server already holds the agent's member record");
  await f.page.waitForFunction(() => [...document.querySelectorAll("#agent-connect-list li")]
    .some(li => li.textContent.includes("Synthetic Claude") && /Access ready, waiting for first action/.test(li.textContent)), null, { timeout: 4000 })
    .catch(() => {});
  const text = await row();
  assert.doesNotMatch(text, /Member record missing/, `fresh connection must not read as a missing member: ${text.slice(0, 120)}`);
  assert.match(text, /Access ready, waiting for first action/);
});
