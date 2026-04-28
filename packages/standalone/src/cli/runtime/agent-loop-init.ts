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
import type { AgentLoopOptions, ContentBlock as AgentContentBlock } from '../../agent/types.js';
import type { ContentBlock as GatewayContentBlock } from '../../gateways/types.js';
import type { AgentLoopClient } from './types.js';
import type { MetricsStore } from '../../observability/metrics-store.js';
import type { SQLiteDatabase } from '../../sqlite.js';
import { insertTokenUsage } from '../../api/index.js';
import { getLatestVersion, upsertMetrics } from '../../db/agent-store.js';
import { syncBuiltinSkills } from './utilities.js';

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
  runtimeBackend: 'claude' | 'codex-mcp',
  options?: { osAgentMode?: boolean }
): AgentLoopInitResult {
  // Reasoning collector for Discord display
  let reasoningLog: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let turnCount = 0;
  let autoRecallUsed = false;
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
  // Viewer frontdoor prefers os-agent config; conductor remains the fallback for legacy installs.
  const frontdoorConfig =
    config.multi_agent?.agents?.['os-agent'] ??
    config.multi_agent?.agents?.conductor ??
    config.multi_agent?.agents?.Conductor;
  const useCodeAct = frontdoorConfig?.useCodeAct === true;

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
      useCodeAct: options?.osAgentMode ? false : useCodeAct,
      toolsConfig: config.agent.tools, // Gateway + MCP hybrid mode
      disallowedTools: osAgentDisallowed,
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
      // Collect reasoning for Discord display
      onTurn: (turn) => {
        turnCount++;
        if (Array.isArray(turn.content)) {
          for (const block of turn.content) {
            if (block.type === 'tool_use') {
              reasoningLog.push(`🔧 ${block.name}`);
            }
          }
        }
      },
      onToolUse: (toolName, _input, result) => {
        // Track tool name (for Code-Act sandbox calls that bypass onTurn)
        if (!reasoningLog.includes(`🔧 ${toolName}`)) {
          reasoningLog.push(`🔧 ${toolName}`);
        }
        // Add tool result summary
        const resultObj = result as { success?: boolean; results?: unknown[]; error?: string };
        if (resultObj?.error) {
          reasoningLog.push(`  ❌ ${resultObj.error}`);
        } else if (resultObj?.results && Array.isArray(resultObj.results)) {
          reasoningLog.push(`  ✓ ${resultObj.results.length} items`);
        } else if (resultObj?.success !== undefined) {
          reasoningLog.push(`  ✓ ${resultObj.success ? 'success' : 'failed'}`);
        }
        console.log(`[Tool] ${toolName} → ${JSON.stringify(result).slice(0, 80)}`);
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
    undefined,
    {
      mamaDbPath: config.database.path.replace(/^~/, homedir()),
    }
  );
  console.log('✓ Lane-based concurrency enabled (reasoning collection)');

  // Build reasoning header for Discord
  const buildReasoningHeader = (turns: number, toolsUsed: string[]): string => {
    const parts: string[] = [];
    if (autoRecallUsed) parts.push('📚 Memory');
    if (toolsUsed.length > 0) parts.push(toolsUsed.join(', '));
    parts.push(`⏱️ ${turns} turns`);
    return `||${parts.join(' | ')}||`;
  };

  // Create AgentLoopClient wrapper (adapts AgentLoopResult -> { response })
  // Also sets session key for lane-based concurrency and includes reasoning
  const agentLoopClient: AgentLoopClient = {
    run: async (prompt: string, options?: AgentLoopOptions) => {
      // Reset reasoning log for new request
      reasoningLog = [];
      turnCount = 0;
      autoRecallUsed = false;

      // Set session key for lane-based concurrency
      if (options?.source && options?.channelId) {
        const sessionKey = `${options.source}:${options.channelId}:${options.userId || 'unknown'}`;
        agentLoop.setSessionKey(sessionKey);
      }

      if (runtimeBackend === 'codex-mcp' && options) {
        // Override role-based model selection for Codex-MCP backend
        options.model = config.agent.model;
      }
      const result = await agentLoop.run(prompt, options);

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
        reasoningLog.filter((l) => l.startsWith('🔧'))
      );
      const response = `${header}\n${result.response}`;
      return { response };
    },
    runWithContent: async (content: GatewayContentBlock[], options?: AgentLoopOptions) => {
      // Reset reasoning log for new request
      reasoningLog = [];
      turnCount = 0;
      autoRecallUsed = false;

      // Set session key for lane-based concurrency
      if (options?.source && options?.channelId) {
        const sessionKey = `${options.source}:${options.channelId}:${options.userId || 'unknown'}`;
        agentLoop.setSessionKey(sessionKey);
      }

      console.log(`[AgentLoop] runWithContent called with ${content.length} blocks`);
      if (runtimeBackend === 'codex-mcp' && options) {
        // Override role-based model selection for Codex-MCP backend
        options.model = config.agent.model;
      }
      const result = await agentLoop.runWithContent(
        content as unknown as AgentContentBlock[],
        options
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
        reasoningLog.filter((l) => l.startsWith('🔧'))
      );
      const response = `${header}\n${result.response}`;
      return { response };
    },
  };

  return { agentLoop, agentLoopClient, useCodeAct };
}
