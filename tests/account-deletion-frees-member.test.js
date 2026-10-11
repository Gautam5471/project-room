// bug-deleted-account-member-stays-active-20261010 (P3, Grok Bot repro on
// prod 8c2b308b): deleting an account removed its member_accounts binding
// but left the room member active, so the roster still listed the deleted
// person and the next joiner with that display name got 422
// display_name_unavailable. Deletion now ends the membership.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

async function startServer(t, f) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
    rmSync(f.directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (origin, path, data, extra = {}) => fetch(origin + path, {
  method: "POST", headers: { "Content-Type": "application/json", Origin: origin, ...extra }, body: JSON.stringify(data)
});

async function memberAccount(t, permissions = ["accept_work"]) {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const email = "frees-member@example.invalid";
  const slot = f.store.createAccountSessionSlot();
  const res = await post(origin, "/api/auth/password/signup", {
    email, password: "fixture-password-frees-member-long", sessionToken: slot.token, sessionRevision: slot.session.sessionRevision
  });
  assert.equal(res.status, 202, await res.clone().text());
  const token = /account_session=([^;]+)/.exec(res.headers.get("set-cookie") || "")?.[1];
  const session = f.store.authenticateAccountSession(token);
  f.store.accountLogins.markEmailVerified(session.account.id, email);
  const ownerKey = f.store.issueAccessKey("commons", "owner");
  const send = (type, data) => f.store.command(ownerKey, "commons", { id: randomUUID(), type, data });
  send(T.MEMBER_ADDED, { memberId: "probe-human", displayName: "Probe73882", kind: "human", permissions });
  f.store.bindHumanAccount("commons", "probe-human", session.account.id);
  const creds = { Cookie: `account_session=${token}`, "X-CSRF-Token": session.csrf };
  return { f, origin, creds, send, accountId: session.account.id };
}

async function deleteAccount(ctx) {
  const planned = await (await fetch(ctx.origin + "/api/account/deletion/plan", { headers: { Cookie: ctx.creds.Cookie } })).json();
  const res = await post(ctx.origin, "/api/account/delete", { confirmationToken: planned.confirmationToken }, ctx.creds);
  assert.equal(res.status, 200, await res.clone().text());
}

test("deleting an account ends its room membership", async t => {
  const ctx = await memberAccount(t);
  assert.equal(ctx.f.store.room("commons").state.members["probe-human"].active, true);
  await deleteAccount(ctx);
  assert.equal(ctx.f.store.room("commons").state.members["probe-human"].active, false);
});

test("a deleted account's display name can be used by the next joiner", async t => {
  const ctx = await memberAccount(t);
  await deleteAccount(ctx);
  ctx.send(T.MEMBER_ADDED, { memberId: "next-human", displayName: "Probe73882", kind: "human", permissions: ["accept_work"] });
  assert.equal(ctx.f.store.room("commons").state.members["next-human"].displayName, "Probe73882");
});

test("deletion still leaves the integrity audit consistent and history readable", async t => {
  const ctx = await memberAccount(t);
  ctx.f.store.command(ctx.f.store.issueAccessKey("commons", "owner"), "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: "before-delete", body: "kept" } });
  await deleteAccount(ctx);
  assert.equal(ctx.f.store.verifyInvitationAudit().consistent, true);
  assert.equal(ctx.f.store.room("commons").state.messages.find(m => m.id === "before-delete").body, "kept");
});

test("deleting an invite-only human account ends its room membership", async t => {
  const ctx = await memberAccount(t, ["invite_member"]);
  await deleteAccount(ctx);
  assert.equal(ctx.f.store.account(ctx.accountId).active, false);
  assert.equal(ctx.f.store.room("commons").state.members["probe-human"].active, false);
});
