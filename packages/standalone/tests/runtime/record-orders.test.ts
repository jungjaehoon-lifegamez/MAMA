import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Stimulus } from '@jungjaehoon/mama-core/runtime/mailbox';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import {
  RECORD_ORDER_MAX_ATTEMPTS,
  batchRecorded,
  createRecordOrders,
  type RecordOrderEvent,
} from '../../src/runtime/record-orders.js';
import { recordOrderPayload } from '../../src/runtime/turn-orders.js';

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

function noUpdate(adapter: Awaited<ReturnType<typeof database>>, orderId: string, child: boolean) {
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
      `INSERT INTO tool_traces (trace_id, model_run_id, tool_name, execution_status, created_at) VALUES ('trace-1', ?, 'work.no_update', 'completed', 1)`
    )
    .run(child ? 'child' : 'parent');
}

function orders(adapter: Awaited<ReturnType<typeof database>>) {
  const accepted: Array<Omit<Stimulus, 'principalId'>> = [];
  const events: RecordOrderEvent[] = [];
  const port = createRecordOrders({
    adapter,
    accept: (stimulus) => {
      accepted.push(stimulus);
      return { inputId: stimulus.id, state: 'accepted' };
    },
    processStartedAt: 0,
    onEvent: (event) => events.push(event),
    sleep: async () => {},
  });
  return { port, accepted, events };
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
  adapter
    .prepare(
      `INSERT INTO mailbox_inputs (stimulus_id, kind, principal_id, channel_key, preview_json, payload_json, occurred_at, created_at, status)
       VALUES (?, 'scheduled', 'owner', 'operator:record', '[]', ?, 1, ?, ?)`
    )
    .run(
      `record:${delta.stimulusId}:${attempt}`,
      JSON.stringify(legacy ? withoutSource : payload),
      Date.now(),
      status
    );
}

describe('record orders', () => {
  it('recovers a lost check at start: next attempt when unrecorded, nothing while one is queued', async () => {
    const adapter = await database();
    mailboxRow(adapter, 1, 'acked');
    const { port, accepted, events } = orders(adapter);
    port.recover();
    expect(accepted.map((stimulus) => stimulus.id)).toEqual([`record:${delta.stimulusId}:2`]);
    expect(events[0]).toMatchObject({ type: 'retry', attempt: 2 });
    mailboxRow(adapter, 2, 'pending');
    const second = orders(adapter);
    second.port.recover();
    expect(second.accepted).toEqual([]);
  });

  it('recovers at start from a record order stored before orders carried their source', async () => {
    const adapter = await database();
    mailboxRow(adapter, 1, 'acked', true);
    const { port, accepted } = orders(adapter);
    port.recover();
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

  it('enqueues the first order without refs and with the deterministic payload', async () => {
    const { port, accepted } = orders(await database());
    port.enqueueFirst({
      ...row(1),
      kind: 'source_delta',
      stimulusId: delta.stimulusId,
      channelKey: 'room',
      payload: delta.payload,
    } as never);
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

  it('enqueues the next attempt while the batch is unrecorded, then logs the loss', async () => {
    const adapter = await database();
    const { port, accepted, events } = orders(adapter);
    port.onResult(row(1), 'run-a');
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ type: 'retry', attempt: 2 });
    expect(accepted.map((stimulus) => stimulus.id)).toEqual([`record:${delta.stimulusId}:2`]);
    await port.onLost(row(RECORD_ORDER_MAX_ATTEMPTS), 'uncertain after restart');
    expect(events[1]).toMatchObject({
      type: 'lost',
      attempt: RECORD_ORDER_MAX_ATTEMPTS,
      reason: 'uncertain after restart',
    });
    expect(accepted).toHaveLength(1);
  });

  it('stops once the batch is recorded, whichever run wrote it', async () => {
    const adapter = await database();
    const { port, accepted, events } = orders(adapter);
    revise(adapter, 'obs-1');
    await port.onLost(row(1), 'dead');
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
