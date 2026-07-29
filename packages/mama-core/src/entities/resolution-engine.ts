import type { EntityMergeAction, EntityResolutionCandidate } from './types.js';

export interface ResolutionDecision {
  candidate: EntityResolutionCandidate;
  decision: 'auto_merge' | 'review';
  reason: string;
  actions: EntityMergeAction[];
}
