# ADR-001: Enforcement Layer Architecture

**Status:** Accepted  
**Date:** 2026-02-08  
**Deciders:** Jung Jaehoon, System Architect (Sisyphus)  
**Related Documents:**

- [PRD: Multi-Agent Workflow v2](.docs/prd-multi-agent-workflow-v2-2026-02-08.md)
- [Architecture: MAMA Swarm](docs/architecture-mama-swarm-2026-02-06.md)
- [Gap Analysis](docs/architecture-gaps-2026-02-08.md)
- [Implementation Plan](docs/implementation-plan-enforcement-layer-2026-02-08.md)

---

## Context

### The Problem: Flattery Loop in Multi-Agent Systems

MAMA's multi-agent swarm exhibits a "flattery loop" problem where agents spend approximately 40% of tokens on praise, confirmation, and status messages rather than actual work:

```text
Human → @Sisyphus "Refactor these 3 files"
  ↓
Sisyphus → "네, 확인했습니다! 3개 파일을 리팩토링하겠습니다." (1 turn wasted)
  ↓
Sisyphus → @DevBot "src/foo.ts를 리팩토링해주세요. 이 파일은 매우 중요합니다."
  ↓ (await... 60초)
DevBot → "알겠습니다! 확인했습니다." (1 turn wasted)
DevBot → [실행] → "완료했습니다! 엔터프라이즈급 리팩토링을 적용했습니다." (flattery)
  ↓
Sisyphus → @Reviewer "리뷰 부탁합니다"
Reviewer → "완벽한 구현입니다! 훌륭한 패턴입니다! APPROVED!" (no verification)
```

**Evidence:**

- MAMA decision graph checkpoint 132 identifies "칭찬, APPROVE, 작업 중단" as recurring problems
- oh-my-opencode achieves 40% token reduction through enforcement hooks
- SOUL.md and persona files already contain rules prohibiting flattery — they are ignored
- Sonnet 4.5 outperforms Opus 4.6 in some tasks → system design matters more than model

### Why Prompt-Only Approaches Fail

**Existing rules in MAMA:**

- `~/.mama/SOUL.md`: "과도한 칭찬이나 빈말 금지"
- Reviewer persona: "No empty praise"
- DevBot persona: "즉시 실행, 확인 메시지 금지"

**Result:** All ignored. Agents still produce flattery and empty confirmations.

**Root cause:** Prompts are "speed limit signs" — they suggest behavior but don't enforce it. Code enforcement is "speed cameras + speed bumps" — it blocks violations.

### Platform Advantage: MAMA Owns the Agent Loop

Unlike agent-agnostic frameworks, MAMA owns the platform:

- `agent-loop.ts` — Controls agent execution flow
- `PersistentCliProcess` — Manages Claude CLI subprocess
- `AgentProcessManager` — Orchestrates process pools
- `processAgentResponse()` — Intercepts all agent outputs

This enables **native enforcement** at the platform level, similar to how oh-my-opencode uses 40+ hooks in Claude Code.

### Comparison: oh-my-opencode vs MAMA

| Feature                  | oh-my-opencode (Claude Code)         | MAMA (Standalone)                    |
| ------------------------ | ------------------------------------ | ------------------------------------ |
| **Platform**             | Claude Code (desktop app)            | Claude CLI subprocess                |
| **Enforcement**          | 40+ hooks (PreToolUse, PostToolUse)  | Custom middleware in agent-loop      |
| **Hook Availability**    | Built-in (Claude Code API)           | Not available (CLI subprocess)       |
| **Enforcement Location** | Before/after tool calls              | After agent response, before Discord |
| **Token Reduction**      | 40% (documented)                     | Target: 40% (same patterns)          |
| **Mid-Turn Injection**   | `<system-reminder>` (native support) | Impossible (CLI protocol limitation) |

**Key insight:** MAMA cannot use Claude Code hooks (different platform), but can implement equivalent enforcement at the response processing layer.

---

## Decision

We will implement a **Hybrid Enforcement Layer** combining 4 components:

### 1. ResponseValidator — Pattern-Matching Response Validator

**Location:** `packages/standalone/src/enforcement/response-validator.ts`

**Function:** Detects flattery and empty confirmations in agent-to-agent responses. When flattery ratio exceeds threshold, reject response and retry with specific feedback.

**Insertion Point:** After agent response, before Discord post

```typescript
// Middleware chain
Agent Response → ResponseValidator → ReviewGate → ScopeGuard → TodoTracker → Discord Post
```

**Patterns:**

```typescript
const flatteryPatterns = {
  korean: [/완벽/, /훌륭/, /인상적/, /엔터프라이즈급/, /최고의/, /뛰어난/],
  english: [
    /perfect/i,
    /excellent/i,
    /impressive/i,
    /enterprise-grade/i,
    /outstanding/i,
    /brilliant/i,
  ],
  confirmation: [/알겠습니다/, /확인했습니다/, /진행하겠습니다/, /I understand/, /Got it/],
};
```

**Rejection Logic:**

```typescript
if (flatteryTokenRatio > 0.2 && isDelegation) {
  return {
    valid: false,
    feedback: '[SYSTEM] Response rejected: contains praise/flattery. Restate with results only.',
    retry: true,
  };
}
```

**Configuration:**

```yaml
enforcement:
  response_validator:
    enabled: true
    flattery_threshold: 0.2 # 20% of tokens
    max_retries: 2
```

### 2. ReviewGate — Evidence-Based APPROVE Enforcement

**Location:** `packages/standalone/src/enforcement/review-gate.ts`

**Function:** Blocks APPROVE responses without verification evidence (test output, build success, diff verification).

**Integration:** Extends existing `swarm-anti-pattern-detector.ts`

**Evidence Patterns:**

```typescript
const evidencePatterns = [
  /test.*pass/i,
  /\d+\/\d+.*pass/i, // "995/995 tests passed"
  /git diff/i,
  /\+\d+\s*-\d+/i, // "+23 -5 lines"
  /build.*success/i,
  /테스트.*통과/,
  /빌드.*성공/,
];
```

**Rejection Logic:**

```typescript
if (/\bAPPROVE\b/i.test(response) && !hasEvidence(response)) {
  return {
    valid: false,
    feedback: '[SYSTEM] APPROVE rejected: no verification evidence. Run tests or show diff.',
    retry: true,
  };
}
```

**Downgrade on Repeated Failure:**

```typescript
if (retryCount >= 2 && !hasEvidence(response)) {
  // Convert APPROVE to NEEDS_REVIEW
  return {
    valid: true,
    modified: response.replace(/APPROVE/gi, 'NEEDS_REVIEW'),
    warning: 'APPROVE downgraded to NEEDS_REVIEW (no evidence after 2 retries)',
  };
}
```

### 3. ScopeGuard — Git Diff-Based Scope Enforcement

**Location:** `packages/standalone/src/enforcement/scope-guard.ts`

**Function:** Compares modified files (git diff) against delegated task's EXPECTED OUTCOME. Warns on unexpected file modifications.

**Workflow:**

```typescript
// 1. Parse EXPECTED OUTCOME from delegation
const expectedFiles = parseExpectedOutcome(delegationPrompt);
// → ["src/auth.ts", "tests/auth.test.ts"]

// 2. Get actual changes
const modifiedFiles = parseGitDiff(await exec('git diff --name-only'));
// → ["src/auth.ts", "tests/auth.test.ts", "src/utils.ts", "README.md"]

// 3. Detect violations
const unexpected = modifiedFiles.filter((f) => !expectedFiles.includes(f));
// → ["src/utils.ts", "README.md"]

if (unexpected.length > 0) {
  return {
    warning: `[SYSTEM] Scope violation: modified ${unexpected.join(', ')} not in expected outcome`,
    severity: unexpected.length >= 3 ? 'NEEDS_REVIEW' : 'WARNING',
  };
}
```

**Configuration:**

```yaml
enforcement:
  scope_guard:
    enabled: true
    violation_threshold: 3 # Mark NEEDS_REVIEW if 3+ unexpected files
```

### 4. TodoTracker — Turn-Boundary Task Tracker

**Location:** `packages/standalone/src/enforcement/todo-tracker.ts`

**Function:** Parses EXPECTED OUTCOME from delegation, tracks completion markers, sends inter-turn reminders for incomplete items.

**Why Turn-Boundary (Not Mid-Turn):**

- Mid-turn injection (FR-013) is impossible due to Claude CLI protocol limitations
- Turn-boundary approach achieves 80% of desired effect
- Reminders injected after agent response, before next turn

**Workflow:**

```typescript
// 1. Parse EXPECTED OUTCOME into checklist
const todos = parseExpectedOutcome(delegationPrompt);
// → [
//   { id: 1, description: "Create src/auth.ts", completed: false },
//   { id: 2, description: "Write tests", completed: false },
//   { id: 3, description: "Run npm test", completed: false }
// ]

// 2. Detect completion markers in agent response
updateFromResponse(sessionId, agentResponse);
// Patterns: "DONE", "완료", "TASK_COMPLETE", file creation detected

// 3. Generate reminder if incomplete
const incomplete = getIncomplete(sessionId);
if (incomplete.length > 0 && agentResponse.includes('end_turn')) {
  injectReminder(
    `[SYSTEM] Remaining: ${incomplete.length} items. Next: ${incomplete[0].description}`
  );
}
```

**Configuration:**

```yaml
enforcement:
  todo_tracker:
    enabled: true
    reminder_on_incomplete: true
```

### Architecture: Middleware Chain

```typescript
// packages/standalone/src/multi-agent/multi-agent-discord.ts
async function processAgentResponse(response: string, context: DelegationContext) {
  // 1. ResponseValidator
  const validationResult = await responseValidator.validate(response, context);
  if (!validationResult.valid) {
    return retryWithFeedback(validationResult.feedback);
  }

  // 2. ReviewGate (if APPROVE detected)
  if (/APPROVE/i.test(response)) {
    const reviewResult = await reviewGate.checkEvidence(response);
    if (!reviewResult.valid) {
      return retryWithFeedback(reviewResult.feedback);
    }
  }

  // 3. ScopeGuard (if delegation task)
  if (context.isDelegation) {
    const scopeResult = await scopeGuard.checkScope(context.task, response);
    if (scopeResult.severity === 'NEEDS_REVIEW') {
      response = `${response}\n\n${scopeResult.warning}`;
    }
  }

  // 4. TodoTracker
  await todoTracker.updateFromResponse(context.sessionId, response);
  const reminder = await todoTracker.getReminderMessage(context.sessionId);
  if (reminder) {
    response = `${response}\n\n${reminder}`;
  }

  // 5. Post to Discord
  await postToDiscord(response);
}
```

### Configuration Schema

```yaml
# packages/standalone/config.yaml
enforcement:
  enabled: true # Master switch

  response_validator:
    enabled: true
    flattery_threshold: 0.2 # 20% of tokens
    max_retries: 2
    patterns:
      korean: ['완벽', '훌륭', '인상적', '엔터프라이즈급']
      english: ['perfect', 'excellent', 'impressive', 'enterprise-grade']

  review_gate:
    enabled: true
    require_evidence: true
    downgrade_after_retries: 2

  scope_guard:
    enabled: true
    violation_threshold: 3 # NEEDS_REVIEW if 3+ unexpected files

  todo_tracker:
    enabled: true
    reminder_on_incomplete: true
```

---

## Alternatives Considered

### Alternative A: Prompt-Only (Stronger SOUL.md)

**Description:** Add more explicit rules to SOUL.md and persona files.

**Pros:**

- ✅ Zero code changes
- ✅ Easy to iterate
- ✅ No performance overhead

**Cons:**

- ❌ Already proven ineffective (existing rules ignored)
- ❌ No enforcement mechanism
- ❌ Relies on model compliance

**Decision:** Rejected. Existing rules already prohibit flattery but are ignored. Adding more rules won't change behavior.

### Alternative B: Claude Hooks Only (PreToolUse/PostToolUse)

**Description:** Use Claude Code's hook system (PreToolUse, PostToolUse, UserPromptSubmit).

**Pros:**

- ✅ Proven system (oh-my-opencode uses this)
- ✅ 40+ hooks available
- ✅ Mid-turn injection support

**Cons:**

- ❌ Platform mismatch: Claude Code hooks not available in CLI subprocess
- ❌ MAMA uses `spawn('claude', [...])`, not Claude Code API
- ❌ Cannot access hook infrastructure

**Decision:** Rejected. MAMA runs Claude CLI as subprocess, not Claude Code desktop app. Hooks are unavailable.

### Alternative C: Custom Enforcement Only (Selected)

**Description:** Implement enforcement at MAMA's platform layer (agent-loop, processAgentResponse).

**Pros:**

- ✅ Full control over enforcement logic
- ✅ Native integration with MAMA architecture
- ✅ Can enforce at response processing layer
- ✅ Independently configurable (feature flags)

**Cons:**

- ❌ More code to write/maintain (~300 lines)
- ❌ No mid-turn injection (CLI limitation)
- ❌ Requires testing and tuning

**Decision:** Selected. MAMA owns the platform, so native enforcement is the most appropriate approach.

### Alternative D: oh-my-opencode Fork

**Description:** Fork oh-my-opencode and adapt it to MAMA's architecture.

**Pros:**

- ✅ Proven system (40+ hooks, 40% token reduction)
- ✅ Extensive enforcement patterns
- ✅ Active development

**Cons:**

- ❌ Platform incompatibility: oh-my-opencode is for Claude Code, MAMA uses CLI subprocess
- ❌ Different architecture (hooks vs middleware)
- ❌ Maintenance burden (keeping fork in sync)

**Decision:** Rejected. Platform mismatch makes direct fork impractical. Instead, we adopt the **patterns** (flattery detection, evidence-based APPROVE) but implement them natively in MAMA.

---

## Consequences

### Positive

✅ **40% Token Reduction (Evidence-Based)**

- oh-my-opencode achieves 40% token reduction through enforcement
- MAMA targets same reduction by blocking flattery, confirmations, empty APPROVE
- Frees up Claude Pro daily limits for actual work

✅ **Evidence-Based Reviews**

- No more rubber-stamp APPROVE without verification
- Reviewers must show test output, git diff, or build success
- Increases trust in multi-agent workflow

✅ **Scope Containment**

- Prevents "fix auth bug" → agent refactors entire codebase
- Detects unintended file modifications
- Reduces scope creep in delegated tasks

✅ **Task Completion Tracking**

- No more "I'm done" without verification
- Turn-boundary reminders for incomplete items
- 80% effectiveness vs impossible mid-turn injection

✅ **Independently Toggleable**

- Each component has feature flag
- Can disable noisy validators during development
- Gradual rollout possible

### Negative

❌ **Implementation Complexity**

- ~300 lines of new validation code
- 4 new TypeScript modules
- Integration with existing multi-agent-discord.ts and multi-agent-slack.ts

❌ **False Positives Possible**

- Legitimate praise might be blocked ("This is a perfect use case for X")
- Requires pattern tuning based on real usage
- May need whitelist for technical terms ("perfect hash", "excellent performance")

❌ **Retry Loops Increase Latency**

- Each rejection adds 1 retry cycle (~30-60s)
- Max 2 retries per component → potential 6 retries total
- Mitigated by max_retries=2 and downgrade logic

❌ **Pattern Maintenance**

- Flattery patterns need ongoing updates (new phrases)
- Evidence patterns may need language-specific tuning
- Requires monitoring and iteration

### Risks & Mitigation

**Risk 1: MidTurnInjector Impossible → TodoTracker is Inter-Turn Only**

- **Impact:** 80% effectiveness vs 100% (mid-turn would be ideal)
- **Mitigation:** Turn-boundary reminders still catch most incomplete tasks
- **Future:** If Claude CLI adds mid-turn injection API, upgrade TodoTracker

**Risk 2: Aggressive Flattery Detection Blocks Valid Responses**

- **Impact:** False positives frustrate agents, increase retries
- **Mitigation:**
  - Threshold tuning (start at 0.2, adjust based on data)
  - Whitelist for technical terms
  - User feedback mechanism to report false positives

**Risk 3: Config Complexity Increases**

- **Impact:** Users confused by 10+ enforcement settings
- **Mitigation:**
  - Master switch: `enforcement.enabled: true/false`
  - Sane defaults (all enabled, threshold 0.2)
  - Documentation with examples

**Risk 4: Performance Overhead**

- **Impact:** Pattern matching adds latency to every response
- **Mitigation:**
  - Regex patterns are fast (<5ms per response)
  - Git diff parsing cached
  - Only run on agent-to-agent responses (not human-facing)

---

## Implementation

### Phase 1: ResponseValidator (Week 2)

**Files:**

- `packages/standalone/src/enforcement/response-validator.ts` (new)
- `packages/standalone/src/enforcement/index.ts` (new)
- `packages/standalone/tests/enforcement/response-validator.test.ts` (new)

**Integration:**

```typescript
// packages/standalone/src/multi-agent/multi-agent-discord.ts
import { ResponseValidator } from '../enforcement';

const validator = new ResponseValidator(config.enforcement.response_validator);

async function processAgentResponse(response: string, context: DelegationContext) {
  if (context.isDelegation) {
    const result = await validator.validate(response);
    if (!result.valid) {
      return retryWithFeedback(result.feedback);
    }
  }
  // ... rest of processing
}
```

**Tests:**

- Flattery detection (Korean + English)
- Threshold calculation (token ratio)
- Retry logic (max 2 retries)
- Human-facing responses bypass (isDelegation flag)

### Phase 2: ReviewGate (Week 2)

**Files:**

- `packages/standalone/src/enforcement/review-gate.ts` (new)
- `packages/standalone/tests/enforcement/review-gate.test.ts` (new)

**Integration:**

```typescript
// Extend swarm-anti-pattern-detector.ts
import { ReviewGate } from '../enforcement';

const reviewGate = new ReviewGate(config.enforcement.review_gate);

if (/APPROVE/i.test(response)) {
  const result = await reviewGate.checkEvidence(response);
  if (!result.valid) {
    return retryWithFeedback(result.feedback);
  }
}
```

**Tests:**

- Evidence pattern matching (test output, git diff, build success)
- APPROVE without evidence → rejection
- APPROVE with evidence → pass
- Downgrade logic (APPROVE → NEEDS_REVIEW after 2 retries)

### Phase 3: ScopeGuard (Week 3)

**Files:**

- `packages/standalone/src/enforcement/scope-guard.ts` (new)
- `packages/standalone/tests/enforcement/scope-guard.test.ts` (new)

**Integration:**

```typescript
const scopeGuard = new ScopeGuard(config.enforcement.scope_guard);

if (context.isDelegation) {
  const result = await scopeGuard.checkScope(context.task, response);
  if (result.severity === 'NEEDS_REVIEW') {
    response = `${response}\n\n${result.warning}`;
  }
}
```

**Tests:**

- EXPECTED OUTCOME parsing
- Git diff parsing
- Scope violation detection (unexpected files)
- Threshold logic (3+ violations → NEEDS_REVIEW)

### Phase 4: TodoTracker (Week 3-4)

**Files:**

- `packages/standalone/src/enforcement/todo-tracker.ts` (new)
- `packages/standalone/tests/enforcement/todo-tracker.test.ts` (new)

**Integration:**

```typescript
const todoTracker = new TodoTracker(config.enforcement.todo_tracker);

await todoTracker.updateFromResponse(context.sessionId, response);
const reminder = await todoTracker.getReminderMessage(context.sessionId);
if (reminder) {
  response = `${response}\n\n${reminder}`;
}
```

**Tests:**

- EXPECTED OUTCOME parsing (checklist extraction)
- Completion marker detection (DONE, 완료, file creation)
- Reminder generation (incomplete items)
- Turn-boundary injection

### Phase 5: Integration & Testing (Week 4-5)

**Files:**

- `packages/standalone/src/multi-agent/multi-agent-discord.ts` (modify)
- `packages/standalone/src/multi-agent/multi-agent-slack.ts` (modify)
- `packages/standalone/tests/multi-agent/enforcement-integration.test.ts` (new)

**Integration Tests:**

- Full middleware chain (ResponseValidator → ReviewGate → ScopeGuard → TodoTracker)
- Feature flag toggling
- Retry loop behavior
- Performance benchmarks (<50ms overhead)

**Configuration:**

- Add `enforcement` section to `config.yaml`
- Document all settings in README
- Provide example configurations

---

## Timeline

| Week | Phase                                | Deliverables                                                                 |
| ---- | ------------------------------------ | ---------------------------------------------------------------------------- |
| 1    | Documentation                        | ADR-001, architecture diagrams, README updates                               |
| 2    | ResponseValidator + ReviewGate       | 2 modules, tests, integration                                                |
| 3    | ScopeGuard + TodoTracker (prototype) | 2 modules, tests, basic integration                                          |
| 4    | TodoTracker (production) + Polish    | Production-ready TodoTracker, config schema, documentation                   |
| 5    | Integration + Deployment             | Full middleware chain, feature flags, metrics dashboard, deployment to users |

**Total Effort:** ~40 hours (5 weeks × 8 hours/week)

---

## Success Metrics

| Metric                                | Current | Target | Measurement                  |
| ------------------------------------- | ------- | ------ | ---------------------------- |
| Flattery ratio in agent-to-agent msgs | ~40%    | <5%    | Token analysis               |
| Empty APPROVE rate                    | ~60%    | <10%   | Review response analysis     |
| Scope violations per delegation       | Unknown | <5%    | ScopeGuard warnings          |
| Task completion without verification  | ~50%    | <10%   | TodoTracker incomplete count |
| Retry loops per delegation            | 0       | <0.5   | Retry counter                |

**Validation:**

- Week 2: Spike validation (ResponseValidator + ReviewGate on test data)
- Week 4: Integration testing (full middleware chain)
- Week 5: Production deployment (gradual rollout with feature flags)

---

## References

- [PRD: Multi-Agent Workflow v2](.docs/prd-multi-agent-workflow-v2-2026-02-08.md) — FR-001, FR-007, FR-008, FR-014
- [Architecture: MAMA Swarm](docs/architecture-mama-swarm-2026-02-06.md) — Multi-agent architecture
- [Gap Analysis](docs/architecture-gaps-2026-02-08.md) — Identified gaps
- [Implementation Plan](docs/implementation-plan-enforcement-layer-2026-02-08.md) — 5-week execution plan
- [oh-my-opencode](https://github.com/nicepkg/oh-my-opencode) — Reference implementation (40+ hooks)
- [MAMA Decision Graph](mama-memory.db) — Checkpoint 132 (flattery loop evidence)

---

## Changelog

- **2026-02-08:** Initial draft (Accepted)
