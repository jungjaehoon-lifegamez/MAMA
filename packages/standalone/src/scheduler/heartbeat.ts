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

현재 시간: ${new Date().toLocaleString('ko-KR')}

HEARTBEAT.md 내용:
${heartbeatContent || '(없음)'}

지시사항:
1. HEARTBEAT.md 확인
2. 할 일이 있으면 처리하고 결과 보고
3. 없으면 "HEARTBEAT_OK"만 응답
4. 사용자에게 알릴 중요한 것이 있으면 알림 메시지 작성

응답 형식:
- 할 일 없음: HEARTBEAT_OK
- 알림 있음: NOTIFY: [메시지 내용]
- 작업 완료: DONE: [완료 내용]`;

      // Run agent loop
      const result = await this.agentLoop.run(prompt);
      const response = result.response.trim();

      memoryLogger.logEvent('하트비트', response.substring(0, 100));

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
      memoryLogger.logEvent('하트비트 에러', String(error));
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
