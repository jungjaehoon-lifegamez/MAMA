/**
 * Memory Agent initialization.
 *
 * Extracted from cli/commands/start.ts to keep the orchestrator thin.
 * All logic and function signatures are unchanged.
 *
 * Responsibilities:
 *   1. Loads memory agent persona via ensureMemoryPersona()
 *   2. Creates memoryAgentContext (AgentContext)
 *   3. Constructs a new AgentLoop for the memory agent (model: claude-sonnet-4-6, maxTurns: 3, tools: mama_search/mama_save)
 *   4. Creates memoryProcessManager with getSharedProcess().sendMessage() implementation:
 *      - Bootstrap delivery (first-time only, with lock)
 *      - Decision count tracking (before/after)
 *      - buildMemoryAuditAckFromAgentResult for ack classification
 *   5. Wires to messageRouter.setMemoryAgent()
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

import type { MAMAConfig } from '../config/types.js';
import { expandPath } from '../config/config-manager.js';
import type { OAuthManager } from '../../auth/index.js';
import { AgentLoop } from '../../agent/index.js';
import type { AgentContext, MAMAApiInterface } from '../../agent/types.js';
import type { MessageRouter } from '../../gateways/message-router.js';
import type { MemoryAgentProcessManagerLike } from '../../gateways/message-router.js';
import {
  buildStandaloneMemoryBootstrap,
  formatMemoryBootstrap,
} from '../../memory/bootstrap-context.js';
import { buildMemoryAuditAckFromAgentResult } from '../../memory/memory-agent-ack.js';
import { deriveMemoryScopes } from '../../memory/scope-context.js';
import type { MAMAApiShape } from './types.js';
import type { MamaApiClient } from '../../gateways/context-injector.js';

/**
 * Result returned by initMemoryAgent.
 */
export interface MemoryAgentInitResult {
  memoryAgentLoop: AgentLoop | null;
}

/**
 * Initialize the memory agent (persistent process for fact extraction).
 *
 * On success, wires memoryProcessManager into messageRouter via setMemoryAgent().
 * On failure, logs a non-fatal warning and returns { memoryAgentLoop: null }.
 */
export async function initMemoryAgent(
  oauthManager: OAuthManager,
  config: MAMAConfig,
  mamaApi: MAMAApiShape,
  mamaApiClient: MamaApiClient,
  messageRouter: MessageRouter,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _runtimeBackend: string
): Promise<MemoryAgentInitResult> {
  // getAdapter is used directly for DB queries after initDB has run
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getAdapter } = require('@jungjaehoon/mama-core/db-manager');

  let memoryAgentLoop: AgentLoop | null = null;

  // Initialize memory agent (persistent process for fact extraction)
  try {
    const { ensureMemoryPersona } = await import('../../multi-agent/memory-agent-persona.js');

    const personaPath = ensureMemoryPersona();
    const memoryPersona = readFileSync(personaPath, 'utf-8');
    const memoryAgentContext: AgentContext = {
      source: 'memory-agent',
      platform: 'cli',
      roleName: 'memory_agent',
      role: {
        allowedTools: ['mama_search', 'mama_save'],
        blockedTools: ['Read', 'Write', 'Bash', 'Grep', 'Glob', 'Edit'],
        systemControl: false,
        sensitiveAccess: false,
      },
      session: {
        sessionId: 'memory-agent:shared',
        channelId: 'shared',
        startedAt: new Date(),
      },
      capabilities: ['mama_search', 'mama_save'],
      limitations: ['No file or shell access'],
      tier: 2,
      backend: 'claude',
    };

    const memoryAgentConfig = config.multi_agent?.agents?.memory;
    const memoryBackend = (memoryAgentConfig?.backend === 'codex-mcp' ? 'codex-mcp' : 'claude') as
      | 'claude'
      | 'codex-mcp';
    const memoryModel =
      memoryAgentConfig?.model ||
      (memoryBackend === 'claude' ? 'claude-sonnet-4-6' : config.agent.model);
    memoryAgentLoop = new AgentLoop(
      oauthManager,
      {
        systemPrompt: memoryPersona,
        model: memoryModel,
        maxTurns: 3,
        backend: memoryBackend,
        toolsConfig: {
          gateway: ['mama_search', 'mama_save'],
          mcp: [],
        },
      },
      undefined,
      { mamaApi: mamaApi as MAMAApiInterface }
    );
    memoryAgentLoop.setSessionKey('memory-agent:shared');
    let memoryBootstrapDelivered = false;
    let memoryBootstrapLock: Promise<void> | null = null;
    const memoryWorkspaceProjectId =
      process.env.MAMA_WORKSPACE ||
      expandPath(config.workspace?.path || `${homedir()}/.mama/workspace`);

    const memoryProcessManager = {
      async getSharedProcess() {
        return {
          async sendMessage(
            content: string,
            options?: {
              sourceTurnId?: string;
              sourceMessageRef?: string;
              parentModelRunId?: string;
            }
          ) {
            if (!memoryAgentLoop) {
              throw new Error('Memory agent loop is not initialized');
            }
            if (!memoryBootstrapDelivered && memoryBootstrapLock) {
              await memoryBootstrapLock;
            }

            // Safe: initDB() completed before memoryProcessManager is created.
            const adapter = getAdapter();
            const beforeDecisionCount = Number(
              adapter.prepare('SELECT COUNT(*) AS count FROM decisions').get().count
            );
            let prompt = content;
            let shouldDeliverBootstrap = false;
            let resolveBootstrapLock: (() => void) | undefined;
            let rejectBootstrapLock: ((error?: unknown) => void) | undefined;
            if (!memoryBootstrapDelivered) {
              shouldDeliverBootstrap = true;
              memoryBootstrapLock = new Promise<void>((resolve, reject) => {
                resolveBootstrapLock = resolve;
                rejectBootstrapLock = reject;
              });
              const bootstrap = await buildStandaloneMemoryBootstrap({
                mamaApi: mamaApiClient,
                scopes: deriveMemoryScopes({
                  source: 'memory-agent',
                  channelId: 'shared',
                  projectId: memoryWorkspaceProjectId,
                }),
                currentGoal: 'Maintain current memory truth and audit ongoing conversations',
                mainAgentState: {
                  active_goal: 'Maintain current memory truth and audit ongoing conversations',
                  active_channel: 'shared',
                },
              });
              prompt = `${formatMemoryBootstrap(bootstrap)}\n\n---\n\n${content}`;
            }

            try {
              const result = await memoryAgentLoop.run(prompt, {
                source: 'memory-agent',
                channelId: 'shared',
                agentContext: memoryAgentContext,
                stopAfterSuccessfulTools: ['mama_save'],
                sourceTurnId: options?.sourceTurnId,
                sourceMessageRef: options?.sourceMessageRef,
                parentModelRunId: options?.parentModelRunId,
              });
              const afterDecisionCount = Number(
                adapter.prepare('SELECT COUNT(*) AS count FROM decisions').get().count
              );
              const ack = buildMemoryAuditAckFromAgentResult(
                result,
                beforeDecisionCount,
                afterDecisionCount
              );

              if (shouldDeliverBootstrap) {
                memoryBootstrapDelivered = true;
                if (resolveBootstrapLock) {
                  resolveBootstrapLock();
                }
                memoryBootstrapLock = null;
              }

              return { response: result.response, ack };
            } catch (error) {
              if (shouldDeliverBootstrap) {
                if (rejectBootstrapLock) {
                  rejectBootstrapLock(error);
                }
                memoryBootstrapLock = null;
              }
              throw error;
            }
          },
        };
      },
    };

    messageRouter.setMemoryAgent(memoryProcessManager as MemoryAgentProcessManagerLike);
    console.log('✓ Memory agent initialized');
  } catch (err) {
    console.warn(
      `[memory-agent] Init failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return { memoryAgentLoop };
}
