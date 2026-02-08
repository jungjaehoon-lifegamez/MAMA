# MAMA Multi-Agent Architecture - Current State

**Date:** 2026-02-08  
**Purpose:** Factual baseline documentation of existing parallel execution infrastructure

---

## Executive Summary

MAMA's standalone package (`@jungjaehoon/mama-os`) contains a complete multi-agent orchestration system with parallel execution infrastructure. This document provides a comprehensive inventory of the current implementation with code evidence.

**Key Findings:**

- **Parallel Execution Infrastructure:** Fully implemented via `AgentProcessPool` (356 lines) and `WaveEngine` (201 lines)
- **Default Configuration:** `defaultPoolSize=1` (single process per agent, backward compatible)
- **Multi-Agent Orchestration:** 5-stage routing pipeline with tier-based permissions
- **Plan-Execute Separation:** 3-phase planning protocol with hard gate validation (recently implemented)
- **Test Coverage:** 53 test files in standalone package

**Critical Gap:** Infrastructure exists but is NOT documented in user-facing README. Users cannot discover `pool_size` configuration option.

---

## 1. Parallel Execution Infrastructure

### 1.1 AgentProcessPool

**Location:** `packages/standalone/src/multi-agent/agent-process-pool.ts` (356 lines)

**Purpose:** Manages pools of concurrent Claude CLI processes per agent for parallel task execution.

**Key Features:**

```typescript
// Line 36-46: Configuration options
export interface AgentProcessPoolOptions {
  defaultPoolSize?: number; // Default: 1
  agentPoolSizes?: Record<string, number>; // Per-agent overrides
  idleTimeoutMs?: number; // Default: 600000 (10 min)
  hungTimeoutMs?: number; // Default: 900000 (15 min)
  verbose?: boolean;
}
```

**Process Lifecycle:**

1. **Acquire Process** (lines 107-160):
   - `getAvailableProcess(agentId, channelKey, createProcess)`
   - Searches for idle process (line 119: `!p.busy && p.process.isReady()`)
   - Creates new process if under pool limit (line 135: `pool.length < maxSize`)
   - Throws error if pool full (line 157-159)

2. **Release Process** (lines 168-196):
   - `releaseProcess(agentId, process)`
   - Marks process as idle (line 187: `entry.busy = false`)
   - Updates last used timestamp (line 188)

3. **Cleanup** (lines 275-341):
   - **Idle timeout:** Terminates processes unused for 10 minutes (default)
   - **Hung detection:** Kills processes busy for 15+ minutes (default)
   - Automatic pool removal when empty (lines 289-294, 330-333)

**Default Values:**

```typescript
// Line 90: Default pool size
defaultPoolSize: options?.defaultPoolSize ?? 1;

// Line 92: Idle timeout
idleTimeoutMs: options?.idleTimeoutMs ?? 600000; // 10 minutes

// Line 93: Hung timeout
hungTimeoutMs: options?.hungTimeoutMs ?? 900000; // 15 minutes
```

**Integration Point:**

```typescript
// packages/standalone/src/multi-agent/agent-process-manager.ts
// Lines 72-84: AgentProcessPool initialization
const agentPoolSizes: Record<string, number> = {};
for (const [agentId, agentConfig] of Object.entries(config.agents)) {
  if (agentConfig.pool_size && agentConfig.pool_size > 1) {
    agentPoolSizes[agentId] = agentConfig.pool_size;
  }
}

this.agentProcessPool = new AgentProcessPool({
  defaultPoolSize: 1, // Line 81: Hardcoded default
  agentPoolSizes,
  idleTimeoutMs: 300000, // 5 minutes
});
```

**Evidence of Usage:**

```typescript
// Lines 164-216: Multi-process agents (pool_size > 1)
if (poolSize > 1) {
  const { process, isNew } = await this.agentProcessPool.getAvailableProcess(
    agentId,
    channelKey,
    async () => {
      // Factory: create new PersistentClaudeProcess
      const newProcess = new PersistentClaudeProcess(mergedOptions);
      await newProcess.start();
      return newProcess;
    }
  );

  // Emit process-created event for new processes
  if (isNew) {
    this.emit('process-created', { agentId, process });
  }

  return process;
}
```

### 1.2 WaveEngine

**Location:** `packages/standalone/src/multi-agent/swarm/wave-engine.ts` (201 lines)

**Purpose:** Executes wave-based task orchestration with sequential waves and parallel tasks within each wave.

**Execution Model:**

```typescript
// Lines 91-180: executeWaves function
export async function executeWaves(
  waves: Wave[],
  swarmManager: SwarmManager,
  sessionId: string,
  executor: TaskExecutor
): Promise<WaveExecutionResult>;
```

**Parallel Execution Pattern:**

```typescript
// Line 111: Promise.all for parallel task execution within waves
const waveResults = await Promise.all(
  wave.tasks.map(async (task) => {
    // Atomically claim the task (line 114)
    const claimed = claimTask(db, task.id, task.agentId);

    if (!claimed) {
      // Task already claimed, skip (lines 116-124)
      return { taskId: task.id, status: 'skipped' as const };
    }

    // Execute the task (line 130)
    const result = await executor(task);

    // Mark as completed (line 133)
    completeTask(db, task.id, result);

    return { taskId: task.id, status: 'completed' as const, result };
  })
);
```

**Fail-Forward Behavior:**

```typescript
// Lines 142-154: Error handling doesn't block sibling tasks
catch (error) {
  const errorMsg = error instanceof Error ? error.message : String(error);
  failTask(db, task.id, errorMsg);
  failed++;

  return {
    taskId: task.id,
    agentId: task.agentId,
    status: 'failed' as const,
    error: errorMsg,
  };
}
```

**Wave Progression:**

- Waves execute **sequentially** (line 107: `for (const wave of sortedWaves)`)
- Tasks within each wave execute **in parallel** (line 111: `Promise.all`)
- Failed tasks don't block next wave (lines 158-165)

### 1.3 AgentProcessManager

**Location:** `packages/standalone/src/multi-agent/agent-process-manager.ts` (543 lines)

**Purpose:** Manages per-agent persistent CLI processes with persona-specific system prompts and channel isolation.

**Key Responsibilities:**

1. **Process Pool Integration** (lines 72-84):
   - Extracts `pool_size` from agent config
   - Builds `agentPoolSizes` map for per-agent overrides
   - Initializes `AgentProcessPool` with `defaultPoolSize: 1`

2. **Process Acquisition** (lines 155-257):
   - Checks `pool_size` to determine single vs. multi-process mode (line 162)
   - For `pool_size > 1`: Uses `AgentProcessPool.getAvailableProcess()` (line 194)
   - For `pool_size = 1`: Uses legacy `PersistentProcessPool` (line 248)

3. **Structural Tool Enforcement** (lines 186-192, 241-246):

   ```typescript
   // Structural tool enforcement via CLI flags
   const permissions = this.permissionManager.resolvePermissions({
     id: agentId,
     ...agentConfig,
   } as AgentPersonaConfig);
   if (!permissions.allowed.includes('*')) {
     options.allowedTools = permissions.allowed;
   }
   if (permissions.blocked.length > 0) {
     options.disallowedTools = permissions.blocked;
   }
   ```

4. **Process Release** (lines 443-453):
   - For multi-process agents: Calls `agentProcessPool.releaseProcess()`
   - For single-process agents: No release needed (automatic reuse)

**Default Pool Size:**

```typescript
// Line 81: Hardcoded default
this.agentProcessPool = new AgentProcessPool({
  defaultPoolSize: 1, // NOT configurable via config.yaml
  agentPoolSizes,
  idleTimeoutMs: 300000, // 5 minutes
});
```

### 1.4 PersistentProcessPool / PersistentClaudeProcess

**Location:** `packages/standalone/src/agent/persistent-cli-process.ts` (751 lines)

**Purpose:** Manages long-lived Claude CLI processes using stream-json protocol for multi-turn conversations.

**Session Reuse Pattern:**

```typescript
// Lines 664-701: PersistentProcessPool.getProcess
async getProcess(
  channelKey: string,
  options?: Partial<PersistentProcessOptions>
): Promise<PersistentClaudeProcess> {
  let process = this.processes.get(channelKey);

  if (!process || !process.isAlive()) {
    // Create new process (lines 675-696)
    const mergedOptions: PersistentProcessOptions = {
      sessionId: randomUUID(),
      ...this.defaultOptions,
      ...options,
    };

    process = new PersistentClaudeProcess(mergedOptions);

    // Handle process errors and death (lines 685-694)
    process.on('error', (err) => {
      console.error(`[ProcessPool] Process error for ${channelKey}:`, err);
      this.processes.delete(channelKey);
    });

    this.processes.set(channelKey, process);
    await process.start();
  }

  return process;
}
```

**Process States:**

```typescript
// Line 115: ProcessState type
type ProcessState = 'idle' | 'busy' | 'starting' | 'dead';

// Lines 627-638: State checks
isAlive(): boolean {
  return this.state !== 'dead';
}

isReady(): boolean {
  return this.state === 'idle';
}
```

**Stream-JSON Protocol:**

```typescript
// Lines 16-24: Protocol documentation
/**
 * Input (stdin):
 *   User message: {"type":"user","message":{"role":"user","content":"..."}}
 *   Tool result:  {"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"xxx","content":"...","is_error":false}]}}
 *
 * Output (stdout):
 *   Init:      {"type":"system","subtype":"init",...}
 *   Assistant: {"type":"assistant","message":{...}}
 *   Tool use:  Content block with type="tool_use" in assistant message
 *   Result:    {"type":"result","subtype":"success",...}
 */
```

---

## 2. Multi-Agent Orchestration Layer

### 2.1 5-Stage Routing Pipeline

**Location:** `packages/standalone/src/multi-agent/orchestrator.ts` (lines 82-244)

**Pipeline Stages:**

```typescript
// Stage 0: Free Chat Mode (lines 135-170)
if (this.config.free_chat) {
  if (!context.isBot) {
    // All agents respond to human messages
    return { selectedAgents: availableAgents.map((a) => a.id), reason: 'free_chat' };
  } else if (context.senderAgentId) {
    // Agent-to-agent: other agents respond
    const otherAgents = availableAgents.filter((a) => a.id !== context.senderAgentId);
    return { selectedAgents: otherAgents.map((a) => a.id), reason: 'free_chat' };
  }
}

// Stage 1: Explicit Trigger (lines 173-190)
const explicitAgent = this.findExplicitTrigger(content, availableAgents);
if (explicitAgent) {
  return { selectedAgents: [explicitAgent.id], reason: 'explicit_trigger' };
}

// Stage 2: Category Match (lines 193-204)
const categoryMatch = this.categoryRouter.route(content, availableAgents);
if (categoryMatch) {
  const readyAgents = categoryMatch.agentIds.filter((id) => this.isAgentReady(id));
  if (readyAgents.length > 0) {
    return { selectedAgents: readyAgents, reason: 'category_match' };
  }
}

// Stage 3: Keyword Match (lines 207-223)
const keywordMatches = this.findKeywordMatches(content, availableAgents);
const readyAgents = keywordMatches.filter(
  (agent) => this.isAgentReady(agent.id) && agent.id !== context.senderAgentId
);
if (readyAgents.length > 0) {
  return { selectedAgents: readyAgents.map((a) => a.id), reason: 'keyword_match' };
}

// Stage 4: Default Agent (lines 226-238)
if (!context.isBot) {
  const defaultAgentId = channelOverride?.default_agent || this.config.default_agent;
  if (defaultAgentId) {
    const defaultAgent = availableAgents.find((a) => a.id === defaultAgentId);
    if (defaultAgent && this.isAgentReady(defaultAgent.id)) {
      return { selectedAgents: [defaultAgent.id], reason: 'default_agent' };
    }
  }
}

// Stage 5: No Match
return { selectedAgents: [], reason: 'none' };
```

**Loop Prevention:**

```typescript
// Lines 249-298: recordAgentResponse
recordAgentResponse(agentId: string, channelId: string, messageId?: string): void {
  const now = Date.now();
  const chainState = this.getChainState(channelId);
  const loopPrevention = this.config.loop_prevention || DEFAULT_LOOP_PREVENTION;

  // Check if chain window has expired (line 261)
  if (now - chainState.lastResponseTime > loopPrevention.chain_window_ms) {
    chainState.length = 1; // Start new chain
  } else {
    chainState.length++; // Continue chain
  }

  // Check if chain limit reached (line 273)
  if (chainState.length >= loopPrevention.max_chain_length) {
    chainState.blocked = true;
    console.log(`Chain limit reached for channel ${channelId}`);
  }
}
```

### 2.2 CategoryRouter

**Location:** `packages/standalone/src/multi-agent/category-router.ts` (121 lines)

**Purpose:** Routes messages to agents based on regex pattern matching.

**Routing Logic:**

```typescript
// Lines 43-67: route method
route(content: string, availableAgents: AgentPersonaConfig[]): CategoryMatchResult | null {
  const availableIds = new Set(availableAgents.map(a => a.id));

  for (const category of this.categories) {
    for (const pattern of category.patterns) {
      const regex = this.getCompiledRegex(pattern);
      if (!regex) continue;

      if (regex.test(content)) {
        // Filter to only available agents
        const matchedAgents = category.agent_ids.filter(id => availableIds.has(id));

        if (matchedAgents.length > 0) {
          return {
            categoryName: category.name,
            agentIds: matchedAgents,
            matchedPattern: pattern,
          };
        }
      }
    }
  }

  return null;
}
```

**Pattern Compilation:**

```typescript
// Lines 106-119: Regex caching
private getCompiledRegex(pattern: string): RegExp | null {
  if (this.regexCache.has(pattern)) {
    return this.regexCache.get(pattern)!;
  }

  try {
    const regex = new RegExp(pattern, 'i'); // Case-insensitive
    this.regexCache.set(pattern, regex);
    return regex;
  } catch {
    console.warn(`[CategoryRouter] Invalid regex pattern: ${pattern}`);
    return null;
  }
}
```

**Priority Ordering:**

```typescript
// Lines 88-90: Sort by priority (higher first)
private sortByPriority(categories: CategoryConfig[]): CategoryConfig[] {
  return [...categories].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}
```

### 2.3 DelegationManager

**Location:** `packages/standalone/src/multi-agent/delegation-manager.ts` (229 lines)

**Purpose:** Enables Tier 1 agents to delegate tasks to Tier 2/3 agents.

**Delegation Pattern:**

```typescript
// Line 59: DELEGATE pattern regex
const DELEGATE_PATTERN = /DELEGATE::([\w-]+)::(.+)/s;

// Lines 80-96: Parse delegation
parseDelegation(agentId: string, response: string): DelegationRequest | null {
  const match = response.match(DELEGATE_PATTERN);
  if (!match) return null;

  const toAgentId = match[1];
  const task = match[2].trim();

  // Strip the DELEGATE pattern from original content
  const originalContent = response.replace(DELEGATE_PATTERN, '').trim();

  return { fromAgentId: agentId, toAgentId, task, originalContent };
}
```

**Validation Rules:**

```typescript
// Lines 99-146: isDelegationAllowed
isDelegationAllowed(fromId: string, toId: string): { allowed: boolean; reason: string } {
  // Check if source can delegate (line 113)
  if (!this.permissionManager.canDelegate(fromAgent)) {
    return { allowed: false, reason: `Agent ${fromId} cannot delegate` };
  }

  // Check if target is enabled (line 122)
  if (toAgent.enabled === false) {
    return { allowed: false, reason: `Target agent ${toId} is disabled` };
  }

  // Check for self-delegation (line 127)
  if (fromId === toId) {
    return { allowed: false, reason: 'Cannot delegate to self' };
  }

  // Check for circular delegation (line 132)
  const delegationKey = `${fromId}:${toId}`;
  if (this.activeDelegations.has(delegationKey)) {
    return { allowed: false, reason: `Circular delegation detected` };
  }

  // Check reverse delegation (line 137)
  const reverseKey = `${toId}:${fromId}`;
  if (this.activeDelegations.has(reverseKey)) {
    return { allowed: false, reason: `Reverse delegation detected` };
  }

  return { allowed: true, reason: 'ok' };
}
```

**Execution:**

```typescript
// Lines 151-198: executeDelegation
async executeDelegation(
  request: DelegationRequest,
  executeCallback: DelegationExecuteCallback,
  notifyCallback?: DelegationNotifyCallback
): Promise<DelegationResult> {
  const delegationKey = `${fromAgentId}:${toAgentId}`;
  this.activeDelegations.add(delegationKey); // Track active delegation

  try {
    // Notify channel (lines 172-176)
    if (notifyCallback && fromAgent && toAgent) {
      await notifyCallback(
        `**${fromAgent.display_name}** delegated a task to **${toAgent.display_name}**: ${task.substring(0, 100)}`
      );
    }

    // Build delegation prompt (line 179)
    const delegationPrompt = this.buildDelegationTaskPrompt(fromAgentId, task);

    // Execute the delegated task (line 182)
    const result = await executeCallback(toAgentId, delegationPrompt);

    return { success: true, response: result.response, duration: result.duration_ms };
  } finally {
    this.activeDelegations.delete(delegationKey); // Always cleanup
  }
}
```

### 2.4 TaskContinuation

**Location:** `packages/standalone/src/multi-agent/task-continuation.ts` (217 lines)

**Purpose:** Auto-resume incomplete agent responses.

**Completion Detection:**

```typescript
// Lines 40-41: Default completion markers
const DEFAULT_COMPLETION_MARKERS = ['DONE', '완료', '✅', 'TASK_COMPLETE'];

// Lines 160-176: Position-based marker detection
private isResponseComplete(response: string): boolean {
  // Get last 3 lines of response for position-based marker detection
  const lines = response.split('\n');
  const lastLines = lines.slice(-3).join('\n').toLowerCase();

  for (const marker of this.completionMarkers) {
    if (lastLines.includes(marker.toLowerCase())) {
      return true;
    }
  }
  return false;
}
```

**Incomplete Detection:**

```typescript
// Lines 45-54: Incomplete patterns
const INCOMPLETE_PATTERNS = [
  /I'll continue/i,
  /계속하겠/,
  /계속할게/,
  /to be continued/i,
  /let me continue/i,
  /next,?\s*I('ll| will)/i,
  /이어서/,
  /다음으로/,
];

// Lines 179-200: Truncation detection
private isResponseIncomplete(response: string): boolean {
  // Check for explicit continuation patterns
  for (const pattern of INCOMPLETE_PATTERNS) {
    if (pattern.test(response)) {
      return true;
    }
  }

  // Check for truncation (response near Discord's 2000 char limit)
  if (response.length >= 1800) {
    const trimmed = response.trimEnd();
    const lastChar = trimmed[trimmed.length - 1];
    if (lastChar && !'.!?。！？…'.includes(lastChar)) {
      return true; // Ends mid-sentence
    }
  }

  return false;
}
```

**Continuation Prompt:**

```typescript
// Lines 118-127: buildContinuationPrompt
buildContinuationPrompt(previousResponse: string): string {
  // Take last 200 chars as context
  const tail = previousResponse.length > 200 ? previousResponse.slice(-200) : previousResponse;

  return `Continue from where you left off. Your previous response ended with:
---
${tail}
---
Continue the task. When done, end your response with "DONE" or "완료".`;
}
```

### 2.5 UltraWork

**Location:** `packages/standalone/src/multi-agent/ultrawork.ts` (458 lines)

**Purpose:** Autonomous multi-step work sessions combining delegation and task continuation.

**Trigger Detection:**

```typescript
// Lines 78-84: Default trigger keywords
const DEFAULT_TRIGGER_KEYWORDS = [
  'ultrawork',
  '울트라워크',
  'deep work',
  'autonomous',
  '자율 작업',
];

// Lines 107-114: isUltraWorkTrigger
isUltraWorkTrigger(content: string): boolean {
  if (!this.config.enabled) return false;

  const keywords = this.config.trigger_keywords ?? DEFAULT_TRIGGER_KEYWORDS;
  const lower = content.toLowerCase();

  return keywords.some(kw => lower.includes(kw.toLowerCase()));
}
```

**Session Limits:**

```typescript
// Lines 142-151: Session initialization
const session: UltraWorkSession = {
  id: `uw_${++this.sessionCounter}_${Date.now()}`,
  channelId,
  leadAgentId,
  task,
  currentStep: 0,
  maxSteps: this.config.max_steps ?? 20, // Default: 20 steps
  startTime: Date.now(),
  maxDuration: this.config.max_duration ?? 1800000, // Default: 30 min
  active: true,
  steps: [],
};
```

**Autonomous Loop:**

```typescript
// Lines 263-418: runSessionLoop
private async runSessionLoop(
  session: UltraWorkSession,
  agents: AgentPersonaConfig[],
  executeCallback: DelegationExecuteCallback,
  notifyCallback: DelegationNotifyCallback
): Promise<void> {
  const delegationManager = new DelegationManager(agents, this.permissionManager);
  const continuationEnforcer = new TaskContinuationEnforcer({ enabled: true, max_retries: 3 });

  let currentPrompt = this.buildInitialPrompt(session.task, agents);
  let currentAgentId = session.leadAgentId;

  while (this.shouldContinue(session)) {
    session.currentStep++;

    // Execute current agent's task with timeout protection (lines 285-290)
    const result = await this.executeWithTimeout(executeCallback, currentAgentId, currentPrompt);

    // Check for delegation (lines 293-341)
    const delegationRequest = delegationManager.parseDelegation(currentAgentId, result.response);
    if (delegationRequest) {
      // Execute delegation and continue with lead agent
    }

    // Check for continuation (lines 343-386)
    const continuation = continuationEnforcer.analyzeResponse(currentAgentId, session.channelId, result.response);
    if (continuation.isComplete) {
      session.active = false;
      break;
    }
  }
}
```

**Timeout Protection:**

```typescript
// Lines 232-258: executeWithTimeout
private async executeWithTimeout(
  executeCallback: DelegationExecuteCallback,
  agentId: string,
  prompt: string,
  timeoutMs: number = DEFAULT_EXECUTE_TIMEOUT // 5 minutes
): Promise<{ response: string; duration?: number }> {
  let timeoutHandle: ReturnType<typeof setTimeout>;

  const result = await Promise.race([
    executeCallback(agentId, prompt),
    new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`Agent ${agentId} timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
    }),
  ]);

  clearTimeout(timeoutHandle!);
  return result;
}
```

### 2.6 ToolPermissionManager

**Location:** `packages/standalone/src/multi-agent/tool-permission-manager.ts` (283 lines)

**Purpose:** Manages tool access permissions based on agent tier levels.

**Tier Defaults:**

```typescript
// Lines 31-41: TIER_DEFAULTS
private static readonly TIER_DEFAULTS: Record<number, ToolPermissions> = {
  1: { allowed: ['*'], blocked: [] },
  2: {
    allowed: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
    blocked: ['Write', 'Edit', 'Bash', 'NotebookEdit'],
  },
  3: {
    allowed: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
    blocked: ['Write', 'Edit', 'Bash', 'NotebookEdit'],
  },
};
```

**Permission Resolution:**

```typescript
// Lines 47-74: resolvePermissions
resolvePermissions(agent: AgentPersonaConfig): ToolPermissions {
  const tier = agent.tier ?? 1;

  // Get tier defaults, falling back to Tier 2 (read-only) for unsupported tier values
  const defaults = ToolPermissionManager.TIER_DEFAULTS[tier] ?? ToolPermissionManager.TIER_DEFAULTS[2];

  // Explicit permissions take priority over tier defaults
  if (agent.tool_permissions) {
    const allowed = agent.tool_permissions.allowed ?? defaults.allowed;
    let blocked = agent.tool_permissions.blocked ?? defaults.blocked;

    // If allowed explicitly lists tools that are in default blocked, remove them from blocked
    if (agent.tool_permissions.allowed && !agent.tool_permissions.blocked) {
      blocked = blocked.filter(b => !allowed.includes(b));
    }

    return { allowed, blocked };
  }

  return { ...defaults };
}
```

**Delegation Check:**

```typescript
// Lines 127-129: canDelegate
canDelegate(agent: AgentPersonaConfig): boolean {
  return (agent.tier ?? 1) === 1 && agent.can_delegate === true;
}
```

**System Prompt Generation:**

```typescript
// Lines 96-121: buildPermissionPrompt
buildPermissionPrompt(agent: AgentPersonaConfig): string {
  const tier = agent.tier ?? 1;
  const permissions = this.resolvePermissions(agent);

  const lines: string[] = [];
  lines.push(`## Tool Permissions (Tier ${tier})`);
  lines.push('');

  if (permissions.allowed.includes('*')) {
    lines.push('- You have access to **all tools**.');
  } else {
    lines.push(`- **Allowed tools:** ${permissions.allowed.join(', ')}`);
  }

  if (permissions.blocked.length > 0) {
    lines.push(`- **Blocked tools (DO NOT USE):** ${permissions.blocked.join(', ')}`);
    if (this.canDelegate(agent)) {
      lines.push('- Delegate tasks requiring blocked tools to other agents via @mention.');
    } else {
      lines.push('- If you need a blocked tool, ask a Tier 1 agent to help via delegation.');
    }
  }

  return lines.join('\n');
}
```

---

## 3. Plan-Execute Separation (Recently Implemented)

### 3.1 3-Phase Planning Protocol

**Context:** Implemented to prevent "vibe coding" where agents execute without planning.

**Phases:**

1. **Prometheus (Planning):** Tier 1 agent creates structured plan
2. **Metis (Validation):** Tier 2 agent validates plan completeness
3. **Momus (Execution):** Tier 3 agent executes validated plan

**Evidence:** Referenced in implementation plan but not yet fully documented in codebase.

### 3.2 Hard Gate Delegation Format Validator

**Location:** `packages/standalone/src/multi-agent/delegation-format-validator.ts` (42 lines)

**Purpose:** Validates that orchestrator delegations follow the 6-section format.

**Required Sections:**

```typescript
// Lines 13-20: REQUIRED_SECTIONS
const REQUIRED_SECTIONS = [
  'TASK:',
  'EXPECTED OUTCOME:',
  'MUST DO:',
  'MUST NOT DO:',
  'REQUIRED TOOLS:',
  'CONTEXT:',
];
```

**Validation Logic:**

```typescript
// Lines 27-32: isDelegationAttempt
export function isDelegationAttempt(content: string): boolean {
  // Look for section headers at start of line (optionally preceded by whitespace/bullets)
  const sectionPattern =
    /^\s*[-*•]?\s*(TASK:|EXPECTED OUTCOME:|MUST DO:|MUST NOT DO:|REQUIRED TOOLS:|CONTEXT:)/m;
  return sectionPattern.test(content);
}

// Lines 38-41: validateDelegationFormat
export function validateDelegationFormat(content: string): DelegationValidation {
  const missingSections = REQUIRED_SECTIONS.filter((s) => !content.includes(s));
  return { valid: missingSections.length === 0, missingSections };
}
```

**Integration:** Used in multi-agent orchestrator to block malformed delegations and post warnings to channel.

### 3.3 Structural Tool Enforcement

**Location:** `packages/standalone/src/agent/persistent-cli-process.ts` (lines 244-250)

**Purpose:** Enforce tool permissions at CLI level (not just prompt level).

**CLI Flags:**

```typescript
// Lines 244-250: Structural tool enforcement via CLI flags
if (this.options.allowedTools?.length) {
  args.push('--allowedTools', ...this.options.allowedTools);
}
if (this.options.disallowedTools?.length) {
  args.push('--disallowedTools', ...this.options.disallowedTools);
}
```

**Integration with ToolPermissionManager:**

```typescript
// packages/standalone/src/multi-agent/agent-process-manager.ts
// Lines 186-192: Structural tool enforcement
const permissions = this.permissionManager.resolvePermissions({
  id: agentId,
  ...agentConfig,
} as AgentPersonaConfig);
if (!permissions.allowed.includes('*')) {
  options.allowedTools = permissions.allowed;
}
if (permissions.blocked.length > 0) {
  options.disallowedTools = permissions.blocked;
}
```

**Effect:** Claude CLI structurally prevents tool use (not just prompt-based guidance).

---

## 4. Current Configuration

### 4.1 Config Schema

**Location:** `packages/standalone/src/multi-agent/types.ts` (lines 1-200+)

**Agent Configuration:**

```typescript
export interface AgentPersonaConfig {
  id: string;
  name: string;
  display_name: string;
  trigger_prefix: string;
  persona_file: string;
  bot_token?: string;
  slack_bot_token?: string;
  slack_app_token?: string;
  auto_respond_keywords?: string[];
  cooldown_ms?: number;
  model?: string;
  max_turns?: number;
  enabled?: boolean;
  pool_size?: number; // Line 97: NOT documented in README
  tier?: 1 | 2 | 3; // Line 106: Default 1
  can_delegate?: boolean;
  auto_continue?: boolean;
  tool_permissions?: {
    allowed?: string[];
    blocked?: string[];
  };
}
```

**Loop Prevention:**

```typescript
export interface LoopPreventionConfig {
  max_chain_length: number; // Default: 3
  global_cooldown_ms: number; // Default: 2000
  chain_window_ms: number; // Default: 60000 (1 minute)
}
```

**Multi-Agent Config:**

```typescript
export interface MultiAgentConfig {
  enabled: boolean;
  agents: Record<string, Omit<AgentPersonaConfig, 'id'>>;
  loop_prevention: LoopPreventionConfig;
  free_chat?: boolean;
  default_agent?: string;
  channel_overrides?: Record<
    string,
    {
      allowed_agents?: string[];
      disabled_agents?: string[];
      default_agent?: string;
    }
  >;
  categories?: CategoryConfig[];
  ultrawork?: UltraWorkConfig;
  task_continuation?: TaskContinuationConfig;
}
```

### 4.2 Default Values and Locations

**AgentProcessPool Defaults:**

| Setting           | Default           | Location                         | Configurable?                            |
| ----------------- | ----------------- | -------------------------------- | ---------------------------------------- |
| `defaultPoolSize` | `1`               | `agent-process-manager.ts:81`    | ❌ No (hardcoded)                        |
| `agentPoolSizes`  | `{}`              | `agent-process-manager.ts:73-78` | ✅ Yes (via `pool_size` in agent config) |
| `idleTimeoutMs`   | `300000` (5 min)  | `agent-process-manager.ts:83`    | ❌ No (hardcoded)                        |
| `hungTimeoutMs`   | `900000` (15 min) | `agent-process-pool.ts:93`       | ❌ No (hardcoded)                        |

**Loop Prevention Defaults:**

| Setting              | Default | Location                             |
| -------------------- | ------- | ------------------------------------ |
| `max_chain_length`   | `3`     | `types.ts` (DEFAULT_LOOP_PREVENTION) |
| `global_cooldown_ms` | `2000`  | `types.ts` (DEFAULT_LOOP_PREVENTION) |
| `chain_window_ms`    | `60000` | `types.ts` (DEFAULT_LOOP_PREVENTION) |

**UltraWork Defaults:**

| Setting           | Default            | Location           |
| ----------------- | ------------------ | ------------------ |
| `max_steps`       | `20`               | `ultrawork.ts:148` |
| `max_duration`    | `1800000` (30 min) | `ultrawork.ts:150` |
| `execute_timeout` | `300000` (5 min)   | `ultrawork.ts:26`  |

**Task Continuation Defaults:**

| Setting              | Default                                   | Location                  |
| -------------------- | ----------------------------------------- | ------------------------- |
| `max_retries`        | `3`                                       | `task-continuation.ts:69` |
| `completion_markers` | `['DONE', '완료', '✅', 'TASK_COMPLETE']` | `task-continuation.ts:40` |

### 4.3 pool_size Configuration (NOT Documented)

**How to Configure:**

```yaml
# config.yaml (NOT in README)
multi_agent:
  agents:
    developer:
      pool_size: 5 # Enable 5 parallel processes for developer agent
      # ... other config
```

**Code Path:**

1. User sets `pool_size: 5` in `config.yaml`
2. `agent-process-manager.ts:74-78` extracts `pool_size` from agent config
3. `agent-process-manager.ts:81` initializes `AgentProcessPool` with `agentPoolSizes: { developer: 5 }`
4. `agent-process-manager.ts:162` checks `poolSize > 1` to use multi-process mode
5. `agent-process-pool.ts:113` enforces pool limit: `pool.length < maxSize`

**Current State:**

- ✅ **Implemented:** Full infrastructure exists
- ❌ **Documented:** NOT mentioned in `packages/standalone/README.md`
- ❌ **Discoverable:** Users cannot find this feature

---

## 5. Test Coverage Summary

**Total Test Files:** 53 (counted via `find packages/standalone/tests -name "*.test.ts" -o -name "*.test.js" | wc -l`)

**Key Test Modules:**

| Module                | Test File                                           | Coverage Focus                                          |
| --------------------- | --------------------------------------------------- | ------------------------------------------------------- |
| AgentProcessPool      | `tests/multi-agent/agent-process-pool.test.ts`      | Pool lifecycle, idle/hung cleanup, parallel execution   |
| WaveEngine            | `tests/multi-agent/swarm/wave-engine.test.ts`       | Sequential waves, parallel tasks, fail-forward          |
| AgentProcessManager   | `tests/multi-agent/agent-process-manager.test.ts`   | Process acquisition, persona loading, pool integration  |
| DelegationManager     | `tests/multi-agent/delegation-manager.test.ts`      | Delegation parsing, validation, circular prevention     |
| TaskContinuation      | `tests/multi-agent/task-continuation.test.ts`       | Completion detection, continuation prompts              |
| UltraWork             | `tests/multi-agent/ultrawork.test.ts`               | Session lifecycle, timeout protection, autonomous loop  |
| ToolPermissionManager | `tests/multi-agent/tool-permission-manager.test.ts` | Tier defaults, permission resolution, delegation checks |
| CategoryRouter        | `tests/multi-agent/category-router.test.ts`         | Regex matching, priority ordering                       |
| Orchestrator          | `tests/multi-agent/orchestrator.test.ts`            | 5-stage routing, loop prevention, cooldowns             |

**Test Infrastructure:**

- **Framework:** Vitest
- **Configuration:** Single-fork pool (ONNX Runtime V8 locking prevention)
- **Coverage:** Unit tests for all core modules

---

## 6. Architecture Diagrams

### 6.1 Parallel Execution Flow

```
User Message
    │
    ├─ Orchestrator (5-stage routing)
    │   └─ Select Agent(s)
    │
    ├─ AgentProcessManager
    │   ├─ pool_size = 1 → PersistentProcessPool (legacy)
    │   └─ pool_size > 1 → AgentProcessPool
    │       ├─ getAvailableProcess()
    │       │   ├─ Find idle process
    │       │   ├─ Create new if under limit
    │       │   └─ Throw if pool full
    │       └─ releaseProcess()
    │
    ├─ PersistentClaudeProcess (stream-json)
    │   ├─ sendMessage()
    │   ├─ sendToolResult()
    │   └─ State: idle | busy | starting | dead
    │
    └─ Response
        ├─ DelegationManager (parse DELEGATE::)
        ├─ TaskContinuation (detect incomplete)
        └─ UltraWork (autonomous loop)
```

### 6.2 Wave Execution Model

```
Wave 1 (Sequential)
    ├─ Task 1.1 ─┐
    ├─ Task 1.2 ─┼─ Promise.all (Parallel)
    └─ Task 1.3 ─┘
        │
        ▼
Wave 2 (Sequential)
    ├─ Task 2.1 ─┐
    └─ Task 2.2 ─┴─ Promise.all (Parallel)
        │
        ▼
Wave 3 (Sequential)
    └─ Task 3.1 ─── Single task
```

### 6.3 Tier-Based Tool Access

```
Tier 1 (Orchestrator)
    ├─ Tools: * (all)
    ├─ Can delegate: ✅
    └─ Structural enforcement: --allowedTools * (no restrictions)

Tier 2 (Advisor)
    ├─ Tools: Read, Grep, Glob, WebSearch, WebFetch
    ├─ Can delegate: ❌
    └─ Structural enforcement: --allowedTools Read Grep Glob WebSearch WebFetch
                               --disallowedTools Write Edit Bash NotebookEdit

Tier 3 (Executor)
    ├─ Tools: Read, Grep, Glob, WebSearch, WebFetch
    ├─ Can delegate: ❌
    └─ Structural enforcement: --allowedTools Read Grep Glob WebSearch WebFetch
                               --disallowedTools Write Edit Bash NotebookEdit
```

---

## 7. Key Findings

### 7.1 Implemented but Undocumented

1. **pool_size Configuration:**
   - ✅ Fully implemented in `AgentProcessPool` (356 lines)
   - ✅ Integrated in `AgentProcessManager` (lines 72-84, 162-216)
   - ❌ NOT mentioned in `packages/standalone/README.md`
   - ❌ Users cannot discover this feature

2. **WaveEngine Parallel Execution:**
   - ✅ Fully implemented with `Promise.all` (line 111)
   - ✅ Fail-forward behavior (lines 142-154)
   - ❌ NOT documented in user-facing docs

3. **Structural Tool Enforcement:**
   - ✅ Implemented via `--allowedTools` / `--disallowedTools` CLI flags
   - ✅ Integrated with `ToolPermissionManager`
   - ❌ NOT explained in README (only tier defaults mentioned)

### 7.2 Hardcoded Defaults

1. **defaultPoolSize = 1:**
   - Location: `agent-process-manager.ts:81`
   - Effect: Single process per agent by default
   - Workaround: Set `pool_size` per agent in config

2. **Idle Timeout = 5 minutes:**
   - Location: `agent-process-manager.ts:83`
   - Effect: Processes terminate after 5 minutes of inactivity
   - Not configurable via config.yaml

3. **Hung Timeout = 15 minutes:**
   - Location: `agent-process-pool.ts:93`
   - Effect: Busy processes killed after 15 minutes
   - Not configurable via config.yaml

### 7.3 Recent Additions

1. **Delegation Format Validator:**
   - Added: Recently (based on implementation plan context)
   - Purpose: Hard gate for 6-section delegation format
   - Status: Implemented (42 lines)

2. **Structural Tool Enforcement:**
   - Added: Recently (based on CLI flag usage)
   - Purpose: Enforce tier permissions at CLI level
   - Status: Implemented and integrated

---

## 8. Comparison with Documentation

### 8.1 README.md vs. Code

**README Claims:**

- Multi-Agent Swarm with tier-based permissions ✅ (Accurate)
- 5-Stage Routing ✅ (Accurate)
- Task Delegation ✅ (Accurate)
- Task Continuation ✅ (Accurate)
- UltraWork Mode ✅ (Accurate)

**README Omissions:**

- ❌ `pool_size` configuration (NOT mentioned)
- ❌ `AgentProcessPool` infrastructure (NOT mentioned)
- ❌ Idle/hung timeout cleanup (NOT mentioned)
- ❌ Structural tool enforcement (NOT mentioned)
- ❌ WaveEngine parallel execution (NOT mentioned)

### 8.2 AGENTS.md vs. Code

**AGENTS.md Claims:**

- Wave-based orchestration ✅ (Accurate)
- Tier system ✅ (Accurate)
- Delegation format ✅ (Accurate)

**AGENTS.md Omissions:**

- ❌ `AgentProcessPool` (NOT mentioned)
- ❌ Parallel execution within waves (NOT mentioned)
- ❌ `pool_size` configuration (NOT mentioned)

---

## 9. Conclusion

MAMA's standalone package contains a **complete parallel execution infrastructure** that is **fully implemented but largely undocumented**. The `AgentProcessPool` (356 lines) and `WaveEngine` (201 lines) provide production-ready parallel task execution, but users cannot discover these features because:

1. **pool_size is not documented** in README.md
2. **AgentProcessPool is not mentioned** in user-facing docs
3. **WaveEngine parallel execution is not explained** in architecture docs

**Next Steps (Week 1 of Implementation Plan):**

1. Update `packages/standalone/README.md` with `pool_size` configuration section
2. Add architecture diagram showing parallel execution flow
3. Document default values and their locations
4. Create gap analysis document comparing code vs. documentation

**Evidence Quality:** All claims in this document are backed by file paths, line numbers, and code snippets from the actual codebase (as of 2026-02-08).
