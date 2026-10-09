import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConnector } from '../../src/connectors/index.js';
import type { ConnectorConfig } from '../../src/connectors/framework/types.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCatalog, createDispatcher, type ActionContext } from '@jungjaehoon/mama-core';
import { startConnectorRuntime } from '../../src/runtime/connectors.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { RawStore } from '../../src/storage/source-archive.js';
import { sourceActionRegistrations } from '../../src/api/source-actions.js';
import { createStoredSourceReader } from '../../src/api/stored-source-reader.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';
import { storedSourceFamilies } from '../../src/connectors/framework/stored-index-read.js';
import { ownerSystemPrompt } from '../../src/runtime/owner-system-prompt.js';

// Only the process boundary is mocked: exercise the real gws parser and connector.
const gws = vi.hoisted(() => ({ run: vi.fn<(args: string[]) => string>() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: (
    file: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string) => void
  ) => {
    if (file !== 'gws') throw new Error('Unexpected executable');
    try {
      callback(null, gws.run(args));
    } catch (error) {
      callback(error as Error, '');
    }
  },
}));

const config: ConnectorConfig = {
  enabled: true,
  pollIntervalMinutes: 5,
  channels: { calendar: { role: 'reference' } },
  auth: { type: 'cli', cli: 'gws', cliAuthCommand: 'gws auth login' },
};
const now = new Date('2024-01-15T00:00:00.000Z');
const stateRoots: string[] = [];
function statePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'calendar-state-'));
  stateRoots.push(root);
  return join(root, 'calendar-state.json');
}
const since = new Date('2024-01-10T00:00:00.000Z');
const event = (overrides: Record<string, unknown> = {}) => ({
  id: 'fixture-event',
  updated: '2024-01-14T12:00:00.000Z',
  summary: 'Schedule review',
  description: 'Weekly sync',
  start: { dateTime: '2024-01-16T10:00:00+09:00' },
  end: { dateTime: '2024-01-16T11:00:00+09:00' },
  location: 'Meeting room',
  organizer: { displayName: 'Fixture organizer', email: 'organizer@example.invalid' },
  status: 'confirmed',
  ...overrides,
});
const list = (items: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ items, ...extra });

async function initialized() {
  const connector = await loadConnector('calendar', config, { connectorStatePath: statePath() });
  await connector.init();
  gws.run.mockClear();
  return connector;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  gws.run.mockReset().mockReturnValue(list([]));
});
afterEach(() => {
  vi.useRealTimers();
  for (const root of stateRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('CalendarConnector (ported from the pre-stub connector)', () => {
  it('loads through the production loader and verifies calendar access at init', async () => {
    const connector = await loadConnector('calendar', config, { connectorStatePath: statePath() });
    await connector.init();
    expect(connector.name).toBe('calendar');
    expect(connector.type).toBe('api');
    expect(connector.getAuthRequirements()).toMatchObject([
      { type: 'cli', cli: 'gws', cliAuthCommand: 'gws auth login' },
    ]);
    expect(gws.run).toHaveBeenCalledWith([
      'calendar',
      'events',
      'list',
      '--params',
      JSON.stringify({ calendarId: 'primary', maxResults: 1 }),
    ]);
    await expect(connector.authenticate()).resolves.toBe(true);
    await expect(connector.dispose()).resolves.toBeUndefined();
  });

  it.each([
    [
      Object.assign(new Error('spawn gws ENOENT'), { code: 'ENOENT' }),
      /install.*gws.*PATH.*start\.sh/i,
    ],
    [new Error('401 invalid credentials'), /gws auth login/i],
    [new Error('403 insufficient scope'), /gws auth login/i],
  ])('fails at init with an actionable fix: %s', async (error, fix) => {
    gws.run.mockImplementation(() => {
      throw error;
    });
    const connector = await loadConnector('calendar', config, { connectorStatePath: statePath() });
    await expect(connector.init()).rejects.toThrow(fix);
    await expect(connector.healthCheck()).resolves.toMatchObject({
      healthy: false,
      lastPollCount: 0,
    });
    await expect(connector.authenticate()).resolves.toBe(false);
  });

  it('rejects JSON error output even when gws exits successfully', async () => {
    gws.run.mockReturnValue(JSON.stringify({ error: { code: 401, message: 'Login required' } }));
    const connector = await loadConnector('calendar', config, { connectorStatePath: statePath() });
    await expect(connector.init()).rejects.toThrow(/gws auth login/);
  });

  it('keeps the measured 90-day bound, page size, expansion and cancellation parameters', async () => {
    const connector = await initialized();
    await expect(connector.poll(since)).resolves.toEqual([]);
    expect(gws.run).toHaveBeenCalledWith([
      'calendar',
      'events',
      'list',
      '--params',
      JSON.stringify({
        calendarId: 'primary',
        timeMin: now.toISOString(),
        timeMax: '2024-04-14T00:00:00.000Z',
        singleEvents: true,
        showDeleted: true,
        orderBy: 'startTime',
        maxResults: 250,
      }),
    ]);
  });

  it('collects the complete first calendar window and uses updatedMin after a cursor exists', async () => {
    const connector = await initialized();
    const initial = await connector.poll(since, { hasCursor: false });
    expect(initial.every((item) => item.collectOnly === true)).toBe(true);
    const first = JSON.parse(gws.run.mock.calls[0]![0]!.at(-1)!) as Record<string, unknown>;
    expect(first).not.toHaveProperty('updatedMin');
    connector.commitPoll?.();
    gws.run.mockClear();
    const laterItems = await connector.poll(since, { hasCursor: true });
    expect(laterItems.every((item) => item.collectOnly !== true)).toBe(true);
    const later = JSON.parse(gws.run.mock.calls[0]![0]!.at(-1)!) as Record<string, unknown>;
    expect(later.updatedMin).toBe(since.toISOString());
  });

  it('reads configured calendars with their keys as channels and display names', async () => {
    const connector = await loadConnector(
      'calendar',
      {
        ...config,
        channels: {
          calendar: { role: 'reference', name: 'Owner calendar' },
          holidays: { role: 'reference', calendarId: 'holiday-id', name: 'Public holidays' },
        },
      },
      { connectorStatePath: statePath() }
    );
    await connector.init();
    gws.run.mockClear().mockReturnValue(list([event()]));
    const items = await connector.poll(since, { hasCursor: false });
    expect(gws.run).toHaveBeenCalledTimes(2);
    expect(items.map((item) => item.channel)).toEqual(['calendar', 'holidays']);
    expect(items[1]?.metadata).toMatchObject({
      calendarName: 'Public holidays',
      calendarId: 'holiday-id',
    });
  });

  it('normalizes schedule fields and versions changes without changing event identity', async () => {
    const connector = await initialized();
    gws.run.mockReturnValue(list([event()]));
    const [first] = await connector.poll(since);
    expect(first).toMatchObject({
      source: 'calendar',
      channel: 'calendar',
      type: 'event',
      sourceEntityId: 'fixture-event',
      sourceId: expect.stringMatching(/^fixture-event:[a-f0-9]{24}$/),
      author: 'Fixture organizer',
      timestamp: new Date('2024-01-14T12:00:00Z'),
      sourceCursor: '2024-01-14T12:00:00.000Z',
      metadata: {
        eventId: 'fixture-event',
        updated: '2024-01-14T12:00:00.000Z',
        summary: 'Schedule review',
        location: 'Meeting room',
        start: '2024-01-16T10:00:00+09:00',
        end: '2024-01-16T11:00:00+09:00',
        organizer: { displayName: 'Fixture organizer', email: 'organizer@example.invalid' },
        status: 'confirmed',
        allDay: false,
        endExclusive: false,
      },
    });
    expect(first?.metadata).not.toHaveProperty('startKind');
    expect(first?.metadata).not.toHaveProperty('endKind');
    for (const field of [
      'Schedule review',
      '2024-01-16T10:00:00+09:00',
      '2024-01-16T11:00:00+09:00',
      'Meeting room',
      'Fixture organizer',
      'Weekly sync',
    ]) {
      expect(first?.content).toContain(field);
    }
    vi.setSystemTime(new Date(now.getTime() + 300_000));
    const [same] = await connector.poll(since);
    expect(same?.sourceId).toBe(first?.sourceId);
    gws.run.mockReturnValue(
      list([event({ location: 'Other room', updated: '2024-01-14T13:00:00.000Z' })])
    );
    const [changed] = await connector.poll(since);
    expect(changed?.sourceId).not.toBe(first?.sourceId);
    expect(changed?.sourceEntityId).toBe(first?.sourceEntityId);
  });

  it('records event update time and keeps a cancelled id-only event as a change', async () => {
    const connector = await initialized();
    gws.run.mockReturnValue(
      list([
        {
          id: 'fixture-cancelled',
          updated: '2024-01-14T18:30:00.000Z',
          status: 'cancelled',
        },
      ])
    );

    const [item] = await connector.poll(since);

    expect(item).toMatchObject({
      sourceEntityId: 'fixture-cancelled',
      timestamp: new Date('2024-01-14T18:30:00.000Z'),
      sourceCursor: '2024-01-14T18:30:00.000Z',
      metadata: {
        eventId: 'fixture-cancelled',
        updated: '2024-01-14T18:30:00.000Z',
        status: 'cancelled',
      },
    });
  });

  it('preserves all-day exclusive ends and upstream timezone for lodging stays', async () => {
    const connector = await initialized();
    gws.run.mockReturnValue(
      list([event({ start: { date: '2024-01-16' }, end: { date: '2024-01-19' } })], {
        timeZone: 'Asia/Seoul',
      })
    );
    const [item] = await connector.poll(since);
    expect(item?.metadata).toMatchObject({
      start: '2024-01-16',
      end: '2024-01-19',
      allDay: true,
      endExclusive: true,
      timeZone: 'Asia/Seoul',
    });
  });

  it('keeps optional fields optional and retains an organizer with only an email', async () => {
    const connector = await initialized();
    gws.run.mockReturnValue(
      list([
        event({
          summary: undefined,
          description: undefined,
          location: undefined,
          organizer: { email: 'organizer@example.invalid' },
        }),
      ])
    );
    const [item] = await connector.poll(since);
    expect(item?.content).toContain('(No title)');
    expect(item?.content).not.toContain('undefined');
    expect(item?.metadata?.organizer).toEqual({ email: 'organizer@example.invalid' });
  });

  it('omits attendees and removes emails and phone numbers from preview text', async () => {
    const connector = await initialized();
    gws.run.mockReturnValue(
      list([
        event({
          summary: 'Review guest@example.invalid',
          description:
            'Contact guest@example.invalid +82 10-0000-0000 or (202) 555-0100; date 2024-01-16',
          location: 'Room 010-0000-0000',
          organizer: { displayName: 'Host 02-000-0000', email: 'organizer@example.invalid' },
          attendees: [{ email: 'guest@example.invalid' }],
        }),
      ])
    );
    const [item] = await connector.poll(since);
    const preview = `${item?.content} ${item?.author}`;
    for (const privateText of [
      'guest@example.invalid',
      '+82 10-0000-0000',
      '(202) 555-0100',
      '010-0000-0000',
      '02-000-0000',
    ]) {
      expect(preview).not.toContain(privateText);
    }
    expect(preview).toContain('2024-01-16');
    expect(item?.metadata).not.toHaveProperty('attendees');
  });

  it('collects every page, including cancellations, using literal arguments for page tokens', async () => {
    const connector = await initialized();
    const token = "page'$(untrusted);two";
    gws.run
      .mockReturnValueOnce(list([event()], { nextPageToken: token }))
      .mockReturnValueOnce(list([event({ id: 'fixture-cancelled', status: 'cancelled' })]));
    const items = await connector.poll(since);
    expect(items).toHaveLength(2);
    expect(items[1]?.metadata?.status).toBe('cancelled');
    const args = gws.run.mock.calls[1]![0];
    expect(args.slice(0, 4)).toEqual(['calendar', 'events', 'list', '--params']);
    expect(JSON.parse(args[4]!).pageToken).toBe(token);
  });

  it('rejects repeated page tokens without returning a partial snapshot', async () => {
    const connector = await initialized();
    gws.run.mockReturnValue(list([event()], { nextPageToken: 'repeat' }));
    await expect(connector.poll(since)).rejects.toThrow(/repeated.*page token/i);
    expect(gws.run).toHaveBeenCalledTimes(2);
    await expect(connector.healthCheck()).resolves.toMatchObject({
      healthy: false,
      lastPollCount: 0,
    });
  });

  it('rejects an incomplete snapshot at the 20-page cap', async () => {
    const connector = await initialized();
    let page = 0;
    gws.run.mockImplementation(() => list([event()], { nextPageToken: `page-${++page}` }));
    await expect(connector.poll(since)).rejects.toThrow(/page cap.*incomplete/i);
    expect(page).toBe(20);
    await expect(connector.healthCheck()).resolves.toMatchObject({
      healthy: false,
      lastPollCount: 0,
    });
  });

  it('accepts a complete twentieth page', async () => {
    const connector = await initialized();
    let page = 0;
    gws.run.mockImplementation(() =>
      list([event({ id: `event-${++page}` })], page < 20 ? { nextPageToken: `page-${page}` } : {})
    );
    await expect(connector.poll(since)).resolves.toHaveLength(20);
  });

  it('parses keyring prefixes and resets health after a successful poll', async () => {
    const connector = await initialized();
    gws.run.mockReturnValueOnce('not JSON');
    await expect(connector.poll(since)).rejects.toThrow(/JSON/);
    gws.run.mockReturnValue('Using keyring backend: fixture\n' + list([event()]));
    await expect(connector.poll(since)).resolves.toHaveLength(1);
    await expect(connector.healthCheck()).resolves.toEqual({
      healthy: true,
      lastPollTime: now,
      lastPollCount: 1,
      error: undefined,
    });
  });
});

describe('calendar through the daemon connector runtime', () => {
  it.each([false, true])(
    'honors enabled=%s and keeps the first schedule snapshot collect-only',
    async (enabled) => {
      const root = mkdtempSync(join(tmpdir(), 'calendar-runtime-'));
      const database = await openCoreDatabase({ path: join(root, 'core.db') });
      const rawStore = new RawStore(join(root, 'raw'));
      const configPath = join(root, 'connectors.json');
      const statePath = join(root, 'state');
      const serialized = JSON.stringify({ calendar: { ...config, enabled } });
      writeFileSync(configPath, serialized);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // First response proves access, the second is the first full snapshot.
      gws.run.mockReturnValueOnce(list([])).mockReturnValue(
        list(
          [
            event({
              summary: 'Lodging stay',
              start: { date: '2024-01-16' },
              end: { date: '2024-01-19' },
            }),
            event({
              id: 'fixture-deadline',
              summary: 'Upcoming deadline',
              start: { date: '2024-01-28' },
              end: { date: '2024-01-29' },
            }),
          ],
          { timeZone: 'Asia/Seoul' }
        )
      );
      const accept = vi.fn();
      let runtime: Awaited<ReturnType<typeof startConnectorRuntime>> | undefined;
      try {
        runtime = await startConnectorRuntime({
          timeZone: createTimeZoneSetting('UTC'),
          configPath,
          rawPath: join(root, 'raw'),
          statePath,
          rawStore,
          coreAdapter: database.adapter,
          clock: () => now.getTime(),
          acceptSourceDelta: accept,
          setInterval: vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>),
          clearInterval: vi.fn(),
        });
        expect(readFileSync(configPath, 'utf8')).toBe(serialized);
        expect(warn).not.toHaveBeenCalled();
        expect(runtime.enabledConnectorNames).toEqual(enabled ? ['calendar'] : []);
        if (!enabled) {
          expect(gws.run).not.toHaveBeenCalled();
          expect(runtime.registry.get('calendar')).toBeUndefined();
          return;
        }
        expect(runtime.registry.get('calendar')?.name).toBe('calendar');
        expect(accept).not.toHaveBeenCalled();
        expect(rawStore.query('calendar', new Date(0))).toHaveLength(2);
        const families = storedSourceFamilies(database.adapter, ['calendar'], {
          principalId: 'fixture-owner',
          agentId: 'fixture-agent',
          actions: [],
          connectors: ['calendar'],
          connectorWideRead: ['calendar'],
          scopes: [],
        });
        // A first snapshot is indexed and readable, but not admitted as live source work.
        expect(families).toEqual([{ source: 'calendar', family: null, count: 2 }]);
        for (const backend of ['claude', 'codex'] as const) {
          expect(ownerSystemPrompt(backend, null, families, true, 'UTC')).toContain(
            'Readable sources: calendar (2)'
          );
        }
        const access: ActionContext['access'] = {
          principalId: 'fixture-owner',
          agentId: 'fixture-agent',
          actions: ['source.search', 'source.read'],
          connectors: ['calendar'],
          connectorWideRead: ['calendar'],
          scopes: [],
        };
        const stored = createStoredSourceReader({
          adapter: database.adapter,
          rawStore: () => rawStore,
        });
        const dispatch = createDispatcher(
          createCatalog(
            sourceActionRegistrations({ stored, timeZone: createTimeZoneSetting('UTC') })
          )
        );
        const found = await dispatch(
          {
            action: 'source.search',
            input: {
              source: 'calendar',
              from: '2024-01-14T00:00:00Z',
              to: '2024-01-29T00:00:00Z',
            },
          },
          { access }
        );
        expect(found).toMatchObject({
          status: 'completed',
          data: {
            hits: expect.arrayContaining([
              expect.objectContaining({ text: expect.stringContaining('Lodging stay') }),
              expect.objectContaining({
                text: expect.stringContaining('Upcoming deadline'),
              }),
            ]),
          },
        });
        const hits = (found as { data: { hits: Array<{ text: string; observationRef: string }> } })
          .data.hits;
        const lodging = hits.find((hit) => hit.text.includes('Lodging stay'))!;
        const read = await dispatch(
          {
            action: 'source.read',
            input: { source: 'calendar', observationRef: lodging.observationRef },
          },
          { access }
        );
        expect(read).toMatchObject({
          status: 'completed',
          data: {
            content: expect.stringContaining('Lodging stay'),
            metadata: {
              start: '2024-01-16',
              end: '2024-01-19',
              location: 'Meeting room',
              allDay: true,
              endExclusive: true,
              organizer: { displayName: 'Fixture organizer' },
            },
          },
        });
        await runtime.pollNow();
        expect(accept).not.toHaveBeenCalled();
        expect(
          storedSourceFamilies(database.adapter, ['calendar'], {
            principalId: 'fixture-owner',
            agentId: 'fixture-agent',
            actions: [],
            connectors: ['calendar'],
            connectorWideRead: ['calendar'],
            scopes: [],
          })
        ).toEqual(families);
        // A failed page must not advance the cursor or publish a partial schedule.
        const cursor = runtime.scheduler.getLastPollTime('calendar');
        gws.run.mockReturnValue(
          list([event({ summary: 'Partial snapshot' })], { nextPageToken: 'repeat' })
        );
        vi.setSystemTime(new Date(now.getTime() + 300_000));
        await runtime.pollNow();
        expect(runtime.scheduler.getLastPollTime('calendar')).toEqual(cursor);
        expect(accept).not.toHaveBeenCalled();
        expect(rawStore.query('calendar', new Date(0))).toHaveLength(2);
      } finally {
        await runtime?.stop();
        rawStore.close();
        await database.close();
        warn.mockRestore();
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it('collects the whole window once for a calendar added after earlier polls', async () => {
    const path = statePath();
    writeFileSync(path, JSON.stringify({ synced: ['calendar'] }));
    const connector = await loadConnector(
      'calendar',
      {
        ...config,
        channels: {
          calendar: { role: 'reference', name: 'Primary calendar' },
          holidays: { role: 'reference', calendarId: 'holiday-id', name: 'Holidays' },
        },
      },
      { connectorStatePath: path }
    );
    await connector.init();
    gws.run.mockClear();
    await connector.poll(since, { hasCursor: true });
    const params = gws.run.mock.calls.map((call) => JSON.parse(call[0][4] as string));
    expect(params.find((p) => p.calendarId === 'primary')).toHaveProperty('updatedMin');
    expect(params.find((p) => p.calendarId === 'holiday-id')).not.toHaveProperty('updatedMin');
    connector.commitPoll?.();
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ synced: ['calendar', 'holidays'] });
  });
});
