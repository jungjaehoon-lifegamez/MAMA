/**
 * MCP Tool: search_narrative
 *
 * Story 2.2: Narrative Search/Expansion
 * Priority: P1 (Core Feature)
 *
 * Searches decisions by query with semantic search and link expansion.
 * Returns narratives with 5-layer structure (specificity, evidence, reasoning, tension, continuity)
 * and related links based on depth parameter.
 *
 * @module search-narrative
 */

const { search } = require('../mama/search-engine');
const { expand } = require('../mama/link-expander');
// eslint-disable-next-line no-unused-vars
const { format, formatMultiple } = require('../mama/response-formatter');
const { info, error: logError } = require('../mama/debug-logger');

/**
 * Search narrative tool definition
 */
const searchNarrativeTool = {
  name: 'search_narrative',
  description:
    'Search decisions by query using semantic search. Returns narratives with 5-layer structure (topic, decision, reasoning, evidence, alternatives, risks) and related links. Supports depth-based link expansion and multiple output modes (full/summary/minimal). Use this when you need to find past decisions by semantic meaning, not exact topic match.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          "Search query (e.g., 'authentication strategy', 'error handling approach'). Uses semantic search to find related decisions even if exact words don't match.",
      },
      depth: {
        type: 'number',
        description:
          'Link expansion depth (0=no links, 1=direct links only, 2=2-hop links). Default: 1',
        minimum: 0,
        maximum: 2,
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return. Default: 5',
        minimum: 1,
        maximum: 20,
      },
      mode: {
        type: 'string',
        enum: ['full', 'summary', 'minimal'],
        description:
          'Output mode: full (all fields), summary (core fields + evidence), minimal (topic + decision only). Default: full',
      },
      threshold: {
        type: 'number',
        description: 'Minimum similarity threshold (0.0-1.0). Default: 0.7',
        minimum: 0.0,
        maximum: 1.0,
      },
    },
    required: ['query'],
  },

  async handler(params, _context) {
    const { query, depth = 1, limit = 5, mode = 'full', threshold = 0.7 } = params || {};

    try {
      // Validation
      if (!query || typeof query !== 'string' || query.trim() === '') {
        return {
          success: false,
          message: '❌ Validation error: query must be a non-empty string',
        };
      }

      if (depth < 0 || depth > 2) {
        return {
          success: false,
          message: '❌ Validation error: depth must be between 0 and 2',
        };
      }

      if (limit < 1 || limit > 20) {
        return {
          success: false,
          message: '❌ Validation error: limit must be between 1 and 20',
        };
      }

      if (!['full', 'summary', 'minimal'].includes(mode)) {
        return {
          success: false,
          message: '❌ Validation error: mode must be full, summary, or minimal',
        };
      }

      if (threshold < 0.0 || threshold > 1.0) {
        return {
          success: false,
          message: '❌ Validation error: threshold must be between 0.0 and 1.0',
        };
      }

      info(
        `[search_narrative] Query: "${query}" (depth: ${depth}, limit: ${limit}, mode: ${mode}, threshold: ${threshold})`
      );

      // 1. Perform semantic search
      const searchResults = await search(query, { limit, threshold });

      if (!searchResults || searchResults.length === 0) {
        info(`[search_narrative] No results found for query: "${query}"`);
        return {
          content: [
            {
              type: 'text',
              text: `🔍 No decisions found matching "${query}"\n\nTry:\n- Using different keywords\n- Lowering the similarity threshold\n- Broadening your search terms`,
            },
          ],
        };
      }

      info(`[search_narrative] Found ${searchResults.length} results`);

      // 2. Expand links for each result
      const linksMap = {};
      if (depth > 0) {
        for (const decision of searchResults) {
          try {
            const links = expand(decision.id, depth, true); // approvedOnly=true
            linksMap[decision.id] = links;
            info(
              `[search_narrative] Expanded ${links.length} links for decision ${decision.id} (depth: ${depth})`
            );
          } catch (error) {
            logError(
              `[search_narrative] Failed to expand links for ${decision.id}: ${error.message}`
            );
            linksMap[decision.id] = [];
          }
        }
      }

      // 3. Format results based on mode
      const formattedResults = formatMultiple(searchResults, linksMap, mode);

      // 4. Build response
      const responseData = {
        query,
        results: formattedResults,
        metadata: {
          count: formattedResults.length,
          depth,
          mode,
          threshold,
        },
      };

      // 5. Format as user-friendly text
      const responseText = this._formatResponseText(responseData);

      return {
        content: [
          {
            type: 'text',
            text: responseText,
          },
        ],
        // Also return structured data for programmatic access
        _data: responseData,
      };
    } catch (error) {
      logError(`[search_narrative] Search failed: ${error.message}`);
      return {
        success: false,
        message: `❌ Search failed: ${error.message}`,
      };
    }
  },

  /**
   * Format response as user-friendly text
   *
   * @private
   * @param {Object} data - Response data
   * @returns {string} Formatted text
   */
  _formatResponseText(data) {
    const { query, results, metadata } = data;
    const { count, depth, mode, threshold } = metadata;

    let text = `🔍 Search Results for "${query}"\n\n`;
    text += `Found ${count} decision(s) (similarity ≥ ${threshold})\n`;
    text += `Mode: ${mode}, Link Depth: ${depth}\n\n`;
    text += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

    results.forEach((result, index) => {
      const { narrative, links } = result;

      text += `${index + 1}. **${narrative.topic}**\n`;
      text += `   ID: ${narrative.id}\n`;
      text += `   Similarity: ${narrative.similarity ? (narrative.similarity * 100).toFixed(1) + '%' : 'N/A'}\n\n`;

      text += `   Decision: ${narrative.decision}\n`;

      if (mode !== 'minimal') {
        if (narrative.reasoning) {
          text += `   Reasoning: ${narrative.reasoning}\n`;
        }
        if (narrative.evidence) {
          text += `   Evidence: ${JSON.stringify(narrative.evidence)}\n`;
        }
      }

      if (mode === 'full') {
        if (narrative.alternatives) {
          text += `   Alternatives: ${JSON.stringify(narrative.alternatives)}\n`;
        }
        if (narrative.risks) {
          text += `   Risks: ${narrative.risks}\n`;
        }
        if (narrative.outcome) {
          text += `   Outcome: ${narrative.outcome}\n`;
        }
      }

      // Links
      if (links && links.length > 0) {
        text += `\n   🔗 Links (${links.length}):\n`;
        links.forEach((link, linkIndex) => {
          const direction = link.direction === 'outgoing' ? '→' : '←';
          const target = link.direction === 'outgoing' ? link.to_id : link.from_id;
          text += `      ${linkIndex + 1}. ${direction} ${link.relationship} ${target} (depth: ${link.depth})\n`;
          if (link.reason) {
            text += `         Reason: ${link.reason}\n`;
          }
        });
      }

      text += '\n';
    });

    return text;
  },
};

module.exports = { searchNarrativeTool };
