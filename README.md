# MAMA OS

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![LongMemEval 100Q](https://img.shields.io/badge/LongMemEval%20100Q-93%25-blue)](packages/memorybench/)
[![Tests](https://img.shields.io/badge/tests-4958%20passing-success)](https://github.com/jungjaehoon-lifegamez/MAMA)

> You read your channels so nothing slips. MAMA reads them instead, and messages
> you the three things that actually need you — each one linked to its source.

## The product is a message that arrives

You pick the hours. At those hours, in Telegram, Slack, or Discord:

```text
■ Briefing — Wed 08:00
1. Client A sent the revised files overnight                  → source
2. The #alpha deadline moved from Friday to Wednesday         → source
3. B's question about invoice terms is 14 hours unanswered    → source

■ Needs your action
- Approve the revised scope before the 11:00 call             → thread

■ Recorded yesterday
- Decision: rotate the staging API keys weekly                → source
```

The example is synthetic; the shape is what the daemon actually sends.

Nobody asked for that message. Overnight, a daemon on your machine polled 14
sources — Slack, Telegram, Gmail, Trello, Sheets, an Obsidian vault, more —
decided what needed you, and wrote it down with links. Behind the message it
already did the small work: the task board updated itself from those same
conversations, durable judgments were filed into memory, and the wiki wrote
its daily page.

## What that replaces

- The morning scan across channels that mostly did not change.
- The archaeology of "when did that deadline move, and who said so?"
- The handoff note you write — or wish someone had written — before stepping away.

Three things it is **not**: a chatbot with good memory (it runs while nobody is
talking to it), a memory database (storage is the input; the report is the
product), or a hosted service (no account, no cloud, no upload).

## Built to be checked, not believed

A system that acts on its own is tolerable only if you can audit it afterwards.

- **No source, no claim.** Every durable change is stored together with the
  events that caused it — or explicitly marked _unattributed_. A database
  constraint makes the third option, a plausible-looking invented cause,
  unstorable.
- **It drafts; you send.** An agent can write the customer reply from the
  evidence, but sending requires an explicit permission for that destination.
  Memory writes refuse anything shaped like a secret.
- **Nothing leaves your machine.** Local SQLite, local embeddings (100+
  languages). The only network traffic is the `claude` or `codex` CLI you
  already logged into, spawned as an official subprocess — no API keys, no
  token extraction, nothing that violates provider terms.
- **Search shows its work.** Strict mode drops a semantic match with no
  lexical or entity evidence behind it: a plausible wrong answer is rejected,
  not displayed.

Depth lives in the docs: [Architecture](docs/explanation/architecture.md) ·
[Security guide](docs/guides/security.md)

## Quick start

**The daemon** — the full product:

```bash
claude auth login            # or: codex login — your existing CLI auth is reused
npx @jungjaehoon/mama-os init
mama start                   # daemon at localhost:3847
```

Operator board at `http://localhost:3847/ui`: live report slots, the trigger
library, and a task board fed from your channels. Chat surfaces: Discord,
Slack, Telegram. Requires Node >= 22 and an authenticated
[Claude Code](https://claude.ai/claude-code) or
[Codex](https://www.npmjs.com/package/@openai/codex) CLI.

**Claude Code plugin** — no daemon; decision memory for coding sessions:

```bash
/plugin install mama
/mama:search "authentication strategy"
```

**MCP server** — Claude Desktop or any MCP client:

```json
{ "mcpServers": { "mama": { "command": "npx", "args": ["@jungjaehoon/mama-server"] } } }
```

## The pieces

| Package                                       | What it is                                                                                                     | You run it?          |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------- |
| [mama-os](packages/standalone/) 0.29.2        | The daemon: connectors, trigger loop, reports, task board, web UI. 92k lines. "MAMA" means this.               | `mama start`         |
| [mama-core](packages/mama-core/) 2.0.0        | The library underneath: memory, provenance, graph, embeddings. Everything imports it; it imports nothing here. | No binary            |
| [mama-server](packages/mcp-server/) 1.15.0    | A deliberately thin MCP adapter over the core — 3.7k lines, no logic of its own.                               | As an MCP server     |
| [plugin](packages/claude-code-plugin/) 1.11.0 | Claude Code hooks + slash commands. No background process.                                                     | Installed, not run   |
| [memorybench](packages/memorybench/) 1.0.0    | The benchmark harness behind the retrieval numbers.                                                            | To reproduce a score |

Dependency direction is one-way: nothing depends on the daemon.

## Numbers we publish against ourselves

- **93.0%** on a 100-question LongMemEval tool-use sample (Sonnet 4.6, fully
  local) — above SuperMemory (81.6%), below Mastra (94.87%).
  [Reproduce it](packages/memorybench/).
- **84% of trigger-authoring passes create nothing** — a duplicate gate rejects
  near-variants of triggers that already exist. Correct, but a self-evolving
  loop idle five times out of six has room to propose better.
- **Cache reuse is 15.9x** per built context, measured against 144.8x for a
  comparable operator on the same machine. The largest cost lever we know of.
- **3 of 18 recent changes carried a cause.** Honest — most runs are
  autonomous, with no owner message to cite — but a floor, not a resting place.

## Roadmap

|                    |                                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Done (v0.15–v0.28) | Search overhaul → connector framework → the operator runtime → owner console → durable workorder pipeline. Full history in the [CHANGELOG](CHANGELOG.md).                 |
| **Now (v0.29)**    | Evidence and effects: every durable change names its cause, or admits it has none.                                                                                        |
| Next               | Context reuse (closing the 15.9x → 144.8x gap), a health surface that makes the daemon's own silence loud, attribution for the autonomous lanes that do most of the work. |
| v1.0               | Team mode: a shared, scoped knowledge graph. General release.                                                                                                             |

## Development

```bash
git clone https://github.com/jungjaehoon-lifegamez/MAMA.git
cd MAMA && pnpm install && pnpm build
pnpm test     # 4,958 tests across five packages
```

Guidelines in [CLAUDE.md](CLAUDE.md). _Last updated: 2026-07-30_

## License

MIT
