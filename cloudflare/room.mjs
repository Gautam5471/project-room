// JDOT-PUBLIC-CSP-RUM begin: outer-response policy
import { publicPageCsp } from "../deploy/public-search.mjs";
// JDOT-PUBLIC-CSP-RUM end
import { GmailSync } from '../server/gmail-sync.mjs';
import { GmailMailbox, gmailConfig } from '../server/gmail-mailbox.mjs';
import { DurableObject } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';
import { isIP } from 'node:net';
import { AsyncLocalStorage } from 'node:async_hooks';
import { RoomStore } from '../server/store.mjs';
import { stitchConfigFromEnv } from '../server/inbox-stitch.mjs';
import { createRoomServer } from '../server/http.mjs';
import { vapidFromEnv } from '../server/push-subscriptions.mjs';
import { googleConfig } from '../server/google-oauth.mjs';
import { ChannelWebhookInbox } from '../server/channel-import.mjs';
import { createMagicLinkMailer } from '../server/magic-links.mjs';
import { magicLinkMailerFromEnv } from '../server/resend-mailer.mjs';
import { ChannelDrainer } from '../server/channel-drain.mjs';
import { DurableDatabase, durableStorage } from './storage.mjs';
import { bootstrapRoom } from './bootstrap.mjs';
import { maintenanceEnabled, maintenanceResponse } from '../server/maintenance.mjs';
import { isEdgeDoorUrl, EDGE_DOOR_HOSTS, rewriteRoomApiPrefix, isHealthAliasPath } from '../deploy/agent-discovery.mjs';
// E1 — email inbound (Worker email() handler). These must come after the
// imports above: server/channel-adapters/index.mjs has a module-init order
// constraint and is only safely evaluated after store.mjs/http.mjs.
import { durableInboundEmailConsumer, emailRoutingLimits, emailRoutingRejections } from '../server/email-routing-inbound.mjs';
import { RETENTION_TABLES, runLiveStoreRetention } from '../server/retention-run.mjs';
import { backfillPublicReadModel as fillPublicReadModel } from '../server/public-read-model.mjs';
import { pruneAbuseRateBuckets } from '../server/abuse-rate-buckets.mjs';
import { pruneOAuthProvider } from '../server/oauth-provider-store.mjs';
import { syncClaimPullRequests } from '../server/claim-pr-sync.mjs';
import { CRON_JOB_BUDGET_MS, HEARTBEAT_STORAGE_KEY, applyOutcomes, jobHealthResponse, jobHealthUnavailable, jobHealthView, runCronJobs, selectWorkerJobs } from './job-heartbeat.mjs';
import { ALARM_RETRY_MS, JOBS, earliestFutureAlarm, jobIsDue, lastRanFrom } from '../server/jobs.mjs';
import { countOpenPublicReports } from '../server/legal-store.mjs'; // open public-report count on GET /api/health/jobs
import { SOURCE_REVISION, BUILD_ID } from '../server/version.mjs';
import { edgePublicResponse } from './edge-public.mjs';
import { appDurationMs, logRoomRequest, requestPath, withServerTiming } from './request-timing.mjs';
import { HEALTH_PROBE_TIMEOUT_MS, createHealthProbe, healthLivenessResponse, readyProbeResponse, workerLivenessResponse } from './health-probe.mjs';
import { exportNdjsonStream, operatorExportResponse } from '../server/room-export.mjs';
import { operatorRestoreResponse } from '../server/restore-ndjson.mjs';
import { flushRoomGuide, installGuideCommandHook } from '../server/room-guide.mjs';

// One probe per isolate. Concurrent health checks during a cold start share
// it; a finished probe does not cache, so the next check sees a fresh answer.
const durableObjectHealth = createHealthProbe();

// Let a request that arrived while this cron RPC was queued run before the
// job's synchronous work closes the input gate again.
function yieldToQueuedRequests() {
  return new Promise(resolve => setTimeout(resolve, 0));
}
function cronDeadline() {
  return Date.now() + CRON_JOB_BUDGET_MS;
}
const RETENTION_CURSOR_KEY = 'retention-table-index';

// The DO transport may erase the original error type. Report availability,
// without exposing backend details or claiming that a mutation rolled back.
function roomUnavailableResponse(request) {
  const pathname = new URL(request.url).pathname;
  const api = pathname.startsWith('/api/') || pathname.startsWith('/room/api/') || pathname === '/mcp' || pathname === '/room/mcp';
  const read = request.method === 'GET' || request.method === 'HEAD';
  const message = 'Project Room is temporarily unavailable. ' + (read
    ? 'Please try again in 30 seconds.'
    : 'The request outcome could not be confirmed. Check its status before repeating it.');
  return new Response(request.method === 'HEAD' ? null : api
    ? JSON.stringify({ error: { code: 'room_unavailable', message } }) : message + '\n', {
    status: 503,
    headers: {
      'Content-Type': api ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store', 'Retry-After': '30',
      'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow'
    }
  });
}

function roomOrigin(env) {
  const origin = new URL(env.ROOM_ORIGIN);
  if (origin.protocol !== 'https:' || origin.origin !== env.ROOM_ORIGIN) throw new Error('Exact HTTPS Room origin required');
  return origin;
}

// One pilot workspace per object, not one object per member. Account/session
// ownership currently spans rooms, so splitting by room would break that contract.
export class ProjectRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // DurableObject stores the context on this.ctx. Keep this.state and this.env
    // as aliases so existing reads of either name stay valid.
    this.state = ctx;
    this.env = env;
    this.requestSignals = new AsyncLocalStorage();
    const origin = roomOrigin(env);
    this.paused = maintenanceEnabled(env.ROOM_MAINTENANCE);
    if (this.paused) return;
    this.store = new RoomStore(null, { database: new DurableDatabase(ctx.storage), storagePlatform: durableStorage,
      stitch: stitchConfigFromEnv(env), identityHashKey: env.ROOM_IDENTITY_HASH_KEY ?? null, integrity: "deferred",
      // Phase 1a: large message bodies at rest outside the projection row.
      bodiesAtRest: env.ROOM_BODIES_AT_REST === "1" });
    // ACT-1a: one delimited call. Room Guide advances after commands. ACT-4 owns nudges.
    installGuideCommandHook(this.store);
    // Event-push dispatch: same fire-and-forget flush as the node entry
    // point. The Durable Object may suspend before the microtask drains;
    // the cron tick remains the restart-safe backstop.
    this.store.agentPlugin.setDispatchKick(() => {
      queueMicrotask(() => {
        this.store.agentPlugin.drainWebhookDeliveries().catch(() => {}).finally(() => {
          this.#armJobAlarm().catch(() => {});
        });
      });
    });
    bootstrapRoom(this.store, env);
    this.store.landQueue.configure({ env });
    // Google sign-in is optional: unconfigured or misconfigured credentials
    // disable the /api/auth/google routes (503) instead of breaking the room.
    let googleAuth = null;
    try { googleAuth = googleConfig(env, env.ROOM_ORIGIN); }
    catch (error) { console.warn(`room google auth disabled: ${error.message}`); }
    let gmailAuth = null;
    try { gmailAuth = gmailConfig(env, env.ROOM_ORIGIN, googleAuth); }
    catch (error) { console.warn(`room Gmail disabled: ${error.message}`); }
    this.gmailSync = gmailAuth ? new GmailSync(new GmailMailbox(this.store, gmailAuth)) : null;
    const deployment = env.ROOM_DEPLOYMENT === 'production' || env.ROOM_DEPLOYMENT === 'staging' ? env.ROOM_DEPLOYMENT : undefined;
    this.server = createRoomServer({ store: this.store, origin: env.ROOM_ORIGIN, assetRoot: origin, serviceMode: env.ROOM_SERVICE_MODE ?? 'cloudflare-staging',
      deployment,
      boardV2Enabled: env.ROOM_BOARD_V2_ENABLED === '1',
      push: vapidFromEnv(env),
      googleAuth,
      gmailAuth,
      // Magic-link email is optional like Google auth: without RESEND_API_KEY
      // the mailer seam reports mail_not_configured instead of breaking boot.
      magicLinkMailer: (() => {
        const send = magicLinkMailerFromEnv(env);
        return send
          ? createMagicLinkMailer({ send, baseUrl: env.ROOM_ORIGIN })
          : createMagicLinkMailer();
      })(),
      // Verified provider webhook updates are journaled in the Durable Object's
      // SQLite (pending_channel_updates), so they survive eviction and restart.
      channelWebhooks: (this.channelWebhooks = new ChannelWebhookInbox(this.store)),
      operatorAccountId: env.ROOM_OPERATOR_ACCOUNT_ID || "",
      resolveRequestSignal: () => this.requestSignals.getStore(),
      loadAsset: async path => {
        const response = await env.ASSETS.fetch(new Request(new URL('/' + path, env.ROOM_ORIGIN)));
        if (!response.ok) throw new Error('Room asset unavailable');
        return Buffer.from(await response.arrayBuffer());
      },
      resolveClientAddress: req => {
        // 2026-09-30 (phase-3 audit LOW-2): trust model documented explicitly.
        // The Durable Object is NOT reachable from the internet — only the
        // front Worker calls this binding, and the Worker overwrites
        // x-room-visitor-ip from Cloudflare's CF-Connecting-IP (validated
        // with isIP() at the Worker boundary) before forwarding. A direct
        // caller cannot spoof this header because they cannot reach the DO.
        // The isIP() check here is defense-in-depth against a misconfigured
        // Worker, not the primary trust boundary.
        const address = req.headers['x-room-visitor-ip'];
        const kind = typeof address === 'string' && isIP(address);
        if (!kind) throw new Error('Trusted visitor address missing');
        return kind === 6 ? new URL(`http://[${address}]`).hostname : address;
      }
    });
    this.handler = httpServerHandler(this.server);
  }
  async fetch(request) {
    const started = Date.now();
    const cold = this.store?.coldStart;
    const respond = response => {
      const appMs = Date.now() - started;
      if (cold && !this.coldStartRequestLogged) {
        this.coldStartRequestLogged = true;
        const line = {
          event: 'room.cold_start', phase: 'first_request',
          constructMs: cold.durationMs, firstRequestMs: appMs,
          rooms: cold.rooms ?? 0, sequences: cold.sequences ?? 0, projectionBytes: cold.projectionBytes ?? 0
        };
        if (cold.phases) line.phases = cold.phases;
        console.info(JSON.stringify(line));
      }
      console.info(JSON.stringify({
        event: 'room.do_request', method: request.method, path: requestPath(request.url), status: response.status, appMs
      }));
      return withServerTiming(response, 'app', appMs);
    };
    if (this.paused) return respond(maintenanceResponse(request));
    const url = new URL(request.url);
    if (url.pathname === '/api/operator/export') {
      return respond(operatorExportResponse(request, this.env.ROOM_BACKUP_TOKEN, this.store.db));
    }
    // Disaster recovery: replay a whole-store NDJSON export into this Durable
    // Object's storage. Same operator token as the export; fail-closed on a
    // non-empty store (see server/restore-ndjson.mjs and docs/BACKUP-DR.md).
    if (url.pathname === '/api/operator/restore') {
      return respond(await operatorRestoreResponse(request, this.env.ROOM_BACKUP_TOKEN, this.store));
    }
    try { return respond(await this.requestSignals.run(request.signal, () => this.handler.fetch(request))); }
    finally {
      this.ctx.waitUntil(this.store.humanPush.flush());
      // ACT-1a: post-request flush for a Room Guide step the command hook left queued.
      this.ctx.waitUntil(Promise.resolve(flushRoomGuide(this.store)));
      // A commit in this request may have queued webhook, land, or claim work.
      this.ctx.waitUntil(this.#armJobAlarm().catch(() => {}));
    }
  }

  // Readiness is one statement. It does not open the room, replay events, or
  // scan a table. A paused object has no database, so it is not ready.
  probeStorage() {
    if (this.paused || !this.store) return { ok: false };
    const row = this.store.db.prepare("SELECT 1 AS ok").get();
    return { ok: row?.ok === 1 };
  }

  async syncGmailMailboxes() {
    if (this.paused) return { completed: 0 };
    await yieldToQueuedRequests();
    // The minute cron does not call this when Gmail is off. A direct call still
    // says so, instead of looking like a mailbox that had nothing to sync.
    if (!this.gmailSync) return { completed: 0, configured: false };
    return this.gmailSync.tick({ deadline: cronDeadline() });
  }

  // Cron heartbeat: the Worker records each tick's per-job outcome here after
  // the jobs settle; GET /api/health/jobs reads it back (no secrets stored).
  async recordCronTick(outcomes) {
    const previous = await this.ctx.storage.get(HEARTBEAT_STORAGE_KEY);
    const next = applyOutcomes(previous, outcomes);
    await this.ctx.storage.put(HEARTBEAT_STORAGE_KEY, next);
    return { recorded: Array.isArray(outcomes) ? outcomes.length : 0 };
  }
  async readJobHealth() {
    const view = jobHealthView(await this.ctx.storage.get(HEARTBEAT_STORAGE_KEY), Date.now(), this.env, this.store);
    return { ...view, publicReports: countOpenPublicReports(this.store) };
  }

  // Task 9 — auto-drain RPC for the Worker's cron trigger. Scans the webhook
  // journal and poison-screens pending slices (both session-free, so they run
  // on schedule); the inbox import itself still needs an owner session (B20
  // system import authority), so slices without one are honestly deferred,
  // never imported. Runs in the DO so no connection data leaves it.
  async drainChannelBacklog() {
    if (this.paused) throw new Error('Room paused');
    await yieldToQueuedRequests();
    const drainer = this.channelDrainer ??= new ChannelDrainer({ store: this.store, webhooks: this.channelWebhooks });
    const gate = drainer.configured();
    if (!gate.configured) return { skipped: 1, configured: false, connections: 0 };
    if (this.channelDrainInflight) return { started: 0, background: 1, inflight: 1, connections: gate.connections };
    const work = this.#drainChannelsInBackground(drainer);
    this.ctx.waitUntil(work);
    return { started: 1, background: 1, connections: gate.connections };
  }
  // Runs after the RPC returns. The first await opens the input gate before
  // any journal scan, and tick yields again between connections. Not an RPC.
  async #drainChannelsInBackground(drainer) {
    this.channelDrainInflight = true;
    try {
      await yieldToQueuedRequests();
      const summary = await drainer.tick({ deadline: cronDeadline(), yieldBetween: () => yieldToQueuedRequests() });
      console.info(JSON.stringify({
        event: 'room.channel_drain', connections: summary.connections ?? 0, deferred: summary.deferred ?? 0,
        errors: summary.errors ?? 0, budgetExceeded: summary.budgetExceeded ? 1 : 0
      }));
      return summary;
    } catch (error) {
      console.error(`[channel-drain] background tick failed: ${error?.message ?? error}`);
      return { errors: 1 };
    } finally {
      this.channelDrainInflight = false;
    }
  }
  // Changed rooms update the checksum. One room per tick is reread so a
  // projection that changes without a new event is still caught. A mismatch
  // replays invitations and legacy projections in slices that yield the
  // input gate. Never called from the constructor.
  async verifyRoomIntegrity() {
    if (this.paused) return { skipped: 1, paused: 1 };
    await yieldToQueuedRequests();
    return this.store.verifyRoomIntegrity({ yieldBetween: () => yieldToQueuedRequests(), deadline: cronDeadline() });
  }
  // RC-2026-09-19-064 — signed webhook dispatch RPC for the Worker's cron
  // trigger. Sweeps due deliveries (pending/failed with next_attempt_at <=
  // now), POSTs each with a fresh timestamped HMAC signature, and advances
  // the pending -> delivered | failed -> dead_letter lifecycle with
  // exponential backoff. Runs in the DO so signing secrets never leave it.
  async drainWebhookDeliveries() {
    if (this.paused) throw new Error('Room paused');
    await yieldToQueuedRequests();
    return this.store.agentPlugin.drainWebhookDeliveries();
  }
  // Land queue: gentle GitHub poll on the per-minute cron. Merged and closed
  // items are skipped, unchanged items back off, and a rate-limit response
  // waits until the reset. A missing token is counted, not thrown, and the
  // token itself is never logged.
  async refreshLandQueue() {
    if (this.paused) return { checked: 0, updated: 0, unconfigured: 0 };
    await yieldToQueuedRequests();
    this.store.landQueue.configure({ env: this.env });
    return this.store.landQueue.refreshDue({ deadline: cronDeadline() });
  }
  // Linked work claims follow the same tick. There is no GitHub webhook
  // receiver; a merged pull completes the claim and a close releases it.
  // The poll is conditional, capped, and waits out a GitHub 403 or 429.
  async refreshClaimPullRequests() {
    if (this.paused) return { checked: 0, updated: 0 };
    await yieldToQueuedRequests();
    // Same 5s budget as the other cron RPCs. The poll itself also stops
    // before the next GitHub call and caps each request to the time left,
    // so a slow pull cannot hold this tick open for the full fetch timeout.
    return syncClaimPullRequests(this.store, {
      env: this.env,
      deadline: cronDeadline(),
      yieldBetween: () => yieldToQueuedRequests()
    });
  }
  // Copies opted-in rooms into the public read model, a bounded batch per tick.
  // Paused rooms return before the store exists. The constructor does not do this.
  async backfillPublicReadModel() {
    if (this.paused) return { done: false, skipped: "paused", rooms: 0, receipts: 0, cards: 0 };
    await yieldToQueuedRequests();
    return fillPublicReadModel(this.store, { limit: 20, deadline: cronDeadline() });
  }
  // Scans only disposable web-fetch/research logs. The deletion flag is
  // explicit; authoritative room and security audit journals are excluded.
  async planRetention() {
    if (this.paused) return { dryRun: true, deleted: 0, skipped: "paused" };
    await yieldToQueuedRequests();
    const stored = await this.ctx.storage.get(RETENTION_CURSOR_KEY);
    const tableIndex = Number.isSafeInteger(stored) ? stored : 0;
    const receipt = runLiveStoreRetention({ store: this.store, env: this.env,
      now: new Date().toISOString(), tableIndex, deadline: cronDeadline(),
      record: plan => { this.lastRetentionPlan = plan; } });
    await this.ctx.storage.put(RETENTION_CURSOR_KEY, (tableIndex + 1) % RETENTION_TABLES.length);
    // Delivered and dead-letter webhook rows are a cache. Pending and failed
    // rows stay until dispatch finishes them. Expired OAuth grants and abuse
    // buckets are the same kind of cache: a room that has never saved one
    // has no table.
    let webhookDeliveries = { deleted: 0 };
    let oauthProvider = { pruned: 0 };
    let abuseRateBuckets = { pruned: 0 };
    try {
      webhookDeliveries = this.store.agentPlugin.pruneWebhookDeliveries();
      oauthProvider = pruneOAuthProvider(this.store.db, { now: Date.now(), limit: 100 });
      abuseRateBuckets = pruneAbuseRateBuckets(this.store.db, { now: Date.now(), limit: 100 });
    } finally {
      console.info(JSON.stringify({
        event: 'room.retention', table: receipt.table, deleted: receipt.deleted,
        dryRun: receipt.dryRun ? 1 : 0, budgetExceeded: receipt.budgetExceeded ? 1 : 0,
        eligible: receipt.categories?.[receipt.table]?.eligible ?? 0,
        webhookDeleted: webhookDeliveries?.deleted ?? 0,
        oauthPruned: oauthProvider?.pruned ?? 0,
        abuseRatePruned: abuseRateBuckets?.pruned ?? 0
      }));
    }
    return { ...receipt, webhookDeliveries, oauthProvider, abuseRateBuckets };
  }
  // Due jobs only. Slow jobs (retention, integrity, backup) run from the
  // safety-net cron. Fast jobs run from the alarm when their nextDueAt arrives.
  async #runDueJobs({ includeSlow }) {
    const stored = await this.ctx.storage.get(HEARTBEAT_STORAGE_KEY);
    const lastRan = lastRanFrom(stored);
    const now = Date.now();
    const selected = selectWorkerJobs(this.env, this.store).filter(job => {
      if (job.slow && !includeSlow) return false;
      return jobIsDue(job, this.store, now, lastRan[job.name]);
    });
    const runners = {};
    for (const job of selected) {
      runners[job.name] = () => job.run(this.store, {
        deadline: Date.now() + (job.budgetMs ?? CRON_JOB_BUDGET_MS),
        env: this.env, room: this, now: () => Date.now()
      });
    }
    const outcomes = await runCronJobs(runners);
    if (outcomes.length) {
      try { await this.recordCronTick(outcomes); }
      catch (error) { console.error(`[job-heartbeat] record failed: ${error?.message ?? error}`); }
    }
    return outcomes;
  }
  // Set the alarm only when the new time is earlier than the one already set.
  // Nothing queued deletes a leftover alarm so an idle room is not woken.
  async #armJobAlarm({ retryDelayMs = 0 } = {}) {
    if (this.paused || !this.store) return { armed: false, alarmAt: null };
    const now = Date.now();
    const stored = await this.ctx.storage.get(HEARTBEAT_STORAGE_KEY);
    let when = earliestFutureAlarm(JOBS, {
      env: this.env, store: this.store, now, lastRan: lastRanFrom(stored), runtime: "worker"
    });
    if (retryDelayMs > 0) {
      const retryAt = now + retryDelayMs;
      when = when == null ? retryAt : Math.min(when, retryAt);
    }
    const current = await this.ctx.storage.getAlarm();
    if (when == null) {
      if (current != null) await this.ctx.storage.deleteAlarm();
      return { armed: false, alarmAt: null };
    }
    if (current != null && current <= when) return { armed: false, alarmAt: current };
    await this.ctx.storage.setAlarm(when);
    return { armed: true, alarmAt: when };
  }
  // Safety-net RPC. Runs anything already due, then re-arms a missing alarm.
  // Reading storage wakes the object, so the Worker cron cannot check "is
  // anything due?" without this wake. The cron stays at 30 minutes.
  async ensureJobAlarm() {
    if (this.paused || !this.store) return { skipped: "paused", armed: false };
    const outcomes = await this.#runDueJobs({ includeSlow: true });
    const armed = await this.#armJobAlarm();
    const failed = outcomes.filter(outcome => !outcome.ok && !JOBS.find(job => job.name === outcome.job)?.slow);
    if (failed.length) throw new Error(`cron jobs failed: ${failed.map(outcome => outcome.job).join(", ")}`);
    return { ...armed, ran: outcomes.map(outcome => outcome.job) };
  }
  // Platform alarm. A throw is rescheduled so a failed tick is not dropped.
  async alarm() {
    if (this.paused || !this.store) return;
    let retryDelayMs = 0;
    try {
      const outcomes = await this.#runDueJobs({ includeSlow: false });
      const failed = outcomes.filter(outcome => !outcome.ok);
      if (failed.length) {
        retryDelayMs = ALARM_RETRY_MS;
        throw new Error(`cron jobs failed: ${failed.map(outcome => outcome.job).join(", ")}`);
      }
    } catch (error) {
      if (!retryDelayMs) retryDelayMs = ALARM_RETRY_MS;
      throw error;
    } finally {
      try { await this.#armJobAlarm({ retryDelayMs }); }
      catch (error) { console.error(`[jobs] alarm re-arm failed: ${error?.message ?? error}`); }
    }
  }
  // Operator and cron export. Returns a stream of NDJSON; callers must not log it.
  exportRoomNdjson() {
    if (this.paused || !this.store) throw new Error('Room paused');
    return exportNdjsonStream(this.store.db);
  }
}

export default {
  async fetch(request, env, ctx) {
    const started = Date.now();
    // JDOT-PUBLIC-CSP-RUM begin: outer-response policy
    const browserOrigin = new URL(request.url).origin;
    let internalPublicPolicy = null, browserPublicPolicy = null;
    // JDOT-PUBLIC-CSP-RUM end
    const finish = (response, servedBy) => {
      // JDOT-PUBLIC-CSP-RUM begin: outer-response policy
      // Door routing rewrites to ROOM_ORIGIN before the edge/DO handles it.
      // Rebase only our known public-page policy, and only after that request
      // passed the existing configured-origin/edge-door guard below.
      if (browserPublicPolicy && response.headers.get('Content-Security-Policy') === internalPublicPolicy) {
        const headers = new Headers(response.headers);
        headers.set('Content-Security-Policy', browserPublicPolicy);
        response = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      }
      // JDOT-PUBLIC-CSP-RUM end
      const totalMs = Date.now() - started;
      const appMs = appDurationMs(response.headers);
      logRoomRequest({ method: request.method, path: requestPath(request.url), status: response.status, totalMs, servedBy, appMs });
      return withServerTiming(response, 'total', totalMs);
    };
    // getdasha edge doors: rewrite onto the Room origin BEFORE the origin
    // check so the worker Host reaches the guard, not the browser Host - the
    // guard 403s anything that is not ROOM_ORIGIN. Packets keep /room;
    // /room/api/* becomes /api/* so identity-create, agent-rooms, and
    // invite redeem hit the same handlers as origin (www /api/* is Webflow).
    if (isEdgeDoorUrl(request.url)) {
      const inbound = new URL(request.url);
      const path = rewriteRoomApiPrefix(inbound.pathname) + inbound.search;
      request = new Request(new URL(path, roomOrigin(env).origin), request);
    } else if (EDGE_DOOR_HOSTS.includes(new URL(request.url).hostname)) {
      // The /room* route also catches /rooms, /roommates and similar lookalikes
      // (an exact pattern would drop /room?ref= query strings). Those are simply
      // not pages here: answer 404, not the 403 meant for a spoofed Host.
      return finish(new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } }), 'worker');
    }
    const url = new URL(request.url);
    // Never derive the trusted origin from a caller-controlled Host header.
    if (url.origin !== roomOrigin(env).origin) return finish(new Response('Unexpected host', { status: 403 }), 'worker');
    // JDOT-PUBLIC-CSP-RUM begin: outer-response policy
    internalPublicPolicy = publicPageCsp(url.origin);
    browserPublicPolicy = publicPageCsp(browserOrigin);
    // JDOT-PUBLIC-CSP-RUM end
    // Storage/DO-independent version signal: answered entirely from module
    // scope and env, never touching the Durable Object, so deploy
    // verification stays available when the DO is down (2026-09-25 outage:
    // /api/version 1101'd with everything else, hiding what was deployed).
    // The durable-object id is derived with idFromName - it names the object
    // this Worker WOULD route to, which is what a door-split check compares;
    // it says nothing about room health. Placed before the maintenance gate
    // and the visitor-address guard so plain monitors always get an answer.
    if ((url.pathname === '/api/version/worker' || url.pathname === '/api/version/worker/') && (request.method === 'GET' || request.method === 'HEAD')) {
      const deployment = env.ROOM_DEPLOYMENT === 'production' || env.ROOM_DEPLOYMENT === 'staging' ? { deployment: env.ROOM_DEPLOYMENT } : {};
      const body = JSON.stringify({
        status: 'ok', servedBy: 'worker', sourceRevision: SOURCE_REVISION, buildId: BUILD_ID, ...deployment,
        durableObject: { name: 'invite-only-pilot', id: env.ROOM.idFromName('invite-only-pilot').toString() }
      });
      return finish(new Response(request.method === 'HEAD' ? null : body, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }), 'worker');
    }
    if (maintenanceEnabled(env.ROOM_MAINTENANCE)) return finish(maintenanceResponse(request), 'worker');
    // HTML, script, and discovery documents are static. Answering them here
    // keeps a cold or busy Durable Object from blanking the page.
    const edge = await edgePublicResponse(request, env, url);
    if (edge) return finish(edge, 'edge');
    // Read-only cron heartbeat (per-job lastSuccessAt / lastError). 503 when a
    // job is stale or failing, so a plain status check catches dead crons.
    if ((url.pathname === '/api/health/jobs' || url.pathname === '/api/health/jobs/') && (request.method === 'GET' || request.method === 'HEAD')) {
      const head = request.method === 'HEAD';
      try { return finish(jobHealthResponse(await env.ROOM.getByName('invite-only-pilot').readJobHealth(), { head }), 'durable-object'); }
      catch (error) { console.error(`[job-heartbeat] read failed: ${error?.message ?? error}`); return finish(jobHealthUnavailable({ head }), 'durable-object'); }
    }
    const address = request.headers.get('CF-Connecting-IP');
    if (!address || !isIP(address)) return finish(new Response('Visitor address unavailable', { status: 403 }), 'worker');
    const headers = new Headers(request.headers);
    // Worker Request.url is the external authority. The Node bridge needs it
    // explicitly; a local runtime's transport Host can be a loopback address.
    headers.set('Host', url.host);
    headers.set('X-Room-Visitor-IP', address);
    headers.delete('X-Real-IP');
    headers.delete('X-Forwarded-For');
    const healthPath = url.pathname.length > 1 && url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
    const deployment = env.ROOM_DEPLOYMENT === 'production' || env.ROOM_DEPLOYMENT === 'staging' ? env.ROOM_DEPLOYMENT : undefined;
    const mode = env.ROOM_SERVICE_MODE ?? 'cloudflare-staging';
    const operationalGet = (request.method === 'GET' || request.method === 'HEAD')
      && (healthPath === '/api/health' || healthPath === '/api/ready' || isHealthAliasPath(url.pathname));
    // These answers never enter the Node origin check. A browser Origin that
    // is not this room is still refused, same as every other /api route.
    if (operationalGet) {
      const originHeader = request.headers.get('Origin');
      if (originHeader && originHeader !== url.origin) {
        return finish(new Response(JSON.stringify({ error: { code: 'origin_denied', message: 'Request origin is not allowed' } }), {
          status: 403, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
        }), 'worker');
      }
    }
    // Liveness is the Worker. It does not construct or query the Durable Object.
    if ((healthPath === '/api/health' || isHealthAliasPath(url.pathname)) && (request.method === 'GET' || request.method === 'HEAD')) {
      return finish(workerLivenessResponse(request, { mode, deployment }), 'worker');
    }
    // Readiness is SELECT 1 on invite-only-pilot, bounded by the probe budget.
    // A cold constructor must not turn this check into room_unavailable.
    if (healthPath === '/api/ready' && (request.method === 'GET' || request.method === 'HEAD')) {
      const probed = await durableObjectHealth({
        timeoutMs: HEALTH_PROBE_TIMEOUT_MS,
        start: async () => {
          const result = await env.ROOM.getByName('invite-only-pilot').probeStorage();
          if (!result?.ok) throw new Error('storage probe failed');
          return new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
        },
        waitUntil: ctx?.waitUntil?.bind(ctx),
        onSnapshot: (snapshot, timing) => ({ response: readyProbeResponse(snapshot, request, { mode, deployment, elapsedMs: timing.elapsedMs }), servedBy: 'durable-object' }),
        onUnready: (readiness, timing) => ({ response: healthLivenessResponse(request, { mode, deployment, readiness, ...timing }), servedBy: 'worker' })
      });
      return finish(probed.response, probed.servedBy);
    }
    let response;
    try {
      response = await env.ROOM.getByName('invite-only-pilot').fetch(new Request(request, { headers }));
    } catch {
      // DO construction can fail before its fetch handler exists. Contain that
      // failure here; never retry a request whose write outcome may be unknown.
      console.error('[room] request failed at Durable Object boundary');
      return finish(roomUnavailableResponse(request), 'durable-object');
    }
    const authFailure = response.headers.get('X-Room-Auth-Failure');
    if (authFailure && /^[a-z][a-z0-9_]{0,63}$/.test(authFailure)) console.warn(`room authentication failed: ${authFailure}`);
    return finish(response, 'durable-object');
  },

  // E1 — Cloudflare Email Routing calls this for every message a routing rule
  // sends to the Worker. message.from / message.to are the SMTP envelope
  // addresses; message.raw is a ReadableStream of the RFC 5322 bytes;
  // message.rawSize is its length; setReject() answers a permanent SMTP error
  // with the reason.
  async email(message, env, ctx) {
    if (maintenanceEnabled(env.ROOM_MAINTENANCE)) { message.setReject(emailRoutingRejections.unavailable); return; }
    // Refuse before reading the stream: the size cap is the first defence.
    if (message.rawSize > emailRoutingLimits.rawBytes) { message.setReject(emailRoutingRejections.tooLarge); return; }
    // Inbox is shelved. Accepting here used to park the message in memory and
    // drop it on eviction. Reject unless a consumer that persists the message
    // is actually wired. A throw from that consumer is still a reject: SMTP
    // must not accept mail we failed to store.
    const consume = durableInboundEmailConsumer();
    if (typeof consume !== "function") { message.setReject(emailRoutingRejections.notAccepted); return; }
    try { await consume(message, env, ctx); }
    catch { message.setReject(emailRoutingRejections.unavailable); }
  },

  // Safety-net cron (wrangler production trigger is every 30 minutes).
  // Reading Durable Object storage always wakes it, so this handler cannot
  // ask "is anything due?" from the Worker. It makes one RPC that runs jobs
  // already due and re-arms the alarm when one is missing. Webhook retries,
  // land-queue polls, and claim polls run from ProjectRoom.alarm() at the
  // next due time. A failed fast job fails this invocation so Cron Events
  // show the exception.
  async scheduled(event, env, ctx) {
    if (maintenanceEnabled(env.ROOM_MAINTENANCE)) return;
    const room = env.ROOM.getByName('invite-only-pilot');
    await room.ensureJobAlarm();
  }
};
