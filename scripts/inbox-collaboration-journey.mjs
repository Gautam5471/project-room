// Test-only staged human simulation. Agent choices arrive separately through MCP.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { chromium } from "playwright";
import { createInboxSandbox } from "./inbox-sandbox.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { signInFixture } from "./auth-signin.mjs";

export async function createInboxCollaborationJourney({ mobile = false } = {}) {
  const sample = await createInboxSandbox(), { store, provider } = sample;
  const evidenceDirectory = mkdtempSync(join(tmpdir(), "room-inbox-collaboration-evidence-"));
  const origin = new URL(sample.url).origin, roomId = "commons", sourceId = "launch", helperId = "reply-helper";
  const errors = [], external = [];
  let browser, page, reviewerPage, workItemId, closed;
  const state = () => store.room(roomId).state;
  const item = () => state().workItems[workItemId];
  const close = () => closed ??= (async () => {
    try { await browser?.close(); } finally { await sample.close(); rmSync(sample.directory, { recursive: true, force: true }); }
  })();
  try {
    const ownerKey = store.issueAccessKey(roomId, "owner"), owner = store.createSession(ownerKey);
    const helperToken = randomBytes(32).toString("base64url");
    store.agentConnections.apply(owner.token, roomId, { action: "create", requestId: randomUUID(),
      memberId: helperId, displayName: "Reply helper", access: "chat",
      keyHash: createHash("sha256").update(helperToken).digest("hex"), expiresAt: Date.now() + 3600000, expectedOwnerRevision: 0 }, owner.session.sessionBinding);
    // Graduated autonomy tiers: the reply helper is operator-promoted so the
    // browser check exercises it as a working agent, not t1_readonly.
    setTier(store.db, roomId, helperId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
    store.command(ownerKey, roomId, { id: randomUUID(), type: "member.added", data: {
      memberId: "mail-reviewer", displayName: "Simulated reviewer", kind: "human", permissions: ["verify"] } });
    const reviewerKey = store.issueAccessKey(roomId, "mail-reviewer");
    const slot = store.createAccountSessionSlot(), account = store.loginAccountSession(slot.token, sample.accountKey, 0);
    const source = {
      adapter: "synthetic", sender: "maya@example.test", recipient: "you@example.test", subject: "A small invitation",
      paragraphs: [
        "We’re inviting a few people to try our shared workspace. Could you suggest a warm, short reply with one small next step?",
        "Internal note: the test access code is ORCHID-482. Do not share."
      ]
    };
    store.inbox.apply(slot.token, { action: "source.save", requestId: randomUUID(), sourceId, expectedRevision: 1, data: source }, account.sessionBinding);
    const configDirectory = join(sample.directory, "helper");
    saveAgentConnection(configDirectory, { version: 1, origin, roomId, memberId: helperId, token: helperToken });
    browser = await chromium.launch({ headless: true });
    async function openPage(url, key) {
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
        isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce" });
      await context.route("**/*", route => {
        if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); }
        return route.continue();
      });
      const p = await context.newPage(); p.setDefaultTimeout(9000);
      p.on("pageerror", error => errors.push(error.message)); p.on("dialog", d => d.accept());
      await p.goto(url); await signInFixture(p, key, { returnTo: url }); return p;
    }
    const capture = async (name, p = page) => {
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await p.screenshot({ path: join(evidenceDirectory, name + ".png") });
    };
    const submit = async p => { await p.locator("#action-form button[type=submit]").click(); await p.locator("#action-dialog").waitFor({ state: "hidden" }); };
    const action = async (p, name) => {
      const card = p.locator(`[data-work-record-id="${workItemId}"]`);
      // Open the existing disclosure, not a new control or service shortcut.
      for (const selector of [".work-details", ".work-help"]) {
        const detail = card.locator(selector);
        if (await detail.count() && !await detail.evaluate(node => node.open)) await detail.locator(":scope > summary").click();
      }
      await card.locator(`[data-action="${name}"]`).click(); await p.locator("#action-dialog").waitFor();
    };
    async function inbox() {
      // Settle the inbox's initial load (first message opened, connection list rendered) before the
      // step-back probe: on a phone the opened reader covers the sidebar.
      await page.locator("#nav-inbox").click(); await page.locator("#inbox-reader").waitFor({ state: "visible" });
      await page.locator("#inbox-add-connection:not([hidden])").waitFor({ state: "attached" });
      if (mobile && await page.locator("#inbox-back").isVisible()) await page.locator("#inbox-back").click();
      await page.locator(`[data-source-id="${sourceId}"]`).click(); await page.locator("#inbox-reader").waitFor();
    }
    function evidence() {
      const snapshot = store.snapshot(helperToken, roomId);
      const encoded = JSON.stringify(snapshot);
      assert.equal(encoded.includes("ORCHID-482"), false);
      assert.equal(encoded.includes("maya@example.test"), false);
      assert.equal(encoded.includes("you@example.test"), false);
      assert.deepEqual(errors, []); assert.deepEqual(external, []);
      return { scope: "local synthetic data; simulated humans; agent participation classified separately", work: item(),
        offers: state().helpOffers, messages: snapshot.state.messages, helperCursor: snapshot.cursor,
        draft: store.inbox.read(slot.token, sourceId, account.sessionBinding).draft,
        sends: store.inbox.sends(slot.token, sourceId, account.sessionBinding).sends,
        providerSubmissions: provider.submits, providerMessages: provider.count(), privateMarkerAbsentFromRoom: true,
        errors, external, audit: auditRecovery(store) };
    }
    page = await openPage(sample.url, sample.accountKey); await page.locator("#inbox-reader").waitFor();
    await inbox(); await capture("01-private-source");
    await page.locator("#inbox-ask").click(); await page.locator("#inbox-share-paragraphs input").first().check();
    await capture("02-share-selection"); await page.locator("#inbox-share-confirm").click();
    await page.locator("#inbox-share-dialog").waitFor({ state: "hidden" }); await page.locator("#main").waitFor();
    const shared = state().messages.find(m => m.body.includes(source.paragraphs[0]));
    assert.ok(shared); assert.equal(shared.body.includes("ORCHID-482"), false);
    // Per-message actions live in the "⋯" overflow menu (UI calming #2).
    await messageAction(page, shared.id, "work");
    await page.locator("#work-title-input").fill("A warm invitation reply");
    await page.locator("#work-done-input").fill("A warm reply of at most 60 words, based only on the shared excerpt, with one small next step and no invented claims. Keep it as a draft; do not send.");
    await page.locator("#assignee-select").selectOption("owner"); await page.locator("#verifier-select").selectOption("mail-reviewer");
    assert.equal(await page.locator("#require-verification").isChecked(), true);
    assert.equal(await page.locator("#require-decision").isChecked(), true);
    await page.locator("#new-work-form button[type=submit]").click(); await page.locator("#work-dialog").waitFor({ state: "hidden" });
    workItemId = Object.values(state().workItems).find(w => w.sourceMessageId === shared.id).id;
    await action(page, "accept"); await submit(page);
    await action(page, "help"); await page.locator("#action-fields [name=scope]").fill("Draft one warm reply under 60 words from the shared excerpt. Keep the draft here; I will review it. No external actions.");
    await page.locator("#action-fields [name=duration]").selectOption("3600000"); await submit(page); await capture("03-help-invitation");

    // The timeline re-renders while messages arrive, which can replace the row or
    // close its "⋯" menu between opening it and clicking the action. Wait for the
    // row, then reopen and click again with short per-attempt timeouts.
    async function messageAction(p, id, action) {
      const row = p.locator(`[data-message-record-id="${id}"]`);
      const target = p.locator(`[data-message-id="${id}"][data-message-action="${action}"]`);
      await row.waitFor({ state: "attached", timeout: 30000 });
      for (let attempt = 1; ; attempt++) {
        try {
          const menu = row.locator("details.message-more");
          if (!(await menu.evaluate(node => node.open, null, { timeout: 3000 }))) await menu.locator("summary").click({ timeout: 3000 });
          await target.click({ timeout: 3000 });
          return;
        } catch (failure) { if (attempt >= 5) throw failure; }
      }
    }

    async function stage(name, input = {}) {
      if (name === "select") {
        const offer = state().helpOffers[input.offerId]; assert.equal(offer?.offererId, helperId);
        await action(page, "select-offer"); await page.locator("#action-fields [name=reason]").fill("Please draft here. I remain responsible for the reply.");
        await submit(page); assert.equal(state().helpOffers[input.offerId].status, "selected");
        assert.equal(item().accountableMemberId, "owner"); await capture("04-selected-helper");
      } else if (name === "adopt") {
        const draft = state().messages.find(m => m.id === input.messageId);
        assert.equal(draft?.authorId, helperId); assert.equal(draft?.body, input.expectedBody);
        // Per-message actions live in the "⋯" overflow menu (UI calming #2).
        await messageAction(page, input.messageId, "result");
        await page.waitForFunction(body => document.querySelector("#action-text-body").textContent === body, input.expectedBody);
        await page.locator("#action-fields [name=producerId]").selectOption(helperId);
        await page.locator("#action-fields [name=summary]").fill("A warm invitation reply");
        await page.locator("#action-fields [name=nextAction]").fill("Review the exact text before using it as a private draft.");
        await capture("05-exact-result"); await submit(page);
        assert.equal(item().receipt.nativeText.messageId, input.messageId);
        assert.equal(item().receipt.producerId, helperId); assert.equal(item().receipt.reportedById, "owner");
      } else if (name === "review") {
        assert.equal(typeof input.reason, "string"); assert.ok(input.reason.trim());
        reviewerPage ??= await openPage(origin, reviewerKey); await reviewerPage.locator("#main").waitFor();
        await action(reviewerPage, "verify");
        await reviewerPage.waitForFunction(body => document.querySelector("#action-text-body").textContent === body, input.expectedBody);
        await reviewerPage.locator("#action-fields [name=result]").selectOption("pass");
        await reviewerPage.locator("#action-fields [name=summary]").fill(input.reason);
        await capture("06-simulated-review", reviewerPage); await submit(reviewerPage);
        assert.equal(item().verification.result, "pass"); assert.equal(item().decision, null);
        await inbox(); await page.locator("#inbox-result-list").getByText("Needs review and approval", { exact: true }).waitFor();
        assert.equal(await page.locator("[data-inbox-result]").count(), 0);
        await page.locator("#nav-rooms").click();
      } else if (name === "finish") {
        await action(page, "decide");
        await page.waitForFunction(body => document.querySelector("#action-text-body").textContent === body, input.expectedBody);
        await page.locator("#action-fields [name=decision]").selectOption("approved");
        await page.locator("#action-fields [name=reason]").fill("Simulated owner checked this exact draft. Approval is not sending.");
        assert.equal(await page.locator("#action-fields [name=sourceMessageId]").count(), 0);
        await page.getByText("Your reason will be posted to the room.", { exact: true }).waitFor();
        await submit(page); assert.equal(provider.count(), 0);
        const rationale = state().messages.find(message => message.id === item().decision.sourceMessageId);
        assert.equal(rationale.body, "Simulated owner checked this exact draft. Approval is not sending.");
        assert.equal(rationale.authorId, "owner"); assert.equal(rationale.toMemberId, null);
        assert.equal(item().decision.reason, rationale.body);
        await inbox(); await page.locator(`[data-inbox-result="${workItemId}"]`).click();
        await page.waitForFunction(body => document.querySelector("#inbox-result-body").textContent === body, input.expectedBody);
        await capture("07-private-adoption"); await page.locator("#inbox-result-use").click();
        await page.getByText("Saved · only you", { exact: true }).waitFor();
        assert.equal(await page.locator("#inbox-draft").inputValue(), input.expectedBody); assert.equal(provider.count(), 0);
        provider.mode = "after";
        await page.locator("#inbox-send-preview").click();
        await page.waitForFunction(body => document.querySelector("#inbox-send-body").textContent === body, input.expectedBody);
        await page.locator("#inbox-send-confirm").click(); await page.getByText("Sample outcome unknown", { exact: true }).waitFor();
        await capture("08-unknown"); await page.reload(); await page.locator("#inbox-reader").waitFor();
        assert.equal(await page.locator("#inbox-list [aria-current=true]").getAttribute("data-source-id"), sourceId);
        await page.locator("#inbox-send-check").click();
        await page.getByText("Sample accepted · delivery unconfirmed", { exact: true }).waitFor();
        assert.equal(provider.submits, 1); assert.equal(provider.count(), 1); await capture("09-private-reply");
      } else if (name !== "read") throw new Error("Choose select, adopt, review, finish or read.");
      const value = evidence();
      writeFileSync(join(evidenceDirectory, "readback.json"), JSON.stringify(value, null, 2), { mode: 0o600 });
      return value;
    }
    return { manifest: { origin, roomId, workItemId, helperId, configDirectory, evidenceDirectory, mobile }, stage, evidence, close };
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3 || process.argv[2] !== "--start") throw new Error("Use --start for a disposable staged exercise.");
  const journey = await createInboxCollaborationJourney();
  console.log(JSON.stringify({ ready: journey.manifest }));
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const stop = async () => { input.close(); await journey.close(); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    for await (const line of input) {
      try {
        const { stage, ...args } = JSON.parse(line); if (stage === "close") break;
        const result = await journey.stage(stage, args);
        console.log(JSON.stringify({ stage, workRevision: result.work.revision, workState: result.work.state,
          decision: result.work.decision?.decision ?? null, sendStates: result.sends.map(s => s.status),
          providerSubmissions: result.providerSubmissions, evidenceDirectory: journey.manifest.evidenceDirectory }));
      }
      catch (error) { console.error(JSON.stringify({ error: error.message })); }
    }
  } finally { await stop(); }
}
