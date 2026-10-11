// Public pages read these tables and nothing from rooms.projection.
// Rows are written when an owner opts in, updated in the same transaction
// as the change, and removed when they opt out. The cron backfill copies
// rooms that opted in before the tables existed. It never runs from the
// Durable Object constructor.
import { createHash } from "node:crypto";
import { publicPage, joinLink, publicName, publicTask, publicReceipts } from "../src/events.js";
import { isUnpublished } from "./legal-store.mjs"; // operator unpublish hides a room or receipt from every public read

export const PUBLIC_START_URL = "https://room.trydemigod.com/?start=room";
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OPEN = new Set(["proposed", "accepted", "working", "blocked"]);
export const PUBLIC_RECEIPT_ID = /^(?:pwr_[a-f0-9]{16,128}|wcr_[a-f0-9]{32}|wir_[a-f0-9]{32})$/;
export const DIRECTORY_PAGE_SIZE = 50;
export const PUBLIC_BACKFILL_BATCH = 20;

export const PUBLIC_READ_MODEL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS public_receipts (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    source TEXT NOT NULL,
    origin_room_id TEXT,
    room_id TEXT,
    room_title TEXT,
    agents_json TEXT NOT NULL,
    humans_json TEXT NOT NULL,
    pull_request TEXT,
    merged_at TEXT,
    hashes_json TEXT NOT NULL,
    at TEXT NOT NULL,
    start_href TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS public_receipts_listing ON public_receipts(at DESC, id ASC);
  CREATE INDEX IF NOT EXISTS public_receipts_room ON public_receipts(room_id, at DESC, id ASC);
  CREATE INDEX IF NOT EXISTS public_receipts_origin ON public_receipts(origin_room_id, source);
  CREATE TABLE IF NOT EXISTS public_rooms (
    slug TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    purpose TEXT NOT NULL,
    humans INTEGER NOT NULL,
    agents INTEGER NOT NULL,
    names_json TEXT NOT NULL,
    tasks_json TEXT NOT NULL,
    members_json TEXT NOT NULL,
    receipts_enabled INTEGER NOT NULL,
    join_mode TEXT NOT NULL,
    join_token TEXT,
    owner_member_id TEXT,
    set_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS public_rooms_listing ON public_rooms(updated_at DESC, slug ASC);
  CREATE TABLE IF NOT EXISTS public_directory_entries (
    agent_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    skills_json TEXT NOT NULL,
    identity_id TEXT,
    receipt_count INTEGER NOT NULL,
    room_count INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS public_directory_listing ON public_directory_entries(name ASC, agent_id ASC);
  CREATE TABLE IF NOT EXISTS public_read_model_backfill (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    phase TEXT NOT NULL,
    cursor TEXT,
    done INTEGER NOT NULL
  );
`;

const hashId = (prefix, roomId, localId) =>
  `${prefix}_${createHash("sha256").update(`${roomId}\0${localId}`).digest("hex").slice(0, 32)}`;

const httpsUrl = value => {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
};

const pullRequestUrl = value => {
  const url = httpsUrl(value);
  return url && /\/pull\/\d+(?:$|[/?#])/.test(url) ? url : null;
};

const hashList = values => [...new Set(values.filter(value => SHA256.test(value)))];

const iso = value => {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return null;
};

const cleanName = value => {
  if (typeof value !== "string") return null;
  const name = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return name ? name.slice(0, 80) : null;
};

const parseJson = (text, fallback) => {
  try {
    const value = JSON.parse(text);
    return value ?? fallback;
  } catch { return fallback; }
};

function credit(state, memberId) {
  if (typeof memberId !== "string" || !state?.members || !Object.hasOwn(state.members, memberId)) return null;
  const member = state.members[memberId];
  if (!member || member.active === false) return null;
  const name = cleanName(member.displayName) ?? memberId;
  return { name, kind: member.kind === "human" ? "human" : "agent" };
}

// A member can store outcome "merged" on a claim. The public page repeats a
// merge only after this server settled it: the poll writes pr_merged, done,
// and syncedAt together. The write path that stops members setting outcome
// is separate.
function serverVerifiedMerge(item) {
  const pull = item?.pullRequest;
  if (!item || item.state !== "done" || pull?.outcome !== "merged" || !iso(pull.syncedAt)) return false;
  const history = Array.isArray(item.history) ? item.history : [];
  return history.some(step => step?.action === "pr_merged");
}

function creditsFrom(people) {
  const agents = [], humans = [];
  for (const person of people) {
    if (!person) continue;
    const list = person.kind === "human" ? humans : agents;
    if (!list.includes(person.name)) list.push(person.name);
  }
  return { agents, humans };
}

function startHref(ownerName) {
  const url = new URL(PUBLIC_START_URL);
  const ref = cleanName(ownerName);
  if (ref) url.searchParams.set("ref", ref);
  return url.href;
}

function isListed(store, roomId) {
  if (typeof roomId !== "string" || !roomId) return false;
  if (store.db.prepare("SELECT 1 FROM room_directory_settings WHERE room_id=? AND discoverable=1").get(roomId)) return true;
  return Boolean(store.db.prepare("SELECT 1 FROM room_public_settings WHERE room_id=? AND enabled=1").get(roomId));
}

function rowToPublic(row) {
  return {
    schema: "project-room-public-receipt/1",
    id: row.id,
    title: row.title,
    source: row.source,
    room: row.room_id ? { id: row.room_id, title: row.room_title ?? null } : null,
    agents: parseJson(row.agents_json, []),
    humans: parseJson(row.humans_json, []),
    pullRequest: row.pull_request,
    mergedAt: row.merged_at,
    hashes: parseJson(row.hashes_json, []),
    at: row.at,
    startHref: row.start_href,
  };
}

const RECEIPT_COLUMNS = `id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json, pull_request, merged_at, hashes_json, at, start_href`;

function insertReceipt(store, row) {
  store.db.prepare(`INSERT INTO public_receipts (${RECEIPT_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title, source=excluded.source, origin_room_id=excluded.origin_room_id,
      room_id=excluded.room_id, room_title=excluded.room_title, agents_json=excluded.agents_json,
      humans_json=excluded.humans_json, pull_request=excluded.pull_request, merged_at=excluded.merged_at,
      hashes_json=excluded.hashes_json, at=excluded.at, start_href=excluded.start_href`
  ).run(row.id, row.title, row.source, row.originRoomId, row.roomId, row.roomTitle, JSON.stringify(row.agents),
    JSON.stringify(row.humans), row.pullRequest, row.mergedAt, JSON.stringify(row.hashes), row.at, row.startHref);
}

function listedRoomFields(state, listed) {
  if (!listed || !state?.room?.id) return { roomId: null, roomTitle: null };
  return { roomId: state.room.id, roomTitle: cleanName(state.room.title) };
}

function optedInRows(store, state) {
  const roomId = state?.room?.id;
  if (!roomId || publicReceipts(state).enabled !== true) return [];
  const listed = isListed(store, roomId);
  const room = listedRoomFields(state, listed);
  const owner = credit(state, state.room?.ownerId);
  const href = startHref(owner?.name);
  const rows = [];
  let claims = [];
  try { claims = store.workClaims?.list?.(roomId) ?? []; } catch { claims = []; }
  for (const item of claims) {
    if (!serverVerifiedMerge(item)) continue;
    const people = [credit(state, item.owner)];
    for (const step of Array.isArray(item.history) ? item.history : []) people.push(credit(state, step?.agentId));
    const { agents, humans } = creditsFrom(people);
    rows.push({
      id: hashId("wcr", roomId, item.id),
      title: cleanName(item.title) ?? "Receipt",
      source: "work-claim",
      originRoomId: roomId,
      roomId: room.roomId,
      roomTitle: room.roomTitle,
      agents, humans,
      pullRequest: pullRequestUrl(item.pullRequest?.url),
      mergedAt: iso(item.pullRequest?.syncedAt),
      hashes: hashList(Array.isArray(item.blobs) ? item.blobs : []),
      at: iso(item.pullRequest?.syncedAt) ?? iso(item.updatedAt) ?? new Date(0).toISOString(),
      startHref: href,
    });
  }
  const items = state.workItems && typeof state.workItems === "object" ? Object.values(state.workItems) : [];
  for (const item of items) {
    if (!item || item.state !== "completed" || !item.receipt || typeof item.receipt !== "object") continue;
    const people = [credit(state, item.receipt.reportedById), credit(state, item.receipt.producerId), credit(state, item.accountableMemberId)];
    const { agents, humans } = creditsFrom(people);
    const version = typeof item.receipt.evidenceVersion === "string" && SHA256.test(item.receipt.evidenceVersion)
      ? item.receipt.evidenceVersion : null;
    rows.push({
      id: hashId("wir", roomId, item.id),
      title: cleanName(item.title) ?? "Receipt",
      source: "work-item",
      originRoomId: roomId,
      roomId: room.roomId,
      roomTitle: room.roomTitle,
      agents, humans,
      pullRequest: pullRequestUrl(item.receipt.evidenceUrl),
      mergedAt: null,
      hashes: hashList(version ? [version] : []),
      at: iso(item.updatedAt) ?? new Date(0).toISOString(),
      startHref: href,
    });
  }
  return rows;
}

function replaceOptedInReceipts(store, state) {
  const roomId = state?.room?.id;
  if (!roomId) return;
  store.db.prepare("DELETE FROM public_receipts WHERE origin_room_id=? AND source IN ('work-claim','work-item')").run(roomId);
  if (publicReceipts(state).enabled !== true) return;
  for (const row of optedInRows(store, state)) insertReceipt(store, row);
}

function touchPublicWorkListing(store, state) {
  const roomId = state?.room?.id;
  if (!roomId) return;
  const listed = isListed(store, roomId);
  const title = listed ? cleanName(state.room?.title) : null;
  const href = startHref(listed ? credit(state, state.room?.ownerId)?.name : null);
  store.db.prepare(`UPDATE public_receipts SET room_id=?, room_title=?, start_href=?
    WHERE origin_room_id=? AND source='public-work'`).run(roomId, title, href, roomId);
}

function memberIndex(state) {
  const members = [];
  for (const member of Object.values(state?.members ?? {})) {
    if (!member || member.active === false || typeof member.id !== "string") continue;
    const name = publicName(member).enabled === true ? cleanName(member.displayName) : null;
    members.push({ id: member.id, name });
  }
  return members;
}

function pageFields(state) {
  const members = Object.values(state?.members ?? {}).filter(member => member && member.active !== false);
  const agents = members.filter(member => member.kind === "agent").length;
  const names = members
    .filter(member => publicName(member).enabled === true && typeof member.displayName === "string")
    .map(member => member.displayName);
  const tasks = Object.values(state?.workItems ?? {})
    .filter(item => item && OPEN.has(item.state) && publicTask(item).enabled === true && typeof item.title === "string")
    .map(item => ({ title: item.title, definitionOfDone: typeof item.definitionOfDone === "string" ? item.definitionOfDone : "" }));
  return {
    humans: members.length - agents,
    agents,
    names,
    tasks,
    members: memberIndex(state),
  };
}

function ownerAuth(store, roomId, state, auth) {
  const ownerId = state?.room?.ownerId;
  const member = ownerId ? state.members?.[ownerId] : null;
  if (!member || member.active === false) return null;
  if (auth?.member?.id === ownerId) return { member: auth.member, account: auth.account ?? null };
  let account = null;
  try {
    const binding = store.db.prepare("SELECT account_id FROM member_accounts WHERE room_id=? AND member_id=?").get(roomId, ownerId);
    if (binding) {
      const row = store.db.prepare("SELECT id, auth_epoch AS authEpoch FROM accounts WHERE id=? AND active=1").get(binding.account_id);
      if (row) account = { id: row.id, authEpoch: row.authEpoch };
    }
  } catch { account = null; }
  return { member, account };
}

function joinTokenFor(store, roomId, state, auth) {
  if (joinLink(state).enabled !== true) return { mode: "request", token: null, ownerId: state?.room?.ownerId ?? null };
  const ownerId = state?.room?.ownerId ?? null;
  const existing = store.db.prepare("SELECT join_token, owner_member_id FROM public_rooms WHERE slug=?").get(roomId);
  if (existing?.join_token && existing.owner_member_id === ownerId) {
    return { mode: "link", token: existing.join_token, ownerId };
  }
  const who = ownerAuth(store, roomId, state, auth);
  if (!who || !store.shareLinks?.personalInvite) return { mode: "request", token: null, ownerId };
  try {
    const minted = store.shareLinks.personalInvite(who, roomId, 25);
    if (minted?.token) return { mode: "link", token: minted.token, ownerId };
  } catch { /* a failed mint leaves the page on the request link */ }
  return { mode: "request", token: null, ownerId };
}

function upsertPublicRoom(store, state, auth) {
  const slug = state?.room?.id;
  if (!SLUG.test(slug ?? "")) return;
  const fields = pageFields(state);
  const join = joinTokenFor(store, slug, state, auth);
  const setAt = publicPage(state).setAt;
  const updatedAt = typeof setAt === "string" ? setAt : new Date().toISOString();
  store.db.prepare(`INSERT INTO public_rooms
    (slug, title, purpose, humans, agents, names_json, tasks_json, members_json, receipts_enabled, join_mode, join_token, owner_member_id, set_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(slug) DO UPDATE SET
      title=excluded.title, purpose=excluded.purpose, humans=excluded.humans, agents=excluded.agents,
      names_json=excluded.names_json, tasks_json=excluded.tasks_json, members_json=excluded.members_json,
      receipts_enabled=excluded.receipts_enabled, join_mode=excluded.join_mode, join_token=excluded.join_token,
      owner_member_id=excluded.owner_member_id, set_at=excluded.set_at, updated_at=excluded.updated_at`
  ).run(slug, typeof state.room.title === "string" ? state.room.title : slug,
    typeof state.room.purpose === "string" ? state.room.purpose : "",
    fields.humans, fields.agents, JSON.stringify(fields.names), JSON.stringify(fields.tasks), JSON.stringify(fields.members),
    publicReceipts(state).enabled === true ? 1 : 0, join.mode, join.token, join.ownerId,
    typeof setAt === "string" ? setAt : null, updatedAt);
}

function refreshLinkedDirectory(store, roomId) {
  const links = store.db.prepare("SELECT DISTINCT identity_id AS identityId FROM identity_links WHERE room_id=?").all(roomId);
  for (const link of links) refreshDirectoryIdentity(store, link.identityId);
}

// Same transaction as the event write when the caller is already inside one.
export function syncRoomPublication(store, { roomId, state, previous = null, auth = null } = {}) {
  if (!roomId || !state?.room) return;
  const pageOn = publicPage(state).enabled === true;
  const pageWas = publicPage(previous).enabled === true;
  const receiptsOn = publicReceipts(state).enabled === true;
  const receiptsWere = publicReceipts(previous).enabled === true;
  if (!pageOn && !pageWas && !receiptsOn && !receiptsWere) return;
  const write = () => {
    if (receiptsOn || receiptsWere) replaceOptedInReceipts(store, state);
    if (pageOn || pageWas || receiptsOn || receiptsWere) touchPublicWorkListing(store, state);
    if (pageOn) upsertPublicRoom(store, state, auth);
    else if (pageWas) store.db.prepare("DELETE FROM public_rooms WHERE slug=?").run(roomId);
    refreshLinkedDirectory(store, roomId);
  };
  if (store.db.isTransaction) write();
  else store.transaction(write);
}

// A claim changed. Refresh that room's public receipts only when it already
// publishes. One indexed lookup; private rooms stop before the projection parse.
export function noteWorkClaimChange(store, roomId) {
  const flags = store.db.prepare(`SELECT json_extract(projection, '$.room.publicReceipts.enabled') AS receipts,
    json_extract(projection, '$.room.publicPage.enabled') AS page FROM rooms WHERE id=?`).get(roomId);
  if (!flags || (flags.receipts !== 1 && flags.page !== 1)) return;
  let state;
  try { state = store.room(roomId).state; } catch { return; }
  syncRoomPublication(store, { roomId, state, previous: state, auth: null });
}

// Directory or public-face listing changed. One room, on the owner's write.
export function refreshListedRoom(store, roomId) {
  let state;
  try { state = store.room(roomId).state; } catch { return; }
  const write = () => {
    touchPublicWorkListing(store, state);
    if (publicReceipts(state).enabled === true) replaceOptedInReceipts(store, state);
  };
  if (store.db.isTransaction) write();
  else store.transaction(write);
}

export function projectPublicWorkReceipt(store, body, artifactSha256 = null) {
  if (!body || typeof body.receiptId !== "string" || !body.receiptId.startsWith("pwr_")) return;
  const roomId = typeof body.namespaceId === "string" ? body.namespaceId : null;
  const listed = roomId ? isListed(store, roomId) : false;
  let roomTitle = null;
  let ownerName = null;
  if (listed) {
    try {
      const state = store.room(roomId).state;
      roomTitle = cleanName(state?.room?.title);
      ownerName = credit(state, state?.room?.ownerId)?.name ?? null;
    } catch { /* the room is gone; the receipt still publishes without its title */ }
  }
  const hashes = hashList([
    HEX64.test(artifactSha256 ?? "") ? `sha256:${artifactSha256}` : null,
    HEX64.test(body.artifact?.sha256 ?? "") ? `sha256:${body.artifact.sha256}` : null,
  ].filter(Boolean));
  const row = {
    id: body.receiptId,
    title: cleanName(body.title) ?? "Public work",
    source: "public-work",
    originRoomId: roomId,
    roomId,
    roomTitle,
    agents: typeof body.agentName === "string" && body.agentName ? [body.agentName]
      : typeof body.identityId === "string" && body.identityId ? [body.identityId] : [],
    humans: [],
    pullRequest: null,
    mergedAt: null,
    hashes,
    at: iso(body.createdAt) ?? new Date(0).toISOString(),
    startHref: startHref(ownerName),
  };
  const write = () => {
    insertReceipt(store, row);
    if (typeof body.identityId === "string") refreshDirectoryIdentity(store, body.identityId);
  };
  if (store.db.isTransaction) write();
  else store.transaction(write);
}

function directoryCounts(store, agentId, identityId) {
  const names = new Set();
  let roomCount = 0;
  if (identityId) {
    const links = store.db.prepare("SELECT room_id AS roomId, member_id AS memberId FROM identity_links WHERE identity_id=?").all(identityId);
    for (const link of links) {
      const room = store.db.prepare("SELECT members_json FROM public_rooms WHERE slug=?").get(link.roomId);
      if (!room) continue;
      const members = parseJson(room.members_json, []);
      const member = members.find(item => item && item.id === link.memberId);
      if (!member) continue;
      roomCount += 1;
      if (typeof member.name === "string" && member.name) names.add(member.name);
    }
  }
  let receiptCount = 0;
  for (const row of store.db.prepare("SELECT agents_json, humans_json FROM public_receipts").all()) {
    const named = [...parseJson(row.agents_json, []), ...parseJson(row.humans_json, [])];
    if (named.includes(agentId) || (identityId && named.includes(identityId)) || named.some(name => names.has(name))) receiptCount += 1;
  }
  return { roomCount, receiptCount };
}

export function syncDirectoryCard(store, agentId) {
  if (typeof agentId !== "string" || !agentId) return;
  const write = () => {
    const row = store.db.prepare(`SELECT card_json, visibility, owner_identity_id AS identityId, withdrawn
      FROM agent_directory_cards WHERE agent_id=?`).get(agentId);
    if (!row || row.withdrawn || row.visibility !== "public") {
      store.db.prepare("DELETE FROM public_directory_entries WHERE agent_id=?").run(agentId);
      return;
    }
    const card = parseJson(row.card_json, {});
    const counts = directoryCounts(store, agentId, row.identityId);
    const skills = Array.isArray(card.skills) ? card.skills.filter(skill => typeof skill === "string") : [];
    store.db.prepare(`INSERT INTO public_directory_entries
      (agent_id, name, description, skills_json, identity_id, receipt_count, room_count, updated_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(agent_id) DO UPDATE SET
        name=excluded.name, description=excluded.description, skills_json=excluded.skills_json,
        identity_id=excluded.identity_id, receipt_count=excluded.receipt_count, room_count=excluded.room_count,
        updated_at=excluded.updated_at`
    ).run(agentId, typeof card.name === "string" && card.name ? card.name : agentId,
      typeof card.description === "string" ? card.description : "",
      JSON.stringify(skills), row.identityId, counts.receiptCount, counts.roomCount, new Date().toISOString());
  };
  if (store.db.isTransaction) write();
  else store.transaction(write);
}

export function refreshDirectoryIdentity(store, identityId) {
  if (typeof identityId !== "string" || !identityId) return;
  const cards = store.db.prepare("SELECT agent_id AS agentId FROM public_directory_entries WHERE identity_id=?").all(identityId);
  for (const card of cards) syncDirectoryCard(store, card.agentId);
}

function backfillCursor(store) {
  let row = store.db.prepare("SELECT phase, cursor, done FROM public_read_model_backfill WHERE id=1").get();
  if (!row) {
    store.db.prepare("INSERT INTO public_read_model_backfill (id, phase, cursor, done) VALUES (1, 'rooms', '', 0)").run();
    row = { phase: "rooms", cursor: "", done: 0 };
  }
  return row;
}

function saveCursor(store, phase, cursor, done) {
  store.db.prepare("UPDATE public_read_model_backfill SET phase=?, cursor=?, done=? WHERE id=1").run(phase, cursor, done ? 1 : 0);
}

// One bounded batch. The worker cron calls this until done is 1.
export function backfillPublicReadModel(store, { limit = PUBLIC_BACKFILL_BATCH, deadline = Infinity } = {}) {
  const cap = Number.isInteger(limit) && limit > 0 && limit <= 100 ? limit : PUBLIC_BACKFILL_BATCH;
  const cursor = backfillCursor(store);
  if (cursor.done) return { done: true, rooms: 0, receipts: 0, cards: 0 };
  const expired = () => Date.now() >= deadline;
  if (cursor.phase === "rooms") {
    const rows = store.db.prepare("SELECT id, projection FROM rooms WHERE id > ? ORDER BY id LIMIT ?").all(cursor.cursor ?? "", cap);
    let rooms = 0;
    let last = cursor.cursor ?? "";
    for (const row of rows) {
      if (expired()) {
        saveCursor(store, "rooms", last, false);
        return { done: false, rooms, receipts: 0, cards: 0, budgetExceeded: true };
      }
      last = row.id;
      rooms += 1;
      try {
        const state = JSON.parse(row.projection);
        if (state?.room?.id) syncRoomPublication(store, { roomId: state.room.id, state, previous: null, auth: null });
      } catch { /* a corrupt projection is not a public page */ }
    }
    if (rows.length < cap) saveCursor(store, "receipts", "", false);
    else saveCursor(store, "rooms", last, false);
    return { done: false, rooms, receipts: 0, cards: 0 };
  }
  if (cursor.phase === "receipts") {
    const rows = store.db.prepare(`SELECT receipt_id, artifact_sha256, receipt_json FROM public_work_receipts
      WHERE receipt_id > ? ORDER BY receipt_id LIMIT ?`).all(cursor.cursor ?? "", cap);
    let receipts = 0;
    let last = cursor.cursor ?? "";
    for (const row of rows) {
      if (expired()) {
        saveCursor(store, "receipts", last, false);
        return { done: false, rooms: 0, receipts, cards: 0, budgetExceeded: true };
      }
      last = row.receipt_id;
      receipts += 1;
      try { projectPublicWorkReceipt(store, JSON.parse(row.receipt_json), row.artifact_sha256); } catch { /* skip a bad receipt */ }
    }
    if (rows.length < cap) saveCursor(store, "directory", "", false);
    else saveCursor(store, "receipts", last, false);
    return { done: false, rooms: 0, receipts, cards: 0 };
  }
  const rows = store.db.prepare(`SELECT agent_id FROM agent_directory_cards
    WHERE visibility='public' AND withdrawn=0 AND agent_id > ? ORDER BY agent_id LIMIT ?`).all(cursor.cursor ?? "", cap);
  let cards = 0;
  let last = cursor.cursor ?? "";
  for (const row of rows) {
    if (expired()) {
      saveCursor(store, "directory", last, false);
      return { done: false, rooms: 0, receipts: 0, cards, budgetExceeded: true };
    }
    last = row.agent_id;
    cards += 1;
    try { syncDirectoryCard(store, row.agent_id); } catch { /* skip a bad card */ }
  }
  if (rows.length < cap) saveCursor(store, "directory", last, true);
  else saveCursor(store, "directory", last, false);
  return { done: rows.length < cap, rooms: 0, receipts: 0, cards };
}

// An unpublished room or receipt stays out of listings, detail reads, and the sitemap.
const HIDDEN_RECEIPT = `NOT EXISTS (
  SELECT 1 FROM public_unpublish u
  WHERE (u.kind='receipt' AND u.target=public_receipts.id)
     OR (u.kind='room' AND u.target=public_receipts.room_id)
     OR (u.kind='room' AND u.target=public_receipts.origin_room_id))`;

const receiptFilter = (room, needle) => {
  const clauses = [];
  const params = [];
  if (room) { clauses.push("room_id=?"); params.push(room); }
  if (needle) { clauses.push("instr(lower(agents_json), ?) > 0"); params.push(needle); }
  return { clauses, params };
};

export function queryPublicReceipts(store, { room = null, agent = null, cursor = null, limit = 20 } = {}) {
  if (room != null && (typeof room !== "string" || !room || room.length > 128)) {
    return { error: { status: 422, code: "invalid_receipt_query", message: "room filter must be a room id" } };
  }
  if (agent != null && (typeof agent !== "string" || !agent.trim() || agent.length > 80)) {
    return { error: { status: 422, code: "invalid_receipt_query", message: "agent filter must be a name" } };
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    return { error: { status: 422, code: "invalid_receipt_query", message: "limit must be an integer from 1 to 50" } };
  }
  const needle = agent ? agent.trim().toLowerCase() : null;
  const filter = receiptFilter(room, needle);
  let after = "";
  const afterParams = [];
  if (cursor != null) {
    if (typeof cursor !== "string" || !cursor) {
      return { error: { status: 422, code: "invalid_receipt_query", message: "cursor is not a receipt from this list" } };
    }
    const where = filter.clauses.length ? `WHERE ${filter.clauses.join(" AND ")} AND id=?` : "WHERE id=?";
    const current = store.db.prepare(`SELECT id, at, agents_json, room_id FROM public_receipts ${where}`).get(...filter.params, cursor);
    if (!current) return { error: { status: 422, code: "invalid_receipt_query", message: "cursor is not a receipt from this list" } };
    after = "(at < ? OR (at = ? AND id > ?))";
    afterParams.push(current.at, current.at, current.id);
  }
  const clauses = [...filter.clauses, HIDDEN_RECEIPT];
  if (after) clauses.push(after);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = store.db.prepare(`SELECT ${RECEIPT_COLUMNS} FROM public_receipts ${where} ORDER BY at DESC, id ASC LIMIT ?`)
    .all(...filter.params, ...afterParams, limit + 1);
  const page = rows.slice(0, limit).map(rowToPublic);
  const nextCursor = rows.length > limit ? page.at(-1)?.id ?? null : null;
  return { receipts: page, nextCursor };
}

export function publicReceiptById(store, id) {
  if (typeof id !== "string" || !PUBLIC_RECEIPT_ID.test(id)) return null;
  const row = store.db.prepare(`SELECT ${RECEIPT_COLUMNS} FROM public_receipts WHERE id=? AND ${HIDDEN_RECEIPT}`).get(id);
  return row ? rowToPublic(row) : null;
}

export function collectPublicReceipts(store) {
  return store.db.prepare(`SELECT ${RECEIPT_COLUMNS} FROM public_receipts WHERE ${HIDDEN_RECEIPT} ORDER BY at DESC, id ASC`).all().map(rowToPublic);
}

export function listPublicReceiptSitemap(store, limit = 1000) {
  const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 1000;
  return store.db.prepare(`SELECT id, at FROM public_receipts WHERE ${HIDDEN_RECEIPT} ORDER BY at DESC, id ASC LIMIT ?`).all(cap).map(row => ({
    path: `/receipts/${row.id}`,
    lastmod: typeof row.at === "string" ? row.at.slice(0, 10) : null,
  }));
}

export function loadPublicRoom(store, slug) {
  if (!SLUG.test(slug) || isUnpublished(store.db, "room", slug)) return null;
  const row = store.db.prepare(`SELECT slug, title, purpose, humans, agents, names_json, tasks_json, receipts_enabled, join_mode, join_token, set_at
    FROM public_rooms WHERE slug=?`).get(slug);
  if (!row) return null;
  return {
    slug: row.slug,
    title: row.title,
    purpose: row.purpose,
    counts: { humans: row.humans, agents: row.agents },
    names: parseJson(row.names_json, []),
    tasks: parseJson(row.tasks_json, []),
    receiptsEnabled: row.receipts_enabled === 1,
    joinMode: row.join_mode === "link" && row.join_token ? "link" : "request",
    joinToken: row.join_mode === "link" ? row.join_token : null,
    setAt: row.set_at,
  };
}

export function listPublicRoomSitemap(store) {
  return store.db.prepare("SELECT slug, set_at FROM public_rooms ORDER BY slug ASC").all()
    .filter(row => !isUnpublished(store.db, "room", row.slug))
    .map(row => ({
      slug: row.slug,
      setAt: row.set_at,
    }));
}

// Newest-first page of receipts that name this room. `after` is the last row
// of the previous page ({ at, id }) so a caller can skip rows it will drop.
export function roomPageReceipts(store, slug, receiptsEnabled, { limit = 5, after = null } = {}) {
  const cap = Number.isInteger(limit) && limit > 0 && limit <= 50 ? limit : 5;
  const params = [slug, receiptsEnabled ? 1 : 0, slug];
  let cursor = "";
  if (after && typeof after.at === "string" && typeof after.id === "string") {
    cursor = " AND (at < ? OR (at = ? AND id > ?))";
    params.push(after.at, after.at, after.id);
  }
  params.push(cap);
  return store.db.prepare(`SELECT id, title, at FROM public_receipts
    WHERE ${HIDDEN_RECEIPT} AND (room_id=? OR (?=1 AND origin_room_id=? AND source IN ('work-claim','work-item')))${cursor}
    ORDER BY at DESC, id ASC LIMIT ?`).all(...params);
}

export function queryDirectoryEntries(store, { cursor = null, limit = DIRECTORY_PAGE_SIZE } = {}) {
  const cap = Number.isInteger(limit) && limit > 0 && limit <= 50 ? limit : DIRECTORY_PAGE_SIZE;
  let rows;
  if (cursor != null) {
    if (typeof cursor !== "string" || !cursor) {
      return { error: { status: 422, code: "invalid_cursor", message: "cursor is not an agent on this list" } };
    }
    const current = store.db.prepare("SELECT name, agent_id FROM public_directory_entries WHERE agent_id=?").get(cursor);
    if (!current) return { error: { status: 422, code: "invalid_cursor", message: "cursor is not an agent on this list" } };
    rows = store.db.prepare(`SELECT agent_id, name, description, skills_json, receipt_count, room_count
      FROM public_directory_entries WHERE name > ? OR (name = ? AND agent_id > ?)
      ORDER BY name ASC, agent_id ASC LIMIT ?`).all(current.name, current.name, current.agent_id, cap + 1);
  } else {
    rows = store.db.prepare(`SELECT agent_id, name, description, skills_json, receipt_count, room_count
      FROM public_directory_entries ORDER BY name ASC, agent_id ASC LIMIT ?`).all(cap + 1);
  }
  const page = rows.slice(0, cap).map(row => ({
    agentId: row.agent_id,
    name: row.name,
    description: row.description,
    skills: parseJson(row.skills_json, []),
    receiptCount: row.receipt_count,
    roomCount: row.room_count,
  }));
  return { agents: page, nextCursor: rows.length > cap ? page.at(-1)?.agentId ?? null : null };
}
