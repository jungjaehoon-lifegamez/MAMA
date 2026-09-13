import type { SQLiteDatabase } from '../sqlite.js';

/** Preserve legacy source locators while adding explicit entity and revision identity. */
export function applyRawItemRevisionsMigration(db: SQLiteDatabase): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const columns = new Set(
      (db.prepare('PRAGMA table_info(raw_items)').all() as Array<{ name: string }>).map(
        (row) => row.name
      )
    );
    for (const name of ['origin_source_id', 'source_entity_id', 'revision_hash']) {
      if (!columns.has(name)) {
        db.exec(`ALTER TABLE raw_items ADD COLUMN ${name} TEXT`);
      }
    }
    if (!columns.has('origin_source_id')) {
      db.exec('UPDATE raw_items SET origin_source_id = source_id');
    }
    if (!columns.has('source_entity_id')) {
      db.exec('UPDATE raw_items SET source_entity_id = source_id');
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_raw_items_entity_revision ON raw_items(source_entity_id, id);
      CREATE INDEX IF NOT EXISTS idx_raw_items_origin_revision
        ON raw_items(origin_source_id, id);
    `);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

interface LegacyPendingRow {
  sequence: number;
  observed_at: number;
  source_id: string;
  source_entity_id: string;
  source: string;
  channel: string;
  author: string;
  content: string;
  timestamp: number;
  type: string;
  metadata: string | null;
  content_hash: string | null;
  source_cursor: string | null;
  tenant_id: string | null;
  project_id: string | null;
  memory_scope_kind: string | null;
  memory_scope_id: string | null;
}

function legacyPendingPayload(row: LegacyPendingRow): string {
  let metadata: Record<string, unknown> | undefined;
  if (row.metadata !== null) {
    try {
      metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`Legacy pending metadata is malformed at local sequence ${row.sequence}`, {
        cause: error,
      });
    }
  }
  return JSON.stringify({
    source: row.source,
    sourceId: row.source_id,
    sourceEntityId: row.source_entity_id,
    channel: row.channel,
    author: row.author,
    content: row.content,
    timestamp: row.timestamp,
    type: row.type,
    ...(metadata === undefined ? {} : { metadata }),
    ...(row.content_hash === null ? {} : { contentHash: row.content_hash }),
    ...(row.source_cursor === null ? {} : { sourceCursor: row.source_cursor }),
    ...(row.tenant_id === null ? {} : { tenantId: row.tenant_id }),
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
    ...(row.memory_scope_kind === null ? {} : { memoryScopeKind: row.memory_scope_kind }),
    ...(row.memory_scope_id === null ? {} : { memoryScopeId: row.memory_scope_id }),
    observedAt: row.observed_at,
  });
}

/** Convert the legacy raw-row join queue into immutable payload snapshots. */
export function applyPendingProjectionSnapshotsMigration(db: SQLiteDatabase): void {
  const columns = new Set(
    (
      db.prepare('PRAGMA table_info(pending_core_projections)').all() as Array<{ name: string }>
    ).map((row) => row.name)
  );
  if (columns.has('payload_hash') && columns.has('payload_json')) {
    return;
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const rows = db
      .prepare(
        `SELECT p.sequence, p.observed_at, r.source_id, r.source_entity_id, r.source,
              r.channel, r.author, r.content, r.timestamp, r.type, r.metadata, r.content_hash,
              r.source_cursor, r.tenant_id, r.project_id, r.memory_scope_kind, r.memory_scope_id
         FROM pending_core_projections p
         JOIN raw_items r ON r.source_id = p.raw_source_id
        ORDER BY p.sequence`
      )
      .all() as LegacyPendingRow[];
    db.exec(`
    DROP INDEX IF EXISTS idx_pending_core_projection_sequence;
    ALTER TABLE pending_core_projections RENAME TO pending_core_projections_legacy;
    CREATE TABLE pending_core_projections (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_source_id TEXT NOT NULL REFERENCES raw_items(source_id),
      payload_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      UNIQUE(raw_source_id, payload_hash)
    );
    CREATE INDEX idx_pending_core_projection_sequence ON pending_core_projections(sequence);
  `);
    const insert = db.prepare(
      `INSERT INTO pending_core_projections
       (sequence, raw_source_id, payload_hash, payload_json, observed_at)
     VALUES (?, ?, ?, ?, ?)`
    );
    for (const row of rows) {
      const payload = legacyPendingPayload(row);
      insert.run(row.sequence, row.source_id, `legacy:${row.sequence}`, payload, row.observed_at);
    }
    db.exec('DROP TABLE pending_core_projections_legacy');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
