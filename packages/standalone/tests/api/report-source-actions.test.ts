import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCatalog, createDispatcher, type ActionContext } from '@jungjaehoon/mama-core';
import { reportSourceActionRegistrations } from '../../src/api/report-source-actions.js';
import { createTimeZoneSetting, localDateKey } from '../../src/runtime/timezone.js';

const now = Date.now();
const rows = [
  {
    source_connector: 'slack',
    source_id: 'one',
    source_entity_id: 'one',
    channel: 'room-a',
    author: 'Writer',
    content: 'First update',
    source_timestamp_ms: now - 1_000,
    current_observation_id: 'obs-one',
    metadata_json: '{"channelName":"Room A"}',
  },
  {
    source_connector: 'slack',
    source_id: 'two',
    source_entity_id: 'two',
    channel: 'room-b',
    author: 'Writer',
    content: 'Hidden update',
    source_timestamp_ms: now - 2_000,
    current_observation_id: 'obs-two',
    metadata_json: '{}',
  },
  {
    source_connector: 'calendar',
    source_id: 'event-v1',
    source_entity_id: 'event',
    channel: 'main',
    source_timestamp_ms: now,
    current_observation_id: 'obs-event',
    metadata_json: JSON.stringify({
      start: new Date(now + 3_600_000).toISOString(),
      end: new Date(now + 7_200_000).toISOString(),
      summary: 'Calendar event',
      status: 'confirmed',
      calendarName: 'Owner calendar',
    }),
  },
  {
    source_connector: 'ical',
    source_id: 'booking-v1',
    source_entity_id: 'booking',
    channel: 'lodging',
    source_timestamp_ms: now,
    current_observation_id: 'obs-booking',
    metadata_json: JSON.stringify({
      start: new Date(now + 4_000_000).toISOString(),
      end: new Date(now + 8_000_000).toISOString(),
      summary: 'Booking',
      status: 'confirmed',
      feedName: 'Lodging feed',
    }),
  },
];

function setup(sourceRows = rows) {
  const adapter = {
    prepare: (sql: string) => ({
      all: (..._params: unknown[]) => {
        if (sql.includes('connector_event_index_cursors'))
          return [
            {
              connector_name: 'slack',
              last_error: 'poll failed',
              last_error_at: new Date(now).toISOString(),
            },
          ];
        if (sql.includes('GROUP BY source_connector, channel'))
          return [
            ...new Map(
              sourceRows
                .filter((row) => row.source_connector === 'slack')
                .map((row) => [
                  row.channel,
                  {
                    source_connector: row.source_connector,
                    channel: row.channel,
                    channel_name: (JSON.parse(row.metadata_json) as { channelName?: string })
                      .channelName,
                  },
                ])
            ).values(),
          ];
        if (sql.includes('ROW_NUMBER()'))
          return sourceRows.filter(
            (row) => row.source_connector === 'calendar' || row.source_connector === 'ical'
          );
        return sourceRows.filter((row) => row.source_connector === 'slack');
      },
    }),
  };
  const dispatch = createDispatcher(
    createCatalog(
      reportSourceActionRegistrations({
        adapter: adapter as never,
        ownerPrincipalId: 'owner',
        timeZone: createTimeZoneSetting('America/Los_Angeles'),
      })
    )
  );
  const access: ActionContext['access'] = {
    principalId: 'limited-reader',
    agentId: 'agent',
    actions: ['source.recent', 'schedule.upcoming'],
    connectors: ['slack', 'calendar', 'ical'],
    scopes: [],
    channels: { slack: ['room-a'], calendar: ['main'], ical: ['lodging'] },
  };
  return { dispatch, access };
}

describe('report source reads', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('classifies an unparseable source.recent since value as invalid input', async () => {
    const { dispatch, access } = setup();
    const result = await dispatch(
      { action: 'source.recent', input: { since: 'yesterday' } },
      { access }
    );
    expect(result).toMatchObject({
      status: 'failed',
      error: { kind: 'invalid_input', code: 'invalid_input' },
    });
  });

  it('lists the changed channels first, obeys channel grants, and exposes failed poll visibility', async () => {
    const { dispatch, access } = setup();
    const result = await dispatch(
      { action: 'source.recent', input: { since: now - 60_000 } },
      { access }
    );
    expect(result).toMatchObject({
      status: 'completed',
      data: {
        channels: [
          {
            source: 'slack',
            channel: 'room-a',
            channelName: 'Room A',
            key: 'slack:room-a',
            count: 1,
            latest: {
              author: 'Writer',
              text: 'First update',
              time: expect.stringContaining('(America/Los_Angeles)'),
            },
          },
        ],
        failedConnectors: [{ connector: 'slack', channels: ['Room A'], error: 'poll failed' }],
      },
    });
    const listed = (result as { data: { channels: Array<Record<string, unknown>> } }).data
      .channels[0]!;
    expect(listed).not.toHaveProperty('lines');
    expect(JSON.stringify(result)).not.toContain('Hidden update');

    const lines = await dispatch(
      { action: 'source.recent', input: { since: now - 60_000, channels: [listed.key] } },
      { access }
    );
    expect(lines).toMatchObject({
      status: 'completed',
      data: {
        channels: [
          {
            key: listed.key,
            lines: [
              {
                author: 'Writer',
                text: 'First update',
                observationRef: 'obs-one',
                time: expect.stringContaining('(America/Los_Angeles)'),
              },
            ],
          },
        ],
      },
    });
    expect(
      await dispatch(
        { action: 'source.recent', input: { since: now - 60_000, channels: ['slack:nowhere'] } },
        { access }
      )
    ).toMatchObject({
      status: 'failed',
      error: { code: 'invalid_input', message: expect.stringContaining('slack:nowhere') },
    });
  });

  it('reads a named channel whatever the cap on the channel list', async () => {
    const { dispatch, access } = setup();
    const owner = { ...access, principalId: 'owner', channels: undefined };
    const listed = (await dispatch(
      { action: 'source.recent', input: { since: now - 60_000 } },
      { access: owner }
    )) as { data: { channels: Array<{ key: string }> } };
    expect(listed.data.channels.length).toBeGreaterThan(1);
    const key = listed.data.channels[0]!.key;
    expect(
      await dispatch(
        { action: 'source.recent', input: { since: now - 60_000, cap: 1, channels: [key] } },
        { access: owner }
      )
    ).toMatchObject({ status: 'completed', data: { channels: [{ key }] } });
  });

  it('fails loudly as invalid input when recent channels exceed the stated cap', async () => {
    const { dispatch, access } = setup();
    const owner = { ...access, principalId: 'owner', channels: undefined };
    const result = await dispatch(
      { action: 'source.recent', input: { since: now - 60_000, cap: 1 } },
      { access: owner }
    );
    expect(result).toMatchObject({
      status: 'failed',
      error: {
        kind: 'invalid_input',
        code: 'invalid_input',
        message: expect.stringContaining('narrow since or cap'),
      },
    });
  });

  it('reads collected calendar and iCal events in one bounded upcoming list', async () => {
    const { dispatch, access } = setup();
    const result = await dispatch({ action: 'schedule.upcoming', input: { days: 14 } }, { access });
    expect(result).toMatchObject({
      status: 'completed',
      data: {
        returned: 2,
        events: [
          { source: 'calendar', calendar: 'Owner calendar', title: 'Calendar event' },
          { source: 'ical', calendar: 'Lodging feed', title: 'Booking' },
        ],
      },
    });
  });

  it('sorts upcoming events by parsed time and omits a cancelled latest version', async () => {
    // The fixtures name fixed October 2026 events; fix the clock so they stay upcoming.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-28T00:00:00.000Z') });
    const local = {
      ...rows[2]!,
      source_id: 'event-local',
      source_entity_id: 'event-local',
      metadata_json: JSON.stringify({
        start: '2026-10-01T10:00:00+09:00',
        end: '2026-10-01T11:00:00+09:00',
        summary: 'Local time first',
        status: 'confirmed',
      }),
    };
    const utc = {
      ...rows[3]!,
      source_id: 'event-utc',
      source_entity_id: 'event-utc',
      metadata_json: JSON.stringify({
        start: '2026-10-01T02:00:00Z',
        end: '2026-10-01T03:00:00Z',
        summary: 'UTC time second',
        status: 'confirmed',
      }),
    };
    const { dispatch, access } = setup([local, utc]);
    const ordered = await dispatch({ action: 'schedule.upcoming', input: {} }, { access });
    expect(ordered).toMatchObject({
      status: 'completed',
      data: { events: [{ title: 'Local time first' }, { title: 'UTC time second' }] },
    });
    const cancelled = {
      ...utc,
      metadata_json: JSON.stringify({ ...JSON.parse(utc.metadata_json), status: 'cancelled' }),
    };
    const canceledSetup = setup([cancelled]);
    const canceledResult = await canceledSetup.dispatch(
      { action: 'schedule.upcoming', input: {} },
      { access }
    );
    expect(canceledResult).toMatchObject({
      status: 'completed',
      data: { returned: 0, events: [] },
    });
  });

  it('sorts mixed iCal date forms by epoch and excludes an all-day event at its exclusive end', async () => {
    // The fixtures name fixed October 2026 events; fix the clock so they stay upcoming.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-28T00:00:00.000Z') });
    const today = localDateKey(Date.now(), 'America/Los_Angeles');
    const [year, month, day] = today.split('-').map(Number);
    const prior = new Date(Date.UTC(year!, month! - 1, day! - 1)).toISOString().slice(0, 10);
    const make = (id: string, title: string, metadata: Record<string, unknown>) => ({
      ...rows[3]!,
      source_id: id,
      source_entity_id: id,
      metadata_json: JSON.stringify({ status: 'confirmed', summary: title, ...metadata }),
    });
    const items = [
      make('all-day-ended', 'Ended all day', {
        start: prior,
        end: today,
        allDay: true,
        endExclusive: true,
      }),
      make('date-only', 'Date only', {
        start: '20261001',
        end: '20261002',
      }),
      make('utc', 'UTC', {
        start: '2026-10-01T06:00:00Z',
        end: '2026-10-01T07:00:00Z',
      }),
      make('offset', 'Offset', {
        start: '2026-10-01T02:00:00+02:00',
        end: '2026-10-01T03:00:00+02:00',
      }),
    ];
    const { dispatch, access } = setup(items);
    const result = await dispatch({ action: 'schedule.upcoming', input: {} }, { access });
    expect(result).toMatchObject({
      status: 'completed',
      data: { events: [{ title: 'Offset' }, { title: 'UTC' }, { title: 'Date only' }] },
    });
  });

  it('applies source channel grants and fails loudly at the upcoming event cap', async () => {
    const { dispatch, access } = setup();
    const scoped = { ...access, channels: { ...access.channels, ical: [] } };
    const visible = await dispatch({ action: 'schedule.upcoming', input: {} }, { access: scoped });
    expect(visible).toMatchObject({
      status: 'completed',
      data: { returned: 1, events: [{ source: 'calendar' }] },
    });
    const capped = await dispatch({ action: 'schedule.upcoming', input: { cap: 1 } }, { access });
    expect(capped).toMatchObject({
      status: 'failed',
      error: { message: expect.stringContaining('narrow days') },
    });
  });
});
