# MAMA MCP API Reference

This document details the Model Context Protocol (MCP) tools provided by the MAMA server.

## Overview

MAMA (Memory-Augmented MCP Assistant) provides **4 core tools** for decision tracking, semantic search, and session continuity.

**Design Principle (v1.3.0):** LLM can infer decision relationships from time-ordered search results. Decisions connect through explicit edge types. Fewer tools = more LLM flexibility.

- **Transport**: Stdio
- **Server Name**: `mama-server`
- **Connection**:
  ```json
  "mama": {
    "command": "npx",
    "args": ["-y", "@jungjaehoon/mama-server"]
  }
  ```

### OpenClaw Plugin

OpenClaw uses the same 4 tools with `mama_` prefix:

| MCP Server        | OpenClaw Plugin        |
| ----------------- | ---------------------- |
| `save`            | `mama_save`            |
| `search`          | `mama_search`          |
| `update`          | `mama_update`          |
| `load_checkpoint` | `mama_load_checkpoint` |

OpenClaw also provides **auto-recall**: relevant decisions are automatically injected on agent start based on user prompt.

## Response Format

All tools return a standard MCP response structure.

### Success

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"success\":true,\"data\":{...}}"
    }
  ]
}
```

### Error

```json
{
  "content": [
    {
      "type": "text",
      "text": "Error: <error_message>"
    }
  ],
  "isError": true
}
```

---

## Tool Catalog (4 Core Tools)

### 1. `save`

Save a decision or checkpoint to MAMA's memory.

**Key Concept:** Same topic = new decision **supersedes** previous, creating an evolution chain.

#### Input Schema

| Field                 | Type   | Required       | Description                                                                 |
| --------------------- | ------ | -------------- | --------------------------------------------------------------------------- |
| `type`                | string | Yes            | `'decision'` or `'checkpoint'`                                              |
| **Decision fields**   |
| `topic`               | string | For decision   | Topic identifier (e.g., 'auth_strategy'). Same topic = supersedes previous. |
| `decision`            | string | For decision   | The decision made                                                           |
| `reasoning`           | string | For decision   | Why this decision was made. Include edge patterns for relationships (v1.3). |
| `confidence`          | number | No             | 0.0-1.0, default 0.5                                                        |
| **Checkpoint fields** |
| `summary`             | string | For checkpoint | Session state: what was done, what's pending                                |
| `next_steps`          | string | No             | Instructions for next session                                               |
| `open_files`          | array  | No             | List of relevant file paths                                                 |

#### Example: Save Decision

```json
{
  "type": "decision",
  "topic": "auth_strategy",
  "decision": "Use JWT with refresh tokens",
  "reasoning": "Need stateless auth for API scaling. Session-based auth failed under load.",
  "confidence": 0.85
}
```

**Response:**

```json
{
  "success": true,
  "id": "decision_auth_strategy_1732530000_abc",
  "type": "decision",
  "message": "Decision saved: auth_strategy"
}
```

#### Example: Save Checkpoint

```json
{
  "type": "checkpoint",
  "summary": "Refactoring auth module. JWT validation working, refresh flow TODO.",
  "next_steps": "1. Implement refresh token rotation\n2. Add token expiration handling\n3. Update tests",
  "open_files": ["src/auth/jwt.ts", "src/middleware/auth.ts", "tests/auth.test.ts"]
}
```

**Response:**

```json
{
  "success": true,
  "id": "checkpoint_3",
  "type": "checkpoint",
  "message": "Checkpoint saved"
}
```

---

### 2. `search`

Search decisions and checkpoints. Semantic search with query, or list recent items without query.

#### Input Schema

| Field   | Type   | Required | Description                                           |
| ------- | ------ | -------- | ----------------------------------------------------- |
| `query` | string | No       | Search query. If empty, returns recent items by time. |
| `type`  | string | No       | `'all'` (default), `'decision'`, or `'checkpoint'`    |
| `limit` | number | No       | Maximum results, default 10                           |

#### Example: Semantic Search

```json
{
  "query": "authentication approach",
  "limit": 5
}
```

**Response:**

```json
{
  "success": true,
  "count": 3,
  "results": [
    {
      "id": "decision_auth_strategy_1732530000_abc",
      "topic": "auth_strategy",
      "decision": "Use JWT with refresh tokens",
      "reasoning": "Need stateless auth for API scaling",
      "confidence": 0.85,
      "created_at": 1732530000,
      "_type": "decision",
      "similarity": 0.87
    },
    ...
  ]
}
```

#### Example: List Recent Items

```json
{
  "type": "all",
  "limit": 10
}
```

Returns decisions and checkpoints sorted by time (newest first).

---

### 3. `update`

Update an existing decision's outcome. Use after trying a decision to track what worked.

#### Input Schema

| Field     | Type   | Required | Description                                                           |
| --------- | ------ | -------- | --------------------------------------------------------------------- |
| `id`      | string | Yes      | Decision ID to update                                                 |
| `outcome` | string | Yes      | Case-insensitive: `success`, `SUCCESS`, `failed`, `FAILED`, `partial` |
| `reason`  | string | No       | Why it succeeded/failed/was partial                                   |

#### Example: Mark Success

```json
{
  "id": "decision_auth_strategy_1732530000_abc",
  "outcome": "success"
}
```

#### Example: Mark Failure

```json
{
  "id": "decision_caching_strategy_1732520000_def",
  "outcome": "failure",
  "reason": "Redis cluster added too much operational complexity"
}
```

**Response:**

```json
{
  "success": true,
  "message": "Updated decision_auth_strategy_1732530000_abc -> success"
}
```

---

### 4. `load_checkpoint`

Load the latest checkpoint to resume a previous session. Use at session start.

#### Input Schema

No parameters required.

#### Example

```json
{}
```

**Response:**

```json
{
  "success": true,
  "checkpoint": {
    "id": 3,
    "summary": "Refactoring auth module. JWT validation working, refresh flow TODO.",
    "next_steps": "1. Implement refresh token rotation...",
    "open_files": ["src/auth/jwt.ts", "src/middleware/auth.ts"],
    "timestamp": 1732530000
  }
}
```

---

## Usage Patterns

### Decision Evolution Tracking

Save multiple decisions with the same topic to track how your thinking evolved:

```javascript
// Initial decision
save({
  type: 'decision',
  topic: 'caching',
  decision: 'Use Redis',
  reasoning: 'Fast in-memory cache',
});

// Later, after issues
save({
  type: 'decision',
  topic: 'caching',
  decision: 'Switch to local LRU cache',
  reasoning: 'Redis added too much ops burden',
});

// Search shows evolution
search({ query: 'caching strategy' });
// Returns both decisions, newest first - LLM can infer the evolution
```

### Session Continuity

```javascript
// End of session
save({
  type: 'checkpoint',
  summary: 'Working on auth refactor. JWT done, refresh TODO.',
  next_steps: 'Test refresh token flow',
  open_files: ['src/auth/jwt.ts'],
});

// Next session
load_checkpoint();
// Returns context to resume work
```

### Learning from Outcomes

```javascript
// After trying a decision
update({
  id: 'decision_caching_1732530000_abc',
  outcome: 'failure',
  reason: 'Redis cluster too complex for our team size',
});

// Future searches will show this outcome
search({ query: 'caching' });
// Results include outcome status - LLM learns what worked
```

---

## Environment Variables

```bash
# Database location (default: ~/.claude/mama-memory.db)
export MAMA_DB_PATH="$HOME/.claude/mama-memory.db"

# Server token (for development)
export MAMA_SERVER_TOKEN="dev-token"

# Server port (default: 3000)
export MAMA_SERVER_PORT="3000"

# Embedding server port (default: 3849)
export MAMA_EMBEDDING_PORT="3849"
```

---

## HTTP API Endpoints (v1.5)

MAMA provides HTTP endpoints for web-based interfaces like the Graph Viewer and Mobile Chat.

**Base URL:** `http://localhost:3847` (API/UI, configurable via `MAMA_SERVER_PORT`)

**Embedding URL:** `http://127.0.0.1:3849` (configurable via `MAMA_EMBEDDING_PORT`, legacy alias: `MAMA_HTTP_PORT`)

**Compatibility:**

| Feature         | Claude Code Plugin | Claude Desktop (MCP) |
| --------------- | ------------------ | -------------------- |
| HTTP Endpoints  | ✅                 | ✅                   |
| Graph Viewer    | ✅                 | ✅                   |
| **Mobile Chat** | ✅                 | ❌                   |

**Note:** Mobile Chat requires Claude Code CLI (`claude` command). Claude Desktop only has MCP servers and cannot spawn CLI subprocesses for chat sessions. Graph Viewer works in both environments.

### Checkpoint API

#### POST /api/checkpoint/save

Save a session checkpoint for later resumption.

**Request:**

```json
{
  "summary": "Implemented auth module, blocked on rate limiter design",
  "open_files": ["src/auth/jwt.js", "tests/auth.test.js"],
  "next_steps": "1. Research token bucket vs leaky bucket\n2. Check Redis compatibility"
}
```

**Response:**

```json
{
  "success": true,
  "id": 100,
  "message": "Checkpoint saved successfully"
}
```

#### GET /api/checkpoint/load

Load the latest active checkpoint.

**Response:**

```json
{
  "success": true,
  "checkpoint": {
    "id": 100,
    "timestamp": 1732530000000,
    "summary": "Implemented auth module, blocked on rate limiter design",
    "open_files": ["src/auth/jwt.js", "tests/auth.test.js"],
    "next_steps": "1. Research token bucket...",
    "status": "active"
  }
}
```

**Error (404):**

```json
{
  "error": true,
  "code": "NO_CHECKPOINT",
  "message": "No checkpoint found"
}
```

### MAMA Search API

#### GET /api/mama/search

Semantic search for decisions (used by Memory tab).

**Query Parameters:**

- `q` (required): Search query
- `limit` (optional): Max results (default: 10, max: 20)

**Response:**

```json
{
  "query": "authentication",
  "results": [
    {
      "id": "decision_auth_strategy_1732530000_abc",
      "topic": "auth_strategy",
      "decision": "Use JWT with refresh tokens",
      "reasoning": "Need stateless auth for API scaling...",
      "similarity": 0.87,
      "created_at": 1732530000000
    }
  ],
  "count": 1
}
```

#### POST /api/mama/save

Save a decision from mobile interface.

**Request:**

```json
{
  "topic": "auth_strategy",
  "decision": "Use JWT with refresh tokens",
  "reasoning": "Need stateless auth for API scaling",
  "confidence": 0.8
}
```

**Response:**

```json
{
  "success": true,
  "id": "decision_auth_strategy_1732530000_abc",
  "message": "Decision saved successfully"
}
```

### Graph API

#### GET /graph

Get decision graph data (nodes + edges).

**Query Parameters:**

- `topic` (optional): Filter by topic
- `cluster` (optional): Include similarity edges (true/false)

**Response:**

```json
{
  "nodes": [
    /* decision objects */
  ],
  "edges": [
    /* edge objects */
  ],
  "similarityEdges": [
    /* similarity edges if cluster=true */
  ],
  "meta": {
    "total_nodes": 42,
    "total_edges": 38,
    "topics": ["auth_strategy", "caching_strategy"]
  },
  "latency": 45
}
```

#### GET /graph/similar

Find similar decisions to a given decision.

**Query Parameters:**

- `id` (required): Decision ID

**Response:**

```json
{
  "id": "decision_auth_strategy_1732530000_abc",
  "similar": [
    {
      "id": "decision_session_mgmt_1732540000_def",
      "topic": "session_management",
      "decision": "Redis for session storage",
      "similarity": 0.82
    }
  ],
  "count": 1
}
```

#### POST /graph/update

Update decision outcome (used by Graph Viewer).

**Request:**

```json
{
  "id": "decision_auth_strategy_1732530000_abc",
  "outcome": "success",
  "reason": "JWT auth scaled to 10k users without issues"
}
```

**Response:**

```json
{
  "success": true,
  "id": "decision_auth_strategy_1732530000_abc",
  "outcome": "SUCCESS"
}
```

### Code-Act API

#### POST /api/code-act

Execute JavaScript code in a sandboxed QuickJS environment with access to gateway tools.

**Authentication:** Requires `MAMA_AUTH_TOKEN` if set.

**Request:**

```json
{
  "code": "const result = await Read('/path/to/file'); return result;",
  "timeout": 30000
}
```

| Field     | Type   | Required | Description                                          |
| --------- | ------ | -------- | ---------------------------------------------------- |
| `code`    | string | Yes      | JavaScript code to execute                           |
| `timeout` | number | No       | Execution timeout in ms (default: 30000, max: 60000) |

**Response:**

```json
{
  "success": true,
  "result": { "content": "file contents..." },
  "duration": 245
}
```

**Security:** Code runs in a QuickJS sandbox (not Node.js). Only Tier 3 (read-only) gateway tools are available. No `require()`, no `process`, no `fs` access.

### Slack API

#### POST /api/slack/send

Send a message to a Slack channel. Requires Slack bot to be configured.

**Request:**

```json
{
  "channel_id": "C01234567",
  "message": "Hello from MAMA!",
  "file_path": "/path/to/attachment.png"
}
```

| Field        | Type   | Required | Description          |
| ------------ | ------ | -------- | -------------------- |
| `channel_id` | string | Yes      | Slack channel ID     |
| `message`    | string | No       | Text message to send |
| `file_path`  | string | No       | File to upload       |

**Response:**

```json
{
  "success": true,
  "message": "Message sent to Slack channel C01234567"
}
```

### Daemon Logs API

#### GET /api/daemon/logs

Retrieve daemon log file contents with pagination support.

**Query Parameters:**

| Field    | Type   | Required | Description                                         |
| -------- | ------ | -------- | --------------------------------------------------- |
| `lines`  | number | No       | Number of lines to return (default: 100, max: 1000) |
| `offset` | number | No       | Line offset from end of file                        |

**Response:**

```json
{
  "success": true,
  "lines": ["[2026-02-22 10:00:00] Starting MAMA OS...", "..."],
  "total": 5420,
  "offset": 0
}
```

### Viewer Routes

| Route     | Description                   |
| --------- | ----------------------------- |
| `/viewer` | Graph Viewer + Mobile Chat UI |
| `/graph`  | Graph data API                |
| `/`       | Redirects to `/viewer`        |

---

## Edge Types (v1.3)

Decisions connect through explicit relationships. Include patterns in the `reasoning` field:

| Edge Type     | Pattern in Reasoning                    | Meaning                      |
| ------------- | --------------------------------------- | ---------------------------- |
| `supersedes`  | (automatic for same topic)              | Newer version replaces older |
| `builds_on`   | `builds_on: decision_xxx`               | Extends prior work           |
| `debates`     | `debates: decision_xxx`                 | Presents alternative view    |
| `synthesizes` | `synthesizes: [decision_a, decision_b]` | Merges multiple approaches   |

### Example: Decision with Edge

```json
{
  "type": "decision",
  "topic": "auth_v2",
  "decision": "Add OAuth2 support alongside JWT",
  "reasoning": "builds_on: decision_auth_strategy_1732530000_abc. Need social login for user growth while keeping API auth."
}
```

Edges are auto-detected and appear in search results with `related_to` and `edge_reason` fields.

---

## Migration from v1.1

If upgrading from v1.1 (11 tools) to v1.2+ (4 tools):

| Old Tool            | New Equivalent                           |
| ------------------- | ---------------------------------------- |
| `save_decision`     | `save` with `type='decision'`            |
| `save_checkpoint`   | `save` with `type='checkpoint'`          |
| `recall_decision`   | `search` with `query=<topic>`            |
| `suggest_decision`  | `search` with `query=<question>`         |
| `list_decisions`    | `search` without query                   |
| `update_outcome`    | `update`                                 |
| `load_checkpoint`   | `load_checkpoint` (unchanged)            |
| `propose_link`      | Removed - use edge patterns in reasoning |
| `approve_link`      | Removed                                  |
| `reject_link`       | Removed                                  |
| `get_pending_links` | Removed                                  |

---

**Last Updated:** 2026-02-22
**Version:** 0.10.0
