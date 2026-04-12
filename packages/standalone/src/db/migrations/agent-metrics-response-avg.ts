import type { SQLiteDatabase } from '../../sqlite.js';

export function applyAgentMetricsResponseAverageMigration(db: SQLiteDatabase): void {
  const tableExists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_metrics'")
    .get();

  if (!tableExists) {
    return;
  }

  const columns = (
    db.prepare('PRAGMA table_info(agent_metrics)').all() as Array<{ name: string }>
  ).map((column) => column.name);

  if (!columns.includes('response_ms_sum')) {
    db.exec('ALTER TABLE agent_metrics ADD COLUMN response_ms_sum REAL DEFAULT 0');
  }
  if (!columns.includes('response_count')) {
    db.exec('ALTER TABLE agent_metrics ADD COLUMN response_count INTEGER DEFAULT 0');
  }
}
