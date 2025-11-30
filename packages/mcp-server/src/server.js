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

// Import MAMA tools - Simplified to 4 core tools (2025-11-25 refactor)
// Rationale: LLM can infer relationships from search results, fewer tools = more flexibility
const { loadCheckpointTool } = require('./tools/checkpoint-tools.js');
const mama = require('./mama/mama-api.js');

// Import core modules
const { initDB } = require('./mama/db-manager.js');
const { startEmbeddingServer, warmModel } = require('./embedding-http-server.js');

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
    // List available tools - Simplified to 4 core tools (2025-11-25)
    // Design principle: LLM infers relationships from search results
    // Fewer tools = more flexibility, less constraint
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        // 1. SAVE - Unified save for decisions and checkpoints
        {
          name: 'save',
          description: `🤝 Save a decision or checkpoint to your reasoning graph.

⚡ TRIGGERS - Call this when:
• User says: "기억해줘", "remember", "decided", "결정했어"
• Lesson learned: "깨달았어", "알게됐어", "this worked/failed"
• Architectural choice made
• Session ending → use type='checkpoint'

🔗 REQUIRED WORKFLOW (Don't create orphans!):
1. Call 'search' FIRST to find related decisions
2. Check if same topic exists (yours will supersede it)
3. MUST include link in reasoning/summary field

📎 LINKING FORMAT:
• [Decision] reasoning: End with 'builds_on: <id>' or 'debates: <id>' or 'synthesizes: [id1, id2]'
• [Checkpoint] summary: Include 'Related decisions: decision_xxx, decision_yyy'

type='decision': choices & lessons (same topic = evolution chain)
type='checkpoint': session state for resumption (ALSO requires search first!)`,
          inputSchema: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['decision', 'checkpoint'],
                description: "What to save: 'decision' or 'checkpoint'",
              },
              // Decision fields
              topic: {
                type: 'string',
                description:
                  "[Decision] Topic identifier (e.g., 'auth_strategy'). ⚡ REUSE same topic = supersedes previous, creating evolution chain.",
              },
              decision: {
                type: 'string',
                description: "[Decision] The decision made (e.g., 'Use JWT with refresh tokens').",
              },
              reasoning: {
                type: 'string',
                description:
                  "[Decision] Why this decision was made. Include 5-layer narrative: (1) Context - what problem/situation; (2) Evidence - what proves this works (tests, benchmarks, prior experience); (3) Alternatives - what other options were considered and why rejected; (4) Risks - known limitations or failure modes; (5) Rationale - final reasoning for this choice. ⚠️ REQUIRED: End with 'builds_on: <id>' or 'debates: <id>' or 'synthesizes: [id1, id2]' to link related decisions.",
              },
              confidence: {
                type: 'number',
                description: '[Decision] Confidence 0.0-1.0. Default: 0.5',
                minimum: 0,
                maximum: 1,
              },
              // Checkpoint fields
              summary: {
                type: 'string',
                description:
                  "[Checkpoint] Session state summary. Use 4-section format: (1) 🎯 Goal & Progress - what was the goal, where did you stop; (2) ✅ Evidence - mark each item as Verified/Not run/Assumed with proof; (3) ⏳ Unfinished & Risks - incomplete work, blockers, unknowns; (4) 🚦 Next Agent Briefing - Definition of Done, quick health checks to run first. ⚠️ Include 'Related decisions: decision_xxx, decision_yyy' to link context.",
              },
              next_steps: {
                type: 'string',
                description:
                  '[Checkpoint] Instructions for next session: DoD (Definition of Done), quick verification commands (npm test, curl health), constraints/cautions.',
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
        // 2. SEARCH - Unified search across decisions and checkpoints
        {
          name: 'search',
          description: `🔍 Search the reasoning graph before acting.

⚡ TRIGGERS - Call this BEFORE:
• ⚠️ REQUIRED before 'save' (find links first!)
• Making architectural choices (check prior art)
• Debugging (find past failures on similar issues)
• Starting work on a topic (load context)
• User asks: "뭐였더라", "what did we decide", "이전에"

🔗 USE FOR REASONING GRAPH:
• Find decisions to supersede (same topic)
• Find decisions to link (builds_on, debates, synthesizes)
• Understand decision evolution (time-ordered results)

Cross-lingual: Works in Korean and English.
⚠️ High similarity (>0.8) = MUST link with builds_on/debates/synthesizes.`,
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description:
                  'Search query (optional). Semantic search finds related decisions even with different wording. If empty, returns recent items sorted by time.',
              },
              type: {
                type: 'string',
                enum: ['all', 'decision', 'checkpoint'],
                description:
                  "Filter by type: 'decision' for architectural choices, 'checkpoint' for session states, 'all' for both. Default: 'all'",
              },
              limit: {
                type: 'number',
                description: 'Maximum results. Default: 10',
              },
            },
          },
        },
        // 3. UPDATE - Update decision outcome
        {
          name: 'update',
          description: `📝 Update decision outcome after real-world validation.

⚡ TRIGGERS - Call this when:
• Days/weeks later: issues discovered → mark 'failed' + reason
• Production success confirmed → mark 'success'
• Partial results with caveats → mark 'partial'
• User says: "이거 안됐어", "this didn't work", "성공했어"

🔗 REASONING GRAPH IMPACT:
• 'failed' outcomes teach future LLMs what to avoid
• After failure → save NEW decision with same topic to supersede

💡 TIP: Don't just update - if approach changed, save a NEW decision with same topic. This creates evolution history.`,
          inputSchema: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: 'Decision ID to update.',
              },
              outcome: {
                type: 'string',
                description:
                  "New outcome status (case-insensitive): 'success' or 'SUCCESS', 'failed' or 'FAILED', 'partial' or 'PARTIAL'.",
              },
              reason: {
                type: 'string',
                description:
                  'Why it succeeded/failed/was partial. Include specific evidence: error logs, metrics, user feedback, or what broke.',
              },
            },
            required: ['id', 'outcome'],
          },
        },
        // 4. LOAD_CHECKPOINT - Resume previous session
        {
          name: 'load_checkpoint',
          description: `🔄 Resume a previous session with full context.

⚡ TRIGGERS - Call this:
• At session start
• User says: "이어서", "continue", "where were we", "지난번"
• After long break from project

🔗 AFTER LOADING:
1. Verify Evidence items (code may have changed!)
2. Run health checks from next_steps first
3. Call 'search' to refresh related decisions

Returns: summary (4-section), next_steps (DoD + commands), open_files

⚠️ WARNING: Checkpoint may be stale. Always verify before continuing.`,
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
      ],
    }));

    // Handle tool execution - 4 core tools only
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        let result;

        switch (name) {
          case 'save':
            result = await this.handleSave(args);
            break;
          case 'search':
            result = await this.handleSearch(args);
            break;
          case 'update':
            result = await this.handleUpdate(args);
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

  /**
   * Handle unified save (decision or checkpoint)
   */
  async handleSave(args) {
    const { type } = args;

    if (type === 'decision') {
      const { topic, decision, reasoning, confidence = 0.5 } = args;
      if (!topic || !decision || !reasoning) {
        return { success: false, message: '❌ Decision requires: topic, decision, reasoning' };
      }
      const id = await mama.save({ topic, decision, reasoning, confidence });
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
    const { query, type = 'all', limit = 10 } = args;

    const results = [];

    // Search decisions
    if (type === 'all' || type === 'decision') {
      let decisions;
      if (query) {
        // suggest() returns { results: [...] } object or null
        // Note: suggest() takes options object as second parameter
        const suggestResult = await mama.suggest(query, { limit });
        decisions = suggestResult?.results || [];
      } else {
        decisions = await mama.list(limit);
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

    // Sort by time (newest first) and limit
    results.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    const limited = results.slice(0, limit);

    return {
      success: true,
      count: limited.length,
      results: limited,
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
      setupLogging();
      validateEnvironment();

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

      // Start HTTP embedding server in background (non-blocking)
      // This allows Graph Viewer and Mobile Chat without delaying MCP initialization
      const embeddingPort = parseInt(
        process.env.MAMA_HTTP_PORT || process.env.MAMA_EMBEDDING_PORT || '3847',
        10
      );

      console.error('[MAMA MCP] Starting HTTP embedding server in background...');
      startEmbeddingServer(embeddingPort)
        .then((httpServer) => {
          if (httpServer) {
            console.error(`[MAMA MCP] HTTP embedding server running on port ${embeddingPort}`);
            console.error(`[MAMA MCP] Graph Viewer: http://localhost:${embeddingPort}/viewer`);
            // Pre-warm model in background
            warmModel().catch((err) =>
              console.error('[MAMA MCP] Model warmup error:', err.message)
            );
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
