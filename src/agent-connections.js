import { validId } from "./events.js";
import { rosterSelection, rosterNameTaken, suggestedConfigDir, capabilitySummary, connectionSeat, connectionStanding, setupChecklist, localClientSteps, routeHint, placeholderSnippetPaths, grokBuildToml, mcpJson, claudeMcpAddCommand, reconnectCopy, routeFromDisplayName, catalogSelection } from "./room-roster.js";

const $ = selector => document.querySelector(selector);
const newToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const digest = async value => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
const statuses = { key_issued: "Access ready · setup not verified", access_changed: "Access changed", revoked: "Key revoked", expired: "Expired", disconnected: "Disconnected" };

export function installAgentConnections({ client, getState }) {
  const dialog = $("#agent-connect-dialog"), form = $("#agent-connect-form"), list = $("#agent-connect-list");
  let owner = null, generation = null, ownerRevision = null, pending = null, setup = null, setupMeta = null, mcpCredential = null, expiryTimer = null, busy = false, copying = false, listVersion = 0, flow = 0, rosterId = null;
  // Rows rendered before the room state held their member: re-read once it arrives (R29-1).
  let unseatedRows = new Set();
  const member = () => getState()?.members[client.session?.member?.id];
  const allowed = () => client.ownsAccountSession() && client.session?.account && member()?.active !== false
    && getState()?.room.id === client.session.roomId
    && member()?.kind === "human" && member()?.permissions.includes("manage_members") && member()?.id === getState()?.room.ownerId;
  const owns = () => allowed() && owner === client.session && generation === client.generation && ownerRevision === member()?.revision;
  const status = text => { $("#agent-connect-status").textContent = text; };
  function conceal() { $("#agent-private-details").open = false; $("#agent-private-config").value = ""; }
  function forget() { setup = null; setupMeta = null; mcpCredential = null; clearTimeout(expiryTimer); expiryTimer = null; conceal(); }
  function privateSetupText() {
    if (!setup) return "";
    return mcpCredential ? `${JSON.stringify(setup)}\nMCP authorization: Bearer ${mcpCredential}` : JSON.stringify(setup);
  }
  function checkExpiry() {
    if (setup && setupMeta.expiresAt <= Date.now()) { forget(); status("This key expired. Replace it to reconnect."); return false; }
    return Boolean(setup);
  }
  function armExpiry() {
    clearTimeout(expiryTimer);
    if (setup) expiryTimer = setTimeout(() => { if (checkExpiry()) armExpiry(); else render(); }, Math.max(1, Math.min(2e9, setupMeta.expiresAt - Date.now() + 1)));
  }
  // An unverified email is a 403 on a valid session: ending access here signed the
  // owner out of the room the moment they tried to add an agent.
  const accessDenied = error => error?.code !== "email_unverified" && [401, 403].includes(error?.status) || ["session_binding_changed", "session_binding_required", "invalid_session_binding"].includes(error?.code);
  const catalogButtons = () => $("#agent-type-catalog")?.querySelectorAll("[data-agent-type], [data-roster]")
    ?? $("#agent-roster")?.querySelectorAll("[data-agent-type], [data-roster]")
    ?? [];
  const ACCESS_HINT = {
    chat: "Can read this room’s history and post messages.",
    contribute: "Can read this room, post messages, and contribute work.",
    review: "Can read this room, post messages, and review work."
  };
  function currentRoute() {
    const value = $("#agent-connect-route")?.value;
    return value === "packet" || value === "direct" ? value : "mcp";
  }
  function currentConfigDir() {
    return suggestedConfigDir(rosterId) || "/absolute/private/room-agent";
  }
  function fillList(node, items) {
    if (!node) return;
    node.replaceChildren(...items.map(text => {
      const li = document.createElement("li");
      li.textContent = text;
      return li;
    }));
  }
  function describeName() {
    const warning = $("#agent-name-warning");
    const taken = rosterNameTaken(getState()?.members, $("#agent-connect-name").value);
    warning.hidden = !taken;
    warning.textContent = taken ? "A member with this name already exists. Create access only if you want a second identity." : "";
  }
  function describeAccess() {
    if ($("#agent-access-hint")) $("#agent-access-hint").textContent = ACCESS_HINT[$("#agent-connect-access").value] ?? ACCESS_HINT.chat;
    fillList($("#agent-capabilities"), capabilitySummary($("#agent-connect-access").value));
  }
  function describeImport() {
    const hint = $("#agent-import-route");
    if (!hint) return;
    const route = currentRoute();
    hint.textContent = route === "packet"
      ? "Use my AI. Import this key only if the host can keep a secret outside chat."
      : route === "direct"
        ? "Import on that computer, then check. No key in a prompt."
        : "Merge the MCP snippet, then call room_check_access.";
  }
  function describeRoute() {
    const route = currentRoute();
    if ($("#agent-route-hint")) $("#agent-route-hint").textContent = routeHint(route);
    if ($("#agent-packet-today")) $("#agent-packet-today").hidden = route !== "packet";
    const packet = route === "packet";
    if ($("#agent-create")) $("#agent-create").hidden = packet;
    if ($("#agent-create-note")) {
      $("#agent-create-note").hidden = packet;
      $("#agent-create-note").textContent = "Next: connect the agent in its own app.";
    }
    if ($("#agent-key-later")) $("#agent-key-later").hidden = !packet;
    if ($("#agent-host-snippets")) $("#agent-host-snippets").hidden = route !== "mcp";
    fillList($("#agent-import-checklist"), setupChecklist({ route, configDir: currentConfigDir() }));
    if ($("#agent-local-command")) $("#agent-local-command").textContent = localClientSteps({ route, configDir: currentConfigDir() }).join("\n");
    try {
      const paths = placeholderSnippetPaths(currentConfigDir());
      if ($("#agent-mcp-toml")) $("#agent-mcp-toml").textContent = grokBuildToml(paths);
      if ($("#agent-mcp-json")) $("#agent-mcp-json").textContent = mcpJson(paths);
      if ($("#agent-mcp-cli")) $("#agent-mcp-cli").textContent = claudeMcpAddCommand(paths);
    } catch {
      if ($("#agent-mcp-toml")) $("#agent-mcp-toml").textContent = "";
      if ($("#agent-mcp-json")) $("#agent-mcp-json").textContent = "";
      if ($("#agent-mcp-cli")) $("#agent-mcp-cli").textContent = "";
    }
    describeName();
    describeAccess();
    describeImport();
  }
  async function copyPlain(text, ok) {
    if (!allowed() || !dialog.open || copying || typeof text !== "string" || !text) return;
    copying = true; render();
    try {
      const write = navigator.clipboard?.writeText?.(text);
      if (!write) throw new Error("clipboard");
      await Promise.race([write, new Promise((_, reject) => setTimeout(() => reject(new Error("clipboard")), 800))]);
      if (allowed() && dialog.open) status(ok);
    } catch {
      if (allowed() && dialog.open) status("Select and copy the text below. No key in this text.");
    } finally { copying = false; render(); }
  }
  function render() {
    form.hidden = Boolean(setup); $("#agent-setup").hidden = !setup;
    if (setup) describeImport();
    for (const input of form.querySelectorAll("input,select")) input.disabled = busy || Boolean(pending);
    $("#agent-create").disabled = busy;
    $("#agent-create").textContent = pending ? "Retry original" : "Create access";
    if ($("#agent-create-later")) $("#agent-create-later").disabled = busy;
    $("#agent-private-copy").disabled = copying || !setup || !owns();
    if ($("#agent-copy-checklist")) $("#agent-copy-checklist").disabled = copying || !setup || !allowed();
    $("#agent-connect-done").disabled = busy || copying;
    $("#agent-retry").hidden = !pending || pending.request.action === "create";
    $("#agent-retry").disabled = busy;
    for (const button of list.querySelectorAll("button")) button.disabled = busy || Boolean(pending) || Boolean(setup);
    for (const button of catalogButtons()) {
      button.disabled = busy || Boolean(pending) || Boolean(setup);
    }
  }
  function reset() {
    flow++; listVersion++; owner = null; generation = null; ownerRevision = null; pending = null; forget(); busy = false;
    conceal(); form.reset(); rosterId = null; $("#agent-other-types").open = false;
    if ($("#agent-roster-hint")) $("#agent-roster-hint").textContent = "";
    if ($("#agent-import-route")) $("#agent-import-route").textContent = "";
    list.replaceChildren(); status(""); render(); dialog.close();
  }
  function sync() {
    $("#connect-agent-button").hidden = !allowed();
    if (owner && !owns()) reset();
    if (setup && owns()) {
      const current = getState()?.members[setup.memberId];
      if (current && (current.revision > setupMeta.memberRevision || current.active === false && current.revision === setupMeta.memberRevision)
        || !current && client.sequence >= setupMeta.sequence) { forget(); status("Agent access changed. Review its connection."); render(); }
      else if (!checkExpiry()) render();
    }
    if (dialog.open && owns() && [...unseatedRows].some(id => connectionSeat(getState()?.members, id))) { unseatedRows = new Set(); void load(); }
  }
  async function load() {
    const version = ++listVersion;
    try {
      const result = await client.request(client.path("/agent-connections"));
      if (!owns() || version !== listVersion || !dialog.open) return;
      if (!Array.isArray(result?.connections) || result.connections.some(row => row.roomId !== owner.roomId || !Object.hasOwn(statuses, row.status)
        || (row.firstActionAt !== null && (typeof row.firstActionAt !== "string" || Number.isNaN(Date.parse(row.firstActionAt)))))) throw new Error();
      if (setup) {
        const current = result.connections.find(row => row.memberId === setup.memberId);
        if (!current || current.status !== "key_issued" || current.generation !== setupMeta.generation) { forget(); status("Agent access changed. Review its connection."); }
      }
      list.replaceChildren(); unseatedRows = new Set();
      for (const row of result.connections) {
        const li = document.createElement("li"), name = document.createElement("strong"), text = document.createElement("p");
        name.textContent = row.displayName;
        const members = getState()?.members;
        const seat = connectionSeat(members, row.memberId);
        if (members && seat == null && row.status !== "disconnected") unseatedRows.add(row.memberId);
        const standing = connectionStanding({
          connectionStatus: row.status,
          memberFound: members ? seat != null : null,
          permissions: seat ? seat.permissions ?? [] : null,
          hostTools: null,
          pending: row.status === "key_issued" && !row.firstActionAt,
        });
        const usedAt = row.keyLastUsedAt ?? row.identityLastUsedAt;
        const usedUa = row.keyLastUsedUa ?? row.identityLastUsedUa;
        const used = usedAt ? ` · Last used ${new Date(usedAt).toLocaleString()}${usedUa ? ` · ${usedUa}` : ""}` : "";
        text.textContent = `${standing.compact} · ${new Date(row.expiresAt).toLocaleString()}${used}`;
        const detail = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = "Permission detail";
        const detailText = document.createElement("p");
        detailText.textContent = standing.detail;
        detail.append(summary, detailText);
        li.append(name, text, detail);
        if (row.status !== "disconnected") {
          const copySteps = document.createElement("button");
          copySteps.type = "button"; copySteps.className = "button ghost"; copySteps.textContent = "Copy plug-in steps";
          copySteps.setAttribute("aria-label", `Copy plug-in steps for ${row.displayName}`);
          copySteps.addEventListener("click", () => {
            if (!allowed() || busy) return;
            void copyPlain(reconnectCopy({ displayName: row.displayName, route: routeFromDisplayName(row.displayName) }),
              "Copied plug-in steps. No key in this text.");
          });
          li.append(copySteps);
        }
        if (row.status !== "disconnected") for (const [action, label] of [["rotate", "Replace key"], ["disconnect", "Disconnect"]]) {
          const button = document.createElement("button"); button.type = "button"; button.className = "button ghost"; button.textContent = label;
          button.setAttribute("aria-label", `${label} for ${row.displayName}`);
          button.addEventListener("click", () => {
            if (!owns() || busy || pending || setup) return;
            const message = action === "rotate" ? "The old key will stop working. Set up the new key afterward. Replace it?"
              : "End Room access? This does not stop the outside AI or erase copies it already has.";
            if (window.confirm(message)) prepare(action, row);
          }); li.append(button);
        }
        list.append(li);
      }
      $("#agent-list-status").textContent = ""; render();
    } catch (error) {
      if (owns() && version === listVersion) {
        if (accessDenied(error)) { reset(); client.handleFailure(error); }
        else $("#agent-list-status").textContent = "Could not refresh connections. Close and reopen to retry.";
      }
    }
  }
  function matches(result, request) {
    const receipt = result?.receipt, connection = result?.connection;
    return receipt?.version === 1 && receipt.action === request.action && receipt.requestId === request.requestId
      && receipt.roomId === owner.roomId && receipt.memberId === request.memberId
      && receipt.generation === (request.action === "create" ? 1 : request.expectedGeneration + 1)
      && receipt.status === (request.action === "disconnect" ? "disconnected" : "issued")
      && (request.action === "disconnect" || receipt.expiresAt === request.expiresAt)
      && Number.isSafeInteger(receipt.at) && receipt.at >= 0
      && (request.action === "rotate" || request.action === "disconnect" && receipt.membershipEventId === null ? receipt.membershipEventId === null && receipt.membershipSequence === null
        : validId(receipt.membershipEventId) && Number.isSafeInteger(receipt.membershipSequence) && receipt.membershipSequence > 0)
      && connection?.roomId === owner.roomId && connection.memberId === request.memberId
      && Number.isSafeInteger(connection.generation) && connection.generation >= receipt.generation
      && Number.isSafeInteger(connection.memberRevision) && connection.memberRevision >= 0
      && Number.isSafeInteger(connection.expiresAt) && connection.expiresAt > 0
      && (connection.generation !== receipt.generation || connection.status !== "key_issued"
        || connection.expiresAt === receipt.expiresAt && connection.memberRevision === (request.action === "create" ? 0 : request.expectedMemberRevision))
      && Object.hasOwn(statuses, connection.status) && typeof result.duplicate === "boolean";
  }
  async function submit() {
    if (!owns() || !pending || busy) return;
    const operation = pending, currentFlow = flow; busy = true; status("Checking…"); render();
    try {
      const result = await client.request(client.path("/agent-connections"), { method: "POST", data: operation.request });
      if (!owns() || pending !== operation) return;
      if (!matches(result, operation.request)) throw new Error("unknown receipt");
      pending = null;
      const usable = operation.token && result.connection.generation === result.receipt.generation && result.connection.status === "key_issued";
      mcpCredential = typeof result.mcpToken?.credential === "string" && result.mcpToken.credential.startsWith("rak_") ? result.mcpToken.credential : null;
      setup = usable ? { version: 1, origin: location.origin, roomId: owner.roomId, memberId: operation.request.memberId, token: operation.token } : null;
      setupMeta = usable ? { generation: result.receipt.generation, memberRevision: result.connection.memberRevision, expiresAt: result.receipt.expiresAt,
        sequence: result.receipt.membershipSequence ?? client.sequence } : null;
      armExpiry();
      status(usable ? "Access ready. Setup does not start an AI." : operation.request.action === "disconnect" ? "Room access ended." : "Original request confirmed. That key is no longer active.");
      conceal(); render();
      if (setup && dialog.open) $("#agent-setup-title").focus();
      void load(); void client.refresh().catch(() => {});
    } catch (error) {
      if (!owns() || pending !== operation) return;
      if (error?.code === "email_unverified") { status(error.message); return; } // keep the request: Retry works once verified
      if (accessDenied(error)) { reset(); client.handleFailure(error); return; }
      if (error.status === 409) {
        pending = null; status("Access changed. Review the current settings before trying again."); void load();
      } else if (error.status === 422) {
        pending = null;
        status(typeof error.message === "string" && error.message.length <= 120 ? error.message : "Choose a name, access and expiry.");
        void load();
      } else status("Change not confirmed. Retry the original.");
    } finally { if (owns() && flow === currentFlow) { busy = false; render(); } }
  }
  async function prepare(action, row) {
    if (!owns() || busy || pending || setup) return;
    busy = true; render();
    const identity = owner, epoch = generation, currentFlow = flow;
    try {
      const token = action === "disconnect" ? null : newToken();
      const request = { action, requestId: crypto.randomUUID(), memberId: row?.memberId ?? `agent-${crypto.randomUUID()}`, expectedOwnerRevision: member().revision,
        ...(action === "create" ? { displayName: $("#agent-connect-name").value.trim(), access: $("#agent-connect-access").value,
          ...(rosterId ? { agentType: rosterId } : {}) }
          : { expectedGeneration: row.generation, expectedMemberRevision: row.memberRevision }),
        ...(token ? { keyHash: await digest(token), expiresAt: Date.now() + Number($("#agent-connect-expiry").value) * 86400000 - 60000 } : {}) };
      if (!owns() || owner !== identity || generation !== epoch || flow !== currentFlow) return;
      pending = { request, token }; busy = false; await submit();
    } catch { if (owns() && owner === identity && generation === epoch && flow === currentFlow) status("Could not prepare access. Try again."); }
    finally { if (owns() && owner === identity && generation === epoch && flow === currentFlow) { busy = false; render(); } }
  }
  if (dialog && typeof document.createElement === "function" && !dialog.querySelector("#growth-connection-invite")) {
    const note = document.createElement("p");
    note.id = "growth-connection-invite";
    note.className = "definition";
    note.textContent = "Your invite link admits a person or an agent. Copy it from Invite. Agents read the same link from GET /api/rooms/{roomId}/referrals.";
    // Optional invite/API detail should not precede the first host choice.
    $("#agent-connect-advanced").append(note);
  }
  $("#connect-agent-button").addEventListener("click", () => {
    if (!allowed()) return;
    if (!owner) { owner = client.session; generation = client.generation; ownerRevision = member().revision; }
    if (!owns()) { reset(); return; }
    checkExpiry(); conceal(); describeRoute(); render(); dialog.showModal(); void load();
    if (pending) status("Change not confirmed. Retry the original.");
    if (setup) $("#agent-setup-title").focus();
    else if (!pending) (rosterId ? $("#agent-connect-name") : catalogButtons()[0])?.focus();
  });
  $("#agent-connect-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", conceal);
  form.addEventListener("submit", event => { event.preventDefault(); if (pending) void submit(); else void prepare("create"); });
  $("#agent-connect-name").addEventListener("input", describeName);
  $("#agent-connect-access")?.addEventListener("change", describeAccess);
  $("#agent-connect-route")?.addEventListener("change", describeRoute);
  $("#agent-retry").addEventListener("click", () => { void submit(); });
  $("#agent-connect-done").addEventListener("click", () => {
    if (!busy && !copying) {
      forget(); form.reset(); rosterId = null;
      if ($("#agent-roster-hint")) $("#agent-roster-hint").textContent = "";
      if ($("#agent-import-route")) $("#agent-import-route").textContent = "";
      describeRoute(); status(""); render(); catalogButtons()[0]?.focus();
    }
  });
  function applyCatalogChoice(id) {
    if (busy || pending || setup) return;
    const row = catalogSelection(id) || rosterSelection(id);
    if (!row) return;
    $("#agent-connect-name").value = row.name;
    $("#agent-connect-access").value = row.access;
    if ($("#agent-connect-route")) $("#agent-connect-route").value = row.route;
    rosterId = row.agentType || id;
    describeRoute();
    if ($("#agent-roster-hint")) {
      const best = row.bestFor ? `${row.bestFor}. ` : "";
      $("#agent-roster-hint").textContent = `${best}${row.hint}`;
    }
  }
  for (const button of catalogButtons()) {
    button.addEventListener("click", () => {
      applyCatalogChoice(button.dataset.agentType || button.dataset.roster);
    });
  }
  $("#agent-private-details").addEventListener("toggle", () => {
    $("#agent-private-config").value = $("#agent-private-details").open && owns() && checkExpiry() ? privateSetupText() : "";
  });
  $("#agent-create-later")?.addEventListener("click", () => { if (!busy && !pending && !setup) $("#agent-create").click(); });
  $("#agent-copy-checklist")?.addEventListener("click", () => {
    if (!setup || !allowed()) return;
    void copyPlain(reconnectCopy({
      displayName: $("#agent-connect-name")?.value,
      route: currentRoute(),
      configDir: currentConfigDir()
    }), "Copied plug-in steps. No key in this text.");
  });
  $("#agent-private-copy").addEventListener("click", async () => {
    if (!owns() || !checkExpiry() || copying || !$("#agent-private-details").open) return;
    const current = setup; copying = true; render();
    try { await navigator.clipboard.writeText(privateSetupText()); if (owns() && setup === current && dialog.open) status("Private setup copied. Clear your clipboard after importing."); }
    catch { if (owns() && setup === current && dialog.open) status("Select and copy the private setup below."); }
    finally { copying = false; render(); }
  });
  return { sync, reset, hasPending: () => Boolean(pending || setup) };
}
