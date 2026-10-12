import { uiText } from "./strings.js";
import { verifyWorkResult } from "./work-packet.js";
import { validateCharterRead } from "./room-charter.js";
import { DM_CONSENT_REFUSAL_CODES } from "./dm-consents.js";
import { BOND_REFUSAL_CODES } from "./friend-bond.js";
import { humanErrorMessage } from "./error-copy.js";

// C2: the read-only "what this agent can access" preview must describe exactly the
// selected work the browser asked about and repeat the server's own omission list;
// anything else is a mismatched response, never a wider or narrower grant.
export function verifyAccessSummary(value, { roomId, workItemId }) {
  const invalid = () => { const error = new Error("Access preview does not match the selected work"); error.code = "invalid_response"; return error; };
  const summary = value?.accessSummary, work = value?.work, conversation = summary?.conversation;
  if (value?.contractVersion !== 1 || value.roomId !== roomId || work?.id !== workItemId || !Number.isFinite(Date.parse(value.evaluatedAt))
    || summary?.version !== 1 || summary.membership !== "room") throw invalid();
  if (!Array.isArray(summary.omitted) || !Array.isArray(value.context?.omitted) || summary.omitted.length !== value.context.omitted.length
    || summary.omitted.some((entry, index) => typeof entry !== "string" || entry !== value.context.omitted[index])) throw invalid();
  if (!conversation || !Array.isArray(conversation.sourceMessageIds) || conversation.deliveredByDefault !== false
    || conversation.sourceMessageIds.some(id => id !== work.sourceMessageId)
    || (conversation.scope === "none") !== (work.sourceMessageId == null)
    || !["not_linked", "unavailable", "deleted", "available"].includes(conversation.sourceAvailability)
    || (conversation.sourceAvailability === "not_linked") !== (work.sourceMessageId == null)) throw invalid();
  if (!Array.isArray(summary.evidence?.records) || summary.evidence.retrieved !== false
    || summary.evidence.records.some(entry => !["receipt", "verification", "decision", "handoff"].includes(entry?.record)
      || (work[entry.record]?.evidenceVersion ?? null) !== entry.evidenceVersion)) throw invalid();
  if (!summary.budget || typeof summary.budget !== "object" || ["maxRuntimeMs", "maxAttempts", "maxConcurrent", "maxSpendCents", "spendCents"]
    .some(key => !(summary.budget[key] === "unknown" || Number.isSafeInteger(summary.budget[key])))) throw invalid();
  if (!Array.isArray(summary.participantIds) || summary.externalExecution !== false || summary.credentials !== "none") throw invalid();
  return summary;
}

// Room events that only append: they never change a message already held, so
// a live refresh for them can read `?messages=recent` and keep older history.
const RECENT_REFRESH_EVENTS = new Set(["message.posted", "dm.posted", "work_claim.updated"]);
// Join held history with a `?messages=recent` window. The window must start on
// a held message with exactly `omitted` messages before it; anything else
// returns null and the caller reads the full snapshot.
function mergeRecentMessages(held, read) {
  const window = read?.messagesWindow, recent = read?.state?.messages;
  if (!window || window.mode !== "recent" || !Number.isSafeInteger(window.omitted) || window.omitted < 0 || !Array.isArray(recent)) return null;
  const { messagesWindow, ...snapshot } = read;
  if (window.omitted === 0) return snapshot;
  const start = recent.length ? held.findIndex(message => message?.id === recent[0]?.id) : -1;
  if (start !== window.omitted) return null;
  return { ...snapshot, state: { ...snapshot.state, messages: [...held.slice(0, start), ...recent] } };
}
// A fresh client holds no history, so its first read used to be the whole room
// (muse-room: 4+ MB, ~7s on prod, 3s short of the 10s read timeout). It now
// reads the newest window first and fills the rest in the background; `partial`
// marks held history that is only that window.
const FILL_DELAY_MS = 250;
function firstWindow(read) {
  const window = read?.messagesWindow;
  if (!window || window.mode !== "recent" || !Number.isSafeInteger(window.omitted) || window.omitted < 0 || !Array.isArray(read?.state?.messages)) return null;
  const { messagesWindow, ...snapshot } = read;
  return { snapshot, partial: window.omitted > 0 };
}
export const IDENTITY_MINT_POW_BITS = 12;
export const IDENTITY_MINT_POW_WINDOW_MS = 10 * 60 * 1000;

// Same challenge as server/agent-identities.mjs solveIdentityMintProof:
// sha256(`${bucket}:${trim(displayName)}:${nonce}`) with bucket = floor(now / window).
export async function solveIdentityMintProof(displayName, now = Date.now(), bits = IDENTITY_MINT_POW_BITS) {
  const name = typeof displayName === "string" ? displayName.trim() : "";
  const bucket = Math.floor(now / IDENTITY_MINT_POW_WINDOW_MS);
  const prefix = "0".repeat(bits / 4);
  const encoder = new TextEncoder();
  for (let i = 0; i < 1_000_000; i++) {
    const nonce = i.toString(36);
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${bucket}:${name}:${nonce}`));
    const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    if (hex.startsWith(prefix)) return nonce;
  }
  throw new Error("proof search exhausted");
}

const accountSessionError = message => {
  const error = new Error(message);
  error.status = 401;
  error.code = "account_session_required";
  return error;
};

const sameAccountSession = (candidate, owner) => Boolean(candidate?.account && owner?.account)
  && candidate.account.id === owner.account.id
  && candidate.account.authEpoch === owner.account.authEpoch
  && candidate.sessionRevision === owner.sessionRevision
  && candidate.sessionBinding === owner.sessionBinding;

export class AccountClient {
  constructor({ fetcher = globalThis.fetch.bind(globalThis) } = {}) {
    this.fetcher = fetcher;
    this.session = null;
    this.generation = 0;
  }
  async request(path, { method = "GET", data, credentials = "same-origin", session = null } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await this.fetcher(path, { method, credentials, signal: controller.signal,
        headers: { ...(data === undefined ? {} : { "Content-Type": "application/json" }), ...(session?.csrf ? { "X-CSRF-Token": session.csrf } : {}), ...(session?.sessionBinding ? { "X-Session-Binding": session.sessionBinding } : {}) },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      const body = await response.json();
      if (!response.ok) { const serverError = body?.error ?? {}; const error = new Error(humanErrorMessage({ status: response.status, code: serverError.code, message: serverError.message })); error.status = response.status; error.code = serverError.code; throw error; }
      return body;
    } finally { clearTimeout(timer); }
  }
  owns(generation, session) { return generation === this.generation && this.session === session; }
  invalidate(generation, session) {
    if (!this.owns(generation, session)) return false;
    this.generation++;
    this.session = null;
    return true;
  }
  currentSession(action, { authenticated = false } = {}) {
    const session = this.session;
    if (!session || !Number.isSafeInteger(session.sessionRevision) || typeof session.csrf !== "string" || typeof session.sessionBinding !== "string"
      || (authenticated && (!session.authenticated || !session.account))) {
      throw accountSessionError(`Restore${authenticated ? " and sign in to" : ""} the account session before ${action}`);
    }
    return session;
  }
  async restore() {
    const generation = ++this.generation;
    this.session = null;
    try {
      const restored = await this.request("/api/account-session");
      if (generation !== this.generation) return null;
      this.session = restored;
      return restored;
    } catch (error) {
      if (generation !== this.generation) return null;
      throw error;
    }
  }
  async login(accountAccessKey) {
    const session = this.currentSession("signing in");
    const generation = ++this.generation;
    try {
      const loggedIn = await this.request("/api/account-session", { method: "POST", session,
        data: { accountAccessKey, expectedSessionRevision: session.sessionRevision } });
      if (!this.owns(generation, session)) return null;
      if (!loggedIn?.authenticated || !loggedIn.account || loggedIn.sessionRevision !== session.sessionRevision + 1) {
        this.invalidate(generation, session);
        return null;
      }
      this.session = loggedIn;
      return loggedIn;
    } catch (error) {
      if (!this.owns(generation, session)) return null;
      // A transport failure can follow a committed identity switch. Do not retain an
      // identity view whose browser slot outcome is unknown; an HTTP rejection did not
      // mutate the slot and may be retried with the same revision.
      if (!Number.isSafeInteger(error.status) || ["stale_session_revision", "session_binding_changed", "csrf_denied", "account_session_required"].includes(error.code)) {
        this.invalidate(generation, session);
      }
      throw error;
    }
  }
  async confirm() {
    const session = this.currentSession("confirming access", { authenticated: true }), generation = this.generation;
    let value;
    try {
      // Name the session this read is checking: a delayed confirmation must
      // never mint a slot, rotate a cookie, or clobber a newer sign-in.
      value = await this.request("/api/account-session", { session });
    } catch (error) {
      // A response that lands after a newer session replaced this one is
      // obsolete: never let it touch the replacement, whatever it reports.
      if (!this.owns(generation, session)) return null;
      // Ownership ended (signed out, revoked, binding rotated): retire the
      // view instead of throwing. Uncertain failures (5xx, offline) keep
      // the session so the caller can retry.
      if (error?.status === 401 || error?.status === 403 || error?.status === 409
        || ["unauthenticated", "access_denied", "session_binding_changed"].includes(error?.code)) {
        this.invalidate(generation, session);
        return false;
      }
      throw error;
    }
    if (!this.owns(generation, session)) return null;
    if (!value?.authenticated || !sameAccountSession(value, session)) { this.invalidate(generation, session); return false; }
    return true; // Keep object identity and generation: Room and Inbox own these.
  }
  async rooms(after = null) {
    const session = this.currentSession("listing rooms", { authenticated: true }), generation = this.generation;
    let value;
    try { value = await this.request("/api/account-rooms" + (after === null ? "" : "?after=" + encodeURIComponent(after)), { session }); }
    catch (error) {
      if (!this.owns(generation, session)) return null;
      if (error.status === 401 || ["session_binding_changed", "account_session_required"].includes(error.code)) this.invalidate(generation, session);
      throw error;
    }
    if (!this.owns(generation, session)) return null;
    const v = value?.viewer;
    if (value?.contractVersion !== 1 || v?.accountId !== session.account.id || v.authEpoch !== session.account.authEpoch
      || v.sessionRevision !== session.sessionRevision || v.sessionBinding !== session.sessionBinding) {
      this.invalidate(generation, session); throw accountSessionError("Account changed");
    }
    const id = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
    if (!Array.isArray(value.rooms) || value.rooms.length > 50 || !value.rooms.every(r => id(r?.id) && id(r.memberId) && typeof r.title === "string")
      || (value.nextCursor !== null && !id(value.nextCursor))) throw new Error("Room list could not be confirmed");
    let previous = after ?? "";
    for (const room of value.rooms) { if (room.id <= previous) throw new Error("Room list order could not be confirmed"); previous = room.id; }
    if (value.nextCursor !== null && (value.nextCursor <= (after ?? "") || value.nextCursor < previous)) throw new Error("Room continuation could not be confirmed");
    return value;
  }
  async logout() {
    const session = this.currentSession("signing out");
    const generation = ++this.generation;
    try {
      const loggedOut = await this.request("/api/account-session", { method: "DELETE", session,
        data: { expectedSessionRevision: session.sessionRevision } });
      if (!this.owns(generation, session)) return null;
      if (loggedOut?.authenticated !== false || loggedOut.account !== null || loggedOut.sessionRevision !== session.sessionRevision + 1) {
        this.invalidate(generation, session);
        return null;
      }
      this.session = loggedOut;
      return loggedOut;
    } catch (error) {
      if (!this.owns(generation, session)) return null;
      if (!Number.isSafeInteger(error.status) || ["stale_session_revision", "csrf_denied", "account_session_required", "unauthenticated"].includes(error.code)) {
        this.invalidate(generation, session);
      }
      throw error;
    }
  }
  previewInvitation(invitationToken) {
    // Preview deliberately sends neither the current account cookie nor its CSRF/binding.
    return this.request("/api/invitations/preview", { method: "POST", credentials: "omit", data: { invitationToken } });
  }
  // RC-2026-09-19-071 (QAJ-001): the request-access door. A stranger with a
  // dead invitation mints a self-serve identity (an identity alone grants
  // nothing) and files an access request the room owner can approve or
  // deny. Both calls are unauthenticated by design; credentials omitted.
  async mintAccessIdentity(displayName) {
    const proof = await solveIdentityMintProof(displayName);
    return this.request("/api/agent-identities", { method: "POST", credentials: "omit", data: { displayName, proof } });
  }
  submitAccessRequest({ roomId, identityId, displayName, requestedPermissions, note, referredBy, requestId }) {
    return this.request("/api/access-requests", { method: "POST", credentials: "omit",
      data: { roomId, identityId, displayName, requestedPermissions, note, referredBy: referredBy ?? null, requestId } });
  }
  async joinShareLink({ linkToken, displayName, redemptionId }) {
    const session = this.currentSession("joining a room");
    // An authenticated join adds membership, not a new browser identity. Keep
    // existing Room ownership intact just as targeted acceptance does.
    const generation = session.authenticated ? this.generation : ++this.generation;
    try {
      const result = await this.request("/api/share-links/join", { method: "POST", session,
        data: { linkToken, displayName, redemptionId, expectedSessionRevision: session.sessionRevision } });
      if (!this.owns(generation, session)) return null;
      if (result.roomMode === true) return result;
      const next = result.session;
      const valid = next?.account && next.roomId === result.roomId && next.member?.kind === "human"
        && (session.authenticated ? sameAccountSession(next, session) : next.sessionRevision === session.sessionRevision + 1);
      if (!valid) { this.invalidate(generation, session); return null; }
      if (!session.authenticated) this.session = { ...next, authenticated: true };
      return result;
    } catch (error) {
      if (!this.owns(generation, session)) return null;
      // Anonymous joins may switch identity even if their response was lost.
      // Authenticated joins cannot switch identity; a rejected link must not
      // discard the unrelated open Room's ownership and private drafts.
      if (!session.authenticated || error.status === 401
        || ["session_binding_changed", "csrf_denied", "account_session_required"].includes(error.code)) this.invalidate(generation, session);
      throw error;
    }
  }
  async prepareShareLink(linkToken) {
    let preview;
    try {
      preview = await this.request("/api/share-links/preview", { method: "POST", credentials: "omit", data: { linkToken } });
    } catch (error) {
      if (error.code !== "link_unavailable") throw error;
      const session = this.session ?? await this.restore();
      if (!session?.authenticated) throw error;
      const generation = this.generation;
      // Closed invitations cannot admit anyone new, but remain a door for an
      // existing member. The server checks membership without redeeming a place.
      preview = await this.request("/api/share-links/preview", { method: "POST", session, data: { linkToken } });
      if (!this.owns(generation, session)) return { preview, session: null };
    }
    // Preview/cancel is not consent to replace an already-open account context.
    const session = this.session ?? await this.restore();
    return { preview, session };
  }
  async acceptInvitation({ invitationToken, redemptionId, expectedRevision }) {
    const session = this.currentSession("accepting an invitation", { authenticated: true });
    const generation = this.generation;
    try {
      const accepted = await this.request("/api/invitations/accept", { method: "POST", session,
        data: { invitationToken, redemptionId, expectedRevision } });
      if (!this.owns(generation, session)) return null;
      if (!sameAccountSession(accepted?.session, session)) {
        this.invalidate(generation, session);
        return null;
      }
      return accepted;
    } catch (error) {
      if (!this.owns(generation, session)) return null;
      if (error.status === 401 || ["stale_session_revision", "session_binding_changed", "csrf_denied", "account_session_required"].includes(error.code)) {
        this.invalidate(generation, session);
      }
      throw error;
    }
  }
}

// Single source for the connected status line; app.js matches this exact text.
const CONNECTED_STATUS = "Connected to room service · no peer read or processing receipt";
export class RoomClient {
  constructor({ fetcher = globalThis.fetch.bind(globalThis), events = globalThis.EventSource, accountClient = null, onSnapshot = () => {}, onStatus = () => {}, onAccessEnded = () => {}, onTyping = () => {}, onConsentChange = () => {} } = {}) {
    Object.assign(this, { fetcher, events, accountClient, onSnapshot, onStatus, onAccessEnded, onTyping, onConsentChange });
    this.session = null;
    this.sequence = 0;
    this.generation = 0;
    this.accountOwnership = null;
    this.streamRetryDelay = 1000;
    this.lastTypingSent = 0;
  }
  setAccountClient(accountClient) {
    if (this.accountClient === accountClient) return this;
    const hadSession = Boolean(this.session);
    this.disconnect();
    this.session = null;
    this.sequence = 0;
    this.accountOwnership = null;
    this.accountClient = accountClient;
    if (hadSession) this.onAccessEnded();
    return this;
  }
  async request(path, { method = "GET", data, authMode = this.session?.authMode, authSession = this.session, offerContext = false } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await this.fetcher(path, { method, credentials: "same-origin", signal: controller.signal,
        headers: { ...(data === undefined ? {} : { "Content-Type": "application/json" }), ...(authSession?.csrf ? { "X-CSRF-Token": authSession.csrf } : {}),
          ...(offerContext ? { "X-Project-Room-Offer-Context": "1" } : {}),
          ...(authMode === "account" ? { "X-Project-Room-Auth": "account", ...(authSession?.sessionBinding ? { "X-Session-Binding": authSession.sessionBinding } : {}) } : {}) },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      const body = await response.json();
      if (!response.ok) { const serverError = body?.error ?? {}; const error = new Error(humanErrorMessage({ status: response.status, code: serverError.code, message: serverError.message })); error.status = response.status; error.code = serverError.code; throw error; }
      return body;
    } finally { clearTimeout(timer); }
  }
  async restore(roomId = null) {
    this.disconnect(); this.sequence = 0; this.session = null; this.accountOwnership = null;
    const generation = this.generation;
    const accountMode = roomId !== null;
    const accountClient = accountMode ? this.accountClient : null;
    const accountSession = accountClient?.session ?? null;
    const accountGeneration = accountClient?.generation ?? null;
    if (accountMode && (!accountClient || !accountSession?.authenticated || !accountSession.account)) {
      throw accountSessionError("Restore and sign in to the account session before opening a Room");
    }
    try {
      const restored = await this.request(accountMode ? `/api/session?room=${encodeURIComponent(roomId)}` : "/api/session",
        accountMode ? { authMode: "account", authSession: accountSession } : {});
      if (generation !== this.generation) return null;
      if (accountMode && (accountClient !== this.accountClient || accountGeneration !== accountClient.generation || accountSession !== accountClient.session
        || restored?.authMode !== "account" || restored.roomId !== roomId || !sameAccountSession(restored, accountSession))) return null;
      this.session = restored;
      if (accountMode) this.accountOwnership = { client: accountClient, generation: accountGeneration, session: accountSession };
      await this.refresh();
      if (generation !== this.generation || this.session !== restored) return null;
      // A 200 session proves we are signed in. Drop any stale "sign in required" line
      // left by an earlier anonymous probe; the stream's open event then says Connected.
      this.onStatus(uiText("connection.connecting"));
      this.connect(); return this.session;
    } catch (error) {
      if (generation !== this.generation) return null;
      if (accountMode && (accountClient !== this.accountClient || accountGeneration !== accountClient.generation || accountSession !== accountClient.session)) return null;
      // refresh() may already have exposed one snapshot before a coalesced follow-up
      // fails. Fail closed through the UI clearing callback whenever identity existed.
      if (this.session) this.endAccess();
      else { this.session = null; this.sequence = 0; }
      throw error;
    }
  }
  async login(accessKey) {
    this.disconnect(); this.sequence = 0; this.session = null; this.accountOwnership = null;
    const generation = this.generation;
    try {
      const loggedIn = await this.request("/api/session", { method: "POST", data: { accessKey } });
      if (generation !== this.generation) return null;
      this.session = loggedIn;
      await this.refresh();
      if (generation !== this.generation || this.session !== loggedIn) return null;
      this.connect(); return this.session;
    } catch (error) {
      if (generation !== this.generation) return null;
      if (this.session) this.endAccess();
      else { this.session = null; this.sequence = 0; }
      throw error;
    }
  }
  async logout() {
    const generation = this.generation, session = this.session;
    if (session?.authMode === "account" && this.accountClient) {
      // Never let an old Room sign out the replacement identity now occupying the
      // shared account-session slot.
      if (!this.ownsAccountSession()) { this.endAccess(); return null; }
      try {
        const loggedOut = await this.accountClient.logout();
        if (generation !== this.generation || this.session !== session) return null;
        this.endAccess();
        return loggedOut;
      } catch (error) {
        if (generation === this.generation && this.session === session && !this.ownsAccountSession()) this.endAccess();
        throw error;
      }
    }
    await this.request("/api/session", { method: "DELETE" });
    // A delayed response belongs only to the session that issued it. An access-ended
    // stream may already have exposed sign-in and allowed a different account to enter.
    if (generation === this.generation && this.session === session) this.endAccess();
  }
  path(suffix = "") { return `/api/rooms/${encodeURIComponent(this.session.roomId)}${suffix}`; }
  // BUILD-01 F2 follow-up: the readable room export for people. A plain link
  // cannot carry the account session binding, so the page fetches it with the
  // same headers as every other room read and receives the file as a Blob to
  // hand to the browser. Anything but a 200 text/html body is an error.
  async exportHtml() {
    if (!this.session) throw accountSessionError("Open the Room before exporting it");
    if (this.session.authMode === "account" && !this.ownsAccountSession()) { this.endAccess(); throw accountSessionError("Account session changed; reopen the Room before exporting"); }
    const { authMode, sessionBinding, roomId } = this.session;
    const response = await this.fetcher(this.path("/export?format=html"), { method: "GET", credentials: "same-origin",
      headers: authMode === "account" ? { "X-Project-Room-Auth": "account", ...(sessionBinding ? { "X-Session-Binding": sessionBinding } : {}) } : {} });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const error = new Error(body?.error?.message || "Room export failed"); error.status = response.status; error.code = body?.error?.code;
      // PRIV-2: a member who is not the owner keeps their session; only the export is refused.
      const ownerOnly = response.status === 403 && error.code === "owner_required";
      if ((!ownerOnly && [401, 403].includes(response.status)) || (authMode === "account" && error.code === "session_binding_changed")) this.endAccess();
      throw error;
    }
    if (!/^text\/html/i.test(response.headers?.get("content-type") ?? "")) { const error = new Error("Room returned an unexpected export"); error.status = response.status; error.code = "invalid_response"; throw error; }
    return { blob: await response.blob(), filename: `room-${roomId}-export.html` };
  }
  ownsAccountSession() {
    if (this.session?.authMode !== "account") return true;
    const owner = this.accountOwnership;
    return Boolean(owner && owner.client === this.accountClient && owner.generation === owner.client.generation && owner.session === owner.client.session
      && sameAccountSession(this.session, owner.session));
  }
  ownsResponse(payload, session = this.session) {
    // Room-cookie sessions (join flow, access-key login) carry no account.
    // #720's anti-confusion check required session.account, so refresh()
    // endAccess()ed every room-mode session and restore() returned null —
    // stranding fresh joiners at the account gate despite a valid cookie.
    // Bind account-less room sessions on room + viewer + session binding.
    if (session?.authMode === "room" && !session.account) {
      return typeof session.sessionBinding === "string"
        && payload.roomId === session.roomId
        && payload.viewerId === session.member.id
        && payload.viewerSessionBinding === session.sessionBinding
        && (!Number.isSafeInteger(session.sessionRevision) || payload.viewerSessionRevision === session.sessionRevision);
    }
    return Boolean(session?.account && typeof session.account.id === "string" && Number.isSafeInteger(session.account.authEpoch) && typeof session.sessionBinding === "string")
      && (session.authMode !== "account" || this.ownsAccountSession())
      && payload.roomId === session.roomId
      && payload.viewerId === session.member.id
      && payload.viewerAccountId === session.account.id
      && payload.viewerAuthEpoch === session.account.authEpoch
      && payload.viewerSessionBinding === session.sessionBinding
      && (!Number.isSafeInteger(session.sessionRevision) || payload.viewerSessionRevision === session.sessionRevision);
  }
  // `revalidate`: a stream (re)open or error. It must re-read (access and the
  // newest messages), but the stream replays every event after the held
  // sequence, so older history is corrected by those events' own reads.
  refresh(receipt = null, { revalidate = false, fill = false } = {}) {
    if (this.session?.authMode === "account" && !this.ownsAccountSession()) { this.endAccess(); return Promise.resolve(); }
    // Only sequenced room events can prove a snapshot already contains a change.
    // Reconnects, explicit refreshes and non-event receipts always revalidate access.
    const sequence = receipt?.event?.roomId === this.session?.roomId && Number.isSafeInteger(receipt?.sequence) && receipt.sequence > 0
      ? receipt.sequence : null;
    // A new message or claim receipt cannot change older messages, so it may
    // re-read only the newest ones. Anything else needs a full read at or past
    // its own sequence, even when a newer windowed read already landed.
    // A background fill is always a full read; a fresh client's first read is windowed.
    const windowed = fill ? false : sequence === null ? (revalidate || !this.heldMessages()) : RECENT_REFRESH_EVENTS.has(receipt.event.type);
    const held = this.heldMessages(), fullSequence = held?.fullSequence ?? this.sequence;
    if (sequence !== null && sequence <= (windowed ? this.sequence : fullSequence)) return Promise.resolve();
    const generation = this.generation;
    if (this.flight?.generation === generation) {
      if (sequence === null) { if (revalidate) this.flight.revisit = true; else this.flight.again = true; }
      else {
        this.flight.sequence = Math.max(this.flight.sequence, sequence);
        if (!windowed) this.flight.fullSequence = Math.max(this.flight.fullSequence, sequence);
      }
      return this.flight.promise;
    }
    const flight = { generation, again: false, revisit: false, sequence: 0, fullSequence: 0, fullNow: !windowed };
    if (fill) flight.fill = true;
    this.flight = flight;
    flight.promise = (async () => {
      try {
        let covered = held?.fullSequence ?? 0;
        do {
          const session = this.session, holding = this.heldMessages();
          // With nothing held, read the newest window first (the background fill brings the rest).
          const full = flight.again || flight.fullNow || flight.fullSequence > covered;
          flight.again = false; flight.revisit = false; flight.fullNow = false; flight.sequence = 0;
          const read = await this.request(this.path(full ? "" : "?messages=recent"), { offerContext: true });
          if (generation !== this.generation || !this.session) return;
          if (!this.ownsResponse(read)) { this.endAccess(); return; }
          // A server without the recent view ignores the parameter and answers in full.
          const whole = full || !Object.hasOwn(read, "messagesWindow");
          let snapshot, partial = false, complete = whole;
          if (whole) snapshot = read;
          else if (!holding || holding.partial) {
            // First window (or a newer window while only a window is held): used as is.
            const first = firstWindow(read);
            snapshot = first?.snapshot ?? null; partial = Boolean(first?.partial); complete = Boolean(first) && !partial;
          } else snapshot = mergeRecentMessages(holding.messages, read);
          if (!snapshot) { flight.fullNow = true; continue; }
          if (complete) covered = Math.max(covered, read.sequence);
          if (snapshot.sequence >= this.sequence) {
            this.sequence = snapshot.sequence;
            this.held = { generation, session, messages: Array.isArray(snapshot.state?.messages) ? snapshot.state.messages.slice() : null,
              fullSequence: complete ? snapshot.sequence : (holding?.fullSequence ?? 0),
              partial, owesFull: !complete && (partial || Boolean(holding?.owesFull)) };
            this.onSnapshot(snapshot, this.session);
          }
        } while (flight.again || flight.revisit || flight.fullNow || flight.sequence > this.sequence || flight.fullSequence > covered);
        if (this.heldMessages()?.owesFull) this.scheduleFill();
      } catch (error) {
        if (generation !== this.generation) return;
        // A failed read may have owed a full one; the stream will not replay
        // its event. Keep what is held (a retry stays a cheap windowed read) and
        // owe a background full read instead of forcing the next read to be full.
        const kept = this.heldMessages();
        this.held = kept ? { ...kept, owesFull: true } : null;
        if (this.session?.authMode === "account" && !this.ownsAccountSession()) { this.endAccess(); return; }
        throw error;
      }
    })().finally(() => { if (this.flight === flight) this.flight = null; });
    return flight.promise;
  }
  // Background full read after a windowed first read (or a failed read). It never
  // changes the status line: the page is already usable. A failure retries quietly
  // with backoff; only an ended session (401/403) is surfaced.
  scheduleFill(delay = FILL_DELAY_MS) {
    if (this.fillTimer) return;
    const generation = this.generation, session = this.session;
    this.fillTimer = setTimeout(() => {
      this.fillTimer = null;
      if (generation !== this.generation || this.session !== session || !this.heldMessages()?.owesFull) return;
      this.refresh(null, { fill: true }).then(() => { this.fillDelay = 1000; }, error => {
        if (generation !== this.generation || this.session !== session) return;
        if ([401, 403].includes(error.status) || error.code === "session_binding_changed") { this.handleFailure(error); return; }
        const next = this.fillDelay || 1000;
        this.fillDelay = Math.min(next * 2, 30000);
        this.scheduleFill(next + Math.random() * next / 4);
      });
    }, delay);
  }
  // History held from this session's last snapshot, for windowed refreshes.
  heldMessages() {
    const held = this.held;
    return held && held.generation === this.generation && held.session === this.session && Array.isArray(held.messages) ? held : null;
  }
  async send(command) {
    if (this.session?.authMode === "account" && !this.ownsAccountSession()) { this.endAccess(); throw accountSessionError("Account session changed; reopen the Room before sending"); }
    const generation = this.generation;
    try {
      const receipt = await this.request(this.path("/commands"), { method: "POST", data: command });
      // A committed receipt remains a success even when the subsequent snapshot fetch fails.
      if (generation === this.generation && this.session) {
        if (!this.ownsAccountSession()) this.endAccess();
        else {
          try { await this.refresh(receipt); } catch (error) { if (generation === this.generation) this.handleFailure(error); }
        }
      }
      return receipt;
    } catch (error) {
      if (generation === this.generation) {
        if (this.session?.authMode === "account" && !this.ownsAccountSession()) this.endAccess();
        // Gate refusals are 403s but the session is still valid — ending
        // access here would sign the user out and swallow the refusal.
        else if (error.code !== "trust_off" && !DM_CONSENT_REFUSAL_CODES.includes(error.code) && !BOND_REFUSAL_CODES.includes(error.code)
          && ([401, 403].includes(error.status) || error.code === "session_binding_changed")) this.handleFailure(error);
      }
      throw error;
    }
  }
  async conversation({ limit = 50, cursor = null, since = null, messageId = null, channelId = null } = {}) {
    const session = this.session, generation = this.generation;
    if (!session || !this.ownsAccountSession()) throw new Error("Sign in again to read this conversation");
    const query = new URLSearchParams({ limit: String(limit) });
    for (const [key, value] of Object.entries({ cursor, since, messageId, channelId })) if (value !== null) query.set(key, value);
    const result = await this.request(this.path(`/conversation?${query}`));
    if (generation !== this.generation || this.session !== session || !this.ownsAccountSession()) throw new Error("Room identity changed");
    if (!this.ownsResponse(result, session)) { this.endAccess(); throw new Error("Room identity changed"); }
    if (result.conversationVersion !== 1 || !["replace", "not_modified", "reset"].includes(result.mode)
      || result.limit !== limit || result.messageId !== messageId || (result.channelId ?? null) !== channelId || !Number.isSafeInteger(result.sequence)
      || ![result.nextCursor, result.checkpoint].every(value => value === null || typeof value === "string")
      || result.mode !== "not_modified" && (!Array.isArray(result.messages) || result.messages.length > limit
        || result.messages.some(message => !message || typeof message.id !== "string" || messageId !== null && message.id !== messageId
          || channelId !== null && (message.toMemberId || (message.channelId || "general") !== channelId))))
      throw new Error("Conversation response could not be confirmed");
    // Callers replace their window and discard older cached pages on `replace`;
    // `reset` requires a fresh latest-page read. Neither is event-log replay.
    return result;
  }
  async replyContext(requestMessageId) {
    const session = this.session, generation = this.generation;
    if (!session || !this.ownsAccountSession()) throw new Error("Sign in again to read this request");
    const current = () => generation === this.generation && this.session === session && this.ownsAccountSession();
    let cursor = null, horizon = null, last = 0;
    const seen = new Set();
    for (let pageIndex = 0; pageIndex < 200; pageIndex++) {
      const query = new URLSearchParams({ requestMessageId, limit: "50", ...(cursor ? { cursor } : {}) });
      const result = await this.request(this.path(`/reply-context?${query}`));
      if (!current()) throw new Error("Room identity changed");
      if (!this.ownsResponse(result, session)) { this.endAccess(); throw new Error("Room identity changed"); }
      const page = result?.page;
      const anchor = JSON.stringify([page?.horizonSequence, page?.horizonEventId]);
      if (result.contractVersion !== 1 || result.selection?.requestMessageId !== requestMessageId
        || result.request?.id !== requestMessageId || !page || !Array.isArray(page.items)
        || page.items.length > 50 || typeof page.hasMore !== "boolean"
        || !Number.isSafeInteger(page.horizonSequence) || page.horizonSequence < 1
        || page.cursor !== cursor || page.afterSequence !== last || horizon !== null && anchor !== horizon
        || page.items.some(item => item.requestMessageId !== requestMessageId
          || !Number.isSafeInteger(item.sequence) || item.sequence <= last || item.sequence > page.horizonSequence))
        throw new Error("Request context could not be confirmed. Refresh context");
      horizon = anchor;
      for (const item of page.items) {
        if (item.sequence <= last) throw new Error("Request context is out of order");
        last = item.sequence;
      }
      if (!page.hasMore) {
        if (page.nextCursor !== null) throw new Error("Request context is incomplete");
        return result;
      }
      if (!page.items.length || typeof page.nextCursor !== "string" || !page.nextCursor || seen.has(page.nextCursor))
        throw new Error("Request context did not advance");
      seen.add(page.nextCursor); cursor = page.nextCursor;
    }
    throw new Error("Request context is too large. Open a new request");
  }
  async caughtUp(sequence = this.sequence) {
    if (this.session?.authMode === "account" && !this.ownsAccountSession()) { this.endAccess(); return null; }
    const generation = this.generation, session = this.session;
    const result = await this.request(this.path("/cursor"), { method: "POST", data: { sequence } });
    if (generation !== this.generation || this.session !== session) return null;
    if (!this.ownsAccountSession()) { this.endAccess(); return null; }
    return result;
  }
  // Ephemeral typing heartbeat. Client-throttled to one beat per 4s; the
  // server expires the beat after 10s, so no explicit stop is needed.
  // Failures are swallowed — typing is best-effort ambient signal.
  // Instinct-3 (muse-room 3675): /typing is room-wide, so a beat while a
  // private recipient is selected would tell every member who is writing a
  // DM and when. A private draft sends no beat.
  sendTyping({ toMemberId = "" } = {}) {
    if (!this.session) return Promise.resolve();
    if (toMemberId) return Promise.resolve();
    const now = Date.now();
    if (now - this.lastTypingSent < 4000) return Promise.resolve();
    this.lastTypingSent = now;
    return this.request(this.path("/typing"), { method: "POST", data: {} }).catch(() => {});
  }
  async reminders(request = null) {
    if (!this.session) return null;
    if (!this.ownsAccountSession()) { this.endAccess(); return null; }
    const generation = this.generation, session = this.session;
    try {
      const result = await this.request(this.path("/reminders"), request ? { method: "POST", data: request } : {});
      if (generation !== this.generation || session !== this.session) return null;
      if (!this.ownsResponse(result, session)) { this.endAccess(); return null; }
      return result;
    } catch (error) {
      if (generation !== this.generation || session !== this.session) return null;
      if (!this.ownsAccountSession()) { this.endAccess(); return null; }
      if ([401, 403].includes(error.status) || error.code === "session_binding_changed") this.handleFailure(error);
      throw error;
    }
  }
  // E4 moderation: POST reports a message (own receipt only); GET lists reports (owner only).
  async reports(request = null) {
    if (!this.session) return null;
    if (!this.ownsAccountSession()) { this.endAccess(); return null; }
    const generation = this.generation, session = this.session;
    try {
      const result = await this.request(this.path("/reports"), request ? { method: "POST", data: request } : {});
      if (generation !== this.generation || session !== this.session) return null;
      if (!this.ownsResponse(result, session)) { this.endAccess(); return null; }
      return result;
    } catch (error) {
      if (generation !== this.generation || session !== this.session) return null;
      if (!this.ownsAccountSession()) { this.endAccess(); return null; }
      if (error.status === 401 || error.code === "session_binding_changed") this.handleFailure(error);
      throw error;
    }
  }
  async humanPushConfig() {
    if (!this.session) return null;
    if (!this.ownsAccountSession()) { this.endAccess(); return null; }
    const generation = this.generation, session = this.session;
    try {
      const result = await this.request(this.path("/human-push"));
      if (generation !== this.generation || session !== this.session) return null;
      if (!this.ownsResponse(result, session)) { this.endAccess(); return null; }
      return result;
    } catch (error) {
      if (generation !== this.generation || session !== this.session) return null;
      if (error.code === "human_push_humans_only" || error.code === "push_not_configured") return null;
      if (!this.ownsAccountSession()) { this.endAccess(); return null; }
      if ([401, 403].includes(error.status) || error.code === "session_binding_changed") this.handleFailure(error);
      throw error;
    }
  }
  async saveHumanPush(subscription) {
    if (!this.session) return null;
    if (!this.ownsAccountSession()) { this.endAccess(); return null; }
    const generation = this.generation, session = this.session;
    const result = await this.request(this.path("/human-push"), { method: "POST", data: subscription });
    if (generation !== this.generation || session !== this.session) return null;
    if (!this.ownsResponse(result, session)) { this.endAccess(); return null; }
    return result;
  }
  async saveHumanPushPreferences(preferences) {
    if (!this.session) return null;
    if (!this.ownsAccountSession()) { this.endAccess(); return null; }
    const generation = this.generation, session = this.session;
    const result = await this.request(this.path("/human-push"), { method: "PATCH", data: { preferences } });
    if (generation !== this.generation || session !== this.session) return null;
    if (!this.ownsResponse(result, session)) { this.endAccess(); return null; }
    return result;
  }
  async notifications(before = null) {
    // B4: read-only feed; a 401/403 ends access exactly like the sibling reads.
    if (!this.session) return null;
    if (!this.ownsAccountSession()) { this.endAccess(); return null; }
    const generation = this.generation, session = this.session;
    try {
      const result = await this.request(this.path(`/notifications${before === null ? "" : `?before=${encodeURIComponent(before)}`}`));
      if (generation !== this.generation || session !== this.session) return null;
      if (!this.ownsResponse(result, session)) { this.endAccess(); return null; }
      return result;
    } catch (error) {
      if (generation !== this.generation || session !== this.session) return null;
      if (!this.ownsAccountSession()) { this.endAccess(); return null; }
      if ([401, 403].includes(error.status) || error.code === "session_binding_changed") this.handleFailure(error);
      throw error;
    }
  }
  async threadMutes() {
    // Per-thread mutes for the current member. Read-only list; 401/403 ends
    // access like the sibling reads.
    if (!this.session) return null;
    if (!this.ownsAccountSession()) { this.endAccess(); return null; }
    const generation = this.generation, session = this.session;
    try {
      const result = await this.request(this.path("/thread-mutes"));
      if (generation !== this.generation || session !== this.session) return null;
      if (!this.ownsResponse(result, session)) { this.endAccess(); return null; }
      return result;
    } catch (error) {
      if (generation !== this.generation || session !== this.session) return null;
      if (!this.ownsAccountSession()) { this.endAccess(); return null; }
      if ([401, 403].includes(error.status) || error.code === "session_binding_changed") this.handleFailure(error);
      throw error;
    }
  }
  async setThreadMute(threadId, muted) {
    // Mute or unmute a thread for the current member. Returns the resolved
    // { threadId, muted } (threadId is the thread root).
    if (!this.session) return null;
    if (!this.ownsAccountSession()) { this.endAccess(); return null; }
    const generation = this.generation, session = this.session;
    try {
      const result = await this.request(this.path("/thread-mutes"), { method: "POST", data: { threadId, muted } });
      if (generation !== this.generation || session !== this.session) return null;
      if (!this.ownsResponse(result, session)) { this.endAccess(); return null; }
      return result;
    } catch (error) {
      if (generation !== this.generation || session !== this.session) return null;
      if (!this.ownsAccountSession()) { this.endAccess(); return null; }
      if ([401, 403].includes(error.status) || error.code === "session_binding_changed") this.handleFailure(error);
      throw error;
    }
  }
  async needsAttention(cursor = null, { includeShadow = false } = {}) {
    // #662: owner-only rollup of everything awaiting an owner decision.
    // 403 owner_required means the viewer is not the owner — not a failure.
    if (!this.session) return null;
    if (!this.ownsAccountSession()) { this.endAccess(); return null; }
    const generation = this.generation, session = this.session;
    try {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      if (includeShadow) params.set("includeShadow", "true");
      const result = await this.request(this.path(`/needs-attention${params.size ? `?${params}` : ""}`));
      if (generation !== this.generation || session !== this.session) return null;
      if (!this.ownsResponse(result, session)) { this.endAccess(); return null; }
      return result;
    } catch (error) {
      if (generation !== this.generation || session !== this.session) return null;
      if (!this.ownsAccountSession()) { this.endAccess(); return null; }
      if (error.status === 403 && error.code === "owner_required") return null;
      if ([401].includes(error.status) || error.code === "session_binding_changed") this.handleFailure(error);
      throw error;
    }
  }
  async roomRead(path) {
    // Attention: guarded GET for room-scoped reads (activity feed, read
    // horizons, saved messages). Session and ownership guards mirror the
    // notifications/needs-attention readers above.
    if (!this.session) return null;
    if (!this.ownsAccountSession()) { this.endAccess(); return null; }
    const generation = this.generation, session = this.session;
    try {
      const result = await this.request(this.path(path));
      if (generation !== this.generation || session !== this.session) return null;
      if (!this.ownsResponse(result, session)) { this.endAccess(); return null; }
      return result;
    } catch (error) {
      if (generation !== this.generation || session !== this.session) return null;
      if (!this.ownsAccountSession()) { this.endAccess(); return null; }
      if ([401, 403].includes(error.status) || error.code === "session_binding_changed") this.handleFailure(error);
      throw error;
    }
  }
  async roomWrite(path, data, method = "POST") {
    // Attention: guarded write for room-scoped attention endpoints.
    if (!this.session) return null;
    if (!this.ownsAccountSession()) { this.endAccess(); return null; }
    const generation = this.generation, session = this.session;
    try {
      const result = await this.request(this.path(path), { method, data });
      if (generation !== this.generation || session !== this.session) return null;
      if (!this.ownsResponse(result, session)) { this.endAccess(); return null; }
      return result;
    } catch (error) {
      if (generation !== this.generation || session !== this.session) return null;
      if (!this.ownsAccountSession()) { this.endAccess(); return null; }
      if ([401, 403].includes(error.status) || error.code === "session_binding_changed") this.handleFailure(error);
      throw error;
    }
  }
  activity({ before = null, limit = 50, type = null } = {}) {
    const query = new URLSearchParams();
    if (before !== null && before !== undefined) query.set("before", String(before));
    if (limit !== 50) query.set("limit", String(limit));
    if (type) query.set("type", type);
    const suffix = query.size ? `/activity?${query}` : "/activity";
    return this.roomRead(suffix);
  }
  activityUnreadCount() {
    return this.roomRead("/activity-unread-count");
  }
  markActivityRead(ids) {
    return this.roomWrite("/activity-read", { ids });
  }
  markActivityReadAll(type = null) {
    return this.roomWrite("/activity-read-all", type ? { type } : {});
  }
  readHorizon(threadId = "") {
    return this.roomRead(threadId ? `/read-horizon?threadId=${encodeURIComponent(threadId)}` : "/read-horizon");
  }
  setReadHorizon(threadId, lastReadMessageId) {
    return this.roomWrite("/read-horizon", { threadId: threadId ?? "", lastReadMessageId });
  }
  savedList() {
    return this.roomRead("/saved");
  }
  setSaved(messageId, saved) {
    return this.roomWrite("/saved", { messageId, saved });
  }
  unsaveMessage(messageId) {
    return this.roomWrite(`/saved/${encodeURIComponent(messageId)}`, {}, "DELETE");
  }
  async charter(revision) {
    if (!this.session) return null;
    if (!this.ownsAccountSession()) { this.endAccess(); return null; }
    const generation = this.generation, session = this.session;
    try {
      const value = await this.request(this.path(`/charter${revision === undefined ? "" : `?revision=${revision}`}`));
      if (generation !== this.generation || session !== this.session) return null;
      if (!this.ownsResponse(value, session)) { this.endAccess(); return null; }
      validateCharterRead(value, session.roomId, revision);
      return value;
    } catch (error) {
      if (generation !== this.generation || session !== this.session) return null;
      if (!this.ownsAccountSession()) { this.endAccess(); return null; }
      if ([401, 403].includes(error.status) || error.code === "session_binding_changed") this.handleFailure(error);
      throw error;
    }
  }
  async workResult(workItemId, { completionEventId = null, draftMessageId = null } = {}) {
    if (!this.session) return null;
    if (!this.ownsAccountSession()) { this.endAccess(); return null; }
    const generation = this.generation, session = this.session, params = new URLSearchParams({ workItemId });
    if (completionEventId !== null) params.set("completionEventId", completionEventId);
    if (draftMessageId !== null) params.set("draftMessageId", draftMessageId);
    try {
      const value = await this.request(this.path(`/work-result?${params}`));
      if (generation !== this.generation || session !== this.session) return null;
      if (!this.ownsResponse(value, session)) { this.endAccess(); return null; }
      await verifyWorkResult(value, { roomId: session.roomId, workItemId, completionEventId, draftMessageId });
      if (generation !== this.generation || session !== this.session) return null;
      if (!this.ownsAccountSession()) { this.endAccess(); return null; }
      return value;
    } catch (error) {
      if (generation !== this.generation || session !== this.session) return null;
      if (!this.ownsAccountSession()) { this.endAccess(); return null; }
      if ([401, 403].includes(error.status) || error.code === "session_binding_changed") this.handleFailure(error);
      throw error;
    }
  }
  // C2: one read-only GET of the selected-work view, used to preview what an agent
  // can access before a run. It never starts, claims or acknowledges anything.
  async workContext(workItemId) {
    if (!this.session) return null;
    if (!this.ownsAccountSession()) { this.endAccess(); return null; }
    const generation = this.generation, session = this.session;
    try {
      const value = await this.request(this.path(`/work-context?${new URLSearchParams({ workItemId })}`));
      if (generation !== this.generation || session !== this.session) return null;
      if (!this.ownsResponse(value, session)) { this.endAccess(); return null; }
      verifyAccessSummary(value, { roomId: session.roomId, workItemId });
      return value;
    } catch (error) {
      if (generation !== this.generation || session !== this.session) return null;
      if (!this.ownsAccountSession()) { this.endAccess(); return null; }
      if ([401, 403].includes(error.status) || error.code === "session_binding_changed") this.handleFailure(error);
      throw error;
    }
  }
  // Return brief: history fixed through H (frozen on the first page, continuations carry it),
  // current live through N. Fetching never acknowledges; only caughtUp() does, explicitly.
  async returnBrief({ horizon = null, after = null, cursor = null, limit = null } = {}) {
    if (this.session?.authMode === "account" && !this.ownsAccountSession()) { this.endAccess(); return null; }
    const generation = this.generation, session = this.session;
    const params = new URLSearchParams();
    if (horizon !== null) { params.set("horizon", horizon); params.set("after", after); params.set("cursor", cursor); }
    if (limit !== null) params.set("limit", limit);
    const query = params.toString();
    const brief = await this.request(this.path(`/return-brief${query ? `?${query}` : ""}`));
    if (generation !== this.generation || this.session !== session) return null;
    if (!this.ownsResponse(brief, session)) {
      this.endAccess();
      return null;
    }
    return brief;
  }
  connect() {
    clearTimeout(this.streamRetry); this.streamRetry = null;
    clearTimeout(this.refreshRetry); this.refreshRetry = null;
    this.stream?.close();
    if (!this.events || !this.session) { this.onStatus("Manual refresh available; live updates unavailable"); return; }
    if (this.session.authMode === "account" && !this.ownsAccountSession()) { this.endAccess(); return; }
    const generation = this.generation, session = this.session;
    // Resume from the last FULL read, not the newest windowed one: a windowed read
    // can pass an event (an edit of an older message) that it did not carry, and
    // the stream must replay that event so it triggers its own full read.
    // Only a window is held: the background fill reads everything, so resume from the newest.
    const heldNow = this.heldMessages();
    const resumeAfter = heldNow && !heldNow.partial ? heldNow.fullSequence : this.sequence;
    const stream = new this.events(`${this.path("/stream")}?after=${resumeAfter}${this.session.authMode === "account" ? `&auth=account&binding=${encodeURIComponent(this.session.sessionBinding)}` : ""}`);
    this.stream = stream;
    const ownsStream = () => this.stream === stream && this.generation === generation && this.session === session;
    const markRecovered = () => {
      if (!ownsStream() || !this.refreshInterrupted) return;
      this.refreshInterrupted = false;
      clearTimeout(this.refreshRetry); this.refreshRetry = null;
      this.refreshRetryDelay = 1000;
      this.onStatus(CONNECTED_STATUS);
    };
    const refreshStream = (receipt, options) => this.refresh(receipt, options).then(value => {
      markRecovered();
      return value;
    }, error => { if (ownsStream()) this.handleFailure(error); });
    stream.addEventListener("open", () => {
      if (!ownsStream()) return;
      this.streamRetryDelay = 1000;
      this.refreshRetryDelay = 1000;
      clearTimeout(this.refreshRetry); this.refreshRetry = null;
      this.refreshInterrupted = false;
      this.onStatus(CONNECTED_STATUS);
      refreshStream(null, { revalidate: true });
    });
    stream.addEventListener("room-event", message => {
      if (!ownsStream()) return;
      let receipt;
      try { receipt = JSON.parse(message.data); } catch { /* Unknown notifications still force a read. */ }
      // Consent state is not part of the room projection, so a snapshot render
      // alone cannot refresh it; the panel refetches on a consent change.
      if (receipt?.event?.type === "dm.consent_changed") this.onConsentChange?.();
      refreshStream(receipt);
    });
    stream.addEventListener("typing", message => {
      if (!ownsStream()) return;
      try {
        const parsed = JSON.parse(message.data);
        if (Array.isArray(parsed.typists)) this.onTyping(parsed.typists);
      } catch { /* Malformed typing payloads are ignored. */ }
    });
    stream.addEventListener("access-ended", () => { if (ownsStream()) this.endAccess(); });
    stream.addEventListener("error", () => {
      if (!ownsStream()) return;
      this.onStatus("Reconnecting · displayed history may be stale");
      refreshStream(null, { revalidate: true });
      // Native retry handles CONNECTING, but HTTP refusals leave EventSource CLOSED.
      // Replace only that stream, with backoff and the same session ownership.
      if (ownsStream() && stream.readyState === 2 && !this.streamRetry) {
        this.streamRetry = setTimeout(() => {
          this.streamRetry = null;
          if (ownsStream()) this.connect();
        }, this.streamRetryDelay + Math.random() * this.streamRetryDelay / 4);
        this.streamRetryDelay = Math.min(this.streamRetryDelay * 2, 30000);
      }
    });
  }
  handleFailure(error) {
    if ([401, 403].includes(error.status) || (this.session?.authMode === "account" && error.code === "session_binding_changed")) {
      this.endAccess();
      return;
    }
    this.onStatus("Connection interrupted · refresh to recover; no peer activity inferred");
    // A closed stream already reconnects. An open stream does not, so a failed
    // follow-up read would otherwise stay stale until some later event.
    if (!this.stream || this.stream.readyState !== 1 || this.refreshRetry) return;
    this.refreshInterrupted = true;
    const delay = this.refreshRetryDelay || 1000;
    this.refreshRetry = setTimeout(() => {
      this.refreshRetry = null;
      if (!this.stream || this.stream.readyState !== 1 || !this.session) return;
      this.refresh(null, { revalidate: true }).then(() => {
        if (!this.stream || this.stream.readyState !== 1 || !this.session) return;
        this.refreshInterrupted = false;
        this.refreshRetryDelay = 1000;
        this.onStatus(CONNECTED_STATUS);
      }).catch(retryError => {
        if (this.stream && this.stream.readyState === 1 && this.session) this.handleFailure(retryError);
      });
    }, delay + Math.random() * delay / 4);
    this.refreshRetryDelay = Math.min(delay * 2, 30000);
  }
  disconnect() {
    this.generation++; clearTimeout(this.streamRetry); this.streamRetry = null; this.streamRetryDelay = 1000;
    clearTimeout(this.refreshRetry); this.refreshRetry = null; this.refreshRetryDelay = 1000;
    clearTimeout(this.fillTimer); this.fillTimer = null; this.fillDelay = 1000;
    this.refreshInterrupted = false;
    this.stream?.close(); this.stream = null;
  }
  endAccess() { this.disconnect(); this.session = null; this.sequence = 0; this.accountOwnership = null; this.onAccessEnded(); }
}

// The explicit name documents the legacy room-key session transport while RoomClient
// remains the stable public name used by the current application.
export { RoomClient as RoomSessionClient };

// Retain the ID for an unchanged retry, never blindly replay a changed revision or payload.
// Unknown commits stay locked across pre-ledger refusals (including rate/size
// limits). Only a rejection after exact retry lookup resolves an unknown original.
export function retryUnconfirmed(error, wasUnconfirmed = false) {
  const scopeRejected = (error.status === 409 && error.code === "claim_conflict")
    || (error.status === 422 && error.code === "invalid_claim_scope");
  const rejected = error.status >= 400 && error.status < 500
    && ["command_rejected", "invalid_command", "invalid_cause", "pilot_limit", "too_large"].includes(error.code);
  const originalRejected = ([409, 422].includes(error.status) && error.code === "command_rejected")
    || (error.status === 422 && error.code === "invalid_cause") || (error.status === 409 && error.code === "pilot_limit");
  return !(scopeRejected || (wasUnconfirmed ? originalRejected : rejected));
}

export function draftCommand(previous, type, data, causationId = null) {
  const contents = JSON.stringify({ type, data, causationId });
  return previous?.contents === contents ? previous : { contents, command: { id: crypto.randomUUID(), type, data, ...(causationId ? { causationId } : {}) } };
}
