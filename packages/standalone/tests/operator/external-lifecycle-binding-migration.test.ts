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
    db.close();
  });
});
