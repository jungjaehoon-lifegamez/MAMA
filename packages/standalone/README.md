# MAMA OS

One owner agent on Claude or Codex watches connected work, keeps task revisions and evidence,
answers on Telegram, publishes reports and a board, and recalls corrections.
[mama-core](../mama-core/README.md) supplies the shared engine.

Current manifest: **0.77.0**. Install with `npm install -g @jungjaehoon/mama-os` (Node.js 22.13+)
and follow [owner setup](../../docs/start/owner-setup.md).

## Start and operate

```bash
npm install -g @jungjaehoon/mama-os
mama init
```

From a checkout, run `pnpm install` and `pnpm build`, then use
`node packages/standalone/dist/cli/index.js` in place of `mama`. Onboarding is terminal-only: the owner types tokens
with echo off. It writes configuration and optional launchd files; backend login and service
startup are separate steps.

For Telegram's common session, create a group with the bot, even for a solo owner, and enter
its negative group or supergroup ID in `mama init`. Private chats always enter personal sessions.
Before starting the daemon, set `member_root` outside HOME in `config.yaml` and run
`mama register-owner <telegram id>` for each owner's positive user ID.

| Command                                       | Purpose                                          |
| --------------------------------------------- | ------------------------------------------------ |
| `mama init`                                   | Set up the owner, backend and connectors         |
| `mama secret set <NAME>` / `mama secret list` | Rotate a token / list names only                 |
| `mama daemon`                                 | Run the configured daemon in the foreground      |
| `mama replay`                                 | Replay prepared historical inputs in day windows |
| `mama status` / `mama stop`                   | Report running/stopped / stop the process        |

See [CLI flags](../../docs/reference/cli.md) and
[launchd management](../../docs/guides/troubleshooting.md).

## Current surface

- **Owner chat:** Telegram, Discord or Slack, each with an allowed chat and owner sender
  ([messengers](../../docs/guides/messengers.md)).
- **Five source connectors:** Chatwork, Slack, Trello, Kagemusha (read-only local bridge),
  and Google Calendar through `gws`.
- **Records:** tasks and revision history, a four-slot board, wiki pages, daily journals,
  lessons, preferences and constraints.
- **Reports:** live deltas, full reports at 08/13/18 and hourly reminders at 09–21, in the
  configured time zone.
- **Viewer:** board, work, memory graph, wiki, logs and security events; read-only data routes.
- **Files:** source attachment lookup/download, native workspace processing,
  `deliver.<messenger>.file` to the owner's chat and `deliver.drive.file` for files over the
  messengers' limit.

Assembly lives in `src/runtime/` and `src/cli/commands/daemon.ts`; actions in `src/api/`,
collectors in `src/connectors/`, Telegram in `src/gateways/`, replay in `src/replay/`,
and viewer sources/assets in `ui/` and `public/viewer/`.

## Data, security and status

OS state lives in `~/.mama/`; its database defaults to `~/.mama/memory.db`.
`config.yaml` and `connectors.json` hold settings; terminal-entered credentials live in
`auth.env` (0600). Both backends have workspace-only writes and credential-read exclusions.
The viewer binds to `127.0.0.1:3847` by default; remote data access requires a bearer token
or verified Access JWT. See [security](../../docs/guides/security.md).

The [public MCP server](../mcp-server/README.md) and
[plugin](../claude-code-plugin/README.md) run independently with a separate development database.

[Owner loop](../../docs/explanation/owner-loop.md) · [Connectors](../../docs/guides/connectors.md) ·
[Backends](../../docs/guides/backends.md) · [Reports](../../docs/guides/reports-and-board.md) ·
[Replay](../../docs/guides/replay.md) · [Viewer](../../docs/guides/viewer.md).

Completion is measured by [INTENT.md](../../INTENT.md); open live checks are in
[checks.md](../../docs/development/checks.md). Run `pnpm test` inside this package, with isolated
state as described in [testing](../../docs/development/testing.md).

[MIT](../../LICENSE).
