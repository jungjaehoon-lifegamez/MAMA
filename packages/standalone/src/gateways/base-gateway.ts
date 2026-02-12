/**
 * Base Gateway abstract class
 *
 * Extracts common logic shared across Discord, Slack, and Telegram gateways.
 * Platform-specific behavior is implemented via abstract methods and properties.
 */

import type {
  Gateway,
  GatewayEvent,
  GatewayEventHandler,
  GatewayConfig,
  MessageSource,
} from './types.js';
import { MessageRouter } from './message-router.js';

export interface BaseGatewayOptions {
  messageRouter: MessageRouter;
  config?: Partial<GatewayConfig>;
}

export abstract class BaseGateway implements Gateway {
  abstract readonly source: MessageSource;

  protected messageRouter: MessageRouter;
  protected eventHandlers: GatewayEventHandler[] = [];
  protected connected = false;

  constructor(options: BaseGatewayOptions) {
    this.messageRouter = options.messageRouter;
  }

  // === Abstract methods — platform-specific ===

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract sendMessage(channelId: string, text: string): Promise<void>;
  abstract sendFile(channelId: string, filePath: string, caption?: string): Promise<void>;

  /** Regex to strip bot mentions from message text. null = no stripping. */
  protected abstract get mentionPattern(): RegExp | null;

  // === Common implementations ===

  isConnected(): boolean {
    return this.connected;
  }

  onEvent(handler: GatewayEventHandler): void {
    this.eventHandlers.push(handler);
  }

  protected emitEvent(event: GatewayEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        console.error('Error in gateway event handler:', error);
      }
    }
  }

  protected cleanMessageContent(content: string): string {
    if (!this.mentionPattern) return content.trim();
    return content.replace(this.mentionPattern, '').trim();
  }
}
