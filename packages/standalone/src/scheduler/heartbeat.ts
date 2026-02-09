/**
 * Heartbeat Scheduler
 *
 * Periodically polls HEARTBEAT.md and executes proactive tasks
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { AgentLoop } from '../agent/agent-loop.js';
import { getMemoryLogger } from '../memory/memory-logger.js';

export interface HeartbeatConfig {
  /** Interval in milliseconds (default: 30 minutes) */
  interval: number;
  /** Quiet hours start (0-23, default: 23) */
  quietStart: number;
  /** Quiet hours end (0-23, default: 8) */
  quietEnd: number;
  /** Discord channel ID to send notifications */
  notifyChannelId?: string;
}

const DEFAULT_CONFIG: HeartbeatConfig = {
  interval: 30 * 60 * 1000, // 30 minutes
  quietStart: 23,
  quietEnd: 8,
};

export class HeartbeatScheduler {
  private config: HeartbeatConfig;
  private agentLoop: AgentLoop;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private sendNotification?: (channelId: string, message: string) => Promise<void>;

  constructor(
    agentLoop: AgentLoop,
    config: Partial<HeartbeatConfig> = {},
    sendNotification?: (channelId: string, message: string) => Promise<void>
  ) {
    this.agentLoop = agentLoop;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.sendNotification = sendNotification;
  }

  /**
   * Start the heartbeat scheduler
   */
  start(): void {
    if (this.running) {
      console.log('[Heartbeat] Already running');
      return;
    }

    this.running = true;
    console.log(`[Heartbeat] Started (interval: ${this.config.interval / 1000}s)`);

    // Run first heartbeat after a short delay
    setTimeout(() => this.tick(), 5000);

    // Schedule regular heartbeats
    this.timer = setInterval(() => this.tick(), this.config.interval);
  }

  /**
   * Stop the heartbeat scheduler
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    console.log('[Heartbeat] Stopped');
  }

  /**
   * Check if current time is within quiet hours
   */
  private isQuietHours(): boolean {
    const hour = new Date().getHours();
    if (this.config.quietStart > this.config.quietEnd) {
      // Quiet hours span midnight (e.g., 23:00 - 08:00)
      return hour >= this.config.quietStart || hour < this.config.quietEnd;
    } else {
      return hour >= this.config.quietStart && hour < this.config.quietEnd;
    }
  }

  /**
   * Execute a heartbeat tick
   */
  private async tick(): Promise<void> {
    // Skip during quiet hours
    if (this.isQuietHours()) {
      console.log('[Heartbeat] Quiet hours - skipping');
      return;
    }

    console.log('[Heartbeat] Tick...');
    const memoryLogger = getMemoryLogger();

    try {
      // Load HEARTBEAT.md
      const homeDir = process.env.HOME || process.env.USERPROFILE || '';
      const heartbeatPath = join(homeDir, '.mama', 'HEARTBEAT.md');

      let heartbeatContent = '';
      if (existsSync(heartbeatPath)) {
        heartbeatContent = readFileSync(heartbeatPath, 'utf-8');
      }

      // Build heartbeat prompt
      const prompt = `[HEARTBEAT POLL]

Current time: ${new Date().toISOString()}

HEARTBEAT.md contents:
${heartbeatContent || '(none)'}

Instructions:
1. Check HEARTBEAT.md
2. If there are tasks, process them and report results
3. If none, respond with "HEARTBEAT_OK" only
4. If there is something important to notify the user about, compose a notification message

Response format:
- No tasks: HEARTBEAT_OK
- Notification: NOTIFY: [message content]
- Task completed: DONE: [completion details]`;

      // Run agent loop
      const result = await this.agentLoop.run(prompt);
      const response = result.response.trim();

      memoryLogger.logEvent('heartbeat', response.substring(0, 100));

      // Handle response
      if (response === 'HEARTBEAT_OK') {
        console.log('[Heartbeat] OK - nothing to do');
      } else if (response.startsWith('NOTIFY:')) {
        const message = response.replace('NOTIFY:', '').trim();
        console.log(`[Heartbeat] Notification: ${message}`);

        // Send notification if configured
        if (this.sendNotification && this.config.notifyChannelId) {
          await this.sendNotification(this.config.notifyChannelId, message);
        }
      } else if (response.startsWith('DONE:')) {
        const done = response.replace('DONE:', '').trim();
        console.log(`[Heartbeat] Task completed: ${done}`);
      } else {
        console.log(`[Heartbeat] Response: ${response.substring(0, 100)}...`);
      }
    } catch (error) {
      console.error('[Heartbeat] Error:', error);
      memoryLogger.logEvent('heartbeat error', String(error));
    }
  }

  /**
   * Manually trigger a heartbeat
   */
  async triggerNow(): Promise<string> {
    console.log('[Heartbeat] Manual trigger');
    await this.tick();
    return 'Heartbeat triggered';
  }

  /**
   * Update configuration
   */
  setConfig(config: Partial<HeartbeatConfig>): void {
    this.config = { ...this.config, ...config };

    // Restart with new interval if running
    if (this.running && config.interval) {
      this.stop();
      this.start();
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): HeartbeatConfig {
    return { ...this.config };
  }
}
