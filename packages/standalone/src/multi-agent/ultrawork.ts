/**
 * UltraWork Manager
 *
 * Manages autonomous multi-step work sessions that combine
 * delegation and task continuation for extended workflows.
 *
 * UltraWork sessions allow a Tier 1 lead agent to autonomously
 * orchestrate work by delegating tasks, continuing incomplete
 * responses, and coordinating with other agents.
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

  /** Active sessions per channel */
  private sessions: Map<string, UltraWorkSession> = new Map();

  /** Session counter for unique IDs */
  private sessionCounter = 0;

  constructor(config: UltraWorkConfig, permissionManager?: ToolPermissionManager) {
    this.config = config;
    this.permissionManager = permissionManager ?? new ToolPermissionManager();
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
    notifyCallback: DelegationNotifyCallback
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

    await notifyCallback(
      `**UltraWork Session Started** (${session.id})\n` +
        `Lead: **${leadAgent.display_name}**\n` +
        `Task: ${task.substring(0, 200)}${task.length > 200 ? '...' : ''}\n` +
        `Limits: ${session.maxSteps} steps, ${Math.round(session.maxDuration / 60000)} min`
    );

    // Run the autonomous loop in detached context (non-blocking)
    // This prevents blocking the Discord message handler for up to 30 minutes
    this.runSessionLoop(session, agents, executeCallback, notifyCallback).catch((err) => {
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
   * Run the autonomous session loop.
   * Lead agent works on the task, delegating and continuing as needed.
   */
  private async runSessionLoop(
    session: UltraWorkSession,
    agents: AgentPersonaConfig[],
    executeCallback: DelegationExecuteCallback,
    notifyCallback: DelegationNotifyCallback
  ): Promise<void> {
    const delegationManager = new DelegationManager(agents, this.permissionManager);
    const continuationEnforcer = new TaskContinuationEnforcer({
      enabled: true,
      max_retries: 3,
    });

    // Initial prompt for lead agent
    let currentPrompt = this.buildInitialPrompt(session.task, agents);
    let currentAgentId = session.leadAgentId;

    while (this.shouldContinue(session)) {
      session.currentStep++;
      const stepStart = Date.now();

      try {
        // Execute current agent's task
        const result = await executeCallback(currentAgentId, currentPrompt);
        const stepDuration = Date.now() - stepStart;

        // Check for delegation in response
        const delegationRequest = delegationManager.parseDelegation(
          currentAgentId,
          result.response
        );

        if (delegationRequest) {
          // Record lead agent's step
          session.steps.push({
            stepNumber: session.currentStep,
            agentId: currentAgentId,
            action: 'delegation',
            responseSummary: delegationRequest.originalContent.substring(0, 200),
            isDelegation: true,
            duration: stepDuration,
            timestamp: Date.now(),
          });

          // Execute delegation
          const delegationResult = await delegationManager.executeDelegation(
            delegationRequest,
            executeCallback,
            notifyCallback
          );

          if (delegationResult.success && delegationResult.response) {
            // Increment again: delegation response counts as a separate step from the lead's request
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

            // Continue with lead agent, incorporating delegation result
            currentPrompt = this.buildContinuationAfterDelegation(
              delegationRequest.toAgentId,
              delegationResult.response
            );
            currentAgentId = session.leadAgentId;
          } else {
            // Delegation failed, let lead agent continue
            currentPrompt = `Delegation to ${delegationRequest.toAgentId} failed: ${delegationResult.error}. Please continue the task yourself.`;
            currentAgentId = session.leadAgentId;
          }
        } else {
          // No delegation - record step and check continuation
          session.steps.push({
            stepNumber: session.currentStep,
            agentId: currentAgentId,
            action: 'direct_work',
            responseSummary: result.response.substring(0, 200),
            isDelegation: false,
            duration: stepDuration,
            timestamp: Date.now(),
          });

          // Check if response is complete
          const continuation = continuationEnforcer.analyzeResponse(
            currentAgentId,
            session.channelId,
            result.response
          );

          if (continuation.isComplete) {
            // Task is done
            session.active = false;
            this.sessions.delete(session.channelId);
            await notifyCallback(
              `**UltraWork Session Complete** (${session.id})\n` +
                `Steps: ${session.currentStep} | Duration: ${Math.round((Date.now() - session.startTime) / 1000)}s`
            );
            break;
          }

          if (continuation.maxRetriesReached) {
            // Can't continue further
            session.active = false;
            this.sessions.delete(session.channelId);
            await notifyCallback(
              `**UltraWork Session Stopped** (${session.id}): Max continuation retries reached.\n` +
                `Steps: ${session.currentStep}`
            );
            break;
          }

          // Build continuation prompt
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

        // Try to recover by sending error context to lead
        currentPrompt = `An error occurred: ${errorMessage}. Please assess the situation and decide how to continue.`;
        currentAgentId = session.leadAgentId;
      }
    }

    // Session limits reached
    if (session.active) {
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

  /**
   * Build the initial prompt for the lead agent.
   */
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
- End your response with "DONE" when the overall task is complete
- Stay focused on the task and be efficient`;
  }

  /**
   * Build continuation prompt after a delegation completes.
   */
  private buildContinuationAfterDelegation(delegatedAgentId: string, response: string): string {
    const summary = response.length > 500 ? response.substring(0, 500) + '...' : response;

    return `Agent ${delegatedAgentId} completed the delegated task. Their response:
---
${summary}
---
Continue with the next step of the overall task. When everything is done, respond with "DONE".`;
  }
}
