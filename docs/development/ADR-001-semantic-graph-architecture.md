# ADR-001: Semantic Graph Architecture for Memory Connections

**Status:** Proposed
**Date:** 2025-11-22
**Deciders:** SpineLift Team
**Related:** PRD-hierarchical-tools-v2.md

---

## Context

MAMA v2 introduces a unified `memories` table with multiple types (decision, checkpoint, insight, context). However, the PRD focused on **what to store** (schema) and **how to access** (tools), missing the critical question: **How do memories connect to each other semantically?**

### The Problem

```javascript
// Scenario: Real user workflow
1. save/decision("auth_strategy", "Use JWT", reasoning="Stateless, scalable")
   → memory_1 (type='decision', topic='auth_strategy')

2. [30 mins later]
   save/checkpoint("Implemented JWT auth in auth.ts")
   → memory_2 (type='checkpoint')

3. [next day]
   evolve/outcome(memory_1, 'FAILED', reason="Performance issues with token refresh")
   → memory_1 updated

4. [same day]
   save/decision("auth_strategy", "Switch to session-based", supersedes=memory_1)
   → memory_3 (type='decision', topic='auth_strategy')

// Question: How do we answer this?
search/context("Why did we abandon JWT?")

→ Should return: memory_1 → memory_3 evolution
→ Should include: memory_2 (implementation evidence)
→ Should surface: outcome='FAILED' (the reason)

= Requires: Multi-type semantic graph!
```

### The Gap

Current schema has:
```sql
related_to TEXT  -- JSON array of IDs
```

But no specification for:
1. **When** to create links (automatic vs explicit)
2. **How** to score link strength (confidence)
3. **Which** types can link to which
4. **How** to traverse for queries
5. **Where** embeddings go (unified vs separate spaces)

### Why This Matters

**For Claude:**
- "Why did we decide X?" → Needs decision evolution chain
- "What happened after we tried Y?" → Needs decision → checkpoint → outcome links
- "Similar to what we did before?" → Needs semantic similarity across types

**For MAMA:**
- Intelligence = Graph traversal quality
- Trust = Retrieving complete context, not fragments
- Evolution = Learn-Unlearn-Relearn visible in graph structure

---

## Decision

We will implement a **Hybrid Semantic Graph** with:

1. **Automatic Temporal Links** (low confidence)
2. **Explicit Semantic Links** (high confidence)
3. **Unified Embedding Space** with type-aware scoring
4. **Multi-dimensional Link Weights**

### 1. Link Types & Creation Rules

```typescript
interface MemoryLink {
  from_id: string;
  to_id: string;
  link_type: 'supersedes' | 'implements' | 'outcome_of' | 'relates_to' | 'temporal';
  confidence: number;  // 0.0-1.0
  created_by: 'user' | 'system' | 'llm';
  metadata?: {
    reason?: string;
    similarity?: number;
    time_delta?: number;
  };
}
```

**Automatic Links (created by system):**

```javascript
// Rule 1: Temporal proximity in same session
if (memory_new.created_at - memory_prev.created_at < 1_hour) {
  createLink({
    from: memory_prev.id,
    to: memory_new.id,
    type: 'temporal',
    confidence: 0.3 + (1 - time_delta_normalized) * 0.2,  // 0.3-0.5
    created_by: 'system'
  });
}

// Rule 2: Same topic (for decisions)
if (memory_new.type === 'decision' &&
    memory_new.topic === memory_prev.topic) {
  createLink({
    from: memory_prev.id,
    to: memory_new.id,
    type: 'relates_to',
    confidence: 0.6,  // Same topic = fairly confident
    created_by: 'system',
    metadata: { reason: 'same_topic' }
  });
}

// Rule 3: Semantic similarity (cross-type)
const similarity = cosineSimilarity(
  memory_new.embedding_vector,
  memory_prev.embedding_vector
);

if (similarity > 0.75) {
  createLink({
    from: memory_prev.id,
    to: memory_new.id,
    type: 'relates_to',
    confidence: similarity,
    created_by: 'system',
    metadata: { similarity, reason: 'semantic_match' }
  });
}
```

**Explicit Links (created by user/LLM):**

```javascript
// Rule 4: Tool-specified relationships
save/decision({
  topic: "auth_strategy",
  decision: "Session-based auth",
  supersedes: "memory_1",  // Explicit!
  confidence: 0.9
});
// → Creates link: { type: 'supersedes', confidence: 1.0, created_by: 'llm' }

evolve/outcome({
  memory_id: "memory_1",
  outcome: "FAILED",
  reason: "Performance issues"
});
// → Creates link: { type: 'outcome_of', confidence: 1.0, created_by: 'llm' }

save/checkpoint({
  summary: "Implemented JWT auth",
  implements: ["memory_1"]  // Optional explicit link
});
// → Creates link: { type: 'implements', confidence: 1.0, created_by: 'user' }
```

### 2. Embedding Space Design

**Decision: Unified Vector Space with Type-Aware Scoring**

```javascript
// Single embedding for all types
embedding_vector: Float32Array(384)  // Content-based only

// But scoring considers type compatibility
function semanticScore(mem1, mem2) {
  const baseSimilarity = cosineSimilarity(mem1.embedding, mem2.embedding);

  // Type compatibility matrix
  const typeBoost = {
    'decision->checkpoint': 1.2,   // Decisions often followed by implementation
    'decision->decision': 1.0,     // Neutral
    'checkpoint->checkpoint': 0.8, // Less likely to be related
    'insight->decision': 1.1,      // Insights inform decisions
    'decision->insight': 0.9       // Reverse less strong
  };

  const boost = typeBoost[`${mem1.type}->${mem2.type}`] || 1.0;
  return Math.min(1.0, baseSimilarity * boost);
}
```

**Why not separate spaces?**
- ❌ Cross-type search becomes impossible
- ❌ "What decisions relate to this checkpoint?" = Hard
- ✅ Unified = "Show me everything about auth" = Easy

**Why not multi-vector (content + type)?**
- ❌ Increases storage 2x
- ❌ Complicates similarity calculation
- ❌ Type is already in metadata (redundant)
- ✅ Type-aware scoring achieves same goal simpler

### 3. Graph Traversal Algorithms

**Query Pattern 1: Evolution Chain**
```javascript
// "Why did we decide X?"
function getDecisionEvolution(topic) {
  return traverseGraph({
    start: findLatest({ type: 'decision', topic }),
    direction: 'backward',
    link_types: ['supersedes', 'relates_to'],
    max_depth: 10,
    min_confidence: 0.6
  });
}

// Returns: [latest_decision → prev_decision → original_decision]
```

**Query Pattern 2: Impact Analysis**
```javascript
// "What happened after decision X?"
function getDecisionImpact(decision_id) {
  return traverseGraph({
    start: decision_id,
    direction: 'forward',
    link_types: ['implements', 'outcome_of', 'temporal'],
    max_depth: 5,
    time_window: 7 * 24 * 60 * 60 * 1000  // 1 week
  });
}

// Returns: [decision → checkpoint (implementation) → outcome (result)]
```

**Query Pattern 3: Contextual Search**
```javascript
// "Similar to what we did with auth?"
async function searchByContext(query, contextMemoryId) {
  const contextMemory = await getMemory(contextMemoryId);

  // 1. Get semantic matches
  const similar = await semanticSearch(query, {
    top_k: 20,
    min_similarity: 0.7
  });

  // 2. Boost connected memories
  const connectedIds = await getConnected(contextMemoryId, {
    max_depth: 2,
    min_confidence: 0.5
  });

  // 3. Re-rank
  return similar.map(mem => ({
    ...mem,
    score: mem.similarity * (connectedIds.includes(mem.id) ? 1.5 : 1.0)
  })).sort((a, b) => b.score - a.score);
}
```

### 4. Link Confidence Decay

Links degrade over time (except explicit supersedes):

```javascript
function getLinkConfidence(link, current_time) {
  if (link.link_type === 'supersedes') {
    return link.confidence;  // Never decays
  }

  const age_days = (current_time - link.created_at) / (24 * 60 * 60 * 1000);
  const decay_rate = {
    'temporal': 0.1,    // Decays quickly
    'relates_to': 0.05, // Decays slowly
    'implements': 0.02  // Nearly permanent
  }[link.link_type] || 0.05;

  return link.confidence * Math.exp(-decay_rate * age_days);
}
```

### 5. Storage Schema

```sql
-- Links table (separate from memories)
CREATE TABLE memory_links (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  link_type TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_by TEXT NOT NULL,
  metadata TEXT,  -- JSON
  created_at INTEGER DEFAULT (unixepoch()),

  FOREIGN KEY (from_id) REFERENCES memories(id) ON DELETE CASCADE,
  FOREIGN KEY (to_id) REFERENCES memories(id) ON DELETE CASCADE,

  CHECK (link_type IN ('supersedes', 'implements', 'outcome_of', 'relates_to', 'temporal')),
  CHECK (confidence >= 0.0 AND confidence <= 1.0),
  CHECK (created_by IN ('user', 'system', 'llm'))
);

CREATE INDEX idx_links_from ON memory_links(from_id);
CREATE INDEX idx_links_to ON memory_links(to_id);
CREATE INDEX idx_links_type ON memory_links(link_type);
CREATE INDEX idx_links_confidence ON memory_links(confidence);

-- Update memories table: remove related_to (now in links table)
-- Keep embedding_vector in memories
```

---

## Consequences

### Positive

✅ **Complete Context Recovery**
- "Why X?" queries return full decision evolution
- Implementation evidence (checkpoints) automatically linked
- Failure reasons visible in graph

✅ **Automatic Intelligence**
- System creates temporal links without user input
- Semantic similarity surfaces unexpected connections
- Type-aware scoring improves relevance

✅ **Flexible Traversal**
- Evolution chains (backward)
- Impact analysis (forward)
- Contextual search (graph-aware ranking)

✅ **Trust Building**
- Explicit links (1.0 confidence) vs automatic (0.3-0.8)
- Decay function reflects reality (temporal links age)
- User can verify link reasoning (metadata)

✅ **Extensible**
- New link types easy to add
- New traversal patterns = new queries
- Confidence tuning without schema change

### Negative

❌ **Complexity**
- Link creation logic adds system complexity
- Graph traversal = more compute than flat queries
- Confidence scoring heuristics need tuning

❌ **Storage Overhead**
- Links table grows O(n²) worst case
- Need pruning strategy for low-confidence links
- Indexes required for performance

❌ **Tuning Required**
- Similarity threshold (0.75?) needs experimentation
- Time window for temporal links (1 hour?) arbitrary
- Type boost factors (1.2?) need validation

❌ **Potential Noise**
- Automatic links may create false positives
- Low-confidence links clutter graph
- Need UI to show/hide automatic links

### Risks & Mitigation

**Risk 1: Link Explosion**
- Mitigation: Prune links with confidence < 0.3 weekly
- Mitigation: Limit automatic links to top-5 per memory
- Mitigation: User can disable automatic linking

**Risk 2: Slow Traversal**
- Mitigation: Cache common traversal patterns
- Mitigation: Limit max_depth in queries
- Mitigation: Materialized views for hot paths

**Risk 3: Incorrect Links**
- Mitigation: Show link confidence in UI
- Mitigation: Allow user to delete/downvote links
- Mitigation: A/B test threshold values

---

## Alternatives Considered

### Alternative 1: Explicit Links Only

**Description:** No automatic link creation. User/LLM must specify all relationships.

**Pros:**
- ✅ Simple, predictable
- ✅ High confidence in all links
- ✅ No false positives

**Cons:**
- ❌ Requires user effort
- ❌ Misses obvious temporal connections
- ❌ Claude must remember to link everything

**Decision:** Rejected. Too much cognitive load on user/Claude.

### Alternative 2: Fully Automatic Graph

**Description:** System creates all links based on ML model predictions.

**Pros:**
- ✅ Zero user effort
- ✅ Can learn patterns over time
- ✅ Sophisticated relationship detection

**Cons:**
- ❌ Black box (users can't understand)
- ❌ Requires training data
- ❌ High complexity
- ❌ Unpredictable behavior

**Decision:** Rejected. Too opaque, MAMA values transparency.

### Alternative 3: Separate Embedding Spaces per Type

**Description:** decisions have one vector space, checkpoints another, etc.

**Pros:**
- ✅ No type pollution
- ✅ Cleaner clustering per type
- ✅ Type-specific similarity tuning

**Cons:**
- ❌ Cross-type search impossible
- ❌ 4x storage for embeddings
- ❌ Complex query logic

**Decision:** Rejected. Cross-type search is killer feature.

### Alternative 4: Graph Database (Neo4j, ArangoDB)

**Description:** Use dedicated graph database instead of SQLite.

**Pros:**
- ✅ Optimized for graph queries
- ✅ Rich query language (Cypher)
- ✅ Built-in graph algorithms

**Cons:**
- ❌ Breaks local-first promise (requires server)
- ❌ Complex deployment
- ❌ Overkill for current scale
- ❌ SQLite simplicity lost

**Decision:** Rejected. Local-first is core value. Can migrate later if needed.

---

## Implementation Notes

### Phase 1: Links Table & Basic Creation
```sql
-- Migration 006
CREATE TABLE memory_links (...);
```

```javascript
// In save/decision tool
if (args.supersedes) {
  await createLink({
    from: args.supersedes,
    to: new_memory_id,
    type: 'supersedes',
    confidence: 1.0,
    created_by: 'llm'
  });
}

// Automatic temporal links
await createTemporalLinks(new_memory_id);
```

### Phase 2: Semantic Similarity Links
```javascript
// After embedding generation
const similar = await findSimilar(new_memory.embedding, {
  threshold: 0.75,
  limit: 5
});

for (const mem of similar) {
  await createLink({
    from: mem.id,
    to: new_memory.id,
    type: 'relates_to',
    confidence: mem.similarity,
    created_by: 'system',
    metadata: { similarity: mem.similarity }
  });
}
```

### Phase 3: Graph Traversal API
```javascript
// Add to mama-api.js
async function traverseGraph(start_id, options) {
  // Breadth-first traversal
  // Returns: Array<Memory & { link_type, confidence }>
}

async function getConnected(memory_id, options) {
  // Returns: Array<memory_id>
}
```

### Phase 4: Query Integration
```javascript
// Update search/by_context tool
const results = await traverseGraph(query_embedding, {
  boost_connected: true,
  context_memory_id: last_accessed_memory
});
```

---

## Validation Criteria

This ADR succeeds if:

1. ✅ "Why did we decide X?" queries return complete evolution chain
2. ✅ Automatic links have >80% relevance (user survey)
3. ✅ Graph traversal adds <100ms latency
4. ✅ Link storage <20% of total DB size
5. ✅ Users understand link confidence UI

This ADR fails if:

1. ❌ False positive links >30% (noise)
2. ❌ Graph queries timeout (>5s)
3. ❌ Users confused by automatic links
4. ❌ Link explosion (>1M links for 10K memories)

---

## References

- PRD: `docs/development/PRD-hierarchical-tools-v2.md`
- Schema: Migration 001 (decisions), Migration 005 (memories)
- Research: [Neo4j Graph Algorithms](https://neo4j.com/docs/graph-data-science/)
- Research: [Temporal Knowledge Graphs](https://arxiv.org/abs/2004.04382)
- Decision: `mama_v2_hierarchical_architecture`

---

## Changelog

- **2025-11-22:** Initial draft (Proposed)
