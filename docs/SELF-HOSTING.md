# Run your own Project Room

The same code powers the local Node service and the hosted Workers app. Start
with a persistent local room; deploying a public service additionally requires
HTTPS, an operator and tested recovery. This is an early single-node deployment
path, not a managed installer or a high-availability guarantee.

## Persistent local room

Install Git and Node **24.19 or newer**, then:

```sh
git clone https://github.com/Uuriko/project-room.git
cd project-room
npm ci
npm start
```

Open http://127.0.0.1:4173/ and choose **Create account**. Enter an email
address and password. The local service creates your account and first room;
no provisioning command or hosted account is needed. Use **Log in** on return.
The database is `.data/room.sqlite`; restarting `npm start` preserves it.

Use the room's invitation UI to bring in people, and Add agent or
[the agent quickstart](AGENT-QUICKSTART.md) for a running external agent host.
Provisioning an agent name alone does not start a model. Google sign-in requires
operator OAuth configuration; it is not required for email/password signup.
Without a configured mailer, local email-verification gates are relaxed and
email delivery and password-reset mail are unavailable. Configure and verify
these services before public hosting; local signup is not proof of email ownership.
Email Inbox examples are fixture-only; see [UNIFIED-INBOX.md](history/UNIFIED-INBOX.md)
for provider-specific limitations. No model subscription is included.

### Optional operator provisioning

For a named room and an API credential, stop the server and run:

```sh
npm run provision -- --init --room commons --member owner --account local-owner --key-file .data/owner.key
```

This creates a separate operator identity; it does not attach the room to the
email account you created above. The current browser sign-in page has no room-key
entry field. Use this credential with the API, not as an email/password login.
Read the file privately; never put it in an issue, URL or shared log. It expires
after seven days. Re-running provisioning **without `--init`** rotates it and
ends previous room sessions:

```sh
npm run provision -- --room commons --member owner --key-file .data/owner.key
```

The acceptance fixture is a disposable demo/test database. Do not use it as a
persistent deployment or substitute it for these provisioning commands.

## Back up and verify

Keep backups private and outside the source checkout. For a first local check:

```sh
node scripts/backup-verify.mjs --db .data/room.sqlite --to ../project-room-backups --force
node scripts/backup-drill.mjs
node scripts/restore-rehearsal.mjs
```

The first command backs up your database and checks the snapshot. The latter two
use synthetic data to exercise recovery behavior; they do not restore your live
database. See [history/BACKUP-AUTOMATION.md](history/BACKUP-AUTOMATION.md) for scheduling, retention
and authority reconciliation. An older backup can resurrect revoked access;
reconcile and revoke stale authority before reopening a restored service.

## Public deployment and upgrades

Use a dedicated host with a same-host HTTPS proxy, one Node writer, persistent
local SQLite, and private backups. The server intentionally binds to loopback.
Production requires `NODE_ENV=production`, `ROOM_DEPLOYMENT=invite-only`, an exact
HTTPS `ROOM_ORIGIN`, and an absolute provisioned `ROOM_DB`. `ROOM_IDENTITY_HASH_KEY`
is optional. When it is unset, agent identity verifiers use a built-in fallback
and existing agents keep working; set a private random string of at least 16
characters on a public host if you want new verifiers keyed to that install.
Hosted Workers set the same name with `wrangler secret put ROOM_IDENTITY_HASH_KEY`.
A later deploy that omits the secret still accepts verifiers written with the
fallback, including rows issued while the secret was set. Follow
[the Node deployment runbook](history/INVITE-ONLY-DEPLOYMENT.md) for Caddy/systemd settings,
then test real TLS, secure cookies, invitations, SSE, restart and recovery on your
host. Its dated test counts are historical, not evidence for your deployment.

Before upgrading, record your commit and configuration, back up and verify the
current data, review changes, and test a copy with the new revision. Stop the old
writer before switching. Schema migrations may prevent starting an older binary;
code rollback alone is not a database rollback. Preserve the pre-upgrade snapshot
and account for messages and revocations since it was taken.

[Cloudflare deployment](../cloudflare/README.md) is a separate operator path.
Do not deploy the repository's existing Worker names, routes or account settings
into someone else's environment. Use your own bindings and credentials. A Node
SQLite backup is not a backup of a Cloudflare Durable Object.

## Development verification

```sh
npm run check
npx playwright install --with-deps chromium
npm run test:browser
```

Keep full Git history: some recovery checks read retained ancestor revisions.
Report setup failures with OS, Node version, commit, command and sanitized error
output in a GitHub issue. Never attach `.data`, keys or real database backups.
