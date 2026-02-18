/**
 * UltraWork State Manager
 *
 * File-based session state persistence for the Ralph Loop pattern.
 * Each session gets its own directory under ~/.mama/workspace/ultrawork/{session_id}/
 *
 * Directory structure:
 *   session.json     - Session metadata (task, phase, agents)
 *   plan.md          - Phase 1 result: implementation plan
 *   progress.json    - Completed steps array
 *   retrospective.md - Phase 3 result: retrospective notes
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

export type UltraWorkPhase = 'planning' | 'building' | 'retrospective' | 'completed';

export interface UltraWorkSessionState {
  id: string;
  task: string;
  phase: UltraWorkPhase;
  agents: string[];
  createdAt: number;
  updatedAt: number;
}

export interface UltraWorkStepRecord {
  stepNumber: number;
  agentId: string;
  action: string;
  responseSummary: string;
  isDelegation: boolean;
  duration: number;
  timestamp: number;
}

export class UltraWorkStateManager {
  private baseDir: string;
  private sessionLocks = new Map<string, Promise<void>>();

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(os.homedir(), '.mama', 'workspace', 'ultrawork');
  }

  /**
   * Validates sessionId to prevent path traversal attacks.
   * Only allows alphanumeric, hyphen, and underscore characters.
   */
  private validateSessionId(sessionId: string): void {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
      throw new Error(`Invalid sessionId: "${sessionId}" — must match /^[A-Za-z0-9_-]+$/`);
    }
    // Double-check with path resolution
    const resolved = path.resolve(this.baseDir, sessionId);
    const base = path.resolve(this.baseDir);
    if (!resolved.startsWith(base + path.sep)) {
      throw new Error(`Invalid sessionId: "${sessionId}" — path traversal detected`);
    }
  }

  private sessionDir(sessionId: string): string {
    this.validateSessionId(sessionId);
    return path.join(this.baseDir, sessionId);
  }

  /**
   * Executes a function with an exclusive lock on the given sessionId.
   * Prevents TOCTOU race conditions on read-modify-write operations.
   */
  private async withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((res) => {
      release = res;
    });
    const chained = prev.then(() => next);
    this.sessionLocks.set(sessionId, chained);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.sessionLocks.get(sessionId) === chained) {
        this.sessionLocks.delete(sessionId);
      }
    }
  }

  async createSession(sessionId: string, task: string, agents: string[]): Promise<void> {
    const dir = this.sessionDir(sessionId);
    await fs.mkdir(dir, { recursive: true });

    const state: UltraWorkSessionState = {
      id: sessionId,
      task,
      phase: 'planning',
      agents,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await fs.writeFile(path.join(dir, 'session.json'), JSON.stringify(state, null, 2));
    await fs.writeFile(path.join(dir, 'progress.json'), '[]');
  }

  async loadSession(sessionId: string): Promise<UltraWorkSessionState | null> {
    try {
      const data = await fs.readFile(
        path.join(this.sessionDir(sessionId), 'session.json'),
        'utf-8'
      );
      return JSON.parse(data) as UltraWorkSessionState;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  async updatePhase(sessionId: string, phase: UltraWorkPhase): Promise<void> {
    return this.withSessionLock(sessionId, async () => {
      const state = await this.loadSession(sessionId);
      if (!state) {
        return;
      }

      state.phase = phase;
      state.updatedAt = Date.now();

      await fs.writeFile(
        path.join(this.sessionDir(sessionId), 'session.json'),
        JSON.stringify(state, null, 2)
      );
    });
  }

  async savePlan(sessionId: string, plan: string): Promise<void> {
    await fs.writeFile(path.join(this.sessionDir(sessionId), 'plan.md'), plan);
  }

  async loadPlan(sessionId: string): Promise<string | null> {
    try {
      return await fs.readFile(path.join(this.sessionDir(sessionId), 'plan.md'), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  async recordStep(sessionId: string, step: UltraWorkStepRecord): Promise<void> {
    return this.withSessionLock(sessionId, async () => {
      const steps = await this.loadProgress(sessionId);
      steps.push(step);
      await fs.writeFile(
        path.join(this.sessionDir(sessionId), 'progress.json'),
        JSON.stringify(steps, null, 2)
      );
    });
  }

  async loadProgress(sessionId: string): Promise<UltraWorkStepRecord[]> {
    try {
      const data = await fs.readFile(
        path.join(this.sessionDir(sessionId), 'progress.json'),
        'utf-8'
      );
      return JSON.parse(data) as UltraWorkStepRecord[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  async saveRetrospective(sessionId: string, retro: string): Promise<void> {
    await fs.writeFile(path.join(this.sessionDir(sessionId), 'retrospective.md'), retro);
  }

  async deleteSession(sessionId: string): Promise<void> {
    // force: true already suppresses ENOENT, so no need to catch
    await fs.rm(this.sessionDir(sessionId), { recursive: true, force: true });
  }

  async listSessions(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.baseDir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }
}
