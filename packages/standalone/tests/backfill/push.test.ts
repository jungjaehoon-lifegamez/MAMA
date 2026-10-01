import { describe, expect, it } from 'vitest';
import { BACKFILL_FORMAT, parseBackfillFile } from '../../src/backfill/format.js';
import {
  ledgerFirstEventAt,
  pushBackfill,
  type BackfillPushPorts,
} from '../../src/backfill/push.js';

const AUG = (day: string) => `2026-08-${day}+09:00`;

function file(): ReturnType<typeof parseBackfillFile> {
  return parseBackfillFile({
    format: BACKFILL_FORMAT,
    period: { from: AUG('01T00:00:00'), until: '2026-09-01T00:00:00+09:00' },
    items: [
      {
        key: 'new-work',
        revisions: [
          {
            at: AUG('03T09:55:00'),
            summary: 'parts received',
            set: { title: 'New work', status: 'pending' },
            sources: ['src:1'],
          },
          { at: AUG('24T16:04:00'), summary: 'FIX', set: { status: 'done' }, sources: ['src:2'] },
        ],
        mentions: [
          { reason: 'progress notes on this work', sources: ['src:3'] },
          { reason: 'a translation of its feedback', sources: ['src:4'] },
        ],
        links: [{ to: { item: 'existing-work' }, relation: 'builds_on', reason: 'same character' }],
      },
      {
        key: 'existing-work',
        commitmentId: 'commitment_existing',
        revisions: [
          {
            at: AUG('26T17:43:00'),
            summary: 'next month parts received',
            set: { title: 'Existing work', status: 'pending' },
            sources: ['src:5'],
          },
        ],
      },
    ],
    lessons: [
      {
        key: 'lesson-a',
        at: AUG('18T18:44:00'),
        topic: 'image edits',
        summary: 'Workers do not edit source images',
        details: 'Stated by the coordinator',
        appliesWhen: 'when a worker gets a still to set up',
        sources: ['src:6'],
      },
    ],
    wiki: [
      {
        path: 'daily/2026-08-28.md',
        title: '2026-08-28',
        content: 'All delivered.',
        sources: ['src:2'],
      },
      {
        path: 'projects/example.md',
        append: [{ section: '## Decisions', text: '- Bones stay near 150.' }],
        sources: ['src:6'],
      },
    ],
    noUpdate: [{ reason: 'meeting notice', sources: ['src:7', 'src:8'] }],
  });
}

function fakePorts(published = new Set<string>()) {
  const calls: Array<{ name: string; input: Record<string, unknown>; operationId: string }> = [];
  const ports: BackfillPushPorts = {
    callAction: async (name, input, operationId) => {
      calls.push({ name, input, operationId });
      return name === 'work.create' ? { commitmentId: 'commitment_new' } : {};
    },
    resolveSources: (ids) =>
      new Map(ids.map((id) => [id, { observationRef: `obs_${id.slice(4)}`, connector: 'chat' }])),
    firstEventAt: () => Date.parse('2026-09-01T10:31:00+09:00'),
    publishedPages: published,
    pagePublished: (id) => published.add(id),
  };
  return { ports, calls, published };
}

describe('backfill push', () => {
  it('writes each work complete in event order, then links, lessons and pages', async () => {
    const { ports, calls } = fakePorts();

    const result = await pushBackfill(file(), ports);

    expect(calls.map((call) => `${call.name} ${call.operationId}`)).toEqual([
      `work.create backfill:${Date.parse(AUG('01T00:00:00'))}:new-work:r0`,
      `work.revise backfill:${Date.parse(AUG('01T00:00:00'))}:new-work:r1`,
      `work.revise backfill:${Date.parse(AUG('01T00:00:00'))}:existing-work:r0`,
      `work.link backfill:${Date.parse(AUG('01T00:00:00'))}:new-work:m0.0`,
      `work.link backfill:${Date.parse(AUG('01T00:00:00'))}:new-work:m1.0`,
      `work.link backfill:${Date.parse(AUG('01T00:00:00'))}:new-work:l0`,
      `memory.save backfill:${Date.parse(AUG('01T00:00:00'))}:lesson:lesson-a`,
      `manage.wiki.publish backfill:${Date.parse(AUG('01T00:00:00'))}:wiki:daily/2026-08-28.md`,
      `manage.wiki.update backfill:${Date.parse(AUG('01T00:00:00'))}:wiki:projects/example.md`,
    ]);
    expect(calls[0]!.input).toMatchObject({
      topic: 'new-work',
      eventDatetime: Date.parse(AUG('03T09:55:00')),
      links: [{ relation: 'derived_from', target: { kind: 'observation', id: 'obs_1' } }],
    });
    expect(calls[1]!.input).toMatchObject({ commitmentId: 'commitment_new' });
    expect(calls[1]!.input).not.toHaveProperty('appliesUntil');
    // Existing work is bounded by its first later revision, so its later state stays current.
    expect(calls[2]!.input).toMatchObject({
      commitmentId: 'commitment_existing',
      appliesUntil: Date.parse('2026-09-01T10:31:00+09:00'),
    });
    expect(calls[5]!.input).toMatchObject({
      from: 'commitment_new',
      to: { kind: 'work', id: 'commitment_existing' },
      relation: 'builds_on',
    });
    expect(calls[6]!.input).toMatchObject({
      kind: 'lesson',
      eventDateTime: Date.parse(AUG('18T18:44:00')),
    });
    expect((calls[7]!.input.pages as Array<Record<string, unknown>>)[0]).toMatchObject({
      expectedContentVersion: null,
      sourceRefs: [{ kind: 'raw', connector: 'chat', id: 'obs_2' }],
    });
    // An existing page gets section appends; its own metadata and evidence ids stay.
    expect(calls[8]!.input).toEqual({
      path: 'projects/example.md',
      edits: [{ section: '## Decisions', append: '- Bones stay near 150.' }],
      sourceIds: ['obs_6'],
    });
    expect(result).toEqual({
      created: 1,
      revised: 2,
      mentions: 2,
      links: 1,
      lessons: 1,
      pagesPublished: 2,
      pagesSkipped: 0,
      notWork: 2,
    });
  });

  it('repeats the same operation ids on a re-run and skips pages already published', async () => {
    const first = fakePorts();
    await pushBackfill(file(), first.ports);
    const again = fakePorts(first.published);

    const result = await pushBackfill(file(), again.ports);

    expect(again.calls.map((call) => call.operationId)).toEqual(
      first.calls.slice(0, -2).map((call) => call.operationId)
    );
    expect(result).toMatchObject({ pagesPublished: 0, pagesSkipped: 2 });
  });

  it('stops before writing when a source is not imported or the period cannot be bounded', async () => {
    const missing = fakePorts();
    missing.ports.resolveSources = () => {
      throw new Error('not imported: src:7');
    };
    await expect(pushBackfill(file(), missing.ports)).rejects.toThrow('not imported: src:7');
    expect(missing.calls).toEqual([]);

    const unbounded = fakePorts();
    const asked: number[] = [];
    unbounded.ports.firstEventAt = (_commitmentId, after) => {
      asked.push(after);
      throw new Error('Existing work commitment_existing has no revision after the period');
    };
    await expect(pushBackfill(file(), unbounded.ports)).rejects.toThrow(
      'has no revision after the period'
    );
    expect(asked).toEqual([Date.parse('2026-09-01T00:00:00+09:00')]);
    expect(unbounded.calls).toEqual([]);
  });

  it('bounds existing work by its first revision after the period, bounded or not', () => {
    const at = (text: string) => Date.parse(text);
    const history = [
      // An August backfill already bounded by September, then the live September work.
      {
        eventDatetime: at(AUG('26T17:43:00')),
        appliesUntil: at('2026-09-01T10:31:00+09:00'),
        createdAt: 1,
      },
      { eventDatetime: at('2026-09-01T10:31:00+09:00'), appliesUntil: null, createdAt: 2 },
      { eventDatetime: at('2026-09-02T20:03:00+09:00'), appliesUntil: null, createdAt: 3 },
    ];
    const firstEventAt = ledgerFirstEventAt(() => ({ items: [{ history }] }));

    // A re-run of August finds the same bound; a July backfill is bounded by August.
    expect(firstEventAt('c', at('2026-09-01T00:00:00+09:00'))).toBe(
      at('2026-09-01T10:31:00+09:00')
    );
    expect(firstEventAt('c', at(AUG('01T00:00:00')))).toBe(at(AUG('26T17:43:00')));
    expect(() => firstEventAt('c', at('2026-10-01T00:00:00+09:00'))).toThrow(
      'Existing work c has no revision after the period'
    );
  });
});
