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
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { AgentLoop, loadBackendAgentsMd } from '../agent/agent-loop.js';
import { ClineCLIAdapter } from '../agent/cline-cli-adapter.js';
import { projectClineNativeTools } from '../agent/cline-native-tool-policy.js';
import {
  defaultModelForBackend,
  effortSupportedByBackend,
  resolveBackendScopedModel,
} from '../agent/backend-model-policy.js';
export { projectClineNativeTools } from '../agent/cline-native-tool-policy.js';
import { buildGatewayToolCatalog } from '../agent/gateway-tool-catalog.js';
import { filterSkillCatalogForContext, loadInstalledSkills } from '../agent/skill-loader.js';
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
import {
  CODE_ACT_MARKER,
  TypeDefinitionGenerator,
  getCodeActInstructions,
  projectCodeActToolPolicy,
} from '../agent/code-act/index.js';
import { HostBridge } from '../agent/code-act/host-bridge.js';
import type { GatewayToolExecutor } from '../agent/gateway-tool-executor.js';
import type { AgentContext, AgentPlatform } from '../agent/types.js';
import {
  resolvePrivateConnectorPolicy,
  type PrivateConnectorPolicy,
} from '../connectors/private-connector-policy.js';

const DEFAULT_PRIVATE_CONNECTOR_POLICY = resolvePrivateConnectorPolicy({
  ok: true,
  config: {},
  enabledNames: [],
});

type PrivateAwareMultiAgentRuntimeOptions = MultiAgentRuntimeOptions & {
  privateConnectorPolicy?: PrivateConnectorPolicy;
};

const { DebugLogger } = debugLogger as {
  DebugLogger: new (context?: string) => {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
};
const processManagerLogger = new DebugLogger('AgentProcessManager');

class ManagedCodeActProcess extends EventEmitter implements AgentRuntimeProcess {
  private stopped = false;
  private activeRequests = 0;

  constructor(
    private readonly loop: AgentLoop,
    private readonly sessionKey: string,
    private readonly source: string,
    private readonly channelId: string,
    private readonly agentContext: AgentContext,
    private readonly model?: string
  ) {
    super();
  }

  async sendMessage(
    content: string,
    callbacks?: import('../agent/persistent-cli-process.js').PromptCallbacks
  ): Promise<import('../agent/persistent-cli-process.js').PromptResult> {
    if (this.stopped) {
      const error = new Error('Process is dead');
      callbacks?.onError?.(error);
      throw error;
    }

    this.activeRequests += 1;
    try {
      const result = await this.loop.run(content, {
        source: this.source,
        channelId: this.channelId,
        sessionKey: this.sessionKey,
        agentContext: this.agentContext,
        model: this.model,
        streamCallbacks: callbacks,
      });
      return {
        response: result.response,
        usage: result.totalUsage,
        session_id: this.sessionKey,
        toolUseBlocks: [],
        hasToolUse: false,
      };
    } finally {
      this.activeRequests -= 1;
      if (!this.stopped && this.activeRequests === 0) {
        this.emit('idle');
      }
    }
  }

  isReady(): boolean {
    return !this.stopped;
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    await this.loop.stop();
    this.emit('close', 0);
  }

  getSessionId(): string {
    return this.sessionKey;
  }
}

/**
 * Resolve path with ~ expansion
 */
function resolvePath(path: string): string {
  if (path.startsWith('~')) {
    return resolve(homedir(), path.slice(2));
  }
  return resolve(path);
}

function safeConfigId(agentId: string): string {
  return agentId.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function codeActBlockedTools(agentConfig: Omit<AgentPersonaConfig, 'id'>): string[] | undefined {
  return agentConfig.gateway_tool_permissions?.blocked ?? agentConfig.tool_permissions?.blocked;
}

function withCodeActPolicyEnv(
  entry: unknown,
  agentId: string,
  allowedTools: string[] | undefined,
  blockedTools: string[] | undefined
): unknown {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return entry;
  }
  const current = entry as Record<string, unknown>;
  const currentEnv =
    current.env && typeof current.env === 'object' && !Array.isArray(current.env)
      ? (current.env as Record<string, unknown>)
      : {};
  return {
    ...current,
    env: {
      ...currentEnv,
      MAMA_CODE_ACT_AGENT_ID: agentId,
      ...(allowedTools !== undefined
        ? { MAMA_CODE_ACT_ALLOWED_TOOLS: JSON.stringify(allowedTools) }
        : {}),
      ...(blockedTools !== undefined
        ? { MAMA_CODE_ACT_BLOCKED_TOOLS: JSON.stringify(blockedTools) }
        : {}),
    },
  };
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
    'gpt-5.4': 'GPT-5.4',
    'gpt-5.4-mini': 'GPT-5.4 Mini',
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
  private codexShutdowns: Map<string, Promise<void>> = new Map();
  private permissionManager: ToolPermissionManager;
  private runtimeOptions: MultiAgentRuntimeOptions;
  private readonly privateConnectorPolicy: PrivateConnectorPolicy;
  private gatewayToolExecutor: GatewayToolExecutor | null = null;
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
    runtimeOptions: PrivateAwareMultiAgentRuntimeOptions = {}
  ) {
    super(); // EventEmitter
    this.config = config;
    this.defaultOptions = defaultOptions;
    this.runtimeOptions = runtimeOptions;
    this.privateConnectorPolicy =
      runtimeOptions.privateConnectorPolicy ?? DEFAULT_PRIVATE_CONNECTOR_POLICY;
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
        this.trackCodexShutdown(key, proc);
      } catch {
        // Ignore errors during cleanup
      }
      this.codexProcessPool.delete(key);
    }
  }

  /** Wire the boot-owned executor used by managed Codex Code-Act loops. */
  setGatewayToolExecutor(executor: GatewayToolExecutor): void {
    this.gatewayToolExecutor = executor;
  }

  private getAgentBackend(
    agentConfig: Omit<AgentPersonaConfig, 'id'>,
    agentId?: string
  ): 'claude' | 'codex' | 'cline' {
    const backend = agentConfig.backend ?? this.runtimeOptions.backend;
    if (!backend) {
      throw new Error(
        `No backend configured for agent${agentId ? ` '${agentId}'` : ''}. ` +
          `Set 'backend' in agent config or global agent.backend. Valid: 'claude' | 'codex' | 'cline'`
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

  private personaCacheKey(agentId: string, model?: string): string {
    return `${this.privateConnectorPolicy.fingerprint}\u0000${agentId}\u0000${model ?? ''}`;
  }

  private personaCacheAgentId(cacheKey: string): string {
    return cacheKey.split('\u0000')[1] ?? '';
  }

  private clearAgentPersonaCache(agentId: string): void {
    for (const cacheKey of this.personaCache.keys()) {
      if (this.personaCacheAgentId(cacheKey) === agentId) {
        this.personaCache.delete(cacheKey);
      }
    }
  }

  private clearPersonaCache(preserveEphemeral = false): void {
    if (!preserveEphemeral) {
      this.personaCache.clear();
      return;
    }

    for (const cacheKey of this.personaCache.keys()) {
      if (!this.isEphemeralAgent(this.personaCacheAgentId(cacheKey))) {
        this.personaCache.delete(cacheKey);
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
    agentId: string,
    overrides?: { requestTimeout?: number }
  ): Promise<AgentRuntimeProcess> {
    const processStart = Date.now();
    const channelKey = this.buildChannelKey(source, channelId, agentId);
    const agentConfig = this.config.agents[agentId];
    const agentBackend = this.getAgentBackend(agentConfig, agentId);
    if (
      (agentBackend === 'codex' || agentBackend === 'cline') &&
      agentConfig?.useCodeAct &&
      !this.gatewayToolExecutor
    ) {
      throw new Error(
        `Managed ${agentBackend} Code-Act agent "${agentId}" cannot start: shared GatewayToolExecutor is not wired`
      );
    }
    const model = resolveBackendScopedModel({
      backend: agentBackend,
      model: agentConfig?.model,
      inheritedBackend: this.runtimeOptions.backend,
      inheritedModel: this.runtimeOptions.model ?? this.defaultOptions.model,
    });
    const systemPrompt = await this.loadPersona(agentId, model);
    const tier = agentConfig?.tier ?? 1;
    const options: Partial<PersistentProcessOptions> = {
      ...this.defaultOptions,
      systemPrompt,
      requestTimeout:
        overrides?.requestTimeout ??
        this.defaultOptions.requestTimeout ??
        this.runtimeOptions.requestTimeout ??
        900000,
    };

    options.model = model;
    const effort = agentConfig?.effort || this.runtimeOptions.effort;
    if (effort) {
      // options.effort is the claude --effort flag. Codex/cline runners take effort
      // from runtimeOptions instead, so a codex-only global ('xhigh') must not leak
      // onto a claude sub-agent's CLI. Say so rather than dropping it quietly.
      if (effortSupportedByBackend('claude', effort)) {
        options.effort = effort as NonNullable<PersistentProcessOptions['effort']>;
      } else {
        debugLogger.debug(
          `[AgentProcessManager] effort "${effort}" is not a claude thinking level; not applied to agent "${agentId}"`
        );
      }
    }

    // MCP config: expose MCP tools to agents. Claude Code-Act agents retain the
    // legacy stripped MCP transport; Codex receives its outer code_act function
    // natively from AgentLoop and must not also load the retired MCP wrapper.
    const mcpConfigPath = resolve(homedir(), '.mama', 'mama-mcp-config.json');
    if (existsSync(mcpConfigPath)) {
      if (agentConfig?.useCodeAct && agentBackend === 'claude') {
        // Claude Code-Act agents: only provide code-act MCP server
        const codeActOnlyConfig = resolve(
          homedir(),
          '.mama',
          `code-act-only-mcp-config-${safeConfigId(agentId)}.json`
        );
        try {
          const fullConfig = JSON.parse(readFileSync(mcpConfigPath, 'utf-8')) as {
            mcpServers?: Record<string, unknown>;
          };
          const codeActEntry = fullConfig.mcpServers?.['code-act'];
          if (codeActEntry) {
            const allowedTools = this.deriveCodeActAllowedTools(agentConfig);
            const blockedTools = codeActBlockedTools(agentConfig);
            writeFileSync(
              codeActOnlyConfig,
              JSON.stringify(
                {
                  mcpServers: {
                    'code-act': withCodeActPolicyEnv(
                      codeActEntry,
                      agentId,
                      allowedTools,
                      blockedTools
                    ),
                  },
                },
                null,
                2
              ),
              'utf-8'
            );
            options.mcpConfigPath = codeActOnlyConfig;
          } else {
            throw new Error(`Missing mcpServers["code-act"] in ${mcpConfigPath}`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Code-Act MCP config unavailable for agent "${agentId}" at ${mcpConfigPath}: ${message}`
          );
        }
      } else if (!agentConfig?.useCodeAct && agentBackend === 'claude') {
        options.mcpConfigPath = mcpConfigPath;
      }
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
    } else if (agentBackend === 'cline') {
      options.allowedTools = ['*'];
    }
    if (permissions.blocked.length > 0) {
      options.disallowedTools = permissions.blocked;
    }

    // Code-Act: available as optional tool alongside direct tools (no forced disallowedTools)

    if (agentBackend === 'codex') {
      await this.waitForCodexShutdown(channelKey);
      const existing = this.codexProcessPool.get(channelKey);
      if (existing) {
        return existing;
      }

      const runner = agentConfig.useCodeAct
        ? this.createManagedCodeActRunner(
            'codex',
            options,
            channelKey,
            source,
            channelId,
            agentId,
            agentConfig,
            this.gatewayToolExecutor!
          )
        : this.createCodexRunner(options, channelKey);
      this.codexProcessPool.set(channelKey, runner);
      this.emit('process-created', { agentId, process: runner });
      return runner;
    }

    if (agentBackend === 'cline') {
      await this.waitForCodexShutdown(channelKey);
      const existing = this.codexProcessPool.get(channelKey);
      if (existing) {
        return existing;
      }
      const runner = agentConfig.useCodeAct
        ? this.createManagedCodeActRunner(
            'cline',
            options,
            channelKey,
            source,
            channelId,
            agentId,
            agentConfig,
            this.gatewayToolExecutor!
          )
        : this.createClineRunner(options, channelKey, agentConfig);
      this.codexProcessPool.set(channelKey, runner);
      this.emit('process-created', { agentId, process: runner });
      return runner;
    }

    // Claude backend
    const { process, created } = await this.processPool.getProcessWithStatus(channelKey, options);
    if (created) {
      this.emit('process-created', { agentId, process });
    }
    if (agentId.toLowerCase() === 'conductor' && this.tracePromptMs) {
      processManagerLogger.debug(
        `[Conductor][timing] total getProcess latency ${Date.now() - processStart}ms`
      );
    }
    return process;
  }

  /**
   * Get a shared singleton process for system-level agents (e.g., memory agent).
   * Unlike getProcess() which creates per-channel processes, this returns
   * a single persistent process shared across all channels.
   *
   * Uses fixed channelKey: `__system__:<agentId>:<agentId>`
   */
  async getSharedProcess(
    agentId: string,
    overrides?: { requestTimeout?: number }
  ): Promise<AgentRuntimeProcess> {
    return this.getProcess('__system__', agentId, agentId, overrides);
  }

  /**
   * Factory: create a runner for a given backend.
   * Claude runners are managed by PersistentProcessPool (returned separately).
   * Codex runners are created here as standalone instances.
   */
  private createCodexRunner(
    options: Partial<PersistentProcessOptions>,
    sessionKey: string
  ): AgentRuntimeProcess {
    return new CodexRuntimeProcess({
      defaultSessionKey: sessionKey,
      model: options.model || this.runtimeOptions.model,
      systemPrompt: options.systemPrompt,
      cwd: this.runtimeOptions.codexCwd ? resolvePath(this.runtimeOptions.codexCwd) : undefined,
      sandbox: this.runtimeOptions.codexSandbox,
      command: this.runtimeOptions.codexCommand,
      requestTimeout: options.requestTimeout,
      mcpConfigPath: options.mcpConfigPath,
      // GLOBAL effort only. The per-agent effort is a claude thinking level; using it
      // here would make each agent rewrite the shared managed config.toml differently.
      effort: this.runtimeOptions.effort,
    });
  }

  private createClineRunner(
    options: Partial<PersistentProcessOptions>,
    sessionKey: string,
    agentConfig: Omit<AgentPersonaConfig, 'id'>
  ): AgentRuntimeProcess {
    const allowedTools = projectClineNativeTools(options.allowedTools);
    const disallowedTools = projectClineNativeTools(options.disallowedTools);
    const canDelegate = (agentConfig.tier ?? 1) === 1 && agentConfig.can_delegate === true;
    return new ClineCLIAdapter({
      command: this.runtimeOptions.clineCommand,
      provider: this.runtimeOptions.clineProvider ?? 'cline',
      model: options.model || this.runtimeOptions.model,
      systemPrompt: options.systemPrompt,
      cwd: this.runtimeOptions.clineCwd ? resolvePath(this.runtimeOptions.clineCwd) : process.cwd(),
      dataDir: this.runtimeOptions.clineDataDir,
      requestTimeout: options.requestTimeout,
      env: options.env,
      sessionId: sessionKey,
      allowedTools,
      disallowedTools,
      allowSpawnAgent: canDelegate,
      allowAgentTeams: canDelegate,
    });
  }

  private createManagedCodeActRunner(
    backend: 'codex' | 'cline',
    options: Partial<PersistentProcessOptions>,
    sessionKey: string,
    source: string,
    channelId: string,
    agentId: string,
    agentConfig: Omit<AgentPersonaConfig, 'id'>,
    executor: GatewayToolExecutor
  ): AgentRuntimeProcess {
    const allowedTools = this.deriveCodeActAllowedTools(agentConfig) ?? ['*'];
    const blockedTools = codeActBlockedTools(agentConfig) ?? [];
    const outerAllowedTools = [
      CODE_ACT_MARKER,
      ...allowedTools.filter((tool) => tool !== CODE_ACT_MARKER),
    ];
    const platform: AgentPlatform =
      source === 'viewer' ||
      source === 'discord' ||
      source === 'telegram' ||
      source === 'slack' ||
      source === 'chatwork' ||
      source === 'cli'
        ? source
        : 'cli';
    const capabilities = allowedTools.includes('*')
      ? [CODE_ACT_MARKER, ...HostBridge.getToolRegistry().map((tool) => tool.name)]
      : [...outerAllowedTools];
    const agentContext: AgentContext = {
      source,
      platform,
      roleName: agentId,
      role: {
        allowedTools: outerAllowedTools,
        blockedTools: [...blockedTools],
        model: options.model,
        maxTurns: agentConfig.max_turns,
      },
      session: {
        sessionId: sessionKey,
        channelId,
        startedAt: new Date(),
      },
      capabilities,
      limitations: blockedTools.map((tool) => `Cannot use ${tool}`),
      tier: agentConfig.tier ?? 1,
      backend,
    };
    const canDelegate = (agentConfig.tier ?? 1) === 1 && agentConfig.can_delegate === true;
    const loop = new AgentLoop(null, {
      backend,
      model: options.model ?? this.runtimeOptions.model,
      systemPrompt: options.systemPrompt,
      maxTurns: agentConfig.max_turns,
      timeoutMs: options.requestTimeout,
      sessionKey,
      useCodeAct: true,
      agentContext,
      toolsConfig: { gateway: ['*'], mcp: [] },
      executor,
      ...(backend === 'cline'
        ? {
            clineCwd: this.runtimeOptions.clineCwd
              ? resolvePath(this.runtimeOptions.clineCwd)
              : undefined,
            clineCommand: this.runtimeOptions.clineCommand,
            clineProvider: this.runtimeOptions.clineProvider,
            clineDataDir: this.runtimeOptions.clineDataDir,
            clineNativeAllowedTools: projectClineNativeTools(options.allowedTools),
            clineNativeDisallowedTools: projectClineNativeTools(options.disallowedTools),
            clineAllowSpawnAgent: canDelegate,
            clineAllowAgentTeams: canDelegate,
          }
        : {}),
      codexCwd: this.runtimeOptions.codexCwd
        ? resolvePath(this.runtimeOptions.codexCwd)
        : undefined,
      codexCommand: this.runtimeOptions.codexCommand,
      codexSandbox: this.runtimeOptions.codexSandbox,
      codexHome: this.runtimeOptions.codexHome,
      codexIsolatedHome: this.runtimeOptions.codexIsolatedHome,
      codexRegistryRoot: this.runtimeOptions.codexRegistryRoot,
    });
    return new ManagedCodeActProcess(
      loop,
      sessionKey,
      source,
      channelId,
      agentContext,
      options.model ?? this.runtimeOptions.model
    );
  }

  /**
   * Load persona system prompt for an agent
   */
  async loadPersona(agentId: string, resolvedModel?: string): Promise<string> {
    const shouldTrace = this.shouldTracePrompt(agentId);
    const traceCacheKey = agentId.toLowerCase() === 'conductor' ? 'conductor' : agentId;

    // Check if a skill rules file exists for this agent (allows hot-reload)
    const skillPath = resolve(homedir(), '.mama', 'skills', `${agentId}-rules.md`);
    const hasSkillFile = existsSync(skillPath);

    // Check cache first — skip cache if skill file exists to allow hot-reload
    const cacheKey = this.personaCacheKey(agentId, resolvedModel);
    if (this.personaCache.has(cacheKey) && !hasSkillFile) {
      const cachedPrompt = this.personaCache.get(cacheKey)!;
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
      this.personaCache.set(cacheKey, defaultPersona);
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
      let systemPrompt = await this.buildSystemPrompt(
        agentId,
        agentConfig,
        personaContent,
        resolvedModel
      );
      if (shouldTrace) {
        processManagerLogger.debug(
          `[Conductor] system prompt built key=${traceCacheKey} build_ms=${Date.now() - buildStart} total_ms=${
            Date.now() - loadStart
          } len=${systemPrompt.length}`
        );
      }

      // Append agent-specific skill rules from ~/.mama/skills/{agentId}-rules.md
      if (hasSkillFile) {
        try {
          const skillContent = await readFile(skillPath, 'utf8');
          if (skillContent.trim()) {
            systemPrompt += `\n\n## Agent Rules (auto-loaded from ${agentId}-rules.md)\n\n${skillContent}`;
            if (shouldTrace) {
              processManagerLogger.debug(
                `[${agentId}] Skill rules loaded: ${skillContent.length} chars`
              );
            }
          }
        } catch {
          // Non-fatal: skill file read error
        }
      }

      this.personaCache.set(cacheKey, systemPrompt);
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
    personaContent: string,
    resolvedModel?: string
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
    const actualModel = resolvedModel || agentConfig.model || this.runtimeOptions.model;
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
    const codexModelId = this.resolveModelForBackend('codex');
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
      }
      // No else. The fallback used to teach `DELEGATE::{agent}::{task}`, and nothing has
      // parsed or executed that since the delegation executor was removed - so a delegating
      // agent in a non-mention configuration was being handed a syntax that does nothing.
      // Teaching no delegation is the honest state of that configuration.
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

    const skillsPrompt = this.buildSkillsPrompt(agentId, agentConfig);
    const agentBackend = this.getAgentBackend(agentConfig, agentId);
    const backendAgentsMd = loadBackendAgentsMd(agentBackend);

    const systemPrompt = `# Agent Identity

You are **${agentConfig.display_name}** (ID: ${agentId}).

## Response Format
- Prefix: **${agentConfig.display_name}**:
- Do the work thoroughly, then report the result
- **ALWAYS respond with text** — never reply with only emoji/reactions
- Multiple AI agents in this channel — be aware of what others have said

## Persona
${resolvedPersona}

${bmadBlock}${backendAgentsMd ? `## Backend-Specific Rules\n${backendAgentsMd}\n\n` : ''}${permissionPrompt}${delegationPrompt ? delegationPrompt + '\n' : ''}${reportBackPrompt ? reportBackPrompt + '\n' : ''}${this.buildToolsSection(agentConfig)}

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
    const allowedTools = agentConfig.useCodeAct
      ? (this.deriveCodeActAllowedTools(agentConfig) ?? ['*'])
      : (agentConfig.tool_permissions?.allowed ?? ['*']);
    const blockedTools = agentConfig.useCodeAct
      ? codeActBlockedTools(agentConfig)
      : agentConfig.tool_permissions?.blocked;
    const catalog = buildGatewayToolCatalog({
      surface: 'multi-agent-generic',
      allowedTools,
      blockedTools,
      privateConnectorPolicy: this.privateConnectorPolicy,
    });
    // Code-Act mode: replace tool_call instructions with Code-Act JS execution
    if (agentConfig.useCodeAct && tier !== 3) {
      const policy = projectCodeActToolPolicy({
        tier: tier as 1 | 2 | 3,
        role: { allowedTools: [...catalog.toolNames], blockedTools: [] },
      });
      const typeDefs = TypeDefinitionGenerator.generate(policy);
      const backend = agentConfig.backend ?? this.runtimeOptions.backend ?? 'claude';
      const codeActBackend = backend;
      return (
        getCodeActInstructions(codeActBackend, policy.names) +
        '\n```typescript\n' +
        typeDefs +
        '\n```\n'
      );
    }

    // Per-agent tool filtering via ToolRegistry (STORY-018)
    return catalog.prompt;
  }

  private deriveCodeActAllowedTools(
    agentConfig: Omit<AgentPersonaConfig, 'id'>
  ): string[] | undefined {
    const explicitGatewayAllowed = agentConfig.gateway_tool_permissions?.allowed;
    if (explicitGatewayAllowed) {
      return this.filterCodeActAllowedTools(
        explicitGatewayAllowed,
        agentConfig.gateway_tool_permissions?.blocked
      );
    }

    const explicitGatewayBlocked = agentConfig.gateway_tool_permissions?.blocked;
    if (explicitGatewayBlocked) {
      const allGatewayTools = HostBridge.getToolRegistry().map((meta) => meta.name);
      return this.filterCodeActAllowedTools(allGatewayTools, explicitGatewayBlocked);
    }

    const cliAllowed = agentConfig.tool_permissions?.allowed;
    if (cliAllowed) {
      return this.filterCodeActAllowedTools(cliAllowed, agentConfig.tool_permissions?.blocked);
    }

    const cliBlocked = agentConfig.tool_permissions?.blocked;
    if (cliBlocked) {
      const allGatewayTools = HostBridge.getToolRegistry().map((meta) => meta.name);
      return this.filterCodeActAllowedTools(allGatewayTools, cliBlocked);
    }

    return undefined;
  }

  private filterCodeActAllowedTools(allowedTools: string[], blockedTools?: string[]): string[] {
    const catalog = buildGatewayToolCatalog({
      surface: 'multi-agent-generic',
      allowedTools,
      blockedTools,
      privateConnectorPolicy: this.privateConnectorPolicy,
    });
    return [
      ...projectCodeActToolPolicy({
        tier: 1,
        role: { allowedTools: [...catalog.toolNames], blockedTools: [] },
      }).names,
    ];
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
   * Falls back to the configured backend default when no registered agent provides one.
   */
  resolveModelForBackend(backend: string): string {
    for (const [, cfg] of Object.entries(this.config.agents)) {
      const agentBackend = this.getAgentBackend(cfg);
      if (agentBackend === backend && cfg.model) {
        return cfg.model;
      }
    }
    if (backend === this.runtimeOptions.backend && this.runtimeOptions.model) {
      return this.runtimeOptions.model;
    }
    if (backend === 'claude' || backend === 'codex' || backend === 'cline') {
      return defaultModelForBackend(backend);
    }
    throw new Error(`Unsupported backend: ${backend}`);
  }

  /**
   * Build installed skills prompt section
   */
  private buildSkillsPrompt(agentId: string, agentConfig: Omit<AgentPersonaConfig, 'id'>): string {
    if (this.shouldOmitSkillCatalog(agentId, agentConfig)) {
      return '';
    }
    const skillCatalog = filterSkillCatalogForContext(loadInstalledSkills(), null);
    if (skillCatalog.length === 0) return '';

    return `## Installed Skills

To invoke a skill, include its keywords in your message.
The full skill instructions will be provided automatically when matched.

${skillCatalog.join('\n')}
`;
  }

  private shouldOmitSkillCatalog(
    agentId: string,
    agentConfig: Omit<AgentPersonaConfig, 'id'>
  ): boolean {
    const systemAutomationAgents = new Set([
      'conductor',
      'dashboard-agent',
      'wiki-agent',
      'memory',
      'memory-agent',
    ]);
    if (systemAutomationAgents.has(agentId.toLowerCase())) {
      return true;
    }
    return agentConfig.can_delegate === false && agentConfig.useCodeAct === true;
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
      this.trackCodexShutdown(channelKey, codexProcess);
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
        if (process) {
          this.trackCodexShutdown(channelKey, process);
        }
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
        if (process) {
          this.trackCodexShutdown(channelKey, process);
        }
        this.codexProcessPool.delete(channelKey);
      }
    }
  }

  /**
   * Stop all processes
   */
  async stopAll(): Promise<void> {
    this.processPool.stopAll();
    for (const [key, process] of this.codexProcessPool) {
      this.trackCodexShutdown(key, process);
    }
    this.codexProcessPool.clear();
    await Promise.all(this.codexShutdowns.values());
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
  async registerEphemeralAgent(agentDef: EphemeralAgentDef): Promise<void> {
    const agentConfig = {
      name: agentDef.display_name,
      display_name: agentDef.display_name,
      trigger_prefix: '', // ephemeral agents have no trigger
      persona_file: '', // inline system prompt, no file
      backend: agentDef.backend,
      model: agentDef.model,
      tier: agentDef.tier ?? 1,
      tool_permissions: agentDef.tool_permissions,
      enabled: true,
    };
    this.config.agents[agentDef.id] = agentConfig;
    // Build full system prompt (with gateway tools, permissions, etc.)
    const fullPrompt = await this.buildSystemPrompt(
      agentDef.id,
      agentConfig,
      agentDef.system_prompt
    );
    this.personaCache.set(this.personaCacheKey(agentDef.id, agentDef.model), fullPrompt);
  }

  /**
   * Unregister ephemeral agents and clean up their processes.
   */
  unregisterEphemeralAgents(agentDefs: EphemeralAgentDef[]): void {
    for (const { id: agentId } of agentDefs) {
      this.stopAgentProcesses(agentId);
      this.clearAgentPersonaCache(agentId);
      delete this.config.agents[agentId];
    }
  }

  /**
   * Reload persona for an agent (clears cache)
   */
  reloadPersona(agentId: string): void {
    this.clearAgentPersonaCache(agentId);
    // Stop all processes for this agent to force reload
    this.stopAgentProcesses(agentId);
  }

  /**
   * Reload all personas
   */
  reloadAllPersonas(): void {
    this.clearPersonaCache(true);
    this.processPool.stopAll();
    for (const [key, process] of this.codexProcessPool) {
      this.trackCodexShutdown(key, process);
    }
    this.codexProcessPool.clear();
  }

  private trackCodexShutdown(channelKey: string, process: AgentRuntimeProcess): Promise<void> {
    const prior = this.codexShutdowns.get(channelKey);
    const shutdown = (prior ? prior.catch(() => undefined) : Promise.resolve())
      .then(() => process.stop())
      .catch((error: unknown) => {
        processManagerLogger.error(
          `Codex process shutdown failed for ${channelKey}: ${error instanceof Error ? error.message : String(error)}`
        );
        throw error;
      });
    const tracked = shutdown.finally(() => {
      if (this.codexShutdowns.get(channelKey) === tracked) {
        this.codexShutdowns.delete(channelKey);
      }
    });
    void tracked.catch(() => undefined);
    this.codexShutdowns.set(channelKey, tracked);
    return tracked;
  }

  private async waitForCodexShutdown(channelKey: string): Promise<void> {
    await this.codexShutdowns.get(channelKey);
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
