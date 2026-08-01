import { describe, expect, it } from 'vitest';
import Database from '../../src/sqlite.js';
import { TaskLedger } from '../../src/operator/task-ledger.js';

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
