/**
 * Story M8-P4 -- schedule_upcoming gateway tool: reads the calendar connector
 * raw store (fixture sqlite via MAMA_CALENDAR_RAW_DB), window-filters, prefers
 * metadata start, caps at 50. Synthetic data only.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from '../../src/sqlite.js';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';

const DAY = 86_400_000;

function makeFixtureDb(path: string, rows: Array<{ content: string; ts: number; meta?: object }>) {
  const db = new Database(path);
  db.exec(`CREATE TABLE raw_items (
    id INTEGER PRIMARY KEY, source_id TEXT, source TEXT, channel TEXT, author TEXT,
    content TEXT, timestamp INTEGER, type TEXT, metadata TEXT, content_hash TEXT,
    source_cursor TEXT, tenant_id TEXT, project_id TEXT, memory_scope_kind TEXT,
    memory_scope_id TEXT, created_at INTEGER
  )`);
  const stmt = db.prepare(
    `INSERT INTO raw_items (source_id, channel, content, timestamp, metadata)
     VALUES (?, 'calendar:primary', ?, ?, ?)`
  );
  rows.forEach((r, i) =>
    stmt.run(`ev-${i}`, r.content, r.ts, r.meta ? JSON.stringify(r.meta) : null)
  );
  db.close();
}

describe('Story M8-P4: schedule_upcoming gateway tool', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mama-sched-'));
    dbPath = join(dir, 'raw.db');
    process.env.MAMA_CALENDAR_RAW_DB = dbPath;
  });
  afterEach(() => {
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
  });
});
