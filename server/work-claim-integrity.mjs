// Board integrity guards (SEC-2 with the Q3-A addendum).
//
// Pure helpers the work-claim routes call before the claim state machine:
// - text: titles, notes and review summaries are NFC-normalized; control
//   characters (newline allowed in notes), bidi controls, lone surrogates and
//   text that is empty once whitespace and invisible characters are removed
//   are refused with 422 invalid_claim_input naming the field;
// - inputs: dependsOn must name claims in this room, leaseHours is 0.25..168;
// - pull requests: the client names a pull request by URL or owner/repo#n.
//   Merge, CI, mergeable and head-sha facts are set only by claim-pr-sync;
// - event budget: Board writes from members without claim authority stop
//   when less than 10% of the room's lifetime event budget is left (note-only
//   writes coalesce in server/work-claim-events.mjs);
// - deploy status: one GitHub read per store per 60 s, single-flight, with
//   the stale cached value while the GitHub budget is held.
import { TEXT_CHARACTER_CLASSES } from "./display-name-guard.mjs";
import { PILOT_LIMITS } from "./store.mjs";
import { readCachedDeployStatus, readClaimPullBudget, readRoomDeployStatus } from "./claim-pr-sync.mjs";

const INVISIBLE = new RegExp(TEXT_CHARACTER_CLASSES.invisible.source, "gu");
const SPACES = new RegExp(TEXT_CHARACTER_CLASSES.spaces.source, "gu");
const BIDI = TEXT_CHARACTER_CLASSES.bidiControls;
// C0 and C1 control characters. Notes keep line feeds.
const CONTROLS_ANY = /[\u0000-\u001F\u007F-\u009F]/u;
const CONTROLS_MULTILINE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/u;

export const BOARD_LEASE_HOURS_MIN = 0.25;
export const BOARD_LEASE_HOURS_MAX = 168;
export const EVENT_BUDGET_RESERVE = 0.1;
export const DEPLOY_STATUS_MAX_AGE_MS = 60_000;
export const DONE_WINDOW_MS = 7 * 24 * 3600 * 1000;
export const LIST_HISTORY_ENTRIES = 3;

const invalid = (reject, field, message) => reject(422, "invalid_claim_input", `${field}: ${message}`);

// Returns the normalized text, or the value unchanged when it is absent or
// not a string (the state machine reports the type error with its own text).
export function boardText(reject, field, value, { multiline = false } = {}) {
  if (value === undefined || value === null || typeof value !== "string") return value;
  if (!value.isWellFormed()) invalid(reject, field, "must not contain unpaired surrogate characters");
  const text = (multiline ? value.replace(/\r\n?/g, "\n") : value).normalize("NFC");
  if ((multiline ? CONTROLS_MULTILINE : CONTROLS_ANY).test(text)) {
    invalid(reject, field, multiline ? "must not contain control characters other than line breaks" : "must not contain control characters");
  }
  if (BIDI.test(text)) invalid(reject, field, "must not contain bidirectional control characters");
  if (text.replace(SPACES, "").replace(INVISIBLE, "").length === 0) {
    invalid(reject, field, "must contain visible text");
  }
  return text;
}

// Every named field that is present is normalized in place on a copy.
export function boardTextFields(reject, data, fields) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const next = { ...data };
  for (const [field, options] of Object.entries(fields)) {
    if (Object.hasOwn(next, field)) next[field] = boardText(reject, field, next[field], options);
  }
  return next;
}

export function assertBoardLeaseHours(reject, data) {
  if (!data || !Object.hasOwn(data, "leaseHours") || data.leaseHours === null) return;
  const value = data.leaseHours;
  if (typeof value !== "number" || !Number.isFinite(value) || value < BOARD_LEASE_HOURS_MIN || value > BOARD_LEASE_HOURS_MAX) {
    invalid(reject, "leaseHours", `must be a number from ${BOARD_LEASE_HOURS_MIN} to ${BOARD_LEASE_HOURS_MAX}, or null where allowed`);
  }
}

export function assertDependsOnKnown(reject, data, { selfId, has }) {
  if (!data || !Array.isArray(data.dependsOn)) return;
  for (const id of data.dependsOn) {
    if (typeof id !== "string") continue; // the state machine reports the shape
    if (id === selfId) invalid(reject, "dependsOn", "a claim cannot depend on itself");
    if (!has(id)) invalid(reject, "dependsOn", `no claim "${id.slice(0, 128)}" in this room`);
  }
}

const SHORT_PULL = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})#([1-9]\d{0,9})$/;
const pullUrlOf = value => {
  if (typeof value !== "string") return value;
  const match = SHORT_PULL.exec(value.trim());
  return match ? `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}` : value;
};

// The client names a pull request; it never asserts what happened to it.
// Objects may carry only url. Anything else (outcome, merged, CI, mergeable,
// head sha, poll metadata) is refused, because claim-pr-sync owns it.
export function clientPullRequestInput(reject, data) {
  if (!data || typeof data !== "object") return data;
  const one = (field, value) => {
    if (value === undefined || value === null) return value;
    if (typeof value === "string") return pullUrlOf(value);
    if (typeof value === "object" && !Array.isArray(value)) {
      const extra = Object.keys(value).filter(key => key !== "url");
      if (extra.length > 0) {
        invalid(reject, `${field}.${extra[0].slice(0, 40)}`, "is recorded by the server from GitHub; send only the pull request URL");
      }
      return { url: pullUrlOf(value.url) };
    }
    return value;
  };
  const next = { ...data };
  if (Object.hasOwn(next, "pullRequest")) next.pullRequest = one("pullRequest", next.pullRequest);
  if (Array.isArray(next.pullRequests)) next.pullRequests = next.pullRequests.map((entry, index) => one(`pullRequests[${index}]`, entry));
  return next;
}

export function roomEventsRemaining(sequence) {
  if (!Number.isSafeInteger(sequence)) return null;
  return Math.max(0, PILOT_LIMITS.eventsPerRoom - sequence);
}

// Board writes from members without claim authority stop when the room has
// less than 10% of its lifetime event budget left. The room owner and
// manage_claims holders can still write, so they can wind the room down.
export function assertBoardEventBudget(sequence, { privileged }) {
  if (privileged) return;
  const remaining = roomEventsRemaining(sequence);
  if (remaining === null || remaining >= PILOT_LIMITS.eventsPerRoom * EVENT_BUDGET_RESERVE) return;
  const message = `This room has ${remaining} of its ${PILOT_LIMITS.eventsPerRoom} room events left, so Board writes are limited to the room owner and claim managers.`;
  const hint = "Ask the room owner to finish or archive work here, or continue in a new room.";
  const error = new Error(message);
  error.status = 409;
  error.code = "room_event_budget_low";
  error.body = { error: { code: "room_event_budget_low", message }, eventsRemaining: remaining, hint, next: [{ command: hint }] };
  throw error;
}

// Deploy status for GET /work-claims/status. Readers share one cached value
// per store; a GitHub read happens at most once per 60 s (single-flight).
// Only Board writers may force a refresh. While the GitHub budget is held,
// the cached value comes back with stale:true and heldUntil, and nothing
// is fetched.
const statusFlights = new WeakMap();

export async function readBoardDeployStatus(store, { fetchImpl, token, nowMs = Date.now(), force = false } = {}) {
  const heldUntil = readClaimPullBudget(store);
  if (heldUntil > nowMs) {
    return { ...readCachedDeployStatus(store), stale: true, heldUntil: new Date(heldUntil).toISOString() };
  }
  const key = store && typeof store === "object" ? store : statusFlights;
  const flight = statusFlights.get(key);
  if (flight?.promise) return flight.promise;
  const cached = readCachedDeployStatus(store);
  const cachedAt = cached.checkedAt ? Date.parse(cached.checkedAt) : NaN;
  const fresh = (flight && nowMs - flight.atMs < DEPLOY_STATUS_MAX_AGE_MS)
    || (Number.isFinite(cachedAt) && nowMs - cachedAt >= 0 && nowMs - cachedAt < DEPLOY_STATUS_MAX_AGE_MS);
  // A reader inside the window after a failed read gets the same cached main
  // that read fell back to; it stays stale unless the cache itself is fresh.
  const cacheFresh = Number.isFinite(cachedAt) && nowMs - cachedAt >= 0 && nowMs - cachedAt < DEPLOY_STATUS_MAX_AGE_MS;
  if (fresh && !force) return { ...cached, stale: !cacheFresh && flight?.stale === true };
  const entry = { atMs: nowMs, promise: null };
  entry.promise = readRoomDeployStatus(store, { fetchImpl, token, nowMs })
    .then(status => { entry.stale = status.stale === true; return { ...status, stale: entry.stale }; })
    .finally(() => { entry.promise = null; });
  statusFlights.set(key, entry);
  return entry.promise;
}
