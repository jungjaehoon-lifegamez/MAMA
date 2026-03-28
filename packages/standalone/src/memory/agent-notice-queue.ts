export interface AuditNotice {
  type: 'direction_alert' | 'truth_conflict' | 'truth_update' | 'memory_warning';
  severity: 'low' | 'medium' | 'high';
  summary: string;
  evidence: Array<{ type: 'conversation' | 'memory' | 'event'; ref: string; excerpt?: string }>;
  recommended_action: 'recheck' | 'consult_memory' | 'avoid_claim' | 'use_truth_snapshot';
  relevant_memories: Array<{ id: string; topic: string; summary: string }>;
}

export function shouldDeliverAuditNotice(notice: AuditNotice): boolean {
  return notice.severity === 'high' || notice.type === 'direction_alert';
}

export class AgentNoticeQueue {
  private readonly queue = new Map<string, AuditNotice[]>();

  enqueue(channelKey: string, notice: AuditNotice): void {
    if (!shouldDeliverAuditNotice(notice)) {
      return;
    }

    const notices = this.queue.get(channelKey) ?? [];
    notices.push(notice);
    this.queue.set(channelKey, notices);
  }

  peek(channelKey: string): AuditNotice[] {
    return [...(this.queue.get(channelKey) ?? [])];
  }

  drain(channelKey: string, count?: number): AuditNotice[] {
    const notices = this.queue.get(channelKey) ?? [];
    if (count === undefined || count >= notices.length) {
      this.queue.delete(channelKey);
      return notices;
    }

    const drained = notices.slice(0, count);
    const remaining = notices.slice(count);
    if (remaining.length > 0) {
      this.queue.set(channelKey, remaining);
    } else {
      this.queue.delete(channelKey);
    }
    return drained;
  }
}
