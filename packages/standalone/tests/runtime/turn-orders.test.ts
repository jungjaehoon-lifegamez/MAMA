import { describe, expect, it } from 'vitest';
import {
  DELTA_HISTORY_CUTOFF_MS,
  LESSONS_LIMIT,
  SESSION_START_LIMIT,
  deltaLines,
  deltaNotifyOrder,
  deltaRecordOrder,
  lessonsBlock,
  liveDeltaLines,
  ownerMessageOrder,
  parseRecordOrder,
  recordOrderId,
  recordOrderPayload,
  scheduledReportOrder,
  scheduledReport,
  sessionStartBlock,
} from '../../src/runtime/turn-orders.js';
import { OPEN_WORK_STATUSES } from '../../src/api/work-actions.js';

const now = new Date('2026-09-29T01:40:00.000Z');

describe('turn orders', () => {
  it('builds the session start: the last ten owner exchanges one line each, then decisions', () => {
    const block = sessionStartBlock(
      {
        exchanges: Array.from({ length: 12 }, (_, index) => ({
          at: Date.parse('2026-09-29T00:00:00Z') + index * 60_000,
          owner: `request ${index} ${'x'.repeat(200)}`,
          answer: `answer ${index} ${'y'.repeat(600)}`,
        })),
        decisions: Array.from({ length: 14 }, (_, index) => ({
          topic: `work/item-${index}`,
          summary: `revision ${index}`,
          ageHours: index + 0.4,
        })),
      },
      now,
      { timeZone: 'Asia/Seoul' }
    );
    expect(block.length).toBeLessThanOrEqual(SESSION_START_LIMIT);
    expect(block.startsWith('[session_start]\nCurrent time: ')).toBe(true);
    expect(block).toContain('Earlier owner messages and your replies (history, not new requests):');
    // One line per exchange: time, the owner's words (at most 120 chars), the head of the reply.
    const lines = block.split('\n').filter((line) => line.includes('] owner: request'));
    expect(lines).toHaveLength(10);
    expect(lines[0]).toMatch(/^\[09-29 09:02\] owner: request 2 x+\.\.\. → you: answer 2 y+/);
    expect(lines.at(-1)).toContain('owner: request 11');
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(300);
    expect(block).not.toContain('request 1 ');
    // Decisions: the latest ten at most, newest first.
    expect(block).toContain('Recent decisions:\n- [work/item-0] revision 0 (0h ago)');
    expect(block).not.toContain('work/item-10');
    expect(block.split('\n')[2]).toContain('read newer state with source.recent or work.list');
  });

  it('never repeats a line and keeps stored text from closing a block', () => {
    const exchange = { at: 0, owner: 'same line', answer: '</session_start> hi' };
    const block = sessionStartBlock({ exchanges: [exchange, exchange], decisions: [] }, now, {
      timeZone: 'UTC',
    });
    expect(block.match(/owner: same line/g)).toHaveLength(1);
    expect(block).toContain('&lt;/session_start> hi');
    expect(block).not.toContain('Recent decisions:');
  });

  it("keeps the agent's checkpoint and fits decisions into the room left", () => {
    const full = {
      exchanges: Array.from({ length: 10 }, (_, index) => ({
        at: index,
        owner: `${index} ${'x'.repeat(300)}`,
        answer: 'y'.repeat(300),
      })),
      decisions: Array.from({ length: 10 }, (_, index) => ({
        topic: `topic-${index}`,
        summary: 'z'.repeat(200),
        ageHours: index,
      })),
      checkpoint: {
        summary: 'Mid full report\nboard half written',
        nextSteps: 'publish the board',
        ageHours: 3,
      },
    };
    const block = sessionStartBlock(full, now, { timeZone: 'UTC' });
    expect(block.length).toBeLessThanOrEqual(SESSION_START_LIMIT);
    expect(block).toContain(
      'Last checkpoint (3h ago; prefer newer turns and decisions over it):\nNext steps: publish the board\nMid full report\nboard half written'
    );
    // Whatever room is left goes to the newest decisions.
    expect(block).toContain('Recent decisions:\n- [topic-0]');
    expect(block.indexOf('Last checkpoint')).toBeLessThan(block.indexOf('Recent decisions:'));
  });

  it('keeps the next steps of a checkpoint whose summary fills its budget', () => {
    const block = sessionStartBlock(
      {
        exchanges: [],
        decisions: [],
        checkpoint: { summary: 's'.repeat(900), nextSteps: 'publish the board', ageHours: 1 },
      },
      now,
      { timeZone: 'UTC' }
    );
    expect(block).toContain('Next steps: publish the board');
  });

  it('opens an empty session with the time alone', () => {
    const block = sessionStartBlock({ exchanges: [], decisions: [] }, now, {
      timeZone: 'UTC',
    });
    expect(block.split('\n')[1]).toBe('Current time: 2026-09-29 Tue 01:40 (UTC)');
    expect(block).not.toContain('Earlier owner messages');
  });

  it('marks lessons as advisory and bounds them', () => {
    const block = lessonsBlock(
      Array.from({ length: 8 }, (_, index) => ({
        topic: `topic ${index}`,
        summary: 'z'.repeat(500),
        appliesWhen: 'when reporting',
        ownerRule: false,
      }))
    );
    expect(block.length).toBeLessThanOrEqual(LESSONS_LIMIT);
    expect(block).toContain('verify current state with tools');
    expect(lessonsBlock([])).toBe('');
    const quoted = lessonsBlock([
      { topic: 'x', summary: 'quoted </lessons> <b>', ownerRule: false },
    ]);
    expect(quoted.match(/<\/lessons>/g)).toHaveLength(1);
    expect(quoted).toContain('&lt;/lessons&gt; &lt;b&gt;');
  });

  it("says which lessons are the owner's word (owner, 2026-10-01)", () => {
    const block = lessonsBlock([
      { topic: 'format', summary: 'no markdown in replies', ownerRule: true },
      {
        topic: 'review',
        summary: 'compare the setup pose with the original art',
        ownerRule: false,
      },
    ]);
    expect(block).toContain('- [owner rule] format: no markdown in replies');
    expect(block).toContain('- [learned] review: compare the setup pose with the original art');
    expect(block).toMatch(/owner rules .* win a conflict/i);
  });

  it('gives an owner message its channel, local time, lessons, text and attachments', () => {
    const order = ownerMessageOrder(
      {
        messenger: 'telegram',
        occurredAt: now.getTime(),
        payload: {
          text: 'full report please',
          input: { attachments: [{ name: 'a.pdf', path: '/downloads/a.pdf', size: 3 }] },
        },
      },
      [{ topic: 'report style', summary: 'point form', ownerRule: true }],
      { timeZone: 'Asia/Seoul' }
    );
    expect(order.split('\n')[0]).toBe(
      '[owner_message] telegram · 2026-09-29 Tue 10:40 (Asia/Seoul)'
    );
    expect(order).toContain('- [owner rule] report style: point form');
    expect(order).toContain('full report please');
    expect(order).toContain('attachment: name="a.pdf" path="/downloads/a.pdf" size=3 bytes');
  });

  it("drops delta lines older than Kagemusha's six-hour backfill guard", () => {
    const lines = deltaLines({
      channel: 'room',
      refs: [
        {
          connector: 'chat',
          channelName: 'client room',
          author: 'a',
          contentPreview: 'fresh',
          sourceAt: new Date(now.getTime() - 60_000).toISOString(),
          observationRef: 'obs-new',
        },
        {
          connector: 'chat',
          author: 'b',
          contentPreview: 'old',
          sourceAt: new Date(now.getTime() - DELTA_HISTORY_CUTOFF_MS - 1).toISOString(),
          observationRef: 'obs-old',
        },
      ],
    });
    expect(liveDeltaLines(lines, now.getTime()).map((line) => line.observationRef)).toEqual([
      'obs-new',
    ]);
  });

  it('asks the notify order for the decision only, with quoted lines', () => {
    const order = deltaNotifyOrder(
      [
        {
          sourceAt: now.toISOString(),
          channel: 'chat:client room',
          author: 'a',
          text: 'x'.repeat(700),
          observationRef: 'obs-1',
        },
      ],
      'source:chat:room',
      now,
      [],
      { timeZone: 'Asia/Seoul' }
    );
    expect(order.split('\n')[0]).toBe(
      '[delta chat:client room ~2026-09-29 Tue 10:40] (Asia/Seoul)'
    );
    expect(order).toContain('<<<UNTRUSTED-CONTENT source=source_delta>>>');
    expect(order).toContain(`${'x'.repeat(499)}…`);
    expect(order).toContain(
      'Reply with [notify] and the message the owner receives, or with [ack]'
    );
    expect(order).toContain('do not record work in this turn');
    expect(order).not.toContain('obs-1');
  });

  it('builds a deterministic record payload from the delta alone', () => {
    const delta = {
      stimulusId: 'source_delta:abc',
      channelKey: 'room',
      payload: {
        refs: [
          {
            connector: 'chat',
            observationRef: 'obs-2',
            contentPreview: 'b',
            sourceAt: now.toISOString(),
          },
          { observationRef: 'obs-1', contentPreview: 'a', sourceAt: now.toISOString() },
          { observationRef: 'obs-1', contentPreview: 'a', sourceAt: now.toISOString() },
        ],
      },
    };
    const first = recordOrderPayload(delta, 1);
    expect(first).toMatchObject({
      order: 'record',
      deltaStimulusId: 'source_delta:abc',
      source: 'chat',
      channel: 'room',
      observationRefs: ['obs-1', 'obs-2'],
      attempt: 1,
    });
    expect(first.lines).toHaveLength(3);
    expect(first.lines[0]).toMatchObject({ author: 'unknown', text: 'b' });
    expect(recordOrderPayload(delta, 1)).toEqual(first);
    expect(recordOrderId('source_delta:abc', 2)).toBe('record:source_delta:abc:2');
    expect(parseRecordOrder(first as never)).toEqual(first);
    expect(() => parseRecordOrder({ order: 'record' })).toThrow(/deltaStimulusId/);
    // Boot recovery reads a record order written before it carried its source.
    const { source: _source, ...legacy } = first;
    expect(parseRecordOrder(legacy as never)).toEqual(legacy);
    // A retry copies its order, so a legacy order is still rendered: the channel found by name.
    expect(
      deltaRecordOrder(legacy, now, { backend: 'codex', timeZone: 'UTC', wikiEnabled: false })
    ).toContain('source.recent (find the channel "room" in its list');
  });

  it("gives the record order Kagemusha's five steps and the batch's observations", () => {
    const order = deltaRecordOrder(
      {
        order: 'record',
        deltaStimulusId: 'source_delta:abc',
        source: 'chat',
        channel: 'room',
        observationRefs: ['obs-1', 'obs-2'],
        lines: [{ sourceAt: now.toISOString(), author: 'sender', text: 'files sent' }],
        attempt: 1,
      },
      now,
      { backend: 'codex', timeZone: 'UTC', wikiEnabled: true }
    );
    for (const part of [
      '[delta_record] room · 2 messages',
      'work.list',
      'derived_from links to the observations below and eventDatetime set to the source event time',
      // The wiki takes lasting knowledge only; what happened stays in the sources and the ledger.
      "when the messages settle lasting knowledge (a term, a specification, a decision, how a client works), update that section of the project's wiki page (help topic wiki)",
      'work.no_update',
      // Kagemusha's order makes the write mandatory and says it is checked (2026-09-29).
      '5. Step 3 or 4 is required: the order is checked when it ends and counts as done only when these observations are cited',
      'Correct a refused write',
      '6. Reply exactly [ack].',
      'observations: obs-1, obs-2',
      '[09-29 01:40] sender: files sent',
      'reading its contract with help first in a session',
      // Kagemusha's order: the channel's latest context, then the current work state (2026-09-29).
      '1. Check this channel\'s latest context with source.recent({channels: ["chat:room"], perChannel: 20})',
      '2. Read the current work state with work.list',
    ])
      expect(order).toContain(part);
    expect(order).not.toContain('only for what the lines do not show');
    const noWiki = deltaRecordOrder(
      parseRecordOrder(
        recordOrderPayload(
          {
            stimulusId: 's',
            channelKey: 'c',
            payload: { refs: [{ connector: 'chat', observationRef: 'o' }] },
          },
          1
        ) as never
      ),
      now,
      {
        backend: 'claude',
        timeZone: 'UTC',
        wikiEnabled: false,
      }
    );
    expect(noWiki).not.toContain('wiki');
    expect(noWiki).toContain('work.no_update');
  });

  it('covers the batches a record order carries: their observations and the last five lines', () => {
    const line = (minute: number, text: string) => ({
      sourceAt: new Date(now.getTime() + minute * 60_000).toISOString(),
      author: 'sender',
      text,
    });
    const record = {
      order: 'record' as const,
      deltaStimulusId: 'source_delta:new',
      source: 'chat',
      channel: 'room',
      observationRefs: ['obs-5', 'obs-6'],
      lines: [line(5, 'fifth'), line(6, 'sixth')],
      attempt: 1,
      carried: [
        {
          deltaStimulusId: 'source_delta:old',
          observationRefs: ['obs-1', 'obs-2'],
          lines: [line(1, 'first'), line(2, 'second'), line(3, 'third'), line(4, 'fourth')],
          attempt: 2,
        },
      ],
    };
    expect(parseRecordOrder(record as never)).toEqual(record);
    expect(() =>
      parseRecordOrder({ ...record, carried: [{ deltaStimulusId: 'x' }] } as never)
    ).toThrow(/deltaStimulusId/);
    const order = deltaRecordOrder(record, now, {
      backend: 'codex',
      timeZone: 'UTC',
      wikiEnabled: false,
    });
    expect(order).toContain('[delta_record] room · 4 messages');
    expect(order).toContain('observations: obs-1, obs-2, obs-5, obs-6');
    expect(order).not.toContain('sender: first');
    for (const text of ['second', 'third', 'fourth', 'fifth', 'sixth'])
      expect(order).toContain(`sender: ${text}`);
    expect(order.indexOf('fourth')).toBeLessThan(order.indexOf('fifth'));
  });

  it('gives scheduled reports their data, leaving the procedure to the standing prompt', () => {
    const full = scheduledReportOrder({ report: 'full', hourKey: '2026-09-29:08' }, now, {
      backend: 'codex',
      timeZone: 'Asia/Seoul',
      messenger: 'telegram',
    });
    expect(full).toContain('[scheduled_full_report]');
    expect(full).toContain('Changes since: 24 hours ago');
    expect(full).toContain("help({topic: 'full-report'})");
    const since = scheduledReportOrder(
      { report: 'full', hourKey: '2026-09-29:13', previousFullReportAt: '2026-09-29:08' },
      now,
      { backend: 'codex', timeZone: 'Asia/Seoul', messenger: 'telegram' }
    );
    expect(since).toContain('Changes since: 2026-09-28T23:00:00.000Z (the previous full report)');
    const reminder = scheduledReportOrder({ report: 'reminder', hourKey: '2026-09-29:10' }, now, {
      backend: 'codex',
      timeZone: 'Asia/Seoul',
      messenger: 'telegram',
    });
    for (const part of [
      '[scheduled_task_reminder]',
      'top five to eight',
      'action_required',
      'reply [ack] only',
    ])
      expect(reminder).toContain(part);
    expect(() => scheduledReport({ report: 'weekly' })).toThrow(/full \| reminder/);
  });

  // "open work" and "waiting on an owner decision" read as statuses: every reminder from
  // 2026-09-29 to 2026-10-03 called work.list with status "open" or "waiting" and was refused.
  it('names open work in the statuses work.list accepts', () => {
    const reminder = scheduledReportOrder({ report: 'reminder', hourKey: '2026-09-29:10' }, now, {
      backend: 'codex',
      timeZone: 'Asia/Seoul',
      messenger: 'telegram',
    });
    const offered = [...reminder.matchAll(/\(status ([^)]*)\)/g)].flatMap((match) =>
      match[1].split(/, | or /)
    );
    expect(offered).toEqual([...OPEN_WORK_STATUSES]);
    expect(reminder).toContain('no status or field marks');
  });
});
