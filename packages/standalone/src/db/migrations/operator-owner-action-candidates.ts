import type { SQLiteDatabase } from '../../sqlite.js';
import {
  applyOperatorTaskExternalLifecycleMigration,
  EXTERNAL_BINDING_RECEIPTS_COLUMNS_SQL,
  EXTERNAL_LIFECYCLE_RECEIPTS_COLUMNS_SQL,
  EXTERNAL_TASK_BINDINGS_COLUMNS_SQL,
} from './operator-task-external-lifecycle.js';

/**
 * Task B2: host-attested owner-run candidates and source-neutral receipts.
 *
 * 1. `operator_owner_action_candidates`: immutable candidate snapshots the host
 *    built and attested under (owner scope, model run, envelope). Keyed by
 *    (model_run_id, candidate_id); candidate ids stay globally content-derived.
 * 2. Receipts and bindings no longer REQUIRE a Board attempt id. The attempt
 *    columns become nullable, but only together with a verified origin run,
 *    owner scope and envelope (CHECK). No synthetic Board row is ever inserted.
 *
 * SQLite cannot relax NOT NULL in place, so legacy-shaped tables are rebuilt
 * by copy-swap INSIDE the caller's transaction with foreign keys ON and
 * deferred: every row, id, receipt, global identity, index and immutability
 * trigger survives. Idempotent: an already-current table is left alone.
 */
export const OWNER_ACTION_CANDIDATES_TABLE = 'operator_owner_action_candidates';

/** Legacy column lists copied verbatim during a rebuild (order is the legacy shape). */
const LEGACY_BINDING_COLUMNS = [
  'id',
  'revision',
  'task_id',
  'connector',
  'source_type',
  'external_source_id',
  'last_observation_seq',
  'created_by_attempt_id',
  'active',
  'created_at',
  'updated_at',
];
const LEGACY_BINDING_RECEIPT_COLUMNS = [
  'candidate_id',
  'decision',
  'workorder_attempt_id',
  'task_id',
  'event_id',
  'connector',
  'source_type',
  'external_source_id',
  'channel_partition',
  'content_sha256',
  'source_timestamp_ms',
  'operator_ingest_seq',
  'operator_observation_seq',
  'task_revision',
  'outcome',
  'reason',
  'binding_id',
  'origin_run_id',
  'origin_cause_event_ids',
  'created_at',
];
const LEGACY_LIFECYCLE_RECEIPT_COLUMNS = [
  'candidate_id',
  'decision',
  'workorder_attempt_id',
  'task_id',
  'event_id',
  'connector',
  'source_type',
  'external_source_id',
  'channel_partition',
  'content_sha256',
  'source_timestamp_ms',
  'operator_ingest_seq',
  'operator_observation_seq',
  'binding_id',
  'binding_revision',
  'task_revision_before',
  'task_revision_after',
  'outcome',
  'reason',
  'origin_run_id',
  'origin_cause_event_ids',
  'created_at',
];

interface RebuildSpec {
  table: string;
  columnsSql: string;
  legacyColumns: readonly string[];
  currentColumns: readonly string[];
  /** Column whose presence proves the current shape. */
  marker: string;
  autoincrement: boolean;
}

const REBUILDS: readonly RebuildSpec[] = [
  {
    table: 'operator_external_task_bindings',
    columnsSql: EXTERNAL_TASK_BINDINGS_COLUMNS_SQL,
    legacyColumns: LEGACY_BINDING_COLUMNS,
    currentColumns: [
      ...LEGACY_BINDING_COLUMNS,
      'created_by_run_id',
      'created_by_owner_scope',
      'created_by_envelope_hash',
    ],
    marker: 'created_by_run_id',
    autoincrement: true,
  },
  {
    table: 'operator_external_binding_receipts',
    columnsSql: EXTERNAL_BINDING_RECEIPTS_COLUMNS_SQL,
    legacyColumns: LEGACY_BINDING_RECEIPT_COLUMNS,
    currentColumns: [
      ...LEGACY_BINDING_RECEIPT_COLUMNS,
      'origin_owner_scope',
      'origin_envelope_hash',
    ],
    marker: 'origin_owner_scope',
    autoincrement: false,
  },
  {
    table: 'operator_external_lifecycle_receipts',
    columnsSql: EXTERNAL_LIFECYCLE_RECEIPTS_COLUMNS_SQL,
    legacyColumns: LEGACY_LIFECYCLE_RECEIPT_COLUMNS,
    currentColumns: [
      ...LEGACY_LIFECYCLE_RECEIPT_COLUMNS,
      'origin_owner_scope',
      'origin_envelope_hash',
    ],
    marker: 'origin_owner_scope',
    autoincrement: false,
  },
];

function tableColumns(db: SQLiteDatabase, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
}

function tableColumnNames(db: SQLiteDatabase, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (column) => column.name
  );
}

function tableExists(db: SQLiteDatabase, table: string): boolean {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) !==
    undefined
  );
}

interface PreparedRebuild {
  spec: RebuildSpec;
  sequence: number | null;
}

function prepareTableRebuild(
  db: SQLiteDatabase,
  spec: RebuildSpec,
  bindingParentRebuilt: boolean
): PreparedRebuild {
  const existingNames = tableColumnNames(db, spec.table);
  const existing = new Set(existingNames);
  const missing = spec.legacyColumns.filter((column) => !existing.has(column));
  if (missing.length > 0) {
    throw new Error(
      `${spec.table} cannot be rebuilt: legacy column(s) ${missing.join(', ')} are missing`
    );
  }
  const unexpected = existingNames.filter((column) => !spec.currentColumns.includes(column));
  if (unexpected.length > 0) {
    throw new Error(
      `${spec.table} cannot be rebuilt: unknown column(s) ${unexpected.join(', ')} would be lost`
    );
  }
  const seq = spec.autoincrement
    ? (db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = ?`).get(spec.table) as
        | { seq: number }
        | undefined)
    : undefined;
  const columnList = existingNames.join(', ');
  const scratch = `${spec.table}__owner_action_rebuild`;
  const scratchColumnsSql =
    bindingParentRebuilt && spec.table !== 'operator_external_task_bindings'
      ? spec.columnsSql.replaceAll(
          'REFERENCES operator_external_task_bindings',
          'REFERENCES operator_external_task_bindings__owner_action_rebuild'
        )
      : spec.columnsSql;
  db.exec(`DROP TABLE IF EXISTS ${scratch};`);
  db.exec(`CREATE TABLE ${scratch} (${scratchColumnsSql});`);
  // The scratch table carries no triggers yet, so copying receipts does not
  // re-fire the global identity reservation for ids that are already reserved.
  db.exec(`INSERT INTO ${scratch} (${columnList}) SELECT ${columnList} FROM ${spec.table};`);
  const before = (db.prepare(`SELECT COUNT(*) AS n FROM ${spec.table}`).get() as { n: number }).n;
  const after = (db.prepare(`SELECT COUNT(*) AS n FROM ${scratch}`).get() as { n: number }).n;
  if (before !== after) {
    throw new Error(`${spec.table} rebuild copied ${after} of ${before} rows`);
  }
  return { spec, sequence: seq?.seq ?? null };
}

function swapPreparedTables(db: SQLiteDatabase, prepared: readonly PreparedRebuild[]): void {
  // SQLite remembers a deferred violation when a referenced parent is dropped,
  // even if an identical parent is recreated before COMMIT. Remove the receipt
  // children first, then swap the binding parent, all in this transaction.
  for (const { spec } of [...prepared].reverse()) {
    db.exec(`DROP TABLE ${spec.table};`);
  }
  for (const { spec, sequence } of prepared) {
    const scratch = `${spec.table}__owner_action_rebuild`;
    db.exec(`ALTER TABLE ${scratch} RENAME TO ${spec.table};`);
    if (!spec.autoincrement || sequence === null) continue;
    const current = db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = ?`).get(spec.table) as
      | { seq: number }
      | undefined;
    if (!current) {
      db.prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)`).run(spec.table, sequence);
    } else if (current.seq < sequence) {
      db.prepare(`UPDATE sqlite_sequence SET seq = ? WHERE name = ?`).run(sequence, spec.table);
    }
  }
}

export function applyOperatorOwnerActionCandidatesMigration(db: SQLiteDatabase): void {
  // Runs inside TaskLedger's BEGIN IMMEDIATE, or opens its own transaction
  // when invoked directly. Foreign keys stay ON throughout.
  db.exec('SAVEPOINT owner_action_candidates_migration');
  try {
    db.pragma('defer_foreign_keys = ON');
    const selected = REBUILDS.filter(
      (spec) => tableExists(db, spec.table) && !tableColumns(db, spec.table).has(spec.marker)
    );
    // Rebuilding the binding parent requires both receipt children to leave
    // the schema first. Include already-current children too and copy every
    // current column, so a partial prior migration cannot lose owner-run data.
    if (selected.some((spec) => spec.table === 'operator_external_task_bindings')) {
      for (const child of REBUILDS.slice(1)) {
        if (tableExists(db, child.table) && !selected.includes(child)) selected.push(child);
      }
    }
    const bindingParentRebuilt = selected.some(
      (spec) => spec.table === 'operator_external_task_bindings'
    );
    const prepared = REBUILDS.filter((spec) => selected.includes(spec)).map((spec) =>
      prepareTableRebuild(db, spec, bindingParentRebuilt)
    );
    if (prepared.length > 0) {
      swapPreparedTables(db, prepared);
      // Reinstall the partial unique indexes, receipt indexes, global identity
      // reservation triggers and immutability triggers the DROPs removed.
      applyOperatorTaskExternalLifecycleMigration(db);
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_operator_external_binding_receipts_origin_run
        ON operator_external_binding_receipts(origin_run_id, candidate_id);
      CREATE INDEX IF NOT EXISTS idx_operator_external_lifecycle_receipts_origin_run
        ON operator_external_lifecycle_receipts(origin_run_id, candidate_id);

      CREATE TABLE IF NOT EXISTS ${OWNER_ACTION_CANDIDATES_TABLE} (
        model_run_id TEXT NOT NULL CHECK (length(trim(model_run_id)) > 0),
        candidate_id TEXT NOT NULL CHECK (length(candidate_id) = 64),
        owner_scope TEXT NOT NULL CHECK (length(trim(owner_scope)) > 0),
        envelope_hash TEXT NOT NULL CHECK (length(trim(envelope_hash)) > 0),
        occurrence_key TEXT NOT NULL CHECK (length(trim(occurrence_key)) > 0),
        workorder_attempt_id INTEGER REFERENCES operator_tasks(id),
        candidate_kind TEXT NOT NULL CHECK (candidate_kind IN ('binding','lifecycle')),
        task_id INTEGER NOT NULL REFERENCES operator_tasks(id),
        event_id TEXT NOT NULL,
        candidate_json TEXT NOT NULL,
        candidate_sha256 TEXT NOT NULL CHECK (length(candidate_sha256) = 64),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (model_run_id, candidate_id)
      );
      CREATE INDEX IF NOT EXISTS idx_operator_owner_action_candidates_scope
        ON ${OWNER_ACTION_CANDIDATES_TABLE} (owner_scope, candidate_id);
      CREATE INDEX IF NOT EXISTS idx_operator_owner_action_candidates_task
        ON ${OWNER_ACTION_CANDIDATES_TABLE} (task_id);
      CREATE TRIGGER IF NOT EXISTS trg_operator_owner_action_candidates_immutable_update
      BEFORE UPDATE ON ${OWNER_ACTION_CANDIDATES_TABLE}
      BEGIN SELECT RAISE(ABORT, 'owner action candidates are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS trg_operator_owner_action_candidates_immutable_delete
      BEFORE DELETE ON ${OWNER_ACTION_CANDIDATES_TABLE}
      BEGIN SELECT RAISE(ABORT, 'owner action candidates are immutable'); END;
    `);
    for (const spec of REBUILDS) {
      if (!tableColumns(db, spec.table).has(spec.marker)) {
        throw new Error(`${spec.table} is still missing ${spec.marker} after migration`);
      }
    }
    db.exec('RELEASE owner_action_candidates_migration');
  } catch (error) {
    db.exec('ROLLBACK TO owner_action_candidates_migration');
    db.exec('RELEASE owner_action_candidates_migration');
    throw error;
  }
}
