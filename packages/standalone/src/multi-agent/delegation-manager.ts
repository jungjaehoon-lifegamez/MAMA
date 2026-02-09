/**
 * Delegation Manager
 *
 * Enables Tier 1 agents to delegate tasks to Tier 2/3 agents.
 * Parses DELEGATE::{agent_id}::{task} patterns from agent responses
 * and executes the delegation workflow.
 *
 * Supports two delegation modes:
 * - **Synchronous:** DELEGATE::{agent_id}::{task} — waits for result
 * - **Background:** DELEGATE_BG::{agent_id}::{task} — returns immediately, runs async
 *
 * Constraints:
 * - Only Tier 1 agents with can_delegate=true can delegate
 * - Maximum delegation depth of 1 (no re-delegation)
 * - Circular delegation prevention
 */

import type { AgentPersonaConfig } from './types.js';
import { ToolPermissionManager } from './tool-permission-manager.js';

/**
 * Parsed delegation request
 */
export interface DelegationRequest {
  /** Agent ID that initiated the delegation */
  fromAgentId: string;
  /** Target agent ID to delegate to */
  toAgentId: string;
  /** Task description to delegate */
  task: string;
  /** Original response content (without the DELEGATE pattern) */
  originalContent: string;
  /** Whether this is a background (async) delegation */
  background: boolean;
}

/**
 * Result of a delegation execution
 */
export interface DelegationResult {
  /** Whether delegation was successful */
  success: boolean;
  /** Delegated agent's response (if successful) */
  response?: string;
  /** Error message (if failed) */
  error?: string;
  /** Duration of delegation in ms */
  duration?: number;
}

/**
 * Callback to send a message to a channel (for notifications)
 */
export type DelegationNotifyCallback = (message: string) => Promise<void>;

/**
 * Callback to get an agent's response for a given prompt
 */
export type DelegationExecuteCallback = (
  agentId: string,
  prompt: string
) => Promise<{ response: string; duration_ms: number }>;

const DELEGATE_PATTERN = /DELEGATE::([\w-]+)::(.+)/s;
const DELEGATE_BG_PATTERN = /DELEGATE_BG::([\w-]+)::(.+)/s;

/**
 * Delegation Manager
 */
export class DelegationManager {
  private permissionManager: ToolPermissionManager;
  private agents: Map<string, AgentPersonaConfig>;

  /** Active delegations for circular prevention: Set<fromId:toId> */
  private activeDelegations: Set<string> = new Set();

  constructor(agents: AgentPersonaConfig[], permissionManager?: ToolPermissionManager) {
    this.permissionManager = permissionManager ?? new ToolPermissionManager();
    this.agents = new Map(agents.map((a) => [a.id, a]));
  }

  parseDelegation(agentId: string, response: string): DelegationRequest | null {
    const bgMatch = response.match(DELEGATE_BG_PATTERN);
    if (bgMatch) {
      const originalContent = response.replace(DELEGATE_BG_PATTERN, '').trim();
      return {
        fromAgentId: agentId,
        toAgentId: bgMatch[1],
        task: bgMatch[2].trim(),
        originalContent,
        background: true,
      };
    }

    const match = response.match(DELEGATE_PATTERN);
    if (!match) return null;

    const originalContent = response.replace(DELEGATE_PATTERN, '').trim();
    return {
      fromAgentId: agentId,
      toAgentId: match[1],
      task: match[2].trim(),
      originalContent,
      background: false,
    };
  }

  /**
   * Check if a delegation is allowed.
   */
  isDelegationAllowed(fromId: string, toId: string): { allowed: boolean; reason: string } {
    const fromAgent = this.agents.get(fromId);
    if (!fromAgent) {
      return { allowed: false, reason: `Unknown source agent: ${fromId}` };
    }

    const toAgent = this.agents.get(toId);
    if (!toAgent) {
      return { allowed: false, reason: `Unknown target agent: ${toId}` };
    }

    // Check if source can delegate
    if (!this.permissionManager.canDelegate(fromAgent)) {
      return {
        allowed: false,
        reason: `Agent ${fromId} cannot delegate (requires Tier 1 + can_delegate=true)`,
      };
    }

    // Check if target is enabled
    if (toAgent.enabled === false) {
      return { allowed: false, reason: `Target agent ${toId} is disabled` };
    }

    // Check for self-delegation
    if (fromId === toId) {
      return { allowed: false, reason: 'Cannot delegate to self' };
    }

    // Check for circular delegation (depth > 1)
    const delegationKey = `${fromId}:${toId}`;
    if (this.activeDelegations.has(delegationKey)) {
      return { allowed: false, reason: `Circular delegation detected: ${fromId} -> ${toId}` };
    }

    // Check reverse delegation (toAgent delegating back to fromAgent)
    const reverseKey = `${toId}:${fromId}`;
    if (this.activeDelegations.has(reverseKey)) {
      return {
        allowed: false,
        reason: `Reverse delegation detected: ${toId} already delegating to ${fromId}`,
      };
    }

    return { allowed: true, reason: 'ok' };
  }

  /**
   * Execute a delegation request.
   */
  async executeDelegation(
    request: DelegationRequest,
    executeCallback: DelegationExecuteCallback,
    notifyCallback?: DelegationNotifyCallback
  ): Promise<DelegationResult> {
    const { fromAgentId, toAgentId, task } = request;

    // Validate delegation
    const check = this.isDelegationAllowed(fromAgentId, toAgentId);
    if (!check.allowed) {
      return { success: false, error: check.reason };
    }

    const delegationKey = `${fromAgentId}:${toAgentId}`;
    this.activeDelegations.add(delegationKey);

    try {
      // Notify channel about delegation
      const fromAgent = this.agents.get(fromAgentId);
      const toAgent = this.agents.get(toAgentId);

      if (notifyCallback && fromAgent && toAgent) {
        await notifyCallback(
          `**${fromAgent.display_name}** delegated a task to **${toAgent.display_name}**: ${task.substring(0, 100)}${task.length > 100 ? '...' : ''}`
        );
      }

      // Build delegation prompt
      const delegationPrompt = this.buildDelegationTaskPrompt(fromAgentId, task);

      // Execute the delegated task
      const result = await executeCallback(toAgentId, delegationPrompt);

      return {
        success: true,
        response: result.response,
        duration: result.duration_ms,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Delegation failed: ${errorMessage}`,
      };
    } finally {
      this.activeDelegations.delete(delegationKey);
    }
  }

  /**
   * Update the agent list (for hot reload).
   */
  updateAgents(agents: AgentPersonaConfig[]): void {
    this.agents = new Map(agents.map((a) => [a.id, a]));
  }

  /**
   * Get active delegation count (for monitoring).
   */
  getActiveDelegationCount(): number {
    return this.activeDelegations.size;
  }

  /**
   * Build the prompt sent to the delegated agent.
   */
  private buildDelegationTaskPrompt(fromAgentId: string, task: string): string {
    const fromAgent = this.agents.get(fromAgentId);
    const fromName = fromAgent?.display_name ?? fromAgentId;

    return `**Delegated Task** from ${fromName}:

${task}

Please complete this task. When finished, include "DONE" in your response.
Do NOT delegate this task further.`;
  }
}
