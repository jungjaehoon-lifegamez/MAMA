# MAMA OS

MAMA OS is the always-on local runtime behind MAMA. It connects messengers and other sources,
maintains local memory and Cases, executes bounded work, and returns reports or files through an
authorized destination.

## Two surfaces with different jobs

### Messenger: the work front

Telegram, Slack, and Discord are where a user normally:

- delegates work;
- attaches input files;
- answers a clarification;
- receives progress or an approval request;
- receives the final artifact.

The user contacts one MAMA identity. Internal models, workers, and domain tools are not exposed as
a team the user must coordinate.

### Viewer: the operator and inspection surface

The Viewer at `http://localhost:3847/viewer` opens on the operator board. It groups read-oriented
views into:

- **Operator:** Board, Tasks, Triggers;
- **Knowledge:** Memory, Wiki;
- **System:** Runtime, Connectors, Logs.

The Viewer helps an owner inspect what MAMA knows and what the runtime is doing. It is not a new
collaboration app and is not required for ordinary messenger delegation.

## Runtime shape

```text
Telegram / Slack / Discord / connector sources
                     │
                     ▼
             authenticated ingress
                     │
                     ▼
          MAMA AgentLoop + Case context
                     │
          ┌──────────┼──────────┐
          ▼          ▼          ▼
   memory tools   domain tools  workorders
          │          │          │
          └──────────┼──────────┘
                     ▼
          artifacts + effects + receipts
                     │
                     ▼
             authorized delivery

Viewer ── HTTP/SSE ── runtime, board, tasks, knowledge, connectors, logs
```

## One MAMA, optional internal workers

MAMA may use a separate process or model for background work, parallel read-only analysis, or
independent review. These are internal execution resources.

The product invariant is:

```text
one user-facing MAMA
one final result
one mutation authority per artifact lineage
```

Named personas and legacy multi-agent configuration are advanced compatibility surfaces. They do
not define the v1 product and should not be required during normal onboarding.

## Durable state

MAMA keeps different authorities separate:

- `mama-memory.db`: memory, connector evidence, model/tool traces, Cases, principals;
- `mama-sessions.db`: messenger sessions, channel messages, agent activity;
- `operator/triggers.db`: owner events, workorders, temporal state, effects;
- workspace files: inbound media and generated artifacts;
- delivery ledgers: local proof of external sends.

Redis is not required for the current one-daemon deployment. Durable work remains in SQLite and
live in-process updates use local queues, events, or SSE.

## Work and recovery

Work that can outlive one model turn is represented by durable rows before the side effect occurs.

- Owner events are persisted before connector cursors advance.
- Workorders have explicit status and retry behavior.
- External effects reserve an occurrence before transmission.
- Delivered results require a local or provider receipt.
- Restart recovery uses durable state instead of regenerating successful mutations.

Model prose is not a receipt.

## Human-team direction

Current releases are owner-first. The v1 team direction adds human principals with explicit scope
and action grants while preserving one MAMA front.

```text
principal grants
∩ connector/source authority
∩ active Case/artifact scope
∩ tool envelope
= effective scope
```

The next access foundation is Phase 2b. Shared Work Cases and real multi-human artifact workflows
build on it. See [The Work Agent Behind Your Messenger](work-agent.md) and the normative
[One-Front Team Work Agent design](../development/2026-08-26-one-front-team-work-agent-design.md).

## Security boundary

MAMA runs on the operator's machine and can reach only what its host configuration and credentials
allow. A messenger sender does not inherit owner power merely by reaching the bot.

- Sender identity is resolved before model execution.
- Private media paths are host verified.
- Context and tools are narrowed by the active authority.
- Mutation and external delivery require explicit authority and receipts.
- Private memory is not a shared-team default.

For operational configuration, see [Standalone Setup](../guides/standalone-setup.md). For security
details, see [Security](../guides/security.md).
