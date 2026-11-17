/**
 * The card an owner approves (docs/development/work/approvals.md, A3). The host renders it from the
 * stored input alone, so what the owner reads is what runs; nothing the model wrote takes its
 * place. Every line is escaped: input text is shown, never interpreted as Telegram HTML.
 */
import { escapeTelegramHtml } from '../gateways/telegram-format.js';
import { localNow } from './timezone.js';
import type { Proposal } from './approval-store.js';

export type ApprovalCardRenderer = (input: unknown) => string[];

/**
 * A value's line breaks stay inside its line: each further line is indented, so text in the input
 * cannot print a line that looks like the host's own.
 */
function contained(line: string): string {
  return line.replace(/\r?\n/g, '\n    ');
}

export function renderApprovalCard(
  title: string,
  lines: readonly string[],
  proposal: Pick<Proposal, 'reason' | 'expiresAt'>,
  timeZone: string
): string {
  return [
    `<b>${escapeTelegramHtml(`Approval request · ${title}`)}</b>`,
    ...lines.map((line) => escapeTelegramHtml(contained(line))),
    ...(proposal.reason
      ? [`Proposed from: ${escapeTelegramHtml(contained(proposal.reason))}`]
      : []),
    `Expires: ${escapeTelegramHtml(localNow(proposal.expiresAt, timeZone))}`,
  ].join('\n');
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A start or end in its plain form: only dateTime, date and timeZone, all text. */
function plainTime(point: unknown): boolean {
  if (point === undefined) return true;
  const time = record(point);
  return (
    Object.keys(time).length > 0 &&
    Object.keys(time).every((key) => ['dateTime', 'date', 'timeZone'].includes(key)) &&
    Object.values(time).every((value) => typeof value === 'string')
  );
}

function when(event: Record<string, unknown>): string {
  const start = record(event.start);
  const end = record(event.end);
  const at = (time: Record<string, unknown>) => String(time.dateTime ?? time.date ?? '?');
  // One zone is named once; two different zones are each named at their own time.
  if (start.timeZone !== undefined && end.timeZone !== undefined && start.timeZone !== end.timeZone)
    return `When: ${at(start)} (${String(start.timeZone)}) – ${at(end)} (${String(end.timeZone)})`;
  const zone = start.timeZone ?? end.timeZone;
  return `When: ${at(start)} – ${at(end)}${zone === undefined ? '' : ` (${String(zone)})`}`;
}

/**
 * google.calendar.write: the op, the calendar, and every field the write sets. Fields in their
 * plain form are shown in words; anything else, and every other field, as it is sent.
 */
export const calendarApprovalCard: ApprovalCardRenderer = (input) => {
  const value = record(input);
  const event = record(value.event);
  const told = value.sendUpdates !== 'none';
  const op = value.op;
  const lines = [
    op === 'create'
      ? 'Action: create event'
      : `Action: ${op === 'delete' ? 'delete' : 'change'} event ${String(value.eventId)}`,
    `Calendar: ${String(value.calendarId ?? 'primary')}`,
  ];
  const shown = new Set<string>();
  const text = (key: string, label: string) => {
    if (typeof event[key] !== 'string') return;
    lines.push(`${label}: ${event[key] as string}`);
    shown.add(key);
  };
  text('summary', 'Title');
  if (
    (event.start !== undefined || event.end !== undefined) &&
    plainTime(event.start) &&
    plainTime(event.end)
  ) {
    lines.push(when(event));
    shown.add('start').add('end');
  }
  text('location', 'Where');
  text('description', 'Description');
  const attendeeList = Array.isArray(event.attendees) ? (event.attendees as unknown[]) : null;
  const plainAttendees =
    attendeeList !== null &&
    attendeeList.every((attendee) => {
      const one = record(attendee);
      return typeof one.email === 'string' && Object.keys(one).length === 1;
    });
  if (plainAttendees) {
    shown.add('attendees');
    const emails = attendeeList!.map((attendee) => String(record(attendee).email));
    lines.push(
      emails.length === 0
        ? 'Attendees: all removed'
        : `Attendees: ${emails.join(', ')} (${
            value.sendUpdates === 'externalOnly'
              ? 'invitations go to people outside the domain'
              : told
                ? 'invitations are sent'
                : 'nobody is told'
          })`
    );
  } else if (event.attendees === undefined)
    lines.push(told ? 'Attendees are told' : 'Attendees are not told');
  if (value.meet === true) lines.push('Meet link: yes');
  // Every other field the event sets is shown as it will be sent: the card is what runs.
  for (const [key, field] of Object.entries(event))
    if (!shown.has(key)) lines.push(`${key}: ${JSON.stringify(field)}`);
  return lines;
};

/** Every action that takes approval, with the card the owner reads for it. */
export const APPROVAL_CARDS: Readonly<
  Record<string, { title: string; render: ApprovalCardRenderer }>
> = {
  'google.calendar.write': { title: 'Google Calendar: write event', render: calendarApprovalCard },
};
