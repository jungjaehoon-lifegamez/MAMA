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

# Server port (default: 3847)
export MAMA_SERVER_PORT="3847"

# Embedding server port (default: 3849)
export MAMA_EMBEDDING_PORT="3849"
```

---

## HTTP API Endpoints (v0.10.0)

MAMA OS provides **60 HTTP endpoints** for the web dashboard, mobile chat, and programmatic access.

**Base URL:** `http://localhost:3847` (configurable via `MAMA_SERVER_PORT`)

**Embedding URL:** `http://127.0.0.1:3849` (configurable via `MAMA_EMBEDDING_PORT`)

**Compatibility:**

| Feature         | MAMA OS | Claude Desktop (MCP) |
| --------------- | ------- | -------------------- |
| HTTP Endpoints  | ✅      | ✅                   |
| Graph Viewer    | ✅      | ✅                   |
| **Mobile Chat** | ✅      | ❌                   |

---

### Health

#### GET /health

Basic health check.

**Response:** `{ "status": "ok", "timestamp": 1732530000 }`

#### GET /api/health

Graph API health check.

**Response:** `{ "status": "ok", "service": "MAMA Graph API" }`

---

### Checkpoint API

#### POST /api/checkpoint/save

Save a session checkpoint.

**Request:**

```json
{
  "summary": "Implemented auth module, blocked on rate limiter design",
  "open_files": ["src/auth/jwt.js"],
  "next_steps": "1. Research token bucket vs leaky bucket"
}
```

**Response:** `{ "success": true, "id": 3, "message": "Checkpoint saved successfully" }`

#### GET /api/checkpoint/load

Load the latest active checkpoint.

**Response:** `{ "success": true, "checkpoint": { "id": 3, "timestamp": 1732530000000, "summary": "...", "open_files": [...], "next_steps": "...", "status": "active" } }`

> **Note:** The MCP `load_checkpoint` tool returns `timestamp` in seconds (Unix epoch), while the HTTP API returns milliseconds. The `id` field is a numeric integer in both APIs.

**Error (404):** `{ "error": true, "code": "NO_CHECKPOINT", "message": "No checkpoint found" }`

#### GET /checkpoints

List all checkpoints (alias: `GET /api/checkpoints`).

---

### Memory API

#### GET /api/mama/search

Semantic search for decisions (alias: `GET /api/search`).

**Query Parameters:** `q` (required), `limit` (optional, default: 10, max: 20)

**Response:** `{ "query": "...", "results": [...], "count": 1 }`

#### POST /api/mama/save

Save a decision (alias: `POST /api/save`).

**Request:** `{ "topic": "auth_strategy", "decision": "Use JWT", "reasoning": "...", "confidence": 0.8 }`

**Response:** `{ "success": true, "id": "decision_auth_strategy_...", "message": "Decision saved successfully" }`

#### GET /api/memory/export

Export decisions as CSV or JSON.

**Query Parameters:** `format` (`csv` | `json`, default: `json`)

---

### Graph API

#### GET /graph

Decision graph data (alias: `GET /api/graph`).

**Query Parameters:** `topic` (optional), `cluster` (optional, true/false)

**Response:** `{ "nodes": [...], "edges": [...], "similarityEdges": [...], "meta": { "total_nodes": 42, "total_edges": 38, "topics": [...] }, "latency": 45 }`

#### GET /graph/similar

Find similar decisions.

**Query Parameters:** `id` (required)

**Response:** `{ "id": "...", "similar": [{ "id": "...", "similarity": 0.82 }], "count": 1 }`

#### POST /graph/update

Update decision outcome (alias: `POST /api/update`).

**Request:** `{ "id": "decision_...", "outcome": "success", "reason": "..." }`

**Response:** `{ "success": true, "id": "...", "outcome": "SUCCESS" }`

---

### Cron API

#### GET /api/cron

List all scheduled jobs.

**Response:** `{ "jobs": [{ "id": "job_...", "name": "...", "cron_expr": "0 * * * *", "prompt": "...", "enabled": true, "next_run": 1732530000 }] }`

#### POST /api/cron

Create a new scheduled job.

**Request:**

```json
{
  "name": "Hourly market check",
  "cron_expr": "0 * * * *",
  "prompt": "Check crypto prices and report",
  "enabled": true
}
```

| Field       | Type    | Required | Description                           |
| ----------- | ------- | -------- | ------------------------------------- |
| `name`      | string  | Yes      | Job name                              |
| `cron_expr` | string  | Yes      | Cron expression                       |
| `prompt`    | string  | Yes      | Prompt to execute                     |
| `enabled`   | boolean | No       | Whether job is active (default: true) |

**Response:** `{ "id": "job_...", "created": true }`

#### GET /api/cron/:id

Get a specific job.

**Response:** `{ "job": { ... } }`

#### PUT /api/cron/:id

Update a job.

**Request:** `{ "name": "...", "cron_expr": "...", "prompt": "...", "enabled": false }`

All fields are optional.

**Response:** `{ "updated": true }`

#### DELETE /api/cron/:id

Delete a job.

**Response:** `{ "deleted": true }`

#### POST /api/cron/:id/run

Run a job immediately (async).

**Response:** `{ "execution_id": "exec_...", "started": true }`

#### GET /api/cron/:id/logs

Get execution logs for a job.

**Query Parameters:** `limit` (default: 20), `offset` (default: 0)

**Response:** `{ "logs": [{ "id": "...", "started_at": 1732530000, "finished_at": 1732530060, "status": "success", "output": "...", "error": null }] }`

---

### Skills API

#### GET /api/skills

List all installed skills.

**Response:** `{ "skills": [...] }`

#### GET /api/skills/catalog

Remote skill catalog.

**Query Parameters:** `source` (`all` | `mama` | `cowork` | `external`, default: `all`)

#### GET /api/skills/search

Search skills.

**Query Parameters:** `q` (required), `source` (optional)

**Response:** `{ "skills": [...] }`

#### POST /api/skills/install

Install a skill from catalog.

**Request:** `{ "source": "cowork", "name": "skill-name" }`

#### POST /api/skills/install-url

Install from GitHub URL.

**Request:** `{ "url": "https://github.com/user/repo/..." }`

#### POST /api/skills

Create a new skill with content.

**Request:** `{ "name": "my-skill", "content": "# Skill content...", "source": "mama" }`

**Response (201):** `{ "success": true, ... }`

#### PUT /api/skills/:name/content

Update skill file content.

**Request:** `{ "content": "# Updated content...", "source": "mama" }`

#### PUT /api/skills/:name

Toggle skill enabled/disabled.

**Request:** `{ "enabled": false, "source": "mama" }`

**Response:** `{ "updated": true }`

#### DELETE /api/skills/:name

Uninstall a skill.

**Query Parameters:** `source` (default: `mama`)

**Response:** `{ "deleted": true }`

#### GET /api/skills/:name/readme

Get SKILL.md content.

**Query Parameters:** `source` (default: `mama`)

**Response:** `{ "content": "# Skill documentation..." }`

---

### Token Usage API

#### GET /api/tokens/summary

Token usage summary: today, 7-day, 30-day totals.

**Response:**

```json
{
  "today": { "input_tokens": 5000, "output_tokens": 3000, "cache_read_tokens": 1000, "cost_usd": 0.05, "request_count": 10 },
  "week": { ... },
  "month": { ... }
}
```

#### GET /api/tokens/by-agent

Per-agent token totals (last 30 days).

**Response:** `{ "agents": [{ "agent_id": "developer", "input_tokens": 50000, "output_tokens": 30000, ... }] }`

#### GET /api/tokens/daily

Daily token breakdown.

**Query Parameters:** `days` (default: 30, max: 90)

**Response:** `{ "daily": [{ "date": "2026-02-22", "input_tokens": 5000, ... }], "days": 30 }`

---

### Heartbeat API

#### GET /api/heartbeat

Get heartbeat status.

**Response:** `{ "status": "active", "active_jobs": 3, "last_execution": { "id": "heartbeat_...", "started_at": 1732530000, "status": "success" } }`

#### POST /api/heartbeat

Trigger manual heartbeat.

**Request:** `{ "prompt": "Generate status report" }` (optional, uses default prompt if omitted)

**Response:** `{ "execution_id": "heartbeat_...", "started": true }`

---

### Upload & Media API

#### POST /api/upload

Upload a file (multipart form, field name: `file`). Rate limited: 10 uploads/minute.

**Allowed types:** JPEG, PNG, GIF, WebP, SVG, PDF, TXT, CSV, Markdown, HTML, JSON, Office docs, ZIP

**Max size:** 20MB (images >500KB auto-compressed)

**Response:** `{ "success": true, "filename": "1732530000_photo.png", "mediaUrl": "/api/media/1732530000_photo.png", "size": 245000, "contentType": "image/png" }`

#### GET /api/media/:filename

Serve uploaded/outbound media file (inline). SVG/HTML/XML are force-downloaded to prevent XSS.

#### GET /api/media/download/:filename

Force-download a media file.

---

### Discord API

#### POST /api/discord/send

Send a text message to a Discord channel.

**Request:** `{ "channelId": "123456789", "message": "Hello!" }`

#### POST /api/discord/cron

Run an agent prompt and send result to Discord.

**Request:** `{ "channelId": "123456789", "prompt": "Generate daily report" }`

**Response:** `{ "success": true, "response": "..." }`

#### POST /api/discord/image

Send an image file to Discord (4-layer path security).

**Request:** `{ "channelId": "123456789", "imagePath": "media/outbound/chart.png", "caption": "Daily chart" }`

**Allowed paths:** Workspace, workspace/temp, /tmp only. Image extensions only (.png, .jpg, .jpeg, .gif, .webp).

#### POST /api/report

Generate heartbeat report via agent and send to Discord.

**Request:** `{ "channelId": "123456789", "reportType": "delta" }` (`delta` | `full`)

#### POST /api/screenshot

Take HTML screenshot and send to Discord.

**Request:** `{ "channelId": "123456789", "htmlFile": "reports/chart.html", "caption": "Chart" }`

**Security:** Relative paths only, must be within workspace directory.

### Slack API

#### POST /api/slack/send

Send a message or file to a Slack channel.

**Request:**

```json
{
  "channelId": "C01234567",
  "message": "Hello from MAMA!",
  "filePath": "/path/to/attachment.png",
  "caption": "Check this out"
}
```

| Field       | Type   | Required | Description                                    |
| ----------- | ------ | -------- | ---------------------------------------------- |
| `channelId` | string | Yes      | Slack channel ID                               |
| `message`   | string | No       | Text message to send                           |
| `filePath`  | string | No       | File to upload (workspace, temp, or /tmp only) |
| `caption`   | string | No       | Caption for file upload                        |

---

### Session API

#### GET /api/sessions/last-active

Return the most recently active session.

**Response:** `{ "session": { ... } }` or `{ "session": null }`

#### GET /api/sessions

List sessions by gateway type.

**Response:** `{ "viewer": [...], "discord": [...], "telegram": [...], "slack": [...] }`

---

### Code-Act API

#### POST /api/code-act

Execute JavaScript in a sandboxed QuickJS environment.

**Authentication:** Requires `MAMA_AUTH_TOKEN` if set.

**Request:**

```json
{
  "code": "const result = await Read('/path/to/file');\nresult;",
  "timeout": 30000
}
```

| Field     | Type   | Required | Description                                                                                                            |
| --------- | ------ | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `code`    | string | Yes      | JavaScript code to execute (evaluated as a script, not wrapped in a function — use expression at end for return value) |
| `timeout` | number | No       | Execution timeout in ms (default: 30000, max: 60000)                                                                   |

**Response:** `{ "success": true, "result": { ... }, "duration": 245 }`

**Security:** QuickJS WASM sandbox. Only Tier 3 (read-only) tools available. No `require()`, `process`, `fs`.

---

### Multi-Agent API

#### GET /api/multi-agent/status

Get multi-agent system status.

#### GET /api/multi-agent/agents

List all agent configs.

#### PUT /api/multi-agent/agents/:id

Update a specific agent's config.

**Request:**

```json
{
  "backend": "claude",
  "model": "claude-opus-4-5-20251101",
  "tier": 1,
  "enabled": true,
  "can_delegate": true
}
```

All fields optional. See [CLAUDE.md Multi-Agent API](../../CLAUDE.md#multi-agent-api) for details.

#### GET /api/multi-agent/delegations

Get recent task delegations / swarm tasks.

---

### Config API

#### GET /api/config

Get current MAMA configuration.

#### PUT /api/config

Update MAMA configuration.

**Request:** Partial config object to merge.

#### GET /api/dashboard/status

Dashboard status: gateways, memory stats, config summary.

#### POST /api/restart

Graceful restart. **Requires authentication.**

---

### MCP Servers API

#### GET /api/mcp-servers

List MCP servers from config.

#### DELETE /api/mcp-servers/:name

Remove an MCP server from config.

---

### Daemon Logs API

#### GET /api/logs/daemon

Read daemon.log with tail support.

**Query Parameters:**

| Field   | Type   | Required | Description                                        |
| ------- | ------ | -------- | -------------------------------------------------- |
| `tail`  | number | No       | Number of lines from end (default: 200, max: 5000) |
| `since` | number | No       | mtime threshold (ms) — returns 304 if unchanged    |

**Response:**

```json
{
  "lines": ["[2026-02-22 10:00:00] Starting MAMA OS...", "..."],
  "total": 5420,
  "totalBytes": 1234567,
  "mtime": 1732530000000,
  "truncated": false
}
```

---

### Playground API

#### GET /api/playgrounds

List playground HTML files from index.json.

**Response:** `[{ "name": "Skill Lab", "slug": "skill-lab", "description": "...", "created_at": "2026-02-22T..." }]`

#### DELETE /api/playgrounds/:slug

Delete a playground HTML file.

**Response:** `{ "success": true }`

---

### Workspace Skills API

#### GET /api/workspace/skills

List installed skill directories in workspace.

**Response:** `{ "skills": [{ "id": "market-monitor" }] }`

#### GET /api/workspace/skills/:name/content

Read SKILL.md content for a workspace skill.

**Response:** `{ "content": "# Skill content..." }`

---

### Viewer Routes

| Route     | Description                   |
| --------- | ----------------------------- |
| `/viewer` | Graph Viewer + Mobile Chat UI |
| `/graph`  | Graph data API                |
| `/setup`  | Setup wizard                  |
| `/`       | Redirects to `/viewer`        |

### Route Aliases

| Alias                  | Canonical                                       |
| ---------------------- | ----------------------------------------------- |
| `GET /api/graph`       | `GET /graph`                                    |
| `GET /api/search`      | `GET /api/mama/search` (converts `query` → `q`) |
| `POST /api/save`       | `POST /api/mama/save`                           |
| `POST /api/update`     | `POST /graph/update`                            |
| `GET /api/checkpoints` | `GET /checkpoints`                              |

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
