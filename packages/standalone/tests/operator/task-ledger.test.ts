/**
 * Unit tests for TaskLedger (M8 Task 0.1) - the operator-owned native work-item
 * ledger. Synthetic data only; in-memory sqlite.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { TaskLedger } from '../../src/operator/task-ledger.js';

describe('TaskLedger', () => {
  let db: SQLiteDatabase;
  let ledger: TaskLedger;

  beforeEach(() => {
    db = new Database(':memory:');
    ledger = new TaskLedger(db);
  });

  it('creates a task with defaults (pending, normal, auto_created, unconfirmed)', () => {
    const t = ledger.create({ title: 'ship the widget' });
    expect(t.id).toBeGreaterThan(0);
    expect(t.status).toBe('pending');
    expect(t.priority).toBe('normal');
    expect(t.autoCreated).toBe(true);
    expect(t.confirmed).toBe(false);
    expect(t.deadline).toBeNull();
  });

  it('counts only open auto-created unconfirmed tasks', () => {
    ledger.create({ title: 'open unconfirmed' });
    ledger.create({ title: 'open confirmed', confirmed: true });
    ledger.create({ title: 'done unconfirmed', status: 'done' });
    ledger.create({ title: 'cancelled unconfirmed', status: 'cancelled' });

    expect(ledger.countOpenUnconfirmed()).toBe(1);
  });

  it('rejects invalid status and priority via CHECK', () => {
    expect(() => ledger.create({ title: 'x', status: 'doing' as never })).toThrow();
    expect(() => ledger.create({ title: 'x', priority: 'urgent' as never })).toThrow();
  });

  it('rejects empty titles and malformed deadlines', () => {
    expect(() => ledger.create({ title: '  ' })).toThrow(/title/);
    expect(() => ledger.create({ title: 'x', deadline: 'next friday' })).toThrow(/ISO date/);
    expect(() => ledger.create({ title: 'x', deadline: '2026-13-99' })).toThrow(/ISO date/);
    expect(() => ledger.create({ title: 'x', deadline: '2026-02-30' })).toThrow(/ISO date/);
  });

  it('maps ISO deadline to UTC-midnight epoch ms for the OperatorTask interface', () => {
    const t = ledger.create({ title: 'x', deadline: '2026-07-20' });
    expect(t.deadlineIso).toBe('2026-07-20');
    expect(t.deadline).toBe(Date.parse('2026-07-20T00:00:00Z'));
  });

  it('upserts on duplicate (source_channel, source_event_id) instead of duplicating', () => {
    const first = ledger.create({
      title: 'review the still',
      source_channel: 'slack:C001',
      source_event_id: 'ev-1',
      latest_event: 'submitted v1',
    });
    const second = ledger.create({
      title: 'review the still (retry wording)',
      source_channel: 'slack:C001',
      source_event_id: 'ev-1',
      latest_event: 'submitted v2',
    });
    expect(second.id).toBe(first.id);
    expect(second.title).toBe('review the still'); // original title kept
    expect(second.latestEvent).toBe('submitted v2'); // movement recorded
    expect(ledger.list({ channel: 'slack:C001' })).toHaveLength(1);
  });

  it('same event id on a DIFFERENT channel is a distinct task', () => {
    ledger.create({ title: 'a', source_channel: 'slack:C001', source_event_id: 'ev-1' });
    ledger.create({ title: 'b', source_channel: 'chatwork:123', source_event_id: 'ev-1' });
    expect(ledger.list({})).toHaveLength(2);
  });

  it('update patches fields and bumps updated_at; unknown id throws', () => {
    const t = ledger.create({ title: 'x' });
    const updated = ledger.update(t.id, {
      status: 'in_progress',
      assignee: 'worker-a',
      deadline: '2026-08-01',
      confirmed: true,
    });
    expect(updated.status).toBe('in_progress');
    expect(updated.assignee).toBe('worker-a');
    expect(updated.deadlineIso).toBe('2026-08-01');
    expect(updated.confirmed).toBe(true);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(t.updatedAt);
    expect(() => ledger.update(9999, { status: 'done' })).toThrow(/no task/);
  });

  it('deadline can be cleared with null', () => {
    const t = ledger.create({ title: 'x', deadline: '2026-08-01' });
    const cleared = ledger.update(t.id, { deadline: null });
    expect(cleared.deadlineIso).toBeNull();
    expect(cleared.deadline).toBeNull();
  });

  it('assignee can be cleared with null', () => {
    const t = ledger.create({ title: 'x', assignee: 'worker-a' });
    const cleared = ledger.update(t.id, { assignee: null });
    expect(cleared.assignee).toBeNull();
  });

  it('deadline_priority ordering: deadline asc nulls last, then priority, LIMIT after order', () => {
    ledger.create({ title: 'no-deadline-high', priority: 'high' });
    ledger.create({ title: 'late-low', deadline: '2026-09-01', priority: 'low' });
    ledger.create({ title: 'soon-normal', deadline: '2026-07-15', priority: 'normal' });
    ledger.create({ title: 'soon-high', deadline: '2026-07-15', priority: 'high' });
    const top2 = ledger.list({ order: 'deadline_priority', limit: 2 });
    // The true top-2 by (deadline, priority) - NOT insertion order.
    expect(top2.map((t) => t.title)).toEqual(['soon-high', 'soon-normal']);
    const all = ledger.list({ order: 'deadline_priority' });
    expect(all[all.length - 1]?.title).toBe('no-deadline-high'); // nulls last
  });

  it('filters: status, channel, search', () => {
    ledger.create({ title: 'alpha work', status: 'review', source_channel: 'slack:C1' });
    ledger.create({ title: 'beta work', assignee: 'worker-b' });
    expect(ledger.list({ status: 'review' })).toHaveLength(1);
    expect(ledger.list({ channel: 'slack:C1' })).toHaveLength(1);
    expect(ledger.list({ search: 'worker-b' })).toHaveLength(1);
    expect(ledger.list({ search: 'alpha' })[0]?.title).toBe('alpha work');
  });

  it('getTasks() satisfies TaskSource with canonical ordering', () => {
    ledger.create({ title: 'b', deadline: '2026-08-01' });
    ledger.create({ title: 'a', deadline: '2026-07-15' });
    const tasks = ledger.getTasks();
    expect(tasks[0]?.title).toBe('a');
    expect(typeof tasks[0]?.deadline).toBe('number'); // OperatorTask numeric contract
  });

  it('payloadHash changes on mutation and is stable otherwise', () => {
    const t = ledger.create({ title: 'x' });
    const h1 = ledger.payloadHash();
    expect(ledger.payloadHash()).toBe(h1);
    ledger.update(t.id, { status: 'done' });
    expect(ledger.payloadHash()).not.toBe(h1);
  });

  it('no-update notes: record + scoped max id', () => {
    expect(ledger.maxNoUpdateId()).toBe(0);
    const a = ledger.recordNoUpdate('reconcile:slack:C1', 'greeting only');
    ledger.recordNoUpdate('reconcile:chatwork:9', 'bot chatter');
    expect(ledger.maxNoUpdateId('reconcile:slack:C1')).toBe(a.id);
    expect(ledger.maxNoUpdateId()).toBeGreaterThan(a.id);
    expect(() => ledger.recordNoUpdate('', 'x')).toThrow(/scope/);
  });
});

/**
 * Story S2-T1: workorder extension of the ledger (Stage 2).
 * Plan: docs/superpowers/plans/2026-07-18-stage2-workorder-ownership.md
 */
describe('Story S2-T1: TaskLedger workorder extension', () => {
  let db: SQLiteDatabase;
  let ledger: TaskLedger;

  beforeEach(() => {
    db = new Database(':memory:');
    ledger = new TaskLedger(db);
  });

  describe('AC #1: migration is idempotent and upgrades legacy schemas safely', () => {
    it('double construction on the same db is harmless', () => {
      ledger.create({ title: 'owner task' });
      const again = new TaskLedger(db);
      expect(again.list()).toHaveLength(1);
    });

    it('upgrades a pre-Stage2 table: columns, failed CHECK, sequence, index predicate', () => {
      const legacy = new Database(':memory:');
      legacy.exec(`
        CREATE TABLE operator_tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending','in_progress','review','blocked','done','cancelled')),
          priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('high','normal','low')),
          assignee TEXT,
          deadline TEXT,
          source_channel TEXT,
          source_event_id TEXT,
          latest_event TEXT,
          auto_created INTEGER NOT NULL DEFAULT 1,
          confirmed INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX idx_operator_tasks_source
          ON operator_tasks(source_channel, source_event_id)
          WHERE source_event_id IS NOT NULL;
        INSERT INTO operator_tasks (title, created_at, updated_at) VALUES ('old row', 1, 1);
      `);
      const upgraded = new TaskLedger(legacy);

      // Old row survives with kind defaulted to owner; id sequence preserved.
      const rows = upgraded.list();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.kind).toBe('owner');
      const next = upgraded.create({ title: 'new row' });
      expect(next.id).toBeGreaterThan(rows[0]!.id);

      // 'failed' is accepted by the rebuilt CHECK (via the internal workorder path).
      const wo = upgraded.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'board:full:slot-1',
        input: {},
      });
      upgraded.claimNextWorkOrder();
      upgraded.failWorkOrder(wo.id, 'test-fail');

      // Terminal keyed row frees the slot (new index predicate) - fresh insert works.
      const again = upgraded.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'board:full:slot-1',
        input: {},
      });
      expect(again.id).not.toBe(wo.id);
    });
  });

  describe('AC #2: kind filters hide system rows from every owner surface', () => {
    it('list/getById/countOpenUnconfirmed/payloadHash exclude system workorders', () => {
      const owner = ledger.create({ title: 'owner task' });
      const hashBefore = ledger.payloadHash();
      const wo = ledger.enqueueWorkOrder({
        workKind: 'wiki',
        idempotencyKey: 'wiki:batch-1',
        input: { events: [] },
      });

      expect(ledger.list().map((t) => t.id)).toEqual([owner.id]);
      expect(ledger.getById(wo.id)).toBeNull();
      expect(ledger.countOpenUnconfirmed()).toBe(1);
      expect(ledger.payloadHash()).toBe(hashBefore); // system enqueue must not shake the hash
      expect(ledger.getTasks()).toHaveLength(1);
    });
  });

  describe('AC #3: tamper guards on all four mutation paths', () => {
    it('external update cannot touch a system row', () => {
      const wo = ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'board:full:slot-2',
        input: {},
      });
      expect(() => ledger.update(wo.id, { status: 'done' })).toThrow(/system workorder/);
    });

    it("external create/update reject the system-only 'failed' status", () => {
      const t = ledger.create({ title: 'owner' });
      expect(() => ledger.update(t.id, { status: 'failed' as never })).toThrow(/system-only/);
      expect(() => ledger.create({ title: 'x', status: 'failed' as never })).toThrow(/system-only/);
    });

    it('owner upsert probe cannot reach a system row (kind-scoped SELECT)', () => {
      ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'key-shared',
        input: {},
      });
      // Same (channel, event) pair from the external surface: probe misses the
      // system row and the unique index rejects the insert - loud, not silent.
      expect(() =>
        ledger.create({
          title: 'imposter',
          source_channel: 'workorder:board',
          source_event_id: 'key-shared',
        })
      ).toThrow();
    });
  });

  describe('AC #4: workorder API - dedup, claim ordering, transitions, cleanup', () => {
    it('dedups open keyed rows, reinserts after terminal', () => {
      const a = ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'board:full:0800',
        input: { mode: 'full' },
      });
      const dup = ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'board:full:0800',
        input: { mode: 'full' },
      });
      expect(dup.id).toBe(a.id);

      ledger.claimNextWorkOrder();
      ledger.completeWorkOrder(a.id);
      const fresh = ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'board:full:0800',
        input: { mode: 'full' },
      });
      expect(fresh.id).not.toBe(a.id);
      expect(fresh.payload.attempts).toBe(1);
    });

    it('claims priority high>normal>low then id ASC (CASE, not lexicographic)', () => {
      const low = ledger.enqueueWorkOrder({
        workKind: 'wiki',
        idempotencyKey: 'w-low',
        input: {},
        priority: 'low',
      });
      const normal = ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'b-normal',
        input: {},
      });
      const high = ledger.enqueueWorkOrder({
        workKind: 'memory-curation',
        idempotencyKey: 'm-high',
        input: {},
        priority: 'high',
      });

      expect(ledger.claimNextWorkOrder()?.id).toBe(high.id);
      expect(ledger.claimNextWorkOrder()?.id).toBe(normal.id);
      expect(ledger.claimNextWorkOrder()?.id).toBe(low.id);
      expect(ledger.claimNextWorkOrder()).toBeNull();
    });

    it('transitions guard against wrong states', () => {
      const wo = ledger.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'b-1',
        input: {},
      });
      expect(() => ledger.completeWorkOrder(wo.id)).toThrow(/expected in_progress/);
      ledger.claimNextWorkOrder();
      ledger.completeWorkOrder(wo.id);
      expect(() => ledger.failWorkOrder(wo.id, 'late')).toThrow(/expected in_progress/);
    });

    it('boot helpers: stale claims listed, open rows cancelled with count', () => {
      const a = ledger.enqueueWorkOrder({ workKind: 'board', idempotencyKey: 'b-2', input: {} });
      ledger.enqueueWorkOrder({ workKind: 'wiki', idempotencyKey: 'w-2', input: {} });
      ledger.claimNextWorkOrder(); // a -> in_progress (crash artifact)

      const stale = ledger.listStaleClaims();
      expect(stale.map((w) => w.id)).toEqual([a.id]);

      const cancelled = ledger.cancelOpenWorkOrders('flag-off');
      expect(cancelled).toBe(2); // pending wiki + in_progress board
      expect(ledger.listStaleClaims()).toHaveLength(0);
    });

    it('workOrderStats reports per-kind last run and failed counts', () => {
      const wo = ledger.enqueueWorkOrder({ workKind: 'wiki', idempotencyKey: 'w-3', input: {} });
      ledger.claimNextWorkOrder();
      ledger.failWorkOrder(wo.id, 'brief missing');

      const stats = ledger.workOrderStats();
      const wiki = stats.find((s) => s.workKind === 'wiki');
      expect(wiki?.failedCount).toBe(1);
      expect(wiki?.lastStatus).toBe('failed');
      expect(wiki?.lastFailureReason).toBe('brief missing');
      const board = stats.find((s) => s.workKind === 'board');
      expect(board?.failedCount).toBe(0);
      expect(board?.lastRunAt).toBeNull();
    });
  });
});

/**
 * Story S2-T1 (review round 1): race, namespace reservation, sequence fidelity.
 */
describe('Story S2-T1: review round 1 hardening', () => {
  describe('AC #5: dual-connection migration safety', () => {
    it('AC #5: two file-DB connections construct concurrently without corrupting the schema', () => {
      const dir = mkdtempSync(join(tmpdir(), 'mama-ledger-race-'));
      const dbPath = join(dir, 'triggers.db');
      try {
        // Legacy shape first so BOTH connections run the upgrade path.
        const seed = new Database(dbPath);
        seed.exec(`
          CREATE TABLE operator_tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','in_progress','review','blocked','done','cancelled')),
            priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('high','normal','low')),
            assignee TEXT, deadline TEXT, source_channel TEXT, source_event_id TEXT,
            latest_event TEXT, auto_created INTEGER NOT NULL DEFAULT 1,
            confirmed INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
          );
          INSERT INTO operator_tasks (title, created_at, updated_at) VALUES ('legacy', 1, 1);
        `);
        seed.close();

        const connA = new Database(dbPath);
        const connB = new Database(dbPath);
        const ledgerA = new TaskLedger(connA); // boot connection: rebuilds
        const ledgerB = new TaskLedger(connB); // lazy connection: guard re-check must no-op

        // Single coherent schema: exactly one operator_tasks table, one row survived,
        // and both connections operate on it.
        expect(ledgerA.list()).toHaveLength(1);
        const created = ledgerB.create({ title: 'via lazy connection' });
        expect(ledgerA.getById(created.id)?.title).toBe('via lazy connection');

        // Sequence fidelity (review m2): exactly ONE sqlite_sequence row - the
        // old INSERT OR REPLACE appended a duplicate that made SQLite read the
        // LOWER seq (latent id reuse).
        const seqRows = connA
          .prepare(`SELECT COUNT(*) AS n FROM sqlite_sequence WHERE name = 'operator_tasks'`)
          .get() as { n: number };
        expect(seqRows.n).toBe(1);

        connA.close();
        connB.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('AC #6: workorder namespace reservation (review m3)', () => {
    it("AC #6: the 'workorder:' source_channel namespace is reserved (review m3)", () => {
      const db2: SQLiteDatabase = new Database(':memory:');
      const ledger2 = new TaskLedger(db2);
      // Deterministic slot keys are public knowledge (OSS) - an owner row on a
      // workorder (channel,event) pair would DoS that schedule slot's INSERT.
      expect(() =>
        ledger2.create({
          title: 'squat',
          source_channel: 'workorder:board',
          source_event_id: 'board:full:12345',
        })
      ).toThrow(/reserved for system workorders/);
    });
  });

  describe('AC #7: cancelled excluded from failure stats (plan D3)', () => {
    it('AC #7: cancelled rows never count as failures in workOrderStats (plan D3)', () => {
      const db3: SQLiteDatabase = new Database(':memory:');
      const ledger3 = new TaskLedger(db3);
      ledger3.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'k1',
        input: { mode: 'full' },
      });
      const cancelled = ledger3.cancelOpenWorkOrders('flag-off');
      expect(cancelled).toBe(1);
      const board = ledger3.workOrderStats().find((s) => s.workKind === 'board');
      expect(board?.failedCount).toBe(0);
      expect(board?.lastStatus).toBe('cancelled');
    });
  });
});

/**
 * Story S2-T1 (review round 2 N4): kind-scoped rollback cancellation.
 */
describe('Story S2-T1: shadow rollback cleanup (N4)', () => {
  describe('AC #1: kind-scoped rollback cancellation', () => {
    it('cancelOpenWorkOrders(onlyKinds) cancels non-board orders and leaves board intact', () => {
      const db4: SQLiteDatabase = new Database(':memory:');
      const ledger4 = new TaskLedger(db4);
      const board = ledger4.enqueueWorkOrder({
        workKind: 'board',
        idempotencyKey: 'b',
        input: { mode: 'full' },
      });
      ledger4.enqueueWorkOrder({
        workKind: 'wiki',
        idempotencyKey: 'w',
        input: { batchId: 'x', events: [] },
      });
      ledger4.enqueueWorkOrder({
        workKind: 'memory-curation',
        idempotencyKey: 'm',
        input: { scheduledAt: 'now' },
      });

      const cancelled = ledger4.cancelOpenWorkOrders('shadow-board-only', [
        'wiki',
        'memory-curation',
      ]);
      expect(cancelled).toBe(2);
      expect(ledger4.claimNextWorkOrder()?.id).toBe(board.id); // board survived
      expect(ledger4.claimNextWorkOrder()).toBeNull(); // nothing else claimable
    });
  });
});
