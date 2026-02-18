# MULTI-AGENT SWARM ORCHESTRATION

**Generated:** 2026-02-08  
**Location:** packages/standalone/src/multi-agent/

---

## OVERVIEW

Wave-based multi-agent orchestration for Discord/Slack/Telegram. Sequential 5-wave progression enables tier-based access control and prevents delegation loops.

---

## WAVE PROGRESSION MODEL

```
Wave 1: Initial Analysis (read-only, all tiers)
  ↓
Wave 2: Planning (Tier 1 agent: conductor)
  ↓
Wave 3: Implementation (Tier 2 agents: developer, coder)
  ↓
Wave 4: Review (Tier 3 agents: reviewer, qa)
  ↓
Wave 5: Completion (Tier 1 agent: conductor)
```

**Tier Access Control:**

- **Tier 1:** Full tool access (file write, command execution, delegation)
- **Tier 2:** Read-only + limited writes (implementation tasks)
- **Tier 3:** Read-only (review, analysis, testing)

---

## KEY FILES

| File                                   | Purpose                                                         |
| -------------------------------------- | --------------------------------------------------------------- |
| `orchestrator.ts`                      | Routes messages to agents (explicit/category/keyword/default)   |
| `delegation-manager.ts`                | Parses and executes `DELEGATE::...` requests                    |
| `tool-permission-manager.ts`           | Tier/tool permission prompts and enforcement                    |
| `types.ts`                             | Multi-agent config types (`agents`, `mention_delegation`, etc.) |
| `swarm/swarm-manager.ts`               | Swarm session DB + progress tracking                            |
| `swarm/swarm-task-runner.ts`           | Executes tasks within wave constraints                          |
| `swarm/wave-engine.ts`                 | Wave state machine and transitions                              |
| `swarm/swarm-anti-pattern-detector.ts` | Prevents delegation loops and tier violations                   |

---

## TASK DELEGATION PATTERN

```text
DELEGATE::{agent_id}::{task description}
DELEGATE_BG::{agent_id}::{task description}
```

Notes:

- `{agent_id}` is the internal agent id (e.g. `developer`, `reviewer`, `pm`) and is **case-sensitive**.
- `{agent_id}` must match the key in `config.yaml` under `multi_agent.agents`.

### Discord Mention Requirements (Delegation Trigger)

Delegation text is only parsed if the Discord gateway processes the message.

- If the channel/guild config has `requireMention: true`, normal messages without an @mention are ignored.
- Delegation commands are treated as explicit triggers: if any line starts with `DELEGATE::` / `DELEGATE_BG::`, it will still be processed (even without an @mention).
- Including the bot mention is still OK and makes intent obvious:

```text
<@BOT_ID> DELEGATE::developer::Implement authentication module
```

- Recommended: use a dedicated swarm/bot channel with `requireMention: false` so `DELEGATE::...` works without @mentions, and keep `requireMention: true` for public channels to avoid spam.

**Anti-Pattern Detection:**

- Blocks delegation loops (A→B→A)
- Enforces tier boundaries (Tier 3 cannot delegate to Tier 1)
- Prevents wave regression (Wave 4 cannot return to Wave 2)

---

## ULTRAWORK 3-PHASE LOOP (Ralph Loop)

Autonomous multi-step sessions using structured Plan→Build→Retrospective phases.

```text
Phase 1: PLANNING
  └─ Conductor creates implementation plan
  └─ Optional Council discussion (council_plan block)
  └─ Plan persisted → plan.md

Phase 2: BUILDING
  └─ Conductor delegates tasks from plan (DELEGATE::)
  └─ Each step → progress.json
  └─ Council escalation on failures
  └─ BUILD_COMPLETE marker → next phase

Phase 3: RETROSPECTIVE
  └─ Reviews completed work against plan
  └─ Council discussion for quality review
  └─ RETRO_COMPLETE → session ends
  └─ RETRO_INCOMPLETE → Phase 2 re-entry (max 1 retry)
```

**Key Files:**

| File                 | Purpose                             |
| -------------------- | ----------------------------------- |
| `ultrawork.ts`       | Session loop, 3-phase orchestration |
| `ultrawork-state.ts` | File-based state persistence (CRUD) |

**State Directory:** `~/.mama/workspace/ultrawork/{session_id}/`

| File               | Content                             |
| ------------------ | ----------------------------------- |
| `session.json`     | id, task, phase, agents, timestamps |
| `plan.md`          | Planning phase output               |
| `progress.json`    | Array of step records               |
| `retrospective.md` | Retrospective phase output          |

**Config (`multi_agent.ultrawork`):**

- `phased_loop: true` — enables 3-phase loop (false = legacy freeform)
- `persist_state: true` — enables file-based state persistence
- `max_steps: 20` — safety limit
- `max_duration: 1800000` — 30 min timeout
