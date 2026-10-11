# Contributing to Project Room

People and agent-assisted contributors are welcome. Bug reports, accessibility fixes, documentation, and integration examples count. Start with the [README](README.md), [self-host guide](docs/SELF-HOSTING.md), and [docs index](docs/INDEX.md).

## A small change, end to end

1. Check existing issues and pull requests for overlapping work. For a small fix, open a focused pull request directly; for a substantial feature, discuss the approach in an issue first. No hosted account, private coordination bus, or live-room claim is required for an outside contribution. Maintainers working on shared checkouts or production use [ROOM-COORDINATION.md](docs/ROOM-COORDINATION.md). Agents should also read [AGENTS.md](AGENTS.md).
2. Fork the repository, clone it with history, create a focused branch, and run `npm ci` with Node 24.19 or newer. No hosted account or model API key is required to develop the core app. If a test fails with `ERR_MODULE_NOT_FOUND` for a package that is listed in `package.json` (for example `yaml`), your `node_modules` predates the commit that added it — re-run `npm install`. `npm test` fails fast with exactly this diagnosis via `scripts/check-deps.mjs`, so you do not have to guess.
3. Make the smallest cohesive change. Keep private Inbox data separate from room content, and test authorization failures as well as the happy path.
4. Run checks relevant to the change. Documentation-only changes need `git diff --check` and `node scripts/docs-link-check.mjs`; they do not need a new test or the full local application suite. For code, `npm run lint` runs the canonical lint gate and `npm run check` runs the standard syntax/contract/lint and unit checks. For UI changes, install Chromium with `npx playwright install --with-deps chromium` and run affected browser checks (`npm run test:browser` is the full suite). Workers changes also need [cloudflare/README.md](cloudflare/README.md). Run tests via `scripts/test-env.sh` so TMPDIR points at the worktree-local `.tmp/`. Hosted CI still must pass on the final head before landing.
5. Open a pull request that states the problem, the resulting behavior, the tests, and the limits. CI includes lint, contract, unit, browser, cloudflare, and component checks. Required CI must pass on the final revision. Repository access never grants permission to read user data or to deploy someone else's service.

## Replay and release

For changes to event admission, reducers, projections, or journals, explain three cases: old history on new code, newly accepted events on older code, and the supported recovery path. An unchanged database schema does not establish replay or rollback compatibility.

Submit only work you have the right to contribute under [Apache-2.0](LICENSE). No copyright assignment or separate CLA is required. Do not fabricate sign-offs. AI assistance is welcome under the same review standard. The submitting person reviews the output and reports which tests actually ran. Never include credentials, private messages, or customer data in issues, fixtures, or prompts sent to services without authorization.

## Review

Be specific and constructive. Maintainers may remove harmful content. The repository owner, [@Uuriko](https://github.com/Uuriko), decides scope, merge, and release. We aim to acknowledge contributions, but response times depend on maintainer availability. A submission does not guarantee acceptance. Use [SECURITY.md](SECURITY.md) for vulnerabilities. Keep one issue per problem, and do not file automated duplicate reports.

## Find your way around

Start with [the architecture map](docs/ARCHITECTURE.md). Browser code lives in `src/`, server modules in `server/`, agent clients in `client/`, machine integration in `machine/`, and native Mac code in `desktop/macos/`. Follow nearby tests for the area you change. See [support](SUPPORT.md), [community conduct](CODE_OF_CONDUCT.md), and [governance](GOVERNANCE.md).

## Work together in Project Room

See [Build Project Room in Project Room](docs/CONTRIBUTING-IN-ROOM.md) for the
optional shared conversation, agent connection and GitHub handoff. For a focused
local readiness check, install Playwright Chromium and run
`bash scripts/test-env.sh npm run test:contributor`. This uses synthetic local
data and needs no hosted credentials; it is not a substitute for the tests
relevant to your change.

## Shared-checkout maintainers

Maintainers coordinate overlapping work through the work-claim board:
`GET /api/rooms/{roomId}/work-claims`. Follow
[ROOM-COORDINATION.md](docs/ROOM-COORDINATION.md) for claims and releases.
This internal coordination path is not a prerequisite for an outside fork or PR.
