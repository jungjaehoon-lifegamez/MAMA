import type { SQLiteDatabase } from '../../sqlite.js';

export function applyTokenUsageAgentVersionMigration(db: SQLiteDatabase): void {
  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'token_usage'")
    .get() as { name?: string } | undefined;
  if (!tableExists?.name) {
    return;
  }

  const columns = (
    db.prepare('PRAGMA table_info(token_usage)').all() as Array<{ name: string }>
  ).map((column) => column.name);

  if (!columns.includes('agent_version')) {
    db.exec('ALTER TABLE token_usage ADD COLUMN agent_version INTEGER');
  }
}
