import { beforeAll, describe, expect, it, vi } from 'vitest';
import { HostBridge } from '../../src/agent/code-act/host-bridge.js';
import { CodeActSandbox } from '../../src/agent/code-act/sandbox.js';
import type { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import type { GatewayToolExecutionContext } from '../../src/agent/types.js';
import { makeSignedEnvelope } from './fixtures.js';

function makeExecutor(overrides?: Partial<GatewayToolExecutor>): GatewayToolExecutor {
  return {
    execute: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  } as unknown as GatewayToolExecutor;
}

describe('Story M1R: Code-Act envelope context propagation', () => {
  beforeAll(async () => {
    await CodeActSandbox.warmup();
  });

  describe('AC: forwards the active envelope context to host bridge gateway calls', () => {
    it('forwards the active envelope context to host bridge gateway calls', async () => {
      const executeFn = vi.fn().mockResolvedValue({
        success: true,
        results: [],
        count: 0,
      });
      const executionContext: GatewayToolExecutionContext = {
        agentId: 'chat_bot',
        source: 'telegram',
        channelId: 'tg:1',
        envelope: makeSignedEnvelope({
          source: 'telegram',
          channel_id: 'tg:1',
        }),
        executionSurface: 'code_act',
      };
      const bridge = new HostBridge(
        makeExecutor({ execute: executeFn }),
        undefined,
        executionContext
      );
      const sandbox = new CodeActSandbox();
      bridge.injectInto(sandbox, 1);

      const result = await sandbox.execute('mama_search({ query: "contracts" })');

      expect(result.success).toBe(true);
      expect(executeFn).toHaveBeenCalledWith(
        'mama_search',
        { query: 'contracts' },
        executionContext
      );
    });
  });
});
