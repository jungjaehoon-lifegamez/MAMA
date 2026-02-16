/**
 * MAMA OpenClaw Plugin - Direct Gateway Integration
 *
 * NO HTTP/REST - Embeds MAMA logic directly into the Gateway
 * Vector search via better-sqlite3 + sqlite-vec
 *
 * Features:
 * - 4 native tools: mama_search, mama_save, mama_load_checkpoint, mama_update
 * - Auto-recall: Semantic search based on user prompt at agent start
 * - Auto-capture: Auto-save important decisions at agent end
 */

import { Type, type Static } from '@sinclair/typebox';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import path from 'node:path';
import os from 'node:os';
import {
  truncateText,
  isRecord,
  getStringField,
  getErrorMessage,
  formatReasoning,
  isRecentCheckpoint,
} from './utils';

// MAMA module path - resolve from workspace dependency
const MAMA_MODULE_PATH = path.dirname(require.resolve('@jungjaehoon/mama-core/mama-api'));

// MAMA API interface for type safety (matching actual mama-api.js implementation)
interface MAMAApi {
  suggest(
    query: string,
    options: { limit: number; threshold: number }
  ): Promise<MAMASuggestResult | null>;
  save(params: {
    topic: string;
    decision: string;
    reasoning: string;
    confidence: number;
    type: string;
  }): Promise<MAMASaveResult>;
  saveCheckpoint(summary: string, files: string[], nextSteps: string): Promise<number>;
  loadCheckpoint(): Promise<MAMACheckpoint | null>;
  list(options: { limit: number }): Promise<MAMADecision[]>;
  updateOutcome(
    id: string,
    options: { outcome: string; failure_reason?: string; limitation?: string }
  ): Promise<void>;
}

interface MAMASaveResult {
  success: boolean;
  id: string;
  similar_decisions?: MAMADecision[];
  warning?: string;
  collaboration_hint?: string;
  reasoning_graph?: unknown;
}

interface MAMASuggestResult {
  query: string;
  results: MAMADecision[];
}

interface MAMADecision {
  id: string;
  topic: string;
  decision: string;
  reasoning: string;
  confidence?: number;
  outcome?: string;
  similarity?: number;
  created_at?: string;
  recency_score?: number;
  recency_age_days?: number;
  final_score?: number;
}

interface MAMACheckpoint {
  id: number;
  summary: string;
  next_steps?: string;
  timestamp: string;
}

// Plugin config schema
const pluginConfigSchema = Type.Object({
  dbPath: Type.Optional(
    Type.String({
      description: 'Path to MAMA SQLite database. Defaults to ~/.claude/mama-memory.db',
    })
  ),
});

// Derive PluginConfig from schema for type safety
type PluginConfig = Static<typeof pluginConfigSchema>;

// Singleton state
let initialized = false;
let mama: MAMAApi | null = null;
let initialDbPath: string | null = null;

// Compaction tracking flag (module-level for cross-hook communication)
let compactionOccurred = false;

// Session-level state for more useful auto-checkpoints
let sessionStartedAt: string | null = null;
let lastUserPrompt: string | null = null;
let lastCompactionAt: string | null = null;
let lastAutoCaptureCandidates: string[] = [];

/**
 * Get MAMA API with null guard
 * @throws Error if MAMA is not initialized
 */
function getMAMA(): MAMAApi {
  if (!mama) {
    throw new Error('MAMA not initialized. Call initMAMA() first.');
  }
  return mama;
}

/**
 * Initialize MAMA (lazy, once)
 */
async function initMAMA(config?: PluginConfig): Promise<void> {
  // Set DB path from config or environment or default
  const dbPath =
    config?.dbPath || process.env.MAMA_DB_PATH || path.join(os.homedir(), '.claude/mama-memory.db');

  // Warn if re-initialized with different config
  if (initialized) {
    if (initialDbPath && dbPath !== initialDbPath) {
      console.warn(
        `[MAMA Plugin] Warning: initMAMA called with different dbPath (${dbPath}) after initialization with (${initialDbPath}). Using original path.`
      );
    }
    return;
  }

  process.env.MAMA_DB_PATH = dbPath;

  try {
    // Load mama-api (high-level API)
    mama = require(path.join(MAMA_MODULE_PATH, 'mama-api.js'));

    // Initialize database via memory-store
    const memoryStore = require(path.join(MAMA_MODULE_PATH, 'memory-store.js'));
    await memoryStore.initDB();

    initialized = true;
    initialDbPath = dbPath;
    console.log(`[MAMA Plugin] Initialized with direct module integration (db: ${dbPath})`);
  } catch (err: unknown) {
    const msg = getErrorMessage(err);
    console.error('[MAMA Plugin] Init failed:', msg);
    throw err instanceof Error ? err : new Error(msg);
  }
}

/**
 * MAMA OpenClaw Plugin definition.
 * Provides semantic decision memory with auto-recall and auto-capture features.
 */
const mamaPlugin = {
  id: 'openclaw-mama',
  name: 'MAMA Memory',
  description: 'Semantic decision memory - Direct Gateway integration (no HTTP)',
  kind: 'memory' as const,
  configSchema: pluginConfigSchema,

  /**
   * Register MAMA plugin with OpenClaw Gateway.
   * Sets up auto-recall, auto-capture, and native MCP tools.
   * @param api - OpenClaw plugin API for event registration and tool creation
   */
  register(api: OpenClawPluginApi) {
    // Get plugin config (config property may be available depending on SDK version)
    const config: PluginConfig | undefined =
      'config' in api ? (api as { config?: PluginConfig }).config : undefined;

    // =====================================================
    // Session Start: Initialize and load checkpoint
    // =====================================================
    api.on('session_start', async (_event: unknown) => {
      try {
        await initMAMA(config);
        sessionStartedAt = new Date().toISOString();
        lastUserPrompt = null;
        lastCompactionAt = null;
        lastAutoCaptureCandidates = [];
        compactionOccurred = false;

        // 1. Load checkpoint
        const checkpoint = await getMAMA().loadCheckpoint();

        // 2. Load recent decisions
        const recentDecisions = await getMAMA().list({ limit: 5 });

        // 3. Console log (void hook - cannot return context)
        if (checkpoint) {
          console.log(`[MAMA] Session start: Loaded checkpoint from ${checkpoint.timestamp}`);
        }
        if (recentDecisions.length > 0) {
          console.log(`[MAMA] Session start: ${recentDecisions.length} recent decisions available`);
        }
      } catch (err: unknown) {
        console.error('[MAMA] Session start error:', getErrorMessage(err));
      }
    });

    // =====================================================
    // Auto-recall: Semantic search based on user prompt
    // =====================================================
    api.on('before_agent_start', async (event: unknown) => {
      try {
        await initMAMA(config);

        let userPrompt = '';
        if (isRecord(event)) {
          userPrompt = getStringField(event, 'prompt') ?? '';
        }
        lastUserPrompt = userPrompt ? truncateText(userPrompt, 200) : null;

        const mamaApi = getMAMA();

        // 1. Perform semantic search if user prompt exists
        let semanticResults: MAMADecision[] = [];
        if (userPrompt && userPrompt.length >= 5) {
          try {
            const searchResult = await mamaApi.suggest(userPrompt, { limit: 3, threshold: 0.5 });
            semanticResults = searchResult?.results || [];
          } catch (searchErr: unknown) {
            console.error('[MAMA] Semantic search error:', getErrorMessage(searchErr));
          }
        }

        // 2. Load latest checkpoint
        const checkpoint = await mamaApi.loadCheckpoint();

        // 3. Load recent decisions (only when no semantic search results)
        let recentDecisions: MAMADecision[] = [];
        if (semanticResults.length === 0) {
          recentDecisions = await mamaApi.list({ limit: 3 });
        }

        // 4. Compaction note if context was recently compressed
        let compactionNote = '';
        if (compactionOccurred) {
          compactionNote =
            '\n**Note:** Context was recently compressed. Above memories help restore state.\n';
          compactionOccurred = false;
        }

        // 5. Inject context if available
        if (checkpoint || semanticResults.length > 0 || recentDecisions.length > 0) {
          let content = '<relevant-memories>\n';
          content += '# MAMA Memory Context\n\n';

          if (semanticResults.length > 0) {
            content += '## Relevant Decisions (semantic match)\n\n';
            semanticResults.forEach((r) => {
              const pct = Math.round((r.similarity || 0) * 100);
              content += `- **${r.topic}** [${pct}%]: ${r.decision}`;
              if (r.outcome) content += ` (${r.outcome})`;
              content += `\n  _${formatReasoning(r.reasoning, 100)}_\n`;
              content += `  ID: \`${r.id}\`\n`;
            });
            content += '\n';
          }

          if (checkpoint) {
            content += `## Last Checkpoint (${new Date(checkpoint.timestamp).toISOString()})\n\n`;
            content += `**Summary:** ${checkpoint.summary}\n\n`;
            if (checkpoint.next_steps) {
              content += `**Next Steps:** ${checkpoint.next_steps}\n\n`;
            }
          }

          if (recentDecisions.length > 0) {
            content += '## Recent Decisions\n\n';
            recentDecisions.forEach((d) => {
              content += `- **${d.topic}**: ${d.decision}`;
              if (d.outcome) content += ` (${d.outcome})`;
              content += '\n';
            });
            content += '\n';
          }

          // Add compaction note if applicable
          if (compactionNote) {
            content += compactionNote;
          }

          content += '</relevant-memories>';

          console.log(
            `[MAMA] Auto-recall: ${semanticResults.length} semantic matches, ${recentDecisions.length} recent, checkpoint: ${!!checkpoint}${compactionNote ? ', post-compaction' : ''}`
          );

          return {
            prependContext: content,
          };
        }
      } catch (err: unknown) {
        console.error('[MAMA] Auto-recall error:', getErrorMessage(err));
      }
    });

    // =====================================================
    // Auto-capture: Auto-save decisions at agent end
    // =====================================================
    api.on('agent_end', async (event: unknown) => {
      if (!isRecord(event)) {
        return;
      }

      const success = event.success === true;
      const messages = Array.isArray(event.messages) ? event.messages : [];
      if (!success || messages.length === 0) {
        return;
      }

      try {
        await initMAMA(config);

        // Extract text from messages
        const texts: string[] = [];
        for (const msg of messages) {
          if (!isRecord(msg)) continue;

          const role = msg.role;
          if (role !== 'user' && role !== 'assistant') continue;

          const content = msg.content;
          if (typeof content === 'string') {
            texts.push(content);
          } else if (Array.isArray(content)) {
            for (const block of content) {
              if (!isRecord(block)) continue;
              if (block.type === 'text' && typeof block.text === 'string') {
                texts.push(block.text);
              }
            }
          }
        }

        // Detect decision patterns
        const decisionPatterns = [
          /decided|결정|선택|chose|use.*instead|going with/i,
          /will use|사용할|approach|방식|strategy/i,
          /remember|기억|learned|배웠|lesson/i,
        ];

        for (const text of texts) {
          // Skip short or injected content
          if (text.length < 20 || text.length > 500) continue;
          if (text.includes('<relevant-memories>')) continue;
          if (text.startsWith('<') && text.includes('</')) continue;

          // Check if it matches decision patterns
          const isDecision = decisionPatterns.some((p) => p.test(text));
          if (!isDecision) continue;

          // Auto-save detected decision (logged only, not actually saved without explicit topic)
          const candidate = truncateText(text, 160);
          if (!lastAutoCaptureCandidates.includes(candidate)) {
            lastAutoCaptureCandidates = [candidate, ...lastAutoCaptureCandidates].slice(0, 3);
          }
          console.log(`[MAMA] Auto-capture candidate: ${candidate}`);
          // Note: Actual save requires an explicit topic, so only logging for now
          // Future: Add topic extraction via LLM
        }
      } catch (err: unknown) {
        console.error('[MAMA] Auto-capture error:', getErrorMessage(err));
      }
    });

    // =====================================================
    // Session End: Auto-save checkpoint
    // =====================================================
    api.on('session_end', async (_event: unknown) => {
      try {
        await initMAMA(config);

        // Check if recent checkpoint exists (avoid noisy auto-saves)
        const existingCheckpoint = await getMAMA().loadCheckpoint();

        if (existingCheckpoint && isRecentCheckpoint(existingCheckpoint.timestamp)) {
          console.log('[MAMA] Session end: Skipping auto-save (recent checkpoint exists)');
          return;
        }

        // Load session metrics for meaningful checkpoint
        const endedAt = new Date().toISOString();
        const recentDecisions = await getMAMA().list({ limit: 10 });
        const decisionCount = recentDecisions.length;
        const recentTopics = recentDecisions
          .map((d) => d.topic)
          .filter((t) => typeof t === 'string' && t.trim().length > 0)
          .slice(0, 5);

        const summaryParts: string[] = [`Session ended: ${endedAt}`];
        if (sessionStartedAt) {
          summaryParts.push(`Session started: ${sessionStartedAt}`);
        }
        if (lastUserPrompt) {
          summaryParts.push(`Last user prompt: ${lastUserPrompt}`);
        }
        if (lastCompactionAt) {
          summaryParts.push(`Last compaction: ${lastCompactionAt}`);
        }
        summaryParts.push(`Decisions recorded (recent): ${decisionCount}`);
        if (recentTopics.length > 0) {
          summaryParts.push(`Recent topics: ${recentTopics.join(', ')}`);
        }

        const nextStepsParts: string[] = [];
        if (lastAutoCaptureCandidates.length > 0) {
          nextStepsParts.push(
            `Review auto-capture candidates:\n- ${lastAutoCaptureCandidates.join('\n- ')}`
          );
        }
        if (decisionCount > 0) {
          nextStepsParts.push(
            `Review recent decisions (count: ${decisionCount}). Last topic: ${
              recentDecisions[0]?.topic || 'unknown'
            }`
          );
        } else {
          nextStepsParts.push('No new decisions recorded in this session.');
        }
        nextStepsParts.push(
          'On next session start: load checkpoint and continue from the last prompt.'
        );

        const summary = summaryParts.join('\n');
        const nextSteps = nextStepsParts.join('\n\n');

        const checkpointId = await getMAMA().saveCheckpoint(
          summary,
          [], // openFiles - session_end doesn't have file info
          nextSteps
        );

        console.log(
          `[MAMA] Session end: Auto-saved checkpoint (id: ${checkpointId}, decisions: ${decisionCount})`
        );
      } catch (err: unknown) {
        console.error('[MAMA] Session end error:', getErrorMessage(err));
      }
    });

    // =====================================================
    // Before Compaction: Save checkpoint before context compression
    // =====================================================
    api.on('before_compaction', async (_event: unknown) => {
      try {
        await initMAMA(config);

        // Save checkpoint before compaction
        const now = new Date().toISOString();
        lastCompactionAt = now;
        const summary = `Pre-compaction checkpoint: ${now}. Context will be compressed.`;
        const checkpointId = await getMAMA().saveCheckpoint(
          summary,
          [],
          'Resume after compaction - check previous context'
        );

        // Set flag for post-compaction context enhancement
        compactionOccurred = true;

        console.log(`[MAMA] Before compaction: Saved checkpoint (id: ${checkpointId})`);
      } catch (err: unknown) {
        console.error('[MAMA] Before compaction error:', getErrorMessage(err));
      }
    });

    // =====================================================
    // After Compaction: Log state and prepare for context re-injection
    // =====================================================
    api.on('after_compaction', async (_event: unknown) => {
      try {
        await initMAMA(config);

        // 1. Load checkpoint
        const checkpoint = await getMAMA().loadCheckpoint();

        // 2. Load recent decisions (for context recovery)
        const recentDecisions = await getMAMA().list({ limit: 5 });

        // 3. Log (void hook - cannot inject directly, before_agent_start handles it)
        console.log('[MAMA] After compaction: Context compressed');
        if (checkpoint) {
          console.log(`[MAMA] Checkpoint available: ${checkpoint.summary?.substring(0, 50)}...`);
        }
        if (recentDecisions.length > 0) {
          console.log(`[MAMA] ${recentDecisions.length} recent decisions ready for re-injection`);
        }

        // Note: compactionOccurred flag set in before_compaction
        // before_agent_start will detect this and add context enhancement
      } catch (err: unknown) {
        console.error('[MAMA] After compaction error:', getErrorMessage(err));
      }
    });

    // =====================================================
    // mama_search - Semantic memory search
    // =====================================================
    api.registerTool({
      name: 'mama_search',
      description: `Search semantic memory for relevant past decisions.

⚠️ **TRIGGERS - Call this BEFORE:**
• Making architectural choices (check prior art)
• Calling mama_save (find links first!)
• Debugging (find past failures on similar issues)
• Starting work on a topic (load context)

**Returns:** Decisions ranked by semantic similarity with:
- Topic, decision, reasoning
- Similarity score (0-100%)
- Decision ID (for linking/updating)

**High similarity (>80%) = MUST link with builds_on/debates/synthesizes**

**Example queries:** "authentication", "database choice", "error handling"`,

      parameters: Type.Object({
        query: Type.String({
          description: 'Search query - topic, question, or keywords',
        }),
        limit: Type.Optional(
          Type.Number({
            description: 'Max results (default: 5)',
          })
        ),
      }),

      async execute(_id: string, params: Record<string, unknown>) {
        try {
          await initMAMA(config);

          const query = String(params.query || '').trim();
          if (!query) {
            return { content: [{ type: 'text', text: 'Error: query required' }] };
          }

          const limit = Math.min(Number(params.limit) || 5, 20);

          // Use mama.suggest() for semantic search
          const result = await getMAMA().suggest(query, { limit, threshold: 0.5 });

          if (!result?.results?.length) {
            return {
              content: [
                {
                  type: 'text',
                  text: `No decisions found for "${query}". This may be a new topic.`,
                },
              ],
            };
          }

          // Format output
          let output = `Found ${result.results.length} related decisions:\n\n`;
          result.results.forEach((r, idx) => {
            const pct = Math.round((r.similarity || 0) * 100);
            output += `**${idx + 1}. ${r.topic}** [${pct}% match]\n`;
            output += `   Decision: ${r.decision}\n`;
            output += `   Reasoning: ${formatReasoning(r.reasoning, 150)}\n`;
            output += `   ID: \`${r.id}\` | Outcome: ${r.outcome || 'pending'}\n\n`;
          });

          return { content: [{ type: 'text', text: output }] };
        } catch (err: unknown) {
          return { content: [{ type: 'text', text: `MAMA error: ${getErrorMessage(err)}` }] };
        }
      },
    });

    // =====================================================
    // mama_save - Save decision or checkpoint
    // =====================================================
    api.registerTool({
      name: 'mama_save',
      description: `Save a decision or checkpoint to semantic memory.

⚠️ **REQUIRED WORKFLOW (Don't create orphans!):**
1. Call mama_search FIRST to find related decisions
2. Check if same topic exists (yours will supersede it)
3. MUST include link in reasoning/summary field

**DECISION - Use when:**
- Making architectural choices
- Learning a lesson (success or failure)
- Establishing a pattern/convention
- Choosing between alternatives

**CHECKPOINT - Use when:**
- Ending a session (save state)
- Reaching a milestone
- Before switching tasks

**Link decisions:** End reasoning with 'builds_on: <id>' or 'debates: <id>' or 'synthesizes: [id1, id2]'`,

      parameters: Type.Object({
        type: Type.Union([Type.Literal('decision'), Type.Literal('checkpoint')], {
          description: "'decision' or 'checkpoint'",
        }),

        topic: Type.Optional(
          Type.String({
            description: "[Decision] Topic ID e.g. 'auth_strategy'",
          })
        ),
        decision: Type.Optional(
          Type.String({
            description: "[Decision] The decision e.g. 'Use JWT with refresh tokens'",
          })
        ),
        reasoning: Type.Optional(
          Type.String({
            description: "[Decision] Why. End with 'builds_on: <id>' to link.",
          })
        ),
        confidence: Type.Optional(
          Type.Number({
            description: '[Decision] 0.0-1.0 (default: 0.8)',
          })
        ),

        summary: Type.Optional(
          Type.String({
            description: '[Checkpoint] What was accomplished',
          })
        ),
        next_steps: Type.Optional(
          Type.String({
            description: '[Checkpoint] What to do next',
          })
        ),
      }),

      async execute(_id: string, params: Record<string, unknown>) {
        try {
          await initMAMA(config);

          const saveType = String(params.type);

          if (saveType === 'checkpoint') {
            const summary = String(params.summary || '');
            if (!summary) {
              return {
                content: [{ type: 'text', text: 'Error: summary required for checkpoint' }],
              };
            }

            // mama.saveCheckpoint returns lastInsertRowid directly (not {id: ...})
            const checkpointId = await getMAMA().saveCheckpoint(
              summary,
              [],
              String(params.next_steps || '')
            );

            return {
              content: [{ type: 'text', text: `Checkpoint saved (id: ${checkpointId})` }],
            };
          }

          // Decision - use mama.save()
          const topic = String(params.topic || '');
          const decision = String(params.decision || '');
          const reasoning = String(params.reasoning || '');

          if (!topic || !decision || !reasoning) {
            return {
              content: [
                { type: 'text', text: 'Error: topic, decision, and reasoning all required' },
              ],
            };
          }

          const confidence = Number(params.confidence) || 0.8;

          // Use mama.save() API
          const result = await getMAMA().save({
            topic,
            decision,
            reasoning,
            confidence,
            type: 'assistant_insight',
          });

          // result contains: { id, similar_decisions, warning, collaboration_hint }
          let msg = `Decision saved (id: ${result.id})`;
          if (result.warning) {
            msg += `\n⚠️ ${result.warning}`;
          }
          if (result.collaboration_hint) {
            msg += `\n💡 ${result.collaboration_hint}`;
          }

          return { content: [{ type: 'text', text: msg }] };
        } catch (err: unknown) {
          return { content: [{ type: 'text', text: `MAMA error: ${getErrorMessage(err)}` }] };
        }
      },
    });

    // =====================================================
    // mama_load_checkpoint - Load checkpoint
    // =====================================================
    api.registerTool({
      name: 'mama_load_checkpoint',
      description: `Load latest checkpoint to resume previous session.

**Use at session start to:**
- Restore previous context
- See where you left off
- Get planned next steps

Also returns recent decisions for context.`,

      parameters: Type.Object({}),

      async execute(_id: string, _params: Record<string, unknown>) {
        try {
          await initMAMA(config);

          // Use mama.loadCheckpoint() and mama.list()
          const checkpoint = await getMAMA().loadCheckpoint();
          // list() returns MAMADecision[] directly
          const recent = await getMAMA().list({ limit: 5 });

          if (!checkpoint) {
            let msg = 'No checkpoint found - fresh start.';
            if (recent?.length) {
              msg += '\n\nRecent decisions:\n';
              recent.forEach((d) => {
                msg += `- ${d.topic}: ${d.decision}\n`;
              });
            }
            return { content: [{ type: 'text', text: msg }] };
          }

          let msg = `**Checkpoint** (${new Date(checkpoint.timestamp).toISOString()})\n\n`;
          msg += `**Summary:**\n${checkpoint.summary}\n\n`;

          if (checkpoint.next_steps) {
            msg += `**Next Steps:**\n${checkpoint.next_steps}\n\n`;
          }

          if (recent?.length) {
            msg += `**Recent Decisions:**\n`;
            recent.forEach((d) => {
              msg += `- **${d.topic}**: ${d.decision} (${d.outcome || 'pending'})\n`;
            });
          }

          return { content: [{ type: 'text', text: msg }] };
        } catch (err: unknown) {
          return { content: [{ type: 'text', text: `MAMA error: ${getErrorMessage(err)}` }] };
        }
      },
    });

    // =====================================================
    // mama_update - Update outcome
    // =====================================================
    api.registerTool({
      name: 'mama_update',
      description: `Update outcome of a previous decision.

**Use when you learn if a decision worked:**
- SUCCESS: Worked well
- FAILED: Didn't work (include reason)
- PARTIAL: Partially worked

Helps future sessions learn from experience.`,

      parameters: Type.Object({
        id: Type.String({ description: 'Decision ID to update' }),
        outcome: Type.Union([
          Type.Literal('success'),
          Type.Literal('failed'),
          Type.Literal('partial'),
        ]),
        reason: Type.Optional(
          Type.String({
            description: 'Why it succeeded/failed/partial',
          })
        ),
      }),

      async execute(_id: string, params: Record<string, unknown>) {
        try {
          await initMAMA(config);

          const decisionId = String(params.id || '');
          const outcome = String(params.outcome || '').toUpperCase();
          const reason = String(params.reason || '');

          if (!decisionId || !outcome) {
            return { content: [{ type: 'text', text: 'Error: id and outcome required' }] };
          }

          // mama.updateOutcome(id, { outcome, failure_reason, limitation })
          await getMAMA().updateOutcome(decisionId, {
            outcome,
            failure_reason: outcome === 'FAILED' ? reason : undefined,
            limitation: outcome === 'PARTIAL' ? reason : undefined,
          });

          return {
            content: [{ type: 'text', text: `Decision ${decisionId} updated to ${outcome}` }],
          };
        } catch (err: unknown) {
          return { content: [{ type: 'text', text: `MAMA error: ${getErrorMessage(err)}` }] };
        }
      },
    });
  },
};

export default mamaPlugin;
