/**
 * iMessageConnector — reads messages from macOS iMessage SQLite database.
 * Queries ~/Library/Messages/chat.db for messages newer than the given timestamp.
 * Uses better-sqlite3 via the standalone's Database wrapper.
 *
 * iMessage timestamps use Core Data format: nanoseconds since 2001-01-01.
 * Conversion: unix_ms = (date / 1_000_000) + 978_307_200_000
 */

import { homedir } from 'os';
import { join } from 'path';

import Database from '../../sqlite.js';
import type { SQLiteDatabase } from '../../sqlite.js';

import type {
  AuthRequirement,
  ConnectorConfig,
  ConnectorHealth,
  IConnector,
  NormalizedItem,
} from '../framework/types.js';

interface MessageRow {
  ROWID: number;
  date: number;
  text: string;
  is_from_me: number;
  sender: string | null;
  chat_id: string | null;
  display_name: string | null;
}

export class IMessageConnector implements IConnector {
  readonly name = 'imessage';
  readonly type = 'local' as const;

  private db: SQLiteDatabase | null = null;
  private dbPath: string;
  private lastPollTime: Date | null = null;
  private lastPollCount = 0;
  private lastError: string | undefined = undefined;

  constructor(
    private config: ConnectorConfig,
    dbPath?: string
  ) {
    this.dbPath = dbPath ?? join(homedir(), 'Library', 'Messages', 'chat.db');
  }

  async init(): Promise<void> {
    if (this.getChatIds().length === 0) {
      throw new Error('iMessage requires explicitly configured chat identifiers');
    }
    try {
      // Messages owns chat.db; a missing one is an error, never a new empty database.
      this.db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
    } catch (err) {
      throw new Error(
        `iMessageConnector: failed to open database at ${this.dbPath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async dispose(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  async healthCheck(): Promise<ConnectorHealth> {
    return {
      healthy: this.db !== null && this.lastError === undefined,
      lastPollTime: this.lastPollTime,
      lastPollCount: this.lastPollCount,
      error: this.lastError,
    };
  }

  getAuthRequirements(): AuthRequirement[] {
    return [
      {
        type: 'none',
        description:
          'No authentication required. The daemon process needs Full Disk Access in System Settings > Privacy & Security.',
      },
    ];
  }

  async authenticate(): Promise<boolean> {
    return this.db !== null;
  }

  private getChatIds(): string[] {
    return Object.entries(this.config.channels)
      .filter(([, channel]) => channel.role !== 'ignore')
      .map(([chatId]) => chatId);
  }

  async poll(since: Date): Promise<NormalizedItem[]> {
    if (!this.db) throw new Error('iMessageConnector not initialized');
    const chatIds = this.getChatIds();
    if (chatIds.length === 0)
      throw new Error('iMessage requires explicitly configured chat identifiers');
    const items: NormalizedItem[] = [];
    try {
      // iMessage date is nanoseconds since 2001-01-01 (Core Data epoch).
      // Values exceed Number.MAX_SAFE_INTEGER, so we convert in SQL instead.
      // Unix seconds = date / 1_000_000_000 + 978_307_200
      const sinceUnixMs = since.getTime();

      const rows = this.db
        .prepare(
          `SELECT m.ROWID,
                  (m.date / 1000000 + 978307200000) as date,
                  m.text, m.is_from_me,
                  h.id as sender,
                  c.chat_identifier as chat_id,
                  c.display_name
           FROM message m
           LEFT JOIN handle h ON m.handle_id = h.ROWID
           LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
           LEFT JOIN chat c ON c.ROWID = cmj.chat_id
           WHERE (m.date / 1000000 + 978307200000) >= ?
             AND m.text IS NOT NULL AND m.text != ''
             AND c.chat_identifier IN (${chatIds.map(() => '?').join(', ')})
           ORDER BY m.date ASC`
        )
        .all(sinceUnixMs, ...chatIds) as MessageRow[];

      for (const row of rows) {
        // date is Unix milliseconds (converted in SQL), preserving the poll cursor precision.
        const unixMs = row.date;
        const author = row.is_from_me ? 'me' : (row.sender ?? 'unknown');
        if (row.chat_id === null || !chatIds.includes(row.chat_id)) continue;

        items.push({
          source: 'imessage',
          sourceId: `imessage:${row.ROWID}`,
          channel: row.chat_id,
          author,
          content: row.text,
          timestamp: new Date(unixMs),
          type: 'message',
          metadata: {
            isFromMe: row.is_from_me === 1,
            chatId: row.chat_id,
            sender: row.sender,
          },
        });
      }
    } catch (err) {
      const chatLabel = chatIds.length === 1 ? 'chat' : 'chats';
      this.lastError = `iMessage poll failed for 1 query covering ${chatIds.length} configured ${chatLabel}; last error: ${err instanceof Error ? err.message : String(err)}`;
      this.lastPollTime = new Date();
      this.lastPollCount = items.length;
      throw new Error(this.lastError, { cause: err });
    }

    this.lastPollTime = new Date();
    this.lastPollCount = items.length;
    this.lastError = undefined;

    return items;
  }
}
