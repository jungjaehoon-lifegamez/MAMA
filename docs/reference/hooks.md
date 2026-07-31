# Hooks Reference

**MAMA hook system for automatic context injection**

---

## Overview

MAMA provides hooks that integrate with Claude Code's hook system. Hooks use an HTTP embedding server for fast context injection (~150ms).

**Active hooks** (authoritative manifest: `packages/claude-code-plugin/.claude-plugin/plugin.json`):

1. **SessionStart** - Session bootstrap: checkpoint + recent decisions (15s timeout)
2. **PreToolUse** (matcher: `Read`) - MCP search + contract-only injection + Reasoning Summary (5s timeout)
3. **PostToolUse** (matchers: `Write`, `Edit`) - Contract extraction + save guidance (5s timeout)
4. **PreCompact** - Checkpoint before context compaction (10s timeout)

UserPromptSubmit is NOT wired - the sections below document only hooks that exist.

**FR Reference:** [FR19-24 (Hook Integration)](../archive/fr-mapping-v1.0.md) (historical v1.0 artifact)

---

## HTTP Embedding Server

Hooks use an HTTP embedding server running on `127.0.0.1:3849` for fast embedding generation:

- Default owner: `@jungjaehoon/mama-os` (Standalone)
- MCP legacy mode: `MAMA_MCP_START_HTTP_EMBEDDING=true`

- **Model stays in memory**: No 2-9 second model load per hook
- **~50ms embedding requests**: HTTP call to localhost
- **Fallback**: If server unavailable, loads model locally

```bash
# Check if HTTP server is running
curl http://127.0.0.1:3849/health

# Expected response
{"status":"ok","modelLoaded":true,"model":"Xenova/multilingual-e5-large","dim":1024}
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
          "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/pretooluse-hook.js"
        }
      ]
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
      "matcher": "Write",
      "hooks": [
        {
          "type": "command",
          "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/posttooluse-hook.js",
          "timeout": 5
        }
      ]
    },
    {
      "matcher": "Edit",
      "hooks": [
        {
          "type": "command",
          "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/posttooluse-hook.js",
          "timeout": 5
        }
      ]
    }
  ]
}
```

---

## Hook Output Visibility

**Claude Code handles hook output differently by hook type:**

| Hook             | Exit Code | Output Method       | Claude Receives    | User Terminal |
| ---------------- | --------- | ------------------- | ------------------ | ------------- |
| **SessionStart** | 0         | `additionalContext` | ✅ Quiet injection | ❌ Hidden     |
| **PreToolUse**   | 2         | `message` + stderr  | ✅ As error        | Varies        |
| **PostToolUse**  | 2         | `message` + stderr  | ✅ As error        | ✅ Visible    |

**Key differences:**

- **SessionStart**: A special exception in Claude Code that allow quiet context injection via `hookSpecificOutput.additionalContext`
- **PreToolUse/PostToolUse**: Must use `exit(2)` to pass context to Claude; output appears as "blocking error"

**Why exit(2)?**

- `exit(0)`: Claude doesn't receive output (except SessionStart)
- `exit(2)`: Claude receives stderr as error context (only way to pass info)

---

Disabling hooks

There is NO supported kill switch today: `MAMA_DISABLE_HOOKS` is only set
internally by the multi-agent process manager to suppress hooks in Tier-2+
subprocesses, and `~/.mama/config.json` has no `disable_hooks` key. To disable
hooks, remove or disable the plugin itself (Claude Code plugin settings).

## Hook Environment Variables

**Available to all hooks:**

- `$CLAUDE_PLUGIN_ROOT` - Plugin directory path
- `$TOOL_NAME` - Tool being called (Pre/PostToolUse only)
- `$MAMA_DB_PATH` - Database path
- `$MAMA_EMBEDDING_PORT` - HTTP embedding server port (default: 3849)
- `$MAMA_HTTP_PORT` - Legacy alias for embedding port (backward compatibility)

---

## Testing Hooks

```bash
cd ~/.claude/plugins/mama

# Test PreToolUse (Read matcher)
export MAMA_DB_PATH=~/.claude/mama-memory.db
echo '{"tool_name":"Read","tool_input":{"file_path":"src/index.ts"}}' | node scripts/pretooluse-hook.js

# Check HTTP embedding server
curl http://127.0.0.1:3849/health

# Measure hook latency
time (echo '{"tool_name":"Read","tool_input":{"file_path":"src/index.ts"}}' | node scripts/pretooluse-hook.js)
```

---

**Related:**

- [Hook Setup Tutorial](../tutorials/hook-setup.md)
- [Configuration Guide](../guides/configuration.md)
- [Troubleshooting - Hooks Not Firing](../guides/troubleshooting.md#4-hooks-not-firing)
