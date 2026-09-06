/**
 * C1 regression: the wiki payload's `taskUpdatedSince` must be accepted by the
 * REAL task_list facade (runTaskListView) and filter correctly. The facade
 * rejects a numeric `updated_since` and requires an RFC 3339 string with an
 * explicit offset, so a text substring test on the contract is not enough - this
 * feeds the host-derived value into runTaskListView over a real in-memory
 * TaskLedger.
 */
import { describe, it, expect } from 'vitest';

import Database from '../../src/sqlite.js';
import { TaskLedger } from '../../src/operator/task-ledger.js';
import { runTaskListView } from '../../src/operator/task-list-views.js';
import { evaluateWikiContinuity } from '../../src/operator/wiki-continuity.js';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import { buildAgentToolExecutionContext } from '../../src/agent/agent-loop.js';

describe('wiki taskUpdatedSince against the real task_list facade', () => {
  it('is accepted by runTaskListView and filters at range.start_ms, while the numeric value is rejected', () => {
    const db = new Database(':memory:');
    try {
      // Two owner tasks, updated before and after the Asia/Seoul day boundary
      // (2026-09-04T15:00:00Z).
      let clock = Date.parse('2026-09-04T10:00:00Z');
      const ledger = new TaskLedger(db, { now: () => clock, timeZone: 'Asia/Seoul' });
      ledger.create({ title: 'early-task' }); // updated 10:00Z (before boundary)
      clock = Date.parse('2026-09-04T20:00:00Z');
      ledger.create({ title: 'late-task' }); // updated 20:00Z (after boundary)
      clock = Date.parse('2026-09-05T02:00:00Z');
      ledger.create({ title: 'at-range-end-task' });

      // A current-day run at 2026-09-05T02:00Z -> owner day 2026-09-05, start
      // 2026-09-04T15:00:00Z.
      const decision = evaluateWikiContinuity({
        nowMs: Date.parse('2026-09-05T02:00:00Z'),
        timeZone: 'Asia/Seoul',
        connectors: ['slack'],
        trigger: 'hourly',
        readSourceWatermark: () => 'w1:x',
        readBaseline: () => null,
      });
      const payload = decision.payload!;
      expect(payload.range.start_ms).toBe(Date.parse('2026-09-04T15:00:00Z'));
      expect(payload.taskUpdatedSince).toBe(new Date(payload.range.start_ms).toISOString());
      expect(payload.taskUpdatedBefore).toBe(new Date(payload.range.end_ms).toISOString());

      // The instructed call — task_list({view:"items", updated_since: <the
      // literal taskUpdatedSince string>}) — is ACCEPTED and filters correctly.
      const result = runTaskListView(
        {
          view: 'items',
          updated_since: payload.taskUpdatedSince,
          updated_before: payload.taskUpdatedBefore,
        },
        { ledger }
      );
      expect(result.success).toBe(true);
      const titles = (result as { tasks: Array<{ title: string }> }).tasks.map((t) => t.title);
      expect(titles).toContain('late-task');
      expect(titles).not.toContain('early-task');
      expect(titles).not.toContain('at-range-end-task');

      // The numeric range.start_ms the pre-fix contract instructed is REJECTED
      // by the real facade — exactly the C1 mismatch.
      expect(() =>
        runTaskListView({ view: 'items', updated_since: payload.range.start_ms }, { ledger })
      ).toThrow(/RFC 3339/);
      expect(() =>
        runTaskListView({ view: 'items', updated_before: payload.range.end_ms }, { ledger })
      ).toThrow(/RFC 3339/);
    } finally {
      db.close();
    }
  });

  it('TG-03/TG-06 enforces the exact wiki range at the gateway boundary', async () => {
    const db = new Database(':memory:');
    try {
      const ledger = new TaskLedger(db, {
        timeZone: 'Asia/Seoul',
        now: () => Date.parse('2026-08-09T00:00:00.000Z'),
      });
      ledger.create({ title: 'bounded task 1' });
      ledger.create({ title: 'bounded task 2' });
      const executor = new GatewayToolExecutor();
      executor.setTaskLedger(ledger);
      const wikiTaskRange = {
        ownerDate: '2026-08-09',
        rangeStartMs: Date.parse('2026-08-08T15:00:00.000Z'),
        rangeEndMs: Date.parse('2026-08-09T15:00:00.000Z'),
        connectors: ['slack'],
        updatedSince: '2026-08-08T15:00:00.000Z',
        updatedBefore: '2026-08-09T15:00:00.000Z',
        noUpdateScope: 'wiki:2026-08-09:test',
      };
      const context = {
        executionSurface: 'model_tool' as const,
        workorderAttemptId: 17,
        wikiTaskRange,
      };

      await expect(
        executor.execute(
          'task_list',
          {
            view: 'items',
            updated_since: wikiTaskRange.updatedSince,
            updated_before: wikiTaskRange.updatedBefore,
          },
          context
        )
      ).resolves.toMatchObject({ success: true, view: 'items' });
      const firstPage = (await executor.execute(
        'task_list',
        { view: 'items', cursor: null, limit: 1 },
        context
      )) as { success: boolean; nextCursor?: string };
      expect(firstPage).toMatchObject({ success: true, nextCursor: expect.any(String) });
      await expect(
        executor.execute(
          'task_list',
          { view: 'items', cursor: firstPage.nextCursor, limit: 1 },
          context
        )
      ).resolves.toMatchObject({ success: true, view: 'items' });
      await expect(
        executor.execute(
          'task_list',
          { view: 'items', updated_before: '2026-08-10T15:00:00.000Z' },
          context
        )
      ).rejects.toThrow(/contradict.*host-issued/i);
      await expect(
        executor.execute(
          'task_list',
          {
            view: 'detail',
            ids: [1],
            updated_since: wikiTaskRange.updatedSince,
            updated_before: wikiTaskRange.updatedBefore,
          },
          context
        )
      ).rejects.toThrow(/requires view items/i);
      await expect(
        executor.execute(
          'contract_no_update',
          { reason: 'no movement', scope: 'wiki:wrong' },
          context
        )
      ).rejects.toThrow(/exact host-issued scope/i);
      await expect(
        executor.execute(
          'contract_no_update',
          { reason: 'no movement', scope: wikiTaskRange.noUpdateScope },
          context
        )
      ).rejects.toThrow(/completed context_compile/i);
      await expect(
        executor.execute(
          'task_list',
          {},
          {
            executionSurface: 'model_tool',
            wikiTaskRange: {
              ownerDate: null,
              rangeStartMs: null,
              rangeEndMs: null,
              connectors: null,
              updatedSince: null,
              updatedBefore: null,
              noUpdateScope: null,
            },
          }
        )
      ).rejects.toThrow(/legacy input/i);
    } finally {
      db.close();
    }
  });

  it('TG-05 carries the host wiki range into every nested tool call', () => {
    const wikiTaskRange = {
      ownerDate: '2026-08-09',
      rangeStartMs: Date.parse('2026-08-08T15:00:00.000Z'),
      rangeEndMs: Date.parse('2026-08-09T15:00:00.000Z'),
      connectors: ['slack'],
      updatedSince: '2026-08-08T15:00:00.000Z',
      updatedBefore: '2026-08-09T15:00:00.000Z',
      noUpdateScope: 'wiki:2026-08-09:test',
    };
    expect(buildAgentToolExecutionContext({ wikiTaskRange })).toMatchObject({ wikiTaskRange });
  });
});
