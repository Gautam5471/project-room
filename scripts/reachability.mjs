// Import-graph reachability for server/ and src/.
//
// Walks static `import` / `export ... from`, bare `import "x"`, and
// string-literal `import("x")` from runtime entry points. Relative
// specifiers resolve with .mjs / .js (and /index). A `new URL("...", import.meta.url)`
// literal is followed too: that is how the push service worker is loaded.
//
// Entry points: cloudflare/room.mjs, server.mjs, the browser documents,
// every file named by package.json "scripts", every `node <file>` in
// .github/workflows, cloudflare *.check.mjs and *.test-fixture.mjs, and the
// runtime-package required roots plus public assets. Optional allowlist
// entries are packaging permissions, not loaders. A module that is only
// named there is still unreachable.
//
// `node scripts/reachability.mjs --check` fails when a server/ or src/ module
// is unreachable and not in KEEP, so unwired modules cannot accumulate.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { publicAssets } from "./runtime-package.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

// Exceptions still outside the checked import graph. Keep this list narrow:
// shipping an asset or passing a unit test does not prove feature integration.
// Remove an exception when its actual runtime or operational loader is wired.
export const KEEP = [
  // Unmounted supervision/session integration; retain pending product review.
  "server/supervision.mjs",
  "server/supervision-routes.mjs",
  "server/session-adapter.mjs",
  "server/session-adapter/herdr-bridge-adapter.mjs",
  // Notification delivery integrations remain inert, not implicitly enabled.
  "server/notify-policy.mjs",
  "server/notify-email.mjs",
  "server/channel-adapters/webhook-secret.mjs",
  "server/channel-adapters/slack-webhook.mjs",
  "server/channel-adapters/discord-webhook.mjs",
  // Existing merge-queue integration remains unmounted.
  "server/merge-queue.mjs",
  // Operational/test entry points not discovered by this literal graph.
  "server/secret-scan.mjs",
  "server/spam-shadow-report.mjs",
  "src/seed.js",
];

const KEEP_SET = new Set(KEEP);

function walk(dir, pred, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, pred, out);
    else if (pred(entry.name)) out.push(full);
  }
  return out;
}

function rel(abs) {
  const norm = normalize(abs).split(sep).join("/");
  const base = root.endsWith(sep) ? root.slice(0, -1) : root.split(sep).join("/");
  return norm.startsWith(base + "/") ? norm.slice(base.length + 1) : norm;
}

// Drop comments without treating `// ... work-claims/*` as a block comment.
// Strings stay intact so import specifiers survive.
function stripComments(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1];
    if (c === "'" || c === "\"" || c === "`") {
      const q = c;
      out += c;
      i++;
      while (i < source.length) {
        const ch = source[i];
        out += ch;
        if (ch === "\\") {
          i++;
          if (i < source.length) out += source[i];
          i++;
          continue;
        }
        i++;
        if (ch === q) break;
      }
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function specifiers(source) {
  const text = stripComments(source);
  const found = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /(?:^|[^\w$.])import\s+["']([^"']+)["']/g,
    /(?:^|[^\w$.])import\s*\(\s*["']([^"']+)["']/g,
    /\bnew\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g,
  ];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(text))) found.push(match[1]);
  }
  return found;
}

function resolveSpecifier(fromRel, spec) {
  if (!spec.startsWith(".")) return null;
  const base = rel(join(root, dirname(fromRel), spec));
  if (base.startsWith("..")) return null;
  const candidates = [base, `${base}.mjs`, `${base}.js`, `${base}.cjs`, `${base}/index.mjs`, `${base}/index.js`];
  for (const candidate of candidates) {
    const abs = join(root, candidate);
    if (existsSync(abs) && statSync(abs).isFile()) return candidate;
  }
  return null;
}

function pathTokens(text) {
  return [...text.matchAll(/(?:^|[\s"'`=])((?:\.\.\/|\.\/)?[\w.@/-]+\.(?:mjs|js|cjs))(?![\w.])/g)].map(match => match[1]);
}

function existing(path) {
  const abs = join(root, path);
  return existsSync(abs) && statSync(abs).isFile() ? path : null;
}

function mappedNames(block, pattern, prefix, suffix) {
  const paths = [];
  const match = block.match(pattern);
  if (!match) return paths;
  for (const name of match[1].matchAll(/["']([^"']+)["']/g)) paths.push(prefix + name[1] + suffix);
  return paths;
}

function runtimePackageEntries() {
  const source = readFileSync(join(root, "scripts/runtime-package.mjs"), "utf8");
  const paths = new Set(publicAssets.filter(path => /\.(mjs|js)$/.test(path)));
  const requiredStart = source.indexOf("const required = ");
  const requiredEnd = source.indexOf("].sort();", requiredStart);
  const required = requiredStart >= 0 && requiredEnd > requiredStart ? source.slice(requiredStart, requiredEnd) : "";
  for (const path of mappedNames(required, /\[([^\]]+)\]\.map\(\s*name\s*=>\s*`server\/\$\{name\}\.mjs`\)/, "server/", ".mjs")) paths.add(path);
  for (const path of mappedNames(required, /\[([^\]]+)\]\.map\(\s*name\s*=>\s*`client\/\$\{name\}\.mjs`\)/, "client/", ".mjs")) paths.add(path);
  for (const path of mappedNames(required, /\[([^\]]+)\]\.map\(\s*name\s*=>\s*`scripts\/\$\{name\}\.mjs`\)/, "scripts/", ".mjs")) paths.add(path);
  for (const path of mappedNames(required, /\[([^\]]+)\]\.map\(\s*name\s*=>\s*"cloudflare\/" \+ name\)/, "cloudflare/", "")) paths.add(path);
  for (const match of required.matchAll(/["']([^"']+\.(?:mjs|js|cjs))["']/g)) paths.add(match[1]);
  return [...paths].map(existing).filter(Boolean);
}

export function entryPoints() {
  const entries = new Set([
    "cloudflare/room.mjs",
    "server.mjs",
    "src/app.js",
    "src/request-access.js",
    "src/join.js",
    "push-sw.js",
  ]);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const value of Object.values(pkg.scripts ?? {})) {
    for (const token of pathTokens(value)) {
      const path = existing(token.replace(/^\.\//, ""));
      if (path) entries.add(path);
    }
  }
  for (const file of walk(join(root, ".github/workflows"), name => name.endsWith(".yml") || name.endsWith(".yaml"))) {
    for (const token of pathTokens(readFileSync(file, "utf8"))) {
      const cleaned = token.replace(/^\.\//, "").replace(/^\.\.\//, "");
      const path = existing(cleaned) ?? existing(`cloudflare/${cleaned}`);
      if (path) entries.add(path);
    }
  }
  for (const file of walk(join(root, "cloudflare"), name => name.endsWith(".check.mjs") || name.endsWith(".test-fixture.mjs"))) {
    entries.add(rel(file));
  }
  for (const file of walk(root, name => name.endsWith(".html"))) {
    if (rel(file).startsWith("docs/") || rel(file).includes("node_modules")) continue;
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/\bsrc\s*=\s*["']([^"']+\.(?:mjs|js))["']/g)) {
      const path = existing(match[1].replace(/^\.\//, "").replace(/^\{\{ASSET_BASE\}\}\//, "").replace(/^\//, ""));
      if (path) entries.add(path);
    }
  }
  for (const path of runtimePackageEntries()) entries.add(path);
  return [...entries].filter(path => existing(path)).sort();
}

export function candidates() {
  const files = [
    ...walk(join(root, "server"), name => name.endsWith(".mjs")),
    ...walk(join(root, "src"), name => name.endsWith(".mjs") || name.endsWith(".js")),
  ];
  return files.map(rel).sort();
}

export function reachedFrom(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length > 0) {
    const path = queue.pop();
    if (seen.has(path) || !existing(path)) continue;
    seen.add(path);
    let source;
    try { source = readFileSync(join(root, path), "utf8"); }
    catch { continue; }
    for (const spec of specifiers(source)) {
      const resolved = resolveSpecifier(path, spec);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

export function report() {
  const entries = entryPoints();
  const reached = reachedFrom(entries);
  const modules = candidates();
  const orphans = modules.filter(path => !reached.has(path));
  const fresh = orphans.filter(path => !KEEP_SET.has(path));
  const kept = orphans.filter(path => KEEP_SET.has(path));
  return { entries, modules, orphans, fresh, kept };
}

function main() {
  const check = process.argv.includes("--check");
  const { modules, fresh, kept } = report();
  if (fresh.length > 0) {
    console.error(`reachability: ${fresh.length} server/src module(s) are unreachable and not in the keep allowlist:`);
    for (const path of fresh) console.error(`  ${path}`);
    console.error("Wire the module from a runtime entry point, or delete it. Do not extend the keep allowlist for new orphans.");
    process.exit(1);
  }
  const keptNote = kept.length > 0 ? `, ${kept.length} kept by allowlist` : "";
  console.log(`reachability: ${modules.length} server/src modules, 0 orphans outside the keep allowlist${keptNote}`);
  if (!check && kept.length > 0) {
    for (const path of kept) console.log(`  keep ${path}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
