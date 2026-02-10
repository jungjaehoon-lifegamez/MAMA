/**
 * Auto-Recall Module for MAMA Standalone
 *
 * Ported from OpenClaw plugin's auto-recall logic to standalone.
 * Automatically searches related memories before agent start and injects into context.
 *
 * Features:
 * - Prompt-based semantic search
 * - Recent checkpoint loading
 * - Related decision context injection
 */

import path from 'node:path';
import os from 'node:os';

// MAMA API interface (same as mama-server's mama-api.js)
interface MAMADecision {
  id: string;
  topic: string;
  decision: string;
  reasoning: string;
  confidence?: number;
  outcome?: string;
  similarity?: number;
  created_at?: string;
}

interface MAMACheckpoint {
  id: number;
  summary: string;
  next_steps?: string;
  timestamp: string;
}

interface MAMASuggestResult {
  query: string;
  results: MAMADecision[];
}

// Singleton state
let initialized = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mamaApi: any = null;

/**
 * Format reasoning with link extraction (reused from OpenClaw logic)
 */
function formatReasoning(reasoning: string, maxLen: number = 80): string {
  if (!reasoning) return '';

  // Extract link patterns
  const linkMatch = reasoning.match(/(builds_on|debates|synthesizes):\s*[\w[\],\s_-]+/i);

  // Truncate main reasoning
  const truncated = reasoning.length > maxLen ? reasoning.substring(0, maxLen) + '...' : reasoning;

  // Add link info if found and not already in truncated part
  if (linkMatch && !truncated.includes(linkMatch[0])) {
    return `${truncated}\n  🔗 ${linkMatch[0]}`;
  }

  return truncated;
}

/**
 * Initialize MAMA API (lazy, singleton)
 */
async function initMAMA(dbPath?: string): Promise<void> {
  if (initialized && mamaApi) {
    return;
  }

  const finalDbPath =
    dbPath || process.env.MAMA_DB_PATH || path.join(os.homedir(), '.claude/mama-memory.db');

  process.env.MAMA_DB_PATH = finalDbPath;

  try {
    // Dynamic import of mama-core modules
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mamaApi = require('@jungjaehoon/mama-core/mama-api');

    // Initialize database
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dbManager = require('@jungjaehoon/mama-core/db-manager');
    await dbManager.initDB();

    initialized = true;
    console.log(`[AutoRecall] MAMA initialized (db: ${finalDbPath})`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    console.error('[AutoRecall] MAMA init failed:', err.message);
    // Don't throw - auto-recall should be optional
  }
}

/**
 * Auto-recall result type
 */
export interface AutoRecallResult {
  /** Context string to inject */
  context: string;
  /** Number of semantic search results */
  semanticMatches: number;
  /** Number of recent decisions */
  recentDecisions: number;
  /** Whether a checkpoint exists */
  hasCheckpoint: boolean;
}

/**
 * Execute prompt-based auto-recall
 *
 * Ported from OpenClaw's before_agent_start hook logic to standalone.
 *
 * @param userPrompt - User prompt (used as semantic search query)
 * @param options - Options
 * @returns AutoRecallResult or null (no memories found)
 */
export async function autoRecall(
  userPrompt: string,
  options: {
    dbPath?: string;
    semanticLimit?: number;
    recentLimit?: number;
    threshold?: number;
  } = {}
): Promise<AutoRecallResult | null> {
  try {
    await initMAMA(options.dbPath);

    if (!mamaApi) {
      return null;
    }

    const semanticLimit = options.semanticLimit ?? 3;
    const recentLimit = options.recentLimit ?? 3;
    const threshold = options.threshold ?? 0.5;

    // 1. Semantic search (only when prompt is long enough)
    let semanticResults: MAMADecision[] = [];
    if (userPrompt && userPrompt.length >= 5) {
      try {
        const searchResult: MAMASuggestResult | null = await mamaApi.suggest(userPrompt, {
          limit: semanticLimit,
          threshold,
        });
        semanticResults = searchResult?.results || [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        console.error('[AutoRecall] Semantic search error:', err.message);
      }
    }

    // 2. Load checkpoint
    let checkpoint: MAMACheckpoint | null = null;
    try {
      checkpoint = await mamaApi.loadCheckpoint();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      console.error('[AutoRecall] Checkpoint load error:', err.message);
    }

    // 3. Load recent decisions (only when no semantic results)
    let recentDecisions: MAMADecision[] = [];
    if (semanticResults.length === 0) {
      try {
        recentDecisions = await mamaApi.listDecisions({ limit: recentLimit });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        console.error('[AutoRecall] Recent decisions error:', err.message);
      }
    }

    // 4. Return null if no context found
    if (!checkpoint && semanticResults.length === 0 && recentDecisions.length === 0) {
      return null;
    }

    // 5. Build context string
    let content = '<relevant-memories>\n';
    content += '# MAMA Memory Context\n\n';

    if (semanticResults.length > 0) {
      content += '## Related Decisions (Semantic Match)\n\n';
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
      let ts: string;
      try {
        ts = new Date(checkpoint.timestamp).toISOString();
      } catch {
        ts = String(checkpoint.timestamp);
      }
      content += `## Last Checkpoint (${ts})\n\n`;
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

    content += '</relevant-memories>';

    console.log(
      `[AutoRecall] Found: ${semanticResults.length} semantic, ${recentDecisions.length} recent, checkpoint: ${!!checkpoint}`
    );

    return {
      context: content,
      semanticMatches: semanticResults.length,
      recentDecisions: recentDecisions.length,
      hasCheckpoint: !!checkpoint,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    console.error('[AutoRecall] Error:', err.message);
    return null;
  }
}

/**
 * Direct MAMA API access (advanced usage)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getMAMAApi(): any {
  return mamaApi;
}

/**
 * Check initialization status
 */
export function isInitialized(): boolean {
  return initialized;
}
