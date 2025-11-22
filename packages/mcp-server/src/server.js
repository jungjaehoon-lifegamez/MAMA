#!/usr/bin/env node

/**
 * MAMA MCP Server
 *
 * Memory-Augmented MCP Assistant - Standalone MCP Server
 *
 * This server provides MCP tools for decision tracking, semantic search,
 * and decision graph navigation across Claude Code and Claude Desktop.
 *
 * Architecture:
 * - Stdio transport (standard MCP pattern)
 * - SQLite + sqlite-vec for decision storage
 * - Transformers.js for local embeddings
 * - No network dependencies (100% local)
 *
 * Usage:
 *   node src/server.js                 # Direct execution
 *   mama-server                        # Via bin (npm install -g)
 *   npx @jungjaehoon/mama-server           # Via npx
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

// Import MAMA tools
const { saveDecisionTool } = require('./tools/save-decision.js');
const { recallDecisionTool } = require('./tools/recall-decision.js');
const { suggestDecisionTool } = require('./tools/suggest-decision.js');
const { listDecisionsTool } = require('./tools/list-decisions.js');
const { updateOutcomeTool } = require('./tools/update-outcome.js');
const { saveCheckpointTool, loadCheckpointTool } = require('./tools/checkpoint-tools.js');

// Import core modules
const { initDB } = require('./mama/db-manager.js');

/**
 * MAMA MCP Server Class
 */
class MAMAServer {
  constructor() {
    this.server = new Server(
      {
        name: 'mama-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  setupHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'save_decision',
          description: 'Save a decision or insight to MAMA\'s memory for future reference.',
          inputSchema: {
            type: 'object',
            properties: {
              topic: {
                type: 'string',
                description: 'Decision topic identifier (e.g., \'auth_strategy\'). Use lowercase with underscores.',
              },
              decision: {
                type: 'string',
                description: 'The decision made (e.g., \'Use JWT with refresh tokens\').',
              },
              reasoning: {
                type: 'string',
                description: 'Why this decision was made. REQUIRED - explain the context and rationale.',
              },
              confidence: {
                type: 'number',
                description: 'Confidence score 0.0-1.0. Default: 0.5',
                minimum: 0,
                maximum: 1,
              },
              type: {
                type: 'string',
                enum: ['user_decision', 'assistant_insight'],
                description: 'Decision type. Default: \'user_decision\'',
              },
              outcome: {
                type: 'string',
                enum: ['pending', 'success', 'failure', 'partial', 'superseded'],
                description: 'Outcome status. Default: \'pending\'',
              },
            },
            required: ['topic', 'decision', 'reasoning'],
          },
        },
        {
          name: 'recall_decision',
          description: 'Recall full decision history for a specific topic.',
          inputSchema: {
            type: 'object',
            properties: {
              topic: {
                type: 'string',
                description: 'Decision topic to recall',
              },
            },
            required: ['topic'],
          },
        },
        {
          name: 'suggest_decision',
          description: 'Auto-suggest relevant past decisions based on user question.',
          inputSchema: {
            type: 'object',
            properties: {
              userQuestion: {
                type: 'string',
                description: 'User\'s question or intent',
              },
              recencyWeight: {
                type: 'number',
                description: 'Weight for recency (0-1). Default: 0.3',
                minimum: 0,
                maximum: 1,
              },
            },
            required: ['userQuestion'],
          },
        },
        {
          name: 'list_decisions',
          description: 'List recent decisions with optional limit',
          inputSchema: {
            type: 'object',
            properties: {
              limit: {
                type: 'number',
                description: 'Maximum number of decisions (default: 10)',
              },
            },
          },
        },
        {
          name: 'update_outcome',
          description: 'Update the outcome status of an existing decision',
          inputSchema: {
            type: 'object',
            properties: {
              topic: {
                type: 'string',
                description: 'Decision topic to update',
              },
              outcome: {
                type: 'string',
                enum: ['pending', 'success', 'failure', 'partial', 'superseded'],
                description: 'New outcome status',
              },
            },
            required: ['topic', 'outcome'],
          },
        },
        {
          name: 'save_checkpoint',
          description: 'Save the current session state (checkpoint) to MAMA memory. Use this when ending a session or reaching a major milestone so work can be resumed later.',
          inputSchema: {
            type: 'object',
            properties: {
              summary: {
                type: 'string',
                description: 'Summary of the current session state, what was accomplished, and what is pending.',
              },
              open_files: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of currently relevant or open files.',
              },
              next_steps: {
                type: 'string',
                description: 'Clear instructions for the next session on what to do next.',
              },
            },
            required: ['summary'],
          },
        },
        {
          name: 'load_checkpoint',
          description: 'Load the latest active session checkpoint. Use this at the start of a new session to resume work seamlessly.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
      ],
    }));

    // Handle tool execution
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        let result;

        switch (name) {
          case 'save_decision':
            result = await saveDecisionTool.handler(args);
            break;
          case 'recall_decision':
            result = await recallDecisionTool.handler(args);
            break;
          case 'suggest_decision':
            result = await suggestDecisionTool.handler(args);
            break;
          case 'list_decisions':
            result = await listDecisionsTool.handler(args);
            break;
          case 'update_outcome':
            result = await updateOutcomeTool.handler(args);
            break;
          case 'save_checkpoint':
            result = await saveCheckpointTool.handler(args);
            break;
          case 'load_checkpoint':
            result = await loadCheckpointTool.handler(args);
            break;
          default:
            throw new Error(`Unknown tool: ${name}`);
        }

        return {
          content: [
            {
              type: 'text',
              text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        console.error('[MAMA MCP] Tool execution error:', error);
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  async start() {
    try {
      // Initialize database
      console.error('[MAMA MCP] Initializing database...');
      await initDB();
      console.error('[MAMA MCP] Database initialized');

      // Start server with stdio transport
      const transport = new StdioServerTransport();
      await this.server.connect(transport);

      // Log to stderr (stdout is for MCP JSON-RPC)
      console.error('[MAMA MCP] Server started successfully');
      console.error('[MAMA MCP] Listening on stdio transport');
      console.error('[MAMA MCP] Ready to accept connections');
    } catch (error) {
      console.error('[MAMA MCP] Failed to start server:', error);
      process.exit(1);
    }
  }
}

// Start server if run directly
if (require.main === module) {
  const server = new MAMAServer();
  server.start().catch((error) => {
    console.error('[MAMA MCP] Fatal error:', error);
    process.exit(1);
  });
}

module.exports = { MAMAServer };
