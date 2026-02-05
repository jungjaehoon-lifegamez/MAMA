# Hooks Reference

**MAMA hook system for automatic context injection**

---

## Overview

MAMA provides hooks that integrate with Claude Code's hook system. Hooks use an HTTP embedding server for fast context injection (~150ms).

**Active hooks:**

1. **UserPromptSubmit** - Semantic search on every prompt (~150ms latency)
2. **PreToolUse** - MCP search + contract-only injection + Reasoning Summary
3. **PostToolUse** - Contract extraction + save guidance with structured reasoning

**FR Reference:** [FR19-24 (Hook Integration)](fr-mapping.md)

---

## HTTP Embedding Server

Hooks use an HTTP embedding server running on `127.0.0.1:3847` for fast embedding generation:

- **Model stays in memory**: No 2-9 second model load per hook
- **~50ms embedding requests**: HTTP call to localhost
- **Fallback**: If server unavailable, loads model locally

```bash
# Check if HTTP server is running
curl http://127.0.0.1:3847/health

# Expected response
{"status":"ok","modelLoaded":true,"model":"Xenova/multilingual-e5-small","dim":384}
```

---

## UserPromptSubmit Hook

**Trigger:** Every user message to Claude

**Purpose:** Automatic semantic search and gentle context hints

**Script:** `scripts/userpromptsubmit-hook.js`

**Latency:** ~150ms (with HTTP embedding server)

**Timeout:** 1200ms

**Configuration:**

```json
{
  "UserPromptSubmit": [
    {
      "matcher": "*",
      "hooks": [
        {
          "type": "command",
          "command": "${CLAUDE_PLUGIN_ROOT}/scripts/userpromptsubmit-hook.js"
        }
      ]
    }
  ]
}
```

**Behavior:**

- Reads `$USER_PROMPT` environment variable
- Requests embedding via HTTP server (port 3847)
- Falls back to local model load if HTTP server unavailable
- Runs semantic search (Tier 1) or exact match (Tier 2)
- Shows tier status banner with latency
- Lists top 3 decisions (if similarity > 75%)

**Output:**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔍 System Status: 🟢 Tier 1 | Full Features Active | ✓ 150ms | 3 decisions
💡 MAMA: 2 related decisions
   • auth_strategy (85%, 2d ago)
   • database_choice (72%, 1w ago)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## PreToolUse Hook

**Status:** Enabled

**Trigger:** Before Read/Grep tools

**Purpose:** Contract-first context injection

**Exit Code:** 2 (blocking error) - ensures Claude receives context

**Behavior:**

- Executes MCP search automatically
- Filters to contract-only results
- Emits **Reasoning Summary** grounded in actual matches
- **MANDATORY:** Shows contract creation template when no contracts exist
- Uses `exit(2) + message` to inject context to Claude
- Per-session long/short output to reduce noise

**Output Visibility:**

| Target        | Visible                       |
| ------------- | ----------------------------- |
| Claude        | ✅ (as error context)         |
| User terminal | Varies by Claude Code version |

**Configuration:**

```json
{
  "PreToolUse": [
    {
      "matcher": "Read",
      "hooks": [
        {
          "type": "command",
          "command": "${CLAUDE_PLUGIN_ROOT}/scripts/pretooluse-hook.js"
        }
      ]
    }
  ]
}
```

---

## PostToolUse Hook

**Status:** Enabled

**Trigger:** After Write/Edit tools

**Purpose:** Extract contracts and guide explicit saves

**Exit Code:** 2 (blocking error) - ensures Claude receives context

**Behavior:**

- Reads entire file after Write/Edit (fixes partial content bug)
- Extracts API contracts from code changes
- **MANDATORY:** Shows "Save API Contract NOW" with code template
- Provides save instructions with structured reasoning
- Requires Context/Evidence/Why/Unknowns in reasoning template
- Uses `exit(2) + stderr` to inject context to Claude
- Per-session long/short output to reduce noise

**Output Visibility:**

| Target        | Visible                      |
| ------------- | ---------------------------- |
| Claude        | ✅ (as error context)        |
| User terminal | ✅ (shows as blocking error) |

**Configuration:**

```json
{
  "PostToolUse": [
    {
      "matcher": "Write|Edit",
      "hooks": [
        {
          "type": "command",
          "command": "${CLAUDE_PLUGIN_ROOT}/scripts/posttooluse-hook.js"
        }
      ]
    }
  ]
}
```

---

## Hook Output Visibility

**Claude Code handles hook output differently by hook type:**

| Hook                 | Exit Code | Output Method       | Claude Receives    | User Terminal |
| -------------------- | --------- | ------------------- | ------------------ | ------------- |
| **UserPromptSubmit** | 0         | `additionalContext` | ✅ Quiet injection | ❌ Hidden     |
| **SessionStart**     | 0         | `additionalContext` | ✅ Quiet injection | ❌ Hidden     |
| **PreToolUse**       | 2         | `message` + stderr  | ✅ As error        | Varies        |
| **PostToolUse**      | 2         | `message` + stderr  | ✅ As error        | ✅ Visible    |

**Key differences:**

- **UserPromptSubmit/SessionStart**: Special exceptions in Claude Code that allow quiet context injection via `hookSpecificOutput.additionalContext`
- **PreToolUse/PostToolUse**: Must use `exit(2)` to pass context to Claude; output appears as "blocking error"

**Why exit(2)?**

- `exit(0)`: Claude doesn't receive output (except UserPromptSubmit/SessionStart)
- `exit(2)`: Claude receives stderr as error context (only way to pass info)

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
- `$MAMA_EMBEDDING_PORT` - HTTP embedding server port (default: 3847)

---

## Testing Hooks

```bash
cd ~/.claude/plugins/mama

# Test UserPromptSubmit
export USER_PROMPT="How does authentication work?"
export MAMA_DB_PATH=~/.claude/mama-memory.db
node scripts/userpromptsubmit-hook.js

# Check HTTP embedding server
curl http://127.0.0.1:3847/health

# Measure hook latency
time USER_PROMPT="test prompt" node scripts/userpromptsubmit-hook.js
```

---

**Related:**

- [Hook Setup Tutorial](../tutorials/hook-setup.md)
- [Configuration Guide](../guides/configuration.md)
- [Troubleshooting - Hooks Not Firing](../guides/troubleshooting.md#4-hooks-not-firing)
