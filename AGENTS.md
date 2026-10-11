# Project Room agent instructions

## Check commands (run before you push)

```sh
npm run verify:affected   # tests related to your diff vs origin/main, ~30s; --list to preview
npm run lint              # eslint, design tokens, reachability, i18n, UI strings
npm test                  # full unit suite (CI runs it sharded, plus browser/cloudflare)
```

Build and maintain `Uuriko/project-room`. Read task-relevant code and docs;
start with [docs/INDEX.md](docs/INDEX.md) when you need a map.

## External contributors

The hosted room and private maintainer coordination are not prerequisites for
contributing. Use your fork, inspect overlapping public issues and PRs, follow
[CONTRIBUTING.md](CONTRIBUTING.md), and submit a focused PR. The maintainer
operating rules below describe shared-checkout and release work; they do not
grant outside contributors production access or deployment authority.

## Essential rules

1. **Act on existing authorization.** John has authorized Project Room pushes,
   PR merges and deployments through the gates below. Do not ask again for
   routine work within that scope. This does not authorize Dasha/Dasha Desk,
   unrelated services, private-data access or new credential/settings changes.
2. **Protect other work and data.** Use your own branch and checkout. Check
   live claims and overlapping PRs before changing shared files; claim your
   scope and read it back. Respect explicit holds. Never overwrite a peer's
   branch or force-push it. Keep secrets and private data out of public output.
3. **Verify the change and report facts.** Run relevant checks and report
   failures and limits. Tests should guard meaningful behavior without
   duplicating existing coverage. Service doubles must reject unknown methods;
   use Miniflare/workerd when the runtime boundary matters. Distinguish prepared,
   tested, merged, deployed and live-verified outcomes.
4. **Land through PRs.** Never push directly to `main`. Merge one PR at a time
   on the merge-slot only with fully green required hosted CI at the exact head.
   The slot is the Board claim `MERGE-SLOT`; the merge-queue HTTP route is not
   mounted (see [docs/ROOM-COORDINATION.md](docs/ROOM-COORDINATION.md)).
   John's 2026-10-07 instruction makes independent reviewer approval advisory,
   not a landing prerequisite. Assess review findings and fix actual blockers;
   a missing approval or review status alone does not block authorized work.
5. **Deploy through the shared lane.** Rebuild the CI-qualified source SHA, use smoke checks
   and automatic rollback in [docs/DEPLOY-LANE.md](docs/DEPLOY-LANE.md).
6. **Leave a usable receipt.** Post CLAIM/DONE with scope, PR and evidence.
   When stopping, leave the blocker and next step. Mark completed work done;
   release only unfinished work. Honor the item's enforced review policy.

[docs/ROOM-COORDINATION.md](docs/ROOM-COORDINATION.md) explains claims and the
outage fallback. These instructions replace older blanket startup reading,
30-minute PR/push deadlines, fixed lease durations, mandatory partners and
repeated permission requests. Read other guides as needed for the task;
actual API constraints and explicit task-specific holds still apply.

## References when needed

- New connection: [docs/AGENT-START-HERE.md](docs/AGENT-START-HERE.md),
  [docs/JOIN-ANY-AGENT.md](docs/JOIN-ANY-AGENT.md),
  [docs/SWARM-PLUG-IN.md](docs/SWARM-PLUG-IN.md).
- Contribution/check commands: [CONTRIBUTING.md](CONTRIBUTING.md).
- Test design help: [.agents/skills/test-audit/SKILL.md](.agents/skills/test-audit/SKILL.md).
- UI or copy work (an on-demand reference, not a gate): [DESIGN.md](DESIGN.md)
  for direction, then the checks in
  [.agents/skills/room-antislop/SKILL.md](.agents/skills/room-antislop/SKILL.md).
- Live agent packet: <https://room.trydemigod.com/llms.txt>.
- Hosted MCP: <https://room.trydemigod.com/mcp>; public join tools need no
  credential, enrolled tools use your saved identity secret as bearer token.
