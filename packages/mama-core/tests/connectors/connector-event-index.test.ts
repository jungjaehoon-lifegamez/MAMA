import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getAdapter } from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import { deleteExpiredConnectorEvents } from '../../src/connectors/event-index.js';

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

  it('rejects invalid retention windows before deleting rows', () => {
    expect(() =>
      deleteExpiredConnectorEvents(getAdapter(), {
        nowMs: Date.parse('2026-04-18T00:00:00.000Z'),
        retentionMs: -1,
      })
    ).toThrow(/retentionMs must be a non-negative finite number/i);
  });
});
