import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';

import { appendMemoryEvent, listMemoryEventsForTopic } from '../../src/memory/event-store.js';

const TEST_DB = '/tmp/test-memory-v2-event-store.db';

describe('memory event store', () => {
  beforeAll(() => {
    [TEST_DB, `${TEST_DB}-journal`, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((file) => {
      try {
        fs.unlinkSync(file);
      } catch {
        /* cleanup */
      }
    });

    process.env.MAMA_DB_PATH = TEST_DB;
  });

  afterAll(async () => {
    const { closeDB } = await import('../../src/db-manager.js');
    await closeDB();
    delete process.env.MAMA_DB_PATH;

    [TEST_DB, `${TEST_DB}-journal`, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((file) => {
      try {
        fs.unlinkSync(file);
      } catch {
        /* cleanup */
      }
    });
  });

  it('should persist append-only events for a topic', async () => {
    await appendMemoryEvent({
      event_type: 'save',
      actor: 'memory_agent',
      topic: 'memory_truth_contract',
      scope_refs: [{ kind: 'project', id: '/repo' }],
      created_at: Date.now(),
    });

    const events = await listMemoryEventsForTopic('memory_truth_contract');
    expect(events[0]?.event_type).toBe('save');
  });

  it('accepts Phase 2 correction and case lifecycle memory event types', async () => {
    for (const eventType of [
      'case.correction_applied',
      'case.correction_reverted',
      'case.membership_tombstoned',
      'case.merged',
      'case.split',
    ] as const) {
      await appendMemoryEvent({
        event_type: eventType,
        actor: 'user',
        topic: 'case:correction-events',
        scope_refs: [{ kind: 'project', id: '/repo' }],
        created_at: Date.now(),
      });
    }

    const events = await listMemoryEventsForTopic('case:correction-events');
    expect(events.map((event) => event.event_type).sort()).toEqual([
      'case.correction_applied',
      'case.correction_reverted',
      'case.membership_tombstoned',
      'case.merged',
      'case.split',
    ]);
  });
});
