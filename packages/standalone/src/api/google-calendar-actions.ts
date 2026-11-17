/**
 * google.calendar.write — create, change or delete an event in the owner's Google Calendar through
 * gws, with a Google Meet link when asked and invitations sent to its attendees (owner,
 * 2026-11-17). The Codex backend reaches Calendar through Codex apps too; this is the path every
 * backend has, Claude's included. The host builds the whole command, as google.read does: the
 * agent gives the event, never a gws method or flag. Each call runs in a directory of its own
 * under runtime/, removed after it. The login needs the calendar scope (gws-utils); a login made
 * with the read-only one is told to sign in again.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionContext, ActionRegistration } from '@jungjaehoon/mama-core';

import { execGwsAsync } from '../connectors/framework/gws-utils.js';
import type { GwsCall } from './drive-actions.js';
import { gwsError } from './google-read-actions.js';

export const GOOGLE_CALENDAR_WRITE_ACTION = 'google.calendar.write';

export interface GoogleCalendarWritePorts {
  /** A directory only the daemon reads (under the MAMA home's runtime/): each call's own cwd. */
  scratchDir: string;
  /**
   * Whether this call runs in a turn an owner-role person's own message started. A write invites
   * people and sends mail, so a turn with no person in it (a source delta, a report) does not
   * write: text from a source cannot book, move or cancel (security review, #582).
   */
  ownerMessageTurn: (context: ActionContext) => boolean;
  gws?: GwsCall;
}

type Operation = 'create' | 'update' | 'delete';

function failure(name: string, message: string, kind?: 'invalid_input' | 'denied'): Error {
  return Object.assign(new Error(message), {
    name,
    ...(kind === undefined ? {} : { code: kind }),
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** What the agent relays: the event's id, link, Meet link, time and who was invited. */
function receipt(result: unknown): Record<string, unknown> {
  const event = record(result) ?? {};
  const entryPoints = record(event.conferenceData)?.entryPoints;
  const video = Array.isArray(entryPoints)
    ? entryPoints.map(record).find((entry) => entry?.entryPointType === 'video')
    : undefined;
  // Google may make the Meet link after it answers: pending, success or failure.
  const meetStatus = record(
    record(record(event.conferenceData)?.createRequest)?.status
  )?.statusCode;
  const attendees = Array.isArray(event.attendees)
    ? event.attendees.map((attendee) => record(attendee)?.email).filter(Boolean)
    : [];
  return {
    id: event.id ?? null,
    status: event.status ?? null,
    summary: event.summary ?? null,
    start: event.start ?? null,
    end: event.end ?? null,
    htmlLink: event.htmlLink ?? null,
    meetLink: event.hangoutLink ?? video?.uri ?? null,
    ...(meetStatus === undefined
      ? {}
      : {
          meetStatus,
          ...(meetStatus === 'pending'
            ? {
                next: 'The Meet link is still being made: read the event again (google.read calendar events get) for it.',
              }
            : {}),
        }),
    attendees,
  };
}

export function googleCalendarWriteActionRegistrations(
  ports: GoogleCalendarWritePorts
): ActionRegistration[] {
  const gws = ports.gws ?? execGwsAsync;
  return [
    {
      contract: {
        name: GOOGLE_CALENDAR_WRITE_ACTION,
        summary:
          "Create, change or delete an event in the owner's Google Calendar, live through gws. create takes event (a Calendar API Event: summary, start and end with dateTime and timeZone, attendees [{email}], description, location); meet true adds a Google Meet link. update takes eventId and the fields to change (meet true adds a Meet link to an event without one). delete takes eventId. calendarId defaults to primary (calendarList with google.read names the others). sendUpdates defaults to all: attendees get the invitation, change or cancellation by email; none sends nothing. Returns the event's id, link, Meet link, time and attendees. Only in a turn an owner started with their own message (their DM or the common channel); not in a replay.",
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['op'],
          properties: {
            op: { type: 'string', enum: ['create', 'update', 'delete'] },
            calendarId: { type: 'string', minLength: 1 },
            eventId: { type: 'string', minLength: 1 },
            event: {
              type: 'object',
              description:
                'The Calendar API Event, or for update the fields to change, e.g. {"summary": "Weekly sync", "start": {"dateTime": "2026-11-20T10:30:00", "timeZone": "Asia/Seoul"}, "end": {...}, "attendees": [{"email": "person@example.com"}]}.',
            },
            meet: { type: 'boolean' },
            sendUpdates: { type: 'string', enum: ['all', 'externalOnly', 'none'] },
          },
        },
        examples: [
          {
            title: 'A meeting with a Meet link and an invitation',
            input: {
              op: 'create',
              meet: true,
              event: {
                summary: 'Review',
                start: { dateTime: '2026-11-20T10:30:00', timeZone: 'Asia/Seoul' },
                end: { dateTime: '2026-11-20T11:00:00', timeZone: 'Asia/Seoul' },
                attendees: [{ email: 'person@example.com' }],
              },
            },
          },
          {
            title: 'Move it',
            input: { op: 'update', eventId: 'event-id', event: { start: {}, end: {} } },
          },
          { title: 'Cancel it', input: { op: 'delete', eventId: 'event-id' } },
        ],
      },
      exec: async (input, context) => {
        // A replay re-runs past turns; it must not book, move or cancel anything again.
        if (context.session?.replaySourceEndMs !== undefined)
          throw failure(
            'google_calendar_replay',
            'google.calendar.write changes the calendar now, and a replay turn re-runs past turns; it is not available in a replay.',
            'denied'
          );
        if (!ports.ownerMessageTurn(context))
          throw failure(
            'google_calendar_owner_message_required',
            'google.calendar.write runs only in a turn an owner started with their own message (their DM or the common channel). In other turns, leave the meeting as a proposal for the owner to confirm.',
            'denied'
          );
        const values = input as {
          op: Operation;
          calendarId?: string;
          eventId?: string;
          event?: Record<string, unknown>;
          meet?: boolean;
          sendUpdates?: 'all' | 'externalOnly' | 'none';
        };
        if (values.op !== 'create' && values.eventId === undefined)
          throw failure(
            'google_calendar_event_missing',
            `google.calendar.write ${values.op} needs eventId (events list with google.read finds it).`,
            'invalid_input'
          );
        if (values.op === 'create' && values.event === undefined)
          throw failure(
            'google_calendar_event_missing',
            'google.calendar.write create needs event, with at least start and end.',
            'invalid_input'
          );
        const params: Record<string, unknown> = {
          calendarId: values.calendarId ?? 'primary',
          sendUpdates: values.sendUpdates ?? 'all',
          ...(values.op === 'create' ? {} : { eventId: values.eventId }),
          ...(values.op === 'delete' ? {} : { conferenceDataVersion: 1 }),
        };
        const body =
          values.op === 'delete'
            ? undefined
            : {
                ...(values.event ?? {}),
                ...(values.meet
                  ? {
                      conferenceData: {
                        createRequest: {
                          requestId: randomUUID(),
                          conferenceSolutionKey: { type: 'hangoutsMeet' },
                        },
                      },
                    }
                  : {}),
              };
        const method = { create: 'insert', update: 'patch', delete: 'delete' }[values.op];
        const args = [
          'calendar',
          'events',
          method,
          '--params',
          JSON.stringify(params),
          ...(body === undefined ? [] : ['--json', JSON.stringify(body)]),
        ];
        mkdirSync(ports.scratchDir, { recursive: true, mode: 0o700 });
        const dir = mkdtempSync(join(ports.scratchDir, 'call-'));
        try {
          let result: unknown;
          try {
            result = await gws(args, { cwd: dir, emptyBody: values.op === 'delete' });
          } catch (error) {
            throw gwsError(error, 'calendar', `calendar events ${method}`);
          }
          return values.op === 'delete' ? { id: values.eventId, deleted: true } : receipt(result);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    },
  ];
}
