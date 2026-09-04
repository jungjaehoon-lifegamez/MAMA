import { describe, expect, it, vi } from 'vitest';
import type { PublicSaveMemoryInput } from '@jungjaehoon/mama-core/memory/types';
import { deriveMemoryScopes } from '../../src/memory/scope-context.js';
import { HOST_LEARNING_SOURCE_TYPE, observeOwnerTurn } from '../../src/operator/turn-observer.js';

const scopes = deriveMemoryScopes({ source: 'telegram', channelId: 'owner-chat', projectId: '/p' });
const source = {
  package: 'standalone' as const,
  source_type: 'telegram',
  channel_id: 'owner-chat',
};

function harness(existing: { memory_id: string } | null = null) {
  const saves: PublicSaveMemoryInput[] = [];
  const updates: Array<{ id: string; summary: string }> = [];
  return {
    saves,
    updates,
    deps: {
      scopes,
      source,
      turnCommitted: true,
      save: vi.fn(async (input: PublicSaveMemoryInput) => {
        saves.push(input);
        return { memoryId: `mem_${saves.length}` };
      }),
      findExisting: vi.fn(async () => existing),
      update: vi.fn(async (id: string, input: { summary: string }) => {
        updates.push({ id, summary: input.summary });
      }),
    },
  };
}

describe('Story ONE-MAMA-P2 Task 2: turn observer', () => {
  it('AC #1 a durable rule is saved once as kind decision under policy:<noun>-<hash> with the turn scopes and a host source', async () => {
    const h = harness();
    const result = await observeOwnerTurn({
      ...h.deps,
      userMessage:
        'From now on treat a submitted task with no feedback after the deadline as done.',
    });
    expect(result.kind).toBe('policy');
    expect(h.deps.save).toHaveBeenCalledTimes(1);
    const saved = h.saves[0];
    expect(saved.kind).toBe('decision');
    expect(saved.topic).toMatch(/^policy:lifecycle-[0-9a-f]{12}$/);
    expect(saved.scopes).toEqual(scopes);
    expect(saved.source.source_type).toBe(HOST_LEARNING_SOURCE_TYPE);
    expect(saved.source.package).toBe('standalone');
    expect(result.memoryId).toBe('mem_1');
  });

  it('AC #2 a correction is saved as kind lesson under lesson:<noun>-<hash>', async () => {
    const h = harness();
    const result = await observeOwnerTurn({
      ...h.deps,
      userMessage: "Don't lead the report with raw counts.",
    });
    expect(result.kind).toBe('lesson');
    expect(h.saves[0].kind).toBe('lesson');
    expect(h.saves[0].topic).toMatch(/^lesson:report-[0-9a-f]{12}$/);
  });

  it('AC #3 the same message twice updates the existing row instead of saving a second', async () => {
    const first = harness();
    const r1 = await observeOwnerTurn({
      ...first.deps,
      userMessage: "Don't lead the report with raw counts.",
    });
    const second = harness({ memory_id: r1.memoryId! });
    const r2 = await observeOwnerTurn({
      ...second.deps,
      userMessage: "Don't  lead the REPORT with raw counts.",
    });
    expect(r2.topic).toBe(r1.topic); // whitespace/case-normalized hash
    expect(r2.deduped).toBe(true);
    expect(second.deps.save).not.toHaveBeenCalled();
    expect(second.updates).toHaveLength(1);
  });

  it('AC #4 none and failed turns write nothing', async () => {
    const h = harness();
    expect(
      (await observeOwnerTurn({ ...h.deps, userMessage: 'What is the status of the report?' })).kind
    ).toBe('none');
    expect(
      (
        await observeOwnerTurn({
          ...h.deps,
          turnCommitted: false,
          userMessage: 'From now on treat every task as done.',
        })
      ).reason
    ).toBe('turn not committed');
    expect(h.deps.save).not.toHaveBeenCalled();
  });

  it('AC #5 the written channel scope id is exactly the deriveMemoryScopes format the reader matches on', async () => {
    const h = harness();
    await observeOwnerTurn({ ...h.deps, userMessage: 'Always start the report with decisions.' });
    const channel = h.saves[0].scopes.find((s) => s.kind === 'channel');
    expect(channel).toEqual({ kind: 'channel', id: 'telegram:owner-chat' });
    // different channel, same text -> different topic hash
    const other = harness();
    await observeOwnerTurn({
      ...other.deps,
      scopes: deriveMemoryScopes({ source: 'telegram', channelId: 'other', projectId: '/p' }),
      userMessage: 'Always start the report with decisions.',
    });
    expect(other.saves[0].topic).not.toBe(h.saves[0].topic);
  });
});
