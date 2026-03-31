# MemoryBench Quality Regression Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolate and fix the current MAMA benchmark quality regression by correcting retrieval rerank behavior first, then validating answer-prompt context strategy with benchmark evidence instead of guesswork.

**Architecture:** Treat the regression as two separate paths: retrieval ordering and answer-context formatting. Fix the retrieval path first because the current rerank gate is provably mis-scaled for similarity scores and is likely firing almost always. Keep the answer-context path under experiment control until we can compare compact vs raw prompt modes against the same saved search inputs.

**Tech Stack:** TypeScript, Node test runner, MemoryBench provider/prompt pipeline, MAMA Graph API, saved benchmark artifacts under `~/.mama/workspace/memorybench`

---

## File Map

- Modify: `packages/memorybench/src/providers/mama/index.ts`
  - Owns MAMA provider retrieval flow, rerank gate, server-scoped search path, and local lexical fallback.
- Modify: `packages/memorybench/src/providers/mama/index.test.ts`
  - Should cover rerank trigger conditions and server-scoped retrieval behavior.
- Modify: `packages/memorybench/src/types/prompts.ts`
  - Owns compact context serialization contract used by answer prompts.
- Modify: `packages/memorybench/src/types/prompts.test.ts`
  - Should lock the context serialization contract and prevent silent prompt regressions.
- Create: `packages/memorybench/src/orchestrator/phases/answer-context-mode.test.ts`
  - Small evidence-driven test harness for compact-vs-raw context generation using stable fixtures.
- Optionally modify: `packages/memorybench/src/prompts/defaults.ts`
  - Only if prompt wording must acknowledge a selectable context mode after evidence gathering.
- Optional docs update: `packages/memorybench/README.md`
  - Record any new env flag or benchmark mode once behavior is finalized.

## Chunk 1: Retrieval Regression Guardrail

### Task 1: Add failing rerank gate tests for similarity-scale inputs

**Files:**

- Modify: `packages/memorybench/src/providers/mama/index.test.ts`

- [ ] **Step 1: Write the failing test**

Add tests that assert:

- strong scoped results with cosine-like scores (`0.9`, `0.82`) do **not** trigger semantic rerank by default
- preference-style queries can still trigger rerank
- ambiguous low-separation candidates only trigger rerank when ambiguity is actually present on the 0-1 scale

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsx --test src/providers/mama/index.test.ts`
Expected: FAIL because current gate treats `topScore < 12` as ambiguous, which always fires for 0-1 similarities.

- [ ] **Step 3: Write minimal implementation**

In `packages/memorybench/src/providers/mama/index.ts`:

- replace the current `topScore < 12` heuristic with similarity-scale aware logic
- base ambiguity on small score gap and weak token coverage, not on an impossible absolute threshold
- keep preference queries as an explicit opt-in path

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsx --test src/providers/mama/index.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/memorybench/src/providers/mama/index.ts packages/memorybench/src/providers/mama/index.test.ts
git commit -m "fix(memorybench): make rerank gate similarity-scale aware"
```

### Task 2: Add regression coverage for scoped server search without unnecessary rerank

**Files:**

- Modify: `packages/memorybench/src/providers/mama/index.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test that verifies:

- server-scoped `topicPrefix` results are returned directly when the top candidate already has clear lexical/query coverage
- rerank is bypassed in that case

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsx --test src/providers/mama/index.test.ts`
Expected: FAIL because the current gate still reranks clear scoped results.

- [ ] **Step 3: Write minimal implementation**

Tighten `maybeSemanticRerank()` call sites so clear scoped results stay in original order.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsx --test src/providers/mama/index.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/memorybench/src/providers/mama/index.ts packages/memorybench/src/providers/mama/index.test.ts
git commit -m "test(memorybench): guard scoped retrieval from unnecessary rerank"
```

## Chunk 2: Answer Context Evidence

### Task 3: Lock the existing compact-context contract with tests

**Files:**

- Modify: `packages/memorybench/src/types/prompts.test.ts`

- [ ] **Step 1: Write the failing test**

Extend tests to assert:

- compact context includes `relevance_snippet`, `numeric_clues`, `time_clues`, and `preference_clues`
- the compact form stays under a bounded token/size budget for large session blobs

- [ ] **Step 2: Run test to verify it fails if the contract is broken**

Run: `pnpm exec tsx --test src/types/prompts.test.ts`
Expected: FAIL on any raw-JSON regression.

- [ ] **Step 3: Write minimal implementation**

If needed, restore or keep compact serialization in `packages/memorybench/src/types/prompts.ts` so the answer prompt contract matches the actual serialized context.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsx --test src/types/prompts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/memorybench/src/types/prompts.ts packages/memorybench/src/types/prompts.test.ts
git commit -m "test(memorybench): lock compact answer context contract"
```

### Task 4: Add a compact-vs-raw answer-context comparison harness

**Files:**

- Create: `packages/memorybench/src/orchestrator/phases/answer-context-mode.test.ts`
- Optionally modify: `packages/memorybench/src/types/prompts.ts`

- [ ] **Step 1: Write the failing test**

Create a fixture-driven test using saved search results from `~/.mama/workspace/memorybench/data/runs/...` or checked-in minimal fixtures that compares:

- compact prompt token count
- raw prompt token count
- presence/absence of answer-critical evidence in each mode

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm exec tsx --test src/orchestrator/phases/answer-context-mode.test.ts`
Expected: FAIL because the comparison helper does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Implement a tiny comparison helper that builds both prompt variants from the same context input and reports token counts plus retained evidence.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsx --test src/orchestrator/phases/answer-context-mode.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/memorybench/src/orchestrator/phases/answer-context-mode.test.ts packages/memorybench/src/types/prompts.ts
git commit -m "test(memorybench): add compact vs raw answer context comparison"
```

## Chunk 3: Benchmark Verification

### Task 5: Re-run narrow provider tests after retrieval fix

**Files:**

- No code change required

- [ ] **Step 1: Run provider tests**

Run: `pnpm exec tsx --test src/providers/mama/index.test.ts`
Expected: PASS

- [ ] **Step 2: Run prompt tests**

Run: `pnpm exec tsx --test src/types/prompts.test.ts`
Expected: PASS

- [ ] **Step 3: Record benchmark command for retrieval-only validation**

Run the same benchmark shape used for the recent regression, but first with rerank fixed and no other answer-path changes.

Suggested command:

```bash
grep -n "mama-bench-v25" /tmp/mama-bench-v25.log
```

Use the real benchmark command from the current shell history or existing run script, then compare:

- Hit@10 / MRR
- single-session-preference accuracy
- average search latency

- [ ] **Step 4: Only after retrieval stabilizes, run answer-context comparison**

Compare the retrieval-stable baseline against compact/raw prompt variants using the same saved search results or same benchmark question set.

- [ ] **Step 5: Update docs if behavior changes**

If an env flag or explicit context mode is introduced, document it in `packages/memorybench/README.md`.
