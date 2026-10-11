// A guest has no email, so account deletion is confirmed by typing DELETE.
// Minimal DOM double (not browser evidence); no deletion request is sent.
import test from "node:test";
import assert from "node:assert/strict";
import { createAccountSettingsUI } from "../src/account-settings-ui.js";

function fixture(methods) {
  const doc = { activeElement: null };
  const node = () => ({ hidden: false, disabled: false, children: [], value: "", type: "", text: "",
    focus() { doc.activeElement = this; }, closest() { return null; }, getClientRects() { return [{}]; },
    append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; },
    set textContent(v) { this.text = v; this.children = []; }, get textContent() { return this.text; } });
  doc.createElement = node;
  const summary = node(), blocked = node(), input = Object.assign(node(), { name: "confirmEmail" }), submit = node(), cancel = node(), label = node();
  const form = { hidden: true, elements: { confirmEmail: input }, reset() { input.value = ""; },
    querySelector: selector => selector === "[data-delete-confirm-label]" ? label : submit };
  const dialog = { open: false, showModal() { this.open = true; }, close() { this.open = false },
    querySelector: selector => ({ "[data-deletion-summary]": summary, "[data-deletion-blocked]": blocked,
      'form[data-form="delete-account"]': form, "[data-action='delete-account-cancel']": cancel })[selector] ?? null,
    querySelectorAll: () => [] };
  const listeners = {};
  const container = { innerHTML: "", addEventListener(name, fn) { listeners[name] = fn; }, removeEventListener() {}, contains: () => true,
    querySelector: selector => selector === "[data-deletion-dialog]" ? dialog : selector === 'form[data-form="delete-account"]' ? form : null };
  const client = { currentSession: () => ({}), async request(path) {
    if (path === "/api/auth/methods") return { methods };
    if (path === "/api/account/deletion/plan") return { confirmationToken: "fixture-only", summary: { text: "inventory" }, plan: { rooms: {} } };
    throw new Error("Unexpected request: " + path);
  } };
  return { doc, container, client, listeners, input, submit, label };
}

async function open(t, methods) {
  const f = fixture(methods), original = globalThis.document;
  globalThis.document = f.doc;
  t.after(() => { if (original === undefined) delete globalThis.document; else globalThis.document = original; });
  await createAccountSettingsUI({ accountClient: f.client }).mount(f.container);
  await f.listeners.click({ target: { closest: () => ({ dataset: { action: "delete-account" } }) } });
  const type = value => { f.input.value = value; f.listeners.input({ target: f.input }); };
  return { ...f, type };
}

test("a guest confirms deletion by typing DELETE, not an email", async t => {
  const f = await open(t, []);
  assert.equal(f.label.text, "Type DELETE to confirm");
  assert.equal(f.input.type, "text");
  assert.equal(f.submit.disabled, true, "disabled until something is typed");
  f.type("gus@example.invalid"); assert.equal(f.submit.disabled, true);
  f.type("delet"); assert.equal(f.submit.disabled, true);
  f.type("  DELETE "); assert.equal(f.submit.disabled, false, "case and surrounding space are ignored");
});

test("an account with an email confirms with that email and DELETE is refused", async t => {
  const f = await open(t, [{ type: "password", email: "Owner@Example.invalid" }]);
  assert.equal(f.label.text, "Type your account email to confirm");
  assert.equal(f.input.type, "email");
  f.type("DELETE"); assert.equal(f.submit.disabled, true);
  f.type("owner@example.invalid"); assert.equal(f.submit.disabled, false);
});
