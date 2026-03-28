import type { MemoryScopeRef } from './scope-context.js';
import type { SaveCandidate } from './save-candidate-types.js';

export interface MemoryAuditJob {
  turnId: string;
  channelKey?: string;
  source?: string;
  channelId?: string;
  userId?: string;
  scopeContext: MemoryScopeRef[];
  conversation: string;
  candidates?: SaveCandidate[];
}

export interface MemoryAuditAckLike {
  status: 'applied' | 'skipped' | 'failed';
  action: 'save' | 'supersede' | 'contradict' | 'mark_stale' | 'quarantine' | 'no_op';
  event_ids: string[];
  reason?: string;
}

type AuditWorker = (job: MemoryAuditJob) => Promise<MemoryAuditAckLike>;

const AUDIT_TIMEOUT_MS = 30_000;

export class AuditTaskQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly worker: AuditWorker) {}

  async enqueue(job: MemoryAuditJob): Promise<MemoryAuditAckLike> {
    const run = this.tail.then(() => {
      return new Promise<MemoryAuditAckLike>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Memory audit timed out')),
          AUDIT_TIMEOUT_MS
        );
        this.worker(job).then(
          (result) => {
            clearTimeout(timer);
            resolve(result);
          },
          (err) => {
            clearTimeout(timer);
            reject(err);
          }
        );
      });
    });
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}
