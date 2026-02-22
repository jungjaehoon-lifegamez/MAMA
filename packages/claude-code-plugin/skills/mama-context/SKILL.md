---
name: mama-context
description: Always-on background context injection from MAMA memory. Automatically surfaces relevant decisions when you work on code, without explicit invocation.
---

# MAMA Context - Auto-Injection Skill

## Overview

This skill provides **automatic background context injection** using MAMA's hook system. It runs silently and surfaces relevant past decisions via the UserPromptSubmit hook (~150ms latency with HTTP embedding server).

**Philosophy:** Gentle hints, not intrusive walls of text. Claude sees topic + time, decides if relevant.

---

## How It Works

The skill uses a **multi-hook system** for comprehensive context injection:

**UserPromptSubmit Hook** (active, ~150ms — no plugin-side script; handled by Claude Code host)

- Triggers: On every user message submission
- Purpose: Inject relevant decisions as context before Claude responds
- Latency: ~150ms (HTTP embedding server keeps model in memory)
- Token budget: 40 tokens (teaser format)

**SessionStart Hook** (`scripts/sessionstart-hook.js`)

- Triggers: Once per session
- Purpose: Initialize MAMA, pre-warm embedding model
- Timeout: 15s

**PreToolUse Hook** (`scripts/pretooluse-hook.js`) - **disabled** (script retained)

- Previously: Injected contracts before Edit/Write operations
- Status: Disabled for performance. Script retained for future use.

**PostToolUse Hook** (`scripts/posttooluse-hook.js`) - **disabled** (script retained)

- Previously: Tracked code changes, suggested decision saves
- Status: Disabled for performance. Script retained for future use.

**PreCompact Hook** (`scripts/precompact-hook.js`)

- Triggers: Before context compaction
- Purpose: Preserve unsaved decisions in compacted context
- Timeout: 10s

---

## Teaser Format (40 tokens)

```text
💡 MAMA: 2 related
   • authentication_strategy (85%, 3 days ago)
   • mesh_detail (78%, 1 week ago)
   /mama:search <topic> for details
```

**Why teaser?**

- Hooks fire on user messages (UserPromptSubmit) → Must be lightweight
- Claude infers relevance from topic + similarity + time
- Full details available via `/mama:search` if needed
- Avoids token bloat (250 tokens → 40 tokens)

---

## Status Transparency

Every injection shows current tier status:

**Tier 1 (Full Features):**

```text
🔍 System Status: ✅ Full Features Active (Tier 1)
   - Vector Search: ✅ ON (Transformers.js, 3ms latency)
   - Search Quality: HIGH (80% accuracy)
```

**Tier 2 (Degraded):**

```text
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

> **Note:** `similarity_threshold: 0.7` applies to explicit searches (`/mama:search`). The disabled `pretooluse-hook.js` uses a looser `SIMILARITY_THRESHOLD = 0.6` (kept from its original contract-injection design). The active UserPromptSubmit hook delegates search to the MCP server, which uses its own default threshold. Hook thresholds are intentionally separate from the config value shown above.

---

## When Claude Should Use This

✅ **Automatic (no action needed):**

- Context appears when relevant decisions exist
- Claude notices hints and can request details
- User sees transparent status (Tier 1/2)

❌ **Don't explicitly invoke this skill:**

- It's always-on (background process)
- Hooks handle triggering automatically
- Use `/mama:search` for explicit lookups

---

## Technical Details

**Hook Integration:**

- UserPromptSubmit: Active (~150ms, no plugin-side script; handled by Claude Code host via MCP)
- SessionStart: `scripts/sessionstart-hook.js` (initialization)
- PreToolUse: `scripts/pretooluse-hook.js` (disabled, script retained)
- PostToolUse: `scripts/posttooluse-hook.js` (disabled, script retained)
- PreCompact: `scripts/precompact-hook.js` (decision preservation)

**Performance:**

- Hook latency: ~150ms (HTTP embedding server, model stays in memory)
- Cold start: ~1500ms (embedding model initialization, first session only)
- Warm: ~50ms (HTTP embedding request)
- Timeout: 1800ms (graceful degradation if exceeded)

**Search Algorithm:**

- Vector search: Transformers.js (3ms embedding)
- Hybrid scoring: 20% recency + 50% importance + 30% semantic
- Graph expansion: Follows supersedes edges
- Recency boost: Gaussian decay (30-day half-life)

---

## Acceptance Criteria Mapping

- ✅ AC1: Declared in plugin.json, references hook outputs
- ✅ AC2: Similarity thresholds (70%) + token budgets (40 teaser / 250 full)
- ✅ AC3: Disable via config (MAMA_DISABLE_HOOKS)
- ✅ AC4: Status indicator (Tier 1/2, accuracy, fix instructions)
- ✅ AC5: Smoke test - fires during normal coding session

---

## Example Output

**User edits a file related to authentication:**

**Skill injects (via UserPromptSubmit hook):**

```text
💡 MAMA: 1 related
   • auth_strategy (90%, 2 days ago)
   /mama:search auth_strategy for full decision

🔍 System Status: ✅ Full Features Active (Tier 1)
```

**Claude sees the hint and can:**

1. Ignore (if not relevant)
2. Suggest `/mama:search auth_strategy` to user
3. Continue with general advice

---

## For Developers

**Testing:**

```bash
# Test SessionStart hook (the only testable standalone hook)
node packages/claude-code-plugin/scripts/sessionstart-hook.js

# UserPromptSubmit hook is triggered automatically by Claude Code
# on every user message — no manual invocation needed.
```

**Architecture:**

```text
User submits prompt
    ↓
UserPromptSubmit Hook (~150ms, 1800ms timeout)
    ↓
Decision search (generate embedding, search, score)
    ↓
Context injection to Claude (40-token teaser)
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
6. **Multi-hook system:** UserPromptSubmit (active) + SessionStart + PreCompact + PreToolUse/PostToolUse (disabled)

---

## Related

- Story M3.2 (this skill)
- Story M2.2 (PreToolUse hook — disabled, scripts retained)
- Story M2.4 (Transparency banner)
- Architecture: `docs/MAMA-ARCHITECTURE.md` (Decision 4 - Hook Implementation)
