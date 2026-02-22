# Multi-Agent Advanced Features Guide

**Category:** Guide (Task-Oriented)
**Audience:** Users who want to leverage advanced features of the Multi-Agent swarm

---

## Council Engine

A structured multi-agent discussion system. When the Conductor generates a `council_plan` block, the designated agents engage in round-by-round sequential discussions.

### Configuration

```yaml
multi_agent:
  council:
    enabled: true
    max_rounds: 5 # Maximum number of discussion rounds
    max_duration_ms: 600000 # Overall timeout (10 minutes)
```

### Trigger

Automatically executed when the Conductor includes a `council_plan` JSON block in its response:

```json
{
  "name": "Database Selection Discussion",
  "topic": "PostgreSQL vs MongoDB: Which DB is suitable for microservices?",
  "agents": ["developer", "reviewer"],
  "rounds": 2,
  "synthesis": true
}
```

### Execution Flow

1. Conductor generates `council_plan` -> System validates agent existence
2. For each round:
   - All participating agents speak in order
   - The full conversation from previous rounds is passed as context
   - 3-minute timeout per agent
3. A summary of the entire discussion is generated

### Constraints

- Maximum 5 rounds (configurable)
- Overall 10-minute timeout (configurable, can also be specified via `timeout_ms` in the plan)
- If one agent fails, the remaining agents continue

---

## Dynamic Workflow DAG

When the Conductor defines tasks as a DAG (Directed Acyclic Graph), ephemeral (temporary) agents are created and executed in parallel/sequential order based on dependencies.

### Configuration

```yaml
multi_agent:
  workflow:
    enabled: true
    max_ephemeral_agents: 20 # Maximum number of ephemeral agents
    max_duration_ms: 600000 # Overall timeout (10 minutes)
    max_concurrent_steps: 3 # Number of concurrent steps
    backend_balancing: true # Claude <-> Codex round-robin
```

### Conductor Output Example

```json
{
  "name": "Code Review Workflow",
  "steps": [
    {
      "id": "analyze",
      "agent": {
        "id": "analyzer-1",
        "display_name": "Code Analyzer",
        "backend": "claude",
        "model": "claude-opus-4-6",
        "system_prompt": "An expert in analyzing code structure."
      },
      "prompt": "Analyze the file structure"
    },
    {
      "id": "implement",
      "agent": {
        "id": "coder-1",
        "display_name": "Developer",
        "backend": "codex-mcp",
        "model": "codex-model",
        "system_prompt": "Implements code changes."
      },
      "prompt": "Implement based on analysis results: {{analyze.result}}",
      "depends_on": ["analyze"]
    }
  ],
  "synthesis": {
    "prompt_template": "Synthesize all results: {{analyze.result}}, {{implement.result}}"
  }
}
```

### Key Concepts

- **Ephemeral Agent**: A temporary agent that exists only during workflow execution. Uses an inline `system_prompt`
- **Result Interpolation**: Inject previous step results into the next step's prompt using `{{step_id.result}}`
- **Level-Based Parallel Execution**: Steps at the same dependency level run concurrently
- **Optional Steps**: Setting `"optional": true` allows the next step to proceed even if the current one fails

### Constraints

- Maximum 5 steps per workflow
- Step timeout: 5 minutes (default, changeable via `timeout_ms`)
- Cyclic dependencies are not allowed (DAG validation)

---

## Swarm DB & Wave Engine

A SQLite-based persistent task queue that supports sequential-parallel execution in Wave units.

### Wave Execution Model

```text
Wave 1: [Task A, Task B, Task C]  <- Parallel execution
         | After all complete
Wave 2: [Task D, Task E]          <- Parallel execution
         | After all complete
Wave 3: [Task F]                  <- Solo execution
```

- Tasks within a Wave are executed in parallel
- Waves are executed sequentially
- Failed tasks do not block the next Wave (fail-forward)

### Task States

```text
pending -> claimed -> completed
                   -> failed -> (retry) -> pending
```

### Key Features

- **Atomic Task Claiming**: Prevents duplicate execution via SQLite transactions
- **Stale Lease Expiration**: Automatically released after 15 minutes if an agent crashes
- **File Ownership Tracking**: Detects file conflicts between concurrent tasks
- **Dependency Resolution**: Propagates to dependent tasks of failed tasks
- **Retry**: Resets failed tasks to pending

### Database Schema

```sql
CREATE TABLE swarm_tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  priority INTEGER DEFAULT 0,
  wave INTEGER NOT NULL,
  status TEXT DEFAULT 'pending',
  claimed_by TEXT,
  files_owned TEXT,    -- JSON array
  depends_on TEXT,     -- JSON array
  retry_count INTEGER DEFAULT 0
);
```

---

## UltraWork Autonomous Sessions

Performs autonomous multi-step tasks using a 3-phase Ralph Loop.

### Trigger

```yaml
ultrawork:
  enabled: true
  trigger_keywords: [ultrawork, deep work, autonomous, 울트라워크]
  max_steps: 20
  max_duration: 1800000 # 30 minutes
```

Automatically executed when a user message contains a trigger keyword:

```
ULTRAWORK: Implement OAuth2 authentication module
```

### 3-Phase Execution

**Phase 1: PLANNING**

- Conductor analyzes the task and generates a plan
- Multi-perspective review via Council discussion (optional)
- Output: `~/.mama/workspace/ultrawork/{session_id}/plan.md`

**Phase 2: BUILDING**

- Conductor delegates plan tasks using the `DELEGATE::` pattern
- Records each step's result in `progress.json`
- Continues until `BUILD_COMPLETE` marker or max_steps is reached

**Phase 3: RETROSPECTIVE**

- Reviews completed work against the original plan
- Quality evaluation via Council discussion
- `RETRO_COMPLETE` -> Session ends
- `RETRO_INCOMPLETE` -> Re-enters Phase 2 (maximum 1 time)

### State Persistence

```text
~/.mama/workspace/ultrawork/{session_id}/
├── session.json       # Metadata, current phase
├── plan.md            # Phase 1 plan
├── progress.json      # Per-step result array
└── retrospective.md   # Phase 3 retrospective
```

On process crash, when the next session is created, stale sessions are detected and can be recovered from the last checkpoint.

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

| Tier       | Access Scope                              | Use Case              |
| ---------- | ----------------------------------------- | --------------------- |
| **Tier 1** | All tools (Read, Edit, Write, Bash, etc.) | Conductor, Developer  |
| **Tier 2** | Read-only + limited write                 | Implementer           |
| **Tier 3** | Custom tool list only                     | Reviewer, QA, Analyst |

---

## Hot-reload

When `updateConfig()` is called, it restarts the process pools to apply new configuration.

### Items That Are Reloaded

- Agent definitions (personas, tiers, permissions)
- Model assignments
- Delegation rules
- Tool permissions
- Channel overrides
- UltraWork/task-continuation settings

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

## Reference Files

- Multi-Agent overall: `packages/standalone/src/multi-agent/`
- Council Engine: `packages/standalone/src/multi-agent/council-engine.ts`
- Workflow Engine: `packages/standalone/src/multi-agent/workflow-engine.ts`
- Swarm DB: `packages/standalone/src/multi-agent/swarm/swarm-db.ts`
- Wave Engine: `packages/standalone/src/multi-agent/swarm/wave-engine.ts`
- UltraWork: `packages/standalone/src/multi-agent/ultrawork.ts`
- Persona examples: `packages/standalone/templates/personas/`
- Internal reference: `packages/standalone/src/multi-agent/AGENTS.md`
