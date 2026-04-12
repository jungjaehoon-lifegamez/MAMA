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

function makeObservation(
  id: string,
  overrides: Partial<EntityObservation> = {}
): EntityObservation {
  return {
    id,
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

describe('Story E1.5: Canonical entity candidate generation', () => {
  describe('AC #1: deterministic preprocessing removes duplicate raw observations', () => {
    it('should dedupe observations by connector and raw record id', () => {
      const deduped = dedupeObservationsBySource([
        makeObservation('one', {
          source_raw_record_id: 'raw_dup',
          context_summary: 'older',
        }),
        makeObservation('two', {
          source_raw_record_id: 'raw_dup',
          context_summary: 'newer',
          timestamp_observed: 1710000000001,
        }),
      ]);

      expect(deduped).toHaveLength(1);
      expect(deduped[0]?.id).toBe('one');
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
      await generateResolutionCandidates(observations, { embeddingScorer });

      expect(embeddingScorer.mock.calls.length).toBeLessThanOrEqual(ENTITY_EMBEDDING_TOPN);
    });
  });
});
