# Hook Setup: Automatic Context Injection

**Audience:** Users who want always-on context
**Duration:** 5 minutes
**Goal:** Configure MAMA's automatic context injection hooks

---

## What are Hooks?

MAMA uses **Claude Code hooks** to automatically inject relevant context when you ask questions:

```
You: "How should I handle authentication?"

MAMA automatically searches and shows:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 MAMA: 1 related decision
   • auth_strategy (90%, 3 days ago)
   /mama-recall auth_strategy for full history
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**No need to remember to search!** MAMA does it for you.

---

## Available Hooks

MAMA provides **3 hooks**:

| Hook | Trigger | Purpose |
|------|---------|---------|
| **UserPromptSubmit** | Every user prompt | Semantic search → gentle hints |
| **PreToolUse** | Before Read/Edit/Grep | File-specific context (coming soon) |
| **PostToolUse** | After Write/Edit | Auto-save decisions (coming soon) |

**FR Reference:** [FR19-24 (Hook Integration)](../reference/fr-mapping.md)

---

## Default Configuration

**Hooks are ENABLED by default** after installation.

Check if hooks are active:
```bash
# In Claude Code, type any message
You: "test"

# You should see MAMA's status banner (even if no decisions found)
🔍 System Status: 🟢 Tier 1 | Full Features Active
```

If you see this banner, hooks are working! ✅

---

## Disable Hooks (Privacy Mode)

**Why disable?**
- 🔒 **Privacy:** Want manual-only control
- 🐛 **Debug:** Hooks interfering with debugging
- 🚀 **Performance:** Measuring pure performance

**How to disable:**

```bash
# Option 1: Environment variable
export MAMA_DISABLE_HOOKS=true

# Option 2: Configuration file (~/.mama/config.json)
{
  "disable_hooks": true
}
```

**After disabling:**
- No automatic context injection
- Manual commands still work (`/mama-recall`, `/mama-suggest`)
- All data stays local (FR45-49)

---

## Hook Behavior

### UserPromptSubmit Hook

**Triggers:** Every time you send a message to Claude

**What it does:**
1. Takes your prompt
2. Runs semantic search against all decisions
3. Shows gentle hints (not walls of text)
4. Includes tier status banner

**Rate limiting:**
- Max 3 decisions shown
- Only if similarity > 60%
- Recency-weighted (recent decisions prioritized)

**Example output:**
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔍 System Status: 🟢 Tier 1 | Full Features Active | ✓ 89ms | 3 decisions
💡 MAMA: 2 related decisions
   • auth_strategy (85%, 2d ago)
   • database_choice (72%, 1w ago)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### PreToolUse Hook (Future)

**Status:** Planned for Epic M6

**Will trigger:** Before Read/Edit/Grep tools

**Purpose:** Show file-specific decisions

### PostToolUse Hook (Future)

**Status:** Planned for Epic M6

**Will trigger:** After Write/Edit tools

**Purpose:** Suggest saving decisions based on code changes

---

## Privacy Guarantees

**FR Reference:** [FR45-49 (Privacy & Security)](../reference/fr-mapping.md)

- ✅ 100% local processing (no network calls)
- ✅ All data in `~/.claude/mama-memory.db`
- ✅ No telemetry, no tracking
- ✅ Hooks can be disabled anytime

**Learn more:** [Data Privacy Explanation](../explanation/data-privacy.md)

---

## Troubleshooting

**Hooks not firing:**
1. Check hooks enabled (no `MAMA_DISABLE_HOOKS=true`)
2. Verify hook script permissions (`chmod +x scripts/*hook.js`)
3. Test manually: `node ~/.claude/plugins/mama/scripts/userpromptsubmit-hook.js`

**See full guide:** [Troubleshooting - Hooks Not Firing](../guides/troubleshooting.md#hooks-not-firing)

---

## Next Steps

- **Learn hook architecture:** [Hooks Reference](../reference/hooks.md)
- **Understand semantic search:** [Semantic Search Explanation](../explanation/semantic-search.md)
- **Review privacy:** [Data Privacy Explanation](../explanation/data-privacy.md)

---

**Related:**
- [Hooks Reference](../reference/hooks.md)
- [Configuration Guide](../guides/configuration.md)
- [Troubleshooting Guide](../guides/troubleshooting.md)
