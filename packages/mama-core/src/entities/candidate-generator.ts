import { EmbeddingUnavailableError } from './errors.js';
import { extractStructuredIdentifiers } from './normalization.js';
import type { EntityObservation, EntityResolutionCandidate } from './types.js';

export const ENTITY_EMBEDDING_TOPN = 50;

export interface CandidateGeneratorOptions {
  embeddingScorer?: (left: EntityObservation, right: EntityObservation) => Promise<number>;
  topN?: number;
}

interface ScoredPair {
  left: EntityObservation;
  right: EntityObservation;
  score_structural: number;
  score_string: number;
  score_context: number;
  score_graph: number;
  score_total: number;
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[\s,.!?;:()[\]{}"'/_-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function contextScore(left: EntityObservation, right: EntityObservation): number {
  const leftTokens = new Set(tokenize(left.context_summary ?? ''));
  const rightTokens = new Set(tokenize(right.context_summary ?? ''));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }

  return overlap / Math.max(Math.min(leftTokens.size, rightTokens.size), 1);
}

function structuralScore(left: EntityObservation, right: EntityObservation): number {
  if (left.normalized_form === right.normalized_form) {
    return 1;
  }

  const leftIds = extractStructuredIdentifiers(left.surface_form);
  const rightIds = extractStructuredIdentifiers(right.surface_form);
  const hasSharedEmail = leftIds.emails.some((value) => rightIds.emails.includes(value));
  const hasSharedHandle = leftIds.handles.some((value) => rightIds.handles.includes(value));
  const hasSharedDomain = leftIds.domains.some((value) => rightIds.domains.includes(value));

  if (hasSharedEmail || hasSharedHandle || hasSharedDomain) {
    return 0.75;
  }

  return 0;
}

function stringScore(left: EntityObservation, right: EntityObservation): number {
  if (left.normalized_form === right.normalized_form) {
    return 1;
  }

  const leftText = left.surface_form.toLowerCase();
  const rightText = right.surface_form.toLowerCase();
  const sharedPrefix = leftText.length > 0 && rightText.length > 0 && leftText[0] === rightText[0];
  return sharedPrefix ? 0.1 : 0;
}

function shouldConsiderPair(left: EntityObservation, right: EntityObservation): boolean {
  if (
    left.entity_kind_hint &&
    right.entity_kind_hint &&
    left.entity_kind_hint !== right.entity_kind_hint
  ) {
    return false;
  }

  if (left.scope_kind !== right.scope_kind) {
    return false;
  }

  if (left.scope_id !== right.scope_id) {
    return false;
  }

  return true;
}

function buildBlockKeys(observation: EntityObservation): string[] {
  const keys = new Set<string>();
  keys.add(`norm:${observation.normalized_form}`);
  for (const related of observation.related_surface_forms) {
    keys.add(`related:${related}`);
  }

  const ids = extractStructuredIdentifiers(observation.surface_form);
  for (const email of ids.emails) {
    keys.add(`email:${email}`);
  }
  for (const handle of ids.handles) {
    keys.add(`handle:${handle}`);
  }
  for (const domain of ids.domains) {
    keys.add(`domain:${domain}`);
  }

  const contextTokens = tokenize(observation.context_summary ?? '').slice(0, 3);
  for (const token of contextTokens) {
    keys.add(`ctx:${observation.scope_kind}:${observation.scope_id ?? 'global'}:${token}`);
  }

  return Array.from(keys);
}

export function dedupeObservationsBySource(observations: EntityObservation[]): EntityObservation[] {
  const seen = new Set<string>();
  const deduped: EntityObservation[] = [];

  for (const observation of observations) {
    const key = JSON.stringify([
      observation.source_connector,
      observation.source_raw_db_ref ?? '',
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

export async function generateResolutionCandidates(
  observations: EntityObservation[],
  options: CandidateGeneratorOptions = {}
): Promise<EntityResolutionCandidate[]> {
  const deduped = dedupeObservationsBySource(observations);
  const blockMap = new Map<string, EntityObservation[]>();
  for (const observation of deduped) {
    const keys = buildBlockKeys(observation);
    for (const key of keys) {
      const existing = blockMap.get(key) ?? [];
      existing.push(observation);
      blockMap.set(key, existing);
    }
  }

  const preliminary: ScoredPair[] = [];
  const seenPairs = new Set<string>();

  for (const bucket of blockMap.values()) {
    if (bucket.length < 2) {
      continue;
    }
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const first = bucket[i]!;
        const second = bucket[j]!;
        const [left, right] =
          first.id.localeCompare(second.id) <= 0 ? [first, second] : [second, first];
        const pairKey = `${left.id}::${right.id}`;
        if (seenPairs.has(pairKey)) {
          continue;
        }
        seenPairs.add(pairKey);

        if (!shouldConsiderPair(left, right)) {
          continue;
        }

        const score_structural = structuralScore(left, right);
        const score_string = stringScore(left, right);
        const score_context = contextScore(left, right);
        const score_graph = 0;
        const score_total = score_structural + score_string + score_context + score_graph;

        if (score_total <= 0 && !options.embeddingScorer) {
          continue;
        }

        preliminary.push({
          left,
          right,
          score_structural,
          score_string,
          score_context,
          score_graph,
          score_total,
        });
      }
    }
  }

  preliminary.sort((left, right) => right.score_total - left.score_total);

  const topN = preliminary.slice(0, options.topN ?? ENTITY_EMBEDDING_TOPN);
  const candidates: EntityResolutionCandidate[] = [];

  for (const item of topN) {
    let score_embedding = 0;
    if (options.embeddingScorer) {
      try {
        score_embedding = await options.embeddingScorer(item.left, item.right);
      } catch (error) {
        if (error instanceof EmbeddingUnavailableError) {
          throw error;
        }
        throw new EmbeddingUnavailableError({
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const createdAt = Date.now();
    candidates.push({
      id: `candidate_${item.left.id}_${item.right.id}`,
      candidate_kind: 'cluster',
      left_ref: item.left.id,
      right_ref: item.right.id,
      status: 'pending',
      score_total: item.score_total + score_embedding,
      score_structural: item.score_structural,
      score_string: item.score_string,
      score_context: item.score_context,
      score_graph: item.score_graph,
      score_embedding,
      rule_trace: JSON.stringify({
        structural: item.score_structural,
        string: item.score_string,
        context: item.score_context,
      }),
      extractor_version: item.left.extractor_version,
      embedding_model_version:
        item.left.embedding_model_version ?? item.right.embedding_model_version,
      created_at: createdAt,
      updated_at: createdAt,
    });
  }

  return candidates;
}
