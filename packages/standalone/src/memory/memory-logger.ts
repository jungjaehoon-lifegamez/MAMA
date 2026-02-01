/**
 * Memory Logger
 *
 * Logs daily conversations and events to ~/.mama/memory/YYYY-MM-DD.md
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export class MemoryLogger {
  private memoryDir: string;

  constructor() {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    this.memoryDir = join(homeDir, '.mama', 'memory');

    // Ensure memory directory exists
    if (!existsSync(this.memoryDir)) {
      mkdirSync(this.memoryDir, { recursive: true });
      console.log('[MemoryLogger] Created memory directory');
    }
  }

  /**
   * Get today's date in YYYY-MM-DD format
   */
  private getToday(): string {
    return new Date().toISOString().split('T')[0];
  }

  /**
   * Get current time in HH:MM format
   */
  private getTime(): string {
    return new Date().toLocaleTimeString('ko-KR', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

  /**
   * Get path to today's log file
   */
  private getTodayPath(): string {
    return join(this.memoryDir, `${this.getToday()}.md`);
  }

  /**
   * Initialize today's log file if it doesn't exist
   */
  private ensureTodayFile(): void {
    const path = this.getTodayPath();
    if (!existsSync(path)) {
      const header = `# ${this.getToday()} 일일 로그\n\n`;
      writeFileSync(path, header, 'utf-8');
      console.log(`[MemoryLogger] Created ${this.getToday()}.md`);
    }
  }

  /**
   * Log a conversation message
   */
  logMessage(source: string, user: string, content: string, isBot: boolean = false): void {
    this.ensureTodayFile();

    const time = this.getTime();
    const prefix = isBot ? '🤖' : '👤';
    const entry = `\n### ${time} [${source}] ${prefix} ${user}\n${content}\n`;

    appendFileSync(this.getTodayPath(), entry, 'utf-8');
  }

  /**
   * Log an event (skill execution, error, etc.)
   */
  logEvent(event: string, details?: string): void {
    this.ensureTodayFile();

    const time = this.getTime();
    let entry = `\n### ${time} ⚡ ${event}\n`;
    if (details) {
      entry += `${details}\n`;
    }

    appendFileSync(this.getTodayPath(), entry, 'utf-8');
  }

  /**
   * Log a decision or checkpoint
   */
  logDecision(topic: string, decision: string, reasoning?: string): void {
    this.ensureTodayFile();

    const time = this.getTime();
    let entry = `\n### ${time} 📝 결정: ${topic}\n**${decision}**\n`;
    if (reasoning) {
      entry += `> ${reasoning}\n`;
    }

    appendFileSync(this.getTodayPath(), entry, 'utf-8');
  }

  /**
   * Get recent logs (today + yesterday)
   */
  getRecentLogs(): string {
    const logs: string[] = [];

    // Today
    const todayPath = this.getTodayPath();
    if (existsSync(todayPath)) {
      logs.push(readFileSync(todayPath, 'utf-8'));
    }

    // Yesterday
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];
    const yesterdayPath = join(this.memoryDir, `${yesterdayStr}.md`);
    if (existsSync(yesterdayPath)) {
      logs.push(readFileSync(yesterdayPath, 'utf-8'));
    }

    return logs.join('\n\n---\n\n');
  }

  /**
   * Get the memory directory path
   */
  getMemoryDir(): string {
    return this.memoryDir;
  }
}

// Singleton instance
let instance: MemoryLogger | null = null;

export function getMemoryLogger(): MemoryLogger {
  if (!instance) {
    instance = new MemoryLogger();
  }
  return instance;
}
