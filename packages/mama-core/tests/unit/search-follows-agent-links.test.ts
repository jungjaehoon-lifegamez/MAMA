/**
 * Search expansion follows the edges an agent stated and no edge the host wrote (owner,
 * 2026-09-30): a link with its reason, a replacement, and legacy rows parsed from an agent's
 * reasoning are followed; the host's similarity rows and its revision chain are not.
 */
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getAdapter } from '../../src/db-manager.js';
import { insertTwinEdge } from '../../src/knowledge/judgments.js';
import { expandWithGraphInAdapter, loadEdgesForIds } from '../../src/memory/api.js';
import { cleanupTestDB, initTestDB } from '../helpers/test-utils.js';

describe('search expansion follows agent links', () => {
  let dbPath = '';
  let api: {
    save: (params: Record<string, unknown>) => Promise<{ success: boolean; id: string }>;
    link: (input: Record<string, unknown>) => Promise<{ edgeId: string; replayed: boolean }>;
  };

  beforeAll(async () => {
    dbPath = await initTestDB('search-follows-agent-links');
    api = (await import('../../src/mama-api.js')).default as unknown as typeof api;
  });

  afterAll(async () => cleanupTestDB(dbPath));

  async function decision(topic: string, extra: Record<string, unknown> = {}) {
    const saved = await api.save({
      type: 'user_decision',
      topic,
      decision: `decision ${topic}`,
      reasoning: 'r',
      ...extra,
    });
    return saved.id;
  }

  function legacyRow(from: string, to: string, reason: string, createdBy: string) {
    getAdapter()
      .prepare(
        `INSERT INTO decision_edges (from_id, to_id, relationship, reason, created_by, approved_by_user)
         VALUES (?, ?, 'builds_on', ?, ?, 1)`
      )
      .run(from, to, reason, createdBy);
  }

  async function expand(id: string) {
    const expanded = await expandWithGraphInAdapter(getAdapter(), [
      { id, topic: 'primary', decision: 'primary', similarity: 0.9 },
    ]);
    return new Map(expanded.map((row) => [row.id, row]));
  }

  it('follows a link, a replacement and a parsed reasoning row, and no host edge', async () => {
    const linked = await decision('expand_linked');
    const replaced = await decision('expand_replaced');
    const similar = await decision('expand_similar');
    const parsed = await decision('expand_parsed');
    const chained = await decision('expand_chained');
    const primary = await decision('expand_primary', {
      links: [{ id: linked, relation: 'builds_on', reason: 'continues the linked rule' }],
      replaces: [{ id: replaced, reason: 'the owner changed the rule' }],
    });
    legacyRow(primary, similar, 'Semantically similar memory detected via vector search', 'user');
    legacyRow(primary, parsed, 'Auto-detected from reasoning: builds_on', 'llm');
    insertTwinEdge(getAdapter() as never, {
      edge_id: 'edge_host_chain',
      edge_type: 'builds_on',
      subject_ref: { kind: 'memory', id: primary },
      object_ref: { kind: 'memory', id: chained },
      confidence: 1,
      source: 'code',
      content_hash: crypto.createHash('sha256').update('host-chain').digest(),
      created_at: Date.now(),
    });

    const rows = await expand(primary);

    expect(rows.get(linked)).toMatchObject({
      graph_source: 'builds_on',
      related_to: primary,
      edge_reason: 'continues the linked rule',
    });
    expect(rows.get(replaced)).toMatchObject({ graph_source: 'supersedes_chain' });
    expect(rows.get(parsed)).toMatchObject({ graph_source: 'builds_on' });
    expect(rows.has(similar)).toBe(false);
    expect(rows.has(chained)).toBe(false);

    const edges = await loadEdgesForIds(getAdapter(), [primary, linked, similar, parsed, chained]);
    expect(edges.map((edge) => [edge.from_id, edge.to_id, edge.type]).sort()).toEqual(
      [
        [primary, linked, 'builds_on'],
        [primary, replaced, 'supersedes'],
        [primary, parsed, 'builds_on'],
      ].sort()
    );
  });

  it('carries a correction with the record a corrected link reaches', async () => {
    const linked = await decision('corrected_linked');
    const primary = await decision('corrected_primary');
    const link = await api.link({
      from: primary,
      to: linked,
      relation: 'builds_on',
      reason: 'looked like the same rule',
    });
    await api.link({
      from: primary,
      to: link.edgeId,
      relation: 'contradicts',
      reason: 'a different rule with the same name',
    });

    expect((await expand(primary)).get(linked)).toMatchObject({
      edge_reason: 'looked like the same rule',
      edge_corrected_by: [
        expect.objectContaining({ reason: 'a different rule with the same name' }),
      ],
    });
  });
});
