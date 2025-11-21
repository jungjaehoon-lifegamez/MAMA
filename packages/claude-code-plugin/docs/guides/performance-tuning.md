# Performance Tuning Guide

This guide helps you optimize MAMA for your specific use case, whether you prioritize speed, accuracy, or recent decision recall.

---

## Quick Tuning Profiles

### Profile 1: Speed-Optimized

**Use case:** Fast queries, acceptable accuracy loss.

```json
{
  "embedding_model": "Xenova/all-MiniLM-L6-v2",
  "search_limit": 5,
  "recency_weight": 0.1,
  "disable_hooks": false
}
```

**Expected results:**
- First query: ~600ms (smaller model)
- Subsequent: ~60ms
- Accuracy: 75% (5% lower than default)

---

### Profile 2: Accuracy-Optimized

**Use case:** Maximum precision, can tolerate slower queries.

```json
{
  "embedding_model": "Xenova/gte-large",
  "search_limit": 20,
  "recency_weight": 0.3,
  "disable_hooks": false
}
```

**Expected results:**
- First query: ~1500ms (larger model)
- Subsequent: ~150ms
- Accuracy: 85% (5% better than default)

---

### Profile 3: Recency-Focused

**Use case:** Heavily favor recent decisions.

```json
{
  "embedding_model": "Xenova/multilingual-e5-small",
  "search_limit": 10,
  "recency_weight": 0.7,
  "recency_scale": 3,
  "disable_hooks": false
}
```

**Expected results:**
- Performance: Same as default (~89ms)
- Recent items (last 3 days) will dominate results

---

### Profile 4: Privacy-Focused

**Use case:** Manual control, no automatic context injection.

```json
{
  "embedding_model": "Xenova/multilingual-e5-small",
  "search_limit": 10,
  "recency_weight": 0.3,
  "disable_hooks": true
}
```

**Expected results:**
- No automatic context injection
- All saves must be manual via `/mama-save`
- Same query performance as default

---

## Parameter Tuning

### Embedding Model Selection

**Parameter:** `embedding_model`

**Available models:**

| Model | Size | First Query | Subsequent | Accuracy |
|-------|------|-------------|------------|----------|
| `Xenova/all-MiniLM-L6-v2` | 90MB | ~600ms | ~60ms | 75% |
| `Xenova/multilingual-e5-small` | 120MB | ~987ms | ~89ms | 80% (default) |
| `Xenova/gte-large` | 200MB | ~1500ms | ~150ms | 85% |

**How to choose:**

```bash
# For speed
/mama-configure --model Xenova/all-MiniLM-L6-v2

# For accuracy
/mama-configure --model Xenova/gte-large

# For Korean + English (default)
/mama-configure --model Xenova/multilingual-e5-small
```

**Impact:**
- Affects: First query time, subsequent query time, accuracy
- Does not affect: Save speed, Tier 2 fallback

---

### Search Result Limit

**Parameter:** `search_limit`

**Range:** 1-50 (default: 10)

**Configuration:**

```json
{
  "search_limit": 20
}
```

**Trade-offs:**

| Limit | Query Time | Coverage |
|-------|-----------|----------|
| 5 | ~60ms | May miss relevant items |
| 10 | ~89ms | Good balance (default) |
| 20 | ~130ms | Comprehensive coverage |
| 50 | ~250ms | Exhaustive (may be noisy) |

**When to increase:**
- You have many decisions (>100)
- You want comprehensive results
- Query speed is not critical

**When to decrease:**
- You prioritize speed
- You have few decisions (<50)
- You use specific topics (don't need broad search)

---

### Recency Tuning

**Parameters:**
- `recency_weight`: How much to favor recent items (0-1, default 0.3)
- `recency_scale`: Days until recency boost decays (default 7)
- `recency_decay`: Score multiplier at scale point (0-1, default 0.5)

**Configuration:**

```json
{
  "recency_weight": 0.5,
  "recency_scale": 14,
  "recency_decay": 0.3
}
```

**Scenarios:**

#### Scenario 1: Favor Recent Work

```json
{
  "recency_weight": 0.7,
  "recency_scale": 3
}
```

**Effect:** Items from last 3 days will dominate results.

**Use case:** Fast-moving projects with frequent context switches.

#### Scenario 2: Ignore Recency

```json
{
  "recency_weight": 0.0
}
```

**Effect:** Pure semantic search, no recency boost.

**Use case:** Long-lived projects where old decisions remain relevant.

#### Scenario 3: Gradual Decay

```json
{
  "recency_weight": 0.3,
  "recency_scale": 30,
  "recency_decay": 0.7
}
```

**Effect:** Gentle recency boost over 30 days.

**Use case:** Projects with medium-term decision cycles (sprints, milestones).

---

## Monitoring Performance

### Check Current Configuration

```bash
cat ~/.mama/config.json
```

### Measure Query Latency

```bash
# Enable debug mode
export MAMA_DEBUG=true

# Run query
/mama-suggest "authentication strategy"

# Check logs for timing breakdown
```

### Performance Regression Tests

```bash
npm run test:performance

# Expected output:
# ✅ Hook latency < 500ms
# ✅ Embedding < 30ms
# ✅ Vector search < 100ms
```

---

## Troubleshooting Slow Performance

### Problem: First query takes >2 seconds

**Likely cause:** Large embedding model or slow disk.

**Solutions:**
1. Use smaller model: `Xenova/all-MiniLM-L6-v2`
2. Use SSD instead of HDD
3. Reduce search_limit to 5

---

### Problem: Subsequent queries slow (>200ms)

**Likely cause:** Large database or high search_limit.

**Solutions:**
1. Reduce search_limit to 5-10
2. Archive old decisions (move to separate DB)
3. Use Tier 2 fallback (exact match only)

---

### Problem: Hook timeouts (500ms exceeded)

**Likely cause:** Model loading during hook execution.

**Solutions:**
1. Pre-warm model: Run `/mama-suggest test` before working
2. Use smaller model: `Xenova/all-MiniLM-L6-v2`
3. Disable hooks: `MAMA_DISABLE_HOOKS=true`

---

### Problem: High memory usage

**Likely cause:** Large embedding model loaded in memory.

**Solutions:**
1. Use smaller model: `Xenova/all-MiniLM-L6-v2` (90MB vs 200MB)
2. Restart Claude Code periodically
3. Use Tier 2 fallback (no model loading)

---

## Advanced Tuning

### Database Optimization

**For large databases (>1,000 decisions):**

```sql
-- Run VACUUM to compact database
sqlite3 ~/.claude/mama-memory.db "VACUUM;"

-- Analyze for query optimization
sqlite3 ~/.claude/mama-memory.db "ANALYZE;"
```

**Expected improvement:** 10-20% faster queries.

---

### Hook Priority Tuning

**If multiple hooks compete for resources:**

1. Check hook order in `.claude/settings.local.json`
2. Place MAMA hooks last (lower priority)
3. Increase timeout to 800ms if needed

```json
{
  "hooks": {
    "UserPromptSubmit": {
      "timeout": 800
    }
  }
}
```

---

### Custom Scoring Function

**For advanced users:** Modify scoring algorithm.

**Location:** `src/core/scoring.js`

**Example:** Boost decisions with high confidence:

```javascript
// Add confidence boost
finalScore = semanticScore * 0.7 + recencyScore * 0.3 + confidenceBoost * 0.1;
```

**Caution:** Custom modifications may affect accuracy. Test thoroughly.

---

## Benchmarking

### Run Benchmarks

```bash
npm run benchmark

# Output:
# Hook latency: 102ms (target: <500ms)
# Embedding: 3ms (target: <30ms)
# Vector search: 48ms (target: <100ms)
# Save: 19ms (target: <50ms)
```

### Compare Models

```bash
# Benchmark all models
npm run benchmark:models

# Output:
# all-MiniLM-L6-v2: 62ms avg
# multilingual-e5-small: 89ms avg
# gte-large: 154ms avg
```

---

## See Also

- [Configuration Guide](configuration.md) - All configuration options
- [Performance Characteristics](../explanation/performance.md) - Design philosophy
- [Troubleshooting](troubleshooting.md) - Common performance issues
- [Tier System](../tutorials/understanding-tiers.md) - Fallback behavior
