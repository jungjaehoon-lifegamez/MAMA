# MAMA OS — Local AI Runtime with Connected Memory

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/badge/node-%3E%3D22.13.0-brightgreen)](https://nodejs.org)
[![LongMemEval](https://img.shields.io/badge/LongMemEval-81.5%25-blue)](packages/memorybench/)
[![Tests](https://img.shields.io/badge/tests-passing-success)](https://github.com/jungjaehoon-lifegamez/MAMA)

> Your AI remembers why, not just what.

MAMA OS is a **local AI runtime** that turns conversations, decisions, and work artifacts into a structured knowledge graph. Every choice is saved with reasoning. Every mistake becomes a reference. When AI agents connect to MAMA, they don't just answer — they understand your context and recommend with evidence.

```
Session 1:  "Use SQLite for the project"
Session 5:  "Switch to PostgreSQL — SQLite can't handle concurrent writes"
Session 12: "Should we use MongoDB for the new service?"
            → MAMA: "You switched from SQLite to PostgreSQL in Session 5
               because of concurrent write issues. MongoDB has similar
               trade-offs. Here's what happened last time..."
```

## Why MAMA OS

AI agents today are brilliant but amnesiac. They forget everything between sessions. MAMA solves this:

|               | Without MAMA           | With MAMA                               |
| ------------- | ---------------------- | --------------------------------------- |
| **Memory**    | Forgets after session  | Knowledge graph with decision evolution |
| **Context**   | Generic answers        | Answers grounded in your history        |
| **Mistakes**  | Repeat the same errors | Past failures prevent future ones       |
| **Knowledge** | Only general knowledge | Domain-specific, accumulated over time  |

### The Vision: From Tool to Partner

```
Today:     General-purpose AI agent (smart but no context)
+ MAMA:    AI agent with your domain knowledge (smart + experienced)
Future:    AI that understands why your team makes decisions the way it does
```

Tacit knowledge — the know-how that lives in conversations, failed experiments, and tribal memory — is the most valuable and hardest to capture asset in any organization. MAMA captures it automatically through a knowledge graph that preserves not just facts, but the reasoning behind every decision.

## Architecture

```
                         MAMA OS (localhost:3847)
                    ┌─────────────────────────────┐
Claude Code ────────┤                             │
  (Plugin hooks)    │   Knowledge Graph Engine    │
                    │   ┌─────────────────────┐   │
Telegram ───────────┤   │ decisions (nodes)   │   │
Discord  ───────────┤   │ edges (supersedes,  │   │
Slack    ───────────┤   │   builds_on,        │   │
                    │   │   debates,          │   │
Web Dashboard ──────┤   │   synthesizes)      │   │
                    │   │ embeddings (vector) │   │
                    │   │ FTS5 (keyword)      │   │
                    │   └─────────────────────┘   │
                    │                             │
                    │   Memory Agent               │
                    │   (auto-extract, evolve)     │
                    └─────────────────────────────┘
                              │
                         SQLite (local)
                    ~/.mama/mama-memory.db
```

**Local-first.** All data stays on your device. No cloud dependency. AI provider independent — works with Claude, GPT, Codex.

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

This means MAMA can answer "why did we switch?" — not just "what do we use?"

## Benchmark: LongMemEval

Tested on [LongMemEval](https://xiaowu0162.github.io/long-mem-eval/) — 500 questions across 6 types, ~115K tokens of conversation history per question.

| System      | Score     | Model      |
| ----------- | --------- | ---------- |
| Mastra      | 94.87%    | GPT-5-mini |
| SuperMemory | 81.6%     | GPT-4o     |
| **MAMA OS** | **81.5%** | Sonnet 4.6 |
| Zep         | 71.2%     | GPT-4o     |

MAMA matches SuperMemory on overall accuracy while running **entirely locally** with open-source components.

## Packages

| Package                                          | Version | Description                                  |
| ------------------------------------------------ | ------- | -------------------------------------------- |
| [@jungjaehoon/mama-os](packages/standalone/)     | 0.14.5  | Always-on runtime with messenger gateways    |
| [@jungjaehoon/mama-server](packages/mcp-server/) | 1.9.3   | MCP server for Claude Desktop/Code           |
| [@jungjaehoon/mama-core](packages/mama-core/)    | 1.3.3   | Core library (memory engine, embeddings, DB) |
| [mama plugin](packages/claude-code-plugin/)      | 1.8.3   | Claude Code plugin (marketplace)             |
| [memorybench](packages/memorybench/)             | 1.0.0   | Memory retrieval benchmarking framework      |

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
npm install -g @jungjaehoon/mama-os
mama start   # starts daemon at localhost:3847
```

Connects to Discord, Slack, Telegram. Web dashboard at `http://localhost:3847`.

> **Requires:** [Claude Code CLI](https://claude.ai/claude-code) or [Codex CLI](https://www.npmjs.com/package/@openai/codex) installed and authenticated.

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
- **Embeddings:** Xenova/multilingual-e5-small (384-dim, quantized q8, 100+ languages)
- **Search:** Hybrid retrieval — FTS5 BM25 (lexical) + cosine similarity (semantic) + RRF fusion
- **Extraction:** Sonnet for structured fact extraction from conversations
- **Transport:** CLI subprocess (Claude/Codex) — officially supported, ToS compliant

## Roadmap

| Phase       | Version | Focus                                                      |
| ----------- | ------- | ---------------------------------------------------------- |
| **Current** | v0.15   | Search quality overhaul, FTS5, evolution engine            |
| Next        | v0.16   | Memory agent endpoint, scope-based search, noise filtering |
|             | v0.17   | Connector framework, messenger memory integration          |
|             | v0.18   | Control tower UI, memory explorer                          |
|             | v0.19   | Stability, security audit                                  |
|             | v1.0    | General release                                            |

## Development

```bash
git clone https://github.com/jungjaehoon-lifegamez/MAMA.git
cd MAMA
pnpm install
pnpm build
pnpm test     # 2600+ tests across all packages
```

See [CLAUDE.md](CLAUDE.md) for detailed development guidelines.

## License

MIT

---

_Last updated: 2026-04-01_
