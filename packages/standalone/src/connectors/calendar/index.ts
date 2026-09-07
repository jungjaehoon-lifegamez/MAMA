/**
 * CalendarConnector — polls Google Calendar via the gws CLI tool.
 * Uses child_process.execSync to call gws CLI commands.
 * Skips "Using keyring backend:" prefix lines before parsing JSON.
 */

import { execSync } from 'child_process';
import { createHash } from 'node:crypto';

import type {
  AuthRequirement,
  ConnectorConfig,
  ConnectorHealth,
  IConnector,
  NormalizedItem,
} from '../framework/types.js';
import { execGws } from '../framework/gws-utils.js';

interface CalendarEvent {
  id: string;
  summary?: string;
  description?: string;
  start?: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  end?: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  organizer?: {
    email?: string;
    displayName?: string;
  };
  status?: string;
}

interface CalendarEventList {
  items?: CalendarEvent[];
  nextPageToken?: string;
  timeZone?: string;
}

const MAX_EVENT_LIST_PAGES = 20;

export class CalendarConnector implements IConnector {
  readonly name = 'calendar';
  readonly type = 'api' as const;

  private lastPollTime: Date | null = null;
  private lastPollCount = 0;
  private lastError: string | undefined = undefined;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_config: ConnectorConfig) {
    // config reserved for future channel-scoped filtering
  }

  async init(): Promise<void> {
    // Verify gws CLI is available
    try {
      execSync('gws --version', { stdio: 'pipe' });
    } catch {
      throw new Error('gws CLI not found. Install it and run: gws auth login');
    }
  }

  async dispose(): Promise<void> {
    // No resources to clean up
  }

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
        type: 'cli',
        cli: 'gws',
        cliAuthCommand: 'gws auth login',
        description: 'Google Workspace CLI authentication. Run: gws auth login',
      },
    ];
  }

  async authenticate(): Promise<boolean> {
    try {
      execSync('gws auth status', { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  private getEventTime(ev: CalendarEvent): string {
    return ev.start?.dateTime ?? ev.start?.date ?? '';
  }

  private getEventEndTime(ev: CalendarEvent): string {
    return ev.end?.dateTime ?? ev.end?.date ?? '';
  }

  async poll(since: Date): Promise<NormalizedItem[]> {
    const items: NormalizedItem[] = [];

    try {
      const timeMin = since.toISOString();
      const observedAt = new Date().toISOString();
      let pageToken: string | undefined;
      const visitedPageTokens = new Set<string>();
      for (let page = 0; page < MAX_EVENT_LIST_PAGES; page += 1) {
        const params = JSON.stringify({
          calendarId: 'primary',
          timeMin,
          singleEvents: true,
          showDeleted: true,
          orderBy: 'startTime',
          maxResults: 50,
          ...(pageToken ? { pageToken } : {}),
        });
        // Escape single quotes so an upstream-controlled value inside the JSON (e.g. a pageToken)
        // cannot close the shell single-quoted argument and inject a command.
        const safeParams = params.replace(/'/g, `'\\''`);
        const result = execGws(
          `calendar events list --params '${safeParams}'`
        ) as CalendarEventList;

        for (const ev of result.items ?? []) {
          const start = this.getEventTime(ev);
          const end = this.getEventEndTime(ev);
          const summary = ev.summary ?? '(No title)';
          const description = ev.description ?? '';
          const organizer = ev.organizer?.displayName ?? ev.organizer?.email ?? 'unknown';
          const allDay = ev.start?.date !== undefined;
          const startMs = start ? new Date(start).getTime() : Date.now();
          const timeZone = ev.start?.timeZone ?? result.timeZone ?? 'UTC';
          const observation = {
            eventId: ev.id,
            summary,
            description,
            start,
            end,
            status: ev.status,
            organizer: ev.organizer,
            allDay,
            endExclusive: allDay,
            timeZone,
          };
          const version = createHash('sha256')
            .update(JSON.stringify(observation))
            .digest('hex')
            .slice(0, 24);

          items.push({
            source: 'calendar',
            sourceId: `${ev.id}:${version}`,
            sourceEntityId: ev.id,
            channel: 'calendar',
            author: organizer,
            content: `${summary} | ${start} ~ ${end}\n${description}`,
            timestamp: new Date(startMs),
            type: 'event',
            sourceCursor: observedAt,
            metadata: {
              ...observation,
              observedAt,
            },
          });
        }

        if (!result.nextPageToken) {
          this.lastPollTime = new Date();
          this.lastPollCount = items.length;
          this.lastError = undefined;
          return items;
        }
        if (visitedPageTokens.has(result.nextPageToken)) {
          throw new Error('Calendar returned a repeated upstream page token');
        }
        visitedPageTokens.add(result.nextPageToken);
        pageToken = result.nextPageToken;
      }
      throw new Error(
        `Calendar page cap (${MAX_EVENT_LIST_PAGES}) reached; upstream snapshot is incomplete`
      );
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.lastPollTime = new Date();
      this.lastPollCount = 0;
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
}
