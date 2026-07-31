# Tier System Deep Dive

The Tier System is MAMA's graceful degradation mechanism. It ensures MAMA always works, even when optimal conditions aren't met.

---

## Overview

MAMA defines multiple tier systems. The first is the **Search Capability Tiers** (2 tiers for graceful degradation), and the second is the **[Tool Permission Tiers](#tool-permission-tiers-multi-agent-system)** (3 tiers for agent access control).

### Search Capability Tiers

| Tier          | Features                        | Accuracy | Latency | Fallback               |
| ------------- | ------------------------------- | -------- | ------- | ---------------------- |
| **🟢 Tier 1** | Vector search + Graph + Recency | 80%      | ~89ms   | Always attempted first |
| **🟡 Tier 2** | Exact match (SQL LIKE)          | 40%      | ~12ms   | Automatic fallback     |

**Transparency:** MAMA always shows which tier is active.

---

## Tier 1: Full Features

### What You Get

- **Semantic understanding:** "authentication" matches "auth", "JWT", "login"
- **Cross-lingual:** Multilingual queries match across different languages
- **Recency boosting:** Recent decisions rank higher
- **Graph expansion:** Follows supersedes/refines/contradicts links
- **Confidence scoring:** Combines multiple signals

### Requirements

1. **Node.js >= 22.13.0** - Required for built-in `node:sqlite`
2. **Embedding model available** - Model downloads on first successful run
3. **Embedding model loaded** - First query loads model (~987ms)

### Performance

- **First query:** ~987ms (model load + inference)
- **Subsequent queries:** ~89ms
- **Accuracy:** 80% (measured against test set)

---

## Tier 2: Exact Match Fallback

### What You Get

- **Exact topic matching:** Only finds exact topic names
- **Keyword search:** Uses SQL LIKE '%keyword%'
- **Always available:** No dependencies

### When It Activates

Tier 2 automatically activates when:

1. **Embedding model fails to load**
   - Missing or incompatible Node.js runtime
   - Insufficient memory

2. **User explicitly disables vector search**
   - Useful for debugging or ultra-fast queries

### Performance

- **All queries:** ~12ms (no model loading)
- **Accuracy:** 40% (exact match only)
- **Trade-off:** 7x faster, but misses semantic matches

---

## How Fallback Works

### Automatic Detection

```
1. User runs /mama:search "authentication strategy"
2. MAMA attempts Tier 1:
   ├── Load embedding model... ❌ FAILED (`node:sqlite` unavailable in this runtime)
   └── Fall back to Tier 2
3. MAMA runs Tier 2:
   ├── SQL query: SELECT * WHERE topic LIKE '%authentication%'
   └── Return results
4. Display: "🟡 Tier 2 (Exact Match Only)"
```

### No User Intervention Required

- Fallback happens **automatically**
- No errors shown to user
- System continues working

### Upgrade Path

If Tier 2 is active, MAMA shows remediation link:

```
🟡 Tier 2 (Exact Match Only)
📖 See: /mama-remediate or docs/guides/tier-2-remediation.md
```

---

## Tier Detection

### Check Current Tier

```
/mama:search

# Output:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🟢 Tier 1 (Full Features Active)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### Tier Indicator in Results

All search results show tier status:

```
💡 MAMA: 2 related decisions (🟢 Tier 1)
   • auth_strategy (90%, 2 hours ago)
   • jwt_implementation (75%, 1 day ago)
```

---

## Tier Comparison

### Example Query: "How should I handle authentication?"

**Tier 1 results:**

```
1. auth_strategy (90% match) - JWT with refresh tokens
2. session_management (78% match) - Cookie-based sessions
3. oauth_integration (65% match) - OAuth 2.0 provider setup
```

**Tier 2 results:**

```
1. auth_strategy (exact match) - JWT with refresh tokens
(No other results - "authentication" doesn't exactly match other topics)
```

---

## When to Use Tier 2 Intentionally

### Use Case 1: Ultra-Fast Queries

If you know the exact topic name:

```bash
/mama:search auth_strategy  # 12ms vs 89ms
```

### Use Case 2: Debugging

Disable vector search to isolate issues:

```bash
/mama:search "test"  # Pure SQL, no model interference
```

### Use Case 3: Low-Resource Environments

On machines with limited RAM or old CPUs:

```json
{}
```

---

## Upgrading from Tier 2 to Tier 1

### Step 1: Check Node.js Version

```bash
node --version
# Required: v22.13.0 or higher
```

### Step 2: Reinstall dependencies with a supported runtime

### Step 3: Restore optional image packages if needed

```bash
cd ~/.claude/plugins/mama
rm -rf node_modules package-lock.json
npm install
npm install --include=optional sharp
```

### Step 4: Verify Upgrade

```bash
/mama:search

# Expected: 🟢 Tier 1 (Full Features Active)
```

**Full guide:** [Tier 2 Remediation Guide](../guides/tier-2-remediation.md)

---

## Tier System Design Philosophy

### Why Two Tiers?

1. **Reliability:** System never breaks, always degrades gracefully
2. **Transparency:** User always knows what features are active
3. **Progressive enhancement:** Start simple (Tier 2), upgrade when ready (Tier 1)

### Why Not Just Fail?

**Bad approach:**

```
Error: Embedding model failed to load
MAMA is unavailable
```

**Good approach (our implementation):**

```
🟡 Tier 2 (Exact Match Only)
MAMA continues working with reduced accuracy
```

---

## Technical Implementation

### Detection Logic

```javascript
// Simplified pseudocode
function getTier() {
  try {
    loadEmbeddingModel();
    return 'tier1';
  } catch (error) {
    console.warn('Tier 1 unavailable, falling back to Tier 2');
    return 'tier2';
  }
}
```

### Search Routing

```javascript
function search(query) {
  const tier = getTier();

  if (tier === 'tier1') {
    return vectorSearch(query); // 80% accuracy
  } else {
    return exactMatchSearch(query); // 40% accuracy
  }
}
```

**Implementation:** `packages/mama-core/src/tier-validator.ts`

---

## FAQs

### Q: Will I lose data if Tier 2 activates?

**A:** No. All data remains in the database. Only search accuracy changes.

### Q: Can I manually switch tiers?

### Q: Does Tier 2 support Korean?

**A:** No. Tier 2 uses exact SQL matching. Korean queries must match Korean topics exactly.

### Q: Can I use Tier 1 on some queries and Tier 2 on others?

**A:** No. Tier is determined at session start and applies to all queries.

---

## Tool Permission Tiers (Multi-Agent System)

Separate from the search tiers above, the **Multi-Agent System** uses a tier field to control which native tools a subprocess agent may use. Ground truth: `packages/standalone/src/multi-agent/tool-permission-manager.ts`.

### Defaults (verbatim from code)

| Tier       | Allowed                                         | Blocked                                 |
| ---------- | ----------------------------------------------- | --------------------------------------- |
| **Tier 1** | `*` (everything)                                | -                                       |
| **Tier 2** | `Read`, `Grep`, `Glob`, `WebSearch`, `WebFetch` | `Write`, `Edit`, `Bash`, `NotebookEdit` |
| **Tier 3** | same as Tier 2                                  | same as Tier 2                          |

Two things the old version of this page got wrong:

- **Tier 2 and Tier 3 defaults are byte-identical.** Downgrading an agent from 2 to 3 changes nothing by default. Differences only come from an explicit `tool_permissions` block on the persona.
- **These are Claude-Code-native tool names, not MAMA gateway tools.** Memory writes (`mama_save`, `mama_update`) are NOT granted by tier; they require an explicit `tool_permissions` allowlist, and gateway-tool authority is governed separately by per-run envelopes (see the generated catalog `packages/standalone/src/agent/gateway-tools.md`).

Delegation (`can_delegate`) is accepted and persisted by the API but **inert**: the `delegate` tool is not dispatchable - its executor was deleted with the multi-agent delegation path.

Tier 3 agents cannot opt into Code-Act and fall back to normal tool-call mode. The `/api/code-act` HTTP endpoint defaults to Tier 2 for Code-Act-enabled agents, but can be forced into read-only injection with `MAMA_CODE_ACT_READ_ONLY=true`.

### Configuration

Personas live in `config.yaml` under `multi_agent.agents` (there is no `~/.mama/agents/` directory):

```yaml
multi_agent:
  agents:
    reviewer:
      tier: 2 # 1, 2, or 3 (default: 1)
```

Or via API:

```bash
curl -X PUT http://localhost:3847/api/multi-agent/agents/reviewer \
  -H "Content-Type: application/json" \
  -d '{"tier": 2}'
```

---

## See Also

- [Tier 2 Remediation Guide](../guides/tier-2-remediation.md) - How to upgrade search to Tier 1
- [Understanding Tiers Tutorial](../tutorials/understanding-tiers.md) - User-facing guide
- [Performance Characteristics](performance.md) - Latency comparison
- [Architecture](architecture.md) - Tier detection implementation
- [Security Guide](../guides/security.md) - Code-Act sandbox security
