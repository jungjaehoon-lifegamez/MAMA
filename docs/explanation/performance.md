# Performance Characteristics

**FR Reference:** [FR36-40 (Performance Requirements)](../reference/fr-mapping.md)

This document explains MAMA's performance characteristics, design choices, and how to optimize for your use case.

---

## Performance Overview

MAMA is designed to be **non-blocking** and **fast**. All operations complete within strict time budgets to ensure Claude Code remains responsive.

| Operation              | Target (p95) | Actual (Measured) | Status                       |
| ---------------------- | ------------ | ----------------- | ---------------------------- |
| Hook injection latency | <1200ms      | ~150ms            | ✅ **8x better than target** |
| HTTP embedding request | <100ms       | ~50ms             | ✅ **2x better than target** |
| Vector search          | <100ms       | ~50ms             | ✅ **PASS**                  |
| Decision save          | <50ms        | ~20ms             | ✅ **PASS**                  |

**FR References:**

- [FR36](../reference/fr-mapping.md) - Hook latency
- [FR37](../reference/fr-mapping.md) - Embedding speed
- [FR38](../reference/fr-mapping.md) - Search speed
- [FR39](../reference/fr-mapping.md) - Save speed

---

## Tier-Specific Performance

### With HTTP Embedding Server (Recommended)

**Hook latency:** ~150ms total

MAMA Standalone runs an HTTP embedding server on port 3849 that keeps the model loaded in memory. Hooks use HTTP requests instead of loading the model each time.

**Breakdown:**

- HTTP embedding request: ~50ms
- Vector search: ~50ms
- Graph expansion: ~20ms
- Recency scoring: ~10ms
- Formatting: ~6ms
- Network overhead: ~14ms

**Benefits:**

- ✅ No model load time (stays in memory)
- ✅ 94% faster than without HTTP server (2-9s → 150ms)
- ✅ Shared across all local LLM clients

### Tier 1 Performance (Without HTTP Server - Fallback)

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

- HTTP embedding server: Model stays loaded, no per-request load time
- Early timeout: Hooks abort at 1200ms
- Asynchronous operations: No synchronous waits
- Fail-fast: If HTTP server unavailable, fall back to local model or Tier 2

**Result:** ~150ms actual latency (8x better than target)

### 2. HTTP Embedding Server

**Target:** Avoid repeated model loading across hook invocations.

**Implementation:**

- Standalone starts HTTP embedding server on port 3849 by default
- MCP can start it only in legacy opt-in mode (`MAMA_MCP_START_HTTP_EMBEDDING=true`)
- Model loads once when server starts, stays in memory
- Hooks make HTTP requests to get embeddings (~50ms)
- Port file at `~/.mama-embedding-port` for client discovery
- Fallback: Local model load if HTTP server unavailable

**Result:** ~50ms embedding requests (vs 2-9s model load)

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
  "embedding_model": "Xenova/multilingual-e5-small",
  "search_limit": 5,
  "recency_weight": 0.1
}
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

### Where Time is Spent (With HTTP Server)

```
Hook latency (~150ms total):
├── HTTP embedding:    50ms (33%) ← Main cost
├── Vector search:     50ms (33%)
├── Graph expansion:   20ms (13%)
├── Recency scoring:   10ms (7%)
├── Network overhead:  14ms (9%)
└── Formatting:         6ms (4%)
```

**Optimization priority:**

1. **HTTP embedding (50ms)** - Already optimized with memory-resident model
2. **Vector search (50ms)** - Use smaller model or reduce search_limit
3. **Graph expansion (20ms)** - Unavoidable (critical feature)

### Where Time is Spent (Without HTTP Server - Fallback)

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

✅ **Hook latency < 1200ms (p95):** Measured at ~150ms with HTTP server
✅ **HTTP embedding < 100ms (p95):** Measured at ~50ms
✅ **No blocking operations:** All I/O is asynchronous
✅ **Graceful degradation:** Falls back to local model or Tier 2 if HTTP server unavailable

### What MAMA Does NOT Guarantee

❌ **HTTP server availability:** Port 3849 may be in use by another process
❌ **Disk I/O speed:** Depends on your disk (SSD recommended)
❌ **SQLite performance:** Depends on database size (>10k decisions may slow down)

---

## Performance FAQs

### Q: Why is hook latency so fast now?

**A:** MAMA Standalone runs an HTTP embedding server on port 3849 that keeps the model loaded in memory. Hooks make HTTP requests (~50ms) instead of loading the model each time (2-9s). This results in ~150ms total hook latency.

### Q: What if the HTTP server is not running?

**A:** Hooks fall back to loading the model locally. First query takes ~987ms (model load), subsequent queries ~89ms. If that also fails, falls back to Tier 2 (exact match only).

### Q: Can other tools use the HTTP embedding server?

**A:** Yes. Any local LLM client (Cursor, Aider, Continue, etc.) can use `http://127.0.0.1:3849/embed` to get embeddings. The model stays loaded in memory, benefiting all clients.

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
