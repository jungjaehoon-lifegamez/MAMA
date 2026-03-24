# Memory Agent Redesign — Implementation Plan

> Superseded for new execution by [2026-03-25-memory-v2-core-first-design.md](/Users/jeongjaehun/project/MAMA/docs/superpowers/specs/2026-03-25-memory-v2-core-first-design.md). This plan targets the older standalone-first JSON-extractor design and should not be used as the active implementation baseline.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace raw API call (HaikuClient) memory extraction with a multi-agent persistent process that uses existing MAMA OS infrastructure.

**Architecture:** Memory agent runs as a singleton PersistentClaudeProcess via `AgentProcessManager.getSharedProcess('memory')`. Triggered fire-and-forget after each conversation turn in `message-router.ts`. Per-turn context injection for both NEW and CONTINUE sessions via ContextInjector.

**Tech Stack:** TypeScript (standalone), PersistentClaudeProcess, AgentProcessManager, SQLite, config.yaml

**Spec:** `docs/superpowers/specs/2026-03-24-memory-agent-redesign.md`
**Branch:** `feat/haiku-memory-layer`

---

## File Map

| File                                                           | Action | Responsibility                                                            |
| -------------------------------------------------------------- | ------ | ------------------------------------------------------------------------- |
| `packages/standalone/src/multi-agent/agent-process-manager.ts` | Modify | Add `getSharedProcess(agentId)` singleton method                          |
| `packages/standalone/src/gateways/message-router.ts`           | Modify | Replace `autoExtractFacts` with memory agent trigger + per-turn injection |
| `packages/standalone/src/gateways/context-injector.ts`         | Modify | Add per-turn injection for CONTINUE sessions                              |
| `packages/standalone/src/agent/gateway-tool-executor.ts`       | Modify | Route `mama_add` through memory agent                                     |
| `packages/standalone/src/cli/commands/start.ts`                | Modify | Pass agentProcessManager to MessageRouter                                 |
| `~/.mama/personas/memory.md`                                   | Create | Memory agent persona (created at runtime if missing)                      |
| `packages/standalone/src/multi-agent/memory-agent-persona.ts`  | Create | Default persona constant + runtime persona file writer                    |
| `packages/standalone/tests/multi-agent/memory-agent.test.ts`   | Create | Integration tests                                                         |

---

### Task 1: Add `getSharedProcess()` to AgentProcessManager

**Files:**

- Modify: `packages/standalone/src/multi-agent/agent-process-manager.ts:97-310`

- [ ] **Step 1: Write test**

Create `packages/standalone/tests/multi-agent/memory-agent.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('AgentProcessManager.getSharedProcess', () => {
  it('should return the same process for multiple calls with same agentId', async () => {
    // getSharedProcess('memory') called twice should return same process instance
  });

  it('should use fixed channelKey __system__:<agentId>', async () => {
    // Verify the channelKey is '__system__:memory'
  });
});
```

Note: Full mock setup depends on existing test patterns in `packages/standalone/tests/`. Check how `agent-process-manager` is tested elsewhere and follow the same pattern.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/standalone && npx vitest run tests/multi-agent/memory-agent.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `getSharedProcess()`**

In `packages/standalone/src/multi-agent/agent-process-manager.ts`, add after `getProcess()` method:

```typescript
/**
 * Get a shared singleton process for system-level agents (e.g., memory agent).
 * Unlike getProcess() which creates per-channel processes, this returns
 * a single persistent process shared across all channels.
 *
 * Uses fixed channelKey: `__system__:<agentId>`
 */
async getSharedProcess(
  agentId: string,
  overrides?: { requestTimeout?: number }
): Promise<AgentRuntimeProcess> {
  return this.getProcess('__system__', agentId, agentId, overrides);
}
```

This reuses the existing `getProcess()` with a fixed source=`__system__` and channelId=agentId, producing channelKey `__system__:memory:memory`. The AgentProcessManager's PersistentProcessPool will reuse the same process for this key.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/standalone && npx vitest run tests/multi-agent/memory-agent.test.ts`
Expected: PASS

- [ ] **Step 5: Build**

Run: `cd packages/standalone && pnpm build`
Expected: PASS (32 tools)

- [ ] **Step 6: Commit**

```bash
git add packages/standalone/src/multi-agent/agent-process-manager.ts packages/standalone/tests/multi-agent/memory-agent.test.ts
git commit -m "feat(memory-agent): add getSharedProcess() singleton for system agents"
```

---

### Task 2: Create Memory Agent Persona

**Files:**

- Create: `packages/standalone/src/multi-agent/memory-agent-persona.ts`

- [ ] **Step 1: Create default persona constant**

Create `packages/standalone/src/multi-agent/memory-agent-persona.ts`:

```typescript
/**
 * Default persona for the memory agent.
 * Written to ~/.mama/personas/memory.md on first use if not present.
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export const MEMORY_AGENT_PERSONA = `You are MAMA's memory agent — an always-on observer that watches conversations and extracts knowledge worth remembering.

## Your Role
- Observe every conversation turn between users and the main agent
- Extract decisions, preferences, lessons, and constraints
- Return structured JSON for storage — never respond to users directly

## Output Format
Return ONLY a JSON object:
\`\`\`json
{
  "facts": [
    {
      "topic": "snake_case_topic",
      "decision": "clear one-sentence decision",
      "reasoning": "brief why",
      "is_static": true or false,
      "confidence": 0.0 to 1.0,
      "relationship": null
    }
  ]
}
\`\`\`

If a fact relates to an existing topic, include relationship:
\`\`\`json
"relationship": {"type": "supersedes", "target_topic": "existing_topic"}
\`\`\`

## Topic Rules
- MUST reuse existing topic if same subject (provided in context)
- Use lowercase snake_case: auth_strategy, database_choice
- Same topic = evolution chain (supersedes)
- Related topic = builds_on or synthesizes

## Relationship Types (match DB schema)
- supersedes: replaces a previous decision on same topic
- builds_on: adds information to existing topic without replacing
- synthesizes: merges multiple decisions or infers connections

## What to Extract
- Architecture decisions, technical choices, tooling preferences
- User preferences and working style (is_static: true)
- Constraints, requirements, lessons learned
- Decision changes (relationship: supersedes)

## What to SKIP (return {"facts": []})
- Greetings, casual chat, thanks
- Questions without answers
- Temporary debugging steps
- Code snippets

Return {"facts": []} if nothing worth saving.
Return ONLY the JSON, no other text.`;

/**
 * Ensure persona file exists at ~/.mama/personas/memory.md
 * Creates it from default if not present.
 */
export function ensureMemoryPersona(): string {
  const personaDir = join(homedir(), '.mama', 'personas');
  const personaPath = join(personaDir, 'memory.md');

  if (!existsSync(personaPath)) {
    if (!existsSync(personaDir)) {
      mkdirSync(personaDir, { recursive: true });
    }
    writeFileSync(personaPath, MEMORY_AGENT_PERSONA, 'utf-8');
  }

  return personaPath;
}
```

- [ ] **Step 2: Build**

Run: `cd packages/standalone && pnpm build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/standalone/src/multi-agent/memory-agent-persona.ts
git commit -m "feat(memory-agent): add default memory agent persona"
```

---

### Task 3: Wire Memory Agent into MessageRouter

**Files:**

- Modify: `packages/standalone/src/gateways/message-router.ts`
- Modify: `packages/standalone/src/cli/commands/start.ts`

This is the core task — replace `autoExtractFacts()` (raw API call) with memory agent persistent process.

- [ ] **Step 1: Add AgentProcessManager to MessageRouter constructor**

In `packages/standalone/src/gateways/message-router.ts`, the constructor currently takes `(sessionStore, agentLoopClient, mamaApiClient, config)`. Add `agentProcessManager` as optional parameter:

```typescript
import type { AgentProcessManager } from '../multi-agent/agent-process-manager.js';

// In constructor:
constructor(
  sessionStore: SessionStore,
  agentLoopClient: AgentLoopClient,
  mamaApi: MamaApiClient,
  config: MessageRouterConfig,
  private agentProcessManager?: AgentProcessManager,
) {
```

- [ ] **Step 2: Replace `autoExtractFacts()` with memory agent trigger**

Replace the entire `autoExtractFacts` method (lines ~984-1041) with:

```typescript
/**
 * Trigger memory agent to extract facts from conversation (fire-and-forget).
 * Uses AgentProcessManager singleton process instead of raw API calls.
 * Skips short exchanges, rate-limits per cooldown.
 */
private lastExtractTime = 0;
private extractQueue: string[] = [];
private extracting = false;
private static readonly EXTRACT_COOLDOWN_MS = 30_000;
private static readonly MIN_CONTENT_LENGTH = 100;
private static readonly MAX_CONTENT_LENGTH = 10_000;

private async triggerMemoryAgent(userText: string, botResponse: string): Promise<void> {
  if (!this.agentProcessManager) return;

  const now = Date.now();
  if (now - this.lastExtractTime < MessageRouter.EXTRACT_COOLDOWN_MS) return;

  let content = `User: ${userText}\nAssistant: ${botResponse}`;
  if (content.length < MessageRouter.MIN_CONTENT_LENGTH) return;
  if (content.length > MessageRouter.MAX_CONTENT_LENGTH) {
    content = content.substring(0, MessageRouter.MAX_CONTENT_LENGTH);
  }

  // Set cooldown immediately to prevent duplicate triggers
  this.lastExtractTime = now;

  try {
    // Get existing topics from DB for topic consistency
    let existingTopics: string[] = [];
    try {
      const { getAdapter } = await import('@jungjaehoon/mama-core/db-manager');
      const adapter = getAdapter();
      const rows = adapter
        .prepare(
          'SELECT DISTINCT topic FROM decisions WHERE superseded_by IS NULL ORDER BY created_at DESC LIMIT 50'
        )
        .all() as { topic: string }[];
      existingTopics = rows.map((r: { topic: string }) => r.topic);
    } catch {
      // DB not ready
    }

    const topicContext = existingTopics.length > 0
      ? `[Existing topics: ${existingTopics.join(', ')}]\n\n`
      : '';

    const message = `${topicContext}Conversation:\n${content}`;

    // Get singleton memory agent process
    const process = await this.agentProcessManager.getSharedProcess('memory');

    // Send message and parse response
    const result = await process.sendMessage(message);
    const responseText = typeof result === 'string' ? result : result?.response || '';

    // Parse JSON facts from response
    const jsonMatch = responseText.match(/\{[\s\S]*"facts"[\s\S]*\}/);
    if (!jsonMatch) return;

    const parsed = JSON.parse(jsonMatch[0]);
    const facts = parsed.facts;
    if (!Array.isArray(facts) || facts.length === 0) return;

    if (!this.mamaApi.save) return;

    for (const fact of facts) {
      if (!fact.topic || !fact.decision) continue;
      try {
        const topic = String(fact.topic).toLowerCase().replace(/\s+/g, '_');
        await this.mamaApi.save({
          topic,
          decision: String(fact.decision),
          reasoning: `[auto-extracted] ${fact.reasoning || ''}`,
          confidence: typeof fact.confidence === 'number' ? fact.confidence : 0.5,
          is_static: fact.is_static ? 1 : 0,
        });
        logger.info(`[memory-agent] Saved: ${topic}`);
      } catch {
        // Continue with other facts
      }
    }
  } catch (err) {
    logger.warn(`[memory-agent] Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

- [ ] **Step 3: Update the fire-and-forget call site**

Find the line (around line 557):

```typescript
this.autoExtractFacts(message.text, response).catch(() => {});
```

Replace with:

```typescript
this.triggerMemoryAgent(message.text, response).catch(() => {});
```

- [ ] **Step 4: Remove old imports**

Remove the `cachedHaikuClient` property and any imports of `HaikuClient`/`extractFacts` from message-router.ts.

- [ ] **Step 5: Pass AgentProcessManager in start.ts**

In `packages/standalone/src/cli/commands/start.ts`, find the MessageRouter construction (around line 1453):

```typescript
const messageRouter = new MessageRouter(sessionStore, agentLoopClient, mamaApiClient, {
  backend: runtimeBackend,
});
```

Find `agentProcessManager` in the same file — it should already exist for multi-agent support. Pass it:

```typescript
const messageRouter = new MessageRouter(
  sessionStore,
  agentLoopClient,
  mamaApiClient,
  {
    backend: runtimeBackend,
  },
  agentProcessManager
);
```

If `agentProcessManager` is created after `messageRouter`, you may need to reorder or set it later via a setter method. Check the initialization order carefully.

- [ ] **Step 6: Ensure memory agent config exists**

In `packages/standalone/src/cli/commands/start.ts`, before the agentProcessManager is used, ensure the memory agent has a default config:

```typescript
// Ensure memory agent is configured
if (!config.agents?.memory) {
  if (!config.agents) config.agents = {};
  config.agents.memory = {
    enabled: true,
    model: 'claude-sonnet-4-6',
    backend: 'claude',
    tier: 1,
    can_delegate: false,
  };
}
```

Also call `ensureMemoryPersona()` from `memory-agent-persona.ts` to create the persona file if needed.

- [ ] **Step 7: Build and test**

Run: `cd packages/standalone && pnpm build`
Expected: PASS (32 tools)

Run: `cd packages/standalone && pnpm test`
Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
git add packages/standalone/src/gateways/message-router.ts packages/standalone/src/cli/commands/start.ts
git commit -m "feat(memory-agent): replace raw API call with persistent process trigger"
```

---

### Task 4: Per-Turn Context Injection for CONTINUE Sessions

**Files:**

- Modify: `packages/standalone/src/gateways/context-injector.ts`
- Modify: `packages/standalone/src/gateways/message-router.ts`

- [ ] **Step 1: Add per-turn injection to message-router**

In `message-router.ts`, find where the user message is sent to the agent loop. Before the agent loop call, add context injection for ALL sessions (not just NEW):

```typescript
// Per-turn context injection — works for both NEW and CONTINUE sessions
let enhancedUserMessage = userMessage;
if (this.contextInjector && userMessage) {
  try {
    const relevantContext = await this.contextInjector.getRelevantContext(userMessage);
    if (relevantContext.hasContext) {
      enhancedUserMessage = `[MAMA Memory]\n${relevantContext.prompt}\n[/MAMA Memory]\n\n${userMessage}`;
    }
  } catch {
    // Context injection failure is non-fatal
  }
}
```

Find the exact location by searching for where `agentLoop.run()` or `agentLoopClient.run()` is called with the user's message. The context prefix should be added to the message content, not the system prompt.

- [ ] **Step 2: Build and test**

Run: `cd packages/standalone && pnpm build && pnpm test`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add packages/standalone/src/gateways/message-router.ts
git commit -m "feat(memory-agent): per-turn context injection for CONTINUE sessions"
```

---

### Task 5: Route mama_add Through Memory Agent

**Files:**

- Modify: `packages/standalone/src/agent/gateway-tool-executor.ts`

- [ ] **Step 1: Update handleMamaAdd to use memory agent**

Replace the existing `handleMamaAdd` method body. Instead of importing HaikuClient/extractFacts directly, route through the memory agent singleton:

```typescript
private async handleMamaAdd(input: { content: string }): Promise<GatewayToolResult> {
  const { content } = input;
  if (!content || typeof content !== 'string') {
    return { success: false, error: 'content is required and must be a string' } as GatewayToolResult;
  }

  // Route through memory agent persistent process
  const agentProcessManager = this.agentProcessManager;
  if (!agentProcessManager) {
    return {
      success: false,
      error: 'Memory agent unavailable. Use mama_save to save manually.',
    } as GatewayToolResult;
  }

  try {
    const process = await agentProcessManager.getSharedProcess('memory');
    const result = await process.sendMessage(content);
    const responseText = typeof result === 'string' ? result : result?.response || '';

    // Parse JSON facts
    const jsonMatch = responseText.match(/\{[\s\S]*"facts"[\s\S]*\}/);
    if (!jsonMatch) {
      return { success: true, extracted: 0, saved: 0, message: 'No facts found.' } as GatewayToolResult;
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const facts = parsed.facts;
    if (!Array.isArray(facts) || facts.length === 0) {
      return { success: true, extracted: 0, saved: 0, message: 'No facts worth saving.' } as GatewayToolResult;
    }

    const api = await this.initializeMAMAApi();
    let saved = 0;
    for (const fact of facts) {
      if (!fact.topic || !fact.decision) continue;
      try {
        await handleSave(api, {
          type: 'decision',
          topic: String(fact.topic).toLowerCase().replace(/\s+/g, '_'),
          decision: String(fact.decision),
          reasoning: `[auto-extracted] ${fact.reasoning || ''}`,
          confidence: typeof fact.confidence === 'number' ? fact.confidence : 0.5,
          is_static: fact.is_static ? 1 : 0,
        } as SaveDecisionInput);
        saved++;
      } catch {
        // Continue
      }
    }

    return { success: true, extracted: facts.length, saved } as GatewayToolResult;
  } catch (err) {
    return {
      success: false,
      error: `Memory agent failed: ${err instanceof Error ? err.message : String(err)}`,
    } as GatewayToolResult;
  }
}
```

- [ ] **Step 2: Add agentProcessManager to GatewayToolExecutor**

The `GatewayToolExecutor` needs access to `agentProcessManager`. Check if it's already available via the constructor options or if it needs to be added.

Search for `GatewayToolExecutorOptions` in `types.ts` and add `agentProcessManager?: AgentProcessManager` if not present.

- [ ] **Step 3: Remove HaikuClient/extractFacts imports**

Remove any remaining imports of `@jungjaehoon/mama-core/haiku-client` and `@jungjaehoon/mama-core/fact-extractor` from `gateway-tool-executor.ts`.

- [ ] **Step 4: Build and test**

Run: `cd packages/standalone && pnpm build && pnpm test`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/standalone/src/agent/gateway-tool-executor.ts packages/standalone/src/agent/types.ts
git commit -m "feat(memory-agent): route mama_add through memory agent persistent process"
```

---

### Task 6: Monitoring — Memory Agent Stats API + Playground

**Files:**

- Modify: `packages/standalone/src/api/graph-api.ts` (or appropriate API handler)
- Create playground HTML via `playground_create` tool

- [ ] **Step 1: Add stats tracking**

In `message-router.ts`, add a stats counter for memory agent:

```typescript
private memoryAgentStats = {
  turnsObserved: 0,
  factsExtracted: 0,
  factsSaved: 0,
  factsFailed: 0,
  lastExtraction: null as number | null,
};
```

Update `triggerMemoryAgent()` to increment these counters.

- [ ] **Step 2: Expose stats via API endpoint**

Add `GET /api/memory-agent/stats` endpoint that returns the stats object as JSON.

- [ ] **Step 3: Create playground dashboard**

Use `playground_create` gateway tool to create an HTML dashboard that fetches `/api/memory-agent/stats` and displays:

- Status (active/inactive)
- Turns observed, facts extracted/saved
- Recent extractions list
- Edge graph summary

- [ ] **Step 4: Build and test**

Run: `cd packages/standalone && pnpm build && pnpm test`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(memory-agent): add stats API and playground dashboard"
```

---

### Task 7: Full Pipeline E2E Test

- [ ] **Step 1: Build all packages**

```bash
pnpm build
```

- [ ] **Step 2: Run all tests**

```bash
pnpm test
```

Expected: ALL PASS across mama-core, mcp-server, standalone, mama-plugin

- [ ] **Step 3: E2E — Memory agent extraction via persistent process**

Restart MAMA OS with new build:

```bash
node packages/standalone/dist/cli/index.js stop
node packages/standalone/dist/cli/index.js start
```

Send meaningful message on Telegram. Check logs:

```bash
tail -50 ~/.mama/logs/daemon.log | grep "memory-agent"
```

Expected: `[memory-agent] Saved: <topic>` entries

- [ ] **Step 4: E2E — Per-turn context injection**

Send follow-up message on same topic. Verify the agent's response references the previously saved fact (injected via context).

- [ ] **Step 5: E2E — Edge creation on topic reuse**

Send a message that contradicts a previous decision. Check DB:

```bash
sqlite3 ~/.mama/mama-memory.db "SELECT * FROM decision_edges ORDER BY created_at DESC LIMIT 5"
```

Expected: supersedes edge

- [ ] **Step 6: E2E — Stats API**

```bash
curl http://localhost:3847/api/memory-agent/stats
```

Expected: JSON with extraction counts

- [ ] **Step 7: Commit any fixes**

---

### Task 8: Cleanup — Remove HaikuClient/FactExtractor

**Files:**

- Delete: `packages/mama-core/src/haiku-client.ts`
- Delete: `packages/mama-core/src/fact-extractor.ts`
- Delete: `packages/mama-core/tests/unit/haiku-client.test.ts`
- Delete: `packages/mama-core/tests/unit/fact-extractor.test.ts`
- Modify: `packages/mama-core/src/index.ts` (remove exports)
- Modify: `packages/mama-core/package.json` (remove export paths)
- Modify: `packages/mcp-server/src/tools/add-memory.js` (remove HaikuClient/extractFacts imports)

**IMPORTANT:** Only do this AFTER Task 7 e2e confirms the new pipeline works. If the memory agent persistent process approach has issues, these files are the fallback.

- [ ] **Step 1: Remove source files**

```bash
rm packages/mama-core/src/haiku-client.ts
rm packages/mama-core/src/fact-extractor.ts
rm packages/mama-core/tests/unit/haiku-client.test.ts
rm packages/mama-core/tests/unit/fact-extractor.test.ts
```

- [ ] **Step 2: Remove exports from index.ts**

Remove lines exporting `HaikuClient`, `extractFacts`, `haiku-client`, `fact-extractor`.

- [ ] **Step 3: Remove export paths from package.json**

Remove `"./haiku-client"` and `"./fact-extractor"` from exports.

- [ ] **Step 4: Update add-memory.js**

In `packages/mcp-server/src/tools/add-memory.js`, remove the HaikuClient/extractFacts imports and update `execute()` to route through a simpler mechanism (or mark the tool as deprecated in favor of automatic extraction).

- [ ] **Step 5: Build and test all**

```bash
pnpm build && pnpm test
```

Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: remove HaikuClient/FactExtractor — replaced by memory agent persistent process"
```
