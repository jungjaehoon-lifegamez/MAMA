---
description: Save a decision or insight to MAMA's long-term memory
allowed-tools: Read
argument-hint: '<topic> <decision> <reasoning> [--confidence=0.8] [--outcome=pending]'
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

2. Use the MCP tool to save the decision:
   - Call `mcp__plugin_mama_mama__save` with `type='decision'` and the parsed parameters
   - The tool will return a decision_id

3. Format the response as markdown:

   ```
   ✅ Decision Saved Successfully

   **Decision ID:** `{decision_id}`
   **Topic:** `{topic}`

   Search for this decision later:
   `/mama:search {topic}`
   ```

## Example Usage

```
/mama:decision auth_strategy "Use JWT with refresh tokens" "Provides better security than sessions" --confidence=0.9 --outcome=success
```

## Error Handling

If required fields are missing, show this help:

```
Usage: /mama:decision <topic> <decision> <reasoning> [options]

Required:
  topic       Decision topic (e.g., 'auth_strategy')
  decision    What was decided
  reasoning   Why this decision was made

Optional:
  --confidence=N    Confidence 0.0-1.0 (default: 0.5)
  --outcome=X       pending|success|failure|partial|superseded (default: pending)

Examples:
  /mama:decision auth "Use JWT" "Better security" --confidence=0.9
  /mama:decision database "Use PostgreSQL" "Better for our use case" --outcome=success
```

## Important Notes

- **Reasoning is required**: Never save a decision without reasoning
- **Topic naming**: Use lowercase with underscores (e.g., 'mama_architecture')
- **Reuse topics**: Use the SAME topic for related decisions to create evolution graphs
- **Graph connectivity**: Supersedes edges created automatically when same topic reused
