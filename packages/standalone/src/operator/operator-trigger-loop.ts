/**
 * OperatorTriggerLoop - the live runtime of the trigger loop (M1-T3, extended for M2).
 *
 * A setInterval tick (NOT scheduler.addJob, which executes an agent prompt, not a callback;
 * precedent: connector-ingress-manual-memory-commit.ts:742) that:
 *   1. drains new deltas (at-least-once: commit only after processing),
 *   2. matches active triggers -> fires them (recall memoryQuery + surface) + recordFire,
 *   3. every authorEveryNTicks: the agent authors new triggers from the recent-events window,
 *   4. every reviewEveryNTicks: the agent reviews fired triggers (keep/refine/retire),
 *   5. every reportEveryNTicks: the agent composes a situational digest of the window (M2),
 *   6. at configured LOCAL hours: the agent composes a fuller scheduled report (M2).
 *
 * Read-only: recall/surface/log/report-to-owner only, no write-actions (M1/M2). All deps are
 * injected so the pipeline is unit-testable.
 */

import type {
  OperatorChannelEvent,
  OperatorMemoryPort,
  OutputSink,
} from './operator-interfaces.js';
import type { TriggerRecord } from './trigger-types.js';
import type { TriggerRegistry } from './trigger-registry.js';
import { matchTriggers } from './trigger-matcher.js';
import { fireTrigger } from './trigger-fire.js';
import { authorTriggers, type AskAgent } from './trigger-author.js';
import { applyReview, type ReviewDecision } from './trigger-review.js';
import { SituationReporter } from './situation-report.js';
import type { ReportSchedule } from './report-scheduler.js';
import type { BackendType } from '../agent/model-runner.js';
import { randomUUID } from 'node:crypto';
import type {
  PendingReportDelivery,
  PendingReportOccurrence,
  PendingReportRequest,
  PendingReportStore,
} from './pending-report-store.js';
import type { ReportMode } from './situation-report.js';

/** Structural delta source - satisfied by ConnectorDeltaRepo. */
export interface DeltaSource {
  drainNew(limit: number): OperatorChannelEvent[];
  commit(events: OperatorChannelEvent[]): void;
}

export interface TriggerLoopConfig {
  tickMs: number;
  drainLimit: number;
  authorEveryNTicks: number;
  reviewEveryNTicks: number;
  authorWindowSize: number;
  /** Situational-digest cadence (M1.5 + M2 output leg). Only used when deps.output is set. */
  reportEveryNTicks?: number;
  /**
   * M2.4 freshness nudge debounce (ms). A poll batch that indexes new rows wakes the loop this many
   * ms later (Kagemusha fast-flush port). Default 15000. 0 == tick immediately on nudge.
   */
  nudgeDebounceMs?: number;
  /**
   * Scheduled full-report suppression window (ms, default 30min): if the last
   * SUCCESSFUL full report (usually an on-demand one) is younger than this,
   * the scheduled fire skips and consumes its hour instead of sending a
   * near-empty duplicate.
   */
  fullReportMinIntervalMs?: number;
}

export interface TriggerLoopDeps {
  /** Provider affects only report tool-call syntax. */
  backend?: BackendType;
  delta: DeltaSource;
  memory: OperatorMemoryPort;
  registry: TriggerRegistry;
  /** Agent for structured-JSON tasks: authorTriggers (real: askAgentCLI - bare CLI parses reliably). */
  askAgent: AskAgent;
  /**
   * Agent for REPORT composition (M2.2). Bind this to the daemon's persona AgentLoop
   * (SOUL.md system prompt, pinned model, session continuity) - tone/quality come from the
   * generation inputs, and reports deserve the persona path while JSON tasks stay on the
   * bare CLI. Absent -> reports use askAgent (explicit config choice, not a failure fallback).
   */
  reportAsk?: AskAgent;
  /** Agent review of one trigger (real: reviewTriggerCLI). */
  review: (trigger: TriggerRecord, recentContext: string[]) => Promise<ReviewDecision>;
  /** Owner-report sink (real: telegram gateway send). Absent -> loop stays read-only. */
  output?: Pick<OutputSink, 'send'>;
  /** Scheduled full-report cadence (real: ReportScheduler). Absent -> full leg off (M2). */
  reportScheduler?: ReportSchedule;
  /**
   * M2.3: tool-call instructions for the FULL report so the agent self-gathers context.
   * A provider form receives the last successful report's anchor so the heavy gather
   * can scope its delta (`since=<lastSuccessIso>`); it is resolved AT FIRE TIME.
   */
  fullReportSelfGather?: string[] | ((ctx: { lastSuccessIso: string | null }) => string[]);
  /**
   * M8: board-reconcile feed. Invoked after commit with connector-qualified
   * channelKey ("<connector>:<channelId>") and bounded delta excerpt lines
   * (each carrying the event id so reconcile task writes can pass
   * source_event_id). Absent -> no reconcile leg.
   */
  onChannelDelta?: (channelKey: string, lines: string[]) => void;
  /** Kagemusha dual output: FULL report also publishes the operator board slots. */
  fullReportBoardLines?: string[];
  /** Context carry (plan v6 S1-T4): persist the delivered FULL report text. */
  persistLastFullReport?: (deliveredAtIso: string, text: string) => void;
  /** Durable report accumulator written before connector cursors advance. */
  pendingReportStore?: PendingReportStore;
  config: TriggerLoopConfig;
  log: (line: string) => void;
}

export interface TickResult {
  tick: number;
  drained: number;
  fires: number;
  authored: number;
  reviewed: number;
  reported: boolean;
  fullReported: boolean;
}

export class OperatorTriggerLoop {
  private deps: TriggerLoopDeps;
  private tickCount = 0;
  private recentEvents: OperatorChannelEvent[] = [];
  private running = false;
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;
  private digest: SituationReporter;
  private fullReporter: SituationReporter;
  private pendingDelivery: PendingReportDelivery | undefined;
  private pendingRequest: PendingReportRequest | undefined;

  constructor(deps: TriggerLoopDeps) {
    this.deps = deps;
    // G2 success signal: when a sent report cites fired triggers (USED_TRIGGERS
    // trailer, window-validated), record 'succeeded' on each. Uncited fires stay
    // neutral; elimination still comes from the review pass. Detector-based fires
    // carry the detector name as id and are not in the registry -- skip loudly.
    const recordTriggerUse = (ids: string[]): void => {
      for (const id of ids) {
        try {
          deps.registry.recordOutcome(id, 'succeeded');
          deps.log(`[trigger-loop] outcome succeeded trigger=${id} (cited in owner report)`);
        } catch (err) {
          deps.log(
            `[trigger-loop] outcome skip trigger=${id}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    };
    this.digest = new SituationReporter({ recordTriggerUse });
    this.fullReporter = new SituationReporter({
      backend: deps.backend,
      // Wrap a provider into a zero-arg closure resolved AT FIRE TIME (buildPrompt
      // calls it): the delta anchor is the last SUCCESSFUL full report, so a run
      // that failed never widens the next window (defer, never drop).
      selfGatherLines:
        typeof deps.fullReportSelfGather === 'function'
          ? () =>
              (deps.fullReportSelfGather as (ctx: { lastSuccessIso: string | null }) => string[])({
                lastSuccessIso: deps.reportScheduler?.loadLastSuccess() ?? null,
              })
          : (deps.fullReportSelfGather ?? []),
      boardPublishLines: deps.fullReportBoardLines,
      recordTriggerUse,
      persistLastFullReport: deps.persistLastFullReport,
    });
    const pending = deps.output ? deps.pendingReportStore?.load() : null;
    if (pending) {
      this.digest.restore(pending.digest);
      this.fullReporter.restore(pending.full);
      this.pendingDelivery = pending.delivery;
      this.pendingRequest = pending.request;
      deps.log('[trigger-loop] restored pending owner-report buffer');
    }
  }

  private persistPendingReports(): void {
    if (!this.deps.output) return;
    this.deps.pendingReportStore?.save({
      version: 1,
      digest: this.digest.snapshot(),
      full: this.fullReporter.snapshot(),
      ...(this.pendingDelivery ? { delivery: this.pendingDelivery } : {}),
      ...(this.pendingRequest ? { request: this.pendingRequest } : {}),
    });
  }

  private reporterFor(mode: ReportMode): SituationReporter {
    return mode === 'full' ? this.fullReporter : this.digest;
  }

  private deliveryIdFor(occurrence: PendingReportOccurrence): string {
    if (occurrence.kind === 'scheduled_full' && occurrence.hourKey) {
      return `operator-report:scheduled:${occurrence.hourKey}`;
    }
    return `operator-report:${occurrence.kind}:${randomUUID()}`;
  }

  private async deliverPendingReport(recovered: boolean): Promise<PendingReportDelivery | null> {
    const pending = this.pendingDelivery;
    const output = this.deps.output;
    if (!pending || !output) {
      return null;
    }

    await this.reporterFor(pending.mode).deliverPrepared(pending, output);
    if (pending.mode === 'full' && this.deps.reportScheduler) {
      if (pending.occurrence.hourKey) {
        this.deps.reportScheduler.markFired(pending.occurrence.hourKey);
      }
      if (pending.occurrence.firedAtIso) {
        this.deps.reportScheduler.markSuccess(pending.occurrence.firedAtIso);
      }
    }
    this.pendingDelivery = undefined;
    this.persistPendingReports();
    if (recovered) {
      this.deps.log(
        `[trigger-loop] recovered pending ${pending.mode} owner report delivery=${pending.deliveryId}`
      );
    }
    return pending;
  }

  private async prepareAndDeliverReport(
    askAgent: AskAgent,
    mode: ReportMode,
    occurrence: PendingReportOccurrence
  ): Promise<boolean> {
    if (!this.deps.output) {
      return false;
    }
    if (this.pendingDelivery) {
      throw new Error('A pending owner report must be recovered before composing another report');
    }
    const deliveryId = this.deliveryIdFor(occurrence);
    const prepared = await this.reporterFor(mode).prepareReport(askAgent, mode, deliveryId);
    if (!prepared) {
      this.persistPendingReports();
      return false;
    }
    this.pendingDelivery = {
      ...prepared,
      deliveryId,
      occurrence,
    };
    // Persist the exact owner-visible text and operation identity before the
    // first external send. A restart replays this record, never a regeneration.
    this.persistPendingReports();
    await this.deliverPendingReport(false);
    return true;
  }

  private async preparePendingRequest(): Promise<boolean> {
    const request = this.pendingRequest;
    if (!request || !this.deps.output) return false;
    if (this.pendingDelivery) {
      throw new Error('A pending owner report delivery must be recovered before its request');
    }
    const reportAsk = this.deps.reportAsk ?? this.deps.askAgent;
    const prepared = await this.fullReporter.prepareReport(
      reportAsk,
      request.mode,
      request.deliveryId
    );
    if (!prepared) {
      this.pendingRequest = undefined;
      this.persistPendingReports();
      return false;
    }
    this.pendingDelivery = {
      ...prepared,
      deliveryId: request.deliveryId,
      occurrence: request.occurrence,
    };
    this.pendingRequest = undefined;
    this.persistPendingReports();
    await this.deliverPendingReport(false);
    return true;
  }

  private async recoverPendingReportWork(): Promise<void> {
    await this.deliverPendingReport(true);
    if (this.pendingRequest) {
      const sent = await this.preparePendingRequest();
      this.deps.log(
        `[trigger-loop] recovered on-demand full report ${sent ? 'SENT' : 'suppressed by agent'}`
      );
    }
  }

  async tick(): Promise<TickResult> {
    const { delta, memory, registry, askAgent, review, config, log } = this.deps;
    const { output, reportScheduler } = this.deps;
    const fullLegOn = Boolean(output && reportScheduler);
    this.tickCount += 1;
    const tick = this.tickCount;

    // Outbox recovery is the first effect in a tick. It reuses the persisted
    // delivery id, allowing Telegram's confirmed-chunk ledger to suppress a
    // send that was accepted just before the prior daemon stopped.
    await this.recoverPendingReportWork();

    // 1. Drain new deltas (commit AFTER processing - at-least-once).
    const events = delta.drainNew(config.drainLimit);
    const reportEvents = output
      ? events.filter((event) => !this.digest.hasRecordedEvent(event))
      : events;
    if (events.length > 0) {
      log(`[trigger-loop] tick ${tick}: drained ${events.length} events`);
    }

    // 2. Match + fire + recordFire, folding fire activity into the report accumulators.
    let fires = 0;
    for (const event of reportEvents) {
      const signals = matchTriggers(event, registry);
      for (const signal of signals) {
        const result = await fireTrigger(signal, memory);
        fires += 1;
        if (signal.triggerId) {
          registry.recordFire(signal.triggerId);
        }
        // Carry the recalled {topic, content} (agent-authored memoryQuery drove it) into the report.
        if (output) {
          this.digest.recordFire({
            triggerId: signal.triggerId ?? signal.detector,
            kind: signal.kind,
            channelId: signal.channelId,
            recalled: result.recalled,
          });
        }
        if (fullLegOn) {
          this.fullReporter.recordFire({
            triggerId: signal.triggerId ?? signal.detector,
            kind: signal.kind,
            channelId: signal.channelId,
            recalled: result.recalled,
          });
        }
        log(
          `[trigger-loop] tick ${tick}: fire trigger=${signal.triggerId ?? signal.detector} ` +
            `recalled=${result.recalled.length} channel=${signal.channelId}`
        );
      }
    }
    // Persist the report window BEFORE advancing the connector cursor. A daemon
    // crash may repeat an event, but it cannot silently lose an owner update.
    if (reportEvents.length > 0) {
      if (output) {
        this.digest.recordWindow(reportEvents);
        if (fullLegOn) {
          this.fullReporter.recordWindow(reportEvents);
        }
      }
      this.recentEvents = [...this.recentEvents, ...reportEvents].slice(-config.authorWindowSize);
      this.persistPendingReports();
    }
    delta.commit(events);

    // M8: feed the board-reconcile leg AFTER commit (the loop's cursor is
    // authoritative; reconcile is a freshness layer repaired by the 30-min cron).
    if (this.deps.onChannelDelta && events.length > 0) {
      const byChannel = new Map<string, OperatorChannelEvent[]>();
      // Report dedupe and board reconciliation have different durability
      // boundaries. A report snapshot may already contain a replayed event,
      // while the board callback did not run before the prior crash. Always
      // replay committed connector rows into reconciliation; that layer owns
      // its own bounded coalescing/idempotency.
      for (const event of events) {
        const key = `${event.channel}:${event.channelId}`;
        const bucket = byChannel.get(key) ?? [];
        bucket.push(event);
        byChannel.set(key, bucket);
      }
      for (const [channelKey, channelEvents] of byChannel) {
        const lines = channelEvents
          .slice(-10)
          .map(
            (e) => `- [id:${e.eventIndexId ?? e.id}] ${e.userId}: ${e.content.trim().slice(0, 200)}`
          );
        try {
          this.deps.onChannelDelta(channelKey, lines);
        } catch (err) {
          log(
            `[trigger-loop] onChannelDelta failed for ${channelKey}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }

    // 3. Agent authors new triggers from the recent window.
    let authored = 0;
    if (tick % config.authorEveryNTicks === 0 && this.recentEvents.length > 0) {
      const created = await authorTriggers(this.recentEvents, registry, askAgent, {
        note: `authored at tick ${tick}`,
      });
      authored = created.length;
      if (authored > 0) {
        if (output) {
          this.digest.recordAuthored(authored);
        }
        if (fullLegOn) {
          this.fullReporter.recordAuthored(authored);
        }
        this.persistPendingReports();
      }
      log(`[trigger-loop] tick ${tick}: author pass created ${authored} trigger(s)`);
    }

    // 4. Agent reviews triggers that have actually fired.
    let reviewed = 0;
    if (tick % config.reviewEveryNTicks === 0) {
      const firedTriggers = registry.listActive().filter((t) => t.stats.fired > 0);
      const context = this.recentEvents.map((e) => `[${e.channelId}] ${e.content}`);
      for (const trigger of firedTriggers) {
        const decision = await review(trigger, context);
        const action = applyReview(decision, trigger.id, registry);
        reviewed += 1;
        log(`[trigger-loop] tick ${tick}: review trigger=${trigger.id} -> ${action}`);
      }
    }

    // 5. Situational digest (M1.5 cadence, M2 window-aware): the agent composes it from the
    //    window + fire activity + recalled memory; the sink delivers it. Agent may reply NOTHING.
    let reported = false;
    const reportAsk = this.deps.reportAsk ?? askAgent;
    const reportEvery = config.reportEveryNTicks ?? 0;
    if (output && reportEvery > 0 && tick % reportEvery === 0 && this.digest.hasActivity()) {
      reported = await this.prepareAndDeliverReport(reportAsk, 'digest', { kind: 'digest' });
      log(`[trigger-loop] tick ${tick}: owner digest ${reported ? 'SENT' : 'suppressed by agent'}`);
    }

    // 6. Scheduled full report (M2): fires at configured LOCAL hours - even on a completely
    //    quiet window (M2.1 aliveness: the agent reports "quiet" instead of skipping; owners
    //    rely on the scheduled report arriving). Fires once per hour (markFired persists the
    //    hour key -> restart-safe). Send failure throws (no-fallback) WITHOUT marking the hour,
    //    so the next tick retries with the buffer intact.
    let fullReported = false;
    if (output && reportScheduler) {
      const { fire, hourKey } = reportScheduler.shouldFire(new Date());
      if (fire) {
        // On-demand merge suppression (plan v6 S1-T3): an owner-requested full
        // report minutes before the scheduled hour makes the scheduled fire a
        // near-empty duplicate. Skip-and-CONSUME (markFired) - the on-demand
        // report WAS this hour's report; defer semantics would re-fire later
        // ticks in the same hour.
        const lastSuccess = reportScheduler.loadLastSuccess();
        const minIntervalMs = config.fullReportMinIntervalMs ?? 30 * 60_000;
        const sinceSuccessMs = lastSuccess ? Date.now() - Date.parse(lastSuccess) : Infinity;
        if (Number.isFinite(sinceSuccessMs) && sinceSuccessMs < minIntervalMs) {
          reportScheduler.markFired(hourKey);
          log(
            `[trigger-loop] tick ${tick}: full report skipped - last success ${lastSuccess} ` +
              `within min interval (hour ${hourKey} consumed)`
          );
        } else {
          // Anchor = FIRE time, captured BEFORE the run: anchoring at completion would
          // leave a gap (messages arriving while the run executes fall after the gather
          // but before a completion-time anchor). Overlap is tolerable; gaps are not.
          const firedAtIso = new Date().toISOString();
          fullReported = await this.prepareAndDeliverReport(reportAsk, 'full', {
            kind: 'scheduled_full',
            hourKey,
            firedAtIso,
          });
          log(
            `[trigger-loop] tick ${tick}: full report ${fullReported ? 'SENT' : 'suppressed by agent'} (${hourKey})`
          );
        }
      }
    }

    return { tick, drained: events.length, fires, authored, reviewed, reported, fullReported };
  }

  /**
   * M2.4 freshness nudge: wake the loop to tick ~nudgeDebounceMs from now instead of waiting for the
   * next scheduled interval. The connector sink calls this (via a forwarder) whenever a poll batch
   * indexes new rows.
   *
   * Debounced (Kagemusha fast-flush port, agent-awareness.ts:322-332 mechanism): the FIRST nudge in
   * a quiet window arms one timer; further nudges while it is armed are ignored, so a burst of poll
   * batches collapses to a single extra tick. Busy-safe (agent-awareness.ts:343-346 mechanism): if a
   * tick is in flight when the timer fires, the nudge is skipped - never concurrent ticks; the
   * uncommitted deltas simply wait for the next tick. Pure timing assist: it only changes WHEN an
   * existing tick runs, never WHAT it does.
   */
  /**
   * On-demand full report (plan v6 S1-T3): the owner's "give me the full
   * report" intent routed to the SAME machinery as the scheduled leg - same
   * reporter, same anchor semantics, same serial guard. Host-code entry
   * (gateway forwarder hook); the run itself is fire-and-forget so the chat
   * turn that triggered it is never blocked (and never nests lane runs).
   *
   * Consume semantics: success marks the current hourKey fired, so a
   * scheduled fire in the same hour does not duplicate; markSuccess advances
   * the delta anchor exactly like a scheduled run.
   */
  startFullReport(): { accepted: boolean; reason?: 'busy' | 'unavailable' } {
    const output = this.deps.output;
    const reportScheduler = this.deps.reportScheduler;
    if (!output) {
      return { accepted: false, reason: 'unavailable' };
    }
    if (this.running || this.pendingDelivery || this.pendingRequest) {
      return { accepted: false, reason: 'busy' };
    }
    const firedAtIso = new Date().toISOString();
    const hourKey = reportScheduler?.shouldFire(new Date()).hourKey;
    const occurrence: PendingReportOccurrence = {
      kind: 'on_demand_full',
      ...(hourKey ? { hourKey } : {}),
      firedAtIso,
    };
    this.pendingRequest = {
      mode: 'full',
      deliveryId: this.deliveryIdFor(occurrence),
      occurrence,
      acceptedAtIso: firedAtIso,
    };
    try {
      this.persistPendingReports();
    } catch (error) {
      this.pendingRequest = undefined;
      this.deps.log(
        `[trigger-loop] on-demand full report could not be accepted durably: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return { accepted: false, reason: 'unavailable' };
    }
    this.running = true;
    void this.preparePendingRequest()
      .then((sent) => {
        this.deps.log(
          `[trigger-loop] on-demand full report ${sent ? 'SENT' : 'suppressed by agent'}`
        );
      })
      .catch((error: unknown) => {
        this.deps.log(
          `[trigger-loop] on-demand full report FAILED: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      })
      .finally(() => {
        this.running = false;
      });
    return { accepted: true };
  }

  nudge(): void {
    if (this.nudgeTimer) return; // already armed - debounce collapses the burst
    const configured = this.deps.config.nudgeDebounceMs;
    const debounceMs =
      typeof configured === 'number' && Number.isFinite(configured) && configured >= 0
        ? configured
        : 15_000;
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null;
      if (this.running) {
        this.deps.log(
          '[trigger-loop] nudge: tick already running - skipped (deltas wait for next tick)'
        );
        return;
      }
      this.running = true;
      void this.tick()
        .catch((error: unknown) => {
          this.deps.log(
            `[trigger-loop] nudge tick failed: ${error instanceof Error ? error.message : String(error)}`
          );
        })
        .finally(() => {
          this.running = false;
        });
    }, debounceMs);
    this.nudgeTimer.unref?.();
  }

  /**
   * Start ticking on the configured interval. Returns a stop function.
   * The interval wrapper catches + logs tick errors so one bad tick does not kill the loop
   * (the error is still surfaced loudly in the log - not swallowed).
   */
  start(): () => void {
    const { config, log } = this.deps;
    if ((this.pendingDelivery || this.pendingRequest) && !this.running) {
      this.running = true;
      void this.recoverPendingReportWork()
        .catch((error: unknown) => {
          log(
            `[trigger-loop] startup report recovery failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        })
        .finally(() => {
          this.running = false;
        });
    }
    const handle = setInterval(() => {
      if (this.running) {
        log('[trigger-loop] tick skipped: previous tick still running');
        return;
      }
      this.running = true;
      void this.tick()
        .catch((error: unknown) => {
          log(
            `[trigger-loop] tick failed: ${error instanceof Error ? error.message : String(error)}`
          );
        })
        .finally(() => {
          this.running = false;
        });
    }, config.tickMs);
    handle.unref?.();
    log(`[trigger-loop] started (tick every ${config.tickMs}ms)`);
    return () => {
      clearInterval(handle);
      if (this.nudgeTimer) {
        clearTimeout(this.nudgeTimer);
        this.nudgeTimer = null;
      }
      log('[trigger-loop] stopped');
    };
  }
}
