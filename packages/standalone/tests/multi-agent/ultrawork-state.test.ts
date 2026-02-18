/**
 * Tests for UltraWorkStateManager
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { UltraWorkStateManager } from '../../src/multi-agent/ultrawork-state.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('UltraWorkStateManager', () => {
  let manager: UltraWorkStateManager;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrawork-test-'));
    manager = new UltraWorkStateManager(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('createSession / loadSession', () => {
    it('should create and load a session', async () => {
      await manager.createSession('uw_1', 'Build the app', ['conductor', 'developer']);

      const session = await manager.loadSession('uw_1');
      expect(session).not.toBeNull();
      expect(session!.id).toBe('uw_1');
      expect(session!.task).toBe('Build the app');
      expect(session!.phase).toBe('planning');
      expect(session!.agents).toEqual(['conductor', 'developer']);
      expect(session!.createdAt).toBeGreaterThan(0);
      expect(session!.updatedAt).toBeGreaterThan(0);
    });

    it('should return null for non-existent session', async () => {
      const session = await manager.loadSession('nonexistent');
      expect(session).toBeNull();
    });

    it('should initialize progress.json as empty array', async () => {
      await manager.createSession('uw_1', 'task', ['a']);
      const progress = await manager.loadProgress('uw_1');
      expect(progress).toEqual([]);
    });
  });

  describe('updatePhase', () => {
    it('should update session phase', async () => {
      await manager.createSession('uw_1', 'task', ['a']);

      await manager.updatePhase('uw_1', 'building');
      let session = await manager.loadSession('uw_1');
      expect(session!.phase).toBe('building');

      await manager.updatePhase('uw_1', 'retrospective');
      session = await manager.loadSession('uw_1');
      expect(session!.phase).toBe('retrospective');

      await manager.updatePhase('uw_1', 'completed');
      session = await manager.loadSession('uw_1');
      expect(session!.phase).toBe('completed');
    });

    it('should update updatedAt timestamp', async () => {
      await manager.createSession('uw_1', 'task', ['a']);
      const before = (await manager.loadSession('uw_1'))!.updatedAt;

      // Small delay to ensure timestamp differs
      await new Promise((r) => setTimeout(r, 5));

      await manager.updatePhase('uw_1', 'building');
      const after = (await manager.loadSession('uw_1'))!.updatedAt;
      expect(after).toBeGreaterThanOrEqual(before);
    });

    it('should no-op for non-existent session', async () => {
      // Should not throw
      await manager.updatePhase('nonexistent', 'building');
    });
  });

  describe('savePlan / loadPlan', () => {
    it('should save and load plan', async () => {
      await manager.createSession('uw_1', 'task', ['a']);
      const plan = '## Tasks\n1. Build API\n2. Add tests';

      await manager.savePlan('uw_1', plan);
      const loaded = await manager.loadPlan('uw_1');
      expect(loaded).toBe(plan);
    });

    it('should return null for non-existent plan', async () => {
      await manager.createSession('uw_1', 'task', ['a']);
      const plan = await manager.loadPlan('uw_1');
      expect(plan).toBeNull();
    });
  });

  describe('recordStep / loadProgress', () => {
    it('should accumulate steps', async () => {
      await manager.createSession('uw_1', 'task', ['a']);

      await manager.recordStep('uw_1', {
        stepNumber: 1,
        agentId: 'conductor',
        action: 'planning',
        responseSummary: 'Created plan',
        isDelegation: false,
        duration: 100,
        timestamp: Date.now(),
      });

      await manager.recordStep('uw_1', {
        stepNumber: 2,
        agentId: 'developer',
        action: 'delegated_task',
        responseSummary: 'Built API',
        isDelegation: false,
        duration: 200,
        timestamp: Date.now(),
      });

      const progress = await manager.loadProgress('uw_1');
      expect(progress).toHaveLength(2);
      expect(progress[0].agentId).toBe('conductor');
      expect(progress[1].agentId).toBe('developer');
    });

    it('should return empty array for non-existent session', async () => {
      const progress = await manager.loadProgress('nonexistent');
      expect(progress).toEqual([]);
    });
  });

  describe('saveRetrospective', () => {
    it('should save retrospective file', async () => {
      await manager.createSession('uw_1', 'task', ['a']);
      const retro = '## Retrospective\n- All tasks completed\n- RETRO_COMPLETE';

      await manager.saveRetrospective('uw_1', retro);

      const content = await fs.readFile(path.join(tempDir, 'uw_1', 'retrospective.md'), 'utf-8');
      expect(content).toBe(retro);
    });
  });

  describe('deleteSession', () => {
    it('should remove session directory', async () => {
      await manager.createSession('uw_1', 'task', ['a']);
      await manager.deleteSession('uw_1');

      const session = await manager.loadSession('uw_1');
      expect(session).toBeNull();
    });

    it('should not throw for non-existent session', async () => {
      await manager.deleteSession('nonexistent');
    });
  });

  describe('listSessions', () => {
    it('should list all session directories', async () => {
      await manager.createSession('uw_1', 'task1', ['a']);
      await manager.createSession('uw_2', 'task2', ['b']);

      const sessions = await manager.listSessions();
      expect(sessions).toContain('uw_1');
      expect(sessions).toContain('uw_2');
      expect(sessions).toHaveLength(2);
    });

    it('should return empty array when no sessions', async () => {
      const sessions = await manager.listSessions();
      expect(sessions).toEqual([]);
    });

    it('should return empty array when base dir does not exist', async () => {
      const mgr = new UltraWorkStateManager('/nonexistent/path');
      const sessions = await mgr.listSessions();
      expect(sessions).toEqual([]);
    });
  });
});
