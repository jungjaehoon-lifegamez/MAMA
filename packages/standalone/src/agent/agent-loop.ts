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

import { readFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { PromptSizeMonitor } from './prompt-size-monitor.js';
import type { PromptLayer } from './prompt-size-monitor.js';
import { CodexMCPProcess } from './codex-mcp-process.js';
import { PersistentCLIAdapter } from './persistent-cli-adapter.js';
import { GatewayToolExecutor } from './gateway-tool-executor.js';
import {
  CodeActSandbox,
  HostBridge,
  TypeDefinitionGenerator,
  getCodeActInstructions,
  CODE_ACT_MARKER,
} from './code-act/index.js';
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
function loadSystemPrompt(verbose = false): string {
  const searchPaths = [
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

// ─── Skill On-Demand Injection ───────────────────────────────────────────────

/**
 * Parse YAML frontmatter from skill .md file
 */
function parseSkillFrontmatter(content: string): {
  name: string;
  description: string;
  keywords: string[];
} {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { name: '', description: '', keywords: [] };
  const block = match[1];
  const name = (block.match(/^name:\s*(.+)$/m)?.[1] ?? '').trim();
  const description = (block.match(/^description:\s*(.+)$/m)?.[1] ?? '').trim();
  const kwBlock = block.match(/^keywords:\n((?:[ \t]+-[ \t]*.+\n?)+)/m);
  const keywords = kwBlock
    ? kwBlock[1]
        .trim()
        .split('\n')
        .map((l) => l.replace(/^[ \t]*-[ \t]*/, '').trim())
        .filter((k) => k.length > 0)
    : [];
  return { name, description, keywords };
}

/**
 * Find the main .md file for a directory skill (for frontmatter parsing)
 */
function findMainSkillFile(skillDir: string, skillName: string): string | null {
  for (const name of [`${skillName}.md`, 'skill.md', 'index.md']) {
    const p = join(skillDir, name);
    if (existsSync(p)) return p;
  }
  try {
    const entries = readdirSync(skillDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.md') && !EXCLUDED_SKILL_FILES.has(e.name)) {
        return join(skillDir, e.name);
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Build skill catalog (one line per enabled skill) for system prompt.
 * Format: "- [source/skillId] keywords: kw1, kw2 | description"
 */
function buildSkillCatalog(verbose = false): string[] {
  const skillsBase = join(homedir(), '.mama', 'skills');
  const stateFile = join(skillsBase, 'state.json');
  const catalog: string[] = [];

  let state: Record<string, { enabled: boolean }> = {};
  try {
    if (existsSync(stateFile)) {
      state = JSON.parse(readFileSync(stateFile, 'utf-8'));
    }
  } catch {
    /* no state file */
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
        if (state[stateKey]?.enabled === false) continue;

        const skillDir = join(sourceDir, entry.name);
        const mainFile = findMainSkillFile(skillDir, entry.name);
        if (!mainFile) continue;

        try {
          const content = readFileSync(mainFile, 'utf-8');
          const fm = parseSkillFrontmatter(content);
          const description = fm.description || '';
          const keywords = fm.keywords.length > 0 ? fm.keywords.join(', ') : entry.name;
          catalog.push(`- [${stateKey}] keywords: ${keywords} | ${description}`);
          if (verbose) console.log(`[AgentLoop] Skill catalog: ${stateKey}`);
        } catch {
          /* skip unreadable */
        }
      }
    } catch {
      /* directory read failed */
    }
  }

  // Flat .md files at root
  try {
    const rootEntries = readdirSync(skillsBase, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      if (EXCLUDED_SKILL_FILES.has(entry.name)) continue;

      const id = entry.name.replace(/\.md$/, '');
      const stateKey = `mama/${id}`;
      if (state[stateKey]?.enabled === false) continue;
      if (catalog.some((l) => l.includes(`[${stateKey}]`))) continue;

      try {
        const content = readFileSync(join(skillsBase, entry.name), 'utf-8');
        const fm = parseSkillFrontmatter(content);
        const description = fm.description || '';
        const keywords = fm.keywords.length > 0 ? fm.keywords.join(', ') : id;
        catalog.push(`- [${stateKey}] keywords: ${keywords} | ${description}`);
        if (verbose) console.log(`[AgentLoop] Skill catalog (flat): ${stateKey}`);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* root directory read failed */
  }

  return catalog;
}

/**
 * Load full skill content on-demand for per-message injection.
 * @param skillId - Skill identifier like "mama/playground"
 */
export function loadSkillContent(skillId: string): string | null {
  const skillsBase = join(homedir(), '.mama', 'skills');

  // Try directory skill first
  const skillDir = join(skillsBase, skillId);
  if (existsSync(skillDir)) {
    const mdFiles = collectMarkdownFiles(skillDir);
    if (mdFiles.length > 0) {
      const parts = mdFiles.map((f) => `## ${f.path}\n\n${f.content}`);
      return `# [Skill: ${skillId}]\n\n${parts.join('\n\n---\n\n')}`;
    }
  }

  // Try flat .md file: "mama/playground" → skills/playground.md
  const idParts = skillId.split('/');
  if (idParts.length >= 2) {
    const flatPath = join(skillsBase, `${idParts[idParts.length - 1]}.md`);
    if (existsSync(flatPath)) {
      try {
        return readFileSync(flatPath, 'utf-8');
      } catch {
        /* skip */
      }
    }
  }

  return null;
}

/**
 * Load installed & enabled skills from ~/.mama/skills/
 * Returns skill catalog lines for system prompt injection (on-demand mode).
 * Full skill content is injected per-message via detectSkillMatch() in PromptEnhancer.
 */
export function loadInstalledSkills(
  verbose = false,
  _options: { onlyCommands?: boolean } = {}
): string[] {
  return buildSkillCatalog(verbose);
}

/**
 * Load backend-specific AGENTS.md from ~/.mama/
 * Maps backend to file: 'claude' → AGENTS.claude.md, 'codex-mcp' → AGENTS.codex.md
 */
export function loadBackendAgentsMd(backend?: string, verbose = false): string {
  if (!backend) return '';
  const keyMap: Record<string, string> = {
    claude: 'claude',
    'codex-mcp': 'codex',
  };
  const key = keyMap[backend];
  if (!key) return '';
  const filePath = join(homedir(), '.mama', `AGENTS.${key}.md`);
  if (existsSync(filePath)) {
    if (verbose) console.log(`[AgentLoop] Loaded backend AGENTS.md: AGENTS.${key}.md`);
    return readFileSync(filePath, 'utf-8');
  }
  if (verbose) console.log(`[AgentLoop] Backend AGENTS.md not found: AGENTS.${key}.md`);
  return '';
}

export function loadComposedSystemPrompt(verbose = false, context?: AgentContext): string {
  const mamaHome = join(homedir(), '.mama');
  const layers: string[] = [];

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
  const personaFiles = ['SOUL.md', 'IDENTITY.md', 'USER.md'];
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

  // Load skill catalog (on-demand mode — full content injected per-message by PromptEnhancer)
  const skillCatalog = loadInstalledSkills(verbose);
  if (skillCatalog.length > 0) {
    const skillDirective = [
      '# Installed Skills',
      '',
      'To invoke a skill, include its keywords in your message.',
      'The full skill instructions will be injected automatically when matched.',
      '',
      ...skillCatalog,
    ].join('\n');
    layers.push(skillDirective);
    if (verbose) console.log(`[AgentLoop] Skill catalog: ${skillCatalog.length} skills`);
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

  // Load backend-specific AGENTS.md (e.g., AGENTS.claude.md, AGENTS.codex.md)
  const backendAgentsMd = loadBackendAgentsMd(context?.backend, verbose);
  if (backendAgentsMd) {
    layers.push(backendAgentsMd);
  }

  // Load CLAUDE.md (base instructions)
  const claudeMd = loadSystemPrompt(verbose);
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
  private readonly agent: PersistentCLIAdapter | CodexMCPProcess;
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
  private readonly useCodeAct: boolean;
  private readonly backend: 'claude' | 'codex-mcp';
  private readonly postToolHandler: PostToolHandler | null;
  private readonly stopContinuationHandler: StopContinuationHandler | null;
  private readonly preCompactHandler: PreCompactHandler | null;
  private preCompactInjected = false;
  private currentStreamCallbacks?: StreamCallbacks;
  private currentTier: 1 | 2 | 3 = 1;

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
    this.useCodeAct = options.useCodeAct ?? false;

    if (useGatewayMode && useMCPMode) {
      logger.debug('🔀 Hybrid mode: Gateway + MCP tools enabled');
    } else if (useMCPMode) {
      logger.debug('🔌 MCP-only mode');
    } else {
      logger.debug('⚙️ Gateway-only mode');
    }

    // Build system prompt with layered truncation support
    const monitor = new PromptSizeMonitor();
    let promptLayers: PromptLayer[];

    if (options.systemPrompt) {
      // Custom system prompt (e.g., multi-agent): treat as a single critical layer
      promptLayers = [{ name: 'custom', content: options.systemPrompt, priority: 1 }];
    } else {
      // Composed prompt: build layers with individual priorities for graceful truncation
      // Priority 1 (never cut): CLAUDE.md base instructions
      // Priority 2 (cut if extreme): personas (SOUL, IDENTITY, USER) + gateway tools
      // Priority 3 (cut first): context prompt + skills + onboarding
      const mamaHome = join(homedir(), '.mama');
      const claudeMd = loadSystemPrompt();
      const personaFiles = ['SOUL.md', 'IDENTITY.md', 'USER.md'];
      const personaParts: string[] = [];
      for (const file of personaFiles) {
        const p = join(mamaHome, file);
        if (existsSync(p)) personaParts.push(readFileSync(p, 'utf-8'));
      }
      const skillCatalog = loadInstalledSkills();
      const onboardingPath = join(mamaHome, 'ONBOARDING.md');
      const onboardingContent = existsSync(onboardingPath)
        ? readFileSync(onboardingPath, 'utf-8')
        : '';

      promptLayers = [
        { name: 'claudeMd', content: claudeMd, priority: 1 },
        ...(personaParts.length > 0
          ? [
              {
                name: 'personas',
                content: personaParts.join('\n\n---\n\n'),
                priority: 2,
              } as PromptLayer,
            ]
          : []),
        ...(skillCatalog.length > 0
          ? [
              {
                name: 'skills',
                content: [
                  '# Installed Skills',
                  '',
                  'To invoke a skill, include its keywords in your message.',
                  '',
                  ...skillCatalog,
                ].join('\n'),
                priority: 3,
              } as PromptLayer,
            ]
          : []),
        ...(onboardingContent
          ? [{ name: 'onboarding', content: onboardingContent, priority: 4 } as PromptLayer]
          : []),
      ];
    }

    const backend = options.backend ?? 'claude';
    if (useGatewayMode) {
      if (this.useCodeAct) {
        // Code-Act mode: replace verbose gateway tools markdown with compact .d.ts
        const typeDefs = TypeDefinitionGenerator.generate(options.agentContext?.tier ?? 1);
        const codeActBackend = backend === 'codex-mcp' ? 'codex-mcp' : ('claude' as const);
        const codeActPrompt =
          getCodeActInstructions(codeActBackend) + '\n```typescript\n' + typeDefs + '\n```';
        promptLayers.push({ name: 'codeAct', content: codeActPrompt, priority: 2 });
      } else {
        const gatewayToolsPrompt = getGatewayToolsPrompt();
        if (gatewayToolsPrompt) {
          promptLayers.push({ name: 'gatewayTools', content: gatewayToolsPrompt, priority: 2 });
        }
      }
    }

    const checkResult = monitor.check(promptLayers);
    if (checkResult.warning) {
      logger.warn(checkResult.warning);
    }
    // Enforce truncation if over budget (priority > 1 layers trimmed first)
    if (!checkResult.withinBudget) {
      const { layers: trimmedLayers, result: enforceResult } = monitor.enforce(promptLayers);
      if (enforceResult.truncatedLayers.length > 0) {
        logger.warn(`Truncated layers: ${enforceResult.truncatedLayers.join(', ')}`);
      }
      promptLayers = trimmedLayers;
      logger.debug(
        `System prompt truncated: ${checkResult.totalChars} → ${enforceResult.totalChars} chars`
      );
    }

    const defaultSystemPrompt = promptLayers
      .filter((l) => l.content.length > 0)
      .map((l) => l.content)
      .join('\n\n---\n\n');

    // Choose backend (default: claude)
    this.backend = options.backend!;

    if (this.backend === 'codex-mcp') {
      // Codex MCP mode: standard MCP protocol
      const workspaceDir = join(homedir(), '.mama', 'workspace');
      // Ensure workspace directory exists
      if (!existsSync(workspaceDir)) {
        mkdirSync(workspaceDir, { recursive: true });
      }
      this.agent = new CodexMCPProcess({
        model: options.model,
        cwd: workspaceDir,
        sandbox: 'workspace-write',
        systemPrompt: defaultSystemPrompt,
        compactPrompt:
          'Summarize the conversation concisely, preserving key decisions and context.',
        timeoutMs: options.timeoutMs,
        codexHome: join(homedir(), '.mama', '.codex'),
      });
      logger.debug('Codex MCP backend enabled');
    } else {
      // Claude backend: always use PersistentCLI for fast responses (~2-3s vs ~16-30s)
      this.persistentCLI = new PersistentCLIAdapter({
        model: options.model!,
        sessionId,
        systemPrompt: defaultSystemPrompt,
        // Code-Act mode: empty MCP config + strict to block all auto-discovered MCP servers
        // Hybrid mode: pass MCP config even with Gateway tools enabled
        // Code-Act mode: keep MCP servers available (slack, notion, etc.)
        mcpConfigPath: useMCPMode ? mcpConfigPath : undefined,
        // MAMA OS is a headless daemon (no TTY) — Claude CLI's interactive permission prompts
        // cannot work. Security is enforced by MAMA's own RoleManager layer (config.yaml roles).
        // DO NOT gate this on env vars — MAMA manages permissions via its config, not Claude CLI.
        dangerouslySkipPermissions: options.dangerouslySkipPermissions ?? false,
        // Gateway tools are processed by GatewayToolExecutor (hybrid with MCP)
        useGatewayTools: useGatewayMode,
        // Code-Act: available as optional tool alongside direct tools (no disallowedTools)
        disallowedTools: undefined,
        // Pass configured timeout (default in PersistentCLI: 120s — too short for complex tasks)
        requestTimeout: options.timeoutMs,
      });
      this.agent = this.persistentCLI;
      logger.debug('🚀 Claude PersistentCLI mode enabled - faster responses');
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
    this.model = options.model!;
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

  private resolveGlobalLaneForSession(sessionKey: string): string | undefined {
    const key = sessionKey.toLowerCase();
    // Don't let background cron runs block interactive chat.
    if (key.startsWith('cron:')) {
      return 'cron';
    }
    return undefined;
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
      const globalLane = this.resolveGlobalLaneForSession(this.sessionKey);
      return this.laneManager.enqueueWithSession(
        this.sessionKey,
        () => this.runWithContentInternal(content, options),
        globalLane
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
      const globalLane = this.resolveGlobalLaneForSession(sessionKey);
      return this.laneManager.enqueueWithSession(
        sessionKey,
        () => this.runWithContentInternal(content, options),
        globalLane
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
    this.currentStreamCallbacks = options?.streamCallbacks;
    const history: Message[] = [];
    const totalUsage = { input_tokens: 0, output_tokens: 0 };
    let turn = 0;
    let stopReason: ClaudeResponse['stop_reason'] = 'end_turn';

    // Propagate agentContext to executor for tier-aware tool permissions
    if (options?.agentContext) {
      this.mcpExecutor.setAgentContext(options.agentContext);
      const rawTier = options.agentContext.tier ?? 1;
      this.currentTier = (rawTier === 1 || rawTier === 2 || rawTier === 3 ? rawTier : 1) as
        | 1
        | 2
        | 3;
    }

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

    // Set session ID on the agent
    // Claude PersistentCLI: process alive → CONTINUE (stdin message), process dead → NEW (spawn with --session-id)
    // Codex: threadId alive → CONTINUE (codex-reply), threadId null → NEW (codex tool)
    const isCodex = this.backend === 'codex-mcp';

    const sessionLabel = (isNew: boolean): string => {
      if (isCodex) {
        return isNew ? 'NEW thread' : 'CONTINUE thread';
      }
      return isNew ? 'NEW process' : 'CONTINUE session';
    };

    if (options?.cliSessionId) {
      this.agent.setSessionId(options.cliSessionId);
      console.log(
        `[AgentLoop] [${isCodex ? 'codex' : 'claude'}] ${channelKey} (${sessionLabel(sessionIsNew)})`
      );
    } else {
      // Fallback: get session from pool (for direct AgentLoop usage)
      // getSession() returns immediately - if busy, we create a new session
      const { sessionId: cliSessionId, isNew, busy } = this.sessionPool.getSession(channelKey);
      if (busy) {
        console.log(`[AgentLoop] Session busy for ${channelKey}, will be queued by Lane`);
      }
      sessionIsNew = isNew;
      ownedSession = true;
      this.agent.setSessionId(cliSessionId);
      console.log(
        `[AgentLoop] [${isCodex ? 'codex' : 'claude'}] ${channelKey} (${sessionLabel(isNew)})`
      );
    }

    try {
      if (options?.systemPrompt) {
        // Skip gateway tools if already embedded in systemPrompt (e.g. by MessageRouter)
        const alreadyHasTools =
          options.systemPrompt.includes('## Gateway Tools') ||
          options.systemPrompt.includes('# Code Execution');
        let gatewayToolsPrompt = '';
        const isResumingSession = options?.resumeSession === true;
        if (this.isGatewayMode && !alreadyHasTools && !isResumingSession) {
          if (this.useCodeAct) {
            const typeDefs = TypeDefinitionGenerator.generate(options?.agentContext?.tier ?? 1);
            const codeActBackend = this.backend === 'codex-mcp' ? 'codex-mcp' : ('claude' as const);
            gatewayToolsPrompt =
              getCodeActInstructions(codeActBackend) + '\n```typescript\n' + typeDefs + '\n```';
          } else {
            gatewayToolsPrompt = getGatewayToolsPrompt();
          }
        }
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

        const ext = this.currentStreamCallbacks;
        const callbacks: StreamCallbacks = {
          onDelta: (text: string) => {
            ext?.onDelta?.(text);
          },
          onToolUse: (name: string, input: Record<string, unknown>) => {
            ext?.onToolUse?.(name, input);
          },
          onFinal: (finalResponse: ClaudeResponse) => {
            ext?.onFinal?.(finalResponse);
          },
          onError: (error: Error) => {
            ext?.onError?.(error);
          },
        };

        let piResult;
        // Claude: First turn → --session-id (inject system prompt), subsequent → --resume
        // Codex: resumeSession only controls threadId reset (false=new thread, true=continue)
        const shouldResume = !sessionIsNew || turn > 1;
        // Both Claude PersistentCLI and Codex MCP preserve context - only send new messages
        const promptText = this.formatLastMessageOnly(history);
        try {
          piResult = await this.agent.prompt(promptText, callbacks, {
            model: options?.model,
            resumeSession: shouldResume,
          });
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
            const newSessionId = this.sessionPool.resetSession(channelKey);
            this.agent.setSessionId(newSessionId);

            // Retry with new session (--session-id instead of --resume)
            piResult = await this.agent.prompt(promptText, callbacks, {
              model: options?.model,
              resumeSession: false, // Force new session
            });
            // Prepend reset notice so user knows context was lost
            if (isPromptTooLong && piResult.response) {
              piResult.response = `⚠️ Session reset: The previous conversation was too long, starting a new session.\n⚠️ 이전 대화가 너무 길어져 새 세션으로 전환되었습니다.\n\n${piResult.response}`;
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

        // Parse tool_call / code_act blocks from text response (Gateway Tools mode ONLY)
        if (this.isGatewayMode) {
          parsedToolCalls = this.parseToolCallsFromText(piResult.response || '');

          // Code-Act: parse ```js blocks only if enabled
          if (this.useCodeAct) {
            const codeActCalls = this.parseCodeActBlocks(piResult.response || '');
            if (codeActCalls.length > 0) {
              parsedToolCalls.push(...codeActCalls);
            }
          }

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
        const tokenStatus = this.sessionPool.updateTokens(
          channelKey,
          response.usage.input_tokens,
          this.backend
        );

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
      this.currentStreamCallbacks = undefined;
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

      // Notify stream: tool execution starting
      this.currentStreamCallbacks?.onToolUse?.(
        toolUse.name,
        toolUse.input as Record<string, unknown>
      );

      try {
        // Code-Act: execute JS code in sandbox
        if (toolUse.name === CODE_ACT_MARKER) {
          const codeActResult = await this.executeCodeAct(
            (toolUse.input as { code: string }).code,
            this.currentTier
          );
          result = JSON.stringify(codeActResult, null, 2);
          if (!codeActResult.success) {
            isError = true;
          }
          this.onToolUse?.(toolUse.name, toolUse.input, codeActResult);
          this.currentStreamCallbacks?.onToolComplete?.(toolUse.name, toolUse.id, isError);
        } else {
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

          // Check if tool execution failed
          const hasSuccess = 'success' in toolResult;
          const toolFailed = hasSuccess && !toolResult.success;
          if (toolFailed) {
            isError = true;
          }

          if (contractContext) {
            result = `${contractContext}\n\n---\n\n${result}`;
          }

          // Notify tool use callback
          this.onToolUse?.(toolUse.name, toolUse.input, toolResult);

          // PostToolUse: auto-extract contracts (fire-and-forget)
          this.postToolHandler?.processInBackground(toolUse.name, toolUse.input, toolResult);

          // Notify stream: tool completed (check actual status)
          this.currentStreamCallbacks?.onToolComplete?.(toolUse.name, toolUse.id, isError);
        }
      } catch (error) {
        isError = true;
        result = error instanceof Error ? error.message : String(error);

        // Notify tool use callback with error
        this.onToolUse?.(toolUse.name, toolUse.input, { error: result });

        // Notify stream: tool completed with error
        this.currentStreamCallbacks?.onToolComplete?.(toolUse.name, toolUse.id, true);
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
   * Parse ```js code blocks as code_act tool calls (Code-Act mode)
   */
  private parseCodeActBlocks(text: string): ToolUseBlock[] {
    const blocks: ToolUseBlock[] = [];
    const codeActRegex = /```(?:js|javascript)\s*\n([\s\S]*?)\n```/g;

    let match;
    while ((match = codeActRegex.exec(text)) !== null) {
      const code = match[1].trim();
      if (code) {
        blocks.push({
          type: 'tool_use',
          id: `code_act_${randomUUID()}`,
          name: CODE_ACT_MARKER,
          input: { code },
        });
      }
    }

    return blocks;
  }

  /**
   * Execute Code-Act JS code in a sandboxed QuickJS environment
   */
  private async executeCodeAct(
    code: string,
    tier: 1 | 2 | 3 = 1
  ): Promise<import('./code-act/types.js').ExecutionResult> {
    try {
      const sandbox = new CodeActSandbox();
      const bridge = new HostBridge(this.mcpExecutor);
      bridge.injectInto(sandbox, tier);

      const result = await sandbox.execute(code);

      if (result.logs.length > 0) {
        console.log(`[CodeAct] console output: ${result.logs.join('\n')}`);
      }

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[CodeAct] Sandbox initialization failed: ${message}`);
      return {
        success: false,
        error: {
          name: 'SandboxError',
          message: `Failed to initialize Code-Act sandbox: ${message}`,
        },
        logs: [],
        metrics: { durationMs: 0, hostCallCount: 0, memoryUsedBytes: 0 },
      };
    }
  }

  /**
   * Remove tool_call and code_act blocks from text (to avoid duplication in response)
   */
  private removeToolCallBlocks(text: string): string {
    return text
      .replace(/```tool_call\s*\n[\s\S]*?\n```/g, '')
      .replace(/```(?:js|javascript)\s*\n[\s\S]*?\n```/g, '')
      .trim();
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
