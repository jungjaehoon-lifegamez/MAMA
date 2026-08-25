import type { AgentContext } from '../agent/types.js';
import type { Envelope } from '../envelope/types.js';
import type { OwnerEventBatch, OwnerEventInbox } from './owner-event-inbox.js';
import { buildOwnerEventEffectAuthority } from './owner-event-effects.js';
import {
  classifyOwnerEventOutcome,
  type OwnerEventHistoryMessage,
  type OwnerEventOutcome,
} from './owner-event-outcome.js';

type OwnerEventTerminalReceipt = Exclude<OwnerEventOutcome, { status: 'retry' }>;

interface OwnerEventRunner {
  run(
    prompt: string,
    options: {
      sessionKey: string;
      source: 'owner-event';
      actorId: 'mama-owner';
      channelId: string;
      freshSession: true;
      agentContext: AgentContext;
      envelope: Envelope;
      causeEventIds: readonly string[];
      sourceMessageRef: string;
      ownerEventEffects: ReturnType<typeof buildOwnerEventEffectAuthority>;
    }
  ): Promise<{ response: string; history: OwnerEventHistoryMessage[] }>;
}

export interface OwnerEventLoopDeps {
  inbox: OwnerEventInbox;
  runner: OwnerEventRunner;
  agentContext: AgentContext;
  buildPrompt: (batch: OwnerEventBatch) => Promise<string> | string;
  issueEnvelope: (batch: OwnerEventBatch) => Promise<Envelope>;
  getNoUpdateMaxId: (scope: string) => number;
  getTerminalReceipt?: (batch: OwnerEventBatch) => OwnerEventTerminalReceipt | null;
  recordTriggerOutcome?: (triggerId: string, outcome: 'succeeded' | 'failed') => void;
  onDead?: (message: string) => void | Promise<void>;
  log: (line: string) => void;
  leaseMs?: number;
  maxBatchesPerTick?: number;
}

export async function closeOwnerEventBeforeDatabase(
  stopOwnerEvent: () => Promise<void>,
  closeOperatorDatabase: () => Promise<void> | void
): Promise<void> {
  await stopOwnerEvent();
  await closeOperatorDatabase();
}

/**
 * The background event turn of the MAMA owner agent.
 *
 * This is deliberately not a planning persona. It consumes the same durable
 * external events, runs the owner's current MAMA policy as a stateless fresh
 * run per batch (each prompt is self-contained; resuming the per-channel
 * thread only replayed the whole growing history on every batch), and ACKs
 * only a receipted action, delegation, or exact no-update.
 */
export class OwnerEventLoop {
  private readonly leaseMs: number;
  private readonly maxBatchesPerTick: number;

  constructor(private readonly deps: OwnerEventLoopDeps) {
    this.leaseMs = deps.leaseMs ?? 10 * 60_000;
    this.maxBatchesPerTick = deps.maxBatchesPerTick ?? 8;
  }

  async tick(): Promise<'idle' | 'processed' | 'failed'> {
    const replay = this.deps.inbox.replayStaleDetailed(this.leaseMs);
    if (replay.replayed > 0) {
      this.deps.log(`[owner-event] replayed ${replay.replayed} stale claim(s)`);
    }
    for (const dead of replay.newlyDead) {
      this.recordTriggerOutcomes(dead, 'failed');
      await this.notifyDead(dead, 'lease expired repeatedly');
    }

    let processed = 0;
    while (processed < this.maxBatchesPerTick) {
      const batch = this.deps.inbox.claimNext();
      if (!batch) break;
      const scope = `owner-event:${batch.id}`;
      const recoveredBeforeRun = this.deps.getTerminalReceipt?.(batch) ?? null;
      if (recoveredBeforeRun) {
        this.ackTerminalReceipt(batch, recoveredBeforeRun, 'recovered before model run');
        processed += 1;
        continue;
      }
      const noUpdateBefore = this.deps.getNoUpdateMaxId(scope);

      try {
        const prompt = await this.deps.buildPrompt(batch);
        const envelope = await this.deps.issueEnvelope(batch);
        const result = await this.deps.runner.run(prompt, {
          sessionKey: `owner-event:${batch.channelKey}`,
          source: 'owner-event',
          actorId: 'mama-owner',
          channelId: batch.channelKey,
          // Stateless lane (owner decision 2026-07-16: session context is a cache,
          // not persistence). Resuming the per-channel thread replayed the whole
          // growing history on every batch - each turn's prompt is already
          // self-contained (brief + activations + completion contract + delta).
          freshSession: true,
          agentContext: this.deps.agentContext,
          envelope,
          causeEventIds: batch.eventIds,
          sourceMessageRef: `owner-event:${batch.id}`,
          ownerEventEffects: buildOwnerEventEffectAuthority(batch),
        });
        const outcome = classifyOwnerEventOutcome({
          history: result.history,
          noUpdateRecorded: this.deps.getNoUpdateMaxId(scope) > noUpdateBefore,
        });
        if (outcome.status === 'retry') {
          const recoveredAfterRun = this.deps.getTerminalReceipt?.(batch) ?? null;
          if (recoveredAfterRun) {
            this.ackTerminalReceipt(batch, recoveredAfterRun, 'recovered after model run');
            processed += 1;
            continue;
          }
          const retry = this.deps.inbox.retry(batch.id, outcome.reason);
          if (retry === 'dead') {
            this.recordTriggerOutcomes(batch, 'failed');
            await this.notifyDead(batch, outcome.reason);
          }
          this.deps.log(
            `[owner-event] batch ${batch.id} ${retry}: ${outcome.reason} (${batch.channelKey})`
          );
          return 'failed';
        }

        this.deps.inbox.ack(batch.id);
        this.recordTriggerOutcomes(batch, 'succeeded');
        processed += 1;
        this.deps.log(
          `[owner-event] batch ${batch.id} ${outcome.status}${
            outcome.tools.length > 0 ? ` via ${outcome.tools.join(',')}` : ''
          }`
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const recoveredAfterError = this.deps.getTerminalReceipt?.(batch) ?? null;
        if (recoveredAfterError) {
          this.ackTerminalReceipt(batch, recoveredAfterError, 'recovered after runner error');
          processed += 1;
          continue;
        }
        const retry = this.deps.inbox.retry(batch.id, reason);
        if (retry === 'dead') {
          this.recordTriggerOutcomes(batch, 'failed');
          await this.notifyDead(batch, reason);
        }
        this.deps.log(`[owner-event] batch ${batch.id} ${retry}: ${reason}`);
        return 'failed';
      }
    }

    const depth = this.deps.inbox.depth();
    if (depth.pending > 0 || depth.dead > 0) {
      this.deps.log(
        `[owner-event] tick budget spent: ${processed} processed, ${depth.pending} pending, ${depth.dead} dead`
      );
    }
    return processed > 0 ? 'processed' : 'idle';
  }

  private recordTriggerOutcomes(batch: OwnerEventBatch, outcome: 'succeeded' | 'failed'): void {
    if (!this.deps.recordTriggerOutcome) return;
    for (const triggerId of new Set(batch.activations.map((activation) => activation.triggerId))) {
      try {
        this.deps.recordTriggerOutcome(triggerId, outcome);
      } catch (error) {
        this.deps.log(
          `[owner-event] trigger outcome skipped for ${triggerId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }

  private ackTerminalReceipt(
    batch: OwnerEventBatch,
    receipt: OwnerEventTerminalReceipt,
    reason: string
  ): void {
    this.deps.inbox.ack(batch.id);
    this.recordTriggerOutcomes(batch, 'succeeded');
    this.deps.log(
      `[owner-event] batch ${batch.id} ${receipt.status} ${reason}${
        receipt.tools.length > 0 ? ` via ${receipt.tools.join(',')}` : ''
      }`
    );
  }

  private async notifyDead(batch: OwnerEventBatch, reason: string): Promise<void> {
    if (!this.deps.onDead) return;
    const message = `MAMA owner-event batch ${batch.id} (${batch.channelKey}) is dead: ${reason}`;
    try {
      await this.deps.onDead(message);
    } catch (error) {
      this.deps.log(
        `[owner-event] dead-batch alert failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}
