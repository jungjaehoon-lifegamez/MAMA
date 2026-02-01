/**
 * Streaming Callback Manager
 *
 * Coordinates callbacks between ClaudeClient and Discord gateway.
 * Manages placeholder message creation, text accumulation, and error handling.
 */

import type { Message } from 'discord.js';
import type { ClaudeResponse } from './types.js';

/**
 * Interface for Discord gateway operations
 */
export interface DiscordGatewayInterface {
  /**
   * Edit a message with throttling to prevent rate limits
   * @param message Discord message to edit
   * @param content New message content
   */
  editMessageThrottled(message: Message, content: string): Promise<void>;
}

/**
 * Manages streaming callbacks and coordinates with Discord gateway
 *
 * Responsibilities:
 * - Create placeholder message before streaming starts
 * - Accumulate text deltas and update Discord message
 * - Track tool use events
 * - Handle errors and update placeholder with error message
 * - Clean up references after streaming completes
 */
export class StreamingCallbackManager {
  private placeholderMessage: Message | null = null;
  private accumulatedText = '';

  /**
   * Create a new streaming callback manager
   * @param discordGateway Discord gateway for message operations
   * @param originalMessage Original message to reply to
   */
  constructor(
    private discordGateway: DiscordGatewayInterface,
    private originalMessage: Message
  ) {}

  /**
   * Create a placeholder message to be updated with streaming content
   * @throws Error if message creation fails
   */
  async createPlaceholder(): Promise<void> {
    this.placeholderMessage = await this.originalMessage.reply('⏳ Processing...');
  }

  /**
   * Handle text delta from streaming response
   * Accumulates text and updates Discord message
   * @param text Text delta to add
   */
  async onDelta(text: string): Promise<void> {
    this.accumulatedText += text;
    if (this.placeholderMessage) {
      await this.discordGateway.editMessageThrottled(this.placeholderMessage, this.accumulatedText);
    }
  }

  /**
   * Handle tool use event
   * @param name Tool name
   * @param _input Tool input
   */
  onToolUse(name: string, _input: unknown): void {
    console.log(`[Streaming] Tool called: ${name}`);
  }

  /**
   * Handle final response from streaming
   * @param _response Final Claude response
   */
  async onFinal(_response: ClaudeResponse): Promise<void> {
    console.log('[Streaming] Stream complete');
    // Final flush handled by Discord gateway's throttle mechanism
  }

  /**
   * Handle error during streaming
   * Updates placeholder message with error information
   * @param error Error that occurred
   */
  async onError(error: Error): Promise<void> {
    console.error('[Streaming] Error:', error);
    if (this.placeholderMessage) {
      await this.placeholderMessage.edit(
        `❌ Translation failed: ${error.message}\n\nPlease try again or use a smaller image.`
      );
    }
  }

  /**
   * Clean up resources and clear references
   * Should be called after streaming completes
   */
  async cleanup(): Promise<void> {
    this.placeholderMessage = null;
    this.accumulatedText = '';
  }

  /**
   * Get the current placeholder message
   * @returns Placeholder message or null if not created
   */
  getPlaceholderMessage(): Message | null {
    return this.placeholderMessage;
  }

  /**
   * Get the accumulated text so far
   * @returns Accumulated text content
   */
  getAccumulatedText(): string {
    return this.accumulatedText;
  }
}
