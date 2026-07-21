import { describe, it, expect } from 'vitest';
import { TypeDefinitionGenerator } from '../../src/agent/code-act/type-definition-generator.js';
import { projectCodeActToolPolicy } from '../../src/agent/code-act/tool-policy.js';

function policy(tier: 1 | 2 | 3, allowedTools?: string[]) {
  return projectCodeActToolPolicy({ tier, role: { allowedTools } });
}

describe('TypeDefinitionGenerator', () => {
  describe('generate', () => {
    it('generates valid declaration syntax for Tier 1', () => {
      const dts = TypeDefinitionGenerator.generate(policy(1));
      expect(dts).toContain('declare function');
      expect(dts).toContain('mama_search');
      expect(dts).toContain('Read');
      expect(dts).toContain('Write');
      expect(dts).toContain('Bash');
      expect(dts).toContain('discord_send');
      expect(dts).toContain('browser_navigate');
    });

    it('includes category headers', () => {
      const dts = TypeDefinitionGenerator.generate(policy(1));
      expect(dts).toContain('// --- memory ---');
      expect(dts).toContain('// --- file ---');
      expect(dts).toContain('// --- communication ---');
      expect(dts).toContain('// --- browser ---');
      expect(dts).toContain('// --- os ---');
    });

    it('uses compact declaration output without per-function JSDoc blocks', () => {
      const dts = TypeDefinitionGenerator.generate(policy(1));
      expect(dts).toContain(
        '// Call with object: Read({path: "/file"}) or positional: Read("/file")'
      );
      expect(dts).toContain('declare function mama_search');
      expect(dts).toContain('declare function context_compile');
      expect(dts).not.toContain('/**');
    });

    it('marks optional params with ?', () => {
      const dts = TypeDefinitionGenerator.generate(policy(1));
      expect(dts).toMatch(/query\?: string/);
      // Anchor to the mama_search declaration so an unrelated declaration
      // exposing `scopes?` would not silently keep this assertion green.
      expect(dts).toMatch(
        /declare function mama_search[\s\S]*scopes\?: Array<\{ kind: 'global' \| 'user' \| 'channel' \| 'project'; id: string \}>/
      );
    });

    it('advertises mama_search diagnostics and meta return fields', () => {
      const dts = TypeDefinitionGenerator.generate(policy(1));
      // Anchor to the mama_search declaration so the assertion fails if those
      // return fields are removed from mama_search specifically.
      expect(dts).toMatch(
        /declare function mama_search[\s\S]*diagnostics\?: Record<string, unknown> \| null; meta\?: Record<string, unknown>/
      );
    });

    it('advertises context_compile scope, connector, temporal, seed refs, and packet return fields', () => {
      const dts = TypeDefinitionGenerator.generate(policy(1));
      expect(dts).toMatch(
        /declare function context_compile[\s\S]*task: string[\s\S]*scopes\?: Array<\{ kind: 'global' \| 'user' \| 'channel' \| 'project'; id: string \}>[\s\S]*connectors\?: string\[\][\s\S]*seed_refs\?: Array<Record<string, unknown>>[\s\S]*range\?: \{ start_ms\?: number; end_ms\?: number \}[\s\S]*as_of\?: string \| number \| null[\s\S]*packet_id: string/
      );
    });

    it('advertises context_packet_id on mama_save decisions', () => {
      const dts = TypeDefinitionGenerator.generate(policy(1));
      expect(dts).toMatch(/declare function mama_save[\s\S]*context_packet_id\?: string/);
    });

    it('marks required params without ?', () => {
      const dts = TypeDefinitionGenerator.generate(policy(1));
      expect(dts).toMatch(/path: string/);
    });

    it('filters Tier 2 to read and memory-write tools', () => {
      const dts = TypeDefinitionGenerator.generate(policy(2));
      expect(dts).toContain('mama_search');
      expect(dts).toContain('context_compile');
      expect(dts).toContain('Read');
      expect(dts).not.toContain('declare function Write');
      expect(dts).not.toContain('declare function Bash');
      expect(dts).not.toContain('declare function discord_send');
    });

    it('Tier 3 excludes durable mutation tools', () => {
      const t2 = TypeDefinitionGenerator.generate(policy(2));
      const t3 = TypeDefinitionGenerator.generate(policy(3));
      expect(t2).toContain('context_compile');
      expect(t3).not.toContain('context_compile');
    });

    it('filters declarations to an explicit agent allowed-tool list', () => {
      const dts = TypeDefinitionGenerator.generate(
        policy(2, ['mama_search', 'agent_notices', 'report_publish', 'code_act'])
      );
      expect(dts).toContain('declare function mama_search');
      expect(dts).toContain('declare function agent_notices');
      expect(dts).toContain('declare function report_publish');
      expect(dts).not.toContain('declare function mama_save');
      expect(dts).not.toContain('declare function wiki_publish');
      expect(dts).not.toContain('declare function Read');
    });

    it('stays within token budget for Tier 1', () => {
      const dts = TypeDefinitionGenerator.generate(policy(1));
      // Includes the owner workflow and scoped recall declarations added to
      // the canonical HostBridge surface while retaining a hard prompt cap.
      expect(dts.length).toBeLessThan(10000);
    });
  });

  describe('estimateTokens', () => {
    it('returns reasonable token estimate', () => {
      const tokens = TypeDefinitionGenerator.estimateTokens(policy(1));
      expect(tokens).toBeGreaterThan(100);
      expect(tokens).toBeLessThan(2500);
    });

    it('Tier 2 uses fewer tokens than Tier 1', () => {
      const t1 = TypeDefinitionGenerator.estimateTokens(policy(1));
      const t2 = TypeDefinitionGenerator.estimateTokens(policy(2));
      expect(t2).toBeLessThan(t1);
    });
  });
});
