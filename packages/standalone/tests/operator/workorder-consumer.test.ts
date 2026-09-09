/**
 * Story S2-T3: workorder consumer - serial consumption, retry policy, alarms,
 * completion hooks. Real in-memory TaskLedger; fake runner/alarm sinks.
 * Plan: docs/superpowers/plans/2026-07-18-stage2-workorder-ownership.md
 */
import { createHash } from 'node:crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OwnerActionEffectLedger } from '../../src/operator/owner-action-effects.js';
import { AgentError } from '../../src/agent/types.js';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { TaskLedger } from '../../src/operator/task-ledger.js';
import {
  WorkOrderConsumer,
  WORKORDER_MAX_ATTEMPTS,
  detectTransportErrorResponse,
  classifyTransientModelError,
  type WorkOrderConsumerDeps,
  type WorkOrderConsumerEvent,
  classifyTemporalFailure,
  buildTurnKindSection,
  DELEGATED_ATTEMPT_TIMEOUT_MS,
  NATIVE_SUBAGENT_ITEM_NAMES,
} from '../../src/operator/workorder-consumer.js';
import { ThreadBriefMemory } from '../../src/operator/thread-brief-memory.js';

function makeDeps(overrides: Partial<WorkOrderConsumerDeps> = {}): {
  deps: WorkOrderConsumerDeps;
  ledger: TaskLedger;
  notices: string[];
  activeSends: string[];
  events: WorkOrderConsumerEvent[];
  logs: string[];
  db: SQLiteDatabase;
} {
  const db: SQLiteDatabase = new Database(':memory:');
  const ledger = new TaskLedger(db);
  const notices: string[] = [];
  const activeSends: string[] = [];
  const events: WorkOrderConsumerEvent[] = [];
  const logs: string[] = [];
  const deps: WorkOrderConsumerDeps = {
    ledger,
    runner: {
      runWithContent: async () => ({ response: 'ok done' }),
    },
    loadOwnerBrief: () => 'You are a test worker. Do the work.',
    noticeOwner: (summary) => notices.push(summary),
    opsAlarm: { configured: true, send: async (line) => void activeSends.push(line) },
    onEvent: (event) => events.push(event),
    log: (line) => logs.push(line),
    ...overrides,
  };
  return { deps, ledger, db, notices, activeSends, events, logs };
}

function enqueueTemporalDue(ledger: TaskLedger): string {
  const task = ledger.create({ title: 'due', due_at: '2026-07-21T00:00:00Z' });
  const occurrenceKey = `epoch:${task.temporalEpoch}:due:${task.dueAt}`;
  const generationKey = `task:${task.id}:${occurrenceKey}:check:${task.dueAt}`;
  ledger.enqueueTemporalGeneration({
    generationKey,
    taskId: task.id,
    temporalEpoch: task.temporalEpoch,
    occurrenceKey,
    checkAt: task.dueAt!,
    sourceChannel: null,
    sourceEventId: null,
  });
  return generationKey;
}

describe('Story S2-T3: WorkOrderConsumer', () => {
  let ctx: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    ctx = makeDeps();
  });

  it.each(['before-run', 'after-effect', 'returned-unsettled'] as const)(
    'TG-06 suppresses unsafe owner replay %s',
    async (phase) => {
      const effects = new OwnerActionEffectLedger(ctx.db);
      let runs = 0;
      const identity = {
        ownerScope: 'owner:runtime',
        occurrenceKey: 'workorder:wiki:effect',
        modelRunId: 'mr-effect',
        envelopeHash: 'hash',
      };
      const record = () => effects.begin(identity, 'shell', 'Bash', { commandSha256: 'test' });
      if (phase === 'before-run') {
        record();
      }
      ctx.deps.hasUnsettledEffects = (wo) =>
        effects.hasUnsettledEffects(`workorder:${wo.idempotencyKey}`);
      ctx.deps.hasUnsafeReplayEffects = (wo) =>
        effects.hasUnsafeReplayEffects(`workorder:${wo.idempotencyKey}`);
      ctx.deps.runner = {
        runWithContent: async () => {
          runs++;
          record();
          if (phase === 'returned-unsettled') {
            return { response: 'claimed success' };
          }
          throw new Error('transport failed');
        },
      };
      ctx.ledger.enqueueWorkOrder({
        workKind: 'wiki',
        idempotencyKey: 'wiki:effect',
        input: { events: [] },
      });
      await new WorkOrderConsumer(ctx.deps).tick();
      expect(runs).toBe(phase === 'before-run' ? 0 : 1);
      expect(ctx.events.some((event) => event.type === 'requeued')).toBe(false);
      expect(ctx.events.some((event) => event.type === 'failed')).toBe(true);
      ctx.db.close();
    }
  );

  describe('console brief: standing policy reaches the thread once', () => {
    async function runOrder(deps: WorkOrderConsumerDeps, ledger: TaskLedger, key: string) {
      ledger.enqueueWorkOrder({ workKind: 'wiki', idempotencyKey: key, input: { events: [] } });
      await new WorkOrderConsumer(deps).tick();
    }

    it('sends the brief on the first turn, omits it while unchanged, resends on a change', async () => {
      const local = makeDeps();
      const prompts: string[] = [];
      const memory = new ThreadBriefMemory();
      let brief = 'BRIEF-ONE. Do the work.';
      local.deps.loadOwnerBrief = () => brief;
      local.deps.admitOwnerBrief = (text) => memory.admit('owner:runtime', text);
      local.deps.runner = {
        runWithContent: async (content) => {
          prompts.push(content.map((block) => ('text' in block ? block.text : '')).join(''));
          return { response: 'ok done' };
        },
      };

      await runOrder(local.deps, local.ledger, 'wiki:b1');
      await runOrder(local.deps, local.ledger, 'wiki:b2');
      brief = 'BRIEF-TWO. Corrected by the owner.';
      await runOrder(local.deps, local.ledger, 'wiki:b3');
      await runOrder(local.deps, local.ledger, 'wiki:b4');

      expect(prompts).toHaveLength(4);
      expect(prompts[0]).toContain('BRIEF-ONE');
      expect(prompts[1]).not.toContain('BRIEF-ONE');
      expect(prompts[2]).toContain('BRIEF-TWO');
      expect(prompts[3]).not.toContain('BRIEF-TWO');
      // The turn-kind delta is on every turn - only the standing half is dropped.
      for (const prompt of prompts) {
        expect(prompt).toContain('Work order:');
        expect(prompt.length).toBeGreaterThan(0);
      }
      expect(prompts[1].length).toBeLessThan(prompts[0].length);
      local.db.close();
    });

    it('keeps the completion receipt hash on the full composed brief either way', async () => {
      const local = makeDeps();
      const memory = new ThreadBriefMemory();
      local.deps.admitOwnerBrief = (text) => memory.admit('owner:runtime', text);
      await runOrder(local.deps, local.ledger, 'wiki:h1');
      await runOrder(local.deps, local.ledger, 'wiki:h2');
      const hashes = local.events
        .filter((event) => event.type === 'complete')
        .map((event) => event.briefHash);
      expect(hashes).toHaveLength(2);
      expect(hashes[0]).toBe(hashes[1]);
      local.db.close();
    });

    it('leaves the brief unadmitted when the run dies before the model, and resends it', async () => {
      const local = makeDeps();
      const prompts: string[] = [];
      const memory = new ThreadBriefMemory();
      local.deps.loadOwnerBrief = () => 'BRIEF-ONE. Do the work.';
      local.deps.admitOwnerBrief = (text) => memory.admit('owner:runtime', text);
      local.deps.retractOwnerBrief = () => memory.forget('owner:runtime');
      let fail = true;
      local.deps.runner = {
        runWithContent: async (content) => {
          prompts.push(content.map((block) => ('text' in block ? block.text : '')).join(''));
          if (fail) throw new Error('transport failed before the model');
          return { response: 'ok done' };
        },
      };

      await runOrder(local.deps, local.ledger, 'wiki:retract1');
      fail = false;
      await runOrder(local.deps, local.ledger, 'wiki:retract2');

      expect(prompts).toHaveLength(3);
      expect(prompts[0]).toContain('BRIEF-ONE');
      // The first run died before the model, so the retry carries the brief again rather
      // than assuming the thread already holds it.
      expect(prompts[1]).toContain('BRIEF-ONE');
      // That retry DID deliver it, so the next turn omits it as before.
      expect(prompts[2]).not.toContain('BRIEF-ONE');
      local.db.close();
    });

    it('still fails loudly when the brief is missing, never a turn-kind-only run', async () => {
      const local = makeDeps();
      local.deps.loadOwnerBrief = () => null;
      local.deps.admitOwnerBrief = () => false;
      await runOrder(local.deps, local.ledger, 'wiki:missing');
      expect(local.events.some((event) => event.reason === 'brief-missing')).toBe(true);
      local.db.close();
    });
  });

  it('keeps the temporal retry budget explicit at three attempts', () => {
    expect(WORKORDER_MAX_ATTEMPTS.temporal).toBe(3);
  });

  it('surfaces owner-runtime journal failure to the owner notice boundary', async () => {
    ctx = makeDeps({
      runner: {
        runWithContent: async () => ({
          response: 'work completed',
          ownerJournalProvenance: 'commit_failed',
        }),
      },
    });
    ctx.ledger.enqueueWorkOrder({
      workKind: 'memory-curation',
      idempotencyKey: 'memory-curation:journal-failure',
      input: { scheduledAt: '2026-09-06T00:00:00.000Z' },
    });

    await new WorkOrderConsumer(ctx.deps).tick();

    expect(ctx.notices).toContain(
      'Owner runtime recovery journal did not persist for memory-curation#1'
    );
    ctx.db.close();
  });

  it('the interval beats while a long run is consuming - mid-run is alive, not silent', async () => {
    // Live day 1 of the S2 window: the beat lived inside tick(), the interval
    // handler skips tick() while consuming, so every run longer than 2x the
    // cadence paged the owner and then "recovered" - a telegram flap per run.
    vi.useFakeTimers();
    try {
      const { initLegCadence } = await import('../../src/operator/leg-cadence.js');
      const legDb: SQLiteDatabase = new Database(':memory:');
      const legs = initLegCadence(legDb, { now: () => Date.now(), hourOfDay: () => 12 });
      legs.declare('workorder-consumer', 1_000);

      const task = ctx.ledger.create({ title: 'due', due_at: '2026-07-21T00:00:00Z' });
      const occurrenceKey = `epoch:${task.temporalEpoch}:due:${task.dueAt}`;
      ctx.ledger.enqueueTemporalGeneration({
        generationKey: `task:${task.id}:${occurrenceKey}:check:${task.dueAt}`,
        taskId: task.id,
        temporalEpoch: task.temporalEpoch,
        occurrenceKey,
        checkAt: task.dueAt!,
        sourceChannel: null,
        sourceEventId: null,
      });
      // A run that holds `consuming` until we release it.
      let releaseRun!: () => void;
      const gate = new Promise<{ response: string }>((resolve) => {
        releaseRun = () => resolve({ response: 'ok done' });
      });
      ctx.deps.runner = { runWithContent: () => gate };
      ctx.deps.tickMs = 1_000;
      const consumer = new WorkOrderConsumer(ctx.deps);
      consumer.start();

      await vi.advanceTimersByTimeAsync(1_000); // first tick claims, run hangs
      await vi.advanceTimersByTimeAsync(3_000); // 3 more firings mid-run
      // Silent for at most one cadence, never past the 2x page threshold.
      expect(legs.check().pages).toEqual([]);

      releaseRun();
      await vi.advanceTimersByTimeAsync(1_000);
      await consumer.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never writes temporal model response content to operational logs', async () => {
    const task = ctx.ledger.create({ title: 'due', due_at: '2026-07-21T00:00:00Z' });
    const occurrenceKey = `epoch:${task.temporalEpoch}:due:${task.dueAt}`;
    ctx.ledger.enqueueTemporalGeneration({
      generationKey: `task:${task.id}:${occurrenceKey}:check:${task.dueAt}`,
      taskId: task.id,
      temporalEpoch: task.temporalEpoch,
      occurrenceKey,
      checkAt: task.dueAt!,
      sourceChannel: null,
      sourceEventId: null,
    });
    const privateResponse = 'private connector evidence must not reach logs';
    ctx.deps.runner = { runWithContent: async () => ({ response: privateResponse }) };
    const consumer = new WorkOrderConsumer(ctx.deps);

    await consumer.tick();

    expect(ctx.logs.join('\n')).not.toContain(privateResponse);
  });

  it('stores and reports only a digest when a temporal runner error is private', async () => {
    const task = ctx.ledger.create({ title: 'due', due_at: '2026-07-21T00:00:00Z' });
    const occurrenceKey = `epoch:${task.temporalEpoch}:due:${task.dueAt}`;
    const generationKey = `task:${task.id}:${occurrenceKey}:check:${task.dueAt}`;
    ctx.ledger.enqueueTemporalGeneration({
      generationKey,
      taskId: task.id,
      temporalEpoch: task.temporalEpoch,
      occurrenceKey,
      checkAt: task.dueAt!,
      sourceChannel: null,
      sourceEventId: null,
    });
    const privateError = 'private connector token abc-123';
    ctx.deps.runner = {
      runWithContent: async () => Promise.reject(new Error(privateError)),
    };
    const consumer = new WorkOrderConsumer(ctx.deps);

    await consumer.tick();

    const combined = [
      ...ctx.logs,
      ...ctx.notices,
      ...ctx.activeSends,
      ...ctx.events.map((event) => event.reason ?? ''),
      ctx.ledger.getTemporalGeneration(generationKey)?.reason ?? '',
    ].join('\n');
    expect(combined).not.toContain(privateError);
    expect(combined).toContain('sha256=');
  });

  it('routes temporal exhaustion through the generation transaction', async () => {
    const task = ctx.ledger.create({ title: 'due', due_at: '2026-07-21T00:00:00Z' });
    const occurrenceKey = `epoch:${task.temporalEpoch}:due:${task.dueAt}`;
    ctx.ledger.enqueueTemporalGeneration({
      generationKey: `task:${task.id}:${occurrenceKey}:check:${task.dueAt}`,
      taskId: task.id,
      temporalEpoch: task.temporalEpoch,
      occurrenceKey,
      checkAt: task.dueAt!,
      sourceChannel: null,
      sourceEventId: null,
    });
    ctx.deps.runner = { runWithContent: async () => Promise.reject(new Error('synthetic')) };
    const consumer = new WorkOrderConsumer(ctx.deps);

    await consumer.tick();
    await consumer.tick();
    await consumer.tick();
    const generation = ctx.ledger.getTemporalGeneration(
      `task:${task.id}:${occurrenceKey}:check:${task.dueAt}`
    );
    expect(generation?.disposition).toBe('exhausted');
    expect(generation?.reason).toMatch(/^temporal-worker-failure;failure_sha256=[a-f0-9]{64};/);
    expect(generation?.reason).not.toContain('synthetic');
    expect(ctx.events.filter((event) => event.type === 'requeued')).toHaveLength(2);
  });

  it.each([
    'CODE_ACT_MUTATION_OUTCOME_UNKNOWN',
    'MCP_RESULT_MISSING',
    'MCP_COMPLETED_MUTATION_INTERRUPTED',
  ] as const)('does not requeue a temporal attempt after terminal ambiguity %s', async (code) => {
    const task = ctx.ledger.create({ title: 'due', due_at: '2026-07-21T00:00:00Z' });
    const occurrenceKey = `epoch:${task.temporalEpoch}:due:${task.dueAt}`;
    const generationKey = `task:${task.id}:${occurrenceKey}:check:${task.dueAt}`;
    ctx.ledger.enqueueTemporalGeneration({
      generationKey,
      taskId: task.id,
      temporalEpoch: task.temporalEpoch,
      occurrenceKey,
      checkAt: task.dueAt!,
      sourceChannel: null,
      sourceEventId: null,
    });
    ctx.deps.runner = {
      runWithContent: async () => {
        throw new AgentError('mutation may have committed; do not retry', code);
      },
    };
    const consumer = new WorkOrderConsumer(ctx.deps);

    await consumer.tick();

    expect(ctx.events.some((event) => event.type === 'requeued')).toBe(false);
    expect(ctx.events.some((event) => event.type === 'exhausted')).toBe(true);
    expect(ctx.ledger.getTemporalGeneration(generationKey)?.disposition).toBe('exhausted');
    expect(ctx.activeSends.join('\n')).toContain('automatic retry suppressed');
  });

  it('suppresses only the exact trusted TOOL_CONTRACT_REPEAT Temporal retry', async () => {
    const generationKey = enqueueTemporalDue(ctx.ledger);
    ctx.deps.runner = {
      runWithContent: async () => {
        throw new AgentError(
          'Temporal deterministic host-tool contract failure repeated',
          'TOOL_CONTRACT_REPEAT'
        );
      },
    };
    const consumer = new WorkOrderConsumer(ctx.deps);

    await consumer.tick();

    expect(ctx.events.some((event) => event.type === 'requeued')).toBe(false);
    expect(ctx.events.some((event) => event.type === 'exhausted')).toBe(true);
    expect(ctx.ledger.getTemporalGeneration(generationKey)?.disposition).toBe('exhausted');
    expect(ctx.activeSends.join('\n')).toContain('deterministic contract');
    expect(ctx.activeSends.join('\n')).not.toContain('ambiguous');
  });

  it('does not trust plain TOOL_CONTRACT_REPEAT text to suppress a Temporal retry', async () => {
    enqueueTemporalDue(ctx.ledger);
    ctx.deps.runner = {
      runWithContent: async () => {
        throw new Error('TOOL_CONTRACT_REPEAT');
      },
    };
    const consumer = new WorkOrderConsumer(ctx.deps);

    await consumer.tick();

    expect(ctx.events.some((event) => event.type === 'requeued')).toBe(true);
    expect(ctx.events.some((event) => event.type === 'exhausted')).toBe(false);
  });

  it('does not broaden retry suppression to unrelated non-retryable AgentError codes', async () => {
    enqueueTemporalDue(ctx.ledger);
    ctx.deps.runner = {
      runWithContent: async () => {
        throw new AgentError(
          'unrelated deterministic-looking error',
          'CLI_ERROR',
          undefined,
          false
        );
      },
    };
    const consumer = new WorkOrderConsumer(ctx.deps);

    await consumer.tick();

    expect(ctx.events.some((event) => event.type === 'requeued')).toBe(true);
    expect(ctx.events.some((event) => event.type === 'exhausted')).toBe(false);
  });

  describe('token telemetry: run usage rides the completion event', () => {
    it('carries totalUsage from the runner into the complete event as tokensUsed', async () => {
      // The 05-08~07-21 measurement gap: legacy personas recorded tokens_used,
      // the Stage-2 workorder path never did. The consumer is the only place
      // that sees the run result AND emits the telemetry event.
      ctx.deps.runner = {
        runWithContent: async () => ({
          response: 'DONE',
          totalUsage: { input_tokens: 41_000, output_tokens: 2_200 },
        }),
      };
      const consumer = new WorkOrderConsumer(ctx.deps);
      const wo = ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'board:tokens:1',
        input: { mode: 'full' },
      });

      await consumer.tick();

      expect(ctx.events).toContainEqual({
        type: 'complete',
        workKind: 'board',
        workOrderId: wo.id,
        tokensUsed: 43_200,
        briefHash: createHash('sha256')
          .update(
            ['You are a test worker. Do the work.', buildTurnKindSection('board')].join('\n\n')
          )
          .digest('hex')
          .slice(0, 16),
      });
    });

    it('omits tokensUsed when the runner reports no usage (no fake zeros)', async () => {
      const consumer = new WorkOrderConsumer(ctx.deps);
      const wo = ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'board:tokens:2',
        input: { mode: 'full' },
      });

      await consumer.tick();

      const complete = ctx.events.find((e) => e.type === 'complete' && e.workOrderId === wo.id);
      expect(complete).toBeDefined();
      expect(complete).not.toHaveProperty('tokensUsed');
      expect(complete?.briefHash).toMatch(/^[a-f0-9]{16}$/);
    });
  });

  describe('AC #1: enqueue -> consume -> complete e2e', () => {
    it('drains pending workorders serially and marks them done', async () => {
      const consumer = new WorkOrderConsumer(ctx.deps);
      const a = ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'board:full:1',
        input: { mode: 'full' },
      });
      const b = ctx.ledger.enqueueWorkOrder({
        workKind: 'wiki',
        idempotencyKey: 'wiki:1',
        input: { batchId: 'b1', events: [] },
      });

      expect(await consumer.tick()).toBe('drained');
      const stats = ctx.ledger.workOrderStats();
      expect(stats.find((s) => s.workKind === 'board')?.lastStatus).toBe('done');
      expect(stats.find((s) => s.workKind === 'wiki')?.lastStatus).toBe('done');
      expect(ctx.events.filter((e) => e.type === 'complete').map((e) => e.workOrderId)).toEqual([
        a.id,
        b.id,
      ]);
    });

    it('serializes: one claim awaited at a time (claim order respected)', async () => {
      const order: string[] = [];
      ctx.deps.runner = {
        runWithContent: async (content) => {
          order.push(String((content[0] as { text: string }).text.includes('"mode":"full"')));
          await new Promise((r) => setTimeout(r, 5));
          return { response: 'done' };
        },
      };
      const consumer = new WorkOrderConsumer(ctx.deps);
      ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'k1',
        input: { mode: 'full' },
      });
      ctx.ledger.enqueueWorkOrder({
        workKind: 'wiki',
        idempotencyKey: 'k2',
        input: { batchId: 'b', events: [] },
        priority: 'high',
      });
      // high-priority wiki claims first despite later enqueue
      await consumer.tick();
      expect(order).toEqual(['false', 'true']);
    });
  });

  describe('AC #2: overlapping ticks skip (re-entrancy guard, plan G4)', () => {
    it('a tick during a long run returns skipped', async () => {
      let release: () => void = () => {};
      ctx.deps.runner = {
        runWithContent: () =>
          new Promise((resolve) => {
            release = () => resolve({ response: 'done' });
          }),
      };
      const consumer = new WorkOrderConsumer(ctx.deps);
      ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'k1',
        input: { mode: 'full' },
      });

      const first = consumer.tick();
      expect(await consumer.tick()).toBe('skipped'); // overlapping firing
      release();
      expect(await first).toBe('drained');
    });
  });

  describe('AC #3: retry policy (plan G5/M4)', () => {
    it('wiki requeues once (attempts 2) then exhausts with an active alarm', async () => {
      ctx.deps.runner = {
        runWithContent: async () => {
          throw new Error('worker blew up');
        },
      };
      const consumer = new WorkOrderConsumer(ctx.deps);
      ctx.ledger.enqueueWorkOrder({
        workKind: 'wiki',
        idempotencyKey: 'wiki:batch-9',
        input: { batchId: 'b9', events: [] },
      });

      await consumer.tick(); // attempt 1 fails -> requeued (fresh row, attempts 2)
      const requeued = ctx.events.find((e) => e.type === 'requeued');
      expect(requeued).toBeDefined();
      expect(ctx.activeSends).toHaveLength(0); // not exhausted yet

      await consumer.tick(); // attempt 2 fails -> exhausted -> alarm
      expect(ctx.events.some((e) => e.type === 'exhausted')).toBe(true);
      expect(ctx.activeSends).toHaveLength(1);
      expect(ctx.activeSends[0]).toContain('retries exhausted');
      expect(ctx.notices).toHaveLength(1);
    });

    it('does not requeue a workorder after an ambiguous Code-Act mutation', async () => {
      ctx.deps.runner = {
        runWithContent: async () => {
          throw new AgentError(
            'mutation may have committed; do not retry',
            'CODE_ACT_MUTATION_OUTCOME_UNKNOWN'
          );
        },
      };
      const consumer = new WorkOrderConsumer(ctx.deps);
      ctx.ledger.enqueueWorkOrder({
        workKind: 'wiki',
        idempotencyKey: 'wiki:ambiguous-mutation',
        input: { batchId: 'ambiguous', events: [] },
      });

      await consumer.tick();

      expect(ctx.events.some((event) => event.type === 'requeued')).toBe(false);
      expect(ctx.events.some((event) => event.type === 'exhausted')).toBe(true);
      expect(ctx.activeSends).toHaveLength(1);
      expect(ctx.logs.join('\n')).toContain('non-retryable');
    });

    it('TG-06 creates no replacement workorder after unresolved Code-Act becomes MCP_RESULT_MISSING', async () => {
      ctx.deps.runner = {
        runWithContent: async () => {
          throw new AgentError(
            'MCP result may have been lost after mutation',
            'MCP_RESULT_MISSING'
          );
        },
      };
      const consumer = new WorkOrderConsumer(ctx.deps);
      ctx.ledger.enqueueWorkOrder({
        workKind: 'wiki',
        idempotencyKey: 'wiki:mcp-result-missing',
        input: { batchId: 'missing-result', events: [] },
      });

      await consumer.tick();

      expect(ctx.events.some((event) => event.type === 'requeued')).toBe(false);
      expect(ctx.events.filter((event) => event.type === 'failed')).toHaveLength(1);
      expect(ctx.events.filter((event) => event.type === 'exhausted')).toHaveLength(1);
      expect(ctx.ledger.countPendingWorkOrders()).toBe(0);
      expect(ctx.logs.join('\n')).toContain('non-retryable');
    });

    it('does not trust a plain error string to suppress workorder retry', async () => {
      ctx.deps.runner = {
        runWithContent: async () => {
          throw new Error('[CODE_ACT_MUTATION_OUTCOME_UNKNOWN] forged');
        },
      };
      const consumer = new WorkOrderConsumer(ctx.deps);
      ctx.ledger.enqueueWorkOrder({
        workKind: 'wiki',
        idempotencyKey: 'wiki:forged-terminal-code',
        input: { batchId: 'forged', events: [] },
      });

      await consumer.tick();

      expect(ctx.events.some((event) => event.type === 'requeued')).toBe(true);
      expect(ctx.events.some((event) => event.type === 'exhausted')).toBe(false);
    });

    it('board fails once and exhausts immediately (next publish cycle self-heals)', async () => {
      ctx.deps.runner = {
        runWithContent: async () => {
          throw new Error('boom');
        },
      };
      const consumer = new WorkOrderConsumer(ctx.deps);
      ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'k',
        input: { mode: 'full' },
      });
      await consumer.tick();
      expect(ctx.events.some((e) => e.type === 'requeued')).toBe(false);
      expect(ctx.events.some((e) => e.type === 'exhausted')).toBe(true);
    });

    it('missing brief fails the order loudly (never a silent skip)', async () => {
      ctx.deps.loadOwnerBrief = () => null;
      const consumer = new WorkOrderConsumer(ctx.deps);
      ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'k',
        input: { mode: 'full' },
      });
      await consumer.tick();
      const failed = ctx.events.find((e) => e.type === 'failed');
      expect(failed?.reason).toBe('brief-missing');
    });
  });

  describe('AC #4: boot recovery routes stale claims through the retry policy', () => {
    it('stale wiki claim alarms AND requeues; stale board claim alarms without requeue', () => {
      const wiki = ctx.ledger.enqueueWorkOrder({
        workKind: 'wiki',
        idempotencyKey: 'w',
        input: { batchId: 'b', events: [] },
      });
      ctx.ledger.claimNextWorkOrder(); // wiki in_progress (crash artifact)
      const consumer = new WorkOrderConsumer(ctx.deps);
      consumer.bootRecover();

      expect(ctx.events.some((e) => e.type === 'stale-claim' && e.workOrderId === wiki.id)).toBe(
        true
      );
      expect(ctx.activeSends.some((l) => l.includes('stale claim'))).toBe(true);
      expect(ctx.events.some((e) => e.type === 'requeued')).toBe(true); // wiki retries once
    });
  });

  describe('AC #5: alarm dedup per kind (6h)', () => {
    it('second exhaustion within the window is log-only', async () => {
      let clock = 1_000_000;
      ctx.deps.now = () => clock;
      ctx.deps.runner = {
        runWithContent: async () => {
          throw new Error('boom');
        },
      };
      const consumer = new WorkOrderConsumer(ctx.deps);

      ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'k1',
        input: { mode: 'full' },
      });
      await consumer.tick();
      clock += 60_000; // 1 min later, same kind fails again
      ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'k2',
        input: { mode: 'full' },
      });
      await consumer.tick();

      expect(ctx.activeSends).toHaveLength(1); // deduped
      expect(ctx.logs.some((l) => l.includes('alarm deduped'))).toBe(true);

      clock += 7 * 60 * 60 * 1000; // past the window
      ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'k3',
        input: { mode: 'full' },
      });
      await consumer.tick();
      expect(ctx.activeSends).toHaveLength(2);
    });
  });

  describe('AC #6: completion hooks (plan D1/E4)', () => {
    it('before state flows to after; after-hook errors are loud but never fail the run', async () => {
      const consumer = new WorkOrderConsumer(ctx.deps);
      const seen: unknown[] = [];
      consumer.registerHook('board', {
        before: () => ({ marker: 42 }),
        after: (_wo, response, beforeState) => {
          seen.push(beforeState, response);
          throw new Error('verification hiccup');
        },
      });
      const wo = ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'k',
        input: { mode: 'full' },
      });
      await consumer.tick();

      expect(seen[0]).toEqual({ marker: 42 });
      expect(ctx.logs.some((l) => l.includes('after-hook error'))).toBe(true);
      expect(ctx.events.some((e) => e.type === 'complete' && e.workOrderId === wo.id)).toBe(true);
    });

    it('a broken before-hook fails the order (never strands the claim)', async () => {
      const consumer = new WorkOrderConsumer(ctx.deps);
      consumer.registerHook('board', {
        before: () => {
          throw new Error('snapshot store gone');
        },
      });
      ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'k',
        input: { mode: 'full' },
      });
      await consumer.tick();
      const failed = ctx.events.find((e) => e.type === 'failed');
      expect(failed?.reason).toContain('before-hook');
    });

    it('duplicate hook registration throws', () => {
      const consumer = new WorkOrderConsumer(ctx.deps);
      consumer.registerHook('wiki', {});
      expect(() => consumer.registerHook('wiki', {})).toThrow(/already registered/);
    });
  });

  describe('AC #7: opt-in blocking effect verdict', () => {
    it('completes only after a required hook returns a complete verdict', async () => {
      const consumer = new WorkOrderConsumer(ctx.deps);
      consumer.registerHook('board', {
        verdictRequired: true,
        after: () => ({ disposition: 'complete' }),
      });
      const wo = ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'required-complete',
        input: { mode: 'full' },
      });

      await consumer.tick();

      expect(ctx.events).toContainEqual({
        type: 'complete',
        workKind: 'board',
        workOrderId: wo.id,
        briefHash: createHash('sha256')
          .update(
            ['You are a test worker. Do the work.', buildTurnKindSection('board')].join('\n\n')
          )
          .digest('hex')
          .slice(0, 16),
      });
    });

    it('routes a required fail verdict through the existing requeue policy', async () => {
      const consumer = new WorkOrderConsumer(ctx.deps);
      consumer.registerHook('wiki', {
        verdictRequired: true,
        after: () => ({ disposition: 'fail', reason: 'effect-missing' }),
      });
      const wo = ctx.ledger.enqueueWorkOrder({
        workKind: 'wiki',
        idempotencyKey: 'required-fail',
        input: { batchId: 'b-required-fail', events: [] },
      });

      await consumer.tick();

      expect(ctx.events).toContainEqual({
        type: 'failed',
        workKind: 'wiki',
        workOrderId: wo.id,
        reason: 'effect-missing',
      });
      expect(ctx.events.some((event) => event.type === 'requeued')).toBe(true);
      expect(ctx.events.some((event) => event.type === 'complete')).toBe(false);
    });

    it('fails when a required hook has no after verifier', async () => {
      const consumer = new WorkOrderConsumer(ctx.deps);
      consumer.registerHook('board', { verdictRequired: true });
      ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'required-after-missing',
        input: { mode: 'full' },
      });

      await consumer.tick();

      expect(ctx.events.find((event) => event.type === 'failed')?.reason).toBe(
        'effect-verdict-missing'
      );
      expect(ctx.events.some((event) => event.type === 'complete')).toBe(false);
    });

    it('fails when a required verifier returns no verdict', async () => {
      const consumer = new WorkOrderConsumer(ctx.deps);
      consumer.registerHook('board', {
        verdictRequired: true,
        after: () => undefined,
      });
      ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'required-verdict-missing',
        input: { mode: 'full' },
      });

      await consumer.tick();

      expect(ctx.events.find((event) => event.type === 'failed')?.reason).toBe(
        'effect-verdict-missing'
      );
    });

    it('fails when a required verifier throws', async () => {
      const consumer = new WorkOrderConsumer(ctx.deps);
      consumer.registerHook('board', {
        verdictRequired: true,
        after: async () => {
          throw new Error('receipt store unavailable');
        },
      });
      ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'required-verifier-throws',
        input: { mode: 'full' },
      });

      await consumer.tick();

      expect(ctx.events.find((event) => event.type === 'failed')?.reason).toBe(
        'after-hook: receipt store unavailable'
      );
    });

    it('bounds a required verifier exception before persistence and alarms', async () => {
      const consumer = new WorkOrderConsumer(ctx.deps);
      consumer.registerHook('board', {
        verdictRequired: true,
        after: () => {
          throw new Error(`private-prefix-${'x'.repeat(1_000)}`);
        },
      });
      ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'required-verifier-bounded-error',
        input: { mode: 'full' },
      });

      await consumer.tick();

      const reason = ctx.events.find((event) => event.type === 'failed')?.reason;
      expect(reason?.startsWith('after-hook: private-prefix-')).toBe(true);
      expect(reason?.length).toBeLessThanOrEqual(500);
    });

    it.each([
      ['null verdict', null],
      ['primitive verdict', 'complete'],
      ['array verdict', [{ disposition: 'complete' }]],
      ['unknown disposition', { disposition: 'unknown' }],
      ['blank failure reason', { disposition: 'fail', reason: '   ' }],
      ['oversized failure reason', { disposition: 'fail', reason: 'x'.repeat(501) }],
    ])('fails a malformed required verdict: %s', async (_label, verdict) => {
      const consumer = new WorkOrderConsumer(ctx.deps);
      consumer.registerHook('board', {
        verdictRequired: true,
        after: () => verdict as never,
      });
      ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: `required-invalid-${_label}`,
        input: { mode: 'full' },
      });

      await consumer.tick();

      expect(ctx.events.find((event) => event.type === 'failed')?.reason).toBe(
        'effect-verdict-invalid'
      );
    });

    it('awaits asynchronous before and after hooks around the runner', async () => {
      const order: string[] = [];
      ctx.deps.runner = {
        runWithContent: async () => {
          order.push('runner');
          return { response: 'done' };
        },
      };
      const consumer = new WorkOrderConsumer(ctx.deps);
      consumer.registerHook('board', {
        verdictRequired: true,
        before: async () => {
          await Promise.resolve();
          order.push('before');
          return { revision: 7 };
        },
        after: async (_wo, _response, beforeState) => {
          await Promise.resolve();
          order.push(`after:${String((beforeState as { revision: number }).revision)}`);
          return { disposition: 'complete' };
        },
      });
      ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'required-async-hooks',
        input: { mode: 'full' },
      });

      await consumer.tick();

      expect(order).toEqual(['before', 'runner', 'after:7']);
      expect(ctx.events.some((event) => event.type === 'complete')).toBe(true);
    });

    it('ignores a fail-shaped verdict when strict completion is not enabled', async () => {
      const consumer = new WorkOrderConsumer(ctx.deps);
      consumer.registerHook('board', {
        after: () => ({ disposition: 'fail', reason: 'legacy-observe-only' }),
      });
      const wo = ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'permissive-fail-shaped',
        input: { mode: 'full' },
      });

      await consumer.tick();

      expect(ctx.events.some((event) => event.type === 'failed')).toBe(false);
      expect(
        ctx.events.some((event) => event.type === 'complete' && event.workOrderId === wo.id)
      ).toBe(true);
    });
  });

  describe('AC #8: start/stop lifecycle', () => {
    it('start twice throws; isStarted reflects state', () => {
      const consumer = new WorkOrderConsumer({ ...ctx.deps, tickMs: 3_600_000 });
      expect(consumer.isStarted()).toBe(false);
      consumer.start();
      expect(consumer.isStarted()).toBe(true);
      expect(() => consumer.start()).toThrow(/already started/);
      consumer.stop();
      expect(consumer.isStarted()).toBe(false);
    });
  });
});

/**
 * Story S2-T4: shadow run-options injection (capture publisher seam).
 */
describe('Story S2-T4: shadow runOptions injection', () => {
  describe('AC #1: capture publisher threading', () => {
    it('threads runOptionsFor output into the runner options', async () => {
      const ctx = makeDeps();
      let captured: Record<string, unknown> = {};
      ctx.deps.runner = {
        runWithContent: async (_content, options) => {
          captured = options as Record<string, unknown>;
          return { response: 'ok' };
        },
      };
      const capturePublisher = (): void => {};
      ctx.deps.runOptionsFor = (wo) =>
        wo.workKind === 'board' ? { reportPublisherOverride: capturePublisher } : undefined;
      const consumer = new WorkOrderConsumer(ctx.deps);
      ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'k',
        input: { mode: 'full' },
      });
      await consumer.tick();
      expect(captured.reportPublisherOverride).toBe(capturePublisher);
      expect(captured.channelId).toBe('worker:board'); // identity intact
    });
  });

  describe('AC #2: refusal instead of live-publish fallback', () => {
    it('a runOptionsFor throw fails the order - never a live publish fallback', async () => {
      const ctx = makeDeps();
      ctx.deps.runOptionsFor = () => {
        throw new Error('shadow capture publisher missing');
      };
      const consumer = new WorkOrderConsumer(ctx.deps);
      ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'k',
        input: { mode: 'full' },
      });
      await consumer.tick();
      const failed = ctx.events.find((e) => e.type === 'failed');
      expect(failed?.reason).toContain('shadow capture publisher missing');
    });
  });
});

/**
 * Story S2-T3 (review round 1): sink-unconfigured degradation.
 */
describe('Story S2-T3: unconfigured ops alarm sink', () => {
  describe('AC #1: log-only degradation', () => {
    it('exhaustion with an unconfigured sink is log-only (loud) and still notices the owner', async () => {
      const ctx = makeDeps();
      ctx.deps.opsAlarm = {
        configured: false,
        send: async () => {
          throw new Error('must never be called');
        },
      };
      ctx.deps.runner = {
        runWithContent: async () => {
          throw new Error('boom');
        },
      };
      const consumer = new WorkOrderConsumer(ctx.deps);
      ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'k',
        input: { mode: 'full' },
      });
      await consumer.tick();

      expect(ctx.logs.some((l) => l.includes('log-only'))).toBe(true);
      expect(ctx.notices).toHaveLength(1); // passive surface still fires
    });
  });
});

/**
 * Story S2-T3 (review round 2 N1): stop() must await the REAL tick.
 */
describe('Story S2-T3: graceful stop under skipped firings (N1)', () => {
  describe('AC #1: stop awaits the real tick', () => {
    it('skipped timer firings do not overwrite the tracked tick; stop awaits the run', async () => {
      const ctx = makeDeps();
      let release: () => void = () => {};
      ctx.deps.runner = {
        runWithContent: () =>
          new Promise((resolve) => {
            release = () => resolve({ response: 'done' });
          }),
      };
      ctx.deps.tickMs = 5;
      const consumer = new WorkOrderConsumer(ctx.deps);
      ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'k',
        input: { mode: 'full' },
      });
      consumer.start();
      await new Promise((r) => setTimeout(r, 30)); // several firings hit the guard
      setTimeout(() => release(), 10);
      await consumer.stop();
      // With the N1 bug, stop() awaited a 'skipped' promise and resolved before
      // the run finished - this assertion fails then.
      expect(ctx.events.some((e) => e.type === 'complete')).toBe(true);
    });

    it('does not claim or fail queued work after shutdown begins', async () => {
      const ctx = makeDeps();
      let rejectRun: (error: Error) => void = () => {};
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      ctx.deps.runner = {
        runWithContent: () =>
          new Promise((_resolve, reject) => {
            rejectRun = reject;
            markStarted?.();
          }),
      };
      ctx.deps.tickMs = 5;
      const consumer = new WorkOrderConsumer(ctx.deps);
      const active = ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'shutdown-active',
        input: { mode: 'full' },
      });
      ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'shutdown-pending',
        input: { mode: 'full' },
      });

      consumer.start();
      await started;
      const stopping = consumer.stop();
      rejectRun(new Error('Agent loop is stopping'));
      await stopping;

      expect(ctx.ledger.listStaleClaims().map((row) => row.id)).toEqual([active.id]);
      expect(ctx.ledger.countPendingWorkOrders()).toBe(1);
      expect(ctx.events.some((event) => event.type === 'failed')).toBe(false);
      expect(ctx.events.some((event) => event.type === 'exhausted')).toBe(false);
    });
  });
});

// The operator could not tell an upstream outage from a bug in this code: five consecutive
// live failures reported `temporal-worker-failure;sha256=...;length=31` and nothing else.
// The label comes from a closed table, so it adds a cause without quoting the error - which
// is what keeps it inside the privacy contract asserted above.
describe('classifyTemporalFailure', () => {
  it('names the shapes the live failures actually take', () => {
    expect(classifyTemporalFailure('API Error: 529 Overloaded.')).toBe('upstream-5xx');
    expect(classifyTemporalFailure('API Error: 500 Internal error')).toBe('upstream-5xx');
    expect(classifyTemporalFailure('request timed out after 240000ms')).toBe('timeout');
    expect(classifyTemporalFailure('API Error: 429 rate limit')).toBe('rate-limited');
    expect(classifyTemporalFailure('connect ECONNREFUSED 127.0.0.1:443')).toBe('network');
    expect(classifyTemporalFailure('API Error: 400 invalid_request')).toBe('request-rejected');
  });

  // Honest about its own limits: an unmatched failure says so rather than guessing, and the
  // caller then reports exactly what it reported before - the digest.
  it('returns null rather than guessing at an unknown failure', () => {
    expect(classifyTemporalFailure('Claude CLI exited with code 1')).toBeNull();
    expect(classifyTemporalFailure('')).toBeNull();
  });

  // The whole point of the closed table: a label is chosen, never extracted. A reason that
  // matches a shape AND carries a token must still yield only the label.
  it('never returns any text taken from the reason', () => {
    const secret = 'connector-token-9f3a2b';
    for (const reason of [
      `API Error: 500 ${secret}`,
      `timed out while sending ${secret}`,
      `ECONNREFUSED talking to ${secret}`,
      secret,
    ]) {
      expect(classifyTemporalFailure(reason) ?? '').not.toContain(secret);
    }
  });
});

describe('in-band API errors are transport failures, never content', () => {
  // Live proof: board#2042 completed with "||⏱️ 1 turns|| | API Error: 529
  // Overloaded..." as its response - a false success delivered as content.
  it('detects the CLI error-as-response shape, with or without the turns prefix', () => {
    expect(
      detectTransportErrorResponse(
        '||⏱️ 1 turns|| | API Error: 529 Overloaded. This is a server-side issue.'
      )
    ).toBe('API Error: 529 Overloaded');
    expect(detectTransportErrorResponse('API Error: 500 Internal server error')).toBe(
      'API Error: 500 Internal server error'
    );
  });

  it('does NOT flag real content that merely quotes an error', () => {
    expect(
      detectTransportErrorResponse(
        'Board report: yesterday one run failed with API Error: 529 Overloaded and recovered.'
      )
    ).toBeNull();
    expect(detectTransportErrorResponse('All 3 cards reconciled, no changes needed.')).toBeNull();
  });

  it('a run whose response is an API error FAILS the workorder instead of completing', async () => {
    const task = ctx2.ledger.create({ title: 'due', due_at: '2026-07-21T00:00:00Z' });
    const occurrenceKey = `epoch:${task.temporalEpoch}:due:${task.dueAt}`;
    ctx2.ledger.enqueueTemporalGeneration({
      generationKey: `task:${task.id}:${occurrenceKey}:check:${task.dueAt}`,
      taskId: task.id,
      temporalEpoch: task.temporalEpoch,
      occurrenceKey,
      checkAt: task.dueAt!,
      sourceChannel: null,
      sourceEventId: null,
    });
    ctx2.deps.runner = {
      runWithContent: async () => ({
        response: '||⏱️ 1 turns|| | API Error: 529 Overloaded. Try again later.',
      }),
    };
    const consumer = new WorkOrderConsumer(ctx2.deps);
    await consumer.tick();
    const failures = ctx2.events.filter((event) => event.type === 'failed');
    expect(failures.length).toBeGreaterThan(0);
    expect(ctx2.events.filter((event) => event.type === 'complete')).toHaveLength(0);
  });
});

const ctx2 = makeDeps();

describe('transient upstream model errors are named, not anonymous digests', () => {
  it('classifies capacity / rate-limit / 5xx thrown errors', () => {
    expect(
      classifyTransientModelError(
        'CLI error: Selected model is at capacity. Please try a different model.'
      )
    ).toBe('model-at-capacity');
    expect(classifyTransientModelError('CLI error: 429 rate limit exceeded')).toBe('rate-limited');
    expect(classifyTransientModelError('CLI error: 503 upstream overloaded')).toBe('upstream-5xx');
  });
  it('leaves genuine MAMA-side failures unclassified (null)', () => {
    expect(
      classifyTransientModelError(
        'candidate receipt set is empty without live pre-run retry authority'
      )
    ).toBeNull();
    expect(classifyTransientModelError('brief-missing')).toBeNull();
  });
  /**
   * Owner decision 2026-09-09: an unattended maintenance turn receives a STIMULUS - the
   * result the host verifies, the input, the budget - and decides for itself how to work.
   * The board and wiki sections were ~7,047 and ~7,277 characters of step-by-step script.
   */
  describe('One MAMA: turn kinds are outcome contracts, not scripts', () => {
    it('states the board result and nothing about tool order', () => {
      const board = buildTurnKindSection('board');
      expect(board).toContain(
        'Result required: the three judgment slots (briefing, action_required, decisions) published with report_publish as HTML fragments, or contract_no_update'
      );
      expect(board).toContain('The pipeline slot is host-rendered.');
      expect(board).toContain('The input carries the batch and the candidates.');
      // The script that used to tell it HOW to read and in what order.
      expect(board).not.toContain('task_list({view');
      expect(board).not.toContain('Read the board progressively');
      // Host-enforced mechanics are enforced by the tools' own errors, not restated.
      expect(board).not.toContain('expected_revision');
      expect(board).not.toContain('Do not supply scopes or seed_refs');
      expect(board.length).toBeLessThan(1300);
    });

    it('states the wiki result and drops the continuity script', () => {
      const wiki = buildTurnKindSection('wiki');
      expect(wiki).toContain(
        'Result required: the wiki pages this batch affects published with wiki_publish, or contract_no_update'
      );
      // P3-8: the host also requires source coverage before it accepts the no-update.
      expect(wiki).toContain(
        'A no-update is accepted only once this attempt has completed context_compile, every bounded task_list page, and wiki_read of Home.md and the bound daily page.'
      );
      expect(wiki).not.toContain('task_list({view');
      // The script told it HOW to read; the coverage clause only names what the host requires.
      expect(wiki).not.toContain('wiki_read({');
      expect(wiki.length).toBeLessThan(1300);
    });

    it.each(['board', 'wiki', 'memory-curation', 'self-check', 'temporal'] as const)(
      'the %s turn carries the two-sentence unattended preamble',
      (kind) => {
        const prompt = buildTurnKindSection(kind);
        expect(prompt).toContain('## Scheduled turn');
        expect(prompt).toContain(
          'This turn runs unattended: no one replies inside it and there is no send.'
        );
        expect(prompt).toContain('owner-facing output');
        expect(prompt).toContain('without waiting for an answer');
        expect(prompt).not.toContain('state the lesson in your final message');
      }
    );

    /**
     * Review P1-2: `input.noUpdateScope` named a variable the code-act sandbox does not
     * have, while the host refuses any scope that is not the exact host-issued string. The
     * literal is rendered into the section instead.
     */
    it('P1-2 renders the literal no-update scope and never points at an `input.` variable', () => {
      for (const kind of ['board', 'wiki', 'memory-curation', 'self-check'] as const) {
        const section = buildTurnKindSection(kind, 'full:2026-09-09');
        expect(section).toContain('contract_no_update({reason, scope: "full:2026-09-09"})');
        expect(section).not.toContain('input.');
      }
      // No host-issued scope: say so, rather than name a variable that does not exist.
      const noScope = buildTurnKindSection('wiki');
      expect(noScope).toContain('the exact scope the host issued for this attempt');
      expect(noScope).not.toContain('input.');
    });

    /** P3-7: the host hard-requires both, so the RESULT requirement says both. */
    it('P3-7 states the temporal context packet requirement and the report_publish prohibition', () => {
      const temporal = buildTurnKindSection('temporal');
      expect(temporal).toContain(
        'carrying the context_packet_id of a context_compile made in this attempt'
      );
      expect(temporal).toContain('Do not call report_publish.');
    });

    it('keeps the two turn-kind sections that were already outcome contracts', () => {
      expect(buildTurnKindSection('memory-curation')).toContain('mama_save');
      expect(buildTurnKindSection('self-check')).toContain('repair_request({issue_id');
      expect(buildTurnKindSection('temporal')).toContain(
        'exactly one successful task_temporal_reconcile'
      );
    });
  });

  describe('One MAMA: host-rendered pipeline slot', () => {
    it('publishes the pipeline before the board turn runs and not for other kinds', async () => {
      const ctx = makeDeps();
      const order: string[] = [];
      ctx.deps.publishPipelineSlot = () => void order.push('pipeline');
      ctx.deps.runner = {
        runWithContent: async () => {
          order.push('model');
          return { response: 'DONE' };
        },
      };
      const consumer = new WorkOrderConsumer(ctx.deps);
      ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'board:pipeline:1',
        input: { mode: 'full' },
      });
      await consumer.tick();
      expect(order).toEqual(['pipeline', 'model']);

      ctx.ledger.enqueueWorkOrder({
        workKind: 'wiki',
        idempotencyKey: 'wiki:pipeline:1',
        input: { batchId: 'b', events: ['e'] },
      });
      await consumer.tick();
      expect(order).toEqual(['pipeline', 'model', 'model']);
    });

    it('fails the board order loudly when the host cannot render the pipeline', async () => {
      const ctx = makeDeps();
      let ran = false;
      ctx.deps.publishPipelineSlot = () => {
        throw new Error('report store unavailable');
      };
      ctx.deps.runner = {
        runWithContent: async () => {
          ran = true;
          return { response: 'DONE' };
        },
      };
      const consumer = new WorkOrderConsumer(ctx.deps);
      const wo = ctx.ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'board:pipeline:fail',
        input: { mode: 'full' },
      });
      await consumer.tick();
      expect(ran).toBe(false);
      expect(ctx.events).toContainEqual({
        type: 'failed',
        workKind: 'board',
        workOrderId: wo.id,
        reason: 'pipeline-render-failed: report store unavailable',
      });
    });
  });
  describe('ONE-MAMA-P3 Task 3: self-check turn', () => {
    it('AC #8 the self-check section names the three outcomes and the work order carries the open issues', async () => {
      const section = buildTurnKindSection('self-check');
      expect(section).toContain('repair_request({issue_id');
      expect(section).toContain('issue_close({issue_id, reason})');
      expect(section).toContain('contract_no_update');
      const ctx = makeDeps();
      let seen = '';
      ctx.deps.runner = {
        runWithContent: async (content) => {
          seen = JSON.stringify(content);
          return { response: 'DONE' };
        },
      };
      ctx.deps.selfCheckInput = () => ({
        openIssues: [{ issueId: 'iss_0123456789abcdef', surface: 'gateway' }],
        noUpdateScope: 'self-check:2026-09-04',
      });
      const consumer = new WorkOrderConsumer(ctx.deps);
      const wo = ctx.ledger.enqueueWorkOrder({
        workKind: 'self-check',
        idempotencyKey: 'self-check:2026-09-04',
        input: { scheduledFor: '2026-09-04' },
      });
      expect(wo.workKind).toBe('self-check');
      // system rows are invisible to the owner-facing getById; read the column directly
      expect(
        (
          ctx.db.prepare('SELECT source_channel FROM operator_tasks WHERE id = ?').get(wo.id) as {
            source_channel: string;
          }
        ).source_channel
      ).toBe('workorder:self-check');
      // idempotent on the date key
      expect(
        ctx.ledger.enqueueWorkOrder({
          workKind: 'self-check',
          idempotencyKey: 'self-check:2026-09-04',
          input: { scheduledFor: '2026-09-04' },
        }).id
      ).toBe(wo.id);
      await consumer.tick();
      expect(seen).toContain('iss_0123456789abcdef');
      expect(seen).toContain('## Turn: self-check');
    });
  });
  describe('ONE-MAMA-P3 Task 4: budget stop on a scheduled turn', () => {
    it('AC #3 a budget-stopped run is retried with the reason, not judged on its partial response', async () => {
      const ctx = makeDeps();
      ctx.deps.runner = {
        runWithContent: async () => ({ response: 'DONE (partial)', stoppedBy: 'budget' as const }),
      };
      const consumer = new WorkOrderConsumer(ctx.deps);
      const wo = ctx.ledger.enqueueWorkOrder({
        workKind: 'wiki',
        idempotencyKey: 'wiki:budget:1',
        input: { batchId: 'b', events: ['e'] },
      });
      await consumer.tick();
      expect(
        ctx.events.some(
          (e) => e.type !== 'complete' && 'reason' in e && String(e.reason).includes('token budget')
        )
      ).toBe(true);
      expect(ctx.events.some((e) => e.type === 'complete' && e.workOrderId === wo.id)).toBe(false);
    });
  });
});

describe('board turn section names the slot format without the class vocabulary', () => {
  it('the required result says HTML fragments; the class list lives in the board persona', () => {
    const board = buildTurnKindSection('board');
    expect(board).toContain('as HTML fragments');
    // 0.41.0 wrote plain text whose newlines collapsed; the format is still stated. The
    // per-class vocabulary is not a turn instruction and stays where it is used.
    for (const kind of ['board', 'wiki', 'memory-curation', 'self-check', 'temporal'] as const) {
      expect(buildTurnKindSection(kind)).not.toContain('report-card');
    }
  });
});

/**
 * Constraint removal Task 1 (TG-04/TG-06): the board prompt the installed daemon actually
 * assembles. The installed 0.46.0 path added a separate worker system persona above the seeded
 * owner brief and host turn section. Those layers contradicted each other: the worker said Trello is
 * reachable only through context_compile, never judge lifecycle across stores, and never ask;
 * the turn section said read trello_* live, decide what is finished, and ask the owner. This
 * drives the real consumer with the real runOptions shape and reads what the runner received.
 */
describe('Story TG-04/TG-06 AC #1: the assembled board prompt is coherent end to end', () => {
  async function assembleBoardTurn(): Promise<{
    systemPrompt: string;
    userMessage: string;
    allowedTools: readonly string[];
  }> {
    const { buildTurnAgentPolicy } = await import('../../src/cli/commands/start.js');
    const { DEFAULT_ROLES } = await import('../../src/cli/config/types.js');
    const { resolvePrivateConnectorPolicy } =
      await import('../../src/connectors/private-connector-policy.js');
    const { CONSOLE_BRIEF_DEFAULT } = await import('../../src/operator/console-brief.js');
    const { attachWorkOrderAttemptContext } = await import('../../src/operator/worker-run.js');
    const privatePolicy = resolvePrivateConnectorPolicy({ ok: true, config: {}, enabledNames: [] });
    const policy = buildTurnAgentPolicy(
      'board',
      'gpt-test',
      'codex',
      privatePolicy,
      ['trello'],
      DEFAULT_ROLES.definitions.owner_console
    );
    const ctx = makeDeps({ loadOwnerBrief: () => CONSOLE_BRIEF_DEFAULT });
    let systemPrompt = '';
    let userMessage = '';
    ctx.deps.runner = {
      runWithContent: async (content, options) => {
        systemPrompt = options.systemPrompt === undefined ? '' : String(options.systemPrompt);
        userMessage = content.map((block) => ('text' in block ? block.text : '')).join('\n');
        return { response: 'DONE' };
      },
    };
    // The exact shape start.ts hands the consumer for a board order.
    ctx.deps.runOptionsFor = (wo) =>
      attachWorkOrderAttemptContext(
        {
          gatewayToolsPrompt: policy.gatewayToolsPrompt,
          agentContext: policy.agentContext,
          workOrderBriefProjectionPolicy: policy.briefProjectionPolicy,
        },
        wo.id
      );
    const consumer = new WorkOrderConsumer(ctx.deps);
    ctx.ledger.enqueueWorkOrder({
      workKind: 'board',
      idempotencyKey: 'board:assembled:1',
      input: { mode: 'full', repairGeneration: 3, noUpdateScope: 'board:full:3' },
    });
    await consumer.tick();
    expect(systemPrompt).toBe('');
    expect(userMessage).toContain('## Turn: board');
    return { systemPrompt, userMessage, allowedTools: policy.agentContext.role.allowedTools };
  }

  it('every tool the turn section names is in the grant, and no layer narrows Trello to context_compile', async () => {
    const { systemPrompt, userMessage, allowedTools } = await assembleBoardTurn();
    const board = userMessage.slice(userMessage.indexOf('## Turn: board'));

    // The outcome contract names only the two tools that record the result.
    const named = new Set(
      board.match(
        /\b(?:trello_[a-z_]+|context_compile|task_(?:list|create|update|reclassify|external_bind|external_correlation|lifecycle_reconcile)|report_publish|contract_no_update)\b/g
      ) ?? []
    );
    expect([...named].sort()).toEqual(['contract_no_update', 'report_publish']);
    for (const tool of named) {
      expect(allowedTools, `turn section names ${tool} but the grant lacks it`).toContain(tool);
    }
    // Dropping the script must not drop the judgment capability: the agent decides how to
    // work, so the tools the old script walked it through stay granted.
    expect(allowedTools).toEqual(
      expect.arrayContaining([
        'task_list',
        'task_update',
        'task_reclassify',
        'task_external_bind',
        'task_lifecycle_reconcile',
        'task_external_correlation',
        'context_compile',
        'trello_kanban',
        'telegram_send',
        'report_publish',
      ])
    );
    expect(systemPrompt).not.toMatch(/only through context_compile/i);
    expect(userMessage).not.toMatch(/only through context_compile/i);
    expect(systemPrompt).not.toMatch(/channel history/i);
    expect(board).not.toMatch(/channel history/i);
  });

  it('the assembled board turn is a stimulus: no step-by-step procedure survives any layer', async () => {
    const { systemPrompt, userMessage } = await assembleBoardTurn();
    const board = userMessage.slice(userMessage.indexOf('## Turn: board'));

    expect(systemPrompt).toBe('');
    expect(board.length).toBeLessThan(1300);
    for (const script of [
      'task_list({view',
      'Read the board progressively',
      'expected_revision',
      'candidate-bound',
      'report-card',
    ]) {
      expect(board, `board turn still scripts: ${script}`).not.toContain(script);
    }
    // And no layer forbids the judgment the owner wants made.
    const whole = `${systemPrompt}\n${userMessage}`;
    expect(whole).not.toMatch(/never infer or copy lifecycle status/i);
    expect(whole).not.toMatch(/do not ask questions/i);
  });

  it('the owner question route survives as the decisions slot, with no send required', async () => {
    const { userMessage, allowedTools } = await assembleBoardTurn();
    expect(userMessage).toMatch(/decisions slot/);
    expect(userMessage).toContain('without waiting for an answer');
    expect(allowedTools).toContain('report_publish');
  });
});

/**
 * Owner decision 2026-09-09: the owner agent may hand long maintenance work to a native
 * subagent and return WITHOUT waiting. The runtime wakes it when the child finishes, and the
 * child's tool calls land on the owner session - so the attempt stays OPEN in `delegated`
 * and the SAME trace verification answers on a later tick. Delegation is observed on the
 * runner's own item stream, never claimed in prose.
 */
describe('delegated maintenance attempts', () => {
  function delegatingCtx(
    verified: { current: boolean },
    announce: 'tool-use' | 'subagent-start' = 'tool-use'
  ) {
    const ctx = makeDeps({ now: () => clock.current });
    ctx.deps.runner = {
      runWithContent: async (_content, options) => {
        const stream = options.streamCallbacks as
          | {
              onToolUse?: (name: string, input: Record<string, unknown>) => void;
              onSubagentStart?: (info: {
                agentThreadId: string;
                agentPath: string;
                itemId: string;
              }) => void;
            }
          | undefined;
        if (announce === 'subagent-start') {
          stream?.onSubagentStart?.({
            agentThreadId: 'child-1',
            agentPath: '/root/board',
            itemId: 'sub-1',
          });
        } else {
          stream?.onToolUse?.('collabAgentToolCall', { nativeToolUseId: 'item-1' });
        }
        return { response: 'handed to a subagent' };
      },
    };
    const consumer = new WorkOrderConsumer(ctx.deps);
    // A verdictRequired hook whose verification is the thing that answers later.
    consumer.registerHook('wiki', {
      verdictRequired: true,
      before: () => 41,
      after: (_wo, _response, beforeState) => {
        expect(beforeState).toBe(41);
        return verified.current
          ? { disposition: 'complete' as const }
          : { disposition: 'fail' as const, reason: 'no obligated tool ran' };
      },
    });
    return { ctx, consumer };
  }

  const clock = { current: 1_000_000 };
  beforeEach(() => {
    clock.current = 1_000_000;
  });

  it('names the observed native subagent items', () => {
    expect(NATIVE_SUBAGENT_ITEM_NAMES).toContain('collabAgentToolCall');
    expect(NATIVE_SUBAGENT_ITEM_NAMES).toContain('subAgentActivity');
  });

  it('keeps the attempt open in delegated, then completes it when the verification passes', async () => {
    const verified = { current: false };
    const { ctx, consumer } = delegatingCtx(verified);
    const wo = ctx.ledger.enqueueWorkOrder({
      workKind: 'wiki',
      idempotencyKey: 'wiki:delegated:1',
      input: { batchId: 'b', events: ['e'] },
    });

    await consumer.tick();
    // Not failed: the work was handed on, and the row keeps its idempotency slot.
    expect(ctx.events).toContainEqual({
      type: 'delegated',
      workKind: 'wiki',
      workOrderId: wo.id,
      reason: 'no obligated tool ran',
    });
    expect(ctx.events.some((event) => event.type === 'failed')).toBe(false);
    expect(ctx.logs).toContain(`[workorder] delegated kind=wiki attempt=${wo.id}`);
    const delegated = ctx.ledger.getWorkOrderById(wo.id);
    expect(delegated?.status).toBe('in_progress');
    expect(delegated?.delegatedAt).toBe(1_000_000);

    // The child does its work: the same verification, against the same snapshot, now passes.
    verified.current = true;
    clock.current += 60_000;
    await consumer.tick();
    expect(ctx.logs).toContain(`[workorder] delegated→done kind=wiki attempt=${wo.id}`);
    expect(ctx.events).toContainEqual(
      expect.objectContaining({ type: 'complete', workKind: 'wiki', workOrderId: wo.id })
    );
    expect(ctx.ledger.getWorkOrderById(wo.id)?.status).toBe('done');
  });

  it('delegates on onSubagentStart alone, which is all codex-cli 0.153.4 emits', async () => {
    // Live: board#4764 failed as `no-durable-result` because only `subAgentActivity`
    // reached the host, and that item never becomes an onToolUse. The dedicated
    // admission callback must be enough on its own.
    const verified = { current: false };
    const { ctx, consumer } = delegatingCtx(verified, 'subagent-start');
    const wo = ctx.ledger.enqueueWorkOrder({
      workKind: 'wiki',
      idempotencyKey: 'wiki:delegated:subagent-start',
      input: { batchId: 'b', events: ['e'] },
    });

    await consumer.tick();
    expect(ctx.events).toContainEqual({
      type: 'delegated',
      workKind: 'wiki',
      workOrderId: wo.id,
      reason: 'no obligated tool ran',
    });
    expect(ctx.events.some((event) => event.type === 'failed')).toBe(false);
    expect(ctx.logs).toContain(
      `[workorder] subagent observed kind=wiki attempt=${wo.id} path=/root/board`
    );
    expect(ctx.ledger.getWorkOrderById(wo.id)?.status).toBe('in_progress');
    expect(ctx.ledger.getWorkOrderById(wo.id)?.delegatedAt).toBe(1_000_000);
  });

  it('fails a delegated attempt as delegated-timeout after 30 minutes with no evidence', async () => {
    const verified = { current: false };
    const { ctx, consumer } = delegatingCtx(verified);
    const wo = ctx.ledger.enqueueWorkOrder({
      workKind: 'wiki',
      idempotencyKey: 'wiki:delegated:timeout',
      input: { batchId: 'b', events: ['e'] },
    });

    await consumer.tick();
    expect(ctx.ledger.getWorkOrderById(wo.id)?.status).toBe('in_progress');

    // One tick short of the bound is still open.
    clock.current += DELEGATED_ATTEMPT_TIMEOUT_MS - 1;
    await consumer.tick();
    expect(ctx.events.some((event) => event.type === 'failed')).toBe(false);

    clock.current += 1;
    await consumer.tick();
    expect(
      ctx.events.filter((event) => event.type === 'failed').map((event) => event.reason)
    ).toContain('delegated-timeout');
  });

  it('does not delegate a verification failure when no subagent was observed', async () => {
    const verified = { current: false };
    const { ctx, consumer } = delegatingCtx(verified);
    ctx.deps.runner = { runWithContent: async () => ({ response: 'did it myself' }) };
    const wo = ctx.ledger.enqueueWorkOrder({
      workKind: 'wiki',
      idempotencyKey: 'wiki:not-delegated',
      input: { batchId: 'b', events: ['e'] },
    });

    await consumer.tick();
    expect(ctx.events.some((event) => event.type === 'delegated')).toBe(false);
    expect(
      ctx.events.filter((event) => event.type === 'failed').map((event) => event.reason)
    ).toContain('no obligated tool ran');
    expect(ctx.ledger.getWorkOrderById(wo.id)?.status).not.toBe('in_progress');
  });

  it('a requeued replacement carries no delegation of its own', () => {
    const ctx = makeDeps();
    const wo = ctx.ledger.enqueueWorkOrder({
      workKind: 'wiki',
      idempotencyKey: 'wiki:requeue-delegated',
      input: { batchId: 'b', events: ['e'] },
    });
    const claimed = ctx.ledger.claimNextWorkOrder();
    if (!claimed) throw new Error('claim expected');
    ctx.ledger.markWorkOrderDelegated(claimed.id, 12_345);
    expect(ctx.ledger.getWorkOrderById(wo.id)?.delegatedAt).toBe(12_345);

    const replacement = ctx.ledger.requeueWorkOrder(
      ctx.ledger.getWorkOrderById(wo.id)!,
      'delegated-timeout'
    );
    expect(replacement.delegatedAt).toBeNull();
    expect(replacement.payload.delegated_at).toBeUndefined();
  });

  /**
   * Live stall (daemon local.10, 2026-09-09, board#4765): the stored payload of a delegated
   * attempt carries the ledger-managed `delegated_at`, and the candidate receipt
   * reconciliation revalidated that stored row with the ENQUEUE validator - so a
   * delegated-and-verified board attempt logged `unknown field 'delegated_at'` on every tick,
   * sat in unresolvedBoardCandidateEffects forever, and the unresolved set is a hard claim
   * barrier that blocks EVERY later work order.
   */
  it('settles a delegated board attempt whose stored payload carries delegated_at', async () => {
    const verified = { current: false };
    const { ctx, consumer } = delegatingCtx(verified);
    consumer.registerHook('board', {
      verdictRequired: true,
      before: () => 41,
      after: () =>
        verified.current
          ? { disposition: 'complete' as const }
          : { disposition: 'fail' as const, reason: 'no obligated tool ran' },
    });
    const wo = ctx.ledger.enqueueWorkOrder({
      workKind: 'board',
      idempotencyKey: 'board:delegated:delegated-at',
      input: { mode: 'full' },
    });

    await consumer.tick();
    expect(ctx.ledger.getWorkOrderById(wo.id)?.payload.delegated_at).toBe(1_000_000);

    verified.current = true;
    clock.current += 60_000;
    await consumer.tick();

    expect(ctx.logs.some((line) => line.includes('candidate receipt state unresolved'))).toBe(
      false
    );
    expect(ctx.logs).toContain(`[workorder] delegated\u2192done kind=board attempt=${wo.id}`);
    expect(ctx.ledger.getWorkOrderById(wo.id)?.status).toBe('done');

    // The claim barrier is clear: a later order still drains.
    const next = ctx.ledger.enqueueWorkOrder({
      workKind: 'board',
      idempotencyKey: 'board:delegated:after-stall',
      input: { mode: 'full' },
    });
    clock.current += 60_000;
    await consumer.tick();
    expect(ctx.ledger.getWorkOrderById(next.id)?.status).not.toBe('pending');
  });

  it('refuses to record a delegation whose row left in_progress before the write', () => {
    const ctx = makeDeps();
    const wo = ctx.ledger.enqueueWorkOrder({
      workKind: 'wiki',
      idempotencyKey: 'wiki:delegate-raced',
      input: { batchId: 'b', events: ['e'] },
    });
    const claimed = ctx.ledger.claimNextWorkOrder();
    if (!claimed) throw new Error('claim expected');
    const stale = ctx.ledger.getWorkOrderById(wo.id);
    if (!stale) throw new Error('row expected');
    // The race the guarded UPDATE cannot see: the row moves on between read and write, so
    // the read reports in_progress and the UPDATE matches nothing.
    ctx.db.prepare(`UPDATE operator_tasks SET status = 'done' WHERE id = ?`).run(wo.id);
    (ctx.ledger as unknown as { getWorkOrderById: (id: number) => unknown }).getWorkOrderById =
      () => stale;
    expect(() => ctx.ledger.markWorkOrderDelegated(claimed.id, 5)).toThrow(
      /left in_progress before the mark/
    );
  });

  it('refuses to record a delegation on a row that is not claimed', () => {
    const ctx = makeDeps();
    const wo = ctx.ledger.enqueueWorkOrder({
      workKind: 'wiki',
      idempotencyKey: 'wiki:delegate-pending',
      input: { batchId: 'b', events: ['e'] },
    });
    expect(() => ctx.ledger.markWorkOrderDelegated(wo.id, 1)).toThrow(/expected in_progress/);
  });
});

/**
 * Owner decision 2026-09-09: the scheduled board is UPDATED from the accumulated state. The
 * delta contract names the three reads it has and says the raw sources are not among them.
 */
describe('board delta turn contract', () => {
  const anchor = '2026-09-09T08:00:00.000Z';
  const section = () =>
    buildTurnKindSection('board', 'full:91', { boardMode: 'delta', deltaAnchor: anchor });

  it('names the anchor and the three accumulated-state sources', () => {
    const body = section();
    expect(body).toContain(`Anchor: ${anchor}`);
    expect(body).toContain('board_read');
    expect(body).toContain(`changes_read({since: "${anchor}"})`);
    expect(body).toContain(`task_list with updated_since "${anchor}"`);
    expect(body).toContain('contract_no_update({reason, scope: "full:91"})');
    expect(body).toContain('report_publish');
  });

  it('forbids raw connector reads and rebuilding', () => {
    const body = section();
    expect(body).toContain('Raw connector reads are not part of this turn');
    expect(body).toContain('do not rebuild it from the sources');
    expect(body).not.toContain('The input carries the batch and the candidates.');
    expect(body.length).toBeLessThan(1600);
  });

  it('leaves the full contract untouched for every other mode', () => {
    for (const options of [
      undefined,
      { boardMode: 'full' },
      { boardMode: 'reconcile' },
      // A delta without a host anchor is not a delta contract - it must not be told to read
      // from a baseline the host never named.
      { boardMode: 'delta' },
    ]) {
      const body = buildTurnKindSection('board', 'full:91', options);
      expect(body).toContain('The input carries the batch and the candidates.');
      expect(body).not.toContain('changes_read');
    }
  });
});
