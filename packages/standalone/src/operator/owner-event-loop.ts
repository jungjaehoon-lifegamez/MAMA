import type { ProcedureRef } from './trigger-types.js';
import type { AgentContext } from '../agent/types.js';
import type { RoleConfig } from '../cli/config/types.js';
import type { Envelope } from '../envelope/types.js';
import type {
  OwnerEventActivation,
  OwnerEventBatch,
  OwnerEventInbox,
} from './owner-event-inbox.js';
import { buildOwnerEventEffectAuthority } from './owner-event-effects.js';
import { OWNER_RUNTIME_SESSION_KEY } from './owner-runtime.js';
import {
  classifyOwnerEventOutcome,
  type OwnerEventHistoryMessage,
  type OwnerEventOutcome,
} from './owner-event-outcome.js';

export type OwnerEventTerminalReceipt = Exclude<OwnerEventOutcome, { status: 'retry' }>;

interface OwnerEventRunner {
  run(
    prompt: string,
    options: {
      sessionKey: string;
      source: 'owner-event';
      actorId: 'mama-owner';
      channelId: string;
      sessionPolicyRole: RoleConfig;
      agentContext: AgentContext;
      prepareEnvelope: () => Promise<Envelope>;
      causeEventIds: readonly string[];
      sourceMessageRef: string;
      ownerJournalPrompt: string;
      procedureRefs?: ProcedureRef[];
      prepareContent?: () => Promise<{
        content: Array<{ type: 'text'; text: string }>;
        procedureRefs: ProcedureRef[];
      }>;
      ownerEventEffects: ReturnType<typeof buildOwnerEventEffectAuthority>;
      /** Measurement only (per-turn [prompt] log line); changes nothing the turn contains. */
      promptKind?: string;
      promptBrief?: 'sent' | 'omitted';
    }
  ): Promise<{ response: string; history: OwnerEventHistoryMessage[]; stoppedBy?: 'budget' }>;
}

export interface OwnerEventLoopDeps {
  inbox: OwnerEventInbox;
  runner: OwnerEventRunner;
  agentContext: AgentContext;
  /** Stable owner capability catalog; execution remains narrowed by agentContext + envelope. */
  ownerRuntimeRole?: RoleConfig;
  /** Resolve and authorize each activation before any metadata reaches the prompt. */
  resolveActivation?: (
    activation: OwnerEventActivation,
    batch: OwnerEventBatch
  ) => OwnerEventActivation | Promise<OwnerEventActivation>;
  assertActiveActivations?: (batch: OwnerEventBatch) => void | Promise<void>;
  buildPrompt: (batch: OwnerEventBatch) => Promise<string> | string;
  /**
   * Whether the prompt this host just built carries the console brief. Measurement only:
   * it feeds the per-turn [prompt] line and never changes what the turn contains.
   */
  promptBriefState?: () => 'sent' | 'omitted';
  issueEnvelope: (batch: OwnerEventBatch) => Promise<Envelope>;
  getNoUpdateMaxId: (scope: string) => number;
  hasUnsafeReplayEffects?: (batch: OwnerEventBatch) => boolean;
  hasUnsettledEffects?: (batch: OwnerEventBatch) => boolean;
  getTerminalReceipt?: (batch: OwnerEventBatch) => OwnerEventTerminalReceipt | null;
  recordTriggerOutcome?: (
    triggerId: string,
    outcome: 'succeeded' | 'failed',
    receiptId?: string
  ) => void;
  onDead?: (message: string) => void | Promise<void>;
  /** Failures become evidence: called once per dead batch with a stable signature. */
  recordIssue?: (input: { channelKey: string; reason: string }) => void;
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
 * external events, submits each bounded event stimulus to the same durable
 * owner runtime used by direct owner conversation, and ACKs
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
      if (this.deps.hasUnsettledEffects?.(batch)) {
        await this.quarantineEffects(batch);
        return 'failed';
      }
      const recoveredBeforeRun = this.deps.getTerminalReceipt?.(batch) ?? null;
      if (recoveredBeforeRun) {
        this.ackTerminalReceipt(batch, recoveredBeforeRun, 'recovered before model run');
        processed += 1;
        continue;
      }
      if (this.deps.hasUnsafeReplayEffects?.(batch)) {
        await this.quarantineEffects(batch);
        return 'failed';
      }
      const noUpdateBefore = this.deps.getNoUpdateMaxId(scope);

      try {
        const resolveActivations = async (): Promise<void> => {
          if (this.deps.resolveActivation) {
            const admitted: OwnerEventActivation[] = [];
            for (const activation of batch.activations) {
              let resolved: OwnerEventActivation;
              try {
                resolved = await this.deps.resolveActivation(activation, batch);
              } catch {
                resolved = {
                  triggerId: activation.triggerId,
                  kind: '',
                  memoryQuery: '',
                  procedure: [],
                  requiredEvidence: [],
                  procedureRef: activation.procedureRef,
                  availability: 'unavailable',
                  resolutionReason: 'activation_resolution_failed',
                };
              }
              admitted.push({
                ...resolved,
                triggerId: activation.triggerId,
                queuedProcedureRef:
                  activation.queuedProcedureRef ??
                  activation.procedureRef ??
                  resolved.queuedProcedureRef,
              });
            }
            batch.activations = admitted;
            this.deps.inbox.saveAdmittedActivations(batch);
          }
        };
        const procedureRefs = (): ProcedureRef[] =>
          batch.activations.flatMap((activation) =>
            activation.availability !== 'unavailable' && activation.procedureRef
              ? [{ ...activation.procedureRef }]
              : []
          );
        await resolveActivations();
        const prompt = await this.deps.buildPrompt(batch);
        const result = await this.deps.runner.run(prompt, {
          sessionKey: OWNER_RUNTIME_SESSION_KEY,
          source: 'owner-event',
          promptKind: 'owner-event',
          promptBrief: this.deps.promptBriefState?.() ?? 'omitted',
          actorId: 'mama-owner',
          channelId: batch.channelKey,
          agentContext: this.deps.agentContext,
          sessionPolicyRole: this.deps.ownerRuntimeRole ?? this.deps.agentContext.role,
          prepareEnvelope: async () => {
            return this.deps.issueEnvelope(batch);
          },
          causeEventIds: batch.eventIds,
          sourceMessageRef: `owner-event:${batch.id}`,
          ownerJournalPrompt: batch.lines.join('\n'),
          procedureRefs: procedureRefs(),
          prepareContent: async () => {
            await resolveActivations();
            await this.deps.assertActiveActivations?.(batch);
            return {
              content: [{ type: 'text', text: await this.deps.buildPrompt(batch) }],
              procedureRefs: procedureRefs(),
            };
          },
          ownerEventEffects: buildOwnerEventEffectAuthority(batch),
        });
        if (this.deps.hasUnsettledEffects?.(batch)) {
          await this.quarantineEffects(batch);
          return 'failed';
        }
        const classified = classifyOwnerEventOutcome({
          history: result.history,
          noUpdateRecorded: this.deps.getNoUpdateMaxId(scope) > noUpdateBefore,
        });
        // A budget stop is a host decision, not a model failure: the batch stays
        // retryable with a named reason unless the run already changed the ledger.
        const outcome =
          result.stoppedBy === 'budget' && classified.status !== 'acted'
            ? { status: 'retry' as const, tools: [], reason: 'run stopped on its token budget' }
            : classified;
        if (outcome.status === 'retry') {
          if (this.deps.hasUnsettledEffects?.(batch)) {
            await this.quarantineEffects(batch);
            return 'failed';
          }
          const recoveredAfterRun = this.deps.getTerminalReceipt?.(batch) ?? null;
          if (recoveredAfterRun) {
            this.ackTerminalReceipt(batch, recoveredAfterRun, 'recovered after model run');
            processed += 1;
            continue;
          }
          if (this.deps.hasUnsafeReplayEffects?.(batch)) {
            await this.quarantineEffects(batch);
            return 'failed';
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

        // A send-only completion is allowed only behind the [decision] marker; the
        // host records WHY it completed without a ledger change so it can be counted.
        const unresolvedReason =
          outcome.status === 'acted' &&
          outcome.ownerDecisionRequested &&
          outcome.tools.every((tool) => tool === 'telegram_send')
            ? 'owner_decision_requested'
            : null;
        this.deps.inbox.ack(batch.id, unresolvedReason);
        this.recordTriggerOutcomes(batch, 'succeeded');
        processed += 1;
        this.deps.log(
          `[owner-event] batch ${batch.id} ${outcome.status}${
            outcome.tools.length > 0 ? ` via ${outcome.tools.join(',')}` : ''
          }${unresolvedReason ? ` unresolved_reason=${unresolvedReason}` : ''}`
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (this.deps.hasUnsettledEffects?.(batch)) {
          await this.quarantineEffects(batch);
          return 'failed';
        }
        const recoveredAfterError = this.deps.getTerminalReceipt?.(batch) ?? null;
        if (recoveredAfterError) {
          this.ackTerminalReceipt(batch, recoveredAfterError, 'recovered after runner error');
          processed += 1;
          continue;
        }
        if (this.deps.hasUnsafeReplayEffects?.(batch)) {
          await this.quarantineEffects(batch);
          return 'failed';
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

  private async quarantineEffects(batch: OwnerEventBatch): Promise<void> {
    const reason = 'Owner effect requires reconciliation; automatic replay suppressed';
    this.deps.inbox.quarantine(batch.id, reason);
    this.recordTriggerOutcomes(batch, 'failed');
    await this.notifyDead(batch, reason);
  }

  private recordTriggerOutcomes(batch: OwnerEventBatch, outcome: 'succeeded' | 'failed'): void {
    if (!this.deps.recordTriggerOutcome) return;
    for (const triggerId of new Set(batch.activations.map((activation) => activation.triggerId))) {
      try {
        const unavailable = batch.activations.some(
          (activation) =>
            activation.triggerId === triggerId && activation.availability === 'unavailable'
        );
        this.deps.recordTriggerOutcome(
          triggerId,
          unavailable ? 'failed' : outcome,
          `owner-event:${batch.id}`
        );
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
    try {
      this.deps.recordIssue?.({ channelKey: batch.channelKey, reason });
    } catch (error) {
      this.deps.log(
        `[owner-event] dead-batch issue record failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
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
