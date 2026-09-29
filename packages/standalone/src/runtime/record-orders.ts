import type { DatabaseAdapter } from '@jungjaehoon/mama-core/db-manager';
import type { MailboxRow, Stimulus } from '@jungjaehoon/mama-core/runtime/mailbox';
import type { StimulusReceipt } from '@jungjaehoon/mama-core/runtime/runtime';
import type { RecordOrderPort } from './stimulus-delivery.js';
import {
  RECORD_ORDER_CHANNEL,
  parseRecordOrder,
  recordOrderId,
  recordOrderPayload,
  type RecordOrderPayload,
} from './turn-orders.js';

export const RECORD_ORDER_MAX_ATTEMPTS = 3;

export type RecordOrderEvent =
  | { type: 'recorded'; deltaStimulusId: string; attempt: number }
  | { type: 'retry'; deltaStimulusId: string; attempt: number; reason: string }
  | { type: 'lost'; deltaStimulusId: string; attempt: number; reason: string };

export interface RecordOrdersOptions {
  adapter: DatabaseAdapter;
  accept(stimulus: Omit<Stimulus, 'principalId'>): StimulusReceipt;
  /** When this daemon process started: runs begun earlier can no longer write. */
  processStartedAt: number;
  onEvent?(event: RecordOrderEvent): void;
  /** How long to wait for a record run's child runs to end before checking. */
  childWaitMs?: number;
  sleep?(ms: number): Promise<void>;
}

/**
 * Kagemusha's taskboard reconcile check, read from MAMA's ledger: the batch counts as recorded
 * when a work revision cites one of its observations, or a record order for it declared no update.
 * Who wrote the revision does not matter; a revision that cites the batch is the record.
 */
export function batchRecorded(adapter: DatabaseAdapter, record: RecordOrderPayload): boolean {
  if (record.observationRefs.length > 0) {
    const marks = record.observationRefs.map(() => '?').join(',');
    const revised = adapter
      .prepare(
        `SELECT 1 FROM commitment_assignments ca
           JOIN twin_edges e ON e.subject_kind = 'memory' AND e.subject_id = ca.record_id
          WHERE e.edge_type = 'derived_from' AND e.object_kind = 'observation'
            AND e.object_id IN (${marks})
          LIMIT 1`
      )
      .get(...record.observationRefs);
    if (revised !== undefined) return true;
  }
  const orderIds = Array.from({ length: RECORD_ORDER_MAX_ATTEMPTS }, (_, index) =>
    recordOrderId(record.deltaStimulusId, index + 1)
  );
  const noUpdate = adapter
    .prepare(
      `SELECT 1 FROM tool_traces t
        WHERE t.tool_name = 'work.no_update' AND t.execution_status = 'completed'
          AND t.model_run_id IN (
            SELECT r.model_run_id FROM model_runs r
             WHERE json_extract(r.input_refs_json, '$.sourceMessageRef') IN (${orderIds.map(() => '?').join(',')})
            UNION
            SELECT c.model_run_id FROM model_runs c JOIN model_runs p ON c.parent_model_run_id = p.model_run_id
             WHERE json_extract(p.input_refs_json, '$.sourceMessageRef') IN (${orderIds.map(() => '?').join(',')})
          )
        LIMIT 1`
    )
    .get(...orderIds, ...orderIds);
  return noUpdate !== undefined;
}

/** Child runs of a record run that this process started and that have not ended yet. */
function runningChildren(adapter: DatabaseAdapter, modelRunId: string, startedAt: number): number {
  const row = adapter
    .prepare(
      `SELECT count(*) AS n FROM model_runs
        WHERE parent_model_run_id = ? AND status NOT IN ('committed', 'failed') AND created_at >= ?`
    )
    .get(modelRunId, startedAt) as { n: number } | undefined;
  return row?.n ?? 0;
}

export interface RecordOrders extends RecordOrderPort {
  /**
   * Re-run the checks a previous process may have lost while waiting for child runs: for each
   * batch of the last day with no record order still queued, an unrecorded batch gets its next
   * attempt or is logged as lost.
   */
  recover(): void;
  /** Drop the checks still waiting; recover() runs them again at the next start. */
  stop(): void;
}

const RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

export function createRecordOrders(options: RecordOrdersOptions): RecordOrders {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const childWaitMs = options.childWaitMs ?? 10 * 60 * 1000;
  let stopped = false;

  const enqueue = (record: RecordOrderPayload): void => {
    options.accept({
      id: recordOrderId(record.deltaStimulusId, record.attempt),
      kind: 'scheduled',
      channelKey: RECORD_ORDER_CHANNEL,
      occurredAt: Date.now(),
      payload: record as unknown as Stimulus['payload'],
    });
  };

  const settle = (record: RecordOrderPayload, reason: string): void => {
    if (batchRecorded(options.adapter, record)) {
      options.onEvent?.({
        type: 'recorded',
        deltaStimulusId: record.deltaStimulusId,
        attempt: record.attempt,
      });
      return;
    }
    if (record.attempt >= RECORD_ORDER_MAX_ATTEMPTS) {
      options.onEvent?.({
        type: 'lost',
        deltaStimulusId: record.deltaStimulusId,
        attempt: record.attempt,
        reason,
      });
      return;
    }
    options.onEvent?.({
      type: 'retry',
      deltaStimulusId: record.deltaStimulusId,
      attempt: record.attempt + 1,
      reason,
    });
    enqueue({ ...record, attempt: record.attempt + 1 });
  };

  return {
    enqueueFirst: (row) => {
      const record = recordOrderPayload(row, 1);
      if (record.observationRefs.length === 0)
        throw new Error(`Live delta ${row.stimulusId} carries no observation to record`);
      enqueue(record);
    },
    // The check waits for child runs in the background so the owner's queue is never held.
    onResult: (row: MailboxRow, modelRunId: string | null) => {
      const record = parseRecordOrder(row.payload);
      void (async () => {
        if (modelRunId !== null) {
          const deadline = Date.now() + childWaitMs;
          while (
            !stopped &&
            runningChildren(options.adapter, modelRunId, options.processStartedAt) > 0 &&
            Date.now() < deadline
          )
            await sleep(5_000);
        }
        if (stopped) return;
        settle(
          record,
          'the order ended without a revision citing the batch or a declared no-update'
        );
      })().catch((error: unknown) => {
        // A check cut off by shutdown is not a loss: recover() runs it at the next start.
        if (stopped) return;
        options.onEvent?.({
          type: 'lost',
          deltaStimulusId: record.deltaStimulusId,
          attempt: record.attempt,
          reason: `record check failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      });
    },
    onLost: (row: MailboxRow, reason: string) => {
      settle(parseRecordOrder(row.payload), reason);
    },
    recover: () => {
      const rows = options.adapter
        .prepare(
          `SELECT payload_json, status FROM mailbox_inputs
            WHERE kind = 'scheduled' AND channel_key = ? AND created_at >= ?`
        )
        .all(RECORD_ORDER_CHANNEL, Date.now() - RECOVERY_WINDOW_MS) as Array<{
        payload_json: string;
        status: string;
      }>;
      const latest = new Map<string, { record: RecordOrderPayload; open: boolean }>();
      for (const row of rows) {
        const record = parseRecordOrder(JSON.parse(row.payload_json));
        const open = row.status === 'pending' || row.status === 'claimed';
        const current = latest.get(record.deltaStimulusId);
        latest.set(record.deltaStimulusId, {
          record: current && current.record.attempt > record.attempt ? current.record : record,
          open: open || (current?.open ?? false),
        });
      }
      for (const { record, open } of latest.values()) {
        if (open || batchRecorded(options.adapter, record)) continue;
        // Repeats at each start while the batch stays unrecorded; any revision citing it clears it.
        settle(record, `still unrecorded at daemon start after attempt ${record.attempt}`);
      }
    },
    stop: () => {
      stopped = true;
    },
  };
}
