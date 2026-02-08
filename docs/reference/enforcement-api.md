# Enforcement Layer API Reference

**Version:** 2.0.0  
**Package:** `@jungjaehoon/mama-os`  
**Module:** `packages/standalone/src/enforcement/`

---

## Overview

The Enforcement Layer provides runtime validation and quality control for AI agent responses in MAMA's multi-agent swarm. It prevents flattery loops, enforces evidence-based approvals, and ensures task scope compliance.

**Architecture:**

```
Agent Response → ResponseValidator → ReviewGate → TodoTracker → Discord/Slack
                                                      ↕
                                               ScopeGuard (git diff)
                                               EnforcementMetrics (observe)
```

**Related Documents:**

- [ADR-001: Enforcement Layer Architecture](../adr/ADR-001-enforcement-layer.md)
- [Enforcement Layer Guide](../guides/enforcement-layer.md)
- [Spike Results](../spike-results-enforcement-layer-2026-02-08.md)

---

## ResponseValidator

Detects and rejects agent responses containing excessive flattery, self-congratulation, status filler, and unnecessary confirmation. Supports both Korean and English pattern detection.

### Class: `ResponseValidator`

**Location:** `packages/standalone/src/enforcement/response-validator.ts`

**Purpose:** Validates agent responses for excessive flattery and empty praise. In agent-to-agent (strict) mode, responses exceeding the flattery threshold are rejected. In human-facing (lenient) mode, a higher effective threshold (2× configured) is used.

#### Constructor

```typescript
constructor(config?: Partial<ResponseValidatorConfig>)
```

**Parameters:**

- `config` (optional): Partial configuration object. Merged with defaults.

**Default Configuration:**

```typescript
{
  enabled: true,
  flatteryThreshold: 0.2,      // 20% of non-code characters
  maxRetries: 3,
  strictMode: true
}
```

**Example:**

```typescript
import { ResponseValidator } from './enforcement/response-validator';

const validator = new ResponseValidator({
  flatteryThreshold: 0.15, // Stricter 15% threshold
  maxRetries: 2,
});
```

#### Methods

##### `validate(response: string, isAgentToAgent: boolean): ValidationResult`

Validate a response string.

**Parameters:**

- `response` (string): The full response text to validate
- `isAgentToAgent` (boolean): Whether this is agent-to-agent communication (strict mode)

**Returns:** `ValidationResult`

```typescript
interface ValidationResult {
  valid: boolean; // Pass/fail
  reason?: string; // Rejection reason (if valid=false)
  matched?: string[]; // Matched pattern labels
  flatteryRatio?: number; // Ratio 0.0–1.0
}
```

**Behavior:**

- Agent-to-agent: Uses configured `flatteryThreshold` (default 20%)
- Human-facing: Uses 2× threshold (default 40%)
- Code blocks (` ``` `) and inline code (`` ` ``) are excluded from analysis

**Example:**

```typescript
const result = validator.validate(agentResponse, true);

if (!result.valid) {
  console.log(`Rejected: ${result.reason}`);
  console.log(`Matched patterns: ${result.matched.join(', ')}`);
  console.log(`Flattery ratio: ${(result.flatteryRatio * 100).toFixed(1)}%`);
  // Re-prompt agent with result.reason
}
```

##### `getFlatteryRatio(response: string): number`

Calculate the flattery ratio for a response.

**Parameters:**

- `response` (string): The full response text

**Returns:** `number` — Ratio between 0.0 and 1.0

**Formula:**

```
Ratio = (total matched characters) / (total non-code characters)
```

Code blocks and inline code are excluded from both numerator and denominator.

**Example:**

```typescript
const ratio = validator.getFlatteryRatio(response);
console.log(`Flattery ratio: ${(ratio * 100).toFixed(1)}%`);
```

##### `detectFlattery(response: string): string[]`

Detect all flattery pattern labels present in a response.

**Parameters:**

- `response` (string): The full response text

**Returns:** `string[]` — Array of matched pattern labels (deduplicated)

**Example:**

```typescript
const matched = validator.detectFlattery(response);
// → ["완벽합니다", "훌륭합니다", "enterprise-grade"]
```

### Configuration Interface

```typescript
interface ResponseValidatorConfig {
  /** Whether validation is enabled */
  enabled: boolean;

  /** Flattery ratio threshold (0.0–1.0). Default: 0.2 (20%) */
  flatteryThreshold: number;

  /** Maximum retries for rejected responses. Default: 3 */
  maxRetries: number;

  /** Strict mode for agent-to-agent communication. Default: true */
  strictMode: boolean;
}
```

### Result Interface

```typescript
interface ValidationResult {
  /** Whether the response passed validation */
  valid: boolean;

  /** Rejection reason (if valid=false) */
  reason?: string;

  /** Matched pattern labels */
  matched?: string[];

  /** Flattery ratio (0.0–1.0) */
  flatteryRatio?: number;
}
```

### Flattery Patterns

**50 patterns across 4 categories:**

| Category                     | Count | Examples (Korean)                            | Examples (English)                                   |
| ---------------------------- | ----- | -------------------------------------------- | ---------------------------------------------------- |
| **Direct Praise**            | 20    | 완벽합니다, 훌륭합니다, 인상적입니다, 놀라운 | perfect, excellent, impressive, wonderful, fantastic |
| **Self-Congratulation**      | 16    | 엔터프라이즈급, 프로덕션 레디, 마스터피스    | enterprise-grade, production-ready, legendary        |
| **Status Filler**            | 9     | 깔끔한 구현, 완벽한 설계, 우아한 솔루션      | elegant solution, clean implementation, really good  |
| **Unnecessary Confirmation** | 5     | 물론입니다, 당연히, 확실히                   | of course, absolutely                                |

**Full pattern list:** See `response-validator.ts` lines 58–126

### Usage Example

```typescript
import { ResponseValidator } from './enforcement/response-validator';

// Initialize with custom config
const validator = new ResponseValidator({
  flatteryThreshold: 0.2,
  maxRetries: 3,
});

// Validate agent-to-agent response
const agentResponse = '완벽합니다! 훌륭한 구현입니다. 엔터프라이즈급 코드입니다.';
const result = validator.validate(agentResponse, true);

if (!result.valid) {
  console.log(`❌ REJECTED: ${result.reason}`);
  console.log(`Matched: ${result.matched.join(', ')}`);
  console.log(`Ratio: ${(result.flatteryRatio * 100).toFixed(1)}%`);

  // Re-prompt agent
  const feedback = `[SYSTEM] ${result.reason}. Restate with results only.`;
  // ... retry logic
} else {
  console.log(`✅ PASSED (ratio: ${(result.flatteryRatio * 100).toFixed(1)}%)`);
}
```

---

## ReviewGate

Enforces evidence-based APPROVE verdicts. Non-approval responses pass through. Approval without evidence → REJECT.

### Class: `ReviewGate`

**Location:** `packages/standalone/src/enforcement/review-gate.ts`

**Purpose:** Blocks APPROVE responses without verification evidence (test results, build status, typecheck, files reviewed). Prevents rubber-stamp approvals.

#### Constructor

```typescript
constructor(config?: Partial<ReviewGateConfig>)
```

**Parameters:**

- `config` (optional): Partial configuration object. Merged with defaults.

**Default Configuration:**

```typescript
{
  enabled: true,
  requireEvidence: true
}
```

**Example:**

```typescript
import { ReviewGate } from './enforcement/review-gate';

const gate = new ReviewGate({
  requireEvidence: true,
});
```

#### Methods

##### `checkApproval(response: string): ReviewResult`

Main gate: passthrough for non-approval, require evidence for approval.

**Parameters:**

- `response` (string): Full review response text

**Returns:** `ReviewResult`

```typescript
interface ReviewResult {
  approved: boolean; // Pass/fail
  hasEvidence: boolean; // Whether evidence was found
  evidenceFound: string[]; // Evidence pattern labels
  reason?: string; // Rejection reason (if approved=false)
}
```

**Behavior:**

1. If response doesn't contain approval keywords → PASS (passthrough)
2. If response contains approval keywords:
   - Extract evidence patterns
   - If evidence found → PASS
   - If no evidence → REJECT with reason

**Example:**

```typescript
const result = gate.checkApproval(reviewResponse);

if (!result.approved) {
  console.log(`❌ REJECTED: ${result.reason}`);
  // Re-prompt reviewer with evidence requirement
} else if (result.hasEvidence) {
  console.log(`✅ APPROVED with evidence: ${result.evidenceFound.join(', ')}`);
} else {
  console.log(`✅ PASSED (not an approval)`);
}
```

##### `containsApproval(response: string): boolean`

Check if response contains approval keywords.

**Parameters:**

- `response` (string): Response text

**Returns:** `boolean`

**Approval Keywords:**

- English: `APPROVE`, `APPROVED`, `LGTM`, `looks good`
- Korean: `승인`, `통과`, `합격`

**Example:**

```typescript
if (gate.containsApproval(response)) {
  // This is an approval response
}
```

##### `extractEvidence(response: string): string[]`

Extract evidence pattern labels from response.

**Parameters:**

- `response` (string): Response text

**Returns:** `string[]` — Array of evidence labels (deduplicated)

**Example:**

```typescript
const evidence = gate.extractEvidence(response);
// → ["test pass", "build succeed", "0 errors"]
```

### Configuration Interface

```typescript
interface ReviewGateConfig {
  /** Whether gate is enabled */
  enabled: boolean;

  /** Require evidence for APPROVE verdicts. Default: true */
  requireEvidence: boolean;
}
```

### Result Interface

```typescript
interface ReviewResult {
  /** Whether approval is valid */
  approved: boolean;

  /** Whether evidence was found */
  hasEvidence: boolean;

  /** Evidence pattern labels found */
  evidenceFound: string[];

  /** Rejection reason (if approved=false) */
  reason?: string;
}
```

### Evidence Patterns

**18 patterns across 6 categories:**

| Category         | Examples                                                               |
| ---------------- | ---------------------------------------------------------------------- |
| **Test Results** | `tests pass`, `628/628`, `12/12 pass`, `N tests passed`                |
| **Build Status** | `build succeeded`, `build success`                                     |
| **TypeScript**   | `typecheck pass`, `typecheck clean`, `typescript compiles`, `0 errors` |
| **Verification** | `verified`, `checked`, `confirmed`                                     |
| **Code Review**  | `reviewed code`, `reviewed changes`, `files reviewed`, `git diff`      |
| **Lint**         | `lint pass`, `lint: 0 errors`, `no lint errors`                        |

**Full pattern list:** See `review-gate.ts` lines 33–53

### Usage Example

```typescript
import { ReviewGate } from './enforcement/review-gate';

const gate = new ReviewGate({ requireEvidence: true });

// Example 1: APPROVE without evidence → REJECT
const response1 = 'APPROVE - 모든 것이 완벽합니다!';
const result1 = gate.checkApproval(response1);
// → { approved: false, hasEvidence: false, evidenceFound: [],
//     reason: "APPROVE verdict requires evidence..." }

// Example 2: APPROVE with evidence → PASS
const response2 = 'APPROVE - Tests pass (628/628), build succeeded, 0 errors';
const result2 = gate.checkApproval(response2);
// → { approved: true, hasEvidence: true,
//     evidenceFound: ["test count", "build succeed", "0 errors"] }

// Example 3: Non-approval response → PASS
const response3 = "Here's my analysis of the code...";
const result3 = gate.checkApproval(response3);
// → { approved: true, hasEvidence: false, evidenceFound: [] }
```

---

## ScopeGuard

**Status:** Planned (Week 3 implementation)

Git diff-based scope enforcement. Compares modified files against delegated task's EXPECTED OUTCOME. Warns on unexpected file modifications.

### Planned Interface

```typescript
interface ScopeGuardConfig {
  enabled: boolean;
  mode: 'warn' | 'block';
  allowedPatterns: string[]; // Glob patterns for allowed files
}

interface ScopeCheckResult {
  valid: boolean;
  unexpectedFiles: string[];
  severity: 'WARNING' | 'NEEDS_REVIEW';
  reason?: string;
}

class ScopeGuard {
  constructor(config?: Partial<ScopeGuardConfig>);
  checkScope(task: string, response: string): Promise<ScopeCheckResult>;
  parseExpectedOutcome(task: string): string[];
  getModifiedFiles(): Promise<string[]>;
}
```

**Planned Usage:**

```typescript
const scopeGuard = new ScopeGuard({
  mode: 'warn',
  allowedPatterns: ['*.test.ts', '*.md'],
});

const result = await scopeGuard.checkScope(delegationTask, agentResponse);

if (result.severity === 'NEEDS_REVIEW') {
  console.log(`⚠️ Scope violation: ${result.unexpectedFiles.join(', ')}`);
}
```

**See:** [ADR-001](../adr/ADR-001-enforcement-layer.md#3-scopeguard--git-diff-based-scope-enforcement) for full specification.

---

## EnforcementPipeline

**Status:** Planned (Week 3 implementation)

Middleware chain that orchestrates all enforcement components.

### Planned Interface

```typescript
interface EnforcementConfig {
  enabled: boolean;
  responseValidator: ResponseValidatorConfig;
  reviewGate: ReviewGateConfig;
  scopeGuard: ScopeGuardConfig;
}

interface EnforcementResult {
  valid: boolean;
  component?: string; // Which component rejected
  reason?: string;
  retry: boolean;
  feedback?: string; // Feedback for agent retry
}

class EnforcementPipeline {
  constructor(config: EnforcementConfig);

  async validate(
    response: string,
    context: {
      isAgentToAgent: boolean;
      isDelegation: boolean;
      task?: string;
    }
  ): Promise<EnforcementResult>;
}
```

**Planned Usage:**

```typescript
const pipeline = new EnforcementPipeline({
  enabled: true,
  responseValidator: { enabled: true, flatteryThreshold: 0.2 },
  reviewGate: { enabled: true, requireEvidence: true },
  scopeGuard: { enabled: true, mode: 'warn' },
});

const result = await pipeline.validate(agentResponse, {
  isAgentToAgent: true,
  isDelegation: true,
  task: delegationPrompt,
});

if (!result.valid) {
  console.log(`Rejected by ${result.component}: ${result.reason}`);
  if (result.retry) {
    // Re-invoke agent with result.feedback
  }
}
```

**See:** [ADR-001](../adr/ADR-001-enforcement-layer.md#architecture-middleware-chain) for full specification.

---

## Performance

All enforcement components are designed for minimal overhead:

| Component         | Average Latency | Method                |
| ----------------- | --------------- | --------------------- |
| ResponseValidator | <1ms            | Pure regex matching   |
| ReviewGate        | <1ms            | Pure regex matching   |
| ScopeGuard        | <50ms (planned) | Git diff parsing      |
| Full Pipeline     | <100ms (target) | Sequential validation |

**Benchmark:** 19 ResponseValidator tests + 20 ReviewGate tests = 39 tests in 35ms total (including setup).

---

## Error Handling

All components follow consistent error handling:

```typescript
// Disabled components always pass
if (!this.config.enabled) {
  return { valid: true };
}

// Empty responses pass
if (response.trim().length === 0) {
  return { valid: true };
}

// Validation logic
// ...

// Rejection with clear reason
if (violationDetected) {
  return {
    valid: false,
    reason: 'Specific reason with actionable guidance',
  };
}
```

---

## Testing

All components have comprehensive test coverage:

| Component           | Test File                                        | Tests   | Coverage |
| ------------------- | ------------------------------------------------ | ------- | -------- |
| ResponseValidator   | `tests/enforcement/response-validator.test.ts`   | 19      | 100%     |
| ReviewGate          | `tests/enforcement/review-gate.test.ts`          | 20      | 100%     |
| ScopeGuard          | `tests/enforcement/scope-guard.test.ts`          | 23      | 100%     |
| TodoTracker         | `tests/enforcement/todo-tracker.test.ts`         | 36      | 100%     |
| EnforcementMetrics  | `tests/enforcement/metrics.test.ts`              | 22      | 100%     |
| EnforcementPipeline | `tests/enforcement/enforcement-pipeline.test.ts` | 23      | 100%     |
| **Total**           |                                                  | **143** | **100%** |

**Run tests:**

```bash
cd packages/standalone
pnpm test enforcement
```

---

## Related Documentation

- [Enforcement Layer Guide](../guides/enforcement-layer.md) — Usage guide with configuration
- [ADR-001: Enforcement Layer Architecture](../adr/ADR-001-enforcement-layer.md) — Design decisions
- [Spike Results](../spike-results-enforcement-layer-2026-02-08.md) — Validation results
- [Implementation Plan](../implementation-plan-enforcement-layer-2026-02-08.md) — 5-week roadmap

---

**Last Updated:** 2026-02-08  
**Version:** 1.0.0  
**Author:** SpineLift Team
