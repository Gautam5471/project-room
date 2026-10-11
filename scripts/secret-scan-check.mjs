// Secret-scan CI gate (H005 wiring). Scans the repo tree for accidentally
// committed secrets using server/secret-scan.mjs. Fails the build on any
// finding. Pure, dependency-free; runs in the contract job via check.mjs.
//
// The config (ALLOWLIST, SKIP_FILES, ...) is exported so the PR diff gate
// (scripts/secret-scan-diff.mjs) and its tests reuse the exact same rules.
// The tree walk below only runs when this file is executed directly.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { scanText } from "../server/secret-scan.mjs";

// Directories never scanned (vendored code, build output, local scratch).
export const SKIP_DIRS = new Set(["node_modules", ".git", "coverage", "test-results", "runlogs-tmp", "dist"]);
// File extensions worth scanning. Secrets live in text; skip binaries/images.
export const SCAN_EXT = /\.(mjs|js|cjs|json|yaml|yml|toml|md|txt|html|css|env|example|sh)$/i;
// File paths never scanned (lockfiles carry hashes, not secrets).
// Fixture/check scripts and READMEs use placeholder secrets (verified 2026-09-16).
// Pinned, reproducibly bundled sanitize-html dependencies contain HTML entity tables,
// base64 alphabets and parser messages, not credentials (build-gmail-sanitizer.mjs).
// 2026-09-30 (phase-2 gap audit L-P2-17): no blanket *-fixture.mjs / *-check.mjs
// skips — fixture and check scripts are scanned like any other source. Their
// genuinely-safe placeholder values are allowlisted explicitly below.
export const SKIP_FILES = [/server\/vendor\/gmail-html-sanitizer\.mjs$/, /package-lock\.json$/, /pnpm-lock\.yaml$/, /\.min\.js$/, /secret-scan-check\.mjs$/,
  /README\.md$/];
// Known-safe lines: the scanner's own patterns, documented examples, redacted placeholders,
// and variable assignments (not hardcoded values).
export const ALLOWLIST = [
  // The scanner's own documented patterns (server/secret-scan.mjs): match the
  // literal regex text (`AKIA[0-9A-Z]{16}` etc.) only. A looser entry here
  // would match real secret-shaped values too and silently disable the
  // aws-access-key / github-token / slack-token rules on every scanned line.
  /AKIA\[0-9A-Z\]\{16\}/, // scanner's own AWS pattern doc (server/secret-scan.mjs)
  /AKIAIOSFODNN7EXAMPLE/, // AWS's official documented example access key ID (docs.aws.amazon.com) — not a real credential (scripts/scan-secrets.mjs usage comment)
  /gh\[op\]_\[A-Za-z0-9\]\{36\}/, // scanner's own GitHub pattern doc
  /xox\[baprs\]-\[A-Za-z0-9-\]\+/, // scanner's own Slack pattern doc
  /<redacted>/i, // explicit redaction marker
  /DASHA_API_KEY=<redacted>/, // documented placeholder (scripts/dasha-bridge.mjs)
  /example\.com/, // documentation URLs
  // Variable/function/member references, not hardcoded secrets:
  // `secret = generateSecret()`, `token: getToken()`, `token: f.keys.producer`,
  // `token: f.keys[actor]`, `token = store.issueAccessKey('x', y)`, `password = foo`
  /\b(secret|password|passwd|pwd|token|api[_-]?key)\b\s*[:=]\s*[a-zA-Z_$][\w$]*(\s*(\.\s*[a-zA-Z_$][\w$]*|\[[^\]]+\]))*(\s*\([^)]*\))?\s*([,;)\]}]|$)/i,
  /\b(secret|password|passwd|pwd|token|api[_-]?key)\b\s*[:=]\s*["'][^"']{0,11}["']/, // short placeholders
  // Template literals assembled at runtime: `token = `${a}.${b}``. Allowed only
  // when every character outside an interpolation is a separator, so a literal
  // run long enough to be a credential is still caught.
  /\b(secret|password|passwd|pwd|token|api[_-]?key)\b\s*[:=]\s*`(?:\$\{[^{}`]*\}|[\s.\-_:/+,;=&?#|])*`/i,
  // Verified false positives (2026-09-16 audit):
  /IDENTITY_SECRET_PREFIX/, // runtime-generated: `secret = PREFIX + base64url(randomBytes(32))`
  /secret = suppliedSecret/, // server/agent-identities.mjs:186 — variable reference, not a hardcoded secret
  /secret: imported\?\.token/, // client/agent-setup.mjs:58 — reads the imported token (or generates one at runtime), not a hardcoded secret
  /CODE_ALPHABET\s*=\s*"[0-9A-Z]/, // invite-code alphabet constants, not secrets (extends one char into the value so the per-finding allowlist overlaps the finding)
  /LEGACY_CODE_ALPHABET\s*=\s*"[A-Z]/, // invite-code alphabet constants, not secrets
  /SHARE_CODE_ALPHABET\s*=\s*"[0-9]/, // Crockford 9-char human join-code alphabet demo, not a credential
  /token:\s*"TELEGRAM_BOT_TOKEN"/, // env var NAME as string, not a token value
  /password:\s*form\.querySelector/, // src/auth-signin-ui.js: reads the user's typed password back from the DOM to preserve it across signup/login mode toggles — not a hardcoded secret
  /secret = \(data\.secret \|\| ""\)\.trim\(\)/, // src/agent-signin-ui.js: reads the user's typed identity secret back from the sign-in form's FormData — runtime input, not a hardcoded secret
  /webhookSecret:\s*"TELEGRAM_WEBHOOK_SECRET"/, // env var NAME as string
  /insertCredential\(/, // `token = this.insertCredential(...)` — credential store API
  /base64url\(randomBytes\(/, // runtime-generated random values
  /generateSecret\(\)/, // runtime-generated secrets in fixtures
  /secret = stashed\?\.secret/, // src/app.js: reads the stashed access-request identity secret back from sessionStorage — variable reference, not a hardcoded secret
  /secret = minted\?\.secret/, // src/app.js: reads the freshly minted access-request identity secret — variable reference, not a hardcoded secret
  /process\.env\.[A-Z_]+/, // env var NAMES (not values)
  /^\|.*\|$/, // markdown table rows
  /randomBytes\(/, // runtime-generated: `randomBytes(32).toString("base64url")`
  /\btokens\.get\(/, // `token = tokens.get(tokenId)` — Map lookup, not a secret
  /BASE32_ALPHABET\s*=\s*"[A-Z]/, // TOTP alphabet constant (extends one char into the value for per-finding overlap)
  /GSM7_BASIC\s*=\s*".*/, // GSM-7 SMS alphabet constant (server/sms-outbound.mjs) — character set for segmentation accounting, not a secret.
    // Anchored to the assignment and spanning the value: the charset splits into several high-entropy tokens.
  /github\.com\/Uuriko\/[A-Za-z0-9_.-]+\/(pull|issues)\/\d+/, // repo PR/issue URLs (evidence links)
  /hidden_files\/claimbond-shadow\/BASELINE-2026-10-05\.md/, // server/claim-reputation.mjs:4 —
    // relative path to the P0 shadow-mode baseline doc, in a header comment. A file path,
    // not a credential; the high-entropy detector joins the path's tokens into a match.
  /\/blob\/main\/docs\//, // docs URLs in discovery configs
  /^\s*secret:\s*<redacted>\s*$/, // literally redacted values
  /\$SCRIPT_DIR/, // shell script variable references
  /^\s*cp\s+"/, // shell copy commands
  /inviteSecretFromText\(/, // `secret = inviteSecretFromText(...)` — clipboard extraction
  /can store a secret:/, // documentation template string
  /tokenPattern\.test\(/, // `token: tokenPattern.test(...) ? ...` — validation, not a secret
  /\.replace\(.*\.toUpperCase\(\)/, // `secret.replace(...).toUpperCase()` — transform, not a secret
  /DUMMY_PASSWORD_VERIFIER\s*=\s*"scrypt/, // slice 2: public placeholder scrypt verifier (hash of a known
    // placeholder password); used only so unknown-email logins cost one scrypt
    // derivation. Not a credential — it is deliberately published in source.
  /AGENT_CARD_PUBLIC_KEY = "e74i9XPv8I1hIhTsVztVupDr6moyCfL\+nGr1HDoOpTc="/, // Owner recovery 2026-09-24: room Agent Card
    // signing PUBLIC key — intentionally committed and published inside the card itself.
    // The private Ed25519 seed is never in the repo (deploy host key file / env only).
  /"sha(?:Full|Url)?":\s*"([0-9a-f]{40}|https:\/\/github\.com\/Uuriko\/project-room\/commit\/[0-9a-f]{40})"/, // receipts-data.mjs: git merge-commit SHAs from public
    // upstream history (verified via `gh api`), not secrets — 40-char hex is the git SHA-1 shape.
  /CITABLE_PROOF_KINDS/, // emissary-lure.mjs (removed on this branch, still on origin/main):
    // constant naming the citable Slice 1 receipt kinds (work/jury/oracle).
    // The `!` prefix in `!CITABLE_PROOF_KINDS.includes(...)` trips the
    // high-entropy detector; it is a code constant, not a secret. Kept so
    // the origin/main-tree diff scan stays false-positive-free.
  // 2026-09-30 (phase-2 gap audit L-P2-17): fixture/check scripts are scanned
  // (no blanket *-fixture.mjs / *-check.mjs skip). Their genuinely-safe
  // placeholder values are allowlisted explicitly below — each entry names
  // the file and why the value is not a credential.
  /synthetic-test-secret/, // scripts/agent-signin-browser-check.mjs:51 — mocked
    // /api/agent-identities route fulfillment; obvious placeholder, not a credential
  /synthetic-test-private-key/, // scripts/agent-signin-browser-check.mjs:51 — same
    // mocked response; obvious placeholder, not a credential
  /synthetic-email-password/, // scripts/email-password-browser-check.mjs:10 —
    // placeholder password typed into a synthetic browser form
  /doesNotMatch\(page\.url\(\), \/pri_\|secret=\|privateKey=\//, // scripts/agent-signin-browser-check.mjs:194 —
    // negative assertion that the URL does NOT contain secrets; the regex text
    // itself is not a credential
  /doesNotMatch\(page\.url\(\), \/password=\|new-email-password\//, // scripts/email-password-browser-check.mjs:37 —
    // negative assertion; the regex text itself is not a credential
  /BCVxsr7N_eNgVRqvHtD0zTZsEc6/, // scripts/human-push-browser-check.mjs:13,
    // cloudflare/store-worker.test-fixture.mjs:101 — Web Push p256dh PUBLIC key
    // (shared test vector, also in tests/); public by design, grants nothing
  /BTBZMqHH6r4Tts7J_aSIgg/, // scripts/human-push-browser-check.mjs:14,
    // cloudflare/store-worker.test-fixture.mjs:101 — Web Push `auth` test vector
    // (16 bytes, shared across tests/web-push.test.js etc.) paired with a fake
    // FCM endpoint; a fixture value, not a real subscription credential
  /synthetic-not-for-export/, // scripts/result-copy-agent-fixture.mjs:20 —
    // example.invalid URL token; obvious placeholder, not a credential
  /token=not-for-export/, // scripts/result-copy-browser-check.mjs:23 —
    // example.invalid URL token; obvious placeholder, not a credential
  /\/api\/agent-wakes\/poll\?hostId=my-runtime/, // deploy/agent-discovery.mjs —
    // onboarding-skill docs example of the wake poll URL (Step 5b). No
    // credentials on the line; the query string trips the high-entropy
    // detector. Overlaps only the docs URL span, so a real secret on the
    // same line still flags (per-finding allowlist).

];


// Exact non-secret tokens only. Unlike the line allowlist, these suppress
// entropy noise without skipping credential-pattern checks or adjacent tokens.
export const SAFE_ENTROPY_TOKENS = [
  // Public release artifact URLs in the herdr pin manifest; they contain no
  // credentials. Exact tokens retain scanning of all neighboring values.
  "https://github.com/Uuriko/herdr/releases/download/demigod/pkg-v1/herdr-linux-aarch64",
  "https://github.com/Uuriko/herdr/releases/download/demigod/pkg-v1/herdr-linux-x86_64",
  "https://github.com/Uuriko/herdr/releases/download/demigod/pkg-v1/herdr-macos-aarch64",
  "https://github.com/Uuriko/herdr/releases/download/demigod/pkg-v1/herdr-macos-x86_64",
  // Public operator runbook socket-path example; not an authentication token.
  "HERDR_SOCKET_PATH=/srv/herdr/tenants/T/socket/herdr.sock",
  "ROOM_WATCH_WATERMARK:-$HOME/workspace/goals/agent-swarm-coordination/hidden_files/room-watch-watermark.txt",
  "REHEARSAL_SCRATCH:-$HOME/workspace/rotation-rehearsal",
  "ROTATION_CUTOVER:-$HOME/workspace/pr-board2/scripts/rotation-cutover.sh",
  "repos/$REPO/issues/$OLD_ISSUE/comments?per_page=100",
  "$SCRATCH/fb-repo/fallback/jill-20260926T214500Z.md",
  "$SCRATCH/fb-repo/fallback/codex-20260926T214700Z.md",
  "https://api.github.com/repos/Uuriko/project-room/issues/266/comments?per_page=100&page=$",
  // Well-known PUBLIC token contract addresses — the USDC rail's asset
  // allowlist (server/usdc-payouts.mjs). World-readable on-chain; grant nothing.
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC on Solana
];

// Directories scanned: source code where a real secret could hide.
// research/ and docs/ are prose with quoted examples; tests/ use fixtures.
export const SCAN_DIRS = ["server", "src", "scripts", "client", "cloudflare", "deploy", "lanes", "specs"];
export const SCAN_ROOT_FILES = true; // *.mjs in repo root (server.mjs etc.)

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out);
    } else if (SCAN_EXT.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

const root = new URL("..", import.meta.url).pathname;

function runTreeScan() {
  const files = [];
  for (const dir of SCAN_DIRS) {
    try { files.push(...walk(join(root, dir))); } catch { /* dir may not exist */ }
  }
  if (SCAN_ROOT_FILES) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && SCAN_EXT.test(entry.name)) files.push(join(root, entry.name));
    }
  }
  const filtered = files.filter(f => {
    if (SKIP_FILES.some(re => re.test(f))) return false;
    // Skip this gate's own allowlist doc lines by scanning everything anyway;
    // the ALLOWLIST above handles known-safe matches.
    try { return statSync(f).size <= 2 * 1024 * 1024; } catch { return false; }
  });

  let total = 0;
  for (const file of filtered) {
    let text;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    const findings = scanText(text, { allowlist: ALLOWLIST, safeEntropyTokens: SAFE_ENTROPY_TOKENS });
    for (const f of findings) {
      console.error(`secret-scan: ${relative(root, file)}:${f.line} [${f.rule}] ${f.label} (${f.preview})`);
      total++;
    }
  }

  if (total > 0) {
    console.error(`\nsecret-scan: FAIL — ${total} finding(s). Remove the secret or add an allowlist entry with justification.`);
    process.exit(1);
  }
  console.log(`secret-scan: ok — ${files.length} files scanned, no findings.`);
}

// Only run the tree scan when executed directly (check.mjs spawns this
// file); importing it (diff gate, tests) gets the config without side
// effects.
const invokedAsCli =
  process.argv[1] === fileURLToPath(import.meta.url) ||
  (process.argv[1] ?? "").endsWith("/secret-scan-check.mjs") ||
  (process.argv[1] ?? "").endsWith("\\secret-scan-check.mjs");
if (invokedAsCli) runTreeScan();
