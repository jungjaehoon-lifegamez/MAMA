import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getAdapter } from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import {
  deleteExpiredConnectorEvents,
  searchConnectorEventsByFTS,
  upsertConnectorEventIndex,
} from '../../src/connectors/event-index.js';

describe('connector event index behavior', () => {
  let testDbPath = '';

  beforeAll(async () => {
    testDbPath = await initTestDB('connector-event-index');
  });

  beforeEach(() => {
    const adapter = getAdapter();
    adapter.prepare('DELETE FROM connector_event_index_cursors').run();
    adapter.prepare('DELETE FROM connector_event_index').run();
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  it('preserves relevance differences when converting BM25 rank to score', () => {
    const adapter = getAdapter();
    upsertConnectorEventIndex(adapter, {
      source_connector: 'slack',
      source_type: 'message',
      source_id: 'evt-strong',
      source_locator: 'slack://alpha/1',
      content: 'alpha alpha alpha rollout checkpoint',
      event_datetime: Date.parse('2026-04-18T01:00:00.000Z'),
    });
    upsertConnectorEventIndex(adapter, {
      source_connector: 'slack',
      source_type: 'message',
      source_id: 'evt-weak',
      source_locator: 'slack://alpha/2',
      content: 'alpha mention',
      event_datetime: Date.parse('2026-04-18T00:00:00.000Z'),
    });

    const results = searchConnectorEventsByFTS(adapter, 'alpha', { limit: 10 });

    expect(results).toHaveLength(2);
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  it('rejects invalid retention windows before deleting rows', () => {
    expect(() =>
      deleteExpiredConnectorEvents(getAdapter(), {
        nowMs: Date.parse('2026-04-18T00:00:00.000Z'),
        retentionMs: -1,
      })
    ).toThrow(/retentionMs must be a non-negative finite number/i);
  });
});
