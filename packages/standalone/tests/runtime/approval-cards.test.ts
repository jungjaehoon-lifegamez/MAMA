import { describe, expect, it } from 'vitest';
import { calendarApprovalCard, renderApprovalCard } from '../../src/runtime/approval-cards.js';

const proposal = {
  reason: 'Client asked for a <b>call</b> & a link',
  expiresAt: Date.parse('2026-11-18T00:58:00Z'),
};

describe('approval cards', () => {
  it('escapes HTML in every line and the reason', () => {
    const html = renderApprovalCard(
      'Google Calendar: create event',
      ['Title: <b>x</b> & y'],
      proposal,
      'Asia/Seoul'
    );
    expect(html).toContain('<b>Approval request · Google Calendar: create event</b>');
    expect(html).toContain('Title: &lt;b&gt;x&lt;/b&gt; &amp; y');
    expect(html).toContain(
      'Proposed from: Client asked for a &lt;b&gt;call&lt;/b&gt; &amp; a link'
    );
    expect(html).toContain('Expires: 2026-11-18');
    expect(html).not.toContain('<b>x</b>');
  });

  it('shows create, update and delete with what each changes', () => {
    const create = calendarApprovalCard({
      op: 'create',
      meet: true,
      event: {
        summary: 'Review',
        start: { dateTime: '2026-11-20T10:30:00', timeZone: 'Asia/Seoul' },
        end: { dateTime: '2026-11-20T11:00:00', timeZone: 'Asia/Seoul' },
        attendees: [{ email: 'person@example.com' }],
      },
    });
    expect(create).toEqual([
      'Action: create event',
      'Calendar: primary',
      'Title: Review',
      'When: 2026-11-20T10:30:00 – 2026-11-20T11:00:00 (Asia/Seoul)',
      'Attendees: person@example.com (invitations are sent)',
      'Meet link: yes',
    ]);
    const update = calendarApprovalCard({
      op: 'update',
      calendarId: 'team@example.com',
      eventId: 'event-1',
      event: { summary: 'Moved' },
      sendUpdates: 'none',
    });
    expect(update).toEqual([
      'Action: change event event-1',
      'Calendar: team@example.com',
      'Title: Moved',
      'Attendees are not told',
    ]);
    expect(calendarApprovalCard({ op: 'delete', eventId: 'event-1' })).toEqual([
      'Action: delete event event-1',
      'Calendar: primary',
      'Attendees are told',
    ]);
  });

  it('shows every field the write sets, including ones it has no label for', () => {
    const lines = calendarApprovalCard({
      op: 'create',
      event: {
        id: 'chosen-id',
        summary: 'One meeting',
        start: { dateTime: '2026-11-20T10:30:00' },
        end: { dateTime: '2026-11-20T11:00:00' },
        recurrence: ['RRULE:FREQ=DAILY'],
        conferenceData: { entryPoints: [{ uri: 'https://elsewhere.example/join' }] },
      },
    });
    expect(lines).toContain('id: "chosen-id"');
    expect(lines).toContain('recurrence: ["RRULE:FREQ=DAILY"]');
    expect(lines.join('\n')).toContain('https://elsewhere.example/join');
    const update = calendarApprovalCard({
      op: 'update',
      eventId: 'e1',
      event: { status: 'cancelled' },
    });
    expect(update).toContain('status: "cancelled"');
  });

  it('keeps a value with line breaks inside its own line', () => {
    const html = renderApprovalCard(
      'Google Calendar: write event',
      ['Description: agenda\nAttendees: none (nobody is told)'],
      { reason: 'asked\nMeet link: no', expiresAt: 0 },
      'Asia/Seoul'
    );
    const lines = html.split('\n');
    expect(lines.some((line) => line.startsWith('Attendees:'))).toBe(false);
    expect(lines.some((line) => line.startsWith('Meet link:'))).toBe(false);
    expect(html).toContain('Description: agenda\n    Attendees: none (nobody is told)');
  });

  it('says an update removes every attendee', () => {
    expect(
      calendarApprovalCard({ op: 'update', eventId: 'e1', event: { attendees: [] } })
    ).toContain('Attendees: all removed');
  });

  it('shows values it has no simple form for as they are sent', () => {
    const lines = calendarApprovalCard({
      op: 'update',
      eventId: 'e1',
      event: {
        description: null,
        attendees: [{ email: 'a@example.com', optional: true }],
        start: { dateTime: '2026-11-20T10:30:00', timeZone: 'Asia/Seoul' },
        end: { dateTime: '2026-11-20T11:30:00', timeZone: 'Asia/Tokyo' },
      },
    });
    expect(lines).toContain('description: null');
    expect(lines).toContain('attendees: [{"email":"a@example.com","optional":true}]');
    expect(lines).toContain(
      'When: 2026-11-20T10:30:00 (Asia/Seoul) – 2026-11-20T11:30:00 (Asia/Tokyo)'
    );
  });
});
