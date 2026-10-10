import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { roomEntry } from "../deploy/room-entry.mjs";
import {
  agentCard, llmsTxt, llmsFullTxt, skillMd, kitsTxt, agentCardJson, agentsJson, discoveryDoc, DISCOVERY_PATHS,
  AFTER_PASTE_SECTION, joinPrompt, JOIN_HOSTS, JOIN_PROMPT_PATH, SHORT_PACKET_FILES, SHORT_PACKET_SYNONYMS, AGENT_CARD_SYNONYMS, HEALTH_ALIAS_PATHS,
  KITS_CATALOG_PATH, KITS_CATALOG_SYNONYMS, KITS_CATALOG_FILES, AGENTS_JSON_PATH,
  isHealthAliasPath, rewriteRoomApiPrefix, edgeDoorApiPath, DISCOVERY_PROTOCOL_VERSION, AGENT_CARD_A2A_PATH,
  ROOM_ORIGIN, ROOM_DOOR, ROOM_PUBLIC_WWW, COMPUTE_DOOR, ROOM_DOCS,
  EDGE_DOOR_HOSTS, isEdgeDoorUrl
} from "../deploy/agent-discovery.mjs";

const FORBIDDEN = /Bearer (?!<saved-identity-secret>|<room-mcp-token>)|ROOM_AGENT_TOKEN|sk-|password|@gmail|John |Potter |Uuriko@|acct-|memberId":"[^c]/i;

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-discovery-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("discovery documents a ledger, not a run factory, with origin, doors and first tools", () => {
  const card = agentCard(), text = llmsTxt(), full = llmsFullTxt();
  assert.equal(card.url, ROOM_ORIGIN);
  assert.equal(card.base_url, ROOM_ORIGIN);
  assert.equal(card.door, ROOM_DOOR);
  assert.equal(card.public_doors.www, ROOM_PUBLIC_WWW);
  assert.equal("lobby" in card.public_doors, false); // dead door, never advertised
  assert.equal(card.product.kind, "ledger");
  assert.equal(card.product.not, "run factory");
  assert.equal(card.product.compute, COMPUTE_DOOR);
  assert.equal(card.endpoints.healthz, `${ROOM_ORIGIN}/api/health`);
  assert.deepEqual(card.key_routes.map(row => row.path), [
    "/api/health", "/llms.txt", "/join.txt", "/mcp", "/mcp/server-card", "/.well-known/mcp.json", "/room/mcp", "/room/mcp/server-card", "/llms-full.txt", "/kits.txt", "/skills", "/procedures", "/agents.json", "/.well-known/agent.json", "/.well-known/governance.json", "/openapi.json",
    "/.well-known/agent-card.json", "/.well-known/jwks.json", "/.well-known/ai-catalog.json", "/.well-known/ard.json", "/robots.txt", "/agent.json",
    "/agent-card.json",
    ...SHORT_PACKET_FILES.map(name => `/${name}`),
    "/room/llms.txt", "/room/join.txt", "/room/llms-full.txt", "/room/kits.txt", "/room/procedures", "/room/agents.json", "/room/.well-known/agent.json",
    "/room/.well-known/agent-card.json",
    ...SHORT_PACKET_FILES.map(name => `/room/${name}`)
  ]);
  assert.deepEqual(card.join.map(row => row.id), ["packet", "guest-agent-link", "enrolled-key", "identity-mint", "agent-room-create", "invite-redeem", "hosted-mcp"]);
  assert.equal(card.join.find(row => row.id === "packet").status, "live");
  assert.equal(card.join.find(row => row.id === "guest-agent-link").status, "live");
  assert.equal(card.join.find(row => row.id === "enrolled-key").status, "live");
  assert.equal(card.join.find(row => row.id === "hosted-mcp").status, "live");
  assert.deepEqual(card.firstTools.map(row => row.name), ["room_check_access", "orient"]);
  assert.equal(card.capabilities["guest-agent-links"], true);
  assert.equal(card.capabilities["agent-keys"], true);
  assert.equal(card.capabilities["agent-rooms"], true);
  assert.match(card.description, /Work Items/);
  assert.match(card.description, /receipts/i);
  assert.match(card.description, /Members/);
  assert.match(card.description, /Not a run factory/);
  assert.match(card.description, /A2A discovery: returns the join guide; use MCP for room actions/);
  assert.match(text, /Agent-native ledger/);
  assert.match(text, /Work Items \+ next actions \+ receipts/);
  assert.match(text, /Not a run factory/);
  assert.match(text, /Compute stays separate/);
  assert.match(text, /HTML door/);
  assert.match(text, /\/room\/llms.txt/);
  assert.equal(DISCOVERY_PATHS.includes("/room"), false);
  assert.equal(DISCOVERY_PATHS.includes("/room/"), false);
  assert.equal(DISCOVERY_PATHS.includes("/mcp"), false);
  assert.equal(DISCOVERY_PATHS.includes("/room/mcp"), false);
  assert.match(text, new RegExp(ROOM_PUBLIC_WWW.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(text.includes("lobby.getdasha.com"), false); // dead door, never advertised
  assert.match(text, /Humans: open this invite link/);
  assert.match(text, /https:\/\/www\.getdasha\.com\/room\/#join\//);
  assert.match(text, /#room\/\{roomId\} is not an invite/);
  assert.match(text, /Agent invite code \/ redeem-invite is labeled below/);
  assert.match(text, /packet \(live, no account\)/);
  assert.match(text, /paste-prompt \(live, no account\)/);
  assert.match(text, /GET \/join\.txt/);
  assert.match(text, /guest-agent-link \(live, owner-issued\)/);
  assert.match(text, /agent-room-create \(live, no account\)/);
  assert.match(text, /bootstrap-agent-room/);
  assert.match(text, /cli, not a live HTTP POST/);
  assert.match(text, /no POST \/api\/bootstrap-agent-room/);
  assert.match(text, /\/room\/api\/agent-identities/);
  assert.match(text, /\/room\/api\/agent-rooms/);
  assert.match(text, /\/room\/api\/agent-invites\/redeem/);
  assert.match(text, /POST \/api\/rooms\/\{roomId\}\/agent-invites/);
  assert.match(text, /\{"profile":"chat\|contribute\|review\|collaborate"\}/);
  assert.equal(card.endpoints.invite_mint, `${ROOM_ORIGIN}/api/rooms/{roomId}/agent-invites`);
  assert.match(text, /hosted-mcp \(live, no account\)/);
  assert.match(text, /https:\/\/www\.getdasha\.com\/room\/mcp/);
  assert.doesNotMatch(text, /human-join-code \(live\)/);
  assert.match(text, /www.getdasha.com \(no \/room path\)/);
  assert.match(text, /room_check_access/);
  assert.match(text, /orient/);
  assert.match(text, new RegExp(ROOM_DOCS.client.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(full, /queued \/ processing \/ active/);
  assert.match(full, /Compute is a separate/);
  assert.match(text, /\/kits\.txt/);
  assert.match(full, /\/kits\.txt/);
  assert.equal(FORBIDDEN.test(text), false);
  assert.equal(FORBIDDEN.test(full), false);
  assert.match(card.skills.find(row => row.id === "packet").description, /After paste/);
  assert.equal(FORBIDDEN.test(kitsTxt()), false);
  assert.equal(FORBIDDEN.test(agentCardJson()), false);
  assert.equal(JSON.parse(agentCardJson()).protocol, "project-room-discovery");
  assert.equal(card.protocolVersion, DISCOVERY_PROTOCOL_VERSION);
  assert.deepEqual(card.skills.map(row => row.id), ["muse-room", "orient", "claims-board", "room_check_access", "packet", "guest-agent-link", "enrolled-key", "identity-mint", "agent-room-create", "invite-redeem", "hosted-mcp"]);
  assert.equal(card.capabilities["agent-identities"], true);
  assert.equal(card.capabilities["webhooks"], true);
  assert.deepEqual(card.defaultInputModes, ["text/plain"]);
  assert.equal(discoveryDoc(AGENT_CARD_A2A_PATH).body, discoveryDoc("/.well-known/agent.json").body);
  assert.equal(discoveryDoc("/room/.well-known/agent-card.json").body, discoveryDoc("/.well-known/agent.json").body);
  assert.equal(discoveryDoc("/project-room/.well-known/agent-card.json").body, discoveryDoc("/.well-known/agent.json").body);
});

test("short and full packets tell a pasted agent the next action; kits and door stay off", () => {
  const text = llmsTxt(), full = llmsFullTxt();
  assert.match(AFTER_PASTE_SECTION, /^## After paste \(you are the agent\)\n/);
  assert.match(AFTER_PASTE_SECTION, /No separate agent invite code, human login, or room-owner approval/);
  assert.match(AFTER_PASTE_SECTION, /fragment after # is not sent/);
  assert.match(AFTER_PASTE_SECTION, /POST \/api\/share-links\/join-agent/);
  assert.match(AFTER_PASTE_SECTION, /GET \/api\/rooms\/ROOM_ID\/activation-pack/);
  assert.doesNotMatch(AFTER_PASTE_SECTION, /#join\/ ≠ agent auth|Waiting for Paste AI draft/);
  for (const packet of [text, full]) {
    const joinAt = packet.indexOf("## Join\n");
    const afterAt = packet.indexOf(AFTER_PASTE_SECTION);
    const routesAt = packet.indexOf("## Routes\n");
    assert.ok(joinAt >= 0, "Join present");
    assert.ok(afterAt > joinAt, "After paste follows Join");
    assert.ok(routesAt > afterAt, "Routes follow After paste");
    assert.equal(packet.includes(AFTER_PASTE_SECTION), true);
    assert.match(packet, /Humans: open this invite link \(https:\/\/www\.getdasha\.com\/room\/#join\/…\)/);
    assert.match(packet, /#room\/\{roomId\} is not an invite/);
  }
  assert.equal(kitsTxt().includes(AFTER_PASTE_SECTION), false, "kits catalog stays packet-off");
  assert.equal(kitsTxt().includes("## After paste"), false);
  const packetSkill = agentCard().skills.find(row => row.id === "packet");
  assert.match(packetSkill.description, /After paste/);
  assert.match(packetSkill.description, /shared invitation/);
  assert.doesNotMatch(agentCardJson(), FORBIDDEN);
});

test("join prompt is one paste, secret-free, and served at /join.txt", () => {
  const prompt = joinPrompt();
  assert.equal(JOIN_PROMPT_PATH, "/join.txt");
  assert.deepEqual([...JOIN_HOSTS], ["Cursor", "Grok Bot", "ChatGPT", "Codex", "Claude", "MCP"]);
  assert.match(prompt, /^Join Uuriko Project Room as an agent\.\n/);
  assert.match(prompt, /\/llms\.txt/);
  assert.match(prompt, /After paste/);
  assert.match(prompt, /HTTP-only agents/);
  assert.match(prompt, /your own saved identity/);
  assert.doesNotMatch(prompt, FORBIDDEN);
  assert.doesNotMatch(prompt, /chatgpt\.com|ChatGPT Sites/i);
  assert.equal(discoveryDoc("/join.txt").body, prompt);
  assert.equal(discoveryDoc("/room/join.txt").body, prompt);
  assert.equal(discoveryDoc("/project-room/join.txt").body, prompt);
  assert.match(discoveryDoc("/join.txt").type, /text\/plain/);
});

test("Room Worker serves llms.txt, llms-full.txt, agent.json and /room aliases", async t => {
  const origin = await serve(t);
  assert.ok(DISCOVERY_PATHS.includes("/llms-full.txt"));
  assert.ok(DISCOVERY_PATHS.includes("/room/llms.txt"));
  for (const path of DISCOVERY_PATHS) {
    const expected = discoveryDoc(path);
    const get = await fetch(origin + path);
    assert.equal(get.status, 200, path);
    assert.equal(get.headers.get("content-type"), expected.type);
    assert.equal(get.headers.get("x-robots-tag"), "all");
    // RC-2026-09-24-202: the node server injects the live `members` array
    // (opted-in skill cards) into the /skills catalog and its aliases. The
    // scratch server has no published cards, so the served body is the
    // static doc plus `"members": []`.
    const expectedBody = discoveryDoc(path) === discoveryDoc("/skills")
      ? JSON.stringify({ ...JSON.parse(expected.body), members: [] }, null, 2) + "\n"
      : expected.body;
    assert.equal(await get.text(), expectedBody, path);
    const head = await fetch(origin + path, { method: "HEAD" });
    assert.equal(head.status, 200, path);
    assert.equal(await head.text(), "");
    assert.equal((await fetch(origin + path, { method: "POST" })).status, 405, path);
  }
  assert.equal(discoveryDoc("/room/llms.txt").body, discoveryDoc("/llms.txt").body);
  assert.equal(discoveryDoc("/room/llms-full.txt").body, discoveryDoc("/llms-full.txt").body);
  assert.equal(discoveryDoc("/room/.well-known/agent.json").body, discoveryDoc("/.well-known/agent.json").body);
});

test("agents.json is a machine-readable flows/steps/actions doc served at /agents.json and /room aliases", async t => {
  const body = agentsJson();
  assert.match(body, /^[{[]/);
  assert.ok(!FORBIDDEN.test(body), "agents.json must stay secret-free and people-free");
  const doc = JSON.parse(body);
  assert.equal(doc.convention, "agents.json");
  assert.equal(doc.name, "Project Room");
  assert.equal(doc.url, ROOM_ORIGIN);
  assert.equal(doc.card, `${ROOM_ORIGIN}/.well-known/agent.json`);
  assert.equal(doc.packet, `${ROOM_ORIGIN}/llms.txt`);
  assert.deepEqual(Object.keys(doc.doors), ["origin", "demigod", "www"]);
  assert.match(doc.doors.www, /^https:\/\//);
  assert.ok(doc.docs.plug_in.endsWith("docs/SWARM-PLUG-IN.md"), "enrollment guide linked");
  assert.deepEqual(doc.flows.map(flow => flow.id),
    ["discover", "enroll", "create-room", "join-invite", "join-mcp", "claim-work", "coordinate-swarm", "archive-room", "identity-secret"]);
  assert.doesNotMatch(body, /issues\/1160/);
  const archived = doc.flows.find(flow => flow.id === "archive-room");
  assert.match(archived.description, /room\.archived/);
  assert.match(archived.steps[0].actions[0].description, /room\.archived/);
  const secret = doc.flows.find(flow => flow.id === "identity-secret");
  assert.match(secret.description, /\{"confirm":true\}/);
  for (const step of secret.steps) {
    assert.match(step.description, /\{"confirm":true\}/);
    assert.match(step.actions[0].description, /\{"confirm":true\}/);
  }
  for (const flow of doc.flows) {
    assert.ok(flow.id && flow.name && flow.description, `flow ${flow.id} has id/name/description`);
    assert.ok(Array.isArray(flow.steps) && flow.steps.length > 0, `flow ${flow.id} has steps`);
    for (const step of flow.steps) {
      assert.ok(step.id && step.name && step.description, `step ${step.id} has id/name/description`);
      assert.ok(Array.isArray(step.actions) && step.actions.length > 0, `step ${step.id} has actions`);
      for (const action of step.actions) {
        assert.ok(action.type && action.method && action.url && action.description,
          `action in step ${step.id} has type/method/url/description`);
        assert.ok(["none", "required"].includes(action.authentication),
          `action in step ${step.id} declares authentication`);
      }
    }
  }
  const actionUrls = doc.flows.flatMap(flow => flow.steps).flatMap(step => step.actions).map(a => a.url);
  assert.ok(actionUrls.includes(`${ROOM_ORIGIN}/api/agent-identities`), "identity self-mint present");
  assert.ok(actionUrls.includes(`${ROOM_ORIGIN}/api/agent-rooms`), "agent room create present");
  assert.ok(actionUrls.includes(`${ROOM_ORIGIN}/api/agent-invites/redeem`), "invite redeem present");
  assert.ok(actionUrls.includes(`${ROOM_ORIGIN}/api/rooms/{roomId}/agent-invites`), "agent invite mint present");
  assert.ok(actionUrls.some(url => url.includes("/work-claims")), "work claim endpoints present");
  // Served: canonical + prefix-preserving edge aliases, JSON content type.
  assert.equal(AGENTS_JSON_PATH, "/agents.json");
  const canonical = discoveryDoc("/agents.json");
  assert.equal(canonical.type, "application/json; charset=utf-8");
  assert.equal(canonical.body, body);
  assert.equal(discoveryDoc("/room/agents.json").body, body);
  assert.equal(discoveryDoc("/room/agents.json/").body, body);
  assert.equal(discoveryDoc("/project-room/agents.json").body, body);
  assert.ok(DISCOVERY_PATHS.includes("/agents.json"));
  assert.ok(DISCOVERY_PATHS.includes("/room/agents.json"));
  const origin = await serve(t);
  const get = await fetch(origin + "/agents.json");
  assert.equal(get.status, 200);
  assert.equal(get.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(JSON.parse(await get.text()), doc);
});

test("conventional skill/agent filenames serve the same short packet as /llms.txt", async t => {
  assert.deepEqual([...SHORT_PACKET_FILES], ["skill.md", "agents.md", "AGENTS.md", "CLAUDE.md"]);
  const origin = await serve(t);
  const short = discoveryDoc("/llms.txt");
  for (const name of SHORT_PACKET_FILES) {
    for (const path of [`/${name}`, `/room/${name}`]) {
      assert.ok(DISCOVERY_PATHS.includes(path), path);
      assert.equal(discoveryDoc(path).body, short.body, path);
      assert.equal(discoveryDoc(path).type, short.type, path);
      const get = await fetch(origin + path);
      assert.equal(get.status, 200, path);
      assert.equal(await get.text(), short.body);
    }
  }
});

test("uppercase /SKILL.md serves the agent skill, distinct from the llms.txt packet", async t => {
  // Contract: /SKILL.md is the Omnara-style self-onboarding skill. Lowercase
  // /skill.md stays the llms.txt alias (SHORT_PACKET_FILES). A regression
  // that folds /SKILL.md into the alias list would silently replace the skill
  // with the packet — this test fails on exactly that.
  const origin = await serve(t);
  const skill = discoveryDoc("/SKILL.md");
  const packet = discoveryDoc("/llms.txt");
  assert.ok(skill, "/SKILL.md is served");
  assert.notEqual(skill.body, packet.body, "/SKILL.md is not the llms.txt packet");
  assert.match(skill.type, /text\/markdown/, "served as markdown");
  assert.ok(skill.body.startsWith("---\nname: work-in-project-room"), "skill frontmatter names the skill");
  assert.ok(skill.body.includes("## Step 1"), "skill walks setup steps");
  assert.ok(skill.body.includes("/api/public-work/match"), "skill covers finding work");
  assert.ok(skill.body.includes("/api/project-offers"), "skill covers paid bounties");
  assert.ok(skill.body.includes("Money honesty"), "skill carries the money-honesty section");
  // Stranger-onboarding recovery contract (qa200-AO-02): /SKILL.md is the whole
  // onboarding for a first-contact agent, so it must document the two dead
  // ends a stranger can hit before earning anything: a 429 on the identity
  // mint (network budget) and an empty recommendations list.
  assert.ok(skill.body.includes("Identity mint network budget reached"), "skill names the mint budget limit");
  assert.ok(skill.body.includes("Retry-After"), "skill documents the mint 429 recovery interval");
  // ch-2041 challenge: the budget refills on a rolling 24h window, not after
  // Retry-After, and the server always sends Retry-After: 3600 for this tier —
  // the doc must not promise recovery after 60 seconds.
  assert.ok(skill.body.includes("rolling 24-hour window"), "skill states the true mint-budget recovery window");
  assert.ok(!skill.body.includes("60 seconds if the header is absent"), "skill drops the false 60s fallback");
  // ch-2041 challenge: an empty match is caused by everything claimed or by a
  // non-volunteer reward request — interests only sort, never filter — so the
  // doc must name those causes and not advise "try other interests".
  assert.ok(skill.body.includes("supportedRewards"), "skill names the reward-class empty-match cause");
  assert.ok(!skill.body.includes("Try other interests"), "skill drops the ineffective empty-match advice");
  // Stranger dead-end recovery map (qa200-GP-05/FINDINGS): four dead ends a
  // first-contact agent hits that the onboarding text above does not cover —
  // Cloudflare 403 on stock library user-agents, zstd content-encoding
  // breaking naive clients, the "Unknown error '<code>'" fallthrough hint,
  // and a 401/rooms: [] right after a successful mint. Each must carry its
  // exact recovery, verified live against production.
  assert.ok(skill.body.includes("error code: 1010"), "skill names the Cloudflare 1010 user-agent dead end");
  assert.ok(skill.body.includes("Content-Encoding: zstd"), "skill documents the zstd dead end and recovery");
  assert.ok(skill.body.includes("Unknown error"), "skill documents the unknown-error fallthrough recovery");
  assert.ok(skill.body.includes("rooms: []"), "skill documents the fresh-mint 401 / rooms dead end");
  assert.ok(!FORBIDDEN.test(skill.body), "skill stays secret-free");
  for (const path of ["/room/SKILL.md", "/project-room/SKILL.md"]) {
    assert.ok(DISCOVERY_PATHS.includes(path), path);
    assert.equal(discoveryDoc(path).body, skill.body, `${path} serves identical bytes`);
    const get = await fetch(origin + path);
    assert.equal(get.status, 200, path);
    assert.equal(await get.text(), skill.body);
  }
  const get = await fetch(origin + "/SKILL.md");
  assert.equal(get.status, 200, "/SKILL.md");
  assert.equal(await get.text(), skill.body);
  // The lowercase alias is untouched: still the short packet.
  assert.equal(discoveryDoc("/skill.md").body, packet.body, "lowercase /skill.md still aliases llms.txt");
});

// The rendered onboarding requests are a copy/paste contract. These checks
// catch malformed bodies and missing transport headers without source greps.
for (const [path, expectedBody, originRequired] of [
  ["/api/access-requests", { roomId: "muse-room", identityId: "<your identityId>", displayName: "Your agent name", requestedPermissions: [], requestId: "YOUR-STABLE-ID-3" }, false],
  ["/api/share-links/join-agent", { linkToken: "TOKEN", displayName: "Your agent name" }, false],
  ["/api/auth/agent/rooms", { identityId: "<your identityId>" }, true],
]) {
  test(`onboarding skill gives a complete JSON request for ${path}`, () => {
    const blocks = [...discoveryDoc("/SKILL.md").body.matchAll(/```\n([\s\S]*?)```/g)].map(match => match[1]);
    const request = blocks.find(block => block.startsWith(`POST ${ROOM_ORIGIN}${path}\n`));
    assert.ok(request, `${path} has a copyable request`);
    assert.match(request, /^Authorization: Bearer <saved-identity-secret>$/m);
    assert.match(request, /^Content-Type: application\/json$/m);
    if (originRequired) assert.ok(request.includes(`Origin: ${ROOM_ORIGIN}\n`));
    assert.deepEqual(JSON.parse(request.slice(request.indexOf("{"))), expectedBody);
  });
}

test("onboarding skill labels every JSON POST example", () => {
  const text = discoveryDoc("/SKILL.md").body;
  const requests = [...text.matchAll(/```\n(POST [\s\S]*?)```/g)].map(match => match[1]);
  for (const request of requests) assert.match(request, /^Content-Type: application\/json$/m, request.split("\n")[0]);
});

test("onboarding skill explains read/chat approval limits", () => {
  const text = discoveryDoc("/SKILL.md").body;
  const step4 = text.slice(text.indexOf("## Step 4"), text.indexOf("## Money honesty"));
  assert.match(step4, /empty `requestedPermissions` asks for read and chat access/);
  assert.match(step4, /read\/chat request waits until the room owner approves it/);
  assert.match(step4, /non-empty permission request may be auto-approved[\s\S]*covered by the room's standing rule/);
  assert.match(step4, /Reuse the same `requestId` when you retry/);
});

test("www leftover synonyms serve the short packet or agent card, not 404", async t => {
  assert.deepEqual([...SHORT_PACKET_SYNONYMS], [
    "/room/skill", "/room/agents", "/room/llms",
    "/room/readme.md", "/room/README.md",
    "/room/gemini.md", "/room/GEMINI.md",
    "/room/cursor.md", "/room/CURSOR.md"
  ]);
  assert.deepEqual([...AGENT_CARD_SYNONYMS], ["/room/agent.json"]);
  const origin = await serve(t);
  const short = discoveryDoc("/llms.txt");
  const card = discoveryDoc("/.well-known/agent.json");
  for (const path of [...SHORT_PACKET_SYNONYMS, ...SHORT_PACKET_SYNONYMS.map(p => `${p}/`)]) {
    assert.equal(discoveryDoc(path).body, short.body, path);
    assert.equal(discoveryDoc(path).type, short.type, path);
    const get = await fetch(origin + path);
    assert.equal(get.status, 200, path);
    assert.equal(get.headers.get("content-type"), short.type, path);
    assert.equal(await get.text(), short.body, path);
  }
  for (const path of ["/room/agent.json", "/room/agent.json/"]) {
    assert.equal(discoveryDoc(path).body, card.body, path);
    const get = await fetch(origin + path);
    assert.equal(get.status, 200, path);
    assert.equal(get.headers.get("content-type"), card.type, path);
    assert.equal(await get.text(), card.body, path);
  }
  // Door roots stay out of ALIASES so HTML / Accept: text/plain keep working.
  assert.equal(discoveryDoc("/room"), null);
  assert.equal(discoveryDoc("/room/"), null);
});

test("kits catalog is its own packet; leftover kit/apps/tools paths do not 404", async t => {
  assert.equal(KITS_CATALOG_PATH, "/kits.txt");
  assert.deepEqual([...KITS_CATALOG_SYNONYMS], ["/room/kit", "/room/kits", "/room/apps", "/room/tools"]);
  assert.deepEqual([...KITS_CATALOG_FILES], [
    "kits.json", "kits.md", "kit.txt", "kit.md", "apps.txt", "apps.md", "tools.txt", "tools.md"
  ]);
  const catalog = discoveryDoc("/kits.txt");
  const short = discoveryDoc("/llms.txt");
  assert.notEqual(catalog.body, short.body);
  assert.match(catalog.type, /text\/plain/);
  assert.equal(catalog.body, kitsTxt());
  assert.match(catalog.body, /People and agents coordinate here\. Not Compute\./);
  assert.match(catalog.body, /This is a catalog\. Not an App Store\. No paid apps\./);
  assert.match(catalog.body, /packet \(live, no account\)/);
  assert.match(catalog.body, /guest-agent-link \(live, owner-issued\)/);
  assert.match(catalog.body, /enrolled-key \(live\)/);
  assert.match(catalog.body, /agent-room-create \(live, no account\)/);
  assert.match(catalog.body, /hosted-mcp \(live, no account\)/);
  assert.match(catalog.body, /\/room\/llms\.txt/);
  assert.match(catalog.body, /\.well-known\/agent\.json/);
  assert.match(catalog.body, /\/health/);
  assert.match(catalog.body, /\/skill/);
  assert.match(catalog.body, /curl -sS/);
  assert.match(catalog.body, /follow Connect/);
  assert.doesNotMatch(catalog.body, /getone\.one|Amore|Accessibility|Mic\/Mac|people-data dump|paid app list/i);
  assert.equal(FORBIDDEN.test(catalog.body), false);
  const origin = await serve(t);
  const catalogPaths = [
    "/kits.txt", "/kits", "/kits/", "/room/kits.txt", "/project-room/kits.txt",
    ...KITS_CATALOG_SYNONYMS, ...KITS_CATALOG_SYNONYMS.map(p => `${p}/`),
    ...KITS_CATALOG_FILES.flatMap(name => [`/${name}`, `/room/${name}`])
  ];
  for (const path of catalogPaths) {
    assert.ok(DISCOVERY_PATHS.includes(path), path);
    assert.equal(discoveryDoc(path).body, catalog.body, path);
    assert.equal(discoveryDoc(path).type, catalog.type, path);
    const get = await fetch(origin + path);
    assert.equal(get.status, 200, path);
    assert.equal(get.headers.get("content-type"), catalog.type, path);
    assert.equal(await get.text(), catalog.body, path);
    const head = await fetch(origin + path, { method: "HEAD" });
    assert.equal(head.status, 200, path);
    assert.equal(await head.text(), "");
  }
  // Skill leftovers stay the short packet, not the kits catalog.
  assert.equal(discoveryDoc("/room/skill").body, short.body);
  assert.notEqual(discoveryDoc("/room/kit").body, short.body);
});

test("rewriteRoomApiPrefix strips /room/api… and /room/src…; packets and /room/health stay", () => {
  assert.equal(rewriteRoomApiPrefix("/room/api/agent-identities"), "/api/agent-identities");
  assert.equal(rewriteRoomApiPrefix("/room/api/agent-rooms"), "/api/agent-rooms");
  assert.equal(rewriteRoomApiPrefix("/room/api/agent-invites/redeem"), "/api/agent-invites/redeem");
  assert.equal(rewriteRoomApiPrefix("/room/api/rooms/grok-den/agent-invites"), "/api/rooms/grok-den/agent-invites");
  assert.equal(rewriteRoomApiPrefix("/room/api/health"), "/api/health");
  assert.equal(rewriteRoomApiPrefix("/room/api/health/"), "/api/health/");
  assert.equal(rewriteRoomApiPrefix("/room/api"), "/api");
  assert.equal(rewriteRoomApiPrefix("/room/src/join.js"), "/src/join.js");
  assert.equal(rewriteRoomApiPrefix("/room/src/styles.css"), "/src/styles.css");
  assert.equal(rewriteRoomApiPrefix("/room/src"), "/src");
  assert.equal(rewriteRoomApiPrefix("/room/srcother"), "/room/srcother");
  assert.equal(rewriteRoomApiPrefix("/api/agent-rooms"), "/api/agent-rooms");
  assert.equal(rewriteRoomApiPrefix("/room/health"), "/room/health");
  assert.equal(rewriteRoomApiPrefix("/room/llms.txt"), "/room/llms.txt");
  assert.equal(rewriteRoomApiPrefix("/room/apitest"), "/room/apitest");
  assert.equal(rewriteRoomApiPrefix("/rooms/api/agent-rooms"), "/rooms/api/agent-rooms");
});

test("edgeDoorApiPath prefixes /room on getdasha hosts only", () => {
  assert.equal(edgeDoorApiPath("https://www.getdasha.com", "/api/agent-rooms"), "/room/api/agent-rooms");
  assert.equal(edgeDoorApiPath("https://getdasha.com", "/api/agent-identities"), "/room/api/agent-identities");
  assert.equal(edgeDoorApiPath("https://www.getdasha.com", "/room/api/agent-rooms"), "/room/api/agent-rooms");
  assert.equal(edgeDoorApiPath("https://project-room-staging.getdasha.workers.dev", "/api/agent-rooms"), "/api/agent-rooms");
  assert.equal(edgeDoorApiPath("https://www.trydemigod.com", "/api/agent-rooms"), "/api/agent-rooms");
  assert.equal(edgeDoorApiPath("https://www.getdasha.com", "/llms.txt"), "/llms.txt");
});

test("/room/health aliases return the same JSON as /api/health; bare /health stays 404", async t => {
  assert.deepEqual([...HEALTH_ALIAS_PATHS], [
    "/room/health", "/room/health/", "/room/api/health", "/room/api/health/",
    "/api/healthz", "/api/healthz/", "/healthz", "/healthz/",
    "/room/healthz", "/room/healthz/", "/room/api/healthz", "/room/api/healthz/"
  ]);
  assert.equal(discoveryDoc("/room/health"), null, "health is API JSON, not a discovery doc");
  assert.equal(isHealthAliasPath("/api/health"), false);
  assert.equal(isHealthAliasPath("/health"), false);
  const origin = await serve(t);
  const canonical = await fetch(`${origin}/api/health`);
  assert.equal(canonical.status, 200);
  const expected = await canonical.json();
  assert.equal(expected.status, "ok");
  for (const path of HEALTH_ALIAS_PATHS) {
    const get = await fetch(origin + path);
    assert.equal(get.status, 200, path);
    assert.match(get.headers.get("content-type"), /application\/json/);
    assert.deepEqual(await get.json(), expected, path);
    const head = await fetch(origin + path, { method: "HEAD" });
    assert.equal(head.status, 200, path);
    assert.equal(await head.text(), "");
  }
  const bare = await fetch(`${origin}/health`);
  assert.equal(bare.status, 404);
  assert.equal((await bare.json()).error.code, "not_found");
});

test("door serves the same discovery bytes and points at origin", async () => {
  const entry = roomEntry(new Request("https://www.trydemigod.com/room"));
  assert.equal(entry.status, 302);
  assert.equal(entry.headers.get("Location"), "https://room.trydemigod.com/");
  for (const doorPath of [
    "/room/llms.txt", "/room/join.txt", "/room/llms-full.txt", "/room/.well-known/agent.json",
    "/room/skill.md", "/room/agents.md", "/room/AGENTS.md", "/room/CLAUDE.md",
    "/room/skill", "/room/skill/", "/room/agents", "/room/llms",
    "/room/agent.json", "/room/readme.md", "/room/gemini.md", "/room/cursor.md",
    "/room/kits.txt", "/room/kits", "/room/kit", "/room/apps", "/room/tools",
    "/project-room/llms.txt", "/project-room/join.txt", "/project-room/llms-full.txt", "/project-room/kits.txt",
    "/project-room/.well-known/agent.json"
  ]) {
    const expected = discoveryDoc(doorPath);
    const get = roomEntry(new Request(`https://www.trydemigod.com${doorPath}`));
    assert.equal(get.status, 200, doorPath);
    assert.equal(get.headers.get("content-type"), expected.type);
    assert.equal(await get.text(), expected.body);
    assert.equal(await roomEntry(new Request(`https://www.trydemigod.com${doorPath}`, { method: "HEAD" })).text(), "");
    assert.equal(roomEntry(new Request(`https://www.trydemigod.com${doorPath}`, { method: "POST" })).status, 405);
  }
});

test("advertised door root redirects to the app; packets stay at /room/llms.txt", async (t) => {
  assert.equal(discoveryDoc("/room"), null);
  assert.equal(discoveryDoc("/room/"), null);
  assert.equal(discoveryDoc("/room/llms.txt").body, llmsTxt());
  assert.match(discoveryDoc("/room/llms.txt").type, /text\/plain/);
  const base = await serve(t);
  for (const path of ["/room", "/room/"]) {
    const res = await fetch(`${base}${path}`, {redirect:"manual"});
    assert.equal(res.status, 302, path);
    assert.equal(res.headers.get("Location"), `${base}/`);
    assert.equal(await res.text(), "");
    const head = await fetch(`${base}${path}`, { method: "HEAD", redirect:"manual" });
    assert.equal(head.status, 302, path);
    assert.equal(await head.text(), "");
    assert.equal((await fetch(`${base}${path}`, { method: "POST" })).status, 405, path);
    const plain = await fetch(`${base}${path}`, { headers: { Accept: "text/plain" } });
    assert.equal(plain.status, 200, path);
    assert.match(plain.headers.get("content-type"), /text\/plain/);
    assert.equal(await plain.text(), llmsTxt());
  }
  const workspace = await fetch(`${base}/`);
  assert.equal(workspace.status, 200);
  assert.match(workspace.headers.get("content-type"), /text\/html/);
  assert.match(await workspace.text(), /message-input/);
  const packet = await fetch(`${base}/room/llms.txt`);
  assert.equal(packet.status, 200);
  assert.match(packet.headers.get("content-type"), /text\/plain/);
  assert.equal(await packet.text(), llmsTxt());
});

test("edge door predicate: getdasha /room only, prefix preserved", () => {
  assert.deepEqual([...EDGE_DOOR_HOSTS], ["getdasha.com", "www.getdasha.com"]);
  for (const host of EDGE_DOOR_HOSTS) {
    for (const path of ["/room", "/room/", "/room/llms.txt", "/room/join.txt", "/room/llms-full.txt", "/room/.well-known/agent.json", "/room/skill.md", "/room/skill", "/room/agent.json", "/room/health", "/room/kits", "/room/apps", "/room/tools", "/room/api/agent-rooms", "/room/api/agent-identities", "/room/api/identity-create", "/room/api/agent-invites/redeem"]) {
      assert.equal(isEdgeDoorUrl(`https://${host}${path}`), true, `${host}${path}`);
    }
  }
  assert.equal(isEdgeDoorUrl("https://getdasha.com/roomful"), false, "prefix lookalike");
  assert.equal(isEdgeDoorUrl("https://getdasha.com/"), false, "apex root stays with Webflow");
  assert.equal(isEdgeDoorUrl("https://www.getdasha.com/.well-known/agent.json"), false, "Compute card untouched");
  assert.equal(isEdgeDoorUrl("https://getdasha.com/compute"), false, "Compute untouched");
  assert.equal(isEdgeDoorUrl("https://lobby.getdasha.com/room/llms.txt"), false, "lobby host stays with dasha-lobby");
  assert.equal(isEdgeDoorUrl(`${ROOM_ORIGIN}/room/llms.txt`), false, "worker origin is direct, not a door");
  assert.equal(isEdgeDoorUrl("https://www.trydemigod.com/room"), false, "demigod door handled by room-entry");
});

test("edge door routes use wildcard patterns so query strings never fall through", async () => {
  // CF exact route patterns drop the query string: /room?ref= fell through to the
  // lobby wildcard and html-404d. Wildcards keep the advertised door on the worker.
  const { readFileSync } = await import("node:fs");
  const wrangler = readFileSync(new URL("../cloudflare/wrangler.jsonc", import.meta.url), "utf8");
  assert.doesNotMatch(wrangler, /"pattern": "(?:www\.)?getdasha\.com\/room"/, "exact /room patterns drop query strings");
  assert.match(wrangler, /"pattern": "getdasha\.com\/room\*"/);
  assert.match(wrangler, /"pattern": "www\.getdasha\.com\/room\*"/);
  const roomWorker = readFileSync(new URL("../cloudflare/room.mjs", import.meta.url), "utf8");
  assert.match(roomWorker, /rewriteRoomApiPrefix/, "edge rewrite must strip /room/api so enrollment is not AX not_found");
  // The tradeoff is bounded: /roomful junk reaches the worker, which answers a plain
  // 404 for edge-door hosts (not the origin guard's 403); isEdgeDoorUrl keeps it out of the door rewrite.
  assert.equal(isEdgeDoorUrl("https://www.getdasha.com/roomful"), false);
  assert.equal(isEdgeDoorUrl("https://www.getdasha.com/room?ref=x"), true);
});

test("A2A agent card conforms to the official A2A 0.3.0 AgentCard shape", () => {
  // Validated 2026-09-12 against https://a2a-protocol.org/latest/specification/
  // (the card declares protocolVersion 0.3.0). Required top-level fields:
  // name, description, url, provider, version, capabilities,
  // defaultInputModes, defaultOutputModes, skills.
  const card = agentCard();
  for (const field of ["name", "description", "url", "version"]) {
    assert.equal(typeof card[field], "string");
    assert.ok(card[field].length > 0, field);
  }
  assert.equal(typeof card.provider.organization, "string");
  assert.equal(typeof card.provider.url, "string");
  // #601: capabilities are build-time route-family booleans plus a stale flag.
  for (const family of ["agent-identities", "agent-invites", "agent-keys", "agent-rooms",
      "guest-agent-links", "directory", "agent-inbox", "collab", "webhooks",
      "public-face", "spend-allowance"]) {
    assert.equal(typeof card.capabilities[family], "boolean", family);
  }
  assert.equal(typeof card.capabilities.stale, "boolean");
  // Modes are defined as media types in the spec.
  const mime = value => typeof value === "string" && /^[a-z-]+\/[a-z0-9.+-]+$/.test(value);
  assert.ok(card.defaultInputModes.length > 0 && card.defaultInputModes.every(mime));
  assert.ok(card.defaultOutputModes.length > 0 && card.defaultOutputModes.every(mime));
  assert.ok(card.skills.length > 0);
  for (const skill of card.skills) {
    for (const field of ["id", "name", "description"]) assert.equal(typeof skill[field], "string", `skill.${field}`);
    assert.ok(Array.isArray(skill.tags) && skill.tags.length > 0, "skill.tags");
    assert.ok((skill.inputModes ?? []).every(mime) && (skill.outputModes ?? []).every(mime), "skill modes");
  }
  assert.equal(card.protocolVersion, DISCOVERY_PROTOCOL_VERSION);
});

test("A2A agent card declares the work-receipt extension (docs/a2a-receipt-extension.md)", () => {
  // Interop contract: any A2A client fetching /.well-known/agent-card.json
  // must be able to discover receipt support. Guarded here because the
  // declaration is a single line in the capabilities literal — a careless
  // rebase could drop it and clients would silently lose discovery.
  const card = agentCard();
  assert.ok(Array.isArray(card.capabilities.extensions), "capabilities.extensions");
  const ext = card.capabilities.extensions.find(e => e.uri === "https://room.trydemigod.com/extensions/work-receipt/v1");
  assert.ok(ext, "work-receipt extension declared");
  assert.equal(ext.required, false, "extension is declarative, never a gate");
  assert.equal(ext.params.schema_version, "project-room-receipt/1");
  assert.match(ext.params.spec_url, /a2a-receipt-extension\.md$/);
});

test("anonymous MCP catalog is seven tools (four join + two public-work + identity mint); copy never says four", async () => {
  const { livePublicMcpTools } = await import("../server/mcp-discovery.mjs");
  const { MCP_JOIN_TOOLS } = await import("../server/mcp-http.mjs");
  const { anonymousPublicWorkMcpTools } = await import("../server/mcp-public-work.mjs");
  const { anonymousIdentityMintMcpTools } = await import("../server/mcp-identity-mint.mjs");
  const tools = livePublicMcpTools();
  assert.equal(MCP_JOIN_TOOLS.length, 4);
  assert.equal(anonymousPublicWorkMcpTools.length, 2);
  assert.equal(anonymousIdentityMintMcpTools.length, 1);
  assert.equal(tools.length, 7);
  assert.deepEqual(tools.map(t => t.name).sort(), [
    ...MCP_JOIN_TOOLS.map(t => t.name),
    "public_work_read_task", "public_work_recommend", "room_identity_mint",
  ].sort());
  // QA5-gb: the packet once called this anonymous catalog "four tools".
  const text = llmsTxt();
  assert.ok(!/four-tool catalog/i.test(text), "llms.txt must not call the anonymous catalog four-tool");
  assert.ok(!/tools\/list is the four( public join)? tools/i.test(text), "llms.txt must not say no-credential tools/list is only four tools");
});

test("llms.txt follows the llmstxt.org header: H1, summary blockquote, Start here links", () => {
  const text = llmsTxt();
  // llmstxt.org: H1, then a blockquote summary, before anything else.
  assert.ok(text.startsWith("# Uuriko Project Room\n\n> "), "llms.txt opens with H1 then a blockquote summary");
  const summary = text.split("\n").find(line => line.startsWith("> "));
  assert.ok(summary && summary.length > 20, "summary blockquote names what the room is");
  // Then a Start here link list pointing at the entry points.
  assert.match(text, /^## Start here$/m);
  const startHere = text.slice(text.indexOf("## Start here"));
  assert.match(startHere, /\[.*\]\(https:\/\/room\.trydemigod\.com\/llms-full\.txt\)/);
  assert.match(startHere, /\[.*\]\(https:\/\/room\.trydemigod\.com\/mcp\)/);
});

test("llms.txt names room.trydemigod.com/mcp as the one canonical MCP URL (QA4 D8/D-a)", () => {
  const text = llmsTxt();
  assert.match(text, /One canonical MCP URL: paste https:\/\/room\.trydemigod\.com\/mcp/);
});

test("llms.txt documents the work-claims REST contract (issue #1529)", () => {
  const text = llmsTxt();
  // The short packet must name the board endpoints so an agent can
  // coordinate machine work without reading the full packet or openapi.
  assert.match(text, /^## Work-claim board$/m);
  const section = text.slice(text.indexOf("## Work-claim board"));
  assert.match(section, /GET \/api\/rooms\/{roomId}\/work-claims/);
  assert.match(section, /POST \/api\/rooms\/{roomId}\/work-claims/);
  assert.match(section, /\/work-claims\/{claimId}\/claim/);
  assert.match(section, /\/work-claims\/{claimId}\/update/);
  assert.match(section, /\/work-claims\/{claimId}\/release/);
  assert.match(section, /first claim wins/i);
});

// PRODUCT-200 B1: the served /openapi.json is the curated in-scope machine
// surface (generated from DISCOVERABILITY_ROUTES), not every route. Its own
// info.description says "treat it as documentation, not a live route table",
// and scripts/openapi-served-exclusions.json inventories the out-of-scope
// routes with reasons. The packets must state that coverage rule honestly;
// an "every route" sentence is docs/live drift the moment it ships.
test("llms packets describe /openapi.json as the curated machine surface, not every route", () => {
  for (const [name, text] of [["llms.txt", llmsTxt()], ["skill.md", skillMd()]]) {
    assert.ok(!text.includes("Every route is in"), `${name}: no 'Every route is in' overclaim`);
    assert.ok(!text.includes("(every route)"), `${name}: no '(every route)' overclaim`);
    assert.match(text, /curated machine[ -]surface/, `${name}: states the actual coverage rule`);
  }
});
