/**
 * MCP Tool: list_decisions
 *
 * Lists recent decisions in chronological order.
 * Returns formatted list with time, type, topic, preview, confidence, and status.
 *
 * Flow:
 * 1. User (via Claude Desktop): "Show me recent decisions"
 * 2. Claude: Calls list_decisions MCP tool
 * 3. Tool: Validates input, calls mama.list()
 * 4. mama.list(): Queries recent decisions + formats as markdown
 * 5. Tool: Returns formatted markdown response
 *
 * @module list-decisions
 */

const path = require('path');

// Import MAMA API from core directory
const mama = require('../mama/mama-api.js');

/**
 * List decisions tool definition
 */
const listDecisionsTool = {
  name: 'list_decisions',
  description:
    'List recent decisions in chronological order. Returns formatted list showing time, type (user/assistant), topic, preview, confidence, and status. Use this to see recent activity or find decisions by browsing.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Maximum number of decisions to return (default: 20, max: 100)',
        minimum: 1,
        maximum: 100,
      },
    },
    required: [],
  },

  async handler(params, context) {
    const { limit = 20 } = params || {};

    try {
      // Validation: Limit range check
      if (limit < 1 || limit > 100) {
        return {
          success: false,
          message: '❌ Validation error: Limit must be between 1 and 100',
        };
      }

      // Call MAMA API with markdown format for human display
      // mama.list() defaults to JSON (LLM-first), but we need markdown for user display
      const list = await mama.list({ limit, format: 'markdown' });

      // Return success response with formatted list
      return {
        success: true,
        list,
        message: list, // For backward compatibility with MCP response format
      };
    } catch (error) {
      // Error handling: Return user-friendly message
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';

      return {
        success: false,
        message: `❌ Failed to list decisions: ${errorMessage}`,
      };
    }
  },
};

module.exports = { listDecisionsTool };
