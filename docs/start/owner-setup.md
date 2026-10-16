---
title: Set up the owner agent
parent: Start
nav_order: 4
---

# Set up the owner agent

MAMA OS keeps work history, answers the owner on Telegram, and publishes a board and
reports. For coding-session decisions and checkpoints, use the separate
[Claude Code plugin](claude-code-plugin.md).

## Install and sign in

Use Node.js 22.13 or newer and an authenticated Claude or Codex CLI on the machine
that will run MAMA:

```bash
node --version
npm install -g @jungjaehoon/mama-os
```

This installs the `mama` command. To work from a checkout instead, run `pnpm install`
and `pnpm build` at the repository root and use
`node packages/standalone/dist/cli/index.js` wherever the guides say `mama`.

Sign in to the backend before setup; `mama init` checks it. For Claude, run `claude auth login`.
For Codex, sign in to the home MAMA gives it, not the usual one:

```bash
CODEX_HOME="$HOME/.mama/.codex" codex login
```

See [Backends](../guides/backends.md).

## Run onboarding in your terminal

Create a Telegram bot through BotFather and a group with the bot for common changes, even if you
are the only owner. Use a bot only this install uses: Telegram hands a bot's messages to one
program at a time, so a bot another MAMA already reads cannot be paired. Then run:

```bash
mama init
```

It asks for:

- the backend and model;
- the Telegram bot token;
- two folders outside your home, one for member workspaces and one for the document tools;
- any sources and other messengers you want;
- last, the pairing code the bot sends when you message it privately, which makes you the first
  owner, and `/bind`, sent by you in the common group after you add the bot there as an
  administrator.

Tokens are entered with terminal echo off; do not send them to the agent.

Pairing comes last, after your answers and folders are checked, so a refused answer does not make
you pair again. Messages the bot held from before are dropped, so send it a new one. Everyone who messages the bot privately while setup waits gets a code, but
only the code typed at your terminal counts, and only that person's `/bind` names the group. A
`/bind` sent as an anonymous administrator cannot count; setup says so. If no `/bind` arrives
within 15 minutes, setup stops without writing anything; run `mama init` again.

Before writing anything, `mama init` checks three things:

- the backend is installed, is at least the version MAMA was verified on, and is signed in;
- Telegram accepts the token;
- the folders are outside your home and the MAMA home.

If a check fails, setup stops and says what to do, and nothing has been written.

The folders have defaults, so press Enter to keep them:

| Platform | Member workspaces                                                   | Document tools              |
| -------- | ------------------------------------------------------------------- | --------------------------- |
| macOS    | `Shared/mama-<you>/members` (the Shared folder beside home folders) | `Shared/mama-<you>/tools`   |
| Linux    | `/var/lib/mama/<you>/members`                                       | `/var/lib/mama/<you>/tools` |

Setup makes them as soon as you name them, and refuses one that another account owns or can
write. On Linux they must exist first. The installer creates them once with `sudo`.

Setup then asks whether to use Jev (TypeSafe). With it, the agent can ask Jev typed questions
inside its scripts (the `judge` action) to narrow many messages or items without reading them all.
Owner text in those calls goes to the Jev service, so it is off unless you choose it. Choosing it
asks for a Jev API key, stored in `~/.mama/jev-key` (0600), and sets `jev.enabled: true` in
`config.yaml`; `mama init --section jev` turns it off. MAMA works the same without it.

The optional tunnel prompts collect the Cloudflare Access issuer, audience and
viewer hostname. Configure that Access application and tunnel separately; see
[Viewer](../guides/viewer.md).

After the questions, `mama init` takes these steps in order:

1. writes the setup;
2. registers you as the first owner;
3. installs the document tools;
4. installs and starts the service (a LaunchAgent on macOS, a systemd user unit kept running
   after logout on Linux);
5. waits until MAMA reports it is running;
6. asks MAMA for one real turn of the backend, run as the service runs it. If it does not answer,
   setup says so and points to `mama logs` and `mama doctor`.

If a step fails, run `mama init` again: it continues from that step without asking again.
Once setup is complete it does not run again. It also refuses to start while a MAMA daemon holds
the install.

To set up without a terminal (a script on the machine that will run MAMA), run
`mama init --non-interactive` with
these variables. Secrets come only from variables, never from flags:

| Variable                      | Value                                                      |
| ----------------------------- | ---------------------------------------------------------- |
| `MAMA_INIT_BACKEND`           | `claude` or `codex`                                        |
| `MAMA_INIT_MODEL`             | The model                                                  |
| `MAMA_TELEGRAM_TOKEN`         | The bot token                                              |
| `MAMA_INIT_COMMON_CHAT_ID`    | The common group's ID                                      |
| `MAMA_INIT_OWNER_TELEGRAM_ID` | Your Telegram user ID                                      |
| `MAMA_INIT_MEMBER_ROOT`       | Member workspaces folder (optional; the default otherwise) |
| `MAMA_INIT_TOOLS_ROOT`        | Document tools folder (optional; the default otherwise)    |
| `MAMA_INIT_TIMEZONE`          | Time zone (optional; the machine's otherwise)              |

Setup writes these files under `~/.mama/`:

| File              | Purpose                                                      |
| ----------------- | ------------------------------------------------------------ |
| `config.yaml`     | Backend, database, common Telegram channel, folders and wiki |
| `connectors.json` | Source channels, roles and credential variable names         |
| `auth.env`        | Tokens, mode 0600; includes a generated viewer bearer token  |
| `start.sh`        | Written by the service step: loads credentials, starts MAMA  |
| `jev-key`         | Jev API key, mode 0600; only when you chose Jev              |
| `workspace/`      | Agent files and the default `wiki/` directory                |
| `logs/`           | Daemon and security logs                                     |

The OS database defaults to `~/.mama/memory.db`. Development memory uses
`~/.claude/mama-memory.db`; keep the two data homes separate.

Each owner gets a personal member session; the common group keeps the common session. Private
chats cannot serve as the common channel: they always enter that person's intake. To add more
owners or members later, see [People and their DMs](../guides/people.md).

## Change one part later

`mama init --section <part>` asks one part of the setup again and saves it:

| Part               | What it asks                                                              |
| ------------------ | ------------------------------------------------------------------------- |
| `telegram`         | A new bot token; the bot must already be in the common group              |
| `model`            | The backend and model, checked as setup checks them                       |
| `timezone`         | Your time zone                                                            |
| `connectors`       | Sources to set up; those you name are set up again, the others stay as is |
| `discord`, `slack` | Owner messages on Discord or Slack, on or off; other settings stay        |
| `jev`              | Jev on or off; its key file stays when you turn it off                    |

Stop MAMA first with `mama stop`. Afterwards, `mama doctor` checks the install as MAMA will start
it (for example, that the service finds a backend you switched to), then `mama service start`
starts it. Answers are
checked before anything is saved, as MAMA checks its settings when it starts, so a change that
leaves a delivery route on a messenger you turned off is refused. Tokens go only to `auth.env`.
The folders cannot be changed this way, since member data lives in them. A `config.yaml` written
by hand is written again in plain YAML without its comments, and the command says so.

## The running service

`mama status` shows the daemon's boot stage, running turns, connectors and last error.
`mama stop` stops it and it stays stopped; after a failure the service manager restarts it.
`mama service restart` restarts it after a change. Only one daemon runs per install: a second
one is refused.

## Confirm the first useful answer

Send the bot a question about a known piece of work, with an original message or
file if needed. Confirm that the reply reaches Telegram, refers to the right work,
and distinguishes missing information from confirmed facts. Ask what evidence it
used and compare its answer with the original. Open
[the viewer](../guides/viewer.md) to inspect the task and board.

Fresh-machine onboarding through backend login and an actual Telegram reply has
not yet been verified end to end. A running process or healthy HTTP response does
not establish that login, source collection or Telegram delivery works. Add a [connector](../guides/connectors.md)
and check an actual source-backed answer before relying on reports.

To rotate a token, run `mama secret set MAMA_TELEGRAM_TOKEN` (or another supported
secret name) in your terminal, then restart the daemon. `mama secret list` prints
names only. For launchd restart/stop and setup errors, see
[Troubleshooting](../guides/troubleshooting.md).
