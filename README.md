# MAMA OS — Local AI Runtime with Connected Memory

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/badge/node-%3E%3D22.13.0-brightgreen)](https://nodejs.org)
[![LongMemEval](https://img.shields.io/badge/LongMemEval-93%25-blue)](packages/memorybench/)
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

### Why We Pivoted

MAMA started as a multi-agent dashboard — skills marketplace, playground, agent swarm, cron scheduler. Those features still exist and work, but they're no longer the focus.

Why? Because **AI agents commoditized all of it.** Claude, GPT, Codex can all orchestrate sub-agents, execute code, and run tools out of the box. Building another agent framework is competing with the foundation model providers themselves.

What AI agents **cannot** do is remember. Every session starts from zero. That's the gap only a persistent memory layer can fill — and that's where MAMA's real value lies.

| Commoditized (still works, not the focus) | Unique to MAMA (core focus)                     |
| ----------------------------------------- | ----------------------------------------------- |
| Multi-agent orchestration                 | Knowledge graph with decision evolution         |
| Skills/plugins marketplace                | Automatic memory extraction from conversations  |
| Code sandbox                              | Cross-source intelligence (code + chat + email) |
| Cron scheduling                           | Domain-specific recall with "why" context       |

### The Vision: From Tool to Partner

```
Today:     General-purpose AI agent (smart but no context)
+ MAMA:    AI agent with your domain knowledge (smart + experienced)
Future:    AI that understands why your team makes decisions the way it does
```

Tacit knowledge — the know-how that lives in conversations, failed experiments, and tribal memory — is the most valuable and hardest to capture asset in any organization. MAMA captures it automatically through a knowledge graph that preserves not just facts, but the reasoning behind every decision.

## Architecture

```
  Conversations                Files & Documents            External Apps
  ─────────────                ─────────────────            ─────────────
  Claude Code (hooks)          PDF / Images                 Gmail MCP ──┐
  Telegram ──────┐             Google Drive                 Calendar ───┤
  Discord  ──────┤             Slack attachments            GitHub ─────┤
  Slack    ──────┤                    │                     Notion ─────┘
  Web Chat ──────┘                    │                          │
        │                             │                     MCP Bridge
        ▼                             ▼                          │
   ingestConversation            ingestDocument                  │
        │                             │                          │
        └──────────┬──────────────────┴──────────────────────────┘
                   ▼
          MAMA OS (localhost:3847)
     ┌──────────────────────────────┐
     │   Memory Agent               │
     │   (observe, extract, evolve) │
     │                              │
     │   Knowledge Graph Engine     │
     │   ┌──────────────────────┐   │
     │   │ facts, decisions,    │   │
     │   │ preferences (nodes)  │   │
     │   │ supersedes/builds_on │   │
     │   │ debates/synthesizes  │   │
     │   │ (edges)              │   │
     │   │ vector + FTS5 search │   │
     │   └──────────────────────┘   │
     └──────────────────────────────┘
                   │
              SQLite (local)
         ~/.claude/mama-memory.db
```

**Local-first.** All data stays on your device. No cloud dependency. AI provider independent — works with Claude, GPT, Codex.

### Knowledge Sources

MAMA's knowledge graph isn't limited to conversations. Any source of knowledge can be ingested:

| Source                   | Method                                             | Status     |
| ------------------------ | -------------------------------------------------- | ---------- |
| **Claude Code sessions** | Plugin hooks → `ingestConversation`                | Production |
| **Messenger chats**      | Telegram/Discord/Slack bots → `ingestConversation` | Production |
| **PDF / Documents**      | Connector → LLM extraction → `ingestDocument`      | v0.17      |
| **Images**               | Connector → LLM vision → `ingestDocument`          | v0.17      |
| **Google Drive**         | MCP Bridge → `ingestDocument`                      | v0.17      |
| **Gmail / Calendar**     | MCP Bridge → `ingestConversation`                  | v0.17      |
| **GitHub / Notion**      | MCP Bridge → `ingestConversation`                  | v0.17      |

mama-core stores **extracted facts only**, never raw files. Connectors handle extraction, mama-core handles storage + search. This means 100+ existing [MCP servers](https://modelcontextprotocol.io/) can feed into MAMA's knowledge graph via a thin bridge adapter.

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

| System      | Score     | Model      | Notes                        |
| ----------- | --------- | ---------- | ---------------------------- |
| Mastra      | 94.87%    | GPT-5-mini |                              |
| **MAMA OS** | **93.0%** | Sonnet 4.6 | Tool-use answer, 100Q sample |
| SuperMemory | 81.6%     | GPT-4o     |                              |
| Zep         | 71.2%     | GPT-4o     |                              |

MAMA now outperforms SuperMemory while running **entirely locally** with open-source components. The tool-use answer phase lets the LLM re-search when initial results are insufficient.

## Packages

| Package                                          | Version | Description                                  |
| ------------------------------------------------ | ------- | -------------------------------------------- |
| [@jungjaehoon/mama-os](packages/standalone/)     | 0.16.1  | Always-on runtime with messenger gateways    |
| [@jungjaehoon/mama-server](packages/mcp-server/) | 1.10.1  | MCP server for Claude Desktop/Code           |
| [@jungjaehoon/mama-core](packages/mama-core/)    | 1.4.0   | Core library (memory engine, embeddings, DB) |
| [mama plugin](packages/claude-code-plugin/)      | 1.9.0   | Claude Code plugin (marketplace)             |
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
- **Embeddings:** Xenova/multilingual-e5-large (1024-dim, quantized q8, 100+ languages)
- **Search:** Hybrid retrieval — FTS5 BM25 (lexical) + cosine similarity (semantic) + RRF fusion
- **Extraction:** Sonnet for structured fact extraction from conversations
- **Transport:** CLI subprocess (Claude/Codex) — officially supported, ToS compliant

## Current Status & Roadmap

### What Works Today

| Feature                | Status     | Details                                                                         |
| ---------------------- | ---------- | ------------------------------------------------------------------------------- |
| **Knowledge Graph**    | Production | decisions + edges (supersedes/builds_on/debates/synthesizes) + truth projection |
| **Hybrid Search**      | Production | FTS5 BM25 + vector cosine + RRF fusion, 93% on LongMemEval                      |
| **Claude Code Plugin** | Production | Auto-save decisions via hooks, search via `/mama:search`                        |
| **MCP Server**         | Production | `mama_save`, `mama_search`, `mama_suggest`, `ingest_conversation` + scopes      |
| **Messenger Gateways** | Production | Telegram, Discord, Slack bots with memory integration                           |
| **Always-On Daemon**   | Production | Cron scheduler, web dashboard at localhost:3847                                 |
| **Evolution Engine**   | Production | Conservative supersede (overlap-based), builds_on for independent facts         |

### What's Not Built Yet

| Feature                       | Target | Why It Matters                                        |
| ----------------------------- | ------ | ----------------------------------------------------- |
| **Noise Filtering**           | v0.17  | Reject greetings, internal prompts, duplicates        |
| **Pattern Recognition**       | v0.17  | Detect recurring workflows from accumulated knowledge |
| **Cross-Source Intelligence** | v0.17  | Code decisions + team chat + email = unified graph    |
| **Workflow Recommendations**  | v0.18  | "Your team usually does X before Y" suggestions       |
| **Memory Explorer UI**        | v0.18  | Visual graph of decision evolution                    |
| **Enterprise Server Mode**    | v0.19  | Central server for team knowledge (vs personal local) |
| **Domain Automation**         | v1.0   | Knowledge graph → automated workflow execution        |

### Roadmap

| Phase    | Version | Focus                                                         |
| -------- | ------- | ------------------------------------------------------------- |
| **Done** | v0.15   | Search quality overhaul, FTS5, evolution engine (58% → 88%)   |
| **Done** | v0.16   | event_date API, tool-use answer, memory agent v5 (88% → 93%)  |
| **Next** | v0.17   | Connector framework, cross-source memory, pattern recognition |
|          | v0.18   | Control tower UI, memory explorer, workflow recommendations   |
|          | v0.19   | Stability, security audit, enterprise server mode             |
|          | v1.0    | General release — domain automation                           |

## Development

```bash
git clone https://github.com/jungjaehoon-lifegamez/MAMA.git
cd MAMA
pnpm install
pnpm build
pnpm test     # 2000+ tests across all packages
```

See [CLAUDE.md](CLAUDE.md) for detailed development guidelines.

## License

MIT

---

_Last updated: 2026-04-01_
