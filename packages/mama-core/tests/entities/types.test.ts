import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  EntityAlias,
  EntityCandidateStatus,
  EntityKind,
  EntityMergeAction,
  EntityMergeActionType,
  EntityNode,
  EntityObservation,
  EntityResolutionCandidate,
  EntityScopeKind,
} from '../../src/entities/types.js';

describe('Story E1.1: Canonical entity domain contracts', () => {
  describe('AC #1: Enumerations expose the approved v1 ontology values', () => {
    it('should expose the supported entity kinds', async () => {
      const types = await import('../../src/entities/types.js');

      expect(types.ENTITY_KINDS).toEqual(['project', 'person', 'organization', 'work_item']);
    });

    it('should expose the supported alias label types', async () => {
      const types = await import('../../src/entities/types.js');

      expect(types.ENTITY_ALIAS_LABEL_TYPES).toEqual(['pref', 'alt', 'hidden', 'source_native']);
    });

    it('should expose the supported candidate statuses', async () => {
      const types = await import('../../src/entities/types.js');

      expect(types.ENTITY_CANDIDATE_STATUSES).toEqual([
        'pending',
        'auto_merged',
        'approved',
        'rejected',
        'deferred',
      ]);
    });

    it('should expose the supported merge action types', async () => {
      const types = await import('../../src/entities/types.js');

      expect(types.ENTITY_MERGE_ACTION_TYPES).toEqual(['merge', 'reject', 'defer', 'split']);
    });

    it('should expose the supported entity scope kinds', async () => {
      const types = await import('../../src/entities/types.js');

      expect(types.ENTITY_SCOPE_KINDS).toEqual(['project', 'channel', 'user', 'global']);
    });
  });

  describe('AC #2: Runtime helpers preserve the expected value space', () => {
    it('should allow a concrete sample for the exported string unions', () => {
      const sampleKind: EntityKind = 'project';
      const sampleScope: EntityScopeKind = 'channel';
      const sampleStatus: EntityCandidateStatus = 'approved';
      const sampleAction: EntityMergeActionType = 'merge';

      expect(sampleKind).toBe('project');
      expect(sampleScope).toBe('channel');
      expect(sampleStatus).toBe('approved');
      expect(sampleAction).toBe('merge');
    });
  });

  describe('AC #3: Type contracts preserve required provenance and scope fields', () => {
    it('should preserve nullable scope binding on entity nodes', () => {
      expectTypeOf<EntityNode>().toMatchTypeOf<{
        id: string;
        kind: EntityKind;
        preferred_label: string;
        scope_kind: EntityScopeKind | null;
        scope_id: string | null;
      }>();
    });

    it('should require provenance on entity observations', () => {
      expectTypeOf<EntityObservation>().toMatchTypeOf<{
        id: string;
        observation_type: 'generic' | 'author' | 'channel';
        entity_kind_hint: EntityKind | null;
        surface_form: string;
        normalized_form: string;
        scope_kind: EntityScopeKind;
        scope_id: string | null;
        extractor_version: string;
        embedding_model_version: string | null;
        source_connector: string;
        source_locator: string | null;
        source_raw_record_id: string;
      }>();
    });

    it('should require model-version provenance on resolution candidates', () => {
      expectTypeOf<EntityResolutionCandidate>().toMatchTypeOf<{
        id: string;
        status: EntityCandidateStatus;
        extractor_version: string;
        embedding_model_version: string | null;
        score_total: number;
      }>();
    });

    it('should preserve label metadata on entity aliases', () => {
      expectTypeOf<EntityAlias>().toMatchTypeOf<{
        id: string;
        entity_id: string;
        label: string;
        normalized_label: string;
        lang: string | null;
        script: string | null;
        source_type: string;
      }>();
    });

    it('should preserve provenance on merge actions', () => {
      expectTypeOf<EntityMergeAction>().toMatchTypeOf<{
        id: string;
        action_type: EntityMergeActionType;
        candidate_id: string | null;
        reason: string;
        evidence_json: string;
      }>();
    });
  });
});
