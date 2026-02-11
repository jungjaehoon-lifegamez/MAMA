/**
 * Work Tracker
 *
 * Tracks active work across agents so they can see what others are doing
 * before attempting delegation. Injected into agent prompts alongside
 * Agent Availability status.
 */

export interface ActiveWork {
  agentId: string;
  channelId: string;
  taskSummary: string;
  startedAt: number;
}

export class WorkTracker {
  private activeWork = new Map<string, ActiveWork>();

  private makeKey(agentId: string, channelId: string): string {
    return `${agentId}:${channelId}`;
  }

  startWork(agentId: string, channelId: string, taskSummary: string): void {
    const key = this.makeKey(agentId, channelId);
    this.activeWork.set(key, {
      agentId,
      channelId,
      taskSummary: taskSummary.substring(0, 100),
      startedAt: Date.now(),
    });
  }

  completeWork(agentId: string, channelId: string): void {
    const key = this.makeKey(agentId, channelId);
    this.activeWork.delete(key);
  }

  getActiveWork(): ActiveWork[] {
    return Array.from(this.activeWork.values());
  }

  buildWorkSection(excludeAgentId: string): string {
    const items = this.getActiveWork().filter((w) => w.agentId !== excludeAgentId);
    if (items.length === 0) return '';

    const lines: string[] = ['## Active Work'];
    for (const item of items) {
      const elapsed = Math.round((Date.now() - item.startedAt) / 1000);
      lines.push(`- 🔧 **${item.agentId}**: ${item.taskSummary} (${elapsed}s)`);
    }
    return lines.join('\n');
  }
}
