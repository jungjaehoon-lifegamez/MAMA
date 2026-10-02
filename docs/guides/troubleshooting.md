---
title: Troubleshoot the owner loop
parent: Guides
nav_order: 10
---

# Troubleshoot the owner loop

Start with a short, private diagnostic sample:

```bash
node --version
mama status
curl -fsS http://127.0.0.1:3847/health
mama secret list
tail -n 60 ~/.mama/logs/daemon.log
```

Node.js must be 22.13 or newer. `mama status` only checks the recorded process;
`/health` only checks the HTTP listener. Confirm a real owner reply and inspect the
related records before deciding that the loop works. Do not print `auth.env` or
share whole configuration files and logs. For development-memory setup, see the
[Claude Code plugin guide](../start/claude-code-plugin.md).

## Fix a configuration error

Edit only the setting named in the error. `config.yaml` uses `version: 1` and the
current `agent`, `database`, `logging`, `telegram`, `jev`, `wiki`, and `reports`
sections. Unsupported keys are logged as `ignored`; parsing an old setting
does not make that feature run. See [Configuration](../reference/configuration.md).

If startup says `run mama secret set MAMA_TELEGRAM_TOKEN and remove telegram.token`,
enter the token through that terminal command, remove the obsolete YAML key, and
restart through `start.sh`. The bare `mama daemon` command does not load
`auth.env` itself. `mama init` refuses existing setup files; it is not a reset tool.

## Restart or stop a launchd service

A launchd service with `KeepAlive` returns after `mama stop` or a killed process.
For a restart that reloads configuration and secrets:

```bash
launchctl bootout gui/$(id -u)/com.mama.server
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mama.server.plist
```

To leave it stopped, run only `bootout`, then confirm `mama status` is `stopped`.
For an unsupervised daemon, `mama stop` sends SIGTERM. Do not start a foreground
copy alongside launchd. If port 3847 is occupied, inspect its owner with
`lsof -nP -iTCP:3847 -sTCP:LISTEN` before stopping anything.

Check the executable paths in `~/.mama/start.sh` after moving a checkout or Node
installation. The generated script records the Node and CLI paths used at setup;
it does not automatically follow a different installation.

## The Telegram bot is silent

Confirm that `telegram.enabled` and `telegram.polling` are true, the owner chat is
allowlisted, and the sender is in `owner_user_ids`. Inspect recent logs for
`telegram polling stopped`, `telegram message dropped`, or a boot-stage failure.
A disabled poller cannot receive owner turns. A second poller using the same bot
can also prevent normal operation.

If the backend fails to authenticate, sign in on the daemon host with
`claude auth login`, or `CODEX_HOME="$HOME/.mama/.codex" codex login` for Codex,
then restart. Use the configured `agent.codex_home` if different; the owner runtime
does not copy a normal Codex login into that home. For the bot token, use
`mama secret set MAMA_TELEGRAM_TOKEN`; do not pass its value as a command argument.
See [Telegram](telegram.md) and [Backends](backends.md).

## A connector or report is stale

Read the viewer's Connectors page or `GET /api/connectors/status`. Check the last
poll, error and configured channel scope. Token-backed sources need the matching
`auth.tokenName` and secret; Trello needs both its key and token. Calendar requires
`gws` on the daemon PATH and actual primary-calendar read access. See
[Connectors](connectors.md).

For reports, check the schedule hours in your configured timezone, Telegram delivery, and whether an earlier
report is still pending. Compare task revisions with the board slot update time.
A source delta ending in `[ack]` produces no owner notification. See
[Reports and board](reports-and-board.md).

## Trace one missing answer or write

Follow the same stimulus through the mailbox, `model_runs`, `tool_traces`, the
Telegram message ledger or board slot writer, and the matching `daemon.log`
entries. Native parent and child tool traces carry their owning model run.
`stimulus accepted`, `stimulus delivered`, `stimulus failed`, `stimulus skipped`,
`delta report route=` and `record order recorded|waiting|retry|lost` distinguish stages. A stored task proves a write, not a sent
reply; inspect the delivery receipt and the owner-visible result separately.

A turn cut off midway (a timeout or a restart) is never run again, because its
effects cannot be proven safe to repeat. It is logged as `stimulus parked uncertain`.
The owner gets a notice for an interrupted message, and an interrupted source change
goes to the record check, unless it came in more than a day ago. Once its follow-up
has a place the input closes with `stimulus closed after uncertain ... follow_up=`.
To retry an interrupted request, send it again.

If delivery is uncertain, check its original operation before sending again. Keep
IDs in private diagnostics and provide a redacted error plus the reproduction
steps when reporting a defect.

## The viewer will not open

HTTP 421 means the Host is not allowed; check `MAMA_VIEWER_HOSTNAMES`. HTTP 401 on
remote data routes means there is no valid bearer credential or verified Access
assertion. A successful health route does not establish data access. See
[Viewer](viewer.md).

`Viewer assets are not installed` means the daemon could not find its viewer
files. Verify that the installation contains the built `public/viewer` assets;
source builds generate the viewer JavaScript. This is an installation failure,
not a Telegram credential problem.

## A database is locked or storage is full

Check available disk space and stop every process using the affected database
before maintenance. Never delete SQLite `-wal` or `-shm` files: committed writes
may still live in the WAL. SQLite handles checkpointing when connections close.
Keep the OS database under `~/.mama/` separate from the development-memory database
under `~/.claude/`; do not reset development memory as an OS troubleshooting step.

## Case merge chain cycle

The retained core case resolver can raise `case.merge_chain_cycle` when
`case_truth.canonical_case_id` links revisit a case or exceed the resolver's
maximum depth (64 by default). Use the error's chain and detected depth to inspect
those links. Repair the incorrect canonical link with evidence before retrying;
do not delete the database or unrelated history. This is a core diagnostic, not a
separate Case object in the current owner work ledger.
