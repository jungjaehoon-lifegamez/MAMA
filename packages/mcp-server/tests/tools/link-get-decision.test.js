/**
 * The public MCP links decisions only where the caller names them, with a reason, and reads one
 * decision with every edge in and out so an agent can walk to the next one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MAMAServer } from '../../src/server.js';
import { cleanupTestDB, initTestDB } from '../helpers/test-db.js';

describe('save links, link and get_decision', () => {
  let dbPath;
  let server;

  beforeAll(async () => {
    dbPath = await initTestDB('link-get-decision');
    server = new MAMAServer();
  });

  afterAll(async () => {
    await cleanupTestDB(dbPath);
  });

  async function save(fields) {
    const result = await server.handleSave({ type: 'decision', ...fields });
    expect(result.success, JSON.stringify(result)).toBe(true);
    return result.id?.id ?? result.id;
  }

  it('walks from a decision to the one it builds on, with the reason and who wrote it', async () => {
    const earlier = await save({
      topic: 'edges_written_by_host',
      decision: 'The host writes edges',
      reasoning: 'agents could not choose them',
    });
    const later = await save({
      topic: 'edges_written_by_agent',
      decision: 'The agent writes edges',
      reasoning: `models can choose them now. builds_on: ${earlier}`,
      links: [{ id: earlier, relation: 'debates', reason: 'reverses who writes the edges' }],
    });

    const read = await server.handleGetDecision({ id: later });
    expect(read.success).toBe(true);
    expect(read.decision.edges).toEqual([
      expect.objectContaining({
        relation: 'debates',
        direction: 'out',
        otherId: earlier,
        otherTopic: 'edges_written_by_host',
        reason: 'reverses who writes the edges',
        source: 'agent',
      }),
    ]);
    const back = await server.handleGetDecision({ id: earlier });
    expect(back.decision.edges).toEqual([
      expect.objectContaining({ direction: 'in', otherId: later }),
    ]);
  });

  it('links after saving and corrects a wrong link by linking to it', async () => {
    const a = await save({ topic: 'link_a', decision: 'A', reasoning: 'r' });
    const b = await save({ topic: 'link_b', decision: 'B', reasoning: 'r' });
    const linked = await server.handleLink({
      from: b,
      to: a,
      relation: 'builds_on',
      reason: 'B continues A',
    });
    expect(linked).toMatchObject({ success: true, replayed: false });
    await server.handleLink({
      from: b,
      to: linked.edgeId,
      relation: 'contradicts',
      reason: 'B replaces A instead of continuing it',
    });

    const read = await server.handleGetDecision({ id: b });
    expect(read.decision.edges).toEqual([
      expect.objectContaining({
        edgeId: linked.edgeId,
        reason: 'B continues A',
        correctedBy: [expect.objectContaining({ reason: 'B replaces A instead of continuing it' })],
      }),
    ]);
    expect(await server.handleLink({ from: b, to: a, relation: 'builds_on' })).toMatchObject({
      success: false,
    });
    expect(await server.handleGetDecision({ id: 'decision_missing' })).toMatchObject({
      success: false,
    });
  });

  it('replaces a named decision through save', async () => {
    const old = await save({ topic: 'policy_old', decision: 'Old', reasoning: 'r' });
    const current = await save({
      topic: 'policy_new',
      decision: 'New',
      reasoning: 'r',
      replaces: [{ id: old, reason: 'the owner changed the policy' }],
    });

    const read = await server.handleGetDecision({ id: old });
    expect(read.decision.supersededBy).toBe(current);
    expect(read.decision.status).toBe('superseded');
  });
});
