// Simulated human interaction in disposable local rooms, never a user study.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { textVersion } from "../server/text-results.mjs";
import { signInFixture } from "./auth-signin.mjs";

async function setup(t, { mobile = false, review = false, viewport = null, body = "  A quiet room\n\nCafé 🪷 — one clear next step.  \n" } = {}) {
  const f = createAcceptanceFixture(), workItemId = "native-human";
  const send = (type, data, actor = "owner") => f.store.command(f.keys[actor], "commons", { id: crypto.randomUUID(), type, data });
  send(T.MEMBER_ADDED, { memberId: "human-checker", displayName: "Test checker", kind: "human", permissions: ["verify"] });
  f.keys["human-checker"] = f.store.issueAccessKey("commons", "human-checker");
  send(T.WORK_PROPOSED, { workItemId, title: "A quiet room", definitionOfDone: "Short text with one next step", mode: "read", accountableMemberId: "owner",
    verifierMemberId: "human-checker", independentVerificationRequired: true, ownerDecisionRequired: true, humanDecisionMakerId: "owner" });
  const item = () => f.store.room("commons").state.workItems[workItemId];
  const mutate = (type, data = {}, actor) => send(type, { workItemId, expectedRevision: item().revision, ...data }, actor);
  mutate(T.WORK_ACCEPTED);
  const posted = send(T.MESSAGE_POSTED, { messageId: "native-draft", workItemId, packetId: "human-packet", basisRevision: 1, body });
  let chatAt = Date.now();
  f.store.now = () => chatAt;
  for (let i = 0; i < 102; i++) { chatAt += 2000; send(T.MESSAGE_POSTED, { body: "Synthetic background activity", replyToId: "test-welcome" }); }
  const complete = () => mutate(T.WORK_COMPLETED, { evidenceKind: "room_text", evidenceMessageId: "native-draft", evidenceMessageEventId: posted.event.id,
    evidenceVersion: textVersion(body), previousCompletionEventId: item().receipt?.eventId ?? null, producerId: "owner", summary: "A quiet room", nextAction: "Review" });
  if (review) complete();
  const server = createRoomServer({ store: f.store, streamInterval: 40 }); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: viewport ?? (mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }), isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce" });
  const errors = [], outside = []; page.on("pageerror", e => errors.push(e.message)); page.setDefaultTimeout(8000);
  await page.route("**/*", route => { if (new URL(route.request().url()).origin !== origin) { outside.push(route.request().url()); return route.abort(); } return route.continue(); });
  await page.goto(origin); await signInFixture(page, f.keys[review ? "human-checker" : "owner"]); await page.locator("#main").waitFor({ state: "visible" });
  const open = async () => {
    if (review) await page.locator(`[data-work-record-id='${workItemId}'] [data-action='verify']`).click();
    else {
      // Per-message actions live in the "⋯" overflow menu (UI calming #2).
      const draftRow = page.locator(`[data-message-record-id='native-draft']`);
      const draftMenu = draftRow.locator('details.message-more');
      if (!(await draftMenu.evaluate(node => node.open))) await draftMenu.locator('summary').click();
      await page.locator("[data-message-id='native-draft'][data-message-action='result']").click();
    }
    await page.locator("#action-dialog").waitFor({ state: "visible" });
  };
  const textReady = async () => { await page.waitForFunction(body => document.querySelector("#action-text-body").textContent === body, body); };
  const fill = async () => {
    if (review) { await page.locator("#action-fields [name=result]").selectOption("pass"); await page.locator("#action-fields [name=summary]").fill("Checked the stored text and next step"); }
    else { await page.locator("#action-fields [name=producerId]").selectOption("owner"); await page.locator("#action-fields [name=summary]").fill("A quiet room"); await page.locator("#action-fields [name=nextAction]").fill("Review exact text"); }
  };
  const capture = async name => { mkdirSync("test-results", { recursive: true }); await page.screenshot({ path: `test-results/native-result-${name}.png` }); };
  t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(outside, []); });
  return { ...f, page, workItemId, body, item, send, mutate, complete, open, fill, textReady, capture, save: page.locator("#action-form button[type=submit]") };
}

for (const mobile of [false, true]) test(`native result ${mobile ? "mobile" : "desktop"}: selected old draft becomes exact result`, { timeout: 25000 }, async t => {
  const f = await setup(t, { mobile }); await f.open(); await f.textReady(); await f.fill();
  assert.equal(await f.page.locator("#action-fields [name=evidenceUrl]").count(), 0);
  assert.equal(await f.page.locator("#action-title").textContent(), "Save as result");
  assert.equal(await f.page.locator("#action-text-body").evaluate(el => getComputedStyle(el).whiteSpace), "pre-wrap");
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await f.capture(mobile ? "mobile" : "desktop"); await f.save.click(); await f.page.locator("#action-dialog").waitFor({ state: "hidden" });
  assert.equal(f.item().receipt.nativeText.messageId, "native-draft"); assert.equal(f.item().receipt.evidenceVersion, textVersion(f.body));
  assert.equal(f.item().verification, null); assert.equal(f.item().decision, null);
  await f.page.locator(`[data-read-result='${f.workItemId}']`).click();
  await f.page.waitForFunction(body => document.querySelector("#result-body").textContent === body, f.body);
  assert.equal(await f.page.locator("#result-dialog").evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await f.page.locator("#close-result").focus(); await f.page.keyboard.press("Tab");
  assert.equal(await f.page.locator("#close-result").evaluate(el => el === document.activeElement), true);
  f.mutate(T.WORK_BLOCKED, { reason: "Synthetic follow-up", nextAction: "Revisit later" });
  await f.page.waitForFunction(id => document.querySelector(`[data-work-record-id='${id}']`).textContent.includes("Synthetic follow-up"), f.workItemId);
  await f.page.locator("#close-result").click(); assert.equal(await f.page.locator("#result-body").textContent(), "");
  assert.equal(await f.page.locator(`[data-read-result='${f.workItemId}']`).evaluate(el => el === document.activeElement), true);
});

test("native result uncertain save resumes exact text and command", { timeout: 25000 }, async t => {
  const f = await setup(t), attempts = []; await f.open(); await f.textReady(); await f.fill();
  await f.page.route("**/commands", async route => { attempts.push(route.request().postDataJSON()); if (attempts.length === 1) { await route.fetch(); return route.abort("failed"); } return route.continue(); });
  await f.save.click(); await f.page.getByText("Save not confirmed. Retry the original before making changes.", { exact: true }).waitFor();
  await f.page.locator("#cancel-action").click(); await f.page.locator("#resume-action").click();
  assert.equal(await f.page.locator("#action-text-body").textContent(), f.body); await f.save.click(); await f.page.locator("#action-dialog").waitFor({ state: "hidden" });
  assert.deepEqual(attempts[0], attempts[1]); assert.equal(f.item().revision, 2);
});

test("native review shows exact text and leaves human approval pending", { timeout: 25000 }, async t => {
  const f = await setup(t, { review: true }); await f.open(); await f.textReady(); await f.fill();
  assert.equal(await f.page.locator("#action-evidence").isVisible(), false);
  assert.equal(await f.page.locator("#action-dialog").evaluate(el => el.scrollWidth <= el.clientWidth), true); await f.capture("review");
  await f.save.click(); await f.page.locator("#action-dialog").waitFor({ state: "hidden" });
  assert.equal(f.item().verification.result, "pass"); assert.equal(f.item().verification.independenceConfirmed, true); assert.equal(f.item().decision, null);
});

// NR-B reflow owner: existing 320px composer/layout tests never open the
// native reader and review form, and this file's prior review ran at 1440px.
// A dialog min-width, unbroken result token, or lost return target can break
// this task independently. Use the real local result/command routes and the
// existing fixture; no production seam, model, real device or AT claim.
for (const theme of ["dark", "light"]) test(`native result 320px ${theme}: read, review and return to the same result`, { timeout: 30000 }, async t => {
  const body = "A quiet room\n\nCheck this exact reference: " + "resultreference".repeat(12) + "\nKeep the next step with the same work.";
  const f = await setup(t, { review: true, viewport: { width: 320, height: 900 }, body });
  const { page } = f, receipt = structuredClone(f.item().receipt), reads = [], evidence = [];
  const card = page.locator(`[data-work-record-id="${f.workItemId}"]`);
  const read = card.locator("[data-read-result]"), verify = card.locator('[data-action="verify"]');
  const initialUrl = page.url();
  mkdirSync("test-results/native-reflow", { recursive: true });
  t.after(() => writeFileSync(`test-results/native-reflow/${theme}.json`, JSON.stringify({
    theme, simulatedHuman: true, realDevice: false, assistiveTechnology: false,
    workItemId: f.workItemId, completionEventId: receipt.eventId, evidenceVersion: receipt.evidenceVersion,
    producerId: receipt.producerId, reviewerId: "human-checker", reads, evidence,
  }, null, 2) + "\n"));
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/work-result")) reads.push({ path: url.pathname, workItemId: url.searchParams.get("workItemId"), completionEventId: url.searchParams.get("completionEventId") });
  });
  await page.evaluate(mode => { document.documentElement.dataset.theme = mode; }, theme);
  // CI keeps no screenshots for a failed shard, so keep a short focus/DOM trace
  // that a failing assertion prints. It observes only; it never changes focus.
  await page.evaluate(() => {
    const trace = window.__focusTrace = [], t0 = performance.now();
    const label = node => node && node.nodeType === 1 ? `${node.tagName.toLowerCase()}${node.id ? "#" + node.id : ""}${node.dataset?.readResult ? "[read-result]" : ""}` : String(node);
    const note = text => { trace.push(`${Math.round(performance.now() - t0)}ms ${text}`); if (trace.length > 40) trace.shift(); };
    for (const type of ["focusin", "focusout"]) document.addEventListener(type, event => note(`${type} ${label(event.target)} -> ${label(event.relatedTarget)}`), true);
    for (const type of ["close", "cancel"]) document.addEventListener(type, event => note(`${type} ${label(event.target)}`), true);
    new MutationObserver(records => {
      if (records.some(record => [...record.removedNodes].some(node => node.nodeType === 1 && (node.matches?.("[data-read-result]") || node.querySelector?.("[data-read-result]")))))
        note("a [data-read-result] node was removed from #message-list");
    }).observe(document.querySelector("#message-list"), { childList: true, subtree: true });
  });
  const trace = async () => page.evaluate(() => ({ trace: window.__focusTrace, active: document.activeElement?.outerHTML.slice(0, 140),
    dialogOpen: document.querySelector("#result-dialog").open, hasFocus: document.hasFocus(), scrollY }));
  await page.locator("#message-input").fill("Keep this reviewer's conversation draft.");
  const measure = async (stage, panelSelector = null, textSelector = null) => {
    const value = await page.evaluate(({ panelSelector, textSelector }) => {
      const panel = panelSelector && document.querySelector(panelSelector), text = textSelector && document.querySelector(textSelector);
      const active = document.activeElement, box = active.getBoundingClientRect(), style = getComputedStyle(active);
      // A viewport-contained control can still be cut off by a scrolling
      // dialog. Measure every clipping ancestor without scrolling it for the test.
      const clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }, clippingAncestors = [];
      for (let node = active.parentElement; node; node = node.parentElement) {
        const css = getComputedStyle(node), rect = node.getBoundingClientRect();
        const clipsX = /^(auto|scroll|hidden|clip)$/.test(css.overflowX), clipsY = /^(auto|scroll|hidden|clip)$/.test(css.overflowY);
        if (!clipsX && !clipsY) continue;
        const bounds = { left: rect.left + node.clientLeft, top: rect.top + node.clientTop,
          right: rect.left + node.clientLeft + node.clientWidth, bottom: rect.top + node.clientTop + node.clientHeight };
        if (clipsX) { clip.left = Math.max(clip.left, bounds.left); clip.right = Math.min(clip.right, bounds.right); }
        if (clipsY) { clip.top = Math.max(clip.top, bounds.top); clip.bottom = Math.min(clip.bottom, bounds.bottom); }
        clippingAncestors.push({ id: node.id, clipsX, clipsY, ...bounds });
      }
      const x = (Math.max(clip.left, box.left) + Math.min(clip.right, box.right)) / 2;
      const y = (Math.max(clip.top, box.top) + Math.min(clip.bottom, box.bottom)) / 2;
      const hit = document.elementFromPoint(x, y);
      return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth,
        theme: document.documentElement.dataset.theme,
        panel: panel && { scrollWidth: panel.scrollWidth, clientWidth: panel.clientWidth },
        text: text && { scrollWidth: text.scrollWidth, clientWidth: text.clientWidth },
        focus: { id: active.id, name: active.getAttribute("name"), workItemId: active.closest("[data-work-record-id]")?.dataset.workRecordId,
          x: box.x, y: box.y, width: box.width, height: box.height, outline: style.outline, boxShadow: style.boxShadow,
          unobscured: hit === active || active.contains(hit), clip, clippingAncestors,
          fullyVisible: box.left >= clip.left - 1 && box.right <= clip.right + 1 && box.top >= clip.top - 1 && box.bottom <= clip.bottom + 1 } };
    }, { panelSelector, textSelector });
    evidence.push({ stage, url: page.url(), ...value });
    await page.screenshot({ path: `test-results/native-reflow/${theme}-${stage}.png` });
    assert.equal(value.width, 320, "actual layout width, not a resized screenshot");
    assert.equal(value.theme, theme);
    assert.ok(value.documentWidth <= value.width + 1, `${stage}: document reflows`);
    for (const [name, size] of [["panel", value.panel], ["text", value.text]]) if (size) {
      assert.ok(size.scrollWidth <= size.clientWidth + 1, `${stage}: ${name} needs no horizontal scrolling`);
    }
    const focus = value.focus;
    assert.ok(focus.width > 0 && focus.height > 0 && focus.x >= 0 && focus.x + focus.width <= 321, `${stage}: focus is horizontally available`);
    assert.ok(focus.y < value.height && focus.y + focus.height > 0 && focus.unobscured,
      `${stage}: focus is visible and unobscured; ${JSON.stringify({ focus, ...(await trace()) })}`);
    if (panelSelector) assert.ok(focus.y >= 0 && focus.y + focus.height <= value.height + 1, `${stage}: focused core control fits the viewport`);
  };
  const readExact = async stage => {
    await read.focus(); await page.keyboard.press("Enter");
    await page.waitForFunction(body => document.querySelector("#result-body").textContent === body, f.body);
    assert.equal(await page.locator("#result-title").textContent(), "A quiet room");
    assert.match(await page.locator("#result-status").textContent(), /Submitted by Room owner.*exact stored text/);
    assert.equal(await page.locator("#close-result").evaluate(node => node === document.activeElement), true);
    await measure(stage, "#result-dialog", "#result-body");
    await page.keyboard.press("Escape"); await page.locator("#result-dialog").waitFor({ state: "hidden" });
    assert.equal(await read.evaluate(node => node === document.activeElement), true,
      `reader returns to this work's result control; ${JSON.stringify(await trace())}`);
    assert.equal(page.url(), initialUrl);
  };
  await readExact("reader-before");
  await measure("reader-return");
  await verify.focus(); await page.keyboard.press("Enter"); await f.textReady();
  const verdict = page.locator("#action-fields [name=result]"), notes = page.locator("#action-fields [name=summary]");
  await verdict.focus(); await verdict.selectOption("pass");
  await measure("review-verdict", "#action-dialog", "#action-text-body");
  await page.keyboard.press("Tab"); assert.equal(await notes.evaluate(node => node === document.activeElement), true);
  await notes.fill("Checked this exact stored reference and next step");
  await measure("review-notes", "#action-dialog", "#action-text-body");
  await page.keyboard.press("Tab"); assert.equal(await page.locator("#cancel-action").evaluate(node => node === document.activeElement), true);
  await page.keyboard.press("Tab"); assert.equal(await f.save.evaluate(node => node === document.activeElement), true);
  await measure("review-save", "#action-dialog", "#action-text-body");
  await page.keyboard.press("Enter"); await page.locator("#action-dialog").waitFor({ state: "hidden" });
  await page.waitForFunction(id => document.activeElement?.closest("[data-work-record-id]")?.dataset.workRecordId === id, f.workItemId);
  assert.equal(f.item().verification.verifierId, "human-checker");
  assert.equal(f.item().verification.result, "pass");
  assert.equal(f.item().verification.independenceConfirmed, true);
  assert.equal(f.item().verification.completionEventId, receipt.eventId);
  assert.equal(f.item().verification.evidenceVersion, receipt.evidenceVersion);
  assert.deepEqual(f.item().receipt, receipt, "review never substitutes a result or producer");
  assert.equal(f.item().decision, null, "the owner's decision is still separate");
  await measure("review-return");
  await readExact("reader-after");
  assert.equal(await page.locator("#message-input").inputValue(), "Keep this reviewer's conversation draft.");
  assert.ok(reads.length > 0, "the real result route was exercised");
  assert.ok(reads.every(value => value.workItemId === f.workItemId && value.completionEventId === receipt.eventId));
  // Full core-control visibility is the product requirement for this task;
  // it is stricter than WCAG 2.4.11's not-entirely-obscured minimum. Preserve
  // every journey screenshot before reporting a clipping failure.
  assert.deepEqual(evidence.filter(value => value.panel && !value.focus.fullyVisible)
    .map(value => ({ stage: value.stage, focus: value.focus })), [], "focused modal controls fit inside all clipping ancestors");
});

test("native review refuses self-consistent text from a different pinned evidence version", { timeout: 25000 }, async t => {
  const f = await setup(t, { review: true });
  await f.page.route("**/work-result?**", async route => {
    const response = await route.fetch(), value = await response.json(); value.result.text.body = "A substituted result";
    value.result.text.byteLength = Buffer.byteLength(value.result.text.body); value.result.text.evidenceVersion = value.result.receipt.evidenceVersion = textVersion(value.result.text.body);
    return route.fulfill({ status: 200, json: value });
  });
  await f.open(); await f.page.getByText("Exact text unavailable. Review current work to try again.", { exact: true }).waitFor();
  assert.equal(await f.save.isEnabled(), false); assert.equal(await f.page.locator("#action-text-body").textContent(), ""); assert.equal(f.item().verification, null);
});

test("native draft cannot save stale work; explicit refresh keeps the selected text", { timeout: 25000 }, async t => {
  const f = await setup(t); await f.open(); await f.textReady(); await f.fill(); f.mutate(T.WORK_STARTED);
  await f.page.locator("#refresh-action").waitFor({ state: "visible" }); assert.equal(await f.save.isEnabled(), false);
  await f.page.locator("#refresh-action").click(); await f.textReady(); await f.page.waitForFunction(() => !document.querySelector("#action-form button[type=submit]").disabled);
  await f.save.click(); await f.page.locator("#action-dialog").waitFor({ state: "hidden" }); assert.equal(f.item().receipt.nativeText.messageId, "native-draft");
});

test("native result large text and keyboard remain usable; revocation clears visible text", { timeout: 25000 }, async t => {
  const f = await setup(t, { review: true });
  await f.page.evaluate(() => { document.documentElement.style.fontSize = "200%"; }); await f.open(); await f.textReady();
  assert.equal(await f.page.locator("#action-text-body").evaluate(el => getComputedStyle(el).fontSize), "32px");
  assert.equal(await f.page.locator("#action-dialog").evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await f.page.locator("#cancel-action").focus(); await f.page.keyboard.press("Escape"); await f.page.locator("#action-dialog").waitFor({ state: "hidden" });
  await f.page.locator(`[data-read-result='${f.workItemId}']`).click();
  await f.page.waitForFunction(body => document.querySelector("#result-body").textContent === body, f.body); await f.capture("large-text");
  assert.equal(await f.page.locator("#result-body").evaluate(el => getComputedStyle(el).fontSize), "32px");
  f.send(T.MEMBER_ACCESS_CHANGED, { memberId: "human-checker", expectedMemberRevision: 0, permissions: ["verify"], active: false });
  await f.page.locator("#auth-panel").waitFor({ state: "visible" });
  assert.equal(await f.page.locator("#result-body").textContent(), ""); assert.equal(await f.page.locator("#action-text-body").textContent(), "");
});

for (const mobile of [false, true]) test(`native result ${mobile ? "phone" : "desktop"}: failed read retries the pinned result in place`, { timeout: 25000 }, async t => {
  const f = await setup(t, { mobile }); f.complete();
  const attempts = [], retry = f.page.locator("#result-retry"); let release, began;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { began = resolve; });
  await f.page.route("**/work-result?**", async route => {
    attempts.push(new URL(route.request().url()).searchParams.get("completionEventId"));
    if (attempts.length === 1) return route.fulfill({ status: 503, json: { error: "Synthetic unavailable" } });
    const response = await route.fetch(); began(); await gate;
    return route.fulfill({ response }).catch(() => {});
  });
  await f.page.locator("#message-input").fill("Keep my steering draft.");
  await f.page.locator(`[data-read-result='${f.workItemId}']`).click();
  await f.page.waitForFunction(() => document.querySelector("#result-status").textContent.includes("unavailable"));
  assert.equal(await retry.isVisible(), true, "a failed exact result can be retried inside its selected reader");
  await retry.focus(); await f.page.keyboard.press("Enter"); await started;
  assert.equal(await retry.isDisabled(), true);
  await retry.evaluate(node => node.click()); assert.equal(attempts.length, 2, "one retry read can be pending");
  // Another result arrives while the selected old read is held. Retrying must
  // retain the exact original completion and never show the replacement text.
  f.mutate(T.WORK_BLOCKED, { reason: "Correction", nextAction: "Revise" });
  f.mutate(T.WORK_BLOCKER_RESOLVED, { resolution: "Ready" });
  const body = "Replacement result", posted = f.send(T.MESSAGE_POSTED, { messageId: "replacement-draft", workItemId: f.workItemId, packetId: "replacement", basisRevision: f.item().revision, body });
  f.mutate(T.WORK_COMPLETED, { evidenceKind: "room_text", evidenceMessageId: "replacement-draft", evidenceMessageEventId: posted.event.id,
    evidenceVersion: textVersion(body), previousCompletionEventId: f.item().receipt.eventId, producerId: "owner", summary: "Replacement", nextAction: "Review" });
  await f.page.waitForFunction(id => document.querySelector(`[data-work-record-id="${id}"]`).textContent.includes("Replacement"), f.workItemId);
  release(); await f.page.waitForFunction(body => document.querySelector("#result-body").textContent === body, f.body);
  assert.match(await f.page.locator("#result-status").textContent(), /^Earlier result/);
  assert.equal(attempts[0], attempts[1]); assert.equal(await retry.isVisible(), false);
  assert.equal(await f.page.locator("#close-result").evaluate(node => node === document.activeElement), true, "hidden retry hands keyboard focus to Close");
  assert.equal(await f.page.locator("#message-input").inputValue(), "Keep my steering draft.");
  await f.capture(mobile ? "retry-phone" : "retry-desktop");
  await f.page.keyboard.press("Escape"); await f.page.locator("#result-dialog").waitFor({ state: "hidden" });
  await f.page.reload(); await f.page.locator("#main").waitFor({ state: "visible" });
  assert.equal(await f.page.locator("#message-input").inputValue(), "Keep my steering draft.");
});

for (const boundary of ["close", "revoke"]) test(`native result: held retry cannot restore text after ${boundary}`, { timeout: 25000 }, async t => {
  const f = await setup(t); f.complete(); let attempts = 0, release, began;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { began = resolve; }); t.after(() => release());
  await f.page.route("**/work-result?**", async route => {
    attempts++;
    if (attempts !== 2) return route.fulfill({ status: 503, json: { error: "Synthetic unavailable" } });
    const response = await route.fetch(); began(); await gate;
    return route.fulfill({ response }).catch(() => {});
  });
  const open = () => f.page.locator(`[data-read-result='${f.workItemId}']`).click();
  await open(); await f.page.locator("#result-retry").waitFor({ state: "visible" });
  await f.page.locator("#result-retry").click(); await started;
  if (boundary === "close") {
    await f.page.keyboard.press("Escape"); await f.page.locator("#result-dialog").waitFor({ state: "hidden" });
    await open(); await f.page.locator("#result-retry").waitFor({ state: "visible" });
  } else {
    f.store.issueAccessKey("commons", "owner");
    await f.page.locator("#auth-panel").waitFor({ state: "visible" });
  }
  release(); await f.page.unroute("**/work-result?**", { behavior: "wait" });
  assert.equal(await f.page.locator("#result-body").textContent(), "");
  if (boundary === "close") {
    assert.match(await f.page.locator("#result-status").textContent(), /unavailable/);
    assert.equal(await f.page.locator("#result-retry").isEnabled(), true);
  } else assert.equal(await f.page.locator("#result-dialog").isVisible(), false);
});

// A live update that re-renders the timeline while the member's focus is on a
// work card's "View result" button must leave that button on screen.
test("native result 320px: a live update keeps the focused View result control on screen", { timeout: 30000 }, async t => {
  const f = await setup(t, { review: true, viewport: { width: 320, height: 900 } });
  const { page } = f, read = page.locator(`[data-work-record-id="${f.workItemId}"] [data-read-result]`);
  await read.waitFor();
  await read.focus();
  const where = () => page.evaluate(() => { const b = document.activeElement.getBoundingClientRect(); return { tag: document.activeElement.dataset.readResult ?? document.activeElement.tagName, top: Math.round(b.top), bottom: Math.round(b.bottom), h: innerHeight, scrollY: Math.round(scrollY) }; });
  const before = await where();
  for (let i = 0; i < 3; i++) { f.send(T.MESSAGE_POSTED, { body: `Live update ${i}`, replyToId: "test-welcome" }); await page.waitForTimeout(250); }
  const mid = await where();
  f.send(T.MESSAGE_POSTED, { messageId: "native-follow", workItemId: f.workItemId, packetId: "human-packet", basisRevision: f.item().revision, body: "Follow-up on the same work" });
  await page.waitForTimeout(500);
  const after = await where();
  assert.ok(after.top >= 0 && after.bottom <= after.h, `focused control on screen after live updates: ${JSON.stringify({ before, mid, after })}`);
});
