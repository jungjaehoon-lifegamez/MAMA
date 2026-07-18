/**
 * Story SMALLFIX-1: decision id slugs for non-ASCII topics
 *
 * Korean-only topics used to collapse into bare underscore runs
 * ("decision_______<ts>_<rand>") - unreadable and near-colliding. The slug
 * now collapses runs and falls back to a stable topic hash; the verbatim
 * topic stays in the topic column.
 */

import { describe, expect, it } from 'vitest';
import { buildDecisionId } from '../src/memory/api.js';

// prettier-ignore
const koreanTopicKeywords = ['보고_언어_정책', '카나리아 SR 파츠분리', '외주 검수 규칙'];

describe('Story SMALLFIX-1: buildDecisionId slugging', () => {
  describe('AC #1: ascii topics keep readable slugs', () => {
    it('collapses separators without losing ascii content', () => {
      expect(buildDecisionId('database_choice')).toMatch(
        /^decision_database_choice_\d+_[a-f0-9-]{8}$/
      );
      expect(buildDecisionId('API contract!! v2')).toMatch(/^decision_api_contract_v2_\d+_/);
    });
  });

  describe('AC #2: non-ascii topics fall back to a stable hash, never underscore runs', () => {
    it.each(koreanTopicKeywords)('slugs: %s', (topic) => {
      const id = buildDecisionId(topic);
      expect(id).not.toMatch(/__/);
      expect(id).not.toMatch(/^decision__/);
    });

    it('pure-korean topic gets a deterministic hash slug', () => {
      const a = buildDecisionId(koreanTopicKeywords[0]);
      const b = buildDecisionId(koreanTopicKeywords[0]);
      const slugA = a.split('_')[1];
      const slugB = b.split('_')[1];
      expect(slugA).toBe(slugB);
      expect(slugA).toMatch(/^t[a-f0-9]{8}$/);
    });

    it('mixed topics keep the ascii part', () => {
      const id = buildDecisionId(koreanTopicKeywords[1] + '_KMS2019_v2');
      expect(id).toContain('sr');
      expect(id).toContain('kms2019');
      expect(id).not.toMatch(/__/);
    });
  });
});
