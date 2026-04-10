/**
 * Kagemusha Query Tools — progressive exploration of business data.
 *
 * Like a coding agent explores code (grep → read file → follow import),
 * these tools let agents explore business data:
 *   entities (rooms) → tasks → messages (raw data)
 *
 * The raw data stays in Kagemusha's DB, queried on demand.
 */

import { homedir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';

import Database from '../../sqlite.js';
import type { SQLiteDatabase } from '../../sqlite.js';

let db: SQLiteDatabase | null = null;

function getDB(): SQLiteDatabase {
  if (db) return db;
  const dbPath = join(homedir(), '.kagemusha', 'kagemusha.db');
  if (!existsSync(dbPath)) {
    throw new Error(`Kagemusha DB not found: ${dbPath}`);
  }
  db = new Database(dbPath);
  return db;
}

export interface EntityProfile {
  id: string;
  name: string;
  channel: string; // kakao, slack, chatwork, etc.
  type: string; // dm, group
  totalMessages: number;
  recentMessages: number; // last 30 days
  activeTasks: number;
  totalTasks: number;
  lastActive: string; // ISO date
}

export interface TaskInfo {
  id: number;
  title: string;
  status: string;
  priority: string;
  deadline: string | null;
  sourceRoom: string | null;
  createdAt: string;
}

export interface MessageInfo {
  id: number;
  channel: string;
  channelId: string;
  author: string;
  role: string;
  content: string;
  timestamp: string;
}

/**
 * List all entities (people, project channels) with activity stats.
 * This is the "file tree" — the starting point for exploration.
 */
export function listEntities(options?: {
  channel?: string; // filter by platform (kakao, slack, chatwork, etc.)
  activeOnly?: boolean; // only entities with recent activity
  limit?: number;
}): EntityProfile[] {
  const d = getDB();
  const limit = options?.limit ?? 50;
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  let roomQuery = 'SELECT id, name, channel, type, last_active FROM rooms';
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (options?.channel) {
    conditions.push('channel = ?');
    params.push(options.channel);
  }
  if (options?.activeOnly) {
    conditions.push('last_active > ?');
    params.push(thirtyDaysAgo);
  }

  if (conditions.length > 0) {
    roomQuery += ' WHERE ' + conditions.join(' AND ');
  }
  roomQuery += ' ORDER BY last_active DESC LIMIT ?';
  params.push(limit);

  const rooms = d.prepare(roomQuery).all(...params) as Array<{
    id: string;
    name: string;
    channel: string;
    type: string;
    last_active: number;
  }>;

  return rooms.map((room) => {
    const totalMessages = (
      d
        .prepare('SELECT COUNT(*) as cnt FROM channel_messages WHERE channel_id = ?')
        .get(room.id) as {
        cnt: number;
      }
    ).cnt;

    const recentMessages = (
      d
        .prepare(
          'SELECT COUNT(*) as cnt FROM channel_messages WHERE channel_id = ? AND created_at > ?'
        )
        .get(room.id, thirtyDaysAgo) as { cnt: number }
    ).cnt;

    let totalTasks = 0;
    let activeTasks = 0;
    try {
      totalTasks = (
        d.prepare('SELECT COUNT(*) as cnt FROM tasks WHERE source_room = ?').get(room.id) as {
          cnt: number;
        }
      ).cnt;
      activeTasks = (
        d
          .prepare(
            "SELECT COUNT(*) as cnt FROM tasks WHERE source_room = ? AND status IN ('pending','in_progress')"
          )
          .get(room.id) as { cnt: number }
      ).cnt;
    } catch {
      /* tasks table may not exist */
    }

    return {
      id: room.id,
      name: room.name || room.id,
      channel: room.channel,
      type: room.type,
      totalMessages,
      recentMessages,
      activeTasks,
      totalTasks,
      lastActive: new Date(room.last_active).toISOString(),
    };
  });
}

/**
 * Get tasks for a specific entity or all tasks matching a filter.
 * This is "reading type definitions" — structured state.
 */
export function queryTasks(options?: {
  sourceRoom?: string; // filter by source room ID
  status?: string; // pending, in_progress, done, completed, dismissed
  priority?: string; // urgent, high, normal, low
  search?: string; // text search in title
  limit?: number;
}): TaskInfo[] {
  const d = getDB();
  const limit = options?.limit ?? 30;
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options?.sourceRoom) {
    conditions.push('source_room = ?');
    params.push(options.sourceRoom);
  }
  if (options?.status) {
    conditions.push('status = ?');
    params.push(options.status);
  }
  if (options?.priority) {
    conditions.push('priority = ?');
    params.push(options.priority);
  }
  if (options?.search) {
    conditions.push('title LIKE ?');
    params.push(`%${options.search}%`);
  }

  let query = 'SELECT id, title, status, priority, deadline, source_room, created_at FROM tasks';
  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  query +=
    ' ORDER BY CASE WHEN deadline IS NOT NULL THEN deadline ELSE 9999999999999 END ASC LIMIT ?';
  params.push(limit);

  const rows = d.prepare(query).all(...params) as Array<{
    id: number;
    title: string;
    status: string;
    priority: string;
    deadline: number | null;
    source_room: string | null;
    created_at: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    deadline: row.deadline ? new Date(row.deadline).toISOString().split('T')[0] : null,
    sourceRoom: row.source_room,
    createdAt: new Date(row.created_at).toISOString().split('T')[0],
  }));
}

/**
 * Get messages from a specific channel within a time range.
 * This is "reading the source file" — the raw data.
 */
export function queryMessages(options: {
  channelId: string;
  since?: string; // ISO date, default: 7 days ago
  limit?: number;
  search?: string; // text search in content
}): MessageInfo[] {
  const d = getDB();
  const limit = options.limit ?? 50;
  const sinceMs = options.since
    ? new Date(options.since).getTime()
    : Date.now() - 7 * 24 * 60 * 60 * 1000;

  const conditions = ['channel_id = ?', 'created_at > ?'];
  const params: unknown[] = [options.channelId, sinceMs];

  if (options.search) {
    conditions.push('content LIKE ?');
    params.push(`%${options.search}%`);
  }

  const query = `SELECT id, channel, channel_id, user_id, role, content, created_at
    FROM channel_messages
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);

  const rows = d.prepare(query).all(...params) as Array<{
    id: number;
    channel: string;
    channel_id: string;
    user_id: string;
    role: string;
    content: string;
    created_at: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    channel: row.channel,
    channelId: row.channel_id,
    author: row.user_id,
    role: row.role,
    content: row.content,
    timestamp: new Date(row.created_at).toISOString(),
  }));
}

/**
 * Get a summary overview — entity counts, task stats, message volume.
 * Like `ls -la` at the root of a codebase.
 */
export function getOverview(): {
  rooms: { total: number; byChannel: Record<string, number> };
  tasks: { total: number; byStatus: Record<string, number> };
  messages: { total: number; recent30d: number };
} {
  const d = getDB();

  const totalRooms = (d.prepare('SELECT COUNT(*) as cnt FROM rooms').get() as { cnt: number }).cnt;
  const roomsByChannel: Record<string, number> = {};
  for (const row of d
    .prepare('SELECT channel, COUNT(*) as cnt FROM rooms GROUP BY channel')
    .all() as Array<{ channel: string; cnt: number }>) {
    roomsByChannel[row.channel] = row.cnt;
  }

  let totalTasks = 0;
  const tasksByStatus: Record<string, number> = {};
  try {
    totalTasks = (d.prepare('SELECT COUNT(*) as cnt FROM tasks').get() as { cnt: number }).cnt;
    for (const row of d
      .prepare('SELECT status, COUNT(*) as cnt FROM tasks GROUP BY status')
      .all() as Array<{ status: string; cnt: number }>) {
      tasksByStatus[row.status] = row.cnt;
    }
  } catch {
    /* tasks table may not exist */
  }

  const totalMessages = (
    d.prepare('SELECT COUNT(*) as cnt FROM channel_messages').get() as { cnt: number }
  ).cnt;
  const recent30d = (
    d
      .prepare('SELECT COUNT(*) as cnt FROM channel_messages WHERE created_at > ?')
      .get(Date.now() - 30 * 24 * 60 * 60 * 1000) as { cnt: number }
  ).cnt;

  return {
    rooms: { total: totalRooms, byChannel: roomsByChannel },
    tasks: { total: totalTasks, byStatus: tasksByStatus },
    messages: { total: totalMessages, recent30d },
  };
}

/** Clean up DB connection */
export function dispose(): void {
  if (db) {
    db.close();
    db = null;
  }
}
