---
description: List recent decisions with filtering options
allowed-tools: Read
model: claude-3-5-sonnet
argument-hint: "[--limit=20] [--outcome=success] [--since=7d]"
---

# List Recent Decisions from MAMA

You are helping the user list recent decisions from MAMA memory.

**User Arguments:** `$ARGUMENTS`

## Instructions

1. Parse optional filter parameters:
   - `--limit=N` (optional): Number of decisions to show (default: 20, max: 100)
   - `--outcome=X` (optional): Filter by outcome (pending|success|failure|partial|superseded)
   - `--since=X` (optional): Show decisions since (e.g., '7d', '24h', '2025-11-01')
   - `--topic=X` (optional): Filter by topic pattern (e.g., 'mama_*', 'auth*')

2. Use the MCP tool `list_decisions` to retrieve decisions:
   - Call `list_decisions` with limit and optional filters
   - Returns decisions in descending chronological order (newest first)
   - Includes: topic, decision, confidence, outcome, timestamp

3. Format the response as a markdown table:
   - Columns: Topic, Decision (preview), Confidence, Outcome, Time
   - Truncate decision text to ~50 chars
   - Use human-readable time (e.g., "3 hours ago")
   - Add colored outcome badges

## Example Usage

```
/mama-list
/mama-list --limit=50
/mama-list --outcome=success
/mama-list --since=7d --outcome=failure
/mama-list --topic=mama_*
```

## Response Format

Format as a markdown table:

```markdown
# 📋 Recent Decisions (showing {count}/{total})

| Topic | Decision | Confidence | Outcome | Time |
|-------|----------|------------|---------|------|
| auth_strategy | Use JWT with refresh tokens... | 90% | ✅ success | 3 hours ago |
| database_choice | PostgreSQL for relational data... | 85% | ✅ success | 1 day ago |
| test_framework | Vitest for unit testing... | 75% | ⚠️ partial | 2 days ago |
| mama_architecture | MCP Server with dual transport... | 95% | ✅ success | 3 days ago |

---

**Filters Applied:**
- Limit: {limit}
- Outcome: {outcome} (if specified)
- Since: {since} (if specified)
- Topic: {topic_pattern} (if specified)

**Actions:**
- View full history: `/mama-recall <topic>`
- Search for related: `/mama-suggest <query>`
```

## Outcome Badges

Use these visual indicators:
- ✅ success - Decision validated and working
- ⏳ pending - Decision not yet validated
- ❌ failure - Decision failed, changed
- ⚠️ partial - Mixed results
- 🔄 superseded - Replaced by newer decision

## Error Handling

If no decisions match filters:

```
❌ No decisions found matching filters

Applied filters:
- Outcome: {outcome}
- Since: {since}
- Topic: {topic_pattern}

Try:
- Remove filters: /mama-list
- Different outcome: /mama-list --outcome=pending
- Broader time range: /mama-list --since=30d
```

## Important Notes

- **Default sort**: Newest first (DESC by timestamp)
- **Limit cap**: Maximum 100 decisions per request
- **Time formats**: Supports '7d', '24h', '2025-11-01', 'last week'
- **Topic patterns**: Supports wildcards (* and ?)
- **Performance**: ~10ms for list queries (indexed)
