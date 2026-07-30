/**
 * Session lifecycle for the stateful conductor.
 *
 * Injected text persists in a long-lived buffer - that is the pivot's one new
 * risk, and this class is the antidote: sessions are disposable on age, turn,
 * token, idle, or suspicion budgets, and every fresh session (boot included)
 * owes the board one re-ground before its first judgment. State survives
 * because it lives in cards; the buffer never has to.
 *
 * Recycle does NOT touch the pool directly: agent-loop's `freshSession: true`
 * is the one sanctioned reset path (it resets the pool entry AND marks the
 * run new in the same place - review F5: `pool.resetSession()` alone swaps a
 * UUID while the fallback branch overwrites `resumeSession` with the pool's
 * own `isNew`, so the old buffer survives). The conductor passes
 * `freshSession: true` whenever `needsReground()` is true.
 */
import { buildChannelKey } from '../agent/session-pool.js';

export const CONDUCTOR_SOURCE = 'conductor';
export const CONDUCTOR_CHANNEL_ID = 'conductor';
// THREE keys, one identity. The LANE comes from the session key's FIRST
// `:` segment (agent-loop.ts resolveGlobalLaneForSession) - NOT from
// options.source. 'operator:conductor' would resolve to the GLOBAL operator
// lane where Stage-2 workers serialize (review F1), so the key must lead
// with a segment absent from SOURCE_GLOBAL_LANES.
export const CONDUCTOR_SESSION_KEY = 'conductor:main'; // lane: session:conductor:main
/** Pool identity: agent-loop derives it from (source, channelId). */
export const CONDUCTOR_POOL_KEY = buildChannelKey(CONDUCTOR_SOURCE, CONDUCTOR_CHANNEL_ID);

export interface ConductorSessionPolicy {
  maxAgeMs: number;
  maxTurns: number;
  maxTokens: number;
  /**
   * Treat the session as expired after this much idle time. Must stay BELOW
   * the pool's own sessionTimeoutMs (30min default): the pool silently drops
   * idle entries, and a pool-expired session would otherwise get a warm turn
   * with no re-ground (review F11). Recycling first keeps the invariant.
   */
  idleExpiryMs: number;
}

const DEFAULTS: ConductorSessionPolicy = {
  maxAgeMs: 6 * 60 * 60 * 1000,
  maxTurns: 400,
  // Below the pool's own 160k context threshold (session-pool.ts
  // CONTEXT_THRESHOLD_TOKENS) so the conductor always recycles BEFORE the
  // pool silently swaps the session out from under it.
  maxTokens: 150_000,
  idleExpiryMs: 25 * 60 * 1000,
};

interface PoolLike {
  getTokenUsage(key: string): number;
}

export class ConductorSession {
  private readonly policy: ConductorSessionPolicy;
  private bornAt: number;
  private turns = 0;
  private lastRunAt: number;
  private suspicion: string | null = null;
  private regroundDue = true; // boot = fresh session = restart recovery

  constructor(
    private readonly pool: PoolLike,
    policy: Partial<ConductorSessionPolicy> = {},
    private readonly now: () => number = () => Date.now()
  ) {
    this.policy = { ...DEFAULTS, ...policy };
    this.bornAt = this.now();
    this.lastRunAt = this.bornAt;
  }

  noteTurn(): void {
    this.turns += 1;
    this.lastRunAt = this.now();
  }

  /**
   * Force a recycle on the next tick. No production detector calls this yet -
   * wiring one (denied-tool patterns, instruction-shaped batch lines) is named
   * S2 work. The recycle path itself is pinned by tests so the hook is live
   * the day a detector exists.
   */
  flagSuspicion(reason: string): void {
    this.suspicion = reason;
  }

  shouldRecycle(): string | null {
    if (this.suspicion) {
      return `suspicion: ${this.suspicion}`;
    }
    if (this.now() - this.bornAt > this.policy.maxAgeMs) {
      return 'max_age';
    }
    if (this.now() - this.lastRunAt > this.policy.idleExpiryMs) {
      return 'idle_expiry';
    }
    if (this.turns >= this.policy.maxTurns) {
      return 'max_turns';
    }
    if (this.pool.getTokenUsage(CONDUCTOR_POOL_KEY) >= this.policy.maxTokens) {
      return 'max_tokens';
    }
    return null;
  }

  recycle(reason: string): { needsReground: true; reason: string } {
    this.bornAt = this.now();
    this.lastRunAt = this.bornAt;
    this.turns = 0;
    this.suspicion = null;
    this.regroundDue = true;
    return { needsReground: true, reason };
  }

  /** Read-only: does the next run owe the board a re-ground? */
  needsReground(): boolean {
    return this.regroundDue;
  }

  /**
   * Called ONLY after a successful re-grounded run. A failed run must not
   * consume the re-ground - the retry still owes the board its context
   * (review: consume-before-run dropped the re-ground on the floor when the
   * first run of a fresh session threw).
   */
  markRegrounded(): void {
    this.regroundDue = false;
  }
}
