// Slice 5 (RC-2026-09-17-014) HTTP tests: the four /api/auth/passkey/*
// routes in server/http.mjs.
//
// Two injection strategies, for two different questions:
//
// - A fully fake passkey service (injected through the createRoomServer
//   passkeyService option) proves the HTTP layer: auth/CSRF gating, the
//   exact arguments the routes pass down (rpId, expectedOrigin), the
//   anonymous-slot upgrade, and status codes.
// - createPasskeyAuth({ store: f.store, verifiers: stubs }) keeps WebAuthn
//   crypto stubbed but runs the real model: this proves register
//   options -> finish persists the credential through the real
//   account-login-methods store, and that authenticate finish resolves the
//   account and method id from it. Real WebAuthn assertion crypto stays
//   covered by src/passkey-login.mjs's own tests. A further test uses the
//   fully real service to prove the challenge store is shared across
//   requests on one server instance (options -> finish with a bogus
//   response answers 401, never 500).
//
// The https-or-localhost origin rule: the route-level 422
// (passkey_origin_rejected) is unreachable over HTTP by construction —
// createRoomServer throws for a non-loopback http origin at startup, and a
// spoofed Host header is rejected earlier by the global 403 host_denied
// guard (the request Host never feeds the expected origin). Both facts are
// asserted here; the 422 branch itself is covered by resolvePasskeyParams
// unit tests in tests/account-passkeys.test.js as defense-in-depth.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createPasskeyAuth, passkeyUserLabel, PASSKEY_FALLBACK_USER } from "../server/account-passkeys.mjs";

const jsonHeaders = { "Content-Type": "application/json" };

function fakePasskeyService() {
  const calls = [];
  const service = {
    calls,
    finishRegistrationResult: { ok: true, credentialId: "cred-http-1" },
    finishAuthenticationResult: null,
    beginRegistration: args => {
      calls.push(["beginRegistration", args]);
      return { challenge: "stub-challenge", rp: { id: args.rpId, name: args.rpId }, challengeId: "ch-reg-1" };
    },
    finishRegistration: args => {
      calls.push(["finishRegistration", args]);
      return service.finishRegistrationResult;
    },
    beginAuthentication: args => {
      calls.push(["beginAuthentication", args]);
      return { challenge: "stub-challenge", rpId: args.rpId, challengeId: "ch-auth-1" };
    },
    finishAuthentication: args => {
      calls.push(["finishAuthentication", args]);
      return service.finishAuthenticationResult ?? { ok: true, accountId: "passkey-user", methodRef: "lm_http" };
    }
  };
  return service;
}

async function startServer(t, f, options = {}, listen = ["127.0.0.1", 0]) {
  const server = createRoomServer({ store: f.store, ...options });
  await new Promise(resolve => server.listen(listen[1], listen[0], resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
    rmSync(f.directory, { recursive: true, force: true });
  });
  return `http://${listen[0]}:${server.address().port}`;
}

function signIn(f, accountId = "passkey-user") {
  f.store.createAccount(accountId);
  const key = f.store.issueAccountAccessKey(accountId);
  const slot = f.store.createAccountSessionSlot();
  const session = f.store.loginAccountSession(slot.token, key, 0);
  return { slot, session };
}

const authedHeaders = (origin, slot, session, extra = {}) => ({
  ...jsonHeaders,
  Cookie: `account_session=${slot.token}`,
  Origin: origin,
  "X-CSRF-Token": session.csrf,
  ...extra
});

const post = (origin, path, headers, body) => fetch(origin + path, {
  method: "POST", headers, body: JSON.stringify(body ?? {})
});

const errorCode = async res => (await res.json()).error.code;

// QAS-702: passkey login rotates the slot token — the fresh token arrives in
// the Set-Cookie header (the route previously relied on the in-place upgrade).
const freshSlotCookie = res => /account_session=([A-Za-z0-9_-]{43})/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? null;

test("register options requires an authenticated account session", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f, { passkeyService: fakePasskeyService() });
  let res = await post(origin, "/api/auth/passkey/register/options", { ...jsonHeaders, Origin: origin }, {});
  assert.equal(res.status, 401);
  const anon = f.store.createAccountSessionSlot();
  res = await post(origin, "/api/auth/passkey/register/options",
    { ...jsonHeaders, Cookie: `account_session=${anon.token}`, Origin: origin }, {});
  assert.equal(res.status, 401, "anonymous slot is not an authenticated session");
});

test("register options returns ceremony options for a signed-in account", async t => {
  const f = createAcceptanceFixture();
  const service = fakePasskeyService();
  const origin = await startServer(t, f, { passkeyService: service });
  const { slot, session } = signIn(f);
  const res = await post(origin, "/api/auth/passkey/register/options",
    authedHeaders(origin, slot, session), { userName: "Ada" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.challengeId, "ch-reg-1");
  assert.equal(body.rp.id, "127.0.0.1");
  assert.deepEqual(service.calls[0], ["beginRegistration", {
    accountId: "passkey-user", rpId: "127.0.0.1", rpName: "Project Room", userName: "Ada", authenticatorSelection: undefined
  }]);
});

test("register finish persists the credential and answers 201", async t => {
  const f = createAcceptanceFixture();
  const service = fakePasskeyService();
  const origin = await startServer(t, f, { passkeyService: service });
  const { slot, session } = signIn(f);
  const headers = authedHeaders(origin, slot, session);
  let res = await post(origin, "/api/auth/passkey/register/finish", headers, { challengeId: "ch-reg-1", response: { id: "cred-http-1" } });
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { ok: true, credentialId: "cred-http-1" });
  const [, args] = service.calls.find(([name]) => name === "finishRegistration");
  assert.equal(args.accountId, "passkey-user");
  assert.equal(args.challengeId, "ch-reg-1");
  assert.equal(args.expectedOrigin, origin);
  assert.equal(args.rpId, "127.0.0.1");
  res = await post(origin, "/api/auth/passkey/register/finish", headers, { challengeId: "ch-reg-1" });
  assert.equal(res.status, 422);
  assert.equal(await errorCode(res), "invalid_passkey_response");
});

test("register finish rejects unauthenticated callers", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f, { passkeyService: fakePasskeyService() });
  const res = await post(origin, "/api/auth/passkey/register/finish",
    { ...jsonHeaders, Origin: origin }, { challengeId: "ch-reg-1", response: {} });
  assert.equal(res.status, 401);
});

test("authenticate options is anonymous and returns a challenge", async t => {
  const f = createAcceptanceFixture();
  const service = fakePasskeyService();
  const origin = await startServer(t, f, { passkeyService: service });
  const res = await post(origin, "/api/auth/passkey/authenticate/options", { ...jsonHeaders, Origin: origin }, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.challengeId, "ch-auth-1");
  assert.equal(body.rpId, "127.0.0.1");
  assert.deepEqual(service.calls, [["beginAuthentication", { rpId: "127.0.0.1" }]]);
});

test("authenticate finish upgrades the slot with the passkey method", async t => {
  const f = createAcceptanceFixture();
  const service = fakePasskeyService();
  const origin = await startServer(t, f, { passkeyService: service });
  signIn(f); // the verified account exists
  const slot = f.store.createAccountSessionSlot(); // anonymous slot to upgrade
  const res = await post(origin, "/api/auth/passkey/authenticate/finish",
    { ...jsonHeaders, Origin: origin },
    { challengeId: "ch-auth-1", response: { id: "cred-http-1" }, sessionToken: slot.token, sessionRevision: 0 });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.authenticated, true);
  assert.equal(body.account.id, "passkey-user");
  const [, args] = service.calls.find(([name]) => name === "finishAuthentication");
  assert.equal(args.expectedOrigin, origin);
  assert.equal(args.rpId, "127.0.0.1");
  // The login minted a fresh slot token: the pre-login token is dead and the
  // fresh cookie token carries the session (QAS-702 session-fixation fix).
  const fresh = freshSlotCookie(res);
  assert.ok(fresh && fresh !== slot.token, "passkey login rotates the slot token");
  assert.throws(() => f.store.authenticateAccountSession(slot.token), { code: "unauthenticated" });
  assert.equal(f.store.authenticateAccountSession(fresh).account.id, "passkey-user");
});

test("authenticate finish rejects stale revisions and malformed bodies", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f, { passkeyService: fakePasskeyService() });
  signIn(f); // the verified account must exist for the slot upgrade
  const slot = f.store.createAccountSessionSlot();
  const headers = { ...jsonHeaders, Origin: origin };
  let res = await post(origin, "/api/auth/passkey/authenticate/finish", headers,
    { challengeId: "ch-auth-1", response: {}, sessionToken: slot.token, sessionRevision: 0 });
  assert.equal(res.status, 200); // stub verifies; slot upgrades and the token rotates
  const fresh = freshSlotCookie(res);
  assert.ok(fresh && fresh !== slot.token, "login rotated the slot token");
  // The pre-login token is dead: presenting it again is 401, not a revision fight.
  res = await post(origin, "/api/auth/passkey/authenticate/finish", headers,
    { challengeId: "ch-auth-1", response: {}, sessionToken: slot.token, sessionRevision: 0 });
  assert.equal(res.status, 401);
  // The rotated token with a stale revision is still a 409.
  res = await post(origin, "/api/auth/passkey/authenticate/finish", headers,
    { challengeId: "ch-auth-1", response: {}, sessionToken: fresh, sessionRevision: 0 });
  assert.equal(res.status, 409, "revision moved on after the first upgrade");
  res = await post(origin, "/api/auth/passkey/authenticate/finish", headers,
    { challengeId: "ch-auth-1", response: {} });
  assert.equal(res.status, 422);
});

test("real service: unknown challenges and bogus responses answer 401, never 500", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f); // no injection: the real challenge store + verifiers
  const { slot, session } = signIn(f);
  const headers = authedHeaders(origin, slot, session);
  let res = await post(origin, "/api/auth/passkey/register/finish", headers, { challengeId: "nope", response: {} });
  assert.equal(res.status, 401);
  assert.equal(await errorCode(res), "invalid_passkey_challenge");
  // A real challenge is issued, then consumed by a bogus response: 401, single-use.
  const options = await (await post(origin, "/api/auth/passkey/register/options", headers, {})).json();
  res = await post(origin, "/api/auth/passkey/register/finish", headers,
    { challengeId: options.challengeId, response: { bogus: true } });
  assert.equal(res.status, 401);
  assert.equal(await errorCode(res), "passkey_verification_failed");
  res = await post(origin, "/api/auth/passkey/register/finish", headers,
    { challengeId: options.challengeId, response: { bogus: true } });
  assert.equal(res.status, 401, "challenge was consumed by the first attempt");
  res = await post(origin, "/api/auth/passkey/authenticate/finish",
    { ...jsonHeaders, Origin: origin },
    { challengeId: "nope", response: {}, sessionToken: "x".repeat(43), sessionRevision: 0 });
  assert.equal(res.status, 401);
});

test("https origins are accepted end to end", async t => {
  const f = createAcceptanceFixture();
  const service = fakePasskeyService();
  // Grab a free port first so the configured https origin matches the listener.
  const { createServer } = await import("node:http");
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const origin = `https://127.0.0.1:${port}`;
  const server = createRoomServer({ store: f.store, origin, passkeyService: service });
  await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
    rmSync(f.directory, { recursive: true, force: true });
  });
  const res = await post(`http://127.0.0.1:${port}`, "/api/auth/passkey/authenticate/options",
    { ...jsonHeaders, Origin: origin }, {});
  assert.equal(res.status, 200);
  assert.equal((await res.json()).rpId, "127.0.0.1");
});

// createPasskeyAuth({ store: f.store, verifiers: stubs }): WebAuthn crypto
// stays stubbed, but registration and authentication run against the real
// model — this proves register options -> finish persists the credential
// and authenticate finish resolves the account + method id from it.
test("register and authenticate round-trip through the real model (stubbed crypto)", async t => {
  const f = createAcceptanceFixture();
  const verifiers = {
    createRegistrationOptions: ({ rpId, user, challenge, excludeCredentials }) => ({
      options: { challenge, rp: { id: rpId, name: rpId }, user, excludeCredentials }, challenge
    }),
    verifyRegistrationResponse: ({ expected }) => {
      assert.equal(expected.origin, origin, "the route passes the server origin down as expectedOrigin");
      assert.equal(expected.rpId, "127.0.0.1");
      return { id: "cred-real-1", rpId: expected.rpId, publicKeyCose: "cose-pk",
        publicKeyJwk: { kty: "EC" }, signCount: 0 };
    },
    createAuthenticationOptions: ({ rpId, challenge, allowCredentials }) => ({
      options: { challenge, rpId, allowCredentials }, challenge
    }),
    verifyAuthenticationAssertion: ({ assertion, store }) => {
      const record = store.getCredential("cred-real-1");
      assert.ok(record, "the credential resolves from the real model");
      store.updateSignCount("cred-real-1", 1);
      return { credentialId: "cred-real-1", userHandle: null, signCount: 1, accountId: record.accountId };
    }
  };
  const origin = await startServer(t, f, { passkeyService: createPasskeyAuth({ store: f.store, verifiers }) });
  const { slot, session } = signIn(f);
  const headers = authedHeaders(origin, slot, session);

  // register options -> finish, persisted through the real model
  const options = await (await post(origin, "/api/auth/passkey/register/options", headers, { userName: "Ada" })).json();
  assert.ok(options.challengeId);
  const finish = await post(origin, "/api/auth/passkey/register/finish", headers,
    { challengeId: options.challengeId, response: { id: "cred-real-1" } });
  assert.equal(finish.status, 201);
  assert.equal((await finish.json()).credentialId, "cred-real-1");
  const stored = f.store.accountLogins.listPasskeyCredentials("passkey-user");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].credentialId, "cred-real-1");

  // authenticate options -> finish upgrades an anonymous slot off the stored credential
  const authOptions = await (await post(origin, "/api/auth/passkey/authenticate/options",
    { ...jsonHeaders, Origin: origin }, {})).json();
  assert.ok(authOptions.challengeId);
  const upgrade = f.store.createAccountSessionSlot();
  const res = await post(origin, "/api/auth/passkey/authenticate/finish",
    { ...jsonHeaders, Origin: origin },
    { challengeId: authOptions.challengeId, response: { id: "cred-real-1" },
      sessionToken: upgrade.token, sessionRevision: 0 });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).account.id, "passkey-user");
  const fresh = freshSlotCookie(res);
  assert.ok(fresh && fresh !== upgrade.token, "passkey login rotates the slot token");
  assert.throws(() => f.store.authenticateAccountSession(upgrade.token), { code: "unauthenticated" });
  assert.equal(f.store.authenticateAccountSession(fresh).account.id, "passkey-user");
  assert.equal(f.store.accountLogins.listPasskeyCredentials("passkey-user")[0].signCount, 1,
    "sign count advanced in the real model");
});

// The https-or-localhost rule at the HTTP boundary: a non-loopback http
// origin never gets a listening server, so the route-level 422 is
// defense-in-depth only (covered by resolvePasskeyParams unit tests).
test("an insecure non-loopback origin is rejected when the server is created", t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  assert.throws(() => createRoomServer({ store: f.store, origin: "http://example.com" }),
    /Non-loopback origins require HTTPS/);
});

// ... and the request Host can never smuggle one in: the global
// host_denied guard fires before any passkey route runs.
test("a spoofed Host header is rejected before the passkey routes (403 host_denied)", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f, { passkeyService: fakePasskeyService() });
  const { status, body } = await new Promise((resolve, reject) => {
    const req = httpRequest(origin + "/api/auth/passkey/authenticate/options", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, Host: "evil.example" }
    }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(JSON.stringify({}));
  });
  assert.equal(status, 403);
  assert.equal(JSON.parse(body).error.code, "host_denied");
});

// P3: an empty options request used to name the passkey after the account id
// ("email:<64 hex>"), so every picker entry looked the same and unreadable.
test("register options with no userName names the passkey after the account's email, not its id", async t => {
  const f = createAcceptanceFixture();
  const service = fakePasskeyService();
  const origin = await startServer(t, f, { passkeyService: service });
  const { slot, session } = signIn(f);
  f.store.accountLogins.linkMagicMethod("passkey-user", { email: "ada@example.test" });
  const res = await post(origin, "/api/auth/passkey/register/options", authedHeaders(origin, slot, session), {});
  assert.equal(res.status, 200);
  const [, args] = service.calls[0];
  assert.equal(args.userName, "ada@example.test");
  assert.equal(args.rpName, "Project Room", "the relying-party name is the product, not the host");
});

test("passkeyUserLabel prefers a verified email, then any email, then the display name, never the account id", () => {
  const f = createAcceptanceFixture();
  const id = `email:${"0123456789abcdef".repeat(4)}`;
  f.store.createAccount(id, "magic-link");
  assert.equal(passkeyUserLabel(f.store, id), PASSKEY_FALLBACK_USER, "no email, no name: a plain label, not the hash id");
  f.store.updateAccountProfile(id, { displayName: "Ada L" });
  assert.equal(passkeyUserLabel(f.store, id), "Ada L");
  f.store.accountLogins.linkMagicMethod(id, { email: "first@example.test" });
  assert.equal(passkeyUserLabel(f.store, id), "first@example.test");
  for (const account of [id]) assert.ok(!passkeyUserLabel(f.store, account).startsWith("email:"));
  assert.equal(passkeyUserLabel(f.store, "missing-account"), PASSKEY_FALLBACK_USER, "an unknown account falls back instead of throwing");
});
