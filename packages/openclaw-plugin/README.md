# @jungjaehoon/openclaw-mama

MAMA Memory Plugin for OpenClaw Gateway - Direct integration without HTTP overhead.

## Features

- **Direct Gateway Integration**: Embeds MAMA logic directly into OpenClaw Gateway
- **4 Native Tools**: `mama_search`, `mama_save`, `mama_load_checkpoint`, `mama_update`
- **Semantic Search**: Vector-based decision retrieval using sqlite-vec
- **Decision Graph**: Track decision evolution with `builds_on`, `debates`, `synthesizes` edges
- **Session Lifecycle Hooks**: Auto-recall at session start, auto-checkpoint at session end
- **Compaction Recovery**: Saves checkpoint before context compression and restores state after

## Installation

### From npm (recommended)

```bash
openclaw plugins install @jungjaehoon/openclaw-mama
```

### From source (development)

```bash
# Clone the repo
git clone https://github.com/jungjaehoon-lifegamez/MAMA.git
cd MAMA

# Install dependencies
pnpm install

# Link plugin for development
ln -s $(pwd)/packages/openclaw-plugin ~/.config/openclaw/extensions/mama

# Restart gateway
systemctl --user restart openclaw-gateway
```

## Configuration

Add to your `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "slots": {
      "memory": "openclaw-mama"
    },
    "entries": {
      "openclaw-mama": {
        "enabled": true
      }
    }
  }
}
```

## Tools

### mama_search

Search semantic memory for relevant past decisions.

```
Query: "authentication strategy"
Returns: Decisions ranked by semantic similarity
```

### mama_save

Save a decision or checkpoint to semantic memory.

```
type: "decision" | "checkpoint"

# For decisions:
topic: "auth_strategy"
decision: "Use JWT with refresh tokens"
reasoning: "More secure than session cookies..."
confidence: 0.8

# For checkpoints:
summary: "Completed auth implementation"
next_steps: "Add rate limiting"
```

### mama_load_checkpoint

Resume previous session by loading the latest checkpoint.

### mama_update

Update outcome of a previous decision.

```
id: "decision_xxx"
outcome: "success" | "failed" | "partial"
reason: "Works well in production"
```

## Session Lifecycle Hooks

MAMA provides comprehensive session memory management through OpenClaw hooks:

| Hook                 | Trigger                    | Action                                    |
| -------------------- | -------------------------- | ----------------------------------------- |
| `session_start`      | Session begins             | Load checkpoint and recent decisions      |
| `before_agent_start` | Before each agent turn     | Inject relevant memories into context     |
| `agent_end`          | After agent completes      | Detect decision patterns (auto-capture)   |
| `session_end`        | Session ends               | Auto-save checkpoint                      |
| `before_compaction`  | Before context compression | Save checkpoint with pre-compaction state |
| `after_compaction`   | After context compression  | Prepare recovery context for next turn    |

### Compaction Recovery (Better than Claude Code)

Unlike Claude Code which only has `PreCompact`, OpenClaw's `after_compaction` hook allows MAMA to:

1. Save a checkpoint before compression
2. Detect when context was compressed
3. Add a recovery note to the next agent turn
4. Help restore working state seamlessly

## Architecture

```
OpenClaw Gateway
└── MAMA Plugin (this package)
    └── @jungjaehoon/mama-core
        ├── mama-api.js (high-level API)
        ├── memory-store.js (SQLite + sqlite-vec)
        └── embeddings.js (Transformers.js)
```

Key design: NO HTTP/REST - MAMA logic is directly embedded into the Gateway for minimal latency (~5ms vs ~180ms with MCP).

## Migration from clawdbot-mama

If upgrading from `@jungjaehoon/clawdbot-mama`:

1. Uninstall old plugin: `openclaw plugins uninstall clawdbot-mama`
2. Install new plugin: `openclaw plugins install @jungjaehoon/openclaw-mama`
3. Update config: Replace `"clawdbot-mama"` with `"openclaw-mama"` in `openclaw.json`

Your decision database (`~/.claude/mama-memory.db`) is preserved.

## Related Packages

- [@jungjaehoon/mama-server](https://www.npmjs.com/package/@jungjaehoon/mama-server) - MCP server for Claude Desktop
- [MAMA Plugin](https://github.com/jungjaehoon-lifegamez/MAMA/tree/main/packages/claude-code-plugin) - Claude Code plugin

## License

MIT
