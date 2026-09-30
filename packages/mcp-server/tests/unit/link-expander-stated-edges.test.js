/**
 * Resuming a checkpoint expands the links of its decisions through the edges an agent stated;
 * the host's similarity rows are not followed (owner, 2026-09-30).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAMAServer } from '../../src/server.js';
import { cleanupTestDB, initTestDB } from '../helpers/test-db.js';

describe('checkpoint link expansion follows stated edges', () => {
  let dbPath;
  let server;

  beforeAll(async () => {
    dbPath = await initTestDB('link-expander-stated-edges');
    server = new MAMAServer();
  });

  afterAll(async () => {
    await cleanupTestDB(dbPath);
  });

  async function save(topic) {
    const result = await server.handleSave({
      type: 'decision',
      topic,
      decision: `decision ${topic}`,
      reasoning: 'r',
    });
    return result.id?.id ?? result.id;
  }

  it('returns an agent link and not a host similarity row', async () => {
    const { expand } = await import('../../src/mama/link-expander.js');
    const { getAdapter } = await import('@jungjaehoon/mama-core/db-manager');
    const base = await save('expander_base');
    const linked = await save('expander_linked');
    const similar = await save('expander_similar');
    await server.handleLink({
      from: base,
      to: linked,
      relation: 'builds_on',
      reason: 'extends the base',
    });
    getAdapter()
      .prepare(
        `INSERT INTO decision_edges (from_id, to_id, relationship, reason, created_by, approved_by_user)
         VALUES (?, ?, 'builds_on', 'Semantically similar memory detected via vector search', 'user', 1)`
      )
      .run(base, similar);

    const links = expand(base, 1, true);

    expect(links.map((link) => [link.to_id, link.reason])).toEqual([[linked, 'extends the base']]);
  });
});
