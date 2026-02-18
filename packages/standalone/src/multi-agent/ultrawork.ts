/**
 * UltraWork Manager
 *
 * Manages autonomous multi-step work sessions that combine
 * delegation and task continuation for extended workflows.
 *
 * Supports two modes:
 * 1. **Phased Loop** (Ralph Loop, default): Plan -> Build -> Retrospective
 *    - File-based state persist for crash recovery
 *    - Council integration at plan and retrospective phases
 *    - Structured task execution from plan
 * 2. **Freeform Loop** (legacy): Lead agent freely delegates and continues
 *
 * Constraints:
 * - max_duration (default 30 min)
 * - max_steps (default 20)
 * - Lead agent must be Tier 1 with can_delegate
 */

import type { UltraWorkConfig, AgentPersonaConfig } from './types.js';
import { ToolPermissionManager } from './tool-permission-manager.js';
import {
  DelegationManager,
  type DelegationExecuteCallback,
  type DelegationNotifyCallback,
} from './delegation-manager.js';
import { TaskContinuationEnforcer } from './task-continuation.js';
import { UltraWorkStateManager } from './ultrawork-state.js';
import * as os from 'os';
import * as path from 'path';

/** Default timeout for executeCallback (5 minutes) */
const DEFAULT_EXECUTE_TIMEOUT = 300000;

/**
 * Callback to intercept agent responses for workflow/council plan execution.
 * Returns the processed result if a plan was found, or null to continue normal processing.
 */
export type ResponseInterceptor = (
  agentResponse: string,
  channelId: string
) => Promise<{ result: string; type: 'workflow' | 'council' } | null>;

/** Default stall threshold — if response is too short, likely stalled */
const STALL_MIN_LENGTH = 20;
/** Max consecutive stalls before forcing a re-prompt */
const MAX_CONSECUTIVE_STALLS = 2;

/**
 * UltraWork session state
 */
export interface UltraWorkSession {
  /** Unique session ID */
  id: string;
  /** Channel where session is running */
  channelId: string;
  /** Lead agent ID (Tier 1) */
  leadAgentId: string;
  /** Task description */
  task: string;
  /** Current step number */
  currentStep: number;
  /** Maximum steps allowed */
  maxSteps: number;
  /** Session start time */
  startTime: number;
  /** Maximum duration in ms */
  maxDuration: number;
  /** Whether session is active */
  active: boolean;
  /** Steps log */
  steps: UltraWorkStep[];
}

/**
 * Individual step in an UltraWork session
 */
export interface UltraWorkStep {
  /** Step number */
  stepNumber: number;
  /** Agent that performed the step */
  agentId: string;
  /** What was done */
  action: string;
  /** Response summary */
  responseSummary: string;
  /** Whether the step was a delegation */
  isDelegation: boolean;
  /** Duration in ms */
  duration: number;
  /** Timestamp */
  timestamp: number;
}

/**
 * Default trigger keywords for UltraWork
 */
const DEFAULT_TRIGGER_KEYWORDS = [
  'ultrawork',
  '울트라워크',
  'deep work',
  'autonomous',
  '자율 작업',
];

/**
 * UltraWork Manager
 */
export class UltraWorkManager {
  private config: UltraWorkConfig;
  private permissionManager: ToolPermissionManager;
  private stateManager: UltraWorkStateManager | null = null;

  /** Active sessions per channel */
  private sessions: Map<string, UltraWorkSession> = new Map();

  /** Session counter for unique IDs */
  private sessionCounter = 0;

  constructor(config: UltraWorkConfig, permissionManager?: ToolPermissionManager) {
    this.config = config;
    this.permissionManager = permissionManager ?? new ToolPermissionManager();

    if (config.persist_state !== false) {
      this.stateManager = new UltraWorkStateManager(
        path.join(os.homedir(), '.mama', 'workspace', 'ultrawork')
      );
    }
  }

  /**
   * Check if a message contains UltraWork trigger keywords.
   */
  isUltraWorkTrigger(content: string): boolean {
    if (!this.config.enabled) return false;

    const keywords = this.config.trigger_keywords ?? DEFAULT_TRIGGER_KEYWORDS;
    const lower = content.toLowerCase();

    return keywords.some((kw) => lower.includes(kw.toLowerCase()));
  }

  /**
   * Start a new UltraWork session.
   */
  async startSession(
    channelId: string,
    leadAgentId: string,
    task: string,
    agents: AgentPersonaConfig[],
    executeCallback: DelegationExecuteCallback,
    notifyCallback: DelegationNotifyCallback,
    responseInterceptor?: ResponseInterceptor
  ): Promise<UltraWorkSession> {
    // Validate lead agent
    const leadAgent = agents.find((a) => a.id === leadAgentId);
    if (!leadAgent) {
      throw new Error(`Unknown lead agent: ${leadAgentId}`);
    }

    if (!this.permissionManager.canDelegate(leadAgent)) {
      throw new Error(`Lead agent ${leadAgentId} must be Tier 1 with can_delegate=true`);
    }

    // Stop existing session for this channel
    if (this.sessions.has(channelId)) {
      this.stopSession(channelId);
    }

    const session: UltraWorkSession = {
      id: `uw_${++this.sessionCounter}_${Date.now()}`,
      channelId,
      leadAgentId,
      task,
      currentStep: 0,
      maxSteps: this.config.max_steps ?? 20,
      startTime: Date.now(),
      maxDuration: this.config.max_duration ?? 1800000, // 30 min
      active: true,
      steps: [],
    };

    this.sessions.set(channelId, session);

    // Persist session state
    if (this.stateManager) {
      await this.stateManager.createSession(
        session.id,
        task,
        agents.filter((a) => a.enabled !== false).map((a) => a.id)
      );
    }

    const modeLabel =
      this.config.phased_loop !== false ? 'Phased (Plan->Build->Retro)' : 'Freeform';
    await notifyCallback(
      `**UltraWork Session Started** (${session.id})\n` +
        `Lead: **${leadAgent.display_name}**\n` +
        `Mode: ${modeLabel}\n` +
        `Task: ${task.substring(0, 200)}${task.length > 200 ? '...' : ''}\n` +
        `Limits: ${session.maxSteps} steps, ${Math.round(session.maxDuration / 60000)} min`
    );

    // Run the autonomous loop in detached context (non-blocking)
    this.runSessionLoop(
      session,
      agents,
      executeCallback,
      notifyCallback,
      responseInterceptor
    ).catch((err) => {
      console.error(`[UltraWork] Session ${session.id} loop error:`, err);
      session.active = false;
      this.sessions.delete(session.channelId);
      notifyCallback(
        `**UltraWork Session Error** (${session.id}): ${err instanceof Error ? err.message : String(err)}`
      ).catch(() => {});
    });

    return session;
  }

  /**
   * Check if a session should continue.
   */
  shouldContinue(session: UltraWorkSession): boolean {
    if (!session.active) return false;
    if (session.currentStep >= session.maxSteps) return false;
    if (Date.now() - session.startTime >= session.maxDuration) return false;
    return true;
  }

  /**
   * Stop an active session.
   */
  stopSession(channelId: string): UltraWorkSession | null {
    const session = this.sessions.get(channelId);
    if (!session) return null;

    session.active = false;
    this.sessions.delete(channelId);
    return session;
  }

  /**
   * Get active session for a channel.
   */
  getSession(channelId: string): UltraWorkSession | null {
    return this.sessions.get(channelId) ?? null;
  }

  /**
   * Get all active sessions.
   */
  getActiveSessions(): UltraWorkSession[] {
    return Array.from(this.sessions.values()).filter((s) => s.active);
  }

  /**
   * Check if UltraWork is enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Update configuration.
   */
  updateConfig(config: UltraWorkConfig): void {
    this.config = config;
  }

  /**
   * Get the state manager (for testing).
   */
  getStateManager(): UltraWorkStateManager | null {
    return this.stateManager;
  }

  /**
   * Override state manager (for testing with temp dirs).
   */
  setStateManager(sm: UltraWorkStateManager | null): void {
    this.stateManager = sm;
  }

  /**
   * Execute callback with timeout protection.
   */
  private async executeWithTimeout(
    executeCallback: DelegationExecuteCallback,
    agentId: string,
    prompt: string,
    timeoutMs: number = DEFAULT_EXECUTE_TIMEOUT
  ): Promise<{ response: string; duration?: number }> {
    let timeoutHandle: ReturnType<typeof setTimeout>;

    const result = await Promise.race([
      executeCallback(agentId, prompt),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`Agent ${agentId} timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);

    clearTimeout(timeoutHandle!);
    return result;
  }

  /**
   * Run the autonomous session loop — dispatches to phased or freeform mode.
   */
  private async runSessionLoop(
    session: UltraWorkSession,
    agents: AgentPersonaConfig[],
    executeCallback: DelegationExecuteCallback,
    notifyCallback: DelegationNotifyCallback,
    responseInterceptor?: ResponseInterceptor
  ): Promise<void> {
    if (this.config.phased_loop !== false) {
      await this.runPhasedLoop(
        session,
        agents,
        executeCallback,
        notifyCallback,
        responseInterceptor
      );
    } else {
      await this.runFreeformLoop(
        session,
        agents,
        executeCallback,
        notifyCallback,
        responseInterceptor
      );
    }
  }

  // ============================================================================
  // Phase 1: Planning
  // ============================================================================

  private async runPlanningPhase(
    session: UltraWorkSession,
    agents: AgentPersonaConfig[],
    executeCallback: DelegationExecuteCallback,
    notifyCallback: DelegationNotifyCallback,
    responseInterceptor?: ResponseInterceptor
  ): Promise<string> {
    await notifyCallback(`**Phase 1: Planning** - Creating implementation plan...`);

    session.currentStep++;
    const planPrompt = this.buildPlanningPrompt(session.task, agents);
    const planResult = await this.executeWithTimeout(
      executeCallback,
      session.leadAgentId,
      planPrompt
    );

    session.steps.push({
      stepNumber: session.currentStep,
      agentId: session.leadAgentId,
      action: 'planning',
      responseSummary: planResult.response.substring(0, 200),
      isDelegation: false,
      duration: planResult.duration ?? 0,
      timestamp: Date.now(),
    });

    // Council check — if Conductor outputs council_plan, interceptor will handle it
    let councilResult: string | null = null;
    if (responseInterceptor) {
      const intercepted = await responseInterceptor(planResult.response, session.channelId);
      if (intercepted?.type === 'council') {
        councilResult = intercepted.result;
        await notifyCallback(councilResult);

        session.currentStep++;
        session.steps.push({
          stepNumber: session.currentStep,
          agentId: session.leadAgentId,
          action: 'council_execution',
          responseSummary: councilResult.substring(0, 200),
          isDelegation: false,
          duration: 0,
          timestamp: Date.now(),
        });
      }
    }

    // Synthesize final plan (with council input if available)
    let finalPlan: string;
    if (councilResult) {
      session.currentStep++;
      const synthesisPrompt =
        `Based on the council discussion:\n---\n${councilResult}\n---\n\n` +
        `Create the final IMPLEMENTATION_PLAN. Format:\n## Tasks\n1. [task description] - assigned to: [agent_id]\n2. ...\n\n` +
        `Include acceptance criteria for each task. End with "PLAN_COMPLETE".`;
      const synthesis = await this.executeWithTimeout(
        executeCallback,
        session.leadAgentId,
        synthesisPrompt
      );
      finalPlan = synthesis.response;

      session.steps.push({
        stepNumber: session.currentStep,
        agentId: session.leadAgentId,
        action: 'plan_synthesis',
        responseSummary: finalPlan.substring(0, 200),
        isDelegation: false,
        duration: synthesis.duration ?? 0,
        timestamp: Date.now(),
      });
    } else {
      finalPlan = planResult.response;
    }

    // Persist plan
    if (this.stateManager) {
      await this.stateManager.savePlan(session.id, finalPlan);
    }

    return finalPlan;
  }

  // ============================================================================
  // Phase 2: Building
  // ============================================================================

  private async runBuildingPhase(
    session: UltraWorkSession,
    plan: string,
    agents: AgentPersonaConfig[],
    executeCallback: DelegationExecuteCallback,
    notifyCallback: DelegationNotifyCallback,
    responseInterceptor?: ResponseInterceptor
  ): Promise<void> {
    await notifyCallback(`**Phase 2: Building** - Executing plan...`);

    const delegationManager = new DelegationManager(agents, this.permissionManager);
    const continuationEnforcer = new TaskContinuationEnforcer({
      enabled: true,
      max_retries: 3,
    });

    let consecutiveStalls = 0;
    let currentPrompt = this.buildBuildingPrompt(plan, agents);
    let currentAgentId = session.leadAgentId;

    while (this.shouldContinue(session)) {
      session.currentStep++;
      const stepStart = Date.now();

      try {
        const result = await this.executeWithTimeout(
          executeCallback,
          currentAgentId,
          currentPrompt
        );
        const stepDuration = Date.now() - stepStart;

        // Stall detection
        if (result.response.trim().length < STALL_MIN_LENGTH) {
          consecutiveStalls++;
          if (consecutiveStalls >= MAX_CONSECUTIVE_STALLS) {
            consecutiveStalls = 0;
            await notifyCallback(
              `Agent ${currentAgentId} appears stalled (${MAX_CONSECUTIVE_STALLS} short responses). Re-prompting...`
            );
            currentPrompt =
              `Your previous responses were too brief. The task is NOT complete yet.\n\n` +
              `Original plan:\n${plan.substring(0, 1000)}\n\n` +
              `Please continue executing the plan. When ALL tasks are done, respond with "BUILD_COMPLETE".`;
            currentAgentId = session.leadAgentId;
            session.steps.push({
              stepNumber: session.currentStep,
              agentId: currentAgentId,
              action: 'stall_detected',
              responseSummary: `Stalled: "${result.response.trim().substring(0, 100)}"`,
              isDelegation: false,
              duration: stepDuration,
              timestamp: Date.now(),
            });
            continue;
          }
        } else {
          consecutiveStalls = 0;
        }

        // Council/workflow interceptor
        if (responseInterceptor) {
          const intercepted = await responseInterceptor(result.response, session.channelId);
          if (intercepted) {
            session.steps.push({
              stepNumber: session.currentStep,
              agentId: currentAgentId,
              action: intercepted.type === 'council' ? 'council_execution' : 'workflow_execution',
              responseSummary: intercepted.result.substring(0, 200),
              isDelegation: false,
              duration: Date.now() - stepStart,
              timestamp: Date.now(),
            });
            await notifyCallback(intercepted.result);
            currentPrompt =
              `The ${intercepted.type} plan completed. Results:\n---\n${intercepted.result.substring(0, 1000)}\n---\n` +
              `Continue executing the plan. When ALL tasks are done, respond with "BUILD_COMPLETE".`;
            currentAgentId = session.leadAgentId;
            continue;
          }
        }

        // Delegation check
        const delegationRequest = delegationManager.parseDelegation(
          currentAgentId,
          result.response
        );

        if (delegationRequest) {
          session.steps.push({
            stepNumber: session.currentStep,
            agentId: currentAgentId,
            action: 'delegation',
            responseSummary: delegationRequest.originalContent.substring(0, 200),
            isDelegation: true,
            duration: stepDuration,
            timestamp: Date.now(),
          });

          const delegationResult = await delegationManager.executeDelegation(
            delegationRequest,
            executeCallback,
            notifyCallback
          );

          if (delegationResult.success && delegationResult.response) {
            session.currentStep++;
            session.steps.push({
              stepNumber: session.currentStep,
              agentId: delegationRequest.toAgentId,
              action: 'delegated_task',
              responseSummary: delegationResult.response.substring(0, 200),
              isDelegation: false,
              duration: delegationResult.duration ?? 0,
              timestamp: Date.now(),
            });

            // Persist step
            if (this.stateManager) {
              await this.stateManager.recordStep(session.id, {
                stepNumber: session.currentStep,
                agentId: delegationRequest.toAgentId,
                action: 'delegated_task',
                responseSummary: delegationResult.response.substring(0, 200),
                isDelegation: false,
                duration: delegationResult.duration ?? 0,
                timestamp: Date.now(),
              });
            }

            currentPrompt = this.buildContinuationAfterDelegation(
              delegationRequest.toAgentId,
              delegationResult.response
            );
            currentAgentId = session.leadAgentId;
          } else {
            currentPrompt = `Delegation to ${delegationRequest.toAgentId} failed: ${delegationResult.error}. Please continue the task yourself.`;
            currentAgentId = session.leadAgentId;
          }
        } else {
          // No delegation — record step, check build completion
          session.steps.push({
            stepNumber: session.currentStep,
            agentId: currentAgentId,
            action: 'direct_work',
            responseSummary: result.response.substring(0, 200),
            isDelegation: false,
            duration: stepDuration,
            timestamp: Date.now(),
          });

          // Persist step
          if (this.stateManager) {
            await this.stateManager.recordStep(session.id, {
              stepNumber: session.currentStep,
              agentId: currentAgentId,
              action: 'direct_work',
              responseSummary: result.response.substring(0, 200),
              isDelegation: false,
              duration: stepDuration,
              timestamp: Date.now(),
            });
          }

          // Build-phase completion check
          if (this.isBuildComplete(result.response)) {
            return; // Move to retrospective
          }

          // Fallback: use continuation enforcer for "DONE" compat
          const continuation = continuationEnforcer.analyzeResponse(
            currentAgentId,
            session.channelId,
            result.response
          );

          if (continuation.isComplete) {
            return; // Move to retrospective
          }

          if (continuation.maxRetriesReached) {
            return; // Move to retrospective anyway
          }

          currentPrompt = continuationEnforcer.buildContinuationPrompt(result.response);
          currentAgentId = session.leadAgentId;
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        session.steps.push({
          stepNumber: session.currentStep,
          agentId: currentAgentId,
          action: 'error',
          responseSummary: errorMessage.substring(0, 200),
          isDelegation: false,
          duration: Date.now() - stepStart,
          timestamp: Date.now(),
        });
        currentPrompt = `An error occurred: ${errorMessage}. Please assess the situation and decide how to continue.`;
        currentAgentId = session.leadAgentId;
      }
    }
  }

  // ============================================================================
  // Phase 3: Retrospective
  // ============================================================================

  private async runRetrospectivePhase(
    session: UltraWorkSession,
    _agents: AgentPersonaConfig[],
    executeCallback: DelegationExecuteCallback,
    notifyCallback: DelegationNotifyCallback,
    responseInterceptor?: ResponseInterceptor
  ): Promise<{ complete: boolean; retro: string }> {
    await notifyCallback(`**Phase 3: Retrospective** - Reviewing results...`);

    const steps = this.stateManager
      ? await this.stateManager.loadProgress(session.id)
      : session.steps;
    const plan = this.stateManager ? ((await this.stateManager.loadPlan(session.id)) ?? '') : '';

    session.currentStep++;
    const retroPrompt = this.buildRetrospectivePrompt(plan, steps);
    const retroResult = await this.executeWithTimeout(
      executeCallback,
      session.leadAgentId,
      retroPrompt
    );

    session.steps.push({
      stepNumber: session.currentStep,
      agentId: session.leadAgentId,
      action: 'retrospective',
      responseSummary: retroResult.response.substring(0, 200),
      isDelegation: false,
      duration: retroResult.duration ?? 0,
      timestamp: Date.now(),
    });

    // Council check
    if (responseInterceptor) {
      const intercepted = await responseInterceptor(retroResult.response, session.channelId);
      if (intercepted?.type === 'council') {
        await notifyCallback(intercepted.result);
        session.currentStep++;
        session.steps.push({
          stepNumber: session.currentStep,
          agentId: session.leadAgentId,
          action: 'council_execution',
          responseSummary: intercepted.result.substring(0, 200),
          isDelegation: false,
          duration: 0,
          timestamp: Date.now(),
        });
      }
    }

    const isComplete = this.isRetroComplete(retroResult.response);

    // Persist retrospective
    if (this.stateManager) {
      await this.stateManager.saveRetrospective(session.id, retroResult.response);
    }

    return { complete: isComplete, retro: retroResult.response };
  }

  // ============================================================================
  // Phased Loop (Ralph Loop): Plan -> Build -> Retrospective
  // ============================================================================

  private async runPhasedLoop(
    session: UltraWorkSession,
    agents: AgentPersonaConfig[],
    executeCallback: DelegationExecuteCallback,
    notifyCallback: DelegationNotifyCallback,
    responseInterceptor?: ResponseInterceptor
  ): Promise<void> {
    // Phase 1: Planning + Council
    if (this.stateManager) {
      await this.stateManager.updatePhase(session.id, 'planning');
    }
    const plan = await this.runPlanningPhase(
      session,
      agents,
      executeCallback,
      notifyCallback,
      responseInterceptor
    );

    if (!this.shouldContinue(session)) {
      this.endSession(session, notifyCallback);
      return;
    }

    // Phase 2: Building
    if (this.stateManager) {
      await this.stateManager.updatePhase(session.id, 'building');
    }
    await this.runBuildingPhase(
      session,
      plan,
      agents,
      executeCallback,
      notifyCallback,
      responseInterceptor
    );

    if (!this.shouldContinue(session)) {
      this.endSession(session, notifyCallback);
      return;
    }

    // Phase 3: Retrospective + Council
    if (this.stateManager) {
      await this.stateManager.updatePhase(session.id, 'retrospective');
    }
    const { complete } = await this.runRetrospectivePhase(
      session,
      agents,
      executeCallback,
      notifyCallback,
      responseInterceptor
    );

    if (!complete && this.shouldContinue(session)) {
      // Incomplete → re-enter Build phase (max 1 retry)
      await notifyCallback(`Retrospective found incomplete items. Re-entering Build phase...`);
      if (this.stateManager) {
        await this.stateManager.updatePhase(session.id, 'building');
      }
      await this.runBuildingPhase(
        session,
        plan,
        agents,
        executeCallback,
        notifyCallback,
        responseInterceptor
      );

      // Re-run retrospective after retry Build phase
      if (!this.shouldContinue(session)) {
        // Session cancelled or limits exceeded
        session.active = false;
        this.sessions.delete(session.channelId);
        await notifyCallback(`**UltraWork Session Ended** — limits exceeded or cancelled`);
        return;
      }

      if (this.stateManager) {
        await this.stateManager.updatePhase(session.id, 'retrospective');
      }
      const retryRetro = await this.runRetrospectivePhase(
        session,
        agents,
        executeCallback,
        notifyCallback,
        responseInterceptor
      );

      if (!retryRetro.complete) {
        // Still incomplete after retry — end session with warning
        if (this.stateManager) {
          await this.stateManager.updatePhase(session.id, 'completed');
        }
        session.active = false;
        this.sessions.delete(session.channelId);
        await notifyCallback(
          `**UltraWork Session Complete** (${session.id}) — with incomplete items\n` +
            `Phases: Plan -> Build -> Retro -> Build (retry) -> Retro\n` +
            `Steps: ${session.currentStep} | Duration: ${Math.round((Date.now() - session.startTime) / 1000)}s`
        );
        return;
      }
    }

    // Complete
    if (this.stateManager) {
      await this.stateManager.updatePhase(session.id, 'completed');
    }
    session.active = false;
    this.sessions.delete(session.channelId);
    await notifyCallback(
      `**UltraWork Session Complete** (${session.id})\n` +
        `Phases: Plan -> Build -> Retrospective\n` +
        `Steps: ${session.currentStep} | Duration: ${Math.round((Date.now() - session.startTime) / 1000)}s`
    );
  }

  // ============================================================================
  // Freeform Loop (Legacy)
  // ============================================================================

  private async runFreeformLoop(
    session: UltraWorkSession,
    agents: AgentPersonaConfig[],
    executeCallback: DelegationExecuteCallback,
    notifyCallback: DelegationNotifyCallback,
    responseInterceptor?: ResponseInterceptor
  ): Promise<void> {
    const delegationManager = new DelegationManager(agents, this.permissionManager);
    const continuationEnforcer = new TaskContinuationEnforcer({
      enabled: true,
      max_retries: 3,
    });

    let consecutiveStalls = 0;
    let currentPrompt = this.buildInitialPrompt(session.task, agents);
    let currentAgentId = session.leadAgentId;

    while (this.shouldContinue(session)) {
      session.currentStep++;
      const stepStart = Date.now();

      try {
        const result = await this.executeWithTimeout(
          executeCallback,
          currentAgentId,
          currentPrompt
        );
        const stepDuration = Date.now() - stepStart;

        // Stall detection
        if (result.response.trim().length < STALL_MIN_LENGTH) {
          consecutiveStalls++;
          if (consecutiveStalls >= MAX_CONSECUTIVE_STALLS) {
            consecutiveStalls = 0;
            await notifyCallback(
              `Agent ${currentAgentId} appears stalled (${MAX_CONSECUTIVE_STALLS} short responses). Re-prompting...`
            );
            currentPrompt = `Your previous responses were too brief. The task is NOT complete yet.\n\nOriginal task: ${session.task}\n\nPlease take concrete action now. When fully done, respond with "DONE".`;
            currentAgentId = session.leadAgentId;
            session.steps.push({
              stepNumber: session.currentStep,
              agentId: currentAgentId,
              action: 'stall_detected',
              responseSummary: `Stalled: "${result.response.trim().substring(0, 100)}"`,
              isDelegation: false,
              duration: stepDuration,
              timestamp: Date.now(),
            });
            continue;
          }
        } else {
          consecutiveStalls = 0;
        }

        // Council/workflow interceptor
        if (responseInterceptor) {
          const intercepted = await responseInterceptor(result.response, session.channelId);
          if (intercepted) {
            session.steps.push({
              stepNumber: session.currentStep,
              agentId: currentAgentId,
              action: intercepted.type === 'council' ? 'council_execution' : 'workflow_execution',
              responseSummary: intercepted.result.substring(0, 200),
              isDelegation: false,
              duration: Date.now() - stepStart,
              timestamp: Date.now(),
            });
            await notifyCallback(intercepted.result);
            currentPrompt = `The ${intercepted.type} plan completed. Results:\n---\n${intercepted.result.substring(0, 1000)}\n---\nContinue with the next step. When done, respond with "DONE".`;
            currentAgentId = session.leadAgentId;
            continue;
          }
        }

        // Delegation check
        const delegationRequest = delegationManager.parseDelegation(
          currentAgentId,
          result.response
        );

        if (delegationRequest) {
          session.steps.push({
            stepNumber: session.currentStep,
            agentId: currentAgentId,
            action: 'delegation',
            responseSummary: delegationRequest.originalContent.substring(0, 200),
            isDelegation: true,
            duration: stepDuration,
            timestamp: Date.now(),
          });

          const delegationResult = await delegationManager.executeDelegation(
            delegationRequest,
            executeCallback,
            notifyCallback
          );

          if (delegationResult.success && delegationResult.response) {
            session.currentStep++;
            session.steps.push({
              stepNumber: session.currentStep,
              agentId: delegationRequest.toAgentId,
              action: 'delegated_task',
              responseSummary: delegationResult.response.substring(0, 200),
              isDelegation: false,
              duration: delegationResult.duration ?? 0,
              timestamp: Date.now(),
            });
            currentPrompt = this.buildContinuationAfterDelegation(
              delegationRequest.toAgentId,
              delegationResult.response
            );
            currentAgentId = session.leadAgentId;
          } else {
            currentPrompt = `Delegation to ${delegationRequest.toAgentId} failed: ${delegationResult.error}. Please continue the task yourself.`;
            currentAgentId = session.leadAgentId;
          }
        } else {
          session.steps.push({
            stepNumber: session.currentStep,
            agentId: currentAgentId,
            action: 'direct_work',
            responseSummary: result.response.substring(0, 200),
            isDelegation: false,
            duration: stepDuration,
            timestamp: Date.now(),
          });

          const continuation = continuationEnforcer.analyzeResponse(
            currentAgentId,
            session.channelId,
            result.response
          );

          if (continuation.isComplete) {
            session.active = false;
            this.sessions.delete(session.channelId);
            await notifyCallback(
              `**UltraWork Session Complete** (${session.id})\n` +
                `Steps: ${session.currentStep} | Duration: ${Math.round((Date.now() - session.startTime) / 1000)}s`
            );
            break;
          }

          if (continuation.maxRetriesReached) {
            session.active = false;
            this.sessions.delete(session.channelId);
            await notifyCallback(
              `**UltraWork Session Stopped** (${session.id}): Max continuation retries reached.\n` +
                `Steps: ${session.currentStep}`
            );
            break;
          }

          currentPrompt = continuationEnforcer.buildContinuationPrompt(result.response);
          currentAgentId = session.leadAgentId;
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        session.steps.push({
          stepNumber: session.currentStep,
          agentId: currentAgentId,
          action: 'error',
          responseSummary: errorMessage.substring(0, 200),
          isDelegation: false,
          duration: Date.now() - stepStart,
          timestamp: Date.now(),
        });
        currentPrompt = `An error occurred: ${errorMessage}. Please assess the situation and decide how to continue.`;
        currentAgentId = session.leadAgentId;
      }
    }

    // Session limits reached
    if (session.active) {
      this.endSession(session, notifyCallback);
    }
  }

  // ============================================================================
  // Prompt builders
  // ============================================================================

  private buildPlanningPrompt(task: string, agents: AgentPersonaConfig[]): string {
    const agentList = agents
      .filter((a) => a.enabled !== false)
      .map((a) => `- **${a.display_name}** (ID: ${a.id}, Tier ${a.tier ?? 1})`)
      .join('\n');

    return `**UltraWork — Phase 1: Planning**

You are leading an autonomous work session. Before implementing, create a detailed plan.

**Task:** ${task}

**Available agents:**
${agentList}

**Instructions:**
1. Analyze the task requirements
2. If multiple perspectives would help, start a council discussion:
   \`\`\`council_plan
   {"name":"plan_review","topic":"Review implementation approach for: ${task.substring(0, 100)}","agents":["developer","reviewer"],"rounds":1}
   \`\`\`
3. After gathering input, create a structured plan:

## Implementation Plan
### Task 1: [description]
- Assigned to: [agent_id]
- Acceptance criteria: [what defines "done"]
### Task 2: ...

4. End with "PLAN_COMPLETE" when the plan is ready.`;
  }

  private buildBuildingPrompt(plan: string, agents: AgentPersonaConfig[]): string {
    const agentList = agents
      .filter((a) => a.enabled !== false)
      .map((a) => `- ${a.display_name} (ID: ${a.id})`)
      .join('\n');

    return `**UltraWork — Phase 2: Building**

Execute the following plan. Delegate tasks to specialists.

**Plan:**
---
${plan.substring(0, 3000)}
---

**Available agents:**
${agentList}

**Instructions:**
- Execute tasks in order from the plan
- Delegate using: DELEGATE::{agent_id}::{task description with acceptance criteria}
- If a task fails or needs discussion, use council_plan for team input
- After ALL tasks are done, respond with "BUILD_COMPLETE"
- Do NOT skip any tasks from the plan`;
  }

  private buildRetrospectivePrompt(
    plan: string,
    steps: Array<{ stepNumber: number; action: string; agentId: string; responseSummary: string }>
  ): string {
    const stepSummary = steps
      .map(
        (s) =>
          `- Step ${s.stepNumber} [${s.action}] by ${s.agentId}: ${s.responseSummary.substring(0, 100)}`
      )
      .join('\n');

    return `**UltraWork — Phase 3: Retrospective**

Review the completed work against the original plan.

**Original Plan:**
---
${plan.substring(0, 2000)}
---

**Completed Steps:**
${stepSummary || '(no steps recorded)'}

**Instructions:**
1. Compare completed work against the plan
2. If team review would help, start a council discussion:
   \`\`\`council_plan
   {"name":"retrospective","topic":"Review completed work quality and identify gaps","agents":["developer","reviewer"],"rounds":1}
   \`\`\`
3. After council input, provide final assessment:
   - What was completed successfully
   - What needs additional work (if any)
   - Lessons learned
4. If ALL tasks are done satisfactorily: respond with "RETRO_COMPLETE"
5. If tasks remain: respond with "RETRO_INCOMPLETE" and list remaining items`;
  }

  private buildInitialPrompt(task: string, agents: AgentPersonaConfig[]): string {
    const agentList = agents
      .filter((a) => a.enabled !== false)
      .map((a) => `- ${a.display_name} (ID: ${a.id}, Tier ${a.tier ?? 1})`)
      .join('\n');

    return `**UltraWork Session**

You are leading an autonomous work session. Complete the following task:

**Task:** ${task}

**Available agents for delegation:**
${agentList}

**Instructions:**
- Break down the task into steps
- Delegate specialized work using: DELEGATE::{agent_id}::{task description}
- For independent tasks that don't block you: DELEGATE_BG::{agent_id}::{task description}
  (Background delegation — you continue working, result is notified in chat when done)
- End your response with "DONE" when the overall task is complete
- Stay focused on the task and be efficient`;
  }

  private buildContinuationAfterDelegation(delegatedAgentId: string, response: string): string {
    const summary = response.length > 500 ? response.substring(0, 500) + '...' : response;

    return `Agent ${delegatedAgentId} completed the delegated task. Their response:
---
${summary}
---
Continue with the next step of the overall task. When everything is done, respond with "DONE".`;
  }

  // ============================================================================
  // Completion markers
  // ============================================================================

  private isBuildComplete(response: string): boolean {
    return /\bBUILD_COMPLETE\b/i.test(response);
  }

  private isRetroComplete(response: string): boolean {
    return /RETRO_COMPLETE/i.test(response);
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  private async endSession(
    session: UltraWorkSession,
    notifyCallback: DelegationNotifyCallback
  ): Promise<void> {
    const reason =
      session.currentStep >= session.maxSteps ? 'max steps reached' : 'max duration reached';

    session.active = false;
    this.sessions.delete(session.channelId);

    await notifyCallback(
      `**UltraWork Session Ended** (${session.id}): ${reason}.\n` +
        `Steps: ${session.currentStep} | Duration: ${Math.round((Date.now() - session.startTime) / 1000)}s`
    );
  }
}
