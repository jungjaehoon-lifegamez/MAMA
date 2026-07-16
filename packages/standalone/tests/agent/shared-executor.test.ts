import { describe, it, expect } from 'vitest';
import { AgentLoop } from '../../src/agent/agent-loop.js';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';

const loopExecutor = (loop: AgentLoop): unknown =>
  (loop as unknown as { mcpExecutor: unknown }).mcpExecutor;

describe('shared gateway executor (root fix for dual-wiring)', () => {
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
});
