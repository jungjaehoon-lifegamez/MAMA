/**
 * Progressive task_list views (Task B).
 *
 * The public task_list facade is view-based: `overview` (aggregate counts),
 * `items` (a bounded page of concise rows) and `detail` (full records for a
 * handful of explicit ids, with explicit text continuation). It intentionally
 * supersedes the old public no-limit whole-detail default; the whole board is
 * still fully reachable, but only through explicit pages, never as one implied
 * "the board is..." return. TaskLedger.list/listPage stay the internal
 * whole-board API for existing consumers.
 *
 * Every read is bounded and honest: an items page carries total/returned/
 * nextCursor plus observedAt/readVersion, a cursor is pinned to its normalized
 * query, order and read generation so a changed filter or an intervening write
 * is rejected with restart guidance rather than silently skipping rows, and a
 * long detail field is paged by Unicode code points with total/nextOffset/
 * complete so no tail disappears. Under a Temporal work context the universe is
 * exactly the one host-bound task; foreign ids are generic missing.
 */

import { createHash } from 'node:crypto';
import type { TaskLedger, TaskRecord, ListTasksPageFilter } from './task-ledger.js';
import { DUE_BUCKETS, parseExactDueAt, type DueBucket, type DueState } from './task-dates.js';

const ITEMS_DEFAULT_LIMIT = 25;
const ITEMS_MAX_LIMIT = 50;
const DETAIL_MAX_IDS = 4;
const TEXT_DEFAULT_LIMIT = 1000;
const TEXT_MAX_LIMIT = 2000;
const CURSOR_VERSION = 1 as const;

/** Owner-visible statuses; 'failed' is a system-only terminal and is never a valid filter. */
const PUBLIC_STATUSES = [
  'pending',
  'in_progress',
  'review',
  'blocked',
  'done',
  'cancelled',
] as const;
const PRIORITIES = ['high', 'normal', 'low'] as const;
const ORDERS = ['deadline_priority', 'updated'] as const;
const QUALIFICATIONS = ['qualified', 'legacy_unqualified'] as const;
const VIEWS = ['overview', 'items', 'detail'] as const;
type ViewName = (typeof VIEWS)[number];

export interface TaskListViewContext {
  readonly ledger: TaskLedger;
}

export interface TextWindow {
  readonly value: string;
  /** Unicode code-point offset this window starts at. */
  readonly offset: number;
  /** Requested window size in Unicode code points. */
  readonly limit: number;
  /** Total length of the field in Unicode code points. */
  readonly total: number;
  /** Next code-point offset, or null when this window reaches the field's end. */
  readonly nextOffset: number | null;
  /** True when nothing remains beyond this window (no silent tail). */
  readonly complete: boolean;
}

interface NormalizedFilter {
  status?: (typeof PUBLIC_STATUSES)[number];
  include_terminal?: boolean;
  channel?: string;
  search?: string;
  assignee?: string;
  priority?: (typeof PRIORITIES)[number];
  dueBucket?: DueBucket;
  dueBeforeMs?: number;
  dueAfterMs?: number;
  updatedSinceMs?: number;
  updatedBeforeMs?: number;
  qualification?: (typeof QUALIFICATIONS)[number];
  order: (typeof ORDERS)[number];
}

interface ItemsCursorPayload {
  readonly v: typeof CURSOR_VERSION;
  readonly fp: string;
  readonly order: (typeof ORDERS)[number];
  readonly readVersion: string;
  readonly inner: string;
  readonly temporalAsOfMs?: number;
}

export type TaskListViewResult =
  | (OverviewView & { success: true })
  | (ItemsView & { success: true })
  | (DetailView & { success: true });

interface OverviewView {
  view: 'overview';
  total: number;
  observedAt: string;
  readVersion: string;
  status: Record<string, number>;
  priority: Record<string, number>;
  channels: Array<{ channel: string | null; count: number }>;
  assignees: Array<{ assignee: string | null; count: number }>;
  due: { missing: number; overdue: number; upcoming: number; closed: number };
}

interface ItemsView {
  view: 'items';
  tasks: Array<Record<string, unknown>>;
  total: number;
  returned: number;
  nextCursor: string | null;
  observedAt: string;
  readVersion: string;
}

interface DetailView {
  view: 'detail';
  tasks: Array<Record<string, unknown>>;
  missingIds: number[];
  observedAt: string;
}

/**
 * Single-value serialization for a task DTO (shared with task_create/task_update).
 * Kept here so the detail view and the mutation returns cannot drift apart.
 */
export function serializeTaskToolRecord(task: TaskRecord): Record<string, unknown> {
  return {
    ...task,
    due_at: task.dueAt === null ? null : new Date(task.dueAt).toISOString(),
    deadline_offset_minutes: task.deadlineOffsetMinutes,
    temporal_state: task.dueState,
  };
}

export function runTaskListView(rawInput: unknown, ctx: TaskListViewContext): TaskListViewResult {
  const input = asObject(rawInput, 'task_list');
  const view = parseView(input.view);
  if (view === 'detail') {
    return runDetailView(input, ctx);
  }
  const filter = parseFilter(input);
  if (view === 'overview') {
    return runOverviewView(filter, ctx);
  }
  return runItemsView(input, filter, ctx);
}

// ─── overview ────────────────────────────────────────────────────────────────

function runOverviewView(
  filter: NormalizedFilter,
  ctx: TaskListViewContext
): OverviewView & { success: true } {
  const data = ctx.ledger.overview(toLedgerFilter(filter));
  return {
    success: true,
    view: 'overview',
    total: data.total,
    observedAt: new Date(data.observedAt).toISOString(),
    readVersion: data.readVersion,
    status: data.status,
    priority: data.priority,
    channels: data.channels,
    assignees: data.assignees,
    due: data.due,
  };
}

// ─── items ───────────────────────────────────────────────────────────────────

function runItemsView(
  input: Record<string, unknown>,
  filter: NormalizedFilter,
  ctx: TaskListViewContext
): ItemsView & { success: true } {
  const limit = parseLimit(input.limit);
  const currentFp = filterFingerprint(filter);
  let innerCursor: string | undefined;
  let expectedReadVersion: string | undefined;
  let temporalAsOfMs: number | undefined;
  if (input.cursor !== undefined) {
    const decoded = decodeItemsCursor(
      input.cursor,
      currentFp,
      filter.order,
      filter.dueBucket !== undefined
    );
    innerCursor = decoded.inner;
    expectedReadVersion = decoded.readVersion;
    temporalAsOfMs = decoded.temporalAsOfMs;
  }
  const page = ctx.ledger.itemsPage({
    ...toLedgerFilter(filter),
    limit,
    cursor: innerCursor,
    temporalAsOfMs,
  } as ListTasksPageFilter);
  if (expectedReadVersion !== undefined && expectedReadVersion !== page.readVersion) {
    throw new Error(
      '[task_list] the board changed since this cursor was issued; restart the items read from the first page.'
    );
  }
  return {
    success: true,
    view: 'items',
    tasks: page.tasks.map((task) => compactItem(task)),
    total: page.total,
    returned: page.returned,
    nextCursor:
      page.nextCursor === null
        ? null
        : encodeItemsCursor(
            currentFp,
            filter.order,
            page.readVersion,
            page.nextCursor,
            page.observedAt
          ),
    observedAt: new Date(page.observedAt).toISOString(),
    readVersion: page.readVersion,
  };
}

function compactItem(
  task: TaskRecord,
  dueState: DueState = task.dueState
): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    assignee: task.assignee,
    // Date-only deadlines survive as their ISO date; the exact timestamp is a
    // separate field, so a legacy dated task never reads as undated.
    deadline: task.deadlineIso,
    due_at: task.dueAt === null ? null : new Date(task.dueAt).toISOString(),
    revision: task.revision,
    sourceChannel: task.sourceChannel,
    sourceEventId: task.sourceEventId,
    temporal_state: dueState,
    // Records vs tasks: what would finish this row, and (once terminal) WHY it
    // closed. Without both, a page of rows cannot be judged - completed work and
    // an item that was never a task look identical.
    completion_criteria: task.completionCriteria,
    resolution_kind: task.resolutionKind,
  };
}

// ─── detail ──────────────────────────────────────────────────────────────────

function runDetailView(
  input: Record<string, unknown>,
  ctx: TaskListViewContext
): DetailView & { success: true } {
  const ids = parseDetailIds(input.ids);
  const textOffset = parseNonNegativeInt(input.text_offset, 'text_offset');
  const textLimit = parseBoundedInt(
    input.text_limit,
    'text_limit',
    TEXT_DEFAULT_LIMIT,
    TEXT_MAX_LIMIT
  );
  const observedAt = ctx.ledger.nowMs();
  const tasks: Array<Record<string, unknown>> = [];
  const missingIds: number[] = [];
  for (const id of ids) {
    const record = ctx.ledger.getById(id);
    if (!record) {
      missingIds.push(id);
      continue;
    }
    tasks.push(detailRecord(record, textOffset, textLimit));
  }
  return {
    success: true,
    view: 'detail',
    tasks,
    missingIds,
    observedAt: new Date(observedAt).toISOString(),
  };
}

function detailRecord(
  task: TaskRecord,
  textOffset: number,
  textLimit: number
): Record<string, unknown> {
  return {
    ...serializeTaskToolRecord(task),
    // title/latestEvent become explicit code-point windows so a long reason or
    // title tail is reachable rather than silently truncated.
    title: textWindow(task.title, textOffset, textLimit),
    latestEvent: textWindow(task.latestEvent ?? '', textOffset, textLimit),
  };
}

function textWindow(source: string, offset: number, limit: number): TextWindow {
  const points = Array.from(source);
  const total = points.length;
  const start = Math.min(offset, total);
  const slice = points.slice(start, start + limit);
  const end = start + slice.length;
  const nextOffset = end < total ? end : null;
  return {
    value: slice.join(''),
    offset,
    limit,
    total,
    nextOffset,
    complete: nextOffset === null,
  };
}

// ─── filter / input parsing ───────────────────────────────────────────────────

function parseFilter(input: Record<string, unknown>): NormalizedFilter {
  return {
    status: parseStatus(input.status),
    include_terminal: parseOptionalBoolean(input.include_terminal, 'include_terminal'),
    channel: parseOptionalString(input.channel, 'channel'),
    search: parseOptionalString(input.search, 'search'),
    assignee: parseOptionalString(input.assignee, 'assignee'),
    priority: parsePriority(input.priority),
    dueBucket: parseDueBucket(input.due_bucket),
    dueBeforeMs: parseOptionalStrictTime(input.due_before, 'due_before'),
    dueAfterMs: parseOptionalStrictTime(input.due_after, 'due_after'),
    updatedSinceMs: parseOptionalStrictTime(input.updated_since, 'updated_since'),
    updatedBeforeMs: parseOptionalStrictTime(input.updated_before, 'updated_before'),
    qualification: parseQualification(input.qualification),
    order: parseOrder(input.order),
  };
}

function toLedgerFilter(filter: NormalizedFilter): ListTasksPageFilter {
  return {
    status: filter.status,
    includeTerminal: filter.include_terminal,
    channel: filter.channel,
    search: filter.search,
    assignee: filter.assignee,
    priority: filter.priority,
    dueBucket: filter.dueBucket,
    dueBeforeMs: filter.dueBeforeMs,
    dueAfterMs: filter.dueAfterMs,
    updatedSinceMs: filter.updatedSinceMs,
    updatedBeforeMs: filter.updatedBeforeMs,
    qualification: filter.qualification,
    order: filter.order,
  };
}

function parseView(value: unknown): ViewName {
  if (value === undefined) return 'items';
  if (typeof value !== 'string' || !(VIEWS as readonly string[]).includes(value)) {
    throw new Error(`task_list view must be one of ${VIEWS.join('|')}.`);
  }
  return value as ViewName;
}

function parseStatus(value: unknown): NormalizedFilter['status'] {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(PUBLIC_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`task_list status must be one of ${PUBLIC_STATUSES.join('|')}.`);
  }
  return value as NormalizedFilter['status'];
}

function parsePriority(value: unknown): NormalizedFilter['priority'] {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(PRIORITIES as readonly string[]).includes(value)) {
    throw new Error(`task_list priority must be one of ${PRIORITIES.join('|')}.`);
  }
  return value as NormalizedFilter['priority'];
}

function parseDueBucket(value: unknown): DueBucket | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(DUE_BUCKETS as readonly string[]).includes(value)) {
    throw new Error(`task_list due_bucket must be one of ${DUE_BUCKETS.join('|')}.`);
  }
  return value as DueBucket;
}

function parseOrder(value: unknown): NormalizedFilter['order'] {
  if (value === undefined) return 'deadline_priority';
  if (typeof value !== 'string' || !(ORDERS as readonly string[]).includes(value)) {
    throw new Error(`task_list order must be one of ${ORDERS.join('|')}.`);
  }
  return value as NormalizedFilter['order'];
}

function parseQualification(value: unknown): NormalizedFilter['qualification'] {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(QUALIFICATIONS as readonly string[]).includes(value)) {
    throw new Error(`task_list qualification must be one of ${QUALIFICATIONS.join('|')}.`);
  }
  return value as NormalizedFilter['qualification'];
}

function parseOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`task_list ${field} must be a string.`);
  }
  return value;
}

function parseOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`task_list ${field} must be a boolean.`);
  }
  return value;
}

function parseOptionalStrictTime(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`task_list ${field} must be an RFC 3339 timestamp with an explicit offset.`);
  }
  try {
    return parseExactDueAt(value).dueAt;
  } catch {
    throw new Error(`task_list ${field} must be an RFC 3339 timestamp with an explicit offset.`);
  }
}

function parseLimit(value: unknown): number {
  if (value === undefined) return ITEMS_DEFAULT_LIMIT;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > ITEMS_MAX_LIMIT) {
    throw new Error(`task_list limit must be an integer from 1 to ${ITEMS_MAX_LIMIT}.`);
  }
  return value as number;
}

function parseNonNegativeInt(value: unknown, field: string): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`task_list ${field} must be a non-negative integer.`);
  }
  return value as number;
}

function parseBoundedInt(value: unknown, field: string, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new Error(`task_list ${field} must be an integer from 1 to ${max}.`);
  }
  return value as number;
}

function parseDetailIds(value: unknown): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > DETAIL_MAX_IDS) {
    throw new Error(`task_list detail ids must be an array of 1 to ${DETAIL_MAX_IDS} task ids.`);
  }
  const ids = value.map((entry) => {
    if (!Number.isInteger(entry) || (entry as number) < 1) {
      throw new Error('task_list detail ids must be positive integers.');
    }
    return entry as number;
  });
  if (new Set(ids).size !== ids.length) {
    throw new Error(`task_list detail ids must be ${DETAIL_MAX_IDS} distinct ids at most.`);
  }
  return ids;
}

function asObject(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} input must be an object.`);
  }
  return value as Record<string, unknown>;
}

// ─── cursor ────────────────────────────────────────────────────────────────────

function filterFingerprint(filter: NormalizedFilter): string {
  const canonical = JSON.stringify([
    filter.status ?? null,
    filter.include_terminal ?? null,
    filter.channel ?? null,
    filter.search ?? null,
    filter.assignee ?? null,
    filter.priority ?? null,
    filter.dueBeforeMs ?? null,
    filter.dueAfterMs ?? null,
    filter.updatedSinceMs ?? null,
    ...(filter.updatedBeforeMs === undefined ? [] : [filter.updatedBeforeMs]),
    filter.qualification ?? null,
    filter.order,
    ...(filter.dueBucket === undefined ? [] : [filter.dueBucket]),
  ]);
  return createHash('sha256').update(canonical).digest('base64url').slice(0, 22);
}

function encodeItemsCursor(
  fp: string,
  order: NormalizedFilter['order'],
  readVersion: string,
  inner: string,
  temporalAsOfMs: number
): string {
  const payload: ItemsCursorPayload = {
    v: CURSOR_VERSION,
    fp,
    order,
    readVersion,
    inner,
    temporalAsOfMs,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeItemsCursor(
  rawCursor: unknown,
  currentFp: string,
  order: NormalizedFilter['order'],
  requireTemporalAsOf = false
): ItemsCursorPayload {
  if (typeof rawCursor !== 'string' || rawCursor.length === 0 || rawCursor.length > 4096) {
    throw new Error('[task_list] malformed items cursor; restart from the first page.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8'));
  } catch {
    throw new Error('[task_list] malformed items cursor; restart from the first page.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('[task_list] malformed items cursor; restart from the first page.');
  }
  const cursor = parsed as Partial<ItemsCursorPayload>;
  if (
    cursor.v !== CURSOR_VERSION ||
    typeof cursor.fp !== 'string' ||
    typeof cursor.readVersion !== 'string' ||
    typeof cursor.inner !== 'string' ||
    cursor.order !== order
  ) {
    throw new Error('[task_list] malformed items cursor; restart from the first page.');
  }
  if (
    (cursor.temporalAsOfMs !== undefined && !Number.isSafeInteger(cursor.temporalAsOfMs)) ||
    (requireTemporalAsOf && !Number.isSafeInteger(cursor.temporalAsOfMs))
  ) {
    throw new Error('[task_list] malformed items cursor; restart from the first page.');
  }
  if (cursor.fp !== currentFp) {
    throw new Error(
      '[task_list] this cursor belongs to a different query (filter or order changed); restart from the first page.'
    );
  }
  return cursor as ItemsCursorPayload;
}
