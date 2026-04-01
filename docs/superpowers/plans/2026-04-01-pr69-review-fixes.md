# PR #69 Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 18 review comments from Gemini Code Assist and CodeRabbit on PR #69 (feat/v016-memory-engine).

**Architecture:** Changes span 4 packages: claude-code-plugin (hook safety), mama-core (noise filter, scope filter, event_date propagation), standalone (queue reliability, handler validation), memorybench (docs accuracy). All fixes are independent and can be parallelized.

**Tech Stack:** TypeScript, Node.js, Vitest

---

### Task 1: Hook stdout safety — `flushAndExit` helper

**Files:**

- Modify: `packages/claude-code-plugin/scripts/userpromptsubmit-hook.js`

- [ ] **Step 1: Replace all `console.log + process.exit` patterns with a safe `flushAndExit` helper**

Replace the 100ms setTimeout exit pattern and all console.log+exit pairs with a helper that uses `process.stdout.write` with a drain callback:

```js
function flushAndExit(json, code = 0) {
  const data = typeof json === 'string' ? json : JSON.stringify(json);
  if (process.stdout.write(data + '\n')) {
    process.exit(code);
  } else {
    process.stdout.once('drain', () => process.exit(code));
    setTimeout(() => process.exit(code), 200);
  }
}
```

Then replace every occurrence:

- Line 35-36: `console.log(JSON.stringify({ continue: true })); process.exit(0);` → `flushAndExit({ continue: true });`
- Line 44-45: same pattern → `flushAndExit(response);`
- Line 50-51: same pattern → `flushAndExit(response);`
- Line 64-65: `console.log(JSON.stringify(response)); setTimeout(() => process.exit(0), 100);` → `flushAndExit(response);`
- Line 75: `console.log(JSON.stringify({ continue: true })); process.exit(0);` → `flushAndExit({ continue: true });`
- Signal handlers (68-71): `() => process.exit(0)` → `() => flushAndExit({ continue: true })`

- [ ] **Step 2: Run tests**

```bash
cd packages/claude-code-plugin && pnpm test
```

- [ ] **Step 3: Commit**

```bash
git add packages/claude-code-plugin/scripts/userpromptsubmit-hook.js
git commit -m "fix(plugin): use flushAndExit helper to prevent dropped stdout"
```

---

### Task 2: Plugin timeout — reduce to 1.8s

**Files:**

- Modify: `packages/claude-code-plugin/.claude-plugin/plugin.json:34`

- [ ] **Step 1: Change UserPromptSubmit hook timeout from 3 to 1.8**

In `plugin.json`, change:

```json
"timeout": 3
```

to:

```json
"timeout": 1.8
```

- [ ] **Step 2: Commit**

```bash
git add packages/claude-code-plugin/.claude-plugin/plugin.json
git commit -m "fix(plugin): reduce UserPromptSubmit hook timeout to 1.8s"
```

---

### Task 3: Queue — include scopes in dedup hash

**Files:**

- Modify: `packages/standalone/src/api/memory-agent-queue.ts:37-39`
- Test: `packages/standalone/tests/api/memory-agent-queue.test.ts`

- [ ] **Step 1: Write failing test for scope-aware dedup**

Add to `memory-agent-queue.test.ts` in the `enqueue` describe block:

```ts
it('should not deduplicate items with same content but different scopes', () => {
  queue = new MemoryAgentQueue({ maxSize: 50, flushInterval: 30_000, onFlush });
  const result1 = queue.enqueue(makeItem('same content', [{ kind: 'project', id: 'proj-a' }]));
  const result2 = queue.enqueue(makeItem('same content', [{ kind: 'project', id: 'proj-b' }]));
  expect(result1).toBe(true);
  expect(result2).toBe(true);
  expect(queue.size).toBe(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/standalone && pnpm vitest run tests/api/memory-agent-queue.test.ts -t "should not deduplicate"
```

Expected: FAIL (both items get same hash, result2 returns false)

- [ ] **Step 3: Fix `computeHash` to include scopes**

In `memory-agent-queue.ts`, change `computeHash`:

```ts
function computeHash(messages: ConversationMessage[], scopes: MemoryScopeRef[] = []): string {
  const scopeKey = scopes
    .map((s) => `${s.kind}:${s.id}`)
    .sort()
    .join('|');
  const content = messages.map((m) => `${m.role}:${m.content}`).join('\n');
  return crypto.createHash('sha256').update(`${scopeKey}\n${content}`).digest('hex');
}
```

Update the call site in `enqueue`:

```ts
const hash = computeHash(item.messages, item.scopes);
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/standalone && pnpm vitest run tests/api/memory-agent-queue.test.ts
```

Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/standalone/src/api/memory-agent-queue.ts packages/standalone/tests/api/memory-agent-queue.test.ts
git commit -m "fix(queue): include scopes in dedup hash to prevent cross-scope collisions"
```

---

### Task 4: Queue — restore items on flush failure

**Files:**

- Modify: `packages/standalone/src/api/memory-agent-queue.ts:98-119`
- Test: `packages/standalone/tests/api/memory-agent-queue.test.ts`

- [ ] **Step 1: Write failing test for flush failure recovery**

Add to `memory-agent-queue.test.ts` in the `flush` describe block:

```ts
it('should restore items on flush failure', async () => {
  const failFlush = vi.fn(async () => {
    throw new Error('transient error');
  });
  queue = new MemoryAgentQueue({ maxSize: 50, flushInterval: 30_000, onFlush: failFlush });
  queue.enqueue(makeItem('important data'));

  await expect(queue.flush()).rejects.toThrow('transient error');

  // Items should be restored
  expect(queue.size).toBe(1);

  // Dedup should still work (hashes restored)
  const result = queue.enqueue(makeItem('important data'));
  expect(result).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/standalone && pnpm vitest run tests/api/memory-agent-queue.test.ts -t "should restore items on flush failure"
```

Expected: FAIL (queue.size is 0 after failed flush)

- [ ] **Step 3: Fix `flush()` to restore on failure**

Replace the `flush()` method in `memory-agent-queue.ts`:

```ts
async flush(): Promise<void> {
  if (this.queue.length === 0 || this.flushing) {
    return;
  }

  this.flushing = true;
  const items = this.queue.splice(0);
  const savedHashes = new Set(this.hashes);
  this.hashes.clear();

  const count = items.length;
  const start = Date.now();

  try {
    await this.onFlush(items);
    const duration = Date.now() - start;
    logger.info(`flushed ${count} items in ${duration}ms`);
  } catch (err) {
    // Restore items and hashes on failure
    this.queue.unshift(...items);
    for (const h of savedHashes) {
      this.hashes.add(h);
    }
    logger.error(`flush failed for ${count} items:`, err);
    throw err;
  } finally {
    this.flushing = false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/standalone && pnpm vitest run tests/api/memory-agent-queue.test.ts
```

Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/standalone/src/api/memory-agent-queue.ts packages/standalone/tests/api/memory-agent-queue.test.ts
git commit -m "fix(queue): restore items and hashes on flush failure to prevent data loss"
```

---

### Task 5: Queue — use DebugLogger instead of console

**Files:**

- Modify: `packages/standalone/src/api/memory-agent-queue.ts`

- [ ] **Step 1: Add DebugLogger import and replace console calls**

At the top of `memory-agent-queue.ts`, add:

```ts
import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';

const { DebugLogger } = debugLogger as unknown as {
  DebugLogger: new (context?: string) => {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
};

const logger = new DebugLogger('MemoryAgentQueue');
```

Then replace:

- `console.error('[MemoryAgentQueue] timer flush error:', err)` → `logger.error('timer flush error:', err)`
- `console.warn('[MemoryAgentQueue] queue full, dropped oldest item')` → `logger.warn('queue full, dropped oldest item')`
- `console.log(...)` in flush → `logger.info(...)` (already shown in Task 4 step 3)
- `console.error(...)` in flush → `logger.error(...)` (already shown in Task 4 step 3)

- [ ] **Step 2: Run tests**

```bash
cd packages/standalone && pnpm vitest run tests/api/memory-agent-queue.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add packages/standalone/src/api/memory-agent-queue.ts
git commit -m "refactor(queue): use DebugLogger instead of console for consistent logging"
```

---

### Task 6: Queue — flush before drop on overflow

**Files:**

- Modify: `packages/standalone/src/api/memory-agent-queue.ts:82-88`

- [ ] **Step 1: Trigger async flush when queue is full instead of dropping**

Replace the overflow section in `enqueue()`:

```ts
// Trigger flush when at max capacity (don't drop items)
if (this.queue.length >= this.maxSize && !this.flushing) {
  this.flush().catch((err) => {
    logger.error('overflow flush error:', err);
  });
}

// If still full after flush attempt (flushing in progress), drop oldest
if (this.queue.length >= this.maxSize) {
  const dropped = this.queue.shift()!;
  if (dropped._hash) {
    this.hashes.delete(dropped._hash);
  }
  logger.warn('queue full during flush, dropped oldest item');
}
```

- [ ] **Step 2: Run tests**

```bash
cd packages/standalone && pnpm vitest run tests/api/memory-agent-queue.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add packages/standalone/src/api/memory-agent-queue.ts
git commit -m "fix(queue): attempt flush before dropping items on overflow"
```

---

### Task 7: Handler — validate scope entries

**Files:**

- Modify: `packages/standalone/src/api/memory-agent-handler.ts:54`

- [ ] **Step 1: Add scope validation before enqueue**

After the message validation loop (line 52), before `const scopes = ...` (line 54), add:

```ts
// Validate scope entries if provided
if (Array.isArray(body.scopes)) {
  for (let i = 0; i < body.scopes.length; i++) {
    const scope = body.scopes[i];
    if (
      !scope ||
      typeof scope !== 'object' ||
      typeof scope.kind !== 'string' ||
      typeof scope.id !== 'string'
    ) {
      res.status(400).json({
        error: `Invalid scope at index ${i}: must have "kind" (string) and "id" (string)`,
        code: 'BAD_REQUEST',
      });
      return;
    }
  }
}
```

- [ ] **Step 2: Run tests**

```bash
cd packages/standalone && pnpm test
```

- [ ] **Step 3: Commit**

```bash
git add packages/standalone/src/api/memory-agent-handler.ts
git commit -m "fix(handler): validate scope entries before accepting request"
```

---

### Task 8: Noise filter — intra-batch dedup + details fallback

**Files:**

- Modify: `packages/mama-core/src/memory/noise-filter.ts:105-115`
- Test: `packages/mama-core/tests/unit/memory-noise-filter.test.ts`

- [ ] **Step 1: Write failing test for intra-batch dedup**

Add to `memory-noise-filter.test.ts` in the `filterNoiseFromUnits` describe block:

```ts
it('removes intra-batch duplicates', () => {
  const units = [
    makeUnit('User prefers dark mode'),
    makeUnit('User prefers dark mode'),
    makeUnit('Project uses TypeScript'),
  ];

  const filtered = filterNoiseFromUnits(units);
  expect(filtered).toHaveLength(2);
  expect(filtered[0].summary).toBe('User prefers dark mode');
  expect(filtered[1].summary).toBe('Project uses TypeScript');
});
```

- [ ] **Step 2: Write failing test for details fallback when summary is noise**

```ts
it('keeps unit when summary is noise but details are meaningful', () => {
  const units: ExtractedMemoryUnit[] = [
    {
      kind: 'fact',
      topic: 'test',
      summary: 'hi there',
      details: 'User greeted and then explained their PostgreSQL migration strategy',
      confidence: 0.8,
    },
  ];

  const filtered = filterNoiseFromUnits(units);
  expect(filtered).toHaveLength(1);
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd packages/mama-core && pnpm vitest run tests/unit/memory-noise-filter.test.ts
```

Expected: Both FAIL

- [ ] **Step 4: Fix `filterNoiseFromUnits` to support both features**

Replace `filterNoiseFromUnits` in `noise-filter.ts`:

```ts
export function filterNoiseFromUnits(
  units: ExtractedMemoryUnit[],
  existingSummaries?: Set<string>
): ExtractedMemoryUnit[] {
  const seen = new Set<string>();
  return units.filter((unit) => {
    const content = unit.summary || unit.details;
    // Check both summary AND details — keep if details are valuable even when summary is noise
    const summaryNoisy = isNoise(unit.summary, existingSummaries);
    const detailsNoisy = !unit.details || isNoise(unit.details, existingSummaries);

    if (summaryNoisy && detailsNoisy) return false;

    // Intra-batch dedup on canonical content
    const normalizedContent = content.toLowerCase();
    if (seen.has(normalizedContent)) return false;
    seen.add(normalizedContent);

    // Also check against existingSummaries for dedup
    if (existingSummaries) {
      for (const existing of existingSummaries) {
        if (existing.toLowerCase() === normalizedContent) return false;
      }
    }

    return true;
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd packages/mama-core && pnpm vitest run tests/unit/memory-noise-filter.test.ts
```

Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add packages/mama-core/src/memory/noise-filter.ts packages/mama-core/tests/unit/memory-noise-filter.test.ts
git commit -m "fix(noise-filter): add intra-batch dedup and details fallback for noisy summaries"
```

---

### Task 9: Noise filter — O(1) duplicate detection

**Files:**

- Modify: `packages/mama-core/src/memory/noise-filter.ts:86-94`

- [ ] **Step 1: Replace O(N) iteration with normalized Set lookup**

In `checkNoise`, replace the duplicate detection block:

```ts
// 4. Exact duplicate summary
if (existingSummaries && existingSummaries.size > 0) {
  const normalizedTrimmed = trimmed.toLowerCase();
  if (existingSummaries.has(normalizedTrimmed)) {
    return { isNoise: true, reason: 'duplicate' };
  }
}
```

This requires that callers pre-normalize their Set. Update `filterNoiseFromUnits` (already done in Task 8) and the test to use a lowercase-normalized set.

- [ ] **Step 2: Update the test for duplicate detection**

In `memory-noise-filter.test.ts`, update the duplicate detection test:

```ts
it('rejects exact duplicate summary (case-insensitive)', () => {
  const existing = new Set(['the project uses sqlite for storage']);
  expect(isNoise('the project uses sqlite for storage', existing)).toBe(true);
  expect(checkNoise('the project uses sqlite for storage', existing).reason).toBe('duplicate');
});

it('allows non-duplicate content', () => {
  const existing = new Set(['the project uses sqlite for storage']);
  expect(isNoise('The project also uses Redis for caching', existing)).toBe(false);
});
```

- [ ] **Step 3: Run tests**

```bash
cd packages/mama-core && pnpm vitest run tests/unit/memory-noise-filter.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add packages/mama-core/src/memory/noise-filter.ts packages/mama-core/tests/unit/memory-noise-filter.test.ts
git commit -m "perf(noise-filter): O(1) duplicate detection via pre-normalized Set lookup"
```

---

### Task 10: Empty scopeFilter returns empty results

**Files:**

- Modify: `packages/mama-core/src/db-adapter/node-sqlite-adapter.ts:323`

- [ ] **Step 1: Handle explicit empty scopeIds**

In `node-sqlite-adapter.ts` vectorSearch, after the existing `scopeIdSet` line (323), add:

```ts
// Explicit empty scope filter = no matches possible
if (scopeFilter && (!scopeFilter.scopeIds || scopeFilter.scopeIds.length === 0)) {
  return [];
}
const scopeIdSet = scopeFilter?.scopeIds?.length ? new Set(scopeFilter.scopeIds) : null;
```

Replace the existing line 323 with the above (move the empty check before the Set creation).

- [ ] **Step 2: Run tests**

```bash
cd packages/mama-core && pnpm test
```

- [ ] **Step 3: Commit**

```bash
git add packages/mama-core/src/db-adapter/node-sqlite-adapter.ts
git commit -m "fix(adapter): return empty results for explicit empty scopeFilter"
```

---

### Task 11: Propagate `event_date` through recall paths

**Files:**

- Modify: `packages/mama-core/src/memory/api.ts` (vector result assembly)

- [ ] **Step 1: Check where vector results are assembled into MemoryRecord**

In `api.ts`, the `toMemoryRecord()` function (line 93) already handles `event_date`. The issue is whether the DB rows being passed to it include `event_date`. Since the `vectorSearch` in `db-manager.ts` does `SELECT * FROM decisions WHERE rowid = ?`, it already includes `event_date`. The `toMemoryRecord` function at line 103 already maps it. This comment is already addressed.

Verify by checking the query:

```bash
grep -n "SELECT.*FROM decisions" packages/mama-core/src/db-manager.ts | head -5
```

The `SELECT * FROM decisions WHERE rowid = ?` (line 361 in db-manager.ts) returns all columns including `event_date`. The `toMemoryRecord` at line 103 maps `row.event_date`. **This is already handled — no code change needed.**

- [ ] **Step 2: Verify `event_date` reaches bundle.memories**

The recall flow: `vectorSearch` → `db-manager.ts` assembles `DecisionRecord` → `api.ts` `recallMemory` calls `toMemoryRecord` on each result → `event_date` is included. **Already working.**

Mark as no-op — respond to reviewer that this is already handled.

---

### Task 12: Pass existingSummaries to filterNoiseFromUnits in ingestConversation

**Files:**

- Modify: `packages/mama-core/src/memory/api.ts:1202`

- [ ] **Step 1: Build existingSummaries set and pass it**

In `api.ts`, before the `filterNoiseFromUnits` call (line 1202), build a set from existing topics:

```ts
// Build existing summaries set for duplicate detection
const existingSummaryRows = adapter
  .prepare(
    `SELECT DISTINCT summary FROM decisions
     WHERE (status = 'active' OR status IS NULL)
     ORDER BY created_at DESC LIMIT 500`
  )
  .all() as Array<{ summary: string }>;
const existingSummaries = new Set(existingSummaryRows.map((r) => (r.summary || '').toLowerCase()));

const filteredUnits = filterNoiseFromUnits(units, existingSummaries);
```

- [ ] **Step 2: Run tests**

```bash
cd packages/mama-core && pnpm test
```

- [ ] **Step 3: Commit**

```bash
git add packages/mama-core/src/memory/api.ts
git commit -m "fix(memory): pass existingSummaries to filterNoiseFromUnits for duplicate detection"
```

---

### Task 13: Timer restoration in queue tests

**Files:**

- Modify: `packages/standalone/tests/api/memory-agent-queue.test.ts:20-22`

- [ ] **Step 1: Move `vi.useRealTimers()` to afterEach**

In `memory-agent-queue.test.ts`, update the `afterEach` block:

```ts
afterEach(() => {
  queue?.stop();
  vi.useRealTimers();
});
```

And remove `vi.useRealTimers()` from inside the timer test body (line 123).

- [ ] **Step 2: Run tests**

```bash
cd packages/standalone && pnpm vitest run tests/api/memory-agent-queue.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add packages/standalone/tests/api/memory-agent-queue.test.ts
git commit -m "fix(tests): move vi.useRealTimers to afterEach to prevent timer leakage"
```

---

### Task 14: Benchmark report — fix branch name, clarify scope, update Next Steps

**Files:**

- Modify: `packages/memorybench/docs/benchmark-200q-report.md`

- [ ] **Step 1: Fix branch name (line 4)**

```
**Branch:** feat/v016-memory-engine
```

- [ ] **Step 2: Clarify improvement scope (line 50)**

```
## Key Improvements (Original 100Q: 58% → 88%)
```

- [ ] **Step 3: Update Next Steps to reflect v0.16 is implemented**

Replace the Next Steps section:

```markdown
## Next Steps

1. Full 500Q benchmark with v0.16 improvements (scope search, noise filtering, temporal metadata) applied
2. Compare with SuperMemory GPT-5 (84.6%) post-v0.16
3. Tune preference extraction prompt for higher accuracy
```

- [ ] **Step 4: Update Weakness Analysis to note v0.16 addresses some issues**

Add after "Fix direction" lines:

- knowledge-update: add `- **v0.16 status:** event_date column added (migration 025), supersede chain improvements in progress`
- temporal-reasoning: add `- **v0.16 status:** event_date field implemented, date-aware ranking pending`

- [ ] **Step 5: Commit**

```bash
git add packages/memorybench/docs/benchmark-200q-report.md
git commit -m "docs(benchmark): fix branch name, clarify scope, update v0.16 status"
```

---

### Task 15: E2E test — set MAMA_FORCE_TIER_3

**Files:**

- Modify: `packages/mama-core/tests/integration/memory-e2e.test.ts:13-23`

- [ ] **Step 1: Set MAMA_FORCE_TIER_3 in beforeAll, restore in afterAll**

```ts
let originalForceTier3: string | undefined;

beforeAll(async () => {
  originalForceTier3 = process.env.MAMA_FORCE_TIER_3;
  process.env.MAMA_FORCE_TIER_3 = 'true';
  process.env.MAMA_DB_PATH = TEST_DB;
  // ... rest of beforeAll
});

afterAll(() => {
  if (originalForceTier3 !== undefined) {
    process.env.MAMA_FORCE_TIER_3 = originalForceTier3;
  } else {
    delete process.env.MAMA_FORCE_TIER_3;
  }
  // ... rest of afterAll
});
```

- [ ] **Step 2: Run tests**

```bash
cd packages/mama-core && pnpm vitest run tests/integration/memory-e2e.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add packages/mama-core/tests/integration/memory-e2e.test.ts
git commit -m "test(e2e): set MAMA_FORCE_TIER_3 for deterministic fast tests"
```

---

### Skipped Items (with justification)

1. **scope-search.test.ts mock vs real adapter** (CR Major): The scope search tests verify the integration contract (scopes pass through to vectorSearch). Rewriting to use real adapter would make this an integration test (already covered by e2e). The unit test of the filtering loop documents the algorithm. Low value to change.

2. **Scope prefilter missing newly saved memories** (CR Major at api.ts:625): Already handled — `bindMemoryToScope` in `db-manager.ts:285` calls `adapter.addScopeBinding()` which updates the in-memory cache immediately after each save. No fix needed.

3. **event_date not reaching recall callers** (CR Major at api.ts:103): Already handled — `SELECT * FROM decisions` returns `event_date`, and `toMemoryRecord()` maps it at line 103. No fix needed.

4. **Noise filter test Story ID headings** (CR Nitpick): The test structure is clear and readable. Adding artificial Story ID annotations provides no value for this project's workflow.
