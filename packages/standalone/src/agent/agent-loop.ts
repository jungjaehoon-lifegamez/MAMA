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

import { readFileSync, existsSync, mkdirSync } from 'fs';
import { PromptSizeMonitor } from './prompt-size-monitor.js';
import type { PromptLayer } from './prompt-size-monitor.js';
import { filterSkillCatalogForContext, loadInstalledSkills } from './skill-loader.js';
import { PersistentCLIAdapter } from './persistent-cli-adapter.js';
import { CodexRuntimeProcess } from '../multi-agent/runtime-process.js';
import type { HostToolBridge, HostToolCall, IModelRunner } from './model-runner.js';
import { GatewayToolExecutor } from './gateway-tool-executor.js';
import { envelopeExpired } from '../envelope/run-guard.js';
import { ToolRegistry } from './tool-registry.js';
import {
  TypeDefinitionGenerator,
  getCodeActInstructions,
  projectCodeActToolPolicy,
  requireCodeActTier,
  CODE_ACT_MARKER,
  type CodeActToolPolicy,
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
  BeginModelRunInput,
  StreamCallbacks,
  AgentContext,
  PromptFinalResponse,
  GatewayExecutionSurface,
  GatewayToolExecutionContext,
  BackgroundTaskRegistry,
} from './types.js';
import { AgentError } from './types.js';
import { buildMinimalContext } from './context-prompt-builder.js';
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

const SOURCE_GLOBAL_LANES: Record<string, string> = {
  viewer: 'viewer',
  system: 'system',
  // Operator work (scheduled reports, briefed worker runs) serializes among
  // itself but must not block owner chat on 'main': a 260s full report was
  // measurably blocking chat replies before this lane existed. Safe only
  // because per-run state is scoped (RunScope), not instance state.
  operator: 'operator',
};

/**
 * Per-run mutable state threaded through a single runWithContentInternal
 * invocation. MUST stay run-local: with the operator global lane, a report or
 * worker run legally overlaps chat turns on the same AgentLoop instance.
 */
interface RunScope {
  streamCallbacks?: StreamCallbacks;
  tier: 1 | 2 | 3;
  /** Per-run turn/tool observers (options-first; instance handlers are the
   *  shared fallback). Instance-only handlers caused cross-run reasoning-log
   *  contamination once operator runs could overlap chat (review M2). */
  onTurn?: (turn: TurnInfo) => void;
  onToolUse?: (toolName: string, input: unknown, result: unknown) => void;
  /** Pre-compaction injection latch - per run, or one run's latch would let an
   *  overlapping run skip required compaction and overflow its context. */
  preCompactInjected?: boolean;
}

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
 * Load backend-specific AGENTS.md from ~/.mama/
 * Maps backend to file: 'claude' → AGENTS.claude.md, 'codex' → AGENTS.codex.md
 */
export function sanitizeLegacyCodexAgentsMd(content: string): string {
  const nativeGuidance = [
    'MAMA exposes the tools permitted for this run as native host tools. Call those tools directly through the model tool interface.',
    '',
    'Do not print Markdown tool blocks or JavaScript as a substitute for a tool call. The available native tool set is injected for each run and already reflects the current role and channel permissions.',
  ].join('\n');
  const knownLegacySections = [
    {
      heading: '## Tool protocol',
      nextHeading: '## Behavioural traits to know about yourself',
      signature: 'Gateway tools via `tool_call` JSON blocks:',
    },
    {
      heading: '## Tool Usage',
      nextHeading: '### Skills',
      signature: 'Use gateway tools via `tool_call` JSON blocks.',
    },
  ];
  const knownLegacyLines = [
    '### How to Call Tools',
    '### Available Gateway Tools',
    '### Important',
    '- **mama_search**(query?, type?, limit?) — Search decisions in MAMA memory',
    '- **mama_save**(type, topic?, decision?, reasoning?) — Save decision or checkpoint',
    '- **mama_update**(id, outcome, reason?) — Update decision outcome',
    '- **mama_load_checkpoint**() — Load last checkpoint',
    '- **discord_send**(channel_id, message?) — Send message to Discord channel',
    '- **slack_send**(channel_id, message?) — Send message to Slack channel',
    '- **Read**(path) — Read file',
    '- **Write**(path, content) — Write file',
    '- **Bash**(command) — Execute shell command',
    '- Do NOT use `exec_command` or `apply_patch` — use gateway tools instead',
    '- Tool calls are executed automatically. No need to use curl or Bash for these.',
    "Do NOT use `exec_command` or `apply_patch` — those are Codex defaults but bypass MAMA's gateway. Tool calls are executed automatically; do not wrap in `curl` or `Bash`.",
    '## Available gateway tools',
    '`mama_search`, `mama_save`, `mama_recall`, `mama_update`, `mama_load_checkpoint`, `discord_send`, `slack_send`, `Read`, `Write`, `Bash`. Check the skill `SKILL.md` for skill-provided extras.',
  ];
  const removeExactLine = (section: string, line: string): string =>
    section
      .split(/(\r?\n)/)
      .filter((part) => part !== line)
      .join('');
  let sanitized = content;

  for (const legacy of knownLegacySections) {
    const start = sanitized.indexOf(legacy.heading);
    if (start === -1) {
      continue;
    }
    const end = sanitized.indexOf(legacy.nextHeading, start + legacy.heading.length);
    if (end === -1) {
      continue;
    }
    const section = sanitized.slice(start, end);
    if (!section.includes(legacy.signature) || !section.includes('```tool_call')) {
      continue;
    }
    let transformed = section.replace(legacy.signature, nativeGuidance);
    const toolCallExample = [
      '```tool_call',
      '{"name": "tool_name", "input": {"param1": "value1"}}',
      '```',
    ].join('\n');
    transformed = transformed
      .replaceAll(toolCallExample, '')
      .replaceAll(toolCallExample.replaceAll('\n', '\r\n'), '');
    for (const line of knownLegacyLines) {
      transformed = removeExactLine(transformed, line);
    }
    sanitized = `${sanitized.slice(0, start)}${transformed}${sanitized.slice(end)}`;
  }

  return sanitized;
}

export function loadBackendAgentsMd(backend?: string, verbose = false): string {
  if (!backend) {
    return '';
  }
  const keyMap: Record<string, string> = {
    claude: 'claude',
    codex: 'codex',
  };
  const key = keyMap[backend];
  if (!key) {
    return '';
  }
  const filePath = join(homedir(), '.mama', `AGENTS.${key}.md`);
  if (existsSync(filePath)) {
    if (verbose) {
      console.log(`[AgentLoop] Loaded backend AGENTS.md: AGENTS.${key}.md`);
    }
    const content = readFileSync(filePath, 'utf-8');
    return key === 'codex' ? sanitizeLegacyCodexAgentsMd(content) : content;
  }
  if (verbose) {
    console.log(`[AgentLoop] Backend AGENTS.md not found: AGENTS.${key}.md`);
  }
  return '';
}

export function loadComposedSystemPrompt(verbose = false, context?: AgentContext): string {
  const mamaHome = join(homedir(), '.mama');
  const layers: string[] = [];

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
  const skillCatalog = filterSkillCatalogForContext(loadInstalledSkills(verbose), context);
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

  // Add minimal context if AgentContext is provided (role awareness)
  if (context) {
    layers.push(buildMinimalContext(context));
  }

  // Load backend-specific AGENTS.md (e.g., AGENTS.claude.md, AGENTS.codex.md)
  const backendAgentsMd = loadBackendAgentsMd(context?.backend, verbose);
  if (backendAgentsMd) {
    layers.push(backendAgentsMd);
  }

  // Load CLAUDE.md (base instructions)
  const claudeMd = loadSystemPrompt(verbose);
  layers.push(claudeMd);

  // Load ONBOARDING.md only during initial setup (before SOUL.md is created)
  const soulPath = join(mamaHome, 'SOUL.md');
  if (!existsSync(soulPath)) {
    const onboardingPath = join(mamaHome, 'ONBOARDING.md');
    if (existsSync(onboardingPath)) {
      const onboardingContent = readFileSync(onboardingPath, 'utf-8');
      layers.push(onboardingContent);
      if (verbose) {
        logger.debug('Loaded ONBOARDING.md (initial setup)');
      }
    }
  } else {
    if (verbose) {
      logger.debug('Skipped ONBOARDING.md (SOUL.md exists, setup complete)');
    }
  }

  const result = layers.join('\n\n---\n\n');
  // Debug: log each layer's size to find what's consuming context
  logger.debug(
    `[SystemPrompt] Total: ${result.length} chars, layers: ${layers.map((l, i) => `L${i}=${l.length}`).join(', ')}`
  );
  return result;
}

/**
 * Load Gateway Tools prompt from MD file
 * These tools are executed by GatewayToolExecutor, NOT MCP
 */
// Cache gateway-tools.md content (static at runtime, no need to re-read)
let _gatewayToolsCache: string | null = null;
// Cache filtered versions keyed by sorted disallowed list
const _filteredCache = new Map<string, string>();

export function getGatewayToolsPrompt(disallowed?: string[]): string {
  if (!_gatewayToolsCache) {
    const gatewayToolsPath = join(__dirname, 'gateway-tools.md');
    if (existsSync(gatewayToolsPath)) {
      _gatewayToolsCache = readFileSync(gatewayToolsPath, 'utf-8');
    } else {
      logger.warn('gateway-tools.md not found, using registry fallback');
      _gatewayToolsCache = `# Gateway Tools\n\n${ToolRegistry.generateFallbackPrompt()}`;
    }
  }

  if (!disallowed?.length) return _gatewayToolsCache;

  const cacheKey = [...disallowed].sort().join(',');
  let filtered = _filteredCache.get(cacheKey);
  if (!filtered) {
    filtered = _gatewayToolsCache;
    for (const tool of disallowed) {
      filtered = filtered.replace(new RegExp(`^- \\*\\*${tool}\\*\\*.*$`, 'gm'), '');
    }
    _filteredCache.set(cacheKey, filtered);
  }
  return filtered;
}

const CANONICAL_CODE_ACT_HEADING = '## Code-Act: Gateway Tool Execution via Sandbox';
const CODE_ACT_MCP_COMPAT_NAME = 'mcp__code-act__code_act';
const GENERATED_CODE_ACT_START = '<!-- MAMA_GENERATED_CODE_ACT_START -->';
const GENERATED_CODE_ACT_END = '<!-- MAMA_GENERATED_CODE_ACT_END -->';
const GENERATED_GATEWAY_TOOLS_START = '<!-- MAMA_GENERATED_GATEWAY_TOOLS_START -->';
const GENERATED_GATEWAY_TOOLS_END = '<!-- MAMA_GENERATED_GATEWAY_TOOLS_END -->';

function removePromptSection(
  systemPrompt: string,
  sectionStart: number,
  sectionEnd: number
): string {
  const prefix = systemPrompt.slice(0, sectionStart);
  const separator = prefix.match(/\r?\n\r?\n---[ \t]*\r?\n\r?\n$/);
  const removalStart = separator?.index ?? sectionStart;
  return `${systemPrompt.slice(0, removalStart)}${systemPrompt.slice(sectionEnd)}`;
}

function stripMarkedPromptSection(
  systemPrompt: string,
  startMarker: string,
  endMarker: string
): string {
  let stripped = systemPrompt;
  let sectionStart = stripped.lastIndexOf(startMarker);
  while (sectionStart >= 0) {
    const markerEnd = stripped.indexOf(endMarker, sectionStart + startMarker.length);
    if (markerEnd < 0) {
      return stripped;
    }
    stripped = removePromptSection(stripped, sectionStart, markerEnd + endMarker.length);
    sectionStart = stripped.lastIndexOf(startMarker);
  }
  return stripped;
}

function wrapGeneratedPromptSection(kind: 'codeAct' | 'gatewayTools', content: string): string {
  const [start, end] =
    kind === 'codeAct'
      ? [GENERATED_CODE_ACT_START, GENERATED_CODE_ACT_END]
      : [GENERATED_GATEWAY_TOOLS_START, GENERATED_GATEWAY_TOOLS_END];
  return `${start}\n${content}\n${end}`;
}

function stripGenericGatewayToolsCatalog(systemPrompt: string): string {
  const withoutMarked = stripMarkedPromptSection(
    systemPrompt,
    GENERATED_GATEWAY_TOOLS_START,
    GENERATED_GATEWAY_TOOLS_END
  );
  const headingPattern = /^#{1,6}\s+Gateway Tools\s*$/gm;
  let catalogStart = -1;
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(withoutMarked)) !== null) {
    catalogStart = match.index;
  }
  if (catalogStart < 0) {
    return withoutMarked;
  }

  const catalog = withoutMarked.slice(catalogStart);
  if (!catalog.includes('Call tools via JSON block:') || !catalog.includes('```tool_call')) {
    return withoutMarked;
  }

  const generatedCatalog = getGatewayToolsPrompt();
  if (withoutMarked.startsWith(generatedCatalog, catalogStart)) {
    return removePromptSection(withoutMarked, catalogStart, catalogStart + generatedCatalog.length);
  }

  const boundedSeparator = catalog.match(/\r?\n\r?\n---[ \t]*\r?\n\r?\n/);
  const sectionEnd = boundedSeparator?.index ?? catalog.length;
  return removePromptSection(withoutMarked, catalogStart, catalogStart + sectionEnd);
}

function stripTrailingCanonicalCodeActSection(systemPrompt: string): string {
  const withoutMarked = stripMarkedPromptSection(
    systemPrompt,
    GENERATED_CODE_ACT_START,
    GENERATED_CODE_ACT_END
  );
  const sectionStart = withoutMarked.lastIndexOf(CANONICAL_CODE_ACT_HEADING);
  if (sectionStart < 0) {
    return withoutMarked;
  }

  const section = withoutMarked.slice(sectionStart);
  const typeFenceStart = section.indexOf('```typescript');
  if (typeFenceStart >= 0) {
    const typeFenceEnd = section.indexOf('```', typeFenceStart + '```typescript'.length);
    if (typeFenceEnd >= 0) {
      return removePromptSection(withoutMarked, sectionStart, sectionStart + typeFenceEnd + 3);
    }
  }

  const boundedSeparator = section.match(/\r?\n\r?\n---[ \t]*\r?\n\r?\n/);
  const sectionEnd = boundedSeparator?.index ?? section.length;
  return removePromptSection(withoutMarked, sectionStart, sectionStart + sectionEnd);
}

function stripDisabledCodeActGuidance(systemPrompt: string): string {
  return stripTrailingCanonicalCodeActSection(systemPrompt).replace(
    /^- \*\*(?:code_act|mcp__code-act__code_act)\*\*.*$/gm,
    ''
  );
}

function combineCodeActSessionPolicyFingerprint(
  callerFingerprint: string | undefined,
  policy: CodeActToolPolicy
): string {
  return JSON.stringify({
    version: 1,
    callerFingerprint: callerFingerprint ?? null,
    codeActPolicy: policy.fingerprintPayload,
  });
}

function roleAllowsOuterCodeAct(
  role: AgentContext['role'] | undefined,
  disallowedTools: readonly string[] | undefined
): boolean {
  if (!role) {
    return false;
  }

  return ToolRegistry.getHostToolDefinitions({
    allowedTools: role.allowedTools,
    blockedTools: role.blockedTools,
    disallowedTools: disallowedTools ? [...disallowedTools] : undefined,
  }).some((tool) => tool.name === CODE_ACT_MARKER);
}

export type AgentToolExecutionContext = GatewayToolExecutionContext;

export function buildAgentToolExecutionContext(
  options?: AgentLoopOptions
): AgentToolExecutionContext | null {
  if (
    !options ||
    (options.agentContext === undefined &&
      options.source === undefined &&
      options.channelId === undefined &&
      options.envelope === undefined &&
      options.sourceTurnId === undefined &&
      options.sourceMessageRef === undefined &&
      options.modelRunId === undefined &&
      options.reportPublisherOverride === undefined)
  ) {
    return null;
  }
  const agentContext = options.agentContext;
  const context: AgentToolExecutionContext = {
    agentContext,
    agentId: agentContext
      ? agentContext.source === 'viewer'
        ? 'os-agent'
        : agentContext.roleName
      : undefined,
    source: options.source,
    channelId: options.channelId,
    envelope: options.envelope,
    executionSurface: 'model_tool',
  };
  if (options.sourceTurnId !== undefined) {
    context.sourceTurnId = options.sourceTurnId;
  }
  if (options.sourceMessageRef !== undefined) {
    context.sourceMessageRef = options.sourceMessageRef;
  }
  if (options.modelRunId !== undefined) {
    context.modelRunId = options.modelRunId;
  }
  if (options.reportPublisherOverride !== undefined) {
    context.reportPublisherOverride = options.reportPublisherOverride;
  }
  return context;
}

function withExecutionSurface(
  executionContext: AgentToolExecutionContext | null,
  executionSurface: GatewayExecutionSurface
): AgentToolExecutionContext | null {
  if (!executionContext) {
    return null;
  }
  if (executionContext.executionSurface === executionSurface) {
    return executionContext;
  }
  return {
    ...executionContext,
    executionSurface,
  };
}

export class AgentLoop {
  private readonly agent: IModelRunner;
  private readonly persistentCLI: PersistentCLIAdapter | null = null;
  private readonly mcpExecutor: GatewayToolExecutor;
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
  private readonly onMetric?: (
    name: string,
    value: number,
    labels?: Record<string, string>
  ) => void;
  private readonly laneManager: LaneManager;
  private readonly useLanes: boolean;
  private sessionKey: string;
  private readonly sessionPool: SessionPool;
  private readonly toolsConfig: typeof DEFAULT_TOOLS_CONFIG;
  private readonly isGatewayMode: boolean;
  private readonly useCodeAct: boolean;
  private readonly backend: 'claude' | 'codex';
  private readonly defaultSystemPrompt: string;
  private readonly postToolHandler: PostToolHandler | null;
  private readonly stopContinuationHandler: StopContinuationHandler | null;
  private readonly preCompactHandler: PreCompactHandler | null;
  // Per-run state (stream callbacks, tier) lives in a RunScope threaded through
  // runWithContentInternal -> executeTools, NEVER on the
  // instance: concurrent runs on separate global lanes (operator report/worker
  // overlapping owner chat) would steal each other's callbacks and leak tiers
  // if these were instance fields.
  private readonly disallowedTools?: string[];

  constructor(
    _oauthManager: OAuthManager | null,
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
    this.useCodeAct = options.useCodeAct ?? false;
    this.isGatewayMode = useGatewayMode || (options.backend === 'codex' && this.useCodeAct);
    this.disallowedTools = this.useCodeAct
      ? options.disallowedTools
      : [
          ...new Set([
            ...(options.disallowedTools ?? []),
            CODE_ACT_MARKER,
            CODE_ACT_MCP_COMPAT_NAME,
          ]),
        ];

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
      const skillCatalog = filterSkillCatalogForContext(
        loadInstalledSkills(),
        options.agentContext ?? null
      );
      // Only load ONBOARDING.md during initial setup (before SOUL.md exists)
      const onboardingContent = !existsSync(join(mamaHome, 'SOUL.md'))
        ? (() => {
            const op = join(mamaHome, 'ONBOARDING.md');
            return existsSync(op) ? readFileSync(op, 'utf-8') : '';
          })()
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

    if (this.useCodeAct && options.systemPrompt) {
      promptLayers = [
        {
          name: 'custom',
          content: stripTrailingCanonicalCodeActSection(
            stripGenericGatewayToolsCatalog(options.systemPrompt)
          ),
          priority: 1,
        },
      ];
    }

    // Load backend-specific AGENTS.md (e.g., AGENTS.claude.md, AGENTS.codex.md)
    const backendAgentsMd = loadBackendAgentsMd(backend);
    if (backendAgentsMd) {
      promptLayers.push({ name: 'backendAgents', content: backendAgentsMd, priority: 2 });
    }

    if (this.isGatewayMode) {
      if (
        this.useCodeAct &&
        roleAllowsOuterCodeAct(options.agentContext?.role, this.disallowedTools)
      ) {
        // Code-Act mode: replace verbose gateway tools markdown with compact .d.ts
        const tierForTypeDefs = options.agentContext?.tier ?? 1;
        const policy = projectCodeActToolPolicy({
          tier: tierForTypeDefs,
          role: options.agentContext?.role,
          disallowedTools: this.disallowedTools,
        });
        const typeDefs = TypeDefinitionGenerator.generate(policy);
        const codeActPrompt = wrapGeneratedPromptSection(
          'codeAct',
          getCodeActInstructions(backend, policy.names) + '\n```typescript\n' + typeDefs + '\n```'
        );
        promptLayers.push({ name: 'codeAct', content: codeActPrompt, priority: 2 });
      } else if (!this.useCodeAct && backend !== 'codex') {
        const gatewayToolsPrompt = getGatewayToolsPrompt(this.disallowedTools);
        if (gatewayToolsPrompt) {
          promptLayers.push({
            name: 'gatewayTools',
            content: wrapGeneratedPromptSection('gatewayTools', gatewayToolsPrompt),
            priority: 2,
          });
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
    this.defaultSystemPrompt = defaultSystemPrompt;

    // Choose backend (default: claude)
    this.backend = backend;

    if (this.backend === 'codex') {
      // Codex app-server mode
      const workspaceDir = options.codexCwd ?? join(homedir(), '.mama', 'workspace');
      // Ensure workspace directory exists
      if (!existsSync(workspaceDir)) {
        mkdirSync(workspaceDir, { recursive: true });
      }
      this.agent = new CodexRuntimeProcess({
        model: options.model,
        cwd: workspaceDir,
        sandbox: options.codexSandbox ?? 'workspace-write',
        systemPrompt: defaultSystemPrompt,
        command: options.codexCommand,
        requestTimeout: options.timeoutMs,
        codexHome: options.codexHome,
        isolatedHome: options.codexIsolatedHome,
        registryRoot: options.codexRegistryRoot,
        mcpConfigPath: this.useCodeAct
          ? undefined
          : (options.mcpConfigPath ?? (useMCPMode ? mcpConfigPath : undefined)),
      });
      logger.debug('Codex app-server backend enabled');
    } else {
      // Claude backend: always use PersistentCLI for fast responses (~2-3s vs ~16-30s)
      this.persistentCLI = new PersistentCLIAdapter({
        model: options.model!,
        sessionId,
        systemPrompt: defaultSystemPrompt,
        // MCP config: only pass when MCP mode is enabled (gateway mode uses GatewayToolExecutor)
        mcpConfigPath: useMCPMode ? mcpConfigPath : undefined,
        // MAMA OS is a headless daemon (no TTY) — Claude CLI's interactive permission prompts
        // cannot work. Security is enforced by MAMA's own RoleManager layer (config.yaml roles).
        // DO NOT gate this on env vars — MAMA manages permissions via its config, not Claude CLI.
        dangerouslySkipPermissions: options.dangerouslySkipPermissions ?? true,
        // Gateway tools are processed by GatewayToolExecutor (hybrid with MCP)
        useGatewayTools: useGatewayMode,
        // Structurally disallow specific tools (e.g., Bash/Read for restricted agents)
        disallowedTools: this.disallowedTools,
        // Native built-ins cross with text-parsed gateway calls (hallucinated
        // ToolSearch/Agent, native gathering that bypasses report verification).
        // Callers opt in per loop; agent-loop-init locks down the main persona.
        tools: options.builtinTools,
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

    // Root fix (2026-07-16): the daemon persona shares the boot-wired executor so
    // every dependency wiring (task ledger, report publisher, event bus, gateways,
    // wiki, obsidian, ...) reaches persona lanes by construction. Constructing a
    // second instance here is allowed ONLY for deliberately isolated loops
    // (memory agent, mama run CLI) that own their dep set.
    this.mcpExecutor = options.executor ?? new GatewayToolExecutor(executorOptions);
    // Persona tool blocks are per-call policy, not executor state - a shared
    // executor must never inherit one caller's blocks (see buildToolExecutionContext).
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.model = options.model!;
    this.onTurn = options.onTurn;
    this.onToolUse = options.onToolUse;
    this.onTokenUsage = options.onTokenUsage;
    this.onMetric = options.onMetric;

    this.laneManager = getGlobalLaneManager();
    this.useLanes = options.useLanes ?? false;
    this.sessionKey = options.sessionKey ?? 'default';
    this.sessionPool = getSessionPool();

    // Initialize PostToolHandler (fire-and-forget after tool execution)
    if (options.postToolUse?.enabled) {
      this.postToolHandler = new PostToolHandler(
        (name, input, executionContext) =>
          this.mcpExecutor.execute(name, input as GatewayToolInput, executionContext ?? undefined),
        { enabled: true, contractSaveLimit: options.postToolUse.contractSaveLimit }
      );
      console.log('[AgentLoop] PostToolHandler enabled');
    } else {
      this.postToolHandler = null;
    }

    // Initialize PreCompactHandler (unsaved decision detection)
    if (options.preCompact?.enabled) {
      this.preCompactHandler = new PreCompactHandler(
        (name, input, executionContext) =>
          this.mcpExecutor.execute(name, input as GatewayToolInput, executionContext ?? undefined),
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
  }

  setContextCompileService(service: GatewayToolExecutorOptions['contextCompileService']): void {
    this.mcpExecutor.setContextCompileService(service);
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
    const source = sessionKey.split(':', 1)[0]?.trim().toLowerCase();
    if (!source) {
      return undefined;
    }
    return SOURCE_GLOBAL_LANES[source];
  }

  private buildToolExecutionContext(options?: AgentLoopOptions): AgentToolExecutionContext | null {
    const base = buildAgentToolExecutionContext(options);
    if (!base) {
      return null; // no context fields - out-of-scope loops keep today's semantics
    }
    return {
      ...base,
      // Persona blocks are per-call policy - never executor instance state.
      disallowedGatewayTools: this.disallowedTools,
      // Never let persona calls inherit the code-act route's fallback identity.
      // 'conductor' matches the existing delegation-routing fallback
      // (gateway-tool-executor.ts:653) so attribution is unchanged.
      // (Persona lanes always pass source/channelId, so base is non-null for them
      // and the disallowed list travels on every persona run.)
      agentId: base.agentId || 'conductor',
    };
  }

  /**
   * Set system prompt override (for per-message context injection)
   */
  setSystemPrompt(prompt: string | undefined): void {
    this.agent.setSystemPrompt(prompt ?? this.defaultSystemPrompt);
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
   * Set Telegram gateway for telegram_send tool
   */
  setTelegramGateway(gateway: {
    sendMessage(chatId: string, text: string): Promise<void>;
    sendFile(chatId: string, filePath: string, caption?: string): Promise<void>;
    sendImage(chatId: string, imagePath: string, caption?: string): Promise<void>;
    sendSticker(chatId: string | number, emotion: string): Promise<boolean>;
  }): void {
    this.mcpExecutor.setTelegramGateway(gateway);
  }

  /**
   * Set shared sessions DB for agent management and validation-aware tools.
   */
  setSessionsDb(db: import('../sqlite.js').default): void {
    this.mcpExecutor.setSessionsDb(db);
  }

  /**
   * Set UI command queue for viewer_state / viewer_navigate tools.
   */
  setUICommandQueue(queue: import('../api/ui-command-handler.js').UICommandQueue): void {
    this.mcpExecutor.setUICommandQueue(queue);
  }

  /**
   * Set validation service for agent_test / delegate validation flows.
   */
  setValidationService(
    svc: import('../validation/session-service.js').ValidationSessionService
  ): void {
    this.mcpExecutor.setValidationService(svc);
  }

  /**
   * Set raw store for connector-backed agent_test input gathering.
   */
  setRawStore(store: import('../connectors/framework/raw-store.js').RawStore): void {
    this.mcpExecutor.setRawStore(store);
  }

  /**
   * Set report publisher for report_publish tool (Dashboard Agent)
   */
  setReportPublisher(fn: (slots: Record<string, string>) => void): void {
    this.mcpExecutor.setReportPublisher(fn);
  }

  /**
   * Set wiki publisher for wiki_publish tool (Wiki Agent)
   */
  setWikiPublisher(
    fn: (
      pages: Array<{
        path: string;
        title: string;
        type: string;
        content: string;
        sourceIds: string[];
        compiledAt: string;
        confidence: string;
      }>
    ) => void
  ): void {
    this.mcpExecutor.setWikiPublisher(fn);
  }

  /**
   * Set AgentProcessManager for delegate tool (multi-agent delegation)
   */
  setAgentProcessManager(
    pm: import('../multi-agent/agent-process-manager.js').AgentProcessManager
  ): void {
    pm.setGatewayToolExecutor(this.mcpExecutor);
    this.mcpExecutor.setAgentProcessManager(pm);
  }

  /**
   * Set DelegationManager for delegate tool (permission checks)
   */
  setDelegationManager(dm: import('../multi-agent/delegation-manager.js').DelegationManager): void {
    this.mcpExecutor.setDelegationManager(dm);
  }

  /**
   * Set runtime multi-agent config applier for agent management tools.
   */
  setApplyMultiAgentConfig(fn: ((config: Record<string, unknown>) => Promise<void>) | null): void {
    this.mcpExecutor.setApplyMultiAgentConfig(fn);
  }

  /**
   * Set per-agent runtime restarter for agent management tools.
   */
  setRestartMultiAgentAgent(fn: ((agentId: string) => Promise<void>) | null): void {
    this.mcpExecutor.setRestartMultiAgentAgent(fn);
  }

  /**
   * Set AgentEventBus for agent_notices tool
   */
  setAgentEventBus(eventBus: import('../multi-agent/agent-event-bus.js').AgentEventBus): void {
    this.mcpExecutor.setAgentEventBus(eventBus);
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
    if (this.stopped) {
      throw new AgentError('Agent loop is stopping', 'AGENT_STOPPED', undefined, false);
    }

    const runScope: RunScope = {
      streamCallbacks: options?.streamCallbacks,
      tier: 1,
      onTurn: options?.onTurn ?? this.onTurn,
      onToolUse: options?.onToolUse ?? this.onToolUse,
    };
    const history: Message[] = [];
    const totalUsage = { input_tokens: 0, output_tokens: 0 };
    let turn = 0;
    let stopReason: ClaudeResponse['stop_reason'] = 'end_turn';
    let ownedModelRunId: string | null = null;
    let ownedModelRunCommitted = false;
    const pendingBackgroundTasks: Promise<unknown>[] = [];
    const backgroundTasks: BackgroundTaskRegistry = {
      register(task: Promise<unknown>): void {
        const observedTask = Promise.resolve(task);
        observedTask.catch(() => {
          // Re-thrown later by drainBackgroundTasks; attach now to prevent unhandled rejections.
        });
        pendingBackgroundTasks.push(observedTask);
      },
    };

    let toolExecutionContext = this.withBackgroundTaskRegistry(
      this.buildToolExecutionContext(options),
      backgroundTasks
    );

    // Track this run's tier for code-act execution and prompt sizing.
    if (options?.agentContext) {
      const rawTier = options.agentContext.tier ?? 1;
      runScope.tier = this.useCodeAct
        ? requireCodeActTier(rawTier)
        : rawTier === 1 || rawTier === 2 || rawTier === 3
          ? rawTier
          : 1;
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
    const isCodex = this.backend === 'codex';
    const codeActPolicy = this.useCodeAct
      ? projectCodeActToolPolicy({
          tier: runScope.tier,
          role: options?.agentContext?.role,
          disallowedTools: this.disallowedTools,
        })
      : undefined;
    const outerCodeActAllowed =
      this.useCodeAct && roleAllowsOuterCodeAct(options?.agentContext?.role, this.disallowedTools);
    const effectiveSessionPolicyFingerprint =
      isCodex && codeActPolicy
        ? combineCodeActSessionPolicyFingerprint(options?.sessionPolicyFingerprint, codeActPolicy)
        : options?.sessionPolicyFingerprint;
    let resolvedCliSessionId: string | null = options?.cliSessionId ?? null;

    const sessionLabel = (isNew: boolean): string => {
      if (isCodex) {
        return isNew ? 'NEW thread' : 'CONTINUE thread';
      }
      return isNew ? 'NEW process' : 'CONTINUE session';
    };

    if (options?.cliSessionId) {
      // Session routing travels per prompt() call via resolvedCliSessionId - no
      // shared-adapter mutation (setSessionId re-pointed channelKey/currentProcess
      // across awaits, cross-wiring concurrent lanes).
      console.log(
        `[AgentLoop] [${isCodex ? 'codex' : 'claude'}] ${channelKey} (${sessionLabel(sessionIsNew)})`
      );
    } else if (options?.freshSession) {
      // Stateless lanes (operator reports): session context is a cache, not
      // persistence - every run self-gathers and recalls; carrying prior runs'
      // gather dumps only grows the context until runs outlive their envelope
      // (measured 146s -> 521s over 3 days; owner decision 2026-07-16).
      const cliSessionId = this.sessionPool.resetSession(channelKey);
      sessionIsNew = true;
      ownedSession = true;
      resolvedCliSessionId = cliSessionId;
      console.log(
        `[AgentLoop] [${isCodex ? 'codex' : 'claude'}] ${channelKey} (FRESH session - stateless lane)`
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
      resolvedCliSessionId = cliSessionId;
      // Per-call routing via resolvedCliSessionId - no shared-adapter mutation.
      console.log(
        `[AgentLoop] [${isCodex ? 'codex' : 'claude'}] ${channelKey} (${sessionLabel(isNew)})`
      );
    }

    try {
      if (this.shouldBeginModelRun(options)) {
        const modelRun = await this.mcpExecutor.beginRuntimeModelRun(
          this.buildModelRunInput(options, resolvedCliSessionId)
        );
        ownedModelRunId = modelRun.model_run_id;
        toolExecutionContext = this.withBackgroundTaskRegistry(
          this.buildToolExecutionContext({
            ...options,
            modelRunId: ownedModelRunId,
          }),
          backgroundTasks
        );
      }

      let nativeToolCallCount = 0;
      let nativeConsecutiveToolCalls = 0;
      let nativeLastToolName = '';
      const hostToolBridge: HostToolBridge | undefined =
        isCodex && this.isGatewayMode
          ? {
              tools: this.useCodeAct
                ? outerCodeActAllowed
                  ? ToolRegistry.getHostToolDefinitions({ allowedTools: [CODE_ACT_MARKER] })
                  : []
                : ToolRegistry.getHostToolDefinitions({
                    allowedTools: options?.agentContext?.role.allowedTools,
                    blockedTools: options?.agentContext?.role.blockedTools,
                    disallowedTools: this.disallowedTools,
                    viewer: options?.agentContext?.platform === 'viewer',
                  }),
              execute: async (call: HostToolCall) => {
                const callSignal = call.signal ?? new AbortController().signal;
                callSignal.throwIfAborted();
                if (nativeToolCallCount >= EMERGENCY_MAX_TURNS) {
                  return {
                    content: `Native tool call budget exceeded emergency maximum turns (${EMERGENCY_MAX_TURNS})`,
                    isError: true,
                    abort: true,
                  };
                }

                const nextConsecutiveCount =
                  call.name === nativeLastToolName ? nativeConsecutiveToolCalls + 1 : 1;
                if (nextConsecutiveCount >= MAX_CONSECUTIVE_SAME_TOOL) {
                  return {
                    content: `Infinite loop detected: Tool "${call.name}" called ${nextConsecutiveCount} times consecutively`,
                    isError: true,
                    abort: true,
                  };
                }

                nativeToolCallCount += 1;
                nativeConsecutiveToolCalls = nextConsecutiveCount;
                nativeLastToolName = call.name;
                const toolUse: ToolUseBlock = {
                  type: 'tool_use',
                  id: call.callId,
                  name: call.name,
                  input: call.input,
                };
                history.push({ role: 'assistant', content: [toolUse] });
                runScope.onTurn?.({
                  turn,
                  role: 'assistant',
                  content: [toolUse],
                  stopReason: 'tool_use',
                });
                const callExecutionContext = toolExecutionContext
                  ? {
                      ...toolExecutionContext,
                      gatewayCallId: call.callId,
                      signal: callSignal,
                    }
                  : null;
                const [toolResult] = await this.executeTools(
                  [toolUse],
                  options?.stopAfterSuccessfulTools ?? [],
                  callExecutionContext,
                  runScope
                );
                callSignal.throwIfAborted();
                if (!toolResult) {
                  return {
                    content: `Native tool "${call.name}" returned no result`,
                    isError: true,
                    abort: true,
                  };
                }
                history.push({ role: 'user', content: [toolResult] });
                runScope.onTurn?.({
                  turn,
                  role: 'user',
                  content: [toolResult],
                });
                return {
                  content: toolResult.content,
                  isError: toolResult.is_error === true,
                  stop:
                    toolResult.is_error !== true &&
                    (options?.stopAfterSuccessfulTools ?? []).includes(call.name),
                };
              },
            }
          : undefined;

      const prepareSystemPrompt = (
        requestedSystemPrompt: string | undefined,
        isResumingSession: boolean
      ): string => {
        let baseSystemPrompt = requestedSystemPrompt ?? this.defaultSystemPrompt;
        let gatewayToolsPrompt = '';
        if (this.isGatewayMode && this.useCodeAct) {
          baseSystemPrompt = stripTrailingCanonicalCodeActSection(
            stripGenericGatewayToolsCatalog(baseSystemPrompt)
          );
          if (outerCodeActAllowed) {
            const policy = codeActPolicy!;
            const typeDefs = TypeDefinitionGenerator.generate(policy);
            gatewayToolsPrompt = wrapGeneratedPromptSection(
              'codeAct',
              getCodeActInstructions(isCodex ? 'codex' : 'claude', policy.names) +
                '\n```typescript\n' +
                typeDefs +
                '\n```'
            );
          }
        } else if (this.isGatewayMode && !isCodex) {
          baseSystemPrompt = stripDisabledCodeActGuidance(baseSystemPrompt);
          if (!isResumingSession) {
            // Non-CodeAct callers may already embed the generic gateway catalog.
            const alreadyHasTools =
              baseSystemPrompt.includes('# Gateway Tools') ||
              baseSystemPrompt.includes('# Code Execution') ||
              baseSystemPrompt.includes('## Code-Act');
            if (!alreadyHasTools) {
              gatewayToolsPrompt = wrapGeneratedPromptSection(
                'gatewayTools',
                getGatewayToolsPrompt(this.disallowedTools)
              );
            }
          }
        }
        const fullPrompt = gatewayToolsPrompt
          ? `${baseSystemPrompt}\n\n---\n\n${gatewayToolsPrompt}`
          : baseSystemPrompt;

        // Monitor and enforce prompt size
        const monitor = new PromptSizeMonitor();
        const runLayers: PromptLayer[] = [
          { name: 'systemPrompt', content: baseSystemPrompt, priority: 1 },
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
          const tBase = trimmed.find((l) => l.name === 'systemPrompt')?.content || baseSystemPrompt;
          const tTools = trimmed.find((l) => l.name === 'gatewayTools')?.content || '';
          effectivePrompt = tTools ? `${tBase}\n\n---\n\n${tTools}` : tBase;
          console.log(
            `[AgentLoop] System prompt truncated: ${fullPrompt.length} → ${effectivePrompt.length} chars`
          );
        }

        console.log(
          `[AgentLoop] Prepared systemPrompt for this call: ${effectivePrompt.length} chars ` +
            `(base: ${baseSystemPrompt.length}, tools: ${gatewayToolsPrompt.length})`
        );
        return effectivePrompt;
      };

      let perCallSystemPrompt: string;
      if (options?.systemPrompt || (this.isGatewayMode && this.useCodeAct)) {
        perCallSystemPrompt = prepareSystemPrompt(
          options?.systemPrompt,
          options?.resumeSession === true
        );
      } else {
        perCallSystemPrompt = this.defaultSystemPrompt;
        console.log(`[AgentLoop] No systemPrompt in options - using spawn default for this call`);
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

        // A run whose envelope is (about to be) expired cannot commit ANY write -
        // every gateway call from here on is denied '[expired]' (enforcer.ts:73).
        if (options?.envelope && envelopeExpired(options.envelope, Date.now(), 30_000)) {
          const envId = String(
            (options.envelope as { instance_id?: string }).instance_id ?? 'unknown'
          );
          if (options?.source === 'operator') {
            // Non-interactive lane: abort loudly now instead of burning doomed turns.
            // The trigger loop keeps its digest buffer and retries next cadence.
            throw new AgentError(
              `Envelope ${envId} expired mid-run at turn ${turn}; aborting doomed run`,
              'ENVELOPE_EXPIRED',
              undefined,
              false
            );
          }
          // Interactive lanes (chat): never abort a live conversation - deliver the
          // text; individual writes will be denied loudly by the enforcer as today.
          console.error(
            `[AgentLoop] envelope ${envId} expired mid-run (turn ${turn}, source ${options?.source ?? 'unknown'}); ` +
              `subsequent gateway writes will be denied`
          );
        }

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

        const ext = runScope.streamCallbacks;
        let attemptReportedError: Error | undefined;
        const callbacks = {
          onDelta: (text: string) => {
            ext?.onDelta?.(text);
          },
          onToolUse: (name: string, input: Record<string, unknown>) => {
            ext?.onToolUse?.(name, input);
          },
          onToolComplete: (name: string, toolUseId: string, isError: boolean) => {
            ext?.onToolComplete?.(name, toolUseId, isError);
          },
          onFinal: (finalResponse: PromptFinalResponse) => {
            ext?.onFinal?.(finalResponse);
          },
          onError: (error: Error) => {
            // A model runner can emit onError before rejecting. Hold it until
            // AgentLoop knows whether the attempt is terminal so a successful
            // one-time session recovery does not leak a false failure event.
            attemptReportedError = error;
          },
        };

        let piResult;
        // Claude: First turn → --session-id (inject system prompt), subsequent → --resume
        // Codex: resumeSession only controls threadId reset (false=new thread, true=continue)
        const shouldResume = isCodex
          ? turn > 1 || (options?.freshSession === true ? false : (options?.resumeSession ?? true))
          : !sessionIsNew || turn > 1;
        // Both Claude PersistentCLI and Codex app-server preserve context - only send new messages
        const promptText = this.formatLastMessageOnly(history);
        const promptStart = Date.now();
        const throwFinalCliError = (error: unknown): never => {
          const normalizedError = error instanceof Error ? error : new Error(String(error));
          this.onMetric?.('prompt_error', 1, {
            backend: this.backend,
            error_type: 'CLI_ERROR',
          });
          try {
            ext?.onError?.(attemptReportedError ?? normalizedError);
          } catch (callbackError) {
            logger.warn(
              `External onError callback failed: ${
                callbackError instanceof Error ? callbackError.message : String(callbackError)
              }`
            );
          }
          throw new AgentError(
            `CLI error: ${normalizedError.message}`,
            'CLI_ERROR',
            normalizedError,
            true
          );
        };
        try {
          piResult = await this.agent.prompt(promptText, callbacks, {
            model: options?.model,
            resumeSession: shouldResume,
            systemPrompt: perCallSystemPrompt,
            sessionKey: channelKey,
            sessionPolicyFingerprint: effectiveSessionPolicyFingerprint,
            sessionId: resolvedCliSessionId ?? undefined,
            // Per-run request timeout (operator worker runs); undefined leaves
            // the pool's construction-time default untouched (chat).
            requestTimeout: options?.requestTimeoutMs,
            hostToolBridge,
          });
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
            errorMessage.includes('request_too_large') ||
            errorMessage.includes('context window') ||
            errorMessage.includes('context_length_exceeded');
          const isCodexPolicyMismatch = errorMessage.includes(
            'Codex app-server thread policy mismatch; reset the session explicitly'
          );

          if (
            (isCodex && isCodexPolicyMismatch) ||
            (!isCodex && (isSessionNotFound || isSessionInUse || isPromptTooLong))
          ) {
            const reason = isCodexPolicyMismatch
              ? 'policy mismatch'
              : isSessionNotFound
                ? 'not found in CLI'
                : isSessionInUse
                  ? 'already in use'
                  : 'prompt too long (context overflow)';
            console.log(`[AgentLoop] Session ${reason}, retrying with new session`);

            // Reset session in pool so it creates a new one
            const newSessionId = this.sessionPool.resetSession(channelKey);
            options?.onCliSessionReset?.(newSessionId);
            // Per-call routing: hand the new id to this prompt() and update the
            // resolved id so later turns follow it - no shared-adapter mutation.
            resolvedCliSessionId = newSessionId;

            // A policy mismatch can occur on a resumed MessageRouter session,
            // whose per-call prompt is intentionally minimal. Rebuild the full
            // policy prompt before opening the replacement durable thread.
            let resetSystemPrompt = perCallSystemPrompt;
            try {
              // Discard the recoverable first-attempt error before any reset
              // preparation. A prompt rebuild or retry failure must surface
              // its own final error, never the mismatch that triggered it.
              attemptReportedError = undefined;
              if (isCodexPolicyMismatch && options?.freshSessionSystemPrompt) {
                resetSystemPrompt = prepareSystemPrompt(
                  await options.freshSessionSystemPrompt(),
                  false
                );
              }

              piResult = await this.agent.prompt(promptText, callbacks, {
                model: options?.model,
                resumeSession: false, // Force new session
                systemPrompt: resetSystemPrompt,
                sessionKey: channelKey,
                sessionPolicyFingerprint: effectiveSessionPolicyFingerprint,
                sessionId: newSessionId,
                // Carry the per-run timeout onto the reset session too.
                requestTimeout: options?.requestTimeoutMs,
                hostToolBridge,
              });
            } catch (retryError) {
              console.error(
                `[AgentLoop] ${this.backend} reset retry failed:`,
                retryError instanceof Error ? retryError.message : String(retryError)
              );
              // resetSession() creates and locks a replacement pool entry.
              // A failed rebuild/retry must remove it entirely; otherwise the
              // next MessageRouter turn sees isNew=false and can persist a
              // minimal resume prompt as the replacement thread's base policy.
              this.sessionPool.invalidateSession(channelKey, newSessionId);
              throwFinalCliError(retryError);
            }
            // Prepend reset notice so user knows context was lost
            if (isPromptTooLong && piResult?.response) {
              piResult.response = `⚠️ Session reset: The previous conversation was too long, starting a new session.\n\n${piResult.response}`;
            }
            console.log(`[AgentLoop] Retry successful with new session: ${newSessionId}`);
          } else {
            throwFinalCliError(error);
          }
        }

        if (!piResult) {
          return throwFinalCliError(new Error('Model runner returned no prompt result'));
        }

        // Emit one terminal metric per prompt turn, including recovered calls.
        this.onMetric?.('prompt_latency_ms', Date.now() - promptStart, {
          backend: this.backend,
          turn: String(turn),
        });
        // After first successful call, mark session as not new for subsequent turns
        if (turn === 1) {
          sessionIsNew = false;
        }

        // Build content blocks - include tool_use blocks if present
        const contentBlocks: ContentBlock[] = [];
        let parsedToolCalls: ToolUseBlock[] = [];

        // Parse tool_call / code_act blocks from text response (Gateway Tools mode ONLY)
        if (this.isGatewayMode && !isCodex) {
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

        // Both parsed gateway calls and native/MCP tool blocks share executeTools.
        const hasToolUse = contentBlocks.some((block) => block.type === 'tool_use');

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
        const tokenBackend = this.backend === 'codex' ? 'codex' : 'claude';
        const tokenStatus = this.sessionPool.updateTokens(
          channelKey,
          response.usage.input_tokens,
          tokenBackend
        );

        // PreCompact: inject compaction summary when approaching context limit
        if (tokenStatus.nearThreshold && this.preCompactHandler && !runScope.preCompactInjected) {
          runScope.preCompactInjected = true;
          try {
            const historyText = history.map((msg) => {
              if (typeof msg.content === 'string') return msg.content;
              return (msg.content as ContentBlock[])
                .filter((b): b is TextBlock => b.type === 'text')
                .map((b) => b.text)
                .join('\n');
            });
            const compactResult = await this.preCompactHandler.process(
              historyText,
              withExecutionSurface(toolExecutionContext, 'reactive_internal')
            );
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
        runScope.onTurn?.({
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

          const toolResults = await this.executeTools(
            response.content,
            options?.stopAfterSuccessfulTools ?? [],
            toolExecutionContext,
            runScope
          );

          // Add tool results to history
          history.push({
            role: 'user',
            content: toolResults,
          });

          // Notify turn callback for tool results
          runScope.onTurn?.({
            turn,
            role: 'user',
            content: toolResults,
          });

          const stopAfterSuccessfulTools = options?.stopAfterSuccessfulTools ?? [];
          const shouldStopAfterTool =
            stopAfterSuccessfulTools.length > 0 &&
            toolUseBlocks.some(
              (toolUse) =>
                stopAfterSuccessfulTools.includes(toolUse.name) &&
                toolResults.some((result) => result.tool_use_id === toolUse.id && !result.is_error)
            );

          if (shouldStopAfterTool) {
            stopReason = 'end_turn';
            break;
          }
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

      const result = {
        response: finalResponse,
        turns: turn,
        history,
        totalUsage,
        stopReason,
        modelRunId: ownedModelRunId ?? options?.modelRunId ?? null,
      };
      try {
        await this.drainBackgroundTasks(pendingBackgroundTasks);
        if (ownedModelRunId) {
          await this.mcpExecutor.commitRuntimeModelRun(ownedModelRunId, 'agent_loop completed');
          ownedModelRunCommitted = true;
        }
      } catch (finalizationError) {
        logger.warn(
          `AgentLoop post-run finalization failed: ${
            finalizationError instanceof Error
              ? finalizationError.message
              : String(finalizationError)
          }`
        );
      }
      return result;
    } catch (error) {
      if (ownedModelRunId && !ownedModelRunCommitted) {
        try {
          const summary = error instanceof Error ? error.message : String(error);
          await this.mcpExecutor.failRuntimeModelRun(ownedModelRunId, summary);
        } catch (failError) {
          logger.warn(
            `Failed to mark model run ${ownedModelRunId} failed: ${
              failError instanceof Error ? failError.message : String(failError)
            }`
          );
        }
      }
      throw error;
    } finally {
      // Always release session lock, even on error
      // BUT only if we own the session (not passed by caller)
      if (ownedSession) {
        this.sessionPool.releaseSession(channelKey);
      }
    }
  }

  private shouldBeginModelRun(options?: AgentLoopOptions): boolean {
    return this.isGatewayMode && !options?.modelRunId;
  }

  private withBackgroundTaskRegistry(
    context: AgentToolExecutionContext | null,
    backgroundTasks: BackgroundTaskRegistry
  ): AgentToolExecutionContext | null {
    if (!context) {
      return null;
    }
    return {
      ...context,
      backgroundTasks,
    };
  }

  private async drainBackgroundTasks(tasks: Promise<unknown>[]): Promise<void> {
    for (let index = 0; index < tasks.length; index += 1) {
      await tasks[index];
    }
  }

  private buildModelRunInput(
    options?: AgentLoopOptions,
    resolvedCliSessionId?: string | null
  ): BeginModelRunInput {
    const agentContext = options?.agentContext;
    return {
      model_id: options?.model ?? this.model ?? null,
      model_provider: this.backend,
      agent_id:
        options?.envelope?.agent_id ??
        (agentContext?.source === 'viewer'
          ? 'os-agent'
          : (agentContext?.roleName ?? options?.source ?? 'agent')),
      instance_id: options?.envelope?.instance_id ?? agentContext?.session?.sessionId ?? null,
      envelope_hash: options?.envelope?.envelope_hash ?? null,
      parent_model_run_id: options?.parentModelRunId ?? null,
      status: 'running',
      input_refs: {
        source: options?.source ?? agentContext?.source ?? 'default',
        channelId: options?.channelId ?? agentContext?.session?.channelId ?? this.sessionKey,
        entrypoint: 'agent_loop',
        ...(options?.sourceTurnId ? { sourceTurnId: options.sourceTurnId } : {}),
        ...(options?.sourceMessageRef ? { sourceMessageRef: options.sourceMessageRef } : {}),
        ...(resolvedCliSessionId ? { cliSessionId: resolvedCliSessionId } : {}),
      },
    };
  }

  /**
   * Execute tools from response content blocks
   */
  private async executeTools(
    content: ContentBlock[],
    stopAfterSuccessfulTools: string[] = [],
    executionContext: AgentToolExecutionContext | null = null,
    runScope: RunScope = { tier: 1 }
  ): Promise<ToolResultBlock[]> {
    const modelToolContext = withExecutionSurface(executionContext, 'model_tool');
    const reactiveInternalContext = withExecutionSurface(executionContext, 'reactive_internal');
    const toolUseBlocks = content.filter(
      (block): block is ToolUseBlock => block.type === 'tool_use'
    );

    const results: ToolResultBlock[] = [];

    for (const toolUse of toolUseBlocks) {
      let result: string;
      let isError = false;
      const executionToolName =
        toolUse.name === CODE_ACT_MCP_COMPAT_NAME ? CODE_ACT_MARKER : toolUse.name;

      // Notify stream: tool execution starting
      runScope.streamCallbacks?.onToolUse?.(
        executionToolName,
        toolUse.input as Record<string, unknown>
      );

      const toolStart = Date.now();
      try {
        // PreToolUse: search MAMA for contracts before Write operations
        let contractContext = '';
        if (executionToolName === 'Write' && toolUse.input) {
          contractContext = await this.searchContractsForTool(
            executionToolName,
            toolUse.input as GatewayToolInput,
            reactiveInternalContext
          );
        }

        const toolResult = await this.mcpExecutor.execute(
          executionToolName,
          toolUse.input as GatewayToolInput,
          modelToolContext ?? undefined
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
        runScope.onToolUse?.(executionToolName, toolUse.input, toolResult);

        // PostToolUse: auto-extract contracts (fire-and-forget)
        this.postToolHandler?.processInBackground(
          executionToolName,
          toolUse.input,
          toolResult,
          reactiveInternalContext
        );

        // Notify stream: tool completed (check actual status)
        runScope.streamCallbacks?.onToolComplete?.(executionToolName, toolUse.id, isError);
        // Emit tool execution metric
        this.onMetric?.('tool_duration_ms', Date.now() - toolStart, {
          tool: executionToolName,
          error: String(isError),
        });
      } catch (error) {
        isError = true;
        result = error instanceof Error ? error.message : String(error);

        // Notify tool use callback with error
        runScope.onToolUse?.(executionToolName, toolUse.input, { error: result });
        this.onMetric?.('tool_duration_ms', Date.now() - toolStart, {
          tool: executionToolName,
          error: 'true',
        });

        // Notify stream: tool completed with error
        runScope.streamCallbacks?.onToolComplete?.(executionToolName, toolUse.id, true);
      }

      results.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: result,
        is_error: isError,
      });

      if (!isError && stopAfterSuccessfulTools.includes(executionToolName)) {
        break;
      }
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
    input: GatewayToolInput,
    executionContext: AgentToolExecutionContext | null = null
  ): Promise<string> {
    try {
      const filePath = (input as { path?: string }).path;
      if (!filePath) {
        return '';
      }

      const fileName = filePath.split('/').pop() || filePath;
      const searchQuery = `contract ${fileName}`;

      const searchResult = await this.mcpExecutor.execute(
        'mama_search',
        {
          query: searchQuery,
          limit: 3,
        },
        executionContext ?? undefined
      );

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
   * Remove tool_call and code_act blocks from text (to avoid duplication in response)
   */
  private removeToolCallBlocks(text: string): string {
    let result = text.replace(/```tool_call\s*\n[\s\S]*?\n```/g, '');
    if (this.useCodeAct) {
      result = result.replace(/```(?:js|javascript)\s*\n[\s\S]*?\n```/g, '');
    }
    return result.trim();
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

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    try {
      // Stop the model runner
      await this.agent.stop();

      const waitUntil = Date.now() + 5000;
      while (this.laneManager.getTotalQueueSize() > 0 && Date.now() < waitUntil) {
        await new Promise((resolve) => setTimeout(resolve, 50));
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
