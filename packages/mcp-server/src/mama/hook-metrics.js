/**
 * Hook Metrics Module
 *
 * Story M2.5: 훅 성능 모니터링 & 로깅
 *
 * Provides structured metrics logging for MAMA hooks:
 * - Per-hook latency tracking
 * - Decision counts and tier state
 * - Auto-save outcomes (accepted/rejected)
 * - Privacy-aware logging (metadata only, sensitive data redacted)
 * - JSONL format for analysis
 *
 * @module hook-metrics
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { info, warn, error: logError } = require('./debug-logger');

// Metrics log directory
const LOG_DIR = path.join(os.homedir(), '.mama', 'logs');
const METRICS_FILE = path.join(LOG_DIR, 'hook-metrics.jsonl');

// Performance targets (from MAMA-PRD.md)
const PERFORMANCE_TARGETS = {
  maxLatencyMs: 500,  // p95 target
  warningLatencyMs: 400  // Warning threshold
};

/**
 * Ensure log directory exists
 */
function ensureLogDir() {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
  } catch (error) {
    warn(`[Metrics] Failed to create log directory: ${error.message}`);
  }
}

/**
 * Hash sensitive data for privacy
 * AC: Privacy - logs redact sensitive reasoning/decision bodies
 *
 * @param {string} text - Text to hash
 * @returns {string} SHA-256 hash
 */
function hashSensitiveData(text) {
  if (!text) return null;
  return crypto.createHash('sha256').update(text).digest('hex').substring(0, 16);
}

/**
 * Redact sensitive fields from object
 * AC: Privacy - storing only metadata and hashed topics
 *
 * @param {Object} data - Data object
 * @returns {Object} Redacted data
 */
function redactSensitiveData(data) {
  const redacted = { ...data };

  // Redact sensitive fields
  if (redacted.decision) {
    redacted.decision_hash = hashSensitiveData(redacted.decision);
    delete redacted.decision;
  }

  if (redacted.reasoning) {
    redacted.reasoning_hash = hashSensitiveData(redacted.reasoning);
    delete redacted.reasoning;
  }

  if (redacted.topic) {
    redacted.topic_hash = hashSensitiveData(redacted.topic);
    delete redacted.topic;
  }

  if (redacted.query) {
    redacted.query_hash = hashSensitiveData(redacted.query);
    delete redacted.query;
  }

  return redacted;
}

/**
 * Log hook metrics
 * AC: Logging middleware captures per-hook timings, decision counts, tier state, outcomes
 *
 * @param {Object} metrics - Metrics object
 * @param {string} metrics.hookName - Hook name (UserPromptSubmit, PreToolUse, PostToolUse)
 * @param {number} metrics.latencyMs - Hook execution latency
 * @param {number} metrics.decisionCount - Number of decisions returned
 * @param {number} metrics.tier - Current tier (1/2/3)
 * @param {string} metrics.tierReason - Reason for current tier
 * @param {string} metrics.outcome - Outcome (success/timeout/error/rate_limited)
 * @param {Object} metrics.metadata - Additional metadata (optional)
 * @returns {void}
 */
function logHookMetrics(metrics) {
  try {
    ensureLogDir();

    const timestamp = new Date().toISOString();

    // Build metrics entry
    const entry = {
      timestamp,
      hook_name: metrics.hookName,
      latency_ms: metrics.latencyMs,
      decision_count: metrics.decisionCount || 0,
      tier: metrics.tier,
      tier_reason: metrics.tierReason,
      outcome: metrics.outcome,
      performance_target_met: metrics.latencyMs <= PERFORMANCE_TARGETS.maxLatencyMs,
      performance_warning: metrics.latencyMs >= PERFORMANCE_TARGETS.warningLatencyMs
    };

    // Add optional metadata (redacted)
    if (metrics.metadata) {
      entry.metadata = redactSensitiveData(metrics.metadata);
    }

    // AC: Alerts/logs clearly show degraded Tier side effects
    if (metrics.tier > 1) {
      entry.degraded_mode = true;
      entry.degraded_features = getDegradedFeatures(metrics.tier);
    }

    // Write JSONL entry
    const logLine = JSON.stringify(entry) + '\n';
    fs.appendFileSync(METRICS_FILE, logLine, 'utf8');

    // Log performance warnings
    if (metrics.latencyMs >= PERFORMANCE_TARGETS.warningLatencyMs) {
      warn(`[Metrics] ${metrics.hookName} latency warning: ${metrics.latencyMs}ms (target: ${PERFORMANCE_TARGETS.maxLatencyMs}ms)`);
    }

    // Log degraded tier
    if (metrics.tier > 1) {
      info(`[Metrics] ${metrics.hookName} running in degraded Tier ${metrics.tier}: ${metrics.tierReason}`);
    }

  } catch (error) {
    logError(`[Metrics] Failed to log hook metrics: ${error.message}`);
  }
}

/**
 * Get degraded features for tier
 * AC: Alerts/logs clearly show degraded Tier side effects
 *
 * @param {number} tier - Current tier
 * @returns {Array<string>} Degraded features
 */
function getDegradedFeatures(tier) {
  const features = [];

  if (tier >= 2) {
    features.push('vector_search_disabled');
    features.push('semantic_similarity_unavailable');
  }

  if (tier >= 3) {
    features.push('graph_traversal_disabled');
    features.push('keyword_search_disabled');
    features.push('mama_fully_disabled');
  }

  return features;
}

/**
 * Log auto-save outcome
 * AC: outcomes (accepted/rejected auto-save)
 *
 * @param {string} action - Action taken (accept/modify/dismiss)
 * @param {Object} metadata - Metadata (optional, will be redacted)
 */
function logAutoSaveOutcome(action, metadata = {}) {
  try {
    ensureLogDir();

    const timestamp = new Date().toISOString();

    const entry = {
      timestamp,
      event_type: 'auto_save_outcome',
      action,
      metadata: redactSensitiveData(metadata)
    };

    const logLine = JSON.stringify(entry) + '\n';
    fs.appendFileSync(METRICS_FILE, logLine, 'utf8');

    info(`[Metrics] Auto-save outcome: ${action}`);

  } catch (error) {
    logError(`[Metrics] Failed to log auto-save outcome: ${error.message}`);
  }
}

/**
 * Get metrics summary
 * AC: Metrics can be surfaced via /mama-status or ad-hoc CLI command
 *
 * @param {Object} options - Filter options
 * @param {number} options.limit - Maximum entries to return
 * @param {string} options.hookName - Filter by hook name
 * @param {number} options.tier - Filter by tier
 * @param {string} options.outcome - Filter by outcome
 * @returns {Object} Metrics summary
 */
function getMetricsSummary(options = {}) {
  try {
    if (!fs.existsSync(METRICS_FILE)) {
      return {
        total_entries: 0,
        entries: [],
        statistics: {}
      };
    }

    const content = fs.readFileSync(METRICS_FILE, 'utf8');
    let entries = content
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));

    // Apply filters
    if (options.hookName) {
      entries = entries.filter(e => e.hook_name === options.hookName);
    }

    if (options.tier !== undefined) {
      entries = entries.filter(e => e.tier === options.tier);
    }

    if (options.outcome) {
      entries = entries.filter(e => e.outcome === options.outcome);
    }

    // Calculate statistics
    const hookMetrics = entries.filter(e => e.hook_name);
    const statistics = {
      total_hook_calls: hookMetrics.length,
      avg_latency_ms: hookMetrics.length > 0
        ? Math.round(hookMetrics.reduce((sum, e) => sum + e.latency_ms, 0) / hookMetrics.length)
        : 0,
      p95_latency_ms: calculatePercentile(hookMetrics.map(e => e.latency_ms), 0.95),
      p99_latency_ms: calculatePercentile(hookMetrics.map(e => e.latency_ms), 0.99),
      performance_target_met_rate: hookMetrics.length > 0
        ? Math.round((hookMetrics.filter(e => e.performance_target_met).length / hookMetrics.length) * 100)
        : 0,
      tier_distribution: getTierDistribution(hookMetrics),
      outcome_distribution: getOutcomeDistribution(hookMetrics),
      degraded_mode_rate: hookMetrics.length > 0
        ? Math.round((hookMetrics.filter(e => e.degraded_mode).length / hookMetrics.length) * 100)
        : 0
    };

    // Limit entries
    if (options.limit) {
      entries = entries.slice(-options.limit);
    }

    return {
      total_entries: entries.length,
      entries: entries.reverse(), // Most recent first
      statistics
    };

  } catch (error) {
    logError(`[Metrics] Failed to get metrics summary: ${error.message}`);
    return {
      total_entries: 0,
      entries: [],
      statistics: {},
      error: error.message
    };
  }
}

/**
 * Calculate percentile
 *
 * @param {Array<number>} values - Values
 * @param {number} percentile - Percentile (0-1)
 * @returns {number} Percentile value
 */
function calculatePercentile(values, percentile) {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil(sorted.length * percentile) - 1;
  return sorted[Math.max(0, index)];
}

/**
 * Get tier distribution
 *
 * @param {Array<Object>} entries - Metrics entries
 * @returns {Object} Tier distribution
 */
function getTierDistribution(entries) {
  const distribution = { tier1: 0, tier2: 0, tier3: 0 };

  entries.forEach(entry => {
    if (entry.tier === 1) distribution.tier1++;
    else if (entry.tier === 2) distribution.tier2++;
    else if (entry.tier === 3) distribution.tier3++;
  });

  return distribution;
}

/**
 * Get outcome distribution
 *
 * @param {Array<Object>} entries - Metrics entries
 * @returns {Object} Outcome distribution
 */
function getOutcomeDistribution(entries) {
  const distribution = {};

  entries.forEach(entry => {
    const outcome = entry.outcome || 'unknown';
    distribution[outcome] = (distribution[outcome] || 0) + 1;
  });

  return distribution;
}

/**
 * Clear metrics log
 * For testing purposes
 */
function clearMetrics() {
  try {
    if (fs.existsSync(METRICS_FILE)) {
      fs.unlinkSync(METRICS_FILE);
    }
  } catch (error) {
    warn(`[Metrics] Failed to clear metrics: ${error.message}`);
  }
}

/**
 * Format metrics for display
 * AC: Metrics can be surfaced via /mama-status
 *
 * @param {Object} summary - Metrics summary
 * @returns {string} Formatted metrics
 */
function formatMetricsDisplay(summary) {
  const stats = summary.statistics;

  let output = '\n📊 MAMA Hook Metrics\n';
  output += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

  // Statistics
  output += `Total Hook Calls: ${stats.total_hook_calls}\n`;
  output += `Average Latency: ${stats.avg_latency_ms}ms\n`;
  output += `P95 Latency: ${stats.p95_latency_ms}ms\n`;
  output += `P99 Latency: ${stats.p99_latency_ms}ms\n`;
  output += `Performance Target Met: ${stats.performance_target_met_rate}%\n`;
  output += `Degraded Mode Rate: ${stats.degraded_mode_rate}%\n\n`;

  // Tier distribution
  output += 'Tier Distribution:\n';
  output += `  🟢 Tier 1: ${stats.tier_distribution.tier1}\n`;
  output += `  🟡 Tier 2: ${stats.tier_distribution.tier2}\n`;
  output += `  🔴 Tier 3: ${stats.tier_distribution.tier3}\n\n`;

  // Outcome distribution
  output += 'Outcome Distribution:\n';
  Object.entries(stats.outcome_distribution).forEach(([outcome, count]) => {
    output += `  ${outcome}: ${count}\n`;
  });

  output += '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

  return output;
}

module.exports = {
  logHookMetrics,
  logAutoSaveOutcome,
  getMetricsSummary,
  formatMetricsDisplay,
  clearMetrics,
  hashSensitiveData,
  redactSensitiveData,
  getDegradedFeatures,
  PERFORMANCE_TARGETS,
  METRICS_FILE
};
