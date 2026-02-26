# Cron Worker Isolation Design

## Problem

Cron jobs share the OS agent's `agentLoop.run()`, causing session contention.
When the OS agent is busy (e.g., long WebSearch chains), cron jobs queue up and hit
the 300s timeout in `message-router.ts:314`. Viewer messages also get blocked.

## Solution

Separate cron execution into an independent PersistentCLI instance with its own
lightweight system prompt and model. Results are delivered directly to gateways
via EventEmitter, bypassing the OS agent entirely.

## Architecture

```text
┌─ MAMA OS Process ─────────────────────────────────────┐
│                                                       │
│  ┌─ OS Agent ──────────┐   ┌─ Cron Worker ──────────┐ │
│  │ PersistentCLI #1    │   │ PersistentCLI #2       │ │
│  │ Full system prompt  │   │ Minimal prompt          │ │
│  │ Sonnet model        │   │ Haiku model             │ │
│  │ Viewer/Discord/     │   │ Cron job execution only │ │
│  │ Slack sessions      │   │ No channel awareness    │ │
│  └─────────────────────┘   └──────────┬─────────────┘ │
│                                       │               │
│                              EventEmitter              │
│                           'cron:completed'             │
│                                       │               │
│                            ┌──────────▼─────────────┐ │
│                            │ CronResultRouter       │ │
│                            │ channel mapping → gw   │ │
│                            │ direct sendMessage()   │ │
│                            └────────────────────────┘ │
└───────────────────────────────────────────────────────┘
```

## Key Decisions

| Item                 | Decision                                                           |
| -------------------- | ------------------------------------------------------------------ |
| CLI                  | Separate PersistentCLI instance                                    |
| Model                | Haiku (lightweight, fast)                                          |
| System prompt        | Minimal — Bash/Read/Write tools + cron execution instructions only |
| Result delivery      | EventEmitter → CronResultRouter → Gateway direct send              |
| OS agent involvement | None. Fully decoupled                                              |
| Session              | Cron-dedicated session. Independent of OS sessions                 |
| Channel routing      | Job config `channel` field determines destination gateway          |

## Components

### 1. CronWorker (new)

**File:** `src/scheduler/cron-worker.ts`

- Creates and manages a dedicated PersistentCLI instance
- Haiku model, minimal system prompt
- Exposes `execute(prompt: string): Promise<string>`
- Emits `cron:completed` and `cron:failed` events

System prompt (~50 tokens):

```text
You are a cron job executor. Execute the given task and return the result.
Available tools: Bash, Read, Write.
Be concise. Return only the result.
```

### 2. CronResultRouter (new)

**File:** `src/scheduler/cron-result-router.ts`

- Listens to EventEmitter for `cron:completed` events
- Maps job's `channel` config to the appropriate gateway
- Calls gateway `sendMessage()` directly (no agentLoop)
- Formats result as: `[Cron] {jobName}: {result summary}`

### 3. start.ts changes

- Remove `agentLoop.run()` callback from scheduler
- Initialize CronWorker with Haiku model + minimal prompt
- Initialize CronResultRouter with gateway references
- Wire: scheduler → CronWorker → EventEmitter → CronResultRouter → gateways

### 4. cron-scheduler.ts changes

- `executeCallback` now calls CronWorker.execute() instead of agentLoop.run()
- No lane routing needed (CronWorker has its own CLI process)

### 5. Lane cleanup

- Remove cron-specific lane logic from agent-loop.ts
- Remove `resolveGlobalLaneForSession` cron branch
- Cron no longer flows through the lane system

## Job Config Extension

```yaml
scheduling:
  jobs:
    - id: daily_report
      name: Daily Report
      cron: '0 9 * * *'
      prompt: 'Generate daily summary'
      enabled: true
      channel: discord:123456789 # gateway:channelId format
```

## Event Schema

```typescript
interface CronCompletedEvent {
  jobId: string;
  jobName: string;
  result: string;
  duration: number;
  channel?: string; // "discord:channelId" | "slack:channelId" | "viewer:sessionId"
}

interface CronFailedEvent {
  jobId: string;
  jobName: string;
  error: string;
  duration: number;
  channel?: string;
}
```

## Migration

- Existing cron jobs continue to work (same config format)
- `channel` field becomes meaningful for result delivery
- No database schema changes needed
- Backward compatible: jobs without `channel` store results in DB only (current behavior)
