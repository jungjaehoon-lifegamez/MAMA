/**
 * The stateful conductor: consumes the durable inbox, judges each batch in
 * ONE long-lived session, and delegates by COMMITTING work orders only - it
 * never awaits a worker from its model turn.
 *
 * Lane: the session key 'conductor:main' leads with a segment absent from
 * SOURCE_GLOBAL_LANES, so runs land on session:conductor:main - fully
 * separate from the global operator lane where Stage-2 workers serialize
 * (worker-run.ts documents the deadlock seal). The lane is derived from the
 * session key's FIRST segment, not options.source (agent-loop.ts
 * resolveGlobalLaneForSession) - tests pin this axis.
 *
 * Trust boundary: batch lines are connector-channel text - attacker-authored
 * by definition, and this session's buffer is long-lived. Every batch enters
 * the prompt through wrapUntrustedContent (the spec's standing "wrapping
 * remains the first line"), under an owner-authored framing instruction.
 */
import type { ConductorInbox } from './conductor-inbox.js';
import {
  type ConductorSession,
  CONDUCTOR_SESSION_KEY,
  CONDUCTOR_SOURCE,
  CONDUCTOR_CHANNEL_ID,
} from './conductor-session.js';
import {
  wrapUntrustedContent,
  UNTRUSTED_EXTERNAL_EVIDENCE_INSTRUCTION,
} from '../utils/untrusted-content.js';
import type { AgentContext } from '../agent/types.js';
import type { Envelope } from '../envelope/types.js';

interface RunnerLike {
  run(
    prompt: string,
    options?: {
      sessionKey?: string;
      source?: string;
      channelId?: string;
      resumeSession?: boolean;
      freshSession?: boolean;
      agentContext?: AgentContext;
      envelope?: Envelope;
    }
  ): Promise<{ response: string }>;
}

export class Conductor {
  private readonly leaseMs: number;
  private readonly maxBatchesPerTick: number;

  constructor(
    private readonly deps: {
      inbox: ConductorInbox;
      session: ConductorSession;
      runner: RunnerLike;
      reground: () => string;
      /**
       * Per-run scoped authority, mirroring the report lane: without an
       * agentContext the executor's permission checks take their documented
       * "no context - allow all" branch, and without an envelope every
       * model_tool call dies 'envelope_missing' while the run still resolves
       * and acks (review F2). Both are REQUIRED wiring in start.ts; optional
       * here only so unit tests can run the loop without the full boot.
       */
      agentContext?: AgentContext;
      issueEnvelope?: () => Promise<Envelope | null>;
      log?: (line: string) => void;
      leaseMs?: number;
      /** Burst backpressure budget: batches processed per tick before yielding. */
      maxBatchesPerTick?: number;
    }
  ) {
    this.leaseMs = deps.leaseMs ?? 10 * 60_000;
    this.maxBatchesPerTick = deps.maxBatchesPerTick ?? 8;
  }

  async tick(): Promise<'idle' | 'processed' | 'failed'> {
    const replayed = this.deps.inbox.replayStale(this.leaseMs);
    if (replayed > 0) {
      this.deps.log?.(`[conductor] replayed ${replayed} stale claim(s)`);
    }

    const reason = this.deps.session.shouldRecycle();
    if (reason) {
      this.deps.session.recycle(reason);
      this.deps.log?.(`[conductor] session recycled: ${reason}`);
    }

    let processed = 0;
    for (; processed < this.maxBatchesPerTick; ) {
      const batch = this.deps.inbox.claimNext();
      if (!batch) {
        break;
      }

      const fresh = this.deps.session.needsReground();
      const parts: string[] = [];
      if (fresh) {
        parts.push(this.deps.reground());
      }
      parts.push(
        UNTRUSTED_EXTERNAL_EVIDENCE_INSTRUCTION,
        wrapUntrustedContent(`channel:${batch.channelKey}`, batch.lines.join('\n'))
      );

      try {
        // freshSession is the ONE sanctioned reset path: agent-loop resets the
        // pool entry AND marks the run new together. resumeSession alone is
        // overwritten by the pool's own isNew in the fallback branch, so it
        // cannot express "start over" (review F5).
        const envelope = (await this.deps.issueEnvelope?.()) ?? undefined;
        await this.deps.runner.run(parts.join('\n'), {
          sessionKey: CONDUCTOR_SESSION_KEY, // lane (first segment picks it)
          source: CONDUCTOR_SOURCE, // pool key half 1
          channelId: CONDUCTOR_CHANNEL_ID, // pool key half 2
          ...(fresh ? { freshSession: true } : { resumeSession: true }),
          agentContext: this.deps.agentContext,
          envelope,
        });
        this.deps.inbox.ack(batch.id);
        this.deps.session.noteTurn();
        if (fresh) {
          this.deps.session.markRegrounded();
        }
        processed += 1;
      } catch (error) {
        const outcome = this.deps.inbox.retry(
          batch.id,
          error instanceof Error ? error.message : String(error)
        );
        if (outcome === 'dead') {
          // A dead batch is a permanent loss - it must never die quietly.
          this.deps.log?.(
            `[conductor] batch ${batch.id} (${batch.channelKey}) parked DEAD after repeated failures: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
        this.logDepth(processed);
        return 'failed';
      }
    }

    this.logDepth(processed);
    return processed > 0 ? 'processed' : 'idle';
  }

  /**
   * A growing inbox must be loud - silence is how backlogs hide. Runs on the
   * failure path too: a batch stuck in retries (attempts 1-4) is exactly when
   * the backlog grows unattended (review).
   */
  private logDepth(processed: number): void {
    const depth = this.deps.inbox.depth();
    if (depth.pending > 0 || depth.dead > 0) {
      this.deps.log?.(
        `[conductor] tick budget spent: ${processed} processed, ${depth.pending} pending, ${depth.dead} dead`
      );
    }
  }
}
