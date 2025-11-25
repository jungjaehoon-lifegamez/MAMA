---
description: Auto-suggest relevant past decisions based on semantic search
allowed-tools: Read
argument-hint: '<query> [--limit=5] [--recency-weight=0.3]'
---

# Suggest Relevant Decisions from MAMA

You are helping the user find relevant past decisions using semantic search.

**User Arguments:** `$ARGUMENTS`

## Instructions

1. Parse the user's query and optional parameters:
   - `query` (required): User's question or search intent
   - `--limit=N` (optional): Number of suggestions (default: 5)
   - `--recency-weight=N` (optional): 0-1, how much to weight recent items (default: 0.3)
   - `--recency-scale=N` (optional): Days until score drops to decay value (default: 7)
   - `--recency-decay=N` (optional): Score at scale point (default: 0.5)
   - `--disable-recency` (optional): Pure semantic search (no recency boost)

2. Use the MCP tool to perform semantic search:
   - Call `mcp__plugin_mama_mama__suggest_decision` with userQuestion and optional parameters
   - The tool uses vector embeddings + recency weighting + graph expansion
   - Returns top N most relevant decisions

3. Format the response as markdown:
   - Show match percentage (similarity + recency + graph)
   - Include decision preview (topic + snippet)
   - Show recency (e.g., "3 hours ago", "2 days ago")
   - Provide recall command for full details

## Example Usage

```
/mama-suggest "How should I handle authentication?"
/mama-suggest "database migration strategy" --limit=10
/mama-suggest "ONNX runtime crashes" --recency-weight=0.5
/mama-suggest "React performance" --disable-recency
```

## Response Format

Format suggestions like this:

```markdown
# 💡 MAMA Suggestions

🔍 Search method: vector+recency+graph
📊 Graph expansion: {primary} primary + {related} related decisions

Found {count} relevant decisions:

## 1. {topic} (92% match)

"{decision preview...}"
⏰ {recency} | Recency: {recency_score}% | Final: {final_score}%
🔍 `/mama-recall {topic}`

## 2. {topic} (87% match)

"{decision preview...}"
⏰ {recency} | Recency: {recency_score}% | Final: {final_score}%
🔍 `/mama-recall {topic}`

---

**Tip:** Use `/mama-recall {topic}` to see full decision history
```

## Error Handling

If no relevant decisions found:

```
❌ No relevant decisions found for: "{query}"

Try:
- Broader search terms
- List recent decisions: /mama-list
- Check database: /mama-configure
```

## Important Notes

- **Semantic search**: Uses multilingual-e5-small embeddings (Korean-English cross-lingual)
- **Recency boost**: Recent decisions scored higher (configurable)
- **Graph expansion**: Follows supersedes/refines/contradicts edges
- **Hybrid scoring**: Combines similarity (70%) + recency (30%) by default
- **Multilingual**: Works in Korean and English
