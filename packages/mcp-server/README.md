# @jungjaehoon/mama-server

MCP server for MAMA (Memory-Augmented MCP Assistant) - Prevents vibe coding breakage by tracking decisions with reasoning.

## What is MAMA?

MAMA tracks **WHY** you decided (reasoning), not just **WHAT** you chose (facts). When Claude switches between frontend/backend/database, it checks MAMA instead of guessing. No more mismatched schemas or wrong field names.

**Regular memory:** "Login returns token"
**MAMA:** "Login returns `{ userId, token, email }` because frontend needs userId for dashboard (tried just token, users had to refetch)"

## Installation

MAMA works with any MCP-compatible client. Add it to your client's configuration:

### Claude Code

```bash
# Quick install via marketplace
/plugin marketplace add jungjaehoon-lifegamez/claude-plugins
/plugin install mama
```

The plugin automatically uses this MCP server via `npx -y @jungjaehoon/mama-server`.

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mama": {
      "command": "npx",
      "args": ["-y", "@jungjaehoon/mama-server"]
    }
  }
}
```

### Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.mama]
  command = "npx"
  args = ["-y", "@jungjaehoon/mama-server"]
  disabled = false
  disabled_tools = []
```

### Antigravity IDE (Gemini)

Add to `~/.gemini/antigravity/mcp_config.json`:

```json
{
  "mcpServers": {
    "mama": {
      "command": "npx",
      "args": ["-y", "@jungjaehoon/mama-server"],
      "disabled": false,
      "disabledTools": []
    }
  }
}
```

### Other MCP Clients

Any MCP-compatible client can use MAMA with:

```bash
npx -y @jungjaehoon/mama-server
```

## Available Tools (v1.3)

The MCP server exposes 4 core tools:

| Tool              | Description                                                           |
| ----------------- | --------------------------------------------------------------------- |
| `save`            | Save decision (`type='decision'`) or checkpoint (`type='checkpoint'`) |
| `search`          | Semantic search (with `query`) or list recent items (without `query`) |
| `update`          | Update decision outcome (case-insensitive: success/failed/partial)    |
| `load_checkpoint` | Resume previous session                                               |

### Edge Types

Decisions connect through relationships. Include patterns in your reasoning:

| Edge Type     | Pattern                    | Meaning                    |
| ------------- | -------------------------- | -------------------------- |
| `supersedes`  | (automatic for same topic) | Newer replaces older       |
| `builds_on`   | `builds_on: decision_xxx`  | Extends prior work         |
| `debates`     | `debates: decision_xxx`    | Alternative view           |
| `synthesizes` | `synthesizes: [id1, id2]`  | Merges multiple approaches |

## Usage Example

Once configured, use MAMA through your MCP client:

```bash
# Save a decision (in Claude Code)
/mama-save topic="auth_strategy" decision="JWT with refresh tokens" reasoning="Need stateless auth for API scaling"

# Search for related decisions
/mama-suggest "How should I handle authentication?"

**Reasoning Summary (required when presenting search results):**
- Explain *why* results match (tokens/endpoint/field overlap)
- Mark unknowns explicitly (avoid false reasoning)
- State next action (use contract fields; do not guess)

# View decision history
/mama-recall auth_strategy

# Save session before closing
/mama-checkpoint

# Resume next time
/mama-resume
```

## Features

- **Session Continuity** - Save/resume work sessions with full context
- **Decision Evolution** - Track how your thinking changes over time
- **Semantic Search** - Natural language queries find relevant decisions
- **Local-First** - All data stored on your device (~/.claude/mama-memory.db)
- **Multilingual** - Supports English, Korean, and other languages
- **Shared Database** - One database works across all your MCP clients
- **Optional HTTP Embedding Server** - Legacy/standalone-less embedding HTTP mode (opt-in)

## HTTP Embedding Server

The MCP server can expose an HTTP embedding API, but this is now opt-in.

- Default: `stdio` MCP only (no HTTP startup)
- Recommended: run `@jungjaehoon/mama-os` for API/UI (`3847`) + embedding/chat (`3849`)
- Legacy opt-in for MCP HTTP: `MAMA_MCP_START_HTTP_EMBEDDING=true`

When enabled, the HTTP embedding API keeps the model loaded in memory:

```
┌─────────────────────────────────────────────────┐
│              Local Machine                       │
├─────────────────────────────────────────────────┤
│  Claude Code  Claude Desktop  Cursor  Aider     │
│       │            │            │       │        │
│       └────────────┴────────────┴───────┘        │
│                      │                           │
│     ┌────────────────▼────────────────┐         │
│     │  HTTP Embedding Server          │         │
│     │  127.0.0.1:3849                 │         │
│     │  Model stays loaded in memory   │         │
│     └─────────────────────────────────┘         │
└─────────────────────────────────────────────────┘
```

### Endpoints

| Endpoint       | Method | Description                  |
| -------------- | ------ | ---------------------------- |
| `/health`      | GET    | Server status and model info |
| `/embed`       | POST   | Single text embedding        |
| `/embed/batch` | POST   | Batch text embeddings        |

### Usage Examples

Enable legacy MCP-launched HTTP mode when starting MCP server:

```bash
MAMA_MCP_START_HTTP_EMBEDDING=true npx @jungjaehoon/mama-server
```

Then query the HTTP endpoints:

```bash
# Check server health
curl http://127.0.0.1:3849/health

# Generate embedding
curl -X POST http://127.0.0.1:3849/embed \
  -H "Content-Type: application/json" \
  -d '{"text": "How does authentication work?"}'

# Batch embeddings
curl -X POST http://127.0.0.1:3849/embed/batch \
  -H "Content-Type: application/json" \
  -d '{"texts": ["query 1", "query 2", "query 3"]}'
```

### Benefits

- **Fast**: ~50ms embedding requests (vs 2-9 seconds loading model each time)
- **Shared**: Any local LLM client can use this service
- **Optional**: Enable only when you explicitly need MCP-launched HTTP mode
- **Secure**: localhost only (127.0.0.1), no external access

## Graph Viewer

Interactive visualization of your reasoning graph.

**Access:** `http://localhost:3847/viewer` (via Standalone) or `http://localhost:3849/viewer` (legacy MCP HTTP mode)

**Features:**

- Network graph with physics simulation
- Checkpoint timeline sidebar
- Draggable detail panel
- Topic filtering and search

## Environment Variables

| Variable                        | Default                    | Description                                  |
| ------------------------------- | -------------------------- | -------------------------------------------- |
| `MAMA_DB_PATH`                  | `~/.claude/mama-memory.db` | SQLite database location                     |
| `MAMA_EMBEDDING_PORT`           | `3849`                     | Embedding HTTP server port                   |
| `MAMA_HTTP_PORT`                | `3849`                     | Backward-compatible alias for embedding port |
| `MAMA_MCP_START_HTTP_EMBEDDING` | `false`                    | Start embedding HTTP server from MCP process |

## Technical Details

- **Database:** SQLite + sqlite-vec extension
- **Embeddings:** Transformers.js (Xenova/multilingual-e5-small, 384-dim)
- **Transport:** stdio-based MCP protocol (default) + optional HTTP embedding server (port 3849)
- **Storage:** ~/.claude/mama-memory.db (configurable via MAMA_DB_PATH)
- **Port File:** ~/.mama-embedding-port (for client discovery)
- **Node.js:** >= 18.0.0 required
- **Disk Space:** ~500MB for embedding model cache

## Related Packages

- **[@jungjaehoon/mama-os](../standalone/README.md)** - Your AI Operating System with Discord/Slack/Telegram gateway integrations
- **[@jungjaehoon/mama-core](../mama-core/README.md)** - Core library for building custom integrations

## Links

- [GitHub Repository](https://github.com/jungjaehoon-lifegamez/MAMA)
- [Documentation](https://github.com/jungjaehoon-lifegamez/MAMA/tree/main/docs)
- [Issues](https://github.com/jungjaehoon-lifegamez/MAMA/issues)
- [Claude Code Plugin](https://github.com/jungjaehoon-lifegamez/claude-plugins/tree/main/mama)

## License

MIT - see [LICENSE](https://github.com/jungjaehoon-lifegamez/MAMA/blob/main/LICENSE)

## Acknowledgments

MAMA was inspired by [mem0](https://github.com/mem0ai/mem0) (Apache 2.0). While MAMA is a distinct implementation focused on local-first SQLite/MCP architecture, we appreciate their pioneering work in LLM memory management.

---

**Author:** SpineLift Team
**Version:** 1.7.1
