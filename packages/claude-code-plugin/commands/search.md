---
description: Search decisions and checkpoints (semantic or list recent)
allowed-tools: Read
argument-hint: '[query] [--type=all|decision|checkpoint] [--limit=10]'
---

# Search MAMA Memory

You are helping the user search decisions and checkpoints from MAMA.

**User Arguments:** `$ARGUMENTS`

## Instructions

1. Parse the user's input:
   - `query` (optional): Search query for semantic search. If empty, list recent items.
   - `--type=X` (optional): Filter by type - 'all' (default), 'decision', 'checkpoint'
   - `--limit=N` (optional): Number of results (default: 10)

2. Use the MCP tool:
   - Call `mcp__plugin_mama_mama__search` with parameters
   - With query: semantic search using embeddings
   - Without query: returns recent items sorted by time

3. Format the response as markdown

## Example Usage

```
/mama:search                              # List recent items
/mama:search auth                         # Semantic search for "auth"
/mama:search "database strategy"          # Semantic search
/mama:search --type=checkpoint            # List recent checkpoints only
/mama:search --type=decision --limit=20   # List 20 recent decisions
```

## Response Format

### With Query (Semantic Search)

```markdown
# Search Results for "{query}"

Found {count} matches:

## 1. {topic} ({similarity}% match)

**Decision:** {decision}
**Reasoning:** {reasoning}
**Outcome:** {outcome} | **Confidence:** {confidence}%
**Created:** {timestamp}

---

**Tip:** Same topic = decision evolution (newer supersedes older)
```

### Without Query (Recent Items)

```markdown
# Recent Items

| Type       | Topic/Summary      | Time        |
| ---------- | ------------------ | ----------- |
| decision   | {topic}: {preview} | 3 hours ago |
| checkpoint | {summary preview}  | 1 day ago   |
| decision   | {topic}: {preview} | 2 days ago  |

---

Use `/mama:search <query>` for semantic search
```

## Important Notes

- **Semantic search**: Uses embeddings for meaning-based matching
- **Topic evolution**: Same topic = new decision supersedes older (LLM infers from time order)
- **Cross-lingual**: Works in Korean and English
- **Unified search**: Searches both decisions and checkpoints
