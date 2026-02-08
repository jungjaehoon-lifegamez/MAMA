# Enforcement Layer Guide

**Version:** 1.0.0  
**Package:** `@jungjaehoon/mama-os`  
**Status:** Week 2 Complete (ResponseValidator + ReviewGate)

---

## Overview

The Enforcement Layer prevents flattery loops, enforces evidence-based approvals, and ensures task scope compliance in MAMA's multi-agent swarm.

### What It Does

**Problem:** AI agents waste ~40% of tokens on flattery, empty confirmations, and rubber-stamp approvals:

```text
❌ Before Enforcement:
DevBot → "완벽합니다! 엔터프라이즈급 리팩토링을 적용했습니다!"
Reviewer → "훌륭한 구현입니다! APPROVED!"

✅ After Enforcement:
DevBot → "Refactored auth.ts: extracted validateToken(), added tests (12/12 pass)"
Reviewer → "APPROVED - Tests pass (12/12), typecheck clean, reviewed git diff"
```

### Why It Matters

- **40% Token Reduction** — Frees up Claude Pro daily limits for actual work
- **Evidence-Based Reviews** — No more rubber-stamp APPROVE without verification
- **Scope Containment** — Prevents "fix auth bug" → agent refactors entire codebase
- **Quality Enforcement** — Prompts suggest, code enforces

### Enforcement-First Philosophy

> "Prompts are speed limit signs. Code enforcement is speed cameras + speed bumps."

MAMA's enforcement layer blocks violations at runtime, not just suggests good behavior. See [ADR-001](../adr/ADR-001-enforcement-layer.md) for design rationale.

---

## Quick Start

### 1. Enable in config.yaml

```yaml
# packages/standalone/config.yaml
enforcement:
  enabled: true # Master switch

  response_validator:
    enabled: true
    flattery_threshold: 0.2 # 20% of non-code characters
    max_retries: 3

  review_gate:
    enabled: true
    require_evidence: true
```

### 2. Start MAMA

```bash
mama start
```

Enforcement runs automatically on all agent-to-agent responses.

### 3. Verify It's Working

Check logs for enforcement events:

```bash
tail -f ~/.mama/logs/mama.log | grep ENFORCEMENT
```

You should see:

```
[ENFORCEMENT] ResponseValidator: REJECTED (flattery ratio 45.2% > 20.0%)
[ENFORCEMENT] ReviewGate: REJECTED (APPROVE without evidence)
[ENFORCEMENT] ResponseValidator: PASSED (flattery ratio 8.3%)
```

---

## Configuration

### Full config.yaml Section

```yaml
enforcement:
  # Master switch (disables all enforcement)
  enabled: true

  # Flattery detection and rejection
  response_validator:
    enabled: true
    flattery_threshold: 0.2 # 20% of non-code characters (default)
    max_retries: 3 # Max retry attempts per response
    strict_mode: true # Use strict threshold for agent-to-agent

  # Evidence-based APPROVE enforcement
  review_gate:
    enabled: true
    require_evidence: true # Reject APPROVE without test/build/verification

  # Scope enforcement (planned for Week 3)
  scope_guard:
    enabled: false # Not yet implemented
    mode: warn # 'warn' or 'block'
    allowed_patterns: # Glob patterns for allowed files
      - '*.test.ts'
      - '*.md'
      - 'docs/**'
```

### Configuration Options Explained

#### `enforcement.enabled`

**Type:** `boolean`  
**Default:** `true`

Master switch. When `false`, all enforcement is disabled (all responses pass through).

**Use case:** Disable during development/debugging to see raw agent responses.

#### `response_validator.flattery_threshold`

**Type:** `number` (0.0–1.0)  
**Default:** `0.2` (20%)

Maximum allowed flattery ratio. Calculated as:

```
Ratio = (flattery characters) / (total non-code characters)
```

**Recommendations:**

- **Strict (15%):** For production multi-agent workflows
- **Default (20%):** Balanced for most use cases
- **Lenient (30%):** For human-facing responses or initial tuning

**Example:**

```yaml
response_validator:
  flattery_threshold: 0.15 # Stricter 15% threshold
```

#### `response_validator.max_retries`

**Type:** `number`  
**Default:** `3`

Maximum retry attempts when response is rejected.

**Behavior:**

- Retry 1: Agent receives rejection feedback
- Retry 2: Agent receives rejection feedback + warning
- Retry 3: Agent receives rejection feedback + final warning
- After max retries: Response passes through with warning logged

**Example:**

```yaml
response_validator:
  max_retries: 2 # Fail faster
```

#### `review_gate.require_evidence`

**Type:** `boolean`  
**Default:** `true`

When `true`, APPROVE responses must contain evidence patterns (test results, build status, verification steps).

**Evidence patterns:**

- Test results: `tests pass`, `628/628`, `12/12 pass`
- Build: `build succeeded`, `compilation passed`
- TypeScript: `typecheck clean`, `0 errors`
- Verification: `verified`, `checked`, `confirmed`
- Code review: `reviewed code`, `git diff`
- Lint: `lint clean`, `no lint errors`

**Example:**

```yaml
review_gate:
  require_evidence: false # Allow APPROVE without evidence (not recommended)
```

#### `scope_guard.mode`

**Type:** `'warn' | 'block'`  
**Default:** `'warn'`  
**Status:** Planned (Week 3)

- **`warn`:** Log scope violations but allow response
- **`block`:** Reject response on scope violations

**Example:**

```yaml
scope_guard:
  enabled: true
  mode: block # Strict scope enforcement
```

#### `scope_guard.allowed_patterns`

**Type:** `string[]` (glob patterns)  
**Default:** `[]`  
**Status:** Planned (Week 3)

Files matching these patterns are always allowed (bypass scope check).

**Example:**

```yaml
scope_guard:
  allowed_patterns:
    - '*.test.ts' # Test files always allowed
    - '*.md' # Documentation always allowed
    - 'docs/**' # Entire docs directory
    - 'scripts/*.sh' # Build scripts
```

---

## How It Works

### Middleware Chain

```
Agent Response (raw)
    ↓
[1] ResponseValidator
    ↓ REJECT → Retry with feedback (max 3 times)
    ↓ PASS
[2] ReviewGate
    ↓ REJECT → Retry with "provide evidence"
    ↓ PASS
[3] ScopeGuard (planned)
    ↓ WARN → Add warning to response
    ↓ PASS
[4] Post to Discord/Slack
```

### Component Details

#### 1. ResponseValidator

**When:** After every agent response, before Discord post

**What it does:**

1. Strip code blocks (` ``` `) and inline code (`` ` ``)
2. Detect flattery patterns (50 patterns: 26 Korean + 24 English)
3. Calculate flattery ratio = matched chars / total chars
4. Compare against threshold (20% agent-to-agent, 40% human-facing)
5. PASS or REJECT with matched patterns + ratio

**Example rejection:**

```
[SYSTEM] Response rejected: contains praise/flattery.
Flattery ratio 45.2% exceeds 20.0% threshold.
Matched: 완벽합니다, 훌륭합니다, 엔터프라이즈급, masterpiece

Restate with results only. Focus on:
- What was changed
- Test results
- Build status
- Verification steps
```

#### 2. ReviewGate

**When:** When response contains APPROVE/LGTM/승인

**What it does:**

1. Check if response contains approval keywords
2. If not approval → PASS (passthrough)
3. If approval → Extract evidence patterns
4. If evidence found → PASS
5. If no evidence → REJECT

**Example rejection:**

```
[SYSTEM] APPROVE verdict requires evidence (test results, build status,
typecheck, files reviewed). Flattery does not substitute for evidence.

Provide one of:
- Test output (e.g., "Tests pass (628/628)")
- Build status (e.g., "Build succeeded, 0 errors")
- Verification steps (e.g., "Reviewed git diff, checked auth.ts")
```

#### 3. ScopeGuard (Planned)

**When:** For delegated tasks only

**What it does:**

1. Parse EXPECTED OUTCOME from delegation prompt
2. Get modified files from `git diff --name-only`
3. Compare actual vs expected files
4. Warn on unexpected modifications

**Example warning:**

```
⚠️ Scope violation: Modified src/utils.ts, README.md not in expected outcome.
Expected: src/auth.ts, tests/auth.test.ts
Actual: src/auth.ts, tests/auth.test.ts, src/utils.ts, README.md

Severity: WARNING (2 unexpected files)
```

---

## Customization

### Adjusting Flattery Threshold

Start with default (20%), then tune based on false positive rate:

```yaml
# Too many false positives? Increase threshold
response_validator:
  flattery_threshold: 0.25  # 25%

# Too much flattery getting through? Decrease threshold
response_validator:
  flattery_threshold: 0.15  # 15%
```

**Monitor:** Check logs for rejection rate. Target: 5-10% rejection rate.

### Adding Custom Patterns

**Not yet supported.** Patterns are hardcoded in `response-validator.ts` and `review-gate.ts`.

**Planned (Week 4):** Custom pattern configuration:

```yaml
response_validator:
  custom_patterns:
    korean:
      - regex: '대단합니다'
        category: 'direct_praise'
    english:
      - regex: '\bamazing\b'
        category: 'direct_praise'
```

### Allowlists for Technical Terms

**Problem:** Technical terms like "perfect hash" or "excellent performance" trigger false positives.

**Workaround (current):** Wrap in code blocks or inline code:

```markdown
The `perfect` hash function has excellent performance.
```

**Planned (Week 4):** Allowlist configuration:

```yaml
response_validator:
  allowlist:
    - 'perfect hash'
    - 'excellent performance'
    - 'brilliant algorithm'
```

### Per-Agent Configuration

**Not yet supported.** All agents use same enforcement config.

**Planned (Week 5):** Per-agent overrides:

```yaml
multi_agent:
  agents:
    developer:
      enforcement:
        response_validator:
          flattery_threshold: 0.15 # Stricter for developer

    reviewer:
      enforcement:
        review_gate:
          require_evidence: true # Always require evidence
```

---

## Troubleshooting

### False Positives on Korean "확실히"

**Problem:** "확실히" (certainly) is flagged as unnecessary confirmation, but it's legitimate in "확실히 동작합니다" (it certainly works).

**Workaround:**

1. Rephrase: "동작합니다" (it works) or "테스트 통과" (tests pass)
2. Increase threshold temporarily:

```yaml
response_validator:
  flattery_threshold: 0.25 # Allows more Korean confirmations
```

**Status:** Monitoring in production. Will adjust pattern if false positive rate >5%.

### Legitimate Praise Being Blocked

**Problem:** "This is a perfect use case for X" is blocked as flattery.

**Workaround:**

1. Wrap technical terms in code: "This is a `perfect` use case"
2. Rephrase: "This use case fits X well"
3. Increase threshold for human-facing responses (automatic 2× threshold)

**Example:**

```typescript
// Agent-to-agent: 20% threshold (strict)
validator.validate(response, (isAgentToAgent = true));

// Human-facing: 40% threshold (lenient)
validator.validate(response, (isAgentToAgent = false));
```

### APPROVE Rejection Despite Evidence

**Problem:** "APPROVE - I verified the changes" is rejected.

**Reason:** "verified" alone is weak evidence. Add specific verification steps.

**Solution:**

```
❌ Weak: "APPROVE - I verified the changes"
✅ Strong: "APPROVE - Verified: tests pass (12/12), typecheck clean, reviewed git diff"
```

**Evidence patterns:**

- Test results: `tests pass`, `N/N`, `N tests passed`
- Build: `build succeeded`, `0 errors`
- Verification: `reviewed code`, `git diff`, `checked files`

### Scope Guard False Positives

**Status:** Not yet implemented (Week 3)

**Planned workaround:**

```yaml
scope_guard:
  allowed_patterns:
    - '*.test.ts' # Test files always allowed
    - '*.md' # Documentation always allowed
    - 'package.json' # Dependency updates
```

### Retry Loops Increase Latency

**Problem:** Each rejection adds 30-60s retry cycle.

**Solution:**

1. Reduce max retries:

```yaml
response_validator:
  max_retries: 2 # Fail faster
```

2. Monitor retry rate in logs:

```bash
grep "RETRY" ~/.mama/logs/mama.log | wc -l
```

Target: <10% retry rate.

### Enforcement Disabled But Still Rejecting

**Check:**

1. Master switch:

```yaml
enforcement:
  enabled: false # Should disable all enforcement
```

2. Restart MAMA:

```bash
mama stop
mama start
```

3. Verify config loaded:

```bash
grep "enforcement" ~/.mama/logs/mama.log
```

---

## FAQ

### Q: Does enforcement work for human-facing responses?

**A:** Yes, but with lenient threshold (2× configured). Agent-to-agent uses 20%, human-facing uses 40%.

**Rationale:** Humans appreciate some warmth in responses. Agents don't need it.

### Q: Can I disable enforcement for specific agents?

**A:** Not yet. Planned for Week 5 (per-agent overrides).

**Workaround:** Disable globally during development:

```yaml
enforcement:
  enabled: false
```

### Q: What happens after max retries?

**A:** Response passes through with warning logged. Agent is not blocked indefinitely.

**Example log:**

```
[WARN] ResponseValidator: Max retries (3) exceeded. Allowing response with warning.
```

### Q: Does enforcement slow down responses?

**A:** Minimal impact. Validation takes <1ms per response. Retries add 30-60s per rejection.

**Benchmark:** 39 tests (ResponseValidator + ReviewGate) in 35ms total.

### Q: Can I see enforcement metrics?

**A:** Not yet. Planned for Week 5 (metrics dashboard).

**Workaround:** Parse logs:

```bash
# Rejection rate
grep "REJECTED" ~/.mama/logs/mama.log | wc -l

# Retry rate
grep "RETRY" ~/.mama/logs/mama.log | wc -l

# Pass rate
grep "PASSED" ~/.mama/logs/mama.log | wc -l
```

### Q: What if I want stricter enforcement?

**A:** Decrease thresholds:

```yaml
response_validator:
  flattery_threshold: 0.1 # 10% (very strict)
  max_retries: 1 # Fail fast

review_gate:
  require_evidence: true # Always require evidence

scope_guard:
  mode: block # Block on violations (Week 3)
```

### Q: What if I want lenient enforcement?

**A:** Increase thresholds or disable components:

```yaml
response_validator:
  flattery_threshold: 0.3 # 30% (lenient)
  max_retries: 5 # More retries

review_gate:
  require_evidence: false # Allow APPROVE without evidence

scope_guard:
  enabled: false # Disable scope checks
```

### Q: Does enforcement work with Slack/Telegram?

**A:** Yes. Enforcement runs on all gateway responses (Discord, Slack, Telegram).

**Integration points:**

- `multi-agent-discord.ts` (line ~697)
- `multi-agent-slack.ts` (planned Week 3)
- `multi-agent-telegram.ts` (planned Week 3)

### Q: Can I test enforcement without running full agent?

**A:** Yes. Use unit tests:

```bash
cd packages/standalone
pnpm test enforcement
```

Or test manually:

```typescript
import { ResponseValidator, ReviewGate } from './enforcement';

const validator = new ResponseValidator({ flatteryThreshold: 0.2 });
const gate = new ReviewGate({ requireEvidence: true });

const response = '완벽합니다! APPROVED!';
console.log(validator.validate(response, true));
console.log(gate.checkApproval(response));
```

---

## Related Documentation

- [API Reference](../reference/enforcement-api.md) — Detailed API documentation
- [ADR-001: Enforcement Layer Architecture](../adr/ADR-001-enforcement-layer.md) — Design decisions
- [Spike Results](../spike-results-enforcement-layer-2026-02-08.md) — Validation results
- [Implementation Plan](../implementation-plan-enforcement-layer-2026-02-08.md) — 5-week roadmap

---

## Roadmap

| Week | Status         | Components                                |
| ---- | -------------- | ----------------------------------------- |
| 1    | ✅ Complete    | Documentation, ADR-001                    |
| 2    | ✅ Complete    | ResponseValidator, ReviewGate             |
| 3    | 🚧 In Progress | ScopeGuard, TodoTracker (prototype)       |
| 4    | 📅 Planned     | TodoTracker (production), custom patterns |
| 5    | 📅 Planned     | Per-agent config, metrics dashboard       |

**Current Version:** 1.0.0 (Week 2 Complete)

---

**Last Updated:** 2026-02-08  
**Version:** 1.0.0  
**Author:** SpineLift Team
