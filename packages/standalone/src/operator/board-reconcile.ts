/**
 * board-reconcile - the delta -> taskboard reconcile contract (M8 Phase 1).
 *
 * Ports Kagemusha's taskboard reconcile mechanism (agent-awareness.ts
 * buildTaskboardReconcilePrompt / runTaskboardReconcile): when a channel delta
 * arrives, the AGENT judges which board slots are affected and MUST either act
 * (partial report_publish / task_create / task_update) or record a
 * contract_no_update note. The system only debounces, budgets, and serializes;
 * every judgment is the agent's (agent-first).
 *
 * Freshness-layer semantics: the 30-minute dashboard cron remains the
 * repair/catch-up pass. Over-budget work is DEFERRED (channel stays dirty with
 * its pending lines), never silently dropped; a crash loses at most one
 * debounce window, which the next cron repairs.
 */

export interface ReconcilePromptInput {
  /** "<connector>:<channelId>" - connector-qualified, collision-free. */
  channelKey: string;
  channelLabel?: string;
  deltaLines: string[];
  todayIso: string;
  /** Also read kagemusha_tasks as judgment CONTEXT (never the projection source). */
  kagemushaContext?: boolean;
}

/** The prompt MUST begin with this token so the persona's RECONCILE RUN mode engages. */
export const RECONCILE_RUN_TOKEN = 'RECONCILE RUN';

/** Generous: live batches run 1-30. A cap that truncates is logged, never silent. */
const MAX_PENDING_EVENT_IDS = 500;

export interface ReconcileSchedulerOptions {
  /** Trailing-edge debounce per channel. */
  debounceMs?: number;
  /** A continuously-busy channel still fires by this bound (anti-starvation). */
  maxWaitMs?: number;
  /** GLOBAL budget across all channels (sliding hour). Over-budget defers, never drops. */
  globalMaxPerHour?: number;
  /** Bounded pending lines kept per channel while deferred. */
  maxPendingLines?: number;
  run: (
    channelKey: string,
    deltaLines: string[],
    eventIds: string[],
    repairGeneration: number
  ) => Promise<void>;
  log: (line: string) => void;
  now?: () => number;
}

interface ChannelState {
  pendingLines: string[];
  /**
   * The batch, accumulated separately from the prompt lines.
   *
   * Not the same cardinality: the prompt shows a bounded tail while the cause is every
   * event the run will have acted on. Truncating them with one cap would silently drop
   * events from the record of why the run did what it did - and two parallel arrays with
   * independent caps is how that drift starts.
   */
  pendingEventIds: string[];
  /** Newest gate generation represented by the coalesced batch. */
  repairGeneration: number;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  firstEnqueuedAt: number | null;
}

export class ReconcileScheduler {
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly globalMaxPerHour: number;
  private readonly maxPendingLines: number;
  private readonly run: ReconcileSchedulerOptions['run'];
  private readonly log: ReconcileSchedulerOptions['log'];
  private readonly now: () => number;

  private channels = new Map<string, ChannelState>();
  private runTimestamps: number[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(opts: ReconcileSchedulerOptions) {
    this.debounceMs = opts.debounceMs ?? 180_000;
    this.maxWaitMs = opts.maxWaitMs ?? 600_000;
    this.globalMaxPerHour = opts.globalMaxPerHour ?? 12;
    this.maxPendingLines = opts.maxPendingLines ?? 30;
    this.run = opts.run;
    this.log = opts.log;
    this.now = opts.now ?? Date.now;
  }

  enqueue(
    channelKey: string,
    lines: string[],
    eventIds: readonly string[] = [],
    repairGeneration = 0
  ): void {
    if (this.stopped) return;
    if (!Number.isSafeInteger(repairGeneration) || repairGeneration < 0) {
      throw new Error('reconcile repairGeneration must be a non-negative safe integer');
    }
    const state = this.channels.get(channelKey) ?? {
      pendingLines: [],
      pendingEventIds: [],
      repairGeneration: 0,
      debounceTimer: null,
      firstEnqueuedAt: null,
    };
    state.pendingLines = [...state.pendingLines, ...lines].slice(-this.maxPendingLines);
    const mergedIds = [...new Set([...state.pendingEventIds, ...eventIds])];
    if (mergedIds.length > MAX_PENDING_EVENT_IDS) {
      // Loud, because a truncated cause set understates what the run rested on and would
      // otherwise look exactly like a smaller batch.
      this.log(
        `[reconcile] ${channelKey}: cause set exceeded ${MAX_PENDING_EVENT_IDS}; dropping the oldest ${mergedIds.length - MAX_PENDING_EVENT_IDS}`
      );
    }
    state.pendingEventIds = mergedIds.slice(-MAX_PENDING_EVENT_IDS);
    state.repairGeneration = Math.max(state.repairGeneration, repairGeneration);
    if (state.firstEnqueuedAt === null) state.firstEnqueuedAt = this.now();
    this.channels.set(channelKey, state);

    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    // Trailing debounce with a max-wait bound: continuous traffic cannot
    // starve the channel past maxWaitMs since its first pending event.
    const sinceFirst = this.now() - state.firstEnqueuedAt;
    const delay = Math.max(0, Math.min(this.debounceMs, this.maxWaitMs - sinceFirst));
    const timer = setTimeout(() => {
      state.debounceTimer = null;
      void this.fire(channelKey);
    }, delay);
    timer.unref?.();
    state.debounceTimer = timer;
  }

  /** Channels currently holding deferred/pending work (for observability). */
  dirtyChannels(): string[] {
    return [...this.channels.entries()]
      .filter(([, s]) => s.pendingLines.length > 0)
      .map(([k]) => k);
  }

  stop(): void {
    this.stopped = true;
    for (const state of this.channels.values()) {
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
      state.debounceTimer = null;
    }
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private budgetAvailable(): boolean {
    const cutoff = this.now() - 3_600_000;
    this.runTimestamps = this.runTimestamps.filter((t) => t > cutoff);
    return this.runTimestamps.length < this.globalMaxPerHour;
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.stopped) return;
    const timer = setTimeout(() => {
      this.retryTimer = null;
      const dirty = this.dirtyChannels();
      for (const key of dirty) {
        const state = this.channels.get(key);
        if (state && !state.debounceTimer) void this.fire(key);
      }
    }, 60_000);
    timer.unref?.();
    this.retryTimer = timer;
  }

  private async fire(channelKey: string): Promise<void> {
    if (this.stopped) return;
    const state = this.channels.get(channelKey);
    if (!state || state.pendingLines.length === 0) return;

    if (!this.budgetAvailable()) {
      // DEFER, never drop: the channel stays dirty and retries when budget frees.
      this.log(
        `[reconcile] global budget exhausted (${this.globalMaxPerHour}/h); deferring ${channelKey} (${state.pendingLines.length} lines kept)`
      );
      this.scheduleRetry();
      return;
    }

    const lines = state.pendingLines;
    const eventIds = state.pendingEventIds;
    const repairGeneration = state.repairGeneration;
    state.pendingLines = [];
    state.pendingEventIds = [];
    state.repairGeneration = 0;
    state.firstEnqueuedAt = null;
    this.runTimestamps.push(this.now());

    try {
      await this.run(channelKey, lines, eventIds, repairGeneration);
    } catch (err) {
      // Run failure keeps the channel dirty for retry; the scheduler survives. The cause
      // set is restored with the lines - a retry that kept the prompt but lost the batch
      // would run on evidence it could no longer name.
      state.pendingLines = [...lines, ...state.pendingLines].slice(-this.maxPendingLines);
      state.pendingEventIds = [...new Set([...eventIds, ...state.pendingEventIds])].slice(
        -MAX_PENDING_EVENT_IDS
      );
      state.repairGeneration = Math.max(repairGeneration, state.repairGeneration);
      if (state.firstEnqueuedAt === null) state.firstEnqueuedAt = this.now();
      this.log(
        `[reconcile] run failed for ${channelKey}: ${err instanceof Error ? err.message : String(err)}; kept dirty for retry`
      );
      this.scheduleRetry();
    }
  }
}
