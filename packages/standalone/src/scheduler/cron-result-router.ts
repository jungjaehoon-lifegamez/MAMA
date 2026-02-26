import { EventEmitter } from 'events';
import type { CronCompletedEvent, CronFailedEvent } from './cron-worker.js';

export type { CronCompletedEvent, CronFailedEvent };

export interface GatewaySender {
  sendMessage(channelId: string, message: string): Promise<void>;
}

export interface CronResultRouterOptions {
  emitter: EventEmitter;
  gateways: {
    discord?: GatewaySender;
    slack?: GatewaySender;
    viewer?: GatewaySender;
  };
}

export class CronResultRouter {
  private readonly gateways: CronResultRouterOptions['gateways'];

  constructor(options: CronResultRouterOptions) {
    this.gateways = options.gateways;

    options.emitter.on('cron:completed', (event: CronCompletedEvent) => {
      this.routeResult(event);
    });

    options.emitter.on('cron:failed', (event: CronFailedEvent) => {
      this.routeError(event);
    });
  }

  private parseChannel(channel?: string): { gateway: string; channelId: string } | null {
    if (!channel) return null;
    const idx = channel.indexOf(':');
    if (idx === -1) return null;
    return {
      gateway: channel.substring(0, idx),
      channelId: channel.substring(idx + 1),
    };
  }

  private getGateway(name: string): GatewaySender | undefined {
    return this.gateways[name as keyof typeof this.gateways];
  }

  private routeResult(event: CronCompletedEvent): void {
    const target = this.parseChannel(event.channel);
    if (!target) {
      console.log(`[CronRouter] Job "${event.jobName}" completed (no channel, result stored only)`);
      return;
    }

    const gw = this.getGateway(target.gateway);
    if (!gw) {
      console.warn(
        `[CronRouter] Gateway "${target.gateway}" not available for job "${event.jobName}"`
      );
      return;
    }

    const message = `\u23f0 **[Cron] ${event.jobName}** (${(event.duration / 1000).toFixed(1)}s)\n${event.result}`;
    gw.sendMessage(target.channelId, message).catch((err) => {
      console.error(`[CronRouter] Failed to deliver result for "${event.jobName}":`, err);
    });
  }

  private routeError(event: CronFailedEvent): void {
    const target = this.parseChannel(event.channel);
    if (!target) {
      console.error(`[CronRouter] Job "${event.jobName}" failed: ${event.error}`);
      return;
    }

    const gw = this.getGateway(target.gateway);
    if (!gw) {
      console.warn(
        `[CronRouter] Gateway "${target.gateway}" not available for failed job "${event.jobName}"`
      );
      return;
    }

    const message = `\u274c **[Cron] ${event.jobName}** failed (${(event.duration / 1000).toFixed(1)}s)\nError: ${event.error}`;
    gw.sendMessage(target.channelId, message).catch((err) => {
      console.error(`[CronRouter] Failed to deliver error for "${event.jobName}":`, err);
    });
  }
}
