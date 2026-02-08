/**
 * Agent Message Queue - Handles message queuing for busy agents
 *
 * Problem: When an agent process is busy, incoming @mentions are silently dropped.
 * Solution: Queue messages per agent, automatically drain when agent becomes idle.
 *
 * Features:
 * - Per-agent FIFO queue
 * - Max 5 messages per agent (oldest dropped when full)
 * - 3-minute TTL (expired messages skipped)
 * - Auto-drain on agent 'idle' event
 *
 * Sprint 3 F7
 */

import type { PersistentClaudeProcess } from '../agent/persistent-cli-process.js';

/**
 * Message context (from multi-agent-slack.ts or multi-agent-discord.ts)
 */
export interface MessageContext {
  channelId: string;
  channelName?: string;
  userId?: string;
  userName?: string;
  messageId?: string;
  threadId?: string;
  files?: Array<{ url: string; name: string; type: string }>;
}

/**
 * Queued message waiting for agent availability
 */
export interface QueuedMessage {
  /** Full prompt to send to agent */
  prompt: string;
  /** Channel ID for response */
  channelId: string;
  /** Thread timestamp (Slack) or message ID (Discord) */
  threadTs?: string;
  /** Message source platform */
  source: 'slack' | 'discord';
  /** When message was enqueued (timestamp) */
  enqueuedAt: number;
  /** Full message context */
  context?: MessageContext;
  /** Discord message ID for emoji queue tracking (⏳→✅) */
  discordMessageId?: string;
}

const MAX_QUEUE_SIZE = 5;
const MESSAGE_TTL_MS = 3 * 60 * 1000; // 3 minutes

/**
 * Agent Message Queue Manager
 *
 * Manages per-agent message queues and automatic draining.
 */
export class AgentMessageQueue {
  private queues: Map<string, QueuedMessage[]> = new Map();

  /**
   * Enqueue a message for a busy agent
   *
   * @param agentId - Agent identifier
   * @param message - Message to queue
   */
  enqueue(agentId: string, message: QueuedMessage): void {
    let queue = this.queues.get(agentId);

    if (!queue) {
      queue = [];
      this.queues.set(agentId, queue);
    }

    // Add message to queue
    queue.push(message);

    // Enforce size limit
    if (queue.length > MAX_QUEUE_SIZE) {
      const dropped = queue.shift();
      console.warn(
        `[MessageQueue] Queue full for ${agentId}, dropped oldest message (waited ${Math.floor((Date.now() - dropped!.enqueuedAt) / 1000)}s)`
      );
    }

    console.log(
      `[MessageQueue] Enqueued message for ${agentId} (queue size: ${queue.length}/${MAX_QUEUE_SIZE})`
    );
  }

  /**
   * Drain queued messages for an agent
   *
   * Called when agent becomes idle. Processes next message in queue.
   *
   * @param agentId - Agent identifier
   * @param process - Agent process to send message to
   * @param sendCallback - Callback to handle sending response to platform
   * @param depth - Recursion depth (internal, for safety)
   */
  async drain(
    agentId: string,
    process: PersistentClaudeProcess,
    sendCallback: (agentId: string, message: QueuedMessage, response: string) => Promise<void>,
    depth: number = 0
  ): Promise<void> {
    // Safety: prevent infinite recursion (should never happen, but defense in depth)
    if (depth >= MAX_QUEUE_SIZE) {
      console.warn(`[MessageQueue] Drain depth limit reached for ${agentId}, stopping`);
      return;
    }

    const queue = this.queues.get(agentId);

    if (!queue || queue.length === 0) {
      return;
    }

    // Get next message
    const message = queue.shift();
    if (!message) {
      return;
    }

    // Check TTL
    const age = Date.now() - message.enqueuedAt;
    if (age > MESSAGE_TTL_MS) {
      console.warn(
        `[MessageQueue] Skipping expired message for ${agentId} (age: ${Math.floor(age / 1000)}s, TTL: ${MESSAGE_TTL_MS / 1000}s)`
      );
      // Try next message if any
      if (queue.length > 0) {
        await this.drain(agentId, process, sendCallback, depth + 1);
      }
      return;
    }

    // Log drain
    const waitedSec = Math.floor(age / 1000);
    const remaining = queue.length;
    console.log(
      `[MessageQueue] Delivering queued message to ${agentId} (waited ${waitedSec}s, queue: ${remaining} remaining)`
    );

    try {
      // Send message to agent process
      const result = await process.sendMessage(message.prompt);

      // Call platform-specific send callback
      await sendCallback(agentId, message, result.response);
    } catch (err) {
      if (err instanceof Error && err.message.includes('Process is busy')) {
        // Agent still busy - don't re-queue (prevent infinite loop)
        console.warn(
          `[MessageQueue] Agent ${agentId} still busy after idle event, dropping message`
        );
      } else {
        // Other error - log and continue
        console.error(`[MessageQueue] Failed to deliver message to ${agentId}:`, err);
      }
    }

    // Try draining next message if any
    if (queue.length > 0) {
      await this.drain(agentId, process, sendCallback, depth + 1);
    }
  }

  /**
   * Get current queue size for an agent
   *
   * @param agentId - Agent identifier
   * @returns Number of queued messages
   */
  getQueueSize(agentId: string): number {
    const queue = this.queues.get(agentId);
    return queue ? queue.length : 0;
  }

  /**
   * Clear expired messages from all queues
   *
   * Should be called periodically (e.g., every minute).
   */
  clearExpired(): void {
    const now = Date.now();
    let totalCleared = 0;

    for (const [agentId, queue] of this.queues.entries()) {
      const before = queue.length;
      const filtered = queue.filter((msg) => now - msg.enqueuedAt < MESSAGE_TTL_MS);

      if (filtered.length !== before) {
        this.queues.set(agentId, filtered);
        const cleared = before - filtered.length;
        totalCleared += cleared;
        console.log(`[MessageQueue] Cleared ${cleared} expired messages for ${agentId}`);
      }

      // Remove empty queues
      if (filtered.length === 0) {
        this.queues.delete(agentId);
      }
    }

    if (totalCleared > 0) {
      console.log(`[MessageQueue] Total expired messages cleared: ${totalCleared}`);
    }
  }

  /**
   * Get all agent IDs with queued messages
   *
   * @returns Array of agent IDs
   */
  getAgentIds(): string[] {
    return Array.from(this.queues.keys());
  }

  /**
   * Clear all queues (for testing)
   */
  clearAll(): void {
    this.queues.clear();
  }
}
