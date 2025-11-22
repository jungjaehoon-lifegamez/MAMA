# @jungjaehoon/mama-server

MCP server for MAMA (Memory-Augmented MCP Assistant) - Tracks decision evolution across your coding sessions.

## What is MAMA?

MAMA remembers why you made decisions, what you tried before, and what didn't work. It stores decisions with semantic search, so relevant context surfaces automatically when you need it.

**Key feature:** Session continuity - save your session state, resume tomorrow with full context.

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

## Available Tools

The MCP server exposes these tools:

- `save_decision` - Save decisions with reasoning and confidence
- `recall_decision` - View full evolution history for a topic
- `suggest_decision` - Semantic search across all decisions
- `list_decisions` - Browse recent decisions chronologically
- `update_outcome` - Update decision outcomes (success/failure/partial)
- `save_checkpoint` - Save session state for later resumption
- `load_checkpoint` - Restore previous session context

## Usage Example

Once configured, use MAMA through your MCP client:

```bash
# Save a decision (in Claude Code)
/mama-save topic="auth_strategy" decision="JWT with refresh tokens" reasoning="Need stateless auth for API scaling"

# Search for related decisions
/mama-suggest "How should I handle authentication?"

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

## Technical Details

- **Database:** SQLite + sqlite-vec extension
- **Embeddings:** Transformers.js (Xenova/all-MiniLM-L6-v2, 384-dim)
- **Transport:** stdio-based MCP protocol
- **Storage:** ~/.claude/mama-memory.db (configurable via MAMA_DB_PATH)
- **Node.js:** >= 18.0.0 required
- **Disk Space:** ~500MB for embedding model cache

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
**Version:** 1.0.1
