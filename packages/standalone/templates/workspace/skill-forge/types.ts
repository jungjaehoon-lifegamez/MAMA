/**
 * Skill Forge - Type Definitions
 */

// ===== Agent Types =====

export type AgentRole = 'architect' | 'developer' | 'qa';

export type AgentModel = 'sonnet' | 'opus' | 'haiku';

export interface AgentConfig {
  role: AgentRole;
  model: AgentModel;
  systemPrompt: string;
}

// ===== Session State =====

export type SessionPhase =
  | 'idle' // 대기 중
  | 'architect' // Architect 작업 중
  | 'architect_review' // Architect 결과 검토 (카운트다운)
  | 'developer' // Developer 작업 중
  | 'developer_review' // Developer 결과 검토 (카운트다운)
  | 'qa' // QA 작업 중
  | 'qa_review' // QA 결과 검토 (카운트다운)
  | 'completed' // 완료
  | 'cancelled'; // 취소됨

export interface SessionState {
  id: string;
  phase: SessionPhase;
  request: SkillRequest;
  artifacts: SessionArtifacts;
  countdown: CountdownState | null;
  createdAt: string;
  updatedAt: string;
}

export interface SkillRequest {
  name: string;
  description: string;
  triggers: string[];
  capabilities: string[];
  rawInput: string;
}

export interface SessionArtifacts {
  architectOutput?: ArchitectOutput;
  developerOutput?: DeveloperOutput;
  qaOutput?: QAOutput;
}

// ===== Agent Outputs =====

export interface ArchitectOutput {
  skillName: string;
  purpose: string;
  triggers: string[];
  workflow: WorkflowStep[];
  fileStructure: FileSpec[];
  toolsRequired: string[];
  estimatedComplexity: 'simple' | 'medium' | 'complex';
}

export interface WorkflowStep {
  step: number;
  action: string;
  description: string;
}

export interface FileSpec {
  path: string;
  purpose: string;
}

export interface DeveloperOutput {
  files: GeneratedFile[];
  installInstructions: string[];
  testCommands: string[];
}

export interface GeneratedFile {
  path: string;
  content: string;
  language: string;
}

export interface QAOutput {
  passed: boolean;
  checklist: ChecklistItem[];
  issues: QAIssue[];
  recommendation: 'approve' | 'revise' | 'reject';
}

export interface ChecklistItem {
  item: string;
  passed: boolean;
  note?: string;
}

export interface QAIssue {
  severity: 'critical' | 'warning' | 'suggestion';
  description: string;
  location?: string;
}

// ===== Countdown =====

export interface CountdownState {
  startedAt: string;
  durationMs: number;
  messageId?: string;
  channelId?: string;
}

// ===== Discord Integration =====

export interface DiscordAction {
  type: 'approve' | 'revise' | 'cancel' | 'extend';
  userId: string;
  timestamp: string;
}

// ===== Orchestrator Events =====

export type OrchestratorEvent =
  | { type: 'REQUEST_RECEIVED'; request: SkillRequest }
  | { type: 'AGENT_START'; agent: AgentRole }
  | { type: 'AGENT_COMPLETE'; agent: AgentRole; output: unknown }
  | { type: 'COUNTDOWN_START'; phase: SessionPhase }
  | { type: 'COUNTDOWN_EXPIRE' }
  | { type: 'USER_ACTION'; action: DiscordAction }
  | { type: 'SESSION_COMPLETE'; success: boolean }
  | { type: 'ERROR'; error: string };

// ===== Config =====

export interface SkillForgeConfig {
  countdownMs: number; // 기본 5000 (5초)
  outputDir: string;
  stateFile: string;
  models: {
    architect: AgentModel;
    developer: AgentModel;
    qa: AgentModel;
  };
}

export const DEFAULT_CONFIG: SkillForgeConfig = {
  countdownMs: 5000,
  outputDir: '~/.mama/workspace/skill-forge/output/generated-skills',
  stateFile: '~/.mama/workspace/skill-forge/state/session.json',
  models: {
    architect: 'sonnet',
    developer: 'opus',
    qa: 'haiku',
  },
};
