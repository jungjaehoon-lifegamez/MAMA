/**
 * CalendarConnector — polls Google Calendar via the gws CLI tool.
 * Uses child_process.execSync to call gws CLI commands.
 * Skips "Using keyring backend:" prefix lines before parsing JSON.
 */

import { execSync } from 'child_process';

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
  };
  end?: {
    dateTime?: string;
    date?: string;
  };
  organizer?: {
    email?: string;
    displayName?: string;
  };
  status?: string;
}

interface CalendarEventList {
  items?: CalendarEvent[];
}

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
    let hadError = false;

    try {
      const timeMin = since.toISOString();
      const params = JSON.stringify({
        calendarId: 'primary',
        timeMin,
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 50,
      });
      const result = execGws(`calendar events list --params '${params}'`) as CalendarEventList;

      const events = result.items ?? [];

      for (const ev of events) {
        const start = this.getEventTime(ev);
        const end = this.getEventEndTime(ev);
        const summary = ev.summary ?? '(No title)';
        const description = ev.description ?? '';
        const organizer = ev.organizer?.displayName ?? ev.organizer?.email ?? 'unknown';

        // Determine timestamp from start time
        const startMs = start ? new Date(start).getTime() : Date.now();
        const timestamp = new Date(startMs);

        items.push({
          source: 'calendar',
          sourceId: ev.id,
          channel: 'calendar',
          author: organizer,
          content: `${summary} | ${start} ~ ${end}\n${description}`,
          timestamp,
          type: 'event',
          metadata: {
            summary,
            start,
            end,
            status: ev.status,
            organizer: ev.organizer,
          },
        });
      }
    } catch (err) {
      hadError = true;
      this.lastError = err instanceof Error ? err.message : String(err);
    }

    this.lastPollTime = new Date();
    this.lastPollCount = items.length;
    // lastError was set in catch blocks; clear only if no error occurred this pass
    if (!hadError) this.lastError = undefined;

    return items;
  }
}
