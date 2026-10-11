// #662 owner attention rollup, plus MEMBER-PERMS reviewed access requests.
// Admins see only the existing access-request queue their authority permits;
// the broader rollup remains owner-only. Requester controls share this module
// so every runtime serves the same already-packaged permission UI.

const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const KIND_LABEL = {
  access_request: "Join request",
  verification: "Verify",
  decision: "Decision",
  spend: "Spend",
  claim_lease: "Claim lease",
  jev_escalation: "Shadow diagnostic",
};

export function createNeedsAttentionCard(options) {
  const { client, section, getState } = options;
  // The original two-argument dependency contract is owner-rollup-only. A
  // supplied state provider enables member-request UI and must stay fail-closed
  // while that provider is empty during navigation or access teardown.
  const hasRoomState = Object.hasOwn(options, "getState");
  const list = section.querySelector("#attention-list");
  const count = section.querySelector("#attention-count");
  const status = section.querySelector("#attention-status");
  const refreshButton = section.querySelector("#attention-refresh");
  const pages = section.querySelector("#attention-pages");
  const range = section.querySelector("#attention-range");
  const previous = section.querySelector("#attention-previous");
  const next = section.querySelector("#attention-next");
  let currentReport = null, epoch = 0, busy = false, partial = null, observed = null, activeScope = null, authority = null;
  function viewer() {
    const state = typeof getState === "function" ? getState() : null, session = client.session;
    const member = hasRoomState ? (state?.room?.id === session?.roomId ? state?.members?.[session?.member?.id] : null) : session?.member;
    return { member, owner: Boolean(member && state?.room?.ownerId === member.id) };
  }
  function canReview() {
    if (!hasRoomState) return Boolean(client.session);
    const { member } = viewer();
    return Boolean(member?.active !== false && member?.permissions?.includes("manage_members"));
  }
  function canGrant(permission) {
    if (!hasRoomState) return true; // Legacy reader authenticates the owner.
    const { member, owner } = viewer();
    return owner || Boolean(member?.permissions?.includes(permission));
  }
  function requestItem(request) {
    const path = client.path(`/access-requests/${encodeURIComponent(request.requestId)}/decide`);
    return { kind: "access_request", id: request.requestId, severity: "action", requestKind: request.kind,
      title: request.kind === "permissions" ? `${request.displayName} wants more permissions` : `${request.displayName} asks to join`,
      detail: `Requested: ${request.requestedPermissions.join(", ") || "read and chat"}${request.kind === "permissions" ? ". Approval adds permissions and keeps existing access." : ""}`,
      requestedPermissions: request.requestedPermissions,
      actions: [{ action: "approve", method: "POST", path, body: { decision: "approve", permissions: request.requestedPermissions, note: null } },
        { action: "deny", method: "POST", path, body: { decision: "deny", permissions: [], note: null } }] };
  }
  // E-H1: retry state for failed fetches. The section starts hidden and the
  // Refresh button lives inside it, so a failed first fetch would otherwise
  // be invisible and unretryable for the whole session.
  let retryTimer = null;
  const RETRY_DELAY_MS = 30000;

  function owns(ticket, session, generation) {
    if (ticket !== epoch || session !== client.session || generation !== client.generation) return false;
    if (!canReview() || hasRoomState && currentReport?.ownerOnly && !viewer().owner) { hide(); return false; }
    return true;
  }
  function clearRetry() {
    if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
  }
  function scheduleRetry() {
    clearRetry();
    const retryTicket = ++epoch, retrySession = client.session, retryGeneration = client.generation;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (owns(retryTicket, retrySession, retryGeneration) && client.session) return refresh();
    }, RETRY_DELAY_MS);
  }
  function setBusy(value) {
    busy = value;
    refreshButton.disabled = value;
    previous.disabled = value || !currentReport?.previousCursor;
    next.disabled = value || !currentReport?.nextCursor;
    list.querySelectorAll(".attention-decide, .attention-partial, .attention-cancel, .attention-selected").forEach(button => {
      button.disabled = value || button.dataset.unavailable === "true";
    });
    list.querySelectorAll("[data-permission-choice]").forEach(input => { input.disabled = value || !canGrant(input.value); });
  }
  function hide() {
    epoch++;
    clearRetry();
    currentReport = null; partial = null; observed = null; activeScope = null; authority = null;
    section.hidden = true;
    list.innerHTML = "";
    count.textContent = "";
    range.textContent = "";
    pages.hidden = true;
    setStatus("");
    setBusy(false);
  }

  function setStatus(message) { status.textContent = message || ""; status.classList.toggle("visible", Boolean(message)); }

  function actionControls(item) {
    const controls = item.actions.map((action, index) => {
      if (action.method === "GET" && item.kind !== "spend") {
        const workId = item.kind === "jev_escalation" ? item.workItemId : item.id;
        return workId ? `<a class="button ghost" href="#pr-record/work/${esc(encodeURIComponent(workId))}" data-open-work="${esc(workId)}">Review</a>`
          : `<a class="button ghost" href="${esc(action.path)}">Diagnostics</a>`;
      }
      if (action.method === "POST" && action.body) {
        const label = action.action === "approve" ? "Approve" : action.action === "deny" ? (item.requestKind === "permissions" ? "Decline" : "Deny") : action.action;
        const unavailable = action.action === "approve" && (action.body.permissions ?? []).some(permission => !canGrant(permission));
        return `<button type="button" class="button${action.action === "approve" ? " primary" : ""} attention-decide" data-action-index="${index}" data-unavailable="${unavailable}"${unavailable ? " disabled" : ""}>${esc(label)}</button>`;
      }
      return action.hint ? `<span class="attention-hint">${esc(action.hint)}</span>` : "";
    }).join("");
    const permissions = item.requestedPermissions ?? [];
    if (item.kind !== "access_request" || !permissions.length) return controls;
    const unavailable = permissions.filter(permission => !canGrant(permission));
    const hint = unavailable.length ? `<p class="form-hint">You cannot grant: ${esc(unavailable.join(", "))}. A room owner or admin who holds them must review those permissions.</p>` : "";
    const choose = partial?.id === item.id;
    const partialControls = choose ? `<fieldset data-permission-selection><legend>Choose permissions to approve</legend>${permissions.map(permission => `<label><input type="checkbox" data-permission-choice value="${esc(permission)}"${partial.selected.has(permission) ? " checked" : ""}${canGrant(permission) ? "" : " disabled"}> ${esc(permission)}</label>`).join("")}
      <button type="button" class="button primary attention-selected" data-unavailable="${!partial.selected.size}"${partial.selected.size ? "" : " disabled"}>Approve selected</button>
      <button type="button" class="button ghost attention-cancel">Cancel</button></fieldset>`
      : `<button type="button" class="button ghost attention-partial">Approve partial</button>`;
    return controls + partialControls + hint;
  }

  function render(report) {
    const items = report?.items ?? [];
    currentReport = report;
    count.textContent = String(report?.itemCount ?? items.length);
    pages.hidden = !report?.nextCursor && !report?.previousCursor;
    range.textContent = items.length ? `Showing ${report.pageOffset + 1}–${report.pageOffset + items.length} of ${report.itemCount}` : "";
    section.hidden = items.length === 0;
    list.innerHTML = items.map((item, itemIndex) => `
      <li class="attention-item attention-${esc(item.kind)} attention-severity-${esc(item.severity)}" data-item-index="${itemIndex}" data-access-request-id="${item.kind === "access_request" ? esc(item.id) : ""}">
        <div class="attention-body">
          <span class="attention-kind">${esc(item.requestKind === "permissions" ? "Permission request" : KIND_LABEL[item.kind] ?? item.kind)}</span>
          <strong class="attention-title">${esc(item.title)}</strong>
          <p class="attention-detail">${esc(item.detail)}</p>
        </div>
        <div class="attention-actions">${actionControls(item)}</div>
      </li>`).join("");
    list.querySelectorAll(".attention-decide").forEach(button => {
      button.addEventListener("click", () => decide(report, Number(button.closest("li").dataset.itemIndex), Number(button.dataset.actionIndex)));
    });
    list.querySelectorAll(".attention-partial").forEach(button => button.addEventListener("click", () => {
      if (busy || !canReview()) return;
      const item = report.items[Number(button.closest("li").dataset.itemIndex)];
      partial = { id: item.id, selected: new Set(item.requestedPermissions.filter(canGrant)) };
      render(report);
      list.querySelector("[data-permission-selection] input:not(:disabled), .attention-cancel")?.focus();
    }));
    list.querySelectorAll("[data-permission-choice]").forEach(input => input.addEventListener("change", () => {
      if (!partial || busy) return;
      if (input.checked && canGrant(input.value)) partial.selected.add(input.value); else partial.selected.delete(input.value);
      const submit = input.closest("fieldset").querySelector(".attention-selected");
      submit.dataset.unavailable = String(!partial.selected.size); submit.disabled = !partial.selected.size;
    }));
    list.querySelectorAll(".attention-selected").forEach(button => button.addEventListener("click", () => {
      if (!partial || !partial.selected.size) return;
      const index = Number(button.closest("li").dataset.itemIndex), item = report.items[index];
      decide(report, index, item.actions.findIndex(action => action.action === "approve"), [...partial.selected]);
    }));
    list.querySelectorAll(".attention-cancel").forEach(button => button.addEventListener("click", cancelPartial));
    setBusy(false);
    setStatus(report?.reset ? "The list changed. Showing the first page." : "");
  }

  function cancelPartial() {
    if (busy || !partial) return;
    const id = partial.id; partial = null;
    render(currentReport);
    list.querySelector(`[data-access-request-id="${CSS.escape(id)}"] .attention-partial`)?.focus();
  }
  list.addEventListener("keydown", event => {
    if (event.key === "Escape" && partial && !busy) { event.preventDefault(); event.stopPropagation(); cancelPartial(); }
  });

  async function decide(report, itemIndex, actionIndex, permissions = null) {
    if (busy || report !== currentReport || !client.session || !canReview()) return;
    if (hasRoomState && !client.ownsAccountSession()) { hide(); client.endAccess(); return; }
    const item = report?.items?.[itemIndex], action = item?.actions?.[actionIndex];
    if (!action?.path || action.method !== "POST" || !action.body) return;
    const body = permissions ? { ...action.body, permissions } : action.body;
    if (body.decision === "approve" && body.permissions.some(permission => !canGrant(permission))) return;
    const ticket = ++epoch, session = client.session, generation = client.generation;
    setBusy(true);
    setStatus("Working…");
    try {
      await client.request(action.path, { method: "POST", data: body });
      if (!owns(ticket, session, generation)) return;
      partial = null;
      await refresh();
    } catch (error) {
      if (!owns(ticket, session, generation)) return;
      if (error.status === 401 || error.code === "session_binding_changed") { hide(); client.handleFailure(error); return; }
      if (error.status === 403) { hide(); await client.refresh(); return; }
      setBusy(false);
      setStatus(error.code === "already_decided" ? "Already decided — refreshing…" : `Could not decide: ${error.message}`);
      if (error.code === "already_decided") await refresh();
    }
  }

  const includeShadow = () => Boolean(globalThis.document?.body?.classList?.contains("human-advanced"));
  globalThis.document?.addEventListener?.("change", event => {
    if (event.target?.id === "human-advanced") queueMicrotask(() => refresh());
  });

  async function refresh(cursor = null) {
    if (!client.session || !canReview()) { hide(); return; }
    if (hasRoomState && !client.ownsAccountSession()) { hide(); client.endAccess(); return; }
    clearRetry();
    const ticket = ++epoch, session = client.session, generation = client.generation;
    const focused = document.activeElement;
    const focusedRow = focused?.closest?.("[data-access-request-id]");
    const focusedRequest = focusedRow?.dataset.accessRequestId;
    const focusedSelector = focused?.matches?.(".attention-decide") ? `[data-action-index="${CSS.escape(focused.dataset.actionIndex)}"]`
      : ["attention-partial", "attention-selected", "attention-cancel"].find(name => focused?.classList?.contains?.(name));
    setBusy(true);
    setStatus("Checking…");
    try {
      let report = await client.needsAttention(cursor, { includeShadow: includeShadow() });
      if (!owns(ticket, session, generation)) return;
      if (hasRoomState) {
        const queue = await client.request(client.path("/access-requests?status=pending"));
        if (!owns(ticket, session, generation)) return;
        if (queue?.roomId !== session.roomId || !Array.isArray(queue.requests)) throw new Error("The request queue could not be confirmed");
        const requests = queue.requests.map(requestItem), byId = new Map(requests.map(item => [item.id, item]));
        // Owners retain their paged rollup; admins receive only the request queue
        // their existing manage_members authority permits, never the owner rollup.
        if (!viewer().owner) report = null;
        report = report ? { ...report, ownerOnly: true, items: report.items.map(item => item.kind === "access_request" ? byId.get(item.id) : item).filter(Boolean) }
          : { items: requests, itemCount: requests.length, pageOffset: 0, ownerOnly: false };
      }
      if (partial && !report?.items.some(item => item.id === partial.id)) partial = null;
      const keepsFocus = focused && (document.activeElement === focused
        || focused.disabled && document.activeElement === document.body);
      render(report);
      if (keepsFocus && focusedRequest && focusedSelector) {
        const selector = focusedSelector.startsWith("[") ? focusedSelector : `.${focusedSelector}`;
        const replacement = list.querySelector(`[data-access-request-id="${CSS.escape(focusedRequest)}"] ${selector}`);
        if (replacement && !replacement.disabled) replacement.focus();
      } else if (keepsFocus && (focused === previous || focused === next)) {
        // Avoid leaving keyboard focus on a now-disabled paging control.
        (pages.hidden ? refreshButton : focused.disabled ? (focused === next ? previous : next) : focused).focus();
      }
    } catch (error) {
      if (!owns(ticket, session, generation)) return;
      if ([401, 403].includes(error.status) || error.code === "session_binding_changed") {
        hide(); if (error.status === 401 || error.code === "session_binding_changed") client.handleFailure(error); return;
      }
      currentReport = null; partial = null; list.innerHTML = "";
      setBusy(false);
      setStatus(`Could not load: ${error.message}`);
      // E-H1: unhide so the owner sees the error and the Refresh button, and
      // schedule an automatic retry so a transient blip doesn't hide join
      // requests and approvals for the whole session.
      section.hidden = false;
      scheduleRetry();
    }
  }

  refreshButton.addEventListener("click", () => refresh());
  previous.addEventListener("click", () => { if (!busy && currentReport?.previousCursor) refresh(currentReport.previousCursor); });
  next.addEventListener("click", () => { if (!busy && currentReport?.nextCursor) refresh(currentReport.nextCursor); });
  function sync() {
    if (!hasRoomState) return;
    if (!client.session || !canReview()) { hide(); return; }
    const identity = `${client.generation}:${client.session.roomId}:${client.session.member.id}`;
    if (identity !== activeScope) { hide(); activeScope = identity; }
    const { member, owner } = viewer(), grants = `${owner}:${member.permissions.join(",")}`;
    // An ex-owner may remain an admin. The owner rollup contains more than
    // requests, so invalidate its page/editor and outstanding reads first.
    if (currentReport?.ownerOnly && !owner) { hide(); activeScope = identity; }
    if (authority !== grants && currentReport) {
      if (partial) partial.selected = new Set([...partial.selected].filter(canGrant));
      const wasBusy = busy;
      render(currentReport);
      setBusy(wasBusy);
    }
    authority = grants;
    const next = `${identity}:${client.sequence}:${includeShadow()}`;
    if (next === observed) return;
    observed = next;
    // Preserve the reader's selected page and unsent partial selection. Manual
    // Next/Previous still exercise the server's stale-continuation reset.
    if (busy || partial || currentReport?.pageOffset > 0) return;
    void refresh();
  }
  return { refresh, hide, sync };
}

// MEMBER-PERMS: the requester uses the same authenticated, reviewed API as REST.
const WORK_PERMISSIONS = ["accept_work", "complete_work"];
// Members read these words, not the permission ids the server stores.
const WORK_PERMISSION_LABELS = { accept_work: "Accept work", complete_work: "Complete work" };

export function installMemberPermissions({ client, getState, getSession }) {
  let scope = null, operation = null, busy = false, message = "", retry = false;
  const current = () => {
    const session = getSession(), state = getState();
    const member = session && state?.members?.[session.member.id];
    return session && state?.room?.id === session.roomId && member?.active !== false && member ? { session, state, member, generation: client.generation } : null;
  };
  const owns = value => {
    const now = current();
    return now && value.session === now.session && value.generation === now.generation && value.state.room.id === now.state.room.id;
  };
  function reset() {
    scope = null; operation = null; busy = false; message = ""; retry = false;
    document.querySelectorAll("[data-member-permissions]").forEach(node => node.remove());
  }
  function sync() {
    const value = current();
    if (!value) { reset(); return; }
    if (!scope || !owns(scope)) { reset(); scope = value; }
    const missing = WORK_PERMISSIONS.filter(permission => !value.member.permissions.includes(permission));
    const row = document.querySelector(`[data-member-record-id="${CSS.escape(value.member.id)}"] .member-profile-body`);
    if (!row) return;
    let group = row.querySelector("[data-member-permissions]");
    if (!missing.length && !message && !operation) return;
    if (!group) {
      group = document.createElement("div"); group.dataset.memberPermissions = value.member.id;
      const button = document.createElement("button"); button.type = "button"; button.className = "text-button";
      button.dataset.requestPermissions = ""; button.addEventListener("click", request);
      const status = document.createElement("p"); status.className = "form-hint"; status.dataset.permissionRequestStatus = "";
      status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
      group.append(button, status); row.append(group);
    }
    const button = group.querySelector("button"), status = group.querySelector("[role=status]");
    button.hidden = !missing.length; button.disabled = busy;
    button.textContent = busy ? "Sending request…" : retry ? "Retry request" : operation?.status === "pending" ? "Check request" : "Ask to take work";
    status.textContent = !missing.length ? "You can take work now." : message || `Ask for: ${missing.map(permission => WORK_PERMISSION_LABELS[permission] ?? permission).join(", ")}. A room owner or admin reviews the request.`;
  }
  async function request() {
    const value = current();
    if (busy || !value || !owns(scope)) return;
    const missing = WORK_PERMISSIONS.filter(permission => !value.member.permissions.includes(permission));
    if (!missing.length) { sync(); return; }
    if (!client.ownsAccountSession()) { client.endAccess(); return; }
    if (!operation || !["pending", "unknown"].includes(operation.status)) {
      operation = { requestId: crypto.randomUUID(), permissions: missing, status: "unknown" };
    }
    const sent = operation;
    busy = true; retry = false; message = "Sending request…"; sync();
    try {
      const result = await client.request(client.path("/members/me/permission-requests"), {
        method: "POST", data: { requestId: sent.requestId, permissions: sent.permissions }
      });
      if (!owns(value) || sent !== operation) return;
      if (result?.requestId !== sent.requestId || result?.kind !== "permissions") throw new Error("The request could not be confirmed. Retry to check it.");
      operation = { ...sent, status: result.status };
      message = result.status === "pending" ? `Requested: ${result.requestedPermissions.join(", ")}. Waiting for review.`
        : result.status === "approved" ? "Request approved. Your room permissions have been updated."
          : result.status === "denied" ? "The request was declined. Your permissions are unchanged."
            : `Request ${result.status}. You can ask again if needed.`;
      await client.refresh();
    } catch (error) {
      if (!owns(value) || sent !== operation) return;
      if ([401, 403].includes(error.status) || error.code === "session_binding_changed") { reset(); client.handleFailure(error); return; }
      // Unknown outcomes and transient pre-lookup refusals retain the exact
      // id and grant list, including an already-confirmed pending request.
      // Retrying checks that request instead of creating a second one.
      retry = !Number.isSafeInteger(error.status) || error.status >= 500 || [408, 425, 429].includes(error.status);
      if (!retry) operation = null;
      message = error.code === "nothing_to_request" ? "You already have these permissions. Refreshing…" : `Could not request: ${error.message}`;
      if (error.code === "nothing_to_request") await client.refresh();
    } finally {
      if (owns(value)) { busy = false; sync(); }
    }
  }
  return { sync, reset };
}
