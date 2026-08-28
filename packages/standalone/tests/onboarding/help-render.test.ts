import { describe, expect, it } from 'vitest';
import { renderContractIntro } from '../../src/onboarding/agent-contract.js';

describe('Story ONB-3: CLI help is the onboarding entry point', () => {
  describe('AC #1: the static contract teaches entry without a scripted sequence', () => {
    it('names the product, points to status, and discloses human-required work', () => {
      const text = renderContractIntro();

      expect(text).toContain('MAMA');
      expect(text).toContain('mama status');
      expect(text).toMatch(/human/i);
      expect(text).not.toMatch(/step\s*1/i);
    });
  });
});
