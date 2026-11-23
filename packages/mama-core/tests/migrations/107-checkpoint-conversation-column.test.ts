/**
 * Migration 012 only creates the checkpoints table when it is missing. A database whose table was
 * made before `recent_conversation` existed kept the old shape through every later migration, so
 * each checkpoint save failed on the missing column. Migration 107 adds it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db-manager.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'mama-checkpoint-column-'));
  roots.push(root);
  return join(root, 'memory.db');
}

function read(path: string) {
  const db = new Database(path, { readonly: true });
  try {
    const columns = (
      db.prepare('PRAGMA table_info(checkpoints)').all() as Array<{ name: string }>
    ).map((column) => column.name);
    const rows = db.prepare('SELECT summary, recent_conversation FROM checkpoints').all();
    const stamped = db.prepare('SELECT 1 FROM schema_version WHERE version = 107').get();
    return { columns, rows, stamped: stamped !== undefined };
  } finally {
    db.close();
  }
}

describe('migration 107 checkpoint conversation column', () => {
  it('adds recent_conversation to a checkpoints table made before it existed', async () => {
    const path = tempPath();
    const old = new Database(path);
    old.exec(`
      CREATE TABLE checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        summary TEXT NOT NULL,
        open_files TEXT,
        next_steps TEXT,
        status TEXT DEFAULT 'active'
      );
      INSERT INTO checkpoints (timestamp, summary) VALUES (1, 'fixture checkpoint');
    `);
    old.close();

    const handle = await openDatabase({ path });
    handle.adapter.disconnect();

    const state = read(path);
    expect(state.columns).toContain('recent_conversation');
    expect(state.rows).toEqual([{ summary: 'fixture checkpoint', recent_conversation: '[]' }]);
    expect(state.stamped).toBe(true);
  });

  it('leaves a database that already has the column as it was, and stamps 107', async () => {
    const path = tempPath();
    const handle = await openDatabase({ path });
    handle.adapter.disconnect();

    const state = read(path);
    expect(state.columns.filter((name) => name === 'recent_conversation')).toHaveLength(1);
    expect(state.stamped).toBe(true);
  });
});
