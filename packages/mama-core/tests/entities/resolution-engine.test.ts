import { describe, expect, it } from 'vitest';
import { OntologyViolationError } from '../../src/entities/errors.js';
import {
  buildReviewReason,
  evaluateResolutionCandidate,
  shouldAutoMerge,
} from '../../src/entities/resolution-engine.js';
import type {
  EntityMergeAction,
  EntityObservation,
  EntityResolutionCandidate,
} from '../../src/entities/types.js';

function makeObservation(
  id: string,
  overrides: Partial<EntityObservation> = {}
): EntityObservation {
  return {
    id,
    observation_type: 'generic',
    entity_kind_hint: 'project',
    surface_form: `Project ${id}`,
    normalized_form: `project ${id}`.toLowerCase(),
    lang: 'en',
    script: 'Latn',
    context_summary: 'launch planning alpha workspace',
    related_surface_forms: [],
    timestamp_observed: 1710000000000,
    scope_kind: 'project',
    scope_id: 'scope-alpha',
    extractor_version: 'history-extractor@v1',
    embedding_model_version: 'multilingual-e5-large',
    source_connector: 'slack',
    source_raw_db_ref: '~/.mama/connectors/slack/raw.db',
    source_raw_record_id: `raw_${id}`,
    created_at: 1710000000000,
    ...overrides,
  };
}

function makeCandidate(
  id: string,
  overrides: Partial<EntityResolutionCandidate> = {}
): EntityResolutionCandidate {
  return {
    id,
    candidate_kind: 'cluster',
    left_ref: 'left',
    right_ref: 'right',
    status: 'pending',
    score_total: 1,
    score_structural: 1,
    score_string: 1,
    score_context: 0.5,
    score_graph: 0,
    score_embedding: 0,
    rule_trace: '{}',
    extractor_version: 'history-extractor@v1',
    embedding_model_version: 'multilingual-e5-large',
    created_at: 1710000000000,
    updated_at: 1710000000000,
    ...overrides,
  };
}

describe('Story E1.6: Canonical entity resolution rules', () => {
  describe('AC #1: exact structural identity can auto-merge', () => {
    it('should auto-merge exact structural matches', () => {
      const result = evaluateResolutionCandidate({
        candidate: makeCandidate('candidate_exact'),
        left: makeObservation('left', {
          surface_form: 'Project Alpha',
          normalized_form: 'project alpha',
        }),
        right: makeObservation('right', {
          surface_form: 'project alpha',
          normalized_form: 'project alpha',
          source_raw_record_id: 'raw_right',
        }),
      });

      expect(shouldAutoMerge(result)).toBe(true);
      expect(result.decision).toBe('auto_merge');
      expect(result.actions).toEqual(
        expect.arrayContaining([
          expect.objectContaining<EntityMergeAction>({
            action_type: 'merge',
            candidate_id: 'candidate_exact',
          }),
        ])
      );
    });
  });

  describe('AC #2: cross-language embedding-only cases stay review-needed', () => {
    it('should keep high-embedding multilingual matches in review', () => {
      const result = evaluateResolutionCandidate({
        candidate: makeCandidate('candidate_multilingual', {
          score_structural: 0,
          score_string: 0,
          score_context: 0.4,
          score_embedding: 0.94,
          score_total: 1.34,
        }),
        left: makeObservation('left_ko', {
          surface_form: '\uD504\uB85C\uC81D\uD2B8 \uC54C\uD30C',
          normalized_form: '\uD504\uB85C\uC81D\uD2B8 \uC54C\uD30C',
          lang: 'ko',
          script: 'Hang',
        }),
        right: makeObservation('right_ja', {
          surface_form: '\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u30A2\u30EB\u30D5\u30A1',
          normalized_form: '\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u30A2\u30EB\u30D5\u30A1',
          lang: 'ja',
          script: 'Jpan',
          source_raw_record_id: 'raw_right_ja',
        }),
      });

      expect(shouldAutoMerge(result)).toBe(false);
      expect(result.decision).toBe('review');
      expect(buildReviewReason(result)).toContain('cross-language');
    });
  });

  describe('AC #3: ontology violations fail loudly', () => {
    it('should reject candidates whose entity kinds conflict', () => {
      expect(() =>
        evaluateResolutionCandidate({
          candidate: makeCandidate('candidate_conflict'),
          left: makeObservation('left_person', {
            entity_kind_hint: 'person',
          }),
          right: makeObservation('right_project', {
            entity_kind_hint: 'project',
            source_raw_record_id: 'raw_right_project',
          }),
        })
      ).toThrow(OntologyViolationError);
    });
  });
});
