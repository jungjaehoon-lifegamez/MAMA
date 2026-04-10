# MAMA OS — Local AI Runtime with Connected Memory

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![LongMemEval](https://img.shields.io/badge/LongMemEval-93%25-blue)](packages/memorybench/)
[![Tests](https://img.shields.io/badge/tests-2800%2B%20passing-success)](https://github.com/jungjaehoon-lifegamez/MAMA)

> Your scattered knowledge, organized by AI agents that never sleep.

## The Problem

Your knowledge is everywhere — Slack threads, email chains, code reviews, meeting notes, spreadsheets, Telegram messages. No human can track all of it. Important decisions get buried. Context gets lost between tools. When you need to make a decision, the information that would help is scattered across ten different apps and three months of history.

This isn't a memory problem. It's an intelligence problem.

## What MAMA OS Does

MAMA OS is a local daemon that connects to your apps, reads everything continuously, and turns scattered records into organized knowledge — then delivers actionable briefings so you can make better decisions faster.

**What the knowledge agents do:**

- **Read everything** — 15 connectors poll Slack, Gmail, Trello, Obsidian, and more. Every day, every channel.
- **Identify what matters** — Out of thousands of messages, surface the decisions, deadlines, and changes that affect your work
- **Connect across sources** — A Slack conversation + a Trello card + an email about the same project are linked automatically
- **Track decision evolution** — Not just what was decided, but what it replaced, what it builds on, and what it contradicts
- **Compile actionable knowledge** — Raw conversations become structured wiki pages with priorities, gaps, and next steps
- **Brief you proactively** — When you start working, relevant context from all sources is already there

```
Without MAMA:  You read 5 Slack channels, 3 email threads, check Trello,
               re-read old PRs, then try to piece together the full picture.

With MAMA:     Agents already read everything. You get a briefing with
               what changed, what's at risk, and what needs your decision.
```

**This is what AI agents can do that humans can't** — read every channel, every thread, every document, every day, and never miss a connection.

## Knowledge Graph

MAMA doesn't just store facts. It tracks how knowledge evolves:

```
"Use JWT" (decision, confidence: 0.8)
    │
    ├── superseded by → "Use JWT with refresh tokens"
    │     reason: "Users complained about frequent logouts"
    │
    ├── builds_on → "Add token rotation for security"
    │
    └── debates → "Consider session-based auth for web app"
          reason: "Simpler for server-rendered pages"
```

Edge types: `supersedes` (replaced), `builds_on` (extended), `debates` (alternative view), `synthesizes` (unified from multiple).

MAMA answers "why did we switch?" — not just "what do we use?"

## Architecture

```
Connectors (15)          Gateways (4)
Slack, Gmail, Sheets...  Discord, Slack, Telegram, Chatwork
       |                        |
       v                        v
 3-Pass Extraction       Knowledge Agents
 (Truth → Hub → Spoke)  (Conductor, Dashboard, Wiki, Memory)
       |                        |
       +--------+-------+------+
                |
         MAMA Core (mama-memory.db)
         Local SQLite + 1024-dim embeddings
         Knowledge graph + evolution edges
                |
         +------+------+
         |             |
    Viewer UI     Claude Code Plugin
```

**Local-first.** All data stays on your device. No cloud. AI provider independent — works with Claude, Codex, or any future backend.

## Security

MAMA OS has full system access via the backend CLI — so security is foundational, not optional.

- **Local-only by default** — Binds to localhost. External access requires explicit tunnel + authentication.
- **5-layer prompt injection defense** — Output sanitization, channel trust boundaries, silent mode, bulk extraction limits. Built from a [real incident](docs/guides/security.md), not theory.
- **Intrusion detection & response** — Honeypot traps → immediate IP ban (15min). Auth failures → auto-ban after 5 attempts. Tarpit delays for suspicious IPs.
- **Agent permission tiers** — Tier 1 (full), Tier 2 (read-only), Tier 3 (scoped). Each agent gets only the tools it needs.
- **Fail-safe shutdown** — When an intrusion cannot be contained, MAMA shuts down gracefully rather than operating compromised.

See the full [Security Guide](docs/guides/security.md) for Cloudflare Zero Trust setup, token authentication, threat scenarios, and Code-Act sandbox isolation.

## Benchmark: LongMemEval

Tested on [LongMemEval](https://xiaowu0162.github.io/long-mem-eval/) — 500 questions across 6 types, ~115K tokens of conversation history per question.

| System | Score | Model | Notes |
|--------|-------|-------|-------|
| Mastra | 94.87% | GPT-5-mini | |
| **MAMA OS** | **93.0%** | Sonnet 4.6 | Tool-use answer, 100Q sample |
| SuperMemory | 81.6% | GPT-4o | |
| Zep | 71.2% | GPT-4o | |

MAMA outperforms SuperMemory while running **entirely locally** with open-source components.

## Packages

| Package | Version | Description |
|---------|---------|-------------|
| [@jungjaehoon/mama-os](packages/standalone/) | 0.18.0 | Always-on runtime — connectors, knowledge agents, viewer |
| [@jungjaehoon/mama-server](packages/mcp-server/) | 1.12.1 | MCP server for Claude Desktop/Code |
| [@jungjaehoon/mama-core](packages/mama-core/) | 1.4.0 | Core library (memory engine, embeddings, DB) |
| [mama plugin](packages/claude-code-plugin/) | 1.9.0 | Claude Code plugin (marketplace) |
| [memorybench](packages/memorybench/) | 1.0.0 | Memory retrieval benchmarking framework |

## Quick Start

### Claude Code Plugin (simplest)

```bash
/plugin install mama

# Decisions are saved automatically via hooks
# Search manually when needed:
/mama:search "authentication strategy"
```

### MAMA OS (full runtime)

```bash
npx @jungjaehoon/mama-os init
mama start   # starts daemon at localhost:3847
```

Web viewer at `http://localhost:3847`. Connects to Discord, Slack, Telegram.

> **Requires:** [Claude Code CLI](https://claude.ai/claude-code) or [Codex CLI](https://www.npmjs.com/package/@openai/codex) installed and authenticated. Node.js >= 18.

### MCP Server (Claude Desktop)

```json
{
  "mcpServers": {
    "mama": {
      "command": "npx",
      "args": ["@jungjaehoon/mama-server"]
    }
  }
}
```

## Technical Details

- **Database:** SQLite via better-sqlite3 (FTS5 full-text search + vector embeddings)
- **Embeddings:** Xenova/multilingual-e5-large (1024-dim, quantized q8, 100+ languages)
- **Search:** Hybrid retrieval — FTS5 BM25 (lexical) + cosine similarity (semantic) + RRF fusion
- **Extraction:** Sonnet for structured fact extraction from conversations
- **Transport:** CLI subprocess (Claude/Codex) — officially supported, ToS compliant

## Roadmap

| Phase | Version | Focus |
|-------|---------|-------|
| **Done** | v0.15 | Search quality overhaul, FTS5, evolution engine (58% → 88%) |
| **Done** | v0.16 | event_date API, tool-use answer, memory agent v5 (88% → 93%) |
| **Done** | v0.17 | Connector framework (15 connectors), truth-first 3-pass extraction |
| **Done** | v0.18 | Output layer — knowledge agents, viewer redesign, security hardening |
| **Next** | v0.19 | Stability + agent management UI |
| | v1.0 | General release — onboarding, 72h uptime test |

## Development

```bash
git clone https://github.com/jungjaehoon-lifegamez/MAMA.git
cd MAMA && pnpm install && pnpm build
pnpm test     # 2800+ tests across all packages
```

See [CLAUDE.md](CLAUDE.md) for development guidelines.

## License

MIT

---

_Last updated: 2026-04-10_
