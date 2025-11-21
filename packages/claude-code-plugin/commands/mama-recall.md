---
description: Recall full decision history for a specific topic
allowed-tools: Read
model: claude-3-5-sonnet
argument-hint: "<topic>"
---

# Recall Decision History from MAMA

You are helping the user recall the full decision history for a specific topic from MAMA.

**User Arguments:** `$ARGUMENTS`

## Instructions

1. Parse the topic from user's input:
   - `topic` (required): Decision topic to recall (e.g., 'auth_strategy', 'database_choice')

2. Use the MCP tool `recall_decision` to retrieve the decision history:
   - Call `recall_decision` with topic: `$ARGUMENTS`
   - The tool returns all decisions for this topic in chronological order
   - Includes: decision, reasoning, confidence, outcome, timestamps

3. Format the response as markdown:
   - Show decision evolution chronologically
   - Highlight supersedes/refines/contradicts relationships
   - Include confidence scores and outcomes
   - Show timestamps in human-readable format

## Example Usage

```
/mama-recall auth_strategy
/mama-recall mama_architecture
/mama-recall database_migration_plan
```

## Response Format

Format the recalled decisions like this:

```markdown
# Decision History: {topic}

## Decision 1 (3 days ago)
**Decision:** {decision text}
**Reasoning:** {reasoning text}
**Confidence:** {confidence}% | **Outcome:** {outcome}
**Created:** {timestamp}

## Decision 2 (1 day ago) - Supersedes Decision 1
**Decision:** {decision text}
**Reasoning:** {reasoning text}
**Confidence:** {confidence}% | **Outcome:** {outcome}
**Created:** {timestamp}

---

**Total Decisions:** {count}
**Latest Update:** {latest_timestamp}
```

## Error Handling

If topic doesn't exist:

```
❌ No decisions found for topic: {topic}

Try searching for related topics:
/mama-suggest {topic}

Or list recent decisions:
/mama-list
```

## Important Notes

- **Graph traversal**: Shows decision evolution (supersedes/refines/contradicts)
- **Learn/Unlearn/Relearn**: Visible in decision outcomes
- **Same topic reuse**: All decisions with same topic shown together
