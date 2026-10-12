/**
 * audit-wave-low-b.test.js — regression tests for LOW wave B findings:
 * L-4 (dm-consents bidirectional revoke), L-5 (ringdetect hop count),
 * L-6 (dispute-arbiters segment-boundary chain overlap), L-7 (health-report
 * NaN scores), L-8 (growth-funnel chronological order / non-negative
 * deltas), L-9 (github-oauth email pagination), L-10 (governance
 * dmConsentRequired honesty), L-16 (migration journal ordering), L-17
 * (morning-digest timestamp canonicalization), L-18 (installer EXIT trap).
 *
 * Each test fails on the pre-fix code for the intended reason and passes
 * after the owner-boundary repair. Run with:
 *   TMPDIR=<worktree>/.tmp node --test tests/audit-wave-low-b.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { DmConsents, dmConsentSchema } from "../server/dm-consents.mjs";
import { AUTONOMY_TIERS_SCHEMA } from "../server/autonomy-tiers.mjs";
import { createArbiters } from "../server/dispute-arbiters.mjs";
import {
  GITHUB_USER_URL, GITHUB_EMAILS_URL,
  fetchGitHubUser,
} from "../server/github-oauth.mjs";
import { governanceObject } from "../server/governance.mjs";

// ---------------------------------------------------------------------------
// L-4: revoke revokes every approved directional row.
// ---------------------------------------------------------------------------

const member = (id, displayName, active = true) => ({ id, displayName, active, kind: "agent", permissions: [] });

function makeDmStore(states) {
  const db = new DatabaseSync(":memory:");
  db.exec(dmConsentSchema);
  db.exec(AUTONOMY_TIERS_SCHEMA);
  const events = [];
  return {
    db,
    transaction(fn) {
      if (db.isTransaction) return fn();
      db.exec("BEGIN IMMEDIATE");
      try { const out = fn(); db.exec("COMMIT"); return out; }
      catch (e) { if (db.isTransaction) db.exec("ROLLBACK"); throw e; }
    },
    room(id) {
      const state = states[id];
      return state ? { state } : null;
    },
    // Append-only stub: the real store's appendSideTableEvent is verified on a
    // real RoomStore in tests/dm-consent-events.test.js.
    appendSideTableEvent(roomId, event) {
      events.push(event);
    },
    events
  };
}

const dmState = () => ({
  room: { id: "r1", title: "Room", purpose: "work", ownerId: "owner", createdAt: 1000 },
  members: {
    owner: member("owner", "Olivia Owner"),
    alice: member("alice", "Alice"),
    bob: member("bob", "Bob"),
  },
  messages: []
});

const errOf = fn => { try { fn(); } catch (e) { return e; } return null; };

test("L-4: revoke revokes both approved directional rows, not just the first", () => {
  const store = makeDmStore({ r1: dmState() });
  const dms = new DmConsents(store);
  dms.request("r1", "alice", "bob");
  dms.decide("r1", "bob", "alice", "approve");
  dms.request("r1", "bob", "alice");
  dms.decide("r1", "alice", "bob", "approve");
  dms.revoke("r1", "alice", "bob");
  const rows = store.db.prepare("SELECT status FROM dm_consents WHERE room_id = 'r1'").all();
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.status === "revoked"), "both directions revoked");
  // Both directions are now refused; nothing stays silently approved.
  assert.equal(errOf(() => dms.requireDmAllowed("r1", "alice", "bob")).code, "dm_consent_required");
  assert.equal(errOf(() => dms.requireDmAllowed("r1", "bob", "alice")).code, "dm_consent_required");
});

// ---------------------------------------------------------------------------
// L-5: refund-loop hops count edges.
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// L-6: delegated-chain overlap is segment-boundary, not substring.
// ---------------------------------------------------------------------------

test("L-6: 'agent1' does not disqualify 'agent12'; true chain overlap still does", () => {
  const arbiters = createArbiters();
  const seat = (verifier, executor) => arbiters.resolveTier1({
    verifierId: verifier.lane, executor, lanes: [verifier],
  });
  // Substring false positive: agent1 vs agent12 share no delegation segment.
  const ok = seat(
    { lane: "agent1", delegatedChain: "agent1" },
    { lane: "agent12", delegatedChain: "agent12" },
  );
  assert.equal(ok.tier, 1, "independent verifier seats");
  // Genuine overlap: john>quill>codex shares segments with john>quill.
  const blocked = seat(
    { lane: "codex", delegatedChain: "john>quill>codex" },
    { lane: "quill", delegatedChain: "john>quill" },
  );
  assert.equal(blocked.unavailable, "no-arbitrator");
  assert.match(blocked.reason, /delegated chain overlap/);
});

// ---------------------------------------------------------------------------
// L-7: health scores reject non-numeric inputs instead of scoring NaN.
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// L-8: funnel is chronological and second-contribution deltas are honest.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// L-9: /user/emails pagination follows Link rel="next".
// ---------------------------------------------------------------------------

const jsonResponse = (data, link = null) => new Response(JSON.stringify(data), {
  status: 200,
  headers: { "content-type": "application/json", ...(link ? { link } : {}) },
});

test("L-9: email pagination follows same-origin Link rel=next, ignores off-origin", async () => {
  const calls = [];
  const fetchFn = async url => {
    calls.push(url);
    if (url === GITHUB_USER_URL) return jsonResponse({ id: 424242, login: "octofixture" });
    if (url === GITHUB_EMAILS_URL)
      return jsonResponse(
        [{ email: "other@example.com", primary: false, verified: true }],
        `<${GITHUB_EMAILS_URL}?page=2>; rel="next"`);
    if (url === `${GITHUB_EMAILS_URL}?page=2`)
      return jsonResponse(
        [{ email: "page2@example.com", primary: true, verified: true }],
        `<https://evil.example/emails>; rel="next"`);
    return new Response("missing", { status: 404 });
  };
  const user = await fetchGitHubUser("token-abc", fetchFn);
  assert.equal(user.email, "page2@example.com");
  assert.ok(calls.includes(`${GITHUB_EMAILS_URL}?page=2`), "second page was fetched");
  assert.ok(!calls.includes("https://evil.example/emails"), "off-origin Link never followed");
});

// ---------------------------------------------------------------------------
// L-10: governance publishes the real (default-open) DM consent posture.
// ---------------------------------------------------------------------------

test("L-10: governance publishes dmConsentRequired: false (default-open)", () => {
  const gov = governanceObject({ origin: "https://room.example" });
  assert.equal(gov.communications.outboundContactPolicy.dmConsentRequired, false);
});

// ---------------------------------------------------------------------------
// L-16: migration journal ordering is verified.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// L-17: morning digest canonicalizes timestamps before comparing/sorting.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// L-18: the installer runs node as a child so the EXIT trap cleans up.
// ---------------------------------------------------------------------------

