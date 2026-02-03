/**
 * Unit tests for SessionStore
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { SessionStore } from '../../src/gateways/session-store.js';

describe('SessionStore', () => {
  let db: Database.Database;
  let store: SessionStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new SessionStore(db);
  });

  afterEach(() => {
    store.close();
  });

  describe('Migration', () => {
    it('should create messenger_sessions table', () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messenger_sessions'")
        .all();
      expect(tables).toHaveLength(1);
    });

    it('should create index', () => {
      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messenger_source_channel'"
        )
        .all();
      expect(indexes).toHaveLength(1);
    });
  });

  describe('getOrCreate()', () => {
    it('should create new session', () => {
      const session = store.getOrCreate('discord', 'channel-123');

      expect(session.id).toBeDefined();
      expect(session.source).toBe('discord');
      expect(session.channelId).toBe('channel-123');
      expect(session.context).toBe('[]');
    });

    it('should return existing session', () => {
      const session1 = store.getOrCreate('discord', 'channel-123');
      const session2 = store.getOrCreate('discord', 'channel-123');

      expect(session1.id).toBe(session2.id);
    });

    it('should create separate sessions for different channels', () => {
      const session1 = store.getOrCreate('discord', 'channel-1');
      const session2 = store.getOrCreate('discord', 'channel-2');

      expect(session1.id).not.toBe(session2.id);
    });

    it('should create separate sessions for different sources', () => {
      const session1 = store.getOrCreate('discord', 'channel-123');
      const session2 = store.getOrCreate('slack', 'channel-123');

      expect(session1.id).not.toBe(session2.id);
    });

    it('should store userId if provided', () => {
      const session = store.getOrCreate('discord', 'channel-123', 'user-456');

      expect(session.userId).toBe('user-456');
    });
  });

  describe('getById()', () => {
    it('should return null for non-existent session', () => {
      const session = store.getById('nonexistent');
      expect(session).toBeNull();
    });

    it('should return session by ID', () => {
      const created = store.getOrCreate('discord', 'channel-123');
      const retrieved = store.getById(created.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(created.id);
    });
  });

  describe('updateSession()', () => {
    it('should add conversation turn', () => {
      const session = store.getOrCreate('discord', 'channel-123');

      const updated = store.updateSession(session.id, 'Hello', 'Hi there!');

      expect(updated).toBe(true);

      const history = store.getHistory(session.id);
      expect(history).toHaveLength(1);
      expect(history[0].user).toBe('Hello');
      expect(history[0].bot).toBe('Hi there!');
    });

    it('should keep only maxTurns', () => {
      const customStore = new SessionStore(db, { maxTurns: 3 });
      const session = customStore.getOrCreate('discord', 'test-channel');

      for (let i = 0; i < 5; i++) {
        customStore.updateSession(session.id, `Message ${i}`, `Response ${i}`);
      }

      const history = customStore.getHistory(session.id);
      expect(history).toHaveLength(3);
      expect(history[0].user).toBe('Message 2'); // Oldest kept
      expect(history[2].user).toBe('Message 4'); // Newest
    });

    it('should store full response without truncation', () => {
      // Truncation removed - store unlimited in DB, truncate only when injecting to prompt
      const session = store.getOrCreate('discord', 'test-channel');
      const longResponse = 'This is a very long response that should NOT be truncated in storage';

      store.updateSession(session.id, 'Hello', longResponse);

      const history = store.getHistory(session.id);
      expect(history[0].bot).toBe(longResponse);
    });

    it('should return false for non-existent session', () => {
      const updated = store.updateSession('nonexistent', 'Hello', 'Hi');
      expect(updated).toBe(false);
    });
  });

  describe('getHistory()', () => {
    it('should return empty array for new session', () => {
      const session = store.getOrCreate('discord', 'channel-123');
      const history = store.getHistory(session.id);
      expect(history).toEqual([]);
    });

    it('should return conversation history', () => {
      const session = store.getOrCreate('discord', 'channel-123');
      store.updateSession(session.id, 'Hello', 'Hi');
      store.updateSession(session.id, 'How are you?', 'Great!');

      const history = store.getHistory(session.id);

      expect(history).toHaveLength(2);
      expect(history[0].user).toBe('Hello');
      expect(history[1].user).toBe('How are you?');
    });
  });

  describe('clearContext()', () => {
    it('should clear session context', () => {
      const session = store.getOrCreate('discord', 'channel-123');
      store.updateSession(session.id, 'Hello', 'Hi');

      const cleared = store.clearContext(session.id);

      expect(cleared).toBe(true);
      expect(store.getHistory(session.id)).toEqual([]);
    });

    it('should return false for non-existent session', () => {
      const cleared = store.clearContext('nonexistent');
      expect(cleared).toBe(false);
    });
  });

  describe('deleteSession()', () => {
    it('should delete session', () => {
      const session = store.getOrCreate('discord', 'channel-123');

      const deleted = store.deleteSession(session.id);

      expect(deleted).toBe(true);
      expect(store.getById(session.id)).toBeNull();
    });

    it('should return false for non-existent session', () => {
      const deleted = store.deleteSession('nonexistent');
      expect(deleted).toBe(false);
    });
  });

  describe('listSessions()', () => {
    it('should return empty array when no sessions', () => {
      const sessions = store.listSessions();
      expect(sessions).toEqual([]);
    });

    it('should list all sessions', () => {
      store.getOrCreate('discord', 'channel-1');
      store.getOrCreate('slack', 'channel-2');

      const sessions = store.listSessions();
      expect(sessions).toHaveLength(2);
    });

    it('should filter by source', () => {
      store.getOrCreate('discord', 'channel-1');
      store.getOrCreate('slack', 'channel-2');
      store.getOrCreate('discord', 'channel-3');

      const discordSessions = store.listSessions('discord');
      expect(discordSessions).toHaveLength(2);
      expect(discordSessions.every((s) => s.source === 'discord')).toBe(true);
    });
  });

  describe('cleanupInactiveSessions()', () => {
    it('should delete old sessions', async () => {
      // Create a session
      const session = store.getOrCreate('discord', 'channel-123');

      // Manually set last_active to past
      db.prepare('UPDATE messenger_sessions SET last_active = ? WHERE id = ?').run(
        Date.now() - 100000,
        session.id
      );

      // Create a recent session
      store.getOrCreate('discord', 'channel-456');

      // Cleanup sessions older than 50 seconds
      const deleted = store.cleanupInactiveSessions(50000);

      expect(deleted).toBe(1);
      expect(store.listSessions()).toHaveLength(1);
    });
  });

  describe('formatContextForPrompt()', () => {
    it('should return "New conversation" for empty history', () => {
      const session = store.getOrCreate('discord', 'channel-123');
      const formatted = store.formatContextForPrompt(session.id);
      expect(formatted).toBe('New conversation');
    });

    it('should format history as readable text', () => {
      const session = store.getOrCreate('discord', 'channel-123');
      store.updateSession(session.id, 'Hello', 'Hi there!');
      store.updateSession(session.id, 'How are you?', 'Great!');

      const formatted = store.formatContextForPrompt(session.id);

      expect(formatted).toContain('User: Hello');
      expect(formatted).toContain('Assistant: Hi there!');
      expect(formatted).toContain('User: How are you?');
      expect(formatted).toContain('Assistant: Great!');
    });
  });
});
