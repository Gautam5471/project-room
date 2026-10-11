import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync, symlinkSync, realpathSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createRoomClient } from "../scripts/room-assistant-scratch.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";
import { openCodexStdio, validateCodexRuntimeConfig } from "../client/codex-stdio.mjs";

function setup(t, mode = "normal") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "room-stdio-"))), cwd = join(root, "workspace"), codexHome = join(root, "codex-home");
  mkdirSync(cwd); mkdirSync(codexHome, { mode: 0o700 });
  const command = join(root, "fake-codex");
  writeFileSync(command, `#!${process.execPath}\nimport readline from 'node:readline';import {spawn} from 'node:child_process';\nconst mode=${JSON.stringify(mode)};\nconst stubborn=mode==='descendant'?spawn(process.execPath,['-e','process.on(\"SIGTERM\",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'}):null;\nconst send=v=>process.stdout.write(JSON.stringify(v)+'\\n');\nif(process.argv[2]!=='app-server'||process.argv[3]!=='--listen'||process.argv[4]!=='stdio://')process.exit(2);\nconst lines=readline.createInterface({input:process.stdin});\nlines.on('line',line=>{const m=JSON.parse(line);if(m.id===999){send({method:'approvalResponse',params:{error:m.error}});return;}if(!m.id)return;\nif(mode==='hang')return;if(mode==='invalid'){process.stdout.write('not JSON\\n');return;}if(mode==='exit')process.exit(3);\nif(m.method==='initialize'){send({id:m.id,result:{childPid:stubborn?.pid,home:process.env.HOME,codexHome:process.env.CODEX_HOME,secret:process.env.ROOM_AGENT_CONFIG??null,other:process.env.OPENAI_API_KEY??null}});return;}\nif(m.method==='thread/name/set'){send({id:m.id,result:{}});return;}\nif(m.method==='thread/start'){send({id:m.id,result:{thread:{id:'owned-thread'}}});return;}\nif(m.method==='turn/start'&&mode==='complete'){send({id:m.id,result:{turn:{id:'owned-turn',status:'inProgress',items:[]}}});setTimeout(()=>send({method:'turn/completed',params:{threadId:'owned-thread',turn:{id:'owned-turn',status:'completed',items:[{id:'answer',type:'agentMessage',phase:'final_answer',text:'Completed through the real subprocess host.'}]}}}),5);return;}\nif(m.method==='turn/start'){send({id:999,method:'item/commandExecution/requestApproval',params:{command:'secret command'}});send({id:m.id,result:{turn:{id:'owned-turn',status:'inProgress'}}});return;}\nif(m.method==='thread/read'||m.method==='thread/resume'){send({id:m.id,result:{thread:{id:m.params.threadId,turns:[]}}});return;}\nsend({id:m.id,error:{code:-32601,message:'unknown'}});});\n`);
  chmodSync(command, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, config: { command, cwd, codexHome, policy: { approvalPolicy: "never", sandbox: "read-only" }, requestTimeoutMs: mode === "hang" ? 100 : 3000 } };
}
test("subprocess handshake clears ambient credentials and restricts thread/method scope", async t => {
  const { config } = setup(t), rpc = openCodexStdio(config);
  t.after(() => rpc.close());
  const result = await rpc.request("initialize", { clientInfo: { name: "test" } });
  assert.equal(result.home, join(config.codexHome, "host-home")); assert.equal(result.codexHome, config.codexHome);
  assert.equal(result.secret, null); assert.equal(result.other, null);
  rpc.notify("initialized", {});
  await assert.rejects(rpc.request("thread/list"), /outside/);
  await assert.rejects(rpc.request("thread/read", { threadId: "foreign" }), /outside/);
  await rpc.request("thread/start", {});
  assert.equal((await rpc.request("thread/read", { threadId: "owned-thread" })).thread.id, "owned-thread");
  assert.throws(() => openCodexStdio(config), /active or unresolved/);
  await rpc.close(); assert.equal(existsSync(join(config.codexHome, ".room-runtime.lock")), false);
});
test("server interactive requests get a typed refusal, never an approval or hang", async t => {
  const { config } = setup(t), attention = [], rpc = openCodexStdio(config, { onAttention: value => attention.push(value) });
  t.after(() => rpc.close());
  let received; const response = new Promise(resolve => { received = resolve; });
  rpc.subscribe(event => { if (event.method === "approvalResponse") received(event); });
  await rpc.request("initialize", {}); await rpc.request("thread/start", {}); await rpc.request("turn/start", { threadId: "owned-thread" });
  assert.equal((await response).params.error.code, -32601);
  assert.equal(attention.length, 1); assert.equal(JSON.stringify(attention).includes("secret command"), false);
});
for (const mode of ["hang", "invalid", "exit"]) test(`subprocess ${mode} rejects uncertain requests without retry`, async t => {
  const { config } = setup(t, mode), rpc = openCodexStdio(config); t.after(() => rpc.close());
  await assert.rejects(rpc.request("initialize", {}), mode === "hang" ? /uncertain/ : mode === "invalid" ? /protocol/ : /disconnected/);
});
test("operator home, ambient Codex home and symlinked process HOME are rejected", t => {
  const { config, root } = setup(t);
  assert.throws(() => validateCodexRuntimeConfig({ ...config, codexHome: homedir() }), /dedicated/);
  assert.throws(() => validateCodexRuntimeConfig({ ...config, codexHome: process.env.CODEX_HOME || join(homedir(), ".codex") }), /dedicated/);
  symlinkSync(root, join(config.codexHome, "host-home"));
  assert.throws(() => openCodexStdio(config), /symlink/);
  assert.throws(() => validateCodexRuntimeConfig({ ...config, policy: { approvalPolicy: "on-request", sandbox: "workspace-write" } }), /unattended/);
});
test("activation CLI --check uses the real child protocol without Room access or model turn", async t => {
  const { config, root } = setup(t), path = join(root, "runtime.json"); writeFileSync(path, JSON.stringify(config));
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/run-codex-room.mjs", "--check", path], { env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = ""; child.stdout.on("data", chunk => { out += chunk; }); child.stderr.on("data", chunk => { err += chunk; });
    child.on("error", reject); child.on("exit", code => resolve({ code, out, err }));
  });
  assert.equal(result.code, 0, result.err); assert.deepEqual(JSON.parse(result.out), { status: "protocol_ready", modelTurnExecuted: false, historyRead: true, resume: true });
});
test("activation CLI executes a public Room ask through a real subprocess and publishes atomically", async t => {
  const { config, root } = setup(t, "complete"), f = createAcceptanceFixture({ dmConsent: true });
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const owner = createRoomClient({ origin, roomId: "commons", token: f.keys.owner });
  await owner.act({ action: "configure", requestId: "configure", expectedRevision: 0, name: "Room", coordinatorMemberId: "producer" });
  f.store.command(f.keys.owner, "commons", { id: "question-cmd", type: "message.posted", data: { messageId: "question", body: "Help our team" } });
  await owner.act({ action: "invoke", requestId: "invoke", runId: "shared-cli", sourceMessageId: "question" });
  const connectionDir = join(root, "connection"), path = join(root, "runtime.json");
  saveAgentConnection(connectionDir, { version: 1, origin, roomId: "commons", memberId: "producer", token: f.keys.producer });
  writeFileSync(path, JSON.stringify(config));
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/run-codex-room.mjs", "shared-cli", join(root, "journal.sqlite"), path],
      { env: { ROOM_AGENT_CONFIG: connectionDir, PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = ""; child.stdout.on("data", chunk => { out += chunk; }); child.stderr.on("data", chunk => { err += chunk; });
    child.on("error", reject); child.on("exit", code => resolve({ code, out, err }));
  });
  assert.equal(result.code, 0, result.err); assert.equal(JSON.parse(result.out).status, "done");
  assert.equal((await owner.assistant()).runs[0].status, "done");
});
test("default operator Codex home stays excluded when CODEX_HOME is overridden", t => {
  const { config, root } = setup(t), previous = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = join(root, "alternate-profile");
    assert.throws(() => validateCodexRuntimeConfig({ ...config, codexHome: join(homedir(), ".codex") }), /dedicated/);
    assert.throws(() => validateCodexRuntimeConfig({ ...config, policy: { ...config.policy, config: {} } }), /unattended/);
  } finally { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; }
});
test("closing kills a TERM-resistant descendant even after the app-server parent exits", async t => {
  const { config } = setup(t, "descendant"), rpc = openCodexStdio(config); t.after(() => rpc.close());
  const { childPid } = await rpc.request("initialize", {}); assert.ok(childPid);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.doesNotThrow(() => process.kill(childPid, 0));
  await rpc.close();
  assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
  assert.equal(existsSync(join(config.codexHome, ".room-runtime.lock")), false);
});


test("activation CLI runs through a symlink entrypoint", t => {
  const { root } = setup(t);
  const alias = join(root, "room-host.mjs");
  symlinkSync(realpathSync("scripts/run-codex-room.mjs"), alias);
  const result = spawnSync(process.execPath, [alias, "--help"], {
    cwd: root, env: { PATH: "/unavailable" }, encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /RUN_ID/);
  assert.match(result.stdout, /--check/);
});
