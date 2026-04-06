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
 * - SQLite + pure-TS cosine similarity for decision storage
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
const path = require('path');

// Import all MAMA tools from src/tools/ — single source of truth for tool definitions
const { createMemoryTools } = require('./tools/index.js');
const memoryTools = createMemoryTools();
const mama = require('@jungjaehoon/mama-core/mama-api');

// Import core modules from mama-core
const { initDB } = require('@jungjaehoon/mama-core/db-manager');
const { generateEmbedding } = require('@jungjaehoon/mama-core/embeddings');
const { vectorSearch } = require('@jungjaehoon/mama-core/memory-store');
const embeddingServer = require('@jungjaehoon/mama-core/embedding-server');
const http = require('http');

const REQUIRED_ENV_VARS = ['MAMA_SERVER_TOKEN', 'MAMA_DB_PATH', 'MAMA_SERVER_PORT'];

/**
 * Check if embedding server is already running (e.g., started by Standalone)
 * @param {number} port - Port to check
 * @returns {Promise<boolean>} - true if server is running
 */
async function isEmbeddingServerRunning(port) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/health',
        method: 'GET',
        timeout: 1000,
      },
      (res) => {
        // Drain the response to free up the socket
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

// Default values for development
const ENV_DEFAULTS = {
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
        if (key === 'MAMA_SERVER_TOKEN') {
          const generatedToken = require('crypto').randomBytes(16).toString('hex');
          process.env[key] = generatedToken;
          const masked = generatedToken.slice(0, 8) + '...' + generatedToken.slice(-4);
          console.error(`[MAMA MCP] Generated random dev token: ${masked}`);
        } else {
          process.env[key] = ENV_DEFAULTS[key];
        }
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
    this.legacyHttpEmbeddingMode = process.env.MAMA_MCP_START_HTTP_EMBEDDING === 'true';
    this.legacyNoticeEmittedInToolResponse = false;

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

  getLegacyMigrationNotice() {
    return (
      '⚠️ Legacy MCP HTTP embedding mode is enabled via MAMA_MCP_START_HTTP_EMBEDDING=true. ' +
      'This mode is deprecated. Recommended runtime: `mama start` (API/UI 3847, embedding 3849).'
    );
  }

  setupHandlers() {
    // Tool definitions come from src/tools/ (single source of truth).
    // Legacy unified tools (save, search, update) kept as wrappers for backward compat.
    const legacyNotice = this.legacyHttpEmbeddingMode
      ? `${this.getLegacyMigrationNotice()}\n\n`
      : '';

    const legacyTools = [
      {
        name: 'save',
        description: `${legacyNotice}${memoryTools.save_decision.description}\n\nAlso supports type='checkpoint' for session state.`,
        inputSchema: {
          type: 'object',
          properties: {
            ...memoryTools.save_decision.inputSchema.properties,
            type: {
              type: 'string',
              enum: ['decision', 'checkpoint'],
              description: "What to save: 'decision' or 'checkpoint'",
            },
            summary: {
              type: 'string',
              description: '[Checkpoint] Session state summary.',
            },
            next_steps: {
              type: 'string',
              description: '[Checkpoint] Instructions for next session.',
            },
            open_files: {
              type: 'array',
              items: { type: 'string' },
              description: '[Checkpoint] Currently relevant files.',
            },
          },
          required: ['type'],
        },
      },
      {
        name: 'search',
        description: memoryTools.suggest_decision.description,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query. Semantic search finds related decisions.',
            },
            type: {
              type: 'string',
              enum: ['all', 'decision', 'checkpoint'],
              description: "Filter by type. Default: 'all'",
            },
            limit: { type: 'number', description: 'Maximum results. Default: 10' },
            scopes: memoryTools.save_decision.inputSchema.properties.scopes,
          },
        },
      },
      {
        name: 'update',
        description: memoryTools.update_outcome.description,
        inputSchema: memoryTools.update_outcome.inputSchema,
      },
    ];

    // Only expose tools that provide genuinely new functionality not covered by
    // the unified save/search/update tools above. src/tools/ handlers are still
    // available for internal routing via the CallTool default case.
    const additionalTools = [
      'ingest_conversation',
      'search_decisions_and_contracts',
      'load_checkpoint',
    ]
      .filter((name) => memoryTools[name])
      .map((name) => ({
        name: memoryTools[name].name,
        description: memoryTools[name].description,
        inputSchema: memoryTools[name].inputSchema,
      }));

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [...legacyTools, ...additionalTools],
    }));

    // Handle tool execution — legacy wrappers + v2 tools from src/tools/
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const toolStart = Date.now();
      console.error(`[MAMA MCP] Tool start: ${name}`);

      try {
        let result;

        switch (name) {
          // Legacy unified wrappers (backward compat)
          case 'save':
            result = await this.handleSave(args);
            break;
          case 'search':
            result = await this.handleSearch(args);
            break;
          case 'update':
            result = await this.handleUpdate(args);
            break;
          default:
            // All other tools → src/tools/ handlers (single source of truth)
            if (memoryTools[name] && typeof memoryTools[name].handler === 'function') {
              result = await memoryTools[name].handler(args);
            } else {
              throw new Error(`Unknown tool: ${name}`);
            }
        }

        const shouldInjectLegacyNotice =
          this.legacyHttpEmbeddingMode && !this.legacyNoticeEmittedInToolResponse;

        if (shouldInjectLegacyNotice) {
          this.legacyNoticeEmittedInToolResponse = true;
        }

        console.error(`[MAMA MCP] Tool done: ${name} (${Date.now() - toolStart}ms)`);

        return {
          content: [
            {
              type: 'text',
              text:
                typeof result === 'string'
                  ? result
                  : JSON.stringify(
                      shouldInjectLegacyNotice
                        ? { ...result, migration_notice: this.getLegacyMigrationNotice() }
                        : result,
                      null,
                      2
                    ),
            },
          ],
        };
      } catch (error) {
        console.error(`[MAMA MCP] Tool failed: ${name} (${Date.now() - toolStart}ms)`);
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

  /**
   * Handle unified save (decision or checkpoint)
   */
  async handleSave(args) {
    const { type } = args;

    if (type === 'decision') {
      const { topic, decision, reasoning, confidence = 0.5, scopes, event_date } = args;
      if (!topic || !decision || !reasoning) {
        return { success: false, message: '❌ Decision requires: topic, decision, reasoning' };
      }
      const id = await mama.save({
        type: 'user_decision',
        topic,
        decision,
        reasoning,
        confidence,
        ...(scopes && { scopes }),
        ...(event_date && { event_date }),
      });
      return {
        success: true,
        id,
        type: 'decision',
        message: `✅ Decision saved: ${topic}`,
      };
    }

    if (type === 'checkpoint') {
      const { summary, next_steps, open_files } = args;
      if (!summary) {
        return { success: false, message: '❌ Checkpoint requires: summary' };
      }
      const id = await mama.saveCheckpoint(summary, open_files || [], next_steps || '');
      return {
        success: true,
        id,
        type: 'checkpoint',
        message: '✅ Checkpoint saved',
      };
    }

    return { success: false, message: "❌ type must be 'decision' or 'checkpoint'" };
  }

  /**
   * Handle unified search (decisions + checkpoints)
   */
  async handleSearch(args) {
    const { query, type = 'all', limit = 10, scopes } = args;

    const results = [];

    // Search decisions
    if (type === 'all' || type === 'decision') {
      let decisions;
      if (query) {
        const suggestResult = await mama.suggest(query, {
          limit,
          ...(scopes && { scopes }),
        });
        decisions = suggestResult?.results || [];
      } else {
        decisions = await mama.list({ limit, ...(scopes && { scopes }) });
      }
      // Ensure decisions is an array
      if (Array.isArray(decisions)) {
        results.push(
          ...decisions.map((d) => ({
            ...d,
            _type: 'decision',
          }))
        );
      }
    }

    // Search checkpoints
    if (type === 'all' || type === 'checkpoint') {
      const checkpoints = await mama.listCheckpoints(limit);
      results.push(
        ...checkpoints.map((c) => ({
          id: `checkpoint_${c.id}`,
          summary: c.summary,
          next_steps: c.next_steps,
          created_at: c.timestamp,
          _type: 'checkpoint',
        }))
      );
    }

    // Decisions are already sorted by similarity from suggest().
    // Only sort checkpoints by time. Keep decisions first (relevance), checkpoints after (recency).
    const decisions = results.filter((r) => r._type === 'decision');
    const checkpoints = results
      .filter((r) => r._type === 'checkpoint')
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    const limited = [...decisions, ...checkpoints].slice(0, limit);

    return {
      success: true,
      count: limited.length,
      results: limited,
    };
  }

  /**
   * Handle PreToolUse search for decisions + contracts
   */
  async handleSearchDecisionsAndContracts(args = {}) {
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
  }

  /**
   * Handle update (decision outcome)
   * Story 3.1: Case-insensitive outcome support
   */
  async handleUpdate(args) {
    const { id, outcome, reason } = args;

    if (!id || !outcome) {
      return { success: false, message: '❌ Update requires: id, outcome' };
    }

    // Story 3.1: Normalize outcome - handle both 'failure' and 'failed' variants
    let normalizedOutcome = outcome.toUpperCase();
    if (normalizedOutcome === 'FAILURE') {
      normalizedOutcome = 'FAILED';
    }

    await mama.updateOutcome(id, {
      outcome: normalizedOutcome,
      failure_reason: reason,
    });

    return {
      success: true,
      message: `✅ Updated ${id} → ${normalizedOutcome}`,
    };
  }

  async start() {
    try {
      validateEnvironment();
      setupLogging();

      // Initialize database
      console.error('[MAMA MCP] Initializing database...');
      await initDB();
      console.error('[MAMA MCP] Database initialized');

      // Start MCP server FIRST (don't block on HTTP server)
      const transport = new StdioServerTransport();
      await this.server.connect(transport);

      // Log to stderr (stdout is for MCP JSON-RPC)
      console.error('[MAMA MCP] Server started successfully');
      console.error('[MAMA MCP] Listening on stdio transport');
      console.error('[MAMA MCP] Ready to accept connections');

      // HTTP embedding server startup is disabled by default for MCP.
      // Architecture: Standalone should own HTTP embedding/chat services.
      // Legacy opt-in: set MAMA_MCP_START_HTTP_EMBEDDING=true.
      const startHttpEmbedding = process.env.MAMA_MCP_START_HTTP_EMBEDDING === 'true';
      const rawEmbeddingPort = process.env.MAMA_EMBEDDING_PORT || process.env.MAMA_HTTP_PORT;
      const parsedEmbeddingPort = parseInt(rawEmbeddingPort || '', 10);
      const embeddingPort =
        Number.isInteger(parsedEmbeddingPort) && parsedEmbeddingPort > 0
          ? parsedEmbeddingPort
          : 3849;

      if (!startHttpEmbedding) {
        console.error('[MAMA MCP] HTTP embedding server startup skipped (default behavior)');
        console.error('[MAMA MCP] Use Standalone for Graph Viewer/Mobile Chat');
        console.error(
          '[MAMA MCP] To enable legacy MCP-launched HTTP: MAMA_MCP_START_HTTP_EMBEDDING=true'
        );
        return;
      }

      // Check if Standalone (or another instance) already started the embedding server
      const serverAlreadyRunning = await isEmbeddingServerRunning(embeddingPort);

      if (serverAlreadyRunning) {
        console.error(`[MAMA MCP] Embedding server already running on port ${embeddingPort}`);
        console.error('[MAMA MCP] Using existing server (likely started by Standalone with chat)');
        console.error(`[MAMA MCP] Graph Viewer: http://localhost:${embeddingPort}/viewer`);
        return;
      }

      console.error('[MAMA MCP] Starting HTTP embedding server in background (legacy opt-in)...');
      embeddingServer
        .startEmbeddingServer(embeddingPort)
        .then((httpServer) => {
          if (httpServer) {
            console.error(`[MAMA MCP] HTTP embedding server running on port ${embeddingPort}`);
            console.error(`[MAMA MCP] Graph Viewer: http://localhost:${embeddingPort}/viewer`);
            console.error('[MAMA MCP] Note: Chat disabled (start Standalone for full features)');
            embeddingServer
              .warmModel()
              .catch((err) => console.error('[MAMA MCP] Model warmup error:', err.message));
          } else {
            console.error('[MAMA MCP] HTTP embedding server skipped (port unavailable or blocked)');
          }
        })
        .catch((err) => {
          console.error('[MAMA MCP] HTTP embedding server error:', err.message);
          console.error('[MAMA MCP] MCP tools will continue to work without Graph Viewer');
        });
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
