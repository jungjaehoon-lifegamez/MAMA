import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getAdapter } from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import { upsertConnectorEventIndex } from '../../src/connectors/event-index.js';

// Migration 067: connector_event_index carries source_entity_id so change history can be read by
// entity (grant-bounded) through the same core index the agent already searches.
describe('Migration 067: connector_event_index.source_entity_id', () => {
  let testDbPath = '';

  beforeAll(async () => {
    testDbPath = await initTestDB('conn-event-entity-id');
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  it('adds the source_entity_id column and its lookup index', () => {
    const columns = (
      getAdapter().prepare('PRAGMA table_info(connector_event_index)').all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(columns).toContain('source_entity_id');

    const index = getAdapter()
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_connector_event_source_entity'"
      )
      .get();
    expect(index).toBeTruthy();
  });

  it('stores an explicit source_entity_id and defaults it to the source_id when absent', () => {
    upsertConnectorEventIndex(getAdapter(), {
      source_connector: 'drive',
      source_type: 'document',
      source_id: 'file:v1',
      source_entity_id: 'file',
      content: 'draft A',
      source_timestamp_ms: Date.parse('2026-09-07T00:00:00.000Z'),
      memory_scope_kind: 'project',
      memory_scope_id: 'alpha',
    });
    const row = getAdapter()
      .prepare(
        'SELECT source_entity_id FROM connector_event_index WHERE source_connector = ? AND source_id = ?'
      )
      .get('drive', 'file:v1') as { source_entity_id: string | null };
    expect(row.source_entity_id).toBe('file');
  });
});
