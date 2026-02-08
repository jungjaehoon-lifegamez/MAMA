/**
 * Agent Process Manager
 *
 * Manages per-agent persistent CLI processes with persona-specific
 * system prompts and channel isolation.
 *
 * Channel key format: {source}:{channelId}:{agentId}
 * Example: "discord:123456789:developer"
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import {
  PersistentProcessPool,
  PersistentClaudeProcess,
  type PersistentProcessOptions,
} from '../agent/persistent-cli-process.js';
import type { AgentPersonaConfig, MultiAgentConfig } from './types.js';
import { ToolPermissionManager } from './tool-permission-manager.js';
import { AgentProcessPool } from './agent-process-pool.js';

/**
 * Resolve path with ~ expansion
 */
function resolvePath(path: string): string {
  if (path.startsWith('~')) {
    return resolve(homedir(), path.slice(2));
  }
  return resolve(path);
}

/**
 * Agent Process Manager
 *
 * Features:
 * - One persistent CLI process per agent per channel
 * - Persona file loading and system prompt injection
 * - Automatic process lifecycle management
 *
 * Events:
 * - 'process-created': { agentId: string, process: PersistentClaudeProcess }
 */
export class AgentProcessManager extends EventEmitter {
  private config: MultiAgentConfig;
  private processPool: PersistentProcessPool;
  private agentProcessPool: AgentProcessPool;
  private permissionManager: ToolPermissionManager;

  /** Cached persona content: Map<agentId, systemPrompt> */
  private personaCache: Map<string, string> = new Map();

  /** Bot user ID map for mention-based delegation: agentId → Discord userId */
  private botUserIdMap: Map<string, string> = new Map();

  /** Whether mention-based delegation is enabled */
  private mentionDelegationEnabled = false;

  /** Default options for all processes */
  private defaultOptions: Partial<PersistentProcessOptions>;

  constructor(config: MultiAgentConfig, defaultOptions: Partial<PersistentProcessOptions> = {}) {
    super(); // EventEmitter
    this.config = config;
    this.defaultOptions = defaultOptions;
    this.processPool = new PersistentProcessPool(defaultOptions);
    this.permissionManager = new ToolPermissionManager();

    // Initialize AgentProcessPool with per-agent pool sizes
    const agentPoolSizes: Record<string, number> = {};
    for (const [agentId, agentConfig] of Object.entries(config.agents)) {
      if (agentConfig.pool_size && agentConfig.pool_size > 1) {
        agentPoolSizes[agentId] = agentConfig.pool_size;
      }
    }

    this.agentProcessPool = new AgentProcessPool({
      defaultPoolSize: 1,
      agentPoolSizes,
      idleTimeoutMs: 300000, // 5 minutes
    });
  }

  /**
   * Update configuration (for hot reload)
   */
  updateConfig(config: MultiAgentConfig): void {
    this.config = config;
    // Clear persona cache to force reload
    this.personaCache.clear();

    // Rebuild AgentProcessPool with new pool sizes
    this.agentProcessPool.stopAll();
    const agentPoolSizes: Record<string, number> = {};
    for (const [agentId, agentConfig] of Object.entries(config.agents)) {
      if (agentConfig.pool_size && agentConfig.pool_size > 1) {
        agentPoolSizes[agentId] = agentConfig.pool_size;
      }
    }
    this.agentProcessPool = new AgentProcessPool({
      defaultPoolSize: 1,
      agentPoolSizes,
      idleTimeoutMs: 300000, // 5 minutes
    });
  }

  /**
   * Set the bot user ID map for mention-based delegation
   * Clears persona cache to regenerate system prompts with mention info
   */
  setBotUserIdMap(map: Map<string, string>): void {
    this.botUserIdMap = map;
    this.personaCache.clear();
  }

  /**
   * Enable or disable mention-based delegation
   * Clears persona cache to regenerate system prompts
   */
  setMentionDelegation(enabled: boolean): void {
    this.mentionDelegationEnabled = enabled;
    this.personaCache.clear();
  }

  /**
   * Build channel key for process pool
   * Format: {source}:{channelId}:{agentId}
   */
  buildChannelKey(source: string, channelId: string, agentId: string): string {
    return `${source}:${channelId}:${agentId}`;
  }

  /**
   * Parse channel key
   */
  parseChannelKey(channelKey: string): { source: string; channelId: string; agentId: string } {
    const parts = channelKey.split(':');
    if (parts.length < 3) {
      throw new Error(`Invalid channel key format: ${channelKey}`);
    }

    return {
      source: parts[0],
      channelId: parts[1],
      agentId: parts.slice(2).join(':'), // Handle agentId with colons
    };
  }

  /**
   * Get or create a process for an agent in a channel
   */
  async getProcess(
    source: string,
    channelId: string,
    agentId: string
  ): Promise<PersistentClaudeProcess> {
    const channelKey = this.buildChannelKey(source, channelId, agentId);
    const agentConfig = this.config.agents[agentId];
    const poolSize = agentConfig?.pool_size ?? 1;

    // Use AgentProcessPool for multi-process agents (pool_size > 1)
    if (poolSize > 1) {
      const systemPrompt = await this.loadPersona(agentId);
      const tier = agentConfig?.tier ?? 1;
      const options: Partial<PersistentProcessOptions> = {
        ...this.defaultOptions,
        systemPrompt,
        requestTimeout: 900000,
      };

      if (agentConfig?.model) {
        options.model = agentConfig.model;
      }

      if (tier >= 2) {
        options.env = { MAMA_DISABLE_HOOKS: 'true' };
      } else {
        // Tier 1: Enable keyword detection, AGENTS.md injection, and rules injection
        options.env = { MAMA_HOOK_FEATURES: 'rules,agents' };
      }

      // Structural tool enforcement via CLI flags
      const permissions = this.permissionManager.resolvePermissions({
        id: agentId,
        ...agentConfig,
      } as AgentPersonaConfig);
      if (!permissions.allowed.includes('*')) {
        options.allowedTools = permissions.allowed;
      }
      if (permissions.blocked.length > 0) {
        options.disallowedTools = permissions.blocked;
      }

      const { process, isNew } = await this.agentProcessPool.getAvailableProcess(
        agentId,
        channelKey,
        async () => {
          // Factory: create new PersistentClaudeProcess
          const mergedOptions: PersistentProcessOptions = {
            sessionId: randomUUID(),
            ...this.defaultOptions,
            ...options,
          } as PersistentProcessOptions;

          const newProcess = new PersistentClaudeProcess(mergedOptions);
          await newProcess.start();
          return newProcess;
        }
      );

      // Emit process-created event for new processes (F7: queue idle listener setup)
      if (isNew) {
        this.emit('process-created', { agentId, process });
      }

      return process;
    }

    // pool_size=1: use existing PersistentProcessPool (backward compatible)
    const systemPrompt = await this.loadPersona(agentId);
    const tier = agentConfig?.tier ?? 1;
    const options: Partial<PersistentProcessOptions> = {
      ...this.defaultOptions,
      systemPrompt,
      requestTimeout: 900000,
    };

    if (agentConfig?.model) {
      options.model = agentConfig.model;
    }

    if (tier >= 2) {
      options.env = { MAMA_DISABLE_HOOKS: 'true' };
    } else {
      options.env = { MAMA_HOOK_FEATURES: 'rules,agents' };
    }

    // Structural tool enforcement via CLI flags
    const permissions = this.permissionManager.resolvePermissions({
      id: agentId,
      ...agentConfig,
    } as AgentPersonaConfig);
    if (!permissions.allowed.includes('*')) {
      options.allowedTools = permissions.allowed;
    }
    if (permissions.blocked.length > 0) {
      options.disallowedTools = permissions.blocked;
    }

    const process = await this.processPool.getProcess(channelKey, options);

    // Emit process-created event if process was just created (F7)
    // Note: PersistentProcessPool doesn't expose isNew, so we check if process has no listeners yet
    if (process.listenerCount('idle') === 0) {
      this.emit('process-created', { agentId, process });
    }

    return process;
  }

  /**
   * Load persona system prompt for an agent
   */
  async loadPersona(agentId: string): Promise<string> {
    // Check cache first
    if (this.personaCache.has(agentId)) {
      return this.personaCache.get(agentId)!;
    }

    const agentConfig = this.config.agents[agentId];
    if (!agentConfig) {
      throw new Error(`Unknown agent: ${agentId}`);
    }

    const personaPath = resolvePath(agentConfig.persona_file);

    // Check if persona file exists
    if (!existsSync(personaPath)) {
      console.warn(`[AgentProcessManager] Persona file not found: ${personaPath}`);
      // Return default persona
      const defaultPersona = this.buildDefaultPersona(agentId, agentConfig);
      this.personaCache.set(agentId, defaultPersona);
      return defaultPersona;
    }

    try {
      const personaContent = await readFile(personaPath, 'utf-8');
      const systemPrompt = this.buildSystemPrompt(agentId, agentConfig, personaContent);
      this.personaCache.set(agentId, systemPrompt);
      return systemPrompt;
    } catch (error) {
      console.error(`[AgentProcessManager] Failed to load persona: ${personaPath}`, error);
      const defaultPersona = this.buildDefaultPersona(agentId, agentConfig);
      this.personaCache.set(agentId, defaultPersona);
      return defaultPersona;
    }
  }

  /**
   * Build system prompt with persona content
   */
  private buildSystemPrompt(
    agentId: string,
    agentConfig: Omit<AgentPersonaConfig, 'id'>,
    personaContent: string
  ): string {
    const agent: AgentPersonaConfig = { id: agentId, ...agentConfig };

    // Replace @mentions in persona with platform-specific <@userId>
    // Matches both @DisplayName (e.g. @📝 Reviewer) and @Name (e.g. @Reviewer)
    let resolvedPersona = personaContent;
    if (this.mentionDelegationEnabled && this.botUserIdMap.size > 0) {
      // Build all replacement patterns first for better performance
      const replacements: Array<[string, string]> = [];
      for (const [aid, cfg] of Object.entries(this.config.agents)) {
        const userId = this.botUserIdMap.get(aid);
        if (userId) {
          if (cfg.display_name) {
            replacements.push([`@${cfg.display_name}`, `<@${userId}>`]);
          }
          if (cfg.name && cfg.name !== cfg.display_name) {
            replacements.push([`@${cfg.name}`, `<@${userId}>`]);
          }
        }
      }

      // Apply all replacements
      for (const [pattern, replacement] of replacements) {
        resolvedPersona = resolvedPersona.replaceAll(pattern, replacement);
      }
    }

    // Build permission prompt
    const permissionPrompt = this.permissionManager.buildPermissionPrompt(agent);

    // Build delegation prompt for Tier 1 agents, or report-back prompt for Tier 2/3
    let delegationPrompt = '';
    let reportBackPrompt = '';
    const allAgents = Object.entries(this.config.agents)
      .filter(([, cfg]) => cfg.enabled !== false)
      .map(([id, cfg]) => ({ id, ...cfg }));

    if (this.permissionManager.canDelegate(agent)) {
      if (this.mentionDelegationEnabled && this.botUserIdMap.size > 0) {
        delegationPrompt = this.permissionManager.buildMentionDelegationPrompt(
          agent,
          allAgents,
          this.botUserIdMap
        );
      } else {
        delegationPrompt = this.permissionManager.buildDelegationPrompt(agent, allAgents);
      }
    } else if (this.mentionDelegationEnabled && this.botUserIdMap.size > 0) {
      // Tier 2/3 agents get report-back instructions
      reportBackPrompt = this.permissionManager.buildReportBackPrompt(
        agent,
        allAgents,
        this.botUserIdMap
      );
    }

    return `# Agent Identity

You are **${agentConfig.display_name}** (ID: ${agentId}).

## Response Format
- Always prefix your responses with: **${agentConfig.display_name}**:
- Example: "**${agentConfig.display_name}**: [your response]"
- Keep responses under 1800 characters for Discord compatibility

## Multi-Agent Context
- You are one of multiple AI agents in this channel
- Other agents may respond to messages too
- Be collaborative and build on others' contributions
- Avoid repeating what other agents have said
- If another agent has already addressed a topic well, acknowledge it briefly

## Persona
${resolvedPersona}

${permissionPrompt}${delegationPrompt ? delegationPrompt + '\n' : ''}${reportBackPrompt ? reportBackPrompt + '\n' : ''}## Guidelines
- Stay in character as ${agentConfig.name}
- Respond naturally to your trigger keywords: ${(agentConfig.auto_respond_keywords || []).join(', ')}
- Your trigger prefix is: ${agentConfig.trigger_prefix}
`;
  }

  /**
   * Build default persona when file is missing
   */
  private buildDefaultPersona(
    agentId: string,
    agentConfig: Omit<AgentPersonaConfig, 'id'>
  ): string {
    return `# Agent Identity

You are **${agentConfig.display_name}** (ID: ${agentId}).

## Response Format
- Always prefix your responses with: **${agentConfig.display_name}**:
- Example: "**${agentConfig.display_name}**: [your response]"
- Keep responses under 1800 characters for Discord compatibility

## Multi-Agent Context
- You are one of multiple AI agents in this channel
- Other agents may respond to messages too
- Be collaborative and build on others' contributions

## Role
You are a helpful AI assistant named ${agentConfig.name}.
Respond to messages in a helpful and professional manner.
`;
  }

  /**
   * Stop a specific agent's process in a channel
   */
  stopProcess(source: string, channelId: string, agentId: string): void {
    const channelKey = this.buildChannelKey(source, channelId, agentId);
    this.processPool.stopProcess(channelKey);
  }

  /**
   * Stop all processes for a channel (all agents)
   */
  stopChannelProcesses(source: string, channelId: string): void {
    const prefix = `${source}:${channelId}:`;
    const activeChannels = this.processPool.getActiveChannels();

    for (const channelKey of activeChannels) {
      if (channelKey.startsWith(prefix)) {
        this.processPool.stopProcess(channelKey);
      }
    }
  }

  /**
   * Stop all processes for an agent (all channels)
   */
  stopAgentProcesses(agentId: string): void {
    const suffix = `:${agentId}`;
    const activeChannels = this.processPool.getActiveChannels();

    for (const channelKey of activeChannels) {
      if (channelKey.endsWith(suffix)) {
        this.processPool.stopProcess(channelKey);
      }
    }
  }

  /**
   * Release a process back to the pool (for multi-process agents)
   */
  releaseProcess(agentId: string, process: PersistentClaudeProcess): void {
    const agentConfig = this.config.agents[agentId];
    const poolSize = agentConfig?.pool_size ?? 1;

    if (poolSize > 1) {
      this.agentProcessPool.releaseProcess(agentId, process);
    }
    // pool_size=1: PersistentProcessPool handles reuse automatically, no release needed
  }

  /**
   * Stop all processes
   */
  stopAll(): void {
    this.processPool.stopAll();
    this.agentProcessPool.stopAll();
    this.personaCache.clear();
  }

  /**
   * Get AgentProcessPool instance (for testing/advanced usage)
   */
  getAgentProcessPool(): AgentProcessPool {
    return this.agentProcessPool;
  }

  /**
   * Get number of active processes
   */
  getActiveCount(): number {
    return this.processPool.getActiveCount();
  }

  /**
   * Get all active channel keys
   */
  getActiveChannels(): string[] {
    return this.processPool.getActiveChannels();
  }

  /**
   * Get states of all agent processes, aggregated by agentId.
   * Returns the "most active" state per agent (busy > starting > idle > dead).
   */
  getAgentStates(): Map<string, string> {
    const states = new Map<string, string>();
    const processStates = this.processPool.getProcessStates();

    // Priority: busy > starting > idle > dead
    const priority: Record<string, number> = { busy: 3, starting: 2, idle: 1, dead: 0 };

    for (const [channelKey, state] of processStates) {
      try {
        const { agentId } = this.parseChannelKey(channelKey);
        const existing = states.get(agentId);
        if (!existing || (priority[state] ?? 0) > (priority[existing] ?? 0)) {
          states.set(agentId, state);
        }
      } catch {
        // Skip malformed keys
      }
    }

    return states;
  }

  /**
   * Reload persona for an agent (clears cache)
   */
  reloadPersona(agentId: string): void {
    this.personaCache.delete(agentId);
    // Stop all processes for this agent to force reload
    this.stopAgentProcesses(agentId);
  }

  /**
   * Reload all personas
   */
  reloadAllPersonas(): void {
    this.personaCache.clear();
    this.processPool.stopAll();
  }

  /**
   * Get process pool (for advanced usage)
   */
  getProcessPool(): PersistentProcessPool {
    return this.processPool;
  }

  /**
   * Check if an agent has an active process in a channel
   */
  hasActiveProcess(source: string, channelId: string, agentId: string): boolean {
    const channelKey = this.buildChannelKey(source, channelId, agentId);
    return this.processPool.getActiveChannels().includes(channelKey);
  }
}
