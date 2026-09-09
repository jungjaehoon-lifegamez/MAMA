# MAMA

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen)](https://nodejs.org)
[![Docs](https://img.shields.io/badge/docs-GitHub%20Pages-blue)](https://jungjaehoon-lifegamez.github.io/MAMA/)

[Documentation](https://jungjaehoon-lifegamez.github.io/MAMA/) ·
[Getting started](#getting-started) · [How it works](#how-it-works) · [Security](#security) ·
[Roadmap](#status-and-roadmap)

MAMA is a **memory store** that runs on your own computer, and an **AI assistant** that works
from it. It keeps what flows through your connected messengers, mail, documents, and calendars
as-is, and the assistant reads that record to tell you what changed and do what you ask.
Nothing is uploaded anywhere. The record stays on your machine.

## Why

An AI assistant is only useful with memory, and memory kept on a company's server disappears
when the service changes or shuts down. MAMA keeps the record of what you did and decided on
your own computer, in the original form, so a better model can read the same record tomorrow.
The memory layer is fixed; which sources you connect and what work you hand over is up to you.

## Principles

In order of importance.

1. **Never lose the record.** Original text, time, source, and later changes are kept, not
   overwritten.
2. **Know why it changed.** Every change the assistant makes names the message or event behind
   it, or is marked "no cause".
3. **Act only where allowed.** Sending messages, paying, deleting: anything with outside effect
   requires prior permission for that target.
4. **Remember corrections.** Say "keep reports short" or "cards on the dashboard" once; it is
   stored as a rule and applied from then on.
5. **Stay independent of the model vendor.** The assistant's brain (Claude, Codex, Cline) is
   swappable; the record's format is not.
6. **Everything else.** Speed and convenience improve only within the five above.

## Parts

| Name | What it does | Version |
|---|---|---|
| `@jungjaehoon/mama-os` | The server: sources, assistant, messenger links, web viewer | 0.52.x |
| `@jungjaehoon/mama-core` | The memory store: format, search, change log | 2.4.x |
| `@jungjaehoon/mama-server` | MCP bridge for Claude Desktop and other MCP clients | 1.15.x |
| Claude Code plugin | Decision memory for coding sessions | 1.11.x |
| MemoryBench | Measures how accurate memory retrieval is | 1.0.x |

## Getting started

Requires Node 22.13+ and a logged-in `claude` or `codex` CLI.

```bash
claude auth login                   # or: codex login
npm install -g @jungjaehoon/mama-os
mama --help                         # tells you the next step
mama status                         # setup is done when the first report arrives
```

- Messenger: `mama gateway telegram --token-stdin` (Slack and Discord work the same way)
- Sources: `mama connector add <name>`, then `mama connector status`
- Web viewer: `http://localhost:3847/viewer` for reports, the task board, and system status
- For scripted installs, follow the `missing` list from `mama status --json` in order; it is
  finished only when `complete: true`.

Claude Code plugin: `/plugin install mama`. MCP:
`{"mcpServers":{"mama":{"command":"npx","args":["@jungjaehoon/mama-server"]}}}`.

## How it works

```
What you add      sources to connect · work to hand over · rules you correct
The assistant     one assistant · a tool catalog · permission scopes · a rule store
The memory store  SQLite on your machine: originals · decision history · change causes · run logs · local search index
```

**Memory store.** Per-source originals live in `~/.mama/connectors/<name>/raw.db`; decisions
and change logs under `~/.mama/`. Changing a decision adds a "this replaced that" link instead
of deleting the old one. Each change log row holds what changed and what caused it; a row with
a faked cause is rejected at write time. The search index (embeddings) is built locally.

**Assistant.** Your messages, scheduled reports, new source content, and timed jobs all reach one
assistant. It picks tools from the catalog and hands long reads and background work to helper
agents, taking back only the result. Every run carries a permission scope saying what it may
touch and until when. Your corrections are stored as rules and offered as candidates in similar
situations. Reports and the board are edited from the last published version, not rebuilt.

**What you add.** A new source is one `IConnector` implementation; polling and storage are
handled. A new kind of work is one entry in the tool catalog. A new rule is one message.

## Sources

calendar, chatwork, discord, drive, gmail, imessage, notion, obsidian, sheets, slack, telegram,
trello, claude-code. Config in `~/.mama/connectors.json`; status via `mama connector status`.
Each channel gets a role (truth, hub, deliverable, spoke, reference) used in reports.

## Security

- The server answers only on your machine (`127.0.0.1`) by default.
- Sending, uploading, paying, and deleting happen only toward allowed targets. Unattended work
  (scheduled reports, incoming-content handling) has no send permission.
- Only allow-listed chats are accepted from messengers (`allowedChatIds` for Telegram).
- Values that look like passwords or keys are not stored in memory.
- Outbound connections go only to the services you connected and the AI CLI you logged into.
  There is no MAMA company server; you run it yourself.

**Running on another host or reaching it from outside.** The viewer and API drive the
assistant, and the assistant can read and write files and run commands. Exposing the server
exposes that machine. If you open it up:

1. Set an access token. Never expose it without one.
2. Do not open the port directly; put it behind an authenticated tunnel or VPN.
3. Keep the messenger allow-list, and restrict `~/.mama/` to the operating account.
4. Back up `~/.mama/` together with `~/.claude/mama-memory.db`.

Details: [Security guide](docs/guides/security.md), [Remote access](docs/guides/mobile-access.md).

## Status and roadmap

| Stage | What | Status |
|---|---|---|
| Memory store | Originals kept, decision history, change causes, local search | done |
| Single-owner assistant | Scheduled reports, board and journal, corrections become rules | done |
| Helpers and continuation | Long work to helper agents; reports continue from the last version | verified locally, preparing release |
| Team members | Verified people share the same memory within their own permissions | next |
| File work | Request → read → new version → approval → delivery → follow-up | next |
| Extension guide | How to add your own sources, tools, and rules | next |

Before 1.0, config and storage format changes ship with automatic migration; APIs may change.

## Read more

- [Documentation site](https://jungjaehoon-lifegamez.github.io/MAMA/)
- [Intent](INTENT.md) · [Architecture](docs/explanation/architecture.md) ·
  [Correcting rules](docs/guides/procedure-corrections.md) · [Configuration](docs/reference/configuration-options.md)
- [Developer playbook](docs/development/developer-playbook.md) · [Release process](docs/development/release-process.md)

## Build

```bash
pnpm install
pnpm build
pnpm test
```

## Contributing

Open an issue or discussion first. Discuss the design before building a feature. Changes to the
storage format must come with a migration script.

## License

MIT © jungjaehoon
