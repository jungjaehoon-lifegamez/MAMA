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
import type { ProcessingResult, ProcessOptions, TurnProcessor } from './message-router.js';

export interface BaseGatewayOptions {
  /**
   * How a turn is processed. Required, because this is what a user-facing surface
   * actually needs; the concrete router is an extra capability, not the dependency.
   */
  turnProcessor: TurnProcessor;
  /**
   * Optional. Only surfaces that read session data for their own display concerns -
   * naming a channel, listing what is active - need the concrete router. A surface that
   * only serves turns must not reach past the contract.
   */
  messageRouter?: MessageRouter;
  config?: Partial<GatewayConfig>;
}

export abstract class BaseGateway implements Gateway {
  abstract readonly source: MessageSource;

  protected messageRouter?: MessageRouter;
  /**
   * The turn seam, shared by every user-facing surface.
   *
   * Telegram, Discord and Slack are ONE role - the place a person reaches the agent - so
   * the boundary belongs here rather than to any one of them. Connectors are not turn
   * sources at all; they are data the agent reads, and they never pass through here.
   *
   * Defaults to the router, so behaviour is unchanged until something is injected.
   */
  protected turnProcessor: TurnProcessor;
  protected eventHandlers: GatewayEventHandler[] = [];
  protected connected = false;

  constructor(options: BaseGatewayOptions) {
    this.messageRouter = options.messageRouter;
    // Adapter, not a cast: anything already satisfying the turn contract is used as-is,
    // and an older router is wrapped, so a caller holding one does not have to change.
    const processor = options.turnProcessor as TurnProcessor & Partial<MessageRouter>;
    this.turnProcessor =
      typeof processor.processTurn === 'function'
        ? processor
        : {
            processTurn: (
              message: Parameters<MessageRouter['process']>[0],
              processOptions?: ProcessOptions
            ): Promise<ProcessingResult> =>
              (processor as unknown as MessageRouter).process(message, processOptions),
          };
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
