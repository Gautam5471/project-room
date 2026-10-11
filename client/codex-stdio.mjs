import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, rmdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const METHODS = new Set(["initialize", "thread/start", "thread/read", "thread/resume", "thread/name/set", "turn/start", "turn/steer", "turn/interrupt"]);
const inside = (root, path) => path === root || (!relative(root, path).startsWith(`..${sep}`) && relative(root, path) !== ".." && !isAbsolute(relative(root, path)));

export function validateCodexRuntimeConfig(config) {
  if (!config || Object.keys(config).some(key => !["command", "cwd", "codexHome", "policy", "requestTimeoutMs", "turnTimeoutMs", "model"].includes(key)))
    throw new Error("Unknown runtime config field");
  for (const key of ["command", "cwd", "codexHome"]) if (!isAbsolute(config[key] ?? "")) throw new Error(`Runtime ${key} must be absolute`);
  if (!statSync(config.command).isFile() || !statSync(config.cwd).isDirectory()) throw new Error("Runtime executable/workspace unavailable");
  const cwd = realpathSync(config.cwd), command = realpathSync(config.command);
  if (cwd !== config.cwd) throw new Error("Select the real workspace path");
  const operatorHome = realpathSync(homedir());
  const ambientHomes = [join(operatorHome, ".codex"), process.env.CODEX_HOME].filter(Boolean)
    .map(path => existsSync(path) ? realpathSync(path) : resolve(path));
  const chosen = config.codexHome;
  if (chosen === operatorHome || ambientHomes.some(path => inside(path, chosen)) || inside(cwd, chosen))
    throw new Error("Choose a dedicated Codex home outside the operator Codex home and workspace");
  if (!existsSync(chosen)) mkdirSync(chosen, { recursive: true, mode: 0o700 });
  if (lstatSync(chosen).isSymbolicLink() || realpathSync(chosen) !== chosen || !statSync(chosen).isDirectory()
    || (statSync(chosen).mode & 0o077) !== 0 || statSync(chosen).uid !== process.getuid())
    throw new Error("Dedicated Codex home must be a private, owned real directory (mode 700)");
  if (!config.policy || Object.keys(config.policy).some(key => !["approvalPolicy", "sandbox"].includes(key))
    || config.policy?.approvalPolicy !== "never" || !["read-only", "workspace-write"].includes(config.policy?.sandbox))
    throw new Error("This unattended CLI requires explicit approvalPolicy never and read-only or workspace-write sandbox; interactive requests are declined");
  for (const [key, fallback, maximum] of [["requestTimeoutMs", 30000, 120000], ["turnTimeoutMs", 300000, 3600000]]) {
    const value = config[key] ?? fallback;
    if (!Number.isInteger(value) || value < 100 || value > maximum) throw new Error(`Invalid ${key}`);
  }
  if (config.model !== undefined && (typeof config.model !== "string" || !config.model.trim() || config.model.length > 128)) throw new Error("Invalid model");
  return { ...structuredClone(config), command, cwd, requestTimeoutMs: config.requestTimeoutMs ?? 30000, turnTimeoutMs: config.turnTimeoutMs ?? 300000 };
}

// A dedicated process, never the desktop daemon/proxy or the operator's HOME.
// Runtime policy controls its model tools; clearing environment is not an OS sandbox.
export function openCodexStdio(config, { allowedThreadIds = [], onAttention = () => {} } = {}) {
  const settings = validateCodexRuntimeConfig(config);
  if (process.platform === "win32") throw new Error("This process transport currently requires macOS or Linux");
  const privateHome = join(settings.codexHome, "host-home");
  if (existsSync(privateHome) && (lstatSync(privateHome).isSymbolicLink() || realpathSync(privateHome) !== privateHome))
    throw new Error("Dedicated process HOME cannot be a symlink");
  mkdirSync(privateHome, { recursive: true, mode: 0o700 }); chmodSync(privateHome, 0o700);
  const lock = join(settings.codexHome, ".room-runtime.lock");
  try { mkdirSync(lock, { mode: 0o700 }); } catch { throw new Error("Dedicated runtime is active or unresolved; reconcile its process before clearing .room-runtime.lock"); }
  const args = ["app-server", "--listen", "stdio://", "-c", 'cli_auth_credentials_store="file"',
    "-c", 'shell_environment_policy.inherit="none"', "-c", `approval_policy=${JSON.stringify(settings.policy.approvalPolicy)}`,
    "-c", `sandbox_mode=${JSON.stringify(settings.policy.sandbox)}`,
    ...(settings.model ? ["-c", `model=${JSON.stringify(settings.model)}`] : [])];
  const child = spawn(settings.command, args, { cwd: settings.cwd, detached: true, shell: false,
    env: { HOME: privateHome, CODEX_HOME: settings.codexHome, PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin", LANG: "en_US.UTF-8" },
    stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map(), listeners = new Set(), threads = new Set(allowedThreadIds);
  let nextId = 1, buffer = "", closed = false, initialization, cleanup;
  const MAX = 1024 * 1024;
  const kill = signal => { if (child.pid) try { process.kill(-child.pid, signal); } catch { /* group exited */ } };
  const alive = () => { if (!child.pid) return false; try { process.kill(-child.pid, 0); return true; } catch { return false; } };
  const settle = () => cleanup ??= (async () => {
    kill("SIGTERM");
    if (alive()) await new Promise(resolve => setTimeout(resolve, 200));
    // Escalate for the entire group even if its parent already exited.
    kill("SIGKILL");
    for (let i = 0; i < 100 && alive(); i++) await new Promise(resolve => setTimeout(resolve, 20));
    if (alive()) throw new Error("Runtime process group is unresolved; private profile lock retained");
    try { rmdirSync(lock); } catch { /* retain an unresolved lock */ }
  })();
  const fail = error => {
    if (closed) return;
    closed = true;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear(); settle().catch(() => {});
  };
  const write = value => {
    const line = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(line) > MAX) throw new Error("Runtime frame exceeds limit");
    if (closed) throw new Error("Runtime disconnected; reconcile original attempt");
    child.stdin.write(line, error => { if (error) fail(new Error("Runtime input disconnected; reconcile original attempt")); });
  };
  child.stderr.resume(); // Never echo potentially secret runtime diagnostics.
  child.on("error", () => {
    fail(new Error("Runtime could not start; inspect executable and dedicated configuration"));
  });
  child.stdin.on("error", () => fail(new Error("Runtime input disconnected; reconcile original attempt")));
  child.on("exit", () => fail(new Error("Runtime disconnected; reconcile original attempt")));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX && !buffer.includes("\n")) { fail(new Error("Runtime frame exceeds limit")); return; }
    for (let index; (index = buffer.indexOf("\n")) !== -1;) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try {
        if (Buffer.byteLength(line) > MAX) throw new Error("Runtime frame exceeds limit");
        const message = JSON.parse(line);
        if (message.method && message.id !== undefined) {
          // No approval or user answer may be inferred from room chatter.
          write({ id: message.id, error: { code: -32601, message: "Interactive runtime requests are unsupported by this Room host; no approval was granted." } });
          onAttention({ type: "runtime_attention_required", method: message.method });
        } else if (message.id !== undefined) {
          const entry = pending.get(message.id);
          if (!entry) continue;
          clearTimeout(entry.timer); pending.delete(message.id);
          if (message.error) { const error = new Error("Runtime rejected request; reconcile original attempt"); error.code = message.error.code; entry.reject(error); }
          else {
            if (entry.method === "thread/start" && typeof message.result?.thread?.id === "string") threads.add(message.result.thread.id);
            entry.resolve(message.result);
          }
        } else if (message.method) for (const listener of listeners) listener(message);
        else throw new Error("Invalid runtime frame");
      } catch { fail(new Error("Runtime protocol failure; reconcile original attempt")); return; }
    }
    if (Buffer.byteLength(buffer) > MAX) fail(new Error("Runtime frame exceeds limit"));
  });
  return {
    request(method, params = {}) {
      if (method === "initialize" && initialization) return initialization;
      if (!METHODS.has(method)) return Promise.reject(new Error("Runtime method is outside the Room protocol"));
      if (method !== "initialize" && method !== "thread/start" && !threads.has(params.threadId))
        return Promise.reject(new Error("Runtime thread is outside this Room journal"));
      if (pending.size >= 128) return Promise.reject(new Error("Too many pending runtime requests"));
      const result = new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => fail(new Error("Runtime request timed out; outcome uncertain, do not retry writes")), settings.requestTimeoutMs);
        pending.set(id, { resolve, reject, timer, method });
        try { write({ id, method, params }); } catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
      if (method === "initialize") initialization = result;
      return result;
    },
    notify(method, params = {}) { if (method !== "initialized") throw new Error("Unsupported runtime notification"); write({ method, params }); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async close() {
      fail(new Error("Runtime closed; reconcile unfinished attempts"));
      await settle();
    }
  };
}

// Qualify the required protocol before claiming any Room work. A handshake
// alone is insufficient: some bundled versions expose schemas but cannot read
// or resume turn history. This creates no model turn or external tool action.
export async function checkCodexProtocol(rpc, config, { threadId } = {}) {
  await rpc.request("initialize", { clientInfo: { name: "project_room", title: "Project Room", version: "0.1.0" } });
  rpc.notify("initialized", {});
  try {
    const id = threadId ?? (await rpc.request("thread/start", { cwd: config.cwd, ...config.policy })).thread?.id;
    if (!id) throw new Error("missing thread");
    // Empty new paginated threads are not persisted until a user turn or
    // metadata write. Name this dedicated probe before requesting history.
    if (!threadId) await rpc.request("thread/name/set", { threadId: id, name: "Project Room protocol check" });
    const read = await rpc.request("thread/read", { threadId: id, includeTurns: true });
    if (read.thread?.id !== id || !Array.isArray(read.thread.turns)) throw new Error("invalid history");
    const resumed = await rpc.request("thread/resume", { threadId: id, cwd: config.cwd, ...config.policy });
    if (resumed.thread?.id !== id) throw new Error("invalid resume");
    return { status: "protocol_ready", modelTurnExecuted: false, historyRead: true, resume: true };
  } catch { throw new Error("Codex runtime lacks the required thread history/read/resume protocol or is unavailable. Use a qualified standalone Codex release (tested rust-v0.162.1) and run --check before starting Room work."); }
}
