import { EmbeddingUnavailableError } from './errors.js';
import { extractStructuredIdentifiers, normalizeEntityLabel } from './normalization.js';
import type { EntityObservation, EntityResolutionCandidate } from './types.js';

export const ENTITY_EMBEDDING_TOPN = 50;
const CROSS_SCOPE_PROBE_MIN_EMBEDDING_SCORE = 0.84;

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
  probe_kind: 'deterministic' | 'cross_scope';
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

function scorePair(
  left: EntityObservation,
  right: EntityObservation,
  probeKind: ScoredPair['probe_kind']
): ScoredPair {
  const score_structural = structuralScore(left, right);
  const score_string = stringScore(left, right);
  const score_context = contextScore(left, right);
  const score_graph = 0;
  const score_total = score_structural + score_string + score_context + score_graph;

  return {
    left,
    right,
    score_structural,
    score_string,
    score_context,
    score_graph,
    score_total,
    probe_kind: probeKind,
  };
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

function shouldConsiderCrossScopeProbe(left: EntityObservation, right: EntityObservation): boolean {
  if (
    !left.entity_kind_hint ||
    !right.entity_kind_hint ||
    left.entity_kind_hint !== right.entity_kind_hint
  ) {
    return false;
  }

  if (left.observation_type !== right.observation_type) {
    return false;
  }

  if (left.scope_kind !== right.scope_kind) {
    return false;
  }

  if (left.scope_id === right.scope_id) {
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

function normalizeSurfaceForm(value: string): string {
  if (value.trim().length === 0) {
    return '';
  }

  return normalizeEntityLabel(value).normalized;
}

function sharedNormalizedRelatedCount(left: EntityObservation, right: EntityObservation): number {
  const leftRelated = new Set(
    left.related_surface_forms.map((value) => normalizeSurfaceForm(value))
  );
  const rightRelated = new Set(
    right.related_surface_forms.map((value) => normalizeSurfaceForm(value))
  );
  if (leftRelated.size === 0 || rightRelated.size === 0) {
    return 0;
  }

  let overlap = 0;
  for (const related of leftRelated) {
    if (rightRelated.has(related)) {
      overlap += 1;
    }
  }
  return overlap;
}

function getTimestampDistance(left: EntityObservation, right: EntityObservation): number {
  if (left.timestamp_observed === null || right.timestamp_observed === null) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.abs(left.timestamp_observed - right.timestamp_observed);
}

function buildPairKey(left: EntityObservation, right: EntityObservation): string {
  return `${left.id}::${right.id}`;
}

function buildCrossLanguageFamilyKey(
  left: EntityObservation,
  right: EntityObservation
): string | null {
  if (!left.lang || !right.lang || left.lang === right.lang) {
    return null;
  }

  const forms = [
    `${left.lang}:${left.normalized_form}`,
    `${right.lang}:${right.normalized_form}`,
  ].sort();
  const observationTypes = [left.observation_type, right.observation_type].sort();

  return JSON.stringify([
    left.entity_kind_hint ?? right.entity_kind_hint ?? 'unknown',
    observationTypes,
    forms,
  ]);
}

function compareProbePairs(left: ScoredPair, right: ScoredPair): number {
  const relatedDelta =
    sharedNormalizedRelatedCount(right.left, right.right) -
    sharedNormalizedRelatedCount(left.left, left.right);
  if (relatedDelta !== 0) {
    return relatedDelta;
  }

  if (right.score_total !== left.score_total) {
    return right.score_total - left.score_total;
  }

  const timestampDelta =
    getTimestampDistance(left.left, left.right) - getTimestampDistance(right.left, right.right);
  if (timestampDelta !== 0) {
    return timestampDelta;
  }

  return buildPairKey(left.left, left.right).localeCompare(buildPairKey(right.left, right.right));
}

function dedupeCrossLanguageFamilies(
  candidates: EntityResolutionCandidate[],
  observationLookup: Map<string, EntityObservation>
): EntityResolutionCandidate[] {
  const deduped: EntityResolutionCandidate[] = [];
  const bestByFamily = new Map<string, EntityResolutionCandidate>();

  for (const candidate of candidates) {
    const left = observationLookup.get(candidate.left_ref);
    const right = observationLookup.get(candidate.right_ref);
    if (!left || !right) {
      deduped.push(candidate);
      continue;
    }

    const familyKey = buildCrossLanguageFamilyKey(left, right);
    if (!familyKey) {
      deduped.push(candidate);
      continue;
    }

    const existing = bestByFamily.get(familyKey);
    if (
      !existing ||
      candidate.score_total > existing.score_total ||
      (candidate.score_total === existing.score_total &&
        candidate.id.localeCompare(existing.id) < 0)
    ) {
      bestByFamily.set(familyKey, candidate);
    }
  }

  return deduped.concat(Array.from(bestByFamily.values()));
}

function buildCrossScopeProbePairs(
  observations: EntityObservation[],
  seenPairs: Set<string>,
  maxPairs: number
): ScoredPair[] {
  if (maxPairs <= 0) {
    return [];
  }

  const probes: ScoredPair[] = [];

  for (let i = 0; i < observations.length; i += 1) {
    for (let j = i + 1; j < observations.length; j += 1) {
      const first = observations[i]!;
      const second = observations[j]!;
      const [left, right] =
        first.id.localeCompare(second.id) <= 0 ? [first, second] : [second, first];
      const pairKey = buildPairKey(left, right);
      if (seenPairs.has(pairKey)) {
        continue;
      }
      seenPairs.add(pairKey);

      if (!shouldConsiderCrossScopeProbe(left, right)) {
        continue;
      }

      probes.push(scorePair(left, right, 'cross_scope'));
      probes.sort(compareProbePairs);
      if (probes.length > maxPairs) {
        probes.length = maxPairs;
      }
    }
  }

  return probes;
}

function hasMultipleScopes(observations: EntityObservation[]): boolean {
  const scopes = new Set(
    observations.map(
      (observation) => `${observation.scope_kind}:${observation.scope_id ?? 'global'}`
    )
  );
  return scopes.size > 1;
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

export async function generateResolutionCandidates(
  observations: EntityObservation[],
  options: CandidateGeneratorOptions = {}
): Promise<EntityResolutionCandidate[]> {
  const deduped = dedupeObservationsBySource(observations);
  const observationLookup = new Map(deduped.map((observation) => [observation.id, observation]));
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

        const scored = scorePair(left, right, 'deterministic');

        if (scored.score_total <= 0 && !options.embeddingScorer) {
          continue;
        }

        preliminary.push(scored);
      }
    }
  }

  preliminary.sort((left, right) => right.score_total - left.score_total);

  const topNLimit = options.topN ?? ENTITY_EMBEDDING_TOPN;
  const topN = preliminary.slice(0, topNLimit);
  topN.sort((left, right) => right.score_total - left.score_total);
  const pairBudget = Math.ceil(topNLimit ** 2 / 2);
  const crossScopeBudget = options.embeddingScorer ? Math.max(0, pairBudget - topN.length) : 0;
  const crossScopePairs =
    options.embeddingScorer && crossScopeBudget > 0 && hasMultipleScopes(deduped)
      ? buildCrossScopeProbePairs(deduped, seenPairs, crossScopeBudget)
      : [];
  const candidates: EntityResolutionCandidate[] = [];

  for (const item of [...topN, ...crossScopePairs]) {
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

    const finalScore = item.score_total + score_embedding;
    if (finalScore <= 0) {
      continue;
    }

    if (
      item.probe_kind === 'cross_scope' &&
      score_embedding < CROSS_SCOPE_PROBE_MIN_EMBEDDING_SCORE
    ) {
      continue;
    }

    const createdAt = Date.now();
    candidates.push({
      id: `candidate_${item.left.id}_${item.right.id}`,
      candidate_kind: 'cluster',
      left_ref: item.left.id,
      right_ref: item.right.id,
      status: 'pending',
      score_total: finalScore,
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

  const dedupedFamilies = options.embeddingScorer
    ? dedupeCrossLanguageFamilies(candidates, observationLookup)
    : candidates;

  dedupedFamilies.sort((left, right) => {
    if (right.score_total !== left.score_total) {
      return right.score_total - left.score_total;
    }
    return left.id.localeCompare(right.id);
  });

  return dedupedFamilies.slice(0, topNLimit);
}
