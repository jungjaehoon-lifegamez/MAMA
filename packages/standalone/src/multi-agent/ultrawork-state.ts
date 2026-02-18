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

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(os.homedir(), '.mama', 'workspace', 'ultrawork');
  }

  private sessionDir(sessionId: string): string {
    return path.join(this.baseDir, sessionId);
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
    } catch {
      return null;
    }
  }

  async updatePhase(sessionId: string, phase: UltraWorkPhase): Promise<void> {
    const state = await this.loadSession(sessionId);
    if (!state) return;

    state.phase = phase;
    state.updatedAt = Date.now();

    await fs.writeFile(
      path.join(this.sessionDir(sessionId), 'session.json'),
      JSON.stringify(state, null, 2)
    );
  }

  async savePlan(sessionId: string, plan: string): Promise<void> {
    await fs.writeFile(path.join(this.sessionDir(sessionId), 'plan.md'), plan);
  }

  async loadPlan(sessionId: string): Promise<string | null> {
    try {
      return await fs.readFile(path.join(this.sessionDir(sessionId), 'plan.md'), 'utf-8');
    } catch {
      return null;
    }
  }

  async recordStep(sessionId: string, step: UltraWorkStepRecord): Promise<void> {
    const steps = await this.loadProgress(sessionId);
    steps.push(step);
    await fs.writeFile(
      path.join(this.sessionDir(sessionId), 'progress.json'),
      JSON.stringify(steps, null, 2)
    );
  }

  async loadProgress(sessionId: string): Promise<UltraWorkStepRecord[]> {
    try {
      const data = await fs.readFile(
        path.join(this.sessionDir(sessionId), 'progress.json'),
        'utf-8'
      );
      return JSON.parse(data) as UltraWorkStepRecord[];
    } catch {
      return [];
    }
  }

  async saveRetrospective(sessionId: string, retro: string): Promise<void> {
    await fs.writeFile(path.join(this.sessionDir(sessionId), 'retrospective.md'), retro);
  }

  async deleteSession(sessionId: string): Promise<void> {
    try {
      await fs.rm(this.sessionDir(sessionId), { recursive: true, force: true });
    } catch {
      // Ignore if already deleted
    }
  }

  async listSessions(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.baseDir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }
}
