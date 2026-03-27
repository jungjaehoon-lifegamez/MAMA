import type { MemoryScopeRef } from './scope-context.js';

export interface MemoryAuditJob {
  turnId: string;
  channelKey?: string;
  scopeContext: MemoryScopeRef[];
  conversation: string;
}

export interface MemoryAuditAckLike {
  status: 'applied' | 'skipped' | 'failed';
  action: 'save' | 'supersede' | 'contradict' | 'mark_stale' | 'quarantine' | 'no_op';
  event_ids: string[];
  reason?: string;
}

type AuditWorker = (job: MemoryAuditJob) => Promise<MemoryAuditAckLike>;

export class AuditTaskQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly worker: AuditWorker) {}

  async enqueue(job: MemoryAuditJob): Promise<MemoryAuditAckLike> {
    const run = this.tail.then(() => this.worker(job));
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}
