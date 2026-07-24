/**
 * Main AgentLoop + AgentLoopClient initialization.
 *
 * Extracted from cli/commands/start.ts to keep the orchestrator thin.
 * All logic and function signatures are unchanged.
 *
 * Responsibilities:
 *   1. Sets up closure-scoped reasoning state (reasoningLog, turnCount, autoRecallUsed)
 *   2. Checks persona completion and logs onboarding status
 *   3. Determines OS Agent mode and loads capabilities
 *   4. Resolves Code-Act config from conductor agent
 *   5. Creates the main AgentLoop with all options
 *   6. Creates buildReasoningHeader() helper (closure-scoped)
 *   7. Creates agentLoopClient wrapper with run() and runWithContent() methods
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { MAMAConfig } from '../config/types.js';
import type { OAuthManager } from '../../auth/index.js';
import { AgentLoop } from '../../agent/index.js';
import type { GatewayToolExecutor } from '../../agent/index.js';
import type {
  AgentLoopOptions,
  ContentBlock as AgentContentBlock,
  GatewayToolExecutorOptions,
} from '../../agent/types.js';
import type { ContentBlock as GatewayContentBlock } from '../../gateways/types.js';
import type { AgentLoopClient } from './types.js';
import type { EnvelopeIssuanceMode } from './envelope-bootstrap.js';
import type { MetricsStore } from '../../observability/metrics-store.js';
import type { SQLiteDatabase } from '../../sqlite.js';
import { insertTokenUsage } from '../../api/index.js';
import { getLatestVersion, upsertMetrics } from '../../db/agent-store.js';
import { syncBuiltinSkills } from './utilities.js';
import * as debugLogger from '@jungjaehoon/mama-core/debug-logger';

const { DebugLogger } = debugLogger as {
  DebugLogger: new (context?: string) => {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
};
const initLogger = new DebugLogger('AgentLoopInit');

export function summarizeToolResult(result: unknown): string {
  if (!result || typeof result !== 'object') {
    return 'completed';
  }
  const record = result as { success?: unknown; code?: unknown; results?: unknown };
  const code = typeof record.code === 'string' ? ` code=${record.code}` : '';
  if (record.success === false) {
    return `failed${code}`;
  }
  if (Array.isArray(record.results)) {
    return `success items=${record.results.length}${code}`;
  }
  if (record.success === true) {
    return `success${code}`;
  }
  return `completed${code}`;
}

export function appendToolResultReasoning(reasoningLog: string[], result: unknown): void {
  if (!result || typeof result !== 'object') {
    return;
  }
  const resultObj = result as {
    success?: boolean;
    results?: unknown[];
    error?: string;
    code?: string;
  };
  if (resultObj.success === false || resultObj.error) {
    reasoningLog.push(`  ❌ failed${resultObj.code ? ` (${resultObj.code})` : ''}`);
  } else if (Array.isArray(resultObj.results)) {
    reasoningLog.push(`  ✓ ${resultObj.results.length} items`);
  } else if (resultObj.success !== undefined) {
    reasoningLog.push(`  ✓ ${resultObj.success ? 'success' : 'failed'}`);
  }
}

// __dirname is available globally in CJS output (NodeNext compiles to CommonJS)
declare const __dirname: string;

/**
 * Result returned by initMainAgentLoop.
 */
export interface AgentLoopInitResult {
  agentLoop: AgentLoop;
  agentLoopClient: AgentLoopClient;
  /** Whether Code-Act is enabled (derived from conductor agent config) */
  useCodeAct: boolean;
}

/**
 * Initialize the main AgentLoop and AgentLoopClient.
 *
 * The reasoning state (reasoningLog, turnCount, autoRecallUsed) lives as
 * closure-scoped variables inside this function — they are not exposed on
 * the return value. buildReasoningHeader() is also a local helper.
 */
export function initMainAgentLoop(
  config: MAMAConfig,
  oauthManager: OAuthManager,
  db: SQLiteDatabase,
  metricsStore: MetricsStore | null,
  runtimeBackend: 'claude' | 'codex',
  toolExecutor: GatewayToolExecutor,
  options?: {
    osAgentMode?: boolean;
    envelopeIssuanceMode?: EnvelopeIssuanceMode;
    contextCompileService?: GatewayToolExecutorOptions['contextCompileService'];
    wikiPublishAdapter?: GatewayToolExecutorOptions['wikiPublishAdapter'];
  }
): AgentLoopInitResult {
  const mamaHome = join(homedir(), '.mama');

  // Sync built-in skills on every start (non-destructive — skips existing files)
  syncBuiltinSkills();

  const personaComplete =
    existsSync(join(mamaHome, 'USER.md')) && existsSync(join(mamaHome, 'SOUL.md'));

  const systemPrompt = '';
  let osCapabilities = '';

  if (!personaComplete) {
    // Onboarding is handled exclusively by the Setup Wizard (/setup).
    // OS agent runs in normal mode — no onboarding prompt injection.
    console.log('⚙️  Onboarding incomplete (use /setup wizard to complete)');
  } else {
    console.log('✓ Persona loaded (chat mode)');
  }

  // OS Agent mode (Viewer context only)
  if (options?.osAgentMode === true) {
    const osAgentPaths = [
      join(__dirname, '../../agent/os-agent-capabilities.md'),
      join(__dirname, '../../../src/agent/os-agent-capabilities.md'),
    ];
    const osAgentPath = osAgentPaths.find((candidate) => existsSync(candidate));
    if (osAgentPath) {
      osCapabilities = readFileSync(osAgentPath, 'utf-8');
      console.log('[start] ✓ OS Agent mode enabled (system control capabilities)');
    }
  }

  // Initialize agent loop with lane-based concurrency and reasoning collection
  // Viewer frontdoor prefers an explicit os-agent value; conductor remains the
  // field-level fallback for normalized legacy installs.
  const osAgentUseCodeAct = config.multi_agent?.agents?.['os-agent']?.useCodeAct;
  const conductorUseCodeAct =
    config.multi_agent?.agents?.conductor?.useCodeAct ??
    config.multi_agent?.agents?.Conductor?.useCodeAct;
  const useCodeAct =
    options?.osAgentMode === true ? false : (osAgentUseCodeAct ?? conductorUseCodeAct ?? true);

  // OS Agent mode: block sub-agent-specific tools to force delegation.
  // The OS agent must use delegate() instead of doing sub-agent work directly.
  const osAgentDisallowed = options?.osAgentMode
    ? ['report_publish', 'wiki_publish', 'obsidian', 'code_act', 'mcp__code-act__code_act']
    : undefined;

  const agentLoop = new AgentLoop(
    oauthManager,
    {
      backend: runtimeBackend,
      model: config.agent.model,
      timeoutMs: config.agent.timeout,
      maxTurns: config.agent.max_turns,
      useCodeAct,
      toolsConfig: config.agent.tools, // Gateway + MCP hybrid mode
      disallowedTools: osAgentDisallowed,
      // Gateway tools are the ONLY tool surface for the daemon persona
      // (owner decision D2, 2026-07-16). MAMA_PERSONA_NATIVE_TOOLS=1 re-enables.
      // NOTE: consumed only by the claude PersistentCLIAdapter branch - on a
      // Codex backend: this option is a no-op (log below keeps that loud).
      builtinTools:
        process.env.MAMA_PERSONA_NATIVE_TOOLS === '1' ||
        process.env.MAMA_PERSONA_NATIVE_TOOLS?.toLowerCase() === 'true'
          ? undefined
          : '',
      // Root fix (2026-07-16): share the boot-wired executor so every dependency
      // wiring reaches the persona lane by construction (no second private twin).
      executor: toolExecutor,
      useLanes: true, // Enable lane-based concurrency for Discord
      // SECURITY MODEL: MAMA OS is a headless daemon — no TTY for interactive permission prompts.
      // Permission enforcement is handled by MAMA's own RoleManager layer:
      //   - config.yaml roles.definitions.*.allowedTools / blockedTools / allowedPaths
      //   - Multi-agent ToolPermissionManager (tier-based tool access)
      //   - Source-based role mapping (viewer=os_agent, discord=chat_bot, etc.)
      // Headless daemon — no TTY for interactive permission prompts.
      // Security is enforced at the API/network layer (auth-middleware), not Claude CLI permissions.
      dangerouslySkipPermissions: config.multi_agent?.dangerouslySkipPermissions ?? true,
      sessionKey: 'default', // Will be updated per message
      systemPrompt: systemPrompt + (osCapabilities ? '\n\n---\n\n' + osCapabilities : ''),
      // Per-run reasoning collection moved to per-call options (review M2:
      // shared closure state contaminated overlapping operator/chat runs).
      // The instance handler keeps only the log side effect for runs that
      // pass no per-call handler (operator report/worker lanes).
      onToolUse: (toolName, _input, result) => {
        initLogger.info(`[Tool] ${toolName} -> ${summarizeToolResult(result)}`);
      },
      onTokenUsage: (record) => {
        try {
          const metricVersion =
            record.agent_id && typeof record.agent_version !== 'number'
              ? (getLatestVersion(db, record.agent_id)?.version ?? null)
              : (record.agent_version ?? null);
          const recordWithVersion =
            metricVersion !== null ? { ...record, agent_version: metricVersion } : record;

          insertTokenUsage(db, recordWithVersion);
          // Also upsert agent_metrics if agent_id is known
          if (record.agent_id) {
            if (metricVersion !== null) {
              const today = new Date().toISOString().slice(0, 10);
              upsertMetrics(db, {
                agent_id: record.agent_id,
                agent_version: metricVersion,
                period_start: today,
                input_tokens: record.input_tokens,
                output_tokens: record.output_tokens,
              });
            }
          }
        } catch {
          /* ignore — agent tables may not be initialized yet */
        }
      },
      onMetric: (name, value, labels) => {
        metricsStore?.record({ name, value, labels });
      },
    },
    undefined
  );
  if (runtimeBackend !== 'claude') {
    console.log(
      '[agent-loop-init] builtinTools lockdown is a no-op on the codex backend (native-tool surface is claude CLI only)'
    );
  }
  console.log('✓ Lane-based concurrency enabled (reasoning collection)');

  // Build reasoning header for Discord
  const buildReasoningHeader = (
    turns: number,
    toolsUsed: string[],
    autoRecallUsed: boolean
  ): string => {
    const parts: string[] = [];
    if (autoRecallUsed) {
      parts.push('📚 Memory');
    }
    if (toolsUsed.length > 0) {
      parts.push(toolsUsed.join(', '));
    }
    parts.push(`⏱️ ${turns} turns`);
    return `||${parts.join(' | ')}||`;
  };

  // Per-call reasoning collectors (review M2): each request collects into its
  // OWN array via per-call options - overlapping operator/chat runs on the
  // same AgentLoop can no longer contaminate each other's reasoning headers.
  const withReasoningCollectors = (
    options: AgentLoopOptions | undefined,
    reasoningLog: string[]
  ): AgentLoopOptions => ({
    ...(options ?? {}),
    onTurn: (turn) => {
      if (Array.isArray(turn.content)) {
        for (const block of turn.content) {
          if (block.type === 'tool_use') {
            reasoningLog.push(`🔧 ${block.name}`);
          }
        }
      }
      options?.onTurn?.(turn);
    },
    onToolUse: (toolName, input, result) => {
      if (!reasoningLog.includes(`🔧 ${toolName}`)) {
        reasoningLog.push(`🔧 ${toolName}`);
      }
      appendToolResultReasoning(reasoningLog, result);
      initLogger.info(`[Tool] ${toolName} -> ${summarizeToolResult(result)}`);
      options?.onToolUse?.(toolName, input, result);
    },
  });

  // Create AgentLoopClient wrapper (adapts AgentLoopResult -> { response })
  // Also sets session key for lane-based concurrency and includes reasoning
  const agentLoopClient: AgentLoopClient = {
    run: async (prompt: string, options?: AgentLoopOptions) => {
      // Per-call reasoning state (review M2: module-level state crossed runs
      // once operator lanes could overlap chat).
      const reasoningLog: string[] = [];
      let autoRecallUsed = false;
      const callOptions = withReasoningCollectors(options, reasoningLog);

      // Per-call session key for lane-based concurrency. Never mutate the
      // shared AgentLoop: setSessionKey here raced overlapping runs, sending
      // them down the wrong lane (observed as polluted default:* sessions).
      if (!options?.sessionKey && options?.source && options?.channelId) {
        callOptions.sessionKey = `${options.source}:${options.channelId}:${options.userId || 'unknown'}`;
      }

      if (runtimeBackend === 'codex') {
        // Override role-based model selection for the Codex backend.
        callOptions.model = config.agent.model;
      }
      const result = await agentLoop.run(prompt, callOptions);

      // Check if auto-recall was used (by checking if relevant-memories was in the history)
      if (result.history && result.history.length > 0) {
        const firstMsg = result.history[0];
        if (firstMsg && Array.isArray(firstMsg.content)) {
          const textContent = firstMsg.content.find((b: { type: string }) => b.type === 'text');
          if (
            textContent &&
            typeof (textContent as { text?: string }).text === 'string' &&
            (textContent as { text: string }).text.includes('<relevant-memories>')
          ) {
            autoRecallUsed = true;
          }
        }
      }

      // Always prepend reasoning header
      const header = buildReasoningHeader(
        result.turns,
        reasoningLog.filter((l) => l.startsWith('🔧')),
        autoRecallUsed
      );
      const response = `${header}\n${result.response}`;
      return { response };
    },
    runWithContent: async (content: GatewayContentBlock[], options?: AgentLoopOptions) => {
      // Per-call reasoning state (review M2).
      const reasoningLog: string[] = [];
      let autoRecallUsed = false;
      const callOptions = withReasoningCollectors(options, reasoningLog);

      // Per-call session key (see run() above: no shared-instance mutation).
      if (!options?.sessionKey && options?.source && options?.channelId) {
        callOptions.sessionKey = `${options.source}:${options.channelId}:${options.userId || 'unknown'}`;
      }

      console.log(`[AgentLoop] runWithContent called with ${content.length} blocks`);
      if (runtimeBackend === 'codex') {
        // Override role-based model selection for the Codex backend.
        callOptions.model = config.agent.model;
      }
      const result = await agentLoop.runWithContent(
        content as unknown as AgentContentBlock[],
        callOptions
      );

      // Check if auto-recall was used
      if (result.history && result.history.length > 0) {
        const firstMsg = result.history[0];
        if (firstMsg && Array.isArray(firstMsg.content)) {
          const textContent = firstMsg.content.find((b: { type: string }) => b.type === 'text');
          if (
            textContent &&
            typeof (textContent as { text?: string }).text === 'string' &&
            (textContent as { text: string }).text.includes('<relevant-memories>')
          ) {
            autoRecallUsed = true;
          }
        }
      }

      // Always prepend reasoning header
      const header = buildReasoningHeader(
        result.turns,
        reasoningLog.filter((l) => l.startsWith('🔧')),
        autoRecallUsed
      );
      const response = `${header}\n${result.response}`;
      // totalUsage must survive this wrapper: workerRun reads it for the
      // Stage-2 token telemetry (0.27.5). The first live run under 0.27.5
      // recorded NULL because this return stripped the field - the structural
      // WorkerRunner type could not catch a concrete wrapper dropping it.
      return { response, totalUsage: result.totalUsage };
    },
  };

  return { agentLoop, agentLoopClient, useCodeAct };
}
