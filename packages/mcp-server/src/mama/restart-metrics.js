/**
 * MAMA Restart Metrics - Track Restart Success & Latency
 *
 * Story 2.3: Zero-Context Restart
 * Implements restart success rate tracking and latency measurement
 *
 * @module restart-metrics
 * @version 1.0
 * @date 2025-11-25
 */

const { info, error: logError } = require('@jungjaehoon/mama-core/debug-logger');

/**
 * Restart metrics storage
 * In-memory for now, can be persisted to SQLite in future
 */
const metrics = {
  restarts: [],
  maxSamples: 1000, // Keep last 1000 restart samples
};

/**
 * Log a restart metric entry
 *
 * @param {Object} entry - Restart metric entry
 * @param {boolean} entry.success - Whether restart succeeded
 * @param {number} entry.latency - Restart latency in milliseconds
 * @param {string} [entry.reason] - Reason for failure (if success=false)
 * @param {string} [entry.error] - Error message (if success=false)
 * @param {number} [entry.narrativeCount] - Number of narrative decisions loaded
 * @param {number} [entry.linkCount] - Number of links expanded
 * @returns {Promise<void>}
 */
async function logRestartMetric(entry) {
  try {
    const timestamp = Date.now();
    const requestId = `restart_${timestamp}_${Math.random().toString(36).slice(2, 9)}`;

    const metricEntry = {
      timestamp,
      requestId,
      operation: 'restart',
      success: entry.success,
      latency_ms: entry.latency,
      reason: entry.reason || null,
      error: entry.error || null,
      narrativeCount: entry.narrativeCount || 0,
      linkCount: entry.linkCount || 0,
    };

    // Add to in-memory storage
    metrics.restarts.push(metricEntry);

    // Keep only last N samples
    if (metrics.restarts.length > metrics.maxSamples) {
      metrics.restarts.shift();
    }

    // Log to console (JSON structured log)
    const logLevel = entry.success ? 'info' : 'warn';
    const logMessage = {
      level: logLevel,
      timestamp: new Date(timestamp).toISOString(),
      requestId,
      operation: 'restart',
      success: entry.success,
      latency_ms: entry.latency,
      narrativeCount: entry.narrativeCount || 0,
      linkCount: entry.linkCount || 0,
    };

    if (!entry.success) {
      logMessage.reason = entry.reason;
      logMessage.error = entry.error;
    }

    if (logLevel === 'info') {
      info(`[RestartMetrics] ${JSON.stringify(logMessage)}`);
    } else {
      logError(`[RestartMetrics] ${JSON.stringify(logMessage)}`);
    }
  } catch (error) {
    logError(`[RestartMetrics] Failed to log metric: ${error.message}`);
  }
}

/**
 * Calculate success rate from recent restarts
 *
 * @param {number} windowSize - Number of recent samples to include (default: 100)
 * @returns {number} Success rate as percentage (0-100)
 */
function calculateSuccessRate(windowSize = 100) {
  if (metrics.restarts.length === 0) {
    return 0;
  }

  const recentRestarts = metrics.restarts.slice(-windowSize);
  const successCount = recentRestarts.filter((r) => r.success).length;
  const successRate = (successCount / recentRestarts.length) * 100;

  return Math.round(successRate * 100) / 100; // Round to 2 decimal places
}

/**
 * Calculate p95 latency from recent restarts
 *
 * @param {number} windowSize - Number of recent samples to include (default: 100)
 * @returns {number} p95 latency in milliseconds
 */
function calculateP95Latency(windowSize = 100) {
  if (metrics.restarts.length === 0) {
    return 0;
  }

  const recentRestarts = metrics.restarts.slice(-windowSize);
  const latencies = recentRestarts.map((r) => r.latency_ms).sort((a, b) => a - b);

  // Calculate 95th percentile index
  const p95Index = Math.ceil(latencies.length * 0.95) - 1;
  const p95Latency = latencies[p95Index] || 0;

  return Math.round(p95Latency);
}

/**
 * Get restart metrics summary
 *
 * @param {number} windowSize - Number of recent samples to include (default: 100)
 * @returns {Object} Metrics summary
 */
function getRestartMetrics(windowSize = 100) {
  const recentRestarts = metrics.restarts.slice(-windowSize);

  if (recentRestarts.length === 0) {
    return {
      totalRestarts: 0,
      successRate: 0,
      p95Latency: 0,
      avgLatency: 0,
      avgNarrativeCount: 0,
      avgLinkCount: 0,
    };
  }

  const successCount = recentRestarts.filter((r) => r.success).length;
  const successRate = (successCount / recentRestarts.length) * 100;

  const latencies = recentRestarts.map((r) => r.latency_ms).sort((a, b) => a - b);
  const p95Index = Math.ceil(latencies.length * 0.95) - 1;
  const p95Latency = latencies[p95Index] || 0;

  const avgLatency = latencies.reduce((sum, l) => sum + l, 0) / latencies.length;
  const avgNarrativeCount =
    recentRestarts.reduce((sum, r) => sum + r.narrativeCount, 0) / recentRestarts.length;
  const avgLinkCount =
    recentRestarts.reduce((sum, r) => sum + r.linkCount, 0) / recentRestarts.length;

  return {
    totalRestarts: recentRestarts.length,
    successRate: Math.round(successRate * 100) / 100,
    p95Latency: Math.round(p95Latency),
    avgLatency: Math.round(avgLatency),
    avgNarrativeCount: Math.round(avgNarrativeCount * 10) / 10,
    avgLinkCount: Math.round(avgLinkCount * 10) / 10,
  };
}

/**
 * Get all restart samples (for testing/debugging)
 *
 * @returns {Array<Object>} All restart samples
 */
function getAllRestarts() {
  return [...metrics.restarts];
}

/**
 * Clear all restart metrics (for testing)
 *
 * @returns {void}
 */
function clearRestartMetrics() {
  metrics.restarts = [];
}

module.exports = {
  logRestartMetric,
  calculateSuccessRate,
  calculateP95Latency,
  getRestartMetrics,
  getAllRestarts,
  clearRestartMetrics,
};
