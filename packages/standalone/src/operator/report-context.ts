import type { MemoryScopeRef } from '@jungjaehoon/mama-core';
import type { MemoryTruthRow } from '@jungjaehoon/mama-core/memory/types';

import type { TrelloKanbanSnapshot } from '../connectors/trello/query-tools.js';
import { ToolRegistry } from '../agent/tool-registry.js';
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
const REGISTERED_TOOL_NAMES = new Set<string>(ToolRegistry.getValidToolNames());
const SOURCE_DISPLAY_LABELS: Readonly<Record<string, string>> = {
  'claude-code': 'claude-code',
  calendar: 'calendar',
  chatwork: 'chatwork',
  discord: 'discord',
  drive: 'drive',
  gmail: 'gmail',
  imessage: 'imessage',
  kagemusha: 'kagemusha',
  notion: 'notion',
  obsidian: 'obsidian',
  sheets: 'sheets',
  slack: 'slack',
  telegram: 'telegram',
  trello: 'trello',
};

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
  /** Owner-entered ISO date (YYYY-MM-DD) or null. Overdue work is unanswerable without it. */
  deadline: string | null;
  /** Host-derived RFC 3339 instant (e.g. review + 14 days) or null. */
  dueAt: string | null;
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
  listTaskPage(input: {
    includeTerminal: false;
    order: 'updated';
    limit: number;
    cursor?: string;
  }): ListTasksPage;
  readClaims(scope: OwnerReportReadScope): Promise<MemoryTruthRow[]>;
  readTrello(scope: OwnerReportReadScope): Promise<TrelloKanbanSnapshot>;
  buildProvenanceLookup(): Promise<CorrelationInput['lookupProvenance']>;
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

function isRegisteredJsonToolObject(value: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  return (
    isRecord(parsed) &&
    typeof parsed.name === 'string' &&
    REGISTERED_TOOL_NAMES.has(parsed.name) &&
    (isRecord(parsed.input) || isRecord(parsed.arguments))
  );
}

function hasRegisteredImperativeTarget(value: string): boolean {
  const matches = value.matchAll(/\b(?:call|use|invoke|run)\s+([A-Za-z][A-Za-z0-9_-]*)\b/gi);
  return [...matches].some((match) => REGISTERED_TOOL_NAMES.has(match[1]));
}

function redactText(value: string, maxLength: number): string {
  if (
    /^\s*(?:system|developer|assistant)\s*:/i.test(value) ||
    /<\/?(?:tool_call|function_call|invoke)\b/i.test(value) ||
    isRegisteredJsonToolObject(value) ||
    /\bmcp__[a-z0-9_.-]+/i.test(value) ||
    /\b(?:ignore|disregard)\s+(?:all\s+)?(?:prior|previous|above)\s+(?:instructions|messages)\b/i.test(
      value
    ) ||
    hasRegisteredImperativeTarget(value)
  ) {
    return '[redacted-instruction]'.slice(0, maxLength);
  }
  return (
    value
      .replace(/```\s*(?:tool_call|json\s*tool_call)[\s\S]*?```/gi, '[redacted-instruction]')
      .replace(/```\s*(?:tool_call|json\s*tool_call)\b/gi, '[redacted-instruction]')
      .replace(/\bignore\s+(?:all\s+)?previous\s+instructions\b/gi, '[redacted-instruction]')
      // Real-data verification (2026-09-02): Board-written latest_event prose and
      // curated claim summaries carried raw event ids (`source_event_id=evt_...`),
      // run ids (`mr_...`) and numeric chat-room ids (`channel=chatwork:123...`) into
      // the model-visible packet. The packet contract forbids raw run/event/source
      // and chat ids; the words around them stay.
      .replace(/\bsource_event_id\s*=\s*\S+/gi, 'source_event_id=[redacted-id]')
      .replace(/\b(?:evt|mr)_[0-9a-f]{8,}\b/gi, '[redacted-id]')
      .replace(
        /\b(chatwork|telegram|slack|kakao|kagemusha|discord|line)\s*[:=]\s*\d{5,}\b/gi,
        '$1:[redacted-id]'
      )
      .replace(/(?:~|\/(?:Users|home|private|var|tmp)\/)[^\s,;)}\]]+/g, '[redacted-path]')
      .replace(
        /\b(token|api[_-]?key|password|secret|authorization)\s*[:=]\s*[^\s,;]+/gi,
        '$1=[redacted-secret]'
      )
      .slice(0, maxLength)
  );
}

/**
 * Upstream instants (Trello card timestamps, effect-ledger times) are copied into the
 * model-visible packet. Normalising them here means connector text can never ride
 * along in a timestamp field and an unparseable value cannot fail packet validation
 * after composition.
 */
function toIsoInstant(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
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

function sourceLabel(
  sourceChannel: string | null,
  authorizedConnectors: readonly string[]
): string | null {
  if (!sourceChannel) return null;
  const separator = sourceChannel.indexOf(':');
  if (separator <= 0) return null;
  const connector = sourceChannel.slice(0, separator);
  return authorizedConnectors.includes(connector)
    ? (SOURCE_DISPLAY_LABELS[connector] ?? null)
    : null;
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

function recomputeCorrelationCoverage(report: CorrelationReport): void {
  const coverage: CorrelationReport['coverage'] = {
    total: report.rows.length,
    matched: 0,
    unmatched: 0,
    ambiguous: 0,
    historical_only: 0,
    not_applicable: 0,
  };
  for (const row of report.rows) coverage[row.outcome] += 1;
  report.coverage = coverage;
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
      recomputeCorrelationCoverage(packet.correlations);
      return true;
    },
    () => {
      if (packet.correlations.rows.length === 0) return false;
      packet.correlations.rows.pop();
      recomputeCorrelationCoverage(packet.correlations);
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
    () => {
      for (let index = packet.windowEvidence.triggerActivity.length - 1; index >= 0; index -= 1) {
        const activity = packet.windowEvidence.triggerActivity[index];
        if (activity.topics.length > 0) {
          activity.topics.pop();
          return true;
        }
      }
      return false;
    },
    () => {
      if (packet.windowEvidence.triggerActivity.length === 0) return false;
      packet.windowEvidence.triggerActivity.pop();
      return true;
    },
    () => {
      if (packet.trello.columns.length === 0) return false;
      packet.trello.columns.pop();
      packet.trello.truncated = true;
      packet.trello.complete = false;
      markSourcePartial(packet, 'trello', 'packet_size_limit_reached');
      return true;
    },
    () => {
      if (packet.trello.boards.length === 0) return false;
      packet.trello.boards.pop();
      packet.trello.truncated = true;
      packet.trello.complete = false;
      markSourcePartial(packet, 'trello', 'packet_size_limit_reached');
      return true;
    },
    () => {
      if (packet.windowEvidence.channels.length === 0) return false;
      packet.windowEvidence.channels.pop();
      return true;
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

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength;
}

function isIsoString(value: unknown): value is string {
  return isBoundedString(value, 64) && isFiniteDate(value);
}

function isSourceState(value: unknown): value is SourceState {
  if (
    !isRecord(value) ||
    (value.state !== 'complete' && value.state !== 'partial' && value.state !== 'unavailable')
  ) {
    return false;
  }
  if (value.state === 'complete') {
    return hasExactKeys(value, ['state', 'observedAt']) && isIsoString(value.observedAt);
  }
  return (
    hasExactKeys(value, ['state', 'observedAt', 'reason']) &&
    (value.state === 'partial'
      ? value.observedAt === null || isIsoString(value.observedAt)
      : value.observedAt === null) &&
    isBoundedString(value.reason, 160) &&
    value.reason.length > 0
  );
}

function isReportWindowEvidence(value: unknown): value is ReportWindowEvidence {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'start',
      'end',
      'channelCount',
      'messageCount',
      'channels',
      'triggerActivity',
    ]) ||
    !isIsoString(value.start) ||
    !isIsoString(value.end) ||
    !isSafeCount(value.channelCount) ||
    !isSafeCount(value.messageCount) ||
    !Array.isArray(value.channels) ||
    value.channels.length > 48 ||
    !Array.isArray(value.triggerActivity) ||
    value.triggerActivity.length > 100
  ) {
    return false;
  }
  const channelsValid = value.channels.every((channel: unknown) => {
    if (
      !isRecord(channel) ||
      !hasExactKeys(channel, ['label', 'count', 'excerpts']) ||
      !isBoundedString(channel.label, 512) ||
      !isSafeCount(channel.count) ||
      !Array.isArray(channel.excerpts) ||
      channel.excerpts.length > 5
    ) {
      return false;
    }
    return channel.excerpts.every(
      (excerpt: unknown) =>
        isRecord(excerpt) &&
        hasExactKeys(excerpt, ['authorLabel', 'text', 'observedAt']) &&
        isBoundedString(excerpt.authorLabel, 160) &&
        isBoundedString(excerpt.text, 160) &&
        (excerpt.observedAt === null || isIsoString(excerpt.observedAt))
    );
  });
  return (
    channelsValid &&
    value.triggerActivity.every(
      (activity: unknown) =>
        isRecord(activity) &&
        hasExactKeys(activity, ['kind', 'count', 'topics']) &&
        isBoundedString(activity.kind, 160) &&
        isSafeCount(activity.count) &&
        Array.isArray(activity.topics) &&
        activity.topics.every((topic: unknown) => isBoundedString(topic, 256))
    )
  );
}

function isCurrentClaim(value: unknown): value is CurrentClaimSummary {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['id', 'topic', 'summary', 'status', 'confidence']) &&
    isBoundedString(value.id, 512) &&
    isBoundedString(value.topic, 512) &&
    isBoundedString(value.summary, 4_000) &&
    isBoundedString(value.status, 64) &&
    typeof value.confidence === 'number' &&
    Number.isFinite(value.confidence)
  );
}

function isOwnerTask(value: unknown): value is OwnerTaskSummary {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'id',
      'revision',
      'title',
      'status',
      'latestEvent',
      'updatedAt',
      'deadline',
      'dueAt',
      'sourceLabel',
    ]) &&
    isSafeCount(value.id) &&
    isSafeCount(value.revision) &&
    isBoundedString(value.title, 1_000) &&
    isBoundedString(value.status, 64) &&
    (value.latestEvent === null || isBoundedString(value.latestEvent, 1_000)) &&
    isIsoString(value.updatedAt) &&
    (value.deadline === null ||
      (typeof value.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.deadline))) &&
    (value.dueAt === null || isIsoString(value.dueAt)) &&
    (value.sourceLabel === null ||
      (isBoundedString(value.sourceLabel, 64) &&
        SOURCE_DISPLAY_LABELS[value.sourceLabel] !== undefined))
  );
}

function isTrelloReport(value: unknown): value is TrelloReportSnapshot {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['observedAt', 'complete', 'truncated', 'boards', 'columns']) ||
    !isIsoString(value.observedAt) ||
    typeof value.complete !== 'boolean' ||
    typeof value.truncated !== 'boolean' ||
    !Array.isArray(value.boards) ||
    !Array.isArray(value.columns)
  ) {
    return false;
  }
  const boardsValid = value.boards.every(
    (board: unknown) =>
      isRecord(board) &&
      hasExactKeys(board, ['board', 'status', 'rosterDegraded']) &&
      isBoundedString(board.board, 256) &&
      (board.status === 'ok' || board.status === 'failed') &&
      typeof board.rosterDegraded === 'boolean'
  );
  let cardTotal = 0;
  const columnsValid = value.columns.every((column: unknown) => {
    if (
      !isRecord(column) ||
      !hasExactKeys(column, ['board', 'list', 'count', 'returned', 'cards']) ||
      !isBoundedString(column.board, 256) ||
      !isBoundedString(column.list, 256) ||
      !isSafeCount(column.count) ||
      !isSafeCount(column.returned) ||
      !Array.isArray(column.cards) ||
      column.cards.length > MAX_TRELLO_CARDS_PER_LIST ||
      column.returned !== column.cards.length ||
      column.count < column.returned
    ) {
      return false;
    }
    cardTotal += column.cards.length;
    return column.cards.every(
      (card: unknown) =>
        isRecord(card) &&
        hasExactKeys(card, ['name', 'labels', 'assignees', 'due', 'lastActivity']) &&
        isBoundedString(card.name, 512) &&
        Array.isArray(card.labels) &&
        card.labels.length <= 20 &&
        card.labels.every((label: unknown) => isBoundedString(label, 128)) &&
        Array.isArray(card.assignees) &&
        card.assignees.length <= 20 &&
        card.assignees.every((assignee: unknown) => isBoundedString(assignee, 128)) &&
        (card.due === null || isBoundedString(card.due, 64)) &&
        isBoundedString(card.lastActivity, 64)
    );
  });
  return boardsValid && columnsValid && cardTotal <= MAX_TRELLO_CARDS;
}

const CORRELATION_OUTCOMES = new Set<CorrelationOutcome>([
  'matched',
  'unmatched',
  'ambiguous',
  'historical_only',
  'not_applicable',
]);
const CORRELATION_REASONS = new Set<CorrelationReason>([
  'no_source',
  'other_connector',
  'no_provenance',
  'provenance_not_indexed',
  'provenance_connector_mismatch',
  'external_ref_unresolvable',
  'provenance_conflict',
  'multiple_rows_one_item',
  'absent_from_live_snapshot',
  'live_snapshot_incomplete',
  'live_item',
]);

function isCorrelationReport(value: unknown): value is CorrelationReport {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['coverage', 'rows']) ||
    !isRecord(value.coverage) ||
    !hasExactKeys(value.coverage, [
      'total',
      'matched',
      'unmatched',
      'ambiguous',
      'historical_only',
      'not_applicable',
    ]) ||
    !Array.isArray(value.rows) ||
    value.rows.length > MAX_TASKS
  ) {
    return false;
  }
  const counts: Record<CorrelationOutcome, number> = {
    matched: 0,
    unmatched: 0,
    ambiguous: 0,
    historical_only: 0,
    not_applicable: 0,
  };
  const coverage = value.coverage;
  const rowsValid = value.rows.every((row: unknown) => {
    if (
      !isRecord(row) ||
      !hasExactKeys(row, ['taskId', 'outcome', 'reason', 'live']) ||
      !isSafeCount(row.taskId) ||
      typeof row.outcome !== 'string' ||
      !CORRELATION_OUTCOMES.has(row.outcome as CorrelationOutcome) ||
      typeof row.reason !== 'string' ||
      !CORRELATION_REASONS.has(row.reason as CorrelationReason) ||
      !(
        row.live === null ||
        (isRecord(row.live) &&
          hasExactKeys(row.live, ['board', 'list']) &&
          isBoundedString(row.live.board, 256) &&
          isBoundedString(row.live.list, 256))
      )
    ) {
      return false;
    }
    counts[row.outcome as CorrelationOutcome] += 1;
    return true;
  });
  return (
    rowsValid &&
    isSafeCount(coverage.total) &&
    coverage.total === value.rows.length &&
    [...CORRELATION_OUTCOMES].every(
      (outcome) => isSafeCount(coverage[outcome]) && coverage[outcome] === counts[outcome]
    )
  );
}

function isChangesReport(value: unknown): value is ChangesReport {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['since', 'total', 'returned', 'coverage', 'rows']) &&
    isIsoString(value.since) &&
    isSafeCount(value.total) &&
    isSafeCount(value.returned) &&
    isRecord(value.coverage) &&
    hasExactKeys(value.coverage, ['attributed', 'unattributed']) &&
    isSafeCount(value.coverage.attributed) &&
    isSafeCount(value.coverage.unattributed) &&
    Array.isArray(value.rows) &&
    value.rows.length <= MAX_CHANGES &&
    value.returned === value.rows.length &&
    value.total >= value.returned &&
    value.rows.every(
      (row: unknown) =>
        isRecord(row) &&
        hasExactKeys(row, ['kind', 'targetType', 'causeState', 'causeKind', 'at']) &&
        isBoundedString(row.kind, 160) &&
        isBoundedString(row.targetType, 160) &&
        (row.causeState === 'attributed' || row.causeState === 'unattributed') &&
        isBoundedString(row.causeKind, 160) &&
        isIsoString(row.at)
    )
  );
}

function isOwnerReportContext(value: unknown): value is OwnerReportContextV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
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
    ]) ||
    value.schemaVersion !== 'mama.owner-report-context/v1' ||
    !isIsoString(value.observedAt) ||
    !isReportWindowEvidence(value.windowEvidence) ||
    !isRecord(value.sources) ||
    !hasExactKeys(value.sources, ['claims', 'tasks', 'trello', 'changes']) ||
    !Object.values(value.sources).every(isSourceState) ||
    !isRecord(value.packet) ||
    !hasExactKeys(value.packet, ['bytes', 'truncated']) ||
    !isSafeCount(value.packet.bytes) ||
    typeof value.packet.truncated !== 'boolean' ||
    !isRecord(value.taskCoverage) ||
    !hasExactKeys(value.taskCoverage, ['total', 'returned', 'truncated']) ||
    !isSafeCount(value.taskCoverage.total) ||
    !isSafeCount(value.taskCoverage.returned) ||
    value.taskCoverage.total < value.taskCoverage.returned ||
    typeof value.taskCoverage.truncated !== 'boolean' ||
    !Array.isArray(value.currentClaims) ||
    value.currentClaims.length > MAX_CLAIMS ||
    !value.currentClaims.every(isCurrentClaim) ||
    !Array.isArray(value.tasks) ||
    value.tasks.length > MAX_TASKS ||
    !value.tasks.every(isOwnerTask) ||
    !isTrelloReport(value.trello) ||
    !isCorrelationReport(value.correlations) ||
    !isChangesReport(value.changes) ||
    !Array.isArray(value.caveats) ||
    !value.caveats.every((caveat: unknown) => isBoundedString(caveat, 160))
  ) {
    return false;
  }
  return true;
}

export function serializeOwnerReportContext(packet: OwnerReportContextV1): string {
  if (!isOwnerReportContext(packet)) {
    throw new Error('Invalid owner report context packet');
  }
  const detached = JSON.parse(JSON.stringify(packet)) as OwnerReportContextV1;
  const serialized = canonicalJson(detached);
  const bytes = Buffer.byteLength(serialized);
  if (bytes > MAX_PACKET_BYTES || detached.packet.bytes !== bytes) {
    throw new Error('Invalid owner report context packet');
  }
  return serialized;
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
      // Real-data verification (2026-09-02): 264 open owner tasks against a 50-row
      // bound. Deadline-first ranking filled the packet with month-old deadline
      // rows and displaced every task updated in the last week, including all
      // in_progress work - the owner report answers "what is open NOW", so recency
      // ranks the bounded set. Stale deadline work stays the Board lane's job.
      const page = deps.listTaskPage({
        includeTerminal: false,
        order: 'updated',
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
      due: toIsoInstant(card.due),
      lastActivity: toIsoInstant(card.lastActivity) ?? observedAt,
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
    const lookupProvenance = rawTrello === null ? () => null : await deps.buildProvenanceLookup();
    const rawResult = deps.correlate({
      connector: 'trello',
      rows: taskRows.map((row) => ({
        id: row.id,
        sourceChannel: row.sourceChannel,
        sourceEventId: row.sourceEventId,
      })),
      lookupProvenance,
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
      const normalizedRows = rawChanges.changes.slice(0, MAX_CHANGES).map((change) => ({
        kind: redactText(change.kind, 160),
        targetType: redactText(change.target_type, 160),
        causeState: change.cause_state as 'attributed' | 'unattributed',
        causeKind: redactText(change.cause_kind, 160),
        at: toIsoInstant(change.at),
      }));
      const rows = normalizedRows.flatMap((row) =>
        row.at === null ? [] : [{ ...row, at: row.at }]
      );
      changes = {
        since: rawChanges.since,
        total: rawChanges.total,
        returned: rows.length,
        coverage: { ...rawChanges.coverage },
        rows,
      };
      if (rows.length < normalizedRows.length) {
        // A change whose time cannot be read is not silently redated; the source is
        // marked partial so the report says the ledger was not fully readable.
        changesState = { state: 'partial', observedAt, reason: 'changes_row_time_invalid' };
        caveats.push('changes_rows_dropped');
      } else if (rawChanges.total > rows.length || rawChanges.returned > rows.length) {
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
      deadline: row.deadlineIso,
      dueAt: row.dueAt === null ? null : new Date(row.dueAt).toISOString(),
      sourceLabel: sourceLabel(row.sourceChannel, readScope.rawConnectors),
    })),
    trello,
    correlations: correlation,
    changes,
    caveats: [...new Set(caveats)].sort(),
  };
  const detached = JSON.parse(JSON.stringify(packet)) as OwnerReportContextV1;
  enforcePacketLimit(detached);
  setPacketBytes(detached);
  if (!isOwnerReportContext(detached)) {
    throw new Error('Owner report context failed canonical schema validation');
  }
  return detached;
}

/**
 * One MAMA (Phase 1 Task 3): the event turn starts from the same host-compiled
 * packet as the report, narrowed to its channel. The read scope MUST be the
 * owner-event scope the run's envelope holds - reading under another principal
 * is the mismatch that fails the envelope scope audit.
 */
export async function compileChannelPacket(
  input: {
    readScope: OwnerReportReadScope;
    channelKey: string;
    eventIds: string[];
    since: string;
  },
  deps: OwnerReportContextDeps
): Promise<OwnerReportContextV1> {
  const separator = input.channelKey.indexOf(':');
  const connector = separator > 0 ? input.channelKey.slice(0, separator) : input.channelKey;
  // The packet validator only accepts sourceLabels from SOURCE_DISPLAY_LABELS, so an
  // unknown connector fails OPEN: keep every row rather than filter on a label no
  // row can carry.
  const label: string | null = SOURCE_DISPLAY_LABELS[connector] ?? null;
  const end = new Date(deps.now()).toISOString();
  const full = await compileOwnerReportContext(
    {
      readScope: input.readScope,
      since: input.since,
      windowEvidence: {
        start: input.since,
        end,
        channelCount: 1,
        messageCount: input.eventIds.length,
        channels: [{ label: label ?? connector, count: input.eventIds.length, excerpts: [] }],
        triggerActivity: [],
      },
    },
    deps
  );
  const keep = new Set(
    full.tasks
      .filter(
        (row) =>
          label === null ||
          row.sourceLabel === label ||
          row.status === 'in_progress' ||
          row.status === 'review'
      )
      .map((row) => row.id)
  );
  const tasks = full.tasks.filter((row) => keep.has(row.id));
  const rows = full.correlations.rows.filter((row) => keep.has(row.taskId));
  // The recency bound is applied to the whole ledger before this channel filter, so a
  // channel whose rows were not updated recently can come out empty while its tasks
  // exist. Say so, or the turn will create the task a second time.
  const caveats =
    tasks.length === 0 && full.taskCoverage.total > 0
      ? [
          ...full.caveats,
          `channel_tasks_outside_recency_bound: no task for ${label ?? connector} among the ${full.tasks.length} most recently updated of ${full.taskCoverage.total} open tasks; task_list is allowed for this channel`,
        ]
      : full.caveats;
  const packet: OwnerReportContextV1 = {
    ...full,
    caveats,
    tasks,
    taskCoverage: {
      total: full.taskCoverage.total,
      returned: tasks.length,
      truncated: full.taskCoverage.truncated,
    },
    correlations: { coverage: { ...full.correlations.coverage }, rows },
  };
  recomputeCorrelationCoverage(packet.correlations);
  setPacketBytes(packet);
  return packet;
}
