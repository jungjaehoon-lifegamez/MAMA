# Memory Writer Agent Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current standalone memory audit loop with a candidate-driven memory writer pipeline and align future benchmark validation to that runtime path.

**Architecture:** Add a deterministic `SaveCandidateExtractor` in front of the memory agent, reduce the memory agent to a writer that resolves topic/relationship/save actions, and make ack/dashboard semantics candidate-aware. After runtime alignment, add an agent-path benchmark to validate the same path used in live gateways.

**Tech Stack:** TypeScript, Vitest, existing `MessageRouter`, `AgentLoop`, `mama_search` / `mama_save` gateway tools, MAMA standalone dashboard APIs.

---

## Chunk 1: Candidate Extraction Foundation

### Task 1: Add candidate contracts

**Files:**

- Create: `packages/standalone/src/memory/save-candidate-types.ts`
- Test: `packages/standalone/tests/memory/save-candidate-extractor.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test that asserts a candidate object shape exists for explicit decision text.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir packages/standalone test tests/memory/save-candidate-extractor.test.ts`
Expected: FAIL because the module/types do not exist yet.

- [ ] **Step 3: Write minimal implementation**

Create shared types:

```ts
export type SaveCandidateKind =
  | 'decision'
  | 'preference'
  | 'fact'
  | 'constraint'
  | 'lesson'
  | 'profile_update'
  | 'change';

export interface SaveCandidate {
  id: string;
  kind: SaveCandidateKind;
  confidence: number;
  topicHint?: string;
  summary: string;
  evidence: string[];
  channelKey: string;
  source: string;
  channelId: string;
  userId?: string;
  projectId?: string;
  createdAt: number;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --dir packages/standalone test tests/memory/save-candidate-extractor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/standalone/src/memory/save-candidate-types.ts packages/standalone/tests/memory/save-candidate-extractor.test.ts
git commit -m "feat(standalone): add memory save candidate types"
```

### Task 2: Implement deterministic candidate extractor

**Files:**

- Create: `packages/standalone/src/memory/save-candidate-extractor.ts`
- Test: `packages/standalone/tests/memory/save-candidate-extractor.test.ts`

- [ ] **Step 1: Write failing tests**

Cover at least:

- explicit decision sentence → `decision`
- explicit preference sentence → `preference`
- pure acknowledgment → no candidates
- change/count sentence → `change`

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm --dir packages/standalone test tests/memory/save-candidate-extractor.test.ts`
Expected: FAIL on missing extractor behavior.

- [ ] **Step 3: Write minimal implementation**

Implement deterministic extraction using phrase/keyword heuristics:

- decision triggers: `앞으로`, `쓰자`, `결정`, `기억해`, `we decided`, `use`, `default`
- preference triggers: `prefer`, `선호`, `favorite`, `recommend`, `좋아`
- change triggers: `처음`, `이제`, `now`, `since`, `initially`
- ignore pure greetings/thanks

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --dir packages/standalone test tests/memory/save-candidate-extractor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/standalone/src/memory/save-candidate-extractor.ts packages/standalone/tests/memory/save-candidate-extractor.test.ts
git commit -m "feat(standalone): add deterministic memory save candidate extractor"
```

## Chunk 2: Message Router Rewire

### Task 3: Change audit job into writer job input

**Files:**

- Modify: `packages/standalone/src/memory/audit-task-queue.ts`
- Modify: `packages/standalone/src/gateways/message-router.ts`
- Test: `packages/standalone/tests/gateways/message-router.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests that verify:

- explicit decision text produces at least one candidate
- memory agent invocation receives candidate metadata, real source/channel/user scope
- no candidate means no memory-agent invocation

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --dir packages/standalone test tests/gateways/message-router.test.ts`
Expected: FAIL because the router still invokes audit on every qualifying turn.

- [ ] **Step 3: Write minimal implementation**

In `MessageRouter`:

- compute a recent-turn window
- call `extractSaveCandidates(...)`
- if zero candidates, stop before enqueuing
- if one or more candidates, include candidates in the job payload

Update job type:

```ts
interface MemoryWriteJob {
  turnId: string;
  channelKey: string;
  source: string;
  channelId: string;
  userId?: string;
  scopeContext: MemoryScopeRef[];
  conversation: string;
  candidates: SaveCandidate[];
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --dir packages/standalone test tests/gateways/message-router.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/standalone/src/memory/audit-task-queue.ts packages/standalone/src/gateways/message-router.ts packages/standalone/tests/gateways/message-router.test.ts
git commit -m "feat(standalone): route memory agent through save candidates"
```

### Task 4: Tighten audit prompt into writer prompt

**Files:**

- Modify: `packages/standalone/src/gateways/message-router.ts`
- Modify: `packages/standalone/src/multi-agent/memory-agent-persona.ts`
- Test: `packages/standalone/tests/gateways/message-router.test.ts`
- Test: `packages/standalone/tests/multi-agent/memory-agent-persona.test.ts`

- [ ] **Step 1: Write failing tests**

Assert the writer prompt/persona:

- refers to candidates
- requires `mama_search`
- requires `mama_save` when candidates are provided
- does not frame the agent primarily as an auditor

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm --dir packages/standalone test tests/gateways/message-router.test.ts tests/multi-agent/memory-agent-persona.test.ts`
Expected: FAIL on old wording and old prompt shape.

- [ ] **Step 3: Write minimal implementation**

Update prompt so the agent receives:

- candidate list
- explicit instruction: candidates exist, so save must be attempted unless contradicted by search evidence
- explicit output expectation through tool calls

Rewrite persona headline and responsibilities around `writer` semantics.

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --dir packages/standalone test tests/gateways/message-router.test.ts tests/multi-agent/memory-agent-persona.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/standalone/src/gateways/message-router.ts packages/standalone/src/multi-agent/memory-agent-persona.ts packages/standalone/tests/gateways/message-router.test.ts packages/standalone/tests/multi-agent/memory-agent-persona.test.ts
git commit -m "feat(standalone): turn memory agent into writer workflow"
```

## Chunk 3: Ack and Dashboard Semantics

### Task 5: Make ack classification candidate-aware

**Files:**

- Modify: `packages/standalone/src/memory/memory-agent-ack.ts`
- Test: `packages/standalone/tests/gateways/memory-agent-ack.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests covering:

- no candidates + no save → `skipped`
- candidates + no save → `failed` or `needs_review`
- candidates + decision count increased → `applied`

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm --dir packages/standalone test tests/gateways/memory-agent-ack.test.ts`
Expected: FAIL because current ack logic ignores candidate presence.

- [ ] **Step 3: Write minimal implementation**

Pass candidate count or candidate IDs into ack classification.

Prefer:

```ts
if (afterDecisionCount > beforeDecisionCount) applied;
else if (candidateCount > 0 && !usedSaveTool) failed;
else skipped;
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --dir packages/standalone test tests/gateways/memory-agent-ack.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/standalone/src/memory/memory-agent-ack.ts packages/standalone/tests/gateways/memory-agent-ack.test.ts
git commit -m "feat(standalone): classify memory skips using candidate presence"
```

### Task 6: Expose candidate lifecycle in dashboard

**Files:**

- Modify: `packages/standalone/src/memory/memory-agent-dashboard.ts`
- Modify: `packages/standalone/src/cli/commands/start.ts`
- Test: `packages/standalone/tests/memory/memory-agent-dashboard.test.ts`

- [ ] **Step 1: Write failing tests**

Assert dashboard payload includes:

- `candidatesDetected`
- `saveAttempted`
- `saveApplied`
- `saveSkipped`
- `saveFailed`

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm --dir packages/standalone test tests/memory/memory-agent-dashboard.test.ts`
Expected: FAIL because these fields are absent.

- [ ] **Step 3: Write minimal implementation**

Extend memory agent stats and payload helper to expose candidate lifecycle counts and a clearer summary message (`skipped` vs `failed`).

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --dir packages/standalone test tests/memory/memory-agent-dashboard.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/standalone/src/memory/memory-agent-dashboard.ts packages/standalone/src/cli/commands/start.ts packages/standalone/tests/memory/memory-agent-dashboard.test.ts
git commit -m "feat(standalone): expose memory candidate lifecycle in dashboard"
```

## Chunk 4: Benchmark Alignment

### Task 7: Define agent-path benchmark contract

**Files:**

- Create: `docs/superpowers/specs/2026-03-27-memory-agent-path-benchmark-design.md`
- Modify: `~/.mama/workspace/memorybench/src/providers/mama/index.ts`
- Test: `~/.mama/workspace/memorybench/src/providers/mama/index.test.ts`

- [ ] **Step 1: Write the failing benchmark alignment test**

Add a provider test that asserts the benchmark path cannot bypass the candidate-extractor/writer flow once the new runtime path is exposed.

- [ ] **Step 2: Run test to verify failure**

Run: `cd <memorybench-workspace> && npx --yes tsx --test src/providers/mama/index.test.ts`
Expected: FAIL until provider alignment contract is updated.

- [ ] **Step 3: Write minimal implementation**

Do not fully migrate benchmark in the same task. First document and expose a provider contract that distinguishes:

- provider-path benchmark
- agent-path benchmark

Add runtime hook points or TODO guards so future reruns cannot claim runtime equivalence without agent-path mode.

- [ ] **Step 4: Run tests to verify pass**

Run: `cd <memorybench-workspace> && npx --yes tsx --test src/providers/mama/index.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-03-27-memory-agent-path-benchmark-design.md <memorybench-workspace>/src/providers/mama/index.ts <memorybench-workspace>/src/providers/mama/index.test.ts
git commit -m "docs: define agent-path benchmark alignment for memory agent"
```

## Chunk 5: Verification and Runtime Smoke

### Task 8: Full standalone verification

**Files:**

- Modify: none
- Test: `packages/standalone/tests/gateways/message-router.test.ts`
- Test: `packages/standalone/tests/gateways/memory-agent-ack.test.ts`
- Test: `packages/standalone/tests/memory/memory-agent-dashboard.test.ts`

- [ ] **Step 1: Run focused standalone tests**

Run:

```bash
pnpm --dir packages/standalone test tests/gateways/message-router.test.ts tests/gateways/memory-agent-ack.test.ts tests/memory/memory-agent-dashboard.test.ts
```

Expected: PASS

- [ ] **Step 2: Run standalone build**

Run:

```bash
pnpm --dir packages/standalone build
```

Expected: exit code `0`

- [ ] **Step 3: Restart standalone**

Run:

```bash
node /Users/jeongjaehun/project/MAMA/packages/standalone/dist/cli/index.js stop
node /Users/jeongjaehun/project/MAMA/packages/standalone/dist/cli/index.js start
node /Users/jeongjaehun/project/MAMA/packages/standalone/dist/cli/index.js status
```

Expected:

- daemon restarts cleanly
- no stale codex child leak from current daemon
- status shows running

- [ ] **Step 4: Runtime smoke in Telegram**

Send:

- `앞으로 이 프로젝트에서는 PostgreSQL을 기본 데이터베이스로 사용하자. 이건 기억해.`
- then `우리 이 프로젝트에서 DB 뭐 쓰기로 했지?`

Expected:

- memory dashboard shows candidate lifecycle activity
- at least one memory save applies
- recall answer mentions `PostgreSQL`

- [ ] **Step 5: Commit**

```bash
git add packages/standalone
git commit -m "feat(standalone): reframe memory agent as candidate-driven writer"
```

## Chunk 6: Follow-up Benchmark Execution

### Task 9: Re-run benchmark only after runtime path alignment

**Files:**

- Read: `/Users/jeongjaehun/.mama/workspace/memorybench/data/runs/mama-bench-quality-step4-20260327/report.json`
- Modify: benchmark runner config only if needed

- [ ] **Step 1: Run the runtime-aligned sample benchmark**

Run a 10-question sample only after the runtime path is aligned.

- [ ] **Step 2: Compare against the current baseline**

Current baseline to beat:

- `mama-bench-quality-step4-20260327`
- accuracy `70%`
- avg context `2797`
- avg search `10340ms`

- [ ] **Step 3: Record results**

Save a new MAMA checkpoint/decision explaining:

- whether candidate-driven writer path improved quality
- whether explicit decision false-skips were reduced
- whether preference retrieval still requires deeper storage redesign

- [ ] **Step 4: Commit benchmark follow-up docs/config if changed**

```bash
git add docs/superpowers/specs /Users/jeongjaehun/.mama/workspace/memorybench
git commit -m "docs: record runtime-aligned memory benchmark results"
```

Plan complete and saved to `docs/superpowers/plans/2026-03-27-memory-writer-agent-implementation.md`. Ready to execute?
