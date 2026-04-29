import type { SQLiteDatabase } from '../../sqlite.js';

export function applyAgentActivityGatewayCallIdMigration(db: SQLiteDatabase): void {
  const tableExists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_activity'")
    .get() as { 1: number } | undefined;

  if (!tableExists) {
    return;
  }

  const columns = (
    db.prepare('PRAGMA table_info(agent_activity)').all() as Array<{ name: string }>
  ).map((column) => column.name);

  if (!columns.includes('gateway_call_id')) {
    db.exec('ALTER TABLE agent_activity ADD COLUMN gateway_call_id TEXT');
  }

  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_agent_activity_gateway_call_id ON agent_activity(gateway_call_id)'
  );
}
