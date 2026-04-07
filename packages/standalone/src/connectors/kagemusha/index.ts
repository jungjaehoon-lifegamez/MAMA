/**
 * KagemushaConnector — reads messages from the Kagemusha local SQLite database.
 * Queries channel_messages table for user messages newer than the given timestamp.
 * Uses the standalone's node:sqlite wrapper (Database from ../../sqlite.js).
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

interface ChannelMessage {
  id: number | string;
  channel: string;
  channel_id: string;
  user_id: string;
  role: string;
  content: string;
  created_at: string;
}

export class KagemushaConnector implements IConnector {
  readonly name = 'kagemusha';
  readonly type = 'local' as const;

  private db: SQLiteDatabase | null = null;
  private dbPath: string;
  private lastPollTime: Date | null = null;
  private lastPollCount = 0;
  private lastError: string | undefined = undefined;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_config: ConnectorConfig, dbPath?: string) {
    this.dbPath = dbPath ?? join(homedir(), '.kagemusha', 'kagemusha.db');
  }

  async init(): Promise<void> {
    try {
      this.db = new Database(this.dbPath);
    } catch (err) {
      throw new Error(
        `KagemushaConnector: failed to open database at ${this.dbPath}: ${err instanceof Error ? err.message : String(err)}`
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
          'No authentication required. Kagemusha database must exist at ~/.kagemusha/kagemusha.db.',
      },
    ];
  }

  async authenticate(): Promise<boolean> {
    return this.db !== null;
  }

  async poll(since: Date): Promise<NormalizedItem[]> {
    if (!this.db) throw new Error('KagemushaConnector not initialized');

    const items: NormalizedItem[] = [];
    let hadError = false;

    try {
      const sinceMs = since.getTime();
      const rows = this.db
        .prepare(
          `SELECT * FROM channel_messages WHERE created_at > ? AND role = 'user' ORDER BY created_at ASC LIMIT 5000`
        )
        .all(sinceMs) as ChannelMessage[];

      for (const row of rows) {
        items.push({
          source: row.channel,
          sourceId: `${row.channel_id}:${row.id}`,
          channel: row.channel_id,
          author: row.user_id,
          content: row.content,
          timestamp: new Date(Number(row.created_at)),
          type: 'message',
          metadata: {
            channel: row.channel,
            channelId: row.channel_id,
            userId: row.user_id,
            role: row.role,
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
