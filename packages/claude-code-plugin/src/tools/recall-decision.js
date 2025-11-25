/**
 * MCP Tool: recall_decision
 *
 * Story M1.3: MCP Tool - recall_decision (ported from mcp-server)
 * Priority: P1 (Core Feature)
 *
 * Recalls full decision history for a specific topic.
 * This is a wrapper around the existing mama.recall() API.
 *
 * Flow:
 * 1. User (via Claude Desktop): "Recall my decision about auth strategy"
 * 2. Claude: Calls recall_decision MCP tool
 * 3. Tool: Validates input, calls mama.recall()
 * 4. mama.recall(): Queries decision history + formats as markdown
 * 5. Tool: Returns formatted markdown response
 *
 * @module recall-decision
 */

const mama = require('../core/mama-api.js');

/**
 * Recall decision tool definition
 */
const recallDecisionTool = {
  name: 'recall_decision',
  description:
    'Recall full decision history for a specific topic. Returns all past decisions on this topic in chronological order with reasoning, confidence, and outcomes. Use this when you need to review previous decisions, understand decision evolution, or check current position on a topic.\n\n⚡ GRAPH TRAVERSAL: When the same topic is reused across multiple decisions, this tool automatically shows the decision evolution chain (supersedes graph), enabling Learn/Unlearn/Relearn workflows.',
  inputSchema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description:
          "Decision topic to recall (e.g., 'auth_strategy', 'mesh_detail_choice'). Use the EXACT SAME topic name used in save_decision to see full decision evolution graph. Different topic names will show separate, disconnected decisions.",
      },
    },
    required: ['topic'],
  },

  async handler(params, _context) {
    const { topic } = params || {};

    try {
      // Validation: Non-empty string check
      if (!topic || typeof topic !== 'string' || topic.trim() === '') {
        return {
          success: false,
          message: '❌ Validation error: Topic must be a non-empty string',
        };
      }

      // Call MAMA API with markdown format for human display
      // mama.recall() defaults to JSON (LLM-first), but we need markdown for user display
      const history = await mama.recall(topic, { format: 'markdown' });

      // Return success response with formatted history
      return {
        success: true,
        history,
        message: history, // For backward compatibility with MCP response format
      };
    } catch (error) {
      // Error handling: Return user-friendly message
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';

      return {
        success: false,
        message: `❌ Failed to recall decisions: ${errorMessage}`,
      };
    }
  },
};

module.exports = { recallDecisionTool };
