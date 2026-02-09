/**
 * Shared Context for Multi-Agent Communication
 *
 * Manages inter-agent message sharing so each agent is aware of
 * what other agents have said in the conversation.
 */

import type { AgentPersonaConfig } from './types.js';

/**
 * Message entry in shared context
 */
export interface SharedMessage {
  /** Agent ID that sent the message (null for human) */
  agentId: string | null;
  /** Display name of the sender */
  displayName: string;
  /** Message content */
  content: string;
  /** Timestamp */
  timestamp: number;
  /** Discord message ID */
  messageId?: string;
  /** Whether this is a human message */
  isHuman: boolean;
}

/**
 * Channel context containing recent messages
 */
export interface ChannelContext {
  /** Channel ID */
  channelId: string;
  /** Recent messages (limited to last N) */
  messages: SharedMessage[];
  /** Last update timestamp */
  lastUpdate: number;
}

/**
 * Shared Context Manager
 *
 * Maintains a sliding window of recent messages per channel
 * so agents can be aware of the conversation context.
 */
export class SharedContextManager {
  /** Context per channel: Map<channelId, ChannelContext> */
  private contexts: Map<string, ChannelContext> = new Map();

  /** Maximum messages to keep per channel */
  private readonly maxMessages: number;

  /** Maximum age of messages in ms (default: 10 minutes) */
  private readonly maxAge: number;

  constructor(options: { maxMessages?: number; maxAgeMs?: number } = {}) {
    this.maxMessages = options.maxMessages || 20;
    this.maxAge = options.maxAgeMs || 10 * 60 * 1000; // 10 minutes
  }

  /**
   * Record a human message
   */
  recordHumanMessage(
    channelId: string,
    username: string,
    content: string,
    messageId?: string
  ): void {
    this.recordMessage(channelId, {
      agentId: null,
      displayName: username,
      content,
      timestamp: Date.now(),
      messageId,
      isHuman: true,
    });
  }

  /**
   * Record a system/automated message (e.g., PR Review Poller)
   * Shows up in context but isn't from a human or a specific agent.
   */
  recordSystemMessage(
    channelId: string,
    displayName: string,
    content: string,
    messageId?: string
  ): void {
    this.recordMessage(channelId, {
      agentId: 'system',
      displayName,
      content,
      timestamp: Date.now(),
      messageId,
      isHuman: false,
    });
  }

  /**
   * Record an agent message
   */
  recordAgentMessage(
    channelId: string,
    agent: AgentPersonaConfig,
    content: string,
    messageId?: string
  ): void {
    this.recordMessage(channelId, {
      agentId: agent.id,
      displayName: agent.display_name,
      content,
      timestamp: Date.now(),
      messageId,
      isHuman: false,
    });
  }

  /**
   * Record a message to the channel context
   */
  private recordMessage(channelId: string, message: SharedMessage): void {
    let context = this.contexts.get(channelId);

    if (!context) {
      context = {
        channelId,
        messages: [],
        lastUpdate: Date.now(),
      };
      this.contexts.set(channelId, context);
    }

    // Add message
    context.messages.push(message);
    context.lastUpdate = Date.now();

    // Trim old messages
    this.trimContext(context);
  }

  /**
   * Trim context to max messages and max age
   */
  private trimContext(context: ChannelContext): void {
    const now = Date.now();

    // Remove old messages
    context.messages = context.messages.filter((msg) => now - msg.timestamp < this.maxAge);

    // Keep only last N messages
    if (context.messages.length > this.maxMessages) {
      context.messages = context.messages.slice(-this.maxMessages);
    }
  }

  /**
   * Get context for a channel
   */
  getContext(channelId: string): ChannelContext | undefined {
    const context = this.contexts.get(channelId);
    if (context) {
      this.trimContext(context);
    }
    return context;
  }

  /**
   * Get recent messages for a channel
   */
  getRecentMessages(channelId: string, limit?: number): SharedMessage[] {
    const context = this.getContext(channelId);
    if (!context) return [];

    const messages = context.messages;
    if (limit && limit < messages.length) {
      return messages.slice(-limit);
    }
    return [...messages];
  }

  /**
   * Build context string for agent prompt injection
   * Excludes messages from the requesting agent to avoid self-reference
   */
  buildContextForAgent(channelId: string, excludeAgentId: string, maxMessages = 5): string {
    const messages = this.getRecentMessages(channelId, maxMessages + 1);

    // Filter out the agent's own messages
    const otherMessages = messages.filter((msg) => msg.agentId !== excludeAgentId);

    if (otherMessages.length === 0) {
      return '';
    }

    // Take only the requested number after filtering
    const relevantMessages = otherMessages.slice(-maxMessages);

    const lines = relevantMessages.map((msg) => {
      const prefix = msg.isHuman ? '👤' : '🤖';
      return `${prefix} **${msg.displayName}**: ${this.truncate(msg.content, 800)}`;
    });

    return `## Recent Conversation Context\n${lines.join('\n')}`;
  }

  /**
   * Get the last message from another agent (for response chaining)
   */
  getLastAgentMessage(channelId: string, excludeAgentId?: string): SharedMessage | null {
    const messages = this.getRecentMessages(channelId);

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!msg.isHuman && msg.agentId !== excludeAgentId) {
        return msg;
      }
    }

    return null;
  }

  /**
   * Get the last human message in a channel
   */
  getLastHumanMessage(channelId: string): SharedMessage | null {
    const messages = this.getRecentMessages(channelId);

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.isHuman) {
        return msg;
      }
    }

    return null;
  }

  /**
   * Check if a specific agent has responded since the last human message
   */
  hasAgentRespondedSinceHuman(channelId: string, agentId: string): boolean {
    const messages = this.getRecentMessages(channelId);

    let lastHumanIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].isHuman) {
        lastHumanIndex = i;
        break;
      }
    }

    if (lastHumanIndex === -1) {
      // No human message found, check all messages
      return messages.some((msg) => msg.agentId === agentId);
    }

    // Check messages after the last human message
    for (let i = lastHumanIndex + 1; i < messages.length; i++) {
      if (messages[i].agentId === agentId) {
        return true;
      }
    }

    return false;
  }

  /**
   * Clear context for a channel
   */
  clearChannel(channelId: string): void {
    this.contexts.delete(channelId);
  }

  /**
   * Clear all contexts
   */
  clearAll(): void {
    this.contexts.clear();
  }

  /**
   * Get all channel IDs with active contexts
   */
  getActiveChannels(): string[] {
    return Array.from(this.contexts.keys());
  }

  /**
   * Truncate text to max length
   */
  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 3) + '...';
  }
}

/**
 * Singleton instance for global shared context
 */
let sharedContextManager: SharedContextManager | null = null;

/**
 * Get or create the shared context manager singleton
 */
export function getSharedContextManager(options?: {
  maxMessages?: number;
  maxAgeMs?: number;
}): SharedContextManager {
  if (!sharedContextManager) {
    sharedContextManager = new SharedContextManager(options);
  }
  return sharedContextManager;
}

/**
 * Reset the shared context manager (for testing)
 */
export function resetSharedContextManager(): void {
  sharedContextManager = null;
}
