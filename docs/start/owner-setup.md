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

For Claude, run `claude auth login`. For Codex, authenticate the managed home:

```bash
CODEX_HOME="$HOME/.mama/.codex" codex login
```

Use your configured `agent.codex_home` if it differs. The owner runtime reads its
own Codex home, not the usual one; `mama init` prints this command with the right
path. See [Backends](../guides/backends.md).

## Run onboarding in your terminal

Create a Telegram bot through BotFather, start a private conversation with it, and
have your owner chat and user IDs ready. Then run:

```bash
node packages/standalone/dist/cli/index.js init
```

Enter the backend, model, Telegram bot token, owner chat and user IDs, and any
source connectors you want to enable. Tokens are entered with terminal echo off;
do not send them to the agent. `mama init` requires a terminal and refuses to
overwrite an existing `config.yaml`, `connectors.json`, `start.sh`, or a selected
existing launch agent.

Setup then asks whether to use Jev (TypeSafe). With it, the agent can ask Jev typed questions
inside its scripts (the `judge` action) to narrow many messages or items without reading them all.
Owner text in those calls goes to the Jev service, so it is off unless you choose it. Choosing it
asks for a Jev API key, stored in `~/.mama/jev-key` (0600), and sets `jev.enabled: true` in
`config.yaml`; remove that line to turn it off. MAMA works the same without it.

The optional tunnel prompts collect the Cloudflare Access issuer, audience and
viewer hostname. Configure that Access application and tunnel separately; see
[Viewer](../guides/viewer.md).

Setup writes these files under `~/.mama/`:

| File              | Purpose                                                        |
| ----------------- | -------------------------------------------------------------- |
| `config.yaml`     | Backend, database, Telegram owner identity and wiki settings   |
| `connectors.json` | Source channels, roles and credential variable names           |
| `auth.env`        | Tokens, mode 0600; includes a generated viewer bearer token    |
| `start.sh`        | Loads credentials, sets the executable PATH, starts the daemon |
| `jev-key`         | Jev API key, mode 0600; only when you chose Jev                |
| `workspace/`      | Agent files and the default `wiki/` directory                  |
| `logs/`           | Daemon and security logs                                       |

The OS database defaults to `~/.mama/memory.db`. Development memory uses
`~/.claude/mama-memory.db`; keep the two data homes separate.

## Start one daemon

On macOS, if you chose to write the launch agent, start it after backend login:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mama.server.plist
node packages/standalone/dist/cli/index.js status
curl -fsS http://127.0.0.1:3847/health
```

Otherwise run `~/.mama/start.sh` in a terminal. It runs the daemon in the foreground
and appends output to `~/.mama/logs/daemon.log`. Setup writes launch files; it does
not start or authenticate the service. Avoid starting a second daemon alongside
launchd. `mama status` reports only `running` or `stopped`.

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
