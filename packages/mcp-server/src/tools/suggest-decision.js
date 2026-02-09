/**
 * MCP Tool: suggest_decision
 *
 * Story M1.3: MCP Tool - suggest_decision (ported from mcp-server)
 * Priority: P1 (Core Feature)
 *
 * Auto-suggests relevant past decisions based on semantic search.
 *
 * @module suggest-decision
 */

const mama = require('@jungjaehoon/mama-core/mama-api');

/**
 * Suggest decision tool definition
 */
const suggestDecisionTool = {
  name: 'suggest_decision',
  description:
    "Auto-suggest relevant past decisions based on user's question. Uses semantic search to find decisions related to the current context. Returns null if no relevant decisions found. Supports multilingual queries (English, Korean, etc.).",
  inputSchema: {
    type: 'object',
    properties: {
      userQuestion: {
        type: 'string',
        description:
          "User's question or intent (e.g., 'How should I handle authentication?', 'What about mesh count?'). The tool will perform semantic search to find relevant past decisions.",
      },
      recencyWeight: {
        type: 'number',
        description:
          'Optional: How much to weight recency vs semantic similarity (0-1). Default: 0.3 (70% semantic, 30% recency).',
        minimum: 0,
        maximum: 1,
      },
      recencyScale: {
        type: 'number',
        description: 'Optional: Scale factor for recency scoring. Default: 0.7',
        default: 0.7,
      },
      recencyDecay: {
        type: 'number',
        description: 'Optional: Decay rate for recency over time. Default: 0.001',
        default: 0.001,
      },
      disableRecency: {
        type: 'boolean',
        description: 'Optional: Disable recency weighting entirely. Default: false',
        default: false,
      },
    },
    required: ['userQuestion'],
  },

  async handler(params, _context) {
    const { userQuestion, recencyWeight, recencyScale, recencyDecay, disableRecency } =
      params || {};

    try {
      // Validation
      if (!userQuestion || typeof userQuestion !== 'string' || userQuestion.trim() === '') {
        return {
          success: false,
          message: '❌ Validation error: userQuestion must be a non-empty string',
        };
      }

      // Call MAMA API with markdown format
      const suggestions = await mama.suggest(userQuestion, {
        format: 'markdown',
        recencyWeight,
        recencyScale,
        recencyDecay,
        disableRecency,
      });

      if (!suggestions) {
        // No relevant decisions found (graceful)
        return {
          success: true,
          message: '💡 No relevant past decisions found for this question.',
        };
      }

      return {
        success: true,
        suggestions,
        message: suggestions,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      return {
        success: false,
        message: `❌ Failed to suggest decisions: ${errorMessage}`,
      };
    }
  },
};

module.exports = { suggestDecisionTool };
