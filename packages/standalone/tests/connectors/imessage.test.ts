import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IMessageConnector } from '../../src/connectors/imessage/index.js';
import Database from '../../src/sqlite.js';
import type { ConnectorConfig } from '../../src/connectors/framework/types.js';

let root = '';
let databasePath = '';

function makeConfig(
  channels: ConnectorConfig['channels'] = { 'chat-fixture-1': { role: 'truth' } }
): ConnectorConfig {
  return {
    enabled: true,
    pollIntervalMinutes: 5,
    channels,
    auth: { type: 'none' },
  };
}

function createDatabase(): void {
  const database = new Database(databasePath);
  database.exec(`
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY,
      date INTEGER NOT NULL,
      text TEXT,
      is_from_me INTEGER NOT NULL,
      handle_id INTEGER
    );
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat_message_join (message_id INTEGER, chat_id INTEGER);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, display_name TEXT);
    INSERT INTO handle VALUES (1, 'sender-fixture');
    INSERT INTO chat VALUES (1, 'chat-fixture-1', 'Fixture chat one');
    INSERT INTO chat VALUES (2, 'chat-fixture-2', 'Fixture chat two');
  `);
  const coreDataDate = (unixSeconds: number): string =>
    String(BigInt(unixSeconds - 978_307_200) * 1_000_000_000n);
  database.exec(`
    INSERT INTO message VALUES (1, ${coreDataDate(1_704_067_201)}, 'Fixture selected message', 0, 1);
    INSERT INTO message VALUES (2, ${coreDataDate(1_704_067_202)}, 'Fixture unselected message', 0, 1);
    INSERT INTO message VALUES (3, ${coreDataDate(1_704_067_203)}, 'Fixture owner message', 1, NULL);
    INSERT INTO chat_message_join VALUES (1, 1);
    INSERT INTO chat_message_join VALUES (2, 2);
    INSERT INTO chat_message_join VALUES (3, 1);
  `);
  database.close();
}

describe('IMessageConnector', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'imessage-connector-test-'));
    databasePath = join(root, 'chat.db');
    createDatabase();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('opens the configured database and requires selected chats', async () => {
    const connector = new IMessageConnector(makeConfig(), databasePath, 'darwin');
    await expect(connector.init()).resolves.toBeUndefined();
    expect(await connector.authenticate()).toBe(true);
    await connector.dispose();

    const unscoped = new IMessageConnector(makeConfig({}), databasePath, 'darwin');
    await expect(unscoped.init()).rejects.toThrow(/explicitly configured chat identifiers/i);
    // Messages keeps its database on macOS only (L4).
    await expect(new IMessageConnector(makeConfig(), databasePath, 'linux').init()).rejects.toThrow(
      /macOS only/
    );
  });

  it('converts Core Data dates and reads only the configured chat', async () => {
    const connector = new IMessageConnector(
      makeConfig({
        'chat-fixture-1': { role: 'truth' },
        'chat-fixture-2': { role: 'ignore' },
      }),
      databasePath,
      'darwin'
    );
    await connector.init();
    const items = await connector.poll(new Date('2024-01-01T00:00:00.000Z'));

    expect(items).toHaveLength(2);
    expect(items.map((item) => item.sourceId)).toEqual(['imessage:1', 'imessage:3']);
    expect(items[0]?.timestamp.toISOString()).toBe('2024-01-01T00:00:01.000Z');
    expect(items[0]?.channel).toBe('chat-fixture-1');
    expect(items[0]?.content).toBe('Fixture selected message');
    expect(JSON.stringify(items)).not.toContain(databasePath);
    await connector.dispose();
  });

  it('does not return messages from a chat that is not configured', async () => {
    const connector = new IMessageConnector(makeConfig(), databasePath, 'darwin');
    await connector.init();
    const items = await connector.poll(new Date(0));
    expect(items.every((item) => item.channel === 'chat-fixture-1')).toBe(true);
    expect(items.some((item) => item.content.includes('unselected'))).toBe(false);
    await connector.dispose();
  });

  it('includes a message at the cursor millisecond instead of skipping its cursor second', async () => {
    const connector = new IMessageConnector(makeConfig(), databasePath, 'darwin');
    await connector.init();
    const items = await connector.poll(new Date('2024-01-01T00:00:01.000Z'));
    expect(items.map((item) => item.sourceId)).toContain('imessage:1');
    await connector.dispose();
  });

  it('surfaces a failed SQLite query instead of returning a partial poll', async () => {
    const connector = new IMessageConnector(makeConfig(), databasePath, 'darwin');
    await connector.init();
    const other = new Database(databasePath);
    other.exec('DROP TABLE message');
    other.close();

    await expect(connector.poll(new Date(0))).rejects.toThrow(
      /iMessage poll failed for 1 query covering 1 configured chat; last error:/
    );
    await expect(connector.healthCheck()).resolves.toMatchObject({ healthy: false });
    await connector.dispose();
  });

  it('describes Full Disk Access for the daemon process', () => {
    const connector = new IMessageConnector(makeConfig(), databasePath, 'darwin');
    expect(connector.getAuthRequirements()[0]?.description).toContain('daemon process');
  });
});
