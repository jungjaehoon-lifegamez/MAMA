import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';

import { getChannelSummary, upsertChannelSummary } from '../../src/memory/channel-summary-store.js';

const TEST_DB = '/tmp/test-channel-summary-store.db';

describe('channel summary store', () => {
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

  it('should upsert and read a channel summary', async () => {
    await upsertChannelSummary({
      channelKey: 'telegram:7026976631',
      summaryMarkdown: '## Channel Summary\n- Current DB direction: PostgreSQL',
      deltaHash: 'db:postgres',
    });

    const summary = await getChannelSummary('telegram:7026976631');
    expect(summary?.summary_markdown).toContain('PostgreSQL');
    expect(summary?.delta_hash).toBe('db:postgres');
  });
});
