# Product Requirements Document: MAMA OS Stability

**Date:** 2026-02-24
**Author:** Jung Jaehoon
**Version:** 1.0
**Project Type:** Stability / Technical Debt Reduction
**Project Level:** Level 3 (15+ stories)
**Status:** Draft

---

## Document Overview

This PRD defines requirements for MAMA OS stability improvements. The goal is **not** new features but operational reliability, predictability, and maintainability. These are the prerequisites for sustainable growth.

**Context:** Council analysis (2026-02-24) identified 5 core stability issues + observability gap. All 6 areas are in scope.

---

## Executive Summary

MAMA OS (~49K LOC) is a functional 24/7 AI agent platform, but has accumulated technical debt that undermines reliability:

- **Token estimation** uses a naive `chars/4` heuristic — 50-100% underestimate for Korean, causing silent context overflow
- **Skill loading** hard-truncates at 4000 chars — instructions silently lost, agent quality degrades randomly
- **CLI backend** has no shared abstraction — Claude/Codex wrappers diverge in timeout, retry, error handling
- **25+ hardcoded constants** — users cannot tune timeouts, limits, thresholds without code changes
- **Gateway tool definitions** maintained in 3 places — tool list drift causes "tool not found" errors
- **Observability** tracks token costs but not turn counts, failure rates, truncation events, or process restarts

**Success = same input produces same quality output, every time.**

---

## Product Goals

### Business Objectives

1. **Reproducibility**: Eliminate silent quality degradation from truncation, estimation errors, and tool drift
2. **Configurability**: All operational parameters tunable without code changes
3. **Maintainability**: Single source of truth for tool definitions; unified CLI backend abstraction
4. **Visibility**: Operators can diagnose issues from metrics alone, without reading logs

### Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Token estimation error (Korean) | ~50-100% underestimate | < 15% |
| Skill truncation events | Unknown (no tracking) | 0 (chunked loading) |
| Hardcoded constants | 25+ | 0 (all in config) |
| Gateway tool source count | 3 (md + fallback + executor) | 1 (SSOT) |
| Observability coverage | Cost only (1 metric type) | 5 metric categories tracked (cost, turns, failures, truncations, skill_loads) |

---

## Functional Requirements

### FR-001: Model-Aware Token Estimator

**Priority:** Must Have

**Description:**
Replace `Math.ceil(chars / 4)` heuristic with a model-aware token estimator. Must handle multilingual text (Korean + English mixed) accurately. Use `cl100k_base` or `o200k_base` tokenizer for Claude models.

**Current locations:**
- `prompt-size-monitor.ts:213` — `Math.ceil(chars / 4)`
- `decision-formatter.ts:373` — `Math.ceil(chars / 4)`
- `agent-loop.ts:42` — same heuristic in comment/code

**Acceptance Criteria:**
- [ ] Token estimation error < 15% for Korean text
- [ ] Token estimation error < 10% for English text
- [ ] Estimation latency < 5ms for 10K char input
- [ ] `WARN_CHARS`, `TRUNCATE_CHARS`, `HARD_LIMIT_CHARS` converted to token-based thresholds
- [ ] Fallback to `chars/4` if tokenizer unavailable (fail-open for estimation, fail-closed for budget enforcement)

**Dependencies:** None

---

### FR-002: Skill Loading Without Truncation

**Priority:** Must Have

**Description:**
Replace hard 4000-char truncation with intelligent skill loading. Skills exceeding the budget should be chunked or summarized, not silently cut.

**Current location:** `agent-loop.ts:155,178-180`

**Acceptance Criteria:**
- [ ] Skills up to 8000 chars load without content loss
- [ ] Skills exceeding limit are split at semantic boundaries (section headers, `---`)
- [ ] Truncation marker includes what was omitted (section names)
- [ ] `MAX_SKILL_FILE_CHARS` configurable via `mama.yaml` or environment variable
- [ ] Truncation events emitted as observable metric

---

### FR-003: Unified CLI Backend Interface

**Priority:** Must Have

**Description:**
Extract a shared `ModelRunner` interface that `PersistentCLIAdapter`, `ClaudeCLIWrapper`, and `CodexMCPProcess` all implement. Normalize timeout, retry, and error handling semantics.

**Current files:**
- `claude-cli-wrapper.ts` — one-shot spawn
- `persistent-cli-process.ts` — long-running process
- `persistent-cli-adapter.ts` — adapter wrapping persistent → wrapper interface
- `codex-mcp-process.ts` — Codex MCP spawn

**Acceptance Criteria:**
- [ ] `ModelRunner` interface defined with: `prompt()`, `stop()`, `isHealthy()`, `getMetrics()`
- [ ] All 3 backends implement `ModelRunner`
- [ ] Timeout values unified and configurable (currently Claude=120s, Codex=180s)
- [ ] Error types standardized (timeout, crash, context overflow, auth failure)
- [ ] AgentLoop depends on `ModelRunner`, not concrete implementations
- [ ] Existing tests pass without modification

**Dependencies:** FR-005 (config externalization for timeout values)

---

### FR-004: Gateway Tools Single Source of Truth

**Priority:** Should Have

**Description:**
Eliminate tool definition drift by generating `gateway-tools.md`, fallback prompt, and `GatewayToolExecutor` registration from a single tool registry.

**Current sources:**
- `src/agent/gateway-tools.md` — full tool docs (Markdown)
- `agent-loop.ts:476-489` — hardcoded fallback (subset of tools)
- `gateway-tool-executor.ts` — runtime tool registration
- `code-act/constants.ts:17` — separate tool list mention

**Acceptance Criteria:**
- [ ] Single `tool-registry.ts` (or `.yaml`) defines all gateway tools
- [ ] `gateway-tools.md` generated from registry (build step or runtime)
- [ ] Fallback prompt generated from same registry
- [ ] Adding a new tool requires editing only 1 file + implementing handler
- [ ] Build fails if registry and executor are out of sync

**Dependencies:** None

---

### FR-005: Configuration Externalization

**Priority:** Must Have

**Description:**
Move all hardcoded operational constants to a configuration layer. Support `~/.mama/config.yaml`, environment variables, and runtime API override.

**Constants to externalize (25+):**

| Category | Constants | Current files |
|----------|-----------|---------------|
| Prompt limits | `WARN_CHARS`, `TRUNCATE_CHARS`, `HARD_LIMIT_CHARS`, `MAX_SKILL_FILE_CHARS` | prompt-size-monitor.ts, agent-loop.ts |
| Timeouts | `requestTimeout`, `DEFAULT_REQUEST_TIMEOUT_MS`, `INITIALIZE_TIMEOUT`, `SESSION_TIMEOUT`, `AGENT_TIMEOUT`, `EXECUTE_TIMEOUT` | persistent-cli-process.ts, codex-mcp-process.ts, session-pool.ts, multi-agent-base.ts, ultrawork.ts |
| Context | `CONTEXT_THRESHOLD_TOKENS`, `MAX_CONTEXT_TOKENS`, `useStdin` threshold | session-pool.ts, claude-cli-wrapper.ts |
| Gateway | `DEDUP_TTL_MS`, `MENTION_TTL_MS`, `MESSAGE_TTL_MS`, `CLEANUP_INTERVAL`, `HEARTBEAT_INTERVAL` | slack.ts, multi-agent-base.ts, agent-message-queue.ts, multi-agent-discord.ts, multi-agent-slack.ts |
| Throttle | `DEFAULT_THROTTLE_MS`, `DEFAULT_INITIAL_DELAY_MS`, `BUSY_RETRY_DELAY_MS` | tool-status-tracker.ts, background-task-manager.ts |
| IO | `MAX_READ_BYTES`, `MAX_DYNAMIC_CONTEXT_CHARS` | gateway-tool-executor.ts, multi-agent-discord.ts |

**Acceptance Criteria:**
- [ ] All 25+ constants read from config with current values as defaults
- [ ] Config schema validated on load (type + range check)
- [ ] `GET /api/config` returns current runtime config
- [ ] `PUT /api/config` allows runtime override (non-persistent by default)
- [ ] Environment variables override config file (`MAMA_REQUEST_TIMEOUT_MS` etc.)
- [ ] Invalid config logs warning and falls back to default (no crash)

**Dependencies:** None

---

### FR-006: Basic Observability Metrics

**Priority:** Should Have

**Description:**
Add structured metrics collection for operational visibility. Build on existing `token_usage` SQLite table.

**Currently tracked:** token counts, cost_usd, duration_ms per request
**Not tracked:** turn counts per session, tool call failures, process restarts, prompt truncations, skill match hits, dedup misses

**Acceptance Criteria:**
- [ ] New `metrics` SQLite table: `(metric_name, value, labels_json, timestamp)`
- [ ] Metrics emitted for: turn_count, tool_failures, process_restarts, prompt_truncations, skill_loads
- [ ] `GET /api/metrics` returns last-N-minutes summary
- [ ] `GET /api/metrics/health` returns system health score with defined thresholds:
  - Green: tool_failure rate < 5%, no process_restart in 10min
  - Yellow: tool_failure rate 5-15% OR process_restart in last 10min
  - Red: tool_failure rate > 15% OR repeated process_restart (3+ in 10min)
- [ ] Health thresholds configurable via FR-005
- [ ] Metrics auto-cleanup (retain 7 days by default, configurable)
- [ ] No external dependencies (no Prometheus/OTel — pure SQLite)

**Dependencies:** FR-005 (retention period configurable)

---

### FR-007: Token Budget Fail-Closed Enforcement

**Priority:** Should Have

**Description:**
When token budget is exceeded, enforce hard cutoff instead of best-effort truncation. Prevent context overflow from reaching the model API.

**Acceptance Criteria:**
- [ ] Hard token limit configurable per model (default: 180K for Claude, 120K for Codex)
- [ ] Exceeding hard limit returns structured error (not silent truncation)
- [ ] System prompt + tools + history budget breakdown visible in metrics
- [ ] Budget enforcement tested with oversized inputs

**Dependencies:** FR-001 (accurate token estimation), FR-005 (per-model limits configurable)

---

### FR-008: Per-Agent MCP Tool Filtering

**Priority:** Should Have

**Description:**
Each agent subprocess currently receives the full MCP tool catalog in its system prompt, even if it only needs 3-4 tools. Add an `allowed_tools` field per agent config so that only relevant tool descriptions are injected into the subprocess prompt. This reduces token overhead from unnecessary tool definitions (can be thousands of tokens per MCP server) and prevents hallucinated calls to tools the agent shouldn't use.

**Context:** Community feedback (dev.to discussion, signalstack + Mahima) identified this as the next optimization layer after subprocess isolation — preventing *unnecessary* injection complements preventing *repeated* injection.

**Current state:**
- Tier-based permissions (Tier 1=all, Tier 2/3=read-only) are **prompt-level only** — full tool descriptions still injected
- Each MCP server's tool catalog loaded in full regardless of agent's actual needs

**Acceptance Criteria:**
- [ ] Agent persona config supports `allowed_tools?: string[]` field
- [ ] When `allowed_tools` is set, only matching tool descriptions injected into system prompt
- [ ] When `allowed_tools` is omitted, current behavior preserved (all tools available)
- [ ] Tool filtering applies to both gateway tools and MCP server tools
- [ ] Token savings from filtering reported as `tools_filtered_count` metric
- [ ] Agents cannot call tools not in their `allowed_tools` list (hard enforcement, not just prompt-based)

**Dependencies:** FR-004 (ToolRegistry), FR-005 (config externalization)

---

## Non-Functional Requirements

### NFR-001: Performance — Token Estimation

**Priority:** Must Have

**Description:**
Token estimation must not add perceptible latency to the request pipeline.

**Acceptance Criteria:**
- [ ] Estimation latency < 5ms for inputs up to 50K chars
- [ ] Tokenizer loaded once (singleton), not per-request
- [ ] Memory overhead < 10MB for tokenizer model

**Rationale:** Estimation runs on every prompt. Adding 100ms+ would degrade UX.

---

### NFR-002: Backward Compatibility

**Priority:** Must Have

**Description:**
All changes must be backward-compatible. Existing `~/.mama/config.json` and `mama.yaml` configurations must continue to work.

**Acceptance Criteria:**
- [ ] Existing config files load without errors
- [ ] Default behavior unchanged when no new config is provided
- [ ] No database migration required for core features (metrics table is additive)
- [ ] All existing tests pass without modification

**Rationale:** Users running MAMA OS in production must not be broken by stability updates.

---

### NFR-003: Zero External Dependencies

**Priority:** Must Have

**Description:**
Stability improvements must not add heavy new dependencies. Prefer built-in Node.js capabilities and existing stack (SQLite, Transformers.js).

**Acceptance Criteria:**
- [ ] No new native dependencies (no Redis, no Kafka, no Prometheus agent)
- [ ] Tokenizer uses pure JS/WASM (e.g., `tiktoken` WASM build or `js-tiktoken`)
- [ ] Total new dependency size < 5MB
- [ ] `pnpm install` time increase < 10%

**Rationale:** MAMA OS is local-first. Adding infrastructure dependencies defeats the purpose.

---

### NFR-004: Test Coverage

**Priority:** Should Have

**Description:**
All new code must have unit tests. Stability code demands higher confidence.

**Acceptance Criteria:**
- [ ] New modules: 90%+ line coverage
- [ ] Token estimator: tested with Korean, English, mixed, code inputs
- [ ] Config loader: tested with valid, invalid, partial, missing configs
- [ ] Metric collection: tested with concurrent writes

**Rationale:** Stability code that isn't tested is an oxymoron.

---

### NFR-005: Observability Overhead

**Priority:** Should Have

**Description:**
Metrics collection must not impact request latency or system stability.

**Acceptance Criteria:**
- [ ] Metric write latency < 1ms (SQLite WAL mode)
- [ ] Metric storage growth < 10MB/day at normal usage
- [ ] Metric collection failure never crashes the main process (fire-and-forget)

**Rationale:** Observability that causes instability is counterproductive.

---

## Epics

### EPIC-001: Token Accuracy

**Description:**
Replace character-based token heuristic with model-aware estimation and enforce hard budget limits.

**Functional Requirements:**
- FR-001 (Model-Aware Token Estimator)
- FR-007 (Token Budget Fail-Closed Enforcement)

**Story Count Estimate:** 4-5

**Priority:** Must Have

**Business Value:**
Eliminates silent context overflow — the #1 cause of unpredictable agent behavior with Korean content.

---

### EPIC-002: Skill Loading

**Description:**
Replace hard truncation with semantic-aware skill loading that preserves instruction integrity.

**Functional Requirements:**
- FR-002 (Skill Loading Without Truncation)

**Story Count Estimate:** 2-3

**Priority:** Must Have

**Business Value:**
Ensures agent follows complete instructions regardless of skill length. Directly improves output quality.

---

### EPIC-003: CLI Backend Unification

**Description:**
Create shared `ModelRunner` interface for all CLI backends, normalizing timeout/retry/error semantics.

**Functional Requirements:**
- FR-003 (Unified CLI Backend Interface)

**Story Count Estimate:** 4-5

**Priority:** Must Have

**Business Value:**
Reduces maintenance burden, makes backend switching safe, and enables consistent error handling across Claude/Codex.

---

### EPIC-004: Configuration System

**Description:**
Externalize all operational constants into a validated, layered configuration system.

**Functional Requirements:**
- FR-005 (Configuration Externalization)

**Story Count Estimate:** 3-4

**Priority:** Must Have

**Business Value:**
Users can tune MAMA OS behavior without code changes. Prerequisite for FR-001, FR-003, FR-006.

---

### EPIC-005: Gateway Tools SSOT & Tool Filtering

**Description:**
Consolidate gateway tool definitions into a single source that generates all artifacts, and add per-agent tool filtering to reduce unnecessary tool description injection.

**Functional Requirements:**
- FR-004 (Gateway Tools Single Source of Truth)
- FR-008 (Per-Agent MCP Tool Filtering)

**Story Count Estimate:** 4-5

**Priority:** Should Have

**Business Value:**
Eliminates tool drift bugs and reduces per-agent token overhead from unnecessary tool descriptions. New tool onboarding becomes a single-file change. Community feedback confirms this is a key optimization for multi-agent setups.

---

### EPIC-006: Observability

**Description:**
Add structured metrics for operational visibility without external dependencies.

**Functional Requirements:**
- FR-006 (Basic Observability Metrics)

**Story Count Estimate:** 3-4

**Priority:** Should Have

**Business Value:**
Operators can diagnose issues from metrics. Prerequisite for data-driven optimization.

---

## User Stories (High-Level)

### EPIC-001: Token Accuracy
- As an operator, I want accurate token estimates for Korean text so that context overflow doesn't silently degrade responses.
- As a developer, I want per-model token limits enforced so that oversized prompts fail explicitly instead of producing garbage.

### EPIC-002: Skill Loading
- As a skill author, I want skills over 4000 chars to load completely so that instructions aren't silently lost.
- As an operator, I want to configure the skill size limit so that I can balance context budget and skill completeness.

### EPIC-003: CLI Backend Unification
- As a developer, I want a single `ModelRunner` interface so that adding a new backend doesn't require touching AgentLoop.
- As an operator, I want consistent timeout behavior across Claude and Codex backends.

### EPIC-004: Configuration System
- As an operator, I want to tune timeouts and thresholds via config file so that I don't need to modify source code.
- As an operator, I want runtime config override via API so that I can adjust behavior without restart.

### EPIC-005: Gateway Tools SSOT & Tool Filtering
- As a developer, I want to add a gateway tool by editing one file so that I don't forget to update fallback or docs.
- As an operator, I want each agent to only see the tools it needs so that token budget isn't wasted on irrelevant tool descriptions.

### EPIC-006: Observability
- As an operator, I want to see turn counts, failure rates, and truncation events so that I can diagnose quality issues.
- As an operator, I want a health endpoint so that monitoring can alert on degradation.

---

## User Personas

### 1. Solo Developer / Power User
- Runs MAMA OS locally on personal machine
- Uses Korean + English mixed
- Wants reliable 24/7 operation without babysitting
- Needs: accurate token handling, configurable limits

### 2. Small Team Operator
- Runs MAMA OS for team (Discord/Slack gateway)
- Needs operational visibility when things go wrong
- Needs: observability, health endpoints, config without code changes

### 3. Plugin/Skill Author
- Writes custom skills and gateway tools
- Needs: reliable skill loading, clear tool onboarding process

---

## User Flows

### 1. Operator Tunes Configuration
`Edit ~/.mama/config.yaml` → `mama restart` → Config validated → New thresholds active → Verify via `GET /api/config`

### 2. Operator Diagnoses Quality Issue
`GET /api/metrics/health` → Yellow (high truncation rate) → `GET /api/metrics?name=prompt_truncations` → Identify cause → Adjust config → Green

### 3. Developer Adds New Gateway Tool
Edit `tool-registry.yaml` → Implement handler in `gateway-tool-executor.ts` → `pnpm build` generates `gateway-tools.md` + fallback → Test → Deploy

---

## Dependencies

### Internal Dependencies

- `packages/mama-core/` — config-loader.ts will be extended (EPIC-004)
- `packages/standalone/src/agent/` — primary target for EPIC-001, 002, 003
- `packages/standalone/src/api/` — metrics and config endpoints (EPIC-004, 006)
- SQLite schema — additive `metrics` table (EPIC-006)

### External Dependencies

- **Tokenizer library** — `js-tiktoken` or `tiktoken` WASM (new, < 2MB)
- No other new external dependencies

---

## Assumptions

1. Current `chars/4` heuristic is the primary cause of Korean text quality issues (needs validation)
2. `js-tiktoken` or equivalent WASM tokenizer works in Node 22 without issues
3. Skills exceeding 8000 chars are rare (< 5% of all skills)
4. Users are willing to adopt `config.yaml` for new settings (existing `config.json` continues to work)
5. SQLite WAL mode handles concurrent metric writes without contention

---

## Out of Scope

- **Distributed systems** — No Redis, Kafka, or multi-node coordination
- **Enterprise features** — No RBAC for config, no audit log, no SSO
- **New AI capabilities** — No new agent types, tools, or model integrations
- **UI/Dashboard** — Metrics exposed as API only, no new frontend
- **Breaking changes** — All changes backward-compatible

---

## Open Questions

1. **Tokenizer choice**: `js-tiktoken` (Rust→WASM, accurate) vs. `gpt-tokenizer` (pure JS, lighter)? Need to benchmark both for Korean accuracy and latency.
2. **Config format**: Extend existing `~/.mama/config.json` or introduce `~/.mama/config.yaml`? YAML is more readable but adds a dependency.
3. **Skill chunking strategy**: Split at `---`/`##` boundaries, or use embedding-based relevance to select chunks?
4. ~~**Metrics retention**: 7 days default — is this enough?~~ **Resolved:** 7 days default, configurable via FR-005/FR-006 AC.

---

## Approval & Sign-off

### Stakeholders

| Role | Name |
|------|------|
| Product Owner | Jung Jaehoon |
| Developer | Jung Jaehoon + Claude |

### Approval Status

- [ ] Product Owner

---

## Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-02-24 | Jung Jaehoon | Initial PRD |

---

## Next Steps

### Phase 3: Architecture

Run `/architecture` to design system architecture addressing all FRs and NFRs.

Key architecture decisions needed:
- Tokenizer integration pattern (singleton, lazy load)
- Config schema design (layered: defaults → file → env → runtime API)
- `ModelRunner` interface design
- Tool registry format and codegen approach
- Metrics storage schema and collection pattern

### Phase 4: Sprint Planning

After architecture, run `/sprint-planning` to:
- Break 6 epics into 18-24 detailed stories
- Sequence sprints (EPIC-004 first as prerequisite)
- Estimate complexity per story

---

**This document was created using BMAD Method v6 - Phase 2 (Planning)**

*To continue: Run `/workflow-status` to see your progress and next recommended workflow.*

---

## Appendix A: Requirements Traceability Matrix

| Epic ID | Epic Name | Functional Requirements | Story Count (Est.) |
|---------|-----------|-------------------------|-------------------|
| EPIC-001 | Token Accuracy | FR-001, FR-007 | 4-5 |
| EPIC-002 | Skill Loading | FR-002 | 2-3 |
| EPIC-003 | CLI Backend Unification | FR-003 | 4-5 |
| EPIC-004 | Configuration System | FR-005 | 3-4 |
| EPIC-005 | Gateway Tools SSOT & Tool Filtering | FR-004, FR-008 | 4-5 |
| EPIC-006 | Observability | FR-006 | 3-4 |
| **Total** | | **8 FRs** | **20-27 stories** |

---

## Appendix B: Prioritization Details

### Functional Requirements

| Priority | Count | IDs |
|----------|-------|-----|
| Must Have | 4 | FR-001, FR-002, FR-003, FR-005 |
| Should Have | 4 | FR-004, FR-006, FR-007, FR-008 |
| Could Have | 0 | — |

### Non-Functional Requirements

| Priority | Count | IDs |
|----------|-------|-----|
| Must Have | 3 | NFR-001, NFR-002, NFR-003 |
| Should Have | 2 | NFR-004, NFR-005 |

### Recommended Epic Sequence

```
EPIC-004 (Config) ──→ EPIC-001 (Token) ──→ EPIC-003 (CLI)
                  └──→ EPIC-002 (Skill)
                  └──→ EPIC-005 (Gateway SSOT)
                  └──→ EPIC-006 (Observability)
```

EPIC-004 is the foundation — multiple other epics depend on externalized config.
