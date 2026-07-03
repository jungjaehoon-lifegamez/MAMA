import { describe, expect, it, vi } from 'vitest';

process.env.MAMA_FORCE_TIER_3 ||= 'true';

import type { SQLiteDatabase } from '../../src/sqlite.js';
import { PrimaryOperatorRuntime } from '../../src/operator-vnext/primary-operator-runtime.js';
import { countRows, makeOperatorVNextDb } from './fixtures.js';

function lastCursorSeq(db: SQLiteDatabase, cursorName = 'connector:slack'): number {
  const row = db
    .prepare('SELECT last_change_seq FROM vnext_operator_cursors WHERE cursor_name = ?')
    .get(cursorName) as { last_change_seq: number } | undefined;
  return row?.last_change_seq ?? 0;
}

function waitOneTurn(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

describe('STORY-VNEXT-PR2-PRIMARY-OPERATOR: primary operator commit shell', () => {
  describe('AC: only delivered changed/no-update decisions advance the cursor', () => {
    it('advances only the contiguous prefix before a channel failure', async () => {
      const db = makeOperatorVNextDb();
      const runtime = new PrimaryOperatorRuntime({
        db,
        cursorName: 'connector:slack',
        connector: 'slack',
        nowMs: () => 1710000000000,
      });

      const result = await runtime.processBatch(
        [
          { seq: 1, sourceRef: { kind: 'raw', connector: 'slack', id: 'event-1' } },
          { seq: 2, sourceRef: { kind: 'raw', connector: 'slack', id: 'event-2' } },
          { seq: 3, sourceRef: { kind: 'raw', connector: 'slack', id: 'event-3' } },
        ],
        async (event) => {
          if (event.seq === 3) {
            throw new Error('worker failed');
          }
          return {
            status: 'no_update',
            reason: `event ${event.seq} did not change state`,
            scopeKey: 'connector:slack',
          };
        }
      );

      expect(result).toMatchObject({
        status: 'partial_failure',
        processed: 2,
        advancedThroughSeq: 2,
        failedSeq: 3,
      });
      expect(lastCursorSeq(db)).toBe(2);
      expect(db.prepare('SELECT COUNT(*) AS count FROM operator_no_updates').get()).toEqual({
        count: 2,
      });

      db.close();
    });

    it('treats model output without changed or no-update as a failed commit', async () => {
      const db = makeOperatorVNextDb();
      const runtime = new PrimaryOperatorRuntime({
        db,
        cursorName: 'connector:slack',
        connector: 'slack',
        nowMs: () => 1710000000000,
      });

      const result = await runtime.processBatch(
        [{ seq: 1, sourceRef: { kind: 'raw', connector: 'slack', id: 'event-1' } }],
        async () => ({ message: 'looks fine' }) as never
      );

      expect(result).toMatchObject({
        status: 'partial_failure',
        processed: 0,
        advancedThroughSeq: 0,
        failedSeq: 1,
      });
      expect(lastCursorSeq(db)).toBe(0);

      db.close();
    });

    it('commits changed decisions through the primary operator only', async () => {
      const db = makeOperatorVNextDb();
      const runtime = new PrimaryOperatorRuntime({
        db,
        cursorName: 'connector:slack',
        connector: 'slack',
        nowMs: () => 1710000000000,
      });

      const result = await runtime.processBatch(
        [{ seq: 1, sourceRef: { kind: 'raw', connector: 'slack', id: 'event-1' } }],
        async () => ({
          status: 'changed',
          changedRefs: [{ kind: 'os_task', id: 'task-1' }],
        })
      );

      expect(result).toMatchObject({
        status: 'committed',
        processed: 1,
        advancedThroughSeq: 1,
      });
      expect(
        db.prepare('SELECT status, changed_refs_json FROM vnext_operator_commits').get()
      ).toEqual({
        status: 'changed',
        changed_refs_json: '["os_task:task-1"]',
      });

      db.close();
    });

    it('ignores model-supplied supplemental source refs', async () => {
      const db = makeOperatorVNextDb();
      const runtime = new PrimaryOperatorRuntime({
        db,
        cursorName: 'connector:slack',
        connector: 'slack',
        nowMs: () => 1710000000000,
      });

      const result = await runtime.processBatch(
        [{ seq: 1, sourceRef: { kind: 'raw', connector: 'slack', id: 'event-1' } }],
        async () => ({
          status: 'changed',
          changedRefs: [{ kind: 'os_task', id: 'task-1' }],
          sourceRefs: [{ kind: 'memory', id: 'memory-1' }],
        })
      );

      expect(result.status).toBe('committed');
      expect(db.prepare('SELECT source_refs_json FROM vnext_operator_commits').get()).toEqual({
        source_refs_json: '["raw:slack:event-1"]',
      });

      db.close();
    });

    it('rejects raw event source refs from a different connector before cursor advancement', async () => {
      const db = makeOperatorVNextDb();
      const runtime = new PrimaryOperatorRuntime({
        db,
        cursorName: 'connector:slack',
        connector: 'slack',
        nowMs: () => 1710000000000,
      });

      const result = await runtime.processBatch(
        [{ seq: 1, sourceRef: { kind: 'raw', connector: 'discord', id: 'event-1' } }],
        async () => ({
          status: 'changed',
          changedRefs: [{ kind: 'os_task', id: 'task-1' }],
        })
      );

      expect(result).toMatchObject({
        status: 'partial_failure',
        processed: 0,
        advancedThroughSeq: 0,
        failedSeq: 1,
      });
      expect(result.error.message).toMatch(/connector mismatch/i);
      expect(lastCursorSeq(db)).toBe(0);
      expect(countRows(db, 'vnext_operator_commits')).toBe(0);

      db.close();
    });

    it('rejects non-raw event source refs before cursor advancement', async () => {
      const db = makeOperatorVNextDb();
      const runtime = new PrimaryOperatorRuntime({
        db,
        cursorName: 'connector:slack',
        connector: 'slack',
        nowMs: () => 1710000000000,
      });

      const result = await runtime.processBatch(
        [{ seq: 1, sourceRef: { kind: 'memory', id: 'memory-1' } }],
        async () => ({
          status: 'changed',
          changedRefs: [{ kind: 'os_task', id: 'task-1' }],
        })
      );

      expect(result).toMatchObject({
        status: 'partial_failure',
        processed: 0,
        advancedThroughSeq: 0,
        failedSeq: 1,
      });
      expect(result.error.message).toMatch(/raw source ref/i);
      expect(lastCursorSeq(db)).toBe(0);
      expect(countRows(db, 'vnext_operator_commits')).toBe(0);

      db.close();
    });

    it('rejects no-update scope keys that do not match the runtime cursor', async () => {
      const db = makeOperatorVNextDb();
      const runtime = new PrimaryOperatorRuntime({
        db,
        cursorName: 'connector:slack',
        connector: 'slack',
        nowMs: () => 1710000000000,
      });

      const result = await runtime.processBatch(
        [{ seq: 1, sourceRef: { kind: 'raw', connector: 'slack', id: 'event-1' } }],
        async () => ({
          status: 'no_update',
          reason: 'event did not change state',
          scopeKey: 'connector:discord',
        })
      );

      expect(result).toMatchObject({
        status: 'partial_failure',
        processed: 0,
        advancedThroughSeq: 0,
        failedSeq: 1,
      });
      expect(result.error.message).toMatch(/scopeKey/i);
      expect(lastCursorSeq(db)).toBe(0);

      db.close();
    });

    it('rejects non-contiguous events before invoking the decider', async () => {
      const db = makeOperatorVNextDb();
      const runtime = new PrimaryOperatorRuntime({
        db,
        cursorName: 'connector:slack',
        connector: 'slack',
        nowMs: () => 1710000000000,
      });
      const decide = vi.fn(() => ({
        status: 'changed',
        changedRefs: [{ kind: 'os_task', id: 'task-2' }],
      }));

      const result = await runtime.processBatch(
        [{ seq: 2, sourceRef: { kind: 'raw', connector: 'slack', id: 'event-2' } }],
        decide
      );

      expect(result).toMatchObject({
        status: 'partial_failure',
        processed: 0,
        advancedThroughSeq: 0,
        failedSeq: 2,
      });
      expect(result.error.message).toMatch(/contiguous/i);
      expect(decide).not.toHaveBeenCalled();
      expect(lastCursorSeq(db)).toBe(0);
      expect(countRows(db, 'vnext_operator_commits')).toBe(0);

      db.close();
    });

    it('does not regress advancedThroughSeq when replaying an already committed event', async () => {
      const db = makeOperatorVNextDb();
      const runtime = new PrimaryOperatorRuntime({
        db,
        cursorName: 'connector:slack',
        connector: 'slack',
        nowMs: () => 1710000000000,
      });

      const first = await runtime.processBatch(
        [
          { seq: 1, sourceRef: { kind: 'raw', connector: 'slack', id: 'event-1' } },
          { seq: 2, sourceRef: { kind: 'raw', connector: 'slack', id: 'event-2' } },
        ],
        async (event) => ({
          status: 'changed',
          changedRefs: [{ kind: 'os_task', id: `task-${event.seq}` }],
        })
      );
      expect(first).toMatchObject({
        status: 'committed',
        processed: 2,
        advancedThroughSeq: 2,
      });

      const replayDecide = vi.fn(() => ({
        status: 'changed',
        changedRefs: [{ kind: 'os_task', id: 'task-1' }],
      }));

      const replay = await runtime.processBatch(
        [{ seq: 1, sourceRef: { kind: 'raw', connector: 'slack', id: 'event-1' } }],
        replayDecide
      );

      expect(replay).toMatchObject({
        status: 'committed',
        processed: 1,
        advancedThroughSeq: 2,
      });
      expect(replay.commits[0]?.outcome).toBe('already_committed');
      expect(replayDecide).not.toHaveBeenCalled();
      expect(lastCursorSeq(db)).toBe(2);

      db.close();
    });

    it('recovers an orphaned stored commit without calling the decider', async () => {
      const db = makeOperatorVNextDb();
      db.prepare(
        `INSERT INTO vnext_operator_cursors (
          cursor_name, last_change_seq, last_idempotency_key, updated_at_ms
        ) VALUES (?, ?, ?, ?)`
      ).run('connector:slack', 0, null, 1710000000000);
      db.prepare(
        `INSERT INTO vnext_operator_commits (
          commit_id, cursor_name, idempotency_key, first_change_seq, last_change_seq,
          status, changed_refs_json, source_refs_json, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'commit-orphaned',
        'connector:slack',
        'cursor:connector:slack:seq:1-1',
        1,
        1,
        'changed',
        '["os_task:task-1"]',
        '["raw:slack:event-1"]',
        1710000000000
      );
      const runtime = new PrimaryOperatorRuntime({
        db,
        cursorName: 'connector:slack',
        connector: 'slack',
        nowMs: () => 1710000000001,
      });
      const decide = vi.fn(() => {
        throw new Error('decider must not run');
      });

      const result = await runtime.processBatch(
        [{ seq: 1, sourceRef: { kind: 'raw', connector: 'slack', id: 'event-1' } }],
        decide
      );

      expect(result).toMatchObject({
        status: 'committed',
        processed: 1,
        advancedThroughSeq: 1,
      });
      expect(result.commits[0]?.outcome).toBe('recovered');
      expect(decide).not.toHaveBeenCalled();
      expect(lastCursorSeq(db)).toBe(1);

      db.close();
    });

    it('recovers legacy connector-scoped idempotency keys before invoking the decider', async () => {
      const db = makeOperatorVNextDb();
      db.prepare(
        `INSERT INTO vnext_operator_cursors (
          cursor_name, last_change_seq, last_idempotency_key, updated_at_ms
        ) VALUES (?, ?, ?, ?)`
      ).run('connector:slack', 0, null, 1710000000000);
      db.prepare(
        `INSERT INTO vnext_operator_commits (
          commit_id, cursor_name, idempotency_key, first_change_seq, last_change_seq,
          status, changed_refs_json, source_refs_json, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'commit-legacy-key',
        'connector:slack',
        'connector:slack:seq:1-1',
        1,
        1,
        'changed',
        '["os_task:task-1"]',
        '["raw:slack:event-1"]',
        1710000000000
      );
      const runtime = new PrimaryOperatorRuntime({
        db,
        cursorName: 'connector:slack',
        connector: 'slack',
        nowMs: () => 1710000000001,
      });
      const decide = vi.fn(() => {
        throw new Error('decider must not run');
      });

      const result = await runtime.processBatch(
        [{ seq: 1, sourceRef: { kind: 'raw', connector: 'slack', id: 'event-1' } }],
        decide
      );

      expect(result).toMatchObject({
        status: 'committed',
        processed: 1,
        advancedThroughSeq: 1,
      });
      expect(result.commits[0]).toMatchObject({
        outcome: 'recovered',
        idempotencyKey: 'connector:slack:seq:1-1',
      });
      expect(decide).not.toHaveBeenCalled();
      expect(lastCursorSeq(db)).toBe(1);

      db.close();
    });

    it('rejects recovered commits with mismatched raw source provenance before invoking the decider', async () => {
      const db = makeOperatorVNextDb();
      db.prepare(
        `INSERT INTO vnext_operator_cursors (
          cursor_name, last_change_seq, last_idempotency_key, updated_at_ms
        ) VALUES (?, ?, ?, ?)`
      ).run('connector:slack', 0, null, 1710000000000);
      db.prepare(
        `INSERT INTO vnext_operator_commits (
          commit_id, cursor_name, idempotency_key, first_change_seq, last_change_seq,
          status, changed_refs_json, source_refs_json, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'commit-orphaned',
        'connector:slack',
        'cursor:connector:slack:seq:1-1',
        1,
        1,
        'changed',
        '["os_task:task-1"]',
        '["raw:slack:event-1"]',
        1710000000000
      );
      const runtime = new PrimaryOperatorRuntime({
        db,
        cursorName: 'connector:slack',
        connector: 'slack',
        nowMs: () => 1710000000001,
      });
      const decide = vi.fn(() => {
        throw new Error('decider must not run');
      });

      const result = await runtime.processBatch(
        [{ seq: 1, sourceRef: { kind: 'raw', connector: 'slack', id: 'event-tampered' } }],
        decide
      );

      expect(result).toMatchObject({
        status: 'partial_failure',
        processed: 0,
        advancedThroughSeq: 0,
        failedSeq: 1,
      });
      expect(result.error.message).toMatch(/source refs/i);
      expect(decide).not.toHaveBeenCalled();
      expect(lastCursorSeq(db)).toBe(0);

      db.close();
    });

    it('serializes concurrent batches for the same cursor before invoking the decider', async () => {
      const db = makeOperatorVNextDb();
      const firstRuntime = new PrimaryOperatorRuntime({
        db,
        cursorName: 'connector:slack',
        connector: 'slack',
        nowMs: () => 1710000000000,
      });
      const secondRuntime = new PrimaryOperatorRuntime({
        db,
        cursorName: 'connector:slack',
        connector: 'slack',
        nowMs: () => 1710000000001,
      });
      let releaseDecision!: () => void;
      const decisionGate = new Promise<void>((resolve) => {
        releaseDecision = resolve;
      });
      const decide = vi.fn(async () => {
        await decisionGate;
        return {
          status: 'changed',
          changedRefs: [{ kind: 'os_task', id: 'task-1' }],
        };
      });

      const first = firstRuntime.processBatch(
        [{ seq: 1, sourceRef: { kind: 'raw', connector: 'slack', id: 'event-1' } }],
        decide
      );
      const second = secondRuntime.processBatch(
        [{ seq: 1, sourceRef: { kind: 'raw', connector: 'slack', id: 'event-1' } }],
        decide
      );
      await waitOneTurn();

      expect(decide).toHaveBeenCalledTimes(1);
      releaseDecision();
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult.commits[0]?.outcome).toBe('committed');
      expect(secondResult.commits[0]?.outcome).toBe('already_committed');
      expect(decide).toHaveBeenCalledTimes(1);
      expect(lastCursorSeq(db)).toBe(1);
      expect(countRows(db, 'vnext_operator_commits')).toBe(1);

      db.close();
    });

    it('rejects allowed-status decisions that omit required payload fields', async () => {
      const changedDb = makeOperatorVNextDb();
      const changedRuntime = new PrimaryOperatorRuntime({
        db: changedDb,
        cursorName: 'connector:slack',
        connector: 'slack',
        nowMs: () => 1710000000000,
      });

      const changedResult = await changedRuntime.processBatch(
        [{ seq: 1, sourceRef: { kind: 'raw', connector: 'slack', id: 'event-1' } }],
        async () => ({ status: 'changed' })
      );
      expect(changedResult).toMatchObject({
        status: 'partial_failure',
        processed: 0,
        advancedThroughSeq: 0,
        failedSeq: 1,
      });
      expect(lastCursorSeq(changedDb)).toBe(0);
      changedDb.close();

      const noUpdateDb = makeOperatorVNextDb();
      const noUpdateRuntime = new PrimaryOperatorRuntime({
        db: noUpdateDb,
        cursorName: 'connector:slack',
        connector: 'slack',
        nowMs: () => 1710000000000,
      });

      const noUpdateResult = await noUpdateRuntime.processBatch(
        [{ seq: 1, sourceRef: { kind: 'raw', connector: 'slack', id: 'event-1' } }],
        async () => ({ status: 'no_update', reason: '   ' })
      );
      expect(noUpdateResult).toMatchObject({
        status: 'partial_failure',
        processed: 0,
        advancedThroughSeq: 0,
        failedSeq: 1,
      });
      expect(lastCursorSeq(noUpdateDb)).toBe(0);
      noUpdateDb.close();
    });

    it('returns idle for an empty batch without calling the decider', async () => {
      const db = makeOperatorVNextDb();
      const runtime = new PrimaryOperatorRuntime({
        db,
        cursorName: 'connector:slack',
        connector: 'slack',
        nowMs: () => 1710000000000,
      });
      await runtime.processBatch(
        [{ seq: 1, sourceRef: { kind: 'raw', connector: 'slack', id: 'event-1' } }],
        async () => ({
          status: 'changed',
          changedRefs: [{ kind: 'os_task', id: 'task-1' }],
        })
      );
      const decide = vi.fn();

      const result = await runtime.processBatch([], decide);

      expect(result).toEqual({
        status: 'idle',
        processed: 0,
        advancedThroughSeq: 1,
        commits: [],
      });
      expect(decide).not.toHaveBeenCalled();

      db.close();
    });
  });
});
