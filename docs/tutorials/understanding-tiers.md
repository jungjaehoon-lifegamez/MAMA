# Understanding the Tier System

**Audience:** All users
**Duration:** 5 minutes
**Goal:** Understand MAMA's tier system and transparency guarantees

---

## What is the Tier System?

MAMA operates in **two tiers** with full transparency about what's working and what's degraded.

**FR Reference:** [FR25-29 (Transparency & Tier Awareness)](../reference/fr-mapping.md)

---

## Tier Comparison

| Tier | Features | Accuracy | Requirements | Status |
|------|----------|----------|--------------|--------|
| **🟢 Tier 1** | Vector search + Graph + Recency | 80% | Transformers.js + SQLite | Optimal |
| **🟡 Tier 2** | Exact match only | 40% | SQLite only | Fallback |

---

## Tier 1 (Full Features) - 🟢

**Message you'll see:**
```
🔍 System Status: 🟢 Tier 1 | Full Features Active | ✓ 89ms | 3 decisions
```

**What this means:**
- ✅ Vector search enabled (semantic similarity)
- ✅ Decision graph traversal (supersedes/refines edges)
- ✅ Recency weighting (recent decisions ranked higher)
- ✅ Cross-lingual search (Korean ↔ English)

**When you see this:** Everything is working optimally. No action needed.

---

## Tier 2 (Fallback Mode) - 🟡

**Message you'll see:**
```
🔍 System Status: 🟡 Tier 2 | Embeddings unavailable | ✓ 12ms | 1 decision
```

**What this means:**
- ⚠️ Vector search DISABLED (exact match only)
- ✅ Decision graph still works
- ⚠️ Accuracy dropped to ~40%
- ⚠️ Korean-English cross-lingual search unavailable

**When you see this:** System is degraded but functional. See [Tier 2 Remediation Guide](../guides/tier-2-remediation.md).

---

## Why Tier 2 Happens

**Common causes:**
1. **First install** - Transformers.js model not downloaded yet
2. **Network issue** - Model download failed during first use
3. **Disk space** - Insufficient space for model cache (~120MB)
4. **Platform incompatibility** - Some edge cases on ARM64/Windows

---

## Transparency Guarantee

Every context injection shows current tier status. You **always** know what's working and what's degraded.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔍 System Status: 🟢 Tier 1 | Full Features Active | ✓ 89ms | 3 decisions
💡 MAMA: 2 related decisions
   • auth_strategy (85%, 2d ago)
   • database_choice (72%, 1w ago)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**This transparency is unique to MAMA.** Other tools silently degrade. MAMA tells you exactly what's working.

---

## Performance Impact

**Tier 1:**
- First query: ~987ms (model load + inference)
- Subsequent queries: ~89ms (cached)

**Tier 2:**
- All queries: ~12ms (exact match only)

**Trade-off:** Tier 2 is faster but less accurate. Tier 1 is slower but finds 80% of relevant decisions.

---

## Next Steps

- **Fix Tier 2:** [Tier 2 Remediation Guide](../guides/tier-2-remediation.md)
- **Learn performance:** [Performance Explanation](../explanation/performance.md)
- **Understand architecture:** [Architecture Explanation](../explanation/architecture.md)

---

**Related:**
- [Tier System Design](../explanation/tier-system.md)
- [Tier 2 Remediation Guide](../guides/tier-2-remediation.md)
- [Performance Characteristics](../explanation/performance.md)
