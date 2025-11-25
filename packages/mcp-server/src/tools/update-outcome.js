/**
 * MCP Tool: update_outcome
 *
 * Story M1.5: MCP Tool - update_outcome (deferred from M1.3)
 * Priority: P1 (Core Feature)
 *
 * Updates decision outcomes based on real-world results.
 * Enables tracking success/failure of decisions over time.
 *
 * @module update-outcome
 */

const mama = require('../mama/mama-api.js');

/**
 * Update outcome tool definition
 */
const updateOutcomeTool = {
  name: 'update_outcome',
  description:
    "Update a decision's outcome based on real-world results. Use this to mark decisions as SUCCESS, FAILED, or PARTIAL after implementation/validation. This enables tracking decision success rates and surfacing failures for improvement.\n\n⚡ OUTCOME TYPES:\n• SUCCESS: Decision worked as expected\n• FAILED: Decision caused problems (provide failure_reason)\n• PARTIAL: Decision partially worked (provide limitation)\n\n⚡ USE CASES:\n• After testing: Mark experimental decisions as SUCCESS/FAILED\n• After deployment: Update outcomes based on production metrics\n• After user feedback: Capture failure reasons from complaints",
  inputSchema: {
    type: 'object',
    properties: {
      decisionId: {
        type: 'string',
        description:
          "Decision ID to update (e.g., 'decision_auth_strategy_123456_abc'). Get this from recall_decision or list_decisions responses.",
      },
      outcome: {
        type: 'string',
        enum: ['SUCCESS', 'FAILED', 'PARTIAL'],
        description:
          "Outcome status:\n• 'SUCCESS': Decision worked well in practice\n• 'FAILED': Decision caused problems (explain in failure_reason)\n• 'PARTIAL': Decision partially worked (explain in limitation)",
      },
      failure_reason: {
        type: 'string',
        description:
          "Why the decision failed (REQUIRED if outcome='FAILED'). Examples: 'Performance degraded under load', 'Security vulnerability found', 'User complaints about complexity'. Max 2000 characters.",
      },
      limitation: {
        type: 'string',
        description:
          "What limitations were discovered (OPTIONAL for outcome='PARTIAL'). Examples: 'Works for most cases but fails with large datasets', 'Acceptable for MVP but needs optimization'. Max 2000 characters.",
      },
    },
    required: ['decisionId', 'outcome'],
  },

  async handler(params, _context) {
    const { decisionId, outcome, failure_reason, limitation } = params || {};

    try {
      // Validation: Required fields
      if (!decisionId || typeof decisionId !== 'string' || decisionId.trim() === '') {
        return {
          success: false,
          message: '❌ Validation error: decisionId must be a non-empty string',
        };
      }

      if (!outcome || !['SUCCESS', 'FAILED', 'PARTIAL'].includes(outcome)) {
        return {
          success: false,
          message: '❌ Validation error: outcome must be "SUCCESS", "FAILED", or "PARTIAL"',
        };
      }

      // Validation: failure_reason required for FAILED
      if (outcome === 'FAILED' && (!failure_reason || failure_reason.trim() === '')) {
        return {
          success: false,
          message:
            '❌ Validation error: failure_reason is required when outcome="FAILED" (explain what went wrong)',
        };
      }

      // Validation: Field lengths
      if (failure_reason && failure_reason.length > 2000) {
        return {
          success: false,
          message: `❌ Validation error: failure_reason must be ≤ 2000 characters (got ${failure_reason.length})`,
        };
      }

      if (limitation && limitation.length > 2000) {
        return {
          success: false,
          message: `❌ Validation error: limitation must be ≤ 2000 characters (got ${limitation.length})`,
        };
      }

      // Call MAMA API
      await mama.updateOutcome(decisionId, {
        outcome,
        failure_reason,
        limitation,
      });

      // Return success response
      return {
        success: true,
        decision_id: decisionId,
        outcome,
        message: `✅ Decision outcome updated to ${outcome}${
          failure_reason
            ? `\n   Reason: ${failure_reason.substring(0, 100)}${failure_reason.length > 100 ? '...' : ''}`
            : ''
        }${limitation ? `\n   Limitation: ${limitation.substring(0, 100)}${limitation.length > 100 ? '...' : ''}` : ''}`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';

      // Check for common errors
      if (errorMessage.includes('not found')) {
        return {
          success: false,
          message: `❌ Decision not found: ${decisionId}\n\nUse recall_decision or list_decisions to find valid decision IDs.`,
        };
      }

      return {
        success: false,
        message: `❌ Failed to update outcome: ${errorMessage}`,
      };
    }
  },
};

module.exports = { updateOutcomeTool };
