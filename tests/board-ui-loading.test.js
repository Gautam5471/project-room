// Board loading states (BU-02): every async board surface shows an honest
// loading state. Fail-first: these imports/assertions fail on the pre-fix
// board-ui.js, which renders a lying empty-board copy while loading and gives
// action buttons zero in-flight feedback.
import test from "node:test";
import assert from "node:assert/strict";
import sanitizeHtml from "sanitize-html";
import { boardHtml, boardSkeletonHtml, pendingOutcome, installWorkBoard } from "../src/board-ui.js";

const NOW = Date.now();
const viewer = { id: "u1", manage: false, owner: false, write: true };
const claim = (id, extra = {}) => ({ id, title: id, state: "unclaimed", owner: null, dependsOn: [], ...extra });

// --- boardSkeletonHtml: decorative placeholder columns while the board loads ---

test("boardSkeletonHtml marks itself decorative and mirrors the five columns", () => {
  const html = boardSkeletonHtml();
  assert.ok(html.includes("board-skeleton"), "skeleton root class");
  assert.ok(html.includes('aria-hidden="true"'), "decorative for screen readers");
  for (const label of ["Ready", "Claimed / In progress", "Blocked", "In review", "Landed"]) {
    assert.ok(html.includes(label), `column label ${label}`);
  }
});

// --- pendingOutcome: honest in-flight copy for every board action ---

test("pendingOutcome narrates each action with the claim title", () => {
  const expected = {
    claim: "Claiming 'Fix login'…",
    renew: "Renewing 'Fix login'…",
    progress: "Marking 'Fix login' in progress…",
    done: "Marking 'Fix login' done…",
    release: "Releasing 'Fix login'…",
    close: "Closing 'Fix login'…",
    cancel: "Cancelling 'Fix login'…",
    reassign: "Reassigning 'Fix login'…",
    create: "Opening 'Fix login'…",
  };
  for (const [action, text] of Object.entries(expected)) {
    assert.equal(pendingOutcome(action, "Fix login"), text, action);
  }
});

test("pendingOutcome handles sweep (no title) and unknown actions", () => {
  assert.equal(pendingOutcome("sweep"), "Closing stale claims…");
  assert.equal(pendingOutcome("teleport", "x"), "");
});

// --- boardHtml loading: never show the lying empty copy while fetching ---

test("boardHtml with loading and no items shows the skeleton, not the empty copy", () => {
  const html = boardHtml([], null, viewer, {}, NOW, { loading: true, canWrite: true });
  assert.ok(html.includes("board-skeleton"), "skeleton while loading");
  assert.ok(html.includes("Loading the board…"), "honest status text");
  assert.ok(!html.includes("No work posted yet"), "no lying empty copy while loading");
  assert.ok(!html.includes("Claim work here"), "no lying empty copy while loading");
});

test("boardHtml with items still loading keeps stale items and says refreshing", () => {
  const items = [claim("a1", { title: "Write the notes" })];
  const html = boardHtml(items, null, viewer, {}, NOW, { loading: true, canWrite: true });
  assert.ok(html.includes("Write the notes"), "stale items stay visible");
  assert.ok(html.includes("Refreshing the board…"), "honest refresh note");
  assert.ok(!html.includes("board-skeleton"), "no skeleton over real items");
});

test("boardHtml with loadError and no items shows the error with a retry button", () => {
  const html = boardHtml([], null, viewer, {}, NOW, { loadError: true, canWrite: true });
  assert.ok(html.includes("Could not load the board."), "honest error copy");
  assert.ok(html.includes("data-board-retry"), "retry button present");
  assert.ok(html.includes("Try again"), "retry label");
  assert.ok(!html.includes("board-skeleton"), "no skeleton on error");
});

test("boardHtml default (no flags) keeps the existing empty-board behavior", () => {
  const shy = { id: null, manage: false, owner: false, write: false };
  const html = boardHtml([], null, shy, {}, NOW, { canWrite: false });
  assert.ok(html.includes("No work posted yet"), "empty copy preserved when not loading");
});

test("a failed refresh with a board already shown still says so, with retry", () => {
  const html = boardHtml([claim("a")], null, viewer, {}, NOW, { loadError: true, canWrite: true });
  assert.ok(html.includes("Could not load the board"));
  assert.ok(html.includes("data-board-retry"));
  assert.ok(html.includes('data-claim-id="a"') || html.includes("board-columns"), "stale board is kept");
});

// Controller regression: the live success message is a completion signal.
// The browser journey checks the actual DOM/focus/HTTP boundary; these held
// promises cover ordering that a fast response can hide there. No new exports.
function held() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function completionFixture(t) {
  const strict = value => new Proxy(value, {
    get(target, key) { assert.ok(key in target, `Unexpected API: ${String(key)}`); return target[key]; },
  });
  const mutation = held(), readback = held(), readArrived = held();
  const listeners = new Map();
  const line = { textContent: "" };
  const previous = { document: globalThis.document, CSS: globalThis.CSS, FormData: globalThis.FormData };
  const body = {};
  let html = "", posts = 0, session = { roomId: "commons", member: { id: "owner" } };
  const form = strict({ querySelector(selector) {
    assert.equal(selector, '[name="mine"]'); return { checked: false };
  } });
  const field = strict({
    name: "q", selectionStart: 5, selectionEnd: 5,
    dataset: { focusKey: "board-filter-q" },
    closest(selector) {
      if (selector === "[data-board-filter]") return form;
      if (selector === "[data-focus-key]") return field;
      assert.equal(selector, "article"); return null;
    },
    focus() { globalThis.document.activeElement = field; }, setSelectionRange() {},
  });
  const button = strict({
    dataset: { claimId: "notes", claimAction: "done", focusKey: "done:notes" },
    closest(selector) {
      assert.ok(["[data-board-retry]", "[data-board-filter-clear]", "[data-needs-me-open]", "[data-claim-action]"].includes(selector));
      return selector === "[data-claim-action]" ? button : null;
    },
    setAttribute(name, value) { assert.equal(name, "aria-busy"); assert.equal(value, "true"); },
    removeAttribute(name) { assert.equal(name, "aria-busy"); },
  });
  const root = strict({
    isConnected: true,
    addEventListener(type, listener) {
      assert.ok(["input", "click", "submit"].includes(type));
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    contains(node) { return node === button || node === form || node === field; },
    querySelector(selector) {
      if (selector === "#board-status") return line;
      if (selector === '[data-focus-key="board-filter-q"]') return field;
      if (selector === '[data-board-filter] [name="mine"]') return null;
      assert.match(selector, /^(\[data-focus-key=|article\[data-claim-id=)/);
      return null;
    },
    set innerHTML(value) {
      html = value;
      line.textContent = /<p id="board-status"[^>]*>(.*?)<\/p>/.exec(value)?.[1] ?? "";
    },
    replaceChildren() { html = ""; line.textContent = ""; },
  });
  globalThis.document = strict({ activeElement: body, body, querySelector(selector) {
    assert.equal(selector, "#work-board"); return root;
  } });
  globalThis.CSS = strict({ escape: value => value });
  globalThis.FormData = class {
    constructor(value) { assert.equal(value, form); }
    get(name) { assert.equal(name, "q"); return "notes"; }
  };
  t.after(async () => {
    mutation.resolve({}); readback.resolve({ claims: [] });
    await new Promise(resolve => setImmediate(resolve));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  });
  const item = claim("notes", { title: "Write the notes", state: "in_progress", owner: "owner",
    updatedAt: new Date().toISOString(), leaseExpiresAt: new Date(Date.now() + 3600000).toISOString() });
  const client = strict({ generation: 1, path: path => path, request(path, options) {
    if (options?.method === "POST") {
      assert.equal(path, "/work-claims/notes/update"); assert.deepEqual(options.data, { state: "done" });
      posts++; return mutation.promise;
    }
    assert.equal(options, undefined);
    if (path === "/work-claims?limit=200") {
      if (posts) { readArrived.resolve(); return readback.promise; }
      return Promise.resolve({ claims: [item] });
    }
    if (path === "/work-claims/status") return Promise.resolve({ behind: 0 });
    if (path === "/work-claims/config") return Promise.resolve({ maxMemberOpenClaims: 20 });
    throw new Error(`Unexpected request: ${path}`);
  } });
  const board = installWorkBoard({ client,
    getState: () => ({ room: { ownerId: "owner" }, members: { owner: { id: "owner", active: true } }, eventLog: [] }),
    getSession: () => session });
  await board.whenReady();
  const click = () => listeners.get("click")[0]({ target: button });
  const filter = () => listeners.get("input")[0]({ target: field });
  const settled = () => new Promise(resolve => setImmediate(resolve));
  return { board, mutation, readback, readArrived, item, click, filter, settled,
    signOut() { session = null; board.reset(); },
    status: () => line.textContent, html: () => html, posts: () => posts };
}

test("Board completion is announced with fresh claims, never during held writes, reads or filter paints", async t => {
  const f = await completionFixture(t);
  f.click();
  assert.equal(f.status(), "Marking 'Write the notes' done…");
  f.filter();
  assert.notEqual(f.status(), "Done 'Write the notes'", "filtering during the POST cannot announce completion");
  f.click();
  assert.equal(f.posts(), 1, "a pending action excludes duplicate writes");
  f.mutation.resolve({});
  await f.readArrived.promise;
  assert.notEqual(f.status(), "Done 'Write the notes'", "readback has not arrived");
  f.filter();
  assert.notEqual(f.status(), "Done 'Write the notes'", "filtering during readback cannot announce completion");
  assert.match(f.html(), /class="claim-lease"/, "the stale card still has its lease");
  f.readback.resolve({ claims: [{ ...f.item, state: "done" }] });
  await f.settled();
  assert.equal(f.status(), "Done 'Write the notes'");
  assert.doesNotMatch(f.html(), /class="claim-lease"/);
  f.filter();
  assert.equal(f.status(), "Done 'Write the notes'", "completed status survives a later filter paint");
});

test("Board readback failure reports an error without a deferred success leaking into a later paint", async t => {
  const f = await completionFixture(t);
  f.click(); f.mutation.resolve({}); await f.readArrived.promise;
  assert.notEqual(f.status(), "Done 'Write the notes'");
  f.readback.reject(new Error("Readback unavailable")); await f.settled();
  assert.match(f.html(), /Could not load the board/);
  f.filter();
  assert.notEqual(f.status(), "Done 'Write the notes'");
  assert.match(f.html(), /class="claim-lease"/);
});

for (const phase of ["write", "readback"]) test(`Board reset retires completion during a held ${phase}`, async t => {
  const f = await completionFixture(t);
  f.click();
  if (phase === "readback") { f.mutation.resolve({}); await f.readArrived.promise; }
  f.signOut();
  f.mutation.resolve({}); f.readback.resolve({ claims: [{ ...f.item, state: "done" }] });
  await f.settled();
  assert.equal(f.html(), "");
  assert.equal(f.status(), "");
  assert.equal(f.posts(), 1);
});

// Parse the controller's real markup, replacing node identities on innerHTML.
// HTML removing steps reset focus to the document viewport/body when the
// focused node is removed. A text-only innerHTML double cannot expose this.
// https://html.spec.whatwg.org/multipage/infrastructure.html#html-element-removing-steps
// This models node removal/restoration, not browser Tab order or modal layout.
function focusDom(t) {
  let nodes = [], active;
  const gates = [], listeners = new Map();
  const body = { closest: () => null };
  active = body;
  const previous = { document: globalThis.document, CSS: globalThis.CSS };
  const matches = (node, selector) => {
    const match = /^(?:([\w-]+)|#([\w-]+))?(?:\[([\w-]+)(?:="([^"]*)")?\])?$/.exec(selector);
    assert.ok(match && selector, `Unsupported selector: ${selector}`);
    const [, tag, id, attribute, value] = match;
    return (!tag || node.tag === tag) && (!id || node.attrs.id === id)
      && (!attribute || (Object.hasOwn(node.attrs, attribute) && (value === undefined || node.attrs[attribute] === value)));
  };
  const query = selector => {
    const parts = selector.split(" ");
    assert.ok(parts.length <= 2, `Unsupported selector: ${selector}`);
    return nodes.find(node => matches(node, parts.at(-1))
      && (parts.length === 1 || node.parent?.closest(parts[0]))) ?? null;
  };
  const root = {
    addEventListener(type, listener) { assert.ok(["input", "click", "submit"].includes(type)); listeners.set(type, listener); },
    contains: node => nodes.includes(node),
    querySelector: query,
    set innerHTML(html) {
      if (nodes.includes(active)) active = body;
      nodes = [];
      const stack = [];
      sanitizeHtml(html, {
        onOpenTag(tag, attrs) {
          const node = { tag, attrs, parent: stack.at(-1),
            get dataset() {
              return Object.fromEntries(Object.entries(attrs).filter(([key]) => key.startsWith("data-"))
                .map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
            },
            closest(selector) {
              for (let ancestor = this; ancestor; ancestor = ancestor.parent) if (matches(ancestor, selector)) return ancestor;
              return null;
            },
            setAttribute(name, value) { attrs[name] = value; },
            focus() { assert.ok(nodes.includes(this), "a removed node cannot receive focus"); active = this; },
          };
          nodes.push(node); stack.push(node);
        },
        onCloseTag() { stack.pop(); },
      });
    },
  };
  globalThis.document = { body, get activeElement() { return active; }, querySelector(selector) {
    assert.equal(selector, "#work-board"); return root;
  } };
  globalThis.CSS = { escape: value => value };
  t.after(async () => {
    for (const gate of gates) gate.resolve({ claims: [] });
    await new Promise(resolve => setImmediate(resolve));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  });
  return { root, query, active: () => active, drain: gate => gates.push(gate), click: target => listeners.get("click")({ target }) };
}

const STATIC_FOCUS_CONTROLS = [
  ["Save cap", '[data-claim-cap] button'],
  ["claim cap", '[data-claim-cap] input'],
  ["new title", '#board-new-item [name="title"]'],
  ["new note", '#board-new-item [name="note"]'],
  ["new files", '#board-new-item [name="files"]'],
  ["Add item", '#board-new-item button'],
  ["Close stale", '#board-close-stale'],
];

for (const [label, selector] of STATIC_FOCUS_CONTROLS) test(`initial Board read preserves focus on ${label}`, async t => {
  const dom = focusDom(t), gate = held(), arrived = held();
  dom.drain(gate);
  const board = focusBoard(gate, arrived);
  board.sync(); await arrived.promise;
  const before = dom.query(selector);
  assert.ok(before, "control exists while the initial read is held");
  before.focus();
  gate.resolve({ claims: [] }); await board.whenReady();
  const after = dom.query(selector);
  assert.ok(after, "equivalent control exists in the loaded board");
  assert.notEqual(after, before, "the renderer replaced the node");
  assert.equal(dom.active(), after, "focus follows the replacement control, not the body");
});

function focusBoard(gate, arrived, state = { room: { ownerId: "owner" }, members: { owner: { id: "owner", active: true } }, eventLog: [] }) {
  const client = { generation: 1, path: path => path, request(path, options) {
    assert.equal(options, undefined, "focus navigation sends no mutation");
    if (path === "/work-claims?limit=200") { arrived.resolve(); return gate.promise; }
    if (path === "/work-claims/status") return Promise.resolve({ behind: 0 });
    if (path === "/work-claims/config") return Promise.resolve({ maxMemberOpenClaims: 20 });
    throw new Error(`Unexpected request: ${path}`);
  } };
  return installWorkBoard({ client, getState: () => state, getSession: () => ({ roomId: "commons", member: { id: "owner" } }) });
}

for (const name of ["mine", "q"]) test(`Board refresh preserves ${name === "mine" ? "Mine only" : "already-keyed search"} focus`, async t => {
  const dom = focusDom(t), gate = held(), arrived = held();
  dom.drain(gate);
  const state = { room: { ownerId: "owner" }, members: { owner: { id: "owner", active: true } }, eventLog: [] };
  const board = focusBoard(gate, arrived, state);
  const claims = [claim("focus-card")];
  gate.resolve({ claims }); await board.whenReady();
  const selector = `[name="${name}"]`, before = dom.query(selector);
  assert.ok(before); before.focus();
  const refresh = held();
  dom.drain(refresh);
  gate.promise = refresh.promise;
  state.eventLog.push({ type: "work_claim.updated", id: "refresh" });
  board.sync();
  assert.equal(dom.active(), dom.query(selector), "loading paint retains focus while the response is held");
  refresh.resolve({ claims }); await board.whenReady();
  const after = dom.query(selector);
  assert.notEqual(after, before);
  assert.equal(dom.active(), after, "both loading and completed paints retain the focused control");
});

test("Board refresh follows the current static control after focus moves from a previously restored control", async t => {
  const dom = focusDom(t), gate = held(), arrived = held();
  dom.drain(gate);
  const state = { room: { ownerId: "owner" }, members: { owner: { id: "owner", active: true } }, eventLog: [] };
  const board = focusBoard(gate, arrived, state);
  board.sync(); await arrived.promise;
  dom.query('[data-claim-cap] button').focus();
  gate.resolve({ claims: [] }); await board.whenReady();
  const title = '#board-new-item [name="title"]';
  dom.query(title).focus();
  const refresh = held(); dom.drain(refresh); gate.promise = refresh.promise;
  state.eventLog.push({ type: "work_claim.updated", id: "next-refresh" });
  board.sync();
  assert.equal(dom.active(), dom.query(title), "loading does not jump back to Save cap");
  refresh.resolve({ claims: [] }); await board.whenReady();
  assert.equal(dom.active(), dom.query(title), "completion retains the user's newer focus choice");
});

test("a completed Board action moves focus to the finished card when its button is gone", async t => {
  const dom = focusDom(t), mutation = held(), readback = held();
  const item = claim("notes", { title: "Write the notes", state: "in_progress", owner: "owner",
    updatedAt: new Date().toISOString(), leaseExpiresAt: new Date(Date.now() + 3600000).toISOString() });
  let posts = 0;
  const client = { generation: 1, path: path => path, request(path, options) {
    if (options?.method === "POST") { posts++; return mutation.promise; }
    if (path === "/work-claims?limit=200") return posts ? readback.promise : Promise.resolve({ claims: [item] });
    if (path === "/work-claims/status") return Promise.resolve({ behind: 0 });
    if (path === "/work-claims/config") return Promise.resolve({ maxMemberOpenClaims: 20 });
    throw new Error(`Unexpected request: ${path}`);
  } };
  const board = installWorkBoard({ client,
    getState: () => ({ room: { ownerId: "owner" }, members: { owner: { id: "owner", active: true } }, eventLog: [] }),
    getSession: () => ({ roomId: "commons", member: { id: "owner" } }) });
  t.after(() => { mutation.resolve({}); readback.resolve({ claims: [] }); });
  board.sync(); await board.whenReady();
  const done = dom.query('[data-claim-action="done"]');
  assert.ok(done, "the in-progress card offers Done");
  done.focus();
  dom.click(done);
  mutation.resolve({}); readback.resolve({ claims: [{ ...item, state: "done" }] });
  await board.whenReady(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(dom.query('[data-claim-action="done"]'), null, "the Done button is gone after completion");
  const heading = dom.query('article[data-claim-id="notes"] h4');
  assert.ok(heading, "the finished card is still on the board");
  assert.equal(dom.active(), heading, "focus lands on the finished card heading, not the page body");
});
