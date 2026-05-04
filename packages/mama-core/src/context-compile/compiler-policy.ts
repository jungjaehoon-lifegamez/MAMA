import type { ContextEvidence, ContextRef } from './types.js';
import { serializeContextRefForProvenance } from './ref.js';
import type { ContextCandidate, HiddenCandidateAggregate } from './source-readers.js';

export interface ContextCompilerPolicyInput {
  task: string;
  candidates: ContextCandidate[];
  hidden: HiddenCandidateAggregate;
  limit?: number;
  strictness?: 'recall' | 'balanced' | 'strict' | 'low' | 'medium' | 'high';
  max_tokens?: number;
}

export interface ContextCompilerPolicyResult {
  selected_evidence: ContextEvidence[];
  source_refs: ContextRef[];
  evidence_clusters: unknown[];
  related_decisions: Array<{ memory_id: string; title: string }>;
  rejected_refs: ContextRef[];
  rejected_summary: string[];
  missing_context: string[];
  caveats: string[];
  retrieval_diagnostics: {
    candidate_count: number;
    selected_count: number;
    rejected_count: number;
    hidden: HiddenCandidateAggregate;
    deduplicated_count: number;
    strict_vector_only_rejected_count: number;
    token_budget_rejected_count: number;
    limit_rejected_count: number;
    truncated_by_tokens: boolean;
    estimated_tokens: number;
  };
  estimated_tokens: number;
}

interface PolicyCounters {
  deduplicated: number;
  strictVectorOnly: number;
  tokenBudget: number;
  limit: number;
}

function normalizeLimit(limit: number | undefined): number {
  return Math.max(0, Math.min(100, Math.floor(limit ?? 10)));
}

export function estimateEvidenceTokens(
  evidence: Pick<ContextEvidence, 'title' | 'excerpt'>
): number {
  const text = `${evidence.title ?? ''}\n${evidence.excerpt ?? ''}`;
  return Math.max(1, Math.ceil(text.length / 4));
}

function sortedCandidates(candidates: readonly ContextCandidate[]): ContextCandidate[] {
  return [...candidates].sort((left, right) => {
    const scoreDiff = right.score - left.score;
    if (scoreDiff !== 0) {
      return scoreDiff;
    }
    return (right.timestamp_ms ?? 0) - (left.timestamp_ms ?? 0);
  });
}

function shouldRejectVectorOnly(
  candidate: ContextCandidate,
  strictness: 'recall' | 'balanced' | 'strict'
): boolean {
  return (
    strictness === 'strict' &&
    candidate.support.is_vector_only === true &&
    candidate.support.confirmation_signals.length === 0
  );
}

function evidenceFromCandidate(candidate: ContextCandidate): ContextEvidence {
  return {
    ref: candidate.ref,
    title: candidate.title,
    excerpt: candidate.excerpt,
    score: candidate.score,
    reasons: [
      ...(candidate.support.confirmation_signals ?? []),
      ...(candidate.support.graph_expanded ? ['graph_expanded'] : []),
    ],
    ...(candidate.retrieval_diagnostics
      ? { retrieval_diagnostics: candidate.retrieval_diagnostics }
      : {}),
  };
}

function addCountSummary(parts: string[], label: string, count: number): void {
  if (count > 0) {
    parts.push(`${label}: ${count}`);
  }
}

function normalizeStrictness(
  strictness: ContextCompilerPolicyInput['strictness']
): 'recall' | 'balanced' | 'strict' {
  switch (strictness) {
    case 'low':
    case 'recall':
      return 'recall';
    case 'high':
    case 'strict':
      return 'strict';
    case 'medium':
    case 'balanced':
    case undefined:
      return 'balanced';
  }
  return 'balanced';
}

export function applyContextCompilerPolicy(
  input: ContextCompilerPolicyInput
): ContextCompilerPolicyResult {
  const limit = normalizeLimit(input.limit);
  const strictness = normalizeStrictness(input.strictness);
  const maxTokens =
    typeof input.max_tokens === 'number' && Number.isFinite(input.max_tokens)
      ? Math.max(0, Math.floor(input.max_tokens))
      : null;

  const seen = new Set<string>();
  const selected: ContextEvidence[] = [];
  const sourceRefs: ContextRef[] = [];
  const rejectedRefs: ContextRef[] = [];
  const counters: PolicyCounters = {
    deduplicated: 0,
    strictVectorOnly: 0,
    tokenBudget: 0,
    limit: 0,
  };
  let estimatedTokens = 0;

  for (const candidate of sortedCandidates(input.candidates)) {
    if (!candidate.visible) {
      continue;
    }

    const key = serializeContextRefForProvenance(candidate.ref);
    if (seen.has(key)) {
      counters.deduplicated += 1;
      rejectedRefs.push(candidate.ref);
      continue;
    }

    if (shouldRejectVectorOnly(candidate, strictness)) {
      counters.strictVectorOnly += 1;
      rejectedRefs.push(candidate.ref);
      continue;
    }

    if (selected.length >= limit) {
      counters.limit += 1;
      rejectedRefs.push(candidate.ref);
      continue;
    }

    const evidence = evidenceFromCandidate(candidate);
    const nextTokens = estimateEvidenceTokens(evidence);
    if (maxTokens !== null && estimatedTokens + nextTokens > maxTokens) {
      counters.tokenBudget += 1;
      rejectedRefs.push(candidate.ref);
      continue;
    }

    selected.push(evidence);
    sourceRefs.push(candidate.ref);
    seen.add(key);
    estimatedTokens += nextTokens;
  }

  const rejectedSummary: string[] = [];
  addCountSummary(rejectedSummary, 'deduplicated duplicate candidates', counters.deduplicated);
  addCountSummary(
    rejectedSummary,
    'strictness rejected vector-only candidates',
    counters.strictVectorOnly
  );
  addCountSummary(rejectedSummary, 'token budget rejected candidates', counters.tokenBudget);
  addCountSummary(rejectedSummary, 'limit rejected candidates', counters.limit);

  const caveats: string[] = [];
  if (input.hidden.total > 0) {
    caveats.push(`hidden candidates omitted: ${input.hidden.total}`);
  }

  const relatedDecisions = selected.flatMap((evidence) =>
    evidence.ref.kind === 'memory'
      ? [{ memory_id: evidence.ref.id, title: evidence.title ?? evidence.ref.id }]
      : []
  );

  return {
    selected_evidence: selected,
    source_refs: sourceRefs,
    evidence_clusters: [],
    related_decisions: relatedDecisions,
    rejected_refs: rejectedRefs,
    rejected_summary: rejectedSummary,
    missing_context:
      selected.length === 0 ? [`No visible evidence selected for task: ${input.task}`] : [],
    caveats,
    retrieval_diagnostics: {
      candidate_count: input.candidates.length,
      selected_count: selected.length,
      rejected_count: rejectedRefs.length,
      hidden: input.hidden,
      deduplicated_count: counters.deduplicated,
      strict_vector_only_rejected_count: counters.strictVectorOnly,
      token_budget_rejected_count: counters.tokenBudget,
      limit_rejected_count: counters.limit,
      truncated_by_tokens: counters.tokenBudget > 0,
      estimated_tokens: estimatedTokens,
    },
    estimated_tokens: estimatedTokens,
  };
}
