/**
 * Migration 102 drops the tables of the modules mama-core 6.0.0 removed. Every other table keeps
 * its rows, and nothing left behind references a dropped table.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { applyMigrationsThrough } from '../helpers/test-utils.js';

const DROPPED = [
  'ranker_model_versions',
  'search_ranker_settings',
  'search_feedback',
  'channel_summaries',
  'channel_summary_state',
  'memory_truth',
];
const MIGRATION = join(
  __dirname,
  '..',
  '..',
  'db',
  'migrations',
  '102-drop-unused-module-tables.sql'
);

function tables(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
}

function rowCounts(db: Database.Database, names: string[]): Record<string, number> {
  return Object.fromEntries(
    names.map((name) => [
      name,
      (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n,
    ])
  );
}

describe('migration 102', () => {
  it('drops the removed modules tables and leaves every other table and row', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    try {
      applyMigrationsThrough(db, 101);
      for (const name of DROPPED) expect(tables(db)).toContain(name);
      db.prepare(
        "INSERT INTO memory_truth (memory_id, topic, truth_status, effective_summary, effective_details, trust_score, scope_refs, supporting_event_ids) VALUES ('m1', 't', 'active', 's', 'd', 0.5, '[]', '[]')"
      ).run();
      const kept = tables(db).filter(
        (name) => !DROPPED.includes(name) && !name.includes('_fts') && name !== 'schema_version'
      );
      const before = rowCounts(db, kept);

      db.exec(readFileSync(MIGRATION, 'utf8'));

      for (const name of DROPPED) expect(tables(db)).not.toContain(name);
      expect(rowCounts(db, kept)).toEqual(before);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(db.prepare('SELECT MAX(version) AS v FROM schema_version').get()).toEqual({ v: 102 });
    } finally {
      db.close();
    }
  });
});
