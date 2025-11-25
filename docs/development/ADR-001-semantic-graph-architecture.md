# ADR-001: Semantic Graph Architecture for Memory Connections

**Status:** Proposed
**Date:** 2025-11-22
**Deciders:** SpineLift Team
**Related Documents:**

- [PRD: MAMA v1.1 - Hierarchical Tools & Unified Schema](./PRD-hierarchical-tools-v1.1.md) - Product requirements and vision
- ~~decision-evolution-philosophy.md~~ (merged into PRD)

---

## Context

### Purpose of This ADR

This ADR answers the **HOW** question: How do we implement decision evolution tracking?

For the **WHY** (vision, goals, user stories), see [PRD Section 1: Vision](./PRD-hierarchical-tools-v1.1.md#1-vision-decision-evolution-not-just-recall).

### The Technical Challenge

MAMA v1.1 introduces a unified `memories` table with multiple types (decision, checkpoint, insight, context). The PRD defined **what to store** (schema) and **how to access** (tools), but the critical question remains:

**How do memories connect to form evolution chains that enable learning?**

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

### 1. Two-Layer Link Architecture

```typescript
interface MemoryLink {
  // Layer 2: Storage (4 core types for efficient queries)
  from_id: string;
  to_id: string;
  link_type: 'evolution' | 'implementation' | 'association' | 'temporal';
  confidence: number; // 0.0-1.0
  created_by: 'user' | 'system' | 'llm';

  // Layer 1: Expression (unlimited, preserved in metadata)
  metadata: {
    original_relationship: string; // e.g., 'supersedes', 'motivated_by'
    relationship_tags?: string[]; // e.g., ['supersedes', 'performance']
    reason?: string; // Why this link exists
    similarity?: number; // For semantic links
    time_delta?: number; // For temporal links
    inference_confidence?: number; // How confident is the core type mapping?
    custom_data?: Record<string, any>; // User-provided metadata
  };
}

// Mapping: Expression → Storage
const relationshipToCore = {
  // Evolution family → 'evolution'
  supersedes: 'evolution',
  refines: 'evolution',
  improves: 'evolution',

  // Implementation family → 'implementation'
  implements: 'implementation',
  outcome_of: 'implementation',
  executes: 'implementation',

  // Association family → 'association'
  relates_to: 'association',
  motivated_by: 'association',
  inspired_by: 'association',
  challenges: 'association',
  depends_on: 'association',

  // Temporal (1:1 mapping)
  temporal: 'temporal',
};
```

**Automatic Links (created by system):**

> **⚠️ Design Note:** Initial rules (v0) created 85% noise (see Consequences section). These improved rules target 60%+ signal ratio based on simulation results.

```javascript
// Rule 1: Temporal proximity (strict: same topic + short window)
const time_delta = memory_new.created_at - memory_prev.created_at;
const FIFTEEN_MINUTES = 15 * 60 * 1000;

if (time_delta < FIFTEEN_MINUTES && memory_new.topic === memory_prev.topic) {
  // Same topic REQUIRED
  createLink({
    from_id: memory_prev.id,
    to_id: memory_new.id,
    link_type: 'temporal',
    confidence: 0.4 + (1 - time_delta / FIFTEEN_MINUTES) * 0.3, // 0.4-0.7
    created_by: 'system',
    metadata: {
      original_relationship: 'temporal',
      time_delta: time_delta,
      reason: 'same_context',
    },
  });
}

// Rule 2: Same topic (with recency decay)
const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;
const age = memory_new.created_at - memory_prev.created_at;

if (memory_new.type === 'decision' && memory_new.topic === memory_prev.topic && age < ONE_WEEK) {
  // Recency limit
  const recency_factor = 1 - age / ONE_WEEK; // 1.0 → 0.0

  createLink({
    from_id: memory_prev.id,
    to_id: memory_new.id,
    link_type: 'association',
    confidence: 0.4 + recency_factor * 0.3, // 0.4-0.7 (recent = higher)
    created_by: 'system',
    metadata: {
      original_relationship: 'relates_to',
      relationship_tags: ['same_topic'],
      reason: 'same_topic',
      age_days: Math.floor(age / (24 * 60 * 60 * 1000)),
    },
  });
}

// Rule 3: Semantic similarity (strict threshold + Top-K limit)
const candidates = await findSimilar(memory_new.embedding_vector, {
  threshold: 0.85, // Raised from 0.75 (reduces false positives)
  limit: 5, // Top-5 only (prevents link explosion)
  exclude_same_topic: true, // Already covered by Rule 2
});

for (const candidate of candidates) {
  createLink({
    from_id: candidate.id,
    to_id: memory_new.id,
    link_type: 'association',
    confidence: candidate.similarity, // 0.85-1.0
    created_by: 'system',
    metadata: {
      original_relationship: 'relates_to',
      relationship_tags: ['semantic_similarity'],
      similarity: candidate.similarity,
      reason: 'semantic_match',
    },
  });
}
```

**Rule Changes Rationale:**

- **Rule 1**: Temporal now requires same topic (prevents "React ↔ JWT" noise) + 15min window (real context)
- **Rule 2**: Added 1-week recency limit (old decisions less relevant) + confidence decay
- **Rule 3**: Threshold 0.75→0.85 (fewer false positives) + Top-5 limit (prevents explosion)

**Explicit Links (created by user/LLM):**

```javascript
// Rule 4: Tool-specified relationships → Core type mapping
save /
  decision({
    topic: 'auth_strategy',
    decision: 'Session-based auth',
    supersedes: 'memory_1', // Explicit parameter
    confidence: 0.9,
  });
// → Creates link: {
//     link_type: 'evolution',  // Core type
//     metadata: { original_relationship: 'supersedes' }
//   }

evolve /
  outcome({
    memory_id: 'memory_1',
    outcome: 'FAILED',
    reason: 'Performance issues',
  });
// → Creates link: {
//     link_type: 'implementation',  // Core type
//     metadata: { original_relationship: 'outcome_of', outcome: 'FAILED' }
//   }

save /
  checkpoint({
    summary: 'Implemented JWT auth',
    implements: ['memory_1'], // Optional explicit link
  });
// → Creates link: {
//     link_type: 'implementation',  // Core type
//     metadata: { original_relationship: 'implements' }
//   }
```

### 2. Embedding Space Design

**Decision: Unified Vector Space with Type-Aware Scoring**

```javascript
// Single embedding for all types
embedding_vector: Float32Array(384); // Content-based only

// But scoring considers type compatibility
function semanticScore(mem1, mem2) {
  const baseSimilarity = cosineSimilarity(mem1.embedding, mem2.embedding);

  // Type compatibility matrix
  const typeBoost = {
    'decision->checkpoint': 1.2, // Decisions often followed by implementation
    'decision->decision': 1.0, // Neutral
    'checkpoint->checkpoint': 0.8, // Less likely to be related
    'insight->decision': 1.1, // Insights inform decisions
    'decision->insight': 0.9, // Reverse less strong
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
    link_types: ['evolution', 'association'], // Core types (not 'supersedes')
    max_depth: 10,
    min_confidence: 0.6,
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
    link_types: ['implementation', 'temporal'], // Core types (not 'implements'/'outcome_of')
    max_depth: 5,
    time_window: 7 * 24 * 60 * 60 * 1000, // 1 week
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
    min_similarity: 0.7,
  });

  // 2. Boost connected memories
  const connectedIds = await getConnected(contextMemoryId, {
    max_depth: 2,
    min_confidence: 0.5,
  });

  // 3. Re-rank
  return similar
    .map((mem) => ({
      ...mem,
      score: mem.similarity * (connectedIds.includes(mem.id) ? 1.5 : 1.0),
    }))
    .sort((a, b) => b.score - a.score);
}
```

### 4. Link Confidence Decay

Links degrade over time (except evolution links):

```javascript
function getLinkConfidence(link, current_time) {
  // Evolution links (supersedes, refines, etc.) never decay
  if (link.link_type === 'evolution') {
    return link.confidence; // Permanent decision history
  }

  const age_days = (current_time - link.created_at) / (24 * 60 * 60 * 1000);
  const decay_rate =
    {
      temporal: 0.1, // Decays quickly (contextual, session-based)
      association: 0.05, // Decays slowly (semantic connections)
      implementation: 0.02, // Nearly permanent (action evidence)
    }[link.link_type] || 0.05;

  return link.confidence * Math.exp(-decay_rate * age_days);
}

// Future enhancement: Fine-grained decay by original_relationship
// Example: 'supersedes' never decays, 'refines' decays slower than 'relates_to'
// Implementation:
// const specificDecay = metadata.original_relationship === 'supersedes' ? 0 :
//                       metadata.original_relationship === 'refines' ? 0.01 : decay_rate;
```

**Note:** Current implementation uses `link_type` (4 core categories) for decay rates. Future versions may add fine-grained policies based on `metadata.original_relationship` for more nuanced aging behavior. See [PRD Future Enhancements](./PRD-hierarchical-tools-v1.1.md#11-future-enhancements-out-of-scope).

### 5. Storage Schema

```sql
-- Links table (separate from memories)
CREATE TABLE memory_links (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  link_type TEXT NOT NULL,        -- 4 core types only
  confidence REAL NOT NULL,
  created_by TEXT NOT NULL,
  metadata TEXT,                  -- JSON: {
                                  --   original_relationship: string,
                                  --   relationship_tags: string[],
                                  --   reason: string,
                                  --   similarity?: number,
                                  --   time_delta?: number,
                                  --   inference_confidence?: number
                                  -- }
  created_at INTEGER DEFAULT (unixepoch()),

  FOREIGN KEY (from_id) REFERENCES memories(id) ON DELETE CASCADE,
  FOREIGN KEY (to_id) REFERENCES memories(id) ON DELETE CASCADE,

  -- Core types (4 only, enables efficient queries)
  CHECK (link_type IN ('evolution', 'implementation', 'association', 'temporal')),
  CHECK (confidence >= 0.0 AND confidence <= 1.0),
  CHECK (created_by IN ('user', 'system', 'llm'))
);

CREATE INDEX idx_links_from ON memory_links(from_id);
CREATE INDEX idx_links_to ON memory_links(to_id);
CREATE INDEX idx_links_type ON memory_links(link_type);
CREATE INDEX idx_links_confidence ON memory_links(confidence);

-- JSON metadata indexes for common queries
CREATE INDEX idx_links_metadata_relationship
  ON memory_links(json_extract(metadata, '$.original_relationship'));

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

- **CRITICAL**: Initial rules (v0) created 85% noise in simulation
- Improved rules (v1): Threshold 0.75→0.85, time window 1h→15min, Top-K limit
- Type boost factors (1.2?) need validation

❌ **Potential Noise (Validated by Simulation)**

**Simulation Results (1000 memories, v0 rules):**

- Signal Ratio: **15.1%** (85% noise!)
- Context Window Pollution: **69.8%** (37/53 irrelevant)
- Total Links: 1,085 (164 useful, 921 noise)
- Graph Traversal: 614 nodes visited (307ms latency)

**Worst Examples:**

- Query: "JWT problems?" → 56.3% noise (9/16 unrelated topics)
- Same topic (12 decisions) → 132 links (most time-distant, low value)
- Semantic: "frontend_framework" ↔ "auth_strategy" = similarity 1.00 (false positive)

**Root Causes:**

1. Threshold too low (0.75): Structural similarity ≠ semantic relevance
2. Time window too wide (1 hour): Different topics in same session linked
3. No recency filter: 6-month-old decisions equally weighted

**Mitigations Applied (v1 rules):**

- Threshold: 0.75→0.85 + Top-5 limit (prevents explosion)
- Temporal: Same topic required + 15min window (real context only)
- Same topic: 1-week recency limit + confidence decay
- **Expected improvement: 15% → 60%+ signal ratio**

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
    from_id: args.supersedes,
    to_id: new_memory_id,
    link_type: 'evolution', // Core type (NOT 'supersedes')
    confidence: 1.0,
    created_by: 'llm',
    metadata: {
      original_relationship: 'supersedes', // Preserve user expression
    },
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
  limit: 5,
});

for (const mem of similar) {
  await createLink({
    from_id: mem.id,
    to_id: new_memory.id,
    link_type: 'association', // Core type (NOT 'relates_to')
    confidence: mem.similarity,
    created_by: 'system',
    metadata: {
      original_relationship: 'relates_to',
      similarity: mem.similarity,
      reason: 'semantic_match',
    },
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
  context_memory_id: last_accessed_memory,
});
```

---

## 6. Link Type Decision Logic

### Who Decides Link Types?

**Critical Clarification:** Link types are NOT decided by analyzing text - they're determined by **which tool is called** and **what parameters are provided**.

```javascript
// Flow:
User: "JWT 대신 세션 쓰자"
  ↓
Claude (LLM): "This supersedes previous auth decision"  ← CLAUDE does reasoning
  ↓
Claude calls: save/decision({ supersedes: "decision_jwt_123" })  ← Parameter
  ↓
Tool: if (args.supersedes) → link_type = 'evolution'  ← Rule-based mapping
```

### Role Breakdown

| Actor                     | Responsibility                    | Reasoning?                      |
| ------------------------- | --------------------------------- | ------------------------------- |
| **Claude (Remote LLM)**   | Tool selection, parameter filling | ✅ Yes (interprets user intent) |
| **MCP Tool (JavaScript)** | Parameter → link_type mapping     | ❌ No (rule-based)              |
| **Pattern matching**      | Regex on reasoning text           | ❌ No (pattern recognition)     |
| **Local LLM**             | Deep reasoning analysis           | ✅ Yes (future feature)         |

### Tool → Link Type Mapping

```javascript
// Explicit mappings (hardcoded in tools)
const toolLinkTypeMap = {
  // save/decision with parameters
  supersedes: 'evolution',
  refines: 'evolution',
  improves: 'evolution',

  // evolve/outcome
  outcome_of: 'implementation',

  // save/checkpoint with implements
  implements: 'implementation',

  // Automatic (system-created)
  temporal: 'temporal', // Time proximity
  semantic: 'association', // Embedding similarity
};
```

### Future: Optional Pattern Matching

```javascript
// Phase 2: Lightweight text analysis (no LLM)
if (!args.supersedes && args.reasoning) {
  const patterns = {
    supersedes: /replaces|instead of|switching from/i,
    improves: /improves|enhances|better than/i,
    fixes: /fixes|resolves|addresses/i,
  };

  for (const [rel, pattern] of Object.entries(patterns)) {
    if (pattern.test(args.reasoning)) {
      createLink({
        link_type: inferCoreType(rel),
        confidence: 0.7, // Lower than explicit
      });
    }
  }
}
```

---

## 7. Creative Parameter Support

### Problem: Fixed Parameters Limit Thinking

Tool schemas traditionally restrict what Claude can express:

```javascript
// Restrictive schema
inputSchema: {
  properties: { supersedes: string },
  additionalProperties: false  // ← Claude can't express new relationships!
}
```

This violates our philosophy: **"Tools should not define boundaries of thought"**.

### Solution: Flexible Links Array

```javascript
// Tool definition
inputSchema: {
  properties: {
    topic: { type: 'string' },
    decision: { type: 'string' },

    // Flexible relationship expression
    links: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          to_id: { type: 'string' },
          relationship: { type: 'string' },  // ← Unlimited!
          tags: { type: 'array', items: { type: 'string' } }
        }
      }
    }
  }
}

// Claude uses creatively:
save/decision({
  topic: "architecture",
  decision: "Event sourcing",
  links: [
    { to_id: "decision_kafka", relationship: "depends_on" },
    { to_id: "analysis_123", relationship: "inspired_by" },
    { to_id: "decision_microservices", relationship: "challenges" }
  ]
})
```

### Relationship Processing

```javascript
// Tool handler
for (const link of args.links) {
  // 1. Infer core type from relationship name (semantically)
  const coreType = await inferCoreType(link.relationship);

  // 2. Create flexible link with two-layer architecture
  await createLink({
    from_id: newMemoryId,
    to_id: link.to_id,
    link_type: coreType, // Core category (4 types for efficient queries)
    confidence: 0.8, // Explicit but creative
    created_by: 'llm',
    metadata: {
      original_relationship: link.relationship, // Preserve user expression
      relationship_tags: [
        link.relationship, // Original creative name
        ...(link.tags || []), // Additional user tags
      ],
      inference_confidence: 0.87, // How confident is the categorization?
      custom_data: link.metadata, // Any additional context
    },
  });
}
```

### Learning Mechanism

```javascript
// Track new relationships
class RelationshipLearning {
  async trackUsage(relationship, context) {
    await db.upsert('relationship_intelligence', {
      relationship,
      usage_count: db.raw('usage_count + 1'),
      last_used: Date.now(),
      contexts: db.raw(`json_insert(contexts, '$', ?)`, [context]),
    });
  }

  async promoteToOfficial(threshold = 50) {
    const candidates = await db.query(
      `
      SELECT relationship, usage_count, avg_confidence
      FROM relationship_intelligence
      WHERE usage_count > ? AND avg_confidence > 0.75
    `,
      [threshold]
    );

    // These become official parameters in next version!
    return candidates;
  }
}
```

### Schema Evolution Example

```javascript
// v1.1: "inspired_by" is creative
links: [{ relationship: "inspired_by", ... }]

// [50 uses later...]

// v1.2: "inspired_by" becomes official parameter!
save/decision({
  inspired_by: "analysis_123",  // ← Now a first-class parameter
  // But links[] still available for new creative ones
})
```

---

## 8. Relationship Intelligence

> **IMPORTANT:** This section is split into v1.1 (simple, proven) and v1.2+ (advanced, experimental) features based on implementation complexity and initial data requirements.

### 8.1 v1.1 Implementation (Included in Initial Release)

#### Semantic Embedding for Automatic Understanding

**Key Insight:** We don't need to hardcode relationship synonyms - Transformers.js **automatically understands semantic similarity**!

```javascript
// NO hardcoding needed!
const embed1 = await embed("inspired by");
const embed2 = await embed("motivated by");
const embed3 = await embed("challenges");

cosine_similarity(embed1, embed2) = 0.87  // Synonyms detected!
cosine_similarity(embed1, embed3) = 0.23  // Different meaning
```

**Why v1.1:** Simple cosine similarity - no complex dependencies, works from day 1.

#### Manual Synonym Detection

```javascript
async function findSynonyms(relationship, threshold = 0.75) {
  // 1. Embed the query
  const queryEmbed = await embed(relationship);

  // 2. Get all existing relationships
  const existing = await db.query(`
    SELECT DISTINCT relationship_tags
    FROM memory_links
  `);

  // 3. Find similar ones (semantic similarity!)
  const synonyms = [];
  for (const rel of existing) {
    const relEmbed = await embed(rel);
    const similarity = cosineSimilarity(queryEmbed, relEmbed);

    if (similarity > threshold) {
      synonyms.push({ relationship: rel, similarity });
    }
  }

  return synonyms.sort((a, b) => b.similarity - a.similarity);
}

// Example:
await findSynonyms('motivated by');
// → [
//   { relationship: "inspired by", similarity: 0.87 },
//   { relationship: "influenced by", similarity: 0.84 },
//   { relationship: "based on", similarity: 0.78 }
// ]
```

**Why v1.1:** Linear scan is O(n) where n = unique relationships (~50-100). Acceptable performance.

#### Multilingual Support (Built-in!)

```javascript
// Works with Korean + English mixed - NO extra configuration!
await findSynonyms('영감을 받은'); // Korean: "inspired by"
// → [
//   { relationship: "inspired by", similarity: 0.89 },  // English!
//   { relationship: "motivated by", similarity: 0.82 },
//   { relationship: "동기부여된", similarity: 0.86 }      // Korean!
// ]

// Transformers.js embedding model handles multilingual automatically
```

**Why v1.1:** Xenova/all-MiniLM-L6-v2 has built-in multilingual support - zero configuration needed.

#### v1.1 Scope Summary

**Included:**

- ✅ Cosine similarity-based synonym detection
- ✅ Multilingual relationship matching (Korean + English)
- ✅ Manual link creation via `links[]` parameter
- ✅ Simple threshold-based filtering (0.75 similarity)

**Performance:**

- O(n) linear scan for synonym detection
- n ≈ 50-100 unique relationships in typical usage
- <50ms latency for synonym queries

**Rationale:**
Simple, proven techniques that work from day 1 with minimal data. No complex dependencies or clustering algorithms.

---

### 8.2 Future Enhancements (v1.2+)

> **Note:** These features require larger datasets (50+ relationships) and add significant implementation complexity. Deferred to post-v1.1 based on actual usage patterns.

#### Automatic Clustering (DBSCAN)

**Why deferred:** Requires minimum 50+ relationships to be useful. Early adopters won't benefit.

```javascript
// Zero hardcoding - system learns relationship clusters!
async function autoClusterRelationships() {
  const allRels = await getAllRelationships();
  const embeddings = await Promise.all(allRels.map((r) => embed(r.relationship)));

  // DBSCAN clustering (density-based)
  const clusters = await dbscan(embeddings, {
    epsilon: 0.25, // Max distance within cluster
    minPoints: 2,
  });

  // System automatically discovers:
  return [
    {
      canonical: 'inspired by',
      members: ['inspired by', 'motivated by', 'influenced by', 'based on', '영감을 받은'],
      avgSimilarity: 0.82,
    },
    {
      canonical: 'challenges',
      members: ['challenges', 'contradicts', 'opposes', 'questions', '반박한다'],
      avgSimilarity: 0.87,
    },
  ];
}
```

**Implementation Complexity:**

- Requires DBSCAN library (ml-dbscan or custom)
- Cluster maintenance logic
- Canonical relationship selection algorithm
- Cluster merging/splitting over time

**When to implement:** After v1.1 has 100+ users with diverse relationship data.

#### Directional Analysis

**Why deferred:** Requires pattern database and inference logic - adds complexity without clear v1.1 use case.

```javascript
// Infer relationship direction from semantics
const directionalityPatterns = {
  forward: ['supersedes', 'implements', 'challenges', 'improves'],
  backward: ['inspired_by', 'based_on', 'motivated_by'],
  bidirectional: ['relates_to', 'similar_to'],
};

async function inferDirectionality(relationship) {
  const embed = await embeddings.generate(relationship);

  const scores = {
    forward: await semanticSimilarity(embed, directionalityPatterns.forward),
    backward: await semanticSimilarity(embed, directionalityPatterns.backward),
    bidirectional: await semanticSimilarity(embed, directionalityPatterns.bidirectional),
  };

  return Object.keys(scores).reduce((a, b) => (scores[a] > scores[b] ? a : b));
}

// Example:
await inferDirectionality('derived_from');
// → 'backward' (similar to 'inspired_by', 'based_on')
```

**Implementation Complexity:**

- Pattern database maintenance
- Directionality inference logic
- Bidirectional link handling

**When to implement:** v1.2+ if usage patterns show need for automatic direction inference.

#### Context-Aware Scoring

**Why deferred:** Requires extensive usage data (outcomes, frequency, centrality) - not available in v1.1.

```javascript
async function scoreRelationship(link, context) {
  let score = link.confidence; // Base

  // 1. Frequency boost (popular relationships)
  const usage = await getRelationshipUsage(link.relationship_tags[0]);
  score *= 1 + Math.log(usage.count) / 10;

  // 2. Outcome correlation
  const outcomeScore = await getOutcomeCorrelation(link.relationship_tags[0]);
  score *= outcomeScore; // Boost if leads to success

  // 3. Graph centrality
  const centrality = await getNodeCentrality(link.to_id);
  score *= 1 + centrality / 100;

  // 4. Time decay (temporal links only)
  if (link.link_type === 'temporal') {
    const age = Date.now() - link.created_at;
    score *= Math.exp(-age / (7 * 24 * 60 * 60 * 1000)); // 1 week half-life
  }

  // 5. Context relevance
  if (context?.topic && link.metadata?.topic === context.topic) {
    score *= 1.5;
  }

  return Math.min(1.0, score);
}
```

---

## 9. Fragmentation Prevention

### Problem: Orphaned Memories & Disconnected Clusters

```javascript
// Scenario: Synonym fragmentation
Decision1 → "inspired_by" → A
Decision2 → "motivated_by" → B  // Isolated!
Decision3 → "based_on" → C      // Isolated!

// Query "inspired_by" → Only finds Decision1 ❌
```

### Multi-Layer Defense System

#### Defense 1: Normalization at Creation

```javascript
async function normalizeRelationship(rawRelationship) {
  // 1. Clean
  let normalized = rawRelationship.toLowerCase().trim().replace(/[_-]/g, ' ');

  // 2. Find semantically similar existing relationships
  const existing = await getAllRelationships();
  const embedNew = await embed(normalized);

  const similarities = await Promise.all(
    existing.map(async (rel) => ({
      relationship: rel,
      similarity: cosineSimilarity(embedNew, await embed(rel)),
    }))
  );

  const topMatch = similarities.sort((a, b) => b.similarity - a.similarity)[0];

  // 3. High similarity → suggest canonical
  if (topMatch.similarity > 0.85) {
    return {
      canonical: topMatch.relationship,
      original: rawRelationship,
      confidence: topMatch.similarity,
      suggested: true, // Claude can override
    };
  }

  // 4. New relationship
  return {
    canonical: normalized,
    original: rawRelationship,
    confidence: 0.5,
    isNew: true,
  };
}
```

#### Defense 2: Fuzzy Query Expansion

```javascript
async function searchByRelationship(relationship) {
  // 1. Exact match
  const exact = await db.query(
    `
    SELECT * FROM memory_links
    WHERE relationship_tags LIKE ?
  `,
    [`%${relationship}%`]
  );

  // 2. Semantic expansion (automatic!)
  const synonyms = await findSynonyms(relationship, 0.8);

  // 3. Expanded query
  const expanded = await db.query(`
    SELECT * FROM memory_links
    WHERE ${synonyms.map((s) => `relationship_tags LIKE '%${s.relationship}%'`).join(' OR ')}
  `);

  return [...new Set([...exact, ...expanded])];
}
```

#### Defense 3: Periodic Clustering

```javascript
// Weekly: Group similar relationships
async function clusterRelationships() {
  const all = await getAllRelationships();
  const embeddings = await Promise.all(all.map((r) => embed(r)));

  const clusters = kMeans(embeddings, { k: 20 });

  // Update canonical forms
  for (const cluster of clusters) {
    const canonical = findMostFrequent(cluster.members);

    for (const member of cluster.members) {
      await db.update('relationship_intelligence', {
        relationship: member,
        canonical_form: canonical,
        cluster_id: cluster.id,
      });
    }
  }

  return clusters;
}
```

#### Defense 4: Confidence Decay for Orphans

```javascript
async function decayOrphanedRelationships() {
  const stats = await db.query(`
    SELECT relationship_tags, COUNT(*) as usage, MAX(created_at) as last_used
    FROM memory_links
    GROUP BY relationship_tags
  `);

  for (const stat of stats) {
    const age_days = (Date.now() - stat.last_used) / (24 * 60 * 60 * 1000);
    const orphan_penalty = stat.usage < 3 ? 2.0 : 1.0;

    const new_confidence = stat.avg_confidence * Math.exp(-0.05 * age_days * orphan_penalty);

    if (new_confidence < 0.2) {
      await archiveRelationship(stat.relationship_tags);
    }
  }
}
```

#### Defense 5: Graph Health Monitoring

```javascript
async function detectIsolation() {
  const graph = await buildGraph();

  const components = findConnectedComponents(graph);
  const isolated = graph.nodes.filter((n) => n.degree === 1);
  const uniqueRels = await db.query(`
    SELECT relationship_tags, COUNT(*) as usage
    FROM memory_links
    GROUP BY relationship_tags
    HAVING usage = 1
  `);

  return {
    components: components.length, // Should be 1
    isolatedNodes: isolated.length,
    uniqueRelationships: uniqueRels.length,
    health: 1 - isolated.length / graph.nodes.length,
  };
}
```

#### Defense 6: Canonical Promotion

```javascript
async function promoteToCanonical() {
  const candidates = await db.query(`
    SELECT relationship_tags, COUNT(*) as usage, AVG(confidence) as avg_conf
    FROM memory_links
    WHERE created_at > ?  -- Last 30 days
    GROUP BY relationship_tags
    HAVING usage > 10 AND avg_conf > 0.75
  `);

  // These become official in next version
  for (const candidate of candidates) {
    await addToOfficialSchema(candidate.relationship_tags);
  }
}
```

### Health Metrics

```javascript
// Dashboard
{
  connectivity: 0.92,           // 92% of nodes connected
  relationshipDiversity: 47,    // 47 unique relationships
  canonicalCoverage: 0.85,      // 85% use canonical forms
  orphanedNodes: 23,
  fragmentedClusters: 2,

  recommendations: [
    "Merge 'motivated_by' into 'inspired_by' (12 occurrences)",
    "Archive 'refines_auth_jwt_token' (1 occurrence, 90 days old)"
  ]
}
```

---

## 10. Performance Considerations

### Graph Traversal Optimization

**Challenge:** As memory graph grows (1K+ nodes, 5K+ links), naive traversal becomes expensive.

**Strategy:**

#### 1. Hard Depth Limits

```javascript
const MAX_DEPTH = 5; // Global hard cap

const DEPTH_BY_QUERY = {
  'search/by_topic': 3, // Evolution chains are typically 2-3 deep
  'search/by_context': 5, // Semantic exploration needs more breadth
  'load/context': 2, // Immediate context only
};

async function traverseGraph(start_id, query_type, options = {}) {
  const maxDepth = Math.min(
    options.max_depth || DEPTH_BY_QUERY[query_type],
    MAX_DEPTH // Never exceed global cap
  );

  return breadthFirstSearch(start_id, { max_depth: maxDepth });
}
```

**Rationale:**

- 95% of useful relationships are within 3 hops
- Depth 5 covers semantic exploration without runaway traversal
- Per-query limits optimize for specific use cases

#### 2. LRU Cache with Invalidation

```javascript
import LRUCache from 'lru-cache';

const traversalCache = new LRUCache({
  max: 100, // 100 cached paths
  ttl: 5 * 60 * 1000, // 5 minutes TTL
  updateAgeOnGet: true, // Refresh on access
});

async function cachedTraversal(start_id, link_types, max_depth) {
  const cacheKey = `${start_id}:${link_types.sort().join(',')}:${max_depth}`;

  // Check cache
  if (traversalCache.has(cacheKey)) {
    return traversalCache.get(cacheKey);
  }

  // Compute
  const results = await breadthFirstSearch(start_id, { link_types, max_depth });

  // Store
  traversalCache.set(cacheKey, results);
  return results;
}

// Invalidate on link creation
async function createLink(from_id, to_id, link_type) {
  await db.insert('memory_links', { from_id, to_id, link_type });

  // Invalidate affected cache entries
  for (const [key, _] of traversalCache.entries()) {
    if (key.startsWith(`${from_id}:`) || key.includes(`:${to_id}:`)) {
      traversalCache.delete(key);
    }
  }
}
```

**Cache Strategy:**

- **Size**: 100 entries covers typical session (10-20 queries × 3-5 variations)
- **TTL**: 5 minutes balances freshness vs hit rate
- **Invalidation**: Targeted invalidation on link creation (conservative)
- **LRU**: Automatically evicts least-used paths

**Expected Performance:**

- Cold query: 50-100ms (breadth-first search)
- Cached query: <5ms (hash lookup)
- Cache hit rate: 60-80% for repeated searches

#### 3. Query Optimization

```javascript
// BEFORE: N+1 query problem
for (const link of links) {
  const targetMemory = await db.get('memories', link.to_id);
  // ... process
}

// AFTER: Batch fetch
const targetIds = links.map((l) => l.to_id);
const memories = await db.query(
  `
  SELECT * FROM memories
  WHERE id IN (${targetIds.map(() => '?').join(',')})
`,
  targetIds
);

const memoryMap = Object.fromEntries(memories.map((m) => [m.id, m]));
for (const link of links) {
  const targetMemory = memoryMap[link.to_id];
  // ... process
}
```

**Optimizations:**

- Batch fetches reduce round trips
- Index on `memory_links(from_id, link_type)` for fast edge lookup
- Pre-join common queries (memory + links)

#### 4. Performance Budget

| Operation                    | v1.1 Target | Acceptable | Notes                       |
| ---------------------------- | ----------- | ---------- | --------------------------- |
| Shallow traversal (depth=2)  | <30ms       | <50ms      | Immediate context           |
| Medium traversal (depth=3-4) | <50ms       | <100ms     | Evolution chains            |
| Deep traversal (depth=5)     | <100ms      | <200ms     | Semantic exploration        |
| Synonym detection (n=50)     | <50ms       | <100ms     | Linear scan                 |
| Link creation                | <20ms       | <50ms      | Insert + cache invalidation |

**Monitoring:**

```javascript
async function traverseWithMetrics(start_id, options) {
  const startTime = Date.now();

  const results = await cachedTraversal(start_id, options.link_types, options.max_depth);

  const latency = Date.now() - startTime;
  if (latency > 100) {
    console.warn(
      `Slow traversal: ${latency}ms for depth=${options.max_depth}, nodes=${results.length}`
    );
  }

  return results;
}
```

**Fallback:**
If performance degrades:

1. Reduce `MAX_DEPTH` to 3
2. Increase cache size to 200
3. Add materialized views for common paths
4. Consider read-through cache with Redis (external dependency)

### Embedding Performance

**Challenge:** Embedding generation is CPU-intensive (30-50ms per text).

**Strategy:**

#### 1. Batch Embeddings

```javascript
// Generate multiple embeddings in parallel
async function batchEmbed(texts) {
  const embeddings = await Promise.all(texts.map((text) => embeddings.generate(text)));
  return embeddings;
}

// Example: Synonym detection
const allRelationships = await db.query('SELECT DISTINCT relationship_tags FROM memory_links');
const allEmbeddings = await batchEmbed(allRelationships); // Parallel generation
```

#### 2. Embedding Cache

```javascript
const embeddingCache = new Map();

async function cachedEmbed(text) {
  if (embeddingCache.has(text)) {
    return embeddingCache.get(text);
  }

  const embedding = await embeddings.generate(text);
  embeddingCache.set(text, embedding);
  return embedding;
}
```

**Expected Performance:**

- Embedding generation: 30-50ms per text
- Cached embedding: <1ms
- Batch embedding (10 texts): ~80ms (parallelized)

---

## Validation Criteria

> **Note:** For business success metrics (tool selection time, user feedback), see [PRD Section 8: Success Metrics](./PRD-hierarchical-tools-v1.1.md#8-success-metrics). This section covers technical validation.

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

- PRD: `docs/development/PRD-hierarchical-tools-v1.1.md`
- Schema: Migration 001 (decisions), Migration 005 (memories)
- Research: [Neo4j Graph Algorithms](https://neo4j.com/docs/graph-data-science/)
- Research: [Temporal Knowledge Graphs](https://arxiv.org/abs/2004.04382)
- Decision: `mama_v1.1_hierarchical_architecture`

---

## Changelog

- **2025-11-22:** Initial draft (Proposed)
