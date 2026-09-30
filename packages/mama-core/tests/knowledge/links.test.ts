/**
 * A link is one appended edge between records that already exist. Proved by reading back through
 * the graph reader: the ends, the reason, and a correction that leaves the corrected row as it was.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getAdapter } from '../../src/db-manager.js';
import { createKnowledge, type Knowledge } from '../../src/knowledge/index.js';
import { cleanupTestDB, initTestDB } from '../helpers/test-utils.js';

const access = {
  principalId: 'principal-link',
  agentId: 'agent-link',
  scopes: [{ kind: 'project' as const, id: 'scope-link' }],
  actions: [],
};
const otherAccess = {
  principalId: 'principal-other',
  agentId: 'agent-other',
  scopes: [{ kind: 'project' as const, id: 'scope-other' }],
  actions: [],
};

function count(table: string): number {
  return (getAdapter().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('knowledge/links: appending an edge the agent judged', () => {
  let dbPath = '';
  let knowledge: Knowledge;

  beforeAll(async () => {
    dbPath = await initTestDB('knowledge-links');
    knowledge = createKnowledge({ adapter: getAdapter() });
  });

  beforeEach(() => {
    const db = getAdapter();
    for (const table of [
      'commitment_assignments',
      'commitments',
      'judgment_commands',
      'command_bindings',
      'twin_edges',
      'memory_events',
      'memory_scope_bindings',
      'memory_scopes',
      'embeddings',
      'decisions',
    ]) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
  });

  afterAll(async () => cleanupTestDB(dbPath));

  async function work(commandId: string, title: string, who = access) {
    return knowledge.createWork(
      { commandId, topic: commandId, summary: title, set: { title }, scopes: who.scopes },
      who
    );
  }

  it('writes one edge with its reason and changes no record or revision', async () => {
    const current = await work('current', 'Setup differs from the sample');
    const earlier = await work('earlier', 'Setup differed from the original art');
    const before = {
      decisions: count('decisions'),
      assignments: count('commitment_assignments'),
    };

    const receipt = knowledge.appendLink(
      {
        commandId: 'link-1',
        from: current.recordRef as { kind: 'memory'; id: string },
        to: earlier.recordRef,
        relation: 'builds_on',
        reason: 'Same kind: the setup was redone against the art; it ended in a client FIX',
      },
      access
    );

    expect(receipt.replayed).toBe(false);
    expect(count('decisions')).toBe(before.decisions);
    expect(count('commitment_assignments')).toBe(before.assignments);
    const page = knowledge.queryGraph(
      { view: 'neighbors', seeds: [current.recordRef], maxDepth: 1, relations: ['builds_on'] },
      access
    );
    const edge = page.edges.find((candidate) => candidate.id === receipt.edgeId);
    expect(edge?.to).toEqual(earlier.recordRef);
    expect(edge?.attrs).toMatchObject({
      source: 'agent',
      agent_id: 'agent-link',
      reason_text: 'Same kind: the setup was redone against the art; it ended in a client FIX',
    });
  });

  it('returns the same edge for a retried command and refuses another payload under its id', async () => {
    const current = await work('current', 'current');
    const earlier = await work('earlier', 'earlier');
    const command = {
      commandId: 'link-retry',
      from: current.recordRef as { kind: 'memory'; id: string },
      to: earlier.recordRef,
      relation: 'builds_on' as const,
      reason: 'same kind',
    };

    const first = knowledge.appendLink(command, access);
    const again = knowledge.appendLink(command, access);

    expect(again).toMatchObject({ edgeId: first.edgeId, replayed: true });
    expect(count("twin_edges WHERE edge_id LIKE 'link_%'")).toBe(1);
    expect(() => knowledge.appendLink({ ...command, reason: 'another reason' }, access)).toThrow(
      /already bound/
    );
  });

  it('refuses an end the caller cannot reach, and a link without a reason', async () => {
    const mine = await work('mine', 'mine');
    const theirs = await work('theirs', 'theirs', otherAccess);

    expect(() =>
      knowledge.appendLink(
        {
          commandId: 'link-out',
          from: mine.recordRef as { kind: 'memory'; id: string },
          to: theirs.recordRef,
          relation: 'builds_on',
          reason: 'x',
        },
        access
      )
    ).toThrow(/unavailable/);
    expect(() =>
      knowledge.appendLink(
        {
          commandId: 'link-from-out',
          from: theirs.recordRef as { kind: 'memory'; id: string },
          to: mine.recordRef,
          relation: 'builds_on',
          reason: 'x',
        },
        access
      )
    ).toThrow(/unavailable/);
    expect(() =>
      knowledge.appendLink(
        {
          commandId: 'link-no-reason',
          from: mine.recordRef as { kind: 'memory'; id: string },
          to: mine.recordRef,
          relation: 'builds_on',
          reason: ' ',
        },
        access
      )
    ).toThrow(/reason must be nonblank/);
  });

  it('corrects a link by a newer edge that contradicts it, leaving the corrected row unchanged', async () => {
    const current = await work('current', 'current');
    const wrong = await work('wrong', 'a sibling, not a precedent');
    const link = knowledge.appendLink(
      {
        commandId: 'link-wrong',
        from: current.recordRef as { kind: 'memory'; id: string },
        to: wrong.recordRef,
        relation: 'builds_on',
        reason: 'looked like the same case',
      },
      access
    );
    const rowBefore = getAdapter()
      .prepare('SELECT * FROM twin_edges WHERE edge_id = ?')
      .get(link.edgeId);

    expect(() =>
      knowledge.appendLink(
        {
          commandId: 'link-correct-bad',
          from: current.recordRef as { kind: 'memory'; id: string },
          to: { kind: 'edge', id: link.edgeId },
          relation: 'builds_on',
          reason: 'x',
        },
        access
      )
    ).toThrow(/contradicts/);
    const correction = knowledge.appendLink(
      {
        commandId: 'link-correct',
        from: current.recordRef as { kind: 'memory'; id: string },
        to: { kind: 'edge', id: link.edgeId },
        relation: 'contradicts',
        reason: 'The other item is the TF of the same character, not an earlier case',
      },
      access
    );

    expect(
      getAdapter().prepare('SELECT * FROM twin_edges WHERE edge_id = ?').get(link.edgeId)
    ).toEqual(rowBefore);
    const page = knowledge.queryGraph(
      { view: 'neighbors', seeds: [current.recordRef], maxDepth: 1, relations: ['builds_on'] },
      access
    );
    expect(page.edges.find((edge) => edge.id === link.edgeId)?.attrs).toMatchObject({
      corrected_by: [
        {
          edgeId: correction.edgeId,
          reason: 'The other item is the TF of the same character, not an earlier case',
        },
      ],
    });
  });

  it('corrects a correction, refuses a link to an edge whose far end is out of reach, and takes no state-changing relation', async () => {
    const current = await work('current', 'current');
    const earlier = await work('earlier', 'earlier');
    const theirs = await work('theirs', 'theirs', otherAccess);
    const from = current.recordRef as { kind: 'memory'; id: string };
    const link = knowledge.appendLink(
      { commandId: 'l-1', from, to: earlier.recordRef, relation: 'builds_on', reason: 'same kind' },
      access
    );
    const first = knowledge.appendLink(
      {
        commandId: 'l-2',
        from,
        to: { kind: 'edge', id: link.edgeId },
        relation: 'contradicts',
        reason: 'not the same kind',
      },
      access
    );
    const second = knowledge.appendLink(
      {
        commandId: 'l-3',
        from,
        to: { kind: 'edge', id: first.edgeId },
        relation: 'contradicts',
        reason: 'it was the same kind after all',
      },
      access
    );

    const page = knowledge.queryGraph(
      { view: 'neighbors', seeds: [current.recordRef], maxDepth: 1, relations: ['builds_on'] },
      access
    );
    expect(page.edges.find((edge) => edge.id === link.edgeId)?.attrs).toMatchObject({
      corrected_by: [
        {
          edgeId: first.edgeId,
          correctedBy: [{ edgeId: second.edgeId, reason: 'it was the same kind after all' }],
        },
      ],
    });
    expect(knowledge.findLink('l-2', access)).toMatchObject({
      edgeId: first.edgeId,
      replayed: true,
    });
    expect(knowledge.findLink('l-unknown', access)).toBeNull();

    const theirLink = knowledge.appendLink(
      {
        commandId: 'l-theirs',
        from: theirs.recordRef as { kind: 'memory'; id: string },
        to: theirs.recordRef,
        relation: 'mentions',
        reason: 'x',
      },
      otherAccess
    );
    expect(() =>
      knowledge.appendLink(
        {
          commandId: 'l-4',
          from,
          to: { kind: 'edge', id: theirLink.edgeId },
          relation: 'contradicts',
          reason: 'x',
        },
        access
      )
    ).toThrow(/unavailable/);
    expect(() =>
      knowledge.appendLink(
        { commandId: 'l-5', from, to: earlier.recordRef, relation: 'supersedes', reason: 'x' },
        access
      )
    ).toThrow(/Unknown link relation/);
  });

  it('shows the evidence of a link only as far as the reader can see it', async () => {
    const bothAccess = {
      principalId: 'principal-both',
      agentId: 'agent-both',
      scopes: [...access.scopes, ...otherAccess.scopes],
      actions: [],
    };
    const current = await work('current', 'current');
    const earlier = await work('earlier', 'earlier');
    const theirs = await work('theirs', 'theirs', otherAccess);
    const receipt = knowledge.appendLink(
      {
        commandId: 'l-evidence',
        from: current.recordRef as { kind: 'memory'; id: string },
        to: earlier.recordRef,
        relation: 'builds_on',
        reason: 'same kind',
        evidenceRefs: [earlier.recordRef, theirs.recordRef],
      },
      bothAccess
    );
    const evidenceFor = (reader: typeof access) =>
      (
        knowledge
          .queryGraph(
            {
              view: 'neighbors',
              seeds: [current.recordRef],
              maxDepth: 1,
              relations: ['builds_on'],
            },
            reader
          )
          .edges.find((edge) => edge.id === receipt.edgeId)?.attrs as { evidence_refs: unknown }
      ).evidence_refs;

    expect(evidenceFor(bothAccess)).toEqual([earlier.recordRef, theirs.recordRef]);
    expect(evidenceFor(access)).toEqual([earlier.recordRef]);
  });

  it("links to a record with no scope binding, as a record's own links may", async () => {
    const current = await work('current', 'current');
    getAdapter()
      .prepare(
        `INSERT INTO decisions (id, topic, decision, confidence, created_at, updated_at)
         VALUES ('unbound-record', 'legacy', 'a record from before scopes', 1, 1, 1)`
      )
      .run();

    const receipt = knowledge.appendLink(
      {
        commandId: 'l-unbound',
        from: current.recordRef as { kind: 'memory'; id: string },
        to: { kind: 'memory', id: 'unbound-record' },
        relation: 'builds_on',
        reason: 'continues the legacy record',
      },
      access
    );
    expect(receipt.replayed).toBe(false);
  });
});
