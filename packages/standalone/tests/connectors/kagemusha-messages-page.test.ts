/**
 * Task C — progressive kagemusha_messages over an ISOLATED in-memory DB.
 *
 * Covers: (created_at, id) keyset paging with tied timestamps traversed exactly
 * once; an append-only asOf upper bound that a later insert cannot shift; a
 * finite time range; a long-content code-point window; and the loud rejections
 * (unknown channel, malformed cursor, unparseable time, changed-query cursor).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from '../../src/sqlite.js';
import type { SQLiteDatabase } from '../../src/sqlite.js';
import {
  queryMessagesPage,
  setKagemushaDbForTest,
} from '../../src/connectors/kagemusha/query-tools.js';

const BASE = Date.parse('2026-07-01T00:00:00Z');
let db: SQLiteDatabase;

function seed(count: number): void {
  const insert = db.prepare(
    'INSERT INTO channel_messages (channel, channel_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (let i = 0; i < count; i += 1) {
    // Groups of 5 share a timestamp: exercises the id tie-break.
    insert.run('kakao', 'r1', `u${i % 3}`, 'user', `message-${i}`, BASE + Math.floor(i / 5) * 1000);
  }
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE rooms (id TEXT PRIMARY KEY, name TEXT, channel TEXT, type TEXT, last_active INTEGER);
    CREATE TABLE channel_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT, channel_id TEXT, user_id TEXT, role TEXT, content TEXT, created_at INTEGER
    );
  `);
  db.prepare('INSERT INTO rooms (id, name, channel, type, last_active) VALUES (?, ?, ?, ?, ?)').run(
    'r1',
    'Room One',
    'kakao',
    'group',
    BASE
  );
  setKagemushaDbForTest(db);
});
afterEach(() => {
  setKagemushaDbForTest(null);
  db.close();
});

describe('Task C: kagemusha_messages progressive paging', () => {
  it('walks every message exactly once across tied timestamps', () => {
    seed(60);
    const seen = new Set<number>();
    let cursor: string | undefined;
    let pages = 0;
    let total = -1;
    do {
      const page = queryMessagesPage({ channelId: 'r1', since: '2026-06-01T00:00:00Z', cursor });
      total = page.total;
      pages += 1;
      for (const message of page.messages) seen.add(message.id);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(total).toBe(60);
    expect(seen.size).toBe(60);
    expect(pages).toBe(Math.ceil(60 / 25));
  });

  it('pins an append-only asOf bound: a later insert never shifts the traversal', () => {
    seed(60);
    const first = queryMessagesPage({ channelId: 'r1', since: '2026-06-01T00:00:00Z' });
    expect(first.total).toBe(60);
    // A brand-new message arrives mid-traversal.
    db.prepare(
      'INSERT INTO channel_messages (channel, channel_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('kakao', 'r1', 'u9', 'user', 'newest', BASE + 999_999);
    const seen = new Set<number>();
    let cursor: string | undefined = first.nextCursor ?? undefined;
    for (const message of first.messages) seen.add(message.id);
    while (cursor) {
      const page = queryMessagesPage({ channelId: 'r1', since: '2026-06-01T00:00:00Z', cursor });
      expect(page.total).toBe(60); // asOf bound holds
      for (const message of page.messages) seen.add(message.id);
      cursor = page.nextCursor ?? undefined;
    }
    expect(seen.size).toBe(60); // the newer insert was excluded
  });

  it('honours a finite [since, before] range', () => {
    seed(60); // timestamps BASE + 0..11 seconds
    const page = queryMessagesPage({
      channelId: 'r1',
      since: new Date(BASE + 2000).toISOString(),
      before: new Date(BASE + 5000).toISOString(),
      limit: 50,
    });
    // created_at > BASE+2000 and <= BASE+5000 -> seconds 3,4,5 -> 15 rows.
    expect(page.total).toBe(15);
    expect(page.returned).toBe(15);
  });

  it('windows long content by code points with a reachable tail', () => {
    db.prepare(
      'INSERT INTO channel_messages (channel, channel_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('kakao', 'r1', 'u0', 'user', 'x'.repeat(5000), BASE);
    const head = queryMessagesPage({
      channelId: 'r1',
      since: '2026-06-01T00:00:00Z',
      content_limit: 2000,
    });
    const window = head.messages[0].content;
    expect(window.total).toBe(5000);
    expect(window.value).toHaveLength(2000);
    expect(window.nextOffset).toBe(2000);
    expect(window.complete).toBe(false);
  });

  it('rejects an unknown channel as a loud missing source, not empty success', () => {
    expect(() => queryMessagesPage({ channelId: 'ghost' })).toThrow(/unknown channel\/source/);
  });

  it('rejects an unparseable time, a malformed cursor, and a changed-query cursor', () => {
    seed(60);
    expect(() => queryMessagesPage({ channelId: 'r1', since: '24h ago' })).toThrow(/ISO-8601/);
    expect(() => queryMessagesPage({ channelId: 'r1', cursor: 'not-a-cursor' })).toThrow(
      /malformed/
    );
    const first = queryMessagesPage({ channelId: 'r1', since: '2026-06-01T00:00:00Z' });
    expect(() =>
      queryMessagesPage({
        channelId: 'r1',
        since: '2026-06-01T00:00:00Z',
        search: 'now-different',
        cursor: first.nextCursor!,
      })
    ).toThrow(/different query/);
  });

  it('rejects a page size outside 1..50, never clamping', () => {
    seed(60);
    expect(() => queryMessagesPage({ channelId: 'r1', limit: 51 })).toThrow(/1 to 50/);
    expect(() => queryMessagesPage({ channelId: 'r1', limit: 0 })).toThrow(/1 to 50/);
  });

  it('freezes an implicit default since into the cursor so a later clock tick does not change the query', () => {
    // Two messages inside the default 7-day window; page 1 omits `since`.
    const insert = db.prepare(
      'INSERT INTO channel_messages (channel, channel_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    vi.useFakeTimers();
    try {
      vi.setSystemTime(BASE + 2000);
      insert.run('kakao', 'r1', 'u0', 'user', 'one', BASE);
      insert.run('kakao', 'r1', 'u1', 'user', 'two', BASE + 1000);
      const first = queryMessagesPage({ channelId: 'r1', limit: 1 });
      expect(first.returned).toBe(1);
      expect(first.nextCursor).not.toBeNull();
      // The clock advances before the continuation - the default since would recompute.
      vi.setSystemTime(BASE + 3000);
      const second = queryMessagesPage({ channelId: 'r1', limit: 1, cursor: first.nextCursor! });
      expect(second.returned).toBe(1);
      expect(second.messages[0].id).not.toBe(first.messages[0].id);
    } finally {
      vi.useRealTimers();
    }
  });

  it('selects one scoped message by messageId across content offsets, without its peers', () => {
    const insert = db.prepare(
      'INSERT INTO channel_messages (channel, channel_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    // Two messages sharing a timestamp; since/before cannot isolate one of them.
    insert.run('kakao', 'r1', 'u0', 'user', 'y'.repeat(5000), BASE);
    const tiedTarget = Number(
      insert.run('kakao', 'r1', 'u1', 'user', 'z'.repeat(5000), BASE).lastInsertRowid
    );
    const scope = { channelId: 'r1', since: '2026-06-01T00:00:00Z' } as const;
    const head = queryMessagesPage({ ...scope, messageId: tiedTarget, content_limit: 2000 });
    expect(head.total).toBe(1);
    expect(head.messages).toHaveLength(1);
    expect(head.messages[0].id).toBe(tiedTarget);
    expect(head.messages[0].content.total).toBe(5000);
    expect(head.messages[0].content.nextOffset).toBe(2000);
    const tail = queryMessagesPage({
      ...scope,
      messageId: tiedTarget,
      content_offset: 4000,
      content_limit: 2000,
    });
    expect(tail.messages[0].content.value).toHaveLength(1000);
    expect(tail.messages[0].content.complete).toBe(true);
  });

  it('treats an out-of-scope or cross-channel messageId as a generic not-found', () => {
    seed(5); // r1 messages
    db.prepare(
      'INSERT INTO rooms (id, name, channel, type, last_active) VALUES (?, ?, ?, ?, ?)'
    ).run('r2', 'Room Two', 'kakao', 'group', BASE);
    const foreign = Number(
      db
        .prepare(
          'INSERT INTO channel_messages (channel, channel_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run('kakao', 'r2', 'u0', 'user', 'other channel', BASE).lastInsertRowid
    );
    // A message that exists, but in another channel, is not disclosed through r1.
    expect(() =>
      queryMessagesPage({ channelId: 'r1', since: '2026-06-01T00:00:00Z', messageId: foreign })
    ).toThrow(/not in this channel\/time\/search scope/);
    // A nonexistent id is the same generic not-found.
    expect(() =>
      queryMessagesPage({ channelId: 'r1', since: '2026-06-01T00:00:00Z', messageId: 999999 })
    ).toThrow(/not in this channel\/time\/search scope/);
  });
});
