/**
 * Tests for UltraWorkManager
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { UltraWorkManager } from '../../src/multi-agent/ultrawork.js';
import { UltraWorkStateManager } from '../../src/multi-agent/ultrawork-state.js';
import type { AgentPersonaConfig, UltraWorkConfig } from '../../src/multi-agent/types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

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

/**
 * Wait for an UltraWork session to complete (non-blocking startSession).
 * Polls session.active until it becomes false or timeout is reached.
 */
async function waitForSessionComplete(
  session: { active: boolean },
  timeoutMs = 5000,
  intervalMs = 10
): Promise<void> {
  const start = Date.now();
  while (session.active && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe('UltraWorkManager', () => {
  let manager: UltraWorkManager;
  const defaultConfig: UltraWorkConfig = {
    enabled: true,
    max_steps: 5,
    max_duration: 60000, // 1 min for tests
    phased_loop: false, // Legacy freeform for existing tests
    persist_state: false,
  };

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

  describe('startSession (freeform)', () => {
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
        'conductor',
        'Build the login page',
        agents,
        executeCallback,
        notifyCallback
      );

      // startSession is non-blocking; wait for the session loop to complete
      await waitForSessionComplete(session);

      expect(session.channelId).toBe('ch1');
      expect(session.leadAgentId).toBe('conductor');
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
        'conductor',
        'Build a full-stack app',
        agents,
        executeCallback,
        notifyCallback
      );

      await waitForSessionComplete(session);

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
        'conductor',
        'Infinite task',
        agents,
        executeCallback,
        notifyCallback
      );

      await waitForSessionComplete(session);

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
        'conductor',
        'Crashy task',
        agents,
        executeCallback,
        notifyCallback
      );

      await waitForSessionComplete(session);

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

      const session1 = await manager.startSession(
        'ch1',
        'conductor',
        'Task 1',
        agents,
        executeCallback,
        notifyCallback
      );
      await waitForSessionComplete(session1);

      const session2 = await manager.startSession(
        'ch1',
        'conductor',
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
        leadAgentId: 'conductor',
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
        leadAgentId: 'conductor',
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
        leadAgentId: 'conductor',
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
        leadAgentId: 'conductor',
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
      let resolve: () => void;
      const blocker = new Promise<void>((r) => {
        resolve = r;
      });
      const executeCallback = vi.fn().mockImplementation(async () => {
        await blocker;
        return { response: 'DONE', duration_ms: 50 };
      });
      const notifyCallback = vi.fn().mockResolvedValue(undefined);

      const sessionPromise = manager.startSession(
        'ch1',
        'conductor',
        'Long task',
        agents,
        executeCallback,
        notifyCallback
      );

      await new Promise((r) => setTimeout(r, 10));

      const _stopped = manager.stopSession('ch1');

      resolve!();
      await sessionPromise;

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

  // ==========================================================================
  // 3-Phase (Ralph Loop) Tests
  // ==========================================================================

  describe('Phased Loop (Ralph Loop)', () => {
    let phasedManager: UltraWorkManager;
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrawork-phased-'));
      const phasedConfig: UltraWorkConfig = {
        enabled: true,
        max_steps: 20,
        max_duration: 60000,
        phased_loop: true,
        persist_state: false, // Don't use default homedir
      };
      phasedManager = new UltraWorkManager(phasedConfig);
      // Inject temp state manager
      phasedManager.setStateManager(new UltraWorkStateManager(tempDir));
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('should run 3 phases: plan -> build -> retro', async () => {
      let callCount = 0;
      const executeCallback = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // Phase 1: Planning response
          return {
            response:
              '## Implementation Plan\n### Task 1: Build API\n- Assigned to: developer\nPLAN_COMPLETE',
            duration: 100,
          };
        }
        if (callCount === 2) {
          // Phase 2: Building response
          return { response: 'All tasks executed. BUILD_COMPLETE', duration: 200 };
        }
        if (callCount === 3) {
          // Phase 3: Retrospective response
          return { response: 'All tasks completed successfully. RETRO_COMPLETE', duration: 100 };
        }
        return { response: 'DONE', duration: 50 };
      });
      const notifyCallback = vi.fn().mockResolvedValue(undefined);

      const session = await phasedManager.startSession(
        'ch1',
        'conductor',
        'Build login feature',
        agents,
        executeCallback,
        notifyCallback
      );

      await waitForSessionComplete(session);

      expect(session.active).toBe(false);

      // Should have planning step
      const planStep = session.steps.find((s) => s.action === 'planning');
      expect(planStep).toBeDefined();

      // Should have direct_work step (building phase)
      const buildStep = session.steps.find((s) => s.action === 'direct_work');
      expect(buildStep).toBeDefined();

      // Should have retrospective step
      const retroStep = session.steps.find((s) => s.action === 'retrospective');
      expect(retroStep).toBeDefined();

      // Notify should include phase messages
      const notifyCalls = notifyCallback.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(notifyCalls.some((msg) => msg.includes('Phase 1: Planning'))).toBe(true);
      expect(notifyCalls.some((msg) => msg.includes('Phase 2: Building'))).toBe(true);
      expect(notifyCalls.some((msg) => msg.includes('Phase 3: Retrospective'))).toBe(true);
      expect(notifyCalls.some((msg) => msg.includes('Session Complete'))).toBe(true);
    });

    it('should persist plan to disk when state manager is set', async () => {
      let callCount = 0;
      const executeCallback = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return { response: 'My plan content\nPLAN_COMPLETE', duration: 100 };
        }
        if (callCount === 2) {
          return { response: 'BUILD_COMPLETE', duration: 100 };
        }
        return { response: 'RETRO_COMPLETE', duration: 100 };
      });
      const notifyCallback = vi.fn().mockResolvedValue(undefined);

      const session = await phasedManager.startSession(
        'ch1',
        'conductor',
        'Test persist',
        agents,
        executeCallback,
        notifyCallback
      );

      await waitForSessionComplete(session);

      // Check plan was persisted
      const sm = phasedManager.getStateManager()!;
      const plan = await sm.loadPlan(session.id);
      expect(plan).toContain('My plan content');
    });

    it('should re-enter build phase when retro is incomplete', async () => {
      let callCount = 0;
      const executeCallback = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // Planning
          return { response: 'Plan ready. PLAN_COMPLETE', duration: 100 };
        }
        if (callCount === 2) {
          // First build
          return { response: 'Partial build. BUILD_COMPLETE', duration: 100 };
        }
        if (callCount === 3) {
          // Retrospective — incomplete
          return {
            response: 'Missing test coverage. RETRO_INCOMPLETE\n- Need unit tests',
            duration: 100,
          };
        }
        if (callCount === 4) {
          // Second build (re-entered)
          return { response: 'Tests added. BUILD_COMPLETE', duration: 100 };
        }
        // After re-entry, session completes (no second retro in current implementation)
        return { response: 'DONE', duration: 50 };
      });
      const notifyCallback = vi.fn().mockResolvedValue(undefined);

      const session = await phasedManager.startSession(
        'ch1',
        'conductor',
        'Build with retro loop',
        agents,
        executeCallback,
        notifyCallback
      );

      await waitForSessionComplete(session);

      expect(session.active).toBe(false);

      // Should have re-entered build phase
      const notifyCalls = notifyCallback.mock.calls.map((c: unknown[]) => c[0] as string);
      const buildPhaseNotices = notifyCalls.filter((msg) => msg.includes('Phase 2: Building'));
      expect(buildPhaseNotices.length).toBe(2); // Initial + re-entry

      expect(notifyCalls.some((msg) => msg.includes('Re-entering Build phase'))).toBe(true);
    });

    it('should use freeform loop when phased_loop=false', async () => {
      const freeformManager = new UltraWorkManager({
        enabled: true,
        max_steps: 5,
        max_duration: 60000,
        phased_loop: false,
        persist_state: false,
      });

      const executeCallback = vi.fn().mockResolvedValue({
        response: 'All done. DONE',
        duration: 50,
      });
      const notifyCallback = vi.fn().mockResolvedValue(undefined);

      const session = await freeformManager.startSession(
        'ch1',
        'conductor',
        'Simple task',
        agents,
        executeCallback,
        notifyCallback
      );

      await waitForSessionComplete(session);

      expect(session.active).toBe(false);

      // Should NOT have phase notifications (freeform mode)
      const notifyCalls = notifyCallback.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(notifyCalls.some((msg) => msg.includes('Phase 1: Planning'))).toBe(false);
    });

    it('should handle council interceptor during planning phase', async () => {
      let callCount = 0;
      const executeCallback = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // Planning with council_plan block
          return {
            response: 'Let me consult the team.\n```council_plan\n{"name":"review"}\n```',
            duration: 100,
          };
        }
        if (callCount === 2) {
          // Synthesis after council
          return { response: '## Final Plan\nTask 1: Build API\nPLAN_COMPLETE', duration: 100 };
        }
        if (callCount === 3) {
          return { response: 'BUILD_COMPLETE', duration: 100 };
        }
        return { response: 'RETRO_COMPLETE', duration: 100 };
      });
      const notifyCallback = vi.fn().mockResolvedValue(undefined);

      const responseInterceptor = vi.fn().mockImplementation(async (response: string) => {
        if (response.includes('council_plan')) {
          return { result: 'Council result: team agrees on approach', type: 'council' };
        }
        return null;
      });

      const session = await phasedManager.startSession(
        'ch1',
        'conductor',
        'Complex task',
        agents,
        executeCallback,
        notifyCallback,
        responseInterceptor
      );

      await waitForSessionComplete(session);

      expect(session.active).toBe(false);
      expect(responseInterceptor).toHaveBeenCalled();

      // Should have council_execution step
      const councilStep = session.steps.find((s) => s.action === 'council_execution');
      expect(councilStep).toBeDefined();

      // Should have plan_synthesis step
      const synthesisStep = session.steps.find((s) => s.action === 'plan_synthesis');
      expect(synthesisStep).toBeDefined();
    });

    it('should persist session phase transitions', async () => {
      let callCount = 0;
      const executeCallback = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return { response: 'PLAN_COMPLETE', duration: 100 };
        if (callCount === 2) return { response: 'BUILD_COMPLETE', duration: 100 };
        return { response: 'RETRO_COMPLETE', duration: 100 };
      });
      const notifyCallback = vi.fn().mockResolvedValue(undefined);

      const session = await phasedManager.startSession(
        'ch1',
        'conductor',
        'Phase tracking test',
        agents,
        executeCallback,
        notifyCallback
      );

      await waitForSessionComplete(session);

      // After completion, session state should be 'completed'
      const sm = phasedManager.getStateManager()!;
      const state = await sm.loadSession(session.id);
      expect(state).not.toBeNull();
      expect(state!.phase).toBe('completed');
    });

    it('should persist retrospective to disk', async () => {
      let callCount = 0;
      const executeCallback = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return { response: 'PLAN_COMPLETE', duration: 100 };
        if (callCount === 2) return { response: 'BUILD_COMPLETE', duration: 100 };
        return { response: 'All good. Lessons: use TDD next time. RETRO_COMPLETE', duration: 100 };
      });
      const notifyCallback = vi.fn().mockResolvedValue(undefined);

      const session = await phasedManager.startSession(
        'ch1',
        'conductor',
        'Retro persist test',
        agents,
        executeCallback,
        notifyCallback
      );

      await waitForSessionComplete(session);

      const retroFile = path.join(tempDir, session.id, 'retrospective.md');
      const content = await fs.readFile(retroFile, 'utf-8');
      expect(content).toContain('Lessons: use TDD');
    });

    it('should include mode label in start notification', async () => {
      let callCount = 0;
      const executeCallback = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return { response: 'PLAN_COMPLETE', duration: 100 };
        if (callCount === 2) return { response: 'BUILD_COMPLETE', duration: 100 };
        return { response: 'RETRO_COMPLETE', duration: 100 };
      });
      const notifyCallback = vi.fn().mockResolvedValue(undefined);

      const session = await phasedManager.startSession(
        'ch1',
        'conductor',
        'Mode test',
        agents,
        executeCallback,
        notifyCallback
      );

      await waitForSessionComplete(session);

      const startNotify = notifyCallback.mock.calls[0][0] as string;
      expect(startNotify).toContain('Phased (Plan->Build->Retro)');
    });
  });
});
