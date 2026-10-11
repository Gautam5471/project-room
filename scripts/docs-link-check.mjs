// Intra-repo markdown links in the maintained docs. docs/history/ is a
// record and is not checked.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, normalize, relative, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function maintainedMarkdown() {
  const files = ["README.md", "AGENTS.md", "CONTRIBUTING.md", "SECURITY.md"]
    .map(name => join(root, name))
    .filter(path => existsSync(path));
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "history") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".md")) files.push(path);
    }
  };
  walk(join(root, "docs"));
  return files;
}

function withoutFences(text) {
  const lines = text.split("\n");
  const kept = [];
  let fence = false;
  for (const line of lines) {
    if (line.trimStart().startsWith("```")) { fence = !fence; continue; }
    if (!fence) kept.push(line);
  }
  return kept.join("\n");
}

export function brokenDocLinks() {
  const failures = [];
  let checked = 0;
  for (const abs of maintainedMarkdown()) {
    const relFile = relative(root, abs).split("\\").join("/");
    const text = withoutFences(readFileSync(abs, "utf8"));
    for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const url = match[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("#") || url.startsWith("//")) continue;
      const pathPart = url.split("#")[0].split("?")[0];
      if (!pathPart) continue;
      checked += 1;
      let decoded;
      try { decoded = decodeURIComponent(pathPart); }
      catch { failures.push(`${relFile} has an undecodable link ${url}`); continue; }
      const resolved = normalize(join(dirname(abs), decoded));
      if (existsSync(resolved)) continue;
      failures.push(`${relFile} links to ${url}, which is not in the tree`);
    }
  }
  return { failures, checked };
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const { failures, checked } = brokenDocLinks();
  if (failures.length) {
    for (const failure of failures) console.error(`docs-link-check: ${failure}`);
    console.error(`docs-link-check: FAILED (${failures.length} broken, ${checked} checked)`);
    process.exit(1);
  }
  console.log(`docs-link-check: OK (${checked} links)`);
}
