/**
 * Skill Forge - Orchestrator
 *
 * 멀티 에이전트 조율: Architect → Developer → QA
 * 각 단계 사이 5초 카운트다운으로 유저 검토 기회 제공
 */

import {
  SessionState,
  SessionPhase,
  SkillRequest,
  OrchestratorEvent,
  DiscordAction,
  SkillForgeConfig,
  DEFAULT_CONFIG,
  ArchitectOutput,
  DeveloperOutput,
  QAOutput,
} from './types';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { randomUUID } from 'crypto';
import { createArchitectAgent } from './agents/architect';
import { createDeveloperAgent } from './agents/developer';
import { createQAAgent } from './agents/qa';
import { ErrorHandler, createError, SkillForgeError, rollbackStrategy } from './error-handler';
import { createMockMAMAIntegration, MAMAIntegration } from './mama-integration';

export class Orchestrator {
  private state: SessionState | null = null;
  private config: SkillForgeConfig;
  private eventHandlers: ((event: OrchestratorEvent) => void)[] = [];
  private countdownTimer: NodeJS.Timeout | null = null;
  private errorHandler: ErrorHandler;
  private mama: MAMAIntegration;

  constructor(config: Partial<SkillForgeConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.errorHandler = new ErrorHandler({
      maxRetries: 3,
      retryDelayMs: 1000,
      onError: (err) => this.emit({ type: 'ERROR', error: err.userMessage }),
    });
    this.mama = createMockMAMAIntegration();
  }

  // ===== Event System =====

  onEvent(handler: (event: OrchestratorEvent) => void): void {
    this.eventHandlers.push(handler);
  }

  private emit(event: OrchestratorEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        console.error('[Orchestrator] Event handler error:', error);
      }
    }
  }

  // ===== Session Management =====

  async startSession(request: SkillRequest): Promise<SessionState> {
    this.state = {
      id: randomUUID(),
      phase: 'idle',
      request,
      artifacts: {},
      countdown: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.emit({ type: 'REQUEST_RECEIVED', request });
    this.saveState();

    await this.transitionTo('architect');
    return this.state;
  }

  getState(): SessionState | null {
    return this.state;
  }

  // ===== Phase Transitions =====

  private async transitionTo(phase: SessionPhase): Promise<void> {
    if (!this.state) {
      throw new Error('No active session');
    }

    this.state.phase = phase;
    this.state.updatedAt = new Date().toISOString();
    this.saveState();

    switch (phase) {
      case 'architect':
        await this.runArchitect();
        break;
      case 'architect_review':
        this.startCountdown('architect_review');
        break;
      case 'developer':
        await this.runDeveloper();
        break;
      case 'developer_review':
        this.startCountdown('developer_review');
        break;
      case 'qa':
        await this.runQA();
        break;
      case 'qa_review':
        this.startCountdown('qa_review');
        break;
      case 'completed':
        this.emit({ type: 'SESSION_COMPLETE', success: true });
        await this.saveGeneratedFiles();
        // MAMA 연동: decision 저장
        await this.saveToMAMA();
        break;
      case 'cancelled':
        this.emit({ type: 'SESSION_COMPLETE', success: false });
        break;
    }
  }

  // ===== Agent Execution =====

  private async runArchitect(): Promise<void> {
    this.emit({ type: 'AGENT_START', agent: 'architect' });

    try {
      const output = await this.errorHandler.handle(
        'architect',
        async () => {
          const architect = createArchitectAgent();
          return architect.design(this.state!.request);
        },
        { phase: 'architect' }
      );

      this.state!.artifacts.architectOutput = output;
      this.emit({ type: 'AGENT_COMPLETE', agent: 'architect', output });

      await this.transitionTo('architect_review');
    } catch (error) {
      await this.handleAgentError(error as SkillForgeError, 'architect');
    }
  }

  private async runDeveloper(): Promise<void> {
    this.emit({ type: 'AGENT_START', agent: 'developer' });

    try {
      const architectOutput = this.state!.artifacts.architectOutput;
      if (!architectOutput) {
        throw createError('STATE_ERROR', 'Architect output not found', { phase: 'developer' });
      }

      const output = await this.errorHandler.handle(
        'developer',
        async () => {
          const developer = createDeveloperAgent();
          return developer.develop(architectOutput, this.state!.request);
        },
        { phase: 'developer' }
      );

      this.state!.artifacts.developerOutput = output;
      this.emit({ type: 'AGENT_COMPLETE', agent: 'developer', output });

      await this.transitionTo('developer_review');
    } catch (error) {
      await this.handleAgentError(error as SkillForgeError, 'developer');
    }
  }

  private async runQA(): Promise<void> {
    this.emit({ type: 'AGENT_START', agent: 'qa' });

    try {
      const architectOutput = this.state!.artifacts.architectOutput;
      const developerOutput = this.state!.artifacts.developerOutput;

      if (!architectOutput || !developerOutput) {
        throw createError('STATE_ERROR', 'Previous outputs not found', { phase: 'qa' });
      }

      const output = await this.errorHandler.handle(
        'qa',
        async () => {
          const qa = createQAAgent();
          return qa.verify(developerOutput, architectOutput);
        },
        { phase: 'qa' }
      );

      this.state!.artifacts.qaOutput = output;
      this.emit({ type: 'AGENT_COMPLETE', agent: 'qa', output });

      await this.transitionTo('qa_review');
    } catch (error) {
      await this.handleAgentError(error as SkillForgeError, 'qa');
    }
  }

  // ===== Error Recovery =====

  private async handleAgentError(error: SkillForgeError, agent: string): Promise<void> {
    console.error(`[Orchestrator] ${agent} failed:`, error.message);

    // Try recovery
    if (rollbackStrategy.canRecover(error, this.state!)) {
      this.state = rollbackStrategy.recover(error, this.state!);
      this.saveState();
      this.emit({ type: 'ERROR', error: `${error.userMessage} (롤백됨)` });
    } else {
      // Cannot recover - cancel session
      await this.transitionTo('cancelled');
    }
  }

  // ===== MAMA Integration =====

  private async saveToMAMA(): Promise<void> {
    if (!this.state) return;

    try {
      await this.mama.saveDecision(this.state);
      console.log('[Orchestrator] Saved decision to MAMA');
    } catch (error) {
      console.error('[Orchestrator] Failed to save to MAMA:', error);
      // Non-critical - don't fail the session
    }
  }

  // ===== File Generation =====

  private async saveGeneratedFiles(): Promise<void> {
    const developerOutput = this.state?.artifacts.developerOutput;
    if (!developerOutput || !developerOutput.files) return;

    const outputDir = this.config.outputDir.replace('~', process.env.HOME || '');

    for (const file of developerOutput.files) {
      const fullPath = `${outputDir}/${file.path}`;
      const dir = dirname(fullPath);

      // 디렉토리 생성
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(fullPath, file.content);
      console.log(`[Orchestrator] Saved: ${fullPath}`);
    }
  }

  // ===== Countdown System =====

  private startCountdown(phase: SessionPhase): void {
    this.emit({ type: 'COUNTDOWN_START', phase });

    this.state!.countdown = {
      startedAt: new Date().toISOString(),
      durationMs: this.config.countdownMs,
    };
    this.saveState();

    this.countdownTimer = setTimeout(() => {
      this.onCountdownExpire();
    }, this.config.countdownMs);
  }

  private stopCountdown(): void {
    if (this.countdownTimer) {
      clearTimeout(this.countdownTimer);
      this.countdownTimer = null;
    }
    if (this.state) {
      this.state.countdown = null;
    }
  }

  private async onCountdownExpire(): Promise<void> {
    this.emit({ type: 'COUNTDOWN_EXPIRE' });
    this.stopCountdown();

    const nextPhase = this.getNextPhase();
    if (nextPhase) {
      await this.transitionTo(nextPhase);
    }
  }

  private getNextPhase(): SessionPhase | null {
    if (!this.state) return null;

    const transitions: Partial<Record<SessionPhase, SessionPhase>> = {
      architect_review: 'developer',
      developer_review: 'qa',
      qa_review: 'completed',
    };

    return transitions[this.state.phase] || null;
  }

  // ===== User Actions =====

  async handleUserAction(action: DiscordAction): Promise<void> {
    if (!this.state) {
      throw new Error('No active session');
    }

    this.emit({ type: 'USER_ACTION', action });
    this.stopCountdown();

    switch (action.type) {
      case 'approve':
        const nextPhase = this.getNextPhase();
        if (nextPhase) {
          await this.transitionTo(nextPhase);
        }
        break;

      case 'revise':
        await this.retryCurrentPhase();
        break;

      case 'cancel':
        await this.transitionTo('cancelled');
        break;

      case 'extend':
        this.startCountdown(this.state.phase);
        break;
    }
  }

  private async retryCurrentPhase(): Promise<void> {
    if (!this.state) return;

    const retryMap: Partial<Record<SessionPhase, SessionPhase>> = {
      architect_review: 'architect',
      developer_review: 'developer',
      qa_review: 'qa',
    };

    const retryPhase = retryMap[this.state.phase];
    if (retryPhase) {
      await this.transitionTo(retryPhase);
    }
  }

  // ===== State Persistence =====

  private saveState(): void {
    if (!this.state) return;

    const statePath = this.config.stateFile.replace('~', process.env.HOME || '');
    const dir = dirname(statePath);

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(statePath, JSON.stringify(this.state, null, 2));
  }

  loadState(): SessionState | null {
    const statePath = this.config.stateFile.replace('~', process.env.HOME || '');

    if (!existsSync(statePath)) {
      return null;
    }

    try {
      const data = readFileSync(statePath, 'utf-8');
      this.state = JSON.parse(data);
      return this.state;
    } catch {
      return null;
    }
  }

  // ===== Debug / Info =====

  getPhaseDescription(phase: SessionPhase): string {
    const descriptions: Record<SessionPhase, string> = {
      idle: '⏸️ 대기 중',
      architect: '🏗️ Architect가 구조를 설계 중...',
      architect_review: '👀 구조 검토 중 (5초 카운트다운)',
      developer: '💻 Developer가 코드 작성 중...',
      developer_review: '👀 코드 검토 중 (5초 카운트다운)',
      qa: '🔍 QA가 검증 중...',
      qa_review: '👀 검증 결과 검토 중 (5초 카운트다운)',
      completed: '✅ 완료!',
      cancelled: '❌ 취소됨',
    };
    return descriptions[phase];
  }

  // ===== Summary =====

  getSummary(): string {
    if (!this.state) return '세션 없음';

    const arch = this.state.artifacts.architectOutput;
    const dev = this.state.artifacts.developerOutput;
    const qa = this.state.artifacts.qaOutput;

    let summary = `## Skill Forge 결과\n\n`;
    summary += `**스킬명:** ${this.state.request.name}\n`;
    summary += `**상태:** ${this.getPhaseDescription(this.state.phase)}\n\n`;

    if (arch) {
      summary += `### 🏗️ Architect\n`;
      summary += `- 목적: ${arch.purpose}\n`;
      summary += `- 복잡도: ${arch.estimatedComplexity}\n`;
      summary += `- 워크플로우: ${arch.workflow.length}단계\n\n`;
    }

    if (dev) {
      summary += `### 💻 Developer\n`;
      summary += `- 생성 파일: ${dev.files.length}개\n`;
      dev.files.forEach((f) => {
        summary += `  - ${f.path}\n`;
      });
      summary += `\n`;
    }

    if (qa) {
      summary += `### 🔍 QA\n`;
      summary += `- 통과: ${qa.passed ? '✅' : '❌'}\n`;
      summary += `- 권고: ${qa.recommendation}\n`;
      summary += `- 체크리스트: ${qa.checklist.filter((c) => c.passed).length}/${qa.checklist.length}\n`;
    }

    return summary;
  }
}

// ===== Factory =====

export function createOrchestrator(config?: Partial<SkillForgeConfig>): Orchestrator {
  return new Orchestrator(config);
}

// ===== Test CLI =====

async function runTest() {
  console.log('🔥 Skill Forge - Full Pipeline Test\n');

  const orchestrator = createOrchestrator({
    countdownMs: 2000, // 테스트용 2초
  });

  // 이벤트 로깅
  orchestrator.onEvent((event) => {
    const emoji: Record<string, string> = {
      REQUEST_RECEIVED: '📥',
      AGENT_START: '🚀',
      AGENT_COMPLETE: '✅',
      COUNTDOWN_START: '⏱️',
      COUNTDOWN_EXPIRE: '⏰',
      SESSION_COMPLETE: '🎉',
      ERROR: '❌',
    };
    console.log(`${emoji[event.type] || '•'} ${event.type}`);
  });

  try {
    await orchestrator.startSession({
      name: 'hello-world',
      description: '간단한 인사 스킬',
      triggers: ['/hello', '안녕'],
      capabilities: ['인사하기', '이름 받기'],
      rawInput: '/forge hello-world - 간단한 인사 스킬',
    });

    // 전체 파이프라인 완료 대기
    await new Promise((resolve) => setTimeout(resolve, 10000));

    console.log('\n' + '='.repeat(50));
    console.log(orchestrator.getSummary());
  } catch (err) {
    console.error('❌ Error:', err);
  }
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  runTest();
}
