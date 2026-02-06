/**
 * Tool Permission Manager
 *
 * Manages tool access permissions based on agent tier levels.
 * Tier 1: Full access (can delegate)
 * Tier 2: Read/analyze only (no write/edit/bash)
 * Tier 3: Read/analyze only (no write/edit/bash)
 *
 * Explicit tool_permissions on an agent override tier defaults.
 */

import type { AgentPersonaConfig } from './types.js';

/**
 * Resolved tool permissions for an agent
 */
export interface ToolPermissions {
  allowed: string[];
  blocked: string[];
}

/**
 * Tool Permission Manager
 */
export class ToolPermissionManager {
  /**
   * Default permissions per tier
   * Tier 1: All tools allowed (backward compatible)
   * Tier 2/3: Read-only tools (no destructive operations)
   */
  private static readonly TIER_DEFAULTS: Record<number, ToolPermissions> = {
    1: { allowed: ['*'], blocked: [] },
    2: {
      allowed: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
      blocked: ['Write', 'Edit', 'Bash', 'NotebookEdit'],
    },
    3: {
      allowed: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
      blocked: ['Write', 'Edit', 'Bash', 'NotebookEdit'],
    },
  };

  /**
   * Resolve final permissions for an agent.
   * Explicit tool_permissions override tier defaults.
   */
  resolvePermissions(agent: AgentPersonaConfig): ToolPermissions {
    const tier = agent.tier ?? 1;

    // Get tier defaults, falling back to Tier 2 (read-only) for unsupported tier values
    const tierDefaults = ToolPermissionManager.TIER_DEFAULTS[tier];
    if (!tierDefaults) {
      console.warn(
        `[ToolPermissionManager] Unsupported tier ${tier} for agent ${agent.id}, falling back to Tier 2 (read-only)`
      );
    }
    const defaults = tierDefaults ?? ToolPermissionManager.TIER_DEFAULTS[2];

    // Explicit permissions take priority over tier defaults
    if (agent.tool_permissions) {
      return {
        allowed: agent.tool_permissions.allowed ?? defaults.allowed,
        blocked: agent.tool_permissions.blocked ?? defaults.blocked,
      };
    }

    return { ...defaults };
  }

  /**
   * Check if a specific tool is allowed for an agent.
   * Blocked list takes precedence over allowed list.
   * Supports wildcard matching (e.g., "mama_*" matches "mama_search").
   */
  isToolAllowed(agent: AgentPersonaConfig, toolName: string): boolean {
    const permissions = this.resolvePermissions(agent);

    // Check blocked first (blocked takes precedence)
    if (this.matchesAny(toolName, permissions.blocked)) {
      return false;
    }

    // Check allowed
    return this.matchesAny(toolName, permissions.allowed);
  }

  /**
   * Build a markdown section describing tool permissions for the system prompt.
   */
  buildPermissionPrompt(agent: AgentPersonaConfig): string {
    const tier = agent.tier ?? 1;
    const permissions = this.resolvePermissions(agent);

    const lines: string[] = [];
    lines.push(`## Tool Permissions (Tier ${tier})`);
    lines.push('');

    if (permissions.allowed.includes('*')) {
      lines.push('- You have access to **all tools**.');
    } else {
      lines.push(`- **Allowed tools:** ${permissions.allowed.join(', ')}`);
    }

    if (permissions.blocked.length > 0) {
      lines.push(`- **Blocked tools (DO NOT USE):** ${permissions.blocked.join(', ')}`);
      if (this.canDelegate(agent)) {
        lines.push('- Delegate tasks requiring blocked tools to other agents via @mention.');
      } else {
        lines.push('- If you need a blocked tool, ask a Tier 1 agent to help via delegation.');
      }
    }

    lines.push('');
    return lines.join('\n');
  }

  /**
   * Check if an agent can delegate tasks to other agents.
   * Only Tier 1 agents with can_delegate=true can delegate.
   */
  canDelegate(agent: AgentPersonaConfig): boolean {
    return (agent.tier ?? 1) === 1 && agent.can_delegate === true;
  }

  /**
   * Check if an agent supports automatic task continuation.
   */
  canAutoContinue(agent: AgentPersonaConfig): boolean {
    return agent.auto_continue === true;
  }

  /**
   * Build delegation prompt for Tier 1 agents that can delegate.
   * Lists available agents they can delegate to.
   */
  buildDelegationPrompt(agent: AgentPersonaConfig, allAgents: AgentPersonaConfig[]): string {
    if (!this.canDelegate(agent)) {
      return '';
    }

    const delegatableAgents = allAgents.filter((a) => a.id !== agent.id && a.enabled !== false);

    if (delegatableAgents.length === 0) {
      return '';
    }

    const lines: string[] = [];
    lines.push('## Delegation');
    lines.push('');
    lines.push('You can delegate tasks to other agents using the format:');
    lines.push('`DELEGATE::{agent_id}::{task description}`');
    lines.push('');
    lines.push('Available agents for delegation:');

    for (const a of delegatableAgents) {
      const tier = a.tier ?? 1;
      lines.push(`- **${a.display_name}** (ID: ${a.id}, Tier ${tier}): ${a.name}`);
    }

    lines.push('');
    lines.push('**Rules:**');
    lines.push("- Only delegate when the task matches another agent's expertise");
    lines.push('- Delegation depth is limited to 1 (no re-delegation)');
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Build mention-based delegation prompt for agents.
   * Uses <@USER_ID> format so agents delegate via Discord @mentions.
   */
  buildMentionDelegationPrompt(
    agent: AgentPersonaConfig,
    allAgents: AgentPersonaConfig[],
    botUserIdMap: Map<string, string>
  ): string {
    if (!this.canDelegate(agent)) {
      return '';
    }

    const delegatableAgents = allAgents.filter(
      (a) => a.id !== agent.id && a.enabled !== false && botUserIdMap.has(a.id)
    );

    if (delegatableAgents.length === 0) {
      return '';
    }

    const lines: string[] = [];
    lines.push('## Delegation via @Mention');
    lines.push('');
    lines.push('You can delegate tasks to other agents by mentioning them in your response.');
    lines.push(
      'Use the @mention format shown below. The mentioned agent will automatically receive your message and respond.'
    );
    lines.push('');
    lines.push('Available agents for delegation:');

    for (const a of delegatableAgents) {
      const tier = a.tier ?? 1;
      const userId = botUserIdMap.get(a.id)!;
      lines.push(`- **${a.display_name}** (Tier ${tier}): mention with <@${userId}>`);
    }

    lines.push('');
    lines.push('**Rules:**');
    lines.push('- Mention only ONE agent at a time per message');
    lines.push("- Only delegate when the task matches another agent's expertise");
    lines.push('- Include a clear task description after the mention');
    lines.push('- Example: "<@123456789> please review this code for security issues"');
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Check if a tool name matches any pattern in the list.
   * Supports exact match and wildcard suffix (e.g., "mama_*").
   */
  private matchesAny(toolName: string, patterns: string[]): boolean {
    for (const pattern of patterns) {
      if (pattern === '*') return true;
      if (pattern === toolName) return true;

      // Wildcard suffix: "mama_*" matches "mama_search", "mama_save", etc.
      if (pattern.endsWith('*')) {
        const prefix = pattern.slice(0, -1);
        if (toolName.startsWith(prefix)) return true;
      }
    }
    return false;
  }
}
