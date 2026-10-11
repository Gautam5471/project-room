# Contributor experience: implementation plan and execution prompt

## Outcome

An outside person can join Project Room, find a useful task, work with a real
agent, submit a focused contribution and see its review/release outcome. The
human mostly interacts with one shared conversation. Other people can prompt,
clarify and review together; individual agents remain accessible on demand.
GitHub-only contribution stays first-class. Apache-2.0 remains the project license.

## Research decisions

- OpenHands connects repository work to explicit sessions and review outcomes.
  Adopt the visible request-to-result loop, reusing our own work/claim machinery:
  https://github.com/OpenHands/docs/blob/main/openhands/usage/use-cases/code-review.mdx
- Temporal distinguishes asynchronous messages from tracked operations and
  documents retry-safe message handling. Apply the distinction to existing
  delivery and journal mechanisms before considering another orchestration service:
  https://docs.temporal.io/encyclopedia/workflow-message-passing
- GitHub requires untrusted fork code to be separated from privileged automation.
  Keep contributor tests secret-free and run event handling from trusted code:
  https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target
- Open Source Guides emphasizes clear scope, public decisions and maintainer
  responsiveness. Prefer a small maintained task queue over automated issue volume:
  https://opensource.guide/best-practices/
  https://opensource.guide/metrics/

These are design inputs, not proof of our product's behavior. No claim of an
exhaustive competitor code audit or live external contributor study is made.

## Existing systems to reuse

- `scripts/agent-inbox.mjs` and the agent quickstart: resumable enrollment and tools.
- Existing host listeners/supervisors: real receipt and response verification;
  distinguish identity, access, listening and execution readiness.
- `scripts/contribution-journey-check.mjs`: synthetic invitation, conversation,
  return and human review on desktop and touch.
- `scripts/github-work-sync.mjs`: idempotent merge notices for conversation work
  items marked with `Room-Work:`; it deliberately does not mark work complete.
- `server/claim-autolink.mjs`: claim/PR matching, a mounted optional
  `/api/github/pr-webhook`, polling fallback and deploy linking.
- `server/github-app/`: signature, installation-token and receipt primitives;
  advertised `/api/github/webhook` and `/github/setup` are separate unfinished routes.
- Existing work items, Board claims, event journals and review policies. Do not
  introduce a third task database or a second generic coordinator.

The GitHub door's scheduled digest runs every ten minutes. Keep it as a fallback,
not the primary low-latency interaction path. Agent signup docs are not proof of
an installed host listener. Local passing tests are not proof of hosted configuration.

## Ordered work and acceptance

### 1. Establish a reproducible contributor baseline

Finish the public onboarding PR; retain the corrected self-host email/password
path. Add one cold-start acceptance test using the real `server.mjs`, an empty
disposable DB, UI signup, message submission, actual process restart and a fresh
browser login. It must assert the same room and persisted message, without
preseeded sessions or credentials. Include it in the existing browser CI list.
Compose existing contribution and GitHub tests into one focused command.

Acceptance: the command succeeds without hosted credentials or a model account;
the browser test fails if the database or account cannot survive restart. Record
OS/runtime, exact revision and limitations. Do not duplicate every auth unit test.

### 2. Restore a dependable delivery path

Inspect queued CI jobs before changing workflows. Record queue age, runner
assignment and concurrency state. Do not cancel unrelated agents' runs or weaken
required checks to force a merge. Repair demonstrated causes; account/runner
capacity problems need explicit evidence and the appropriate operator action.
Triage all package trees, not only the root npm audit: relay and Cloudflare have
separate lockfiles. Patch compatible dependencies in a separate focused PR and
run those packages' tests. Qualify the exact final revision for release.

Acceptance: required checks complete on the candidate head; dependency findings
are fixed or individually assessed with evidence. A queued check is neither a
pass nor a code failure. Release remains blocked without a verified merge slot.

### 3. Verify one real contributor and host

Use a fresh synthetic contributor in an explicitly designated test room. Join
through the ordinary invite flow, connect one real supported external host, send
a directed request and wait for an actual reply recorded in Room. Repeat after
host restart and interrupted delivery. Verify a second human can clarify the
request without creating a duplicate task. Reuse existing enrollment and wake
configuration, and report the exact host/runtime used.

Acceptance: identify the host receipt, room response and recovery result. Report
unavailable/disconnected honestly; never fake a model reply or treat a test double
as host evidence. Keep tokens private. If live credentials are unavailable,
finish local verification and name the unresolved configuration precisely.

### 4. Close the GitHub loop using existing adapters

Map conversation work IDs and Board claim IDs before wiring the UI. Expose the
PR link and check/review/merge state on the existing task surface. Extend the
mounted PR receiver and shared verification primitives where appropriate; do not
mount the incomplete App wholesale just to make a route return 200.
Exercise signed deliveries over HTTP, malformed signatures, retries and outcome
reconciliation. Preserve one notification per event, visibility boundaries and
GitHub's source-of-truth role. Clearly separate merged from deployed.

Acceptance: a linked PR updates the intended task once; repeated delivery does
not produce duplicate work or posts; unrelated rooms receive nothing. An App
installation must bind repository/installation/room authority explicitly.

### 5. Make the shared human thread useful

Reuse the current conversation and task panel. Default to one coordinator voice
with concise progress grounded in actual events. Provide result/review/stop
controls and contextual questions. Show agent identities and detailed activity
on expansion; never expose private chain-of-thought. Preserve direct addressing.
Typing indicators represent actual typing/streaming, not fabricated acceptance.
No extra sign-in paragraphs, emoji controls or mandatory setup wizard.

For multiplayer prompting, retain each person's message and attribution; route
clarifications to the active task, show conflicts that need a decision and avoid
starting two executions for the same request. Agent tools should read/update
structured state directly, using cursors, batches and stable request IDs where
already supported. UI automation is a fallback for actions lacking machine tools.

Acceptance: test keyboard, narrow and desktop layouts, prompt interruption,
cancellation, two concurrent humans, reconnect and review. Measure server receipt,
host acceptance and first useful response separately; set latency targets after
recording an honest baseline rather than inventing measured numbers.

### 6. Invite and retain contributors

Prepare five bounded public tasks with acceptance criteria and a named reviewer.
Publish a contributor invitation only once its expiry/admission/support behavior
is verified. Keep project decisions discoverable in public issues or docs.
Demonstrate one real completed task with synthetic content and clear setup/costs.
Track first useful result, response time and returning contributors; do not rank
people by generated lines, issue count or messages. Credits/bounties should build
on accepted results after the contribution loop is reliable, not incentivize noise.

## Detailed execution prompt

Act as the maintainer implementing this plan. Start from the current repository
and preserve other agents' work. Read applicable instructions, the public PR
queue and available coordination state; use an isolated checkout and claim exact
paths. If live coordination is unavailable, prepare bounded work and report the
outage without claiming a lease. Keep earlier unfinished work visible; do not
silently bundle unrelated coordinator branches into this contribution change.

Audit the existing implementation at each named boundary before coding. Trace
routes through handlers, storage, clients, UI and tests. Distinguish dead modules,
feature flags, installed configuration and production verification. Reuse the
strongest existing owner for each behavior. Prefer connecting, simplifying and
removing misleading claims to creating parallel systems.

Execute phase 1 first and use its failures to prioritize repairs. Add tests only
for independently meaningful boundaries. The new cold-start test must drive the
actual page and restart the actual process; it must not log in through a fixture
API. Isolate temporary state and inherited credentials, clean up processes even
on failure, use bounded waits and assert persistent observable results. Wire it
into the existing CI suite, not a decorative unexecuted script.

Next inspect the delivery and GitHub integration evidence. For any new webhook
path, verify signatures on original bytes, map its authority and test redelivery
through HTTP. Never execute PR content in a privileged workflow. Consolidate
only after preserving existing work-item versus claim semantics. For host work,
require actual receipt/reply evidence and keep unavailable hosts visibly pending.

Use existing human design conventions: minimal entry page, one shared thread,
compact task progress, context-specific choices, no technical status clutter.
Give agents structured machine access with stable identities and retry-safe
commands. Do not add a marketplace, reputation hierarchy, new message bus or
credit economy merely to make this plan broader; these follow demonstrated user
needs once the contributor loop works.

Run focused checks, repository-required lint and affected tests. Inspect the diff
and report failures honestly. Push coherent reviewable checkpoints and link the
PR. Merge and deploy only through the verified shared lane and passing hosted
checks. Finish with exact evidence, remaining blockers and the next concrete
step; do not describe prepared work as merged, released or externally validated.

## Execution checkpoint — 2026-10-11

Implemented the phase-1 acceptance baseline and the public in-room contribution
guide in the onboarding PR. `npm run test:contributor` passes six checks, including
the new actual-process cold-start journey and a signed PR auto-link over HTTP,
with tamper rejection and duplicate-delivery checks. The new browser check is
registered in the existing browser suite. The affected gate passes 240 tests;
lint passes with existing warnings. `CI=1 npm run check` passes the full
contract gate (the full unit suite is intentionally separate); documentation
validation resolves 395 links. Documentation-contract failures from
the earlier cleanup were corrected by restoring the schema version, agent entry
link and clearly scoped maintainer references, without requiring private coordination for outsiders.

The GitHub Actions API shows the onboarding run queued with no runner assigned;
Actions is enabled and other runs have active hosted runners. This establishes
waiting, not its cause. Do not claim a billing outage or fix by weakening checks.

Dependabot identifies the 15 alerts as development dependencies. A fresh relay
`npm audit --package-lock-only` reports four affected package nodes (including
transitive parents); that count is not the advisory count. Its suggested Miniflare
upgrade is a major alpha. Review compatible patched transitive versions and test
relay/Workers before selecting an upgrade; do not run force-fix blindly. This
triage does not establish production exploitability or resolve the alerts.

Still unverified: minimum-version Linux installation, signed desktop download,
real external host receipt/reply/restart, live GitHub configuration and production
signup/release. The local coordinator config still returns `invalid_config`.
No live claim, merge or deployment is represented by this checkpoint.
