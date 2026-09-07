import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from '../../src/sqlite.js';
import { TaskLedger } from '../../src/operator/task-ledger.js';
import { applyOperatorOwnerActionCandidatesMigration } from '../../src/db/migrations/operator-owner-action-candidates.js';
import { bindingCandidateFor } from './external-lifecycle-fixtures.js';

/**
 * The exact pre-B2 shape: NOT NULL attempt columns, no origin owner/envelope
 * columns, no owner action candidate table. Built by hand so the upgrade is
 * exercised against real legacy bytes, not against whatever the current
 * migration happens to create.
 */
function createLegacyExternalLifecycleSchema(db: Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_operator_external_binding_receipts_global_identity;
    DROP TRIGGER IF EXISTS trg_operator_external_lifecycle_receipts_global_identity;
    DROP TRIGGER IF EXISTS trg_operator_external_receipt_identities_immutable_update;
    DROP TRIGGER IF EXISTS trg_operator_external_receipt_identities_immutable_delete;
    DROP TRIGGER IF EXISTS trg_operator_owner_action_candidates_immutable_update;
    DROP TRIGGER IF EXISTS trg_operator_owner_action_candidates_immutable_delete;
    DROP TABLE IF EXISTS operator_owner_action_candidates;
    DROP TABLE IF EXISTS operator_external_lifecycle_receipts;
    DROP TABLE IF EXISTS operator_external_binding_receipts;
    DROP TABLE IF EXISTS operator_external_task_bindings;
    DROP TABLE IF EXISTS operator_external_receipt_identities;

    CREATE TABLE operator_external_task_bindings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      task_id INTEGER NOT NULL REFERENCES operator_tasks(id),
      connector TEXT NOT NULL CHECK (connector = 'kagemusha'),
      source_type TEXT NOT NULL CHECK (source_type = 'kanban_card'),
      external_source_id TEXT NOT NULL,
      last_observation_seq INTEGER NOT NULL CHECK (last_observation_seq >= 1),
      created_by_attempt_id INTEGER NOT NULL REFERENCES operator_tasks(id),
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_operator_external_binding_active_task
      ON operator_external_task_bindings(task_id) WHERE active = 1;
    CREATE UNIQUE INDEX idx_operator_external_binding_active_external
      ON operator_external_task_bindings(connector, source_type, external_source_id) WHERE active = 1;

    CREATE TABLE operator_external_binding_receipts (
      candidate_id TEXT PRIMARY KEY,
      decision TEXT NOT NULL CHECK (decision IN ('bind','decline')),
      workorder_attempt_id INTEGER NOT NULL REFERENCES operator_tasks(id),
      task_id INTEGER NOT NULL REFERENCES operator_tasks(id),
      event_id TEXT NOT NULL,
      connector TEXT NOT NULL CHECK (connector = 'kagemusha'),
      source_type TEXT NOT NULL CHECK (source_type = 'kanban_card'),
      external_source_id TEXT NOT NULL,
      channel_partition TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      source_timestamp_ms INTEGER NOT NULL,
      operator_ingest_seq INTEGER NOT NULL CHECK (operator_ingest_seq >= 1),
      operator_observation_seq INTEGER NOT NULL CHECK (operator_observation_seq >= 1),
      task_revision INTEGER NOT NULL CHECK (task_revision >= 1),
      outcome TEXT NOT NULL CHECK (outcome IN ('bound','declined','superseded')),
      reason TEXT NOT NULL,
      binding_id INTEGER REFERENCES operator_external_task_bindings(id),
      origin_run_id TEXT,
      origin_cause_event_ids TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_operator_external_binding_receipts_attempt
      ON operator_external_binding_receipts(workorder_attempt_id, candidate_id);

    CREATE TABLE operator_external_lifecycle_receipts (
      candidate_id TEXT PRIMARY KEY,
      decision TEXT NOT NULL CHECK (decision IN ('apply','retain')),
      workorder_attempt_id INTEGER NOT NULL REFERENCES operator_tasks(id),
      task_id INTEGER NOT NULL REFERENCES operator_tasks(id),
      event_id TEXT NOT NULL,
      connector TEXT NOT NULL CHECK (connector = 'kagemusha'),
      source_type TEXT NOT NULL CHECK (source_type = 'kanban_card'),
      external_source_id TEXT NOT NULL,
      channel_partition TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      source_timestamp_ms INTEGER NOT NULL,
      operator_ingest_seq INTEGER NOT NULL CHECK (operator_ingest_seq >= 1),
      operator_observation_seq INTEGER NOT NULL CHECK (operator_observation_seq >= 1),
      binding_id INTEGER NOT NULL REFERENCES operator_external_task_bindings(id),
      binding_revision INTEGER NOT NULL CHECK (binding_revision >= 1),
      task_revision_before INTEGER NOT NULL CHECK (task_revision_before >= 1),
      task_revision_after INTEGER NOT NULL CHECK (task_revision_after >= 1),
      outcome TEXT NOT NULL CHECK (outcome IN ('applied','retained','superseded')),
      reason TEXT NOT NULL,
      origin_run_id TEXT,
      origin_cause_event_ids TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_operator_external_lifecycle_receipts_attempt
      ON operator_external_lifecycle_receipts(workorder_attempt_id, candidate_id);

    CREATE TABLE operator_external_receipt_identities (
      candidate_id TEXT PRIMARY KEY,
      receipt_kind TEXT NOT NULL CHECK (receipt_kind IN ('binding','lifecycle')),
      created_at INTEGER NOT NULL
    );
    CREATE TRIGGER trg_operator_external_binding_receipts_global_identity
    BEFORE INSERT ON operator_external_binding_receipts
    BEGIN
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM operator_external_receipt_identities WHERE candidate_id = NEW.candidate_id
      ) THEN RAISE(ABORT, 'external receipt candidate id is already reserved') END;
      INSERT INTO operator_external_receipt_identities (candidate_id, receipt_kind, created_at)
      VALUES (NEW.candidate_id, 'binding', NEW.created_at);
    END;
    CREATE TRIGGER trg_operator_external_lifecycle_receipts_global_identity
    BEFORE INSERT ON operator_external_lifecycle_receipts
    BEGIN
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM operator_external_receipt_identities WHERE candidate_id = NEW.candidate_id
      ) THEN RAISE(ABORT, 'external receipt candidate id is already reserved') END;
      INSERT INTO operator_external_receipt_identities (candidate_id, receipt_kind, created_at)
      VALUES (NEW.candidate_id, 'lifecycle', NEW.created_at);
    END;
    CREATE TRIGGER trg_operator_external_receipt_identities_immutable_update
    BEFORE UPDATE ON operator_external_receipt_identities
    BEGIN SELECT RAISE(ABORT, 'external receipt identities are immutable'); END;
    CREATE TRIGGER trg_operator_external_receipt_identities_immutable_delete
    BEFORE DELETE ON operator_external_receipt_identities
    BEGIN SELECT RAISE(ABORT, 'external receipt identities are immutable'); END;
    CREATE TRIGGER trg_operator_external_binding_receipts_immutable_update
    BEFORE UPDATE ON operator_external_binding_receipts
    BEGIN SELECT RAISE(ABORT, 'external binding receipts are immutable'); END;
    CREATE TRIGGER trg_operator_external_binding_receipts_immutable_delete
    BEFORE DELETE ON operator_external_binding_receipts
    BEGIN SELECT RAISE(ABORT, 'external binding receipts are immutable'); END;
    CREATE TRIGGER trg_operator_external_lifecycle_receipts_immutable_update
    BEFORE UPDATE ON operator_external_lifecycle_receipts
    BEGIN SELECT RAISE(ABORT, 'external lifecycle receipts are immutable'); END;
    CREATE TRIGGER trg_operator_external_lifecycle_receipts_immutable_delete
    BEFORE DELETE ON operator_external_lifecycle_receipts
    BEGIN SELECT RAISE(ABORT, 'external lifecycle receipts are immutable'); END;
  `);
}

interface LegacyFixture {
  db: Database;
  taskId: number;
  attemptId: number;
  queuedAttemptId: number;
  bindingIds: number[];
  bindingReceiptId: string;
  lifecycleReceiptId: string;
  queuedCandidate: ReturnType<typeof bindingCandidateFor>;
}

/**
 * A legacy database with real rows in every table plus a reconcile Board
 * workorder that was queued (payload persisted) before the upgrade.
 */
function createLegacyFixture(path = ':memory:'): LegacyFixture {
  const db = new Database(path);
  const ledger = new TaskLedger(db, { now: () => 1_000 });
  const task = ledger.create({ title: 'legacy bound task' });
  const other = ledger.create({ title: 'legacy queued task' });
  const attempt = ledger.enqueueWorkOrder({
    workKind: 'board',
    idempotencyKey: 'legacy-attempt',
    input: { mode: 'full' },
  });
  ledger.claimNextWorkOrder();
  ledger.completeWorkOrder(attempt.id);
  const queuedCandidate = bindingCandidateFor({ task: other, eventId: 'evt_queued' });
  const queued = ledger.enqueueWorkOrder({
    workKind: 'board',
    idempotencyKey: 'legacy-queued-reconcile',
    input: {
      mode: 'reconcile',
      channelKey: 'kagemusha:room-a',
      deltaLines: ['queued before upgrade'],
      eventIds: [queuedCandidate.eventId],
      candidates: { bindingCandidates: [queuedCandidate], lifecycleCandidates: [] },
    },
  });
  createLegacyExternalLifecycleSchema(db);

  const bindingIds: number[] = [];
  // Two bindings, one deactivated, so AUTOINCREMENT state and the partial
  // unique indexes both have something to preserve.
  for (const [source, active] of [
    ['task:1', 0],
    ['task:1', 1],
  ] as const) {
    const inserted = db
      .prepare(
        `INSERT INTO operator_external_task_bindings
        (task_id, connector, source_type, external_source_id, last_observation_seq, created_by_attempt_id,
         active, created_at, updated_at)
        VALUES (?, 'kagemusha', 'kanban_card', ?, 3, ?, ?, 11, 12)`
      )
      .run(task.id, source, attempt.id, active);
    bindingIds.push(Number(inserted.lastInsertRowid));
  }
  const bindingReceiptId = 'a1'.repeat(32);
  const lifecycleReceiptId = 'b2'.repeat(32);
  db.prepare(
    `INSERT INTO operator_external_binding_receipts
    (candidate_id, decision, workorder_attempt_id, task_id, event_id, connector, source_type, external_source_id,
     channel_partition, content_sha256, source_timestamp_ms, operator_ingest_seq, operator_observation_seq,
     task_revision, outcome, reason, binding_id, origin_run_id, origin_cause_event_ids, created_at)
    VALUES (?, 'bind', ?, ?, 'evt_legacy_bind', 'kagemusha', 'kanban_card', 'task:1', 'room-a',
     '${'a'.repeat(64)}', 5, 1, 3, 1, 'bound', 'legacy bind', ?, 'mr_legacy', '["evt_legacy_bind"]', 13)`
  ).run(bindingReceiptId, attempt.id, task.id, bindingIds[1]);
  db.prepare(
    `INSERT INTO operator_external_lifecycle_receipts
    (candidate_id, decision, workorder_attempt_id, task_id, event_id, connector, source_type, external_source_id,
     channel_partition, content_sha256, source_timestamp_ms, operator_ingest_seq, operator_observation_seq,
     binding_id, binding_revision, task_revision_before, task_revision_after, outcome, reason,
     origin_run_id, origin_cause_event_ids, created_at)
    VALUES (?, 'retain', ?, ?, 'evt_legacy_retain', 'kagemusha', 'kanban_card', 'task:1', 'room-a',
     '${'b'.repeat(64)}', 6, 2, 4, ?, 1, 1, 1, 'retained', 'legacy retain', NULL, '[]', 14)`
  ).run(lifecycleReceiptId, attempt.id, task.id, bindingIds[1]);

  return {
    db,
    taskId: task.id,
    attemptId: attempt.id,
    queuedAttemptId: queued.id,
    bindingIds,
    bindingReceiptId,
    lifecycleReceiptId,
    queuedCandidate,
  };
}

function snapshotRows(db: Database, table: string, orderBy: string): unknown[] {
  return db.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all();
}

function sqlFor(db: Database, type: 'table' | 'index', name: string): string {
  return (
    (
      db.prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?').get(type, name) as
        | {
            sql: string | null;
          }
        | undefined
    )?.sql ?? ''
  );
}

type ReceiptKind = 'binding' | 'lifecycle';
type ConflictClause = 'OR REPLACE' | 'OR IGNORE';

interface PreRoundTwoFixture {
  db: Database;
  attemptId: number;
  taskId: number;
  bindingId: number;
  candidateId: string;
}

function createPreRoundTwoFixture(sourceKind: ReceiptKind): PreRoundTwoFixture {
  const db = new Database(':memory:');
  const ledger = new TaskLedger(db);
  const task = ledger.create({ title: `pre-round-2 ${sourceKind} receipt owner` });
  const attempt = ledger.enqueueWorkOrder({
    workKind: 'board',
    idempotencyKey: `pre-round-2-${sourceKind}-attempt`,
    input: { mode: 'full' },
  });
  const binding = db
    .prepare(
      `INSERT INTO operator_external_task_bindings
      (task_id, connector, source_type, external_source_id, last_observation_seq, created_by_attempt_id,
       active, created_at, updated_at)
      VALUES (?, 'kagemusha', 'kanban_card', 'task:pre-round-2', 1, ?, 1, 1, 1)`
    )
    .run(task.id, attempt.id);
  const candidateId = (sourceKind === 'binding' ? 'g' : 'h').repeat(64);
  const bindingId = Number(binding.lastInsertRowid);

  if (sourceKind === 'binding') {
    db.prepare(
      `INSERT INTO operator_external_binding_receipts
      (candidate_id, decision, workorder_attempt_id, task_id, event_id, connector, source_type, external_source_id,
       channel_partition, content_sha256, source_timestamp_ms, operator_ingest_seq, operator_observation_seq,
       task_revision, outcome, reason, origin_cause_event_ids, created_at)
      VALUES (?, 'decline', ?, ?, 'evt_pre_round_2_binding', 'kagemusha', 'kanban_card', 'task:pre-round-2',
       'room-a', '${'a'.repeat(64)}', 1, 1, 1, 1, 'declined', 'pre-round-2', '[]', 1)`
    ).run(candidateId, attempt.id, task.id);
  } else {
    db.prepare(
      `INSERT INTO operator_external_lifecycle_receipts
      (candidate_id, decision, workorder_attempt_id, task_id, event_id, connector, source_type, external_source_id,
       channel_partition, content_sha256, source_timestamp_ms, operator_ingest_seq, operator_observation_seq,
       binding_id, binding_revision, task_revision_before, task_revision_after, outcome, reason,
       origin_cause_event_ids, created_at)
      VALUES (?, 'retain', ?, ?, 'evt_pre_round_2_lifecycle', 'kagemusha', 'kanban_card', 'task:pre-round-2',
       'room-a', '${'b'.repeat(64)}', 2, 2, 2, ?, 1, 1, 1, 'retained', 'pre-round-2', '[]', 2)`
    ).run(candidateId, attempt.id, task.id, bindingId);
  }

  // This is the 59dfd4ec schema: shared identities and same-name receipt triggers, but no
  // identity immutability triggers or explicit preflight before their INSERTs.
  db.exec(`
    DROP TRIGGER trg_operator_external_binding_receipts_global_identity;
    DROP TRIGGER trg_operator_external_lifecycle_receipts_global_identity;
    DROP TRIGGER trg_operator_external_receipt_identities_immutable_update;
    DROP TRIGGER trg_operator_external_receipt_identities_immutable_delete;
    CREATE TRIGGER trg_operator_external_binding_receipts_global_identity
    BEFORE INSERT ON operator_external_binding_receipts
    BEGIN
      INSERT INTO operator_external_receipt_identities (candidate_id, receipt_kind, created_at)
      VALUES (NEW.candidate_id, 'binding', NEW.created_at);
    END;
    CREATE TRIGGER trg_operator_external_lifecycle_receipts_global_identity
    BEFORE INSERT ON operator_external_lifecycle_receipts
    BEGIN
      INSERT INTO operator_external_receipt_identities (candidate_id, receipt_kind, created_at)
      VALUES (NEW.candidate_id, 'lifecycle', NEW.created_at);
    END;
  `);

  return { db, attemptId: attempt.id, taskId: task.id, bindingId, candidateId };
}

function insertOppositeKindReceipt(
  fixture: PreRoundTwoFixture,
  sourceKind: ReceiptKind,
  conflictClause: ConflictClause
): void {
  if (sourceKind === 'binding') {
    fixture.db
      .prepare(
        `INSERT ${conflictClause} INTO operator_external_lifecycle_receipts
      (candidate_id, decision, workorder_attempt_id, task_id, event_id, connector, source_type, external_source_id,
       channel_partition, content_sha256, source_timestamp_ms, operator_ingest_seq, operator_observation_seq,
       binding_id, binding_revision, task_revision_before, task_revision_after, outcome, reason,
       origin_cause_event_ids, created_at)
      VALUES (?, 'retain', ?, ?, 'evt_upgrade_lifecycle_${conflictClause.replace(' ', '_')}', 'kagemusha',
       'kanban_card', 'task:pre-round-2', 'room-b', '${'c'.repeat(64)}', 3, 3, 3, ?, 1, 1, 1,
       'retained', 'conflict', '[]', 3)`
      )
      .run(fixture.candidateId, fixture.attemptId, fixture.taskId, fixture.bindingId);
    return;
  }

  fixture.db
    .prepare(
      `INSERT ${conflictClause} INTO operator_external_binding_receipts
    (candidate_id, decision, workorder_attempt_id, task_id, event_id, connector, source_type, external_source_id,
     channel_partition, content_sha256, source_timestamp_ms, operator_ingest_seq, operator_observation_seq,
     task_revision, outcome, reason, origin_cause_event_ids, created_at)
    VALUES (?, 'decline', ?, ?, 'evt_upgrade_binding_${conflictClause.replace(' ', '_')}', 'kagemusha',
     'kanban_card', 'task:pre-round-2', 'room-b', '${'d'.repeat(64)}', 4, 4, 4, 1, 'declined',
     'conflict', '[]', 4)`
    )
    .run(fixture.candidateId, fixture.attemptId, fixture.taskId);
}

function receiptCount(db: Database, kind: ReceiptKind, candidateId: string): number {
  const table =
    kind === 'binding'
      ? 'operator_external_binding_receipts'
      : 'operator_external_lifecycle_receipts';
  return (
    db
      .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE candidate_id = ?`)
      .get(candidateId) as {
      count: number;
    }
  ).count;
}

describe('Story B2: owner action candidate migration rebuilds the NOT NULL attempt columns', () => {
  it('rebuilds legacy tables in place, preserving every row, id, receipt, identity, index and trigger', () => {
    const fixture = createLegacyFixture();
    const { db } = fixture;
    expect(sqlFor(db, 'table', 'operator_external_task_bindings')).toContain(
      'created_by_attempt_id INTEGER NOT NULL'
    );
    const before = {
      bindings: snapshotRows(db, 'operator_external_task_bindings', 'id'),
      bindingReceipts: snapshotRows(db, 'operator_external_binding_receipts', 'candidate_id'),
      lifecycleReceipts: snapshotRows(db, 'operator_external_lifecycle_receipts', 'candidate_id'),
      identities: snapshotRows(db, 'operator_external_receipt_identities', 'candidate_id'),
      seq: db
        .prepare(`SELECT seq FROM sqlite_sequence WHERE name = ?`)
        .get('operator_external_task_bindings'),
    };
    // Drift the sequence above max(id) so a naive rebuild would reuse an id.
    db.prepare(
      `UPDATE sqlite_sequence SET seq = 40 WHERE name = 'operator_external_task_bindings'`
    ).run();

    new TaskLedger(db, { now: () => 2_000 });

    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    for (const table of [
      'operator_external_task_bindings',
      'operator_external_binding_receipts',
      'operator_external_lifecycle_receipts',
    ]) {
      const sql = sqlFor(db, 'table', table);
      expect(sql).not.toContain('created_by_attempt_id INTEGER NOT NULL');
      expect(sql).not.toContain('workorder_attempt_id INTEGER NOT NULL');
    }
    expect(sqlFor(db, 'table', 'operator_external_task_bindings')).toContain('created_by_run_id');
    expect(sqlFor(db, 'table', 'operator_external_binding_receipts')).toContain(
      'origin_owner_scope'
    );
    expect(sqlFor(db, 'table', 'operator_external_lifecycle_receipts')).toContain(
      'origin_envelope_hash'
    );
    expect(sqlFor(db, 'table', 'operator_owner_action_candidates')).toContain(
      'PRIMARY KEY (model_run_id, candidate_id)'
    );

    // Every legacy column value survives byte for byte; new columns are null.
    const nulls = {
      created_by_run_id: null,
      created_by_owner_scope: null,
      created_by_envelope_hash: null,
    };
    expect(snapshotRows(db, 'operator_external_task_bindings', 'id')).toEqual(
      before.bindings.map((row) => ({ ...(row as object), ...nulls }))
    );
    expect(snapshotRows(db, 'operator_external_binding_receipts', 'candidate_id')).toEqual(
      before.bindingReceipts.map((row) => ({
        ...(row as object),
        origin_owner_scope: null,
        origin_envelope_hash: null,
      }))
    );
    expect(snapshotRows(db, 'operator_external_lifecycle_receipts', 'candidate_id')).toEqual(
      before.lifecycleReceipts.map((row) => ({
        ...(row as object),
        origin_owner_scope: null,
        origin_envelope_hash: null,
      }))
    );
    expect(snapshotRows(db, 'operator_external_receipt_identities', 'candidate_id')).toEqual(
      before.identities
    );
    expect(before.seq).toEqual({ seq: fixture.bindingIds[1] });
    expect(
      db
        .prepare(`SELECT seq FROM sqlite_sequence WHERE name = ?`)
        .get('operator_external_task_bindings')
    ).toEqual({ seq: 40 });

    // Indexes and triggers are back on the rebuilt tables.
    for (const index of [
      'idx_operator_external_binding_active_task',
      'idx_operator_external_binding_active_external',
      'idx_operator_external_binding_receipts_attempt',
      'idx_operator_external_lifecycle_receipts_attempt',
      'idx_operator_external_binding_receipts_origin_run',
      'idx_operator_external_lifecycle_receipts_origin_run',
    ]) {
      expect(sqlFor(db, 'index', index)).not.toBe('');
    }
    const triggers = (
      db.prepare(`SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger'`).all() as Array<{
        name: string;
        tbl_name: string;
      }>
    ).map((row) => `${row.tbl_name}:${row.name}`);
    for (const expected of [
      'operator_external_binding_receipts:trg_operator_external_binding_receipts_global_identity',
      'operator_external_binding_receipts:trg_operator_external_binding_receipts_immutable_update',
      'operator_external_binding_receipts:trg_operator_external_binding_receipts_immutable_delete',
      'operator_external_lifecycle_receipts:trg_operator_external_lifecycle_receipts_global_identity',
      'operator_external_lifecycle_receipts:trg_operator_external_lifecycle_receipts_immutable_update',
      'operator_external_lifecycle_receipts:trg_operator_external_lifecycle_receipts_immutable_delete',
      'operator_external_receipt_identities:trg_operator_external_receipt_identities_immutable_update',
      'operator_external_receipt_identities:trg_operator_external_receipt_identities_immutable_delete',
      'operator_owner_action_candidates:trg_operator_owner_action_candidates_immutable_update',
      'operator_owner_action_candidates:trg_operator_owner_action_candidates_immutable_delete',
    ]) {
      expect(triggers).toContain(expected);
    }
    expect(() =>
      db
        .prepare(
          `UPDATE operator_external_binding_receipts SET reason = 'x' WHERE candidate_id = ?`
        )
        .run(fixture.bindingReceiptId)
    ).toThrow(/immutable/);
    expect(() =>
      db
        .prepare(`DELETE FROM operator_external_lifecycle_receipts WHERE candidate_id = ?`)
        .run(fixture.lifecycleReceiptId)
    ).toThrow(/immutable/);
    // Partial unique indexes still bite; the deactivated row still allows a new active one.
    expect(() =>
      db
        .prepare(
          `INSERT INTO operator_external_task_bindings
          (task_id, connector, source_type, external_source_id, last_observation_seq, created_by_attempt_id,
           active, created_at, updated_at)
          VALUES (?, 'kagemusha', 'kanban_card', 'task:1', 4, ?, 1, 1, 1)`
        )
        .run(fixture.taskId, fixture.attemptId)
    ).toThrow(/UNIQUE/);
    // The CHECK forbids an orphan row with neither attempt nor owner run.
    expect(() =>
      db
        .prepare(
          `INSERT INTO operator_external_task_bindings
          (task_id, connector, source_type, external_source_id, last_observation_seq,
           active, created_at, updated_at)
          VALUES (?, 'kagemusha', 'kanban_card', 'task:99', 4, 0, 1, 1)`
        )
        .run(fixture.taskId)
    ).toThrow(/CHECK/);
    db.close();
  });

  it('is idempotent across constructors and a direct out-of-transaction invocation', () => {
    const fixture = createLegacyFixture();
    const { db } = fixture;
    // Direct call: opens its own transaction (SAVEPOINT) with deferred FKs.
    applyOperatorOwnerActionCandidatesMigration(db);
    const shape = sqlFor(db, 'table', 'operator_external_task_bindings');
    const rows = snapshotRows(db, 'operator_external_task_bindings', 'id');
    applyOperatorOwnerActionCandidatesMigration(db);
    new TaskLedger(db);
    new TaskLedger(db);
    expect(sqlFor(db, 'table', 'operator_external_task_bindings')).toBe(shape);
    expect(snapshotRows(db, 'operator_external_task_bindings', 'id')).toEqual(rows);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name LIKE '%__owner_action_rebuild'`
        )
        .get()
    ).toEqual({ n: 0 });
    db.close();
  });

  it('reopens the rebuilt database with legacy rows, foreign keys and triggers intact', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mama-owner-candidates-'));
    const databasePath = join(directory, 'operator.db');
    const fixture = createLegacyFixture(databasePath);
    try {
      new TaskLedger(fixture.db, { now: () => 2_000 });
      fixture.db.close();

      const reopened = new Database(databasePath);
      try {
        const ledger = new TaskLedger(reopened, { now: () => 3_000 });
        expect(reopened.pragma('foreign_key_check')).toEqual([]);
        expect(ledger.getExternalCandidateReceipt(fixture.bindingReceiptId)).toMatchObject({
          kind: 'binding',
          workOrderAttemptId: fixture.attemptId,
          outcome: 'bound',
        });
        expect(ledger.getExternalCandidateReceipt(fixture.lifecycleReceiptId)).toMatchObject({
          kind: 'lifecycle',
          workOrderAttemptId: fixture.attemptId,
          outcome: 'retained',
        });
        expect(() =>
          reopened
            .prepare(
              `UPDATE operator_external_binding_receipts SET reason = reason WHERE candidate_id = ?`
            )
            .run(fixture.bindingReceiptId)
        ).toThrow(/immutable/i);
      } finally {
        reopened.close();
      }
    } finally {
      if (fixture.db.open) {
        fixture.db.close();
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps a legacy queued Board attempt decidable through the unchanged numeric wrapper', () => {
    const fixture = createLegacyFixture();
    const { db } = fixture;
    const ledger = new TaskLedger(db, { now: () => 3_000 });
    const claimed = ledger.claimNextWorkOrder();
    expect(claimed?.id).toBe(fixture.queuedAttemptId);
    const candidate = fixture.queuedCandidate;
    const receipt = ledger.applyExternalBindingDecision(
      fixture.queuedAttemptId,
      {
        candidate_id: candidate.candidateId,
        decision: 'bind',
        reason: 'queued before the upgrade, decided after it',
        expected_revision: candidate.taskRevision,
      },
      {
        runId: 'mr_after',
        workOrderAttemptId: fixture.queuedAttemptId,
        causeEventIds: [candidate.eventId],
      }
    );
    expect(receipt).toMatchObject({
      outcome: 'bound',
      workOrderAttemptId: fixture.queuedAttemptId,
      originRunId: 'mr_after',
      originOwnerScope: null,
    });
    expect(ledger.getExternalBinding(candidate.taskId)).toMatchObject({
      createdByAttemptId: fixture.queuedAttemptId,
      createdByRunId: 'mr_after',
      createdByOwnerScope: null,
    });
    // Legacy receipts read back through the same API with null owner fields.
    expect(ledger.getExternalCandidateReceipt(fixture.bindingReceiptId)).toMatchObject({
      kind: 'binding',
      workOrderAttemptId: fixture.attemptId,
      originRunId: 'mr_legacy',
      originOwnerScope: null,
      outcome: 'bound',
    });
    expect(ledger.getExternalCandidateReceipt(fixture.lifecycleReceiptId)).toMatchObject({
      kind: 'lifecycle',
      workOrderAttemptId: fixture.attemptId,
      originRunId: null,
      outcome: 'retained',
    });
    expect(ledger.inspectBoardCandidateAttempt(fixture.queuedAttemptId)).toEqual({
      disposition: 'complete',
      outcomes: ['bound'],
    });
    db.close();
  });

  it('gives a fresh database the current shape without a rebuild', () => {
    const db = new Database(':memory:');
    new TaskLedger(db);
    expect(sqlFor(db, 'table', 'operator_external_task_bindings')).toContain('created_by_run_id');
    expect(sqlFor(db, 'table', 'operator_external_binding_receipts')).toContain(
      'origin_owner_scope'
    );
    expect(sqlFor(db, 'table', 'operator_owner_action_candidates')).not.toBe('');
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });
});

describe('Story EL3: external lifecycle binding migration', () => {
  it('creates receipted binding tables with active-pair and decision constraints', () => {
    const db = new Database(':memory:');
    new TaskLedger(db);

    for (const table of [
      'operator_external_task_bindings',
      'operator_external_binding_receipts',
      'operator_external_lifecycle_receipts',
    ]) {
      expect(sqlFor(db, 'table', table)).not.toBe('');
    }
    expect(sqlFor(db, 'table', 'operator_external_binding_receipts')).toContain(
      "'bound','declined','superseded'"
    );
    expect(sqlFor(db, 'table', 'operator_external_lifecycle_receipts')).toContain(
      "'applied','retained','superseded'"
    );
    expect(sqlFor(db, 'index', 'idx_operator_external_binding_active_task')).not.toBe('');
    expect(sqlFor(db, 'index', 'idx_operator_external_binding_active_external')).not.toBe('');
    db.close();
  });

  it('enforces active uniqueness in both directions and a candidate receipt identity globally', () => {
    const db = new Database(':memory:');
    const ledger = new TaskLedger(db);
    const first = ledger.create({ title: 'first' });
    const second = ledger.create({ title: 'second' });
    const attempt = ledger.enqueueWorkOrder({
      workKind: 'board',
      idempotencyKey: 'schema',
      input: { mode: 'full' },
    });
    const laterAttempt = ledger.enqueueWorkOrder({
      workKind: 'board',
      idempotencyKey: 'schema-later',
      input: { mode: 'full' },
    });

    const insertBinding = db.prepare(`INSERT INTO operator_external_task_bindings
      (task_id, connector, source_type, external_source_id, last_observation_seq, created_by_attempt_id, active, created_at, updated_at)
      VALUES (?, 'kagemusha', 'kanban_card', ?, 9, ?, 1, 1, 1)`);
    insertBinding.run(first.id, 'task:42', attempt.id);
    expect(() => insertBinding.run(first.id, 'task:43', attempt.id)).toThrow();
    expect(() => insertBinding.run(second.id, 'task:42', attempt.id)).toThrow();

    const insertReceipt = db.prepare(`INSERT INTO operator_external_binding_receipts
      (candidate_id, decision, workorder_attempt_id, task_id, event_id, connector, source_type, external_source_id,
       channel_partition, content_sha256, source_timestamp_ms, operator_ingest_seq, operator_observation_seq,
       task_revision, outcome, reason, origin_cause_event_ids, created_at)
      VALUES ('${'c'.repeat(64)}', 'decline', ?, ?, 'evt_schema', 'kagemusha', 'kanban_card', 'task:42', 'room-a',
       '${'a'.repeat(64)}', 1, 1, 1, 1, 'declined', 'not exact', '[]', 1)`);
    insertReceipt.run(attempt.id, first.id);
    expect(() => insertReceipt.run(attempt.id, first.id)).toThrow();
    const invalidDecision = db.prepare(`INSERT INTO operator_external_binding_receipts
      (candidate_id, decision, workorder_attempt_id, task_id, event_id, connector, source_type, external_source_id,
       channel_partition, content_sha256, source_timestamp_ms, operator_ingest_seq, operator_observation_seq,
       task_revision, outcome, reason, origin_cause_event_ids, created_at)
      VALUES ('${'d'.repeat(64)}', 'invented', ?, ?, 'evt_schema_2', 'kagemusha', 'kanban_card', 'task:43', 'room-a',
       '${'a'.repeat(64)}', 1, 1, 1, 1, 'declined', 'not exact', '[]', 1)`);
    expect(() => invalidDecision.run(attempt.id, second.id)).toThrow();

    const insertLifecycleReceipt = db.prepare(`INSERT INTO operator_external_lifecycle_receipts
      (candidate_id, decision, workorder_attempt_id, task_id, event_id, connector, source_type, external_source_id,
       channel_partition, content_sha256, source_timestamp_ms, operator_ingest_seq, operator_observation_seq,
       binding_id, binding_revision, task_revision_before, task_revision_after, outcome, reason,
       origin_cause_event_ids, created_at)
      VALUES ('${'c'.repeat(64)}', 'retain', ?, ?, 'evt_schema_3', 'kagemusha', 'kanban_card', 'task:42', 'room-b',
       '${'b'.repeat(64)}', 2, 2, 2, ?, 1, 1, 1, 'retained', 'already current', '[]', 2)`);
    const replaceLifecycleReceipt =
      db.prepare(`INSERT OR REPLACE INTO operator_external_lifecycle_receipts
      (candidate_id, decision, workorder_attempt_id, task_id, event_id, connector, source_type, external_source_id,
       channel_partition, content_sha256, source_timestamp_ms, operator_ingest_seq, operator_observation_seq,
       binding_id, binding_revision, task_revision_before, task_revision_after, outcome, reason,
       origin_cause_event_ids, created_at)
      VALUES ('${'c'.repeat(64)}', 'retain', ?, ?, 'evt_schema_replace', 'kagemusha', 'kanban_card', 'task:42', 'room-b',
       '${'b'.repeat(64)}', 2, 2, 2, ?, 1, 1, 1, 'retained', 'already current', '[]', 2)`);
    expect(() =>
      db
        .prepare(
          `UPDATE operator_external_receipt_identities
         SET receipt_kind = 'lifecycle' WHERE candidate_id = ?`
        )
        .run('c'.repeat(64))
    ).toThrow();
    expect(() =>
      db
        .prepare(`DELETE FROM operator_external_receipt_identities WHERE candidate_id = ?`)
        .run('c'.repeat(64))
    ).toThrow();
    expect(() => replaceLifecycleReceipt.run(laterAttempt.id, first.id, 1)).toThrow();
    expect(() => insertLifecycleReceipt.run(laterAttempt.id, first.id, 1)).toThrow();
    expect(
      db
        .prepare(
          `SELECT receipt_kind FROM operator_external_receipt_identities WHERE candidate_id = ?`
        )
        .get('c'.repeat(64))
    ).toEqual({ receipt_kind: 'binding' });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM operator_external_lifecycle_receipts WHERE candidate_id = ?`
        )
        .get('c'.repeat(64))
    ).toEqual({ count: 0 });

    db.exec('DROP TRIGGER IF EXISTS trg_operator_external_binding_receipts_global_identity');
    db.exec('DROP TRIGGER IF EXISTS trg_operator_external_lifecycle_receipts_global_identity');
    insertLifecycleReceipt.run(laterAttempt.id, first.id, 1);
    expect(() => ledger.getExternalCandidateReceipt('c'.repeat(64))).toThrow(/duplicate|global/i);
    db.close();
  });

  it('backfills both pre-namespace receipt kinds before installing global identity guards', () => {
    const db = new Database(':memory:');
    const ledger = new TaskLedger(db);
    const task = ledger.create({ title: 'legacy receipt owner' });
    const attempt = ledger.enqueueWorkOrder({
      workKind: 'board',
      idempotencyKey: 'legacy-receipt-attempt',
      input: { mode: 'full' },
    });
    const binding = db
      .prepare(
        `INSERT INTO operator_external_task_bindings
        (task_id, connector, source_type, external_source_id, last_observation_seq, created_by_attempt_id,
         active, created_at, updated_at)
        VALUES (?, 'kagemusha', 'kanban_card', 'task:42', 1, ?, 1, 1, 1)`
      )
      .run(task.id, attempt.id);

    for (const trigger of [
      'trg_operator_external_binding_receipts_global_identity',
      'trg_operator_external_lifecycle_receipts_global_identity',
      'trg_operator_external_receipt_identities_immutable_update',
      'trg_operator_external_receipt_identities_immutable_delete',
    ]) {
      db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    }
    db.exec(`DROP TABLE operator_external_receipt_identities`);

    db.prepare(
      `INSERT INTO operator_external_binding_receipts
      (candidate_id, decision, workorder_attempt_id, task_id, event_id, connector, source_type, external_source_id,
       channel_partition, content_sha256, source_timestamp_ms, operator_ingest_seq, operator_observation_seq,
       task_revision, outcome, reason, origin_cause_event_ids, created_at)
      VALUES ('${'e'.repeat(64)}', 'decline', ?, ?, 'evt_legacy_binding', 'kagemusha', 'kanban_card', 'task:42',
       'room-a', '${'a'.repeat(64)}', 1, 1, 1, 1, 'declined', 'legacy', '[]', 1)`
    ).run(attempt.id, task.id);
    db.prepare(
      `INSERT INTO operator_external_lifecycle_receipts
      (candidate_id, decision, workorder_attempt_id, task_id, event_id, connector, source_type, external_source_id,
       channel_partition, content_sha256, source_timestamp_ms, operator_ingest_seq, operator_observation_seq,
       binding_id, binding_revision, task_revision_before, task_revision_after, outcome, reason,
       origin_cause_event_ids, created_at)
      VALUES ('${'f'.repeat(64)}', 'retain', ?, ?, 'evt_legacy_lifecycle', 'kagemusha', 'kanban_card', 'task:42',
       'room-a', '${'b'.repeat(64)}', 2, 2, 2, ?, 1, 1, 1, 'retained', 'legacy', '[]', 2)`
    ).run(attempt.id, task.id, Number(binding.lastInsertRowid));

    new TaskLedger(db);
    expect(
      db
        .prepare(
          `SELECT candidate_id, receipt_kind FROM operator_external_receipt_identities ORDER BY candidate_id`
        )
        .all()
    ).toEqual([
      { candidate_id: 'e'.repeat(64), receipt_kind: 'binding' },
      { candidate_id: 'f'.repeat(64), receipt_kind: 'lifecycle' },
    ]);
    db.close();
  });

  for (const sourceKind of ['binding', 'lifecycle'] as const) {
    for (const conflictClause of ['OR REPLACE', 'OR IGNORE'] as const) {
      const oppositeKind: ReceiptKind = sourceKind === 'binding' ? 'lifecycle' : 'binding';
      const scenario = `${sourceKind} to ${oppositeKind} with ${conflictClause}`;

      it(`allows ${scenario} under the pre-round-2 receipt triggers`, () => {
        const fixture = createPreRoundTwoFixture(sourceKind);
        expect(() => insertOppositeKindReceipt(fixture, sourceKind, conflictClause)).not.toThrow();
        expect(receiptCount(fixture.db, sourceKind, fixture.candidateId)).toBe(1);
        expect(receiptCount(fixture.db, oppositeKind, fixture.candidateId)).toBe(1);
        expect(
          fixture.db
            .prepare(
              `SELECT receipt_kind FROM operator_external_receipt_identities WHERE candidate_id = ?`
            )
            .get(fixture.candidateId)
        ).toEqual({
          receipt_kind: conflictClause === 'OR REPLACE' ? oppositeKind : sourceKind,
        });
        expect(() =>
          fixture.db
            .prepare(
              `UPDATE operator_external_receipt_identities
               SET created_at = created_at WHERE candidate_id = ?`
            )
            .run(fixture.candidateId)
        ).not.toThrow();
        expect(() =>
          fixture.db
            .prepare(`DELETE FROM operator_external_receipt_identities WHERE candidate_id = ?`)
            .run(fixture.candidateId)
        ).not.toThrow();
        fixture.db.close();
      });

      it(`rejects ${scenario} after upgrading the receipt triggers`, () => {
        const fixture = createPreRoundTwoFixture(sourceKind);
        new TaskLedger(fixture.db);
        new TaskLedger(fixture.db);

        expect(() => insertOppositeKindReceipt(fixture, sourceKind, conflictClause)).toThrow(
          /already reserved/
        );
        expect(receiptCount(fixture.db, sourceKind, fixture.candidateId)).toBe(1);
        expect(receiptCount(fixture.db, oppositeKind, fixture.candidateId)).toBe(0);
        expect(
          fixture.db
            .prepare(
              `SELECT receipt_kind FROM operator_external_receipt_identities WHERE candidate_id = ?`
            )
            .get(fixture.candidateId)
        ).toEqual({ receipt_kind: sourceKind });
        expect(() =>
          fixture.db
            .prepare(
              `UPDATE operator_external_receipt_identities
               SET receipt_kind = ? WHERE candidate_id = ?`
            )
            .run(oppositeKind, fixture.candidateId)
        ).toThrow();
        expect(() =>
          fixture.db
            .prepare(`DELETE FROM operator_external_receipt_identities WHERE candidate_id = ?`)
            .run(fixture.candidateId)
        ).toThrow();
        fixture.db.close();
      });
    }
  }
});
