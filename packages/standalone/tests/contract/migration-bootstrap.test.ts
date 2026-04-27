import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from '../../src/sqlite.js';
import { initAgentTables } from '../../src/db/agent-store.js';

describe('migration bootstrap', () => {
  it('real bootstrap path applies envelope migration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mama-boot-'));
    const db = new Database(join(dir, 'real.db'));

    try {
      initAgentTables(db);

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
