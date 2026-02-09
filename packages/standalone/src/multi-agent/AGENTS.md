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
Wave 2: Planning (Tier 1 agent: Sisyphus)
  ↓
Wave 3: Implementation (Tier 2 agents: Developer, Coder)
  ↓
Wave 4: Review (Tier 3 agents: Reviewer, QA)
  ↓
Wave 5: Completion (Tier 1 agent: Sisyphus)
```

**Tier Access Control:**

- **Tier 1:** Full tool access (file write, command execution, delegation)
- **Tier 2:** Read-only + limited writes (implementation tasks)
- **Tier 3:** Read-only (review, analysis, testing)

---

## KEY FILES

| File                             | Purpose                                       |
| -------------------------------- | --------------------------------------------- |
| `swarm-manager.ts`               | Orchestrates wave progression and delegation  |
| `swarm-task-runner.ts`           | Executes tasks within wave constraints        |
| `wave-engine.ts`                 | Wave state machine and transitions            |
| `swarm-anti-pattern-detector.ts` | Prevents delegation loops and tier violations |
| `agent-personas.ts`              | Agent definitions (Sisyphus, Developer, etc.) |

---

## TASK DELEGATION PATTERN

```typescript
// Agent requests delegation via special syntax
`DELEGATE::Developer::Implement authentication module`;

// Swarm manager parses and routes to appropriate tier
swarmManager.delegate('Developer', 'Implement authentication module', currentWave);
```

**Anti-Pattern Detection:**

- Blocks delegation loops (A→B→A)
- Enforces tier boundaries (Tier 3 cannot delegate to Tier 1)
- Prevents wave regression (Wave 4 cannot return to Wave 2)
