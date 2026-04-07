import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CalendarConnector } from '../../src/connectors/calendar/index.js';
import type { ConnectorConfig } from '../../src/connectors/framework/types.js';

// Mock child_process
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'child_process';
const mockExecSync = vi.mocked(execSync);

function makeConfig(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    enabled: true,
    pollIntervalMinutes: 15,
    channels: {},
    auth: {
      type: 'cli',
      cli: 'gws',
      cliAuthCommand: 'gws auth login',
    },
    ...overrides,
  };
}

function makeEventListJson(events: Record<string, unknown>[]): string {
  return JSON.stringify({ items: events });
}

function makeEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'evt001',
    summary: 'Team Standup',
    description: 'Daily standup meeting',
    start: { dateTime: '2024-01-15T09:00:00+09:00' },
    end: { dateTime: '2024-01-15T09:30:00+09:00' },
    organizer: { email: 'organizer@example.com', displayName: 'Organizer Name' },
    status: 'confirmed',
    ...overrides,
  };
}

describe('CalendarConnector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecSync.mockReturnValue('' as unknown as ReturnType<typeof execSync>);
  });

  describe('name and type', () => {
    it('has name "calendar"', () => {
      const connector = new CalendarConnector(makeConfig());
      expect(connector.name).toBe('calendar');
    });

    it('has type "api"', () => {
      const connector = new CalendarConnector(makeConfig());
      expect(connector.type).toBe('api');
    });
  });

  describe('getAuthRequirements', () => {
    it('returns cli auth requirement for gws', () => {
      const connector = new CalendarConnector(makeConfig());
      const reqs = connector.getAuthRequirements();
      expect(reqs).toHaveLength(1);
      expect(reqs[0]?.type).toBe('cli');
      expect(reqs[0]?.cli).toBe('gws');
      expect(reqs[0]?.cliAuthCommand).toBe('gws auth login');
    });
  });

  describe('init', () => {
    it('initializes when gws CLI is available', async () => {
      mockExecSync.mockReturnValue('gws version 1.0.0' as unknown as ReturnType<typeof execSync>);
      const connector = new CalendarConnector(makeConfig());
      await expect(connector.init()).resolves.toBeUndefined();
    });

    it('throws when gws CLI is not found', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('command not found: gws');
      });
      const connector = new CalendarConnector(makeConfig());
      await expect(connector.init()).rejects.toThrow(/gws/i);
    });
  });

  describe('authenticate', () => {
    it('returns true when gws auth status succeeds', async () => {
      mockExecSync.mockReturnValue('' as unknown as ReturnType<typeof execSync>);
      const connector = new CalendarConnector(makeConfig());
      await connector.init();
      expect(await connector.authenticate()).toBe(true);
    });

    it('returns false when gws auth status throws', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockImplementationOnce(() => {
          throw new Error('not authenticated');
        });
      const connector = new CalendarConnector(makeConfig());
      await connector.init();
      expect(await connector.authenticate()).toBe(false);
    });
  });

  describe('poll', () => {
    it('returns empty array when no events', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(makeEventListJson([]) as unknown as ReturnType<typeof execSync>);
      const connector = new CalendarConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toEqual([]);
    });

    it('returns normalized event items', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          makeEventListJson([makeEvent()]) as unknown as ReturnType<typeof execSync>
        );
      const connector = new CalendarConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toHaveLength(1);
      expect(items[0]?.source).toBe('calendar');
      expect(items[0]?.type).toBe('event');
    });

    it('sets sourceId to event.id', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          makeEventListJson([makeEvent({ id: 'unique-evt-id' })]) as unknown as ReturnType<
            typeof execSync
          >
        );
      const connector = new CalendarConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.sourceId).toBe('unique-evt-id');
    });

    it('formats content as "summary | start ~ end\\ndescription"', async () => {
      const event = makeEvent({
        summary: 'Team Meeting',
        description: 'Weekly sync',
        start: { dateTime: '2024-01-15T10:00:00Z' },
        end: { dateTime: '2024-01-15T11:00:00Z' },
      });
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(makeEventListJson([event]) as unknown as ReturnType<typeof execSync>);
      const connector = new CalendarConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.content).toBe(
        'Team Meeting | 2024-01-15T10:00:00Z ~ 2024-01-15T11:00:00Z\nWeekly sync'
      );
    });

    it('uses organizer displayName as author', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          makeEventListJson([
            makeEvent({
              organizer: { email: 'org@example.com', displayName: 'Jane Doe' },
            }),
          ]) as unknown as ReturnType<typeof execSync>
        );
      const connector = new CalendarConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.author).toBe('Jane Doe');
    });

    it('falls back to organizer email when displayName is absent', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          makeEventListJson([
            makeEvent({
              organizer: { email: 'org@example.com' },
            }),
          ]) as unknown as ReturnType<typeof execSync>
        );
      const connector = new CalendarConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.author).toBe('org@example.com');
    });

    it('uses date (all-day) when dateTime is absent', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          makeEventListJson([
            makeEvent({
              start: { date: '2024-01-15' },
              end: { date: '2024-01-16' },
            }),
          ]) as unknown as ReturnType<typeof execSync>
        );
      const connector = new CalendarConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.content).toContain('2024-01-15');
      expect(items[0]?.content).toContain('2024-01-16');
    });

    it('handles empty description gracefully', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          makeEventListJson([makeEvent({ description: undefined })]) as unknown as ReturnType<
            typeof execSync
          >
        );
      const connector = new CalendarConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.content).toMatch(/Team Standup \|/);
      expect(items[0]?.content).toMatch(/\n$/);
    });

    it('passes timeMin as ISO string to gws CLI', async () => {
      const since = new Date('2024-01-10T00:00:00.000Z');
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(makeEventListJson([]) as unknown as ReturnType<typeof execSync>);
      const connector = new CalendarConnector(makeConfig());
      await connector.init();
      await connector.poll(since);

      const calls = mockExecSync.mock.calls;
      const listCall = calls.find((c: unknown[]) => String(c[0]).includes('calendar events list'));
      expect(listCall).toBeDefined();
      expect(String(listCall?.[0])).toContain('2024-01-10T00:00:00.000Z');
    });

    it('passes singleEvents=true and orderBy=startTime', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(makeEventListJson([]) as unknown as ReturnType<typeof execSync>);
      const connector = new CalendarConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0));

      const calls = mockExecSync.mock.calls;
      const listCall = calls.find((c: unknown[]) => String(c[0]).includes('calendar events list'));
      const cmd = String(listCall?.[0]);
      expect(cmd).toContain('"singleEvents":true');
      expect(cmd).toContain('"orderBy":"startTime"');
    });

    it('handles prefix lines like "Using keyring backend: ..." before JSON', async () => {
      const prefixed = 'Using keyring backend: SecretService\n' + makeEventListJson([makeEvent()]);
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(prefixed as unknown as ReturnType<typeof execSync>);
      const connector = new CalendarConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toHaveLength(1);
    });

    it('sets channel to "calendar"', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          makeEventListJson([makeEvent()]) as unknown as ReturnType<typeof execSync>
        );
      const connector = new CalendarConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.channel).toBe('calendar');
    });

    it('includes metadata with start, end, status, organizer', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          makeEventListJson([makeEvent()]) as unknown as ReturnType<typeof execSync>
        );
      const connector = new CalendarConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.metadata).toHaveProperty('status', 'confirmed');
      expect(items[0]?.metadata).toHaveProperty('start');
      expect(items[0]?.metadata).toHaveProperty('end');
    });
  });

  describe('healthCheck', () => {
    it('reflects lastPollTime and lastPollCount after poll', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(
          makeEventListJson([makeEvent()]) as unknown as ReturnType<typeof execSync>
        );
      const connector = new CalendarConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0));
      const health = await connector.healthCheck();
      expect(health.lastPollTime).not.toBeNull();
      expect(health.lastPollCount).toBe(1);
    });

    it('is healthy when no errors occurred', async () => {
      mockExecSync
        .mockReturnValueOnce('' as unknown as ReturnType<typeof execSync>)
        .mockReturnValueOnce(makeEventListJson([]) as unknown as ReturnType<typeof execSync>);
      const connector = new CalendarConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0));
      const health = await connector.healthCheck();
      expect(health.healthy).toBe(true);
    });
  });

  describe('dispose', () => {
    it('resolves without error', async () => {
      const connector = new CalendarConnector(makeConfig());
      await expect(connector.dispose()).resolves.toBeUndefined();
    });
  });
});
