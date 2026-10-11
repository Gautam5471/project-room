// Auth group (batch RT-1). Moved verbatim from server/http.mjs:
// magic link, password reset, password signup/login/change, and passkey.
// Email verification, password set, recovery codes, and OAuth stay on the
// legacy chain. Handler bodies keep their checks; the dispatcher only
// adds 405 Allow for a wrong method on one of these paths.

import { createHash } from "node:crypto";
import { ServiceError } from "../service-error.mjs";
import { magicLinkUnavailable, validateMagicReturnTo, attemptMailDelivery } from "../magic-links.mjs";
import { normalizeEmail } from "../account-login-methods.mjs";
import { resolvePasskeyParams, passkeyUserLabel, PASSKEY_RP_NAME } from "../account-passkeys.mjs";
import { hashPassword, verifyPassword, checkPasswordPolicy, DUMMY_PASSWORD_VERIFIER } from "../../src/password-auth.mjs";

const objectResponse = Object.freeze({ type: "object" });

const emailRequestBody = Object.freeze({
  type: "object",
  required: ["email"],
  additionalProperties: false,
  properties: {
    email: { type: "string" },
    returnTo: { type: "string" },
  },
});

const slotFields = Object.freeze({
  sessionToken: { type: "string" },
  sessionRevision: { type: "integer" },
});

function authRoute(row) {
  return {
    capability: null,
    events: [],
    scope: "worker",
    handler: handleAuthGroup,
    ...row,
    schema: { response: objectResponse, ...row.schema },
  };
}

// Accounts provisioned from an email (password signup, magic link) use
// email:<sha256>. Deleting an account leaves a deactivated tombstone under that
// id so retained audit rows stay attributable; a later signup for the same email
// takes the next free suffix (email:<sha256>.2, …) instead of colliding with it.
// A live account at an id is returned as is, so callers keep their
// existing-account handling.
const MAX_EMAIL_ACCOUNT_GENERATIONS = 20;
export function emailAccountIdFor(store, normalized) {
  const base = `email:${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
  for (let generation = 1; generation <= MAX_EMAIL_ACCOUNT_GENERATIONS; generation++) {
    const id = generation === 1 ? base : `${base}.${generation}`;
    const row = store.db.prepare("SELECT active FROM accounts WHERE id=?").get(id);
    if (!row || row.active === 1) return id;
  }
  throw new ServiceError(409, "account_exists", "This email can't start a new account; contact support");
}

export async function handleAuthGroup(ctx) {
  const {
    req, res, url, store, remoteAddress,
    json, reject, rate, cookie, setCookie, body,
    checkOrigin, protectWrite, exact, expectedOrigin,
    accountCookieName, roomCookieName, tokenPattern, accountView,
    signInSlotToken, magicMailer, magicEmailLimit, passkeys,
    magicRequestEmailLimiter, magicConsumeEmailLimiter,
    resetRequestEmailLimiter, resetConsumeEmailLimiter, signupEmailLimiter,
  } = ctx;
  const finishPasswordSlot = (slotToken, accountId, expectedRevision, methodRef) => {
    // QAS-702 (RC-2026-09-19-069): every password login mints a fresh
    // slot token and invalidates the pre-login one.
    const { token: freshSlotToken, session: loggedIn } = store.loginAccountSessionWithMethod(slotToken, accountId, expectedRevision, {
      method: { kind: "password", ref: methodRef },
      rotateSlot: true
    });
    setCookie(res, accountCookieName, freshSlotToken, Math.max(0, Math.floor((loggedIn.expiresAt - store.now()) / 1000)));
    return loggedIn;
  };
  const signupReply = () => ({ status: "check_email", mailConfigured: magicMailer.isConfigured() });
  // Delivery does not change the signup response, but a failure is logged
  // (redacted) so operators can see why mail is not arriving.
  const deliverSignupMail = fn => attemptMailDelivery(fn, "signup");
  const passkeyUnavailable = () => json(res, 503, { status: "unavailable", reason: "passkey_not_configured" });

  // ---- Magic link auth (slice 3, RC-2026-09-17-012) ----
  //
  // Passwordless email sign-in. POST /api/auth/magic/request issues a
  // single-use code and hands it to the mailer seam; POST
  // /api/auth/magic/consume redeems it with { email, code, sessionToken,
  // sessionRevision }, provisions/links the account, and upgrades the
  // named account-session slot (same login call as the /api/account-session
  // POST, with method { kind: "magic" }). The slot is verified before any
  // code is burned so a CSRF failure cannot consume a one-time code.
  // QAS-702: the login mints a FRESH slot token and invalidates the
  // pre-login one, so a planted token never authenticates after sign-in.
  // QAX-007: a slot already signed in to a different account refuses the
  // consume (409 magic_account_mismatch) before the code burns.
  //
  // Codes are never returned in API responses — only through the
  // mailer. When no mail provider is configured the request route says
  // so honestly (mail_not_configured) and issues nothing. Both routes
  // ride the browser's account slot + CSRF like every other cookie
  // session write; the response shape never reveals whether the email
  // already has an account.
  if (url.pathname === "/api/auth/magic/request" || url.pathname === "/api/auth/magic/consume") {
    if (req.method !== "POST") reject(405, "method_not_allowed", "Method not allowed");
    checkOrigin(req, true);
    const slotToken = cookie(req, accountCookieName);
    if (!slotToken) reject(401, "account_session_required", "Start an account browser session before signing in");
    const slot = store.accountSessionSlot(slotToken);
    protectWrite(req, slot, false);
    if (url.pathname === "/api/auth/magic/request") {
      const data = await body(req);
      if (!(exact(data, ["email"]) || exact(data, ["email", "returnTo"])) || typeof data.email !== "string") reject(422, "invalid_email_request", "An email address is required");
      if (Object.hasOwn(data, "returnTo") && validateMagicReturnTo(data.returnTo) === null) reject(422, "invalid_return_target", "A valid local return target is required");
      const normalized = normalizeEmail(data.email);
      if (!normalized) reject(422, "invalid_email", "A valid email address is required");
      rate(`magic-request:${remoteAddress}`, 5);
      magicEmailLimit(magicRequestEmailLimiter, normalized);
      if (!magicMailer.isConfigured()) return json(res, 200, magicLinkUnavailable());
      const issued = store.accountLogins.issueMagicCode({ email: normalized });
      await magicMailer.sendMagicLink({ to: normalized, code: issued.code, expiresAt: issued.expiresAt, ...(Object.hasOwn(data, "returnTo") ? { returnTo: data.returnTo } : {}) });
      return json(res, 200, { status: "sent" });
    }
    const data = await body(req);
    const consumeToken = signInSlotToken(req, data, ["email", "code", "sessionRevision"],
      { code: "invalid_magic_login", message: "Email, code, session token, and current session revision are required", csrf: "always" });
    if (typeof data.email !== "string" || typeof data.code !== "string" || !Number.isSafeInteger(data.sessionRevision)) {
      reject(422, "invalid_magic_login", "Email, code, session token, and current session revision are required");
    }
    const normalized = normalizeEmail(data.email);
    if (!normalized) reject(422, "invalid_email", "A valid email address is required");
    rate(`magic-consume:${remoteAddress}`, 10);
    magicEmailLimit(magicConsumeEmailLimiter, normalized);
    // QAX-007 (RC-2026-09-19-074): never silently switch accounts. A slot
    // already authenticated to a DIFFERENT account refuses the consume
    // BEFORE any code burns, so a foreign link stays live for its real
    // owner. Same-account re-auth (the link's email belongs to the
    // signed-in account) is unaffected.
    const alreadySignedIn = (() => {
      try { return store.authenticateAccountSession(consumeToken); }
      catch (error) { if (error?.status === 401) return null; throw error; }
    })();
    if (alreadySignedIn?.account) {
      const targetAccountId = store.accountLogins.findAccountHoldingEmail(normalized);
      if (targetAccountId !== alreadySignedIn.account.id) {
        reject(409, "magic_account_mismatch",
          "This browser is already signed in to a different account; sign out before using a magic link for another email");
      }
    }
    // The slot is verified before any code is burned so a CSRF failure
    // cannot consume a one-time code.
    // The model burns the code window on failure (401 invalid_magic_code)
    // after 5 wrong attempts / 15-minute expiry / single use.
    store.accountLogins.consumeMagicCode({ email: normalized, code: data.code });
    const oldRoomToken = cookie(req, roomCookieName);
    // A consumed code proves the email. Attach to the verified owner, or
    // to an unverified password account for that address (that password
    // is removed). Otherwise provision email:<sha256>. Login shares this
    // transaction so a failed sign-in does not remove the password.
    const { token: freshSlotToken, session: loggedIn } = store.transaction(() => {
      const adopted = store.accountLogins.adoptVerifiedEmail(normalized, { preserveSlotToken: consumeToken });
      let accountId = adopted?.accountId ?? null;
      if (!accountId) {
        const derived = emailAccountIdFor(store, normalized);
        try { store.createAccount(derived, "magic-link"); }
        catch (error) { if (!(error instanceof ServiceError) || error.status !== 409) throw error; }
        accountId = derived;
      }
      let method = store.accountLogins.listMethods(accountId).find(row => row.type === "magic" && row.email === normalized);
      if (!method) method = store.accountLogins.linkMagicMethod(accountId, { email: normalized });
      store.accountLogins.touchMethod(accountId, method.id);
      return store.loginAccountSessionWithMethod(consumeToken, accountId, data.sessionRevision, {
        method: { kind: "magic", ref: method.id },
        revokeRoomToken: oldRoomToken && tokenPattern.test(oldRoomToken) ? oldRoomToken : null,
        rotateSlot: true
      });
    });
    setCookie(res, accountCookieName, freshSlotToken, Math.max(0, Math.floor((loggedIn.expiresAt - store.now()) / 1000)));
    return json(res, 201, accountView(loggedIn));
  }
  if (url.pathname === "/api/auth/password/reset/request" || url.pathname === "/api/auth/password/reset/consume") {
    if (req.method !== "POST") reject(405, "method_not_allowed", "Method not allowed");
    checkOrigin(req, true);
    const slotToken = cookie(req, accountCookieName);
    if (!slotToken) reject(401, "account_session_required", "Start a browser session before resetting a password");
    const slot = store.accountSessionSlot(slotToken);
    protectWrite(req, slot, false);
    const data = await body(req);
    const requesting = url.pathname.endsWith("/request");
    if (requesting) {
      if (!(exact(data, ["email"]) || exact(data, ["email", "returnTo"])) || typeof data.email !== "string") reject(422, "invalid_email_request", "An email address is required");
      if (Object.hasOwn(data, "returnTo") && validateMagicReturnTo(data.returnTo) === null) reject(422, "invalid_return_target", "A valid local return target is required");
    } else if (!exact(data, ["email", "code", "newPassword", "sessionRevision"]) || typeof data.email !== "string"
      || typeof data.code !== "string" || typeof data.newPassword !== "string") reject(422, "invalid_password_reset", "Reset proof, new password and current session revision are required");
    const normalized = normalizeEmail(data.email);
    if (!normalized) reject(422, "invalid_email", "A valid email address is required");
    rate(`password-reset-${requesting ? "request" : "consume"}:${remoteAddress}`, requesting ? 5 : 10);
    magicEmailLimit(requesting ? resetRequestEmailLimiter : resetConsumeEmailLimiter, normalized);
    if (requesting) {
      if (!magicMailer.isConfigured()) return json(res, 200, magicLinkUnavailable());
      const issued = store.accountLogins.issuePasswordResetCode({ email: normalized });
      await magicMailer.sendMagicLink({ to: normalized, code: issued.code, expiresAt: issued.expiresAt, purpose: "password-reset",
        ...(Object.hasOwn(data, "returnTo") ? { returnTo: data.returnTo } : {}) });
      return json(res, 200, { status: "sent" });
    }
    const verifyResetSlot = () => {
      const currentSlot = store.accountSessionSlot(slotToken);
      protectWrite(req, currentSlot, false);
      if (!Number.isSafeInteger(data.sessionRevision) || data.sessionRevision !== currentSlot.sessionRevision) reject(409, "stale_session_revision", "The browser session changed; refresh before resetting");
      let authenticated = null;
      try { authenticated = store.authenticateAccountSession(slotToken); }
      catch (error) { if (error.status !== 401) throw error; }
      const target = store.accountLogins.passwordResetAccount(normalized);
      if (authenticated && authenticated.account.id !== target?.accountId) reject(409, "reset_account_mismatch", "This reset is for another account. Sign out before continuing.");
    };
    // The body may have been held while another tab changed this slot.
    verifyResetSlot();
    const policy = checkPasswordPolicy(data.newPassword);
    if (policy) reject(422, policy.code, policy.message);
    const verifier = hashPassword(data.newPassword);
    const resetFailure = store.transaction(() => {
      // Recheck inside the writer fence so another process cannot change
      // the browser slot between authorization and proof consumption.
      verifyResetSlot();
      try { store.accountLogins.resetPassword({ email: normalized, code: data.code, verifier }); }
      catch (error) {
        // Invalid proof attempts deliberately persist their bounded counter.
        if (error instanceof ServiceError && error.code === "invalid_password_reset") return error;
        throw error;
      }
      return null;
    });
    if (resetFailure) throw resetFailure;
    // Notification failure cannot undo a committed password change or
    // turn a used proof into a second mutation. Never include secrets.
    try { await magicMailer.sendPasswordResetNotice?.({ to: normalized }); } catch { /* Password is already reset. */ }
    return json(res, 200, { status: "password_reset", signInRequired: true });
  }
  // ---- Password auth (slice 2, RC-2026-09-17-011) ----
  // Email+password login. Signup provisions an `email:<sha256>` account,
  // links the password method, and upgrades the browser's account session
  // slot; login verifies against the stored scrypt verifier, or a dummy
  // verifier when the email is unknown, so a wrong password and an unknown
  // email answer identically; change rotates the verifier on an
  // authenticated session. Plaintext passwords never reach the store.
  // ---- ID-SEC auth: verified email and uniform signup ----
  if (url.pathname === "/api/auth/password/signup") {
    if (req.method !== "POST") reject(405, "method_not_allowed", "Method not allowed");
    checkOrigin(req, true);
    rate(`password-signup:${remoteAddress}`, 10);
    const data = await body(req);
    // An optional returnTo (same strict validation as magic sign-in) rides
    // the signup mail, so an invitee who signs up from a #join/ or #invite/
    // link lands back on that invitation from the email, not on a bare root.
    const signupReturn = Object.hasOwn(data, "returnTo");
    const signupToken = signInSlotToken(req, data, ["email", "password", "sessionRevision", ...(signupReturn ? ["returnTo"] : [])],
      { code: "invalid_signup", message: "An email, password, and current session are required" });
    if (typeof data.email !== "string" || typeof data.password !== "string") {
      reject(422, "invalid_signup", "An email, password, and current session are required");
    }
    if (signupReturn && validateMagicReturnTo(data.returnTo) === null) reject(422, "invalid_return_target", "A valid local return target is required");
    const signupLink = signupReturn ? { returnTo: data.returnTo } : {};
    const normalized = normalizeEmail(data.email);
    if (!normalized) reject(422, "invalid_email", "A valid email address is required");
    const policy = checkPasswordPolicy(data.password);
    if (policy) reject(422, policy.code, policy.message);
    magicEmailLimit(signupEmailLimiter, normalized);
    const verifier = hashPassword(data.password);
    const mailConfigured = magicMailer.isConfigured();
    const holding = store.accountLogins.findAccountHoldingEmail(normalized);
    if (holding) {
      if (mailConfigured) await deliverSignupMail(() => magicMailer.sendMagicLink({ to: normalized, purpose: "signup-notice", ...signupLink }));
      return json(res, 202, signupReply());
    }
    const accountId = emailAccountIdFor(store, normalized);
    try { store.createAccount(accountId, "password-signup"); }
    catch (error) {
      if (!(error instanceof ServiceError) || error.status !== 409) throw error;
      if (mailConfigured) await deliverSignupMail(() => magicMailer.sendMagicLink({ to: normalized, purpose: "signup-notice", ...signupLink }));
      return json(res, 202, signupReply());
    }
    const method = store.accountLogins.linkPasswordMethod(accountId, { email: normalized, verifier });
    store.accountLogins.touchMethod(accountId, method.id);
    if (mailConfigured) {
      const issued = store.accountLogins.issueEmailVerifyCode({ accountId, email: normalized });
      await deliverSignupMail(() => magicMailer.sendMagicLink({
        to: normalized, code: issued.code, expiresAt: issued.expiresAt, purpose: "email-verify", ...signupLink
      }));
    }
    finishPasswordSlot(signupToken, accountId, data.sessionRevision, method.id);
    return json(res, 202, signupReply());
  }
  if (url.pathname === "/api/auth/password/login") {
    if (req.method !== "POST") reject(405, "method_not_allowed", "Method not allowed");
    checkOrigin(req, true);
    rate(`password-login-ip:${remoteAddress}`, 60);
    const data = await body(req);
    const loginToken = signInSlotToken(req, data, ["email", "password", "sessionRevision"],
      { code: "invalid_login", message: "An email, password, and current session are required" });
    if (typeof data.email !== "string" || typeof data.password !== "string") {
      reject(422, "invalid_login", "An email, password, and current session are required");
    }
    const normalized = normalizeEmail(data.email);
    if (!normalized) reject(422, "invalid_email", "A valid email address is required");
    rate(`password-login:${normalized}`, 10);
    const accountId = store.accountLogins.findPasswordAccount(normalized);
    const verifier = accountId ? store.accountLogins.readPasswordVerifier(accountId) : null;
    // Unknown emails and verifier-less accounts verify against the dummy
    // so the response never reveals whether the email is registered.
    if (!verifyPassword(data.password, verifier ?? DUMMY_PASSWORD_VERIFIER)) {
      reject(401, "invalid_credentials", "Invalid email or password");
    }
    const passwordMethod = store.accountLogins.listMethods(accountId).find(m => m.type === "password");
    store.accountLogins.touchMethod(accountId, passwordMethod.id);
    const loggedIn = finishPasswordSlot(loginToken, accountId, data.sessionRevision, passwordMethod.id);
    return json(res, 200, accountView(loggedIn));
  }
  if (url.pathname === "/api/auth/password/change") {
    if (req.method !== "POST") reject(405, "method_not_allowed", "Method not allowed");
    checkOrigin(req, true);
    rate(`password-change:${remoteAddress}`, 20);
    const slotToken = cookie(req, accountCookieName);
    if (!slotToken) reject(401, "account_session_required", "Sign in before changing the password");
    let session;
    try {
      session = store.authenticateAccountSession(slotToken);
    } catch (error) {
      if (error.status !== 401) throw error;
      reject(401, "invalid_session", "That session is no longer valid; sign in again");
    }
    if (!session.account) reject(401, "account_session_required", "Sign in before changing the password");
    const data = await body(req);
    if (!exact(data, ["currentPassword", "newPassword"])
      || typeof data.currentPassword !== "string" || typeof data.newPassword !== "string") {
      reject(422, "invalid_password_change", "The current and new passwords are required");
    }
    const verifyChangeSession = () => store.authenticateAccountSession(slotToken, null, session.sessionBinding);
    verifyChangeSession();
    const verifier = store.accountLogins.readPasswordVerifier(session.account.id);
    if (!verifyPassword(data.currentPassword, verifier ?? DUMMY_PASSWORD_VERIFIER)) {
      reject(401, "invalid_credentials", "The current password is incorrect");
    }
    const policy = checkPasswordPolicy(data.newPassword);
    if (policy) reject(422, policy.code, policy.message);
    const replacementVerifier = hashPassword(data.newPassword);
    store.transaction(() => {
      verifyChangeSession();
      if (store.accountLogins.readPasswordVerifier(session.account.id) !== verifier) {
        reject(409, "password_changed", "The password changed; retry with the current password");
      }
      store.accountLogins.setPasswordVerifier(session.account.id, replacementVerifier);
    });
    return json(res, 200, { status: "ok" });
  }
  // ---- Passkey auth (slice 5, RC-2026-09-17-014) ----
  if (url.pathname === "/api/auth/passkey/register/options" && req.method === "POST") {
    checkOrigin(req, true);
    const slotToken = cookie(req, accountCookieName);
    if (!slotToken) reject(401, "account_session_required", "Sign in before registering a passkey");
    const auth = store.authenticateAccountSession(slotToken); // 401 unless the slot is authenticated
    protectWrite(req, auth, false);
    rate(`passkey-register-options:${auth.account.id}`, 10);
    const params = resolvePasskeyParams(expectedOrigin());
    if (!params) return passkeyUnavailable();
    const data = await body(req);
    if (data.userName !== undefined && typeof data.userName !== "string") {
      reject(422, "invalid_passkey_request", "userName must be a string");
    }
    if (data.authenticatorSelection !== undefined
      && (data.authenticatorSelection === null || typeof data.authenticatorSelection !== "object")) {
      reject(422, "invalid_passkey_request", "authenticatorSelection must be an object");
    }
    return json(res, 200, passkeys().beginRegistration({ accountId: auth.account.id, rpId: params.rpId,
      rpName: PASSKEY_RP_NAME, userName: data.userName ?? passkeyUserLabel(store, auth.account.id), authenticatorSelection: data.authenticatorSelection }));
  }
  if (url.pathname === "/api/auth/passkey/register/finish" && req.method === "POST") {
    checkOrigin(req, true);
    const slotToken = cookie(req, accountCookieName);
    if (!slotToken) reject(401, "account_session_required", "Sign in before registering a passkey");
    const auth = store.authenticateAccountSession(slotToken);
    protectWrite(req, auth, false);
    rate(`passkey-register-finish:${auth.account.id}`, 10);
    const params = resolvePasskeyParams(expectedOrigin());
    if (!params) return passkeyUnavailable();
    const data = await body(req);
    if (!exact(data, ["challengeId", "response"]) || typeof data.challengeId !== "string"
      || data.response === null || typeof data.response !== "object") {
      reject(422, "invalid_passkey_response", "A challenge id and credential response are required");
    }
    return json(res, 201, passkeys().finishRegistration({ accountId: auth.account.id, challengeId: data.challengeId,
      response: data.response, expectedOrigin: params.origin, rpId: params.rpId }));
  }
  if (url.pathname === "/api/auth/passkey/authenticate/options" && req.method === "POST") {
    checkOrigin(req, true);
    rate(`passkey-auth-options:${remoteAddress}`, 20);
    const params = resolvePasskeyParams(expectedOrigin());
    if (!params) return passkeyUnavailable();
    await body(req); // discoverable-credential flow: the JSON body carries no required fields
    return json(res, 200, passkeys().beginAuthentication({ rpId: params.rpId }));
  }
  if (url.pathname === "/api/auth/passkey/authenticate/finish" && req.method === "POST") {
    checkOrigin(req, true);
    rate(`passkey-auth-finish:${remoteAddress}`, 10);
    const params = resolvePasskeyParams(expectedOrigin());
    if (!params) return passkeyUnavailable();
    const data = await body(req);
    const passkeyToken = signInSlotToken(req, data, ["challengeId", "response", "sessionRevision"],
      { code: "invalid_passkey_response", message: "A challenge id, credential response, and session are required" });
    if (typeof data.challengeId !== "string" || data.response === null || typeof data.response !== "object"
      || !Number.isSafeInteger(data.sessionRevision)) {
      reject(422, "invalid_passkey_response", "A challenge id, credential response, and session are required");
    }
    const verified = passkeys().finishAuthentication({ challengeId: data.challengeId, response: data.response,
      expectedOrigin: params.origin, rpId: params.rpId });
    const oldRoomToken = cookie(req, roomCookieName);
    // QAS-702 (RC-2026-09-19-069): mint a fresh slot token on login and
    // invalidate the pre-login one — the new token is set as the cookie
    // here (this route previously relied on the in-place slot upgrade).
    const { token: freshSlotToken, session: loggedIn } = store.loginAccountSessionWithMethod(passkeyToken, verified.accountId, data.sessionRevision, {
      method: { kind: "passkey", ref: verified.methodRef },
      revokeRoomToken: oldRoomToken && tokenPattern.test(oldRoomToken) ? oldRoomToken : null,
      rotateSlot: true
    });
    setCookie(res, accountCookieName, freshSlotToken, Math.max(0, Math.floor((loggedIn.expiresAt - store.now()) / 1000)));
    return json(res, 200, accountView(loggedIn));
  }
  reject(404, "not_found", "Not found");
}

// Guest upgrade (auth audit 2026-10-09, path 13).
//
// A guest who joins from a share link gets a real account (guest-<uuid>)
// whose sign-in lasts 8 hours, with no email. Account settings offered "Set a
// password", which needs an email, and no way to add one, so a guest could
// neither keep the account nor delete it.
//
// Two steps, both on the guest's own signed-in session:
//   POST /api/auth/guest/upgrade          { email }
//   POST /api/auth/guest/upgrade/confirm  { email, code, password }
// The first always answers the same 202. A free address gets a 6-digit code;
// an address another account holds gets the existing-account notice instead.
// The second links the email (verified) and the password to the SAME account,
// so its id, rooms, and messages stay. Nothing is linked until the code
// proves the inbox, and a held address simply has no code, so neither step
// reveals whether someone else uses an email.


function guestSession(ctx) {
  const { req, store, reject, cookie, checkOrigin, protectWrite, accountCookieName } = ctx;
  checkOrigin(req, true);
  const slotToken = cookie(req, accountCookieName);
  if (!slotToken) reject(401, "account_session_required", "Sign in to keep this account");
  let session;
  try { session = store.authenticateAccountSession(slotToken); }
  catch (error) {
    if (error.status !== 401) throw error;
    reject(401, "invalid_session", "That session is no longer valid; sign in again");
  }
  if (!session.account) reject(401, "account_session_required", "Sign in to keep this account");
  protectWrite(req, session, false);
  const methods = store.accountLogins.listMethods(session.account.id);
  if (methods.some(method => method.email || method.type === "password")) {
    reject(409, "login_method_exists", "This account already has an email or password; manage it in Account settings");
  }
  return session;
}

const emailFrom = (ctx, data) => {
  const normalized = typeof data.email === "string" ? normalizeEmail(data.email) : null;
  if (!normalized) ctx.reject(422, "invalid_email", "A valid email address is required");
  return normalized;
};

async function postGuestUpgrade(ctx) {
  const { res, store, remoteAddress, json, reject, rate, body, exact, magicMailer, magicEmailLimit, signupEmailLimiter } = ctx;
  rate(`guest-upgrade:${remoteAddress}`, 20);
  const session = guestSession(ctx);
  const data = await body(ctx.req);
  if (!exact(data, ["email"])) reject(422, "invalid_email", "A valid email address is required");
  const email = emailFrom(ctx, data);
  rate(`guest-upgrade-account:${session.account.id}`, 5);
  magicEmailLimit(signupEmailLimiter, email);
  const mailConfigured = magicMailer.isConfigured();
  if (mailConfigured) {
    const send = fn => attemptMailDelivery(fn, "guest-upgrade");
    if (store.accountLogins.findAccountHoldingEmail(email)) {
      await send(() => magicMailer.sendMagicLink({ to: email, purpose: "signup-notice" }));
    } else {
      const issued = store.accountLogins.issueEmailVerifyCode({ accountId: session.account.id, email });
      await send(() => magicMailer.sendMagicLink({ to: email, code: issued.code, expiresAt: issued.expiresAt, purpose: "email-verify" }));
    }
  }
  return json(res, 202, { status: "check_email", mailConfigured });
}

async function postGuestUpgradeConfirm(ctx) {
  const { res, store, remoteAddress, json, reject, rate, body, exact } = ctx;
  rate(`guest-upgrade-confirm:${remoteAddress}`, 20);
  const session = guestSession(ctx);
  const data = await body(ctx.req);
  if (!exact(data, ["email", "code", "password"]) || typeof data.code !== "string" || typeof data.password !== "string") {
    reject(422, "invalid_password_set", "An email, code, and password are required");
  }
  const email = emailFrom(ctx, data);
  const policy = checkPasswordPolicy(data.password);
  if (policy) reject(422, policy.code, policy.message);
  const accountId = session.account.id;
  // Someone took the address since the code went out: same answer as a bad code.
  if (store.accountLogins.findAccountHoldingEmail(email)) reject(401, "invalid_email_code", "That code is not valid");
  store.accountLogins.consumeEmailVerifyCode({ accountId, email, code: data.code.trim() });
  const method = store.accountLogins.linkPasswordMethod(accountId, { email, verifier: hashPassword(data.password) });
  store.accountLogins.markEmailVerified(accountId, email);
  store.accountLogins.touchMethod(accountId, method.id);
  return json(res, 200, { status: "upgraded", email });
}

const row = (id, path, handler, required) => Object.freeze({ id, method: "POST", path, auth: "account",
  capability: null, scope: "worker", handler, events: [], rate: { key: id, max: 20 },
  parity: "exempt:human browser account setup; agents have no guest account",
  schema: { body: { type: "object", required, additionalProperties: false,
    properties: Object.fromEntries(required.map(key => [key, { type: "string" }])) }, response: { type: "object" } } });

const GUEST_UPGRADE_ROUTES = [
  row("auth.guest.upgrade", "/api/auth/guest/upgrade", postGuestUpgrade, ["email"]),
  row("auth.guest.upgrade.confirm", "/api/auth/guest/upgrade/confirm", postGuestUpgradeConfirm, ["email", "code", "password"]),
];

export const AUTH_ROUTES = Object.freeze([
  authRoute({
    id: "auth.magic.request", method: "POST", path: "/api/auth/magic/request", auth: "account",
    rate: { key: "magic-request", max: 5 },
    schema: { body: emailRequestBody },
  }),
  authRoute({
    id: "auth.magic.consume", method: "POST", path: "/api/auth/magic/consume", auth: "account",
    rate: { key: "magic-consume", max: 10 },
    schema: { body: { type: "object", required: ["email", "code", "sessionRevision"], additionalProperties: false, properties: {
      email: { type: "string" }, code: { type: "string" }, ...slotFields,
    } } },
  }),
  authRoute({
    id: "auth.password.reset.request", method: "POST", path: "/api/auth/password/reset/request", auth: "account",
    rate: { key: "password-reset-request", max: 5 },
    schema: { body: emailRequestBody },
  }),
  authRoute({
    id: "auth.password.reset.consume", method: "POST", path: "/api/auth/password/reset/consume", auth: "account",
    rate: { key: "password-reset-consume", max: 10 },
    schema: { body: { type: "object", required: ["email", "code", "newPassword", "sessionRevision"], additionalProperties: false, properties: {
      email: { type: "string" }, code: { type: "string" }, newPassword: { type: "string", minLength: 10, maxLength: 256 }, sessionRevision: { type: "integer" },
    } } },
  }),
  authRoute({
    id: "auth.password.signup", method: "POST", path: "/api/auth/password/signup", auth: "account",
    rate: { key: "password-signup", max: 10 },
    schema: { body: { type: "object", required: ["email", "password", "sessionRevision"], additionalProperties: false, properties: {
      email: { type: "string" }, password: { type: "string" }, returnTo: { type: "string" }, ...slotFields,
    } } },
  }),
  authRoute({
    id: "auth.password.login", method: "POST", path: "/api/auth/password/login", auth: "account",
    rate: { key: "password-login-ip", max: 60 },
    schema: { body: { type: "object", required: ["email", "password", "sessionRevision"], additionalProperties: false, properties: {
      email: { type: "string" }, password: { type: "string" }, ...slotFields,
    } } },
  }),
  authRoute({
    id: "auth.password.change", method: "POST", path: "/api/auth/password/change", auth: "account",
    rate: { key: "password-change", max: 20 },
    schema: { body: { type: "object", required: ["currentPassword", "newPassword"], additionalProperties: false, properties: {
      currentPassword: { type: "string" }, newPassword: { type: "string" },
    } } },
  }),
  authRoute({
    id: "auth.passkey.register.options", method: "POST", path: "/api/auth/passkey/register/options", auth: "account",
    rate: { key: "passkey-register-options", max: 10 },
    schema: { body: { type: "object", properties: { userName: { type: "string" }, authenticatorSelection: { type: "object" } } } },
  }),
  authRoute({
    id: "auth.passkey.register.finish", method: "POST", path: "/api/auth/passkey/register/finish", auth: "account",
    rate: { key: "passkey-register-finish", max: 10 },
    schema: { body: { type: "object", required: ["challengeId", "response"], additionalProperties: false, properties: {
      challengeId: { type: "string" }, response: { type: "object" },
    } } },
  }),
  authRoute({
    id: "auth.passkey.authenticate.options", method: "POST", path: "/api/auth/passkey/authenticate/options", auth: "none",
    rate: { key: "passkey-auth-options", max: 20 },
    schema: { body: { type: "object" } },
  }),
  authRoute({
    id: "auth.passkey.authenticate.finish", method: "POST", path: "/api/auth/passkey/authenticate/finish", auth: "account",
    rate: { key: "passkey-auth-finish", max: 10 },
    schema: { body: { type: "object", required: ["challengeId", "response", "sessionRevision"], additionalProperties: false, properties: {
      challengeId: { type: "string" }, response: { type: "object" }, ...slotFields,
    } } },
  }),
  ...GUEST_UPGRADE_ROUTES,
]);
