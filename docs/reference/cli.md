---
title: CLI reference
parent: Reference
nav_order: 3
---

# CLI reference

Use `mama` from `@jungjaehoon/mama-os` to configure and run the owner agent. Start with
[owner setup](../start/owner-setup.md). Running `mama` without a command prints the supported syntax.

| Command                             | What it does                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mama init`                         | Prompts in a terminal and writes a new installation. No flags are supported.                                                                                                                                                                                                                                                                             |
| `mama secret set <NAME>`            | Prompts with echo disabled and atomically updates one supported secret in `~/.mama/auth.env`. Restart the daemon afterward.                                                                                                                                                                                                                              |
| `mama secret list`                  | Prints configured secret names only. It does not print values.                                                                                                                                                                                                                                                                                           |
| `mama register-owner <telegram id>` | Registers one active member with the owner role, leaving the common principal without a Telegram identity. Refused while the daemon or another command holds the install; prints counts only.                                                                                                                                                            |
| `mama tools install`                | Installs or updates the document toolkit under `tools_root` for every session, and adds `tools_root` to `config.yaml` when it is missing.                                                                                                                                                                                                                |
| `mama daemon`                       | Runs the daemon in the foreground until stopped. It expects the credentials in its environment.                                                                                                                                                                                                                                                          |
| `mama replay`                       | Runs the historical replay using the configured database and prepared import manifest, then stops. Refused while the daemon runs.                                                                                                                                                                                                                        |
| `mama backfill <file>`              | Checks a backfill file and writes the period it describes through the owner's actions, then stops. Refused while the daemon runs.                                                                                                                                                                                                                        |
| `mama status [--json]`              | Asks the running daemon for its version, boot stage, running turns, waiting inputs, connectors and last error. Exits 0 when running and 3 when stopped; names the command that holds the install when it is not the daemon.                                                                                                                              |
| `mama stop`                         | Stops the daemon: unloads the LaunchAgent that runs it, otherwise asks it through its control socket, and waits up to two minutes until the install is released. A replay, backfill or `register-owner` is left to finish. A running turn is interrupted; at the next start MAMA delivers its stored result or tells its sender that it was interrupted. |

## Create an installation

Run `mama init` yourself in a terminal. It asks for the backend (`claude` or `codex`), model,
negative Telegram common group or supergroup chat ID, and optional connectors and viewer access
settings. A solo owner creates a group with the bot for common changes; a private chat cannot
reach the common session. Set `member_root` outside HOME, then register each owner with
`mama register-owner <telegram id>` while the daemon is stopped, before starting it. Enter tokens
only at the hidden prompts. Both `init` and `secret set` reject non-terminal input.

`init` writes `config.yaml`, `connectors.json`, `auth.env`, `start.sh`, and the workspace beneath
`~/.mama/`. It generates a viewer token and can write the macOS launchd file
`~/Library/LaunchAgents/com.mama.server.plist`. It refuses to overwrite existing configuration,
connector, startup or selected launchd files. It prints login and start instructions; it does not
log into a backend, start the daemon or prove that Telegram works.

Allowed secret names are `MAMA_TELEGRAM_TOKEN`, `MAMA_TELEGRAM_SOURCE_TOKEN`, `MAMA_SLACK_TOKEN`,
`MAMA_SLACK_APP_TOKEN`, `MAMA_CHATWORK_TOKEN`, `MAMA_DISCORD_TOKEN`, `MAMA_NOTION_TOKEN`,
`MAMA_TRELLO_KEY`, `MAMA_TRELLO_TOKEN`, `MAMA_AUTH_TOKEN`, and `MAMA_ICAL_URL_<NAME>`.

## Install the document toolkit

`mama tools install` builds a new toolkit version under `tools_root` and switches to it only after
its checks pass; the previous version is kept. The toolkit holds a Python environment with
python-pptx, python-docx, openpyxl, xlsxwriter, PyMuPDF, pdfplumber, reportlab, Pillow, numpy, pandas and
matplotlib, plus LibreOffice and Noto CJK fonts. A release that changes the package list takes effect
only after `mama tools install` runs again; until then sessions keep the previous version. On macOS `tools_root` defaults to the Shared folder beside the home folders; set it
elsewhere in `config.yaml` if needed, outside HOME. `mama init` runs the install last. The first
install adds `tools_root` to `config.yaml`; restart the daemon once after it. Later installs need no
restart. The daemon log says `document toolkit: present` at start. The page renderer
(`document.render`) runs only on macOS.

## Register owner people

Remove the retired `telegram.owner_user_ids` key before running the command. Pass each owner's
Telegram user ID explicitly; IDs are not inferred from `allowed_chats`. A pending, claimed or
uncertain DM input prevents cutover. The command moves that DM's chat to the person and binds
older unscoped common checkpoints to the first registered owner. Group chat stays common.
A rerun for the same person changes nothing.

## Start and stop

The generated `~/.mama/start.sh` loads `auth.env`, sets the executable search path and runs the daemon.
Use the launchd command printed by `init` when you selected that installation method. A direct
`mama daemon` invocation does not load `auth.env` for you.

launchd uses KeepAlive. To keep its managed daemon stopped, unload the job:

```bash
launchctl bootout gui/$(id -u)/com.mama.server
```

One process holds an install at a time: the daemon, a replay or backfill, or `register-owner`.
It takes `~/.mama/runtime/daemon.lock` before it opens the database, so a second one is refused
before it changes anything, and the daemon answers `mama status` and `mama stop` through
`~/.mama/daemon.sock` with a token it writes there at each start. A lock left by a crash or a
reboot is replaced at the next start: a holder counts only while its process, started before the
lock in the same machine boot, still runs.

`mama status` shows what the daemon reports; check an owner Telegram reply and the
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
