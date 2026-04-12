import { OntologyViolationError } from './errors.js';
import type { EntityMergeAction, EntityObservation, EntityResolutionCandidate } from './types.js';

export interface ResolutionDecision {
  candidate: EntityResolutionCandidate;
  decision: 'auto_merge' | 'review';
  reason: string;
  actions: EntityMergeAction[];
}

function isCrossLanguage(left: EntityObservation, right: EntityObservation): boolean {
  return Boolean(left.lang && right.lang && left.lang !== right.lang);
}

export function shouldAutoMerge(result: ResolutionDecision): boolean {
  return result.decision === 'auto_merge';
}

export function buildReviewReason(result: ResolutionDecision): string {
  return result.reason;
}

export function evaluateResolutionCandidate(input: {
  candidate: EntityResolutionCandidate;
  left: EntityObservation;
  right: EntityObservation;
}): ResolutionDecision {
  const { candidate, left, right } = input;

  if (
    left.entity_kind_hint &&
    right.entity_kind_hint &&
    left.entity_kind_hint !== right.entity_kind_hint
  ) {
    throw new OntologyViolationError({
      left_entity_kind: left.entity_kind_hint,
      right_entity_kind: right.entity_kind_hint,
      candidate_id: candidate.id,
    });
  }

  const sameNormalized = left.normalized_form === right.normalized_form;
  const exactStructural = candidate.score_structural >= 1 && sameNormalized;
  const crossLanguage = isCrossLanguage(left, right);

  if (exactStructural && !crossLanguage) {
    return {
      candidate,
      decision: 'auto_merge',
      reason: 'Exact structural match with no cross-language ambiguity.',
      actions: [
        {
          id: `merge_${candidate.id}`,
          action_type: 'merge',
          source_entity_id: candidate.left_ref,
          target_entity_id: candidate.right_ref,
          candidate_id: candidate.id,
          actor_type: 'system',
          actor_id: 'resolution-engine',
          reason: 'Exact structural match with no cross-language ambiguity.',
          evidence_json: JSON.stringify({
            score_structural: candidate.score_structural,
            normalized_form: left.normalized_form,
          }),
          created_at: Date.now(),
        },
      ],
    };
  }

  if (crossLanguage && candidate.score_embedding > 0) {
    return {
      candidate,
      decision: 'review',
      reason: 'High-similarity cross-language candidate requires human review.',
      actions: [],
    };
  }

  return {
    candidate,
    decision: 'review',
    reason: 'Candidate requires manual review before merge.',
    actions: [],
  };
}
