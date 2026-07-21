import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAgentToolExecutionContext } from '../../src/agent/agent-loop.js';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import type { GatewayToolExecutionContext, MAMAApiSetInput } from '../../src/agent/types.js';
import type { ContextCompileService } from '../../src/agent/context-compile-service.js';
import { initAgentTables } from '../../src/db/agent-store.js';
import { TaskLedger } from '../../src/operator/task-ledger.js';
import type { TemporalWorkContext } from '../../src/operator/temporal-effect.js';
import { occurrenceKeyForTask, temporalGenerationKey } from '../../src/operator/task-temporal.js';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { makeSignedEnvelope } from '../envelope/fixtures.js';

describe('Story A2 Task 7: trusted temporal work context', () => {
  let db: SQLiteDatabase;
  let ledger: TaskLedger;
  let executor: GatewayToolExecutor;
  let context: TemporalWorkContext;
  let executionContext: GatewayToolExecutionContext;
  let taskId: number;
  const now = Date.parse('2026-07-21T15:00:00Z');

  beforeEach(() => {
    db = new Database(':memory:');
    ledger = new TaskLedger(db, { now: () => now, timeZone: 'Asia/Seoul' });
    initAgentTables(db);
    executor = new GatewayToolExecutor();
    executor.setTaskLedger(ledger);
    executor.setSessionsDb(db);
    const task = ledger.create({
      title: 'temporal authority test',
      due_at: '2026-07-22T00:00:00+09:00',
      source_channel: 'trello:synthetic-board',
      source_event_id: 'synthetic-card',
    });
    taskId = task.id;
    const occurrenceKey = occurrenceKeyForTask(task)!;
    const generationKey = temporalGenerationKey(task.id, occurrenceKey, now);
    ledger.enqueueTemporalGeneration({
      generationKey,
      taskId: task.id,
      temporalEpoch: task.temporalEpoch,
      occurrenceKey,
      checkAt: now,
      sourceChannel: task.sourceChannel,
      sourceEventId: task.sourceEventId,
      priority: 'high',
    });
    const attempt = ledger.claimNextWorkOrder()!;
    context = ledger.loadTemporalWorkContext(attempt.id);
    executionContext = {
      executionSurface: 'model_tool',
      temporalWorkContext: context,
      agentContext: {
        source: 'operator',
        platform: 'cli',
        roleName: 'workorder-temporal',
        role: {
          allowedTools: ['code_act', 'report_publish', 'task_list', 'task_temporal_reconcile'],
          allowedPaths: [],
          systemControl: false,
          sensitiveAccess: false,
        },
        session: {
          sessionId: 'operator:worker:temporal',
          channelId: 'worker:temporal',
          startedAt: new Date(now),
        },
        capabilities: ['code_act', 'report_publish', 'task_list', 'task_temporal_reconcile'],
        limitations: [],
        tier: 2,
        backend: 'codex',
      },
    };
  });

  afterEach(() => db.close());

  it('copies only a host-supplied temporal context into an agent run', () => {
    const trusted = buildAgentToolExecutionContext({ temporalWorkContext: context });
    const ordinary = buildAgentToolExecutionContext({ source: 'telegram', channelId: 'tg:1' });

    expect(trusted?.temporalWorkContext).toEqual(context);
    expect(ordinary).not.toHaveProperty('temporalWorkContext');
  });

  it('scopes task_list to the single host-bound owner task', async () => {
    ledger.create({ title: 'unrelated private owner task' });

    const result = (await executor.execute('task_list', {} as never, executionContext)) as {
      success: boolean;
      tasks: Array<{ id: number; title: string }>;
    };

    expect(result.success).toBe(true);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.id).toBe(taskId);
    expect(result.tasks[0]?.title).toBe('temporal authority test');
  });

  it('keeps task_temporal_reconcile unavailable without trusted context', async () => {
    await expect(
      executor.execute('task_temporal_reconcile', {
        expected_revision: context.revision,
        outcome: 'resolved',
        status: 'done',
        reason: 'model supplied identifiers are not authority',
        task_id: context.taskId,
        attempt_id: context.attemptId,
      } as never)
    ).rejects.toMatchObject({ code: 'WORKORDER_SUPERSEDED' });
    expect(ledger.getById(taskId)?.revision).toBe(1);
  });

  it('rejects model attempts to override trusted identity fields', async () => {
    await expect(
      executor.execute(
        'task_temporal_reconcile',
        {
          expected_revision: context.revision,
          outcome: 'resolved',
          status: 'done',
          reason: 'forged task id',
          task_id: context.taskId + 1,
        } as never,
        executionContext
      )
    ).rejects.toThrow(/^temporal_tool_failed;sha256=[a-f0-9]{64};length=\d+$/);
    expect(ledger.getById(taskId)?.revision).toBe(1);
  });

  it('commits through direct gateway execution and returns the bounded receipt', async () => {
    const result = (await executor.execute(
      'task_temporal_reconcile',
      {
        expected_revision: context.revision,
        outcome: 'resolved',
        status: 'done',
        reason: 'Fresh source evidence confirms completion',
      } as never,
      executionContext
    )) as { success: boolean; receipt: { taskId: number; workorderAttemptId: number } };

    expect(result).toMatchObject({
      success: true,
      receipt: { taskId, workorderAttemptId: context.attemptId },
    });
    expect(ledger.getById(taskId)).toMatchObject({ status: 'done', revision: 2 });
  });

  it('retains the exact trusted context through nested Code-Act', async () => {
    const result = await executor.execute(
      'code_act',
      {
        code: `task_temporal_reconcile({ expected_revision: ${context.revision}, outcome: 'resolved', status: 'done', reason: 'Nested host context is exact' })`,
        allowedTools: ['task_temporal_reconcile'],
      },
      executionContext
    );

    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(ledger.getTemporalEffect(context.attemptId)).toMatchObject({
      taskId,
      outcome: 'resolved',
    });
  });

  it('allows reads but rejects all temporal writes after supersession', async () => {
    ledger.update(taskId, { due_at: '2026-07-23T00:00:00+09:00' });
    const published: unknown[] = [];
    executor.setReportPublisher((slots) => published.push(slots));

    const read = await executor.execute('task_list', {} as never, executionContext);
    expect(read.success).toBe(true);
    await expect(
      executor.execute(
        'report_publish',
        { slots: { pipeline: '<p>stale</p>' } } as never,
        executionContext
      )
    ).rejects.toMatchObject({ code: 'WORKORDER_SUPERSEDED' });
    await expect(
      executor.execute(
        'task_temporal_reconcile',
        {
          expected_revision: context.revision,
          outcome: 'resolved',
          status: 'done',
          reason: 'stale attempt',
        } as never,
        executionContext
      )
    ).rejects.toMatchObject({ code: 'WORKORDER_SUPERSEDED' });
    expect(published).toHaveLength(0);
  });

  it('checks supersession before envelope validation and creates no denial audit', async () => {
    const sentinel = 'private-trello-card-secret-42';
    ledger.update(taskId, { due_at: '2026-07-23T00:00:00+09:00' });
    const staleContext: GatewayToolExecutionContext = {
      ...executionContext,
      envelope: makeSignedEnvelope({
        scope: {
          ...makeSignedEnvelope().scope,
          raw_connectors: ['trello'],
        },
      }),
      agentContext: {
        ...executionContext.agentContext!,
        role: {
          ...executionContext.agentContext!.role,
          allowedTools: ['context_compile'],
        },
      },
    };

    await expect(
      executor.execute(
        'context_compile',
        { task: 'compile', connectors: [sentinel] } as never,
        staleContext
      )
    ).rejects.toMatchObject({ code: 'WORKORDER_SUPERSEDED' });

    const auditJson = JSON.stringify(
      db.prepare(`SELECT * FROM agent_activity ORDER BY id ASC`).all()
    );
    expect(auditJson).not.toContain(sentinel);
    expect(auditJson).not.toContain('envelope_violation');
  });

  it('keeps temporal context_compile denials non-reflective in direct and nested Code-Act', async () => {
    const connectorSentinel = 'private-trello-card-secret-99';
    const rawIdSentinel = 'private-raw-id-secret-100';
    const compilerSentinel = 'private-compiler-secret-101';
    const traceSummaries: string[] = [];
    const compileService: ContextCompileService = {
      compileAndPersistContext: async () => {
        throw new Error(`compiler reflected ${compilerSentinel}`);
      },
    };
    executor.setContextCompileService(compileService);
    executor.setMamaApi({
      listDecisions: async () => [],
      appendToolTrace: async (input) => {
        traceSummaries.push(input.output_summary ?? '');
        return {} as never;
      },
    } as unknown as MAMAApiSetInput);
    const securedContext: GatewayToolExecutionContext = {
      ...executionContext,
      modelRunId: 'mr_temporal_security',
      envelope: makeSignedEnvelope({
        scope: {
          ...makeSignedEnvelope().scope,
          raw_connectors: ['trello'],
        },
      }),
      agentContext: {
        ...executionContext.agentContext!,
        role: {
          ...executionContext.agentContext!.role,
          allowedTools: ['code_act', 'context_compile'],
        },
      },
    };

    const direct = await executor.execute(
      'context_compile',
      { task: 'compile', connectors: [connectorSentinel] } as never,
      securedContext
    );
    expect(direct).toMatchObject({ success: false, code: 'connector_out_of_scope' });
    expect(JSON.stringify(direct)).not.toContain(connectorSentinel);

    const forgedSeed = await executor.execute(
      'context_compile',
      {
        task: 'compile',
        connectors: ['trello'],
        seed_refs: [{ kind: 'raw', connector: 'trello', raw_id: rawIdSentinel }],
      } as never,
      securedContext
    );
    expect(forgedSeed).toMatchObject({ success: false, code: 'context_compile_failed' });
    expect(JSON.stringify(forgedSeed)).not.toContain(rawIdSentinel);
    expect(JSON.stringify(forgedSeed)).not.toContain(compilerSentinel);

    const nested = await executor.execute(
      'code_act',
      {
        code: `context_compile({ task: 'compile', connectors: ['trello'], seed_refs: [{ kind: 'raw', connector: 'trello', raw_id: '${rawIdSentinel}' }] })`,
        allowedTools: ['context_compile'],
      },
      securedContext
    );
    const nestedJson = JSON.stringify(nested);
    expect(nestedJson).not.toContain(rawIdSentinel);
    expect(nestedJson).not.toContain(compilerSentinel);

    const auditJson = JSON.stringify(
      db.prepare(`SELECT * FROM agent_activity ORDER BY id ASC`).all()
    );
    for (const sentinel of [connectorSentinel, rawIdSentinel, compilerSentinel]) {
      expect(auditJson).not.toContain(sentinel);
      expect(JSON.stringify(traceSummaries)).not.toContain(sentinel);
    }
  });

  it('blocks stale side-effect tools even if a legacy Claude catalog exposes them', async () => {
    ledger.update(taskId, { due_at: '2026-07-23T00:00:00+09:00' });
    const legacyContext: GatewayToolExecutionContext = {
      ...executionContext,
      agentContext: {
        ...executionContext.agentContext!,
        role: {
          ...executionContext.agentContext!.role,
          allowedTools: ['browser_click'],
        },
      },
    };

    await expect(
      executor.execute('browser_click', { selector: '#danger' } as never, legacyContext)
    ).rejects.toMatchObject({ code: 'WORKORDER_SUPERSEDED' });
  });

  it('restricts temporal report publication to the host-derived pipeline slot', async () => {
    const published: unknown[] = [];
    executor.setReportPublisher((slots) => published.push(slots));

    await expect(
      executor.execute(
        'report_publish',
        { slots: { briefing: '<p>forbidden</p>' } } as never,
        executionContext
      )
    ).rejects.toThrow(/^temporal_tool_failed;sha256=[a-f0-9]{64};length=\d+$/);
    await expect(
      executor.execute(
        'report_publish',
        { slots: { pipeline: '<p>ok</p>', custom: '<p>forbidden</p>' } } as never,
        executionContext
      )
    ).rejects.toThrow(/^temporal_tool_failed;sha256=[a-f0-9]{64};length=\d+$/);

    const result = await executor.execute(
      'report_publish',
      { slots: { pipeline: '<p>ok</p>' } } as never,
      executionContext
    );
    expect(result.success).toBe(true);
    expect(published).toEqual([{ pipeline: '<p>ok</p>' }]);
  });
});
