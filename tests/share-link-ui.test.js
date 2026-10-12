import test from "node:test";
import assert from "node:assert/strict";
import { formatShareInvitation, humanJoinShareBase, humanJoinShareUrl, installShareLinks, setShareLinkStatus, invitationFailureMessage, invitationManagementFailureMessage, requestFailureMessage, reuseVisibleRoom, readUncertainJoin, writeUncertainJoin, clearUncertainJoin } from "../src/share-links.js";

test("human join share URLs keep the app path so www /room is not dropped", () => {
  const token = "T".repeat(43);
  assert.equal(humanJoinShareBase({ origin: "https://www.getdasha.com", pathname: "/room" }), "https://www.getdasha.com/room");
  assert.equal(humanJoinShareBase({ origin: "https://www.getdasha.com", pathname: "/room/" }), "https://www.getdasha.com/room");
  assert.equal(humanJoinShareUrl(token, "", { origin: "https://www.getdasha.com", pathname: "/room" }),
    `https://www.getdasha.com/room/#join/${token}`);
  assert.equal(humanJoinShareUrl(token, "", { origin: "https://www.getdasha.com", pathname: "/room/" }),
    `https://www.getdasha.com/room/#join/${token}`);
  assert.equal(humanJoinShareUrl(token, "/work/item-1", { origin: "https://www.getdasha.com", pathname: "/room/index.html" }),
    `https://www.getdasha.com/room/#join/${token}/work/item-1`);
  assert.equal(humanJoinShareUrl(token, "", { origin: "http://localhost:52331", pathname: "/" }),
    `http://localhost:52331/#join/${token}`);
  assert.equal(humanJoinShareUrl(token, "", { origin: "http://localhost:52331" }),
    `http://localhost:52331/#join/${token}`);
});

test("invitation note formatting is bounded plain text with an exact URL-only fallback", () => {
  const url = "https://room.example/#join/synthetic";
  for (const note of ["", "  ", "\n\t"]) assert.equal(formatShareInvitation(note, url), url);
  assert.equal(formatShareInvitation("  Can you review this?\nNo rush.  ", url), `Can you review this?\nNo rush.\n\n${url}`);
  assert.equal(formatShareInvitation("<b>Literal text</b> 💡", url), `<b>Literal text</b> 💡\n\n${url}`);
  assert.equal(formatShareInvitation("💡".repeat(300), url), `${"💡".repeat(300)}\n\n${url}`);
  for (const note of ["x".repeat(601), "💡".repeat(301), null]) assert.equal(formatShareInvitation(note, url), "");
  assert.equal(formatShareInvitation("A note", ""), "");
});

test("invitation status uses the shared form-status visibility contract", () => {
  const classes = new Set();
  const element = { textContent: "", classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } } };
  for (const text of ["Joining room…", "Ask for a new link.", "Link copied.", "Select and copy the link above."]) {
    setShareLinkStatus(element, text);
    assert.equal(element.textContent, text);
    assert.equal(classes.has("visible"), true);
  }
  setShareLinkStatus(element, "");
  assert.equal(element.textContent, "");
  assert.equal(classes.has("visible"), false);
});

test("same-room invitation revalidates the visible Room session, not an older account identity", async () => {
  const session = { roomId: "commons", authMode: "room", member: { id: "owner" } };
  let refreshes = 0;
  const client = { session, generation: 3, async refresh() { refreshes++; } };
  const joined = await reuseVisibleRoom(client, "commons", session);
  assert.equal(joined.session, session);
  assert.equal(joined.roomMode, true);
  assert.equal(refreshes, 1);
  assert.equal(await reuseVisibleRoom(client, "elsewhere", session), null);
  assert.equal(await reuseVisibleRoom(client, "commons", { ...session }), null);
  assert.equal(refreshes, 1);
  client.refresh = async () => { client.generation++; };
  await assert.rejects(() => reuseVisibleRoom(client, "commons", session), /identity changed/);
});

test("visible-room revalidation failure does not produce a reusable join result", async () => {
  const session = { roomId: "commons", authMode: "account" };
  const client = { session, generation: 0, async refresh() { throw new TypeError("Failed to fetch"); } };
  await assert.rejects(() => reuseVisibleRoom(client, "commons", session), /Failed to fetch/);
  client.refresh = async () => { client.session = null; };
  await assert.rejects(() => reuseVisibleRoom(client, "commons", session), /identity changed/);
});

test("invitation transport errors give an honest, actionable same-request retry message", () => {
  for (const error of [new DOMException("signal is aborted without reason", "AbortError"), new TypeError("Failed to fetch")]) {
    assert.match(invitationFailureMessage(error), /could not confirm the result/);
    assert.match(invitationFailureMessage(error), /same request/);
    assert.doesNotMatch(invitationFailureMessage(error), /signal is aborted/);
  }
  assert.equal(invitationFailureMessage(new Error("Ask for a new link.")), "Ask for a new link.");
});

test("general request failures hide raw transport and parser text but keep service messages", () => {
  for (const error of [new DOMException("signal is aborted without reason", "AbortError"), new DOMException("timed out", "TimeoutError"),
    new TypeError("Failed to fetch"), new SyntaxError("Unexpected token '<', \"<html>\" is not valid JSON")]) {
    assert.equal(requestFailureMessage(error), "The connection was interrupted and the result could not be confirmed");
  }
  assert.equal(requestFailureMessage(new Error("Membership is inactive.")), "Membership is inactive.");
});

test("invitation management recovery distinguishes listing, creation and cancellation", () => {
  const error = new TypeError("Failed to fetch");
  assert.match(invitationManagementFailureMessage(error, "list"), /Close and reopen/);
  assert.match(invitationManagementFailureMessage(error, "create"), /same request/);
  assert.match(invitationManagementFailureMessage(error, "cancel"), /same link again/);
  assert.equal(invitationManagementFailureMessage(new Error("Membership is inactive."), "create"), "Membership is inactive.");
});

test("invitation UI retries the same uncertain creation and preserves confirmed success when the list fails", async () => {
  const nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {
      value: "", textContent: "", hidden: false, disabled: false, open: false, dataset: {}, handlers: {}, attributes: {},
      setAttribute(name, value) { this.attributes[name] = String(value); }, getAttribute(name) { return this.attributes[name] ?? null; },
      classList: { toggle() {} },
      addEventListener(type, handler) { this.handlers[type] = handler; },
      contains() { return false; }, replaceChildren() {}, showModal() { this.open = true; }, close() { this.open = false; },
      focus() { focused = selector; },
    });
    return nodes.get(selector);
  };
  let focused = null, createAttempts = 0, lists = 0;
  const requests = [];
  const globals = { document: { querySelector: node }, window: { addEventListener() {} },
    location: { hostname: "localhost", origin: "http://localhost:52331" } };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const member = { id: "owner", kind: "human", revision: 1, permissions: ["manage_members"] };
  const session = { member };
  const client = {
    session, ownsAccountSession: () => true, generation: 0, path: suffix => suffix,
    async request(path, options) {
      assert.equal(path, "/share-links");
      if (options?.method === "POST") {
        requests.push(structuredClone(options.data));
        if (++createAttempts === 1) throw new TypeError("Failed to fetch");
        return { link: { id: "created-link", status: "active", expiresAt: options.data.expiresAt } };
      }
      if (++lists > 1) throw new TypeError("Failed to fetch");
      return { links: [] };
    },
  };
  try {
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    const ui = installShareLinks({ client, accountClient: {}, getState: () => ({ members: { owner: member } }), getSession: () => session, openRoom() {} });
    node("#share-link-expiry").value = "24";
    node("#share-link-limit").value = "2";
    await node("#invite-people-button").handlers.click();
    await node("#share-link-form").handlers.submit({ preventDefault() {} });
    assert.match(node("#share-link-status").textContent, /could not confirm the result/);
    assert.equal(node("#share-link-create").disabled, false);
    await node("#share-link-form").handlers.submit({ preventDefault() {} });
    assert.equal(createAttempts, 2);
    assert.deepEqual(requests[1], requests[0], "retry preserves token, request ID, expiry, scope and membership revision");
    assert.equal(node("#share-link-status").textContent, "Link ready.");
    assert.match(node("#share-management-status").textContent, /reload invitation links/);
    assert.equal(node("#share-link-result").hidden, false);
    assert.equal(node("#share-link-url").value, `http://localhost:52331/#join/${requests[0].linkToken}`);
    assert.match(node("#share-link-url").value, /#join\//);
    assert.doesNotMatch(node("#share-link-url").value, /#room\//);
    assert.doesNotMatch(node("#share-link-url").value, /^https:\/\/www\.getdasha\.com\/#join\//);
    assert.equal(node("#share-link-create").disabled, false);
    assert.equal(focused, "#share-link-copy");
    ui.resetManagement();
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

test("invitation UI writes a path-aware www /room join URL", async () => {
  const nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {
      value: "", textContent: "", hidden: false, disabled: false, open: false, dataset: {}, handlers: {}, attributes: {},
      setAttribute(name, value) { this.attributes[name] = String(value); }, getAttribute(name) { return this.attributes[name] ?? null; },
      classList: { toggle() {} },
      addEventListener(type, handler) { this.handlers[type] = handler; },
      contains() { return false; }, replaceChildren() {}, showModal() { this.open = true; }, close() { this.open = false; },
      focus() {},
    });
    return nodes.get(selector);
  };
  const globals = { document: { querySelector: node }, window: { addEventListener() {} },
    location: { hostname: "www.getdasha.com", origin: "https://www.getdasha.com", pathname: "/room/" } };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const member = { id: "owner", kind: "human", revision: 1, permissions: ["manage_members"] };
  const session = { member };
  let created;
  const client = {
    session, ownsAccountSession: () => true, generation: 0, path: suffix => suffix,
    async request(path, options) {
      if (options?.method === "POST") {
        created = structuredClone(options.data);
        return { link: { id: "www-link", status: "active", expiresAt: options.data.expiresAt }, code: "ABC-DEF-GHJ" };
      }
      return { links: [] };
    },
  };
  try {
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    const ui = installShareLinks({ client, accountClient: {}, getState: () => ({ members: { owner: member } }), getSession: () => session, openRoom() {} });
    node("#share-link-expiry").value = "24";
    node("#share-link-limit").value = "2";
    await node("#invite-people-button").handlers.click();
    await node("#share-link-form").handlers.submit({ preventDefault() {} });
    assert.equal(node("#share-link-url").value, `https://www.getdasha.com/room/#join/${created.linkToken}`);
    assert.doesNotMatch(node("#share-link-url").value, /^https:\/\/www\.getdasha\.com\/#join\//);
    assert.doesNotMatch(node("#share-link-url").value, /#room\//);
    ui.resetManagement();
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

test("mint unlocks Create before a hanging clipboard write and never uses origin-only #join/", async () => {
  const nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {
      value: "", textContent: "", hidden: false, disabled: false, open: false, dataset: {}, handlers: {}, attributes: {},
      setAttribute(name, value) { this.attributes[name] = String(value); }, getAttribute(name) { return this.attributes[name] ?? null; },
      classList: { toggle() {} },
      addEventListener(type, handler) { this.handlers[type] = handler; },
      contains() { return false; }, replaceChildren() {}, showModal() { this.open = true; }, close() { this.open = false; },
      focus() {},
    });
    return nodes.get(selector);
  };
  let finishClipboard;
  const globals = {
    document: { querySelector: node }, window: { addEventListener() {} },
    location: { hostname: "www.getdasha.com", origin: "https://www.getdasha.com", pathname: "/room/" },
    navigator: { clipboard: { writeText: value => { assert.match(value, /^https:\/\/www\.getdasha\.com\/room\/#join\/[A-Za-z0-9_-]{43}$/); return new Promise(resolve => { finishClipboard = resolve; }); } } }
  };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const member = { id: "owner", kind: "human", revision: 1, permissions: ["manage_members"] };
  const session = { member };
  let created;
  const client = {
    session, ownsAccountSession: () => true, generation: 0, path: suffix => suffix,
    async request(path, options) {
      if (options?.method === "POST") {
        created = structuredClone(options.data);
        return { link: { id: "hang-link", status: "active", expiresAt: options.data.expiresAt } };
      }
      return { links: [] };
    },
  };
  try {
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    const ui = installShareLinks({ client, accountClient: {}, getState: () => ({ members: { owner: member } }), getSession: () => session, openRoom() {} });
    node("#share-link-expiry").value = "24";
    node("#share-link-limit").value = "2";
    await node("#invite-people-button").handlers.click();
    const minted = node("#share-link-form").handlers.submit({ preventDefault() {} });
    await Promise.resolve();
    assert.equal(node("#share-link-create").disabled, false, "Create is usable while clipboard is still pending");
    assert.equal(node("#share-link-status").textContent, "Link ready.");
    assert.equal(node("#share-link-url").value, `https://www.getdasha.com/room/#join/${created.linkToken}`);
    assert.doesNotMatch(node("#share-link-url").value, /^https:\/\/www\.getdasha\.com\/#join\//);
    finishClipboard();
    await minted;
    assert.equal(node("#share-link-status").textContent, "Link copied.");
    ui.resetManagement();
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

const guestJoinDom = () => {
  const nodes = new Map();
  let focused = null;
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {
      value: "", textContent: "", hidden: false, disabled: false, open: false, dataset: {}, handlers: {}, attributes: {},
      setAttribute(name, value) { this.attributes[name] = String(value); }, getAttribute(name) { return this.attributes[name] ?? null; },
      classList: { toggle() {} }, addEventListener(type, handler) { this.handlers[type] = handler; },
      contains() { return false; }, replaceChildren() {}, reset() {}, showModal() { this.open = true; }, close() { this.open = false; },
      focus() { focused = selector; },
      querySelectorAll() { return [node("#join-link-name"), node("#join-link-submit"), node("#join-link-close")]; },
    });
    return nodes.get(selector);
  };
  const storage = new Map();
  const localStorage = {
    getItem: key => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)); },
    removeItem: key => { storage.delete(key); },
  };
  const joinStorage = new Map();
  const sessionStorage = {
    getItem: key => (joinStorage.has(key) ? joinStorage.get(key) : null),
    setItem: (key, value) => { joinStorage.set(key, String(value)); },
    removeItem: key => { joinStorage.delete(key); },
  };
  const location = { hostname: "localhost", origin: "http://localhost:52331", hash: "" };
  const globals = { document: { querySelector: node }, window: { addEventListener() {}, sessionStorage }, location, localStorage, sessionStorage };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const install = () => { for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); };
  const uninstall = () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  };
  return { node, nodes, location, storage, joinStorage, focused: () => focused, install, uninstall };
};

const previewFor = (title = "Synthetic room") => ({
  room: { id: "commons", title }, access: "Conversation only.",
  link: { expiresAt: Date.now() + 3600000, remainingJoins: 2 },
});

test("uncertain join records round-trip, expire, and clear", () => {
  const storage = new Map();
  const localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) };
  assert.equal(readUncertainJoin(localStorage), null);
  writeUncertainJoin({ linkToken: "t".repeat(43), redemptionId: "redemption-1", displayName: "Guest One" }, localStorage);
  const record = readUncertainJoin(localStorage);
  assert.equal(record.redemptionId, "redemption-1");
  assert.equal(record.displayName, "Guest One");
  clearUncertainJoin(localStorage);
  assert.equal(readUncertainJoin(localStorage), null);
  // Malformed or stale records never resume a join.
  storage.set("room.guestJoin.uncertain.v1", "not json");
  assert.equal(readUncertainJoin(localStorage), null);
  storage.set("room.guestJoin.uncertain.v1", JSON.stringify({ linkToken: "short", redemptionId: "r", displayName: "x", at: Date.now() }));
  assert.equal(readUncertainJoin(localStorage), null);
  const stale = { linkToken: "t".repeat(43), redemptionId: "r", displayName: "x", at: Date.now() - 13 * 3600 * 1000 };
  storage.set("room.guestJoin.uncertain.v1", JSON.stringify(stale));
  assert.equal(readUncertainJoin(localStorage), null);
  assert.equal(readUncertainJoin(undefined), null, "missing storage is not a crash");
});

test("interrupted guest join auto-recovers the same request and opens the room", async () => {
  const dom = guestJoinDom();
  let rejectJoin, attempts = 0, opened = null, restores = 0;
  const calls = [];
  const accountClient = {
    session: {},
    async restore() { restores++; return this.session; },
    async prepareShareLink() { return { session: this.session, preview: previewFor() }; },
    async joinShareLink(request) {
      calls.push(structuredClone(request));
      if (++attempts === 1) return new Promise((_, reject) => { rejectJoin = reject; });
      return { roomId: "commons", session: { member: { id: "same-guest" } } };
    },
  };
  dom.install();
  try {
    const ui = installShareLinks({ client: { generation: 0 }, accountClient, getState: () => null, getSession: () => null,
      async openRoom(roomId, roomMode, session) { opened = { roomId, roomMode, session }; } });
    await ui.open({ token: "s".repeat(43) });
    dom.node("#join-link-name").value = "Retry guest";
    const pending = dom.node("#join-link-form").handlers.submit({ preventDefault() {} });
    assert.equal(dom.node("#join-link-submit").disabled, true, "controls stay locked while the join is in flight");
    assert.equal(dom.node("#join-link-close").disabled, true);
    let escapePrevented = false;
    dom.node("#join-link-dialog").handlers.cancel({ preventDefault() { escapePrevented = true; } });
    assert.equal(escapePrevented, true);
    rejectJoin(new TypeError("Synthetic lost response"));
    await pending;
    // The lost response triggers an automatic idempotent re-check: the session
    // is restored first, then the SAME redemption id is re-issued.
    assert.equal(restores, 1);
    assert.equal(attempts, 2);
    assert.deepEqual(calls[1], calls[0], "recovery re-issues the identical request, never a second join");
    assert.equal(opened.session.member.id, "same-guest");
    assert.equal(dom.node("#join-link-dialog").open, false);
    assert.equal(dom.focused(), "#message-input");
    assert.equal(readUncertainJoin(), null, "confirmed success clears the optimistic record");
    ui.resetManagement?.();
  } finally { dom.uninstall(); }
});

test("double-interrupted guest join stays honest, keeps the record, and names the room", async () => {
  const dom = guestJoinDom();
  const calls = [];
  const accountClient = {
    session: {},
    async restore() { return this.session; },
    async prepareShareLink() { return { session: this.session, preview: previewFor("Dogfood room") }; },
    async joinShareLink(request) { calls.push(structuredClone(request)); throw new TypeError("Synthetic lost response"); },
  };
  dom.install();
  try {
    const ui = installShareLinks({ client: { generation: 0 }, accountClient, getState: () => null, getSession: () => null,
      async openRoom() { throw new Error("must not open"); } });
    await ui.open({ token: "s".repeat(43) });
    dom.node("#join-link-name").value = "Unlucky guest";
    await dom.node("#join-link-form").handlers.submit({ preventDefault() {} });
    assert.equal(calls.length, 2, "one automatic re-check, then honesty");
    assert.deepEqual(calls[1], calls[0]);
    assert.match(dom.node("#join-link-status").textContent, /couldn't confirm whether you joined “Dogfood room”/);
    assert.match(dom.node("#join-link-status").textContent, /can't be joined twice/);
    assert.equal(dom.node("#join-link-dialog").open, true, "dialog stays open with the recovery path");
    const record = readUncertainJoin();
    assert.equal(record?.redemptionId, calls[0].redemptionId, "uncertain outcome keeps the record for reload recovery");
    assert.equal(dom.focused(), "#join-link-submit");
  } finally { dom.uninstall(); }
});

test("confirmed join rejection rolls the optimistic record back", async () => {
  const dom = guestJoinDom();
  const expired = new Error("This invite link has expired, been cancelled, or reached its join limit. Ask for a new invite link.");
  expired.status = 410; expired.code = "link_unavailable";
  const accountClient = {
    session: {},
    async prepareShareLink() { return { session: this.session, preview: previewFor() }; },
    async joinShareLink() { throw expired; },
  };
  dom.install();
  try {
    const ui = installShareLinks({ client: { generation: 0 }, accountClient, getState: () => null, getSession: () => null,
      async openRoom() { throw new Error("must not open"); } });
    await ui.open({ token: "s".repeat(43) });
    dom.node("#join-link-name").value = "Late guest";
    await dom.node("#join-link-form").handlers.submit({ preventDefault() {} });
    assert.match(dom.node("#join-link-status").textContent, /expired, been cancelled/);
    assert.equal(readUncertainJoin(), null, "confirmed failure clears the optimistic record");
    assert.equal(dom.node("#join-link-dialog").open, true);
  } finally { dom.uninstall(); }
});

test("reload resumes the uncertain join with the same redemption id", async () => {
  const dom = guestJoinDom();
  const token = "r".repeat(43);
  const calls = [];
  let opened = null;
  const accountClient = {
    session: {},
    async restore() { return this.session; },
    async prepareShareLink() { return { session: this.session, preview: previewFor("Resume room") }; },
    async joinShareLink(request) {
      calls.push(structuredClone(request));
      return { roomId: "commons", session: { member: { id: "resumed-guest" } } };
    },
  };
  dom.install();
  try {
    writeUncertainJoin({ linkToken: token, redemptionId: "stored-redemption-9", displayName: "Returning guest" });
    const ui = installShareLinks({ client: { generation: 0 }, accountClient, getState: () => null, getSession: () => null,
      async openRoom(roomId, roomMode, session) { opened = { roomId, roomMode, session }; } });
    await ui.open({ token });
    assert.equal(dom.node("#join-link-name").value, "Returning guest", "name is prefilled from the saved request");
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(calls.length, 1, "the uncertain join is re-checked automatically");
    assert.equal(calls[0].redemptionId, "stored-redemption-9", "same redemption id, never a second join");
    assert.equal(calls[0].displayName, "Returning guest");
    assert.equal(opened.session.member.id, "resumed-guest");
    assert.equal(dom.node("#join-link-dialog").open, false);
  } finally { dom.uninstall(); }
});

test("a failed join keeps the invitation in the address bar instead of stranding the guest", async () => {
  const dom = guestJoinDom();
  const token = "f".repeat(43);
  const expired = new Error("This invite link has expired, been cancelled, or reached its join limit. Ask for a new invite link.");
  expired.status = 410; expired.code = "link_unavailable";
  let statusText = "";
  const accountClient = {
    session: {},
    async prepareShareLink() { return { session: this.session, preview: previewFor("Stranded room") }; },
    async joinShareLink() { throw expired; },
  };
  dom.install();
  try {
    const ui = installShareLinks({ client: { generation: 0 }, accountClient, getState: () => null, getSession: () => null,
      async openRoom() { throw new Error("must not open"); },
      setConnectionStatus: text => { statusText = text; } });
    await ui.open({ token });
    dom.node("#join-link-name").value = "Late guest";
    await dom.node("#join-link-form").handlers.submit({ preventDefault() {} });
    // The guest closes the failed dialog: the invitation stays actionable in
    // the address bar and the connection status orients back to the room.
    dom.node("#join-link-dialog").handlers.close();
    assert.equal(dom.location.hash, `#join/${token}`);
    assert.match(statusText, /your invitation to “Stranded room” is still open in the address bar/);
  } finally { dom.uninstall(); }
});

test("a successful join leaves no invitation fragment behind", async () => {
  const dom = guestJoinDom();
  const token = "g".repeat(43);
  const accountClient = {
    session: {},
    async prepareShareLink() { return { session: this.session, preview: previewFor() }; },
    async joinShareLink() { return { roomId: "commons", session: { member: { id: "lucky-guest" } } }; },
  };
  dom.install();
  try {
    const ui = installShareLinks({ client: { generation: 0 }, accountClient, getState: () => null, getSession: () => null,
      async openRoom() {} });
    await ui.open({ token });
    dom.node("#join-link-name").value = "Lucky guest";
    await dom.node("#join-link-form").handlers.submit({ preventDefault() {} });
    assert.equal(dom.node("#join-link-dialog").open, false);
    assert.equal(dom.location.hash, "", "landed guests keep a clean address bar");
  } finally { dom.uninstall(); }
});

test("open-room failure after a join recovers the credential and navigates", async () => {
  const dom = guestJoinDom();
  const calls = [];
  let openAttempts = 0, opened = null;
  const accountClient = {
    session: {},
    async restore() { return this.session; },
    async prepareShareLink() { return { session: this.session, preview: previewFor() }; },
    async joinShareLink(request) {
      calls.push(structuredClone(request));
      return { roomId: "commons", duplicate: true, session: { member: { id: "same-guest" } } };
    },
  };
  dom.install();
  try {
    const ui = installShareLinks({ client: { generation: 0 }, accountClient, getState: () => null, getSession: () => null,
      async openRoom(roomId, roomMode, session) {
        if (++openAttempts === 1) throw new TypeError("Synthetic navigation loss");
        opened = { roomId, roomMode, session };
      } });
    await ui.open({ token: "o".repeat(43) });
    dom.node("#join-link-name").value = "Navigating guest";
    await dom.node("#join-link-form").handlers.submit({ preventDefault() {} });
    assert.equal(openAttempts, 2, "the recovery re-navigates after re-checking the join");
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], calls[0], "recovery uses the identical idempotent request");
    assert.equal(opened.session.member.id, "same-guest");
    assert.equal(dom.node("#join-link-dialog").open, false);
    assert.equal(readUncertainJoin(), null);
  } finally { dom.uninstall(); }
});


for (const code of ["csrf_denied", "session_binding_changed", "stale_session_revision", "account_session_required"]) {
  test(`changed guest session (${code}) requires review and explicit identity confirmation`, async () => {
    const dom = guestJoinDom(); let joins = 0, restores = 0, opened = 0;
    const accountClient = {
      session: {},
      async prepareShareLink() { return { session: this.session, preview: previewFor() }; },
      async restore() { restores++; return this.session = { authenticated: true, account: { id: "other-tab-identity" } }; },
      async joinShareLink() {
        if (++joins === 1) throw Object.assign(new Error("Session confirmation required; sign in again"), { code });
        return { roomId: "commons", session: { member: { id: "same-guest" } } };
      }
    };
    dom.install();
    try {
      const ui = installShareLinks({ client: { generation: 0 }, accountClient,
        getState: () => null, getSession: () => null, async openRoom() { opened++; } });
      await ui.open({ token: "t".repeat(43) });
      const submit = () => dom.node("#join-link-form").handlers.submit({ preventDefault() {} });
      await submit();
      assert.equal(restores, 0, "no silent session replacement");
      assert.equal(dom.node("#join-link-form").hidden, true);
      assert.equal(dom.focused(), "#join-link-retry");
      assert.match(dom.node("#join-link-status").textContent, /another tab/);
      await submit();
      assert.equal(joins, 1, "stale form cannot bypass review");
      await dom.node("#join-link-retry").handlers.click();
      assert.equal(restores, 1);
      assert.equal(joins, 1, "review never redeems an invitation");
      assert.equal(opened, 0);
      assert.match(dom.node("#join-link-status").textContent, /other-tab-identity/);
      accountClient.session = { ...accountClient.session };
      await submit();
      assert.equal(joins, 1, "a second identity change requires another review");
      await dom.node("#join-link-retry").handlers.click();
      await submit();
      assert.equal(joins, 2);
      assert.equal(opened, 1);
    } finally { dom.uninstall(); }
  });
}

test("lost guest cookie keeps the original join request and shows recovery instead of blind retry", async () => {
  const dom = guestJoinDom(), calls = [];
  const accountClient = {
    session: { authenticated: false, account: null }, async restore() { return this.session; },
    async logout() { return this.session; },
    async prepareShareLink() { return { session: this.session, preview: previewFor() }; },
    async joinShareLink(request) {
      calls.push(structuredClone(request));
      throw Object.assign(new Error("Return to your original browser session. No additional guest was created."), { code: "join_session_lost", status: 409 });
    }
  };
  dom.install();
  try {
    const ui = installShareLinks({ client: { generation: 0 }, accountClient, getState: () => null, getSession: () => null,
      async openRoom() { throw new Error("must not open another identity"); } });
    await ui.open({ token: "s".repeat(43) });
    dom.node("#join-link-name").value = "Jill";
    await dom.node("#join-link-form").handlers.submit({ preventDefault() {} });
    assert.equal(calls.length, 1);
    assert.equal(dom.node("#join-link-signout").hidden, false);
    assert.match(dom.node("#join-link-signout").textContent, /uses another place/);
    assert.equal(readUncertainJoin().redemptionId, calls[0].redemptionId);
    assert.match(dom.node("#join-link-status").textContent, /original browser session/);
    assert.equal(dom.node("#join-account-choices").hidden, false, "the recovery message offers a visible sign-in action");
    assert.doesNotMatch(dom.node("#join-link-status").textContent, /couldn't confirm/);
    await dom.node("#join-link-form").handlers.submit({ preventDefault() {} });
    assert.deepEqual(calls[1], calls[0]);
    assert.equal(readUncertainJoin().redemptionId, calls[0].redemptionId);
    await dom.node("#join-link-signout").handlers.click();
    assert.equal(readUncertainJoin(), null, "only the explicit start-over clears recovery");
    await dom.node("#join-link-form").handlers.submit({ preventDefault() {} });
    assert.notEqual(calls[2].redemptionId, calls[0].redemptionId);
  } finally { dom.uninstall(); }
});


test("reload recovers a pending join even when its success filled the invitation", async () => {
  const dom = guestJoinDom(); let recovered = null, opened = false;
  const token = "s".repeat(43), redemptionId = crypto.randomUUID();
  const accountClient = {
    session: {}, async restore() { return this.session; },
    async prepareShareLink() { throw Object.assign(new Error("Full invitation"), { code: "link_unavailable", status: 410 }); },
    async joinShareLink(request) { recovered = request; return { roomId: "commons", session: { member: { id: "same-guest" } } }; }
  };
  dom.install();
  try {
    writeUncertainJoin({ linkToken: token, redemptionId, displayName: "Jill", roomId: "commons", roomTitle: "Room" });
    const ui = installShareLinks({ client: { generation: 0 }, accountClient, getState: () => null, getSession: () => null,
      async openRoom() { opened = true; } });
    await ui.open({ token });
    assert.equal(recovered.redemptionId, redemptionId);
    assert.equal(recovered.linkToken, token);
    assert.equal(opened, true);
    assert.equal(readUncertainJoin(), null);
  } finally { dom.uninstall(); }
});

test("a signed-in person on a dead link keeps the fresh-link ask and a way back to their rooms", async () => {
  const dom = guestJoinDom();
  const accountClient = {
    session: { authenticated: true, account: { id: "signed-in-person" } },
    async prepareShareLink() { throw Object.assign(new Error("gone"), { code: "link_unavailable", status: 410 }); },
  };
  dom.install();
  try {
    const ui = installShareLinks({ client: { generation: 0 }, accountClient, getState: () => null, getSession: () => null, openRoom() {} });
    await ui.open({ token: "c".repeat(43) });
    assert.equal(dom.node("#join-link-title").textContent, "This invite has ended");
    assert.match(dom.node("#join-link-scope").textContent, /fresh link/);
    assert.doesNotMatch(dom.node("#join-link-status").textContent, /Sign in and request access/);
    assert.match(dom.node("#join-link-status").textContent, /fresh link/);
    assert.equal(dom.node("#join-account-signin").hidden, true, "no Log in choice for a signed-in person");
    assert.equal(dom.node("#join-account-guest-hint").hidden, true, "no guest hint for a signed-in person");
    const roomsLink = dom.node("#join-account-rooms-link");
    assert.equal(roomsLink.hidden, false, "a signed-in person can get back to their rooms");
    assert.equal(roomsLink.textContent, "Back to your rooms", "the rooms link has visible, named text");
    assert.equal(roomsLink.getAttribute("href"), "http://localhost:52331", "the rooms link lands on the app root");
    dom.joinStorage.set("pr-pending-join", "#join/" + "c".repeat(43));
    await roomsLink.handlers.click();
    assert.equal(dom.joinStorage.has("pr-pending-join"), false, "the dead link's pending-join mirror is gone before the app root loads");
  } finally { dom.uninstall(); }
});

test("a later open after a signed-in dead invite restores the sign-in and guest choices", async () => {
  const dom = guestJoinDom();
  let dead = true;
  const accountClient = {
    session: { authenticated: true, account: { id: "signed-in-person" } },
    async prepareShareLink() {
      if (dead) throw Object.assign(new Error("gone"), { code: "link_unavailable", status: 410 });
      return { session: this.session, preview: previewFor() };
    },
  };
  dom.install();
  try {
    const ui = installShareLinks({ client: { generation: 0 }, accountClient, getState: () => null, getSession: () => null, openRoom() {} });
    await ui.open({ token: "d".repeat(43) });
    assert.equal(dom.node("#join-account-signin").hidden, true);
    dead = false; accountClient.session = {};
    await ui.open({ token: "e".repeat(43) });
    assert.equal(dom.node("#join-account-signin").hidden, false, "signed-out join path keeps its Log in choice");
    assert.equal(dom.node("#join-account-guest-hint").hidden, false);
    assert.equal(dom.node("#join-account-rooms-link").hidden, true);
  } finally { dom.uninstall(); }
});

test("an invite landing names who invited you", async () => {
  const dom = guestJoinDom();
  const accountClient = {
    session: {},
    async prepareShareLink() {
      return { session: this.session, preview: { ...previewFor("Commons"), inviterDisplayName: "Ada" } };
    },
  };
  dom.install();
  try {
    const ui = installShareLinks({ client: { generation: 0 }, accountClient, getState: () => null, getSession: () => null, openRoom() {} });
    await ui.open({ token: "n".repeat(43) });
    assert.equal(dom.node("#join-inviter-line").textContent, "Ada invited you.");
    assert.match(dom.node("#join-link-title").textContent, /Commons/);
  } finally { dom.uninstall(); }
});

test("a dead invite link asks for a fresh one and offers sign-in", async () => {
  const dom = guestJoinDom();
  const accountClient = {
    session: null,
    async prepareShareLink() { throw Object.assign(new Error("gone"), { code: "link_unavailable", status: 410 }); },
  };
  dom.install();
  try {
    const ui = installShareLinks({ client: { generation: 0 }, accountClient, getState: () => null, getSession: () => null, openRoom() {} });
    await ui.open({ token: "b".repeat(43) });
    assert.equal(dom.node("#join-link-title").textContent, "This invite has ended");
    assert.match(dom.node("#join-link-scope").textContent, /fresh link/);
    assert.match(dom.node("#join-link-status").textContent, /Sign in and request access/);
    assert.equal(dom.node("#join-account-choices").hidden, false);
    assert.equal(dom.node("#join-link-dialog").open, true);
    assert.equal(dom.node("#join-link-scope").textContent.includes("incomplete"), false);
  } finally { dom.uninstall(); }
});
