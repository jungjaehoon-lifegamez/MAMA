import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeSQLiteAdapter } from '../../src/db-adapter/node-sqlite-adapter.js';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');
const tempPaths = new Set<string>();

function tempDbPath(): string {
  const path = join(os.tmpdir(), `test-vector-status-filter-${randomUUID()}.db`);
  tempPaths.add(path);
  return path;
}

afterEach(() => {
  for (const path of tempPaths) {
    for (const file of [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]) {
      try {
        fs.unlinkSync(file);
      } catch {
        // best effort
      }
    }
  }
  tempPaths.clear();
});

function vec(seed: number): Float32Array {
  const v = new Float32Array(1024);
  v[0] = 1;
  v[1] = seed * 0.001;
  return v;
}

function seedDecision(
  adapter: NodeSQLiteAdapter,
  id: string,
  status: string | null,
  outcome: string | null,
  seed: number
): number {
  adapter
    .prepare(
      `INSERT INTO decisions (id, topic, decision, status, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(id, `topic-${id}`, `decision text ${id}`, status, outcome, Date.now());
  const row = adapter.prepare(`SELECT rowid FROM decisions WHERE id = ?`).get(id) as {
    rowid: number;
  };
  adapter.insertEmbedding(row.rowid, vec(seed));
  return row.rowid;
}

function setupAdapter(): NodeSQLiteAdapter {
  const adapter = new NodeSQLiteAdapter({ dbPath: tempDbPath() });
  adapter.connect();
  (adapter as unknown as { runMigrations: (dir: string) => void }).runMigrations(MIGRATIONS_DIR);
  return adapter;
}

describe('Story R1: vectorSearch status pre-filter', () => {
  describe('AC #1: excludeStatuses skips superseded/stale rows at search time', () => {
    it('returns all rows without the filter and only non-excluded rows with it', () => {
      const adapter = setupAdapter();
      const activeRid = seedDecision(adapter, 'a1', 'active', null, 1);
      seedDecision(adapter, 's1', 'superseded', null, 2);
      seedDecision(adapter, 's2', null, 'stale', 3); // status NULL -> outcome fallback

      const unfiltered = adapter.vectorSearch(vec(1), 5);
      expect(unfiltered).not.toBeNull();
      expect(unfiltered!.length).toBe(3);

      const filtered = adapter.vectorSearch(vec(1), 5, undefined, [
        'superseded',
        'quarantined',
        'contradicted',
        'stale',
      ]);
      expect(filtered).not.toBeNull();
      expect(filtered!.map((r) => r.rowid)).toEqual([activeRid]);
      adapter.disconnect();
    });
  });

  describe('AC #2: the status cache follows reloadVectorCache after status changes', () => {
    it('excludes a row that was superseded after the initial cache load', () => {
      const adapter = setupAdapter();
      const rid1 = seedDecision(adapter, 'a1', 'active', null, 1);
      const rid2 = seedDecision(adapter, 'a2', 'active', null, 2);

      const excluded = ['superseded', 'quarantined', 'contradicted', 'stale'];
      const before = adapter.vectorSearch(vec(1), 5, undefined, excluded);
      expect(before!.map((r) => r.rowid).sort()).toEqual([rid1, rid2].sort());

      adapter.prepare(`UPDATE decisions SET status = 'superseded' WHERE id = 'a2'`).run();
      adapter.reloadVectorCache();

      const after = adapter.vectorSearch(vec(1), 5, undefined, excluded);
      expect(after!.map((r) => r.rowid)).toEqual([rid1]);
      adapter.disconnect();
    });
  });
});
