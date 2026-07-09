/**
 * Unit tests for ConnectorDeltaRepo (M1-T1 - real delta source over connector_event_index).
 * Inline content columns (migration 030:523-543), per-(source_connector, COALESCE(channel,''))
 * cursor (migration 039). Seeded schema mirrors the real table; cursors persist to a JSON
 * file (as in ~/.mama) so a second repo instance resumes where the first committed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { ConnectorDeltaRepo } from '../../src/operator/connector-delta-repo.js';

function seedSchema(db: SQLiteDatabase): void {
  db.exec(`
    CREATE TABLE connector_event_index (
      event_index_id TEXT PRIMARY KEY,
      source_connector TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      channel TEXT,
      author TEXT,
      content TEXT NOT NULL,
      source_timestamp_ms INTEGER NOT NULL,
      operator_ingest_seq INTEGER
    );
  `);
}

function seedRow(
  db: SQLiteDatabase,
  id: string,
  connector: string,
  channel: string | null,
  seq: number,
  content: string,
  ts = 1000
): void {
  db.prepare(
    `INSERT INTO connector_event_index
       (event_index_id, source_connector, source_type, source_id, channel, author, content, source_timestamp_ms, operator_ingest_seq)
     VALUES (?, ?, 'message', ?, ?, 'someone', ?, ?, ?)`
  ).run(id, connector, id, channel, content, ts, seq);
}

describe('ConnectorDeltaRepo', () => {
  let db: SQLiteDatabase;
  let tmp: string;
  let cursorPath: string;

  beforeEach(() => {
    db = new Database(':memory:');
    seedSchema(db);
    tmp = mkdtempSync(join(tmpdir(), 'delta-repo-'));
    cursorPath = join(tmp, 'cursors.json');
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('drains real content per partition, ordered by operator_ingest_seq', () => {
    seedRow(db, 'e1', 'slack', 'ch-a', 1, 'first in a', 100);
    seedRow(db, 'e2', 'slack', 'ch-a', 2, 'second in a', 200);
    seedRow(db, 'e3', 'slack', 'ch-b', 1, 'first in b', 150);
    const repo = new ConnectorDeltaRepo(db, cursorPath);
    const events = repo.drainNew(10);
    expect(events).toHaveLength(3);
    const chA = events.filter((e) => e.channelId === 'ch-a');
    expect(chA.map((e) => e.content)).toEqual(['first in a', 'second in a']);
    expect(events.every((e) => e.channel === 'slack' && e.role === 'user')).toBe(true);
    expect(events.find((e) => e.content === 'first in b')?.eventIndexId).toBe('e3');
    expect(typeof events[0].id).toBe('number');
  });

  it('commit advances per-partition cursors: no replay, no cross-channel skip', () => {
    // Same seq values in two partitions - the scalar-cursor bug this design fixes.
    seedRow(db, 'a1', 'slack', 'ch-a', 1, 'a1');
    seedRow(db, 'a2', 'slack', 'ch-a', 2, 'a2');
    seedRow(db, 'b1', 'slack', 'ch-b', 1, 'b1');
    const repo = new ConnectorDeltaRepo(db, cursorPath);
    const first = repo.drainNew(10);
    expect(first).toHaveLength(3);
    repo.commit(first);
    expect(repo.drainNew(10)).toEqual([]);

    // New rows continue each partition independently.
    seedRow(db, 'a3', 'slack', 'ch-a', 3, 'a3');
    seedRow(db, 'b2', 'slack', 'ch-b', 2, 'b2');
    const second = repo.drainNew(10);
    expect(second.map((e) => e.content).sort()).toEqual(['a3', 'b2']);
  });

  it('uncommitted drain is re-delivered (at-least-once)', () => {
    seedRow(db, 'e1', 'slack', 'ch-a', 1, 'once');
    const repo = new ConnectorDeltaRepo(db, cursorPath);
    expect(repo.drainNew(10)).toHaveLength(1);
    // no commit -> same event drains again
    expect(repo.drainNew(10)).toHaveLength(1);
  });

  it('cursors persist across repo instances (JSON file)', () => {
    seedRow(db, 'e1', 'slack', 'ch-a', 1, 'one');
    const repo1 = new ConnectorDeltaRepo(db, cursorPath);
    repo1.commit(repo1.drainNew(10));
    const repo2 = new ConnectorDeltaRepo(db, cursorPath);
    expect(repo2.drainNew(10)).toEqual([]);
  });

  it('NULL channel partitions via COALESCE to empty string', () => {
    seedRow(db, 'n1', 'imessage', null, 1, 'dm hello');
    const repo = new ConnectorDeltaRepo(db, cursorPath);
    const events = repo.drainNew(10);
    expect(events).toHaveLength(1);
    expect(events[0].channelId).toBe('');
    repo.commit(events);
    expect(repo.drainNew(10)).toEqual([]);
  });

  it('missing connector_event_index table throws (no-fallback)', () => {
    const bare = new Database(':memory:');
    const repo = new ConnectorDeltaRepo(bare, join(tmp, 'c2.json'));
    expect(() => repo.drainNew(10)).toThrow();
    bare.close();
  });
});
