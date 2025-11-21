# MAMA Plugin Regression Test Harness

**Story**: M4.2 - 회귀 및 시뮬레이션 하네스\
**Purpose**: Catch cross-cutting bugs before releases by simulating typical workflows and hook executions.

---

## Overview

This regression harness provides automated testing for:

1. **Workflow Simulation** (`workflow-simulation.test.js`)
   - Simulates typical MAMA workflows: save→list→suggest, evolution tracking, bulk operations
   - Validates data integrity, output formatting, and performance
   - Ensures consistent behavior across tool interactions

2. **Hook Simulation** (`hook-simulation.test.js`)
   - Simulates PreToolUse, PostToolUse, and UserPromptSubmit hooks
   - Validates injection formatting, transparency banners, and tier awareness
   - Measures hook latency to enforce performance budgets

---

## Running Tests Locally

### Quick Start

```bash
cd mama-plugin

# Run all tests (includes regression harness)
npm test

# Run only regression tests
npm test tests/regression/

# Run specific test file
npm test tests/regression/workflow-simulation.test.js
npm test tests/regression/hook-simulation.test.js

# Watch mode (auto-rerun on changes)
npm run test:watch tests/regression/
```

### Test Output

Successful run:
```
✓ tests/regression/workflow-simulation.test.js (45)
  ✓ Workflow 1: Discovery (save → list → suggest) (2)
  ✓ Workflow 2: Evolution Tracking (save → save → recall) (2)
  ✓ Workflow 3: Bulk Operations (save multiple → list) (2)
  ...

✓ tests/regression/hook-simulation.test.js (38)
  ✓ PreToolUse Hook Simulation (7)
  ✓ PostToolUse Hook Simulation (4)
  ✓ UserPromptSubmit Hook Simulation (4)
  ...

Test Files  2 passed (2)
     Tests  83 passed (83)
  Start at  12:34:56
  Duration  2.84s
```

With performance metrics:
```
[Regression] Discovery workflow latency: 142ms
[Regression] list_decisions p95: 18ms
[Regression] PreToolUse (Read) latency: 89ms
[Regression] PreToolUse p95 latency: 67ms
```

---

## CI Integration

### GitHub Actions

Regression tests run automatically on:
- **Every PR** that modifies `mama-plugin/**`
- **Push to main/develop** branches

Workflow file: `.github/workflows/mama-plugin-tests.yml`

View results:
1. Go to PR → Checks tab
2. Find "MAMA Plugin Tests" workflow
3. Click "Run all tests" or "Run regression harness" step

### Manual Trigger

```bash
# GitHub CLI
gh workflow run mama-plugin-tests.yml

# Or via GitHub UI
Actions → MAMA Plugin Tests → Run workflow
```

---

## Test Coverage

### Workflow Simulation (`workflow-simulation.test.js`)

| Workflow | Tests | Coverage |
|----------|-------|----------|
| **Discovery** (save→list→suggest) | 2 tests | Happy path, performance |
| **Evolution Tracking** (save→save→recall) | 2 tests | Supersedes chain, integrity |
| **Bulk Operations** (multiple saves→list) | 2 tests | Pagination, formatting |
| **Edge Cases** | 3 tests | Validation, empty DB, concurrent ops |
| **Performance** | 2 tests | p95 latency, large dataset |

Total: **11 test scenarios**, **45+ assertions**

### Hook Simulation (`hook-simulation.test.js`)

| Hook | Tests | Coverage |
|------|-------|----------|
| **PreToolUse** | 7 tests | Read/Edit/Grep tools, rate limiting, tier awareness |
| **PostToolUse** | 4 tests | Write/Edit tools, non-triggering tools |
| **UserPromptSubmit** | 4 tests | Prompt handling, empty prompts |
| **Cross-Hook Integration** | 2 tests | Parallel execution, format consistency |
| **Performance** | 2 tests | p95 latency, large dataset |
| **Error Handling** | 3 tests | Missing env vars, DB failures, timeouts |

Total: **22 test scenarios**, **38+ assertions**

---

## Performance Budgets

### Enforced Latency Targets

| Operation | p95 Target | CI Allowance | Notes |
|-----------|-----------|--------------|-------|
| `list_decisions` | < 100ms | < 100ms | SQLite query + formatting |
| `suggest_decision` | < 200ms | < 200ms | Includes semantic search (Tier 2) |
| Discovery workflow | < 500ms | < 500ms | Full save→list→suggest cycle |
| PreToolUse hook | < 100ms | < 500ms | Real-world vs CI overhead |
| PostToolUse hook | < 100ms | < 500ms | Real-world vs CI overhead |

**Note**: CI allowances are more generous to account for shared runner variability.

---

## Interpreting Test Results

### Success Indicators

✅ All tests pass\
✅ Performance metrics within budget\
✅ No stderr output from hook scripts\
✅ Consistent formatting across runs

### Common Failures

#### 1. Performance Regression

```
❌ expect(p95Latency).toBeLessThan(100)
   Expected: < 100
   Received: 147
```

**Cause**: New code added processing overhead\
**Fix**: Profile with `--reporter=verbose`, optimize hot path

#### 2. Hook Script Errors

```
❌ expect(result.exitCode).toBe(0)
   Expected: 0
   Received: 1
   stderr: "Error: Cannot find module 'db-manager.js'"
```

**Cause**: Module path resolution issue\
**Fix**: Check `require()` paths in hook scripts, ensure `PLUGIN_ROOT` is correct

#### 3. Rate Limiting Failures

```
❌ expect(second.stdout).toBe('')
   Expected: ''
   Received: '🔍 PreToolUse...'
```

**Cause**: Rate limit file not cleaned up\
**Fix**: Check `beforeEach()` cleanup, ensure `.pretooluse-last-run` is deleted

#### 4. Flaky Tests (Timing-Dependent)

```
❌ Test timeout (sometimes passes, sometimes fails)
```

**Cause**: Race conditions, async timing issues\
**Fix**: Increase timeouts, add explicit waits, ensure test isolation

---

## Maintenance

### Adding New Regression Tests

1. **Identify the workflow or hook pattern**:
   ```javascript
   describe('Workflow X: Pattern Description', () => {
     it('should complete pattern successfully', async () => {
       // Test implementation
     });
   });
   ```

2. **Follow existing patterns**:
   - Use isolated test DB (`os.tmpdir()`)
   - Force Tier 2 mode (`MAMA_FORCE_TIER_2=true`)
   - Measure performance where applicable
   - Clean up resources in `afterAll()`

3. **Add to appropriate file**:
   - **Workflow patterns** → `workflow-simulation.test.js`
   - **Hook patterns** → `hook-simulation.test.js`

4. **Update this README** with new test coverage

### Updating Performance Budgets

If legitimate changes require higher latency:

1. Profile to understand overhead source
2. Update constants in test files:
   ```javascript
   const MAX_LATENCY_MS = 150; // Increased from 100ms due to X
   ```
3. Document reason in comment
4. Update this README's budget table

### Troubleshooting

**Test DB conflicts**:
```bash
# Find and remove stale test DBs
rm /tmp/mama-*-test-*.db
```

**Hook script permissions**:
```bash
# Ensure hook scripts are executable
chmod +x mama-plugin/scripts/*-hook.js
```

**Node.js version mismatch**:
```bash
# Check version (must be >= 18)
node --version

# Use nvm if needed
nvm use 18
```

**Vitest cache issues**:
```bash
# Clear vitest cache
npx vitest run --clearCache
```

---

## References

- **Story M4.2**: `docs/stories/story-M4.2.md`
- **Test Infrastructure**: M4.1 established list-recall integration test patterns
- **Hook Implementation**: M2 epic (PreToolUse, PostToolUse, UserPromptSubmit)
- **Performance Targets**: PRD FR45-49 (< 100ms p95 for core operations)

---

## FAQ

### Q: Why do tests run slower in CI than locally?

**A**: CI runners are shared and may have higher variance. This is why CI allowances (500ms) are more generous than real-world targets (100ms).

### Q: Should I use snapshots or explicit assertions?

**A**: **Explicit assertions** are preferred for regression tests. Snapshots can be brittle and hide regressions behind "update snapshot" auto-fixes.

### Q: How do I debug a failing hook simulation?

**A**: Enable debug logging:
```bash
DEBUG=mama:* npm test tests/regression/hook-simulation.test.js
```

Or inspect hook stdout/stderr directly:
```javascript
const result = await execHook(PRETOOLUSE_HOOK, {...});
console.log('stdout:', result.stdout);
console.log('stderr:', result.stderr);
```

### Q: Can I run regression tests against production data?

**A**: **No**. Regression tests use isolated test DBs (`os.tmpdir()`). Never point `MAMA_DB_PATH` to production.

### Q: How often should I run regression tests locally?

**A**: **Before every commit** that touches core MAMA functionality (tools, hooks, DB). Use `npm run test:watch` during development.

---

**Last Updated**: 2025-11-21\
**Maintainer**: SpineLift Team\
**Status**: ✅ Active (M4.2 complete, 83 regression tests)
