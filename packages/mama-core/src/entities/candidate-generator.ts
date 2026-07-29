import type { EntityObservation } from './types.js';

export const ENTITY_EMBEDDING_TOPN = 50;

export interface CandidateGeneratorOptions {
  embeddingScorer?: (left: EntityObservation, right: EntityObservation) => Promise<number>;
  topN?: number;
}

export function dedupeObservationsBySource(observations: EntityObservation[]): EntityObservation[] {
  const seen = new Set<string>();
  const deduped: EntityObservation[] = [];

  for (const observation of observations) {
    const key = JSON.stringify([
      observation.source_connector,
      observation.source_locator ?? `missing-locator:${observation.id}`,
      observation.source_raw_record_id,
      observation.observation_type,
    ]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(observation);
  }

  return deduped;
}
