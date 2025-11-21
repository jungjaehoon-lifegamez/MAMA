# Performance Characteristics

**FR Reference:** [FR36-40 (Performance Requirements)](../reference/fr-mapping.md)

This document explains MAMA's performance characteristics, design choices, and how to optimize for your use case.

---

## Performance Overview

MAMA is designed to be **non-blocking** and **fast**. All operations complete within strict time budgets to ensure Claude Code remains responsive.

| Operation | Target (p95) | Actual (Measured) | Status |
|-----------|-------------|-------------------|--------|
| Hook injection latency | <500ms | ~100ms | ✅ **5x better than target** |
| Embedding generation | <30ms | 3ms | ✅ **10x better than target** |
| Vector search | <100ms | ~50ms | ✅ **PASS** |
| Decision save | <50ms | ~20ms | ✅ **PASS** |

**FR References:**
- [FR36](../reference/fr-mapping.md) - Hook latency
- [FR37](../reference/fr-mapping.md) - Embedding speed
- [FR38](../reference/fr-mapping.md) - Search speed
- [FR39](../reference/fr-mapping.md) - Save speed

---

## Tier-Specific Performance

### Tier 1 Performance (Vector Search)

**First query:**
- ~987ms (one-time model load + inference)
- Only happens once per session

**Subsequent queries:**
- ~89ms (cached model)
- Includes vector search + graph expansion + recency scoring

**Breakdown:**
- Embedding generation: ~3ms
- Vector search: ~50ms
- Graph expansion: ~20ms
- Recency scoring: ~10ms
- Formatting: ~6ms

### Tier 2 Performance (Exact Match)

**All queries:**
- ~12ms (exact match only)
- No model loading required
- Simple SQL query with LIKE operator

**Trade-offs:**
- ✅ 7x faster than Tier 1
- ❌ 40% accuracy (vs 80% in Tier 1)
- ❌ No semantic understanding

---

## Performance Philosophy

### 1. Non-Blocking Design

**Target:** Hook completes within 500ms to avoid blocking Claude's response.

**Implementation:**
- Early timeout: Hooks abort at 500ms
- Asynchronous operations: No synchronous waits
- Fail-fast: If model load fails, fall back to Tier 2

**Result:** ~100ms actual latency (5x better than target)

### 2. Lazy Loading

**Target:** Don't load embedding model until first search.

**Implementation:**
- Model loads only on first `/mama-suggest` or automatic context injection
- Once loaded, model stays in memory for session

**Result:** Fast startup, no upfront cost

### 3. Caching Strategy

**Target:** Never recompute embeddings.

**Implementation:**
- Embeddings stored as BLOB in SQLite
- Generated once during `/mama-save`
- Reused for all searches

**Result:** 0ms embedding recomputation cost

---

## Performance Tuning

### Use Case: Optimize for Speed

**Goal:** Minimize latency, accept lower accuracy.

**Configuration:**

```json
{
  "embedding_model": "Xenova/all-MiniLM-L6-v2",
  "search_limit": 5,
  "recency_weight": 0.1
}
```

**Expected performance:**
- First query: ~600ms (smaller model)
- Subsequent: ~60ms (faster inference)

**Trade-offs:**
- ❌ 5% less accurate than default
- ✅ 30% faster

### Use Case: Optimize for Accuracy

**Goal:** Maximum precision, accept slower queries.

**Configuration:**

```json
{
  "embedding_model": "Xenova/gte-large",
  "search_limit": 20,
  "recency_weight": 0.3
}
```

**Expected performance:**
- First query: ~1500ms (larger model load)
- Subsequent: ~150ms (more results to rank)

**Trade-offs:**
- ✅ 5% more accurate
- ❌ 2x slower

### Use Case: Optimize for Recent Items

**Goal:** Favor recent decisions heavily.

**Configuration:**

```json
{
  "recency_weight": 0.7,
  "recency_scale": 3
}
```

**Expected performance:**
- No latency impact (recency scoring is fast)

**Trade-offs:**
- ✅ Recent items rank higher
- ❌ Older but semantically relevant items may be buried

---

## Bottleneck Analysis

### Where Time is Spent (Tier 1)

```
First query (987ms total):
├── Model load:       900ms (90%) ← One-time cost
├── Embedding:          3ms (0.3%)
├── Vector search:     50ms (5%)
├── Graph expansion:   20ms (2%)
└── Recency scoring:   14ms (1.4%)

Subsequent queries (89ms total):
├── Embedding:          3ms (3%)
├── Vector search:     50ms (56%) ← Main cost
├── Graph expansion:   20ms (22%)
├── Recency scoring:   10ms (11%)
└── Formatting:         6ms (7%)
```

**Optimization priority:**
1. **Vector search (50ms)** - Use smaller model or reduce search_limit
2. **Graph expansion (20ms)** - Unavoidable (critical feature)
3. **Recency scoring (10ms)** - Adjust recency_weight

### Where Time is Spent (Tier 2)

```
All queries (12ms total):
├── SQL query:        10ms (83%)
└── Formatting:        2ms (17%)
```

**Optimization:** Not needed. Already optimal for exact match use case.

---

## Performance Monitoring

### Check Current Tier

```
/mama-list
# Output shows: 🟢 Tier 1 (Full Features Active)
```

### Measure Actual Latency

```bash
# Enable debug mode
export MAMA_DEBUG=true

# Run query and check logs
/mama-suggest "authentication strategy"

# Look for timing logs in Claude Code debug console
```

### Performance Regression Testing

**Test suite includes performance benchmarks:**

```bash
npm run test:performance

# Expected output:
# ✅ Hook latency < 500ms
# ✅ Embedding generation < 30ms
# ✅ Vector search < 100ms
```

---

## Performance Guarantees

### What MAMA Guarantees

✅ **Hook latency < 500ms (p95):** Measured at ~100ms
✅ **No blocking operations:** All I/O is asynchronous
✅ **Graceful degradation:** Falls back to Tier 2 if Tier 1 fails

### What MAMA Does NOT Guarantee

❌ **First-query speed:** Model load takes ~900ms (unavoidable)
❌ **Disk I/O speed:** Depends on your disk (SSD recommended)
❌ **SQLite performance:** Depends on database size (>10k decisions may slow down)

---

## Performance FAQs

### Q: Why is the first query slow?

**A:** The embedding model needs to be loaded into memory (~900ms one-time cost). This only happens once per session. Subsequent queries are fast (~89ms).

### Q: Can I pre-load the model?

**A:** Not currently supported. Model loads on first search to avoid upfront cost for users who don't search immediately.

### Q: Does database size affect performance?

**A:** Yes, but minimally:
- <1,000 decisions: ~50ms search time
- 1,000-10,000 decisions: ~70ms search time
- >10,000 decisions: May exceed 100ms (consider archiving old decisions)

### Q: Why is Tier 2 so much faster?

**A:** Tier 2 uses exact SQL LIKE matching. No vector search, no model loading, no embedding generation. Just a simple database query.

**Trade-off:** 40% accuracy vs 80% in Tier 1.

---

## See Also

- [Configuration Guide](../guides/configuration.md) - How to tune performance settings
- [Performance Tuning Guide](../guides/performance-tuning.md) - Detailed optimization strategies
- [Architecture](architecture.md) - System design decisions
- [Tier System](tier-system.md) - Why Tier 2 is faster but less accurate
