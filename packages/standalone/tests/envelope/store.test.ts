import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from '../../src/sqlite.js';
import { applyEnvelopeTablesMigration } from '../../src/db/migrations/envelope-tables.js';

describe('envelope migration', () => {
  it('creates envelopes and system_config_versions tables', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mama-envmig-'));
    const db = new Database(join(dir, 't.db'));

    try {
      applyEnvelopeTablesMigration(db);

      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('envelopes','system_config_versions')"
        )
        .all() as { name: string }[];

      expect(tables.map((table) => table.name).sort()).toEqual([
        'envelopes',
        'system_config_versions',
      ]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
