import { describe, expect, it } from 'vitest';
import { BACKFILL_FORMAT, parseBackfillFile } from '../../src/backfill/format.js';

type RawItem = { revisions: Array<Record<string, unknown>>; [field: string]: unknown };

const period = { from: '2026-08-01T00:00:00+09:00', until: '2026-09-01T00:00:00+09:00' };

function validFile(): Record<string, unknown> {
  return {
    format: BACKFILL_FORMAT,
    period,
    items: [
      {
        key: 'still-a',
        topic: 'still a',
        revisions: [
          {
            at: '2026-08-03T09:55:00+09:00',
            summary: 'parts received',
            set: { title: 'Still A', status: 'pending' },
            sources: ['src:1'],
          },
          {
            at: '2026-08-24T16:04:00+09:00',
            summary: 'client FIX',
            set: { status: 'done' },
            sources: ['src:2'],
          },
        ],
        mentions: [{ reason: 'progress notes about this still', sources: ['src:3'] }],
        links: [{ to: { item: 'still-b' }, relation: 'builds_on', reason: 'same character' }],
      },
      {
        key: 'still-b',
        commitmentId: 'commitment_existing',
        revisions: [
          {
            at: '2026-08-26T17:43:00+09:00',
            summary: 'parts for the next month received',
            set: { title: 'Still B', status: 'pending' },
            sources: ['src:4'],
          },
        ],
      },
    ],
    lessons: [
      {
        key: 'no-direct-image-edits',
        at: '2026-08-18T18:44:00+09:00',
        topic: 'image edits',
        summary: 'Workers do not edit the source images',
        details: 'Stated by the coordinator',
        appliesWhen: 'when a worker gets a still to set up',
        sources: ['src:5'],
      },
    ],
    wiki: [
      {
        path: 'daily/2026-08-28.md',
        title: '2026-08-28',
        content: 'All August items delivered.',
      },
      {
        path: 'projects/example.md',
        append: [{ section: '## Decisions', text: '- Bones stay near 150.' }],
        sources: ['src:5'],
      },
    ],
    noUpdate: [{ reason: 'weekly meeting notice', sources: ['src:6'] }],
  };
}

describe('backfill file format', () => {
  it('reads a valid file with its times as epoch ms', () => {
    const file = parseBackfillFile(validFile());

    expect(file.period).toEqual({
      from: Date.parse('2026-07-31T15:00:00Z'),
      until: Date.parse('2026-08-31T15:00:00Z'),
    });
    expect(file.items[0]!.revisions.map((revision) => revision.at)).toEqual([
      Date.parse('2026-08-03T00:55:00Z'),
      Date.parse('2026-08-24T07:04:00Z'),
    ]);
    expect(file.items[1]).toMatchObject({ key: 'still-b', commitmentId: 'commitment_existing' });
    expect(file.items[1]!.appliesUntil).toBeUndefined();
    expect(file.noUpdate).toHaveLength(1);
  });

  it('lists every problem at once instead of guessing', () => {
    const raw = validFile();
    const [first, second] = raw.items as RawItem[];
    first!.revisions[0]!.recordedAt = 1;
    first!.revisions[1]!.at = '2026-08-02T00:00:00+09:00';
    first!.mentions = [{ reason: ' ', sources: ['src:3'] }];
    first!.links = [{ to: { item: 'missing' }, relation: 'builds_on', reason: 'x' }];
    second!.revisions[0]!.set = { status: 'pending' };
    second!.appliesUntil = '2026-08-20T00:00:00+09:00';
    second!.revisions.push({
      at: '2026-09-02T00:00:00+09:00',
      summary: 'outside',
      sources: ['src:7'],
    });
    (raw.wiki as Array<Record<string, unknown>>)[0]!.path = '../secrets.md';
    (raw.wiki as Array<Record<string, unknown>>)[1]!.title = 'a page gets content or appends';
    (raw.wiki as Array<Record<string, unknown>>).push({
      path: 'projects/other.md',
      append: [{ section: 'Decisions', text: '- x' }],
    });

    let message = '';
    try {
      parseBackfillFile(raw);
    } catch (error) {
      message = (error as Error).message;
    }
    for (const expected of [
      'item still-a.revisions[0]: unknown field recordedAt',
      'item still-a.revisions[1].at: is earlier than the revision before it',
      'item still-a.mentions[0].reason: must be nonblank text',
      'item still-a.links: names no other item missing',
      'item still-b.revisions[0].set.title: the first revision must state the title',
      'item still-b.revisions[1].at: is outside the period',
      'item still-b.appliesUntil: must follow every revision of the period',
      'wiki[0].path: must be a relative .md path inside the wiki',
      'wiki[1]: carries either title and content (a new page) or append (an existing page)',
      'wiki[2].append[0].section: must be a Markdown heading line',
    ])
      expect(message).toContain(expected);
  });

  it('refuses a bound or a topic on the wrong kind of item', () => {
    const raw = validFile();
    const [first, second] = raw.items as RawItem[];
    first!.appliesUntil = '2026-08-30T00:00:00+09:00';
    second!.topic = 'existing work keeps its topic';

    expect(() => parseBackfillFile(raw)).toThrow(
      /item still-a.appliesUntil: belongs only to existing work[\s\S]*item still-b.topic: belongs only to new work/
    );
  });
});
