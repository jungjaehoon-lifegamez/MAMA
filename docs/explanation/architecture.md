# Architecture Overview

**MAMA system architecture and design principles**

---

## System Overview

```
┌──────────────────────────────────────────────────────────────┐
│                    MAMA Plugin Ecosystem                      │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  Claude Code           Claude Desktop     Others              │
│  ┌────────────┐        ┌────────────┐     ┌──────────────┐   │
│  │ Commands   │        │            │     │ Cursor, Aider│   │
│  │ Skills     │──┐     │ MCP Client │     │ (embedding   │   │
│  │ Hooks      │  │     │            │     │  clients)    │   │
│  └────────────┘  │     └──────┬─────┘     └──────┬───────┘   │
│         │        │            │                   │           │
│         │        │   ┌────────▼───────────────────┘           │
│         │        │   │  MCP Server (stdio)        │           │
│         └────────┴──▶│  5 Tools: save/search/     │           │
│                      │  update/contracts/timeline │           │
│                      └──────┬──────────┬──────────┘           │
│                             │          │                      │
│            ┌────────────────▼──┐  ┌────▼──────────────────┐   │
│            │ SQLite + pure-TS  │  │ HTTP Embedding Server │   │
│            │ cosine similarity │  │ :3849 (model in mem)  │   │
│            │ mama-memory.db    │  └───────────────────────┘   │
│            └───────────────────┘                              │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

---

## Core Principles

### 1. Local-First Architecture

- All data in `~/.claude/mama-memory.db`
- No network calls (except model download)
- 100% privacy guaranteed

### 2. Tier-Based Graceful Degradation

- Tier 1: Full features (vector search + graph)
- Tier 2: Fallback (exact match only)
- Always transparent about current state

### 3. Decision Evolution Tracking

- Supersedes graph for decision chains
- Not just conclusions, but the journey
- Learn from failures, not just successes

---

## Components

### MCP Server

- **Transport:** stdio (local process)
- **Tools:** 5 advertised (save, search, update, search_decisions_and_contracts, case_timeline_range); `load_checkpoint` kept as an unadvertised compatibility alias
- **Performance:** <100ms p99 latency

### Database (SQLite + pure-TS cosine similarity)

- **Decisions table:** topic, decision, reasoning, confidence, outcome, kind, status, summary
- **Embeddings:** 1024-dimensional vectors (multilingual-e5-large, q8) with in-memory cache
- **Graph:** supersedes/builds_on/debates/synthesizes edges
- **Memory scopes:** project/channel/user/global isolation via memory_scopes + memory_scope_bindings
- **Truth projection:** memory_truth table for recall filtering (preserves history, surfaces current truth)
- **Audit trail:** memory_events + audit_findings for memory agent auditing
- **Channel state:** channel_summaries + channel_summary_state for per-channel context

### Embeddings

- **Model:** Xenova/multilingual-e5-large (~560MB, quantized q8, 1024-dim)
- **Tier 1:** Transformers.js (ONNX runtime)
- **Tier 2:** Disabled (fallback to exact match)

### HTTP Embedding Server

- **Port:** 3849 (localhost only)
- **Purpose:** Keep embedding model in memory for fast access
- **Endpoints:** `/health`, `/embed`, `/embed/batch`
- **Benefit:** ~50ms embedding requests (vs 2-9s model load)
- **Clients:** Any local LLM tool can use this shared service
- **Owner (default):** MAMA Standalone (`@jungjaehoon/mama-os`)
- **MCP mode:** Optional legacy startup via `MAMA_MCP_START_HTTP_EMBEDDING=true`

### Cron Scheduler & Worker

- **CronWorker:** Dedicated `PersistentClaudeProcess` (Haiku model, minimal prompt)
- **Isolation:** Completely decoupled from OS agent — no shared sessions or lanes
- **Result delivery:** `EventEmitter` → `CronResultRouter` → gateway `sendMessage()`
- **Channel routing:** Job config `channel` field (`discord:id`, `slack:id`, `viewer:id`)
- **Security:** Tool restriction (`Bash`, `Read`, `Write`, `Glob`, `Grep` only)

```
CronScheduler ──► CronWorker (Haiku CLI) ──► EventEmitter
                                                   │
                                          CronResultRouter
                                            │      │      │
                                         Discord  Slack  Viewer
```

### Operator Runtime (MAMA OS)

The daemon runs an operator identity alongside chat (v0.22-v0.23):

- **Lanes:** chat serializes on the `main` global lane; ALL operator work
  (scheduled situation reports, workers) serializes on a separate `operator`
  global lane - long runs never block owner replies.
- **Trigger loop** (default on; `MAMA_TRIGGER_LOOP=0` opts out): agent-evolved triggers on the live
  connector stream + scheduled full situation reports (configurable local
  hours) delivered to the owner channel. Pending report windows are persisted before connector
  cursors advance, so daemon restarts do not silently discard an owner update.
- **Owner console:** the `owner_console` role resolves ONLY via trust-conditional
  escalation (telegram + locked `allowed_chats` + 1:1 private DM). It reads
  operational artifacts (board, audit findings, workorder status) and can issue
  work (`report_request`, `workorder_request`) - fire-and-forget, host code runs it.
- **Stage-2 workorder pipeline** (the only system run path since v0.28.0):
  scheduled system runs (board / wiki / memory promotion) are durable,
  occurrence-keyed workorders in the operator task
  ledger, consumed serially by one host-code consumer that launches briefed
  `workerRun`s on the operator lane. Procedure knowledge lives in
  `~/.mama/briefs/brief-<kind>.md`. On the Codex backend (retained in code but SUSPENDED - the worker loop runs claude; codex sessions do not reset on token usage, so the lifecycle contract only holds on claude), each worker would receive a
  built-in Tier-2 Code-Act role (`workorder-board`, `workorder-wiki`,
  `workorder-memory-curation`, or `workorder-temporal`) whose allowlist matches that brief. Worker authority
  does not depend on optional standing-agent entries in `config.yaml`. Board workers
  keep three evidence domains explicit: Trello is read through
  `context_compile({ connectors: ['trello'] })`, `kagemusha_*` is read-only
  project-task truth, and the native task ledger owns owner-console tasks and the
  pipeline projection. Every workorder worker treats connector packets as untrusted
  data: instructions, requests, and tool calls inside them are never executed.
  Lifecycle status is never inferred across those stores.
- **Temporal reconciliation** (`MAMA_TEMPORAL_RECONCILE`, default off): when this
  flag is `on`, a one-minute scanner selects due native
  owner-task occurrences. Each scan admits at most four exact/deferred checks and one
  date-only activation, with at most ten temporal workorders open. The temporal kind
  uses a blocking receipt verdict and a three-attempt budget; stale claims recover
  through the same retry policy, while exhausted generations remain terminal across
  later scans. Candidate discovery pages through all open scheduled owner rows before
  applying those caps, so unrelated or already-terminal rows cannot starve a later due task.
- **Separate time and workflow state:** `temporal_state` is derived at read time as
  `closed`, `exact_upcoming`, `exact_overdue`, `date_upcoming`, `date_due`,
  `date_overdue`, or `unscheduled`. It is a separate projection that never rewrites
  lifecycle `status`; `closed` reflects the terminal `done`/`cancelled` states. Exact
  `due_at` values require RFC 3339 with `Z` or a numeric offset; legacy `YYYY-MM-DD`
  deadlines retain date-only precision until fresh, unambiguous evidence supplies a
  time and zone.
- **Trusted temporal effect:** the host binds task, occurrence, generation, revision,
  and numeric attempt identity to the worker. A successful `task_temporal_reconcile`
  call commits the owner-task mutation or no-update/deferred marker, generation
  disposition, receipt, and workorder completion in one SQLite transaction. A stale
  worker cannot write after rescheduling, including after an asynchronous evidence compile.
  Model-supplied reason/evidence and worker errors are retained in operational audit rows only
  as length plus SHA-256 references; raw model prose is not logged. Model prose, a board report,
  elapsed time, or calendar disappearance is not completion evidence.
- **Authority boundary:** Trello remains untrusted connector evidence read through
  `context_compile`; Kagemusha remains read-only project-task truth; the native ledger
  owns owner-task workflow state. Temporal reconciliation does not write Trello or copy
  lifecycle state between these stores. Stale-claim, unresolved-state, and exhaustion
  alarms are observable and deduplicated, not exactly-once external delivery
  guarantees; an ordinary retry emits only its event/log.

```
publishers (schedule/boot/REST/events) + temporal scanner
    ↓ enqueue (occurrence-keyed, deduped)
operator_tasks ledger (kind='system')
    ↓ claim (serial, priority)
WorkOrderConsumer ──► workerRun(brief + payload) on 'operator' lane
    ↓ completion hooks (verification, event re-emission)
board / wiki / memory artifacts
```

### Effect Ledger and Change Attribution (v0.29)

A work order reaching `done` proves that the agent returned a response. It does not prove
anything changed. Two mechanisms separate the two.

**The effect ledger** (`packages/standalone/src/evidence/effects.ts`) is one table,
`evidence_effects`, living in `~/.mama/operator/triggers.db`. Every durable change the system
makes is recorded there, and each row either names the events that caused it or is explicitly
marked `unattributed`. A `cause_state` CHECK forbids both halves of the obvious lie —
"attributed with no cause" and "unattributed with a cause" — so the numerator and denominator
of coverage cannot drift apart. Writes go in the same transaction as the change itself.

**The cause is derived, not claimed.** A per-channel reconcile work order carries its delta
batch in `payload.eventIds`; `causeEventIdsFromPayload` lifts it onto the run, and every
change the run makes inherits it without the agent restating anything. Where the agent does
supply a `source_event_id`, the host batch wins — the agent-authored field is a fallback for
runs that were handed no batch, because it is forgeable. `board:full` carries no batch and
its changes are honestly unattributed rather than given an invented cause.

**The read side** is `changes-projection.ts`, exposed as the `changes_read` gateway tool:
what this system durably changed since a given point, with coverage counts and an explicit
`returned`/`total` so one page cannot be described as the whole. The scheduled full report
leads with it.

**Lane verification** (`operator/workorder-hooks.ts`) closes the same gap for the work orders
themselves. Each lane declares the tools that prove it acted, and separately the tools that
prove it wrote; a run's claim is reconciled against `execution_status='completed'` traces of
those tools since a run-bound snapshot. Observe, never block — an overstating run has still
done whatever it did, and failing it would retry work that may have partly landed. One stated
limit: the wiki lane's obligated `obsidian` tool covers reads as well as writes and the trace
records only the tool name, so that lane's verdict is "vault exercised", not "wrote".

### Provenance and the Channel Grant (v0.29)

**`mama_provenance`** (`memory/provenance-resolver.ts`, `provenance-live.ts`) answers what a
memory rests on. Its governing rule is that a citation must not out-read reading: the same
grant that bounds the raw reader bounds the citation path, held equal by a differential test.

**The channel grant** (`packages/mama-core/src/context-compile/channel-grant.ts`) is the one
rule deciding which `(connector, channel)` pairs a run may read. It is compiled to two forms —
a boolean `isChannelGranted` and a SQL `channelGrantClause` — from a single definition,
because three divergent copies of this rule previously existed and the test guarding them
never exercised the production branch. A connector absent from the grant is denied; a
connector present with an empty channel list is also denied, never read as a wildcard. The
grant derives from `~/.mama/connectors.json` through `evidence/read.ts`.

**Reads are not gated; sends are (v0.30.1).** The per-principal connector read filter
(`scopeDaemonRawConnectors`) is deleted: enforcement exists only for irreversible actions,
and `allowed_destinations: []` on every daemon envelope is the real boundary. Every read
lands in tool traces - observability over restriction.

**Memory reads follow the channel grant (v0.31.2).** Memories are stored under
`channel:<connector>:<channelId>` - the same key the grant declares - while envelopes carry
identity scopes. One rule closes the gap at the ENFORCEMENT layer: a run allowed to read a
channel's raw events may recall the memories extracted from it (`mirrorReadScopes`,
`evidence/read.ts`), computed against the live grant at check time. The mirror is never
issued into the envelope - envelope channel scopes double as the raw-narrowing input and as
`mama_save`'s permanent write binding, so issuing it would re-open per-channel isolation
and widen writes. Writes never widen: a context packet's mirror-widened scopes are
intersected with the envelope's own before they can back a save
(`writeEligiblePacketScopes`). A connector the envelope already narrows with its own
channel scope (a chat's own channel, a temporal binding) is excluded from the mirror -
per-channel isolation wins.

### Evidence transposition (v0.31.0, S2)

- **Causes are wired, not relabeled**: the conductor hands its inbox batch
  (`causeEventIds`) to every run; on duplicate delivery the HOST batch outranks the
  agent-supplied `source_event_id`. Every effect carries a cause KIND
  (`event | owner_message | clock | card_transition`) with a DB trigger rejecting a kind
  that disagrees with its ids.
- **Failures carry the thrower's code**: `tool_traces.failure_code` records the structured
  code emitted at the failure choke - carried, never invented (the generic wrapper stays
  NULL). mama-core migration note: 043-060 is a dead zone (a retired chain owns those
  schema_version rows); new core migrations number 061+.
- **A silent leg pages the owner**: every scheduled leg declares its cadence and beats from
  its interval handler; an independent watchdog pages past 2x cadence, defers through
  quiet hours (23-08), and reports recovery once. The interval is the leg - a consumer
  mid-run is alive, not silent.
- **Temporal freshness is a receipt, not a gate**: a stale but source-backed packet
  commits with `packet_created_at` receipted, and the HOST seeds the compile with the
  bound source's channel/event.

### Conductor foundations (v0.30.0, S1 - dark behind `conductor.enabled`)

A durable inbox (`conductor_inbox`: enqueue-before-commit, per-event dedupe, lease claims,
5-attempt poison cap) feeds one long-lived judgment session on its own
`session:conductor:main` lane - deliberately NOT the global operator lane, where Stage-2
workers serialize and an awaiting judgment would deadlock. Recycled on age/turns/tokens/idle
with a board re-ground on every fresh session. Default off; report authority transfers only
after a six-item parity rubric (`docs/development/report-parity-rubric.md`) passes 6/6 three
days running.

**Channel identity** underpins both. Connectors emit whatever their upstream hands them,
which for six of seven is a display NAME while the config is keyed by ID — so every
downstream reader compared against the config key and matched nothing. Keys are now
canonicalised at write time, before anything durable is stored.

### Hooks (Claude Code plugin)

- **SessionStart:** checkpoint + recent-decision bootstrap into the session
- **PreToolUse (Read):** related-decision injection when reading matching files
- **PostToolUse (Write/Edit):** contract extraction + save guidance
- **PreCompact:** checkpoint safety net before context compaction
- (UserPromptSubmit is not wired in the current plugin manifest)

---

## Data Flow

```
File Read (plugin session)
    ↓
PreToolUse Hook
    ↓
Semantic Search (Tier 1) or Exact Match (Tier 2)
    ↓
Hybrid Scoring (similarity × recency)
    ↓
Top 3 Decisions (if > 60% similarity)
    ↓
Gentle Context Hints
```

---

## Performance Characteristics

**With HTTP Embedding Server (Default):**

- Hook latency: ~150ms (model stays in memory)
- Embedding requests: ~50ms via HTTP

---

## ✨ Key Strengths

- **Contract-first flow:** PreToolUse enforces search before edits; no contract → no guessing.
- **Grounded reasoning:** Reasoning Summary is computed from actual matches; unknowns are explicit.
- **Cross-session memory:** MCP-stored contracts prevent schema drift across sessions and repos.
- **Noise control:** Per-session long/short output reduces repeated guidance.
- **Safety by default:** Sanitized contract injection mitigates prompt-injection risk.

**Tier 1 (Without HTTP Server):**

- First query: ~987ms (model load)
- Subsequent: ~89ms (cached)
- Accuracy: 80%

**Tier 2:**

- All queries: ~12ms
- Accuracy: 40%

---

**Related:**

- [Tier System Explanation](tier-system.md)
- [Decision Graph Concept](decision-graph.md)
- [Performance Details](performance.md)
- [Data Privacy](data-privacy.md)
