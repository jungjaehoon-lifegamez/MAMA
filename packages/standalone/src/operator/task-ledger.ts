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
  // System-only terminal for workorder rows. Owner rows can never reach it:
  // external create/update guards reject it, so it stays out of owner surfaces.
  'failed',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ['high', 'normal', 'low'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_KINDS = ['owner', 'system'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const WORKORDER_KINDS = ['board', 'wiki', 'memory-curation'] as const;
export type WorkOrderKind = (typeof WORKORDER_KINDS)[number];

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
  kind: string;
  payload: string | null;
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
    kind: (row.kind ?? 'owner') as TaskKind,
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
    // Both construction sites (start.ts boot + operator-handler lazy) run this;
    // busy_timeout here covers BOTH connections against the rebuild race.
    this.db.pragma('busy_timeout = 5000');
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
    return rows.map(rowToRecord);
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
    const now = Date.now();

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
    const existing = this.getRowById(id);
    if (!existing) throw new Error(`task_update: no task with id ${id}`);
    // Stage-2 tamper guards: system workorder rows are host-managed (their
    // transitions go through the workorder API only), and 'failed' can never
    // be set on an owner task from any external surface (REST PATCH + gateway
    // task_update both land here).
    if (existing.kind === 'system') {
      throw new Error(`task_update: task ${id} is a system workorder row (host-managed)`);
    }
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
    assertEnum(order.workKind, WORKORDER_KINDS, 'workKind');
    if (order.priority !== undefined) assertEnum(order.priority, TASK_PRIORITIES, 'priority');
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
    if (open) return this.rowToWorkOrder(open);

    const attempts =
      typeof order.input.attempts === 'number' && order.input.attempts >= 1
        ? order.input.attempts
        : 1;
    const payload = JSON.stringify({ ...order.input, attempts });
    const now = Date.now();
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

  /**
   * Claim the next pending workorder: priority high>normal>low, then id ASC
   * (plan D2/E2 - CASE mapping, never lexicographic on the TEXT enum).
   * pending -> in_progress. Single serial consumer; transaction for atomicity.
   */
  claimNextWorkOrder(): WorkOrderRecord | null {
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
      if (!row) {
        this.db.exec('COMMIT');
        return null;
      }
      this.db
        .prepare(`UPDATE operator_tasks SET status = 'in_progress', updated_at = ? WHERE id = ?`)
        .run(Date.now(), row.id);
      this.db.exec('COMMIT');
      return this.getWorkOrderById(row.id);
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

  /** In-progress system rows at boot = crash artifacts (single serial consumer). */
  listStaleClaims(): WorkOrderRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM operator_tasks WHERE kind = 'system' AND status = 'in_progress'`)
      .all() as TaskRow[];
    return rows.map((row) => this.rowToWorkOrder(row));
  }

  /**
   * Flag-off boot cleanup (plan D3): open system rows -> cancelled. A rollback
   * is not a failure - excluded from failed counters/alarms; caller logs ONE
   * summary line with the returned count.
   */
  cancelOpenWorkOrders(reason: string): number {
    const result = this.db
      .prepare(
        `UPDATE operator_tasks
         SET status = 'cancelled', latest_event = ?, updated_at = ?
         WHERE kind = 'system' AND status IN ('pending','in_progress')`
      )
      .run(reason, Date.now());
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
      .run(status, reason, Date.now(), id);
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
    const attempts =
      typeof payload.attempts === 'number' && payload.attempts >= 1 ? payload.attempts : 1;
    return {
      id: row.id,
      workKind: workKind as WorkOrderKind,
      status: row.status as TaskStatus,
      priority: row.priority as TaskPriority,
      idempotencyKey: row.source_event_id ?? '',
      payload: { ...payload, attempts },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
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
