/** Google Calendar snapshots through the authorised gws CLI on the daemon's PATH. */
import { createHash } from 'node:crypto';
import type {
  AuthRequirement,
  ConnectorConfig,
  ConnectorHealth,
  IConnector,
  NormalizedItem,
  ConnectorPollCursor,
} from '../framework/types.js';
import { cliAuth } from '../framework/types.js';
import { execGwsAsync, gwsLogin, gwsMissing, gwsTool } from '../framework/gws-utils.js';
import { readConnectorState, writeConnectorState } from '../framework/connector-state.js';

interface CalendarEvent {
  id: string;
  updated: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  organizer?: { email?: string; displayName?: string };
  status?: string;
}

interface CalendarEventList {
  items?: CalendarEvent[];
  nextPageToken?: string;
  timeZone?: string;
}

const MAX_EVENT_LIST_PAGES = 20;
// f3f0316c7: unbounded singleEvents expansion repeatedly hit the cap and saved nothing.
const EVENT_LIST_HORIZON_MS = 90 * 24 * 60 * 60 * 1000;
const EVENT_LIST_PAGE_SIZE = 250;

/** Free text reaches search and delta previews. Structured event times are kept separately. */
function previewText(value: string): string {
  return value
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email]')
    .replace(/\+?\(?\d[\d ().-]{5,}\d/g, (candidate) => {
      if (/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return candidate;
      return candidate.replace(/\D/g, '').length >= 7 ? '[phone]' : candidate;
    });
}

export class CalendarConnector implements IConnector {
  readonly name = 'calendar';
  readonly type = 'api' as const;
  private lastPollTime: Date | null = null;
  private lastPollCount = 0;
  private lastError: string | undefined;

  // The primary calendar uses the existing configured channel key "calendar".
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private readonly calendars: Array<{ key: string; id: string; label: string }>;
  /** Calendars whose whole window has been collected once; later polls only ask for changes. */
  private readonly synced: Set<string>;
  private pendingSynced: Set<string> | null = null;

  constructor(
    config: ConnectorConfig,
    private readonly statePath: string
  ) {
    const configured = Object.entries(config.channels).filter(
      ([key, channel]) =>
        channel.role !== 'ignore' && (channel.calendarId || key === 'calendar' || key === 'primary')
    );
    this.calendars = configured.some(([, channel]) => channel.calendarId)
      ? configured.map(([key, channel]) => ({
          key,
          id: channel.calendarId ?? 'primary',
          label: channel.name ?? key,
        }))
      : [{ key: 'calendar', id: 'primary', label: 'Primary calendar' }];
    this.synced = new Set(
      readConnectorState(statePath, (value) => {
        const synced = (value as { synced?: unknown } | null)?.synced;
        if (!Array.isArray(synced) || !synced.every((key) => typeof key === 'string')) {
          throw new Error('Calendar connector state must list synced calendar keys');
        }
        return synced as string[];
      }) ?? []
    );
  }

  commitPoll(): void {
    if (this.pendingSynced === null) return;
    for (const key of this.pendingSynced) this.synced.add(key);
    this.pendingSynced = null;
    writeConnectorState(this.statePath, { synced: [...this.synced].sort() });
  }

  abortPollHandoff(): void {
    this.pendingSynced = null;
  }

  private async verifyAccess(): Promise<void> {
    // auth status can succeed without Calendar scope. Exercise the read permission itself.
    await execGwsAsync([
      'calendar',
      'events',
      'list',
      '--params',
      JSON.stringify({ calendarId: this.calendars[0]?.id ?? 'primary', maxResults: 1 }),
    ]);
  }

  async init(): Promise<void> {
    try {
      await this.verifyAccess();
      this.lastError = undefined;
    } catch (error) {
      this.lastError =
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? `Calendar: ${gwsMissing}`
          : `Calendar: ${gwsTool.command} cannot read the primary calendar. Sign in with Google Calendar read access (${gwsLogin}), then retry.`;
      throw new Error(this.lastError, { cause: error });
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

  getAuthRequirements(): AuthRequirement[] {
    return [
      {
        ...cliAuth(gwsTool),
        description:
          'Google Calendar read access through Google Workspace CLI. Run: gws auth login',
      },
    ];
  }

  async authenticate(): Promise<boolean> {
    try {
      await this.verifyAccess();
      return true;
    } catch {
      return false;
    }
  }

  async poll(since: Date, cursor?: ConnectorPollCursor): Promise<NormalizedItem[]> {
    const items: NormalizedItem[] = [];
    try {
      const windowStart = new Date();
      const timeMin = windowStart.toISOString();
      const timeMax = new Date(windowStart.getTime() + EVENT_LIST_HORIZON_MS).toISOString();
      const observedAt = new Date().toISOString();
      const pendingSynced = new Set<string>();
      for (const calendar of this.calendars) {
        // A calendar added after the first poll still needs its whole window once.
        const changesOnly = cursor?.hasCursor === true && this.synced.has(calendar.key);
        let pageToken: string | undefined;
        let pageComplete = false;
        const visitedPageTokens = new Set<string>();
        for (let page = 0; page < MAX_EVENT_LIST_PAGES; page += 1) {
          const result = (await execGwsAsync([
            'calendar',
            'events',
            'list',
            '--params',
            JSON.stringify({
              calendarId: calendar.id,
              timeMin,
              timeMax,
              ...(changesOnly ? { updatedMin: since.toISOString() } : {}),
              singleEvents: true,
              showDeleted: true,
              orderBy: 'startTime',
              maxResults: EVENT_LIST_PAGE_SIZE,
              ...(pageToken ? { pageToken } : {}),
            }),
          ])) as CalendarEventList;

          for (const ev of result.items ?? []) {
            const updatedAt = new Date(ev.updated);
            if (!Number.isFinite(updatedAt.getTime())) {
              throw new Error('Calendar event omitted a valid updated time');
            }
            const start = ev.start?.dateTime ?? ev.start?.date ?? '';
            const end = ev.end?.dateTime ?? ev.end?.date ?? '';
            const summary = ev.summary ?? '(No title)';
            const description = ev.description ?? '';
            const organizer = ev.organizer?.displayName ?? ev.organizer?.email ?? 'unknown';
            const allDay = ev.start?.date !== undefined;
            // Cancelled events can carry only an id; retain that cancellation observation.
            const observation = {
              eventId: ev.id,
              calendarId: calendar.id,
              calendarName: calendar.label,
              updated: ev.updated,
              summary,
              description,
              location: ev.location,
              start,
              end,
              status: ev.status,
              organizer: ev.organizer,
              allDay,
              endExclusive: allDay,
              timeZone: ev.start?.timeZone ?? result.timeZone ?? 'UTC',
            };
            const version = createHash('sha256')
              .update(JSON.stringify(observation))
              .digest('hex')
              .slice(0, 24);
            items.push({
              source: 'calendar',
              sourceId: `${calendar.key === 'calendar' ? '' : `${calendar.key}:`}${ev.id}:${version}`,
              sourceEntityId: `${calendar.key === 'calendar' ? '' : `${calendar.key}:`}${ev.id}`,
              channel: calendar.key,
              author: previewText(organizer),
              content: [
                `${previewText(summary)} | ${start} ~ ${end}`,
                `Organizer: ${previewText(organizer)}`,
                ...(ev.location ? [`Location: ${previewText(ev.location)}`] : []),
                previewText(description),
              ].join('\n'),
              timestamp: updatedAt,
              type: 'event',
              sourceCursor: ev.updated,
              metadata: { ...observation, observedAt },
              ...(!this.synced.has(calendar.key) ? { collectOnly: true } : {}),
            });
          }

          if (!result.nextPageToken) {
            pageComplete = true;
            break;
          }
          if (visitedPageTokens.has(result.nextPageToken)) {
            throw new Error('Calendar returned a repeated upstream page token');
          }
          visitedPageTokens.add(result.nextPageToken);
          pageToken = result.nextPageToken;
        }
        if (!pageComplete)
          throw new Error(
            `Calendar page cap (${MAX_EVENT_LIST_PAGES}) reached; upstream snapshot is incomplete`
          );
        pendingSynced.add(calendar.key);
      }
      this.pendingSynced = pendingSynced;
      this.lastPollTime = new Date();
      this.lastPollCount = items.length;
      this.lastError = undefined;
      return items;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.lastPollTime = new Date();
      this.lastPollCount = 0;
      throw error instanceof Error ? error : new Error(String(error));
    }
  }
}
