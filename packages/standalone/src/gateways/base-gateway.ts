import type {
  Gateway,
  GatewayEvent,
  GatewayEventHandler,
  GatewayConfig,
  MessageSource,
} from './types.js';
import type { SessionDirectory, TurnIntake } from './turn-contract.js';
import type { OwnerFileDeliveryResult } from '../api/file-delivery.js';

export interface BaseGatewayOptions {
  intake: TurnIntake;
  sessionDirectory?: SessionDirectory;
  config?: Partial<GatewayConfig>;
}

export abstract class BaseGateway implements Gateway {
  abstract readonly source: MessageSource;

  protected readonly sessionDirectory?: SessionDirectory;
  protected readonly intake: TurnIntake;
  protected readonly eventHandlers: GatewayEventHandler[] = [];
  protected connected = false;
  protected accepting = true;
  private readonly intakeWork = new Set<Promise<void>>();
  private readonly deliveryWork = new Set<Promise<unknown>>();

  beginStop(): void | Promise<void> {
    this.accepting = false;
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.intakeWork]);
    await Promise.allSettled([...this.deliveryWork]);
  }

  protected trackDelivery<T>(work: () => Promise<T>): Promise<T> {
    const pending = work();
    this.deliveryWork.add(pending);
    void pending.then(
      () => this.deliveryWork.delete(pending),
      () => this.deliveryWork.delete(pending)
    );
    return pending;
  }

  protected trackIntake(work: () => Promise<void>): Promise<void> {
    if (!this.accepting) return Promise.reject(new Error('Gateway intake is stopping'));
    const pending = work();
    this.intakeWork.add(pending);
    void pending.then(
      () => this.intakeWork.delete(pending),
      () => this.intakeWork.delete(pending)
    );
    return pending;
  }

  constructor(options: BaseGatewayOptions) {
    this.sessionDirectory = options.sessionDirectory;
    this.intake = options.intake;
  }

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract sendMessage(channelId: string, text: string, idempotencyKey?: string): Promise<void>;
  abstract sendFile(
    path: string,
    caption: string | undefined,
    operationId: string
  ): Promise<OwnerFileDeliveryResult>;

  protected get mentionPattern(): RegExp | null {
    return null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  onEvent(handler: GatewayEventHandler): void {
    this.eventHandlers.push(handler);
  }

  protected emitEvent(event: GatewayEvent): void {
    for (const handler of this.eventHandlers) handler(event);
  }

  protected cleanMessageContent(content: string): string {
    if (!this.mentionPattern) return content.trim();
    return content.replace(this.mentionPattern, '').trim();
  }
}
