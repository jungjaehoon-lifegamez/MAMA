/**
 * Session lifecycle for the stateful conductor.
 *
 * Injected text persists in a long-lived buffer - that is the pivot's one new
 * risk, and this class is the antidote: sessions are disposable on age, turn,
 * token, or suspicion budgets, and every fresh session (boot included) owes
 * the board one re-ground before its first judgment. State survives because
 * it lives in cards; the buffer never has to.
 */
export const CONDUCTOR_SOURCE = 'conductor';
export const CONDUCTOR_CHANNEL_ID = 'conductor';
// THREE keys, one identity - agent-loop.ts builds the POOL key from
// buildChannelKey(source, channelId), while sessionKey only picks the LANE.
// All three must be passed together or the conductor's session, lane, and
// token accounting silently split across different identities.
export const CONDUCTOR_SESSION_KEY = 'operator:conductor'; // lane key
/** Pool identity: agent-loop.ts derives it from (source, channelId). */
export const CONDUCTOR_POOL_KEY = `${CONDUCTOR_SOURCE}:${CONDUCTOR_CHANNEL_ID}`;

export interface ConductorSessionPolicy {
  maxAgeMs: number;
  maxTurns: number;
  maxTokens: number;
}

const DEFAULTS: ConductorSessionPolicy = {
  maxAgeMs: 6 * 60 * 60 * 1000,
  maxTurns: 400,
  maxTokens: 150_000,
};

interface PoolLike {
  getSessionId(key: string): string;
  resetSession(key: string): string;
  getTokenUsage(key: string): number;
}

export class ConductorSession {
  private readonly policy: ConductorSessionPolicy;
  private bornAt: number;
  private turns = 0;
  private suspicion: string | null = null;
  private regroundDue = true; // boot = fresh session = restart recovery

  constructor(
    private readonly pool: PoolLike,
    policy: Partial<ConductorSessionPolicy> = {},
    private readonly now: () => number = () => Date.now()
  ) {
    this.policy = { ...DEFAULTS, ...policy };
    this.bornAt = this.now();
  }

  noteTurn(): void {
    this.turns += 1;
  }

  flagSuspicion(reason: string): void {
    this.suspicion = reason;
  }

  shouldRecycle(): string | null {
    if (this.suspicion) return `suspicion: ${this.suspicion}`;
    if (this.now() - this.bornAt > this.policy.maxAgeMs) return 'max_age';
    if (this.turns >= this.policy.maxTurns) return 'max_turns';
    if (this.pool.getTokenUsage(CONDUCTOR_POOL_KEY) >= this.policy.maxTokens) {
      return 'max_tokens';
    }
    return null;
  }

  recycle(reason: string): { needsReground: true; reason: string } {
    this.pool.resetSession(CONDUCTOR_POOL_KEY);
    this.bornAt = this.now();
    this.turns = 0;
    this.suspicion = null;
    this.regroundDue = true;
    return { needsReground: true, reason };
  }

  consumeReground(): boolean {
    const due = this.regroundDue;
    this.regroundDue = false;
    return due;
  }
}
