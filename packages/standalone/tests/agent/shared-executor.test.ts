import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../../src/agent/agent-loop.js';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import type { MAMAApiInterface, MAMAApiSetInput, SearchResultItem } from '../../src/agent/types.js';

const loopExecutor = (loop: AgentLoop): unknown =>
  (loop as unknown as { mcpExecutor: unknown }).mcpExecutor;

class IdentitySensitiveBootApi implements Omit<MAMAApiInterface, 'listDecisions'> {
  readonly #decisions: SearchResultItem[];

  readonly save: MAMAApiInterface['save'] = async () => ({
    success: true,
    id: 'decision_saved',
    type: 'decision',
  });

  readonly saveCheckpoint: MAMAApiInterface['saveCheckpoint'] = async () => ({
    success: true,
    id: 'checkpoint_saved',
    type: 'checkpoint',
  });

  readonly updateOutcome: MAMAApiInterface['updateOutcome'] = async () => ({ success: true });
  readonly loadCheckpoint: MAMAApiInterface['loadCheckpoint'] = async () => ({ success: true });

  constructor(decisions: SearchResultItem[]) {
    this.#decisions = decisions;
  }

  async list(options?: Parameters<MAMAApiInterface['listDecisions']>[0]): Promise<unknown[]> {
    return this.#decisions.slice(0, options?.limit);
  }

  async suggest(
    _query: string,
    options?: Parameters<MAMAApiInterface['suggest']>[1]
  ): ReturnType<MAMAApiInterface['suggest']> {
    const results = this.#decisions.slice(0, options?.limit);
    return { success: true, results, count: results.length };
  }
}

describe('Story BOUNDARY-1: shared gateway executor', () => {
  describe('AC #1: persona loop uses the injected boot-wired executor and per-call tool blocks', () => {
    it('uses the injected executor instead of constructing its own', () => {
      const shared = new GatewayToolExecutor({});
      const loop = new AgentLoop({} as never, {
        toolsConfig: { gateway: ['*'], mcp: [] },
        executor: shared,
      });
      expect(loopExecutor(loop)).toBe(shared);
    });

    it('boot wiring on the shared executor is visible to the persona loop', () => {
      const shared = new GatewayToolExecutor({});
      const loop = new AgentLoop({} as never, {
        toolsConfig: { gateway: ['*'], mcp: [] },
        executor: shared,
      });
      const fakeLedger = { list: () => [] } as never;
      shared.setTaskLedger(fakeLedger); // simulates start.ts:1067
      expect((loopExecutor(loop) as { getTaskLedger(): unknown }).getTaskLedger()).toBe(fakeLedger);
    });

    it('still constructs its own executor when none injected (memory agent / mama run)', () => {
      const loop = new AgentLoop({} as never, { toolsConfig: { gateway: ['*'], mcp: [] } });
      expect(loopExecutor(loop)).toBeInstanceOf(GatewayToolExecutor);
    });

    it('does NOT mutate instance-level disallowed tools on an injected executor', () => {
      const shared = new GatewayToolExecutor({});
      new AgentLoop({} as never, {
        toolsConfig: { gateway: ['*'], mcp: [] },
        executor: shared,
        disallowedTools: ['report_publish'],
      });
      // Instance-level set would leak the persona's blocks to dashboard-agent/code-act
      // callers of the shared executor. The list must flow per-call instead.
      expect(
        (shared as unknown as { disallowedGatewayTools: Set<string> }).disallowedGatewayTools.size
      ).toBe(0);
    });

    it('DENIES a tool via per-call context (end-to-end through normalize+merge)', async () => {
      // Regression guard for the silent-drop hazard: normalizeExecutionContext and
      // mergeWithFallbackExecutionContext are explicit-field whitelists - if either
      // drops disallowedGatewayTools, enforcement dies silently. This test fails then.
      const shared = new GatewayToolExecutor({});
      const result = await shared.execute(
        'report_publish',
        { slots: {} } as never,
        { disallowedGatewayTools: ['report_publish'] } as never
      );
      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('not available'),
      });
    });

    it('setMamaApi wires the API onto an already-constructed executor', () => {
      const shared = new GatewayToolExecutor({});
      const fakeApi: MAMAApiSetInput & { marker: string } = {
        marker: 'initMamaCore-instance',
        async save() {
          return { success: true, id: 'decision_saved', type: 'decision' };
        },
        async saveCheckpoint() {
          return { success: true, id: 'checkpoint_saved', type: 'checkpoint' };
        },
        async listDecisions() {
          return [];
        },
        async suggest() {
          return { success: true, results: [], count: 0 };
        },
        async updateOutcome() {
          return { success: true };
        },
        async loadCheckpoint() {
          return { success: true };
        },
      };
      shared.setMamaApi(fakeApi);
      expect((shared as unknown as { mamaApi: unknown }).mamaApi).toBe(fakeApi);
    });

    it('executes a no-query mama_search with the boot API list alias', async () => {
      const decision = {
        id: 'decision_boot_alias',
        topic: 'native parity',
        decision: 'Normalize the boot API alias once',
        created_at: '2026-07-21T00:00:00.000Z',
        type: 'decision' as const,
      };
      const list = vi.fn().mockResolvedValue([decision]);
      const bootApi = Object.freeze({
        save: vi.fn(),
        saveCheckpoint: vi.fn(),
        list,
        suggest: vi.fn(),
        updateOutcome: vi.fn(),
        loadCheckpoint: vi.fn(),
      });
      const shared = new GatewayToolExecutor({});
      shared.setMamaApi(bootApi);

      const result = await shared.execute('mama_search', {});

      expect('listDecisions' in bootApi).toBe(false);
      expect(list).toHaveBeenCalledWith({ limit: 10 });
      expect(result).toEqual({ success: true, results: [decision], count: 1 });
    });

    it('forwards non-list boot API methods with the original receiver', async () => {
      const decision: SearchResultItem = {
        id: 'decision_identity_sensitive',
        topic: 'native parity',
        decision: 'Bind forwarded methods to the original boot API',
        created_at: '2026-07-21T00:00:00.000Z',
        type: 'decision',
      };
      const bootApi: MAMAApiSetInput = Object.freeze(new IdentitySensitiveBootApi([decision]));
      const shared = new GatewayToolExecutor({});
      shared.setMamaApi(bootApi);

      const result = await shared.execute('mama_search', { query: 'native parity' });

      expect(result).toEqual({ success: true, results: [decision], count: 1 });
    });

    it('rejects boot wiring when neither list alias is available', () => {
      const shared = new GatewayToolExecutor({});
      const incompleteApi = {
        save: vi.fn(),
        saveCheckpoint: vi.fn(),
        suggest: vi.fn(),
        updateOutcome: vi.fn(),
        loadCheckpoint: vi.fn(),
      };

      expect(() => shared.setMamaApi(incompleteApi as unknown as MAMAApiSetInput)).toThrow(
        'MAMA API must provide listDecisions() or list()'
      );
    });
  });
});
