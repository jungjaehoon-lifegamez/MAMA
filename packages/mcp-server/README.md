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

## Available Tools

The MCP server exposes 13 tools:

| Tool                             | Description                                                             |
| -------------------------------- | ----------------------------------------------------------------------- |
| `save_decision`                  | Save decision with optional scopes and event_date for temporal tracking |
| `recall_decision`                | Recall decision history by topic, scope-filtered via recallMemory v2    |
| `suggest_decision`               | Semantic search with scopes, strictness controls, and diagnostics       |
| `list_decisions`                 | List recent decisions, scope-filterable                                 |
| `update_outcome`                 | Update decision outcome (case-insensitive: success/failed/partial)      |
| `search_narrative`               | Narrative search with link expansion (depth 0-2)                        |
| `ingest_conversation`            | Ingest conversation messages into memory with optional LLM extraction   |
| `save_checkpoint`                | Save session checkpoint for later resumption                            |
| `load_checkpoint`                | Resume previous session                                                 |
| `generate_quality_report`        | Quality metrics and observability report                                |
| `get_restart_metrics`            | Restart success rate and latency monitoring                             |
| `search_decisions_and_contracts` | Decision + contract lookup for tooling and hook pipelines               |
| `case_timeline_range`            | Read bounded case timeline windows for case-first workflows             |

### Edge Types

Decisions connect through relationships. Include patterns in your reasoning:

| Edge Type     | Pattern                    | Meaning                    |
| ------------- | -------------------------- | -------------------------- |
| `supersedes`  | (automatic for same topic) | Newer replaces older       |
| `builds_on`   | `builds_on: decision_xxx`  | Extends prior work         |
| `debates`     | `debates: decision_xxx`    | Alternative view           |
| `synthesizes` | `synthesizes: [id1, id2]`  | Merges multiple approaches |

### Search Quality Controls

`suggest_decision` accepts optional search-quality parameters for agents and operators:

| Parameter           | Use                                                           |
| ------------------- | ------------------------------------------------------------- |
| `strictness`        | `'recall'`, `'balanced'`, or `'strict'` retrieval mode        |
| `strict`            | Shortcut for strict mode                                      |
| `threshold`         | Override the mode's minimum candidate threshold               |
| `disableRecency`    | Remove recency boosting when relevance matters more than time |
| `includeRelated`    | Include or suppress graph-expanded related hits               |
| `topicPrefix`       | Limit search to a topic namespace                             |
| `minLexicalSupport` | Require independent relevance confirmation                    |
| `diagnostics`       | Return why each result was included or rejected               |
| `scopes`            | Limit search to project/channel/user/global memory scopes     |

Use `strictness: "balanced"` for normal agent work and `strictness: "strict"` when a result will
drive a code change, user-facing answer, or provenance claim.

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

## Environment Variables

| Variable       | Default                    | Description              |
| -------------- | -------------------------- | ------------------------ |
| `MAMA_DB_PATH` | `~/.claude/mama-memory.db` | SQLite database location |

## Technical Details

- **Database:** SQLite + pure-TS cosine similarity
- **Embeddings:** Transformers.js (Xenova/multilingual-e5-large, 1024-dim)
- **Transport:** stdio-based MCP protocol
- **Storage:** ~/.claude/mama-memory.db (configurable via MAMA_DB_PATH)
- **Node.js:** >= 22.13.0 required
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
**Version:** 1.13.0
