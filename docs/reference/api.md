# MCP Tool API Reference

**MAMA MCP Tools for programmatic access**

---

## Overview

MAMA provides 5 MCP tools for programmatic decision management:

1. `save_decision` - Save a decision
2. `recall_decision` - Recall decision history
3. `suggest_decision` - Semantic search
4. `list_decisions` - List recent decisions
5. `update_outcome` - Update decision outcome

**Transport:** stdio (local)
**Protocol:** Model Context Protocol (MCP) v1.0

---

## Tool: save_decision

Save a decision to MAMA's memory.

**Parameters:**
```typescript
{
  topic: string;              // Required: Decision identifier
  decision: string;           // Required: What was decided
  reasoning: string;          // Required: Why this was decided
  confidence?: number;        // Optional: 0.0-1.0, default 0.5
  outcome?: string;           // Optional: 'pending'|'success'|'failure'|'partial'|'superseded'
  type?: string;              // Optional: 'user_decision'|'assistant_insight'
  failure_reason?: string;    // Optional: Why decision failed
  limitation?: string;        // Optional: Known limitations
}
```

**Returns:**
```typescript
{
  success: boolean;
  decision_id: string;
  topic: string;
  message: string;
}
```

---

## Tool: recall_decision

Recall full decision history for a topic.

**Parameters:**
```typescript
{
  topic: string;  // Required: Topic to recall
}
```

**Returns:**
```typescript
{
  success: boolean;
  topic: string;
  history: Array<{
    decision_id: string;
    decision: string;
    reasoning: string;
    confidence: number;
    outcome: string;
    timestamp: string;
    supersedes?: string[];
  }>;
}
```

---

## Tool: suggest_decision

Semantic search across all decisions.

**Parameters:**
```typescript
{
  userQuestion: string;      // Required: Search query
  recencyWeight?: number;    // Optional: 0-1, default 0.3
  recencyScale?: number;     // Optional: Days, default 7
  recencyDecay?: number;     // Optional: 0-1, default 0.5
}
```

**Returns:**
```typescript
{
  success: boolean;
  suggestions: Array<{
    topic: string;
    decision: string;
    similarity: number;
    recency_days: number;
    final_score: number;
  }>;
}
```

---

## Tool: list_decisions

List recent decisions.

**Parameters:**
```typescript
{
  limit?: number;    // Optional: Max decisions, default 10
  offset?: number;   // Optional: Pagination offset, default 0
}
```

**Returns:**
```typescript
{
  success: boolean;
  list: string;      // Formatted markdown list
  decisions: Array<{
    topic: string;
    decision: string;
    confidence: number;
    outcome: string;
    timestamp: string;
  }>;
}
```

---

## Tool: update_outcome

Update decision outcome.

**Parameters:**
```typescript
{
  topic: string;              // Required: Topic to update
  outcome: string;            // Required: New outcome
  failure_reason?: string;    // Optional: Why it failed
}
```

**Returns:**
```typescript
{
  success: boolean;
  message: string;
}
```

---

## Usage Example

```javascript
// Via MCP SDK
const { MCPClient } = require('@modelcontextprotocol/sdk');

const client = new MCPClient();
await client.connectStdio({
  command: 'node',
  args: ['~/.claude/plugins/mama/src/commands/index.js']
});

const result = await client.callTool('save_decision', {
  topic: 'test_topic',
  decision: 'Use Vitest',
  reasoning: 'Better ESM support',
  confidence: 0.9
});

console.log(result);
```

---

**Related:**
- [Commands Reference](commands.md)
- [Developer Playbook](../development/developer-playbook.md)
- [MCP Server Configuration](configuration-options.md)
