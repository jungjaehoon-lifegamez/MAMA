# MAMA OS - A Local Operator That Watches, Acts, and Shows Its Work

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![LongMemEval 100Q](https://img.shields.io/badge/LongMemEval%20100Q-93%25-blue)](packages/memorybench/)
[![Tests](https://img.shields.io/badge/tests-4958%20passing-success)](https://github.com/jungjaehoon-lifegamez/MAMA)

> A daemon that reads your work channels, decides on its own when something matters, acts on it,
> and keeps a record of what it changed and why.

MAMA OS runs in the background on your machine. It reads the places your work actually happens —
Slack, Telegram, Gmail, Trello, your Obsidian vault — and does three things with what it finds:
remembers it, reports on it, and acts on it.

The part that surprises people is that most of this happens when nobody is talking to it. On a
recent 75-minute sample of the live daemon, 8 of 114 lane operations came from a human conversation.
The other 106 were the system deciding for itself: firing a trigger it wrote earlier, publishing a
report, reconciling a board, promoting a durable judgment into memory.

That makes accountability the point rather than a feature. Every durable change the system makes is
recorded with the batch of events that caused it — or explicitly marked as having no known cause. A
database constraint makes it impossible to store a change that claims a cause it does not have.

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
  required, decisions, pipeline) rendered live over SSE, a Triggers tab showing the loop's own
  library, and a native Tasks surface backed by the task ledger. Tasks display workflow status and
  temporal state separately, so an overdue item is never silently treated as blocked or complete.
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

## Evidence and Effects

A system that changes things on your behalf should be able to say what caused each change — or say
plainly that it cannot. MAMA OS records that in one place, with the numerator and denominator of
coverage kept inseparable.

- **Effect ledger** — one table, `evidence_effects`. A database CHECK forbids both "attributed with
  no cause" and "unattributed with a cause", and a trigger rejects unusable cause ids. There is no
  shape in which a change can quietly lose its provenance.
- **Bounded runs** — a run is `{channel, delta batch}`. The batch the host handed the run becomes the
  cause of everything that run changes; the agent never restates it, and a host batch always beats an
  agent-supplied source id, which is forgeable. When the host handed the run no batch, a named source
  event is still used — weaker evidence, not worthless. Only when there is neither is the change
  marked unattributed, which is the honest answer rather than a plausible-looking one.
- **`changes_read`** — what this system durably changed since a given point, with coverage counts.
  The full report leads with it.
- **`mama_provenance`** — what a memory rests on. A citation must not out-read reading: the same
  channel grant bounds both.
- **Channel grant** — one rule decides which `(connector, channel)` pairs a run may read, compiled
  both to a boolean and to a SQL clause that a differential test pins against each other.
- **Lane verification** — a work order reaching `done` proves only that the agent replied. Each
  lane's claim is reconciled against completed tool traces since a run-bound snapshot. It observes
  and reports; it never blocks. Where a tool cannot distinguish a read from a write, the verdict says
  so rather than claiming more than it knows.

## What You Actually Get

Written plainly, and split by how much you choose to run. Nothing below is aspirational — the
"someday" version lives in the Roadmap.

### If you install the Claude Code plugin (smallest step)

Your coding decisions get written down without you doing it, and come back when they matter. When
you later read a file that a past decision touched, the reasoning shows up in your session. You can
search it with `/mama:search`. There is no daemon and no background process — just hooks and slash
commands.

### If you run the daemon (the real thing)

**It reads your channels so you don't re-read them.** Fourteen connectors poll Slack, Telegram,
Gmail, Trello, Sheets, Obsidian and more. Conversations get turned into decisions, deadlines and
changes automatically. You do not tag anything.

**It tells you what changed, without being asked.** Reports go out on a schedule — briefing, what
needs action, decisions made, pipeline. They are not a query result you went and fetched. Nobody
asked for the 8am report; it arrives because the system decided the day had started.

**It notices recurring situations and writes its own rules for them.** When the same kind of message
keeps showing up, the agent writes a trigger for it — keywords, what to recall, what to do — and
fires it on future messages. You did not configure that trigger. Being honest about the rate: most
authoring passes produce nothing, because a duplicate gate rejects near-variants of triggers that
already exist.

**Answers come with their sources attached.** A memory can be traced back to the raw message it came
from. Search runs in a strict mode that rejects a semantic match with no lexical or entity evidence
behind it — so a plausible-sounding wrong answer gets dropped instead of shown.

**It keeps a record of what it changed, and admits when it can't explain one.** This is the part
most agent systems skip. Every durable change is stored with the batch of events that caused it. If
the system cannot name a cause, the change is stored as _unattributed_ rather than given a
plausible-looking one. A database constraint makes the dishonest version unstorable.

**It cannot quietly send things on your behalf.** An agent can draft a customer message from the
evidence. Sending it requires the active envelope to permit that destination. Memory writes refuse
content that looks like a secret.

**Your data does not leave the machine.** SQLite on local disk, embeddings computed locally. The
only network calls are to the AI provider you already authenticated with, through the official
`claude` or `codex` CLI.

### What it is not

- Not a chatbot with a good memory. It runs when nobody is talking to it.
- Not a memory database. Storage is the input; cited reports are the output.
- Not a hosted service. There is no account, no cloud, no upload.

## Where It Is Headed (not what it does today)

Everything above this line is running now. Everything below is the direction, written as a scenario
so the gap is visible rather than blurred.

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

## The Surfaces You Look At

**The operator board at `http://localhost:3847/ui`** is where the system talks to you: four slots the
agent publishes into — briefing, what needs action, decisions, pipeline — updating live over SSE,
plus a Triggers tab showing the rules the loop wrote for itself, and a Tasks view backed by the task
ledger. Tasks show workflow status and time status separately, so an overdue item is never silently
displayed as blocked or done.

**The legacy viewer at `/viewer`** is still there — `Dashboard`, `Memory`, `Feed`, `Wiki`, `Agents`,
`Logs`, `Settings`, and a chat shell — for looking directly at the stored record.

**Your chat app** is the third surface, and the one you will use most. Reports arrive in Discord,
Slack or Telegram without you opening anything. In an allowlisted 1:1 Telegram DM you get the owner
console, which is the same system with a wider set of permissions.

```text
Without MAMA:  The agent sees fragments. You still reconstruct the board.

With MAMA:     The agent gets bounded evidence surfaces. You get the
               raw material for cited briefings and safer next actions.
```

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
Connectors (14)              Gateways (3)
Slack, Gmail, Sheets...      Discord, Slack, Telegram
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
             Effect ledger (operator/triggers.db)
             every durable change, with the delta
             batch that caused it - or an explicit
             "unattributed"
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
- **Provenance ledger** — Memory writes, raw refs, model runs, and tool traces are recorded as they
  happen, and can be audited afterwards without exposing prompt bodies or connector payloads.
- **Evidence before action** — Reports carry their source refs and say what context was missing, so
  a human or a downstream worker sees the gaps before acting on the conclusion.
- **5-layer prompt injection defense** — Output sanitization, channel trust boundaries, silent mode, bulk extraction limits. Built from a [real incident](docs/guides/security.md), not theory.
- **Intrusion detection & response** — Honeypot traps → immediate IP ban (15min). Auth failures → auto-ban after 5 attempts. Tarpit delays for suspicious IPs.
- **Agent permission tiers** — Tier 1 gets full runtime tools, Tier 2 can write scoped
  memory, and Tier 3 stays strictly read-only. Each agent gets only the tools it needs.
- **Owner-console trust model (v0.22+)** — Telegram media and owner access require an explicit
  `allowed_chats` allowlist (text-only open mode warns loudly at boot); the `owner_console` role is
  granted only in an allowlisted chat's 1:1 DM. That verified owner may compose Drive operations
  against the folder selected in the active request. Non-owner Drive operations remain limited to
  role-permitted tools and configured connector/envelope scope; they cannot select arbitrary roots.
  Supplied destination capabilities remain validated, and uploads can read only private MAMA
  workspace files. Memory writes refuse secret-shaped content, and Telegram forwarded messages,
  forwarded-image analysis, and Drive-derived Code-Act output are wrapped as untrusted at their
  model boundaries.
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

Five packages, and they are not five versions of the same thing. Pick by what you want to run.

| Package                                          | Version | What it is                                                                                                                                                                              | Do you run it?            |
| ------------------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| [@jungjaehoon/mama-os](packages/standalone/)     | 0.29.2  | **The daemon.** 92k lines: connectors, gateways, the trigger loop, the workorder pipeline, the effect ledger, the web UI. When people say "MAMA", this is almost always what they mean. | Yes — `mama start`        |
| [@jungjaehoon/mama-core](packages/mama-core/)    | 2.0.0   | **The library underneath.** 35k lines of memory, provenance, graph, and embeddings. It depends on nothing else in this repo, and the other three all import it.                         | No — it has no binary     |
| [@jungjaehoon/mama-server](packages/mcp-server/) | 1.15.0  | **A thin MCP adapter**, 3.7k lines over two dependencies. It exposes the core library to Claude Desktop or any MCP client. Deliberately small: it holds no logic of its own.            | Only as an MCP server     |
| [mama plugin](packages/claude-code-plugin/)      | 1.11.0  | **Hooks and slash commands for Claude Code** — 5k lines of hook scripts plus 2k lines of markdown commands. No daemon, no background process.                                           | Installed, not run        |
| [memorybench](packages/memorybench/)             | 1.0.0   | **A benchmark harness**, not part of the product. It exists so retrieval-quality claims can be checked rather than asserted.                                                            | Only to reproduce a score |

The dependency direction is one-way: `mama-core` sits at the bottom, and the daemon, the MCP
server, and the plugin all build on it. Nothing depends on the daemon.

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

## Roadmap

| Phase    | Version | Focus                                                                                                                                                                                                                                                                                |
| -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Done** | v0.15   | Search quality overhaul, FTS5, evolution engine (58% -> 88%)                                                                                                                                                                                                                         |
| **Done** | v0.16   | `event_date` API, tool-use answer, memory agent v5 (88% -> 93%)                                                                                                                                                                                                                      |
| **Done** | v0.17   | Connector framework (13 connectors at the time), truth-first 3-pass extraction                                                                                                                                                                                                       |
| **Done** | v0.18   | Output layer: knowledge agents, viewer redesign, security hardening                                                                                                                                                                                                                  |
| **Done** | v0.19   | Agent-management foundation: viewer-aware frontdoor, validation UI, activity telemetry, conductor isolation                                                                                                                                                                          |
| **Done** | v0.20.1 | M1-M6 runtime foundation plus Context Compile V0: envelopes, model/tool trace ledger, raw/situation/graph worker APIs, strict search diagnostics, append-only `context_packets`, `context_compile`, and downstream `context_packet_id` provenance                                    |
| **Done** | v0.21   | The operator runtime: self-evolving trigger loop with a citation success circuit, `/ui` operator board (four live report slots + trigger library), task-truth from the real task ledger, wiki v5 daily journal + lessons, scheduled memory promotion, self-auditing with alert dedup |
| **Done** | v0.23   | The owner console + workorder ownership: trust-conditional `owner_console` role, artifact-hub tools, secret-safe memory writes, and the Stage-2 durable workorder pipeline                                                                                                           |
| **Done** | v0.24   | Codex app-server parity: durable multiplexed threads, native MAMA host tools (including connector/Trello surfaces), role-scoped Code-Act, strict managed runtime isolation, and automatic migration from the legacy `codex-mcp` backend                                              |
| **Done** | v0.25   | Verified temporal owner-task reconciliation with source-bound evidence, authoritative receipts, mixed-version safety, and bounded shutdown handling                                                                                                                                  |
| **Done** | v0.26   | Telegram media conversations, owner-scoped Drive operations, and fail-closed media handling                                                                                                                                                                                          |
| **Done** | v0.27   | Composable owner workflows, local document and image processing, and durable Telegram delivery                                                                                                                                                                                       |
| **Done** | v0.28   | Agent-owned owner-console operating brief, per-call session keys, and deletion of the legacy persona run path                                                                                                                                                                        |
| **Now**  | v0.29   | Evidence and effects: an effect ledger where every durable change names its cause or admits it has none, bounded runs, `changes_read` and `mama_provenance`, one channel-grant rule pinned by a differential test, and lane verification that observes without blocking              |
|          | Later   | Cross-language retrieval hardening, domain extraction templates, cross-worker packet analytics, and team-scoped context review workflows                                                                                                                                             |
|          | v1.0    | Team mode: shared scoped knowledge graph for organizations. General release                                                                                                                                                                                                          |

### What needs improving, measured

These are not guesses about what might be nice. Each one is a number taken off the running system,
and each is a direction the next releases have to move.

**Context churn is the largest cost lever.** Measured against a comparable operator running the same
CLI on the same machine, MAMA re-reads a cached context 15.9 times before rebuilding it; the other
system reaches 144.8. MAMA spends 3.4x more on cache creation while doing 2.6x fewer cache reads.
The stateless-run design bought correctness and is charging for it here. Closing part of that gap is
worth more than any other single optimisation.

**The system watches your channels better than it watches itself.** The trigger-authoring step died
on every attempt for three days before anyone noticed, because the failure recorded a 240 KB command
line and no cause. That is now fixed, but the general problem is not: an autonomous process needs a
health surface that makes its own silence loud.

**Most authoring passes produce nothing.** Across 705 recorded passes, 84% created zero triggers —
the duplicate gate rejects near-variants of what already exists. That gate is correct and stops the
library filling with noise, but a self-evolving loop that is idle five times out of six has room
either to propose better or to say why it declined.

**Attribution coverage is thin where it matters most.** In a recent window, 3 of 18 recorded changes
carried a cause. The split is honest — most runs are autonomous and have no owner message to cite —
but "honestly unattributed" is a floor to build up from, not a resting place. Work orders already
carry a batch; the autonomous lanes that do the bulk of the work mostly do not.

**Removed surfaces should stay removed.** Two shipped APIs turned out to be permanently empty: a
delegations endpoint reading a table nothing wrote, and a registered `delegate` tool with no
executor. Both are gone. The lesson worth keeping is the test that would have caught them — a
surface that can only ever answer "nothing" should fail a build, not a user.

## Development

```bash
git clone https://github.com/jungjaehoon-lifegamez/MAMA.git
cd MAMA && pnpm install && pnpm build
pnpm test     # 4,958 tests across all packages
```

See [CLAUDE.md](CLAUDE.md) for development guidelines.

_Last updated: 2026-07-30_

## License

MIT
