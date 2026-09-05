import { describe, it, expect } from 'vitest';
import { TypeDefinitionGenerator } from '../../src/agent/code-act/type-definition-generator.js';
import { projectCodeActToolPolicy } from '../../src/agent/code-act/tool-policy.js';
import { HostBridge } from '../../src/agent/code-act/host-bridge.js';
import { CODE_ACT_METADATA_DECLARATIONS } from '../../src/agent/code-act/constants.js';

const TOOL_DESCRIBE_MAX_NAMES = 4;

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
      expect(dts).toContain('telegram_send');
    });

    it('includes category headers', () => {
      const dts = TypeDefinitionGenerator.generate(policy(1));
      expect(dts).toContain('// --- memory ---');
      expect(dts).toContain('// --- file ---');
      expect(dts).toContain('// --- communication ---');
      expect(dts).toContain('// --- os ---');
    });

    it('uses compact declaration output without per-function JSDoc blocks', () => {
      const dts = TypeDefinitionGenerator.generate(policy(1));
      expect(dts).toContain('// Args: Read({path:"/file"}) or Read("/file")');
      expect(dts).toContain('declare function mama_search');
      expect(dts).toContain('declare function context_compile');
      expect(dts).not.toContain('/**');
    });

    it('TG-03/TG-04 wraps parameterized tool declarations in one input object', () => {
      const dts = TypeDefinitionGenerator.generate(policy(1, ['Write']));

      expect(dts).toContain('declare function Write(input:{path: string,content: string}): true;');
    });

    it('TG-03/TG-04 makes the input object optional when every field is optional', () => {
      const dts = TypeDefinitionGenerator.generate(policy(1, ['mama_search']));

      expect(dts).toContain('declare function mama_search(input?:{query?: string');
      expect(dts).not.toContain('declare function mama_search(input:{');
    });

    it('TG-03/TG-04 keeps zero-parameter tool declarations callable with no input', () => {
      const dts = TypeDefinitionGenerator.generate(policy(2, ['report_request']));

      expect(dts).toContain('declare function report_request(): { message: string };');
      expect(dts).not.toContain('report_request(input:');
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

    it('TG-04 projects the revision and verified-review evidence ABI on task_update', () => {
      const dts = TypeDefinitionGenerator.generate(policy(2, ['task_update']));
      expect(dts).toMatch(/declare function task_update[\s\S]*expected_revision\?: number/);
      expect(dts).toMatch(/declare function task_update[\s\S]*context_packet_id\?: string/);
      expect(dts).toMatch(/declare function task_update[\s\S]*review_anchor_ref\?: string/);
      expect(dts).toMatch(/declare function task_update[\s\S]*latest_event\?: string/);
      expect(dts).toMatch(/declare function task_update[\s\S]*latestEvent: string \| null/);
    });

    it('Story TG-04/TG-06 AC #1 projects task_temporal_reconcile as an outcome-discriminated union', () => {
      const dts = TypeDefinitionGenerator.generate(policy(2, ['task_temporal_reconcile']));
      const declaration = dts
        .split('\n')
        .find((line) => line.startsWith('declare function task_temporal_reconcile('));
      expect(declaration).toBeDefined();

      // The validator accepts evidence_summary ONLY on final_no_update and
      // next_temporal_check_at ONLY on deferred, and REQUIRES each there. A flat
      // `evidence_summary?: string` advertises a field the model may add to any
      // outcome, which the host then rejects with a hashed error the model cannot
      // read. The signature must say exactly what each outcome accepts.
      expect(declaration).not.toContain('evidence_summary?:');
      expect(declaration).not.toContain('next_temporal_check_at?:');
      expect(declaration).toMatch(
        /^declare function task_temporal_reconcile\(input:\{context_packet_id: string,expected_revision: number,reason: string,outcome: 'resolved',status: 'pending' \| 'in_progress' \| 'review' \| 'blocked' \| 'done' \| 'cancelled',due_at\?: string \| null\} \| \{context_packet_id: string,expected_revision: number,reason: string,outcome: 'resolved',status\?: 'pending' \| 'in_progress' \| 'review' \| 'blocked' \| 'done' \| 'cancelled',due_at: string \| null\} \| \{context_packet_id: string,expected_revision: number,reason: string,outcome: 'final_no_update',evidence_summary: string\} \| \{context_packet_id: string,expected_revision: number,reason: string,outcome: 'deferred',next_temporal_check_at: string\}\): \{receipt:\{taskId:number;workorderAttemptId:number;outcome:string\}\};$/
      );
    });

    it('TG-04 leaves declarations without an explicit input type on the generated object form', () => {
      const dts = TypeDefinitionGenerator.generate(
        policy(2, ['task_update', 'contract_no_update'])
      );
      expect(dts).toContain('declare function task_update(input:{id: number,');
      expect(dts).toContain(
        'declare function contract_no_update(input:{reason: string,scope: string}): { note: { id: number } };'
      );
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

    it('injects a COMPACT progressive bootstrap, not the whole catalog', () => {
      // The runtime no longer injects the full .d.ts. The bootstrap is ONLY the
      // two discovery primitives; every business tool is reached on demand via
      // tool_search/tool_describe. So the acceptance is the actual injected
      // surface: tiny, and NOT an enumeration of the catalog.
      expect(CODE_ACT_METADATA_DECLARATIONS).toContain('declare function tool_search(');
      expect(CODE_ACT_METADATA_DECLARATIONS).toContain('declare function tool_describe(');
      expect(CODE_ACT_METADATA_DECLARATIONS.length).toBeLessThan(400);
      // Representative business tools are discovered, never enumerated at bootstrap.
      for (const name of ['trello_kanban', 'task_list', 'board_read', 'context_compile']) {
        expect(CODE_ACT_METADATA_DECLARATIONS).not.toContain(name);
      }
      // The bootstrap is a small fraction of the complete catalog it replaces.
      const wholeCatalog = TypeDefinitionGenerator.generate(policy(1));
      expect(CODE_ACT_METADATA_DECLARATIONS.length).toBeLessThan(wholeCatalog.length * 0.1);
    });

    it('bounds the largest on-demand tool_describe batch and keeps each contract complete', () => {
      // tool_describe returns 1..4 COMPLETE contracts. The user-facing cost is
      // that worst-case batch, not the whole catalog: it must stay a bounded,
      // small fraction of the full surface while remaining complete (metadata
      // @field lines plus the declaration for every selected tool).
      const registry = HostBridge.getToolRegistry();
      const contracts = registry
        .map((meta) => TypeDefinitionGenerator.generateContract(meta))
        .sort((left, right) => right.length - left.length);
      expect(contracts.length).toBeGreaterThan(TOOL_DESCRIBE_MAX_NAMES);
      const largestBatch = contracts.slice(0, TOOL_DESCRIBE_MAX_NAMES);
      const batchText = largestBatch.join('\n');
      // Describing the WHOLE catalog on demand would be every contract at once;
      // even the four heaviest are a small fraction of that - the progressive win.
      const allContracts = contracts.join('\n');
      expect(batchText.length).toBeLessThan(allContracts.length * 0.5);
      // Each contract is complete: its metadata comment and its declaration.
      for (const contract of largestBatch) {
        expect(contract).toContain('@field');
        expect(contract).toContain('declare function');
      }
    });
  });

  describe('estimateTokens', () => {
    it('estimates the complete-catalog cost as chars/4 (a correctness relation, not an injected budget)', () => {
      // estimateTokens is a generator utility over the COMPLETE catalog, which is
      // no longer injected (the runtime injects the bootstrap and discovers the
      // rest). So the assertion is the definition itself - the estimate tracks the
      // generated length - rather than a stale absolute ceiling on an unshipped
      // surface.
      const dts = TypeDefinitionGenerator.generate(policy(1));
      expect(TypeDefinitionGenerator.estimateTokens(policy(1))).toBe(Math.ceil(dts.length / 4));
      expect(TypeDefinitionGenerator.estimateTokens(policy(1))).toBeGreaterThan(100);
    });

    it('Tier 2 uses fewer tokens than Tier 1', () => {
      const t1 = TypeDefinitionGenerator.estimateTokens(policy(1));
      const t2 = TypeDefinitionGenerator.estimateTokens(policy(2));
      expect(t2).toBeLessThan(t1);
    });
  });
});
