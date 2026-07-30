/**
 * The stateful conductor: consumes the durable inbox, judges each batch in
 * ONE long-lived session, and delegates by COMMITTING work orders only - it
 * never awaits a worker from its model turn. Its runs use source 'conductor',
 * which is absent from SOURCE_GLOBAL_LANES on purpose: the lane becomes
 * session:operator:conductor, fully separate from the global operator lane
 * where Stage-2 workers serialize (worker-run.ts documents the deadlock seal).
 */
import type { ConductorInbox } from './conductor-inbox.js';
import {
  type ConductorSession,
  CONDUCTOR_SESSION_KEY,
  CONDUCTOR_SOURCE,
  CONDUCTOR_CHANNEL_ID,
} from './conductor-session.js';

interface RunnerLike {
  run(
    prompt: string,
    options?: { sessionKey?: string; source?: string; channelId?: string; resumeSession?: boolean }
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
      if (!batch) break;

      const fresh = this.deps.session.consumeReground();
      const parts: string[] = [];
      if (fresh) {
        parts.push(this.deps.reground());
      }
      parts.push(`[CHANNEL ${batch.channelKey}]`, ...batch.lines);

      try {
        // resumeSession is load-bearing: agent-loop.ts:1229 treats an absent
        // flag as a NEW session; omitting it re-creates the stateless operator
        // this sprint exists to end.
        await this.deps.runner.run(parts.join('\n'), {
          sessionKey: CONDUCTOR_SESSION_KEY, // lane
          source: CONDUCTOR_SOURCE, // pool key half 1
          channelId: CONDUCTOR_CHANNEL_ID, // pool key half 2 (agent-loop.ts:1220)
          resumeSession: !fresh,
        });
        this.deps.inbox.ack(batch.id);
        this.deps.session.noteTurn();
        processed += 1;
      } catch (error) {
        this.deps.inbox.retry(batch.id, error instanceof Error ? error.message : String(error));
        return 'failed';
      }
    }

    const depth = this.deps.inbox.depth();
    if (depth.pending > 0) {
      // A growing inbox must be loud - silence here is how backlogs hide.
      this.deps.log?.(
        `[conductor] tick budget spent: ${processed} processed, ${depth.pending} pending, ${depth.dead} dead`
      );
    }
    return processed > 0 ? 'processed' : 'idle';
  }
}
