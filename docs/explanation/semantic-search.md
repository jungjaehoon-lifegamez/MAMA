# Semantic Search - How It Works

**FR Reference:** [FR8-12 (Semantic Search)](../reference/fr-mapping.md)

This document explains how MAMA's semantic search works under the hood, including embeddings, similarity scoring, and ranking algorithms.

---

## Overview

MAMA uses **vector embeddings** to understand the meaning of your decisions and queries, not just exact keyword matches.

**Example:**

```
Query: "How should I handle authentication?"

Exact match would only find:
- ❌ Topics with word "authentication"

Semantic search finds:
- ✅ auth_strategy (90% match)
- ✅ jwt_implementation (78% match)
- ✅ session_management (75% match)
- ✅ oauth_integration (65% match)
```

---

## How Embeddings Work

### What is an Embedding?

An **embedding** is a vector (array of numbers) that represents the semantic meaning of text.

**Example:**

```
Text: "JWT authentication with refresh tokens"
Embedding: [0.23, -0.45, 0.78, ..., 0.12]  (384 dimensions)
```

**Similar concepts have similar vectors:**

```
"JWT authentication" → [0.23, -0.45, 0.78, ...]
"Token-based auth"   → [0.25, -0.43, 0.76, ...]  (close!)
"Database schema"    → [-0.67, 0.12, -0.34, ...] (far!)
```

### Embedding Model

MAMA uses **Transformers.js** (in-browser ML) with pre-trained models:

| Model | Size | Language | Accuracy |
|-------|------|----------|----------|
| `Xenova/multilingual-e5-small` | 120MB | Korean + English | 80% (default) |
| `Xenova/all-MiniLM-L6-v2` | 90MB | English only | 75% |
| `Xenova/gte-large` | 200MB | English only | 85% |

**See also:** [Configuration Guide](../guides/configuration.md#change-embedding-model)

---

## Similarity Scoring

### Cosine Similarity

MAMA computes **cosine similarity** between query embedding and decision embeddings:

```
similarity = cos(θ) = (A · B) / (||A|| × ||B||)

Where:
- A = query embedding
- B = decision embedding
- θ = angle between vectors
```

**Range:** 0.0 (no similarity) to 1.0 (identical)

**Example:**

```
Query: "authentication strategy"
Decision 1: "JWT with refresh tokens" → 0.92 (92% match)
Decision 2: "Database indexing" → 0.15 (15% match)
```

### Similarity Threshold

MAMA shows results with similarity >= 50% (configurable):

```json
{
  "similarity_threshold": 0.5
}
```

---

## Ranking Algorithm

### Components

MAMA combines three signals to rank results:

1. **Semantic similarity (70%)** - How closely the meaning matches
2. **Recency (30%)** - How recently the decision was made
3. **Graph boost (bonus)** - Decisions linked via supersedes/refines

### Formula

```
final_score = (semantic_score × 0.7) + (recency_score × 0.3) + graph_boost

Where:
- semantic_score: cosine similarity (0.0-1.0)
- recency_score: exponential decay based on time
- graph_boost: +0.1 for each graph connection
```

**Example:**

```
Decision: auth_strategy
- Semantic: 0.92 (92% match)
- Recency: 0.95 (created 2 hours ago)
- Graph: +0.2 (2 supersedes links)

Final score: (0.92 × 0.7) + (0.95 × 0.3) + 0.2 = 1.129 → capped at 1.0
```

### Recency Decay

**Default configuration:**

```json
{
  "recency_weight": 0.3,
  "recency_scale": 7,
  "recency_decay": 0.5
}
```

**Decay curve:**

```
Score = e^(-(days / recency_scale))

Day 0:  1.0  (100%)
Day 7:  0.5  (50%)
Day 14: 0.25 (25%)
Day 30: 0.01 (1%)
```

**See also:** [Performance Tuning Guide](../guides/performance-tuning.md#recency-tuning)

---

## Cross-Lingual Search

### How It Works

The **multilingual-e5-small** model maps Korean and English to the **same semantic space**:

```
Korean:  "인증" → [0.23, -0.45, 0.78, ...]
English: "authentication" → [0.25, -0.43, 0.76, ...]
                           ↑ Very similar vectors!
```

**Result:** Korean query "인증" matches English decision "authentication strategy" at 88%

### Language Detection

MAMA does **not** detect language. The embedding model automatically handles both languages:

```
/mama-suggest "How do I handle 인증?"
# Matches both English and Korean decisions
```

---

## Graph Expansion

### Supersedes Relationships

When a decision supersedes another, both are considered:

```
Query: "authentication"

Matched: auth_strategy_v3 (90%)
Graph expansion finds:
- auth_strategy_v2 (superseded by v3) → +0.1 boost
- auth_strategy_v1 (superseded by v2) → +0.05 boost
```

**Why?** Understanding the evolution helps avoid repeating past mistakes.

**Implementation:** `src/core/graph-expansion.js`

**See also:** [Decision Graph](decision-graph.md)

---

## Performance Optimizations

### 1. Embedding Caching

Embeddings are computed once during `/mama-save` and stored as BLOBs in SQLite:

```sql
CREATE TABLE decisions (
  id INTEGER PRIMARY KEY,
  topic TEXT,
  decision TEXT,
  embedding BLOB  -- 384-dimensional vector stored here
);
```

**Benefit:** No recomputation on search (~3ms saved per query)

### 2. Lazy Model Loading

Model loads only on first search:

```
Session start: Model not loaded (0ms cost)
First /mama-suggest: Load model (~987ms) + search (~89ms)
Second /mama-suggest: Cached model + search (~89ms)
```

### 3. Vector Index

MAMA uses **flat vector search** (brute force):

```
For each decision:
  similarity = cosine(query_embedding, decision_embedding)
```

**Complexity:** O(N) where N = number of decisions

**Acceptable because:**
- Most users have <1000 decisions (~50ms)
- SQLite is fast enough for this scale
- No need for ANN (Approximate Nearest Neighbor) yet

**Future:** May add FAISS or Annoy if database grows to >10,000 decisions

---

## Limitations

### 1. First Query Latency

**Issue:** First query takes ~987ms (model load)

**Mitigation:** Lazy loading avoids upfront cost

**Future:** Pre-warm model on plugin load (configurable)

### 2. Embedding Dimension

**Issue:** 384 dimensions (120MB model) is a trade-off

**Trade-off:**
- Smaller model (90MB): Faster, less accurate
- Larger model (200MB): Slower, more accurate

**Configurable:** See [Configuration Guide](../guides/configuration.md#change-embedding-model)

### 3. Language Coverage

**Issue:** Only Korean + English supported

**Future:** Add multilingual-e5-base for more languages (Japanese, Chinese, etc.)

---

## Technical Deep Dive

### Embedding Generation Pipeline

```
1. User input: "JWT authentication with refresh tokens"
2. Tokenization: ["JWT", "authentication", "with", "refresh", "tokens"]
3. Model inference:
   ├── Token IDs: [1234, 5678, 9012, ...]
   ├── Attention layers: 12 layers
   └── Output: [0.23, -0.45, 0.78, ..., 0.12] (384 dimensions)
4. Store in SQLite as BLOB
```

**Implementation:** `src/core/embeddings.js`

### Similarity Search Pipeline

```
1. User query: "authentication strategy"
2. Generate query embedding: [0.25, -0.43, 0.76, ...]
3. Load all decision embeddings from SQLite
4. Compute cosine similarity for each:
   ├── Decision 1: 0.92 (auth_strategy)
   ├── Decision 2: 0.78 (jwt_implementation)
   └── Decision 3: 0.15 (database_schema)
5. Filter: Keep only >= 0.5
6. Rank: Sort by final_score (semantic + recency + graph)
7. Return top 10 (configurable)
```

**Implementation:** `src/core/similarity.js`, `src/core/scoring.js`

---

## FAQs

### Q: Why not use OpenAI embeddings?

**A:** MAMA is 100% local. OpenAI embeddings require API calls (privacy issue).

### Q: Can I use a different embedding model?

**A:** Yes! Any Transformers.js compatible model works. See [Configuration Guide](../guides/configuration.md#change-embedding-model).

### Q: Does MAMA support phrase matching?

**A:** Yes, implicitly. Embeddings capture phrase meaning, not just individual words.

### Q: How accurate is semantic search?

**A:** 80% in Tier 1 (measured against test set). Configurable via model selection.

---

## See Also

- [Tier System](tier-system.md) - Fallback to exact match when embeddings unavailable
- [Decision Graph](decision-graph.md) - Graph expansion for supersedes relationships
- [Configuration Guide](../guides/configuration.md) - Change embedding model
- [Performance Tuning](../guides/performance-tuning.md) - Optimize for your use case
- [FR8-12 (Semantic Search)](../reference/fr-mapping.md) - Functional requirements
