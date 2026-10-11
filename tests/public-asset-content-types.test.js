import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { extname } from "node:path";
import { publicAssetPaths } from "../deploy/public-assets.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { edgePublicResponse } from "../cloudflare/edge-public.mjs";

// The server sends X-Content-Type-Options: nosniff, so a browser only runs a module
// or applies a stylesheet when the Content-Type is right. R27-1 shipped a .mjs served
// as text/markdown (Board j/k never loaded). Pin the type of every public asset by
// extension, and make a new extension an explicit decision instead of a silent
// "text/markdown" fallback.
const EXPECTED = {
  ".js": /^text\/javascript\b/, ".mjs": /^text\/javascript\b/, ".css": /^text\/css\b/, ".html": /^text\/html\b/,
  ".svg": /^image\/svg\+xml\b/, ".png": /^image\/png\b/, ".ttf": /^font\/ttf\b/, ".txt": /^text\/plain\b/,
  ".webmanifest": /^application\/manifest\+json\b/, ".json": /^application\/json\b/, ".sh": /^text\/plain\b/,
  ".md": /^text\/markdown\b/,
};

test("every public asset extension has an explicit expected content type", () => {
  const missing = [...new Set(publicAssetPaths.map(path => extname(path)))].filter(ext => !EXPECTED[ext]);
  assert.deepEqual(missing, [], "add the new extension to EXPECTED and to both assetType maps (server/http.mjs, cloudflare/edge-public.mjs)");
});

test("the server serves every public asset with the content type for its extension", async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`, wrong = [];
  for (const path of publicAssetPaths) {
    const res = await fetch(`${origin}/${path}`); await res.arrayBuffer();
    const type = res.headers.get("content-type") || "";
    if (res.status !== 200 || !EXPECTED[extname(path)].test(type)) wrong.push(`${path} -> ${res.status} ${type}`);
  }
  assert.deepEqual(wrong, []);
});

test("the production edge serves every public asset with the content type for its extension", async () => {
  const env = { ROOM_ORIGIN: "https://room.example.test", ASSETS: { fetch: async () => new Response("x") } }, wrong = [];
  for (const path of publicAssetPaths) {
    const url = new URL(`https://room.example.test/${path}`);
    const res = await edgePublicResponse(new Request(url), env, url);
    const type = res?.headers.get("content-type") || "";
    // Pages answer their .html URL with a redirect to the canonical extensionless URL.
    if (extname(path) === ".html" && res?.status === 301) continue;
    if (!res || res.status !== 200 || !EXPECTED[extname(path)].test(type)) wrong.push(`${path} -> ${res?.status} ${type}`);
  }
  assert.deepEqual(wrong, []);
});
