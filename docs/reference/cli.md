---
title: CLI reference
parent: Reference
nav_order: 3
---

# CLI reference

Use `mama` from `@jungjaehoon/mama-os` to configure and run the owner agent. Start with
[owner setup](../start/owner-setup.md). Running `mama` without a command prints the supported syntax.

| Command                                                | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mama init`                                            | Prompts in a terminal and writes a new installation. No flags are supported.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `mama secret set <NAME>`                               | Prompts with echo disabled and atomically updates one supported secret in `~/.mama/auth.env`. Restart the daemon afterward.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `mama secret list`                                     | Prints configured secret names only. It does not print values.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `mama register-owner <telegram id>`                    | Registers one active member with the owner role, leaving the common principal without a Telegram identity. Refused while the daemon or another command holds the install; prints counts only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `mama tools install`                                   | Installs or updates the document toolkit under `tools_root` for every session, and adds `tools_root` to `config.yaml` when it is missing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `mama daemon`                                          | Runs the daemon in the foreground until stopped. It expects the credentials in its environment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `mama replay`                                          | Runs the historical replay using the configured database and prepared import manifest, then stops. Refused while the daemon or another command holds the install.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `mama backfill <file>`                                 | Checks a backfill file and writes the period it describes through the owner's actions, then stops. Refused while the daemon or another command holds the install.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `mama status [--json]`                                 | Asks the running daemon for its version, boot stage, running turns, waiting inputs, connectors and last error. Exits 0 when running and 3 when stopped; names the command that holds the install when it is not the daemon.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `mama stop`                                            | Stops the daemon: unloads the LaunchAgent that runs it, otherwise asks it through its control socket, and waits up to two minutes until the install is released. A replay, backfill or `register-owner` is left to finish. A running turn is interrupted; at the next start MAMA delivers its stored result or tells its sender that it was interrupted.                                                                                                                                                                                                                                                                                                                                                                                          |
| `mama service install [--enable-linger]`               | Writes `~/.mama/start.sh` and the service file from the current templates: a LaunchAgent on macOS, a systemd user unit on Linux, both restarting only after a failure. A replaced `start.sh` is kept under `~/.mama/runtime/`; the viewer's access settings carry over and other exports are named. `--enable-linger` keeps a Linux service running after logout.                                                                                                                                                                                                                                                                                                                                                                                 |
| `mama service start\|stop\|restart\|status\|uninstall` | Starts, stops or restarts the service, shows `mama status`, or removes the service file (start.sh and the data stay).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `mama doctor [--json] [--offline] [--report]`          | Checks the install as its service would run it, without changing it: config and `connectors.json`, `member_root`, the Node and backend that `start.sh` runs (version and sign-in with the daemon's environment), the shell sandbox, the secrets each enabled messenger and source needs and each source started as boot starts it, the Telegram bot's place in the common group, the toolkit, the daemon or its port, the service manager and log sizes. Each problem comes with what to do; exits 1 when a check fails. `--offline` makes no network call and starts no source; `--report` prints a summary for a bug report that holds no paths, values, ids or message text.                                                                   |
| `mama backup [--include-secrets] [--logs]`             | Writes one archive of a stopped install to `~/.mama/backups/` (0600, the one folder the agents cannot read): the database (copied with SQLite's backup and checked), the MAMA home's state, the workspace, every person's folder under `member_root`, the published common skills, the wiki MAMA writes and Jev's vocabulary, with a manifest of every entry's mode, link target and SHA-256 that the archive is read back against. Credentials (auth.env, the Codex login, the Jev key, an MCP configuration with servers besides MAMA's, and any config file that holds a token) only with `--include-secrets`; logs only with `--logs`; Codex sessions never (they start over). Refused while the daemon or another command holds the install. |
| `mama restore <archive>`                               | Puts a `mama backup` archive onto this stopped install. The restored `config.yaml` is the backup's settings with this install's paths, and every part goes where that config puts it; stored attachment paths move to this install's roots. Every destination goes aside while its copy takes its place; if any step fails, all of them are put back. This install's credentials and `start.sh` stay when the archive has none.                                                                                                                                                                                                                                                                                                                   |
| `mama restore --rollback`                              | Puts back an install whose restore was interrupted, from the journal under `~/.mama/backups/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

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

`mama service install` writes the LaunchAgent or systemd user unit; both restart the daemon only
after a failure, so `mama stop` leaves it stopped and `mama service start` starts it again.

One process holds an install at a time: the daemon, a replay or backfill, or `register-owner`.
It takes an exclusive lock on `~/.mama/runtime/daemon.lock` before it opens the database, so a
second one is refused before it changes anything; the operating system releases the lock when the
process ends, so a crash or a reboot leaves nothing to clean up. The daemon answers `mama status`
and `mama stop` through `~/.mama/daemon.sock` with a token it writes under `~/.mama/runtime/` at
each start.

`mama status` shows what the daemon reports; check an owner Telegram reply and the
[viewer](../guides/viewer.md) to verify useful operation.

When the daemon does not start, it prints the boot stage that failed; the error is in the line
before it (in `~/.mama/logs/daemon.log` under the service). `mama doctor` checks what the service
would run with: the Node path in `start.sh` (a path inside one Node version, such as a Homebrew
Cellar or nvm folder, disappears on an upgrade; `init` and `service install` write Homebrew's
stable `opt` link instead, and doctor checks that Node can load MAMA's SQLite module after a major
upgrade), the backend found on that script's `PATH`, and the rest of the install. Attach
`mama doctor --report` to a bug report rather than the log.

## Back up and restore

`mama backup` reads the install while holding it, so stop the daemon first (`mama stop`) and start
it again afterwards (`mama service start`). It names what it left out: credentials unless
`--include-secrets`, logs unless `--logs`, Codex homes and their sessions (sessions start over
after a restore), and any top-level entry in `~/.mama` that this version does not read. The
archive stays in `~/.mama/backups/`, which no agent can read; copying it elsewhere is up to you,
and a copy with credentials is as sensitive as `auth.env`.

`mama restore <archive>` needs an installed, stopped target. The restored `config.yaml` keeps
the backup's settings but takes every path (database, logs, `member_root`, `tools_root`, the
wiki, Jev's files, the Codex home and workspace) from this install's config, comments dropped;
the database, the workspace, every person's folder, the published skills and the wiki go there.
Attachment paths MAMA reads back (mailbox inputs and the connector event index) move to this
install's roots; recorded evidence, the raw stores (whose hashes cover them) and tool history keep
the paths they had. If the archive holds credentials they replace this install's; otherwise this
install's stay, and a target with none is told to set them. `start.sh` is never replaced: run
`mama service install` on a new machine. The owner's Codex threads start over. Then `mama doctor`,
and `mama service start`.

A restore refuses a backup that holds a person's export or erasure in progress, since its paths
and file snapshots cannot move. Restoring an older backup brings back whatever was erased after it
was taken. If a restore is interrupted, the daemon and `mama doctor` refuse until
`mama restore --rollback` puts the install back (or finishes clearing a restore that had already
taken effect).

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
