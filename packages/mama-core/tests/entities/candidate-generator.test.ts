import { describe, expect, it, vi } from 'vitest';
import {
  ENTITY_EMBEDDING_TOPN,
  dedupeObservationsBySource,
  generateResolutionCandidates,
} from '../../src/entities/candidate-generator.js';
import type { EntityObservation } from '../../src/entities/types.js';
import { EmbeddingUnavailableError } from '../../src/entities/errors.js';

const KOREAN_PROJECT_ALPHA = '\uD504\uB85C\uC81D\uD2B8 \uC54C\uD30C';
const JAPANESE_PROJECT_ALPHA = '\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u30A2\u30EB\u30D5\u30A1';
const KOREAN_PERSON_JAEHUN = '\uC815\uC7AC\uD6C8';

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

  describe('AC #2: deterministic blocking surfaces obvious candidates', () => {
    it('should generate a candidate for exact normalized-label matches', async () => {
      const candidates = await generateResolutionCandidates([
        makeObservation('alpha_en', {
          surface_form: 'Project Alpha',
          normalized_form: 'project alpha',
        }),
        makeObservation('alpha_en_2', {
          surface_form: 'project alpha',
          normalized_form: 'project alpha',
          source_raw_record_id: 'raw_alpha_2',
        }),
      ]);

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        left_ref: 'alpha_en',
        right_ref: 'alpha_en_2',
        status: 'pending',
      });
      expect(candidates[0]?.score_structural).toBeGreaterThan(0);
    });

    it('should generate a stable candidate id regardless of observation input order', async () => {
      const observations = [
        makeObservation('zeta_b', {
          surface_form: 'Project Zeta',
          normalized_form: 'project zeta',
          source_raw_record_id: 'raw_zeta_b',
        }),
        makeObservation('zeta_a', {
          surface_form: 'Project Zeta',
          normalized_form: 'project zeta',
          source_raw_record_id: 'raw_zeta_a',
        }),
      ];

      const candidates = await generateResolutionCandidates(observations);

      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.id).toBe('candidate_zeta_a_zeta_b');
      expect(candidates[0]?.left_ref).toBe('zeta_a');
      expect(candidates[0]?.right_ref).toBe('zeta_b');
    });

    it('should generate a candidate when structured identifiers match', async () => {
      const candidates = await generateResolutionCandidates([
        makeObservation('alpha_mail_1', {
          surface_form: 'owner@example.com',
          normalized_form: 'owner@example.com',
        }),
        makeObservation('alpha_mail_2', {
          surface_form: 'OWNER@example.com',
          normalized_form: 'owner@example.com',
          source_raw_record_id: 'raw_mail_2',
        }),
      ]);

      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.score_string).toBeGreaterThan(0);
    });
  });

  describe('AC #3: cross-language cases can enter the queue through embedding/context evidence', () => {
    it('probes same-language pairs across scopes when embedding scoring is enabled', async () => {
      const candidates = await generateResolutionCandidates(
        [
          makeObservation('alpha_same_lang_scope_a', {
            observation_type: 'channel',
            entity_kind_hint: 'project',
            surface_form: 'Alpha North',
            normalized_form: 'alpha north',
            lang: 'en',
            script: 'Latn',
            context_summary: 'roadmap planning summit',
            scope_kind: 'channel',
            scope_id: 'scope-a',
            source_raw_record_id: 'raw_alpha_same_lang_scope_a',
          }),
          makeObservation('alpha_same_lang_scope_b', {
            observation_type: 'channel',
            entity_kind_hint: 'project',
            surface_form: 'Alpha Core',
            normalized_form: 'alpha core',
            lang: 'en',
            script: 'Latn',
            context_summary: 'billing audit retrospective',
            scope_kind: 'channel',
            scope_id: 'scope-b',
            source_raw_record_id: 'raw_alpha_same_lang_scope_b',
          }),
        ],
        {
          embeddingScorer: vi.fn(async () => 0.86),
          topN: 5,
        }
      );

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        left_ref: 'alpha_same_lang_scope_a',
        right_ref: 'alpha_same_lang_scope_b',
        score_embedding: 0.86,
      });
    });

    it('probes high-similarity multilingual pairs across scopes when embedding scoring is enabled', async () => {
      const candidates = await generateResolutionCandidates(
        [
          makeObservation('alpha_en_scope_a', {
            surface_form: 'Project Alpha',
            normalized_form: 'project alpha',
            scope_id: 'scope-a',
            source_raw_record_id: 'raw_alpha_en_scope_a',
          }),
          makeObservation('alpha_ko_scope_b', {
            surface_form: KOREAN_PROJECT_ALPHA,
            normalized_form: KOREAN_PROJECT_ALPHA,
            lang: 'ko',
            script: 'Hang',
            scope_id: 'scope-b',
            source_raw_record_id: 'raw_alpha_ko_scope_b',
          }),
        ],
        {
          embeddingScorer: vi.fn(async () => 0.86),
          topN: 5,
        }
      );

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        left_ref: 'alpha_en_scope_a',
        right_ref: 'alpha_ko_scope_b',
        score_embedding: 0.86,
      });
    });

    it('should generate a multilingual candidate when embedding similarity is high', async () => {
      const candidates = await generateResolutionCandidates(
        [
          makeObservation('alpha_ko', {
            surface_form: KOREAN_PROJECT_ALPHA,
            normalized_form: KOREAN_PROJECT_ALPHA,
            lang: 'ko',
            script: 'Hang',
          }),
          makeObservation('alpha_ja', {
            surface_form: JAPANESE_PROJECT_ALPHA,
            normalized_form: JAPANESE_PROJECT_ALPHA,
            lang: 'ja',
            script: 'Jpan',
            source_raw_record_id: 'raw_alpha_ja',
          }),
        ],
        {
          embeddingScorer: vi.fn(async () => 0.93),
        }
      );

      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.score_embedding).toBe(0.93);
      expect(candidates[0]?.score_context).toBeGreaterThan(0);
    });

    it('should raise EmbeddingUnavailableError when the scorer fails', async () => {
      await expect(
        generateResolutionCandidates(
          [
            makeObservation('alpha_ko_fail', {
              surface_form: KOREAN_PROJECT_ALPHA,
              normalized_form: KOREAN_PROJECT_ALPHA,
              lang: 'ko',
              script: 'Hang',
            }),
            makeObservation('alpha_ja_fail', {
              surface_form: JAPANESE_PROJECT_ALPHA,
              normalized_form: JAPANESE_PROJECT_ALPHA,
              lang: 'ja',
              script: 'Jpan',
              source_raw_record_id: 'raw_alpha_ja_fail',
            }),
          ],
          {
            embeddingScorer: vi.fn(async () => {
              throw new EmbeddingUnavailableError({
                model: 'multilingual-e5-large',
              });
            }),
          }
        )
      ).rejects.toBeInstanceOf(EmbeddingUnavailableError);
    });

    it('keeps zero-score pairs when an embedding scorer is available', async () => {
      const candidates = await generateResolutionCandidates(
        [
          makeObservation('alpha_ko_zero', {
            surface_form: KOREAN_PROJECT_ALPHA,
            normalized_form: KOREAN_PROJECT_ALPHA,
            lang: 'ko',
            script: 'Hang',
            context_summary: 'launch alpha',
            related_surface_forms: ['runtime-linked'],
          }),
          makeObservation('alpha_ja_zero', {
            surface_form: JAPANESE_PROJECT_ALPHA,
            normalized_form: JAPANESE_PROJECT_ALPHA,
            lang: 'ja',
            script: 'Jpan',
            context_summary: 'milestone beta',
            related_surface_forms: ['runtime-linked'],
            source_raw_record_id: 'raw_alpha_ja_zero',
          }),
        ],
        {
          embeddingScorer: vi.fn(async () => 0.88),
        }
      );

      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.score_structural).toBe(0);
      expect(candidates[0]?.score_string).toBe(0);
      expect(candidates[0]?.score_embedding).toBe(0.88);
    });

    it('drops deterministic zero-score pairs when embedding scoring also returns zero', async () => {
      const candidates = await generateResolutionCandidates(
        [
          makeObservation('alpha_zero_a', {
            observation_type: 'author',
            entity_kind_hint: 'person',
            surface_form: 'Kim',
            normalized_form: 'kim',
            lang: 'en',
            script: 'Latn',
            context_summary: 'totally different context',
            related_surface_forms: ['shared-room'],
            scope_kind: 'global',
            scope_id: null,
            source_raw_record_id: 'raw_alpha_zero_a',
          }),
          makeObservation('alpha_zero_b', {
            observation_type: 'author',
            entity_kind_hint: 'person',
            surface_form: 'Lee',
            normalized_form: 'lee',
            lang: 'en',
            script: 'Latn',
            context_summary: 'another unrelated note',
            related_surface_forms: ['shared-room'],
            scope_kind: 'global',
            scope_id: null,
            source_raw_record_id: 'raw_alpha_zero_b',
          }),
        ],
        {
          embeddingScorer: vi.fn(async () => 0),
          topN: 5,
        }
      );

      expect(candidates).toHaveLength(0);
    });

    it('keeps only the highest-scoring candidate for a repeated multilingual pair family', async () => {
      const embeddingScorer = vi.fn(async (left: EntityObservation, right: EntityObservation) => {
        const scopedPair = [left.id, right.id].sort().join('::');
        if (scopedPair === 'alpha_en_scope_b::alpha_es_scope_c') {
          return 0.92;
        }
        if (scopedPair === 'jaehun_en_scope_a::jaehun_ko_scope_d') {
          return 0.88;
        }
        return 0.84;
      });

      const candidates = await generateResolutionCandidates(
        [
          makeObservation('alpha_en_scope_a', {
            surface_form: 'Project Alpha',
            normalized_form: 'project alpha',
            scope_id: 'scope-a',
            source_raw_record_id: 'raw_alpha_en_scope_a_dupe',
          }),
          makeObservation('alpha_en_scope_b', {
            surface_form: 'Project Alpha',
            normalized_form: 'project alpha',
            scope_id: 'scope-b',
            source_raw_record_id: 'raw_alpha_en_scope_b',
          }),
          makeObservation('alpha_es_scope_c', {
            surface_form: 'Proyecto Alpha',
            normalized_form: 'proyecto alpha',
            lang: 'es',
            script: 'Latn',
            scope_id: 'scope-c',
            source_raw_record_id: 'raw_alpha_es_scope_c',
          }),
          makeObservation('jaehun_en_scope_a', {
            observation_type: 'author',
            entity_kind_hint: 'person',
            surface_form: 'Jae Hun',
            normalized_form: 'jae hun',
            scope_id: 'scope-a',
            related_surface_forms: ['Project Alpha'],
            source_raw_record_id: 'raw_jaehun_en_scope_a',
          }),
          makeObservation('jaehun_ko_scope_d', {
            observation_type: 'author',
            entity_kind_hint: 'person',
            surface_form: KOREAN_PERSON_JAEHUN,
            normalized_form: KOREAN_PERSON_JAEHUN,
            lang: 'ko',
            script: 'Hang',
            scope_id: 'scope-d',
            related_surface_forms: [KOREAN_PROJECT_ALPHA],
            source_raw_record_id: 'raw_jaehun_ko_scope_d',
          }),
        ],
        {
          embeddingScorer,
          topN: 5,
        }
      );

      expect(candidates).toHaveLength(2);
      expect(candidates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            left_ref: 'alpha_en_scope_b',
            right_ref: 'alpha_es_scope_c',
            score_embedding: 0.92,
          }),
          expect.objectContaining({
            left_ref: 'jaehun_en_scope_a',
            right_ref: 'jaehun_ko_scope_d',
            score_embedding: 0.88,
          }),
        ])
      );
    });
  });

  describe('AC #4: top-N gate prevents candidate blowouts', () => {
    it('should call the embedding scorer for at most the configured top-N candidates', async () => {
      const observations = Array.from({ length: 120 }, (_, index) =>
        makeObservation(`bulk_${index}`, {
          surface_form: `Project Alpha ${index}`,
          normalized_form: 'project alpha',
          source_raw_record_id: `raw_bulk_${index}`,
          context_summary: `launch alpha ${index}`,
        })
      );

      const embeddingScorer = vi.fn(async () => 0.51);
      const candidates = await generateResolutionCandidates(observations, { embeddingScorer });

      expect(candidates).toHaveLength(ENTITY_EMBEDDING_TOPN);
      expect(embeddingScorer).toHaveBeenCalledTimes(ENTITY_EMBEDDING_TOPN);
    });

    it('should not call the embedding scorer for unrelated observations outside deterministic blocks', async () => {
      const observations = [
        makeObservation('alpha', {
          surface_form: 'Project Alpha',
          normalized_form: 'project alpha',
          context_summary: 'alpha launch milestone',
          source_raw_record_id: 'raw_alpha',
        }),
        makeObservation('beta', {
          surface_form: 'Project Beta',
          normalized_form: 'project beta',
          context_summary: 'beta hiring plan',
          source_raw_record_id: 'raw_beta',
        }),
        makeObservation('gamma', {
          surface_form: 'Project Gamma',
          normalized_form: 'project gamma',
          context_summary: 'gamma finance review',
          source_raw_record_id: 'raw_gamma',
        }),
      ];

      const embeddingScorer = vi.fn(async () => 0.7);
      const candidates = await generateResolutionCandidates(observations, { embeddingScorer });

      expect(candidates).toHaveLength(0);
      expect(embeddingScorer).not.toHaveBeenCalled();
    });
  });
});
