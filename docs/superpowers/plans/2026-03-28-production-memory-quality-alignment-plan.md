# Production Memory Quality Alignment Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the retrieval improvements proven in MemoryBench into the real production recall/search path, then validate the aligned path on a 100-question benchmark.

**Architecture:** Move the winning behavior from the benchmark-only `MAMAProvider` into `mama-core` so production and benchmark share the same retrieval logic. Specifically, enrich vector-first recall with lexical scoped candidates when vector hits are sparse or semantically off, and ensure `mama.suggest()` benefits from the same improvement because it already routes through `recallMemory()` first.

**Tech Stack:** TypeScript, Vitest, `mama-core`, `standalone`, MemoryBench, SQLite-backed test DBs

---

## File Map

- Modify: `packages/mama-core/src/memory/api.ts`
  - Production recall path used by standalone runtime. Will gain lexical candidate augmentation on top of vector-first retrieval.
- Modify: `packages/mama-core/tests/unit/memory-v2-api.test.ts`
  - Integration-style API tests for `recallMemory()`.
- Modify: `packages/mama-core/tests/unit/memory-v2-legacy-shims.test.ts`
  - Optional if `mama.suggest()` result shape/behavior needs explicit regression coverage.
- Modify: `packages/standalone/tests/benchmark/memory-provider-benchmark.test.ts`
  - Confirms `mama.suggest()` and `recallMemory()` still perform on representative provider-path scenarios.
- Optional modify: `packages/standalone/src/gateways/context-injector.ts`
  - Only if production thresholding still discards now-improved candidates after core changes.

## Chunk 1: Core Retrieval Alignment

### Task 1: Add failing test for vector results augmented by lexical scoped candidates

**Files:**

- Modify: `packages/mama-core/tests/unit/memory-v2-api.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test that saves:

- one answer-bearing memory containing the exact durable fact
- one semantically plausible distractor

Then assert `recallMemory()` for the target question returns the answer-bearing memory even when vector-first retrieval would otherwise be sparse or off-target.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir packages/mama-core test tests/unit/memory-v2-api.test.ts`
Expected: FAIL because current `recallMemory()` only falls back to lexical matching when vector retrieval returns zero results.

- [ ] **Step 3: Write minimal implementation**

In `packages/mama-core/src/memory/api.ts`:

- keep vector retrieval as primary
- compute lexical scoped candidates from the same scope window
- merge lexical candidates with vector candidates when vector hits are sparse, low-coverage, or likely off-target
- preserve truth/status filtering

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --dir packages/mama-core test tests/unit/memory-v2-api.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/mama-core/src/memory/api.ts packages/mama-core/tests/unit/memory-v2-api.test.ts
git commit -m "fix(mama-core): augment vector recall with lexical scoped candidates"
```

### Task 2: Add failing test for legacy `mama.suggest()` benefiting from the same recall improvement

**Files:**

- Modify: `packages/mama-core/tests/unit/memory-v2-legacy-shims.test.ts`

- [ ] **Step 1: Write the failing test**

Add a regression test that asserts `mama.suggest()` returns the answer-bearing memory for the same scenario covered in Task 1, proving legacy callers gain the improvement through `recallMemory()`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir packages/mama-core test tests/unit/memory-v2-legacy-shims.test.ts`
Expected: FAIL or require updated assertions if the shim test is too mocked to prove the real path.

- [ ] **Step 3: Write minimal implementation**

Only adjust tests or shim behavior if needed. Do not add a separate benchmark-only branch in `mama.suggest()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --dir packages/mama-core test tests/unit/memory-v2-legacy-shims.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/mama-core/tests/unit/memory-v2-legacy-shims.test.ts
git commit -m "test(mama-core): cover legacy suggest on aligned recall path"
```

## Chunk 2: Runtime Verification

### Task 3: Verify standalone runtime path still works with improved recall

**Files:**

- Modify: `packages/standalone/tests/benchmark/memory-provider-benchmark.test.ts`
- Optional modify: `packages/standalone/tests/gateways/memory-v2.e2e.test.ts`

- [ ] **Step 1: Add or tighten benchmark scenario coverage**

Cover at least:

- single-session fact recall
- knowledge update recall
- lexical rescue case where exact fact wording matters

- [ ] **Step 2: Run standalone benchmark test to verify failure if behavior is still missing**

Run: `pnpm --dir packages/standalone test tests/benchmark/memory-provider-benchmark.test.ts`
Expected: FAIL if production path still misses lexical rescue.

- [ ] **Step 3: Write minimal implementation**

Only modify standalone runtime code if the improved `mama-core` path still gets filtered out downstream.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --dir packages/standalone test tests/benchmark/memory-provider-benchmark.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/standalone/tests/benchmark/memory-provider-benchmark.test.ts packages/standalone/tests/gateways/memory-v2.e2e.test.ts
git commit -m "test(standalone): verify runtime recall on aligned core path"
```

## Chunk 3: 100-Question Benchmark

### Task 4: Run 100-question benchmark on aligned path

**Files:**

- No code change required

- [ ] **Step 1: Run core verification first**

Run:

```bash
pnpm --dir packages/mama-core test tests/unit/memory-v2-api.test.ts
pnpm --dir packages/standalone test tests/benchmark/memory-provider-benchmark.test.ts
```

Expected: PASS

- [ ] **Step 2: Run 100-question benchmark**

Use the same benchmark workspace and answering/judge model as the validated 10-question runs, but scale to 100 questions.

Run:

```bash
cd /Users/jeongjaehun/.mama/workspace/memorybench
pnpm exec tsx src/index.ts run -p mama -b longmemeval -r mama-bench-v29-prod-aligned-100 -j gpt-5.3-codex -m gpt-5.3-codex -l 100 --force
```

- [ ] **Step 3: Record report**

Read:

```bash
cat /Users/jeongjaehun/.mama/workspace/memorybench/data/runs/mama-bench-v29-prod-aligned-100/report.json
```

Capture:

- accuracy
- MemScore
- Hit@10 / MRR
- by-question-type breakdown

- [ ] **Step 4: Compare against 10-question proof run**

Compare the 100-question report with `mama-bench-v28-local-merge` and explicitly note:

- whether improvements hold at scale
- whether preference/update categories regress
- whether latency remains under the Codex time budget assumptions

- [ ] **Step 5: Update docs if benchmark methodology changes**

If the benchmark is now considered production-aligned rather than provider-adapter-only, record that in the benchmark notes or docs.
