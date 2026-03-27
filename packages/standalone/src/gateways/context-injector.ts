/**
 * Context Injector for proactive decision retrieval
 *
 * Searches MAMA's decision graph for relevant context
 * and formats it for injection into system prompts.
 */

import type { RelatedDecision, MessageRouterConfig } from './types.js';

/**
 * Checkpoint data from MAMA
 */
export interface Checkpoint {
  id: number;
  timestamp: number;
  summary: string;
  next_steps?: string;
  open_files?: string[];
}

/**
 * Decision data from MAMA
 */
export interface Decision {
  id: string;
  topic: string;
  decision: string;
  reasoning?: string;
  outcome?: string;
  confidence?: number;
  created_at?: string;
}

/**
 * MAMA API interface for context injection
 *
 * This interface abstracts the MAMA API calls,
 * allowing for easy mocking in tests.
 */
export interface MamaApiClient {
  /**
   * Search for decisions related to a query
   */
  search(query: string, limit?: number): Promise<SearchResult[]>;

  /**
   * Load the last active checkpoint
   */
  loadCheckpoint?(): Promise<Checkpoint | null>;

  /**
   * List recent decisions
   */
  listDecisions?(options?: { limit?: number }): Promise<Decision[]>;

  /**
   * Save a new decision or fact
   */
  save?(input: Record<string, unknown>): Promise<unknown>;

  /**
   * Recall memory v2 bundle
   */
  recallMemory?(
    query: string,
    options?: { scopes?: Array<{ kind: string; id: string }>; includeProfile?: boolean }
  ): Promise<RecallBundle>;

  /**
   * Ingest raw content into memory v2
   */
  ingestMemory?(input: Record<string, unknown>): Promise<unknown>;

  /**
   * Build compact bootstrap packet for memory agents
   */
  buildMemoryBootstrap?(input: {
    scopes: Array<{ kind: string; id: string }>;
    currentGoal?: string;
    mainAgentState?: MemoryAgentBootstrap['main_agent_state'];
  }): Promise<MemoryAgentBootstrap>;

  /**
   * Read the rolling summary for a channel
   */
  getChannelSummary?(channelKey: string): Promise<{
    channel_key: string;
    summary_markdown: string;
    updated_at: number;
  } | null>;

  /**
   * Update the rolling summary for a channel
   */
  upsertChannelSummary?(input: {
    channelKey: string;
    summaryMarkdown: string;
    deltaHash?: string;
  }): Promise<void>;
}

/**
 * Search result from MAMA API
 */
export interface SearchResult {
  id: string;
  topic?: string;
  decision?: string;
  reasoning?: string;
  outcome?: string;
  similarity: number;
}

export interface RecallBundleMemory {
  id: string;
  topic: string;
  summary: string;
  details?: string;
}

export interface RecallBundle {
  profile: {
    static: Array<{ summary: string }>;
    dynamic: Array<{ summary: string }>;
    evidence: Array<{ memory_id: string; topic: string; why_included: string }>;
  };
  memories: RecallBundleMemory[];
  graph_context: {
    primary: RecallBundleMemory[];
    expanded: RecallBundleMemory[];
    edges: Array<{ from_id: string; to_id: string; type: string; reason?: string }>;
  };
  search_meta: {
    query: string;
    scope_order: string[];
    retrieval_sources: string[];
  };
}

export interface MemoryAgentBootstrap {
  current_goal?: string;
  scope_context: Array<{ kind: string; id: string }>;
  truth_snapshot: Array<{ id: string; topic: string; summary: string; trust_score: number }>;
  open_audit_findings: Array<{ id: string; kind: string; severity: string; summary: string }>;
  recent_memory_events: Array<{ id: string; type: string; topic?: string; created_at: number }>;
  profile_snapshot?: {
    static: Array<{ id: string; summary: string }>;
    dynamic: Array<{ id: string; summary: string }>;
  };
  main_agent_state?: {
    active_goal?: string;
    active_channel?: string;
    active_user?: string;
  };
}

/**
 * Context injection result
 */
export interface InjectedContext {
  /** Formatted context string for system prompt */
  prompt: string;
  /** Related decisions that were found */
  decisions: RelatedDecision[];
  /** Whether any relevant context was found */
  hasContext: boolean;
}

/**
 * Context Injector class
 *
 * Retrieves relevant decisions from MAMA memory and formats
 * them for injection into the agent's system prompt.
 */
export class ContextInjector {
  private mamaApi: MamaApiClient;
  private similarityThreshold: number;
  private maxDecisions: number;

  constructor(
    mamaApi: MamaApiClient,
    config: Pick<MessageRouterConfig, 'similarityThreshold' | 'maxDecisions'> = {}
  ) {
    this.mamaApi = mamaApi;
    this.similarityThreshold = config.similarityThreshold ?? 0.85;
    this.maxDecisions = config.maxDecisions ?? 3;
  }

  /**
   * Get relevant context for a user message
   */
  async getRelevantContext(query: string): Promise<InjectedContext> {
    if (!query.trim()) {
      return { prompt: '', decisions: [], hasContext: false };
    }

    try {
      // Debug: console.log(`[ContextInjector] Searching for: "${query.substring(0, 50)}..."`);
      const searchResult = await this.mamaApi.search(query, this.maxDecisions + 2);

      // Handle null/empty result
      if (!searchResult) {
        // Debug logging removed
        return { prompt: '', decisions: [], hasContext: false };
      }

      // mama-core's suggest() returns { query, results, meta, graph } object
      // Extract the actual results array - handle both array and object formats
      let results: SearchResult[];
      if (Array.isArray(searchResult)) {
        results = searchResult;
      } else {
        // Cast to any to access .results property from mama-core's response format
        const responseObj = searchResult as { results?: SearchResult[] };
        results = responseObj.results || [];
      }

      // Filter by similarity threshold
      const relevant = results
        .filter((r) => r.similarity >= this.similarityThreshold)
        .slice(0, this.maxDecisions);

      if (relevant.length === 0) {
        return { prompt: '', decisions: [], hasContext: false };
      }

      // Convert to RelatedDecision format
      const decisions: RelatedDecision[] = relevant.map((r) => ({
        id: r.id,
        topic: r.topic || 'unknown',
        decision: r.decision || '',
        reasoning: r.reasoning,
        outcome: this.parseOutcome(r.outcome),
        similarity: r.similarity,
      }));

      // Format prompt
      const prompt = this.formatPrompt(decisions);

      return { prompt, decisions, hasContext: true };
    } catch (error) {
      // Log error but don't fail - context is optional
      console.error('Failed to get relevant context:', error);
      return { prompt: '', decisions: [], hasContext: false };
    }
  }

  /**
   * Format decisions into a system prompt section
   */
  private formatPrompt(decisions: RelatedDecision[]): string {
    const hints = decisions.map((d) => {
      const pct = Math.round(d.similarity * 100);
      const summary = d.decision.length > 60 ? d.decision.substring(0, 57) + '...' : d.decision;
      return `- ${d.topic} (${pct}%): ${summary}`;
    });

    return `## Prior Decisions (verify before use)\n${hints.join('\n')}`;
  }

  /**
   * Parse outcome string to typed value
   */
  private parseOutcome(outcome?: string): RelatedDecision['outcome'] {
    if (!outcome) return 'pending';

    const lower = outcome.toLowerCase();
    if (lower === 'success') return 'success';
    if (lower === 'failed') return 'failed';
    if (lower === 'partial') return 'partial';
    return 'pending';
  }

  /**
   * Update configuration
   */
  setConfig(config: Pick<MessageRouterConfig, 'similarityThreshold' | 'maxDecisions'>): void {
    if (config.similarityThreshold !== undefined) {
      this.similarityThreshold = config.similarityThreshold;
    }
    if (config.maxDecisions !== undefined) {
      this.maxDecisions = config.maxDecisions;
    }
  }

  /**
   * Get session startup context (equivalent to SessionStart hook)
   * Includes checkpoint, recent decisions, and greeting instructions
   */
  async getSessionStartupContext(input?: { source: string; channelId: string }): Promise<string> {
    try {
      let contextText = '';

      if (input && this.mamaApi.getChannelSummary) {
        const summary = await this.mamaApi.getChannelSummary(`${input.source}:${input.channelId}`);
        if (summary?.summary_markdown) {
          contextText += `\n📝 **Channel Summary**:\n${summary.summary_markdown}\n`;
        }
      }

      // Load checkpoint if available
      if (this.mamaApi.loadCheckpoint) {
        const checkpoint = await this.mamaApi.loadCheckpoint();
        if (checkpoint) {
          const timeAgo = this.formatTimeAgo(Date.now() - checkpoint.timestamp);
          contextText += `\n📍 **Last Checkpoint** (${timeAgo}):\n`;
          contextText += `   ${this.truncate(checkpoint.summary, 80)}\n`;
          if (checkpoint.next_steps) {
            contextText += `   Next: ${this.truncate(checkpoint.next_steps, 60)}\n`;
          }
        }
      }

      // Load recent decisions if available
      if (this.mamaApi.listDecisions) {
        const decisions = await this.mamaApi.listDecisions({ limit: 5 });
        if (decisions && decisions.length > 0) {
          contextText += `\n🧠 **Recent Decisions** (${decisions.length}):\n`;
          decisions.forEach((d, idx) => {
            const createdTime = d.created_at ? new Date(d.created_at).getTime() : NaN;
            const timeAgo = !isNaN(createdTime) ? this.formatTimeAgo(Date.now() - createdTime) : '';
            const outcomeEmoji =
              d.outcome === 'success' ? '✅' : d.outcome === 'failed' ? '❌' : '⏳';
            contextText += `   ${idx + 1}. ${outcomeEmoji} ${d.topic}: ${this.truncate(d.decision, 60)} (${timeAgo})\n`;
          });
        }
      }

      if (!contextText) {
        return '';
      }

      // Add proactive greeting instructions
      return `
🧠 **MAMA Session initialized**
${contextText}

🤖 **PROACTIVE GREETING INSTRUCTION:**
   If the user's first message is a simple greeting ("hi", "hello", "hey") or lacks specific task instructions,
   YOU MUST proactively initiate a contextual conversation:

   1. Greet the user warmly in their language
   2. Summarize what was being worked on from the last checkpoint (if exists)
   3. Highlight 1-2 recent key decisions that might be relevant
   4. Ask if they want to continue previous work or start something new
   5. Suggest specific next steps based on checkpoint's next_steps

💡 **Proactive Partner Mode:**
   Save important decisions without being asked.
   Example: "Let's use PostgreSQL" → save(topic="database_choice", ...)
`;
    } catch (error) {
      console.error('Failed to get session startup context:', error);
      return '';
    }
  }

  /**
   * Format milliseconds to human-readable time ago
   */
  private formatTimeAgo(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return `${seconds}s ago`;
  }

  /**
   * Truncate text to max length
   */
  private truncate(text: string, maxLen: number): string {
    if (!text) return '';
    if (text.length <= maxLen) return text;
    return text.substring(0, maxLen - 3) + '...';
  }
}

/**
 * Create a mock MAMA API client for testing
 */
export function createMockMamaApi(decisions: SearchResult[] = []): MamaApiClient {
  return {
    async search(_query: string, limit?: number): Promise<SearchResult[]> {
      return decisions.slice(0, limit || decisions.length);
    },
    async recallMemory(query: string): Promise<RecallBundle> {
      const memories = decisions.map((decision) => ({
        id: decision.id,
        topic: decision.topic || 'unknown',
        summary: decision.decision || '',
        details: decision.reasoning || '',
      }));

      return {
        profile: {
          static: [{ summary: 'Prefer concise answers' }],
          dynamic: [{ summary: 'Current repo uses pnpm' }],
          evidence: memories.map((memory) => ({
            memory_id: memory.id,
            topic: memory.topic,
            why_included: 'Mocked for test',
          })),
        },
        memories,
        graph_context: {
          primary: memories,
          expanded: [],
          edges: [],
        },
        search_meta: {
          query,
          scope_order: ['project', 'channel', 'user', 'global'],
          retrieval_sources: ['mock'],
        },
      };
    },
    async ingestMemory(input: Record<string, unknown>): Promise<unknown> {
      return {
        success: true,
        id: 'ingested_mock_memory',
        ...input,
      };
    },
    async buildMemoryBootstrap(input): Promise<MemoryAgentBootstrap> {
      return {
        current_goal: input.currentGoal,
        scope_context: input.scopes,
        truth_snapshot: decisions.map((decision) => ({
          id: decision.id,
          topic: decision.topic || 'unknown',
          summary: decision.decision || '',
          trust_score: decision.similarity,
        })),
        open_audit_findings: [],
        recent_memory_events: [],
        profile_snapshot: {
          static: [{ id: 'static_1', summary: 'Prefer concise answers' }],
          dynamic: [{ id: 'dynamic_1', summary: 'Current repo uses pnpm' }],
        },
        main_agent_state: input.mainAgentState,
      };
    },
    async getChannelSummary(channelKey: string) {
      return {
        channel_key: channelKey,
        summary_markdown: '## Channel Summary\n- Current DB direction: PostgreSQL',
        updated_at: Date.now(),
      };
    },
    async upsertChannelSummary() {
      return;
    },
  };
}
