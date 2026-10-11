// A handoff URL must not carry userinfo. The validator's error text already
// says "without credentials"; this drives handoffEnvelope, the shipped check.
import test from "node:test";
import assert from "node:assert/strict";
import { handoffEnvelope, handoffEnvelopeVersion } from "../server/work-handoff.mjs";

const NOW = Date.parse("2024-10-18T00:00:00.000Z");
const iso = ms => new Date(ms).toISOString();

const record = ref => handoffEnvelope({
  envelopeVersion: handoffEnvelopeVersion,
  id: "he_url",
  from: "agent-a",
  to: "agent-b",
  createdAt: iso(NOW),
  objective: "Fetch the public brief and draft a reply",
  inputs: [{ kind: "url", ref }],
  authority: {
    permissions: ["accept_work"],
    scope: { rooms: ["room-1"] },
    expiresAt: iso(NOW + 24 * 3600 * 1000),
  },
  expectedOutput: { kind: "text_result", description: "A short public brief" },
  acceptanceTest: { checks: [{ kind: "result_submitted", workId: "work-1" }] },
  termination: { expiresAt: iso(NOW + 24 * 3600 * 1000), onExpiry: "release" },
  provenance: { createdBy: "agent-a", claimId: "lane", taskId: "work-1", chain: [] },
});

test("handoffEnvelope rejects a URL that embeds credentials", () => {
  assert.throws(
    () => record("https://ops:s3cret@example.test/repo"),
    error => error.code === "invalid_handoff_envelope",
  );
  assert.throws(
    () => record("https://ops@example.test/repo"),
    error => error.code === "invalid_handoff_envelope",
  );
});

test("handoffEnvelope still accepts a credential-free https URL", () => {
  const withPort = record("https://example.test:443/repo");
  assert.equal(withPort.inputs[0].ref, "https://example.test:443/repo");
  const pathAt = record("https://example.test/a@b");
  assert.equal(pathAt.inputs[0].ref, "https://example.test/a@b");
});
