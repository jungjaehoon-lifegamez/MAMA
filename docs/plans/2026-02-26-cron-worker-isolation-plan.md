# Cron Worker Isolation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Isolate cron job execution from the OS agent by running cron in a dedicated PersistentClaudeProcess process with Haiku model, delivering results directly to gateways via EventEmitter.

**Architecture:** CronWorker manages its own PersistentClaudeProcess instance (Haiku, minimal system prompt). CronScheduler calls CronWorker.execute() instead of agentLoop.run(). Results flow through EventEmitter → CronResultRouter → gateway.sendMessage(). OS agent has zero awareness of cron.

**Tech Stack:** TypeScript, PersistentClaudeProcess, node-cron, EventEmitter, existing gateway interfaces

---

## Task 1: CronWorker class

**Files:**

- Create: `packages/standalone/src/scheduler/cron-worker.ts`
- Test: `packages/standalone/tests/scheduler/cron-worker.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CronWorker } from '../../src/scheduler/cron-worker.js';
import { EventEmitter } from 'events';

// Mock PersistentClaudeProcess
vi.mock('../../src/agent/persistent-cli-process.js', () => ({
  PersistentClaudeProcess: vi.fn().mockImplementation(() => ({
    sendMessage: vi.fn().mockResolvedValue({
      response: 'task completed',
      tokenUsage: { input: 10, output: 5 },
    }),
    stop: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  })),
}));

describe('CronWorker', () => {
  let worker: CronWorker;
  let emitter: EventEmitter;

  beforeEach(() => {
    emitter = new EventEmitter();
    worker = new CronWorker({ emitter });
  });

  afterEach(async () => {
    await worker.stop();
  });

  it('should execute a prompt and return result', async () => {
    const result = await worker.execute('echo hello');
    expect(result).toBe('task completed');
  });

  it('should emit cron:completed on success', async () => {
    const handler = vi.fn();
    emitter.on('cron:completed', handler);

    await worker.execute('echo hello', { jobId: 'test1', jobName: 'Test Job' });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'test1',
        jobName: 'Test Job',
        result: 'task completed',
      })
    );
  });

  it('should emit cron:failed on error', async () => {
    // Override mock to throw
    const { PersistentClaudeProcess } = await import('../../src/agent/persistent-cli-process.js');
    (PersistentClaudeProcess as any).mockImplementationOnce(() => ({
      sendMessage: vi.fn().mockRejectedValue(new Error('CLI crashed')),
      stop: vi.fn(),
      on: vi.fn(),
    }));

    const failWorker = new CronWorker({ emitter });
    const handler = vi.fn();
    emitter.on('cron:failed', handler);

    await expect(
      failWorker.execute('bad command', { jobId: 'fail1', jobName: 'Fail' })
    ).rejects.toThrow('CLI crashed');

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'fail1',
        error: 'CLI crashed',
      })
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/standalone && pnpm vitest run tests/scheduler/cron-worker.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
/**
 * CronWorker - Dedicated PersistentClaudeProcess instance for cron job execution.
 * Runs with Haiku model and minimal system prompt.
 * Emits results via EventEmitter, fully decoupled from OS agent.
 */

import { EventEmitter } from 'events';
import { PersistentClaudeProcess } from '../agent/persistent-cli-process.js';

const CRON_SYSTEM_PROMPT = `You are a cron job executor. Execute the given task and return the result.
Available tools: Bash, Read, Write.
Be concise. Return only the result.`;

const CRON_MODEL = 'claude-haiku-4-5-20251001';

export interface CronWorkerOptions {
  emitter: EventEmitter;
  model?: string;
  systemPrompt?: string;
}

export interface CronJobContext {
  jobId?: string;
  jobName?: string;
  channel?: string;
}

export interface CronCompletedEvent {
  jobId: string;
  jobName: string;
  result: string;
  duration: number;
  channel?: string;
}

export interface CronFailedEvent {
  jobId: string;
  jobName: string;
  error: string;
  duration: number;
  channel?: string;
}

export class CronWorker {
  private cli: PersistentClaudeProcess | null = null;
  private readonly emitter: EventEmitter;
  private readonly model: string;
  private readonly systemPrompt: string;

  constructor(options: CronWorkerOptions) {
    this.emitter = options.emitter;
    this.model = options.model ?? CRON_MODEL;
    this.systemPrompt = options.systemPrompt ?? CRON_SYSTEM_PROMPT;
  }

  private ensureCLI(): PersistentClaudeProcess {
    if (!this.cli) {
      this.cli = new PersistentClaudeProcess({
        sessionId: `cron-worker-${Date.now()}`,
        model: this.model,
        systemPrompt: this.systemPrompt,
        dangerouslySkipPermissions: true,
        allowedTools: CRON_ALLOWED_TOOLS,
        pluginDir: undefined, // No plugins
      });
    }
    return this.cli;
  }

  async execute(prompt: string, context: CronJobContext = {}): Promise<string> {
    const { jobId = 'unknown', jobName = 'unknown', channel } = context;
    const startTime = Date.now();

    try {
      const cli = this.ensureCLI();
      const result = await cli.sendMessage(prompt);
      const duration = Date.now() - startTime;

      this.emitter.emit('cron:completed', {
        jobId,
        jobName,
        result: result.response,
        duration,
        channel,
      } satisfies CronCompletedEvent);

      return result.response;
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMsg = error instanceof Error ? error.message : String(error);

      this.emitter.emit('cron:failed', {
        jobId,
        jobName,
        error: errorMsg,
        duration,
        channel,
      } satisfies CronFailedEvent);

      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.cli) {
      await this.cli.stop();
      this.cli = null;
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/standalone && pnpm vitest run tests/scheduler/cron-worker.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/standalone/src/scheduler/cron-worker.ts packages/standalone/tests/scheduler/cron-worker.test.ts
git commit -m "feat(cron): add CronWorker with dedicated PersistentClaudeProcess instance"
```

---

## Task 2: CronResultRouter class

**Files:**

- Create: `packages/standalone/src/scheduler/cron-result-router.ts`
- Test: `packages/standalone/tests/scheduler/cron-result-router.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CronResultRouter } from '../../src/scheduler/cron-result-router.js';
import { EventEmitter } from 'events';

describe('CronResultRouter', () => {
  let emitter: EventEmitter;
  let discordSend: ReturnType<typeof vi.fn>;
  let slackSend: ReturnType<typeof vi.fn>;
  let viewerSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    emitter = new EventEmitter();
    discordSend = vi.fn().mockResolvedValue(undefined);
    slackSend = vi.fn().mockResolvedValue(undefined);
    viewerSend = vi.fn().mockResolvedValue(undefined);
  });

  it('should route discord results to discord gateway', () => {
    new CronResultRouter({
      emitter,
      gateways: {
        discord: { sendMessage: discordSend },
        slack: { sendMessage: slackSend },
      },
    });

    emitter.emit('cron:completed', {
      jobId: 'j1',
      jobName: 'Daily Report',
      result: 'Report done',
      duration: 5000,
      channel: 'discord:123456',
    });

    expect(discordSend).toHaveBeenCalledWith('123456', expect.stringContaining('Daily Report'));
    expect(discordSend).toHaveBeenCalledWith('123456', expect.stringContaining('Report done'));
  });

  it('should route slack results to slack gateway', () => {
    new CronResultRouter({
      emitter,
      gateways: {
        slack: { sendMessage: slackSend },
      },
    });

    emitter.emit('cron:completed', {
      jobId: 'j2',
      jobName: 'Check',
      result: 'All good',
      duration: 1000,
      channel: 'slack:C12345',
    });

    expect(slackSend).toHaveBeenCalledWith('C12345', expect.stringContaining('All good'));
  });

  it('should not crash when no channel specified', () => {
    new CronResultRouter({ emitter, gateways: {} });

    // Should not throw
    emitter.emit('cron:completed', {
      jobId: 'j3',
      jobName: 'Silent',
      result: 'done',
      duration: 100,
    });
  });

  it('should handle cron:failed events', () => {
    new CronResultRouter({
      emitter,
      gateways: {
        discord: { sendMessage: discordSend },
      },
    });

    emitter.emit('cron:failed', {
      jobId: 'j4',
      jobName: 'Broken',
      error: 'timeout',
      duration: 30000,
      channel: 'discord:999',
    });

    expect(discordSend).toHaveBeenCalledWith('999', expect.stringContaining('Broken'));
    expect(discordSend).toHaveBeenCalledWith('999', expect.stringContaining('timeout'));
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/standalone && pnpm vitest run tests/scheduler/cron-result-router.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
/**
 * CronResultRouter - Routes cron job results directly to gateways.
 * Listens for cron:completed and cron:failed events,
 * parses channel config, and calls gateway.sendMessage().
 */

import { EventEmitter } from 'events';
import type { CronCompletedEvent, CronFailedEvent } from './cron-worker.js';

export interface GatewaySender {
  sendMessage(channelId: string, message: string): Promise<void>;
}

export interface CronResultRouterOptions {
  emitter: EventEmitter;
  gateways: {
    discord?: GatewaySender;
    slack?: GatewaySender;
    viewer?: GatewaySender;
  };
}

export class CronResultRouter {
  private readonly gateways: CronResultRouterOptions['gateways'];

  constructor(options: CronResultRouterOptions) {
    this.gateways = options.gateways;

    options.emitter.on('cron:completed', (event: CronCompletedEvent) => {
      this.routeResult(event);
    });

    options.emitter.on('cron:failed', (event: CronFailedEvent) => {
      this.routeError(event);
    });
  }

  private parseChannel(channel?: string): { gateway: string; channelId: string } | null {
    if (!channel) return null;
    const idx = channel.indexOf(':');
    if (idx === -1) return null;
    return {
      gateway: channel.substring(0, idx),
      channelId: channel.substring(idx + 1),
    };
  }

  private getGateway(name: string): GatewaySender | undefined {
    return this.gateways[name as keyof typeof this.gateways];
  }

  private routeResult(event: CronCompletedEvent): void {
    const target = this.parseChannel(event.channel);
    if (!target) {
      console.log(`[CronRouter] Job "${event.jobName}" completed (no channel, result stored only)`);
      return;
    }

    const gw = this.getGateway(target.gateway);
    if (!gw) {
      console.warn(
        `[CronRouter] Gateway "${target.gateway}" not available for job "${event.jobName}"`
      );
      return;
    }

    const message = `⏰ **[Cron] ${event.jobName}** (${(event.duration / 1000).toFixed(1)}s)\n${event.result}`;
    gw.sendMessage(target.channelId, message).catch((err) => {
      console.error(`[CronRouter] Failed to deliver result for "${event.jobName}":`, err);
    });
  }

  private routeError(event: CronFailedEvent): void {
    const target = this.parseChannel(event.channel);
    if (!target) {
      console.error(`[CronRouter] Job "${event.jobName}" failed: ${event.error}`);
      return;
    }

    const gw = this.getGateway(target.gateway);
    if (!gw) return;

    const message = `❌ **[Cron] ${event.jobName}** failed (${(event.duration / 1000).toFixed(1)}s)\nError: ${event.error}`;
    gw.sendMessage(target.channelId, message).catch((err) => {
      console.error(`[CronRouter] Failed to deliver error for "${event.jobName}":`, err);
    });
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/standalone && pnpm vitest run tests/scheduler/cron-result-router.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/standalone/src/scheduler/cron-result-router.ts packages/standalone/tests/scheduler/cron-result-router.test.ts
git commit -m "feat(cron): add CronResultRouter for direct gateway delivery"
```

---

## Task 3: Wire CronWorker into start.ts, remove agentLoop dependency

**Files:**

- Modify: `packages/standalone/src/cli/commands/start.ts:1437-1490`
- Modify: `packages/standalone/src/scheduler/index.ts` (export new modules)

**Step 1: Update scheduler/index.ts exports**

Add to `packages/standalone/src/scheduler/index.ts`:

```typescript
export { CronWorker } from './cron-worker.js';
export type {
  CronWorkerOptions,
  CronJobContext,
  CronCompletedEvent,
  CronFailedEvent,
} from './cron-worker.js';
export { CronResultRouter } from './cron-result-router.js';
export type { CronResultRouterOptions, GatewaySender } from './cron-result-router.js';
```

**Step 2: Replace agentLoop callback in start.ts**

Replace lines 1437-1453 (the old `scheduler.setExecuteCallback` block) with:

```typescript
// Initialize cron worker (dedicated PersistentClaudeProcess, Haiku model)
const cronEmitter = new EventEmitter();
const cronWorker = new CronWorker({ emitter: cronEmitter });

scheduler.setExecuteCallback(async (prompt: string) => {
  console.log(`[Cron] Executing: ${prompt.substring(0, 50)}...`);
  const job = scheduler.getRunningJob(); // Need to pass job context
  const result = await cronWorker.execute(prompt, {
    jobId: job?.id,
    jobName: job?.name,
    channel: job?.channel,
  });
  console.log(`[Cron] Completed: ${result.substring(0, 100)}...`);
  return result;
});
```

**Step 3: Initialize CronResultRouter after gateways are created**

After gateway initialization (around line 1610+), add:

```typescript
// Wire cron results to gateways
const cronResultRouter = new CronResultRouter({
  emitter: cronEmitter,
  gateways: {
    discord: discordGateway ?? undefined,
    slack: slackGateway ?? undefined,
  },
});
```

**Step 4: Add `channel` to job config loading**

In the job loading loop (lines 1471-1484), pass `channel` through to scheduler:

```typescript
scheduler.addJob({
  id: job.id,
  name: job.name,
  cronExpr: job.cron,
  prompt: job.prompt,
  enabled: job.enabled ?? true,
  channel: job.channel, // NEW: pass channel config
});
```

**Step 5: Add cleanup on shutdown**

Find the shutdown handler and add:

```typescript
await cronWorker.stop();
```

**Step 6: Run full test suite**

Run: `cd packages/standalone && pnpm vitest run tests/scheduler/`
Expected: All PASS

**Step 7: Commit**

```bash
git add packages/standalone/src/cli/commands/start.ts packages/standalone/src/scheduler/index.ts
git commit -m "feat(cron): wire CronWorker into start.ts, remove agentLoop dependency"
```

---

## Task 4: Add `channel` field to JobConfig and CronScheduler

**Files:**

- Modify: `packages/standalone/src/scheduler/types.ts:13-24`
- Modify: `packages/standalone/src/scheduler/cron-scheduler.ts:260-352`

**Step 1: Add `channel` to JobConfig**

In `types.ts`, add to `JobConfig`:

```typescript
export interface JobConfig {
  id: string;
  name: string;
  cronExpr: string;
  prompt: string;
  enabled?: boolean;
  channel?: string; // NEW: "discord:channelId" | "slack:channelId" | "viewer:sessionId"
}
```

**Step 2: Pass job context to executeCallback**

In `cron-scheduler.ts`, modify `executeJob()` to pass job metadata.
Current: `this.executeCallback(job.prompt)`
Change the callback signature to include job context:

```typescript
// Change callback type
private executeCallback?: (prompt: string, job: CronJob) => Promise<string>;

setExecuteCallback(callback: (prompt: string, job: CronJob) => Promise<string>): void {
  this.executeCallback = callback;
}
```

Then in `executeJob()`, change:

```typescript
// Before:
response = await this.executeCallback(job.prompt);
// After:
response = await this.executeCallback(job.prompt, job);
```

**Step 3: Update start.ts callback to use job parameter**

```typescript
scheduler.setExecuteCallback(async (prompt: string, job) => {
  console.log(`[Cron] Executing: ${prompt.substring(0, 50)}...`);
  const result = await cronWorker.execute(prompt, {
    jobId: job.id,
    jobName: job.name,
    channel: job.channel,
  });
  console.log(`[Cron] Completed: ${result.substring(0, 100)}...`);
  return result;
});
```

**Step 4: Run tests**

Run: `cd packages/standalone && pnpm vitest run tests/scheduler/`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/standalone/src/scheduler/types.ts packages/standalone/src/scheduler/cron-scheduler.ts packages/standalone/src/cli/commands/start.ts
git commit -m "feat(cron): add channel field to JobConfig, pass job context to callback"
```

---

## Task 5: Remove cron lane logic from agent-loop.ts

**Files:**

- Modify: `packages/standalone/src/agent/agent-loop.ts:549-556`

**Step 1: Remove cron branch from resolveGlobalLaneForSession**

```typescript
// Before:
private resolveGlobalLaneForSession(sessionKey: string): string | undefined {
  const key = sessionKey.toLowerCase();
  if (key.startsWith('cron:')) {
    return 'cron';
  }
  return undefined;
}

// After:
private resolveGlobalLaneForSession(sessionKey: string): string | undefined {
  // Cron jobs no longer flow through agentLoop (uses dedicated CronWorker)
  return undefined;
}
```

**Step 2: Run full test suite to check for regressions**

Run: `cd packages/standalone && pnpm test`
Expected: PASS (no tests should depend on cron lane routing)

**Step 3: Commit**

```bash
git add packages/standalone/src/agent/agent-loop.ts
git commit -m "refactor(cron): remove cron lane logic from agent-loop"
```

---

## Task 6: Update cron API handler for channel field

**Files:**

- Modify: `packages/standalone/src/api/cron-handler.ts`

**Step 1: Pass `channel` through API create/update**

In the POST handler (create job), include `channel` from request body:

```typescript
scheduler.addJob({
  id: generatedId,
  name: body.name,
  cronExpr: body.cron_expr,
  prompt: body.prompt,
  enabled: body.enabled ?? true,
  channel: body.channel, // NEW
});
```

In the PUT handler (update job), include `channel`:

```typescript
if (body.channel !== undefined) {
  // update channel
}
```

In the GET handler, include `channel` in response.

**Step 2: Update config sync to persist channel**

In `syncJobsToConfig()`, include `channel`:

```typescript
config.scheduling.jobs = scheduler.listJobs().map((job) => ({
  id: job.id,
  name: job.name,
  cron: job.cronExpr,
  prompt: job.prompt,
  enabled: job.enabled,
  channel: job.channel, // NEW
}));
```

**Step 3: Run API tests**

Run: `cd packages/standalone && pnpm vitest run tests/scheduler/`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/standalone/src/api/cron-handler.ts
git commit -m "feat(cron): support channel field in cron API endpoints"
```

---

## Task 7: Integration test

**Files:**

- Create: `packages/standalone/tests/scheduler/cron-isolation.integration.test.ts`

**Step 1: Write integration test**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { CronWorker } from '../../src/scheduler/cron-worker.js';
import { CronResultRouter } from '../../src/scheduler/cron-result-router.js';

vi.mock('../../src/agent/persistent-cli-process.js', () => ({
  PersistentClaudeProcess: vi.fn().mockImplementation(() => ({
    sendMessage: vi.fn().mockResolvedValue({
      response: 'cron result data',
      tokenUsage: { input: 10, output: 5 },
    }),
    stop: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  })),
}));

describe('Cron Isolation Integration', () => {
  let emitter: EventEmitter;
  let worker: CronWorker;
  let discordSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    emitter = new EventEmitter();
    worker = new CronWorker({ emitter });
    discordSend = vi.fn().mockResolvedValue(undefined);

    new CronResultRouter({
      emitter,
      gateways: {
        discord: { sendMessage: discordSend },
      },
    });
  });

  afterEach(async () => {
    await worker.stop();
  });

  it('should execute cron job and deliver result to discord', async () => {
    const result = await worker.execute('generate report', {
      jobId: 'daily',
      jobName: 'Daily Report',
      channel: 'discord:123456',
    });

    expect(result).toBe('cron result data');
    expect(discordSend).toHaveBeenCalledWith('123456', expect.stringContaining('Daily Report'));
    expect(discordSend).toHaveBeenCalledWith('123456', expect.stringContaining('cron result data'));
  });

  it('should not export agentLoop or lane dependencies', async () => {
    const workerModule = await import('../../src/scheduler/cron-worker.js');
    const exportedKeys = Object.keys(workerModule);
    expect(exportedKeys).not.toContain('agentLoop');
    expect(exportedKeys).not.toContain('lane');
    expect(exportedKeys).toContain('CronWorker');
  });
});
```

**Step 2: Run integration test**

Run: `cd packages/standalone && pnpm vitest run tests/scheduler/cron-isolation.integration.test.ts`
Expected: PASS

**Step 3: Run full test suite**

Run: `cd packages/standalone && pnpm test`
Expected: All PASS

**Step 4: Commit**

```bash
git add packages/standalone/tests/scheduler/cron-isolation.integration.test.ts
git commit -m "test(cron): add cron isolation integration test"
```
