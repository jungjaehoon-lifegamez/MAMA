import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCatalog, createDispatcher, type ActionContext } from '@jungjaehoon/mama-core';

import { googleCalendarWriteActionRegistrations } from '../../src/api/google-calendar-actions.js';

let root: string;
let bin: string;
let scratch: string;
let log: string;
let cwdLog: string;
/** Whether the fixture call runs in a turn an owner's own message started. */
let ownerTurn = true;

/** A `gws` stand-in on PATH that records its argv, one per line, and its directory, then runs `script`. */
function fakeGws(script: string): void {
  writeFileSync(
    join(bin, 'gws'),
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\npwd -P > '${cwdLog}'\n${script}\n`
  );
  chmodSync(join(bin, 'gws'), 0o755);
}

const argvRun = (): string[] | null =>
  existsSync(log) ? readFileSync(log, 'utf8').trimEnd().split('\n') : null;

const access: ActionContext['access'] = {
  principalId: 'owner',
  agentId: 'agent',
  actions: ['google.calendar.write'],
  connectors: ['calendar'],
  scopes: [],
};

const write = (
  input: Record<string, unknown>,
  session?: ActionContext['session'],
  operationId?: string,
  grant: ActionContext['access'] = access
) =>
  createDispatcher(
    createCatalog(
      googleCalendarWriteActionRegistrations({
        scratchDir: scratch,
        ownerMessageTurn: () => ownerTurn,
      })
    )
  )(
    {
      action: 'google.calendar.write',
      input,
      ...(operationId === undefined ? {} : { operationId }),
    },
    { access: grant, ...(session === undefined ? {} : { session }) }
  );

// Synthetic event; the shape is the Calendar API's Event resource.
const created = {
  id: 'fixture-event',
  status: 'confirmed',
  summary: 'Fixture review',
  htmlLink: 'https://www.google.com/calendar/event?eid=fixture',
  hangoutLink: 'https://meet.google.com/abc-defg-hij',
  start: { dateTime: '2026-11-20T10:30:00+09:00' },
  end: { dateTime: '2026-11-20T11:00:00+09:00' },
  attendees: [{ email: 'person@example.com' }],
};

describe('google.calendar.write', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'google-calendar-'));
    bin = join(root, 'bin');
    scratch = join(root, 'runtime', 'google-calendar');
    log = join(root, 'argv');
    cwdLog = join(root, 'cwd');
    mkdirSync(bin);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
    ownerTurn = true;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('books a meeting with a Meet link and an outside attendee, and returns the Meet link', async () => {
    fakeGws(`echo '${JSON.stringify(created)}'`);
    const event = {
      summary: 'Fixture review',
      start: { dateTime: '2026-11-20T10:30:00', timeZone: 'Asia/Seoul' },
      end: { dateTime: '2026-11-20T11:00:00', timeZone: 'Asia/Seoul' },
      attendees: [{ email: 'person@example.com' }],
    };
    const result = await write({ op: 'create', meet: true, event });
    expect(result).toMatchObject({
      status: 'completed',
      data: {
        id: 'fixture-event',
        meetLink: 'https://meet.google.com/abc-defg-hij',
        attendees: ['person@example.com'],
      },
    });
    const argv = argvRun()!;
    expect(argv.slice(0, 4)).toEqual(['calendar', 'events', 'insert', '--params']);
    expect(JSON.parse(argv[4]!)).toEqual({
      calendarId: 'primary',
      sendUpdates: 'all',
      conferenceDataVersion: 1,
    });
    expect(argv[5]).toBe('--json');
    const body = JSON.parse(argv[6]!);
    expect(body).toMatchObject({
      ...event,
      conferenceData: { createRequest: { conferenceSolutionKey: { type: 'hangoutsMeet' } } },
    });
    expect(body.conferenceData.createRequest.requestId).toEqual(expect.any(String));
    expect(argv).toHaveLength(7);
    expect(
      readFileSync(cwdLog, 'utf8')
        .trim()
        .startsWith(`${realpathSync(scratch)}/call-`)
    ).toBe(true);
    expect(readdirSync(scratch)).toEqual([]);
  });

  it('says when Google is still making the Meet link, and when it failed', async () => {
    const pending = {
      ...created,
      hangoutLink: undefined,
      conferenceData: { createRequest: { status: { statusCode: 'pending' } } },
    };
    fakeGws(`echo '${JSON.stringify(pending)}'`);
    const result = await write({ op: 'create', meet: true, event: { start: {}, end: {} } });
    expect(result).toMatchObject({
      status: 'completed',
      data: { meetLink: null, meetStatus: 'pending', next: expect.stringContaining('events get') },
    });
    fakeGws(
      `echo '${JSON.stringify({ ...pending, conferenceData: { createRequest: { status: { statusCode: 'failure' } } } })}'`
    );
    const failed = await write({ op: 'create', meet: true, event: { start: {}, end: {} } });
    expect(failed).toMatchObject({ data: { meetLink: null, meetStatus: 'failure' } });
    expect((failed as { data: Record<string, unknown> }).data.next).toBeUndefined();
  });

  it('gives one operation one event id, and reads the event back when a retry finds it made', async () => {
    fakeGws(`echo '${JSON.stringify(created)}'`);
    const event = { start: {}, end: {} };
    await write({ op: 'create', event }, undefined, 'fixture-operation');
    const first = JSON.parse(argvRun()![6]!).id as string;
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    await write({ op: 'create', event }, undefined, 'fixture-operation');
    expect(JSON.parse(argvRun()![6]!).id).toBe(first);
    await write({ op: 'create', event }, undefined, 'another-operation');
    expect(JSON.parse(argvRun()![6]!).id).not.toBe(first);

    // The insert answers 409 (made by the lost attempt); the event is read back.
    fakeGws(
      `case "$3" in insert) echo '{"error":{"code":409,"message":"The requested identifier already exists.","reason":"duplicate"}}'; exit 1;; *) echo '${JSON.stringify(created)}';; esac`
    );
    const again = await write({ op: 'create', event }, undefined, 'fixture-operation');
    expect(again).toMatchObject({
      status: 'completed',
      data: { id: 'fixture-event', existing: true },
    });
    expect(argvRun()!.slice(0, 3)).toEqual(['calendar', 'events', 'get']);
    expect(JSON.parse(argvRun()![4]!)).toEqual({ calendarId: 'primary', eventId: first });

    // Any other failure names the id so the agent can check before creating again.
    fakeGws(
      `echo '{"error":{"code":500,"message":"Backend Error","reason":"backendError"}}'\nexit 1`
    );
    const failed = await write({ op: 'create', event }, undefined, 'fixture-operation');
    expect((failed as { error: { message: string } }).error.message).toContain(
      `its id is ${first}`
    );
  });

  it('needs the calendar connector grant', async () => {
    fakeGws(`echo '{}'`);
    const result = await write({ op: 'delete', eventId: 'fixture-event' }, undefined, undefined, {
      ...access,
      connectors: ['gmail'],
    });
    expect(result).toMatchObject({ status: 'failed' });
    expect(argvRun()).toBeNull();
  });

  it('changes and cancels a named event, sending updates as asked', async () => {
    fakeGws(`echo '${JSON.stringify(created)}'`);
    await write({
      op: 'update',
      calendarId: 'team@example.com',
      eventId: 'fixture-event',
      event: { summary: 'Moved' },
      sendUpdates: 'none',
    });
    expect(argvRun()!.slice(0, 3)).toEqual(['calendar', 'events', 'patch']);
    expect(JSON.parse(argvRun()![4]!)).toEqual({
      calendarId: 'team@example.com',
      eventId: 'fixture-event',
      sendUpdates: 'none',
      conferenceDataVersion: 1,
    });
    expect(JSON.parse(argvRun()![6]!)).toEqual({ summary: 'Moved' });

    fakeGws('');
    expect(await write({ op: 'delete', eventId: 'fixture-event' })).toMatchObject({
      status: 'completed',
      data: { id: 'fixture-event', deleted: true },
    });
    expect(argvRun()).toEqual([
      'calendar',
      'events',
      'delete',
      '--params',
      '{"calendarId":"primary","sendUpdates":"all","eventId":"fixture-event"}',
    ]);
  });

  it.each([
    ['an update without eventId', { op: 'update', event: { summary: 'x' } }, 'needs eventId'],
    ['a delete without eventId', { op: 'delete' }, 'needs eventId'],
    ['a create without event', { op: 'create' }, 'needs event'],
  ])('refuses %s before gws runs', async (_case, input, says) => {
    fakeGws(`echo '{}'`);
    const result = await write(input);
    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'google_calendar_event_missing' },
    });
    expect((result as { error: { message: string } }).error.message).toContain(says);
    expect(argvRun()).toBeNull();
  });

  it('does not write in a turn no owner message started, before gws runs', async () => {
    fakeGws(`echo '{}'`);
    ownerTurn = false;
    const result = await write({ op: 'delete', eventId: 'fixture-event' });
    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'google_calendar_owner_message_required' },
    });
    expect(argvRun()).toBeNull();
  });

  it('is not available in a replay', async () => {
    fakeGws(`echo '{}'`);
    const result = await write({ op: 'delete', eventId: 'fixture-event' }, {
      replaySourceEndMs: 1,
    } as ActionContext['session']);
    expect(result).toMatchObject({ status: 'failed', error: { code: 'google_calendar_replay' } });
    expect(argvRun()).toBeNull();
  });

  it('tells a read-only login to sign in again with the calendar scope', async () => {
    fakeGws(
      `echo '{"error":{"code":403,"message":"Request had insufficient authentication scopes.","reason":"insufficientPermissions"}}'\nexit 1`
    );
    const result = await write({ op: 'delete', eventId: 'fixture-event' });
    expect(result).toMatchObject({ status: 'failed', error: { code: 'google_scope_missing' } });
    expect((result as { error: { message: string } }).error.message).toContain(
      'The login must include https://www.googleapis.com/auth/calendar.'
    );
  });
});
