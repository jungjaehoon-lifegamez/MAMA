import { describe, expect, it, vi } from 'vitest';

import { DelegationExecutor } from '../../src/agent/delegation-executor.js';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';

function createMamaApiMock() {
  return {
    save: vi.fn().mockResolvedValue({ success: true, id: 'decision_vnext_manual' }),
    saveCheckpoint: vi.fn().mockResolvedValue({ success: true, id: 'checkpoint_vnext_manual' }),
    listDecisions: vi.fn(),
    suggest: vi.fn(),
    updateOutcome: vi.fn(),
    loadCheckpoint: vi.fn(),
    beginModelRun: vi.fn().mockResolvedValue({
      model_run_id: 'mr_vnext_manual',
      gateway_call_id: 'gw_vnext_manual',
    }),
    commitModelRun: vi.fn().mockResolvedValue({ model_run_id: 'mr_vnext_manual' }),
    failModelRun: vi.fn().mockResolvedValue({ model_run_id: 'mr_vnext_manual' }),
    appendToolTrace: vi.fn().mockResolvedValue({ ok: true }),
  };
}

function createViewerAdminContext() {
  return {
    source: 'viewer',
    platform: 'viewer' as const,
    roleName: 'os_agent',
    role: {
      allowedTools: ['*'],
      systemControl: true,
      sensitiveAccess: true,
    },
    session: {
      sessionId: 'viewer-session',
      startedAt: new Date(),
    },
    capabilities: ['All tools'],
    limitations: [],
  };
}

describe('Story PR5.4: vNext Delegation Authority', () => {
  describe('AC #1: workers cannot nest durable delegation in vNext mode', () => {
    it('denies delegate at GatewayToolExecutor before spawning a sub-agent', async () => {
      const executor = new GatewayToolExecutor({
        mamaApi: {
          save: vi.fn(),
          saveCheckpoint: vi.fn(),
          listDecisions: vi.fn(),
          suggest: vi.fn(),
          updateOutcome: vi.fn(),
          loadCheckpoint: vi.fn(),
        },
        vNextRuntimeEnabled: true,
      });

      const result = await executor.execute(
        'delegate',
        { agentId: 'wiki-agent', task: 'Write durable wiki update' },
        {
          executionSurface: 'model_tool',
          agentId: 'wiki-agent',
          source: 'system',
          channelId: 'system:wiki-agent',
        }
      );

      expect(result).toMatchObject({
        success: false,
        code: 'vnext_worker_delegation_denied',
      });
    });

    it('lets DelegationExecutor enforce an injected authority denial', async () => {
      const executor = new DelegationExecutor({
        agentProcessManager: null,
        delegationManagerRef: null,
        retryDelayMs: 1,
        resolveManagedAgentId: (id) => id,
        checkViewerOnly: () => null,
        checkDelegationAuthority: () => ({
          allowed: false,
          code: 'vnext_worker_delegation_denied',
          reason: 'vNext workers must return proposals instead of delegating.',
        }),
      });

      const result = await executor.runDelegate(
        { agentId: 'dashboard-agent', task: 'Nested worker task' },
        { agentId: 'wiki-agent', source: 'system', channelId: 'system:wiki-agent' }
      );

      expect(result).toEqual({
        success: false,
        code: 'vnext_worker_delegation_denied',
        error: 'vNext workers must return proposals instead of delegating.',
      });
    });

    it('requires direct viewer-admin surface for manual vNext memory commits', async () => {
      const mamaApi = createMamaApiMock();
      const executor = new GatewayToolExecutor({
        mamaApi,
        vNextRuntimeEnabled: true,
        envelopeIssuanceMode: 'off',
      });
      const input = {
        type: 'decision',
        topic: 'operator authority',
        decision: 'Manual commits require a direct viewer-admin surface.',
        reasoning: 'Viewer-admin roles can be present on model-tool calls.',
      };
      const viewerAdminContext = createViewerAdminContext();

      const modelToolResult = await executor.execute('mama_save', input, {
        executionSurface: 'model_tool',
        source: 'viewer',
        agentId: 'os-agent',
        channelId: 'viewer-session',
        agentContext: viewerAdminContext,
      });

      expect(modelToolResult).toMatchObject({
        success: false,
        code: 'vnext_worker_proposal_required',
      });
      expect(mamaApi.save).not.toHaveBeenCalled();

      const directResult = await executor.execute('mama_save', input, {
        executionSurface: 'direct',
        source: 'viewer',
        agentId: 'os-agent',
        channelId: 'viewer-session',
        agentContext: viewerAdminContext,
      });

      expect(directResult).toMatchObject({ success: true });
      expect(mamaApi.save).toHaveBeenCalledOnce();
    });
  });
});
