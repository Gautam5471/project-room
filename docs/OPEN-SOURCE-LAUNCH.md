# Open-source launch checkpoint — 2026-10-11

This is an execution checklist, not a release announcement. Local verification
below used Node 26.8.2 on macOS and base revision 5f820dad; it does not establish
minimum-Node compatibility, production OAuth, or signed desktop readiness.

## Completed

- [x] Enable GitHub Discussions and automatic merged-branch deletion.
- [x] Enable Dependabot alerts and automatic security updates.
- [x] Enable immutable future releases; older releases are not retroactively immutable.
- [x] Preserve existing secret scanning, push protection, and private vulnerability reporting.
- [x] Prepare a concise README, public contribution path, support, conduct and governance guidance.
- [x] Remove private-room and coordination-bus prerequisites for outside contributors.
- [x] Verify `npm ci` and persistent operator provisioning with private key-file delivery.
- [x] Verify empty-database startup, real browser email/password signup, automatic room creation and authenticated reload.
- [x] Replace stale self-host instructions for the removed browser room-key form.
- [x] Pass 14 focused first-use, provisioning and runtime-package checks.
- [x] Pass documentation link and whitespace checks.

## Before announcing a release

- [ ] Merge the onboarding PR through the existing protected queue after its checks pass.
- [ ] Test the documented quickstart on the minimum supported Node version and Linux.
- [ ] Record one real end-to-end external agent connection: enrollment, human prompt,
      host receipt, response, disconnect and reconnection. A profile or tool ping is insufficient.
- [ ] Verify the intended public host's signup, email delivery, login, invitation and recovery.
- [ ] Triage the 15 open Dependabot alerts (six high) found when alerts were enabled:
      `relay/package-lock.json` (sharp and undici) and both Cloudflare lockfiles
      (sharp). Verify reachability, apply compatible fixes and test each package.
      A clean root `npm ci` audit does not cover these separate dependency trees.
- [ ] Qualify one exact release commit with the release owner's existing acceptance suite;
      package that revision and publish checksums and known limitations.
- [ ] For desktop distribution, attach a signed and notarized Mac build and verify a
      downloaded installation and its login return path. Existing runtime archives are not Mac installers.
- [ ] Capture a short real demonstration of a human task and an agent-produced result.
      Use synthetic content, disclose the setup and exclude credentials/private conversations.
- [ ] Finish reviewing public issue labels (#863 no longer carries `good first issue`): move discussion-only items out of `good first issue`,
      and select bounded reproducible tasks with acceptance criteria and a maintainer contact.
- [ ] Publish a welcome Discussion linking to the merged quickstart and invite reports
      of setup failures. Do not promise support response times we cannot meet.

## Decisions that remain explicit

**Review enforcement.** Main currently requires checks and disallows force pushes,
but required approval count is zero and CODEOWNERS review is not enforced. The only
listed code owner is Uuriko, also the author of many agent PRs. Requiring that same
owner's approval would strand self-authored PRs. Establish a second consenting
maintainer/reviewer before changing that protection; do not mistake CODEOWNERS prose
for an enforced review gate.

**Conduct reporting.** GitHub provides Report content for abuse. No separate private
maintainer conduct inbox is configured. Security reports have their existing private
vulnerability-reporting route.

**Release ownership.** The live coordination CLI reported `invalid_config` during
this pass. A local board/bus claim is not a verified live merge lease. Repair that
connection or obtain the release owner's explicit handoff before landing overlapping
work or publishing a combined release.

**Success measure.** Track actual outside-user completion: local install, first room,
first working agent reply, first useful contribution and return usage. Stars and
agent-authored issue volume do not establish those outcomes. Begin with voluntarily
reported setup results; do not silently add telemetry to self-hosted installations.
