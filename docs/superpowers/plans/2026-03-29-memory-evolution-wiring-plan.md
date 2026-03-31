# Memory Evolution Wiring — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire existing graph expansion into recallMemory(), validate with a 10-question temporal/multi-session subset benchmark.

**Architecture:** Export `expandWithGraph()` from mama-api.ts, call it in recallMemory() to populate `graph_context.expanded` and `edges`. Add `loadEdgesForIds()` helper. Run a targeted 10-question benchmark to measure improvement before full 100-question run.

**Tech Stack:** TypeScript, mama-core, memorybench, SQLite decision_edges table, Vitest/node:test

**Spec:** `docs/superpowers/specs/2026-03-29-memory-evolution-pipeline-design.md`

---

## File Map

- Modify: `packages/mama-core/src/mama-api.ts` — export expandWithGraph
- Modify: `packages/mama-core/src/memory/api.ts` — wire graph expansion into recallMemory, add loadEdgesForIds, add skipGraphExpansion option
- Create: `packages/mama-core/tests/unit/recall-graph-expansion.test.ts` — test graph expansion in recall
- Modify: `packages/memorybench/src/providers/mama/index.ts` — remove PHOTOGRAPHY_EXPANSION, DINNER_EXPANSION, remove semanticRerankLocalRecords from search path

---

## Chunk 1: Export expandWithGraph from mama-api

### Task 1: Export expandWithGraph

**Files:**

- Modify: `packages/mama-core/src/mama-api.ts:1120`

- [ ] **Step 1: Add expandWithGraph to the mama object exports**

In `packages/mama-core/src/mama-api.ts`, find the `const mama = {` object (around line 1390+) and add `expandWithGraph` to it. Also find the `async function expandWithGraph` declaration at line 1120 — it's already a top-level function, just not exported.

Find the mama object literal and add:

```typescript
  expandWithGraph,
```

alongside the other search-related exports like `search`, `suggest`, `scanAutoLinks`.

- [ ] **Step 2: Verify the export compiles**

Run: `cd packages/mama-core && pnpm build`
Expected: tsc succeeds with no errors

- [ ] **Step 3: Commit**

```bash
git add packages/mama-core/src/mama-api.ts
git commit -m "feat(mama-core): export expandWithGraph for recall integration"
```

---

## Chunk 2: Wire graph expansion into recallMemory

### Task 2: Add loadEdgesForIds helper

**Files:**

- Modify: `packages/mama-core/src/memory/api.ts`

- [ ] **Step 1: Write the loadEdgesForIds function**

Add this function in `packages/mama-core/src/memory/api.ts` after the existing `mergeRecallCandidates` function (around line 300):

```typescript
async function loadEdgesForIds(ids: string[]): Promise<MemoryEdge[]> {
  if (ids.length === 0) return [];
  await initDB();
  const adapter = getAdapter();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = adapter
    .prepare(
      `SELECT from_id, to_id, relationship AS type, reason
       FROM decision_edges
       WHERE from_id IN (${placeholders}) OR to_id IN (${placeholders})`
    )
    .all(...ids, ...ids) as Array<{
    from_id: string;
    to_id: string;
    type: string;
    reason: string | null;
  }>;
  return rows.map((row) => ({
    from_id: row.from_id,
    to_id: row.to_id,
    type: row.type as MemoryEdge['type'],
    reason: row.reason ?? undefined,
  }));
}
```

- [ ] **Step 2: Verify build**

Run: `cd packages/mama-core && pnpm build`
Expected: tsc succeeds

- [ ] **Step 3: Commit**

```bash
git add packages/mama-core/src/memory/api.ts
git commit -m "feat(mama-core): add loadEdgesForIds helper for graph-aware recall"
```

### Task 3: Add skipGraphExpansion option to RecallMemoryOptions

**Files:**

- Modify: `packages/mama-core/src/memory/api.ts:52-56`

- [ ] **Step 1: Extend the interface**

In `packages/mama-core/src/memory/api.ts`, find `interface RecallMemoryOptions` (line 52) and add:

```typescript
interface RecallMemoryOptions {
  scopes?: MemoryScopeRef[];
  includeProfile?: boolean;
  includeHistory?: boolean;
  skipGraphExpansion?: boolean;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/mama-core/src/memory/api.ts
git commit -m "feat(mama-core): add skipGraphExpansion to RecallMemoryOptions"
```

### Task 4: Wire expandWithGraph into recallMemory

**Files:**

- Modify: `packages/mama-core/src/memory/api.ts`

- [ ] **Step 1: Add import for expandWithGraph**

At the top of `packages/mama-core/src/memory/api.ts`, add an import. Since `mama-api.ts` exports via `const mama = {...}` and `expandWithGraph` is in the same package, import directly from the module:

```typescript
import { expandWithGraph } from '../mama-api.js';
```

Note: This may cause a circular dependency since mama-api.ts imports from memory/api.ts. If it does, we'll inline the graph expansion logic instead. Check in Step 3.

- [ ] **Step 2: Replace the static graph_context population**

Find this code block in `recallMemory()` (around line 557):

```typescript
bundle.graph_context.primary = matched;
bundle.graph_context.expanded = [];
bundle.graph_context.edges = [];
```

Replace with:

```typescript
bundle.graph_context.primary = matched;
bundle.graph_context.expanded = [];
bundle.graph_context.edges = [];

if (matched.length > 0 && !options.skipGraphExpansion) {
  try {
    const candidates = matched.map((m) => ({
      id: m.id,
      topic: m.topic,
      decision: m.summary,
      confidence: m.confidence,
      created_at: m.created_at,
      similarity: m.confidence ?? 0.5,
    }));
    const expanded = await expandWithGraph(candidates);
    const primaryIds = new Set(matched.map((m) => m.id));
    const expandedOnly = expanded.filter((e) => !primaryIds.has(e.id));

    bundle.graph_context.expanded = expandedOnly.map((e) => ({
      id: e.id,
      topic: e.topic,
      kind: 'decision' as MemoryKind,
      summary: String(e.decision || ''),
      details: '',
      confidence: e.graph_rank ?? 0.5,
      status: 'active' as MemoryStatus,
      scopes: [],
      source: { package: 'mama-core' as const, source_type: e.graph_source || 'graph_expansion' },
      created_at: e.created_at ?? Date.now(),
      updated_at: e.created_at ?? Date.now(),
    }));

    const allIds = [...matched.map((m) => m.id), ...expandedOnly.map((e) => e.id)];
    bundle.graph_context.edges = await loadEdgesForIds(allIds);
  } catch {
    // Graph expansion is best-effort; do not fail recall
  }
}
```

- [ ] **Step 3: Verify build (check for circular dependency)**

Run: `cd packages/mama-core && pnpm build`

If circular dependency error:

- Remove the import from step 1
- Copy `expandWithGraph` and its helpers (`queryDecisionGraph`, `querySemanticEdges`) into `memory/api.ts` or a shared `memory/graph-expansion.ts` file
- The function is ~160 lines but self-contained

Expected: tsc succeeds

- [ ] **Step 4: Run existing tests**

Run: `pnpm test`
Expected: All tests pass (graph expansion is additive, no existing behavior changes)

- [ ] **Step 5: Commit**

```bash
git add packages/mama-core/src/memory/api.ts
git commit -m "feat(mama-core): wire expandWithGraph into recallMemory graph_context"
```

---

## Chunk 3: Test graph expansion in recall

### Task 5: Write recall graph expansion test

**Files:**

- Create: `packages/mama-core/tests/unit/recall-graph-expansion.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateEmbeddingMock = vi.fn();
const vectorSearchMock = vi.fn();
const queryDecisionGraphMock = vi.fn();
const querySemanticEdgesMock = vi.fn();

let decisionRows: Array<Record<string, unknown>> = [];
let edgeRows: Array<Record<string, unknown>> = [];

vi.mock('../../src/embeddings.js', () => ({
  generateEmbedding: generateEmbeddingMock,
}));

vi.mock('../../src/db-manager.js', () => ({
  initDB: vi.fn(async () => {}),
  getAdapter: vi.fn(() => ({
    prepare(sql: string) {
      return {
        all: (..._args: unknown[]) => {
          if (sql.includes('FROM decision_edges')) return edgeRows;
          if (sql.includes('FROM memory_scope_bindings')) return [];
          if (sql.includes('FROM decisions')) return decisionRows;
          return [];
        },
      };
    },
  })),
  insertDecisionWithEmbedding: vi.fn(),
  ensureMemoryScope: vi.fn(async () => 1),
  vectorSearch: vectorSearchMock,
  queryDecisionGraph: queryDecisionGraphMock,
  querySemanticEdges: querySemanticEdgesMock,
}));

describe('recallMemory with graph expansion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    decisionRows = [];
    edgeRows = [];
    queryDecisionGraphMock.mockResolvedValue([]);
    querySemanticEdgesMock.mockResolvedValue({});
  });

  it('should populate graph_context.expanded when edges exist', async () => {
    generateEmbeddingMock.mockResolvedValue(new Float32Array(384));
    vectorSearchMock.mockResolvedValue([
      {
        id: 'mem-current',
        topic: 'therapist_schedule',
        decision: 'I see my therapist biweekly',
        reasoning: 'Changed from weekly',
        confidence: 0.9,
        created_at: 200,
        status: 'active',
      },
    ]);

    queryDecisionGraphMock.mockResolvedValue([
      {
        id: 'mem-previous',
        topic: 'therapist_schedule',
        decision: 'I see my therapist weekly',
        confidence: 0.8,
        created_at: 100,
      },
    ]);

    edgeRows = [
      { from_id: 'mem-current', to_id: 'mem-previous', type: 'supersedes', reason: 'Same topic' },
    ];

    const { recallMemory } = await import('../../src/memory/api.js');
    const bundle = await recallMemory('How often do I see my therapist?');

    expect(bundle.graph_context.primary.length).toBeGreaterThan(0);
    expect(bundle.graph_context.expanded.length).toBeGreaterThan(0);
    expect(bundle.graph_context.edges.length).toBeGreaterThan(0);

    const expandedTopics = bundle.graph_context.expanded.map((e) => e.topic);
    expect(expandedTopics).toContain('therapist_schedule');
  });

  it('should return empty expanded when skipGraphExpansion is true', async () => {
    generateEmbeddingMock.mockResolvedValue(new Float32Array(384));
    vectorSearchMock.mockResolvedValue([
      {
        id: 'mem-1',
        topic: 'test',
        decision: 'test decision',
        reasoning: '',
        confidence: 0.9,
        created_at: 100,
        status: 'active',
      },
    ]);

    const { recallMemory } = await import('../../src/memory/api.js');
    const bundle = await recallMemory('test query', { skipGraphExpansion: true });

    expect(bundle.graph_context.expanded).toEqual([]);
    expect(bundle.graph_context.edges).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd packages/mama-core && pnpm vitest run tests/unit/recall-graph-expansion.test.ts`

Note: This test may need adjustment based on the actual circular dependency resolution from Task 4. If `expandWithGraph` was moved to a separate file, update the mock accordingly.

Expected: 2 tests pass

- [ ] **Step 3: Commit**

```bash
git add packages/mama-core/tests/unit/recall-graph-expansion.test.ts
git commit -m "test(mama-core): add recall graph expansion tests"
```

---

## Chunk 4: Remove benchmark cheats

### Task 6: Remove query expansion and semantic rerank from MAMA provider

**Files:**

- Modify: `packages/memorybench/src/providers/mama/index.ts`

- [ ] **Step 1: Delete PHOTOGRAPHY_EXPANSION and DINNER_EXPANSION constants**

In `packages/memorybench/src/providers/mama/index.ts`, delete the arrays at lines ~77-99:

```typescript
// DELETE these:
const PHOTOGRAPHY_EXPANSION = [...]
const DINNER_EXPANSION = [...]
```

- [ ] **Step 2: Simplify getExpandedQueryTokens to return empty**

Find `getExpandedQueryTokens` method and replace its body:

```typescript
private getExpandedQueryTokens(_query: string): string[] {
  return [];
}
```

- [ ] **Step 3: Remove semantic rerank from search path**

In the `search()` method, find the call to `maybeSemanticRerank()` or `semanticRerankLocalRecords()` and replace with a pass-through. Find the block that calls rerank (around line 580-600) and simplify:

Replace any reranking call with just returning the ranked results directly. The server-side graph expansion now handles retrieval quality.

- [ ] **Step 4: Run memorybench tests**

Run: `cd packages/memorybench && bun test`
Expected: All tests pass (tests for rerank may need updating — delete rerank-specific test cases)

- [ ] **Step 5: Commit**

```bash
git add packages/memorybench/src/providers/mama/index.ts
git commit -m "fix(memorybench): remove benchmark-only query expansion and semantic rerank cheats"
```

---

## Chunk 5: Run 10-question validation benchmark

### Task 7: Select and run temporal/multi-session subset

**Files:**

- No code changes — benchmark execution only

- [ ] **Step 1: Identify 10 target question IDs**

Pick 5 temporal + 5 multi-session failures from v47:

Temporal (5):

- `gpt4_8279ba03` — "What kitchen appliance did I buy 10 days ago?"
- `8077ef71` — "How many days ago did I attend a networking event?"
- `gpt4_468eb063` — "How many days ago did I meet Emma?"
- `bcbe585f` — "How many weeks ago did I attend a bird watching workshop?"
- `gpt4_93159ced_abs` — "How many weeks ago did I attend the 'Summer Nights' festival?"

Multi-session (5):

- `gpt4_2f8be40d` — "How many weddings have I attended this year?"
- `2ce6a0f2` — "How many different art-related events did I attend?"
- `7024f17c` — "How many hours of jogging and yoga did I do last week?"
- `3fdac837` — "Total number of days I spent in Japan and Chicago?"
- `4f54b7c9` — "How many antique items did I inherit or acquire?"

- [ ] **Step 2: Run the subset benchmark**

```bash
cd /Users/jeongjaehun/.mama/workspace/memorybench
bun run src/index.ts run \
  -p mama -b longmemeval \
  -j gpt-5.3-codex -m gpt-5.3-codex \
  -r mama-bench-v48-graph-subset \
  --data-source-run mama-bench-v41-clean-100 \
  --questions gpt4_8279ba03,8077ef71,gpt4_468eb063,bcbe585f,gpt4_93159ced_abs,gpt4_2f8be40d,2ce6a0f2,7024f17c,3fdac837,4f54b7c9
```

Note: If `--questions` flag doesn't exist, check the CLI help for the correct way to specify a subset. Alternative: use `test` command for individual questions.

- [ ] **Step 3: Compare results against v47 baseline**

Read the report:

```bash
cat data/runs/mama-bench-v48-graph-subset/report.json | python3 -c "
import json, sys
r = json.load(sys.stdin)
s = r['summary']
print(f'Accuracy: {s[\"accuracy\"]*100:.1f}% ({s[\"correctCount\"]}/{s[\"totalQuestions\"]})')
by_type = r.get('byQuestionType', {})
for cat, d in by_type.items():
    print(f'  {cat}: {d[\"accuracy\"]*100:.1f}% ({d[\"correct\"]}/{d[\"total\"]})')
"
```

Expected improvement: at least 1-2 more correct vs v47 baseline (where all 10 were wrong).

- [ ] **Step 4: Document results**

Record the v48 subset results in a comment on PR #68 or in the spec file, comparing:

- v47 baseline (0/10 on these questions)
- v48 with graph expansion (target: 2-4/10)

---

## Success Criteria

- [ ] `pnpm test` passes (all existing tests + new graph expansion test)
- [ ] `bun test` in memorybench passes (with cheat removal)
- [ ] `recallMemory()` populates `graph_context.expanded` and `edges` when edges exist
- [ ] 10-question subset shows measurable improvement over v47 baseline
- [ ] No benchmark-only cheats remain (no query expansion, no semantic rerank)
