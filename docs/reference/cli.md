---
title: CLI reference
parent: Reference
nav_order: 3
---

# CLI reference

Use `mama` from `@jungjaehoon/mama-os` to configure and run the owner agent. Start with
[owner setup](../start/owner-setup.md). Running `mama` without a command prints the supported syntax.

| Command                                                | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mama init --section <part>`                           | Asks one part of an existing setup again and saves it, while MAMA is stopped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `mama init --section connectors --non-interactive`     | Enables sources from `MAMA_INIT_CONNECTORS` without a terminal, while MAMA is stopped; their tokens go on the setup page.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `mama init --non-interactive`                          | Sets up a new installation from `MAMA_INIT_*` variables and a setup page in the browser, then starts it. The install command runs it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `mama secret set <NAME>`                               | Prompts with echo disabled and atomically updates one supported secret in `~/.mama/auth.env`. Restart the daemon afterward.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `mama secret list`                                     | Prints configured secret names only. It does not print values.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `mama register-owner <telegram id>`                    | Registers one active member with the owner role, leaving the common principal without a Telegram identity. Refused while the daemon or another command holds the install; prints counts only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `mama tools install`                                   | Installs or updates the document toolkit under `tools_root` for every session, and adds `tools_root` to `config.yaml` when it is missing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `mama daemon`                                          | Runs the daemon in the foreground until stopped. It expects the credentials in its environment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `mama replay`                                          | Runs the historical replay using the configured database and prepared import manifest, then stops. Refused while the daemon or another command holds the install.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `mama backfill <file>`                                 | Checks a backfill file and writes the period it describes through the owner's actions, then stops. Refused while the daemon or another command holds the install.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `mama status [--json]`                                 | Asks the running daemon for its version, boot stage, running turns, waiting inputs, whether a drain holds new work, connectors and last error. Exits 0 when running and 3 when stopped; names the command that holds the install when it is not the daemon.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `mama stop [--now]`                                    | Drains the daemon, then stops it. The drain claims nothing new (messages, deltas and reports that arrive wait for the next start; host commands such as `/stop` still answer) and waits until the turns running and the inputs already claimed finish and their replies are delivered, printing what it waits for. It gives up after one `agent.max_turn_ms` for each turn that may still run plus a minute, or when the daemon stops answering, changes nothing and exits 1. The drain is held through the stop: it unloads the LaunchAgent that runs the daemon, otherwise asks it through its control socket, and waits up to two minutes until the install is released. A replay, backfill or `register-owner` is left to finish. `--now` skips the drain: a running turn is interrupted, and at the next start MAMA delivers its stored result or tells its sender that it was interrupted.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `mama service install [--enable-linger]`               | Writes `~/.mama/start.sh` and the service file from the current templates: a LaunchAgent on macOS, a systemd user unit on Linux, both restarting only after a failure. A replaced `start.sh` is kept under `~/.mama/runtime/`; the viewer's access settings carry over and other exports are named. `--enable-linger` keeps a Linux service running after logout.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `mama service start\|stop\|restart\|status\|uninstall` | Starts, stops or restarts the service, shows `mama status`, or removes the service file (start.sh and the data stay). Stop, restart and, on macOS, uninstall drain first, as `mama stop` does.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `mama doctor [--json] [--offline] [--report]`          | Checks the install as its service would run it, without changing it: config and `connectors.json`, `member_root`, the Node and backend that `start.sh` runs (version and sign-in with the daemon's environment), the shell sandbox, the database's schema against this version, the secrets each enabled messenger and source needs and each source started as boot starts it, the Telegram bot's place in the common group, the toolkit, the daemon or its port, the service manager and log sizes. Each problem comes with what to do; exits 1 when a check fails. `--offline` makes no network call and starts no source; `--report` prints a summary for a bug report that holds no paths, values, ids or message text.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `mama logs [-n <lines>] [--follow]`                    | Prints the last lines of the daemon's log (`logging.file`, `~/.mama/logs/daemon.log` by default; 50 unless `-n` says), then with `--follow` each line as it is written, also across a rotation. The daemon rotates that log at 10 MB and `security-events.jsonl` at 5 MB, keeping five compressed archives of each (`.1.gz` is the newest); the file itself is emptied in place, never replaced.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `mama backup [--include-secrets] [--logs] [--restart]` | Writes one archive of a stopped install to `~/.mama/backups/` (0600, the one folder the agents cannot read): the database (copied with SQLite's backup and checked), the MAMA home's state, the workspace, every person's folder under `member_root`, the published common skills, the wiki MAMA writes and Jev's vocabulary, with a manifest of every entry's mode, link target and SHA-256 that the archive is read back against. Credentials (auth.env, the Codex login, the Jev key, an MCP configuration with servers besides MAMA's, and any config file that holds a token) only with `--include-secrets`; logs only with `--logs`; Codex sessions never (they start over). Refused while the daemon or another command holds the install. `--restart` drains and stops a running install first and starts it again through its service afterwards, also when the backup fails.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `mama uninstall [--dry-run] [--data [--toolkit]]`      | Stops MAMA (whatever holds the install) and removes its service; the data stays. With `--data`, after you type the MAMA home's path back on a terminal, it also removes the MAMA home (config, credentials, workspace, logs, backups and, by default, the database), the folder and temporary files of each person MAMA registered under `member_root` and the folders it retired, and the common skills under `tools_root`; `--toolkit` also removes the toolkit's versions (LibreOffice and the fonts stay: Homebrew installed them, and the command names the `brew uninstall --cask` that removes them). `member_root` and `tools_root` themselves go only once nothing else is in them. Paths your config sets outside the MAMA home (a database, a log, a Codex home, the Jev key) are listed as staying, not removed. `--dry-run` lists all of it, with sizes, and changes nothing. If whatever holds the install cannot be stopped, nothing changes. On an install the install command made, `--data` also removes its program (Node.js, MAMA OS and the `mama` command), last; without `--data` that program stays and is named. Both name the startup files that hold the install command's PATH block, for you to remove. For an npm install, `npm uninstall -g @jungjaehoon/mama-os` removes the program. |
| `mama restore <archive>`                               | Puts a `mama backup` archive onto this stopped install. The restored `config.yaml` is the backup's settings with this install's paths, and every part goes where that config puts it; stored attachment paths move to this install's roots. Every destination goes aside while its copy takes its place; if any step fails, all of them are put back. This install's credentials and `start.sh` stay when the archive has none.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `mama restore --rollback`                              | Puts back an install whose restore was interrupted, from the journal under `~/.mama/backups/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `mama update [<version>] [--dry-run]`                  | Updates an npm install to the registry's latest release, or to `<version>`: it installs the new version beside the old one first (a failure changes nothing), drains and stops, takes a backup with credentials, swaps the two, and starts the new version with new work held until it runs. If any step fails, the old version is put back and started. `--dry-run` shows the plan. A checkout prints its git steps instead.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `mama update --rollback`                               | Resolves an update that was interrupted, from its journal in `~/.mama/runtime/`; `mama doctor` prints the full command.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## Create an installation

The person's agent creates an installation with the install command, as
[owner setup](../start/owner-setup.md) describes:

```sh
curl -fsSL https://github.com/jungjaehoon-lifegamez/MAMA/releases/latest/download/install.sh | MAMA_INIT_MODEL=<model> sh -s -- --backend <claude|codex> --non-interactive
```

It reads no terminal. It installs Node.js, MAMA OS and the `mama` command under `~/.mama`, and the
backend with its vendor's installer when none that runs is found. Then it runs
`mama init --non-interactive`. A new install needs `--backend`, and either `--non-interactive` or
`--no-init`, which installs only and prints the init command. On an install that is set up it
needs no options. With your own Node.js, `npm install -g @jungjaehoon/mama-os` installs the program,
and `mama init --non-interactive` is run directly.

`mama init --non-interactive` reads its answers from the environment. No secret and no Telegram ID
is among them. A missing required variable is named.

| Variable                                                               | Value                                                                                    |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `MAMA_INIT_BACKEND`                                                    | `claude` or `codex`, required; the install command sets it from `--backend`              |
| `MAMA_INIT_MODEL`                                                      | The model, required                                                                      |
| `MAMA_INIT_TIMEZONE`                                                   | Time zone, optional; this machine's otherwise                                            |
| `MAMA_INIT_MEMBER_ROOT`, `MAMA_INIT_TOOLS_ROOT`                        | Member workspace and document tool folders outside HOME, optional; defaults otherwise    |
| `MAMA_CF_ACCESS_ISSUER`, `MAMA_CF_ACCESS_AUD`, `MAMA_VIEWER_HOSTNAMES` | The viewer behind a Cloudflare Access tunnel, optional; all three together, one hostname |
| `MAMA_VIEWER_OWNER_EMAILS`                                             | Owner emails for access monitoring, optional, with the tunnel                            |

Before writing anything it checks three things:

- the backend is installed, at least the verified version, and signed in. Otherwise it stops and
  names the login, with the backend's full path;
- the folders stay outside HOME and the MAMA home;
- on the setup page, Telegram accepts the bot token.

The setup page opens in the browser on this machine once every other answer is checked. It listens
on `127.0.0.1` at a random path that is never printed: init writes it into `open.html` (0600, in a
0700 temporary folder) and opens that file with `open` or `xdg-open`, or prints the file's path. The
page takes the bot token, checked with Telegram, then the pairing code the bot sends when you
message it privately (this names you as the owner). After one token and one code it closes;
unused, it closes after 15 minutes and nothing is written. Last, `/bind`, sent by you in the
Telegram common group or supergroup after the bot is added as an administrator, names the common
channel. A solo owner creates a group with the bot for common changes; a private chat cannot reach
the common session. Enter tokens only on the setup page.

It then writes `config.yaml`, `connectors.json`, `auth.env` (with a generated viewer token) and the
workspace beneath `~/.mama/`, and continues in this order:

1. registers you as the first owner;
2. installs the document toolkit;
3. installs and starts the service through `mama service`;
4. waits until the daemon reports it is running and the viewer answers `/health`;
5. asks the daemon for one real backend turn (`probe` on the control socket), run on the common
   session's turn chain in a session of its own that is reset afterwards, so the backend is proven
   with the service's PATH, environment, sandbox and model. The service step is done only when it
   answers, so the install command checks again after a fix.

Each finished step is recorded in `~/.mama/runtime/init-state.json`. A failed run continues from
its last step when the install command runs again. A finished setup says so and exits 0. An
existing `config.yaml` without that record, or a daemon holding the install, is refused.

`mama init --section <part>` asks one part of an existing setup again and saves it: `telegram`
(a bot token; the bot must already be in the common group), `model` (backend and model, checked in
the Codex home the daemon uses), `timezone`, `connectors` (the sources named are set up again, the
others kept), `discord` or `slack` (the block's other settings, such as `file_delivery`, stay) or
`jev`. It takes the install lock, so MAMA must be stopped (`mama stop`); run `mama doctor` before
starting it again. The answers get init's
checks, and the new `config.yaml` (with its delivery routes) and `connectors.json` must pass the
checks MAMA runs at boot; nothing is written until they do. Tokens go to `auth.env` only. A
`config.yaml` written by hand is written again in plain YAML and loses its comments.

Each part asks at a terminal, except `mama init --section connectors --non-interactive`, which the
person's agent runs. It reads `MAMA_INIT_CONNECTORS`, a JSON object of `connectors.json` blocks
keyed by source name, and takes the sources' tokens on the setup page. It refuses a source whose
tool MAMA's service cannot find, or whose sign-in does not read, and saves nothing then. Every
refusal says that MAMA is still stopped. See [sources](../guides/connectors.md). `secret set`
rejects non-terminal input.

Allowed secret names are `MAMA_TELEGRAM_TOKEN`, `MAMA_TELEGRAM_SOURCE_TOKEN`, `MAMA_SLACK_TOKEN`,
`MAMA_SLACK_APP_TOKEN`, `MAMA_CHATWORK_TOKEN`, `MAMA_DISCORD_TOKEN`, `MAMA_NOTION_TOKEN`,
`MAMA_TRELLO_KEY`, `MAMA_TRELLO_TOKEN`, `MAMA_AUTH_TOKEN`, and `MAMA_ICAL_URL_<NAME>`.

## Install the document toolkit

`mama tools install` builds a new toolkit version under `tools_root` and switches to it only after
its checks pass; the previous version is kept. The toolkit holds a Python environment with
python-pptx, python-docx, openpyxl, xlsxwriter, PyMuPDF, pdfplumber, reportlab, Pillow, numpy, pandas and
matplotlib, plus LibreOffice and Noto CJK fonts. A release that changes the package list takes effect
only after `mama tools install` runs again; until then sessions keep the previous version. `tools_root` defaults to a folder of yours outside HOME (`Shared/mama-<you>/tools` in the Shared folder beside the home folders on macOS,
`/var/lib/mama/<you>/tools` on Linux); set it elsewhere in `config.yaml` if needed. Setup runs the install before it starts the service. The first
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
Setup installs and starts the service for you. A direct
`mama daemon` invocation does not load `auth.env` for you.

`mama service install` writes the LaunchAgent or systemd user unit; both restart the daemon only
after a failure, so `mama stop` leaves it stopped and `mama service start` starts it again.

One process holds an install at a time: the daemon, a replay or backfill, or `register-owner`.
It takes an exclusive lock on `~/.mama/runtime/daemon.lock` before it opens the database, so a
second one is refused before it changes anything; the operating system releases the lock when the
process ends, so a crash or a reboot leaves nothing to clean up. The daemon answers `mama status`,
`mama stop` and its drain through `~/.mama/daemon.sock` with a token it writes under
`~/.mama/runtime/` at each start.

`mama status` shows what the daemon reports; check an owner Telegram reply and the
[viewer](../guides/viewer.md) to verify useful operation.

When the daemon does not start, it prints the boot stage that failed; the error is in the line
before it (`mama logs`). The daemon writes its own output to the rotated `~/.mama/logs/daemon.log`
once it has read its config, also when you run `mama daemon` by hand (follow it with
`mama logs --follow`). What comes before that, or bypasses it (a config that does not load, a
crash while Node loads, Node's report of a fatal error), goes to `~/.mama/logs/crash.log` under the
service; `start.sh` empties it at start once it is past 1 MB. `mama doctor` checks what the service
would run with: the Node path in `start.sh` (a path inside one Node version, such as a Homebrew
Cellar or nvm folder, disappears on an upgrade; `init` and `service install` write Homebrew's
stable `opt` link instead, and doctor checks that Node can load MAMA's SQLite module after a major
upgrade), the backend found on that script's `PATH`, and the rest of the install. Attach
`mama doctor --report` to a bug report rather than the log.

## Back up and restore

`mama backup` reads the install while holding it, so stop the daemon first (`mama stop`) and start
it again afterwards (`mama service start`), or let `mama backup --restart` do both. It names what it
left out: credentials unless `--include-secrets`, logs unless `--logs`, Codex homes and their
sessions (sessions start over after a restore), and any top-level entry in `~/.mama` that this
version does not read. The archive stays in `~/.mama/backups/`, which no agent can read; copying it
elsewhere is up to you, and a copy with credentials is as sensitive as `auth.env`.

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

Restore only archives you made: an archive's config and database decide who the owner is and
what the agents may do, so restoring one from elsewhere hands that over, whatever the path rules
refuse. A restore refuses a backup that holds a person's export or erasure in progress, since its paths
and file snapshots cannot move. Restoring an older backup brings back whatever was erased after it
was taken. If a restore is interrupted, the daemon and `mama doctor` refuse until
`mama restore --rollback` puts the install back (or finishes clearing a restore that had already
taken effect).

## Update

`mama update` serves an npm install: one the install command made (MAMA OS in `~/.mama/npm`, run
by its own Node.js), or `npm install -g @jungjaehoon/mama-os`. Run it with the `mama` the service
runs. Its `start.sh` must be one `mama service install` wrote with this version or
later (it stops any start while an update is under way); `mama update` says so otherwise. It asks the registry npm uses, then shows the plan; `--dry-run` stops there. It
installs the new version next to the old one, so a failed download changes nothing. Then it lets
running turns finish (new messages wait), stops the service, takes a backup with credentials in
`~/.mama/backups/`, and swaps the new version in. The new version writes `start.sh` and the service
file, checks the install, and starts with new work held; once it runs and its viewer answers, the
held work runs and the backup and the old version are removed.

If a step fails, the old version is put back with its own `start.sh` and service file and started
again. The database is restored from the backup only when the new version changed its schema;
the report then says how many inputs (messages, source changes, reports) that arrived after the
backup were dropped. A version older than the one running is refused. If the update itself is
killed, the install stays stopped and `mama doctor` prints the `mama update --rollback` command
that resolves it.

`mama update` does not change Node.js. On an install the install command made, when the new
release pins another Node.js, its report ends by saying to run the install command again, and
`mama doctor` warns the same. That run moves MAMA to the new Node with
`mama update --node <folder>`: it lets running turns finish, stops MAMA, swaps the Node in and checks that MAMA starts
on it, or puts the old Node back. A move that was cut off is finished or undone by the next run of
the install command.

A checkout updates by git: `mama update` prints the steps (stop, `git pull`, `pnpm install`,
`pnpm build`, `service install`, `service start`).

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
