/**
 * MCP Tool: recall_decision
 *
 * Story M1.3: MCP Tool - recall_decision (ported from mcp-server)
 * Priority: P1 (Core Feature)
 *
 * Recalls decision history for a specific topic using v2 recallMemory API.
 * Supports scope-based filtering.
 *
 * @module recall-decision
 */

const mama = require('@jungjaehoon/mama-core/mama-api');

/**
 * Create recall decision tool with dependencies
 * @param {Object} mamaApi - MAMA API instance
 */
const createRecallDecisionTool = (mamaApi) => ({
  name: 'recall_decision',
  description:
    'Recall decision history for a topic using semantic search. Returns past decisions filtered by scope if provided. Use this when you need to review previous decisions, understand decision evolution, or check current position on a topic.\n\n⚡ GRAPH TRAVERSAL: When the same topic is reused across multiple decisions, this tool automatically shows the decision evolution chain (supersedes graph), enabling Learn/Unlearn/Relearn workflows.',
  inputSchema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description:
          "Decision topic to recall (e.g., 'auth_strategy', 'mesh_detail_choice'). Use the EXACT SAME topic name used in save_decision to see full decision evolution graph.",
      },
      format: {
        type: 'string',
        enum: ['markdown', 'json'],
        description: "Output format. Default: 'markdown'",
      },
      scopes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: ['global', 'user', 'channel', 'project'],
              description: 'Scope type',
            },
            id: {
              type: 'string',
              description: 'Scope identifier (e.g., project path, channel ID)',
            },
          },
          required: ['kind', 'id'],
        },
        description: 'Filter recall results by scope. If omitted, returns all scopes.',
      },
    },
    required: ['topic'],
  },

  async handler(params, _context) {
    const { topic, format = 'markdown', scopes } = params || {};

    try {
      // Validation: Non-empty string check
      if (!topic || typeof topic !== 'string' || topic.trim() === '') {
        return {
          success: false,
          message: '❌ Validation error: Topic must be a non-empty string',
        };
      }

      if (scopes && scopes.length > 0) {
        // Use v2 recallMemory for scope-aware semantic recall
        const bundle = await mamaApi.recallMemory(topic, {
          scopes,
          includeHistory: true,
        });

        if (format === 'json') {
          return { success: true, history: bundle, message: bundle };
        }

        const memories = bundle.memories || [];
        let md = `🧠 **Recall: ${topic}** (${memories.length} results)\n\n`;
        for (const m of memories) {
          md += `### ${m.topic}\n`;
          md += `${m.summary}\n`;
          if (m.details && m.details !== m.summary) {
            md += `> ${m.details}\n`;
          }
          md += `- Confidence: ${m.confidence} | Status: ${m.status}`;
          if (m.event_date) {
            md += ` | Event: ${m.event_date}`;
          }
          md += '\n\n';
        }
        return { success: true, history: md, message: md };
      }

      // Legacy path: topic-exact-match recall (no scopes)
      const history = await mamaApi.recall(topic, { format });

      return {
        success: true,
        history,
        message: history,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      return {
        success: false,
        message: `❌ Failed to recall decisions: ${errorMessage}`,
      };
    }
  },
});

// Default instance with real dependency
const recallDecisionTool = createRecallDecisionTool(mama);

module.exports = { recallDecisionTool, createRecallDecisionTool };
