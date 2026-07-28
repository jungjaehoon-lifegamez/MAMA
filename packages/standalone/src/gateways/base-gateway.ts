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
// Contract only. Importing the concrete router here - even as a type - is what let the
// inversion be true of one gateway and false of the class every gateway inherits from.
import type { SessionDirectory, TurnProcessor } from './turn-contract.js';

export interface BaseGatewayOptions {
  /**
   * How a turn is processed. Required, because this is what a user-facing surface
   * actually needs; the concrete router is an extra capability, not the dependency.
   */
  turnProcessor: TurnProcessor;
  /**
   * Optional, and narrow. Only surfaces that read session data for their own display
   * concerns - naming a channel, listing what is active - ask for this. It is not a
   * router: a surface that serves turns cannot reach past the contract through it.
   */
  sessionDirectory?: SessionDirectory;
  config?: Partial<GatewayConfig>;
}

export abstract class BaseGateway implements Gateway {
  abstract readonly source: MessageSource;

  protected sessionDirectory?: SessionDirectory;
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
    this.sessionDirectory = options.sessionDirectory;
    // No adaptation, no cast: the contract is the dependency, so a caller that does not
    // satisfy it is a compile error rather than something quietly wrapped at runtime.
    this.turnProcessor = options.turnProcessor;
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
