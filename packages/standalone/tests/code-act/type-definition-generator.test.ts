import { describe, it, expect } from 'vitest';
import { TypeDefinitionGenerator } from '../../src/agent/code-act/type-definition-generator.js';

describe('TypeDefinitionGenerator', () => {
  describe('generate', () => {
    it('generates valid declaration syntax for Tier 1', () => {
      const dts = TypeDefinitionGenerator.generate(1);
      expect(dts).toContain('declare function');
      expect(dts).toContain('mama_search');
      expect(dts).toContain('Read');
      expect(dts).toContain('Write');
      expect(dts).toContain('Bash');
      expect(dts).toContain('discord_send');
      expect(dts).toContain('browser_navigate');
    });

    it('includes category headers', () => {
      const dts = TypeDefinitionGenerator.generate(1);
      expect(dts).toContain('// --- memory ---');
      expect(dts).toContain('// --- file ---');
      expect(dts).toContain('// --- communication ---');
      expect(dts).toContain('// --- browser ---');
      expect(dts).toContain('// --- os ---');
    });

    it('includes JSDoc descriptions', () => {
      const dts = TypeDefinitionGenerator.generate(1);
      expect(dts).toContain('/** Search decisions and checkpoints */');
      expect(dts).toContain('/** Read file contents */');
    });

    it('marks optional params with ?', () => {
      const dts = TypeDefinitionGenerator.generate(1);
      expect(dts).toMatch(/query\?: string/);
    });

    it('marks required params without ?', () => {
      const dts = TypeDefinitionGenerator.generate(1);
      expect(dts).toMatch(/path: string/);
    });

    it('filters to read-only for Tier 2', () => {
      const dts = TypeDefinitionGenerator.generate(2);
      expect(dts).toContain('mama_search');
      expect(dts).toContain('Read');
      expect(dts).not.toContain('declare function Write');
      expect(dts).not.toContain('declare function Bash');
      expect(dts).not.toContain('declare function discord_send');
    });

    it('Tier 3 matches Tier 2', () => {
      const t2 = TypeDefinitionGenerator.generate(2);
      const t3 = TypeDefinitionGenerator.generate(3);
      expect(t3).toBe(t2);
    });

    it('stays within token budget (~2000 chars for Tier 1)', () => {
      const dts = TypeDefinitionGenerator.generate(1);
      expect(dts.length).toBeLessThan(5000);
    });
  });

  describe('estimateTokens', () => {
    it('returns reasonable token estimate', () => {
      const tokens = TypeDefinitionGenerator.estimateTokens(1);
      expect(tokens).toBeGreaterThan(100);
      expect(tokens).toBeLessThan(2000);
    });

    it('Tier 2 uses fewer tokens than Tier 1', () => {
      const t1 = TypeDefinitionGenerator.estimateTokens(1);
      const t2 = TypeDefinitionGenerator.estimateTokens(2);
      expect(t2).toBeLessThan(t1);
    });
  });
});
