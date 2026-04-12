import type { SQLiteDatabase } from '../../sqlite.js';

export function applyAgentActivityValidationColumnsMigration(db: SQLiteDatabase): void {
  const tableExists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_activity'")
    .get() as { 1: number } | undefined;

  if (!tableExists) {
    return;
  }

  const columns = (
    db.prepare('PRAGMA table_info(agent_activity)').all() as Array<{ name: string }>
  ).map((column) => column.name);

  if (!columns.includes('run_id')) {
    db.exec('ALTER TABLE agent_activity ADD COLUMN run_id TEXT');
  }
  if (!columns.includes('execution_status')) {
    db.exec('ALTER TABLE agent_activity ADD COLUMN execution_status TEXT');
  }
  if (!columns.includes('trigger_reason')) {
    db.exec('ALTER TABLE agent_activity ADD COLUMN trigger_reason TEXT');
  }
}
