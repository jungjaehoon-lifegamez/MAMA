/**
 * Agent Loop Engine for MAMA Standalone
 *
 * Main orchestrator that:
 * - Maintains conversation history
 * - Calls Claude API via ClaudeClient
 * - Parses tool_use blocks from responses
 * - Executes tools via MCPExecutor
 * - Sends tool_result back to Claude
 * - Loops until stop_reason is "end_turn" or max turns reached
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { PromptSizeMonitor } from './prompt-size-monitor.js';
import type { PromptLayer } from './prompt-size-monitor.js';
import { ClaudeCLIWrapper } from './claude-cli-wrapper.js';
import { CodexCLIWrapper } from './codex-cli-wrapper.js';
import { PersistentCLIAdapter } from './persistent-cli-adapter.js';
import { GatewayToolExecutor } from './gateway-tool-executor.js';
import { LaneManager, getGlobalLaneManager } from '../concurrency/index.js';
import { SessionPool, getSessionPool, buildChannelKey } from './session-pool.js';
import type { OAuthManager } from '../auth/index.js';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type {
  Message,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ToolDefinition,
  AgentLoopOptions,
  AgentLoopResult,
  TurnInfo,
  ClaudeResponse,
  GatewayToolInput,
  ClaudeClientOptions,
  GatewayToolExecutorOptions,
  StreamCallbacks,
  AgentContext,
} from './types.js';
import { AgentError } from './types.js';
import { buildContextPrompt } from './context-prompt-builder.js';
import { PostToolHandler } from './post-tool-handler.js';
import { StopContinuationHandler } from './stop-continuation-handler.js';
import { PreCompactHandler } from './pre-compact-handler.js';
import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';

const { DebugLogger } = debugLogger as {
  DebugLogger: new (context?: string) => {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
};

const logger = new DebugLogger('AgentLoop');

/**
 * Default configuration
 */
const DEFAULT_MAX_TURNS = 20; // Increased from 10 to allow more complex tool chains

/**
 * Default tools configuration - all tools via Gateway (self-contained)
 */
const DEFAULT_TOOLS_CONFIG = {
  gateway: ['*'],
  mcp: [] as string[],
  mcp_config: '~/.mama/mama-mcp-config.json',
};

/**
 * Check if a tool name matches a pattern (supports wildcards like "browser_*")
 * Reserved for future hybrid tool routing
 */
function _matchToolPattern(toolName: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return toolName.startsWith(prefix);
  }
  return toolName === pattern;
}

// _matchToolPattern is reserved for future hybrid routing
void _matchToolPattern;

/**
 * Load CLAUDE.md system prompt
 * Tries multiple paths: project root, ~/.mama, /etc/mama
 */
function loadSystemPrompt(verbose = false, backend?: 'claude' | 'codex'): string {
  const searchPaths = [
    // Codex-specific prompt (if configured)
    ...(backend === 'codex' ? [join(homedir(), '.mama/CODEX.md')] : []),
    // User home - MAMA standalone config (priority)
    join(homedir(), '.mama/CLAUDE.md'),
    // System config
    '/etc/mama/CLAUDE.md',
    // Project root (monorepo) - fallback only for development
    join(__dirname, '../../../../CLAUDE.md'),
  ];

  for (const path of searchPaths) {
    if (existsSync(path)) {
      if (verbose) console.log(`[AgentLoop] Loaded system prompt from: ${path}`);
      return readFileSync(path, 'utf-8');
    }
  }

  if (backend === 'codex') {
    console.warn('[AgentLoop] CODEX.md not found, using minimal Codex identity');
    return 'You are MAMA OS running on Codex CLI. Follow user and MAMA rules.';
  }

  console.warn('[AgentLoop] CLAUDE.md not found, using default identity');
  return "You are Claude Code, Anthropic's official CLI for Claude.";
}

/**
 * Load composed system prompt with persona layers + CLAUDE.md + optional context
 * Tries to load persona files from ~/.mama/ in order:
 * 1. SOUL.md (philosophical principles)
 * 2. IDENTITY.md (role and character)
 * 3. USER.md (user preferences)
 * 4. **Context Prompt** (if AgentContext provided - role awareness)
 * 5. CLAUDE.md (base instructions)
 *
 * If persona files are missing, logs warning and continues with CLAUDE.md alone.
 *
 * @param verbose - Enable verbose logging
 * @param context - Optional AgentContext for role-aware prompt injection
 */
/**
 * Files to exclude from skill prompt injection (reduce token bloat)
 */
const EXCLUDED_SKILL_FILES = new Set([
  'CONNECTORS.md',
  'connectors.md',
  'LICENSE.md',
  'license.md',
  'CHANGELOG.md',
  'changelog.md',
  'CONTRIBUTING.md',
  'contributing.md',
  'README.md',
  'readme.md',
]);

/** Max chars per skill file to prevent prompt bloat */
const MAX_SKILL_FILE_CHARS = 4000;

/**
 * Recursively collect all .md files from a directory (sync)
 * Filters out non-essential files (LICENSE, CONNECTORS, etc.)
 */
function collectMarkdownFiles(dir: string, prefix = ''): Array<{ path: string; content: string }> {
  const results: Array<{ path: string; content: string }> = [];
  if (!existsSync(dir)) return results;

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = join(dir, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        results.push(...collectMarkdownFiles(fullPath, relativePath));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        if (EXCLUDED_SKILL_FILES.has(entry.name)) continue;
        let content = readFileSync(fullPath, 'utf-8');
        // Only truncate supplementary files, never command files
        const isCommand = relativePath.startsWith('commands/');
        if (!isCommand && content.length > MAX_SKILL_FILE_CHARS) {
          content = content.slice(0, MAX_SKILL_FILE_CHARS) + '\n\n[... truncated]';
        }
        results.push({ path: relativePath, content });
      }
    }
  } catch {
    // Read failed
  }
  return results;
}

/**
 * Load installed & enabled skills from ~/.mama/skills/
 * Returns skill content blocks for system prompt injection.
 * Reads all .md files recursively (commands/, skills/, etc.)
 */
export function loadInstalledSkills(
  verbose = false,
  options: { onlyCommands?: boolean } = {}
): string[] {
  const skillsBase = join(homedir(), '.mama', 'skills');
  const stateFile = join(skillsBase, 'state.json');
  const blocks: string[] = [];

  // Load state (enabled/disabled tracking)
  let state: Record<string, { enabled: boolean }> = {};
  try {
    if (existsSync(stateFile)) {
      state = JSON.parse(readFileSync(stateFile, 'utf-8'));
    }
  } catch {
    // No state file
  }

  const sources = ['mama', 'cowork', 'external'];
  for (const source of sources) {
    const sourceDir = join(skillsBase, source);
    if (!existsSync(sourceDir)) continue;

    try {
      const entries = readdirSync(sourceDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const stateKey = `${source}/${entry.name}`;

        // Skip disabled skills
        if (state[stateKey]?.enabled === false) continue;

        const skillDir = join(sourceDir, entry.name);
        let mdFiles = collectMarkdownFiles(skillDir);
        if (options.onlyCommands) {
          mdFiles = mdFiles.filter((f) => f.path.startsWith('commands/'));
        }

        if (mdFiles.length > 0) {
          const parts = mdFiles.map((f) => `## ${f.path}\n\n${f.content}`);
          blocks.push(`# [Skill: ${source}/${entry.name}]\n\n${parts.join('\n\n---\n\n')}`);
          if (verbose)
            console.log(
              `[AgentLoop] Loaded skill: ${source}/${entry.name} (${mdFiles.length} files)`
            );
        }
      }
    } catch {
      // Directory read failed
    }
  }

  // Also load flat .md skill files from ~/.mama/skills/ root
  try {
    const rootEntries = readdirSync(skillsBase, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) {
        continue;
      }
      if (EXCLUDED_SKILL_FILES.has(entry.name)) {
        continue;
      }
      const id = entry.name.replace(/\.md$/, '');
      const stateKey = `mama/${id}`;

      // Skip disabled skills (check state like subdirectory skills)
      if (state[stateKey]?.enabled === false) {
        continue;
      }

      // Skip if already loaded from subdirectory
      if (blocks.some((b) => b.includes(`[Skill: mama/${id}]`))) {
        continue;
      }

      const fullPath = join(skillsBase, entry.name);
      let content = readFileSync(fullPath, 'utf-8');
      if (content.length > MAX_SKILL_FILE_CHARS) {
        content = content.slice(0, MAX_SKILL_FILE_CHARS) + '\n\n[... truncated]';
      }
      blocks.push(`# [Skill: mama/${id}]\n\n${content}`);
      if (verbose) console.log(`[AgentLoop] Loaded root skill: ${id}`);
    }
  } catch {
    // Root directory read failed
  }

  return blocks;
}

export function loadComposedSystemPrompt(verbose = false, context?: AgentContext): string {
  const mamaHome = join(homedir(), '.mama');
  const layers: string[] = [];
  const backend = (process.env.MAMA_BACKEND as 'claude' | 'codex' | undefined) ?? 'claude';

  // Load state for conditional loading (skills + system docs)
  const stateFile = join(mamaHome, 'skills', 'state.json');
  let state: Record<string, { enabled?: boolean }> = {};
  try {
    if (existsSync(stateFile)) {
      state = JSON.parse(readFileSync(stateFile, 'utf-8'));
    }
  } catch (err) {
    logger.error(`Failed to parse state file ${stateFile}:`, err);
    throw new Error(
      `Failed to parse state file ${stateFile}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Load persona files: SOUL.md, IDENTITY.md, USER.md
  const personaFiles = backend === 'codex' ? ['USER.md'] : ['SOUL.md', 'IDENTITY.md', 'USER.md'];
  for (const file of personaFiles) {
    const path = join(mamaHome, file);
    if (existsSync(path)) {
      if (verbose) console.log(`[AgentLoop] Loaded persona: ${file}`);
      const content = readFileSync(path, 'utf-8');
      layers.push(content);
    } else {
      if (verbose) console.log(`[AgentLoop] Persona file not found (skipping): ${file}`);
    }
  }

  // Load installed & enabled skills (HIGH PRIORITY — before CLAUDE.md)
  const skillBlocks = loadInstalledSkills(verbose, { onlyCommands: backend === 'codex' });
  if (skillBlocks.length > 0) {
    const skillDirective = [
      '# Installed Skills (PRIORITY)',
      '',
      '**IMPORTANT:** The following skills/plugins are installed by the user.',
      'When a user request matches a skill by keywords or description, you MUST:',
      '1. Find the matching skill section below (check "keywords" in frontmatter or skill name)',
      '2. Follow its "지시사항" / instructions EXACTLY as written — do NOT improvise alternatives',
      '3. Use the tools available to you (fetch, Bash, etc.) as the skill directs',
      '4. DO NOT create separate scripts or files unless the skill explicitly instructs it',
      '5. For [INSTALLED PLUGIN COMMAND] messages, find matching "commands/{name}.md"',
      '6. DO NOT use the Skill tool — these are NOT system skills',
      '',
      skillBlocks.join('\n\n---\n\n'),
    ].join('\n');
    layers.push(skillDirective);
    if (verbose) console.log(`[AgentLoop] Injected ${skillBlocks.length} installed skills`);
  }

  // Add context prompt if AgentContext is provided (role awareness)
  if (context) {
    const contextPrompt = buildContextPrompt(context);
    if (verbose)
      console.log(
        `[AgentLoop] Injecting context prompt for ${context.roleName}@${context.platform}`
      );
    layers.push(contextPrompt);
  }

  // Load CLAUDE.md (base instructions)
  const claudeMd = loadSystemPrompt(verbose, backend);
  layers.push(claudeMd);

  // Load ONBOARDING.md only if not disabled in state
  // This contains config schema + bot setup guides - only needed during initial setup
  if (state['system/onboarding']?.enabled !== false) {
    const onboardingPath = join(mamaHome, 'ONBOARDING.md');
    if (existsSync(onboardingPath)) {
      const onboardingContent = readFileSync(onboardingPath, 'utf-8');
      layers.push(onboardingContent);
      if (verbose) {
        logger.debug('Loaded ONBOARDING.md (setup reference)');
      }
    }
  } else {
    if (verbose) {
      logger.debug('Skipped ONBOARDING.md (disabled in state)');
    }
  }

  return layers.join('\n\n---\n\n');
}

/**
 * Load Gateway Tools prompt from MD file
 * These tools are executed by GatewayToolExecutor, NOT MCP
 */
export function getGatewayToolsPrompt(): string {
  const gatewayToolsPath = join(__dirname, 'gateway-tools.md');

  if (existsSync(gatewayToolsPath)) {
    return readFileSync(gatewayToolsPath, 'utf-8');
  }

  // TODO: Consider generating both gateway-tools.md and this fallback from a single source
  // to prevent tool list drift (CodeRabbit review suggestion)
  logger.warn('gateway-tools.md not found, using minimal prompt');
  return `
## Gateway Tools

To call a Gateway Tool, output a JSON block:

\`\`\`tool_call
{"name": "tool_name", "input": {"param1": "value1"}}
\`\`\`

**MAMA Memory:** mama_search, mama_save, mama_update, mama_load_checkpoint
**Browser:** browser_navigate, browser_screenshot, browser_click, browser_type, browser_get_text, browser_scroll, browser_wait_for, browser_evaluate, browser_pdf, browser_close
**Utility:** discord_send, Read, Write, Bash
`;
}

export class AgentLoop {
  private readonly agent: ClaudeCLIWrapper | PersistentCLIAdapter | CodexCLIWrapper;
  private readonly claudeCLI: ClaudeCLIWrapper | null = null;
  private readonly persistentCLI: PersistentCLIAdapter | null = null;
  private readonly mcpExecutor: GatewayToolExecutor;
  private systemPromptOverride?: string;
  private readonly maxTurns: number;
  private readonly model: string;
  private readonly onTurn?: (turn: TurnInfo) => void;
  private readonly onToolUse?: (toolName: string, input: unknown, result: unknown) => void;
  private readonly onTokenUsage?: (record: {
    channel_key: string;
    agent_id?: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens?: number;
    cost_usd?: number;
  }) => void;
  private readonly laneManager: LaneManager;
  private readonly useLanes: boolean;
  private sessionKey: string;
  private readonly sessionPool: SessionPool;
  private readonly toolsConfig: typeof DEFAULT_TOOLS_CONFIG;
  private readonly isGatewayMode: boolean;
  private readonly usePersistentCLI: boolean;
  private readonly backend: 'claude' | 'codex';
  private readonly postToolHandler: PostToolHandler | null;
  private readonly stopContinuationHandler: StopContinuationHandler | null;
  private readonly preCompactHandler: PreCompactHandler | null;
  private preCompactInjected = false;

  constructor(
    _oauthManager: OAuthManager,
    options: AgentLoopOptions = {},
    _clientOptions?: ClaudeClientOptions,
    executorOptions?: GatewayToolExecutorOptions
  ) {
    // Initialize tools config (hybrid Gateway/MCP routing)
    this.toolsConfig = {
      ...DEFAULT_TOOLS_CONFIG,
      ...options.toolsConfig,
    };

    const mcpConfigPath =
      this.toolsConfig.mcp_config?.replace('~', homedir()) ||
      join(homedir(), '.mama/mama-mcp-config.json');
    const sessionId = randomUUID();

    // Determine tool mode: Gateway, MCP, or Hybrid
    // - gateway: ['*'] → Use internal GatewayToolExecutor for mama_*, discord_send, etc.
    // - mcp: ['*'] or [...] → Use MCP servers for external tools (brave-devtools, etc.)
    // - Both can be enabled for hybrid mode
    const mcpTools = this.toolsConfig.mcp || [];
    const gatewayTools = this.toolsConfig.gateway || [];

    // Hybrid mode: Gateway + MCP both enabled
    const useGatewayMode = gatewayTools.includes('*') || gatewayTools.length > 0;
    const useMCPMode = mcpTools.includes('*') || mcpTools.length > 0;
    this.isGatewayMode = useGatewayMode;

    if (useGatewayMode && useMCPMode) {
      logger.debug('🔀 Hybrid mode: Gateway + MCP tools enabled');
    } else if (useMCPMode) {
      logger.debug('🔌 MCP-only mode');
    } else {
      logger.debug('⚙️ Gateway-only mode');
    }

    // Build system prompt
    const basePrompt = options.systemPrompt || loadComposedSystemPrompt();
    // Only include Gateway Tools prompt if using Gateway mode
    const gatewayToolsPrompt = useGatewayMode ? getGatewayToolsPrompt() : '';
    let defaultSystemPrompt = gatewayToolsPrompt
      ? `${basePrompt}\n\n---\n\n${gatewayToolsPrompt}`
      : basePrompt;

    // Monitor and enforce prompt size limits
    const monitor = new PromptSizeMonitor();
    const promptLayers: PromptLayer[] = [
      { name: 'base', content: basePrompt, priority: 1 },
      ...(gatewayToolsPrompt
        ? [{ name: 'gatewayTools', content: gatewayToolsPrompt, priority: 2 } as PromptLayer]
        : []),
    ];
    const checkResult = monitor.check(promptLayers);
    if (checkResult.warning) {
      logger.warn(checkResult.warning);
    }
    // Actually enforce truncation if over budget
    if (!checkResult.withinBudget) {
      const { layers: trimmedLayers, result: enforceResult } = monitor.enforce(promptLayers);
      if (enforceResult.truncatedLayers.length > 0) {
        logger.warn(`Truncated layers: ${enforceResult.truncatedLayers.join(', ')}`);
      }
      const trimmedBase = trimmedLayers.find((l) => l.name === 'base')?.content || basePrompt;
      const trimmedTools = trimmedLayers.find((l) => l.name === 'gatewayTools')?.content || '';
      defaultSystemPrompt = trimmedTools ? `${trimmedBase}\n\n---\n\n${trimmedTools}` : trimmedBase;
      logger.debug(
        `System prompt truncated: ${checkResult.totalChars} → ${defaultSystemPrompt.length} chars`
      );
    }

    // Choose backend (default: claude)
    this.backend = options.backend ?? 'claude';

    // Choose CLI mode: Persistent (fast, experimental) or Standard (stable)
    this.usePersistentCLI = this.backend === 'codex' ? false : (options.usePersistentCLI ?? false);
    if (this.backend === 'codex' && options.usePersistentCLI) {
      logger.warn('Codex backend does not support persistent CLI mode; disabling');
    }

    if (this.usePersistentCLI) {
      // Persistent CLI mode: keeps Claude process alive for multi-turn conversations
      // Response time: ~2-3s instead of ~16-30s
      this.persistentCLI = new PersistentCLIAdapter({
        model: options.model ?? 'claude-sonnet-4-20250514',
        sessionId,
        systemPrompt: defaultSystemPrompt,
        // Hybrid mode: pass MCP config even with Gateway tools enabled
        mcpConfigPath: useMCPMode ? mcpConfigPath : undefined,
        // Headless daemon requires skipping permission prompts (no TTY available).
        // Security is enforced by MAMA's RoleManager, not Claude CLI's interactive prompts.
        // MAMA_TRUSTED_ENV must be set to enable this flag (defense in depth)
        dangerouslySkipPermissions:
          process.env.MAMA_TRUSTED_ENV === 'true' && (options.dangerouslySkipPermissions ?? false),
        // Gateway tools are processed by GatewayToolExecutor (hybrid with MCP)
        useGatewayTools: useGatewayMode,
      });
      this.agent = this.persistentCLI;
      logger.debug('🚀 Persistent CLI mode enabled - faster responses');
    } else {
      if (this.backend === 'codex') {
        // Codex CLI mode: spawns new Codex process per message
        this.agent = new CodexCLIWrapper({
          model: options.model,
          sessionId,
          systemPrompt: defaultSystemPrompt,
          sandbox: 'read-only',
          skipGitRepoCheck: true,
        });
        logger.debug('Codex CLI backend enabled');
      } else {
        // Standard Claude CLI mode: spawns new process per message
        this.claudeCLI = new ClaudeCLIWrapper({
          model: options.model ?? 'claude-sonnet-4-20250514',
          sessionId,
          systemPrompt: defaultSystemPrompt,
          // Hybrid mode: pass MCP config even with Gateway tools enabled
          mcpConfigPath: useMCPMode ? mcpConfigPath : undefined,
          // Headless daemon requires skipping permission prompts (no TTY available).
          // Security is enforced by MAMA's RoleManager, not Claude CLI's interactive prompts.
          // MAMA_TRUSTED_ENV must be set to enable this flag (defense in depth)
          dangerouslySkipPermissions:
            process.env.MAMA_TRUSTED_ENV === 'true' &&
            (options.dangerouslySkipPermissions ?? false),
          // Gateway tools are processed by GatewayToolExecutor (hybrid with MCP)
          useGatewayTools: useGatewayMode,
        });
        this.agent = this.claudeCLI;
      }
    }
    logger.debug(
      'Config: gateway=' +
        JSON.stringify(this.toolsConfig.gateway) +
        ' mcp=' +
        JSON.stringify(this.toolsConfig.mcp)
    );

    this.mcpExecutor = new GatewayToolExecutor(executorOptions);
    this.systemPromptOverride = options.systemPrompt;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    // Use the same default model as CLI wrappers above (L252, L264)
    this.model = options.model ?? 'claude-sonnet-4-20250514';
    this.onTurn = options.onTurn;
    this.onToolUse = options.onToolUse;
    this.onTokenUsage = options.onTokenUsage;

    this.laneManager = getGlobalLaneManager();
    this.useLanes = options.useLanes ?? false;
    this.sessionKey = options.sessionKey ?? 'default';
    this.sessionPool = getSessionPool();

    // Initialize PostToolHandler (fire-and-forget after tool execution)
    if (options.postToolUse?.enabled) {
      this.postToolHandler = new PostToolHandler(
        (name, input) => this.mcpExecutor.execute(name, input as GatewayToolInput),
        { enabled: true, contractSaveLimit: options.postToolUse.contractSaveLimit }
      );
      console.log('[AgentLoop] PostToolHandler enabled');
    } else {
      this.postToolHandler = null;
    }

    // Initialize PreCompactHandler (unsaved decision detection)
    if (options.preCompact?.enabled) {
      this.preCompactHandler = new PreCompactHandler(
        (name, input) => this.mcpExecutor.execute(name, input as GatewayToolInput),
        { enabled: true, maxDecisionsToDetect: options.preCompact.maxDecisionsToDetect }
      );
      console.log('[AgentLoop] PreCompactHandler enabled');
    } else {
      this.preCompactHandler = null;
    }

    // Initialize StopContinuationHandler (opt-in auto-resume)
    if (options.stopContinuation?.enabled) {
      this.stopContinuationHandler = new StopContinuationHandler({
        enabled: true,
        maxRetries: options.stopContinuation.maxRetries ?? 3,
        completionMarkers: options.stopContinuation.completionMarkers ?? [
          'DONE',
          'FINISHED',
          '✅',
          'TASK_COMPLETE',
        ],
      });
      console.log('[AgentLoop] StopContinuationHandler enabled');
    } else {
      this.stopContinuationHandler = null;
    }

    if (!this.systemPromptOverride) {
      loadComposedSystemPrompt(true);
    }
  }

  /**
   * Set session key for lane-based concurrency
   * Use format: "{source}:{channelId}:{userId}"
   */
  setSessionKey(key: string): void {
    this.sessionKey = key;
  }

  /**
   * Get current session key
   */
  getSessionKey(): string {
    return this.sessionKey;
  }

  /**
   * Set system prompt override (for per-message context injection)
   */
  setSystemPrompt(prompt: string | undefined): void {
    this.systemPromptOverride = prompt;
  }

  /**
   * Set Discord gateway for discord_send tool
   */
  setDiscordGateway(gateway: {
    sendMessage(channelId: string, message: string): Promise<void>;
    sendFile(channelId: string, filePath: string, caption?: string): Promise<void>;
    sendImage(channelId: string, imagePath: string, caption?: string): Promise<void>;
  }): void {
    this.mcpExecutor.setDiscordGateway(gateway);
  }

  /**
   * Run the agent loop with a user prompt
   *
   * Uses lane-based concurrency when useLanes is enabled:
   * - Same session messages are processed in order
   * - Different sessions can run in parallel
   * - Global lane limits total concurrent API calls
   *
   * @param prompt - User prompt to process
   * @param options - Execution options (systemPrompt, disableAutoRecall, etc.)
   * @returns Agent loop result with final response and history
   * @throws AgentError on errors
   */
  async run(prompt: string, options?: AgentLoopOptions): Promise<AgentLoopResult> {
    // Convert string prompt to text content block
    const content: ContentBlock[] = [{ type: 'text', text: prompt }];

    // Use lane-based queueing if enabled
    if (this.useLanes) {
      return this.laneManager.enqueueWithSession(this.sessionKey, () =>
        this.runWithContentInternal(content, options)
      );
    }

    // Direct execution for backward compatibility
    return this.runWithContentInternal(content, options);
  }

  /**
   * Run the agent loop with multimodal content blocks
   *
   * Uses lane-based concurrency when useLanes is enabled.
   *
   * @param content - Array of content blocks (text, images, documents)
   * @param options - Execution options (systemPrompt, disableAutoRecall, etc.)
   * @returns Agent loop result with final response and history
   * @throws AgentError on errors
   */
  async runWithContent(
    content: ContentBlock[],
    options?: AgentLoopOptions
  ): Promise<AgentLoopResult> {
    const sessionKey = options?.sessionKey || this.sessionKey;

    // Use lane-based queueing if enabled
    if (this.useLanes) {
      return this.laneManager.enqueueWithSession(sessionKey, () =>
        this.runWithContentInternal(content, options)
      );
    }

    // Direct execution for backward compatibility
    return this.runWithContentInternal(content, options);
  }

  /**
   * Internal implementation of runWithContent (without lane queueing)
   */
  private async runWithContentInternal(
    content: ContentBlock[],
    options?: AgentLoopOptions
  ): Promise<AgentLoopResult> {
    const history: Message[] = [];
    const totalUsage = { input_tokens: 0, output_tokens: 0 };
    let turn = 0;
    let stopReason: ClaudeResponse['stop_reason'] = 'end_turn';

    // Infinite loop prevention
    let consecutiveToolCalls = 0;
    let lastToolName = '';
    const MAX_CONSECUTIVE_SAME_TOOL = 15; // Increased from 5 - normal coding tasks often need 10+ consecutive Bash calls
    const EMERGENCY_MAX_TURNS = Math.max(this.maxTurns + 10, 50); // Always above maxTurns

    // Track channel key for session release
    const channelKey = buildChannelKey(
      options?.source ?? 'default',
      options?.channelId ?? this.sessionKey
    );

    // Use session pool for conversation continuity
    // IMPORTANT: If caller passes cliSessionId, use it directly to avoid double-locking
    // MessageRouter already calls getSession() and passes the result via options
    let sessionIsNew = options?.resumeSession === undefined ? true : !options.resumeSession;
    let ownedSession = false;

    // Set session ID on the agent (works for both ClaudeCLIWrapper and PersistentCLIAdapter)
    if (options?.cliSessionId) {
      this.agent.setSessionId(options.cliSessionId);
      console.log(
        `[AgentLoop] Using caller session: ${channelKey} → ${options.cliSessionId} (${sessionIsNew ? 'NEW' : 'RESUME'})`
      );
    } else {
      // Fallback: get session from pool (for direct AgentLoop usage)
      const { sessionId: cliSessionId, isNew } = this.sessionPool.getSession(channelKey);
      sessionIsNew = isNew;
      ownedSession = true;
      this.agent.setSessionId(cliSessionId);
      console.log(
        `[AgentLoop] Session pool: ${channelKey} → ${cliSessionId} (${isNew ? 'NEW' : 'RESUME'})`
      );
    }

    try {
      if (options?.systemPrompt) {
        // Skip gateway tools if already embedded in systemPrompt (e.g. by MessageRouter)
        const alreadyHasTools = options.systemPrompt.includes('# Gateway Tools');
        const gatewayToolsPrompt =
          this.isGatewayMode && !alreadyHasTools ? getGatewayToolsPrompt() : '';
        const fullPrompt = gatewayToolsPrompt
          ? `${options.systemPrompt}\n\n---\n\n${gatewayToolsPrompt}`
          : options.systemPrompt;

        // Monitor and enforce prompt size
        const monitor = new PromptSizeMonitor();
        const runLayers: PromptLayer[] = [
          { name: 'systemPrompt', content: options.systemPrompt, priority: 1 },
          ...(gatewayToolsPrompt
            ? [{ name: 'gatewayTools', content: gatewayToolsPrompt, priority: 2 } as PromptLayer]
            : []),
        ];
        const checkResult = monitor.check(runLayers);
        if (checkResult.warning) {
          console.warn(`[AgentLoop] ${checkResult.warning}`);
        }

        let effectivePrompt = fullPrompt;
        if (!checkResult.withinBudget) {
          const { layers: trimmed, result: enforceResult } = monitor.enforce(runLayers);
          if (enforceResult.truncatedLayers.length > 0) {
            console.warn(
              `[AgentLoop] Truncated layers: ${enforceResult.truncatedLayers.join(', ')}`
            );
          }
          const tBase =
            trimmed.find((l) => l.name === 'systemPrompt')?.content || options.systemPrompt;
          const tTools = trimmed.find((l) => l.name === 'gatewayTools')?.content || '';
          effectivePrompt = tTools ? `${tBase}\n\n---\n\n${tTools}` : tBase;
          console.log(
            `[AgentLoop] System prompt truncated: ${fullPrompt.length} → ${effectivePrompt.length} chars`
          );
        }

        console.log(
          `[AgentLoop] Setting systemPrompt: ${effectivePrompt.length} chars (base: ${options.systemPrompt.length}, tools: ${gatewayToolsPrompt.length})`
        );
        this.agent.setSystemPrompt(effectivePrompt);
      } else {
        console.log(`[AgentLoop] No systemPrompt in options, using default`);
      }

      // Reset StopContinuation state for this channel to prevent leaking
      // retry counts from previous invocations
      if (this.stopContinuationHandler) {
        this.stopContinuationHandler.resetChannel(channelKey);
      }

      // Add initial user message with content blocks
      history.push({
        role: 'user',
        content,
      });

      while (turn < this.maxTurns) {
        turn++;

        // Emergency brake: prevent infinite loops
        if (turn >= EMERGENCY_MAX_TURNS) {
          throw new AgentError(
            `Emergency stop: Agent loop exceeded emergency maximum turns (${EMERGENCY_MAX_TURNS})`,
            'EMERGENCY_MAX_TURNS',
            undefined,
            false
          );
        }

        let response: ClaudeResponse;

        const callbacks: StreamCallbacks = {
          onDelta: (text: string) => {
            console.log('[Streaming] Delta received:', text.length, 'chars');
          },
          onToolUse: (name: string, _input: Record<string, unknown>) => {
            console.log(`[Streaming] Tool called: ${name}`);
          },
          onFinal: (_finalResponse: ClaudeResponse) => {
            console.log('[Streaming] Stream complete');
          },
          onError: (error: Error) => {
            console.error('[Streaming] Error:', error);
            // Don't throw - let the promise rejection handle it
          },
        };

        let piResult;
        // Pass role-specific model and resume flag based on session state
        // First turn of new session: --session-id (inject system prompt)
        // Subsequent turns (tool loop) or resumed sessions: --resume (skip system prompt)
        const shouldResume = !sessionIsNew || turn > 1;
        // Persistent CLI preserves context automatically - only send new messages
        // Codex resume also preserves context - send only last message
        // Non-persistent CLI needs full history formatted as prompt
        const promptText =
          this.usePersistentCLI || (this.backend === 'codex' && shouldResume)
            ? this.formatLastMessageOnly(history)
            : this.formatHistoryAsPrompt(history);
        try {
          piResult = await this.agent.prompt(promptText, callbacks, {
            model: options?.model,
            resumeSession: shouldResume,
          });
          // Codex returns its own thread_id; map it into the session pool for continuity
          if (this.backend === 'codex' && piResult.session_id && ownedSession) {
            this.sessionPool.setSessionId(channelKey, piResult.session_id);
            this.agent.setSessionId(piResult.session_id);
          }
          // After first successful call, mark session as not new for subsequent turns
          if (turn === 1) sessionIsNew = false;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`[AgentLoop] ${this.backend} CLI error:`, errorMessage);

          // Check if this is a recoverable session error
          // 1. "No conversation found" - CLI session was lost (daemon restart, timeout)
          // 2. "Session ID already in use" - concurrent request conflict
          // 3. "Prompt is too long" - session context exceeded API limits
          const isSessionNotFound = errorMessage.includes('No conversation found with session ID');
          const isSessionInUse = errorMessage.includes('is already in use');
          const isPromptTooLong =
            errorMessage.includes('Prompt is too long') ||
            errorMessage.includes('prompt is too long') ||
            errorMessage.includes('request_too_large');

          if (isSessionNotFound || isSessionInUse || isPromptTooLong) {
            const reason = isSessionNotFound
              ? 'not found in CLI'
              : isSessionInUse
                ? 'already in use'
                : 'prompt too long (context overflow)';
            console.log(`[AgentLoop] Session ${reason}, retrying with new session`);

            // Reset session in pool so it creates a new one
            this.sessionPool.resetSession(channelKey);
            const newSessionId = this.sessionPool.getSessionId(channelKey);
            this.agent.setSessionId(newSessionId);

            // Retry with new session (--session-id instead of --resume)
            piResult = await this.agent.prompt(promptText, callbacks, {
              model: options?.model,
              resumeSession: false, // Force new session
            });
            // Prepend reset notice so user knows context was lost
            if (isPromptTooLong && piResult.response) {
              piResult.response = `⚠️ 이전 대화가 너무 길어져 새 세션으로 전환되었습니다.\n\n${piResult.response}`;
            }
            console.log(`[AgentLoop] Retry successful with new session: ${newSessionId}`);
          } else {
            throw new AgentError(
              `CLI error: ${errorMessage}`,
              'CLI_ERROR',
              error instanceof Error ? error : undefined,
              true // retryable
            );
          }
        }

        // Build content blocks - include tool_use blocks if present
        const contentBlocks: ContentBlock[] = [];
        let parsedToolCalls: ToolUseBlock[] = [];

        // Parse tool_call blocks from text response (Gateway Tools mode ONLY)
        if (this.isGatewayMode) {
          parsedToolCalls = this.parseToolCallsFromText(piResult.response || '');
          const textWithoutToolCalls = this.removeToolCallBlocks(piResult.response || '');

          if (textWithoutToolCalls.trim()) {
            contentBlocks.push({ type: 'text', text: textWithoutToolCalls });
          }

          // Add parsed tool_use blocks from text (Gateway Tools - prompt-based)
          if (parsedToolCalls.length > 0) {
            for (const toolCall of parsedToolCalls) {
              contentBlocks.push({
                type: 'tool_use',
                id: toolCall.id,
                name: toolCall.name,
                input: toolCall.input,
              } as ToolUseBlock);
            }
            console.log(
              `[AgentLoop] Parsed ${parsedToolCalls.length} tool calls from text (Gateway Tools mode)`
            );
          }
        } else {
          // MCP mode: use response text as-is
          if (piResult.response?.trim()) {
            contentBlocks.push({ type: 'text', text: piResult.response });
          }
        }

        // Add tool_use blocks from Claude CLI if present (MCP mode)
        if ('toolUseBlocks' in piResult && Array.isArray(piResult.toolUseBlocks)) {
          const toolUseBlocks = piResult.toolUseBlocks;
          for (const toolUse of toolUseBlocks) {
            contentBlocks.push({
              type: 'tool_use',
              id: toolUse.id,
              name: toolUse.name,
              input: toolUse.input,
            } as ToolUseBlock);
          }
          console.log(`[AgentLoop] Detected ${toolUseBlocks.length} tool calls from MCP`);
        }

        // Set stop_reason based on whether tools were requested
        // In Gateway mode: check parsed tool calls; in MCP mode: check CLI tool blocks
        const hasToolUse = this.isGatewayMode
          ? parsedToolCalls.length > 0
          : ('hasToolUse' in piResult ? piResult.hasToolUse : false) || false;

        // eslint-disable-next-line prefer-const
        response = {
          id: `msg_${Date.now()}`,
          type: 'message' as const,
          role: 'assistant' as const,
          content: contentBlocks,
          model: this.model,
          stop_reason: hasToolUse ? ('tool_use' as const) : ('end_turn' as const),
          stop_sequence: null,
          usage: piResult.usage,
        };

        // Update usage
        totalUsage.input_tokens += response.usage.input_tokens;
        totalUsage.output_tokens += response.usage.output_tokens;

        // Record token usage
        if (this.onTokenUsage) {
          try {
            this.onTokenUsage({
              channel_key: channelKey,
              agent_id: options?.agentContext?.roleName || this.model, // Use roleName if available, else model
              input_tokens: response.usage.input_tokens,
              output_tokens: response.usage.output_tokens,
              cache_read_tokens: response.usage.cache_read_input_tokens || 0, // No longer needs 'as any' cast
              cost_usd: piResult.cost_usd || 0,
            });
          } catch {
            // Ignore recording errors - never break the agent loop
          }
        }

        // Track tokens in session pool for auto-reset at 80% context
        const tokenStatus = this.sessionPool.updateTokens(channelKey, response.usage.input_tokens);

        // PreCompact: inject compaction summary when approaching context limit
        if (tokenStatus.nearThreshold && this.preCompactHandler && !this.preCompactInjected) {
          this.preCompactInjected = true;
          try {
            const historyText = history.map((msg) => {
              if (typeof msg.content === 'string') return msg.content;
              return (msg.content as ContentBlock[])
                .filter((b): b is TextBlock => b.type === 'text')
                .map((b) => b.text)
                .join('\n');
            });
            const compactResult = await this.preCompactHandler.process(historyText);
            if (compactResult.compactionPrompt) {
              history.push({
                role: 'user',
                content: [{ type: 'text', text: compactResult.compactionPrompt }],
              });
              console.log(
                `[AgentLoop] PreCompact: injected compaction summary (${compactResult.unsavedDecisions.length} unsaved decisions detected)`
              );
            }
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[AgentLoop] PreCompact error (non-blocking):`, message);
          }
        }

        // Add assistant response to history
        history.push({
          role: 'assistant',
          content: response.content,
        });

        // Notify turn callback
        this.onTurn?.({
          turn,
          role: 'assistant',
          content: response.content,
          stopReason: response.stop_reason,
          usage: response.usage,
        });

        stopReason = response.stop_reason;

        // Check stop conditions
        if (response.stop_reason === 'end_turn') {
          // StopContinuation: check if response looks incomplete before breaking
          if (this.stopContinuationHandler) {
            const finalText = this.extractTextFromContent(response.content);
            const decision = this.stopContinuationHandler.analyzeResponse(channelKey, finalText);
            if (decision.shouldContinue && decision.continuationPrompt) {
              console.log(
                `[AgentLoop] StopContinuation: auto-continuing (attempt ${decision.attempt}, reason: ${decision.reason})`
              );
              history.push({
                role: 'user',
                content: [{ type: 'text', text: decision.continuationPrompt }],
              });
              continue;
            }
          }
          break;
        }

        if (response.stop_reason === 'max_tokens') {
          throw new AgentError(
            'Response truncated due to max tokens limit',
            'MAX_TOKENS',
            undefined,
            false
          );
        }

        // Handle tool use
        if (response.stop_reason === 'tool_use') {
          // Check for infinite loop patterns in tool usage
          const toolUseBlocks = response.content.filter(
            (block): block is ToolUseBlock => block.type === 'tool_use'
          );

          if (toolUseBlocks.length > 0) {
            const currentToolName = toolUseBlocks[0].name;

            if (currentToolName === lastToolName) {
              consecutiveToolCalls++;
              if (consecutiveToolCalls >= MAX_CONSECUTIVE_SAME_TOOL) {
                throw new AgentError(
                  `Infinite loop detected: Tool "${currentToolName}" called ${consecutiveToolCalls} times consecutively`,
                  'INFINITE_LOOP_DETECTED',
                  undefined,
                  false
                );
              }
            } else {
              consecutiveToolCalls = 1;
              lastToolName = currentToolName;
            }
          }

          const toolResults = await this.executeTools(response.content);

          // Add tool results to history
          history.push({
            role: 'user',
            content: toolResults,
          });

          // Notify turn callback for tool results
          this.onTurn?.({
            turn,
            role: 'user',
            content: toolResults,
          });
        }
      }

      // Check if we hit max turns
      if (turn >= this.maxTurns && stopReason === 'tool_use') {
        throw new AgentError(
          `Agent loop exceeded maximum turns (${this.maxTurns})`,
          'MAX_TURNS',
          undefined,
          false
        );
      }

      // Extract final text response
      const finalResponse = this.extractTextResponse(history);

      return {
        response: finalResponse,
        turns: turn,
        history,
        totalUsage,
        stopReason,
      };
    } finally {
      // Always release session lock, even on error
      // BUT only if we own the session (not passed by caller)
      if (ownedSession) {
        this.sessionPool.releaseSession(channelKey);
      }
    }
  }

  /**
   * Execute tools from response content blocks
   */
  private async executeTools(content: ContentBlock[]): Promise<ToolResultBlock[]> {
    const toolUseBlocks = content.filter(
      (block): block is ToolUseBlock => block.type === 'tool_use'
    );

    const results: ToolResultBlock[] = [];

    for (const toolUse of toolUseBlocks) {
      let result: string;
      let isError = false;

      try {
        // PreToolUse: search MAMA for contracts before Write operations
        let contractContext = '';
        if (toolUse.name === 'Write' && toolUse.input) {
          contractContext = await this.searchContractsForTool(
            toolUse.name,
            toolUse.input as GatewayToolInput
          );
        }

        const toolResult = await this.mcpExecutor.execute(
          toolUse.name,
          toolUse.input as GatewayToolInput
        );
        result = JSON.stringify(toolResult, null, 2);

        if (contractContext) {
          result = `${contractContext}\n\n---\n\n${result}`;
        }

        // Notify tool use callback
        this.onToolUse?.(toolUse.name, toolUse.input, toolResult);

        // PostToolUse: auto-extract contracts (fire-and-forget)
        this.postToolHandler?.processInBackground(toolUse.name, toolUse.input, toolResult);
      } catch (error) {
        isError = true;
        result = error instanceof Error ? error.message : String(error);

        // Notify tool use callback with error
        this.onToolUse?.(toolUse.name, toolUse.input, { error: result });
      }

      results.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: result,
        is_error: isError,
      });
    }

    return results;
  }

  /**
   * Search MAMA for contracts related to a tool operation.
   * Used as PreToolUse interceptor — searches for contract_* topics
   * related to the file being written/edited.
   *
   * Non-blocking: returns empty string if search fails or no contracts found.
   */
  private async searchContractsForTool(
    _toolName: string,
    input: GatewayToolInput
  ): Promise<string> {
    try {
      const filePath = (input as { path?: string }).path;
      if (!filePath) {
        return '';
      }

      const fileName = filePath.split('/').pop() || filePath;
      const searchQuery = `contract ${fileName}`;

      const searchResult = await this.mcpExecutor.execute('mama_search', {
        query: searchQuery,
        limit: 3,
      });

      if (searchResult && typeof searchResult === 'object' && 'results' in searchResult) {
        const typedResult = searchResult as {
          results: Array<{ topic?: string; decision?: string; confidence?: number }>;
        };
        const contractResults = typedResult.results.filter((r) => r.topic?.startsWith('contract_'));

        if (contractResults.length > 0) {
          const lines = contractResults.map(
            (r) => `- **${r.topic}**: ${r.decision} (confidence: ${r.confidence ?? 'unknown'})`
          );
          return (
            `## PreToolUse: Related Contracts Found\n\n` +
            `Before writing to \`${fileName}\`, review these existing contracts:\n\n` +
            `${lines.join('\n')}\n\n` +
            `Ensure your changes are consistent with these contracts.`
          );
        }
      }

      return '';
    } catch {
      // Non-blocking: silently return empty on any error
      return '';
    }
  }

  /**
   * Parse tool_call blocks from text response (Gateway Tools mode)
   * Format: ```tool_call\n{"name": "...", "input": {...}}\n```
   */
  private parseToolCallsFromText(text: string): ToolUseBlock[] {
    const toolCalls: ToolUseBlock[] = [];
    const toolCallRegex = /```tool_call\s*\n([\s\S]*?)\n```/g;

    let match;
    while ((match = toolCallRegex.exec(text)) !== null) {
      try {
        const jsonStr = match[1].trim();
        const parsed = JSON.parse(jsonStr);

        if (parsed.name && typeof parsed.name === 'string') {
          toolCalls.push({
            type: 'tool_use',
            id: `gateway_tool_${randomUUID()}`,
            name: parsed.name,
            input: parsed.input || {},
          });
        }
      } catch (e) {
        console.warn(`[AgentLoop] Failed to parse tool_call block: ${e}`);
      }
    }

    return toolCalls;
  }

  /**
   * Remove tool_call blocks from text (to avoid duplication in response)
   */
  private removeToolCallBlocks(text: string): string {
    return text.replace(/```tool_call\s*\n[\s\S]*?\n```/g, '').trim();
  }

  private extractTextFromContent(content: ContentBlock[]): string {
    return content
      .filter((block): block is TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  }

  /**
   * Extract text response from the last assistant message
   */
  private extractTextResponse(history: Message[]): string {
    // Find the last assistant message
    for (let i = history.length - 1; i >= 0; i--) {
      const message = history[i];
      if (message.role === 'assistant') {
        const content = message.content;

        if (typeof content === 'string') {
          return content;
        }

        // Extract text blocks
        const textBlocks = (content as ContentBlock[]).filter(
          (block): block is TextBlock => block.type === 'text'
        );

        return textBlocks.map((block) => block.text).join('\n');
      }
    }

    return '';
  }

  /**
   * Format conversation history as prompt text for Claude CLI
   * Note: Claude CLI -p mode only supports text, so images are converted to file paths
   * that Claude Code can read using the Read tool.
   */
  private formatHistoryAsPrompt(history: Message[]): string {
    return history
      .map((msg) => {
        const content = msg.content;
        let text: string;

        if (typeof content === 'string') {
          text = content;
        } else if (Array.isArray(content)) {
          const parts: string[] = [];

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          for (const block of content as any[]) {
            if (block.type === 'text') {
              parts.push(block.text);
            } else if (block.type === 'tool_use') {
              // Format tool_use block for Claude to see its previous tool calls
              parts.push(
                `[Tool Call: ${block.name}]\nInput: ${JSON.stringify(block.input, null, 2)}`
              );
            } else if (block.type === 'tool_result') {
              // Format tool_result block for Claude to see tool execution results
              const status = block.is_error ? 'ERROR' : 'SUCCESS';
              parts.push(`[Tool Result: ${status}]\n${block.content}`);
            } else if (block.type === 'image') {
              if (block.localPath) {
                parts.push(
                  `⚠️ CRITICAL: The user has uploaded an image file.\n` +
                    `Image path: ${block.localPath}\n` +
                    `You MUST call the Read tool on "${block.localPath}" to view this image FIRST.\n` +
                    `DO NOT describe or guess the image contents without reading it.\n` +
                    `DO NOT say you cannot read images - the Read tool supports image files.`
                );
              } else if (block.source?.data) {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const fs = require('fs');
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const path = require('path');
                const mediaDir = path.join(homedir(), '.mama', 'workspace', 'media', 'inbound');
                fs.mkdirSync(mediaDir, { recursive: true });
                // Map MIME type to file extension (support PNG, JPEG, GIF, WebP)
                const mimeToExt: Record<string, string> = {
                  'image/png': '.png',
                  'image/jpeg': '.jpg',
                  'image/jpg': '.jpg',
                  'image/gif': '.gif',
                  'image/webp': '.webp',
                };
                const ext = mimeToExt[block.source.media_type?.toLowerCase() || ''] || '.jpg';
                const imagePath = path.join(
                  mediaDir,
                  `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`
                );
                try {
                  fs.writeFileSync(imagePath, Buffer.from(block.source.data, 'base64'));
                  parts.push(
                    `⚠️ CRITICAL: The user has uploaded an image file.\n` +
                      `Image path: ${imagePath}\n` +
                      `You MUST call the Read tool on "${imagePath}" to view this image FIRST.\n` +
                      `DO NOT describe or guess the image contents without reading it.\n` +
                      `DO NOT say you cannot read images - the Read tool supports image files.`
                  );
                } catch {
                  parts.push('[Image attached but could not be processed]');
                }
              }
            }
          }

          text = parts.join('\n');
        } else {
          return '';
        }

        if (msg.role === 'user') {
          return `User: ${text}`;
        } else if (msg.role === 'assistant') {
          return `Assistant: ${text}`;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n\n');
  }

  /**
   * Format only the last user message for persistent CLI
   * Persistent CLI maintains context automatically, so we only send the new message
   */
  private formatLastMessageOnly(history: Message[]): string {
    // Find the last user message in the history
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      if (msg.role === 'user') {
        const content = msg.content;
        let text: string;

        if (typeof content === 'string') {
          text = content;
        } else if (Array.isArray(content)) {
          const parts: string[] = [];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          for (const block of content as any[]) {
            if (block.type === 'text') {
              parts.push(block.text);
            } else if (block.type === 'image' && block.localPath) {
              parts.push(
                `⚠️ CRITICAL: The user has uploaded an image file.\n` +
                  `Image path: ${block.localPath}\n` +
                  `You MUST call the Read tool on "${block.localPath}" to view this image FIRST.\n` +
                  `DO NOT describe or guess the image contents without reading it.\n` +
                  `DO NOT say you cannot read images - the Read tool supports image files.`
              );
            } else if (block.type === 'image' && block.source?.data) {
              // Base64-encoded image — save to disk so persistent CLI can read it
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const fs = require('fs');
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const path = require('path');
              const mediaDir = path.join(homedir(), '.mama', 'workspace', 'media', 'inbound');
              fs.mkdirSync(mediaDir, { recursive: true });
              // Map MIME type to file extension (support PNG, JPEG, GIF, WebP)
              const mimeToExt: Record<string, string> = {
                'image/png': '.png',
                'image/jpeg': '.jpg',
                'image/jpg': '.jpg',
                'image/gif': '.gif',
                'image/webp': '.webp',
              };
              const ext = mimeToExt[block.source.media_type?.toLowerCase() || ''] || '.jpg';
              const imagePath = path.join(
                mediaDir,
                `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`
              );
              try {
                fs.writeFileSync(imagePath, Buffer.from(block.source.data, 'base64'));
                parts.push(
                  `⚠️ CRITICAL: The user has uploaded an image file.\n` +
                    `Image path: ${imagePath}\n` +
                    `You MUST call the Read tool on "${imagePath}" to view this image FIRST.\n` +
                    `DO NOT describe or guess the image contents without reading it.\n` +
                    `DO NOT say you cannot read images - the Read tool supports image files.`
                );
              } catch {
                parts.push('[Image attached but could not be processed]');
              }
            } else if (block.type === 'tool_result') {
              const status = block.is_error ? 'ERROR' : 'SUCCESS';
              parts.push(`[Tool Result: ${status}]\n${block.content}`);
            } else if (block.type === 'tool_use') {
              parts.push(
                `[Tool Call: ${block.name}]\nInput: ${JSON.stringify(block.input, null, 2)}`
              );
            }
          }
          text = parts.join('\n');
        } else {
          text = '';
        }

        return text;
      }
    }
    // Fallback: if no user message found, return empty string
    return '';
  }

  /**
   * Get the MAMA tool definitions
   */
  static getToolDefinitions(): ToolDefinition[] {
    return [];
  }

  /**
   * Get the default system prompt (verbose logging)
   */
  static getDefaultSystemPrompt(): string {
    return loadSystemPrompt(true);
  }

  /**
   * Stop and cleanup the AgentLoop resources
   */
  private stopped = false;

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;

    try {
      // Stop persistent CLI if it exists
      if (this.persistentCLI?.stopAll) {
        this.persistentCLI.stopAll();
      }

      // NOTE: sessionPool is a shared global singleton — do NOT dispose here.
      // It will be cleaned up when the process exits or via a global shutdown handler.

      // Lane manager doesn't have explicit stop method
      // Let it be cleaned up by garbage collection
    } catch (error) {
      console.error('Error during AgentLoop cleanup:', error);
    }
  }
}
