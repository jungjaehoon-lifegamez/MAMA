import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrationsThrough } from '../../src/test-utils.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
});

afterEach(() => {
  db.close();
});

function columns(): string[] {
  return (
    db.prepare('PRAGMA table_info(awareness_operational_issues)').all() as Array<{ name: string }>
  ).map((c) => c.name);
}

describe('Story ONE-MAMA-P3 Task 2: migration 066 awareness_operational_issues', () => {
  it('AC #1 creates the table with occurrences on a fresh database', () => {
    applyMigrationsThrough(db, 66);
    expect(columns()).toEqual([
      'issue_id',
      'dedupe_key',
      'surface',
      'severity',
      'status',
      'source_delta_id',
      'first_seen_at',
      'last_seen_at',
      'next_retry_at',
      'last_error',
      'owner_agent',
      'occurrences',
    ]);
    // applyMigrationsThrough executes the SQL only; version bookkeeping is the runtime adapter's job.
  });

  it('AC #2 adopts an installed table without occurrences and loses no row; the runtime adds the column', () => {
    applyMigrationsThrough(db, 65);
    // The owner's installed shape (retired chain): no occurrences column.
    db.exec(`
      CREATE TABLE awareness_operational_issues (
        issue_id TEXT PRIMARY KEY,
        dedupe_key TEXT UNIQUE NOT NULL,
        surface TEXT NOT NULL,
        severity TEXT NOT NULL,
        status TEXT NOT NULL,
        source_delta_id TEXT,
        first_seen_at INTEGER NOT NULL CHECK (first_seen_at >= 0),
        last_seen_at INTEGER NOT NULL CHECK (last_seen_at >= first_seen_at),
        next_retry_at INTEGER,
        last_error TEXT,
        owner_agent TEXT
      );
      INSERT INTO awareness_operational_issues
        (issue_id, dedupe_key, surface, severity, status, first_seen_at, last_seen_at)
        VALUES ('iss_1', 'k1', 'gateway', 'warn', 'open', 10, 20);
    `);
    applyMigrationsThrough(db, 66, 66);
    expect(columns()).not.toContain('occurrences'); // plain SQL cannot add it conditionally
    expect(db.prepare('SELECT count(*) AS n FROM awareness_operational_issues').get()).toEqual({
      n: 1,
    });
    // running the migration again is a no-op
    applyMigrationsThrough(db, 66, 66);
    expect(db.prepare('SELECT count(*) AS n FROM awareness_operational_issues').get()).toEqual({
      n: 1,
    });
  });
});
