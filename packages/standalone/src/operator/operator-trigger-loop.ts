/**
 * OperatorTriggerLoop - the live runtime of the trigger loop (M1-T3).
 *
 * A setInterval tick (NOT scheduler.addJob, which executes an agent prompt, not a callback;
 * precedent: connector-ingress-manual-memory-commit.ts:742) that:
 *   1. drains new deltas (at-least-once: commit only after processing),
 *   2. matches active triggers -> fires them (recall memoryQuery + surface) + recordFire,
 *   3. every authorEveryNTicks: the agent authors new triggers from the recent-events window,
 *   4. every reviewEveryNTicks: the agent reviews fired triggers (keep/refine/retire).
 *
 * Read-only: recall/surface/log only, no outbound send (M1). Every step logs
 * (observability-over-restriction). All deps are injected so the pipeline is unit-testable;
 * M1-T4 wires the real adapters behind MAMA_TRIGGER_LOOP=1.
 */

import type { OperatorChannelEvent, OperatorMemoryPort } from './operator-interfaces.js';
import type { TriggerRecord } from './trigger-types.js';
import type { TriggerRegistry } from './trigger-registry.js';
import { matchTriggers } from './trigger-matcher.js';
import { fireTrigger } from './trigger-fire.js';
import { authorTriggers, type AskAgent } from './trigger-author.js';
import { applyReview, type ReviewDecision } from './trigger-review.js';

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
}

export interface TriggerLoopDeps {
  delta: DeltaSource;
  memory: OperatorMemoryPort;
  registry: TriggerRegistry;
  /** Agent used by authorTriggers (real: askAgentCLI). */
  askAgent: AskAgent;
  /** Agent review of one trigger (real: reviewTriggerCLI). */
  review: (trigger: TriggerRecord, recentContext: string[]) => Promise<ReviewDecision>;
  config: TriggerLoopConfig;
  log: (line: string) => void;
}

export interface TickResult {
  tick: number;
  drained: number;
  fires: number;
  authored: number;
  reviewed: number;
}

export class OperatorTriggerLoop {
  private deps: TriggerLoopDeps;
  private tickCount = 0;
  private recentEvents: OperatorChannelEvent[] = [];
  private running = false;

  constructor(deps: TriggerLoopDeps) {
    this.deps = deps;
  }

  async tick(): Promise<TickResult> {
    const { delta, memory, registry, askAgent, review, config, log } = this.deps;
    this.tickCount += 1;
    const tick = this.tickCount;

    // 1. Drain new deltas (commit AFTER processing - at-least-once).
    const events = delta.drainNew(config.drainLimit);
    if (events.length > 0) log(`[trigger-loop] tick ${tick}: drained ${events.length} events`);

    // 2. Match + fire + recordFire.
    let fires = 0;
    for (const event of events) {
      const signals = matchTriggers(event, registry);
      for (const signal of signals) {
        const result = await fireTrigger(signal, memory);
        fires += 1;
        if (signal.triggerId) registry.recordFire(signal.triggerId);
        log(
          `[trigger-loop] tick ${tick}: fire trigger=${signal.triggerId ?? signal.detector} ` +
            `recalled=${result.recalled.length} channel=${signal.channelId}`
        );
      }
    }
    delta.commit(events);

    // Maintain the recent-events window for authoring.
    if (events.length > 0) {
      this.recentEvents = [...this.recentEvents, ...events].slice(-config.authorWindowSize);
    }

    // 3. Agent authors new triggers from the recent window.
    let authored = 0;
    if (tick % config.authorEveryNTicks === 0 && this.recentEvents.length > 0) {
      const created = await authorTriggers(this.recentEvents, registry, askAgent, {
        note: `authored at tick ${tick}`,
      });
      authored = created.length;
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

    return { tick, drained: events.length, fires, authored, reviewed };
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
          log(`[trigger-loop] tick failed: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => {
          this.running = false;
        });
    }, config.tickMs);
    handle.unref?.();
    log(`[trigger-loop] started (tick every ${config.tickMs}ms)`);
    return () => {
      clearInterval(handle);
      log('[trigger-loop] stopped');
    };
  }
}
