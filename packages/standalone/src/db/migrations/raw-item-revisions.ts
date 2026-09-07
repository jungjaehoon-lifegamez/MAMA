import type { SQLiteDatabase } from '../../sqlite.js';

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
      if (!columns.has(name)) db.exec(`ALTER TABLE raw_items ADD COLUMN ${name} TEXT`);
    }
    if (!columns.has('origin_source_id'))
      db.exec('UPDATE raw_items SET origin_source_id = source_id');
    if (!columns.has('source_entity_id'))
      db.exec('UPDATE raw_items SET source_entity_id = source_id');
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
