# Flaky-Test Quarantine

A flaky test — one that fails non-deterministically while the product is fine — must **leave the blocking suite the same day it is identified**. Flakes rot signal: one red-but-meaningless test trains every lane to ignore CI. Quarantine keeps the red honest without silencing the test.

## The lifecycle

1. **Quarantine it today.** When a flake is confirmed (not "maybe", confirmed — fails at least once on a green tree), open a PR that (a) removes it from the blocking suite (skips it, or moves it out of the default `node --test` glob) and (b) appends an entry to `tests/quarantine.json`. Same PR, same day.
2. **Record the entry.** Shape:
   ```json
   {
     "test": "tests/worker-pool.test.js > drains on SIGTERM",
     "reason": "assert.throws timing: race between SIGTERM handler and drain loop (seen 3x on CI, never locally)",
     "owner": "quill",
     "quarantined_at": "2026-10-05",
     "repair_by": "2026-10-19"
   }
   ```
   `reason` is the failure signature, not a vibe — enough that a stranger can reproduce the flake. `repair_by` is at most 14 days after `quarantined_at`. `owner` is a lane or handle; it may be filled in by the repair lane within the 14-day window if unknown at quarantine time.
3. **While quarantined, the test runs in the non-blocking lane.** Quarantined tests are executed by `scripts/run-quarantined-tests.mjs` (`npm run test:quarantined`), which reads `tests/quarantine.json`. Entries identify tests either by file plus test name (`"file > test name"`) or by a bare file. The runner executes each test with `QUARANTINE_RUN=1`. A failing test produces a non-zero exit status from the local runner.

   In CI, `.github/workflows/zero-bug-quarantine.yml` defines two jobs:
   - **`quarantine-check`**: validates the quarantine registry on pull requests and pushes to `main`.
   - **`quarantined-tests`**: executes the quarantined tests on pushes to `main`. The job sets `continue-on-error: true`, making the CI execution lane non-blocking so test failures report honestly without failing the pipeline.

   Quarantined tests can be run locally using:
   ```sh
   bash scripts/test-env.sh npm run test:quarantined
   ```
4. **Repair or re-admit within 14 days.** The owner fixes the root cause (not the assertion — the race, the clock dependency, the shared fixture) and the test re-enters the blocking suite with its entry deleted. A genuinely unfixable test is re-admitted only as a deleted test: remove the entry and delete or permanently disable the test with the reason recorded in the PR, never as an indefinite quarantine.

## The enforcement

The `quarantine-check` job runs `scripts/quarantine-check.mjs` in CI on every PR and every push to `main`. It exits non-zero when any entry violates the contract:

- **past `repair_by`** — the 14 days are up, the test is not fixed, and nobody re-admitted or deleted it;
- **`quarantined_at` older than 14 days with no `owner`** — an ownerless flake quietly becoming permanent;
- malformed entries, unparseable dates, future `quarantined_at`, or `repair_by` beyond the 14-day cap.

Fix violations by doing the actual work (repair the test), not by editing dates. Extending a `repair_by` requires the reason field to say why and who agreed — and it still cannot exceed 14 days from `quarantined_at`.

## Deterministic time (TST-11)

A test that reads the wall clock while the code under test reads an injected clock can flake: a slow runner or an `advance()` moves one clock and not the other. Use `tests/helpers/test-clock.mjs`. `createTestClock()` gives the store and the assertions one clock (`new RoomStore(file, { now: clock.now })`, then assert against `clock.now()`). `freezeDate(t, at)` pins the global `Date` for one test when the code takes no clock; real `setTimeout` waits still run. First users: `tests/guest-join.test.js` (exact TTL on the store clock instead of a 60 s window) and `tests/claim-scopes.test.js`.
