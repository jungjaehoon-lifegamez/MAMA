import type { SQLiteDatabase } from '../../sqlite.js';

/**
 * Additive storage for input-independent owner action receipts (Task E).
 *
 * One row per (owner namespace, host-derived occurrence, logical action). The
 * row is reserved BEFORE the effect runs and can only move
 * transmitting -> unknown | confirmed; confirmed is final. The originating
 * model run / envelope are audit metadata: a later authorized attempt of the
 * same occurrence reconciles this row instead of creating another effect.
 *
 * This table is separate from the legacy integer batch-keyed
 * `owner_event_effects` table, which is neither read, altered, nor migrated
 * here. Nothing in this migration is destructive; it is safe to run on every
 * open, including on a database that already carries the table.
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
  'origin_envelope_hash',
  'origin_workorder_attempt_id',
  'settled_model_run_id',
  'created_at',
  'updated_at',
] as const;

export function applyOwnerActionEffectsMigration(db: SQLiteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${OWNER_ACTION_EFFECTS_TABLE} (
      owner_scope TEXT NOT NULL CHECK (length(trim(owner_scope)) > 0),
      occurrence_key TEXT NOT NULL CHECK (length(trim(occurrence_key)) > 0),
      action_key TEXT NOT NULL CHECK (length(trim(action_key)) > 0),
      effect_kind TEXT NOT NULL CHECK (length(trim(effect_kind)) > 0),
      status TEXT NOT NULL CHECK (status IN ('transmitting','unknown','confirmed')),
      intent_json TEXT NOT NULL,
      intent_sha256 TEXT NOT NULL,
      result_json TEXT,
      last_error TEXT,
      origin_model_run_id TEXT NOT NULL CHECK (length(trim(origin_model_run_id)) > 0),
      origin_envelope_hash TEXT NOT NULL CHECK (length(trim(origin_envelope_hash)) > 0),
      origin_workorder_attempt_id INTEGER,
      settled_model_run_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (owner_scope, occurrence_key, action_key)
    );
    CREATE INDEX IF NOT EXISTS idx_owner_action_effects_pending
      ON ${OWNER_ACTION_EFFECTS_TABLE} (owner_scope, occurrence_key, status, created_at, action_key);
  `);

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
    'origin_workorder_attempt_id',
    'settled_model_run_id',
  ]);
  if (info.some((column) => !nullable.has(column.name) && column.notnull !== 1)) {
    throw new Error(`${OWNER_ACTION_EFFECTS_TABLE} is missing a required NOT NULL constraint`);
  }
  const schema = db
    .prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?')
    .get('table', OWNER_ACTION_EFFECTS_TABLE) as { sql: string };
  const normalized = schema.sql.toLowerCase().replace(/\s+/g, '');
  const checks = [
    "check(statusin('transmitting','unknown','confirmed'))",
    ...[
      'owner_scope',
      'occurrence_key',
      'action_key',
      'effect_kind',
      'origin_model_run_id',
      'origin_envelope_hash',
    ].map((column) => `check(length(trim(${column}))>0)`),
  ];
  if (checks.some((check) => !normalized.includes(check))) {
    throw new Error(`${OWNER_ACTION_EFFECTS_TABLE} is missing a required CHECK constraint`);
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS owner_action_effects_confirmed_immutable
    BEFORE UPDATE ON ${OWNER_ACTION_EFFECTS_TABLE} WHEN OLD.status = 'confirmed'
    BEGIN SELECT RAISE(ABORT, 'confirmed owner action receipt is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS owner_action_effects_confirmed_no_delete
    BEFORE DELETE ON ${OWNER_ACTION_EFFECTS_TABLE} WHEN OLD.status = 'confirmed'
    BEGIN SELECT RAISE(ABORT, 'confirmed owner action receipt is immutable'); END;
  `);
}
