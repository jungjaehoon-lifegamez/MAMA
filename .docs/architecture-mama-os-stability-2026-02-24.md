# System Architecture: MAMA OS Stability

**Date:** 2026-02-24
**Architect:** Jung Jaehoon
**Version:** 1.0
**Project Type:** Stability / Technical Debt Reduction
**Project Level:** Level 3
**Status:** Draft

---

## Document Overview

This document defines the architecture for MAMA OS stability improvements. It covers 6 epics: Token Accuracy, Skill Loading, CLI Backend Unification, Configuration Externalization, Gateway Tools SSOT, and Observability.

**Related Documents:**
- PRD: `.docs/prd-mama-os-stability-2026-02-24.md`

---

## Executive Summary

MAMA OS stability work is **not greenfield** — it's surgical improvement of an existing 49K LOC codebase. The architecture focuses on:

1. **Minimal surface area** — Each change touches specific modules, no cross-cutting rewrites
2. **Backward compatibility** — All existing configs, APIs, and behaviors remain unchanged
3. **Config-first sequencing** — EPIC-004 (Configuration) is the foundation; other epics consume it
4. **Zero new infrastructure** — SQLite, Node.js built-ins, WASM tokenizer only

---

## Architectural Drivers

| Driver | Source | Impact |
|--------|--------|--------|
| NFR-001: Token estimation < 5ms | FR-001 | Tokenizer must be singleton, pre-loaded |
| NFR-002: Backward compatibility | All FRs | New config layer must fall through to defaults |
| NFR-003: Zero external deps | All FRs | No Redis, no Prometheus — SQLite + WASM only |
| NFR-005: Observability overhead < 1ms | FR-006 | Fire-and-forget metric writes, WAL mode |
| Existing MAMAConfig interface | All FRs | New config sections extend, not replace |

---

## System Overview

### Architectural Pattern

**Pattern:** Modular Enhancement of Existing Monolith

**Rationale:** MAMA OS is a well-structured monolith. Stability work adds/replaces modules within existing boundaries rather than restructuring. Each epic produces 1-2 new modules that plug into existing extension points.

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                     AgentLoop                            │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐ │
│  │ PromptSize   │  │ SkillLoader  │  │ ModelRunner   │ │
│  │ Monitor      │  │ (enhanced)   │  │ (interface)   │ │
│  │ + Tokenizer  │  │              │  │               │ │
│  │   (NEW)      │  │              │  │ ┌───────────┐ │ │
│  └──────┬───────┘  └──────┬───────┘  │ │ Claude    │ │ │
│         │                  │          │ │ Adapter   │ │ │
│         ▼                  ▼          │ ├───────────┤ │ │
│  ┌──────────────────────────────┐    │ │ Codex     │ │ │
│  │     ConfigManager (extended) │    │ │ Adapter   │ │ │
│  │     ~/.mama/config.yaml      │    │ └───────────┘ │ │
│  │     + runtime overrides      │    └───────────────┘ │
│  └──────────────────────────────┘                       │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐                     │
│  │ ToolRegistry │  │ MetricsStore │                     │
│  │ (SSOT, NEW)  │  │ (SQLite,NEW) │                     │
│  └──────────────┘  └──────────────┘                     │
└─────────────────────────────────────────────────────────┘
```

---

## Technology Stack

### New Dependencies

| Dependency | Purpose | Size | Justification |
|-----------|---------|------|---------------|
| `js-tiktoken` | Token estimation (cl100k_base) | ~1.5MB WASM | Accurate multilingual tokenization without native deps |

### Existing Stack (unchanged)

- **Runtime:** Node.js 22+, TypeScript 5.4
- **Database:** SQLite via better-sqlite3 (WAL mode)
- **Config:** js-yaml (already in deps)
- **Build:** Turbo, pnpm monorepo
- **Test:** Vitest
- **CI:** GitHub Actions

No new infrastructure dependencies.

---

## Component Architecture

### Component 1: TokenEstimator

**Purpose:** Replace `chars/4` heuristic with model-aware token counting

**File:** `packages/standalone/src/agent/token-estimator.ts` (NEW)

**Interface:**
```typescript
interface TokenEstimator {
  /** Count tokens for given text. Uses cl100k_base as approximation. */
  count(text: string): number;

  /** Check if text exceeds token limit */
  exceedsLimit(text: string, limit: number): boolean;
}
```

**Design decisions:**
- Singleton — tokenizer loaded once on first call, reused across all requests
- `count()` uses `js-tiktoken` `cl100k_base` encoding as **best-available approximation** (no public Claude tokenizer exists; cl100k_base is the closest BPE tokenizer available)
- Always use `count()` for accuracy — no fast-path estimate (the `chars/4` problem we're solving was itself a "fast estimate")
- Fallback: if WASM load fails, degrade to `Math.ceil(byteLength * 0.4)` (conservative byte-length estimate; never `chars/4`)
- **Accuracy target:** < 15% error for Korean, < 10% for English. Monitor via `token_estimation_error` metric and adjust if needed

**Integration into PromptSizeMonitor:**
```typescript
// prompt-size-monitor.ts — change estimateTokens()
- return Math.ceil(chars / 4);
+ return tokenEstimator.count(text);

// Thresholds change from char-based to token-based:
- WARN_CHARS = 15_000    →  WARN_TOKENS (from config, default: 3_750)
- TRUNCATE_CHARS = 25_000 → TRUNCATE_TOKENS (from config, default: 6_250)
- HARD_LIMIT_CHARS = 40_000 → HARD_LIMIT_TOKENS (from config, default: 10_000)
```

**FRs addressed:** FR-001, FR-007
**NFRs addressed:** NFR-001 (< 5ms latency)

---

### Component 2: SkillLoader (enhanced)

**Purpose:** Replace hard 4000-char truncation with semantic-aware loading

**File:** `packages/standalone/src/agent/skill-loader.ts` (EXTRACT from agent-loop.ts)

**Current logic (agent-loop.ts:155-180):**
```typescript
const MAX_SKILL_FILE_CHARS = 4000;
if (!isCommand && content.length > MAX_SKILL_FILE_CHARS) {
  content = content.slice(0, MAX_SKILL_FILE_CHARS) + '\n[... truncated]';
}
```

**New design:**
```typescript
interface SkillLoadResult {
  content: string;
  truncated: boolean;
  omittedSections: string[];  // section headers that were cut
  originalChars: number;
}

function loadSkillContent(
  skillPath: string,
  maxTokens: number,        // from config, default: 2000
  tokenEstimator: TokenEstimator
): SkillLoadResult;
```

**Truncation strategy:**
1. Parse skill file into sections (split on `## ` or `---`)
2. Include sections by priority: frontmatter → core instructions → examples → appendix
3. If total exceeds `maxTokens`, omit lowest-priority sections
4. Append `[Omitted: {section_names}]` marker
5. Never cut mid-section

**Config:**
```yaml
# ~/.mama/config.yaml
agent:
  skill_max_tokens: 2000   # default, configurable
```

**FRs addressed:** FR-002
**NFRs addressed:** NFR-002 (backward compatible — default matches current ~1000 tokens)

---

### Component 3: IModelRunner Interface

**Purpose:** Unified interface for Claude CLI and Codex MCP backends

**File:** `packages/standalone/src/agent/model-runner.ts` (NEW)

**Current state:** AgentLoop uses `PersistentCLIAdapter | CodexMCPProcess` union type directly.

**New interface:**
```typescript
interface IModelRunner {
  /** Send prompt, receive streaming response */
  prompt(content: string, callbacks: PromptCallbacks): Promise<PromptResult>;

  /** Send tool result back to model (Claude CLI only; Codex handles this via MCP protocol) */
  sendToolResult?(toolUseId: string, result: string): Promise<void>;

  /** Set system prompt for session */
  setSystemPrompt(prompt: string): void;

  /** Set session ID for persistence */
  setSessionId(id: string): void;

  /** Health check */
  isHealthy(): boolean;

  /** Get runtime metrics */
  getMetrics(): RunnerMetrics;

  /** Graceful shutdown */
  stop(): Promise<void>;

  /** Backend identifier */
  readonly backendType: 'claude-cli' | 'codex-mcp';
}

interface RunnerMetrics {
  totalRequests: number;
  failedRequests: number;
  avgLatencyMs: number;
  lastError: string | null;
  uptime: number;
}
```

**Migration path:**
1. Define `IModelRunner` in `model-runner.ts`
2. `PersistentCLIAdapter` implements `IModelRunner` (add `isHealthy()`, `getMetrics()`, `stop()`)
3. `CodexMCPProcess` implements `IModelRunner` (add missing methods)
4. AgentLoop changes: `private readonly agent: PersistentCLIAdapter | CodexMCPProcess` → `private readonly agent: IModelRunner`
5. Timeout values read from config (FR-005), not hardcoded per-backend

**Timeout unification:**
```yaml
# ~/.mama/config.yaml
agent:
  timeout: 180000           # unified default (currently Claude=120s, Codex=180s)
  initialize_timeout: 60000
  session_timeout: 1800000
```

**FRs addressed:** FR-003
**NFRs addressed:** NFR-002 (existing tests pass — interface is additive)

---

### Component 4: ConfigManager Extension

**Purpose:** Externalize 25+ hardcoded constants into config.yaml

**File:** `packages/standalone/src/cli/config/types.ts` + `config-manager.ts` (EXTEND)

**Design: Layered config resolution**

```
Priority (high → low):
  1. Runtime API override  (PUT /api/config, in-memory only)
  2. Environment variables (MAMA_REQUEST_TIMEOUT etc.)
  3. Config file           (~/.mama/config.yaml)
  4. Defaults              (DEFAULT_CONFIG in types.ts)
```

**New config sections:**

```typescript
interface MAMAConfig {
  // ... existing fields ...

  // NEW: Prompt limits (EPIC-001)
  prompt?: {
    warn_tokens: number;           // default: 3750
    truncate_tokens: number;       // default: 6250
    hard_limit_tokens: number;     // default: 10000
    skill_max_tokens: number;      // default: 2000
  };

  // NEW: Timeouts (EPIC-003)
  timeouts?: {
    request_ms: number;            // default: 180000
    initialize_ms: number;         // default: 60000
    session_ms: number;            // default: 1800000
    agent_ms: number;              // default: 300000
    ultrawork_ms: number;          // default: 300000
    busy_retry_ms: number;         // default: 5000
  };

  // NEW: Gateway settings (EPIC-004)
  gateway?: {
    dedup_ttl_ms: number;          // default: 30000
    mention_ttl_ms: number;        // default: 300000
    message_ttl_ms: number;        // default: 1200000
    cleanup_interval_ms: number;   // default: 60000
    heartbeat_interval_ms: number; // default: 60000
  };

  // NEW: IO limits
  io?: {
    max_read_bytes: number;        // default: 200000
    stdin_threshold: number;       // default: 50000
    max_dynamic_context_chars: number; // default: 4000
  };

  // NEW: Metrics (EPIC-006)
  metrics?: {
    enabled: boolean;              // default: true
    retention_days: number;        // default: 7
  };
}
```

**Synchronous cache layer (critical design):**

Current `loadConfig()` is async (file read). But 25+ callsites are in synchronous contexts (constructors, module-scope constants). Solution:

```typescript
// config-manager.ts
let cachedConfig: MAMAConfig | null = null;

/** Call once at startup (async). Loads file + env + validates. */
export async function initConfig(): Promise<MAMAConfig> {
  cachedConfig = await loadAndMergeConfig();
  return cachedConfig;
}

/** Synchronous access after init. Returns cached config. */
export function getConfig(): MAMAConfig {
  if (!cachedConfig) throw new Error('Config not initialized — call initConfig() first');
  return cachedConfig;
}

/** Runtime override (PUT /api/config). Updates cache in-memory. */
export function overrideConfig(partial: Partial<MAMAConfig>): void {
  cachedConfig = deepMerge(cachedConfig!, partial);
}
```

Startup sequence: `initConfig()` called in `mama start` before any AgentLoop creation.

**Config access pattern:**
```typescript
// Current (scattered):
const DEDUP_TTL_MS = 30_000;

// New (centralized, synchronous):
import { getConfig } from './config/config-manager.ts';
const dedupTtl = getConfig().gateway?.dedup_ttl_ms ?? 30_000;

// Or via typed helper:
import { getGatewayConfig } from './config/accessors.ts';
const dedupTtl = getGatewayConfig('dedup_ttl_ms');
```

**Environment variable mapping:**
```
MAMA_REQUEST_TIMEOUT_MS    → timeouts.request_ms
MAMA_WARN_TOKENS           → prompt.warn_tokens
MAMA_METRICS_ENABLED       → metrics.enabled
MAMA_DEDUP_TTL_MS          → gateway.dedup_ttl_ms
```

Convention: `MAMA_` prefix + section + field, SCREAMING_SNAKE_CASE.

**Runtime API:**
```
GET  /api/config          → current effective config (merged)
PUT  /api/config          → runtime override (in-memory, lost on restart)
GET  /api/config/defaults → default values only
```

**FRs addressed:** FR-005
**NFRs addressed:** NFR-002 (defaults = current behavior)

---

### Component 5: ToolRegistry (Gateway SSOT)

**Purpose:** Single source of truth for gateway tool definitions

**File:** `packages/standalone/src/agent/tool-registry.ts` (NEW)

**Current problem:** Tool definitions in 3 places:
- `gateway-tools.md` — docs for LLM
- `agent-loop.ts:476-489` — fallback prompt (subset)
- `gateway-tool-executor.ts` — `VALID_TOOLS` array + handler dispatch

**New design:**

```typescript
interface ToolDefinition {
  name: string;
  category: 'memory' | 'browser' | 'gateway' | 'os' | 'utility' | 'cron';
  description: string;        // one-line for catalog
  parameters: Record<string, { type: string; required: boolean; description: string }>;
  requiresRole?: string[];    // role-based access
  examples?: string[];        // usage examples for LLM prompt
}

class ToolRegistry {
  private tools: Map<string, ToolDefinition>;

  /** Register a tool */
  register(def: ToolDefinition): void;

  /** Get all tool names (for VALID_TOOLS validation) */
  getValidToolNames(): string[];

  /** Generate gateway-tools.md content (for LLM prompt) */
  generatePrompt(): string;

  /** Generate fallback prompt (minimal, for when .md file is missing) */
  generateFallbackPrompt(): string;

  /** Validate that all registered tools have handlers */
  validateHandlers(executor: GatewayToolExecutor): string[];  // returns missing
}
```

**Build-time generation:**
- `pnpm build` step generates `dist/agent/gateway-tools.md` from registry
- Fallback is also generated (not hand-maintained)
- Build fails if registry has tools without handlers (via test)

**Migration:**
1. Create `tool-registry.ts` with all current tools from `VALID_TOOLS`
2. `GatewayToolExecutor` constructor reads from registry instead of hardcoded array
3. `agent-loop.ts` fallback reads from `registry.generateFallbackPrompt()`
4. `gateway-tools.md` generated by build script from registry
5. Delete hand-maintained fallback string

**FRs addressed:** FR-004

---

### Component 6: MetricsStore

**Purpose:** Structured metrics collection for operational visibility

**File:** `packages/standalone/src/metrics/metrics-store.ts` (NEW)

**SQLite schema:**
```sql
CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,           -- 'turn_count', 'tool_failure', 'prompt_truncation', etc.
  value REAL NOT NULL,          -- metric value (count=1, duration=ms, etc.)
  labels TEXT,                  -- JSON: {"agent_id":"conductor","channel":"discord"}
  created_at INTEGER NOT NULL   -- epoch ms
);

CREATE INDEX idx_metrics_name_ts ON metrics(name, created_at);
CREATE INDEX idx_metrics_ts ON metrics(created_at);  -- for time-based cleanup queries
```

**Interface:**
```typescript
class MetricsStore {
  constructor(db: Database);

  /** Record a metric (fire-and-forget, never throws) */
  record(name: string, value: number, labels?: Record<string, string>): void;

  /** Query metrics summary */
  query(name: string, sinceMs: number): { count: number; sum: number; avg: number; max: number };

  /** Health score: green/yellow/red based on error rates */
  healthScore(): 'green' | 'yellow' | 'red';

  /** Cleanup old metrics */
  cleanup(retentionDays: number): number;
}
```

**Metric types:**

| Name | Emitter | Trigger |
|------|---------|---------|
| `turn_count` | AgentLoop | Each model turn |
| `tool_failure` | GatewayToolExecutor | Tool execution error |
| `process_restart` | PersistentProcessPool | Process respawn |
| `prompt_truncation` | PromptSizeMonitor | enforce() called |
| `skill_load` | SkillLoader | Skill content loaded |
| `skill_truncation` | SkillLoader | Skill content truncated |
| `request_duration_ms` | IModelRunner | Each prompt() call |
| `token_estimation_error` | TokenEstimator | Periodic calibration |

**API endpoints:**
```
GET /api/metrics                    → all metrics summary (last 1h)
GET /api/metrics?name=tool_failure  → filtered
GET /api/metrics/health             → { status: 'green'|'yellow'|'red', details: {...} }
```

**Health score logic:**
- Green: tool_failure rate < 5%, no process_restart in 10min
- Yellow: tool_failure rate 5-15% OR process_restart in last 10min
- Red: tool_failure rate > 15% OR repeated process_restart

**Distribution pattern: Module-level singleton**

MetricsStore is used by 5+ components (AgentLoop, GatewayToolExecutor, PromptSizeMonitor, SkillLoader, PersistentProcessPool). Singleton avoids threading it through every constructor.

```typescript
// metrics/metrics-store.ts
let instance: MetricsStore | null = null;

/** Initialize once at startup (after DB is ready) */
export function initMetrics(dbPath: string): MetricsStore {
  instance = new MetricsStore(dbPath);
  return instance;
}

/** Get singleton. Returns no-op stub if not initialized (safe for early calls). */
export function getMetrics(): MetricsStore {
  return instance ?? noopMetrics;
}

// Usage from any component:
import { getMetrics } from '../metrics/metrics-store.ts';
getMetrics().record('turn_count', 1, { agent_id: this.agentId });
getMetrics().record('prompt_truncation', 1, { layers: truncatedLayers.join(',') });
```

Startup order: `initConfig()` → `initMetrics()` → create AgentLoop.

**FRs addressed:** FR-006
**NFRs addressed:** NFR-005 (fire-and-forget, WAL mode, < 1ms write)

---

## Data Architecture

### New Data (Additive Only)

| Table | Database | Purpose |
|-------|----------|---------|
| `metrics` | `~/.mama/data/metrics.db` | Operational metrics |

Separate DB file to avoid contention with session data. WAL mode enabled.

### Data Flow

```
AgentLoop / SkillLoader / ToolExecutor / ProcessPool
        │ record()
        ▼
   MetricsStore (fire-and-forget, async insert)
        │
        ▼
   metrics.db (WAL mode, auto-cleanup)
        │
        ▼
   GET /api/metrics (read-only query)
```

### Existing Data (Unchanged)

- `mama-memory.db` — decisions, embeddings (mama-core)
- `mama-sessions.db` — token_usage, channel_messages (standalone)
- `mama-scheduler.db` — schedules, schedule_logs
- `~/.mama/config.yaml` — configuration

---

## API Design

### New Endpoints

| Method | Path | Purpose | Epic |
|--------|------|---------|------|
| `GET` | `/api/config` | Current effective config | EPIC-004 |
| `PUT` | `/api/config` | Runtime config override | EPIC-004 |
| `GET` | `/api/config/defaults` | Default config values | EPIC-004 |
| `GET` | `/api/metrics` | Metrics summary | EPIC-006 |
| `GET` | `/api/metrics/health` | System health score | EPIC-006 |

### Existing Endpoints (Unchanged)

- `GET /api/tokens/summary` — token cost tracking
- `GET /api/tokens/by-agent` — per-agent breakdown
- `GET /api/tokens/daily` — daily time series
- All other existing API endpoints

---

## NFR Coverage

### NFR-001: Token Estimation < 5ms

**Requirement:** Estimation latency < 5ms for inputs up to 50K chars

**Solution:**
- `js-tiktoken` WASM tokenizer loaded as singleton on first call
- Subsequent calls reuse encoder instance — no re-initialization
- `estimate()` fast path uses byte-length heuristic for pre-screening

**Validation:**
- Unit test: benchmark 50K char Korean + English input, assert < 5ms
- Integration test: PromptSizeMonitor round-trip with real tokenizer

---

### NFR-002: Backward Compatibility

**Requirement:** Existing configs and behaviors unchanged

**Solution:**
- All new config fields are `optional` with defaults matching current hardcoded values
- Config resolution: new fields only activate if explicitly set
- `IModelRunner` interface is satisfied by existing `PersistentCLIAdapter` and `CodexMCPProcess` without changing their public API
- Metrics DB is separate file — no migration of existing DBs

**Validation:**
- Existing test suite passes without modification
- Fresh install with no config.yaml changes produces identical behavior

---

### NFR-003: Zero External Dependencies

**Requirement:** No Redis, Kafka, Prometheus — local-first only

**Solution:**
- Tokenizer: `js-tiktoken` (WASM, ~1.5MB, pure JS API)
- Metrics: SQLite (already in deps via better-sqlite3)
- Config: js-yaml (already in deps)
- Total new dep size: ~1.5MB

**Validation:**
- `pnpm install` delta < 2MB
- No new native compilation required

---

### NFR-004: Test Coverage 90%+

**Requirement:** New modules have 90%+ line coverage

**Solution:**
- TokenEstimator: test with Korean, English, mixed, code, empty input
- ConfigManager extensions: test valid, invalid, partial, missing, env override
- MetricsStore: test concurrent writes, cleanup, health score calculation
- SkillLoader: test short skills, long skills, section splitting, edge cases
- IModelRunner: test interface compliance for both backends

**Validation:**
- `vitest --coverage` reports per-file coverage
- CI gate at 90% for new files

---

### NFR-005: Observability Overhead < 1ms

**Requirement:** Metric writes must not impact request latency

**Solution:**
- `MetricsStore.record()` is synchronous SQLite insert in WAL mode (< 0.1ms typical)
- Wrapped in try-catch — failures logged, never thrown
- Cleanup runs on timer (every hour), not on write path
- Separate DB file prevents contention with session data

**Validation:**
- Benchmark: 1000 metric inserts, assert p99 < 1ms
- Stress test: concurrent metric writes during agent operation

---

## Development Architecture

### New Module Structure

```
packages/standalone/src/
├── agent/
│   ├── token-estimator.ts      (NEW - EPIC-001)
│   ├── skill-loader.ts         (NEW - EPIC-002, extracted from agent-loop.ts)
│   ├── model-runner.ts         (NEW - EPIC-003, interface definition)
│   ├── tool-registry.ts        (NEW - EPIC-005)
│   ├── prompt-size-monitor.ts  (MODIFIED - uses TokenEstimator)
│   ├── agent-loop.ts           (MODIFIED - uses IModelRunner, SkillLoader, config)
│   ├── persistent-cli-adapter.ts  (MODIFIED - implements IModelRunner)
│   ├── codex-mcp-process.ts       (MODIFIED - implements IModelRunner)
│   └── gateway-tool-executor.ts   (MODIFIED - uses ToolRegistry)
├── cli/config/
│   ├── types.ts                (MODIFIED - new config sections)
│   ├── config-manager.ts       (MODIFIED - env override, runtime API)
│   └── config-accessors.ts     (NEW - typed getters for each section)
├── metrics/
│   └── metrics-store.ts        (NEW - EPIC-006)
└── api/
    ├── config-handler.ts       (NEW - config REST endpoints)
    └── metrics-handler.ts      (NEW - metrics REST endpoints)
```

### Testing Strategy

| Module | Test Type | Key Cases |
|--------|-----------|-----------|
| TokenEstimator | Unit | Korean accuracy, English accuracy, mixed, empty, huge input, latency |
| SkillLoader | Unit | Short skill, long skill, section split, no sections, frontmatter |
| IModelRunner | Integration | Both backends satisfy interface, timeout from config |
| ConfigManager | Unit | Defaults, file, env override, runtime override, validation |
| ToolRegistry | Unit | Registration, generation, validation, missing handlers |
| MetricsStore | Unit + Integration | Insert, query, health score, cleanup, concurrency |

---

## Requirements Traceability

### FR → Component Mapping

| FR | Component | Files |
|----|-----------|-------|
| FR-001 Token Estimator | TokenEstimator + PromptSizeMonitor | token-estimator.ts, prompt-size-monitor.ts |
| FR-002 Skill Loading | SkillLoader | skill-loader.ts, agent-loop.ts |
| FR-003 CLI Backend | IModelRunner | model-runner.ts, persistent-cli-adapter.ts, codex-mcp-process.ts |
| FR-004 Gateway SSOT | ToolRegistry | tool-registry.ts, gateway-tool-executor.ts |
| FR-005 Config | ConfigManager + Accessors | types.ts, config-manager.ts, config-accessors.ts |
| FR-006 Observability | MetricsStore | metrics-store.ts, metrics-handler.ts |
| FR-007 Budget Enforcement | TokenEstimator + PromptSizeMonitor | token-estimator.ts, prompt-size-monitor.ts |

### NFR → Solution Mapping

| NFR | Solution | Validation |
|-----|----------|------------|
| NFR-001 < 5ms estimation | WASM singleton tokenizer | Benchmark test |
| NFR-002 Backward compat | Optional config fields, defaults | Existing tests pass |
| NFR-003 Zero deps | js-tiktoken WASM only | Dep size check |
| NFR-004 90% coverage | Per-module test suites | CI coverage gate |
| NFR-005 < 1ms metrics | Fire-and-forget SQLite WAL | Benchmark test |

---

## Trade-offs & Decision Log

### Decision 1: js-tiktoken over gpt-tokenizer

**Choice:** `js-tiktoken` (Rust→WASM) with `cl100k_base` encoding
**Trade-off:**
- Gain: Fast WASM execution, well-tested BPE tokenizer, best-available approximation for multilingual text
- Lose: ~1.5MB bundle size, WASM initialization time (~50ms cold start), **not an exact match for Claude's proprietary tokenizer**
**Rationale:** No public Claude tokenizer exists. `cl100k_base` is the closest available BPE encoding and significantly more accurate than `chars/4` for Korean text. Both `js-tiktoken` and `gpt-tokenizer` use OpenAI encodings — the differentiator is WASM performance vs pure JS. We monitor `token_estimation_error` metric post-deployment and adjust the approach if error exceeds 15%.

### Decision 2: Separate metrics.db

**Choice:** New `metrics.db` file instead of adding table to `mama-sessions.db`
**Trade-off:**
- Gain: No contention with session writes, independent cleanup, can delete without affecting sessions
- Lose: One more DB file to manage
**Rationale:** Metrics are high-write, low-read. Isolating them prevents WAL checkpoint contention with session data.

### Decision 3: Token-based thresholds over char-based

**Choice:** Convert all `*_CHARS` thresholds to `*_TOKENS`
**Trade-off:**
- Gain: Accurate budget enforcement regardless of language
- Lose: Slight overhead per check (tokenizer call instead of `.length`)
**Rationale:** The entire point of EPIC-001. Char-based thresholds are the root cause of Korean text issues.

### Decision 4: ToolRegistry as runtime object (not YAML file)

**Choice:** TypeScript `ToolRegistry` class with programmatic registration
**Trade-off:**
- Gain: Type safety, compile-time validation, handler co-location
- Lose: Not as readable as YAML/JSON config file
**Rationale:** Tool definitions need parameter types and handler references. A YAML file would require a separate validation step. TypeScript gives us both definition and validation.

### Decision 5: Config sections are optional objects

**Choice:** `prompt?: { ... }` optional sections rather than flat top-level fields
**Trade-off:**
- Gain: Organized, namespace-free, clear what's new vs existing
- Lose: Slightly more verbose access (`config.prompt?.warn_tokens`)
**Rationale:** 25+ new fields would pollute the flat MAMAConfig. Sections group related concerns. Accessor functions hide the verbosity.

---

## Implementation Sequence

```
Sprint 1: EPIC-004 (Config Externalization)
  ├── Extend MAMAConfig types
  ├── Add config-accessors.ts (async init + sync cache)
  ├── Add env variable resolution
  ├── Add config REST API
  └── Tests

Sprint 2: EPIC-001 (Token Accuracy) + EPIC-002 (Skill Loading)
  ├── TokenEstimator with js-tiktoken
  ├── PromptSizeMonitor migration to token-based
  ├── SkillLoader extraction + semantic split
  ├── FR-007 budget enforcement
  └── Tests

Sprint 3: EPIC-003 (CLI Backend Unification)
  ├── IModelRunner interface (sendToolResult optional)
  ├── ClaudeCliRunner adapter
  ├── CodexMcpRunner adapter
  ├── Agent process manager refactor
  └── Tests

Sprint 4: EPIC-005 (Gateway SSOT) + EPIC-006 (Observability)
  ├── ToolRegistry + build-time gateway-tools.md generation
  ├── MetricsStore (singleton, fire-and-forget)
  ├── Metric emission points
  ├── Health score API endpoints
  └── Integration tests
```

---

## Open Issues & Risks

| Risk | Mitigation |
|------|------------|
| `js-tiktoken` WASM may not load in all Node.js environments | Fallback to byte-length estimate; test in CI on ubuntu + macos |
| `cl100k_base` may not perfectly match Claude's tokenizer | Within 5% is acceptable; monitor estimation_error metric |
| Config file format change (new sections) may confuse users | New sections are optional; existing configs work unchanged |
| ToolRegistry refactor touches critical path (tool execution) | Feature flag: `MAMA_USE_TOOL_REGISTRY=true` for gradual rollout |

---

## Assumptions & Constraints

1. `js-tiktoken` `cl100k_base` encoding is an approximation for Claude tokenization — no public Claude tokenizer exists. Actual error rate will be measured post-deployment and calibrated via `calibrationFactor` config
2. SQLite WAL mode handles concurrent metric writes from single Node.js process
3. Existing `MAMAConfig` interface's `[key: string]: unknown` index signature allows new sections
4. Skills exceeding 8000 chars (4000 tokens) are rare edge cases
5. No multi-process MAMA OS deployment (single node assumption retained)

---

## Future Considerations

- **Distributed metrics**: If MAMA OS adds multi-node, MetricsStore can be swapped for shared store
- **OpenTelemetry export**: MetricsStore could add OTel exporter as optional feature
- **Auto-tuning**: Token thresholds could self-adjust based on observed estimation errors
- **Skill retrieval**: RAG-based skill chunk selection instead of priority-based truncation

---

## Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-02-24 | Jung Jaehoon | Initial architecture |

---

## Next Steps

Run `/sprint-planning` to:
- Break 6 epics into 18-24 detailed stories
- Assign story points
- Plan 4 sprint iterations per sequence above

---

**This document was created using BMAD Method v6 - Phase 3 (Solutioning)**
