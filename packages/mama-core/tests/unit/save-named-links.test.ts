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
    link: (input: Record<string, unknown>) => Promise<{ edgeId: string; replayed: boolean }>;
    updateOutcome: (id: string, params: Record<string, unknown>) => Promise<void>;
    getDecision: (id: string) => Promise<{
      supersededBy: string | null;
      edges: Array<Record<string, unknown>>;
    } | null>;
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

  it('links after saving, reads the edges of one decision, and shows a correction and host rows', async () => {
    const first = await api.save({
      type: 'user_decision',
      topic: 'read_tool',
      decision: 'Add a read-by-id tool',
      reasoning: 'r',
    });
    const second = await api.save({
      type: 'user_decision',
      topic: 'read_tool_edges',
      decision: 'The read-by-id tool returns edges',
      reasoning: 'r',
    });
    const linked = await api.link({
      from: second.id,
      to: first.id,
      relation: 'builds_on',
      reason: 'extends the read tool with its edges',
    });
    expect(
      await api.link({
        from: second.id,
        to: first.id,
        relation: 'builds_on',
        reason: 'extends the read tool with its edges',
      })
    ).toMatchObject({ edgeId: linked.edgeId, replayed: true });
    await api.link({
      from: second.id,
      to: linked.edgeId,
      relation: 'contradicts',
      reason: 'the second one replaces the first rather than extending it',
    });
    getAdapter()
      .prepare(
        `INSERT INTO decision_edges (from_id, to_id, relationship, reason, created_by)
         VALUES (?, ?, 'builds_on', 'Semantically similar memory detected via vector search', 'user')`
      )
      .run(first.id, second.id);

    const read = await api.getDecision(second.id);
    expect(read?.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relation: 'builds_on',
          direction: 'out',
          otherId: first.id,
          otherTopic: 'read_tool',
          reason: 'extends the read tool with its edges',
          source: 'agent',
          correctedBy: [
            expect.objectContaining({
              reason: 'the second one replaces the first rather than extending it',
            }),
          ],
        }),
        expect.objectContaining({ direction: 'in', otherId: first.id, source: 'host' }),
      ])
    );
    expect(await api.getDecision('decision_missing')).toBeNull();
  });

  it('links, replaces and corrects across project scopes that the caller names', async () => {
    const elsewhere = await api.save({
      type: 'user_decision',
      topic: 'scoped_elsewhere',
      decision: 'A decision in another project',
      reasoning: 'r',
      scopes: [{ kind: 'project', id: '/other/project' }],
    });
    const here = await api.save({
      type: 'user_decision',
      topic: 'scoped_here',
      decision: 'A decision here that builds on it',
      reasoning: 'r',
      scopes: [{ kind: 'project', id: '/this/project' }],
      links: [{ id: elsewhere.id, relation: 'builds_on', reason: 'reuses the other project rule' }],
    });
    const edge = (await api.getDecision(here.id))!.edges.find(
      (candidate) => candidate.otherId === elsewhere.id
    ) as { edgeId: string };
    await api.link({
      from: here.id,
      to: edge.edgeId,
      relation: 'contradicts',
      reason: 'the rule does not carry over',
    });
    await api.save({
      type: 'user_decision',
      topic: 'scoped_here_next',
      decision: 'Replace the other project decision',
      reasoning: 'r',
      scopes: [{ kind: 'project', id: '/this/project' }],
      replaces: [{ id: elsewhere.id, reason: 'moved here' }],
    });

    expect((await api.getDecision(here.id))!.edges).toEqual([
      expect.objectContaining({
        otherId: elsewhere.id,
        correctedBy: [expect.objectContaining({ reason: 'the rule does not carry over' })],
      }),
    ]);
    expect(
      getAdapter()
        .prepare('SELECT COUNT(*) AS n FROM memory_scope_bindings WHERE memory_id = ?')
        .get(here.id)
    ).toEqual({ n: 1 });
    expect((await api.getDecision(elsewhere.id))!.supersededBy).not.toBeNull();
  });

  it('links within one scope, refuses a replacing relation as a link, and shows what an update replaced', async () => {
    const scopes = [{ kind: 'project', id: '/same/project' }];
    const base = await api.save({
      type: 'user_decision',
      topic: 'same_scope_base',
      decision: 'Base',
      reasoning: 'r',
      scopes,
    });
    const next = await api.save({
      type: 'user_decision',
      topic: 'same_scope_next',
      decision: 'Next',
      reasoning: 'r',
      scopes,
      links: [{ id: base.id, relation: 'builds_on', reason: 'continues the base' }],
    });
    expect(next.success).toBe(true);
    await expect(
      api.save({
        type: 'user_decision',
        topic: 'same_scope_bad',
        decision: 'x',
        reasoning: 'r',
        scopes,
        links: [{ id: base.id, relation: 'supersedes', reason: 'x' }],
      })
    ).rejects.toThrow(/goes in replaces/);
    await expect(
      api.save({
        type: 'user_decision',
        topic: 'same_scope_reasonless',
        decision: 'x',
        reasoning: 'r',
        scopes,
        replaces: [{ id: base.id }],
      })
    ).rejects.toThrow(/needs a reason/);

    await api.updateOutcome(base.id, { outcome: 'SUCCESS' });
    await api.updateOutcome(base.id, { outcome: 'FAILED', failure_reason: 'rolled back' });
    const amends = (await api.getDecision(base.id))!.edges.filter(
      (edge) => edge.relation === 'amends'
    );
    expect(amends.map((edge) => edge.replacedValues)).toEqual([
      expect.objectContaining({ outcome: null }),
      expect.objectContaining({ outcome: 'SUCCESS' }),
    ]);
  });
});
