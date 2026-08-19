# Multi-Agent Personas Guide

**Category:** Guide (Task-Oriented)
**Audience:** Users configuring the daemon's agent personas and tool tiers

---

> In the viewer, webchat, and connector-event lane, MAMA/`os-agent` is the acting subject. A
> multi-agent persona named `conductor` may remain in legacy installations, but it is not the
> removed background Conductor and does not own connector events or audits.

## What this guide no longer covers

Four subsystems this guide used to document were removed in v0.29.0 because nothing ran
them. They are gone from the runtime, not merely disabled:

| Removed                                                  | What replaced it                                                                                   |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Council Engine (`council_plan` blocks)                   | nothing — no parser or executor exists                                                             |
| Dynamic Workflow DAG (`workflow_plan`, ephemeral agents) | nothing — only the type declarations survive                                                       |
| Swarm DB & Wave Engine (`swarm_tasks`)                   | the Stage-2 work order pipeline (`workorder-board`, `workorder-wiki`, `workorder-memory-curation`) |
| UltraWork autonomous sessions                            | nothing                                                                                            |

`multi_agent.council`, `multi_agent.workflow` and `ultrawork` may still parse in
`~/.mama/config.json`; they are inert. `delegate` is still listed in the tool registry and is
NOT dispatchable — calling it throws `Unknown tool: delegate`, and the `DELEGATE::` message
prefix is no longer executed by anything.

What survives is the part that was always doing the work: named personas, a three-tier tool
permission model, and hot-reload.

---

## Custom Persona Creation

### File Format

Personas are defined as Markdown files:

```markdown
# Agent Name

## Role

Role description

## Responsibilities

- Responsibility 1
- Responsibility 2

## Constraints

- Constraint 1

## Communication Style

- Style description
```

### Required Fields

| Field          | Description                                                     |
| -------------- | --------------------------------------------------------------- |
| `name`         | Agent identifier                                                |
| `display_name` | Name displayed in chat                                          |
| `persona_file` | Path to the persona Markdown file                               |
| `tier`         | 1 (full access), 2 (read + limited write), 3 (custom tool list) |

### Placement

```text
~/.mama/agents/           # User custom personas
~/.mama/templates/personas/  # Built-in personas
```

### Configuration Example

```yaml
multi_agent:
  agents:
    my_agent:
      name: 'My Agent'
      display_name: 'Custom Agent'
      persona_file: ~/.mama/agents/my-agent.md
      backend: 'claude'
      model: 'claude-sonnet-4-6'
      tier: 2
      auto_respond_keywords: [custom, special]
      cooldown_ms: 3000
      tool_permissions:
        # Note: tool_permissions only controls Claude CLI built-in tools.
        # Gateway tools (mama_search, discord_send, etc.) are managed separately by tier.
        allowed: [Read, Grep, Glob, Bash]
        blocked: [Write, Edit]
```

### Permissions by Tier

| Tier       | Access Scope                              | Use Case                       |
| ---------- | ----------------------------------------- | ------------------------------ |
| **Tier 1** | All tools (Read, Edit, Write, Bash, etc.) | os-agent, conductor, developer |
| **Tier 2** | Read-only + limited write                 | Implementer                    |
| **Tier 3** | Custom tool list only                     | Reviewer, QA, Analyst          |

---

## Hot-reload

When `updateConfig()` is called, it restarts the process pools to apply new configuration.

### Items That Are Reloaded

- Agent definitions (personas, tiers, permissions)
- Model assignments
- Tool permissions
- Channel overrides

### Items That Are NOT Reloaded (Require Server Restart)

- Discord/Slack bot tokens
- MCP server connections
- Database paths

### API

```bash
# Update agent configuration (triggers hot-reload)
curl -X PUT 'http://localhost:3847/api/multi-agent/agents/developer' \
  -H "Content-Type: application/json" \
  -d '{"backend": "claude", "model": "claude-opus-4-6"}'
```

---

---

## Reference Files

Surviving modules in `packages/standalone/src/multi-agent/`:

| File                                                                             | Role                                   |
| -------------------------------------------------------------------------------- | -------------------------------------- |
| `agent-process-manager.ts`                                                       | owns the managed agent processes       |
| `agent-event-bus.ts`                                                             | the event bus personas publish onto    |
| `tool-permission-manager.ts`                                                     | the three-tier tool permission model   |
| `conductor-persona.ts`                                                           | the conductor's system prompt sections |
| `dashboard-agent-persona.ts`, `wiki-agent-persona.ts`, `memory-agent-persona.ts` | optional legacy persona configs        |
| `runtime-process.ts`, `types.ts`, `workflow-types.ts`, `bmad-templates.ts`       | supporting types and process plumbing  |

The work orders that actually run scheduled system work live elsewhere:
`packages/standalone/src/operator/` (`workorder-consumer.ts`, `workorder-hooks.ts`,
`worker-run.ts`) with briefs in `~/.mama/briefs/`.
