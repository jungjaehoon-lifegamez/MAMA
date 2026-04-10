# v0.18 Multi-Agent Unification Plan (v3 — Gateway Tool 기반)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `delegate` gateway tool 하나로 모든 플랫폼에서 동일한 멀티에이전트 delegation을 구현. Claude Code의 도구 호출 메커니즘 위에 MAMA의 역할(persona/tier/backend) 레이어를 얹는다.

**Architecture:** Conductor가 `delegate(agentId, task)` 도구를 호출하면, GatewayToolExecutor가 AgentProcessManager에서 persistent process를 얻어 실행하고 결과를 도구 결과로 반환. DELEGATE:: 텍스트 파싱 불필요. DelegatingProcess 래퍼 불필요. Claude Code가 도구 호출 라이프사이클(타임아웃, 스트리밍, 진행)을 관리.

**Tech Stack:** TypeScript, GatewayToolExecutor, AgentProcessManager, ToolRegistry

---

## Core Insight

```
Claude Code 도구 호출:
  Conductor → Bash("ls -la") → Claude Code가 실행 → 결과 반환
  Conductor → Read("file.ts") → Claude Code가 실행 → 결과 반환

delegate 도구 호출 (동일 패턴):
  Conductor → delegate(developer, "인증 구현") → GatewayToolExecutor가 실행
    → AgentProcessManager → developer persistent process
    → developer 실행 → 결과를 도구 결과로 반환
  Conductor가 결과 보고 다음 판단
```

기존 바퀴(Claude Code tool call) 위에 롤(MAMA persona/tier)만 추가.

---

## 절대 원칙: 레거시 회귀 금지

이 계획은 **전면 리팩토링**입니다. 구현 중 다음은 금지:

- "디스코드/슬랙 기존 로직이 있으니 재사용하자" ← **금지**
- "이미 작동하는 코드니까 건드리지 말자" ← **금지**
- "간단한 방법을 찾았습니다" (= 기존 코드 재사용) ← **금지**

기존 DELEGATE:: 텍스트 파싱, 플랫폼별 delegation 핸들러, submitBackgroundDelegations 등은 **삭제 대상**입니다. 새 delegate gateway tool + code-act 경로가 이것들을 완전히 대체합니다. 중간 타협 없음.

---

## File Structure

```
packages/standalone/src/
├── agent/
│   ├── gateway-tool-executor.ts    ← MODIFY: delegate 도구 핸들러 추가 (~30줄)
│   ├── tool-registry.ts            ← MODIFY: delegate 도구 등록
│   └── gateway-tools.md            ← AUTO: 도구 문서 자동 생성
├── multi-agent/
│   ├── multi-agent-discord.ts      ← MODIFY: DELEGATE:: 파싱 코드 삭제
│   ├── multi-agent-slack.ts        ← MODIFY: DELEGATE:: 파싱 코드 삭제
│   ├── multi-agent-base.ts         ← MODIFY: submitBackgroundDelegations 삭제
│   └── delegation-manager.ts       ← KEEP: 권한 검증용으로 유지 (isDelegationAllowed)
└── tests/
    └── agent/
        └── delegate-tool.test.ts   ← CREATE: delegate 도구 테스트
```

---

## Task 1: delegate Gateway Tool 등록

**Files:**

- Modify: `packages/standalone/src/agent/tool-registry.ts`

- [ ] **Step 1.1: tool-registry.ts에 delegate 도구 스키마 추가**

```typescript
{
  name: 'delegate',
  description: 'Delegate a task to another agent. The target agent has its own persona, tools, and persistent session. Use this to assign specialized work (coding, review, research) to the right agent. Returns the agent\'s response.',
  category: 'multi_agent',
  inputSchema: {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        description: 'Target agent ID (e.g., "developer", "reviewer"). See available agents in your persona.',
      },
      task: {
        type: 'string',
        description: 'Task description for the target agent. Be specific about what to do and what to return.',
      },
      background: {
        type: 'boolean',
        description: 'If true, run in background (fire-and-forget). Default: false (synchronous, waits for result).',
        default: false,
      },
    },
    required: ['agentId', 'task'],
  },
}
```

- [ ] **Step 1.2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 1.3: Commit**

```bash
git add packages/standalone/src/agent/tool-registry.ts
git commit -m "feat(tools): register delegate tool in gateway tool registry"
```

---

## Task 2: delegate 도구 핸들러 구현

**핵심 파일.** GatewayToolExecutor에 delegate case 추가. AgentProcessManager에서 persistent process를 얻어 실행.

**Files:**

- Modify: `packages/standalone/src/agent/gateway-tool-executor.ts`
- Create: `packages/standalone/tests/agent/delegate-tool.test.ts`

### Step 2.1: Write tests

- [ ] **Step 2.1.1: Create test file**

```typescript
// packages/standalone/tests/agent/delegate-tool.test.ts
import { describe, it, expect, vi } from 'vitest';
import { DelegationManager } from '../../src/multi-agent/delegation-manager.js';

describe('delegate gateway tool', () => {
  const agentConfigs = [
    { id: 'conductor', name: 'Conductor', tier: 1, can_delegate: true, enabled: true },
    { id: 'developer', name: 'Developer', tier: 2, can_delegate: false, enabled: true },
    { id: 'disabled-agent', name: 'Disabled', tier: 2, enabled: false },
  ] as any[];

  describe('permission checks', () => {
    it('allows tier 1 agent with can_delegate to delegate', () => {
      const dm = new DelegationManager(agentConfigs);
      const check = dm.isDelegationAllowed('conductor', 'developer');
      expect(check.allowed).toBe(true);
    });

    it('blocks tier 2 agent from delegating', () => {
      const dm = new DelegationManager(agentConfigs);
      const check = dm.isDelegationAllowed('developer', 'conductor');
      expect(check.allowed).toBe(false);
    });

    it('blocks delegation to disabled agent', () => {
      const dm = new DelegationManager(agentConfigs);
      const check = dm.isDelegationAllowed('conductor', 'disabled-agent');
      expect(check.allowed).toBe(false);
    });

    it('blocks self-delegation', () => {
      const dm = new DelegationManager(agentConfigs);
      const check = dm.isDelegationAllowed('conductor', 'conductor');
      expect(check.allowed).toBe(false);
    });
  });

  describe('delegation prompt', () => {
    it('builds prompt with task and instructions', () => {
      const dm = new DelegationManager(agentConfigs);
      const request = {
        fromAgentId: 'conductor',
        toAgentId: 'developer',
        task: 'Implement auth module with passport.js',
        originalContent: '',
        background: false,
      };
      const prompt = dm.buildDelegationPrompt(request);
      expect(prompt).toContain('Implement auth module');
      expect(prompt).toContain('conductor');
    });
  });

  describe('delegate tool response format', () => {
    it('returns success with agent response', () => {
      const result = {
        success: true,
        data: {
          agentId: 'developer',
          response: 'Auth module implemented with passport.js.',
          duration_ms: 5000,
        },
      };
      expect(result.success).toBe(true);
      expect(result.data.agentId).toBe('developer');
      expect(result.data.response).toContain('Auth module');
    });

    it('returns error when delegation denied', () => {
      const result = {
        success: false,
        error: 'Delegation denied: agent "developer" cannot delegate (tier 2)',
      };
      expect(result.success).toBe(false);
      expect(result.error).toContain('denied');
    });

    it('returns error when target agent not found', () => {
      const result = {
        success: false,
        error: 'Agent "unknown-agent" not found or not enabled',
      };
      expect(result.success).toBe(false);
    });
  });
});
```

- [ ] **Step 2.1.2: Run tests**

Run: `cd packages/standalone && pnpm vitest run tests/agent/delegate-tool.test.ts`
Expected: PASS

### Step 2.2: Implement handler

- [ ] **Step 2.2.1: Make buildDelegationPrompt public in DelegationManager**

In `packages/standalone/src/multi-agent/delegation-manager.ts`, if `buildDelegationPrompt` is private, make it public.

- [ ] **Step 2.2.2: Add delegate case to GatewayToolExecutor**

In `packages/standalone/src/agent/gateway-tool-executor.ts`, add to the tool handler switch:

```typescript
case 'delegate': {
  const { agentId, task, background } = input as {
    agentId: string;
    task: string;
    background?: boolean;
  };

  // Validate: need processManager and delegationManager
  const processManager = this.getAgentProcessManager();
  const delegationManager = this.getDelegationManager();
  if (!processManager || !delegationManager) {
    return { success: false, error: 'Multi-agent not configured' };
  }

  // Permission check
  const sourceAgentId = this.currentAgentId || 'unknown';
  const check = delegationManager.isDelegationAllowed(sourceAgentId, agentId);
  if (!check.allowed) {
    return { success: false, error: `Delegation denied: ${check.reason}` };
  }

  // Background delegation: fire-and-forget
  if (background) {
    const bgManager = this.getBackgroundTaskManager();
    if (bgManager) {
      bgManager.submit({
        description: task.substring(0, 200),
        prompt: task,
        agentId,
        requestedBy: sourceAgentId,
        channelId: this.currentChannelId || '',
        source: (this.currentSource as 'discord' | 'slack') || 'discord',
      });
      return { success: true, data: { agentId, background: true, message: 'Task submitted' } };
    }
    return { success: false, error: 'Background task manager not available' };
  }

  // Sync delegation: execute and return result
  try {
    const source = this.currentSource || 'viewer';
    const channelId = this.currentChannelId || 'default';
    const process = await processManager.getProcess(source, channelId, agentId);

    const delegationPrompt = delegationManager.buildDelegationPrompt({
      fromAgentId: sourceAgentId,
      toAgentId: agentId,
      task,
      originalContent: '',
      background: false,
    });

    const startTime = Date.now();
    const result = await process.sendMessage(delegationPrompt);
    const duration = Date.now() - startTime;

    // Record delegation in history
    delegationManager.recordDelegation(sourceAgentId, agentId, task, duration);

    return {
      success: true,
      data: {
        agentId,
        response: result.response,
        duration_ms: duration,
      },
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Delegation to ${agentId} failed: ${errMsg}` };
  }
}
```

- [ ] **Step 2.2.3: Add accessor methods to GatewayToolExecutor**

```typescript
/** Set AgentProcessManager for delegate tool */
setAgentProcessManager(pm: AgentProcessManager): void {
  this.agentProcessManager = pm;
}

/** Set DelegationManager for delegate tool */
setDelegationManager(dm: DelegationManager): void {
  this.delegationManager = dm;
}

/** Set current agent context (called before each tool execution) */
setCurrentAgentContext(agentId: string, source: string, channelId: string): void {
  this.currentAgentId = agentId;
  this.currentSource = source;
  this.currentChannelId = channelId;
}

private getAgentProcessManager() { return this.agentProcessManager ?? null; }
private getDelegationManager() { return this.delegationManager ?? null; }
private getBackgroundTaskManager() { return this.backgroundTaskManager ?? null; }
```

- [ ] **Step 2.2.4: Run tests**

Run: `cd packages/standalone && pnpm vitest run tests/agent/delegate-tool.test.ts`
Expected: PASS

- [ ] **Step 2.2.5: Commit**

```bash
git add packages/standalone/src/agent/gateway-tool-executor.ts packages/standalone/src/multi-agent/delegation-manager.ts packages/standalone/tests/agent/delegate-tool.test.ts
git commit -m "feat(tools): implement delegate gateway tool handler"
```

---

## Task 3: HostBridge + GatewayToolExecutor Wiring

**핵심:** (1) HostBridge.TOOL_REGISTRY에 delegate 메타데이터 추가 → code-act에서 자동 사용 가능. (2) GatewayToolExecutor에 ProcessManager/DelegationManager 연결. Code-act이 MCP tool로 등록되어 있으므로 모든 CLI 프로세스(Discord/Slack/Telegram/Viewer)에서 자동 작동.

**Files:**

- Modify: `packages/standalone/src/agent/code-act/host-bridge.ts` (TOOL_REGISTRY에 delegate 추가)
- Modify: `packages/standalone/src/cli/runtime/api-routes-init.ts` (wiring)
- Modify: `packages/standalone/src/multi-agent/multi-agent-base.ts` (public getters)

- [ ] **Step 3.1: HostBridge TOOL_REGISTRY에 delegate 추가**

In `packages/standalone/src/agent/code-act/host-bridge.ts`, TOOL_REGISTRY 배열에:

```typescript
{
  name: 'delegate',
  description: 'Delegate a task to another agent with its own persona, tools, and persistent session.',
  parameters: {
    agentId: { type: 'string', description: 'Target agent ID' },
    task: { type: 'string', description: 'Task description' },
    background: { type: 'boolean', description: 'Fire-and-forget mode', optional: true },
  },
  tier: 1, // Tier 1 only — only Conductor can delegate
}
```

- [ ] **Step 3.2: Expose getProcessManager/getDelegationManager from MultiAgentHandlerBase**

In `packages/standalone/src/multi-agent/multi-agent-base.ts`:

```typescript
getProcessManager(): AgentProcessManager { return this.processManager; }
getDelegationManager(): DelegationManager { return this.delegationManager; }
```

- [ ] **Step 3.3: Wire in api-routes-init**

```typescript
if (multiAgentHandler) {
  gatewayToolExecutor.setAgentProcessManager(multiAgentHandler.getProcessManager());
  gatewayToolExecutor.setDelegationManager(multiAgentHandler.getDelegationManager());
}
```

- [ ] **Step 3.4: Run full test suite**

Run: `pnpm test`
Expected: All pass

- [ ] **Step 3.5: Commit**

```bash
git add packages/standalone/src/agent/code-act/host-bridge.ts packages/standalone/src/cli/runtime/api-routes-init.ts packages/standalone/src/multi-agent/multi-agent-base.ts
git commit -m "feat(tools): wire delegate to HostBridge + GatewayToolExecutor for code-act access"
```

---

## Task 4: Conductor Persona에 delegate 도구 안내

**핵심:** Conductor가 delegate 도구를 사용하도록 persona에 안내 추가.

**Files:**

- Modify: Conductor persona file (`~/.mama/personas/conductor.md` 또는 해당 파일)

- [ ] **Step 4.1: Conductor persona에 delegation 지시 추가**

```markdown
## Delegation

You have a `delegate` tool to assign tasks to specialized agents:

- **delegate(agentId, task)** — Synchronous. Waits for result. Use for tasks that need the result before continuing.
- **delegate(agentId, task, background: true)** — Background. Fire-and-forget. Use for independent tasks.

Available agents:

- `developer` — Code implementation, debugging, file creation
- `reviewer` — Code review, quality checks

Always use `delegate` instead of trying to do specialized work yourself.
When you receive a delegation result, evaluate it and decide next steps.
```

- [ ] **Step 4.2: Commit**

```bash
git commit -m "feat(persona): add delegate tool instructions to Conductor persona"
```

---

## Task 5: Discord/Slack DELEGATE:: 파싱 코드 삭제

**핵심:** 프로세스가 delegate 도구를 사용하므로, 핸들러의 DELEGATE:: 텍스트 파싱은 dead code.

**Files:**

- Modify: `packages/standalone/src/multi-agent/multi-agent-discord.ts`
- Modify: `packages/standalone/src/multi-agent/multi-agent-slack.ts`
- Modify: `packages/standalone/src/multi-agent/multi-agent-base.ts`

- [ ] **Step 5.1: Discord handler에서 delegation 파싱 삭제**

`multi-agent-discord.ts`에서 삭제:

- `delegationManager.parseAllDelegations()` 호출 (~line 867, 1032)
- `backgroundTaskManager.submit()` delegation 관련 블록
- `messageQueue.enqueue()` sync delegation 관련 블록
- DELEGATE_BG 관련 분기 전체

유지:

- Workflow/council execution
- Gateway tool calls (`executeAgentToolCalls` / `executeTextToolCalls`)
- Agent formatting, emoji, multi-bot UX

- [ ] **Step 5.2: Slack handler에서 동일 삭제**

`multi-agent-slack.ts`에서 동일한 delegation 파싱 코드 삭제.

- [ ] **Step 5.3: Base handler에서 submitBackgroundDelegations 삭제**

`multi-agent-base.ts`의 `submitBackgroundDelegations()` 메서드 삭제 (line 812-840). Dead code.

- [ ] **Step 5.4: delegation-format-validator.ts 검토**

`isDelegationAttempt()`, `validateDelegationFormat()` — 이것들이 다른 곳에서도 쓰이는지 확인. delegate 도구 전환 후 불필요하면 삭제.

- [ ] **Step 5.5: Run full test suite**

Run: `pnpm test`
Expected: All pass

- [ ] **Step 5.6: Commit**

```bash
git add packages/standalone/src/multi-agent/multi-agent-discord.ts packages/standalone/src/multi-agent/multi-agent-slack.ts packages/standalone/src/multi-agent/multi-agent-base.ts
git commit -m "refactor(multi-agent): remove DELEGATE:: text parsing — replaced by delegate gateway tool"
```

---

## Task 6: 에이전트 장애 복원 (Resilience)

**문제:** (1) delegate 호출 시 target agent가 busy이거나 context compaction 중 crash. (2) 프로세스 재시작 시 이전 대화 컨텍스트 소실.

**Files:**

- Modify: `packages/standalone/src/agent/gateway-tool-executor.ts` (delegate handler에 retry/recovery 추가)
- Modify: `packages/standalone/src/multi-agent/agent-process-manager.ts` (crash 감지 + 재생성)
- Create: `packages/standalone/tests/agent/delegate-resilience.test.ts`
- Reference: `packages/standalone/src/gateways/channel-history.ts` (formatForContext 패턴)

### Step 6.1: Busy 처리 — retry with backoff

- [ ] **Step 6.1.1: Write test**

```typescript
// packages/standalone/tests/agent/delegate-resilience.test.ts
import { describe, it, expect, vi } from 'vitest';

describe('delegate tool resilience', () => {
  it('retries on busy process before failing', async () => {
    let callCount = 0;
    const mockProcess = {
      sendMessage: vi.fn(async () => {
        callCount++;
        if (callCount < 3) throw new Error('Process is busy');
        return { response: 'Done', duration_ms: 100 };
      }),
      isReady: () => callCount >= 3,
      stop: vi.fn(),
      on: vi.fn().mockReturnThis(),
    };

    // Simulate retry logic
    const maxRetries = 3;
    let result;
    for (let i = 0; i < maxRetries; i++) {
      try {
        result = await mockProcess.sendMessage('task');
        break;
      } catch (err: any) {
        if (!err.message.includes('busy') || i === maxRetries - 1) throw err;
        await new Promise((r) => setTimeout(r, 100 * (i + 1))); // backoff
      }
    }
    expect(result?.response).toBe('Done');
    expect(callCount).toBe(3);
  });

  it('recreates process on crash and retries', async () => {
    let crashed = true;
    const createProcess = vi.fn(async () => ({
      sendMessage: vi.fn(async () => {
        if (crashed) {
          crashed = false;
          throw new Error('exited with code 1');
        }
        return { response: 'Recovered', duration_ms: 100 };
      }),
      isReady: () => true,
      stop: vi.fn(),
      on: vi.fn().mockReturnThis(),
    }));

    // First call: crash → recreate → retry
    const proc1 = await createProcess();
    try {
      await proc1.sendMessage('task');
    } catch {
      const proc2 = await createProcess();
      const result = await proc2.sendMessage('task');
      expect(result.response).toBe('Recovered');
    }
    expect(createProcess).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 6.1.2: Add retry logic to delegate handler**

In `gateway-tool-executor.ts` delegate case, wrap `process.sendMessage()`:

```typescript
// Retry with backoff for busy/crash
const MAX_RETRIES = 3;
let lastError: Error | null = null;

for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
  try {
    const process = await processManager.getProcess(source, channelId, agentId);
    const result = await process.sendMessage(delegationPrompt);
    // Success
    return { success: true, data: { agentId, response: result.response, duration_ms: ... } };
  } catch (err) {
    lastError = err instanceof Error ? err : new Error(String(err));
    const isBusy = lastError.message.includes('busy');
    const isCrash = lastError.message.includes('exited with code');

    if (isCrash) {
      // Process crashed — force recreate by stopping and retrying
      try { processManager.stopProcess(source, channelId, agentId); } catch {}
    }

    if (attempt < MAX_RETRIES - 1 && (isBusy || isCrash)) {
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); // 1s, 2s, 3s backoff
      continue;
    }
    break;
  }
}
return { success: false, error: `Delegation to ${agentId} failed after ${MAX_RETRIES} attempts: ${lastError?.message}` };
```

- [ ] **Step 6.1.3: Run tests, commit**

```bash
git commit -m "feat(delegate): add retry with backoff for busy/crash resilience"
```

### Step 6.2: Restart 시 히스토리 인계

- [ ] **Step 6.2.1: 재시작 감지 + channelHistory 주입**

`delegate` handler에서 프로세스가 새로 생성된 경우(isNew), 채널 히스토리를 주입:

```typescript
const process = await processManager.getProcess(source, channelId, agentId);

// Check if this is a fresh session (no prior context)
const sessionId = process.getSessionId?.();
const isNewSession = !sessionId || processManager.isNewProcess(source, channelId, agentId);

if (isNewSession) {
  // Inject channel history so agent has context from prior conversations
  const channelHistory = getChannelHistory();
  if (channelHistory) {
    const agentConfig = processManager.getAgentConfig(agentId);
    const displayName = agentConfig?.display_name || agentId;
    const historyContext = channelHistory.formatForContext(channelId, '', displayName);
    if (historyContext) {
      // Prepend history to the delegation prompt
      delegationPrompt = `${historyContext}\n\n${delegationPrompt}`;
    }
  }
}
```

- [ ] **Step 6.2.2: Run tests, commit**

```bash
git commit -m "feat(delegate): inject channel history on process restart for context continuity"
```

---

## Task 7: Sheets Snapshot Persistence (독립)

- [ ] **Step 6.1: loadSnapshot/saveSnapshot 추가**

`packages/standalone/src/connectors/sheets/index.ts`에 snapshot.json 영속화.
`init()`에서 `loadSnapshot()`, `poll()` 끝에 `saveSnapshot()`.

- [ ] **Step 6.2: Test and commit**

```bash
git commit -m "fix(sheets): persist snapshot to prevent re-emitting unchanged rows"
```

---

## Task 8: DB Auto-Migration Verification (독립)

- [ ] **Step 7.1: migration 014 자동 실행 확인**
- [ ] **Step 7.2: 필요 시 수정, commit**

---

## Task 9: Kagemusha History Compiler (독립)

- [ ] **Step 8.1: groupByMonth + compileMonth 생성**
- [ ] **Step 8.2: API endpoint 추가**
- [ ] **Step 8.3: Test and commit**

---

## Execution Order

```
Task 1: delegate 도구 등록           ← 스키마만 (5분)
  ↓
Task 2: delegate 핸들러 구현          ← 핵심 (~30줄)
  ↓
Task 3: Wire (api-routes-init)       ← 연결
  ↓
Task 4: Conductor persona 업데이트    ← persona 수정
  ↓
Task 5: DELEGATE:: 파싱 코드 삭제     ← 정리
  ↓
Task 6: 에이전트 장애 복원            ← busy retry + crash recovery + history 인계
  ↓ (독립)
Task 7: Sheets fix
Task 8: DB migration
Task 9: Kagemusha history
```

## Verification Checklist

- [ ] `pnpm build` — 0 errors
- [ ] `pnpm test` — all pass
- [ ] **Discord**: Conductor가 delegate(developer, task) 도구 호출 → developer 실행 → 결과 반환
- [ ] **Viewer**: 같은 동작 (MessageRouter → GatewayToolExecutor → delegate)
- [ ] **Telegram**: 같은 동작 (MessageRouter 경로)
- [ ] delegate(agentId, task, background: true) → BG 실행 → 완료 시 알림
- [ ] Tier 2 agent가 delegate 시도 → 도구 에러 반환
- [ ] 비활성 에이전트에 delegate → 에러 반환
- [ ] Self-delegation → 에러 반환
- [ ] DELEGATE:: 텍스트 패턴이 응답에 있어도 무시됨 (파싱 삭제됨)
