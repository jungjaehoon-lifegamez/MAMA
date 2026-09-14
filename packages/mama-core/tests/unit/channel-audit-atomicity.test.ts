import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAdapter } from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import { recordChannelAudit } from '../../src/memory/channel-summary-state-store.js';

describe('recordChannelAudit atomicity', () => {
  let dbPath = '';
  beforeAll(async () => {
    dbPath = await initTestDB('atomic-channel-audit');
  });
  afterAll(async () => cleanupTestDB(dbPath));
  beforeEach(() => {
    const db = getAdapter();
    db.prepare('DELETE FROM audit_findings').run();
    db.prepare('DELETE FROM memory_events').run();
    db.prepare('DELETE FROM channel_summary_state').run();
    db.prepare('DELETE FROM channel_summaries').run();
  });

  it('leaves no event behind when the finding insert fails', async () => {
    const db = getAdapter();
    db.exec(`
      CREATE TRIGGER fail_finding_insert
      BEFORE INSERT ON audit_findings
      BEGIN
        SELECT RAISE(ABORT, 'synthetic finding failure');
      END
    `);

    await expect(
      recordChannelAudit({
        channelKey: 'probe-channel',
        turnId: 'turn-1',
        topic: 'probe topic',
        scopeRefs: [],
        ack: { status: 'failed', action: 'no_op', reason: 'synthetic' } as never,
      })
    ).rejects.toThrow('synthetic finding failure');

    db.exec('DROP TRIGGER fail_finding_insert');

    for (const table of [
      'memory_events',
      'audit_findings',
      'channel_summary_state',
      'channel_summaries',
    ]) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
  });

  it('writes the event, finding, state and summary together on success', async () => {
    const db = getAdapter();
    await recordChannelAudit({
      channelKey: 'probe-channel',
      turnId: 'turn-2',
      topic: 'probe topic',
      scopeRefs: [],
      ack: { status: 'failed', action: 'no_op', reason: 'recorded' } as never,
    });
    for (const table of [
      'memory_events',
      'audit_findings',
      'channel_summary_state',
      'channel_summaries',
    ]) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 1 });
    }
  });
});
