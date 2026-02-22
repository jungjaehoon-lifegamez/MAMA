# Code-Act Sandbox Usage Guide

**Category:** Guide (Task-Oriented)
**Audience:** Users who want to understand and utilize the Code-Act sandbox

---

## Overview

Code-Act Sandbox is an isolated JavaScript execution environment based on QuickJS/WASM. It allows agents to combine multiple tools into a single code block for execution, achieving 67-88% token savings and 80-90% round-trip reduction compared to the traditional single `tool_call` approach.

### Traditional Approach vs Code-Act

```text
Traditional: Message → LLM → 1 tool → History → LLM → 1 tool → ... (5-10 round trips)
Code-Act: Message → LLM → JavaScript code → Multiple tools + Data processing → 1-2 round trips
```

---

## When to Use

- **Tier 1/2 agents**: Enable with `useCodeAct: true` in configuration
- **Tier 3 agents**: Code-Act unavailable (automatically forced to `useCodeAct: false`)
- **HTTP API**: `POST /api/code-act` endpoint (only Tier 3 tools available)

### Agent Configuration

```yaml
multi_agent:
  agents:
    developer:
      tier: 1
      useCodeAct: true # Enable Code-Act

    reviewer:
      tier: 3
      # useCodeAct: false enforced (Tier 3)
```

---

## Available Tools

Tools are accessed through HostBridge via the gateway. Available tools vary by Tier.

### Tier 1 (Full Access)

| Category      | Tools                                                             |
| ------------- | ----------------------------------------------------------------- |
| **Memory**    | `mama_search`, `mama_save`, `mama_update`, `mama_load_checkpoint` |
| **File**      | `Read`, `Write`, `Grep`, `Glob`                                   |
| **Execution** | `Bash`                                                            |
| **Messaging** | `discord_send`, `slack_send`, `telegram_send`                     |
| **Browser**   | `browser_get_text`, `browser_screenshot`                          |
| **PR**        | `pr_review_threads`                                               |
| **MCP**       | All dynamically registered MCP tools                              |

### Tier 2 (Read-Only)

`mama_search`, `mama_load_checkpoint`, `Read`, `Grep`, `Glob`, `browser_get_text`, `browser_screenshot`, `pr_review_threads`

### HTTP API (Tier 3 Restricted)

Only Tier 3 tools are available when accessed externally via `POST /api/code-act`.

---

## API

### POST /api/code-act

```bash
curl -X POST http://localhost:3847/api/code-act \
  -H "Content-Type: application/json" \
  -d '{"code": "const results = await mama_search({query: \"auth\"}); return results;"}'
```

**Request:**

```json
{
  "code": "const results = await mama_search({query: 'auth'}); return results;"
}
```

**Response:**

```json
{
  "success": true,
  "value": { "decisions": [...] },
  "logs": ["Found 3 matching decisions"],
  "metrics": {
    "durationMs": 245,
    "hostCallCount": 1,
    "memoryUsedBytes": 1048576
  }
}
```

**Error Response:**

```json
{
  "success": false,
  "error": {
    "name": "TypeError",
    "message": "mama_search is not a function",
    "stack": "..."
  }
}
```

**Authentication:** Required if the `MAMA_AUTH_TOKEN` environment variable is set.

---

## Security Model

### WASM Isolation

The QuickJS WASM engine provides a fully isolated environment.

| Threat                  | Defense                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------- |
| **Node.js API access**  | `require`, `process`, `fs` not injected (do not exist)                             |
| **Network access**      | No `fetch()`, `XMLHttpRequest`, or sockets                                         |
| **Infinite loops**      | Engine-level CPU timeout (default 30 seconds)                                      |
| **Memory exhaustion**   | `setMemoryLimit()` hard cap (default 256MB via quickjs-emscripten WASM allocation) |
| **Prototype pollution** | QuickJS isolates from host Object.prototype                                        |
| **Code injection**      | Only injected functions are available                                              |

### Tier-Based Access Control

- **Tier 1 + `useCodeAct: true`**: All functions injected
- **Tier 2 + `useCodeAct: true`**: Read-only functions only injected
- **Tier 3**: Code-Act disabled (falls back to tool_call mode)
- **HTTP API** (`/api/code-act`): Only Tier 3 tools available

### MCP Registration

Code-Act is also registered as a separate MCP server (`code-act-server.ts`), allowing LLMs to invoke it directly as a `code_act` tool. Actual execution is proxied to `POST /api/code-act`.

---

## Performance

| Metric               | Value                         |
| -------------------- | ----------------------------- |
| Cold start           | < 500ms (initial WASM load)   |
| Warm start           | < 5ms (SandboxPool reuse)     |
| Host call overhead   | < 10ms (Handle serialization) |
| Token savings        | 67-88%                        |
| Round-trip reduction | 80-90%                        |

---

## TypeScript Type Definitions

When Code-Act is enabled, auto-generated `.d.ts` type definitions are injected into the system prompt instead of the traditional gateway tool Markdown. This allows the LLM to generate more accurate code, with approximately 37% token savings compared to the traditional Markdown approach.

---

## Hybrid Mode

Code-Act and traditional `tool_call` can be used simultaneously. The LLM can mix both formats in its response, and CodeBlockRouter handles routing automatically.

- ` ```tool_call ` blocks → Traditional GatewayToolExecutor
- ` ```js ` / ` ```javascript ` blocks → CodeActSandbox

---

## Reference Files

- MCP server: `packages/standalone/src/mcp/code-act-server.ts`
- Sandbox implementation: `packages/standalone/src/agent/code-act/`
- Architecture document: `docs/architecture-code-act-sandbox-2026-02-20.md`
- Security guide: `docs/guides/security.md`
