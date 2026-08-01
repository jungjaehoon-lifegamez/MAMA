import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { upsertConnectorEventIndex } from '../../src/connectors/event-index.js';
import { getAdapter } from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';

describe('Story M2.5: refreshed connector observation sequences', () => {
  let testDbPath = '';

  beforeAll(async () => {
    testDbPath = await initTestDB('operator-ingest-seq-update');
  });

  beforeEach(() => {
    const adapter = getAdapter();
    adapter.prepare('DELETE FROM connector_event_index_cursors').run();
    adapter.prepare('DELETE FROM connector_event_index_operator_seq_cursors').run();
    const observationCursorTable = adapter
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get('connector_event_index_observation_cursors') as { name?: string } | undefined;
    if (observationCursorTable?.name === 'connector_event_index_observation_cursors') {
      adapter.prepare('DELETE FROM connector_event_index_observation_cursors').run();
    }
    adapter.prepare('DELETE FROM connector_event_index').run();
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  describe('AC #1: stable observations retain their sequence allocation', () => {
    it('allocates new partition and connector-wide sequences only when the stable observation changes', () => {
      const adapter = getAdapter();
      const base = {
        source_connector: 'kagemusha',
        source_type: 'kanban_card',
        source_id: 'task:42',
        channel: 'room-a',
        content: 'status:pending',
        source_timestamp_ms: Date.parse('2026-08-02T00:00:00.000Z'),
        metadata: { taskId: 42, status: 'pending', rawConnector: 'kagemusha' },
      } as const;

      const first = upsertConnectorEventIndex(adapter, base);
      const identical = upsertConnectorEventIndex(adapter, base);
      const changed = upsertConnectorEventIndex(adapter, {
        ...base,
        content: 'status:done',
        metadata: { ...base.metadata, status: 'done' },
      });

      expect(first.operator_ingest_seq).toBe(1);
      expect(first.operator_observation_seq).toBe(1);
      expect(identical.operator_ingest_seq).toBe(first.operator_ingest_seq);
      expect(identical.operator_observation_seq).toBe(first.operator_observation_seq);
      expect(changed.event_index_id).toBe(first.event_index_id);
      expect(changed.operator_ingest_seq).toBeGreaterThan(first.operator_ingest_seq);
      expect(changed.operator_observation_seq).toBeGreaterThan(first.operator_observation_seq);
    });
  });

  describe('AC #2: connector-wide ordinals order channel moves', () => {
    it('allocates a new partition sequence and a newer global ordinal for an equal-timestamp move', () => {
      const adapter = getAdapter();
      const first = upsertConnectorEventIndex(adapter, {
        source_connector: 'kagemusha',
        source_type: 'kanban_card',
        source_id: 'task:43',
        channel: 'room-a',
        content: 'status:pending',
        source_timestamp_ms: 1_775_260_800_000,
      });
      const moved = upsertConnectorEventIndex(adapter, {
        source_connector: 'kagemusha',
        source_type: 'kanban_card',
        source_id: 'task:43',
        channel: 'room-b',
        content: 'status:pending',
        source_timestamp_ms: 1_775_260_800_000,
      });

      expect(moved.operator_ingest_seq).toBe(1);
      expect(moved.operator_observation_seq).toBeGreaterThan(first.operator_observation_seq);
    });
  });
});
