/**
 * The card an owner approves (docs/development/work/approvals.md, A3). The host renders it from the
 * stored input alone, so what the owner reads is what runs; nothing the model wrote takes its
 * place. Every line is escaped: input text is shown, never interpreted as Telegram HTML.
 */
import { escapeTelegramHtml } from '../gateways/telegram-format.js';
import { localNow } from './timezone.js';
import type { Proposal } from './approval-store.js';

export type ApprovalCardRenderer = (input: unknown) => string[];

export function renderApprovalCard(
  title: string,
  lines: readonly string[],
  proposal: Pick<Proposal, 'reason' | 'expiresAt'>,
  timeZone: string
): string {
  return [
    `<b>${escapeTelegramHtml(`Approval request · ${title}`)}</b>`,
    ...lines.map(escapeTelegramHtml),
    ...(proposal.reason ? [`Proposed from: ${escapeTelegramHtml(proposal.reason)}`] : []),
    `Expires: ${escapeTelegramHtml(localNow(proposal.expiresAt, timeZone))}`,
  ].join('\n');
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function when(event: Record<string, unknown>): string | null {
  const start = record(event.start);
  const end = record(event.end);
  const at = (point: Record<string, unknown>) => String(point.dateTime ?? point.date ?? '?');
  if (Object.keys(start).length === 0 && Object.keys(end).length === 0) return null;
  const zone = start.timeZone ?? end.timeZone;
  return `When: ${at(start)} – ${at(end)}${zone ? ` (${String(zone)})` : ''}`;
}

/** google.calendar.write: the op, the calendar, and every field the write sets. */
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
  if (typeof event.summary === 'string') lines.push(`Title: ${event.summary}`);
  const time = when(event);
  if (time) lines.push(time);
  if (typeof event.location === 'string') lines.push(`Where: ${event.location}`);
  if (typeof event.description === 'string') lines.push(`Description: ${event.description}`);
  const attendees = Array.isArray(event.attendees)
    ? event.attendees.map((attendee) => String(record(attendee).email ?? '?'))
    : [];
  if (attendees.length > 0)
    lines.push(
      `Attendees: ${attendees.join(', ')} (${told ? 'invitations are sent' : 'nobody is told'})`
    );
  else lines.push(told ? 'Attendees are told' : 'Attendees are not told');
  if (value.meet === true) lines.push('Meet link: yes');
  return lines;
};
