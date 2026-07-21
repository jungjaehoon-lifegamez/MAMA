# MAMA OS - Local Operating Memory for AI Agents

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![LongMemEval 100Q](https://img.shields.io/badge/LongMemEval%20100Q-93%25-blue)](packages/memorybench/)
[![Tests](https://img.shields.io/badge/tests-3000%2B%20passing-success)](https://github.com/jungjaehoon-lifegamez/MAMA)

> Local operating memory that lets AI agents read the board, cite the evidence, and stay inside
> explicit boundaries.

MAMA OS connects chats, docs, decisions, and work logs into a local memory substrate. Agents can use
it to search raw evidence, follow relationships, inspect timelines, and produce better briefings
instead of guessing from a short prompt.

This release ships the foundation: raw search/window APIs, graph/entity/timeline APIs, situation
packets, trusted provenance, model/tool traces, strict search diagnostics, runtime envelopes, and
Context Compile V0. `context_compile` turns those pieces into one selected/rejected/missing
evidence packet for a task, and `mama_save` can attach that packet through trusted
`context_packet_id` provenance.

## The Operator Runtime

The living center of MAMA OS is the **trigger loop**: an agent that authors its own triggers from
recurring situations in your channels, fires them on future messages to recall the right memory,
and folds everything into owner situation reports. The loop evolves itself — a review pass retires
noisy triggers, and delivered reports that cite a fired trigger feed a success signal back into
that trigger's stats.

What runs continuously today:

- **Trigger loop** — agent-authored triggers (keywords + memory query + procedure), deterministic
  fire → recall → report, near-duplicate authoring gate, citation-based success circuit.
- **Operator board at `/ui`** — a React viewer with four agent-published slots (briefing, action
  required, decisions, pipeline) rendered live over SSE, plus a Triggers tab showing the loop's
  own library. Task state comes from the real task ledger, never guessed from chat.
- **Memory promotion** — every 6 hours a curation pass promotes durable judgments (pricing rules,
  standing client preferences, process rules) from recent channel data into decisions. Task states
  never become memories; the board owns those.
- **Wiki compilation** — promoted decisions chain into an Obsidian wiki organized as an
  append-only daily journal (`daily/YYYY-MM-DD.md`) plus lesson pages
  (`lessons/clients|process|system`) that strengthen with evidence and get superseded, never
  deleted.
- **Hourly self-audit** — a conductor pass checks process health, databases, config, and security
  posture, deduplicating alerts against a state file so the owner hears about a finding once, not
  every hour.

## Target Workflow

MAMA is being built toward a local memory twin that agents can inspect, cite, and act on inside
explicit permission boundaries.

Ask:

> "Is Project A at risk right now?"

A search tool finds messages containing "Project A." A MAMA-backed agent reads the board:

1. The customer said the schedule was fine in email.
2. The internal owner changed twice in Slack.
3. The core PR is still waiting for review.
4. The QA checklist is not closed.
5. The same customer changed demo scope at the last minute last month.

A mature MAMA-backed agent should be able to report:

- **Judgment:** schedule risk is high.
- **Evidence:** demo request, review-blocked PR, owner changes, unfinished QA, prior scope-change
  pattern.
- **Inference:** the customer has not complained yet, but delivery risk is accumulating before the
  demo.
- **Missing context:** demo scope is not confirmed.
- **Risk forecast:** if review and demo scope do not close today, Friday may turn into a
  renegotiation.
- **Next move:** assign a PR reviewer, confirm demo scope with the customer, shrink QA to the
  release-critical path.
- **Permission boundary:** external sending is not allowed, so the agent drafts the message and
  records the report instead of contacting the customer.

That is the product direction: not another search box, but the substrate for an extra
analyst-operator that can read the company record, separate evidence from inference, forecast the
next risk, and only act inside the scope it was given.

## Why This Matters

Agents are useful when they can simulate. AlphaGo read the board before choosing the next move. Work
agents need the same thing: enough context to reconstruct what happened, infer what may matter, and
compare possible next actions.

Most agents never see that board. They see a prompt, a few files, or one search result. MAMA's job is
to make the board visible.

## North Star

MAMA OS is moving toward a company memory twin: an append-only substrate of raw records, memories,
entities, cases, reports, edges, and provenance that strong agents can inspect, simulate, and cite.

That North Star has three parts:

- **Twin substrate** — preserve raw evidence, time, scope, provenance, and edges so future
  models can reinterpret the same company history.
- **Agent ergonomics** — give workers bounded tools, runtime envelopes, fan-out search,
  situation packets, and query-conditioned context compilation.
- **Reports as deliverables** — turn evidence into cited reports and briefings for humans;
  memory rows are infrastructure, not the final product.

This release is the runtime foundation for that direction. It ships envelope, provenance,
worker-context, strict-search, and Context Compile building blocks, including append-only
context packets and downstream `context_packet_id` save provenance.

## What MAMA OS Does

MAMA OS is a local daemon that connects to your apps, reads continuously, and turns scattered records
into scoped, auditable operating memory for agents and humans.

The **operator board at `/ui`** is the primary live surface: four agent-published report slots
(briefing, action required, decisions, pipeline) updating over SSE, plus the trigger library. The
legacy viewer at `/viewer` remains available with `Dashboard`, `Memory`, `Feed`, `Wiki`, `Agents`,
`Logs`, and `Settings` tabs and a global chat shell.

**Current building blocks and direction:**

- **Read connected sources** — 15 connectors poll Slack, Gmail, Trello, Obsidian, and more
- **Reconstruct timelines** — Show raw, memory, case, entity, and edge events in order
- **Build the relationship graph** — Link people, projects, customers, channels, documents, PRs, and decisions across sources
- **Surface risk signals** — Highlight stale coverage, blocked cases, low-confidence memories, open questions, and conflicting evidence candidates
- **Track decision evolution** — Not just what was decided, but what it replaced, what it builds on, and what it contradicts
- **Operate inside envelopes** — Gateway and worker calls carry a signed envelope hash, scope boundaries, and destination limits enforced before each tool call
- **Preserve provenance** — Memory writes can point back to source refs, model runs, tool traces, and envelope hashes
- **Search with evidence** — Strict and balanced modes reject vector-only noise unless lexical/entity/raw/seed evidence confirms the result
- **Organize actionable knowledge** — Raw conversations become structured wiki pages and situation summaries with priorities, gaps, and next steps
- **Prepare briefings** — Dashboard, wiki, and situation agents can summarize visible context for humans and workers

```text
Without MAMA:  The agent sees fragments. You still reconstruct the board.

With MAMA:     The agent gets bounded evidence surfaces. You get the
               raw material for cited briefings and safer next actions.
```

This is the direction for local AI agents: read connected evidence continuously, then explain which
sources they used, what may still be missing, and which permission boundary they were inside.

## How It Runs

MAMA OS executes AI agents as **official CLI subprocesses** — spawning `claude` or `codex` the same way you would in your terminal.

```
MAMA OS daemon
  └─ spawns: claude … / codex …   (your official agent CLI)
       └─ Claude Code or Codex CLI (your existing OAuth session)
            └─ Provider API (standard authenticated request)
```

This is the provider-sanctioned execution method. No API keys to manage, no token extraction, no header spoofing. Your existing CLI authentication is reused directly.

**Why this matters:** Some third-party agent frameworks reach these providers via unofficial methods — extracting OAuth tokens, spoofing API headers, or bypassing rate limits. Those approaches violate provider Terms of Service (e.g. [Anthropic's](https://www.anthropic.com/policies/terms) or [OpenAI's](https://openai.com/policies/terms-of-use)) and risk account suspension. MAMA OS doesn't do any of that. If `claude` or `codex` works in your terminal, MAMA OS works.

```bash
# Already have Claude Code or Codex?
claude auth status   # or: codex login — if authenticated, you're ready
mama start           # MAMA reuses your existing CLI authentication
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
             tool traces, twin edges,
             worker packets, context packets
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
- **Destination limits** — An agent can draft a customer message from evidence, but cannot send it
  unless the active envelope explicitly allows that destination.
- **Provenance ledger** — Memory writes, raw refs, model runs, and tool traces can be audited after
  the fact without exposing prompt bodies or hidden connector payloads.
- **Evidence before action** — Agent outputs can carry raw source refs, model/tool traces, and
  missing-context caveats before a human or downstream worker acts on them.
- **5-layer prompt injection defense** — Output sanitization, channel trust boundaries, silent mode, bulk extraction limits. Built from a [real incident](docs/guides/security.md), not theory.
- **Intrusion detection & response** — Honeypot traps → immediate IP ban (15min). Auth failures → auto-ban after 5 attempts. Tarpit delays for suspicious IPs.
- **Agent permission tiers** — Tier 1 gets full runtime tools, Tier 2 can write scoped
  memory, and Tier 3 stays strictly read-only. Each agent gets only the tools it needs.
- **Owner-console trust model (v0.22+)** — Telegram inbound requires an explicit `allowed_chats`
  allowlist (boot warns loudly when open); the `owner_console` role is granted only in an
  allowlisted chat's 1:1 DM, memory writes refuse secret-shaped content, and forwarded/third-party
  text is wrapped as untrusted before it reaches any prompt.
- **Fail-safe shutdown** — When an intrusion cannot be contained, MAMA shuts down gracefully rather than operating compromised.

See the full [Security Guide](docs/guides/security.md) for Cloudflare Zero Trust setup, token authentication, threat scenarios, and Code-Act sandbox isolation.

## Benchmark: LongMemEval

Benchmark context: [LongMemEval](https://xiaowu0162.github.io/long-mem-eval/) has 500 questions
across 6 types, with ~115K tokens of conversation history per question. The current MAMA result is
a 100-question tool-use sample.

| System      | Score     | Model      | Notes                        |
| ----------- | --------- | ---------- | ---------------------------- |
| Mastra      | 94.87%    | GPT-5-mini |                              |
| **MAMA OS** | **93.0%** | Sonnet 4.6 | Tool-use answer, 100Q sample |
| SuperMemory | 81.6%     | GPT-4o     |                              |
| Zep         | 71.2%     | GPT-4o     |                              |

On that sampled run, MAMA lands above SuperMemory while running **entirely locally** with
open-source components.

## Packages

| Package                                          | Version | Description                                           |
| ------------------------------------------------ | ------- | ----------------------------------------------------- |
| [@jungjaehoon/mama-os](packages/standalone/)     | 0.24.0  | Always-on runtime, envelopes, connectors, worker APIs |
| [@jungjaehoon/mama-server](packages/mcp-server/) | 1.14.0  | MCP server for Claude Desktop/Code and any MCP client |
| [@jungjaehoon/mama-core](packages/mama-core/)    | 1.9.0   | Core memory, provenance, raw refs, graph, embeddings  |
| [mama plugin](packages/claude-code-plugin/)      | 1.10.0  | Claude Code plugin (marketplace)                      |
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

Operator board at `http://localhost:3847/ui` (agent-published report slots + trigger library);
legacy viewer at `http://localhost:3847/viewer` with `Dashboard`, `Memory`, `Feed`, `Wiki`,
`Agents`, `Logs`, and `Settings` tabs. Connects to Discord, Slack, Telegram.

> **Requires:** [Claude Code CLI](https://claude.ai/claude-code) or [Codex CLI](https://www.npmjs.com/package/@openai/codex) installed and authenticated. Node.js >= 22.13.0.

### MCP Server (Claude Desktop / any MCP client)

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
- **Runtime boundary:** Signed reactive envelopes (HMAC over scope, expiry, actor) checked by an enforcer that rejects out-of-scope destinations, connectors, or tier mismatches
- **Provenance:** Compact source refs, model runs, tool traces, twin edges, worker situation
  packets, and context packets
- **Context compiler:** Context Compile V0 turns broad search candidates into
  selected/rejected/missing evidence packets with trusted `context_packet_id` provenance
- **Extraction:** structured fact extraction from conversations via the configured model backend (default Sonnet; Codex/GPT models also supported)
- **Transport:** CLI subprocess (Claude/Codex) — officially supported, ToS compliant

## What Works Today

Anyone who installs MAMA OS and connects their apps gets:

- **Automatic knowledge extraction** — Connectors poll 15 sources, AI extracts decisions/deadlines/changes without manual input
- **Cross-source evidence reads** — "What happened with X?" can pull from connected raw sources and decisions together
- **Noise-resistant search** — Strict and balanced modes can reject vector-only matches and show why a result was included
- **Bounded agent calls** — Gateway and worker calls can be tied to runtime envelopes and audited for scope or destination mismatches
- **Evidence provenance** — Memory rows can be traced to raw refs, model runs, tool traces, and trusted runtime context
- **Worker context APIs** — Raw search, situation packets, graph/entity APIs, and twin edges give sub-agents structured evidence surfaces
- **Task-scoped context packets** — `context_compile` selects, rejects, and explains evidence
  for a specific task before a worker saves memory or composes a report
- **Decision evolution tracking** — Not just what was decided, but what it replaced, contradicted, and depended on
- **Situation briefings** — Dashboard and situation agents summarize what changed, what is stale, and what needs attention
- **Wiki organization** — The wiki agent keeps an Obsidian vault as an append-only daily journal plus durable lesson pages, compiled from promoted decisions
- **93% retrieval accuracy** — 100-question LongMemEval tool-use sample against long conversation histories

`mama_search` remains the broad candidate retriever. `context_compile` is now the task-shaped layer
that selects, rejects, and explains evidence before a worker writes memory or composes a report.

## Roadmap

| Phase    | Version | Focus                                                                                                                                                                                                                                                                                |
| -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Done** | v0.15   | Search quality overhaul, FTS5, evolution engine (58% -> 88%)                                                                                                                                                                                                                         |
| **Done** | v0.16   | `event_date` API, tool-use answer, memory agent v5 (88% -> 93%)                                                                                                                                                                                                                      |
| **Done** | v0.17   | Connector framework (15 connectors), truth-first 3-pass extraction                                                                                                                                                                                                                   |
| **Done** | v0.18   | Output layer: knowledge agents, viewer redesign, security hardening                                                                                                                                                                                                                  |
| **Done** | v0.19   | Agent-management foundation: viewer-aware frontdoor, validation UI, activity telemetry, conductor isolation                                                                                                                                                                          |
| **Done** | v0.20.1 | M1-M6 runtime foundation plus Context Compile V0: envelopes, model/tool trace ledger, raw/situation/graph worker APIs, strict search diagnostics, append-only `context_packets`, `context_compile`, and downstream `context_packet_id` provenance                                    |
| **Done** | v0.21   | The operator runtime: self-evolving trigger loop with a citation success circuit, `/ui` operator board (four live report slots + trigger library), task-truth from the real task ledger, wiki v5 daily journal + lessons, scheduled memory promotion, self-auditing with alert dedup |
| **Done** | v0.23   | The owner console + workorder ownership: trust-conditional `owner_console` role, artifact-hub tools, secret-safe memory writes, and the Stage-2 durable workorder pipeline                                                                                                           |
| **Now**  | v0.24   | Codex app-server parity: durable multiplexed threads, native MAMA host tools (including connector/Trello surfaces), role-scoped Code-Act, strict managed runtime isolation, and automatic migration from the legacy `codex-mcp` backend                                              |
|          | Later   | Cross-language retrieval hardening, domain extraction templates, cross-worker packet analytics, and team-scoped context review workflows                                                                                                                                             |
|          | v1.0    | Team mode: shared scoped knowledge graph for organizations. General release                                                                                                                                                                                                          |

## Development

```bash
git clone https://github.com/jungjaehoon-lifegamez/MAMA.git
cd MAMA && pnpm install && pnpm build
pnpm test     # 3000+ tests across all packages
```

See [CLAUDE.md](CLAUDE.md) for development guidelines.

_Last updated: 2026-07-21_

## License

MIT
