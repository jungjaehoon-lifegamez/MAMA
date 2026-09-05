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

/** Test seam: point the read tools at an isolated in-memory database. */
export function setKagemushaDbForTest(instance: SQLiteDatabase | null): void {
  db = instance;
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
  // Validate BEFORE any DB access: new Date("24h ago") is NaN, and a NaN bind
  // makes `created_at > ?` silently match zero rows (empty-success). Fail loud.
  let sinceMs: number;
  // Treat a JSON null (common in LLM-produced payloads) as absent -
  // new Date(null) would otherwise parse to epoch 0 and match ALL history.
  if (options.since !== undefined && options.since !== null) {
    sinceMs = new Date(options.since).getTime();
    if (Number.isNaN(sinceMs)) {
      throw new Error(
        `since must be an ISO-8601 date/timestamp (got "${options.since}"); phrases like "24h ago" are not parseable`
      );
    }
  } else {
    sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
  }
  const d = getDB();
  const limit = options.limit ?? 50;

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

/** Progressive page bounds shared by kagemusha_messages (Task C). */
const MESSAGES_DEFAULT_LIMIT = 25;
const MESSAGES_MAX_LIMIT = 50;
const CONTENT_DEFAULT_LIMIT = 2000;
const CONTENT_MAX_LIMIT = 4000;

export interface MessageContentWindow {
  value: string;
  /** Unicode code-point offset this window starts at. */
  offset: number;
  limit: number;
  /** Total content length in Unicode code points. */
  total: number;
  nextOffset: number | null;
  complete: boolean;
}

export interface MessagePageRecord {
  id: number;
  channel: string;
  channelId: string;
  author: string;
  role: string;
  /** Whole message record; long content is a reachable code-point window, never a hidden slice. */
  content: MessageContentWindow;
  timestamp: string;
}

export interface MessagesPage {
  messages: MessagePageRecord[];
  total: number;
  returned: number;
  nextCursor: string | null;
  observedAt: string;
  /**
   * Append-only upper bound: this page and its continuation only see rows with
   * id <= asOfId, so later inserts never shift the traversal. It is NOT an
   * immutable snapshot - edits or deletes to existing rows are not frozen.
   */
  snapshot: { asOfId: number; note: string };
}

interface MessagesCursor {
  v: 1;
  /** The scope is FROZEN into the cursor - including an implicit default `since` -
   *  so a continuation reuses the exact bounds page 1 used. A later clock tick
   *  cannot silently redefine the query. */
  channelId: string;
  sinceMs: number;
  beforeMs: number | null;
  search: string | null;
  asOfId: number;
  lastCreatedAt: number;
  lastId: number;
}

function strictMs(value: string, field: string): number {
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) {
    throw new Error(
      `${field} must be an ISO-8601 date/timestamp (got "${value}"); phrases like "24h ago" are not parseable`
    );
  }
  return ms;
}

interface ResolvedScope {
  channelId: string;
  sinceMs: number;
  beforeMs: number | null;
  search: string | null;
}

/**
 * Resolve the effective (channel, time, search) scope, freezing an implicit
 * default `since` when there is no cursor. On a continuation the cursor's frozen
 * bounds win, and an EXPLICITLY supplied filter that disagrees with them is
 * rejected - an omitted filter simply inherits the frozen value, so a later clock
 * tick can no longer turn "same query, next page" into a different-query error.
 */
function resolveScope(
  options: { channelId: string; since?: string | null; before?: string | null; search?: string },
  cursor: MessagesCursor | null
): ResolvedScope {
  const explicitSince =
    options.since !== undefined && options.since !== null ? strictMs(options.since, 'since') : null;
  const explicitBefore =
    options.before !== undefined && options.before !== null
      ? strictMs(options.before, 'before')
      : null;
  const explicitSearch = options.search !== undefined ? options.search : null;
  if (cursor) {
    if (cursor.channelId !== options.channelId) {
      throw scopeChangeError();
    }
    if (explicitSince !== null && explicitSince !== cursor.sinceMs) throw scopeChangeError();
    if (
      options.before !== undefined &&
      options.before !== null &&
      explicitBefore !== cursor.beforeMs
    ) {
      throw scopeChangeError();
    }
    if (options.search !== undefined && explicitSearch !== cursor.search) throw scopeChangeError();
    return {
      channelId: cursor.channelId,
      sinceMs: cursor.sinceMs,
      beforeMs: cursor.beforeMs,
      search: cursor.search,
    };
  }
  return {
    channelId: options.channelId,
    sinceMs: explicitSince ?? Date.now() - 7 * 24 * 60 * 60 * 1000,
    beforeMs: explicitBefore,
    search: explicitSearch,
  };
}

function scopeChangeError(): Error {
  return new Error(
    'kagemusha_messages cursor belongs to a different query (channel/time/search changed); restart the read.'
  );
}

function scopeSql(scope: ResolvedScope): { where: string[]; params: unknown[] } {
  const where = ['channel_id = ?', 'created_at > ?'];
  const params: unknown[] = [scope.channelId, scope.sinceMs];
  if (scope.beforeMs !== null) {
    where.push('created_at <= ?');
    params.push(scope.beforeMs);
  }
  if (scope.search !== null) {
    where.push('content LIKE ?');
    params.push(`%${scope.search}%`);
  }
  return { where, params };
}

function contentWindow(source: string, offset: number, limit: number): MessageContentWindow {
  const points = Array.from(source);
  const start = Math.min(offset, points.length);
  const slice = points.slice(start, start + limit);
  const end = start + slice.length;
  const nextOffset = end < points.length ? end : null;
  return {
    value: slice.join(''),
    offset,
    limit,
    total: points.length,
    nextOffset,
    complete: nextOffset === null,
  };
}

/**
 * Progressive, bounded read of one channel's messages, newest first. Adds a
 * (created_at, id) keyset cursor over an append-only asOf upper bound, honest
 * total/returned/nextCursor, and strict time validation. An unknown channel is a
 * loud missing-source error, never an empty success; an empty nextCursor means
 * the END of this channel's scoped matches, not that all channels were read.
 */
export function queryMessagesPage(options: {
  channelId: string;
  since?: string | null;
  before?: string | null;
  search?: string;
  limit?: number;
  cursor?: string;
  messageId?: number;
  content_offset?: number;
  content_limit?: number;
}): MessagesPage {
  if (!options.channelId || typeof options.channelId !== 'string') {
    throw new Error('kagemusha_messages requires channelId');
  }
  if (options.limit !== undefined) {
    if (
      !Number.isInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > MESSAGES_MAX_LIMIT
    ) {
      throw new Error(
        `kagemusha_messages limit must be an integer from 1 to ${MESSAGES_MAX_LIMIT}.`
      );
    }
  }
  const limit = options.limit ?? MESSAGES_DEFAULT_LIMIT;
  const contentOffset = options.content_offset ?? 0;
  if (!Number.isInteger(contentOffset) || contentOffset < 0) {
    throw new Error('kagemusha_messages content_offset must be a non-negative integer.');
  }
  const contentLimit = options.content_limit ?? CONTENT_DEFAULT_LIMIT;
  if (!Number.isInteger(contentLimit) || contentLimit < 1 || contentLimit > CONTENT_MAX_LIMIT) {
    throw new Error(
      `kagemusha_messages content_limit must be an integer from 1 to ${CONTENT_MAX_LIMIT}.`
    );
  }

  const d = getDB();
  // Missing-source: an unknown channel is an explicit error, not empty success.
  const known = d.prepare('SELECT 1 FROM rooms WHERE id = ?').get(options.channelId) as
    | { 1: number }
    | undefined;
  if (!known) {
    throw new Error(`kagemusha_messages: unknown channel/source "${options.channelId}"`);
  }

  const cursor = options.cursor !== undefined ? decodeMessagesCursor(options.cursor) : null;
  const scope = resolveScope(options, cursor);
  const { where: baseWhere, params: baseParams } = scopeSql(scope);

  // Single-message selection: read ONE long message across content offsets without
  // returning its peers. It is bound to the SAME channel/time/search scope, so a
  // foreign id or one outside the scope is a generic not-found - never disclosed.
  if (options.messageId !== undefined) {
    if (!Number.isInteger(options.messageId) || options.messageId < 1) {
      throw new Error('kagemusha_messages messageId must be a positive integer.');
    }
    const row = d
      .prepare(
        `SELECT id, channel, channel_id, user_id, role, content, created_at
         FROM channel_messages
         WHERE ${baseWhere.join(' AND ')} AND id = ?`
      )
      .get(...baseParams, options.messageId) as
      | {
          id: number;
          channel: string;
          channel_id: string;
          user_id: string;
          role: string;
          content: string;
          created_at: number;
        }
      | undefined;
    if (!row) {
      throw new Error(
        `kagemusha_messages: message ${options.messageId} is not in this channel/time/search scope`
      );
    }
    return {
      messages: [
        {
          id: row.id,
          channel: row.channel,
          channelId: row.channel_id,
          author: row.user_id,
          role: row.role,
          content: contentWindow(row.content, contentOffset, contentLimit),
          timestamp: new Date(row.created_at).toISOString(),
        },
      ],
      total: 1,
      returned: 1,
      nextCursor: null,
      observedAt: new Date().toISOString(),
      snapshot: {
        asOfId: row.id,
        note: 'single selected message; content is paged by content_offset/content_limit',
      },
    };
  }

  // Bind the append-only upper id: the cursor pins the first page's asOfId; a
  // first page captures the current MAX(id) of the scoped set.
  const asOfId =
    cursor?.asOfId ??
    (
      d
        .prepare(
          `SELECT COALESCE(MAX(id), 0) AS m FROM channel_messages WHERE ${baseWhere.join(' AND ')}`
        )
        .get(...baseParams) as { m: number }
    ).m;

  const total = (
    d
      .prepare(
        `SELECT COUNT(*) AS c FROM channel_messages WHERE ${baseWhere.join(' AND ')} AND id <= ?`
      )
      .get(...baseParams, asOfId) as { c: number }
  ).c;

  const pageWhere = [...baseWhere, 'id <= ?'];
  const pageParams = [...baseParams, asOfId];
  if (cursor) {
    pageWhere.push('(created_at < ? OR (created_at = ? AND id < ?))');
    pageParams.push(cursor.lastCreatedAt, cursor.lastCreatedAt, cursor.lastId);
  }

  const rows = d
    .prepare(
      `SELECT id, channel, channel_id, user_id, role, content, created_at
       FROM channel_messages
       WHERE ${pageWhere.join(' AND ')}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`
    )
    .all(...pageParams, limit + 1) as Array<{
    id: number;
    channel: string;
    channel_id: string;
    user_id: string;
    role: string;
    content: string;
    created_at: number;
  }>;

  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const last = pageRows[pageRows.length - 1];
  return {
    messages: pageRows.map((row) => ({
      id: row.id,
      channel: row.channel,
      channelId: row.channel_id,
      author: row.user_id,
      role: row.role,
      content: contentWindow(row.content, contentOffset, contentLimit),
      timestamp: new Date(row.created_at).toISOString(),
    })),
    total,
    returned: pageRows.length,
    nextCursor:
      hasMore && last
        ? encodeMessagesCursor({
            v: 1,
            channelId: scope.channelId,
            sinceMs: scope.sinceMs,
            beforeMs: scope.beforeMs,
            search: scope.search,
            asOfId,
            lastCreatedAt: last.created_at,
            lastId: last.id,
          })
        : null,
    observedAt: new Date().toISOString(),
    snapshot: {
      asOfId,
      note: 'append-only upper bound: later inserts are excluded; edits/deletes to existing rows are NOT frozen',
    },
  };
}

function encodeMessagesCursor(payload: MessagesCursor): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeMessagesCursor(raw: unknown): MessagesCursor {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) {
    throw new Error('kagemusha_messages cursor is malformed; restart the read.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new Error('kagemusha_messages cursor is malformed; restart the read.');
  }
  const cursor = parsed as MessagesCursor;
  if (
    !cursor ||
    typeof cursor !== 'object' ||
    cursor.v !== 1 ||
    typeof cursor.channelId !== 'string' ||
    !Number.isSafeInteger(cursor.sinceMs) ||
    !(cursor.beforeMs === null || Number.isSafeInteger(cursor.beforeMs)) ||
    !(cursor.search === null || typeof cursor.search === 'string') ||
    !Number.isSafeInteger(cursor.asOfId) ||
    !Number.isSafeInteger(cursor.lastCreatedAt) ||
    !Number.isSafeInteger(cursor.lastId)
  ) {
    throw new Error('kagemusha_messages cursor is malformed; restart the read.');
  }
  return cursor;
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
