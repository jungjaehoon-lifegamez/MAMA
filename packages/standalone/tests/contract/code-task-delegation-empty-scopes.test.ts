import { describe, expect, it, vi } from 'vitest';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';
import type { AgentProcessManager } from '../../src/multi-agent/agent-process-manager.js';
import type { DelegationManager } from '../../src/multi-agent/delegation-manager.js';

describe('Story M1R: code-task delegation envelope boundary', () => {
  it('keeps legacy code-task delegate execution outside reactive envelope enforcement', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ response: 'done' });
    const getProcess = vi.fn().mockResolvedValue({
      sendMessage,
      getSessionId: vi.fn().mockReturnValue('delegate-session'),
    });
    const isDelegationAllowed = vi.fn().mockReturnValue({ allowed: true, reason: 'ok' });
    const buildDelegationPrompt = vi.fn(
      (sourceAgentId: string, task: string) => `[${sourceAgentId}] ${task}`
    );
    const executor = new GatewayToolExecutor({ envelopeIssuanceMode: 'enabled' });
    executor.setAgentProcessManager({
      getProcess,
      stopProcess: vi.fn(),
    } as unknown as AgentProcessManager);
    executor.setDelegationManager({
      isDelegationAllowed,
      buildDelegationPrompt,
    } as unknown as DelegationManager);

    const result = await executor.execute(
      'delegate',
      {
        agentId: 'developer',
        task: 'implement the code-task change',
      },
      {
        agentId: 'conductor',
        source: 'viewer',
        channelId: 'default',
        executionSurface: 'direct',
      }
    );

    expect(result).toMatchObject({
      success: true,
      data: expect.objectContaining({ agentId: 'developer', response: 'done' }),
    });
    expect(isDelegationAllowed).toHaveBeenCalledWith('conductor', 'developer');
    expect(getProcess).toHaveBeenCalledWith('viewer', 'default', 'developer');
  });
});
