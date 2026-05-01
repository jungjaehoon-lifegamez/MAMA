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

    it('uses compact declaration output without per-function JSDoc blocks', () => {
      const dts = TypeDefinitionGenerator.generate(1);
      expect(dts).toContain(
        '// Call with object: Read({path: "/file"}) or positional: Read("/file")'
      );
      expect(dts).toContain('declare function mama_search');
      expect(dts).toContain('declare function context_compile');
      expect(dts).not.toContain('/**');
    });

    it('marks optional params with ?', () => {
      const dts = TypeDefinitionGenerator.generate(1);
      expect(dts).toMatch(/query\?: string/);
      // Anchor to the mama_search declaration so an unrelated declaration
      // exposing `scopes?` would not silently keep this assertion green.
      expect(dts).toMatch(
        /declare function mama_search[\s\S]*scopes\?: Array<\{ kind: 'global' \| 'user' \| 'channel' \| 'project'; id: string \}>/
      );
    });

    it('advertises mama_search diagnostics and meta return fields', () => {
      const dts = TypeDefinitionGenerator.generate(1);
      // Anchor to the mama_search declaration so the assertion fails if those
      // return fields are removed from mama_search specifically.
      expect(dts).toMatch(
        /declare function mama_search[\s\S]*diagnostics\?: Record<string, unknown> \| null; meta\?: Record<string, unknown>/
      );
    });

    it('advertises context_compile scope, connector, temporal, seed refs, and packet return fields', () => {
      const dts = TypeDefinitionGenerator.generate(1);
      expect(dts).toMatch(
        /declare function context_compile[\s\S]*task: string[\s\S]*scopes\?: Array<\{ kind: 'global' \| 'user' \| 'channel' \| 'project'; id: string \}>[\s\S]*connectors\?: string\[\][\s\S]*seed_refs\?: Array<Record<string, unknown>>[\s\S]*range\?: \{ start_ms\?: number; end_ms\?: number \}[\s\S]*as_of\?: string \| number \| null[\s\S]*packet_id: string/
      );
    });

    it('marks required params without ?', () => {
      const dts = TypeDefinitionGenerator.generate(1);
      expect(dts).toMatch(/path: string/);
    });

    it('filters Tier 2 to read and memory-write tools', () => {
      const dts = TypeDefinitionGenerator.generate(2);
      expect(dts).toContain('mama_search');
      expect(dts).toContain('context_compile');
      expect(dts).toContain('Read');
      expect(dts).not.toContain('declare function Write');
      expect(dts).not.toContain('declare function Bash');
      expect(dts).not.toContain('declare function discord_send');
    });

    it('Tier 3 excludes durable mutation tools', () => {
      const t2 = TypeDefinitionGenerator.generate(2);
      const t3 = TypeDefinitionGenerator.generate(3);
      expect(t2).toContain('context_compile');
      expect(t3).not.toContain('context_compile');
    });

    it('stays within token budget for Tier 1', () => {
      const dts = TypeDefinitionGenerator.generate(1);
      expect(dts.length).toBeLessThan(7200);
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
