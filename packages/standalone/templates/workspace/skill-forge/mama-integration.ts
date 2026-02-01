/**
 * Skill Forge - MAMA Integration
 *
 * MAMA MCP 서버와 연동하여 decision/checkpoint 관리
 */

import { SessionState, ArchitectOutput, QAOutput } from './types';

// ===== MAMA Decision Types =====

export interface MAMADecision {
  type: 'decision';
  topic: string;
  decision: string;
  reasoning: string;
  confidence: number;
}

export interface MAMACheckpoint {
  type: 'checkpoint';
  summary: string;
  next_steps: string;
  open_files: string[];
}

// ===== Decision Builders =====

export function buildSkillDecision(state: SessionState): MAMADecision {
  const arch = state.artifacts.architectOutput;
  const qa = state.artifacts.qaOutput;

  if (!arch) {
    throw new Error('No architect output available');
  }

  const decision = `skill_${arch.skillName}`;
  const qaStatus = qa ? (qa.passed ? 'QA passed' : 'QA failed') : 'QA pending';

  return {
    type: 'decision',
    topic: `skill_forge_${arch.skillName}`,
    decision: `Created skill '${arch.skillName}' - ${arch.purpose}`,
    reasoning: buildDecisionReasoning(arch, qa),
    confidence: calculateConfidence(state),
  };
}

function buildDecisionReasoning(arch: ArchitectOutput, qa?: QAOutput): string {
  const sections: string[] = [];

  // 1. Context
  sections.push(`(1) Context - Skill Forge를 통해 '${arch.skillName}' 스킬 생성 요청됨`);

  // 2. Evidence
  const evidence = [
    `워크플로우 ${arch.workflow.length}단계 설계`,
    `파일 ${arch.fileStructure.length}개 구조화`,
    `복잡도: ${arch.estimatedComplexity}`,
  ];
  if (qa) {
    evidence.push(
      `QA 체크리스트: ${qa.checklist.filter((c) => c.passed).length}/${qa.checklist.length} 통과`
    );
  }
  sections.push(`(2) Evidence - ${evidence.join(', ')}`);

  // 3. Alternatives
  sections.push(`(3) Alternatives - 수동 작성 대비 자동화된 구조 설계 채택`);

  // 4. Risks
  const risks = qa?.issues.filter((i) => i.severity === 'critical').map((i) => i.description) || [];
  sections.push(`(4) Risks - ${risks.length ? risks.join(', ') : '주요 리스크 없음'}`);

  // 5. Rationale
  sections.push(`(5) Rationale - Architect→Developer→QA 파이프라인으로 일관된 품질 보장`);

  return sections.join('; ');
}

function calculateConfidence(state: SessionState): number {
  const qa = state.artifacts.qaOutput;

  if (!qa) return 0.5;

  if (qa.passed && qa.recommendation === 'approve') {
    return 0.9;
  } else if (qa.passed) {
    return 0.7;
  } else if (qa.recommendation === 'revise') {
    return 0.5;
  } else {
    return 0.3;
  }
}

// ===== Checkpoint Builders =====

export function buildSessionCheckpoint(state: SessionState): MAMACheckpoint {
  const { phase, artifacts, request } = state;

  // Summary with 4-section format
  const summary = buildCheckpointSummary(state);

  // Next steps
  const nextSteps = buildNextSteps(state);

  // Open files
  const openFiles = buildOpenFiles(state);

  return {
    type: 'checkpoint',
    summary,
    next_steps: nextSteps,
    open_files: openFiles,
  };
}

function buildCheckpointSummary(state: SessionState): string {
  const { phase, artifacts, request } = state;
  const sections: string[] = [];

  // 1. Goal & Progress
  sections.push(`🎯 Goal & Progress - '${request.name}' 스킬 생성, 현재 ${phase} 단계`);

  // 2. Evidence
  const evidence: string[] = [];
  if (artifacts.architectOutput) {
    evidence.push(`Architect: Verified (${artifacts.architectOutput.workflow.length}단계 설계)`);
  }
  if (artifacts.developerOutput) {
    evidence.push(`Developer: Verified (${artifacts.developerOutput.files.length}개 파일)`);
  }
  if (artifacts.qaOutput) {
    evidence.push(`QA: ${artifacts.qaOutput.passed ? 'Passed' : 'Failed'}`);
  }
  sections.push(`✅ Evidence - ${evidence.join(', ') || 'Not run'}`);

  // 3. Unfinished & Risks
  const unfinished: string[] = [];
  if (phase === 'architect' || phase === 'architect_review') {
    unfinished.push('Developer 작업 대기');
    unfinished.push('QA 검증 대기');
  } else if (phase === 'developer' || phase === 'developer_review') {
    unfinished.push('QA 검증 대기');
  }
  sections.push(`⏳ Unfinished & Risks - ${unfinished.join(', ') || '없음'}`);

  // 4. Related decisions
  sections.push(`Related decisions: skill_forge_${request.name}`);

  return sections.join('; ');
}

function buildNextSteps(state: SessionState): string {
  const { phase, request } = state;
  const steps: string[] = [];

  // DoD
  steps.push(`DoD: '${request.name}' 스킬이 QA 통과 후 output 폴더에 저장`);

  // Quick verification
  steps.push(`Verification: cd ~/.mama/workspace/skill-forge && npx tsx test-e2e.ts`);

  // Phase-specific
  switch (phase) {
    case 'architect':
    case 'architect_review':
      steps.push('Next: Architect 출력 검토 후 Developer 진행');
      break;
    case 'developer':
    case 'developer_review':
      steps.push('Next: Developer 출력 검토 후 QA 진행');
      break;
    case 'qa':
    case 'qa_review':
      steps.push('Next: QA 결과 확인 후 최종 승인');
      break;
    case 'completed':
      steps.push('Done: 생성된 파일을 MAMA에 등록');
      break;
  }

  return steps.join('; ');
}

function buildOpenFiles(state: SessionState): string[] {
  const files = [
    '~/.mama/workspace/skill-forge/orchestrator.ts',
    '~/.mama/workspace/skill-forge/types.ts',
  ];

  // Add generated files if any
  const developerOutput = state.artifacts.developerOutput;
  if (developerOutput) {
    for (const file of developerOutput.files) {
      files.push(`~/.mama/workspace/skill-forge/output/generated-skills/${file.path}`);
    }
  }

  return files;
}

// ===== MCP Call Helpers =====

/**
 * Format decision for MAMA MCP save call
 */
export function formatDecisionForMCP(decision: MAMADecision): Record<string, unknown> {
  return {
    type: 'decision',
    topic: decision.topic,
    decision: decision.decision,
    reasoning: decision.reasoning,
    confidence: decision.confidence,
  };
}

/**
 * Format checkpoint for MAMA MCP save call
 */
export function formatCheckpointForMCP(checkpoint: MAMACheckpoint): Record<string, unknown> {
  return {
    type: 'checkpoint',
    summary: checkpoint.summary,
    next_steps: checkpoint.next_steps,
    open_files: checkpoint.open_files,
  };
}

// ===== Integration Events =====

export type MAMAEvent =
  | { type: 'DECISION_SAVED'; topic: string; id: string }
  | { type: 'CHECKPOINT_SAVED'; id: string }
  | { type: 'MAMA_ERROR'; error: string };

export interface MAMAIntegration {
  saveDecision(state: SessionState): Promise<MAMAEvent>;
  saveCheckpoint(state: SessionState): Promise<MAMAEvent>;
  searchRelated(topic: string): Promise<string[]>;
}

/**
 * Mock implementation for testing
 * Real implementation would use MCP client
 */
export function createMockMAMAIntegration(): MAMAIntegration {
  let decisionCount = 0;
  let checkpointCount = 0;

  return {
    async saveDecision(state: SessionState): Promise<MAMAEvent> {
      const decision = buildSkillDecision(state);
      decisionCount++;
      console.log(`[MAMA] Saved decision: ${decision.topic}`);
      console.log(`[MAMA] Reasoning: ${decision.reasoning}`);
      return {
        type: 'DECISION_SAVED',
        topic: decision.topic,
        id: `decision_${decisionCount}`,
      };
    },

    async saveCheckpoint(state: SessionState): Promise<MAMAEvent> {
      const checkpoint = buildSessionCheckpoint(state);
      checkpointCount++;
      console.log(`[MAMA] Saved checkpoint`);
      console.log(`[MAMA] Summary: ${checkpoint.summary}`);
      return {
        type: 'CHECKPOINT_SAVED',
        id: `checkpoint_${checkpointCount}`,
      };
    },

    async searchRelated(topic: string): Promise<string[]> {
      console.log(`[MAMA] Searching for: ${topic}`);
      return []; // Mock returns empty
    },
  };
}

// ===== Test =====

async function runTest() {
  console.log('🔗 MAMA Integration Test\n');

  // Mock session state
  const mockState: SessionState = {
    id: 'test-123',
    phase: 'completed',
    request: {
      name: 'hello-world',
      description: '간단한 인사 스킬',
      triggers: ['/hello'],
      capabilities: ['인사하기'],
      rawInput: '/forge hello-world',
    },
    artifacts: {
      architectOutput: {
        skillName: 'hello-world',
        purpose: '유저에게 인사하는 간단한 스킬',
        triggers: ['/hello', '안녕'],
        workflow: [
          { step: 1, action: 'parse', description: '입력 파싱' },
          { step: 2, action: 'respond', description: '인사 응답' },
        ],
        fileStructure: [
          { path: 'skills/hello-world/index.ts', purpose: '메인 로직' },
          { path: 'skills/hello-world/types.ts', purpose: '타입 정의' },
        ],
        toolsRequired: ['Read'],
        estimatedComplexity: 'simple',
      },
      developerOutput: {
        files: [
          { path: 'skills/hello-world/index.ts', content: '...', language: 'typescript' },
          { path: 'skills/hello-world/types.ts', content: '...', language: 'typescript' },
        ],
        installInstructions: ['npm install'],
        testCommands: ['npm test'],
      },
      qaOutput: {
        passed: true,
        checklist: [
          { item: '타입 정의 완료', passed: true },
          { item: '메인 함수 존재', passed: true },
        ],
        issues: [],
        recommendation: 'approve',
      },
    },
    countdown: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const mama = createMockMAMAIntegration();

  console.log('=== Decision ===\n');
  const decision = buildSkillDecision(mockState);
  console.log(JSON.stringify(decision, null, 2));

  console.log('\n=== Checkpoint ===\n');
  const checkpoint = buildSessionCheckpoint(mockState);
  console.log(JSON.stringify(checkpoint, null, 2));

  console.log('\n=== Save via Integration ===\n');
  await mama.saveDecision(mockState);
  await mama.saveCheckpoint(mockState);

  console.log('\n✅ Test complete');
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  runTest();
}
