
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { applyMigrationsThrough } from '../../src/test-utils.js';
function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((col) => col.name)
    .sort();
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function triggerExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name = ?")
    .get(name) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function insertConnectorEvent(
  db: Database.Database,
  overrides: Partial<{
    event_index_id: string;
    source_connector: string;
    source_id: string;
    title: string | null;
    content: string;
    content_hash: Buffer;
    artifact_locator: string | null;
    expires_at: string | null;
  }> = {}
): void {
  const now = '2026-04-18T00:00:00.000Z';
  db.prepare(
    `
      INSERT INTO connector_event_index (
        event_index_id, source_connector, source_type, source_id, source_locator,
        channel, author, title, content, event_datetime, event_date, source_timestamp_ms,
        metadata_json, artifact_locator, artifact_title, content_hash, indexed_at, updated_at,
        expires_at
      )
      VALUES (?, ?, 'message', ?, 'slack://C1/1', 'C1', 'alice', ?, ?, 1710000000000,
              '2026-04-18', 1710000000000, '{}', ?, 'Artifact', ?, ?, ?, ?)
    `
  ).run(
    overrides.event_index_id ?? 'evt-index-1',
    overrides.source_connector ?? 'slack',
    overrides.source_id ?? 'source-1',
    overrides.title ?? 'Launch update',
    overrides.content ?? 'Launch content from connector',
    overrides.artifact_locator ?? null,
    overrides.content_hash ?? Buffer.alloc(32, 1),
    now,
    now,
    overrides.expires_at ?? null
  );
}

describe('case-first substrate — connector_event_index schema', () => {
  it('creates connector index tables on apply', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 30);

    expect(tableExists(db, 'connector_event_index')).toBe(true);
    expect(tableExists(db, 'connector_event_index_cursors')).toBe(true);
    expect(tableExists(db, 'connector_event_index_fts')).toBe(true);

    db.close();
  });

  it('creates every connector_event_index column required by amendment 9', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 30);

    expect(columnNames(db, 'connector_event_index')).toEqual(
      [
        'artifact_locator',
        'artifact_title',
        'author',
        'channel',
        'content',
        'content_hash',
        'event_date',
        'event_datetime',
        'event_index_id',
        'expires_at',
        'indexed_at',
        'metadata_json',
        'source_connector',
        'source_id',
        'source_locator',
        'source_timestamp_ms',
        'source_type',
        'title',
        'updated_at',
      ].sort()
    );

    db.close();
  });

  it('creates the FTS table and insert/update/delete triggers', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 30);

    expect(tableExists(db, 'connector_event_index_fts')).toBe(true);
    expect(triggerExists(db, 'trg_connector_event_index_ai')).toBe(true);
    expect(triggerExists(db, 'trg_connector_event_index_au')).toBe(true);
    expect(triggerExists(db, 'trg_connector_event_index_ad')).toBe(true);

    // Seed with content-unique tokens so we can verify AU trigger rebuilds
    // FTS rows on update. Title is indexed too; use tokens that only exist
    // in content to isolate content-column behavior.
    insertConnectorEvent(db, { content: 'originaltoken body text' });
    const ftsHit = db
      .prepare(
        `SELECT event_index_id
         FROM connector_event_index_fts
         WHERE connector_event_index_fts MATCH 'originaltoken'`
      )
      .get() as { event_index_id: string } | undefined;
    expect(ftsHit?.event_index_id).toBe('evt-index-1');

    db.prepare(
      "UPDATE connector_event_index SET content = 'replacedtoken body text' WHERE event_index_id = ?"
    ).run('evt-index-1');
    const oldHit = db
      .prepare(
        `SELECT event_index_id
         FROM connector_event_index_fts
         WHERE connector_event_index_fts MATCH 'originaltoken'`
      )
      .get() as { event_index_id: string } | undefined;
    const newHit = db
      .prepare(
        `SELECT event_index_id
         FROM connector_event_index_fts
         WHERE connector_event_index_fts MATCH 'replacedtoken'`
      )
      .get() as { event_index_id: string } | undefined;
    expect(oldHit).toBeUndefined();
    expect(newHit?.event_index_id).toBe('evt-index-1');

    db.prepare('DELETE FROM connector_event_index WHERE event_index_id = ?').run('evt-index-1');
    const deletedHit = db
      .prepare(
        `SELECT event_index_id
         FROM connector_event_index_fts
         WHERE connector_event_index_fts MATCH 'roadmap'`
      )
      .get() as { event_index_id: string } | undefined;
    expect(deletedHit).toBeUndefined();

    db.close();
  });

  it('enforces unique source identity on source_connector plus source_id', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 30);

    insertConnectorEvent(db, { event_index_id: 'evt-index-1', source_id: 'same-source' });
    expect(() =>
      insertConnectorEvent(db, { event_index_id: 'evt-index-2', source_id: 'same-source' })
    ).toThrow(/UNIQUE constraint/i);

    expect(() =>
      insertConnectorEvent(db, {
        event_index_id: 'evt-index-3',
        source_connector: 'discord',
        source_id: 'same-source',
      })
    ).not.toThrow();

    db.close();
  });

  it('creates replay-safe cursor columns with defaults', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 30);

    expect(columnNames(db, 'connector_event_index_cursors')).toEqual(
      [
        'connector_name',
        'indexed_count',
        'last_error',
        'last_error_at',
        'last_seen_source_id',
        'last_seen_timestamp_ms',
        'last_success_at',
        'last_sweep_at',
      ].sort()
    );

    db.prepare('INSERT INTO connector_event_index_cursors (connector_name) VALUES (?)').run(
      'slack'
    );
    const cursor = db
      .prepare(
        `SELECT last_seen_timestamp_ms, last_seen_source_id, indexed_count
         FROM connector_event_index_cursors
         WHERE connector_name = ?`
      )
      .get('slack') as {
      last_seen_timestamp_ms: number;
      last_seen_source_id: string;
      indexed_count: number;
    };

    expect(cursor.last_seen_timestamp_ms).toBe(0);
    expect(cursor.last_seen_source_id).toBe('');
    expect(cursor.indexed_count).toBe(0);

    db.close();
  });

  it('enforces 32-byte content_hash and keeps artifact and retention columns writable', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrationsThrough(db, 30);

    expect(() => insertConnectorEvent(db, { content_hash: Buffer.from('short') })).toThrow(
      /CHECK constraint/i
    );

    expect(() =>
      insertConnectorEvent(db, {
        event_index_id: 'evt-index-artifact',
        source_id: 'artifact-source',
        artifact_locator: 'obsidian://cases/alpha.md',
        expires_at: '2026-07-17T00:00:00.000Z',
      })
    ).not.toThrow();

    const row = db
      .prepare(
        `SELECT artifact_locator, artifact_title, expires_at
         FROM connector_event_index
         WHERE event_index_id = ?`
      )
      .get('evt-index-artifact') as {
      artifact_locator: string;
      artifact_title: string;
      expires_at: string;
    };

    expect(row.artifact_locator).toBe('obsidian://cases/alpha.md');
    expect(row.artifact_title).toBe('Artifact');
    expect(row.expires_at).toBe('2026-07-17T00:00:00.000Z');

    db.close();
  });

});
