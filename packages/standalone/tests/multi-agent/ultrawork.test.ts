/**
 * Tests for UltraWorkManager
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UltraWorkManager } from '../../src/multi-agent/ultrawork.js';
import type { AgentPersonaConfig, UltraWorkConfig } from '../../src/multi-agent/types.js';

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

describe('UltraWorkManager', () => {
  let manager: UltraWorkManager;
  const defaultConfig: UltraWorkConfig = {
    enabled: true,
    max_steps: 5,
    max_duration: 60000, // 1 min for tests
  };

  const agents: AgentPersonaConfig[] = [
    makeAgent({
      id: 'sisyphus',
      name: 'Sisyphus',
      display_name: '🏔️ Sisyphus',
      tier: 1,
      can_delegate: true,
    }),
    makeAgent({ id: 'developer', name: 'Developer', display_name: '🔧 Developer', tier: 2 }),
    makeAgent({ id: 'reviewer', name: 'Reviewer', display_name: '📝 Reviewer', tier: 3 }),
  ];

  beforeEach(() => {
    manager = new UltraWorkManager(defaultConfig);
  });

  describe('isUltraWorkTrigger', () => {
    it('should detect "ultrawork" keyword', () => {
      expect(manager.isUltraWorkTrigger('Start ultrawork on this task')).toBe(true);
    });

    it('should detect Korean trigger "울트라워크"', () => {
      expect(manager.isUltraWorkTrigger('울트라워크 모드로 작업해줘')).toBe(true);
    });

    it('should detect "deep work" keyword', () => {
      expect(manager.isUltraWorkTrigger('Do deep work on this feature')).toBe(true);
    });

    it('should detect "autonomous" keyword', () => {
      expect(manager.isUltraWorkTrigger('Run this in autonomous mode')).toBe(true);
    });

    it('should be case-insensitive', () => {
      expect(manager.isUltraWorkTrigger('ULTRAWORK please')).toBe(true);
    });

    it('should return false for non-trigger content', () => {
      expect(manager.isUltraWorkTrigger('Hello, please fix this bug')).toBe(false);
    });

    it('should return false when disabled', () => {
      const disabled = new UltraWorkManager({ enabled: false });
      expect(disabled.isUltraWorkTrigger('ultrawork please')).toBe(false);
    });

    it('should support custom trigger keywords', () => {
      const custom = new UltraWorkManager({
        enabled: true,
        trigger_keywords: ['GOTIME'],
      });
      expect(custom.isUltraWorkTrigger('GOTIME build the app')).toBe(true);
      expect(custom.isUltraWorkTrigger('ultrawork build the app')).toBe(false);
    });
  });

  describe('startSession', () => {
    it('should start a session and run to completion', async () => {
      let callCount = 0;
      const executeCallback = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return { response: 'Working on step 1. DONE', duration_ms: 100 };
        }
        return { response: 'DONE', duration_ms: 50 };
      });
      const notifyCallback = vi.fn().mockResolvedValue(undefined);

      const session = await manager.startSession(
        'ch1',
        'sisyphus',
        'Build the login page',
        agents,
        executeCallback,
        notifyCallback
      );

      expect(session.channelId).toBe('ch1');
      expect(session.leadAgentId).toBe('sisyphus');
      expect(session.task).toBe('Build the login page');
      expect(session.active).toBe(false); // Completed
      expect(session.steps.length).toBeGreaterThanOrEqual(1);
      expect(notifyCallback).toHaveBeenCalledTimes(2); // Start + Complete
    });

    it('should handle delegation during session', async () => {
      let callCount = 0;
      const executeCallback = vi.fn().mockImplementation(async (agentId: string) => {
        callCount++;
        if (callCount === 1) {
          // Lead agent delegates
          return {
            response: 'Let me delegate. DELEGATE::developer::Build the API',
            duration_ms: 100,
          };
        }
        if (callCount === 2 && agentId === 'developer') {
          // Developer completes delegated task
          return { response: 'API built. DONE', duration_ms: 200 };
        }
        // Lead agent continues after delegation
        return { response: 'All steps complete. DONE', duration_ms: 50 };
      });
      const notifyCallback = vi.fn().mockResolvedValue(undefined);

      const session = await manager.startSession(
        'ch1',
        'sisyphus',
        'Build a full-stack app',
        agents,
        executeCallback,
        notifyCallback
      );

      expect(session.active).toBe(false);
      expect(session.steps.length).toBeGreaterThanOrEqual(2);
      // Should have delegation step
      const delegationStep = session.steps.find((s) => s.isDelegation);
      expect(delegationStep).toBeDefined();
    });

    it('should stop at max steps', async () => {
      const executeCallback = vi.fn().mockResolvedValue({
        response: "I'll continue with more work",
        duration_ms: 50,
      });
      const notifyCallback = vi.fn().mockResolvedValue(undefined);

      const session = await manager.startSession(
        'ch1',
        'sisyphus',
        'Infinite task',
        agents,
        executeCallback,
        notifyCallback
      );

      expect(session.active).toBe(false);
      // Should stop at or near maxSteps (5 configured + continuation retries might stop earlier)
      expect(session.currentStep).toBeLessThanOrEqual(defaultConfig.max_steps! + 1);
    });

    it('should reject non-Tier-1 lead agent', async () => {
      const executeCallback = vi.fn();
      const notifyCallback = vi.fn();

      await expect(
        manager.startSession(
          'ch1',
          'developer',
          'Some task',
          agents,
          executeCallback,
          notifyCallback
        )
      ).rejects.toThrow('Tier 1');
    });

    it('should reject unknown lead agent', async () => {
      const executeCallback = vi.fn();
      const notifyCallback = vi.fn();

      await expect(
        manager.startSession(
          'ch1',
          'nonexistent',
          'Some task',
          agents,
          executeCallback,
          notifyCallback
        )
      ).rejects.toThrow('Unknown lead agent');
    });

    it('should handle execution errors gracefully', async () => {
      let callCount = 0;
      const executeCallback = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Process crashed');
        }
        // After error recovery, complete
        return { response: 'Recovered. DONE', duration_ms: 50 };
      });
      const notifyCallback = vi.fn().mockResolvedValue(undefined);

      const session = await manager.startSession(
        'ch1',
        'sisyphus',
        'Crashy task',
        agents,
        executeCallback,
        notifyCallback
      );

      // Should have recovered and continued
      const errorStep = session.steps.find((s) => s.action === 'error');
      expect(errorStep).toBeDefined();
      expect(session.steps.length).toBeGreaterThan(1);
    });

    it('should replace existing session on same channel', async () => {
      const executeCallback = vi.fn().mockResolvedValue({
        response: 'DONE',
        duration_ms: 50,
      });
      const notifyCallback = vi.fn().mockResolvedValue(undefined);

      await manager.startSession(
        'ch1',
        'sisyphus',
        'Task 1',
        agents,
        executeCallback,
        notifyCallback
      );
      const session2 = await manager.startSession(
        'ch1',
        'sisyphus',
        'Task 2',
        agents,
        executeCallback,
        notifyCallback
      );

      expect(session2.task).toBe('Task 2');
    });
  });

  describe('shouldContinue', () => {
    it('should return false when session is inactive', () => {
      const session = {
        id: 'test',
        channelId: 'ch1',
        leadAgentId: 'sisyphus',
        task: 'test',
        currentStep: 0,
        maxSteps: 10,
        startTime: Date.now(),
        maxDuration: 60000,
        active: false,
        steps: [],
      };
      expect(manager.shouldContinue(session)).toBe(false);
    });

    it('should return false when max steps reached', () => {
      const session = {
        id: 'test',
        channelId: 'ch1',
        leadAgentId: 'sisyphus',
        task: 'test',
        currentStep: 10,
        maxSteps: 10,
        startTime: Date.now(),
        maxDuration: 60000,
        active: true,
        steps: [],
      };
      expect(manager.shouldContinue(session)).toBe(false);
    });

    it('should return false when max duration exceeded', () => {
      const session = {
        id: 'test',
        channelId: 'ch1',
        leadAgentId: 'sisyphus',
        task: 'test',
        currentStep: 0,
        maxSteps: 10,
        startTime: Date.now() - 120000,
        maxDuration: 60000,
        active: true,
        steps: [],
      };
      expect(manager.shouldContinue(session)).toBe(false);
    });

    it('should return true when within limits', () => {
      const session = {
        id: 'test',
        channelId: 'ch1',
        leadAgentId: 'sisyphus',
        task: 'test',
        currentStep: 3,
        maxSteps: 10,
        startTime: Date.now(),
        maxDuration: 60000,
        active: true,
        steps: [],
      };
      expect(manager.shouldContinue(session)).toBe(true);
    });
  });

  describe('stopSession', () => {
    it('should stop and return an active session', async () => {
      // Start a long-running session
      let resolve: () => void;
      const blocker = new Promise<void>((r) => {
        resolve = r;
      });
      const executeCallback = vi.fn().mockImplementation(async () => {
        await blocker;
        return { response: 'DONE', duration_ms: 50 };
      });
      const notifyCallback = vi.fn().mockResolvedValue(undefined);

      // Start session in background (will block on first step)
      const sessionPromise = manager.startSession(
        'ch1',
        'sisyphus',
        'Long task',
        agents,
        executeCallback,
        notifyCallback
      );

      // Give the session a moment to start
      await new Promise((r) => setTimeout(r, 10));

      // Stop it
      const stopped = manager.stopSession('ch1');

      // Unblock so the promise can resolve
      resolve!();
      await sessionPromise;

      // The session should have been stopped
      expect(manager.getSession('ch1')).toBeNull();
    });

    it('should return null for non-existent session', () => {
      expect(manager.stopSession('nonexistent')).toBeNull();
    });
  });

  describe('getActiveSessions', () => {
    it('should return empty when no sessions', () => {
      expect(manager.getActiveSessions()).toEqual([]);
    });
  });

  describe('isEnabled', () => {
    it('should reflect config', () => {
      expect(manager.isEnabled()).toBe(true);

      const disabled = new UltraWorkManager({ enabled: false });
      expect(disabled.isEnabled()).toBe(false);
    });
  });

  describe('updateConfig', () => {
    it('should update configuration', () => {
      manager.updateConfig({ enabled: false });
      expect(manager.isEnabled()).toBe(false);
    });
  });
});
