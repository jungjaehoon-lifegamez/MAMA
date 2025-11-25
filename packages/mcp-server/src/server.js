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
const {
  proposeLinkTool,
  approveLinkTool,
  rejectLinkTool,
  getPendingLinksTool,
  deprecateAutoLinksTool,
  scanAutoLinksTool,
  createLinkBackupTool,
  generateCleanupReportTool,
  restoreLinkBackupTool,
  executeLinkCleanupTool,
  validateCleanupResultTool,
} = require('./tools/link-tools.js');
const {
  generateQualityReportTool,
  getRestartMetricsTool,
} = require('./tools/quality-metrics-tools.js');

// Import core modules
const { initDB } = require('./mama/db-manager.js');

const REQUIRED_ENV_VARS = ['MAMA_SERVER_TOKEN', 'MAMA_DB_PATH', 'MAMA_SERVER_PORT'];

// Default values for development
const ENV_DEFAULTS = {
  MAMA_SERVER_TOKEN: 'dev-token-12345',
  MAMA_DB_PATH: process.env.HOME
    ? `${process.env.HOME}/.claude/mama-memory.db`
    : './mama-memory.db',
  MAMA_SERVER_PORT: '3000',
};

/**
 * Setup logging with token masking
 */
function setupLogging() {
  const token = process.env.MAMA_SERVER_TOKEN;
  if (!token) {
    return;
  }

  const originalConsoleError = console.error;
  const originalConsoleLog = console.log;

  const maskToken = (args) => {
    return args.map((arg) => {
      if (typeof arg === 'string') {
        return arg.replace(
          new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
          '***token***'
        );
      }
      return arg;
    });
  };

  console.error = (...args) => {
    originalConsoleError.apply(console, maskToken(args));
  };

  console.log = (...args) => {
    originalConsoleLog.apply(console, maskToken(args));
  };
}

/**
 * Validate and set default environment variables if missing.
 * In production, missing vars would cause exit(1).
 * In development, defaults are provided with a warning.
 */
function validateEnvironment() {
  const missingVars = REQUIRED_ENV_VARS.filter((key) => {
    const value = process.env[key];
    return value === undefined || value === null || value.toString().trim() === '';
  });

  if (missingVars.length > 0) {
    // Development mode: Set defaults and warn
    if (process.env.NODE_ENV !== 'production') {
      console.error(
        '[MAMA MCP] Warning: Using default values for missing env vars:',
        missingVars.join(', ')
      );
      missingVars.forEach((key) => {
        process.env[key] = ENV_DEFAULTS[key];
      });
      return;
    }

    // Production mode: Exit with error
    const errorPayload = {
      error: {
        code: 'MISSING_ENV_VARS',
        message: `Missing required environment variables: ${missingVars.join(', ')}`,
        details: {
          missing: missingVars,
          required: REQUIRED_ENV_VARS,
        },
      },
    };

    console.error(JSON.stringify(errorPayload, null, 2));
    process.exit(1);
  }
}

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
          description: "Save a decision or insight to MAMA's memory for future reference.",
          inputSchema: {
            type: 'object',
            properties: {
              topic: {
                type: 'string',
                description:
                  "Decision topic identifier (e.g., 'auth_strategy'). Use lowercase with underscores.",
              },
              decision: {
                type: 'string',
                description: "The decision made (e.g., 'Use JWT with refresh tokens').",
              },
              reasoning: {
                type: 'string',
                description:
                  'Why this decision was made. REQUIRED - explain the context and rationale.',
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
                description: "Decision type. Default: 'user_decision'",
              },
              outcome: {
                type: 'string',
                enum: ['pending', 'success', 'failure', 'partial', 'superseded'],
                description: "Outcome status. Default: 'pending'",
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
                description: "User's question or intent",
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
              decisionId: {
                type: 'string',
                description: "Decision ID to update (e.g., 'decision_auth_strategy_123456_abc').",
              },
              outcome: {
                type: 'string',
                enum: ['SUCCESS', 'FAILED', 'PARTIAL'],
                description: 'New outcome status',
              },
              failure_reason: {
                type: 'string',
                description: "Why the decision failed (REQUIRED if outcome='FAILED').",
              },
              limitation: {
                type: 'string',
                description: "What limitations were discovered (OPTIONAL for outcome='PARTIAL').",
              },
            },
            required: ['decisionId', 'outcome'],
          },
        },
        {
          name: 'save_checkpoint',
          description:
            'Save the current session state (checkpoint). Format: 1) Goal & Progress (honest about unfinished), 2) Evidence with status [Verified/Not run/Assumed], 3) Unfinished & Risks, 4) Next Agent briefing (Definition of Done + quick health-check commands).',
          inputSchema: {
            type: 'object',
            properties: {
              summary: {
                type: 'string',
                description:
                  'Summary of the current session state, what was accomplished, and what is pending.',
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
          description:
            'Load the latest active session checkpoint. Use this at the start of a new session to resume work seamlessly.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        // Epic 3: Link Collaboration & Governance
        {
          name: 'propose_link',
          description: proposeLinkTool.description,
          inputSchema: proposeLinkTool.inputSchema,
        },
        {
          name: 'approve_link',
          description: approveLinkTool.description,
          inputSchema: approveLinkTool.inputSchema,
        },
        {
          name: 'reject_link',
          description: rejectLinkTool.description,
          inputSchema: rejectLinkTool.inputSchema,
        },
        {
          name: 'get_pending_links',
          description: getPendingLinksTool.description,
          inputSchema: getPendingLinksTool.inputSchema,
        },
        {
          name: 'deprecate_auto_links',
          description: deprecateAutoLinksTool.description,
          inputSchema: deprecateAutoLinksTool.inputSchema,
        },
        {
          name: 'scan_auto_links',
          description: scanAutoLinksTool.description,
          inputSchema: scanAutoLinksTool.inputSchema,
        },
        {
          name: 'create_link_backup',
          description: createLinkBackupTool.description,
          inputSchema: createLinkBackupTool.inputSchema,
        },
        {
          name: 'generate_cleanup_report',
          description: generateCleanupReportTool.description,
          inputSchema: generateCleanupReportTool.inputSchema,
        },
        {
          name: 'restore_link_backup',
          description: restoreLinkBackupTool.description,
          inputSchema: restoreLinkBackupTool.inputSchema,
        },
        {
          name: 'generate_quality_report',
          description: generateQualityReportTool.description,
          inputSchema: generateQualityReportTool.inputSchema,
        },
        {
          name: 'get_restart_metrics',
          description: getRestartMetricsTool.description,
          inputSchema: getRestartMetricsTool.inputSchema,
        },
        {
          name: 'execute_link_cleanup',
          description: executeLinkCleanupTool.description,
          inputSchema: executeLinkCleanupTool.inputSchema,
        },
        {
          name: 'validate_cleanup_result',
          description: validateCleanupResultTool.description,
          inputSchema: validateCleanupResultTool.inputSchema,
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
          case 'propose_link':
            result = await proposeLinkTool.handler(args);
            break;
          case 'approve_link':
            result = await approveLinkTool.handler(args);
            break;
          case 'reject_link':
            result = await rejectLinkTool.handler(args);
            break;
          case 'get_pending_links':
            result = await getPendingLinksTool.handler(args);
            break;
          case 'deprecate_auto_links':
            result = await deprecateAutoLinksTool.handler(args);
            break;
          case 'scan_auto_links':
            result = await scanAutoLinksTool.handler(args);
            break;
          case 'create_link_backup':
            result = await createLinkBackupTool.handler(args);
            break;
          case 'generate_cleanup_report':
            result = await generateCleanupReportTool.handler(args);
            break;
          case 'restore_link_backup':
            result = await restoreLinkBackupTool.handler(args);
            break;
          case 'generate_quality_report':
            result = await generateQualityReportTool.handler(args);
            break;
          case 'get_restart_metrics':
            result = await getRestartMetricsTool.handler(args);
            break;
          case 'execute_link_cleanup':
            result = await executeLinkCleanupTool.handler(args);
            break;
          case 'validate_cleanup_result':
            result = await validateCleanupResultTool.handler(args);
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
      setupLogging();
      validateEnvironment();

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

module.exports = { MAMAServer, validateEnvironment, setupLogging, REQUIRED_ENV_VARS };
