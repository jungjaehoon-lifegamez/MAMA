/**
 * Story S2-T4 (review round 1): executor-surface behavior of the Stage-2
 * additions - capture-override precedence at report_publish, and the
 * workorder_request/workorder_status cases.
 * Plan: docs/superpowers/plans/2026-07-18-stage2-workorder-ownership.md
 */
import { describe, it, expect } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import { TaskLedger } from '../../src/operator/task-ledger.js';

describe('Story S2-T4: executor surface', () => {
  describe('AC #1: report_publish override precedence - capture runs never touch the live store', () => {
    it('a per-call override receives the slots; the live publisher is untouched', async () => {
      const executor = new GatewayToolExecutor({});
      const liveCalls: unknown[] = [];
      const captureCalls: unknown[] = [];
      executor.setReportPublisher((slots) => void liveCalls.push(slots));

      const result = (await executor.execute(
        'report_publish',
        { slots: { briefing: '<p>x</p>' } } as never,
        {
          executionSurface: 'model_tool',
          reportPublisherOverride: (slots: Record<string, string>) => void captureCalls.push(slots),
        } as never
      )) as { success?: boolean };

      expect(result.success).toBe(true);
      expect(captureCalls).toHaveLength(1);
      expect(liveCalls).toHaveLength(0);
    });

    it('without an override the live publisher still receives publishes', async () => {
      const executor = new GatewayToolExecutor({});
      const liveCalls: unknown[] = [];
      executor.setReportPublisher((slots) => void liveCalls.push(slots));
      await executor.execute(
        'report_publish',
        { slots: { briefing: 'y' } } as never,
        {
          executionSurface: 'model_tool',
        } as never
      );
      expect(liveCalls).toHaveLength(1);
    });
  });

  describe('AC #2: workorder_request - validation, disabled path, ack-only', () => {
    it('rejects unknown kinds before reaching any handler', async () => {
      const executor = new GatewayToolExecutor({});
      const result = (await executor.execute(
        'workorder_request',
        { kind: 'reports' } as never,
        {
          executionSurface: 'model_tool',
        } as never
      )) as { success?: boolean; code?: string };
      expect(result.success).toBe(false);
      expect(result.code).toBe('invalid_workorder_kind');
    });

    it('answers with a typed error when the machinery is disabled', async () => {
      const executor = new GatewayToolExecutor({});
      const result = (await executor.execute(
        'workorder_request',
        { kind: 'board' } as never,
        {
          executionSurface: 'model_tool',
        } as never
      )) as { success?: boolean; code?: string };
      expect(result.success).toBe(false);
      expect(result.code).toBe('workorder_machinery_disabled');
    });

    it('acks synchronously through the handler and surfaces handler rejection reasons', async () => {
      const executor = new GatewayToolExecutor({});
      const requested: string[] = [];
      executor.setWorkOrderRequestHandler((kind) => {
        requested.push(kind);
        return kind === 'board'
          ? { accepted: true }
          : { accepted: false, reason: 'shadow-board-only' };
      });

      const ok = (await executor.execute(
        'workorder_request',
        { kind: 'board' } as never,
        {
          executionSurface: 'model_tool',
        } as never
      )) as { success?: boolean; message?: string };
      expect(ok.success).toBe(true);
      expect(ok.message).toContain('do not wait');

      const rejected = (await executor.execute(
        'workorder_request',
        { kind: 'wiki' } as never,
        {
          executionSurface: 'model_tool',
        } as never
      )) as { success?: boolean; code?: string };
      expect(rejected.success).toBe(false);
      expect(rejected.code).toBe('workorder_shadow-board-only');
      expect(requested).toEqual(['board', 'wiki']);
    });
  });

  describe('AC #3: workorder_status - per-kind stats passthrough', () => {
    it('returns ledger stats; unavailable ledger answers with a typed error', async () => {
      const bare = new GatewayToolExecutor({});
      const noLedger = (await bare.execute(
        'workorder_status',
        {} as never,
        {
          executionSurface: 'model_tool',
        } as never
      )) as { success?: boolean; code?: string };
      expect(noLedger.success).toBe(false);
      expect(noLedger.code).toBe('ledger_unavailable');

      const db: SQLiteDatabase = new Database(':memory:');
      const ledger = new TaskLedger(db);
      const wo = ledger.enqueueWorkOrder({
        workKind: 'wiki',
        idempotencyKey: 'w-1',
        input: { batchId: 'b', events: [] },
      });
      ledger.claimNextWorkOrder();
      ledger.failWorkOrder(wo.id, 'brief missing');

      const executor = new GatewayToolExecutor({});
      executor.setTaskLedger(ledger);
      const result = (await executor.execute(
        'workorder_status',
        {} as never,
        {
          executionSurface: 'model_tool',
        } as never
      )) as {
        success?: boolean;
        data?: { kinds: Array<{ workKind: string; failedCount: number }> };
      };
      expect(result.success).toBe(true);
      const wiki = result.data?.kinds.find((k) => k.workKind === 'wiki');
      expect(wiki?.failedCount).toBe(1);
    });
  });
});
