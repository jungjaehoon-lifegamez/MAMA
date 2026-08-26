# Internal Worker Orchestration (Advanced and Legacy)

MAMA's product exposes one work agent through existing messengers. Users delegate an outcome to
MAMA; they do not need to select, name, or coordinate AI teammates.

This guide documents the remaining internal/legacy multi-agent configuration for operators who
already depend on it. It is not the recommended onboarding path and does not define the v1 human
team model.

## Product rule

```text
user-facing identity       MAMA
human team                 verified human principals
internal workers           optional execution resources
artifact writer            one authority per lineage
final answer and receipt   owned by MAMA
```

An internal worker can help with an independently parallelizable analysis, a bounded domain task,
or an independent review. It should return evidence to the MAMA run that owns the operation rather
than take over the user conversation.

## Removed orchestration features

The following historical systems were removed in v0.29.0 because the runtime did not execute them:

| Removed system                         | Current status                             |
| -------------------------------------- | ------------------------------------------ |
| Council Engine (`council_plan`)        | No parser or executor                      |
| Dynamic Workflow DAG (`workflow_plan`) | Type declarations remain; no executor      |
| Swarm DB and Wave Engine               | Replaced by the Stage-2 workorder pipeline |
| UltraWork autonomous sessions          | No runtime                                 |
| `delegate` gateway action              | Not dispatchable; calling it fails         |

Configuration keys for these systems may still parse for backward compatibility. Parsing is not
evidence that a feature runs. Do not present these modes during onboarding or use them in a new
product plan.

## What remains

- managed model-process pools;
- optional named persona configuration from legacy installs;
- model and backend overrides;
- tool-tier and native-tool narrowing;
- hot reload of process pools;
- Stage-2 system workorders outside this module.

The workorders that run scheduled Board, Wiki, memory-curation, and Temporal work live under
`packages/standalone/src/operator/`. They are host-owned work types, not user-facing AI coworkers.

## When an internal worker is justified

Use an internal worker only when at least one condition is true:

- two or more branches are independent and parallel execution reduces wall time;
- the branch needs an isolated context that should not pollute the main Case run;
- an independent review has measurable value;
- a domain runtime requires a different process or model boundary;
- tool authority must be narrower than the MAMA run's authority.

Do not create a worker for:

- a deterministic tool call;
- a short sequential task;
- two mutations of the same artifact lineage;
- a role label that exists only to imitate a human organization;
- work whose complete context must be copied to every worker;
- a user preference for a named persona.

Multi-agent systems spend additional tokens and coordination time. Treat them as optional
test-time compute, not a default product feature.

## Legacy persona configuration

Older installations may contain persona files under `~/.mama/personas/` and entries under
`multi_agent.agents`.

```yaml
multi_agent:
  enabled: false
  agents:
    legacy-reviewer:
      name: Legacy Reviewer
      persona_file: ~/.mama/personas/legacy-reviewer.md
      backend: codex
      model: gpt-5.6-luna
      tier: 3
      tool_permissions:
        allowed: [Read, Grep, Glob]
        blocked: [Write, Edit, Bash]
```

The default remains disabled. New v1 team access must not be modeled by adding one persona per
human or one persona per job title.

## Tool tiers are not human-team grants

Legacy persona tiers narrow an internal runtime's tools. Human-team authorization is a different
contract.

```text
internal tool tier
  answers: what may this process call?

principal scope grant
  answers: what may this human request, read, modify, approve, or deliver?
```

Phase 2b must compute human effective scope independently of persona configuration. A permissive
internal worker cannot widen the requester's authority.

## Hot reload

Updating managed-agent configuration restarts affected process pools. It does not hot-reload:

- messenger tokens;
- MCP connections;
- database paths.

Use hot reload only for installations that still operate managed workers explicitly. It is not
required for normal one-front MAMA operation.

## Related

- [The Work Agent Behind Your Messenger](../explanation/work-agent.md)
- [One-Front Team Work Agent design](../development/2026-08-26-one-front-team-work-agent-design.md)
- [Architecture](../explanation/architecture.md)
- [Code-Act Sandbox](code-act-sandbox.md)
