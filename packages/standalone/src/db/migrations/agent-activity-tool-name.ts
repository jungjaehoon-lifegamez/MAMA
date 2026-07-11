import type { SQLiteDatabase } from '../../sqlite.js';

/**
 * M8: gateway_tool_call rows carry a queryable tool name (the reconcile
 * verifier matches obligated tools against it). CREATE TABLE IF NOT EXISTS is
 * a no-op on existing tables, so this must be an explicit guarded ALTER.
 */
export function applyAgentActivityToolNameMigration(db: SQLiteDatabase): void {
  const tableExists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_activity'")
    .get() as { 1: number } | undefined;

  if (!tableExists) {
    return;
  }

  const columns = (
    db.prepare('PRAGMA table_info(agent_activity)').all() as Array<{ name: string }>
  ).map((column) => column.name);

  if (!columns.includes('tool_name')) {
    db.exec('ALTER TABLE agent_activity ADD COLUMN tool_name TEXT');
  }
  if (!columns.includes('normalized_tool_name')) {
    db.exec('ALTER TABLE agent_activity ADD COLUMN normalized_tool_name TEXT');
  }
}
