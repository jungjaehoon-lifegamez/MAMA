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
import {
  PersistentProcessPool,
  PersistentClaudeProcess,
  type PersistentProcessOptions,
} from '../agent/persistent-cli-process.js';
import type { AgentPersonaConfig, MultiAgentConfig } from './types.js';

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
 */
export class AgentProcessManager {
  private config: MultiAgentConfig;
  private processPool: PersistentProcessPool;

  /** Cached persona content: Map<agentId, systemPrompt> */
  private personaCache: Map<string, string> = new Map();

  /** Default options for all processes */
  private defaultOptions: Partial<PersistentProcessOptions>;

  constructor(config: MultiAgentConfig, defaultOptions: Partial<PersistentProcessOptions> = {}) {
    this.config = config;
    this.defaultOptions = defaultOptions;
    this.processPool = new PersistentProcessPool(defaultOptions);
  }

  /**
   * Update configuration (for hot reload)
   */
  updateConfig(config: MultiAgentConfig): void {
    this.config = config;
    // Clear persona cache to force reload
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

    // Load persona system prompt
    const systemPrompt = await this.loadPersona(agentId);

    // Get agent-specific options
    const agentConfig = this.config.agents[agentId];
    const options: Partial<PersistentProcessOptions> = {
      ...this.defaultOptions,
      systemPrompt,
    };

    // Override model if agent-specific
    if (agentConfig?.model) {
      options.model = agentConfig.model;
    }

    return this.processPool.getProcess(channelKey, options);
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
${personaContent}

## Guidelines
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
   * Stop all processes
   */
  stopAll(): void {
    this.processPool.stopAll();
    this.personaCache.clear();
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
