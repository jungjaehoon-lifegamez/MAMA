# Extraction & Column Mapping Cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix column mapping confusion in saveMemory, remove regex-first extraction, and strengthen LLM post-validation so extraction produces correct, non-hallucinated memories with properly separated fields.

**Architecture:** Remove the 2-stage regex-first/LLM-fallback pipeline in `ingestConversation`, use LLM-only extraction with post-validation against source text. Fix `details` to contain quoted source sentences (not full conversation). Restore scope-aware topic loading that was removed when regex-first was added.

**Tech Stack:** TypeScript, Vitest, SQLite (better-sqlite3), mama-core memory API

---

### Task 1: Add post-validation test (strengthen threshold)

**Files:**

- Modify: `packages/mama-core/tests/unit/memory-v2-extraction.test.ts`

- [ ] **Step 1: Write failing test for 70% post-validation threshold**

Add to the `ingestConversation` describe block:

```typescript
it('should reject hallucinated units from extraction (post-validation)', async () => {
  setExtractionFn(async () => [
    {
      kind: 'fact' as const,
      topic: 'camera_purchase',
      summary: 'User bought a Sony A7IV camera at Best Buy on March 15',
      details: 'User mentioned buying a Sony A7IV.',
      confidence: 0.9,
    },
    {
      kind: 'fact' as const,
      topic: 'hallucinated_trip',
      summary: 'User traveled to Antarctica for a research expedition in January',
      details: 'User discussed their Antarctica research trip.',
      confidence: 0.85,
    },
  ]);

  const result = await ingestConversation({
    messages: [
      { role: 'user', content: 'I just bought a Sony A7IV camera.' },
      { role: 'assistant', content: 'Great choice! The Sony A7IV is excellent for photography.' },
    ],
    scopes: [{ kind: 'user', id: 'test-validation' }],
    source: { package: 'mama-core', source_type: 'test' },
    extract: { enabled: true },
  });

  // Sony fact should pass (keywords exist in conversation)
  // Antarctica fact should be rejected (keywords not in conversation)
  expect(result.extractedMemories).toHaveLength(1);
  expect(result.extractedMemories[0].topic).toBe('camera_purchase');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/mama-core && npx vitest run tests/unit/memory-v2-extraction.test.ts -t "should reject hallucinated"`
Expected: FAIL — currently both units pass because 50% threshold is too low, or regex-first bypasses LLM entirely

- [ ] **Step 3: Commit test**

```bash
git add packages/mama-core/tests/unit/memory-v2-extraction.test.ts
git commit -m "test: add post-validation hallucination rejection test"
```

---

### Task 2: Remove regex-first stage, restore LLM-only extraction

**Files:**

- Modify: `packages/mama-core/src/memory/api.ts:1170-1235`

- [ ] **Step 1: Write failing test for LLM-only path with details as quoted sentences**

Add to `memory-v2-extraction.test.ts`:

```typescript
it('should store details as quoted source sentences, not full conversation', async () => {
  setExtractionFn(async () => [
    {
      kind: 'decision' as const,
      topic: 'database_choice',
      summary: 'Decided to use PostgreSQL for the e-commerce project',
      details: 'User said: "Let\'s use PostgreSQL for the e-commerce app"',
      confidence: 0.9,
    },
  ]);

  const result = await ingestConversation({
    messages: [
      { role: 'user', content: "Let's use PostgreSQL for the e-commerce app." },
      { role: 'assistant', content: 'PostgreSQL is great for relational data.' },
      { role: 'user', content: 'Also, we need to set up CI/CD next week.' },
    ],
    scopes: [{ kind: 'project', id: 'test:details' }],
    source: { package: 'mama-core', source_type: 'test' },
    extract: { enabled: true },
  });

  expect(result.extractedMemories).toHaveLength(1);

  // Recall and verify details is the quoted sentence, not full conversation
  const recall = await recallMemory('PostgreSQL', {
    scopes: [{ kind: 'project', id: 'test:details' }],
  });
  const match = recall.memories.find((m) => m.topic === 'database_choice');
  expect(match).toBeDefined();
  // details should contain the LLM-provided quote, not the entire conversation
  expect(match!.details).toContain('PostgreSQL');
  expect(match!.details).not.toContain('CI/CD next week');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/mama-core && npx vitest run tests/unit/memory-v2-extraction.test.ts -t "should store details as quoted"`
Expected: FAIL — regex path sets `details: conversationText` (entire conversation)

- [ ] **Step 3: Rewrite ingestConversation extraction section**

In `packages/mama-core/src/memory/api.ts`, replace the entire regex-first + LLM-fallback block (lines ~1172-1235) with LLM-only extraction:

```typescript
// LLM extraction with scope-aware topic reuse
try {
  await initDB();
  const adapter = getAdapter();

  // Fetch existing topics so LLM can reuse them (enables supersedes edges)
  let existingTopics: Array<{ topic: string }>;
  if (input.scopes && input.scopes.length > 0) {
    const scopeIds = await Promise.all(
      input.scopes.map((scope) => ensureMemoryScope(scope.kind, scope.id))
    );
    const placeholders = scopeIds.map(() => '?').join(', ');
    existingTopics = adapter
      .prepare(
        `SELECT DISTINCT d.topic FROM decisions d
           JOIN memory_scope_bindings msb ON msb.memory_id = d.id
           WHERE msb.scope_id IN (${placeholders})
             AND (d.status = 'active' OR d.status IS NULL)
           ORDER BY d.created_at DESC LIMIT 200`
      )
      .all(...scopeIds) as Array<{ topic: string }>;
  } else {
    existingTopics = adapter
      .prepare(
        `SELECT DISTINCT topic FROM decisions
           WHERE (status = 'active' OR status IS NULL)
           ORDER BY created_at DESC LIMIT 200`
      )
      .all() as Array<{ topic: string }>;
  }
  const topicList = existingTopics.map((r) => r.topic);

  const prompt = buildExtractionPrompt(input.messages, topicList);
  const rawUnits = await extractionFn(prompt, input.extract);

  // Post-validation: reject units whose key content words aren't in the source text.
  // Threshold 70% — stricter than previous 50% to catch hallucinated facts.
  const convLower = conversationText.toLowerCase();
  units = rawUnits.filter((u) => {
    const words = u.summary
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 4);
    if (words.length === 0) return true; // very short summary, let noise filter handle
    const matchCount = words.filter((w) => convLower.includes(w)).length;
    const ratio = matchCount / words.length;
    if (ratio < 0.7) {
      info(
        `[memory] rejected hallucinated unit: "${u.summary.slice(0, 80)}" (${Math.round(ratio * 100)}% match)`
      );
      return false;
    }
    return true;
  });

  info(`[memory] LLM extraction: ${rawUnits.length} raw → ${units.length} verified`);
} catch (err) {
  warn(`[memory] LLM extraction failed: ${err instanceof Error ? err.message : String(err)}`);
  return result;
}
```

- [ ] **Step 4: Remove the fact-extractor import**

Remove the dynamic import of `./fact-extractor.js` that was inside the regex-first block. The file `fact-extractor.ts` stays on disk but is no longer imported by `api.ts`.

- [ ] **Step 5: Run all extraction tests**

Run: `cd packages/mama-core && npx vitest run tests/unit/memory-v2-extraction.test.ts`
Expected: All tests PASS including the two new ones

- [ ] **Step 6: Commit**

```bash
git add packages/mama-core/src/memory/api.ts packages/mama-core/tests/unit/memory-v2-extraction.test.ts
git commit -m "feat: remove regex-first extraction, LLM-only with 70% post-validation"
```

---

### Task 3: Fix details column — quoted sentences only

**Files:**

- Modify: `packages/mama-core/src/memory/api.ts` (ingestMemory function, ~line 1052-1064)

- [ ] **Step 1: Fix ingestMemory details**

The `ingestMemory` function (raw blob save) currently sets `details: 'Raw conversation: ${input.content}'`. This is correct for raw blobs — no change needed here. The fix is in `ingestConversation` which was already fixed in Task 2 (LLM now provides the quote via `unit.details`).

Verify that `saveMemory` mapping is clear:

```typescript
// In saveMemory — line 443-444:
//   decision: input.summary    ← extracted statement
//   reasoning: input.details   ← quoted sentences from LLM
// This is correct. No code change needed.
```

- [ ] **Step 2: Verify the toMemoryRecord mapping is consistent**

In `toMemoryRecord` (line 93-104), verify:

```typescript
summary: String(row.summary ?? row.decision ?? ''),  // ← extracted statement
details: String(row.reasoning ?? row.decision ?? ''), // ← quoted sentences
```

This is correct — `reasoning` holds the LLM quote, falls back to `decision` if null.

- [ ] **Step 3: Run full test suite**

Run: `cd packages/mama-core && npx vitest run tests/unit/`
Expected: All PASS

- [ ] **Step 4: Commit (if any changes)**

Only commit if adjustments were needed. Otherwise skip.

---

### Task 4: Run 12Q benchmark regression test

**Files:**

- Read: `packages/memorybench/src/providers/mama/index.ts`

- [ ] **Step 1: Check if 12Q benchmark can be run**

Run: `cd packages/memorybench && ls src/providers/mama/`
Check the benchmark runner and understand how to execute it.

- [ ] **Step 2: Run the 12Q benchmark**

Run the benchmark (exact command depends on setup — likely `npx vitest run` or a custom script).
Expected: Top1 >= 92%, Top3 = 100%

- [ ] **Step 3: If regression detected, diagnose and fix**

Compare failing questions against previous results. The most likely regression point is the 70% threshold being too strict — if so, lower to 65% and re-test.

- [ ] **Step 4: Commit benchmark results if passing**

```bash
git add -A
git commit -m "test: verify 12Q benchmark passes after extraction cleanup"
```

---

### Task 5: Clean up unused imports and dead code

**Files:**

- Modify: `packages/mama-core/src/memory/api.ts`

- [ ] **Step 1: Remove unused imports**

Remove the import of `filterNoiseFromUnits` if it's no longer used (check — it's still used in the noise filter stage after extraction, so likely stays). Remove `info` import if it was only used in regex logging (check — it's used in LLM path too, so stays).

Verify no reference to `fact-extractor.js` remains in `api.ts`.

- [ ] **Step 2: Run type check**

Run: `cd packages/mama-core && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run full test suite**

Run: `cd packages/mama-core && npx vitest run`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add packages/mama-core/src/memory/api.ts
git commit -m "refactor: remove unused regex extraction imports"
```
