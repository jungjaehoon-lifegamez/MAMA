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
import { loadInstalledSkills } from '../agent/agent-loop.js';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import {
  PersistentProcessPool,
  type PersistentProcessOptions,
} from '../agent/persistent-cli-process.js';
import type { AgentPersonaConfig, MultiAgentConfig, MultiAgentRuntimeOptions } from './types.js';
import { ToolPermissionManager } from './tool-permission-manager.js';
import { AgentProcessPool } from './agent-process-pool.js';
import { CodexRuntimeProcess, type AgentRuntimeProcess } from './runtime-process.js';
import type { EphemeralAgentDef } from './workflow-types.js';
import { buildBmadPromptBlock } from './bmad-templates.js';

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
 * Convert model ID to human-readable display name
 */
function getModelDisplayName(modelId: string): string {
  const modelMap: Record<string, string> = {
    // Claude 4.6
    'claude-opus-4-6': 'Claude Opus 4.6',
    'claude-opus-4-6-20260210': 'Claude Opus 4.6',
    'claude-sonnet-4-6': 'Claude Sonnet 4.6',
    'claude-sonnet-4-6-20260217': 'Claude Sonnet 4.6',
    // Claude 4.5
    'claude-opus-4-5-20251101': 'Claude Opus 4.5',
    'claude-sonnet-4-5-20250929': 'Claude Sonnet 4.5',
    'claude-haiku-4-5-20251001': 'Claude Haiku 4.5',
    // Claude 4.0
    'claude-sonnet-4-20250514': 'Claude 4 Sonnet',
    'claude-opus-4-20250514': 'Claude 4 Opus',
    // Aliases
    'claude-opus-4-latest': 'Claude Opus 4 (latest)',
    'claude-sonnet-4-latest': 'Claude Sonnet 4 (latest)',
    // OpenAI / Codex
    'gpt-5.3-codex': 'GPT-5.3 Codex',
    'gpt-5-codex': 'GPT-5 Codex',
    'gpt-4.1': 'GPT-4.1',
    'gpt-4.1-mini': 'GPT-4.1 Mini',
    'gpt-4.1-nano': 'GPT-4.1 Nano',
    o3: 'OpenAI o3',
    'o4-mini': 'OpenAI o4-mini',
    // Google
    'gemini-2.5-pro': 'Gemini 2.5 Pro',
    'gemini-2.5-flash': 'Gemini 2.5 Flash',
  };
  return modelMap[modelId] || modelId;
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
 * - 'process-created': { agentId: string, process: AgentRuntimeProcess }
 */
export class AgentProcessManager extends EventEmitter {
  private config: MultiAgentConfig;
  private processPool: PersistentProcessPool;
  private agentProcessPool: AgentProcessPool;
  private codexProcessPool: Map<string, AgentRuntimeProcess> = new Map();
  private permissionManager: ToolPermissionManager;
  private runtimeOptions: MultiAgentRuntimeOptions;

  /** Cached persona content: Map<agentId, systemPrompt> */
  private personaCache: Map<string, string> = new Map();

  /** Bot user ID map for mention-based delegation: agentId → Discord userId */
  private botUserIdMap: Map<string, string> = new Map();

  /** Whether mention-based delegation is enabled */
  private mentionDelegationEnabled = false;

  /** Default options for all processes */
  private defaultOptions: Partial<PersistentProcessOptions>;

  constructor(
    config: MultiAgentConfig,
    defaultOptions: Partial<PersistentProcessOptions> = {},
    runtimeOptions: MultiAgentRuntimeOptions = {}
  ) {
    super(); // EventEmitter
    this.config = config;
    this.defaultOptions = defaultOptions;
    this.runtimeOptions = runtimeOptions;
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
    // Clear persona cache to force reload, but keep inline ephemeral prompts
    this.clearPersonaCache(true);
    this.config = config;

    // Stop and clear ALL process pools so new processes pick up new model/config
    // 1. Claude PersistentProcessPool
    void this.processPool.stopAll();

    // 2. Codex processes
    for (const [key, proc] of this.codexProcessPool.entries()) {
      try {
        proc.stop();
      } catch {
        // Ignore errors during cleanup
      }
      this.codexProcessPool.delete(key);
    }

    // 3. Rebuild AgentProcessPool with new pool sizes
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

  private getAgentBackend(
    agentConfig: Omit<AgentPersonaConfig, 'id'>
  ): 'claude' | 'codex-mcp' | 'gemini' {
    return agentConfig.backend ?? this.runtimeOptions.backend ?? 'claude';
  }

  /**
   * Set the bot user ID map for mention-based delegation
   * Clears persona cache to regenerate system prompts with mention info
   */
  setBotUserIdMap(map: Map<string, string>): void {
    this.botUserIdMap = map;
    this.clearPersonaCache(true);
  }

  /**
   * Enable or disable mention-based delegation
   * Clears persona cache to regenerate system prompts
   */
  setMentionDelegation(enabled: boolean): void {
    this.mentionDelegationEnabled = enabled;
    this.clearPersonaCache(true);
  }

  private isEphemeralAgent(agentId: string): boolean {
    return this.config.agents[agentId]?.persona_file === '';
  }

  private clearPersonaCache(preserveEphemeral = false): void {
    if (!preserveEphemeral) {
      this.personaCache.clear();
      return;
    }

    for (const agentId of this.personaCache.keys()) {
      if (!this.isEphemeralAgent(agentId)) {
        this.personaCache.delete(agentId);
      }
    }
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
  ): Promise<AgentRuntimeProcess> {
    const channelKey = this.buildChannelKey(source, channelId, agentId);
    const agentConfig = this.config.agents[agentId];
    const poolSize = agentConfig?.pool_size ?? 1;
    const agentBackend = this.getAgentBackend(agentConfig);
    const systemPrompt = await this.loadPersona(agentId);
    const tier = agentConfig?.tier ?? 1;
    const options: Partial<PersistentProcessOptions> = {
      ...this.defaultOptions,
      systemPrompt,
      requestTimeout:
        this.defaultOptions.requestTimeout ?? this.runtimeOptions.requestTimeout ?? 900000,
    };

    if (agentConfig?.model) {
      options.model = agentConfig.model;
    }
    const effort = agentConfig?.effort || this.runtimeOptions.effort;
    if (effort) {
      options.effort = effort;
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

    if (agentBackend === 'codex-mcp') {
      // Use AgentProcessPool for multi-process agents (pool_size > 1)
      if (poolSize > 1) {
        const { process, isNew } = await this.agentProcessPool.getAvailableProcess(
          agentId,
          channelKey,
          async () => this.createCodexProcess(options)
        );
        if (isNew) {
          this.emit('process-created', { agentId, process });
        }
        return process;
      }

      const existing = this.codexProcessPool.get(channelKey);
      if (existing) {
        return existing;
      }

      const process = await this.createCodexProcess(options);
      this.codexProcessPool.set(channelKey, process);
      this.emit('process-created', { agentId, process });
      return process;
    }

    // Claude backend
    if (poolSize > 1) {
      const { process, isNew } = await this.agentProcessPool.getAvailableProcess(
        agentId,
        channelKey,
        async () => {
          const mergedOptions: PersistentProcessOptions = {
            sessionId: randomUUID(),
            ...this.defaultOptions,
            ...options,
          } as PersistentProcessOptions;

          const { PersistentClaudeProcess } = await import('../agent/persistent-cli-process.js');
          const newProcess = new PersistentClaudeProcess(mergedOptions);
          await newProcess.start();
          return newProcess;
        }
      );

      if (isNew) {
        this.emit('process-created', { agentId, process });
      }

      return process;
    }

    const process = await this.processPool.getProcess(channelKey, options);
    if (process.listenerCount('idle') === 0) {
      this.emit('process-created', { agentId, process });
    }
    return process;
  }

  private async createCodexProcess(
    options: Partial<PersistentProcessOptions>
  ): Promise<AgentRuntimeProcess> {
    const process = new CodexRuntimeProcess({
      model: options.model || this.runtimeOptions.model,
      systemPrompt: options.systemPrompt,
      cwd: this.runtimeOptions.codexCwd,
      sandbox: this.runtimeOptions.codexSandbox,
      requestTimeout: options.requestTimeout,
    });
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
      const systemPrompt = await this.buildSystemPrompt(agentId, agentConfig, personaContent);
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
  private async buildSystemPrompt(
    agentId: string,
    agentConfig: Omit<AgentPersonaConfig, 'id'>,
    personaContent: string
  ): Promise<string> {
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

    // Replace model placeholder with actual config value
    // Supports both {{model}} placeholder and hardcoded model names
    const actualModel = agentConfig.model || this.runtimeOptions.model || 'unknown';
    const modelDisplayName = getModelDisplayName(actualModel);
    resolvedPersona = resolvedPersona.replace(/\{\{model\}\}/gi, modelDisplayName);
    // Also replace common hardcoded model patterns with actual model
    resolvedPersona = resolvedPersona.replace(
      /powered by \*\*[^*]+\*\* \([^)]+\)/gi,
      `powered by **${modelDisplayName}** (${actualModel})`
    );

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

    const includeBmadBlock = this.shouldInjectBmadBlock(agentId, agentConfig);
    const bmadBlock = includeBmadBlock ? await this.buildBmadBlock() : '';

    return `# Agent Identity

You are **${agentConfig.display_name}** (ID: ${agentId}).

## Response Format
- Prefix: **${agentConfig.display_name}**:
- Do the work thoroughly, then report the result
- **ALWAYS respond with text** — never reply with only emoji/reactions
- Multiple AI agents in this channel — be aware of what others have said

## Persona
${resolvedPersona}

${bmadBlock}${permissionPrompt}${delegationPrompt ? delegationPrompt + '\n' : ''}${reportBackPrompt ? reportBackPrompt + '\n' : ''}## Gateway Tools

To use gateway tools, output a JSON block in your response:

\`\`\`tool_call
{"name": "tool_name", "input": {"param1": "value1"}}
\`\`\`

Available tools:
- **discord_send**(channel_id, message?, file_path?) — Send message or file to a Discord channel
- **slack_send**(channel_id, message?, file_path?) — Send message or file to a Slack channel
- **mama_search**(query?, type?, limit?) — Search decisions in MAMA memory
- **mama_save**(type, topic?, decision?, reasoning?, summary?, next_steps?) — Save decision or checkpoint
- **pr_review_threads**(pr_url) — Fetch unresolved PR review threads (grouped by file, with line/body/author). Use this to autonomously analyze PR feedback.

The channel_id for the current conversation is provided in the message context.
Tool calls are executed automatically. You do NOT need curl or Bash for these.

${this.buildSkillsPrompt()}
## Guidelines
- Stay in character as ${agentConfig.name}
- Respond naturally to your trigger keywords: ${(agentConfig.auto_respond_keywords || []).join(', ')}
- Your trigger prefix is: ${agentConfig.trigger_prefix}
`;
  }

  private shouldInjectBmadBlock(
    agentId: string,
    agentConfig: Omit<AgentPersonaConfig, 'id'>
  ): boolean {
    const hasPlanningFlag =
      typeof agentConfig.is_planning_agent === 'boolean' ||
      typeof agentConfig.isPlanningAgent === 'boolean';
    if (agentConfig.is_planning_agent === true || agentConfig.isPlanningAgent === true) {
      return true;
    }

    const hasTierSignal = typeof agentConfig.tier === 'number';
    if (agentConfig.tier === 1 && agentConfig.can_delegate === true) {
      return true;
    }

    // Backward compatibility: older configs may only identify Conductor by agent ID.
    if (!hasPlanningFlag && !hasTierSignal) {
      return agentId.toLowerCase() === 'conductor';
    }

    return false;
  }

  /**
   * Build installed skills prompt section
   */
  private buildSkillsPrompt(): string {
    const skillBlocks = loadInstalledSkills();
    if (skillBlocks.length === 0) return '';

    return `## Installed Skills (PRIORITY)

**IMPORTANT:** The following skills/plugins are installed by the user.
When a user message contains [INSTALLED PLUGIN COMMAND] you MUST:
1. Find the matching "commands/{name}.md" section below
2. Follow its instructions EXACTLY as written
3. DO NOT use the Skill tool — these are NOT system skills
4. DO NOT match to bmad, oh-my-claudecode, or any built-in skill

${skillBlocks.join('\n\n---\n\n')}
`;
  }

  /**
   * Build BMAD planning context block for Conductor's system prompt.
   * Returns empty string if BMAD is not relevant.
   */
  private async buildBmadBlock(): Promise<string> {
    try {
      return await buildBmadPromptBlock(process.cwd());
    } catch {
      return '';
    }
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
    const codexProcess = this.codexProcessPool.get(channelKey);
    if (codexProcess) {
      codexProcess.stop();
      this.codexProcessPool.delete(channelKey);
    }
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
    for (const channelKey of this.codexProcessPool.keys()) {
      if (channelKey.startsWith(prefix)) {
        const process = this.codexProcessPool.get(channelKey);
        process?.stop();
        this.codexProcessPool.delete(channelKey);
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
    for (const channelKey of this.codexProcessPool.keys()) {
      if (channelKey.endsWith(suffix)) {
        const process = this.codexProcessPool.get(channelKey);
        process?.stop();
        this.codexProcessPool.delete(channelKey);
      }
    }
  }

  /**
   * Release a process back to the pool (for multi-process agents)
   */
  releaseProcess(agentId: string, process: AgentRuntimeProcess): void {
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
    for (const process of this.codexProcessPool.values()) {
      process.stop();
    }
    this.codexProcessPool.clear();
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
    return this.processPool.getActiveCount() + this.codexProcessPool.size;
  }

  /**
   * Get all active channel keys
   */
  getActiveChannels(): string[] {
    return [...this.processPool.getActiveChannels(), ...this.codexProcessPool.keys()];
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

    for (const channelKey of this.codexProcessPool.keys()) {
      try {
        const { agentId } = this.parseChannelKey(channelKey);
        const existing = states.get(agentId);
        if (!existing || (priority.idle ?? 0) > (priority[existing] ?? 0)) {
          states.set(agentId, 'idle');
        }
      } catch {
        // Skip malformed keys
      }
    }

    return states;
  }

  /**
   * Register an ephemeral agent definition (for workflow orchestration).
   * The agent is added to config.agents so getProcess() can find it.
   */
  registerEphemeralAgent(agentDef: EphemeralAgentDef): void {
    this.config.agents[agentDef.id] = {
      name: agentDef.display_name,
      display_name: agentDef.display_name,
      trigger_prefix: '', // ephemeral agents have no trigger
      persona_file: '', // inline system prompt, no file
      backend: agentDef.backend as 'claude' | 'codex-mcp' | 'gemini',
      model: agentDef.model,
      tier: agentDef.tier ?? 1,
      tool_permissions: agentDef.tool_permissions,
      enabled: true,
    };
    // Cache the inline system prompt directly
    this.personaCache.set(agentDef.id, agentDef.system_prompt);
  }

  /**
   * Unregister ephemeral agents and clean up their processes.
   */
  unregisterEphemeralAgents(agentDefs: EphemeralAgentDef[]): void {
    for (const { id: agentId } of agentDefs) {
      this.stopAgentProcesses(agentId);
      this.personaCache.delete(agentId);
      delete this.config.agents[agentId];
    }
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
    this.clearPersonaCache(true);
    this.processPool.stopAll();
    for (const process of this.codexProcessPool.values()) {
      process.stop();
    }
    this.codexProcessPool.clear();
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
    return (
      this.processPool.getActiveChannels().includes(channelKey) ||
      this.codexProcessPool.has(channelKey)
    );
  }

  /**
   * Get agent IDs with active processes in a given channel
   */
  getActiveAgentsInChannel(source: string, channelId: string): string[] {
    const prefix = `${source}:${channelId}:`;
    const agentIdSet = new Set<string>();

    // 1. Check processPool (pool_size=1 agents)
    for (const channelKey of this.processPool.getActiveChannels()) {
      if (channelKey.startsWith(prefix)) {
        try {
          const { agentId } = this.parseChannelKey(channelKey);
          agentIdSet.add(agentId);
        } catch {
          // Skip malformed keys
        }
      }
    }

    // 2. Check agentProcessPool (pool_size>1 agents) — only include agents serving this channel
    for (const channelKey of this.codexProcessPool.keys()) {
      if (channelKey.startsWith(prefix)) {
        try {
          const { agentId } = this.parseChannelKey(channelKey);
          agentIdSet.add(agentId);
        } catch {
          // Skip malformed keys
        }
      }
    }

    // 3. Check agentProcessPool (pool_size>1 agents) — only include agents serving this channel
    for (const [agentId] of this.agentProcessPool.getAllPoolStatuses()) {
      if (this.agentProcessPool.hasBusyProcessForChannel(agentId, prefix)) {
        agentIdSet.add(agentId);
      }
    }

    return Array.from(agentIdSet);
  }
}
