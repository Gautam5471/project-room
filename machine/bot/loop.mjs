import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { machineEnabled } from "../lib/flags.mjs";
import { configHome, loadConfig } from "../lib/config.mjs";
import { identitySecret } from "../lib/room.mjs";
import { APPROVAL_TTL_MS, ERROR } from "../lib/protocol.mjs";
import { approvalClass, requestApproval, takeApproval } from "../lib/approvals.mjs";
import { appendManifest, captureConsoleFrame, sha256 } from "../lib/recording.mjs";
import { dispatchTool } from "../lib/tools.mjs";
import { deleteGuest, guestName } from "../lib/vms.mjs";
import { normalizeBot, botTierFromRoom, isDesktopTask } from "./config.mjs";
import { createRoomApi } from "./room-api.mjs";
import { queueMatch, sourcesIncomplete, wakePointers } from "./queue.mjs";
import { pickSlot, slotLabel } from "./lease.mjs";
import { stageReceipt, closeClaim } from "./receipts.mjs";
import { createProvider } from "./providers/index.mjs";
import { GUI_MESSAGE } from "./providers/schemas.mjs";
import { readProviderKey } from "./keys.mjs";
import { redact } from "./redact.mjs";

function claimId(prefix) {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

function summarize(result) {
  const content = result?.content;
  const image = Array.isArray(content) ? content.find(item => item?.type === "image" && typeof item.data === "string") : null;
  if (image) return { image: true, bytes: image.data.length };
  if (typeof result?.output === "string") return { output: result.output.slice(0, 500) };
  return { ok: true };
}

export class MachineBot {
  constructor({ home, env = process.env, fetchImpl = globalThis.fetch, provider = null, clock = null, waitMs = 25000, dispatch = dispatchTool, daemon = null } = {}) {
    this.home = home ?? configHome(env);
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.providerOverride = provider;
    this.clock = clock ?? (() => Date.now());
    this.waitMs = waitMs;
    this.dispatch = dispatch;
    this.daemon = daemon;
    this.stopped = false;
    this.abort = new AbortController();
    this.memberIds = new Map();
    this.provider = null;
    this.pending = null;
    this.active = null;
    this.toolRuntime = null;
    this.loadState();
  }

  isEnabled() {
    if (!machineEnabled(this.env)) return false;
    return normalizeBot(loadConfig(this.home).bot).enabled === true;
  }

  statePath() {
    return join(this.home, "bot-state.json");
  }

  loadState() {
    const path = this.statePath();
    if (!existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      this.pending = parsed.pending ?? null;
      this.active = parsed.active ?? null;
      if (this.active) this.active.observations = [];
    } catch {
      this.pending = null;
      this.active = null;
    }
  }

  async saveState() {
    const secrets = await this.secrets();
    const payload = {
      pending: this.pending,
      active: this.active ? { ...this.active, observations: undefined } : null,
    };
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath()}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${redact(JSON.stringify(payload), secrets)}\n`, { mode: 0o600 });
    renameSync(temporary, this.statePath());
  }

  async secrets() {
    const key = this.config?.provider ? await readProviderKey(this.config.provider, this.home) : null;
    return [key, this.secret].filter(value => typeof value === "string" && value.length >= 8);
  }

  sleep(ms) {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }

  async stop() {
    this.stopped = true;
    this.abort.abort();
  }

  async run() {
    while (!this.stopped) {
      let result = null, failed = false;
      try { result = await this.once(); } catch { failed = true; }
      if (this.stopped) return;
      // A halted or paused machine leaves its wakes unacked, so the next
      // heartbeat hands them straight back; wait instead of spinning on them.
      const held = (result?.results ?? []).some(item => item?.halted || item?.paused);
      if (failed || result?.deliveryPending || result?.polled === false || (this.pending && !this.active) || held) await this.sleep(1000);
    }
  }

  async once() {
    if (!this.isEnabled()) return { enabled: false };
    if (this.stopped) return { enabled: true, stopped: true };
    const config = loadConfig(this.home);
    this.config = config;
    this.bot = normalizeBot(config.bot);
    const secret = await identitySecret(this.home);
    if (!secret || !config.roomOrigin) return { enabled: true, enrolled: false };
    this.secret = secret;
    this.api = createRoomApi({ origin: config.roomOrigin, secret, signal: this.abort.signal });
    if (this.pending) await this.tryGo();
    if (this.active) return { enabled: true, ...(await this.continueActive()) };
    const beat = await this.api.heartbeat();
    let signals = beat.ok ? wakePointers(beat.value) : [];
    if (signals.length === 0) {
      const page = await this.api.poll(this.pending ? 0 : this.waitMs);
      if (this.stopped) return { enabled: true, stopped: true };
      if (!page.ok) return { enabled: true, polled: false, status: page.status };
      signals = wakePointers(page.value);
    }
    if (this.stopped) return { enabled: true, stopped: true };
    const results = [];
    for (const signal of signals) {
      if (this.stopped) break;
      results.push(await this.handleSignal(signal));
      if (this.active) {
        results.push(await this.continueActive());
        break;
      }
    }
    return { enabled: true, results };
  }

  async memberId(roomId) {
    if (this.memberIds.has(roomId)) return this.memberIds.get(roomId);
    const view = await this.api.pause(roomId);
    const id = view.value?.memberId;
    if (typeof id === "string" && id) this.memberIds.set(roomId, id);
    return this.memberIds.get(roomId) ?? null;
  }

  async tierFor(roomId) {
    const memberId = await this.memberId(roomId);
    if (!memberId) return this.bot.tier;
    const report = await this.api.tier(roomId, memberId);
    if (!report.ok) return this.bot.tier;
    return botTierFromRoom(report.value, this.bot.tier);
  }

  async resolveProvider() {
    if (this.providerOverride) return this.providerOverride;
    if (this.provider) return this.provider;
    const key = await readProviderKey(this.config.provider, this.home);
    this.provider = await createProvider({
      name: this.config.provider,
      key,
      model: this.bot.model,
      fetchImpl: this.fetchImpl,
    });
    return this.provider;
  }

  async post(roomId, body, replyToId) {
    const secrets = await this.secrets();
    return this.api.post(roomId, body, { replyToId, secrets });
  }

  async reply(roomId, body, replyToId, updateId, basisToken) {
    const posted = await this.post(roomId, body, replyToId);
    if (posted.ok && updateId) await this.api.markUpdate(roomId, updateId, "done", basisToken);
    return posted;
  }

  async handleSignal(signal) {
    const roomId = signal?.roomId;
    const signalId = signal?.signalId;
    if (typeof roomId !== "string" || !this.bot.rooms.includes(roomId)) {
      await this.api.ack([signalId].filter(Boolean));
      return { signalId, ignored: "allowlist" };
    }
    const queued = await this.readQueue(roomId, signal);
    if (!queued.ok) {
      if (queued.reason === "membership" || queued.reason === "handled") await this.api.ack([signalId].filter(Boolean));
      return { signalId, ignored: queued.reason };
    }
    const source = await this.readSource(roomId, signal, queued);
    if (!source.ok) {
      if (source.reason === "membership" || source.reason === "handled") await this.api.ack([signalId].filter(Boolean));
      return { signalId, ignored: source.reason };
    }
    // A halted machine takes no new work. Leave the wake unacked, as a pause
    // does: claiming the item only to block it at the first step took it off
    // the board and consumed the wake, so nobody picked it up after resume.
    if (this.isHalted()) return { signalId, halted: true };
    if (await this.isPaused(roomId)) return { signalId, paused: true };
    const provider = await this.resolveProvider();
    if (provider.name === "none" || provider.missingKey === true) {
      await this.reply(roomId, provider.message, source.messageId, source.updateId, source.basisToken);
      await this.api.ack([signalId]);
      return { signalId, refused: provider.name };
    }
    if (isDesktopTask(source.text) && provider.computerUse !== true) {
      await this.reply(roomId, GUI_MESSAGE, source.messageId, source.updateId, source.basisToken);
      await this.api.ack([signalId]);
      return { signalId, refused: "desktop" };
    }
    const tier = await this.tierFor(roomId);
    const actNow = tier === "t3" || (tier === "t2" && source.kind === "work");
    if (!actNow && source.kind !== "work" && tier === "t2") {
      await this.reply(roomId, "I take board items assigned to me. I did not start from this mention.", source.messageId, source.updateId, source.basisToken);
      await this.api.ack([signalId]);
      return { signalId, ignored: "tier" };
    }
    if (!actNow) {
      const plan = await this.reply(roomId, `Plan: ${source.text.trim().slice(0, 400)} Reply go and I will start.`, source.messageId, source.updateId, source.basisToken);
      if (!plan.ok) return { signalId, ignored: "unread" };
      this.pending = { ...source, planMessageId: plan.messageId, tier };
      await this.saveState();
      await this.api.ack([signalId]);
      return { signalId, planned: true, planMessageId: plan.messageId };
    }
    await this.api.ack([signalId]);
    await this.begin(source);
    return { signalId, started: Boolean(this.active) };
  }

  async readQueue(roomId, signal) {
    const orient = await this.api.orient(roomId);
    if (orient.status === 403 || orient.status === 404) return { ok: false, reason: "membership" };
    if (!orient.ok) return { ok: false, reason: "unread" };
    const memberId = orient.value?.you?.member?.id ?? orient.value?.member?.id;
    if (typeof memberId === "string" && memberId) this.memberIds.set(roomId, memberId);
    const updates = await this.api.updates(roomId);
    if (updates.status === 403 || updates.status === 404) return { ok: false, reason: "membership" };
    if (!updates.ok) return { ok: false, reason: "unread" };
    const match = queueMatch(signal, { updates: updates.value?.items ?? [], orient: orient.value });
    if (match) return { ok: true, ...match };
    if (sourcesIncomplete(updates.value?.incompleteSources)) return { ok: true, fallback: true };
    return { ok: false, reason: "handled" };
  }

  async readSource(roomId, signal, queued = {}) {
    const pointedMessage = typeof queued.messageId === "string" ? queued.messageId : null;
    const pointedWork = typeof queued.workItemId === "string" ? queued.workItemId : null;
    const workItemId = pointedMessage ? null : (pointedWork ?? (signal.kind === "work" ? signal.workItemId : null));
    if (typeof workItemId === "string") {
      const item = await this.api.claim(roomId, workItemId);
      if (item.status === 403) return { ok: false, reason: "membership" };
      if (item.ok && item.value) {
        return {
          ok: true,
          kind: "work",
          roomId,
          messageId: null,
          workItemId,
          updateId: queued.updateId ?? null,
          basisToken: queued.basisToken ?? null,
          text: String(item.value.title ?? queued.title ?? workItemId),
        };
      }
      if (typeof queued.title === "string" && queued.title && item.status === 404) {
        return {
          ok: true,
          kind: "work",
          roomId,
          messageId: null,
          workItemId,
          updateId: queued.updateId ?? null,
          basisToken: queued.basisToken ?? null,
          text: queued.title,
        };
      }
      return { ok: false, reason: item.status === 404 ? "handled" : "unread" };
    }
    const messageId = pointedMessage ?? signal.messageId;
    if (typeof messageId !== "string" || messageId.startsWith("work-claim:")) {
      return { ok: false, reason: queued.fallback ? "unread" : "handled" };
    }
    const page = await this.api.conversation(roomId, { messageId });
    if (page.status === 403 || page.status === 404) return { ok: false, reason: "membership" };
    if (!page.ok) return { ok: false, reason: "unread" };
    const message = page.value?.messages?.[0];
    if (!message || typeof message.body !== "string") return { ok: false, reason: "unread" };
    if (typeof page.value?.viewerId === "string") this.memberIds.set(roomId, page.value.viewerId);
    const kind = queued.kind === "dm" || signal.kind === "dm" ? "dm" : "mention";
    return {
      ok: true,
      kind,
      roomId,
      messageId: message.id ?? messageId,
      updateId: queued.updateId ?? null,
      basisToken: queued.basisToken ?? null,
      text: message.body,
    };
  }

  async tryGo() {
    const pending = this.pending;
    if (!pending) return;
    if (this.isHalted()) return; // never start new work while halted
    const page = await this.api.conversation(pending.roomId, { limit: 40 });
    if (!page.ok) return;
    const allowed = new Set([this.config.ownerMemberId, ...this.bot.goMembers].filter(id => typeof id === "string" && id));
    const reply = [...(page.value?.messages ?? [])].reverse().find(message =>
      String(message.body ?? "").trim() === "go"
      && allowed.has(message.authorId)
      && (message.replyToId === pending.planMessageId || message.replyToId === pending.messageId));
    if (!reply) return;
    this.pending = null;
    await this.saveState();
    await this.begin(pending);
  }

  async begin(source) {
    if (this.isHalted() || await this.isPaused(source.roomId)) return;
    const memberId = await this.memberId(source.roomId);
    const listed = await this.api.claims(source.roomId);
    const claims = listed.value?.claims ?? [];
    const machineId = this.config.machineId || "machine";
    const picked = pickSlot(claims, machineId, memberId, this.clock());
    if (!picked.slot) {
      await this.reply(source.roomId, "Desk and scratch are both leased. I did not start.", source.messageId, source.updateId, source.basisToken);
      return;
    }
    const work = await this.ensureWork(source, memberId);
    if (!work) {
      await this.reply(source.roomId, "I could not claim this on the board.", source.messageId, source.updateId, source.basisToken);
      return;
    }
    const lease = picked.existing ?? await this.ensureLease(source, work.id, picked.slot, machineId);
    if (!lease) {
      await this.reply(source.roomId, "I could not lease a desktop slot.", source.messageId, source.updateId, source.basisToken);
      await this.api.updateClaim(source.roomId, work.id, { state: "blocked", note: "no slot" });
      return;
    }
    this.provider = await this.resolveProvider();
    this.active = {
      roomId: source.roomId,
      messageId: source.messageId,
      text: source.text,
      updateId: source.updateId ?? null,
      basisToken: source.basisToken ?? null,
      workId: work.id,
      leaseId: lease.id,
      slot: picked.slot,
      steps: 0,
      spendUsd: 0,
      startedAt: this.clock(),
      lastProgressAt: this.clock(),
      observations: [],
    };
    await this.saveState();
  }

  async ensureWork(source, memberId) {
    if (source.workItemId) {
      const existing = await this.api.claim(source.roomId, source.workItemId);
      const item = existing.value;
      if (item?.state === "unclaimed") {
        const taken = await this.api.takeClaim(source.roomId, item.id, { leaseHours: 0.5, note: "bot" });
        if (taken.ok) return taken.value;
      }
      if (item && item.owner === memberId && item.state !== "done" && item.state !== "unclaimed") return item;
    }
    const id = claimId("botw");
    const title = source.text.trim().slice(0, 200) || id;
    const created = await this.api.createClaim(source.roomId, {
      id, title, kind: "work", reviewPolicy: "self_attested", note: "bot",
    });
    if (!created.ok) return null;
    const taken = await this.api.takeClaim(source.roomId, id, { leaseHours: 0.5, note: "bot" });
    return taken.ok ? taken.value : null;
  }

  async ensureLease(source, workId, slot, machineId) {
    const id = claimId(`botl-${slot}`);
    const created = await this.api.createClaim(source.roomId, {
      id,
      title: `Lease ${slot}`,
      kind: "work",
      reviewPolicy: "self_attested",
      files: [slotLabel(machineId, slot)],
      dependsOn: [workId],
      note: "bot lease",
    });
    if (!created.ok) return null;
    const taken = await this.api.takeClaim(source.roomId, id, { leaseHours: 0.5, note: "bot lease" });
    return taken.ok ? taken.value : null;
  }

  budgetReason() {
    const active = this.active;
    if (!active) return null;
    if (active.steps >= this.bot.maxSteps) return `I stopped because I reached the step limit (${this.bot.maxSteps}).`;
    if (this.clock() - active.startedAt >= this.bot.maxWallMs) return "I stopped because I reached the time limit.";
    if (active.spendUsd >= this.bot.maxSpendUsd) return `I stopped because I reached the spend limit (${this.bot.maxSpendUsd}).`;
    return null;
  }

  async isPaused(roomId) {
    const until = this.daemon?.state?.pausedUntil;
    if (until && this.clock() < until) return true;
    const view = await this.api.pause(roomId);
    if (!view.ok) return false;
    return Boolean(view.value?.pause);
  }

  isHalted() {
    return this.daemon?.state?.halted === true;
  }

  // Called by the daemon when a relay halt arrives: release the active claim
  // and stop before the next step. The halted state persists across restarts
  // until the operator resumes, so the bot must not pick the work back up.
  async haltActive() {
    if (this.active?.completion) return { halted: true, deliveryPending: true };
    if (!this.active) return { stopped: true };
    return this.stopEarly("Halted by the operator. I stopped before the next step.");
  }

  async continueActive() {
    // Finished execution resumes delivery, never another model/tool turn.
    if (this.active?.completion) {
      if (this.stopped || this.isHalted()) return { halted: true, deliveryPending: true };
      if (await this.isPaused(this.active.roomId)) return { paused: true, deliveryPending: true };
      return this.finish();
    }
    // A persisted task loaded while already halted must be stopped and
    // cleared via stopEarly — not silently left active by the loop guard.
    if (this.isHalted()) return this.stopEarly("Halted by the operator. I stopped before the next step.");
    while (this.active && !this.stopped) {
      if (this.isHalted()) return this.stopEarly("Halted by the operator. I stopped before the next step.");
      if (await this.isPaused(this.active.roomId)) return this.stopEarly("Paused. I stopped before the next step.");
      const lost = await this.boardStop();
      if (lost) return this.stopReleased(lost);
      const before = this.budgetReason();
      if (before) return this.stopEarly(before);
      const observations = this.active.observations;
      this.active.observations = [];
      const provider = this.provider ?? await this.resolveProvider();
      const turn = await provider.next({ task: this.active.text, observations });
      this.active.spendUsd += Number(turn.costUsd) || 0;
      if (turn.error && !(turn.actions ?? []).length) return this.stopEarly(turn.error);
      const after = this.budgetReason();
      if (after) return this.stopEarly(after);
      if (!(turn.actions ?? []).length) {
        const gone = await this.boardStop();
        if (gone) return this.stopReleased(gone);
        return this.finish(turn.text || "Done.");
      }
      for (const action of turn.actions) {
        if (this.stopped) return { stopped: true };
        if (this.isHalted()) return this.stopEarly("Halted by the operator. I stopped before the next step.");
        if (await this.isPaused(this.active.roomId)) return this.stopEarly("Paused. I stopped before the next step.");
        const released = await this.boardStop();
        if (released) return this.stopReleased(released);
        const reason = this.budgetReason();
        if (reason) return this.stopEarly(reason);
        const executed = await this.execute(action);
        if (!executed.ok) return this.stopEarly(executed.message);
        this.active.steps += 1;
        this.active.observations.push(executed.observation);
        await this.maybeProgress();
      }
    }
    return { stopped: this.stopped === true };
  }

  async maybeProgress() {
    if (!this.active) return;
    if (this.clock() - this.active.lastProgressAt < this.bot.progressIntervalMs) return;
    this.active.lastProgressAt = this.clock();
    await this.post(this.active.roomId, `Still working. Step ${this.active.steps}.`, this.active.messageId);
    await this.saveState();
  }

  async execute(action) {
    const tool = action.tool;
    const args = action.args ?? {};
    const className = approvalClass({ tool, slot: this.active.slot, args });
    if (className) {
      const approved = await this.approve(className, tool);
      if (!approved.ok) return approved;
    }
    let state;
    try {
      state = this.toolState();
    } catch (error) {
      return { ok: false, message: error.message };
    }
    const dispatched = await this.dispatch({
      tool, args, slot: this.active.slot, claimId: this.active.leaseId, state, home: this.home,
    });
    if (!dispatched.ok) return { ok: false, message: dispatched.error?.message ?? "The tool failed." };
    let frameHash = null;
    if (String(tool).startsWith("desktop.")) {
      const vm = this.active.slot === "scratch" ? guestName("scratch", this.active.leaseId) : "desk";
      const frame = await captureConsoleFrame(this.home, this.active.leaseId, vm);
      frameHash = frame?.hash ?? null;
    }
    appendManifest(this.home, this.active.leaseId, {
      at: new Date(this.clock()).toISOString(),
      tool,
      args,
      resultHash: sha256(Buffer.from(JSON.stringify(dispatched.result ?? null))),
      frameHash,
    });
    const content = dispatched.result?.content;
    const image = Array.isArray(content) ? content.find(item => item?.type === "image" && typeof item.data === "string") : null;
    return {
      ok: true,
      observation: {
        tool,
        id: action.id ?? null,
        callId: action.callId ?? null,
        ok: true,
        result: summarize(dispatched.result),
        image: image && image.data.length < 200_000 ? `data:${image.mimeType || "image/png"};base64,${image.data}` : null,
      },
    };
  }

  toolState() {
    const state = this.daemon?.state ?? (this.toolRuntime ??= {
      running: {}, slots: { desk: null, scratch: null }, halted: false, snapshots: {},
    });
    // M2: never stomp a slot another lease holds. The daemon's own call()
    // path rejects foreign claimIds with SLOT_HELD; the bot must apply the
    // same rule before writing instead of blindly overwriting.
    // Known limit: a relay lease minted but not yet used through the daemon
    // is not in state.slots until its first call. The window is narrow (the
    // lease must arrive between the bot's check and its first write), and
    // the daemon still rejects the late arrival with SLOT_HELD rather than
    // interleaving work.
    const held = state.slots[this.active.slot];
    if (held && held.claimId !== this.active.leaseId) {
      throw new Error(`Slot ${this.active.slot} is held by another lease; the bot refused to seize it.`);
    }
    state.slots[this.active.slot] = {
      claimId: this.active.leaseId,
      identityId: this.memberIds.get(this.active.roomId) ?? "bot",
    };
    return state;
  }

  async approve(className, detail) {
    const requested = await requestApproval({
      home: this.home,
      origin: this.config.roomOrigin,
      roomId: this.active.roomId,
      secret: this.secret,
      ownerMemberId: this.config.ownerMemberId,
      className,
      detail,
    });
    if (!requested.ok) return { ok: false, message: "I could not ask for approval." };
    const waitMs = Number(this.env.ROOM_MACHINE_APPROVAL_WAIT_MS);
    const budget = Number.isFinite(waitMs) && waitMs >= 0 ? waitMs : APPROVAL_TTL_MS;
    const deadline = this.clock() + budget;
    while (this.clock() <= deadline && !this.stopped) {
      const taken = await takeApproval({
        home: this.home,
        origin: this.config.roomOrigin,
        roomId: this.active.roomId,
        secret: this.secret,
        code: requested.code,
        now: this.clock(),
      });
      if (taken.ok) return { ok: true };
      if (taken.reason === ERROR.APPROVAL_DENIED) return { ok: false, message: "The owner did not approve this." };
      await this.sleep(40);
    }
    return { ok: false, message: "The approval expired before the owner replied." };
  }

  // Independent Stop for one task: the owner (or a claim manager) stops this
  // bot's task by releasing, reassigning or closing its board item, without
  // halting the machine. Re-read the item between steps; a transient read
  // failure keeps working, a missing or no-longer-held item stops.
  async boardStop() {
    const active = this.active;
    if (!active?.workId || typeof this.api?.claim !== "function") return null;
    const read = await this.api.claim(active.roomId, active.workId);
    if (!read.ok) {
      return read.status === 404 || read.status === 410
        ? "This item was removed from the board. I stopped before the next step."
        : null;
    }
    const item = read.value ?? {};
    const memberId = this.memberIds.get(active.roomId) ?? null;
    if (item.state === "unclaimed") return "This item was released on the board. I stopped before the next step.";
    if (item.state === "done" || item.state === "closed") return "This item was closed on the board. I stopped before the next step.";
    if (memberId && item.owner && item.owner !== memberId) return "This item was reassigned on the board. I stopped before the next step.";
    return null;
  }

  // Like stopEarly, but the work item is no longer ours: give back the slot
  // lease and leave the item where its new holder (or the owner) put it.
  async stopReleased(message) {
    const active = this.active;
    if (!active) return { stopped: true };
    await this.reply(active.roomId, message, active.messageId, active.updateId, active.basisToken);
    await this.api.updateClaim(active.roomId, active.leaseId, { state: "unclaimed", note: message.slice(0, 200) });
    this.clearSlot(active);
    this.active = null;
    await this.saveState();
    return { stopped: true, released: true, message };
  }

  async stopEarly(message) {
    const active = this.active;
    if (!active) return { stopped: true };
    await this.reply(active.roomId, message, active.messageId, active.updateId, active.basisToken);
    await this.api.updateClaim(active.roomId, active.leaseId, { state: "unclaimed", note: message.slice(0, 200) });
    await this.api.updateClaim(active.roomId, active.workId, { state: "blocked", note: message.slice(0, 200) });
    this.clearSlot(active);
    this.active = null;
    await this.saveState();
    return { stopped: true, message };
  }

  clearSlot(active) {
    const state = this.daemon?.state ?? this.toolRuntime;
    if (state?.slots?.[active.slot]?.claimId === active.leaseId) state.slots[active.slot] = null;
    if (active.slot === "scratch" && state) {
      deleteGuest(state, guestName("scratch", active.leaseId)).catch(() => {});
    }
  }

  async finish(text) {
    const active = this.active;
    if (!active.completion) {
      active.completion = { text: redact(text, await this.secrets()), messageId: randomUUID(), updateRequestId: randomUUID() };
      await this.saveState();
    }
    const completion = active.completion;
    const held = () => this.stopped || this.isHalted();
    if (held()) return { halted: true, deliveryPending: true };
    if (!completion.receipt) {
      const receipt = await stageReceipt({
        origin: this.config.roomOrigin, roomId: active.roomId, secret: this.secret,
        home: this.home, claimId: active.leaseId, label: this.config.label, slot: active.slot, isStopped: held,
      });
      if (!receipt.ok) return { deliveryPending: true, stage: "receipt", status: receipt.status };
      completion.receipt = receipt;
      await this.saveState();
    }
    const receipt = completion.receipt, note = completion.text.slice(0, 400);
    for (const field of ['leaseId', 'workId']) {
      if (completion[field]) continue;
      if (held()) return { halted: true, deliveryPending: true };
      const closed = await closeClaim(this.config.roomOrigin, active.roomId, this.secret, active[field], {
        blobs: receipt.blobs, tags: receipt.tags, note, requestId: `${completion.messageId}-${field}`, isStopped: held,
      });
      if (!closed.ok) return { deliveryPending: true, stage: field, status: closed.status };
      completion[field] = true;
      await this.saveState();
    }
    if (!completion.posted) {
      if (held()) return { halted: true, deliveryPending: true };
      const body = [completion.text, ...(receipt.blobs.length ? [`Receipt ${receipt.blobs.join(" ")}`] : [])].join("\n");
      const posted = await this.api.post(active.roomId, body, { replyToId: active.messageId, messageId: completion.messageId });
      if (!posted.ok) return { deliveryPending: true, stage: 'message', status: posted.status };
      completion.posted = true;
      await this.saveState();
    }
    if (held()) return { halted: true, deliveryPending: true };
    if (active.updateId && active.basisToken) {
      const marked = await this.api.markUpdate(active.roomId, active.updateId, 'done', active.basisToken, completion.updateRequestId);
      // A newer update must remain actionable; never fetch a new basis just to clear it.
      if (!marked.ok && !['update_changed', 'update_not_found'].includes(marked.value?.error?.code)) return { deliveryPending: true, stage: 'update', status: marked.status };
    }
    this.clearSlot(active);
    this.active = null;
    await this.saveState();
    return { done: true, closed: true, blobs: receipt.blobs, workId: active.workId, leaseId: active.leaseId };
  }
}

export function attachBot(daemon) {
  const bot = new MachineBot({ home: daemon.home, env: daemon.env, daemon });
  daemon.botLoop = bot; // let the daemon halt the bot's active execution
  if (!bot.isEnabled()) return async () => {};
  const done = bot.run();
  return async () => {
    await bot.stop();
    await done;
  };
}
