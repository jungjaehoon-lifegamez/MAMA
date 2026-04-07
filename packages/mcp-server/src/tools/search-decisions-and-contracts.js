/**
 * MCP Tool: search_decisions_and_contracts
 *
 * PreToolUse hook RPC — searches decisions and contract-specific memories
 * for file-aware context injection before Edit/Write/apply_patch tool calls.
 *
 * @module search-decisions-and-contracts
 */

const path = require('path');
const { initDB } = require('@jungjaehoon/mama-core/db-manager');
const { generateEmbedding } = require('@jungjaehoon/mama-core/embeddings');
const { vectorSearch } = require('@jungjaehoon/mama-core/memory-store');

/**
 * search_decisions_and_contracts tool definition
 */
const searchDecisionsAndContractsTool = {
  name: 'search_decisions_and_contracts',
  description: 'Search decisions and contracts for PreToolUse hook injection.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query for decisions.' },
      filePath: { type: 'string', description: 'File path context.' },
      toolName: { type: 'string', description: 'Tool name (Edit/Write/apply_patch).' },
      decisionLimit: { type: 'number', description: 'Max decisions (default: 5).' },
      contractLimit: { type: 'number', description: 'Max contracts (default: 3).' },
      similarityThreshold: {
        type: 'number',
        description: 'Similarity threshold (default: 0.7).',
      },
    },
  },

  async handler(args = {}) {
    try {
      const {
        query = '',
        filePath = '',
        toolName = '',
        decisionLimit = 5,
        contractLimit = 3,
        similarityThreshold = 0.7,
      } = args;

      await initDB();

      let decisionResults = [];
      let contractResults = [];

      // Decision search
      if (decisionLimit > 0 && query) {
        try {
          const queryEmbedding = await generateEmbedding(query);
          const results = await vectorSearch(queryEmbedding, decisionLimit, similarityThreshold);
          if (Array.isArray(results)) {
            decisionResults = results.slice(0, decisionLimit);
          }
        } catch (err) {
          console.error('[MAMA MCP] Decision search failed:', err.message);
        }
      }

      // Contract search (file-specific)
      const contractTools = ['Edit', 'Write', 'apply_patch'];
      const codeExtensions = ['.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs', '.java'];
      const ext = filePath ? path.extname(filePath) : '';

      if (
        contractLimit > 0 &&
        filePath &&
        contractTools.includes(toolName) &&
        codeExtensions.includes(ext)
      ) {
        const basename = path.basename(filePath, ext);
        const keywords = basename.split(/[-_]/).filter(Boolean);
        const contractQuery = `contract api ${keywords.join(' ')}`.trim();

        if (contractQuery) {
          try {
            const contractEmbedding = await generateEmbedding(contractQuery);
            const contractMatches = await vectorSearch(contractEmbedding, 10, similarityThreshold);
            if (Array.isArray(contractMatches)) {
              contractResults = contractMatches
                .filter((r) => r.topic && r.topic.startsWith('contract_'))
                .slice(0, contractLimit);
            }
          } catch (err) {
            console.error('[MAMA MCP] Contract search failed:', err.message);
          }
        }
      }

      return {
        success: true,
        decisionResults,
        contractResults,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

module.exports = { searchDecisionsAndContractsTool };
