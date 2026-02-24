/**
 * HealthScoreService — computes system health from MetricsStore (STORY-021)
 *
 * Health score: 0-100 based on error rate, average latency, and uptime.
 */

import { MetricsStore } from './metrics-store.js';

export interface HealthReport {
  score: number;
  status: 'healthy' | 'degraded' | 'unhealthy';
  components: {
    prompt_latency: ComponentHealth;
    error_rate: ComponentHealth;
    tool_performance: ComponentHealth;
  };
  timestamp: number;
}

export interface ComponentHealth {
  score: number;
  details: Record<string, number | string>;
}

export class HealthScoreService {
  constructor(private store: MetricsStore) {}

  compute(windowMs = 5 * 60 * 1000): HealthReport {
    const now = Date.now();
    const startTs = now - windowMs;

    const promptLatency = this.computePromptLatency(startTs, now);
    const errorRate = this.computeErrorRate(startTs, now);
    const toolPerf = this.computeToolPerformance(startTs, now);

    // Weighted average: latency=40%, errors=40%, tools=20%
    const score = Math.round(
      promptLatency.score * 0.4 + errorRate.score * 0.4 + toolPerf.score * 0.2
    );
    const status = score >= 80 ? 'healthy' : score >= 50 ? 'degraded' : 'unhealthy';

    return {
      score,
      status,
      components: {
        prompt_latency: promptLatency,
        error_rate: errorRate,
        tool_performance: toolPerf,
      },
      timestamp: now,
    };
  }

  private computePromptLatency(startTs: number, endTs: number): ComponentHealth {
    const agg = this.store.aggregate('prompt_latency_ms', startTs, endTs);
    if (!agg || agg.count === 0) {
      return { score: 100, details: { avg_ms: 0, count: 0, status: 'no data' } };
    }

    // Score: 100 at ≤2s avg, 0 at ≥30s avg
    const avgMs = agg.avg;
    const score = Math.max(0, Math.min(100, Math.round(100 - ((avgMs - 2000) / 28000) * 100)));

    return {
      score,
      details: { avg_ms: Math.round(avgMs), p95_proxy: Math.round(agg.max), count: agg.count },
    };
  }

  private computeErrorRate(startTs: number, endTs: number): ComponentHealth {
    const errors = this.store.aggregate('prompt_error', startTs, endTs);
    const prompts = this.store.aggregate('prompt_latency_ms', startTs, endTs);

    const errorCount = errors?.count ?? 0;
    const promptCount = prompts?.count ?? 0;
    const total = promptCount + errorCount;

    if (total === 0) {
      return { score: 100, details: { error_count: 0, total: 0, rate: '0%' } };
    }

    const rate = errorCount / total;
    // Score: 100 at 0% errors, 0 at ≥20% errors
    const score = Math.max(0, Math.min(100, Math.round(100 - (rate / 0.2) * 100)));

    return {
      score,
      details: {
        error_count: errorCount,
        total,
        rate: `${(rate * 100).toFixed(1)}%`,
      },
    };
  }

  private computeToolPerformance(startTs: number, endTs: number): ComponentHealth {
    const agg = this.store.aggregate('tool_duration_ms', startTs, endTs);
    if (!agg || agg.count === 0) {
      return { score: 100, details: { avg_ms: 0, count: 0, status: 'no data' } };
    }

    // Score: 100 at ≤500ms avg, 0 at ≥10s avg
    const avgMs = agg.avg;
    const score = Math.max(0, Math.min(100, Math.round(100 - ((avgMs - 500) / 9500) * 100)));

    return {
      score,
      details: { avg_ms: Math.round(avgMs), max_ms: Math.round(agg.max), count: agg.count },
    };
  }
}
