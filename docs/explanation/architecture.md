---
title: Architecture
parent: Explanation
nav_order: 2
---

# Architecture

MAMA has two products built on one engine. MAMA OS carries the owner's work across messages,
source changes and reports. The Claude Code plugin and public MCP server carry development
memory across coding sessions. They do not share a running daemon or a default database.

## Choose the boundary you are changing

| Package                       | Responsibility                                                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `packages/mama-core`          | SQLite storage, records and revisions, evidence links, memory, search, embeddings, runtime drivers and action dispatch |
| `packages/standalone`         | MAMA OS: Telegram, connectors, owner guidance, work views, reports, wiki, viewer and the `mama` CLI                    |
| `packages/mcp-server`         | Development-memory tools over stdio; calls core in process                                                             |
| `packages/claude-code-plugin` | Claude Code commands and hooks; uses core and the public MCP server                                                    |

The workspace links packages through `workspace:*` dependencies. Another product uses the
[public core exports](../../packages/mama-core/package.json) with its own database, principals,
sources and vocabulary. Core supplies records, revisions and evidence; the consumer supplies what
those records mean. See [INTENT](../../INTENT.md) for the shared-engine acceptance check.

## Follow one owner session

```text
Telegram owner messages     connector deltas     scheduled reports     native events
           \_____________________|_____________________|__________________/
                                 |
                         durable runtime mailbox
                                 |
                       one persistent owner session
                         Claude CLI or Codex
                                 |
                         registered MAMA actions
                                 |
                 work and memory / originals / wiki / board
                                 |
                       Telegram result and receipt
```

[Owner runtime assembly](../../packages/standalone/src/runtime/owner-runtime.ts) opens the
product database, builds the action catalog and starts the native session and mailbox.
[Stimulus delivery](../../packages/standalone/src/runtime/stimulus-delivery.ts) sends the input
kinds through the same session. The backend owns model execution; MAMA supplies source access,
action contracts, storage and traces. The agent decides how evidence changes the work.

Claude receives MAMA actions through the product's MCP adapter; Codex receives dynamic tools.
Both owner backends have web access and workspace file tools. Writes stay in the workspace;
credential files and secret-shaped daemon environment variables are excluded. Native tool and
MAMA action calls are traced. See [backends](../guides/backends.md) and
[security](../guides/security.md) for the boundary.

## Keep the two data homes separate

| State                                                      | Location or authority                                                                     |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| MAMA OS configuration and credentials                      | `~/.mama/config.yaml`, `connectors.json`, and the separate `auth.env`                     |
| Work, memory, source index, mailbox and model/tool records | Product SQLite database at `database.path`; setup sets `~/.mama/memory.db`                |
| Preserved connector payloads                               | Per-connector raw storage under `~/.mama/connectors/`                                     |
| Runtime and delivery state                                 | `~/.mama/runtime/`; the board is persisted in `~/.mama/report-slots.json`                 |
| Owner files and generated artifacts                        | `~/.mama/workspace/`                                                                      |
| Wiki                                                       | Configured `wiki.vaultPath` and `wiki.wikiDir`                                            |
| Development memory                                         | `MAMA_DB_PATH`, then the older `MAMA_DATABASE_PATH`, otherwise `~/.claude/mama-memory.db` |

The [public MCP server](../../packages/mcp-server/src/server.js) initializes development memory
itself. It does not require MAMA OS. Plugin hooks use that development-memory store, not the
owner's product database.

Durable storage and embeddings are local. Configured connectors use their upstream services,
and the selected backend receives the prompts and evidence supplied for a model turn. Local
storage is not a promise that the complete agent runs offline.

Continue with [the owner loop](owner-loop.md), [the work ledger](work-ledger.md), or
[memory and search](memory-and-search.md).
