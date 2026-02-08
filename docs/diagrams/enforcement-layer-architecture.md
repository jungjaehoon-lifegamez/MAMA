# Enforcement Layer Architecture Diagrams

**Purpose:** Visual reference for the Enforcement Layer implementation (ADR-001)  
**Target:** `packages/standalone/src/enforcement/`  
**Integration Points:** Multi-agent orchestrator, gateway handlers, shared context

---

## Diagram 1: Hook Lifecycle Flow

Shows the complete message processing lifecycle in MAMA's multi-agent system, from Discord message to final response.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        MESSAGE PROCESSING LIFECYCLE                      │
└─────────────────────────────────────────────────────────────────────────┘

Discord Message
      │
      ▼
┌──────────────────┐
│  Gateway Handler │  (packages/standalone/src/gateways/discord.ts)
│  (Discord Bot)   │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Message Router  │  (packages/standalone/src/gateways/message-router.ts)
│  (5-Stage)       │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Orchestrator    │  (packages/standalone/src/multi-agent/orchestrator.ts)
│  (Agent Select)  │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Agent Process   │  (packages/standalone/src/multi-agent/agent-process-pool.ts)
│  (Claude CLI)    │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Agent Response  │  Raw text output from Claude CLI subprocess
│  (Raw Text)      │
└────────┬─────────┘
         │
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         ENFORCEMENT LAYER                                │
│                  (packages/standalone/src/enforcement/)                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  ResponseValidator                                               │   │
│  │  (enforcement/response-validator.ts)                             │   │
│  │                                                                   │   │
│  │  • Flattery pattern detection (KR/EN)                            │   │
│  │  • Token ratio calculation (flattery / total)                    │   │
│  │  • Threshold check (20% default)                                 │   │
│  │  • Context-aware (agent-to-agent vs human-facing)                │   │
│  └────────┬──────────────────────────────────────────────────────────┘   │
│           │                                                               │
│           ├─ REJECT → inject retry prompt → re-invoke agent              │
│           │                                                               │
│           └─ PASS                                                         │
│                │                                                          │
│                ▼                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  ReviewGate                                                      │   │
│  │  (enforcement/review-gate.ts)                                    │   │
│  │                                                                   │   │
│  │  • APPROVE/승인 pattern detection                                 │   │
│  │  • Evidence extraction (tests pass, verified, checked)           │   │
│  │  • Evidence requirement enforcement                              │   │
│  └────────┬──────────────────────────────────────────────────────────┘   │
│           │                                                               │
│           ├─ REJECT → "APPROVE requires evidence. What did you verify?"  │
│           │                                                               │
│           └─ PASS                                                         │
│                │                                                          │
│                ▼                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  ScopeGuard                                                      │   │
│  │  (enforcement/scope-guard.ts)                                    │   │
│  │                                                                   │   │
│  │  • Scope creep detection (task vs response alignment)            │   │
│  │  • Warning injection (flag but continue)                         │   │
│  └────────┬──────────────────────────────────────────────────────────┘   │
│           │                                                               │
│           └─ WARNING → flag but continue                                 │
│                │                                                          │
│                ▼                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  TodoTracker                                                     │   │
│  │  (enforcement/todo-tracker.ts)                                   │   │
│  │                                                                   │   │
│  │  • Incomplete task detection (continuation markers)              │   │
│  │  • Queue reminder for next turn                                  │   │
│  └────────┬──────────────────────────────────────────────────────────┘   │
│           │                                                               │
│           └─ QUEUE → reminder for next turn                              │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────┐
│  Shared Context  │  (packages/standalone/src/multi-agent/shared-context.ts)
│  (Record)        │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Discord Post    │  Final message sent to Discord channel
│  (Final Output)  │
└──────────────────┘
```

**Key Decision Points:**

- **ResponseValidator:** Rejects flattery-heavy responses (agent-to-agent only)
- **ReviewGate:** Blocks APPROVE without evidence
- **ScopeGuard:** Warns on scope creep but allows continuation
- **TodoTracker:** Queues reminders for incomplete tasks

---

## Diagram 2: ResponseValidator Flow

Detailed validation pipeline for agent responses, with context-aware flattery detection.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      RESPONSE VALIDATOR PIPELINE                         │
│                  (enforcement/response-validator.ts)                     │
└─────────────────────────────────────────────────────────────────────────┘

Agent Response (raw text)
      │
      ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Context Check: Is this agent-to-agent communication?                │
│                                                                       │
│  • Check delegation context (DELEGATE:: marker in history)           │
│  • Check SharedContext for recent agent messages                     │
│  • Check if response is a reply to another agent                     │
└────────┬──────────────────────────────────────────────────────────────┘
         │
         ├─────────────────────────────────────────────────────────────┐
         │                                                              │
         ▼                                                              ▼
┌─────────────────────────┐                              ┌─────────────────────────┐
│  Agent-to-Agent         │                              │  Human-Facing           │
│  (Strict Validation)    │                              │  (Lenient Validation)   │
└────────┬────────────────┘                              └────────┬────────────────┘
         │                                                         │
         ▼                                                         ▼
┌─────────────────────────┐                              ┌─────────────────────────┐
│  Flattery Detection     │                              │  Skip Flattery Check    │
│                         │                              │                         │
│  Korean Patterns:       │                              │  Some politeness is     │
│  • "훌륭한 분석"         │                              │  acceptable in human    │
│  • "완벽한 구현"         │                              │  communication          │
│  • "정말 잘하셨"         │                              │                         │
│  • "대단한 작업"         │                              │  Only check:            │
│  • "멋진 코드"           │                              │  • Completeness markers │
│                         │                              │  • Task alignment       │
│  English Patterns:      │                              │                         │
│  • "excellent work"     │                              └────────┬────────────────┘
│  • "great job"          │                                       │
│  • "perfect"            │                                       │
│  • "amazing"            │                                       │
│  • "brilliant"          │                                       │
│  • "well done"          │                                       │
└────────┬────────────────┘                                       │
         │                                                         │
         ▼                                                         │
┌─────────────────────────┐                                       │
│  Token Ratio Calc       │                                       │
│                         │                                       │
│  flattery_tokens = 15   │                                       │
│  total_tokens = 50      │                                       │
│  ratio = 15/50 = 30%    │                                       │
└────────┬────────────────┘                                       │
         │                                                         │
         ▼                                                         │
┌─────────────────────────┐                                       │
│  Threshold Check        │                                       │
│                         │                                       │
│  ratio > 20%?           │                                       │
└────────┬────────────────┘                                       │
         │                                                         │
         ├─ YES ──────────────────────────────────────────────────┤
         │                                                         │
         ▼                                                         │
┌─────────────────────────┐                                       │
│  REJECT                 │                                       │
│                         │                                       │
│  Inject retry prompt:   │                                       │
│  "Your response was     │                                       │
│   30% flattery. Focus   │                                       │
│   on technical content  │                                       │
│   only. Retry."         │                                       │
└────────┬────────────────┘                                       │
         │                                                         │
         ▼                                                         │
┌─────────────────────────┐                                       │
│  Re-invoke Agent        │                                       │
│                         │                                       │
│  • Append retry prompt  │                                       │
│  • Increment retry count│                                       │
│  • Max retries: 2       │                                       │
└─────────────────────────┘                                       │
         │                                                         │
         │                                                         │
         ├─ NO ───────────────────────────────────────────────────┤
         │                                                         │
         ▼                                                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  PASS                                                            │
│                                                                  │
│  Output: validated response (original text)                     │
└──────────────────────────────────────────────────────────────────┘
```

**Configuration:**

```typescript
// enforcement/config.ts
export const FLATTERY_THRESHOLD = 0.2; // 20% max flattery tokens
export const MAX_RETRIES = 2;

export const FLATTERY_PATTERNS = {
  korean: [
    /훌륭한\s*분석/gi,
    /완벽한\s*구현/gi,
    /정말\s*잘하셨/gi,
    /대단한\s*작업/gi,
    /멋진\s*코드/gi,
  ],
  english: [
    /excellent\s+work/gi,
    /great\s+job/gi,
    /\bperfect\b/gi,
    /\bamazing\b/gi,
    /\bbrilliant\b/gi,
    /well\s+done/gi,
  ],
};
```

---

## Diagram 3: ReviewGate Sequence

APPROVE verification flow with evidence requirement enforcement.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         REVIEW GATE SEQUENCE                             │
│                    (enforcement/review-gate.ts)                          │
└─────────────────────────────────────────────────────────────────────────┘

Reviewer Response (raw text)
      │
      ▼
┌──────────────────────────────────────────────────────────────────────┐
│  APPROVE Pattern Detection                                            │
│                                                                       │
│  Korean Patterns:                                                     │
│  • "승인"                                                              │
│  • "APPROVE"                                                          │
│  • "통과"                                                              │
│  • "OK"                                                               │
│                                                                       │
│  English Patterns:                                                    │
│  • "APPROVE"                                                          │
│  • "APPROVED"                                                         │
│  • "LGTM" (Looks Good To Me)                                          │
│  • "PASS"                                                             │
└────────┬──────────────────────────────────────────────────────────────┘
         │
         ├─────────────────────────────────────────────────────────────┐
         │                                                              │
         ▼                                                              ▼
┌─────────────────────────┐                              ┌─────────────────────────┐
│  Contains APPROVE?      │                              │  No APPROVE keyword     │
│  (YES)                  │                              │  (NO)                   │
└────────┬────────────────┘                              └────────┬────────────────┘
         │                                                         │
         ▼                                                         │
┌─────────────────────────┐                                       │
│  Extract Evidence       │                                       │
│                         │                                       │
│  Evidence Patterns:     │                                       │
│  • "tests pass"         │                                       │
│  • "테스트 통과"         │                                       │
│  • "verified"           │                                       │
│  • "확인했"              │                                       │
│  • "checked"            │                                       │
│  • "검증했"              │                                       │
│  • "build success"      │                                       │
│  • "빌드 성공"           │                                       │
│  • "ran"                │                                       │
│  • "실행했"              │                                       │
│  • "output shows"       │                                       │
│  • "결과 확인"           │                                       │
└────────┬────────────────┘                                       │
         │                                                         │
         ▼                                                         │
┌─────────────────────────┐                                       │
│  Evidence Found?        │                                       │
└────────┬────────────────┘                                       │
         │                                                         │
         ├─ YES ──────────────────────────────────────────────────┤
         │                                                         │
         ▼                                                         │
┌─────────────────────────┐                                       │
│  APPROVE with Evidence  │                                       │
│                         │                                       │
│  Example:               │                                       │
│  "APPROVE - I verified  │                                       │
│   the tests pass and    │                                       │
│   build succeeds."      │                                       │
│                         │                                       │
│  Action: ALLOW          │                                       │
└─────────────────────────┘                                       │
         │                                                         │
         │                                                         │
         ├─ NO ───────────────────────────────────────────────────┤
         │                                                         │
         ▼                                                         │
┌─────────────────────────┐                                       │
│  REJECT                 │                                       │
│                         │                                       │
│  Inject feedback:       │                                       │
│  "APPROVE requires      │                                       │
│   evidence. What did    │                                       │
│   you verify?           │                                       │
│                         │                                       │
│   Examples:             │                                       │
│   • 'tests pass'        │                                       │
│   • 'verified output'   │                                       │
│   • 'checked logs'      │                                       │
│   • 'build succeeds'    │                                       │
│                         │                                       │
│   Please retry with     │                                       │
│   specific evidence."   │                                       │
└────────┬────────────────┘                                       │
         │                                                         │
         ▼                                                         │
┌─────────────────────────┐                                       │
│  Re-invoke Reviewer     │                                       │
│                         │                                       │
│  • Append feedback      │                                       │
│  • Increment retry count│                                       │
│  • Max retries: 2       │                                       │
└─────────────────────────┘                                       │
         │                                                         │
         │                                                         │
         ▼                                                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  PASS                                                            │
│                                                                  │
│  Output: validated response (original text)                     │
└──────────────────────────────────────────────────────────────────┘
```

**Configuration:**

```typescript
// enforcement/config.ts
export const APPROVE_PATTERNS = {
  korean: [/승인/gi, /통과/gi, /\bOK\b/gi],
  english: [/\bAPPROVE\b/gi, /\bAPPROVED\b/gi, /\bLGTM\b/gi, /\bPASS\b/gi],
};

export const EVIDENCE_PATTERNS = {
  korean: [/테스트\s*통과/gi, /확인했/gi, /검증했/gi, /빌드\s*성공/gi, /실행했/gi, /결과\s*확인/gi],
  english: [
    /tests?\s+pass/gi,
    /verified/gi,
    /checked/gi,
    /build\s+success/gi,
    /\bran\b/gi,
    /output\s+shows/gi,
  ],
};
```

**Example Interactions:**

```
❌ REJECTED:
Reviewer: "APPROVE - looks good!"
ReviewGate: "APPROVE requires evidence. What did you verify?"

✅ APPROVED:
Reviewer: "APPROVE - I ran the tests and they all pass. Build succeeds."
ReviewGate: PASS (evidence: "ran the tests", "pass", "Build succeeds")

✅ APPROVED (Korean):
Reviewer: "승인 - 테스트 통과 확인했습니다. 빌드 성공."
ReviewGate: PASS (evidence: "테스트 통과", "확인했", "빌드 성공")

✅ PASS THROUGH (not an approval):
Reviewer: "I found 3 issues in the code..."
ReviewGate: PASS (no APPROVE keyword, no enforcement)
```

---

## Integration Points

### 1. Multi-Agent Orchestrator

**File:** `packages/standalone/src/multi-agent/orchestrator.ts`

**Integration:**

```typescript
// After agent responds, before recording to SharedContext
const validatedResponse = await enforcementLayer.validate({
  response: agentResponse,
  agentId: agent.id,
  context: messageContext,
});

if (validatedResponse.rejected) {
  // Re-invoke agent with feedback
  return this.retryWithFeedback(agent, validatedResponse.feedback);
}

// Continue with validated response
sharedContext.recordAgentMessage(channelId, agent, validatedResponse.text);
```

### 2. Gateway Handlers

**Files:**

- `packages/standalone/src/gateways/discord.ts`
- `packages/standalone/src/gateways/slack.ts`
- `packages/standalone/src/gateways/telegram.ts`

**Integration:**

```typescript
// Before posting to Discord
const enforcedResponse = await enforcementLayer.enforce({
  response: agentResponse,
  agentId: agent.id,
  channelId: message.channelId,
});

// Post to Discord
await message.channel.send(enforcedResponse.text);
```

### 3. Shared Context

**File:** `packages/standalone/src/multi-agent/shared-context.ts`

**Integration:**

```typescript
// Only record validated responses
recordAgentMessage(
  channelId: string,
  agent: AgentPersonaConfig,
  validatedContent: string, // Already passed enforcement
  messageId?: string
): void {
  // Record to context
}
```

---

## File Structure (Planned)

```
packages/standalone/src/enforcement/
├── index.ts                    # Public API exports
├── config.ts                   # Pattern configs, thresholds
├── response-validator.ts       # Flattery detection
├── review-gate.ts              # APPROVE evidence enforcement
├── scope-guard.ts              # Scope creep detection
├── todo-tracker.ts             # Incomplete task tracking
├── enforcement-layer.ts        # Orchestrates all validators
└── types.ts                    # TypeScript interfaces
```

---

## Notes

- **ASCII art style:** Works in any markdown renderer (no Mermaid dependency)
- **File paths:** Included for each component (planned locations)
- **Error paths:** Clearly marked with rejection flows
- **Bilingual support:** Korean and English patterns throughout
- **Context-aware:** Agent-to-agent vs human-facing validation
- **Retry logic:** Max 2 retries per validation failure
- **Evidence requirement:** APPROVE must include verification details

---

**Related Documents:**

- [ADR-001: Enforcement Layer](../adr/001-enforcement-layer.md)
- [Multi-Agent Architecture](../architecture-mama-swarm-2026-02-06.md)
- [Shared Context API](../../packages/standalone/src/multi-agent/shared-context.ts)

**Last Updated:** 2026-02-08  
**Author:** SpineLift Team
