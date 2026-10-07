---
title: CLI reference
parent: Reference
nav_order: 3
---

# CLI reference

Use `mama` from `@jungjaehoon/mama-os` to configure and run the owner agent. Start with
[owner setup](../start/owner-setup.md). Running `mama` without a command prints the supported syntax.

| Command                  | What it does                                                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mama init`              | Prompts in a terminal and writes a new installation. No flags are supported.                                                                        |
| `mama secret set <NAME>` | Prompts with echo disabled and atomically updates one supported secret in `~/.mama/auth.env`. Restart the daemon afterward.                         |
| `mama secret list`       | Prints configured secret names only. It does not print values.                                                                                      |
| `mama register-owner`    | Registers the owner once as the principal that grants team members access, bound to every Telegram owner ID. Prints the result and row counts only. |
| `mama daemon`            | Runs the daemon in the foreground until stopped. It expects the credentials in its environment.                                                     |
| `mama replay`            | Runs the historical replay using the configured database and prepared import manifest, then stops.                                                  |
| `mama backfill <file>`   | Checks a backfill file and writes the period it describes through the owner's actions, then stops.                                                  |
| `mama status`            | Prints `running` or `stopped` from the PID record and process check.                                                                                |
| `mama stop`              | Sends SIGTERM to the recorded daemon PID.                                                                                                           |

## Create an installation

Run `mama init` yourself in a terminal. It asks for the backend (`claude` or `codex`), model,
Telegram owner chat and user IDs, and optional connectors and viewer access settings. Enter tokens
only at the hidden prompts. Both `init` and `secret set` reject non-terminal input.

`init` writes `config.yaml`, `connectors.json`, `auth.env`, `start.sh`, and the workspace beneath
`~/.mama/`. It generates a viewer token and can write the macOS launchd file
`~/Library/LaunchAgents/com.mama.server.plist`. It refuses to overwrite existing configuration,
connector, startup or selected launchd files. It prints login and start instructions; it does not
log into a backend, start the daemon or prove that Telegram works.

Allowed secret names are `MAMA_TELEGRAM_TOKEN`, `MAMA_SLACK_TOKEN`, `MAMA_CHATWORK_TOKEN`,
`MAMA_TRELLO_KEY`, `MAMA_TRELLO_TOKEN`, and `MAMA_AUTH_TOKEN`.

## Start and stop

The generated `~/.mama/start.sh` loads `auth.env`, sets the executable search path and runs the daemon.
Use the launchd command printed by `init` when you selected that installation method. A direct
`mama daemon` invocation does not load `auth.env` for you.

launchd uses KeepAlive. To keep its managed daemon stopped, unload the job:

```bash
launchctl bootout gui/$(id -u)/com.mama.server
```

`mama status` confirms process existence only. Check an owner Telegram reply and the
[viewer](../guides/viewer.md) to verify useful operation.

## Replay prepared history

`mama replay` has no CLI options. It reads `september-import-manifest.json` under `~/.mama/runtime/`,
with `september-replay-cursor.json` and `september-replay-ledger.jsonl` beside it. These are the
current filenames used by the implementation. Prepare the source archive and stop the live service
before following the [replay guide](../guides/replay.md).

## Backfill a past period

`mama backfill <file>` takes one `mama-backfill/1` file. It refuses an invalid file and lists every
problem, and it writes nothing until every cited source has been imported. Stop the live service
first. See the [backfill guide](../guides/backfill.md).

Sources: [CLI dispatch](../../packages/standalone/src/cli/index.ts),
[commands](../../packages/standalone/src/cli/commands),
[launch files](../../packages/standalone/src/cli/launch-files.ts).
