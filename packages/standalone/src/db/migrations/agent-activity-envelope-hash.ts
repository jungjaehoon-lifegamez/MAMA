import type { SQLiteDatabase } from '../../sqlite.js';

export function applyAgentActivityEnvelopeColumnsMigration(db: SQLiteDatabase): void {
  const tableExists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_activity'")
    .get() as { 1: number } | undefined;

  if (!tableExists) {
    return;
  }

  const columns = (
    db.prepare('PRAGMA table_info(agent_activity)').all() as Array<{ name: string }>
  ).map((column) => column.name);

  if (!columns.includes('envelope_hash')) {
    db.exec('ALTER TABLE agent_activity ADD COLUMN envelope_hash TEXT');
  }
  if (!columns.includes('requested_scopes')) {
    db.exec('ALTER TABLE agent_activity ADD COLUMN requested_scopes TEXT');
  }
  if (!columns.includes('envelope_scopes_snapshot')) {
    db.exec('ALTER TABLE agent_activity ADD COLUMN envelope_scopes_snapshot TEXT');
  }
  if (!columns.includes('scope_mismatch')) {
    db.exec('ALTER TABLE agent_activity ADD COLUMN scope_mismatch INTEGER DEFAULT 0');
  }

  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_agent_activity_envelope_hash ON agent_activity(envelope_hash)'
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_agent_activity_scope_mismatch
     ON agent_activity(scope_mismatch, created_at)
     WHERE scope_mismatch = 1`
  );
}
