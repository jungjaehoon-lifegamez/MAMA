import { describe, expect, it } from 'vitest';
import { InvalidEntityLabelError } from '../../src/entities/errors.js';
import {
  detectScript,
  extractStructuredIdentifiers,
  normalizeEntityLabel,
} from '../../src/entities/normalization.js';

const KOREAN_PROJECT_ALPHA = '\uD504\uB85C\uC81D\uD2B8 \uC54C\uD30C';
const JAPANESE_PROJECT_ALPHA = '\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u30A2\u30EB\u30D5\u30A1';

describe('Story E1.4: Multilingual entity normalization', () => {
  describe('AC #1: labels are normalized without destroying source scripts', () => {
    it('should normalize whitespace and casing for latin labels', () => {
      expect(normalizeEntityLabel('  Project   Alpha  ')).toEqual({
        original: '  Project   Alpha  ',
        normalized: 'project alpha',
        script: 'Latn',
      });
    });

    it('should preserve Korean text while normalizing spacing', () => {
      expect(normalizeEntityLabel(`  ${KOREAN_PROJECT_ALPHA}  `)).toEqual({
        original: `  ${KOREAN_PROJECT_ALPHA}  `,
        normalized: KOREAN_PROJECT_ALPHA,
        script: 'Hang',
      });
    });

    it('should preserve Japanese text instead of transliterating it away', () => {
      expect(normalizeEntityLabel(` ${JAPANESE_PROJECT_ALPHA} `)).toEqual({
        original: ` ${JAPANESE_PROJECT_ALPHA} `,
        normalized: JAPANESE_PROJECT_ALPHA,
        script: 'Jpan',
      });
    });
  });

  describe('AC #2: script detection is explicit', () => {
    it('should detect Latin labels', () => {
      expect(detectScript('Project Alpha')).toBe('Latn');
    });

    it('should detect Korean labels', () => {
      expect(detectScript(KOREAN_PROJECT_ALPHA)).toBe('Hang');
    });

    it('should detect Japanese labels', () => {
      expect(detectScript(JAPANESE_PROJECT_ALPHA)).toBe('Jpan');
    });

    it('should report mixed-script labels explicitly', () => {
      expect(detectScript(`Alpha ${KOREAN_PROJECT_ALPHA}`)).toBe('Mixed');
    });
  });

  describe('AC #3: structured identifiers are extracted deterministically', () => {
    it('should extract emails, handles, and domains', () => {
      expect(
        extractStructuredIdentifiers('Reach owner@example.com or @alpha via launch.example.com')
      ).toEqual({
        emails: ['owner@example.com'],
        handles: ['alpha'],
        domains: ['launch.example.com'],
      });
    });
  });

  describe('AC #4: invalid inputs fail loudly', () => {
    it('should throw InvalidEntityLabelError for nullish input', () => {
      expect(() => normalizeEntityLabel(null)).toThrow(InvalidEntityLabelError);
    });

    it('should throw InvalidEntityLabelError for non-string input', () => {
      expect(() => normalizeEntityLabel(42)).toThrow(InvalidEntityLabelError);
    });
  });
});
