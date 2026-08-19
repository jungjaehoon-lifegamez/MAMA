/**
 * Story S2-T3 (review round 1 BLOCKERs): the extracted completion-hook pieces.
 *
 * The G1 trace test goes through the REAL logGatewayToolCall path - rows are
 * written by GatewayToolExecutor.execute() against a real sessions DB, never
 * self-seeded (plan AC bans seeded rows). Plan:
 * docs/superpowers/plans/2026-07-18-stage2-workorder-ownership.md
 */
import { describe, it, expect } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { initAgentTables } from '../../src/db/agent-store.js';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import { createReportPublisher, createReportStore } from '../../src/api/report-handler.js';
import { TaskLedger } from '../../src/operator/task-ledger.js';
import {
  buildWorkerTraceQueries,
  buildFullBoardTraceQueries,
  applyBoardRefreshVerdict,
  LANE_OBLIGATED_TOOLS,
  buildPromotionAfterHook,
  boardCandidateReceiptVerdict,
  buildTemporalWorkOrderHook,
  buildWikiAfterHook,
} from '../../src/operator/workorder-hooks.js';
import type { WorkOrderRecord } from '../../src/operator/task-ledger.js';

const fakeWo = { workKind: 'memory-curation', id: 1 } as unknown as WorkOrderRecord;

describe('Story S2-T3: extracted workorder hooks', () => {
  describe('TG-01/TG-05/TG-06 Task 6: board candidate receipt verdict', () => {
    it('requires a full durable receipt set for a candidate reconcile while leaving ordinary boards complete', () => {
      const candidateReconcile = {
        id: 11,
        workKind: 'board',
        payload: {
          attempts: 1,
          mode: 'reconcile',
          candidates: {
            bindingCandidates: [{ candidateId: 'candidate-a' }],
            lifecycleCandidates: [],
          },
        },
      } as unknown as WorkOrderRecord;
      const ordinaryBoard = {
        ...candidateReconcile,
        payload: { attempts: 1, mode: 'full' },
      } as unknown as WorkOrderRecord;

      expect(
        boardCandidateReceiptVerdict(candidateReconcile, {
          inspectBoardCandidateAttempt: () => ({
            disposition: 'partial',
            missingCandidateIds: ['candidate-a'],
          }),
        })
      ).toEqual({
        disposition: 'fail',
        reason: 'candidate receipt set partial; missing 1 decision(s)',
      });
      expect(boardCandidateReceiptVerdict(ordinaryBoard, null)).toEqual({
        disposition: 'complete',
      });
    });
  });

  describe('TG-01/TG-06 Board repair gate completion', () => {
    it('clears a captured reconcile only when action and candidate effects both verify', () => {
      const cleared: Array<[string, number]> = [];
      const gate = {
        completeVerifiedReconcile: (channel: string, generation: number) =>
          cleared.push([channel, generation]),
        completeVerifiedFull: () => undefined,
      };
      const workOrder = {
        id: 12,
        workKind: 'board',
        payload: {
          attempts: 1,
          mode: 'reconcile',
          channelKey: 'telegram:owner',
          repairGeneration: 51,
        },
      } as unknown as WorkOrderRecord;

      expect(applyBoardRefreshVerdict(workOrder, true, { disposition: 'complete' }, gate)).toEqual({
        disposition: 'complete',
      });
      expect(cleared).toEqual([['telegram:owner', 51]]);

      applyBoardRefreshVerdict(workOrder, false, { disposition: 'complete' }, gate);
      applyBoardRefreshVerdict(
        workOrder,
        true,
        { disposition: 'fail', reason: 'candidate receipt missing' },
        gate
      );
      expect(cleared).toEqual([['telegram:owner', 51]]);
    });

    it('clears all captured dirt only after a host-verified full effect', () => {
      const cleared: number[] = [];
      const gate = {
        completeVerifiedReconcile: () => undefined,
        completeVerifiedFull: (generation: number) => cleared.push(generation),
      };
      const workOrder = {
        id: 13,
        workKind: 'board',
        payload: { attempts: 1, mode: 'full', repairGeneration: 88, noUpdateScope: 'full:88' },
      } as unknown as WorkOrderRecord;

      applyBoardRefreshVerdict(workOrder, false, { disposition: 'complete' }, gate);
      expect(cleared).toEqual([]);
      applyBoardRefreshVerdict(workOrder, true, { disposition: 'complete' }, gate);
      expect(cleared).toEqual([88]);
    });
  });

  describe('AC #1 (G1): worker trace queries see rows written by the REAL executor log path', () => {
    async function runToolAs(
      db: SQLiteDatabase,
      executor: GatewayToolExecutor,
      channelId: string
    ): Promise<void> {
      // task_create is in OBLIGATED_TOOLS; the executor's execute() logs the
      // gateway_tool_call row itself (real logGatewayToolCall shape).
      const result = (await executor.execute(
        'task_create',
        { title: `probe ${channelId}` } as never,
        { executionSurface: 'model_tool', source: 'operator', channelId } as never
      )) as { success?: boolean };
      expect(result.success).toBe(true);
    }

    it('counts obligated rows for worker:board and ignores other channels', async () => {
      const sessionsDb: SQLiteDatabase = new Database(':memory:');
      initAgentTables(sessionsDb);
      const opDb: SQLiteDatabase = new Database(':memory:');
      const executor = new GatewayToolExecutor({});
      executor.setSessionsDb(sessionsDb);
      executor.setTaskLedger(new TaskLedger(opDb));

      const queries = buildWorkerTraceQueries(sessionsDb, 'worker:board');
      const before = queries.getTraceMaxId();
      expect(queries.countObligatedTraceRowsSince(before)).toBe(0);

      await runToolAs(sessionsDb, executor, 'worker:board'); // counted
      await runToolAs(sessionsDb, executor, 'telegram:123'); // other channel - ignored

      expect(queries.countObligatedTraceRowsSince(before)).toBe(1);
      expect(queries.getTraceMaxId()).toBeGreaterThan(before);

      // The anchor works: rows before the snapshot are not re-counted.
      const after = queries.getTraceMaxId();
      expect(queries.countObligatedTraceRowsSince(after)).toBe(0);
    });

    it('TG-06 full repair evidence is attempt-bound and requires all four slots', async () => {
      const sessionsDb: SQLiteDatabase = new Database(':memory:');
      initAgentTables(sessionsDb);
      const opDb: SQLiteDatabase = new Database(':memory:');
      const executor = new GatewayToolExecutor({});
      executor.setSessionsDb(sessionsDb);
      executor.setTaskLedger(new TaskLedger(opDb));
      executor.setReportPublisher(() => undefined);

      expect(() => buildFullBoardTraceQueries(sessionsDb, 'worker:board', 0)).toThrow(
        /positive integer/
      );

      const queries = buildFullBoardTraceQueries(sessionsDb, 'worker:board', 41);
      const before = queries.getTraceMaxId();
      await runToolAs(sessionsDb, executor, 'worker:board');
      await executor.execute(
        'report_publish',
        { slots: { briefing: '<p>partial must not verify</p>' } } as never,
        {
          executionSurface: 'model_tool',
          source: 'operator',
          channelId: 'worker:board',
          workorderAttemptId: 41,
        } as never
      );
      expect(queries.countObligatedTraceRowsSince(before)).toBe(0);

      await executor.execute(
        'report_publish',
        {
          slots: {
            pipeline: '<p>wrong attempt</p>',
            briefing: '<p>wrong attempt</p>',
            decisions: '<p>wrong attempt</p>',
            action_required: '<p>wrong attempt</p>',
          },
        } as never,
        {
          executionSurface: 'model_tool',
          source: 'operator',
          channelId: 'worker:board',
          workorderAttemptId: 40,
        } as never
      );
      expect(queries.countObligatedTraceRowsSince(before)).toBe(0);

      await expect(
        executor.execute(
          'report_publish',
          {} as never,
          {
            executionSurface: 'model_tool',
            source: 'operator',
            channelId: 'worker:board',
            workorderAttemptId: 41,
          } as never
        )
      ).rejects.toThrow(/slots object/);
      expect(queries.countObligatedTraceRowsSince(before)).toBe(0);

      executor.setReportPublisher(() => {
        throw new Error('synthetic report store failure');
      });
      await expect(
        executor.execute(
          'report_publish',
          {
            slots: {
              briefing: '<p>failed</p>',
              action_required: '<p>failed</p>',
              decisions: '<p>failed</p>',
              pipeline: '<p>failed</p>',
            },
          } as never,
          {
            executionSurface: 'model_tool',
            source: 'operator',
            channelId: 'worker:board',
            workorderAttemptId: 41,
          } as never
        )
      ).rejects.toThrow(/synthetic report store failure/);
      expect(queries.countObligatedTraceRowsSince(before)).toBe(0);

      executor.setReportPublisher(() => undefined);
      await executor.execute(
        'report_publish',
        {
          slots: {
            pipeline: '<p>pipeline secret-free fixture</p>',
            custom_extra: '<p>extra remains allowed</p>',
            briefing: '<p>briefing secret-free fixture</p>',
            decisions: '<p>decisions secret-free fixture</p>',
            action_required: '<p>action secret-free fixture</p>',
          },
        } as never,
        {
          executionSurface: 'model_tool',
          source: 'operator',
          channelId: 'worker:board',
          workorderAttemptId: 41,
        } as never
      );

      expect(queries.countObligatedTraceRowsSince(before)).toBe(1);
      const row = sessionsDb
        .prepare(
          `SELECT details FROM agent_activity
           WHERE type = 'gateway_tool_call' AND execution_status = 'completed'
             AND normalized_tool_name = 'report_publish'
             AND json_extract(details, '$.workorder_attempt_id') = 41
           ORDER BY id DESC LIMIT 1`
        )
        .get() as { details: string };
      const details = JSON.parse(row.details) as Record<string, unknown>;
      expect(details.report_slot_ids).toEqual([
        'action_required',
        'briefing',
        'custom_extra',
        'decisions',
        'pipeline',
      ]);
      expect(row.details).not.toContain('secret-free fixture');
    });

    it('TG-06 full evidence follows the real publisher persisted subset', async () => {
      const sessionsDb: SQLiteDatabase = new Database(':memory:');
      initAgentTables(sessionsDb);
      const executor = new GatewayToolExecutor({});
      executor.setSessionsDb(sessionsDb);
      executor.setTaskLedger(new TaskLedger(new Database(':memory:')));
      executor.setReportPublisher(createReportPublisher(createReportStore(), new Set()));
      const queries = buildFullBoardTraceQueries(sessionsDb, 'worker:board', 77);
      const before = queries.getTraceMaxId();
      const context = {
        executionSurface: 'model_tool' as const,
        source: 'operator' as const,
        channelId: 'worker:board',
        workorderAttemptId: 77,
      };

      const partial = await executor.execute(
        'report_publish',
        {
          slots: {
            briefing: '<p>b</p>',
            action_required: '<p>a</p>',
            decisions: '<p>d</p>',
            pipeline: 'x'.repeat(65_537),
          },
        } as never,
        context as never
      );
      expect(partial).toMatchObject({
        success: true,
        acceptedSlotIds: ['action_required', 'briefing', 'decisions'],
      });
      expect(queries.countObligatedTraceRowsSince(before)).toBe(0);

      await expect(
        executor.execute(
          'report_publish',
          {
            slots: {
              briefing: 'x'.repeat(65_537),
              action_required: 'x'.repeat(65_537),
              decisions: 'x'.repeat(65_537),
              pipeline: 'x'.repeat(65_537),
            },
          } as never,
          context as never
        )
      ).rejects.toThrow(/accepted no slots/);
      expect(queries.countObligatedTraceRowsSince(before)).toBe(0);

      const complete = await executor.execute(
        'report_publish',
        {
          slots: {
            custom_extra: '<p>x</p>',
            pipeline: '<p>p</p>',
            briefing: '<p>b</p>',
            decisions: '<p>d</p>',
            action_required: '<p>a</p>',
          },
        } as never,
        context as never
      );
      expect(complete).toMatchObject({
        success: true,
        acceptedSlotIds: ['action_required', 'briefing', 'custom_extra', 'decisions', 'pipeline'],
      });
      expect(queries.countObligatedTraceRowsSince(before)).toBe(1);
    });

    // Found in review. The executor writes a trace row on its failure paths too, so without
    // an execution_status predicate a refused mama_save counted as proof the lane saved -
    // and the promotion hook would emit memory:promoted on it.
    it('does NOT count a tool call that failed', async () => {
      const sessionsDb: SQLiteDatabase = new Database(':memory:');
      initAgentTables(sessionsDb);
      const opDb: SQLiteDatabase = new Database(':memory:');
      const executor = new GatewayToolExecutor({});
      executor.setSessionsDb(sessionsDb);
      executor.setTaskLedger(new TaskLedger(opDb));

      const queries = buildWorkerTraceQueries(sessionsDb, 'worker:board');
      const before = queries.getTraceMaxId();

      // A real refusal through the real executor: task_create with no title fails validation.
      // It rejects rather than returning success:false, and the executor logs the attempt
      // either way - which is the point. The row exists; it must not be counted.
      await expect(
        executor.execute(
          'task_create',
          {} as never,
          {
            executionSurface: 'model_tool',
            source: 'operator',
            channelId: 'worker:board',
          } as never
        )
      ).rejects.toThrow(/task title/);

      expect(queries.getTraceMaxId()).toBeGreaterThan(before);
      expect(queries.countObligatedTraceRowsSince(before)).toBe(0);
    });

    it('missing sessions db degrades to zeros (bracket reads as unverified, never throws)', () => {
      const queries = buildWorkerTraceQueries(undefined, 'worker:board');
      expect(queries.getTraceMaxId()).toBe(0);
      expect(queries.countObligatedTraceRowsSince(0)).toBe(0);
    });

    // The obligated names are interpolated into SQL rather than bound, because they are a
    // fixed list. Nothing outside this module supplies them today; this keeps that true.
    it('refuses an obligated tool name that is not a bare identifier', () => {
      expect(() =>
        buildWorkerTraceQueries(undefined, 'worker:wiki', ["x'; DROP TABLE t--"])
      ).toThrow(/invalid obligated tool name/);
    });

    it('accepts the per-lane lists the lanes actually use', () => {
      for (const tools of Object.values(LANE_OBLIGATED_TOOLS)) {
        expect(() => buildWorkerTraceQueries(undefined, 'worker:probe', tools)).not.toThrow();
      }
    });
  });

  // What the run SAID against what it DID.
  //
  // The first version of this comment claimed the wiki lane wrote nothing for 25 days, on
  // the strength of wiki_page_index being frozen since 2026-07-04. That was the wrong
  // measurement point: the lane writes through the `obsidian` tool into the vault the owner
  // has open, and it took writes minutes before this was written. What is true is narrower
  // and is what these tests hold - the hook never checked either way.
  describe('AC #2: a lane claim is reconciled against obligated-tool traces', () => {
    function tracesReturning(n: number) {
      return { getTraceMaxId: () => 0, countObligatedTraceRowsSince: () => n };
    }
    function collect(traceCount: number | null) {
      const actions: Array<{ action: string; target: string }> = [];
      const promoted: number[] = [];
      const lines: string[] = [];
      const unverified: string[] = [];
      const events = {
        emitAgentAction: (action: string, target: string) => actions.push({ action, target }),
        emitMemoryPromoted: (saved: number) => promoted.push(saved),
      };
      const hook =
        traceCount === null
          ? buildPromotionAfterHook(events)
          : buildPromotionAfterHook(events, {
              traces: tracesReturning(traceCount),
              log: (line) => lines.push(line),
              onUnverified: (note) => unverified.push(note),
            });
      return { actions, promoted, lines, unverified, hook };
    }

    // The defect this exists to stop: a run that saved nothing, said it saved three, and
    // woke the wiki compiler on the strength of the sentence.
    it('does not promote on a claim no tool trace supports', () => {
      const run = collect(0);
      run.hook(fakeWo, 'analysis complete.\nPROMOTED 3', 0);
      expect(run.promoted).toEqual([]);
      expect(run.unverified[0]).toContain('claim unsupported');
    });

    // Found in review, in the first version of this very hook. `contract_no_update` is
    // obligated so an empty run can SAY it was empty - counting it as a save reported
    // "promotion run: 1 saved" for a run that saved nothing, and that count is what wakes
    // the wiki compiler. Acting and writing are two questions.
    it('does not count an honest no-update as a save', () => {
      const actions: Array<{ action: string; target: string }> = [];
      const promoted: number[] = [];
      const lines: string[] = [];
      const hook = buildPromotionAfterHook(
        {
          emitAgentAction: (action, target) => actions.push({ action, target }),
          emitMemoryPromoted: (saved) => promoted.push(saved),
        },
        {
          // One obligated trace (the contract_no_update call), zero write traces.
          traces: { getTraceMaxId: () => 0, countObligatedTraceRowsSince: () => 1 },
          writeTraces: { getTraceMaxId: () => 0, countObligatedTraceRowsSince: () => 0 },
          log: (line) => lines.push(line),
        }
      );

      hook(fakeWo, 'NO_UPDATE', 0);

      expect(promoted).toEqual([]);
      expect(actions[0].action).toBe('no_update');
      // Still verified: the lane DID act, it just did not write.
      expect(lines[0]).toContain('verified');
    });

    it('promotes the MEASURED count, not the claimed one', () => {
      const run = collect(2);
      run.hook(fakeWo, 'PROMOTED 5', 0);
      expect(run.promoted).toEqual([2]);
      expect(run.lines[0]).toContain('CLAIM EXCEEDS TRACES');
    });

    it('a claim matched by traces is verified and promotes that count', () => {
      const run = collect(3);
      run.hook(fakeWo, 'PROMOTED 3', 0);
      expect(run.promoted).toEqual([3]);
      expect(run.lines[0]).toContain('verified');
      expect(run.unverified).toEqual([]);
    });

    // "Nothing to do" and "did nothing" have to stay distinguishable, and only a tool call
    // can tell them apart - hence contract_no_update being obligated.
    it('flags NO_UPDATE that was never recorded through a tool', () => {
      const run = collect(0);
      run.hook(fakeWo, 'NO_UPDATE', 0);
      expect(run.unverified[0]).toContain('without recording it');
      expect(run.promoted).toEqual([]);
    });

    it('says so when no trace source is wired rather than reporting a claim as measured', () => {
      const run = collect(null);
      run.hook(fakeWo, 'PROMOTED 3');
      expect(run.actions[0].target).toContain('unverified');
      expect(run.promoted).toEqual([3]);
    });
  });

  describe('AC #3: the wiki hook measures instead of reading prose', () => {
    function wikiRun(traceCount: number) {
      const lines: string[] = [];
      const unverified: string[] = [];
      const hook = buildWikiAfterHook((line) => lines.push(line), {
        traces: { getTraceMaxId: () => 0, countObligatedTraceRowsSince: () => traceCount },
        onUnverified: (note) => unverified.push(note),
      });
      return { lines, unverified, hook };
    }

    it('reports a compile nothing wrote as UNVERIFIED', () => {
      const run = wikiRun(0);
      run.hook(fakeWo, 'compiled 2 pages', 0);
      expect(run.lines[0]).toContain('UNVERIFIED');
      expect(run.unverified).toHaveLength(1);
    });

    // Deliberately NOT the word "verified": the obligated `obsidian` tool covers reads too
    // and the trace carries only its name, so the strongest honest claim is that the lane
    // exercised the vault.
    it('reports a trace-backed run as vault exercised, never as a proven write', () => {
      const run = wikiRun(1);
      run.hook(fakeWo, 'compiled 2 pages', 0);
      expect(run.lines[0]).toContain('vault exercised');
      expect(run.lines[0]).not.toContain('wrote');
      expect(run.unverified).toEqual([]);
    });
  });

  describe('AC #4: temporal hook requires a receipt verdict', () => {
    it('maps verified receipts to a required completion verdict', async () => {
      let scopedNoteMaxId = 0;
      const context = {
        attemptId: 9,
        generationKey: 'generation:9',
        taskId: 3,
        temporalEpoch: 1,
        occurrenceKey: 'due:9',
        checkAt: 9,
        revision: 2,
        sourceChannel: null,
        sourceEventId: null,
      };
      const hook = buildTemporalWorkOrderHook({
        loadTemporalWorkContext: () => context,
        getTemporalEffect: () => ({
          workorderAttemptId: 9,
          taskId: 3,
          generationKey: 'generation:9',
          occurrenceKey: 'due:9',
          outcome: 'final_no_update',
          beforeRevision: 2,
          afterRevision: 3,
          changedFields: ['temporal_reconciled_occurrence_key', 'last_temporal_attempt_id'],
          reason:
            'temporal-effect-final_no_update;reason_sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;reason_length=29;evidence_sha256=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb;evidence_length=20',
          nextTemporalCheckAt: null,
          attestationVersion: 1,
          contextPacketId: 'ctxp_workorder_hook_test',
          contextPacketSha256: 'e'.repeat(64),
          createdAt: 10,
        }),
        getTask: () =>
          ({
            id: 3,
            revision: 3,
            temporalReconciledOccurrenceKey: 'due:9',
            nextTemporalCheckAt: null,
            lastTemporalAttemptId: 9,
            lastTemporalCheckedAt: 10,
          }) as never,
        getTemporalGeneration: () =>
          ({
            generationKey: 'generation:9',
            taskId: 3,
            temporalEpoch: 1,
            occurrenceKey: 'due:9',
            checkAt: 9,
            disposition: 'final_no_update',
            lastWorkOrderId: 9,
          }) as never,
        getScopedNoteMaxId: () => scopedNoteMaxId,
      });
      const wo = { id: 9, workKind: 'temporal' } as WorkOrderRecord;
      const before = await hook.before!(wo);
      scopedNoteMaxId = 1;

      expect(hook.verdictRequired).toBe(true);
      expect(await hook.after!(wo, 'irrelevant model prose', before)).toEqual({
        disposition: 'complete',
      });
    });
  });
});
