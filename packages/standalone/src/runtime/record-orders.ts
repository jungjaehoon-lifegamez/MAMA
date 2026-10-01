import type { DatabaseAdapter } from '@jungjaehoon/mama-core/db-manager';
import type { MailboxRow, Stimulus } from '@jungjaehoon/mama-core/runtime/mailbox';
import type { StimulusReceipt } from '@jungjaehoon/mama-core/runtime/runtime';
import type { RecordOrderPort } from './stimulus-delivery.js';
import {
  RECORD_ORDER_CHANNEL,
  parseRecordOrder,
  recordOrderBatches,
  recordOrderId,
  recordOrderPayload,
  type RecordOrderBatch,
  type RecordOrderPayload,
} from './turn-orders.js';

export const RECORD_ORDER_MAX_ATTEMPTS = 3;

/**
 * How long an unrecorded batch waits for its next attempt. Kagemusha leaves such a batch behind
 * its cursor and reads it again at its next delta tick (deltaDigestIntervalMinutes: 15 by default,
 * 5 where this was measured). On 2026-09-29 MAMA re-sent the same order at once into the same
 * session, and both retries were answered [ack] in two seconds with no tool call.
 */
export const RECORD_RETRY_DELAY_MS = 5 * 60 * 1000;

export type RecordOrderEvent =
  | { type: 'recorded'; deltaStimulusId: string; attempt: number }
  /** The attempt ended unrecorded; the batch waits for the channel's next delta or tick. */
  | { type: 'waiting'; deltaStimulusId: string; attempt: number; reason: string }
  /** The batch's next attempt was placed in an order. */
  | { type: 'retry'; deltaStimulusId: string; attempt: number; order: string }
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
  /** How long an unrecorded batch waits when no delta of its channel comes first. */
  retryDelayMs?: number;
  /** Starts a timer and returns its cancel. */
  setTimer?(run: () => void, ms: number): () => void;
}

/**
 * Kagemusha's taskboard reconcile check, read from MAMA's ledger: the batch counts as recorded
 * when a work revision cites one of its observations, or an order that included it declared no
 * update. Who wrote the revision does not matter; a revision that cites the batch is the record.
 * In an order that only carried the batch, the no-update must cite one of its observations: the
 * order may show none of its lines, and a no-update about the newer messages does not cover it.
 */
export function batchRecorded(
  adapter: DatabaseAdapter,
  batch: Pick<RecordOrderBatch, 'deltaStimulusId' | 'observationRefs'>,
  carryingOrders: readonly string[] = []
): boolean {
  if (batch.observationRefs.length > 0) {
    const marks = batch.observationRefs.map(() => '?').join(',');
    const revised = adapter
      .prepare(
        `SELECT 1 FROM commitment_assignments ca
           JOIN twin_edges e ON e.subject_kind = 'memory' AND e.subject_id = ca.record_id
          WHERE e.edge_type = 'derived_from' AND e.object_kind = 'observation'
            AND e.object_id IN (${marks})
          LIMIT 1`
      )
      .get(...batch.observationRefs);
    if (revised !== undefined) return true;
  }
  const ownOrders = Array.from({ length: RECORD_ORDER_MAX_ATTEMPTS }, (_, index) =>
    recordOrderId(batch.deltaStimulusId, index + 1)
  );
  if (noUpdateIn(adapter, ownOrders, null)) return true;
  const carrying = [...new Set(carryingOrders)].filter((id) => !ownOrders.includes(id));
  return carrying.length > 0 && noUpdateIn(adapter, carrying, batch.observationRefs);
}

/** A completed work.no_update in these orders' runs, citing one of `cites` when given. */
function noUpdateIn(
  adapter: DatabaseAdapter,
  orderIds: readonly string[],
  cites: readonly string[] | null
): boolean {
  const marks = orderIds.map(() => '?').join(',');
  const citing =
    cites === null
      ? ''
      : `AND EXISTS (
            SELECT 1 FROM json_each(CASE WHEN json_valid(t.input_summary)
                THEN json_extract(t.input_summary, '$.observationRefs') END) ref
             WHERE ref.value IN (${cites.map(() => '?').join(',')}))`;
  return (
    adapter
      .prepare(
        `SELECT 1 FROM tool_traces t
          WHERE t.tool_name = 'work.no_update' AND t.execution_status = 'completed'
            AND t.model_run_id IN (
              SELECT r.model_run_id FROM model_runs r
               WHERE json_extract(r.input_refs_json, '$.sourceMessageRef') IN (${marks})
              UNION
              SELECT c.model_run_id FROM model_runs c JOIN model_runs p ON c.parent_model_run_id = p.model_run_id
               WHERE json_extract(p.input_refs_json, '$.sourceMessageRef') IN (${marks})
            )
            ${citing}
          LIMIT 1`
      )
      .get(...orderIds, ...orderIds, ...(cites ?? [])) !== undefined
  );
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
   * Re-run the checks a previous process may have lost: every batch of the last day of record
   * orders whose latest order has ended unrecorded waits for its next attempt, or is logged as
   * lost.
   */
  recover(): void;
  /** Drop the checks and timers still waiting; recover() rebuilds them at the next start. */
  stop(): void;
}

const RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

interface ChannelOf {
  source?: string;
  channel: string;
}

/** A batch as the stored orders show it. */
interface BatchState extends ChannelOf {
  /** The batch at its latest attempt. */
  batch: RecordOrderBatch;
  /** The order holding the latest attempt is still queued or running. */
  open: boolean;
  /** Every order that included the batch; a no-update in any of them covers it. */
  orders: string[];
}

/**
 * The batches of the last day of record orders, each at its latest attempt. The day ends at the
 * latest stored order, not at now: a batch left waiting when the daemon stopped is still read
 * after a longer stop.
 */
function storedBatches(adapter: DatabaseAdapter): Map<string, BatchState> {
  const rows = adapter
    .prepare(
      `SELECT m.stimulus_id, m.payload_json, m.status, n.state AS native_state
         FROM mailbox_inputs m LEFT JOIN native_input_deliveries n ON n.input_id = m.id
        WHERE m.kind = 'scheduled' AND m.channel_key = ?
          AND m.created_at >= (SELECT max(created_at) FROM mailbox_inputs
                                WHERE kind = 'scheduled' AND channel_key = ?) - ?`
    )
    .all(RECORD_ORDER_CHANNEL, RECORD_ORDER_CHANNEL, RECOVERY_WINDOW_MS) as Array<{
    stimulus_id: string;
    payload_json: string;
    status: string;
    native_state: string | null;
  }>;
  const states = new Map<string, BatchState>();
  for (const row of rows) {
    const order = parseRecordOrder(JSON.parse(row.payload_json));
    // A row parked uncertain stays claimed; its batch is settled through onLost, not left open.
    const open =
      (row.status === 'pending' || row.status === 'claimed') && row.native_state !== 'uncertain';
    for (const batch of recordOrderBatches(order)) {
      const current = states.get(batch.deltaStimulusId);
      const orders = [...(current?.orders ?? []), row.stimulus_id];
      if (current === undefined || batch.attempt > current.batch.attempt)
        states.set(batch.deltaStimulusId, {
          batch,
          source: order.source,
          channel: order.channel,
          open,
          orders,
        });
      else
        states.set(batch.deltaStimulusId, {
          ...current,
          open: current.open || (batch.attempt === current.batch.attempt && open),
          orders,
        });
    }
  }
  return states;
}

function orderExists(adapter: DatabaseAdapter, id: string): boolean {
  return (
    adapter.prepare(`SELECT 1 FROM mailbox_inputs WHERE stimulus_id = ? LIMIT 1`).get(id) !==
    undefined
  );
}

function channelKeyOf(where: ChannelOf): string {
  return `${where.source ?? ''}\u0000${where.channel}`;
}

interface WaitingChannel extends ChannelOf {
  /** Oldest first, each at the attempt that ended unrecorded. */
  batches: Map<string, RecordOrderBatch>;
  cancel?: () => void;
}

export function createRecordOrders(options: RecordOrdersOptions): RecordOrders {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const childWaitMs = options.childWaitMs ?? 10 * 60 * 1000;
  const retryDelayMs = options.retryDelayMs ?? RECORD_RETRY_DELAY_MS;
  const setTimer =
    options.setTimer ??
    ((run: () => void, ms: number) => {
      const timer = setTimeout(run, ms);
      timer.unref?.();
      return () => clearTimeout(timer);
    });
  const waiting = new Map<string, WaitingChannel>();
  let stopped = false;

  /**
   * An order id is written once: its carried batches depend on what was waiting at the time, so
   * the stored order stands. enqueueFirst checks before it takes the channel's waiting batches (a
   * replayed notify result enqueues its first order again); a tick relies on the check here.
   */
  const enqueue = (record: RecordOrderPayload): boolean => {
    const id = recordOrderId(record.deltaStimulusId, record.attempt);
    if (orderExists(options.adapter, id)) return false;
    const receipt = options.accept({
      id,
      kind: 'scheduled',
      channelKey: RECORD_ORDER_CHANNEL,
      occurredAt: Date.now(),
      payload: record as unknown as Stimulus['payload'],
    });
    // The mailbox remembers an id after its row is pruned.
    if (receipt.state === 'duplicate') return false;
    for (const batch of recordOrderBatches(record))
      if (batch.attempt > 1)
        options.onEvent?.({
          type: 'retry',
          deltaStimulusId: batch.deltaStimulusId,
          attempt: batch.attempt,
          order: id,
        });
    return true;
  };

  const take = (key: string): WaitingChannel | undefined => {
    const entry = waiting.get(key);
    waiting.delete(key);
    entry?.cancel?.();
    return entry;
  };

  const next = (batch: RecordOrderBatch): RecordOrderBatch => ({
    ...batch,
    attempt: batch.attempt + 1,
  });

  /**
   * The waiting batches that still need an order. One that another order took up, or that was
   * recorded while it waited (by another turn reading the channel), is left out.
   */
  const dueBatches = (batches: readonly RecordOrderBatch[]): RecordOrderBatch[] => {
    if (batches.length === 0) return [];
    const stored = storedBatches(options.adapter);
    const recorded: RecordOrderBatch[] = [];
    const due = batches.filter((batch) => {
      const state = stored.get(batch.deltaStimulusId);
      if (state !== undefined && (state.open || state.batch.attempt > batch.attempt)) return false;
      if (batchRecorded(options.adapter, batch, state?.orders ?? [])) {
        recorded.push(batch);
        return false;
      }
      return true;
    });
    for (const batch of recorded)
      options.onEvent?.({
        type: 'recorded',
        deltaStimulusId: batch.deltaStimulusId,
        attempt: batch.attempt,
      });
    return due;
  };

  // Kagemusha's next tick: the channel's waiting batches go together in one order.
  const tick = (key: string): void => {
    const entry = take(key);
    if (entry === undefined || stopped) return;
    // The batches whose outcome is still open; a failure below reports only these as lost.
    let unsettled = [...entry.batches.values()];
    try {
      const due = dueBatches(unsettled);
      unsettled = due;
      const [own, ...carried] = due;
      if (own === undefined) return;
      const placed = enqueue({
        order: 'record',
        deltaStimulusId: own.deltaStimulusId,
        ...(entry.source === undefined ? {} : { source: entry.source }),
        channel: entry.channel,
        observationRefs: own.observationRefs,
        lines: own.lines,
        attempt: own.attempt + 1,
        ...(carried.length === 0 ? {} : { carried: carried.map(next) }),
      });
      // The own batch's next order is already stored, older than the day recovery reads; that
      // order accounts for it, and the rest wait for the next tick.
      if (!placed) for (const batch of carried) wait(batch, entry);
    } catch (error) {
      for (const batch of unsettled)
        options.onEvent?.({
          type: 'lost',
          deltaStimulusId: batch.deltaStimulusId,
          attempt: batch.attempt,
          reason: `record retry failed: ${error instanceof Error ? error.message : String(error)}`,
        });
    }
  };

  const wait = (batch: RecordOrderBatch, where: ChannelOf): void => {
    const key = channelKeyOf(where);
    const entry = waiting.get(key) ?? {
      source: where.source,
      channel: where.channel,
      batches: new Map<string, RecordOrderBatch>(),
    };
    const current = entry.batches.get(batch.deltaStimulusId);
    if (current === undefined || batch.attempt > current.attempt)
      entry.batches.set(batch.deltaStimulusId, batch);
    entry.cancel ??= setTimer(() => tick(key), retryDelayMs);
    waiting.set(key, entry);
  };

  const settle = (
    batch: RecordOrderBatch,
    where: ChannelOf,
    orders: readonly string[],
    reason: string
  ): void => {
    if (batchRecorded(options.adapter, batch, orders)) {
      options.onEvent?.({
        type: 'recorded',
        deltaStimulusId: batch.deltaStimulusId,
        attempt: batch.attempt,
      });
      return;
    }
    if (batch.attempt >= RECORD_ORDER_MAX_ATTEMPTS) {
      options.onEvent?.({
        type: 'lost',
        deltaStimulusId: batch.deltaStimulusId,
        attempt: batch.attempt,
        reason,
      });
      return;
    }
    options.onEvent?.({
      type: 'waiting',
      deltaStimulusId: batch.deltaStimulusId,
      attempt: batch.attempt,
      reason,
    });
    if (!stopped) wait(batch, where);
  };

  return {
    // The channel's waiting batches ride with its next delta, as Kagemusha's cursor re-reads them.
    enqueueFirst: (row) => {
      const record = recordOrderPayload(row, 1);
      if (record.observationRefs.length === 0)
        throw new Error(`Live delta ${row.stimulusId} carries no observation to record`);
      if (orderExists(options.adapter, recordOrderId(record.deltaStimulusId, 1))) return;
      const key = channelKeyOf(record);
      const carried = dueBatches([...(waiting.get(key)?.batches.values() ?? [])]).map(next);
      enqueue(carried.length === 0 ? record : { ...record, carried });
      // Taken only once the order is stored, so a refused accept leaves them waiting.
      take(key);
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
        for (const batch of recordOrderBatches(record))
          settle(
            batch,
            record,
            [row.stimulusId],
            'the order ended without a revision citing the batch or a declared no-update'
          );
      })().catch((error: unknown) => {
        // A check cut off by shutdown is not a loss: recover() runs it at the next start.
        if (stopped) return;
        for (const batch of recordOrderBatches(record))
          options.onEvent?.({
            type: 'lost',
            deltaStimulusId: batch.deltaStimulusId,
            attempt: batch.attempt,
            reason: `record check failed: ${error instanceof Error ? error.message : String(error)}`,
          });
      });
    },
    onLost: (row: MailboxRow, reason: string) => {
      const record = parseRecordOrder(row.payload);
      try {
        const stored = storedBatches(options.adapter);
        for (const batch of recordOrderBatches(record)) {
          const state = stored.get(batch.deltaStimulusId);
          // Skip a batch that already has a later attempt, or that is older than the day recovery
          // reads (a lost batch would otherwise run again).
          if (state === undefined || state.batch.attempt > batch.attempt) continue;
          settle(batch, record, [...state.orders, row.stimulusId], reason);
        }
      } catch (error) {
        // The runtime swallows a failed report, so the loss is named here.
        for (const batch of recordOrderBatches(record))
          options.onEvent?.({
            type: 'lost',
            deltaStimulusId: batch.deltaStimulusId,
            attempt: batch.attempt,
            reason: `record check failed: ${error instanceof Error ? error.message : String(error)}`,
          });
      }
    },
    recover: () => {
      for (const state of storedBatches(options.adapter).values()) {
        if (state.open || batchRecorded(options.adapter, state.batch, state.orders)) continue;
        // Repeats at each start while the batch stays unrecorded; any revision citing it clears it.
        settle(
          state.batch,
          state,
          state.orders,
          `still unrecorded at daemon start after attempt ${state.batch.attempt}`
        );
      }
    },
    stop: () => {
      stopped = true;
      for (const key of [...waiting.keys()]) take(key);
    },
  };
}
