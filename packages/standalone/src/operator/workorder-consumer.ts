/**
 * WorkOrderConsumer - the single host-code consumer of system workorders
 * (Stage 2, plan S2-T3).
 *
 * A dedicated interval timer (60s default) claims pending workorders from the
 * TaskLedger and runs each through workerRun on the operator lane. It runs
 * UNCONDITIONALLY of MAMA_TRIGGER_LOOP (the publishers are unconditional, so
 * coupling consumption to an opt-in loop would strand every workorder - plan
 * A1 BLOCKER), gated only by MAMA_STAGE2_WORKORDERS=shadow|on.
 *
 * Serial consumption: one claim at a time, awaited to completion, with a tick
 * re-entrancy guard (a 260s board run spans 4+ ticks - overlapping ticks skip,
 * plan G4). Blocking bound = the runner's per-request timeout x maxTurns; no
 * consumer-level watchdog (plan N2).
 *
 * Failure policy (plan G5/M4): failWorkOrder marks the row, then per-kind
 * maxAttempts decides requeue (fresh row, attempts+1, same occurrence key)
 * vs retries-exhausted (owner alarm, deduped per kind). Boot recovery routes
 * stale in_progress claims (crash artifacts) through the SAME policy, with a
 * separate stale-claim alarm.
 *
 * Completion hooks (plan E3/E4): per-kind before/after seams re-home the
 * post-run host effects the legacy closures owned (board bracket
 * verification, promotion event re-emission, wiki noUpdate reading). Hook
 * errors remain observe-only for existing kinds. A kind may opt into a typed
 * blocking verdict; A1 does not enable that option for any production kind.
 */

import type { WorkOrderKind, WorkOrderRecord, EnqueueWorkOrderInput } from './task-ledger.js';
import { workerRun, type WorkerRunner } from './worker-run.js';

export interface WorkOrderLedgerPort {
  claimNextWorkOrder(): WorkOrderRecord | null;
  completeWorkOrder(id: number): void;
  failWorkOrder(id: number, reason: string): void;
  /** Atomic fail+replacement (retry) - one transaction (PR bot round). */
  requeueWorkOrder(wo: WorkOrderRecord, reason: string): WorkOrderRecord;
  requeueTemporalWorkOrder(attemptId: number, reason: string): WorkOrderRecord;
  exhaustTemporalWorkOrder(attemptId: number, reason: string): void;
  enqueueWorkOrder(order: EnqueueWorkOrderInput): WorkOrderRecord;
  listStaleClaims(): WorkOrderRecord[];
  countPendingWorkOrders(): number;
}

/** Active owner alarm channel (telegram via the ops sink; may be unconfigured). */
export interface OpsAlarmSink {
  configured: boolean;
  send(line: string): Promise<void>;
}

export type WorkOrderEffectVerdict =
  | { disposition: 'complete' }
  | { disposition: 'fail'; reason: string };

export interface WorkOrderHook {
  /** Bracket 'before' state (e.g. verifier snapshot at claim time). */
  before?: (wo: WorkOrderRecord) => unknown | Promise<unknown>;
  /** Post-run effects (verification, event re-emission, outcome reading). */
  after?: (
    wo: WorkOrderRecord,
    response: string,
    beforeState: unknown
  ) => WorkOrderEffectVerdict | void | Promise<WorkOrderEffectVerdict | void>;
  /** Opt-in only: a missing, malformed, or negative verdict blocks completion. */
  verdictRequired?: boolean;
}

export interface WorkOrderConsumerEvent {
  type: 'complete' | 'failed' | 'requeued' | 'exhausted' | 'stale-claim';
  workKind: WorkOrderKind;
  workOrderId: number;
  reason?: string;
}

export interface WorkOrderConsumerDeps {
  ledger: WorkOrderLedgerPort;
  runner: WorkerRunner;
  /** null = brief missing -> the workorder fails loudly (never a silent skip). */
  loadBrief: (kind: WorkOrderKind) => string | null;
  /** Passive owner surface (AgentNoticeQueue via MessageRouter accessor). */
  noticeOwner: (summary: string) => void;
  opsAlarm: OpsAlarmSink;
  /** Telemetry seam (agent_activity / eventBus) - optional. */
  onEvent?: (event: WorkOrderConsumerEvent) => void;
  /**
   * Per-order extra run options (Stage-2: per-run envelope issuance + the
   * shadow capture-publisher override). May be async - envelope issuance
   * persists to the DB. A THROW/REJECT here fails the order loudly - at
   * shadow, a missing capture publisher must never fall through to a live
   * publish (plan T4 AC), and a run without an envelope would have every
   * model_tool call denied 'envelope_missing'.
   */
  runOptionsFor?: (
    wo: WorkOrderRecord
  ) => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>;
  log?: (line: string) => void;
  tickMs?: number;
  now?: () => number;
}

/** Per-kind retry budget: attempts start at 1; board/promotion self-heal on
 *  the next publish cycle, wiki events do not re-fire so it retries once. */
export const WORKORDER_MAX_ATTEMPTS: Record<WorkOrderKind, number> = {
  board: 1,
  wiki: 2,
  'memory-curation': 1,
  temporal: 3,
};

const DEFAULT_TICK_MS = 60_000;
const ALARM_DEDUP_MS = 6 * 60 * 60 * 1000;
const MAX_EFFECT_VERDICT_REASON_LENGTH = 500;

export class WorkOrderConsumer {
  private readonly deps: WorkOrderConsumerDeps;
  private readonly hooks = new Map<WorkOrderKind, WorkOrderHook>();
  private readonly lastAlarmAt = new Map<WorkOrderKind, number>();
  private timer: NodeJS.Timeout | null = null;
  private consuming = false;
  private activeTick: Promise<unknown> | null = null;

  constructor(deps: WorkOrderConsumerDeps) {
    this.deps = deps;
  }

  registerHook(kind: WorkOrderKind, hook: WorkOrderHook): void {
    if (this.hooks.has(kind)) {
      throw new Error(`[workorder-consumer] hook for '${kind}' already registered`);
    }
    this.hooks.set(kind, hook);
  }

  /**
   * Boot recovery (plan C4/M4): in_progress system rows are crash artifacts
   * (single serial consumer). Each routes through the SAME failure policy
   * (a crashed wiki batch requeues once; board/promotion do not), plus a
   * separate stale-claim alarm.
   */
  bootRecover(): void {
    for (const wo of this.deps.ledger.listStaleClaims()) {
      this.log(`[workorder-consumer] stale claim recovered: ${wo.workKind}#${wo.id}`);
      this.emitEvent({ type: 'stale-claim', workKind: wo.workKind, workOrderId: wo.id });
      this.alarm(wo.workKind, `workorder ${wo.workKind}#${wo.id} stale claim (daemon crash?)`);
      this.handleFailure(wo, 'stale-claim');
    }
  }

  start(): void {
    if (this.timer) {
      throw new Error('[workorder-consumer] already started');
    }
    const tickMs = this.deps.tickMs ?? DEFAULT_TICK_MS;
    this.timer = setInterval(() => {
      // Only track a REAL tick: during a long run subsequent firings resolve
      // 'skipped' instantly and would OVERWRITE activeTick - stop() would
      // then await the skipped promise while the true tick still runs and
      // the DB closes under it (round-2 review N1).
      if (!this.consuming) {
        this.activeTick = this.tick();
      }
    }, tickMs);
    this.timer.unref?.();
    this.log(`[workorder-consumer] started (tick every ${tickMs}ms)`);
  }

  isStarted(): boolean {
    return this.timer !== null;
  }

  /** Graceful: awaits an in-flight tick so shutdown does not race the
   *  operator-DB close into "database is not open" noise (review m4). */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.activeTick) {
      await this.activeTick.catch(() => {});
      this.activeTick = null;
    }
  }

  /**
   * Drain pending workorders serially: claim -> await -> next claim. Returns
   * 'skipped' when a previous tick is still consuming (re-entrancy guard,
   * plan G4) - long runs span multiple tick firings.
   */
  async tick(): Promise<'drained' | 'skipped'> {
    if (this.consuming) return 'skipped';
    this.consuming = true;
    try {
      // Drain is BOUNDED by the pending count at tick start: a row requeued
      // by this tick's failure policy waits for the NEXT tick (natural
      // backoff - otherwise a failing order retries in a tight loop).
      let remaining = this.deps.ledger.countPendingWorkOrders();
      while (remaining > 0) {
        const wo = this.deps.ledger.claimNextWorkOrder();
        if (!wo) break;
        await this.runOne(wo);
        remaining--;
      }
      return 'drained';
    } finally {
      this.consuming = false;
    }
  }

  private async runOne(wo: WorkOrderRecord): Promise<void> {
    let brief: string | null;
    try {
      brief = this.deps.loadBrief(wo.workKind);
    } catch (err) {
      // I/O errors (permissions etc.) must fail THIS order, not abort the
      // whole tick with a stranded claim (PR bot round).
      this.handleFailure(wo, `brief-load-failed: ${errMessage(err)}`);
      return;
    }
    if (!brief || !brief.trim()) {
      this.log(`[workorder-consumer] brief missing for '${wo.workKind}' - failing #${wo.id}`);
      this.handleFailure(wo, 'brief-missing');
      return;
    }

    const hook = this.hooks.get(wo.workKind);
    let beforeState: unknown;
    if (hook?.before) {
      try {
        beforeState = await hook.before(wo);
      } catch (err) {
        // A broken before-hook must not strand the claim: fail the order loudly.
        this.handleFailure(wo, `before-hook: ${errMessage(err)}`);
        return;
      }
    }

    let response: string;
    try {
      // Inside the try: a runOptionsFor throw/reject (shadow capture publisher
      // missing, envelope issuance failure) fails the order instead of running
      // with the live publisher / without an envelope.
      const runOptions = await this.deps.runOptionsFor?.(wo);
      response = await workerRun(this.deps.runner, {
        kind: wo.workKind,
        brief,
        input: JSON.stringify(wo.payload),
        runOptions,
      });
    } catch (err) {
      this.handleFailure(wo, errMessage(err));
      return;
    }

    let verdict: WorkOrderEffectVerdict | void = undefined;
    if (hook?.after) {
      try {
        verdict = await hook.after(wo, response, beforeState);
      } catch (err) {
        if (hook.verdictRequired) {
          this.handleFailure(wo, boundedEffectFailure('after-hook: ', err));
          return;
        }
        // Existing kinds remain observe-only: a verification/emission failure
        // is loud but does not fail a run that completed.
        this.log(
          `[workorder-consumer] after-hook error (${wo.workKind}#${wo.id}): ${errMessage(err)}`
        );
      }
    }

    if (hook?.verdictRequired) {
      if (verdict === undefined) {
        this.handleFailure(wo, 'effect-verdict-missing');
        return;
      }
      if (typeof verdict !== 'object' || verdict === null || Array.isArray(verdict)) {
        this.handleFailure(wo, 'effect-verdict-invalid');
        return;
      }
      if (verdict.disposition === 'fail') {
        const reason = typeof verdict.reason === 'string' ? verdict.reason.trim() : '';
        if (!reason || reason.length > MAX_EFFECT_VERDICT_REASON_LENGTH) {
          this.handleFailure(wo, 'effect-verdict-invalid');
          return;
        }
        this.handleFailure(wo, reason);
        return;
      }
      if (verdict.disposition !== 'complete') {
        this.handleFailure(wo, 'effect-verdict-invalid');
        return;
      }
    }

    // Shadow-gate diagnostics (§8.2): the worker's actual output decides
    // whether the tool path works - log a bounded head, never the full body.
    this.log(
      `[workorder-consumer] ${wo.workKind}#${wo.id} response head: ${response.slice(0, 200).replace(/\n/g, ' | ')}`
    );
    this.deps.ledger.completeWorkOrder(wo.id);
    this.emitEvent({ type: 'complete', workKind: wo.workKind, workOrderId: wo.id });
    this.log(`[workorder-consumer] completed ${wo.workKind}#${wo.id}`);
  }

  /**
   * Failure policy layer (plan G5): mark failed, then requeue (attempts+1,
   * fresh row, same occurrence key - the terminal row freed it) or declare
   * retries-exhausted with an owner alarm.
   */
  private handleFailure(wo: WorkOrderRecord, reason: string): void {
    const maxAttempts = WORKORDER_MAX_ATTEMPTS[wo.workKind];
    if (wo.payload.attempts < maxAttempts) {
      // Atomic fail+requeue (PR bot round): a crash between separate fail and
      // enqueue calls would silently lose the retry.
      const requeued =
        wo.workKind === 'temporal'
          ? this.deps.ledger.requeueTemporalWorkOrder(wo.id, reason)
          : this.deps.ledger.requeueWorkOrder(wo, reason);
      this.emitEvent({ type: 'failed', workKind: wo.workKind, workOrderId: wo.id, reason });
      this.emitEvent({ type: 'requeued', workKind: wo.workKind, workOrderId: requeued.id });
      this.log(
        `[workorder-consumer] failed ${wo.workKind}#${wo.id} (${reason}) -> requeued #${requeued.id} (attempt ${wo.payload.attempts + 1}/${maxAttempts})`
      );
      return;
    }

    if (wo.workKind === 'temporal') {
      this.deps.ledger.exhaustTemporalWorkOrder(wo.id, reason);
    } else {
      this.deps.ledger.failWorkOrder(wo.id, reason);
    }
    this.emitEvent({ type: 'failed', workKind: wo.workKind, workOrderId: wo.id, reason });
    this.log(`[workorder-consumer] failed ${wo.workKind}#${wo.id}: ${reason}`);
    this.emitEvent({ type: 'exhausted', workKind: wo.workKind, workOrderId: wo.id, reason });
    this.alarm(
      wo.workKind,
      `workorder ${wo.workKind}#${wo.id} retries exhausted (${wo.payload.attempts}/${maxAttempts}): ${reason}`
    );
  }

  /** Owner alarm: passive notice + active telegram, deduped per kind (6h). */
  private alarm(kind: WorkOrderKind, message: string): void {
    const now = this.deps.now?.() ?? Date.now();
    const last = this.lastAlarmAt.get(kind);
    if (last !== undefined && now - last < ALARM_DEDUP_MS) {
      this.log(`[workorder-consumer] alarm deduped (${kind}): ${message}`);
      return;
    }
    this.lastAlarmAt.set(kind, now);
    try {
      this.deps.noticeOwner(message);
    } catch (err) {
      this.log(`[workorder-consumer] notice enqueue failed: ${errMessage(err)}`);
    }
    if (this.deps.opsAlarm.configured) {
      void this.deps.opsAlarm.send(`⚠️ ${message}`).catch((err) => {
        this.log(`[workorder-consumer] active alarm send failed: ${errMessage(err)}`);
      });
    } else {
      this.log(`[workorder-consumer] active alarm unconfigured - log-only: ${message}`);
    }
  }

  private emitEvent(event: WorkOrderConsumerEvent): void {
    try {
      this.deps.onEvent?.(event);
    } catch {
      /* telemetry only */
    }
  }

  private log(line: string): void {
    (this.deps.log ?? console.log)(line);
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function boundedEffectFailure(prefix: string, err: unknown): string {
  return `${prefix}${errMessage(err)}`.slice(0, MAX_EFFECT_VERDICT_REASON_LENGTH);
}
