/**
 * SmartSearch — Haiku-powered reranking of search candidates.
 */

import type { HaikuClient } from './haiku-client.js';
import { warn } from './debug-logger.js';

const RERANK_MIN_CANDIDATES = 3;

const RERANK_PROMPT = `Given a search query and candidate memory results, rerank by relevance.
Consider: query intent, temporal relevance, decision currency (is it still valid?).
Return ONLY a JSON array of indices in order of relevance (most relevant first).
Example: [2, 0, 1] means candidate at index 2 is most relevant.`;

export interface SearchCandidate {
  id: string;
  topic: string;
  decision: string;
  score: number;
  [key: string]: unknown;
}

/**
 * Rerank search candidates using Haiku.
 * Returns original order on any error (graceful degradation).
 */
export async function rerankResults(
  query: string,
  candidates: SearchCandidate[],
  haiku: HaikuClient
): Promise<SearchCandidate[]> {
  if (candidates.length < RERANK_MIN_CANDIDATES) {
    return candidates;
  }

  try {
    const candidateText = candidates
      .map((c, i) => `[${i}] topic: ${c.topic} | decision: ${c.decision}`)
      .join('\n');

    const response = await haiku.complete(
      RERANK_PROMPT,
      `Query: ${query}\n\nCandidates:\n${candidateText}`
    );

    const indices = parseIndices(response, candidates.length);
    if (!indices) return candidates;

    return indices.map((i) => candidates[i]);
  } catch (err) {
    warn(`[SmartSearch] Rerank failed: ${err instanceof Error ? err.message : String(err)}`);
    return candidates;
  }
}

function parseIndices(response: string, maxIndex: number): number[] | null {
  try {
    const match = response.match(/\[[\d,\s]+\]/);
    if (!match) return null;
    const indices = JSON.parse(match[0]) as number[];
    if (!Array.isArray(indices)) return null;
    // Validate all indices are in range
    if (indices.some((i) => typeof i !== 'number' || i < 0 || i >= maxIndex)) return null;
    // Deduplicate
    const unique = [...new Set(indices)];
    // Add any missing indices at the end
    for (let i = 0; i < maxIndex; i++) {
      if (!unique.includes(i)) unique.push(i);
    }
    return unique;
  } catch {
    return null;
  }
}
