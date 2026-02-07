/**
 * MAMA Core Adapter for Swarm Task Runner
 *
 * Connects SwarmTaskRunner to mama-core for context injection
 * using direct import instead of HTTP API.
 *
 * @module swarm-mama-adapter
 * @version 1.0
 */

import type { MamaApiClient, SearchResult } from '../../gateways/context-injector.js';

/**
 * mama-core suggest() result format
 */
interface MamaSuggestResult {
  query: string;
  results: Array<{
    id: string;
    topic?: string;
    decision?: string;
    reasoning?: string;
    outcome?: string;
    similarity: number;
    created_at?: string;
  }>;
  meta?: {
    searchMethod?: string;
    totalResults?: number;
    threshold?: number;
  };
  graph?: unknown;
}

/**
 * Create a MamaApiClient that uses mama-core directly
 *
 * @returns MamaApiClient implementation
 */
export function createMamaApiAdapter(): MamaApiClient {
  return {
    async search(query: string, limit?: number): Promise<SearchResult[]> {
      try {
        // Dynamically require mama-core (CommonJS module)
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mama = require('@jungjaehoon/mama-core/mama-api');

        if (!mama || !mama.suggest) {
          console.warn('[SwarmMamaAdapter] mama-core suggest() not available');
          return [];
        }

        // Call mama-core suggest()
        const result: MamaSuggestResult = await mama.suggest(query, {
          format: 'json',
          limit: limit || 5,
          threshold: 0.6,
          useReranking: false,
        });

        // Handle null/empty result
        if (!result || !result.results) {
          console.log('[SwarmMamaAdapter] suggest() returned no results');
          return [];
        }

        // Convert mama-core format to SearchResult[]
        const searchResults: SearchResult[] = result.results.map((r) => ({
          id: r.id,
          topic: r.topic,
          decision: r.decision,
          reasoning: r.reasoning,
          outcome: r.outcome,
          similarity: r.similarity,
        }));

        console.log(
          `[SwarmMamaAdapter] Found ${searchResults.length} results for query: "${query.substring(0, 50)}..."`
        );

        return searchResults;
      } catch (error) {
        // Graceful fallback - log error but don't throw
        console.warn('[SwarmMamaAdapter] Failed to search MAMA:', error);
        return [];
      }
    },
  };
}

/**
 * Save swarm checkpoint to MAMA (F6)
 *
 * @param sessionId - Swarm session ID
 * @param summary - Checkpoint summary
 * @param openFiles - Files being worked on (optional)
 * @param nextSteps - Next steps description (optional)
 */
export async function saveSwarmCheckpoint(
  sessionId: string,
  summary: string,
  openFiles?: string[],
  nextSteps?: string
): Promise<void> {
  try {
    // Dynamically require mama-core (CommonJS module)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mama = require('@jungjaehoon/mama-core/mama-api');

    if (!mama || !mama.saveCheckpoint) {
      console.warn('[SwarmMamaAdapter] mama.saveCheckpoint() not available');
      return;
    }

    // Call mama-core saveCheckpoint()
    await mama.saveCheckpoint(summary, openFiles || [], nextSteps || '', []);

    console.log(
      `[SwarmMamaAdapter] Saved checkpoint for session ${sessionId}: ${summary.substring(0, 60)}...`
    );
  } catch (error) {
    // Graceful fallback - log error but don't throw
    console.warn('[SwarmMamaAdapter] Failed to save checkpoint:', error);
  }
}
