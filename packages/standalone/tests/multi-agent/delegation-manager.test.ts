/**
 * Tests for DelegationManager
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DelegationManager } from '../../src/multi-agent/delegation-manager.js';
import type { AgentPersonaConfig } from '../../src/multi-agent/types.js';

function makeAgent(overrides: Partial<AgentPersonaConfig> = {}): AgentPersonaConfig {
  return {
    id: 'test',
    name: 'Test',
    display_name: 'Test',
    trigger_prefix: '!test',
    persona_file: '~/.mama/personas/test.md',
    ...overrides,
  };
}

describe('DelegationManager', () => {
  let manager: DelegationManager;
  const agents: AgentPersonaConfig[] = [
    makeAgent({
      id: 'conductor',
      name: 'Conductor',
      display_name: '🎯 Conductor',
      tier: 1,
      can_delegate: true,
    }),
    makeAgent({ id: 'developer', name: 'Developer', display_name: '🔧 Developer', tier: 2 }),
    makeAgent({ id: 'reviewer', name: 'Reviewer', display_name: '📝 Reviewer', tier: 3 }),
    makeAgent({ id: 'disabled', name: 'Disabled', display_name: 'Disabled', enabled: false }),
  ];

  beforeEach(() => {
    manager = new DelegationManager(agents);
  });

  describe('parseDelegation', () => {
    it('should parse valid DELEGATE pattern', () => {
      const response = 'Let me delegate this. DELEGATE::developer::Implement the login feature';
      const result = manager.parseDelegation('conductor', response);

      expect(result).not.toBeNull();
      expect(result!.fromAgentId).toBe('conductor');
      expect(result!.toAgentId).toBe('developer');
      expect(result!.task).toBe('Implement the login feature');
    });

    it('should extract original content without DELEGATE pattern', () => {
      const response = 'I will handle the planning. DELEGATE::developer::Build the API';
      const result = manager.parseDelegation('conductor', response);

      expect(result).not.toBeNull();
      expect(result!.originalContent).toBe('I will handle the planning.');
    });

    it('should return null when no DELEGATE pattern exists', () => {
      const response = 'Here is my regular response without any delegation.';
      const result = manager.parseDelegation('conductor', response);
      expect(result).toBeNull();
    });

    it('should handle multiline task descriptions', () => {
      const response =
        'DELEGATE::reviewer::Review this code:\n- Check error handling\n- Verify types';
      const result = manager.parseDelegation('conductor', response);

      expect(result).not.toBeNull();
      expect(result!.task).toContain('Check error handling');
      expect(result!.task).toContain('Verify types');
    });

    it('should trim whitespace from task', () => {
      const response = 'DELEGATE::developer::  Some task with spaces  ';
      const result = manager.parseDelegation('conductor', response);
      expect(result!.task).toBe('Some task with spaces');
    });

    it('should parse agent IDs with hyphens', () => {
      const response = 'DELEGATE::my-custom-agent::Build the feature';
      const result = manager.parseDelegation('conductor', response);

      expect(result).not.toBeNull();
      expect(result!.toAgentId).toBe('my-custom-agent');
      expect(result!.task).toBe('Build the feature');
    });
  });

  describe('isDelegationAllowed', () => {
    it('should allow Tier 1 with can_delegate to delegate', () => {
      const result = manager.isDelegationAllowed('conductor', 'developer');
      expect(result.allowed).toBe(true);
    });

    it('should reject delegation from Tier 2 agent', () => {
      const result = manager.isDelegationAllowed('developer', 'reviewer');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('cannot delegate');
    });

    it('should reject self-delegation', () => {
      const result = manager.isDelegationAllowed('conductor', 'conductor');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('self');
    });

    it('should reject delegation to disabled agent', () => {
      const result = manager.isDelegationAllowed('conductor', 'disabled');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('disabled');
    });

    it('should reject delegation to unknown agent', () => {
      const result = manager.isDelegationAllowed('conductor', 'nonexistent');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Unknown target');
    });

    it('should reject delegation from unknown agent', () => {
      const result = manager.isDelegationAllowed('nonexistent', 'developer');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Unknown source');
    });
  });

  describe('executeDelegation', () => {
    it('should execute delegation successfully', async () => {
      const executeCallback = vi.fn().mockResolvedValue({
        response: 'Task completed. DONE',
        duration_ms: 500,
      });
      const notifyCallback = vi.fn().mockResolvedValue(undefined);

      const request = {
        fromAgentId: 'conductor',
        toAgentId: 'developer',
        task: 'Implement login',
        originalContent: 'Delegating this task.',
      };

      const result = await manager.executeDelegation(request, executeCallback, notifyCallback);

      expect(result.success).toBe(true);
      expect(result.response).toContain('Task completed');
      expect(result.duration).toBe(500);
      expect(executeCallback).toHaveBeenCalledOnce();
      expect(notifyCallback).toHaveBeenCalledOnce();
    });

    it('should include delegation context in execute callback', async () => {
      const executeCallback = vi.fn().mockResolvedValue({
        response: 'Done',
        duration_ms: 100,
      });

      const request = {
        fromAgentId: 'conductor',
        toAgentId: 'developer',
        task: 'Build the API',
        originalContent: '',
      };

      await manager.executeDelegation(request, executeCallback);

      const calledPrompt = executeCallback.mock.calls[0][1];
      expect(calledPrompt).toContain('Delegated Task');
      expect(calledPrompt).toContain('Conductor');
      expect(calledPrompt).toContain('Build the API');
      expect(calledPrompt).toContain('Do NOT delegate');
    });

    it('should fail for unauthorized delegation', async () => {
      const executeCallback = vi.fn();

      const request = {
        fromAgentId: 'developer', // Tier 2, cannot delegate
        toAgentId: 'reviewer',
        task: 'Review code',
        originalContent: '',
      };

      const result = await manager.executeDelegation(request, executeCallback);

      expect(result.success).toBe(false);
      expect(result.error).toContain('cannot delegate');
      expect(executeCallback).not.toHaveBeenCalled();
    });

    it('should handle execution errors gracefully', async () => {
      const executeCallback = vi.fn().mockRejectedValue(new Error('Process crashed'));

      const request = {
        fromAgentId: 'conductor',
        toAgentId: 'developer',
        task: 'Do something',
        originalContent: '',
      };

      const result = await manager.executeDelegation(request, executeCallback);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Process crashed');
    });

    it('should work without notify callback', async () => {
      const executeCallback = vi.fn().mockResolvedValue({
        response: 'Done',
        duration_ms: 100,
      });

      const request = {
        fromAgentId: 'conductor',
        toAgentId: 'developer',
        task: 'Build it',
        originalContent: '',
      };

      const result = await manager.executeDelegation(request, executeCallback);
      expect(result.success).toBe(true);
    });

    it('should prevent circular delegation', async () => {
      // Simulate conductor -> developer delegation is active
      const executeCallback = vi.fn().mockImplementation(async () => {
        // While this delegation is active, try reverse delegation
        const reverseCheck = manager.isDelegationAllowed('developer', 'conductor');
        expect(reverseCheck.allowed).toBe(false);
        expect(reverseCheck.reason).toContain('Reverse delegation');

        return { response: 'Done', duration_ms: 100 };
      });

      const request = {
        fromAgentId: 'conductor',
        toAgentId: 'developer',
        task: 'Build it',
        originalContent: '',
      };

      await manager.executeDelegation(request, executeCallback);
    });

    it('should clean up active delegation after completion', async () => {
      const executeCallback = vi.fn().mockResolvedValue({
        response: 'Done',
        duration_ms: 100,
      });

      const request = {
        fromAgentId: 'conductor',
        toAgentId: 'developer',
        task: 'Build it',
        originalContent: '',
      };

      expect(manager.getActiveDelegationCount()).toBe(0);
      await manager.executeDelegation(request, executeCallback);
      expect(manager.getActiveDelegationCount()).toBe(0); // Cleaned up
    });

    it('should clean up active delegation after error', async () => {
      const executeCallback = vi.fn().mockRejectedValue(new Error('crash'));

      const request = {
        fromAgentId: 'conductor',
        toAgentId: 'developer',
        task: 'Build it',
        originalContent: '',
      };

      await manager.executeDelegation(request, executeCallback);
      expect(manager.getActiveDelegationCount()).toBe(0); // Cleaned up even on error
    });
  });

  describe('updateAgents', () => {
    it('should update the agent list', () => {
      const newAgents = [
        makeAgent({ id: 'new_lead', tier: 1, can_delegate: true }),
        makeAgent({ id: 'new_worker', tier: 2 }),
      ];

      manager.updateAgents(newAgents);

      // Old agents should not be found
      const old = manager.isDelegationAllowed('conductor', 'developer');
      expect(old.allowed).toBe(false);

      // New agents should work
      const fresh = manager.isDelegationAllowed('new_lead', 'new_worker');
      expect(fresh.allowed).toBe(true);
    });
  });
});
