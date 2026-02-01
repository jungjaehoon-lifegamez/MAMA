/**
 * MAMA (Memory-Augmented MCP Architecture) - Outcome Tracker
 *
 * Track decision outcomes from user feedback
 * Tasks: 4.1-4.8 (Failure/success indicators, UserPromptSubmit analysis, outcome marking)
 * AC #3: Failure tracking (user feedback → outcome marked, failure_reason extracted, duration calculated)
 *
 * @module outcome-tracker
 * @version 1.0
 * @date 2025-11-14
 */

const { info, error: logError } = require('./debug-logger');
const { getDB, updateDecisionOutcome } = require('./memory-store');
const { updateConfidence } = require('./decision-tracker');

/**
 * Failure indicators
 * Task 4.2: Define failure indicators
 */
const FAILURE_INDICATORS = [
  /doesn't\s*work/i,
  /failed/i,
  /error/i,
  /slow/i,
  /broken/i,
  /bug/i,
  /wrong/i,
  /not\s*working/i,
];

/**
 * Success indicators
 * Task 4.3: Define success indicators
 */
const SUCCESS_INDICATORS = [
  /works/i,
  /perfect/i,
  /great/i,
  /success/i,
  /excellent/i,
  /fast/i,
  /good/i,
];

/**
 * Partial success indicators
 * Task 4.3: Define partial success indicators
 */
const PARTIAL_INDICATORS = [/okay/i, /acceptable/i, /improved/i, /better/i];

/**
 * Recent decision time window (1 hour in milliseconds)
 * Task 4.5: Only mark outcome if decision is recent (< 1 hour)
 */
const RECENT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/**
 * Check if message matches failure indicators
 *
 * Task 4.2: Match failure patterns
 *
 * @param {string} message - User message
 * @returns {boolean} True if failure detected
 */
function matchesFailureIndicators(message) {
  return FAILURE_INDICATORS.some((pattern) => pattern.test(message));
}

/**
 * Check if message matches success indicators
 *
 * Task 4.3: Match success patterns
 *
 * @param {string} message - User message
 * @returns {boolean} True if success detected
 */
function matchesSuccessIndicators(message) {
  return SUCCESS_INDICATORS.some((pattern) => pattern.test(message));
}

/**
 * Check if message matches partial success indicators
 *
 * Task 4.3: Match partial success patterns
 *
 * @param {string} message - User message
 * @returns {boolean} True if partial success detected
 */
function matchesPartialIndicators(message) {
  return PARTIAL_INDICATORS.some((pattern) => pattern.test(message));
}

/**
 * Determine outcome from user message
 *
 * Task 4.4, 4.5: Analyze user message for indicators
 * AC #3: Failure tracking from user feedback
 *
 * @param {string} message - User message
 * @returns {string|null} Outcome type ('FAILED', 'SUCCESS', 'PARTIAL') or null
 */
function analyzeOutcome(message) {
  if (matchesFailureIndicators(message)) {
    return 'FAILED';
  }

  if (matchesSuccessIndicators(message)) {
    return 'SUCCESS';
  }

  if (matchesPartialIndicators(message)) {
    return 'PARTIAL';
  }

  return null; // No clear outcome
}

/**
 * Extract failure reason from user message
 *
 * Task 4.6: Extract failure_reason from user message
 * AC #3: failure_reason extracted
 *
 * Simple extraction: First sentence or first 200 characters
 * Future: Use LLM for better extraction
 *
 * @param {string} message - User message
 * @param {string} outcome - Outcome type
 * @returns {string|null} Failure reason
 */
function extractFailureReason(message, outcome) {
  if (outcome !== 'FAILED') {
    return null;
  }

  // Extract first sentence
  const firstSentence = message.split(/[.!?]/)[0].trim();

  // Limit to 200 characters
  const reason = firstSentence.substring(0, 200);

  return reason || 'User indicated failure';
}

/**
 * Get recent decision (within 1 hour)
 *
 * Task 4.5: Find recent decision (< 1 hour)
 * AC #3: Recent decision (< 1 hour) marked
 *
 * @param {string} sessionId - Session ID
 * @returns {Object|null} Recent decision or null
 */
function getRecentDecision(sessionId) {
  const db = getDB();

  try {
    const now = Date.now();
    const cutoffTime = now - RECENT_WINDOW_MS;

    const recent = db
      .prepare(
        `
      SELECT * FROM decisions
      WHERE session_id = ?
        AND outcome IS NULL
        AND created_at > ?
      ORDER BY created_at DESC
      LIMIT 1
    `
      )
      .get(sessionId, cutoffTime);

    return recent || null;
  } catch (error) {
    throw new Error(`Failed to query recent decision: ${error.message}`);
  }
}

/**
 * Calculate duration in days
 *
 * Task 4.7: Calculate duration_days
 * AC #3: duration_days calculated
 *
 * @param {number} createdAt - Decision created timestamp
 * @returns {number} Duration in days
 */
function calculateDurationDays(createdAt) {
  const now = Date.now();
  const durationMs = now - createdAt;
  const durationDays = durationMs / (1000 * 60 * 60 * 24);

  // Round to 2 decimal places
  return Math.round(durationDays * 100) / 100;
}

/**
 * Get evidence impact for outcome
 *
 * Task 6: Confidence evolution - Calculate impact based on outcome
 * AC #5: Confidence score calculated based on history
 *
 * @param {string} outcome - Outcome type ('FAILED', 'SUCCESS', 'PARTIAL')
 * @param {number} durationDays - Duration in days
 * @returns {number} Impact on confidence
 */
function getEvidenceImpact(outcome, durationDays) {
  // Task 6.3: Define evidence impacts
  let impact = 0;

  switch (outcome) {
    case 'SUCCESS':
      impact = 0.2; // +0.2 for success
      break;
    case 'FAILED':
      impact = -0.3; // -0.3 for failure
      break;
    case 'PARTIAL':
      impact = 0.1; // +0.1 for partial success
      break;
  }

  // Task 6.3: Temporal stability bonus (30+ days)
  if (outcome === 'SUCCESS' && durationDays >= 30) {
    impact += 0.1; // +0.1 for temporal stability
  }

  return impact;
}

/**
 * Mark decision outcome
 *
 * Task 4.8: Update decision row with outcome, failure_reason, duration_days
 * Task 6.5: Update confidence when outcome is marked
 * AC #3: Outcome marked with failure_reason and duration_days
 * AC #5: Confidence evolution
 *
 * @param {string} decisionId - Decision ID
 * @param {string} outcome - Outcome type ('FAILED', 'SUCCESS', 'PARTIAL')
 * @param {string} failureReason - Failure reason (if outcome=FAILED)
 * @param {number} durationDays - Duration in days
 */
async function markOutcome(decisionId, outcome, failureReason, durationDays) {
  try {
    // Get current decision to read confidence
    const db = getDB();
    const decision = db.prepare('SELECT * FROM decisions WHERE id = ?').get(decisionId);

    if (!decision) {
      throw new Error(`Decision not found: ${decisionId}`);
    }

    // Guard against double-marking
    if (decision.outcome) {
      info(`[MAMA] Outcome already set for ${decisionId}: ${decision.outcome}`);
      return;
    }

    // Task 6.5: Calculate new confidence
    const evidenceImpact = getEvidenceImpact(outcome, durationDays);
    const evidence = [{ type: outcome, impact: evidenceImpact }];
    const prevConfidence = Number(decision.confidence ?? 0);
    const newConfidence = updateConfidence(prevConfidence, evidence);

    // Update decision with outcome and new confidence
    await updateDecisionOutcome(decisionId, {
      outcome,
      failure_reason: failureReason,
      duration_days: durationDays,
      confidence: newConfidence,
    });

    info(
      `[MAMA] Confidence updated: ${prevConfidence.toFixed(2)} → ${newConfidence.toFixed(2)} (${outcome})`
    );
  } catch (error) {
    throw new Error(`Failed to mark outcome: ${error.message}`);
  }
}

/**
 * UserPromptSubmit Handler
 *
 * Task 4.4: On UserPromptSubmit, analyze user message for indicators
 * Task 4.5: If matches + recent decision (< 1 hour), mark outcome
 * Task 4.6: Extract failure_reason from user message
 * Task 4.7: Calculate duration_days
 * Task 4.8: Update decision row
 *
 * AC #3: Failure tracking (user feedback → outcome marked)
 *
 * @param {Object} hookContext - Hook context from Claude Code
 * @param {string} hookContext.user_message - User's message
 * @param {string} hookContext.session_id - Session ID
 */
async function onUserPromptSubmit(hookContext) {
  try {
    const userMessage = hookContext.user_message || '';
    const sessionId = hookContext.session_id || '';

    // Task 4.4: Analyze user message for outcome
    const outcome = analyzeOutcome(userMessage);

    if (!outcome) {
      // No clear outcome detected
      return;
    }

    // Task 4.5: Find recent decision (< 1 hour)
    const recentDecision = getRecentDecision(sessionId);

    if (!recentDecision) {
      // No recent decision to mark
      return;
    }

    // Task 4.6: Extract failure reason
    const failureReason = extractFailureReason(userMessage, outcome);

    // Task 4.7: Calculate duration
    const durationDays = calculateDurationDays(recentDecision.created_at);

    // Task 4.8: Mark outcome
    await markOutcome(recentDecision.id, outcome, failureReason, durationDays);

    info(`[MAMA] Outcome marked: ${recentDecision.id} → ${outcome} (${durationDays} days)`);
  } catch (error) {
    // Log error but don't crash hook
    logError(`[MAMA] Outcome tracking failed: ${error.message}`);
  }
}

// Export API
module.exports = {
  onUserPromptSubmit,
  analyzeOutcome,
  extractFailureReason,
  getRecentDecision,
  calculateDurationDays,
  markOutcome,
  matchesFailureIndicators,
  matchesSuccessIndicators,
  matchesPartialIndicators,
  FAILURE_INDICATORS,
  SUCCESS_INDICATORS,
  PARTIAL_INDICATORS,
  RECENT_WINDOW_MS,
};
