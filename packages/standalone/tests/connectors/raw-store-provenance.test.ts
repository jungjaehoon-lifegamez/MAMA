import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RawStore } from '../../src/connectors/framework/raw-store.js';
import type { NormalizedItem } from '../../src/connectors/framework/types.js';
import Database from '../../src/sqlite.js';

function columnNames(dbPath: string): string[] {
  const db = new Database(dbPath);
  const columns = (db.prepare('PRAGMA table_info(raw_items)').all() as Array<{ name: string }>).map(
    (column) => column.name
  );
  db.close();
  return columns.sort();
}

function rawRow(dbPath: string, sourceId: string): Record<string, unknown> {
  const db = new Database(dbPath);
  const row = db.prepare('SELECT * FROM raw_items WHERE source_id = ?').get(sourceId) as Record<
    string,
    unknown
  >;
  db.close();
  return row;
}

function provenanceItem(overrides: Partial<NormalizedItem> = {}): NormalizedItem {
  return {
    source: 'slack',
    sourceId: 'slack-msg-1',
    channel: 'project-a',
    author: 'user-1',
    content: 'Ship M2 provenance',
    timestamp: new Date('2026-04-29T04:00:00.000Z'),
    type: 'message',
    contentHash: 'a'.repeat(64),
    sourceCursor: 'cursor-1',
    tenantId: 'tenant-alpha',
    projectId: 'project-a',
    memoryScopeKind: 'project',
    memoryScopeId: 'scope-project-a',
    ...overrides,
  };
}

describe('Story M2.3: RawStore provenance persistence', () => {
  let tempDir: string;
  let store: RawStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mama-raw-store-provenance-'));
    store = new RawStore(tempDir);
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('AC #1: raw_items stores connector scope and cursor metadata', () => {
    it('creates provenance columns and round-trips them through query and getRecent', () => {
      store.save('slack', [provenanceItem()]);

      const dbPath = join(tempDir, 'slack', 'raw.db');
      expect(columnNames(dbPath)).toEqual(
        expect.arrayContaining([
          'content_hash',
          'source_cursor',
          'tenant_id',
          'project_id',
          'memory_scope_kind',
          'memory_scope_id',
        ])
      );

      const queried = store.query('slack', new Date('2026-04-29T03:59:00.000Z'));
      const recent = store.getRecent('slack', 1);

      for (const item of [queried[0], recent[0]]) {
        expect(item).toMatchObject({
          contentHash: 'a'.repeat(64),
          sourceCursor: 'cursor-1',
          tenantId: 'tenant-alpha',
          projectId: 'project-a',
          memoryScopeKind: 'project',
          memoryScopeId: 'scope-project-a',
        });
      }
    });

    it('computes lowercase SHA-256 content hashes when none are supplied', () => {
      store.save('slack', [provenanceItem({ contentHash: undefined })]);

      const [saved] = store.getRecent('slack', 1);
      expect(saved.contentHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('rejects ambiguous caller-supplied content hashes', () => {
      expect(() => store.save('slack', [provenanceItem({ contentHash: 'ABC' })])).toThrow(
        /lowercase 64-character SHA-256 hex string/
      );
    });

    it('upgrades a legacy raw_items row and updates provenance on source_id conflict', () => {
      const connectorDir = join(tempDir, 'slack');
      mkdirSync(connectorDir, { recursive: true });
      const dbPath = join(connectorDir, 'raw.db');
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE raw_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id TEXT NOT NULL UNIQUE,
          source TEXT NOT NULL,
          channel TEXT NOT NULL,
          author TEXT NOT NULL,
          content TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          type TEXT NOT NULL,
          metadata TEXT,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
        );
        INSERT INTO raw_items
          (source_id, source, channel, author, content, timestamp, type, metadata)
        VALUES
          ('slack-msg-1', 'slack', 'legacy', 'legacy-user', 'legacy content', 1, 'message', NULL);
      `);
      db.close();

      store.save('slack', [
        provenanceItem({
          channel: 'project-a',
          content: 'updated content',
          sourceCursor: 'cursor-updated',
        }),
      ]);

      const upgraded = rawRow(dbPath, 'slack-msg-1');
      expect(upgraded.content).toBe('legacy content');
      expect(upgraded.content_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(upgraded.source_cursor).toBe('cursor-updated');
      expect(upgraded.tenant_id).toBe('tenant-alpha');
      expect(upgraded.project_id).toBe('project-a');
      expect(upgraded.memory_scope_kind).toBe('project');
      expect(upgraded.memory_scope_id).toBe('scope-project-a');
    });

    it('backfills legacy rows without inventing unknown scope values', () => {
      const connectorDir = join(tempDir, 'slack');
      mkdirSync(connectorDir, { recursive: true });
      const dbPath = join(connectorDir, 'raw.db');
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE raw_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id TEXT NOT NULL UNIQUE,
          source TEXT NOT NULL,
          channel TEXT NOT NULL,
          author TEXT NOT NULL,
          content TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          type TEXT NOT NULL,
          metadata TEXT,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
        );
        INSERT INTO raw_items
          (source_id, source, channel, author, content, timestamp, type, metadata)
        VALUES
          ('slack-msg-legacy', 'slack', 'legacy', 'legacy-user', 'legacy content', 1, 'message', NULL);
      `);
      db.close();

      const updated = store.backfillProvenance('slack', {
        sourceCursor: 'cursor-backfill',
      });

      expect(updated).toBe(1);
      const upgraded = rawRow(dbPath, 'slack-msg-legacy');
      expect(upgraded.content_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(upgraded.source_cursor).toBe('cursor-backfill');
      expect(upgraded.tenant_id).toBeNull();
      expect(upgraded.project_id).toBeNull();
      expect(upgraded.memory_scope_kind).toBeNull();
      expect(upgraded.memory_scope_id).toBeNull();
    });
  });
});
