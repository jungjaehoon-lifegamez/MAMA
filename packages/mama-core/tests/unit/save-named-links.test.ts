/**
 * A save links only what the caller names, each with the reason it judged; nothing is linked from
 * the reasoning text or from similarity.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getAdapter } from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../helpers/test-utils.js';

describe('mama.save: named links and replacements', () => {
  let dbPath = '';
  let api: {
    save: (params: Record<string, unknown>) => Promise<{ success: boolean; id: string }>;
  };

  beforeAll(async () => {
    dbPath = await initTestDB('save-named-links');
    api = (await import('../../src/mama-api.js')).default as unknown as typeof api;
  });

  afterAll(async () => cleanupTestDB(dbPath));

  it('writes a named link with its reason, and no link from the reasoning text', async () => {
    const earlier = await api.save({
      type: 'user_decision',
      topic: 'edge_rule',
      decision: 'The host writes edges',
      reasoning: 'agents could not choose them',
    });
    const later = await api.save({
      type: 'user_decision',
      topic: 'edge_rule_now',
      decision: 'The agent writes edges',
      reasoning: `models can choose them now. builds_on: ${earlier.id}`,
      links: [{ id: earlier.id, relation: 'debates', reason: 'reverses who writes the edges' }],
    });

    expect(
      getAdapter()
        .prepare(
          `SELECT edge_type, object_id, reason_text FROM twin_edges
            WHERE subject_kind = 'memory' AND subject_id = ?`
        )
        .all(later.id)
    ).toEqual([
      { edge_type: 'debates', object_id: earlier.id, reason_text: 'reverses who writes the edges' },
    ]);
  });

  it('replaces a named decision with its reason, and refuses a link without one', async () => {
    const earlier = await api.save({
      type: 'user_decision',
      topic: 'policy_a',
      decision: 'Keep the old policy',
      reasoning: 'r',
    });
    await api.save({
      type: 'user_decision',
      topic: 'policy_b',
      decision: 'Use the new policy',
      reasoning: 'r',
      replaces: [{ id: earlier.id, reason: 'the owner changed the policy' }],
    });

    expect(
      getAdapter().prepare('SELECT status FROM decisions WHERE id = ?').get(earlier.id)
    ).toEqual({ status: 'superseded' });
    await expect(
      api.save({
        type: 'user_decision',
        topic: 'policy_c',
        decision: 'x',
        reasoning: 'r',
        links: [{ id: earlier.id, relation: 'builds_on', reason: ' ' }],
      })
    ).rejects.toThrow(/needs a reason/);
  });
});
