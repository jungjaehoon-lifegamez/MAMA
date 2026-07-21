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

export function buildReconcilePrompt(input: ReconcilePromptInput): string {
  const label = input.channelLabel ?? input.channelKey;
  const scope = `reconcile:${input.channelKey}`;
  return [
    `${RECONCILE_RUN_TOKEN} for channel ${label} (${input.channelKey}). Today is ${input.todayIso}.`,
    'New messages arrived in this channel. Reconcile the operator board and the task ledger',
    'against them. Plan (execute in order):',
    '1. Read the delta lines below.',
    `2. task_list() for existing work items${input.kagemushaContext ? ' and kagemusha_tasks() as extra CONTEXT (the native ledger stays the projection source)' : ''}.`,
    '3. Judge which slots are affected (briefing / action_required / decisions / pipeline).',
    '4. You MUST call at least ONE of: report_publish with ONLY the affected slots,',
    '   task_create, or task_update -- when the delta concerns work that ALREADY has a',
    '   task row (match by title or source in step 2), task_update that row instead of',
    '   creating a near-duplicate, and pass source_channel plus source_event_id from the',
    '   delta header so retries upsert. If NOTHING on the board or ledger is affected,',
    `   you MUST call contract_no_update({reason, scope: "${scope}"}) instead.`,
    '5. Finish with exactly one line: RECONCILED <comma-separated slots or none>.',
    '',
    'Constraints: do not rewrite unaffected slots; no mama_save; no follow-up questions.',
    '- Set due_at only from trusted, unambiguous time and time zone evidence; otherwise retain date-only precision.',
    '- Never infer completion from calendar disappearance.',
    '- Never copy Trello or Kagemusha lifecycle status into the native ledger.',
    '',
    `<latest-delta channel="${input.channelKey}">`,
    ...input.deltaLines,
    '</latest-delta>',
  ].join('\n');
}

export interface ReconcileSchedulerOptions {
  /** Trailing-edge debounce per channel. */
  debounceMs?: number;
  /** A continuously-busy channel still fires by this bound (anti-starvation). */
  maxWaitMs?: number;
  /** GLOBAL budget across all channels (sliding hour). Over-budget defers, never drops. */
  globalMaxPerHour?: number;
  /** Bounded pending lines kept per channel while deferred. */
  maxPendingLines?: number;
  run: (channelKey: string, deltaLines: string[]) => Promise<void>;
  log: (line: string) => void;
  now?: () => number;
}

interface ChannelState {
  pendingLines: string[];
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

  enqueue(channelKey: string, lines: string[]): void {
    if (this.stopped) return;
    const state = this.channels.get(channelKey) ?? {
      pendingLines: [],
      debounceTimer: null,
      firstEnqueuedAt: null,
    };
    state.pendingLines = [...state.pendingLines, ...lines].slice(-this.maxPendingLines);
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
    state.pendingLines = [];
    state.firstEnqueuedAt = null;
    this.runTimestamps.push(this.now());

    try {
      await this.run(channelKey, lines);
    } catch (err) {
      // Run failure keeps the channel dirty for retry; the scheduler survives.
      state.pendingLines = [...lines, ...state.pendingLines].slice(-this.maxPendingLines);
      if (state.firstEnqueuedAt === null) state.firstEnqueuedAt = this.now();
      this.log(
        `[reconcile] run failed for ${channelKey}: ${err instanceof Error ? err.message : String(err)}; kept dirty for retry`
      );
      this.scheduleRetry();
    }
  }
}
