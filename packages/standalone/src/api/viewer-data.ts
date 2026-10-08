import type {
  CommitmentPage,
  CommitmentRevision,
  CommitmentView,
} from '@jungjaehoon/mama-core/knowledge';
import { isErasedRecord, type ErasedRecord, type WorkGraphPage } from '@jungjaehoon/mama-core';
import type { DatabaseAdapter } from '@jungjaehoon/mama-core/db-manager';
import { isOwnerChatRef, RULE_KINDS } from '../runtime/owner-authority.js';
import { localDateKey } from '../runtime/timezone.js';

export interface ViewerMemoryStats {
  total: number;
  thisWeek: number;
}

export function readViewerMemoryStats(
  adapter: Pick<DatabaseAdapter, 'prepare'>,
  now = Date.now()
): ViewerMemoryStats {
  return adapter
    .prepare(
      `SELECT COUNT(*) AS total,
              COUNT(CASE WHEN created_at >= ? AND created_at <= ? THEN 1 END) AS thisWeek
         FROM decisions`
    )
    .get(now - 7 * 24 * 60 * 60 * 1_000, now) as ViewerMemoryStats;
}

export interface ViewerTaskSummary {
  commitmentId: string;
  rowId: number;
  revision: number;
  title: string | null;
  project: string | null;
  stage: string | null;
  assignee: string | null;
  lastEventTime: string | number | null;
  updatedAt: number;
  withdrawn: boolean;
}

export interface ViewerTaskList {
  tasks: ViewerTaskSummary[];
  nextCursor: string | null;
  coverage: CommitmentPage['coverage'];
}

export interface ViewerEvidence {
  observationRef: string;
  source: string;
  channel?: string | null;
  sourceAt?: number | null;
  observedAt?: number | null;
  content: string;
}

export interface RevisionGraphRead {
  record: WorkGraphPage['nodes'][number] | null;
  evidence: ViewerEvidence[];
}

export interface ViewerRevision {
  revision: number;
  operation: CommitmentRevision['operation'];
  recordRef: CommitmentRevision['recordRef'];
  eventTime: number;
  eventTimeSource: 'event' | 'recorded';
  recordedAt: number;
  summary: string | null;
  reasoning: string | null;
  change: CommitmentRevision['set'];
  clear: Array<keyof CommitmentRevision['set']>;
  feedback: string | null;
  roles: unknown[] | null;
  files: unknown[] | null;
  evidence: ViewerEvidence[];
}

export interface ViewerTaskDetail extends ViewerTaskSummary {
  createdAt: number;
  revisions: ViewerRevision[];
}

export interface ViewerGraphResult {
  nodes: WorkGraphPage['nodes'];
  edges: WorkGraphPage['edges'];
  coverage: WorkGraphPage['coverage'];
  snapshot: WorkGraphPage['snapshot'];
  nextCursor: string | null;
}

export interface ViewerMemorySearchResult {
  count: number;
  results: unknown[];
}

function textField(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function scalarField(value: unknown): string | number | null {
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}

function arrayField(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function taskSummary(item: CommitmentView): ViewerTaskSummary {
  return {
    commitmentId: item.commitmentId,
    rowId: item.rowId,
    revision: item.revision,
    title: textField(item.values.title),
    project: textField(item.values.project),
    stage: textField(item.values.stage),
    assignee: textField(item.values.assignee ?? item.values.assigneeText),
    lastEventTime: scalarField(item.values.lastEventTime),
    updatedAt: item.updatedAt,
    withdrawn: item.withdrawn,
  };
}

export function shapeTaskList(page: CommitmentPage): ViewerTaskList {
  return {
    tasks: page.items.map(taskSummary),
    nextCursor: page.nextCursor,
    coverage: page.coverage,
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function scalarNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function compactText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  const candidate = objectValue(value);
  return typeof candidate.value === 'string' ? candidate.value : null;
}

function taskSummaryFromCompact(row: Record<string, unknown>): ViewerTaskSummary {
  const commitmentId = row.commitmentId;
  const rowId = row.id;
  const revision = row.revision;
  const updatedAt = row.updatedAt ?? row.updated_at;
  if (
    typeof commitmentId !== 'string' ||
    !Number.isSafeInteger(rowId) ||
    !Number.isSafeInteger(revision) ||
    !Number.isSafeInteger(updatedAt)
  ) {
    throw new Error('work.list items returned an invalid compact work row');
  }
  return {
    commitmentId,
    rowId: rowId as number,
    revision: revision as number,
    title: compactText(row.title),
    project: typeof row.project === 'string' ? row.project : null,
    stage: typeof row.stage === 'string' ? row.stage : null,
    assignee: typeof row.assignee === 'string' ? row.assignee : null,
    lastEventTime:
      typeof row.lastEventTime === 'string' || typeof row.lastEventTime === 'number'
        ? row.lastEventTime
        : null,
    updatedAt: updatedAt as number,
    withdrawn: row.withdrawn === true,
  };
}

export function shapeWorkListItems(data: unknown): ViewerTaskList {
  const result = objectValue(data);
  if (result.view !== 'items' || !Array.isArray(result.tasks)) {
    throw new Error('work.list did not return an items view');
  }
  const nextCursor = result.nextCursor;
  const total = result.total;
  if ((nextCursor !== null && typeof nextCursor !== 'string') || !Number.isSafeInteger(total)) {
    throw new Error('work.list items returned an invalid page');
  }
  const tasks = result.tasks.map((row) => taskSummaryFromCompact(objectValue(row)));
  return {
    tasks,
    nextCursor,
    coverage: {
      returned: tasks.length,
      total: total as number,
      complete: nextCursor === null,
      reasons: nextCursor === null ? [] : ['more work follows this page'],
    },
  };
}

export function shapeWorkListDetail(
  data: unknown,
  reads: ReadonlyMap<string, RevisionGraphRead>
): ViewerTaskDetail {
  const result = objectValue(data);
  if (result.view !== 'detail' || !Array.isArray(result.tasks)) {
    throw new Error('work.list did not return a detail view');
  }
  if (result.tasks.length !== 1) {
    throw new Error('work.list detail did not return exactly one task');
  }
  const row = objectValue(result.tasks[0]);
  const summary = taskSummaryFromCompact(row);
  const history = row.history;
  if (!Array.isArray(history)) throw new Error('work.list detail did not return revision history');
  const revisions = [...history]
    .sort((left, right) => {
      const a = objectValue(left);
      const b = objectValue(right);
      const aTime = Number(a.eventDatetime ?? a.createdAt);
      const bTime = Number(b.eventDatetime ?? b.createdAt);
      return aTime - bTime || Number(a.revision) - Number(b.revision);
    })
    .map((raw): ViewerRevision => {
      const revision = objectValue(raw);
      const rawRecordRef = objectValue(revision.recordRef);
      if (typeof rawRecordRef.kind !== 'string' || typeof rawRecordRef.id !== 'string') {
        throw new Error('work.list detail history returned an invalid record reference');
      }
      const recordRef = rawRecordRef as unknown as CommitmentRevision['recordRef'];
      const read = reads.get(refKey(recordRef));
      const eventDatetime = revision.eventDatetime;
      const eventTime =
        typeof eventDatetime === 'number' ? eventDatetime : Number(revision.createdAt);
      return {
        revision: Number(revision.revision),
        operation: revision.operation as CommitmentRevision['operation'],
        recordRef,
        eventTime,
        eventTimeSource: typeof eventDatetime === 'number' ? 'event' : 'recorded',
        recordedAt: Number(revision.createdAt),
        summary: recordText(read, 'summary'),
        reasoning: recordText(read, 'reasoning'),
        change: objectValue(revision.set) as CommitmentRevision['set'],
        clear: Array.isArray(revision.clear)
          ? (revision.clear as Array<keyof CommitmentRevision['set']>)
          : [],
        feedback: textField(objectValue(revision.set).feedback),
        roles: arrayField(objectValue(revision.set).roles),
        files: arrayField(objectValue(revision.set).files),
        evidence: read?.evidence ?? [],
      };
    });
  const createdAt = scalarNumber(row.createdAt) ?? revisions[0]?.eventTime ?? summary.updatedAt;
  const updatedAt = scalarNumber(row.updatedAt) ?? revisions.at(-1)?.eventTime ?? summary.updatedAt;
  return {
    ...summary,
    createdAt: createdAt ?? summary.updatedAt,
    updatedAt: updatedAt ?? summary.updatedAt,
    revisions,
  };
}

function refKey(ref: { kind: string; id: string }): string {
  return `${ref.kind}:${ref.id}`;
}

function recordText(
  read: RevisionGraphRead | undefined,
  field: 'summary' | 'reasoning'
): string | null {
  const data = read?.record?.data;
  if (!data) return null;
  if (isErasedRecord(data)) return field === 'summary' ? 'Erased' : null;
  if (data.kind !== 'memory') return null;
  if (field === 'summary') return data.summary;
  return textField(data.payload.reasoning);
}

function revisionsFor(item: CommitmentView): CommitmentRevision[] {
  if (item.history === undefined) {
    throw new Error('work.show did not return revision history');
  }
  return [...item.history].sort(
    (left, right) =>
      (left.eventDatetime ?? left.createdAt) - (right.eventDatetime ?? right.createdAt) ||
      left.revision - right.revision
  );
}

export function shapeTaskDetail(
  page: CommitmentPage,
  reads: ReadonlyMap<string, RevisionGraphRead>
): ViewerTaskDetail {
  if (page.items.length !== 1) {
    throw new Error('work.show did not return exactly one task');
  }
  const item = page.items[0]!;
  const revisions = revisionsFor(item).map((revision): ViewerRevision => {
    const read = reads.get(refKey(revision.recordRef));
    const eventTime = revision.eventDatetime ?? revision.createdAt;
    return {
      revision: revision.revision,
      operation: revision.operation,
      recordRef: revision.recordRef,
      eventTime,
      eventTimeSource: revision.eventDatetime === null ? 'recorded' : 'event',
      recordedAt: revision.createdAt,
      summary: recordText(read, 'summary'),
      reasoning: recordText(read, 'reasoning'),
      change: revision.set,
      clear: revision.clear,
      feedback: textField(revision.set.feedback),
      roles: arrayField(revision.set.roles),
      files: arrayField(revision.set.files),
      evidence: read?.evidence ?? [],
    };
  });
  return {
    ...taskSummary(item),
    createdAt: revisions[0]?.eventTime ?? item.createdAt,
    updatedAt: revisions[revisions.length - 1]?.eventTime ?? item.updatedAt,
    revisions,
  };
}

export function shapeGraphPage(
  page: WorkGraphPage,
  kinds: readonly string[] = []
): ViewerGraphResult {
  if (kinds.length === 0) return page;
  const wanted = new Set(kinds);
  const nodes = page.nodes.filter((node) => wanted.has(node.ref.kind));
  const visible = new Set(nodes.map((node) => refKey(node.ref)));
  const edges = page.edges.filter(
    (edge) => visible.has(refKey(edge.from)) && visible.has(refKey(edge.to))
  );
  return { ...page, nodes, edges };
}

export function shapeMemorySearch(data: unknown): ViewerMemorySearchResult {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('memory.search returned a non-object result');
  }
  const result = data as { count?: unknown; results?: unknown };
  if (!Array.isArray(result.results) || !Number.isSafeInteger(result.count)) {
    throw new Error('memory.search returned no bounded result list');
  }
  return { count: result.count as number, results: result.results };
}

/** One record as memory.read:timeline returns it. */
interface SavedTimelineRecord {
  id: string;
  kind: string | null;
  status: string | null;
  topic: string;
  summary: string;
  createdAt: number;
  sourceMessageRef: string | null;
  commitmentId: string | null;
  revision: number | null;
  operation: string | null;
  itemTitle: string | null;
}

export interface SavedTimelinePage {
  records: Array<SavedTimelineRecord | ErasedRecord>;
  nextCursor: string | null;
}

export function savedTimelinePage(data: unknown): SavedTimelinePage {
  const page = objectValue(data);
  if (
    !Array.isArray(page.records) ||
    !(page.nextCursor === null || typeof page.nextCursor === 'string')
  ) {
    throw new Error('memory.read:timeline returned no record page');
  }
  return page as unknown as SavedTimelinePage;
}

export interface ViewerTimelineRecord {
  id: string;
  kind: string | null;
  status: string | null;
  topic: string;
  summary: string;
  time: string;
  /** The ref kind of the turn that wrote it (owner_chat for the owner's own conversation). */
  via: string | null;
}

export interface ViewerTimelineItem {
  commitmentId: string;
  title: string | null;
  topic: string;
  revisions: Array<{
    id: string;
    revision: number | null;
    operation: string | null;
    status: string | null;
    summary: string;
    time: string;
  }>;
}

export type ViewerTimelineGroup =
  | { group: string; count: number; records: ViewerTimelineRecord[] }
  | { group: 'work'; count: number; items: ViewerTimelineItem[] };

export interface ViewerSavedTimeline {
  from: string;
  to: string;
  timeZone: string;
  total: number;
  /** Per group, after the text filter and before the group filter, so every chip keeps its count. */
  counts: Record<string, number>;
  days: Array<{ day: string | null; total: number; groups: ViewerTimelineGroup[] }>;
}

/** The groups the memory view names first; any other kind follows under its own name, then work. */
const TIMELINE_GROUPS = ['owner_rule', 'learned', 'decision', 'fact'];

/**
 * A work revision belongs to its item; a rule is the owner's when the owner's own conversation
 * wrote it (owner-authority.ts) and learned otherwise; any other record goes by its kind.
 */
function savedTimelineGroup(record: SavedTimelineRecord): string {
  if (record.commitmentId !== null) return 'work';
  if ((RULE_KINDS as readonly string[]).includes(record.kind ?? '')) {
    return isOwnerChatRef(record.sourceMessageRef) ? 'owner_rule' : 'learned';
  }
  return record.kind ?? 'none';
}

function groupRank(group: string): number {
  if (group === 'work') return TIMELINE_GROUPS.length + 1;
  const known = TIMELINE_GROUPS.indexOf(group);
  return known === -1 ? TIMELINE_GROUPS.length : known;
}

function turnKind(ref: string | null): string | null {
  if (ref === null) return null;
  return isOwnerChatRef(ref) ? 'owner_chat' : ref.split(':')[0];
}

/**
 * What was written when, for a person reading it: by local day, newest first, then by group, and
 * work revisions under the item they revised. Records arrive newest written first.
 */
export function shapeSavedTimeline(
  records: readonly (SavedTimelineRecord | ErasedRecord)[],
  window: { from: string; to: string; timeZone: string },
  filter: { query: string | null; groups: ReadonlySet<string> | null }
): ViewerSavedTimeline {
  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone: window.timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const needle = filter.query === null ? null : filter.query.toLowerCase();
  const counts: Record<string, number> = Object.fromEntries(
    [...TIMELINE_GROUPS, 'work'].map((group) => [group, 0])
  );
  const days = new Map<string, Map<string, SavedTimelineRecord[]>>();
  let total = 0;
  const erasedRecords: ViewerTimelineRecord[] = [];
  for (const record of records) {
    if (isErasedRecord(record)) {
      if (
        needle !== null &&
        ![record.id, 'erased'].some((label) => label.toLowerCase().includes(needle))
      )
        continue;
      counts.erased = (counts.erased ?? 0) + 1;
      if (filter.groups !== null && !filter.groups.has('erased')) continue;
      total += 1;
      erasedRecords.push({
        id: `memory:${record.id}`,
        kind: null,
        status: 'erased',
        topic: record.id,
        summary: 'Erased',
        time: '',
        via: null,
      });
      continue;
    }
    if (
      needle !== null &&
      ![record.topic, record.summary, record.itemTitle ?? ''].some((text) =>
        text.toLowerCase().includes(needle)
      )
    ) {
      continue;
    }
    const group = savedTimelineGroup(record);
    counts[group] = (counts[group] ?? 0) + 1;
    if (filter.groups !== null && !filter.groups.has(group)) continue;
    total += 1;
    const day = localDateKey(record.createdAt, window.timeZone);
    const byGroup = days.get(day) ?? new Map<string, SavedTimelineRecord[]>();
    days.set(day, byGroup);
    byGroup.set(group, [...(byGroup.get(group) ?? []), record]);
  }
  return {
    ...window,
    total,
    counts,
    days: [
      ...[...days].map(([day, byGroup]) => ({
        day,
        total: [...byGroup.values()].reduce((sum, rows) => sum + rows.length, 0),
        groups: [...byGroup]
          .sort(
            ([left], [right]) => groupRank(left) - groupRank(right) || left.localeCompare(right)
          )
          .map(([group, rows]): ViewerTimelineGroup => {
            if (group !== 'work') {
              return {
                group,
                count: rows.length,
                records: rows.map((record) => ({
                  id: `memory:${record.id}`,
                  kind: record.kind,
                  status: record.status,
                  topic: record.topic,
                  summary: record.summary,
                  time: clock.format(record.createdAt),
                  via: turnKind(record.sourceMessageRef),
                })),
              };
            }
            const items = new Map<string, ViewerTimelineItem>();
            for (const record of rows) {
              const commitmentId = record.commitmentId as string;
              const item = items.get(commitmentId) ?? {
                commitmentId,
                title: record.itemTitle,
                topic: record.topic,
                revisions: [],
              };
              items.set(commitmentId, item);
              item.revisions.push({
                id: `memory:${record.id}`,
                revision: record.revision,
                operation: record.operation,
                status: record.status,
                summary: record.summary,
                time: clock.format(record.createdAt),
              });
            }
            return { group: 'work', count: rows.length, items: [...items.values()] };
          }),
      })),
      ...(erasedRecords.length === 0
        ? []
        : [
            {
              day: null,
              total: erasedRecords.length,
              groups: [{ group: 'erased', count: erasedRecords.length, records: erasedRecords }],
            },
          ]),
    ],
  };
}

export interface ArchiveOperatorTask {
  id: number;
  commitment_id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'review' | 'blocked' | 'done' | 'cancelled';
  priority: 'high' | 'normal' | 'low';
  assignee: string | null;
  due_date: string | null;
  due_at: string | null;
  deadline_offset_minutes: number | null;
  revision: number;
  temporal_state:
    | 'closed'
    | 'exact_upcoming'
    | 'exact_overdue'
    | 'date_upcoming'
    | 'date_due'
    | 'date_overdue'
    | 'unscheduled';
  source_channel: string | null;
  latest_event: string | null;
  auto_created: boolean;
  confirmed: boolean;
  created_at: number;
  updated_at: number;
}

export interface ArchiveGraphNode {
  id: string;
  kind?: string;
  state?: string;
  label?: string;
  topic?: string;
  decision_preview?: string;
  decision?: string;
  reasoning?: string;
  confidence?: number | null;
  created_at?: number;
  outcome?: string | null;
  [key: string]: unknown;
}

export interface ArchiveGraphEdge {
  id: string;
  from: string;
  to: string;
  relationship: string;
  reason?: string | null;
  [key: string]: unknown;
}

export interface ArchiveGraphResponse {
  nodes: ArchiveGraphNode[];
  edges: ArchiveGraphEdge[];
  similarityEdges: unknown[];
  meta: Record<string, unknown>;
  latency: number;
}

const TASK_STATUSES = new Set<ArchiveOperatorTask['status']>([
  'pending',
  'in_progress',
  'review',
  'blocked',
  'done',
  'cancelled',
]);
const TASK_PRIORITIES = new Set<ArchiveOperatorTask['priority']>(['high', 'normal', 'low']);

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function archiveStatus(value: unknown, withdrawn: boolean): ArchiveOperatorTask['status'] {
  if (typeof value === 'string' && TASK_STATUSES.has(value as ArchiveOperatorTask['status'])) {
    return value as ArchiveOperatorTask['status'];
  }
  if (value !== undefined && value !== null) {
    // work.* enforces the status vocabulary; anything else is a defect to surface, not "pending".
    throw new Error(`work status outside the contract: ${JSON.stringify(value)}`);
  }
  return withdrawn ? 'cancelled' : 'pending';
}

function archivePriority(value: unknown): ArchiveOperatorTask['priority'] {
  return typeof value === 'string' && TASK_PRIORITIES.has(value as ArchiveOperatorTask['priority'])
    ? (value as ArchiveOperatorTask['priority'])
    : 'normal';
}

function validDate(value: string | null): boolean {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function normalizeDueAt(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function temporalState(
  status: ArchiveOperatorTask['status'],
  dueAt: string | null,
  dueDate: string | null,
  now: number
): ArchiveOperatorTask['temporal_state'] {
  if (status === 'done' || status === 'cancelled') return 'closed';
  if (dueAt !== null) return Date.parse(dueAt) > now ? 'exact_upcoming' : 'exact_overdue';
  if (dueDate === null || !validDate(dueDate)) return 'unscheduled';
  const today = new Date(now).toISOString().slice(0, 10);
  if (dueDate > today) return 'date_upcoming';
  if (dueDate === today) return 'date_due';
  return 'date_overdue';
}

function operatorTaskEventTimes(item: CommitmentView): { createdAt: number; updatedAt: number } {
  if (item.history === undefined || item.history.length === 0) {
    return { createdAt: item.createdAt, updatedAt: item.updatedAt };
  }
  const revisions = [...item.history].sort(
    (left, right) =>
      (left.eventDatetime ?? left.createdAt) - (right.eventDatetime ?? right.createdAt) ||
      left.revision - right.revision
  );
  return {
    createdAt: revisions[0]!.eventDatetime ?? revisions[0]!.createdAt,
    updatedAt:
      revisions[revisions.length - 1]!.eventDatetime ?? revisions[revisions.length - 1]!.createdAt,
  };
}

function archiveTask(item: CommitmentView, now: number): ArchiveOperatorTask {
  const values = recordValue(item.values);
  const eventTimes = operatorTaskEventTimes(item);
  const status = archiveStatus(values.status, item.withdrawn);
  const dueDate = stringValue(values.deadline);
  const dueAt = normalizeDueAt(values.dueAt);
  const offset =
    typeof values.deadlineOffsetMinutes === 'number' &&
    Number.isSafeInteger(values.deadlineOffsetMinutes)
      ? values.deadlineOffsetMinutes
      : null;
  return {
    id: item.rowId,
    commitment_id: item.commitmentId,
    title: stringValue(values.title) ?? '',
    status,
    priority: archivePriority(values.priority),
    assignee: stringValue(values.assignee ?? values.assigneeText),
    due_date: dueDate !== null && validDate(dueDate) ? dueDate : null,
    due_at: dueAt,
    deadline_offset_minutes: offset,
    revision: item.revision,
    temporal_state: temporalState(status, dueAt, dueDate, now),
    source_channel: stringValue(values.sourceChannel ?? values.source_channel),
    latest_event: stringValue(values.latestEvent ?? values.latest_event),
    auto_created: values.autoCreated === true || values.auto_created === true,
    confirmed: values.confirmed === true,
    created_at: eventTimes.createdAt,
    updated_at: eventTimes.updatedAt,
  };
}

export function shapeOperatorTasks(
  page: CommitmentPage,
  options: { now?: number; status?: string; sourceChannel?: string; limit?: number } = {}
): { tasks: ArchiveOperatorTask[]; reason?: string } {
  const now = options.now ?? Date.now();
  let tasks = page.items.map((item) => archiveTask(item, now));
  if (options.status !== undefined) tasks = tasks.filter((task) => task.status === options.status);
  if (options.sourceChannel !== undefined) {
    tasks = tasks.filter((task) => task.source_channel === options.sourceChannel);
  }
  if (options.limit !== undefined) tasks = tasks.slice(0, options.limit);
  return { tasks };
}

function archiveTaskFromCompact(row: Record<string, unknown>): ArchiveOperatorTask {
  const id = row.id;
  const commitmentId = row.commitmentId;
  const revision = row.revision;
  const updatedAt = row.updatedAt ?? row.updated_at;
  if (
    !Number.isSafeInteger(id) ||
    typeof commitmentId !== 'string' ||
    !Number.isSafeInteger(revision) ||
    !Number.isSafeInteger(updatedAt)
  ) {
    throw new Error('work.list items returned an invalid operator row');
  }
  const status = row.status;
  const priority = row.priority ?? 'normal';
  if (!TASK_STATUSES.has(status as ArchiveOperatorTask['status'])) {
    throw new Error('work.list items returned a status outside the contract');
  }
  if (!TASK_PRIORITIES.has(priority as ArchiveOperatorTask['priority'])) {
    throw new Error('work.list items returned a priority outside the contract');
  }
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  const number = (value: unknown): number | null =>
    typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
  const temporal = row.temporal_state;
  const validTemporal = new Set<ArchiveOperatorTask['temporal_state']>([
    'closed',
    'exact_upcoming',
    'exact_overdue',
    'date_upcoming',
    'date_due',
    'date_overdue',
    'unscheduled',
  ]);
  if (!validTemporal.has(temporal as ArchiveOperatorTask['temporal_state'])) {
    throw new Error('work.list items returned an invalid temporal state');
  }
  return {
    id: id as number,
    commitment_id: commitmentId,
    title: text(row.title) ?? '',
    status: status as ArchiveOperatorTask['status'],
    priority: priority as ArchiveOperatorTask['priority'],
    assignee: text(row.assignee),
    due_date: text(row.deadline),
    due_at: text(row.due_at),
    deadline_offset_minutes: number(row.deadline_offset_minutes),
    revision: revision as number,
    temporal_state: temporal as ArchiveOperatorTask['temporal_state'],
    source_channel: text(row.sourceChannel),
    latest_event: text(row.latest_event),
    auto_created: row.auto_created === true,
    confirmed: row.confirmed === true,
    created_at: number(row.createdAt ?? row.created_at) ?? (updatedAt as number),
    updated_at: updatedAt as number,
  };
}

export function shapeOperatorTasksFromItems(
  data: unknown,
  options: { status?: string; sourceChannel?: string } = {}
): {
  tasks: ArchiveOperatorTask[];
  nextCursor: string | null;
  coverage?: ViewerTaskList['coverage'];
} {
  const result = objectValue(data);
  if (result.view !== 'items' || !Array.isArray(result.tasks)) {
    throw new Error('work.list did not return an items view');
  }
  const nextCursor = result.nextCursor;
  if (nextCursor !== null && typeof nextCursor !== 'string') {
    throw new Error('work.list items returned an invalid cursor');
  }
  let tasks = result.tasks.map((row) => archiveTaskFromCompact(objectValue(row)));
  if (options.status !== undefined) tasks = tasks.filter((task) => task.status === options.status);
  if (options.sourceChannel !== undefined) {
    tasks = tasks.filter((task) => task.source_channel === options.sourceChannel);
  }
  const total = result.total;
  if (!Number.isSafeInteger(total)) throw new Error('work.list items returned an invalid total');
  return {
    tasks,
    nextCursor,
    coverage: {
      returned: tasks.length,
      total: total as number,
      complete: nextCursor === null,
      reasons: nextCursor === null ? [] : ['more work follows this page'],
    },
  };
}

function graphRef(ref: { kind: string; id: string }): string {
  return `${ref.kind}:${ref.id}`;
}

function preview(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= 220 ? normalized : `${normalized.slice(0, 220)}...`;
}

export function mapArchiveGraphNode(
  node: WorkGraphPage['nodes'][number],
  timeZone: string
): ArchiveGraphNode & { kind: string; label: string; decision_preview: string } {
  const data = node.data;
  if (isErasedRecord(data))
    return {
      id: graphRef(node.ref),
      kind: data.kind,
      state: 'erased',
      label: 'Erased',
      decision_preview: 'Erased',
    };
  const memory = data.kind === 'memory' ? data : null;
  // An observation's label is its source id; show when and where instead (the text is read
  // on demand by the detail view through source.read).
  const observationLabel =
    data.kind === 'observation'
      ? `${new Date(data.sourceAt ?? data.observedAt).toLocaleString('ko-KR', { timeZone })} (${timeZone}) · ${data.connector}`
      : null;
  const summary = memory?.summary ?? observationLabel ?? node.label;
  const payload = memory?.payload ?? null;
  return {
    id: graphRef(node.ref),
    kind: memory?.recordKind === 'commitment' ? 'commitment' : (memory?.memoryKind ?? data.kind),
    state: memory?.stateAtSnapshot,
    label: observationLabel ?? node.label,
    topic: memory?.topic ?? data.kind,
    decision_preview: preview(summary),
    decision: summary,
    reasoning: payload && typeof payload.reasoning === 'string' ? payload.reasoning : undefined,
    outcome: payload && typeof payload.outcome === 'string' ? payload.outcome : null,
    confidence: null,
    created_at: memory?.recordedAt ?? (data.kind === 'observation' ? data.observedAt : 0),
  };
}

export function mapArchiveGraphEdge(edge: WorkGraphPage['edges'][number]): ArchiveGraphEdge {
  const attrs = recordValue(edge.attrs);
  return {
    id: edge.id,
    from: graphRef(edge.resolvedFrom),
    to: graphRef(edge.resolvedTo),
    relationship: edge.relation,
    reason: typeof attrs.reason_text === 'string' ? attrs.reason_text : null,
  };
}

export function shapeArchiveGraph(
  page: WorkGraphPage,
  latency: number,
  kinds: readonly string[] = [],
  timeZone: string
): ArchiveGraphResponse {
  const nodes = page.nodes.map((node) => mapArchiveGraphNode(node, timeZone));
  const edges = page.edges.map(mapArchiveGraphEdge);
  if (kinds.length === 0) {
    return {
      nodes,
      edges,
      similarityEdges: [],
      meta: {
        total_nodes: nodes.length,
        total_edges: edges.length,
        similarity_edges: 0,
        partial: page.nextCursor !== null,
        next_cursor: page.nextCursor,
        source: 'graph.query:browse',
      },
      latency,
    };
  }
  const wanted = new Set(kinds);
  const visible = new Set(
    page.nodes.filter((node) => wanted.has(node.ref.kind)).map((node) => graphRef(node.ref))
  );
  const filteredNodes = nodes.filter((node) => visible.has(node.id));
  const filteredEdges = edges.filter((edge) => visible.has(edge.from) && visible.has(edge.to));
  return {
    nodes: filteredNodes,
    edges: filteredEdges,
    similarityEdges: [],
    meta: {
      total_nodes: filteredNodes.length,
      total_edges: filteredEdges.length,
      similarity_edges: 0,
      partial: page.nextCursor !== null,
      next_cursor: page.nextCursor,
      source: 'graph.query:browse',
    },
    latency,
  };
}
