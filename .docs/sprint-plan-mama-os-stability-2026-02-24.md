# Sprint Plan: MAMA OS Stability

**Date:** 2026-02-24
**Scrum Master:** Jung Jaehoon + Claude
**Project Level:** 3
**Total Stories:** 22
**Total Points:** 60
**Planned Sprints:** 4 (1-week sprints)
**Team Capacity:** ~15 points/sprint

---

## Executive Summary

MAMA OS Stability 작업을 22개 스토리(60 points)로 분해하여 4주 스프린트로 계획. Config Externalization을 기반으로 깔고, Token/Skill → CLI Backend → Gateway SSOT + Observability + Tool Filtering 순서로 진행. 각 스프린트는 독립적으로 릴리즈 가능한 단위.

**Key Metrics:**
- Total Stories: 22
- Total Points: 60
- Sprints: 4 × 1-week
- Team Capacity: ~15 points/sprint
- Target Completion: 2026-03-24

---

## Story Inventory

### EPIC-004: Configuration System (Sprint 1)

#### STORY-001: Define MAMAConfig type extensions

**Epic:** EPIC-004 Configuration System
**Priority:** Must Have

**User Story:**
As a developer,
I want typed config sections (prompt, timeouts, gateway, io, metrics)
So that all hardcoded constants have a single typed definition.

**Acceptance Criteria:**
- [ ] MAMAConfig interface extended with 5 optional sections
- [ ] DEFAULT_CONFIG object with all 25+ defaults matching current hardcoded values
- [ ] Type exports for each section (PromptConfig, TimeoutConfig, etc.)
- [ ] Existing MAMAConfig fields unchanged

**Technical Notes:**
- File: `packages/standalone/src/cli/config/types.ts`
- All new sections are `optional` — backward compatible
- Default values extracted from current hardcoded locations

**Dependencies:** None
**Points:** 2

---

#### STORY-002: Implement async init + sync cache ConfigManager

**Epic:** EPIC-004 Configuration System
**Priority:** Must Have

**User Story:**
As a developer,
I want `initConfig()` async load + `getConfig()` sync access
So that 25+ callsites in sync contexts can read config without async.

**Acceptance Criteria:**
- [ ] `initConfig()` loads config.yaml + merges env vars + validates
- [ ] `getConfig()` returns cached config synchronously
- [ ] `overrideConfig(partial)` updates in-memory cache
- [ ] Throws if `getConfig()` called before `initConfig()`
- [ ] `mama start` calls `initConfig()` before AgentLoop creation

**Technical Notes:**
- File: `packages/standalone/src/cli/config/config-manager.ts`
- Pattern: async init → sync cache (documented in architecture)
- Config validation: type + range check, warn on invalid, fallback to default

**Dependencies:** STORY-001
**Points:** 3

---

#### STORY-003: Environment variable override layer

**Epic:** EPIC-004 Configuration System
**Priority:** Must Have

**User Story:**
As an operator,
I want `MAMA_*` env vars to override config.yaml
So that I can customize behavior in CI/Docker without editing files.

**Acceptance Criteria:**
- [ ] Convention: `MAMA_` + SECTION + FIELD in SCREAMING_SNAKE_CASE
- [ ] Env vars override config file values
- [ ] At least 6 key env vars mapped: REQUEST_TIMEOUT_MS, WARN_TOKENS, METRICS_ENABLED, DEDUP_TTL_MS, MAX_READ_BYTES, SKILL_MAX_TOKENS
- [ ] Unmapped env vars ignored (no crash)

**Technical Notes:**
- `MAMA_REQUEST_TIMEOUT_MS → timeouts.request_ms`
- Priority: env > file > defaults

**Dependencies:** STORY-002
**Points:** 2

---

#### STORY-004: Config REST API endpoints

**Epic:** EPIC-004 Configuration System
**Priority:** Should Have

**User Story:**
As an operator,
I want `GET/PUT /api/config` endpoints
So that I can inspect and override config at runtime without restart.

**Acceptance Criteria:**
- [ ] `GET /api/config` returns effective merged config
- [ ] `PUT /api/config` applies in-memory override (non-persistent)
- [ ] `GET /api/config/defaults` returns defaults only
- [ ] PUT validates input (rejects invalid types/ranges)

**Technical Notes:**
- File: `packages/standalone/src/api/config-handler.ts` (NEW)
- Register routes in existing Express app

**Dependencies:** STORY-002
**Points:** 3

---

#### STORY-005: Migrate hardcoded constants to config

**Epic:** EPIC-004 Configuration System
**Priority:** Must Have

**User Story:**
As a developer,
I want all 25+ hardcoded constants replaced with `getConfig()` calls
So that operators can tune behavior without code changes.

**Acceptance Criteria:**
- [ ] All constants in FR-005 table replaced with config reads
- [ ] Each callsite uses typed accessor or `getConfig().section?.field ?? default`
- [ ] grep for old constant names returns 0 hits (except DEFAULT_CONFIG)
- [ ] All existing tests pass without modification

**Technical Notes:**
- Mechanical replacement across ~15 files
- Key files: prompt-size-monitor.ts, persistent-cli-process.ts, codex-mcp-process.ts, session-pool.ts, slack.ts, multi-agent-*.ts, agent-loop.ts

**Dependencies:** STORY-002
**Points:** 5

---

### EPIC-001: Token Accuracy (Sprint 2)

#### STORY-006: TokenEstimator with js-tiktoken

**Epic:** EPIC-001 Token Accuracy
**Priority:** Must Have

**User Story:**
As a developer,
I want a singleton TokenEstimator using cl100k_base
So that token counts are accurate for Korean + English text.

**Acceptance Criteria:**
- [ ] `count(text): number` returns token count
- [ ] `exceedsLimit(text, limit): boolean` convenience method
- [ ] Singleton — WASM loaded once on first call
- [ ] Fallback to `Math.ceil(byteLength * 0.4)` if WASM fails
- [ ] Latency < 5ms for 50K char input (benchmark test)
- [ ] Korean text error < 15%, English < 10%

**Technical Notes:**
- File: `packages/standalone/src/agent/token-estimator.ts` (NEW)
- `js-tiktoken` WASM, cl100k_base encoding
- New dependency: add `js-tiktoken` to standalone/package.json

**Dependencies:** None
**Points:** 5

---

#### STORY-007: Migrate PromptSizeMonitor to token-based

**Epic:** EPIC-001 Token Accuracy
**Priority:** Must Have

**User Story:**
As an operator,
I want prompt limits enforced in tokens not characters
So that Korean text gets accurate budget enforcement.

**Acceptance Criteria:**
- [ ] `WARN_CHARS` → `warn_tokens` (from config, default: 3750)
- [ ] `TRUNCATE_CHARS` → `truncate_tokens` (default: 6250)
- [ ] `HARD_LIMIT_CHARS` → `hard_limit_tokens` (default: 10000)
- [ ] `estimateTokens()` uses `tokenEstimator.count()`
- [ ] All threshold comparisons use token values

**Technical Notes:**
- File: `packages/standalone/src/agent/prompt-size-monitor.ts`
- Also update `decision-formatter.ts:373` and `agent-loop.ts:42`

**Dependencies:** STORY-005 (config), STORY-006 (estimator)
**Points:** 3

---

#### STORY-008: Token budget fail-closed enforcement

**Epic:** EPIC-001 Token Accuracy
**Priority:** Should Have

**User Story:**
As an operator,
I want hard token limits per model
So that oversized prompts fail explicitly instead of silent truncation.

**Acceptance Criteria:**
- [ ] Hard limit configurable per model (Claude=180K, Codex=120K)
- [ ] Exceeding hard limit returns structured error
- [ ] Budget breakdown (system + tools + history) visible in metrics
- [ ] Tested with oversized inputs

**Technical Notes:**
- Integrate with PromptSizeMonitor + MetricsStore
- Error type: `TokenBudgetExceededError`

**Dependencies:** STORY-006, STORY-007
**Points:** 3

---

### EPIC-002: Skill Loading (Sprint 2)

#### STORY-009: Extract SkillLoader from agent-loop.ts

**Epic:** EPIC-002 Skill Loading
**Priority:** Must Have

**User Story:**
As a developer,
I want skill loading logic in a dedicated module
So that it's testable and maintainable.

**Acceptance Criteria:**
- [ ] `skill-loader.ts` extracted from agent-loop.ts:155-180
- [ ] `loadSkillContent(path, maxTokens, estimator): SkillLoadResult`
- [ ] `SkillLoadResult` includes: content, truncated, omittedSections, originalChars
- [ ] agent-loop.ts calls SkillLoader instead of inline logic
- [ ] Existing behavior preserved (same output for same input)

**Technical Notes:**
- File: `packages/standalone/src/agent/skill-loader.ts` (NEW)
- Pure extraction first, then enhance

**Dependencies:** STORY-006 (TokenEstimator)
**Points:** 3

---

#### STORY-010: Semantic section-based skill truncation

**Epic:** EPIC-002 Skill Loading
**Priority:** Must Have

**User Story:**
As a skill author,
I want skills over the limit split at section boundaries
So that instructions aren't cut mid-sentence.

**Acceptance Criteria:**
- [ ] Parse skill into sections (split on `## ` or `---`)
- [ ] Include by priority: frontmatter → core → examples → appendix
- [ ] Omit lowest-priority sections when over budget
- [ ] Append `[Omitted: section_names]` marker
- [ ] Never cut mid-section
- [ ] `skill_max_tokens` configurable (default: 2000)

**Technical Notes:**
- Enhance SkillLoader from STORY-009
- Emit `skill_truncation` metric

**Dependencies:** STORY-009
**Points:** 3

---

### EPIC-003: CLI Backend Unification (Sprint 3)

#### STORY-011: Define IModelRunner interface

**Epic:** EPIC-003 CLI Backend
**Priority:** Must Have

**User Story:**
As a developer,
I want a shared ModelRunner interface
So that AgentLoop doesn't depend on concrete backends.

**Acceptance Criteria:**
- [ ] `IModelRunner` interface with: prompt(), sendToolResult?(), setSystemPrompt(), setSessionId(), isHealthy(), getMetrics(), stop(), backendType
- [ ] `RunnerMetrics` type defined
- [ ] `PromptResult` type defined
- [ ] Interface exported from `model-runner.ts`

**Technical Notes:**
- File: `packages/standalone/src/agent/model-runner.ts` (NEW)
- sendToolResult is optional (Claude only)

**Dependencies:** None
**Points:** 2

---

#### STORY-012: ClaudeCliRunner implements IModelRunner

**Epic:** EPIC-003 CLI Backend
**Priority:** Must Have

**User Story:**
As a developer,
I want PersistentCLIAdapter to implement IModelRunner
So that Claude backend is normalized.

**Acceptance Criteria:**
- [ ] PersistentCLIAdapter implements IModelRunner
- [ ] `isHealthy()` checks process state
- [ ] `getMetrics()` returns request count, failure count, avg latency
- [ ] `stop()` gracefully terminates
- [ ] Timeout reads from config (not hardcoded 120s)
- [ ] Existing tests pass

**Technical Notes:**
- File: `packages/standalone/src/agent/persistent-cli-adapter.ts`
- Additive changes — existing public API preserved

**Dependencies:** STORY-011, STORY-005 (config)
**Points:** 5

---

#### STORY-013: CodexMcpRunner implements IModelRunner

**Epic:** EPIC-003 CLI Backend
**Priority:** Must Have

**User Story:**
As a developer,
I want CodexMCPProcess to implement IModelRunner
So that Codex backend matches Claude interface.

**Acceptance Criteria:**
- [ ] CodexMCPProcess implements IModelRunner
- [ ] Missing methods added: isHealthy(), getMetrics(), stop()
- [ ] Timeout reads from config (not hardcoded 180s)
- [ ] backendType = 'codex-mcp'

**Technical Notes:**
- File: `packages/standalone/src/agent/codex-mcp-process.ts`

**Dependencies:** STORY-011, STORY-005 (config)
**Points:** 3

---

#### STORY-014: AgentLoop uses IModelRunner

**Epic:** EPIC-003 CLI Backend
**Priority:** Must Have

**User Story:**
As a developer,
I want AgentLoop to depend on IModelRunner interface
So that backend switching is safe and testable.

**Acceptance Criteria:**
- [ ] `agent: PersistentCLIAdapter | CodexMCPProcess` → `agent: IModelRunner`
- [ ] Error types standardized (timeout, crash, context_overflow, auth_failure)
- [ ] AgentLoop uses `agent.isHealthy()` and `agent.getMetrics()`
- [ ] All existing tests pass

**Technical Notes:**
- File: `packages/standalone/src/agent/agent-loop.ts`
- Import IModelRunner, remove concrete type unions

**Dependencies:** STORY-012, STORY-013
**Points:** 3

---

#### STORY-015: Agent process manager refactor

**Epic:** EPIC-003 CLI Backend
**Priority:** Should Have

**User Story:**
As a developer,
I want process pool creation to use IModelRunner factory
So that new backends can be added without modifying pool logic.

**Acceptance Criteria:**
- [ ] Process pool creates runners via factory function
- [ ] Factory selects backend based on agent config
- [ ] Hot-reload (updateConfig) stops all pools correctly
- [ ] Process restart metrics emitted

**Technical Notes:**
- File: `packages/standalone/src/agent/agent-process-manager.ts`

**Dependencies:** STORY-012, STORY-013
**Points:** 3

---

### EPIC-005: Gateway Tools SSOT & Tool Filtering (Sprint 4)

#### STORY-016: ToolRegistry core implementation

**Epic:** EPIC-005 Gateway SSOT
**Priority:** Should Have

**User Story:**
As a developer,
I want a ToolRegistry that is the single source of truth for all gateway tools
So that tool definitions don't drift across 3 files.

**Acceptance Criteria:**
- [ ] `ToolRegistry` class with register(), getValidToolNames(), generatePrompt(), generateFallbackPrompt()
- [ ] All current VALID_TOOLS registered
- [ ] `validateHandlers(executor)` returns list of missing handlers
- [ ] Build test fails if registry and executor mismatch

**Technical Notes:**
- File: `packages/standalone/src/agent/tool-registry.ts` (NEW)
- Migrate tools from gateway-tool-executor.ts VALID_TOOLS array

**Dependencies:** None
**Points:** 3

---

#### STORY-017: Build-time gateway-tools.md generation

**Epic:** EPIC-005 Gateway SSOT
**Priority:** Should Have

**User Story:**
As a developer,
I want gateway-tools.md generated from ToolRegistry at build time
So that docs and code never drift.

**Acceptance Criteria:**
- [ ] Build step generates `dist/agent/gateway-tools.md` from registry
- [ ] Fallback prompt also generated from registry
- [ ] Hand-maintained `src/agent/gateway-tools.md` replaced with generated version
- [ ] Adding a tool = edit registry + implement handler (1 file change + 1 handler)

**Technical Notes:**
- Add build script or postbuild step
- Delete hand-maintained fallback string in agent-loop.ts

**Dependencies:** STORY-016
**Points:** 3

---

#### STORY-018: Per-agent allowed_tools filtering

**Epic:** EPIC-005 Tool Filtering (FR-008)
**Priority:** Should Have

**User Story:**
As an operator,
I want each agent to only see the tools it needs
So that token budget isn't wasted on irrelevant tool descriptions.

**Acceptance Criteria:**
- [ ] `AgentPersonaConfig.allowed_tools?: string[]` field added
- [ ] `ToolRegistry.getFilteredTools(allowedTools?)` returns subset
- [ ] `generatePrompt(allowedTools?)` only includes filtered tools
- [ ] Omitted = all tools (backward compatible)
- [ ] `tools_filtered_count` metric emitted
- [ ] Hard enforcement: GatewayToolExecutor rejects calls not in allowed_tools

**Technical Notes:**
- Estimated token savings: ~2K-4K per agent per turn
- Community feedback (dev.to) drove this requirement

**Dependencies:** STORY-016
**Points:** 5

---

### EPIC-006: Observability (Sprint 4)

#### STORY-019: MetricsStore SQLite implementation

**Epic:** EPIC-006 Observability
**Priority:** Should Have

**User Story:**
As an operator,
I want structured metrics stored in SQLite
So that I can diagnose operational issues.

**Acceptance Criteria:**
- [ ] `metrics` table: (id, name, value, labels, created_at)
- [ ] Indexes: `idx_metrics_name_ts`, `idx_metrics_ts`
- [ ] Separate DB file: `~/.mama/data/metrics.db`
- [ ] `record()` fire-and-forget (never throws)
- [ ] `query()` returns count/sum/avg/max
- [ ] `cleanup()` removes old metrics
- [ ] Singleton pattern: `initMetrics()` + `getMetrics()`

**Technical Notes:**
- File: `packages/standalone/src/metrics/metrics-store.ts` (NEW)
- WAL mode for concurrent writes
- No-op stub when not initialized

**Dependencies:** STORY-005 (config for retention_days)
**Points:** 5

---

#### STORY-020: Metric emission points

**Epic:** EPIC-006 Observability
**Priority:** Should Have

**User Story:**
As an operator,
I want metrics emitted from AgentLoop, ToolExecutor, ProcessPool, PromptMonitor
So that I have visibility into system behavior.

**Acceptance Criteria:**
- [ ] `turn_count` from AgentLoop
- [ ] `tool_failure` from GatewayToolExecutor
- [ ] `process_restart` from PersistentProcessPool
- [ ] `prompt_truncation` from PromptSizeMonitor
- [ ] `skill_load` + `skill_truncation` from SkillLoader
- [ ] `request_duration_ms` from IModelRunner

**Technical Notes:**
- Add `getMetrics().record(...)` calls to each emitter
- Each record includes relevant labels (agent_id, channel, etc.)

**Dependencies:** STORY-019
**Points:** 3

---

#### STORY-021: Health score API

**Epic:** EPIC-006 Observability
**Priority:** Should Have

**User Story:**
As an operator,
I want a `/api/metrics/health` endpoint
So that monitoring can alert on degradation.

**Acceptance Criteria:**
- [ ] `GET /api/metrics` returns last-1h summary
- [ ] `GET /api/metrics?name=tool_failure` filtered query
- [ ] `GET /api/metrics/health` returns green/yellow/red
- [ ] Thresholds: green < 5% failure, yellow 5-15%, red > 15%
- [ ] Thresholds configurable via config

**Technical Notes:**
- File: `packages/standalone/src/api/metrics-handler.ts` (NEW)

**Dependencies:** STORY-019, STORY-020
**Points:** 3

---

#### STORY-022: Metrics auto-cleanup

**Epic:** EPIC-006 Observability
**Priority:** Should Have

**User Story:**
As an operator,
I want metrics auto-cleaned after retention period
So that disk usage stays bounded.

**Acceptance Criteria:**
- [ ] Timer-based cleanup (every 1h)
- [ ] Retention days from config (default: 7)
- [ ] Cleanup count logged
- [ ] Cleanup failure doesn't crash main process

**Technical Notes:**
- Use setInterval in MetricsStore constructor
- `DELETE FROM metrics WHERE created_at < ?`

**Dependencies:** STORY-019
**Points:** 2

---

## Sprint Allocation

### Sprint 1 (Week 1) — Config Foundation — 15/15 points

**Goal:** 모든 hardcoded 상수를 설정 시스템으로 이관. 다른 모든 Epic의 기반.

| Story | Title | Points | Priority |
|-------|-------|--------|----------|
| STORY-001 | MAMAConfig type extensions | 2 | Must |
| STORY-002 | Async init + sync cache ConfigManager | 3 | Must |
| STORY-003 | Environment variable override | 2 | Must |
| STORY-004 | Config REST API | 3 | Should |
| STORY-005 | Migrate hardcoded constants | 5 | Must |

**Total:** 15 points (100% capacity)
**Risks:** STORY-005가 ~15 파일 수정 — regression 주의
**Deliverable:** `mama start` with config.yaml + env override 동작

---

### Sprint 2 (Week 2) — Token Accuracy + Skill Loading — 17/15 points

**Goal:** Korean 토큰 추정 정확도 달성, 스킬 잘림 제거.

| Story | Title | Points | Priority |
|-------|-------|--------|----------|
| STORY-006 | TokenEstimator (js-tiktoken) | 5 | Must |
| STORY-007 | PromptSizeMonitor token migration | 3 | Must |
| STORY-008 | Token budget fail-closed | 3 | Should |
| STORY-009 | SkillLoader extraction | 3 | Must |
| STORY-010 | Semantic skill truncation | 3 | Must |

**Total:** 17 points (113% — stretch sprint, offset by STORY-009 being mechanical extraction)
**Risks:** js-tiktoken WASM 호환성; 벤치마크 미달 시 fallback 사용
**Deliverable:** Korean token error < 15%, skills never hard-truncated

---

### Sprint 3 (Week 3) — CLI Backend Unification — 16/15 points

**Goal:** IModelRunner 인터페이스로 Claude/Codex 백엔드 통합.

| Story | Title | Points | Priority |
|-------|-------|--------|----------|
| STORY-011 | IModelRunner interface | 2 | Must |
| STORY-012 | ClaudeCliRunner implementation | 5 | Must |
| STORY-013 | CodexMcpRunner implementation | 3 | Must |
| STORY-014 | AgentLoop uses IModelRunner | 3 | Must |
| STORY-015 | Process manager refactor | 3 | Should |

**Total:** 16 points (107% — slight stretch)
**Risks:** 기존 테스트 깨짐 가능성 — interface compliance 먼저 검증
**Deliverable:** AgentLoop이 concrete type 대신 interface에 의존

---

### Sprint 4 (Week 4) — Gateway SSOT + Tool Filtering + Observability — 24/15 points

**Goal:** Tool 정의 단일화, 에이전트별 도구 필터링, 운영 메트릭 수집.

| Story | Title | Points | Priority |
|-------|-------|--------|----------|
| STORY-016 | ToolRegistry core | 3 | Should |
| STORY-017 | Build-time gateway-tools.md | 3 | Should |
| STORY-018 | Per-agent allowed_tools | 5 | Should |
| STORY-019 | MetricsStore SQLite | 5 | Should |
| STORY-020 | Metric emission points | 3 | Should |
| STORY-021 | Health score API | 3 | Should |
| STORY-022 | Metrics auto-cleanup | 2 | Should |

**Total:** 24 points (160% — will likely spill to Week 5)
**Risks:** 가장 큰 스프린트. STORY-018과 STORY-019가 각각 5pts. 필요시 STORY-021, 022를 다음 주로 이월.
**Deliverable:** Tool registry SSOT, per-agent filtering, operational metrics

---

## Epic Traceability

| Epic ID | Epic Name | Stories | Points | Sprint |
|---------|-----------|---------|--------|--------|
| EPIC-004 | Configuration System | 001-005 | 15 | 1 |
| EPIC-001 | Token Accuracy | 006-008 | 11 | 2 |
| EPIC-002 | Skill Loading | 009-010 | 6 | 2 |
| EPIC-003 | CLI Backend Unification | 011-015 | 16 | 3 |
| EPIC-005 | Gateway SSOT & Tool Filtering | 016-018 | 11 | 4 |
| EPIC-006 | Observability | 019-022 | 13 | 4 |
| **Total** | | **22 stories** | **72 pts** | **4 sprints** |

---

## FR Coverage

| FR | Stories | Sprint |
|----|---------|--------|
| FR-001 Token Estimator | STORY-006, 007 | 2 |
| FR-002 Skill Loading | STORY-009, 010 | 2 |
| FR-003 CLI Backend | STORY-011-015 | 3 |
| FR-004 Gateway SSOT | STORY-016, 017 | 4 |
| FR-005 Config | STORY-001-005 | 1 |
| FR-006 Observability | STORY-019-022 | 4 |
| FR-007 Budget Enforcement | STORY-008 | 2 |
| FR-008 Tool Filtering | STORY-018 | 4 |

All 8 FRs covered.

---

## Risks and Mitigation

**High:**
- Sprint 4 overloaded (24 pts vs 15 capacity) — mitigation: STORY-021/022 이월 허용, 핵심(016-019)만 우선
- js-tiktoken WASM Node 22 호환 — mitigation: fallback to byte-length estimate

**Medium:**
- STORY-005 (25+ constant 교체) regression — mitigation: 파일별 커밋, 기존 테스트 전부 통과 확인
- IModelRunner 인터페이스 호환 — mitigation: 기존 public API 유지, additive only

**Low:**
- cl100k_base ↔ Claude tokenizer 오차 — mitigation: token_estimation_error 메트릭 모니터링
- Config file format 혼란 — mitigation: 새 섹션 optional, 기존 config 무변경 동작

---

## Definition of Done

Story 완료 조건:
- [ ] 코드 구현 + 커밋
- [ ] Unit test 작성 (새 모듈 90%+ coverage)
- [ ] `pnpm test` 전체 통과
- [ ] `pnpm typecheck` 통과
- [ ] 관련 기존 테스트 수정 없이 통과
- [ ] 필요시 CHANGELOG 업데이트

---

## Next Steps

**즉시:** Sprint 1 시작

```
/dev-story STORY-001  → MAMAConfig type extensions
/dev-story STORY-002  → ConfigManager async init + sync cache
```

**Sprint 진행:**
- Sprint 1: Config foundation (이번 주)
- Sprint 2: Token accuracy + Skill loading
- Sprint 3: CLI backend unification
- Sprint 4: Gateway SSOT + Tool filtering + Observability

---

**This plan was created using BMAD Method v6 - Phase 4 (Implementation Planning)**
