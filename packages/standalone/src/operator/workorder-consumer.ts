/**
 * WorkOrderConsumer - the single host-code consumer of system workorders
 * (Stage 2, plan S2-T3).
 *
 * A dedicated interval timer (60s default) claims pending workorders from the
 * TaskLedger and runs each through workerRun on the operator lane. It runs
 * UNCONDITIONALLY of MAMA_TRIGGER_LOOP (the publishers are unconditional, so
 * coupling consumption to an opt-in loop would strand every workorder - plan
 * A1 BLOCKER). Since v0.28.0 this is the ONLY system run path.
 *
 * Serial consumption: one claim at a time, awaited to completion, with a tick
 * re-entrancy guard (a 260s board run spans 4+ ticks - overlapping ticks skip,
 * plan G4). Blocking bound = the runner's per-request timeout x maxTurns; no
 * consumer-level watchdog (plan N2).
 *
 * Failure policy (plan G5/M4): ordinary kinds use failWorkOrder plus per-kind
 * retry limits. Temporal attempts instead run durable generation arbitration,
 * so a committed effect wins over runner transport failure and retries remain
 * tied to one generation. Boot recovery routes stale in_progress claims
 * through the matching policy and emits a separate stale-claim alarm.
 *
 * Completion hooks (plan E3/E4): per-kind before/after seams re-home the
 * post-run host effects the legacy closures owned (board bracket
 * verification, promotion event re-emission, wiki noUpdate reading). Hook
 * errors remain observe-only for existing kinds. Temporal work opts into a
 * blocking verdict, with its durable receipt still authoritative over runner
 * or verifier transport failures.
 */

import { createHash } from 'node:crypto';

import { AgentError } from '../agent/types.js';

import {
  TEMPORAL_WORKORDER_MAX_ATTEMPTS,
  type WorkOrderKind,
  type WorkOrderRecord,
  type EnqueueWorkOrderInput,
  type BoardCandidateAttemptState,
  type TemporalAttemptState,
  type TemporalWorkFailureResult,
} from './task-ledger.js';
import { workerRun, type WorkerRunner } from './worker-run.js';
import { getLegCadence } from './leg-cadence.js';

export interface WorkOrderLedgerPort {
  claimNextWorkOrder(): WorkOrderRecord | null;
  completeWorkOrder(id: number): void;
  failWorkOrder(id: number, reason: string): void;
  /** Atomic fail+replacement (retry) - one transaction (PR bot round). */
  requeueWorkOrder(wo: WorkOrderRecord, reason: string): WorkOrderRecord;
  inspectTemporalAttempt(attemptId: number): TemporalAttemptState;
  inspectBoardCandidateAttempt(attemptId: number): BoardCandidateAttemptState;
  failTemporalWorkOrder(
    attemptId: number,
    reason: string,
    allowRetry?: boolean
  ): TemporalWorkFailureResult;
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
  type: 'complete' | 'failed' | 'requeued' | 'exhausted' | 'stale-claim' | 'superseded';
  workKind: WorkOrderKind;
  workOrderId: number;
  reason?: string;
  /** input+output tokens of the completed run, when the runner reported usage.
   *  Restores the tokens_used telemetry the legacy persona path had
   *  (executeValidatedRun) and the Stage-2 cutover lost. */
  tokensUsed?: number;
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
   * Per-order extra run options (Stage-2: per-run envelope issuance). May be
   * async - envelope issuance persists to the DB. A THROW/REJECT here fails
   * the order loudly - a run without an envelope would have every model_tool
   * call denied 'envelope_missing'.
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
  temporal: TEMPORAL_WORKORDER_MAX_ATTEMPTS,
};

export interface SafeCandidateRetryEvidence {
  readonly phase: 'before_runner_call';
  readonly code: 'before_hook_failed' | 'run_options_failed';
}

// This is intentionally a runtime capability, rather than a structural
// TypeScript type. A caller can spell the public fields but cannot add its
// object to this module-private set, so error text and runner output cannot
// manufacture candidate retry authority.
const safeCandidateRetryEvidence = new WeakSet<object>();

function mintSafeCandidateRetryEvidence(
  code: SafeCandidateRetryEvidence['code']
): SafeCandidateRetryEvidence {
  const evidence: SafeCandidateRetryEvidence = { phase: 'before_runner_call', code };
  safeCandidateRetryEvidence.add(evidence);
  return evidence;
}

function hasSafeCandidateRetryEvidence(
  evidence: SafeCandidateRetryEvidence | undefined
): evidence is SafeCandidateRetryEvidence {
  return evidence !== undefined && safeCandidateRetryEvidence.has(evidence);
}

/**
 * An API failure the CLI printed as response text. Bounded to the head of the
 * response so a report that merely QUOTES an old error is not misclassified -
 * the CLI emits the error as (nearly) the whole output, optionally behind the
 * turns-counter prefix.
 */
export function detectTransportErrorResponse(response: string): string | null {
  const head = response.slice(0, 300);
  const match = /(?:^|\|\s*)API Error:\s*(\d{3}[^.\n]*)/.exec(head);
  if (!match) return null;
  // Only when the error IS the message, not buried inside real content: the
  // text before the marker must be nothing but the turns/status prefix.
  const prefix = head.slice(0, match.index);
  if (prefix.replace(/[|\s\d]|turns|⏱️/gu, '').length > 0) return null;
  return `API Error: ${match[1].trim()}`;
}

/** Exported so the boot-time leg declaration and the timer share one number. */
export const DEFAULT_TICK_MS = 60_000;
const ALARM_DEDUP_MS = 6 * 60 * 60 * 1000;
const MAX_EFFECT_VERDICT_REASON_LENGTH = 500;

export class WorkOrderConsumer {
  private readonly deps: WorkOrderConsumerDeps;
  private readonly hooks = new Map<WorkOrderKind, WorkOrderHook>();
  private readonly lastAlarmAt = new Map<string, number>();
  private readonly unresolvedTemporalEffects = new Map<
    number,
    { workOrder: WorkOrderRecord; reason: string; allowRetry: boolean; tokensUsed?: number }
  >();
  private readonly unresolvedBoardCandidateEffects = new Map<
    number,
    {
      workOrder: WorkOrderRecord;
      reason: string;
      retryEvidence?: SafeCandidateRetryEvidence;
      tokensUsed?: number;
      completeWhenNoCandidates: boolean;
    }
  >();
  private timer: NodeJS.Timeout | null = null;
  private consuming = false;
  private stopping = false;
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
      this.alarm(
        wo.workKind,
        `workorder ${wo.workKind}#${wo.id} stale claim (daemon crash?)`,
        wo.workKind === 'temporal' ? 'temporal-stale-claim' : wo.workKind
      );
      this.handleFailure(wo, 'stale-claim');
      if (this.unresolvedTemporalEffects.size > 0 || this.unresolvedBoardCandidateEffects.size > 0)
        break;
    }
  }

  start(): void {
    if (this.timer) {
      throw new Error('[workorder-consumer] already started');
    }
    this.stopping = false;
    const tickMs = this.deps.tickMs ?? DEFAULT_TICK_MS;
    this.timer = setInterval(() => {
      // The INTERVAL is the leg, so the interval beats - unconditionally.
      // The beat used to live inside tick(), but this handler skips tick()
      // while a run is consuming, so every workorder run longer than 2x the
      // cadence went "silent", paged the owner, then "recovered" when the
      // run finished - a page/recover flap on every long run (live, day 1
      // of the S2 window). A consumer mid-run is alive, not silent.
      getLegCadence()?.beat('workorder-consumer');
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
    this.stopping = true;
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
    if (this.consuming || this.stopping) return 'skipped';
    this.consuming = true;
    try {
      // Unknown durable state is a hard claim barrier. Recheck it before any
      // new model work so a database outage cannot produce duplicate effects.
      if (
        this.unresolvedTemporalEffects.size > 0 ||
        this.unresolvedBoardCandidateEffects.size > 0
      ) {
        this.recheckUnresolvedTemporalEffects();
        this.recheckUnresolvedBoardCandidateEffects();
        return 'drained';
      }
      // Drain is BOUNDED by the pending count at tick start: a row requeued
      // by this tick's failure policy waits for the NEXT tick (natural
      // backoff - otherwise a failing order retries in a tight loop).
      let remaining = this.deps.ledger.countPendingWorkOrders();
      while (remaining > 0 && !this.stopping) {
        const wo = this.deps.ledger.claimNextWorkOrder();
        if (!wo) break;
        await this.runOne(wo);
        remaining--;
        if (this.stopping) break;
        if (
          this.unresolvedTemporalEffects.size > 0 ||
          this.unresolvedBoardCandidateEffects.size > 0
        )
          break;
      }
      return 'drained';
    } finally {
      this.consuming = false;
    }
  }

  private async runOne(wo: WorkOrderRecord): Promise<void> {
    if (this.stopping) {
      this.log(`[workorder-consumer] leaving ${wo.workKind}#${wo.id} for boot recovery`);
      return;
    }
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
        this.handleFailure(
          wo,
          `before-hook: ${errMessage(err)}`,
          true,
          wo.workKind === 'board' ? mintSafeCandidateRetryEvidence('before_hook_failed') : undefined
        );
        return;
      }
    }

    let response: string;
    let tokensUsed: number | undefined;
    let runOptions: Record<string, unknown> | undefined;
    try {
      // Inside the try: a runOptionsFor throw/reject (envelope issuance
      // failure) fails the order instead of running without an envelope.
      runOptions = await this.deps.runOptionsFor?.(wo);
    } catch (err) {
      this.handleFailure(
        wo,
        `run-options: ${errMessage(err)}`,
        true,
        wo.workKind === 'board' ? mintSafeCandidateRetryEvidence('run_options_failed') : undefined
      );
      return;
    }

    try {
      const runResult = await workerRun(this.deps.runner, {
        kind: wo.workKind,
        brief,
        input: JSON.stringify(wo.payload),
        runOptions,
      });
      response = runResult.response;
      tokensUsed = runResult.tokensUsed;
    } catch (err) {
      if (this.stopping) {
        this.log(`[workorder-consumer] interrupted ${wo.workKind}#${wo.id}; boot will recover it`);
        return;
      }
      const reason = errMessage(err);
      this.handleFailure(wo, reason, !isAmbiguousCodeActMutation(err));
      return;
    }

    // The claude CLI reports API failures IN-BAND: it exits cleanly and
    // prints the error as response text ("API Error: 529 Overloaded ...").
    // Live proof: board#2042 was marked COMPLETED with exactly that text as
    // its response - a false success whose "content" then reached the owner
    // channel looking like a report. A response that is an API error is a
    // TRANSPORT failure: retry it, never complete it, never deliver it.
    const transportError = detectTransportErrorResponse(response);
    if (transportError) {
      this.handleFailure(wo, `model-transport-error: ${transportError}`);
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

    if (wo.workKind === 'temporal') {
      // Temporal responses may contain private task or connector evidence.
      // The durable receipt is authoritative, so never log model prose here.
      this.arbitrateTemporalAttempt(wo, 'temporal-effect-missing', true, tokensUsed);
      return;
    }
    if (wo.workKind === 'board') {
      this.arbitrateBoardCandidateAttempt(
        wo,
        'candidate receipt set missing after runner completion',
        undefined,
        tokensUsed,
        true
      );
      return;
    }
    // Shadow-gate diagnostics (§8.2): the worker's actual output decides
    // whether the tool path works - log a bounded head, never the full body.
    this.log(
      `[workorder-consumer] ${wo.workKind}#${wo.id} response head: ${response.slice(0, 200).replace(/\n/g, ' | ')}`
    );
    this.deps.ledger.completeWorkOrder(wo.id);
    this.emitEvent({
      type: 'complete',
      workKind: wo.workKind,
      workOrderId: wo.id,
      // Token telemetry for agent_activity (start.ts onEvent): the consumer is
      // the only seam that sees the run result AND emits the event. Absent when
      // the runner reported no usage - never a fabricated zero.
      ...(tokensUsed === undefined ? {} : { tokensUsed }),
    });
    this.log(`[workorder-consumer] completed ${wo.workKind}#${wo.id}`);
  }

  /**
   * Failure policy layer (plan G5): mark failed, then requeue (attempts+1,
   * fresh row, same occurrence key - the terminal row freed it) or declare
   * retries-exhausted with an owner alarm.
   */
  private handleFailure(
    wo: WorkOrderRecord,
    reason: string,
    allowRetry = true,
    retryEvidence?: SafeCandidateRetryEvidence
  ): void {
    if (wo.workKind === 'temporal') {
      this.arbitrateTemporalAttempt(wo, reason, allowRetry);
      return;
    }

    if (wo.workKind === 'board') {
      this.arbitrateBoardCandidateAttempt(wo, reason, retryEvidence);
      return;
    }

    this.handleOrdinaryFailure(wo, reason, allowRetry);
  }

  private handleOrdinaryFailure(wo: WorkOrderRecord, reason: string, allowRetry = true): void {
    const maxAttempts = WORKORDER_MAX_ATTEMPTS[wo.workKind];
    if (allowRetry && wo.payload.attempts < maxAttempts) {
      // Atomic fail+requeue (PR bot round): a crash between separate fail and
      // enqueue calls would silently lose the retry.
      const requeued = this.deps.ledger.requeueWorkOrder(wo, reason);
      this.emitEvent({ type: 'failed', workKind: wo.workKind, workOrderId: wo.id, reason });
      this.emitEvent({ type: 'requeued', workKind: wo.workKind, workOrderId: requeued.id });
      this.log(
        `[workorder-consumer] failed ${wo.workKind}#${wo.id} (${reason}) -> requeued #${requeued.id} (attempt ${wo.payload.attempts + 1}/${maxAttempts})`
      );
      return;
    }

    if (!allowRetry) {
      this.log(
        `[workorder-consumer] ${wo.workKind}#${wo.id} has a non-retryable ambiguous mutation outcome`
      );
    }

    this.deps.ledger.failWorkOrder(wo.id, reason);
    this.emitEvent({ type: 'failed', workKind: wo.workKind, workOrderId: wo.id, reason });
    this.log(`[workorder-consumer] failed ${wo.workKind}#${wo.id}: ${reason}`);
    this.emitEvent({ type: 'exhausted', workKind: wo.workKind, workOrderId: wo.id, reason });
    this.alarm(
      wo.workKind,
      `workorder ${wo.workKind}#${wo.id} retries exhausted (${wo.payload.attempts}/${maxAttempts}): ${reason}`
    );
  }

  /** Durable receipts are the board-candidate completion authority. */
  private arbitrateBoardCandidateAttempt(
    wo: WorkOrderRecord,
    reason: string,
    retryEvidence?: SafeCandidateRetryEvidence,
    tokensUsed?: number,
    completeWhenNoCandidates = false
  ): void {
    let state: BoardCandidateAttemptState;
    try {
      state = this.deps.ledger.inspectBoardCandidateAttempt(wo.id);
    } catch (err) {
      this.deferBoardCandidateArbitration(
        wo,
        reason,
        err,
        retryEvidence,
        tokensUsed,
        completeWhenNoCandidates
      );
      return;
    }
    this.unresolvedBoardCandidateEffects.delete(wo.id);

    if (state.disposition === 'none') {
      // Ordinary boards and reconcile boards without candidates retain their
      // historical one-attempt semantics.
      if (completeWhenNoCandidates) {
        this.deps.ledger.completeWorkOrder(wo.id);
        this.emitEvent({
          type: 'complete',
          workKind: 'board',
          workOrderId: wo.id,
          ...(tokensUsed === undefined ? {} : { tokensUsed }),
        });
        this.log(`[workorder-consumer] completed board#${wo.id}`);
        return;
      }
      this.handleOrdinaryFailure(wo, reason);
      return;
    }
    if (state.disposition === 'complete') {
      this.deps.ledger.completeWorkOrder(wo.id);
      this.emitEvent({
        type: 'complete',
        workKind: 'board',
        workOrderId: wo.id,
        ...(tokensUsed === undefined ? {} : { tokensUsed }),
      });
      this.log(
        `[workorder-consumer] completed board#${wo.id} from candidate receipts (${state.outcomes.join(',')})`
      );
      return;
    }

    if (
      state.disposition === 'zero' &&
      hasSafeCandidateRetryEvidence(retryEvidence) &&
      wo.payload.attempts < 2
    ) {
      const requeued = this.deps.ledger.requeueWorkOrder(wo, reason);
      this.emitEvent({ type: 'failed', workKind: 'board', workOrderId: wo.id, reason });
      this.emitEvent({ type: 'requeued', workKind: 'board', workOrderId: requeued.id });
      this.log(
        `[workorder-consumer] failed board#${wo.id} (${reason}) -> candidate-only requeue #${requeued.id}`
      );
      return;
    }

    const receiptReason =
      state.disposition === 'partial'
        ? `candidate receipt set partial; missing ${state.missingCandidateIds.length} decision(s)`
        : 'candidate receipt set is empty without live pre-run retry authority';
    this.deps.ledger.failWorkOrder(wo.id, receiptReason);
    this.emitEvent({
      type: 'failed',
      workKind: 'board',
      workOrderId: wo.id,
      reason: receiptReason,
    });
    this.emitEvent({
      type: 'exhausted',
      workKind: 'board',
      workOrderId: wo.id,
      reason: receiptReason,
    });
    this.alarm('board', `workorder board#${wo.id} ${receiptReason}`, 'board-candidate-receipts');
    this.log(`[workorder-consumer] failed board#${wo.id}: ${receiptReason}`);
  }

  private deferBoardCandidateArbitration(
    wo: WorkOrderRecord,
    reason: string,
    err: unknown,
    retryEvidence?: SafeCandidateRetryEvidence,
    tokensUsed?: number,
    completeWhenNoCandidates = false
  ): void {
    this.unresolvedBoardCandidateEffects.set(wo.id, {
      workOrder: wo,
      reason,
      retryEvidence,
      tokensUsed,
      completeWhenNoCandidates,
    });
    const message = `workorder board#${wo.id} candidate receipt state unresolved: ${errMessage(err)}`;
    this.log(`[workorder-consumer] ${message}`);
    this.alarm('board', message, 'board-candidate-state-unresolved');
  }

  private recheckUnresolvedBoardCandidateEffects(): void {
    for (const pending of [...this.unresolvedBoardCandidateEffects.values()]) {
      this.arbitrateBoardCandidateAttempt(
        pending.workOrder,
        pending.reason,
        pending.retryEvidence,
        pending.tokensUsed,
        pending.completeWhenNoCandidates
      );
    }
  }

  /** Durable row+generation+receipt state always wins over runner prose/errors. */
  private arbitrateTemporalAttempt(
    wo: WorkOrderRecord,
    reason: string,
    allowRetry = true,
    tokensUsed?: number
  ): void {
    const auditReason = temporalFailureAuditReason(reason);
    const logReason = temporalFailureLogReason(reason);
    let state: TemporalAttemptState;
    try {
      state = this.deps.ledger.inspectTemporalAttempt(wo.id);
    } catch (err) {
      // The RAW reason, not the digest: a deferred attempt is re-arbitrated later, and
      // parking the digest here made the cause unrecoverable for every recheck after it.
      this.deferTemporalArbitration(wo, reason, err, allowRetry, tokensUsed);
      return;
    }

    if (state.workOrder.status === 'done' && state.receipt) {
      this.unresolvedTemporalEffects.delete(wo.id);
      this.emitEvent({
        type: 'complete',
        workKind: 'temporal',
        workOrderId: wo.id,
        // Temporal completions route through this receipt arbitration, not the
        // generic complete path - carry the run's usage the same way.
        ...(tokensUsed === undefined ? {} : { tokensUsed }),
      });
      this.log(
        `[workorder-consumer] completed temporal#${wo.id} from receipt (${state.receipt.outcome})`
      );
      return;
    }
    if (state.generation.disposition === 'superseded') {
      this.unresolvedTemporalEffects.delete(wo.id);
      this.emitEvent({ type: 'superseded', workKind: 'temporal', workOrderId: wo.id });
      this.log(`[workorder-consumer] temporal#${wo.id} superseded; no retry required`);
      return;
    }
    if (
      state.workOrder.status === 'failed' &&
      state.generation.disposition === 'active' &&
      state.generation.lastWorkOrderId !== null &&
      state.generation.lastWorkOrderId !== wo.id
    ) {
      this.unresolvedTemporalEffects.delete(wo.id);
      this.emitEvent({
        type: 'failed',
        workKind: 'temporal',
        workOrderId: wo.id,
        reason: auditReason,
      });
      this.emitEvent({
        type: 'requeued',
        workKind: 'temporal',
        workOrderId: state.generation.lastWorkOrderId,
      });
      this.log(
        `[workorder-consumer] temporal#${wo.id} retry was already committed as #${state.generation.lastWorkOrderId}`
      );
      return;
    }
    if (
      state.workOrder.status === 'failed' &&
      state.generation.disposition === 'exhausted' &&
      state.generation.lastWorkOrderId === wo.id
    ) {
      this.unresolvedTemporalEffects.delete(wo.id);
      this.emitEvent({
        type: 'failed',
        workKind: 'temporal',
        workOrderId: wo.id,
        reason: auditReason,
      });
      this.emitEvent({
        type: 'exhausted',
        workKind: 'temporal',
        workOrderId: wo.id,
        reason: auditReason,
      });
      this.log(`[workorder-consumer] temporal#${wo.id} exhaustion was already committed`);
      this.alarm(
        'temporal',
        `workorder temporal#${wo.id} retries exhausted (${wo.payload.attempts}/${WORKORDER_MAX_ATTEMPTS.temporal}): ${logReason}`
      );
      return;
    }
    if (state.workOrder.status !== 'in_progress') {
      this.deferTemporalArbitration(
        wo,
        reason,
        new Error(
          `attempt is '${state.workOrder.status}' with generation '${state.generation.disposition}'`
        ),
        allowRetry,
        tokensUsed
      );
      return;
    }

    let result: TemporalWorkFailureResult;
    try {
      result = this.deps.ledger.failTemporalWorkOrder(wo.id, auditReason, allowRetry);
    } catch (err) {
      // A competing effect/supersession may have won after the read. Do not
      // guess which transition won; force another authoritative read first.
      // The RAW reason, not the digest: a deferred attempt is re-arbitrated later, and
      // parking the digest here made the cause unrecoverable for every recheck after it.
      this.deferTemporalArbitration(wo, reason, err, allowRetry, tokensUsed);
      return;
    }
    this.unresolvedTemporalEffects.delete(wo.id);
    if (result.disposition === 'superseded') {
      this.emitEvent({ type: 'superseded', workKind: 'temporal', workOrderId: wo.id });
      this.log(`[workorder-consumer] temporal#${wo.id} superseded during failure arbitration`);
      return;
    }
    this.emitEvent({
      type: 'failed',
      workKind: 'temporal',
      workOrderId: wo.id,
      reason: auditReason,
    });
    if (result.disposition === 'requeued') {
      this.emitEvent({
        type: 'requeued',
        workKind: 'temporal',
        workOrderId: result.replacement.id,
      });
      this.log(
        `[workorder-consumer] failed temporal#${wo.id} (${logReason}) -> requeued #${result.replacement.id} (attempt ${result.attempt + 1}/${result.maxAttempts})`
      );
      return;
    }
    this.log(
      result.retrySuppressed
        ? `[workorder-consumer] failed temporal#${wo.id}: non-retryable ambiguous mutation outcome`
        : `[workorder-consumer] failed temporal#${wo.id}: ${logReason}`
    );
    this.emitEvent({
      type: 'exhausted',
      workKind: 'temporal',
      workOrderId: wo.id,
      reason: auditReason,
    });
    this.alarm(
      'temporal',
      result.retrySuppressed
        ? `workorder temporal#${wo.id} automatic retry suppressed because a mutation outcome is ambiguous: ${logReason}`
        : `workorder temporal#${wo.id} retries exhausted (${result.attempt}/${result.maxAttempts}): ${logReason}`
    );
  }

  private deferTemporalArbitration(
    wo: WorkOrderRecord,
    reason: string,
    err: unknown,
    allowRetry = true,
    tokensUsed?: number
  ): void {
    // tokensUsed survives the deferral so a later receipt-complete still
    // carries the run's usage (a deferred effect is not an unmeasured one).
    this.unresolvedTemporalEffects.set(wo.id, { workOrder: wo, reason, allowRetry, tokensUsed });
    const message = `workorder temporal#${wo.id} effect state unresolved: ${errMessage(err)}`;
    this.log(`[workorder-consumer] ${message}`);
    this.alarm('temporal', message, 'temporal-state-unresolved');
  }

  private recheckUnresolvedTemporalEffects(): void {
    for (const pending of [...this.unresolvedTemporalEffects.values()]) {
      this.arbitrateTemporalAttempt(
        pending.workOrder,
        pending.reason,
        pending.allowRetry,
        pending.tokensUsed
      );
    }
  }

  /** Owner alarm: passive notice + active telegram, deduped per kind (6h). */
  private alarm(kind: WorkOrderKind, message: string, dedupeKey: string = kind): void {
    const now = this.deps.now?.() ?? Date.now();
    const last = this.lastAlarmAt.get(dedupeKey);
    if (last !== undefined && now - last < ALARM_DEDUP_MS) {
      this.log(`[workorder-consumer] alarm deduped (${kind}): ${message}`);
      return;
    }
    this.lastAlarmAt.set(dedupeKey, now);
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

function isAmbiguousCodeActMutation(error: unknown): boolean {
  return (
    error instanceof AgentError &&
    (error.code === 'CODE_ACT_MUTATION_COMMITTED_AFTER_ABORT' ||
      error.code === 'CODE_ACT_MUTATION_OUTCOME_UNKNOWN' ||
      error.code === 'MCP_RESULT_MISSING' ||
      error.code === 'MCP_COMPLETED_MUTATION_INTERRUPTED')
  );
}

/**
 * A closed vocabulary of failure shapes, and the ONLY thing the log learns about a cause.
 *
 * Nothing is copied out of the error: a pattern matches, and a fixed label is emitted. That
 * is what keeps this inside the privacy contract these failures already have - a runner
 * error can carry connector evidence or a token, so logs, notices, sends, events and the
 * ledger row must never contain its text. `temporalFailureAuditReason` enforces that by
 * hashing, and the hash is still what the durable row stores.
 *
 * But the digest was ALSO all the operator ever saw. Five consecutive live failures reported
 * `temporal-worker-failure;sha256=...;length=31` - a fingerprint of a cause nobody could
 * read, so nobody could tell an upstream outage from a bug in this code. A label from this
 * table separates those without quoting a single byte of the error.
 */
const TEMPORAL_FAILURE_SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b429\b|rate.?limit|too many requests/i, 'rate-limited'],
  [/\b5\d{2}\b|overloaded|server error|internal error/i, 'upstream-5xx'],
  [/timed?.?out|etimedout|deadline|aborted/i, 'timeout'],
  [/econnrefused|enotfound|econnreset|socket hang up|network/i, 'network'],
  [/\b4\d{2}\b|invalid.?request|bad request|unauthorized|forbidden/i, 'request-rejected'],
  [/no such tool|unknown tool|not dispatchable|no executor/i, 'tool-missing'],
  [/out of memory|heap|maxbuffer/i, 'resource-exhausted'],
  // The run finished but landed no reconcile receipt. Live root cause
  // (2026-07-31): the code-act MCP transport does not carry the lane's
  // host-issued temporal work context, so task_temporal_reconcile dies
  // WORKORDER_SUPERSEDED inside the run - principal-follows-run (S3).
  [/temporal effect receipt missing/i, 'receipt-missing'],
];

/** The failure shape, or null when none of the known ones match. */
export function classifyTemporalFailure(reason: string): string | null {
  for (const [pattern, label] of TEMPORAL_FAILURE_SHAPES) {
    if (pattern.test(reason)) {
      return label;
    }
  }
  return null;
}

/**
 * What the OPERATOR reads: a shape label from the closed table above, plus a short digest
 * prefix so the line can still be tied to its audit row. Never any text from the error.
 *
 * An unmatched failure reads `unclassified`, which carries exactly as much as the old digest
 * did - the classification only ever adds.
 */
function temporalFailureLogReason(reason: string): string {
  const digest = createHash('sha256').update(reason).digest('hex').slice(0, 12);
  return `temporal-worker-failure(${classifyTemporalFailure(reason) ?? 'unclassified'}) sha256=${digest}`;
}

function temporalFailureAuditReason(reason: string): string {
  if (/^temporal-worker-failure;sha256=[a-f0-9]{64};length=\d+$/.test(reason)) {
    return reason;
  }
  return `temporal-worker-failure;sha256=${createHash('sha256').update(reason).digest('hex')};length=${reason.length}`;
}

function boundedEffectFailure(prefix: string, err: unknown): string {
  return `${prefix}${errMessage(err)}`.slice(0, MAX_EFFECT_VERDICT_REASON_LENGTH);
}
