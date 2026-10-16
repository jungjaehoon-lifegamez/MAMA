# MAMA

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen)](https://nodejs.org)
[![Docs](https://img.shields.io/badge/docs-GitHub%20Pages-blue)](https://jungjaehoon-lifegamez.github.io/MAMA/)

[Documentation](https://jungjaehoon-lifegamez.github.io/MAMA/) ·
[Your first day](docs/start/tutorial.md) · [How it works](#how-it-works) ·
[What you can connect](#what-you-can-connect) · [Security](#security) · [Roadmap](#roadmap)

MAMA is a **work agent that runs on your own computer**. It follows the conversations, files and
schedules in the tools you connect, keeps them as they were, and keeps a history of each piece of
work: what changed, why, who did it and what the feedback was. You talk to it in your messenger.
It answers from that history, sends you reports, and remembers how you want things done.

The same repository also gives Claude Code a **development memory** (decisions and checkpoints
that survive a new session), and both are built on **mama-core**, a shared engine other products
can use.

MAMA runs no hosted service. The record stays on your machine. Only the content a run needs
leaves it, through the AI CLI you logged into and the services you connected.

## Why

An assistant is only as useful as what it remembers, and memory kept on someone else's server
disappears when the service changes. MAMA keeps the record of your work on your computer, in its
original form, so today's model and a better one tomorrow can read the same history. You decide
which sources to connect and what to hand over.

## Principles

In order of importance.

1. **Never lose the record.** Original text, time, source and every later change are kept, not
   overwritten.
2. **Know why it changed.** Each change to a piece of work names the message or file behind it.
3. **Act only where allowed.** MAMA sends only to the destinations you configured and to the DMs of
   people you registered, and its agent writes files only inside its own workspace.
4. **Remember corrections.** Say "reports should be short" or "translate feedback into the usual
   spreadsheet" once. MAMA keeps it as guidance or as a workflow and applies it from then on.
5. **Stay independent of the model vendor.** Claude or Codex runs the agent; the record's format
   does not depend on either.
6. **Everything else.** Speed and convenience improve only within the five above.

## What it looks like

> **You:** Who is working on what right now?
>
> **MAMA:** 12 items are in progress. Two need you today: the sample poster review is waiting for
> your decision on the color variant, and the launch checklist is overdue since yesterday 17:00.

> **You:** From now on, when feedback arrives as a PDF, translate it into our feedback spreadsheet
> and send it back as a file.
>
> **MAMA:** Saved as a workflow. I will use it for the next feedback PDF.

> **You (in your DM):** Open the progress sheet in Drive and chart this month's prices by title.
>
> **MAMA:** Here is the chart and the table behind it. Two titles have no price yet this month.

At 08:00, 13:00 and 18:00 it sends a full report. Urgent changes arrive as soon as they happen;
the rest are gathered into an hourly reminder between 09:00 and 21:00.

## Getting started

You need Node.js 22.13+, a logged-in `claude` or `codex` CLI, and a Telegram bot in a group
for common changes (Discord and Slack work too). Create that group even for a solo owner;
use its negative group or supergroup ID during setup. Private chats enter personal sessions.

```bash
npm install -g @jungjaehoon/mama-os
mama init          # asks for settings; tokens are typed at hidden prompts
mama register-owner YOUR_TELEGRAM_USER_ID # after setting member_root outside HOME
~/.mama/start.sh   # or the launchctl command init prints
```

On macOS `mama init` also installs the document toolkit the sessions use for office files and
charts; after an upgrade, run `mama tools install` again.

To run from a checkout instead, run `pnpm install` and `pnpm build`, then use
`node packages/standalone/dist/cli/index.js` wherever the guides say `mama`.

Before registration, set `member_root` in `~/.mama/config.yaml` to an absolute directory
outside HOME. Replace `YOUR_TELEGRAM_USER_ID` with each owner's positive user ID and register
them before starting the daemon. See [owner setup](docs/start/owner-setup.md).

Then send your bot a message. Setup is done when MAMA answers you, not when the process is
running. The [first-day tutorial](docs/start/tutorial.md) walks through connecting a source,
asking about work, giving a correction, reports, the viewer and sending files.

Claude Code development memory is separate and needs no daemon: `/plugin install mama`, or add the
MCP server `{"mcpServers":{"mama":{"command":"npx","args":["@jungjaehoon/mama-server"]}}}`.
See [Claude Code plugin](docs/start/claude-code-plugin.md).

## How it works

```
What you connect   work sources · a messenger · corrections you give
The agent          a common session, a DM session per person and a group session per member, on Claude or Codex
The record         SQLite on your machine: originals · work history · guidance · reports · run logs · local search index
```

**The record.** Every collected message, file notice or calendar change is stored as an original
observation. Work items keep revisions: each one says what changed, why, the evidence it came from
and who was involved. Search runs locally over originals, work history and memory.

**The agent.** The common group, new source changes and scheduled reports reach the common
session. It reads the stored work and sources before answering, updates the work history, writes
the board and the wiki pages of the work it touched, and can split a large replay window across
subagents inside the same turn. A source change gets a short turn that decides whether to tell you
and a second turn that records it; MAMA checks the work ledger and orders the record again if it is
missing. Every tool call it makes is recorded with the run that made it.

**Each person's DM.** Everyone you register, owners included, gets a session of their own in a DM
with MAMA, with their own records, scheduled jobs, notices and skills. An owner's DM also reads the
common records and sources. In a DM, MAMA can run scripts in that person's workspace, make
PowerPoint, Word, Excel and PDF files and charts, and, for an owner, read Google Drive sheets. A
member without the owner role works in the group in a session of its own, within the projects it is
given. See [People and DMs](docs/guides/people.md).

**Guidance and workflows.** Your corrections are kept as lessons, preferences, constraints and
workflows, each with a line saying when it applies. Rules that always apply go in your owner
policy file, which the common session and owners' DMs hold. With each message from you or source change,
the agent is shown the few saved lessons that match it best, and can add, revise or retire
workflows as you agree on them. Every change keeps its history.

**The viewer.** `http://127.0.0.1:3847` shows the board, work items with their history, the memory
graph, the wiki and logs.

## What you can connect

Each source is optional; enable the ones you use in `~/.mama/connectors.json` or during `mama init`.

| Source                                | What MAMA collects                                                   | How it connects                      |
| ------------------------------------- | -------------------------------------------------------------------- | ------------------------------------ |
| Chatwork, Slack                       | Messages in the rooms and channels you choose, and their attachments | API token                            |
| Discord                               | Messages in the channels you choose                                  | Bot token                            |
| Trello                                | Card and list changes on the boards you choose                       | API key and token                    |
| Notion                                | Pages shared with the integration                                    | API token                            |
| Telegram (source)                     | Messages in groups you add a separate source bot to                  | Bot token                            |
| Google Calendar, Gmail, Drive, Sheets | Changed events, mail, files and rows                                 | The logged-in `gws` command          |
| iCal feeds                            | Events in the calendar feeds you add                                 | Private URL as a secret, set by hand |
| Obsidian                              | Notes in the vault folders you choose                                | Local folder                         |
| iMessage                              | Messages in the chats you choose                                     | Local database (Full Disk Access)    |
| Claude Code                           | Conversations in the projects you choose                             | Local folder                         |
| Kagemusha bridge                      | A read-only view of a local Kagemusha database                       | Local database                       |

**Messengers.** You talk to MAMA in Telegram, Discord or Slack. In Telegram, each person you
register has a DM with MAMA, and owners and members also use the common group; Discord and Slack
keep one owner channel. Messages from anyone else are ignored and logged. You choose which messenger
receives reports, notifications and security alerts. See [Sources](docs/guides/connectors.md) and
[Messengers](docs/guides/messengers.md).

## Security

- Tokens are typed by you at a terminal prompt and stored only in `~/.mama/auth.env` (mode 0600).
  The configuration files hold none, and the agent cannot read MAMA's credential files.
- The agent writes only inside its workspace. Files you send it are saved by MAMA into a folder the
  agent can read but not change.
- Messages, files and pages from other people reach the agent marked as untrusted evidence, never
  as instructions.
- Work that runs with no one in the conversation (source changes and reports, and the notices and
  scheduled jobs of people with the owner role) can search the web but opens pages only from sites
  you list; other members have no web tools. When you ask, the agent on the Claude
  backend can open any page, and you are told which sites it opened, grouped per site within a
  minute. The Codex backend searches the web but does not open pages.
- The viewer answers only on your machine (`127.0.0.1`) by default and serves read-only pages.

**Reaching the viewer from outside.** If you expose it through a tunnel:

1. Put it behind Cloudflare Access and set `MAMA_CF_ACCESS_ISSUER` and `MAMA_CF_ACCESS_AUD` so MAMA
   verifies the Access token itself, or set `MAMA_AUTH_TOKEN` for short tests only.
2. List your hostnames in `MAMA_VIEWER_HOSTNAMES`; requests for other hosts are refused.
3. Every outside request is logged as a security event, and suspicious ones alert you in your
   messenger.

Details: [Security guide](docs/guides/security.md), [Viewer](docs/guides/viewer.md).

## Packages

These are the current package versions.

| Package                                                     | Role                             | Version |
| ----------------------------------------------------------- | -------------------------------- | ------- |
| [MAMA OS](packages/standalone/README.md)                    | Owner agent and `mama` command   | 0.78.0  |
| [mama-core](packages/mama-core/README.md)                   | Shared engine and public exports | 8.8.0   |
| [Public MCP server](packages/mcp-server/README.md)          | Development memory over stdio    | 2.6.0   |
| [Claude Code plugin](packages/claude-code-plugin/README.md) | Development commands and hooks   | 2.3.0   |

## Roadmap

MAMA is built in stages, and each stage is judged on real work, not on tests alone. Today it runs
on the developer's own Mac. 1.0 is the stage where anyone can install it.

| Stage                      | What you get                                                                                                                                                                                           | Progress                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| 1. The record              | Every original kept, a history for each piece of work with its evidence, local search, and past messages imported per source (`mama backfill`, `mama replay`)                                          | Done                                                                                                                    |
| 2. Your own work           | It finds the work in your sources, adds news to it, answers who is doing what and how things went, keeps reports and the board in line with the work, and follows your corrections, on Claude or Codex | Live on one install; 2 of 5 owner checks accepted                                                                       |
| 3. A shared engine         | Another project builds its own records, history and search on mama-core                                                                                                                                | Done                                                                                                                    |
| 4. People                  | Each person has a DM with its own records, jobs and skills; members work in the group within what they are granted                                                                                     | In progress: owners' DMs built and in use (one daily, one a few times); members without the owner role not yet verified |
| 5. 1.0: anyone can install | A fresh install on macOS, Linux or Docker, set up from the docs alone and kept across upgrades                                                                                                         | In progress: 9 of 52                                                                                                    |

Messengers: Telegram is live; Discord and Slack have not run live yet. Windows is not planned for
1.0.

### 1.0 progress

| Area             | What it covers                                                                                                              | Done       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Install          | One command per platform, a check of the AI CLI you sign in to, a Node path that survives upgrades, document tools on Linux | 1 / 6      |
| Setup            | Pairing in Telegram instead of typed IDs, defaults instead of edited files, the service started for you                     | 0 / 7      |
| Operations       | Status, `mama doctor`, update (also from chat), backup and restore, upgrade checks, logs, log rotation, uninstall           | 7 / 9      |
| Linux            | Document rendering, sandbox checks, a full run                                                                              | 0 / 5      |
| Docker           | An official image, signing in inside the container, the same isolation inside it                                            | 0 / 5      |
| Everyday use     | Chat commands such as `/stop`, usage and limits, a health view, Discord and Slack verified or marked experimental           | 0 / 4      |
| People           | The remaining live checks, and use by more than one person                                                                  | 0 / 5      |
| Your own work    | The owner checks of stage 2 accepted                                                                                        | 0 / 4      |
| Fixes and guides | Chatwork polling, shutdown order, prompt size, test stability, CI coverage, a guide per platform, what 1.x promises         | 1 / 7      |
| **Total**        |                                                                                                                             | **9 / 52** |

Each item, with what is true today and how it is checked, is in the
[1.0 work list](docs/development/work/v1.md). Ongoing live checks are in the
[work plan](docs/development/plan.md).

## Documentation

- [Your first day with MAMA](docs/start/tutorial.md) · [Owner setup](docs/start/owner-setup.md)
- [Sources](docs/guides/connectors.md) · [Messengers](docs/guides/messengers.md) ·
  [People and DMs](docs/guides/people.md) ·
  [Reports and board](docs/guides/reports-and-board.md) ·
  [Corrections and learning](docs/guides/corrections-and-learning.md)
- [CLI](docs/reference/cli.md) · [Configuration](docs/reference/configuration.md) ·
  [Architecture](docs/explanation/architecture.md)
- [Security](docs/guides/security.md) · [Contributing](docs/development/contributing.md)

## License

[MIT](LICENSE).
