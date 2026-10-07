import { invalidInput } from '../utils/invalid-input.js';
import type { ActionRegistration } from '@jungjaehoon/mama-core';
import type { ActionContext } from '@jungjaehoon/mama-core';
import type { DatabaseAdapter } from '@jungjaehoon/mama-core/db-manager';
import type { TimeZoneSetting } from '../runtime/timezone.js';
import { durationEndEpoch, epochForCalendarValue } from '../runtime/timezone.js';

type Access = ActionContext['access'];
type Row = Record<string, unknown>;
type ReportReadPorts = {
  adapter: Pick<DatabaseAdapter, 'prepare'>;
  ownerPrincipalId: string;
  timeZone: TimeZoneSetting;
};

function grantChannels(
  access: Access,
  connector: string,
  ownerPrincipalId: string
): string[] | null {
  if (!access.connectors?.includes(connector)) return [];
  if (access.principalId === ownerPrincipalId) return null;
  return [
    ...new Set((access.channels?.[connector] ?? []).filter((channel) => channel.trim() !== '')),
  ];
}

function allowedRows(rows: Row[], access: Access, ownerPrincipalId: string): Row[] {
  return rows.filter((row) => {
    const connector = String(row.source_connector);
    const channels = grantChannels(access, connector, ownerPrincipalId);
    return channels !== null && channels.length === 0
      ? false
      : channels === null || channels.includes(String(row.channel ?? ''));
  });
}

function visibleConnectorFilter(
  connectors: readonly string[],
  access: Access,
  ownerPrincipalId: string
): { sql: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  for (const connector of connectors) {
    const wide = access.principalId === ownerPrincipalId;
    if (wide) {
      clauses.push('source_connector = ?');
      params.push(connector);
      continue;
    }
    const granted = access.channels?.[connector] ?? [];
    const readGranted = granted;
    if (readGranted.length === 0) continue;
    clauses.push(`(source_connector = ? AND channel IN (${readGranted.map(() => '?').join(',')}))`);
    params.push(connector, ...readGranted);
  }
  return {
    sql: clauses.length ? clauses.map((clause) => `(${clause})`).join(' OR ') : '0',
    params,
  };
}

function sinceTime(value: unknown, now: number): number {
  if (value === undefined) return now - 24 * 60 * 60 * 1_000;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string') {
    const duration = /^(\d+)\s*(h|d) ago$/i.exec(value.trim());
    if (duration)
      return (
        now - Number(duration[1]) * (duration[2]!.toLowerCase() === 'h' ? 3_600_000 : 86_400_000)
      );
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw invalidInput(
    'source.recent since must be epoch milliseconds, an ISO time, or a duration such as "24h ago"'
  );
}

/** Rows scanned in host memory; each channel reports its full count and its latest lines. */
const RECENT_SCAN_LIMIT = 20_000;

function decodeMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value === '') return {};
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Stored event metadata is malformed');
  return parsed as Record<string, unknown>;
}

function recentAction(ports: ReportReadPorts): ActionRegistration {
  return {
    contract: {
      name: 'source.recent',
      summary:
        'See which channels changed since a time, then read the ones that matter. Without channels it lists every granted channel that changed: channel (the stored value source.search filters on), channelName when the source names it, key, change count and latest line; with channels (keys from that list) it returns their latest perChannel lines with observation refs to open with source.read. since takes epoch milliseconds, an ISO time or a duration such as "24h ago", and defaults to 24 hours. failedConnectors names sources whose last poll failed, so a failure is not read as no change. It reads the stored index, not the live provider; more channels than cap or more than 20,000 changes fails as invalid input, so narrow since.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          since: {
            description:
              'Start time as epoch milliseconds, timezone-aware ISO time, or duration such as "24h ago". Defaults to 24 hours.',
            oneOf: [
              { type: 'integer', minimum: 0 },
              { type: 'string', minLength: 1 },
            ],
          },
          channels: {
            type: 'array',
            minItems: 1,
            maxItems: 10,
            items: { type: 'string', minLength: 1 },
            description:
              'Channel keys (key, not channel) from the list to read lines from, e.g. ["chat:room-a"].',
          },
          perChannel: {
            type: 'integer',
            minimum: 1,
            maximum: 20,
            description: 'Lines per requested channel; defaults to 5.',
          },
          cap: {
            type: 'integer',
            minimum: 1,
            maximum: 500,
            description:
              'Maximum channels returned; each channel reports its full change count and its latest perChannel lines.',
          },
        },
      },
      examples: [
        { title: 'Channels that changed', input: { since: '24h ago' } },
        {
          title: 'Lines of two channels',
          input: { since: '24h ago', channels: ['chat:room-a', 'chat:room-b'] },
        },
      ],
    },
    exec: (input, context) => {
      const values = input as Record<string, unknown>;
      const requested = values.channels === undefined ? null : new Set(values.channels as string[]);
      const chatChannels = [...(requested ?? [])].filter((key) => key.startsWith('chat:'));
      const now = Date.now();
      const since = sinceTime(values.since, now);
      const perChannel = values.perChannel === undefined ? 5 : (values.perChannel as number);
      const cap = values.cap === undefined ? 100 : (values.cap as number);
      if (!Number.isSafeInteger(perChannel) || Number(perChannel) < 1 || Number(perChannel) > 20)
        throw new Error('source.recent perChannel must be from 1 to 20');
      if (!Number.isSafeInteger(cap) || Number(cap) < 1 || Number(cap) > 500)
        throw new Error('source.recent cap must be from 1 to 500');
      const connectors = context.access.connectors ?? [];
      if (connectors.length === 0)
        throw new Error('source.recent requires at least one granted connector');
      const visibility = visibleConnectorFilter(connectors, context.access, ports.ownerPrincipalId);
      const sourceCeiling = context.readAllowance?.maxSourceMs;
      const rows = ports.adapter
        .prepare(
          `SELECT source_connector, source_id, source_entity_id, channel, author, content, source_timestamp_ms,
                current_observation_id, metadata_json
         FROM connector_event_index WHERE (${visibility.sql}) AND source_timestamp_ms >= ?
           AND (source_connector != 'chat' ${chatChannels.length === 0 ? '' : `OR source_connector || ':' || channel IN (${chatChannels.map(() => '?').join(',')})`})
           ${sourceCeiling === undefined || sourceCeiling === null ? '' : 'AND source_timestamp_ms <= ?'}
         ORDER BY source_timestamp_ms DESC, source_id DESC LIMIT ?`
        )
        .all(
          ...visibility.params,
          since,
          ...chatChannels,
          ...(sourceCeiling === undefined || sourceCeiling === null ? [] : [sourceCeiling]),
          RECENT_SCAN_LIMIT + 1
        ) as Row[];
      if (rows.length > RECENT_SCAN_LIMIT)
        throw invalidInput(
          `source.recent found more than ${RECENT_SCAN_LIMIT} changes; narrow since or cap`
        );
      const visible = allowedRows(rows, context.access, ports.ownerPrincipalId);
      const groups = new Map<
        string,
        {
          source: string;
          channel: string;
          channelName?: string;
          key: string;
          count: number;
          latest: Record<string, unknown> | null;
          lines: Array<Record<string, unknown>>;
        }
      >();
      for (const row of visible) {
        const metadata = decodeMetadata(row.metadata_json);
        const source = String(row.source_connector);
        // channel is the stored value that grants and source.search filter on; the display name
        // rides beside it, so a listed channel can be passed to source.search as it is.
        const channelKey = String(row.channel ?? '');
        const channelName =
          typeof metadata.channelName === 'string' && metadata.channelName !== channelKey
            ? metadata.channelName
            : undefined;
        const key = `${source}:${channelKey}`;
        const group = groups.get(key) ?? {
          source,
          channel: channelKey,
          ...(channelName === undefined ? {} : { channelName }),
          key,
          count: 0,
          latest: null,
          lines: [],
        };
        group.count += 1;
        groups.set(key, group);
        // Rows come newest first: the first one is the channel's latest line in the list.
        if (group.latest === null)
          group.latest = {
            author: row.author ?? null,
            time: `${new Date(Number(row.source_timestamp_ms)).toLocaleString('ko-KR', { timeZone: ports.timeZone.get() })} (${ports.timeZone.get()})`,
            text: String(row.content).slice(0, 120),
          };
        if (requested === null || !requested.has(key)) continue;
        if (group.lines.length >= Number(perChannel)) continue;
        const timestamp = Number(row.source_timestamp_ms);
        if (
          typeof row.current_observation_id !== 'string' ||
          row.current_observation_id.trim() === ''
        ) {
          throw new Error('source.recent indexed change has no observation reference');
        }
        group.lines.push({
          author: row.author ?? null,
          time: `${new Date(timestamp).toLocaleString('ko-KR', { timeZone: ports.timeZone.get() })} (${ports.timeZone.get()})`,
          text: String(row.content).slice(0, 200),
          observationRef: row.current_observation_id,
        });
        groups.set(key, group);
      }
      if (requested !== null) {
        const unknown = [...requested].filter((key) => !groups.has(key));
        if (unknown.length > 0)
          throw invalidInput(
            `source.recent channels without changes since then: ${unknown.join(', ')}; list the channels first`
          );
      }
      const failures = ports.adapter
        .prepare(
          `SELECT connector_name, last_error, last_error_at FROM connector_event_index_cursors
         WHERE last_error IS NOT NULL AND connector_name IN (${connectors.map(() => '?').join(',')})`
        )
        .all(...connectors) as Row[];
      const failedConnectors = failures
        .filter((row) => {
          const grant = grantChannels(
            context.access,
            String(row.connector_name),
            ports.ownerPrincipalId
          );
          return grant === null || grant.length > 0;
        })
        .map((row) => {
          const connector = String(row.connector_name);
          const knownChannels = ports.adapter
            .prepare(
              `SELECT source_connector, channel, json_extract(metadata_json, '$.channelName') AS channel_name
               FROM connector_event_index WHERE source_connector = ? GROUP BY source_connector, channel`
            )
            .all(connector) as Row[];
          const failedChannels = [
            ...new Map(
              allowedRows(knownChannels, context.access, ports.ownerPrincipalId)
                .filter((event) => event.source_connector === connector)
                .map((event) => {
                  const key = String(event.channel ?? '');
                  return [
                    key,
                    typeof event.channel_name === 'string' ? event.channel_name : key,
                  ] as const;
                })
            ).values(),
          ];
          return {
            connector,
            channels: failedChannels,
            error: row.last_error,
            failedAt: row.last_error_at,
          };
        });
      // The cap bounds the channel list; a read of named channels returns only those.
      if (requested === null && groups.size > Number(cap))
        throw invalidInput(
          `source.recent found changes in ${groups.size} channels, more than cap ${cap}; narrow since or cap`
        );
      const sorted = [...groups.values()].sort(
        (a, b) =>
          a.source.localeCompare(b.source) ||
          (a.channelName ?? a.channel).localeCompare(b.channelName ?? b.channel)
      );
      return {
        since: new Date(since).toISOString(),
        cap: Number(cap),
        scanned: visible.length,
        channels:
          requested === null
            ? sorted.map(({ source, channel, channelName, key, count, latest }) => ({
                source,
                channel,
                ...(channelName === undefined ? {} : { channelName }),
                key,
                count,
                latest,
              }))
            : sorted
                .filter((group) => requested.has(group.key))
                .map(({ source, channel, channelName, key, count, lines }) => ({
                  source,
                  channel,
                  ...(channelName === undefined ? {} : { channelName }),
                  key,
                  count,
                  lines,
                })),
        failedConnectors,
      };
    },
  };
}

function upcomingAction(ports: ReportReadPorts): ActionRegistration {
  return {
    contract: {
      name: 'schedule.upcoming',
      summary:
        "Read upcoming calendar and iCal events from the stored event index, including configured holiday calendars. days sets the window (default 14, at most 90); cancelled and ended events are left out; an all-day event stays upcoming until its exclusive end (the day after its start when it has no end) in the event's timezone or the owner's. Events come sorted by start time with source, calendar, title, an observation ref, and start and end as written in the source. More events than cap (default 250) is an error; narrow days.",
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          days: {
            type: 'integer',
            minimum: 0,
            maximum: 90,
            description: 'Days ahead, default 14.',
          },
          cap: {
            type: 'integer',
            minimum: 1,
            maximum: 500,
            description: 'Event cap; exceeding it fails instead of truncating.',
          },
        },
      },
      examples: [{ title: 'Next two weeks', input: { days: 14 } }],
    },
    exec: (input, context) => {
      const values = input as Record<string, unknown>;
      const days = values.days === undefined ? 14 : (values.days as number);
      const cap = values.cap === undefined ? 250 : (values.cap as number);
      if (!Number.isSafeInteger(days) || Number(days) < 0 || Number(days) > 90)
        throw new Error('schedule.upcoming days must be from 0 to 90');
      if (!Number.isSafeInteger(cap) || Number(cap) < 1 || Number(cap) > 500)
        throw new Error('schedule.upcoming cap must be from 1 to 500');
      const connectors = ['calendar', 'ical'].filter((name) =>
        context.access.connectors?.includes(name)
      );
      if (!connectors.length)
        throw new Error('schedule.upcoming requires a granted calendar or ical connector');
      const visibility = visibleConnectorFilter(connectors, context.access, ports.ownerPrincipalId);
      const raw = ports.adapter
        .prepare(
          `SELECT source_connector, source_id, source_entity_id, channel, source_timestamp_ms,
                metadata_json, current_observation_id
         FROM (SELECT e.*, ROW_NUMBER() OVER (
           PARTITION BY source_connector, COALESCE(source_entity_id, source_id)
           ORDER BY source_timestamp_ms DESC, indexed_at DESC, source_id DESC
         ) AS revision_order FROM connector_event_index e
         WHERE (${visibility.sql}))
         WHERE revision_order=1 ORDER BY source_timestamp_ms DESC`
        )
        .all(...visibility.params) as Row[];
      const visible = allowedRows(raw, context.access, ports.ownerPrincipalId);
      const now = Date.now();
      const until = now + Number(days) * 86_400_000;
      const events = visible.flatMap((row) => {
        const metadata = decodeMetadata(row.metadata_json);
        if (metadata.status === 'cancelled') return [];
        const startRaw = metadata.start ?? metadata.dtstart;
        const endRaw = metadata.end ?? metadata.dtend;
        if (typeof startRaw !== 'string') return [];
        const ownerTimeZone = ports.timeZone.get();
        const eventZone =
          typeof metadata.timeZone === 'string'
            ? metadata.timeZone
            : typeof metadata.startTimeZone === 'string'
              ? metadata.startTimeZone
              : undefined;
        const start = epochForCalendarValue(startRaw, eventZone, ownerTimeZone);
        let end: number;
        if (typeof endRaw === 'string') {
          end = epochForCalendarValue(
            endRaw,
            typeof metadata.endTimeZone === 'string' ? metadata.endTimeZone : eventZone,
            ownerTimeZone
          );
        } else if (typeof metadata.duration === 'string') {
          end = durationEndEpoch(startRaw, metadata.duration, eventZone ?? ownerTimeZone);
        } else {
          end = start + (metadata.allDay === true ? 86_400_000 : 0);
        }
        const hasEnded = metadata.endExclusive === true ? end <= now : end < now;
        if (!Number.isFinite(start) || !Number.isFinite(end) || hasEnded || start > until)
          return [];
        return [
          {
            source: row.source_connector,
            calendar: metadata.calendarName ?? metadata.feedName ?? row.channel,
            start: startRaw,
            end: typeof endRaw === 'string' ? endRaw : startRaw,
            ...(typeof metadata.duration === 'string' ? { duration: metadata.duration } : {}),
            title: metadata.summary ?? '(Untitled event)',
            observationRef: row.current_observation_id,
            sortMs: start,
          },
        ];
      });
      if (events.length > Number(cap))
        throw new Error(
          `schedule.upcoming found more than ${cap} events; narrow days or increase cap`
        );
      events.sort((a, b) => a.sortMs - b.sortMs);
      return {
        days: Number(days),
        cap: Number(cap),
        returned: events.length,
        events: events.map(({ sortMs: _sortMs, ...event }) => event),
      };
    },
  };
}

export function reportSourceActionRegistrations(ports: ReportReadPorts): ActionRegistration[] {
  return [recentAction(ports), upcomingAction(ports)];
}
