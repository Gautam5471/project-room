import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyEdgePath, edgePublicResponse } from "../cloudflare/edge-public.mjs";

function release(root, name) {
  const src = join(root, "src-" + name);
  mkdirSync(join(src, "bin"), { recursive: true });
  writeFileSync(join(src, "bin", "room.mjs"), "#!/usr/bin/env node\nconsole.log('room-ok');\n");
  const tarball = join(root, name + ".tar.gz");
  const packed = spawnSync("tar", ["-czf", tarball, "-C", src, "bin"], { encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  const hash = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  return { tarball, hash };
}

function install(root, { tarball, sums }) {
  const home = join(root, "home-" + Math.random().toString(16).slice(2));
  mkdirSync(home);
  const sumsFile = join(root, "SHA256SUMS-" + Math.random().toString(16).slice(2));
  writeFileSync(sumsFile, sums);
  const result = spawnSync("sh", [fileURLToPath(new URL("../scripts/install.sh", import.meta.url))], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      PATH: dirname(process.execPath) + ":" + (process.env.PATH ?? ""),
      PROJECT_ROOM_HOME: home,
      PROJECT_ROOM_TARBALL: tarball,
      PROJECT_ROOM_CHECKSUMS: sumsFile,
    },
  });
  return { result, home };
}

test("install.sh refuses a bad checksum and installs a matching one", t => {
  const root = mkdtempSync(join(tmpdir(), "room-install-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const good = release(root, "good");
  const bad = install(root, { tarball: good.tarball, sums: "0".repeat(64) + "  " + good.tarball.split("/").pop() + "\n" });
  assert.notEqual(bad.result.status, 0);
  assert.match(bad.result.stderr, /Refusing to install/);
  assert.equal(statSync(join(bad.home, ".project-room", "bin", "room"), { throwIfNoEntry: false }), undefined);
  const base = good.tarball.split("/").pop();
  const ok = install(root, { tarball: good.tarball, sums: good.hash + "  " + base + "\n" });
  assert.equal(ok.result.status, 0, ok.result.stderr);
  const bin = join(ok.home, ".project-room", "bin", "room");
  assert.equal(statSync(bin).mode & 0o111, 0o111);
  chmodSync(join(ok.home, ".project-room", "runtime", "bin", "room.mjs"), 0o644);
  const ran = spawnSync(bin, [], { encoding: "utf8", env: { ...process.env, PATH: dirname(process.execPath) + ":" + (process.env.PATH ?? "") } });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stdout.trim(), "room-ok");
  assert.match(ok.result.stdout, /room setup <tool>/);
});

test("the worker serves /install.sh from scripts/install.sh", async () => {
  assert.equal(classifyEdgePath("/install.sh"), "asset");
  const script = readFileSync(new URL("../scripts/install.sh", import.meta.url));
  let requested = "";
  const env = {
    ROOM_ORIGIN: "https://room.example.test",
    ASSETS: { fetch: async request => { requested = new URL(request.url).pathname; return new Response(script); } },
  };
  const url = new URL("https://room.example.test/install.sh");
  const response = await edgePublicResponse(new Request(url), env, url);
  assert.equal(response.status, 200);
  assert.equal(requested, "/scripts/install.sh");
  assert.match(response.headers.get("content-type"), /text\/plain/);
  assert.equal(await response.text(), script.toString());
  assert.match(response.headers.get("x-robots-tag"), /noindex/);
});

test("install.sh network path: a release whose SHA256SUMS names the asset installs", async t => {
  const { createServer } = await import("node:http");
  const { spawn } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "room-install-net-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const built = release(root, "project-room-runtime");
  const bytes = readFileSync(built.tarball);
  let origin = "";
  const server = createServer((req, res) => {
    if (req.url === "/release") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ assets: [
        { name: "project-room-runtime.tar.gz", browser_download_url: origin + "/dl/project-room-runtime.tar.gz" },
        { name: "SHA256SUMS", browser_download_url: origin + "/dl/SHA256SUMS" }] }));
    }
    if (req.url === "/dl/project-room-runtime.tar.gz") return res.end(bytes);
    if (req.url === "/dl/SHA256SUMS") return res.end(built.hash + "  project-room-runtime.tar.gz\n");
    res.statusCode = 404; res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  origin = `http://127.0.0.1:${server.address().port}`;
  const home = join(root, "home");
  mkdirSync(home);
  const { NODE_USE_ENV_PROXY, HTTP_PROXY, HTTPS_PROXY, http_proxy, https_proxy, ...env } = process.env;
  const child = spawn("sh", [fileURLToPath(new URL("../scripts/install.sh", import.meta.url))], { env: { ...env, HOME: home,
    PATH: dirname(process.execPath) + ":" + (process.env.PATH ?? ""), PROJECT_ROOM_HOME: home, PROJECT_ROOM_RELEASE_API: origin + "/release" } });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const status = await new Promise(resolve => child.on("close", resolve));
  assert.equal(status, 0, stderr);
  assert.equal(statSync(join(home, ".project-room", "bin", "room")).mode & 0o111, 0o111);
});
