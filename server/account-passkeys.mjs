// Slice 5 (RC-2026-09-17-014) — passkey / WebAuthn wiring.
//
// Thin ceremony layer over src/passkey-login.mjs (F019): an in-memory
// single-use challenge store plus registration/assertion wiring against the
// slice-1 model (server/account-login-methods.mjs). No network, no timers;
// randomness and time are injectable so tests drive it deterministically.
// The crypto verifiers are injectable too — tests stub them, never fork the
// crypto.
//
// Registration binds to an authenticated account session (the HTTP layer
// enforces this; it prevents passkey squatting). Authentication consumes a
// login slot via store.loginAccountSessionWithMethod (slice 1 primitive).
//
// Multi-process limitation: the challenge store is pure in-memory. A
// deployment running more than one server process must share challenges
// (or pin the whole ceremony to one process); otherwise a finish posted to
// a different process than the options call answers 401.

import { createHash, randomBytes } from "node:crypto";
import { ServiceError } from "./store.mjs";
import {
  createRegistrationOptions, verifyRegistrationResponse, createAuthenticationOptions, verifyAuthenticationAssertion
} from "../src/passkey-login.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
const isNonEmptyString = value => typeof value === "string" && value.length > 0;
const base64url = bytes => Buffer.from(bytes).toString("base64url");

export const PASSKEY_CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CHALLENGES = 1000; // bound the in-memory store; oldest evicted first

// In-memory single-use challenge store with TTL. issueChallenge(purpose,
// accountId) -> { id, challenge }; consumeChallenge(id) returns the stored
// record ({ id, purpose, accountId, challenge, issuedAt, expiresAt }) and
// deletes it — a replayed or expired id answers 401.
export function createChallengeStore({ now = Date.now, ttlMs = PASSKEY_CHALLENGE_TTL_MS, random = randomBytes } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError("ttlMs must be a positive number");
  const pending = new Map();
  const sweep = () => {
    const at = Number(now());
    for (const [id, record] of pending) {
      if (record.expiresAt <= at) pending.delete(id);
    }
    if (pending.size > MAX_CHALLENGES) {
      const oldest = [...pending.values()].sort((a, b) => a.issuedAt - b.issuedAt);
      for (const record of oldest.slice(0, pending.size - MAX_CHALLENGES)) pending.delete(record.id);
    }
  };
  return {
    issueChallenge(purpose, accountId) {
      if (purpose !== "register" && purpose !== "authenticate") {
        fail(422, "invalid_passkey_purpose", "Challenge purpose must be register or authenticate");
      }
      const issuedAt = Number(now());
      const record = {
        id: base64url(random(16)),
        purpose,
        accountId: accountId ?? null,
        challenge: base64url(random(32)),
        issuedAt,
        expiresAt: issuedAt + ttlMs
      };
      pending.set(record.id, record);
      sweep(); // expire dead entries, then evict oldest past the bound
      return { id: record.id, challenge: record.challenge };
    },
    consumeChallenge(id) {
      const record = typeof id === "string" ? pending.get(id) : undefined;
      if (record) pending.delete(id); // single-use: consumed even when the follow-up verify fails
      if (!record || Number(now()) > record.expiresAt) {
        fail(401, "invalid_passkey_challenge", "Challenge expired or already used; start the ceremony again");
      }
      return record;
    },
    get size() { return pending.size; }
  };
}

const defaultVerifiers = {
  createRegistrationOptions, verifyRegistrationResponse, createAuthenticationOptions, verifyAuthenticationAssertion
};

// Resolve the WebAuthn origin / RP-ID pair from the server's expected
// origin. WebAuthn needs a secure context — an https origin or a loopback
// host — otherwise the browser ceremony cannot run and this throws 422.
// Returns null when no origin can be established at all (the HTTP layer
// answers an honest 503 passkey_not_configured in that case). The RP ID
// comes from ROOM_PASSKEY_RP_ID or defaults to the origin's hostname.
export function resolvePasskeyParams(expectedOriginValue, rpIdOverride = process.env.ROOM_PASSKEY_RP_ID) {
  let url;
  try { url = new URL(expectedOriginValue); }
  catch { return null; }
  const hostname = url.hostname;
  const bareHost = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const loopback = bareHost === "localhost" || bareHost === "127.0.0.1" || bareHost === "::1";
  if (url.protocol !== "https:" && !loopback) {
    fail(422, "passkey_origin_rejected", "Passkey sign-in needs an https origin or localhost");
  }
  const rpId = typeof rpIdOverride === "string" && rpIdOverride !== "" ? rpIdOverride : bareHost;
  return { origin: url.origin, rpId };
}

// Name shown in the passkey picker at every sign-in. Account ids for email
// accounts are "email:<sha256 hex>", which made every picker entry look the
// same and unreadable, so show the verified email first, then any email, then
// the profile display name. An account with none of them gets a plain label.
export const PASSKEY_RP_NAME = "Project Room";
export const PASSKEY_FALLBACK_USER = "Project Room account";
export function passkeyUserLabel(store, accountId) {
  try {
    const methods = store.accountLogins.listMethods(accountId).filter(method => !method.disabled && isNonEmptyString(method.email));
    const best = methods.find(method => method.verifiedAt) ?? methods[0];
    if (best) return best.email;
  } catch { /* fall through to the profile */ }
  try {
    const name = store.accountProfile(accountId).displayName;
    if (isNonEmptyString(name)) return name;
  } catch { /* account has no profile row */ }
  return PASSKEY_FALLBACK_USER;
}

// Wiring around the model. `store` is the RoomStore (store.accountLogins,
// store.loginAccountSessionWithMethod, store.db). `challenges` defaults to a
// fresh in-memory store; the HTTP layer creates one per server instance and
// shares it across the four routes. `verifiers` defaults to the real
// src/passkey-login.mjs functions; tests inject stubs.
export function createPasskeyAuth({ store, challenges = createChallengeStore({ now: () => store.now() }),
  verifiers = defaultVerifiers } = {}) {
  if (store == null || typeof store !== "object") throw new TypeError("store is required");
  const logins = () => {
    if (store.accountLogins == null) throw new Error("store.accountLogins is required for passkey auth");
    return store.accountLogins;
  };

  // Build registration options for navigator.credentials.create(). Returns
  // the options JSON plus the challenge id the client must echo back.
  function beginRegistration({ accountId, rpId, rpName, userName, authenticatorSelection }) {
    if (!isNonEmptyString(accountId)) fail(422, "invalid_account_id", "A valid account is required");
    if (!isNonEmptyString(rpId)) fail(422, "invalid_passkey_rp", "An RP id is required");
    if (!isNonEmptyString(userName)) fail(422, "invalid_passkey_user", "A user name is required");
    if (authenticatorSelection !== undefined && (authenticatorSelection === null || typeof authenticatorSelection !== "object")) {
      fail(422, "invalid_passkey_selection", "authenticatorSelection must be an object");
    }
    // 404 when the account does not exist; already-registered credentials
    // are excluded so the authenticator will not silently re-register.
    const excludeCredentials = logins().listPasskeyCredentials(accountId).map(credential => ({
      id: credential.credentialId,
      ...(Array.isArray(credential.transports) && credential.transports.length > 0 ? { transports: credential.transports } : {})
    }));
    const issued = challenges.issueChallenge("register", accountId);
    const { options } = verifiers.createRegistrationOptions({
      rpId,
      rpName: isNonEmptyString(rpName) ? rpName : rpId,
      // WebAuthn caps user.id at 64 bytes and wants an opaque handle, not an
      // identifier: email:<sha256 hex> account ids are 70 bytes and made every
      // email account's registration fail in the browser. A 32-byte digest is
      // stable per account and never exposes the id.
      user: { id: createHash("sha256").update(accountId, "utf8").digest(), name: userName, displayName: userName },
      challenge: issued.challenge,
      excludeCredentials,
      // Login is discoverable-only (beginAuthentication sends no
      // allowCredentials), so a registered credential is useless unless it
      // is discoverable: force resident keys no matter what the caller asked.
      authenticatorSelection: { ...authenticatorSelection, residentKey: "required", requireResidentKey: true }
    });
    return { ...options, challengeId: issued.id };
  }

  // Verify the registration response and persist the credential.
  // 401 when the challenge is replayed, expired, or bound to another
  // account; 401 (not 500) when the attestation does not verify.
  function finishRegistration({ accountId, challengeId, response, expectedOrigin, rpId, label = "Passkey" }) {
    if (!isNonEmptyString(accountId)) fail(422, "invalid_account_id", "A valid account is required");
    const issued = challenges.consumeChallenge(challengeId);
    if (issued.purpose !== "register" || issued.accountId !== accountId) {
      fail(401, "invalid_passkey_challenge", "Challenge was not issued for this registration");
    }
    if (!isNonEmptyString(rpId)) fail(422, "invalid_passkey_rp", "An RP id is required");
    if (!isNonEmptyString(expectedOrigin)) fail(422, "invalid_passkey_origin", "An expected origin is required");
    let record;
    try {
      record = verifiers.verifyRegistrationResponse({
        response,
        expected: { challenge: issued.challenge, rpId, origin: expectedOrigin }
      });
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      fail(401, "passkey_verification_failed", "Passkey registration did not verify");
    }
    const linked = logins().registerPasskeyCredential(accountId, record, { label });
    return { ok: true, credentialId: linked.credentialId };
  }

  // Build authentication options for navigator.credentials.get().
  // Discoverable-credential flow: no allowCredentials, so the account is
  // resolved from the assertion's credential id.
  function beginAuthentication({ rpId }) {
    if (!isNonEmptyString(rpId)) fail(422, "invalid_passkey_rp", "An RP id is required");
    const issued = challenges.issueChallenge("authenticate", null);
    const { options } = verifiers.createAuthenticationOptions({ rpId, challenge: issued.challenge, allowCredentials: [] });
    return { ...options, challengeId: issued.id };
  }

  // Verify the assertion and return the verified account. The
  // {getCredential, updateSignCount} adapter comes from the slice-1 model
  // and updates the sign count on success. The login-methods row is
  // touched for the settings UI "last used" display; the method id is a
  // read-only lookup on the credential's method_id (never a secret).
  function finishAuthentication({ challengeId, response, expectedOrigin, rpId }) {
    const issued = challenges.consumeChallenge(challengeId);
    if (issued.purpose !== "authenticate") {
      fail(401, "invalid_passkey_challenge", "Challenge was not issued for authentication");
    }
    if (!isNonEmptyString(rpId)) fail(422, "invalid_passkey_rp", "An RP id is required");
    if (!isNonEmptyString(expectedOrigin)) fail(422, "invalid_passkey_origin", "An expected origin is required");
    const adapter = logins().passkeyStore();
    let verified;
    try {
      verified = verifiers.verifyAuthenticationAssertion({
        assertion: response,
        expected: { challenge: issued.challenge, rpId, origin: expectedOrigin },
        store: adapter
      });
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      fail(401, "passkey_verification_failed", "Passkey assertion did not verify");
    }
    const credential = adapter.getCredential(verified.credentialId);
    const accountId = credential?.accountId;
    if (!isNonEmptyString(accountId)) fail(401, "passkey_verification_failed", "Passkey assertion did not verify");
    const row = store.db.prepare("SELECT method_id AS methodId FROM account_passkey_credentials WHERE credential_id=?")
      .get(verified.credentialId);
    const methodId = row?.methodId ?? null;
    if (methodId) logins().touchMethod(accountId, methodId);
    // ref is the login-methods row id (a public handle, never a secret);
    // the credential id is the fallback when the row is unexpectedly gone.
    return { ok: true, accountId, methodRef: methodId ?? verified.credentialId };
  }

  return { beginRegistration, finishRegistration, beginAuthentication, finishAuthentication, challenges };
}
