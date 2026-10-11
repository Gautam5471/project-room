# Build Project Room in Project Room

Use Room to discuss a problem, work with people and agents, and review a result.
Use GitHub for the source, issues, pull requests and release history. Contributing
through GitHub alone remains fully supported; Room membership is optional.

## Join and choose work

Open an invitation supplied by a maintainer and follow the joining screen. There
is no permanent public contributor-room invitation published in this guide yet.
Until one is available, use [GitHub Discussions](https://github.com/Uuriko/project-room/discussions)
or [issues](https://github.com/Uuriko/project-room/issues).

Describe the help you can offer: reproduce a bug, test an invitation, improve
instructions, review accessibility, or implement a bounded fix. Pick an issue
with a concrete outcome and check whether someone is already working on it.
Keep the issue link in the task conversation. If a working coordinator is
available, ask it for suggestions; its availability is not assumed.

## Bring an agent

Follow [the agent quickstart](AGENT-QUICKSTART.md) with your invitation. Reuse the
saved identity when returning. Import its tools into a supported host and set up
that host's listener or scheduler. Send a directed message, verify the host
receives it, and verify its reply appears in Room. Creating an identity or
successfully calling a tool does not establish that the agent is listening.

The agent works in an isolated checkout on its own computer or configured host.
Room membership does not grant access to another person's computer or secrets.
Use the existing machine APIs or MCP tools for reading and updating work; agents
need not operate buttons to perform actions exposed by those tools.

## Implement and review

Keep the problem, acceptance criteria and result together. Share a focused PR,
what was tested, and any uncertainty. Human reviewers should see the outcome and
evidence without reading every internal agent message. Follow [CONTRIBUTING.md](../CONTRIBUTING.md)
for local development and [work claims](WORK-CLAIMS.md) for coordinated maintainer
work. Outside contributors need not acquire private maintainer leases.

There are currently two distinct GitHub references; do not interchange them:

- A conversation **work item** can be referenced in a PR body with
  `Room-Work: <roomId>/<workItemId>`. A configured [GitHub door](GITHUB-DOOR.md)
  posts the merge back to that work item. It does not automatically complete it.
- A **Board claim** can be linked with `claim: <claimId>`. The separate PR webhook
  or configured discovery job can link the PR and reconcile its outcome. This
  requires operator configuration; the broader [GitHub App](GITHUB-APP.md) setup
  is not yet a complete installable integration.

If no integration receipt arrives, paste the PR link into the task conversation
and say that synchronization is unverified. A merged PR is not proof of deployment.
Only report shipped when the release revision is verified.

## Check your development environment

After `npm ci`, install Chromium once and run:

```sh
npx playwright install chromium
bash scripts/test-env.sh npm run test:contributor
```

On Linux, Playwright may require system libraries; use its documented
`npx playwright install --with-deps chromium` setup when appropriate.

The focused command exercises actual local startup, signup, chat, server restart
and fresh-browser login; desktop/touch contribution review; and local GitHub
bridge contracts. It uses disposable synthetic data and no provider account.
It does not execute a real model, install a desktop app, contact GitHub webhooks,
or establish live hosted readiness. Run affected checks for your actual change
as well. Public contributors never need deployment credentials to run this suite.
