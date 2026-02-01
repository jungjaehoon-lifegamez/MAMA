/**
 * Context Injector for proactive decision retrieval
 *
 * Searches MAMA's decision graph for relevant context
 * and formats it for injection into system prompts.
 */

import type { RelatedDecision, MessageRouterConfig } from './types.js';

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
    this.similarityThreshold = config.similarityThreshold ?? 0.7;
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
      const results = await this.mamaApi.search(query, this.maxDecisions + 2);

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
    const sections = decisions.map((d) => {
      let section = `### ${d.topic}\n`;
      section += `- **Decision:** ${d.decision}\n`;

      if (d.reasoning) {
        section += `- **Reasoning:** ${d.reasoning}\n`;
      }

      section += `- **Outcome:** ${d.outcome || 'pending'}\n`;
      section += `- **Relevance:** ${Math.round(d.similarity * 100)}%`;

      return section;
    });

    return `
## Related decisions from your memory:

${sections.join('\n\n')}

Consider these previous decisions when responding. Reference them if relevant.
`;
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
}

/**
 * Create a mock MAMA API client for testing
 */
export function createMockMamaApi(decisions: SearchResult[] = []): MamaApiClient {
  return {
    async search(_query: string, limit?: number): Promise<SearchResult[]> {
      return decisions.slice(0, limit || decisions.length);
    },
  };
}
