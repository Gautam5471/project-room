import { publicJoinInviteHref } from "./room-deep-link.js";
import { parseShareInviteCode } from "./share-invite-code.js";
import { canInviteMembers } from "./events.js";

// Kept in this module so the browser asset list does not need a new file.
export function inviteMessage(title) {
  const name = typeof title === "string" && title.trim() ? title.trim() : "this room";
  return `Join me in ${name}. People and agents work in the same room.\n{url}`;
}

export function deadInviteCopy() {
  return {
    title: "This invite has ended",
    scope: "Unable to open this invitation. Ask the person who invited you for a fresh link.",
    status: "This invite is unavailable. Sign in and request access.",
  };
}

export function rewardLine(reward) {
  if (!reward || typeof reward.tier !== "string") return "";
  const credits = (reward.credits ?? 0) + (reward.welcomeCredit ?? 0);
  const next = reward.next ? ` · ${reward.next.remaining} to ${reward.next.name}` : "";
  const active = reward.activeCount ?? 0;
  return `${reward.tier} · ${active} active · ${credits} room credit${credits === 1 ? "" : "s"}${next}`;
}
// Invite copy uses publicJoinInviteHref (origin + /room path). Never `${location.origin}/#join/`.

const $ = selector => document.querySelector(selector);
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
// Legacy aliases are accepted only to recover previously issued invitations.
const validInvitation = value => typeof value === "string" && (tokenPattern.test(value) || Boolean(parseShareInviteCode(value)));

// Human #join/ links must keep the app path. `location.origin` alone drops `/room`
// on www.getdasha.com and produces an incomplete join URL.
export function humanJoinShareBase(locationLike = globalThis.location) {
  const origin = locationLike?.origin ?? "";
  const path = String(locationLike?.pathname ?? "").replace(/\/index\.html$/, "").replace(/\/$/, "") || "";
  return `${origin}${path}`;
}

export function humanJoinShareUrl(token, purposePath = "", locationLike = globalThis.location) {
  return `${humanJoinShareBase(locationLike)}/#join/${token}${purposePath}`;
}

export function consumeJoinFragment() {
  if (location.hash.startsWith("#code/")) {
    const formatted = parseShareInviteCode(location.hash);
    history.replaceState(history.state, "", location.pathname + location.search);
    return { token: formatted || null, focus: null };
  }
  if (!location.hash.startsWith("#join/")) return null;
  const value = location.hash.slice(6);
  history.replaceState(history.state, "", location.pathname + location.search);
  // Optional purpose: #join/<token>/<kind>/<id> points the guest at the question or
  // result they were invited to open. This is a navigation hint, not an access
  // boundary: accepting the invitation still grants the documented room access.
  const segments = value.split("/");
  let focus = null;
  if (segments.length === 3 && ["work", "message"].includes(segments[1])) {
    try { focus = { kind: segments[1], id: decodeURIComponent(segments[2]) }; } catch { focus = null; }
  }
  const accepted = validInvitation(segments[0]) ? segments[0] : null;
  return { token: accepted, focus };
}
const newToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const date = value => new Date(value).toLocaleString();

export function formatShareInvitation(note, url) {
  if (typeof note !== "string" || note.length > 600 || !url) return "";
  return note.trim() ? `${note.trim()}\n\n${url}` : url;
}

export function setShareLinkStatus(element, text) {
  element.textContent = text;
  element.classList.toggle("visible", Boolean(text));
}

const interrupted = error => error?.name === "AbortError" || error?.name === "TimeoutError" || error instanceof TypeError;
const changedJoinSession = error => ["csrf_denied", "session_binding_changed", "stale_session_revision", "account_session_required"].includes(error?.code);
export const canRetryInvitation = error => interrupted(error) || error?.status === 429 || error?.status >= 500;
// Raw transport text ("signal is aborted without reason", "Unexpected token '<'") is not a user message.
export function requestFailureMessage(error) {
  return interrupted(error) || error instanceof SyntaxError ? "The connection was interrupted and the result could not be confirmed" : error.message;
}
export function invitationFailureMessage(error) {
  if (interrupted(error)) {
    return "The connection was interrupted. We could not confirm the result. Your entries are kept; try again here to check or finish the same request.";
  }
  return error.message;
}

export function invitationManagementFailureMessage(error, operation) {
  if (!interrupted(error)) return error.message;
  if (operation === "list") return "The connection was interrupted. Close and reopen this window to reload invitation links.";
  if (operation === "cancel") return "The connection was interrupted. We could not confirm cancellation. Try cancelling this same link again to check or finish it.";
  return invitationFailureMessage(error);
}

const UNCERTAIN_JOIN_KEY = "room.guestJoin.uncertain.v1";
const UNCERTAIN_JOIN_TTL_MS = 12 * 3600 * 1000;
// A join POST whose response is lost leaves the outcome unknown: the server may
// have committed the membership (and bumped the session revision/CSRF), so a
// reload must be able to recover the *same* request idempotently. The redemption
// record is persisted optimistically *before* the POST and cleared on any
// confirmed outcome (success or a definitive rejection).
export function readUncertainJoin(storage = globalThis.localStorage, now = Date.now()) {
  try {
    const raw = storage?.getItem(UNCERTAIN_JOIN_KEY);
    if (!raw) return null;
    const record = JSON.parse(raw);
    if (!record || typeof record !== "object" || !validInvitation(record.linkToken)
      || typeof record.redemptionId !== "string" || typeof record.displayName !== "string"
      || !Number.isSafeInteger(record.at) || now - record.at > UNCERTAIN_JOIN_TTL_MS) return null;
    return record;
  } catch { return null; }
}
export function writeUncertainJoin(record, storage = globalThis.localStorage) {
  try {
    storage?.setItem(UNCERTAIN_JOIN_KEY, JSON.stringify({ linkToken: record.linkToken, redemptionId: record.redemptionId,
      displayName: record.displayName, roomId: record.roomId ?? null, roomTitle: record.roomTitle ?? null, at: Date.now() }));
  } catch { /* private-mode writes may throw; the join still proceeds */ }
}
export function clearUncertainJoin(storage = globalThis.localStorage) {
  try { storage?.removeItem(UNCERTAIN_JOIN_KEY); } catch { /* ignore */ }
}

export async function reuseVisibleRoom(client, roomId, visibleSession) {
  if (!visibleSession || visibleSession !== client.session || visibleSession.roomId !== roomId) return null;
  const generation = client.generation;
  // Revalidate the identity actually shown in the Room, not an older account cookie
  // left by another sign-in mode. Existing access needs no invitation redemption.
  await client.refresh();
  if (client.generation !== generation || client.session !== visibleSession) throw new Error("Your room identity changed. Close and review the invitation again.");
  return { roomId, roomMode: visibleSession.authMode !== "account", session: visibleSession, duplicate: true };
}

export function installShareLinks({ client, accountClient, getState, getSession, openRoom,
  listPurposes = () => [], onJoinedRoom = null, onAccountSignin = () => {}, onOAuthStart = () => {}, canLeaveAccountSignin = () => true,
  setConnectionStatus = text => { $("#connection-status").textContent = text; } }) {
  let managementVersion = 0, listVersion = 0, joinVersion = 0, joinSecret = null, redemptionId = null, joining = false, pendingCreate = null;
  let joinFocus = null;
  let needsSessionReview = false, reviewedSession = null;
  let joined = null, previewRoomId = null, previewRoomTitle = null;
  let joinAttempted = false, joinLanded = false, suppressJoinHash = false;
  let managementSession = null, managementGeneration = null, currentLink = null, expiryTimer = null, copyRevision = 0, copying = false;
  let kitOnly = false;
  const manager = $("#share-link-dialog"), joinDialog = $("#join-link-dialog");
  const status = text => setShareLinkStatus($("#share-link-status"), text);
  const listStatus = text => setShareLinkStatus($("#share-management-status"), text);
  const joinStatus = text => setShareLinkStatus($("#join-link-status"), text);
  // Invite signup follow-ups (#2318, auth audit A20). After someone creates an
  // account from the join dialog, the sign-in form moves back to the hidden
  // auth panel, so its "Check your email" status was never seen. The dialog
  // now asks the server for the account's own email state, says so itself,
  // offers a resend whose link keeps this invitation, and fills the name.
  const resendButton = () => {
    let button = $("#join-verify-resend");
    if (!button) {
      button = document.createElement("button");
      button.type = "button"; button.id = "join-verify-resend"; button.className = "text-button"; button.hidden = true;
      button.textContent = "Send a new code";
      $("#join-link-status").after(button);
      button.addEventListener("click", resendVerification);
    }
    return button;
  };
  async function resendVerification() {
    const button = resendButton(), version = joinVersion;
    if (!joinSecret || button.disabled) return;
    button.disabled = true;
    try {
      const session = accountClient.currentSession("sending a verification code", { authenticated: true });
      const reply = await accountClient.request("/api/auth/email/verify/resend", { method: "POST", session,
        data: { returnTo: `/${shareLinksPendingFragment()}` } });
      if (version !== joinVersion) return;
      joinStatus(reply?.status === "resent" ? "A new code is on its way. It can take a minute to arrive; check spam too."
        : reply?.status === "already_verified" ? "Your email is already verified." : "We couldn\u2019t send the email just now. Try again in a minute.");
      if (reply?.status === "already_verified") button.hidden = true;
    } catch (error) {
      if (version === joinVersion) joinStatus(error?.message || "Could not send a new code.");
    } finally { button.disabled = false; }
  }
  const shareLinksPendingFragment = () => `#join/${joinSecret}${joinFocus ? `/${joinFocus.kind}/${encodeURIComponent(joinFocus.id)}` : ""}`;
  async function applyAccountDefaults(version) {
    let session;
    try { session = accountClient.currentSession("joining this room", { authenticated: true }); } catch { return; }
    const [methods, profile] = await Promise.all([
      accountClient.request("/api/auth/methods", { session }).catch(() => null),
      accountClient.request("/api/account/profile", { session }).catch(() => null)]);
    if (version !== joinVersion || joining) return;
    const email = (methods?.methods ?? []).map(method => method.email).find(Boolean) ?? "";
    const name = $("#join-link-name");
    const suggested = (typeof profile?.displayName === "string" && profile.displayName.trim()) || email.split("@")[0] || "";
    if (name && !name.value.trim() && suggested) name.value = suggested.slice(0, 80);
    if (methods?.emailVerification?.status === "unverified" && methods?.providers?.mail?.configured) {
      joinStatus("Check your email for a verification code. You can join now and verify later.");
      resendButton().hidden = false;
    }
  }
  function syncAccountSigninBusy() {
    const pending = joining || !canLeaveAccountSignin();
    joinDialog.setAttribute("aria-busy", String(pending));
    for (const control of joinDialog.querySelectorAll("button,input")) control.disabled = pending;
    $("#join-account-google").setAttribute("aria-disabled", String(pending));
  }
  function joinBusy(value) { joining = value; syncAccountSigninBusy(); }
  const member = () => getState()?.members[getSession()?.member.id];
  const canManage = () => {
    const current = member();
    return Boolean(current && current.active !== false && (current.id === getState()?.room?.ownerId
      || current.permissions.includes("manage_members") && (current.kind === "human" || current.delegatedAdmin === true)));
  };
  // The join POST's response can be lost *after* the server committed the join
  // (which also bumps the slot revision and CSRF token). A naive retry with the
  // stale session would 403, so: restore the session first, then re-issue the
  // *same* redemption id. The server resolves it idempotently — a committed join
  // returns the credential (duplicate), a never-started join runs for real, and
  // the guest can never be joined twice. Errors carry `uncertainJoin` when the
  // outcome could not be determined either way.
  async function attemptJoin({ linkToken, displayName, redemptionId }) {
    const uncertain = error => { error.uncertainJoin = true; return error; };
    try {
      return await accountClient.joinShareLink({ linkToken, displayName, redemptionId });
    } catch (error) {
      if (error.code === "join_session_lost") throw uncertain(error);
      if (!canRetryInvitation(error)) throw error;
      try { await accountClient.restore(); }
      catch { throw uncertain(error); } // restore failed: the join outcome is still unknown
      try {
        return await accountClient.joinShareLink({ linkToken, displayName, redemptionId });
      } catch (retryError) {
        throw canRetryInvitation(retryError) || retryError.code === "join_session_lost" ? uncertain(retryError) : retryError;
      }
    }
  }
  function joinFailureStatus(error) {
    if (changedJoinSession(error)) return "Your browser session changed, possibly because another tab joined. Review the current browser session before continuing. You do not need to create an account.";
    const room = previewRoomTitle ? `“${previewRoomTitle}”` : "the room";
    if (error?.code === "join_session_lost") return invitationFailureMessage(error);
    if (error?.uncertainJoin) {
      return `The connection was interrupted and we couldn't confirm whether you joined ${room}. ` +
        `Your invitation is kept — reopen it (or reload this page) and we'll check whether your join went through. You can't be joined twice.`;
    }
    return invitationFailureMessage(error);
  }
  const ownsManagement = () => managementSession && managementSession === getSession()
    && managementGeneration === client.generation && managementSession === client.session && client.ownsAccountSession() && canManage();
  const managementCurrent = (version, generation) => version === managementVersion && generation === client.generation && manager.open && ownsManagement();
  const escHtml = value => value.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  function refreshPurposes() {
    const select = $("#share-link-purpose"), previous = select.value;
    const items = listPurposes();
    select.innerHTML = `<option value="">Whole room</option>` + items.map(p =>
      `<option value="${escHtml(p.id)}">${p.done ? "Result" : "Question"} · ${escHtml(p.title)}</option>`).join("");
    select.value = items.some(p => p.id === previous) ? previous : "";
  }
  function updateCopyControls() {
    $("#share-link-copy").disabled = copying || !currentLink;
    $("#share-note-copy").disabled = copying || !currentLink || !$("#share-note-text").value.trim()
      || !$("#share-note-preview").value;
  }
  function clearResult(message = "") {
    const heldFocus = $("#share-link-result").contains(document.activeElement);
    copyRevision++; currentLink = null; clearTimeout(expiryTimer); expiryTimer = null;
    $("#share-link-url").value = ""; delete $("#share-link-url").dataset.linkId;
    $("#share-note-text").value = ""; $("#share-note-preview").value = "";
    $("#share-note").open = false; $("#share-note-result").hidden = true;
    $("#share-purpose-note").hidden = true;
    $("#share-link-result").hidden = true; $("#share-link-form").hidden = false;
    status(message); updateCopyControls();
    if (heldFocus && manager.open && ownsManagement()) $("#share-link-create").focus();
  }
  function checkResult() {
    if (currentLink && (currentLink.expiresAt <= Date.now() || currentLink.memberRevision !== member()?.revision)) {
      clearResult("This link is no longer active. Create a new link.");
    }
    return currentLink;
  }
  function managementError(error) {
    // email_unverified is a 403 about the account, not a changed session: keep the
    // dialog and show the server's "Verify your email" message instead of
    // claiming the invitation access changed.
    if (error?.code !== "email_unverified" && [401, 403].includes(error?.status) || ["session_binding_changed", "session_binding_required", "invalid_session_binding"].includes(error?.code)) {
      resetManagement(); setConnectionStatus("Invitation access changed. Reopen the room before inviting.");
    }
  }
  function updateLimits() {
    const hours = Number($("#share-link-expiry").value), limit = Number($("#share-link-limit").value);
    const duration = hours === 168 ? "7 days" : `${hours} ${hours === 1 ? "hour" : "hours"}`;
    $("#share-settings-summary").textContent = `${duration} · ${Number.isInteger(limit) && limit >= 1 && limit <= 25 ? `${limit} ${limit === 1 ? "guest" : "guests"}` : "Choose a guest limit"}`;
  }
  let creating = false;
  function creationBusy(value) {
    creating = value;
    // The close control is held too: dismissing mid-request would orphan a shown-once link.
    for (const id of ["share-link-create", "share-link-expiry", "share-link-limit", "share-link-close"]) $("#" + id).disabled = value;
  }
  function updateSwitchWarning() {
    const currentRoom = getSession()?.roomId ?? getState()?.room?.id;
    $("#join-switch-warning").hidden = !previewRoomId || !(currentRoom ? currentRoom !== previewRoomId : accountClient.session?.authenticated);
  }
  const inRoom = () => {
    const current = member();
    return Boolean(current && current.active !== false && (getSession()?.roomId || getState()?.room?.id));
  };
  function refreshAgentCode() {
    const code = $("#growth-agent-code");
    if (!code) return;
    const state = getState();
    const id = getSession()?.member?.id;
    code.hidden = !(state && id && canInviteMembers(state, id));
  }
  function applyKitChrome() {
    const form = $("#share-link-form");
    const management = $("#share-management");
    if (management) management.hidden = kitOnly;
    if (!form) return;
    // A shown admin result owns the form. Snapshot sync must not put the form
    // back on screen over "Link copied."
    if (kitOnly) { form.hidden = true; return; }
    if ($("#share-link-result")?.hidden === false) return;
    form.hidden = false;
  }
  function renderKit(data) {
    const invite = data?.invite;
    const url = invite?.token ? humanJoinShareUrl(invite.token) : "";
    const message = invite?.message && url ? String(invite.message).replaceAll("{url}", url) : "";
    const urlField = $("#growth-invite-url");
    if (urlField) urlField.value = url;
    const messageField = $("#growth-invite-message");
    if (messageField) messageField.value = message;
    const rewardEl = $("#growth-reward");
    if (rewardEl) rewardEl.textContent = rewardLine(data?.reward);
    const copyLink = $("#growth-copy-link");
    const copyMessage = $("#growth-copy-message");
    if (copyLink) copyLink.disabled = !url;
    if (copyMessage) copyMessage.disabled = !message;
    const kitStatus = $("#growth-kit-status");
    if (kitStatus && data?.inviteBlocked === "email_unverified") kitStatus.textContent = "Verify your email to invite people. Open Sign-in & security from the account menu.";
    else if (kitStatus && invite && invite.status && invite.status !== "active") kitStatus.textContent = "This link has ended.";
    else if (kitStatus && !kitStatus.textContent) kitStatus.textContent = "";
  }
  async function loadKit() {
    const roomId = getSession()?.roomId || getState()?.room?.id;
    if (!roomId || typeof client?.request !== "function" || typeof client?.path !== "function") return;
    try {
      const data = await client.request(client.path("/referrals"), { method: "GET" });
      renderKit(data);
    } catch { /* The invite dialog still opens. */ }
  }
  async function copyGrowth(value, done) {
    const kitStatus = $("#growth-kit-status");
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      if (kitStatus) kitStatus.textContent = done;
    } catch {
      if (kitStatus) kitStatus.textContent = "Select and copy.";
    }
  }
  function ensureGrowthChrome() {
    if (typeof document.createElement !== "function") return;
    const title = $("#share-link-title");
    if (title) title.textContent = "Invite";
    const intro = $("#share-link-intro");
    if (intro) intro.textContent = "Share one link with people or AI agents. They land in this room.";
    if (!$("#growth-kit") && $("#share-link-dialog")) {
      const section = document.createElement("section");
      section.id = "growth-kit";
      section.className = "growth-kit";
      section.innerHTML = `<p id="growth-reward" class="growth-reward"></p>
        <label for="growth-invite-url">Your invite link</label>
        <input id="growth-invite-url" type="text" readonly autocomplete="off" spellcheck="false">
        <button id="growth-copy-link" class="button primary" type="button">Copy link</button>
        <label for="growth-invite-message">Message</label>
        <textarea id="growth-invite-message" rows="3" readonly autocomplete="off" spellcheck="false"></textarea>
        <button id="growth-copy-message" class="button" type="button">Copy message</button>
        <button id="growth-agent-code" class="button ghost" type="button" hidden>One-time agent code</button>
        <p id="growth-kit-status" class="form-status" role="status" aria-live="polite"></p>`;
      if (intro?.after) intro.after(section);
      else $("#share-link-dialog").append(section);
      $("#growth-copy-link")?.addEventListener("click", () => copyGrowth($("#growth-invite-url")?.value, "Link copied."));
      $("#growth-copy-message")?.addEventListener("click", () => copyGrowth($("#growth-invite-message")?.value, "Message copied."));
      $("#growth-agent-code")?.addEventListener("click", () => $("#invite-agents-button")?.click());
    }
    if (!$("#join-inviter-line") && $("#join-link-scope")) {
      const line = document.createElement("p");
      line.id = "join-inviter-line";
      line.className = "growth-inviter";
      $("#join-link-scope").before(line);
    }
    refreshAgentCode();
  }
  function sync() {
    $("#invite-people-button").hidden = !(canManage() || inRoom());
    refreshAgentCode();
    applyKitChrome();
    if (manager.open && kitOnly) {
      const current = member();
      if (!current || current.active === false) { kitOnly = false; manager.close(); return; }
    } else if (manager.open && !ownsManagement()) resetManagement();
    else checkResult();
    if (joinDialog.open) updateSwitchWarning();
  }
  function resetManagement() {
    managementVersion++; listVersion++; pendingCreate = null;
    managementSession = null; managementGeneration = null; clearResult();
    $("#share-settings").open = false; $("#share-management").open = false;
    $("#share-link-list").replaceChildren(); status(""); listStatus("");
    creationBusy(false); updateLimits();
    if (manager.open) manager.close();
    sync();
  }
  async function list(version, generation, confirmed = "") {
    const sequence = ++listVersion;
    listStatus(confirmed || "Loading links…");
    try {
    const result = await client.request(client.path("/share-links"));
    if (!managementCurrent(version, generation)) { sync(); return; }
    if (sequence !== listVersion) return;
    if (currentLink && result.links.some(link => link.id === currentLink.id && link.status !== "active")) {
      clearResult("This link is no longer active. Create a new link.");
    }
    const items = result.links.map(link => {
      const li = document.createElement("li"), text = document.createElement("p");
      li.dataset.linkId = link.id;
      const kind = link.access === "co_admin" ? "Co-admin" : link.access === "member" ? "Member" : "Guest";
      const description = status => `${kind} · ${link.joins}/${link.maxJoins} joined · ${status.replaceAll("_", " ")} · expires ${date(link.expiresAt)}`;
      text.textContent = description(link.status);
      li.append(text);
      if (link.status === "active") {
        const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "button ghost";
        cancel.textContent = "Cancel link"; cancel.setAttribute("aria-label", `Cancel link created ${date(link.createdAt)}`);
        cancel.addEventListener("click", async () => {
          if (!managementCurrent(version, generation)) return;
          const heldFocus = document.activeElement === cancel;
          let cancelled = false;
          listVersion++; // A pre-cancellation read cannot restore an active row.
          if (currentLink?.id === link.id) clearResult();
          cancel.disabled = true;
          try {
            await client.request(client.path("/share-links-cancel"), { method: "POST", data: { linkId: link.id } });
            if (!managementCurrent(version, generation)) { sync(); return; }
            cancelled = true;
            cancel.textContent = "Cancelled";
            text.textContent = description("cancelled");
            await list(version, generation, "Link cancelled. Existing members keep their access.");
          } catch (error) { if (managementCurrent(version, generation) && !cancelled) { managementError(error); listStatus(invitationManagementFailureMessage(error, "cancel")); cancel.disabled = false; } else sync(); }
          finally {
            if (cancelled && heldFocus && managementCurrent(version, generation)
              && [document.body, cancel].includes(document.activeElement)) $("#share-management-summary").focus();
          }
        });
        li.append(cancel);
      }
      return li;
    });
    $("#share-link-list").replaceChildren(...items);
    if (!items.length) $("#share-link-list").textContent = "No invitation links yet.";
    listStatus(confirmed);
    } catch (error) {
      if (managementCurrent(version, generation) && sequence === listVersion) { managementError(error); listStatus(`${confirmed ? confirmed + " " : ""}${invitationManagementFailureMessage(error, "list")}`); }
      else sync();
      throw error;
    }
  }
  $("#invite-people-button").addEventListener("click", async () => {
    const admin = canManage();
    kitOnly = !admin;
    if (!admin) {
      if (!inRoom()) return;
      applyKitChrome();
      refreshAgentCode();
      manager.showModal();
      await loadKit();
      return;
    }
    resetManagement(); const version = ++managementVersion, generation = client.generation;
    managementSession = getSession(); managementGeneration = generation;
    if (!ownsManagement()) return;
    kitOnly = false;
    applyKitChrome();
    $("#share-local-note").hidden = !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
    refreshPurposes();
    refreshAgentCode();
    // Member and co-admin links are the room creator's to make.
    // Optional chrome: its absence must never keep the dialog from opening.
    const accessLabel = $("#share-link-access-label"), access = $("#share-link-access");
    if (accessLabel) accessLabel.hidden = getState()?.room?.ownerId !== getSession()?.member?.id;
    if (access) access.value = "guest";
    manager.showModal(); $("#share-link-create").focus();
    // Link-list feedback never owns the newer creation/clipboard status.
    await Promise.all([list(version, generation).catch(() => {}), loadKit()]);
  });
  $("#share-link-close").addEventListener("click", () => { if (!creating) manager.close(); });
  manager.addEventListener("cancel", event => { if (creating) event.preventDefault(); });
  manager.addEventListener("close", () => { resetManagement(); if (!$("#invite-people-button").hidden) $("#invite-people-button").focus(); });
  $("#share-link-another").addEventListener("click", () => {
    clearResult(); $("#share-link-create").focus();
  });
  $("#share-link-form").addEventListener("input", () => { pendingCreate = null; updateLimits(); });
  $("#share-link-form").addEventListener("invalid", event => {
    if ($("#share-settings").contains(event.target)) { $("#share-settings").open = true; event.target.focus(); }
  }, true);
  $("#share-link-form").addEventListener("submit", async event => {
    event.preventDefault(); const version = managementVersion, generation = client.generation;
    if (!managementCurrent(version, generation)) return;
    // The disabled button stops a native click, not a scripted or repeated submit.
    if (creating) return;
    const request = pendingCreate ||= { requestId: crypto.randomUUID(), linkToken: newToken(),
      expiresAt: Date.now() + Number($("#share-link-expiry").value) * 3600000,
      maxJoins: Number($("#share-link-limit").value), expectedMemberRevision: getState().members[getSession().member.id].revision,
      ...($("#share-link-access-label")?.hidden === false && $("#share-link-access")?.value && $("#share-link-access").value !== "guest" ? { access: $("#share-link-access").value } : {}) };
    creationBusy(true); status("Creating link…");
    try {
      const result = await client.request(client.path("/share-links"), { method: "POST", data: request });
      if (!managementCurrent(version, generation)) { sync(); return; }
      pendingCreate = null; // The owned response confirms this request's outcome.
      if (result.link.status !== "active") throw new Error("This link is no longer active. Create a new link.");
      clearResult();
      currentLink = { id: result.link.id, expiresAt: result.link.expiresAt, memberRevision: request.expectedMemberRevision };
      if (!checkResult()) return;
      const purposeItem = listPurposes().find(p => p.id === $("#share-link-purpose").value) ?? null;
      const inviteUrl = publicJoinInviteHref(request.linkToken, purposeItem ? `/work/${encodeURIComponent(purposeItem.id)}` : "")
        || humanJoinShareUrl(request.linkToken, purposeItem ? `/work/${encodeURIComponent(purposeItem.id)}` : "");
      $("#share-link-url").value = inviteUrl;
      $("#share-purpose-note").hidden = !purposeItem;
      if (purposeItem) $("#share-purpose-note").textContent = `Opens "${purposeItem.title}" after they join. Guests can read the room and its history, post messages, and react.`;
      if (result.link.access === "co_admin") { $("#share-purpose-note").hidden = false; $("#share-purpose-note").textContent = "Anyone who joins with this link gets full permissions. Share it only with people and agents you trust."; }
      else if (result.link.access === "member") { $("#share-purpose-note").hidden = false; $("#share-purpose-note").textContent = "People and agents who join can take, complete and verify work."; }
      $("#share-link-url").dataset.linkId = result.link.id;
      $("#share-link-result").hidden = false;
      $("#share-link-form").hidden = true;
      expiryTimer = setTimeout(checkResult, Math.max(0, currentLink.expiresAt - Date.now()));
      expiryTimer.unref?.();
      updateCopyControls();
      // Unlock the dialog before clipboard. A hanging writeText (or a test
      // stub that waits for finish) must not keep Create disabled.
      status("Link ready.");
      $("#share-link-copy").focus();
      creationBusy(false);
      list(version, generation).catch(() => {});
      const clipboard = globalThis.navigator?.clipboard;
      if (!copying && inviteUrl && clipboard?.writeText) {
        try {
          await clipboard.writeText(inviteUrl);
          if (managementCurrent(version, generation) && currentLink && $("#share-link-url").value === inviteUrl) {
            status("Link copied.");
          }
        } catch { /* Copy button remains */ }
      }
    } catch (error) { if (managementCurrent(version, generation)) { managementError(error); status(invitationManagementFailureMessage(error, "create")); } else sync(); }
    finally { if (managementCurrent(version, generation)) creationBusy(false); }
  });
  $("#share-note-text").addEventListener("input", () => {
    copyRevision++; status("");
    const note = $("#share-note-text").value;
    $("#share-note-preview").value = note.trim() ? formatShareInvitation(note, $("#share-link-url").value) : "";
    $("#share-note-result").hidden = !$("#share-note-preview").value;
    updateCopyControls();
  });
  $("#share-note").addEventListener("toggle", () => { copyRevision++; if (currentLink) status(""); });
  async function copy(withNote) {
    sync();
    const version = managementVersion, generation = client.generation;
    if (copying || !managementCurrent(version, generation) || !checkResult()) return;
    const field = $(withNote ? "#share-note-preview" : "#share-link-url"), value = field.value;
    if (!value || (withNote && (!$("#share-note").open || !$("#share-note-text").value.trim()))) return;
    const revision = ++copyRevision, link = currentLink, focus = document.activeElement;
    const currentResult = () => managementCurrent(version, generation) && checkResult() === link && revision === copyRevision
      && field.value === value && (!withNote || ($("#share-note").open && !$("#share-note-result").hidden));
    copying = true; updateCopyControls();
    status(withNote ? "Copying invitation…" : "Copying link…");
    try { await navigator.clipboard.writeText(value); if (currentResult()) status(withNote ? "Invitation copied." : "Link copied."); }
    catch {
      if (currentResult()) {
        if ([document.body, focus].includes(document.activeElement)) { field.focus(); field.select(); }
        status(withNote ? "Select and copy the preview above." : "Select and copy the link above.");
      }
    } finally { copying = false; sync(); updateCopyControls(); }
  }
  $("#share-link-copy").addEventListener("click", () => copy(false));
  $("#share-note-copy").addEventListener("click", () => copy(true));
  async function open(fragment, { afterSignIn = false } = {}) {
    if (!afterSignIn && !canLeaveAccountSignin()) { joinStatus("Finish signing in before opening another invitation."); return; }
    if (joining) { joinStatus("Finish the current join before opening another invitation."); return; }
    const retryHadFocus = document.activeElement === $("#join-link-retry");
    const version = ++joinVersion; joinSecret = fragment.token; redemptionId = crypto.randomUUID(); joined = null; joinFocus = fragment.focus ?? null; previewRoomId = null; previewRoomTitle = null;
    joinAttempted = false; joinLanded = false;
    needsSessionReview = false; reviewedSession = null;
    // Resume path (#657 defect 3): an earlier attempt with this token left an
    // uncertain redemption record. Reuse the SAME redemption id — never mint a
    // second join for it.
    const uncertain = readUncertainJoin();
    const resume = !fragment.reviewSession && uncertain && uncertain.linkToken === fragment.token ? uncertain : null;
    if (resume) redemptionId = resume.redemptionId;
    onAccountSignin(null);
    $("#join-account-choices").hidden = true; $("#join-account-auth").hidden = true;
    $("#join-link-form").reset(); $("#join-link-form").hidden = true;
    $("#shared-agent-details").hidden = true; $("#shared-agent-details").open = false; $("#shared-agent-instructions").value = "";
    $("#join-link-retry").hidden = true;
    $("#join-link-retry").textContent = "Retry";
    $("#join-access-details").open = false; $("#join-switch-warning").hidden = true;
    $("#join-link-permissions").textContent = ""; $("#join-link-expiry").textContent = "";
    $("#join-link-submit").textContent = "Join room"; $("#join-link-signout").hidden = true;
    $("#join-link-title").textContent = "Join this room"; $("#join-link-scope").textContent = "Checking your invitation…";
    const invitedBy = $("#join-inviter-line");
    if (invitedBy) invitedBy.textContent = "";
    joinStatus(""); resendButton().hidden = true; if (!joinDialog.open) joinDialog.showModal();
    if (!joinSecret) {
      $("#join-link-scope").textContent = "This invitation link is incomplete. Ask for a new link.";
      return;
    }
    if (!validInvitation(joinSecret)) {
      $("#join-link-scope").textContent = "This invitation is invalid. Ask for a new link.";
      return;
    }
    try {
      if (fragment.reviewSession && !await accountClient.restore()) throw new Error("Unable to confirm your browser session. Review it again.");
      if (version !== joinVersion) return;
      const { preview, session: account } = await accountClient.prepareShareLink(joinSecret);
      if (version !== joinVersion || !account) return;
      previewRoomId = preview.room.id; previewRoomTitle = preview.room.title;
      $("#join-link-title").textContent = `Join ${preview.room.title}`;
      const inviterLine = $("#join-inviter-line");
      if (inviterLine) inviterLine.textContent = preview.inviterDisplayName ? `${preview.inviterDisplayName} invited you.` : "";
      const returning = preview.link.status !== "active";
      $("#join-link-scope").textContent = returning ? "You already belong to this room. Open it without using another invitation place." : "Join the conversation. Everyone in the room can read your messages.";
      $("#join-link-permissions").textContent = preview.access;
      $("#join-link-expiry").textContent = `Invitation expires ${date(preview.link.expiresAt)} · ${preview.link.remainingJoins} places left.`;
      const sharedUrl = publicJoinInviteHref(joinSecret);
      $("#shared-agent-details").hidden = !sharedUrl;
      $("#shared-agent-instructions").value = sharedUrl ? `Join ${preview.room.title}: ${sharedUrl}\nDownload and verify the agent runtime from https://github.com/Uuriko/project-room/releases/latest (Node 24.19+). From its folder run:\nnode scripts/agent-inbox.mjs join ${JSON.stringify(sharedUrl)} ./room-connection --name "My agent"\nReview the destination and read/chat access, then repeat with --accept when authorized. Reuse room-connection to resume. Import the returned host configuration into your MCP client. A running host is required to answer requests.` : "";
      updateSwitchWarning();
      $("#join-account-choices").hidden = Boolean(account.authenticated) || Boolean(resume);
      $("#join-guest-note").hidden = Boolean(account.authenticated);
      const elevatedLink = preview.link.access && preview.link.access !== "guest";
      $("#join-link-submit").textContent = returning ? "Open room" : account.authenticated || elevatedLink ? "Join room" : "Continue as guest";
      const accessSummary = $("#join-access-details").querySelector?.("summary");
      if (accessSummary) accessSummary.textContent = elevatedLink ? (preview.link.access === "co_admin" ? "Co-admin access" : "Member access") : "Guest access";
      $("#join-link-form").hidden = false; $("#join-link-name").focus();
      if (account.authenticated && !resume && !fragment.reviewSession) await applyAccountDefaults(version);
      if (version !== joinVersion) return;
      // Signed out: sign-in comes first, with "Continue as guest" below it.
      // Member and co-admin links need an account, so they offer no guest path.
      const elevated = preview.link.access && preview.link.access !== "guest";
      $("#join-account-back").hidden = elevated;
      if (!account.authenticated && !resume && !fragment.reviewSession && !returning) {
        $("#join-account-choices").hidden = true; $("#join-account-back").hidden = true;
        $("#join-account-auth").hidden = false; onAccountSignin("magic");
        $("#join-link-form").hidden = elevated;
        if (elevated) $("#join-link-scope").textContent = "Sign in or create an account to join. This invitation gives you room permissions.";
        $("#join-account-google").focus();
      }
      if (fragment.reviewSession) {
        reviewedSession = account;
        const identity = account.account?.id;
        joinStatus(identity
          ? `Current browser identity: ${identity}. Choose “Confirm and continue” to join or open this room with this identity. Existing membership is reused; unsent drafts from another identity will not be carried over.`
          : "No signed-in identity is active. Choose “Confirm and continue” only if you want to join as a new guest and use an invitation place.");
        $("#join-link-submit").textContent = "Confirm and continue";
      }
      if (resume && version === joinVersion && !joining) {
        // The guest already consented to this exact request; its outcome is
        // unknown. Check whether it completed instead of asking them to re-join.
        $("#join-link-name").value = resume.displayName ?? "";
        performJoin({ resume: true });
      }
    } catch (error) {
      if (version !== joinVersion) return;
      if (resume && error.code === "link_unavailable") {
        // The earlier join may have consumed the final place. Preview refuses
        // new joins, but the authenticated idempotent replay can still recover it.
        previewRoomId = resume.roomId; previewRoomTitle = resume.roomTitle;
        $("#join-link-name").value = resume.displayName;
        $("#join-link-form").hidden = false;
        $("#join-link-scope").textContent = "Checking your earlier join…";
        await performJoin({ resume: true });
        return;
      }
      if (!resume && error?.code === "link_unavailable") {
        const dead = deadInviteCopy();
        $("#join-link-title").textContent = dead.title;
        $("#join-link-scope").textContent = dead.scope;
        $("#join-account-choices").hidden = false;
        $("#join-link-form").hidden = true;
        $("#join-link-retry").hidden = true;
        joinStatus(dead.status);
        return;
      }
      $("#join-link-scope").textContent = "Unable to open this invitation.";
      needsSessionReview = Boolean(fragment.reviewSession) || changedJoinSession(error);
      const retryable = needsSessionReview || canRetryInvitation(error);
      $("#join-link-retry").hidden = !retryable;
      $("#join-link-retry").textContent = needsSessionReview ? "Review browser session" : "Retry";
      joinStatus(interrupted(error) ? "Connection interrupted. Try again." : joinFailureStatus(error));
      if (retryable && retryHadFocus && [document.body, $("#join-link-retry")].includes(document.activeElement)) $("#join-link-retry").focus();
    }
  }
  for (const [id, mode] of [["#join-account-signin", "magic"]]) {
    $(id).addEventListener("click", () => {
      if (joining || !canLeaveAccountSignin()) return;
      $("#join-account-choices").hidden = true; $("#join-link-form").hidden = true;
      $("#join-account-auth").hidden = false;
      onAccountSignin(mode); $("#join-account-google").focus();
    });
  }
  $("#join-account-google").addEventListener("click", event => {
    if (joining || !canLeaveAccountSignin()) { event.preventDefault(); return; }
    onOAuthStart(event);
  });
  $("#join-link-name").addEventListener("invalid", () => joinStatus("Enter the name to show in this room."));
  $("#join-account-back").addEventListener("click", () => {
    if (joining || !canLeaveAccountSignin()) return;
    onAccountSignin(null); $("#join-account-auth").hidden = true;
    $("#join-account-choices").hidden = true; $("#join-link-form").hidden = false;
    $("#join-link-name").focus();
  });
  $("#shared-agent-copy").addEventListener("click", async () => {
    const field = $("#shared-agent-instructions"), value = field.value, version = joinVersion;
    if (!value || $("#shared-agent-details").hidden) return;
    try { await navigator.clipboard.writeText(value); if (version === joinVersion) joinStatus("Agent instructions copied."); }
    catch { if (version === joinVersion) { field.focus(); field.select(); joinStatus("Select and copy the agent instructions."); } }
  });
  $("#join-link-retry").addEventListener("click", () => {
    if (joinSecret && !joining && canLeaveAccountSignin()) return open({ token: joinSecret, focus: joinFocus, reviewSession: needsSessionReview });
  });
  async function performJoin({ resume = false } = {}) {
    if (joining || !canLeaveAccountSignin() || !joinSecret || needsSessionReview) return;
    const version = joinVersion, name = $("#join-link-name").value.trim(); let failed = false;
    joinBusy(true);
    joinStatus(joined ? "Opening room…" : resume ? "Checking whether your earlier join completed…" : "Joining room…");
    try {
      if (reviewedSession && accountClient.session !== reviewedSession) {
        throw Object.assign(new Error("Browser session changed"), { code: "session_binding_changed" });
      }
      if (!joined) {
        if (getState() && !reviewedSession) joined = await reuseVisibleRoom(client, previewRoomId, getSession());
        if (!joined) {
          if (!accountClient.session) await accountClient.restore();
          if (version !== joinVersion) return;
          // Optimistic persistence (#657 defect 3): record the request BEFORE
          // the POST. A lost response must not orphan the membership — a reload
          // resumes this exact request idempotently. Cleared on any confirmed
          // outcome; kept while the outcome is unknown.
          joinAttempted = true;
          writeUncertainJoin({ linkToken: joinSecret, redemptionId, displayName: name, roomId: previewRoomId, roomTitle: previewRoomTitle });
          try {
            joined = await attemptJoin({ linkToken: joinSecret, displayName: name, redemptionId });
          } catch (joinError) {
            if (!joinError.uncertainJoin) clearUncertainJoin();
            throw joinError;
          }
          clearUncertainJoin();
        }
        if (!joined) throw new Error("Your browser identity changed. Close and reopen the invitation.");
      }
      if (version !== joinVersion) return;
      try {
        await openRoom(joined.roomId, joined.roomMode === true, joined.session);
      } catch (openError) {
        if (!canRetryInvitation(openError)) throw openError;
        // "Open joined room" recovery (#657 defect 2): the join may have
        // landed while the room view or credential went stale. Recover the
        // credential through the idempotent join, then navigate for real.
        joinAttempted = true;
        joinStatus("Reconnecting to your joined room…");
        writeUncertainJoin({ linkToken: joinSecret, redemptionId, displayName: name, roomId: joined.roomId, roomTitle: previewRoomTitle });
        try {
          joined = await attemptJoin({ linkToken: joinSecret, displayName: name, redemptionId });
        } catch (joinError) {
          if (!joinError.uncertainJoin) clearUncertainJoin();
          throw joinError;
        }
        clearUncertainJoin();
        await openRoom(joined.roomId, joined.roomMode === true, joined.session);
      }
      if (version !== joinVersion) return;
      joinLanded = true;
      const focus = joinFocus; joinFocus = null;
      joinDialog.close();
      if (focus && onJoinedRoom) onJoinedRoom(focus);
      else $("#message-input").focus();
    } catch (error) {
      if (version !== joinVersion) return;
      failed = true;
      joinStatus(joinFailureStatus(error));
      if (changedJoinSession(error)) {
        needsSessionReview = true; reviewedSession = null; joined = null;
        $("#join-link-form").hidden = true;
        $("#join-account-choices").hidden = true;
        $("#join-link-retry").hidden = false;
        $("#join-link-retry").textContent = "Review browser session";
      }
      if (error.code === "join_session_lost") $("#join-account-choices").hidden = false;
      const lostGuest = error.code === "join_session_lost" && accountClient.session?.authenticated === false;
      $("#join-link-signout").hidden = error.code !== "guest_session_ended" && !lostGuest;
      $("#join-link-signout").textContent = lostGuest ? "Start a new guest (uses another place)" : "Log out of expired guest session";
      if (joined) $("#join-link-submit").textContent = "Open joined room";
    } finally {
      joinBusy(false);
      if (failed && version === joinVersion && joinDialog.open) $(needsSessionReview ? "#join-link-retry" : "#join-link-submit").focus();
    }
  }
  $("#join-link-form").addEventListener("submit", event => { event.preventDefault(); return performJoin(); });
  $("#join-link-signout").addEventListener("click", async () => {
    if (joining || !canLeaveAccountSignin()) return;
    const version = joinVersion;
    let failed = false;
    joinBusy(true); joinStatus("Signing out…");
    try {
      const restored = await accountClient.restore();
      if (version !== joinVersion || !joinDialog.open) return;
      if (!restored) throw new Error("Your browser identity changed. Try again to confirm sign-out.");
      if (restored.authenticated !== false || restored.account !== null) throw new Error("Your browser identity changed. Close and review the invitation again.");
      const signedOut = await accountClient.logout();
      if (version !== joinVersion || !joinDialog.open) return;
      if (signedOut?.authenticated !== false || signedOut.account !== null) throw new Error("Sign-out was not confirmed. Try again.");
      clearUncertainJoin();
      redemptionId = crypto.randomUUID(); $("#join-link-signout").hidden = true;
      joinStatus("Signed out. You can now join with a new guest identity.");
    } catch (error) {
      if (version === joinVersion) { failed = true; joinStatus(invitationFailureMessage(error)); }
    } finally {
      joinBusy(false);
      if (version === joinVersion && joinDialog.open) $(failed ? "#join-link-signout" : "#join-link-name").focus();
    }
  });
  $("#join-link-close").addEventListener("click", () => { if (!joining && canLeaveAccountSignin()) joinDialog.close(); });
  joinDialog.addEventListener("cancel", event => { if (joining || !canLeaveAccountSignin()) event.preventDefault(); });
  joinDialog.addEventListener("close", () => {
    onAccountSignin(null);
    joinVersion++;
    const pendingToken = joinSecret, pendingFocus = joinFocus, attempted = joinAttempted, landed = joinLanded, roomTitle = previewRoomTitle;
    joinSecret = null; redemptionId = null; joined = null; joinFocus = null; previewRoomId = null; previewRoomTitle = null;
    joinAttempted = false; joinLanded = false;
    $("#join-link-form").reset();
    $("#join-link-retry").hidden = true;
    if (pendingToken && attempted && !landed) {
      // #657 defect 4: never strand the guest on an unrelated page. The address
      // bar keeps the invitation, so reopening it (or reloading) resumes the
      // same join idempotently instead of landing on the fixtures inbox.
      suppressJoinHash = true;
      location.hash = `#join/${pendingToken}${pendingFocus ? `/${pendingFocus.kind}/${encodeURIComponent(pendingFocus.id)}` : ""}`;
    }
    if (!getState()) {
      $("#auth-panel").hidden = false;
      setConnectionStatus(attempted && !landed && roomTitle
        ? `Not connected · your invitation to “${roomTitle}” is still open in the address bar`
        : "Not connected · open an invitation link to join");
      ($("#google-signin") ?? $("#auth-title") ?? $("#access-key")).focus?.();
    }
  });
  window.addEventListener("hashchange", () => {
    if (suppressJoinHash) { suppressJoinHash = false; return; }
    const fragment = consumeJoinFragment(); if (fragment) open(fragment);
  });
  ensureGrowthChrome();
  return { sync, resetManagement, open, syncAccountSigninBusy,
    pendingFragment: () => joinSecret ? shareLinksPendingFragment() : null,
    async resumeSignedIn() {
      if (!joinDialog.open || !joinSecret) return false;
      await open({ token: joinSecret, focus: joinFocus }, { afterSignIn: true }); return true;
    }
  };
}
