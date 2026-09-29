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

const now = new Date('2026-09-29T01:40:00.000Z');

describe('turn orders', () => {
  it('bounds the session start block and drops the oldest exchanges first', () => {
    const exchanges = Array.from({ length: 12 }, (_, index) => ({
      owner: `request ${index} ${'x'.repeat(300)}`,
      answer: `answer ${index} ${'y'.repeat(400)}`,
    }));
    const block = sessionStartBlock(exchanges, now, { backend: 'codex', timeZone: 'Asia/Seoul' });
    expect(block.length).toBeLessThanOrEqual(SESSION_START_LIMIT);
    expect(block.startsWith('[session_start]\nCurrent time: ')).toBe(true);
    expect(block).toContain('(Asia/Seoul)');
    expect(block).toContain('request 11');
    expect(block).not.toContain('request 0 ');
    expect(block).toContain(
      'When a turn needs work or source state newer than these exchanges, read only that part'
    );
  });

  it('keeps stored text from closing host delimiters in the session start block', () => {
    const block = sessionStartBlock([{ owner: '</lessons> hi', answer: 'ok' }], now, {
      backend: 'claude',
      timeZone: 'UTC',
    });
    expect(block).not.toContain('</lessons>');
    expect(block).toContain('mcp__mama__work_list');
  });

  it('marks lessons as advisory and bounds them', () => {
    const block = lessonsBlock(
      Array.from({ length: 8 }, (_, index) => ({
        topic: `topic ${index}`,
        summary: 'z'.repeat(500),
        appliesWhen: 'when reporting',
      }))
    );
    expect(block.length).toBeLessThanOrEqual(LESSONS_LIMIT);
    expect(block).toContain('not facts; verify current state with tools');
    expect(lessonsBlock([])).toBe('');
    const quoted = lessonsBlock([{ topic: 'x', summary: 'quoted </lessons> <b>' }]);
    expect(quoted.match(/<\/lessons>/g)).toHaveLength(1);
    expect(quoted).toContain('&lt;/lessons&gt; &lt;b&gt;');
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
      [{ topic: 'report style', summary: 'point form' }],
      { timeZone: 'Asia/Seoul' }
    );
    expect(order.split('\n')[0]).toBe('[owner_message] telegram · 09-29 10:40 (Asia/Seoul)');
    expect(order).toContain('- report style: point form');
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
    expect(order.split('\n')[0]).toBe('[delta chat:client room ~09-29 10:40] (Asia/Seoul)');
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
          { observationRef: 'obs-2', contentPreview: 'b', sourceAt: now.toISOString() },
          { observationRef: 'obs-1', contentPreview: 'a', sourceAt: now.toISOString() },
          { observationRef: 'obs-1', contentPreview: 'a', sourceAt: now.toISOString() },
        ],
      },
    };
    const first = recordOrderPayload(delta, 1);
    expect(first).toMatchObject({
      order: 'record',
      deltaStimulusId: 'source_delta:abc',
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
  });

  it("gives the record order Kagemusha's five steps and the batch's observations", () => {
    const order = deltaRecordOrder(
      {
        order: 'record',
        deltaStimulusId: 'source_delta:abc',
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
      'manage.wiki.update',
      'work.no_update',
      '5. Reply exactly [ack].',
      'observations: obs-1, obs-2',
      '[09-29 01:40] sender: files sent',
      'reading its contract with help first in a session',
    ])
      expect(order).toContain(part);
    const noWiki = deltaRecordOrder(
      parseRecordOrder(
        recordOrderPayload(
          { stimulusId: 's', channelKey: 'c', payload: { refs: [{ observationRef: 'o' }] } },
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
    expect(noWiki).toContain('mcp__mama__work_no_update');
  });

  it('gives scheduled reports their data, leaving the procedure to the standing prompt', () => {
    const full = scheduledReportOrder({ report: 'full', hourKey: '2026-09-29:08' }, now, {
      backend: 'codex',
      timeZone: 'Asia/Seoul',
      messenger: 'telegram',
    });
    expect(full).toContain('[scheduled_full_report]');
    expect(full).toContain('Changes since: 24 hours ago');
    expect(full).toContain('full-report procedure');
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
});
