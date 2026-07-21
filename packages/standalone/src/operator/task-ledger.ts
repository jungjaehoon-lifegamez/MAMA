/**
 * TaskLedger - the operator-owned native work-item ledger (M8 Task 0.1).
 *
 * Extends the shape of Kagemusha's proven task store with assignment,
 * idempotency, temporal scheduling, durable generation, effect receipt, and
 * workorder state. Implements the pre-existing `TaskSource` interface
 * (operator-interfaces.ts) so the board projects one task model, not two.
 *
 * Reconcile runs create/update rows through the task_create/task_update gateway
 * tools; the pipeline board slot is a projection of `list({order:
 * 'deadline_priority'})`. The agent proposes task changes, while this ledger
 * enforces revisions, temporal ownership, idempotency, and atomic receipts.
 *
 * Schema-extension note: CREATE TABLE IF NOT EXISTS is a no-op on existing
 * tables. Any post-ship column addition needs an explicit ALTER TABLE guarded
 * by a PRAGMA table_info check, added to runMigration().
 *
 * The db handle is SHARED with TriggerRegistry and owned by the caller
 * (start.ts opens and closes it once) - deliberately no close() here.
 */

import { createHash } from 'node:crypto';
import { applyOperatorTaskTemporalMigration } from '../db/migrations/operator-task-temporal.js';
import type { SQLiteDatabase } from '../sqlite.js';
import type { OperatorTask, TaskSource } from './operator-interfaces.js';
import {
  temporalNoUpdateScope,
  temporalReceiptInvariantError,
  type TemporalEffectReceipt,
  type TemporalEvidenceAttestation,
  type TemporalReconcileInput,
  type TemporalWorkContext,
} from './temporal-effect.js';
import {
  deriveTemporalState,
  occurrenceKeyForTask,
  parseExactDueAt,
  temporalGenerationKey,
  type TemporalState,
} from './task-temporal.js';

export const TASK_STATUSES = [
  'pending',
  'in_progress',
  'review',
  'blocked',
  'done',
  'cancelled',
  // System-only terminal for workorder rows. Owner rows can never reach it:
  // external create/update guards reject it, so it stays out of owner surfaces.
  'failed',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ['high', 'normal', 'low'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_KINDS = ['owner', 'system'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const WORKORDER_KINDS = ['board', 'wiki', 'memory-curation', 'temporal'] as const;
export type WorkOrderKind = (typeof WORKORDER_KINDS)[number];
export const TEMPORAL_WORKORDER_MAX_ATTEMPTS = 3;

/** source_channel namespace for workorder rows: 'workorder:<workKind>'. */
export const WORKORDER_CHANNEL_PREFIX = 'workorder:';

export interface EnqueueWorkOrderInput {
  workKind: WorkOrderKind;
  /** Per-occurrence idempotency key (schedule slot / event batch / manual ts). */
  idempotencyKey: string;
  /** Kind-specific payload; `attempts` is managed by the ledger (starts at 1). */
  input: Record<string, unknown>;
  priority?: TaskPriority;
}

export interface EnqueueTemporalGenerationInput {
  generationKey: string;
  taskId: number;
  temporalEpoch: number;
  occurrenceKey: string;
  checkAt: number;
  sourceChannel: string | null;
  sourceEventId: string | null;
  priority?: TaskPriority;
}

export interface WorkOrderRecord {
  id: number;
  workKind: WorkOrderKind;
  status: TaskStatus;
  priority: TaskPriority;
  idempotencyKey: string;
  /** Parsed payload; always carries `attempts` (>= 1). */
  payload: Record<string, unknown> & { attempts: number };
  createdAt: number;
  updatedAt: number;
}

/** Extended record: satisfies OperatorTask (numeric deadline) and carries the ISO original. */
export interface TaskRecord extends OperatorTask {
  status: TaskStatus;
  priority: TaskPriority;
  kind: TaskKind;
  /** ISO YYYY-MM-DD as stored; `deadline` (OperatorTask) is its UTC-midnight epoch ms. */
  deadlineIso: string | null;
  assignee: string | null;
  sourceChannel: string | null;
  sourceEventId: string | null;
  latestEvent: string | null;
  autoCreated: boolean;
  confirmed: boolean;
  dueAt: number | null;
  deadlineOffsetMinutes: number | null;
  revision: number;
  temporalEpoch: number;
  temporalReconciledOccurrenceKey: string | null;
  lastTemporalCheckedAt: number | null;
  nextTemporalCheckAt: number | null;
  lastTemporalAttemptId: number | null;
  temporalState: TemporalState;
}

export interface TaskLedgerOptions {
  now?: () => number;
  timeZone?: string;
}

export type TemporalGenerationDisposition =
  | 'active'
  | 'resolved'
  | 'final_no_update'
  | 'deferred'
  | 'exhausted'
  | 'superseded';

export interface TemporalGenerationRecord {
  generationKey: string;
  taskId: number;
  temporalEpoch: number;
  occurrenceKey: string;
  checkAt: number;
  disposition: TemporalGenerationDisposition;
  lastWorkOrderId: number | null;
  reason: string | null;
  createdAt: number;
  updatedAt: number;
}

export type { TemporalWorkContext } from './temporal-effect.js';

export interface TemporalGenerationEnqueueResult {
  generation: TemporalGenerationRecord;
  workOrder: WorkOrderRecord;
  created: boolean;
}

/** Authoritative terminal-arbitration view for one temporal attempt. */
export interface TemporalAttemptState {
  workOrder: WorkOrderRecord;
  generation: TemporalGenerationRecord;
  receipt: TemporalEffectReceipt | null;
}

export type TemporalWorkFailureResult =
  | { disposition: 'requeued'; replacement: WorkOrderRecord; attempt: number; maxAttempts: number }
  | { disposition: 'exhausted'; attempt: number; maxAttempts: number }
  | { disposition: 'superseded'; attempt: number; maxAttempts: number };

export interface CreateTaskInput {
  title: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assignee?: string;
  /** ISO YYYY-MM-DD */
  deadline?: string;
  /** RFC 3339 with an explicit Z or numeric offset. */
  due_at?: string;
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
  /** RFC 3339 with an explicit Z or numeric offset. */
  due_at?: string | null;
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
  kind: string;
  payload: string | null;
  assignee: string | null;
  deadline: string | null;
  source_channel: string | null;
  source_event_id: string | null;
  latest_event: string | null;
  auto_created: number;
  confirmed: number;
  due_at: number | null;
  deadline_offset_minutes: number | null;
  revision: number;
  temporal_epoch: number;
  temporal_reconciled_occurrence_key: string | null;
  last_temporal_checked_at: number | null;
  next_temporal_check_at: number | null;
  last_temporal_attempt_id: number | null;
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

function rowToRecord(row: TaskRow, now: number, timeZone: string): TaskRecord {
  return {
    id: row.id,
    title: row.title,
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    kind: (row.kind ?? 'owner') as TaskKind,
    deadline: isoToEpochMs(row.deadline),
    deadlineIso: row.deadline,
    assignee: row.assignee,
    sourceChannel: row.source_channel,
    sourceEventId: row.source_event_id,
    latestEvent: row.latest_event,
    autoCreated: row.auto_created === 1,
    confirmed: row.confirmed === 1,
    dueAt: row.due_at,
    deadlineOffsetMinutes: row.deadline_offset_minutes,
    revision: row.revision,
    temporalEpoch: row.temporal_epoch,
    temporalReconciledOccurrenceKey: row.temporal_reconciled_occurrence_key,
    lastTemporalCheckedAt: row.last_temporal_checked_at,
    nextTemporalCheckAt: row.next_temporal_check_at,
    lastTemporalAttemptId: row.last_temporal_attempt_id,
    temporalState: deriveTemporalState(
      {
        status: row.status,
        dueAt: row.due_at,
        deadlineIso: row.deadline,
        deadlineOffsetMinutes: row.deadline_offset_minutes,
      },
      now,
      timeZone
    ),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class TaskLedger implements TaskSource {
  private db: SQLiteDatabase;
  private now: () => number;
  private timeZone: string;

  constructor(db: SQLiteDatabase, options: TaskLedgerOptions = {}) {
    this.db = db;
    this.now = options.now ?? Date.now;
    this.timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    // Validate the injected or boot-resolved zone once, before reads depend on it.
    new Intl.DateTimeFormat('en-US', { timeZone: this.timeZone }).format(0);
    this.runMigration();
  }

  private toRecord(row: TaskRow): TaskRecord {
    return rowToRecord(row, this.now(), this.timeZone);
  }

  private runMigration(): void {
    // Both construction sites (start.ts boot + operator-handler lazy) run this;
    // busy_timeout here covers BOTH connections against the rebuild race.
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS operator_tasks (${TaskLedger.TABLE_COLUMNS_SQL});
      ${TaskLedger.INDEXES_SQL}

      CREATE TABLE IF NOT EXISTS operator_no_update_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_operator_no_update_scope
        ON operator_no_update_notes(scope, id);
    `);
    this.upgradeSchema();
    const foreignKeyViolations = this.db.pragma('foreign_key_check') as unknown[];
    if (foreignKeyViolations.length > 0) {
      throw new Error(
        `operator task migration found ${foreignKeyViolations.length} foreign key violation(s)`
      );
    }
  }

  /** Full current column set - single source for CREATE and the rebuild copy. */
  private static readonly TABLE_COLUMNS_SQL = `
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','in_progress','review','blocked','done','cancelled','failed')),
        priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('high','normal','low')),
        kind TEXT NOT NULL DEFAULT 'owner' CHECK (kind IN ('owner','system')),
        payload TEXT,
        assignee TEXT,
        deadline TEXT,
        source_channel TEXT,
        source_event_id TEXT,
        latest_event TEXT,
        auto_created INTEGER NOT NULL DEFAULT 1,
        confirmed INTEGER NOT NULL DEFAULT 0,
        due_at INTEGER,
        deadline_offset_minutes INTEGER
          CHECK (deadline_offset_minutes BETWEEN -840 AND 840),
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        temporal_epoch INTEGER NOT NULL DEFAULT 0 CHECK (temporal_epoch >= 0),
        temporal_reconciled_occurrence_key TEXT,
        last_temporal_checked_at INTEGER,
        next_temporal_check_at INTEGER,
        last_temporal_attempt_id INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL`;

  // Unique-index predicate excludes terminal rows so a terminal keyed workorder
  // frees its idempotency slot for a fresh insert (plan M1); owner upsert is a
  // SELECT probe, unaffected.
  private static readonly INDEXES_SQL = `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_operator_tasks_source
        ON operator_tasks(source_channel, source_event_id)
        WHERE source_event_id IS NOT NULL
          AND status NOT IN ('done','failed','cancelled');
      CREATE INDEX IF NOT EXISTS idx_operator_tasks_status ON operator_tasks(status);
      CREATE INDEX IF NOT EXISTS idx_operator_tasks_deadline ON operator_tasks(deadline);`;

  /**
   * Stage-2 in-place upgrade for pre-existing tables. Guards are re-checked
   * INSIDE `BEGIN IMMEDIATE`: two connections construct TaskLedger (boot +
   * lazy API handler) and both run this - the loser must see the winner's
   * finished work, not rebuild an already-migrated table.
   */
  private upgradeSchema(): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const cols = this.db.prepare(`PRAGMA table_info(operator_tasks)`).all() as Array<{
        name: string;
      }>;
      if (!cols.some((c) => c.name === 'kind')) {
        this.db.exec(
          `ALTER TABLE operator_tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'owner'
             CHECK (kind IN ('owner','system'))`
        );
      }
      if (!cols.some((c) => c.name === 'payload')) {
        this.db.exec(`ALTER TABLE operator_tasks ADD COLUMN payload TEXT`);
      }

      // 'failed' lives in an inline CHECK -> table rebuild (copy-swap) required.
      const tableSql = (
        this.db
          .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='operator_tasks'`)
          .get() as { sql: string }
      ).sql;
      if (!tableSql.includes(`'failed'`)) {
        const seqRow = this.db
          .prepare(`SELECT seq FROM sqlite_sequence WHERE name='operator_tasks'`)
          .get() as { seq: number } | undefined;
        this.db.exec(`
          CREATE TABLE operator_tasks_new (${TaskLedger.TABLE_COLUMNS_SQL});
          INSERT INTO operator_tasks_new
            (id, title, status, priority, kind, payload, assignee, deadline, source_channel,
             source_event_id, latest_event, auto_created, confirmed, created_at, updated_at)
            SELECT id, title, status, priority, kind, payload, assignee, deadline,
                   source_channel, source_event_id, latest_event, auto_created, confirmed,
                   created_at, updated_at
            FROM operator_tasks;
          DROP TABLE operator_tasks;
          ALTER TABLE operator_tasks_new RENAME TO operator_tasks;
        `);
        if (seqRow) {
          // sqlite_sequence has NO unique key on name - INSERT OR REPLACE
          // would APPEND a duplicate row (review m2). UPDATE first; insert
          // only when the rename left no row behind.
          const updated = this.db
            .prepare(`UPDATE sqlite_sequence SET seq = ? WHERE name = 'operator_tasks'`)
            .run(seqRow.seq);
          if (updated.changes === 0) {
            this.db
              .prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES ('operator_tasks', ?)`)
              .run(seqRow.seq);
          }
        }
      }

      applyOperatorTaskTemporalMigration(this.db);

      // Old-predicate unique index (no terminal exclusion) -> swap in place.
      const idxRow = this.db
        .prepare(
          `SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_operator_tasks_source'`
        )
        .get() as { sql: string } | undefined;
      if (!idxRow || !idxRow.sql.includes('status NOT IN')) {
        this.db.exec(`DROP INDEX IF EXISTS idx_operator_tasks_source;`);
      }
      this.db.exec(TaskLedger.INDEXES_SQL);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** TaskSource conformance: open items in canonical board order. */
  getTasks(): OperatorTask[] {
    return this.list({ order: 'deadline_priority' });
  }

  countOpenUnconfirmed(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM operator_tasks
         WHERE kind = 'owner'
           AND auto_created = 1
           AND confirmed = 0
           AND status NOT IN ('done', 'cancelled')`
      )
      .get() as { count: number };
    return row.count;
  }

  list(filter: ListTasksFilter = {}): TaskRecord[] {
    // Owner surface only - system workorder rows never appear in board/REST/
    // gateway listings (Stage-2 kind filter; workorders have dedicated readers).
    const where: string[] = [`kind = 'owner'`];
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
    return rows.map((row) => this.toRecord(row));
  }

  /** Internal bounded page for temporal reconciliation; excludes rows that can never be candidates. */
  listTemporalScanPage(input: { limit: number; afterId: number }): TaskRecord[] {
    const rawLimit = Number(input.limit);
    const rawAfterId = Number(input.afterId);
    const limit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(200, Math.floor(rawLimit)))
      : 200;
    const afterId = Number.isFinite(rawAfterId) ? Math.max(0, Math.floor(rawAfterId)) : 0;
    const rows = this.db
      .prepare(
        `SELECT * FROM operator_tasks INDEXED BY idx_operator_tasks_temporal_scan_id
         WHERE kind = 'owner'
           AND status IN ('pending','in_progress','review','blocked')
           AND id > ?
           AND (due_at IS NOT NULL OR deadline IS NOT NULL OR next_temporal_check_at IS NOT NULL)
         ORDER BY id ASC
         LIMIT ?`
      )
      .all(afterId, limit) as TaskRow[];
    return rows.map((row) => this.toRecord(row));
  }

  /** Owner rows only - system workorder rows are invisible to external reads. */
  getById(id: number): TaskRecord | null {
    const record = this.getRowById(id);
    return record && record.kind === 'owner' ? record : null;
  }

  /** Internal fetch without the kind filter (guards and workorder paths). */
  private getRowById(id: number): TaskRecord | null {
    const row = this.db.prepare(`SELECT * FROM operator_tasks WHERE id = ?`).get(id) as
      | TaskRow
      | undefined;
    return row ? this.toRecord(row) : null;
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
    if (input.status === 'failed') {
      throw new Error(`task_create: 'failed' is a system-only status`);
    }
    // Namespace reservation (review m3): the occurrence keys are deterministic
    // (epoch slots, readable from OSS source) - an agent-created owner row on
    // a 'workorder:' (channel,event) pair would collide with the system
    // INSERT via the shared unique index and DoS that schedule slot.
    if (input.source_channel?.startsWith(WORKORDER_CHANNEL_PREFIX)) {
      throw new Error(
        `task_create: source_channel namespace '${WORKORDER_CHANNEL_PREFIX}*' is reserved for system workorders`
      );
    }
    if (input.priority !== undefined) assertEnum(input.priority, TASK_PRIORITIES, 'priority');
    if (input.deadline !== undefined) assertIsoDate(input.deadline, 'deadline');
    const exactDue = input.due_at !== undefined ? parseExactDueAt(input.due_at) : null;
    if (exactDue && input.deadline !== undefined && input.deadline !== exactDue.deadline) {
      throw new Error('task_create: due_at and deadline conflict');
    }
    const normalizedDeadline = exactDue?.deadline ?? input.deadline ?? null;
    const initialTemporalEpoch = normalizedDeadline !== null ? 1 : 0;
    const now = this.now();

    if (input.source_channel && input.source_event_id) {
      // kind='owner' probe: an agent-supplied (channel, event) pair can never
      // reach a system workorder row (Stage-2 tamper guard).
      const existing = this.db
        .prepare(
          `SELECT * FROM operator_tasks
           WHERE source_channel = ? AND source_event_id = ? AND kind = 'owner'`
        )
        .get(input.source_channel, input.source_event_id) as TaskRow | undefined;
      if (existing) {
        // Duplicate source delivery uses the same mutation boundary, including
        // exact-time normalization and no-op detection. The original title stays
        // stable across retries for backward compatibility.
        return this.update(existing.id, {
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(input.assignee !== undefined ? { assignee: input.assignee } : {}),
          ...(input.deadline !== undefined ? { deadline: input.deadline } : {}),
          ...(input.due_at !== undefined ? { due_at: input.due_at } : {}),
          ...(input.confirmed !== undefined ? { confirmed: input.confirmed } : {}),
          ...(input.latest_event !== undefined ? { latest_event: input.latest_event } : {}),
        });
      }
    }

    const result = this.db
      .prepare(
        `INSERT INTO operator_tasks
           (title, status, priority, assignee, deadline, due_at, deadline_offset_minutes,
            revision, temporal_epoch, source_channel, source_event_id, latest_event,
            auto_created, confirmed, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.title.trim(),
        input.status ?? 'pending',
        input.priority ?? 'normal',
        input.assignee ?? null,
        normalizedDeadline,
        exactDue?.dueAt ?? null,
        exactDue?.offsetMinutes ?? null,
        initialTemporalEpoch,
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
    if (patch.status === 'failed') {
      throw new Error(`task_update: 'failed' is a system-only status`);
    }
    if (patch.status !== undefined) assertEnum(patch.status, TASK_STATUSES, 'status');
    if (patch.priority !== undefined) assertEnum(patch.priority, TASK_PRIORITIES, 'priority');
    if (patch.deadline !== undefined && patch.deadline !== null) {
      assertIsoDate(patch.deadline, 'deadline');
    }
    if (patch.title !== undefined && patch.title.trim() === '') {
      throw new Error('task title must be a non-empty string');
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT * FROM operator_tasks WHERE id = ?').get(id) as
        | TaskRow
        | undefined;
      if (!existing) throw new Error(`task_update: no task with id ${id}`);
      if (existing.kind === 'system') {
        throw new Error(`task_update: task ${id} is a system workorder row (host-managed)`);
      }

      const next: Record<string, unknown> = {
        title: existing.title,
        status: existing.status,
        priority: existing.priority,
        assignee: existing.assignee,
        deadline: existing.deadline,
        due_at: existing.due_at,
        deadline_offset_minutes: existing.deadline_offset_minutes,
        latest_event: existing.latest_event,
        confirmed: existing.confirmed,
        temporal_epoch: existing.temporal_epoch,
        temporal_reconciled_occurrence_key: existing.temporal_reconciled_occurrence_key,
        last_temporal_checked_at: existing.last_temporal_checked_at,
        next_temporal_check_at: existing.next_temporal_check_at,
        last_temporal_attempt_id: existing.last_temporal_attempt_id,
      };
      if (patch.title !== undefined) next.title = patch.title.trim();
      if (patch.status !== undefined) next.status = patch.status;
      if (patch.priority !== undefined) next.priority = patch.priority;
      if (patch.assignee !== undefined) next.assignee = patch.assignee;
      if (patch.latest_event !== undefined) next.latest_event = patch.latest_event;
      if (patch.confirmed !== undefined) next.confirmed = patch.confirmed ? 1 : 0;

      const hasDueAt = Object.prototype.hasOwnProperty.call(patch, 'due_at');
      const hasDeadline = Object.prototype.hasOwnProperty.call(patch, 'deadline');
      if (hasDueAt && patch.due_at !== null && patch.due_at !== undefined) {
        const exactDue = parseExactDueAt(patch.due_at);
        if (hasDeadline && patch.deadline !== exactDue.deadline) {
          throw new Error('task_update: due_at and deadline conflict');
        }
        next.due_at = exactDue.dueAt;
        next.deadline = exactDue.deadline;
        next.deadline_offset_minutes = exactDue.offsetMinutes;
      } else if (hasDeadline) {
        next.deadline = patch.deadline ?? null;
        next.due_at = null;
        if (patch.deadline === null) {
          next.deadline_offset_minutes = null;
        }
      } else if (hasDueAt) {
        next.due_at = null;
      }

      const temporalChanged =
        next.due_at !== existing.due_at || next.deadline !== existing.deadline;
      const terminalToOpen =
        (existing.status === 'done' || existing.status === 'cancelled') &&
        next.status !== 'done' &&
        next.status !== 'cancelled';
      const openToTerminal =
        existing.status !== 'done' &&
        existing.status !== 'cancelled' &&
        (next.status === 'done' || next.status === 'cancelled');
      if (temporalChanged || terminalToOpen) {
        next.temporal_epoch = existing.temporal_epoch + 1;
        next.temporal_reconciled_occurrence_key = null;
        next.last_temporal_checked_at = null;
        next.next_temporal_check_at = null;
        next.last_temporal_attempt_id = null;
      }

      const persistedColumns = [
        'title',
        'status',
        'priority',
        'assignee',
        'deadline',
        'due_at',
        'deadline_offset_minutes',
        'latest_event',
        'confirmed',
        'temporal_epoch',
        'temporal_reconciled_occurrence_key',
        'last_temporal_checked_at',
        'next_temporal_check_at',
        'last_temporal_attempt_id',
      ] as const;
      const changedColumns = persistedColumns.filter((column) => next[column] !== existing[column]);
      if (changedColumns.length === 0) {
        this.db.exec('COMMIT');
        return this.toRecord(existing);
      }

      const nextRevision = existing.revision + 1;
      const sets = changedColumns.map((column) => `${column} = ?`);
      const values = changedColumns.map((column) => next[column]);
      sets.push('revision = ?', 'updated_at = ?');
      values.push(nextRevision, this.now());
      this.db
        .prepare(`UPDATE operator_tasks SET ${sets.join(', ')} WHERE id = ?`)
        .run(...values, id);
      if (temporalChanged || terminalToOpen) {
        this.supersedeTemporalGenerationsInTransaction(id, Number(next.temporal_epoch));
      } else if (openToTerminal) {
        this.supersedeAllActiveTemporalGenerationsInTransaction(id);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getById(id)!;
  }

  private supersedeTemporalGenerationsInTransaction(
    taskId: number,
    currentEpoch: number,
    excludeGenerationKey?: string,
    updatedAt: number = this.now()
  ): void {
    const reason = 'task temporal occurrence superseded';
    const exclusion = excludeGenerationKey ? ' AND generation_key != ?' : '';
    const generationParams = excludeGenerationKey
      ? [taskId, currentEpoch, excludeGenerationKey]
      : [taskId, currentEpoch];
    this.db
      .prepare(
        `UPDATE operator_tasks SET status = 'cancelled', latest_event = ?, updated_at = ?
         WHERE kind = 'system' AND status IN ('pending','in_progress') AND id IN (
           SELECT last_workorder_id FROM operator_temporal_generations
           WHERE task_id = ? AND disposition = 'active' AND temporal_epoch < ?${exclusion}
         )`
      )
      .run(reason, updatedAt, ...generationParams);
    this.db
      .prepare(
        `UPDATE operator_temporal_generations
         SET disposition = 'superseded', reason = ?, updated_at = ?
         WHERE task_id = ? AND disposition = 'active' AND temporal_epoch < ?${exclusion}`
      )
      .run(reason, updatedAt, ...generationParams);
  }

  private supersedeAllActiveTemporalGenerationsInTransaction(
    taskId: number,
    updatedAt: number = this.now()
  ): void {
    const reason = 'owner task closed';
    this.db
      .prepare(
        `UPDATE operator_tasks SET status = 'cancelled', latest_event = ?, updated_at = ?
         WHERE kind = 'system' AND status IN ('pending','in_progress') AND id IN (
           SELECT last_workorder_id FROM operator_temporal_generations
           WHERE task_id = ? AND disposition = 'active'
         )`
      )
      .run(reason, updatedAt, taskId);
    this.db
      .prepare(
        `UPDATE operator_temporal_generations
         SET disposition = 'superseded', reason = ?, updated_at = ?
         WHERE task_id = ? AND disposition = 'active'`
      )
      .run(reason, updatedAt, taskId);
  }

  /**
   * Stable hash over ordered OWNER rows - the Phase-2 verifier's ledger
   * snapshot. kind filter keeps concurrent system enqueues from shaking the
   * hash mid-bracket (evidence-only signal, but noise is noise).
   */
  payloadHash(): string {
    const rows = this.db
      .prepare(
        `SELECT id, title, status, priority, assignee, deadline, latest_event, confirmed,
                updated_at
         FROM operator_tasks WHERE kind = 'owner' ORDER BY id ASC`
      )
      .all() as Array<Record<string, unknown>>;
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  }

  // ── Workorder API (Stage 2) ─────────────────────────────────────────────
  // System rows only. These are the ONLY paths that create or transition
  // kind='system' rows; external create/update guards reject everything else.

  /**
   * Enqueue a workorder. Idempotent per occurrence key: an open (pending or
   * in_progress) keyed row dedups; a terminal keyed row frees the slot (the
   * unique index excludes terminal statuses) and a fresh row is inserted.
   */
  enqueueWorkOrder(order: EnqueueWorkOrderInput): WorkOrderRecord {
    if (order.workKind === 'temporal') {
      throw new Error('enqueueWorkOrder: temporal work requires enqueueTemporalGeneration');
    }
    if (Object.prototype.hasOwnProperty.call(order.input, 'attempts')) {
      throw new Error('enqueueWorkOrder: attempts is ledger-managed and cannot be supplied');
    }
    return this.insertWorkOrder(order, 1);
  }

  private insertWorkOrder(order: EnqueueWorkOrderInput, attempts: number): WorkOrderRecord {
    assertEnum(order.workKind, WORKORDER_KINDS, 'workKind');
    if (order.priority !== undefined) {
      assertEnum(order.priority, TASK_PRIORITIES, 'priority');
    }
    if (!order.idempotencyKey || order.idempotencyKey.trim() === '') {
      throw new Error('enqueueWorkOrder: idempotencyKey must be non-empty');
    }
    const channel = `${WORKORDER_CHANNEL_PREFIX}${order.workKind}`;
    const open = this.db
      .prepare(
        `SELECT * FROM operator_tasks
         WHERE kind = 'system' AND source_channel = ? AND source_event_id = ?
           AND status IN ('pending','in_progress')`
      )
      .get(channel, order.idempotencyKey) as TaskRow | undefined;
    if (open) {
      return this.rowToWorkOrder(open);
    }

    if (!Number.isSafeInteger(attempts) || attempts < 1) {
      throw new Error(`insertWorkOrder: attempts must be a positive integer, got: ${attempts}`);
    }
    const payload = JSON.stringify({ ...order.input, attempts });
    const now = this.now();
    const result = this.db
      .prepare(
        `INSERT INTO operator_tasks
           (title, status, priority, kind, payload, source_channel, source_event_id,
            auto_created, confirmed, created_at, updated_at)
         VALUES (?, 'pending', ?, 'system', ?, ?, ?, 1, 0, ?, ?)`
      )
      .run(
        `workorder:${order.workKind}`,
        order.priority ?? 'normal',
        payload,
        channel,
        order.idempotencyKey,
        now,
        now
      );
    return this.getWorkOrderById(Number(result.lastInsertRowid))!;
  }

  enqueueTemporalGeneration(
    input: EnqueueTemporalGenerationInput
  ): TemporalGenerationEnqueueResult {
    this.validateTemporalGenerationInput(input);
    const sourceChannelRef = this.temporalSourceIdentifierRef(input.sourceChannel);
    const sourceEventIdRef = this.temporalSourceIdentifierRef(input.sourceEventId);
    let result: TemporalGenerationEnqueueResult | null = null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.getTemporalGeneration(input.generationKey);
      if (existing) {
        if (
          existing.taskId !== input.taskId ||
          existing.temporalEpoch !== input.temporalEpoch ||
          existing.occurrenceKey !== input.occurrenceKey ||
          existing.checkAt !== input.checkAt
        ) {
          throw new Error(
            `temporal generation '${input.generationKey}' conflicts with its stored identity`
          );
        }
        if (existing.lastWorkOrderId === null) {
          throw new Error(
            `temporal generation '${input.generationKey}' has no owning workorder attempt`
          );
        }
        const workOrder = this.getWorkOrderById(existing.lastWorkOrderId);
        if (!workOrder) {
          throw new Error(
            `temporal generation '${input.generationKey}' owns missing workorder ${existing.lastWorkOrderId}`
          );
        }
        this.assertTemporalPayloadMatches(workOrder, existing);
        if (
          workOrder.payload.sourceChannel !== sourceChannelRef ||
          workOrder.payload.sourceEventId !== sourceEventIdRef
        ) {
          throw new Error(
            `temporal generation '${input.generationKey}' conflicts with stored source identifiers`
          );
        }
        result = { generation: existing, workOrder, created: false };
      } else {
        const task = this.getRowById(input.taskId);
        if (!task || task.kind !== 'owner') {
          throw new Error(`temporal generation: owner task ${input.taskId} does not exist`);
        }
        if (task.status === 'done' || task.status === 'cancelled') {
          throw new Error(`temporal generation: task ${input.taskId} is closed`);
        }
        const currentOccurrence = occurrenceKeyForTask(task);
        if (
          task.temporalEpoch !== input.temporalEpoch ||
          currentOccurrence !== input.occurrenceKey
        ) {
          throw new Error(`temporal generation: task occurrence no longer matches enqueue input`);
        }
        if (
          this.temporalSourceIdentifierRef(task.sourceChannel) !== sourceChannelRef ||
          this.temporalSourceIdentifierRef(task.sourceEventId) !== sourceEventIdRef
        ) {
          throw new Error(`temporal generation: source identifiers do not match owner task`);
        }
        const openCollision = this.db
          .prepare(
            `SELECT id FROM operator_tasks
             WHERE kind = 'system' AND source_channel = 'workorder:temporal'
               AND source_event_id = ? AND status IN ('pending','in_progress')`
          )
          .get(input.generationKey) as { id: number } | undefined;
        if (openCollision) {
          throw new Error(
            `temporal generation '${input.generationKey}' has orphan open workorder ${openCollision.id}`
          );
        }

        const timestamp = this.now();
        this.db
          .prepare(
            `INSERT INTO operator_temporal_generations
               (generation_key, task_id, temporal_epoch, occurrence_key, check_at,
                disposition, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`
          )
          .run(
            input.generationKey,
            input.taskId,
            input.temporalEpoch,
            input.occurrenceKey,
            input.checkAt,
            timestamp,
            timestamp
          );
        const workOrder = this.insertWorkOrder(
          {
            workKind: 'temporal',
            idempotencyKey: input.generationKey,
            input: {
              generationKey: input.generationKey,
              taskId: input.taskId,
              temporalEpoch: input.temporalEpoch,
              occurrenceKey: input.occurrenceKey,
              checkAt: input.checkAt,
              sourceChannel: sourceChannelRef,
              sourceEventId: sourceEventIdRef,
            },
            priority: input.priority ?? 'normal',
          },
          1
        );
        this.db
          .prepare(
            `UPDATE operator_temporal_generations
             SET last_workorder_id = ?, updated_at = ? WHERE generation_key = ?`
          )
          .run(workOrder.id, timestamp, input.generationKey);
        const generation = this.getTemporalGeneration(input.generationKey);
        if (!generation) {
          throw new Error(`temporal generation '${input.generationKey}' could not be read back`);
        }
        result = { generation, workOrder, created: true };
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    if (!result) {
      throw new Error(`temporal generation '${input.generationKey}' produced no result`);
    }
    return result;
  }

  getTemporalGeneration(generationKey: string): TemporalGenerationRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM operator_temporal_generations WHERE generation_key = ?`)
      .get(generationKey) as
      | {
          generation_key: string;
          task_id: number;
          temporal_epoch: number;
          occurrence_key: string;
          check_at: number;
          disposition: string;
          last_workorder_id: number | null;
          reason: string | null;
          created_at: number;
          updated_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      generationKey: row.generation_key,
      taskId: row.task_id,
      temporalEpoch: row.temporal_epoch,
      occurrenceKey: row.occurrence_key,
      checkAt: row.check_at,
      disposition: row.disposition as TemporalGenerationDisposition,
      lastWorkOrderId: row.last_workorder_id,
      reason: row.reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  loadTemporalWorkContext(attemptId: number): TemporalWorkContext {
    return this.loadTemporalWorkContextInternal(attemptId);
  }

  assertTemporalWorkContextActive(suppliedContext: TemporalWorkContext): TemporalWorkContext {
    const trustedContext = this.loadTemporalWorkContextInternal(suppliedContext.attemptId);
    this.assertTemporalContextMatches(suppliedContext, trustedContext);
    return trustedContext;
  }

  getTemporalEffect(attemptId: number): TemporalEffectReceipt | null {
    const row = this.db
      .prepare(`SELECT * FROM operator_temporal_effects WHERE workorder_attempt_id = ?`)
      .get(attemptId) as
      | {
          workorder_attempt_id: number;
          task_id: number;
          generation_key: string;
          occurrence_key: string;
          outcome: string;
          before_revision: number;
          after_revision: number;
          changed_fields: string;
          reason: string;
          attestation_version: number;
          context_packet_id: string | null;
          context_packet_sha256: string | null;
          next_temporal_check_at: number | null;
          created_at: number;
        }
      | undefined;
    if (!row) return null;
    const changedFields: unknown = JSON.parse(row.changed_fields);
    if (
      !Array.isArray(changedFields) ||
      !changedFields.every((field) => typeof field === 'string')
    ) {
      throw new Error(`temporal effect ${attemptId} has invalid changed_fields`);
    }
    if (!['resolved', 'final_no_update', 'deferred'].includes(row.outcome)) {
      throw new Error(`temporal effect ${attemptId} has invalid outcome '${row.outcome}'`);
    }
    return {
      workorderAttemptId: row.workorder_attempt_id,
      taskId: row.task_id,
      generationKey: row.generation_key,
      occurrenceKey: row.occurrence_key,
      outcome: row.outcome as TemporalEffectReceipt['outcome'],
      beforeRevision: row.before_revision,
      afterRevision: row.after_revision,
      changedFields,
      reason: row.reason,
      attestationVersion: row.attestation_version === 1 ? 1 : 0,
      contextPacketId: row.context_packet_id ?? '',
      contextPacketSha256: row.context_packet_sha256 ?? '',
      nextTemporalCheckAt: row.next_temporal_check_at,
      createdAt: row.created_at,
    };
  }

  /**
   * Read and validate the durable state that decides a temporal attempt's
   * terminal outcome. This intentionally does not require an active attempt:
   * consumers must be able to arbitrate committed, superseded, and exhausted
   * attempts after runner/auditor failures and daemon restarts.
   */
  inspectTemporalAttempt(attemptId: number): TemporalAttemptState {
    const workOrder = this.getWorkOrderById(attemptId);
    if (!workOrder || workOrder.workKind !== 'temporal') {
      throw new Error(`temporal attempt state: no temporal attempt ${attemptId}`);
    }
    const generationKey = this.requirePayloadString(workOrder.payload, 'generationKey', attemptId);
    const generation = this.getTemporalGeneration(generationKey);
    if (!generation) {
      throw new Error(`temporal attempt state: generation '${generationKey}' is missing`);
    }
    this.assertTemporalPayloadMatches(workOrder, generation);
    const receipt = this.getTemporalEffect(attemptId);

    if (receipt) {
      const receiptError = temporalReceiptInvariantError(receipt, {
        attemptId,
        taskId: generation.taskId,
        generationKey: generation.generationKey,
        occurrenceKey: generation.occurrenceKey,
      });
      if (receiptError) {
        throw new Error(`temporal attempt state: ${receiptError}`);
      }
      if (
        workOrder.status !== 'done' ||
        generation.lastWorkOrderId !== attemptId ||
        generation.disposition !== receipt.outcome
      ) {
        throw new Error(`temporal attempt state: receipt ${attemptId} is not atomically committed`);
      }
      const task = this.getById(generation.taskId);
      if (!task || task.revision < receipt.afterRevision) {
        throw new Error(`temporal attempt state: receipt ${attemptId} owner revision is invalid`);
      }
      if (receipt.outcome !== 'resolved') {
        const scope = temporalNoUpdateScope({
          attemptId,
          generationKey: generation.generationKey,
          taskId: generation.taskId,
          temporalEpoch: generation.temporalEpoch,
          occurrenceKey: generation.occurrenceKey,
          checkAt: generation.checkAt,
          revision: receipt.beforeRevision,
          sourceChannel: null,
          sourceEventId: null,
        });
        const note = this.db
          .prepare(
            `SELECT id FROM operator_no_update_notes
             WHERE scope = ? AND reason = ? AND created_at = ? LIMIT 1`
          )
          .get(scope, receipt.reason, receipt.createdAt) as { id: number } | undefined;
        if (!note) {
          throw new Error(`temporal attempt state: exact-scope no-update note is missing`);
        }
      }
      if (task.revision === receipt.afterRevision) {
        if (
          task.lastTemporalAttemptId !== attemptId ||
          task.lastTemporalCheckedAt !== receipt.createdAt
        ) {
          throw new Error(`temporal attempt state: owner attempt markers are invalid`);
        }
        if (receipt.outcome === 'resolved' || receipt.outcome === 'final_no_update') {
          if (
            task.temporalReconciledOccurrenceKey !== generation.occurrenceKey ||
            task.nextTemporalCheckAt !== null
          ) {
            throw new Error(`temporal attempt state: owner final markers are invalid`);
          }
        } else if (task.nextTemporalCheckAt !== receipt.nextTemporalCheckAt) {
          throw new Error(`temporal attempt state: owner deferred check is invalid`);
        }
      }
    } else if (workOrder.status === 'done') {
      throw new Error(`temporal attempt state: done attempt ${attemptId} has no receipt`);
    }

    if (workOrder.status === 'in_progress') {
      if (
        receipt ||
        generation.disposition !== 'active' ||
        generation.lastWorkOrderId !== attemptId
      ) {
        throw new Error(`temporal attempt state: active attempt ${attemptId} lost ownership`);
      }
    }
    if (
      workOrder.status === 'cancelled' &&
      generation.disposition !== 'superseded' &&
      (generation.disposition !== 'active' || generation.lastWorkOrderId !== attemptId)
    ) {
      throw new Error(
        `temporal attempt state: cancelled attempt ${attemptId} has invalid ownership`
      );
    }
    if (
      workOrder.status === 'failed' &&
      generation.disposition === 'active' &&
      generation.lastWorkOrderId !== attemptId
    ) {
      const replacement =
        generation.lastWorkOrderId === null
          ? null
          : this.getWorkOrderById(generation.lastWorkOrderId);
      if (
        !replacement ||
        replacement.workKind !== 'temporal' ||
        (replacement.status !== 'pending' && replacement.status !== 'in_progress')
      ) {
        throw new Error(`temporal attempt state: retry replacement is missing or terminal`);
      }
      this.assertTemporalPayloadMatches(replacement, generation);
    }

    if (
      generation.disposition === 'superseded' &&
      workOrder.status !== 'cancelled' &&
      workOrder.status !== 'failed'
    ) {
      throw new Error(`temporal attempt state: superseded attempt ${attemptId} is still open`);
    }
    return { workOrder, generation, receipt };
  }

  applyTemporalEffect(
    suppliedContext: TemporalWorkContext,
    input: TemporalReconcileInput,
    evidence: TemporalEvidenceAttestation,
    now: number = this.now()
  ): TemporalEffectReceipt {
    if (!Number.isSafeInteger(now)) {
      throw new Error('temporal effect time must be an epoch millisecond integer');
    }
    this.validateTemporalEffectInput(input, now);
    if (
      !evidence ||
      typeof evidence.contextPacketId !== 'string' ||
      evidence.contextPacketId.trim().length < 1 ||
      evidence.contextPacketId.length > 300 ||
      !/^[a-f0-9]{64}$/.test(evidence.contextPacketSha256)
    ) {
      throw new Error('temporal effect requires a valid host evidence attestation');
    }
    let receipt: TemporalEffectReceipt | null = null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const context = this.assertTemporalWorkContextActive(suppliedContext);
      if (input.expected_revision !== context.revision) {
        throw new Error(
          `temporal effect revision mismatch: expected ${input.expected_revision}, current ${context.revision}`
        );
      }
      const existing = this.db
        .prepare(`SELECT * FROM operator_tasks WHERE id = ?`)
        .get(context.taskId) as TaskRow | undefined;
      if (!existing || existing.kind !== 'owner' || existing.revision !== context.revision) {
        throw new Error(`temporal effect owner task no longer matches trusted context`);
      }

      const next: Record<string, unknown> = {
        status: existing.status,
        deadline: existing.deadline,
        due_at: existing.due_at,
        deadline_offset_minutes: existing.deadline_offset_minutes,
        temporal_epoch: existing.temporal_epoch,
        temporal_reconciled_occurrence_key: existing.temporal_reconciled_occurrence_key,
        last_temporal_checked_at: now,
        next_temporal_check_at: null,
        last_temporal_attempt_id: context.attemptId,
      };
      const auditParts = [`reason=${input.reason.trim()}`];
      if (input.outcome === 'final_no_update') {
        auditParts.push(`evidence=${input.evidence_summary.trim()}`);
      }
      const receiptReason = this.temporalAuditText(`effect-${input.outcome}`, auditParts);
      let nextCheck: number | null = null;
      let rescheduled = false;

      if (input.outcome === 'resolved') {
        if (input.status !== undefined) next.status = input.status;
        if (Object.prototype.hasOwnProperty.call(input, 'due_at')) {
          if (input.due_at === null) {
            next.due_at = null;
          } else if (input.due_at !== undefined) {
            const exactDue = parseExactDueAt(input.due_at);
            if (exactDue.dueAt !== existing.due_at) {
              next.due_at = exactDue.dueAt;
              next.deadline = exactDue.deadline;
              next.deadline_offset_minutes = exactDue.offsetMinutes;
            }
          }
        }
        const resolvedEffectChanged =
          next.status !== existing.status || next.due_at !== existing.due_at;
        if (!resolvedEffectChanged) {
          throw new Error('temporal resolved outcome requires an actual status or due_at change');
        }
        rescheduled = next.due_at !== existing.due_at;
        if (rescheduled) next.temporal_epoch = existing.temporal_epoch + 1;
        next.temporal_reconciled_occurrence_key = context.occurrenceKey;
      } else if (input.outcome === 'final_no_update') {
        next.temporal_reconciled_occurrence_key = context.occurrenceKey;
      } else {
        nextCheck = parseExactDueAt(input.next_temporal_check_at).dueAt;
        next.next_temporal_check_at = nextCheck;
      }

      const persistedColumns = [
        'status',
        'deadline',
        'due_at',
        'deadline_offset_minutes',
        'temporal_epoch',
        'temporal_reconciled_occurrence_key',
        'last_temporal_checked_at',
        'next_temporal_check_at',
        'last_temporal_attempt_id',
      ] as const;
      const changedFields = persistedColumns.filter((column) => next[column] !== existing[column]);
      const afterRevision = existing.revision + 1;
      const sets = changedFields.map((column) => `${column} = ?`);
      const values = changedFields.map((column) => next[column]);
      sets.push('revision = ?', 'updated_at = ?');
      values.push(afterRevision, now);
      const ownerUpdate = this.db
        .prepare(
          `UPDATE operator_tasks SET ${sets.join(', ')} WHERE id = ? AND kind = 'owner' AND revision = ?`
        )
        .run(...values, context.taskId, existing.revision);
      if (ownerUpdate.changes !== 1) {
        throw new Error(`temporal effect lost owner task revision for task ${context.taskId}`);
      }

      if (rescheduled) {
        this.supersedeTemporalGenerationsInTransaction(
          context.taskId,
          Number(next.temporal_epoch),
          context.generationKey,
          now
        );
      }
      const generationUpdate = this.db
        .prepare(
          `UPDATE operator_temporal_generations
           SET disposition = ?, reason = ?, updated_at = ?
           WHERE generation_key = ? AND disposition = 'active' AND last_workorder_id = ?`
        )
        .run(input.outcome, receiptReason, now, context.generationKey, context.attemptId);
      if (generationUpdate.changes !== 1) {
        throw new Error(
          `temporal effect lost generation ownership for attempt ${context.attemptId}`
        );
      }
      if (input.outcome === 'resolved' && (next.status === 'done' || next.status === 'cancelled')) {
        this.supersedeAllActiveTemporalGenerationsInTransaction(context.taskId, now);
      }

      if (input.outcome !== 'resolved') {
        this.insertNoUpdateNote(temporalNoUpdateScope(context), receiptReason, now);
      }
      this.db
        .prepare(
          `INSERT INTO operator_temporal_effects
             (workorder_attempt_id, task_id, generation_key, occurrence_key, outcome,
              before_revision, after_revision, changed_fields, reason,
              attestation_version, context_packet_id, context_packet_sha256,
              next_temporal_check_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
        )
        .run(
          context.attemptId,
          context.taskId,
          context.generationKey,
          context.occurrenceKey,
          input.outcome,
          existing.revision,
          afterRevision,
          JSON.stringify(changedFields),
          receiptReason,
          evidence.contextPacketId,
          evidence.contextPacketSha256,
          nextCheck,
          now
        );
      const workOrderUpdate = this.db
        .prepare(
          `UPDATE operator_tasks SET status = 'done', latest_event = ?, updated_at = ?
           WHERE id = ? AND kind = 'system' AND status = 'in_progress'
             AND source_channel = 'workorder:temporal' AND source_event_id = ?`
        )
        .run(receiptReason, now, context.attemptId, context.generationKey);
      if (workOrderUpdate.changes !== 1) {
        throw new Error(`temporal effect lost active workorder ${context.attemptId}`);
      }
      receipt = this.getTemporalEffect(context.attemptId);
      if (!receipt) throw new Error(`temporal effect receipt could not be read back`);
      const receiptError = temporalReceiptInvariantError(receipt, {
        attemptId: context.attemptId,
        taskId: context.taskId,
        generationKey: context.generationKey,
        occurrenceKey: context.occurrenceKey,
        beforeRevision: context.revision,
      });
      if (receiptError) {
        throw new Error(`temporal effect receipt invariant failed: ${receiptError}`);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    if (!receipt) throw new Error(`temporal effect produced no receipt`);
    return receipt;
  }

  requeueTemporalWorkOrder(attemptId: number, reason: string): WorkOrderRecord {
    this.assertTemporalReason(reason);
    const auditReason = this.temporalAuditText('worker-failure', [`failure=${reason}`]);
    let replacement: WorkOrderRecord | null = null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const context = this.loadTemporalWorkContextInternal(attemptId);
      const workOrder = this.getWorkOrderById(attemptId)!;
      if (workOrder.payload.attempts >= TEMPORAL_WORKORDER_MAX_ATTEMPTS) {
        throw new Error(`temporal retry budget exhausted for attempt ${attemptId}`);
      }
      replacement = this.requeueTemporalWorkOrderInTransaction(context, workOrder, auditReason);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    if (!replacement) throw new Error(`temporal retry for attempt ${attemptId} produced no row`);
    return replacement;
  }

  exhaustTemporalWorkOrder(attemptId: number, reason: string): void {
    this.assertTemporalReason(reason);
    const auditReason = this.temporalAuditText('worker-failure', [`failure=${reason}`]);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const context = this.loadTemporalWorkContextInternal(attemptId);
      const workOrder = this.getWorkOrderById(attemptId)!;
      if (workOrder.payload.attempts !== TEMPORAL_WORKORDER_MAX_ATTEMPTS) {
        throw new Error(
          `temporal exhaustion requires attempt ${TEMPORAL_WORKORDER_MAX_ATTEMPTS}, got ${workOrder.payload.attempts}`
        );
      }
      this.exhaustTemporalWorkOrderInTransaction(context, auditReason);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  failTemporalWorkOrder(attemptId: number, reason: string): TemporalWorkFailureResult {
    this.assertTemporalReason(reason);
    const auditReason = this.temporalAuditText('worker-failure', [`failure=${reason}`]);
    let result: TemporalWorkFailureResult | null = null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const repairedAttempt = this.repairClosedTemporalOwnershipInTransaction(attemptId);
      if (repairedAttempt !== null) {
        result = {
          disposition: 'superseded',
          attempt: repairedAttempt,
          maxAttempts: TEMPORAL_WORKORDER_MAX_ATTEMPTS,
        };
        this.db.exec('COMMIT');
        return result;
      }
      const context = this.loadTemporalWorkContextInternal(attemptId);
      const workOrder = this.getWorkOrderById(attemptId)!;
      const attempt = workOrder.payload.attempts;
      if (attempt < TEMPORAL_WORKORDER_MAX_ATTEMPTS) {
        result = {
          disposition: 'requeued',
          replacement: this.requeueTemporalWorkOrderInTransaction(context, workOrder, auditReason),
          attempt,
          maxAttempts: TEMPORAL_WORKORDER_MAX_ATTEMPTS,
        };
      } else if (attempt === TEMPORAL_WORKORDER_MAX_ATTEMPTS) {
        this.exhaustTemporalWorkOrderInTransaction(context, auditReason);
        result = {
          disposition: 'exhausted',
          attempt,
          maxAttempts: TEMPORAL_WORKORDER_MAX_ATTEMPTS,
        };
      } else {
        throw new Error(`temporal attempt ${attemptId} exceeds retry budget: ${attempt}`);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    if (!result) throw new Error(`temporal failure for attempt ${attemptId} produced no result`);
    return result;
  }

  private repairClosedTemporalOwnershipInTransaction(attemptId: number): number | null {
    const workOrder = this.getWorkOrderById(attemptId);
    if (!workOrder || workOrder.workKind !== 'temporal') {
      return null;
    }
    const generationKey = this.requirePayloadString(workOrder.payload, 'generationKey', attemptId);
    const generation = this.getTemporalGeneration(generationKey);
    if (!generation || generation.lastWorkOrderId !== attemptId) {
      return null;
    }
    const task = this.getById(generation.taskId);
    if (!task || (task.status !== 'done' && task.status !== 'cancelled')) {
      return null;
    }
    const openAttempt = workOrder.status === 'pending' || workOrder.status === 'in_progress';
    if (generation.disposition === 'active' && openAttempt) {
      this.supersedeAllActiveTemporalGenerationsInTransaction(task.id);
    } else if (generation.disposition !== 'superseded' || workOrder.status !== 'cancelled') {
      return null;
    }
    return workOrder.payload.attempts;
  }

  /** Repair pre-fix databases where a terminal owner still has active temporal ownership. */
  repairClosedTemporalGenerations(): number {
    let repaired = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db
        .prepare(
          `SELECT DISTINCT generation.task_id
           FROM operator_temporal_generations generation
           JOIN operator_tasks owner ON owner.id = generation.task_id
           WHERE generation.disposition = 'active'
             AND owner.kind = 'owner'
             AND owner.status IN ('done','cancelled')
           ORDER BY generation.task_id ASC`
        )
        .all() as Array<{ task_id: number }>;
      const updatedAt = this.now();
      for (const row of rows) {
        this.supersedeAllActiveTemporalGenerationsInTransaction(row.task_id, updatedAt);
      }
      repaired = rows.length;
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return repaired;
  }

  /** Control-plane pause: cancel open attempts but keep generations resumable. */
  pauseActiveTemporalWork(reason: string): number {
    this.assertTemporalReason(reason);
    let changed = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db
        .prepare(
          `UPDATE operator_tasks
           SET status = 'cancelled', latest_event = ?, updated_at = ?
           WHERE kind = 'system' AND source_channel = 'workorder:temporal'
             AND status IN ('pending','in_progress')`
        )
        .run(reason, this.now());
      changed = result.changes;
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return changed;
  }

  /** Resume paused active generations without spending another model attempt. */
  resumePausedTemporalWork(): WorkOrderRecord[] {
    const resumed: WorkOrderRecord[] = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db
        .prepare(
          `SELECT generation_key, last_workorder_id
           FROM operator_temporal_generations generation
           WHERE disposition = 'active' AND last_workorder_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM operator_tasks open_attempt
               WHERE open_attempt.kind = 'system'
                 AND open_attempt.source_channel = 'workorder:temporal'
                 AND open_attempt.source_event_id = generation.generation_key
                 AND open_attempt.status IN ('pending','in_progress')
             )
           ORDER BY generation_key ASC`
        )
        .all() as Array<{ generation_key: string; last_workorder_id: number }>;
      for (const row of rows) {
        const generation = this.getTemporalGeneration(row.generation_key);
        const previous = this.getWorkOrderById(row.last_workorder_id);
        if (!generation || !previous || previous.status !== 'cancelled') {
          throw new Error(
            `temporal resume: active generation '${row.generation_key}' has no paused attempt`
          );
        }
        this.assertTemporalPayloadMatches(previous, generation);
        const { attempts, ...payload } = previous.payload;
        const replacement = this.insertWorkOrder(
          {
            workKind: 'temporal',
            idempotencyKey: generation.generationKey,
            input: payload,
            priority: previous.priority,
          },
          attempts
        );
        const ownership = this.db
          .prepare(
            `UPDATE operator_temporal_generations
             SET last_workorder_id = ?, updated_at = ?
             WHERE generation_key = ? AND disposition = 'active' AND last_workorder_id = ?`
          )
          .run(replacement.id, this.now(), generation.generationKey, previous.id);
        if (ownership.changes !== 1) {
          throw new Error(
            `temporal resume lost ownership for generation '${generation.generationKey}'`
          );
        }
        resumed.push(replacement);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return resumed;
  }

  private requeueTemporalWorkOrderInTransaction(
    context: TemporalWorkContext,
    workOrder: WorkOrderRecord,
    reason: string
  ): WorkOrderRecord {
    this.transitionWorkOrder(workOrder.id, 'failed', reason);
    const { attempts: _attempts, ...payload } = workOrder.payload;
    const replacement = this.insertWorkOrder(
      {
        workKind: 'temporal',
        idempotencyKey: context.generationKey,
        input: payload,
        priority: workOrder.priority,
      },
      workOrder.payload.attempts + 1
    );
    const ownership = this.db
      .prepare(
        `UPDATE operator_temporal_generations
         SET last_workorder_id = ?, updated_at = ?
         WHERE generation_key = ? AND disposition = 'active' AND last_workorder_id = ?`
      )
      .run(replacement.id, this.now(), context.generationKey, workOrder.id);
    if (ownership.changes !== 1) {
      throw new Error(`temporal retry lost generation ownership for attempt ${workOrder.id}`);
    }
    return replacement;
  }

  private exhaustTemporalWorkOrderInTransaction(
    context: TemporalWorkContext,
    reason: string
  ): void {
    this.transitionWorkOrder(context.attemptId, 'failed', reason);
    const update = this.db
      .prepare(
        `UPDATE operator_temporal_generations
         SET disposition = 'exhausted', reason = ?, updated_at = ?
         WHERE generation_key = ? AND disposition = 'active' AND last_workorder_id = ?`
      )
      .run(reason, this.now(), context.generationKey, context.attemptId);
    if (update.changes !== 1) {
      throw new Error(`temporal exhaustion lost ownership for attempt ${context.attemptId}`);
    }
  }

  supersedeTemporalGenerations(
    taskId: number,
    currentEpoch: number,
    excludeGenerationKey?: string
  ): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.supersedeTemporalGenerationsInTransaction(taskId, currentEpoch, excludeGenerationKey);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private validateTemporalGenerationInput(input: EnqueueTemporalGenerationInput): void {
    const bounded = (value: string, field: string, max: number): void => {
      if (value.length < 1 || value.length > max) {
        throw new Error(`temporal generation: ${field} must contain 1-${max} characters`);
      }
    };
    bounded(input.generationKey, 'generationKey', 500);
    bounded(input.occurrenceKey, 'occurrenceKey', 300);
    if (!Number.isSafeInteger(input.taskId) || input.taskId < 1) {
      throw new Error(`temporal generation: taskId must be a positive integer`);
    }
    if (!Number.isSafeInteger(input.temporalEpoch) || input.temporalEpoch < 0) {
      throw new Error(`temporal generation: temporalEpoch must be a non-negative integer`);
    }
    if (!Number.isSafeInteger(input.checkAt)) {
      throw new Error(`temporal generation: checkAt must be an epoch millisecond integer`);
    }
    const canonicalKey = temporalGenerationKey(input.taskId, input.occurrenceKey, input.checkAt);
    if (input.generationKey !== canonicalKey) {
      throw new Error(`temporal generation: generationKey must equal canonical identity key`);
    }
    for (const [field, value] of [
      ['sourceChannel', input.sourceChannel],
      ['sourceEventId', input.sourceEventId],
    ] as const) {
      if (value !== null && typeof value !== 'string') {
        throw new Error(`temporal generation: ${field} must be a string or null`);
      }
    }
    if (input.priority !== undefined) assertEnum(input.priority, TASK_PRIORITIES, 'priority');
  }

  /**
   * Workorder payloads carry only bounded references to owner-source identifiers.
   * Owner rows created by older releases may contain empty or arbitrarily long
   * connector identifiers; hashing preserves exact identity without making one
   * legacy row able to abort temporal boot or inflate every retry payload.
   */
  private temporalSourceIdentifierRef(value: string | null): string | null {
    if (value === null) return null;
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
  }

  private validateTemporalEffectInput(input: TemporalReconcileInput, now: number): void {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('temporal effect input must be an object');
    }
    if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0) {
      throw new Error('temporal effect expected_revision must be a non-negative integer');
    }
    this.assertTemporalReason(input.reason);
    const baseKeys = ['expected_revision', 'outcome', 'reason'];
    let allowedKeys: string[];
    if (input.outcome === 'resolved') {
      allowedKeys = [...baseKeys, 'status', 'due_at'];
      if (input.status !== undefined) {
        assertEnum(input.status, TASK_STATUSES, 'temporal effect status');
        if (String(input.status) === 'failed') {
          throw new Error(`temporal effect: 'failed' is a system-only status`);
        }
      }
      if (input.due_at !== undefined && input.due_at !== null) parseExactDueAt(input.due_at);
    } else if (input.outcome === 'final_no_update') {
      allowedKeys = [...baseKeys, 'evidence_summary'];
      if (
        typeof input.evidence_summary !== 'string' ||
        input.evidence_summary.trim().length < 1 ||
        input.evidence_summary.length > 1_000
      ) {
        throw new Error('temporal effect evidence_summary must contain 1-1000 characters');
      }
    } else if (input.outcome === 'deferred') {
      allowedKeys = [...baseKeys, 'next_temporal_check_at'];
      if (typeof input.next_temporal_check_at !== 'string') {
        throw new Error('temporal effect next_temporal_check_at must be RFC 3339');
      }
      const nextCheck = parseExactDueAt(input.next_temporal_check_at).dueAt;
      if (nextCheck <= now) {
        throw new Error('temporal effect deferred check must be strictly in the future');
      }
    } else {
      throw new Error(`temporal effect outcome is unknown or forbidden`);
    }
    const unknownKeys = Object.keys(input).filter((key) => !allowedKeys.includes(key));
    if (unknownKeys.length > 0) {
      throw new Error(
        `temporal effect contains unknown or forbidden fields: ${unknownKeys.join(', ')}`
      );
    }
  }

  private assertTemporalContextMatches(
    supplied: TemporalWorkContext,
    trusted: TemporalWorkContext
  ): void {
    const fields: Array<keyof TemporalWorkContext> = [
      'attemptId',
      'generationKey',
      'taskId',
      'temporalEpoch',
      'occurrenceKey',
      'checkAt',
      'revision',
      'sourceChannel',
      'sourceEventId',
    ];
    if (fields.some((field) => supplied[field] !== trusted[field])) {
      throw new Error('temporal effect supplied context does not match trusted host context');
    }
  }

  private loadTemporalWorkContextInternal(attemptId: number): TemporalWorkContext {
    const workOrder = this.getWorkOrderById(attemptId);
    if (!workOrder || workOrder.workKind !== 'temporal') {
      throw new Error(`temporal context: no temporal attempt ${attemptId}`);
    }
    if (workOrder.status !== 'in_progress') {
      throw new Error(
        `temporal context: attempt ${attemptId} is '${workOrder.status}', expected active attempt`
      );
    }
    const payload = workOrder.payload;
    const generationKey = this.requirePayloadString(payload, 'generationKey', attemptId);
    const taskId = this.requirePayloadInteger(payload, 'taskId', attemptId, 1);
    const temporalEpoch = this.requirePayloadInteger(payload, 'temporalEpoch', attemptId, 0);
    const occurrenceKey = this.requirePayloadString(payload, 'occurrenceKey', attemptId);
    const checkAt = this.requirePayloadInteger(payload, 'checkAt', attemptId);
    const sourceChannel = this.requireNullablePayloadString(payload, 'sourceChannel', attemptId);
    const sourceEventId = this.requireNullablePayloadString(payload, 'sourceEventId', attemptId);
    const generation = this.getTemporalGeneration(generationKey);
    if (!generation || generation.disposition !== 'active') {
      throw new Error(`temporal context: generation '${generationKey}' is not active`);
    }
    if (generation.lastWorkOrderId !== attemptId) {
      throw new Error(`temporal context: attempt ${attemptId} no longer owns generation`);
    }
    this.assertTemporalPayloadMatches(workOrder, generation);
    const task = this.getRowById(taskId);
    if (!task || task.kind !== 'owner') {
      throw new Error(`temporal context: owner task ${taskId} does not exist`);
    }
    if (task.status === 'done' || task.status === 'cancelled') {
      throw new Error(`temporal context: owner task ${taskId} is closed`);
    }
    if (
      task.temporalEpoch !== temporalEpoch ||
      occurrenceKeyForTask(task) !== occurrenceKey ||
      this.temporalSourceIdentifierRef(task.sourceChannel) !== sourceChannel ||
      this.temporalSourceIdentifierRef(task.sourceEventId) !== sourceEventId ||
      generation.taskId !== taskId ||
      generation.temporalEpoch !== temporalEpoch ||
      generation.occurrenceKey !== occurrenceKey ||
      generation.checkAt !== checkAt
    ) {
      throw new Error(`temporal context: attempt ${attemptId} payload no longer matches ownership`);
    }
    return {
      attemptId,
      generationKey,
      taskId,
      temporalEpoch,
      occurrenceKey,
      checkAt,
      revision: task.revision,
      sourceChannel,
      sourceEventId,
    };
  }

  private assertTemporalPayloadMatches(
    workOrder: WorkOrderRecord,
    generation: TemporalGenerationRecord
  ): void {
    const payload = workOrder.payload;
    if (
      payload.generationKey !== generation.generationKey ||
      payload.taskId !== generation.taskId ||
      payload.temporalEpoch !== generation.temporalEpoch ||
      payload.occurrenceKey !== generation.occurrenceKey ||
      payload.checkAt !== generation.checkAt
    ) {
      throw new Error(
        `temporal attempt ${workOrder.id} payload does not match generation ownership`
      );
    }
  }

  private requirePayloadString(
    payload: Record<string, unknown>,
    field: string,
    attemptId: number
  ): string {
    const value = payload[field];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`temporal attempt ${attemptId}: ${field} must be a non-empty string`);
    }
    return value;
  }

  private requireNullablePayloadString(
    payload: Record<string, unknown>,
    field: string,
    attemptId: number
  ): string | null {
    const value = payload[field];
    if (value !== null && typeof value !== 'string') {
      throw new Error(`temporal attempt ${attemptId}: ${field} must be a string or null`);
    }
    return value;
  }

  private requirePayloadInteger(
    payload: Record<string, unknown>,
    field: string,
    attemptId: number,
    minimum: number = Number.MIN_SAFE_INTEGER
  ): number {
    const value = payload[field];
    if (!Number.isSafeInteger(value) || (value as number) < minimum) {
      throw new Error(`temporal attempt ${attemptId}: ${field} must be an integer`);
    }
    return value as number;
  }

  private assertTemporalReason(reason: string): void {
    if (reason.trim().length < 1 || reason.length > 500) {
      throw new Error('temporal workorder reason must contain 1-500 characters');
    }
  }

  private temporalAuditText(kind: string, values: readonly string[]): string {
    const refs = values.map((value, index) => {
      const separator = value.indexOf('=');
      const label = separator > 0 ? value.slice(0, separator) : `value${index + 1}`;
      const text = separator > 0 ? value.slice(separator + 1) : value;
      const digest = createHash('sha256').update(text).digest('hex');
      return `${label}_sha256=${digest};${label}_length=${text.length}`;
    });
    return `temporal-${kind};${refs.join(';')}`;
  }

  /**
   * Claim the next pending workorder: priority high>normal>low, then id ASC
   * (plan D2/E2 - CASE mapping, never lexicographic on the TEXT enum).
   * pending -> in_progress. Single serial consumer; transaction for atomicity.
   */
  claimNextWorkOrder(): WorkOrderRecord | null {
    let claimedId: number | null = null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db
        .prepare(
          `SELECT * FROM operator_tasks
           WHERE kind = 'system' AND status = 'pending'
           ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END ASC,
                    id ASC
           LIMIT 1`
        )
        .get() as TaskRow | undefined;
      if (row) {
        this.db
          .prepare(`UPDATE operator_tasks SET status = 'in_progress', updated_at = ? WHERE id = ?`)
          .run(this.now(), row.id);
        claimedId = row.id;
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    // Read-back OUTSIDE the try: a throw here (corrupt payload) must not
    // trigger ROLLBACK after COMMIT (PR bot round - masked error class).
    return claimedId === null ? null : this.getWorkOrderById(claimedId);
  }

  /**
   * Atomic fail-and-requeue (PR bot round): the failure mark and the
   * replacement row commit together - a crash between the two would lose
   * the retry (the old row terminal, the new one never inserted). The
   * replacement can only be inserted AFTER the old row leaves the partial
   * unique index, hence one transaction, not two calls.
   */
  requeueWorkOrder(wo: WorkOrderRecord, reason: string): WorkOrderRecord {
    if (wo.workKind === 'temporal') {
      return this.requeueTemporalWorkOrder(wo.id, reason);
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getWorkOrderById(wo.id);
      if (!current || current.workKind !== wo.workKind) {
        throw new Error(`workorder retry: claimed row ${wo.id} no longer matches input`);
      }
      this.transitionWorkOrder(current.id, 'failed', reason);
      const { attempts: _attempts, ...input } = current.payload;
      const replacement = this.insertWorkOrder(
        {
          workKind: current.workKind,
          idempotencyKey: current.idempotencyKey,
          input,
          priority: current.priority,
        },
        current.payload.attempts + 1
      );
      this.db.exec('COMMIT');
      return replacement;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  completeWorkOrder(id: number): void {
    this.transitionWorkOrder(id, 'done', null);
  }

  failWorkOrder(id: number, reason: string): void {
    this.transitionWorkOrder(id, 'failed', reason);
  }

  countPendingWorkOrders(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM operator_tasks WHERE kind = 'system' AND status = 'pending'`
      )
      .get() as { count: number };
    return row.count;
  }

  countOpenWorkOrders(kind?: WorkOrderKind): number {
    const row = (
      kind
        ? this.db
            .prepare(
              `SELECT COUNT(*) AS count FROM operator_tasks
               WHERE kind = 'system' AND status IN ('pending','in_progress')
                 AND source_channel = ?`
            )
            .get(`${WORKORDER_CHANNEL_PREFIX}${kind}`)
        : this.db
            .prepare(
              `SELECT COUNT(*) AS count FROM operator_tasks
               WHERE kind = 'system' AND status IN ('pending','in_progress')`
            )
            .get()
    ) as { count: number };
    return row.count;
  }

  findTemporalGenerationKeys(generationKeys: readonly string[]): Set<string> {
    if (generationKeys.length === 0) return new Set();
    if (generationKeys.length > 500) {
      throw new Error('findTemporalGenerationKeys accepts at most 500 keys');
    }
    const rows = this.db
      .prepare(
        `SELECT generation_key FROM operator_temporal_generations
         WHERE generation_key IN (${generationKeys.map(() => '?').join(',')})`
      )
      .all(...generationKeys) as Array<{ generation_key: string }>;
    return new Set(rows.map((row) => row.generation_key));
  }

  /** In-progress system rows at boot = crash artifacts (single serial consumer). */
  listStaleClaims(): WorkOrderRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM operator_tasks WHERE kind = 'system' AND status = 'in_progress'`)
      .all() as TaskRow[];
    return rows.map((row) => this.rowToWorkOrder(row));
  }

  /**
   * Boot cleanup (plan D3 + review N4): open system rows -> cancelled. A
   * rollback is not a failure - excluded from failed counters/alarms; caller
   * logs ONE summary line with the returned count. `onlyKinds` scopes the
   * cancellation (shadow rollback cancels non-board orders only).
   */
  cancelOpenWorkOrders(reason: string, onlyKinds?: WorkOrderKind[]): number {
    // An explicit empty scope means "cancel nothing", never "cancel all"
    // (review F2 - the fall-through would silently widen a scoped call).
    if (onlyKinds !== undefined && onlyKinds.length === 0) {
      return 0;
    }
    const kindFilter =
      onlyKinds && onlyKinds.length > 0
        ? ` AND source_channel IN (${onlyKinds.map(() => '?').join(',')})`
        : '';
    const kindParams = (onlyKinds ?? []).map((kind) => `${WORKORDER_CHANNEL_PREFIX}${kind}`);
    const result = this.db
      .prepare(
        `UPDATE operator_tasks
         SET status = 'cancelled', latest_event = ?, updated_at = ?
         WHERE kind = 'system' AND status IN ('pending','in_progress')${kindFilter}`
      )
      .run(reason, this.now(), ...kindParams);
    return result.changes;
  }

  /** Per-kind stats for the workorder_status surface. */
  workOrderStats(): Array<{
    workKind: WorkOrderKind;
    lastRunAt: number | null;
    lastStatus: TaskStatus | null;
    failedCount: number;
    lastFailureReason: string | null;
  }> {
    return WORKORDER_KINDS.map((workKind) => {
      const channel = `${WORKORDER_CHANNEL_PREFIX}${workKind}`;
      const last = this.db
        .prepare(
          `SELECT status, updated_at FROM operator_tasks
           WHERE kind = 'system' AND source_channel = ?
           ORDER BY updated_at DESC, id DESC LIMIT 1`
        )
        .get(channel) as { status: string; updated_at: number } | undefined;
      const failed = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM operator_tasks
           WHERE kind = 'system' AND source_channel = ? AND status = 'failed'`
        )
        .get(channel) as { count: number };
      const lastFailure = this.db
        .prepare(
          `SELECT latest_event FROM operator_tasks
           WHERE kind = 'system' AND source_channel = ? AND status = 'failed'
           ORDER BY updated_at DESC, id DESC LIMIT 1`
        )
        .get(channel) as { latest_event: string | null } | undefined;
      return {
        workKind,
        lastRunAt: last?.updated_at ?? null,
        lastStatus: (last?.status as TaskStatus) ?? null,
        failedCount: failed.count,
        lastFailureReason: lastFailure?.latest_event ?? null,
      };
    });
  }

  private getWorkOrderById(id: number): WorkOrderRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM operator_tasks WHERE id = ? AND kind = 'system'`)
      .get(id) as TaskRow | undefined;
    return row ? this.rowToWorkOrder(row) : null;
  }

  private transitionWorkOrder(id: number, status: 'done' | 'failed', reason: string | null): void {
    const row = this.getWorkOrderById(id);
    if (!row) throw new Error(`workorder transition: no system row with id ${id}`);
    if (row.status !== 'in_progress') {
      throw new Error(`workorder transition: row ${id} is '${row.status}', expected in_progress`);
    }
    this.db
      .prepare(
        `UPDATE operator_tasks SET status = ?, latest_event = COALESCE(?, latest_event),
                updated_at = ? WHERE id = ?`
      )
      .run(status, reason, this.now(), id);
  }

  private rowToWorkOrder(row: TaskRow): WorkOrderRecord {
    const workKind = (row.source_channel ?? '').slice(WORKORDER_CHANNEL_PREFIX.length);
    assertEnum(workKind, WORKORDER_KINDS, 'workKind');
    let payload: Record<string, unknown>;
    try {
      payload = row.payload ? (JSON.parse(row.payload) as Record<string, unknown>) : {};
    } catch (error) {
      // No-fallback: a corrupt payload is a real fault, surface it loudly.
      throw new Error(
        `workorder ${row.id}: corrupt payload JSON (${error instanceof Error ? error.message : String(error)})`
      );
    }
    // Strict reads (PR bot round): silently normalizing corrupt ownership or
    // retry metadata would mask a real fault - every row here was written by
    // enqueueWorkOrder, which guarantees both fields.
    if (typeof payload.attempts !== 'number' || payload.attempts < 1) {
      throw new Error(
        `workorder ${row.id}: invalid attempts in payload (${String(payload.attempts)})`
      );
    }
    if (!row.source_event_id) {
      throw new Error(`workorder ${row.id}: missing idempotency key (source_event_id)`);
    }
    return {
      id: row.id,
      workKind: workKind as WorkOrderKind,
      status: row.status as TaskStatus,
      priority: row.priority as TaskPriority,
      idempotencyKey: row.source_event_id,
      payload: { ...payload, attempts: payload.attempts },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** contract_no_update: silence as a verifiable judgment, scoped to one reconcile run. */
  recordNoUpdate(scope: string, reason: string): { id: number } {
    if (!scope || !reason) {
      throw new Error('contract_no_update requires both scope and reason');
    }
    return this.insertNoUpdateNote(scope, reason, this.now());
  }

  private insertNoUpdateNote(scope: string, reason: string, createdAt: number): { id: number } {
    const result = this.db
      .prepare(`INSERT INTO operator_no_update_notes (scope, reason, created_at) VALUES (?, ?, ?)`)
      .run(scope, reason, createdAt);
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
