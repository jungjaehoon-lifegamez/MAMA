#!/usr/bin/env node

/**
 * MAMA MCP Server
 *
 * Memory-Augmented MCP Assistant - MCP Server Implementation
 *
 * This server provides MCP tools for decision tracking, semantic search,
 * and decision graph navigation across Claude Code and Claude Desktop.
 *
 * Architecture:
 * - Stdio transport (standard MCP pattern)
 * - SQLite + sqlite-vec for decision storage
 * - Transformers.js for local embeddings
 * - No network dependencies (100% local)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// Import MAMA tools
import { saveDecisionTool } from './tools/save-decision.js';
import { recallDecisionTool } from './tools/recall-decision.js';
import { suggestDecisionTool } from './tools/suggest-decision.js';
import { listDecisionsTool } from './tools/list-decisions.js';
import { updateOutcomeTool } from './tools/update-outcome.js';

// Import core modules
import { initDB } from './mama/db-manager.js';

/**
 * MAMA MCP Server
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
          description: 'Save a decision or insight to MAMA\'s memory for future reference. Use this when the user explicitly wants to remember something important (e.g., architectural decisions, parameter choices, lessons learned). The decision will be stored with semantic embeddings for later retrieval.',
          inputSchema: {
            type: 'object',
            properties: {
              topic: {
                type: 'string',
                description: 'Decision topic identifier (e.g., \'auth_strategy\', \'mesh_detail_choice\'). Use lowercase with underscores. REUSE SAME TOPIC for related decisions to create supersedes edges.',
              },
              decision: {
                type: 'string',
                description: 'The decision made (e.g., \'Use JWT with refresh tokens\'). Max 2000 characters.',
              },
              reasoning: {
                type: 'string',
                description: 'Why this decision was made. REQUIRED - never leave empty. Explain the context, alternatives considered, and rationale. Max 5000 characters.',
              },
              confidence: {
                type: 'number',
                description: 'Confidence score 0.0-1.0. Use 0.9 for high confidence, 0.8 for medium, 0.5 for experimental. Default: 0.5',
                minimum: 0,
                maximum: 1,
              },
              type: {
                type: 'string',
                enum: ['user_decision', 'assistant_insight'],
                description: '\'user_decision\' if user explicitly decided, \'assistant_insight\' if this is Claude\'s suggestion. Default: \'user_decision\'',
              },
              outcome: {
                type: 'string',
                enum: ['pending', 'success', 'failure', 'partial', 'superseded'],
                description: 'Decision outcome status. Use \'pending\' for new decisions (default), \'success\' when confirmed working, \'failure\' when approach failed.',
              },
              failure_reason: {
                type: 'string',
                description: 'Why this decision failed (optional, use with outcome=\'failure\').',
              },
              limitation: {
                type: 'string',
                description: 'Known limitations or constraints of this decision (optional).',
              },
            },
            required: ['topic', 'decision', 'reasoning'],
          },
        },
        {
          name: 'recall_decision',
          description: 'Recall full decision history for a specific topic. Returns all past decisions on this topic in chronological order with reasoning, confidence, and outcomes. Use this when you need to review previous decisions or check current position on a topic.',
          inputSchema: {
            type: 'object',
            properties: {
              topic: {
                type: 'string',
                description: 'Decision topic to recall (e.g., \'auth_strategy\'). Use the EXACT SAME topic name used in save_decision.',
              },
            },
            required: ['topic'],
          },
        },
        {
          name: 'suggest_decision',
          description: 'Auto-suggest relevant past decisions based on user\'s question. Uses semantic search to find decisions related to the current context. Returns null if no relevant decisions found. Supports multilingual queries.',
          inputSchema: {
            type: 'object',
            properties: {
              userQuestion: {
                type: 'string',
                description: 'User\'s question or intent (e.g., \'How should I handle authentication?\'). The tool will perform semantic search to find relevant past decisions.',
              },
              recencyWeight: {
                type: 'number',
                description: 'How much to weight recency vs semantic similarity (0-1). Default: 0.3 (70% semantic, 30% recency).',
                minimum: 0,
                maximum: 1,
              },
              recencyScale: {
                type: 'number',
                description: 'Days until recency score drops to recencyDecay value. Default: 7 days.',
                minimum: 0.1,
              },
              recencyDecay: {
                type: 'number',
                description: 'Recency score at scale point (0-1). Default: 0.5 (50% score at 7 days).',
                minimum: 0.01,
                maximum: 1,
              },
              disableRecency: {
                type: 'boolean',
                description: 'Set true to disable recency boosting entirely (pure semantic search). Default: false.',
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
                description: 'Maximum number of decisions to return (default: 10)',
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
              failure_reason: {
                type: 'string',
                description: 'Why this decision failed (optional)',
              },
            },
            required: ['topic', 'outcome'],
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
            result = await saveDecisionTool(args);
            break;
          case 'recall_decision':
            result = await recallDecisionTool(args);
            break;
          case 'suggest_decision':
            result = await suggestDecisionTool(args);
            break;
          case 'list_decisions':
            result = await listDecisionsTool(args);
            break;
          case 'update_outcome':
            result = await updateOutcomeTool(args);
            break;
          default:
            throw new Error(`Unknown tool: ${name}`);
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
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
    // Initialize database
    await initDB();

    // Start server with stdio transport
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    // Log to stderr (stdout is for MCP JSON-RPC)
    console.error('MAMA MCP Server started');
    console.error('Listening on stdio transport');
  }
}

// Start server
const server = new MAMAServer();
server.start().catch((error) => {
  console.error('Failed to start MAMA MCP Server:', error);
  process.exit(1);
});
