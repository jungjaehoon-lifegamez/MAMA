import { createHash, randomUUID } from 'node:crypto';
import type {
  ConnectorConfig,
  ConnectorHealth,
  IConnector,
  NormalizedItem,
} from '../framework/types.js';
import { readConnectorState, writeConnectorState } from '../framework/connector-state.js';
import { parseICalendar } from './parser.js';
import type { TimeZoneSetting } from '../../runtime/timezone.js';
import {
  calendarValueKind,
  durationEndEpoch,
  epochForCalendarValue,
} from '../../runtime/timezone.js';

interface ICalEntityState {
  version: string;
  // Absent on legacy states: keep their existing address until the version changes.
  observationId?: string;
  firstSeenAt: number;
  start: string;
  startTimeZone?: string;
  end?: string;
  endTimeZone?: string;
  duration?: string;
  summary: string;
  status: string;
  feedKey: string;
  feedName: string;
}

export class ICalConnector implements IConnector {
  readonly name = 'ical';
  readonly type = 'api' as const;
  private readonly feeds: Array<{ key: string; name: string; envName: string }>;
  private lastPollTime: Date | null = null;
  private lastPollCount = 0;
  private lastError: string | undefined;
  private readonly synced: Set<string>;
  private readonly entities: Record<string, ICalEntityState>;
  private pendingSynced: Set<string> | null = null;

  constructor(
    config: ConnectorConfig,
    private readonly statePath: string,
    private readonly timeZone: TimeZoneSetting
  ) {
    this.feeds = Object.entries(config.channels).map(([key, channel]) => ({
      key,
      name: channel.feedName ?? channel.name ?? key,
      envName: `MAMA_ICAL_URL_${key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`,
    }));
    const state = readConnectorState(statePath, (value) => {
      const record = value as { synced?: unknown; entities?: unknown } | null;
      const synced = record?.synced;
      if (!Array.isArray(synced) || !synced.every((key) => typeof key === 'string')) {
        throw new Error('iCal connector state must list synced feed keys');
      }
      const entities = record?.entities ?? {};
      if (entities === null || typeof entities !== 'object' || Array.isArray(entities)) {
        throw new Error('iCal connector state entities must be a record');
      }
      return { synced: synced as string[], entities: entities as Record<string, ICalEntityState> };
    }) ?? { synced: [], entities: {} };
    this.synced = new Set(state.synced);
    this.entities = state.entities;
  }
  commitPoll(): void {
    if (this.pendingSynced === null) return;
    for (const key of this.pendingSynced) this.synced.add(key);
    this.pendingSynced = null;
    writeConnectorState(this.statePath, {
      synced: [...this.synced].sort(),
      entities: this.entities,
    });
  }
  abortPollHandoff(): void {
    this.pendingSynced = null;
  }
  async init(): Promise<void> {
    for (const feed of this.feeds) {
      if (!process.env[feed.envName])
        throw new Error(`iCal feed ${feed.name} has no ${feed.envName} secret`);
    }
  }
  async dispose(): Promise<void> {}
  async healthCheck(): Promise<ConnectorHealth> {
    return {
      healthy: this.lastError === undefined,
      lastPollTime: this.lastPollTime,
      lastPollCount: this.lastPollCount,
      error: this.lastError,
    };
  }
  getAuthRequirements() {
    return this.feeds.map((feed) => ({
      type: 'token' as const,
      tokenName: feed.envName,
      description: `Secret URL for iCal feed ${feed.name}`,
    }));
  }
  async authenticate(): Promise<boolean> {
    return this.feeds.every((feed) => Boolean(process.env[feed.envName]));
  }
  async poll(_since: Date): Promise<NormalizedItem[]> {
    const output: NormalizedItem[] = [];
    try {
      const pendingSynced = new Set<string>();
      for (const feed of this.feeds) {
        const url = process.env[feed.envName];
        if (!url) throw new Error(`iCal feed ${feed.name} has no configured secret`);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20_000);
        let response: Response;
        try {
          response = await fetch(url, { signal: controller.signal });
        } catch {
          clearTimeout(timeout);
          throw new Error(`iCal feed ${feed.name} fetch failed`);
        }
        if (!response.ok) {
          clearTimeout(timeout);
          throw new Error(`iCal feed ${feed.name} fetch failed with HTTP ${response.status}`);
        }
        let body: string;
        try {
          body = await response.text();
        } catch {
          clearTimeout(timeout);
          throw new Error(`iCal feed ${feed.name} response could not be read`);
        }
        clearTimeout(timeout);
        let events;
        try {
          events = parseICalendar(body);
        } catch {
          throw new Error(`iCal feed ${feed.name} parse failed: invalid calendar data`);
        }
        const seen = new Set<string>();
        const emit = (event: (typeof events)[number]) => {
          const fields = { ...event, feedName: feed.name, feedKey: feed.key };
          const version = createHash('sha256')
            .update(JSON.stringify(fields))
            .digest('hex')
            .slice(0, 24);
          const entityKey = `${feed.key}:${event.uid}`;
          const previous = this.entities[entityKey];
          const firstSeenAt = previous?.version === version ? previous.firstSeenAt : Date.now();
          const observationId =
            event.revisionTime === undefined
              ? previous?.version === version
                ? previous.observationId
                : randomUUID()
              : undefined;
          this.entities[entityKey] = {
            version,
            ...(observationId === undefined ? {} : { observationId }),
            firstSeenAt,
            start: event.start,
            end: event.end,
            ...(event.startTimeZone ? { startTimeZone: event.startTimeZone } : {}),
            ...(event.end === undefined ? {} : { end: event.end }),
            ...(event.endTimeZone ? { endTimeZone: event.endTimeZone } : {}),
            ...(event.duration === undefined ? {} : { duration: event.duration }),
            summary: event.summary,
            status: event.status,
            feedKey: feed.key,
            feedName: feed.name,
          };
          output.push({
            source: 'ical',
            sourceId: `${entityKey}:${version}${observationId === undefined ? '' : `:${observationId}`}`,
            sourceEntityId: entityKey,
            channel: feed.key,
            author: 'unknown',
            content: `${event.summary} | ${event.start} ~ ${event.end ?? event.duration ?? event.start}`,
            timestamp: new Date(event.revisionTime ?? firstSeenAt),
            type: 'event',
            sourceCursor: version,
            metadata: {
              start: event.start,
              ...(event.end === undefined ? {} : { end: event.end }),
              ...(event.startTimeZone ? { startTimeZone: event.startTimeZone } : {}),
              ...(event.endTimeZone ? { endTimeZone: event.endTimeZone } : {}),
              ...(event.duration === undefined ? {} : { duration: event.duration }),
              ...(calendarValueKind(event.start) === 'date' &&
              (event.end === undefined || calendarValueKind(event.end) === 'date')
                ? { allDay: true, endExclusive: true }
                : {}),
              summary: event.summary,
              status: event.status,
              feedName: feed.name,
              feedKey: feed.key,
            },
            ...(!this.synced.has(feed.key) ? { collectOnly: true } : {}),
          });
        };
        for (const event of events) {
          seen.add(`${feed.key}:${event.uid}`);
          emit(event);
        }
        for (const [entityKey, previous] of Object.entries(this.entities)) {
          if (previous.feedKey !== feed.key || seen.has(entityKey)) continue;
          const previousEnd = previous.end
            ? epochForCalendarValue(
                previous.end,
                previous.endTimeZone ?? previous.startTimeZone,
                this.timeZone.get()
              )
            : previous.duration
              ? durationEndEpoch(
                  previous.start,
                  previous.duration,
                  previous.startTimeZone ?? this.timeZone.get()
                )
              : epochForCalendarValue(previous.start, previous.startTimeZone, this.timeZone.get());
          if (previousEnd <= Date.now()) {
            delete this.entities[entityKey];
            continue;
          }
          emit({
            uid: entityKey.slice(feed.key.length + 1),
            start: previous.start,
            end: previous.end,
            ...(previous.startTimeZone ? { startTimeZone: previous.startTimeZone } : {}),
            ...(previous.endTimeZone ? { endTimeZone: previous.endTimeZone } : {}),
            ...(previous.duration ? { duration: previous.duration } : {}),
            summary: previous.summary,
            status: 'cancelled',
          });
        }
        pendingSynced.add(feed.key);
      }
      writeConnectorState(this.statePath, {
        synced: [...this.synced].sort(),
        entities: this.entities,
      });
      this.pendingSynced = pendingSynced;
      this.lastPollTime = new Date();
      this.lastPollCount = output.length;
      this.lastError = undefined;
      return output;
    } catch (error) {
      this.lastPollTime = new Date();
      this.lastPollCount = 0;
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error instanceof Error ? error : new Error(String(error));
    }
  }
}
