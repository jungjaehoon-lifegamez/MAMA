import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getAdapter } from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import {
  getConnectorEventIndexRecord,
  upsertConnectorEventIndex,
} from '../../src/connectors/event-index.js';

function columnInfo(table: string): Map<string, string> {
  const rows = getAdapter().prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    type: string;
  }>;
  return new Map(rows.map((row) => [row.name, row.type]));
}

function indexExists(indexName: string): boolean {
  const row = getAdapter()
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?")
    .get(indexName) as { name?: string } | undefined;
  return row?.name === indexName;
}

describe('Story M2.3: Connector raw provenance', () => {
  let testDbPath = '';

  beforeAll(async () => {
    testDbPath = await initTestDB('connector-raw-provenance');
  });

  beforeEach(() => {
    const adapter = getAdapter();
    adapter.prepare('DELETE FROM connector_event_index_cursors').run();
    adapter.prepare('DELETE FROM connector_event_index').run();
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  describe('AC #1: connector_event_index carries scope and cursor metadata', () => {
    it('creates nullable scope columns without duplicating content_hash', () => {
      const columns = columnInfo('connector_event_index');

      expect(columns.get('content_hash')?.toUpperCase()).toBe('BLOB');
      expect(columns.get('source_cursor')).toBe('TEXT');
      expect(columns.get('tenant_id')).toBe('TEXT');
      expect(columns.get('project_id')).toBe('TEXT');
      expect(columns.get('memory_scope_kind')).toBe('TEXT');
      expect(columns.get('memory_scope_id')).toBe('TEXT');
      expect(indexExists('idx_connector_event_scope')).toBe(true);
      expect(indexExists('idx_connector_event_source_cursor')).toBe(true);
    });

    it('round-trips connector provenance fields through upsert and read helpers', () => {
      const adapter = getAdapter();
      const saved = upsertConnectorEventIndex(adapter, {
        source_connector: 'slack',
        source_type: 'message',
        source_id: 'slack-msg-1',
        source_locator: 'slack://team/channel/1',
        source_cursor: 'cursor-2026-04-29T04:00:00Z',
        tenant_id: 'tenant-alpha',
        project_id: 'project-a',
        memory_scope_kind: 'project',
        memory_scope_id: 'scope-project-a',
        content: 'Decision provenance raw event',
        event_datetime: Date.parse('2026-04-29T04:00:00.000Z'),
      });

      expect(saved.source_cursor).toBe('cursor-2026-04-29T04:00:00Z');
      expect(saved.tenant_id).toBe('tenant-alpha');
      expect(saved.project_id).toBe('project-a');
      expect(saved.memory_scope_kind).toBe('project');
      expect(saved.memory_scope_id).toBe('scope-project-a');

      const reloaded = getConnectorEventIndexRecord(adapter, 'slack', 'slack-msg-1');
      expect(reloaded).toMatchObject({
        source_cursor: 'cursor-2026-04-29T04:00:00Z',
        tenant_id: 'tenant-alpha',
        project_id: 'project-a',
        memory_scope_kind: 'project',
        memory_scope_id: 'scope-project-a',
      });
      expect(reloaded?.content_hash.byteLength).toBe(32);
    });
  });
});
