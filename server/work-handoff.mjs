// Structured agent-to-agent work handoff (B014). A frozen contract so any
// agent can hand work to any other agent — or to John — with everything the
// receiver needs: objective → status → next → blockers → files → validation.
// Pure validator: no store, no network. A later slice persists handoffs.
import { createHash, randomUUID } from "node:crypto";
import { PERMISSIONS } from "../src/events.js";
import { ServiceError } from "./store.mjs";
class HandoffError extends Error { constructor(code, message) { super(message); this.name = "HandoffError"; this.code = code; } }
const fail = (code, message) => { throw new HandoffError(code, message); };
const requireHandoff = (condition, code = "invalid_work_handoff", message = "invalid work handoff") => { if (!condition) fail(code, message); };

const text = (value, max, field) => {
  requireHandoff(typeof value === "string" && value.isWellFormed() && value.length > 0 && value.length <= max, "invalid_work_handoff", `${field} must be 1..${max} well-formed characters`);
  return value;
};
const optionalText = (value, max, field) => value == null ? null : text(value, max, field);
const idText = value => { requireHandoff(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value), "invalid_work_handoff", "handoff ids must be simple identifiers"); return value; };
const isoDate = value => {
  requireHandoff(typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/.test(value) && Number.isFinite(Date.parse(value)), "invalid_work_handoff", "handoff timestamps must be ISO UTC");
  return value;
};
export const handoffStatuses = Object.freeze(["not_started", "in_progress", "blocked", "ready_for_review", "done"]);
// files: [{ path, kind, sha }] — kind in {code, doc, data, other}; sha is a
// 40-char git blob id or 64-char sha256 when the file is not in git.
const handoffFile = value => {
  requireHandoff(value !== null && typeof value === "object" && !Array.isArray(value), "invalid_work_handoff", "handoff files must be objects");
  requireHandoff(Object.keys(value).every(k => ["path", "kind", "sha"].includes(k)), "invalid_work_handoff", "handoff files carry only path/kind/sha");
  const kinds = ["code", "doc", "data", "other"];
  requireHandoff(kinds.includes(value.kind), "invalid_work_handoff", `file kind must be one of ${kinds.join(",")}`);
  if (value.sha !== undefined && value.sha !== null) requireHandoff(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(value.sha), "invalid_work_handoff", "file sha must be a 40 or 64 char hex digest");
  return Object.freeze({ path: text(value.path, 1024, "file path"), kind: value.kind, sha: value.sha ?? null });
};
// Validate and freeze one handoff record.
export function workHandoff(value) {
  requireHandoff(value !== null && typeof value === "object" && !Array.isArray(value), "invalid_work_handoff", "handoff must be an object");
  const allowed = ["id", "from", "to", "at", "objective", "status", "summary", "next", "blockers", "files", "validation"];
  requireHandoff(Object.keys(value).every(k => allowed.includes(k)), "invalid_work_handoff", `handoff carries only ${allowed.join(",")}`);
  requireHandoff(handoffStatuses.includes(value.status), "invalid_work_handoff", `status must be one of ${handoffStatuses.join(",")}`);
  const list = (values, max, field) => {
    requireHandoff(Array.isArray(values) && values.length <= 64, "invalid_work_handoff", `${field} must be a list of at most 64`);
    return Object.freeze(values.map(v => text(v, max, field)));
  };
  const record = {
    id: idText(value.id),
    from: text(value.from, 128, "from"),
    to: text(value.to, 128, "to"),
    at: isoDate(value.at),
    objective: text(value.objective, 4096, "objective"),
    status: value.status,
    summary: text(value.summary, 8192, "summary"),
    next: list(value.next ?? [], 2048, "next step"),
    blockers: list(value.blockers ?? [], 2048, "blocker"),
    files: Object.freeze((value.files ?? []).map(handoffFile).slice(0, 64)),
    validation: optionalText(value.validation, 8192, "validation"),
  };
  requireHandoff(record.status !== "blocked" || record.blockers.length > 0, "invalid_work_handoff", "a blocked handoff must name its blockers");
  requireHandoff(record.status !== "ready_for_review" || record.validation !== null, "invalid_work_handoff", "a review-ready handoff must say how it was validated");
  return Object.freeze(record);
}
// Convenience: start a handoff skeleton the handing agent fills in.
export function startHandoff({ id, from, to, objective }) {
  return { id: idText(id), from: text(from, 128, "from"), to: text(to, 128, "to"),
    at: new Date().toISOString(), objective: text(objective, 4096, "objective"),
    status: "in_progress", summary: "", next: [], blockers: [], files: [], validation: null };
}
export { HandoffError };

// ---------------------------------------------------------------------------
// Typed handoff envelopes (RC-2026-09-19-062).
//
// The work handoff above is a status report. An envelope is a delegation:
// everything the receiving agent needs to take the work and run with it —
// objective, inputs (references, not blobs), scoped authority, expected
// output, a machine-checkable acceptance test, termination conditions, and
// full provenance. The journal records every terminal state (completed,
// rejected, expired, escalated, cancelled) so the falsifiable claim "typed
// handoffs reduce escalations" is measurable: escalation rate = escalated /
// closed envelopes, comparable against the legacy owner-directed handoff
// (work.handoff_recorded) baseline.
//
// The validator is pure (no store, no network); HandoffEnvelopeJournal below
// persists envelopes room-scoped, following the InboxHandoffJournal pattern.
// Journal validation raises ServiceError (422/404/409) so the codes read the
// same in unit tests and over HTTP.
const envelopeFail = (status, code, message) => { throw new ServiceError(status, code, message); };
const envelopeCheck = (condition, code, message) => { if (!condition) envelopeFail(422, code, message); };
const ENVELOPE_CODE = "invalid_handoff_envelope";

export const handoffEnvelopeVersion = 1;
export const envelopeStatuses = Object.freeze(["proposed", "accepted", "completed", "rejected", "expired", "escalated", "cancelled"]);
const envelopeTerminal = new Set(["completed", "rejected", "expired", "escalated", "cancelled"]);
export const envelopeTransitions = Object.freeze({
  proposed: ["accepted", "rejected", "cancelled", "expired"],
  accepted: ["completed", "escalated", "cancelled", "expired"],
  completed: [], rejected: [], expired: [], escalated: [], cancelled: [],
});

const agentId = (value, field) => {
  envelopeCheck(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value), ENVELOPE_CODE,
    `${field} must be a 1..128 character agent id`);
  return value;
};
const envelopeText = (value, max, field, { optional = false } = {}) => {
  if (value === undefined || value === null) {
    envelopeCheck(optional, ENVELOPE_CODE, `${field} is required`);
    return null;
  }
  envelopeCheck(typeof value === "string" && value.isWellFormed() && value.length > 0 && value.length <= max, ENVELOPE_CODE,
    `${field} must be 1..${max} well-formed characters`);
  return value;
};
const envelopeIso = (value, field) => {
  const parsed = envelopeText(value, 64, field);
  envelopeCheck(Number.isFinite(Date.parse(parsed)), ENVELOPE_CODE, `${field} must be a parseable timestamp`);
  return new Date(parsed).toISOString();
};
const idList = (value, maxItems, field, { optional = false } = {}) => {
  if (value === undefined || value === null) {
    envelopeCheck(optional, ENVELOPE_CODE, `${field} is required`);
    return null;
  }
  envelopeCheck(Array.isArray(value) && value.length <= maxItems, ENVELOPE_CODE, `${field} must be a list of at most ${maxItems}`);
  return Object.freeze(value.map((item, i) => agentId(item, `${field}[${i}]`)));
};

// Inputs are references, not blobs: the receiver fetches them through the
// room API it already has. kinds: work (work item id), message (message id),
// file (repo path + optional sha), url (https reference), note (short inline
// context, capped — not a document dump).
const inputKinds = Object.freeze(["work", "message", "file", "url", "note"]);
// Userinfo is a credential even when the rest of the URL is https. A port
// and an "@" in the path are not userinfo and stay allowed.
const httpsReferenceWithoutCredentials = ref => {
  let url;
  try { url = new URL(ref); } catch { return false; }
  return url.protocol === "https:" && url.username === "" && url.password === "" && url.hostname !== "";
};
const envelopeInput = value => {
  envelopeCheck(value !== null && typeof value === "object" && !Array.isArray(value), ENVELOPE_CODE, "inputs must be objects");
  envelopeCheck(Object.keys(value).every(k => ["kind", "ref", "label", "sha", "detail"].includes(k)), ENVELOPE_CODE,
    "input carries only kind/ref/label/sha/detail");
  envelopeCheck(inputKinds.includes(value.kind), ENVELOPE_CODE, `input kind must be one of ${inputKinds.join(",")}`);
  const ref = envelopeText(value.ref, 2048, "input ref");
  if (value.kind === "url") envelopeCheck(httpsReferenceWithoutCredentials(ref), ENVELOPE_CODE, "url inputs must be https URLs without credentials");
  if (value.sha !== undefined && value.sha !== null)
    envelopeCheck(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(value.sha), ENVELOPE_CODE, "input sha must be a 40 or 64 char hex digest");
  return Object.freeze({ kind: value.kind, ref,
    label: value.label === undefined || value.label === null ? null : envelopeText(value.label, 256, "input label"),
    sha: value.sha ?? null,
    detail: value.detail === undefined || value.detail === null ? null : envelopeText(value.detail, 2000, "input detail") });
};

// Scoped authority: capability bits the receiver may exercise, the resource
// scope they apply to, and an expiry. A handoff must not be a privilege
// escalation vector, so manage_members/decide are rejected at issuance —
// the same agent-safety rule as invite codes. At least one of rooms/workIds
// must be non-empty: authority without a resource scope is not scoped.
const envelopeAuthority = value => {
  envelopeCheck(value !== null && typeof value === "object" && !Array.isArray(value), ENVELOPE_CODE, "authority must be an object");
  envelopeCheck(Object.keys(value).every(k => ["permissions", "scope", "expiresAt", "note"].includes(k)), ENVELOPE_CODE,
    "authority carries only permissions/scope/expiresAt/note");
  envelopeCheck(Array.isArray(value.permissions) && value.permissions.length >= 1 && value.permissions.length <= PERMISSIONS.length,
    ENVELOPE_CODE, "authority.permissions must be a non-empty permission list");
  const permissions = Object.freeze([...new Set(value.permissions.map((p, i) => {
    envelopeCheck(typeof p === "string" && PERMISSIONS.includes(p), ENVELOPE_CODE, `authority.permissions[${i}] must be a known permission`);
    return p;
  }))]);
  envelopeCheck(!permissions.includes("manage_members") && !permissions.includes("decide"), ENVELOPE_CODE,
    "handoff authority cannot grant manage_members or decide — escalate to a human instead");
  envelopeCheck(value.scope !== null && typeof value.scope === "object" && !Array.isArray(value.scope), ENVELOPE_CODE, "authority.scope must be an object");
  envelopeCheck(Object.keys(value.scope).every(k => ["rooms", "workIds"].includes(k)), ENVELOPE_CODE, "authority.scope carries only rooms/workIds");
  const rooms = idList(value.scope.rooms, 32, "authority.scope.rooms", { optional: true }) ?? Object.freeze([]);
  const workIds = idList(value.scope.workIds, 64, "authority.scope.workIds", { optional: true }) ?? Object.freeze([]);
  envelopeCheck(rooms.length + workIds.length >= 1, ENVELOPE_CODE, "authority.scope must name at least one room or work item");
  return Object.freeze({ permissions, scope: Object.freeze({ rooms, workIds }),
    expiresAt: envelopeIso(value.expiresAt, "authority.expiresAt"),
    note: value.note === undefined || value.note === null ? null : envelopeText(value.note, 1024, "authority.note") });
};

const outputKinds = Object.freeze(["text_result", "verification", "decision", "artifact", "report"]);
const envelopeExpectedOutput = value => {
  envelopeCheck(value !== null && typeof value === "object" && !Array.isArray(value), ENVELOPE_CODE, "expectedOutput must be an object");
  envelopeCheck(Object.keys(value).every(k => ["kind", "description", "schema"].includes(k)), ENVELOPE_CODE,
    "expectedOutput carries only kind/description/schema");
  envelopeCheck(outputKinds.includes(value.kind), ENVELOPE_CODE, `expectedOutput.kind must be one of ${outputKinds.join(",")}`);
  return Object.freeze({ kind: value.kind, description: envelopeText(value.description, 2048, "expectedOutput.description"),
    schema: value.schema === undefined || value.schema === null ? null : envelopeText(value.schema, 2048, "expectedOutput.schema") });
};

// Acceptance checks are machine-checkable by construction: each names a kind
// the verifier can evaluate without reading prose. complete() requires the
// recipient to name which declared checks passed.
const checkKinds = Object.freeze(["work_completed", "result_submitted", "verification_recorded", "manual_review"]);
const envelopeAcceptanceCheck = (value, i) => {
  const field = `acceptanceTest.checks[${i}]`;
  envelopeCheck(value !== null && typeof value === "object" && !Array.isArray(value), ENVELOPE_CODE, `${field} must be an object`);
  envelopeCheck(checkKinds.includes(value.kind), ENVELOPE_CODE, `${field}.kind must be one of ${checkKinds.join(",")}`);
  const check = { kind: value.kind };
  if (value.kind === "work_completed" || value.kind === "result_submitted") {
    envelopeCheck(Object.keys(value).every(k => ["kind", "workId", "description"].includes(k)), ENVELOPE_CODE, `${field} carries only kind/workId/description`);
    check.workId = agentId(value.workId, `${field}.workId`);
  } else if (value.kind === "verification_recorded") {
    envelopeCheck(Object.keys(value).every(k => ["kind", "workId", "verdict", "description"].includes(k)), ENVELOPE_CODE,
      `${field} carries only kind/workId/verdict/description`);
    check.workId = agentId(value.workId, `${field}.workId`);
    check.verdict = value.verdict === undefined || value.verdict === null ? null : envelopeText(value.verdict, 64, `${field}.verdict`);
  } else {
    envelopeCheck(Object.keys(value).every(k => ["kind", "reviewer", "description"].includes(k)), ENVELOPE_CODE, `${field} carries only kind/reviewer/description`);
    check.reviewer = agentId(value.reviewer, `${field}.reviewer`);
  }
  check.description = value.description === undefined || value.description === null ? null : envelopeText(value.description, 1024, `${field}.description`);
  return Object.freeze(check);
};
const envelopeAcceptanceTest = value => {
  envelopeCheck(value !== null && typeof value === "object" && !Array.isArray(value), ENVELOPE_CODE, "acceptanceTest must be an object");
  envelopeCheck(Object.keys(value).every(k => ["checks"].includes(k)), ENVELOPE_CODE, "acceptanceTest carries only checks");
  envelopeCheck(Array.isArray(value.checks) && value.checks.length >= 1 && value.checks.length <= 16, ENVELOPE_CODE,
    "acceptanceTest.checks must be a list of 1..16");
  return Object.freeze({ checks: Object.freeze(value.checks.map((c, i) => envelopeAcceptanceCheck(c, i))) });
};

const envelopeTermination = (value, createdAt) => {
  envelopeCheck(value !== null && typeof value === "object" && !Array.isArray(value), ENVELOPE_CODE, "termination must be an object");
  envelopeCheck(Object.keys(value).every(k => ["expiresAt", "onExpiry", "escalateTo", "maxRounds"].includes(k)), ENVELOPE_CODE,
    "termination carries only expiresAt/onExpiry/escalateTo/maxRounds");
  envelopeCheck(["escalate", "release"].includes(value.onExpiry), ENVELOPE_CODE, "termination.onExpiry must be escalate or release");
  const expiresAt = envelopeIso(value.expiresAt, "termination.expiresAt");
  envelopeCheck(Date.parse(expiresAt) > Date.parse(createdAt), ENVELOPE_CODE, "termination.expiresAt must be after createdAt");
  const escalateTo = value.escalateTo === undefined || value.escalateTo === null ? null : agentId(value.escalateTo, "termination.escalateTo");
  envelopeCheck(value.onExpiry !== "escalate" || escalateTo !== null, ENVELOPE_CODE, "termination.escalateTo is required when onExpiry is escalate");
  const maxRounds = value.maxRounds === undefined || value.maxRounds === null ? null : value.maxRounds;
  if (maxRounds !== null) envelopeCheck(Number.isInteger(maxRounds) && maxRounds >= 1 && maxRounds <= 64, ENVELOPE_CODE, "termination.maxRounds must be 1..64");
  return Object.freeze({ expiresAt, onExpiry: value.onExpiry, escalateTo, maxRounds });
};

const envelopeProvenance = value => {
  envelopeCheck(value !== null && typeof value === "object" && !Array.isArray(value), ENVELOPE_CODE, "provenance must be an object");
  envelopeCheck(Object.keys(value).every(k => ["createdBy", "claimId", "taskId", "parentEnvelopeId", "chain"].includes(k)), ENVELOPE_CODE,
    "provenance carries only createdBy/claimId/taskId/parentEnvelopeId/chain");
  const createdBy = agentId(value.createdBy, "provenance.createdBy");
  const claimId = value.claimId === undefined || value.claimId === null ? null : value.claimId;
  if (claimId !== null) envelopeCheck(typeof claimId === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(claimId), ENVELOPE_CODE, "provenance.claimId must be a simple identifier");
  const taskId = value.taskId === undefined || value.taskId === null ? null : agentId(value.taskId, "provenance.taskId");
  const parentEnvelopeId = value.parentEnvelopeId === undefined || value.parentEnvelopeId === null ? null : agentId(value.parentEnvelopeId, "provenance.parentEnvelopeId");
  const chain = idList(value.chain ?? [], 32, "provenance.chain", { optional: true }) ?? Object.freeze([]);
  if (parentEnvelopeId !== null) {
    envelopeCheck(chain.length >= 1 && chain[chain.length - 1] === parentEnvelopeId, ENVELOPE_CODE,
      "provenance.chain must end with provenance.parentEnvelopeId");
  }
  return Object.freeze({ createdBy, claimId, taskId, parentEnvelopeId, chain });
};

// Validate and freeze one typed handoff envelope. id/from/createdAt are
// assigned by the journal; every other field is caller-supplied and checked.
export function handoffEnvelope(value) {
  envelopeCheck(value !== null && typeof value === "object" && !Array.isArray(value), ENVELOPE_CODE, "an envelope must be an object");
  const allowed = ["envelopeVersion", "id", "from", "to", "createdAt", "objective", "inputs",
    "authority", "expectedOutput", "acceptanceTest", "termination", "provenance"];
  envelopeCheck(Object.keys(value).every(k => allowed.includes(k)), ENVELOPE_CODE, `envelope carries only ${allowed.join(",")}`);
  envelopeCheck(value.envelopeVersion === handoffEnvelopeVersion, ENVELOPE_CODE, `envelopeVersion must be ${handoffEnvelopeVersion}`);
  const id = agentId(value.id, "id");
  const from = agentId(value.from, "from"), to = agentId(value.to, "to");
  envelopeCheck(from !== to, ENVELOPE_CODE, "an envelope cannot hand work to its sender");
  const createdAt = envelopeIso(value.createdAt, "createdAt");
  envelopeCheck(Array.isArray(value.inputs) && value.inputs.length >= 1 && value.inputs.length <= 64, ENVELOPE_CODE,
    "inputs must be a list of 1..64 references");
  const inputs = Object.freeze(value.inputs.map(envelopeInput));
  const authority = envelopeAuthority(value.authority);
  envelopeCheck(Date.parse(authority.expiresAt) > Date.parse(createdAt), ENVELOPE_CODE, "authority.expiresAt must be after createdAt");
  const provenance = envelopeProvenance(value.provenance);
  envelopeCheck(provenance.createdBy === from, ENVELOPE_CODE, "provenance.createdBy must be the sending agent");
  return Object.freeze({ envelopeVersion: handoffEnvelopeVersion, id, from, to, createdAt,
    objective: envelopeText(value.objective, 4096, "objective"),
    inputs, authority,
    expectedOutput: envelopeExpectedOutput(value.expectedOutput),
    acceptanceTest: envelopeAcceptanceTest(value.acceptanceTest),
    termination: envelopeTermination(value.termination, createdAt),
    provenance });
}
// Convenience: start an envelope skeleton the handing agent fills in.
export function startEnvelope({ from, to, objective }) {
  const createdAt = new Date().toISOString();
  const in24h = new Date(Date.parse(createdAt) + 24 * 3600 * 1000).toISOString();
  return { envelopeVersion: handoffEnvelopeVersion, id: `he_${randomUUID()}`, from: agentId(from, "from"), to: agentId(to, "to"),
    createdAt, objective: envelopeText(objective, 4096, "objective"),
    inputs: [], authority: { permissions: [], scope: { rooms: [], workIds: [] }, expiresAt: in24h },
    expectedOutput: { kind: "text_result", description: "" },
    acceptanceTest: { checks: [] },
    termination: { expiresAt: in24h, onExpiry: "release", escalateTo: null, maxRounds: null },
    provenance: { createdBy: from, claimId: null, taskId: null, parentEnvelopeId: null, chain: [] } };
}

export const handoffEnvelopeSchema = `
  CREATE TABLE IF NOT EXISTS handoff_envelopes (
    envelope_id TEXT NOT NULL PRIMARY KEY,
    room_id TEXT NOT NULL,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('proposed','accepted','completed','rejected','expired','escalated','cancelled')),
    envelope TEXT NOT NULL CHECK(json_valid(envelope)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    history TEXT NOT NULL CHECK(json_valid(history))
  );
  CREATE INDEX IF NOT EXISTS handoff_envelopes_room_status ON handoff_envelopes(room_id,status,created_at);
  CREATE INDEX IF NOT EXISTS handoff_envelopes_room_to ON handoff_envelopes(room_id,to_agent,status);
`;
const envelopeReceiptOf = row => ({ envelopeId: row.envelope_id, roomId: row.room_id, status: row.status,
  fromAgent: row.from_agent, toAgent: row.to_agent, createdAt: row.created_at, updatedAt: row.updated_at,
  envelope: JSON.parse(row.envelope), history: JSON.parse(row.history) });
const envelopeScope = roomId => { envelopeCheck(typeof roomId === "string" && roomId.length >= 1 && roomId.length <= 384, "invalid_envelope_room", "Supply a room."); };

export class HandoffEnvelopeJournal {
  constructor(store) { this.store = store; this.db = store.db; }
  // A read-only open of a file written before this journal finds none of
  // these objects and must not migrate, so allowAbsent accepts a wholly
  // missing schema; a partially present one still fails.
  verifySchema({ allowAbsent = false } = {}) {
    const normalize = sql => sql?.trim().replace(/;$/, "").replace(/IF NOT EXISTS /g, "").replace(/\s+/g, " ");
    const expected = handoffEnvelopeSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean)
      .map(sql => ({ sql, actual: this.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(/^CREATE (?:TABLE|INDEX) (?:IF NOT EXISTS )?([a-z_]+)/.exec(sql.trim())[1])?.sql }));
    if (allowAbsent && expected.every(({ actual }) => actual === undefined)) return false;
    for (const { sql, actual } of expected) {
      if (normalize(actual) !== normalize(sql)) throw new Error("Handoff envelope journal schema requires operator reconciliation");
    }
    return true;
  }
  // Offline integrity: every row's envelope names the envelope id and room
  // it is keyed by, statuses stay in the enum, and every envelope starts
  // proposed.
  verify() {
    for (const row of this.db.prepare("SELECT * FROM handoff_envelopes").all()) {
      const envelope = JSON.parse(row.envelope), history = JSON.parse(row.history);
      if (envelope.id !== row.envelope_id) throw new Error(`Handoff envelope ${row.envelope_id} does not name its own id`);
      if (!envelopeStatuses.includes(row.status)) throw new Error(`Handoff envelope ${row.envelope_id} has an unknown status`);
      if (!Array.isArray(history) || history.length === 0 || history[0].status !== "proposed")
        throw new Error(`Handoff envelope ${row.envelope_id} has no proposed origin`);
    }
  }
  // Journal an envelope: the sender hands typed work to a named agent. The
  // envelope id is journal-assigned; the sender supplies everything else.
  create(roomId, fields, { from, requestId }) {
    envelopeScope(roomId);
    envelopeCheck(fields !== null && typeof fields === "object" && !Array.isArray(fields), ENVELOPE_CODE, "an envelope must be an object");
    const sender = agentId(from, "from");
    if (requestId !== undefined) agentId(requestId, "requestId");
    const id = requestId === undefined ? `he_${randomUUID()}`
      : `he_req_${createHash("sha256").update(JSON.stringify(["handoff-create-v1", roomId, sender, requestId])).digest("base64url")}`;
    return this.store.transaction(() => {
      const existing = requestId === undefined ? null
        : this.db.prepare("SELECT * FROM handoff_envelopes WHERE room_id=? AND from_agent=? AND envelope_id=?").get(roomId, sender, id);
      const now = existing?.created_at ?? this.store.now();
      const createdAt = new Date(now).toISOString();
      const envelope = handoffEnvelope({ ...fields, envelopeVersion: handoffEnvelopeVersion,
        id, from: sender, createdAt,
        provenance: { ...(fields.provenance ?? {}), createdBy: sender } });
      if (existing) {
        // Compare normalized input at the original creation time: a retry is
        // still valid after expiry and must never rewind the current lifecycle.
        if (JSON.stringify(envelope) !== existing.envelope)
          envelopeFail(409, "envelope_request_conflict", "This requestId was already used for a different handoff.");
        return { ...envelopeReceiptOf(existing), duplicate: true };
      }
      const history = JSON.stringify([{ status: "proposed", at: createdAt, by: sender }]);
      this.db.prepare(`INSERT INTO handoff_envelopes
        (envelope_id,room_id,from_agent,to_agent,status,envelope,created_at,updated_at,history)
        VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(envelope.id, roomId, envelope.from, envelope.to, "proposed", JSON.stringify(envelope), now, now, history);
      const receipt = envelopeReceiptOf(this.db.prepare("SELECT * FROM handoff_envelopes WHERE envelope_id=?").get(envelope.id));
      return requestId === undefined ? receipt : { ...receipt, duplicate: false };
    });
  }
  list(roomId, { status = null, to = null } = {}) {
    envelopeScope(roomId);
    if (status !== null && status !== undefined) {
      envelopeCheck(envelopeStatuses.includes(status), "invalid_envelope_status", `status must be one of ${envelopeStatuses.join(",")}`);
    }
    if (to !== null && to !== undefined) agentId(to, "to");
    return this.store.readTransaction(() => {
      let sql = "SELECT * FROM handoff_envelopes WHERE room_id=?";
      const params = [roomId];
      if (status !== null && status !== undefined) { sql += " AND status=?"; params.push(status); }
      if (to !== null && to !== undefined) { sql += " AND to_agent=?"; params.push(to); }
      sql += " ORDER BY created_at DESC LIMIT 500";
      return this.db.prepare(sql).all(...params).map(envelopeReceiptOf);
    });
  }
  // Move an envelope along its lifecycle. Terminal envelopes are immutable;
  // illegal edges are refused, never silently rewritten. Actor rules:
  // accept/reject/complete by the recipient (to); cancel by the sender
  // (from); escalate by either party; expired only by the system sweep.
  // complete() requires checksPassed: the non-empty subset of the declared
  // acceptance checks the recipient asserts passed.
  transition(roomId, envelopeId, status, { by = null, note = null, checksPassed = null } = {}) {
    envelopeScope(roomId);
    agentId(envelopeId, "envelopeId");
    envelopeCheck(envelopeStatuses.includes(status), "invalid_envelope_status", `status must be one of ${envelopeStatuses.join(",")}`);
    const actor = by === null || by === undefined ? null : (status === "expired" && by === "system" ? "system" : agentId(by, "by"));
    const trimmed = note === undefined || note === null ? null : envelopeText(note, 500, "note");
    return this.store.transaction(() => {
      const row = this.db.prepare("SELECT * FROM handoff_envelopes WHERE room_id=? AND envelope_id=?").get(roomId, envelopeId);
      if (!row) envelopeFail(404, "envelope_not_found", "No such envelope in this room.");
      if (!envelopeTransitions[row.status].includes(status))
        envelopeFail(409, "invalid_envelope_transition", `A ${row.status} envelope cannot move to ${status}.`);
      const envelope = JSON.parse(row.envelope);
      if (status === "expired") {
        envelopeCheck(actor === "system", "envelope_expiry_system_only", "Only the expiry sweep moves an envelope to expired.");
      } else {
        envelopeCheck(actor !== null, "envelope_actor_required", "A transitioning actor is required.");
        if ((status === "accepted" || status === "rejected" || status === "completed") && actor !== envelope.to)
          envelopeFail(403, "envelope_recipient_only", `Only ${envelope.to} can ${status} this envelope.`);
        if (status === "cancelled" && actor !== envelope.from)
          envelopeFail(403, "envelope_sender_only", `Only ${envelope.from} can cancel this envelope.`);
        if (status === "escalated" && actor !== envelope.to && actor !== envelope.from)
          envelopeFail(403, "envelope_party_only", "Only the sender or recipient can escalate this envelope.");
      }
      const now = this.store.now();
      // A delayed recipient must not revive a delegation after either of its
      // configured deadlines. Cleanup remains available until the explicit sweep.
      if ((status === "accepted" || status === "completed")
        && (now >= Date.parse(envelope.authority.expiresAt) || now >= Date.parse(envelope.termination.expiresAt)))
        envelopeFail(409, "envelope_expired", "This handoff has expired. Ask the sender for a new handoff.");
      let passed = null;
      if (status === "completed") {
        envelopeCheck(Array.isArray(checksPassed) && checksPassed.length >= 1, "envelope_checks_required",
          "Completing an envelope requires naming the acceptance checks that passed.");
        const declared = new Set(envelope.acceptanceTest.checks.map(c => c.kind));
        // Each asserted pass is recorded as given: collapsing duplicate
        // kinds would merge two distinct declared checks of the same kind
        // into one, weakening the acceptance criteria on the receipt.
        passed = Object.freeze(checksPassed.map((kind, i) => {
          envelopeCheck(typeof kind === "string" && declared.has(kind), "envelope_unknown_check",
            `checksPassed[${i}] is not a declared acceptance check`);
          return kind;
        }));
        envelopeCheck(passed.length >= 1, "envelope_checks_required", "At least one declared acceptance check must pass.");
      }
      const entry = { status, at: new Date(now).toISOString(), ...(actor ? { by: actor } : {}),
        ...(trimmed ? { note: trimmed } : {}), ...(passed ? { checksPassed: [...passed] } : {}) };
      const history = [...JSON.parse(row.history), entry];
      this.db.prepare("UPDATE handoff_envelopes SET status=?,updated_at=?,history=? WHERE room_id=? AND envelope_id=?")
        .run(status, now, JSON.stringify(history), roomId, envelopeId);
      return envelopeReceiptOf(this.db.prepare("SELECT * FROM handoff_envelopes WHERE envelope_id=?").get(envelopeId));
    });
  }
  // Expiry sweep: proposed/accepted envelopes past termination.expiresAt move
  // to escalated (when onExpiry is escalate) or expired. Returns the ids moved.
  sweepExpired(roomId, { now = null } = {}) {
    envelopeScope(roomId);
    const nowMs = now ?? this.store.now();
    const moved = { expired: [], escalated: [] };
    for (const row of this.db.prepare("SELECT * FROM handoff_envelopes WHERE room_id=? AND status IN ('proposed','accepted')").all(roomId)) {
      const envelope = JSON.parse(row.envelope);
      if (Date.parse(envelope.termination.expiresAt) > nowMs) continue;
      const target = envelope.termination.onExpiry === "escalate" ? "escalated" : "expired";
      const history = [...JSON.parse(row.history),
        { status: target, at: new Date(nowMs).toISOString(), by: "system", reason: "termination.expiresAt reached",
          ...(target === "escalated" ? { escalatedTo: envelope.termination.escalateTo } : {}) }];
      this.db.prepare("UPDATE handoff_envelopes SET status=?,updated_at=?,history=? WHERE room_id=? AND envelope_id=?")
        .run(target, nowMs, JSON.stringify(history), roomId, row.envelope_id);
      moved[target].push(row.envelope_id);
    }
    return { expired: Object.freeze(moved.expired), escalated: Object.freeze(moved.escalated) };
  }
  // Falsifiability instrument for "typed handoffs reduce escalations":
  // escalationRate = escalated / closed, where closed counts every terminal
  // state. Null when nothing has closed yet.
  metrics(roomId) {
    envelopeScope(roomId);
    const counts = Object.fromEntries(envelopeStatuses.map(s => [s, 0]));
    for (const row of this.db.prepare("SELECT status,COUNT(*) AS n FROM handoff_envelopes WHERE room_id=? GROUP BY status").all(roomId)) {
      counts[row.status] = row.n;
    }
    const closed = counts.completed + counts.rejected + counts.expired + counts.escalated + counts.cancelled;
    return Object.freeze({ roomId, total: Object.values(counts).reduce((a, b) => a + b, 0),
      byStatus: Object.freeze({ ...counts }), closed,
      escalationRate: closed === 0 ? null : counts.escalated / closed });
  }
}
export { envelopeTerminal };
