# Codex App-Server Backend Setup Guide

**Category:** Guide (Task-Oriented)
**Audience:** Users who want to use Codex app-server as a backend in MAMA OS

---

## Overview

MAMA OS runs Codex CLI through its stdio app-server protocol and can mix Codex and Claude
agents in the same multi-agent workflow. The configured backend name is `codex`.

The runtime keeps one managed app-server process, multiplexes conversations onto durable Codex
threads, and exposes the tools allowed for each run as native app-server host tools. MAMA still
enforces the current role, tier, runtime, channel, and Reactive-envelope policy before executing a
host tool.

`codex-mcp` is a legacy configuration alias. Existing configuration is normalized to `codex`, but
new configuration and API calls should use `codex`.

## Installation

### 1. Install Codex CLI

```bash
npm install -g @openai/codex
```

You can also place a Codex binary in a directory on `PATH`.

### 2. Authenticate

Run `codex login` before starting MAMA. By default, MAMA isolates Codex state under
`~/.mama/.codex` and bootstraps `auth.json` from `~/.codex/auth.json` when needed. The managed
copy is refreshed only when the source credentials change.

Useful overrides:

```bash
export MAMA_CODEX_COMMAND=/path/to/codex
export CODEX_HOME=~/.mama/.codex
```

MAMA searches for the Codex executable in this order:

1. The configured command
2. `MAMA_CODEX_COMMAND`
3. `CODEX_COMMAND`
4. `PATH`
5. Common local binary directories such as `~/.local/bin`

## Configuration

### Global configuration

```yaml
agent:
  backend: codex
  model: gpt-5.4
  timeout: 180000
  codex_home: ~/.mama/.codex
  codex_cwd: ~/.mama/workspace
  codex_sandbox: workspace-write
  codex_skip_git_repo_check: true
  codex_ephemeral: false
```

### Per-agent override

```yaml
multi_agent:
  enabled: true
  agents:
    conductor:
      backend: claude
      model: claude-sonnet-4-6
      tier: 1
      can_delegate: true

    developer:
      backend: codex
      model: gpt-5.4
      tier: 2
      codex_sandbox: workspace-write

    reviewer:
      backend: codex
      model: gpt-5.4
      tier: 3
      codex_sandbox: read-only
```

## Claude and Codex runtime differences

| Item               | Claude backend                 | Codex backend                                                         |
| ------------------ | ------------------------------ | --------------------------------------------------------------------- |
| Protocol           | Persistent Claude CLI stream   | `codex app-server --strict-config --stdio`                            |
| Conversation state | Persistent CLI session         | Durable app-server thread registry                                    |
| Process model      | Resident process pool          | One multiplexed managed app-server process                            |
| Tools              | Gateway/Code-Act routing       | Native app-server host tools projected per run                        |
| Sandbox            | CLI permission policy          | `read-only`, `workspace-write`, or `danger-full-access`               |
| Timeout behavior   | Per request                    | Confirmed turns are isolated; unreconciled starts restart the process |
| Compaction         | Managed by MAMA session policy | Managed by Codex app-server                                           |

On a new Codex conversation, MAMA creates a thread with the current persona and runtime policy.
After a MAMA daemon restart, it resumes the durable thread and sends a fresh runtime bootstrap on
the first resumed turn so current policy and tool context are not stale. An explicit fresh session
removes the old registry entry and starts a new thread.

## Native tool bridge and Code-Act

Codex agents call the tools advertised by app-server directly. They must not print JSON or Markdown
tool blocks as a substitute for a tool call.

The advertised set is built for each run and can include:

- Memory and context tools such as `mama_search`, `context_compile`, and `mama_save`
- Messaging and connector tools allowed for the current role and channel
- Browser or other gateway tools explicitly allowed by configuration
- `code_act`, which runs JavaScript against its own restricted host bridge

Code-Act does not bypass MAMA permissions. Its host bridge applies the same role, runtime, tier,
channel, and Reactive-envelope checks as direct native host-tool calls. After a turn is cancelled,
MAMA rejects new tool callbacks and waits for any callback that already started to settle before
reporting the turn failure. An external side effect may still finish if its provider call had
already begun and does not support cooperative cancellation.

For the verified Telegram owner console, Code-Act exposes the complete Google Drive composition
surface even when the active envelope has no static Drive destination. The owner may list, browse,
resolve, download, and upload to the folder selected for the active request. A configured
non-ignored `folderId` or `driveId` can still issue a short-lived, envelope-bound destination
capability; when `drive_upload` supplies one, the executor validates it. Non-owner roles cannot gain
Drive tools, and Drive read results stay wrapped as untrusted data after Code-Act execution even
when the sandbox transforms or summarizes them.

MAMA intentionally excludes the `mama` and legacy `code-act` MCP servers from the Codex app-server
MCP registry. Exposing them there would create a second route around the canonical host bridge.
Other explicitly configured external MCP servers may still be projected into app-server after
their configuration is validated.

## Sandbox options

| Mode                 | Description                                | Typical use                      |
| -------------------- | ------------------------------------------ | -------------------------------- |
| `read-only`          | File reads only                            | Review and investigation         |
| `workspace-write`    | Writes limited to the configured workspace | Development; recommended default |
| `danger-full-access` | Full filesystem access                     | Trusted administration only      |

The app-server is also launched from a managed Codex home with user instructions, apps, plugins,
tool search, shell, web search, and other unprojected native surfaces disabled. MAMA rejects
instruction sources that resolve outside its managed roots, including symlink escapes.

## External MCP servers

`agent.tools.mcp_config` may point to a validated MAMA MCP configuration file. For Codex,
non-MAMA external servers are translated into app-server launch overrides. Stdio server secrets
are passed through the child environment, redacted from errors, and trigger a safe process refresh
when changed.

```yaml
agent:
  backend: codex
  tools:
    gateway:
      - '*'
    mcp:
      - '*'
    mcp_config: ~/.mama/mama-mcp-config.json
```

The gateway allowlist and MCP configuration describe different boundaries: gateway tools are
executed by MAMA's canonical executor, while validated external MCP servers run through Codex.

## Configuration type reference

```typescript
interface AgentConfig {
  backend: 'claude' | 'codex';
  model: string;
  timeout: number;

  effort?: 'low' | 'medium' | 'high' | 'max'; // Claude only
  use_persistent_cli?: boolean; // Claude only

  codex_home?: string;
  codex_cwd?: string;
  codex_sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  codex_skip_git_repo_check?: boolean;
  codex_ephemeral?: boolean;
}
```

## Troubleshooting

- **Authentication failure:** run `codex login`, then restart MAMA. Check
  `~/.mama/logs/daemon.log` if the managed credential copy cannot be prepared.
- **Backend rejected:** use `codex`. Unknown backend names fail explicitly; only stored legacy
  `codex-mcp` values are migrated.
- **Thread policy mismatch:** the app-server process rejects the stale durable thread without
  changing its registry entry. The MAMA AgentLoop then performs one bounded reset, rebuilds the
  complete current persona/rules/tool prompt, and retries on a fresh thread. A successful recovery
  emits no user-facing error callback. If the reset retry fails, MAMA reports one normalized error;
  repeated retries are not attempted, and the replacement pool entry is invalidated so the next
  request rebuilds a full prompt instead of persisting minimal resume instructions. Opt-in legacy
  context search is also rerun during that lazy full-prompt rebuild. Stable owner-console policy,
  including the external-evidence trust boundary, participates in the fingerprint so deployment
  invalidates durable threads that predate the rule.
- **Unexpected instruction source:** remove instructions or symlinks that resolve outside the
  managed MAMA roots.
- **External MCP startup issue:** validate `agent.tools.mcp_config`; MAMA rejects malformed fields,
  unsafe environment bindings, and invalid transports before launching Codex.

## Reference files

- App-server runtime: `packages/standalone/src/agent/codex-app-server-process.ts`
- Durable thread registry: `packages/standalone/src/agent/codex-thread-registry.ts`
- Managed Codex home and MCP projection: `packages/standalone/src/agent/codex-home.ts`
- Shared model runner: `packages/standalone/src/agent/model-runner.ts`
- Canonical host-tool executor: `packages/standalone/src/agent/gateway-tool-executor.ts`
- Codex instructions: `packages/standalone/templates/AGENTS.codex.md`
