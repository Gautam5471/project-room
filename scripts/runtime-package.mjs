// Offline exact-commit packaging. No dependency installation, upload or deployment.
// This verifier is standalone: it can be copied outside the source checkout.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, posix } from "node:path";
import { pathToFileURL } from "node:url";

const v8Assets = ["index.html", ...["app.js", "client.js", "events.js", "conversation.js", "workflow.js", "share-links.js",
  "return-brief.js", "work-selectors.js", "work-status.js", "work-packet.js", "portable-work.js", "reminders.js", "reminder-time.js", "styles.css"].map(name => "src/" + name)];
export const publicAssets = ["src/board-mine.js", "src/first-room-copy.js", "strings/en.js", "strings/en.json", "index.html", "project-room-mark.svg", "src/login-polish.css", "about.html", "offers.html", "src/project-offers-ui.js", "src/owner-project-offers-ui.js", "src/project-offers.css", "favicon.svg", "icon.svg", "manifest.webmanifest", "push-sw.js", "src/app.js", "src/strings.js", "src/human-experience.js", "src/human-experience.css", "src/member-display-names.js", "src/room-layout.js", "src/client.js", "src/events.js", "src/display-name-guard.js", "src/conversation.js", "src/workflow.js", "src/human-push.js", "src/human-push-display.js", "src/spend-pricing-ui.js", "src/polls.js", "src/share-links.js", "src/return-brief.js", "src/work-selectors.js", "src/work-status.js", "src/work-packet.js", "src/portable-work.js", "src/reminders.js", "src/reminder-time.js", "src/styles.css", "src/agent-connections.js", "src/room-charter.js", "src/room-instructions.js", "src/reply-requests.js", "src/work-help.js", "src/help-offers.js", "src/inbox-client.js", "src/inbox-ui.js", "src/inbox-quarantine-ui.js", "src/account-setup-ui.js", "src/gmail-ui.js", "src/inbox-send-ui.js", "src/room-roster.js", "src/account-settings-ui.js", "src/auth-signin-ui.js", "src/agent-signin-ui.js", "src/agent-first-run.js", "src/invite-context.js", "src/request-access.js", "src/room-deep-link.js", "src/browser-session.js", "src/composer-files.js", "src/session-expiry.js", "src/agent-invite-ui.js", "src/referral-board.js", "src/land-queue-board.js", "src/open-questions-ui.js", "src/retention-ui.js", "src/board-ui.js", "src/board-keyboard.mjs", "src/board.css", "src/squads-ui.js", "src/join.js", "src/join-watchdog.js", "src/work-item-session.js", "src/work-loops.js", "src/work-recipes.js", "src/chat-suggestions.js", "src/share-invite-code.js", "src/handoff-envelope-ui.js", "src/dm-consents.js", "src/friend-bond.js", "src/needs-attention.js", "src/updates-ui.js", "src/emoji.js", "src/emoji-catalog.js", "src/error-copy.js", "src/public-a11y.css", "connectors/muse.md", "compare/project-room-vs-slack.html", "compare/project-room-vs-discord.html", "compare/agent-collaboration-tool.html", "compare/multi-agent-workspace.html", "compare/ai-agent-coordination.html", "compare/project-room-vs-agent-room.html", "og/home.png", "og/fonts/Inter-Regular.ttf", "og/fonts/OFL.txt", "og/about.png", "og/offers.png", "og/compare.png", "og/receipts.png", "offline.html", "icons/icon-192.png", "icons/icon-512.png", "icons/maskable-512.png", "icons/apple-touch-icon-180.png", "src/pwa-install.js", "src/push-ask.js", "scripts/install.sh", "docs/agents/index.html", "docs/agents/paste.html", "docs/agents/claude-code.html", "docs/agents/codex.html", "docs/agents/cursor.html", "docs/agents/cline.html", "docs/agents/vscode.html", "docs/agents/aider.html", "docs/agents/openai-agents-sdk.html", "docs/agents/langgraph.html", "docs/agents/crewai.html", "examples/integrations/claude-code/README.md", "examples/integrations/codex/README.md", "examples/integrations/cursor/README.md", "examples/integrations/cline/README.md", "examples/integrations/vscode/README.md", "examples/integrations/aider/README.md", "examples/integrations/openai-agents-sdk/README.md", "examples/integrations/langgraph/README.md", "examples/integrations/crewai/README.md", "operator.html", "src/operator-ui.js", "src/operator.css"];// Read the selected source's explicit asset declaration, never today's list for
// an older schema. Parse only this repository's data-only array/spread/map shape;
// do not execute packaged JavaScript. Missing advertised assets remain errors.
function assetsFor(files) {
  const path = files.has("deploy/public-assets.mjs") ? "deploy/public-assets.mjs" : "cloudflare/build-assets.mjs";
  const name = path.startsWith("deploy/") ? "publicAssetPaths" : "assetPaths";
  const source = files.get(path)?.toString();
  const declaration = source?.match(new RegExp(`export const ${name} = ([\\s\\S]*?);`))?.[1];
  const expression = declaration?.startsWith("Object.freeze(") ? declaration.slice(14, -1) : declaration;
  const parts = expression?.match(/^\[(.*?)\.\.\.\[(.*?)\]\.map\(\s*(\w+)\s*=>\s*(["'])src\/\4\s*\+\s*\3\s*\)(.*?)\]$/s);
  check(parts, `${path} has an unsupported public asset declaration`);
  const literals = text => {
    const values = [...text.matchAll(/["']([A-Za-z0-9_./-]+)["']/g)].map(match => match[1]);
    check(!text.replace(/["'][A-Za-z0-9_./-]+["']/g, "").replace(/[\s,]/g, ""), `${path} has unsupported asset expressions`);
    return values;
  };
  const assets = [...literals(parts[1]), ...literals(parts[2]).map(file => "src/" + file), ...literals(parts[5])];
  check(assets.includes("index.html") && new Set(assets).size === assets.length && assets.every(asset => allowed.has(asset)), `${path} advertises invalid or unregistered assets`);
  return assets;
}
const required = [...v8Assets, "server.mjs", "package.json", "package-lock.json",
  ...["backup", "bootstrap", "claim-scopes", "deployment", "http", "invitation-evidence", "invitation-journal", "reminders",
    "return-brief", "return-selectors", "share-links", "store", "work-context", "writer-fence"].map(name => `server/${name}.mjs`),
  ...["room-agent", "assignment-watcher", "watch-journal"].map(name => `client/${name}.mjs`),
  ...["backup-room", "provision", "audit-invitations", "agent-inbox", "agent-watch"].map(name => `scripts/${name}.mjs`),
  ...["room.mjs", "storage.mjs", "bootstrap.mjs", "build-assets.mjs", "wrangler.jsonc", "package.json", "pnpm-lock.yaml"].map(name => "cloudflare/" + name)].sort();
// Historical v8 packages predate these files. Literal-import closure below makes
// them mandatory when the selected source imports them, without rewriting history.
const optional = ["server/diagnostics.mjs", "server/maintenance.mjs", "server/recovery.mjs", "client/agent-connection.mjs", "server/agent-connections.mjs", "src/agent-connections.js", "src/agent-error.mjs", "client/mcp-stdio.mjs", "client/work-preparation.mjs", "scripts/agent-mcp.mjs", "client/work-actions.mjs", "server/work-discussion.mjs", "server/text-results.mjs", "client/attention-inbox.mjs"];
optional.push("scripts/build-ui-strings.mjs", "src/strings.js", "strings/en.js", "strings/en.json");
optional.push("server/public-work-claims.mjs", "server/public-work-claim-fence.mjs", "client/public-work-claims.mjs");
optional.push("server/public-work-reviews.mjs", "server/mcp-public-work.mjs", "server/public-work-successors.mjs");
optional.push("src/audit-receipts.mjs", "src/outside-agents.mjs", "server/outside-agents.mjs", "scripts/outside-agents.mjs");
optional.push("src/room-charter.js", "src/room-instructions.js");
optional.push("src/reply-requests.js", "server/reply-requests.mjs");
optional.push("server/dm-consents.mjs", "server/public-face.mjs"); // consent-bound DMs + public face (imported by server/store.mjs)
optional.push("server/bonds.mjs"); // agent Bond + peer DMs (imported by server/store.mjs and server/http.mjs)
optional.push("server/membership-delegation-journal.mjs"); // append-only membership grant decisions
optional.push("server/room-directory.mjs"); // #605 opt-in public room directory (imported by server/store.mjs)
optional.push("offers.html", "src/project-offers-ui.js", "src/owner-project-offers-ui.js", "src/project-offers.css", "server/project-offers.mjs", "src/contribution-brief.js", "src/paid-work-offers.js");
optional.push("server/opportunities.mjs"); // opportunity feed v2: read-only open-work discovery (imported by server/http.mjs)
optional.push("server/conversation-sync.mjs"); // bounded viewer-scoped conversation reads (imported by server/http.mjs)
optional.push("src/curiosity-rank.mjs"); // curiosity sort for room_list_work (imported by server/mcp-room-profile.mjs)
optional.push("src/dm-consents.js"); // DM consent browser view-model + API helpers (imported by src/app.js)
optional.push("src/friend-bond.js"); // Friend / Bond People chrome (imported by src/app.js and src/client.js)
optional.push("src/error-copy.js"); // Human error copy (imported by src/client.js, src/friend-bond.js, src/operator-ui.js)
optional.push("src/room-layout.js", "src/member-display-names.js");
optional.push("src/needs-attention.js", "src/updates-ui.js"); // #662: owner "needs your attention" card (imported by src/app.js)
optional.push("src/emoji.js", "src/emoji-catalog.js"); // Unicode emoji catalog + reaction identity (imported by src/app.js, src/conversation.js, src/events.js)
optional.push("src/display-name-guard.js"); // Member display-name admission (imported by src/events.js and re-exported by server/display-name-guard.mjs)
optional.push("src/presence-state.js"); // #660: pure presence/working-state derivation (imported by server/store.mjs)
optional.push("client/reply-actions.mjs", "scripts/agent-replies.mjs", "client/request-runner.mjs", "client/host-process.mjs", "client/host-context-policy.mjs", "client/host-result.mjs", "client/host-subprocess.mjs", "client/host-verification.mjs", "client/agent-setup.mjs", "client/setup-journal.mjs", "scripts/connect-room.mjs", "scripts/run-room-request.mjs");
optional.push("client/codex-runtime.mjs", "client/codex-shared-assistant.mjs", "client/codex-stdio.mjs", "client/room-assistant-client.mjs", "scripts/run-codex-room.mjs", "docs/CODEX-ROOM-HOST.md");
optional.push("scripts/agent-doctor.mjs");
optional.push("scripts/bootstrap-agent-room.mjs");
optional.push("client/request-notices.mjs");
optional.push("src/work-help.js", "server/work-help.mjs");
optional.push("src/help-offers.js");
optional.push("client/help-actions.mjs");
optional.push("client/begin-work.mjs"); // selected-work Begin (imported by client/mcp-stdio.mjs and server/mcp-full-profile.mjs)
optional.push("client/bounty-tools.mjs"); // bounty tool surface (imported by server/mcp-full-profile.mjs; pure, no imports of its own)
optional.push("client/trust-tools.mjs"); // trust tool surface (imported by server/mcp-full-profile.mjs; pure, no imports of its own)
optional.push("server/inbox.mjs");
optional.push("server/inbox-search.mjs"); // full-text search index (imported by server/inbox.mjs; pure, no imports of its own)
optional.push("server/inbox-threads.mjs"); // thread builder (imported by server/inbox.mjs; pure, no imports of its own)
optional.push("server/inbox-stitch.mjs"); // stitch key derivation + scoring (imported by server/inbox.mjs and server.mjs; pure)
optional.push("server/inbox-stitch-store.mjs"); // hash-only stitch graph (imported by server/inbox.mjs; pure persistence, no imports beyond inbox-stitch.mjs)
optional.push("server/inbox-spam.mjs"); // spam/phishing flagging (imported by server/inbox-import-guards.mjs; pure, no imports of its own)
optional.push("server/notify-prefs.mjs"); // notification prefs + quiet hours (imported by server/inbox.mjs and server/inbox-import-guards.mjs; pure, no imports of its own)
optional.push("server/thread-mutes.mjs"); // per-thread mutes (imported by server/store.mjs; pure, no imports of its own)
optional.push("server/human-push.mjs"); // human browser push, mentions and DMs (imported by server/store.mjs)
optional.push("server/push-subscriptions.mjs", "server/web-push.mjs"); // browser push delivery (imported by server/human-push.mjs and cloudflare/room.mjs)
optional.push("src/human-push.js", "src/human-push-display.js", "push-sw.js"); // human push button, lock-screen text, and service worker
optional.push("server/inbox-import-guards.mjs"); // import-time spam/notify wiring (imported by server/inbox.mjs; pure, imports inbox-spam.mjs and notify-prefs.mjs)
optional.push("server/spam-shadow.mjs"); // shadow-mode auto-quarantine instrumentation (imported by server/inbox.mjs; pure, imports inbox-spam.mjs)
optional.push("server/spam-quarantine-journal.mjs"); // spam-guard quarantine journal (imported by server/store.mjs; imports ServiceError from store.mjs)
optional.push("server/quarantine-thread-splits.mjs"); // quarantine review thread-split journal (imported by server/store.mjs and server/inbox.mjs)
optional.push("server/quarantine-review-coverage.mjs"); // per-signal review-coverage dashboard (imported by server/inbox.mjs; pure, no imports of its own)
// NOTE: server/thread-tree.mjs stays OUT of the closure. inbox-threads.mjs
// already groups, nests, and flattens threads; importing both would duplicate
// the reply-tree logic. thread-tree.mjs remains available for a future
// collapse/expand UI slice.
optional.push("server/inbox-outbox.mjs", "server/inbox-transport.mjs", "server/version.mjs");
optional.push("server/jev-admission.mjs"); // Jev-harness admission gate (imported by server/http.mjs; pure, no imports of its own)
optional.push("server/jev-receipts.mjs"); // Jev-harness receipt gate (imported by server/work-claim-routes.mjs; pure, no imports of its own)
optional.push("server/required-reading.mjs"); // W012: per-lane required reading (imported by server/work-claim-routes.mjs; pure, imports server/work-claims.mjs)
optional.push("server/jev-shadow-journal.mjs"); // Jev shadow-decision journal (imported by server/store.mjs; imports ServiceError from server/service-error.mjs)
optional.push("server/service-error.mjs"); // shared ServiceError (imported by server/store.mjs — re-exported — and server/jev-shadow-journal.mjs; pure, no imports of its own)
optional.push("server/csv-export.mjs"); // structured CSV/JSON export (imported by server/inbox-outbox.mjs for the send-journal audit export; pure, no imports of its own)
optional.push("scripts/stamp-version.mjs");
optional.push("server/email-envelope.mjs", "server/graph-email.mjs", "server/email-import.mjs");
optional.push("server/graph-fixture-sync.mjs");
optional.push("server/graph-reply-draft.mjs");
optional.push("server/graph-reply-journal.mjs");
optional.push("server/graph-reply-update-review.mjs");
optional.push("src/inbox-client.js", "src/inbox-ui.js");
optional.push("src/inbox-quarantine-ui.js"); // quarantine review surface (imported by src/inbox-ui.js)
optional.push("src/inbox-send-ui.js");
optional.push("src/room-roster.js");
optional.push("deploy/public-assets.mjs", "deploy/public-search.mjs"); // Shared live manifest; historical packages predate it.
optional.push("deploy/agent-discovery.mjs", "deploy/room-entry.mjs", "server/guest-agent-links.mjs");
optional.push("deploy/agent-card-key.mjs", "deploy/agent-card-signed.mjs"); // RC-2026-09-23-105: room card signing key (public half) + build-time signature (imported by deploy/agent-discovery.mjs; pure)
optional.push("deploy/procedures-index.mjs"); // W008: baked shared-procedure index (imported by deploy/agent-discovery.mjs; generated by scripts/procedures-index.mjs, never hand-edited)
optional.push("server/guest-invites.mjs"); // RC-2026-09-23-100: GX-invite public handoff for external agents (imported by server/store.mjs + server/http.mjs)
optional.push("server/web-fetch.mjs"); // RC-2026-09-23-102: room-side web fetch (imported by server/store.mjs + server/http.mjs)
optional.push("server/web-research.mjs"); // RC-2026-09-24-310: knowledge router (imported by server/store.mjs; imports server/web-fetch.mjs)
optional.push("server/claim-validate.mjs"); // RC-2026-09-24-204: synchronous pre-post claim-block validation (imported by server/http.mjs; pure, no imports of its own)
optional.push("deploy/capabilities.mjs"); // #601: build-time route-family inventory (imported by deploy/agent-discovery.mjs)
optional.push("src/room-mcp-join.js", "src/share-invite-code.js", "src/handoff-envelope-ui.js", "server/mcp-http.mjs");
optional.push("src/mcp-server-card.mjs"); // one MCP server card rendered from the live tool lists
optional.push("server/mcp-hosted-tools.mjs"); // hosted MCP tool definitions (imported by server/mcp-room-profile.mjs and server/mcp-discovery.mjs)
optional.push("server/mcp-discovery.mjs"); // binds the server card to those live lists (imported by server/mcp-http.mjs and deploy/room-entry.mjs)
optional.push("server/mcp-arg-errors.mjs"); // structured MCP tools/call errors (imported by server/mcp-http.mjs and server/mcp-room-profile.mjs)
optional.push("server/mcp-identity-mint.mjs"); // anonymous MCP identity mint (imported by server/mcp-http.mjs and server/mcp-room-profile.mjs)
optional.push("server/mcp-action-search.mjs"); // room_search_actions, room_run_action and the lean profile (imported by server/mcp-discovery.mjs and server/mcp-room-profile.mjs)
optional.push("server/mcp-room-profile.mjs"); // authenticated hosted MCP room tools (imported by server/http.mjs)
optional.push("server/spend-grants.mjs"); // spend-primitive MVP: per-agent spend grants + charge-then-forward (imported by server/mcp-room-profile.mjs, server/mcp-full-profile.mjs, server/http.mjs)
optional.push("server/a2a-jsonrpc.mjs"); // public A2A JSON-RPC join reply at /a2a (imported by server/http.mjs)
optional.push("server/read-cursor.mjs"); // safe scalar foundation imported by needs-me
optional.push("server/needs-me.mjs"); // cross-room room_needs_me (imported by server/mcp-room-profile.mjs and server/http.mjs)
optional.push("server/land-queue.mjs"); // per-room pull-request land queue (imported by server/store.mjs)
optional.push("server/mcp-full-profile.mjs"); // stdio-equivalent hosted MCP tools (imported by server/mcp-room-profile.mjs)
optional.push("server/agent-identities.mjs");
optional.push("server/owner-delegates.mjs"); // Owner-delegate authority (imported by server/store.mjs; delegate flag consumed by server/guest-agent-links.mjs, server/guest-invites.mjs, server/agent-invites.mjs, server/access-review.mjs, server/agent-connections.mjs)
optional.push("server/display-name-guard.mjs"); // Identity mint/link guard is part of the runtime import closure.
optional.push("server/agent-invites.mjs");
optional.push("server/routes/agent-connect.mjs"); // GET /a/<code> agent invite page (imported by server/http.mjs and server/agent-invites.mjs)
optional.push("server/referrals.mjs"); // Referral attribution: joins via invite/access-request (imported by server/store.mjs)
optional.push("server/growth-loop.mjs"); // Referral growth: activation, room credits, payout guard (imported by server/referrals.mjs and server/agent-rooms.mjs)
optional.push("server/referral-invites.mjs"); // Signed agent-carried referral invites (imported by server/store.mjs and server/http.mjs)
optional.push("src/work-item-session.js");
optional.push("src/board.js");
optional.push("src/work-templates.js");
optional.push("src/room-templates.js");
optional.push("scripts/release-evidence.mjs");
optional.push("src/work-loops.js");
optional.push("src/work-recipes.js");
optional.push("src/chat-suggestions.js"); // one-tap replies and task nudge above the composer (imported by src/app.js)
optional.push("server/action-classes.mjs");
optional.push("server/room-lifecycle.mjs");
optional.push("server/attachment-schema.mjs");
optional.push("server/room-attachment-bytes.mjs"); // room_attachments byte store (imported by server/store.mjs and server/http.mjs)
optional.push("server/inbox-attachment-bytes.mjs"); // identity inbox attachment bytes (imported by server/store.mjs)
optional.push("server/attachments.mjs"); // filename and extension checks (imported by server/room-attachment-bytes.mjs)
optional.push("server/wake-queue.mjs", "server/request-runs.mjs");
optional.push("server/wake-queue-limits.mjs"); // wake-queue capacity constants (imported by server/wake-queue.mjs and server/governance.mjs; leaf, no store import)
optional.push("server/governance.mjs"); // /.well-known/governance.json builder (imported by deploy/agent-discovery.mjs)
optional.push("server/discoverability.mjs"); // Appendix A route table + generated /openapi.json (imported by server/http.mjs, server/mcp-http.mjs, server/mcp-room-profile.mjs)
optional.push("server/matchmaking-routes.mjs", "server/work-matchmaking.mjs", "server/work-declarations.mjs", "server/agent-lanes.mjs"); // work matchmaking routes (imported by server/http.mjs)
optional.push("server/attention.mjs");
optional.push("server/owner-attention.mjs"); // #662: owner "needs your attention" rollup (imported by server/http.mjs)
optional.push("server/mention-lifecycle.mjs"); // #658: mention lifecycle state machine + schema (imported by server/store.mjs)
optional.push("server/moderation.mjs");
optional.push("server/channel-connection.mjs", "server/channel-import.mjs", "server/channel-adapters/index.mjs", "server/channel-adapters/email.mjs", "server/channel-adapters/telegram.mjs", "server/channel-adapters/telegram-rotation.mjs", "server/channel-adapters/gmail.mjs", "server/channel-adapters/whatsapp.mjs", "server/channel-adapters/sms.mjs", "server/channel-adapters/messenger.mjs");
optional.push("server/mime-message.mjs", "server/email-routing-inbound.mjs", "server/channel-journal.mjs");
optional.push("server/channel-live-status.mjs"); // Task 10: durable Telegram live-delivery/send facts (imported by server/store.mjs)
optional.push("server/delivery-tracing.mjs"); // R1: opt-in OTel delivery-path tracing (pure, no store.mjs imports)
optional.push("server/channel-send-budgets.mjs"); // Task 41: per-connection send budgets (imported by server/http.mjs; imports token-bucket.mjs and store.mjs)
optional.push("server/token-bucket.mjs"); // token-bucket limiter (imported by server/channel-send-budgets.mjs; pure, no imports)
optional.push("server/spam-quarantine-journal.mjs"); // Durable spam-guard quarantine journal (imported by server/store.mjs)
optional.push("server/channel-drain.mjs"); // Task 9: scheduled drain of pending_channel_updates (imported by server.mjs)
optional.push("server/sla-clocks.mjs"); // Task 24: per-channel SLA clocks (imported by server/inbox.mjs)
optional.push("server/sla-breach-journal.mjs"); // Task 26: durable in-app sink for SLA-breach deliver (imported by server/store.mjs)
optional.push("server/sla-dashboard.mjs"); // Task 26: SLA dashboard aggregator (imported by server/inbox.mjs)
optional.push("server/inbox-triage.mjs"); // Task 21: triage decider reused by server/morning-digest.mjs
optional.push("server/inbox-handoff.mjs"); // Task 23: agent handoff protocol (imported by server/inbox.mjs and server/store.mjs)
optional.push("server/handoff-case.mjs"); // CASE handoff contract (imported by server/inbox-handoff.mjs; pure, imports ServiceError from store.mjs)
optional.push("server/work-handoff.mjs"); // RC-2026-09-19-062: typed handoff envelopes (imported by server/store.mjs; pure, imports ServiceError from store.mjs)
optional.push("server/room-context.mjs"); // Compact agent room context (imported by server/store.mjs; pure, imports events.js and workflow.js)
optional.push("server/inbox-assign.mjs"); // Lane C: pure assignment logic (imported by server/inbox-collab-store.mjs; pure, no imports)
optional.push("server/inbox-internal-notes.mjs"); // Lane C: pure internal-notes logic (imported by server/inbox-collab-store.mjs; imports inbox-assign.mjs)
optional.push("server/inbox-collision.mjs"); // Lane C: pure draft-collision logic (imported by server/inbox-collab-store.mjs; imports inbox-assign.mjs)
optional.push("server/inbox-approval.mjs"); // Lane C: pure approval logic (imported by server/inbox-collab-store.mjs; imports inbox-assign.mjs)
optional.push("server/inbox-agent-routing.mjs"); // Lane C: pure @agent routing (imported by server/inbox-collab-store.mjs; imports inbox-assign.mjs)
optional.push("server/inbox-collab-store.mjs"); // Lane C: collab sub-store (imported by server/store.mjs; created by the collab worker, may be absent here)
optional.push("server/inbox-collab-routes.mjs"); // Lane C: collab HTTP routes (imported by server/http.mjs; created by the collab worker, may be absent here)
optional.push("server/content-trust.mjs"); // structured untrusted markers for member-authored text (leaf; imported by store, http surfaces, MCP)
optional.push("server/room-activation-pack.mjs"); // quill lane RC-2026-09-18-040: room activation pack (imported by server/http.mjs)
optional.push("server/orient.mjs"); // jill lane RC-2026-09-28: orient endpoint builder (imported by server/http.mjs; pure, imports ../src/* only)
optional.push("server/wiki-read-api.mjs"); // W009: read-only wiki API for agents (imported by server/http.mjs; serves embedded wiki-data, no fs)
optional.push("server/wiki-parse.mjs", "server/wiki-data.mjs"); // W009: pure wiki parsers (imported by wiki-read-api.mjs + scripts/wiki-build.mjs) and the build-time embedded wiki planes
optional.push("server/updates.mjs"); // Updates projection (imported by server/http.mjs, server/needs-me.mjs, server/orient.mjs, server/store.mjs)
optional.push("server/work-claims.mjs"); // RC-2026-09-18-041: pure work-claim state machine (imported by server/work-claim-routes.mjs)
optional.push("server/work-claim-sqlite.mjs");
optional.push("server/persisted-row.mjs"); // RC-2026-09-27-2730: replay-safe persisted-row envelope + move-tolerant kind codec (imported by server/work-claim-sqlite.mjs, server/dispatch-journal.mjs, server/bounty-escrow.mjs; pure, no imports)
optional.push("server/claim-collisions.mjs");
optional.push("server/work-claim-routes.mjs"); // RC-2026-09-18-041: work-claim HTTP routes (imported by server/http.mjs)
optional.push("server/work-claim-events.mjs"); // work_claim.updated receipts (imported by server/work-claim-routes.mjs; imports src/events.js)
optional.push("server/work-claim-integrity.mjs"); // SEC-2: Board input bounds, event budget and status cache (imported by server/work-claim-routes.mjs; imports src/display-name-guard.js via server/display-name-guard.mjs and server/store.mjs limits)
optional.push("server/work-claim-mirror.mjs"); // projection claims mirrored onto the work-claims board (imported by server/store.mjs)
optional.push("server/receipt-cards.mjs"); // ACT-1a: in-room receipt cards (imported by server/work-claim-events.mjs and server/room-guide.mjs)
optional.push("server/room-guide.mjs"); // ACT-1a: Room Guide demo agent (imported by cloudflare/room.mjs and server/starter-room.mjs)
optional.push("server/starter-room.mjs"); // ACT-1a: starter seed (imported by server/room-lifecycle.mjs)
optional.push("server/claim-coordination.mjs"); // exclusive file leases, ready queue, pull-request outcomes (imported by server/work-claims.mjs and server/work-claim-routes.mjs)
optional.push("server/claim-pr-sync.mjs"); // poll linked pull requests onto claims (imported by server/work-claim-routes.mjs and cloudflare/room.mjs)
optional.push("server/claim-autolink.mjs"); // plan-pr-autolink: claim-id parsing, PR auto-link, webhook core, poll fallback, deploy linking (imported by server/jobs.mjs and server/routes/pr-webhook.mjs)
optional.push("server/github-app/verify.mjs"); // plan-pr-autolink: GitHub webhook HMAC verification (imported by server/claim-autolink.mjs; pure, no imports)
optional.push("server/mention-receipts.mjs"); // sender-facing mention delivery and read/ack receipts (imported by server/http.mjs)
optional.push("server/feedback-store.mjs"); // RC-2026-09-27-2745: pure /feedback state machine + Mark-staked triage economy (imported by server/feedback-routes.mjs; imports ./feedback-scrub.mjs)
optional.push("server/feedback-scrub.mjs"); // RC-2026-09-27-2745: secret scrubbing at feedback intake (imported by server/feedback-store.mjs; pure, no imports)
optional.push("server/feedback-routes.mjs"); // RC-2026-09-27-2745: /feedback HTTP routes (imported by server/http.mjs)
optional.push("server/work-duplicates.mjs"); // jill 2026-09-24: pure work-claim duplicate detection (imported by server/work-claim-routes.mjs; pure, no imports)
optional.push("server/retention-response.mjs"); // jill 2026-10-03: first-contribution response SLA + no-zero-reply watchdog (imported by server/work-claim-routes.mjs; pure, no imports)
optional.push("server/bounty-escrow.mjs"); // agent work exchange slice 1: escrowed-bounty ledger + lifecycle (imported by server/bounty-escrow-routes.mjs)
optional.push("server/bounty-escrow-routes.mjs"); // agent work exchange slice 1: bounty/credit HTTP routes (imported by server/http.mjs)
optional.push("server/bounty-disputes.mjs"); // agent work exchange slice 1: dispute state machine (imported by server/bounty-escrow.mjs)
optional.push("server/bounty-receipts.mjs"); // bounty receipts slice #1: Ed25519-signed, externally verifiable movement receipts (imported by server/bounty-escrow.mjs; pure, node:crypto only)
optional.push("server/dispute-arbiters.mjs"); // agent work exchange slice 1: designated-verifier arbitration (imported by server/bounty-escrow.mjs)
optional.push("server/bounty-reputation.mjs"); // integration-map slice #4: bounty -> reputation projector (imported by server/bounty-escrow.mjs)
optional.push("server/reputation.mjs"); // B019: pure reputation tracker with typed signals + bands (imported by server/bounty-reputation.mjs)
optional.push("server/agent-rooms.mjs"); // agent room ownership service (imported by server/http.mjs)
optional.push("server/agent-api-keys.mjs"); // Lane D: scoped agent API-key issuance (imported by server/agent-plugin-store.mjs; pure, node:crypto only)
optional.push("server/agent-card-signing.mjs"); // RC-2026-09-18-014: Ed25519 card signing/verification (imported by server/agent-directory.mjs; pure, node:crypto only)
optional.push("server/agent-key-registry.mjs"); // Integration map slice 9: agent public-key registry (imported by server/store.mjs and server/agent-identities.mjs)
optional.push("server/signed-evidence.mjs"); // Integration map slice 5: canonical signed external evidence for work.completed (imported by server/store.mjs; pure, imports bounty-receipts.mjs + agent-card-signing.mjs)
optional.push("server/agent-directory.mjs"); // Lane D: agent card directory (imported by server/agent-plugin-store.mjs; imports agent-card-signing.mjs)
optional.push("server/agent-plugin-manifest.mjs"); // Lane D: plug-in manifest builder/validator (imported by server/agent-plugin-store.mjs and server/agent-plugin-routes.mjs; pure, no imports)
optional.push("server/ip-blocklist.mjs"); // RC-2026-09-25: shared SSRF IP blocklist + pinned lookup (imported by server/web-fetch.mjs, server/outbound-webhooks.mjs, server/webhook-dispatch.mjs; pure, no imports)
optional.push("server/outbound-webhooks.mjs"); // webhook URL validation (imported by server/agent-webhook-subscriptions.mjs; pure, no imports)
optional.push("server/agent-webhook-subscriptions.mjs"); // Lane D: per-agent webhook subscriptions (imported by server/agent-plugin-store.mjs; imports outbound-webhooks.mjs)
optional.push("server/webhook-dispatch.mjs"); // RC-2026-09-19-064: signed dispatch engine (imported by server/agent-plugin-store.mjs; pure, node:crypto only)
optional.push("server/identity-verification.mjs"); // RC-2026-09-18-049: pure agent verification tiers (imported by server/agent-plugin-store.mjs; pure, no imports)
optional.push("server/agent-plugin-store.mjs"); // Lane D: plug-in sub-store, SQLite bridge + ownership (imported by server/store.mjs and server/agent-plugin-routes.mjs)
optional.push("server/agent-plugin-routes.mjs"); // Lane D: plug-in HTTP routes (imported by server/http.mjs)
optional.push("server/room-key-presence.mjs"); // Scoped pull-only room credential presence.
optional.push("server/agent-heartbeats.mjs"); // RC-2026-09-18-051: wakeable agent presence (imported by server/store.mjs; imports outbound-webhooks.mjs)
optional.push("server/work-wakes.mjs"); // Opt-in pointer-only work delivery on heartbeat reads (imported by server/store.mjs; pure work-pointer journal)
optional.push("server/members-directory.mjs"); // RC-2026-09-24-202: members directory + skill cards (imported by server/store.mjs)
optional.push("server/gmail-content.mjs","server/gmail-import-authority.mjs","server/gmail-sync.mjs","server/vendor/gmail-html-sanitizer.mjs","server/vendor/gmail-html-LICENSES.txt", "server/gmail-mailbox.mjs", "server/gmail-actions.mjs", "src/account-setup-ui.js", "src/gmail-ui.js");
optional.push("server/retention-run.mjs"); // dry-run retention caller (imported by cloudflare/room.mjs)
optional.push("cloudflare/job-heartbeat.mjs"); // per-job cron heartbeat (imported by cloudflare/room.mjs)
optional.push("cloudflare/edge-public.mjs"); // static assets and discovery docs answered outside the Durable Object (imported by cloudflare/room.mjs)
optional.push("cloudflare/request-timing.mjs"); // Server-Timing and per-request duration logs (imported by cloudflare/room.mjs)
optional.push("cloudflare/health-probe.mjs"); // Worker-side /api/ready SELECT 1 probe (imported by cloudflare/room.mjs)
optional.push("server/identity-secret-hash.mjs"); // HMAC identity verifiers and legacy scrypt upgrade (imported by server/agent-identities.mjs)
optional.push("server/retention.mjs", "server/audit-retention.mjs"); // pure planners (imported by server/retention-run.mjs)
optional.push("server/google-oauth.mjs"); // Google sign-in (imported by server/http.mjs and cloudflare/room.mjs)
optional.push("server/github-oauth.mjs"); // GitHub sign-in (imported by server/http.mjs)
optional.push("server/oauth-provider.mjs"); // OAuth2 authorization server for connectors (imported by server/http.mjs)
optional.push("server/oauth-provider-store.mjs"); // Durable hashed OAuth grants (imported by server/oauth-provider.mjs, server/writer-fence.mjs, and cloudflare/room.mjs)
optional.push("server/abuse-rate-buckets.mjs"); // Durable abuse rate buckets (imported by server/http.mjs, server/writer-fence.mjs, and cloudflare/room.mjs)
optional.push("connectors/muse.md"); // Muse custom-connector brief (served at /connectors/muse.md)
optional.push("server/account-login-methods.mjs"); // Multi-method login model (imported by server/store.mjs)
optional.push("server/account-deletion.mjs"); // RC-2026-09-19-078: deletion executor (imported by server/http.mjs; imports the src planner below)
optional.push("server/operator-auth.mjs", "server/operator-actions.mjs", "server/purge-registry.mjs", "server/operator-purge.mjs", "server/operator-status.mjs", "server/operator-routes.mjs"); // CP-ADMIN-0: operator auth, purge, and status (imported by server/http.mjs and server/store.mjs)
optional.push("src/account-deletion.mjs"); // RC-2026-09-19-078: pure purge planner (imported by server/account-deletion.mjs)
optional.push("server/account-passkeys.mjs"); // Passkey auth wiring (slice 5; imported by server/http.mjs)
optional.push("src/passkey-login.mjs"); // WebAuthn logic (imported by server/account-passkeys.mjs)
optional.push("server/magic-links.mjs"); // Magic-link mail sender seam (imported by server/http.mjs)
optional.push("server/resend-mailer.mjs"); // Resend-backed magic-link sender (imported by server/boot-options.mjs, cloudflare/room.mjs)
optional.push("src/password-auth.mjs"); // Email+password crypto (imported by server/http.mjs, slice 2)
optional.push("src/account-settings-ui.js"); // Sign-in & security settings UI (imported by src/app.js, slice 7)
optional.push("src/auth-signin-ui.js"); // Multi-method sign-in / create-account UI (imported by src/app.js, slice 7)
optional.push("src/agent-signin-ui.js"); // Agent browser sign-in choice UI (imported by src/app.js, RC-2026-09-23)
optional.push("src/agent-first-run.js"); // Agent first-run orientation card (imported by src/agent-signin-ui.js, RC-2026-09-24-213)
optional.push("src/invite-context.js"); // Invitation context stashed at OAuth start (imported by src/app.js, RC-2026-09-18-007)
optional.push("src/request-access.js"); // Request-access disclosure for signed-in users with no rooms (RC-2026-09-30-3611)
optional.push("src/room-deep-link.js"); // #room/{roomId} Open/People deep-link
optional.push("src/browser-session.js"); // Last-room + Sign out session-hint clear
optional.push("src/composer-files.js"); // Composer file chips (imported by src/app.js)
optional.push("src/session-expiry.js"); // Session-expiry locale rendering (imported by src/app.js + src/join.js)
optional.push("src/agent-invite-ui.js"); // People-rail invite-code mint (collaborate/contribute)
optional.push("src/referral-board.js"); // People-rail referral board (imports agent-invite-ui for "my referral link" mint)
optional.push("src/land-queue-board.js"); // Land-queue board card (imported by src/app.js)
optional.push("src/open-questions-ui.js"); // Open-questions radar (imported by src/app.js)
optional.push("src/retention-ui.js"); // Retention dashboard (imported by src/app.js)
optional.push("src/board-ui.js", "src/board-keyboard.mjs", "src/board-mine.js", "src/first-room-copy.js", "src/board.css"); // Tasks › Board (imported by src/app.js)
optional.push("src/squads-ui.js");
optional.push("server/room-export-html.mjs");
optional.push("server/room-export.mjs", "cloudflare/room-backup.mjs");
optional.push("server/restore-ndjson.mjs"); // whole-store NDJSON restore (imported by cloudflare/room.mjs)
optional.push("server/jobs.mjs"); // shared job registry (imported by cloudflare/job-heartbeat.mjs and server.mjs)
optional.push("server/redact-read.mjs"); // read-time message tombstone (imported by server/http.mjs and the MCP room tools)
optional.push("server/dm-event-visibility.mjs"); // SEC-19 DM follow-up visibility (imported by server/store.mjs and server/http.mjs)
optional.push("about.html");
optional.push("join.html"); // Self-serve join template (loaded by GET /join, not a raw URL)
optional.push("favicon.svg", "icon.svg", "manifest.webmanifest", "src/public-a11y.css");
// HB-3a: icons, offline page, install helper, and the push soft ask. The manifest PNG list waits on SEC-1.
optional.push("offline.html", "icons/icon-192.png", "icons/icon-512.png", "icons/maskable-512.png", "icons/apple-touch-icon-180.png", "src/pwa-install.js", "src/push-ask.js");
optional.push("compare/project-room-vs-slack.html", "compare/project-room-vs-discord.html", "compare/agent-collaboration-tool.html", "compare/multi-agent-workspace.html", "compare/ai-agent-coordination.html", "compare/project-room-vs-agent-room.html"); // AEO buyer-intent pages (public assets)
optional.push("og/home.png", "og/about.png", "og/offers.png", "og/compare.png", "og/receipts.png"); // GR1 static share images
optional.push("og/fonts/Inter-Regular.ttf", "og/fonts/OFL.txt"); // sign-in wordmark font (src/styles.css @font-face)
optional.push("src/join.js"); // Join page logic (public asset, imported by join.html)
optional.push("src/join-watchdog.js"); // Join page loader watchdog (public asset, loaded by join.html)
optional.push("server/access-review.mjs");
optional.push("server/access-requests.mjs", "server/identity-ratelimit.mjs");
optional.push("server/member-permission-requests.mjs", "server/routes/member-permissions.mjs"); // reviewed member permissions and their RT aliases
optional.push("server/agent-fleet.mjs", "server/routes/agents.mjs"); // CP-AGENTS-1: fleet read model and its RT route (imported by server/routes/table.mjs and server/orient.mjs)
optional.push("server/work-wants.mjs", "server/routes/wants-work.mjs"); // BOARD-WAKE-2: ready-work preference and its RT route (imported by server/store.mjs, server/work-claim-routes.mjs and server/routes/table.mjs)
optional.push("server/routes/spend-grants.mjs"); // spend-primitive MVP: per-agent spend grant RT routes (imported by server/routes/table.mjs)
optional.push("server/routes/typing.mjs"); // human UX: ephemeral typing heartbeat RT route (imported by server/routes/table.mjs)
optional.push("server/code-drops.mjs", "server/routes/code-drops.mjs"); // code drops: room-native patch exchange (imported by server/store.mjs and server/routes/table.mjs)
optional.push("server/projection-at-rest.mjs"); // Phase1a stored body serializer
optional.push("server/routes/wake-status.mjs"); // plan-wake-live: wakeable / not-wakeable list RT route (imported by server/routes/table.mjs)
optional.push("server/routes/demo.mjs", "server/routes/human-push.mjs");
optional.push("server/routes/squads.mjs"); // plan-squads: squad roster RT routes (imported by server/routes/table.mjs)
optional.push("server/spend-pricing.mjs", "server/routes/spend-pricing.mjs"); // spend-pricing kill switch: owner-only priced-tool gate lever (imported by server/routes/table.mjs and server/spend-grants.mjs)
optional.push("server/room-flood-guard.mjs"); // per (room, member) chat post budget (imported by server/store.mjs)
optional.push("server/membership-delegation.mjs"); // RC-2026-09-18-038: owner-granted membership administration (imported by server/store.mjs)
optional.push("server/usage-summary.mjs");
optional.push("server/channel-adapters/telegram-config.mjs", "server/channel-adapters/telegram-transport.mjs", "scripts/telegram-set-webhook.mjs", "scripts/telegram-rotate-webhook.mjs");
optional.push("server/receipts-page.mjs", "server/receipts-live.mjs"); // public receipts page + live room reader (imported by server/http.mjs)
optional.push("server/legal-store.mjs", "server/legal-pages.mjs", "server/legal-routes.mjs", "server/legal-documents.mjs"); // terms, privacy, public reports, unpublish
optional.push("docs/legal/terms.md", "docs/legal/privacy.md", "docs/legal/acceptable-use.md", "docs/legal/subprocessors.json");
optional.push("server/public-read-model.mjs"); // public page tables (imported by server/store.mjs and the public routes)
optional.push("server/templates.mjs", "server/public-rooms.mjs"); // GR2 template gallery, public room pages, agent directory (imported by server/http.mjs)
optional.push("src/design-tokens.js"); // token declarations embedded in the public receipts page
optional.push("server/boot-options.mjs"); // imported by server.mjs: default boot args incl. ChannelWebhookInbox
optional.push("server/instance-lock.mjs"); // imported by server.mjs: single-instance boot lock for the on-disk database
optional.push("server/boot-config.mjs"); // imported by server.mjs: fail-loud critical-config boot gate (RC-2026-09-27-2732)
optional.push("server/messages-store.mjs"); // MSG-1: messages table written with each message event (imported by server/store.mjs)
optional.push("server/message-redaction.mjs"); // PRIV-1: rewrite deleted message text out of the log (imported by server/store.mjs and server/account-deletion.mjs)
optional.push("server/history-visibility.mjs"); // PRIV-2: history visibility floor and export authority (imported by server/store.mjs and server/http.mjs)
optional.push("server/pins.mjs");
optional.push("server/squads.mjs"); // plan-squads: squad roster + thread channel (imported by server/http.mjs, server/store.mjs, server/mcp-room-profile.mjs, server/work-claim-routes.mjs)
optional.push("server/typing.mjs"); // ephemeral typing heartbeats (imported by server/http.mjs; pure, in-memory only)
optional.push("server/notifications.mjs");
optional.push("server/open-questions.mjs"); // F1: open-questions radar read (imported by server/http.mjs)
optional.push("server/activity.mjs"); // Attention: activity feed, read horizons, saved messages, thread mutes (imported by server/store.mjs and server/http.mjs)
optional.push("server/spend-allowance.mjs");
optional.push("server/autonomy-tiers.mjs"); // Graduated autonomy tiers (imported by server/store.mjs and server/http.mjs)
optional.push("server/grants.mjs"); // UFO-steal slice 1 (RC-2026-09-27-2728): per-agent capability grant edges (imported by server/store.mjs and server/http.mjs)
optional.push("server/next-actions.mjs", "server/next-actions-routes.mjs"); // RC-2026-09-25-911: ranked per-agent next actions (pure builder + HTTP routes; imported by server/store.mjs and server/http.mjs)
optional.push("server/capability-visibility.mjs"); // RC-2026-09-27-2731: withhold-never-refused catalog predicate (imported by server/mcp-discovery.mjs and server/mcp-room-profile.mjs)
optional.push("src/growth-emit.js", "src/growth-events.js", "src/growth-collector.js", "src/growth-mentions.js", "src/growth-fanout.js", "src/growth-persistence.js", "src/growth-summary.js", "src/growth-compare.js", "src/growth-alerts.js", "src/growth-watch.js", "src/growth-scheduler.js", "src/growth-http.js", "src/growth-digest.js");
// Preserve redistribution terms; historical commits predate these documents.
optional.push("LICENSE", "NOTICE", "THIRD_PARTY.md");
optional.push("server/routes/dispatch.mjs", "server/routes/table.mjs", "server/routes/inbox.mjs", "server/routes/auth.mjs", "server/routes/desktop-auth.mjs", "server/routes/work-claims.mjs"); // batch RT: declarative route table (imported by server/http.mjs)
// DX-1a begin: installer, agent docs, and the example pages those docs link to.
const dx1aAssets = ["scripts/install.sh", "docs/agents/index.html", "docs/agents/paste.html", "docs/agents/claude-code.html", "docs/agents/codex.html", "docs/agents/cursor.html", "docs/agents/cline.html", "docs/agents/vscode.html", "docs/agents/aider.html", "docs/agents/openai-agents-sdk.html", "docs/agents/langgraph.html", "docs/agents/crewai.html", "examples/integrations/claude-code/README.md", "examples/integrations/codex/README.md", "examples/integrations/cursor/README.md", "examples/integrations/cline/README.md", "examples/integrations/vscode/README.md", "examples/integrations/aider/README.md", "examples/integrations/openai-agents-sdk/README.md", "examples/integrations/langgraph/README.md", "examples/integrations/crewai/README.md"];

optional.push(...dx1aAssets, "server/connect-snippets.mjs");
// CP-ADMIN-1: operator console (unlinked, token-only).
const operatorConsoleAssets = ["operator.html", "src/operator-ui.js", "src/operator.css"];
optional.push("project-room-mark.svg", "src/login-polish.css");

optional.push(...operatorConsoleAssets);
// DX-1a end
optional.push("src/human-experience.js", "src/human-experience.css", "server/room-assistant.mjs", "server/routes/room-assistant.mjs", "client/assistant-tools.mjs");

optional.push("server/trial-task-store.mjs", "server/trial-tasks.mjs", "server/vetting-receipts.mjs", "server/demigod-offers.mjs", "server/demigod-contracts.mjs", "server/buyer-signoff.mjs", "server/routes/record-rails.mjs", "server/demigod-policy-adapter.mjs", "server/settlement-router.mjs", "server/fee-credit-ledger.mjs");

optional.push("src/spend-pricing-ui.js", "src/polls.js");
export const allowed = new Set([...required, ...optional]);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
// The contract stays exact: any mismatch fails. Each failure now names the
// offending path/value so a PR author can fix it in one cycle instead of
// re-running CI to discover what drifted (e.g. a new server module imported
// by an allowlisted file that was never registered in `optional` above).
const check = (condition, detail) => {
  if (!condition) throw new Error("Runtime package does not match its exact allowlisted contract"
    + (detail ? `: ${detail}` : ""));
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hashPattern = /^[0-9a-f]{40}$/;
const manifestName = "runtime-manifest.json";

function runtimeMetadata(files) {
  const schema = /export const STORE_SCHEMA_VERSION = (\d+);/.exec(files.get("server/writer-fence.mjs").toString());
  const pkg = JSON.parse(files.get("package.json"));
  const config = JSON.parse(files.get("cloudflare/wrangler.jsonc"));
  check(["8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "30", "31", "32", "33", "34", "35", "36", "37", "38"].includes(schema?.[1]) && typeof pkg.engines?.node === "string",
    `unsupported store schema ${schema?.[1] ?? "unparseable"} or missing package.json engines.node`);
  return { schemaVersion: Number(schema[1]), node: pkg.engines.node, cloudflare: { compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags, durableObjects: config.durable_objects, migrations: config.migrations } };
}

export function createRuntimePackage({ repository, commit, destination }) {
  check(typeof commit === "string" && hashPattern.test(commit),
    `commit must be a full 40-char hash, got: ${String(commit).slice(0, 64)}`);
  const git = (...args) => execFileSync("git", args, { cwd: repository, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  let resolved;
  try {
    resolved = git("rev-parse", "--verify", `${commit}^{commit}`).toString().trim();
  } catch {
    throw new Error(`Baseline commit ${commit} is not in this checkout's history.`
      + ` The upgrade gates need the full history: run 'git fetch --unshallow' (or clone without --depth).`);
  }
  check(resolved === commit, `resolved commit ${resolved} does not match requested ${commit}`);
  const tree = git("rev-parse", `${commit}^{tree}`).toString().trim();
  const entries = git("ls-tree", "-r", "-z", commit, "--", ...allowed).toString().split("\0").filter(Boolean).map(line => {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/.exec(line);
    check(match && allowed.has(match[3]), `git tree entry is not in the allowlisted runtime package: ${match?.[3] ?? line}`);
    return { path: match[3], object: match[2] };
  }).sort((a, b) => a.path < b.path ? -1 : 1);
  const missingRequired = required.filter(path => !entries.some(entry => entry.path === path));
  check(missingRequired.length === 0, `required runtime files missing from the package: ${missingRequired.join(", ")}`);
  const files = new Map(entries.map(entry => [entry.path, git("cat-file", "blob", entry.object)]));
  const runtime = runtimeMetadata(files);
  check(isAbsolute(destination) && destination === resolve(destination),
    `destination must be an absolute normalized path, got: ${destination}`);
  const parent = realpathSync(dirname(destination)), output = join(parent, basename(destination));
  mkdirSync(output, { mode: 0o700 }); // Existing paths are never reused or overwritten.
  for (const [path, bytes] of files) {
    mkdirSync(dirname(join(output, path)), { recursive: true, mode: 0o700 });
    writeFileSync(join(output, path), bytes, { mode: 0o600, flag: "wx" });
  }
  const manifest = { format: 1, sourceCommit: commit, sourceTree: tree, runtime, publicAssets: assetsFor(files),
    files: [...files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) })),
    limitation: "Content consistency only; not trusted provenance, recovery freshness, hosted readiness or publication approval." };
  // Last write is the completion marker. A partial directory is not a package.
  writeFileSync(join(output, manifestName), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return verifyRuntimePackage(output, { expectedCommit: commit });
}

export function verifyRuntimePackage(directory, { expectedCommit } = {}) {
  const root = resolve(directory), info = lstatSync(root);
  check(info.isDirectory() && !info.isSymbolicLink());
  const actual = [];
  const walk = (prefix = "") => {
    for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        check([...allowed].some(file => file.startsWith(path + "/")),
          `packaged directory ${path}/ is not a prefix of any allowlisted runtime file`);
        walk(path);
      } else {
        check(entry.isFile() && (path === manifestName || allowed.has(path)),
          `packaged file ${path} is not in the allowlisted runtime package`);
        actual.push(path);
      }
    }
  };
  walk();
  check(actual.includes(manifestName), "packaged runtime is missing its runtime-manifest.json");
  const raw = readFileSync(join(root, manifestName)), manifest = JSON.parse(raw);
  check(manifest.format === 1, `runtime manifest format ${manifest.format} is not 1`);
  check(hashPattern.test(manifest.sourceCommit),
    `runtime manifest sourceCommit is not a commit hash: ${String(manifest.sourceCommit).slice(0, 64)}`);
  check(hashPattern.test(manifest.sourceTree),
    `runtime manifest sourceTree is not a tree hash: ${String(manifest.sourceTree).slice(0, 64)}`);
  check(!expectedCommit || manifest.sourceCommit === expectedCommit,
    `runtime manifest sourceCommit ${manifest.sourceCommit} does not match expected ${expectedCommit}`);
  check(Array.isArray(manifest.files), "runtime manifest files is not an array");
  const listed = manifest.files.map(entry => entry.path);
  check(new Set(listed).size === listed.length, "runtime manifest lists a file more than once");
  check(same([...listed].sort(), listed), "runtime manifest file list is not sorted");
  const missingListed = required.filter(path => !listed.includes(path));
  check(missingListed.length === 0, `runtime manifest omits required files: ${missingListed.join(", ")}`);
  const actualSorted = actual.sort(), expectedSorted = [...listed, manifestName].sort();
  check(same(actualSorted, expectedSorted),
    `packaged files differ from the manifest: missing [${expectedSorted.filter(p => !actualSorted.includes(p)).join(", ")}], extra [${actualSorted.filter(p => !expectedSorted.includes(p)).join(", ")}]`);
  const files = new Map();
  for (const entry of manifest.files) {
    check(allowed.has(entry.path), `manifest entry ${entry.path} is not in the allowlisted runtime package`);
    check(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && /^[0-9a-f]{64}$/.test(entry.sha256),
      `manifest entry ${entry.path} has invalid bytes/sha256`);
    const bytes = readFileSync(join(root, entry.path));
    check(bytes.length === entry.bytes && sha256(bytes) === entry.sha256,
      `packaged file ${entry.path} does not match its manifest bytes/sha256`);
    files.set(entry.path, bytes);
  }
  const expectedAssets = assetsFor(files);
  const missingAssets = expectedAssets.filter(asset => !manifest.publicAssets.includes(asset));
  const extraAssets = manifest.publicAssets.filter(asset => !expectedAssets.includes(asset));
  check(missingAssets.length === 0 && extraAssets.length === 0,
    `runtime manifest publicAssets mismatch: missing [${missingAssets.join(", ")}], extra [${extraAssets.join(", ")}]`);
  const absentAssets = expectedAssets.filter(path => !files.has(path));
  check(absentAssets.length === 0, `runtime public assets missing from packaged files: ${absentAssets.join(", ")}`);
  // Check this codebase's literal imports, including dynamic literal imports.
  // This is not a complete JavaScript dependency parser; cold runtime tests and
  // source review remain required, especially if a computed loader is added.
  for (const [path, bytes] of files) if (/\.m?js$/.test(path)) {
    // Quoted actions such as "import" or "source.import" are not declarations.
    for (const match of bytes.toString().matchAll(/(?<!["'.-])(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (specifier.startsWith("node:") || specifier.startsWith("cloudflare:")) continue;
      const resolved = posix.normalize(posix.join(posix.dirname(path), specifier));
      check(specifier.startsWith(".") && files.has(resolved),
        `${path} imports ${JSON.stringify(specifier)} (resolves to ${resolved}), which is not in the allowlisted runtime package — register it in scripts/runtime-package.mjs`);
    }
  }
  const actualRuntime = runtimeMetadata(files);
  check(same(manifest.runtime, actualRuntime),
    `runtime manifest metadata differs from recomputed: manifest ${JSON.stringify(manifest.runtime)} vs computed ${JSON.stringify(actualRuntime)}`);
  return { verified: true, sourceCommit: manifest.sourceCommit, sourceTree: manifest.sourceTree,
    schemaVersion: manifest.runtime.schemaVersion, files: listed.length, assets: manifest.publicAssets.length, manifestSha256: sha256(raw) };
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  const [action, ...args] = process.argv.slice(2);
  try {
    let result;
    if (action === "create" && args.length === 3) result = createRuntimePackage({ repository: args[0], commit: args[1], destination: args[2] });
    else if (action === "verify" && args.length >= 1 && args.length <= 2) result = verifyRuntimePackage(args[0], { expectedCommit: args[1] });
    else throw new Error("Usage: runtime-package.mjs create REPOSITORY EXACT_COMMIT NEW_ABSOLUTE_DIRECTORY | verify DIRECTORY [EXACT_COMMIT]");
    console.log(JSON.stringify(result));
  } catch { console.error("Runtime package operation failed. No upload, deployment or overwrite was requested. Inspect the private output before retrying."); process.exitCode = 1; }
}
