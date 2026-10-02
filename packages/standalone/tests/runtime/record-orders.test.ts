import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Stimulus } from '@jungjaehoon/mama-core/runtime/mailbox';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import {
  RECORD_ORDER_MAX_ATTEMPTS,
  RECORD_RETRY_DELAY_MS,
  batchRecorded,
  createRecordOrders,
  type RecordOrderEvent,
} from '../../src/runtime/record-orders.js';
import { recordOrderPayload, type RecordOrderPayload } from '../../src/runtime/turn-orders.js';

const homes: string[] = [];
const databases: Array<Awaited<ReturnType<typeof openCoreDatabase>>> = [];

afterEach(async () => {
  for (const database of databases.splice(0).reverse()) await database.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function database() {
  const home = mkdtempSync(join(tmpdir(), 'mama-record-orders-'));
  homes.push(home);
  const db = await openCoreDatabase({ path: join(home, 'state.db') });
  databases.push(db);
  return db.adapter;
}

const delta = {
  stimulusId: 'source_delta:batch',
  channelKey: 'room',
  payload: {
    refs: [
      { observationRef: 'obs-1', contentPreview: 'a', sourceAt: new Date().toISOString() },
      { observationRef: 'obs-2', contentPreview: 'b', sourceAt: new Date().toISOString() },
    ],
  },
};

function row(attempt: number) {
  return {
    id: attempt,
    stimulusId: `record:${delta.stimulusId}:${attempt}`,
    principalId: 'owner',
    kind: 'scheduled' as const,
    channelKey: 'operator:record',
    occurredAt: 1,
    refs: [],
    preview: [],
    status: 'claimed' as const,
    attempts: 1,
    createdAt: 1,
    coalesceKey: null,
    payload: recordOrderPayload(delta, attempt) as never,
  };
}

// The rows stand for a revision the knowledge layer wrote; the check reads only these columns.
function revise(adapter: Awaited<ReturnType<typeof database>>, observationId: string) {
  adapter.exec('PRAGMA foreign_keys = OFF');
  adapter
    .prepare(
      `INSERT INTO commitment_assignments (commitment_id, revision, record_id, operation, set_json, clear_json, created_at, model_run_id)
       VALUES (?, 2, ?, 'revise', '{}', '[]', 1, 'run-1')`
    )
    .run(`commitment-${observationId}`, `record-${observationId}`);
  adapter
    .prepare(
      `INSERT INTO twin_edges (edge_type, subject_kind, subject_id, object_kind, object_id, source, content_hash, created_at)
       VALUES ('derived_from', 'memory', ?, 'observation', ?, 'agent', randomblob(32), 1)`
    )
    .run(`record-${observationId}`, observationId);
}

function noUpdate(
  adapter: Awaited<ReturnType<typeof database>>,
  orderId: string,
  child: boolean,
  cites: string[] = []
) {
  adapter
    .prepare(
      `INSERT INTO model_runs (model_run_id, status, created_at, input_refs_json) VALUES ('parent', 'committed', 1, ?)`
    )
    .run(JSON.stringify({ sourceMessageRef: orderId }));
  if (child)
    adapter
      .prepare(
        `INSERT INTO model_runs (model_run_id, status, created_at, parent_model_run_id) VALUES ('child', 'committed', 1, 'parent')`
      )
      .run();
  adapter
    .prepare(
      `INSERT INTO tool_traces (trace_id, model_run_id, tool_name, input_summary, execution_status, created_at) VALUES ('trace-1', ?, 'work.no_update', ?, 'completed', 1)`
    )
    .run(
      child ? 'child' : 'parent',
      JSON.stringify({ reason: 'nothing to record', observationRefs: cites })
    );
}

function orders(adapter: Awaited<ReturnType<typeof database>>) {
  const accepted: Array<Omit<Stimulus, 'principalId'>> = [];
  const events: RecordOrderEvent[] = [];
  const timers: Array<{ run: () => void; ms: number; cancelled: boolean }> = [];
  const port = createRecordOrders({
    adapter,
    accept: (stimulus) => {
      accepted.push(stimulus);
      return { inputId: stimulus.id, state: 'accepted' };
    },
    processStartedAt: 0,
    onEvent: (event) => events.push(event),
    sleep: async () => {},
    setTimer: (run, ms) => {
      const timer = { run, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
  // The next delta tick: every timer still armed fires.
  const tick = () => {
    for (const timer of timers.splice(0)) if (!timer.cancelled) timer.run();
  };
  return { port, accepted, events, timers, tick };
}

function store(
  adapter: Awaited<ReturnType<typeof database>>,
  payload: RecordOrderPayload | Record<string, unknown>,
  status: 'pending' | 'claimed' | 'acked',
  nativeState?: 'uncertain',
  createdAt = Date.now()
) {
  const record = payload as RecordOrderPayload;
  const id = `record:${record.deltaStimulusId}:${record.attempt}`;
  const inserted = adapter
    .prepare(
      `INSERT INTO mailbox_inputs (stimulus_id, kind, principal_id, channel_key, preview_json, payload_json, occurred_at, created_at, status)
       VALUES (?, 'scheduled', 'owner', 'operator:record', '[]', ?, 1, ?, ?)`
    )
    .run(id, JSON.stringify(payload), createdAt, status);
  if (nativeState)
    adapter
      .prepare(`INSERT INTO native_input_deliveries (input_id, state, updated_at) VALUES (?, ?, 1)`)
      .run(inserted.lastInsertRowid, nativeState);
  return { ...row(record.attempt), stimulusId: id, payload: payload as never };
}

function mailboxRow(
  adapter: Awaited<ReturnType<typeof database>>,
  attempt: number,
  status: 'pending' | 'acked',
  legacy = false
) {
  const payload = recordOrderPayload(delta, attempt);
  // A record order stored before orders carried their source.
  const { source: _source, ...withoutSource } = payload;
  store(adapter, legacy ? withoutSource : payload, status);
}

const later = {
  stimulusId: 'source_delta:later',
  channelKey: 'room',
  payload: {
    refs: [{ observationRef: 'obs-3', contentPreview: 'c', sourceAt: new Date().toISOString() }],
  },
};

const DAY = 24 * 60 * 60 * 1000;

// A delta in another channel, whose order anchors the day recovery reads.
const other = {
  stimulusId: 'source_delta:other',
  channelKey: 'hall',
  payload: {
    refs: [{ observationRef: 'obs-9', contentPreview: 'z', sourceAt: new Date().toISOString() }],
  },
};

function deltaRow(source: typeof delta) {
  return {
    ...row(1),
    kind: 'source_delta',
    stimulusId: source.stimulusId,
    channelKey: source.channelKey,
    payload: source.payload,
  } as never;
}

describe('record orders', () => {
  it('recovers a lost check at start: waits for the tick when unrecorded, nothing while one is queued', async () => {
    const adapter = await database();
    mailboxRow(adapter, 1, 'acked');
    const { port, accepted, events, timers, tick } = orders(adapter);
    port.recover();
    expect(events[0]).toMatchObject({ type: 'waiting', attempt: 1 });
    expect(accepted).toEqual([]);
    expect(timers[0]?.ms).toBe(RECORD_RETRY_DELAY_MS);
    tick();
    expect(accepted.map((stimulus) => stimulus.id)).toEqual([`record:${delta.stimulusId}:2`]);
    mailboxRow(adapter, 2, 'pending');
    const second = orders(adapter);
    second.port.recover();
    second.tick();
    expect(second.accepted).toEqual([]);
  });

  it('recovers at start from a record order stored before orders carried their source', async () => {
    const adapter = await database();
    mailboxRow(adapter, 1, 'acked', true);
    const { port, accepted, tick } = orders(adapter);
    port.recover();
    tick();
    expect(accepted.map((stimulus) => stimulus.id)).toEqual([`record:${delta.stimulusId}:2`]);
  });

  it('counts a batch recorded only by a revision citing its observations or a declared no-update', async () => {
    const adapter = await database();
    const record = recordOrderPayload(delta, 1);
    expect(batchRecorded(adapter, record)).toBe(false);
    revise(adapter, 'obs-other');
    expect(batchRecorded(adapter, record)).toBe(false);
    revise(adapter, 'obs-2');
    expect(batchRecorded(adapter, record)).toBe(true);
  });

  it.each([false, true])(
    'accepts a no-update from the order run or its child (child: %s)',
    async (child) => {
      const adapter = await database();
      const record = recordOrderPayload(delta, 1);
      noUpdate(adapter, `record:${delta.stimulusId}:2`, child);
      expect(batchRecorded(adapter, record)).toBe(true);
    }
  );

  it('credits a carried batch with a no-update in the carrying order only when it cites the batch', async () => {
    const citing = await database();
    const record = recordOrderPayload(delta, 1);
    noUpdate(citing, `record:${later.stimulusId}:1`, false, ['obs-3', 'obs-2']);
    expect(batchRecorded(citing, record)).toBe(false);
    expect(batchRecorded(citing, record, [`record:${later.stimulusId}:1`])).toBe(true);
    // A no-update about the newer messages alone does not cover the carried batch.
    const other = await database();
    noUpdate(other, `record:${later.stimulusId}:1`, false, ['obs-3']);
    expect(batchRecorded(other, record, [`record:${later.stimulusId}:1`])).toBe(false);
  });

  it('enqueues the first order without refs and with the deterministic payload', async () => {
    const { port, accepted } = orders(await database());
    port.enqueueFirst(deltaRow(delta));
    expect(accepted).toEqual([
      expect.objectContaining({
        id: `record:${delta.stimulusId}:1`,
        kind: 'scheduled',
        channelKey: 'operator:record',
        payload: recordOrderPayload(delta, 1),
      }),
    ]);
    expect(accepted[0]).not.toHaveProperty('refs');
  });

  it('leaves a first order that is already stored, as a replayed notify result would enqueue it again', async () => {
    const adapter = await database();
    store(adapter, recordOrderPayload(delta, 1), 'pending');
    const { port, accepted } = orders(adapter);
    port.enqueueFirst(deltaRow(delta));
    expect(accepted).toEqual([]);
  });

  it('takes over an interrupted live delta: recorded, ordered within the day, lost after it', async () => {
    // The shape a live collector stored before this change, with its extra fields.
    const legacy = {
      stimulusId: 'source_delta:legacy',
      channelKey: 'source:calendar:primary',
      payload: {
        channel: 'primary',
        coalesceKey: 'calendar:primary',
        collector: 'calendar',
        kind: 'calendar',
        preview: ['event moved'],
        refs: [
          {
            connector: 'calendar',
            contentHash: 'hash-1',
            metadata: { status: 'confirmed' },
            observationRef: 'obs-legacy',
            observedAt: new Date().toISOString(),
            sourceAt: new Date(Date.now() + 30 * DAY).toISOString(),
            sourceEntityId: 'event-1',
            sourceId: 'event-1:v2',
          },
        ],
      },
    };
    const interrupted = (source: typeof delta | typeof legacy, createdAt: number) =>
      ({ ...(deltaRow(source as typeof delta) as object), createdAt }) as never;

    const fresh = orders(await database());
    expect(fresh.port.onDeltaLost(interrupted(legacy, Date.now()))).toBe('ordered');
    expect(fresh.accepted.map((stimulus) => stimulus.id)).toEqual([
      `record:${legacy.stimulusId}:1`,
    ]);

    const citedAdapter = await database();
    revise(citedAdapter, 'obs-1');
    const cited = orders(citedAdapter);
    expect(cited.port.onDeltaLost(interrupted(delta, Date.now()))).toBe('recorded');
    expect(cited.accepted).toEqual([]);
    expect(cited.events).toEqual([
      { type: 'recorded', deltaStimulusId: delta.stimulusId, attempt: 0 },
    ]);

    // An older batch is not recorded now: its facts would come back stale.
    const old = orders(await database());
    expect(old.port.onDeltaLost(interrupted(delta, Date.now() - DAY - 1))).toBe('lost');
    expect(old.accepted).toEqual([]);
    expect(old.events[0]).toMatchObject({
      type: 'lost',
      reason: 'the delta came in more than a day ago',
    });

    const empty = orders(await database());
    const bare = { ...delta, payload: { refs: [{ contentPreview: 'a' }] } };
    expect(empty.port.onDeltaLost(interrupted(bare as typeof delta, Date.now()))).toBe('lost');
    expect(empty.events[0]).toMatchObject({
      type: 'lost',
      reason: 'the interrupted delta carries no observation to record',
    });
  });

  it('refuses a live delta with no observation to record', async () => {
    const { port } = orders(await database());
    expect(() =>
      port.enqueueFirst({
        ...row(1),
        kind: 'source_delta',
        stimulusId: 'x',
        payload: { refs: [] },
      } as never)
    ).toThrow(/no observation/);
  });

  it('holds an unrecorded batch for the tick instead of re-sending it, then logs the loss', async () => {
    const adapter = await database();
    const { port, accepted, events, tick } = orders(adapter);
    port.onResult(row(1), 'run-a');
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ type: 'waiting', attempt: 1 });
    expect(accepted).toEqual([]);
    tick();
    expect(accepted.map((stimulus) => stimulus.id)).toEqual([`record:${delta.stimulusId}:2`]);
    expect(events[1]).toMatchObject({
      type: 'retry',
      attempt: 2,
      order: `record:${delta.stimulusId}:2`,
    });
    const last = store(
      adapter,
      recordOrderPayload(delta, RECORD_ORDER_MAX_ATTEMPTS),
      'claimed',
      'uncertain'
    );
    await port.onLost(last, 'uncertain after restart');
    expect(events[2]).toMatchObject({
      type: 'lost',
      attempt: RECORD_ORDER_MAX_ATTEMPTS,
      reason: 'uncertain after restart',
    });
    expect(accepted).toHaveLength(1);
  });

  it("carries a waiting batch into the channel's next delta order and drops its tick", async () => {
    const adapter = await database();
    const { port, accepted, events, tick } = orders(adapter);
    port.onResult(row(1), 'run-a');
    await vi.waitFor(() => expect(events).toHaveLength(1));
    port.enqueueFirst(deltaRow(later));
    const first = recordOrderPayload(later, 1);
    expect(accepted.map((stimulus) => stimulus.id)).toEqual([`record:${later.stimulusId}:1`]);
    expect(accepted[0]!.payload).toEqual({
      ...first,
      carried: [
        {
          deltaStimulusId: delta.stimulusId,
          observationRefs: ['obs-1', 'obs-2'],
          lines: recordOrderPayload(delta, 1).lines,
          attempt: 2,
        },
      ],
    });
    expect(events[1]).toMatchObject({
      type: 'retry',
      deltaStimulusId: delta.stimulusId,
      attempt: 2,
      order: `record:${later.stimulusId}:1`,
    });
    tick();
    expect(accepted).toHaveLength(1);
  });

  it('checks every batch an order carried, and recovery follows a batch into the order carrying it', async () => {
    const adapter = await database();
    mailboxRow(adapter, 1, 'acked');
    const carrying = {
      ...recordOrderPayload(later, 1),
      carried: [{ ...recordOrderPayload(delta, 2), attempt: 2 }].map(
        ({ deltaStimulusId, observationRefs, lines, attempt }) => ({
          deltaStimulusId,
          observationRefs,
          lines,
          attempt,
        })
      ),
    };
    const carryingRow = store(adapter, carrying, 'pending');
    const queued = orders(adapter);
    queued.port.recover();
    queued.tick();
    expect(queued.accepted).toEqual([]);
    expect(queued.events).toEqual([]);

    revise(adapter, 'obs-3');
    const { port, events } = orders(adapter);
    port.onResult(carryingRow, 'run-b');
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events).toEqual([
      { type: 'recorded', deltaStimulusId: later.stimulusId, attempt: 1 },
      expect.objectContaining({ type: 'waiting', deltaStimulusId: delta.stimulusId, attempt: 2 }),
    ]);
  });

  it('sends no turn for a batch recorded while it waited', async () => {
    const adapter = await database();
    const { port, accepted, events, tick } = orders(adapter);
    port.onResult(row(1), 'run-a');
    await vi.waitFor(() => expect(events).toHaveLength(1));
    revise(adapter, 'obs-1');
    tick();
    expect(accepted).toEqual([]);
    expect(events[1]).toEqual({ type: 'recorded', deltaStimulusId: delta.stimulusId, attempt: 1 });
  });

  it("leaves a batch recorded while it waited out of the channel's next delta order", async () => {
    const adapter = await database();
    const { port, accepted, events } = orders(adapter);
    port.onResult(row(1), 'run-a');
    await vi.waitFor(() => expect(events).toHaveLength(1));
    revise(adapter, 'obs-2');
    port.enqueueFirst(deltaRow(later));
    expect(accepted[0]!.payload).toEqual(recordOrderPayload(later, 1));
    expect(events[1]).toEqual({ type: 'recorded', deltaStimulusId: delta.stimulusId, attempt: 1 });
  });

  it('retries a batch whose order was parked uncertain, though the row stays claimed', async () => {
    const adapter = await database();
    const parked = store(adapter, recordOrderPayload(delta, 1), 'claimed', 'uncertain');
    const { port, accepted, tick } = orders(adapter);
    port.recover();
    await port.onLost(parked, 'uncertain after restart');
    tick();
    expect(accepted.map((stimulus) => stimulus.id)).toEqual([`record:${delta.stimulusId}:2`]);
  });

  it('ignores a parked row whose batch already has a later attempt', async () => {
    const adapter = await database();
    const parked = store(adapter, recordOrderPayload(delta, 1), 'claimed', 'uncertain');
    mailboxRow(adapter, 2, 'pending');
    const { port, accepted, events, tick } = orders(adapter);
    await port.onLost(parked, 'uncertain after restart');
    tick();
    expect(events).toEqual([]);
    expect(accepted).toEqual([]);
  });

  it("keeps the channel's other waiting batches when the own batch's next order is already stored", async () => {
    const adapter = await database();
    const { port, accepted, events, tick } = orders(adapter);
    port.onResult(row(1), 'run-a');
    port.onResult(
      {
        ...row(1),
        stimulusId: `record:${later.stimulusId}:1`,
        payload: recordOrderPayload(later, 1) as never,
      },
      'run-b'
    );
    await vi.waitFor(() => expect(events).toHaveLength(2));
    // The own batch's next order, stored before the day recovery reads.
    store(adapter, recordOrderPayload(delta, 2), 'acked', undefined, Date.now() - 2 * DAY);
    store(adapter, recordOrderPayload(other, 1), 'acked');
    tick();
    expect(accepted).toEqual([]);
    tick();
    expect(accepted.map((stimulus) => stimulus.id)).toEqual([`record:${later.stimulusId}:2`]);
  });

  it('does not bring back a batch whose parked row is older than the day recovery reads', async () => {
    const adapter = await database();
    const parked = store(
      adapter,
      recordOrderPayload(delta, 1),
      'claimed',
      'uncertain',
      Date.now() - 3 * DAY
    );
    store(adapter, recordOrderPayload(other, 1), 'acked');
    const { port, accepted, events, timers } = orders(adapter);
    await port.onLost(parked, 'uncertain after restart');
    expect(events).toEqual([]);
    expect(timers).toEqual([]);
    expect(accepted).toEqual([]);
  });

  it('recovers a batch left waiting before a stop longer than a day', async () => {
    const adapter = await database();
    store(adapter, recordOrderPayload(delta, 1), 'acked', undefined, Date.now() - 3 * DAY);
    const { port, accepted, tick } = orders(adapter);
    port.recover();
    tick();
    expect(accepted.map((stimulus) => stimulus.id)).toEqual([`record:${delta.stimulusId}:2`]);
  });

  it('keeps a waiting batch when the order that would carry it is refused', async () => {
    const adapter = await database();
    const accepted: string[] = [];
    const events: RecordOrderEvent[] = [];
    const timers: Array<() => void> = [];
    let refuse = true;
    const port = createRecordOrders({
      adapter,
      accept: (stimulus) => {
        if (refuse) throw new Error('database is locked');
        accepted.push(stimulus.id);
        return { inputId: stimulus.id, state: 'accepted' };
      },
      processStartedAt: 0,
      onEvent: (event) => events.push(event),
      sleep: async () => {},
      setTimer: (run) => {
        timers.push(run);
        return () => {};
      },
    });
    port.onResult(row(1), 'run-a');
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(() => port.enqueueFirst(deltaRow(later))).toThrow(/locked/);
    refuse = false;
    for (const run of timers.splice(0)) run();
    expect(accepted).toEqual([`record:${delta.stimulusId}:2`]);
  });

  it('stops once the batch is recorded, whichever run wrote it', async () => {
    const adapter = await database();
    const dead = store(adapter, recordOrderPayload(delta, 1), 'acked');
    const { port, accepted, events } = orders(adapter);
    revise(adapter, 'obs-1');
    await port.onLost(dead, 'dead');
    expect(events).toEqual([{ type: 'recorded', deltaStimulusId: delta.stimulusId, attempt: 1 }]);
    expect(accepted).toHaveLength(0);
  });

  it('waits for child runs this process started before checking', async () => {
    const adapter = await database();
    adapter
      .prepare(
        `INSERT INTO model_runs (model_run_id, status, created_at, parent_model_run_id) VALUES ('child-running', 'running', 5, 'run-a')`
      )
      .run();
    let slept = 0;
    const events: RecordOrderEvent[] = [];
    const port = createRecordOrders({
      adapter,
      accept: (stimulus) => ({ inputId: stimulus.id, state: 'accepted' }),
      processStartedAt: 0,
      onEvent: (event) => events.push(event),
      childWaitMs: 60_000,
      sleep: async () => {
        slept += 1;
        adapter
          .prepare(
            `UPDATE model_runs SET status = 'committed' WHERE model_run_id = 'child-running'`
          )
          .run();
      },
    });
    port.onResult(row(1), 'run-a');
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(slept).toBe(1);
  });

  it('drops a check cut off by shutdown without logging a loss', async () => {
    const adapter = await database();
    adapter
      .prepare(
        `INSERT INTO model_runs (model_run_id, status, created_at, parent_model_run_id) VALUES ('child-running', 'running', 5, 'run-a')`
      )
      .run();
    const events: RecordOrderEvent[] = [];
    const accepted: string[] = [];
    let port: ReturnType<typeof createRecordOrders>;
    const stoppedDuringWait = new Promise<void>((resolve) => {
      port = createRecordOrders({
        adapter,
        accept: (stimulus) => {
          accepted.push(stimulus.id);
          return { inputId: stimulus.id, state: 'accepted' };
        },
        processStartedAt: 0,
        onEvent: (event) => events.push(event),
        sleep: async () => {
          port.stop();
          resolve();
        },
      });
    });
    port!.onResult(row(1), 'run-a');
    await stoppedDuringWait;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual([]);
    expect(accepted).toEqual([]);
  });

  it('treats child runs from before this process as ended', async () => {
    const adapter = await database();
    adapter
      .prepare(
        `INSERT INTO model_runs (model_run_id, status, created_at, parent_model_run_id) VALUES ('orphan', 'running', 5, 'run-a')`
      )
      .run();
    const events: RecordOrderEvent[] = [];
    const sleep = vi.fn(async () => {});
    const port = createRecordOrders({
      adapter,
      accept: (stimulus) => ({ inputId: stimulus.id, state: 'accepted' }),
      processStartedAt: 10,
      onEvent: (event) => events.push(event),
      sleep,
    });
    port.onResult(row(1), 'run-a');
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(sleep).not.toHaveBeenCalled();
  });
});
