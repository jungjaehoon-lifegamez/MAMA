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

// Import all MAMA tools from src/tools/ — single source of truth for tool definitions
const { createMemoryTools } = require('./tools/index.js');
const memoryTools = createMemoryTools();
const mama = require('@jungjaehoon/mama-core/mama-api');

// Import core modules from mama-core
const { initDB, declareProductionDatabasePath } = require('@jungjaehoon/mama-core/db-manager');
const { declareEmbeddingCacheDir } = require('@jungjaehoon/mama-core/embeddings');
const os = require('node:os');
const path = require('node:path');
const { version: PACKAGE_VERSION } = require('../package.json');

/** Name this consumer's storage and model cache before core initialization. */
function validateEnvironment() {
  const defaultPath = path.join(os.homedir(), '.claude', 'mama-memory.db');
  declareProductionDatabasePath(defaultPath);
  declareEmbeddingCacheDir(path.join(os.homedir(), '.cache', 'huggingface', 'transformers'));
  // The core also accepts the older MAMA_DATABASE_PATH name; a path set under either wins.
  if (!process.env.MAMA_DB_PATH && !process.env.MAMA_DATABASE_PATH) {
    process.env.MAMA_DB_PATH = defaultPath;
  }
  return process.env.MAMA_DB_PATH || process.env.MAMA_DATABASE_PATH;
}

/**
 * MAMA MCP Server Class
 */
class MAMAServer {
  constructor() {
    this.server = new Server(
      {
        name: 'mama-server',
        version: PACKAGE_VERSION,
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
    // Tool definitions come from src/tools/ (single source of truth).
    // Legacy unified tools (save, search, update) kept as wrappers for backward compat.
    const tools = [
      // 1. SAVE — decisions, checkpoints, conversation ingestion
      {
        name: 'save',
        description: `Save to MAMA memory. Use type parameter to choose what to save.

**type='decision'** — Save architectural decisions, lessons learned, insights.
  Required: topic, decision, reasoning. Optional: confidence, scopes, event_date, links, replaces.
  Search for related decisions first. Link the ones this decision builds on, debates or combines
  with links, and name the ones it replaces with replaces, each with the reason you judged.
  Nothing is linked for you; link later with the link tool.
  Triggers: user says "기억해", "remember", "decided". Topic reuse alone does not create a relationship.

**type='checkpoint'** — Save session state for resumption.
  Required: summary (4-section: Goal, Evidence, Unfinished, Next Briefing).
  Optional: next_steps, open_files. Triggers: session ending, "체크포인트", "save progress".

**type='ingest'** — Import conversation messages into memory as a raw source observation.
  Required: messages (array of {role, content}). Optional: scopes, session_date.

**Scopes**: Isolate memories per project/channel. Example: [{"kind":"project","id":"/my/app"}]
**event_date**: ISO 8601 date when event occurred (e.g. "2024-01-15"), not when saved.`,
        inputSchema: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['decision', 'checkpoint', 'ingest'],
              description: "What to save: 'decision', 'checkpoint', or 'ingest'",
            },
            // Decision fields
            topic: {
              type: 'string',
              description:
                '[Decision] Topic identifier. Relationships require explicit referenced IDs.',
            },
            decision: {
              type: 'string',
              description: '[Decision] The decision made.',
            },
            reasoning: {
              type: 'string',
              description: '[Decision] Why. Relations go in links or replaces, not in this text.',
            },
            links: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'The related decision id.' },
                  relation: {
                    type: 'string',
                    enum: [
                      'builds_on',
                      'refines',
                      'contradicts',
                      'debates',
                      'synthesizes',
                      'mentions',
                    ],
                  },
                  reason: { type: 'string', description: 'What relates the two, in a sentence.' },
                },
                required: ['id', 'relation', 'reason'],
              },
              description:
                '[Decision] Decisions this one relates to, each with the relation and the reason you judged.',
            },
            replaces: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'The replaced decision id.' },
                  reason: { type: 'string', description: 'Why it is replaced.' },
                },
                required: ['id', 'reason'],
              },
              description: '[Decision] Decisions this one replaces, each with the reason.',
            },
            confidence: {
              type: 'number',
              description: '[Decision] 0.0-1.0. Default: 0.5',
              minimum: 0,
              maximum: 1,
            },
            scopes: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['global', 'user', 'channel', 'project'] },
                  id: { type: 'string' },
                },
                required: ['kind', 'id'],
              },
              description: 'Memory scopes for isolation.',
            },
            event_date: {
              type: 'string',
              description: 'ISO 8601 date when event occurred (e.g. "2024-01-15").',
            },
            item: {
              type: 'string',
              description: '[Decision] Explicit registry item node id.',
            },
            actors: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  person: { type: 'string' },
                  role: { type: 'string' },
                },
                required: ['person', 'role'],
              },
              description: '[Decision] Explicit registry person nodes and their roles.',
            },
            // Checkpoint fields
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
            // Ingest fields
            messages: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  role: { type: 'string', enum: ['user', 'assistant', 'system'] },
                  content: { type: 'string' },
                },
                required: ['role', 'content'],
              },
              description: '[Ingest] Conversation messages to import.',
            },
            session_date: {
              type: 'string',
              description: '[Ingest] ISO 8601 date when conversation occurred.',
            },
          },
          required: ['type'],
        },
      },
      // 2. SEARCH — unified search across decisions, checkpoints, load latest checkpoint
      {
        name: 'search',
        description: `Search MAMA memory. Returns results ranked by semantic similarity.

**With query** — Semantic search across decisions and checkpoints. Cross-lingual (Korean + English).
  Triggers: "뭐였더라", "what did we decide", making architectural choices, debugging.

**Without query** — List recent items sorted by time.

**Resume session**: type='checkpoint' without query → loads latest checkpoint with full context (narrative, links, next steps).
  Triggers: "이어서", "continue", "where were we", session start.

**type parameter**: 'decision' (choices/lessons only), 'checkpoint' (session states / resume), 'all' (both, default).
**scopes**: Filter by project/channel. Omit for global search.
**limit**: Max results (default: 10).`,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query. Omit to list recent items.',
            },
            type: {
              type: 'string',
              enum: ['all', 'decision', 'checkpoint'],
              description: "Filter by type. Default: 'all'",
            },
            limit: { type: 'number', description: 'Max results. Default: 10' },
            threshold: {
              type: 'number',
              minimum: 0,
              maximum: 1,
              description: 'Minimum retrieval threshold. Omit for mode default.',
            },
            strict: {
              type: 'boolean',
              description: 'Shortcut for strict search mode.',
            },
            strictness: {
              type: 'string',
              enum: ['recall', 'balanced', 'strict'],
              description: "Search quality mode. Default: 'recall'.",
            },
            disableRecency: {
              type: 'boolean',
              description: 'Disable recency weighting in search.',
            },
            includeRelated: {
              type: 'boolean',
              description: 'Include related graph-expanded results.',
            },
            topicPrefix: {
              type: 'string',
              description: 'Restrict search to topics with this prefix.',
            },
            minLexicalSupport: {
              type: 'boolean',
              description: 'Require lexical/entity/exact-topic confirmation.',
            },
            diagnostics: {
              type: 'boolean',
              description: 'Return retrieval diagnostics for search quality inspection.',
            },
            scopes: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['global', 'user', 'channel', 'project'] },
                  id: { type: 'string' },
                },
                required: ['kind', 'id'],
              },
              description: 'Filter by scope.',
            },
          },
        },
      },
      // 3. UPDATE — decision outcome tracking
      {
        name: 'update',
        description: `Update decision outcome after real-world validation.

Triggers: "이거 안됐어", "this worked", days later when issues discovered.
outcome: 'success', 'failed', 'partial' (case-insensitive).
After failure → save a NEW decision and explicitly reference any relationship in its reasoning.`,
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Decision ID to update.' },
            outcome: {
              type: 'string',
              description: "'success', 'failed', or 'partial' (case-insensitive).",
            },
            reason: {
              type: 'string',
              description: 'Why it succeeded/failed/was partial. Include evidence.',
            },
          },
          required: ['id', 'outcome'],
        },
      },
      // 4. LINK — a link after saving, or a correction of a link
      {
        name: 'link',
        description: `Link one decision to another after saving, with the reason you judged.

Nothing is edited: a wrong link is corrected by linking to it (to = its edgeId from get_decision,
relation contradicts), and both stay in the history. A decision that replaces another is saved
with replaces.`,
        inputSchema: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'The decision the link is stated from.' },
            to: {
              type: 'string',
              description: 'The related decision id, or the edgeId of a link to correct.',
            },
            relation: {
              type: 'string',
              enum: ['builds_on', 'refines', 'contradicts', 'debates', 'synthesizes', 'mentions'],
            },
            reason: { type: 'string', description: 'What relates the two, in a sentence.' },
          },
          required: ['from', 'to', 'relation', 'reason'],
        },
      },
      // 5. GET_DECISION — one decision and its edges, to walk the graph
      {
        name: 'get_decision',
        description: `Read one decision by id with every edge in and out: the relation, the other
decision's id, topic and first line, the reason, who wrote it (agent; agent_text, parsed from an
older reasoning text; host, linked by similarity), and any correction. Follow an edge by reading
the other id.`,
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Decision id.' } },
          required: ['id'],
        },
      },
      // 6. SEARCH_DECISIONS_AND_CONTRACTS — PreToolUse hook RPC (defined in src/tools/)
      {
        name: memoryTools.search_decisions_and_contracts.name,
        description: memoryTools.search_decisions_and_contracts.description,
        inputSchema: memoryTools.search_decisions_and_contracts.inputSchema,
      },
      // 7. CASE_TIMELINE_RANGE — Phase 3 case timeline RPC (defined in src/tools/)
      {
        name: memoryTools.case_timeline_range.name,
        description: memoryTools.case_timeline_range.description,
        inputSchema: memoryTools.case_timeline_range.inputSchema,
      },
    ];

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

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
          case 'link':
            result = await this.handleLink(args);
            break;
          case 'get_decision':
            result = await this.handleGetDecision(args);
            break;
          default:
            // All other tools → src/tools/ handlers (single source of truth)
            if (memoryTools[name] && typeof memoryTools[name].handler === 'function') {
              result = await memoryTools[name].handler(args);
            } else {
              throw new Error(`Unknown tool: ${name}`);
            }
        }

        console.error(`[MAMA MCP] Tool done: ${name} (${Date.now() - toolStart}ms)`);

        return {
          content: [
            {
              type: 'text',
              text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
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
      const {
        topic,
        decision,
        reasoning,
        confidence = 0.5,
        scopes,
        event_date,
        item,
        actors,
        links,
        replaces,
      } = args;
      if (!topic || !decision || !reasoning) {
        return { success: false, message: '❌ Decision requires: topic, decision, reasoning' };
      }
      const saved = await mama.save({
        type: 'user_decision',
        topic,
        decision,
        reasoning,
        confidence,
        ...(scopes && { scopes }),
        ...(event_date && { event_date }),
        ...(item && { item }),
        ...(actors && { actors }),
        ...(links && { links }),
        ...(replaces && { replaces }),
      });
      if (!saved.success) {
        return saved;
      }
      return {
        success: true,
        id: saved.id,
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

    if (type === 'ingest') {
      return await memoryTools.ingest_conversation.handler(args);
    }

    return { success: false, message: "❌ type must be 'decision', 'checkpoint', or 'ingest'" };
  }

  /**
   * Handle unified search (decisions + checkpoints)
   */
  async handleSearch(args) {
    const {
      query,
      type = 'all',
      limit = 10,
      scopes,
      threshold,
      strict,
      strictness,
      disableRecency,
      includeRelated,
      topicPrefix,
      minLexicalSupport,
      diagnostics,
    } = args;

    // type='checkpoint' without query → load latest checkpoint (resume session).
    // load_checkpoint does not yet honor scopes, so reject scoped checkpoint reads
    // explicitly rather than silently bypass scope isolation.
    if (type === 'checkpoint' && !query) {
      if (Array.isArray(scopes) && scopes.length > 0) {
        return {
          success: false,
          code: 'scoped_checkpoint_unsupported',
          count: 0,
          results: [],
          message: 'Scoped checkpoint reads are not supported yet',
        };
      }
      return await memoryTools.load_checkpoint.handler(args);
    }

    const results = [];
    let searchDiagnostics;
    let searchMeta;

    // Search decisions
    if (type === 'all' || type === 'decision') {
      let decisions;
      if (query) {
        const suggestResult = await mama.suggest(query, {
          limit,
          ...(scopes && { scopes }),
          ...(threshold !== undefined && { threshold }),
          ...(strict !== undefined && { strict }),
          ...(strictness !== undefined && { strictness }),
          ...(disableRecency !== undefined && { disableRecency }),
          ...(includeRelated !== undefined && { includeRelated }),
          ...(topicPrefix !== undefined && { topicPrefix }),
          ...(minLexicalSupport !== undefined && { minLexicalSupport }),
          ...(diagnostics !== undefined && { diagnostics }),
        });
        // Preserve the failure signal — collapsing a null/invalid suggest
        // response to [] would make callers unable to distinguish "no matches"
        // from "search pipeline failed". Mirror the standalone handler's
        // suggest_returned_null code so behavior stays consistent across
        // transports.
        if (!suggestResult || typeof suggestResult !== 'object') {
          return {
            success: false,
            code: 'suggest_returned_null',
            count: 0,
            results: [],
            message: 'Search failed: suggest() returned no result for query',
          };
        }
        // Forward explicit { success: false, code, error } failures from
        // mama.suggest() unchanged so callers see the real cause instead of
        // a synthetic empty success.
        if (suggestResult.success === false) {
          const hasOwn = Object.prototype.hasOwnProperty;
          const forwarded = {
            ...suggestResult,
            success: false,
            code: suggestResult.code || 'suggest_failed',
          };
          if (!hasOwn.call(forwarded, 'count')) {
            forwarded.count = 0;
          }
          if (!hasOwn.call(forwarded, 'results')) {
            forwarded.results = [];
          }
          if (!hasOwn.call(forwarded, 'message')) {
            forwarded.message = suggestResult.error || 'Search pipeline failed';
          }
          return forwarded;
        }
        searchDiagnostics = suggestResult.diagnostics;
        searchMeta = suggestResult.meta;
        decisions = Array.isArray(suggestResult.results) ? suggestResult.results : [];
      } else {
        decisions = await mama.list({
          limit,
          ...(scopes && { scopes }),
          ...(topicPrefix !== undefined && { topicPrefix }),
        });
      }
      if (Array.isArray(decisions)) {
        results.push(
          ...decisions.map((d) => ({
            ...d,
            _type: 'decision',
          }))
        );
      }
    }

    // mama.listCheckpoints() does not yet honor the scopes filter, so any
    // checkpoint read with scopes provided would silently bypass scope
    // isolation. Reject explicitly when the caller requested scopes — for
    // type='checkpoint' this fails the whole search; for type='all' we let
    // decisions (which DO honor scopes via mama.suggest/list) return alone
    // and skip the checkpoint blocks below.
    const checkpointReadsBlockedByScope = Array.isArray(scopes) && scopes.length > 0;
    if (checkpointReadsBlockedByScope && type === 'checkpoint') {
      return {
        success: false,
        code: 'scoped_checkpoint_unsupported',
        count: 0,
        results: [],
        message: 'Scoped checkpoint reads are not supported yet',
      };
    }

    // Search checkpoints (with query = search, without = handled above as load)
    if ((type === 'all' || type === 'checkpoint') && query && !checkpointReadsBlockedByScope) {
      const checkpoints = await mama.listCheckpoints(limit);
      results.push(
        ...checkpoints
          .filter((c) => c.summary && c.summary.toLowerCase().includes(query.toLowerCase()))
          .map((c) => ({
            id: `checkpoint_${c.id}`,
            summary: c.summary,
            next_steps: c.next_steps,
            created_at: c.timestamp,
            _type: 'checkpoint',
          }))
      );
    }

    // type='all' without query — include recent checkpoints
    if (type === 'all' && !query && !checkpointReadsBlockedByScope) {
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
      ...(query ? { query } : {}),
      count: limited.length,
      results: limited,
      ...(searchDiagnostics !== undefined ? { diagnostics: searchDiagnostics } : {}),
      ...(searchMeta !== undefined ? { meta: searchMeta } : {}),
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

  async handleLink(args) {
    const { from, to, relation, reason } = args;
    if (!from || !to || !relation || !reason) {
      return { success: false, message: '❌ Link requires: from, to, relation, reason' };
    }
    const receipt = await mama.link({ from, to, relation, reason });
    return { success: true, ...receipt };
  }

  async handleGetDecision(args) {
    if (!args.id) {
      return { success: false, message: '❌ get_decision requires: id' };
    }
    const decision = await mama.getDecision(args.id);
    if (!decision) {
      return { success: false, message: `❌ Decision not found: ${args.id}` };
    }
    return { success: true, decision };
  }

  async start() {
    try {
      validateEnvironment();

      // Initialize database
      console.error('[MAMA MCP] Initializing database...');
      await initDB();
      console.error('[MAMA MCP] Database initialized');

      // Start the stdio MCP server.
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

module.exports = { MAMAServer, validateEnvironment };
