// HTTP integration tests for Google sign-in (phase 2): the
// /api/auth/google/start and /api/auth/google/callback routes in
// server/http.mjs, wired to server/google-oauth.mjs with no Clerk and no
// provider-onboarding. Google's token and JWKS endpoints are mocked; no
// network calls, no real credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { clientId, clientSecret, sub, googleAuth } from "../scripts/helpers/google-oauth-fixture.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { GOOGLE_START_PATH, GOOGLE_CALLBACK_PATH, GOOGLE_SCOPES } from "../server/google-oauth.mjs";
import * as T from "../src/events.js";

async function startServer(t, f, options = {}) {
  const server = createRoomServer({ store: f.store, ...options });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}


function authCookie(f, accountId, withMethod = null) {
  const slot = f.store.createAccountSessionSlot();
  const revision = slot.session.sessionRevision;
  if (withMethod) f.store.loginAccountSessionWithMethod(slot.token, accountId, revision, { method: withMethod });
  else f.store.loginAccountSession(slot.token, f.store.issueAccountAccessKey(accountId), revision);
  return { cookie: `account_session=${slot.token}`, csrf: f.store.accountSessionSlot(slot.token).csrf };
};

const accountCookie = res => {
  const setCookie = res.headers.get("set-cookie") || "";
  const match = /account_session=([A-Za-z0-9_-]{43})/.exec(setCookie);
  return match?.[1] ?? null;
};

async function beginFlow(origin, cookieHeader) {
  const start = await fetch(origin + GOOGLE_START_PATH, {
    redirect: "manual", headers: cookieHeader ? { Cookie: cookieHeader } : {}
  });
  assert.equal(start.status, 302);
  const authorize = new URL(start.headers.get("location"));
  assert.equal(authorize.origin, "https://accounts.google.com");
  assert.equal(authorize.searchParams.get("client_id"), clientId);
  assert.equal(authorize.searchParams.get("redirect_uri"), origin + GOOGLE_CALLBACK_PATH);
  assert.equal(authorize.searchParams.get("scope"), GOOGLE_SCOPES);
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.match(authorize.searchParams.get("state") || "", /^[A-Za-z0-9_-]{43}$/);
  return { authorize, slotCookie: accountCookie(start) };
}

test("start redirects to Google with PKCE and mints an account session slot", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f, { googleAuth: googleAuth() });
  const { slotCookie } = await beginFlow(origin);
  assert.ok(slotCookie, "start sets the account session cookie");
  const slot = f.store.accountSessionSlot(slotCookie);
  assert.equal(slot.account, null, "slot is unauthenticated until the callback");
});

test("start reuses the existing account session slot", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f, { googleAuth: googleAuth() });
  const first = await beginFlow(origin);
  const second = await beginFlow(origin, `account_session=${first.slotCookie}`);
  assert.equal(second.slotCookie, null, "no new slot cookie when one already exists");
});

test("start is 503 with honest JSON when Google is not configured", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const res = await fetch(origin + GOOGLE_START_PATH, { redirect: "manual" });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.reason, "google_not_configured");
  assert.equal(JSON.stringify(body).includes(clientSecret), false);
});

test("unconfigured Google browser navigation returns to sign-in without minting a session", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const res = await fetch(origin + GOOGLE_START_PATH, { redirect: "manual", headers: { Accept: "text/html,application/xhtml+xml" } });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/?google=unavailable");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("set-cookie"), null);
  assert.equal(await res.text(), "");
});

test("configured Google browser navigation still begins the PKCE flow", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f, { googleAuth: googleAuth() });
  const res = await fetch(origin + GOOGLE_START_PATH, { redirect: "manual", headers: { Accept: "text/html" } });
  assert.equal(res.status, 302);
  const authorize = new URL(res.headers.get("location"));
  assert.equal(authorize.origin, "https://accounts.google.com");
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.ok(accountCookie(res));
});

test("start rejects non-GET methods", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f, { googleAuth: googleAuth() });
  const res = await fetch(origin + GOOGLE_START_PATH, { method: "POST" });
  assert.equal(res.status, 405);
});

test("callback success establishes the session and returns the same-origin page", async t => {
  const f = createAcceptanceFixture();
  // The Google account already belongs to commons, so the landing opens it.
  const pre = f.store.createAccountSessionSlot();
  f.store.loginAccountSessionWithGoogle(pre.token, sub, 0);
  f.store.command(f.keys.owner, "commons", { id: "google-member-1", type: T.EVENT_TYPES.MEMBER_ADDED,
    data: { memberId: "googler", displayName: "Googler", kind: "human", permissions: [] } });
  f.store.bindHumanAccount("commons", "googler", `google:${sub}`);

  const origin = await startServer(t, f, { googleAuth: googleAuth() });
  const { authorize, slotCookie } = await beginFlow(origin);
  const callback = await fetch(
    `${origin}${GOOGLE_CALLBACK_PATH}?state=${authorize.searchParams.get("state")}&code=code-fixture`,
    { redirect: "manual", headers: { Cookie: `account_session=${slotCookie}` } });
  assert.equal(callback.status, 200);
  const html = await callback.text();
  assert.match(html, /content="0;url=\/\?room=commons"/);
  const sessionCookie = accountCookie(callback);
  // QAS-702: the callback mints a fresh slot token — the pre-login token is
  // dead and the fresh cookie token carries the Google session.
  assert.ok(sessionCookie && sessionCookie !== slotCookie, "the callback rotates the session slot");
  assert.throws(() => f.store.authenticateAccountSession(slotCookie), { code: "unauthenticated" });
  const session = f.store.authenticateAccountSession(sessionCookie);
  assert.equal(session.account.id, `google:${sub}`);
  assert.doesNotMatch(session.account.id, /@/);
  // The account row uses the Google subject, never the email address.
  const row = f.store.db.prepare("SELECT id, origin FROM accounts WHERE id=?").get(`google:${sub}`);
  assert.equal(row.origin, "google");
  // No secret material leaks into the returned page.
  assert.equal(html.includes(clientSecret), false);
  assert.equal(html.includes("code-fixture"), false);
});

test("callback success without rooms lands on the account home, session established", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f, { googleAuth: googleAuth() });
  const { authorize, slotCookie } = await beginFlow(origin);
  const callback = await fetch(
    `${origin}${GOOGLE_CALLBACK_PATH}?state=${authorize.searchParams.get("state")}&code=code-fixture`,
    { redirect: "manual", headers: { Cookie: `account_session=${slotCookie}` } });
  assert.equal(callback.status, 200);
  const html = await callback.text();
  // A fresh account has no rooms: the post-login page must land on the
  // account home (room list + "New room" + invite redemption), not the
  // error path that silently bounced users back to the login form.
  assert.match(html, /url=\/\?account=1/);
  const sessionCookie = accountCookie(callback);
  assert.ok(sessionCookie, "session cookie is set even without a room to open");
  const session = f.store.authenticateAccountSession(sessionCookie);
  assert.equal(session.account.id, `google:${sub}`);
});

test("callback with a state mismatch provisions no account", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f, { googleAuth: googleAuth() });
  await beginFlow(origin);
  const bad = await fetch(`${origin}${GOOGLE_CALLBACK_PATH}?state=${"x".repeat(43)}&code=code-fixture`, { redirect: "manual" });
  assert.equal(bad.status, 200);
  assert.match(await bad.text(), /url=\/\?google=error/);
  assert.equal(bad.headers.get("set-cookie") || "", "");
  // Internal stage and schema hints stay in the server log, never on the response.
  assert.equal(bad.headers.get("X-Room-Auth-Diagnostic"), null);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM accounts WHERE id LIKE 'google:%'").get().n, 0);
});

test("callback with a provider denial provisions no account", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f, { googleAuth: googleAuth() });
  const { authorize } = await beginFlow(origin);
  const denied = await fetch(
    `${origin}${GOOGLE_CALLBACK_PATH}?state=${authorize.searchParams.get("state")}&error=access_denied`,
    { redirect: "manual" });
  assert.equal(denied.status, 200);
  assert.match(await denied.text(), /url=\/\?google=error/);
  assert.equal(denied.headers.get("X-Room-Auth-Diagnostic"), null);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM accounts WHERE id LIKE 'google:%'").get().n, 0);
});

test("callback is 503 with honest JSON when Google is not configured", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const res = await fetch(`${origin}${GOOGLE_CALLBACK_PATH}?state=${"y".repeat(43)}&code=x`, { redirect: "manual" });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.reason, "google_not_configured");
});

test("callback rejects non-GET methods", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f, { googleAuth: googleAuth() });
  const res = await fetch(origin + GOOGLE_CALLBACK_PATH, { method: "POST" });
  assert.equal(res.status, 405);
});

test("second login with the same Google subject reuses the account", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f, { googleAuth: googleAuth() });
  for (let i = 0; i < 2; i++) {
    const { authorize, slotCookie } = await beginFlow(origin);
    const callback = await fetch(
      `${origin}${GOOGLE_CALLBACK_PATH}?state=${authorize.searchParams.get("state")}&code=code-${i}`,
      { redirect: "manual", headers: { Cookie: `account_session=${slotCookie}` } });
    assert.equal(callback.status, 200);
    const session = f.store.authenticateAccountSession(accountCookie(callback));
    assert.equal(session.account.id, `google:${sub}`);
  }
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM accounts WHERE id=?").get(`google:${sub}`).n, 1);
});


test("GET /api/auth/google/link/start 401s anonymously, 503s when Google is not configured", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  // Auth is checked before provider configuration: anonymous callers get
  // 401 without learning whether Google is configured.
  const anon = await fetch(origin + "/api/auth/google/link/start", { redirect: "manual" });
  assert.equal(anon.status, 401);

  const accountId = "google-link-start-503";
  f.store.createAccount(accountId, "link-start-fixture");
  const magic = f.store.accountLogins.linkMagicMethod(accountId, { email: "googlelink503@example.invalid" });
  const creds = authCookie(f, accountId, { kind: "magic", ref: magic.id });
  const res = await fetch(origin + "/api/auth/google/link/start", {
    redirect: "manual", headers: { Cookie: creds.cookie } });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).reason, "google_not_configured");
});

test("Google callback links through the shared account-login model", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f, { googleAuth: googleAuth() });
  const { authorize, slotCookie } = await beginFlow(origin);
  const callback = await fetch(
    `${origin}${GOOGLE_CALLBACK_PATH}?state=${authorize.searchParams.get("state")}&code=code-shared`,
    { redirect: "manual", headers: { Cookie: `account_session=${slotCookie}` } });
  assert.equal(callback.status, 200);
  const session = f.store.authenticateAccountSession(accountCookie(callback));
  // The account is linked through the shared model: the OAuth subject
  // resolves to the signed-in account via findAccountByOAuth.
  assert.equal(f.store.accountLogins.findAccountByOAuth("google", sub), session.account.id);
  const methods = f.store.accountLogins.listMethods(session.account.id);
  assert.ok(methods.some(m => m.type === "oauth" && m.provider === "google" && !m.disabled),
    "expected a linked Google OAuth method");
});

test("Google link intent attaches the subject to the signed-in account", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f, { googleAuth: googleAuth() });
  const accountId = "google-link-target";
  f.store.createAccount(accountId, "link-fixture");
  const magic = f.store.accountLogins.linkMagicMethod(accountId, { email: "googlelink@example.invalid" });
  const creds = authCookie(f, accountId, { kind: "magic", ref: magic.id });
  // Start the link flow (authenticated).
  const start = await fetch(origin + "/api/auth/google/link/start", {
    redirect: "manual", headers: { Cookie: creds.cookie } });
  assert.equal(start.status, 302);
  const authorize = new URL(start.headers.get("location"));
  const callback = await fetch(
    `${origin}${GOOGLE_CALLBACK_PATH}?state=${authorize.searchParams.get("state")}&code=code-link`,
    { redirect: "manual", headers: { Cookie: creds.cookie } });
  assert.equal(callback.status, 200);
  assert.equal(f.store.accountLogins.findAccountByOAuth("google", sub), accountId);
  const methods = f.store.accountLogins.listMethods(accountId);
  assert.ok(methods.some(m => m.type === "oauth" && m.provider === "google" && !m.disabled),
    "expected Google linked to the signed-in account");
});

for (const stale of ["missing", "expired", "malformed"]) test(`Google start replaces a ${stale} session cookie`, async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f, { googleAuth: googleAuth() });
  const slot = f.store.createAccountSessionSlot();
  if (stale === "expired") f.store.db.prepare("UPDATE account_session_slots SET expires_at=0 WHERE hash=?").run(slot.session.credentialHash);
  const old = stale === "missing" ? "x".repeat(43) : stale === "malformed" ? "bad" : slot.token;
  const flow = await beginFlow(origin, `account_session=${old}`);
  assert.ok(flow.slotCookie);
  assert.notEqual(flow.slotCookie, old);
  const callback = await fetch(origin + GOOGLE_CALLBACK_PATH + "?state=" + flow.authorize.searchParams.get("state") + "&code=fixture", { redirect: "manual" });
  assert.equal(callback.headers.get("X-Room-Auth-Failure"), null);
  const token = accountCookie(callback);
  assert.ok(token);
  const session = await fetch(origin + "/api/account-session", { headers: { Cookie: `account_session=${token}` } });
  assert.equal((await session.json()).authenticated, true);
});
