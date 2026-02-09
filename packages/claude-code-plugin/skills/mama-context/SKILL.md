---
name: mama-context
description: Always-on background context injection from MAMA memory. Automatically surfaces relevant decisions when you work on code, without explicit invocation.
---

# MAMA Context - Auto-Injection Skill

## Overview

This skill provides **automatic background context injection** using MAMA's hook system. It runs silently and surfaces relevant past decisions when you edit code (PreToolUse hook) and tracks changes (PostToolUse hook).

**Philosophy:** Gentle hints, not intrusive walls of text. Claude sees topic + time, decides if relevant.

---

## How It Works

The skill uses a **multi-hook system** for comprehensive context injection:

**SessionStart Hook** (`scripts/sessionstart-hook.js`)

- Triggers: Once per session
- Purpose: Initialize MAMA, pre-warm embedding model
- Timeout: 15s

**PreToolUse Hook** (`scripts/pretooluse-hook.js`)

- Triggers: Before Edit, Write, NotebookEdit operations
- Purpose: Inject relevant contracts before code changes
- Similarity threshold: 75%
- Timeout: 5s

**PostToolUse Hook** (`scripts/posttooluse-hook.js`)

- Triggers: After Write, Edit operations
- Purpose: Track code changes, suggest decision saves
- Timeout: 5s

**PreCompact Hook** (`scripts/precompact-hook.js`)

- Triggers: Before context compaction
- Purpose: Preserve unsaved decisions in compacted context
- Timeout: 10s

---

## Teaser Format (40 tokens)

```
💡 MAMA: 2 related
   • authentication_strategy (85%, 3 days ago)
   • mesh_detail (78%, 1 week ago)
   /mama-recall <topic> for details
```

**Why teaser?**

- Must be lightweight to avoid token bloat
- Claude infers relevance from topic + similarity + time
- Full details available via `/mama-recall` if needed
- Avoids token bloat (250 tokens → 40 tokens)

---

## Status Transparency

Every injection shows current tier status:

**Tier 1 (Full Features):**

```
🔍 System Status: ✅ Full Features Active (Tier 1)
   - Vector Search: ✅ ON (Transformers.js, 3ms latency)
   - Search Quality: HIGH (80% accuracy)
```

**Tier 2 (Degraded):**

```
🔍 System Status: ⚠️ DEGRADED MODE (Tier 2)
   - Vector Search: ❌ OFF (embedding model failed)
   - Search Quality: BASIC (40% accuracy, exact match only)

⚠️ Fix: Check embedding model installation
```

---

## Configuration

**Disable Skill:**

```bash
# Environment variable
export MAMA_DISABLE_HOOKS=true

# Or in config file (~/.mama/config.json)
{
  "disable_hooks": true
}
```

**Adjust Thresholds:**

```json
{
  "similarity_threshold": 0.7,
  "token_budget": 40,
  "rate_limit_ms": 1000
}
```

---

## When Claude Should Use This

✅ **Automatic (no action needed):**

- Context appears when relevant decisions exist
- Claude notices hints and can request details
- User sees transparent status (Tier 1/2)

❌ **Don't explicitly invoke this skill:**

- It's always-on (background process)
- Hooks handle triggering automatically
- Use `/mama-recall` for explicit lookups

---

## Technical Details

**Hook Integration:**

- SessionStart: `scripts/sessionstart-hook.js` (initialization)
- PreToolUse: `scripts/pretooluse-hook.js` (contract injection for Edit/Write)
- PostToolUse: `scripts/posttooluse-hook.js` (outcome tracking for Write/Edit)
- PreCompact: `scripts/precompact-hook.js` (decision preservation)

**Performance:**

- Hook latency: ~1200-1500ms typical (includes embedding model loading)
- Cold start: ~1500ms (embedding model initialization)
- Warm: ~300-500ms (model cached)
- Timeout: 1200ms (graceful degradation if exceeded)

**Search Algorithm:**

- Vector search: Transformers.js (3ms embedding)
- Hybrid scoring: 20% recency + 50% importance + 30% semantic
- Graph expansion: Follows supersedes edges
- Recency boost: Gaussian decay (30-day half-life)

---

## Acceptance Criteria Mapping

- ✅ AC1: Declared in plugin.json, references hook outputs
- ✅ AC2: Similarity thresholds (75%) + token budgets (40/300)
- ✅ AC3: Disable via config (MAMA_DISABLE_HOOKS)
- ✅ AC4: Status indicator (Tier 1/2, accuracy, fix instructions)
- ✅ AC5: Smoke test - fires during normal coding session

---

## Example Output

**User edits a file related to authentication:**

**Skill injects (via PreToolUse hook):**

```
💡 MAMA: 1 related
   • auth_strategy (90%, 2 days ago)
   /mama-recall auth_strategy for full decision

🔍 System Status: ✅ Full Features Active (Tier 1)
```

**Claude sees the hint and can:**

1. Ignore (if not relevant)
2. Suggest `/mama-recall auth_strategy` to user
3. Continue with general advice

---

## For Developers

**Testing:**

```bash
# Test PreToolUse hook
export TOOL_NAME="Edit"
export FILE_PATH="src/auth.ts"
node mama-plugin/scripts/pretooluse-hook.js
```

**Architecture:**

```
Code Edit/Write
    ↓
PreToolUse Hook (5s timeout)
    ↓
Contract search (generate embedding, search, score)
    ↓
Contract injection to Claude
    ↓
Claude sees context
```

---

## Key Principles

1. **Lightweight:** 40 tokens teaser format
2. **Transparent:** Always show tier status and latency
3. **Non-intrusive:** Hints, not walls of text
4. **Opt-out:** User control via config (MAMA_DISABLE_HOOKS)
5. **Graceful degradation:** Tier 2 fallback if embeddings unavailable
6. **Multi-hook system:** SessionStart + PreToolUse + PostToolUse + PreCompact

---

## Related

- Story M3.2 (this skill)
- Story M2.2 (PreToolUse hook)
- Story M2.4 (Transparency banner)
- Architecture: `docs/MAMA-ARCHITECTURE.md` (Decision 4 - Hook Implementation)
