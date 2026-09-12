import type { SQLiteDatabase } from '../../sqlite.js';

/**
 * Additive storage for input-independent owner action receipts (Task E).
 *
 * One row per (owner namespace, host-derived occurrence, logical action). The
 * row is reserved BEFORE the effect runs and can only move
 * transmitting -> unknown | confirmed; confirmed is final.
 *
 * Origin (v0.29 / T0.A): a receipt names WHAT authorized the attempt - a model
 * run OR a service/CLI operation. `origin_model_run_id` and `origin_operation_id`
 * are both nullable, but a CHECK requires at least one valid (nonempty) origin,
 * so a receipt can never exist unattributed. A model-backed legacy caller keeps
 * writing `origin_model_run_id` and reading back exactly as before; the operation
 * origin is what lets a truthful host operation reserve a receipt without a model
 * run. The origin is audit/identity metadata: a later authorized attempt of the
 * same occurrence reconciles this row instead of creating another effect.
 *
 * This table is separate from the legacy integer batch-keyed
 * `owner_event_effects` table, which is neither read, altered, nor migrated
 * here. Nothing in this migration is destructive; it is safe to run on every
 * open, including on a database that already carries the table. A database
 * carrying the pre-origin shape (origin_model_run_id NOT NULL, no
 * origin_operation_id) is rebuilt in place, preserving every existing row,
 * index and confirmed receipt.
 */
export const OWNER_ACTION_EFFECTS_TABLE = 'owner_action_effects';

const REQUIRED_COLUMNS = [
  'owner_scope',
  'occurrence_key',
  'action_key',
  'effect_kind',
  'status',
  'intent_json',
  'intent_sha256',
  'result_json',
  'last_error',
  'origin_model_run_id',
  'origin_operation_id',
  'origin_envelope_hash',
  'origin_workorder_attempt_id',
  'settled_model_run_id',
  'created_at',
  'updated_at',
] as const;

// Nonempty-origin CHECK, kept identical in the DDL and the verification so they
// cannot drift. Normalizing (drop whitespace, lowercase) makes the assertion
// resilient to formatting while still pinning both origin columns and the
// at-least-one-origin invariant.
const AT_LEAST_ONE_ORIGIN_CHECK = `CHECK (
      (origin_model_run_id IS NOT NULL AND length(trim(origin_model_run_id)) > 0)
      OR (origin_operation_id IS NOT NULL AND length(trim(origin_operation_id)) > 0)
    )`;

// PRIMARY KEY is kept the LAST clause so an external "drop the PK" edit removes
// it (and its leading comma) without leaving a dangling comma.
function ownerActionEffectsTableDDL(tableName: string): string {
  return `CREATE TABLE ${tableName} (
      owner_scope TEXT NOT NULL CHECK (length(trim(owner_scope)) > 0),
      occurrence_key TEXT NOT NULL CHECK (length(trim(occurrence_key)) > 0),
      action_key TEXT NOT NULL CHECK (length(trim(action_key)) > 0),
      effect_kind TEXT NOT NULL CHECK (length(trim(effect_kind)) > 0),
      status TEXT NOT NULL CHECK (status IN ('transmitting','unknown','confirmed')),
      intent_json TEXT NOT NULL,
      intent_sha256 TEXT NOT NULL,
      result_json TEXT,
      last_error TEXT,
      origin_model_run_id TEXT CHECK (origin_model_run_id IS NULL OR length(trim(origin_model_run_id)) > 0),
      origin_operation_id TEXT CHECK (origin_operation_id IS NULL OR length(trim(origin_operation_id)) > 0),
      origin_envelope_hash TEXT NOT NULL CHECK (length(trim(origin_envelope_hash)) > 0),
      origin_workorder_attempt_id INTEGER,
      settled_model_run_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ${AT_LEAST_ONE_ORIGIN_CHECK},
      PRIMARY KEY (owner_scope, occurrence_key, action_key)
    )`;
}

// Confirmed receipts are immutable and undeletable. These triggers are the
// enforcement; they are created on a fresh table AND re-created inside the
// rebuild transaction so a completed migration never leaves a confirmed receipt
// even momentarily unprotected. Kept in one place so both paths agree.
function protectionTriggersDDL(tableName: string): string {
  return `
    CREATE TRIGGER IF NOT EXISTS owner_action_effects_confirmed_immutable
    BEFORE UPDATE ON ${tableName} WHEN OLD.status = 'confirmed'
    BEGIN SELECT RAISE(ABORT, 'confirmed owner action receipt is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS owner_action_effects_confirmed_no_delete
    BEFORE DELETE ON ${tableName} WHEN OLD.status = 'confirmed'
    BEGIN SELECT RAISE(ABORT, 'confirmed owner action receipt is immutable'); END;
  `;
}

const REQUIRED_PROTECTION_TRIGGERS = [
  'owner_action_effects_confirmed_immutable',
  'owner_action_effects_confirmed_no_delete',
] as const;

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, '').toLowerCase();
}

function tableColumnInfo(
  db: SQLiteDatabase,
  tableName: string
): Array<{ name: string; type: string; notnull: number }> {
  return db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
  }>;
}

function tableSql(db: SQLiteDatabase, tableName: string): string {
  const row = db
    .prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?')
    .get('table', tableName) as { sql?: string } | undefined;
  return row?.sql ?? '';
}

/**
 * True when the existing table already carries the operation-origin shape:
 * both origin columns present, origin_model_run_id nullable, and the
 * at-least-one-origin CHECK in place. Never inferred from a version number.
 */
function hasOperationOriginShape(db: SQLiteDatabase): boolean {
  const info = tableColumnInfo(db, OWNER_ACTION_EFFECTS_TABLE);
  const names = new Set(info.map((column) => column.name));
  if (!names.has('origin_model_run_id') || !names.has('origin_operation_id')) {
    return false;
  }
  const modelRunColumn = info.find((column) => column.name === 'origin_model_run_id');
  if (!modelRunColumn || modelRunColumn.notnull !== 0) {
    return false;
  }
  return normalizeSql(tableSql(db, OWNER_ACTION_EFFECTS_TABLE)).includes(
    normalizeSql(AT_LEAST_ONE_ORIGIN_CHECK)
  );
}

/**
 * Rebuild a pre-origin table in place. FK enforcement is disabled OUTSIDE the
 * transaction (SQLite refuses to toggle it inside one) and restored in finally;
 * a foreign_key_check guards the swap. Every existing row is copied (legacy
 * rows carry origin_operation_id = NULL, satisfying the CHECK through their
 * model run), and every non-auto index is recreated from its stored DDL.
 */
function rebuildForOperationOrigins(db: SQLiteDatabase): void {
  const previousForeignKeys = db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      const oldColumns = new Set(
        tableColumnInfo(db, OWNER_ACTION_EFFECTS_TABLE).map((column) => column.name)
      );
      const carried = [
        'owner_scope',
        'occurrence_key',
        'action_key',
        'effect_kind',
        'status',
        'intent_json',
        'intent_sha256',
        'result_json',
        'last_error',
        'origin_model_run_id',
        'origin_envelope_hash',
        'origin_workorder_attempt_id',
        'settled_model_run_id',
        'created_at',
        'updated_at',
      ].filter((column) => oldColumns.has(column));
      const columnList = carried.join(', ');

      const indexSqls = (
        db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL"
          )
          .all(OWNER_ACTION_EFFECTS_TABLE) as Array<{ sql: string }>
      ).map((row) => row.sql);

      // Preserve any custom/existing triggers (including the confirmed-immutable
      // and no-delete protections) so DROP TABLE does not leave the rebuilt
      // table unprotected. Re-created INSIDE this transaction, before commit.
      const triggerSqls = (
        db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name=? AND sql IS NOT NULL"
          )
          .all(OWNER_ACTION_EFFECTS_TABLE) as Array<{ sql: string }>
      ).map((row) => row.sql);

      db.exec(ownerActionEffectsTableDDL(`${OWNER_ACTION_EFFECTS_TABLE}_origin_new`));
      db.exec(
        `INSERT INTO ${OWNER_ACTION_EFFECTS_TABLE}_origin_new (${columnList})
           SELECT ${columnList} FROM ${OWNER_ACTION_EFFECTS_TABLE}`
      );
      db.exec(`DROP TABLE ${OWNER_ACTION_EFFECTS_TABLE}`);
      db.exec(
        `ALTER TABLE ${OWNER_ACTION_EFFECTS_TABLE}_origin_new RENAME TO ${OWNER_ACTION_EFFECTS_TABLE}`
      );
      for (const sql of indexSqls) {
        db.exec(sql.replace(/^CREATE\s+INDEX/i, 'CREATE INDEX IF NOT EXISTS'));
      }
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_owner_action_effects_pending
           ON ${OWNER_ACTION_EFFECTS_TABLE} (owner_scope, occurrence_key, status, created_at, action_key)`
      );
      // Re-create preserved triggers, then guarantee the two protections exist
      // even if the old table had lost them - all before the transaction commits.
      for (const sql of triggerSqls) {
        db.exec(sql.replace(/^CREATE\s+TRIGGER/i, 'CREATE TRIGGER IF NOT EXISTS'));
      }
      db.exec(protectionTriggersDDL(OWNER_ACTION_EFFECTS_TABLE));

      const violations = db.pragma(`foreign_key_check(${OWNER_ACTION_EFFECTS_TABLE})`) as unknown[];
      if (violations.length > 0) {
        throw new Error(`${OWNER_ACTION_EFFECTS_TABLE} rebuild left foreign key violations`);
      }
      // Validate the rebuilt state BEFORE commit: the origin shape must be right
      // and both confirmed-receipt protections must be present. A migration that
      // reaches commit therefore never leaves receipts durably unprotected.
      if (!hasOperationOriginShape(db)) {
        throw new Error(`${OWNER_ACTION_EFFECTS_TABLE} rebuild did not produce the origin shape`);
      }
      assertProtectionTriggersPresent(db);
    }, 'immediate')();
  } finally {
    db.pragma(`foreign_keys = ${previousForeignKeys ? 'ON' : 'OFF'}`);
  }
}

function assertProtectionTriggersPresent(db: SQLiteDatabase): void {
  const present = new Set(
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=?")
        .all(OWNER_ACTION_EFFECTS_TABLE) as Array<{ name: string }>
    ).map((row) => row.name)
  );
  const missing = REQUIRED_PROTECTION_TRIGGERS.filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new Error(
      `${OWNER_ACTION_EFFECTS_TABLE} is missing confirmed-receipt protection trigger(s): ${missing.join(', ')}`
    );
  }
}

export function applyOwnerActionEffectsMigration(db: SQLiteDatabase): void {
  // `CREATE TABLE IF NOT EXISTS ...` via the shared DDL builder (the table-name
  // argument carries the IF NOT EXISTS guard). No-op on an existing table.
  db.exec(`
    ${ownerActionEffectsTableDDL(`IF NOT EXISTS ${OWNER_ACTION_EFFECTS_TABLE}`)};
    CREATE INDEX IF NOT EXISTS idx_owner_action_effects_pending
      ON ${OWNER_ACTION_EFFECTS_TABLE} (owner_scope, occurrence_key, status, created_at, action_key);
  `);

  // A database carrying the pre-origin shape is rebuilt before verification.
  if (!hasOperationOriginShape(db)) {
    rebuildForOperationOrigins(db);
  }

  // Fail loudly rather than run against a same-named table with a different
  // shape: a silent partial schema would make receipts unreadable.
  const columns = new Set(
    (
      db.prepare(`PRAGMA table_info(${OWNER_ACTION_EFFECTS_TABLE})`).all() as Array<{
        name: string;
      }>
    ).map((column) => column.name)
  );
  const missing = REQUIRED_COLUMNS.filter((column) => !columns.has(column));
  if (missing.length > 0) {
    throw new Error(
      `${OWNER_ACTION_EFFECTS_TABLE} exists without required column(s): ${missing.join(', ')}`
    );
  }
  const info = db.prepare(`PRAGMA table_info(${OWNER_ACTION_EFFECTS_TABLE})`).all() as Array<{
    name: string;
    pk: number;
    notnull: number;
  }>;
  const primaryKey = info
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name);
  if (primaryKey.join(',') !== 'owner_scope,occurrence_key,action_key') {
    throw new Error(`${OWNER_ACTION_EFFECTS_TABLE} has an invalid receipt primary key`);
  }
  const nullable = new Set([
    'result_json',
    'last_error',
    'origin_model_run_id',
    'origin_operation_id',
    'origin_workorder_attempt_id',
    'settled_model_run_id',
  ]);
  if (info.some((column) => !nullable.has(column.name) && column.notnull !== 1)) {
    throw new Error(`${OWNER_ACTION_EFFECTS_TABLE} is missing a required NOT NULL constraint`);
  }
  const schema = db
    .prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?')
    .get('table', OWNER_ACTION_EFFECTS_TABLE) as { sql: string };
  const normalized = normalizeSql(schema.sql);
  const checks = [
    "check(statusin('transmitting','unknown','confirmed'))",
    ...['owner_scope', 'occurrence_key', 'action_key', 'effect_kind', 'origin_envelope_hash'].map(
      (column) => `check(length(trim(${column}))>0)`
    ),
    // At least one valid (nonempty) origin: a receipt is never unattributed.
    normalizeSql(AT_LEAST_ONE_ORIGIN_CHECK),
  ];
  if (checks.some((check) => !normalized.includes(check))) {
    throw new Error(`${OWNER_ACTION_EFFECTS_TABLE} is missing a required CHECK constraint`);
  }
  // The fresh-create path guarantees the protections here (the rebuild path
  // already created them inside its transaction); assert they exist afterwards.
  db.exec(protectionTriggersDDL(OWNER_ACTION_EFFECTS_TABLE));
  assertProtectionTriggersPresent(db);
}
