# Codex CLI Backend Setup Guide

**Category:** Guide (Task-Oriented)
**Audience:** Users who want to use Codex CLI as a backend in MAMA OS

---

## Overview

MAMA OS can run Codex CLI in MCP server mode (`codex mcp-server`) and use it as an agent backend. You can also mix it with the Claude CLI backend to use both backends simultaneously in a single Multi-Agent swarm.

---

## Installation

### 1. Install Codex CLI

```bash
# Global install via npm
npm install -g @openai/codex

# Or install the binary directly
# Place it in a directory included in PATH, such as ~/.local/bin/codex
```

### 2. Environment Variables (Optional)

```bash
# Specify the Codex binary path directly (if not in PATH)
export MAMA_CODEX_COMMAND=/path/to/codex
# Or
export CODEX_COMMAND=/path/to/codex

# Codex configuration directory (default: ~/.mama/.codex)
export CODEX_HOME=~/.mama/.codex
```

MAMA searches for the Codex binary in the following order:

1. The `command` option in the configuration
2. `MAMA_CODEX_COMMAND` environment variable
3. `CODEX_COMMAND` environment variable
4. PATH search
5. Fallback paths: `~/.local/bin/codex`, `~/bin/codex`, `/usr/local/bin/codex`, etc.

---

## Configuration

### Global Configuration

Change the default backend to `codex-mcp` in `config.yaml`:

```yaml
agent:
  backend: 'codex-mcp'
  model: 'codex-model-name'
  timeout: 180000
  codex_sandbox: 'workspace-write'
```

### Per-Agent Override

Specify the backend for individual agents in the Multi-Agent configuration:

```yaml
multi_agent:
  enabled: true
  agents:
    conductor:
      backend: 'claude'
      model: 'claude-sonnet-4-6'
      tier: 1
      can_delegate: true

    developer:
      backend: 'codex-mcp'
      model: 'codex-model-name'
      tier: 1
      codex_sandbox: 'workspace-write'

    reviewer:
      backend: 'claude'
      model: 'claude-sonnet-4-6'
      tier: 3
```

---

## Claude vs Codex Comparison

| Item                   | Claude CLI                                                     | Codex MCP                                            |
| ---------------------- | -------------------------------------------------------------- | ---------------------------------------------------- |
| **Protocol**           | CLI subprocess (JSON stdout)                                   | MCP (JSON-RPC via stdio)                             |
| **Session Management** | UUID + session persistence (context preserved across sessions) | ThreadId-based internal management                   |
| **Sandbox**            | None (permissions-based)                                       | `read-only`, `workspace-write`, `danger-full-access` |
| **Thinking**           | Adaptive thinking (`effort: low~max`)                          | None                                                 |
| **Startup Method**     | Resident process pool (PersistentProcessPool)                  | Resident process (reused after MCP Initialize)       |
| **Timeout**            | Configurable per request                                       | Initialize 60s, request 3 min default                |
| **Auto-Restart**       | Process pool recreation                                        | Automatic restart once on failure                    |
| **State Machine**      | None                                                           | `dead → starting → ready → busy → ready`             |
| **Isolation**          | `cwd: ~/.mama/workspace` + git boundary + empty plugin-dir     | `codex_cwd` configuration                            |
| **System Prompt**      | Injected once via `--system-prompt` (persistent session)       | Injected once via developer-instructions             |

> **Important:** Both backends inject the system prompt **only once on the first turn**. Claude preserves prior context via session persistence, while Codex does so via threadId.

---

## Sandbox Options

Sandbox modes exclusive to the Codex backend:

| Mode                 | Description                                | Use Case                                       |
| -------------------- | ------------------------------------------ | ---------------------------------------------- |
| `read-only`          | Cannot write to the file system            | Analysis and review-only agents                |
| `workspace-write`    | Can only modify files within the workspace | General development agents (recommended)       |
| `danger-full-access` | Full file system access                    | System administration tasks (use with caution) |

```yaml
agent:
  codex_sandbox: 'workspace-write' # Recommended default
```

---

## Mixed Swarm Example

Use Claude and Codex agents together in a single swarm:

```yaml
multi_agent:
  enabled: true

  workflow:
    enabled: true
    backend_balancing: true # Claude ↔ Codex round-robin

  agents:
    conductor:
      backend: 'claude'
      model: 'claude-sonnet-4-6'
      tier: 1
      can_delegate: true

    developer:
      backend: 'codex-mcp'
      model: 'codex-model-name'
      tier: 1
      codex_sandbox: 'workspace-write'

    coder:
      backend: 'codex-mcp'
      model: 'codex-model-name'
      tier: 2
      codex_sandbox: 'workspace-write'

    reviewer:
      backend: 'claude'
      model: 'claude-sonnet-4-6'
      tier: 3
```

When `backend_balancing: true` is set, Dynamic Workflow's ephemeral agents are distributed between Claude and Codex in a round-robin fashion.

---

## Customizing AGENTS.codex.md

Codex backend agents receive a different instruction file than Claude agents.

### Default Files

- **Claude agents**: Use persona files (`~/.mama/templates/personas/*.md`) directly
- **Codex agents**: Instructions injected based on `templates/AGENTS.codex.md`

### Tool Call Format for Codex Agents

Codex agents call gateway tools using JSON blocks:

```json
{ "name": "mama_search", "input": { "query": "authentication strategy" } }
```

### Available Gateway Tools

- **Memory**: `mama_search`, `mama_save`, `mama_update`, `mama_load_checkpoint`
- **Messaging**: `discord_send`, `slack_send`
- **File**: `Read`, `Write`, `Bash`

> **Note:** Do not use `exec_command` or `apply_patch` in Codex agents. Use only gateway tools.

### How to Customize

You can modify `templates/AGENTS.codex.md` to change the default behavior of Codex agents. When a skill is activated, its `SKILL.md` is additionally injected.

---

## Configuration Type Reference

```typescript
interface AgentConfig {
  backend: 'claude' | 'codex-mcp';
  model: string;
  timeout: number;

  // Claude only
  effort?: 'low' | 'medium' | 'high' | 'max';
  use_persistent_cli?: boolean;

  // Codex only
  codex_home?: string;
  codex_cwd?: string;
  codex_sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  codex_skip_git_repo_check?: boolean;
  codex_ephemeral?: boolean;
}
```

---

## Reference Files

- Codex MCP process: `packages/standalone/src/agent/codex-mcp-process.ts`
- Claude CLI wrapper: `packages/standalone/src/agent/claude-cli-wrapper.ts`
- Codex instructions: `packages/standalone/templates/AGENTS.codex.md`
- Configuration types: `packages/standalone/src/cli/config/types.ts`
