# MAMA OS

A common session, a DM session per registered person and a group session per member, on Claude or
Codex, watch connected work, keep task revisions and evidence, answer in Telegram (each person's DM
and the common group), Discord or Slack, publish reports and a board, and recall corrections.
[mama-core](../mama-core/README.md) supplies the shared engine.

Current manifest: **0.78.0**. Install with `npm install -g @jungjaehoon/mama-os` (Node.js 22.13+)
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
| `mama register-owner <telegram id>`           | Register an owner before the daemon starts       |
| `mama tools install`                          | Install or update the document toolkit           |
| `mama secret set <NAME>` / `mama secret list` | Rotate a token / list names only                 |
| `mama daemon`                                 | Run the configured daemon in the foreground      |
| `mama backfill <file>`                        | Write a prepared past-period backfill file       |
| `mama replay`                                 | Replay prepared historical inputs in day windows |
| `mama status` / `mama stop`                   | Report running/stopped / stop the process        |

See [CLI flags](../../docs/reference/cli.md) and
[launchd management](../../docs/guides/troubleshooting.md).

## Current surface

- **Messengers:** in Telegram, a DM per registered person and the common group; Discord and
  Slack keep one owner channel ([messengers](../../docs/guides/messengers.md)).
- **People:** each person's DM session has its own records, scheduled jobs, notices and skills;
  an owner's DM also reads the common records. Members without the owner role work in the group
  in a session of their own ([people and DMs](../../docs/guides/people.md)).
- **Sources:** Chatwork, Slack, Discord, Telegram groups, Trello, Notion, Google Calendar, Gmail,
  Drive and Sheets through `gws`, iCal feeds, Obsidian, iMessage, Claude Code and a read-only
  Kagemusha bridge ([sources](../../docs/guides/connectors.md)).
- **Records:** tasks and revision history, a four-slot board, wiki pages, daily journals,
  lessons, preferences, constraints, workflows and skills.
- **Documents:** a managed toolkit (`mama tools install`) with python-pptx, python-docx, openpyxl,
  PyMuPDF, numpy, pandas, matplotlib, LibreOffice and Noto CJK fonts; on macOS `document.render`
  turns a workspace file into a PDF and page images.
- **Web:** for owners, turns where a person speaks search the web and, on Claude, open pages;
  turns with no person in them search the web but open pages only from the hosts in
  `agent.autonomous_web_fetch`. Members without the owner role have no web tools.
- **Reports:** live deltas, full reports at 08/13/18 and hourly reminders at 09–21, in the
  configured time zone.
- **Viewer:** board, work, memory graph, wiki, logs and security events; read-only data routes.
- **Files:** source attachment lookup/download, native workspace processing,
  `deliver.<messenger>.file` to the caller's chat and `deliver.drive.file` for files over the
  messengers' limit; an owner's DM fetches Drive files with `drive.download`.

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
[the work plan](../../docs/development/plan.md) and results in
[checks.md](../../docs/development/checks.md). Run `pnpm test` inside this package, with isolated
state as described in [testing](../../docs/development/testing.md).

[MIT](../../LICENSE).
