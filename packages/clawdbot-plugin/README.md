# @jungjaehoon/clawdbot-mama

MAMA Memory Plugin for Clawdbot Gateway - Direct integration without HTTP overhead.

## Features

- **Direct Gateway Integration**: Embeds MAMA logic directly into Clawdbot Gateway
- **4 Native Tools**: `mama_search`, `mama_save`, `mama_load_checkpoint`, `mama_update`
- **Semantic Search**: Vector-based decision retrieval using sqlite-vec
- **Decision Graph**: Track decision evolution with `builds_on`, `debates`, `synthesizes` edges

## Installation

### From npm (recommended)

```bash
clawdbot plugins install @jungjaehoon/clawdbot-mama
```

### From source (development)

```bash
# Clone the repo
git clone https://github.com/jungjaehoon-lifegamez/MAMA.git
cd MAMA

# Install dependencies
pnpm install

# Link plugin for development
ln -s $(pwd)/packages/clawdbot-plugin ~/.config/clawdbot/extensions/mama

# Restart gateway
systemctl --user restart clawdbot-gateway
```

## Configuration

Add to your `~/.clawdbot/clawdbot.json`:

```json
{
  "plugins": {
    "slots": {
      "memory": "mama"
    },
    "entries": {
      "mama": {
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

## Architecture

```
Clawdbot Gateway
└── MAMA Plugin (this package)
    └── @jungjaehoon/mama-server
        ├── mama-api.js (high-level API)
        ├── memory-store.js (SQLite + sqlite-vec)
        └── embeddings.js (Transformers.js)
```

Key design: NO HTTP/REST - MAMA logic is directly embedded into the Gateway for minimal latency (~5ms vs ~180ms with MCP).

## Related Packages

- [@jungjaehoon/mama-server](https://www.npmjs.com/package/@jungjaehoon/mama-server) - MCP server for Claude Desktop
- [MAMA Plugin](https://github.com/jungjaehoon-lifegamez/MAMA/tree/main/packages/claude-code-plugin) - Claude Code plugin

## License

MIT
