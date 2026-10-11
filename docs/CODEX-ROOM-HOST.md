# Run Codex for a shared Room conversation

This opt-in host connects an existing Room assistant identity to a dedicated local
Codex App Server. It executes a selected **public shared ask**, including its
human contributions, and publishes one result through Room's atomic publication
endpoint. It does not import the Codex desktop app's account or conversations.

## Prepare a dedicated runtime

Use Node 22.13+ with `node:sqlite` and a Codex executable supporting App Server
thread start/read/resume and turn start/steer/interrupt. A version string alone
is insufficient; run the protocol check below.

Choose a private directory outside both the workspace and your usual `.codex`
directory. Example paths below must be replaced with your actual absolute paths.

```sh
mkdir -m 700 /absolute/room-codex-home
CODEX_HOME=/absolute/room-codex-home /absolute/codex \
  -c 'cli_auth_credentials_store="file"' login
```

Complete the normal Codex login for this dedicated profile. Do not copy your
ordinary `auth.json`, HOME, or desktop session directory. The host uses a separate
process HOME and a minimal environment; it forwards no Room token or inherited
API key. Dedicated Codex configuration and credentials remain operator-managed.

Save `/absolute/runtime.json`:

```json
{
  "command": "/absolute/codex",
  "cwd": "/absolute/project-checkout",
  "codexHome": "/absolute/room-codex-home",
  "policy": {
    "approvalPolicy": "never",
    "sandbox": "workspace-write"
  },
  "requestTimeoutMs": 30000,
  "turnTimeoutMs": 300000
}
```

Use `read-only` for inspection tasks. An optional `model` chooses a model available
to the dedicated account. This unattended host accepts only the two listed
sandbox modes and `approvalPolicy: "never"`; tools outside the configured policy
are denied, not silently approved. Clearing the environment is not an additional
OS sandbox; Codex enforces the selected tool sandbox.

From the Project Room source checkout:

```sh
node scripts/run-codex-room.mjs --check /absolute/runtime.json
```

The check starts a dedicated process, initializes it, creates and names an empty
probe thread, then reads and resumes its history. Naming persists the empty
paginated thread; requesting history before that can report `list_turns is not
supported yet` even on a compatible release. No model turn runs. A successful
check proves these protocol operations, **not provider authentication or successful
model/tool execution**.

## Select the Room and shared ask

Reuse the saved private Room connection directory. Its `connection.json` selects
the origin, room and member; do not print its token. The room owner must already
have selected this agent as the room assistant. A human creates the shared ask
in the room. Listing does not start work:

```sh
ROOM_AGENT_CONFIG=/absolute/room-connection \
  node scripts/run-codex-room.mjs --list
```

Execute one of this member's selected runs:

```sh
ROOM_AGENT_CONFIG=/absolute/room-connection \
  node scripts/run-codex-room.mjs RUN_ID \
  /absolute/private-room-journal.sqlite /absolute/runtime.json
```

The CLI checks the protocol **before claiming the run**. It streams answer deltas
as JSON to stdout and prints the final Room status/result ID. It passes neither
connection credentials nor private runtime reasoning into the room. The journal
binds the Room origin, room incarnation, member, run and attempt to the runtime
thread and turn. Only newly created or journal-authorized threads are accessible.
It does not list, attach to, or control unrelated Codex sessions.

## Stop, retries and interactive requests

Use Stop in the Room conversation to request interruption. The host polls shared
controls, interrupts the exact runtime turn and acknowledges stopping only after
observing terminal execution. Ctrl-C/SIGTERM stops the local host and interrupts
its owned work; if settlement cannot be confirmed, Room remains recoverable
rather than claiming success. The process group is terminated on host exit.

Keep both the private journal and dedicated Codex home. Rerunning the exact
command reconciles the original attempt or retries the saved atomic publication;
it must not execute the original completed work again. Ambiguous start/steering
responses require reconciliation. Never delete the journal to force a retry.

Only one host process may use a dedicated profile at once. An unresolved
`.room-runtime.lock` means inspect whether its process is still running before
manually removing that lock; do not remove it just to start a second host.

This CLI has no interactive approval or user-answer UI. Every runtime-initiated
approval/question receives an explicit JSON-RPC refusal, and stderr reports
`runtime_attention_required` with the request method. Ordinary group-chat text
is never interpreted as an approval. Use a task allowed by the configured policy
or a separately integrated interactive host when a genuine decision is required.

## Qualification evidence

On 2026-10-11, dedicated temporary profiles passed initialize, thread start,
metadata persistence, history read, and resume with both the installed Codex
0.159.0 and the official standalone `rust-v0.162.1` macOS ARM64 executable.
These checks used no model credentials and performed no model turn.

The 0.162.1 archive came from the [official release](https://github.com/openai/codex/releases/tag/rust-v0.162.1).
Its SHA-256 matched the GitHub release asset digest:
`b293a0fcdd871900a44c0a4f40a1aa401b31e02854f790ebdb8bd5d1177fd1fe`.
The existing app/global executable was not replaced.

Automated tests run a real fake-protocol subprocess through the CLI and a local
Room HTTP fixture, including atomic result publication. They also cover scoped
threads, private process environment, unsupported interactive requests, malformed
output, disconnects, timeouts and duplicate profile locks. Live authenticated model
execution requires the dedicated profile login and remains separate qualification.
