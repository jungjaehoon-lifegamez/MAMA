---
title: Security guide
parent: Guides
nav_order: 8
---

# Security guide

MAMA runs one owner agent, stores its
work history, and serves the owner's tasks, memory, wiki, reports and logs. The
security boundary protects those records and connector credentials while keeping
the owner's existing tools available.

## Viewer access

The viewer binds to the loopback interface by default. `MAMA_API_HOST` can override
the bind address; keep the origin on loopback when using a Cloudflare tunnel.
A direct loopback request without tunnel headers uses the local dashboard without
a token. Local processes and other users able to reach that interface are inside
this trust boundary.

Every request must first pass a Host allowlist, including public routes. Loopback
names and addresses are accepted. Add the public viewer's host names through
`MAMA_VIEWER_HOSTNAMES`, a comma-separated environment variable containing host
names only. An unrecognised or malformed Host receives 421 before authentication.
The reason for this check is DNS rebinding: a remote page must not gain the local
no-token path by resolving its own name to the loopback interface. An allowed
Host is routing validation, not an authenticated identity.

For remote access, place the viewer behind Cloudflare Tunnel and an Access
application. Set `MAMA_CF_ACCESS_ISSUER` and `MAMA_CF_ACCESS_AUD` for that application
in the daemon environment. The origin verifies the Access assertion's RS256
signature against the issuer's signing keys, issuer, audience, time claims and
email claim. Signing keys are cached for ten minutes. Missing configuration,
invalid assertions and verification errors fail authentication. A forwarded email
or tunnel header alone never establishes identity.

`MAMA_AUTH_TOKEN` provides an alternative bearer credential for API clients.
Send it in the Authorization header; never put it in a URL or a recallable record.
It is compared with a timing-safe comparison. A valid token is independent of
Access authentication. Keep it only with trusted clients and in the daemon's
credential environment.

API routes require authentication for nonlocal or tunnel-shaped requests. The
health endpoint, static viewer assets and OPTIONS keep their existing public
route semantics, but still pass the Host check. Cloudflare Access policy decides
who can reach the tunnel. The origin verifies an assertion for the configured
application; it does not maintain a second email allowlist.

## Owner credential boundary

Run `mama init` in the owner's terminal for onboarding. It reads tokens with echo
off and writes them only to `~/.mama/auth.env` with mode 0600; `config.yaml` and
`connectors.json` carry settings and credential variable names. Rotate a token
with `mama secret set <NAME>`, also in a terminal, then restart the daemon.
`mama secret list` prints names only. The agent does not receive or type tokens.

The daemon reads the Telegram bot token from `MAMA_TELEGRAM_TOKEN`, loaded by
`~/.mama/start.sh` from `auth.env`. A `telegram.token` key in `config.yaml` is an
error; move it with `mama secret set MAMA_TELEGRAM_TOKEN` and remove that key.

The daemon's connectors retain the credentials needed to collect and deliver
work. Before starting either native agent backend, standalone removes
secret-shaped environment names. The shared core driver accepts that complete
consumer-supplied environment, and native children inherit the same boundary.
Noncredential runtime settings remain available.

The Claude owner runs inside the workspace with project/local settings, an empty
plugin directory and a Git boundary that prevents loading global instructions.
Read-deny rules and Bash sandbox denyRead paths exclude `auth.env`, `config.yaml`,
`runtime/` and the managed or configured Codex home. Writes stay inside the
workspace; Bash remains sandboxed without an unsandboxed retry. Native web tools
remain available. Subagents inherit these settings.

The Codex owner uses a named workspace permission profile with those credential
paths denied. Both thread start and resume select that profile. Workspace writes,
native shell and web search remain available under the existing policy; shell
network access is unchanged. Approval handling does not grant access to excluded
credentials.

These controls separate agent-readable work from connector authentication. They
do not promise that a credential deliberately placed in an otherwise readable
work file is invisible to the owner agent.

## External evidence and recallable writes

Model-facing results from source search/read, attachment list/download, wiki read
and report read are quoted as untrusted content. Source delta stimuli use the
same boundary. Stored originals and host receipts retain their structure.
Quoting makes external instructions visibly distinct from an owner instruction;
it is not a guarantee against all prompt injection.

The dispatcher scans recallable writes before executing them. The contract is
set on `memory.save`, `memory.update`, `work.create`, `work.revise`,
`manage.wiki.publish`, `manage.wiki.update` and `report.publish`. Secret-shaped
material is refused with `secret_material_refused`; errors name the pattern,
never the matched value. Nested content and evidence references are scanned.
Ordinary content hashes and version hashes remain valid. Instruction-shaped
phrases produce observations rather than a new owner capability restriction.

The scanner recognises specific credential shapes; it does not identify every
possible secret or retroactively remove older stored content. Do not use tasks,
memory, wiki pages or reports as a credential store.

## Observation and logs

Catalog calls and native owner/subagent tool calls are observed in `tool_traces`.
Native traces contain the tool name, a bounded input summary with secret-shaped
values masked, status, duration and the owning parent or child `model_run_id`.
Native outputs are not copied into these summaries. This is observation, not a
tool approval or blocking rule. Trace failures must not prevent native execution.
A trace records a provider-reported call; it is not a complete operating-system
audit of every subprocess or network packet.

Each tunnel-shaped viewer request produces one log line with method, path without
query, status, a bounded Cloudflare ray identifier, and a short hash of the
verified Access email or `token`. Requests without verified credentials carry an
unauthenticated marker. Failed API authentication is logged once. Ordinary direct
loopback requests are not logged. Tokens, assertions, query strings and raw email
addresses are not request-log fields.

Viewer clients receive a generic internal-error response; diagnostic detail stays
in the daemon log with sensitive values redacted. The daemon creates its log with
mode 0600 and tightens an existing log's permissions on startup. The log viewer
reads at most 256 KiB from the tail, with at most 2,000 returned lines. Native Claude stderr uses the same
configured-secret redaction mechanism as the Codex driver.

## Telegram and attachments

Telegram ingress requires an allowlisted chat and an accepted owner sender.
When explicit owner sender IDs are absent, the existing single-chat owner check
requires the sender to match that chat. Messages rejected by this check stay
rejected and now produce an observation containing hashes of the chat and sender
IDs, without message content or raw identifiers.

Shared connector attachment downloads are limited to 50 MiB. The downloader
checks declared lengths and counts streamed bytes, so missing or understated
Content-Length cannot bypass the cap. Oversize downloads fail clearly and remove
partial files. Telegram's existing narrower 20 MiB download cap remains in place;
the Bot API's 50 MB upload allowance does not enlarge its download allowance.
Slack file requests attach the bot credential only to an approved HTTPS file
origin and do not forward it through automatic redirects to another origin.
These checks protect disk/memory use and prevent credential disclosure.

## Outbound paths

What can leave the machine from an owner turn, checked on the Claude backend on
2026-10-03:

- The model provider receives everything the agent reads, as with any hosted model.
- Bash runs in the workspace sandbox with no allowed network hosts, so a shell command
  that opens a connection is refused at the sandbox proxy: a GET and a POST with an
  empty body both received 403. `allowUnsandboxedCommands` is off, so a refused
  command is not retried outside the sandbox.
- Native web fetch and web search stay available; the owner's work needs them. They
  run outside the shell sandbox, so a requested URL and a search query leave the
  machine. Web fetch reads a page and sends no body, but text placed in a URL travels
  with it.
- The agent writes outward only through owner actions: files to the configured owner
  messengers (`deliver.<messenger>.file`; a messenger that is not enabled refuses), and
  the board and wiki, which the viewer serves behind the access controls above. Drive,
  Trello, Chatwork and Slack are read only.
- Drive is read through the gws CLI and its own credential store (`drive.read`,
  `drive.download`); the daemon makes the calls and the agent receives the results.
- Every call is recorded in `tool_traces`, native Bash, web fetch and web search
  included, with a bounded input summary. An outbound attempt raises no owner alert
  yet, a refused one included; alerts for these attempts are work item W35.

The Codex backend keeps its own sandbox's network setting; it was not checked here.

## Limits of this threat model

- A compromised owner account or stolen bearer credential carries the owner's
  authority. These changes do not add a second approval gate to owner tools.
- Access policy membership, account security and application scope are the
  deployment owner's responsibility. Origin JWT verification does not correct an
  overly broad Access policy.
- A compromised operating system, privileged local process or daemon process can
  access data and credentials outside the agent boundary.
- Quoting and shape-based secret detection reduce specific exposure paths; they
  do not provide complete content sanitisation or guaranteed injection immunity.
- Hashed identifiers support correlation, not strong anonymity for guessable IDs.
  Protect the logs and database as private owner data.
