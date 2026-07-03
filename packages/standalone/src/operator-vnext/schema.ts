import type { SQLiteDatabase } from '../sqlite.js';

const VNEXT_OPERATOR_CONTRACTS_VERSION = 38;
const VNEXT_OPERATOR_CONTRACTS_DESCRIPTION = 'Create vNext operator contracts';
const REQUIRED_OPERATOR_TABLES = [
  'vnext_operator_cursors',
  'vnext_operator_commits',
  'operator_no_updates',
  'worker_proposals',
  'operator_memory_commit_intents',
] as const;
const REQUIRED_COLUMNS: Record<(typeof REQUIRED_OPERATOR_TABLES)[number], readonly string[]> = {
  vnext_operator_cursors: [
    'cursor_name',
    'last_change_seq',
    'last_idempotency_key',
    'updated_at_ms',
  ],
  vnext_operator_commits: [
    'commit_id',
    'cursor_name',
    'idempotency_key',
    'first_change_seq',
    'last_change_seq',
    'status',
    'changed_refs_json',
    'source_refs_json',
    'created_at_ms',
  ],
  operator_no_updates: [
    'no_update_id',
    'scope_key',
    'reason',
    'source_refs_json',
    'idempotency_key',
    'created_at_ms',
  ],
  worker_proposals: [
    'proposal_id',
    'worker_id',
    'kind',
    'payload_json',
    'source_refs_json',
    'confidence',
    'status',
    'created_at_ms',
    'accepted_at_ms',
  ],
  operator_memory_commit_intents: [
    'intent_id',
    'cursor_name',
    'idempotency_key',
    'expected_memory_count',
    'memory_payload_hash',
    'memory_ids_json',
    'source_refs_json',
    'status',
    'claim_token',
    'created_at_ms',
    'updated_at_ms',
  ],
};
const REQUIRED_INDEXES = [
  'idx_vnext_operator_commits_cursor_seq',
  'idx_operator_no_updates_scope_created',
  'idx_worker_proposals_status_kind',
  'idx_operator_memory_commit_intents_cursor_created',
] as const;
const OPERATOR_MEMORY_COMMIT_INTENT_BASE_SQL_FRAGMENTS = [
  'idempotency_key TEXT NOT NULL UNIQUE',
  'expected_memory_count INTEGER NOT NULL CHECK (expected_memory_count > 0)',
  "memory_payload_hash TEXT NOT NULL CHECK (memory_payload_hash LIKE 'sha256:%')",
  'memory_ids_json TEXT NOT NULL CHECK (json_valid(memory_ids_json))',
  'source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json))',
  "status TEXT NOT NULL CHECK (status IN ('pending', 'saving', 'saved', 'promoted'))",
  'created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)',
  'updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)',
] as const;
const OPERATOR_MEMORY_COMMIT_INTENT_CLAIM_SQL_FRAGMENTS = [
  "(status = 'saving' AND claim_token IS NOT NULL)",
  "(status != 'saving' AND claim_token IS NULL)",
] as const;
const REQUIRED_TABLE_SQL_FRAGMENTS: Partial<
  Record<(typeof REQUIRED_OPERATOR_TABLES)[number], readonly string[]>
> = {
  operator_memory_commit_intents: [
    ...OPERATOR_MEMORY_COMMIT_INTENT_BASE_SQL_FRAGMENTS,
    ...OPERATOR_MEMORY_COMMIT_INTENT_CLAIM_SQL_FRAGMENTS,
  ],
};
const SQLITE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const VNEXT_OPERATOR_CONTRACTS_SQL = `
CREATE TABLE IF NOT EXISTS vnext_operator_cursors (
  cursor_name TEXT PRIMARY KEY,
  last_change_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_change_seq >= 0),
  last_idempotency_key TEXT,
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
);

CREATE TABLE IF NOT EXISTS vnext_operator_commits (
  commit_id TEXT PRIMARY KEY,
  cursor_name TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  first_change_seq INTEGER NOT NULL CHECK (first_change_seq >= 0),
  last_change_seq INTEGER NOT NULL CHECK (last_change_seq >= first_change_seq),
  status TEXT NOT NULL CHECK (status IN ('changed', 'no_update')),
  changed_refs_json TEXT NOT NULL CHECK (json_valid(changed_refs_json)),
  source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  FOREIGN KEY (cursor_name) REFERENCES vnext_operator_cursors(cursor_name)
);

CREATE INDEX IF NOT EXISTS idx_vnext_operator_commits_cursor_seq
  ON vnext_operator_commits(cursor_name, last_change_seq);

CREATE TABLE IF NOT EXISTS operator_no_updates (
  no_update_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
);

CREATE INDEX IF NOT EXISTS idx_operator_no_updates_scope_created
  ON operator_no_updates(scope_key, created_at_ms DESC);

CREATE TABLE IF NOT EXISTS worker_proposals (
  proposal_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'rejected', 'superseded')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  accepted_at_ms INTEGER CHECK (
    (status = 'proposed' AND accepted_at_ms IS NULL) OR
    (status = 'accepted' AND accepted_at_ms IS NOT NULL AND accepted_at_ms >= created_at_ms) OR
    (status = 'rejected' AND accepted_at_ms IS NULL) OR
    (status = 'superseded' AND (accepted_at_ms IS NULL OR accepted_at_ms >= created_at_ms))
  )
);

CREATE INDEX IF NOT EXISTS idx_worker_proposals_status_kind
  ON worker_proposals(status, kind, created_at_ms);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (${VNEXT_OPERATOR_CONTRACTS_VERSION}, '${VNEXT_OPERATOR_CONTRACTS_DESCRIPTION}');

CREATE TABLE IF NOT EXISTS operator_memory_commit_intents (
  intent_id TEXT PRIMARY KEY,
  cursor_name TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  expected_memory_count INTEGER NOT NULL CHECK (expected_memory_count > 0),
  memory_payload_hash TEXT NOT NULL CHECK (memory_payload_hash LIKE 'sha256:%'),
  memory_ids_json TEXT NOT NULL CHECK (json_valid(memory_ids_json)),
  source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'saving', 'saved', 'promoted')),
  claim_token TEXT CHECK (
    (status = 'saving' AND claim_token IS NOT NULL) OR
    (status != 'saving' AND claim_token IS NULL)
  ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
);

CREATE INDEX IF NOT EXISTS idx_operator_memory_commit_intents_cursor_created
  ON operator_memory_commit_intents(cursor_name, created_at_ms DESC);
`;

const OPERATOR_MEMORY_COMMIT_INTENT_CLAIM_MIGRATION_SQL = `
DROP TABLE IF EXISTS operator_memory_commit_intents_v041;

CREATE TABLE operator_memory_commit_intents_v041 (
  intent_id TEXT PRIMARY KEY,
  cursor_name TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  expected_memory_count INTEGER NOT NULL CHECK (expected_memory_count > 0),
  memory_payload_hash TEXT NOT NULL CHECK (memory_payload_hash LIKE 'sha256:%'),
  memory_ids_json TEXT NOT NULL CHECK (json_valid(memory_ids_json)),
  source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'saving', 'saved', 'promoted')),
  claim_token TEXT CHECK (
    (status = 'saving' AND claim_token IS NOT NULL) OR
    (status != 'saving' AND claim_token IS NULL)
  ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
);

INSERT INTO operator_memory_commit_intents_v041 (
  intent_id,
  cursor_name,
  idempotency_key,
  expected_memory_count,
  memory_payload_hash,
  memory_ids_json,
  source_refs_json,
  status,
  claim_token,
  created_at_ms,
  updated_at_ms
)
SELECT
  intent_id,
  cursor_name,
  idempotency_key,
  expected_memory_count,
  memory_payload_hash,
  memory_ids_json,
  source_refs_json,
  CASE
    WHEN status = 'saving' AND claim_token IS NULL THEN 'pending'
    ELSE status
  END,
  CASE
    WHEN status = 'saving' AND claim_token IS NOT NULL THEN claim_token
    ELSE NULL
  END,
  created_at_ms,
  updated_at_ms
FROM operator_memory_commit_intents;

DROP TABLE operator_memory_commit_intents;
ALTER TABLE operator_memory_commit_intents_v041 RENAME TO operator_memory_commit_intents;

CREATE INDEX IF NOT EXISTS idx_operator_memory_commit_intents_cursor_created
  ON operator_memory_commit_intents(cursor_name, created_at_ms DESC);
`;

export interface VNextOperatorSchemaOptions {
  readMigrationSql?: () => string;
}

function tableExists(db: SQLiteDatabase, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return row !== undefined;
}

function hasOperatorSchemaVersion(db: SQLiteDatabase): boolean {
  if (!tableExists(db, 'schema_version')) {
    return false;
  }
  const row = db
    .prepare('SELECT 1 FROM schema_version WHERE version = ?')
    .get(VNEXT_OPERATOR_CONTRACTS_VERSION);
  return row !== undefined;
}

function indexExists(db: SQLiteDatabase, indexName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(indexName);
  return row !== undefined;
}

function tableColumns(db: SQLiteDatabase, tableName: string): Set<string> {
  if (!SQLITE_IDENTIFIER_PATTERN.test(tableName)) {
    throw new Error(`Invalid SQLite identifier: ${tableName}`);
  }
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return new Set(columns.map((column) => column.name));
}

function tableSql(db: SQLiteDatabase, tableName: string): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { sql?: string } | undefined;
  return row?.sql ?? '';
}

function tableHasSqlFragments(
  db: SQLiteDatabase,
  tableName: (typeof REQUIRED_OPERATOR_TABLES)[number],
  fragments: readonly string[]
): boolean {
  const sql = tableSql(db, tableName);
  return fragments.every((fragment) => sql.includes(fragment));
}

function migrateOperatorMemoryCommitIntentClaimInvariant(db: SQLiteDatabase): void {
  const tableName = 'operator_memory_commit_intents';
  if (!tableExists(db, tableName)) {
    return;
  }
  if (tableHasSqlFragments(db, tableName, OPERATOR_MEMORY_COMMIT_INTENT_CLAIM_SQL_FRAGMENTS)) {
    return;
  }
  const columns = tableColumns(db, tableName);
  if (!REQUIRED_COLUMNS[tableName].every((column) => columns.has(column))) {
    return;
  }
  if (!tableHasSqlFragments(db, tableName, OPERATOR_MEMORY_COMMIT_INTENT_BASE_SQL_FRAGMENTS)) {
    return;
  }
  db.exec(OPERATOR_MEMORY_COMMIT_INTENT_CLAIM_MIGRATION_SQL);
}

function assertTableSqlCompatible(
  db: SQLiteDatabase,
  tableName: (typeof REQUIRED_OPERATOR_TABLES)[number]
): void {
  const fragments = REQUIRED_TABLE_SQL_FRAGMENTS[tableName] ?? [];
  if (fragments.length === 0) {
    return;
  }
  const sql = tableSql(db, tableName);
  for (const fragment of fragments) {
    if (!sql.includes(fragment)) {
      throw new Error(
        `vNext operator schema table ${tableName} is missing SQL fragment ${fragment}`
      );
    }
  }
}

function assertOperatorSchemaCompatible(db: SQLiteDatabase): void {
  for (const table of REQUIRED_OPERATOR_TABLES) {
    if (!tableExists(db, table)) {
      throw new Error(`vNext operator schema is missing table ${table}`);
    }
    const columns = tableColumns(db, table);
    for (const column of REQUIRED_COLUMNS[table]) {
      if (!columns.has(column)) {
        throw new Error(`vNext operator schema table ${table} is missing column ${column}`);
      }
    }
    assertTableSqlCompatible(db, table);
  }
  for (const index of REQUIRED_INDEXES) {
    if (!indexExists(db, index)) {
      throw new Error(`vNext operator schema is missing index ${index}`);
    }
  }
}

function assertExistingOperatorTablesCompatible(db: SQLiteDatabase): void {
  for (const table of REQUIRED_OPERATOR_TABLES) {
    if (!tableExists(db, table)) {
      continue;
    }
    const columns = tableColumns(db, table);
    for (const column of REQUIRED_COLUMNS[table]) {
      if (!columns.has(column)) {
        throw new Error(`vNext operator schema table ${table} is missing column ${column}`);
      }
    }
    assertTableSqlCompatible(db, table);
  }
}

function hasInstalledOperatorSchema(db: SQLiteDatabase): boolean {
  if (!hasOperatorSchemaVersion(db)) {
    return false;
  }
  assertExistingOperatorTablesCompatible(db);
  if (!REQUIRED_OPERATOR_TABLES.every((table) => tableExists(db, table))) {
    return false;
  }
  assertOperatorSchemaCompatible(db);
  return true;
}

function ensureSchemaVersionDescriptionColumn(db: SQLiteDatabase): void {
  const columns = db.prepare('PRAGMA table_info(schema_version)').all() as Array<{ name: string }>;
  const hasDescription = columns.some((column) => column.name === 'description');
  if (!hasDescription) {
    db.exec('ALTER TABLE schema_version ADD COLUMN description TEXT');
  }
}

export function ensureVNextOperatorSchema(
  db: SQLiteDatabase,
  options: VNextOperatorSchemaOptions = {}
): void {
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER DEFAULT (unixepoch() * 1000),
        description TEXT
      )
    `);
    ensureSchemaVersionDescriptionColumn(db);
    migrateOperatorMemoryCommitIntentClaimInvariant(db);
    if (hasInstalledOperatorSchema(db)) {
      return;
    }
    const migrationSql = options.readMigrationSql?.() ?? VNEXT_OPERATOR_CONTRACTS_SQL;
    db.exec(migrationSql);
    migrateOperatorMemoryCommitIntentClaimInvariant(db);
    assertOperatorSchemaCompatible(db);
  });
  tx();
}
