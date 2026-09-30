/**
 * work.link appends one edge between work items with the reason the agent judged, and
 * work.list view links reads it back from either end, with a later correction beside it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createKnowledge, type Knowledge } from '@jungjaehoon/mama-core/knowledge';

import { minimalWorkActionRegistrations, runWorkListView } from '../../src/api/work-actions.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';

const access = {
  principalId: 'principal-link',
  agentId: 'agent-link',
  scopes: [{ kind: 'global' as const, id: 'system' }],
  actions: [],
};

describe('work.link and work.list view links', () => {
  let root = '';
  let handle: Awaited<ReturnType<typeof openCoreDatabase>>;
  let knowledge: Knowledge;
  let link: (input: Record<string, unknown>, operationId: string) => Promise<unknown>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'mama-work-link-'));
    handle = await openCoreDatabase({ path: join(root, 'memory.db') });
    knowledge = createKnowledge({ adapter: handle.adapter });
    const registration = minimalWorkActionRegistrations({
      knowledge,
      observationExists: () => false,
    }).find((candidate) => candidate.contract.name === 'work.link')!;
    link = async (input, operationId) =>
      registration.exec(input, { access, operationId } as never) as Promise<unknown>;
  });

  afterEach(async () => {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function work(commandId: string, title: string) {
    return knowledge.createWork(
      { commandId, topic: commandId, summary: title, set: { title }, scopes: access.scopes },
      access
    );
  }

  function revisions(commitmentId: string): number {
    return knowledge.readWork({ commitmentId, history: 'all' }, access).items[0]!.history!.length;
  }

  it('links two items without a revision and reads the link from both ends', async () => {
    const current = await work('current', 'Setup differs from the sample');
    const earlier = await work('earlier', 'Setup differed from the original art');

    const receipt = (await link(
      {
        from: current.commitmentId,
        to: { kind: 'work', id: earlier.commitmentId },
        relation: 'builds_on',
        reason: 'The same setup problem; it ended in a client FIX after the setup was redone',
      },
      'op-link'
    )) as { edgeId: string; replayed: boolean };

    expect(receipt.replayed).toBe(false);
    expect(revisions(current.commitmentId)).toBe(1);
    expect(revisions(earlier.commitmentId)).toBe(1);
    const view = (await runWorkListView(
      { view: 'links', ids: [current.commitmentId, earlier.commitmentId] },
      { knowledge, access, timeZone: 'UTC' }
    )) as { items: Array<{ commitmentId: string; links: Array<Record<string, unknown>> }> };
    expect(view.items[0]!.links).toEqual([
      expect.objectContaining({
        edgeId: receipt.edgeId,
        relation: 'builds_on',
        direction: 'out',
        reason: 'The same setup problem; it ended in a client FIX after the setup was redone',
        source: 'agent',
        other: {
          kind: 'work',
          commitmentId: earlier.commitmentId,
          title: 'Setup differed from the original art',
          status: expect.any(String),
        },
      }),
    ]);
    expect(view.items[1]!.links).toEqual([
      expect.objectContaining({
        direction: 'in',
        other: expect.objectContaining({ commitmentId: current.commitmentId }),
      }),
    ]);
  });

  it('corrects a link by linking to it, and the corrected link keeps its row', async () => {
    const current = await work('current', 'current');
    const sibling = await work('sibling', 'the TF of the same character');
    const wrong = (await link(
      {
        from: current.commitmentId,
        to: { kind: 'work', id: sibling.commitmentId },
        relation: 'builds_on',
        reason: 'looked like the same case',
      },
      'op-wrong'
    )) as { edgeId: string };

    await expect(
      link(
        {
          from: current.commitmentId,
          to: { kind: 'edge', id: wrong.edgeId },
          relation: 'builds_on',
          reason: 'x',
        },
        'op-bad-correction'
      )
    ).rejects.toThrow(/contradicts/);
    await link(
      {
        from: current.commitmentId,
        to: { kind: 'edge', id: wrong.edgeId },
        relation: 'contradicts',
        reason: 'A sibling item of the same character, not an earlier case',
      },
      'op-correct'
    );

    const view = (await runWorkListView(
      { view: 'links', ids: [current.commitmentId] },
      { knowledge, access, timeZone: 'UTC' }
    )) as { items: Array<{ links: Array<Record<string, unknown>> }> };
    expect(view.items[0]!.links).toEqual([
      expect.objectContaining({
        edgeId: wrong.edgeId,
        reason: 'looked like the same case',
        correctedBy: [
          expect.objectContaining({
            reason: 'A sibling item of the same character, not an earlier case',
          }),
        ],
      }),
    ]);
    expect(revisions(current.commitmentId)).toBe(1);
  });

  it('refuses evidence that is not a stored observation and an unknown item', async () => {
    const current = await work('current', 'current');
    const earlier = await work('earlier', 'earlier');

    await expect(
      link(
        {
          from: current.commitmentId,
          to: { kind: 'work', id: earlier.commitmentId },
          relation: 'builds_on',
          reason: 'x',
          evidenceRefs: ['obs_missing'],
        },
        'op-evidence'
      )
    ).rejects.toThrow(/unavailable observation/);
    await expect(
      link(
        {
          from: 'commitment_missing',
          to: { kind: 'work', id: earlier.commitmentId },
          relation: 'builds_on',
          reason: 'x',
        },
        'op-missing'
      )
    ).rejects.toThrow(/unavailable/);
  });
});
