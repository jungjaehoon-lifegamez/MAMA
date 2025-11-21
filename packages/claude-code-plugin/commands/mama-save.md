---
description: Save a decision or insight to MAMA's long-term memory
allowed-tools: Read
model: claude-3-5-sonnet
argument-hint: "<topic> <decision> <reasoning> [--confidence=0.8] [--outcome=pending]"
---

# Save Decision to MAMA Memory

You are helping the user save a decision to MAMA (Memory-Augmented MCP Assistant).

**User Arguments:** `$ARGUMENTS`

## Instructions

1. Parse the user's input to extract:
   - `topic` (required): Decision topic identifier (e.g., 'auth_strategy', 'database_choice')
   - `decision` (required): What was decided (e.g., 'Use JWT with refresh tokens')
   - `reasoning` (required): Why this decision was made
   - `confidence` (optional): 0.0-1.0, default 0.5
   - `outcome` (optional): 'pending', 'success', 'failure', 'partial', 'superseded', default 'pending'
   - `type` (optional): 'user_decision' or 'assistant_insight', default 'user_decision'
   - `failure_reason` (optional): Why this decision failed (if outcome='failure')
   - `limitation` (optional): Known limitations of this decision

2. Use the MCP tool `save_decision` to save the decision:
   - Call `save_decision` with the parsed parameters
   - The tool will return a decision_id

3. Format the response as markdown:
   ```
   ✅ Decision Saved Successfully

   **Decision ID:** `{decision_id}`
   **Topic:** `{topic}`

   You can recall this decision later with:
   `/mama-recall {topic}`

   Or search for related decisions:
   `/mama-suggest {topic}`
   ```

## Example Usage

```
/mama-save auth_strategy "Use JWT with refresh tokens" "Provides better security than sessions" --confidence=0.9 --outcome=success
```

## Error Handling

If required fields are missing, show this help:

```
Usage: /mama-save <topic> <decision> <reasoning> [options]

Required:
  topic       Decision topic (e.g., 'auth_strategy')
  decision    What was decided
  reasoning   Why this decision was made

Optional:
  --confidence=N    Confidence 0.0-1.0 (default: 0.5)
  --outcome=X       pending|success|failure|partial|superseded (default: pending)
  --type=X          user_decision|assistant_insight (default: user_decision)
  --failure-reason  Why decision failed (for outcome=failure)
  --limitation      Known limitations

Examples:
  /mama-save auth "Use JWT" "Better security" --confidence=0.9
  /mama-save database "Use PostgreSQL" "Better for our use case" --outcome=success
```

## Important Notes

- **Reasoning is required**: Never save a decision without reasoning
- **Topic naming**: Use lowercase with underscores (e.g., 'mama_architecture')
- **Reuse topics**: Use the SAME topic for related decisions to create evolution graphs
- **Graph connectivity**: Supersedes edges created automatically when same topic reused
