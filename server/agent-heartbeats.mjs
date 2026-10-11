// Agent host heartbeats and the durable mention/DM wake queue.
//
// Each agent identity has zero or more hosts. A host is wakeable (the
// default) or pull-only. Wakeable hosts wait on GET /api/agent-wakes/poll
// and may also register an HTTPS wake URL. Pull-only hosts register no
// wake URL. Presence is online when any host was seen inside its
// reachability window (max(180s, cadenceSeconds * 1.5)), offline when
// every host is stale, and unregistered when no host has reported.
//
// Any agent with at least one registered host gets one wake signal per
// mention or DM, whatever the host's mode or presence. The same message
// coalesces to one signal (agent plus message). POST /api/agent-heartbeats
// returns that host's unacknowledged signals in pendingWakes, oldest
// first, at most 50, with more:true when the page is truncated. The poll
// does not acknowledge. The host acknowledges with ackWakes.
//
// Push is a separate doorbell. An offline wakeable host with a usable
// push subscription receives a pointer-only POST. Push does not decide
// who gets a queued signal.
//
// SQLite persistence survives restarts. The schema is additive.
import { randomBytes } from "node:crypto";
import { validateWebhookUrl, assertWebhookHostDnsPublic, WAKE_ACK_HINT } from "./outbound-webhooks.mjs";
import { postDelivery } from "./webhook-dispatch.mjs";

const MODES = Object.freeze(["wakeable", "pull-only"]);
const WAKE_KINDS = Object.freeze(["mention", "dm"]);
const STATUSES = Object.freeze(["online", "offline", "unregistered"]);
// RC-2026-09-24-203: the default reachability window is 180s (was 60s).
// Per host the window is max(180s, cadenceSeconds * 1.5).
export const HEARTBEAT_STALE_AFTER_MS = 180000;
// plan-wake-live: an agent is "wakeable" when it polled (GET
// /api/agent-wakes/poll) or heartbeated within the last 24h. Deliberately
// far wider than the 180s presence window: presence measures host
// liveness, wakeability measures listener recency — the room must tell a
// live listener from an idle agent whose queue merely looks empty.
export const WAKEABLE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING_WAKES = 50;
const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const HOST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
// Push wake path (RC-2026-09-24-203): token bounds, delivery timeout, and
// the consecutive-failure count that suspends a subscription.
const PUSH_TOKEN_MIN = 1;
const PUSH_TOKEN_MAX = 500;
const PUSH_DELIVERY_TIMEOUT_MS = 5000;
const PUSH_SUSPEND_AFTER_FAILURES = 3;
const PUSH_EVENT_TYPES = Object.freeze(["message.posted", "dm.posted", "bond.proposed", "assignment.created", "land.updated"]);

// RC-2026-09-24-203: agent_push_configs carries per-host push-notification
// subscriptions and poll cadence. Purely additive: agent_hosts is never
// altered, one row per (agent, host), replaced on each heartbeat that
// carries push/cadence fields. The token and bearer credentials are stored
// but never returned in any response, never logged, and never put in room
// state/events.
export const agentHeartbeatSchema = `
  CREATE TABLE IF NOT EXISTS agent_hosts (
    agent_id TEXT NOT NULL, host_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('wakeable','pull-only')),
    wake_url TEXT, last_seen_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(agent_id, host_id)
  );
  CREATE INDEX IF NOT EXISTS agent_hosts_seen ON agent_hosts(agent_id, last_seen_at);
  CREATE TABLE IF NOT EXISTS agent_wake_signals (
    signal_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('mention','dm')),
    room_id TEXT, message_id TEXT,
    created_at INTEGER NOT NULL, delivered_at INTEGER,
    UNIQUE(agent_id, message_id)
  );
  CREATE INDEX IF NOT EXISTS agent_wake_signals_pending ON agent_wake_signals(agent_id, delivered_at);
  CREATE TABLE IF NOT EXISTS agent_push_configs (
    agent_id TEXT NOT NULL, host_id TEXT NOT NULL,
    cadence_seconds REAL,
    push_url TEXT, push_token TEXT, push_auth_json TEXT,
    push_failures INTEGER NOT NULL DEFAULT 0,
    push_suspended INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(agent_id, host_id)
  );
  CREATE INDEX IF NOT EXISTS agent_push_configs_seen ON agent_push_configs(agent_id, updated_at);
  CREATE TABLE IF NOT EXISTS agent_wake_polls (
    agent_id TEXT PRIMARY KEY,
    last_polled_at INTEGER NOT NULL
  );
`;
// plan-wake-live: agent_wake_polls is the durable per-agent last-polled-at.
// Recorded on poll AND heartbeat activity (a heartbeat carries the pending
// queue, so it proves the host is listening). Purely additive: existing
// tables are never altered; agents from before this table existed simply
// read as not wakeable until they next poll or heartbeat. (The comment
// lives outside the template: verifySchema() splits the schema on
// statement boundaries and SQL comments between statements break it.)

export class HeartbeatError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "HeartbeatError";
    this.status = status;
    this.code = code;
  }
}
const fail = (status, code, message) => { throw new HeartbeatError(status, code, message); };
const check = (condition, status, code, message) => { if (!condition) fail(status, code, message); };

const checkAgentId = agentId =>
  check(typeof agentId === "string" && AGENT_ID_PATTERN.test(agentId),
    422, "invalid_heartbeat", "agentId must match [A-Za-z0-9_-]{1,64}");
const checkHostId = hostId =>
  check(typeof hostId === "string" && HOST_ID_PATTERN.test(hostId),
    422, "invalid_heartbeat", "hostId must match [A-Za-z0-9._-]{1,128}");

// RC-2026-09-24-203: cadence is the host's declared poll interval in
// seconds. Positive and finite; absent means the 180s default window.
// Bounded above: the window is cadence x 1.5, so an unbounded cadence (1e300)
// kept one heartbeat "online" for good and land-queue wakes (sent only to
// offline claimants) never fired for an agent that had stopped.
export const MAX_CADENCE_SECONDS = 7 * 24 * 3600;
const checkCadenceSeconds = cadenceSeconds =>
  check(Number.isFinite(cadenceSeconds) && cadenceSeconds > 0 && cadenceSeconds <= MAX_CADENCE_SECONDS,
    422, "invalid_heartbeat", `cadenceSeconds must be a positive number of seconds, at most ${MAX_CADENCE_SECONDS} (7 days)`);

// RC-2026-09-24-203: validate a pushNotification subscription body.
// Returns the normalized { url, token, authJson }. The sync shape checks
// live here; the async DNS-rebinding check runs in assertPushDns (the route
// awaits it before heartbeat() stores anything). The token and bearer
// credentials are validated for shape only and are NEVER echoed — the
// caller stores them, responses never include them.
const PUSH_NOTIFICATION_KEYS = Object.freeze(["url", "token", "authentication"]);
const checkPushNotification = pushNotification => {
  check(pushNotification !== null && typeof pushNotification === "object" && !Array.isArray(pushNotification),
    422, "invalid_heartbeat", "pushNotification must be an object");
  const keys = Object.keys(pushNotification);
  check(keys.includes("url") && keys.includes("token")
    && keys.every(key => PUSH_NOTIFICATION_KEYS.includes(key)),
    422, "invalid_heartbeat", "pushNotification accepts url, token, and optional authentication");
  const { url, token, authentication } = pushNotification;
  let validatedUrl;
  try { validatedUrl = validateWebhookUrl(url); }
  catch (error) { fail(422, "invalid_heartbeat", `pushNotification.url is not a usable push target: ${error.message}`); }
  check(typeof token === "string" && token.length >= PUSH_TOKEN_MIN && token.length <= PUSH_TOKEN_MAX,
    422, "invalid_heartbeat", `pushNotification.token must be a ${PUSH_TOKEN_MIN}-${PUSH_TOKEN_MAX} char opaque string`);
  let authJson = null;
  if (authentication !== undefined && authentication !== null) {
    check(typeof authentication === "object" && !Array.isArray(authentication),
      422, "invalid_heartbeat", "pushNotification.authentication must be an object");
    const authKeys = Object.keys(authentication);
    check(authKeys.length === 2 && authKeys.includes("schemes") && authKeys.includes("credentials"),
      422, "invalid_heartbeat", "pushNotification.authentication must be exactly { schemes, credentials }");
    check(Array.isArray(authentication.schemes) && authentication.schemes.length === 1
      && authentication.schemes[0] === "bearer",
      422, "invalid_heartbeat", "pushNotification.authentication.schemes must be [\"bearer\"]");
    check(typeof authentication.credentials === "string" && authentication.credentials.length > 0,
      422, "invalid_heartbeat", "pushNotification.authentication.credentials must be a non-empty string");
    authJson = JSON.stringify({ schemes: ["bearer"], credentials: authentication.credentials });
  }
  return { url: validatedUrl, token, authJson };
};

const hostView = (row, cadenceSeconds = null) => Object.freeze({
  agentId: row.agent_id, hostId: row.host_id, mode: row.mode,
  wakeUrl: row.wake_url, lastSeenAt: row.last_seen_at,
  createdAt: row.created_at, updatedAt: row.updated_at,
  // RC-2026-09-24-203: the host's declared poll cadence (null when the host
  // never declared one); drives the per-host reachability window.
  cadenceSeconds,
});
// work-claim:{id}:{reason}:… is the claim wake id. Poll and heartbeat
// readers triage on reason without a second table. Other signals stay
// the same shape.
const claimWakeOf = messageId => {
  if (typeof messageId !== "string" || !messageId.startsWith("work-claim:")) return null;
  const parts = messageId.split(":");
  if (parts.length < 3 || parts[1].length === 0 || parts[2].length === 0) return null;
  return { workClaim: parts[1], reason: parts[2] };
};
const signalView = row => {
  const claim = claimWakeOf(row.message_id);
  return Object.freeze({
    signalId: row.signal_id, agentId: row.agent_id, kind: row.kind,
    roomId: row.room_id, messageId: row.message_id,
    createdAt: row.created_at, deliveredAt: row.delivered_at,
    ...(claim ? { workClaim: claim.workClaim, reason: claim.reason } : {}),
    // Tag acknowledgment (2026-09-23): the one-tap ack copy rides the journaled
    // pending-wake signal too, so an agent reading its heartbeat queue learns a
    // bare 👍 react counts as a response. Additive — every existing field stands.
    ackHint: WAKE_ACK_HINT,
  });
};

// A pre-migration or read-only DB lacks these tables; that is the only error the
// fail-closed reads below may absorb. Busy, locked and I/O errors must surface.
function isMissingTable(error) {
  return /no such (table|column)/i.test(String(error?.message ?? ""));
}

export class AgentHeartbeats {
  constructor(store, { staleAfterMs = HEARTBEAT_STALE_AFTER_MS } = {}) {
    this.store = store;
    this.db = store.db;
    check(Number.isFinite(staleAfterMs) && staleAfterMs > 0,
      500, "invalid_heartbeat_config", "staleAfterMs must be positive");
    this.staleAfterMs = staleAfterMs;
    // Push delivery transport (RC-2026-09-24-203). Production leaves both
    // null: postDelivery then uses the real fetch and real DNS. Tests inject
    // mocks via setPushTransport so the push path never touches the network.
    this.pushFetchImpl = null;
    this.pushDnsResolvers = null;
    // Fire-and-forget push POSTs in flight; flushPushes() awaits them.
    this._pushInflight = [];
    // RC-2026-09-28-3602: in-process wake waiters for the room-hosted poll.
    // agentId+hostId -> { roomId, onWake }. One waiter per host: a second
    // waiter with the same hostId releases the first (it resolves
    // immediately so a reconnecting host never wedges the slot), while a
    // different host's wait is never disturbed. In-memory only — a restart
    // drops waiters, never the durable signals they wait on.
    this._wakeWaiters = new Map();
  }

  now() { return this.store.now(); }

  // Read-only never migrates: verify the additive tables only when present.
  verifySchema({ allowAbsent = false } = {}) {
    const normalize = sql => sql?.trim().replace(/;$/, "").replace(/IF NOT EXISTS /g, "").replace(/\s+/g, " ");
    const expected = agentHeartbeatSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean)
      .map(sql => ({ sql, actual: this.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(/^CREATE (?:TABLE|INDEX) (?:IF NOT EXISTS )?([a-z_]+)/.exec(sql.trim())[1])?.sql }));
    if (allowAbsent && expected.every(({ actual }) => actual === undefined)) return false;
    for (const { sql, actual } of expected) {
      if (normalize(actual) !== normalize(sql)) throw new Error("Agent heartbeat schema requires operator reconciliation");
    }
    return true;
  }

  // plan-wake-live: stamp the agent's last-polled-at. Polls and
  // heartbeats both prove the host is listening (a heartbeat response
  // carries the pending wake queue), so both count as poll activity.
  recordPollActivity(agentId, at = this.now()) {
    this.db.prepare(`INSERT INTO agent_wake_polls (agent_id, last_polled_at)
      VALUES (?, ?) ON CONFLICT(agent_id) DO UPDATE SET last_polled_at=excluded.last_polled_at`)
      .run(agentId, at);
    return this;
  }

  // plan-wake-live: wakeable = the agent polled or heartbeated within
  // WAKEABLE_WINDOW_MS. Agents that never polled (including host rows
  // from before agent_wake_polls existed) read as not wakeable with a
  // null stamp — never as an error. The COMMS-02 mention-target-warning
  // surface consumes this to warn the poster before @mentioning an
  // idle agent.
  wakeStatusOf(agentId) {
    checkAgentId(agentId);
    let row = null;
    try {
      row = this.db.prepare(
        "SELECT last_polled_at AS lastPolledAt FROM agent_wake_polls WHERE agent_id=?").get(agentId);
    } catch (error) {
      if (!isMissingTable(error)) throw error;
      // Pre-migration DB without agent_wake_polls (read-only opens never
      // migrate): read as not wakeable, mirroring wakeStatusList.
      row = null;
    }
    const lastPolledAt = row?.lastPolledAt ?? null;
    return Object.freeze({
      agentId, lastPolledAt, windowMs: WAKEABLE_WINDOW_MS,
      wakeable: lastPolledAt !== null && this.now() - lastPolledAt <= WAKEABLE_WINDOW_MS,
    });
  }

  // plan-wake-live: every registered agent partitioned into the wakeable
  // list and the not-wakeable list. Read-only; never migrates (an older
  // DB without agent_wake_polls lists everyone as not wakeable; a
  // pre-heartbeat DB without any of the tables lists nobody at all).
  wakeStatusList() {
    const at = this.now();
    let rows;
    try {
      rows = this.db.prepare(`SELECT h.agent_id AS agentId, p.last_polled_at AS lastPolledAt
        FROM (SELECT DISTINCT agent_id FROM agent_hosts) h
        LEFT JOIN agent_wake_polls p ON p.agent_id = h.agent_id
        ORDER BY h.agent_id`).all();
    } catch (error) {
      if (!isMissingTable(error)) throw error;
      rows = [];
      try {
        rows = this.db.prepare("SELECT DISTINCT agent_id AS agentId FROM agent_hosts ORDER BY agent_id")
          .all().map(row => ({ agentId: row.agentId, lastPolledAt: null }));
      } catch (error) {
        if (!isMissingTable(error)) throw error;
        // Pre-heartbeat DB without agent_hosts either (read-only opens
        // never migrate): nobody registered, both lists stay empty.
      }
    }
    const wakeable = [], notWakeable = [];
    for (const row of rows) {
      const lastPolledAt = row.lastPolledAt ?? null;
      const entry = Object.freeze({ agentId: row.agentId, lastPolledAt });
      (lastPolledAt !== null && at - lastPolledAt <= WAKEABLE_WINDOW_MS ? wakeable : notWakeable).push(entry);
    }
    return Object.freeze({
      windowMs: WAKEABLE_WINDOW_MS, asOf: at,
      wakeable: Object.freeze(wakeable), notWakeable: Object.freeze(notWakeable),
    });
  }

  // Record a heartbeat from one of the agent's hosts. Upserts the host row
  // and returns the host plus the agent's currently pending wake signals.
  // Pending signals are NOT marked delivered here — the host acknowledges
  // them via ackWakes once it has actually handled them.
  //
  // RC-2026-09-24-203: cadenceSeconds (optional) declares the host's poll
  // cadence and drives its reachability window; pushNotification (optional)
  // registers a push subscription for the wake path. One subscription per
  // (agent, host): each heartbeat replaces the host's push config — a body
  // that carries pushNotification stores it fresh (resetting the failure
  // counters, which re-arms a suspended subscription); a body without it
  // leaves the existing subscription untouched, so old heartbeat bodies
  // keep working unchanged.
  heartbeat({ agentId, hostId, mode, wakeUrl = null, cadenceSeconds = null, pushNotification = null, workWakes = undefined, workScopeRoomId = null }) {
    checkAgentId(agentId);
    checkHostId(hostId);
    check(workWakes === undefined || typeof workWakes === "boolean", 422, "invalid_heartbeat", "workWakes must be a boolean");
    // RC-2026-09-28-3602: wakeable is the default; mode may be null when the
    // caller omits it. An explicitly invalid value still fails.
    const effectiveMode = mode === undefined || mode === null ? "wakeable" : mode;
    check(MODES.includes(effectiveMode), 422, "invalid_heartbeat",
      `mode must be one of ${MODES.join(", ")}`);
    if (cadenceSeconds !== null && cadenceSeconds !== undefined) checkCadenceSeconds(cadenceSeconds);
    const push = (pushNotification === null || pushNotification === undefined)
      ? null : checkPushNotification(pushNotification);
    // RC-2026-09-28-3602: wakeUrl is optional for wakeable hosts — without
    // one the host is reached through the room-hosted wake poll; with one
    // it also gets the true-push journal fan-out. pull-only stays
    // self-driven: no push URL.
    let url = null;
    if (effectiveMode === "wakeable") {
      if (wakeUrl !== null && wakeUrl !== undefined) {
        try { url = validateWebhookUrl(wakeUrl); }
        catch (error) { fail(422, "invalid_heartbeat", `invalid wakeUrl: ${error.message}`); }
      }
    } else if (wakeUrl !== null && wakeUrl !== undefined) {
      fail(422, "invalid_heartbeat", "pull-only hosts cannot register a wake URL");
    }
    const at = this.now();
    this.db.prepare(`INSERT INTO agent_hosts
      (agent_id, host_id, mode, wake_url, last_seen_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, host_id) DO UPDATE SET mode=excluded.mode,
        wake_url=excluded.wake_url, last_seen_at=excluded.last_seen_at,
        updated_at=excluded.updated_at`)
      .run(agentId, hostId, effectiveMode, url, at, at, at);
    // plan-wake-live: heartbeat activity proves the host is listening.
    this.recordPollActivity(agentId, at);
    // The push/cadence row tracks the latest heartbeat; push fields change
    // only when the body carries pushNotification (never on bare
    // heartbeats), and a fresh subscription resets failures/suspension.
    this.db.prepare(`INSERT INTO agent_push_configs
      (agent_id, host_id, cadence_seconds, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(agent_id, host_id) DO UPDATE SET
        cadence_seconds=excluded.cadence_seconds, updated_at=excluded.updated_at`)
      .run(agentId, hostId, cadenceSeconds ?? null, at);
    if (push) {
      this.db.prepare(`UPDATE agent_push_configs
        SET push_url=?, push_token=?, push_auth_json=?, push_failures=0, push_suspended=0, updated_at=?
        WHERE agent_id=? AND host_id=?`)
        .run(push.url, push.token, push.authJson, at, agentId, hostId);
    }
    if (workWakes !== undefined) this.store.workWakes.setHost(agentId, hostId, workWakes, workScopeRoomId);
    const cadence = cadenceSeconds ?? null;
    const host = hostView(this.db.prepare(
      "SELECT * FROM agent_hosts WHERE agent_id=? AND host_id=?").get(agentId, hostId), cadence);
    const pushRow = this.db.prepare(
      "SELECT push_url AS pushUrl, push_suspended AS pushSuspended FROM agent_push_configs WHERE agent_id=? AND host_id=?")
      .get(agentId, hostId);
    const pushConfigured = pushRow?.pushUrl != null;
    const pushSuspended = pushRow?.pushSuspended === 1;
    const windowMs = this.windowFor(cadence);
    const reachableUntil = host.lastSeenAt + windowMs;
    // "push": wakeable host, usable push subscription, inside the window.
    // "poller": inside the window but no usable push. "none": stale.
    // RC-2026-09-28-3602: effectiveMode — mode defaults to wakeable.
    const reachability = Object.freeze({
      mode: at > reachableUntil ? "none"
        : (effectiveMode === "wakeable" && pushConfigured && !pushSuspended ? "push" : "poller"),
      reachableUntil,
    });
    const page = this.pendingWakePage(agentId, { hostId, roomId: workScopeRoomId });
    return Object.freeze({
      host: { ...host, workWakes: this.store.workWakes?.hostEnabled(agentId, hostId) ?? false },
      pendingWakes: page.signals, more: page.more,
      pushConfigured, pushSuspended, reachability,
    });
  }

  // Per-host reachability window (RC-2026-09-24-203):
  // max(baseWindow, cadenceSeconds * 1.5). Undeclared cadence reads the
  // 180s default.
  windowFor(cadenceSeconds) {
    const cadence = Number(cadenceSeconds);
    const cadenceMs = Number.isFinite(cadence) && cadence > 0 ? cadence * 1500 : 0;
    return Math.max(this.staleAfterMs, cadenceMs);
  }

  // Async subscribe-time DNS-rebinding check for a push url. The route
  // awaits this BEFORE the sync heartbeat() upsert stores anything, so a
  // hostname that resolves internal never lands in the table. Resolvers
  // are injectable (setPushTransport) so tests never touch the network;
  // omitted they default to the real resolver (fail closed in production).
  async assertPushDns(url) {
    try {
      await assertWebhookHostDnsPublic(url, this.pushDnsResolvers ?? {});
    } catch (error) {
      fail(422, "invalid_heartbeat", `pushNotification.url rejected: ${error.message}`);
    }
    return url;
  }

  // Override the push delivery transport (fetch impl + DNS resolvers).
  // Production never calls this: postDelivery then uses the DNS-pinned
  // transport on Node (plain fetch on Workers) and the real DNS resolver.
  // Tests inject mocks here.
  setPushTransport({ fetchImpl = null, dnsResolvers = null } = {}) {
    this.pushFetchImpl = fetchImpl;
    this.pushDnsResolvers = dnsResolvers;
    return this;
  }

  // Eligible push targets for an agent: wakeable hosts with a configured,
  // non-suspended push subscription, and only when the agent is offline.
  // This push policy is separate from durable wake queue eligibility:
  // fresh heartbeat presence does not prove message delivery.
  // Never throws for missing tables (older DB) — returns no
  // targets. The returned targets carry the token only in memory; it is
  // never logged and never enters room state.
  pushTargets(agentId) {
    try {
      checkAgentId(agentId);
      const status = this.statusOf(agentId);
      if (status.status !== "offline") return Object.freeze([]);
      const configs = new Map(this.db.prepare(
        "SELECT host_id AS hostId, push_url AS pushUrl, push_token AS pushToken, push_suspended AS pushSuspended FROM agent_push_configs WHERE agent_id=?")
        .all(agentId).map(row => [row.hostId, row]));
      const targets = [];
      for (const host of status.hosts) {
        if (host.mode !== "wakeable") continue;
        const config = configs.get(host.hostId);
        if (!config || !config.pushUrl || config.pushSuspended) continue;
        targets.push(Object.freeze({ agentId, hostId: host.hostId, url: config.pushUrl, token: config.pushToken }));
      }
      return Object.freeze(targets);
    } catch (error) {
      if (!isMissingTable(error)) throw error;
      return Object.freeze([]);
    }
  }

  // Fire-and-forget push fan-out for one room event. The synchronous part
  // (offline gating + target selection) runs on the request path; each
  // POST runs async and its outcome updates the durable failure counters.
  // Total: the push path can never fail or delay the caller's command.
  pushNotify({ identityId, eventType, roomId, id, ts } = {}) {
    try {
      check(typeof identityId === "string" && identityId.length > 0, 422, "invalid_heartbeat", "identityId is required");
      check(PUSH_EVENT_TYPES.includes(eventType), 422, "invalid_heartbeat", `eventType must be one of ${PUSH_EVENT_TYPES.join(", ")}`);
      for (const target of this.pushTargets(identityId)) {
        const pending = this.deliverPush({ ...target, eventType, roomId, id, ts }).catch(() => {});
        // M-3: settled deliveries self-remove — without this, one settled
        // promise is retained per offline wakeable host per event, forever.
        this._pushInflight.push(pending);
        pending.then(() => {
          const at = this._pushInflight.indexOf(pending);
          if (at >= 0) this._pushInflight.splice(at, 1);
        });
      }
    } catch {
      // The push path never fails the caller.
    }
    return this;
  }

  // Test helper: await every push POST scheduled so far.
  async flushPushes() {
    const pending = this._pushInflight.splice(0, this._pushInflight.length);
    await Promise.all(pending);
  }

  // POST one push doorbell. Pointer-only body — never message bodies; the
  // receiver pulls the real event from its agent inbox. 2xx within 5s is
  // delivered (failures reset); anything else increments push_failures,
  // and 3 consecutive failures suspend the subscription until the agent
  // re-arms it with a fresh pushNotification.
  async deliverPush({ agentId, hostId, url, token, eventType, roomId, id, ts }) {
    const envelope = Object.freeze({ eventType, roomId, id, ts });
    const headers = Object.freeze({
      "Content-Type": "application/json",
      "X-Room-Notification-Token": token,
    });
    let result;
    try {
      // No fetchImpl here: production uses postDelivery's DNS-pinned
      // transport (M-1 fix). Tests inject one via setPushTransport.
      result = await postDelivery({
        ...(this.pushFetchImpl ? { fetchImpl: this.pushFetchImpl } : {}),
        url, envelope, headers,
        timeoutMs: PUSH_DELIVERY_TIMEOUT_MS,
        dnsResolvers: this.pushDnsResolvers ?? undefined,
      });
    } catch (error) {
      result = { ok: false, error: String(error?.message ?? error).slice(0, 500) };
    }
    const at = this.now();
    if (result.ok) {
      this.db.prepare("UPDATE agent_push_configs SET push_failures=0, updated_at=? WHERE agent_id=? AND host_id=?")
        .run(at, agentId, hostId);
    } else {
      const row = this.db.prepare(
        "SELECT push_failures AS pushFailures FROM agent_push_configs WHERE agent_id=? AND host_id=?")
        .get(agentId, hostId);
      const failures = (row?.pushFailures ?? 0) + 1;
      this.db.prepare(`UPDATE agent_push_configs
        SET push_failures=?, push_suspended=?, updated_at=? WHERE agent_id=? AND host_id=?`)
        .run(failures, failures >= PUSH_SUSPEND_AFTER_FAILURES ? 1 : 0, at, agentId, hostId);
    }
    return result;
  }

  // Mark wake signals delivered after the host handled them. Returns the
  // ids that were actually pending (unknown or already-delivered ids are
  // reported, not applied — ack is idempotent).
  ackWakes({ agentId, signalIds, roomId = null }) {
    checkAgentId(agentId);
    check(Array.isArray(signalIds) && signalIds.length > 0
      && signalIds.every(id => typeof id === "string" && id.length > 0),
      422, "invalid_heartbeat_ack", "signalIds must be a non-empty string array");
    const at = this.now();
    const acknowledged = [];
    const stmt = this.db.prepare(
      "UPDATE agent_wake_signals SET delivered_at=? WHERE agent_id=? AND signal_id=? AND delivered_at IS NULL AND (? IS NULL OR room_id=?)");
    for (const signalId of signalIds) {
      if (stmt.run(at, agentId, signalId, roomId, roomId).changes > 0) acknowledged.push(signalId);
    }
    acknowledged.push(...(this.store.workWakes?.ack(agentId, signalIds, roomId) ?? []));
    return Object.freeze({ acknowledged: Object.freeze(acknowledged) });
  }

  // Enqueue a wake signal for an agent (mention or DM). Coalesced on
  // (agent_id, message_id): the same message wakes an agent exactly once.
  enqueueWake({ agentId, kind, roomId = null, messageId }) {
    checkAgentId(agentId);
    check(WAKE_KINDS.includes(kind), 422, "invalid_wake",
      `kind must be one of ${WAKE_KINDS.join(", ")}`);
    check(typeof messageId === "string" && messageId.length > 0,
      422, "invalid_wake", "messageId must be a non-empty string");
    check(roomId === null || (typeof roomId === "string" && roomId.length > 0),
      422, "invalid_wake", "roomId must be a non-empty string or null");
    const at = this.now();
    const signalId = `ws_${at.toString(36)}${randomBytes(6).toString("base64url")}`;
    const applied = this.db.prepare(`INSERT OR IGNORE INTO agent_wake_signals
      (signal_id, agent_id, kind, room_id, message_id, created_at, delivered_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL)`).run(signalId, agentId, kind, roomId, messageId, at);
    const row = this.db.prepare(
      "SELECT * FROM agent_wake_signals WHERE agent_id=? AND message_id=?").get(agentId, messageId);
    // RC-2026-09-28-3602: a genuinely new signal releases the room-hosted
    // poll waiter (coalesced duplicates don't — nothing new arrived).
    if (applied.changes > 0) this._releaseWakeWaiter(agentId, roomId);
    return Object.freeze({ enqueued: applied.changes > 0, signal: signalView(row) });
  }

  // Undelivered wake signals, oldest first, capped at the caller's limit.
  pendingWakes(agentId, options = {}) {
    return this.pendingWakePage(agentId, options).signals;
  }

  // One page of unacknowledged signals for the host's rooms, oldest first.
  // `more` is true when a signal remains past the cap. Fetching one extra
  // row from each source is enough: the oldest page takes at most `limit`
  // rows from either source.
  pendingWakePage(agentId, { limit = MAX_PENDING_WAKES, roomId = null, hostId = null } = {}) {
    checkAgentId(agentId);
    check(Number.isInteger(limit) && limit > 0 && limit <= MAX_PENDING_WAKES,
      422, "invalid_heartbeat", `limit must be 1..${MAX_PENDING_WAKES}`);
    const probe = limit + 1;
    const messages = this.db.prepare(`SELECT * FROM agent_wake_signals
      WHERE agent_id=? AND delivered_at IS NULL AND (? IS NULL OR room_id=?) ORDER BY created_at ASC LIMIT ?`)
      .all(agentId, roomId, roomId, probe).map(signalView);
    const work = this.store.workWakes?.pending(agentId, { roomId, hostId, limit: probe }) ?? [];
    const combined = [...messages, ...work].sort((a, b) => a.createdAt - b.createdAt);
    return Object.freeze({
      signals: Object.freeze(combined.slice(0, limit)),
      more: combined.length > limit,
    });
  }

  // RC-2026-09-28-3602: room-hosted wake poll — a synchronous, durable,
  // non-consuming read of the agent's pending wake signals. When called
  // before any wait, it returns the current pending set immediately (so
  // the HTTP wait layer can release instantly on a signal that landed
  // between requests); called after a wait it returns the fresh set.
  // Registration is established by heartbeat(), so notePoll refuses
  // unregistered agents the same way presence reads report them
  // "unregistered" — an unknown agent has nothing to wait on. This never
  // acknowledges: signals leave the queue only through ackWakes().
  notePoll({ agentId, roomId = null }) {
    checkAgentId(agentId);
    let known = null;
    try {
      known = this.db.prepare("SELECT 1 FROM agent_hosts WHERE agent_id=? LIMIT 1").get(agentId);
    } catch (error) {
      if (!isMissingTable(error)) throw error;
      // Pre-heartbeat DB without agent_hosts (read-only opens never
      // migrate): no host ever reported, so the agent is unregistered.
    }
    if (!known) return Object.freeze({ agentId, registered: false, pendingWakes: Object.freeze([]) });
    // plan-wake-live: the poll itself is listener evidence — best-effort on
    // pre-migration DBs without agent_wake_polls (read-only never migrates).
    // The pending-wake read below still serves; only the stamp is skipped.
    // recordPollActivity stays loud for its write-path caller heartbeat():
    // a missing stamp table there is a real problem, not a legacy DB.
    try { this.recordPollActivity(agentId); } catch (error) { if (!isMissingTable(error)) throw error; /* no stamp table yet */ }
    return Object.freeze({
      agentId, registered: true, pendingWakes: this.pendingWakes(agentId, { roomId }),
    });
  }

  // RC-2026-09-28-3602: register one in-process waiter per HOST for the
  // agent's next wake signal. Returns a release function (idempotent).
  // onWake fires when enqueueWake lands a NEW signal matching the waiter's
  // roomId filter (null matches every room). Reconnecting with the same
  // hostId replaces only that host's waiter, so a stale slot never wedges
  // a host — and a second host's wait is never disturbed (per-agent
  // replacement caused a two-host livelock: each poll released the other
  // and neither ever waited).
  addWakeWaiter(agentId, hostId, { roomId = null, onWake }) {
    checkAgentId(agentId);
    checkHostId(hostId);
    check(typeof onWake === "function", 500, "invalid_wake_waiter", "onWake must be a function");
    const key = `${agentId}\0${hostId}`;
    const previous = this._wakeWaiters.get(key);
    const entry = { roomId, onWake };
    this._wakeWaiters.set(key, entry);
    if (previous && previous !== entry) {
      try { previous.onWake(); } catch { /* a throwing waiter must not break the new one */ }
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this._wakeWaiters.get(key) === entry) this._wakeWaiters.delete(key);
    };
  }

  // Release every waiter held by the agent's hosts when a new signal lands
  // (roomId-scoped). Never throws — the wake path must not fail the
  // message post.
  _releaseWakeWaiter(agentId, roomId) {
    try {
      const prefix = `${agentId}\0`;
      for (const [key, waiter] of this._wakeWaiters) {
        if (!key.startsWith(prefix)) continue;
        if (waiter.roomId !== null && waiter.roomId !== roomId) continue;
        this._wakeWaiters.delete(key);
        waiter.onWake();
      }
    } catch { /* waiters are best-effort; the durable queue is the contract */ }
  }

  // Effective presence for an agent: online when any host was seen inside
  // its own reachability window, offline when every host is stale,
  // unregistered when no host ever reported.
  //
  // RC-2026-09-24-203: the window is per host — max(180s, cadenceSeconds *
  // 1.5) — read from the host's push/cadence row; hosts that never declared
  // a cadence read the 180s default.
  statusOf(agentId) {
    checkAgentId(agentId);
    const at = this.now();
    let hosts;
    try {
      hosts = this.db.prepare("SELECT * FROM agent_hosts WHERE agent_id=? ORDER BY last_seen_at DESC")
        .all(agentId);
    } catch (error) {
      if (!isMissingTable(error)) throw error;
      // Pre-heartbeat DB without agent_hosts (read-only opens never
      // migrate): no host ever reported — read as unregistered, never an
      // error. presenceForCard promises null for absent heartbeat tables;
      // that promise runs through this shape.
      return Object.freeze({ agentId, status: "unregistered", lastSeenAt: null, hosts: Object.freeze([]) });
    }
    if (hosts.length === 0) {
      return Object.freeze({ agentId, status: "unregistered", lastSeenAt: null, hosts: Object.freeze([]) });
    }
    let cadences = new Map();
    try {
      cadences = new Map(this.db.prepare(
        "SELECT host_id AS hostId, cadence_seconds AS cadenceSeconds FROM agent_push_configs WHERE agent_id=?")
        .all(agentId).map(row => [row.hostId, row.cadenceSeconds]));
    } catch (error) {
      if (!isMissingTable(error)) throw error;
      // Older database without the push table: every host reads the
      // default window (read-only never migrates).
    }
    const withState = hosts.map(row => {
      const cadenceSeconds = cadences.get(row.host_id) ?? null;
      const windowMs = this.windowFor(cadenceSeconds);
      const view = hostView(row, cadenceSeconds);
      return Object.freeze({ ...view, state: at - view.lastSeenAt <= windowMs ? "online" : "stale" });
    });
    const online = withState.some(host => host.state === "online");
    return Object.freeze({
      agentId,
      status: online ? "online" : "offline",
      lastSeenAt: withState[0].lastSeenAt,
      hosts: Object.freeze(withState),
    });
  }

  // Queue a wake for every agent that has registered at least one host.
  // Mode and presence do not matter. An agent with no host has nowhere to
  // deliver the signal. Coalescing stays on agent plus message.
  wakeIfOffline({ agentId, kind, roomId = null, messageId }) {
    checkAgentId(agentId);
    if (this.statusOf(agentId).hosts.length === 0)
      return Object.freeze({ woken: false, signal: null });
    const { enqueued, signal } = this.enqueueWake({ agentId, kind, roomId, messageId });
    return Object.freeze({ woken: true, enqueued, signal });
  }
}
export { MODES, WAKE_KINDS, STATUSES, HOST_ID_PATTERN };
