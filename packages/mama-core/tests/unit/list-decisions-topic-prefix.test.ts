import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mama from '../../src/mama-api.js';
import { getAdapter } from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';

/**
 * A topic prefix read is a ledger lookup: every fact filed under one item key, exactly.
 *
 * Measured 2026-09-11 against the live daemon: `suggest(prefix, {topicPrefix})` returned 5
 * of the 12 rows under `bc_1118003` and one row from another item, because that path is a
 * similarity search with the prefix as a soft signal. Questions like "how many feedback
 * rounds did this item have" need the exact set, superseded rounds included.
 */
function insertDecision(input: {
  id: string;
  topic: string;
  eventMs: number;
  supersededBy?: string | null;
}): void {
  const adapter = getAdapter();
  adapter
    .prepare(
      `INSERT INTO decisions (
         id, topic, decision, reasoning, confidence, created_at, updated_at,
         kind, status, summary, event_datetime, superseded_by
       ) VALUES (?, ?, ?, '', 0.8, ?, ?, 'decision', 'active', ?, ?, ?)`
    )
    .run(
      input.id,
      input.topic,
      `fact ${input.id}`,
      input.eventMs,
      input.eventMs,
      `fact ${input.id}`,
      input.eventMs,
      input.supersededBy ?? null
    );
}

describe('listDecisions({topicPrefix})', () => {
  let dbPath: string;

  beforeAll(async () => {
    dbPath = await initTestDB('list-decisions-topic-prefix');
    insertDecision({ id: 'd_a1', topic: 'bc_1118003_ナターシャ', eventMs: 1_000 });
    insertDecision({ id: 'd_a2', topic: 'bc_1118003_ナターシャ', eventMs: 2_000, supersededBy: 'd_a3' });
    insertDecision({ id: 'd_a3', topic: 'bc_1118003_ナターシャ 할로윈', eventMs: 3_000 });
    insertDecision({ id: 'd_b1', topic: 'tf_1118003_ナターシャ', eventMs: 4_000 });
    insertDecision({ id: 'd_c1', topic: 'bc_1078002_トリュファイナ', eventMs: 5_000 });
    insertDecision({ id: 'd_pct', topic: 'bc%wild', eventMs: 6_000 });
  });

  afterAll(async () => {
    await cleanupTestDB(dbPath);
  });

  it('returns exactly the rows whose topic starts with the prefix, newest first, superseded rounds included', async () => {
    const rows = (await mama.list({ topicPrefix: 'bc_1118003', limit: 10 })) as Array<{
      id: string;
      superseded_by?: string | null;
    }>;
    expect(rows.map((r) => r.id)).toEqual(['d_a3', 'd_a2', 'd_a1']);
    expect(rows.find((r) => r.id === 'd_a2')?.superseded_by).toBe('d_a3');
  });

  it('treats LIKE metacharacters in the prefix literally', async () => {
    const rows = (await mama.list({ topicPrefix: 'bc%', limit: 10 })) as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(['d_pct']);
    const underscore = (await mama.list({ topicPrefix: 'bc_1', limit: 10 })) as Array<{
      id: string;
    }>;
    expect(underscore.map((r) => r.id).sort()).toEqual(['d_a1', 'd_a2', 'd_a3', 'd_c1']);
  });

  it('still lists recent current decisions when no prefix is given', async () => {
    const rows = (await mama.list({ limit: 10 })) as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).not.toContain('d_a2');
    expect(rows.length).toBe(5);
  });
});
