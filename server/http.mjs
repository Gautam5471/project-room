// JDOT-PUBLIC-CSP-RUM begin: public-page policy
import { dmEventVisibility } from "./dm-event-visibility.mjs";
import { publicPageCsp } from "../deploy/public-search.mjs";
// JDOT-PUBLIC-CSP-RUM end
import { acceptPrefersHtml, publicHtmlNotFoundPath, publicSearchAssets, publicSearchCanonical, publicSearchMarketingPolicy, publicSearchSitemap, PUBLIC_NOT_FOUND_HTML, PUBLIC_SEARCH_CSP, PUBLIC_PAGE_LASTMOD, reviewedPublicSearchPaths } from "../deploy/public-search.mjs";
import { readConversation } from "./conversation-sync.mjs";
import { OutsideAgents } from "./outside-agents.mjs";
import { GmailMailbox } from './gmail-mailbox.mjs';
import { publicAssetPaths } from "../deploy/public-assets.mjs";
import { vapidFromEnv } from "./push-subscriptions.mjs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { ServiceError } from "./store.mjs";
import { ABUSE_RATE_FAMILIES, loadAbuseRateBucket, saveAbuseRateBucket } from "./abuse-rate-buckets.mjs";
import { peerEventVisible, visibleBonds } from "./bonds.mjs";
import { clientAddress, STREAM_INTERVAL_DEFAULT_MS } from "./deployment.mjs";
import { isWorkersRuntime } from "./ip-blocklist.mjs";
import { validId, memberCan, MAX_MESSAGE_COMMAND_BYTES } from "../src/events.js";
import { SyntheticInboxTransport, FixtureChannelSender } from "./inbox-transport.mjs";
import { createSendBudgetRegistry } from "./channel-send-budgets.mjs";
import { handleInboxCollab } from "./inbox-collab-routes.mjs"; // Lane C inbox collaboration (task RC-2026-09-18-011).
import { buildActivationPack } from "./room-activation-pack.mjs"; // Room activation pack (quill lane, RC-2026-09-18-040).
import { buildOrient } from "./orient.mjs"; // Orient endpoint (jill lane, RC-2026-09-28 — the URL outside agents guess; ryska's 404).
import { listRoomUpdates, listIdentityUpdates, listAccountUpdates, markUpdate, readEventTail } from "./updates.mjs"; // Updates projection (U batch).
import { handleWorkClaims } from "./work-claim-routes.mjs"; // Work-claim leases/delivery/review (task RC-2026-09-18-041).
import { handleAgentConnect } from "./routes/agent-connect.mjs";
import { listMentionReceipts } from "./mention-receipts.mjs";
import { handleMatchmaking } from "./matchmaking-routes.mjs"; // Arrival surface: declare, offer, match, and human decisions as work.
import { handleFeedback } from "./feedback-routes.mjs"; // Agent /feedback endpoint (structured bug/feature reports).
import { handleBountyEscrow } from "./bounty-escrow-routes.mjs"; // Escrowed bounties + credit ledger (agent work exchange, slice 1).
import { buildOpportunitiesFeed } from "./opportunities.mjs"; // Public opportunity feed v2: read-only open-work discovery, decoupled from admission.
import { telegramConfig, TelegramLiveStatus } from "./channel-adapters/telegram-config.mjs";
import { TelegramTransport } from "./channel-adapters/telegram-transport.mjs";
import { SOURCE_REVISION, BUILD_ID } from "./version.mjs";
import { agentErrorBody, errorCategory, mergeErrorDetail, ERROR_COMMAND_TYPE } from "../src/agent-error.mjs";
import { DiagnosticsLog, supportExportBundle } from "./diagnostics.mjs";
import { renderRoomExportHtml, EXPORT_HTML_CSP } from "./room-export-html.mjs";
import { redactEventPage, redactEventRows, redactMessageTree, redactSnapshotState } from "./redact-read.mjs";
import { messageInHistory, eventInHistory, indexMessages as indexHistoryMessages, requireExportOwner, recordRoomExport } from "./history-visibility.mjs"; // PRIV-2
import { discoveryDoc, isHealthAliasPath, rewriteRoomApiPrefix, EDGE_DOOR_HOSTS, ROOM_ORIGIN } from "../deploy/agent-discovery.mjs";
import { noteIdentityMint } from "./growth-loop.mjs";
import { createWikiReadApi } from "./wiki-read-api.mjs"; // W009: read-only wiki API for agents (prefix-delegated, no route literals here)
import { buildOpenApiJson, discoverabilityErrorOverride, nextActionsForAccessRequest, nextActionsForAccessRequestStatus, nextActionsForInviteRedeem } from "./discoverability.mjs";
import { MCP_SERVER_CARD_PATH, MCP_DISCOVERY_CACHE_CONTROL, MCP_SERVER_CARD_CORS } from "../src/mcp-server-card.mjs";
import { SKILLS_CATALOG_PATH } from "../deploy/agent-discovery.mjs";
// RC-2026-09-24-202: the skills catalog doc object (frozen singleton in
// deploy/agent-discovery.mjs). Aliases (/room/skills, /project-room/skills,
// trailing-slash twins) resolve to this same object via discoveryDoc, so
// identity comparison injects the members array on every alias.
const SKILLS_CATALOG_DOC = discoveryDoc(SKILLS_CATALOG_PATH);
const MCP_SERVER_CARD_DOC = discoveryDoc(MCP_SERVER_CARD_PATH);
import { isRoomMcpPath, writeRoomMcpNode } from "./mcp-http.mjs";
import { isA2aPath, writeA2aNode } from "./a2a-jsonrpc.mjs";
import { mcpAttachmentBodyBytes } from "./room-attachment-bytes.mjs";
import { createHostedRoomMcp } from "./mcp-room-profile.mjs";
import { diagnoseArguments } from "./mcp-arg-errors.mjs";
import { collectNeedsMe } from "./needs-me.mjs";
import { isIdentitySecret } from "./agent-identities.mjs";
import { isPublicRoomDoorPath, wantsPublicDoorHtml, publicRoomAppUrl } from "../deploy/room-entry.mjs";
import { guestAgentLinkContract, GUEST_AGENT_TOKEN_PREFIX, isGuestAgentMemberId } from "./guest-agent-links.mjs";
import { isWebFetchGuest, WebFetchError } from "./web-fetch.mjs";
// Board v2 is retired. Its routes answer 410 board_v2_retired. The
// board_vtwo_* tables stay in place; nothing here drops them.
import { validateClaimText, CLAIM_TEXT_MAX_LENGTH } from "./claim-validate.mjs"; // Synchronous pre-post claim-block validation (RC-2026-09-24-204): pure, no store.
import { getTracer, SPAN_NAMES, ATTR } from "./delivery-tracing.mjs"; // R1 opt-in delivery-path tracing (RC-2026-09-26-966).
import { guestInviteContract } from "./guest-invites.mjs";
import { isSessionStatus } from "../src/work-item-session.js";
import { accessReviewReport } from "./access-review.mjs";
import { roomUsageSummary, parseUsageDays } from "./usage-summary.mjs";
import { AccessRequests, REQUEST_TTL_MS } from "./access-requests.mjs";
import { attentionReport } from "./owner-attention.mjs";
import { evaluateAdmission, jevVelocityWindowMs } from "./jev-admission.mjs";
import { jevShadowReport } from "./jev-shadow-journal.mjs";
import { AgentRooms, ROOM_TOKEN_NOT_IDENTITY } from "./agent-rooms.mjs";
import { API_KEY_PREFIX } from "./agent-api-keys.mjs";
import { createAgentPluginRoutes } from "./agent-plugin-routes.mjs";
import { createNextActionsRoutes } from "./next-actions-routes.mjs"; // RC-2026-09-25-911: ranked per-agent next actions.
import { readSpendAllowance, setSpendAllowance } from "./spend-allowance.mjs";
import { getAgentAutonomyTier, setAgentAutonomyTier } from "./autonomy-tiers.mjs";
import { listAgentGrants, getAgentCapabilities, issueAgentGrant, revokeAgentGrant } from "./grants.mjs";
import { listPins, setPin } from "./pins.mjs";
// (squad roster handlers moved to server/routes/squads.mjs, batch RT)
import { clearBeat, currentTypists, typingBeats, typingKey } from "./typing.mjs";
import { renderReceiptsHtml, renderReceiptDetailHtml, receiptsListJson, receiptJson, RECEIPTS_PAGE_CSP } from "./receipts-page.mjs";
import { queryPublicReceipts, publicReceiptById, listPublicReceiptSitemap, PUBLIC_RECEIPT_ID } from "./receipts-live.mjs";
// --- GR2 public acquisition pages (templates, opt-in room pages, agent directory). ---
import { applyRoomTemplate } from "./templates.mjs";
import { templatesIndex, templatePage, publicRoomView, agentDirectoryView, publicSitemapEntries, PUBLIC_PAGE_CSP } from "./public-rooms.mjs";
// --- end GR2 ---
// --- LEGAL public pages, terms acceptance, abuse reports, operator unpublish (G-SEC-11, G-SEC-14). ---
import { termsStatus } from "./legal-store.mjs";
import { LEGAL_SITEMAP_PATHS } from "./legal-pages.mjs";
import { handleLegalRequest, isLegalPath } from "./legal-routes.mjs";
// --- end LEGAL ---
import {
  listActivity, activityUnreadCount, markActivityRead, markActivityReadAll,
  getReadHorizon, setReadHorizon, listSaved, setSaved
} from "./activity.mjs";
import { listOpenQuestions } from "./open-questions.mjs";
import { GoogleSignIn, GOOGLE_START_PATH, GOOGLE_CALLBACK_PATH, googlePostLoginPage } from "./google-oauth.mjs";
import { createMagicLinkMailer, attemptMailDelivery, validateMagicReturnTo } from "./magic-links.mjs";
import { createRateLimiter } from "./identity-ratelimit.mjs";
import { emailLookupHash, normalizeEmail } from "./account-login-methods.mjs";
import { createPasskeyAuth, resolvePasskeyParams } from "./account-passkeys.mjs";
import { createDeletionSecret, executeAccountDeletion, issueDeletionToken, planAccountDeletion, verifyDeletionToken, RETENTION_POLICY } from "./account-deletion.mjs"; // RC-2026-09-19-078: account-management surface
import { createOperatorRoutes } from "./operator-routes.mjs"; // CP-ADMIN-0: operator purge, status, and audit. Paths stay in that module.
import { hashPassword, checkPasswordPolicy } from "../src/password-auth.mjs";
import { buildGitHubAuthUrl, codeChallengeFor, createPendingStore, exchangeCodeForToken, fetchGitHubUser,
  GitHubOAuthError, GITHUB_START_PATH, GITHUB_CALLBACK_PATH, githubPostLoginPage, githubUnavailablePage } from "./github-oauth.mjs";
import { createOAuthProvider, OAUTH_SCOPES } from "./oauth-provider.mjs";
import { dispatchRoute } from "./routes/dispatch.mjs";

const roomCookieName = "room_session";
const accountCookieName = "account_session";
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const bindingPattern = /^[a-f0-9]{64}$/;
const assetType = path => path.endsWith(".js") || path.endsWith(".mjs") ? "text/javascript" : path.endsWith(".css") ? "text/css"
  : path.endsWith(".html") ? "text/html" : path.endsWith(".svg") ? "image/svg+xml"
  : path.endsWith(".png") ? "image/png" : path.endsWith(".ttf") ? "font/ttf" : path.endsWith(".txt") ? "text/plain"
  : path.endsWith(".webmanifest") ? "application/manifest+json" : path.endsWith(".json") ? "application/json" : path.endsWith(".sh") ? "text/plain"
  : "text/markdown; charset=utf-8";
const assets = new Map([
  ["/", ["index.html", "text/html"]],
  ["/offers", ["offers.html", "text/html"]],
  ...publicAssetPaths.map(path => [`/${path}`, [path, assetType(path)]]),
  // Public AEO buyer-intent pages: extensionless canonical URLs (the .html
  // forms are served by the allowlist spread above).
  ...["project-room-vs-slack", "project-room-vs-discord", "agent-collaboration-tool", "multi-agent-workspace", "ai-agent-coordination", "project-room-vs-agent-room"]
    .map(name => [`/compare/${name}`, [`compare/${name}.html`, "text/html"]]),
]);
for (const [url, file] of publicSearchAssets(publicAssetPaths)) assets.set(url, [file, "text/html"]);
for (const name of ["favicon.svg", "icon.svg", "manifest.webmanifest"]) {
  const asset = assets.get(`/${name}`);
  if (asset) assets.set(`/room/${name}`, asset);
}
// GET/HEAD-only liveness paths; any other method is 405 with Allow (#1529).
const LIVENESS_GET_ONLY_PATHS = new Set(["/api/health", "/api/health/", "/api/version"]);
// W009: the wiki read API owns every /api/wiki/ template inside
// server/wiki-read-api.mjs (reads are lazy per request; import is side-effect-free).
const wikiReadApi = createWikiReadApi();
const reject = (status, code, message, headers) => { throw new ServiceError(status, code, message, headers ?? null); };

// RFC 9116. Contact comes from ROOM_SECURITY_CONTACT. A bare address becomes
// a mailto URI. Anything else must already be mailto: or https:, with no
// line breaks. Unset or unusable values serve 404.
let securityContactWarned = false;
function securityContactFrom(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) return null;
  const contact = trimmed.includes(":") ? trimmed : `mailto:${trimmed}`;
  if (!/^mailto:/i.test(contact) && !/^https:\/\//i.test(contact)) return null;
  return contact;
}
function securityTxtDocument(contact, now = Date.now()) {
  const expires = new Date(now + 365 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return `Contact: ${contact}\nExpires: ${expires}\n`;
}
let emailGatesRelaxedWarned = false;
function warnEmailGatesRelaxed() {
  if (emailGatesRelaxedWarned) return;
  emailGatesRelaxedWarned = true;
  console.warn("No magic-link mailer is configured: email-verification gates are relaxed (agent-invite escape hatch); /api/health reports emailVerification: relaxed-no-mailer");
}
function warnMissingSecurityContact() {
  if (securityContactWarned) return;
  securityContactWarned = true;
  console.warn("ROOM_SECURITY_CONTACT is unset; /.well-known/security.txt returns 404");
}
function warnMissingSecurityContactCheck() {
  if (!securityContactFrom(process.env.ROOM_SECURITY_CONTACT)) warnMissingSecurityContact();
}
function writeSecurityTxt(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") reject(405, "method_not_allowed", "Method not allowed", { Allow: "GET, HEAD" });
  const contact = securityContactFrom(process.env.ROOM_SECURITY_CONTACT);
  if (!contact) {
    warnMissingSecurityContact();
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(req.method === "HEAD" ? undefined : "Not found\n");
    return;
  }
  const body = securityTxtDocument(contact);
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Length", String(Buffer.byteLength(body)));
  res.end(req.method === "HEAD" ? undefined : body);
}
// RFC 8288 discovery hints on machine-readable surfaces: the A2A agent card,
// the llms packet, the skills catalog, and the public HTML door.
const discoveryLinks = url => {
  // The shared entry host serves other products at its apex. Hosted discovery
  // must lead to Room; local and independently hosted instances stay local.
  const base = url.origin === ROOM_ORIGIN || EDGE_DOOR_HOSTS.includes(url.hostname) ? ROOM_ORIGIN : "";
  return [
    `<${base}/.well-known/agent-card.json>; rel="alternate"; type="application/json"`,
    `<${base}/llms.txt>; rel="help"`,
    `<${base}/skills>; rel="describedby"`,
    `<${base}/room>; rel="alternate"; type="text/html"`
  ].join(", ");
};
// --- GR1 public pages: live receipts and the sitemap under the /room prefix.
// Static marketing (/about, /offers, /compare, images) stays off this server.
// The edge serves those, including www.getdasha.com/room/<page>.
const gr1PublicPath = pathname => {
  if (!pathname.startsWith("/room/")) return null;
  const rest = pathname.slice("/room".length);
  if (rest === "/receipts" || rest === "/sitemap.xml") return rest;
  if (/^\/receipts\/(?:pwr_[a-f0-9]{16,128}|wcr_[a-f0-9]{32}|wir_[a-f0-9]{32})(?:\.json)?$/.test(rest)) return rest;
  return null;
};
const PUBLIC_RECEIPT_JSON = /^\/receipts\/(?:pwr_[a-f0-9]{16,128}|wcr_[a-f0-9]{32}|wir_[a-f0-9]{32})\.json$/;
const isPublicReceiptsJson = pathname => pathname === "/api/public/receipts"
  || pathname === "/room/api/public/receipts"
  || PUBLIC_RECEIPT_JSON.test(pathname)
  || (pathname.startsWith("/room") && PUBLIC_RECEIPT_JSON.test(pathname.slice("/room".length)));
const allowPublicReceiptsCors = res => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
};
// --- GR2: /room aliases for the acquisition pages. /room/agents.json stays the discovery packet. ---
const gr2PublicPath = pathname => {
  if (!pathname.startsWith("/room/")) return null;
  const rest = pathname.slice("/room".length);
  if (rest === "/templates" || rest === "/agents" || rest === "/templates.json") return rest;
  if (/^\/templates\/[a-z0-9][a-z0-9-]{0,63}(?:\.json)?$/.test(rest)) return rest;
  if (/^\/r\/[a-z0-9][a-z0-9-]{0,63}(?:\.json)?$/.test(rest)) return rest;
  return null;
};
// --- end GR2 ---
const canonicalLink = pathname => {
  const path = pathname === "/index.html" ? "/" : pathname === "/about.html" ? "/about" : pathname === "/offers.html" ? "/offers" : pathname;
  return `<${ROOM_ORIGIN}${path}>; rel="canonical"`;
};
const publicPageLinks = (url, pathname) => `${discoveryLinks(url)}, ${canonicalLink(pathname)}`;
const pathId = encoded => {
  let id;
  try { id = decodeURIComponent(encoded); } catch { reject(404, "not_found", "Not found"); }
  if (!validId(id)) reject(404, "not_found", "Not found");
  return id;
};
const accountView = auth => ({
  authenticated: Boolean(auth.account),
  account: auth.account ? { id: auth.account.id, revision: auth.account.revision, authEpoch: auth.account.authEpoch } : null,
  csrf: auth.csrf,
  sessionBinding: auth.sessionBinding,
  sessionRevision: auth.sessionRevision,
  expiresAt: auth.expiresAt,
  authenticatedUntil: auth.authenticatedUntil ?? null
});
const sessionView = auth => ({
  authMode: auth.credentialScope === "account-session" ? "account" : "room",
  account: auth.account ? { id: auth.account.id, revision: auth.account.revision, authEpoch: auth.account.authEpoch } : null,
  member: auth.member,
  roomId: auth.roomId,
  csrf: auth.csrf,
  sessionBinding: auth.sessionBinding,
  sessionRevision: auth.sessionRevision ?? null,
  credentialKind: auth.kind,
  expiresAt: auth.expiresAt
});
const exact = (value, fields) => Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
// Providers the browser may reply through from the Inbox. Email stays out until
// an outbound email slice exists; its sources report send: false.
const channelSendProviders = Object.freeze(["telegram-bot"]);
const JSON_BODY_BYTES = 16384;
const rateHash = value => createHash("sha256").update(String(value)).digest("hex");
// A lagging stream that still has not drained its final event by now is dropped.
const STREAM_DRAIN_GRACE_MS = 5000;
// Messages a `?messages=recent` room snapshot carries (the /conversation page maximum).
const SNAPSHOT_RECENT_MESSAGES = 100;

// Least-recently-used bookkeeping for small internal caches (channel senders).
// Returns the cached value for key, marking it most-recently-used; when key is
// absent, makeValue() builds it, the least-recently-used entry is evicted at
// capacity, and the new value is stored. Exported for unit tests.
export function touchLruEntry(map, key, makeValue, capacity) {
  if (map.has(key)) {
    const value = map.get(key);
    map.delete(key);
    map.set(key, value); // mark most-recently-used
    return value;
  }
  while (map.size >= capacity) map.delete(map.keys().next().value); // evict least-recently-used
  const value = makeValue();
  map.set(key, value);
  return value;
}

// A runtime package's reviewed public HTML is immutable for this server's
// lifetime. Retain its successful bytes for BOTH page serving and sitemap
// probes, so the map never advertises bytes the loader cannot actually serve.
// The finite reviewed catalog bounds this cache; failed reads are not retained.
function defaultAssetLoader(assetRoot) {
  const cacheable = new Set([...publicSearchAssets(publicAssetPaths)]
    .filter(([path]) => reviewedPublicSearchPaths.includes(path)).map(([, file]) => file));
  const loaded = new Map();
  return path => {
    if (!cacheable.has(path)) return readFile(new URL(path, assetRoot));
    if (!loaded.has(path)) {
      const pending = readFile(new URL(path, assetRoot));
      loaded.set(path, pending);
      pending.catch(() => { if (loaded.get(path) === pending) loaded.delete(path); });
    }
    return loaded.get(path);
  };
}

// Per-credential write budget for routes that carry no user-authored content.
export const HOUSEKEEPING_WRITE_PER_MINUTE = 240;
export const HOUSEKEEPING_WRITE_ROUTES = Object.freeze(new Set(["cursor", "presence", "activity-read", "activity-read-all", "read-horizon", "saved"]));
export function createRoomServer({ store, origin, assetRoot = new URL("../", import.meta.url), streamInterval = STREAM_INTERVAL_DEFAULT_MS, streamQueueCap = 65536, trustedLocalProxy = false,
  loadAsset = defaultAssetLoader(assetRoot), resolveClientAddress = req => clientAddress(req, trustedLocalProxy),
  resolveRequestSignal = () => null, syntheticInboxTransport = null, channelWebhooks = null, cookieNamespace = "",
  telegram = telegramConfig(), telegramStatus = store?.telegramLiveStatus ?? new TelegramLiveStatus(), channelTransports = null,
  googleAuth = null, gmailAuth = null, directSendFetch = null,
  sendBudgetRegistry = null, sendBudgetEnv = null, // per-connection send budgets (task #41); null = build from env
  passkeyService = null, // test injection for the passkey routes; production uses createPasskeyAuth({ store })
  magicLinkMailer = null,
  githubAuth = null,
  fetchPullRequest = null,
  githubToken = undefined,
  connectorClients = [], // OAuth2 clients for third-party connectors (e.g. [{ clientId, name, redirectUris }])
  serviceMode = trustedLocalProxy ? "invite-only-pilot" : "single-node-pilot", deployment = undefined, growth = null, push = undefined,
  operatorAccountId = (globalThis.process && globalThis.process.env.ROOM_OPERATOR_ACCOUNT_ID) || "" }) {
  // Human browser push stays off until VAPID keys are present. Node reads
  // process.env; the Worker passes its bindings as `push` so a secret never
  // has to live in the source tree.
  if (store?.humanPush) store.humanPush.configure({
    vapid: push === undefined ? vapidFromEnv(globalThis.process?.env ?? {}) : push
  });
  // Live Telegram bindings are read once (Worker secrets or local env); the
  // config never holds up startup and the card reports "not configured".
  if (typeof telegram?.configured !== "boolean" || !Array.isArray(telegram.bindings)) throw new Error("Telegram configuration must come from telegramConfig()");
  if (deployment !== undefined && deployment !== "production" && deployment !== "staging") throw new Error("deployment must be production or staging");
  const sessionAccountView = auth => {
    const view = accountView(auth);
    if (!auth?.account) return view;
    return { ...view, terms: termsStatus(store.db, auth.account.id) };
  };
  // Literals stay in this file so scripts/open-routes.mjs sees the legal API.
  const legalApiPaths = new Set(["/api/reports/public/challenge", "/api/reports/public", "/api/account/terms", "/api/operator/unpublish", "/api/health/jobs"]);
  // The Worker reads ROOM_SECURITY_CONTACT from its binding in edge-public.
  // Logging process.env here would warn on every isolate that has no env var.
  if (!isWorkersRuntime()) warnMissingSecurityContactCheck();
  const deploymentField = deployment ? { deployment } : {};
  // Google sign-in is off unless the caller passes googleConfig(env, origin).
  // The sign-in helper is created lazily so its PKCE/state table lives as long
  // as this server instance (one per Durable Object in production).
  let googleSignIn = null;
  const gmail = gmailAuth ? new GmailMailbox(store, gmailAuth) : null;
  // Magic-link mailer (slice 3). Unconfigured by default: the routes say so
  // honestly (mail_not_configured) and never pretend a code was sent.
  const magicMailer = magicLinkMailer ?? createMagicLinkMailer();
  if (typeof magicMailer.isConfigured !== "function" || typeof magicMailer.sendMagicLink !== "function") {
    throw new Error("magicLinkMailer must come from createMagicLinkMailer()");
  }
  // With no mailer no verification code can be delivered: every email-verification
  // gate (invites, share links, identity mint, a second room) then follows the
  // agent-invites escape hatch instead of deadlocking the account.
  // Optional-chained: option-validation tests build the server on a stub store
  // with no accountLogins; a real store always has it.
  store.accountLogins?.setVerificationUnachievable?.(() => !magicMailer.isConfigured());
  // The mailer is fixed when the server is built, so a deploy that lost its mail
  // secret would otherwise open every email gate without a trace. Say so at boot
  // and report it in /api/health.
  const emailVerification = magicMailer.isConfigured() ? "enforced" : "relaxed-no-mailer";
  if (emailVerification === "relaxed-no-mailer") warnEmailGatesRelaxed();
  // Per-email buckets (hourly) complement the per-address rate() limits below.
  const magicRequestEmailLimiter = createRateLimiter({ capacity: 3, refillPerSecond: 3 / 3600 });
  const resetRequestEmailLimiter = createRateLimiter({ capacity: 3, refillPerSecond: 3 / 3600 });
  const resetConsumeEmailLimiter = createRateLimiter({ capacity: 10, refillPerSecond: 10 / 3600 });
  const magicConsumeEmailLimiter = createRateLimiter({ capacity: 10, refillPerSecond: 10 / 3600 });
  const signupEmailLimiter = createRateLimiter({ capacity: 3, refillPerSecond: 3 / 3600 });
  const magicEmailLimit = (limiter, normalized) => {
    const checked = limiter.check(rateHash(normalized));
    if (!checked.allowed) {
      throw new ServiceError(429, "rate_limited", checked.message, { "Retry-After": String(Math.ceil(checked.retryAfterMs / 1000)) });
    }
  };
  // RC-2026-09-19-078: signs the confirm-then-delete confirmation tokens.
  // Per server instance; tokens are only ever redeemed against the server
  // that issued them.
  const accountDeletionSecret = createDeletionSecret();
  const google = () => {
    if (!googleAuth) return null;
    // Persistent PKCE state: the Durable Object's SQLite survives Worker
    // isolate eviction between the Google redirect and the callback, where
    // the old in-memory Map silently lost the flow (google_state_invalid).
    const pendingStore = {
      create: entry => store.oauthPendingStateCreate(entry),
      consume: (provider, stateHash) => store.oauthPendingStateConsume(provider, stateHash),
      delete: (provider, stateHash) => store.oauthPendingStateDelete(provider, stateHash),
    };
    googleSignIn ??= new GoogleSignIn({ clientId: googleAuth.clientId, clientSecret: googleAuth.clientSecret,
      redirectUri: googleAuth.redirectUri || expectedOrigin() + GOOGLE_CALLBACK_PATH,
      fetchImpl: googleAuth.fetchImpl ?? fetch, now: () => store.now(), pendingStore });
    return googleSignIn;
  };
  // ---- Recovery codes (slice 6, RC-2026-09-17-015) ----
  //
  // Last-resort sign-in for the multi-method login program. A generated set
  // is shown exactly once (never re-displayed, never logged); redeeming one
  // code upgrades an anonymous slot into the account session. Generate and
  // status need an authenticated account session; redeem resolves the account
  // from a verified email hint — the client never supplies a raw account id.
  // The redeem budget is 10 attempts per 15 minutes per email hint (per-IP
  // limits ride on the shared rate() family at the route itself).
  const recoveryRedeemLimiter = createRateLimiter({ capacity: 10, refillPerSecond: 10 / (15 * 60) });
  const recoveryRedeemAllowed = emailHint => {
    const verdict = recoveryRedeemLimiter.check(`recovery-redeem:${rateHash(emailHint)}`);
    if (!verdict.allowed) reject(429, "rate_limited", verdict.message);
  };
  // Long-lived passkey auth service (slice 5, RC-2026-09-17-014): one challenge
  // store per server instance (one per Durable Object in production) so
  // registration/authentication ceremonies survive across the options and
  // finish calls.
  // passkeyService is a test injection point for stubbed verification.
  let passkeyAuthService = null;
  const passkeys = () => passkeyService
    ?? (passkeyAuthService ??= createPasskeyAuth({ store }));
  // GitHub sign-in is off unless the caller passes githubAuth
  // ({ clientId, clientSecret, redirectUri?, fetchImpl? }). The pending
  // state/PKCE table lives as long as this server instance, mirroring the
  // Google helper above (one per Durable Object in production).
  let githubOAuth = null;
  const github = () => {
    if (!githubAuth) return null;
    if (!githubOAuth) {
      const clientId = githubAuth.clientId, clientSecret = githubAuth.clientSecret;
      let redirectUri = githubAuth.redirectUri || expectedOrigin() + GITHUB_CALLBACK_PATH;
      try {
        const parsed = new URL(redirectUri);
        if (parsed.pathname !== GITHUB_CALLBACK_PATH || parsed.search || parsed.hash
          || parsed.username || parsed.password
          || !(parsed.protocol === "https:" || (parsed.protocol === "http:" && parsed.hostname === "127.0.0.1"))) {
          throw new Error("bad redirect");
        }
        redirectUri = parsed.href;
      } catch { throw new Error("Invalid GitHub authentication configuration"); }
      if (typeof clientId !== "string" || !clientId || typeof clientSecret !== "string" || !clientSecret) {
        throw new Error("Invalid GitHub authentication configuration");
      }
      githubOAuth = { clientId, clientSecret, redirectUri, fetchImpl: githubAuth.fetchImpl ?? fetch,
        // Persistent PKCE state (same isolate-eviction fix as Google above).
        pending: createPendingStore({ now: () => store.now(), persistentStore: {
          create: entry => store.oauthPendingStateCreate(entry),
          consume: (provider, stateHash) => store.oauthPendingStateConsume(provider, stateHash),
          delete: (provider, stateHash) => store.oauthPendingStateDelete(provider, stateHash),
        } }) };
    }
    return githubOAuth;
  };
  // OAuth2 authorization server for third-party connectors (e.g. Meta Muse).
  // Unlike the Google/GitHub helpers above (OAuth CLIENTS for sign-in), this
  // is the PROVIDER side: external clients redirect users here to obtain
  // scoped tokens for the Project Room API. One instance per server (one per
  // Durable Object in production); client registry comes from config.
  const oauthProvider = createOAuthProvider({
    db: store.db,
    clock: () => store.now(),
    // F-01 reuse signal: refresh-token reuse (possible theft) revokes the
    // whole token family inside the provider; log it as a structured
    // security line so operators see it, and the token endpoint already
    // answers the reuse attempt with a distinct invalid_grant.
    onSecurityEvent: event => {
      console.warn(`oauth security event: ${JSON.stringify(event)}`);
    },
    // Deleted/deactivated accounts lose connector access immediately: token
    // verification fails closed even if a token row survived a purge.
    isAccountActive: userId => {
      try {
        return store.db.prepare("SELECT active FROM accounts WHERE id=?").get(userId)?.active === 1;
      } catch { return false; }
    },
  });
  for (const c of connectorClients) {
    oauthProvider.registerClient(c);
  }
  // Like emailAccountIdFor (#2434): deleting an account leaves a deactivated
  // tombstone at github:<id> / google:<sub>, and its login methods are gone, so
  // a returning person reaches the provision step below. Take the next free
  // suffix instead of signing them into the tombstone ("Active account
  // required" forever). A live account at the id is returned as is.
  const providerAccountIdFor = base => {
    for (let generation = 1; generation <= 20; generation++) {
      const id = generation === 1 ? base : `${base}.${generation}`;
      const row = store.db.prepare("SELECT active FROM accounts WHERE id=?").get(id);
      if (!row || row.active === 1) return id;
    }
    throw new ServiceError(409, "account_exists", "This sign-in can't start a new account; contact support");
  };
  // GitHub subject -> account linking order (slice 4): an existing OAuth
  // link wins; otherwise a primary verified email links to the account that
  // already owns it; otherwise a github:<id> account is provisioned (with
  // a magic-link method when the provider attested a verified email).
  // linkOAuthMethod rejects cross-account subject reuse with a 409, which
  // surfaces to the caller as-is.
  // Link intent (slice 7): the settings UI starts the flow with link=true
  // so the subject attaches to the currently authenticated account. A
  // subject already owned by a different account 409s instead of silently
  // switching the browser into that account.
  const linkGitHubSubject = ({ subject, email, slotToken = null }) => {
    const logins = store.accountLogins;
    const owner = logins.findAccountByOAuth("github", subject);
    if (owner) {
      if (email) logins.adoptVerifiedEmail(email, { preserveSlotToken: slotToken, preferredAccountId: owner });
      const existing = logins.listMethods(owner).find(m => m.type === "oauth" && m.provider === "github" && !m.disabled);
      return { accountId: owner, methodRef: existing ? existing.id : `github:${subject}` };
    }
    const normalized = email ? normalizeEmail(email) : null;
    const emailOwner = normalized ? logins.adoptVerifiedEmail(normalized, { preserveSlotToken: slotToken })?.accountId ?? null : null;
    if (emailOwner) {
      const method = logins.linkOAuthMethod(emailOwner, { provider: "github", subject, email: normalized });
      return { accountId: emailOwner, methodRef: method.id };
    }
    const accountId = providerAccountIdFor(`github:${subject}`);
    if (!store.db.prepare("SELECT 1 FROM accounts WHERE id=?").get(accountId)) {
      store.createAccount(accountId, "github-oauth");
    }
    const method = logins.linkOAuthMethod(accountId, { provider: "github", subject, email: normalized });
    if (normalized) {
      try { logins.linkMagicMethod(accountId, { email: normalized }); }
      catch (error) {
        if (!(error instanceof ServiceError) || error.code !== "login_method_exists") throw error;
      }
    }
    return { accountId, methodRef: method.id };
  };
  // Link intent (slice 7): attach the GitHub subject to the account that
  // owns the pending session slot. The slot must still be authenticated;
  // a subject owned elsewhere 409s via linkOAuthMethod.
  const linkGitHubSubjectToAccount = ({ subject, email, slotToken }) => {
    let session;
    try {
      session = store.authenticateAccountSession(slotToken);
    } catch (error) {
      if (error.status !== 401) throw error;
      throw new ServiceError(401, "invalid_session", "That sign-in attempt is no longer valid; start again");
    }
    if (!session.account) throw new ServiceError(401, "account_session_required", "Sign in before connecting GitHub");
    const normalized = email ? normalizeEmail(email) : null;
    if (normalized) store.accountLogins.adoptVerifiedEmail(normalized, { preserveSlotToken: slotToken, preferredAccountId: session.account.id });
    const method = store.accountLogins.linkOAuthMethod(session.account.id, { provider: "github", subject, email: normalized });
    return { accountId: session.account.id, methodRef: method.id };
  };
  // Google shared-account linking (RC-2026-09-17-017): mirrors the GitHub
  // find-or-provision order through the shared account-login model instead of
  // provisioning `google:<sub>` directly.
  const linkGoogleSubject = ({ subject, email, slotToken = null }) => {
    const logins = store.accountLogins;
    const owner = logins.findAccountByOAuth("google", subject);
    if (owner) {
      if (email) logins.adoptVerifiedEmail(email, { preserveSlotToken: slotToken, preferredAccountId: owner });
      const existing = logins.listMethods(owner).find(m => m.type === "oauth" && m.provider === "google" && !m.disabled);
      return { accountId: owner, methodRef: existing ? existing.id : `google:${subject}` };
    }
    const normalized = email ? normalizeEmail(email) : null;
    const emailOwner = normalized ? logins.adoptVerifiedEmail(normalized, { preserveSlotToken: slotToken })?.accountId ?? null : null;
    if (emailOwner) {
      const method = logins.linkOAuthMethod(emailOwner, { provider: "google", subject, email: normalized });
      return { accountId: emailOwner, methodRef: method.id };
    }
    const accountId = providerAccountIdFor(`google:${subject}`);
    if (!store.db.prepare("SELECT 1 FROM accounts WHERE id=?").get(accountId)) {
      store.createAccount(accountId, "google-oauth");
    }
    const method = logins.linkOAuthMethod(accountId, { provider: "google", subject, email: normalized });
    if (normalized) {
      try { logins.linkMagicMethod(accountId, { email: normalized }); }
      catch (error) {
        if (!(error instanceof ServiceError) || error.code !== "login_method_exists") throw error;
      }
    }
    return { accountId, methodRef: method.id };
  };
  // Link intent: attach the Google subject to the account that owns the
  // pending session slot. The slot must still be authenticated; a subject
  // owned elsewhere 409s via linkOAuthMethod.
  const linkGoogleSubjectToAccount = ({ subject, email, slotToken }) => {
    let session;
    try {
      session = store.authenticateAccountSession(slotToken);
    } catch (error) {
      if (error.status !== 401) throw error;
      throw new ServiceError(401, "invalid_session", "That sign-in attempt is no longer valid; start again");
    }
    if (!session.account) throw new ServiceError(401, "account_session_required", "Sign in before connecting Google");
    const normalized = email ? normalizeEmail(email) : null;
    if (normalized) store.accountLogins.adoptVerifiedEmail(normalized, { preserveSlotToken: slotToken, preferredAccountId: session.account.id });
    const method = store.accountLogins.linkOAuthMethod(session.account.id, { provider: "google", subject, email: normalized });
    return { accountId: session.account.id, methodRef: method.id };
  };
  const githubOAuthErrorMessage = code => ({
    github_state_invalid: "This GitHub sign-in attempt is not valid; start again",
    github_state_expired: "This GitHub sign-in attempt expired; start again",
    github_consent_denied: "GitHub sign-in was not approved",
    github_token_rejected: "GitHub did not accept this sign-in attempt; start again",
    github_callback_invalid: "This GitHub callback is not valid",
    github_provider_unavailable: "GitHub could not be reached; try again"
  }[code] ?? "GitHub sign-in could not be completed");
  if (trustedLocalProxy && !origin?.startsWith("https://")) throw new Error("The deployment proxy requires a fixed HTTPS origin");
  if (!Number.isInteger(streamQueueCap) || streamQueueCap < 1) throw new Error("Stream queue cap must be a positive integer of bytes");
  if (!Number.isInteger(streamInterval) || streamInterval < 1) throw new Error("Stream interval must be a positive integer of milliseconds");
  if (channelTransports !== null && typeof channelTransports !== "function") throw new Error("channelTransports must be a resolver function");
  // One send transport per (provider, account, connection): the live Telegram
  // transport when the bindings are set, otherwise the inert fixture sender. The
  // browser is told which ("live" or "fixture") so it labels outcomes honestly.
  const channelSenders = new Map(), sendReceipts = new Map();
  // access_requests schema is applied in the store open path (server/store.mjs),
  // so every RoomStore — including store-only recovery fixtures — carries it.
  const accessRequests = new AccessRequests(store);
  // agent_room_ownership schema is applied in the store open path
  // (server/store.mjs), so every RoomStore carries it; http.mjs only owns
  // the service instance.
  const agentRooms = new AgentRooms(store);
  const hostedRoomMcp = createHostedRoomMcp(store, { agentRooms });
  // Lane D agent plug-in surface (RC-2026-09-18-010): identity-scoped API
  // keys, public agent directory, derived plug-in manifest, per-agent webhook
  // subscriptions. Schema is applied in the store open path (server/store.mjs),
  // so every RoomStore carries it; http.mjs only owns the service instance.
  const agentPlugin = createAgentPluginRoutes({ store, json, reject, body, rate, bearer, exact, pathId, origin });
  // CP-ADMIN-0: operator routes. An unset secret makes the handler return false.
  const operatorRoutes = createOperatorRoutes({ store, json, reject, body, rate });
  // RC-2026-09-25-911: ranked next-actions. Schema is applied in the store
  // open path (server/store.mjs), so every RoomStore carries it; http.mjs
  // only owns the service instance.
  const nextActionsRoutes = createNextActionsRoutes({ store, json, reject, body, rate, roomCredentials, expectedBinding, accountBinding });
  const resolveChannelTransport = channelTransports ?? (({ provider, accountId, connectionId }) => {
    if (!channelSendProviders.includes(provider)) return null;
    const key = JSON.stringify([provider, accountId, connectionId]);
    // Idle scopes only hold in-memory receipts; the send journal stays
    // authoritative, so evicting the least-recently-used sender is safe —
    // unlike clear(), this never drops a transport with in-flight sends that
    // was recently used.
    return touchLruEntry(channelSenders, key, () => {
      const adapter = telegram.configured ? new TelegramTransport({ config: telegram, status: telegramStatus, accountId, connectionId, receipts: sendReceipts })
        : new FixtureChannelSender({ kind: provider, status: telegramStatus, accountId, connectionId });
      return { mode: telegram.configured ? "live" : "fixture", transport: new SyntheticInboxTransport(store.inbox, adapter) };
    }, 2000);
  });
  // Per-connection send budgets (task #41): one token bucket per
  // (channel, account, connection) guarding the channel-sends path below.
  // Defaults to 30 sends/min per Telegram bot; env and per-connection
  // overrides are documented in server/channel-send-budgets.mjs.
  const sendBudgets = sendBudgetRegistry ?? createSendBudgetRegistry({ env: sendBudgetEnv ?? process.env, now: () => store.now(),
    connectionBudget: (channel, accountId, connectionId) => {
      if (!connectionId || connectionId === "direct") return null;
      try { return store.connections.connection(accountId, connectionId)?.sendBudget ?? null; }
      catch { return null; }
    } });
  // Provider id (from the channel connection link) to the budgeted channel.
  // Fixture and live transports share the budget: it guards the send intent,
  // not the network call, so both paths behave identically.
  const sendBudgetChannelFor = provider => provider === "telegram-bot" ? "telegram" : null;
  if (typeof cookieNamespace !== "string" || !/^[A-Za-z0-9_-]{0,64}$/.test(cookieNamespace))
    throw new Error("Cookie namespace must contain at most 64 letters, digits, underscores or hyphens");
  if (syntheticInboxTransport && (!(syntheticInboxTransport instanceof SyntheticInboxTransport)
    || syntheticInboxTransport.inbox !== store.inbox || trustedLocalProxy
    || origin && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname)))
    throw new Error("Synthetic inbox transport requires its own loopback test service");
  if (origin) {
    const url = new URL(origin);
    if (url.origin !== origin || !["http:", "https:"].includes(url.protocol)) throw new Error("Origin must be a fixed HTTP(S) origin without a path");
    if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Non-loopback origins require HTTPS");
  }
  const expectedOrigin = () => origin || `http://127.0.0.1:${server.address().port}`;
  // Avoid local-instance sign-in collisions; namespacing is not host isolation.
  const scopedCookieName = name => `${expectedOrigin().startsWith("https:") ? "__Host-" : ""}${cookieNamespace ? cookieNamespace + "_" : ""}${name}`;
  const streams = new Set();
  // Typing heartbeat state lives in server/typing.mjs (shared with the route
  // table's POST /typing handler); the SSE pump below prunes on read.
  const diagnostics = new DiagnosticsLog();

  // Route templates for diagnostics: static words only, ids become :item.
  const templateSegments = rest => rest.split("/").map(segment => /^[a-z][a-z-]{0,40}$/.test(segment) ? segment : ":item").join("/");
  const requestPathname = requestUrl => { try { return new URL(requestUrl, expectedOrigin()).pathname; } catch { return null; } };
  // Room-scoped support-export route templates.
  function diagnosticRoute(requestUrl, roomId) {
    if (!roomId) return null;
    const pathname = requestPathname(requestUrl);
    if (pathname === null) return null;
    const prefix = `/api/rooms/${encodeURIComponent(roomId)}`;
    if (pathname !== prefix && !pathname.startsWith(prefix + "/")) return null;
    const rest = pathname.slice(prefix.length);
    if (!rest) return "/api/rooms/:roomId";
    return `/api/rooms/:roomId/${templateSegments(rest.slice(1))}`;
  }
  // Operator trace for failures outside a room scope: the static path template
  // only, never the query string, headers, body or the error's own message.
  const serviceRoute = requestUrl => {
    const pathname = requestPathname(requestUrl);
    return pathname === null || pathname === "/" ? "/" : "/" + templateSegments(pathname.slice(1).slice(0, 512));
  };
  // Keys are "<family>:<ip or credential...>". Each family keeps at most
  // RATE_FAMILY_KEYS live entries; a flood of foreign keys evicts that family's
  // least recently touched entry instead of refusing every new key, so a busy
  // minute cannot lock out fresh logins or joins, and one family cannot starve
  // another. Map insertion order doubles as the recency order.
  const RATE_FAMILY_KEYS = 2000;
  const rates = new Map(), rateFamilies = new Map();
  const rateFamily = id => id.slice(0, id.indexOf(":"));
  const dropRate = (id, family = rateFamily(id)) => {
    const entry = rates.get(id);
    // Keep a durable count that was already being written. A key that never
    // reached a write stride leaves no row, so a flood of one-shot keys cannot
    // fill the table.
    if (entry && ABUSE_RATE_FAMILIES.has(family) && entry.persistedN !== undefined && entry.persistedN !== entry.n && entry.until > Date.now())
      saveAbuseRateBucket(store.db, id, entry);
    rates.delete(id);
    const left = rateFamilies.get(family) - 1;
    if (left > 0) rateFamilies.set(family, left); else rateFamilies.delete(family);
  };
  function rate(id, maximum) {
    const now = Date.now();
    for (const [k, v] of rates) if (v.until <= now) dropRate(k);
    const family = rateFamily(id);
    const durable = ABUSE_RATE_FAMILIES.has(family);
    let entry = rates.get(id);
    if (entry) rates.delete(id);
    else {
      if (durable) entry = loadAbuseRateBucket(store.db, id, now);
      if ((rateFamilies.get(family) ?? 0) >= RATE_FAMILY_KEYS)
        for (const k of rates.keys()) if (rateFamily(k) === family) { dropRate(k, family); break; }
      rateFamilies.set(family, (rateFamilies.get(family) ?? 0) + 1);
      if (!entry) entry = { n: 0, until: now + 60000 };
    }
    entry.n++;
    rates.set(id, entry);
    if (durable) {
      const stride = Math.max(1, Math.floor(maximum / 4));
      if (entry.n >= maximum || entry.n % stride === 0) saveAbuseRateBucket(store.db, id, entry);
    }
    if (entry.n > maximum) throw new ServiceError(429, "rate_limited", "Too many requests; retry after a minute",
      { "X-RateLimit-Limit": maximum, "X-RateLimit-Remaining": 0, "X-RateLimit-Reset": Math.ceil(entry.until / 1000) });
  }
  function cookie(req, name) {
    const scoped = scopedCookieName(name);
    const matches = (req.headers.cookie || "").split(";").map(value => value.trim()).filter(value => value.startsWith(`${scoped}=`));
    if (matches.length > 1) reject(401, "ambiguous_session_cookie", "Conflicting browser session cookies; clear this site's cookies and sign in again");
    return matches[0]?.slice(scoped.length + 1);
  }
  function bearer(req) {
    if (!req.headers.authorization) return null;
    // RC-2026-09-18-012: rak_ presented API-key credentials ("rak_"+secret)
    // authenticate as the bound agent identity with its stored scopes; the
    // keyId form (shorter) never verifies and reads as 401 downstream.
    // QA 2026-10-03 (P1-3): RFC 7235 — the auth scheme is case-insensitive,
    // so "bearer"/"BEARER" must work like "Bearer". Token shape unchanged.
    const match = /^[Bb][Ee][Aa][Rr][Ee][Rr] ([A-Za-z0-9_-]{43}|ga1\.[A-Za-z0-9_-]{43}|pri_[A-Za-z0-9_-]{43,128}|rak_[A-Za-z0-9_-]{16,128})$/.exec(req.headers.authorization);
    if (!match) reject(401, "unauthenticated", "Invalid Authorization header");
    return match[1];
  }
  // Owner delegates (server/owner-delegates.mjs) need no parallel auth path:
  // store.authenticate stamps the delegate flag on the member copy whenever
  // the identity holds an active per-room grant, so route handlers keep
  // their own authorization and a delegate only passes gates that name the
  // delegate flag explicitly.
  function roomAuth(selected, roomId, fence) {
    return selected.mode === "account"
      ? store.authenticateAccountSession(selected.token, roomId, fence)
      : store.authenticate(selected.token, roomId, fence, { allowAccountSession: false });
  }
  function roomCredentials(req, url) {
    const bearerToken = bearer(req);
    if (bearerToken) return { token: bearerToken, bearer: true, mode: "room" };
    const requested = req.headers["x-project-room-auth"] ?? url.searchParams.get("auth") ?? "room";
    if (!["room", "account"].includes(requested)) reject(422, "invalid_auth_mode", "Invalid Room authentication mode");
    return { token: cookie(req, requested === "account" ? accountCookieName : roomCookieName), bearer: false, mode: requested };
  }
  function expectedBinding(req) {
    const value = req.headers["x-session-binding"];
    if (value === undefined) return null;
    if (typeof value !== "string" || !bindingPattern.test(value)) reject(422, "invalid_session_binding", "Invalid session response binding");
    return value;
  }
  function accountBinding(req, url = null) {
    const header = expectedBinding(req);
    const values = url?.searchParams.getAll("binding") ?? [];
    if (values.length > 1 || (values.length && !bindingPattern.test(values[0]))
      || (header && values.length && header !== values[0])) reject(422, "invalid_session_binding", "Invalid session response binding");
    const binding = header ?? values[0];
    if (!binding) reject(422, "session_binding_required", "Current account session binding required");
    return binding;
  }
  function checkOrigin(req, required = false) {
    const origin = req.headers.origin;
    if ((required || origin) && origin !== expectedOrigin()) {
      reject(403, "origin_denied", required ? "Origin header is required" : "Request origin is not allowed");
    }
  }
  // The public Join-with-code door (getdasha.com/room) is a browser page on
  // the edge-door hosts, not the room origin. Only the read-only
  // POST /api/share-links/preview route accepts these origins; every other
  // route keeps the strict checkOrigin.
  function isEdgeDoorOrigin(origin) {
    return typeof origin === "string" && EDGE_DOOR_HOSTS.some(host => origin === `https://${host}`);
  }
  // Route-scoped origin relaxation for POST /api/share-links/preview only:
  // the public Join-with-code door runs on the getdasha edge-door hosts, so
  // its browser Origin is the door host, not the room origin. This route
  // accepts those two door origins alongside the room origin; every other
  // route keeps the strict checkOrigin. Missing and foreign origins are
  // still denied with the same message checkOrigin(req, true) produces.
  function checkPreviewOrigin(req) {
    const origin = req.headers.origin;
    // Same bearer waiver as protectWrite (#1529): a headless agent with a
    // Bearer credential and no Origin is not a browser forgery. Without a
    // credential the Origin is still required (RC-2026-09-23).
    if (origin === undefined && carriesBearer(req)) return;
    if (origin !== expectedOrigin() && !isEdgeDoorOrigin(origin)) {
      reject(403, "origin_denied", "Origin header is required");
    }
  }
  // Origin checks are a CSRF defense for cookie/browser sessions. A request
  // presenting an Authorization: Bearer credential is not an ambient-auth
  // browser flow — the bearer credential IS the authentication — so the
  // browser-Origin requirement is waived for it. Credential validity is
  // still enforced by each route's own auth (format via bearer(), scope and
  // identity via the store); a forged or missing Origin on a bearer request
  // buys an attacker nothing.
  function carriesBearer(req) {
    return typeof req.headers.authorization === "string" && /^bearer /i.test(req.headers.authorization);
  }
  function protectWrite(req, auth, isBearer) {
    checkOrigin(req, !isBearer);
    if (!isBearer) {
      const csrf = req.headers["x-csrf-token"];
      if (auth.kind !== "session" || typeof csrf !== "string" || !bindingPattern.test(csrf) || !auth.csrf
        || !timingSafeEqual(Buffer.from(csrf), Buffer.from(auth.csrf))) reject(403, "csrf_denied", "Session confirmation required; sign in again");
    }
  }
  function setCookie(res, name, token, maxAge, sameSite = "Strict") {
    res.setHeader("Set-Cookie", `${scopedCookieName(name)}=${token}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${expectedOrigin().startsWith("https:") ? "; Secure" : ""}`);
  }
  function json(res, status, value, head = false) {
    const body = JSON.stringify(value);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
    res.end(head ? undefined : body);
  }
  // Read-time message redaction (server/redact-read.mjs). Responses that
  // return events, the room projection, or an export show the tombstone for
  // a deleted message and only the current body after an edit. The log
  // itself is not rewritten.
  function projectionMessages(id) {
    return store.room(id).state.messages;
  }
  // Bounded request reader shared by JSON and NDJSON routes. A declared
  // oversize is refused immediately while draining in the background: a stalled
  // sender must not hold a connection open until its request timeout. For
  // unknown-length bodies, discard over-limit chunks while draining to end,
  // so a client that finishes sending can read the 413. Aborts fail promptly.
  function readText(req, limit, tooLarge) {
    const declaredBytes = Number(req.headers["content-length"]);
    if (declaredBytes > limit) { req.resume(); throw tooLarge(declaredBytes); }
    return new Promise((resolve, rejectPromise) => {
      let bytes = 0;
      let oversize = false;
      const chunks = [];
      req.on("data", chunk => {
        // Keep counting past the limit without buffering, so the 413 names
        // the actual size (G7); over-limit chunk buffers are still dropped.
        bytes += chunk.length;
        if (oversize) return;
        if (bytes > limit) { oversize = true; chunks.length = 0; }
        else chunks.push(chunk);
      });
      req.on("end", () => oversize ? rejectPromise(tooLarge(bytes)) : resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", rejectPromise);
      req.on("aborted", () => rejectPromise(new ServiceError(400, "aborted", "Request ended early")));
    });
  }
  // Every JSON route takes the default limit; a caller passes `limit` only where
  // the provider's payload is known to be larger (the Telegram webhook embeds
  // the replied-to message).
  async function body(req, { limit = JSON_BODY_BYTES } = {}) {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) reject(415, "json_required", "Use application/json");
    // G7 (#940): the body-cap rejection names the limit and the actual size.
    // Code stays too_large; the AX layer adds the next step.
    const text = await readText(req, limit, actualBytes => new ServiceError(413, "too_large", `Request body is ${actualBytes} bytes; the limit is ${limit} bytes`));
    try { const value = JSON.parse(text); if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(); return value; }
    catch { reject(400, "invalid_json", "Expected a JSON object"); }
  }
  function stream(req, res, token, roomId, after, auth, operationId) {
    const binding = auth.sessionBinding;
    store.eventsAfter(token, roomId, after, 100, binding);
    if (streams.size >= 100 || [...streams].filter(item => item.credentialHash === auth.credentialHash).length >= 3) reject(429, "stream_limit", "Close another room connection before opening more");
    res.writeHead(200, { "Content-Type": "text/event-stream", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    const entry = { credentialHash: auth.credentialHash, sessionBinding: binding, memberId: auth.member.id, roomId, res };
    streams.add(entry);
    let cursor = after;
    let timer;
    const signal = resolveRequestSignal(req);
    const cleanup = () => { clearInterval(timer); streams.delete(entry); signal?.removeEventListener("abort", abort); };
    const end = data => { cleanup(); if (!res.destroyed && !res.writableEnded) res.end(data); };
    const abort = () => end();
    // Per-connection send queue: a consumer whose unsent bytes exceed the cap
    // gets one final stream_lagging event and, if it never drains, its socket
    // dropped. Peers keep their own queues. Reconnecting with Last-Event-ID
    // resumes from the last event the client actually processed.
    const lagging = () => res.writableLength > streamQueueCap;
    const lag = () => {
      diagnostics.record({ operationId, at: new Date().toISOString(), status: 200, code: "stream_lagging", category: "unavailable", route: "/api/rooms/:roomId/stream", roomId });
      console.warn(`room diagnostic ${operationId} 200 stream_lagging unavailable /api/rooms/:roomId/stream`);
      const drop = setTimeout(() => res.destroy(), STREAM_DRAIN_GRACE_MS);
      drop.unref();
      res.once("close", () => clearTimeout(drop));
      end('event: stream_lagging\ndata: {"message":"Client fell behind; reconnect with Last-Event-ID to resume"}\n\n');
    };
    const pump = () => {
      if (res.destroyed || res.writableEnded) { cleanup(); return; }
      try {
        const batch = redactEventPage(store.eventsAfter(token, roomId, cursor, 100, binding), projectionMessages(roomId));
        if (!batch.events.length) res.write(": connected transport only\n\n");
        for (const item of batch.events) {
          res.write(`id: ${item.sequence}\nevent: room-event\ndata: ${JSON.stringify(item)}\n\n`);
          cursor = item.sequence;
          if (lagging()) break;
        }
        // Ephemeral typing indicators ride the stream as synthetic `typing`
        // events with no `id:` — they never disturb Last-Event-ID resume.
        // Emitted only when the visible typist set changes for this connection.
        if (!lagging()) {
          const typists = currentTypists(typingBeats, roomId, entry.memberId);
          const key = typingKey(typists);
          if (key !== entry.lastTypingKey) {
            entry.lastTypingKey = key;
            res.write(`event: typing\ndata: ${JSON.stringify({ typists })}\n\n`);
          }
        }
        if (lagging()) lag();
        // Advance past invisible rows only after the complete visible batch
        // was queued. A lagging stream must resume from its last sent event.
        else cursor = batch.next;
      } catch (error) {
        if ([401, 403].includes(error?.status) || error?.code === "session_binding_changed") {
          end('event: access-ended\ndata: {"message":"Access ended; sign in again"}\n\n');
        } else {
          diagnostics.record({ operationId, at: new Date().toISOString(), status: 503, code: "stream_unavailable", category: "unavailable", route: "/api/rooms/:roomId/stream", roomId });
          end('event: unavailable\ndata: {"message":"Connection interrupted; reconnect to recover"}\n\n');
        }
      }
    };
    timer = setInterval(pump, streamInterval);
    timer.unref();
    res.once("close", cleanup); res.once("finish", cleanup); res.once("error", abort);
    // Workers' Node bridge does not emit close when a browser leaves. The
    // request-scoped platform signal releases only this stream and its timer.
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort(); else pump();
  }
  const server = createServer(async (req, res) => {
    const operationId = `op_${randomBytes(6).toString("base64url")}`;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    // #975: HSTS on every HTTPS response (Cloudflare path doesn't set it).
    // NOTE: no includeSubDomains - unverified that all trydemigod.com
    // subdomains are HTTPS-only; dropping it is the safe default.
    res.setHeader("Strict-Transport-Security", "max-age=31536000");
    // Cloudflare Web Analytics injects its beacon at the edge. The app does not
    // add that script; this document policy is what lets the beacon run.
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self'; font-src 'self'; connect-src 'self' https://cloudflareinsights.com; img-src 'self'; manifest-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    // SEC-1: lock unused powerful features and cross-origin window access.
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    try {
      if (req.headers.host !== new URL(expectedOrigin()).host) reject(403, "host_denied", "Unexpected host");
      let remoteAddress;
      try { remoteAddress = resolveClientAddress(req); }
      catch { reject(403, "proxy_denied", "Invalid proxy configuration"); }
      // QA 2026-10-04 (group QA wave): an unparseable request target (e.g. "//")
      // threw inside new URL and fell through to a 500. Fail it as a 400 up
      // front so malformed lines never masquerade as server errors.
      let url;
      try { url = new URL(req.url, expectedOrigin()); }
      catch { reject(400, "invalid_request", "Could not parse the request URL"); }
      const loopback = ["127.0.0.1", "::1"].includes(remoteAddress);
      // QA 2026-10-03 (P2-1): a trailing slash must reach the route, not a 404
      // whose "check access" hint misdirects on public endpoints. Normalize
      // once, up front, so every matcher below sees the canonical path. Only
      // the URL object is rewritten — req.url stays untouched for diagnostics.
      if (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.replace(/\/+$/, "");
      if (url.pathname === "/.well-known/security.txt" || url.pathname === "/security.txt" || url.pathname === "/room/.well-known/security.txt") {
        return writeSecurityTxt(req, res);
      }
      // Jev-harness admission gate, shadow mode (docs/JEV-GATES.md): score
      // the join with the cheap classifier, journal the would-be decision,
      // then proceed unchanged. Shadow mode never enforces — this helper
      // never throws, so a scoring or journal failure cannot break admission.
      const jevShadowAdmission = (path, { roomId, identityId = null, memberId = null, displayName = "", card = null } = {}) => {
        try {
          if (typeof roomId !== "string" || !roomId) return;
          const now = store.now();
          const members = Object.values(store.room(roomId).state.members ?? {});
          let resolvedIdentityId = identityId;
          const member = memberId ? members.find(m => m && m.id === memberId) : null;
          if (!resolvedIdentityId && member) resolvedIdentityId = member.identityId ?? null;
          const resolvedDisplayName = displayName
            || (typeof member?.displayName === "string" ? member.displayName : "");
          const identity = resolvedIdentityId ? store.identities.get(resolvedIdentityId) : null;
          const ipHash = rateHash(String(remoteAddress ?? ""));
          const decision = evaluateAdmission({
            identityId: resolvedIdentityId, displayName: resolvedDisplayName, path,
            identityAgeMs: identity && Number.isFinite(identity.createdAt) ? Math.max(0, now - identity.createdAt) : null,
            existingDisplayNames: members
              .filter(m => m && m.active !== false && typeof m.displayName === "string")
              .map(m => m.displayName),
            recentJoins: {
              byIdentity: resolvedIdentityId ? store.jevShadow.recentJoinCount({ identityId: resolvedIdentityId, windowMs: jevVelocityWindowMs }) : 0,
              byIp: store.jevShadow.recentJoinCount({ ipHash, windowMs: jevVelocityWindowMs }),
            },
            card, at: now,
          });
          store.jevShadow.record({ gate: "admission", roomId, identityId: resolvedIdentityId, ipHash, path,
            score: decision.score, decision: decision.decision, escalate: false, signals: decision.signals, at: now });
        } catch { /* shadow-only: never break the join */ }
      };
      const inboundPath = url.pathname;
      if (isRoomMcpPath(inboundPath) || isRoomMcpPath(rewriteRoomApiPrefix(inboundPath))) {
        rate(`mcp-join:${remoteAddress}`, 60);
        if (req.method === "POST") {
          // Join traffic stays on the small JSON cap. A live identity secret
          // may stage one room file (base64, at most attachmentLimits.fileBytes).
          const fileBody = typeof req.headers.authorization === "string"
            // RFC 7235: auth scheme is case-insensitive ("bearer"/"BEARER"
            // accepted), matching bearer()/carriesBearer() above.
            && /^bearer (?:pri_|rak_)/i.test(req.headers.authorization);
          const text = await readText(req, fileBody ? mcpAttachmentBodyBytes : JSON_BODY_BYTES, () => new ServiceError(413, "too_large", "Request is too large"));
          return writeRoomMcpNode(req, res, url, { bodyText: text, roomMcp: hostedRoomMcp, remoteAddress });
        }
        return writeRoomMcpNode(req, res, url);
      }
      if (isA2aPath(inboundPath)) {
        rate(`a2a:${remoteAddress}`, 60);
        const text = req.method === "POST" ? await readText(req, JSON_BODY_BYTES, () => new ServiceError(413, "too_large", "Request is too large")) : "";
        return writeA2aNode(req, res, { bodyText: text });
      }
      // The global origin gate runs before routing; the share-link preview is
      // let through for the edge-door origins here, and its route-level
      // checkPreviewOrigin still requires an Origin header.
      const previewDoorRequest = req.method === "POST"
        && (inboundPath === "/api/share-links/preview" || inboundPath === "/room/api/share-links/preview")
        && isEdgeDoorOrigin(req.headers.origin);
      const publicReceiptsRead = ["GET", "HEAD", "OPTIONS"].includes(req.method) && isPublicReceiptsJson(inboundPath);
      if (publicReceiptsRead) allowPublicReceiptsCors(res);
      if (publicReceiptsRead && req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
      }
      if (!previewDoorRequest && !publicReceiptsRead) checkOrigin(req);
      url.pathname = rewriteRoomApiPrefix(inboundPath);
      if (url.pathname.startsWith("/api/")) res.setHeader("X-Operation-Id", operationId);
      // Sign-in slot resolution (slice 7): browser clients cannot read the
      // HttpOnly account-slot cookie, so the sign-in JSON routes accept the
      // slot token from the request cookie when the body omits sessionToken.
      // The cookie path is CSRF-protected via protectWrite (the browser
      // carries the token in the X-CSRF-Token header); the explicit body
      // token stays a bearer secret for API clients. `csrf: "always"` keeps
      // the pre-existing always-CSRF routes (magic consume, recovery redeem)
      // unchanged for body-token callers.
      const signInSlotToken = (req, data, fields, { code, message, csrf = "cookie" }) => {
        const withToken = Object.hasOwn(data, "sessionToken");
        if (!exact(data, withToken ? [...fields, "sessionToken"] : fields)
          || (withToken && typeof data.sessionToken !== "string")) {
          reject(422, code, message);
        }
        const slotToken = withToken ? data.sessionToken : cookie(req, accountCookieName);
        if (typeof slotToken !== "string" || slotToken.length === 0) {
          reject(401, "account_session_required", "Start an account browser session before signing in");
        }
        // Cookie-fallback (browser) slots are resolved here for the CSRF
        // check; explicit API tokens keep the route's original validation
        // order and are verified by finish*Slot below.
        if (!withToken) {
          const slot = store.accountSessionSlot(slotToken);
          protectWrite(req, slot, false);
        } else if (csrf === "always") {
          const slot = store.accountSessionSlot(slotToken);
          protectWrite(req, slot, false);
        }
        return slotToken;
      };
      // Route table (batch RT). A matched row is finished here, including
      // 405 Allow on a known path. The inbox mount and the auth group keep
      // their own session and method checks. Anything else falls through
      // to the legacy chain below until that chain is empty.
      if (await dispatchRoute({
        req, res, url, store, remoteAddress, loopback, operationId,
        // JDOT-MEMBER-PERMS begin: share quotas across request aliases.
        accessRequests,
        // JDOT-MEMBER-PERMS end
        json, reject, rate, cookie, setCookie, bearer, body, readText,
        roomAuth, roomCredentials, expectedBinding, accountBinding,
        checkOrigin, protectWrite, exact, pathId, expectedOrigin,
        accountCookieName, roomCookieName, tokenPattern, accountView: sessionAccountView,
        signInSlotToken, magicMailer, magicEmailLimit, passkeys, oauthProvider,
        magicRequestEmailLimiter, magicConsumeEmailLimiter,
        resetRequestEmailLimiter, resetConsumeEmailLimiter, signupEmailLimiter,
        gmail, channelWebhooks, telegram, telegramStatus,
        sendBudgets, sendBudgetChannelFor, syntheticInboxTransport,
        resolveChannelTransport, directSendFetch,
      })) return;
      if ((url.pathname === "/api/health" || url.pathname === "/api/health/" || isHealthAliasPath(inboundPath) || isHealthAliasPath(url.pathname)) && ["GET", "HEAD"].includes(req.method)) {
        return json(res, 200, { status: "ok", mode: serviceMode, emailVerification, ...deploymentField }, req.method === "HEAD");
      }
      if (url.pathname === "/api/version" && ["GET", "HEAD"].includes(req.method)) {
        return json(res, 200, { status: "ok", mode: serviceMode, sourceRevision: SOURCE_REVISION, buildId: BUILD_ID, ...deploymentField }, req.method === "HEAD");
      }
      // A known liveness path with the wrong method is 405 with Allow, like the
      // route table, not a 404 that reads as "this path does not exist" (#1529).
      if ((LIVENESS_GET_ONLY_PATHS.has(url.pathname) || isHealthAliasPath(inboundPath) || isHealthAliasPath(url.pathname))
        && req.method !== "OPTIONS") {
        reject(405, "method_not_allowed", "Method not allowed", { Allow: "GET, HEAD" });
      }
      // Google sign-in (Clerk-free). The start route begins the PKCE flow bound
      // to the browser's account session slot; the callback verifies state and
      // the code exchange, upgrades the slot to the Google-provisioned account,
      // and returns a same-origin HTML page so the SameSite=Strict session
      // cookie is sent on the next load. Error responses never carry tokens.
      if (url.pathname === "/api/auth/gmail/callback" && req.method === "GET") {
        rate(`gmail-callback:${remoteAddress}`, 20);
        let result = 'error';
        try {
          if (gmail) {
            const completed = await gmail.complete(new URL(expectedOrigin() + url.pathname + url.search), cookie(req, "gmail_oauth"));
            setCookie(res, 'gmail_oauth', '', 0, 'Lax');
            result = 'connected';
            try { await gmail.sync(completed.token, completed.binding, completed.mailboxId); } catch { result = 'sync-error'; }
          }
        } catch (error) { if (error.code === 'gmail_consent_denied') result = 'cancelled'; }
        const href = '/?account=1&gmail=' + result + '#pr-view/inbox';
        res.setHeader('Content-Security-Policy', "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${href.replaceAll('&', '&amp;')}"><title>Returning to Inbox</title></head><body><a href="${href.replaceAll('&', '&amp;')}">Return to Inbox</a></body></html>`);
      }
      if (url.pathname === GOOGLE_START_PATH) {
        if (req.method !== "GET") reject(405, "method_not_allowed", "Method not allowed");
        const signIn = google();
        if (!signIn) {
          // Return browser navigations to the sign-in surface, where the
          // existing OAuth invitation stash restores their destination.
          if ((req.headers.accept || "").includes("text/html")) {
            res.writeHead(302, { Location: "/?google=unavailable", "Cache-Control": "no-store" });
            return res.end();
          }
          return json(res, 503, { status: "unavailable", reason: "google_not_configured" });
        }
        rate(`google-start:${remoteAddress}`, 10);
        let slotToken = cookie(req, accountCookieName), expectedRevision;
        if (slotToken) {
          try { expectedRevision = store.accountSessionSlot(slotToken).sessionRevision; }
          catch (error) {
            // A stale browser cookie must not turn a fresh sign-in into a raw
            // 401. Replace only an unauthenticated slot; preserve other errors.
            if (error.code !== "unauthenticated") throw error;
            slotToken = null;
          }
        }
        if (!slotToken) {
          const created = store.createAccountSessionSlot();
          slotToken = created.token;
          expectedRevision = created.session.sessionRevision;
          setCookie(res, accountCookieName, slotToken, Math.max(0, Math.floor((created.session.expiresAt - store.now()) / 1000)));
        }
        const started = signIn.begin({ slotToken, expectedRevision });
        res.statusCode = 302;
        res.setHeader("Location", started.authorizationUrl);
        return res.end();
      }
      if (url.pathname === GOOGLE_CALLBACK_PATH) {
        if (req.method !== "GET") reject(405, "method_not_allowed", "Method not allowed");
        const signIn = google();
        if (!signIn) return json(res, 503, { status: "unavailable", reason: "google_not_configured" });
        rate(`google-callback:${remoteAddress}`, 20);
        const finishGoogle = href => {
          const html = googlePostLoginPage(href);
          res.setHeader("Content-Security-Policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
          const bytes = Buffer.from(html, "utf8");
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": bytes.length });
          return res.end(bytes);
        };
        let stage = "provider";
        try {
          const completed = await signIn.complete({ callbackUrl: expectedOrigin() + url.pathname + url.search });
          // Shared-model linking (RC-2026-09-17-017): the callback links the
          // Google subject through the account-login model. A link intent
          // attaches to the signed-in account; otherwise find-or-provision
          // runs (existing OAuth link → verified-email match → new account).
          stage = "account_link";
          const subject = String(completed.claims.sub);
          const email = typeof completed.claims.email === "string" ? completed.claims.email : null;
          const linked = completed.link
            ? linkGoogleSubjectToAccount({ subject, email, slotToken: completed.slotToken })
            : linkGoogleSubject({ subject, email, slotToken: completed.slotToken });
          stage = "method_touch";
          store.accountLogins.touchMethodByOAuth("google", subject);
          const oldRoomToken = cookie(req, roomCookieName);
          // QAS-702 (RC-2026-09-19-069): the login mints a fresh slot token
          // and invalidates the pre-login one — a planted token can never
          // authenticate after the victim signs in.
          stage = "account_session";
          const { token: freshSlotToken, session: loggedIn } = store.loginAccountSessionWithMethod(completed.slotToken, linked.accountId,
            completed.expectedRevision, { method: { kind: "oauth", ref: linked.methodRef },
              revokeRoomToken: oldRoomToken && tokenPattern.test(oldRoomToken) ? oldRoomToken : null,
              rotateSlot: true });
          setCookie(res, accountCookieName, freshSlotToken, Math.max(0, Math.floor((loggedIn.expiresAt - store.now()) / 1000)));
          const firstRoom = store.db.prepare("SELECT room_id FROM member_accounts WHERE account_id=? ORDER BY room_id LIMIT 1")
            .get(linked.accountId);
          // A fresh account has no rooms yet: land on the account home, where
          // the room list, invite redemption, and "New room" creation live.
          // The error path is reserved for genuine failures (denied consent,
          // bad state), which the client surfaces with a real message.
          return finishGoogle(firstRoom ? `/?room=${encodeURIComponent(firstRoom.room_id)}` : "/?account=1");
        } catch (error) {
          // Log only a bounded error identifier, never callback URLs, tokens,
          // provider bodies, emails, or arbitrary exception messages.
          const reason = /^[a-z][a-z0-9_]{0,63}$/.test(error?.code || "") ? error.code : "internal_error";
          const schema = /(?:no such (?:table|column): |(?:NOT NULL|UNIQUE) constraint failed: )([a-z_][a-z0-9_.]*)/i.exec(error?.message || "");
          res.setHeader("X-Room-Auth-Diagnostic", `${stage}:${schema ? schema[0] : /FOREIGN KEY constraint failed|CHECK constraint failed|writer fence|writer version/i.exec(error?.message || "")?.[0] || (error?.name === "TypeError" ? "type_error" : "error")}`);
          res.setHeader("X-Room-Auth-Failure", reason);
          console.warn(`google callback failed: ${reason}`);
          return finishGoogle("/?google=error");
        }
      }
      if (url.pathname === "/api/auth/email/verify") {
        if (req.method !== "POST") reject(405, "method_not_allowed", "Method not allowed");
        checkOrigin(req, true);
        rate(`email-verify:${remoteAddress}`, 10);
        const slotToken = cookie(req, accountCookieName);
        if (!slotToken) reject(401, "account_session_required", "Sign in before verifying your email");
        let session;
        try { session = store.authenticateAccountSession(slotToken); }
        catch (error) {
          if (error.status !== 401) throw error;
          reject(401, "invalid_session", "That session is no longer valid; sign in again");
        }
        if (!session.account) reject(401, "account_session_required", "Sign in before verifying your email");
        protectWrite(req, session, false);
        const data = await body(req);
        if (!exact(data, ["code"]) || typeof data.code !== "string") reject(422, "invalid_email_code", "A verification code is required");
        const verified = store.accountLogins.consumeEmailVerifyCode({ accountId: session.account.id, code: data.code.trim() });
        return json(res, 200, { status: "verified", email: verified.email });
      }
      if (url.pathname === "/api/auth/email/verify/resend") {
        if (req.method !== "POST") reject(405, "method_not_allowed", "Method not allowed");
        checkOrigin(req, true);
        // A failed send is logged (redacted) and reported as not_delivered; the
        // fresh code is already issued, so the client can retry.
        const slotToken = cookie(req, accountCookieName);
        if (!slotToken) reject(401, "account_session_required", "Sign in before verifying your email");
        let session;
        try { session = store.authenticateAccountSession(slotToken); }
        catch (error) {
          if (error.status !== 401) throw error;
          reject(401, "invalid_session", "That session is no longer valid; sign in again");
        }
        if (!session.account) reject(401, "account_session_required", "Sign in before verifying your email");
        protectWrite(req, session, false);
        // Tight per-account budget: a resend mints a fresh code, so this is
        // not a free oracle for someone else's inbox.
        rate(`email-verify-resend:${session.account.id}`, 5);
        const emailRow = store.db.prepare(`SELECT email FROM account_login_methods
          WHERE account_id=? AND type='password' AND disabled=0 AND email IS NOT NULL LIMIT 1`)
          .get(session.account.id);
        const normalized = emailRow ? normalizeEmail(emailRow.email) : null;
        if (!normalized) reject(422, "invalid_email", "This account has no email to verify");
        const pending = store.db.prepare(`SELECT 1 FROM account_login_methods
          WHERE account_id=? AND email_hash=? AND disabled=0 AND verified_at IS NULL LIMIT 1`)
          .get(session.account.id, emailLookupHash(normalized));
        if (!pending) return json(res, 200, { status: "already_verified", email: normalized });
        if (!magicMailer.isConfigured()) {
          reject(503, "mail_not_configured", "Email delivery is not configured; contact the operator to verify this address");
        }
        // An optional returnTo (same strict validation as magic sign-in) keeps
        // a pending invitation in the resent link, like signup's own mail.
        // The body itself is optional (docs/openapi.yaml): a body-less resend
        // works as before; a body that is present must be a JSON object.
        const hasBody = Number(req.headers["content-length"] || 0) > 0 || req.headers["transfer-encoding"] !== undefined;
        const data = hasBody ? await body(req) : {};
        const returnTo = data && Object.hasOwn(data, "returnTo") ? validateMagicReturnTo(data.returnTo) : undefined;
        if (returnTo === null) reject(422, "invalid_return_target", "A valid local return target is required");
        const issued = store.accountLogins.issueEmailVerifyCode({ accountId: session.account.id, email: normalized });
        const delivered = await attemptMailDelivery(() => magicMailer.sendMagicLink({
          to: normalized, code: issued.code, expiresAt: issued.expiresAt, purpose: "email-verify", ...(returnTo ? { returnTo } : {})
        }), "email-verify resend");
        return json(res, 200, { status: delivered ? "resent" : "not_delivered", email: normalized, expiresAt: issued.expiresAt });
      }
      // ---- end ID-SEC auth ----
      // ---- GitHub OAuth (slice 4, RC-2026-09-17-013) ----
      // GitHub sign-in (Clerk-free). The start route binds the browser's
      // account session slot (passed as ?sessionToken=) into a single-use
      // PKCE state and 302s to GitHub; the callback consumes the state,
      // exchanges the code, links the verified GitHub subject into the
      // multi-method login model, and upgrades the slot. The callback
      // returns the upgraded session as JSON (a same-origin landing page
      // is out of scope for this slice). Error responses never carry tokens.
      if (url.pathname === GITHUB_START_PATH) {
        if (req.method !== "GET") reject(405, "method_not_allowed", "Method not allowed");
        const oauth = github();
        if (!oauth) {
          // Slice 7: browsers navigating directly to the start route get a
          // readable landing page; API clients keep the 503 JSON body.
          if ((req.headers.accept || "").includes("text/html")) {
            res.setHeader("Content-Security-Policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
            const bytes = Buffer.from(githubUnavailablePage(), "utf8");
            res.writeHead(503, { "Content-Type": "text/html; charset=utf-8", "Content-Length": bytes.length });
            return res.end(bytes);
          }
          return json(res, 503, { status: "unavailable", reason: "github_not_configured",
            error: { code: "github_not_configured", message: "GitHub sign-in is not configured" } });
        }
        rate(`github-start:${remoteAddress}`, 10);
        // Browser clients cannot read the HttpOnly slot cookie into the
        // sessionToken query param, so the slot falls back to the request
        // cookie (CSRF-protected); API clients keep the bearer query param.
        const paramToken = url.searchParams.get("sessionToken");
        const startToken = (typeof paramToken === "string" && paramToken.length > 0) ? paramToken : cookie(req, accountCookieName);
        if (!startToken) reject(401, "account_session_required", "Start an account browser session before signing in");
        const startSlot = store.accountSessionSlot(startToken);
        if (!paramToken) {
          // Same-origin browser navigation cannot attach a CSRF header. Its
          // pending state is still bound to this slot and revision; every
          // other cookie request retains the normal Origin/CSRF gate.
          if (req.headers["sec-fetch-mode"] === "navigate" && req.headers["sec-fetch-site"] === "same-origin") checkOrigin(req, false);
          else protectWrite(req, startSlot, false);
        }
        const expectedRevision = startSlot.sessionRevision;
        const { state, codeVerifier } = oauth.pending.create({ sessionToken: startToken, sessionRevision: expectedRevision });
        const authorizationUrl = buildGitHubAuthUrl({ clientId: oauth.clientId, redirectUri: oauth.redirectUri,
          state, codeChallenge: codeChallengeFor(codeVerifier) });
        res.statusCode = 302;
        res.setHeader("Location", authorizationUrl);
        return res.end();
      }
      if (url.pathname === GITHUB_CALLBACK_PATH) {
        if (req.method !== "GET") reject(405, "method_not_allowed", "Method not allowed");
        const oauth = github();
        if (!oauth) return json(res, 503, { status: "unavailable", reason: "github_not_configured",
          error: { code: "github_not_configured", message: "GitHub sign-in is not configured" } });
        rate(`github-callback:${remoteAddress}`, 20);
        // Browser OAuth navigations send Accept: text/html; they get a
        // landing page (slice 7) while API clients keep the JSON body.
        const githubWantsHtml = (req.headers.accept || "").includes("text/html");
        const githubHtml = href => {
          const html = githubPostLoginPage(href);
          res.setHeader("Content-Security-Policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
          const bytes = Buffer.from(html, "utf8");
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": bytes.length });
          return res.end(bytes);
        };
        const githubLanding = accountId => {
          const firstRoom = store.db.prepare("SELECT room_id FROM member_accounts WHERE account_id=? ORDER BY room_id LIMIT 1")
            .get(accountId);
          return firstRoom ? `/?room=${encodeURIComponent(firstRoom.room_id)}` : "/?account=1";
        };
        try {
          if (url.searchParams.getAll("state").length > 1 || url.searchParams.getAll("code").length > 1) {
            throw new GitHubOAuthError("github_callback_invalid");
          }
          const state = url.searchParams.get("state");
          if (url.searchParams.get("error")) {
            if (state) { try { oauth.pending.consume(state); } catch { /* burn what we can */ } }
            throw new GitHubOAuthError("github_consent_denied");
          }
          const code = url.searchParams.get("code");
          if (!code) throw new GitHubOAuthError("github_callback_invalid");
          const pending = oauth.pending.consume(state); // 401 on replay, expiry, or mismatch
          const accessToken = await exchangeCodeForToken({ code, codeVerifier: pending.codeVerifier,
            clientId: oauth.clientId, clientSecret: oauth.clientSecret, redirectUri: oauth.redirectUri,
            fetchFn: oauth.fetchImpl });
          const ghUser = await fetchGitHubUser(accessToken, oauth.fetchImpl);
          const subject = String(ghUser.id);
          const linked = pending.link
            ? linkGitHubSubjectToAccount({ subject, email: ghUser.email, slotToken: pending.sessionToken })
            : linkGitHubSubject({ subject, email: ghUser.email, slotToken: pending.sessionToken });
          store.accountLogins.touchMethodByOAuth("github", subject);
          // QAS-702 (RC-2026-09-19-069): mint a fresh slot token on login and
          // invalidate the pre-login one — see the Google path above.
          const { token: freshSlotToken, session: loggedIn } = store.loginAccountSessionWithMethod(pending.sessionToken, linked.accountId,
            pending.sessionRevision, { method: { kind: "oauth", ref: linked.methodRef }, rotateSlot: true });
          setCookie(res, accountCookieName, freshSlotToken,
            Math.max(0, Math.floor((loggedIn.expiresAt - store.now()) / 1000)));
          if (githubWantsHtml) return githubHtml(githubLanding(linked.accountId));
          return json(res, 200, {
            status: "ok",
            provider: "github",
            account: { id: loggedIn.account.id, revision: loggedIn.account.revision },
            sessionRevision: loggedIn.sessionRevision,
            expiresAt: loggedIn.expiresAt,
            method: { kind: "oauth", ref: linked.methodRef }
          });
        } catch (error) {
          if (error instanceof GitHubOAuthError) {
            if (githubWantsHtml) return githubHtml("/?github=error");
            const status = { github_state_invalid: 401, github_state_expired: 401, github_consent_denied: 401,
              github_token_rejected: 401, github_callback_invalid: 422, github_provider_unavailable: 503 }[error.code] ?? 502;
            throw new ServiceError(status, error.code, githubOAuthErrorMessage(error.code));
          }
          throw error;
        }
      }
      // OAuth2 authorization server for third-party connectors (RFC 6749).
      // GET /.well-known/oauth-authorization-server — server metadata (RFC 8414).
      if (url.pathname === "/.well-known/oauth-authorization-server" && req.method === "GET") {
        const issuer = expectedOrigin();
        return json(res, 200, {
          issuer,
          authorization_endpoint: issuer + "/oauth/authorize",
          token_endpoint: issuer + "/oauth/token",
          revocation_endpoint: issuer + "/oauth/revoke",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: [...OAUTH_SCOPES],
          token_endpoint_auth_methods_supported: ["none"], // public clients with PKCE
        });
      }
      // GET /.well-known/feedback — /feedback standard discovery metadata.
      // Mirrors docs/feedback-endpoint.md §7: version, intake URL template,
      // accepted severities, identity requirements, rate limit, triage SLA,
      // verdict enum, and the verdict polling URL template. Plain JSON, no
      // signature: the standard's discovery card is advisory, not
      // attestable (it states the room's policy; the room's signed agent
      // card is the attestable surface). Unaauthenticated like the other
      // well-known metadata on this door.
      if (url.pathname === "/.well-known/feedback" && ["GET", "HEAD"].includes(req.method)) {
        const origin = expectedOrigin();
        return json(res, 200, {
          feedback_version: "1",
          intake: { url_template: `${origin}/api/rooms/{roomId}/feedback`, method: "POST" },
          severities: ["bug", "perf", "missing-feature", "docs"],
          identity: { required: "authenticated room member", lane: "member id", guests: "read-only" },
          rate_limit: { filings_per_lane_per_hour: 10 },
          triage_sla: "reviewers aim for a first verdict within 24 hours of filing",
          verdict_enum: ["real", "junk", "user-error"],
          verdict_polling: { url_template: `${origin}/api/rooms/{roomId}/feedback/{feedback_id}`, method: "GET" },
        }, req.method === "HEAD");
      }
      // GET /oauth/authorize — validate the request and show the consent screen.
      // The user must be logged in (account session cookie); otherwise redirect
      // to the login page with a return URL.
      if (url.pathname === "/oauth/authorize" && req.method === "GET") {
        rate(`oauth-authorize:${remoteAddress}`, 30);
        const slotToken = cookie(req, accountCookieName);
        // QA-Sec 2026-09-19: the old code read slot?.session?.account?.id,
        // but accountSessionSlot never populates account (always null), so
        // every logged-in user was bounced to login and consent could never
        // complete. Authenticate the account session properly.
        let auth = null;
        try { auth = slotToken ? store.authenticateAccountSession(slotToken) : null; } catch { auth = null; }
        if (!auth || !auth.account?.id) {
          res.statusCode = 302;
          res.setHeader("Location", "/?oauth=login&return=" + encodeURIComponent(url.pathname + url.search));
          return res.end();
        }
        let validated;
        try {
          validated = oauthProvider.validateAuthorizationRequest({
            clientId: url.searchParams.get("client_id"),
            redirectUri: url.searchParams.get("redirect_uri"),
            scopes: (url.searchParams.get("scope") || "").split(" ").filter(Boolean),
            state: url.searchParams.get("state"),
            codeChallenge: url.searchParams.get("code_challenge"),
          });
          if (url.searchParams.get("code_challenge_method") !== "S256") {
            throw new ServiceError(400, "invalid_request", "code_challenge_method must be S256");
          }
        } catch (error) {
          const code = error instanceof ServiceError ? error.code : "invalid_request";
          return json(res, 400, { error: code, error_description: error.message });
        }
        const scopeLabels = {
          "rooms:read": "See your rooms",
          "chat:read": "Read messages",
          "chat:write": "Post messages",
          "work:read": "See work items",
          "work:write": "Accept and complete work",
        };
        const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        const scopeItems = validated.client.clientId === "project-room-macos"
          ? "<li>Sign in to the Mac app with this account, including its room and account controls. The Mac session is separate from this browser.</li>"
          : validated.scopes.map(s => `<li>${esc(scopeLabels[s] || s)}</li>`).join("");
        const revocationHelp = validated.client.clientId === "project-room-macos"
          ? "Sign out from Account in the Mac app to end its session. Signing out of this browser leaves the Mac app signed in."
          : "Revoke access with the /api/oauth/sessions endpoints or POST /oauth/revoke.";
        const nativeAccountName = validated.client.clientId === "project-room-macos"
          ? store.accountProfile(auth.account.id).displayName : null;
        const nativeAccountEmail = validated.client.clientId === "project-room-macos"
          ? store.accountLogins.listMethods(auth.account.id).find(method => !method.disabled && method.email && method.verifiedAt != null)?.email : null;
        const nativeAccountLabel = [nativeAccountName, nativeAccountEmail].filter(Boolean).join(" · ") || "Current signed-in account";
        const nativeConsentWarning = validated.client.clientId === "project-room-macos"
          ? `<p data-native-account>Account: ${esc(nativeAccountLabel)}</p><p>Only allow this if you just chose Sign in in the Project Room Mac app.</p>` : "";
        const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect ${esc(validated.client.name)}</title><style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#1a1a1a}h1{font-size:1.25rem}ul{padding-left:1.25rem}.actions{margin-top:1.5rem;display:flex;gap:.75rem}button{padding:.6rem 1.25rem;border-radius:.5rem;border:1px solid #ccc;font-size:1rem;cursor:pointer}.primary{background:#0066cc;color:#fff;border-color:#0066cc}</style></head><body><h1>Connect ${esc(validated.client.name)} to Project Room?</h1><p><strong>${esc(validated.client.name)}</strong> is requesting access to your Project Room account. It will be able to:</p><ul>${scopeItems}</ul><p>${esc(revocationHelp)}</p>${nativeConsentWarning}<form method="post" action="/oauth/authorize"><input type="hidden" name="client_id" value="${esc(url.searchParams.get("client_id"))}"><input type="hidden" name="redirect_uri" value="${esc(url.searchParams.get("redirect_uri"))}"><input type="hidden" name="scope" value="${esc(url.searchParams.get("scope") || "")}"><input type="hidden" name="state" value="${esc(url.searchParams.get("state") || "")}"><input type="hidden" name="code_challenge" value="${esc(url.searchParams.get("code_challenge"))}"><input type="hidden" name="code_challenge_method" value="S256"><input type="hidden" name="csrf_token" value="${esc(auth.csrf)}"><div class="actions"><button type="submit" name="decision" value="allow" class="primary">Allow</button><button type="submit" name="decision" value="deny">Deny</button></div></form></body></html>`;
        const bytes = Buffer.from(html, "utf8");
        res.setHeader("Referrer-Policy", "same-origin");
        res.setHeader("Content-Security-Policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; style-src 'unsafe-inline'");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": bytes.length });
        return res.end(bytes);
      }
      // POST /oauth/authorize — process the consent decision. Accepts the
      // server's own consent form (application/x-www-form-urlencoded with a
      // csrf_token field) and JSON API clients (x-csrf-token header).
      if (url.pathname === "/oauth/authorize" && req.method === "POST") {
        rate(`oauth-authorize:${remoteAddress}`, 30);
        const slotToken = cookie(req, accountCookieName);
        // QA-Sec 2026-09-19: authenticateAccountSession, not the raw slot
        // (whose account is always null) — the same authN fix QA-Auth #720
        // made on this endpoint.
        let auth = null;
        try { auth = slotToken ? store.authenticateAccountSession(slotToken) : null; } catch { auth = null; }
        if (!auth || !auth.account?.id) reject(401, "account_session_required", "Log in to Project Room first");
        const accountId = auth.account.id;
        const contentType = req.headers["content-type"] || "";
        let data;
        if (/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(contentType)) {
          // Consent-form submission: same bounded reader as the JSON body.
          const text = await readText(req, JSON_BODY_BYTES, () => new ServiceError(413, "too_large", "Request is too large"));
          data = Object.fromEntries(new URLSearchParams(text));
        } else {
          data = await body(req);
        }
        // CSRF for the consent POST: the form carries csrf_token in the body
        // (browsers can't set x-csrf-token); API clients use the header.
        // Either way it must equal the session's csrf token.
        checkOrigin(req, true);
        const presented = req.headers["x-csrf-token"] ?? data.csrf_token;
        if (typeof presented !== "string" || !bindingPattern.test(presented) || !auth.csrf
          || !timingSafeEqual(Buffer.from(presented), Buffer.from(auth.csrf))) reject(403, "csrf_denied", "Session confirmation required; sign in again");
        // QA-Auth #720: validate the authorization request BEFORE acting on
        // the decision. The redirect target must be a registered client URI:
        // an unvalidated redirect_uri on the deny/error path was an open
        // redirect, and a malformed URI threw an uncaught 500. Per
        // RFC 6749 §4.1.2.1, error responses redirect only when the
        // redirect_uri itself is valid; otherwise 400 JSON directly.
        let validated;
        try {
          validated = oauthProvider.validateAuthorizationRequest({
            clientId: data.client_id,
            redirectUri: data.redirect_uri,
            scopes: String(data.scope || "").split(" ").filter(Boolean),
            state: data.state,
            codeChallenge: data.code_challenge,
          });
          if (data.code_challenge_method !== "S256") {
            throw new ServiceError(400, "invalid_request", "code_challenge_method must be S256");
          }
        } catch (error) {
          const code = error instanceof ServiceError ? error.code : "invalid_request";
          return json(res, 400, { error: code, error_description: error.message });
        }
        const decision = data.decision;
        const state = validated.state;
        const failRedirect = (error, description) => {
          const u = new URL(validated.redirectUri);
          u.searchParams.set("error", error);
          if (description) u.searchParams.set("error_description", description);
          if (state) u.searchParams.set("state", state);
          res.statusCode = 302;
          res.setHeader("Location", u.href);
          return res.end();
        };
        if (decision !== "allow") return failRedirect("access_denied", "The user denied the request");
        const { code } = oauthProvider.issueCode({
          clientId: validated.client.clientId,
          userId: accountId,
          redirectUri: validated.redirectUri,
          scopes: [...validated.scopes],
          codeChallenge: validated.codeChallenge,
        });
        const u = new URL(validated.redirectUri);
        u.searchParams.set("code", code);
        if (state) u.searchParams.set("state", state);
        res.statusCode = 302;
        res.setHeader("Location", u.href);
        return res.end();
      }
      // POST /oauth/token — exchange codes and refresh tokens (RFC 6749 §4.1.3, §6).
      if (url.pathname === "/oauth/token" && req.method === "POST") {
        rate(`oauth-token-exchange:${remoteAddress}`, 60);
        const data = await body(req);
        const grantType = data.grant_type;
        // F-02 session metadata: the IP and User-Agent seen at issuance,
        // stored read-only on the token records so GET /api/oauth/sessions
        // can show the user which sessions are theirs.
        const sessionMeta = {
          ip: typeof remoteAddress === "string" ? remoteAddress : null,
          userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
        };
        try {
          let tokens;
          if (grantType === "authorization_code") {
            tokens = oauthProvider.exchangeCode({
              code: data.code,
              clientId: data.client_id,
              redirectUri: data.redirect_uri,
              codeVerifier: data.code_verifier,
              session: sessionMeta,
            });
          } else if (grantType === "refresh_token") {
            tokens = oauthProvider.refresh({
              refreshToken: data.refresh_token,
              clientId: data.client_id,
              session: sessionMeta,
            });
          } else {
            return json(res, 400, { error: "unsupported_grant_type" });
          }
          return json(res, 200, {
            access_token: tokens.accessToken,
            refresh_token: tokens.refreshToken,
            token_type: tokens.tokenType,
            expires_in: tokens.expiresIn,
            scope: tokens.scopes.join(" "),
          });
        } catch (error) {
          const code = error.code === "invalid_request" ? "invalid_request" : "invalid_grant";
          return json(res, 400, { error: code, error_description: error.message });
        }
      }
      // POST /oauth/revoke — revoke an access or refresh token (RFC 7009).
      // F-02: revoking a refresh token kills its whole token family, so
      // every access token derived from the grant dies immediately (this
      // is what the consent screen promises). Revoking an access token
      // stays surgical — only that token dies.
      if (url.pathname === "/oauth/revoke" && req.method === "POST") {
        rate(`oauth-revoke:${remoteAddress}`, 60);
        const data = await body(req);
        oauthProvider.revoke(data.token);
        return json(res, 200, {});
      }
      // GET /api/oauth/sessions — list the signed-in account's active OAuth
      // sessions (F-02). One entry per live token family: client, issued-at,
      // scopes, and the IP/User-Agent seen at issuance. Account session
      // cookie + session binding; a caller only ever sees their own families.
      if (url.pathname === "/api/oauth/sessions" && req.method === "GET") {
        rate(`oauth-sessions-list:${remoteAddress}`, 60);
        const slotToken = cookie(req, accountCookieName);
        if (!slotToken) reject(401, "account_session_required", "Sign in to manage connected sessions");
        const auth = store.authenticateAccountSession(slotToken, null, accountBinding(req));
        return json(res, 200, { sessions: oauthProvider.listSessions({ userId: auth.account.id }) });
      }
      // POST /api/oauth/sessions/revoke-all — kill every OAuth session for
      // the signed-in account (F-02): all refresh families and access tokens
      // die immediately, across all clients. The consent promise made real.
      if (url.pathname === "/api/oauth/sessions/revoke-all" && req.method === "POST") {
        rate(`oauth-sessions-revoke-all:${remoteAddress}`, 30);
        const slotToken = cookie(req, accountCookieName);
        if (!slotToken) reject(401, "account_session_required", "Sign in to manage connected sessions");
        const auth = store.authenticateAccountSession(slotToken, null, accountBinding(req));
        protectWrite(req, auth, false);
        const revoked = oauthProvider.revokeAllForUser({ userId: auth.account.id });
        return json(res, 200, { revoked });
      }
      // DELETE /api/oauth/sessions/:id — kill one session (token family)
      // owned by the signed-in account (F-02). Unknown ids and other users'
      // families both answer 404, so a caller can't probe for them.
      const oauthSessionKill = /^\/api\/oauth\/sessions\/([^/]{1,128})$/.exec(url.pathname);
      if (oauthSessionKill && req.method === "DELETE") {
        rate(`oauth-session-kill:${remoteAddress}`, 60);
        const slotToken = cookie(req, accountCookieName);
        if (!slotToken) reject(401, "account_session_required", "Sign in to manage connected sessions");
        const auth = store.authenticateAccountSession(slotToken, null, accountBinding(req));
        protectWrite(req, auth, false);
        const revoked = oauthProvider.revokeSession({ userId: auth.account.id, familyId: oauthSessionKill[1] });
        if (revoked === 0) reject(404, "session_not_found", "No such active session");
        return json(res, 200, { revoked });
      }
      if (url.pathname === "/api/ready" && ["GET", "HEAD"].includes(req.method)) {
        try {
          if (store.storageStatus?.().unavailable) return json(res, 503, { status: "unavailable", reason: "storage_unavailable" }, req.method === "HEAD");
          if (!store.db.prepare("SELECT 1 FROM rooms LIMIT 1").get()) throw new Error("No room");
          return json(res, 200, { status: "ready" }, req.method === "HEAD");
        } catch { return json(res, 503, { status: "unavailable" }, req.method === "HEAD"); }
      }
      // Track C C14 — read-only growth analytics surface. The handler is a
      // pure read over the collector/scheduler; unknown /growth subpaths 404
      // inside the handler so the surface stays explicit. Failure-isolated:
      // a throwing handler degrades to a 503, never to a dropped connection.
      if (growth) {
        let growthReply = null;
        try {
          growthReply = growth.handle(url.pathname, req.method, url.searchParams);
        } catch { return json(res, 503, { status: "unavailable", reason: "growth_unavailable" }); }
        if (growthReply) return json(res, growthReply.status, growthReply.body);
      }
      // W009 — read-only wiki API for agents (procedures, lessons, runbooks).
      // Prefix-delegated: server/wiki-read-api.mjs owns every /api/wiki/
      // template and throws ServiceError for 4xx/503, so the canonical error
      // envelope applies and a throwing plane fails closed to 503, never to a
      // dropped connection. /room/api/wiki/* reaches here via the prefix rewrite.
      if (url.pathname.startsWith("/api/wiki/")) {
        const wikiReply = wikiReadApi.handle(url.pathname, req.method, url.searchParams);
        if (wikiReply) return json(res, wikiReply.status, wikiReply.body, req.method === "HEAD");
      }
      // Public Hosts (www / lobby / apex) reverse-proxy /room here. Browsers
      // go directly to the canonical workspace app. Packets stay
      // at /llms.txt, /room/llms.txt, /skill.md, /room/skill, agent.json,
      // and the kits catalog at /kits.txt / /room/kits.
      if (isPublicRoomDoorPath(url.pathname)) {
        if (!["GET", "HEAD"].includes(req.method)) reject(405, "method_not_allowed", "Method not allowed");
        if (wantsPublicDoorHtml(req.headers.accept)) {
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("Link", `${discoveryLinks(url)}, <${expectedOrigin()}/>; rel="canonical"`);
          res.writeHead(302, { Location: publicRoomAppUrl(url.href, expectedOrigin()) });
          return res.end();
        }
        const packet = discoveryDoc("/llms.txt");
        res.setHeader("X-Robots-Tag", "all");
        res.setHeader("Link", discoveryLinks(url));
        const packetBytes = Buffer.from(packet.body);
        res.writeHead(200, { "Content-Type": packet.type, "Content-Length": packetBytes.length });
        return res.end(req.method === "HEAD" ? undefined : packetBytes);
      }
      const discovery = discoveryDoc(url.pathname);
      if (discovery === MCP_SERVER_CARD_DOC && req.method === "OPTIONS") {
        res.setHeader("X-Robots-Tag", "all");
        res.setHeader("Cache-Control", MCP_DISCOVERY_CACHE_CONTROL);
        for (const [name, value] of Object.entries(MCP_SERVER_CARD_CORS)) res.setHeader(name, value);
        res.writeHead(204, { Allow: "GET, HEAD, OPTIONS" });
        return res.end();
      }
      if (discovery && ["GET", "HEAD"].includes(req.method)) {
        res.setHeader("X-Robots-Tag", "all");
        res.setHeader("Link", discoveryLinks(url));
        if (discovery === MCP_SERVER_CARD_DOC) {
          res.setHeader("Cache-Control", MCP_DISCOVERY_CACHE_CONTROL);
          for (const [name, value] of Object.entries(MCP_SERVER_CARD_CORS)) res.setHeader(name, value);
        }
        let docBody = discovery.body;
        // RC-2026-09-24-202: the skills catalog gains a `members` array of
        // opted-in member skill cards (publish:true). The static deploy
        // asset carries the base catalog; the node server injects the live
        // member layer. Skills without evidence render "self-declared".
        if (discovery === SKILLS_CATALOG_DOC) {
          try {
            const catalog = JSON.parse(docBody);
            catalog.members = store.membersDirectory.publishedMembers();
            docBody = JSON.stringify(catalog, null, 2) + "\n";
          } catch { /* static body keeps its shape on parse failure */ }
        }
        const bytes = Buffer.from(docBody);
        res.writeHead(200, { "Content-Type": discovery.type, "Content-Length": bytes.length });
        return res.end(req.method === "HEAD" ? undefined : bytes);
      }
      if (discovery) reject(405, "method_not_allowed", "Method not allowed");
      // Burs-IA steal A1: GET /openapi.json is generated from the canonical
      // route table (server/discoverability.mjs), never hand-maintained, so
      // the served spec cannot drift from the live routes. The /room alias
      // keeps the prefix-preserving www edge consistent with the packets.
      if (url.pathname === "/openapi.json" || url.pathname === "/room/openapi.json") {
        if (!["GET", "HEAD"].includes(req.method)) reject(405, "method_not_allowed", "Method not allowed");
        return json(res, 200, buildOpenApiJson({ origin: expectedOrigin() }), req.method === "HEAD");
      }
      // Public room directory (#605): owner opt-in listing so a freshly
      // minted identity can discover real rooms to request access to.
      // Sanitized field-by-field in the module: no member, identity, or
      // DM data ever leaves. Registered BEFORE the /api/public/rooms/{code}
      // matcher below, which would otherwise read "directory" as a code.
      if (url.pathname === "/api/public/rooms/directory" && req.method === "GET") {
        rate(`room-directory:${remoteAddress}`, 120);
        return json(res, 200, store.roomDirectory.list({
          after: url.searchParams.get("after"),
          limit: url.searchParams.get("limit"),
        }));
      }
      if (url.pathname === "/api/public/rooms/directory") reject(405, "method_not_allowed", "Method not allowed");
      if (url.pathname === "/api/public-work/match") {
        if (req.method !== "POST") reject(405, "method_not_allowed", "Method not allowed", { Allow: "POST" });
        if ([...url.searchParams].length) reject(422, "invalid_public_work", "No matching query parameters accepted");
        rate(`public-work-match:${remoteAddress}`, 60);
        const secret = bearer(req);
        const input = await body(req);
        return json(res, 200, store.publicWorkClaims.match(secret, input));
      }
      const publicWorkReviewMatch = /^\/api\/public-work\/receipts\/([^/]{1,128})\/review$/.exec(url.pathname);
      if (publicWorkReviewMatch) {
        if (!["GET", "HEAD"].includes(req.method)) reject(405, "method_not_allowed", "Method not allowed", { Allow: "GET, HEAD" });
        if ([...url.searchParams].length) reject(422, "invalid_public_work_review", "No review query parameters accepted");
        rate(`public-work-review:${remoteAddress}`, 120);
        return json(res, 200, store.publicWorkReviews.contributorReview(bearer(req), pathId(publicWorkReviewMatch[1])), req.method === "HEAD");
      }
      const publicWorkTaskMatch = /^\/api\/public-work\/tasks\/([^/]{1,128})(?:\/(claim|renew|release|finish))?$/.exec(url.pathname);
      const publicWorkReceiptMatch = /^\/api\/public-work\/receipts\/([^/]{1,128})(?:\/(artifact))?$/.exec(url.pathname);
      if (url.pathname === "/api/public-work/tasks" || publicWorkTaskMatch || publicWorkReceiptMatch) {
        if ([...url.searchParams.keys()].some(key => url.pathname !== "/api/public-work/tasks" || !["limit", "after"].includes(key) || url.searchParams.getAll(key).length !== 1)) reject(422, "invalid_public_work", "Unsupported query parameters");
        const action = publicWorkTaskMatch?.[2];
        if (action) {
          if (req.method !== "POST") reject(405, "method_not_allowed", "Method not allowed", { Allow: "POST" });
          rate(`public-work-write:${remoteAddress}`, 60);
          const secret = bearer(req);
          const identity = store.identities.resolveGlobalIdentitySecret(secret);
          if (!identity) reject(401, "unauthenticated", "Use your saved agent identity credential");
          rate(`public-work-identity:${identity.identityId}`, 60);
          // Escaped JSON can be larger than the domain's 64KiB UTF8 artifact.
          // The larger envelope limit applies to this one route only.
          const data = await body(req, action === "finish" ? { limit: 524288 } : {});
          // The service reauthenticates the unchanged credential inside its
          // write transaction after the awaited upload, including on replay.
          return json(res, 200, store.publicWorkClaims.act(pathId(publicWorkTaskMatch[1]), secret, action, data));
        }
        if (!["GET", "HEAD"].includes(req.method)) reject(405, "method_not_allowed", "Method not allowed", { Allow: "GET, HEAD" });
        rate(`public-work-read:${remoteAddress}`, 120);
        if (publicWorkReceiptMatch) {
          const receiptId = pathId(publicWorkReceiptMatch[1]);
          // Owner-only public-receipts toggle: a room that turned receipts
          // private still serves them to its members; everyone else gets 403.
          // The credential is optional here — anonymous reads stay open for
          // rooms that never flipped the toggle (current behavior).
          const receiptRoomId = store.publicWorkClaims.receiptRoomId(receiptId);
          let memberId = null;
          if (receiptRoomId && !store.roomDirectory.publicReceiptsVisible(receiptRoomId)) {
            const secret = bearer(req);
            if (secret) {
              try {
                const viewerAuth = store.authenticate(secret, receiptRoomId);
                if (viewerAuth?.member?.id) memberId = viewerAuth.member.id;
              } catch { /* anonymous: the 403 below names the real problem */ }
            }
          }
          const viewer = memberId ? { memberId } : {};
          if (publicWorkReceiptMatch[2]) {
            const artifact = store.publicWorkClaims.artifact(receiptId, viewer);
            res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": "attachment; filename=contribution.txt", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox", "Cache-Control": "no-store" });
            return res.end(req.method === "HEAD" ? undefined : artifact.artifactText);
          }
          return json(res, 200, store.publicWorkClaims.receipt(receiptId, viewer), req.method === "HEAD");
        }
        return json(res, 200, publicWorkTaskMatch
          ? store.publicWorkClaims.read(pathId(publicWorkTaskMatch[1]))
          : store.publicWorkClaims.list({ limit: Number(url.searchParams.get("limit") ?? 20), after: url.searchParams.get("after") ?? "" }), req.method === "HEAD");
      }
      const projectOfferPublicMatch = /^\/api\/project-offers\/([^/]{1,128})(?:\/(brief.md))?$/.exec(url.pathname);
      if (url.pathname === "/api/project-offers" || projectOfferPublicMatch) {
        if (!["GET", "HEAD"].includes(req.method)) reject(405, "method_not_allowed", "Method not allowed");
        rate(`project-offers:${remoteAddress}`, 120);
        if (projectOfferPublicMatch) {
          // Exact literal guard: route inventory expands the dot-form matcher.
          if (projectOfferPublicMatch[2] && projectOfferPublicMatch[2] !== "brief.md") reject(404, "not_found", "Not found");
          if ([...url.searchParams].length) reject(422, "invalid_project_offer", "No detail query parameters accepted");
          const offerId = pathId(projectOfferPublicMatch[1]);
          if (projectOfferPublicMatch[2]) {
            const brief = store.projectOffers.brief(offerId);
            res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" });
            return res.end(req.method === "HEAD" ? undefined : brief);
          }
          return json(res, 200, store.projectOffers.read(offerId));
        }
        if ([...url.searchParams.keys()].some(key => !["limit", "after"].includes(key) || url.searchParams.getAll(key).length !== 1)) reject(422, "invalid_project_offer", "Only limit and after accepted");
        return json(res, 200, store.projectOffers.list({ limit: url.searchParams.get("limit") ?? 20, after: url.searchParams.get("after") }));
      }
      // Public opportunity feed (v2): read-only discovery of open work
      // across directory-listed rooms. Decoupled from admission — reading
      // the feed grants nothing; acting on an opportunity uses the normal
      // invite/join flow. Strict public shape: no member, identity, invite
      // code, or admission data ever leaves. ?since=<cursor> returns only
      // items opened/created after the cursor (cheap resume for pollers).
      if (url.pathname === "/api/opportunities.json" && req.method === "GET") {
        rate(`opportunities:${remoteAddress}`, 120);
        return json(res, 200, buildOpportunitiesFeed(store, {
          now: store.now(),
          roomId: url.searchParams.get("room"),
          limit: url.searchParams.get("limit"),
          since: url.searchParams.get("since"),
        }));
      }
      if (url.pathname === "/api/opportunities.json") reject(405, "method_not_allowed", "Method not allowed");
      // Public read-only face: no login, owner opt-in only. The code is the
      // Bearer <redacted> (unguessable pub1.*); no member, identity, or DM data ever leaves.
      const publicFaceMatch = /^\/p\/([A-Za-z0-9._~-]{1,128})$/.exec(url.pathname);
      // The /api/public/* matchers use the extractor-friendly ([^/]{1,128})
      // group form so scripts/open-routes.mjs can inventory them; the code
      // charset is validated below (unknown/malformed codes 404 identically).
      const publicApiMatch = /^\/api\/public\/rooms\/([^/]{1,128})$/.exec(url.pathname);
      const publicFeedMatch = /^\/api\/public\/rooms\/([^/]{1,128})\/feed$/.exec(url.pathname);
      const publicApiAny = publicApiMatch ?? publicFeedMatch;
      if ((publicFaceMatch || publicApiAny) && req.method === "GET") {
        rate(`public-face:${remoteAddress}`, 120);
        const code = (publicFaceMatch ?? publicApiAny)[1];
        // Malformed/unknown/disabled codes all 404 as face_not_found inside
        // the module (never plain not_found, so the invite-only boundary
        // probe counts these routes as served-open rather than unserved).
        res.setHeader("X-Robots-Tag", "noindex, nofollow");
        res.setHeader("Link", discoveryLinks(url));
        if (publicFeedMatch) {
          const after = url.searchParams.get("after");
          const limit = url.searchParams.get("limit");
          return json(res, 200, store.publicFace.feedByCode(code, {
            after: after ?? null,
            limit: limit == null ? 50 : Number(limit)
          }));
        }
        if (publicApiAny) return json(res, 200, store.publicFace.faceByCode(code));
        const accept = String(req.headers.accept || "");
        if (accept.includes("application/json") && !accept.includes("text/html")) {
          return json(res, 200, store.publicFace.faceByCode(code));
        }
        const html = store.publicFace.faceHtml(code);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
        return res.end(html);
      }
      if (publicFaceMatch || publicApiAny) reject(405, "method_not_allowed", "Method not allowed");
      // --- ACT-2a public agent-connect page: GET /a/<code> ---
      // RT's route table has not landed. In-memory limiter until a persisted limiter lands.
      if (handleAgentConnect(req, url, { res, store, remoteAddress, rate, reject, origin: expectedOrigin() })) return;
      // --- end ACT-2a ---
      // --- GR1 public pages: live receipts and /room/<marketing> aliases ---
      const gr1Alias = gr1PublicPath(url.pathname);
      if (gr1Alias) url.pathname = gr1Alias;
      // --- GR2 ---
      const gr2Alias = gr2PublicPath(url.pathname);
      if (gr2Alias) url.pathname = gr2Alias;
      // --- end GR2 ---
      const receiptDetail = /^\/receipts\/((?:pwr_[a-f0-9]{16,128}|wcr_[a-f0-9]{32}|wir_[a-f0-9]{32}))(\.json)?$/.exec(url.pathname);
      if ((url.pathname === "/receipts" || url.pathname === "/api/public/receipts" || receiptDetail) && ["GET", "HEAD"].includes(req.method)) {
        rate(`receipts:${remoteAddress}`, 120);
        const indexable = !url.search;
        if (indexable) res.setHeader("X-Robots-Tag", "all");
        // Owner-only public-receipts toggle: these representations are
        // toggle-controlled, so they must never sit in a shared cache — a
        // response cached while public would keep disclosing a room's
        // receipts after the owner switches privacy off.
        res.setHeader("Cache-Control", "no-store");
        if (receiptDetail) {
          if (!PUBLIC_RECEIPT_ID.test(receiptDetail[1])) reject(404, "not_found", "Not found");
          const receipt = publicReceiptById(store, receiptDetail[1]);
          if (!receipt) reject(404, "not_found", "Not found");
          res.setHeader("Link", publicPageLinks(url, `/receipts/${receipt.id}`));
          if (receiptDetail[2]) {
            const body = Buffer.from(JSON.stringify(receiptJson(receipt)));
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length });
            return res.end(req.method === "HEAD" ? undefined : body);
          }
          // JDOT-PUBLIC-CSP-RUM begin: public-page policy
          res.setHeader("Content-Security-Policy", publicPageCsp(expectedOrigin(), RECEIPTS_PAGE_CSP));
          // JDOT-PUBLIC-CSP-RUM end
          const html = Buffer.from(renderReceiptDetailHtml(receipt));
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": html.length });
          return res.end(req.method === "HEAD" ? undefined : html);
        }
        const limitRaw = url.searchParams.get("limit");
        const queried = queryPublicReceipts(store, {
          room: url.searchParams.get("room"),
          agent: url.searchParams.get("agent"),
          cursor: url.searchParams.get("cursor"),
          limit: limitRaw == null ? 20 : Number(limitRaw),
        });
        if (queried.error) reject(queried.error.status, queried.error.code, queried.error.message);
        res.setHeader("Link", publicPageLinks(url, "/receipts"));
        if (url.pathname === "/api/public/receipts") {
          const body = Buffer.from(JSON.stringify(receiptsListJson(queried)));
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length });
          return res.end(req.method === "HEAD" ? undefined : body);
        }
        // JDOT-PUBLIC-CSP-RUM begin: public-page policy
        res.setHeader("Content-Security-Policy", publicPageCsp(expectedOrigin(), RECEIPTS_PAGE_CSP));
        // JDOT-PUBLIC-CSP-RUM end
        const html = Buffer.from(renderReceiptsHtml(queried));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": html.length });
        return res.end(req.method === "HEAD" ? undefined : html);
      }
      if (url.pathname === "/receipts" || url.pathname === "/api/public/receipts" || receiptDetail) reject(405, "method_not_allowed", "Method not allowed");
      if ((url.pathname === "/join.html" || url.pathname === "/room/join.html") && ["GET", "HEAD"].includes(req.method)) {
        res.writeHead(301, { Location: url.pathname.replace(/\.html$/, "") + url.search });
        return res.end();
      }
      if ((url.pathname === "/favicon.ico" || url.pathname === "/room/favicon.ico") && ["GET", "HEAD"].includes(req.method)) {
        res.writeHead(301, { Location: (url.pathname.startsWith("/room/") ? "/room" : "") + "/favicon.svg" });
        return res.end();
      }
      // --- LEGAL public pages, terms acceptance, abuse reports, operator unpublish (G-SEC-11, G-SEC-14). ---
      if (legalApiPaths.has(url.pathname) || isLegalPath(url.pathname)) {
        const handled = await handleLegalRequest({
          req, res, url, store, rate, remoteAddress, readBody: body, json, cookie, protectWrite, reject,
          operatorAccountId, accountCookieName, accountView: sessionAccountView,
        });
        if (handled) return;
      }
      // --- end LEGAL ---
      if (url.pathname === "/sitemap.xml" && ["GET", "HEAD"].includes(req.method)) {
        // Confirm bytes exist before advertising an asset-backed canonical URL.
        const candidates = [...publicSearchAssets(publicAssetPaths)]
          .filter(([path]) => reviewedPublicSearchPaths.includes(path));
        // Independent immutable assets need no serial I/O round trips. Keep
        // catalog order and use the same loader as page serving; a failed
        // read still excludes the page rather than poisoning the whole map.
        const availability = await Promise.allSettled(candidates.map(async ([, file]) => loadAsset(file)));
        const available = candidates.filter((_, i) => availability[i].status === "fulfilled")
          .map(([path]) => path);
        const receiptEntries = listPublicReceiptSitemap(store).map(item => ({
          path: item.path,
          lastmod: item.lastmod || PUBLIC_PAGE_LASTMOD,
        }));
        const xml = publicSearchSitemap(ROOM_ORIGIN, [
          ...available.map(path => ({ path, lastmod: PUBLIC_PAGE_LASTMOD })),
          { path: "/receipts", lastmod: PUBLIC_PAGE_LASTMOD },
          ...LEGAL_SITEMAP_PATHS.map(path => ({ path, lastmod: PUBLIC_PAGE_LASTMOD })),
          ...receiptEntries,
          ...publicSitemapEntries(store), // GR2 templates, agents, and opted-in room pages
        ]);
        if (!url.search) res.setHeader("X-Robots-Tag", "all");
        res.setHeader("Link", publicPageLinks(url, "/sitemap.xml"));
        res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8" });
        return res.end(req.method === "HEAD" ? undefined : xml);
      }
      // --- GR2 public acquisition pages. Script-free. Indexable when the URL has no query. ---
      const templateDetail = /^\/templates\/([a-z0-9][a-z0-9-]{0,63})(\.json)?$/.exec(url.pathname);
      const roomPage = /^\/r\/([a-z0-9][a-z0-9-]{0,63})(\.json)?$/.exec(url.pathname);
      const acquisition = url.pathname === "/templates" || url.pathname === "/templates.json"
        || url.pathname === "/agents" || templateDetail || roomPage;
      if (acquisition && ["GET", "HEAD"].includes(req.method)) {
        rate(`acquisition:${remoteAddress}`, 120);
        const ref = url.searchParams.get("ref") ?? "";
        const sendPage = (status, html, jsonBody, canonical, cacheControl = "public, max-age=60") => {
          if (!url.search) res.setHeader("X-Robots-Tag", "all");
          res.setHeader("Cache-Control", cacheControl);
          res.setHeader("Link", publicPageLinks(url, canonical));
          if (jsonBody) {
            const body = Buffer.from(JSON.stringify(jsonBody));
            res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length });
            return res.end(req.method === "HEAD" ? undefined : body);
          }
          // JDOT-PUBLIC-CSP-RUM begin: public-page policy
          res.setHeader("Content-Security-Policy", publicPageCsp(expectedOrigin(), PUBLIC_PAGE_CSP));
          // JDOT-PUBLIC-CSP-RUM end
          const body = Buffer.from(html);
          res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Content-Length": body.length });
          return res.end(req.method === "HEAD" ? undefined : body);
        };
        if (url.pathname === "/templates" || url.pathname === "/templates.json") {
          const page = templatesIndex();
          return sendPage(200, page.html, url.pathname.endsWith(".json") ? page.document : null, "/templates");
        }
        if (templateDetail) {
          const page = templatePage(templateDetail[1], { ref });
          if (!page) reject(404, "not_found", "Not found");
          return sendPage(200, page.html, templateDetail[2] ? page.document : null, `/templates/${templateDetail[1]}`);
        }
        if (url.pathname === "/agents") {
          const page = agentDirectoryView(store, { ref, cursor: url.searchParams.get("cursor") });
          if (page.error) reject(page.error.status, page.error.code, page.error.message);
          return sendPage(200, page.html, null, "/agents");
        }
        const page = publicRoomView(store, roomPage[1], { ref });
        // A browser opening /r/<slug> for a room that is unknown or not
        // published gets the same styled 404 as any other public path, not
        // the JSON API envelope; /r/<slug>.json and non-HTML clients keep JSON.
        if (!page && !roomPage[2] && acceptPrefersHtml(req.headers.accept)) {
          const body = Buffer.from(PUBLIC_NOT_FOUND_HTML);
          res.setHeader("X-Robots-Tag", "noindex");
          res.writeHead(404, { "Content-Type": "text/html; charset=utf-8", "Content-Length": body.length });
          return res.end(req.method === "HEAD" ? undefined : body);
        }
        if (!page) reject(404, "not_found", "Not found");
        // Owner-only public-receipts toggle: the room page lists receipt
        // titles, so like the receipts routes it must never sit in a shared
        // cache — a response cached while public would keep disclosing a
        // room's receipts after the owner switches privacy off.
        return sendPage(200, page.html, roomPage[2] ? page.document : null, `/r/${roomPage[1]}`, "no-store");
      }
      if (acquisition) reject(405, "method_not_allowed", "Method not allowed");
      // --- end GR2 ---
      if (assets.has(url.pathname) && ["GET", "HEAD"].includes(req.method)) {
        const [path, type] = assets.get(url.pathname);
        const data = await loadAsset(path);
        const canonical = publicSearchCanonical(url.pathname, publicAssetPaths);
        // JDOT-PUBLIC-CSP-RUM begin: public-page policy
        if (canonical && publicSearchMarketingPolicy(canonical)) res.setHeader("Content-Security-Policy", publicPageCsp(expectedOrigin(), PUBLIC_SEARCH_CSP));
        // JDOT-PUBLIC-CSP-RUM end
        if (canonical && !url.search) {
          if (canonical !== url.pathname) {
            res.writeHead(301, { Location: canonical });
            return res.end();
          }
          if (reviewedPublicSearchPaths.includes(canonical)) res.setHeader("X-Robots-Tag", "all");
        }
        // RFC 8288 discovery hints on the public HTML door too: a cold agent
        // starting at GET / alone can find the agent card from Link headers.
        // GR1: marketing documents also name the canonical host.
        const linkPath = canonical && reviewedPublicSearchPaths.includes(canonical) ? canonical : (gr1Alias ? url.pathname : null);
        res.setHeader("Link", linkPath ? publicPageLinks(url, linkPath) : discoveryLinks(url));
        const binary = type === "image/png" || type === "font/ttf";
        if (binary) res.setHeader("Cache-Control", "public, max-age=86400");
        res.writeHead(200, { "Content-Type": binary ? type : `${type}; charset=utf-8` });
        return res.end(req.method === "HEAD" ? undefined : data);
      }
      if (url.pathname === "/api/account-rooms" && req.method === "GET") {
        const token = cookie(req, accountCookieName), binding = accountBinding(req);
        if (url.searchParams.getAll("after").length > 1) reject(422, "invalid_room", "Invalid room continuation");
        return json(res, 200, store.accountRooms(token, binding, { after: url.searchParams.get("after") }));
      }
      if (url.pathname === "/api/account-rooms" && req.method === "POST") {
        // Issue #6 A2: create a room for the signed-in account. Account session
        // cookie + X-Session-Binding + CSRF; the store allows an account with
        // no rooms yet to create its first room, otherwise requires membership
        // administration somewhere (owner or manage_members), and bounds the count.
        const token = cookie(req, accountCookieName), binding = accountBinding(req);
        const auth = store.authenticateAccountSession(token, null, binding);
        protectWrite(req, auth, false); rate(`account-room-create:${auth.account.id}`, 10);
        const result = store.createAccountRoom(token, binding, await body(req));
        return json(res, result.duplicate ? 200 : 201, result);
      }
      // --- GR2: create a room from a public template. Auth and CSRF run before the body is trusted. ---
      if (url.pathname === "/api/account-rooms/from-template" && req.method === "POST") {
        const token = cookie(req, accountCookieName), binding = accountBinding(req);
        const auth = store.authenticateAccountSession(token, null, binding);
        protectWrite(req, auth, false);
        rate(`account-template:${auth.account.id}`, 10);
        const result = applyRoomTemplate(store, token, binding, await body(req));
        return json(res, result.duplicate ? 200 : 201, result);
      }
      // --- end GR2 ---
      if (url.pathname === "/api/account/ensure-default-room" && req.method === "POST") {
        // RC-2026-09-19-088: first sign-in must never land in an empty void.
        // Idempotent: an account that already has rooms gets its first room
        // back with created=false and nothing is created.
        const token = cookie(req, accountCookieName), binding = accountBinding(req);
        const auth = store.authenticateAccountSession(token, null, binding);
        protectWrite(req, auth, false); rate(`account-default-room:${auth.account.id}`, 10);
        const existing = store.db.prepare(
          "SELECT room_id FROM member_accounts WHERE account_id=? ORDER BY room_id LIMIT 1").get(auth.account.id);
        if (existing) return json(res, 200, { room: { id: existing.room_id }, created: false });
        // An account that has ever held a room but holds none now deliberately
        // left (or was removed from) all of them — never resurrect a room.
        const row = store.db.prepare("SELECT ever_had_room, display_name FROM accounts WHERE id=?").get(auth.account.id);
        if (!row || row.ever_had_room) return json(res, 200, { room: null, created: false });
        const roomId = `personal-${randomBytes(9).toString("base64url")}`;
        const displayName = (typeof row.display_name === "string" && row.display_name.trim()) || "Owner";
        const created = store.createAccountRoom(token, binding, {
          roomId, title: "My first room", purpose: "A personal starting room.", kind: "personal", displayName });
        return json(res, created.duplicate ? 200 : 201, { room: { id: roomId }, created: !created.duplicate });
      }
      if (url.pathname === "/api/account-session") {
        const slotToken = cookie(req, accountCookieName);
        if (req.method === "GET") {
          const binding = expectedBinding(req);
          if (binding !== null) {
            // Bound account confirmation: the read names the session it is
            // checking and must never mint a recovery slot, rotate the
            // cookie, or clobber a newer sign-in. A malformed binding was
            // rejected as 422 above; authenticateAccountSession answers 401
            // for a dead session and 409 when the binding rotated.
            const confirmed = store.authenticateAccountSession(slotToken, null, binding);
            return json(res, 200, sessionAccountView(confirmed));
          }
          if (!slotToken) {
            rate(`account-slot:${remoteAddress}`, 20);
            const created = store.createAccountSessionSlot();
            setCookie(res, accountCookieName, created.token, Math.max(0, Math.floor((created.session.expiresAt - store.now()) / 1000)));
            return json(res, 200, sessionAccountView(created.session));
          }
          let slot;
          try { slot = store.authenticateAccountSession(slotToken); }
          catch (error) {
            if (error.status !== 401) throw error;
            try { slot = store.accountSessionSlot(slotToken); }
            catch (slotError) {
              if (slotError.status !== 401) throw slotError;
              rate(`account-slot:${remoteAddress}`, 20);
              const created = store.createAccountSessionSlot();
              setCookie(res, accountCookieName, created.token, Math.max(0, Math.floor((created.session.expiresAt - store.now()) / 1000)));
              slot = created.session;
            }
          }
          return json(res, 200, sessionAccountView(slot));
        }
        checkOrigin(req, true);
        if (!slotToken) reject(401, "account_session_required", "Start an account browser session before signing in");
        const slot = store.accountSessionSlot(slotToken);
        protectWrite(req, slot, false);
        const data = await body(req);
        if (req.method === "POST") {
          if (!exact(data, ["accountAccessKey", "expectedSessionRevision"]) || typeof data.accountAccessKey !== "string") reject(422, "invalid_login", "An account key and current session revision are required");
          rate(`account-login:${remoteAddress}:${slot.credentialHash}`, 10);
          const oldRoomToken = cookie(req, roomCookieName);
          // QAS-702 (RC-2026-09-19-069), QA-Auth 2026-09-19: rotate the slot
          // atomically with the login (same store transaction). The pre-login
          // token is dead on success; on failure nothing is upgraded.
          const { token: freshSlotToken, session: loggedIn } = store.loginAccountSession(slotToken, data.accountAccessKey, data.expectedSessionRevision, {
            revokeRoomToken: oldRoomToken && tokenPattern.test(oldRoomToken) ? oldRoomToken : null,
            rotateSlot: true
          });
          setCookie(res, accountCookieName, freshSlotToken, Math.max(0, Math.floor((loggedIn.expiresAt - store.now()) / 1000)));
          return json(res, 201, sessionAccountView(loggedIn));
        }
        if (req.method === "DELETE") {
          if (!exact(data, ["expectedSessionRevision"])) reject(422, "invalid_logout", "Current session revision required");
          return json(res, 200, sessionAccountView(store.logoutAccountSession(slotToken, data.expectedSessionRevision)));
        }
        reject(405, "method_not_allowed", "Method not allowed");
      }
      // ---- Recovery codes (slice 6, RC-2026-09-17-015) ----
      //
      // generate: an authenticated account session mints (or regenerates) the
      // set; the plaintext codes leave in exactly this one response and are
      // never logged or re-displayed. Regenerating invalidates the set that
      // was shown before. redeem: the account is resolved from the verified
      // email hint; a wrong code and an unknown email return the same 401
      // shape, and a successful redeem burns the code, records the method
      // use, and upgrades the caller's session slot. status: authenticated
      // sessions see only the configured/remaining counts, never the codes.
      if (url.pathname === "/api/auth/recovery-codes/generate" && req.method === "POST") {
        checkOrigin(req, true);
        rate(`recovery-codes-generate:${remoteAddress}`, 10);
        const auth = store.authenticateAccountSession(cookie(req, accountCookieName));
        protectWrite(req, auth, false);
        const { codes, count } = store.accountLogins.generateRecoveryCodes(auth.account.id);
        return json(res, 200, { codes, count, generatedAt: new Date(store.now()).toISOString(),
          warning: "Save these now \u2014 they are shown once and each works a single time. Regenerating invalidates the previous set." });
      }
      if (url.pathname === "/api/auth/recovery-codes/status" && req.method === "GET") {
        rate(`recovery-codes-status:${remoteAddress}`, 30);
        const auth = store.authenticateAccountSession(cookie(req, accountCookieName));
        const configured = store.accountLogins.listMethods(auth.account.id)
          .some(method => method.type === "recovery-code-set" && !method.disabled);
        const remaining = configured ? store.accountLogins.recoveryCodesRemaining(auth.account.id) : null;
        return json(res, 200, { configured, remaining });
      }
      if (url.pathname === "/api/auth/recovery-codes/redeem" && req.method === "POST") {
        checkOrigin(req, true);
        rate(`recovery-redeem:${remoteAddress}`, 10);
        const data = await body(req);
        const redeemToken = signInSlotToken(req, data, ["email", "code", "sessionRevision"],
          { code: "invalid_recovery_redeem", message: "An email, recovery code, session token, and current session revision are required", csrf: "always" });
        if (typeof data.email !== "string" || typeof data.code !== "string" || !Number.isSafeInteger(data.sessionRevision)) {
          reject(422, "invalid_recovery_redeem", "An email, recovery code, session token, and current session revision are required");
        }
        const email = normalizeEmail(data.email);
        if (email === null) reject(422, "invalid_email", "A valid email address is required");
        // The slot is verified before any code is burned so a CSRF failure
        // cannot consume a one-time code.
        recoveryRedeemAllowed(email);
        const accountId = store.accountLogins.findAccountByVerifiedEmail(email);
        let redemption;
        try {
          if (accountId === null) reject(401, "invalid_recovery_code", "That recovery code is not valid");
          redemption = store.accountLogins.consumeRecoveryCode(accountId, data.code);
        } catch (error) {
          // No set and a wrong code answer identically: there is no oracle.
          if (error instanceof ServiceError && (error.code === "invalid_recovery_code" || error.code === "login_method_not_found")) {
            reject(401, "invalid_recovery_code", "That recovery code is not valid");
          }
          throw error;
        }
        const method = store.accountLogins.listMethods(accountId)
          .find(candidate => candidate.type === "recovery-code-set" && !candidate.disabled);
        if (method) store.accountLogins.touchMethod(accountId, method.id);
        // QA-Auth 2026-09-19: QAS-702 rotation was missing on the recovery
        // path — mint a fresh slot token so a planted pre-login token can
        // never authenticate after the redeem.
        const { token: freshSlotToken, session: loggedIn } = store.loginAccountSessionWithMethod(redeemToken, accountId, data.sessionRevision, {
          method: { kind: "recovery-code", ref: method ? method.id : "recovery-code-set" },
          rotateSlot: true
        });
        setCookie(res, accountCookieName, freshSlotToken, Math.max(0, Math.floor((loggedIn.expiresAt - store.now()) / 1000)));
        return json(res, 200, { remaining: redemption.remaining, session: sessionAccountView(loggedIn) });
      }
      // ---- Login method settings (slice 7, RC-2026-09-17-016) ----
      // Authenticated management of an account's linked sign-in methods.
      // GET /api/auth/methods lists the safe method descriptors (verifiers
      // are never exposed) plus honest provider/mail configuration status;
      // the disable/enable/remove routes mutate one method at a time and
      // the model refuses to disable or remove the last active method.
      // POST /api/auth/password/set attaches a first password to an
      // account that signed up another way (it 409s when one exists; the
      // slice-2 change route rotates it). GET /api/auth/github/link/start
      // begins the slice-4 GitHub OAuth dance with a link intent so the
      // callback attaches the GitHub subject to the currently authenticated
      // account instead of the sign-in find-or-provision order.
      const requireAccountSession = () => {
        const slotToken = cookie(req, accountCookieName);
        if (!slotToken) reject(401, "account_session_required", "Sign in to manage your account");
        let session;
        try {
          session = store.authenticateAccountSession(slotToken);
        } catch (error) {
          if (error.status !== 401) throw error;
          reject(401, "invalid_session", "That session is no longer valid; sign in again");
        }
        if (!session.account) reject(401, "account_session_required", "Sign in to manage your account");
        return { ...session, slotToken };
      };
      const providerConfigured = probe => {
        try { return probe() !== null; } catch { return false; }
      };
      if (url.pathname === "/api/auth/methods") {
        if (req.method !== "GET") reject(405, "method_not_allowed", "Method not allowed");
        const session = requireAccountSession();
        return json(res, 200, {
          methods: store.accountLogins.listMethods(session.account.id),
          emailVerification: store.accountLogins.emailVerification(session.account.id),
          providers: {
            github: { configured: providerConfigured(() => github()) },
            google: { configured: providerConfigured(() => google()) },
            passkey: { configured: resolvePasskeyParams(expectedOrigin()) !== null },
            mail: { configured: magicMailer.isConfigured() }
          }
        });
      }
      const methodIdFrom = data => {
        if (!exact(data, ["id"]) || typeof data.id !== "string" || data.id.length === 0) {
          reject(422, "invalid_method", "A login method id is required");
        }
        return data.id;
      };
      if (url.pathname === "/api/auth/methods/disable") {
        if (req.method !== "POST") reject(405, "method_not_allowed", "Method not allowed");
        checkOrigin(req, true);
        rate(`auth-methods:${remoteAddress}`, 30);
        const session = requireAccountSession();
        protectWrite(req, session, false);
        const method = store.accountLogins.setMethodDisabled(session.account.id, methodIdFrom(await body(req)), true);
        return json(res, 200, { method });
      }
      if (url.pathname === "/api/auth/methods/enable") {
        if (req.method !== "POST") reject(405, "method_not_allowed", "Method not allowed");
        checkOrigin(req, true);
        rate(`auth-methods:${remoteAddress}`, 30);
        const session = requireAccountSession();
        protectWrite(req, session, false);
        const method = store.accountLogins.setMethodDisabled(session.account.id, methodIdFrom(await body(req)), false);
        return json(res, 200, { method });
      }
      if (url.pathname === "/api/auth/methods/remove") {
        if (req.method !== "POST") reject(405, "method_not_allowed", "Method not allowed");
        checkOrigin(req, true);
        rate(`auth-methods:${remoteAddress}`, 30);
        const session = requireAccountSession();
        protectWrite(req, session, false);
        const removed = store.accountLogins.removeMethod(session.account.id, methodIdFrom(await body(req)));
        return json(res, 200, removed);
      }
      if (url.pathname === "/api/auth/password/set") {
        if (req.method !== "POST") reject(405, "method_not_allowed", "Method not allowed");
        checkOrigin(req, true);
        rate(`password-set:${remoteAddress}`, 20);
        const session = requireAccountSession();
        protectWrite(req, session, false);
        const data = await body(req);
        if (!exact(data, ["password"]) || typeof data.password !== "string") {
          reject(422, "invalid_password_set", "A new password is required");
        }
        const methods = store.accountLogins.listMethods(session.account.id);
        if (methods.some(method => method.type === "password")) {
          reject(409, "password_already_set", "This account already has a password; change it instead");
        }
        const policy = checkPasswordPolicy(data.password);
        if (policy) reject(422, policy.code, policy.message);
        const email = methods.find(method => method.email)?.email ?? null;
        if (!email) reject(422, "no_verified_email", "Link an email-based sign-in method before setting a password");
        const method = store.accountLogins.linkPasswordMethod(session.account.id, { email, verifier: hashPassword(data.password) });
        store.accountLogins.touchMethod(session.account.id, method.id);
        return json(res, 201, { status: "ok", method: { id: method.id, type: "password" } });
      }
      if (url.pathname === "/api/auth/github/link/start") {
        if (req.method !== "GET") reject(405, "method_not_allowed", "Method not allowed");
        // Auth first: anonymous callers get 401 without learning whether
        // GitHub is configured (slice 7 hardening).
        const session = requireAccountSession();
        const oauth = github();
        if (!oauth) return json(res, 503, { status: "unavailable", reason: "github_not_configured",
          error: { code: "github_not_configured", message: "GitHub sign-in is not configured" } });
        rate(`github-link-start:${remoteAddress}`, 10);
        const slotToken = session.slotToken;
        const expectedRevision = store.accountSessionSlot(slotToken).sessionRevision;
        const { state, codeVerifier } = oauth.pending.create({ sessionToken: slotToken, sessionRevision: expectedRevision, link: true });
        const authorizationUrl = buildGitHubAuthUrl({ clientId: oauth.clientId, redirectUri: oauth.redirectUri,
          state, codeChallenge: codeChallengeFor(codeVerifier) });
        res.statusCode = 302;
        res.setHeader("Location", authorizationUrl);
        return res.end();
      }
      if (url.pathname === "/api/auth/google/link/start") {
        if (req.method !== "GET") reject(405, "method_not_allowed", "Method not allowed");
        // Auth first: anonymous callers get 401 without learning whether
        // Google is configured.
        const session = requireAccountSession();
        const signIn = google();
        if (!signIn) return json(res, 503, { status: "unavailable", reason: "google_not_configured" });
        rate(`google-link-start:${remoteAddress}`, 10);
        const slotToken = session.slotToken;
        const expectedRevision = store.accountSessionSlot(slotToken).sessionRevision;
        const started = signIn.begin({ slotToken, expectedRevision, link: true });
        res.statusCode = 302;
        res.setHeader("Location", started.authorizationUrl);
        return res.end();
      }
      // ---- Account management (RC-2026-09-19-078) ----
      // Account-level profile (display name / avatar), first-run onboarding
      // for new accounts, the deletion retention policy, and confirm-then-
      // delete account deletion wired to src/account-deletion.mjs via
      // server/account-deletion.mjs. All of these require the authenticated
      // account session and act only on the caller's own account.
      if (url.pathname === "/api/account/profile") {
        if (req.method === "GET") {
          const session = requireAccountSession();
          return json(res, 200, store.accountProfile(session.account.id));
        }
        if (req.method !== "POST") reject(405, "method_not_allowed", "Method not allowed");
        checkOrigin(req, true);
        rate(`account-profile:${remoteAddress}`, 30);
        const session = requireAccountSession();
        protectWrite(req, session, false);
        return json(res, 200, store.updateAccountProfile(session.account.id, await body(req)));
      }
      if (url.pathname === "/api/account/onboarding") {
        if (req.method !== "GET") reject(405, "method_not_allowed", "Method not allowed");
        const session = requireAccountSession();
        return json(res, 200, store.onboardingState(session.account.id));
      }
      if (url.pathname === "/api/account/onboarding/complete") {
        if (req.method !== "POST") reject(405, "method_not_allowed", "Method not allowed");
        checkOrigin(req, true);
        rate(`account-onboarding:${remoteAddress}`, 30);
        const session = requireAccountSession();
        protectWrite(req, session, false);
        return json(res, 200, store.completeOnboarding(session.account.id));
      }
      if (url.pathname === "/api/account/retention") {
        if (req.method !== "GET") reject(405, "method_not_allowed", "Method not allowed");
        requireAccountSession();
        return json(res, 200, { policy: RETENTION_POLICY });
      }
      if (url.pathname === "/api/account/deletion/plan") {
        if (req.method !== "GET") reject(405, "method_not_allowed", "Method not allowed");
        const session = requireAccountSession();
        rate(`account-deletion-plan:${remoteAddress}`, 10);
        const { plan, summary } = planAccountDeletion(store, session.account.id);
        return json(res, 200, {
          plan,
          summary,
          confirmationToken: issueDeletionToken(accountDeletionSecret, session.account.id, plan),
          retention: RETENTION_POLICY,
        });
      }
      if (url.pathname === "/api/account/delete") {
        if (req.method !== "POST") reject(405, "method_not_allowed", "Method not allowed");
        checkOrigin(req, true);
        rate(`account-delete:${remoteAddress}`, 5);
        const session = requireAccountSession();
        protectWrite(req, session, false);
        const data = await body(req);
        if (!exact(data, ["confirmationToken"]) || typeof data.confirmationToken !== "string" || data.confirmationToken.length === 0) {
          reject(422, "invalid_deletion", "A deletion confirmation token from GET /api/account/deletion/plan is required");
        }
        // Re-plan from the live store and verify the token against the fresh
        // plan: data changed after confirmation 409s as plan_changed.
        const { plan } = planAccountDeletion(store, session.account.id);
        verifyDeletionToken(accountDeletionSecret, session.account.id, plan, data.confirmationToken);
        const receipt = executeAccountDeletion(store, plan);
        setCookie(res, accountCookieName, "", 0);
        return json(res, 200, { deleted: true, accountId: session.account.id, receipt });
      }
      if (url.pathname === "/api/guest-agent-links" && ["GET", "HEAD"].includes(req.method)) {
        return json(res, 200, guestAgentLinkContract(), req.method === "HEAD");
      }
      if (url.pathname === "/api/guest-agent-links" && req.method === "POST") {
        checkOrigin(req, !carriesBearer(req));
        rate(`guest-agent-mint:${remoteAddress}`, 30);
        const selected = roomCredentials(req, url);
        if (!selected.token) reject(401, "unauthenticated", "Ask the owner to mint a guest invite or Add agent.");
        const data = await body(req);
        if (typeof data.roomId !== "string" || !validId(data.roomId)) reject(422, "invalid_link", "Supply the room and guest invite mint fields");
        const fence = selected.mode === "account" ? accountBinding(req) : expectedBinding(req);
        const auth = roomAuth(selected, data.roomId, fence);
        if (selected.bearer && auth.credentialScope !== "room") reject(403, "access_denied", "Bearer account sessions are not accepted");
        if (!selected.bearer && auth.kind !== "session") reject(401, "unauthenticated", "Browser session required");
        protectWrite(req, auth, selected.bearer);
        const result = store.guestAgentLinks.mint(selected.token, data.roomId, data, fence);
        return json(res, result.duplicate ? 200 : 201, result);
      }
      if (url.pathname === "/api/guest-agent-links/preview" && req.method === "POST") {
        checkOrigin(req, true);
        rate(`guest-agent-preview:${remoteAddress}`, 30);
        const data = await body(req);
        if (!exact(data, ["linkToken"])) reject(422, "invalid_link", "Guest-agent link required");
        return json(res, 200, store.guestAgentLinks.preview(data.linkToken));
      }
      if (url.pathname === "/api/guest-agent-links/join" && req.method === "POST") {
        checkOrigin(req, true);
        rate(`guest-agent-join:${remoteAddress}`, 20);
        const data = await body(req);
        if (!exact(data, ["linkToken"])) reject(422, "invalid_link", "Guest-agent link required");
        const joinedLink = store.guestAgentLinks.join(data.linkToken);
        // Jev-harness admission gate, shadow mode (docs/JEV-GATES.md):
        // score the join, journal the would-be decision, admit anyway. This
        // path carries no signed card at join time (the card is checked at
        // link mint), so the card component stays inactive.
        jevShadowAdmission("guest-agent-link:join", { roomId: joinedLink.room?.id, memberId: joinedLink.memberId,
          displayName: "", card: null });
        return json(res, 200, joinedLink);
      }
      if (url.pathname === "/api/guest-agent-links/refresh" && req.method === "POST") {
        // v0 self-service refresh (issue #1563): the holder of an EXPIRED
        // guest-agent credential presents it and gets a fresh one for the
        // same seat, no owner round-trip. Possession of the expired bearer
        // is the proof; revoked, swept, and v1 seats are refused inside
        // GuestAgentLinks#refresh. Rate matches the sibling join route.
        checkOrigin(req, true);
        rate(`guest-agent-refresh:${remoteAddress}`, 20);
        const data = await body(req);
        if (!exact(data, ["linkToken"])) reject(422, "invalid_link", "Guest-agent link required");
        return json(res, 200, store.guestAgentLinks.refresh(data.linkToken));
      }
      // GX-… guest invites (RC-2026-09-23-100): the public-handoff flow.
      // The invite code is public-safe (single-use, hash-stored, grants
      // nothing); the ga1. credential is issued only at redemption, after
      // the guest presents an ai_… identity and a signed agent card.
      if (url.pathname === "/api/guest-invites" && ["GET", "HEAD"].includes(req.method)) {
        return json(res, 200, guestInviteContract(), req.method === "HEAD");
      }
      if (url.pathname === "/api/guest-invites/preview" && req.method === "POST") {
        checkOrigin(req, true);
        rate(`guest-invite-preview:${remoteAddress}`, 30);
        const data = await body(req);
        if (!exact(data, ["inviteCode"]) || typeof data.inviteCode !== "string") reject(422, "invalid_guest_invite", "Guest invite code required");
        return json(res, 200, store.guestInvites.preview(data.inviteCode));
      }
      if (url.pathname === "/api/guest-invites/redeem" && req.method === "POST") {
        checkOrigin(req, !carriesBearer(req));
        rate(`guest-invite-redeem:${remoteAddress}`, 10);
        // The identity secret rides the Authorization header (never the
        // body): the share-links join-agent flow uses the same convention.
        const identitySecret = bearer(req);
        const data = await body(req);
        if (!identitySecret) reject(401, "unauthenticated", "Present your agent identity secret as a Bearer token");
        if (!exact(data, ["inviteCode", "card"]) || typeof data.inviteCode !== "string") reject(422, "invalid_guest_invite", "Supply the invite code and a signed agent card");
        rate(`guest-invite-redeem-code:${rateHash(data.inviteCode)}`, 5);
        const result = store.guestInvites.redeem(data.inviteCode, identitySecret, data.card);
        // Jev-harness admission gate, shadow mode (docs/JEV-GATES.md):
        // score the join, journal the would-be decision, admit anyway. The
        // redeem verifies the signed card signature and rejects invalid
        // cards, so a successful redeem means the card was present+valid.
        jevShadowAdmission("guest-invite:redeem", { roomId: result.room?.id,
          identityId: store.identities.resolveGlobalIdentitySecret(identitySecret)?.identityId ?? null,
          displayName: result.member?.displayName ?? "", card: { present: true, valid: true } });
        return json(res, result.duplicate ? 200 : 201, result);
      }
      if (url.pathname === "/api/guest-invites/request" && req.method === "POST") {
        // Self-serve guest entry (RC-2026-09-25-912): no invite code, no
        // identity secret, no owner in the loop. The signed agent card in
        // the body is the entire credential; its joinRequest binds the
        // room + requestId. Per-minute IP guard here; the hourly/daily
        // gates live in GuestInvites#requestSelfServe.
        checkOrigin(req, true);
        rate(`guest-invite-request:${remoteAddress}`, 10);
        const data = await body(req);
        if (!exact(data, ["card"])) reject(422, "card_invalid", "Supply a signed agent card with a joinRequest");
        const result = store.guestInvites.requestSelfServe(data.card, String(remoteAddress ?? ""));
        jevShadowAdmission("guest-invite:request", { roomId: result.room?.id,
          identityId: null, displayName: result.member?.displayName ?? "", card: { present: true, valid: true } });
        // Identical requestId replays (200) return the originally issued
        // credential; a new requestId renews with rotation (200); first
        // joins mint (201).
        return json(res, result.replayed || result.renewed ? 200 : 201, result);
      }
      if (url.pathname === "/api/guest-invites/rotate" && req.method === "POST") {
        checkOrigin(req, !carriesBearer(req));
        rate(`guest-invite-rotate:${remoteAddress}`, 10);
        const guestToken = bearer(req);
        if (!guestToken) reject(401, "unauthenticated", "Present your guest credential as a Bearer token");
        const data = await body(req);
        if (typeof data.roomId !== "string" || !validId(data.roomId)) reject(422, "invalid_guest_invite", "Supply the room");
        const fence = expectedBinding(req);
        return json(res, 200, store.guestInvites.rotate(guestToken, data.roomId, fence));
      }
      if (url.pathname === "/api/share-links/preview" && req.method === "POST") {
        checkPreviewOrigin(req);
        rate(`link-preview:${remoteAddress}`, 30);
        const data = await body(req);
        if (!exact(data, ["linkToken"])) reject(422, "invalid_link", "Invitation link required");
        return json(res, 200, store.shareLinks.preview(data.linkToken, cookie(req, accountCookieName), expectedBinding(req)));
      }
      if (url.pathname === "/api/share-links/join-agent" && req.method === "POST") {
        checkOrigin(req, !carriesBearer(req));
        rate(`link-agent-join:${remoteAddress}`, 20);
        const identitySecret = bearer(req);
        if (identitySecret?.startsWith(API_KEY_PREFIX)) reject(401, "room_token_not_identity", ROOM_TOKEN_NOT_IDENTITY);
        if (!store.identities.resolveGlobalIdentitySecret(identitySecret)) reject(401, "unauthenticated", "Active agent identity required");
        const data = await body(req);
        if (!exact(data, ["linkToken", "displayName"])) reject(422, "invalid_join", "Invitation link and agent name required");
        const result = store.shareLinks.joinAgent(identitySecret, data.linkToken, data.displayName, { address: String(remoteAddress ?? "") });
        // Jev-harness admission gate, shadow mode (docs/JEV-GATES.md):
        // score the join, journal the would-be decision, admit anyway.
        jevShadowAdmission("share-link:join-agent", { roomId: result.roomId, identityId: result.identityId,
          displayName: data.displayName, card: null });
        // Burs-IA steal A1: a guest join is a cold-start step — the response
        // is self-describing. Guests get read+chat only, so the guidance is
        // orientation + hello, never work claims or admin moves.
        const guestRoom = `/api/rooms/${encodeURIComponent(result.roomId)}`;
        return json(res, result.duplicate ? 200 : 201, {
          ...result,
          next: [
            Object.freeze({ action: "see-who-is-around", method: "GET", path: `${guestRoom}/presence`,
              description: "Orient: list the room's members, who is online, and who is holding which work sessions." }),
            Object.freeze({ action: "say-hello", method: "POST", path: `${guestRoom}/commands`,
              description: "Say hello: { id: <uuid>, type: \"message.posted\", data: { messageId: <uuid>, body } }. Your guest pass grants read+chat; work claims, polls, and admin are out of scope." }),
          ],
          nextActions: nextActionsForInviteRedeem(result.roomId),
        });
      }
      // POST-only route: a wrong method is 405 (Allow: POST), not a 404
      // unknown-route, so a mistaken GET reads as a method error.
      if (url.pathname === "/api/share-links/join-agent" && req.method !== "POST") {
        reject(405, "method_not_allowed", "Method not allowed", { Allow: "POST" });
      }
      if (url.pathname === "/api/share-links/join" && req.method === "POST") {
        checkOrigin(req, true);
        const token = cookie(req, accountCookieName), slot = store.accountSessionSlot(token);
        protectWrite(req, slot, false);
        const binding = accountBinding(req);
        const data = await body(req);
        if (!exact(data, ["linkToken", "displayName", "redemptionId", "expectedSessionRevision"])) reject(422, "invalid_join", "Supply the invitation link and your name");
        rate(`link-join:${remoteAddress}`, 20);
        const oldRoomToken = cookie(req, roomCookieName);
        const result = store.shareLinks.join(token, data.linkToken, { ...data, expectedSessionBinding: binding,
          revokeRoomToken: oldRoomToken && tokenPattern.test(oldRoomToken) ? oldRoomToken : null,
          clientAddress: String(remoteAddress ?? ""), clientSession: token });
        return json(res, result.duplicate ? 200 : 201, result);
      }
      if (url.pathname === "/api/invitations/preview" && req.method === "POST") {
        checkOrigin(req, true);
        rate(`invitation-preview:${remoteAddress}`, 30);
        const data = await body(req);
        if (!exact(data, ["invitationToken"]) || typeof data.invitationToken !== "string") reject(422, "invalid_invitation", "Invitation token required");
        return json(res, 200, store.previewInvitation(data.invitationToken));
      }
      if (url.pathname === "/api/invitations/accept" && req.method === "POST") {
        checkOrigin(req, true);
        const slotToken = cookie(req, accountCookieName);
        const auth = store.authenticateAccountSession(slotToken);
        protectWrite(req, auth, false);
        const data = await body(req);
        if (!exact(data, ["invitationToken", "redemptionId", "expectedRevision"]) || typeof data.invitationToken !== "string" || typeof data.redemptionId !== "string") reject(422, "invalid_invitation_acceptance", "Invitation token, redemption ID, and expected revision required");
        rate(`invitation-accept:${auth.credentialHash}:${rateHash(data.invitationToken)}`, 20);
        const result = store.acceptInvitation(slotToken, data.invitationToken, { redemptionId: data.redemptionId, expectedRevision: data.expectedRevision, expectedSessionBinding: auth.sessionBinding });
        return json(res, result.duplicate ? 200 : 201, result);
      }
      if (url.pathname === "/api/session" && req.method === "POST") {
        checkOrigin(req, true);
        rate(`login:${remoteAddress}`, 10);
        const data = await body(req);
        if (!exact(data, ["accessKey"]) || typeof data.accessKey !== "string") reject(422, "invalid_login", "An access key is required");
        const { token, session } = store.createSession(data.accessKey);
        setCookie(res, roomCookieName, token, Math.max(0, Math.floor((session.expiresAt - store.now()) / 1000)));
        return json(res, 201, sessionView(session));
      }
      // Agent browser sign-in (RC-2026-09-23): agents can sign in on their
      // own account via the browser UI. POST /api/auth/agent/rooms verifies
      // the identity secret and lists linked rooms; POST /api/auth/agent/session
      // creates a room-scoped browser session for the chosen room.
      if (url.pathname === "/api/auth/agent/rooms" && req.method === "POST") {
        checkOrigin(req, true);
        rate(`login:${remoteAddress}`, 10);
        const data = await body(req);
        if (!exact(data, ["identityId"]) || typeof data.identityId !== "string") {
          reject(422, "invalid_login", "An agent identity ID is required");
        }
        const secret = bearer(req);
        if (!secret) reject(401, "unauthenticated", "Agent identity secret required. Agents can self-mint an identity at POST /api/agent-identities.");
        const identity = store.identities.authenticateIdentitySecret(data.identityId, secret);
        const rooms = store.identities.roomsForIdentity(data.identityId);
        return json(res, 200, { identityId: identity.identityId, displayName: identity.displayName, rooms });
      }
      if (url.pathname === "/api/auth/agent/session" && req.method === "POST") {
        checkOrigin(req, true);
        rate(`login:${remoteAddress}`, 10);
        const data = await body(req);
        if (!exact(data, ["identityId", "roomId"]) || typeof data.identityId !== "string" || typeof data.roomId !== "string") {
          reject(422, "invalid_login", "An agent identity ID and room are required");
        }
        const secret = bearer(req);
        if (!secret) reject(401, "unauthenticated", "Agent identity secret required. Agents can self-mint an identity at POST /api/agent-identities.");
        // Verify the secret before creating the session
        store.identities.authenticateIdentitySecret(data.identityId, secret);
        const { token, session } = store.createAgentSession(data.identityId, data.roomId);
        setCookie(res, roomCookieName, token, Math.max(0, Math.floor((session.expiresAt - store.now()) / 1000)));
        return json(res, 201, sessionView(session));
      }
      // Lane D agent plug-in surface (RC-2026-09-18-010): /api/agent-keys,
      // /api/agent-directory, /api/agent-manifest (+ the well-known manifest
      // path), /api/agent-webhooks. Mounted before the /api/ 404 guard so
      // the well-known path (outside /api/) is reachable; the handler
      // returns true when it served the request, false to fall through.
      // One-URL machine door: POST /join (+ /room/join, /api/join).
      // Mounted before the /api/ 404 guard (same as the agent-plugin
      // surface): /join is not under /api/. Unauthenticated and
      // rate-limited, like identity-create. The /api/join alias keeps the
      // door inside the /api/ inventory (openapi security: [], boundary
      // probes, route-docs gate).
      //   { displayName }               -> mint an identity + a personal first room
      //   { displayName, inviteCode }   -> redeem the invite into its room
      // The one-time identity secret is shown once; save it immediately.
      if ((url.pathname === "/join" || url.pathname === "/room/join" || url.pathname === "/api/join") && req.method === "POST") {
        rate(`join:${remoteAddress}`, 20);
        const data = await body(req);
        const hasProof = Boolean(data) && Object.hasOwn(data, "proof");
        const hasInvite = Boolean(data) && Object.hasOwn(data, "inviteCode");
        const hasRecoverable = Boolean(data) && Object.hasOwn(data, "recoverable");
        const joinFields = ["displayName", ...(hasInvite ? ["inviteCode"] : []), ...(hasProof ? ["proof"] : []), ...(hasRecoverable ? ["recoverable"] : [])];
        if (!data || !exact(data, joinFields)) {
          reject(422, "invalid_join", "displayName, an optional inviteCode, an optional proof, and an optional recoverable flag are the accepted fields");
        }
        // Retry-safe first-room join: `recoverable: true` with the caller's own
        // generated pri_ secret as the bearer. The identity id derives from that
        // secret, so a retry after a lost response returns the same identity and
        // the same personal room (duplicate: true) instead of minting a second
        // identity and room. The anonymous (no invite) branch only.
        if (hasRecoverable && (data.recoverable !== true || hasInvite)) {
          reject(422, "invalid_join", "recoverable must be true and applies only to a join without an inviteCode");
        }
        const recoverableSecret = hasRecoverable ? bearer(req) : undefined;
        if (hasRecoverable && !recoverableSecret) reject(401, "unauthenticated", "Saved registration credential required");
        const name = typeof data.displayName === "string" ? data.displayName.trim() : "";
        if (!name || name.length > 80) reject(422, "invalid_join", "displayName must be 1-80 characters");
        if (hasProof && (typeof data.proof !== "string" || !/^[A-Za-z0-9_-]{1,43}$/.test(data.proof))) {
          reject(422, "invalid_join", "proof is invalid");
        }
        if (typeof data.inviteCode === "string" && data.inviteCode.trim()) {
          const redeemed = store.invites.redeem(data.inviteCode, { displayName: name });
          // Jev-harness admission gate, shadow mode (docs/JEV-GATES.md):
          // score the join, journal the would-be decision, admit anyway.
          jevShadowAdmission("join:invite", { roomId: redeemed.roomId, identityId: redeemed.identityId,
            displayName: redeemed.displayName ?? name, card: null });
          // The browser that just joined gets a working session cookie, so the
          // join page lands the recipient inside the room — no CLI, no docs.
          const joined = store.createJoinSession(redeemed.roomId, redeemed.memberId);
          setCookie(res, roomCookieName, joined.token, Math.max(0, Math.floor((joined.expiresAt - store.now()) / 1000)));
          return json(res, 201, {
            identityId: redeemed.identityId,
            // The invite branch never reveals the identity credential (see
            // agent-invites.mjs redeem): what it hands out is the room-scoped
            // rak_ token. roomToken names it honestly; identitySecret stays as a
            // deprecated alias for existing callers. Identity-wide routes
            // (/api/agent-rooms, /api/needs-me) do not accept it.
            roomToken: redeemed.mcpToken.credential,
            credentialKind: "room_token",
            identitySecret: redeemed.mcpToken.credential,
            mcpToken: redeemed.mcpToken,
            roomId: redeemed.roomId,
            memberId: redeemed.memberId,
            displayName: redeemed.displayName,
            via: "invite",
            session: true,
            sessionExpiresAt: joined.expiresAt,
            next: [
              "You are signed in — open the room below",
              "Save the room token — it expires in 30 days and is shown once",
              "Use it as Authorization: Bearer on /mcp for this room",
              "roomToken (also returned as the deprecated alias identitySecret) is room-scoped: identity-wide routes such as /api/agent-rooms and /api/needs-me refuse it; use room_check_access and room_needs_me on /mcp instead",
              `Orient: GET /api/rooms/${redeemed.roomId}/activation-pack`,
              `Read the room: GET /api/rooms/${redeemed.roomId}?view=work`
            ]
          });
        }
        const { identity, room } = store.transaction(() => {
          // Atomic: a failed room creation rolls the identity insert back
          // with it, so no orphan identity can survive a half-done join.
          const createdIdentity = store.identities.create(name, {
            secret: recoverableSecret,
            anonymous: { address: String(remoteAddress ?? ""), proof: data.proof },
          });
          const createdRoom = agentRooms.create(recoverableSecret ?? createdIdentity.secret, {
            roomId: `personal-${createdIdentity.identityId}`,
            title: `${name}'s room`,
            purpose: "A personal room for getting oriented and starting work.",
            kind: "personal",
            displayName: name
          });
          return { identity: createdIdentity, room: createdRoom };
        });
        // Same working session as the invite branch: the browser that just
        // created this room lands inside it.
        const firstJoined = store.createJoinSession(room.roomId, room.ownerMemberId);
        // Jev-harness admission gate, shadow mode (docs/JEV-GATES.md):
        // score the join, journal the would-be decision, admit anyway.
        jevShadowAdmission("join:first-room", { roomId: room.roomId, identityId: identity.identityId,
          displayName: name, card: null });
        setCookie(res, roomCookieName, firstJoined.token, Math.max(0, Math.floor((firstJoined.expiresAt - store.now()) / 1000)));
        return json(res, 201, {
          identityId: identity.identityId,
          identitySecret: identity.secret,
          roomId: room.roomId,
          memberId: room.ownerMemberId,
          displayName: name,
          via: "first-room",
          duplicate: room.duplicate,
          session: true,
          sessionExpiresAt: firstJoined.expiresAt,
          next: [
            "You are signed in — open the room below",
            recoverableSecret
              ? "Your own pri_ secret is your credential; retry this call with the same secret and you get this identity and room back"
              : "Save identitySecret too — it is shown once and never again, for agent tooling",
            `Authenticate: Authorization: Bearer <${recoverableSecret ? "your pri_ secret" : "identitySecret"}> on /api/rooms/${room.roomId}/…`,
            `Orient: GET /api/rooms/${room.roomId}/activation-pack`,
            `Read the room: GET /api/rooms/${room.roomId}?view=work`
          ]
        });
      }
      // CP-ADMIN-0: operator surface. Returns false when the secret is unset, so
      // the request falls through to the same not_found as an unknown path.
      if (await operatorRoutes(req, res, { url, remoteAddress, requestId: operationId })) return;
      if (await agentPlugin(req, res, { url, remoteAddress })) return;
      if (await nextActionsRoutes(req, res, { url, remoteAddress })) return;
      // Public agent-invite join page: GET /join and GET /join/:code
      // (plus the /room/join twins on the www door). Unauthenticated and
      // stateless by design, like POST /join: the page previews the invite
      // and joins through the existing rate-limited API routes. Outside the
      // /api/ inventory by design, like the discovery packets.
      // D-c: the code segment is deliberately permissive (any single path
      // segment, up to 128 chars). Malformed codes must render this page so
      // the client-side boot() shows the error screen with the "Back to
      // sign-in" fallback; narrowing it here strands the user on the generic
      // 404 page. The client still validates the code shape before calling
      // the preview API.
      const joinPageMatch = /^\/(?:room\/)?join(?:\/([^/]{1,128}))?\/?$/.exec(url.pathname);
      if (joinPageMatch) {
        if (req.method !== "GET") reject(405, "method_not_allowed", "Method not allowed");
        const assetBase = url.pathname.startsWith("/room/") ? "/room" : "";
        const page = (await loadAsset("join.html")).toString("utf8").replaceAll("{{ASSET_BASE}}", assetBase);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(page), "Cache-Control": "no-store" });
        return res.end(page);
      }
      // Q3-E HTML 404. A browser Accept that prefers text/html gets 404.html
      // (lang, title, h1, links home / about / receipts, X-Robots-Tag: noindex).
      // /api/, /mcp and /.well-known/ keep the JSON body, as does any client
      // whose Accept does not prefer text/html.
      if (publicHtmlNotFoundPath(url.pathname) && acceptPrefersHtml(req.headers.accept)) {
        const body = Buffer.from(PUBLIC_NOT_FOUND_HTML);
        res.setHeader("X-Robots-Tag", "noindex");
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8", "Content-Length": body.length });
        return res.end(req.method === "HEAD" ? undefined : body);
      }
      if (!url.pathname.startsWith("/api/")) reject(404, "not_found", "Not found");
      if (url.pathname === "/api/session") {
        const selectedRoom = url.searchParams.get("room");
        const authMode = selectedRoom !== null || req.headers["x-project-room-auth"] === "account" ? "account" : "room";
        if (authMode === "account" && req.headers.authorization) reject(403, "access_denied", "Account browser sessions do not use bearer authorization");
        const token = authMode === "account" ? cookie(req, accountCookieName) : (bearer(req) ?? cookie(req, roomCookieName));
        const auth = authMode === "account" ? store.authenticateAccountSession(token, selectedRoom, accountBinding(req))
          : store.authenticate(token, undefined, expectedBinding(req), { allowAccountSession: false });
        const isBearer = Boolean(req.headers.authorization);
        if (!isBearer && auth.kind !== "session") reject(401, "unauthenticated", "Browser session required");
        if (req.method === "GET") return json(res, 200, sessionView(auth));
        if (req.method === "DELETE") {
          protectWrite(req, auth, isBearer);
          if (authMode === "account") store.logoutAccountSession(token, auth.sessionRevision);
          else store.revoke(token);
          return json(res, 200, { signedOut: true });
        }
        reject(405, "method_not_allowed", "Method not allowed");
      }
      // Room-side web fetch (RC-2026-09-23-102): POST /api/web/fetch. The room
      // comes from the credential itself — room bearer credentials (access
      // keys and room sessions) carry their room_id, so no roomId appears in
      // the path. Identity secrets and API keys cannot resolve a room without
      // one and answer 401 here; use a room bearer credential instead.
      // Documented in docs/openapi.yaml like every other route literal here.
      if (url.pathname === "/api/web/fetch") {
        if (req.method !== "POST") reject(405, "method_not_allowed", "Method not allowed");
        const isBearer = Boolean(req.headers.authorization);
        const token = bearer(req) ?? cookie(req, roomCookieName);
        const webAuth = store.authenticate(token, undefined, expectedBinding(req), { allowAccountSession: false });
        // Owner + full members only. The guest gate uses the #798 code and
        // copy (isWebFetchGuest covers ga1. guest-agents and human
        // share-link guests with role === "guest"). There is no drafts-only
        // member tier in the room data model, so every other active member
        // qualifies; the choice is documented in the PR.
        if (!webAuth.member?.id) reject(401, "unauthenticated", "Member credential required");
        if (isWebFetchGuest(webAuth.member)) reject(403, "guest_scope_denied", "Guest members cannot perform this action");
        protectWrite(req, webAuth, isBearer);
        rate(`write:${webAuth.credentialHash}`, 60);
        const data = await body(req);
        try {
          return json(res, 200, await store.webFetch.fetch(webAuth.roomId, webAuth.member.id, data, { credentialHash: webAuth.credentialHash }));
        } catch (error) {
          // Quota-exceeded is a typed 429 with retry info, never a 500.
          // Every typed failure carries its request_id for journal correlation.
          if (error instanceof WebFetchError) {
            const payload = { error: { code: error.code, message: error.message }, request_id: error.requestId ?? null };
            if (error.code === "rate_limited") {
              res.setHeader("Retry-After", String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))));
              return json(res, 429, { ...payload, retryAfterMs: error.retryAfterMs, resetAt: error.resetAt });
            }
            return json(res, error.status, payload);
          }
          throw error;
        }
      }
      // Room-side knowledge router (RC-2026-09-24-310): POST /api/web/research.
      // An agent asks a question; the room plans which sources to consult (its own
      // fetch memory, local docs corpus, explicit URLs, env-configured provider)
      // and returns evidence with provenance receipts. Same auth posture as
      // /api/web/fetch: owner + full members, #798 guest gate. Planning
      // (planOnly) is free; execution bills research quota, and fetch-leg URLs
      // additionally bill web-fetch quota (credit semantics, Alexandria-style).
      if (url.pathname === "/api/web/research") {
        if (req.method !== "POST") reject(405, "method_not_allowed", "Method not allowed");
        const researchIsBearer = Boolean(req.headers.authorization);
        const researchToken = bearer(req) ?? cookie(req, roomCookieName);
        const researchAuth = store.authenticate(researchToken, undefined, expectedBinding(req), { allowAccountSession: false });
        if (!researchAuth.member?.id) reject(401, "unauthenticated", "Member credential required");
        if (isWebFetchGuest(researchAuth.member)) reject(403, "guest_scope_denied", "Guest members cannot perform this action");
        protectWrite(req, researchAuth, researchIsBearer);
        rate(`write:${researchAuth.credentialHash}`, 60);
        const researchData = await body(req);
        try {
          return json(res, 200, await store.webResearch.research(researchAuth.roomId, researchAuth.member.id, researchData, { credentialHash: researchAuth.credentialHash }));
        } catch (error) {
          if (error instanceof WebFetchError) {
            const payload = { error: { code: error.code, message: error.message }, request_id: error.requestId ?? null };
            if (error.code === "rate_limited") {
              res.setHeader("Retry-After", String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))));
              return json(res, 429, { ...payload, retryAfterMs: error.retryAfterMs, resetAt: error.resetAt });
            }
            return json(res, error.status, payload);
          }
          throw error;
        }
      }
      // Synchronous claim-block validation (RC-2026-09-24-204):
      // POST /api/claims/validate. Agents validate the ```room-claim block
      // they intend to post on the #266 coordination board BEFORE posting —
      // the async rebuild is the only validator otherwise, and it rejects
      // malformed blocks silently into its log. Unauthenticated by design
      // (any agent can pre-validate; 30/address/min); a pure function of
      // the request body — no room state read or written, no credential
      // required, no checkOrigin (agent script clients send no Origin; the
      // route has no ambient-auth side effect to CSRF-protect).
      // Documented in docs/openapi.yaml like every other route literal here.
      if (url.pathname === "/api/claims/validate") {
        if (req.method !== "POST") reject(405, "method_not_allowed", "Method not allowed", { Allow: "POST" });
        rate(`claim-validate:${remoteAddress}`, 30);
        const data = await body(req, { limit: CLAIM_TEXT_MAX_LENGTH + 8192 });
        if (!exact(data, ["text"]) || typeof data.text !== "string") {
          reject(422, "invalid_claim_text", "A claim text string is required");
        }
        if (data.text.length > CLAIM_TEXT_MAX_LENGTH) {
          reject(422, "text_too_long", `Claim text must be at most ${CLAIM_TEXT_MAX_LENGTH} characters`);
        }
        return json(res, 200, validateClaimText(data.text));
      }
      const revokeMatch = /^\/api\/rooms\/([^/]{1,384})\/invitations\/([^/]{1,384})\/revoke$/.exec(url.pathname);
      // Round-2 #101: creating an agent identity is open (an identity alone
      // grants nothing); linking it into a room is owner-only per room.
      // Unauthenticated mints are bounded by the per-address limiter here,
      // plus the address, network, and daily budgets inside create
      // (429 rate_limited / 428 proof_required) and the IDENTITY_LIMIT cap
      // (409 pilot_limit, no row written).
      if ((url.pathname === "/api/agent-identities" || url.pathname === "/api/identity-create") && req.method === "POST") {
        rate(`identity-create:${remoteAddress}`, 30);
        const data = await body(req);
        const hasProof = Boolean(data) && Object.hasOwn(data, "proof");
        const recoverable = data?.recoverable === true;
        const fields = ["displayName", ...(recoverable ? ["recoverable"] : []), ...(hasProof ? ["proof"] : [])];
        if (!data || !exact(data, fields) || typeof data.displayName !== "string"
          || (Object.hasOwn(data, "recoverable") && data.recoverable !== true)) reject(422, "invalid_identity", "displayName is required");
        if (hasProof && (typeof data.proof !== "string" || !/^[A-Za-z0-9_-]{1,43}$/.test(data.proof))) {
          reject(422, "invalid_identity", "proof is invalid");
        }
        const registrationCredential = data.recoverable ? bearer(req) : undefined;
        if (data.recoverable && !registrationCredential) reject(401, "unauthenticated", "Saved registration credential required");
        const slotToken = cookie(req, accountCookieName);
        if (slotToken) {
          try {
            const mintSession = store.authenticateAccountSession(slotToken);
            if (mintSession.account) store.accountLogins.assertEmailVerified(mintSession.account.id);
          } catch (error) {
            if (!(error instanceof ServiceError) || error.status !== 401) throw error;
          }
        }
        const created = store.identities.create(data.displayName, {
          secret: registrationCredential,
          anonymous: { address: String(remoteAddress ?? ""), proof: data.proof },
        });
        let mintAccountId = null;
        if (slotToken) {
          try { mintAccountId = store.authenticateAccountSession(slotToken).account?.id ?? null; }
          catch { /* an anonymous mint still records the address and browser session */ }
        }
        noteIdentityMint(store, created.identityId, { address: String(remoteAddress ?? ""), session: slotToken || null, accountId: mintAccountId });
        return json(res, 201, created);
      }
      // POST-only mint. GET must not look like a missing route (404) or an
      // auth challenge (401): there is nothing to authenticate.
      if ((url.pathname === "/api/agent-identities" || url.pathname === "/api/identity-create") && req.method !== "POST") {
        reject(405, "method_not_allowed", "Method not allowed", { Allow: "POST" });
      }
      // Agent invite codes: redemption is unauthenticated (the code is the
      // bearer credential); issuance is owner-only per room.
      if (url.pathname === "/api/agent-invites/redeem" && req.method === "POST") {
        rate(`invite-redeem:${remoteAddress}`, 20);
        const data = await body(req);
        // Colony round-2 (musespark-explorer, 2026-10-06): the static 422 here
        // blamed the caller for sending *less* when the body carried an *extra*
        // field — a recovery trap for a cold client. Port the access-request
        // diagnoseArguments pattern so the 422 names the offending field.
        const diagnosis = diagnoseArguments({
          required: ["code", "displayName"],
          properties: { code: { type: "string" }, displayName: { type: "string" }, requestId: { type: "string" } },
          additionalProperties: false,
        }, data);
        if (diagnosis) {
          const parts = [];
          if (diagnosis.missing.length) parts.push(`missing required field${diagnosis.missing.length > 1 ? "s" : ""}: ${diagnosis.missing.join(", ")}`);
          if (diagnosis.unexpected.length) parts.push(`unexpected field${diagnosis.unexpected.length > 1 ? "s" : ""}: ${diagnosis.unexpected.join(", ")}`);
          for (const [field, reason] of Object.entries(diagnosis.invalid)) parts.push(`${field}: ${reason}`);
          reject(422, "invalid_invite", `Invalid invite redeem (${parts.join("; ")}). Send exactly {code, displayName} with an optional requestId.`);
        }
        // G1 idempotent redeem (PRODUCT-200 D7): an opt-in client-kept
        // requestId makes an uncertain retry safe — the retry replays the
        // journaled redemption instead of 409ing on the burned code.
        let requestId = null;
        if (data.requestId !== undefined) {
          if (!validId(data.requestId)) reject(422, "invalid_invite", "Send a valid request id for retry-safe redemption.");
          requestId = data.requestId;
        }
        const redeemedInvite = store.invites.redeem(data.code, { displayName: data.displayName, identitySecret: bearer(req), requestId });
        // Jev-harness admission gate, shadow mode (docs/JEV-GATES.md):
        // score the join, journal the would-be decision, admit anyway.
        jevShadowAdmission("agent-invite:redeem", { roomId: redeemedInvite.roomId, identityId: redeemedInvite.identityId,
          displayName: redeemedInvite.displayName ?? data.displayName, card: null });
        return json(res, 201, redeemedInvite);
      }
      if (url.pathname === "/api/agent-invites/redeem" && req.method !== "POST") {
        reject(405, "method_not_allowed", "Method not allowed", { Allow: "POST" });
      }
      // Signed referral invites: the owner, or a member who can invite, mints
      // a bearer token and carries it out-of-band — the server never sends it.
      // Redemption is unauthenticated (the token is the credential) and
      // lands the stranger at the fixed read+chat tier.
      if (url.pathname === "/api/referral-invites/mint" && req.method === "POST") {
        rate(`referral-invite-mint:${remoteAddress}`, 20);
        const secret = bearer(req);
        if (!secret) reject(401, "unauthenticated", "Sign in with an active room key or agent identity secret");
        const data = await body(req);
        const withCap = Object.hasOwn(data, "maxDepth");
        const withKey = Object.hasOwn(data, "requestId");
        if (!(exact(data, ["roomId", ...(withCap ? ["maxDepth"] : []), ...(withKey ? ["requestId"] : [])]))
            || typeof data.roomId !== "string"
            || (withCap && typeof data.maxDepth !== "number")) {
          reject(422, "invalid_invite", "roomId, optional numeric maxDepth and optional requestId are the accepted fields");
        }
        return json(res, 201, store.referralInvites.mint(secret, data.roomId,
          { ...(withCap ? { maxDepth: data.maxDepth } : {}), ...(withKey ? { requestId: data.requestId } : {}) }));
      }
      if (url.pathname === "/api/referral-invites/mint" && req.method !== "POST") {
        reject(405, "method_not_allowed", "Method not allowed", { Allow: "POST" });
      }
      if (url.pathname === "/api/referral-invites/redeem" && req.method === "POST") {
        rate(`referral-invite-redeem:${remoteAddress}`, 20);
        const data = await body(req);
        // SEC-1: a bearer attaches an existing identity. A new join shares
        // the anonymous mint limiter, so proof is accepted on this body.
        const fields = ["token"];
        if (Object.hasOwn(data, "displayName")) fields.push("displayName");
        if (Object.hasOwn(data, "proof")) fields.push("proof");
        const proofOk = !Object.hasOwn(data, "proof") || (typeof data.proof === "string" && /^[A-Za-z0-9_-]{1,43}$/.test(data.proof));
        if (!exact(data, fields)
            || typeof data.token !== "string"
            || (Object.hasOwn(data, "displayName") && typeof data.displayName !== "string")
            || !proofOk) {
          reject(422, "invalid_invite", "token, optional displayName, and optional proof are the accepted fields");
        }
        const redeemedReferral = store.referralInvites.redeem({
          token: data.token,
          displayName: data.displayName,
          identitySecret: bearer(req) || null,
          address: String(remoteAddress ?? ""),
          proof: data.proof,
        });
        // Jev-harness admission gate, shadow mode (docs/JEV-GATES.md):
        // score the join, journal the would-be decision, admit anyway.
        jevShadowAdmission("referral-invite:redeem", { roomId: redeemedReferral.roomId, identityId: redeemedReferral.identityId,
          displayName: redeemedReferral.displayName ?? data.displayName, card: null });
        return json(res, 201, redeemedReferral);
      }
      if (url.pathname === "/api/referral-invites/redeem" && req.method !== "POST") {
        reject(405, "method_not_allowed", "Method not allowed", { Allow: "POST" });
      }
      // Referral invite preview: read-only consent data for the
      // pre-redemption review screen. POST (not GET) so the bearer token
      // never lands in a query string or access log. Unauthenticated;
      // consumes nothing, reveals no inviter or identity data.
      if (url.pathname === "/api/referral-invites/preview" && req.method === "POST") {
        rate(`referral-invite-preview:${remoteAddress}`, 20);
        const data = await body(req);
        if (!exact(data, ["token"]) || typeof data.token !== "string") reject(422, "invalid_invite", "token is required");
        return json(res, 200, store.referralInvites.preview(data.token));
      }
      if (url.pathname === "/api/referral-invites/preview" && req.method !== "POST") {
        reject(405, "method_not_allowed", "Method not allowed", { Allow: "POST" });
      }
      // Agent invite preview: read-only consent data for the pre-redemption
      // review screen. Unauthenticated (the code is the bearer credential);
      // consumes nothing, reveals no member or identity data.
      if (url.pathname === "/api/agent-invites/preview" && req.method === "GET") {
        rate(`invite-preview:${remoteAddress}`, 20);
        const code = url.searchParams.get("code");
        if (typeof code !== "string" || !code) reject(422, "invalid_invite", "Invite code is required");
        return json(res, 200, store.invites.preview(code));
      }
      // Self-serve access requests: an identity without membership asks to
      // join. Unauthenticated (the identity is not a member yet); the
      // module rate-limits per identity and never reveals more than 404.
      if (url.pathname === "/api/access-requests" && req.method === "POST") {
        // The other three open POST routes all bound themselves per address
        // before reading a body; this one did not, so the only limit it had was
        // keyed on a field the caller chooses.
        rate(`access-request:${remoteAddress}`, 20);
        const data = await body(req);
        // RC-2026-09-28-3410: the old exact() gate demanded all six keys and
        // answered every violation with one static "accepted fields" list, so
        // a fresh agent could not self-diagnose (this burned a real newcomer).
        // The gate now ports the MCP structured-argument shape
        // ({missing, unexpected, invalid}) down to HTTP, and its
        // required/optional set aligns with the service
        // (server/access-requests.mjs): note and referredBy may be omitted or null
        // (RC-2026-09-18-025); requestId omitted is minted by the service —
        // send one when retrying so the retry is idempotent.
        const diagnosis = diagnoseArguments({
          required: ["roomId", "identityId", "displayName", "requestedPermissions"],
          properties: {
            roomId: { type: "string" },
            identityId: { type: "string" },
            displayName: { type: "string" },
            requestedPermissions: { type: "array" },
            note: { type: ["string", "null"] },
            referredBy: { type: ["string", "null"] },
            requestId: { type: "string" },
          },
          additionalProperties: false,
        }, data);
        if (diagnosis) {
          const parts = [];
          if (diagnosis.missing.length) parts.push(`missing required field${diagnosis.missing.length > 1 ? "s" : ""}: ${diagnosis.missing.join(", ")}`);
          if (diagnosis.unexpected.length) parts.push(`unexpected field${diagnosis.unexpected.length > 1 ? "s" : ""}: ${diagnosis.unexpected.join(", ")}`);
          for (const [field, reason] of Object.entries(diagnosis.invalid)) parts.push(`${field}: ${reason}`);
          reject(422, "invalid_request",
            `Invalid access request (${parts.join("; ")}). Send {roomId, identityId, displayName, requestedPermissions} with optional {note, referredBy, requestId}; requestId is your idempotency key — reuse it when retrying.`);
        }
        // Burs-IA steal A1: filing an access request is a cold-start step — the
        // response teaches the status-poll path and the expected decision
        // window (requests expire undecided after REQUEST_TTL_MS). The
        // guidance lives at the service level (pendingNext / autoApproveResponse
        // in server/access-requests.mjs) and is reused here, not rebuilt:
        // pending responses carry poll-status + cancel guidance, approved
        // ones carry the new member's first moves. Never overwrite an
        // approval's next[] with poll/cancel.
        // JDOT-ACCESS-UPGRADE-HTTP begin: upgrades require identity-holder proof.
        const filed = accessRequests.request(data.roomId, data, bearer(req));
        // JDOT-ACCESS-UPGRADE-HTTP end
        return json(res, 201, {
          ...filed,
          next: filed.next ?? [],
          nextActions: nextActionsForAccessRequest({
            requestId: filed.requestId, identityId: data.identityId,
            decisionWindowDays: REQUEST_TTL_MS / 86400000,
          }),
        });
      }
      // POST-only route: a wrong method is 405 (Allow: POST), not a 404
      // unknown-route, so a mistaken GET reads as a method error.
      if (url.pathname === "/api/access-requests" && req.method !== "POST") {
        reject(405, "method_not_allowed", "Method not allowed", { Allow: "POST" });
      }
      // Agent room ownership, self-serve path: a self-minted identity
      // creates a room and becomes its owner. The pri_ secret travels in
      // the bearer header (never a JSON body); per-address rate limit
      // before the body is read, per-identity budget inside the module.
      if (url.pathname === "/api/agent-rooms" && req.method === "GET") {
        rate(`agent-room-list:${remoteAddress}`, 60);
        return json(res, 200, agentRooms.list(bearer(req), url.searchParams.get("after") ?? ""));
      }
      if (url.pathname === "/api/agent-rooms" && req.method === "POST") {
        rate(`agent-room-create:${remoteAddress}`, 20);
        const secret = bearer(req);
        if (!secret) reject(401, "unauthenticated", "Identity secret required. Agents can self-mint an identity at POST /api/agent-identities.");
        const data = await body(req);
        const created = agentRooms.create(secret, data);
        return json(res, created.duplicate ? 200 : 201, created);
      }
      // GET is a documented identity-secret list (401 without a pri_), not a
      // POST-only route. Other methods are not part of that contract.
      if (url.pathname === "/api/agent-rooms") {
        reject(405, "method_not_allowed", "Method not allowed", { Allow: "GET, POST" });
      }
      // Cross-room attention for one identity. Same read as MCP room_needs_me.
      if (url.pathname === "/api/needs-me" && (req.method === "GET" || req.method === "HEAD")) {
        rate(`needs-me:${remoteAddress}`, 60);
        const secret = bearer(req);
        if (secret && secret.startsWith(API_KEY_PREFIX)) reject(401, "room_token_not_identity", ROOM_TOKEN_NOT_IDENTITY);
        if (!secret || !isIdentitySecret(secret)) reject(401, "unauthenticated", "Identity secret required. Agents can self-mint an identity at POST /api/agent-identities.");
        const sinceParam = url.searchParams.get("since");
        let since;
        if (sinceParam == null || sinceParam === "") since = undefined;
        else if (/^\d+$/.test(sinceParam)) since = Number(sinceParam);
        else {
          try { since = JSON.parse(sinceParam); }
          catch { reject(422, "invalid_cursor", "since must be a sequence number or a cursor object"); }
        }
        return json(res, 200, collectNeedsMe(store, secret, { since }), req.method === "HEAD");
      }
      if (url.pathname === "/api/needs-me") {
        reject(405, "method_not_allowed", "Method not allowed", { Allow: "GET" });
      }
      // UPDATES — one projection of what needs the caller now. Room lists and
      // marks ride the same credential funnel as other room routes. Cross-room
      // reads accept an identity secret or an account session. needs-me stays
      // as a compatibility view and retires handled items.
      const updatesListMatch = /^\/api\/rooms\/([^/]{1,384})\/updates$/.exec(url.pathname);
      const updatesReadMatch = /^\/api\/rooms\/([^/]{1,384})\/updates\/([^/]{1,128})\/read$/.exec(url.pathname);
      const updatesDoneMatch = /^\/api\/rooms\/([^/]{1,384})\/updates\/([^/]{1,128})\/done$/.exec(url.pathname);
      const updatesClearMatch = /^\/api\/rooms\/([^/]{1,384})\/updates\/([^/]{1,128})\/clear$/.exec(url.pathname);
      const updatesMarkMatch = updatesReadMatch ?? updatesDoneMatch ?? updatesClearMatch;
      const updatesQuery = () => {
        const params = url.searchParams;
        const allowed = new Set(["state", "kinds", "cursor", "limit", "auth", "binding"]);
        if ([...params.keys()].some(key => !allowed.has(key) || params.getAll(key).length !== 1)) {
          reject(422, "invalid_updates_query", "state, kinds, cursor, and limit are the updates query parameters");
        }
        const query = {};
        if (params.has("state")) query.state = params.get("state");
        if (params.has("kinds")) query.kinds = params.get("kinds");
        if (params.has("cursor")) query.cursor = params.get("cursor");
        if (params.has("limit")) query.limit = Number(params.get("limit"));
        return query;
      };
      if (url.pathname === "/api/updates" && (req.method === "GET" || req.method === "HEAD")) {
        rate(`updates:${remoteAddress}`, 60);
        const secret = bearer(req);
        if (secret) {
          if (!isIdentitySecret(secret)) reject(401, "unauthenticated", "Cross-room updates need an identity secret or an account session");
          return json(res, 200, listIdentityUpdates(store, secret, updatesQuery()), req.method === "HEAD");
        }
        const token = cookie(req, accountCookieName);
        if (!token) reject(401, "unauthenticated", "Identity secret or account session required");
        return json(res, 200, listAccountUpdates(store, token, accountBinding(req, url), updatesQuery()), req.method === "HEAD");
      }
      if (url.pathname === "/api/updates") reject(405, "method_not_allowed", "Method not allowed", { Allow: "GET" });
      if (updatesListMatch || updatesMarkMatch) {
        const roomId = pathId((updatesListMatch ?? updatesMarkMatch)[1]);
        const selected = roomCredentials(req, url);
        const fence = selected.mode === "account" ? accountBinding(req, null) : expectedBinding(req);
        const auth = roomAuth(selected, roomId, fence);
        if (selected.bearer && auth.credentialScope !== "room") reject(403, "access_denied", "Bearer account sessions are not accepted");
        if (!selected.bearer && auth.kind !== "session") reject(401, "unauthenticated", "Browser session required");
        if (auth.kind === "api-key") {
          const requiredScope = updatesListMatch ? "rooms:read" : "rooms:write";
          const granted = (auth.apiKeyScopes ?? []).some(scope => scope === requiredScope || (scope.endsWith(":*") && requiredScope.startsWith(scope.slice(0, -1))));
          if (!granted) reject(403, "insufficient_scope", `API key lacks the ${requiredScope} scope`);
        }
        rate(`read:${auth.credentialHash}`, 600);
        if (updatesListMatch) {
          if (!["GET", "HEAD"].includes(req.method)) reject(405, "method_not_allowed", "Method not allowed", { Allow: "GET, HEAD" });
          return json(res, 200, listRoomUpdates(store, selected.token, roomId, updatesQuery(), fence), req.method === "HEAD");
        }
        if (req.method !== "POST") reject(405, "method_not_allowed", "Method not allowed", { Allow: "POST" });
        protectWrite(req, auth, selected.bearer);
        rate(`write:${auth.credentialHash}`, 60);
        const data = await body(req);
        // JDOT-COH-UPDATES-BASIS begin
        // Missing expectedBasis can reach only an authenticated legacy receipt;
        // the service refuses every new unbound operation.
        if ((!exact(data, ["requestId"]) && !exact(data, ["requestId", "expectedBasis"])) || typeof data.requestId !== "string") reject(422, "invalid_update", "Supply requestId and the observed expectedBasis");
        const action = updatesReadMatch ? "read" : updatesDoneMatch ? "done" : "clear";
        return json(res, 200, markUpdate(store, selected.token, roomId, pathId(updatesMarkMatch[2]), action, data.requestId, fence, data.expectedBasis));
        // JDOT-COH-UPDATES-BASIS end
      }
      const accessStatusMatch = /^\/api\/access-requests\/([^/]{1,64})$/.exec(url.pathname);
      if (accessStatusMatch && req.method === "GET") {
        // The only open route with no per-address bound. It is not an
        // enumeration vector (a wrong identity and a missing request answer
        // the same 404, and identity ids are 96 random bits), but an open read
        // with no limit at all is still unbounded work for anyone who asks.
        rate(`access-request-status:${remoteAddress}`, 60);
        const identityId = url.searchParams.get("identityId");
        if (!identityId) reject(422, "invalid_request", "identityId query param is required");
        // JDOT-ACCESS-UPGRADE-HTTP begin: upgrade status has the same identity boundary.
        const record = accessRequests.status(pathId(accessStatusMatch[1]), identityId, bearer(req));
        // JDOT-ACCESS-UPGRADE-HTTP end
        // The poll read is the requester's only window on the decision. Return
        // the status with the continuation for that status, so an approved
        // requester learns where the room read lives (mirrors the filing
        // response teaching the poll path).
        return json(res, 200, {
          ...record,
          next: nextActionsForAccessRequestStatus({
            requestId: record.requestId, identityId, roomId: record.roomId,
            status: record.status, decisionWindowDays: REQUEST_TTL_MS / 86400000
          })
        });
      }
      if (accessStatusMatch && req.method === "POST") {
        rate(`access-request-cancel:${remoteAddress}`, 20);
        const secret = bearer(req);
        if (!secret) reject(401, "unauthenticated", "The requesting identity's current bearer secret is required");
        const data = await body(req);
        if (!exact(data, ["identityId"])) reject(422, "invalid_request", "identityId is required");
        return json(res, 200, accessRequests.cancel(pathId(accessStatusMatch[1]), data.identityId, secret));
      }
      // Land queue. Any member can add, list, or remove a pull request, and
      // report the tip they are landing. Names match the hosted MCP tools.
      // A missing GitHub token that the read requires is 503 github_unconfigured.
      const landAdd = /^\/api\/rooms\/([^/]{1,384})\/add_land_item$/.exec(url.pathname);
      const landList = /^\/api\/rooms\/([^/]{1,384})\/list_land_queue$/.exec(url.pathname);
      const landRemove = /^\/api\/rooms\/([^/]{1,384})\/remove_land_item$/.exec(url.pathname);
      const landTip = /^\/api\/rooms\/([^/]{1,384})\/report_tip$/.exec(url.pathname);
      const landMatch = landAdd || landList || landRemove || landTip;
      if (landMatch) {
        const roomId = pathId(landMatch[1]);
        const action = landAdd ? "add_land_item" : landList ? "list_land_queue" : landRemove ? "remove_land_item" : "report_tip";
        const selected = roomCredentials(req, url);
        const fence = selected.mode === "account" ? accountBinding(req, null) : expectedBinding(req);
        const auth = roomAuth(selected, roomId, fence);
        if (selected.bearer && auth.credentialScope !== "room") reject(403, "access_denied", "Bearer account sessions are not accepted");
        if (!selected.bearer && auth.kind !== "session") reject(401, "unauthenticated", "Browser session required");
        if (auth.kind === "api-key") {
          const requiredScope = action === "list_land_queue" ? "rooms:read" : "rooms:write";
          const granted = (auth.apiKeyScopes ?? []).some(scope =>
            scope === requiredScope || (scope.endsWith(":*") && requiredScope.startsWith(scope.slice(0, -1))));
          if (!granted) reject(403, "insufficient_scope", `API key lacks the ${requiredScope} scope`);
        }
        rate(`read:${auth.credentialHash}`, 600);
        if (action === "list_land_queue") {
          if (!["GET", "HEAD"].includes(req.method)) reject(405, "method_not_allowed", "Method not allowed", { Allow: "GET" });
          return json(res, 200, store.landQueue.list(roomId, auth.member.id), req.method === "HEAD");
        }
        if (req.method !== "POST") reject(405, "method_not_allowed", "Method not allowed", { Allow: "POST" });
        protectWrite(req, auth, selected.bearer);
        rate(`write:${auth.credentialHash}`, 60);
        const data = await body(req);
        try {
          if (action === "add_land_item") {
            if (!data || typeof data !== "object" || Array.isArray(data)) reject(422, "invalid_land_item", "repo and prNumber are required");
            const claimant = Object.hasOwn(data, "claimantMemberId") ? data.claimantMemberId : null;
            // B6: requestId is the caller's idempotency key — a retry with the
            // same key replays the stored response instead of re-executing.
            // exact() matches the key set precisely, so the allowed list is
            // built from the optional keys actually present.
            const allowed = ["repo", "prNumber"];
            if (claimant !== null) allowed.push("claimantMemberId");
            if (data.requestId !== undefined) allowed.push("requestId");
            if (!exact(data, allowed) || typeof data.repo !== "string" || !Number.isSafeInteger(data.prNumber)) {
              reject(422, "invalid_land_item", "repo and prNumber are required");
            }
            const result = await store.landQueue.add(roomId, auth.member.id, {
              repo: data.repo, prNumber: data.prNumber, claimantMemberId: claimant,
              requestId: data.requestId ?? null
            });
            return json(res, result.duplicate ? 200 : 201, result);
          }
          if (action === "remove_land_item") {
            const removeAllowed = data.requestId === undefined ? ["itemId"] : ["itemId", "requestId"];
            if (!exact(data, removeAllowed) || typeof data.itemId !== "string") reject(422, "invalid_land_item", "itemId is required");
            return json(res, 200, store.landQueue.remove(roomId, auth.member.id, { itemId: data.itemId, requestId: data.requestId ?? null }));
          }
          const tipKeys = Object.keys(data ?? {});
          const tipAllowed = tipKeys.every(key => ["itemId", "sourceRevision", "buildId", "requestId"].includes(key)) && tipKeys.includes("itemId");
          if (!tipAllowed || typeof data.itemId !== "string") reject(422, "invalid_land_tip", "itemId and a tip field are required");
          return json(res, 200, store.landQueue.reportTip(roomId, auth.member.id, data));
        } catch (error) {
          if (error instanceof ServiceError && error.code === "github_unconfigured") {
            return json(res, 503, { error: { code: error.code, message: error.message }, ...(error.item ? { item: error.item } : {}) });
          }
          throw error;
        }
      }
      // Room files: the same room_attachments store the MCP file tools use.
      // Stage bytes, list them, then commit a staged file onto a message.
      const roomFilesMatch = /^\/api\/rooms\/([^/]{1,384})\/files$/.exec(url.pathname);
      const roomFileCommitMatch = /^\/api\/rooms\/([^/]{1,384})\/files\/([^/]{1,384})\/commit$/.exec(url.pathname);
      // Parity with MCP room_get_file: read one file's bytes over REST. The
      // commit template ends in /commit so it can never match this anchored
      // pattern; keep the const a plain regex literal so the route-docs gate
      // extracts it (the gate only indexes `const x = /^...$/;` shapes).
      const roomFileGetMatch = /^\/api\/rooms\/([^/]{1,384})\/files\/([^/]{1,384})$/.exec(url.pathname);
      if (roomFilesMatch || roomFileCommitMatch || roomFileGetMatch) {
        const roomId = pathId((roomFilesMatch || roomFileCommitMatch || roomFileGetMatch)[1]);
        const fileId = roomFileCommitMatch ? pathId(roomFileCommitMatch[2]) : null;
        const readFileId = roomFileGetMatch ? pathId(roomFileGetMatch[2]) : null;
        const writing = req.method === "POST";
        const selected = roomCredentials(req, url);
        const fence = selected.mode === "account" ? accountBinding(req, null) : expectedBinding(req);
        const auth = roomAuth(selected, roomId, fence);
        if (selected.bearer && auth.credentialScope !== "room") reject(403, "access_denied", "Bearer account sessions are not accepted");
        if (!selected.bearer && auth.kind !== "session") reject(401, "unauthenticated", "Browser session required");
        if (auth.kind === "api-key") {
          const requiredScope = writing ? "rooms:write" : "rooms:read";
          const granted = (auth.apiKeyScopes ?? []).some(scope =>
            scope === requiredScope || (scope.endsWith(":*") && requiredScope.startsWith(scope.slice(0, -1))));
          if (!granted) reject(403, "insufficient_scope", `API key lacks the ${requiredScope} scope`);
        }
        if (readFileId) {
          if (!["GET", "HEAD"].includes(req.method)) reject(405, "method_not_allowed", "Method not allowed", { Allow: "GET" });
          rate(`read:${auth.credentialHash}`, 600);
          return json(res, 200, store.roomAttachments.get(selected.token, roomId, readFileId), req.method === "HEAD");
        }
        if (!writing) {
          if (!["GET", "HEAD"].includes(req.method) || fileId) reject(405, "method_not_allowed", "Method not allowed", { Allow: fileId ? "POST" : "GET" });
          rate(`read:${auth.credentialHash}`, 600);
          return json(res, 200, store.roomAttachments.list(selected.token, roomId), req.method === "HEAD");
        }
        if (req.method !== "POST") reject(405, "method_not_allowed", "Method not allowed", { Allow: fileId ? "POST" : "GET, POST" });
        protectWrite(req, auth, selected.bearer);
        rate(`write:${auth.credentialHash}`, 60);
        if (fileId) {
          const data = await body(req);
          if (!exact(data, ["messageId"]) || typeof data.messageId !== "string") reject(422, "invalid_message", "messageId is required");
          return json(res, 200, store.roomAttachments.commit(selected.token, roomId, { id: fileId, messageId: data.messageId }));
        }
        const data = await body(req, { limit: mcpAttachmentBodyBytes });
        if (!data || typeof data.id !== "string" || typeof data.filename !== "string" || typeof data.mediaType !== "string" || typeof data.data !== "string"
          || !exact(data, ["id", "filename", "mediaType", "data"])) {
          reject(422, "invalid_attachment", "id, filename, mediaType, and data are required");
        }
        const staged = store.roomAttachments.stage(selected.token, roomId, data);
        return json(res, staged.duplicate ? 200 : 201, staged);
      }
      // onboarding-funnel was removed on main (replaced by activation-pack);
      // dm-consents + public-face are this branch's consent/face routes.
      const publicWorkResultsMatch = /^\/api\/rooms\/([^/]{1,384})\/public-work\/results$/.exec(url.pathname);
      const publicWorkInspectMatch = /^\/api\/rooms\/([^/]{1,384})\/public-work\/receipts\/([^/]{1,128})$/.exec(url.pathname);
      const publicWorkDecideMatch = /^\/api\/rooms\/([^/]{1,384})\/public-work\/receipts\/([^/]{1,128})\/decide$/.exec(url.pathname);
      const publicWorkVerifyMatch = /^\/api\/rooms\/([^/]{1,384})\/public-work\/receipts\/([^/]{1,128})\/verify$/.exec(url.pathname);
      const publicWorkFollowUpMatch = /^\/api\/rooms\/([^/]{1,384})\/public-work\/receipts\/([^/]{1,128})\/follow-up$/.exec(url.pathname);
      const publicWorkRoomReviewMatch = publicWorkResultsMatch ?? publicWorkInspectMatch ?? publicWorkDecideMatch ?? publicWorkVerifyMatch ?? publicWorkFollowUpMatch;
      const projectOfferPublishMatch = /^\/api\/rooms\/([^/]{1,384})\/project-offers\/([^/]{1,128})\/publish$/.exec(url.pathname);
      const projectOfferWithdrawMatch = /^\/api\/rooms\/([^/]{1,384})\/project-offers\/([^/]{1,128})\/withdraw$/.exec(url.pathname);
      const projectOfferClaimsMatch = /^\/api\/rooms\/([^/]{1,384})\/project-offers\/([^/]{1,128})\/claims$/.exec(url.pathname);
      const projectOfferActionMatch = projectOfferPublishMatch ?? projectOfferWithdrawMatch ?? projectOfferClaimsMatch;
      const match = /^\/api\/rooms\/([^/]{1,384})(?:\/(commands|events|context|conversation|stream|cursor|project-offers|return-brief|work-changes|work-context|work-discussion|work-result|work-sessions|presence|capabilities|export|import|charter|outside-agents|request-runs|reply-requests|reply-context|reply-history|invitations|share-links|share-links-cancel|reminders|reports|agent-connections|guest-agent-links|guest-invites|guest-invites-list|guest-invites-revoke|guest-invites-disconnect|guest-invites-revoke-all|guest-invites-upgrade|diagnostics|diagnostics-export|search|pins|provider-heartbeats|identity-links|agent-invites|agent-pause|access-review|access-requests|usage|notifications|spend-allowance|agent-inbox|activation-pack|orient|verification-policy|dm-consents|bonds|peer-dms|directory|opportunities|public-face|needs-attention|jev-shadow|mentions|open-questions|human-push|thread-mutes|referrals|referral-invites|activity|activity-read|activity-read-all|activity-unread-count|read-horizon|saved))?$/.exec(url.pathname);
      // Round-2 #112: threaded replies share the room funnel below (id decoding,
      // credential selection, read rate limit) with every other room route.
      const threadMatch = /^\/api\/rooms\/([^/]{1,384})\/messages\/([^/]{1,384})\/thread$/.exec(url.pathname);
      const accessDecideMatch = /^\/api\/rooms\/([^/]{1,384})\/access-requests\/([^/]{1,64})\/decide$/.exec(url.pathname);
      // RC-2026-09-18-038: owner-granted membership administration for agent
      // identities (server/membership-delegation.mjs). Grant and revoke are
      // owner-only; the list is owner-only like the sibling audit lists.
      const delegationGrantMatch = /^\/api\/rooms\/([^/]{1,384})\/membership-delegation\/grant$/.exec(url.pathname);
      const delegationRevokeMatch = /^\/api\/rooms\/([^/]{1,384})\/membership-delegation\/revoke$/.exec(url.pathname);
      const delegationListMatch = /^\/api\/rooms\/([^/]{1,384})\/membership-delegation$/.exec(url.pathname);
      // Owner delegates (server/owner-delegates.mjs): per-room grants that
      // let an agent identity act with the owner's authority. Grant, revoke,
      // and list are owner-only; the holder can never grant further.
      const ownerDelegateGrantMatch = /^\/api\/rooms\/([^/]{1,384})\/owner-delegates\/grant$/.exec(url.pathname);
      const ownerDelegateRevokeMatch = /^\/api\/rooms\/([^/]{1,384})\/owner-delegates\/revoke$/.exec(url.pathname);
      const ownerDelegateListMatch = /^\/api\/rooms\/([^/]{1,384})\/owner-delegates$/.exec(url.pathname);
      // Attention: DELETE /api/rooms/:roomId/saved/:messageId unsaves one message.
      const savedDeleteMatch = /^\/api\/rooms\/([^/]{1,384})\/saved\/([^/]{1,384})$/.exec(url.pathname);
      const ownershipTransferMatch = /^\/api\/rooms\/([^/]{1,384})\/ownership\/transfer$/.exec(url.pathname);
      // Consent-bound DMs: list/request at the funnel root, decide/revoke/unblock below.
      const dmConsentDecideMatch = /^\/api\/rooms\/([^/]{1,384})\/dm-consents\/([^/]{1,64})\/decide$/.exec(url.pathname);
      const dmConsentBlockMatch = /^\/api\/rooms\/([^/]{1,384})\/dm-consents\/block$/.exec(url.pathname);
      const dmConsentRevokeMatch = /^\/api\/rooms\/([^/]{1,384})\/dm-consents\/revoke$/.exec(url.pathname);
      const dmConsentUnblockMatch = /^\/api\/rooms\/([^/]{1,384})\/dm-consents\/unblock$/.exec(url.pathname);
      const peerDmThreadMatch = /^\/api\/rooms\/([^/]{1,384})\/peer-dms\/([^/]{1,160})$/.exec(url.pathname);
      // Operator prerequisites: per-agent autonomy tiers. Owner-only read
      // and write.
      const operatorAgentMatch = /^\/api\/rooms\/([^/]{1,384})\/operator\/agents\/([^/]{1,64})$/.exec(url.pathname);
      // UFO-steal slice 1 (RC-2026-09-27-2728): per-agent capability grant
      // edges. Management is owner-or-delegate; agents read their own edges.
      const agentGrantsMatch = /^\/api\/rooms\/([^/]{1,384})\/agent-grants$/.exec(url.pathname);
      const agentGrantDeleteMatch = /^\/api\/rooms\/([^/]{1,384})\/agent-grants\/([^/]{1,64})\/([^/]{1,128})$/.exec(url.pathname);
      const agentCapabilitiesMatch = /^\/api\/rooms\/([^/]{1,384})\/agent-capabilities$/.exec(url.pathname);
      // #658: mention lifecycle. The ack template names the message event;
      // settings is a literal segment and is tested first so it is never
      // mistaken for a message event id.
      const mentionSettingsMatch = /^\/api\/rooms\/([^/]{1,384})\/mentions\/settings$/.exec(url.pathname);
      const mentionAckMatch = /^\/api\/rooms\/([^/]{1,384})\/mentions\/([^/]{1,128})\/ack$/.exec(url.pathname);
      // RC-2026-09-23: self-deactivation. DELETE /api/rooms/{roomId}/members/{memberId}
      // deactivates the caller's own membership (memberId must equal the
      // authenticated member id; anything else is 403). Emits
      // member.access_changed with active:false via the event-sourced path;
      // the identity link is kept (identity is not deleted).
      const memberDeactivateMatch = /^\/api\/rooms\/([^/]{1,384})\/members\/([^/]{1,64})$/.exec(url.pathname);
      // plan-dir-card: a member's directory card (owns[] + reach{}) for
      // the member chip, and the owner-only directory seed.
      const memberCardMatch = /^\/api\/rooms\/([^/]{1,384})\/members\/([^/]{1,64})\/card$/.exec(url.pathname);
      const dirSeedMatch = /^\/api\/rooms\/([^/]{1,384})\/directory\/seed$/.exec(url.pathname);
      // Public-face controls (owner only): status/toggle at the funnel root, rotate below.
      const publicFaceRotateMatch = /^\/api\/rooms\/([^/]{1,384})\/public-face\/rotate$/.exec(url.pathname);
      // Lane C inbox collaboration (task RC-2026-09-18-011): every collab
      // route template below is documented in docs/openapi.yaml — the
      // route-docs gate extracts these literals from this file.
      const collabAssignmentsMatch = /^\/api\/rooms\/([^/]{1,384})\/collab\/assignments$/.exec(url.pathname);
      const collabAssignmentReleaseMatch = /^\/api\/rooms\/([^/]{1,384})\/collab\/assignments\/([^/]{1,64})\/release$/.exec(url.pathname);
      const collabNotesMatch = /^\/api\/rooms\/([^/]{1,384})\/collab\/notes$/.exec(url.pathname);
      const collabLockAcquireMatch = /^\/api\/rooms\/([^/]{1,384})\/collab\/draft-locks\/acquire$/.exec(url.pathname);
      const collabLockReleaseMatch = /^\/api\/rooms\/([^/]{1,384})\/collab\/draft-locks\/release$/.exec(url.pathname);
      const collabLocksMatch = /^\/api\/rooms\/([^/]{1,384})\/collab\/draft-locks$/.exec(url.pathname);
      const collabApprovalsMatch = /^\/api\/rooms\/([^/]{1,384})\/collab\/approvals$/.exec(url.pathname);
      const collabApprovalDecideMatch = /^\/api\/rooms\/([^/]{1,384})\/collab\/approvals\/([^/]{1,64})\/decide$/.exec(url.pathname);
      const collabApprovalResubmitMatch = /^\/api\/rooms\/([^/]{1,384})\/collab\/approvals\/([^/]{1,64})\/resubmit$/.exec(url.pathname);
      const collabRoutingMentionsMatch = /^\/api\/rooms\/([^/]{1,384})\/collab\/routing\/mentions$/.exec(url.pathname);
      const collabRoutingMatch = /^\/api\/rooms\/([^/]{1,384})\/collab\/routing$/.exec(url.pathname);
      const collabRoutingResolveMatch = /^\/api\/rooms\/([^/]{1,384})\/collab\/routing\/([^/]{1,64})\/resolve$/.exec(url.pathname);
      const collabRoutingPolicyMatch = /^\/api\/rooms\/([^/]{1,384})\/collab\/routing\/policy$/.exec(url.pathname);
      const collabHandoffsMatch = /^\/api\/rooms\/([^/]{1,384})\/collab\/handoffs$/.exec(url.pathname);
      const collabHandoffTransitionMatch = /^\/api\/rooms\/([^/]{1,384})\/collab\/handoffs\/([^/]{1,64})\/transition$/.exec(url.pathname);
      // Typed handoff envelopes (RC-2026-09-19-062). The sweep/metrics
      // literals are separate templates so they are never mistaken for an
      // envelope id by the transition template below.
      const collabEnvelopesMatch = /^\/api\/rooms\/([^/]{1,384})\/collab\/envelopes$/.exec(url.pathname);
      const collabEnvelopeSweepMatch = /^\/api\/rooms\/([^/]{1,384})\/collab\/envelopes\/sweep$/.exec(url.pathname);
      const collabEnvelopeMetricsMatch = /^\/api\/rooms\/([^/]{1,384})\/collab\/envelopes\/metrics$/.exec(url.pathname);
      const collabEnvelopeTransitionMatch = /^\/api\/rooms\/([^/]{1,384})\/collab\/envelopes\/([^/]{1,64})\/transition$/.exec(url.pathname);
      const collabMatch = collabAssignmentsMatch ?? collabAssignmentReleaseMatch ?? collabNotesMatch
        ?? collabLockAcquireMatch ?? collabLockReleaseMatch ?? collabLocksMatch ?? collabApprovalsMatch
        ?? collabApprovalDecideMatch ?? collabApprovalResubmitMatch ?? collabRoutingMentionsMatch
        ?? collabRoutingMatch ?? collabRoutingResolveMatch ?? collabRoutingPolicyMatch ?? collabHandoffsMatch
        ?? collabHandoffTransitionMatch ?? collabEnvelopesMatch ?? collabEnvelopeSweepMatch
        ?? collabEnvelopeMetricsMatch ?? collabEnvelopeTransitionMatch;
      // Work claims with leases, delivery modes and review policies (task
      // RC-2026-09-18-041): every route template below is documented in
      // docs/openapi.yaml — the route-docs gate extracts these literals from
      // this file. The /sweep and /duplicates templates are tested before the
      // {id} template so the literal segments are never mistaken for a claim id.
      const mmSeekerMatch = /^\/api\/rooms\/([^/]{1,384})\/matchmaking\/seeker$/.exec(url.pathname);
      const mmOfferMatch = /^\/api\/rooms\/([^/]{1,384})\/matchmaking\/openings$/.exec(url.pathname);
      const mmMatchMatch = /^\/api\/rooms\/([^/]{1,384})\/matchmaking\/match$/.exec(url.pathname);
      const mmDecisionsMatch = /^\/api\/rooms\/([^/]{1,384})\/matchmaking\/decisions$/.exec(url.pathname);
      const mmDecisionAnswerMatch = /^\/api\/rooms\/([^/]{1,384})\/matchmaking\/decisions\/([^/]{1,128})\/answer$/.exec(url.pathname);
      const mmDecisionReadMatch = /^\/api\/rooms\/([^/]{1,384})\/matchmaking\/decisions\/([^/]{1,128})$/.exec(url.pathname);
      const matchmakingMatch = mmSeekerMatch ?? mmOfferMatch ?? mmMatchMatch ?? mmDecisionsMatch
        ?? mmDecisionAnswerMatch ?? mmDecisionReadMatch;
      const workClaimsMatch = /^\/api\/rooms\/([^/]{1,384})\/work-claims$/.exec(url.pathname);
      const workClaimsStatusMatch = /^\/api\/rooms\/([^/]{1,384})\/work-claims\/status$/.exec(url.pathname);
      const workClaimsSweepMatch = /^\/api\/rooms\/([^/]{1,384})\/work-claims\/sweep$/.exec(url.pathname);
      const workClaimsDuplicatesMatch = /^\/api\/rooms\/([^/]{1,384})\/work-claims\/duplicates$/.exec(url.pathname);
      // Owner cap for open claims per member. Literal segment before {id}.
      const workClaimsConfigMatch = /^\/api\/rooms\/([^/]{1,384})\/work-claims\/config$/.exec(url.pathname);
      const workClaimItemMatch = /^\/api\/rooms\/([^/]{1,384})\/work-claims\/([^/]{1,128})$/.exec(url.pathname);
      const workClaimClaimMatch = /^\/api\/rooms\/([^/]{1,384})\/work-claims\/([^/]{1,128})\/claim$/.exec(url.pathname);
      const workClaimUpdateMatch = /^\/api\/rooms\/([^/]{1,384})\/work-claims\/([^/]{1,128})\/update$/.exec(url.pathname);
      const workClaimReviewMatch = /^\/api\/rooms\/([^/]{1,384})\/work-claims\/([^/]{1,128})\/review$/.exec(url.pathname);
      const workClaimReleaseMatch = /^\/api\/rooms\/([^/]{1,384})\/work-claims\/([^/]{1,128})\/release$/.exec(url.pathname);
      const workClaimReassignMatch = /^\/api\/rooms\/([^/]{1,384})\/work-claims\/([^/]{1,128})\/reassign$/.exec(url.pathname);
      const workClaimReceiptsMatch = /^\/api\/rooms\/([^/]{1,384})\/receipts$/.exec(url.pathname);
      const workClaimRenewMatch = /^\/api\/rooms\/([^/]{1,384})\/work-claims\/([^/]{1,128})\/renew$/.exec(url.pathname);
      // Provenance walk + premise-invalid rollback (orch-provenance-rollback).
      // Literal segments are matched before the {id} template so they are
      // never mistaken for a claim id.
      const workClaimMatch = workClaimsMatch ?? workClaimsStatusMatch ?? workClaimsSweepMatch ?? workClaimsDuplicatesMatch ?? workClaimsConfigMatch ?? workClaimClaimMatch
        ?? workClaimUpdateMatch ?? workClaimReviewMatch ?? workClaimReleaseMatch ?? workClaimReassignMatch ?? workClaimRenewMatch
        ?? workClaimItemMatch
        ?? workClaimReceiptsMatch;
      // Agent /feedback endpoint (structured bug/feature reports): every
      // route template below is documented in docs/openapi.yaml — the
      // route-docs gate extracts these literals from this file. The literal
      // segments (queue, notifications) are tested before the {id} template
      // so they are never mistaken for a feedback id (each regex is
      // anchored, so this is belt-and-braces).
      const feedbackBaseMatch = /^\/api\/rooms\/([^/]{1,384})\/feedback$/.exec(url.pathname);
      const feedbackQueueMatch = /^\/api\/rooms\/([^/]{1,384})\/feedback\/queue$/.exec(url.pathname);
      const feedbackNotificationsMatch = /^\/api\/rooms\/([^/]{1,384})\/feedback\/notifications$/.exec(url.pathname);
      const feedbackItemMatch = /^\/api\/rooms\/([^/]{1,384})\/feedback\/([^/]{1,64})$/.exec(url.pathname);
      const feedbackTriageMatch = /^\/api\/rooms\/([^/]{1,384})\/feedback\/([^/]{1,64})\/triage$/.exec(url.pathname);
      const feedbackAppealMatch = /^\/api\/rooms\/([^/]{1,384})\/feedback\/([^/]{1,64})\/appeal$/.exec(url.pathname);
      const feedbackAppealDecisionMatch = /^\/api\/rooms\/([^/]{1,384})\/feedback\/([^/]{1,64})\/appeal\/decision$/.exec(url.pathname);
      const feedbackOutcomeMatch = /^\/api\/rooms\/([^/]{1,384})\/feedback\/([^/]{1,64})\/outcome$/.exec(url.pathname);
      const feedbackMatch = feedbackBaseMatch ?? feedbackQueueMatch ?? feedbackNotificationsMatch
        ?? feedbackAppealDecisionMatch ?? feedbackTriageMatch ?? feedbackAppealMatch
        ?? feedbackOutcomeMatch ?? feedbackItemMatch;
      // Escrowed bounties + credit ledger (agent work exchange, slice 1):
      // every route template below is documented in docs/openapi.yaml — the
      // route-docs gate extracts these literals from this file. The
      // /dispute/decide template is listed before /dispute so the literal
      // segment is never mistaken for part of a dispute id (each regex is
      // anchored, so this is belt-and-braces). :identity may carry a lane id
      // like id:agent/jill — callers percent-encode the slash.
      const bountyListMatch = /^\/api\/rooms\/([^/]{1,384})\/bounties$/.exec(url.pathname);
      const bountyFundMatch = /^\/api\/rooms\/([^/]{1,384})\/bounties\/([^/]{1,128})\/fund$/.exec(url.pathname);
      const bountyDeclineMatch = /^\/api\/rooms\/([^/]{1,384})\/bounties\/([^/]{1,128})\/decline$/.exec(url.pathname);
      const bountySnoozeMatch = /^\/api\/rooms\/([^/]{1,384})\/bounties\/([^/]{1,128})\/snooze$/.exec(url.pathname);
      const bountyDuplicateMatch = /^\/api\/rooms\/([^/]{1,384})\/bounties\/([^/]{1,128})\/duplicate$/.exec(url.pathname);
      const bountyWatchMatch = /^\/api\/rooms\/([^/]{1,384})\/bounties\/([^/]{1,128})\/watch$/.exec(url.pathname);
      const bountyClaimMatch = /^\/api\/rooms\/([^/]{1,384})\/bounties\/([^/]{1,128})\/claim$/.exec(url.pathname);
      const bountySubmitMatch = /^\/api\/rooms\/([^/]{1,384})\/bounties\/([^/]{1,128})\/submit$/.exec(url.pathname);
      const bountyAcceptMatch = /^\/api\/rooms\/([^/]{1,384})\/bounties\/([^/]{1,128})\/accept$/.exec(url.pathname);
      // Free-miss settlement: the poster/verifier's first-party rejection of
      // submitted work. Literal segment — must never be mistaken for a bounty id.
      const bountyRejectMatch = /^\/api\/rooms\/([^/]{1,384})\/bounties\/([^/]{1,128})\/reject$/.exec(url.pathname);
      const bountyDisputeDecideMatch = /^\/api\/rooms\/([^/]{1,384})\/bounties\/([^/]{1,128})\/dispute\/decide$/.exec(url.pathname);
      const bountyDisputeMatch = /^\/api\/rooms\/([^/]{1,384})\/bounties\/([^/]{1,128})\/dispute$/.exec(url.pathname);
      const bountyFinalizeMatch = /^\/api\/rooms\/([^/]{1,384})\/bounties\/([^/]{1,128})\/finalize$/.exec(url.pathname);
      const bountyRubricMatch = /^\/api\/rooms\/([^/]{1,384})\/bounties\/([^/]{1,128})\/rubric$/.exec(url.pathname);
      // Slice 10: literal segment — arbiter review-packet inspection; must
      // never be mistaken for a bounty id.
      const bountyReviewsMatch = /^\/api\/rooms\/([^/]{1,384})\/bounties\/reviews$/.exec(url.pathname);
      // Slice 10: sybil-flag arbiter queue + resolution. Literal segments;
      // must never be mistaken for a bounty id.
      const bountySybilFlagsMatch = /^\/api\/rooms\/([^/]{1,384})\/bounties\/sybil-flags$/.exec(url.pathname);
      const bountySybilDismissMatch = /^\/api\/rooms\/([^/]{1,384})\/bounties\/sybil-flags\/([^/]{1,128})\/dismiss$/.exec(url.pathname);
      const bountySybilConfirmMatch = /^\/api\/rooms\/([^/]{1,384})\/bounties\/sybil-flags\/([^/]{1,128})\/confirm$/.exec(url.pathname);
      const bountyReputationReviewsMatch = /^\/api\/rooms\/([^/]{1,384})\/bounties\/reputation-reviews$/.exec(url.pathname);
      const bountyMatch = bountyListMatch ?? bountyFundMatch ?? bountyDeclineMatch ?? bountySnoozeMatch
        ?? bountyDuplicateMatch ?? bountyWatchMatch ?? bountyClaimMatch ?? bountySubmitMatch ?? bountyAcceptMatch
        ?? bountyRejectMatch
        ?? bountyDisputeDecideMatch ?? bountyDisputeMatch ?? bountyFinalizeMatch ?? bountyRubricMatch
        ?? bountyReviewsMatch ?? bountySybilFlagsMatch ?? bountySybilDismissMatch ?? bountySybilConfirmMatch
        ?? bountyReputationReviewsMatch;
      const creditsBalancesMatch = /^\/api\/rooms\/([^/]{1,384})\/credits\/balances\/([^/]{1,256})$/.exec(url.pathname);
      const creditsHistoryMatch = /^\/api\/rooms\/([^/]{1,384})\/credits\/history\/([^/]{1,256})$/.exec(url.pathname);
      const creditsTransferMatch = /^\/api\/rooms\/([^/]{1,384})\/credits\/transfer$/.exec(url.pathname);
      const creditsEpochMatch = /^\/api\/rooms\/([^/]{1,384})\/credits\/epoch\/close$/.exec(url.pathname);
      const creditsMatch = creditsBalancesMatch ?? creditsHistoryMatch ?? creditsTransferMatch ?? creditsEpochMatch;
      // Board v2 (RC-2026-09-27-2720): the durable claims board mounted under
      // the room funnel. One anchored regex per concrete route — the
      // route-docs gate (scripts/open-routes.mjs) expands only ([^/]{1,N})
      // groups, so a subtree regex would fail the check. The board itself is
      // deployment-wide (one per room database); :roomId selects the auth
      // context. Literal segments (heartbeat/release/receipts) sit on their
      // own templates so they are never mistaken for a task id.
      const boardV2ClaimsMatch = /^\/api\/rooms\/([^/]{1,384})\/board\/v2\/claims$/.exec(url.pathname);
      const boardV2HeartbeatMatch = /^\/api\/rooms\/([^/]{1,384})\/board\/v2\/claims\/([^/]{1,128})\/heartbeat$/.exec(url.pathname);
      const boardV2ReleaseMatch = /^\/api\/rooms\/([^/]{1,384})\/board\/v2\/claims\/([^/]{1,128})\/release$/.exec(url.pathname);
      const boardV2ReceiptsMatch = /^\/api\/rooms\/([^/]{1,384})\/board\/v2\/claims\/([^/]{1,128})\/receipts$/.exec(url.pathname);
      const boardV2NotesMatch = /^\/api\/rooms\/([^/]{1,384})\/board\/v2\/notes$/.exec(url.pathname);
      const boardV2FindingsMatch = /^\/api\/rooms\/([^/]{1,384})\/board\/v2\/findings$/.exec(url.pathname);
      const boardV2DecisionsMatch = /^\/api\/rooms\/([^/]{1,384})\/board\/v2\/decisions$/.exec(url.pathname);
      const boardV2BoardMatch = /^\/api\/rooms\/([^/]{1,384})\/board\/v2\/board$/.exec(url.pathname);
      const boardV2EventsMatch = /^\/api\/rooms\/([^/]{1,384})\/board\/v2\/events$/.exec(url.pathname);
      const boardV2MirrorMatch = /^\/api\/rooms\/([^/]{1,384})\/board\/v2\/mirror-map$/.exec(url.pathname);
      const boardV2HealthMatch = /^\/api\/rooms\/([^/]{1,384})\/board\/v2\/health$/.exec(url.pathname);
      const boardV2Match = boardV2ClaimsMatch ?? boardV2HeartbeatMatch ?? boardV2ReleaseMatch ?? boardV2ReceiptsMatch
        ?? boardV2NotesMatch ?? boardV2FindingsMatch ?? boardV2DecisionsMatch ?? boardV2BoardMatch
        ?? boardV2EventsMatch ?? boardV2MirrorMatch ?? boardV2HealthMatch;
      // Consent-bound DMs (decide/revoke/unblock) and public-face rotate ride
      // the same funnel: their literal segments must never be mistaken for ids.
      if (!publicWorkRoomReviewMatch && !projectOfferActionMatch && !match && !revokeMatch && !threadMatch && !accessDecideMatch && !delegationGrantMatch && !delegationRevokeMatch && !delegationListMatch && !ownerDelegateGrantMatch && !ownerDelegateRevokeMatch && !ownerDelegateListMatch && !ownershipTransferMatch && !collabMatch && !workClaimMatch
        && !feedbackMatch && !bountyMatch && !creditsMatch && !boardV2Match
        && !dmConsentDecideMatch && !dmConsentBlockMatch && !dmConsentRevokeMatch && !dmConsentUnblockMatch && !publicFaceRotateMatch
        && !peerDmThreadMatch && !operatorAgentMatch
        && !mentionAckMatch && !mentionSettingsMatch && !savedDeleteMatch && !memberDeactivateMatch
        && !memberCardMatch && !dirSeedMatch
        && !agentGrantsMatch && !agentGrantDeleteMatch && !agentCapabilitiesMatch
        && !matchmakingMatch) reject(404, "not_found", "Not found");
      const roomId = pathId((publicWorkRoomReviewMatch ?? projectOfferActionMatch ?? match ?? revokeMatch ?? threadMatch ?? accessDecideMatch ?? delegationGrantMatch ?? delegationRevokeMatch ?? delegationListMatch ?? ownerDelegateGrantMatch ?? ownerDelegateRevokeMatch ?? ownerDelegateListMatch ?? ownershipTransferMatch ?? collabMatch ?? workClaimMatch
        ?? feedbackMatch ?? bountyMatch ?? creditsMatch ?? boardV2Match
        ?? dmConsentDecideMatch ?? dmConsentBlockMatch ?? dmConsentRevokeMatch ?? dmConsentUnblockMatch ?? publicFaceRotateMatch
        ?? peerDmThreadMatch ?? operatorAgentMatch
        ?? mentionAckMatch ?? mentionSettingsMatch ?? savedDeleteMatch ?? memberDeactivateMatch
        ?? memberCardMatch ?? dirSeedMatch
        ?? agentGrantsMatch ?? agentGrantDeleteMatch ?? agentCapabilitiesMatch ?? matchmakingMatch)[1]);
      // NOTE: matchmakingMatch must stay in the roomId chain above — it was
      // added to the 404 guard but forgotten here, so every matchmaking
      // route 500'd on `undefined[1]` instead of reaching roomAuth's 401.
      const invitationId = revokeMatch ? pathId(revokeMatch[2]) : null;
      const threadMessageId = threadMatch ? pathId(threadMatch[2]) : null;
      const accessRequestId = accessDecideMatch ? pathId(accessDecideMatch[2]) : null;
      const dmRequesterId = dmConsentDecideMatch ? pathId(dmConsentDecideMatch[2]) : null;
      const peerDmThreadId = peerDmThreadMatch ? pathId(peerDmThreadMatch[2]) : null;
      const mentionEventId = mentionAckMatch ? pathId(mentionAckMatch[2]) : null;
      const savedDeleteMessageId = savedDeleteMatch ? pathId(savedDeleteMatch[2]) : null;
      const deactivateMemberId = memberDeactivateMatch ? pathId(memberDeactivateMatch[2]) : null;
      const cardMemberId = memberCardMatch ? pathId(memberCardMatch[2]) : null;
      const route = publicWorkRoomReviewMatch ? "public-work-review" : projectOfferActionMatch ? "project-offers" : match ? (match[2] ?? "") : revokeMatch ? "invitation-revoke" : threadMatch ? "thread" : accessDecideMatch ? "access-decide" : delegationGrantMatch ? "delegation-grant" : delegationRevokeMatch ? "delegation-revoke" : delegationListMatch ? "delegation-list" : ownerDelegateGrantMatch ? "owner-delegate-grant" : ownerDelegateRevokeMatch ? "owner-delegate-revoke" : ownerDelegateListMatch ? "owner-delegate-list"
        : dmConsentDecideMatch ? "dm-consent-decide" : dmConsentBlockMatch ? "dm-consent-block" : dmConsentRevokeMatch ? "dm-consent-revoke"
        : dmConsentUnblockMatch ? "dm-consent-unblock" : publicFaceRotateMatch ? "public-face-rotate"
        : peerDmThreadMatch ? "peer-dm-thread" : operatorAgentMatch ? "operator-agent"
        : agentGrantsMatch ? "agent-grants" : agentGrantDeleteMatch ? "agent-grant-delete"
        : agentCapabilitiesMatch ? "agent-capabilities"
        : mentionAckMatch ? "mention-ack" : mentionSettingsMatch ? "mention-settings" : savedDeleteMatch ? "saved-delete"
        : memberDeactivateMatch ? "member-deactivate"
        : memberCardMatch ? "member-card" : dirSeedMatch ? "directory-seed"
        : "ownership-transfer";      const selected = roomCredentials(req, url);
      const fence = selected.mode === "account" ? accountBinding(req, route === "stream" ? url : null) : expectedBinding(req);
      const auth = roomAuth(selected, roomId, fence);
      if (selected.bearer && auth.credentialScope !== "room") reject(403, "access_denied", "Bearer account sessions are not accepted");
      if (!selected.bearer && auth.kind !== "session") reject(401, "unauthenticated", "Browser session required");
      rate(`read:${auth.credentialHash}`, 600);
      if (!["GET", "HEAD"].includes(req.method)) {
        protectWrite(req, auth, selected.bearer);
        // Housekeeping writes (read markers, saves, presence, cursor)
        // fire as a side effect of reading and typing. They get their own
        // bucket so a fast typist's read markers don't spend the 60/min
        // budget the chat flood guard and real writes share.
        const housekeeping = HOUSEKEEPING_WRITE_ROUTES.has(route);
        rate(housekeeping ? `write-hk:${auth.credentialHash}` : `write:${auth.credentialHash}`, housekeeping ? HOUSEKEEPING_WRITE_PER_MINUTE : 60);
      }
      // RC-2026-09-18-012: API-key callers are confined to their stored
      // scopes on every room route — reads need rooms:read, writes need
      // rooms:write. Owner identity secrets and room credentials are
      // unaffected. The agent-inbox route is narrower than the room event
      // log, so it carries its own inbox:read gate instead (see below): an
      // inbox-only key must not imply rooms:read.
      if (auth.kind === "api-key" && route !== "agent-inbox") {
        const requiredScope = req.method === "GET" || req.method === "HEAD" ? "rooms:read" : "rooms:write";
        const granted = (auth.apiKeyScopes ?? []).some(scope =>
          scope === requiredScope || (scope.endsWith(":*") && requiredScope.startsWith(scope.slice(0, -1))));
        if (!granted) reject(403, "insufficient_scope", `API key lacks the ${requiredScope} scope`);
      }
      if (route === "public-work-review") {
        if ([...url.searchParams.keys()].some(key => (key !== "auth" && (!publicWorkResultsMatch || !["limit", "after"].includes(key))) || url.searchParams.getAll(key).length !== 1)) reject(422, "invalid_public_work_review", "Unsupported review query parameters");
        // FO-DRIFT-1/2: the spec constrains auth to the room|account enum.
        // Validate the selector value on the results route even when bearer
        // or header auth is selected, where roomCredentials would otherwise
        // ignore a malformed query parameter.
        const authSelector = url.searchParams.get("auth");
        if (publicWorkResultsMatch && authSelector !== null && !["room", "account"].includes(authSelector)) reject(422, "invalid_public_work_review", "Invalid auth query parameter");
        if (isGuestAgentMemberId(auth.member.id)) reject(403, "access_denied", "Guests cannot review contributions");
        const action = publicWorkDecideMatch ? "decide" : publicWorkVerifyMatch ? "verify" : publicWorkFollowUpMatch ? "follow-up" : null;
        if (!action) {
          if (!["GET", "HEAD"].includes(req.method)) reject(405, "method_not_allowed", "Method not allowed", { Allow: "GET, HEAD" });
          const result = publicWorkResultsMatch
            ? store.publicWorkReviews.results(roomId, auth.member.id, { limit: Number(url.searchParams.get("limit") ?? 20), after: url.searchParams.get("after") ?? "" })
            : store.publicWorkReviews.inspect(roomId, auth.member.id, pathId(publicWorkInspectMatch[2]));
          return json(res, 200, result, req.method === "HEAD");
        }
        if (req.method !== "POST") reject(405, "method_not_allowed", "Method not allowed", { Allow: "POST" });
        const data = await body(req);
        const result = store.transaction(() => {
          const current = roomAuth(selected, roomId, fence);
          if (current.member.id !== auth.member.id) reject(403, "access_denied", "The acting identity changed");
          if (current.kind === "api-key" && !(current.apiKeyScopes ?? []).some(scope => scope === "rooms:write" || scope === "rooms:*")) reject(403, "insufficient_scope", "API key lacks rooms:write");
          return action === "follow-up"
            ? store.publicWorkSuccessors.create(roomId, current.member.id, pathId(publicWorkFollowUpMatch[2]), data)
            : store.publicWorkReviews[action](roomId, current.member.id, pathId(publicWorkRoomReviewMatch[2]), data);
        });
        return json(res, 200, result);
      }
      if (route === "project-offers") {
        if (isGuestAgentMemberId(auth.member.id)) reject(403, "owner_only", "Guests cannot manage project offers");
        if (!projectOfferActionMatch && ["GET", "HEAD"].includes(req.method)) return json(res, 200, store.projectOffers.ownerList(roomId, auth.member.id));
        if (req.method === "POST") {
          const data = await body(req);
          const outcome = store.transaction(() => {
            // Upload may outlive credential revocation, role change or session rotation.
            const current = roomAuth(selected, roomId, fence);
            if (current.member.id !== auth.member.id) reject(403, "access_denied", "The acting identity changed");
            if (current.kind === "api-key" && !(current.apiKeyScopes ?? []).some(scope => scope === "rooms:write" || scope === "rooms:*")) reject(403, "insufficient_scope", "API key lacks rooms:write");
            if (projectOfferClaimsMatch) return store.publicWorkClaims.enable(roomId, current.member.id, pathId(projectOfferClaimsMatch[2]), data);
            return projectOfferActionMatch
              ? store.projectOffers.transition(roomId, current.member.id, pathId(projectOfferActionMatch[2]), projectOfferPublishMatch ? "publish" : "withdraw", data)
              : store.projectOffers.create(roomId, current.member.id, data);
          });
          return json(res, projectOfferActionMatch ? 200 : 201, outcome);
        }
        reject(405, "method_not_allowed", "Method not allowed");
      }
      // RC-2026-09-19-070: DM privacy. A targeted message (message.posted
      // with data.toMemberId) is visible only to its sender and its addressed
      // member — the room owner is not exempt. The /events and /stream routes
      // already enforce this inside the store (RC-2026-09-18-012); the read
      // surfaces below apply the same predicate at the HTTP layer so
      // non-participants see no DM existence, count, or metadata.
      const viewerId = auth.member.id;
      // --- PRIV-2 history visibility ---
      // A since_join reader also loses messages and events from before their
      // join (server/history-visibility.mjs). null for everyone else.
      const historyFloor = store.historyFloor(roomId, viewerId);
      const historyMessages = historyFloor ? indexHistoryMessages(store.room(roomId).state.messages) : null;
      const dmMessageVisible = message => messageInHistory(message, historyFloor)
        && (!message.toMemberId || message.authorId === viewerId || message.toMemberId === viewerId);
      // SEC-19: edits, deletes, redactions, reactions and pins of a DM follow
      // the DM's own visibility (server/dm-event-visibility.mjs).
      const dmPartyVisible = dmEventVisibility(viewerId, store.room(roomId).state.messages);
      const dmEventVisible = event => eventInHistory(event, historyFloor, historyMessages) && dmPartyVisible(event);
      // --- end PRIV-2 ---
      // Bond receipts and peer DMs are ledger events, visible to the two
      // identities (bond metadata also to the room owner). Not room chat.
      const peerContext = {
        memberId: viewerId,
        identityId: store.bonds.identityForMember(roomId, viewerId),
        isOwner: viewerId === store.room(roomId).state.room.ownerId
      };
      const roomEventVisible = event => dmEventVisible(event) && peerEventVisible(event, peerContext);
      // RC-2026-09-23-101: guest-agent scope gate, HTTP-layer half. The
      // store.command() gate (RC-2026-09-23-100) covers the event-sourced
      // command path, but the bounty-escrow, work-claim and inbox-collab
      // HTTP families bypass store.command() entirely. A redeemed GX guest
      // credential authenticates as a room-scope bearer, so without this
      // check a guest could post/fund/claim bounties, move credits, acquire
      // work claims, and hold collab draft locks. Guests hold guest:* scopes
      // only (read + chat; chat posts and reactions ride store.command(),
      // which keeps its own finer gate), so every non-read call on these
      // three families is refused outright. Reads stay open — guests keep
      // their approved history access. Same code and copy as the store
      // gate, so clients see one stable denial either way.
      if (auth.member && isGuestAgentMemberId(auth.member.id)
        && (collabMatch || workClaimMatch || feedbackMatch || bountyMatch || creditsMatch)
        && !["GET", "HEAD"].includes(req.method)) {
        reject(403, "guest_scope_denied", "Guest members cannot perform this action");
      }
      // Lane C inbox collaboration (task RC-2026-09-18-011): room-scoped
      // collab routes share the credential, fence and rate-limit checks
      // above; the handler maps pure-module errors to stable 4xx codes.
      if (collabMatch) {
        // Typed envelope routes (RC-2026-09-19-062) resolve first so the
        // /sweep and /metrics literals never read as an envelope id.
        const collabRoute = collabEnvelopesMatch ? "envelopes"
          : collabEnvelopeSweepMatch ? "envelope-sweep"
          : collabEnvelopeMetricsMatch ? "envelope-metrics"
          : collabEnvelopeTransitionMatch ? "envelope-transition"
          : collabAssignmentsMatch ? "assignments"
          : collabAssignmentReleaseMatch ? "assignment-release"
          : collabNotesMatch ? "notes"
          : collabLockAcquireMatch ? "lock-acquire"
          : collabLockReleaseMatch ? "lock-release"
          : collabLocksMatch ? "lock-detect"
          : collabApprovalsMatch ? "approvals"
          : collabApprovalDecideMatch ? "approval-decide"
          : collabApprovalResubmitMatch ? "approval-resubmit"
          : collabRoutingMentionsMatch ? "routing-mentions"
          : collabRoutingMatch ? "routing"
          : collabRoutingResolveMatch ? "routing-resolve"
          : collabRoutingPolicyMatch ? "routing-policy"
          : collabHandoffsMatch ? "handoffs" : "handoff-transition";
        const collabIdMatch = collabAssignmentReleaseMatch ?? collabApprovalDecideMatch ?? collabApprovalResubmitMatch
          ?? collabRoutingResolveMatch ?? collabHandoffTransitionMatch ?? collabEnvelopeTransitionMatch;
        return await handleInboxCollab({ req, res, url, store, roomId, auth, collabRoute,
          collabId: collabIdMatch ? pathId(collabIdMatch[2]) : null,
          reauthorize: () => {
            const current = selected.mode === "account" ? store.authenticateAccountSession(selected.token, roomId, fence)
              : store.authenticate(selected.token, roomId, fence, { allowAccountSession: false });
            if (selected.bearer && current.credentialScope !== "room") reject(403, "access_denied", "Bearer account sessions are not accepted");
            if (!selected.bearer && current.kind !== "session") reject(401, "unauthenticated", "Browser session required");
            protectWrite(req, current, selected.bearer);
            if (current.kind === "api-key" && !(current.apiKeyScopes ?? []).some(scope =>
              scope === "rooms:write" || scope.endsWith(":*") && "rooms:write".startsWith(scope.slice(0, -1))))
              reject(403, "insufficient_scope", "API key lacks the rooms:write scope");
            if (isGuestAgentMemberId(current.member.id)) reject(403, "guest_scope_denied", "Guest members cannot perform this action");
            return current;
          }, helpers: { json, reject, body } });
      }
      // Work claims (task RC-2026-09-18-041): room-scoped claim registry
      // routes share the credential, fence and rate-limit checks above; the
      // handler maps pure-module errors to stable 4xx codes.
      if (workClaimMatch) {
        const workClaimRoute = workClaimsSweepMatch ? "sweep"
          : workClaimsStatusMatch ? "status"
          : workClaimsDuplicatesMatch ? "duplicates"
          : workClaimsConfigMatch ? "config"
          : workClaimsMatch ? (req.method === "GET" ? "list" : "create")
          : workClaimReceiptsMatch ? "receipts"
          : workClaimItemMatch ? "read"
          : workClaimClaimMatch ? "claim"
          : workClaimUpdateMatch ? "update"
          : workClaimReviewMatch ? "review"
          : workClaimReleaseMatch ? "release"
          : workClaimRenewMatch ? "renew"
          : "reassign";
        const workClaimIdMatch = workClaimItemMatch ?? workClaimClaimMatch ?? workClaimUpdateMatch
          ?? workClaimReviewMatch ?? workClaimReleaseMatch ?? workClaimReassignMatch ?? workClaimRenewMatch
         ;
        return await handleWorkClaims({ req, res, url, store, roomId, auth, workClaimRoute,
          workClaimId: workClaimIdMatch ? pathId(workClaimIdMatch[2]) : null, registry: store.workClaims,
          ...(fetchPullRequest ? { fetchPullRequest } : {}),
          ...(githubToken !== undefined ? { githubToken } : {}),
          reauthorize: () => {
            const current = selected.mode === "account" ? store.authenticateAccountSession(selected.token, roomId, fence)
              : store.authenticate(selected.token, roomId, fence, { allowAccountSession: false });
            if (current.kind === "api-key") {
              const required = ["GET", "HEAD"].includes(req.method) ? "rooms:read" : "rooms:write";
              if (!(current.apiKeyScopes ?? []).some(scope => scope === required || (scope.endsWith(":*") && required.startsWith(scope.slice(0, -1))))) reject(403, "insufficient_scope", `API key lacks the ${required} scope`);
            }
            if (isGuestAgentMemberId(current.member.id) && !["GET", "HEAD"].includes(req.method)) reject(403, "guest_scope_denied", "Guest members cannot perform this action");
            return current;
          }, helpers: { json, reject, body } });
      }
      // Matchmaking (arrival surface): an agent declares what it is here for,
      // a room declares what an opening needs, and the pure matcher pairs
      // them. Human decisions enter as routable work on the same surface, so
      // a question for a person is filtered like any other opening. Shares
      // the credential, fence and rate-limit checks above.
      if (matchmakingMatch) {
        const matchmakingRoute = mmSeekerMatch ? "declare"
          : mmOfferMatch ? "offer"
          : mmMatchMatch ? "match"
          : mmDecisionsMatch ? "decision-open"
          : mmDecisionAnswerMatch ? "decision-answer" : "decision-read";
        const matchmakingIdMatch = mmDecisionAnswerMatch ?? mmDecisionReadMatch;
        // The route-docs gate (scripts/routes-inventory.mjs) is static: it
        // reads the served POST set off this condition. The five mutating
        // routes take POST with a JSON body (declare, offer, match,
        // decision-open, decision-answer); decision-read is the GET/HEAD
        // read. The shared dispatch below serves every method, so this
        // branch names the POST set and changes nothing at runtime.
        if (req.method === "POST"
          && (mmSeekerMatch ?? mmOfferMatch ?? mmMatchMatch ?? mmDecisionsMatch ?? mmDecisionAnswerMatch)) {
          // Fall through to the dispatch below.
        }
        return await handleMatchmaking({ req, res, url, store, roomId, auth, matchmakingRoute,
          matchmakingId: matchmakingIdMatch ? pathId(matchmakingIdMatch[2]) : null,
          registry: store.matchmaking,
          reauthorize: () => {
            const current = selected.mode === "account" ? store.authenticateAccountSession(selected.token, roomId, fence)
              : store.authenticate(selected.token, roomId, fence, { allowAccountSession: false });
            if (current.kind === "api-key") {
              const required = ["GET", "HEAD"].includes(req.method) ? "rooms:read" : "rooms:write";
              if (!(current.apiKeyScopes ?? []).some(scope => scope === required || (scope.endsWith(":*") && required.startsWith(scope.slice(0, -1))))) reject(403, "insufficient_scope", `API key lacks the ${required} scope`);
            }
            if (isGuestAgentMemberId(current.member.id) && !["GET", "HEAD"].includes(req.method)) reject(403, "guest_scope_denied", "Guest members cannot perform this action");
            return current;
          }, helpers: { json, reject, body } });
      }
      // Agent /feedback endpoint (task RC-2026-09-27-2745): structured
      // bug/feature reports with a Mark-staked triage economy, feeding the
      // claims board via severity-routed promotion. Shares the room funnel
      // above (credential, fence, rate-limit, API-key scopes); non-GET
      // routes enforce the caller's autonomy tier inside the handler. Guests
      // may read but never write, per the guest policy (they stay out of
      // claims-board participation; filing feedback is participation). The
      // literal segments (queue, notifications) resolve before the {id}
      // template so they are never mistaken for a feedback id (each regex
      // is anchored, so this is belt-and-braces).
      if (feedbackMatch) {
        const feedbackRoute = feedbackQueueMatch ? "queue"
          : feedbackNotificationsMatch ? "notifications"
          : feedbackAppealDecisionMatch ? "appeal-decision"
          : feedbackTriageMatch ? "triage"
          : feedbackAppealMatch ? "appeal"
          : feedbackOutcomeMatch ? "outcome"
          : feedbackBaseMatch ? (["GET", "HEAD"].includes(req.method) ? "list" : "submit")
          : "read";
        const feedbackIdMatch = feedbackTriageMatch ?? feedbackAppealMatch ?? feedbackOutcomeMatch ?? feedbackItemMatch;
        return await handleFeedback({ req, res, url, store, roomId, auth, feedbackRoute,
          feedbackId: feedbackIdMatch ? pathId(feedbackIdMatch[2]) : null,
          reauthorize: () => {
            const current = selected.mode === "account" ? store.authenticateAccountSession(selected.token, roomId, fence)
              : store.authenticate(selected.token, roomId, fence, { allowAccountSession: false });
            if (current.kind === "api-key") {
              const required = ["GET", "HEAD"].includes(req.method) ? "rooms:read" : "rooms:write";
              if (!(current.apiKeyScopes ?? []).some(scope => scope === required || (scope.endsWith(":*") && required.startsWith(scope.slice(0, -1))))) reject(403, "insufficient_scope", `API key lacks the ${required} scope`);
            }
            if (isGuestAgentMemberId(current.member.id) && !["GET", "HEAD"].includes(req.method)) reject(403, "guest_scope_denied", "Guest members cannot perform this action");
            return current;
          }, helpers: { json, reject, body } });
      }
      // Board v2 is retired. Authenticated callers get 410 and a pointer at
      // the work-claims board. The board_vtwo_* tables are not dropped.
      if (boardV2Match) {
        return json(res, 410, {
          error: { code: "board_v2_retired", message: "Board v2 is retired. Use the work-claims board." },
          next: [{ href: `/api/rooms/${boardV2Match[1]}/work-claims` }]
        });
      }
      // Escrowed bounties + credit ledger (agent work exchange, slice 1):
      // room-scoped bounty lifecycle and derived-balance credit routes share
      // the credential, fence and rate-limit checks above; the handler maps
      // escrow-module errors to stable 4xx codes. Credits are valueless
      // ledger units — no cash-out, no on-chain touch, no real money.
      if (bountyMatch || creditsMatch) {
        const escrowRoute = bountyListMatch ? (req.method === "GET" ? "list" : "create")
          : bountyFundMatch ? "fund" : bountyDeclineMatch ? "decline" : bountySnoozeMatch ? "snooze"
          : bountyDuplicateMatch ? "duplicate" : bountyWatchMatch ? "watch"
          : bountyClaimMatch ? "claim" : bountySubmitMatch ? "submit" : bountyAcceptMatch ? "accept"
          : bountyRejectMatch ? "reject"
          : bountyDisputeDecideMatch ? "dispute-decide" : bountyDisputeMatch ? "dispute"
          : bountyFinalizeMatch ? "finalize" : bountyRubricMatch ? "rubric"
          : bountyReviewsMatch ? "reviews"
          : bountySybilFlagsMatch ? "sybil-flags" : bountySybilDismissMatch ? "sybil-dismiss"
          : bountySybilConfirmMatch ? "sybil-confirm"
          : bountyReputationReviewsMatch ? "reputation-reviews"
          : creditsBalancesMatch ? "balances" : creditsHistoryMatch ? "history"
          : creditsTransferMatch ? "transfer" : "epoch-close";
        const bountyIdMatch = bountyFundMatch ?? bountyDeclineMatch ?? bountySnoozeMatch ?? bountyDuplicateMatch
          ?? bountyWatchMatch ?? bountyClaimMatch ?? bountySubmitMatch ?? bountyAcceptMatch ?? bountyRejectMatch
          ?? bountyDisputeDecideMatch ?? bountyDisputeMatch ?? bountyFinalizeMatch ?? bountyRubricMatch;
        const identityMatch = creditsBalancesMatch ?? creditsHistoryMatch;
        const sybilFlagIdMatch = bountySybilDismissMatch ?? bountySybilConfirmMatch;
        return await handleBountyEscrow({ req, res, url, store, roomId, auth, escrowRoute,
          bountyId: bountyIdMatch ? pathId(bountyIdMatch[2]) : null,
          sybilFlagId: sybilFlagIdMatch ? pathId(sybilFlagIdMatch[2]) : null,
          identity: identityMatch ? identityMatch[2] : null,
          reauthorize: () => {
            const current = selected.mode === "account" ? store.authenticateAccountSession(selected.token, roomId, fence)
              : store.authenticate(selected.token, roomId, fence, { allowAccountSession: false });
            if (selected.bearer && current.credentialScope !== "room") reject(403, "access_denied", "Bearer account sessions are not accepted");
            if (!selected.bearer && current.kind !== "session") reject(401, "unauthenticated", "Browser session required");
            if (current.kind === "api-key" && !(current.apiKeyScopes ?? []).some(scope =>
              scope === "rooms:write" || scope.endsWith(":*") && "rooms:write".startsWith(scope.slice(0, -1))))
              reject(403, "insufficient_scope", "API key lacks the rooms:write scope");
            if (isGuestAgentMemberId(current.member.id)) reject(403, "guest_scope_denied", "Guest members cannot perform this action");
            return current;
          }, helpers: { json, reject, body } });
      }
      if (route === "conversation" && req.method === "GET") {
        const params = url.searchParams;
        if ([...params.keys()].some(key => !["limit", "cursor", "since", "messageId", "channelId", "auth"].includes(key) || params.getAll(key).length !== 1)
          || params.has("limit") && !/^[1-9]\d*$/.test(params.get("limit"))) reject(422, "invalid_conversation_selection", "Choose a bounded conversation page or one message");
        return json(res, 200, readConversation(store, selected.token, roomId, {
          ...(params.has("limit") ? { limit: Number(params.get("limit")) } : {}),
          cursor: params.get("cursor"), since: params.get("since"), messageId: params.get("messageId"), channelId: params.get("channelId"), expectedSessionBinding: fence
        }));
      }
      if (route === "thread" && req.method === "GET") {
        // RC-2026-09-19-070: a DM thread root is invisible to non-participants
        // (404, like a missing message); DM replies inside a visible thread are dropped.
        const thread = store.messageThread(selected.token, roomId, threadMessageId, fence);
        if (!dmMessageVisible(thread.thread)) reject(404, "message_not_found", "Message not found");
        const stripDmReplies = message => ({ ...message,
          replies: (message.replies ?? []).filter(dmMessageVisible).map(stripDmReplies) });
        return json(res, 200, { ...thread, thread: redactMessageTree(stripDmReplies(thread.thread)) });
      }
      if (!route && req.method === "GET") {
        const params = url.searchParams;
        // `?messages=recent`: the full snapshot with only the newest
        // SNAPSHOT_RECENT_MESSAGES visible messages. A busy room's full
        // history (muse-room: 5,300+ messages, ~5 MB) no longer has to ship
        // on every open; older history pages through /conversation.
        const recentMessages = params.has("messages");
        if (recentMessages && (params.has("view") || params.get("messages") !== "recent"
          || [...params.keys()].some(key => !["messages", "auth"].includes(key) || params.getAll(key).length !== 1))) {
          reject(422, "invalid_snapshot_view", "Choose a supported snapshot view");
        }
        if (params.has("view") && (params.getAll("view").length !== 1 || params.get("view") !== "work"
          || [...params.keys()].some(key => !["view", "auth"].includes(key) || params.getAll(key).length !== 1))) {
          reject(422, "invalid_snapshot_view", "Choose a supported snapshot view");
        }
        const helpContext = req.headers["x-project-room-help-context"];
        if (helpContext !== undefined && (helpContext !== "1" || !params.has("view"))) reject(422, "invalid_help_context", "Choose version 1 with the current work view");
        const offerContext = req.headers["x-project-room-offer-context"];
        if (offerContext !== undefined && (offerContext !== "1" || params.has("view"))) reject(422, "invalid_offer_context", "Choose version 1 with the full room view");
        const snapshotView = params.has("view") ? "work" : "full";
        const snapshot = store.snapshot(selected.token, roomId, fence, snapshotView, helpContext === "1", offerContext === "1");
        if (snapshotView === "full") {
          // RC-2026-09-19-070: strip targeted DMs from both carriers in the
          // full snapshot — the audit tail (state.eventLog, the named P0) and
          // the live projection (state.messages, which the client renders as
          // the timeline). Pins reference messages by id, so pins of hidden
          // DMs are dropped too — otherwise the pin would reveal the DM's
          // existence. The work view carries none of these.
          const visibleMessages = (snapshot.state.messages ?? []).filter(dmMessageVisible);
          const visibleIds = new Set(visibleMessages.map(message => message.id));
          // The recent window trims after DM filtering, so hidden DMs never
          // count toward it; pins still follow every visible message.
          const windowed = recentMessages ? visibleMessages.slice(-SNAPSHOT_RECENT_MESSAGES) : visibleMessages;
          const nextState = { ...snapshot.state,
            messages: windowed,
            eventLog: (snapshot.state.eventLog ?? []).filter(roomEventVisible),
            pins: (snapshot.state.pins ?? []).filter(pin => visibleIds.has(pin.messageId)) };
          if (snapshot.state.bonds) nextState.bonds = visibleBonds(snapshot.state.bonds, peerContext);
          snapshot.state = redactSnapshotState(nextState);
          if (recentMessages) snapshot.messagesWindow = { mode: "recent", limit: SNAPSHOT_RECENT_MESSAGES,
            omitted: visibleMessages.length - windowed.length, older: "conversation" };
        }
        return json(res, 200, snapshot);
      }
      if (route === "outside-agents") {
        const network = new OutsideAgents(store);
        if (req.method === "GET") {
          if ([...url.searchParams.keys()].some(key => key !== "auth")) reject(422, "invalid_outside_agent", "This read takes no query filters");
          return json(res, 200, network.list(selected.token, roomId, fence));
        }
        if (req.method === "POST") {
          const data = await body(req);
          const allowed = { introduce: ["externalRef", "displayName", "origin", "reach", "note"], knows: ["fromRef", "toRef"], link: ["externalRef", "memberId"], verify: ["externalRef", "decision"] };
          if (!data || Array.isArray(data) || !Object.hasOwn(allowed, data.action) || Object.keys(data).some(key => key !== "action" && !allowed[data.action].includes(key)))
            reject(422, "invalid_outside_agent", "Choose introduce, knows, link or verify with public fields only");
          const { action, ...input } = data;
          const method = action === "introduce" ? "record" : action;
          return json(res, 200, network[method](selected.token, roomId, input, fence));
        }
        reject(405, "method_not_allowed", "Use GET or POST");
      }
      if (route === "request-runs") {
        if (req.method === "GET") return json(res, 200, store.requestRuns.list(selected.token, roomId, fence));
        if (req.method === "POST") return json(res, 200, store.requestRuns.apply(selected.token, roomId, await body(req), fence));
      }
      if (["reply-requests", "reply-context", "reply-history"].includes(route) && req.method === "GET") {
        const params = url.searchParams, names = route === "reply-requests" ? ["direction", "status"]
          : route === "reply-context" ? ["requestMessageId", "cursor", "limit"] : ["direction", "cursor", "checkpoint", "limit"];
        if ([...params.keys()].some(key => ![...names, "auth"].includes(key) || params.getAll(key).length !== 1)
          || params.has("limit") && !/^[1-9]\d*$/.test(params.get("limit"))) reject(422, "invalid_reply_selection", "Invalid request selection");
        const options = Object.fromEntries(names.filter(key => key !== "requestMessageId" && params.has(key)).map(key => [key, key === "limit" ? Number(params.get(key)) : params.get(key)]));
        options.expectedSessionBinding = fence;
        const value = route === "reply-requests" ? store.replyRequests.list(selected.token, roomId, options)
          : route === "reply-context" ? store.replyRequests.selected(selected.token, roomId, params.get("requestMessageId"), options)
          : store.replyRequests.history(selected.token, roomId, options);
        return json(res, 200, value);
      }
      if (route === "work-changes" && req.method === "GET") {
        // F3: derived read-time change list for one work item; never a write.
        const params = url.searchParams;
        if ([...params.keys()].some(key => !["workItemId", "since", "auth"].includes(key) || params.getAll(key).length !== 1)
          || !params.has("workItemId") || params.has("since") && !/^(0|[1-9]\d*)$/.test(params.get("since"))) reject(422, "invalid_history_selection", "Choose a work item and optional basis revision");
        return json(res, 200, store.workItemHistory(selected.token, roomId, params.get("workItemId"), fence, params.has("since") ? Number(params.get("since")) : null));
      }
      if (route === "charter" && req.method === "GET") {
        const params = url.searchParams;
        if ([...params.keys()].some(key => !["revision", "auth"].includes(key) || params.getAll(key).length !== 1)
          || params.has("revision") && !/^(0|[1-9]\d*)$/.test(params.get("revision"))) reject(422, "invalid_charter_revision", "Choose an instructions version");
        return json(res, 200, store.charter(selected.token, roomId, { ...(params.has("revision") ? { revision: Number(params.get("revision")) } : {}), expectedSessionBinding: fence }));
      }
      if (route === "work-context" && req.method === "GET") {
        const params = url.searchParams;
        const offerContext = req.headers["x-project-room-offer-context"];
        if (offerContext !== undefined && offerContext !== "1") reject(422, "invalid_offer_context", "Choose offer context version 1");
        if ([...params.keys()].some(key => !["workItemId", "includeSource", "auth"].includes(key) || params.getAll(key).length !== 1)
          || (params.has("includeSource") && !["true", "false"].includes(params.get("includeSource")))) {
          reject(422, "invalid_work_context", "Choose one work ID and an optional source inclusion flag");
        }
        return json(res, 200, store.workContext(selected.token, roomId, params.get("workItemId"), {
          includeSource: params.get("includeSource") === "true", includeOffers: offerContext === "1", expectedSessionBinding: fence
        }));
      }
      if (route === "work-result" && req.method === "GET") {
        const params = url.searchParams;
        if ([...params.keys()].some(key => !["workItemId", "completionEventId", "draftMessageId", "auth"].includes(key) || params.getAll(key).length !== 1)) reject(422, "invalid_result_selection", "Invalid result selection");
        return json(res, 200, store.workResult(selected.token, roomId, params.get("workItemId"), {
          completionEventId: params.get("completionEventId"), draftMessageId: params.get("draftMessageId"), expectedSessionBinding: fence
        }));
      }
      if (route === "capabilities" && req.method === "GET") {
        const search = url.searchParams.get("search");
        return json(res, 200, store.capabilities(selected.token, roomId, { search, expectedSessionBinding: fence }));
      }
      // ROOM ACTIVATION PACK — quill lane: one machine-readable fetch giving
      // an agent everything it needs to start working (roster, open work with
      // claim state, pins, participation rules, coordination norms, event
      // cursor). Rides the standard room credential funnel above; unknown
      // rooms answer 404 room_not_found from the store.
      if (route === "activation-pack" && req.method === "GET") {
        return json(res, 200, buildActivationPack(store, roomId, viewerId));
      }
      // ORIENT — jill lane RC-2026-09-28 (ryska's 404): the URL outside
      // agents guess by analogy with /activation-pack. Read-only,
      // member-scoped orientation: contract version, authenticated member
      // and scope, room summary, evaluated-through sequence, and a bounded
      // list of open work records with their next steps. Rides the standard
      // room credential funnel above; unknown rooms answer 404
      // room_not_found from the store.
      if (route === "orient" && req.method === "GET") {
        const params = url.searchParams;
        const allowed = new Set(["focus", "q", "maxTokens", "auth", "binding"]);
        if ([...params.keys()].some(key => !allowed.has(key) || params.getAll(key).length !== 1)) {
          reject(422, "invalid_orient", "focus, q, and maxTokens are the orient query parameters");
        }
        return json(res, 200, buildOrient(store, roomId, viewerId, {
          focus: params.get("focus"), q: params.get("q"), maxTokens: params.get("maxTokens"),
          token: selected.token, binding: fence
        }));
      }
      if (route === "verification-policy" && req.method === "GET") {
        // RC-2026-09-18-049: read the room's verified-agents gate policy.
        return json(res, 200, store.agentPlugin.roomVerificationPolicy(roomId));
      }
      if (route === "verification-policy" && req.method === "POST") {
        // RC-2026-09-18-049: whether the room only admits verified agents.
        // Deciding who may join is membership administration, so this takes
        // manage_members like the rest of it: the owner, or an admin the owner
        // appointed (#643). Enforcement happens in AgentIdentities.link.
        const data = await body(req);
        if (!exact(data, ["requireVerified"]) || typeof data.requireVerified !== "boolean") {
          reject(422, "invalid_policy", "requireVerified (boolean) is the only accepted field");
        }
        const authority = store.roomAuthority(roomId);
        if (!auth.member?.id || !memberCan(authority, auth.member.id, "manage_members")) {
          reject(403, "access_denied", "Membership administration grant required");
        }
        return json(res, 200, store.agentPlugin.setRoomVerificationPolicy({
          roomId, requireVerified: data.requireVerified, setBy: auth.member.id,
        }));
      }
      if (route === "search" && req.method === "GET") {
        // Round-2 #113: full-text search over messages and work items.
        const q = url.searchParams.get("q");
        const kind = url.searchParams.get("kind") ?? "all";
        const limitRaw = url.searchParams.get("limit");
        if (limitRaw !== null && (!/^[1-9]\d*$/.test(limitRaw) || Number(limitRaw) > 200)) {
          reject(422, "invalid_search", "limit is 1 to 200");
        }
        const before = url.searchParams.get("before");
        const result = store.search(selected.token, roomId, q, kind, fence, { limit: limitRaw === null ? 50 : Number(limitRaw), before });
        // RC-2026-09-19-070: search hits carry bodies but not toMemberId, so
        // re-resolve each hit against the projection and drop targeted DMs
        // the viewer is not a party to. Fail closed when a hit cannot be resolved.
        if (result.messages?.length) {
          const byId = new Map(store.room(roomId).state.messages.map(message => [message.id, message]));
          result.messages = result.messages.filter(hit => {
            const message = byId.get(hit.id);
            return message ? dmMessageVisible(message) : false;
          });
        }
        return json(res, 200, result);
      }
      if (route === "usage" && req.method === "GET") {
        // F5: read-only per-room usage summary. Member-visible like the
        // sibling dashboards: every figure derives from data a member can
        // already read (membership snapshot, work-session spend, events).
        const params = url.searchParams;
        if ([...params.keys()].some(key => !["days", "auth"].includes(key) || params.getAll(key).length !== 1)) reject(422, "invalid_usage_period", "Choose an optional number of days only");
        return json(res, 200, roomUsageSummary(store, selected.token, roomId, { days: parseUsageDays(params.get("days")), expectedSessionBinding: fence }));
      }
      if (route === "pins") {
        // Issue #6 B2: pinned messages. GET lists the ordered pins; POST pins or unpins one message (server/pins.mjs).
        // RC-2026-09-19-070: pin views carry message bodies, so pins of
        // targeted DMs the viewer is not a party to are dropped (and the
        // count recomputed) — otherwise the pin would leak the DM's body,
        // existence, and count. Fail closed when a pin cannot be resolved.
        const stripHiddenPinTargets = value => {
          const byId = new Map(store.room(roomId).state.messages.map(message => [message.id, message]));
          const pins = (value.pins ?? []).filter(pin => {
            const message = byId.get(pin.messageId);
            return message ? dmMessageVisible(message) : false;
          });
          return { ...value, pins, count: pins.length };
        };
        if (req.method === "GET") return json(res, 200, stripHiddenPinTargets(listPins(store, selected.token, roomId, fence)));
        if (req.method === "POST") {
          const result = setPin(store, selected.token, roomId, await body(req), fence);
          return json(res, result.changed ? 201 : 200, stripHiddenPinTargets(result)); // 201 when an event was appended, 200 when the room was already in that state or the requestId replayed
        }
        reject(405, "method_not_allowed", "Method not allowed");
      }
      // Typing heartbeats are served by the route table
      // (server/routes/typing.mjs); the SSE pump below emits synthetic
      // `typing` events.
      if (route === "provider-heartbeats" && req.method === "GET") {
        // Round-2 #118: provider heartbeat dashboard.
        return json(res, 200, store.providerHeartbeats(selected.token, roomId, fence));
      }
      if (route === "identity-links") {
        // Round-2 #101: multi-room agent identity links.
        const data = req.method === "GET" ? {} : await body(req);
        if (req.method === "GET") return json(res, 200, { roomId, links: store.identities.list(selected.token, roomId, fence) });
        if (req.method === "POST") {
          const keys = Object.keys(data);
          if (!keys.includes("identityId") || !keys.includes("permissions")
            || keys.some(k => !["identityId", "memberId", "displayName", "permissions"].includes(k))
            || typeof data.identityId !== "string") reject(422, "invalid_identity", "identityId and permissions are required");
          return json(res, 201, store.identities.link(selected.token, roomId, data, fence));
        }
        if (req.method === "DELETE") {
          if (!exact(data, ["identityId"]) || typeof data.identityId !== "string") reject(422, "invalid_identity", "identityId is required");
          return json(res, 200, store.identities.unlink(selected.token, roomId, data.identityId, fence));
        }
        reject(405, "method_not_allowed", "Method not allowed");
      }
      if (route === "agent-invites") {
        // One-time agent invite codes: owner-only issuance, audit, revocation.
        const data = req.method === "GET" ? {} : await body(req);
        if (req.method === "GET") return json(res, 200, { roomId, invites: store.invites.list(selected.token, roomId, fence) });
        if (req.method === "POST") {
          const keys = Object.keys(data);
          if ((!keys.includes("permissions") && !keys.includes("profile"))
            || keys.some(k => !["permissions", "profile", "expiresInMinutes", "displayName"].includes(k)))
            reject(422, "invalid_invite", "permissions or profile is required; optional: expiresInMinutes, displayName");
          return json(res, 201, store.invites.create(selected.token, roomId, data, fence,
            // Funnel: on a deployment without a configured mailer no account can
            // ever complete email verification, so the email_unverified gate
            // would deadlock invite mint permanently instead of nudging the
            // owner to verify. Where mail is configured the gate still applies.
            { emailVerificationUnachievable: !magicMailer.isConfigured() }));
        }
        if (req.method === "DELETE") {
          if (!exact(data, ["inviteId"]) || typeof data.inviteId !== "string") reject(422, "invalid_invite", "inviteId is required");
          return json(res, 200, store.invites.revoke(selected.token, roomId, data.inviteId, fence));
        }
        reject(405, "method_not_allowed", "Method not allowed");
      }
      if (route === "export" && req.method === "GET") {
        // Round-2 #106: JSONL export of the event log (same visibility as
        // the events route — members only). One {sequence, event} per line.
        // RC-2026-09-19-070: the events route filters targeted DMs to
        // sender+recipient, so the export applies the same filter here.
        // The log is bounded (10000 events per room, the same bound import
        // enforces), so the whole export is materialised before any header
        // is written: an auth, fence or storage failure part-way through
        // takes the normal JSON error path instead of truncating a 200 body
        // that would read as a valid, merely shorter, export. Content-Length
        // lets clients treat a dropped connection as an incomplete download.
        //
        // BUILD-01 F2: ?format=html renders the same event walk as one
        // self-contained document for people (server/room-export-html.mjs).
        // Same auth, same materialise-then-answer rule, same Content-Length
        // framing; the CSP header pins the document's single style block and
        // forbids everything else, so a browser that opens it inline runs
        // nothing.
        //
        // PRIV-2: owner-only. The export is materialised first, then the
        // room.exported audit record is appended, so a failed audit write
        // answers with an error instead of an unaudited download.
        requireExportOwner(store, roomId, viewerId, reject);
        const format = url.searchParams.get("format") ?? "jsonl";
        if (!["jsonl", "html"].includes(format) || url.searchParams.getAll("format").length > 1) reject(422, "invalid_format", "format is jsonl (default) or html");
        if (format === "html") {
          const rows = redactEventRows([...store.exportEvents(selected.token, roomId, fence)].filter(({ event }) => roomEventVisible(event)), projectionMessages(roomId));
          const bytes = Buffer.from(renderRoomExportHtml(rows, { roomId }), "utf8");
          recordRoomExport(store, selected.token, roomId, "html", fence); // PRIV-2
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": bytes.length,
            "Content-Security-Policy": EXPORT_HTML_CSP,
            "Content-Disposition": `attachment; filename="room-${roomId}-export.html"` });
          return res.end(bytes);
        }
        const lines = [];
        // R1 (export/import round-trip): the per-viewer filter can drop
        // targeted DMs the viewer cannot see, leaving sequence gaps in the
        // file; importEvents demands dense line.sequence === i + 1, so the
        // export renumbers the visible walk densely. Event bodies carry no
        // sequence (order + event ids are the stable references; import
        // rewrites dense row keys anyway), so renumbering is replay-safe
        // and keeps the export self-consistent for reimport.
        const visible = [];
        for (const line of store.exportEvents(selected.token, roomId, fence)) {
          if (!roomEventVisible(line.event)) continue;
          visible.push(line);
        }
        let exportSequence = 0;
        for (const line of redactEventRows(visible, projectionMessages(roomId))) {
          exportSequence += 1;
          lines.push(JSON.stringify({ sequence: exportSequence, event: line.event }) + "\n");
        }
        const bytes = Buffer.from(lines.join(""), "utf8");
        recordRoomExport(store, selected.token, roomId, "jsonl", fence); // PRIV-2
        res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Content-Length": bytes.length,
          "Content-Disposition": `attachment; filename="room-${roomId}-export.jsonl"` });
        return res.end(bytes);
      }
      if (route === "import" && req.method === "POST") {
        // Round-2 #107: NDJSON import (the #106 export format). Owner-only,
        // replaces room history. 8MB cap — larger restores go through backup.
        if (!/^application\/x-ndjson/i.test(req.headers["content-type"] || "")) reject(415, "ndjson_required", "Use application/x-ndjson");
        const text = await readText(req, 8 * 1024 * 1024, () => new ServiceError(413, "too_large", "Import is too large; use database backup instead"));
        // Number lines before dropping blanks so the reported line matches the file.
        const lines = text.split("\n").map((l, i) => [l, i + 1]).filter(([l]) => l.trim()).map(([l, lineNumber]) => {
          try { return JSON.parse(l); } catch { reject(422, "invalid_import", `Line ${lineNumber} is not valid JSON`); }
        });
        return json(res, 200, store.importEvents(selected.token, roomId, lines, fence));
      }
      if (route === "presence" && req.method === "GET") {
        const watchers = [...streams].filter(entry => entry.roomId === roomId).map(entry => entry.memberId);
        return json(res, 200, store.presence(selected.token, roomId, watchers, fence));
      }
      if (route === "work-sessions" && req.method === "GET") {
        const params = url.searchParams;
        if ([...params.keys()].some(key => !["status", "auth"].includes(key) || params.getAll(key).length !== 1)
          || (params.has("status") && !isSessionStatus(params.get("status")))) {
          reject(422, "invalid_session_status", "Choose one session status");
        }
        return json(res, 200, store.workSessions(selected.token, roomId, {
          status: params.get("status"), expectedSessionBinding: fence
        }));
      }
      if (route === "work-sessions" && req.method === "POST") {
        const result = store.mutateWorkSession(selected.token, roomId, await body(req), fence);
        return json(res, result.duplicate ? 200 : 201, result);
      }
      if (route === "spend-allowance" && req.method === "GET") {
        // C3: room spend allowance with spent, reserved and headroom. Member-readable: derived from work-session state members already see.
        if ([...url.searchParams.keys()].some(key => key !== "auth")) reject(422, "invalid_spend_allowance", "This read takes no parameters");
        return json(res, 200, readSpendAllowance(store, selected.token, roomId, fence));
      }
      if (route === "spend-allowance" && req.method === "POST") {
        const result = setSpendAllowance(store, selected.token, roomId, await body(req), fence); // owner-only (403 owner_required)
        return json(res, result.duplicate ? 200 : 201, result);
      }
      if (route === "operator-agent" && req.method === "GET") {
        // Graduated autonomy tiers read. Owner-only (403 owner_required for anyone else).
        return json(res, 200, getAgentAutonomyTier(store, selected.token, roomId, pathId(operatorAgentMatch[2]), fence));
      }
      if (route === "operator-agent" && req.method === "PUT") {
        // Graduated autonomy tiers write (promotion / instant demotion). Owner-only (403 owner_required for anyone else).
        const result = setAgentAutonomyTier(store, selected.token, roomId, pathId(operatorAgentMatch[2]), await body(req), fence);
        return json(res, 200, result);
      }
      if (route === "agent-grants" && req.method === "GET") {
        // UFO-steal slice 1: list grant edges. Owner or grants:issue delegate (403 otherwise).
        return json(res, 200, listAgentGrants(store, selected.token, roomId, fence));
      }
      if (route === "agent-grants" && req.method === "POST") {
        // UFO-steal slice 1: issue a grant edge. Owner or grants:issue delegate;
        // tier-gated and guest-denied inside. Guests can never hold edges (422).
        const result = issueAgentGrant(store, selected.token, roomId, await body(req), fence);
        return json(res, 201, result);
      }
      if (route === "agent-grant-delete" && req.method === "DELETE") {
        // UFO-steal slice 1: revoke a grant edge (stamps revoked_at). Idempotent.
        return json(res, 200, revokeAgentGrant(store, selected.token, roomId,
          pathId(agentGrantDeleteMatch[2]), pathId(agentGrantDeleteMatch[3]), fence));
      }
      if (route === "agent-capabilities" && req.method === "GET") {
        // UFO-steal slice 1: the caller's own effective capability set — live
        // grant edges resolved per request at this trust boundary, so an edge
        // issued mid-serve shows up without a restart. Guest denials applied.
        return json(res, 200, getAgentCapabilities(store, selected.token, roomId, fence));
      }
      if (route === "work-discussion" && req.method === "GET") {
        const params = url.searchParams;
        if ([...params.keys()].some(key => !["workItemId", "cursor", "since", "limit", "auth"].includes(key) || params.getAll(key).length !== 1)
          || ["since", "limit"].some(key => params.has(key) && !/^(0|[1-9]\d*)$/.test(params.get(key)))) reject(422, "invalid_discussion", "Use workItemId (not taskId), optional limit from 1 to 50, and either cursor or since. Supply each parameter once; since must be a non-negative integer.");
        const discussion = store.workDiscussion(selected.token, roomId, params.get("workItemId"), {
          cursor: params.get("cursor"), ...(params.has("since") ? { since: Number(params.get("since")) } : {}),
          ...(params.has("limit") ? { limit: Number(params.get("limit")) } : {}), expectedSessionBinding: fence
        });
        // RC-2026-09-19-070: DM visibility is enforced inside
        // selectedWorkDiscussion (before paging), so page boundaries,
        // hasMore, cursors, rowBytes and participants reveal nothing about
        // DMs the viewer is not a party to.
        return json(res, 200, discussion);
      }
      if (route === "reminders" && req.method === "GET") return json(res, 200, store.reminders.list(selected.token, roomId, fence));
      if (route === "notifications" && req.method === "GET") {
        // B4: per-member feed derived from the event tail after the member's cursor. Read model only; the
        // store method re-authenticates membership, and the read rate limit above already covers it.
        const params = url.searchParams;
        if ([...params.keys()].some(key => !["limit", "before", "auth"].includes(key) || params.getAll(key).length !== 1)) reject(422, "invalid_notification_selection", "Choose an optional limit and before sequence");
        if (params.has("limit") && !/^[1-9]\d*$/.test(params.get("limit"))) reject(422, "invalid_notification_limit", "Choose a positive limit");
        if (params.has("before") && !/^[1-9]\d*$/.test(params.get("before"))) reject(422, "invalid_notification_selection", "Choose a positive before sequence");
        return json(res, 200, store.notifications.list(selected.token, roomId, fence, {
          ...(params.has("limit") ? { limit: Number(params.get("limit")) } : {}),
          ...(params.has("before") ? { before: Number(params.get("before")) } : {})
        }));
      }
      if (route === "agent-connections" && req.method === "GET") return json(res, 200, store.agentConnections.list(selected.token, roomId, fence));
      if (route === "activity" && req.method === "GET") {
        // Attention: personal activity feed (write-time fan-out). Query:
        // before (exclusive event id), limit (1..100), type (one of the four
        // activity types). Read model; the store function re-authenticates.
        const params = url.searchParams;
        if ([...params.keys()].some(key => !["limit", "before", "type", "auth"].includes(key) || params.getAll(key).length !== 1)) reject(422, "invalid_activity_selection", "Choose an optional limit, before, and type");
        return json(res, 200, listActivity(store, selected.token, roomId, {
          ...(params.has("limit") ? { limit: params.get("limit") } : {}),
          ...(params.has("before") ? { before: params.get("before") } : {}),
          ...(params.has("type") ? { type: params.get("type") } : {})
        }, fence));
      }
      if (route === "activity-unread-count" && req.method === "GET") {
        return json(res, 200, activityUnreadCount(store, selected.token, roomId, fence));
      }
      if (route === "activity-read" && req.method === "POST") {
        return json(res, 200, markActivityRead(store, selected.token, roomId, await body(req), fence));
      }
      if (route === "activity-read-all" && req.method === "POST") {
        return json(res, 200, markActivityReadAll(store, selected.token, roomId, await body(req), fence));
      }
      if (route === "read-horizon" && req.method === "GET") {
        const params = url.searchParams;
        if ([...params.keys()].some(key => !["threadId", "auth"].includes(key) || params.getAll(key).length !== 1)) reject(422, "invalid_horizon", "Choose an optional threadId");
        return json(res, 200, getReadHorizon(store, selected.token, roomId, {
          ...(params.has("threadId") ? { threadId: params.get("threadId") } : {})
        }, fence));
      }
      if (route === "read-horizon" && req.method === "POST") {
        return json(res, 200, setReadHorizon(store, selected.token, roomId, await body(req), fence));
      }
      if (route === "saved" && req.method === "GET") {
        return json(res, 200, listSaved(store, selected.token, roomId, fence));
      }
      if (route === "saved" && (req.method === "POST" || req.method === "DELETE")) {
        // Save (POST {messageId, saved:true}) or unsave (DELETE {messageId}).
        const data = await body(req);
        if (req.method === "DELETE") return json(res, 200, setSaved(store, selected.token, roomId, { messageId: data.messageId, saved: false }, fence));
        return json(res, 200, setSaved(store, selected.token, roomId, data, fence));
      }
      if (route === "saved-delete" && req.method === "DELETE") {
        // DELETE /api/rooms/:roomId/saved/:messageId — unsave one message.
        return json(res, 200, setSaved(store, selected.token, roomId, { messageId: savedDeleteMessageId, saved: false }, fence));
      }
      // Thread mutes are served by the canonical store.threadMutes module
      // (GET list + POST set below); the activity fan-out reads the same
      // thread_mutes table for thread_reply suppression.
      if (route === "diagnostics" && req.method === "GET") {
        store.agentConnections.owner(selected.token, roomId, fence);
        return json(res, 200, { diagnostics: diagnostics.list(roomId) });
      }
      if (route === "diagnostics-export" && req.method === "GET") {
        // W4-57 M6: sanitized support-export bundle. Owner-only, but accepts the
        // owner's room bearer as well as a signed-in account session, so the
        // CLI (bearer-only) can pull it. Whitelisted scalar fields only — no
        // credentials, hashes, bodies, or member details.
        const exportAuth = store.authenticate(selected.token, roomId, fence);
        if (exportAuth.member.kind !== "human" || exportAuth.member.id !== store.room(roomId).state.room.ownerId
          || !exportAuth.member.permissions.includes("manage_members")) {
          reject(403, "owner_required", "Only the room owner can export diagnostics");
        }
        const bundle = supportExportBundle({ roomId, roomTitle: store.room(roomId).state.room.title,
          service: { sourceRevision: SOURCE_REVISION, buildId: BUILD_ID, mode: serviceMode, ...deploymentField },
          diagnostics: diagnostics.list(roomId) });
        res.setHeader("Content-Disposition", `attachment; filename="room-${roomId}-support-export.json"`);
        return json(res, 200, bundle);
      }
      if (route === "needs-attention" && req.method === "GET") {
        // #662: owner-only rollup of everything awaiting an owner decision.
        const shadow = url.searchParams.getAll("includeShadow");
        if (shadow.length > 1 || shadow.length === 1 && !["true", "false"].includes(shadow[0])) {
          return json(res, 422, { error: "invalid_attention_query", message: "includeShadow must be a single true or false value" });
        }
        return json(res, 200, attentionReport({ store, accessRequests }, selected.token, roomId, fence, Date.now(), { cursor: url.searchParams.get("cursor"), includeShadow: shadow[0] === "true" }));
      }
      if (route === "jev-shadow" && req.method === "GET") {
        // Jev-harness shadow-review surface (docs/JEV-GATES.md): owner-only,
        // read-only listing of recent shadow decisions with scores for hand
        // review. Shadow data is measurement, never membership — nothing here
        // mutates state.
        const params = url.searchParams;
        if ([...params.keys()].some(key => !["gate", "escalate", "limit"].includes(key) || params.getAll(key).length !== 1)) {
          reject(422, "invalid_jev_shadow_query", "gate, escalate and limit are the accepted query parameters");
        }
        const gate = params.get("gate");
        if (gate !== null && !["admission", "receipt"].includes(gate)) reject(422, "invalid_jev_shadow_query", "gate must be admission or receipt");
        const escalateParam = params.get("escalate");
        if (escalateParam !== null && !["true", "false"].includes(escalateParam)) reject(422, "invalid_jev_shadow_query", "escalate must be true or false");
        const limitParam = params.get("limit");
        const limit = limitParam === null ? 50 : Number(limitParam);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) reject(422, "invalid_jev_shadow_query", "limit must be 1..500");
        return json(res, 200, jevShadowReport({ store }, selected.token, roomId,
          { gate, escalate: escalateParam === null ? null : escalateParam === "true", limit }, fence));
      }
      if (route === "mentions" && req.method === "GET") {
        // #658: member-readable mention list. memberId defaults to the
        // caller; an owner may query another member (feeds #662's card).
        // view=receipts is the sender's copy: delivered, then read/acked.
        const params = url.searchParams;
        if ([...params.keys()].some(key => !["state", "after", "memberId", "auth", "view"].includes(key) || params.getAll(key).length !== 1)) {
          reject(422, "invalid_mention_query", "state, after, memberId and view are the accepted query parameters");
        }
        if (params.get("view") === "receipts") {
          if (params.has("state") || params.has("after") || params.has("memberId")) {
            reject(422, "invalid_mention_query", "view=receipts does not take state, after, or memberId");
          }
          return json(res, 200, listMentionReceipts(store, selected.token, roomId, fence));
        }
        if (params.has("view")) reject(422, "invalid_mention_query", "view must be receipts");
        return json(res, 200, store.listMentions(selected.token, roomId, {
          state: params.get("state"), after: params.get("after"), memberId: params.get("memberId"),
        }, fence));
      }
      if (route === "mention-ack" && req.method === "POST") {
        // #658: explicit mention acknowledgement. Member-only and
        // idempotent; acking someone else's mention is 403.
        return json(res, 200, store.acknowledgeMention(selected.token, roomId, mentionEventId, fence));
      }
      if (route === "mention-settings" && req.method === "POST") {
        // #658: owner-only mention timeout override for the room.
        const data = await body(req);
        if (!exact(data, ["timeoutMs"])) reject(422, "invalid_request", "timeoutMs is the accepted field");
        return json(res, 200, store.setMentionTimeout(selected.token, roomId, data.timeoutMs, fence));
      }
      if (route === "member-card" && req.method === "GET") {
        // plan-dir-card: a room member's directory card for the member
        // chip (owns[] + reach{}). Any room member may read it; visibility
        // is enforced in the store (private cards only to the owning
        // identity). 404 when the member has no card or the viewer may not
        // see it — never an existence oracle.
        const doc = store.agentPlugin.cardForMember({
          roomId, memberId: cardMemberId, viewerIdentityId: auth.identityId ?? null,
          // A2A v1.0 projection (interop/discoverability only); interfaces
          // omitted when the origin is not a public https URL.
          serviceOrigin: typeof origin === "string" && /^https:\/\/\S+$/.test(origin) ? origin : null,
        });
        if (!doc) reject(404, "unknown_card", "No directory card for this member");
        return json(res, 200, doc);
      }
      if (route === "directory-seed" && req.method === "POST") {
        // plan-dir-card: owner-only seeding of placeholder directory cards
        // for agent members that have none. Seeded cards are visibility
        // "room", provenance "seeded", unsigned; the agent replaces its seed
        // by publishing a signed card.
        return json(res, 200, store.agentPlugin.seedRoomDirectoryCards({ roomId, ownerMemberId: auth.member.id }));
      }
      if (route === "member-deactivate" && req.method === "DELETE") {
        // RC-2026-09-23: self-deactivation. The caller names its own member
        // id; naming anyone else is 403. Emits member.access_changed with
        // active:false through the event-sourced path (the self-leave
        // branch of changeMemberAccess skips the manage_members gate, and
        // the owner invariant still holds — the owner cannot self-deactivate).
        // The identity link is kept: identity is not deleted, only the
        // membership becomes inactive.
        if (deactivateMemberId !== auth.member.id) reject(403, "access_denied", "You can only deactivate your own membership");
        const member = auth.member;
        // Note: a second DELETE never reaches here — after deactivation the
        // credential no longer authenticates (401). The active check below
        // is defensive only.
        if (member.active === false) reject(409, "already_inactive", "Membership is already inactive");
        if (store.roomAuthority(roomId).ownerId === member.id)
          reject(403, "owner_cannot_deactivate", "The room owner cannot deactivate its own membership; transfer ownership first");
        const result = store.command(selected.token, roomId, {
          id: randomUUID(), type: "member.access_changed",
          data: { memberId: member.id, expectedMemberRevision: member.revision, permissions: member.permissions, active: false }
        }, fence);
        return json(res, 200, { roomId, memberId: member.id, active: false, sequence: result.sequence });
      }
      if (route === "open-questions" && req.method === "GET") {
        // F1: open-questions radar — unanswered "?" messages room-wide, DM-scoped
        // to the caller's parties. Read model; the store function re-authenticates.
        const params = url.searchParams;
        if ([...params.keys()].some(key => !["limit", "auth"].includes(key) || params.getAll(key).length !== 1)) reject(422, "invalid_open_questions_selection", "Choose an optional limit");
        return json(res, 200, listOpenQuestions(store, selected.token, roomId, {
          ...(params.has("limit") ? { limit: params.get("limit") } : {})
        }, fence));
      }
      // Per-thread mutes: private per-member suppression of a thread's
      // activity from the notification/unread feed. GET lists the caller's
      // muted thread-root ids; POST {threadId, muted} mutes or unmutes
      // (threadId may be any message in the thread; it resolves to the root).
      if (route === "thread-mutes" && req.method === "GET") {
        return json(res, 200, store.threadMutes.list(selected.token, roomId, fence));
      }
      if (route === "thread-mutes" && req.method === "POST") {
        const data = await body(req);
        if (!exact(data, ["threadId", "muted"])) reject(422, "invalid_thread_mute", "threadId and muted are the accepted fields");
        return json(res, 200, store.threadMutes.set(selected.token, roomId, data, fence));
      }
      if (route === "agent-pause" && req.method === "GET") {
        // C6: wake-pause state for the caller, or (signed-in owner) one named
        // member plus the room's paused roster. Authorization is store-level.
        const params = url.searchParams;
        if ([...params.keys()].some(key => !["memberId", "auth"].includes(key) || params.getAll(key).length !== 1)) reject(422, "invalid_pause_selection", "Choose at most one member");
        return json(res, 200, store.wakeQueue.inspect(selected.token, roomId, { memberId: params.get("memberId") }, fence));
      }
      if (route === "agent-pause" && req.method === "POST") {
        // C6: pause or resume a member's queued wakes (own row, or owner over
        // another member). Draft class: nothing is sent, launched or spent.
        const data = await body(req);
        const fields = data.action === "resume" ? ["action", "memberId", "requestId"] : ["action", "memberId", "requestId", "reason"];
        if (!["pause", "resume"].includes(data.action) || !exact(data, fields) || typeof data.memberId !== "string") reject(422, "invalid_pause_command", "Supply action (pause or resume), memberId, requestId and, for pause, reason or null");
        const target = { memberId: data.memberId };
        const result = data.action === "pause" ? store.wakeQueue.pause(selected.token, roomId, { requestId: data.requestId, reason: data.reason }, fence, target)
          : store.wakeQueue.resume(selected.token, roomId, { requestId: data.requestId }, fence, target);
        return json(res, result.duplicate ? 200 : 201, result);
      }
      if (route === "access-review" && req.method === "GET") {
        // BUILD-01 D4: owner-only periodic access review; assembly lives in
        // server/access-review.mjs and is shared with scripts/access-review.mjs.
        return json(res, 200, accessReviewReport(store, selected.token, roomId, fence));
      }
      if (route === "access-requests" && req.method === "GET") {
        const status = url.searchParams.get("status") ?? "pending";
        const requests = accessRequests.list(selected.token, roomId, { status }, fence);        // RC-2026-09-18-056: an owner who sees a pending request but not
        // the decision path can't admit anyone — name the decide step.
        const next = requests.length > 0
          ? [Object.freeze({
              action: "decide-request",
              method: "POST",
              path: `/api/rooms/${roomId}/access-requests/${requests[0].requestId}/decide`,
              description: `Decide ${requests[0].displayName}'s request: send { decision: "approve", permissions: ${JSON.stringify(requests[0].requestedPermissions)}, note: null }. Use "deny" to refuse. Send your identity secret as the Bearer token.`,
            })]
          : [Object.freeze({
              action: "watch-requests",
              description: "No pending join requests. New requests from agents asking to join appear here.",
            })];
        return json(res, 200, { roomId, requests, next: Object.freeze(next) });
      }
      if (route === "referrals" && req.method === "GET") {
        // Member-visible referral board: newest-first join graph, plain
        // leaderboard by successful referrals, and the caller's own rows.
        // Authorization is store-level (Referrals.board); ids and display
        // names only, no credential data.
        return json(res, 200, store.referrals.board(selected.token, roomId, fence, {
          address: String(remoteAddress ?? ""),
          session: cookie(req, accountCookieName) || null,
        }));
      }
      if (route === "referral-invites" && req.method === "GET") {
        // Owner-only referral invite journal: every mint, redemption, and
        // policy rejection with the inviter identified. The invitee-facing
        // surfaces (preview, redeem, member events) never join against
        // this table, so the inviter stays hidden from invitees.
        // Authorization is store-level (ReferralInvites.list).
        return json(res, 200, store.referralInvites.list(selected.token, roomId));
      }
      if (route === "referral-invites" && req.method !== "GET") {
        reject(405, "method_not_allowed", "Method not allowed", { Allow: "GET" });
      }
      if (route === "access-decide" && req.method === "POST") {
        const data = await body(req);
        // Docs (and decide() below) treat permissions/note as optional; only
        // decision is required. Reject unknown fields, not missing optionals.
        const keys = Object.keys(data ?? {});
        if (!keys.includes("decision") || keys.some(k => !["decision", "permissions", "note"].includes(k))) {
          reject(422, "invalid_request", "decision is required; permissions and note are optional");
        }
        const decided = accessRequests.decide(selected.token, roomId, accessRequestId, data, fence);
        // Jev-harness admission gate, shadow mode (docs/JEV-GATES.md): an
        // approved access request is an admission — score it, journal the
        // would-be decision, keep the approval unchanged.
        if (data.decision === "approve") {
          jevShadowAdmission("access-request:approve", { roomId, identityId: decided.identityId ?? null,
            displayName: decided.displayName ?? "", card: null });
        }
        return json(res, 200, decided);
      }
      // RC-2026-09-18-038: owner-granted membership administration for agent
      // identities. Grant/revoke/list are owner-only; a grant lets the
      // holder's identity list and decide access requests (see
      // server/membership-delegation.mjs). The holder cannot grant further.
      if (route === "delegation-list" && req.method === "GET") {
        return json(res, 200, { roomId, grants: store.delegation.list(selected.token, roomId, fence) });
      }
      if (route === "delegation-grant" && req.method === "POST") {
        const data = await body(req);
        if (!exact(data, ["identityId"])) reject(422, "invalid_request", "identityId is the accepted field");
        return json(res, 200, store.delegation.grant(selected.token, roomId, data, fence));
      }
      if (route === "delegation-revoke" && req.method === "POST") {
        const data = await body(req);
        if (!exact(data, ["identityId"])) reject(422, "invalid_request", "identityId is the accepted field");
        return json(res, 200, store.delegation.revokeEffective(selected.token, roomId, data, fence));
      }
      // Owner delegates (server/owner-delegates.mjs): per-room grants that
      // let an agent identity act with the owner's authority. Grant, revoke,
      // and list are owner-only; the holder can never grant further.
      if (route === "owner-delegate-list" && req.method === "GET") {
        return json(res, 200, { roomId, grants: store.ownerDelegates.list(selected.token, roomId, fence) });
      }
      if (route === "owner-delegate-grant" && req.method === "POST") {
        const data = await body(req);
        if (!exact(data, ["identityId"])) reject(422, "invalid_request", "identityId is the accepted field");
        return json(res, 200, store.ownerDelegates.grant(selected.token, roomId, data, fence));
      }
      if (route === "owner-delegate-revoke" && req.method === "POST") {
        const data = await body(req);
        if (!exact(data, ["identityId"])) reject(422, "invalid_request", "identityId is the accepted field");
        return json(res, 200, store.ownerDelegates.revoke(selected.token, roomId, data, fence));
      }
      if (route === "ownership-transfer" && req.method === "POST") {
        // Agent room ownership, appointment path: the current room owner
        // appoints another member (human or agent) as owner. Owner-only;
        // the ownership.transferred event is auditable and reversible.
        // reason is optional; toMemberId is required.
        const data = await body(req);
        if (!exact(data, ["toMemberId"]) && !exact(data, ["toMemberId", "reason"])) {
          reject(422, "invalid_request", "toMemberId and an optional reason are the accepted fields");
        }
        return json(res, 200, agentRooms.transfer(selected.token, roomId, data, fence));
      }
      if (route === "agent-connections" && req.method === "POST") {
        const result = store.agentConnections.apply(selected.token, roomId, await body(req), fence);
        return json(res, result.duplicate ? 200 : 201, result);
      }
      if (route === "guest-agent-links" && req.method === "POST") {
        rate(`guest-agent-mint:${remoteAddress}`, 30);
        const result = store.guestAgentLinks.mint(selected.token, roomId, await body(req), fence);
        return json(res, result.duplicate ? 200 : 201, result);
      }
      // GX-… guest invites: owner-administered through the same room funnel
      // (store-level owner gate). Public preview/redeem/rotate live at the
      // top-level /api/guest-invites/* routes above.
      if (route === "guest-invites" && req.method === "POST") {
        rate(`guest-invite-mint:${remoteAddress}`, 30);
        const result = store.guestInvites.mint(selected.token, roomId, await body(req), fence);
        return json(res, result.duplicate ? 200 : 201, result);
      }
      if (route === "guest-invites-list" && req.method === "POST") {
        rate(`guest-invite-admin:${remoteAddress}`, 30);
        return json(res, 200, store.guestInvites.list(selected.token, roomId, fence));
      }
      if (route === "guest-invites-revoke" && req.method === "POST") {
        rate(`guest-invite-admin:${remoteAddress}`, 30);
        const data = await body(req);
        if (!exact(data, ["inviteId"]) || typeof data.inviteId !== "string") reject(422, "invalid_guest_invite", "Supply the invite id");
        return json(res, 200, store.guestInvites.revoke(selected.token, roomId, data.inviteId, fence));
      }
      if (route === "guest-invites-disconnect" && req.method === "POST") {
        rate(`guest-invite-admin:${remoteAddress}`, 30);
        const data = await body(req);
        if (!exact(data, ["memberId"]) || typeof data.memberId !== "string") reject(422, "invalid_guest_invite", "Supply the guest member id");
        return json(res, 200, store.guestInvites.disconnect(selected.token, roomId, data.memberId, fence));
      }
      if (route === "guest-invites-revoke-all" && req.method === "POST") {
        rate(`guest-invite-admin:${remoteAddress}`, 30);
        return json(res, 200, store.guestInvites.revokeAll(selected.token, roomId, fence));
      }
      if (route === "guest-invites-upgrade" && req.method === "POST") {
        rate(`guest-invite-admin:${remoteAddress}`, 30);
        const upgradeBody = await body(req);
        return json(res, 200, store.guestInvites.upgrade(selected.token, roomId, upgradeBody.memberId, upgradeBody.tier, fence));
      }
      if (route === "reminders" && req.method === "POST") {
        const result = store.reminders.mutate(selected.token, roomId, await body(req), fence);
        return json(res, result.duplicate ? 200 : 201, result);
      }
      // E4 moderation: any member reports a message (own receipt only); the owner alone lists reports.
      if (route === "reports" && req.method === "GET") return json(res, 200, store.moderation.list(selected.token, roomId, fence));
      if (route === "reports" && req.method === "POST") {
        const result = store.moderation.report(selected.token, roomId, await body(req), fence);
        return json(res, result.duplicate ? 200 : 201, result);
      }
      // Invitation links are administered from a signed-in browser session
      // (room-key or account cookie), or an owner/owner-appointed admin on its
      // agent identity bearer. Room keys presented as bearers remain excluded.
      if ((route === "share-links" || route === "share-links-cancel") && selected.bearer
        && !(auth.kind === "identity" && (store.roomAuthority(roomId).ownerId === auth.member?.id
          || auth.member?.delegatedAdmin === true && auth.member.permissions.includes("manage_members")))) {
        reject(403, "access_denied", "Invitation links require a signed-in browser session");
      }
      if (route === "share-links" && req.method === "GET") return json(res, 200, store.shareLinks.list(selected.token, roomId, fence));
      if (route === "share-links" && req.method === "POST") {
        const data = await body(req);
        const linkFields = ["requestId", "linkToken", "expiresAt", "maxJoins", "expectedMemberRevision"];
        if (!exact(data, linkFields) && !exact(data, [...linkFields, "access"])) reject(422, "invalid_link", "Supply the exact invitation link settings");
        // Same escape hatch as agent-invites: with no mailer, verification can never complete.
        const result = store.shareLinks.create(selected.token, roomId, data, fence, { emailVerificationUnachievable: !magicMailer.isConfigured() });
        return json(res, result.duplicate ? 200 : 201, result);
      }
      if (route === "share-links-cancel" && req.method === "POST") {
        const data = await body(req);
        if (!exact(data, ["linkId"])) reject(422, "invalid_link", "Select one invitation link to cancel");
        return json(res, 200, store.shareLinks.cancel(selected.token, roomId, data.linkId, fence));
      }
      // Consent-bound DMs: participants list/request their own directional
      // pairs; the owner sees pair metadata. The authenticated member is the
      // implicit actor — rows carry display handles plus the authoritative
      // member ids (display names are not unique per room).
      if (route === "dm-consents" && req.method === "GET") {
        return json(res, 200, store.dmConsents.list(roomId, auth.member.id));
      }
      if (route === "dm-consents" && req.method === "POST") {
        const data = await body(req);
        if (!(exact(data, ["targetId"]) || exact(data, ["targetId", "reason"]))) {
          reject(422, "invalid_dm_request", "targetId and an optional reason are the accepted fields");
        }
        const pair = store.dmConsents.request(roomId, auth.member.id, data.targetId, data.reason);
        // RC-2026-09-24-001: teach the consent loop at the source. The target
        // approves at the decide path (their own call — not a reverse POST,
        // which creates a duplicate pending row); the requester waits.
        return json(res, 201, {
          ...pair,
          next: Object.freeze([Object.freeze({
            action: "wait-for-approval",
            description: `The target (${data.targetId}) approves at POST /api/rooms/${roomId}/dm-consents/${auth.member.id}/decide with { decision: "approve" | "reject" | "block" }. Only they can decide — your reverse POST would create a duplicate pending row, not an approval.`,
          })]),
        });
      }
      if (route === "dm-consent-decide" && req.method === "POST") {
        const data = await body(req);
        if (!exact(data, ["decision"])) reject(422, "invalid_dm_decision", "decision is the accepted field");
        return json(res, 200, store.dmConsents.decide(roomId, auth.member.id, dmRequesterId, data.decision));
      }
      if (route === "dm-consent-block" && req.method === "POST") {
        const data = await body(req);
        if (!exact(data, ["peerId"])) reject(422, "invalid_dm_block", "peerId is the accepted field");
        return json(res, 200, store.dmConsents.block(roomId, auth.member.id, data.peerId));
      }
      if (route === "dm-consent-revoke" && req.method === "POST") {
        const data = await body(req);
        if (!exact(data, ["peerId"])) reject(422, "invalid_dm_revoke", "peerId is the accepted field");
        return json(res, 200, store.dmConsents.revoke(roomId, auth.member.id, data.peerId));
      }
      if (route === "dm-consent-unblock" && req.method === "POST") {
        const data = await body(req);
        if (!exact(data, ["peerId"])) reject(422, "invalid_dm_unblock", "peerId is the accepted field");
        return json(res, 200, store.dmConsents.unblock(roomId, auth.member.id, data.peerId));
      }
      // Public directory listing controls (#605): owner only (enforced in
      // the module). Status is visible to the owner alone; the public reads
      // the sanitized listing at GET /api/public/rooms/directory.
      if (route === "directory" && req.method === "GET") {
        return json(res, 200, store.roomDirectory.status(roomId, auth.member.id));
      }
      if (route === "directory" && req.method === "POST") {
        // Owner-only public-receipts toggle rides the directory route (the
        // room's public-visibility controls). discoverable stays required;
        // publicReceipts is an additive optional field. docs/openapi.yaml
        // documents the original {discoverable} shape only.
        const data = await body(req);
        const hasDiscoverable = Object.hasOwn(data ?? {}, "discoverable");
        const hasReceipts = Object.hasOwn(data ?? {}, "publicReceipts");
        if ((!hasDiscoverable && !hasReceipts)
          || Object.keys(data ?? {}).some(key => key !== "discoverable" && key !== "publicReceipts")
          || (hasDiscoverable && typeof data.discoverable !== "boolean")
          || (hasReceipts && typeof data.publicReceipts !== "boolean")) {
          reject(422, "invalid_directory", "discoverable (boolean) is required; publicReceipts (boolean) is optional");
        }
        if (hasDiscoverable) store.roomDirectory.set(roomId, auth.member.id, data.discoverable);
        if (hasReceipts) store.roomDirectory.setReceiptsVisibility(roomId, auth.member.id, data.publicReceipts);
        return json(res, 200, store.roomDirectory.status(roomId, auth.member.id));
      }
      // Owner-only opportunity-feed visibility, independent of directory
      // listing. The public feed reads the persisted bit, never this route.
      if (route === "opportunities" && req.method === "GET") {
        return json(res, 200, store.roomDirectory.opportunityStatus(roomId, auth.member.id));
      }
      if (route === "opportunities" && req.method === "POST") {
        const data = await body(req);
        if (!exact(data, ["enabled"]) || typeof data.enabled !== "boolean") {
          reject(422, "invalid_opportunities", "enabled (boolean) is the accepted field");
        }
        return json(res, 200, store.roomDirectory.setOpportunities(roomId, auth.member.id, data.enabled));
      }
      // Public-face controls: owner only (enforced in the module). Status is
      // visible to the owner alone; the public reads the face at /p/{code}.
      if (route === "public-face" && req.method === "GET") {
        return json(res, 200, store.publicFace.status(roomId, auth.member.id));
      }
      if (route === "public-face" && req.method === "POST") {
        const data = await body(req);
        if (!exact(data, ["enabled"]) || typeof data.enabled !== "boolean") {
          reject(422, "invalid_face", "enabled (boolean) is the accepted field");
        }
        return json(res, 200, data.enabled
          ? store.publicFace.enable(roomId, auth.member.id)
          : store.publicFace.disable(roomId, auth.member.id));
      }
      if (route === "public-face-rotate" && req.method === "POST") {
        return json(res, 200, store.publicFace.rotate(roomId, auth.member.id));
      }
      if (route === "context" && req.method === "GET") {
        const params = url.searchParams;
        if ([...params.keys()].some(key => !["since_version", "auth"].includes(key) || params.getAll(key).length !== 1)) {
          reject(422, "invalid_context_version", "since_version is the only context query parameter");
        }
        const context = store.roomContext(selected.token, roomId, {
          sinceVersion: params.has("since_version") ? params.get("since_version") : null, expectedSessionBinding: fence
        });
        if (context.not_modified) return json(res, 200, context);
        return json(res, 200, { ...context, orient: buildOrient(store, roomId, viewerId, { text: false, token: selected.token, binding: fence }) });
      }
      if (route === "bonds" && req.method === "GET") {
        return json(res, 200, { bonds: store.bonds.listForMember(roomId, auth.member.id) });
      }
      if (route === "peer-dms" && req.method === "GET") {
        return json(res, 200, { threads: store.bonds.listThreads(roomId, auth.member.id) });
      }
      if (route === "peer-dm-thread" && req.method === "GET") {
        return json(res, 200, store.bonds.readThread(roomId, auth.member.id, peerDmThreadId));
      }
      if (route === "events" && req.method === "GET") {
        const params = url.searchParams;
        // `afterSequence` is not a cursor. Ignoring it used to restart the
        // page at sequence 0, so an agent that thought it was caught up
        // reread the whole log. Refuse it and name `after`.
        if (params.has("afterSequence")) {
          reject(422, "invalid_event_cursor",
            "events uses the query parameter after (a sequence number), not afterSequence. Retry with after set to the last sequence you handled. A refused afterSequence is not a filter and does not mean you are caught up.");
        }
        if (params.has("tail")) {
          if ([...params.keys()].some(key => !["tail", "auth"].includes(key) || params.getAll(key).length !== 1)) {
            reject(422, "invalid_event_cursor", "tail is used alone, as an integer from 1 to 200");
          }
          const tail = Number(params.get("tail"));
          return json(res, 200, redactEventPage(readEventTail(store, selected.token, roomId, tail, fence), projectionMessages(roomId)));
        }
        return json(res, 200, redactEventPage(store.eventsAfter(selected.token, roomId,
          Number(params.get("after") || 0), Number(params.get("limit") || 100),
          { actor: params.get("actor"), since: params.get("since"), until: params.get("until"), expectedSessionBinding: fence }), projectionMessages(roomId)));
      }
      if (route === "agent-inbox" && req.method === "GET") {
        // RC-2026-09-18-012: agent-scoped unified inbox. Agent members only
        // (owner identity credential or a scoped rak_ key with inbox:read);
        // the human /api/inbox/* account-session surface is untouched.
        if (auth.member.kind !== "agent") reject(403, "agent_inbox_agent_only", "The agent inbox is for agent members");
        if (auth.kind === "api-key") {
          const granted = (auth.apiKeyScopes ?? []).some(scope =>
            scope === "inbox:read" || (scope.endsWith(":*") && "inbox:read".startsWith(scope.slice(0, -1))));
          if (!granted) reject(403, "insufficient_scope", "API key lacks the inbox:read scope");
        }
        const params = url.searchParams;
        if ([...params.keys()].some(key => !["limit", "auth"].includes(key) || params.getAll(key).length !== 1)
          || params.has("limit") && (!/^[1-9]\d*$/.test(params.get("limit")) || Number(params.get("limit")) > 200))
          reject(422, "invalid_inbox_selection", "Choose a limit of 1..200");
        return json(res, 200, store.agentInbox(selected.token, roomId, {
          limit: params.has("limit") ? Number(params.get("limit")) : 50, expectedSessionBinding: fence }));
      }
      if (route === "stream" && req.method === "GET") return stream(req, res, selected.token, roomId, Number(req.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0), auth, operationId);
      if (route === "commands" && req.method === "POST") {
        // RC-2026-09-23-100: per-guest message token bucket (chat spam
        // mitigation). The per-request scope gate in RoomStore#command is
        // the authority boundary; this is volume control.
        if (typeof selected.token === "string" && selected.token.startsWith(GUEST_AGENT_TOKEN_PREFIX)) {
          rate(`guest-post:${rateHash(selected.token)}`, 120);
        }
        const command = await body(req, { limit: MAX_MESSAGE_COMMAND_BYTES });
        // R1 delivery-path tracing (RC-2026-09-26-966): delivery.inbound spans
        // request receipt through store.command. Opt-in via TELEMETRY=true;
        // disabled tracers return null spans, so the default path pays nothing
        // and needs no branching. Only ids and the command type are recorded —
        // never bodies.
        const inboundSpan = getTracer().startSpan(SPAN_NAMES.INBOUND, { attributes: {
          [ATTR.ROOM_ID]: roomId, [ATTR.INGRESS]: "api" } });
        try {
          if (typeof command?.type === "string") inboundSpan.setAttribute(ATTR.EVENT_TYPE, command.type);
          const result = store.command(selected.token, roomId, command, fence);
          if (!result?.duplicate && result?.event?.type === "message.posted") clearBeat(typingBeats, roomId, result.event.actorId);
          const messageId = result?.event?.data?.messageId ?? result?.event?.id;
          if (typeof messageId === "string") inboundSpan.setAttribute(ATTR.MESSAGE_ID, messageId);
          inboundSpan.setAttribute(ATTR.OUTCOME, result?.duplicate ? "duplicate" : "ok");
          inboundSpan.setStatusOk();
          return json(res, result.duplicate ? 200 : 201, result);
        } catch (error) {
          inboundSpan.recordException(error);
          // G7 (#940): hand the refused command's type to the AX layer via a
          // symbol key (never serialized) so bond/dm field-shape errors can
          // enumerate the expected data shape. Codes/messages unchanged.
          if (error instanceof ServiceError && typeof command?.type === "string") error[ERROR_COMMAND_TYPE] = command.type;
          throw error;
        } finally {
          inboundSpan.end();
        }
      }
      if (route === "return-brief" && req.method === "GET") {
        const horizon = url.searchParams.get("horizon"), after = url.searchParams.get("after"), cursor = url.searchParams.get("cursor"), limit = url.searchParams.get("limit");
        const brief = store.returnBrief(selected.token, roomId, { horizon: horizon === null ? null : Number(horizon), after: after === null ? null : Number(after), cursor: cursor === null ? null : Number(cursor), limit: limit === null ? undefined : Number(limit), expectedSessionBinding: fence });
        if (brief?.history) brief.history.items = redactEventRows(brief.history.items, projectionMessages(roomId));
        return json(res, 200, brief);
      }
      if (route === "cursor" && req.method === "POST") {
        const data = await body(req);
        if (!exact(data, ["sequence"])) reject(422, "invalid_cursor", "Supply sequence only");
        return json(res, 200, store.markCaughtUp(selected.token, roomId, data.sequence, fence));
      }
      // #643: invitation administration admits the room owner by ID on any
      // credential (share-links-style owner-capability exemption, audited);
      // anyone else needs an account browser session, as before.
      const invitationOwnerActing = auth.member?.id === store.room(roomId).state.room.ownerId;
      if (route === "invitations" && req.method === "GET") {
        // Round-2 #108: invite-link analytics.
        if (!invitationOwnerActing && (selected.mode !== "account" || selected.bearer)) reject(403, "account_session_required", "Invitation administration requires an account browser session");
        return json(res, 200, store.invitationStats(selected.token, roomId, auth.sessionBinding));
      }
      if (route === "invitations" && req.method === "POST") {
        if (!invitationOwnerActing && (selected.mode !== "account" || selected.bearer)) reject(403, "account_session_required", "Invitation administration requires an account browser session");
        const data = await body(req);
        const fields = ["requestId", "invitationToken", "intendedAccountId", "intendedMemberId", "displayName", "role", "expiresAt", "expectedIssuerMemberRevision"];
        if (!exact(data, fields)) {
          // A cold agent follows room-create `next` with { profile } or
          // { permissions }. That body belongs on agent-invites; naming the
          // working route here is the recovery when the hint was missed.
          const agentShaped = data && typeof data === "object" && !Array.isArray(data)
            && ["profile", "permissions", "expiresInMinutes"].some(key => Object.hasOwn(data, key));
          if (agentShaped) reject(422, "invalid_invitation",
            `To invite a peer agent, POST /api/rooms/${roomId}/agent-invites with {"profile":"chat|contribute|review|collaborate"}. This route issues account-bound human invitations and needs exactly these fields: ${fields.join(", ")}.`);
          reject(422, "invalid_invitation", "Supply the exact invitation scope");
        }
        const result = store.issueInvitation(selected.token, roomId, { requestId: data.requestId, token: data.invitationToken, intendedAccountId: data.intendedAccountId, intendedMemberId: data.intendedMemberId, displayName: data.displayName, role: data.role, expiresAt: data.expiresAt, expectedIssuerMemberRevision: data.expectedIssuerMemberRevision, expectedSessionBinding: auth.sessionBinding });
        return json(res, result.duplicate ? 200 : 201, result);
      }
      if (route === "invitation-revoke" && req.method === "POST") {
        if (!invitationOwnerActing && (selected.mode !== "account" || selected.bearer)) reject(403, "account_session_required", "Invitation administration requires an account browser session");
        const data = await body(req);
        if (!exact(data, ["expectedRevision", "reason"])) reject(422, "invalid_invitation_change", "Invitation revision and reason required");
        return json(res, 200, store.revokeInvitation(selected.token, invitationId, { expectedRevision: data.expectedRevision, reason: data.reason, expectedSessionBinding: auth.sessionBinding, expectedRoomId: roomId }));
      }
      reject(405, "method_not_allowed", "Method not allowed");
    } catch (caught) {
      // Storage failures raised outside a store transaction take the same typed 503 and count toward readiness.
      const error = caught instanceof ServiceError ? caught : store.storageFailure?.(caught) ?? caught;
      if (res.headersSent) { res.end(); return; }
      if (error.status === 429) res.setHeader("Retry-After", "60");
      if (error.headers && typeof error.headers === "object") {
        for (const [name, value] of Object.entries(error.headers)) res.setHeader(name, String(value));
      }
      let roomId, workItemId;
      try {
        const parsed = new URL(req.url, expectedOrigin());
        parsed.pathname = rewriteRoomApiPrefix(parsed.pathname);
        const match = /^\/api\/rooms\/([^/]+)/.exec(parsed.pathname);
        if (match) {
          try { const id = decodeURIComponent(match[1]); if (validId(id)) roomId = id; } catch { /* ignore */ }
        }
        const selected = parsed.searchParams.get("workItemId");
        if (selected && validId(selected)) workItemId = selected;
      } catch { /* ignore */ }
      const httpStatus = error.status || 500;
      const code = error.code || "internal_error";
      const message = error.status ? error.message : "Service could not complete the request; no success is claimed";
      const category = errorCategory(httpStatus, code);
      const route = diagnosticRoute(req.url, roomId);
      if (route) {
        diagnostics.record({ operationId, at: new Date().toISOString(), status: httpStatus, code, category, route, roomId });
        console.warn(`room diagnostic ${operationId} ${httpStatus} ${code} ${category} ${route}`);
      } else if (httpStatus >= 500) {
        // Non-room 5xx (inbox, account session, login) still leave an operator trace.
        console.warn(`service diagnostic ${operationId} ${httpStatus} ${code} ${category} ${serviceRoute(req.url)}`);
      }
      if (httpStatus === 413) {
        // finish means handed to the OS, not received by the client. Drain
        // in-flight bytes without buffering, then half-close. The destroy
        // deadline re-arms while request bytes keep flowing (#976), so a
        // slow-but-alive upload is never cut off mid-flight and always gets
        // the readable too_large; only a sender that stops sending is
        // destroyed after the grace period.
        const socket = req.socket;
        res.once("finish", () => {
          if (socket.destroyed) return;
          let deadline = null;
          const clear = () => { if (deadline !== null) { clearTimeout(deadline); deadline = null; } };
          const drained = () => { clear(); if (!socket.destroyed) socket.end(); };
          if (req.complete) { drained(); return; }
          const arm = () => {
            clear();
            deadline = setTimeout(() => { deadline = null; socket.destroy(); }, 1000);
            deadline.unref();
          };
          const cleanup = () => { clear(); req.off("data", arm); };
          req.on("data", arm);
          req.once("end", () => { cleanup(); drained(); });
          req.once("aborted", () => { cleanup(); socket.destroy(); });
          socket.once("close", cleanup);
          arm();
        });
      }
      // Burs-IA steal A1: listed routes get route-aware hint/next guidance on
      // top of the canonical envelope; everything else keeps the existing body.
      let errorOverride = null;
      try {
        errorOverride = discoverabilityErrorOverride({ pathname: requestPathname(req.url), httpStatus, code });
      } catch { /* base envelope keeps its shape on parse failure */ }
      const errorBody = mergeErrorDetail(errorOverride
        ? { error: { code, message }, ...errorOverride, operationId, category }
        : { ...agentErrorBody({ httpStatus, code, message, roomId, workItemId, commandType: error[ERROR_COMMAND_TYPE] }), operationId, category },
      error.detail);
      json(res, httpStatus, errorBody);
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.closeStreams = () => { for (const { res } of streams) res.end(); };
  server.rateLimitKeys = () => rates.size;
  return server;
}
