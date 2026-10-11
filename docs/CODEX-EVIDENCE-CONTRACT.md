# Offline Codex evidence inspector

Inspect one existing private evidence file produced by
`scripts/native-host-request-run.mjs`, without changing that runner:

```sh
node scripts/codex-evidence-summary.mjs /absolute/path/to/evidence.json
```

The command reads that explicit regular file only, prints a redacted JSON
summary to stdout, and never starts Codex, a model, a browser, a tool, or a
network request. It does not discover sessions or read Codex history, config,
authentication, or adjacent files. It does not write any file. Preserve the
original evidence privately. Do not redirect stdout onto the input file:
shell redirection can truncate it before this command starts.

Exit codes:

- `0`: zero process exit and an observed, structurally consistent completed
  turn, without known parse/lifecycle damage
- `1`: supported evidence with a failed/incomplete turn or a non-successful
  process disposition (including an unresolved host)
- `2`: invalid/unreadable/oversized envelope, unsupported host or known
  incompatible event dialect, invalid UTF-8, non-regular file, or wrong arguments

Neither exit code zero nor a `turn.completed` event proves the Room accepted
work, tests passed, an independent review happened, or anything was deployed.
The four `verification` fields always say `not_established`. Check the actual
Room records and independent evidence separately. This inspector is a local
projection of untrusted evidence, not an authenticity verifier or acceptance gate.

## Programmatic contract

`summarizeCodexEvidence(jsonText)` is an exported pure function: supply the
whole native-host evidence JSON as a string. It returns the same version-1
summary as the CLI and does no I/O. It never returns raw input or exception
messages. The CLI's UTF-8 and regular-file checks apply before this function.

Required envelope fields: `host: "codex"`, integer-or-null `code`,
string-or-null `signal`, boolean `timedOut` and `outputLimited`, and string
`stdout`. The runner's unresolved-host envelope may omit `stdout` when it
contains a nonempty string `hostUnresolved`. Other envelope fields, including
prompt, stderr, phase, timestamps, member ID, and boundary text, are not emitted.

- `input.accepted` describes envelope/dialect support, not acceptance of work
- `input.complete` means the parsed stream has no detected structural damage;
  it does not assert the process finished or that the file is authentic
- `process.disposition` is one of `host_unresolved`, `timed_out`,
  `output_limited`, `signaled`, `exited_zero`, `exited_nonzero`, `unknown`, in
  that precedence order. Timeout/output-limit booleans are also retained
- `turn.disposition` is `failed` if any validated `turn.failed` or stream-level
  `error` was seen, even when a later completion or exit zero appears. Otherwise
  it is `completed` only with a matching started/completed lifecycle, no open
  turn, no pending items and no known malformed or conflicting evidence.
  All remaining cases are `incomplete`. Multiple complete turns are supported.
  Conflicting thread identities or items outside an open turn damage the stream.
  A thread-start record is optional; its absence is not proof of thread identity
- `events` counts records and item lifecycle events, including repeated update
  records. Empty lines are ignored. `turn` also counts terminal records
- `items` counts distinct IDs internally, never emits them, and separates tools,
  terminal/pending items, failed/declined items, nonfatal error items, unknown
  item kinds and identical terminal-status repeats. Failed/declined evidence is
  sticky across updates; repeat snapshots do not inflate unique item counts.
  Reusing an ID with another kind, reopening a terminal item or conflicting
  terminal statuses marks the stream incomplete. Item IDs are scoped to this
  evidence file. These are observed lifecycle counts, not unique physical
  side effects or a proof that tools succeeded

A failed tool item or nonfatal `error` item can be followed by a recovered,
completed turn. Its count remains visible; it does not itself fail the turn.
Unknown optional event/item kinds produce fixed compatibility warnings and no
raw names. A pending unknown item is still pending. Extra fields are tolerated.
Known malformed fields prevent clean completion. MCP arguments/results and
web search action/results are opaque; their contents are not schema-validated.
App-server JSON-RPC/method records and Claude-style assistant/user/system/result
records are explicitly unsupported, rather than mistaken for exec completion.

## Bounds and privacy

Hard bounds are 16 MiB UTF-8 envelope, 256 KiB per JSONL line and 20,000
nonempty event records. On a line/event limit, processing stops and completion
is conservative; counts describe only the inspected prefix. Oversized envelopes
are rejected before parsing. CLI reads at most the file limit plus one byte,
including when a file grows after it is opened. Regular-file checking and a
nonblocking open avoid accepting devices/directories or waiting on a FIFO.
CRLF and a final line without newline are supported. Invalid JSON, malformed
records, invalid UTF-8 and file errors return only closed reason codes.

Output is bounded by fixed keys, counters and a finite set of warning codes.
No prompt, stdout/stderr excerpt, tool arguments/results/text, raw ID, raw tool
or server name, path, signal value, exception string or token is returned.
Warnings count categories once, not individual raw error messages. Unknown
records can still contain failures this version cannot understand; compatibility
warnings warrant inspection with an appropriate newer reader before relying on
these observations. The function does not verify signatures, producer identity,
file stability during a concurrent write, or model claims.

## Upstream basis and licensing

The event vocabulary and lifecycle distinctions were reviewed against official
OpenAI Codex commit `cc7ba33601286a751477832b01de7b6f8de0dd9c`:

- [SDK events](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/sdk/typescript/src/events.ts)
- [SDK items](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/sdk/typescript/src/items.ts)
- [Rust exec events](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/exec/src/exec_events.rs)

Rust additionally describes collab tool calls, declined commands, in-progress
file changes, and defaulted MCP arguments. These are recognized here. The
cache-write usage field is optional per Rust's default; the other pinned usage
counters are required safe nonnegative integers. Older/different schemas may
produce conservative warnings rather than a completed result. This is not the
app-server notification protocol and is not a universal Codex version adapter.

The implementation and tests are original JavaScript, with no literal upstream
source copied. Codex is Apache-2.0; its root NOTICE identifies OpenAI copyright
2025 and MIT-derived Ratatui code. No Rust, Ratatui or SDK implementation is
vendored by this change, so no copied-source NOTICE addition is needed.

## Tests

```sh
node --test tests/codex-evidence-summary.test.js
npm run verify:affected
npm run lint
```

Tests use synthetic in-memory records and disposable files only. CLI tests
spawn this Node inspector, never a native agent or an authenticated service.
They cover terminal/process separation, failure and recovery, malformed and
unknown records, duplicate/conflicting lifecycle evidence, redaction, bounds,
unsupported dialects, UTF-8, CRLF and preservation of input bytes.
