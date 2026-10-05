import { createHash } from 'node:crypto';
import type { ActionContext, ActionRegistration, ActionSchemaObject } from '@jungjaehoon/mama-core';
import type { TimeZoneSetting } from '../runtime/timezone.js';
import { epochAtLocalDateTime, localDateKey } from '../runtime/timezone.js';
import { recordLinkSchema, scopeRefSchema } from '@jungjaehoon/mama-core/api/catalog';
import {
  JudgmentError,
  TWIN_EDGE_TYPES,
  type CommitmentView,
  type JudgmentAccess,
  type CreateWorkCommand,
  type Knowledge,
  type OwnerWorkPatch,
  type ReviseWorkCommand,
  type WorkRead,
} from '@jungjaehoon/mama-core/knowledge';

export interface WorkPorts {
  knowledge: Pick<Knowledge, 'createWork' | 'reviseWork' | 'readWork' | 'appendLink' | 'findLink'>;
  /** sourceRefs are observationRef handles; core stores them unchecked, so the product checks them. */
  observationExists: (observationId: string) => boolean;
}

export interface WorkListPorts {
  knowledge: Pick<Knowledge, 'readWork' | 'queryGraph'>;
  timeZone: TimeZoneSetting;
}

export interface WorkListViewContext {
  readonly knowledge: Pick<Knowledge, 'readWork' | 'queryGraph'>;
  readonly access: JudgmentAccess;
  readonly now?: () => number;
  readonly timeZone: string;
}

export interface WorkListTextWindow {
  readonly value: string;
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
  readonly nextOffset: number | null;
  readonly complete: boolean;
}

type PublicWorkStatus = 'pending' | 'in_progress' | 'review' | 'blocked' | 'done' | 'cancelled';

interface WorkListFilter {
  readonly status?: readonly PublicWorkStatus[];
  readonly stage?: string;
  readonly project?: string;
  readonly text?: string;
  readonly asOf?: number;
  /** Items written at or after this epoch-ms instant: what an orchestrated turn changed. */
  readonly changedSince?: number;
  /** Items last written before this epoch-ms instant: work that has not moved since. */
  readonly changedBefore?: number;
  /** Open items by their deadline against the owner's today; closed items never match. */
  readonly due?: WorkListDue;
  /**
   * Items with a revision whose source event time falls in [eventSince, eventBefore): what
   * happened in a span. Write time is not event time: a replay or backfill writes a month of
   * September events on one day.
   */
  readonly eventSince?: number;
  readonly eventBefore?: number;
}

const WORK_LIST_DUE = ['overdue', 'today', 'upcoming', 'unscheduled'] as const;
type WorkListDue = (typeof WORK_LIST_DUE)[number];

interface WorkListCursor {
  readonly v: 1;
  readonly filter: string;
  /** The first page's filter, so a continuation may pass the cursor alone. */
  readonly query?: WorkListFilter;
  readonly readVersion: string;
  readonly offset: number;
}

interface WorkListSnapshot {
  readonly items: readonly CommitmentView[];
  readonly readVersion: string;
  readonly observedAt: number;
}

interface WorkListOverview {
  success: true;
  view: 'overview';
  total: number;
  observedAt: string;
  readVersion: string;
  status: Record<PublicWorkStatus, number>;
  priority: Record<string, number>;
  channels: Array<{ channel: string | null; count: number }>;
  assignees: Array<{ assignee: string | null; count: number }>;
  due: { missing: number; overdue: number; upcoming: number; closed: number };
}

interface WorkListItems {
  success: true;
  view: 'items';
  tasks: Array<Record<string, unknown>>;
  total: number;
  returned: number;
  nextCursor: string | null;
  observedAt: string;
  readVersion: string;
}

interface WorkListDetail {
  success: true;
  view: 'detail';
  tasks: Array<Record<string, unknown>>;
  missingIds: Array<string | number>;
  observedAt: string;
}

interface WorkListPipeline {
  success: true;
  view: 'pipeline';
  fields: readonly [
    'commitmentId',
    'title',
    'status',
    'assignee',
    'deadline',
    'latest_change',
    'latest_event',
  ];
  stages: Array<{ stage: string; count: number; rows: unknown[][] }>;
  total: number;
  observedAt: string;
}

export interface WorkListLinks {
  success: true;
  view: 'links';
  items: Array<Record<string, unknown>>;
  missingIds: Array<string | number>;
}

export type WorkListViewResult =
  | WorkListOverview
  | WorkListItems
  | WorkListDetail
  | WorkListPipeline
  | WorkListLinks;

const WORK_LIST_DEFAULT_LIMIT = 25;
const WORK_LIST_MAX_LIMIT = 50;
const WORK_LIST_MAX_DETAIL_IDS = 4;
const WORK_LIST_DEFAULT_TEXT_LIMIT = 1_000;
const WORK_LIST_REVISION_SUMMARY_LIMIT = 300;
const WORK_LIST_EVENT_REVISIONS = 20;
const WORK_LIST_MAX_TEXT_LIMIT = 2_000;
/** The statuses of open work: everything but done and cancelled. */
export const OPEN_WORK_STATUSES = ['pending', 'in_progress', 'review', 'blocked'] as const;
const WORK_LIST_STATUSES: readonly PublicWorkStatus[] = [
  ...OPEN_WORK_STATUSES,
  'done',
  'cancelled',
];
const WORK_LIST_PRIORITIES = ['high', 'normal', 'low'] as const;

function workListObject(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('work.list input must be an object');
  }
  return value as Record<string, unknown>;
}

function workListString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`work.list ${field} must be a string`);
  return value;
}

function workListStatuses(value: unknown): readonly PublicWorkStatus[] | undefined {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) {
    throw new Error('work.list status must contain at least one status');
  }
  const statuses = values.map((candidate) => {
    if (typeof candidate !== 'string') {
      throw new Error('work.list status must be a string or an array of strings');
    }
    if (!WORK_LIST_STATUSES.includes(candidate as PublicWorkStatus)) {
      throw new Error(`work.list status must be one of ${WORK_LIST_STATUSES.join('|')}`);
    }
    return candidate as PublicWorkStatus;
  });
  return [...new Set(statuses)];
}

function workListInteger(
  value: unknown,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`work.list ${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function workListNonNegativeInteger(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`work.list ${field} must be a non-negative integer`);
  }
  return value as number;
}

function workListAsOf(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('work.list asOf must be a non-negative epoch-millisecond integer');
  }
  return value as number;
}

/**
 * A changed-since/before bound as epoch ms or a timezone-qualified ISO time, as source.recent
 * takes: on 2026-09-29 the agent passed "2026-09-29T00:00:00+09:00" and the call failed.
 */
function workListTime(value: unknown, field: string): number {
  const parsed = offsetIsoTime(value);
  if (parsed !== undefined) return parsed;
  if (Number.isSafeInteger(value) && (value as number) >= 0) return value as number;
  throw new Error(`work.list ${field} must be epoch milliseconds or an ISO time with its offset`);
}

const OFFSET_ISO_PATTERN =
  '^(\\d{4})-(\\d{2})-(\\d{2})[T ](\\d{2}):(\\d{2})(?::\\d{2}(?:\\.\\d{1,3})?)?(Z|([+-])(\\d{2}):(\\d{2}))$';

/** An ISO time that states its offset (Z or ±HH:MM), as epoch ms; undefined for anything else. */
export function offsetIsoTime(value: unknown): number | undefined {
  const match = typeof value === 'string' ? new RegExp(OFFSET_ISO_PATTERN).exec(value) : null;
  if (!match) return undefined;
  const parsed = Date.parse(match[0].replace(' ', 'T'));
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  // Date.parse rolls an impossible date or hour forward (Feb 30 becomes Mar 2): the wall time
  // at the stated offset must read back as written.
  const [, year, month, day, hour, minute, zone, sign, offsetHours, offsetMinutes] = match;
  const offset =
    zone === 'Z' ? 0 : (sign === '-' ? -1 : 1) * (Number(offsetHours) * 60 + Number(offsetMinutes));
  const wall = new Date(parsed + offset * 60_000);
  const readBack = [
    wall.getUTCFullYear(),
    wall.getUTCMonth() + 1,
    wall.getUTCDate(),
    wall.getUTCHours(),
    wall.getUTCMinutes(),
  ];
  const written = [year, month, day, hour, minute].map(Number);
  return readBack.every((part, index) => part === written[index]) ? parsed : undefined;
}

function workListFilter(input: Record<string, unknown>): WorkListFilter {
  const status = workListStatuses(input.status);
  return {
    ...(status === undefined ? {} : { status }),
    ...(input.stage === undefined ? {} : { stage: workListString(input.stage, 'stage') }),
    ...(input.project === undefined ? {} : { project: workListString(input.project, 'project') }),
    ...(input.text === undefined ? {} : { text: workListString(input.text, 'text') }),
    ...(input.asOf === undefined ? {} : { asOf: workListAsOf(input.asOf) }),
    ...(input.changedSince === undefined
      ? {}
      : { changedSince: workListTime(input.changedSince, 'changedSince') }),
    ...(input.changedBefore === undefined
      ? {}
      : { changedBefore: workListTime(input.changedBefore, 'changedBefore') }),
    ...(input.due === undefined ? {} : { due: workListDueFilter(input.due) }),
    ...(input.eventSince === undefined
      ? {}
      : { eventSince: workListTime(input.eventSince, 'eventSince') }),
    ...(input.eventBefore === undefined
      ? {}
      : { eventBefore: workListTime(input.eventBefore, 'eventBefore') }),
  };
}

/** An item's revisions in the span, the newest 20 with the count: one item moved 51 times in a day. */
function workListEventPage(item: CommitmentView, filter: WorkListFilter): Record<string, unknown> {
  const revisions = workListEventRevisions(item, filter);
  return {
    revisions: revisions.slice(-WORK_LIST_EVENT_REVISIONS),
    revisionsTotal: revisions.length,
  };
}

function workListEventBounded(filter: WorkListFilter): boolean {
  return filter.eventSince !== undefined || filter.eventBefore !== undefined;
}

/** The revisions in the event bounds; a revision with no event time counts at its write time. */
function workListEventRevisions(
  item: CommitmentView,
  filter: WorkListFilter
): Array<Record<string, unknown>> {
  return (item.chain ?? []).flatMap((entry) => {
    const at = entry.eventDatetime ?? entry.createdAt;
    if (filter.eventSince !== undefined && at < filter.eventSince) return [];
    if (filter.eventBefore !== undefined && at >= filter.eventBefore) return [];
    const summary =
      entry.summary !== null && entry.summary.length > WORK_LIST_REVISION_SUMMARY_LIMIT
        ? `${entry.summary.slice(0, WORK_LIST_REVISION_SUMMARY_LIMIT - 1)}…`
        : entry.summary;
    return [{ revision: entry.revision, at, status: entry.status, stage: entry.stage, summary }];
  });
}

function workListDueFilter(value: unknown): WorkListDue {
  if (typeof value !== 'string' || !(WORK_LIST_DUE as readonly string[]).includes(value)) {
    throw new Error(`work.list due must be one of ${WORK_LIST_DUE.join('|')}`);
  }
  return value as WorkListDue;
}

function workListValueObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function workListText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function workListNormalizedText(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

function workListTokens(value: string): string[] {
  const normalized = workListNormalizedText(value)
    .replace(/([\p{L}])([\p{N}])/gu, '$1 $2')
    .replace(/([\p{N}])([\p{L}])/gu, '$1 $2');
  return normalized.split(/[^\p{L}\p{N}]+/gu).filter((token) => token.length > 0);
}

function workListSearchFields(item: CommitmentView): { title: string; description: string } {
  const values = workListValueObject(item.values);
  return {
    title: workListText(values.title) ?? '',
    description: workListText(values.description) ?? '',
  };
}

function workListLexicalScore(
  query: string,
  fields: { title: string; description: string }
): number {
  const queryTokens = [...new Set(workListTokens(query))];
  if (queryTokens.length === 0) {
    throw new Error('work.list text must contain searchable text');
  }
  const fieldText = `${fields.title}\n${fields.description}`;
  const fieldTokens = new Set(workListTokens(fieldText));
  const overlap = queryTokens.filter((token) => fieldTokens.has(token)).length / queryTokens.length;
  const compactQuery = workListNormalizedText(query).replace(/[^\p{L}\p{N}]+/gu, '');
  const exactSubstringBonus =
    compactQuery.length > 0 &&
    [fields.title, fields.description].some((field) =>
      workListNormalizedText(field)
        .replace(/[^\p{L}\p{N}]+/gu, '')
        .includes(compactQuery)
    )
      ? 0.2
      : 0;
  return Math.min(1, overlap * 0.8 + exactSubstringBonus);
}

function workListStatus(item: CommitmentView): PublicWorkStatus {
  if (item.withdrawn) return 'cancelled';
  const value = workListValueObject(item.values).status;
  if (typeof value === 'string' && WORK_LIST_STATUSES.includes(value as PublicWorkStatus)) {
    return value as PublicWorkStatus;
  }
  if (value !== undefined && value !== null) {
    throw new Error(
      `work.list encountered a status outside the contract: ${JSON.stringify(value)}`
    );
  }
  return 'pending';
}

function workListPriority(item: CommitmentView): string {
  const value = workListText(workListValueObject(item.values).priority);
  return value !== null &&
    WORK_LIST_PRIORITIES.includes(value as (typeof WORK_LIST_PRIORITIES)[number])
    ? value
    : 'normal';
}

function workListEventTime(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return Date.parse(value);
  return null;
}

function workListIso(value: unknown): string | null {
  const ms = workListEventTime(value);
  return ms === null ? null : new Date(ms).toISOString();
}

/** The day an item is due in the owner's zone: its exact due time decides, as it does for the due state. */
function workListDueDate(values: Record<string, unknown>, timeZone: string): string | null {
  const exact = workListEventTime(values.dueAt ?? values.due_at);
  if (exact !== null) return localDateKey(exact, timeZone);
  return workListText(values.deadline ?? values.due_date);
}

function workListDueState(
  item: CommitmentView,
  now: number,
  timeZone: string
):
  | 'closed'
  | 'exact_upcoming'
  | 'exact_overdue'
  | 'date_upcoming'
  | 'date_due'
  | 'date_overdue'
  | 'unscheduled' {
  const status = workListStatus(item);
  if (status === 'done' || status === 'cancelled') return 'closed';
  const values = workListValueObject(item.values);
  const exact = workListEventTime(values.dueAt ?? values.due_at);
  if (exact !== null) return exact > now ? 'exact_upcoming' : 'exact_overdue';
  const deadline = workListText(values.deadline ?? values.due_date);
  if (deadline === null || !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return 'unscheduled';
  const deadlineMs = epochAtLocalDateTime(`${deadline}T00:00:00`, timeZone);
  if (!Number.isFinite(deadlineMs)) return 'unscheduled';
  const today = localDateKey(now, timeZone);
  if (deadline > today) return 'date_upcoming';
  if (deadline === today) return 'date_due';
  return 'date_overdue';
}

function workListCompact(
  item: CommitmentView,
  now: number,
  score: number | undefined,
  timeZone: string
): Record<string, unknown> {
  const values = workListValueObject(item.values);
  const status = workListStatus(item);
  const assignee = workListText(values.assignee ?? values.assigneeText ?? values.assignee_text);
  const deadline = workListText(values.deadline ?? values.due_date);
  const sourceChannel = workListText(values.sourceChannel ?? values.source_channel);
  const sourceEventId = workListText(values.sourceEventId ?? values.source_event_id);
  const latestEvent = workListText(values.latestEvent ?? values.latest_event);
  const compact: Record<string, unknown> = {
    id: item.rowId,
    commitmentId: item.commitmentId,
    revision: item.revision,
    title: workListText(values.title),
    status,
    stage: workListText(values.stage),
    project: workListText(values.project),
    temporal_state: workListDueState(item, now, timeZone),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
  const priority = workListPriority(item);
  if (priority !== 'normal') compact.priority = priority;
  const optional: Array<[string, unknown]> = [
    ['assignee', assignee],
    ['deadline', deadline],
    ['due_at', workListIso(values.dueAt ?? values.due_at)],
    [
      'deadline_offset_minutes',
      typeof values.deadlineOffsetMinutes === 'number'
        ? values.deadlineOffsetMinutes
        : typeof values.deadline_offset_minutes === 'number'
          ? values.deadline_offset_minutes
          : null,
    ],
    ['sourceChannel', sourceChannel],
    ['sourceEventId', sourceEventId],
    ['completion_criteria', workListText(values.completionCriteria ?? values.completion_criteria)],
    ['resolution_kind', workListText(values.resolutionKind ?? values.resolution_kind)],
    ['latest_event', latestEvent?.replace(/\s+/g, ' ').trim() ?? null],
    ['lastEventTime', values.lastEventTime ?? values.last_event_time],
  ];
  for (const [key, value] of optional) {
    if (value !== null && value !== undefined) compact[key] = value;
  }
  if (values.autoCreated === true || values.auto_created === true) compact.auto_created = true;
  if (values.confirmed === true) compact.confirmed = true;
  if (item.withdrawn) compact.withdrawn = true;
  if (score !== undefined) compact.score = score;
  return compact;
}

function workListMatches(
  item: CommitmentView,
  filter: WorkListFilter,
  now: number,
  timeZone: string
): boolean {
  const values = workListValueObject(item.values);
  if (filter.status !== undefined && !filter.status.includes(workListStatus(item))) return false;
  if (filter.stage !== undefined && workListText(values.stage) !== filter.stage) return false;
  if (filter.project !== undefined && workListText(values.project) !== filter.project) return false;
  if (filter.changedSince !== undefined && item.updatedAt < filter.changedSince) return false;
  if (filter.changedBefore !== undefined && item.updatedAt >= filter.changedBefore) return false;
  if (filter.due !== undefined && workListDueGroup(item, now, timeZone) !== filter.due)
    return false;
  if (workListEventBounded(filter) && workListEventRevisions(item, filter).length === 0)
    return false;
  return true;
}

function workListDueGroup(item: CommitmentView, now: number, timeZone: string): WorkListDue | null {
  const state = workListDueState(item, now, timeZone);
  if (state === 'closed') return null;
  if (state === 'unscheduled') return 'unscheduled';
  if (state === 'date_due') return 'today';
  if (state === 'exact_upcoming') {
    const values = workListValueObject(item.values);
    const exact = workListEventTime(values.dueAt ?? values.due_at)!;
    return localDateKey(exact, timeZone) === localDateKey(now, timeZone) ? 'today' : 'upcoming';
  }
  return state.endsWith('overdue') ? 'overdue' : 'upcoming';
}

interface WorkListRankedItem {
  readonly item: CommitmentView;
  readonly score?: number;
}

/**
 * Rank by the owner's words, not by substring: token overlap after NFKC and
 * splitting on spaces, underscores, punctuation and letter/number boundaries,
 * plus a bonus when the query is contained with separators removed. An item
 * sharing no token is not a match. Embeddings were measured and dropped: on
 * the live ledger e5 gave every title ~0.8 cosine (no separation, a
 * transliterated Korean name ranked a different item first) and the first
 * query embedded all items for 80 s.
 */
function workListRankedItems(
  items: readonly CommitmentView[],
  filter: WorkListFilter,
  now: number,
  timeZone: string
): readonly WorkListRankedItem[] {
  const filtered = items.filter((item) => workListMatches(item, filter, now, timeZone));
  if (filter.text === undefined) return filtered.map((item) => ({ item }));
  const query = filter.text;
  return filtered
    .map((item) => ({ item, score: workListLexicalScore(query, workListSearchFields(item)) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || right.item.updatedAt - left.item.updatedAt);
}

/**
 * The query a cursor belongs to. A due filter depends on the owner's today, so its day is part of
 * the query: a page read after midnight restarts instead of skipping items that changed group.
 */
function workListFingerprint(filter: WorkListFilter, dueDay: string | null): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        dueDay,
        filter.status === undefined ? null : [...filter.status].sort(),
        filter.stage ?? null,
        filter.project ?? null,
        filter.text ?? null,
        filter.asOf ?? null,
        filter.changedSince ?? null,
        filter.changedBefore ?? null,
        filter.due ?? null,
        filter.eventSince ?? null,
        filter.eventBefore ?? null,
      ])
    )
    .digest('base64url')
    .slice(0, 22);
}

function workListReadVersion(items: readonly CommitmentView[]): string {
  const state = items.map((item) => ({
    commitmentId: item.commitmentId,
    rowId: item.rowId,
    revision: item.revision,
    latestJudgmentRef: item.latestJudgmentRef,
    values: item.values,
    withdrawn: item.withdrawn,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }));
  return createHash('sha256').update(JSON.stringify(state)).digest('base64url');
}

function workListReadSnapshot(ctx: WorkListViewContext, filter: WorkListFilter): WorkListSnapshot {
  const items: CommitmentView[] = [];
  const incompleteReasons: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const query: WorkRead = {
      // The chain carries each revision's event time and summary, read only for an event span.
      history: workListEventBounded(filter) ? 'chain' : 'current',
      limit: 100,
      ...(filter.asOf === undefined ? {} : { asOf: filter.asOf }),
      ...(cursor === undefined ? {} : { cursor }),
    };
    const page = ctx.knowledge.readWork(query, ctx.access);
    items.push(...page.items);
    incompleteReasons.push(
      ...page.coverage.reasons.filter((reason) => reason !== 'more commitments follow this page')
    );
    if (incompleteReasons.length > 0) {
      throw new Error(`work.list read is incomplete: ${incompleteReasons.join('; ')}`);
    }
    if (page.nextCursor === null) {
      break;
    }
    cursor = page.nextCursor;
  }
  const observedAt = ctx.now?.() ?? Date.now();
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) {
    throw new Error('work.list observed time must be a non-negative epoch-millisecond integer');
  }
  return { items: Object.freeze(items), readVersion: workListReadVersion(items), observedAt };
}

function encodeWorkListCursor(cursor: WorkListCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** The filter a cursor carries; malformed cursors are rejected by decodeWorkListCursor. */
function workListCursorQuery(value: unknown): WorkListFilter | undefined {
  if (typeof value !== 'string' || value === '' || value.length > 4_096) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  const query = (parsed as { query?: unknown } | null)?.query;
  return query !== null && typeof query === 'object' && !Array.isArray(query)
    ? workListFilter(query as Record<string, unknown>)
    : undefined;
}

function decodeWorkListCursor(
  value: unknown,
  filter: WorkListFilter,
  dueDay: string | null
): WorkListCursor {
  if (value === '') {
    throw new Error('work.list cursor is empty; omit cursor to start from the first page');
  }
  if (typeof value !== 'string' || value.length > 4_096) {
    throw new Error('work.list cursor is malformed; restart the items read from the first page');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new Error('work.list cursor is malformed; restart the items read from the first page');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('work.list cursor is malformed; restart the items read from the first page');
  }
  const candidate = parsed as Partial<WorkListCursor>;
  if (
    candidate.v !== 1 ||
    typeof candidate.filter !== 'string' ||
    typeof candidate.readVersion !== 'string' ||
    !Number.isSafeInteger(candidate.offset) ||
    (candidate.offset as number) < 0
  ) {
    throw new Error('work.list cursor is malformed; restart the items read from the first page');
  }
  if (candidate.filter !== workListFingerprint(filter, dueDay)) {
    throw new Error(
      'work.list cursor belongs to a different query; restart the items read from the first page'
    );
  }
  return candidate as WorkListCursor;
}

function workListTextWindow(value: string, offset: number, limit: number): WorkListTextWindow {
  const points = Array.from(value);
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

function workListDetailIds(value: unknown): Array<string | number> {
  if (!Array.isArray(value) || value.length < 1 || value.length > WORK_LIST_MAX_DETAIL_IDS) {
    throw new Error(`work.list detail ids must contain 1 to ${WORK_LIST_MAX_DETAIL_IDS} ids`);
  }
  const ids = value.map((id) => {
    if (
      (typeof id !== 'string' && typeof id !== 'number') ||
      (typeof id === 'string' && id.trim() === '') ||
      (typeof id === 'number' && (!Number.isSafeInteger(id) || id < 1))
    ) {
      throw new Error('work.list detail ids must be nonblank commitment ids or positive row ids');
    }
    return id;
  });
  if (new Set(ids).size !== ids.length) throw new Error('work.list detail ids must be distinct');
  return ids;
}

/**
 * Detail answers one level at a time: the newest revisions and evidence, with their totals and the
 * offset of the next page. On 2026-09-29 one detail read of a 52-revision item returned 50,746
 * characters, every revision's values included.
 */
const WORK_LIST_DETAIL_HISTORY_PAGE = 5;
const WORK_LIST_DETAIL_BASIS_RECENT = 20;

function workListDetailRecord(
  item: CommitmentView,
  textOffset: number,
  textLimit: number,
  historyOffset: number,
  now: number,
  timeZone: string
): Record<string, unknown> {
  if (item.history === undefined)
    throw new Error('work.list detail did not return revision history');
  const values = workListValueObject(item.values);
  // The text fields are given once, as windows, above the other values.
  const otherValues = Object.fromEntries(
    Object.entries(values).filter(
      ([field]) => !['title', 'description', 'latestEvent'].includes(field)
    )
  );
  const newestFirst = [...item.history].reverse();
  const historyPage = newestFirst.slice(
    historyOffset,
    historyOffset + WORK_LIST_DETAIL_HISTORY_PAGE
  );
  const historyNext = historyOffset + historyPage.length;
  const compact = workListCompact(item, now, undefined, timeZone);
  return {
    ...compact,
    title:
      typeof values.title === 'string'
        ? workListTextWindow(values.title, textOffset, textLimit)
        : null,
    description:
      typeof values.description === 'string'
        ? workListTextWindow(values.description, textOffset, textLimit)
        : null,
    latestEvent:
      typeof values.latestEvent === 'string'
        ? workListTextWindow(values.latestEvent, textOffset, textLimit)
        : null,
    values: otherValues,
    basis: item.basis.slice(-WORK_LIST_DETAIL_BASIS_RECENT),
    basisTotal: item.basis.length,
    history: historyPage,
    historyTotal: newestFirst.length,
    historyNextOffset: historyNext < newestFirst.length ? historyNext : null,
    latestJudgmentRef: item.latestJudgmentRef,
  };
}

/**
 * One step of the walk: every link written from or to any revision of the item, with the relation,
 * the reason, who wrote it, its evidence, any later correction, and the other end. A link sits on
 * the revision that wrote it, so every revision is a seed; source citations (derived_from) and the
 * item's own records are left out, and a correction shows on the link it corrects.
 */
function workListLinks(input: Record<string, unknown>, ctx: WorkListViewContext): WorkListLinks {
  const ids = workListDetailIds(input.ids);
  const items: Array<Record<string, unknown>> = [];
  const missingIds: Array<string | number> = [];
  const otherItems = new Map<string, Record<string, unknown>>();
  for (const id of ids) {
    const page = ctx.knowledge.readWork(
      { history: 'all', ...(typeof id === 'number' ? { rowId: id } : { commitmentId: id }) },
      ctx.access
    );
    const item = page.items[0];
    if (item === undefined || item.history === undefined) {
      missingIds.push(id);
      continue;
    }
    const own = new Set(item.history.map((revision) => revision.recordRef.id));
    const graph = ctx.knowledge.queryGraph(
      {
        view: 'neighbors',
        seeds: item.history.map((revision) => revision.recordRef),
        maxDepth: 1,
        direction: 'both',
        relations: TWIN_EDGE_TYPES.filter((relation) => relation !== 'derived_from'),
        history: 'all',
        limit: 500,
      },
      ctx.access
    );
    const nodes = new Map(graph.nodes.map((node) => [`${node.ref.kind}:${node.ref.id}`, node]));
    const links: Array<Record<string, unknown>> = [];
    for (const edge of graph.edges) {
      const out = own.has(edge.from.id);
      if (!out && !own.has(edge.to.id)) continue;
      const other = out ? edge.to : edge.from;
      if (other.kind === 'edge' || (other.kind === 'memory' && own.has(other.id))) continue;
      const attrs = (edge.attrs ?? {}) as Record<string, unknown>;
      const written = (attrs.relation_attrs ?? {}) as Record<string, unknown>;
      const node = nodes.get(`${other.kind}:${other.id}`);
      const data = node?.data as { work?: { commitmentId?: string } } | undefined;
      const commitmentId = other.kind === 'memory' ? data?.work?.commitmentId : undefined;
      if (commitmentId !== undefined && commitmentId === item.commitmentId) continue;
      const reason =
        typeof written.reason === 'string'
          ? written.reason
          : typeof attrs.reason_text === 'string'
            ? attrs.reason_text
            : null;
      links.push({
        edgeId: edge.id,
        relation: edge.relation,
        direction: out ? 'out' : 'in',
        reason,
        ...(typeof written.role === 'string' ? { role: written.role } : {}),
        source: attrs.source ?? null,
        ...(attrs.evidence_refs ? { evidenceRefs: attrs.evidence_refs } : {}),
        ...(attrs.corrected_by ? { correctedBy: attrs.corrected_by } : {}),
        other:
          commitmentId !== undefined
            ? { kind: 'work', commitmentId }
            : { kind: other.kind, id: other.id, name: node?.label ?? null },
      });
      if (commitmentId !== undefined) otherItems.set(commitmentId, {});
    }
    items.push({
      commitmentId: item.commitmentId,
      title: workListText(workListValueObject(item.values).title),
      revisions: item.history.length,
      links,
      coverage: graph.coverage,
    });
  }
  // The other items' current title and status, so the next step can be chosen without opening them.
  for (const commitmentId of otherItems.keys()) {
    const found = ctx.knowledge.readWork({ commitmentId }, ctx.access).items[0];
    if (found !== undefined)
      otherItems.set(commitmentId, {
        title: workListText(workListValueObject(found.values).title),
        status: workListStatus(found),
      });
  }
  for (const item of items)
    for (const link of item.links as Array<{ other: Record<string, unknown> }>)
      if (link.other.kind === 'work')
        Object.assign(link.other, otherItems.get(link.other.commitmentId as string) ?? {});
  return { success: true, view: 'links', items, missingIds };
}

function workListDetail(input: Record<string, unknown>, ctx: WorkListViewContext): WorkListDetail {
  const ids = workListDetailIds(input.ids);
  const textOffset = workListNonNegativeInteger(input.text_offset, 'text_offset', 0);
  const textLimit = workListInteger(
    input.text_limit,
    'text_limit',
    WORK_LIST_DEFAULT_TEXT_LIMIT,
    1,
    WORK_LIST_MAX_TEXT_LIMIT
  );
  const historyOffset = workListNonNegativeInteger(input.history_offset, 'history_offset', 0);
  const asOf = workListAsOf(input.asOf);
  const now = ctx.now?.() ?? Date.now();
  const tasks: Array<Record<string, unknown>> = [];
  const missingIds: Array<string | number> = [];
  for (const id of ids) {
    const query: WorkRead = {
      history: 'all',
      ...(asOf === undefined ? {} : { asOf }),
      ...(typeof id === 'number' ? { rowId: id } : { commitmentId: id }),
    };
    const page = ctx.knowledge.readWork(query, ctx.access);
    const item = page.items[0];
    if (item === undefined) {
      missingIds.push(id);
      continue;
    }
    tasks.push(workListDetailRecord(item, textOffset, textLimit, historyOffset, now, ctx.timeZone));
  }
  return {
    success: true,
    view: 'detail',
    tasks,
    missingIds,
    observedAt: new Date(now).toISOString(),
  };
}

function workListOverview(
  snapshot: WorkListSnapshot,
  rankedItems: readonly WorkListRankedItem[],
  now: number,
  timeZone: string
): WorkListOverview {
  const items = rankedItems.map(({ item }) => item);
  const status = Object.fromEntries(WORK_LIST_STATUSES.map((name) => [name, 0])) as Record<
    PublicWorkStatus,
    number
  >;
  const priority = Object.fromEntries(WORK_LIST_PRIORITIES.map((name) => [name, 0])) as Record<
    string,
    number
  >;
  const channels = new Map<string | null, number>();
  const assignees = new Map<string | null, number>();
  const due = { missing: 0, overdue: 0, upcoming: 0, closed: 0 };
  for (const item of items) {
    const values = workListValueObject(item.values);
    const itemStatus = workListStatus(item);
    status[itemStatus] += 1;
    const itemPriority = workListPriority(item);
    priority[itemPriority] = (priority[itemPriority] ?? 0) + 1;
    const channel = workListText(values.sourceChannel ?? values.source_channel);
    channels.set(channel, (channels.get(channel) ?? 0) + 1);
    const assignee = workListText(values.assignee ?? values.assigneeText ?? values.assignee_text);
    assignees.set(assignee, (assignees.get(assignee) ?? 0) + 1);
    const temporal = workListDueState(item, now, timeZone);
    if (temporal === 'closed') due.closed += 1;
    else if (temporal === 'unscheduled') due.missing += 1;
    else if (temporal.endsWith('overdue')) due.overdue += 1;
    else due.upcoming += 1;
  }
  const sortedFacet = (values: Map<string | null, number>) =>
    [...values.entries()]
      .sort((left, right) => String(left[0] ?? '').localeCompare(String(right[0] ?? '')))
      .map(([value, count]) => ({
        [values === channels ? 'channel' : 'assignee']: value,
        count,
      })) as Array<{
      channel: string | null;
      assignee: string | null;
      count: number;
    }>;
  const channelRows = sortedFacet(channels).map((row) => ({
    channel: row.channel,
    count: row.count,
  }));
  const assigneeRows = sortedFacet(assignees).map((row) => ({
    assignee: row.assignee,
    count: row.count,
  }));
  return {
    success: true,
    view: 'overview',
    total: items.length,
    observedAt: new Date(snapshot.observedAt).toISOString(),
    readVersion: snapshot.readVersion,
    status,
    priority,
    channels: channelRows,
    assignees: assigneeRows,
    due,
  };
}

export async function runWorkListView(
  rawInput: unknown,
  ctx: WorkListViewContext
): Promise<WorkListViewResult> {
  const input = workListObject(rawInput);
  const view = input.view === undefined ? 'items' : input.view;
  if (
    view !== 'overview' &&
    view !== 'items' &&
    view !== 'detail' &&
    view !== 'pipeline' &&
    view !== 'links'
  ) {
    throw new Error('work.list view must be one of overview|items|detail|pipeline|links');
  }
  if (input.ids !== undefined && view !== 'detail' && view !== 'links') {
    throw new Error('work.list ids are only valid with view=detail or view=links');
  }
  if (view === 'detail') return workListDetail(input, ctx);
  if (view === 'links') return workListLinks(input, ctx);
  const requested = workListFilter(input);
  const filter =
    input.cursor !== undefined && Object.keys(requested).length === 0
      ? (workListCursorQuery(input.cursor) ?? requested)
      : requested;
  const snapshot = workListReadSnapshot(ctx, filter);
  const now = ctx.now?.() ?? snapshot.observedAt;
  if (input.readVersion !== undefined && input.readVersion !== snapshot.readVersion) {
    throw new Error('work.list readVersion changed; restart the items read from the first page');
  }
  if (view === 'pipeline') {
    const open = snapshot.items.filter(
      (item) => !['done', 'cancelled'].includes(workListStatus(item))
    );
    const groups = new Map<string, unknown[][]>();
    const fields = [
      'commitmentId',
      'title',
      'status',
      'assignee',
      'deadline',
      'latest_change',
      'latest_event',
    ] as const;
    for (const item of open) {
      const values = workListValueObject(item.values);
      const stage = workListText(values.stage) ?? 'Unstaged';
      const group = groups.get(stage) ?? [];
      const latestEvent = workListText(values.latestEvent ?? values.latest_event);
      group.push([
        item.commitmentId,
        workListText(values.title),
        workListStatus(item),
        workListText(values.assignee ?? values.assigneeText ?? values.assignee_text),
        workListDueDate(values, ctx.timeZone),
        Math.trunc(
          typeof item.updatedAt === 'number'
            ? item.updatedAt / 1_000
            : Date.parse(item.updatedAt) / 1_000
        ),
        latestEvent?.replace(/\s+/g, ' ').trim() ?? null,
      ]);
      groups.set(stage, group);
    }
    return {
      success: true,
      view: 'pipeline',
      fields,
      stages: [...groups.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([stage, rows]) => ({ stage, count: rows.length, rows })),
      total: open.length,
      observedAt: new Date(snapshot.observedAt).toISOString(),
    };
  }
  if (view === 'overview') {
    const rankedItems = workListRankedItems(snapshot.items, filter, now, ctx.timeZone);
    return workListOverview(snapshot, rankedItems, now, ctx.timeZone);
  }

  const limit = workListInteger(
    input.limit,
    'limit',
    WORK_LIST_DEFAULT_LIMIT,
    1,
    WORK_LIST_MAX_LIMIT
  );
  const dueDay = filter.due === undefined ? null : localDateKey(now, ctx.timeZone);
  const decoded =
    input.cursor === undefined ? null : decodeWorkListCursor(input.cursor, filter, dueDay);
  if (decoded !== null && decoded.readVersion !== snapshot.readVersion) {
    throw new Error(
      'work.list board changed since this cursor was issued; restart the items read from the first page'
    );
  }
  const rankedItems = workListRankedItems(snapshot.items, filter, now, ctx.timeZone);
  const offset = decoded?.offset ?? 0;
  const page = rankedItems.slice(offset, offset + limit);
  const nextOffset = offset + page.length < rankedItems.length ? offset + page.length : null;
  return {
    success: true,
    view: 'items',
    tasks: page.map(({ item, score }) => ({
      ...workListCompact(item, now, score, ctx.timeZone),
      ...(workListEventBounded(filter) ? workListEventPage(item, filter) : {}),
    })),
    total: rankedItems.length,
    returned: page.length,
    nextCursor:
      nextOffset === null
        ? null
        : encodeWorkListCursor({
            v: 1,
            filter: workListFingerprint(filter, dueDay),
            query: filter,
            readVersion: snapshot.readVersion,
            offset: nextOffset,
          }),
    observedAt: new Date(snapshot.observedAt).toISOString(),
    readVersion: snapshot.readVersion,
  };
}

/** Archive callers used this name; keep the carried view contract name at the action boundary. */
export const runTaskListView = runWorkListView;

export function workListActionRegistrations(ports: WorkListPorts): ActionRegistration[] {
  return [
    {
      contract: {
        name: 'work.list',
        summary:
          'Find owner work by what the turn needs: items filtered by status, stage, project, due, changedSince or changedBefore and ranked by text, in pages of 25 (50 max); overview counts; detail for up to 4 ids with the current record, its 20 newest evidence refs and its 5 newest revisions (history_offset pages older ones). eventSince and eventBefore find what happened in a span by source event time, each item with its revisions there. pipeline returns every open item grouped by stage (rows in the order of its fields: commitmentId, title, status, assignee, deadline as the local due date, latest_change in epoch seconds, latest_event) and ignores limit: read it inside a script that builds the board, not into your context. links for up to 4 ids returns every link from or to the item with its relation, reason, writer, evidence, correction and the other end (item title and status, person, record or observation); follow it to the other item with detail.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            view: { type: 'string', enum: ['overview', 'items', 'detail', 'pipeline', 'links'] },
            ids: {
              type: 'array',
              minItems: 1,
              maxItems: WORK_LIST_MAX_DETAIL_IDS,
              items: {
                oneOf: [
                  { type: 'string', minLength: 1 },
                  { type: 'integer', minimum: 1 },
                ],
              },
            },
            limit: { type: 'integer', minimum: 1, maximum: WORK_LIST_MAX_LIMIT },
            cursor: { type: 'string', minLength: 0 },
            readVersion: {
              type: 'string',
              minLength: 1,
              description: 'Optional echoed read version; must match the current read.',
            },
            status: {
              oneOf: [
                { type: 'string', enum: WORK_LIST_STATUSES },
                { type: 'array', minItems: 1, items: { type: 'string', enum: WORK_LIST_STATUSES } },
              ],
            },
            stage: { type: 'string' },
            project: { type: 'string' },
            text: { type: 'string' },
            asOf: { type: 'integer', minimum: 0 },
            changedSince: {
              oneOf: [
                { type: 'integer', minimum: 0 },
                { type: 'string', minLength: 1 },
              ],
              description:
                'Only items written at or after this time (epoch ms or ISO with offset), e.g. the start of your turn.',
            },
            changedBefore: {
              oneOf: [
                { type: 'integer', minimum: 0 },
                { type: 'string', minLength: 1 },
              ],
              description:
                'Only items last written before this time (epoch ms or ISO with offset): work that has not moved.',
            },
            due: {
              type: 'string',
              enum: WORK_LIST_DUE,
              description:
                "Open items whose deadline is past, is the owner's today, is later, or is unset.",
            },
            eventSince: {
              oneOf: [
                { type: 'integer', minimum: 0 },
                { type: 'string', minLength: 1 },
              ],
              description:
                'Only items with a revision whose source event time is at or after this time (epoch ms or ISO with offset); each item lists those revisions with their summaries.',
            },
            eventBefore: {
              oneOf: [
                { type: 'integer', minimum: 0 },
                { type: 'string', minLength: 1 },
              ],
              description:
                'Only items with a revision whose source event time is before this time; with eventSince, what happened on a day.',
            },
            text_offset: { type: 'integer', minimum: 0 },
            text_limit: { type: 'integer', minimum: 1, maximum: WORK_LIST_MAX_TEXT_LIMIT },
            history_offset: {
              type: 'integer',
              minimum: 0,
              description:
                'Detail: skip this many of the newest revisions; each page has 5, historyNextOffset gives the next.',
            },
            history: { type: 'string', enum: ['current', 'all'] },
          },
        },
        examples: [
          { title: 'Work overview', input: { view: 'overview' } },
          { title: 'Overdue open work', input: { view: 'items', due: 'overdue' } },
          { title: 'First work page', input: { view: 'items', limit: WORK_LIST_DEFAULT_LIMIT } },
          { title: 'Work detail', input: { view: 'detail', ids: ['commitment-reference'] } },
        ],
      },
      exec: (input, context) =>
        runWorkListView(input, {
          knowledge: ports.knowledge,
          access: context.access,
          timeZone: ports.timeZone.get(),
        }),
    },
  ];
}

const nullableText: ActionSchemaObject = {
  description: 'Optional text value; null clears the field, e.g. "reviewed" or null.',
  oneOf: [{ type: 'string' }, { type: 'null' }],
};

const workFileSchema: ActionSchemaObject = {
  type: 'object',
  additionalProperties: false,
  properties: {
    locator: { type: 'string', minLength: 1, description: 'Relevant file locator.' },
    version: { type: 'string', minLength: 1, description: 'Relevant file version.' },
    hash: { type: 'string', minLength: 1, description: 'Relevant file content hash.' },
  },
  required: ['locator', 'version', 'hash'],
};

const workRoleSchema: ActionSchemaObject = {
  type: 'object',
  additionalProperties: true,
  properties: {
    personRef: { type: 'string', minLength: 1, description: 'Person reference for the role.' },
    role: { type: 'string', minLength: 1, description: 'Role judged from evidence.' },
    evidenceRefs: {
      type: 'array',
      description: 'Stable observationRef handles supporting the role.',
      items: { type: 'string', minLength: 1 },
    },
    confirmed: {
      type: 'boolean',
      description:
        'True when evidence confirms the role; false is the explicit unconfirmed status.',
    },
  },
};

const workPatchSchema: ActionSchemaObject = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { ...nullableText, description: 'Work title, e.g. "Prepare release" or null.' },
    description: {
      ...nullableText,
      description: 'Work description, e.g. "Collect review" or null.',
    },
    status: {
      description:
        'Work status: pending, in_progress, review, blocked, done or cancelled; or null. The owner stage stays in stage.',
      oneOf: [
        {
          type: 'string',
          enum: ['pending', 'in_progress', 'review', 'blocked', 'done', 'cancelled'],
        },
        { type: 'null' },
      ],
    },
    priority: { ...nullableText, description: 'Work priority, e.g. "high" or null.' },
    dueAt: { ...nullableText, description: 'Due-time text, e.g. "2026-09-30" or null.' },
    deadline: { ...nullableText, description: 'Deadline text, e.g. "Friday" or null.' },
    deadlineOffsetMinutes: {
      description: 'Deadline offset from the stated event, e.g. 60 or null.',
      oneOf: [{ type: 'integer', minimum: -840, maximum: 840 }, { type: 'null' }],
    },
    stage: { ...nullableText, description: 'Current work stage, or null to clear it.' },
    project: {
      ...nullableText,
      description: 'project associated with the work, or null to clear it.',
    },
    lastEventTime: {
      ...nullableText,
      description:
        'Timezone-qualified ISO timestamp for the source event time, not replay time, or null.',
    },
    files: {
      description: 'Relevant file locator/version/hash entries preserved with the work, or null.',
      oneOf: [{ type: 'array', items: workFileSchema }, { type: 'null' }],
    },
    completionCriteria: {
      type: 'string',
      pattern: '\\S',
      description: 'Evidence-based completion rule, e.g. "Owner approves".',
    },
    assignee: { ...nullableText, description: 'Assigned person text, e.g. "person_123" or null.' },
    assigneeText: {
      ...nullableText,
      description: 'Unresolved assignee text, e.g. "reviewer" or null.',
    },
    latestEvent: {
      ...nullableText,
      description: 'Latest work event text, e.g. "review requested" or null.',
    },
    confirmed: {
      description: 'Whether the patch is confirmed, e.g. true or null.',
      oneOf: [{ type: 'boolean' }, { type: 'null' }],
    },
    roles: {
      description:
        'Evidence-backed role entries with personRef, role, evidenceRefs and confirmed; use false for an explicit unconfirmed status, or null.',
      oneOf: [{ type: 'array', items: workRoleSchema }, { type: 'null' }],
    },
    data: {
      description: 'Product-specific structured fields, e.g. {"stage":"review"} or null.',
      oneOf: [{ type: 'object' }, { type: 'null' }],
    },
  },
};

const commandFields: Record<string, ActionSchemaObject> = {
  summary: {
    type: 'string',
    minLength: 1,
    description: 'What changed and why, e.g. "Review is requested".',
  },
  reasoning: {
    type: 'string',
    minLength: 1,
    description: 'Decision reasoning, e.g. "The source confirms the handoff".',
  },
  scopes: {
    type: 'array',
    description: 'Work visibility scopes, e.g. [{"kind":"project","id":"project_123"}].',
    items: scopeRefSchema,
  },
  sourceRefs: {
    type: 'array',
    description: 'Stable observationRef citation handles, e.g. ["obs_123"].',
    items: { type: 'string', minLength: 1 },
  },
  links: {
    type: 'array',
    description:
      'Graph links from this revision: derived_from an observation it rests on; supersedes, amends or refines an earlier record it replaces or corrects; contradicts one it reverses; builds_on or synthesizes records it extends or combines; blocks or next_action_for another work item. E.g. [{"relation":"derived_from","target":{"kind":"observation","id":"obs_123"}}].',
    items: recordLinkSchema,
  },
  eventDatetime: {
    description:
      'Source event time as epoch milliseconds or an ISO time with its offset, not replay time, or null, e.g. 1760000000000 or "2026-01-01T09:30:00+09:00".',
    oneOf: [{ type: 'number' }, { type: 'string', pattern: OFFSET_ISO_PATTERN }, { type: 'null' }],
  },
  recordedAt: {
    type: 'number',
    description: 'Record time as epoch milliseconds, e.g. 1760000000000.',
  },
  event: { type: 'object', description: 'Structured event details, e.g. {"kind":"review"}.' },
};

const createSchema: ActionSchemaObject = {
  type: 'object',
  required: ['topic', 'summary', 'set'],
  additionalProperties: false,
  properties: {
    ...commandFields,
    topic: { type: 'string', minLength: 1, description: 'Work topic key, e.g. "release".' },
    set: {
      ...workPatchSchema,
      description: 'Fields to set on the new work item, e.g. {"title":"Prepare release"}.',
    },
  },
};

const reviseSchema: ActionSchemaObject = {
  type: 'object',
  required: ['commitmentId', 'summary'],
  additionalProperties: false,
  properties: {
    ...commandFields,
    commitmentId: {
      type: 'string',
      minLength: 1,
      description: 'stable commitmentId citation handle to revise, e.g. "commitment_123".',
    },
    expectedRevision: {
      type: 'integer',
      minimum: 0,
      description:
        'Optional revision read before editing; when omitted, the latest owner revision is appended.',
    },
    appliesUntil: {
      description:
        'When this revision stops applying, as epoch milliseconds or an ISO time with its offset. A backfill that adds an earlier period to work already revised later sets it to the event time of the first later revision, so the later state stays current; it must follow eventDatetime, e.g. "2026-09-01T10:31:00+09:00".',
      oneOf: [{ type: 'number' }, { type: 'string', pattern: OFFSET_ISO_PATTERN }],
    },
    set: {
      ...workPatchSchema,
      description: 'Fields to update on the existing work item, e.g. {"assignee":null}.',
    },
    clear: {
      type: 'array',
      description: 'Patch fields to clear, e.g. ["assignee"].',
      items: { type: 'string' },
    },
  },
};

function operationId(context: ActionContext, action: string): string {
  if (typeof context.operationId !== 'string' || context.operationId.trim() === '') {
    throw new JudgmentError('INVALID_COMMAND', `${action} requires operationId`);
  }
  return context.operationId;
}

function assertSourceRefsExist(body: Record<string, unknown>, ports: WorkPorts): void {
  if (!Array.isArray(body.sourceRefs)) return;
  for (const ref of body.sourceRefs) {
    if (typeof ref === 'string' && !ports.observationExists(ref)) {
      // Echo only the caller's own input, as the core reference refusal does.
      throw new JudgmentError(
        'REFERENCE_NOT_FOUND',
        `sourceRefs names an unavailable observation: ${ref}`
      );
    }
  }
}

/**
 * The ledger stores eventDatetime and appliesUntil as epoch ms. On 2026-09-29 an agent passed the
 * source time as "…T12:30:00+09:00", the write was refused, and the record order ended without a
 * record.
 */
function withEventEpoch(body: Record<string, unknown>, action: string): Record<string, unknown> {
  let normalized = body;
  for (const field of ['eventDatetime', 'appliesUntil'] as const) {
    if (typeof body[field] !== 'string') continue;
    const epoch = offsetIsoTime(body[field] as string);
    if (epoch === undefined)
      throw new JudgmentError(
        'INVALID_COMMAND',
        `${action} ${field} must be epoch milliseconds or an ISO time with its offset`
      );
    normalized = { ...normalized, [field]: epoch };
  }
  return normalized;
}

function commandFieldsFrom(body: Record<string, unknown>): Record<string, unknown> {
  const { commitmentId: _commitmentId, expectedRevision: _expectedRevision, ...fields } = body;
  return fields;
}

export function assertReplayEventDatetime(
  body: Record<string, unknown>,
  context: ActionContext,
  action: 'work.create' | 'work.revise'
): void {
  const ceiling = context.session?.replaySourceEndMs;
  if (ceiling === undefined) return;
  if (!Number.isSafeInteger(ceiling) || ceiling < 0) {
    throw new JudgmentError(
      'REPLAY_SOURCE_CEILING_INVALID',
      'Replay source ceiling must be a nonnegative epoch millisecond integer'
    );
  }
  const eventDatetime = body.eventDatetime;
  if (
    typeof eventDatetime !== 'number' ||
    !Number.isSafeInteger(eventDatetime) ||
    eventDatetime <= 0
  ) {
    throw new JudgmentError(
      'REPLAY_EVENT_TIME_REQUIRED',
      `${action} requires eventDatetime during replay`
    );
  }
  if (eventDatetime > ceiling) {
    throw new JudgmentError(
      'REPLAY_EVENT_TIME_AFTER_CEILING',
      `${action} eventDatetime is later than the active replay source ceiling`
    );
  }
}

export function minimalWorkActionRegistrations(ports: WorkPorts): ActionRegistration[] {
  return [
    {
      contract: {
        name: 'work.create',
        recallableWrite: true,
        summary:
          'Create one owner-work commitment. Product fields such as assignee and roles remain part of the revision patch; links with relation derived_from cite the observations the work rests on.',
        inputSchema: createSchema,
        examples: [
          {
            title: 'Create owner work',
            input: {
              topic: 'work topic',
              summary: 'what the work means',
              set: { title: 'work title', assignee: 'assignee', roles: [] },
            },
          },
        ],
      },
      exec: (input, context) => {
        const body = withEventEpoch(input as Record<string, unknown>, 'work.create');
        assertReplayEventDatetime(body, context, 'work.create');
        assertSourceRefsExist(body, ports);
        return ports.knowledge.createWork(
          {
            ...body,
            ...commandFieldsFrom(body),
            commandId: operationId(context, 'work.create'),
            modelRunId: context.session?.modelRunId,
          } as unknown as CreateWorkCommand,
          context.access
        );
      },
    },
    {
      contract: {
        name: 'work.revise',
        recallableWrite: true,
        summary:
          'Append a revision to owner work while keeping its original topic. expectedRevision is optional for the single owner writer; when supplied it rejects a stale write. The required summary states what changed and why. Links with relation derived_from cite the observations the revision rests on.',
        inputSchema: reviseSchema,
        examples: [
          {
            title: 'Revise assignee and roles',
            input: {
              commitmentId: 'commitment-reference',
              expectedRevision: 1,
              summary: 'what changed and why',
              set: { assignee: null, roles: [] },
            },
          },
        ],
      },
      exec: (input, context) => {
        const body = withEventEpoch(input as Record<string, unknown>, 'work.revise');
        assertReplayEventDatetime(body, context, 'work.revise');
        assertSourceRefsExist(body, ports);
        const commitmentId = body.commitmentId as string;
        return ports.knowledge.reviseWork(
          {
            ...commandFieldsFrom(body),
            commitmentId,
            ...(body.expectedRevision === undefined
              ? {}
              : { expectedRevision: body.expectedRevision }),
            commandId: operationId(context, 'work.revise'),
            modelRunId: context.session?.modelRunId,
          } as unknown as ReviseWorkCommand,
          context.access
        );
      },
    },
    workLinkRegistration(ports),
  ];
}

// Replacing and amending change the target's state and are written with a revision (work.revise
// links, memory.retire), not as a bare link.
export const LINK_RELATIONS = [
  'builds_on',
  'refines',
  'contradicts',
  'debates',
  'synthesizes',
  'mentions',
  'blocks',
  'next_action_for',
] as const;

const linkSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['from', 'to', 'relation', 'reason'],
  properties: {
    from: {
      type: 'string',
      description: 'commitmentId of the item the link is stated from, e.g. "commitment_123".',
    },
    to: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'id'],
      properties: {
        kind: {
          type: 'string',
          enum: ['work', 'memory', 'registry', 'observation', 'edge'],
          description: 'What the other end is, e.g. "work".',
        },
        id: {
          type: 'string',
          minLength: 1,
          description: 'Its id: a commitmentId, record id, node id, observationRef or edgeId.',
        },
      },
      description:
        'The other end: an item by commitmentId (kind work), one record, a person node, an observation, or a link (kind edge) the new link contradicts, e.g. {"kind":"work","id":"commitment_456"}.',
    },
    relation: {
      type: 'string',
      enum: [...LINK_RELATIONS],
      description:
        'builds_on for an earlier case or work this continues, refines for a correction, contradicts for a reversal or a wrong link, e.g. "builds_on".',
    },
    reason: {
      type: 'string',
      minLength: 1,
      description:
        'What relates the two, in a sentence the next reader can check, e.g. "The same setup problem; it ended in a client FIX after the setup was redone".',
    },
    evidenceRefs: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      description: 'observationRefs the reason rests on, e.g. ["obs_123"].',
    },
  },
} as const;

function headRecord(
  ports: WorkPorts,
  commitmentId: string,
  access: JudgmentAccess
): { kind: 'memory'; id: string } {
  const item = ports.knowledge.readWork({ commitmentId }, access).items[0];
  if (item === undefined)
    throw new JudgmentError('REFERENCE_NOT_FOUND', `Commitment is unavailable: ${commitmentId}`);
  return { kind: 'memory', id: item.latestJudgmentRef.id };
}

export function workLinkRegistration(ports: WorkPorts): ActionRegistration {
  return {
    contract: {
      name: 'work.link',
      recallableWrite: true,
      summary:
        'Link one work item to another item, a record, a person or an observation, with the reason you judged; it appends an edge and writes no revision. A link to a link (to.kind edge, relation contradicts) corrects it: the wrong link stays in the history with the correction beside it.',
      inputSchema: linkSchema,
      examples: [
        {
          title: 'Link an earlier case of the same kind',
          input: {
            from: 'commitment-reference',
            to: { kind: 'work', id: 'commitment-earlier' },
            relation: 'builds_on',
            reason: 'what is the same and how the earlier one ended',
          },
        },
      ],
    },
    exec: (input, context) => {
      const body = input as {
        from: string;
        to: { kind: 'work' | 'memory' | 'registry' | 'observation' | 'edge'; id: string };
        relation: (typeof LINK_RELATIONS)[number];
        reason: string;
        evidenceRefs?: string[];
      };
      for (const ref of body.evidenceRefs ?? []) {
        if (!ports.observationExists(ref))
          throw new JudgmentError(
            'REFERENCE_NOT_FOUND',
            `evidenceRefs names an unavailable observation: ${ref}`
          );
      }
      // A retried call finds its link before the heads are read again: the item may have been
      // revised since, and the retry must still return the same link. The ends are compared as
      // revisions of the named items; core's content hash compares the rest of the statement.
      const commandId = operationId(context, 'work.link');
      const earlier = ports.knowledge.findLink(commandId, context.access);
      let from: { kind: 'memory'; id: string };
      let to: Parameters<WorkPorts['knowledge']['appendLink']>[0]['to'];
      if (earlier) {
        const isRevisionOf = (ref: { kind: string; id: string }, commitmentId: string) =>
          ref.kind === 'memory' &&
          (
            ports.knowledge.readWork({ commitmentId, history: 'all' }, context.access).items[0]
              ?.history ?? []
          ).some((revision) => revision.recordRef.id === ref.id);
        const sameTarget =
          body.to.kind === 'work'
            ? isRevisionOf(earlier.to, body.to.id)
            : earlier.to.kind === body.to.kind && earlier.to.id === body.to.id;
        if (!isRevisionOf(earlier.from, body.from) || !sameTarget)
          throw new JudgmentError(
            'COMMAND_CONFLICT',
            'The command id is already bound to another link'
          );
        from = earlier.from as { kind: 'memory'; id: string };
        to = earlier.to;
      } else {
        from = headRecord(ports, body.from, context.access);
        to =
          body.to.kind === 'work'
            ? headRecord(ports, body.to.id, context.access)
            : { kind: body.to.kind, id: body.to.id };
      }
      const receipt = ports.knowledge.appendLink(
        {
          commandId,
          from,
          to,
          relation: body.relation,
          reason: body.reason,
          ...(body.evidenceRefs?.length
            ? {
                evidenceRefs: body.evidenceRefs.map((id) => ({
                  kind: 'observation' as const,
                  id,
                })),
              }
            : {}),
          modelRunId: context.session?.modelRunId ?? null,
        },
        context.access
      );
      return { ...receipt, from: { commitmentId: body.from, recordRef: from }, to };
    },
  };
}

export type { OwnerWorkPatch };
