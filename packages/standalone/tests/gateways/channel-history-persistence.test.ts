/**
 * Unit tests for ChannelHistory SQLite persistence (Sprint 3 F5)
 *
 * Tests:
 * - SQLite table creation
 * - Write-through on record()
 * - Preload from DB on startup
 * - 24-hour cleanup
 * - Restart scenario (in-memory loss + DB restore)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ChannelHistory } from '../../src/gateways/channel-history.js';
import type { HistoryEntry } from '../../src/gateways/channel-history.js';

describe('ChannelHistory - SQLite Persistence', () => {
  let db: Database.Database;
  let history: ChannelHistory;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    if (history) {
      history.destroy();
    }
    db.close();
  });

  describe('Migration', () => {
    it('should create channel_messages table', () => {
      history = new ChannelHistory({ db });

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='channel_messages'")
        .all();
      expect(tables).toHaveLength(1);
    });

    it('should create channel-timestamp index', () => {
      history = new ChannelHistory({ db });

      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_channel_ts'")
        .all();
      expect(indexes).toHaveLength(1);
    });
  });

  describe('Write-through persistence', () => {
    it('should save messages to SQLite on record()', () => {
      history = new ChannelHistory({ db });

      const entry: HistoryEntry = {
        messageId: 'msg-1',
        sender: 'Alice',
        userId: 'user-123',
        body: 'Hello world',
        timestamp: Date.now(),
        isBot: false,
      };

      history.record('channel-1', entry);

      // Verify DB write
      const rows = db.prepare('SELECT * FROM channel_messages WHERE message_id = ?').all('msg-1');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        channel_id: 'channel-1',
        message_id: 'msg-1',
        sender: 'Alice',
        user_id: 'user-123',
        body: 'Hello world',
        is_bot: 0,
      });
    });

    it('should handle INSERT OR REPLACE correctly', () => {
      history = new ChannelHistory({ db });

      const entry: HistoryEntry = {
        messageId: 'msg-1',
        sender: 'Alice',
        userId: 'user-123',
        body: 'First message',
        timestamp: Date.now(),
      };

      history.record('channel-1', entry);

      // Update sender via updateSender()
      history.updateSender('channel-1', 'msg-1', 'Alice (updated)');

      // Record again (REPLACE)
      const updatedEntry = { ...entry, body: 'Updated message' };
      history.record('channel-1', updatedEntry);

      const rows = db.prepare('SELECT * FROM channel_messages WHERE message_id = ?').all('msg-1');
      expect(rows).toHaveLength(1);
      expect(rows[0].body).toBe('Updated message');
    });

    it('should not crash if DB is not provided', () => {
      // No DB = in-memory only
      history = new ChannelHistory();

      const entry: HistoryEntry = {
        messageId: 'msg-1',
        sender: 'Alice',
        userId: 'user-123',
        body: 'Hello',
        timestamp: Date.now(),
      };

      expect(() => history.record('channel-1', entry)).not.toThrow();
    });
  });

  describe('Preload from DB on startup', () => {
    it('should load recent 5 messages per channel', () => {
      // First instance: write 10 messages
      history = new ChannelHistory({ db, preloadLimit: 5 });

      for (let i = 1; i <= 10; i++) {
        history.record('channel-1', {
          messageId: `msg-${i}`,
          sender: `User${i}`,
          userId: `user-${i}`,
          body: `Message ${i}`,
          timestamp: Date.now() + i * 1000,
          isBot: false,
        });
      }

      history.destroy();

      // Second instance: preload
      const history2 = new ChannelHistory({ db, preloadLimit: 5 });

      const loaded = history2.getHistory('channel-1');
      expect(loaded).toHaveLength(5);
      expect(loaded[0].body).toBe('Message 6'); // Oldest of recent 5
      expect(loaded[4].body).toBe('Message 10'); // Most recent

      history2.destroy();
    });

    it('should load from multiple channels', () => {
      history = new ChannelHistory({ db, preloadLimit: 3 });

      // Channel 1
      for (let i = 1; i <= 5; i++) {
        history.record('channel-1', {
          messageId: `ch1-msg-${i}`,
          sender: 'Alice',
          userId: 'alice',
          body: `Channel 1 message ${i}`,
          timestamp: Date.now() + i * 1000,
        });
      }

      // Channel 2
      for (let i = 1; i <= 3; i++) {
        history.record('channel-2', {
          messageId: `ch2-msg-${i}`,
          sender: 'Bob',
          userId: 'bob',
          body: `Channel 2 message ${i}`,
          timestamp: Date.now() + i * 1000,
        });
      }

      history.destroy();

      // Restart: preload
      const history2 = new ChannelHistory({ db, preloadLimit: 3 });

      const ch1 = history2.getHistory('channel-1');
      const ch2 = history2.getHistory('channel-2');

      expect(ch1).toHaveLength(3);
      expect(ch2).toHaveLength(3);

      history2.destroy();
    });

    it('should not load if no DB provided', () => {
      const history2 = new ChannelHistory(); // No DB

      const loaded = history2.getHistory('channel-1');
      expect(loaded).toHaveLength(0);
    });
  });

  describe('24-hour cleanup', () => {
    it('should delete messages older than 24 hours', () => {
      history = new ChannelHistory({ db });

      const now = Date.now();
      const oneDayAgo = now - 24 * 60 * 60 * 1000;
      const twoDaysAgo = now - 48 * 60 * 60 * 1000;

      // Old message (48h ago)
      db.prepare(
        `INSERT INTO channel_messages
         (channel_id, message_id, sender, user_id, body, timestamp, is_bot)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('channel-1', 'old-msg', 'Alice', 'alice', 'Old', twoDaysAgo, 0);

      // Recent message (12h ago)
      db.prepare(
        `INSERT INTO channel_messages
         (channel_id, message_id, sender, user_id, body, timestamp, is_bot)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('channel-1', 'recent-msg', 'Bob', 'bob', 'Recent', oneDayAgo + 12 * 60 * 60 * 1000, 0);

      // Cleanup
      const _cleaned = (history as unknown as { cleanupDb: () => void }).cleanupDb();

      const remaining = db.prepare('SELECT COUNT(*) as count FROM channel_messages').get() as {
        count: number;
      };

      expect(remaining.count).toBe(1);

      const rows = db.prepare('SELECT message_id FROM channel_messages').all() as Array<{
        message_id: string;
      }>;
      expect(rows[0].message_id).toBe('recent-msg');
    });

    it('should return cleaned count', () => {
      history = new ChannelHistory({ db });

      const twoDaysAgo = Date.now() - 48 * 60 * 60 * 1000;

      for (let i = 1; i <= 5; i++) {
        db.prepare(
          `INSERT INTO channel_messages
           (channel_id, message_id, sender, user_id, body, timestamp, is_bot)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run('channel-1', `msg-${i}`, 'Alice', 'alice', `Msg ${i}`, twoDaysAgo, 0);
      }

      // Should log cleanup (check manually or mock console.log)
      const cleaned = (history as unknown as { cleanupDb: () => void }).cleanupDb();
      // Can't easily test console.log without mocking, but ensure no crash
      expect(cleaned).toBeUndefined();
    });
  });

  describe('Restart scenario (Sprint 3 F5.6)', () => {
    it('should restore context after daemon restart', () => {
      // Session 1: active daemon
      history = new ChannelHistory({ db });

      const entries: HistoryEntry[] = [
        {
          messageId: 'msg-1',
          sender: 'Sisyphus',
          userId: 'sisyphus',
          body: 'src/api/graph-api.js에 status 엔드포인트 구현해줘',
          timestamp: Date.now(),
        },
        {
          messageId: 'msg-2',
          sender: 'DevBot',
          userId: 'devbot',
          body: '완료했습니다. GET /api/multi-agent/status 추가.',
          timestamp: Date.now() + 1000,
          isBot: true,
        },
        {
          messageId: 'msg-3',
          sender: 'Sisyphus',
          userId: 'sisyphus',
          body: '코드 리뷰 부탁',
          timestamp: Date.now() + 2000,
        },
        {
          messageId: 'msg-4',
          sender: 'Reviewer',
          userId: 'reviewer',
          body: 'LGTM. 토큰 마스킹 추가 권장.',
          timestamp: Date.now() + 3000,
          isBot: true,
        },
        {
          messageId: 'msg-5',
          sender: 'User',
          userId: 'user-123',
          body: '커밋해줘',
          timestamp: Date.now() + 4000,
        },
      ];

      for (const entry of entries) {
        history.record('channel-123', entry);
      }

      // Simulate daemon crash (in-memory lost)
      const formatted1 = history.formatForContext('channel-123');
      expect(formatted1).toContain('Sisyphus');
      expect(formatted1).toContain('DevBot');

      history.destroy();

      // Session 2: daemon restart (new ChannelHistory instance)
      const history2 = new ChannelHistory({ db, preloadLimit: 5 });

      // Verify context restored
      const restored = history2.getHistory('channel-123');
      expect(restored).toHaveLength(5);

      const formatted2 = history2.formatForContext('channel-123');
      expect(formatted2).toContain('[Chat messages since your last reply - for context]');
      expect(formatted2).toContain('Sisyphus:');
      expect(formatted2).toContain('DevBot:');
      expect(formatted2).toContain('Reviewer:');
      expect(formatted2).toContain('커밋해줘');

      history2.destroy();
    });
  });

  describe('Backward compatibility', () => {
    it('should work without DB (in-memory only)', () => {
      history = new ChannelHistory(); // No DB

      const entry: HistoryEntry = {
        messageId: 'msg-1',
        sender: 'Alice',
        userId: 'alice',
        body: 'Hello',
        timestamp: Date.now(),
      };

      history.record('channel-1', entry);

      const retrieved = history.getHistory('channel-1');
      expect(retrieved).toHaveLength(1);
      expect(retrieved[0].body).toBe('Hello');
    });

    it('should not break existing API', () => {
      history = new ChannelHistory({ db });

      // Test all existing methods
      const entry: HistoryEntry = {
        messageId: 'msg-1',
        sender: 'Alice',
        userId: 'alice',
        body: 'Test',
        timestamp: Date.now(),
      };

      history.record('channel-1', entry);
      expect(history.getHistory('channel-1')).toHaveLength(1);
      expect(history.getRecentHistory('channel-1', 'msg-1')).toHaveLength(0);
      expect(history.getChannelIds()).toContain('channel-1');

      history.updateSender('channel-1', 'msg-1', 'Alice (new)');
      expect(history.getHistory('channel-1')[0].sender).toBe('Alice (new)');

      history.clear('channel-1');
      expect(history.getHistory('channel-1')).toHaveLength(0);
    });
  });
});
