# Hooks Reference

**MAMA hook system for automatic context injection**

---

## Overview

MAMA provides 3 hooks that integrate with Claude Code's hook system:

1. **UserPromptSubmit** - Semantic search on every prompt
2. **PreToolUse** - Context before Read/Edit/Grep (planned)
3. **PostToolUse** - Auto-save after Write/Edit (planned)

**FR Reference:** [FR19-24 (Hook Integration)](fr-mapping.md)

---

## UserPromptSubmit Hook

**Trigger:** Every user message to Claude

**Purpose:** Automatic semantic search and gentle context hints

**Script:** `scripts/userpromptsubmit-hook.js`

**Configuration:**
```json
{
  "UserPromptSubmit": [{
    "matcher": "*",
    "hooks": [{
      "type": "command",
      "command": "${CLAUDE_PLUGIN_ROOT}/scripts/userpromptsubmit-hook.js"
    }]
  }]
}
```

**Behavior:**
- Reads `$USER_PROMPT` environment variable
- Runs semantic search (Tier 1) or exact match (Tier 2)
- Shows tier status banner
- Lists top 3 decisions (if similarity > 60%)
- Rate-limited to prevent spam

**Output:**
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔍 System Status: 🟢 Tier 1 | Full Features Active | ✓ 89ms | 3 decisions
💡 MAMA: 2 related decisions
   • auth_strategy (85%, 2d ago)
   • database_choice (72%, 1w ago)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## PreToolUse Hook (Planned)

**Status:** Epic M6

**Trigger:** Before Read/Edit/Grep tools

**Purpose:** Show file-specific decisions

**Configuration:**
```json
{
  "PreToolUse": [{
    "matcher": "Read|Edit|Grep|Glob",
    "hooks": [{
      "type": "command",
      "command": "${CLAUDE_PLUGIN_ROOT}/scripts/pretooluse-hook.js"
    }]
  }]
}
```

---

## PostToolUse Hook (Planned)

**Status:** Epic M6

**Trigger:** After Write/Edit tools

**Purpose:** Suggest saving decisions based on code changes

**Configuration:**
```json
{
  "PostToolUse": [{
    "matcher": "Write|Edit",
    "hooks": [{
      "type": "command",
      "command": "${CLAUDE_PLUGIN_ROOT}/scripts/posttooluse-hook.js"
    }]
  }]
}
```

---

## Disabling Hooks

**Environment variable:**
```bash
export MAMA_DISABLE_HOOKS=true
```

**Configuration file (`~/.mama/config.json`):**
```json
{
  "disable_hooks": true
}
```

---

## Hook Environment Variables

**Available to all hooks:**
- `$CLAUDE_PLUGIN_ROOT` - Plugin directory path
- `$USER_PROMPT` - Current user prompt (UserPromptSubmit only)
- `$TOOL_NAME` - Tool being called (Pre/PostToolUse only)
- `$MAMA_DB_PATH` - Database path

---

## Testing Hooks

```bash
cd ~/.claude/plugins/mama

# Test UserPromptSubmit
export USER_PROMPT="test prompt"
export MAMA_DB_PATH=~/.claude/mama-memory.db
node scripts/userpromptsubmit-hook.js
```

---

**Related:**
- [Hook Setup Tutorial](../tutorials/hook-setup.md)
- [Configuration Guide](../guides/configuration.md)
- [Troubleshooting - Hooks Not Firing](../guides/troubleshooting.md#4-hooks-not-firing)
