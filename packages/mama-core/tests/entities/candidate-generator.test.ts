import { describe, expect, it } from 'vitest';
import { dedupeObservationsBySource } from '../../src/entities/candidate-generator.js';
import type { EntityObservation } from '../../src/entities/types.js';

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
    source_locator: '~/.mama/connectors/slack/raw.db',
    source_raw_record_id: `raw_${id}`,
    created_at: 1710000000000,
    ...overrides,
  };
}

describe('Story E1.5: Canonical entity candidate generation', () => {
  describe('AC #1: deterministic preprocessing removes duplicate raw observations', () => {
    it('should dedupe observations by connector and raw record id', () => {
      const deduped = dedupeObservationsBySource([
        makeObservation('one', {
          observation_type: 'generic',
          source_raw_record_id: 'raw_dup',
          context_summary: 'older',
        }),
        makeObservation('two', {
          observation_type: 'generic',
          source_raw_record_id: 'raw_dup',
          context_summary: 'newer',
          timestamp_observed: 1710000000001,
        }),
      ]);

      expect(deduped).toHaveLength(1);
      expect(deduped[0]?.id).toBe('one');
    });

    it('should keep observations distinct when raw db ref or observation type differs', () => {
      const deduped = dedupeObservationsBySource([
        makeObservation('one', {
          observation_type: 'author',
          source_raw_record_id: 'raw_dup',
          source_locator: '~/.mama/connectors/slack/raw-a.db',
        }),
        makeObservation('two', {
          observation_type: 'channel',
          source_raw_record_id: 'raw_dup',
          source_locator: '~/.mama/connectors/slack/raw-a.db',
        }),
        makeObservation('three', {
          observation_type: 'author',
          source_raw_record_id: 'raw_dup',
          source_locator: '~/.mama/connectors/slack/raw-b.db',
        }),
      ]);

      expect(deduped).toHaveLength(3);
    });

    it('should keep observations distinct when source_locator is missing', () => {
      const deduped = dedupeObservationsBySource([
        makeObservation('one', {
          source_raw_record_id: 'raw_missing_locator',
          source_locator: null,
        }),
        makeObservation('two', {
          source_raw_record_id: 'raw_missing_locator',
          source_locator: null,
        }),
      ]);

      expect(deduped).toHaveLength(2);
    });
  });
});
