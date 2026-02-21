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
import { EventEmitter } from 'events';
import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';
import {
  PersistentProcessPool,
  type PersistentProcessOptions,
} from '../agent/persistent-cli-process.js';
import type { AgentPersonaConfig, MultiAgentConfig, MultiAgentRuntimeOptions } from './types.js';
import { ToolPermissionManager } from './tool-permission-manager.js';
import { CodexRuntimeProcess, type AgentRuntimeProcess } from './runtime-process.js';
import type { EphemeralAgentDef } from './workflow-types.js';
import { buildBmadPromptBlock } from './bmad-templates.js';
import { TypeDefinitionGenerator, CODE_ACT_INSTRUCTIONS } from '../agent/code-act/index.js';

const { DebugLogger } = debugLogger as {
  DebugLogger: new (context?: string) => {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
};
const processManagerLogger = new DebugLogger('AgentProcessManager');

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
  private codexProcessPool: Map<string, AgentRuntimeProcess> = new Map();
  private permissionManager: ToolPermissionManager;
  private runtimeOptions: MultiAgentRuntimeOptions;
  private readonly tracePromptMs = globalThis.process.env.MAMA_CONDUCTOR_PROMPT_MS === '1';
  private readonly dumpConductorPrompt = globalThis.process.env.MAMA_DUMP_CONDUCTOR_PROMPT === '1';

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
  }

  private getAgentBackend(
    agentConfig: Omit<AgentPersonaConfig, 'id'>,
    agentId?: string
  ): 'claude' | 'codex-mcp' | 'gemini' {
    const backend = agentConfig.backend ?? this.runtimeOptions.backend;
    if (!backend) {
      throw new Error(
        `No backend configured for agent${agentId ? ` '${agentId}'` : ''}. ` +
          `Set 'backend' in agent config or global agent.backend. Valid: 'claude' | 'codex-mcp'`
      );
    }
    return backend;
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
    const processStart = Date.now();
    const channelKey = this.buildChannelKey(source, channelId, agentId);
    const agentConfig = this.config.agents[agentId];
    const agentBackend = this.getAgentBackend(agentConfig, agentId);
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

    // Code-Act: available as optional tool alongside direct tools (no forced disallowedTools)

    if (agentBackend === 'codex-mcp') {
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
    const process = await this.processPool.getProcess(channelKey, options);
    if (process.listenerCount('idle') === 0) {
      this.emit('process-created', { agentId, process });
    }
    if (agentId.toLowerCase() === 'conductor' && this.tracePromptMs) {
      processManagerLogger.debug(
        `[Conductor][timing] total getProcess latency ${Date.now() - processStart}ms`
      );
    }
    return process;
  }

  private async createCodexProcess(
    options: Partial<PersistentProcessOptions>
  ): Promise<AgentRuntimeProcess> {
    const process = new CodexRuntimeProcess({
      model: options.model || this.runtimeOptions.model,
      systemPrompt: options.systemPrompt,
      cwd: this.runtimeOptions.codexCwd ? resolvePath(this.runtimeOptions.codexCwd) : undefined,
      sandbox: this.runtimeOptions.codexSandbox,
      command: this.runtimeOptions.codexCommand,
      requestTimeout: options.requestTimeout,
    });
    return process;
  }

  /**
   * Load persona system prompt for an agent
   */
  async loadPersona(agentId: string): Promise<string> {
    const shouldTrace = this.shouldTracePrompt(agentId);
    const traceCacheKey = agentId.toLowerCase() === 'conductor' ? 'conductor' : agentId;

    // Check cache first
    if (this.personaCache.has(agentId)) {
      const cachedPrompt = this.personaCache.get(agentId)!;
      if (shouldTrace) {
        processManagerLogger.debug(
          `[Conductor] system prompt cache HIT | key=${traceCacheKey} len=${cachedPrompt.length}`
        );
      }
      return cachedPrompt;
    }

    const agentConfig = this.config.agents[agentId];
    if (!agentConfig) {
      throw new Error(`Unknown agent: ${agentId}`);
    }

    const personaPath = resolvePath(agentConfig.persona_file);
    const loadStart = Date.now();

    // Check if persona file exists
    if (!existsSync(personaPath)) {
      console.warn(`[AgentProcessManager] Persona file not found: ${personaPath}`);
      // Return default persona
      const defaultPersona = this.buildDefaultPersona(agentId, agentConfig);
      this.personaCache.set(agentId, defaultPersona);
      if (shouldTrace) {
        processManagerLogger.warn(
          `[Conductor] persona file missing (${traceCacheKey}), using default in ${Date.now() - loadStart}ms`
        );
      }
      return defaultPersona;
    }

    try {
      const readStart = Date.now();
      const personaContent = await readFile(personaPath, 'utf-8');
      const readDuration = Date.now() - readStart;
      if (shouldTrace) {
        processManagerLogger.debug(
          `[Conductor] persona read complete key=${traceCacheKey} path=${personaPath} read_ms=${readDuration} bytes=${personaContent.length}`
        );
      }
      const buildStart = Date.now();
      const systemPrompt = await this.buildSystemPrompt(agentId, agentConfig, personaContent);
      if (shouldTrace) {
        processManagerLogger.debug(
          `[Conductor] system prompt built key=${traceCacheKey} build_ms=${Date.now() - buildStart} total_ms=${
            Date.now() - loadStart
          } len=${systemPrompt.length}`
        );
      }
      this.personaCache.set(agentId, systemPrompt);
      if (shouldTrace && this.dumpConductorPrompt) {
        processManagerLogger.debug(`[Conductor] system prompt content:\n${systemPrompt}`);
      }
      return systemPrompt;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to load persona for '${agentId}': ${personaPath}. ` +
          `Error: ${message}. Fix: check file permissions or run 'mama init'`
      );
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

    const buildStart = Date.now();
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

    // Replace model placeholders with actual config values
    const actualModel = agentConfig.model || this.runtimeOptions.model;
    if (!actualModel) {
      throw new Error(
        `No model configured for agent '${agentId}'. ` +
          `Set 'model' in agent config or global agent.model`
      );
    }
    const modelDisplayName = getModelDisplayName(actualModel);
    resolvedPersona = resolvedPersona.replace(/\{\{model\}\}/gi, modelDisplayName);
    resolvedPersona = resolvedPersona.replace(/\{\{model_id\}\}/gi, actualModel);

    // Resolve backend-specific model IDs for workflow plan templates
    const claudeModelId = this.resolveModelForBackend('claude');
    const codexModelId = this.resolveModelForBackend('codex-mcp');
    resolvedPersona = resolvedPersona.replace(/\{\{claude_model_id\}\}/gi, claudeModelId);
    resolvedPersona = resolvedPersona.replace(/\{\{codex_model_id\}\}/gi, codexModelId);

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
      .filter(([id, cfg]) => cfg.enabled !== false && id !== agentId) // Exclude self
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
    const bmadStart = Date.now();
    const bmadBlock = includeBmadBlock ? await this.buildBmadBlock() : '';
    const bmadMs = includeBmadBlock ? Date.now() - bmadStart : 0;

    const skillsPrompt = this.buildSkillsPrompt();
    const systemPrompt = `# Agent Identity

You are **${agentConfig.display_name}** (ID: ${agentId}).

## Response Format
- Prefix: **${agentConfig.display_name}**:
- Do the work thoroughly, then report the result
- **ALWAYS respond with text** — never reply with only emoji/reactions
- Multiple AI agents in this channel — be aware of what others have said

## Persona
${resolvedPersona}

${bmadBlock}${permissionPrompt}${delegationPrompt ? delegationPrompt + '\n' : ''}${reportBackPrompt ? reportBackPrompt + '\n' : ''}${this.buildToolsSection(agentConfig)}

${skillsPrompt}## Guidelines
- Stay in character as ${agentConfig.name}
- Respond naturally to your trigger keywords: ${(agentConfig.auto_respond_keywords || []).join(', ')}
- Your trigger prefix is: ${agentConfig.trigger_prefix}
`;

    if (this.shouldTracePrompt(agentId)) {
      processManagerLogger.debug(
        `[Conductor] buildSystemPrompt done key=${agentId.toLowerCase()} build_ms=${Date.now() - buildStart} bmad_ms=${bmadMs} skills_len=${skillsPrompt.length} total_len=${systemPrompt.length}`
      );
    }

    return systemPrompt;
  }

  private buildToolsSection(agentConfig: Omit<AgentPersonaConfig, 'id'>): string {
    const tier = agentConfig.tier ?? 1;
    // Code-Act mode: replace tool_call instructions with Code-Act JS execution
    if (agentConfig.useCodeAct && tier !== 3) {
      const typeDefs = TypeDefinitionGenerator.generate(tier as 1 | 2 | 3);
      return CODE_ACT_INSTRUCTIONS + '\n```typescript\n' + typeDefs + '\n```\n';
    }

    // Default: tool_call JSON block instructions
    return `## Gateway Tools

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
`;
  }

  private shouldTracePrompt(agentId: string): boolean {
    return (
      this.tracePromptMs &&
      (agentId.toLowerCase() === 'conductor' ||
        globalThis.process.env.MAMA_AGENT_PROMPT_TRACE === '1')
    );
  }

  private shouldInjectBmadBlock(
    agentId: string,
    agentConfig: Omit<AgentPersonaConfig, 'id'>
  ): boolean {
    // Explicit opt-out always wins.
    if (agentConfig.is_planning_agent === false || agentConfig.isPlanningAgent === false) {
      return false;
    }

    const hasPlanningFlag =
      typeof agentConfig.is_planning_agent === 'boolean' ||
      typeof agentConfig.isPlanningAgent === 'boolean';
    if (agentConfig.is_planning_agent === true || agentConfig.isPlanningAgent === true) {
      return true;
    }

    const hasTierSignal = typeof agentConfig.tier === 'number';
    if (
      agentConfig.tier === 1 &&
      agentConfig.can_delegate === true &&
      agentConfig.is_planning_agent !== false &&
      agentConfig.isPlanningAgent !== false
    ) {
      return true;
    }

    // Backward compatibility: older configs may only identify Conductor by agent ID.
    if (!hasPlanningFlag && !hasTierSignal) {
      return agentId.toLowerCase() === 'conductor';
    }

    return false;
  }

  /**
   * Resolve the preferred model ID for a given backend from config.
   * Scans registered agents to find the first model matching the backend.
   * Falls back to runtimeOptions.model for claude, 'unknown' otherwise.
   */
  private resolveModelForBackend(backend: string): string {
    for (const [, cfg] of Object.entries(this.config.agents)) {
      const agentBackend = this.getAgentBackend(cfg);
      if (agentBackend === backend && cfg.model) {
        return cfg.model;
      }
    }
    if (backend === 'claude') {
      if (!this.runtimeOptions.model) {
        throw new Error(`No model configured for claude backend. Set agent.model in config.yaml`);
      }
      return this.runtimeOptions.model;
    }
    return 'unknown';
  }

  /**
   * Build installed skills prompt section
   */
  private buildSkillsPrompt(): string {
    const skillCatalog = loadInstalledSkills();
    if (skillCatalog.length === 0) return '';

    return `## Installed Skills

To invoke a skill, include its keywords in your message.
The full skill instructions will be provided automatically when matched.

${skillCatalog.join('\n')}
`;
  }

  /**
   * Build BMAD planning context block for Conductor's system prompt.
   * Returns an explicit marker on failure for easier diagnosis.
   */
  private async buildBmadBlock(): Promise<string> {
    try {
      return await buildBmadPromptBlock(process.cwd());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        '[AgentProcessManager] BMAD prompt block generation failed, using fallback:',
        message
      );
      console.error('[AgentProcessManager] BMAD prompt block generation failed:', message);
      return `[BMAD_LOAD_ERROR: ${message}]`;
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
   * Stop all processes
   */
  stopAll(): void {
    this.processPool.stopAll();
    for (const process of this.codexProcessPool.values()) {
      process.stop();
    }
    this.codexProcessPool.clear();
    this.personaCache.clear();
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

    // 2. Check codex processes
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

    return Array.from(agentIdSet);
  }
}
