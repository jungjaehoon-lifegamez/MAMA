import { randomUUID } from 'node:crypto';

import { canonicalizeJSON } from '../canonicalize.js';
import type { DatabaseAdapter } from '../db-manager.js';
import {
  buildAgentSituationCacheKey,
  normalizeAgentSituationEffectiveFilters,
} from './cache-key.js';
import {
  AGENT_SITUATION_V0_POLICY_VERSION,
  getAgentSituationRankingPolicy,
  scoreAgentSituationCandidate,
} from './ranking-policy.js';
import {
  listVisibleAgentSituationSources as readVisibleSources,
  type AgentSituationSourceReadInput,
  type VisibleAgentSituationSources,
} from './source-readers.js';
import type {
  AgentSituationInput,
  AgentSituationPacketRecord,
  SituationBriefing,
  SituationRankedItem,
  SituationRecommendedTool,
  SituationSourceCoverage,
  SituationRef,
} from './types.js';

type SituationBuilderAdapter = Pick<DatabaseAdapter, 'prepare'>;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function ttlForRange(rangeStartMs: number, rangeEndMs: number): number {
  const rangeMs = Math.max(0, rangeEndMs - rangeStartMs);
  const dayMs = 24 * 60 * 60 * 1000;
  if (rangeMs <= 7 * dayMs) {
    return 120;
  }
  if (rangeMs <= 30 * dayMs) {
    return 300;
  }
  return 900;
}

function topStrings(values: string[], limit = 3): string[] {
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function refKey(ref: SituationRef): string {
  return `${ref.kind}:${ref.id}`;
}

function buildBriefing(sources: VisibleAgentSituationSources): SituationBriefing {
  const memories = sources.memories;
  const openQuestions = memories.filter((memory) => memory.is_open_question);
  const lowConfidence = [...memories, ...sources.cases, ...sources.edges].filter(
    (candidate) => typeof candidate.confidence === 'number' && candidate.confidence < 0.6
  );

  return {
    decisions: topStrings(memories.map((memory) => memory.summary || memory.title)),
    facts: topStrings(sources.raw.map((raw) => raw.summary)),
    open_questions: topStrings(openQuestions.map((memory) => memory.summary || memory.title)),
    risks: topStrings([
      ...lowConfidence.map((candidate) => candidate.summary || candidate.title),
      ...sources.cases
        .filter((item) => item.status === 'blocked')
        .map((item) => `${item.title}: ${item.status}`),
    ]),
  };
}

function buildCoverage(
  sources: VisibleAgentSituationSources,
  input: AgentSituationInput
): SituationSourceCoverage[] {
  const coverage: SituationSourceCoverage[] = [];
  for (const connector of input.effective_filters.connectors) {
    for (const scope of input.effective_filters.scopes) {
      const raw = sources.raw.filter(
        (item) =>
          item.connector === connector &&
          item.scope?.kind === scope.kind &&
          item.scope.id === scope.id
      );
      const memories = sources.memories.filter(
        (item) => item.scope?.kind === scope.kind && item.scope.id === scope.id
      );
      const cases = sources.cases.filter(
        (item) => item.scope?.kind === scope.kind && item.scope.id === scope.id
      );
      const rowRefs = new Set([...raw, ...memories, ...cases].map((item) => refKey(item.ref)));
      const edges = sources.edges.filter(
        (item) => rowRefs.has(refKey(item.subject_ref)) && rowRefs.has(refKey(item.object_ref))
      );
      const lastSeenMs = Math.max(
        0,
        ...raw.map((item) => item.timestamp_ms),
        ...memories.map((item) => item.timestamp_ms),
        ...cases.map((item) => item.timestamp_ms),
        ...edges.map((item) => item.timestamp_ms)
      );
      coverage.push({
        connector,
        channel_id: raw[0]?.channel_id ?? null,
        memory_scope: scope,
        raw_count: raw.length,
        memory_count: memories.length,
        case_count: cases.length,
        edge_count: edges.length,
        last_seen: lastSeenMs > 0 ? iso(lastSeenMs) : null,
        stale:
          lastSeenMs > 0
            ? (input.now_ms ?? Date.now()) - lastSeenMs > 30 * 24 * 60 * 60 * 1000
            : true,
      });
    }
  }
  return coverage;
}

function buildRankedItems(
  sources: VisibleAgentSituationSources,
  limit: number
): SituationRankedItem[] {
  const policy = getAgentSituationRankingPolicy();
  const candidates = [...sources.raw, ...sources.memories, ...sources.cases, ...sources.edges];
  return candidates
    .map((candidate) => {
      const score = scoreAgentSituationCandidate(candidate, policy);
      return {
        ref: candidate.ref,
        kind: candidate.kind,
        score: score.score,
        reasons: score.reasons,
        caveats: score.caveats,
      };
    })
    .sort((left, right) => right.score - left.score || left.ref.id.localeCompare(right.ref.id))
    .slice(0, limit);
}

function buildRecommendations(
  sources: VisibleAgentSituationSources,
  rankedItems: SituationRankedItem[]
): SituationRecommendedTool[] {
  const recommendations: SituationRecommendedTool[] = [];
  const expectedRefs: SituationRef[] = rankedItems.map((item) => item.ref);
  if (sources.memories.some((memory) => memory.is_open_question) || sources.raw.length > 0) {
    recommendations.push({
      tool: 'raw.searchAll',
      args: {
        query: sources.memories.find((memory) => memory.is_open_question)?.title ?? 'recent work',
      },
      reason: 'visible_open_question_needs_evidence',
      expected_refs: expectedRefs.filter((ref) => ref.kind === 'raw' || ref.kind === 'memory'),
    });
  }
  const topRaw = sources.raw[0];
  if (topRaw) {
    recommendations.push({
      tool: 'raw.window',
      args: { raw_id: topRaw.ref.id },
      reason: 'inspect_visible_raw_context',
      expected_refs: [topRaw.ref],
    });
  }
  return recommendations;
}

function sourceRefs(sources: VisibleAgentSituationSources): SituationRef[] {
  return [
    ...sources.raw.map((item) => item.ref),
    ...sources.memories.map((item) => item.ref),
    ...sources.cases.map((item) => item.ref),
    ...sources.edges.map((item) => item.ref),
  ];
}

function primaryScope(input: AgentSituationInput) {
  const scope = input.scope[0] ?? input.effective_filters.scopes[0];
  if (!scope) {
    throw new Error('agent.situation requires at least one effective memory scope');
  }
  return scope;
}

function primaryProjectId(input: AgentSituationInput): string {
  const project = input.effective_filters.project_refs[0];
  if (!project) {
    throw new Error('agent.situation requires at least one effective project ref');
  }
  return project.id;
}

function json<T>(value: T): string {
  return canonicalizeJSON(value);
}

export function listVisibleAgentSituationSources(
  adapter: SituationBuilderAdapter,
  input: AgentSituationSourceReadInput
): VisibleAgentSituationSources {
  return readVisibleSources(adapter, input);
}

export function buildAgentSituationPacketRecord(
  adapter: SituationBuilderAdapter,
  input: AgentSituationInput
): AgentSituationPacketRecord {
  const rankingPolicyVersion = input.ranking_policy_version ?? AGENT_SITUATION_V0_POLICY_VERSION;
  const nowMs = Math.floor(input.now_ms ?? Date.now());
  const limit = Math.floor(input.limit);
  const effectiveFilters = normalizeAgentSituationEffectiveFilters(input.effective_filters);
  const normalizedInput = { ...input, effective_filters: effectiveFilters };
  const sources = readVisibleSources(adapter, {
    effective_filters: effectiveFilters,
    range_start_ms: input.range_start_ms,
    range_end_ms: input.range_end_ms,
    limit,
  });
  const key = buildAgentSituationCacheKey({
    ...effectiveFilters,
    range_start_ms: input.range_start_ms,
    range_end_ms: input.range_end_ms,
    focus: input.focus,
    limit,
    ranking_policy_version: rankingPolicyVersion,
  });
  const ttlSeconds = ttlForRange(input.range_start_ms, input.range_end_ms);
  const expiresAt = nowMs + ttlSeconds * 1000;
  const scope = primaryScope(input);
  const rankedItems = buildRankedItems(sources, limit);
  const briefing = buildBriefing(sources);
  const coverage = buildCoverage(sources, normalizedInput);
  const visibleSourceRefs = sourceRefs(sources);
  const pendingHumanQuestions = sources.memories
    .filter((memory) => memory.is_open_question)
    .slice(0, 3)
    .map((memory) => ({
      memory_id: memory.ref.id,
      title: memory.title,
      summary: memory.summary,
    }));
  const caveats = visibleSourceRefs.length === 0 ? ['no_visible_sources'] : ([] as string[]);
  const recommendedNextTools = buildRecommendations(sources, rankedItems);
  const freshness = {
    generated_at_ms: nowMs,
    visible_source_count: visibleSourceRefs.length,
  };

  return {
    packet_id: `situ_${randomUUID().replace(/-/g, '')}`,
    cache_key: key.cacheKey,
    scope_json: json(input.scope),
    scope: input.scope,
    scope_hash: key.scopeHash,
    range_start_ms: Math.floor(input.range_start_ms),
    range_end_ms: Math.floor(input.range_end_ms),
    focus_json: json(input.focus),
    focus: input.focus,
    envelope_hash: input.envelope_hash,
    envelope_effective_filters_json: json(effectiveFilters),
    envelope_effective_filters: effectiveFilters,
    envelope_effective_filters_hash: key.filtersHash,
    ranking_policy_version: rankingPolicyVersion,
    generated_at: nowMs,
    expires_at: expiresAt,
    ttl_seconds: ttlSeconds,
    freshness_json: json(freshness),
    freshness,
    source_coverage_json: json(coverage),
    source_coverage: coverage,
    briefing_json: json(briefing),
    briefing,
    ranked_items_json: json(rankedItems),
    ranked_items: rankedItems,
    top_memory_refs_json: json(sources.memories.map((memory) => memory.ref.id).slice(0, limit)),
    top_memory_refs: sources.memories.map((memory) => memory.ref.id).slice(0, limit),
    pending_human_questions_json: json(pendingHumanQuestions),
    pending_human_questions: pendingHumanQuestions,
    entity_clusters_json: '[]',
    entity_clusters: [],
    recommended_next_tools_json: json(recommendedNextTools),
    recommended_next_tools: recommendedNextTools,
    generated_from_slice_ids_json: '[]',
    generated_from_slice_ids: [],
    caveats_json: json(caveats),
    caveats,
    agent_id: input.agent_id,
    model_run_id: input.model_run_id,
    input_snapshot_ref: `situation:${key.cacheKey}`,
    source_refs_json: json(visibleSourceRefs),
    source_refs: visibleSourceRefs,
    tenant_id: effectiveFilters.tenant_id,
    project_id: primaryProjectId(normalizedInput),
    memory_scope_kind: scope.kind,
    memory_scope_id: scope.id,
    created_at: nowMs,
  };
}
