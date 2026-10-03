---
title: Choose and authenticate a backend
parent: Guides
nav_order: 2
---

# Choose and authenticate a backend

MAMA runs one persistent owner session with either `claude` or `codex`. Choose it
in `mama init`, or edit `agent.backend` and `agent.model` in
`~/.mama/config.yaml`, then restart the daemon.

| Backend  | Sign in on the daemon host                    | Runtime                                                     |
| -------- | --------------------------------------------- | ----------------------------------------------------------- |
| `claude` | `claude auth login`                           | Persistent Claude CLI; MAMA actions exposed through MCP     |
| `codex`  | `CODEX_HOME="$HOME/.mama/.codex" codex login` | Codex app-server; MAMA actions exposed as native host tools |

Use a model your backend account can run. Backend authentication is separate from
Telegram and connector tokens. The owner backend does not receive secret-shaped
variables from the daemon environment.

## Adjust a run

`agent.effort`, `agent.max_turns`, `agent.timeout`, `agent.max_turn_ms` and
`agent.run_token_budget` control the run. Setup writes `medium`, `100`, `600000`,
`3600000` and `0` respectively. `agent.timeout` is how long a turn may go without progress
(milliseconds; any output from the runtime restarts it, so only one step longer than this stops
a working turn), `agent.max_turn_ms` is the longest a turn may run in all, and a zero token
budget imposes no run token cap. Supported
effort values depend on the selected backend and model. See the
[configuration reference](../reference/configuration.md).

Codex keeps managed state under `~/.mama/.codex` by default. Sign in to that home
with the command above, or use your configured `agent.codex_home` as `CODEX_HOME`.
The current owner assembly does not copy credentials from your usual Codex home;
a plain `codex login` may authenticate a different home. MAMA regenerates the
managed `config.toml`; change MAMA's configuration rather than editing that TOML.

## Keep the owner boundary intact

Both backends work in `~/.mama/workspace` by default, write within that workspace,
and have native web access. Claude uses sandboxed Bash, project/local settings,
an empty plugin directory and a Git boundary. Codex enables native shell and web
search under a workspace permission profile. The owner Codex session requires
`workspace-write`; another `agent.codex_sandbox` value fails at runtime.

Both backends exclude `auth.env`, `config.yaml`, `runtime/` and the managed Codex
home from agent reads. Native child agents inherit the boundary. Claude child
agents run within the active turn, with background tasks disabled. Catalog and
native tool calls are recorded for the parent and child runs.

MAMA owns the conversation and delivery even when it uses native subagents.
There is no separate user-facing agent roster to configure. See
[Security](security.md) and [Troubleshooting](troubleshooting.md) for credentials,
login failures and tracing a turn.
