import type { MemoryScopeRef } from '@jungjaehoon/mama-core';
import type { MemoryTruthRow } from '@jungjaehoon/mama-core/memory/types';

import type { TrelloKanbanSnapshot } from '../connectors/trello/query-tools.js';
import type {
  ChangesReadFailure,
  ChangesReadInput,
  ChangesReadResult,
} from './changes-projection.js';
import type {
  CorrelationInput,
  CorrelationOutcome,
  CorrelationReason,
  CorrelationResult,
} from './external-correlation.js';
import type { ListTasksPage, TaskRecord } from './task-ledger.js';

const MAX_CLAIMS = 30;
const MAX_TASKS = 50;
const TASK_PAGE_SIZE = 20;
const MAX_TRELLO_CARDS_PER_LIST = 100;
const MAX_TRELLO_CARDS = 300;
const MAX_CHANGES = 100;
const MAX_PACKET_BYTES = 96 * 1024;

export interface OwnerReportReadScope {
  projectRefs: Array<{ kind: 'project'; id: string }>;
  memoryScopes: MemoryScopeRef[];
  rawConnectors: string[];
}

export interface ReportWindowEvidence {
  start: string;
  end: string;
  channelCount: number;
  messageCount: number;
  channels: Array<{
    label: string;
    count: number;
    excerpts: Array<{ authorLabel: string; text: string; observedAt: string | null }>;
  }>;
  triggerActivity: Array<{ kind: string; count: number; topics: string[] }>;
}

export type SourceState =
  | { state: 'complete'; observedAt: string }
  | { state: 'partial'; observedAt: string | null; reason: string }
  | { state: 'unavailable'; observedAt: null; reason: string };

export interface CurrentClaimSummary {
  id: string;
  topic: string;
  summary: string;
  status: string;
  confidence: number;
}

export interface OwnerTaskSummary {
  id: number;
  revision: number;
  title: string;
  status: string;
  latestEvent: string | null;
  updatedAt: string;
  sourceLabel: string | null;
}

export interface TrelloReportSnapshot {
  observedAt: string;
  complete: boolean;
  truncated: boolean;
  boards: Array<{ board: string; status: 'ok' | 'failed'; rosterDegraded: boolean }>;
  columns: Array<{
    board: string;
    list: string;
    count: number;
    returned: number;
    cards: Array<{
      name: string;
      labels: string[];
      assignees: string[];
      due: string | null;
      lastActivity: string;
    }>;
  }>;
}

export interface CorrelationReport {
  coverage: Record<CorrelationOutcome | 'total', number>;
  rows: Array<{
    taskId: number;
    outcome: CorrelationOutcome;
    reason: CorrelationReason;
    live: { board: string; list: string } | null;
  }>;
}

export interface ChangesReport {
  since: string;
  total: number;
  returned: number;
  coverage: { attributed: number; unattributed: number };
  rows: Array<{
    kind: string;
    targetType: string;
    causeState: 'attributed' | 'unattributed';
    causeKind: string;
    at: string;
  }>;
}

export interface OwnerReportContextV1 {
  schemaVersion: 'mama.owner-report-context/v1';
  observedAt: string;
  windowEvidence: ReportWindowEvidence;
  sources: Record<'claims' | 'tasks' | 'trello' | 'changes', SourceState>;
  packet: { bytes: number; truncated: boolean };
  taskCoverage: { total: number; returned: number; truncated: boolean };
  currentClaims: CurrentClaimSummary[];
  tasks: OwnerTaskSummary[];
  trello: TrelloReportSnapshot;
  correlations: CorrelationReport;
  changes: ChangesReport;
  caveats: string[];
}

export interface OwnerReportContextDeps {
  listTaskPage(input: { includeTerminal: false; limit: number; cursor?: string }): ListTasksPage;
  readClaims(scope: OwnerReportReadScope): Promise<MemoryTruthRow[]>;
  readTrello(scope: OwnerReportReadScope): Promise<TrelloKanbanSnapshot>;
  correlate(input: CorrelationInput): CorrelationResult;
  readChanges(
    scope: OwnerReportReadScope,
    input: ChangesReadInput,
    nowMs: number
  ): ChangesReadResult | ChangesReadFailure;
  now(): number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteDate(value: string): boolean {
  return value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function isSafeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validScopeRef(value: unknown): value is MemoryScopeRef {
  if (!isRecord(value) || typeof value.kind !== 'string' || typeof value.id !== 'string') {
    return false;
  }
  return value.id.trim().length > 0;
}

function assertInput(input: {
  readScope: OwnerReportReadScope;
  windowEvidence: ReportWindowEvidence;
  since: string;
}): void {
  const scope = input.readScope;
  const window = input.windowEvidence;
  const scopeValid =
    isRecord(scope) &&
    Array.isArray(scope.projectRefs) &&
    scope.projectRefs.every(
      (ref) =>
        isRecord(ref) && ref.kind === 'project' && typeof ref.id === 'string' && ref.id !== ''
    ) &&
    Array.isArray(scope.memoryScopes) &&
    scope.memoryScopes.every(validScopeRef) &&
    Array.isArray(scope.rawConnectors) &&
    scope.rawConnectors.every((connector) => typeof connector === 'string' && connector !== '');
  const windowValid =
    isRecord(window) &&
    typeof window.start === 'string' &&
    isFiniteDate(window.start) &&
    typeof window.end === 'string' &&
    isFiniteDate(window.end) &&
    isSafeCount(window.channelCount) &&
    isSafeCount(window.messageCount) &&
    Array.isArray(window.channels) &&
    window.channels.length <= 48 &&
    window.channels.every(
      (channel) =>
        isRecord(channel) &&
        typeof channel.label === 'string' &&
        isSafeCount(channel.count) &&
        Array.isArray(channel.excerpts) &&
        channel.excerpts.length <= 5 &&
        channel.excerpts.every(
          (excerpt) =>
            isRecord(excerpt) &&
            typeof excerpt.authorLabel === 'string' &&
            typeof excerpt.text === 'string' &&
            (excerpt.observedAt === null ||
              (typeof excerpt.observedAt === 'string' && isFiniteDate(excerpt.observedAt)))
        )
    ) &&
    Array.isArray(window.triggerActivity) &&
    window.triggerActivity.length <= 100 &&
    window.triggerActivity.every(
      (activity) =>
        isRecord(activity) &&
        typeof activity.kind === 'string' &&
        isSafeCount(activity.count) &&
        Array.isArray(activity.topics) &&
        activity.topics.every((topic) => typeof topic === 'string')
    );
  if (
    !scopeValid ||
    !windowValid ||
    typeof input.since !== 'string' ||
    !isFiniteDate(input.since)
  ) {
    throw new Error('Invalid owner report context input');
  }
}

function detachScope(scope: OwnerReportReadScope): OwnerReportReadScope {
  return {
    projectRefs: scope.projectRefs.map((ref) => ({ kind: 'project', id: ref.id })),
    memoryScopes: scope.memoryScopes.map((ref) => ({ kind: ref.kind, id: ref.id })),
    rawConnectors: [...new Set(scope.rawConnectors)].sort(),
  };
}

function redactText(value: string, maxLength: number): string {
  return value
    .replace(/```\s*(?:tool_call|json\s*tool_call)[\s\S]*?```/gi, '[redacted-instruction]')
    .replace(/```\s*(?:tool_call|json\s*tool_call)\b/gi, '[redacted-instruction]')
    .replace(/\bignore\s+(?:all\s+)?previous\s+instructions\b/gi, '[redacted-instruction]')
    .replace(/(?:~|\/(?:Users|home|private|var|tmp)\/)[^\s,;)}\]]+/g, '[redacted-path]')
    .replace(
      /\b(token|api[_-]?key|password|secret|authorization)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[redacted-secret]'
    )
    .slice(0, maxLength);
}

function sanitizeWindow(window: ReportWindowEvidence): ReportWindowEvidence {
  return {
    start: new Date(window.start).toISOString(),
    end: new Date(window.end).toISOString(),
    channelCount: window.channelCount,
    messageCount: window.messageCount,
    channels: window.channels
      .map((channel) => ({
        label: redactText(channel.label, 512),
        count: channel.count,
        excerpts: channel.excerpts.map((excerpt) => ({
          authorLabel: redactText(excerpt.authorLabel, 160),
          text: redactText(excerpt.text, 160),
          observedAt:
            excerpt.observedAt === null ? null : new Date(excerpt.observedAt).toISOString(),
        })),
      }))
      .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label)),
    triggerActivity: window.triggerActivity
      .map((activity) => ({
        kind: redactText(activity.kind, 160),
        count: activity.count,
        topics: activity.topics.map((topic) => redactText(topic, 256)).sort(),
      }))
      .sort((left, right) => right.count - left.count || left.kind.localeCompare(right.kind)),
  };
}

function sourceLabel(sourceChannel: string | null): string | null {
  if (!sourceChannel) return null;
  const separator = sourceChannel.indexOf(':');
  if (separator <= 0) return null;
  const connector = sourceChannel.slice(0, separator);
  return connector.trim() ? redactText(connector.trim(), 64) : null;
}

function emptyCorrelation(): CorrelationReport {
  return {
    coverage: {
      total: 0,
      matched: 0,
      unmatched: 0,
      ambiguous: 0,
      historical_only: 0,
      not_applicable: 0,
    },
    rows: [],
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])])
  );
}

function canonicalJson(packet: OwnerReportContextV1): string {
  return JSON.stringify(canonicalize(packet));
}

function setPacketBytes(packet: OwnerReportContextV1): string {
  let serialized = '';
  let previous = -1;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    serialized = canonicalJson(packet);
    const bytes = Buffer.byteLength(serialized);
    packet.packet.bytes = bytes;
    if (bytes === previous) return canonicalJson(packet);
    previous = bytes;
  }
  throw new Error('Owner report context canonical byte count did not converge');
}

function markSourcePartial(
  packet: OwnerReportContextV1,
  source: keyof OwnerReportContextV1['sources'],
  reason: string
): void {
  const current = packet.sources[source];
  packet.sources[source] = {
    state: 'partial',
    observedAt: current.observedAt,
    reason,
  };
}

function enforcePacketLimit(packet: OwnerReportContextV1): void {
  let serialized = setPacketBytes(packet);
  if (Buffer.byteLength(serialized) <= MAX_PACKET_BYTES) return;

  packet.packet.truncated = true;
  if (!packet.caveats.includes('packet_size_truncated')) {
    packet.caveats.push('packet_size_truncated');
  }
  const removers: Array<() => boolean> = [
    () => {
      for (let index = packet.trello.columns.length - 1; index >= 0; index -= 1) {
        const column = packet.trello.columns[index];
        if (column.cards.length > 0) {
          column.cards.pop();
          column.returned = column.cards.length;
          packet.trello.truncated = true;
          packet.trello.complete = false;
          markSourcePartial(packet, 'trello', 'packet_size_limit_reached');
          return true;
        }
      }
      return false;
    },
    () => {
      if (packet.changes.rows.length === 0) return false;
      packet.changes.rows.pop();
      packet.changes.returned = packet.changes.rows.length;
      markSourcePartial(packet, 'changes', 'packet_size_limit_reached');
      return true;
    },
    () => {
      if (packet.currentClaims.length === 0) return false;
      packet.currentClaims.pop();
      markSourcePartial(packet, 'claims', 'packet_size_limit_reached');
      return true;
    },
    () => {
      if (packet.tasks.length === 0) return false;
      packet.tasks.pop();
      packet.taskCoverage.returned = packet.tasks.length;
      packet.taskCoverage.truncated = packet.taskCoverage.total > packet.tasks.length;
      markSourcePartial(packet, 'tasks', 'packet_size_limit_reached');
      packet.correlations.rows = packet.correlations.rows.filter((row) =>
        packet.tasks.some((task) => task.id === row.taskId)
      );
      return true;
    },
    () => {
      for (let index = packet.windowEvidence.channels.length - 1; index >= 0; index -= 1) {
        const channel = packet.windowEvidence.channels[index];
        if (channel.excerpts.length > 0) {
          channel.excerpts.pop();
          return true;
        }
      }
      return false;
    },
  ];
  while (Buffer.byteLength(serialized) > MAX_PACKET_BYTES) {
    let removed = false;
    for (const remove of removers) {
      if (remove()) {
        removed = true;
        break;
      }
    }
    if (!removed) {
      throw new Error('Owner report context cannot fit the canonical packet byte limit');
    }
    serialized = setPacketBytes(packet);
  }
}

function isOwnerReportContext(value: unknown): value is OwnerReportContextV1 {
  if (!isRecord(value)) return false;
  const exactKeys = [
    'schemaVersion',
    'observedAt',
    'windowEvidence',
    'sources',
    'packet',
    'taskCoverage',
    'currentClaims',
    'tasks',
    'trello',
    'correlations',
    'changes',
    'caveats',
  ];
  return (
    Object.keys(value).length === exactKeys.length &&
    Object.keys(value).every((key) => exactKeys.includes(key)) &&
    value.schemaVersion === 'mama.owner-report-context/v1' &&
    typeof value.observedAt === 'string' &&
    isFiniteDate(value.observedAt) &&
    isRecord(value.packet) &&
    isSafeCount(value.packet.bytes) &&
    typeof value.packet.truncated === 'boolean' &&
    Array.isArray(value.currentClaims) &&
    Array.isArray(value.tasks) &&
    isRecord(value.trello) &&
    isRecord(value.correlations) &&
    isRecord(value.changes) &&
    Array.isArray(value.caveats)
  );
}

export function serializeOwnerReportContext(packet: OwnerReportContextV1): string {
  if (!isOwnerReportContext(packet)) {
    throw new Error('Invalid owner report context packet');
  }
  return canonicalJson(packet);
}

export async function compileOwnerReportContext(
  input: {
    readScope: OwnerReportReadScope;
    windowEvidence: ReportWindowEvidence;
    since: string;
  },
  deps: OwnerReportContextDeps
): Promise<OwnerReportContextV1> {
  assertInput(input);
  const nowMs = deps.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error('Invalid owner report context clock');
  }
  const observedAt = new Date(nowMs).toISOString();
  const readScope = detachScope(input.readScope);
  const caveats: string[] = [];

  const taskRows: TaskRecord[] = [];
  let taskTotal = 0;
  let taskState: SourceState = { state: 'complete', observedAt };
  try {
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      const page = deps.listTaskPage({
        includeTerminal: false,
        limit: Math.min(TASK_PAGE_SIZE, MAX_TASKS - taskRows.length),
        ...(cursor ? { cursor } : {}),
      });
      if (!isSafeCount(page.total) || !Array.isArray(page.tasks)) {
        throw new Error('invalid task page');
      }
      if (taskRows.length === 0) taskTotal = page.total;
      taskRows.push(...page.tasks.slice(0, MAX_TASKS - taskRows.length));
      const next = page.nextCursor ?? undefined;
      if (next && seenCursors.has(next)) throw new Error('task cursor repeated');
      if (next) seenCursors.add(next);
      cursor = next;
    } while (cursor && taskRows.length < MAX_TASKS);
    if (taskTotal > taskRows.length) {
      taskState = { state: 'partial', observedAt, reason: 'task_limit_reached' };
      caveats.push('task_set_truncated');
    }
  } catch {
    taskState =
      taskRows.length > 0
        ? { state: 'partial', observedAt, reason: 'tasks_read_failed' }
        : { state: 'unavailable', observedAt: null, reason: 'tasks_read_failed' };
    caveats.push('tasks_unavailable');
  }

  let claims: MemoryTruthRow[] = [];
  let claimsState: SourceState = { state: 'complete', observedAt };
  try {
    claims = await deps.readClaims(readScope);
  } catch {
    claimsState = { state: 'unavailable', observedAt: null, reason: 'claims_read_failed' };
    caveats.push('claims_unavailable');
  }
  claims.sort(
    (left, right) =>
      (right.updated_at ?? right.created_at ?? 0) - (left.updated_at ?? left.created_at ?? 0) ||
      left.memory_id.localeCompare(right.memory_id)
  );
  if (claims.length > MAX_CLAIMS) {
    claims = claims.slice(0, MAX_CLAIMS);
    claimsState = { state: 'partial', observedAt, reason: 'claims_limit_reached' };
    caveats.push('claims_truncated');
  }

  let rawTrello: TrelloKanbanSnapshot | null = null;
  let trelloState: SourceState;
  if (!readScope.rawConnectors.includes('trello')) {
    trelloState = { state: 'unavailable', observedAt: null, reason: 'trello_not_authorized' };
    caveats.push('trello_unavailable');
  } else {
    try {
      rawTrello = await deps.readTrello(readScope);
      if (rawTrello.boards.length === 0) {
        trelloState = {
          state: 'unavailable',
          observedAt: null,
          reason: 'trello_no_authorized_boards',
        };
        caveats.push('trello_unavailable');
      } else if (!rawTrello.complete || rawTrello.truncated) {
        trelloState = {
          state: 'partial',
          observedAt: rawTrello.observedAt,
          reason: 'trello_snapshot_incomplete',
        };
        caveats.push('trello_snapshot_incomplete');
      } else {
        trelloState = { state: 'complete', observedAt: rawTrello.observedAt };
      }
    } catch {
      trelloState = { state: 'unavailable', observedAt: null, reason: 'trello_read_failed' };
      caveats.push('trello_unavailable');
    }
  }

  const trello: TrelloReportSnapshot = {
    observedAt: rawTrello?.observedAt ?? observedAt,
    complete: rawTrello !== null && rawTrello.boards.length > 0 && rawTrello.complete,
    truncated: rawTrello?.truncated ?? false,
    boards: (rawTrello?.boards ?? [])
      .map((board) => ({
        board: redactText(board.board, 256),
        status: board.status,
        rosterDegraded: board.rosterDegraded,
      }))
      .sort((left, right) => left.board.localeCompare(right.board)),
    columns: [],
  };
  let remainingCards = MAX_TRELLO_CARDS;
  for (const column of [...(rawTrello?.columns ?? [])].sort(
    (left, right) => left.board.localeCompare(right.board) || left.list.localeCompare(right.list)
  )) {
    const sortedCards = [...column.cards].sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.lastActivity.localeCompare(right.lastActivity)
    );
    const allowed = Math.max(0, Math.min(MAX_TRELLO_CARDS_PER_LIST, remainingCards));
    const cards = sortedCards.slice(0, allowed).map((card) => ({
      name: redactText(card.name, 512),
      labels: card.labels
        .slice(0, 20)
        .map((label) => redactText(label, 128))
        .sort(),
      assignees: card.assignees
        .slice(0, 20)
        .map((assignee) => redactText(assignee, 128))
        .sort(),
      due: card.due,
      lastActivity: card.lastActivity,
    }));
    remainingCards -= cards.length;
    if (cards.length < column.cards.length || cards.length < column.returned) {
      trello.truncated = true;
      trello.complete = false;
    }
    trello.columns.push({
      board: redactText(column.board, 256),
      list: redactText(column.list, 256),
      count: column.count,
      returned: cards.length,
      cards,
    });
  }
  if (trello.truncated && trelloState.state !== 'unavailable') {
    trelloState = {
      state: 'partial',
      observedAt: rawTrello?.observedAt ?? null,
      reason: 'trello_card_limit_reached',
    };
    if (!caveats.includes('trello_snapshot_incomplete')) caveats.push('trello_snapshot_incomplete');
  }

  let correlation = emptyCorrelation();
  try {
    const rawResult = deps.correlate({
      connector: 'trello',
      rows: taskRows.map((row) => ({
        id: row.id,
        sourceChannel: row.sourceChannel,
        sourceEventId: row.sourceEventId,
      })),
      lookupProvenance: () => null,
      liveItems: (rawTrello?.columns ?? []).flatMap((column) =>
        column.cards.map((card) => ({
          itemId: card.cardId,
          board: column.board,
          list: column.list,
        }))
      ),
      liveSnapshotComplete: trelloState.state === 'complete',
    });
    correlation = {
      coverage: { ...rawResult.coverage },
      rows: rawResult.correlations
        .map((row) => ({
          taskId: row.taskId,
          outcome: row.outcome,
          reason: row.reason,
          live: row.live
            ? { board: redactText(row.live.board, 256), list: redactText(row.live.list, 256) }
            : null,
        }))
        .sort((left, right) => left.taskId - right.taskId),
    };
  } catch {
    caveats.push('correlation_unavailable');
  }

  let changes: ChangesReport = {
    since: new Date(input.since).toISOString(),
    total: 0,
    returned: 0,
    coverage: { attributed: 0, unattributed: 0 },
    rows: [],
  };
  let changesState: SourceState = { state: 'complete', observedAt };
  try {
    const rawChanges = deps.readChanges(
      readScope,
      { since: input.since, limit: MAX_CHANGES },
      nowMs
    );
    if (!rawChanges.success) {
      changesState = { state: 'unavailable', observedAt: null, reason: 'changes_read_failed' };
      caveats.push('changes_unavailable');
    } else {
      const rows = rawChanges.changes.slice(0, MAX_CHANGES).map((change) => ({
        kind: redactText(change.kind, 160),
        targetType: redactText(change.target_type, 160),
        causeState: change.cause_state as 'attributed' | 'unattributed',
        causeKind: redactText(change.cause_kind, 160),
        at: change.at,
      }));
      changes = {
        since: rawChanges.since,
        total: rawChanges.total,
        returned: rows.length,
        coverage: { ...rawChanges.coverage },
        rows,
      };
      if (rawChanges.total > rows.length || rawChanges.returned > rows.length) {
        changesState = { state: 'partial', observedAt, reason: 'changes_limit_reached' };
        caveats.push('changes_truncated');
      }
    }
  } catch {
    changesState = { state: 'unavailable', observedAt: null, reason: 'changes_read_failed' };
    caveats.push('changes_unavailable');
  }

  const windowEvidence = sanitizeWindow(input.windowEvidence);
  if (
    windowEvidence.channels.some((channel) =>
      channel.excerpts.some((item) => item.observedAt === null)
    )
  ) {
    caveats.push('window_evidence_timestamp_unavailable');
  }
  const packet: OwnerReportContextV1 = {
    schemaVersion: 'mama.owner-report-context/v1',
    observedAt,
    windowEvidence,
    sources: {
      claims: claimsState,
      tasks: taskState,
      trello: trelloState,
      changes: changesState,
    },
    packet: { bytes: 0, truncated: false },
    taskCoverage: {
      total: taskTotal,
      returned: taskRows.length,
      truncated: taskTotal > taskRows.length,
    },
    currentClaims: claims.map((row) => ({
      id: redactText(row.memory_id, 512),
      topic: redactText(row.topic, 512),
      summary: redactText(row.effective_summary, 4_000),
      status: redactText(row.truth_status, 64),
      confidence: row.trust_score,
    })),
    tasks: taskRows.map((row) => ({
      id: row.id,
      revision: row.revision,
      title: redactText(row.title, 1_000),
      status: redactText(row.status, 64),
      latestEvent: row.latestEvent === null ? null : redactText(row.latestEvent, 1_000),
      updatedAt: new Date(row.updatedAt).toISOString(),
      sourceLabel: sourceLabel(row.sourceChannel),
    })),
    trello,
    correlations: correlation,
    changes,
    caveats: [...new Set(caveats)].sort(),
  };
  enforcePacketLimit(packet);
  setPacketBytes(packet);
  return packet;
}
