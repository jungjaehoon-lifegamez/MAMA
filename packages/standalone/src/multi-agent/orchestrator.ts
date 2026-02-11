/**
 * Multi-Agent Orchestrator
 *
 * Manages agent selection, trigger matching, and loop prevention
 * for multi-agent Discord conversations.
 */

import type {
  MultiAgentConfig,
  AgentPersonaConfig,
  ChainState,
  AgentSelectionResult,
  MessageContext,
  AgentResponseRecord,
} from './types.js';
import { DEFAULT_LOOP_PREVENTION } from './types.js';
import { CategoryRouter } from './category-router.js';
import { createSafeLogger } from '../utils/log-sanitizer.js';

/**
 * Multi-Agent Orchestrator
 *
 * Responsibilities:
 * 1. Select which agent(s) should respond to a message
 * 2. Track response chains to prevent infinite loops
 * 3. Manage per-agent cooldowns
 * 4. Reset chain state on human messages
 */
export class MultiAgentOrchestrator {
  private logger = createSafeLogger('Orchestrator');
  private config: MultiAgentConfig;
  private categoryRouter: CategoryRouter;

  /** Chain state per channel: Map<channelId, ChainState> */
  private chainStates: Map<string, ChainState> = new Map();
  /** Per-channel chain length overrides */
  private chainLimitOverrides: Map<string, number> = new Map();

  /** Last response time per agent: Map<agentId, timestamp> */
  private agentCooldowns: Map<string, number> = new Map();

  /** Response history for debugging: limited to last 100 entries */
  private responseHistory: AgentResponseRecord[] = [];
  private readonly MAX_HISTORY = 100;

  constructor(config: MultiAgentConfig) {
    this.config = config;
    this.categoryRouter = new CategoryRouter(config.categories);
  }

  /**
   * Update configuration (for hot reload)
   */
  updateConfig(config: MultiAgentConfig): void {
    this.config = config;
    this.categoryRouter.updateCategories(config.categories ?? []);
  }

  /**
   * Get agent configuration by ID
   */
  getAgent(agentId: string): AgentPersonaConfig | undefined {
    const agentConfig = this.config.agents[agentId];
    if (!agentConfig) return undefined;

    return {
      id: agentId,
      ...agentConfig,
    };
  }

  /**
   * Get all enabled agents
   */
  getEnabledAgents(): AgentPersonaConfig[] {
    return Object.entries(this.config.agents)
      .filter(([, config]) => config.enabled !== false)
      .map(([id, config]) => ({
        id,
        ...config,
      }));
  }

  /**
   * Select which agents should respond to a message
   */
  selectRespondingAgents(context: MessageContext): AgentSelectionResult {
    // If multi-agent is disabled, return empty
    if (!this.config.enabled) {
      return {
        selectedAgents: [],
        reason: 'none',
        blocked: false,
      };
    }

    // If sender is human, reset chain and process selection
    if (!context.isBot) {
      this.resetChain(context.channelId);
    }

    // Check if chain is blocked
    const chainState = this.getChainState(context.channelId);
    const maxChainLength = this.getMaxChainLength(context.channelId);
    if (chainState.blocked) {
      return {
        selectedAgents: [],
        reason: 'none',
        blocked: true,
        blockReason: `Chain limit reached (${chainState.length}/${maxChainLength}). Waiting for human input.`,
      };
    }

    // Check global cooldown (skip for agent-to-agent in free_chat mode)
    const now = Date.now();
    const timeSinceLastResponse = now - chainState.lastResponseTime;
    const isAgentToAgent = context.isBot && context.senderAgentId && this.config.free_chat;
    if (!isAgentToAgent && timeSinceLastResponse < this.config.loop_prevention.global_cooldown_ms) {
      return {
        selectedAgents: [],
        reason: 'none',
        blocked: true,
        blockReason: `Global cooldown active (${this.config.loop_prevention.global_cooldown_ms - timeSinceLastResponse}ms remaining)`,
      };
    }

    // Get channel-specific overrides
    const channelOverride = this.config.channel_overrides?.[context.channelId];
    const allowedAgents = channelOverride?.allowed_agents;
    const disabledAgents = channelOverride?.disabled_agents || [];

    // Filter agents based on channel config
    const availableAgents = this.getEnabledAgents().filter((agent) => {
      if (disabledAgents.includes(agent.id)) return false;
      if (allowedAgents && !allowedAgents.includes(agent.id)) return false;
      return true;
    });

    // 0. Free chat mode
    if (this.config.free_chat) {
      if (!context.isBot) {
        // If specific agents are @mentioned, only those respond
        if (context.mentionedAgentIds && context.mentionedAgentIds.length > 0) {
          const mentionedAvailable = availableAgents.filter((a) =>
            context.mentionedAgentIds!.includes(a.id)
          );
          if (mentionedAvailable.length > 0) {
            this.agentCooldowns.clear();
            return {
              selectedAgents: mentionedAvailable.map((a) => a.id),
              reason: 'free_chat',
              blocked: false,
            };
          }
        }
        // No specific mention: all agents respond (reset cooldowns for fresh start)
        this.agentCooldowns.clear();
        return {
          selectedAgents: availableAgents.map((a) => a.id),
          reason: 'free_chat',
          blocked: false,
        };
      } else if (context.senderAgentId) {
        // Agent message: other agents respond (agent-to-agent)
        // Skip per-agent cooldown - chain limit handles loop prevention
        const otherAgents = availableAgents.filter((a) => a.id !== context.senderAgentId);
        if (otherAgents.length > 0) {
          return {
            selectedAgents: otherAgents.map((a) => a.id),
            reason: 'free_chat',
            blocked: false,
          };
        }
      }
    }

    // 1. Check for explicit trigger prefix
    const explicitAgent = this.findExplicitTrigger(context.content, availableAgents);
    if (explicitAgent) {
      // Check agent cooldown
      if (!this.isAgentReady(explicitAgent.id)) {
        return {
          selectedAgents: [],
          reason: 'explicit_trigger',
          blocked: true,
          blockReason: `Agent ${explicitAgent.id} is on cooldown`,
        };
      }

      return {
        selectedAgents: [explicitAgent.id],
        reason: 'explicit_trigger',
        blocked: false,
      };
    }

    // 1.5 Category-based routing
    const categoryMatch = this.categoryRouter.route(context.content, availableAgents);
    if (categoryMatch) {
      // Filter out agents on cooldown
      const readyAgents = categoryMatch.agentIds.filter((id) => this.isAgentReady(id));
      if (readyAgents.length > 0) {
        return {
          selectedAgents: readyAgents,
          reason: 'category_match',
          blocked: false,
        };
      }
    }

    // 2. Check for keyword matches (only for human messages or agent-to-agent)
    const keywordMatches = this.findKeywordMatches(context.content, availableAgents);

    // Filter out agents on cooldown and exclude the sender agent
    const readyAgents = keywordMatches.filter(
      (agent) => this.isAgentReady(agent.id) && agent.id !== context.senderAgentId
    );

    if (readyAgents.length > 0) {
      // If message is from another agent, only allow one response to prevent cross-talk spam
      const selectedCount = context.isBot ? 1 : readyAgents.length;

      return {
        selectedAgents: readyAgents.slice(0, selectedCount).map((a) => a.id),
        reason: 'keyword_match',
        blocked: false,
      };
    }

    // 3. Check for default agent (only for human messages)
    if (!context.isBot) {
      const defaultAgentId = channelOverride?.default_agent || this.config.default_agent;
      if (defaultAgentId) {
        const defaultAgent = availableAgents.find((a) => a.id === defaultAgentId);
        if (defaultAgent && this.isAgentReady(defaultAgent.id)) {
          return {
            selectedAgents: [defaultAgent.id],
            reason: 'default_agent',
            blocked: false,
          };
        }
      }
    }

    return {
      selectedAgents: [],
      reason: 'none',
      blocked: false,
    };
  }

  /**
   * Record an agent response (updates chain state and cooldowns)
   */
  recordAgentResponse(agentId: string, channelId: string, messageId?: string): void {
    const now = Date.now();

    // Update agent cooldown
    this.agentCooldowns.set(agentId, now);

    // Update chain state
    const chainState = this.getChainState(channelId);
    const loopPrevention = this.config.loop_prevention || DEFAULT_LOOP_PREVENTION;

    // Check if chain window has expired
    if (now - chainState.lastResponseTime > loopPrevention.chain_window_ms) {
      // Start new chain
      chainState.length = 1;
    } else {
      // Continue chain
      chainState.length++;
    }

    chainState.lastResponseTime = now;
    chainState.lastAgentId = agentId;

    // Check if chain limit reached
    const maxChainLength = this.getMaxChainLength(channelId);
    if (chainState.length >= maxChainLength) {
      chainState.blocked = true;
      this.logger.debug(
        `[Orchestrator] Chain limit reached for channel ${channelId} (${chainState.length}/${maxChainLength})`
      );
    }

    this.chainStates.set(channelId, chainState);

    // Record to history
    this.responseHistory.push({
      agentId,
      channelId,
      timestamp: now,
      messageId,
    });

    // Trim history if needed
    if (this.responseHistory.length > this.MAX_HISTORY) {
      this.responseHistory = this.responseHistory.slice(-this.MAX_HISTORY);
    }

    this.logger.info(
      `[Orchestrator] Recorded response: agent=${agentId}, channel=${channelId}, chain=${chainState.length}`
    );
  }

  /**
   * Reset chain state for a channel (called on human message)
   */
  resetChain(channelId: string): void {
    const chainState = this.chainStates.get(channelId);
    if (chainState) {
      this.logger.info(
        `[Orchestrator] Resetting chain for channel ${channelId} (was: ${chainState.length}, blocked: ${chainState.blocked})`
      );
    }

    this.chainStates.set(channelId, {
      length: 0,
      lastResponseTime: 0,
      lastAgentId: null,
      blocked: false,
    });
  }

  /**
   * Override max chain length for a channel (runtime).
   */
  setChannelChainLimit(channelId: string, maxChainLength: number): void {
    if (maxChainLength <= 0) {
      throw new Error('maxChainLength must be greater than 0');
    }
    this.chainLimitOverrides.set(channelId, maxChainLength);
  }

  /**
   * Clear max chain length override for a channel.
   */
  clearChannelChainLimit(channelId: string): void {
    this.chainLimitOverrides.delete(channelId);
  }

  /**
   * Get effective max chain length for a channel.
   */
  private getMaxChainLength(channelId: string): number {
    return this.chainLimitOverrides.get(channelId) ?? this.config.loop_prevention.max_chain_length;
  }

  /**
   * Get chain state for a channel
   */
  getChainState(channelId: string): ChainState {
    let state = this.chainStates.get(channelId);
    if (!state) {
      state = {
        length: 0,
        lastResponseTime: 0,
        lastAgentId: null,
        blocked: false,
      };
      this.chainStates.set(channelId, state);
    }
    return state;
  }

  /**
   * Check if an agent is ready (not on cooldown)
   */
  isAgentReady(agentId: string): boolean {
    const lastResponse = this.agentCooldowns.get(agentId);
    if (!lastResponse) return true;

    const agent = this.getAgent(agentId);
    const cooldownMs = agent?.cooldown_ms || 5000;

    return Date.now() - lastResponse >= cooldownMs;
  }

  /**
   * Find explicit trigger prefix match
   */
  private findExplicitTrigger(
    content: string,
    agents: AgentPersonaConfig[]
  ): AgentPersonaConfig | null {
    const trimmedContent = content.trim().toLowerCase();

    for (const agent of agents) {
      const prefix = agent.trigger_prefix.toLowerCase();
      if (trimmedContent.startsWith(prefix)) {
        return agent;
      }
    }

    return null;
  }

  /**
   * Find agents that match keywords in the message
   */
  private findKeywordMatches(content: string, agents: AgentPersonaConfig[]): AgentPersonaConfig[] {
    const lowerContent = content.toLowerCase();
    const matches: AgentPersonaConfig[] = [];

    for (const agent of agents) {
      const keywords = agent.auto_respond_keywords || [];
      for (const keyword of keywords) {
        if (lowerContent.includes(keyword.toLowerCase())) {
          matches.push(agent);
          break; // One match per agent is enough
        }
      }
    }

    return matches;
  }

  /**
   * Extract agent ID from a bot message's display name
   * @example "**🔧 DevBot**: Hello" -> "developer"
   */
  extractAgentIdFromMessage(messageContent: string): string | null {
    // Pattern: **<emoji> <name>**: or **<name>**:
    const match = messageContent.match(/^\*\*([^*]+)\*\*:/);
    if (!match) return null;

    const displayName = match[1].trim();

    // Find agent by display_name or name
    for (const [agentId, config] of Object.entries(this.config.agents)) {
      if (config.display_name === displayName || config.name === displayName) {
        return agentId;
      }
    }

    return null;
  }

  /**
   * Strip trigger prefix from message content
   */
  stripTriggerPrefix(content: string, agentId: string): string {
    const agent = this.getAgent(agentId);
    if (!agent) return content;

    const prefix = agent.trigger_prefix.toLowerCase();
    const trimmedContent = content.trim();

    if (trimmedContent.toLowerCase().startsWith(prefix)) {
      return trimmedContent.slice(prefix.length).trim();
    }

    return content;
  }

  /**
   * Get response history for debugging
   */
  getResponseHistory(): AgentResponseRecord[] {
    return [...this.responseHistory];
  }

  /**
   * Clear all state (for testing)
   */
  clearState(): void {
    this.chainStates.clear();
    this.agentCooldowns.clear();
    this.responseHistory = [];
  }
}
