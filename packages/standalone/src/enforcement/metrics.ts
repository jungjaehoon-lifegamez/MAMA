/**
 * Enforcement Metrics — In-memory tracking of rejection, retry, and pass-through rates per agent.
 *
 * Tracks per-agent and global metrics for all enforcement pipeline stages:
 * ResponseValidator, ReviewGate, ScopeGuard, and TodoTracker.
 * Runtime-only tracker — no file I/O, no persistence.
 *
 * @module enforcement/metrics
 * @see docs/spike-prep-enforcement-layer-2026-02-08.md
 */

/**
 * Per-agent enforcement metrics
 */
export interface AgentMetrics {
  /** Total responses processed */
  totalResponses: number;
  /** Responses that passed all enforcement checks */
  passed: number;
  /** Responses rejected by ResponseValidator (flattery) */
  rejectedByValidator: number;
  /** Responses rejected by ReviewGate (no evidence) */
  rejectedByReviewGate: number;
  /** Responses rejected by ScopeGuard */
  rejectedByScopeGuard: number;
  /** Responses flagged by TodoTracker (incomplete) */
  flaggedByTodoTracker: number;
  /** Number of retries triggered */
  retries: number;
  /** Timestamp of first recorded event */
  firstSeen: number;
  /** Timestamp of last recorded event */
  lastSeen: number;
}

/**
 * Full metrics summary (per-agent + global aggregation)
 */
export interface MetricsSummary {
  /** Per-agent metrics */
  agents: Record<string, AgentMetrics>;
  /** Global totals across all agents */
  global: AgentMetrics;
}

/**
 * Configuration for EnforcementMetrics
 */
export interface EnforcementMetricsConfig {
  /** Whether metrics collection is enabled */
  enabled: boolean;
}

/**
 * Enforcement pipeline stages that can reject a response
 */
type RejectionStage = 'validator' | 'reviewGate' | 'scopeGuard' | 'todoTracker';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: EnforcementMetricsConfig = {
  enabled: true,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a fresh AgentMetrics object with all counters at zero.
 */
function createEmptyMetrics(): AgentMetrics {
  return {
    totalResponses: 0,
    passed: 0,
    rejectedByValidator: 0,
    rejectedByReviewGate: 0,
    rejectedByScopeGuard: 0,
    flaggedByTodoTracker: 0,
    retries: 0,
    firstSeen: 0,
    lastSeen: 0,
  };
}

// ---------------------------------------------------------------------------
// EnforcementMetrics
// ---------------------------------------------------------------------------

/**
 * In-memory tracker for enforcement pipeline metrics.
 *
 * Records pass, rejection, and retry events per agent.
 * When disabled, all record* methods are no-ops and getSummary returns empty data.
 *
 * @example
 * ```typescript
 * const metrics = new EnforcementMetrics();
 * metrics.recordPass('developer');
 * metrics.recordRejection('developer', 'validator');
 * metrics.recordRetry('developer');
 * const summary = metrics.getSummary();
 * ```
 */
export class EnforcementMetrics {
  private readonly config: EnforcementMetricsConfig;
  private readonly agentMap: Map<string, AgentMetrics>;

  constructor(config?: Partial<EnforcementMetricsConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.agentMap = new Map<string, AgentMetrics>();
  }

  /**
   * Record a response that passed all enforcement checks.
   *
   * @param agentId - The agent whose response passed
   */
  recordPass(agentId: string): void {
    if (!this.config.enabled) {
      return;
    }

    const metrics = this.getOrCreate(agentId);
    const now = Date.now();

    metrics.totalResponses++;
    metrics.passed++;
    metrics.lastSeen = now;

    if (metrics.firstSeen === 0) {
      metrics.firstSeen = now;
    }
  }

  /**
   * Record a response rejected by a specific enforcement stage.
   *
   * @param agentId - The agent whose response was rejected
   * @param stage - Which enforcement stage rejected the response
   */
  recordRejection(agentId: string, stage: RejectionStage): void {
    if (!this.config.enabled) {
      return;
    }

    const metrics = this.getOrCreate(agentId);
    const now = Date.now();

    metrics.totalResponses++;
    metrics.lastSeen = now;

    if (metrics.firstSeen === 0) {
      metrics.firstSeen = now;
    }

    switch (stage) {
      case 'validator':
        metrics.rejectedByValidator++;
        break;
      case 'reviewGate':
        metrics.rejectedByReviewGate++;
        break;
      case 'scopeGuard':
        metrics.rejectedByScopeGuard++;
        break;
      case 'todoTracker':
        metrics.flaggedByTodoTracker++;
        break;
    }
  }

  /**
   * Record a retry event for an agent.
   *
   * @param agentId - The agent that triggered a retry
   */
  recordRetry(agentId: string): void {
    if (!this.config.enabled) {
      return;
    }

    const metrics = this.getOrCreate(agentId);
    const now = Date.now();

    metrics.retries++;
    metrics.lastSeen = now;

    if (metrics.firstSeen === 0) {
      metrics.firstSeen = now;
    }
  }

  /**
   * Get metrics for a specific agent.
   *
   * @param agentId - The agent to look up
   * @returns AgentMetrics if the agent has been tracked, undefined otherwise
   */
  getAgentMetrics(agentId: string): AgentMetrics | undefined {
    return this.agentMap.get(agentId);
  }

  /**
   * Get a full summary of all metrics (per-agent + global aggregation).
   *
   * When disabled, returns an empty summary with zeroed global metrics.
   *
   * @returns MetricsSummary with per-agent and global totals
   */
  getSummary(): MetricsSummary {
    const agents: Record<string, AgentMetrics> = {};
    const global = createEmptyMetrics();

    if (!this.config.enabled) {
      return { agents, global };
    }

    for (const [agentId, metrics] of this.agentMap) {
      agents[agentId] = { ...metrics };

      global.totalResponses += metrics.totalResponses;
      global.passed += metrics.passed;
      global.rejectedByValidator += metrics.rejectedByValidator;
      global.rejectedByReviewGate += metrics.rejectedByReviewGate;
      global.rejectedByScopeGuard += metrics.rejectedByScopeGuard;
      global.flaggedByTodoTracker += metrics.flaggedByTodoTracker;
      global.retries += metrics.retries;

      if (
        metrics.firstSeen > 0 &&
        (global.firstSeen === 0 || metrics.firstSeen < global.firstSeen)
      ) {
        global.firstSeen = metrics.firstSeen;
      }

      if (metrics.lastSeen > global.lastSeen) {
        global.lastSeen = metrics.lastSeen;
      }
    }

    return { agents, global };
  }

  /**
   * Clear all collected metrics.
   */
  reset(): void {
    this.agentMap.clear();
  }

  /**
   * Calculate the pass rate (0.0–1.0) for a specific agent or globally.
   *
   * Returns 0 when totalResponses is 0 (avoids division by zero).
   *
   * @param agentId - Optional agent ID. When omitted, returns global pass rate.
   * @returns Pass rate between 0.0 and 1.0
   */
  getPassRate(agentId?: string): number {
    if (agentId !== undefined) {
      const metrics = this.agentMap.get(agentId);

      if (!metrics || metrics.totalResponses === 0) {
        return 0;
      }

      return metrics.passed / metrics.totalResponses;
    }

    // Global pass rate
    const summary = this.getSummary();

    if (summary.global.totalResponses === 0) {
      return 0;
    }

    return summary.global.passed / summary.global.totalResponses;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Get existing metrics for an agent or create a fresh entry.
   */
  private getOrCreate(agentId: string): AgentMetrics {
    let metrics = this.agentMap.get(agentId);

    if (!metrics) {
      metrics = createEmptyMetrics();
      this.agentMap.set(agentId, metrics);
    }

    return metrics;
  }
}
