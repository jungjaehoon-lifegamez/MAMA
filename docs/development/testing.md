# Testing Guide

MAMA has a comprehensive test suite with 134 tests across unit, integration, and regression tests.

---

## Quick Reference

```bash
# Run all tests
npm test

# Run specific test file
npm test tests/skills/mama-context-skill.test.js

# Run with coverage
npm run test:coverage

# Run performance benchmarks
npm run test:performance
```

---

## Test Structure

### Test Categories

| Category              | Count | Purpose                                 | Location             |
| --------------------- | ----- | --------------------------------------- | -------------------- |
| **Unit Tests**        | 62    | Core logic (embeddings, scoring, graph) | `tests/unit/`        |
| **Integration Tests** | 39    | Commands, hooks, workflows              | `tests/integration/` |
| **Regression Tests**  | 33    | Bug prevention                          | `tests/regression/`  |
| **Performance Tests** | -     | Latency benchmarks                      | `tests/performance/` |

**Total:** 134 tests (100% pass rate)

---

## Running Tests

### All Tests

```bash
npm test

# Expected output:
# ✅ 134 tests passed
# ⏱️  Duration: ~8 seconds
```

### Specific Test Suite

```bash
# Unit tests only
npm test tests/unit/

# Integration tests only
npm test tests/integration/

# Specific file
npm test tests/unit/embeddings.test.js
```

### Watch Mode

```bash
npm test -- --watch

# Tests re-run on file changes
```

### M1R Envelope Runtime Verification

Use this focused suite when changing Reactive envelope issuance, gateway tool
execution, `agent_activity` audit rows, or envelope health/status APIs:

```bash
MAMA_FORCE_TIER_3=true pnpm -C packages/standalone exec vitest run tests/contract/m1r-envelope-completion-matrix.test.ts tests/contract/envelope-callsite-matrix.test.ts tests/agent/delegation-executor.test.ts tests/envelope/executor-pipeline.test.ts tests/envelope/agent-loop-internal-tool-context.test.ts tests/envelope/code-act-context.test.ts tests/cli/runtime/agent-loop-init-envelope-options.test.ts tests/cli/runtime/envelope-bootstrap.test.ts tests/envelope/reactive-config.test.ts tests/envelope/memory-scope-mismatch-logging.test.ts tests/envelope/executor-audit.test.ts tests/db/agent-activity.test.ts tests/api/health-envelope.test.ts tests/api/envelope-status-auth.test.ts tests/envelope/executor-integration.test.ts tests/contract/reactive-envelope.test.ts tests/contract/reactive-envelope-tool-path.test.ts tests/contract/envelope-drift-sentinel.test.ts tests/contract/code-task-delegation-empty-scopes.test.ts
pnpm -C packages/standalone typecheck
pnpm -C packages/standalone test
pnpm test
pnpm build
git diff --check
```

`MAMA_FORCE_TIER_3=true` skips embedding work during focused verification, which
keeps local and CI runs faster and less sensitive to embedding runtime latency.

`/health` must stay public and envelope-free. Envelope runtime metadata and the
24-hour scope-mismatch count are verified through authenticated
`/api/envelope/status`, with the count sourced from `agent_activity`, not
best-effort metrics.

### M2 Memory Provenance Foundation

Use this focused suite when changing memory provenance columns, trusted
provenance sanitization, gateway correlation ids, or memory provenance query
helpers:

```bash
pnpm -C packages/mama-core exec vitest run tests/memory/memory-provenance.test.ts tests/memory/memory-provenance-query.test.ts tests/cases/migration-chain.test.ts tests/cases/migration-runner-duplicate-column.test.ts
pnpm -C packages/mcp-server exec vitest run tests/tools/save-decision-v2.test.js tests/tools/ingest-conversation-provenance.test.js
pnpm -C packages/standalone exec vitest run tests/envelope/memory-provenance-context.test.ts tests/envelope/executor-audit.test.ts tests/envelope/memory-scope-mismatch-logging.test.ts tests/db/agent-activity.test.ts tests/gateways/message-router.test.ts tests/agent/gateway-tool-executor.test.ts tests/cli/runtime/memory-agent-init.test.ts
pnpm -C packages/mama-core typecheck
pnpm -C packages/standalone typecheck
git diff --check
```

These tests prove that public callers cannot spoof trusted provenance, direct
writes still create fallback save events, gateway memory writes receive a typed
`gateway_call_id`, and provenance reads use `memory_scope_bindings` for scoped
visibility.

---

## Test Coverage

```bash
npm run test:coverage

# Output:
# Overall coverage: 87%
# - Statements: 88%
# - Branches: 85%
# - Functions: 90%
# - Lines: 87%
```

**Coverage report:** `coverage/index.html`

**Target:** >80% coverage

---

## Writing Tests

### Unit Test Example

```javascript
// tests/unit/similarity.test.js
import { cosineSimilarity } from '../../src/core/similarity.js';

describe('cosineSimilarity', () => {
  test('identical vectors return 1.0', () => {
    const v1 = [1, 0, 0];
    const v2 = [1, 0, 0];
    expect(cosineSimilarity(v1, v2)).toBe(1.0);
  });

  test('orthogonal vectors return 0.0', () => {
    const v1 = [1, 0, 0];
    const v2 = [0, 1, 0];
    expect(cosineSimilarity(v1, v2)).toBe(0.0);
  });
});
```

### Integration Test Example

```javascript
// tests/integration/mama-save.test.js
import { executeMamaSave } from '../../src/commands/mama-save.js';

describe('/mama-save command', () => {
  test('saves decision to database', async () => {
    const result = await executeMamaSave({
      topic: 'test_topic',
      decision: 'Use Vitest',
      reasoning: 'Better ESM support',
      confidence: 0.9,
    });

    expect(result.success).toBe(true);
    expect(result.id).toBeGreaterThan(0);
  });
});
```

### Regression Test Example

```javascript
// tests/regression/fuzzy-matching-bug.test.js
describe('Regression: Fuzzy matching bug', () => {
  test('exact match preferred over fuzzy', async () => {
    // Bug: Fuzzy match ranked higher than exact match
    await save({ topic: 'auth_strategy', decision: 'JWT' });
    await save({ topic: 'authorization', decision: 'RBAC' });

    const results = await recall('auth_strategy');
    expect(results[0].topic).toBe('auth_strategy'); // Exact match first
  });
});
```

---

## Test Utilities

### Mock Database

```javascript
import { createMockDb } from '../helpers/mock-db.js';

const db = createMockDb();
// Use db in tests, automatically cleaned up
```

### Mock Embeddings

```javascript
import { mockEmbeddings } from '../helpers/mock-embeddings.js';

mockEmbeddings.setMockVector([0.1, 0.2, 0.3, ...]);
```

### Test Fixtures

```javascript
import { fixtures } from '../helpers/fixtures.js';

const testDecision = fixtures.decision();
const testQuery = fixtures.query();
```

---

## Performance Testing

### Run Benchmarks

```bash
npm run test:performance

# Output:
# Hook latency: 102ms (target: <500ms) ✅
# Embedding: 3ms (target: <30ms) ✅
# Vector search: 48ms (target: <100ms) ✅
# Save: 19ms (target: <50ms) ✅
```

### Performance Test Example

```javascript
// tests/performance/search-latency.test.js
describe('Search performance', () => {
  test('vector search completes within 100ms', async () => {
    const start = Date.now();
    await vectorSearch('test query');
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(100);
  });
});
```

---

## Continuous Integration

### GitHub Actions

Tests run automatically on:

- Every push
- Every pull request
- Daily schedule (regression)

**Workflow:** `.github/workflows/test.yml`

### Pre-commit Hooks

```bash
# Install pre-commit hooks
npm run prepare

# Runs automatically before commit:
# 1. Lint
# 2. Type check
# 3. Tests
```

---

## Debugging Tests

### Debug Specific Test

```bash
# Enable debug output
MAMA_DEBUG=true npm test tests/unit/embeddings.test.js

# Use Node debugger
node --inspect-brk node_modules/.bin/jest tests/unit/embeddings.test.js
```

### Test-only Mode

```javascript
test.only('this test runs alone', () => {
  // Only this test runs
});
```

---

## Test Guidelines

### DO:

- ✅ Test behavior, not implementation
- ✅ Write descriptive test names
- ✅ Use fixtures for complex data
- ✅ Clean up after tests (close DB, etc.)
- ✅ Test edge cases and errors

### DON'T:

- ❌ Mock internal functions (test real implementation)
- ❌ Use `console.log` for debugging (use DebugLogger)
- ❌ Skip tests with `.skip()` in commits
- ❌ Write flaky tests (timing-dependent)

---

## Test Coverage Requirements

**For new code:**

- Unit tests: 100% coverage
- Integration tests: Required for commands/hooks
- Regression tests: Required for bug fixes

**For existing code:**

- Maintain overall coverage >80%
- Don't reduce coverage in PRs

---

## See Also

- [Developer Playbook](developer-playbook.md) - Development setup
- [Code Standards](code-standards.md) - Coding conventions
- [Contributing Guide](contributing.md) - How to contribute
- [Architecture](../explanation/architecture.md) - System design
