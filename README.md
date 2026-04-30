# MAMA OS - Local AI Runtime for Provenance-Backed Context

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![LongMemEval](https://img.shields.io/badge/LongMemEval-93%25-blue)](packages/memorybench/)
[![Tests](https://img.shields.io/badge/tests-3000%2B%20passing-success)](https://github.com/jungjaehoon-lifegamez/MAMA)

> Bounded, provenance-backed working context for AI agents running on your machine.

## The Problem

Your knowledge is everywhere — Slack threads, email chains, code reviews, meeting notes, spreadsheets, Telegram messages. No human can track all of it. Important decisions get buried. Context gets lost between tools. When you need to make a decision, the information that would help is scattered across ten different apps and three months of history.

For AI agents, the problem is sharper. A vector search can find something vaguely similar, but the
agent still needs to know whether that result is in scope, which raw evidence supports it, which
model run produced it, and whether it is allowed to act on it.

This isn't just a memory problem. It's a bounded context problem.

## What MAMA OS Does

MAMA OS is a local daemon that connects to your apps, reads continuously, and turns scattered
records into scoped, auditable context for agents and humans.

The browser viewer is the live operating surface for that work: `Dashboard`, `Memory`, `Feed`,
`Wiki`, `Agents`, `Logs`, and `Settings`, with a global chat shell layered on top instead of a
separate chat tab.

**What the knowledge agents do:**

- **Read everything** — 15 connectors poll Slack, Gmail, Trello, Obsidian, and more. Every day, every channel.
- **Identify what matters** — Out of thousands of messages, surface the decisions, deadlines, and changes that affect your work
- **Connect across sources** — A Slack conversation + a Trello card + an email about the same project are linked automatically
- **Track decision evolution** — Not just what was decided, but what it replaced, what it builds on, and what it contradicts
- **Operate inside envelopes** — Gateway and worker calls carry signed scope boundaries and audit rows
- **Preserve provenance** — Memory writes can point back to source refs, model runs, tool traces, and envelope hashes
- **Search with evidence** — Strict and balanced modes reject vector-only noise unless lexical/entity/raw/seed evidence confirms the result
- **Compile actionable knowledge** — Raw conversations become structured wiki pages with priorities, gaps, and next steps
- **Brief you proactively** — When you start working, relevant context from all sources is already there

```
Without MAMA:  You read 5 Slack channels, 3 email threads, check Trello,
               re-read old PRs, then try to piece together the full picture.

With MAMA:     Agents already read everything. You get a briefing with
               what changed, what's at risk, and what needs your decision.
```

**This is what local AI agents should do** — read every channel, every thread, every document, every
day, then explain exactly which evidence they used and which permission boundary they were inside.

## How It Runs

MAMA OS executes AI agents as **official CLI subprocesses** — spawning `claude` or `codex` the same way you would in your terminal.

```
MAMA OS daemon
  └─ spawns: claude --session-id abc --system-prompt "..."
       └─ Claude Code CLI (your existing OAuth session)
            └─ Anthropic API (standard authenticated request)
```

This is the provider-sanctioned execution method. No API keys to manage, no token extraction, no header spoofing. Your existing CLI authentication is reused directly.

**Why this matters:** Some third-party agent frameworks access Claude via unofficial methods — extracting OAuth tokens, spoofing API headers, or bypassing rate limits. These approaches violate [Anthropic's Terms of Service](https://www.anthropic.com/policies/terms) and risk account suspension. MAMA OS doesn't do any of that. If `claude` or `codex` works in your terminal, MAMA OS works.

```bash
# Already have Claude Code?
claude auth status # If this shows loggedIn=true, you're ready
mama start         # MAMA uses your existing authentication
```

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
Connectors (15)              Gateways (4)
Slack, Gmail, Sheets...      Discord, Slack, Telegram, Chatwork
       |                            |
       v                            v
 3-Pass Extraction          Reactive Runtime Envelopes
 (Truth -> Hub -> Spoke)    scope, expiry, signature, audit
       |                            |
       +------------+---------------+
                    |
             MAMA Core (mama-memory.db)
             SQLite + 1024-dim embeddings
             memory, raw refs, model runs,
             tool traces, twin edges, packets
                    |
             +------+------+
             |             |
        Viewer UI     Claude Code Plugin / MCP
```

**Local-first.** All data stays on your device. No cloud. AI provider independent — works with Claude, Codex, or any future backend.

## Security

MAMA OS has full system access via the backend CLI — so security is foundational, not optional.

- **Local-only by default** — Binds to localhost. External access requires explicit tunnel + authentication.
- **Signed runtime envelopes** — Gateway and worker tool calls carry verifiable scope, expiry, and
  actor context before irreversible side effects are allowed.
- **Provenance ledger** — Memory writes, raw refs, model runs, and tool traces can be audited after
  the fact without exposing prompt bodies or hidden connector payloads.
- **5-layer prompt injection defense** — Output sanitization, channel trust boundaries, silent mode, bulk extraction limits. Built from a [real incident](docs/guides/security.md), not theory.
- **Intrusion detection & response** — Honeypot traps → immediate IP ban (15min). Auth failures → auto-ban after 5 attempts. Tarpit delays for suspicious IPs.
- **Agent permission tiers** — Tier 1 (full), Tier 2 (read-only), Tier 3 (scoped). Each agent gets only the tools it needs.
- **Fail-safe shutdown** — When an intrusion cannot be contained, MAMA shuts down gracefully rather than operating compromised.

See the full [Security Guide](docs/guides/security.md) for Cloudflare Zero Trust setup, token authentication, threat scenarios, and Code-Act sandbox isolation.

## Benchmark: LongMemEval

Tested on [LongMemEval](https://xiaowu0162.github.io/long-mem-eval/) — 500 questions across 6 types, ~115K tokens of conversation history per question.

| System      | Score     | Model      | Notes                        |
| ----------- | --------- | ---------- | ---------------------------- |
| Mastra      | 94.87%    | GPT-5-mini |                              |
| **MAMA OS** | **93.0%** | Sonnet 4.6 | Tool-use answer, 100Q sample |
| SuperMemory | 81.6%     | GPT-4o     |                              |
| Zep         | 71.2%     | GPT-4o     |                              |

MAMA outperforms SuperMemory while running **entirely locally** with open-source components.

## Packages

| Package                                          | Version | Description                                           |
| ------------------------------------------------ | ------- | ----------------------------------------------------- |
| [@jungjaehoon/mama-os](packages/standalone/)     | 0.19.1  | Always-on runtime, envelopes, connectors, worker APIs |
| [@jungjaehoon/mama-server](packages/mcp-server/) | 1.13.0  | MCP server for Claude Desktop/Code                    |
| [@jungjaehoon/mama-core](packages/mama-core/)    | 1.5.0   | Core memory, provenance, raw refs, graph, embeddings  |
| [mama plugin](packages/claude-code-plugin/)      | 1.9.0   | Claude Code plugin (marketplace)                      |
| [memorybench](packages/memorybench/)             | 1.0.0   | Memory retrieval benchmarking framework               |

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
claude auth login   # or: codex login
npx @jungjaehoon/mama-os init
mama start   # starts daemon at localhost:3847
```

Web viewer at `http://localhost:3847/viewer`. The current Viewer ships `Dashboard`, `Memory`,
`Feed`, `Wiki`, `Agents`, `Logs`, and `Settings`; chat opens from the floating shell instead of a
dedicated tab. Connects to Discord, Slack, Telegram.

> **Requires:** [Claude Code CLI](https://claude.ai/claude-code) or [Codex CLI](https://www.npmjs.com/package/@openai/codex) installed and authenticated. Node.js >= 22.13.0.

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
- **Search:** Hybrid retrieval — FTS5 BM25 (lexical) + cosine similarity (semantic) + RRF fusion, with strict modes and diagnostics for vector-noise debugging
- **Runtime boundary:** Signed reactive envelopes with scope snapshots, expiry, and mismatch audit rows
- **Provenance:** Compact source refs, model runs, tool traces, twin edges, and worker situation packets
- **Extraction:** Sonnet for structured fact extraction from conversations
- **Transport:** CLI subprocess (Claude/Codex) — officially supported, ToS compliant

## What Works Today

Anyone who installs MAMA OS and connects their apps gets:

- **Automatic knowledge extraction** — Connectors poll 15 sources, AI extracts decisions/deadlines/changes without manual input
- **Cross-source search** — "What did we decide about X?" searches Slack + email + code + docs simultaneously
- **Noise-resistant search** — Strict and balanced modes can reject vector-only matches and show why a result was included
- **Bounded agent calls** — Gateway and worker calls can be tied to runtime envelopes and audited for scope mismatches
- **Evidence provenance** — Memory rows can be traced to raw refs, model runs, tool traces, and trusted runtime context
- **Worker context APIs** — Raw search, situation packets, graph/entity APIs, and twin edges give sub-agents structured evidence surfaces
- **Decision evolution tracking** — Not just what was decided, but what it replaced and why
- **Proactive briefings** — Dashboard agent compiles what changed across all sources
- **Wiki compilation** — Knowledge agents organize raw conversations into structured Obsidian pages
- **93% retrieval accuracy** — Proven on LongMemEval benchmark against 115K-token conversation histories

## Roadmap

| Phase    | Version | Focus                                                                                                                                                |
| -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Done** | v0.15   | Search quality overhaul, FTS5, evolution engine (58% -> 88%)                                                                                         |
| **Done** | v0.16   | `event_date` API, tool-use answer, memory agent v5 (88% -> 93%)                                                                                      |
| **Done** | v0.17   | Connector framework (15 connectors), truth-first 3-pass extraction                                                                                   |
| **Done** | v0.18   | Output layer: knowledge agents, viewer redesign, security hardening                                                                                  |
| **Done** | v0.19   | Agent-management foundation: viewer-aware frontdoor, validation UI, activity telemetry, conductor isolation                                          |
| **Now**  | v0.20   | M1-M6 runtime foundation: envelopes, model/tool trace ledger, raw/situation/graph worker APIs, strict search diagnostics, process cleanup            |
| **Next** | v0.21   | Context Compile V0: append-only `context_packets`, deterministic compiler, `context_compile` tool/API, and downstream `context_packet_id` provenance |
|          | Later   | Report composer, packet retention policy, search-quality feedback loops, browser onboarding for non-developers, and domain extraction templates      |
|          | v1.0    | Team mode: shared scoped knowledge graph for organizations. General release                                                                          |

## Development

```bash
git clone https://github.com/jungjaehoon-lifegamez/MAMA.git
cd MAMA && pnpm install && pnpm build
pnpm test     # 3000+ tests across all packages
```

See [CLAUDE.md](CLAUDE.md) for development guidelines.

_Last updated: 2026-04-30_

## License

MIT
