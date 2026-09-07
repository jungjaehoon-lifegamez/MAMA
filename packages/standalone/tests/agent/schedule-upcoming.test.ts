/**
 * Story M8-P4 -- schedule_upcoming gateway tool: reads the calendar connector
 * raw store (fixture sqlite via MAMA_CALENDAR_RAW_DB), window-filters, prefers
 * metadata start, caps at 50. Synthetic data only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from '../../src/sqlite.js';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import { CalendarConnector } from '../../src/connectors/calendar/index.js';
import { RawStore } from '../../src/connectors/framework/raw-store.js';
import { execSync } from 'child_process';

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execSync: vi.fn(),
}));

const mockExecGws = {
  mockReturnValueOnce(value: unknown) {
    vi.mocked(execSync).mockReturnValueOnce(JSON.stringify(value));
  },
};

const DAY = 86_400_000;

interface FixtureRow {
  sourceId?: string;
  content: string;
  ts: number;
  meta?: object;
  createdAt?: number;
}

function makeFixtureDb(path: string, rows: FixtureRow[]) {
  const db = new Database(path);
  db.exec(`CREATE TABLE raw_items (
    id INTEGER PRIMARY KEY, source_id TEXT, source TEXT, channel TEXT, author TEXT,
    content TEXT, timestamp INTEGER, type TEXT, metadata TEXT, content_hash TEXT,
    source_cursor TEXT, tenant_id TEXT, project_id TEXT, memory_scope_kind TEXT,
    memory_scope_id TEXT, created_at INTEGER
  )`);
  const stmt = db.prepare(
    `INSERT INTO raw_items (source_id, source, channel, author, content, timestamp, type, metadata, created_at)
     VALUES (?, 'calendar', 'calendar:primary', 'owner', ?, ?, 'event', ?, ?)`
  );
  rows.forEach((r, i) =>
    stmt.run(
      r.sourceId ?? `ev-${i}`,
      r.content,
      r.ts,
      r.meta ? JSON.stringify(r.meta) : null,
      r.createdAt ?? r.ts
    )
  );
  db.close();
}

describe('Story M8-P4: schedule_upcoming gateway tool', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-07T03:00:00.000Z'));
    dir = mkdtempSync(join(tmpdir(), 'mama-sched-'));
    dbPath = join(dir, 'raw.db');
    process.env.MAMA_CALENDAR_RAW_DB = dbPath;
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.MAMA_CALENDAR_RAW_DB;
    rmSync(dir, { recursive: true, force: true });
  });

  describe('Acceptance Criteria: window filtering and digest', () => {
    it('returns only events inside [now, now+days] with a text digest', async () => {
      const now = Date.now();
      makeFixtureDb(dbPath, [
        { content: 'yesterday standup', ts: now - DAY },
        { content: 'tomorrow delivery\nextra detail', ts: now + DAY },
        { content: 'far future review', ts: now + 30 * DAY },
      ]);
      const executor = new GatewayToolExecutor();
      const result = (await executor.execute('schedule_upcoming', { days: 14 })) as {
        success: boolean;
        events: Array<{ title: string; channel: string }>;
        text: string;
      };
      expect(result.success).toBe(true);
      expect(result.events).toHaveLength(1);
      expect(result.events[0]?.title).toBe('tomorrow delivery'); // first line only
      expect(result.text).toContain('tomorrow delivery');
      expect(result.text).toContain('calendar:primary');
    });

    it('prefers metadata start over the row timestamp', async () => {
      const now = Date.now();
      const metaStart = new Date(now + 2 * DAY).toISOString();
      makeFixtureDb(dbPath, [{ content: 'meta event', ts: now + DAY, meta: { start: metaStart } }]);
      const executor = new GatewayToolExecutor();
      const result = (await executor.execute('schedule_upcoming', {})) as {
        events: Array<{ start: string }>;
      };
      expect(result.events[0]?.start).toBe(metaStart);
    });

    it('empty window yields a quiet digest, not a failure', async () => {
      makeFixtureDb(dbPath, []);
      const executor = new GatewayToolExecutor();
      const result = (await executor.execute('schedule_upcoming', { days: 7 })) as {
        success: boolean;
        text: string;
      };
      expect(result.success).toBe(true);
      expect(result.text).toContain('no calendar events');
    });

    it('fails closed when the raw store is missing', async () => {
      process.env.MAMA_CALENDAR_RAW_DB = join(dir, 'nope.db');
      const executor = new GatewayToolExecutor();
      const result = (await executor.execute('schedule_upcoming', {})) as {
        success: boolean;
        error?: string;
      };
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('includes ongoing and future intervals, excludes ended and cancelled occurrences (TG-03/TG-06)', async () => {
      const now = Date.now();
      makeFixtureDb(dbPath, [
        {
          sourceId: 'ongoing',
          content: 'ongoing review',
          ts: now - DAY,
          meta: {
            start: new Date(now - DAY).toISOString(),
            end: new Date(now + DAY).toISOString(),
            status: 'confirmed',
          },
        },
        {
          sourceId: 'future',
          content: 'future review',
          ts: now + 2 * DAY,
          meta: {
            start: new Date(now + 2 * DAY).toISOString(),
            end: new Date(now + 2 * DAY + 3_600_000).toISOString(),
            status: 'confirmed',
          },
        },
        {
          sourceId: 'ended',
          content: 'ended review',
          ts: now - 2 * DAY,
          meta: {
            start: new Date(now - 2 * DAY).toISOString(),
            end: new Date(now - 1).toISOString(),
            status: 'confirmed',
          },
        },
        {
          sourceId: 'cancelled',
          content: 'cancelled review',
          ts: now + DAY,
          meta: {
            start: new Date(now + DAY).toISOString(),
            end: new Date(now + DAY + 3_600_000).toISOString(),
            status: 'cancelled',
          },
        },
      ]);

      const executor = new GatewayToolExecutor();
      const result = (await executor.execute('schedule_upcoming', { days: 14 })) as {
        success: boolean;
        events: Array<{ sourceId: string; status: string }>;
        coverage: { complete: boolean };
      };
      expect(result.events.map((event) => event.sourceId)).toEqual(['ongoing', 'future']);
      expect(result.coverage.complete).toBe(true);
    });

    it('preserves all-day dates, exclusive end, and explicit timezone', async () => {
      makeFixtureDb(dbPath, [
        {
          sourceId: 'all-day',
          content: 'all day event',
          ts: new Date('2026-09-07T15:00:00.000Z').getTime(),
          meta: {
            start: '2026-09-08',
            end: '2026-09-10',
            status: 'confirmed',
            allDay: true,
            endExclusive: true,
            timeZone: 'Asia/Seoul',
          },
        },
      ]);

      const executor = new GatewayToolExecutor();
      const result = (await executor.execute('schedule_upcoming', { days: 14 })) as {
        events: Array<{
          startDate: string;
          endDateExclusive: string;
          timeZone: string;
          allDay: boolean;
        }>;
      };
      expect(result.events[0]).toMatchObject({
        startDate: '2026-09-08',
        endDateExclusive: '2026-09-10',
        timeZone: 'Asia/Seoul',
        allDay: true,
      });
    });

    it.each([
      {
        timeZone: 'Asia/Seoul',
        startDate: '2026-09-08',
        endDate: '2026-09-09',
        beforeEnd: '2026-09-08T14:59:59.999Z',
        atEnd: '2026-09-08T15:00:00.000Z',
      },
      {
        timeZone: 'America/New_York',
        startDate: '2026-11-01',
        endDate: '2026-11-02',
        beforeEnd: '2026-11-02T04:59:59.999Z',
        atEnd: '2026-11-02T05:00:00.000Z',
      },
    ])(
      'uses $timeZone local midnight and exclusive all-day end',
      async ({ timeZone, startDate, endDate, beforeEnd, atEnd }) => {
        const storeRoot = join(dir, 'connectors');
        const store = new RawStore(storeRoot);
        process.env.MAMA_CALENDAR_RAW_DB = join(storeRoot, 'calendar', 'raw.db');
        const connector = new CalendarConnector({
          enabled: true,
          pollIntervalMinutes: 15,
          channels: {},
          auth: { type: 'cli', cli: 'gws', cliAuthCommand: 'gws auth login' },
        });
        mockExecGws.mockReturnValueOnce({
          timeZone,
          items: [
            {
              id: `event-${timeZone}`,
              summary: 'zoned all day',
              status: 'confirmed',
              start: { date: startDate },
              end: { date: endDate },
            },
          ],
        });
        store.save('calendar', await connector.poll(new Date(0)));

        vi.setSystemTime(new Date(beforeEnd));
        const active = (await new GatewayToolExecutor().execute('schedule_upcoming', {
          days: 1,
        })) as { events: Array<{ sourceId: string }> };
        expect(active.events).toHaveLength(1);

        vi.setSystemTime(new Date(atEnd));
        const ended = (await new GatewayToolExecutor().execute('schedule_upcoming', {
          days: 1,
        })) as { events: Array<{ sourceId: string }> };
        expect(ended.events).toHaveLength(0);
        store.close();
      }
    );

    it('uses the latest versioned observation for an update and cancellation through RawStore', async () => {
      const storeRoot = join(dir, 'connectors');
      const store = new RawStore(storeRoot);
      process.env.MAMA_CALENDAR_RAW_DB = join(storeRoot, 'calendar', 'raw.db');
      const connector = new CalendarConnector({
        enabled: true,
        pollIntervalMinutes: 15,
        channels: {},
        auth: { type: 'cli', cli: 'gws', cliAuthCommand: 'gws auth login' },
      });
      const eventWindow = {
        start: { dateTime: '2026-09-08T09:00:00+09:00' },
        end: { dateTime: '2026-09-08T10:00:00+09:00' },
      };

      store.save('calendar', [
        {
          source: 'calendar',
          sourceId: 'same-event',
          channel: 'calendar',
          author: 'owner',
          content: 'Original',
          timestamp: new Date('2026-09-08T00:00:00.000Z'),
          type: 'event',
          metadata: {
            summary: 'Original',
            status: 'confirmed',
            start: '2026-09-08T09:00:00+09:00',
            end: '2026-09-08T10:00:00+09:00',
          },
        },
      ]);
      vi.advanceTimersByTime(1_000);
      mockExecGws.mockReturnValueOnce({
        timeZone: 'Asia/Seoul',
        items: [{ id: 'same-event', summary: 'Updated', status: 'confirmed', ...eventWindow }],
      });
      store.save('calendar', await connector.poll(new Date(0)));

      const updated = (await new GatewayToolExecutor().execute('schedule_upcoming', {
        days: 14,
      })) as { events: Array<{ sourceId: string; title: string }> };
      expect(updated.events).toEqual([
        expect.objectContaining({ sourceId: 'same-event', title: 'Updated' }),
      ]);

      vi.advanceTimersByTime(1_000);
      mockExecGws.mockReturnValueOnce({
        timeZone: 'Asia/Seoul',
        items: [{ id: 'same-event', summary: 'Updated', status: 'cancelled', ...eventWindow }],
      });
      store.save('calendar', await connector.poll(new Date(0)));
      vi.advanceTimersByTime(1_000);
      mockExecGws.mockReturnValueOnce({
        timeZone: 'Asia/Seoul',
        items: [{ id: 'same-event', summary: 'Updated', status: 'cancelled', ...eventWindow }],
      });
      store.save('calendar', await connector.poll(new Date(0)));
      const cancelled = (await new GatewayToolExecutor().execute('schedule_upcoming', {
        days: 14,
      })) as { events: Array<{ sourceId: string }> };
      expect(cancelled.events).toEqual([]);
      expect(store.query('calendar', new Date(0))).toHaveLength(3);
      // A revert reuses the earlier semantic version; millisecond observation order wins over row id.
      vi.advanceTimersByTime(100);
      mockExecGws.mockReturnValueOnce({
        timeZone: 'Asia/Seoul',
        items: [{ id: 'same-event', summary: 'Updated', status: 'confirmed', ...eventWindow }],
      });
      store.save('calendar', await connector.poll(new Date(0)));
      const restored = (await new GatewayToolExecutor().execute('schedule_upcoming', {
        days: 14,
      })) as { events: Array<{ sourceId: string }> };
      expect(restored.events.map((event) => event.sourceId)).toEqual(['same-event']);
      expect(store.query('calendar', new Date(0))).toHaveLength(3);
      store.close();
    });

    it('pages 51 rows with explicit snapshot coverage and continuation', async () => {
      const now = Date.now();
      const storeRoot = join(dir, 'connectors');
      const store = new RawStore(storeRoot);
      process.env.MAMA_CALENDAR_RAW_DB = join(storeRoot, 'calendar', 'raw.db');
      const connector = new CalendarConnector({
        enabled: true,
        pollIntervalMinutes: 15,
        channels: {},
        auth: { type: 'cli', cli: 'gws', cliAuthCommand: 'gws auth login' },
      });
      const upstreamEvents = Array.from({ length: 51 }, (_, index) => ({
        id: `event-${String(index).padStart(2, '0')}`,
        summary: `event ${index}`,
        status: 'confirmed',
        start: { dateTime: new Date(now + (index + 1) * 60_000).toISOString() },
        end: { dateTime: new Date(now + (index + 2) * 60_000).toISOString() },
      }));
      mockExecGws.mockReturnValueOnce({ timeZone: 'Asia/Seoul', items: upstreamEvents });
      store.save('calendar', await connector.poll(new Date(0)));

      const executor = new GatewayToolExecutor();
      const first = (await executor.execute('schedule_upcoming', { days: 14 })) as {
        events: Array<{ sourceId: string }>;
        total: number;
        returned: number;
        nextCursor: string | null;
        observedAt: string | null;
        insertedAt: string;
        readVersion: string;
        coverage: { complete: boolean; source: string };
      };
      expect(first).toMatchObject({
        total: 51,
        returned: 50,
        coverage: { complete: false, source: 'local_snapshot', upstreamComplete: 'unknown' },
      });
      expect(first.nextCursor).toEqual(expect.any(String));
      expect(first.observedAt).toBe(new Date(now).toISOString());
      expect(first.insertedAt).toEqual(expect.any(String));
      expect(first.readVersion).toEqual(expect.any(String));

      vi.advanceTimersByTime(1_000);
      mockExecGws.mockReturnValueOnce({
        timeZone: 'Asia/Seoul',
        items: upstreamEvents.map((event, index) =>
          index === 50 ? { ...event, summary: 'changed event' } : event
        ),
      });
      store.save('calendar', await connector.poll(new Date(0)));

      const second = (await executor.execute('schedule_upcoming', {
        days: 14,
        cursor: first.nextCursor,
      })) as {
        events: Array<{ sourceId: string }>;
        total: number;
        returned: number;
        nextCursor: string | null;
        observedAt: string;
        readVersion: string;
      };
      expect(second).toMatchObject({ success: false });
      expect((second as { error?: string }).error).toMatch(/snapshot changed/i);
      store.close();
    });

    it('does not label a legacy insertion timestamp as an observation timestamp', async () => {
      const now = Date.now();
      makeFixtureDb(dbPath, [
        {
          content: 'legacy event',
          ts: now + DAY,
          createdAt: now - 5_000,
          meta: {
            start: new Date(now + DAY).toISOString(),
            end: new Date(now + DAY + 60_000).toISOString(),
            status: 'confirmed',
          },
        },
      ]);
      const result = (await new GatewayToolExecutor().execute('schedule_upcoming', {
        days: 14,
      })) as { observedAt: string | null; insertedAt: string | null; cacheAgeMs: number | null };
      expect(result).toMatchObject({
        observedAt: null,
        insertedAt: new Date(now - 5_000).toISOString(),
        cacheAgeMs: null,
      });
    });
  });
});
