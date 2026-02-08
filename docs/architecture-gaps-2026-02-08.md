# Architecture Gap Analysis

**Date:** 2026-02-08  
**Author:** System Architect (Sisyphus)  
**Purpose:** Identify gaps between implementation, documentation, and requirements  
**Related:** `docs/implementation-plan-enforcement-layer-2026-02-08.md`

---

## Executive Summary

This gap analysis compares what's **implemented in code** vs what's **documented** vs what's **needed** for MAMA's multi-agent architecture. The analysis reveals significant undocumented features (parallel execution infrastructure), documented-but-unimplemented features (MidTurnInjector), and critical missing enforcement capabilities.

**Key Findings:**

- **7 major features** implemented but not documented (pool_size, WaveEngine parallelism, hung process detection, etc.)
- **1 documented feature** impossible to implement (MidTurnInjector - Claude CLI protocol limitation)
- **4 critical features** needed but neither implemented nor documented (Enforcement Layer components)
- **12 Quick Wins** identified (< 1 hour each, mostly documentation updates)

---

## Summary Table

| Category                           | Count  | Impact   | Quick Wins |
| ---------------------------------- | ------ | -------- | ---------- |
| **Implemented but NOT Documented** | 7      | Major    | 6          |
| **Documented but NOT Implemented** | 1      | Minor    | 1          |
| **Needed but Neither**             | 4      | Critical | 5          |
| **Total Gaps**                     | **12** | -        | **12**     |

---

## Category 1: Implemented but NOT Documented

Features that exist in code but are missing or incomplete in docs/README.

### Gap 1.1: `pool_size` Configuration

**Description:** Per-agent process pool configuration exists in code but is completely undocumented in README.

**Code Evidence:**

- `packages/standalone/src/multi-agent/agent-process-pool.ts` (356 lines, full implementation)
- `packages/standalone/src/multi-agent/agent-process-manager.ts` line 81: `defaultPoolSize: 1`
- `packages/standalone/src/multi-agent/agent-process-manager.ts` lines 73-78: Per-agent pool size extraction from config
- Test coverage: `packages/standalone/tests/agent/persistent-cli-process-tools.test.ts`

**Where it should be:** `packages/standalone/README.md` Multi-Agent Swarm section

**Current Status:**

- ✅ Fully implemented with configurable pool sizes
- ✅ Automatic process reuse when idle
- ✅ Pool capacity management (throws when full)
- ✅ Idle timeout cleanup (10 min default)
- ❌ Zero documentation in README

**Impact Level:** **Major** - Users cannot leverage parallel execution without knowing this exists

**Quick Win?** **Yes** - Add 15-line YAML example to README (~30 minutes)

**Recommended Fix:**

```yaml
# Add to packages/standalone/README.md Multi-Agent Swarm section
multi_agent:
  agents:
    developer:
      pool_size: 5 # Enable 5 parallel processes (default: 1)
      # Allows 5 concurrent tasks per agent
      # Increases throughput 5x for parallel workloads
```

---

### Gap 1.2: AgentProcessPool Parallel Execution

**Description:** Full process pooling infrastructure exists but README only mentions "Multi-Agent Swarm" without explaining process pooling mechanics.

**Code Evidence:**

- `packages/standalone/src/multi-agent/agent-process-pool.ts`:
  - `getAvailableProcess()` - Finds idle process or creates new one (lines 107-160)
  - `releaseProcess()` - Returns process to pool (lines 168-196)
  - `cleanupIdleProcesses()` - Auto-cleanup after timeout (lines 275-302)
  - `cleanupHungProcesses()` - Kills stuck processes (lines 311-341)

**Where it should be:** `packages/standalone/README.md` Architecture section

**Current Status:**

- ✅ Pool status monitoring (`getPoolStatus()`)
- ✅ Per-agent pool size overrides
- ✅ Automatic idle/hung process cleanup
- ❌ Not mentioned in README at all

**Impact Level:** **Major** - Users don't understand how parallel execution works

**Quick Win?** **Yes** - Add architecture diagram to README (~45 minutes)

**Recommended Fix:**
Add to README Architecture section:

```
### Process Pool Architecture

Each agent can maintain multiple Claude CLI processes:
- pool_size=1: Single process (default, backward compatible)
- pool_size=5: Up to 5 parallel processes per agent
- Automatic reuse: Idle processes are reused for new tasks
- Auto-cleanup: Idle processes terminate after 10 minutes
- Hung detection: Processes stuck >15 minutes are killed
```

---

### Gap 1.3: WaveEngine Parallel Execution

**Description:** WaveEngine executes tasks within each wave in parallel using `Promise.all`, but README doesn't explain this.

**Code Evidence:**

- `packages/standalone/src/multi-agent/swarm/wave-engine.ts` line 111:
  ```typescript
  const waveResults = await Promise.all(
    wave.tasks.map(async (task) => {
      // Execute all tasks in this wave in parallel
  ```
- Sequential wave progression (Wave 1 → Wave 2 → Wave 3)
- Parallel task execution within each wave

**Where it should be:** `packages/standalone/README.md` Multi-Agent Swarm section

**Current Status:**

- ✅ Implemented: Sequential waves, parallel tasks
- ✅ Fail-forward behavior (failed tasks don't block siblings)
- ❌ README says "5-Stage Message Routing" but doesn't explain wave parallelism

**Impact Level:** **Major** - Users don't understand wave execution model

**Quick Win?** **Yes** - Add 10-line explanation to README (~20 minutes)

**Recommended Fix:**

```markdown
### Wave Execution Model

Waves execute **sequentially**, tasks within each wave execute **in parallel**:

Wave 1: [Task A, Task B, Task C] ← All run in parallel
↓ (wait for all to complete)
Wave 2: [Task D, Task E] ← All run in parallel
↓
Wave 3: [Task F]
```

---

### Gap 1.4: Plan-Execute Separation (3-Phase Planning Protocol)

**Description:** Hard gate delegation validator and 3-phase planning protocol (Prometheus/Metis/Momus) implemented in commit 901c451 but not documented.

**Code Evidence:**

- `packages/standalone/src/multi-agent/delegation-format-validator.ts` - Validates 6-section delegation format
- Persona files reference Prometheus (planning), Metis (wisdom), Momus (critique)
- Commit 901c451: "Add hard gate delegation validator"

**Where it should be:** `packages/standalone/README.md` Delegation section

**Current Status:**

- ✅ Implemented: 6-section validation
- ✅ Hard gate: Invalid delegations rejected
- ❌ Not documented in README

**Impact Level:** **Major** - Users don't know delegation format requirements

**Quick Win?** **Yes** - Add delegation format example to README (~30 minutes)

**Recommended Fix:**
Add to README Delegation section:

```markdown
### Delegation Format (6-Section Structure)

All delegations must follow this structure:

1. TASK - Exact work to be done
2. EXPECTED OUTCOME - Files to create/modify, verification commands
3. REQUIRED TOOLS - Tools and their purpose
4. MUST DO - Mandatory patterns/rules
5. MUST NOT DO - Forbidden actions
6. CONTEXT - Background information

Invalid delegations are automatically rejected.
```

---

### Gap 1.5: `--allowedTools` / `--disallowedTools` CLI Flags

**Description:** Structural tool enforcement via CLI flags is wired through `PersistentProcessOptions` → `buildArgs()` but not documented.

**Code Evidence:**

- `packages/standalone/src/agent/persistent-cli-process.ts` lines 50-53:
  ```typescript
  /** Structurally allowed tools (--allowedTools CLI flag) */
  allowedTools?: string[];
  /** Structurally disallowed tools (--disallowedTools CLI flag) */
  disallowedTools?: string[];
  ```
- `packages/standalone/src/agent/persistent-cli-process.ts` lines 245-249:
  ```typescript
  if (this.options.allowedTools?.length) {
    args.push('--allowedTools', ...this.options.allowedTools);
  }
  if (this.options.disallowedTools?.length) {
    args.push('--disallowedTools', ...this.options.disallowedTools);
  }
  ```
- `packages/standalone/src/multi-agent/agent-process-manager.ts` lines 188-191, 242-245: Tool permissions applied per agent

**Where it should be:** `packages/standalone/README.md` Agent Tier System section

**Current Status:**

- ✅ Implemented: CLI flag generation
- ✅ Per-agent tool permissions
- ✅ Test coverage: `persistent-cli-process-tools.test.ts`
- ❌ Not mentioned in README

**Impact Level:** **Major** - Users don't know how tier-based tool access works

**Quick Win?** **Yes** - Add config example to README (~20 minutes)

**Recommended Fix:**

```yaml
# Add to README Agent Tier System section
multi_agent:
  agents:
    reviewer:
      tier: 2
      tool_permissions:
        allowed: ['Read', 'Grep', 'Glob'] # Read-only tools
        blocked: ['Write', 'Edit', 'Bash'] # No file modifications
```

---

### Gap 1.6: Hung Process Detection

**Description:** Hung process detection with 15-minute timeout exists but is not documented.

**Code Evidence:**

- `packages/standalone/src/multi-agent/agent-process-pool.ts` line 93:
  ```typescript
  hungTimeoutMs: options?.hungTimeoutMs ?? 900000, // 15 minutes
  ```
- `packages/standalone/src/multi-agent/agent-process-pool.ts` lines 311-341: `cleanupHungProcesses()` implementation

**Where it should be:** `packages/standalone/README.md` Troubleshooting section

**Current Status:**

- ✅ Implemented: 15-minute hung timeout
- ✅ Automatic process killing
- ✅ Configurable timeout
- ❌ Not documented

**Impact Level:** **Minor** - Automatic safety feature, but users should know it exists

**Quick Win?** **Yes** - Add to Troubleshooting section (~15 minutes)

**Recommended Fix:**

```markdown
### Hung Process Detection

MAMA automatically detects and kills hung processes:

- Default timeout: 15 minutes
- Processes busy longer than timeout are killed
- Configurable via AgentProcessPoolOptions.hungTimeoutMs
```

---

### Gap 1.7: Idle Process Cleanup

**Description:** Idle process cleanup with 10-minute timeout exists but is not documented.

**Code Evidence:**

- `packages/standalone/src/multi-agent/agent-process-pool.ts` line 92:
  ```typescript
  idleTimeoutMs: options?.idleTimeoutMs ?? 600000, // 10 minutes
  ```
- `packages/standalone/src/multi-agent/agent-process-pool.ts` lines 275-302: `cleanupIdleProcesses()` implementation

**Where it should be:** `packages/standalone/README.md` Configuration section

**Current Status:**

- ✅ Implemented: 10-minute idle timeout
- ✅ Automatic cleanup
- ✅ Configurable timeout
- ❌ Not documented

**Impact Level:** **Minor** - Resource management feature

**Quick Win?** **Yes** - Add to Configuration section (~15 minutes)

**Recommended Fix:**

```yaml
# Add to README Configuration section
multi_agent:
  process_pool:
    idle_timeout_minutes: 10 # Auto-terminate idle processes
    hung_timeout_minutes: 15 # Kill stuck processes
```

---

## Category 2: Documented but NOT Implemented

Features mentioned in docs/PRDs but not actually in code.

### Gap 2.1: MidTurnInjector

**Description:** Referenced in EPIC-E6 and PRD as a planned feature, but impossible to implement due to Claude CLI protocol limitations.

**Documentation Evidence:**

- `.docs/epics/EPIC-E6-mid-turn-injection.md` (236 lines, full spec)
- `.docs/prd-multi-agent-workflow-v2-2026-02-08.md` mentions mid-turn injection

**Code Evidence:**

- ❌ No files matching "MidTurnInjector", "mid-turn", or "mid_turn" in TypeScript files
- ❌ No implementation in `packages/standalone/src/multi-agent/`

**Why Not Implemented:**
Claude CLI protocol doesn't support mid-turn message injection. The CLI operates in request-response cycles with no mechanism to inject messages during an active turn.

**Current Status:**

- ❌ Not implemented
- ❌ Cannot be implemented with current Claude CLI
- ✅ Alternative exists: Turn-boundary TodoTracker (80% of desired effect)

**Impact Level:** **Minor** - Alternative approach achieves most benefits

**Quick Win?** **Yes** - Update EPIC-E6 status to "Deferred" (~10 minutes)

**Recommended Fix:**
Update `.docs/epics/EPIC-E6-mid-turn-injection.md`:

```markdown
**Status:** Deferred (Claude CLI Protocol Limitation)

**Reason:** Claude CLI operates in request-response cycles with no mid-turn injection support.

**Alternative:** Turn-boundary TodoTracker achieves 80% of desired effect:

- Inject reminders at turn boundaries (after tool_use, before next assistant turn)
- Background task completion notifications in next turn
- Anti-pattern warnings in next turn

**Future:** If Claude CLI adds mid-turn injection support, revisit this EPIC.
```

---

## Category 3: Needed but Neither Implemented Nor Documented

Features identified as needed but don't exist anywhere.

### Gap 3.1: ResponseValidator (Enforcement Layer)

**Description:** Flattery detection and response quality validation needed to prevent "excellent work" spam.

**Evidence of Need:**

- `.docs/prd-multi-agent-workflow-v2-2026-02-08.md` FR-001: Response Validator & Rejection Engine
- Checkpoint 132 mentions "칭찬, APPROVE, 작업 중단" as problems
- oh-my-opencode has 40+ enforcement hooks (40% token reduction)

**Code Evidence:**

- ❌ No `ResponseValidator` class exists
- ❌ No flattery detection patterns
- ❌ No response rejection mechanism

**Where it should be:** `packages/standalone/src/enforcement/response-validator.ts`

**Current Status:**

- ❌ Not implemented
- ❌ Not documented
- ✅ PRD exists with detailed spec

**Impact Level:** **Critical** - 40% token waste on flattery (oh-my-opencode data)

**Quick Win?** **No** - Requires 4-8 hours implementation + testing

**Recommended Implementation:**

```typescript
// packages/standalone/src/enforcement/response-validator.ts
export class ResponseValidator {
  private flatteryPatterns = [
    /great question/i,
    /excellent idea/i,
    /perfect implementation/i,
    /enterprise-grade/i,
    /완벽/,
    /훌륭/,
    /엔터프라이즈급/,
  ];

  validate(response: string): ValidationResult {
    const flatteryMatch = this.detectFlattery(response);
    if (flatteryMatch && flatteryMatch.ratio > 0.2) {
      return {
        valid: false,
        reason: 'Flattery detected',
        matched: flatteryMatch.patterns,
      };
    }
    return { valid: true };
  }
}
```

---

### Gap 3.2: ReviewGate (Evidence-Based APPROVE)

**Description:** APPROVE messages must include evidence (tests passed, verified, checked), not just "looks good".

**Evidence of Need:**

- `.docs/prd-multi-agent-workflow-v2-2026-02-08.md` mentions evidence-based validation
- Checkpoint 132: "APPROVE" as a problem pattern

**Code Evidence:**

- ❌ No `ReviewGate` class exists
- ❌ No evidence pattern matching
- ❌ No APPROVE validation

**Where it should be:** `packages/standalone/src/enforcement/review-gate.ts`

**Current Status:**

- ❌ Not implemented
- ❌ Not documented
- ✅ Need identified in PRD

**Impact Level:** **Critical** - Prevents rubber-stamp approvals

**Quick Win?** **No** - Requires 4-6 hours implementation + testing

**Recommended Implementation:**

```typescript
// packages/standalone/src/enforcement/review-gate.ts
export class ReviewGate {
  private evidencePatterns = [
    /tests? pass/i,
    /verified/i,
    /checked/i,
    /confirmed/i,
    /테스트 통과/,
    /확인했/,
  ];

  checkEvidence(response: string): boolean {
    const hasApprove = /\bAPPROVE\b/i.test(response);
    if (!hasApprove) return true; // Not an approval, pass through

    // APPROVE must have evidence
    return this.evidencePatterns.some((p) => p.test(response));
  }
}
```

---

### Gap 3.3: ScopeGuard (Scope Creep Detection)

**Description:** Detect when agents modify files outside their assigned scope.

**Evidence of Need:**

- `.docs/prd-multi-agent-workflow-v2-2026-02-08.md` mentions scope enforcement
- Common problem: "Fix auth bug" → agent refactors entire codebase

**Code Evidence:**

- ❌ No `ScopeGuard` class exists
- ❌ No git diff parsing
- ❌ No scope violation detection

**Where it should be:** `packages/standalone/src/enforcement/scope-guard.ts`

**Current Status:**

- ❌ Not implemented
- ❌ Not documented
- ✅ Need identified in PRD

**Impact Level:** **Major** - Prevents scope creep and unintended changes

**Quick Win?** **No** - Requires 6-8 hours implementation + testing

**Recommended Implementation:**

```typescript
// packages/standalone/src/enforcement/scope-guard.ts
export class ScopeGuard {
  checkScope(task: string, gitDiff: string): ScopeViolation[] {
    const allowedFiles = this.extractFilesFromTask(task);
    const modifiedFiles = this.parseGitDiff(gitDiff);

    return modifiedFiles
      .filter((file) => !allowedFiles.includes(file))
      .map((file) => ({
        file,
        reason: 'Modified file not mentioned in task',
      }));
  }
}
```

---

### Gap 3.4: TodoTracker (Turn-Boundary Task Tracking)

**Description:** Track task completion progress and remind agents of incomplete items at turn boundaries.

**Evidence of Need:**

- `.docs/epics/EPIC-E6-mid-turn-injection.md` E6-S2: TodoTracker spec
- Alternative to MidTurnInjector (which is impossible)

**Code Evidence:**

- ❌ No `TodoTracker` class exists
- ❌ No EXPECTED OUTCOME parsing
- ❌ No completion marker detection

**Where it should be:** `packages/standalone/src/enforcement/todo-tracker.ts`

**Current Status:**

- ❌ Not implemented
- ✅ Documented in EPIC-E6
- ✅ Achieves 80% of MidTurnInjector benefits

**Impact Level:** **Major** - Prevents incomplete task submissions

**Quick Win?** **No** - Requires 6-8 hours implementation + testing

**Recommended Implementation:**

```typescript
// packages/standalone/src/enforcement/todo-tracker.ts
export class TodoTracker {
  createFromExpectedOutcome(sessionId: string, outcome: string): TodoItem[] {
    // Parse "- [ ] item" patterns
    return outcome.match(/- \[ \] .+/g)?.map(parseItem) || [];
  }

  updateFromResponse(sessionId: string, response: string): void {
    // Detect completion markers: DONE, 완료, TASK_COMPLETE
    // Match file creation/modification patterns
  }

  getReminderMessage(sessionId: string): string | null {
    const incomplete = this.getIncomplete(sessionId);
    if (incomplete.length === 0) return null;
    return `Remaining: ${incomplete.length} items. Next: ${incomplete[0].description}`;
  }
}
```

---

### Gap 3.5: Observability/Metrics Aggregation

**Description:** Hook metrics are logged but never analyzed or aggregated.

**Evidence of Need:**

- `packages/mama-core/src/mama/hook-metrics.js` writes metrics to files
- No aggregation, no dashboard, no analysis

**Code Evidence:**

- ✅ Metrics logged: `hook-metrics.js`
- ❌ No aggregation logic
- ❌ No metrics API
- ❌ No dashboard

**Where it should be:** `packages/standalone/src/observability/metrics-aggregator.ts`

**Current Status:**

- ⚠️ Partially implemented (logging only)
- ❌ No aggregation or analysis
- ❌ Not documented

**Impact Level:** **Major** - Cannot measure enforcement effectiveness

**Quick Win?** **Yes** - Add basic aggregation script (~1 hour)

**Recommended Implementation:**

```typescript
// packages/standalone/src/observability/metrics-aggregator.ts
export class MetricsAggregator {
  aggregateHookMetrics(logDir: string): HookMetrics {
    // Read all hook-metrics-*.json files
    // Aggregate by hook type, agent, time period
    // Calculate: avg duration, success rate, error rate
  }

  generateReport(): string {
    // Markdown report with charts
  }
}
```

---

## Quick Wins Summary

Items fixable in < 1 hour each:

| #   | Gap                                           | Time   | Priority |
| --- | --------------------------------------------- | ------ | -------- |
| 1   | Add `pool_size` to README                     | 30 min | High     |
| 2   | Add AgentProcessPool architecture diagram     | 45 min | High     |
| 3   | Add WaveEngine parallel execution explanation | 20 min | High     |
| 4   | Add delegation format example                 | 30 min | High     |
| 5   | Add `--allowedTools` config example           | 20 min | Medium   |
| 6   | Add hung process detection to Troubleshooting | 15 min | Low      |
| 7   | Add idle cleanup to Configuration             | 15 min | Low      |
| 8   | Update EPIC-E6 status to "Deferred"           | 10 min | High     |
| 9   | Add basic metrics aggregation script          | 60 min | Medium   |
| 10  | Update PRD to remove MidTurnInjector          | 15 min | High     |
| 11  | Add AGENTS.md pool_size mention               | 20 min | Medium   |
| 12  | Add AGENTS.md WaveEngine parallelism          | 20 min | Medium   |

**Total Quick Win Time:** ~5 hours  
**High Priority Quick Wins:** 6 items (~2.5 hours)

---

## Impact Analysis

### By Impact Level

| Level        | Count | Examples                                                       |
| ------------ | ----- | -------------------------------------------------------------- |
| **Critical** | 2     | ResponseValidator, ReviewGate                                  |
| **Major**    | 7     | pool_size docs, WaveEngine docs, ScopeGuard, TodoTracker, etc. |
| **Minor**    | 3     | Hung detection docs, idle cleanup docs, MidTurnInjector status |

### By Category

| Category                       | Critical | Major | Minor | Total |
| ------------------------------ | -------- | ----- | ----- | ----- |
| Implemented but NOT Documented | 0        | 5     | 2     | 7     |
| Documented but NOT Implemented | 0        | 0     | 1     | 1     |
| Needed but Neither             | 2        | 2     | 0     | 4     |

---

## Recommendations

### Week 1 Priorities (Documentation)

1. **Day 1-2:** Fix all "Implemented but NOT Documented" gaps (7 items, ~3 hours)
   - Add pool_size, AgentProcessPool, WaveEngine to README
   - Add delegation format, tool permissions examples
   - Add hung/idle cleanup documentation

2. **Day 3:** Update PRD and EPIC-E6 for MidTurnInjector (2 items, ~30 minutes)
   - Mark EPIC-E6 as "Deferred"
   - Update PRD to use TodoTracker instead

3. **Day 4-5:** Add basic observability (1 item, ~1 hour)
   - Metrics aggregation script
   - Simple report generation

### Week 2-5 Priorities (Implementation)

1. **Week 2:** Spike ResponseValidator and ReviewGate
   - Prototype flattery detection
   - Test evidence-based APPROVE

2. **Week 3-4:** Implement Enforcement Layer
   - ResponseValidator (production-ready)
   - ReviewGate (production-ready)
   - ScopeGuard (prototype)
   - TodoTracker (production-ready)

3. **Week 5:** Integration and deployment
   - Wire enforcement into multi-agent-discord.ts
   - Feature flags for gradual rollout
   - Metrics dashboard

---

## Related Documents

- [Implementation Plan](implementation-plan-enforcement-layer-2026-02-08.md) - 5-week execution plan
- [PRD Multi-Agent Workflow v2](.docs/prd-multi-agent-workflow-v2-2026-02-08.md) - Requirements
- [EPIC-E6](.docs/epics/EPIC-E6-mid-turn-injection.md) - MidTurnInjector spec
- [AGENTS.md](../AGENTS.md) - Project knowledge base

---

**Next Steps:**

1. Review this gap analysis with stakeholders
2. Prioritize Quick Wins for Week 1
3. Begin ADR-001 (Enforcement Layer design) in Week 1 Day 3-5
4. Start Spike implementation in Week 2

---

**Author:** System Architect (Sisyphus)  
**Last Updated:** 2026-02-08  
**Status:** Complete
