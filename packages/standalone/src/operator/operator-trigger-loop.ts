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
}

export interface TriggerLoopDeps {
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
    });
  }

  async tick(): Promise<TickResult> {
    const { delta, memory, registry, askAgent, review, config, log } = this.deps;
    const { output, reportScheduler } = this.deps;
    const fullLegOn = Boolean(output && reportScheduler);
    this.tickCount += 1;
    const tick = this.tickCount;

    // 1. Drain new deltas (commit AFTER processing - at-least-once).
    const events = delta.drainNew(config.drainLimit);
    if (events.length > 0) {
      log(`[trigger-loop] tick ${tick}: drained ${events.length} events`);
    }

    // 2. Match + fire + recordFire, folding fire activity into the report accumulators.
    let fires = 0;
    for (const event of events) {
      const signals = matchTriggers(event, registry);
      for (const signal of signals) {
        const result = await fireTrigger(signal, memory);
        fires += 1;
        if (signal.triggerId) {
          registry.recordFire(signal.triggerId);
        }
        // Carry the recalled {topic, content} (agent-authored memoryQuery drove it) into the report.
        this.digest.recordFire({
          triggerId: signal.triggerId ?? signal.detector,
          kind: signal.kind,
          channelId: signal.channelId,
          recalled: result.recalled,
        });
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
    delta.commit(events);

    // M8: feed the board-reconcile leg AFTER commit (the loop's cursor is
    // authoritative; reconcile is a freshness layer repaired by the 30-min cron).
    if (this.deps.onChannelDelta && events.length > 0) {
      const byChannel = new Map<string, OperatorChannelEvent[]>();
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

    // Feed the drained window into the report accumulators (bounded per-channel) and keep the
    // author window. The digest reports on ALL channels seen, not only the ones that fired.
    if (events.length > 0) {
      this.digest.recordWindow(events);
      if (fullLegOn) {
        this.fullReporter.recordWindow(events);
      }
      this.recentEvents = [...this.recentEvents, ...events].slice(-config.authorWindowSize);
    }

    // 3. Agent authors new triggers from the recent window.
    let authored = 0;
    if (tick % config.authorEveryNTicks === 0 && this.recentEvents.length > 0) {
      const created = await authorTriggers(this.recentEvents, registry, askAgent, {
        note: `authored at tick ${tick}`,
      });
      authored = created.length;
      if (authored > 0) {
        this.digest.recordAuthored(authored);
        if (fullLegOn) {
          this.fullReporter.recordAuthored(authored);
        }
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
      reported = await this.digest.report(reportAsk, output, 'digest');
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
        // Anchor = FIRE time, captured BEFORE the run: anchoring at completion would
        // leave a gap (messages arriving while the run executes fall after the gather
        // but before a completion-time anchor). Overlap is tolerable; gaps are not.
        const firedAtIso = new Date().toISOString();
        fullReported = await this.fullReporter.report(reportAsk, output, 'full');
        reportScheduler.markFired(hourKey); // reached only if report() did not throw (sent OR agent-suppressed)
        if (fullReported) {
          // ONLY a delivered report advances the delta anchor. A NOTHING-suppressed
          // report or a Task-4 ENVELOPE_EXPIRED abort must NOT advance it, so the
          // next report's window still covers everything this run missed.
          reportScheduler.markSuccess(firedAtIso);
        }
        log(
          `[trigger-loop] tick ${tick}: full report ${fullReported ? 'SENT' : 'suppressed by agent'} (${hourKey})`
        );
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
