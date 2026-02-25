/**
 * Dynamic Workflow Orchestration Types
 *
 * Conductor가 사용자 의도를 분석하여 동적으로 생성하는
 * 워크플로우 DAG 관련 타입 정의.
 */

export type AgentBackend = 'claude' | 'codex-mcp' | 'gemini';

/**
 * Conductor가 동적으로 생성하는 임시 에이전트 정의
 */
export interface EphemeralAgentDef {
  /** Unique ID within the workflow, e.g. "planner-1", "coder-2" */
  id: string;
  /** Display name with emoji, e.g. "🔍 Researcher" */
  display_name: string;
  /** Runtime backend */
  backend: AgentBackend;
  /** Model ID */
  model: string;
  /** Inline system prompt */
  system_prompt: string;
  /** Agent tier level @default 1 */
  tier?: 1 | 2 | 3;
  /** Tool permissions override */
  tool_permissions?: { allowed?: string[]; blocked?: string[] };
}

/**
 * 워크플로우 DAG의 한 단계
 */
export interface WorkflowStep {
  /** Unique step ID within the workflow */
  id: string;
  /** Agent definition for this step */
  agent: EphemeralAgentDef;
  /** Prompt template — supports {{step_id.result}} interpolation */
  prompt: string;
  /** Step IDs this step depends on */
  depends_on?: string[];
  /** Timeout in ms @default 300000 (5 min) */
  timeout_ms?: number;
  /** If true, workflow continues even if this step fails @default false */
  optional?: boolean;
}

/**
 * Conductor가 출력하는 워크플로우 계획
 */
export interface WorkflowPlan {
  /** Human-readable name for the workflow */
  name: string;
  /** Ordered steps forming a DAG */
  steps: WorkflowStep[];
  /** Optional synthesis step to combine all results */
  synthesis?: {
    agent?: EphemeralAgentDef;
    prompt_template?: string;
  };
}

/**
 * 워크플로우 설정 (MultiAgentConfig.workflow)
 */
export interface WorkflowConfig {
  /** Enable dynamic workflow orchestration */
  enabled: boolean;
  /** Max ephemeral agents per workflow @default 20 */
  max_ephemeral_agents?: number;
  /** Max total workflow duration in ms @default 1800000 (30 min). 0 = unlimited */
  max_duration_ms?: number;
  /** Per-step timeout in ms @default 300000 (5 min). 0 = unlimited */
  step_timeout_ms?: number;
  /** Max concurrent steps per execution level @default 3 */
  max_concurrent_steps?: number;
  /** Round-robin backend balancing (claude ↔ codex-mcp) @default true */
  backend_balancing?: boolean;
}

/**
 * 단계 실행 결과
 */
export interface StepResult {
  stepId: string;
  agentId: string;
  result: string;
  duration_ms: number;
  status: 'success' | 'failed' | 'timeout' | 'skipped';
  error?: string;
}

/**
 * 워크플로우 실행 상태
 */
export interface WorkflowExecution {
  id: string;
  planName: string;
  startedAt: number;
  completedAt?: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  steps: StepResult[];
}

/**
 * 워크플로우 진행 이벤트 (콜백용)
 */
export interface WorkflowProgressEvent {
  type: 'step-started' | 'step-completed' | 'step-failed' | 'workflow-completed';
  executionId: string;
  stepId?: string;
  agentDisplayName?: string;
  agentBackend?: string;
  agentModel?: string;
  result?: string;
  error?: string;
  /** Elapsed time for the step or total workflow */
  duration_ms?: number;
  /** Summary of all step results (for workflow-completed) */
  summary?: string;
  /** Steps completed so far */
  completedSteps?: number;
  /** Total steps in workflow */
  totalSteps?: number;
}

// ============================================================================
// Council Mode Types
// ============================================================================

/**
 * Conductor가 생성하는 council 토론 계획
 */
export interface CouncilPlan {
  name: string;
  /** 토론 주제 */
  topic: string;
  /** 기존 named agent IDs */
  agents: string[];
  /** 라운드 수 (1-5) */
  rounds: number;
  /** Conductor가 최종 합성할지 여부 @default true */
  synthesis?: boolean;
  /** 전체 타임아웃 (ms) */
  timeout_ms?: number;
}

/**
 * Council 라운드별 결과
 */
export interface CouncilRoundResult {
  round: number;
  agentId: string;
  agentDisplayName: string;
  response: string;
  duration_ms: number;
  status: 'success' | 'failed' | 'timeout' | 'skipped';
  error?: string;
}

/**
 * Council 실행 상태
 */
export interface CouncilExecution {
  id: string;
  planName: string;
  topic: string;
  startedAt: number;
  completedAt?: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  rounds: CouncilRoundResult[];
}

/**
 * Council 설정 (MultiAgentConfig.council)
 */
export interface CouncilConfig {
  /** Enable council mode */
  enabled: boolean;
  /** Max rounds per council @default 5 */
  max_rounds?: number;
  /** Max total council duration in ms @default 600000 (10 min) */
  max_duration_ms?: number;
}

/**
 * Council 진행 이벤트
 */
export interface CouncilProgressEvent {
  type:
    | 'council-round-started'
    | 'council-round-completed'
    | 'council-round-failed'
    | 'council-completed';
  executionId: string;
  round?: number;
  agentId?: string;
  agentDisplayName?: string;
  response?: string;
  error?: string;
  duration_ms?: number;
  summary?: string;
}
