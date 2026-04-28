import type { SQLiteDatabase } from '../../sqlite.js';

export function applyEnvelopeTablesMigration(db: SQLiteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS envelopes (
      envelope_hash      TEXT PRIMARY KEY,
      instance_id        TEXT NOT NULL UNIQUE,
      parent_instance_id TEXT,
      agent_id           TEXT NOT NULL,
      source             TEXT NOT NULL,
      channel_id         TEXT,
      trigger_context    TEXT NOT NULL,
      scope              TEXT NOT NULL,
      tier               INTEGER NOT NULL CHECK (tier IN (1, 2, 3)),
      budget             TEXT NOT NULL,
      expires_at         TEXT NOT NULL,
      signature          TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_envelopes_parent ON envelopes(parent_instance_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_envelopes_agent ON envelopes(agent_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_envelopes_expires ON envelopes(expires_at)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS system_config_versions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      kind        TEXT NOT NULL,
      key_id      TEXT,
      key_version INTEGER,
      payload     TEXT NOT NULL,
      actor_id    TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_sysconfig_kind ON system_config_versions(kind, key_id, key_version)'
  );
}
