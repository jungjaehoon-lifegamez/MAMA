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

interface KagemushaTask {
  id: number;
  title: string;
  status: string;
  priority: string;
  deadline: number | null;
  source_room: string | null;
  auto_created: number;
  confirmed: number;
  created_at: number;
  updated_at: number;
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

    // 1. Channel messages (existing)
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
            rawConnector: 'kagemusha',
            userId: row.user_id,
            role: row.role,
          },
        });
      }
    } catch (err) {
      hadError = true;
      this.lastError = err instanceof Error ? err.message : String(err);
    }

    // 2. Tasks (new) — include updated tasks since last poll
    try {
      const sinceMs = since.getTime();
      const tasks = this.db
        .prepare(`SELECT * FROM tasks WHERE updated_at > ? ORDER BY updated_at ASC LIMIT 500`)
        .all(sinceMs) as KagemushaTask[];

      for (const task of tasks) {
        const deadline = task.deadline
          ? new Date(task.deadline).toISOString().split('T')[0]
          : 'none';
        const content = `[Task] ${task.title} | status:${task.status} | priority:${task.priority} | deadline:${deadline}`;
        items.push({
          source: 'kagemusha-tasks',
          sourceId: `task:${task.id}`,
          channel: task.source_room || 'system',
          author: 'kagemusha',
          content,
          timestamp: new Date(task.updated_at),
          type: 'kanban_card',
          metadata: {
            taskId: task.id,
            status: task.status,
            priority: task.priority,
            deadline: task.deadline,
            sourceRoom: task.source_room,
            rawConnector: 'kagemusha',
            autoCreated: task.auto_created === 1,
          },
        });
      }
    } catch {
      // tasks table may not exist in older Kagemusha versions — non-fatal
    }

    this.lastPollTime = new Date();
    this.lastPollCount = items.length;
    if (!hadError) this.lastError = undefined;

    return items;
  }

  /**
   * Bulk poll: read ALL messages from a given start date, no limit.
   * Used for historical ingest, not regular polling.
   * Yields batches to avoid memory pressure on large datasets.
   */
  async *pollBulk(since: Date, batchSize = 5000): AsyncGenerator<NormalizedItem[], void, void> {
    if (!this.db) throw new Error('KagemushaConnector not initialized');

    let offset = 0;
    const sinceMs = since.getTime();

    while (true) {
      const rows = this.db
        .prepare(
          `SELECT * FROM channel_messages WHERE created_at > ? ORDER BY created_at ASC LIMIT ? OFFSET ?`
        )
        .all(sinceMs, batchSize, offset) as ChannelMessage[];

      if (rows.length === 0) break;

      const items: NormalizedItem[] = rows.map((row) => ({
        source: row.channel,
        sourceId: `${row.channel_id}:${row.id}`,
        channel: row.channel_id,
        author: row.user_id,
        content: row.content,
        timestamp: new Date(Number(row.created_at)),
        type: 'message' as const,
        metadata: {
          channel: row.channel,
          channelId: row.channel_id,
          rawConnector: 'kagemusha',
          userId: row.user_id,
          role: row.role,
        },
      }));

      yield items;
      offset += batchSize;

      if (rows.length < batchSize) break;
    }

    // Also yield all tasks
    try {
      const tasks = this.db
        .prepare(`SELECT * FROM tasks ORDER BY updated_at ASC`)
        .all() as KagemushaTask[];

      if (tasks.length > 0) {
        yield tasks.map((task) => {
          const deadline = task.deadline
            ? new Date(task.deadline).toISOString().split('T')[0]
            : 'none';
          return {
            source: 'kagemusha-tasks',
            sourceId: `task:${task.id}`,
            channel: task.source_room || 'system',
            author: 'kagemusha',
            content: `[Task] ${task.title} | status:${task.status} | priority:${task.priority} | deadline:${deadline}`,
            timestamp: new Date(task.updated_at),
            type: 'kanban_card' as const,
            metadata: {
              taskId: task.id,
              status: task.status,
              priority: task.priority,
              deadline: task.deadline,
              sourceRoom: task.source_room,
              rawConnector: 'kagemusha',
              autoCreated: task.auto_created === 1,
            },
          };
        });
      }
    } catch {
      // tasks table may not exist
    }
  }

  /** Get total counts for progress reporting */
  async getCounts(): Promise<{ messages: number; tasks: number; rooms: number }> {
    if (!this.db) return { messages: 0, tasks: 0, rooms: 0 };
    const messages = (
      this.db.prepare('SELECT COUNT(*) as cnt FROM channel_messages').get() as { cnt: number }
    ).cnt;
    let tasks = 0;
    try {
      tasks = (this.db.prepare('SELECT COUNT(*) as cnt FROM tasks').get() as { cnt: number }).cnt;
    } catch {
      /* table may not exist */
    }
    let rooms = 0;
    try {
      rooms = (this.db.prepare('SELECT COUNT(*) as cnt FROM rooms').get() as { cnt: number }).cnt;
    } catch {
      /* table may not exist */
    }
    return { messages, tasks, rooms };
  }
}
