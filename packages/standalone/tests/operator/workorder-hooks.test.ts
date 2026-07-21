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
import { TaskLedger } from '../../src/operator/task-ledger.js';
import {
  buildWorkerTraceQueries,
  buildPromotionAfterHook,
  buildTemporalWorkOrderHook,
  buildWikiAfterHook,
} from '../../src/operator/workorder-hooks.js';
import type { WorkOrderRecord } from '../../src/operator/task-ledger.js';

const fakeWo = { workKind: 'memory-curation', id: 1 } as unknown as WorkOrderRecord;

describe('Story S2-T3: extracted workorder hooks', () => {
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

    it('missing sessions db degrades to zeros (bracket reads as unverified, never throws)', () => {
      const queries = buildWorkerTraceQueries(undefined, 'worker:board');
      expect(queries.getTraceMaxId()).toBe(0);
      expect(queries.countObligatedTraceRowsSince(0)).toBe(0);
    });
  });

  describe('AC #2 (R7): promotion hook keeps the memory:promoted chain alive', () => {
    function collect() {
      const actions: Array<{ action: string; target: string }> = [];
      const promoted: number[] = [];
      const hook = buildPromotionAfterHook({
        emitAgentAction: (action, target) => actions.push({ action, target }),
        emitMemoryPromoted: (saved) => promoted.push(saved),
      });
      return { actions, promoted, hook };
    }

    it('PROMOTED <n> emits memory:promoted with the count', () => {
      const { actions, promoted, hook } = collect();
      hook(fakeWo, 'analysis complete.\nPROMOTED 3');
      expect(promoted).toEqual([3]);
      expect(actions).toEqual([{ action: 'promoted', target: 'promotion run: 3 saved' }]);
    });

    it('NO_UPDATE (and PROMOTED 0) emit NO memory:promoted', () => {
      const { actions, promoted, hook } = collect();
      hook(fakeWo, 'NO_UPDATE');
      hook(fakeWo, 'PROMOTED 0');
      expect(promoted).toEqual([]);
      expect(actions.every((a) => a.action === 'no_update')).toBe(true);
    });
  });

  describe('AC #3: wiki hook reads the outcome', () => {
    it('distinguishes NO_UPDATE from a completed compile', () => {
      const lines: string[] = [];
      const hook = buildWikiAfterHook((line) => lines.push(line));
      hook(fakeWo, 'NO_UPDATE');
      hook(fakeWo, 'compiled 2 pages');
      expect(lines[0]).toContain('no changes');
      expect(lines[1]).toContain('complete');
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
