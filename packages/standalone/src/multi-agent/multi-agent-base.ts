/**
 * Multi-Agent Handler Base
 *
 * Abstract base class for platform-specific multi-agent handlers.
 * Contains shared infrastructure (orchestrator, process manager, queues,
 * delegation, background tasks) so Discord and Slack handlers only
 * implement platform-specific messaging and formatting.
 */

import type { MultiAgentConfig, AgentPersonaConfig, ChainState } from './types.js';
import { MultiAgentOrchestrator } from './orchestrator.js';
import { AgentProcessManager } from './agent-process-manager.js';
import { getSharedContextManager, type SharedContextManager } from './shared-context.js';
import type { PersistentProcessOptions } from '../agent/persistent-cli-process.js';
import { AgentMessageQueue } from './agent-message-queue.js';
import { BackgroundTaskManager, type BackgroundTask } from './background-task-manager.js';
import { SystemReminderService } from './system-reminder.js';
import { DelegationManager } from './delegation-manager.js';
import { PRReviewPoller } from './pr-review-poller.js';
import { WorkTracker } from './work-tracker.js';
import type { GatewayToolExecutor } from '../agent/gateway-tool-executor.js';
import type { GatewayToolInput } from '../agent/types.js';

/** Default timeout for agent responses (15 minutes -- must accommodate sub-agent spawns) */
export const AGENT_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Response from a single agent
 */
export interface AgentResponse {
  /** Agent ID */
  agentId: string;
  /** Agent configuration */
  agent: AgentPersonaConfig;
  /** Formatted content (with agent prefix) */
  content: string;
  /** Raw content from Claude */
  rawContent: string;
  /** Response duration in ms */
  duration?: number;
  /** Message ID (set after sending) */
  messageId?: string;
}

/**
 * Multi-agent response result
 */
export interface MultiAgentResponse {
  /** Selected agent IDs */
  selectedAgents: string[];
  /** Selection reason */
  reason:
    | 'explicit_trigger'
    | 'keyword_match'
    | 'default_agent'
    | 'free_chat'
    | 'category_match'
    | 'delegation'
    | 'ultrawork'
    | 'mention_chain'
    | 'none';
  /** Individual agent responses */
  responses: AgentResponse[];
}

/**
 * Abstract base class for platform-specific multi-agent handlers.
 *
 * Subclasses must implement:
 * - getPlatformName() - 'discord' | 'slack'
 * - formatBold(text) - platform-specific bold formatting
 * - extractMentionedAgentIds(content) - platform-specific mention extraction
 * - platformCleanup() - platform-specific cleanup on stopAll()
 */
export abstract class MultiAgentHandlerBase {
  protected config: MultiAgentConfig;
  protected orchestrator: MultiAgentOrchestrator;
  protected processManager: AgentProcessManager;
  protected sharedContext: SharedContextManager;
  protected messageQueue: AgentMessageQueue;
  protected prReviewPoller: PRReviewPoller;
  protected backgroundTaskManager: BackgroundTaskManager;
  protected systemReminder: SystemReminderService;
  protected delegationManager: DelegationManager;
  protected workTracker: WorkTracker;
  protected gatewayToolExecutor: GatewayToolExecutor | null = null;

  /** Whether multi-bot mode is initialized */
  protected multiBotInitialized = false;

  /** Dedup map for delegation mentions with timestamps (prevents double processing) */
  protected processedMentions = new Map<string, number>();

  /** TTL for processed mention entries (5 minutes) */
  protected static readonly MENTION_TTL_MS = 5 * 60 * 1000;

  /** Platform identifier for process manager calls */
  protected abstract getPlatformName(): 'discord' | 'slack';

  /** Platform-specific bold formatting */
  abstract formatBold(text: string): string;

  /** Platform-specific mention extraction from message content */
  abstract extractMentionedAgentIds(content: string): string[];

  /** Platform-specific cleanup called during stopAll() */
  protected abstract platformCleanup(): Promise<void>;

  constructor(config: MultiAgentConfig, processOptions: Partial<PersistentProcessOptions> = {}) {
    this.config = config;
    this.orchestrator = new MultiAgentOrchestrator(config);
    this.processManager = new AgentProcessManager(config, processOptions);
    this.sharedContext = getSharedContextManager();
    this.messageQueue = new AgentMessageQueue();
    this.prReviewPoller = new PRReviewPoller();

    const agentConfigs = Object.entries(config.agents).map(([id, cfg]) => ({ id, ...cfg }));
    this.delegationManager = new DelegationManager(agentConfigs);
    this.workTracker = new WorkTracker();

    this.backgroundTaskManager = new BackgroundTaskManager(
      async (agentId: string, prompt: string): Promise<string> => {
        const process = await this.processManager.getProcess(
          this.getPlatformName(),
          'background',
          agentId
        );
        const result = await process.sendMessage(prompt);
        // Execute any gateway tool calls (discord_send, mama_*) from response text
        const cleaned = await this.executeTextToolCalls(result.response);
        return cleaned;
      },
      { maxConcurrentPerAgent: 2, maxTotalConcurrent: 5 }
    );

    this.systemReminder = new SystemReminderService({
      batchWindowMs: 2000,
      enableChatNotifications: true,
    });

    this.backgroundTaskManager.on('task-started', ({ task }: { task: BackgroundTask }) => {
      this.systemReminder.notify({
        type: 'task-started',
        taskId: task.id,
        description: task.description,
        agentId: task.agentId,
        requestedBy: task.requestedBy,
        channelId: task.channelId,
        timestamp: Date.now(),
      });
    });

    this.backgroundTaskManager.on('task-completed', ({ task }: { task: BackgroundTask }) => {
      this.systemReminder.notify({
        type: 'task-completed',
        taskId: task.id,
        description: task.description,
        agentId: task.agentId,
        requestedBy: task.requestedBy,
        channelId: task.channelId,
        duration: task.duration,
        timestamp: Date.now(),
      });
    });

    this.backgroundTaskManager.on('task-failed', ({ task }: { task: BackgroundTask }) => {
      this.systemReminder.notify({
        type: 'task-failed',
        taskId: task.id,
        description: task.description,
        agentId: task.agentId,
        requestedBy: task.requestedBy,
        channelId: task.channelId,
        error: task.error,
        timestamp: Date.now(),
      });
    });
  }

  /**
   * Setup idle event listeners for agent processes (F7)
   */
  protected setupIdleListeners(): void {
    this.processManager.on('process-created', ({ agentId, process }) => {
      process.on('idle', async () => {
        await this.messageQueue.drain(agentId, process, async (aid, message, response) => {
          await this.sendQueuedResponse(aid, message, response);
        });
      });
    });
  }

  /**
   * Platform-specific queued response handler
   */
  protected abstract sendQueuedResponse(
    agentId: string,
    message: import('./agent-message-queue.js').QueuedMessage,
    response: string
  ): Promise<void>;

  /**
   * Clean up old processed mention entries based on TTL
   */
  protected cleanupProcessedMentions(): void {
    const now = Date.now();
    for (const [key, ts] of this.processedMentions) {
      if (now - ts > MultiAgentHandlerBase.MENTION_TTL_MS) {
        this.processedMentions.delete(key);
      }
    }
  }

  /**
   * Check if multi-agent mode is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Check if mention-based delegation is enabled
   */
  isMentionDelegationEnabled(): boolean {
    return this.config.mention_delegation === true;
  }

  /**
   * Format agent response with display name prefix
   */
  protected formatAgentResponse(agent: AgentPersonaConfig, response: string): string {
    const prefix = `${this.formatBold(agent.display_name)}:`;
    if (
      response.startsWith(prefix) ||
      response.startsWith(`${this.formatBold(agent.display_name)}: `)
    ) {
      return response;
    }
    return `${prefix} ${response}`;
  }

  /**
   * Get orchestrator for direct access
   */
  getOrchestrator(): MultiAgentOrchestrator {
    return this.orchestrator;
  }

  /**
   * Get process manager for direct access
   */
  getProcessManager(): AgentProcessManager {
    return this.processManager;
  }

  /**
   * Get shared context manager
   */
  getSharedContext(): SharedContextManager {
    return this.sharedContext;
  }

  getBackgroundTaskManager(): BackgroundTaskManager {
    return this.backgroundTaskManager;
  }

  getSystemReminder(): SystemReminderService {
    return this.systemReminder;
  }

  /**
   * Get PR Review Poller instance
   */
  getPRReviewPoller(): PRReviewPoller {
    return this.prReviewPoller;
  }

  /**
   * Get work tracker instance
   */
  getWorkTracker(): WorkTracker {
    return this.workTracker;
  }

  /**
   * Set the gateway tool executor for handling tool_use blocks from agents.
   */
  setGatewayToolExecutor(executor: GatewayToolExecutor): void {
    this.gatewayToolExecutor = executor;
  }

  /**
   * Parse ```tool_call blocks from response text (Gateway Tools mode).
   * Returns array of parsed tool calls.
   */
  protected parseToolCallsFromText(
    text: string
  ): Array<{ name: string; input: Record<string, unknown> }> {
    const toolCallRegex = /```tool_call\s*\n([\s\S]*?)\n```/g;
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    let match;

    while ((match = toolCallRegex.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(match[1].trim());
        if (parsed.name) {
          calls.push({ name: parsed.name, input: parsed.input || {} });
        }
      } catch (e) {
        console.warn(`[MultiAgent] Failed to parse tool_call block: ${e}`);
      }
    }

    return calls;
  }

  /**
   * Remove ```tool_call blocks from text (to avoid showing raw JSON to users).
   */
  protected removeToolCallBlocks(text: string): string {
    return text.replace(/```tool_call\s*\n[\s\S]*?\n```/g, '').trim();
  }

  /**
   * Parse and execute gateway tool calls from response text.
   * Returns the cleaned text (with tool_call blocks removed).
   * Tool calls are fire-and-forget (results not returned to Claude).
   */
  protected async executeTextToolCalls(responseText: string): Promise<string> {
    if (!this.gatewayToolExecutor) return responseText;

    const toolCalls = this.parseToolCallsFromText(responseText);
    if (toolCalls.length === 0) return responseText;

    console.log(
      `[MultiAgent] Executing ${toolCalls.length} gateway tool(s): ${toolCalls.map((t) => t.name).join(', ')}`
    );

    for (const toolCall of toolCalls) {
      try {
        const result = await this.gatewayToolExecutor.execute(
          toolCall.name,
          toolCall.input as GatewayToolInput
        );
        console.log(
          `[MultiAgent] Tool ${toolCall.name} succeeded:`,
          JSON.stringify(result).substring(0, 200)
        );
      } catch (error) {
        console.error(
          `[MultiAgent] Tool ${toolCall.name} failed:`,
          error instanceof Error ? error.message : error
        );
      }
    }

    return this.removeToolCallBlocks(responseText);
  }

  /**
   * Build agent availability status section for prompt injection.
   * Shows busy/idle state and queue size for each agent except the current one.
   */
  protected buildAgentStatusSection(excludeAgentId: string): string {
    const states = this.processManager.getAgentStates();
    const enabledAgents = this.orchestrator.getEnabledAgents();
    const lines: string[] = ['## Agent Availability'];

    for (const agent of enabledAgents) {
      if (agent.id === excludeAgentId) continue;
      const state = states.get(agent.id) ?? 'idle';
      const queueSize = this.messageQueue.getQueueSize(agent.id);
      const emoji = state === 'busy' ? '🔴' : state === 'idle' ? '🟢' : '🟡';
      const queueInfo = queueSize > 0 ? ` (${queueSize} queued)` : '';
      lines.push(`- ${emoji} **${agent.display_name}**: ${state}${queueInfo}`);
    }
    return lines.join('\n');
  }

  /**
   * Get chain state for a channel (for debugging)
   */
  getChainState(channelId: string): ChainState {
    return this.orchestrator.getChainState(channelId);
  }

  /**
   * Stop all agent processes and bots
   */
  async stopAll(): Promise<void> {
    this.backgroundTaskManager.destroy();
    this.processManager.stopAll();
    this.prReviewPoller.stopAll();
    await this.platformCleanup();
  }
}
