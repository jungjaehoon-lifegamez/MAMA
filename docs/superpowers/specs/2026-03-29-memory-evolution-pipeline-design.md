# Memory Evolution Pipeline — Minimal Wiring Design

> MAMA's differentiator: memories are never overwritten — evolution history is preserved. Failures become assets.

**Goal:** Wire the already-implemented evolution engine, graph expansion, and memory agent together so benchmarks can prove MAMA's differentiator and improve temporal/multi-session recall.

**Approach:** Minimal wiring — minimize new code, connect existing implementations.

---

## Current State Diagnosis

### Already Implemented (Not Used)

| Component                  | File                                                 | Status                                                        |
| -------------------------- | ---------------------------------------------------- | ------------------------------------------------------------- |
| `resolveMemoryEvolution()` | `mama-core/src/memory/evolution-engine.ts:85`        | supersedes (exact topic match) + builds_on (2+ shared tokens) |
| `expandWithGraph()`        | `mama-core/src/mama-api.ts:1120`                     | Per-edge-type ranking, interleaving, 1-hop traversal          |
| `querySemanticEdges()`     | `mama-core/src/db-manager.ts:655`                    | Bidirectional edge queries (outgoing + incoming)              |
| `queryDecisionGraph()`     | `mama-core/src/db-manager.ts:588`                    | Supersedes chain retrieval per topic                          |
| `projectMemoryTruth()`     | `mama-core/src/memory/truth-store.ts:49`             | Truth status management (active/superseded/contradicted)      |
| Memory writer agent        | `standalone/src/multi-agent/memory-agent-persona.ts` | search → evolve → save workflow                               |
| `decision_edges` table     | migrations 001, 006, 010                             | 6 edge types, governance columns, indexes                     |

### Missing Connections

| Gap                                              | Location                                  | Impact                                                          |
| ------------------------------------------------ | ----------------------------------------- | --------------------------------------------------------------- |
| `recallMemory()` never calls `expandWithGraph()` | `api.ts:557-559`                          | `graph_context.expanded = []`, `edges = []` always empty        |
| Benchmark doesn't use agent path                 | `memorybench/providers/mama/index.ts:421` | Uses `ingestConversation()` — no supersedes edges between units |
| No HTTP API for agent path                       | `graph-api.ts`                            | Benchmark cannot invoke memory agent                            |
| No evolution question dataset                    | —                                         | MAMA differentiator unmeasured                                  |

---

## Design: 3 Changes

### Change 1: Wire graph expansion into recallMemory()

**File:** `packages/mama-core/src/memory/api.ts`

**Current code (line 557-559):**

```typescript
bundle.graph_context.primary = matched;
bundle.graph_context.expanded = []; // ← always empty
bundle.graph_context.edges = []; // ← always empty
```

**After:**

```typescript
bundle.graph_context.primary = matched;

// Graph expansion: follow edges to find evolution history + related memories
if (matched.length > 0 && !options.skipGraphExpansion) {
  const candidates = matched.map((m) => ({
    id: m.id,
    topic: m.topic,
    decision: m.summary,
    confidence: m.confidence,
    created_at: m.created_at,
    similarity: m.confidence,
  }));
  const expanded = await expandWithGraph(candidates);
  const expandedOnly = expanded.filter((e) => !matched.some((m) => m.id === e.id));

  bundle.graph_context.expanded = expandedOnly.map((e) => ({
    id: e.id,
    topic: e.topic,
    kind: 'decision' as MemoryKind,
    summary: e.decision || '',
    details: '',
    confidence: e.graph_rank ?? 0.5,
    status: 'active' as MemoryStatus,
    scopes: [],
    source: { package: 'mama-core', source_type: e.graph_source || 'graph_expansion' },
    created_at: e.created_at ?? Date.now(),
    updated_at: e.created_at ?? Date.now(),
  }));

  // Collect edges from DB for matched + expanded nodes
  const allIds = [...matched.map((m) => m.id), ...expandedOnly.map((e) => e.id)];
  bundle.graph_context.edges = await loadEdgesForIds(allIds);
}
```

**Required helpers:**

- `loadEdgesForIds(ids: string[])` — query `decision_edges` where from_id or to_id is in the ID set
- `expandWithGraph` import — currently module-private in `mama-api.ts`, needs export

**`RecallMemoryOptions` extension:**

```typescript
interface RecallMemoryOptions {
  // ... existing fields
  skipGraphExpansion?: boolean; // default false. true skips edge traversal
}
```

**Impact:**

- All `recallMemory()` callers automatically get graph context
- Backward compatible (`skipGraphExpansion` defaults to false; consumers that ignore expanded/edges are unaffected)
- MCP SearchEngine already uses `expandWithGraph()` in `mama-api.ts` — recall gets the same logic

---

### Change 2: Audit Conversation API Endpoint

**File:** `packages/standalone/src/api/graph-api.ts`

**New endpoint:** `POST /api/mama/audit-conversation`

Exposes the production memory writer agent path over HTTP. When the benchmark calls this endpoint:

1. `extractSaveCandidates()` — regex candidate detection
2. `buildMemoryAuditPrompt()` — construct agent prompt with scopes + candidates
3. `AuditTaskQueue.enqueue()` — run memory agent (search → evolve → save)
4. Automatic edge creation (same topic → supersedes, shared tokens → builds_on)

**Request:**

```typescript
POST /api/mama/audit-conversation
{
  messages: Array<{role: 'user'|'assistant', content: string}>,
  scopes: Array<{kind: string, id: string}>,
  source: {package: string, source_type: string}
}
```

**Response:**

```typescript
{
  success: boolean,
  ack: {
    status: 'applied' | 'skipped' | 'failed',
    action: 'save' | 'supersede' | 'no_op',
    event_ids: string[],
    reason: string
  }
}
```

**Implementation approach:**

- Add route to `graph-api.ts`
- Reuse `MessageRouter.triggerMemoryAgent` logic but return ack synchronously for HTTP response
- No cooldown (benchmark ingests entire conversations at once)
- Reuse existing `AuditTaskQueue` + `memoryAgentLoop`

**Dependencies:**

- Needs access to `MessageRouter` or `AgentProcessManager` memory agent instance
- `createGraphHandler` already accepts `GraphHandlerOptions` — pass memory agent reference as an option

---

### Change 3: Benchmark provider switch + evolution questions

**File:** `packages/memorybench/src/providers/mama/index.ts`

**Ingest change:**

```typescript
// Before: POST /api/mama/ingest-conversation (LLM extraction only, no inter-unit edges)
// After:  POST /api/mama/audit-conversation (agent path, automatic edge creation)

async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
  for (const session of sessions) {
    const res = await fetch(`${this.baseUrl}/api/mama/audit-conversation`, {
      method: 'POST',
      body: JSON.stringify({
        messages: session.messages,
        scopes: [{ kind: 'channel', id: options.containerTag }],
        source: { package: 'standalone', source_type: 'memorybench' }
      })
    });
    // ...
  }
}
```

**Search changes — remove benchmark-only cheats:**

- Delete `PHOTOGRAPHY_EXPANSION`, `DINNER_EXPANSION` (overfitting)
- Remove `semanticRerankLocalRecords` (or apply equally to all providers)
- Keep `rankLocalRecords` (lexical fallback exists in mama-core too)
- Server recall now includes graph expansion, so client-side compensation is unnecessary

**Evolution questions:**

Add questions to existing LongMemEval conversations where knowledge-update / temporal / multi-session patterns contain evolution:

| Existing Question                    | Added Question (evolution)                                      | Tests                      |
| ------------------------------------ | --------------------------------------------------------------- | -------------------------- |
| "How often do I see my therapist?"   | "Has my therapist visit frequency changed? What was it before?" | supersedes chain traversal |
| "What database do I use?"            | "Did I switch from a different DB? Why?"                        | evolution reasoning        |
| "What's my current workout routine?" | "How has my workout routine evolved?"                           | temporal evolution         |

**Implementation:**

- `packages/memorybench/data/benchmarks/longmemeval/evolution-questions.json` — hand-curated
- Reuses existing LongMemEval conversations, only adds new questions
- New questionType: `decision-evolution`
- LongMemEvalBenchmark loader merges evolution questions with existing questions

---

## File Map

| Change | File                                                                        | What Changes                                                      |
| ------ | --------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Modify | `packages/mama-core/src/memory/api.ts`                                      | Wire expandWithGraph() into recallMemory(), add loadEdgesForIds() |
| Modify | `packages/mama-core/src/mama-api.ts`                                        | Export expandWithGraph()                                          |
| Modify | `packages/mama-core/src/memory/types.ts`                                    | Add skipGraphExpansion to RecallMemoryOptions                     |
| Modify | `packages/standalone/src/api/graph-api.ts`                                  | POST /api/mama/audit-conversation endpoint                        |
| Modify | `packages/standalone/src/api/graph-api-types.ts`                            | Add memory agent reference to GraphHandlerOptions                 |
| Modify | `packages/memorybench/src/providers/mama/index.ts`                          | Switch ingest to audit-conversation, remove cheats                |
| Modify | `packages/memorybench/src/benchmarks/longmemeval/index.ts`                  | Evolution questions loader                                        |
| Create | `packages/memorybench/data/benchmarks/longmemeval/evolution-questions.json` | Evolution question dataset                                        |
| Create | `packages/mama-core/tests/unit/recall-graph-expansion.test.ts`              | Graph expansion recall tests                                      |
| Create | `packages/standalone/tests/api/audit-conversation.test.ts`                  | Audit API tests                                                   |

---

## Validation Plan

### Unit Tests

1. `recallMemory()` + graph expansion — save memories with edges, verify expanded contains related memories on recall
2. `loadEdgesForIds()` — verify supersedes/builds_on edge retrieval accuracy
3. Audit API — conversation → agent execution → edge creation verification

### Benchmark Validation

1. **Same 100 questions re-run** (agent path ingest + graph-aware recall)
   - temporal-reasoning: 65% → target 80%+
   - multi-session: 33% → target 50%+
   - knowledge-update: 88% → maintain or improve
2. **Evolution questions** (new dataset)
   - MAMA: target 80%+ (graph traversal advantage)
   - Comparison providers: expected 30-50% (no edges)

### Fair Comparison

- Remove MAMA-only benchmark cheats (query expansion, semantic rerank)
- Same answering model (GPT-5.3 Codex) for all providers
- Fix Hit@10 measurement bug (match on extracted memory IDs, not session IDs)

---

## Cost / Risk

| Risk                                          | Mitigation                                              |
| --------------------------------------------- | ------------------------------------------------------- |
| Agent path ingest is slow (~1-2s per session) | 100 questions x ~40 sessions avg = ~80 min. Acceptable. |
| Agent SKIPs some sessions (doesn't save)      | Force-inject candidates in benchmark mode               |
| expandWithGraph() returns too many results    | Existing interleaving logic caps by graph_rank          |
| Performance impact on existing recallMemory() | skipGraphExpansion option for opt-out                   |
| Evolution question data quality               | Hand-curated + ground truth verification                |

---

## Expected Outcome

```
Current (v47):
  Overall: 63%
  temporal: 65%, multi-session: 33%
  graph_context.expanded: always []
  edge utilization: 0%

After (projected):
  Overall: 75-80%
  temporal: 80%+ (supersedes chain enables chronological event tracking)
  multi-session: 50%+ (builds_on expands related session retrieval)
  Evolution section: 80%+ (MAMA-exclusive territory)
```

**MAMA's story: "Other memory systems only tell you the latest answer. MAMA remembers why it changed."**
