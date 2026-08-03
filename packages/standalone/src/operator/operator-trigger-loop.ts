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
import { SituationReporter, type DeliveredFullReport } from './situation-report.js';
import type { ReportSchedule } from './report-scheduler.js';
import type { BackendType } from '../agent/model-runner.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  pendingReportDeliveryPayloadIdentity,
  pendingReportRequestPayloadIdentity,
  type PendingReportDelivery,
  type PendingReportLoadOutcome,
  type PendingReportOccurrence,
  type PendingReportRequest,
  type PendingReportSaveExpectation,
  type PendingReportStore,
} from './pending-report-store.js';
import type { ReportMode } from './situation-report.js';
import { getLegCadence } from './leg-cadence.js';
import type { ArtifactProvenance, ReportCarryTarget } from './report-carry.js';

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
  /** Maximum distinct newly-fired triggers reviewed in one maintenance pass. Default 1. */
  reviewBatchLimit?: number;
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
  /** Agent for structured-JSON tasks: authorTriggers (isolated JSON-only provider runtime). */
  askAgent: AskAgent;
  /**
   * Agent for REPORT composition (M2.2). Bind this to the daemon's persona AgentLoop
   * (SOUL.md system prompt, pinned model, session continuity) - tone/quality come from the
   * generation inputs, and reports deserve the persona path while JSON tasks stay on the
   * isolated CLI. Absent -> reports use askAgent (explicit config choice, not a failure fallback).
   */
  reportAsk?: AskAgent;
  /** Agent review of one trigger (real: reviewTriggerCLI). */
  review: (trigger: TriggerRecord, recentContext: string[]) => Promise<ReviewDecision>;
  /** Owner-report sink (real: telegram gateway send). Absent -> loop stays read-only. */
  output?: Pick<OutputSink, 'send'> & { target?: ReportCarryTarget };
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
  /**
   * `eventIds` is the batch itself, carried alongside the human-readable lines.
   *
   * The ids were already inside the lines as `[id:evt_...]` headers and were only ever
   * read back by parsing prose - which meant the SYSTEM knew the batch, flattened it to
   * text, and then asked the AGENT to restate it. Every change a bounded run makes rests
   * on this batch; carrying it is the difference between a fact and a claim.
   */
  onChannelDelta?: (channelKey: string, lines: string[], eventIds: string[]) => void;
  /**
   * S1: durable conductor feed. Each per-channel batch is enqueued BEFORE
   * `delta.commit()` - a crash between the two redelivers the events and the
   * inbox's per-event dedupe absorbs the duplicate. Structural type, no import
   * cycle. Absent -> no conductor leg.
   */
  conductorInbox?: {
    enqueue(batch: { channelKey: string; eventIds: string[]; lines: string[] }): number | null;
  };
  /** Kagemusha dual output: FULL report also publishes the operator board slots. */
  fullReportBoardLines?: string[];
  /** Captures the provenance of the run that has just composed a FULL report. */
  fullReportProvenance?: () => ArtifactProvenance;
  /** Persists the exact successful FULL delivery for the later owner-turn carry. */
  persistLastFullReport?: (report: DeliveredFullReport) => void;
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

interface TickOptions {
  /** Connector freshness ticks drain data but must not accelerate LLM maintenance passes. */
  advanceMaintenance?: boolean;
}

export class OperatorTriggerLoop {
  private deps: TriggerLoopDeps;
  private tickCount = 0;
  private maintenanceTickCount = 0;
  private authorWindowGeneration = 0;
  private authoredWindowGeneration = 0;
  private recentEvents: OperatorChannelEvent[] = [];
  private running = false;
  private maintenancePending = false;
  private schedulerActive = false;
  private stopping = false;
  private activeRunPromise: Promise<void> | null = null;
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;
  private digest: SituationReporter;
  private fullReporter: SituationReporter;
  private pendingDelivery: PendingReportDelivery | undefined;
  private pendingRequest: PendingReportRequest | undefined;
  private pendingReportExpectation: PendingReportSaveExpectation | undefined;
  private pendingReportLegacyLoaded = false;

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
      fullReportProvenance: deps.fullReportProvenance,
      persistLastFullReport: deps.persistLastFullReport,
    });
    if (this.refreshPendingReportState() === 'quarantined') {
      deps.log(
        '[trigger-loop] owner-report work blocked until pending outbox quarantine is cleared'
      );
    }
  }

  /** Reloads one durable outcome so recovery can hydrate this live loop before report work. */
  private refreshPendingReportState(): PendingReportLoadOutcome['status'] | 'unavailable' {
    if (!this.deps.output) {
      return 'unavailable';
    }
    const store = this.deps.pendingReportStore;
    if (!store?.loadOutcome) {
      if (store?.loadStatus?.() === 'quarantined') {
        return 'quarantined';
      }
      if (!this.pendingReportLegacyLoaded) {
        const pending = store?.load() ?? null;
        this.pendingReportLegacyLoaded = true;
        if (pending) {
          this.digest.restore(pending.digest);
          this.fullReporter.restore(pending.full);
          this.pendingDelivery = pending.delivery;
          this.pendingRequest = pending.request;
          return 'ready';
        }
        this.pendingReportExpectation = { status: 'empty', revision: null };
      }
      return this.pendingDelivery || this.pendingRequest ? 'ready' : 'empty';
    }
    const outcome = store.loadOutcome();
    if (outcome.status === 'quarantined') {
      this.pendingReportExpectation = undefined;
      return 'quarantined';
    }
    if (outcome.status === 'empty') {
      this.pendingReportExpectation = outcome;
      return 'empty';
    }
    if (this.pendingReportExpectation?.revision !== outcome.revision) {
      this.digest.restore(outcome.state.digest);
      this.fullReporter.restore(outcome.state.full);
      this.pendingDelivery = outcome.state.delivery;
      this.pendingRequest = outcome.state.request;
      this.deps.log('[trigger-loop] refreshed durable pending owner-report buffer');
    }
    this.pendingReportExpectation = outcome;
    return 'ready';
  }

  private isPendingReportWorkBlocked(): boolean {
    return this.refreshPendingReportState() === 'quarantined';
  }

  private persistPendingReports(): boolean {
    if (!this.deps.output) return false;
    if (this.refreshPendingReportState() === 'quarantined') return false;
    const state = {
      version: 1,
      digest: this.digest.snapshot(),
      full: this.fullReporter.snapshot(),
      ...(this.pendingDelivery ? { delivery: this.pendingDelivery } : {}),
      ...(this.pendingRequest ? { request: this.pendingRequest } : {}),
    } as const;
    try {
      this.deps.pendingReportStore?.save(state, this.pendingReportExpectation);
      this.refreshPendingReportState();
      return true;
    } catch (error) {
      this.refreshPendingReportState();
      throw error;
    }
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

  private requireOutputTarget(): ReportCarryTarget {
    const target = this.deps.output?.target;
    if (
      target?.source !== 'telegram' ||
      target.channelId.length === 0 ||
      target.channelId.trim() !== target.channelId
    ) {
      throw new Error('Owner-report output is missing its canonical Telegram target binding');
    }
    return target;
  }

  private assertPendingTarget(target: ReportCarryTarget, phase: string): void {
    const configured = this.requireOutputTarget();
    if (target.source !== configured.source || target.channelId !== configured.channelId) {
      throw new Error(
        `Pending owner-report ${phase} target ${target.channelId} does not match configured target ${configured.channelId}`
      );
    }
  }

  private assertPendingDeliveryBinding(delivery: PendingReportDelivery): void {
    this.assertPendingTarget(delivery.target, 'delivery');
    const expected = pendingReportDeliveryPayloadIdentity(delivery);
    if (delivery.payloadIdentity !== expected) {
      throw new Error(
        `Pending owner-report delivery ${delivery.deliveryId} payload identity mismatch`
      );
    }
  }

  private assertPendingRequestBinding(request: PendingReportRequest): void {
    this.assertPendingTarget(request.target, 'request');
    const expected = pendingReportRequestPayloadIdentity(request);
    if (request.payloadIdentity !== expected) {
      throw new Error(
        `Pending owner-report request ${request.deliveryId} payload identity mismatch`
      );
    }
  }

  private async deliverPendingReport(recovered: boolean): Promise<PendingReportDelivery | null> {
    const pending = this.pendingDelivery;
    const output = this.deps.output;
    if (!pending || !output) {
      return null;
    }

    this.assertPendingDeliveryBinding(pending);
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
    if (!this.deps.output || this.isPendingReportWorkBlocked()) {
      return false;
    }
    if (this.pendingDelivery) {
      throw new Error('A pending owner report must be recovered before composing another report');
    }
    const target = this.requireOutputTarget();
    const deliveryId = this.deliveryIdFor(occurrence);
    const prepared = await this.reporterFor(mode).prepareReport(askAgent, mode, deliveryId);
    if (!prepared) {
      this.persistPendingReports();
      return false;
    }
    const delivery = {
      ...prepared,
      deliveryId,
      occurrence,
      target,
    };
    this.pendingDelivery = {
      ...delivery,
      payloadIdentity: pendingReportDeliveryPayloadIdentity(delivery),
    };
    // Persist the exact owner-visible text and operation identity before the
    // first external send. A restart replays this record, never a regeneration.
    if (!this.persistPendingReports()) {
      return false;
    }
    await this.deliverPendingReport(false);
    return true;
  }

  private async preparePendingRequest(): Promise<boolean> {
    const request = this.pendingRequest;
    if (!request || !this.deps.output || this.isPendingReportWorkBlocked()) return false;
    if (this.pendingDelivery) {
      throw new Error('A pending owner report delivery must be recovered before its request');
    }
    this.assertPendingRequestBinding(request);
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
    const delivery = {
      ...prepared,
      deliveryId: request.deliveryId,
      occurrence: request.occurrence,
      target: request.target,
    };
    this.pendingDelivery = {
      ...delivery,
      payloadIdentity: pendingReportDeliveryPayloadIdentity(delivery),
    };
    this.pendingRequest = undefined;
    if (!this.persistPendingReports()) {
      return false;
    }
    await this.deliverPendingReport(false);
    return true;
  }

  private async recoverPendingReportWork(): Promise<boolean> {
    if (this.isPendingReportWorkBlocked()) return false;
    const delivered = await this.deliverPendingReport(true);
    let recovered = delivered !== null;
    if (this.pendingRequest) {
      const sent = await this.preparePendingRequest();
      recovered = true;
      this.deps.log(
        `[trigger-loop] recovered on-demand full report ${sent ? 'SENT' : 'suppressed by agent'}`
      );
    }
    return recovered;
  }

  async tick(options: TickOptions = {}): Promise<TickResult> {
    const { delta, memory, registry, askAgent, review, config, log } = this.deps;
    const { output, reportScheduler } = this.deps;
    const fullLegOn = Boolean(output && reportScheduler);
    this.tickCount += 1;
    const tick = this.tickCount;
    const maintenanceTick =
      options.advanceMaintenance === false ? null : (this.maintenanceTickCount += 1);
    let fires = 0;
    let authored = 0;
    let reviewed = 0;
    let reported = false;
    let fullReported = false;
    const result = (drained = 0): TickResult => ({
      tick,
      drained,
      fires,
      authored,
      reviewed,
      reported,
      fullReported,
    });

    // Outbox recovery is the first effect in a tick. It reuses the persisted
    // delivery id, allowing Telegram's confirmed-chunk ledger to suppress a
    // send that was accepted just before the prior daemon stopped.
    this.refreshPendingReportState();
    const recoveredPendingWork = await this.recoverPendingReportWork();
    if (this.stopping) return result();

    // 1. Drain new deltas (commit AFTER processing - at-least-once).
    const events = delta.drainNew(config.drainLimit);
    const reportEvents = output
      ? events.filter((event) => !this.digest.hasRecordedEvent(event))
      : events;
    if (events.length > 0) {
      log(`[trigger-loop] tick ${tick}: drained ${events.length} events`);
    }

    // 2. Match + fire + recordFire, folding fire activity into the report accumulators.
    for (const event of reportEvents) {
      const signals = matchTriggers(event, registry);
      for (const signal of signals) {
        const fireResult = await fireTrigger(signal, memory);
        if (this.stopping) return result(events.length);
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
            recalled: fireResult.recalled,
          });
        }
        if (fullLegOn) {
          this.fullReporter.recordFire({
            triggerId: signal.triggerId ?? signal.detector,
            kind: signal.kind,
            channelId: signal.channelId,
            recalled: fireResult.recalled,
          });
        }
        log(
          `[trigger-loop] tick ${tick}: fire trigger=${signal.triggerId ?? signal.detector} ` +
            `recalled=${fireResult.recalled.length} channel=${signal.channelId}`
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
      this.authorWindowGeneration += 1;
      this.persistPendingReports();
    }
    // Group per channel ONCE, before the cursor moves: the conductor inbox
    // persists each group pre-commit, and the same groups feed the post-commit
    // reconcile callback.
    const channelBatches: Array<{
      channelKey: string;
      lines: string[];
      indexIds: string[];
      inboxEventIds: string[];
    }> = [];
    if (events.length > 0 && (this.deps.conductorInbox || this.deps.onChannelDelta)) {
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
        // The prompt shows the last 10; the CAUSE is the whole batch. Truncating both
        // would silently drop events the run acted on from the record of why it acted.
        // Embedded newlines are collapsed: a message body containing "\n[/UNTRUSTED..."
        // must not be able to forge line or block framing downstream.
        const shown = channelEvents.slice(-10);
        const lines = shown.map(
          (e) =>
            `- [id:${e.eventIndexId ?? e.id}] ${e.userId}: ${e.content
              .trim()
              .replace(/[\r\n]+/g, ' ')
              .slice(0, 200)}`
        );
        const indexIds = channelEvents
          .map((e) => e.eventIndexId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0);
        // Inbox identity must cover EVERY event or dedupe cannot absorb a
        // redelivery. The fallback is NAMESPACED: bare delta row ids from two
        // different channels (or after a VACUUM renumbering) must not collide
        // in the global dedupe PK.
        const inboxEventIds = channelEvents.map(
          (e) => e.eventIndexId ?? `raw:${channelKey}:${e.id}`
        );
        channelBatches.push({ channelKey, lines, indexIds, inboxEventIds });
      }
    }

    // S1: durable BEFORE the cursor advances. Deliberately NOT wrapped in
    // try/catch - an inbox write failure must fail the tick before commit so
    // the batch redelivers next drain. Fail loud, lose nothing.
    if (this.deps.conductorInbox) {
      for (const b of channelBatches) {
        this.deps.conductorInbox.enqueue({
          channelKey: b.channelKey,
          eventIds: b.inboxEventIds,
          lines: b.lines,
        });
      }
    }

    delta.commit(events);

    // M8: feed the board-reconcile leg AFTER commit (the loop's cursor is
    // authoritative; reconcile is a freshness layer repaired by the 30-min cron).
    if (this.deps.onChannelDelta) {
      for (const b of channelBatches) {
        try {
          this.deps.onChannelDelta(b.channelKey, b.lines, b.indexIds);
        } catch (err) {
          log(
            `[trigger-loop] onChannelDelta failed for ${b.channelKey}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }

    // 3. Agent authors new triggers from the recent window.
    if (
      maintenanceTick !== null &&
      maintenanceTick % config.authorEveryNTicks === 0 &&
      this.recentEvents.length > 0 &&
      this.authorWindowGeneration > this.authoredWindowGeneration
    ) {
      if (registry.canAttemptAuthor()) {
        try {
          const created = await authorTriggers(this.recentEvents, registry, askAgent, {
            note: `authored at tick ${tick}`,
          });
          if (this.stopping) return result(events.length);
          authored = created.length;
          registry.clearAuthorFailure();
          this.authoredWindowGeneration = this.authorWindowGeneration;
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
        } catch (error) {
          if (this.stopping) {
            log(`[trigger-loop] tick ${tick}: author pass cancelled by shutdown`);
            return result(events.length);
          }
          registry.recordAuthorFailure(authorWindowFingerprint(this.recentEvents));
          log(
            `[trigger-loop] tick ${tick}: author pass FAILED; backed off: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    }

    // 4. Agent reviews triggers that have actually fired.
    if (this.stopping) return result(events.length);
    if (maintenanceTick !== null && maintenanceTick % config.reviewEveryNTicks === 0) {
      const configuredReviewLimit = config.reviewBatchLimit;
      const reviewBatchLimit =
        typeof configuredReviewLimit === 'number' &&
        Number.isInteger(configuredReviewLimit) &&
        configuredReviewLimit > 0
          ? configuredReviewLimit
          : 1;
      const firedTriggers = registry.listReviewCandidates(reviewBatchLimit);
      const context = boundedReviewContext(this.recentEvents);
      for (const trigger of firedTriggers) {
        try {
          const decision = await review(trigger, context);
          if (this.stopping) return result(events.length);
          const action = applyReview(decision, trigger.id, registry);
          if (action === 'kept') {
            registry.markReviewed(trigger.id, trigger.stats.fired);
          }
          reviewed += 1;
          log(`[trigger-loop] tick ${tick}: review trigger=${trigger.id} -> ${action}`);
        } catch (error) {
          if (this.stopping) {
            log(`[trigger-loop] tick ${tick}: review trigger=${trigger.id} cancelled by shutdown`);
            return result(events.length);
          }
          let backoffNote = 'backed off';
          try {
            registry.recordReviewFailure(trigger.id);
          } catch (stateError) {
            backoffNote = `state changed before backoff: ${
              stateError instanceof Error ? stateError.message : String(stateError)
            }`;
          }
          log(
            `[trigger-loop] tick ${tick}: review trigger=${trigger.id} FAILED; ${backoffNote}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    }

    // 5. Situational digest (M1.5 cadence, M2 window-aware): the agent composes it from the
    //    window + fire activity + recalled memory; the sink delivers it. Agent may reply NOTHING.
    if (this.stopping) return result(events.length);
    const reportAsk = this.deps.reportAsk ?? askAgent;
    const reportEvery = config.reportEveryNTicks ?? 0;
    if (
      !this.isPendingReportWorkBlocked() &&
      output &&
      reportEvery > 0 &&
      tick % reportEvery === 0 &&
      this.digest.hasActivity()
    ) {
      reported = await this.prepareAndDeliverReport(reportAsk, 'digest', { kind: 'digest' });
      if (this.stopping) return result(events.length);
      log(`[trigger-loop] tick ${tick}: owner digest ${reported ? 'SENT' : 'suppressed by agent'}`);
    }

    // 6. Scheduled full report (M2): fires at configured LOCAL hours - even on a completely
    //    quiet window (M2.1 aliveness: the agent reports "quiet" instead of skipping; owners
    //    rely on the scheduled report arriving). Fires once per hour (markFired persists the
    //    hour key -> restart-safe). Send failure throws (no-fallback) WITHOUT marking the hour,
    //    so the next tick retries with the buffer intact.
    if (
      !this.stopping &&
      !recoveredPendingWork &&
      !this.isPendingReportWorkBlocked() &&
      output &&
      reportScheduler
    ) {
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
          if (this.stopping) return result(events.length);
          log(
            `[trigger-loop] tick ${tick}: full report ${fullReported ? 'SENT' : 'suppressed by agent'} (${hourKey})`
          );
        }
      }
    }

    return result(events.length);
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
   * uncommitted deltas simply wait for the next tick. The extra tick drains and reports, but does
   * not advance author/review maintenance cadence.
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
    if (this.stopping) return { accepted: false, reason: 'unavailable' };
    const output = this.deps.output;
    const reportScheduler = this.deps.reportScheduler;
    if (!output || this.isPendingReportWorkBlocked()) {
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
    let target: ReportCarryTarget;
    try {
      target = this.requireOutputTarget();
    } catch (error) {
      this.deps.log(
        `[trigger-loop] on-demand full report target binding unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return { accepted: false, reason: 'unavailable' };
    }
    const request = {
      mode: 'full',
      deliveryId: this.deliveryIdFor(occurrence),
      occurrence,
      acceptedAtIso: firedAtIso,
      target,
    } as const;
    this.pendingRequest = {
      ...request,
      payloadIdentity: pendingReportRequestPayloadIdentity(request),
    };
    try {
      if (!this.persistPendingReports()) {
        this.pendingRequest = undefined;
        return { accepted: false, reason: 'unavailable' };
      }
    } catch (error) {
      this.pendingRequest = undefined;
      this.deps.log(
        `[trigger-loop] on-demand full report could not be accepted durably: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return { accepted: false, reason: 'unavailable' };
    }
    this.launchRun(
      this.preparePendingRequest().then((sent) => {
        this.deps.log(
          `[trigger-loop] on-demand full report ${sent ? 'SENT' : 'suppressed by agent'}`
        );
      }),
      'on-demand full report FAILED'
    );
    return { accepted: true };
  }

  nudge(): void {
    if (this.stopping) return;
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
      this.launchRun(this.tick({ advanceMaintenance: false }), 'nudge tick failed');
    }, debounceMs);
    this.nudgeTimer.unref?.();
  }

  /**
   * Start ticking on the configured interval. Returns a stop function.
   * The interval wrapper catches + logs tick errors so one bad tick does not kill the loop
   * (the error is still surfaced loudly in the log - not swallowed).
   */
  start(): () => Promise<void> {
    const { config, log } = this.deps;
    this.stopping = false;
    this.schedulerActive = true;
    if ((this.pendingDelivery || this.pendingRequest) && !this.running) {
      this.launchRun(this.recoverPendingReportWork(), 'startup report recovery failed');
    }
    const handle = setInterval(() => {
      // The INTERVAL is the leg: it beats even while a long tick (full
      // report) is still running - same flap the workorder consumer paged
      // on live. A loop mid-tick is alive, not silent.
      getLegCadence()?.beat('trigger-loop');
      if (this.running) {
        this.maintenancePending = true;
        log('[trigger-loop] tick skipped: previous tick still running');
        return;
      }
      this.launchRun(this.tick(), 'tick failed');
    }, config.tickMs);
    handle.unref?.();
    log(`[trigger-loop] started (tick every ${config.tickMs}ms)`);
    let stopPromise: Promise<void> | undefined;
    return () => {
      if (stopPromise) return stopPromise;
      this.stopping = true;
      this.schedulerActive = false;
      this.maintenancePending = false;
      clearInterval(handle);
      if (this.nudgeTimer) {
        clearTimeout(this.nudgeTimer);
        this.nudgeTimer = null;
      }
      stopPromise = (async () => {
        const activeRun = this.activeRunPromise;
        if (activeRun) await activeRun;
        log('[trigger-loop] stopped');
      })();
      return stopPromise;
    };
  }

  private launchRun(work: Promise<unknown>, failureLabel: string): void {
    this.running = true;
    const tracked = work
      .then(() => undefined)
      .catch((error: unknown) => {
        this.deps.log(
          `[trigger-loop] ${failureLabel}: ${error instanceof Error ? error.message : String(error)}`
        );
      })
      .finally(() => {
        if (this.activeRunPromise === tracked) this.activeRunPromise = null;
        this.finishRun();
      });
    this.activeRunPromise = tracked;
  }

  private finishRun(): void {
    this.running = false;
    if (!this.schedulerActive || !this.maintenancePending) return;
    this.maintenancePending = false;
    this.launchRun(this.tick(), 'deferred maintenance tick failed');
  }
}

const REVIEW_CONTEXT_EVENT_CHARS = 500;
const REVIEW_CONTEXT_TOTAL_CHARS = 8_000;

function boundedReviewContext(events: OperatorChannelEvent[]): string[] {
  const lines: string[] = [];
  let used = 0;
  for (const event of [...events].reverse()) {
    const content = event.content
      .trim()
      .replace(/[\r\n]+/g, ' ')
      .slice(0, REVIEW_CONTEXT_EVENT_CHARS);
    const line = `[${event.channelId}] ${content}`;
    if (used + line.length + 1 > REVIEW_CONTEXT_TOTAL_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  const omitted = events.length - lines.length;
  lines.reverse();
  if (omitted > 0) lines.unshift(`[... ${omitted} event(s) omitted by review input budget]`);
  return lines;
}

function authorWindowFingerprint(events: OperatorChannelEvent[]): string {
  const hash = createHash('sha256');
  for (const event of events) {
    hash.update(event.channel);
    hash.update('\0');
    hash.update(event.channelId);
    hash.update('\0');
    hash.update(String(event.eventIndexId ?? event.id));
    hash.update('\0');
    hash.update(String(event.createdAt));
    hash.update('\0');
    hash.update(event.content);
    hash.update('\0');
  }
  return hash.digest('hex');
}
