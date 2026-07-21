import type {
  EnqueueTemporalGenerationInput,
  TaskRecord,
  TemporalGenerationEnqueueResult,
} from './task-ledger.js';
import { occurrenceKeyForTask, temporalGenerationKey } from './task-temporal.js';

export type TemporalCandidateKind = 'exact_or_deferred' | 'date_activation';

export interface TemporalCandidate extends EnqueueTemporalGenerationInput {
  kind: TemporalCandidateKind;
}

export interface TemporalSelectionOptions {
  now: number;
  timeZone: string;
  exactLimit?: number;
  dateLimit?: number;
}

export interface TemporalScannerLedger {
  listTemporalScanPage(input: { limit: number; offset: number }): TaskRecord[];
  findTemporalGenerationKeys(generationKeys: readonly string[]): Set<string>;
  countOpenWorkOrders(kind: 'temporal'): number;
  enqueueTemporalGeneration(input: EnqueueTemporalGenerationInput): TemporalGenerationEnqueueResult;
}

export interface TemporalSchedulerOptions {
  ledger: TemporalScannerLedger;
  now: () => number;
  timeZone: string;
  intervalMs?: number;
  maxOpen?: number;
  exactLimit?: number;
  dateLimit?: number;
  setInterval?: (callback: () => void, intervalMs: number) => NodeJS.Timeout;
  clearInterval?: (timer: NodeJS.Timeout) => void;
  log?: (line: string) => void;
}

export interface TemporalTickResult {
  enqueued: number;
  saturated: boolean;
}

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_MAX_OPEN = 10;
const DEFAULT_EXACT_LIMIT = 4;
const DEFAULT_DATE_LIMIT = 1;
const TASK_SCAN_LIMIT = 200;

function retainBestCandidates(
  retained: TemporalCandidate[],
  incoming: TemporalCandidate[],
  kind: TemporalCandidateKind,
  limit: number
): TemporalCandidate[] {
  return [...retained, ...incoming]
    .filter((candidate) => candidate.kind === kind)
    .sort((left, right) => left.checkAt - right.checkAt || left.taskId - right.taskId)
    .slice(0, limit);
}

function dateInIanaZone(epochMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(epochMs));
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = values.get('year');
  const month = values.get('month');
  const day = values.get('day');
  if (!year || !month || !day) {
    throw new Error(`could not derive local date in time zone: ${timeZone}`);
  }
  return `${year}-${month}-${day}`;
}

function dateAtTaskBoundary(
  epochMs: number,
  offsetMinutes: number | null,
  timeZone: string
): string {
  if (offsetMinutes !== null) {
    return new Date(epochMs + offsetMinutes * 60_000).toISOString().slice(0, 10);
  }
  return dateInIanaZone(epochMs, timeZone);
}

export function startOfTaskDate(
  deadlineIso: string,
  offsetMinutes: number | null,
  timeZone: string
): number {
  const utcMidnight = Date.parse(`${deadlineIso}T00:00:00Z`);
  if (!Number.isFinite(utcMidnight)) {
    throw new Error(`invalid task deadline date: ${deadlineIso}`);
  }
  if (offsetMinutes !== null) {
    if (!Number.isInteger(offsetMinutes) || offsetMinutes < -840 || offsetMinutes > 840) {
      throw new Error(`invalid task deadline offset: ${offsetMinutes}`);
    }
    return utcMidnight - offsetMinutes * 60_000;
  }

  // Find the first UTC millisecond that formats as the requested local date.
  // This remains correct across DST changes where a fixed 24-hour subtraction does not.
  let low = utcMidnight - 36 * 60 * 60 * 1000;
  let high = utcMidnight + 36 * 60 * 60 * 1000;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (dateInIanaZone(middle, timeZone) < deadlineIso) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  if (dateInIanaZone(low, timeZone) !== deadlineIso) {
    throw new Error(`task deadline date ${deadlineIso} does not exist in time zone ${timeZone}`);
  }
  return low;
}

export function buildTemporalGenerationKey(task: TaskRecord, checkAt: number): string {
  const occurrenceKey = occurrenceKeyForTask(task);
  if (!occurrenceKey) {
    throw new Error(`task ${task.id} has no temporal occurrence`);
  }
  if (!Number.isSafeInteger(checkAt)) {
    throw new Error(`task ${task.id} checkAt must be an epoch millisecond integer`);
  }
  return temporalGenerationKey(task.id, occurrenceKey, checkAt);
}

function candidateForTask(
  task: TaskRecord,
  now: number,
  timeZone: string
): TemporalCandidate | null {
  if (task.status === 'done' || task.status === 'cancelled') return null;
  const occurrenceKey = occurrenceKeyForTask(task);
  if (!occurrenceKey || task.temporalReconciledOccurrenceKey === occurrenceKey) return null;

  if (task.dueAt !== null) {
    const checkAt = task.nextTemporalCheckAt ?? task.dueAt;
    if (checkAt > now) return null;
    return {
      kind: 'exact_or_deferred',
      generationKey: buildTemporalGenerationKey(task, checkAt),
      taskId: task.id,
      temporalEpoch: task.temporalEpoch,
      occurrenceKey,
      checkAt,
      sourceChannel: task.sourceChannel,
      sourceEventId: task.sourceEventId,
      priority: 'high',
    };
  }
  if (task.deadlineIso === null) return null;
  const today = dateAtTaskBoundary(now, task.deadlineOffsetMinutes, timeZone);
  if (task.deadlineIso > today) return null;
  if (task.nextTemporalCheckAt !== null && task.nextTemporalCheckAt > now) return null;
  const isDeferred = task.nextTemporalCheckAt !== null;
  const checkAt =
    task.nextTemporalCheckAt ??
    startOfTaskDate(task.deadlineIso, task.deadlineOffsetMinutes, timeZone);
  return {
    kind: isDeferred ? 'exact_or_deferred' : 'date_activation',
    generationKey: buildTemporalGenerationKey(task, checkAt),
    taskId: task.id,
    temporalEpoch: task.temporalEpoch,
    occurrenceKey,
    checkAt,
    sourceChannel: task.sourceChannel,
    sourceEventId: task.sourceEventId,
    priority: isDeferred ? 'high' : 'normal',
  };
}

export function selectTemporalCandidates(
  tasks: readonly TaskRecord[],
  existingGenerationKeys: ReadonlySet<string>,
  options: TemporalSelectionOptions
): TemporalCandidate[] {
  const exactLimit = options.exactLimit ?? DEFAULT_EXACT_LIMIT;
  const dateLimit = options.dateLimit ?? DEFAULT_DATE_LIMIT;
  const candidates = tasks
    .map((task) => candidateForTask(task, options.now, options.timeZone))
    .filter((candidate): candidate is TemporalCandidate => candidate !== null)
    .filter((candidate) => !existingGenerationKeys.has(candidate.generationKey));
  const exact = candidates
    .filter((candidate) => candidate.kind === 'exact_or_deferred')
    .sort((left, right) => left.checkAt - right.checkAt || left.taskId - right.taskId)
    .slice(0, exactLimit);
  const dates = candidates
    .filter((candidate) => candidate.kind === 'date_activation')
    .sort((left, right) => left.checkAt - right.checkAt || left.taskId - right.taskId)
    .slice(0, dateLimit);
  return [...exact, ...dates];
}

export class TemporalReconcileScheduler {
  private readonly options: TemporalSchedulerOptions;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: TemporalSchedulerOptions) {
    this.options = options;
    // Validate once before interval callbacks depend on the zone.
    new Intl.DateTimeFormat('en-US', { timeZone: options.timeZone }).format(0);
  }

  tick(): TemporalTickResult {
    const maxOpen = this.options.maxOpen ?? DEFAULT_MAX_OPEN;
    const open = this.options.ledger.countOpenWorkOrders('temporal');
    if (open >= maxOpen) return { enqueued: 0, saturated: true };

    const now = this.options.now();
    const exactLimit = this.options.exactLimit ?? DEFAULT_EXACT_LIMIT;
    const dateLimit = this.options.dateLimit ?? DEFAULT_DATE_LIMIT;
    let exact: TemporalCandidate[] = [];
    let dates: TemporalCandidate[] = [];
    for (let offset = 0; ; offset += TASK_SCAN_LIMIT) {
      const tasks = this.options.ledger.listTemporalScanPage({
        limit: TASK_SCAN_LIMIT,
        offset,
      });
      if (tasks.length === 0) break;
      const pageCandidates = selectTemporalCandidates(tasks, new Set(), {
        now,
        timeZone: this.options.timeZone,
        exactLimit: TASK_SCAN_LIMIT,
        dateLimit: TASK_SCAN_LIMIT,
      });
      const existing = this.options.ledger.findTemporalGenerationKeys(
        pageCandidates.map((candidate) => candidate.generationKey)
      );
      const eligible = pageCandidates.filter((candidate) => !existing.has(candidate.generationKey));
      exact = retainBestCandidates(exact, eligible, 'exact_or_deferred', exactLimit);
      dates = retainBestCandidates(dates, eligible, 'date_activation', dateLimit);
      if (tasks.length < TASK_SCAN_LIMIT) break;
    }
    const candidates = [...exact, ...dates].slice(0, maxOpen - open);
    for (const candidate of candidates) {
      this.options.ledger.enqueueTemporalGeneration(candidate);
    }
    return { enqueued: candidates.length, saturated: false };
  }

  start(): void {
    if (this.timer) throw new Error('temporal reconcile scheduler already started');
    const setTimer = this.options.setInterval ?? setInterval;
    this.timer = setTimer(() => {
      try {
        this.tick();
      } catch (error) {
        const line = `[temporal-reconcile] tick failed: ${error instanceof Error ? error.message : String(error)}`;
        if (this.options.log) this.options.log(line);
        else console.error(line);
      }
    }, this.options.intervalMs ?? DEFAULT_INTERVAL_MS);
  }

  stop(): void {
    if (!this.timer) return;
    const clearTimer = this.options.clearInterval ?? clearInterval;
    clearTimer(this.timer);
    this.timer = null;
  }
}
