import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import Database from '../../src/sqlite.js';
import { KagemushaConnector } from '../../src/connectors/kagemusha/index.js';
import type { ConnectorConfig } from '../../src/connectors/framework/types.js';

let tempDir: string;
let tempDbPath: string;

function makeConfig(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    enabled: true,
    pollIntervalMinutes: 5,
    channels: {},
    auth: { type: 'none' },
    ...overrides,
  };
}

function createTestDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  return db;
}

describe('KagemushaConnector', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kagemusha-test-'));
    tempDbPath = join(tempDir, 'kagemusha.db');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('name and type', () => {
    it('has name "kagemusha"', () => {
      const connector = new KagemushaConnector(makeConfig(), tempDbPath);
      expect(connector.name).toBe('kagemusha');
    });

    it('has type "local"', () => {
      const connector = new KagemushaConnector(makeConfig(), tempDbPath);
      expect(connector.type).toBe('local');
    });
  });

  describe('getAuthRequirements', () => {
    it('returns "none" auth requirement', () => {
      const connector = new KagemushaConnector(makeConfig(), tempDbPath);
      const reqs = connector.getAuthRequirements();
      expect(reqs).toHaveLength(1);
      expect(reqs[0]?.type).toBe('none');
    });
  });

  describe('init', () => {
    it('initializes successfully when db file exists', async () => {
      createTestDb(tempDbPath).close();
      const connector = new KagemushaConnector(makeConfig(), tempDbPath);
      await expect(connector.init()).resolves.toBeUndefined();
      await connector.dispose();
    });

    it('throws when db file does not exist', async () => {
      const connector = new KagemushaConnector(makeConfig(), '/nonexistent/path/kagemusha.db');
      await expect(connector.init()).rejects.toThrow(/failed to open/i);
    });
  });

  describe('authenticate', () => {
    it('returns true after init', async () => {
      createTestDb(tempDbPath).close();
      const connector = new KagemushaConnector(makeConfig(), tempDbPath);
      await connector.init();
      expect(await connector.authenticate()).toBe(true);
      await connector.dispose();
    });

    it('returns false before init', async () => {
      const connector = new KagemushaConnector(makeConfig(), tempDbPath);
      expect(await connector.authenticate()).toBe(false);
    });
  });

  describe('poll', () => {
    it('returns empty array when no messages after since', async () => {
      createTestDb(tempDbPath).close();
      const connector = new KagemushaConnector(makeConfig(), tempDbPath);
      await connector.init();
      const items = await connector.poll(new Date('2030-01-01T00:00:00.000Z'));
      expect(items).toEqual([]);
      await connector.dispose();
    });

    it('returns user messages newer than since', async () => {
      const db = createTestDb(tempDbPath);
      db.prepare(
        `INSERT INTO channel_messages (channel, channel_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      ).run('chatwork', 'room-123', 'user-alice', 'user', 'Hello', 1705309200000);
      db.close();

      const connector = new KagemushaConnector(makeConfig(), tempDbPath);
      await connector.init();
      const items = await connector.poll(new Date('2024-01-01T00:00:00.000Z'));
      expect(items).toHaveLength(1);
      expect(items[0]?.content).toBe('Hello');
      await connector.dispose();
    });

    it('excludes non-user messages (role != user)', async () => {
      const db = createTestDb(tempDbPath);
      db.prepare(
        `INSERT INTO channel_messages (channel, channel_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      ).run('chatwork', 'room-123', 'assistant', 'assistant', 'AI response', 1705309200000);
      db.close();

      const connector = new KagemushaConnector(makeConfig(), tempDbPath);
      await connector.init();
      const items = await connector.poll(new Date('2024-01-01T00:00:00.000Z'));
      expect(items).toHaveLength(0);
      await connector.dispose();
    });

    it('excludes messages before since', async () => {
      const db = createTestDb(tempDbPath);
      db.prepare(
        `INSERT INTO channel_messages (channel, channel_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      ).run('slack', 'channel-abc', 'user-bob', 'user', 'Old message', 1704067199000);
      db.close();

      const connector = new KagemushaConnector(makeConfig(), tempDbPath);
      await connector.init();
      const items = await connector.poll(new Date('2024-01-01T00:00:00.000Z'));
      expect(items).toHaveLength(0);
      await connector.dispose();
    });

    it('sets sourceId as "channelId:id"', async () => {
      const db = createTestDb(tempDbPath);
      db.prepare(
        `INSERT INTO channel_messages (channel, channel_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      ).run('chatwork', 'room-999', 'user-alice', 'user', 'Test', '2024-06-01T00:00:00.000Z');
      db.close();

      const connector = new KagemushaConnector(makeConfig(), tempDbPath);
      await connector.init();
      const items = await connector.poll(new Date('2024-01-01T00:00:00.000Z'));
      // id is auto-incremented, starts at 1
      expect(items[0]?.sourceId).toBe('room-999:1');
      await connector.dispose();
    });

    it('sets source from row.channel', async () => {
      const db = createTestDb(tempDbPath);
      db.prepare(
        `INSERT INTO channel_messages (channel, channel_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      ).run('kakao', 'kakao-room-1', 'user-carol', 'user', 'Hi', '2024-06-01T00:00:00.000Z');
      db.close();

      const connector = new KagemushaConnector(makeConfig(), tempDbPath);
      await connector.init();
      const items = await connector.poll(new Date('2024-01-01T00:00:00.000Z'));
      expect(items[0]?.source).toBe('kakao');
      await connector.dispose();
    });

    it('sets channel from row.channel_id', async () => {
      const db = createTestDb(tempDbPath);
      db.prepare(
        `INSERT INTO channel_messages (channel, channel_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      ).run('slack', 'C01234ABCDE', 'user-dave', 'user', 'Hey', '2024-06-01T00:00:00.000Z');
      db.close();

      const connector = new KagemushaConnector(makeConfig(), tempDbPath);
      await connector.init();
      const items = await connector.poll(new Date('2024-01-01T00:00:00.000Z'));
      expect(items[0]?.channel).toBe('C01234ABCDE');
      await connector.dispose();
    });

    it('sets author from row.user_id', async () => {
      const db = createTestDb(tempDbPath);
      db.prepare(
        `INSERT INTO channel_messages (channel, channel_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      ).run('chatwork', 'room-1', 'user-eve', 'user', 'Hello', '2024-06-01T00:00:00.000Z');
      db.close();

      const connector = new KagemushaConnector(makeConfig(), tempDbPath);
      await connector.init();
      const items = await connector.poll(new Date('2024-01-01T00:00:00.000Z'));
      expect(items[0]?.author).toBe('user-eve');
      await connector.dispose();
    });

    it('sets type to "message"', async () => {
      const db = createTestDb(tempDbPath);
      db.prepare(
        `INSERT INTO channel_messages (channel, channel_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      ).run('slack', 'C1', 'user-1', 'user', 'msg', '2024-06-01T00:00:00.000Z');
      db.close();

      const connector = new KagemushaConnector(makeConfig(), tempDbPath);
      await connector.init();
      const items = await connector.poll(new Date('2024-01-01T00:00:00.000Z'));
      expect(items[0]?.type).toBe('message');
      await connector.dispose();
    });

    it('returns messages ordered by created_at ascending', async () => {
      const db = createTestDb(tempDbPath);
      const stmt = db.prepare(
        `INSERT INTO channel_messages (channel, channel_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      );
      stmt.run('slack', 'C1', 'u1', 'user', 'second', '2024-06-01T00:00:02.000Z');
      stmt.run('slack', 'C1', 'u1', 'user', 'first', '2024-06-01T00:00:01.000Z');
      stmt.run('slack', 'C1', 'u1', 'user', 'third', '2024-06-01T00:00:03.000Z');
      db.close();

      const connector = new KagemushaConnector(makeConfig(), tempDbPath);
      await connector.init();
      const items = await connector.poll(new Date('2024-01-01T00:00:00.000Z'));
      expect(items[0]?.content).toBe('first');
      expect(items[1]?.content).toBe('second');
      expect(items[2]?.content).toBe('third');
      await connector.dispose();
    });
  });

  describe('healthCheck', () => {
    it('returns healthy after successful poll', async () => {
      createTestDb(tempDbPath).close();
      const connector = new KagemushaConnector(makeConfig(), tempDbPath);
      await connector.init();
      await connector.poll(new Date(0));
      const health = await connector.healthCheck();
      expect(health.healthy).toBe(true);
      await connector.dispose();
    });

    it('tracks lastPollTime after poll', async () => {
      createTestDb(tempDbPath).close();
      const connector = new KagemushaConnector(makeConfig(), tempDbPath);
      await connector.init();
      const before = new Date();
      await connector.poll(new Date(0));
      const health = await connector.healthCheck();
      expect(health.lastPollTime).not.toBeNull();
      expect(health.lastPollTime!.getTime()).toBeGreaterThanOrEqual(before.getTime());
      await connector.dispose();
    });
  });

  describe('dispose', () => {
    it('closes the database and authenticate returns false', async () => {
      createTestDb(tempDbPath).close();
      const connector = new KagemushaConnector(makeConfig(), tempDbPath);
      await connector.init();
      await connector.dispose();
      expect(await connector.authenticate()).toBe(false);
    });
  });
});
