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
import { parseExactDueAt } from './task-temporal.js';

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
const VIEWS = ['overview', 'items', 'detail'] as const;
type ViewName = (typeof VIEWS)[number];

/** Restriction context: when boundTask is set the universe is exactly that task. */
export interface TaskListViewContext {
  readonly ledger: TaskLedger;
  /** Present only under a Temporal work context; the sole readable owner row. */
  readonly boundTask?: TaskRecord;
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
  dueBeforeMs?: number;
  dueAfterMs?: number;
  updatedSinceMs?: number;
  order: (typeof ORDERS)[number];
}

interface ItemsCursorPayload {
  readonly v: typeof CURSOR_VERSION;
  readonly fp: string;
  readonly order: (typeof ORDERS)[number];
  readonly readVersion: string;
  readonly inner: string;
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
    temporal_epoch: task.temporalEpoch,
    temporal_reconciled_occurrence_key: task.temporalReconciledOccurrenceKey,
    last_temporal_checked_at: task.lastTemporalCheckedAt,
    next_temporal_check_at: task.nextTemporalCheckAt,
    last_temporal_attempt_id: task.lastTemporalAttemptId,
    temporal_state: task.temporalState,
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
  if (ctx.boundTask) {
    return boundOverview(filter, ctx);
  }
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

function boundOverview(
  filter: NormalizedFilter,
  ctx: TaskListViewContext
): OverviewView & { success: true } {
  const task = ctx.boundTask!;
  const observedAt = ctx.ledger.nowMs();
  const matched = boundTaskMatches(task, filter) ? [task] : [];
  const status: Record<string, number> = {};
  const priority: Record<string, number> = {};
  const channels = new Map<string | null, number>();
  const assignees = new Map<string | null, number>();
  const due = { missing: 0, overdue: 0, upcoming: 0, closed: 0 };
  for (const row of matched) {
    status[row.status] = (status[row.status] ?? 0) + 1;
    priority[row.priority] = (priority[row.priority] ?? 0) + 1;
    channels.set(row.sourceChannel, (channels.get(row.sourceChannel) ?? 0) + 1);
    assignees.set(row.assignee, (assignees.get(row.assignee) ?? 0) + 1);
    bucketOf(row.temporalState, due);
  }
  return {
    success: true,
    view: 'overview',
    total: matched.length,
    observedAt: new Date(observedAt).toISOString(),
    readVersion: boundReadVersion(task),
    status,
    priority,
    channels: [...channels].map(([channel, count]) => ({ channel, count })),
    assignees: [...assignees].map(([assignee, count]) => ({ assignee, count })),
    due,
  };
}

function bucketOf(state: TaskRecord['temporalState'], due: OverviewView['due']): void {
  if (state === 'closed') due.closed += 1;
  else if (state === 'unscheduled') due.missing += 1;
  else if (state === 'exact_overdue' || state === 'date_overdue') due.overdue += 1;
  else due.upcoming += 1;
}

// ─── items ───────────────────────────────────────────────────────────────────

function runItemsView(
  input: Record<string, unknown>,
  filter: NormalizedFilter,
  ctx: TaskListViewContext
): ItemsView & { success: true } {
  const limit = parseLimit(input.limit);
  if (ctx.boundTask) {
    return boundItems(filter, limit, input.cursor, ctx);
  }
  const currentFp = filterFingerprint(filter);
  let innerCursor: string | undefined;
  let expectedReadVersion: string | undefined;
  if (input.cursor !== undefined) {
    const decoded = decodeItemsCursor(input.cursor, currentFp, filter.order);
    innerCursor = decoded.inner;
    expectedReadVersion = decoded.readVersion;
  }
  const page = ctx.ledger.itemsPage({
    ...toLedgerFilter(filter),
    limit,
    cursor: innerCursor,
  } as ListTasksPageFilter);
  if (expectedReadVersion !== undefined && expectedReadVersion !== page.readVersion) {
    throw new Error(
      '[task_list] the board changed since this cursor was issued; restart the items read from the first page.'
    );
  }
  return {
    success: true,
    view: 'items',
    tasks: page.tasks.map(compactItem),
    total: page.total,
    returned: page.returned,
    nextCursor:
      page.nextCursor === null
        ? null
        : encodeItemsCursor(currentFp, filter.order, page.readVersion, page.nextCursor),
    observedAt: new Date(page.observedAt).toISOString(),
    readVersion: page.readVersion,
  };
}

function boundItems(
  filter: NormalizedFilter,
  limit: number,
  rawCursor: unknown,
  ctx: TaskListViewContext
): ItemsView & { success: true } {
  const task = ctx.boundTask!;
  const observedAt = ctx.ledger.nowMs();
  const readVersion = boundReadVersion(task);
  // A single-task universe never paginates; a cursor over it can only be one
  // that binds this same generation, and there is never a second page.
  if (rawCursor !== undefined) {
    decodeItemsCursor(rawCursor, filterFingerprint(filter), filter.order);
  }
  const matched = boundTaskMatches(task, filter) ? [task] : [];
  const bounded = matched.slice(0, limit);
  return {
    success: true,
    view: 'items',
    tasks: bounded.map(compactItem),
    total: matched.length,
    returned: bounded.length,
    nextCursor: null,
    observedAt: new Date(observedAt).toISOString(),
    readVersion,
  };
}

function compactItem(task: TaskRecord): Record<string, unknown> {
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
    temporal_state: task.temporalState,
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
    const record = resolveDetailTask(id, ctx);
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

/** Under a Temporal context only the bound id resolves; every other id is generic missing. */
function resolveDetailTask(id: number, ctx: TaskListViewContext): TaskRecord | null {
  if (ctx.boundTask) {
    return ctx.boundTask.id === id ? ctx.boundTask : null;
  }
  return ctx.ledger.getById(id);
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
    dueBeforeMs: parseOptionalStrictTime(input.due_before, 'due_before'),
    dueAfterMs: parseOptionalStrictTime(input.due_after, 'due_after'),
    updatedSinceMs: parseOptionalStrictTime(input.updated_since, 'updated_since'),
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
    dueBeforeMs: filter.dueBeforeMs,
    dueAfterMs: filter.dueAfterMs,
    updatedSinceMs: filter.updatedSinceMs,
    order: filter.order,
  };
}

function boundTaskMatches(task: TaskRecord, filter: NormalizedFilter): boolean {
  if (filter.status !== undefined && task.status !== filter.status) return false;
  if (filter.status === undefined && filter.include_terminal === false) {
    if (task.status === 'done' || task.status === 'cancelled') return false;
  }
  if (filter.channel !== undefined && task.sourceChannel !== filter.channel) return false;
  if (filter.assignee !== undefined && task.assignee !== filter.assignee) return false;
  if (filter.priority !== undefined && task.priority !== filter.priority) return false;
  if (filter.search !== undefined) {
    const needle = filter.search.toLowerCase();
    const hay = `${task.title}\n${task.latestEvent ?? ''}\n${task.assignee ?? ''}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  if (
    filter.dueBeforeMs !== undefined &&
    !(task.dueAt !== null && task.dueAt < filter.dueBeforeMs)
  ) {
    return false;
  }
  if (
    filter.dueAfterMs !== undefined &&
    !(task.dueAt !== null && task.dueAt >= filter.dueAfterMs)
  ) {
    return false;
  }
  if (filter.updatedSinceMs !== undefined && !(task.updatedAt >= filter.updatedSinceMs)) {
    return false;
  }
  return true;
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

function parseOrder(value: unknown): NormalizedFilter['order'] {
  if (value === undefined) return 'deadline_priority';
  if (typeof value !== 'string' || !(ORDERS as readonly string[]).includes(value)) {
    throw new Error(`task_list order must be one of ${ORDERS.join('|')}.`);
  }
  return value as NormalizedFilter['order'];
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
    filter.order,
  ]);
  return createHash('sha256').update(canonical).digest('base64url').slice(0, 22);
}

function encodeItemsCursor(
  fp: string,
  order: NormalizedFilter['order'],
  readVersion: string,
  inner: string
): string {
  const payload: ItemsCursorPayload = { v: CURSOR_VERSION, fp, order, readVersion, inner };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeItemsCursor(
  rawCursor: unknown,
  currentFp: string,
  order: NormalizedFilter['order']
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
  if (cursor.fp !== currentFp) {
    throw new Error(
      '[task_list] this cursor belongs to a different query (filter or order changed); restart from the first page.'
    );
  }
  return cursor as ItemsCursorPayload;
}

function boundReadVersion(task: TaskRecord): string {
  return createHash('sha256')
    .update(`bound:${task.id}:${task.revision}:${task.updatedAt}`)
    .digest('base64url')
    .slice(0, 22);
}
