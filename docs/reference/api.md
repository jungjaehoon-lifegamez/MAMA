# MAMA MCP API Reference

This document details the Model Context Protocol (MCP) tools provided by the MAMA server.

## Overview

MAMA (Memory-Augmented MCP Assistant) provides a set of tools for decision tracking, semantic search, and session continuity.

- **Transport**: Stdio
- **Server Name**: `mama-server`
- **Connection**:
  ```json
  "mama": {
    "command": "npx",
    "args": ["-y", "@jungjaehoon/mama-server"],
    "env": { ... }
  }
  ```

## Response Format

All tools return a standard MCP response structure.

### Success

The actual data is often JSON-stringified within the text content to support complex structures over stdio.

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

Errors follow a structured format for programmatic handling.

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human readable message",
    "details": { ... }
  }
}
```

### Error Codes

**Note**: Currently, the MCP server uses a simplified error format for stdio transport compatibility. The server returns errors as text content with `isError: true` flag. Full structured error response (shown below) will be implemented in future versions for HTTP transport.

**Current Implementation** (packages/mcp-server/src/server.js):

```javascript
{
  content: [{
    type: 'text',
    text: 'Error: <error_message>'
  }],
  isError: true
}
```

**Target Implementation** (for future HTTP transport):

```javascript
{
  error: {
    code: 'VALIDATION_ERROR',
    message: '<error_message>',
    details: {...}
  }
}
```

All MAMA MCP tools use the following standardized error codes:

| Code               | Description               | When It Occurs                                                | Example                                        |
| ------------------ | ------------------------- | ------------------------------------------------------------- | ---------------------------------------------- |
| `VALIDATION_ERROR` | Input validation failed   | Missing required fields, invalid types, constraint violations | Missing `topic` field in `save_decision`       |
| `NOT_FOUND`        | Resource not found        | Topic doesn't exist, decision ID not found                    | `recall_decision` for non-existent topic       |
| `UNAUTHORIZED`     | Authentication failed     | Invalid or missing auth token (future HTTP transport)         | Missing `MAMA_AUTH_TOKEN` environment variable |
| `INTERNAL_ERROR`   | Server internal error     | Unexpected server failures, unhandled exceptions              | Unhandled exception in tool handler            |
| `DATABASE_ERROR`   | Database operation failed | SQLite errors, constraint violations, transaction failures    | Unique constraint violation, DB locked         |

**Error Response Example**:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Required field 'topic' is missing",
    "details": {
      "field": "topic",
      "provided": undefined,
      "expected": "string"
    }
  }
}
```

---

## Authentication

MAMA uses environment variable-based authentication for security and flexibility.

### Current Implementation (Stdio Transport)

- **Transport**: Stdio (standard input/output)
- **Scope**: Local process only
- **Authentication**: Not required (stdio is inherently local)
- **Configuration**: Database path via `MAMA_DB_PATH` environment variable

### Future HTTP Transport

When MAMA extends to HTTP-based transport, authentication will be mandatory:

- **Method**: Bearer token authentication
- **Header**: `Authorization: Bearer <token>`
- **Token Source**: `MAMA_AUTH_TOKEN` environment variable
- **Validation**: All requests must include a valid token
- **Error**: Returns `UNAUTHORIZED` (401) if token is missing or invalid

### Environment Variables

```bash
# Database location (required)
export MAMA_DB_PATH="$HOME/.claude/mama-memory.db"

# Authentication token (required for HTTP, optional for stdio)
export MAMA_AUTH_TOKEN="your-secure-token-here"

# Log level (optional, default: info)
export MAMA_LOG_LEVEL="info"
```

### Token Security

**CRITICAL**: Tokens must never appear in logs or error messages.

- **Storage**: Environment variables only (never hardcode)
- **Logging**: Always mask tokens before logging
  - Format: `Bearer abc123...` → `Bearer ****`
  - Masking function: Show first 4 chars only, rest as `***`
- **Transmission**: HTTPS only (for future HTTP transport)

**Token Masking Example**:

```javascript
function maskToken(token) {
  if (!token) return '(not set)';
  if (token.length <= 4) return '****';
  return token.substring(0, 4) + '***';
}

// Usage
console.log(`Auth token loaded: ${maskToken(process.env.MAMA_AUTH_TOKEN)}`);
// Output: Auth token loaded: abcd***
```

---

## Logging Format

MAMA uses structured logging for observability and debugging.

### Log Structure

All logs follow a consistent JSON structure:

```typescript
type LogEntry = {
  level: 'debug' | 'info' | 'warn' | 'error';
  timestamp: string; // ISO 8601 format
  requestId: string; // UUID for request tracing
  sessionId?: string; // Optional session identifier
  message: string; // Human-readable message
  meta?: Record<string, any>; // Additional context
};
```

### Log Levels

Control log verbosity via `MAMA_LOG_LEVEL` environment variable:

- `debug`: Verbose debugging information (development only)
- `info`: General information messages (default)
- `warn`: Warning messages (potential issues)
- `error`: Error messages (failures, exceptions)

### Masking Rules

**PII (Personally Identifiable Information)** and **sensitive data** must be masked:

| Data Type       | Masking Rule           | Example                                 |
| --------------- | ---------------------- | --------------------------------------- |
| Auth tokens     | Full masking           | `Bearer abc123` → `Bearer ****`         |
| Passwords       | Full masking           | `password123` → `****`                  |
| Email addresses | Partial masking        | `user@example.com` → `u***@example.com` |
| File paths      | Home directory masking | `/home/user/project` → `~/project`      |
| IP addresses    | Partial masking        | `192.168.1.100` → `192.168.*.*`         |

### Log Format Examples

**JSON Format (Machine-Readable)**:

```json
{
  "level": "info",
  "timestamp": "2025-11-25T12:34:56.789Z",
  "requestId": "req-uuid-123",
  "sessionId": "session-uuid-456",
  "message": "Decision saved successfully",
  "meta": {
    "tool": "save_decision",
    "topic": "auth_strategy",
    "decisionId": "decision_auth_strategy_123456_abc",
    "duration_ms": 45
  }
}
```

**Human-Readable Format (Console)**:

```
[2025-11-25 12:34:56] INFO [req-uuid-123] Decision saved successfully
  topic: auth_strategy
  decisionId: decision_auth_strategy_123456_abc
  duration: 45ms
```

### Masking Implementation

```javascript
// Token masking
function maskToken(token) {
  if (!token) return '(not set)';
  if (token.length <= 4) return '****';
  return token.substring(0, 4) + '***';
}

// PII masking (email)
function maskEmail(email) {
  if (!email || !email.includes('@')) return email;
  const [user, domain] = email.split('@');
  return `${user[0]}***@${domain}`;
}

// Path masking (hide home directory)
function maskPath(filePath) {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home && filePath.startsWith(home)) {
    return filePath.replace(home, '~');
  }
  return filePath;
}

// Usage in logging
console.log({
  level: 'info',
  message: 'User action',
  meta: {
    email: maskEmail('user@example.com'),
    token: maskToken(authToken),
    file: maskPath('/home/user/project/file.js'),
  },
});
```

---

## Tool Catalog

### 1. Agent Collaboration Protocol (Session Management)

These tools are critical for maintaining continuity between AI sessions.

#### `save_checkpoint`

Saves the current session state. **MUST follow the Truthful Continuity format.**

- **Input Schema**:
  - `summary` (string, required): **Structured narrative.**
    - **1. 🎯 Goal & Progress**: What was the goal and how far did you get? If unfinished, note where/why.
    - **2. ✅ Evidence & Verification**: Files/logs/commands + status [Verified | Not run | Assumed]. Call out assumptions explicitly.
    - **3. ⏳ Unfinished & Risks**: Remaining work, unrun tests, risks/unknowns.
  - `open_files` (array<string>): List of relevant file paths.
  - `next_steps` (string): **4. 🚦 Next Agent Briefing**: Next session Definition of Done and quick health/start commands.

- **Example Usage**:
  ```javascript
  use_mcp_tool({
    server_name: 'mama',
    tool_name: 'save_checkpoint',
    arguments: {
      summary: [
        '# 🎯 Goal & Progress',
        '- Goal: Finish auth middleware',
        '- Progress: Validation added, JWT refresh TODO (blocked by spec)',
        '',
        '# ✅ Evidence',
        '- File `packages/api/auth.js` status: Verified via unit test `npm test auth`',
        '- Command `npm test auth` status: Verified',
        '- Command `npm run e2e` status: Not run (takes 10m)',
        '',
        '# ⏳ Unfinished & Risks',
        '- JWT refresh flow not implemented; need spec for token lifetime',
        '- Risk: Logging still prints raw token in debug mode',
      ].join('\\n'),
      open_files: ['/abs/path/to/packages/api/auth.js'],
      next_steps: [
        '🚦 Next Agent Briefing',
        '- DoD: Auth middleware rejects invalid tokens and hides tokens in logs',
        '- Quick checks: npm test auth, grep -n "token" packages/api/auth.js',
      ].join('\\n'),
    },
  });
  ```

#### `load_checkpoint`

Loads the latest session state to resume work "zero-context".

- **Input Schema**: `{}` (No arguments)
- **Output**: Returns the last summary, open files, and next mission.

---

### 2. Core Memory (Decision Tracking)

#### `save_decision`

Saves a decision with reasoning and confidence.

- **Input Schema**:
  - `topic` (string, required): Identifier (e.g., `auth_strategy`). Reuse for related decisions.
  - `decision` (string, required): The decision made.
  - `reasoning` (string, required): Context and rationale.
  - `confidence` (number): 0.0 - 1.0 (default: 0.5).
  - `type` (string): `user_decision` (default) or `assistant_insight`.
  - `outcome` (string): `pending` (default), `success`, `failure`, `partial`.

#### `recall_decision`

Retrieves decision history for a topic.

- **Input Schema**:
  - `topic` (string, required): Topic to recall.
- **Output**: Returns decision history, supersedes chain, and semantic edges (refines/contradicts).

#### `suggest_decision`

Finds relevant past decisions based on a natural language query.

- **Input Schema**:
  - `userQuestion` (string, required): Query or intent.
  - `recencyWeight` (number): 0.0 - 1.0 (default: 0.3).
- **Output**: List of relevant decisions with similarity scores.

#### `list_decisions`

Lists recent decisions.

- **Input Schema**:
  - `limit` (number): Max results (default: 10).

#### `update_outcome`

Updates the outcome of an existing decision.

- **Input Schema**:
  - `decisionId` (string, required): Decision ID to update.
  - `outcome` (string, required): `SUCCESS`, `FAILED`, `PARTIAL`.
  - `failure_reason` (string): Required if outcome is `FAILED`.
  - `limitation` (string): Optional for `PARTIAL` outcome.

**Example Usage**:

```javascript
// Success case
use_mcp_tool({
  server_name: 'mama',
  tool_name: 'update_outcome',
  arguments: {
    decisionId: 'decision_auth_strategy_123456_abc',
    outcome: 'SUCCESS',
  },
});

// Failure case
use_mcp_tool({
  server_name: 'mama',
  tool_name: 'update_outcome',
  arguments: {
    decisionId: 'decision_jwt_refresh_789012_def',
    outcome: 'FAILED',
    failure_reason: 'JWT refresh tokens not supported by current library',
  },
});
```

**Response**:

```json
{
  "content": [
    {
      "type": "text",
      "text": "Outcome updated: decision_auth_strategy_123456_abc → SUCCESS"
    }
  ]
}
```

**Error Example** (Decision not found):

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Decision not found",
    "details": {
      "decisionId": "decision_nonexistent_123"
    }
  }
}
```

---

### 3. Link Collaboration & Governance

These tools enable collaborative decision graph management with explicit approval workflows.

#### `propose_link`

Propose a semantic relationship between two decisions for user approval.

- **Input Schema**:
  - `from_id` (string, required): Source decision ID.
  - `to_id` (string, required): Target decision ID.
  - `relationship` (string, required): `refines` or `contradicts`.
  - `reason` (string, required): Explanation of the relationship.
  - `evidence` (string): Optional supporting evidence.
  - `decision_id` (string): Optional context decision where link was identified.

**Example Usage**:

```javascript
use_mcp_tool({
  server_name: 'mama',
  tool_name: 'propose_link',
  arguments: {
    from_id: 'decision_jwt_impl_123',
    to_id: 'decision_auth_strategy_456',
    relationship: 'refines',
    reason: 'JWT implementation adds technical details missing in the auth strategy decision',
    evidence: 'packages/api/auth.js:45-89 implements JWT validation',
    decision_id: 'decision_code_review_789',
  },
});
```

**Response**:

```json
{
  "content": [
    {
      "type": "text",
      "text": "Link proposed: decision_jwt_impl_123 refines decision_auth_strategy_456\nStatus: Pending user approval\nReason: JWT implementation adds technical details missing in the auth strategy decision"
    }
  ]
}
```

**Error Example** (Decision not found):

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Source decision not found",
    "details": {
      "from_id": "decision_nonexistent_123"
    }
  }
}
```

#### `approve_link`

Approve a pending link proposal.

- **Input Schema**:
  - `from_id` (string, required): Source decision ID.
  - `to_id` (string, required): Target decision ID.
  - `relationship` (string, required): `refines` or `contradicts`.

**Example Usage**:

```javascript
use_mcp_tool({
  server_name: 'mama',
  tool_name: 'approve_link',
  arguments: {
    from_id: 'decision_jwt_impl_123',
    to_id: 'decision_auth_strategy_456',
    relationship: 'refines',
  },
});
```

**Response**:

```json
{
  "content": [
    {
      "type": "text",
      "text": "Link approved and activated:\n- From: decision_jwt_impl_123\n- To: decision_auth_strategy_456\n- Relationship: refines\n- Status: Active"
    }
  ]
}
```

#### `reject_link`

Reject a pending link proposal.

- **Input Schema**:
  - `from_id` (string, required): Source decision ID.
  - `to_id` (string, required): Target decision ID.
  - `relationship` (string, required): `refines` or `contradicts`.
  - `reason` (string): Optional rejection reason.

**Example Usage**:

```javascript
use_mcp_tool({
  server_name: 'mama',
  tool_name: 'reject_link',
  arguments: {
    from_id: 'decision_jwt_impl_123',
    to_id: 'decision_oauth_strategy_789',
    relationship: 'refines',
    reason: 'These decisions are unrelated - JWT is for auth, OAuth is for authorization',
  },
});
```

**Response**:

```json
{
  "content": [
    {
      "type": "text",
      "text": "Link rejected:\n- From: decision_jwt_impl_123\n- To: decision_oauth_strategy_789\n- Relationship: refines\n- Reason: These decisions are unrelated - JWT is for auth, OAuth is for authorization"
    }
  ]
}
```

#### `get_pending_links`

List all pending link proposals awaiting user approval.

- **Input Schema**:
  - `from_id` (string): Optional filter by source decision.
  - `to_id` (string): Optional filter by target decision.

**Example Usage**:

```javascript
// List all pending links
use_mcp_tool({
  server_name: 'mama',
  tool_name: 'get_pending_links',
  arguments: {},
});

// Filter by source decision
use_mcp_tool({
  server_name: 'mama',
  tool_name: 'get_pending_links',
  arguments: {
    from_id: 'decision_auth_strategy_456',
  },
});
```

**Response**:

```json
{
  "content": [
    {
      "type": "text",
      "text": "# Pending Link Proposals (2)\n\n1. decision_jwt_impl_123 refines decision_auth_strategy_456\n   Reason: JWT implementation adds technical details\n   Proposed at: 2025-11-25T10:30:00Z\n\n2. decision_oauth_flow_789 contradicts decision_simple_auth_012\n   Reason: OAuth complexity conflicts with simplicity goal\n   Proposed at: 2025-11-25T11:15:00Z"
    }
  ]
}
```

---

### 4. Quality Metrics & Observability

#### `generate_quality_report`

Generate a comprehensive quality report with coverage and quality metrics.

- **Input Schema**:
  - `format` (string): `json` or `markdown` (default: `json`).
  - `thresholds` (object): Optional custom thresholds.
    - `narrativeCoverage` (number): Narrative coverage threshold (0-1, default: 0.8).
    - `linkCoverage` (number): Link coverage threshold (0-1, default: 0.7).
    - `richReasonRatio` (number): Rich reason ratio threshold (0-1, default: 0.7).

**Metrics**:

- **Narrative Coverage**: % of decisions with complete narrative fields
- **Link Coverage**: % of decisions with at least one link
- **Narrative Quality**: Field completeness for evidence, alternatives, risks
- **Link Quality**: Rich reason ratio (>50 chars) and approved link ratio

**Example Usage**:

```javascript
use_mcp_tool({
  server_name: 'mama',
  tool_name: 'generate_quality_report',
  arguments: {
    format: 'markdown',
    thresholds: {
      narrativeCoverage: 0.9,
      linkCoverage: 0.8,
    },
  },
});
```

#### `get_restart_metrics`

Get restart success rate and latency metrics for zero-context restart feature.

- **Input Schema**:
  - `period` (string): `24h`, `7d` (default), or `30d`.
  - `include_latency` (boolean): Include latency percentiles (default: true).

**Metrics**:

- **Success Rate**: % of successful restart attempts (target: 95%+)
- **Latency Percentiles**: p50, p95, p99 response times
  - Full mode target: p95 < 2500ms
  - Summary mode target: p95 < 1000ms

**Example Usage**:

```javascript
use_mcp_tool({
  server_name: 'mama',
  tool_name: 'get_restart_metrics',
  arguments: {
    period: '7d',
    include_latency: true,
  },
});
```

---

### 5. Migration & Cleanup

Tools for managing legacy data migration and cleanup operations.

#### `scan_auto_links`

Scan for auto-generated links (v0 legacy) that need migration.

- **Input Schema**:
  - `include_samples` (boolean): Include sample links in output (default: false).

**Example Usage**:

```javascript
use_mcp_tool({
  server_name: 'mama',
  tool_name: 'scan_auto_links',
  arguments: {
    include_samples: true,
  },
});
```

**Response**:

```json
{
  "content": [
    {
      "type": "text",
      "text": "# Auto-Link Scan Results\n\nTotal Links: 150\nAuto-Generated Links: 45 (30%)\nProtected Links: 105 (70%)\nDeletion Targets: 45\n\nSample Deletion Targets:\n1. decision_a → decision_b (refines)\n2. decision_c → decision_d (contradicts)\n..."
    }
  ]
}
```

#### `create_link_backup`

Create a backup of auto-generated links before cleanup.

- **Input Schema**:
  - `include_protected` (boolean): Include protected links in backup (default: false).

**Example Usage**:

```javascript
use_mcp_tool({
  server_name: 'mama',
  tool_name: 'create_link_backup',
  arguments: {
    include_protected: false,
  },
});
```

**Response**:

```json
{
  "content": [
    {
      "type": "text",
      "text": "# Backup Created Successfully\n\n**Links Backed Up:** 45\n**Backup File:** ~/.claude/mama-backups/links-backup-2025-11-25T12-30-45-123Z.json\n**Checksum:** abc123def456...\n**Manifest File:** ~/.claude/mama-backups/backup-manifest-2025-11-25T12-30-45-123Z.json"
    }
  ]
}
```

#### `execute_link_cleanup`

Execute auto-generated link cleanup with batch deletion.

- **Input Schema**:
  - `batch_size` (number): Links per batch (default: 100).
  - `dry_run` (boolean): Simulate deletion without actual changes (default: true).

**Example Usage**:

```javascript
// Dry-run first (safe simulation)
use_mcp_tool({
  server_name: 'mama',
  tool_name: 'execute_link_cleanup',
  arguments: {
    batch_size: 100,
    dry_run: true,
  },
});

// Actual execution
use_mcp_tool({
  server_name: 'mama',
  tool_name: 'execute_link_cleanup',
  arguments: {
    batch_size: 100,
    dry_run: false,
  },
});
```

**Response (Dry-Run)**:

```json
{
  "content": [
    {
      "type": "text",
      "text": "# Link Cleanup Execution\n\n**Mode:** DRY RUN MODE (simulation)\n**Would Delete:** 45\n**Backup File:** ~/.claude/mama-backups/links-backup-2025-11-25.json\n\nSample Links:\n1. decision_a → decision_b (refines)\n...\n\n⚠️ To execute actual deletion, run with `dry_run: false`"
    }
  ]
}
```

**Response (Actual Execution)**:

```json
{
  "content": [
    {
      "type": "text",
      "text": "# Link Cleanup Execution\n\n**Mode:** Cleanup Execution Complete\n**Deleted:** 45\n**Failed:** 0\n**Success Rate:** 100%\n**Backup File:** ~/.claude/mama-backups/links-backup-2025-11-25.json\n\n✅ Cleanup completed. Run `validate_cleanup_result` to verify."
    }
  ]
}
```

#### `validate_cleanup_result`

Validate cleanup result and generate post-cleanup report.

- **Input Schema**:
  - `format` (string): `json` or `markdown` (default: `markdown`).

**Success Criteria**:

- **SUCCESS**: Remaining auto links < 5%
- **PARTIAL**: Remaining auto links 5-10%
- **FAILED**: Remaining auto links > 10%

**Example Usage**:

```javascript
use_mcp_tool({
  server_name: 'mama',
  tool_name: 'validate_cleanup_result',
  arguments: {
    format: 'markdown',
  },
});
```

**Response**:

```json
{
  "content": [
    {
      "type": "text",
      "text": "# Post-Cleanup Validation\n\n**Status:** SUCCESS\n\n✅ SUCCESS: Remaining auto-links under 5%. Target achieved!\n\n## Statistics\n- **Total Links:** 105\n- **Remaining Auto Links:** 0\n- **Remaining Ratio:** 0.0%\n- **Protected Links:** 105\n\n## Recommendation\nCleanup completed successfully. You can proceed with migration."
    }
  ]
}
```

---

### 6. Planned Tools (Future)

- **`save_insight`**: Specialized tool for capturing AI insights (currently handled by `save_decision` with type=`assistant_insight`).
- **`evolve/supersede`**: Explicitly mark a decision as superseding another (currently handled implicitly by topic reuse).
