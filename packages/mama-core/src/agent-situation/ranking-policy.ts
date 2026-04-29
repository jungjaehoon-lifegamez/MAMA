import type { AgentSituationCandidate, SituationScore } from './types.js';

export const AGENT_SITUATION_V0_POLICY_VERSION = 'agent_situation.v0';

export const AGENT_SITUATION_V0_WEIGHTS = {
  urgency: 0.35,
  confidence_gap: 0.2,
  source_freshness: 0.2,
  cross_channel_signal: 0.15,
  pending_human_question: 0.1,
} as const;

export interface AgentSituationRankingPolicy {
  version: string;
  weights: typeof AGENT_SITUATION_V0_WEIGHTS;
}

const V0_POLICY: AgentSituationRankingPolicy = {
  version: AGENT_SITUATION_V0_POLICY_VERSION,
  weights: AGENT_SITUATION_V0_WEIGHTS,
};

function textHasUrgency(candidate: AgentSituationCandidate): boolean {
  const text = `${candidate.title} ${candidate.summary}`.toLowerCase();
  return /\b(blocked|urgent|risk|deploy|release|needs?|review|failed|failing)\b/.test(text);
}

function freshnessScore(candidate: AgentSituationCandidate): number {
  if (!Number.isFinite(candidate.timestamp_ms) || candidate.timestamp_ms <= 0) {
    return 0;
  }
  const ageMs = Math.max(0, Date.now() - candidate.timestamp_ms);
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  return Math.max(0, 1 - Math.min(ageMs, sevenDaysMs) / sevenDaysMs);
}

export function getAgentSituationRankingPolicy(
  version = AGENT_SITUATION_V0_POLICY_VERSION
): AgentSituationRankingPolicy {
  if (version !== AGENT_SITUATION_V0_POLICY_VERSION) {
    throw new Error(`Unknown agent situation ranking policy: ${version}`);
  }
  return V0_POLICY;
}

export function scoreAgentSituationCandidate(
  candidate: AgentSituationCandidate,
  policy: AgentSituationRankingPolicy
): SituationScore {
  const reasons: string[] = [];
  const caveats: string[] = [];
  let score = 0;

  if (textHasUrgency(candidate)) {
    score += policy.weights.urgency;
    reasons.push('urgent_visible_signal');
  }

  const confidence = typeof candidate.confidence === 'number' ? candidate.confidence : 1;
  if (confidence < 0.6) {
    score += policy.weights.confidence_gap;
    reasons.push('low_confidence_memory');
    caveats.push('low_confidence_visible_memory');
  }

  if (candidate.has_debate_edge) {
    score += policy.weights.confidence_gap;
    reasons.push('debated_visible_memory');
  }

  const freshness = freshnessScore(candidate);
  if (freshness > 0) {
    score += freshness * policy.weights.source_freshness;
    reasons.push('recent_visible_source');
  }

  if (candidate.connector && candidate.channel_id) {
    score += policy.weights.cross_channel_signal / 2;
    reasons.push('visible_connector_context');
  }

  if (candidate.is_open_question) {
    score += policy.weights.pending_human_question + 0.2;
    reasons.push('pending_open_question');
  }

  return {
    score: Number(score.toFixed(6)),
    reasons: [...new Set(reasons)],
    caveats: [...new Set(caveats)],
  };
}
