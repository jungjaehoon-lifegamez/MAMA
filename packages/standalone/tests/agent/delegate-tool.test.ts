/**
 * Unit tests for the delegate gateway tool handler
 *
 * Tests:
 * - Permission checks via DelegationManager (tier, can_delegate, enabled, self-delegation)
 * - buildDelegationPrompt output
 * - Sync delegation success/error response format
 * - Background delegation response format
 * - Multi-agent not configured error
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DelegationManager } from '../../src/multi-agent/delegation-manager.js';
import { ToolPermissionManager } from '../../src/multi-agent/tool-permission-manager.js';
import type { AgentPersonaConfig } from '../../src/multi-agent/types.js';
import { GatewayToolExecutor } from '../../src/agent/gateway-tool-executor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<AgentPersonaConfig> & { id: string }): AgentPersonaConfig {
  return {
    name: overrides.id,
    display_name: overrides.id,
    trigger_prefix: `!${overrides.id}`,
    persona_file: '',
    auto_respond_keywords: [],
    tier: 1,
    can_delegate: false,
    enabled: true,
    ...overrides,
  };
}

// Default agent set used across tests
const conductor = makeAgent({ id: 'conductor', tier: 1, can_delegate: true });
const developer = makeAgent({ id: 'developer', tier: 2, can_delegate: false });
const reviewer = makeAgent({ id: 'reviewer', tier: 2, can_delegate: false });
const disabledAgent = makeAgent({ id: 'disabled-agent', tier: 2, enabled: false });

const allAgents = [conductor, developer, reviewer, disabledAgent];

// ---------------------------------------------------------------------------
// Permission tests (using real DelegationManager — no mocks)
// ---------------------------------------------------------------------------

describe('DelegationManager permission checks', () => {
  let dm: DelegationManager;

  beforeEach(() => {
    dm = new DelegationManager(allAgents, new ToolPermissionManager());
  });

  it('allows tier 1 with can_delegate to delegate to tier 2', () => {
    const result = dm.isDelegationAllowed('conductor', 'developer');
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('ok');
  });

  it('blocks tier 2 agent from delegating', () => {
    const result = dm.isDelegationAllowed('developer', 'reviewer');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('cannot delegate');
  });

  it('blocks delegation to disabled agent', () => {
    const result = dm.isDelegationAllowed('conductor', 'disabled-agent');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('disabled');
  });

  it('blocks self-delegation', () => {
    const result = dm.isDelegationAllowed('conductor', 'conductor');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('self');
  });

  it('blocks delegation from unknown source agent', () => {
    const result = dm.isDelegationAllowed('nonexistent', 'developer');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Unknown source agent');
  });

  it('blocks delegation to unknown target agent', () => {
    const result = dm.isDelegationAllowed('conductor', 'nonexistent');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Unknown target agent');
  });
});

// ---------------------------------------------------------------------------
// buildDelegationPrompt tests
// ---------------------------------------------------------------------------

describe('DelegationManager.buildDelegationPrompt', () => {
  let dm: DelegationManager;

  beforeEach(() => {
    dm = new DelegationManager(allAgents, new ToolPermissionManager());
  });

  it('produces prompt with from-agent display name and task', () => {
    const prompt = dm.buildDelegationPrompt('conductor', 'Fix the login bug');
    expect(prompt).toContain('conductor');
    expect(prompt).toContain('Fix the login bug');
    expect(prompt).toContain('Delegated Task');
    expect(prompt).toContain('DONE');
  });

  it('includes do-not-re-delegate instruction', () => {
    const prompt = dm.buildDelegationPrompt('conductor', 'Review PR #42');
    expect(prompt).toContain('Do NOT delegate');
  });
});

// ---------------------------------------------------------------------------
// GatewayToolExecutor delegate handler tests
// ---------------------------------------------------------------------------

describe('GatewayToolExecutor delegate handler', () => {
  let executor: GatewayToolExecutor;
  let dm: DelegationManager;

  // Mock AgentProcessManager with a fake sendMessage
  const mockSendMessage = vi.fn().mockResolvedValue({ response: 'Task completed.' });
  const mockGetProcess = vi.fn().mockResolvedValue({ sendMessage: mockSendMessage });

  const mockAgentProcessManager = {
    getProcess: mockGetProcess,
  } as unknown as import('../../src/multi-agent/agent-process-manager.js').AgentProcessManager;

  beforeEach(() => {
    vi.clearAllMocks();

    dm = new DelegationManager(allAgents, new ToolPermissionManager());

    executor = new GatewayToolExecutor({
      mamaApi: {
        save: vi.fn(),
        saveCheckpoint: vi.fn(),
        listDecisions: vi.fn(),
        suggest: vi.fn(),
        updateOutcome: vi.fn(),
        loadCheckpoint: vi.fn(),
      },
    });

    executor.setAgentProcessManager(mockAgentProcessManager);
    executor.setDelegationManager(dm);
    executor.setCurrentAgentContext('conductor', 'discord', 'channel-123');
  });

  it('returns error when multi-agent is not configured', async () => {
    // Create a fresh executor without setting process manager / delegation manager
    const bareExecutor = new GatewayToolExecutor({
      mamaApi: {
        save: vi.fn(),
        saveCheckpoint: vi.fn(),
        listDecisions: vi.fn(),
        suggest: vi.fn(),
        updateOutcome: vi.fn(),
        loadCheckpoint: vi.fn(),
      },
    });

    const result = await bareExecutor.execute('delegate', {
      agentId: 'developer',
      task: 'Fix bug',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Multi-agent not configured');
  });

  it('returns error when delegation is denied (tier 2 delegating)', async () => {
    executor.setCurrentAgentContext('developer', 'discord', 'channel-123');

    const result = await executor.execute('delegate', {
      agentId: 'reviewer',
      task: 'Review code',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Delegation denied');
    expect(result.error).toContain('cannot delegate');
  });

  it('returns success for synchronous delegation', async () => {
    const result = await executor.execute('delegate', {
      agentId: 'developer',
      task: 'Implement login feature',
    });

    expect(result.success).toBe(true);
    expect((result as { data: { agentId: string } }).data.agentId).toBe('developer');
    expect((result as { data: { response: string } }).data.response).toBe('Task completed.');
    expect((result as { data: { duration_ms: number } }).data.duration_ms).toBeGreaterThanOrEqual(
      0
    );

    // Verify delegation prompt was used
    expect(mockSendMessage).toHaveBeenCalledOnce();
    const sentPrompt = mockSendMessage.mock.calls[0][0];
    expect(sentPrompt).toContain('Delegated Task');
    expect(sentPrompt).toContain('Implement login feature');
  });

  it('returns success for background delegation', async () => {
    const result = await executor.execute('delegate', {
      agentId: 'developer',
      task: 'Run linter in background',
      background: true,
    });

    expect(result.success).toBe(true);
    expect((result as { data: { background: boolean } }).data.background).toBe(true);
    expect((result as { data: { agentId: string } }).data.agentId).toBe('developer');
  });

  it('returns error when process sendMessage fails', async () => {
    mockSendMessage.mockRejectedValueOnce(new Error('Process crashed'));

    const result = await executor.execute('delegate', {
      agentId: 'developer',
      task: 'Do something',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Delegation to developer failed');
    expect(result.error).toContain('Process crashed');
  });

  it('returns error for self-delegation', async () => {
    const result = await executor.execute('delegate', {
      agentId: 'conductor',
      task: 'Self-referential task',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Delegation denied');
    expect(result.error).toContain('self');
  });

  it('returns error for delegation to disabled agent', async () => {
    const result = await executor.execute('delegate', {
      agentId: 'disabled-agent',
      task: 'Task for disabled agent',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Delegation denied');
    expect(result.error).toContain('disabled');
  });
});
