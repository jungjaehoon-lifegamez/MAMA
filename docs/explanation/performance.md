# Performance Characteristics

**FR Reference:** [FR36-40 (Performance Requirements)](../archive/fr-mapping-v1.0.md)

This document explains MAMA's performance characteristics, design choices, and how to optimize for your use case.

---

## Performance Overview

MAMA is designed to be **non-blocking** and **fast**. All operations complete within strict time budgets to ensure Claude Code remains responsive.

| Operation              | Target (p95) | Notes                                      |
| ---------------------- | ------------ | ------------------------------------------ |
| Hook injection latency | <1200ms      | Bounded by the hook timeout                |
| Vector search          | <100ms       | Includes local embedding and SQLite search |
| Decision save          | <50ms        | Includes local persistence                 |

**FR References:**

- [FR36](../archive/fr-mapping-v1.0.md) - Hook latency
- [FR37](../archive/fr-mapping-v1.0.md) - Embedding speed
- [FR38](../archive/fr-mapping-v1.0.md) - Search speed
- [FR39](../archive/fr-mapping-v1.0.md) - Save speed

---

## Tier-Specific Performance

### Tier 1 Performance

**First query:**

- ~987ms (one-time model load + inference)
- Only happens once per session

**Subsequent queries:**

- ~89ms (cached model)
- Includes vector search + graph expansion + recency scoring

**Breakdown:**

- Embedding generation: ~3ms (after model load)
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

**Target:** Hook completes within 1200ms to avoid blocking Claude's response.

**Implementation:**

- Early timeout: Hooks abort at 1200ms
- Asynchronous operations: No synchronous waits
- Fail-fast: If local embeddings are unavailable, use Tier 2 exact matching

**Result:** ~150ms actual latency (8x better than target)

### 2. In-process embeddings

**Target:** Keep semantic search local and reuse work within the active process.

**Implementation:**

- The process performing semantic search loads the local model on demand
- The process-local cache reuses embeddings
- No embedding listener, proxy, or port discovery is involved
- Provider initialization failures are explicit; Tier 2 uses exact matching

**Result:** Semantic search remains local without a second runtime to start or monitor.

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
{}
```

**Expected performance:**

- Cold start: ~1700ms (q8 quantized model)
- Warm queries: ~11ms (model in memory)

**Trade-offs:**

- ❌ 5% less accurate than default
- ✅ 30% faster

### Use Case: Optimize for Accuracy

**Goal:** Maximum precision, accept slower queries.

**Configuration:**

```json
{}
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
{}
```

**Expected performance:**

- No latency impact (recency scoring is fast)

**Trade-offs:**

- ✅ Recent items rank higher
- ❌ Older but semantically relevant items may be buried

---

## Bottleneck Analysis

### Where Time is Spent (Warm In-Process Model)

```
Hook latency (~150ms total):
├── Local embedding:   50ms (33%) ← Main cost
├── Vector search:     50ms (33%)
├── Graph expansion:   20ms (13%)
├── Recency scoring:   10ms (7%)
├── Runtime overhead:  14ms (9%)
└── Formatting:         6ms (4%)
```

**Optimization priority:**

1. **Local embedding (50ms)** - Reuses the process-local model and cache
2. **Vector search (50ms)** - Use smaller model or reduce search_limit
3. **Graph expansion (20ms)** - Unavoidable (critical feature)

### Where Time is Spent (Cold In-Process Model)

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
/mama:search
# Output shows: 🟢 Tier 1 (Full Features Active)
```

### Measure Actual Latency

```bash
# Enable debug mode
export MAMA_DEBUG=true

# Run query and check logs
/mama:search "authentication strategy"

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

✅ **Hook latency < 1200ms (p95):** Enforced by the hook timeout
✅ **No blocking operations:** All I/O is asynchronous
✅ **Graceful degradation:** Tier 2 remains available if local embeddings are unavailable

### What MAMA Does NOT Guarantee

❌ **Disk I/O speed:** Depends on your disk (SSD recommended)
❌ **SQLite performance:** Depends on database size (>10k decisions may slow down)

---

## Performance FAQs

### Q: What if local embeddings cannot initialize?

**A:** The semantic path reports its provider failure. Search can degrade to Tier 2 exact matching
where that contract applies; it does not contact a fallback HTTP service.

### Q: Does database size affect performance?

**A:** Yes, but minimally:

- <1,000 decisions: ~50ms search time
- 1,000-10,000 decisions: ~70ms search time
- > 10,000 decisions: May exceed 100ms (consider archiving old decisions)

### Q: Why is Tier 2 so much faster?

**A:** Tier 2 uses exact SQL LIKE matching. No vector search, no model loading, no embedding generation. Just a simple database query.

**Trade-off:** 40% accuracy vs 80% in Tier 1.

---

## See Also

- [Configuration Guide](../guides/configuration.md) - How to tune performance settings
- [Performance Tuning Guide](../guides/performance-tuning.md) - Detailed optimization strategies
- [Architecture](architecture.md) - System design decisions
- [Tier System](tier-system.md) - Why Tier 2 is faster but less accurate
