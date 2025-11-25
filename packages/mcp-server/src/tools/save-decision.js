/**
 * MCP Tool: save_decision
 *
 * Story M1.3: MCP Tool - save_decision (ported from mcp-server)
 * Priority: P1 (Core Feature)
 *
 * Saves decisions and insights to MAMA's memory for future reference.
 *
 * @module save-decision
 */

const mama = require('../mama/mama-api.js');

/**
 * Create save decision tool with dependencies
 * @param {Object} mamaApi - MAMA API instance
 */
const createSaveDecisionTool = (mamaApi) => ({
  name: 'save_decision',
  description:
    "Save a decision or insight to MAMA's memory for future reference. Use this when the user explicitly wants to remember something important (e.g., architectural decisions, parameter choices, lessons learned). The decision will be stored with semantic embeddings for later retrieval.\n\n⚡ IMPORTANT - Graph Connectivity: Reuse the SAME topic name for related decisions to create decision graphs (supersedes/refines/contradicts edges). Example: Use 'auth_strategy' for all authentication decisions, not 'auth_strategy_v1', 'auth_strategy_v2'. This enables Learn/Unlearn/Relearn workflows.",
  inputSchema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description:
          "Decision topic identifier (e.g., 'auth_strategy', 'mesh_detail_choice'). Use lowercase with underscores. Max 200 characters.\n\n⚡ REUSE SAME TOPIC for related decisions to create supersedes edges.",
      },
      decision: {
        type: 'string',
        description:
          "The decision made (e.g., 'Use JWT with refresh tokens'). Max 2000 characters.",
      },
      reasoning: {
        type: 'string',
        description:
          'Why this decision was made. This is REQUIRED - never leave empty. Explain the context, alternatives considered, and rationale. IMPORTANT: Use English for better semantic search and relationship detection (e.g., use "instead of", "contrary to", "replaces" for conflicting decisions). Max 5000 characters.',
      },
      confidence: {
        type: 'number',
        description:
          'Confidence score 0.0-1.0. Use 0.9 for high confidence, 0.8 for medium, 0.5 for experimental. Default: 0.5',
        minimum: 0,
        maximum: 1,
      },
      type: {
        type: 'string',
        enum: ['user_decision', 'assistant_insight'],
        description:
          "'user_decision' if user explicitly decided, 'assistant_insight' if this is Claude's suggestion. Default: 'user_decision'",
      },
      outcome: {
        type: 'string',
        enum: ['pending', 'success', 'failure', 'partial', 'superseded'],
        description: "Outcome status. Default: 'pending'",
      },
      evidence: {
        type: 'array',
        items: { type: 'string' },
        description: 'Evidence supporting the decision (e.g., file paths, logs, metrics).',
      },
      alternatives: {
        type: 'array',
        items: { type: 'string' },
        description: 'Alternative options considered but rejected (Tension layer).',
      },
      risks: {
        type: 'string',
        description: 'Potential risks or downsides (Tension layer).',
      },
    },
    required: ['topic', 'decision', 'reasoning'],
  },

  async handler(params, _context) {
    const {
      topic,
      decision,
      reasoning,
      confidence = 0.5,
      type = 'user_decision',
      outcome = 'pending',
      evidence,
      alternatives,
      risks,
    } = params || {};

    try {
      // Validation
      if (!topic || !decision || !reasoning) {
        return {
          success: false,
          message: '❌ Validation error: topic, decision, and reasoning are required',
        };
      }

      if (topic.length > 200 || decision.length > 2000 || reasoning.length > 5000) {
        return {
          success: false,
          message:
            '❌ Validation error: Field length exceeded (topic≤200, decision≤2000, reasoning≤5000)',
        };
      }

      // Call MAMA API (mama.save will handle outcome mapping to DB format)
      const id = await mamaApi.save({
        topic,
        decision,
        reasoning,
        confidence,
        type, // Assuming mama.saveDecision now expects 'type' directly
        outcome,
        evidence,
        alternatives,
        risks,
      });

      return {
        success: true,
        decision_id: id,
        topic: topic,
        message: `✅ Decision saved successfully (ID: ${id})`,
        recall_command: `To recall: mama.recall('${topic}')`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      return {
        success: false,
        message: `❌ Failed to save decision: ${errorMessage}`,
      };
    }
  },
});

// Default instance with real dependency
const saveDecisionTool = createSaveDecisionTool(mama);

module.exports = { saveDecisionTool, createSaveDecisionTool };
