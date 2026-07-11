/**
 * TaskLedger - the operator-owned native work-item ledger (M8 Task 0.1).
 *
 * Ports the SHAPE of Kagemusha's proven task store (11 columns: id/title/status/
 * priority/deadline/source/auto_created/confirmed/timestamps) plus `assignee`
 * and an idempotency key. Implements the pre-existing `TaskSource` interface
 * (operator-interfaces.ts) so the board projects ONE task model, not two.
 *
 * Reconcile runs create/update rows through the task_create/task_update gateway
 * tools; the pipeline board slot is a projection of `list({order:
 * 'deadline_priority'})`. The AGENT makes every judgment about what becomes a
 * task; this store only persists.
 *
 * Schema-extension note: CREATE TABLE IF NOT EXISTS is a no-op on existing
 * tables. Any post-ship column addition needs an explicit ALTER TABLE guarded
 * by a PRAGMA table_info check, added to runMigration().
 *
 * The db handle is SHARED with TriggerRegistry and owned by the caller
 * (start.ts opens and closes it once) - deliberately no close() here.
 */

import { createHash } from 'node:crypto';
import type { SQLiteDatabase } from '../sqlite.js';
import type { OperatorTask, TaskSource } from './operator-interfaces.js';

export const TASK_STATUSES = [
  'pending',
  'in_progress',
  'review',
  'blocked',
  'done',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ['high', 'normal', 'low'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** Extended record: satisfies OperatorTask (numeric deadline) and carries the ISO original. */
export interface TaskRecord extends OperatorTask {
  status: TaskStatus;
  priority: TaskPriority;
  /** ISO YYYY-MM-DD as stored; `deadline` (OperatorTask) is its UTC-midnight epoch ms. */
  deadlineIso: string | null;
  assignee: string | null;
  sourceChannel: string | null;
  sourceEventId: string | null;
  latestEvent: string | null;
  autoCreated: boolean;
  confirmed: boolean;
}

export interface CreateTaskInput {
  title: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assignee?: string;
  /** ISO YYYY-MM-DD */
  deadline?: string;
  /** channelKey: "<connector>:<channelId>" */
  source_channel?: string;
  /** Idempotency key from the connector event; duplicate (channel, event) UPSERTS. */
  source_event_id?: string;
  latest_event?: string;
  confirmed?: boolean;
}

export interface UpdateTaskInput {
  status?: TaskStatus;
  priority?: TaskPriority;
  assignee?: string | null;
  deadline?: string | null;
  latest_event?: string;
  confirmed?: boolean;
  title?: string;
}

export interface ListTasksFilter {
  status?: TaskStatus;
  channel?: string;
  search?: string;
  limit?: number;
  /** 'deadline_priority' = deadline asc NULLS LAST, then high>normal>low, then id. */
  order?: 'deadline_priority' | 'updated';
}

interface TaskRow {
  id: number;
  title: string;
  status: string;
  priority: string;
  assignee: string | null;
  deadline: string | null;
  source_channel: string | null;
  source_event_id: string | null;
  latest_event: string | null;
  auto_created: number;
  confirmed: number;
  created_at: number;
  updated_at: number;
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isoToEpochMs(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

function assertEnum(value: string, allowed: readonly string[], field: string): void {
  if (!allowed.includes(value)) {
    throw new Error(`${field} must be one of ${allowed.join('|')}, got: ${value}`);
  }
}

function assertIsoDate(value: string, field: string): void {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) {
    throw new Error(`${field} must be an ISO date (YYYY-MM-DD), got: ${value}`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const isRoundTrip =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  if (!isRoundTrip) {
    throw new Error(`${field} must be an ISO date (YYYY-MM-DD), got: ${value}`);
  }
}

function rowToRecord(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    title: row.title,
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    deadline: isoToEpochMs(row.deadline),
    deadlineIso: row.deadline,
    assignee: row.assignee,
    sourceChannel: row.source_channel,
    sourceEventId: row.source_event_id,
    latestEvent: row.latest_event,
    autoCreated: row.auto_created === 1,
    confirmed: row.confirmed === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class TaskLedger implements TaskSource {
  private db: SQLiteDatabase;

  constructor(db: SQLiteDatabase) {
    this.db = db;
    this.runMigration();
  }

  private runMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS operator_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','in_progress','review','blocked','done','cancelled')),
        priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('high','normal','low')),
        assignee TEXT,
        deadline TEXT,
        source_channel TEXT,
        source_event_id TEXT,
        latest_event TEXT,
        auto_created INTEGER NOT NULL DEFAULT 1,
        confirmed INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_operator_tasks_source
        ON operator_tasks(source_channel, source_event_id)
        WHERE source_event_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_operator_tasks_status ON operator_tasks(status);
      CREATE INDEX IF NOT EXISTS idx_operator_tasks_deadline ON operator_tasks(deadline);

      CREATE TABLE IF NOT EXISTS operator_no_update_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_operator_no_update_scope
        ON operator_no_update_notes(scope, id);
    `);
  }

  /** TaskSource conformance: open items in canonical board order. */
  getTasks(): OperatorTask[] {
    return this.list({ order: 'deadline_priority' });
  }

  list(filter: ListTasksFilter = {}): TaskRecord[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    if (filter.channel) {
      where.push('source_channel = ?');
      params.push(filter.channel);
    }
    if (filter.search) {
      where.push('(title LIKE ? OR latest_event LIKE ? OR assignee LIKE ?)');
      const like = `%${filter.search}%`;
      params.push(like, like, like);
    }
    const order =
      filter.order === 'updated'
        ? 'updated_at DESC, id DESC'
        : // deadline asc NULLS LAST, then priority high>normal>low, then id.
          // LIMIT applies AFTER ordering so the true top-N is returned.
          `CASE WHEN deadline IS NULL THEN 1 ELSE 0 END ASC, deadline ASC,
           CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END ASC, id ASC`;
    const rawLimit = Number(filter.limit);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, Math.floor(rawLimit))) : 50;
    const rows = this.db
      .prepare(
        `SELECT * FROM operator_tasks
         ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY ${order}
         LIMIT ?`
      )
      .all(...params, limit) as TaskRow[];
    return rows.map(rowToRecord);
  }

  getById(id: number): TaskRecord | null {
    const row = this.db.prepare(`SELECT * FROM operator_tasks WHERE id = ?`).get(id) as
      | TaskRow
      | undefined;
    return row ? rowToRecord(row) : null;
  }

  /**
   * Create a task. Idempotent under at-least-once delivery: a duplicate
   * (source_channel, source_event_id) UPSERTS - the existing row gets the new
   * latest_event (and title stays) instead of a near-duplicate row appearing.
   */
  create(input: CreateTaskInput): TaskRecord {
    if (!input.title || input.title.trim() === '') {
      throw new Error('task title must be a non-empty string');
    }
    if (input.status !== undefined) assertEnum(input.status, TASK_STATUSES, 'status');
    if (input.priority !== undefined) assertEnum(input.priority, TASK_PRIORITIES, 'priority');
    if (input.deadline !== undefined) assertIsoDate(input.deadline, 'deadline');
    const now = Date.now();

    if (input.source_channel && input.source_event_id) {
      const existing = this.db
        .prepare(`SELECT * FROM operator_tasks WHERE source_channel = ? AND source_event_id = ?`)
        .get(input.source_channel, input.source_event_id) as TaskRow | undefined;
      if (existing) {
        // Upsert carries every provided field EXCEPT title (the original naming
        // stays stable across retries; movement and state updates flow through).
        return this.update(existing.id, {
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(input.assignee !== undefined ? { assignee: input.assignee } : {}),
          ...(input.deadline !== undefined ? { deadline: input.deadline } : {}),
          ...(input.confirmed !== undefined ? { confirmed: input.confirmed } : {}),
          ...(input.latest_event !== undefined ? { latest_event: input.latest_event } : {}),
        });
      }
    }

    const result = this.db
      .prepare(
        `INSERT INTO operator_tasks
           (title, status, priority, assignee, deadline, source_channel, source_event_id,
            latest_event, auto_created, confirmed, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.title.trim(),
        input.status ?? 'pending',
        input.priority ?? 'normal',
        input.assignee ?? null,
        input.deadline ?? null,
        input.source_channel ?? null,
        input.source_event_id ?? null,
        input.latest_event ?? null,
        1,
        input.confirmed ? 1 : 0,
        now,
        now
      );
    const created = this.getById(Number(result.lastInsertRowid));
    if (!created) throw new Error('task_create: inserted row could not be read back');
    return created;
  }

  update(id: number, patch: UpdateTaskInput): TaskRecord {
    const existing = this.getById(id);
    if (!existing) throw new Error(`task_update: no task with id ${id}`);
    if (patch.status !== undefined) assertEnum(patch.status, TASK_STATUSES, 'status');
    if (patch.priority !== undefined) assertEnum(patch.priority, TASK_PRIORITIES, 'priority');
    if (patch.deadline !== undefined && patch.deadline !== null) {
      assertIsoDate(patch.deadline, 'deadline');
    }
    if (patch.title !== undefined && patch.title.trim() === '') {
      throw new Error('task title must be a non-empty string');
    }

    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [Date.now()];
    const assign = (column: string, value: unknown) => {
      sets.push(`${column} = ?`);
      params.push(value);
    };
    if (patch.title !== undefined) assign('title', patch.title.trim());
    if (patch.status !== undefined) assign('status', patch.status);
    if (patch.priority !== undefined) assign('priority', patch.priority);
    if (patch.assignee !== undefined) assign('assignee', patch.assignee);
    if (patch.deadline !== undefined) assign('deadline', patch.deadline);
    if (patch.latest_event !== undefined) assign('latest_event', patch.latest_event);
    if (patch.confirmed !== undefined) assign('confirmed', patch.confirmed ? 1 : 0);

    this.db.prepare(`UPDATE operator_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    return this.getById(id)!;
  }

  /** Stable hash over ordered rows - the Phase-2 verifier's ledger snapshot. */
  payloadHash(): string {
    const rows = this.db
      .prepare(
        `SELECT id, title, status, priority, assignee, deadline, latest_event, confirmed,
                updated_at
         FROM operator_tasks ORDER BY id ASC`
      )
      .all() as Array<Record<string, unknown>>;
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  }

  /** contract_no_update: silence as a verifiable judgment, scoped to one reconcile run. */
  recordNoUpdate(scope: string, reason: string): { id: number } {
    if (!scope || !reason) {
      throw new Error('contract_no_update requires both scope and reason');
    }
    const result = this.db
      .prepare(`INSERT INTO operator_no_update_notes (scope, reason, created_at) VALUES (?, ?, ?)`)
      .run(scope, reason, Date.now());
    return { id: Number(result.lastInsertRowid) };
  }

  /** Max no-update note id, optionally scoped - the verifier's note snapshot. */
  maxNoUpdateId(scope?: string): number {
    const row = (
      scope
        ? this.db
            .prepare(`SELECT MAX(id) AS max_id FROM operator_no_update_notes WHERE scope = ?`)
            .get(scope)
        : this.db.prepare(`SELECT MAX(id) AS max_id FROM operator_no_update_notes`).get()
    ) as { max_id: number | null };
    return row.max_id ?? 0;
  }
}
