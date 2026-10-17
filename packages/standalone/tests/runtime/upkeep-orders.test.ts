import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { JudgmentAccess } from '@jungjaehoon/mama-core/knowledge';
import type { MailboxRow, Stimulus } from '@jungjaehoon/mama-core/runtime/mailbox';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { CLOSE_ORDER_CHANNEL, closeUpkeepKind } from '../../src/runtime/upkeep-close.js';
import {
  UPKEEP_MAX_ATTEMPTS,
  createUpkeepOrders,
  parseUpkeepOrder,
  type UpkeepEvent,
} from '../../src/runtime/upkeep-orders.js';

const homes: string[] = [];
const databases: Array<Awaited<ReturnType<typeof openCoreDatabase>>> = [];

afterEach(async () => {
  for (const database of databases.splice(0).reverse()) await database.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

type Adapter = Awaited<ReturnType<typeof openCoreDatabase>>['adapter'];

async function database(): Promise<Adapter> {
  const home = mkdtempSync(join(tmpdir(), 'mama-upkeep-'));
  homes.push(home);
  const db = await openCoreDatabase({ path: join(home, 'state.db') });
  databases.push(db);
  db.adapter.exec('PRAGMA foreign_keys = OFF');
  return db.adapter;
}

const SINCE = 1_000_000;
const NOW = SINCE + 60 * 60 * 1000;
const access: JudgmentAccess = {
  principalId: 'owner',
  agentId: 'owner-agent',
  scopes: [{ kind: 'user', id: 'owner' }],
};

interface Revision {
  revision: number;
  set: Record<string, unknown>;
  createdAt: number;
  appliesUntil?: number;
  modelRunId?: string;
}

// The rows stand for revisions the knowledge layer wrote; the scan and check read only these.
function work(
  adapter: Adapter,
  id: string,
  revisions: Revision[],
  options: { withdrawn?: boolean; scope?: string } = {}
) {
  const head = `head-${id}`;
  adapter
    .prepare(
      `INSERT INTO commitments (commitment_id, current_revision, head_record_id, withdrawn, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 1)`
    )
    .run(id, revisions.length, head, options.withdrawn ? 1 : 0);
  for (const revision of revisions)
    adapter
      .prepare(
        `INSERT INTO commitment_assignments (commitment_id, revision, record_id, operation, set_json, clear_json, applies_until, created_at, model_run_id)
         VALUES (?, ?, ?, 'revise', ?, '[]', ?, ?, ?)`
      )
      .run(
        id,
        revision.revision,
        `${id}-r${revision.revision}`,
        JSON.stringify(revision.set),
        revision.appliesUntil ?? null,
        revision.createdAt,
        revision.modelRunId ?? null
      );
  if (options.scope !== undefined)
    adapter
      .prepare(`INSERT INTO memory_scope_bindings (memory_id, scope_id) VALUES (?, ?)`)
      .run(head, options.scope);
}

/** An order's run, as the delivery records it, with its writes. */
function run(adapter: Adapter, orderId: string, runId: string) {
  adapter
    .prepare(
      `INSERT INTO model_runs (model_run_id, status, created_at, input_refs_json) VALUES (?, 'committed', ?, ?)`
    )
    .run(runId, NOW, JSON.stringify({ sourceMessageRef: orderId }));
}

function noUpdate(adapter: Adapter, runId: string, input: Record<string, unknown>) {
  adapter
    .prepare(
      `INSERT INTO tool_traces (trace_id, model_run_id, tool_name, input_summary, execution_status, created_at)
       VALUES (?, ?, 'work.no_update', ?, 'completed', ?)`
    )
    .run(`trace-${runId}`, runId, JSON.stringify(input), NOW);
}

function harness(adapter: Adapter, at = NOW) {
  const events: UpkeepEvent[] = [];
  const accepted: Array<Omit<Stimulus, 'principalId'>> = [];
  let clock = at;
  const orders = createUpkeepOrders({
    adapter,
    accept: (stimulus) => {
      accepted.push(stimulus);
      adapter
        .prepare(
          `INSERT INTO mailbox_inputs (stimulus_id, kind, principal_id, channel_key, preview_json, payload_json, occurred_at, created_at, status)
           VALUES (?, 'scheduled', 'owner', ?, '[]', ?, ?, ?, 'claimed')`
        )
        .run(stimulus.id, stimulus.channelKey, JSON.stringify(stimulus.payload), clock, clock);
      return { inputId: stimulus.id, state: 'accepted' };
    },
    kinds: [closeUpkeepKind({ since: SINCE, access: () => access, timeZone: () => 'UTC' })],
    processStartedAt: 0,
    onEvent: (event) => events.push(event),
    sleep: async () => {},
    now: () => clock,
  });
  /** The order's row as delivery hands it back, after it ran. */
  const finish = (index: number): MailboxRow => {
    const stimulus = accepted[index]!;
    adapter
      .prepare(`UPDATE mailbox_inputs SET status = 'acked' WHERE stimulus_id = ?`)
      .run(stimulus.id);
    return {
      id: index + 1,
      stimulusId: stimulus.id,
      principalId: 'owner',
      kind: 'scheduled',
      channelKey: stimulus.channelKey,
      occurredAt: clock,
      refs: [],
      preview: [],
      status: 'claimed',
      attempts: 1,
      createdAt: clock,
      coalesceKey: null,
      payload: stimulus.payload as never,
    };
  };
  const settled = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    orders,
    events,
    accepted,
    finish,
    settled,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const closed = (createdAt: number, status = 'done', extra: Partial<Revision> = {}): Revision => ({
  revision: 2,
  set: { status },
  createdAt,
  ...extra,
});

describe('closing summary scan', () => {
  it('orders items closed after the start, as the current fold shows them', async () => {
    const adapter = await database();
    work(adapter, 'c-after', [
      { revision: 1, set: { title: 'After', status: 'in_progress' }, createdAt: 1 },
      closed(SINCE + 10),
    ]);
    work(adapter, 'c-before', [
      { revision: 1, set: { title: 'Before' }, createdAt: 1 },
      closed(SINCE - 10),
    ]);
    work(adapter, 'c-cancelled', [
      { revision: 1, set: { title: 'Cancelled' }, createdAt: 1 },
      closed(SINCE + 20, 'cancelled'),
    ]);
    // Done once, but that revision stopped applying: the item is open again.
    work(adapter, 'c-folded', [
      { revision: 1, set: { title: 'Folded', status: 'in_progress' }, createdAt: 1 },
      closed(SINCE + 30, 'done', { appliesUntil: SINCE + 40 }),
    ]);
    work(
      adapter,
      'c-withdrawn',
      [{ revision: 1, set: { title: 'Withdrawn' }, createdAt: 1 }, closed(SINCE + 50)],
      { withdrawn: true }
    );
    work(
      adapter,
      'c-hidden',
      [{ revision: 1, set: { title: 'Hidden' }, createdAt: 1 }, closed(SINCE + 60)],
      { scope: 'someone-else' }
    );
    const h = harness(adapter);
    h.orders.tick('close');
    expect(h.accepted).toHaveLength(1);
    const order = parseUpkeepOrder(h.accepted[0]!.payload as never);
    expect(h.accepted[0]!.channelKey).toBe(CLOSE_ORDER_CHANNEL);
    expect(order.subjects.map((subject) => subject.key)).toEqual(['c-after:2', 'c-cancelled:2']);
    const text = h.orders.render(h.finish(0), new Date(NOW));
    expect(text).toContain('[upkeep_close] 2 closed work items');
    expect(text).toContain('- c-after (done');
    expect(text).toContain('After');
  });

  it('takes a reopened item that closes again as a new subject', async () => {
    const adapter = await database();
    work(adapter, 'c-again', [
      { revision: 1, set: { title: 'Again' }, createdAt: 1 },
      closed(SINCE + 10),
      { revision: 3, set: { status: 'in_progress' }, createdAt: SINCE + 20 },
      { revision: 4, set: { status: 'done' }, createdAt: SINCE + 30 },
    ]);
    const h = harness(adapter);
    h.orders.tick('close');
    expect(parseUpkeepOrder(h.accepted[0]!.payload as never).subjects.map((s) => s.key)).toEqual([
      'c-again:4',
    ]);
  });

  it('places no second order while one is open, and nothing when every subject is settled', async () => {
    const adapter = await database();
    work(adapter, 'c-one', [
      { revision: 1, set: { title: 'One' }, createdAt: 1 },
      closed(SINCE + 10),
    ]);
    const h = harness(adapter);
    h.orders.tick('close');
    h.orders.tick('close');
    expect(h.accepted).toHaveLength(1);
    const row = h.finish(0);
    run(adapter, row.stimulusId, 'run-1');
    adapter
      .prepare(
        `INSERT INTO commitment_assignments (commitment_id, revision, record_id, operation, set_json, clear_json, created_at, model_run_id)
         VALUES ('c-one', 3, 'c-one-r3', 'revise', ?, '[]', ?, 'run-1')`
      )
      .run(
        JSON.stringify({ description: 'Two rounds of outside feedback, fixed on the third.' }),
        NOW
      );
    h.orders.onResult(row, 'run-1');
    await h.settled();
    expect(h.events).toContainEqual({ type: 'checked', kind: 'close', subject: 'c-one:2' });
    h.orders.tick('close');
    expect(h.accepted).toHaveLength(1);
  });
});

describe('closing summary check', () => {
  it('counts a description from the order run or a no-update naming the item, not a status-only revision', async () => {
    const adapter = await database();
    work(adapter, 'c-summary', [
      { revision: 1, set: { title: 'Summary' }, createdAt: 1 },
      closed(SINCE + 10),
    ]);
    work(adapter, 'c-status', [
      { revision: 1, set: { title: 'Status' }, createdAt: 1 },
      closed(SINCE + 20),
    ]);
    work(adapter, 'c-noupdate', [
      { revision: 1, set: { title: 'NoUpdate' }, createdAt: 1 },
      closed(SINCE + 30),
    ]);
    work(adapter, 'c-other-run', [
      { revision: 1, set: { title: 'Other' }, createdAt: 1 },
      closed(SINCE + 40),
    ]);
    const h = harness(adapter);
    h.orders.tick('close');
    const row = h.finish(0);
    run(adapter, row.stimulusId, 'run-1');
    const write = (id: string, set: Record<string, unknown>, runId: string | null) =>
      adapter
        .prepare(
          `INSERT INTO commitment_assignments (commitment_id, revision, record_id, operation, set_json, clear_json, created_at, model_run_id)
           VALUES (?, 3, ?, 'revise', ?, '[]', ?, ?)`
        )
        .run(id, `${id}-r3`, JSON.stringify(set), NOW, runId);
    write('c-summary', { description: 'Submitted twice; one round of outside feedback.' }, 'run-1');
    write('c-status', { status: 'done' }, 'run-1');
    noUpdate(adapter, 'run-1', { reason: 'already summarized', commitmentIds: ['c-noupdate'] });
    // A description written by some other turn is not this order's summary.
    write('c-other-run', { description: 'latest event narrative' }, 'unrelated-run');
    h.orders.onResult(row, 'run-1');
    await h.settled();
    const by = (subject: string) =>
      h.events.find((event) => 'subject' in event && event.subject === subject)?.type;
    expect(by('c-summary:2')).toBe('checked');
    expect(by('c-noupdate:2')).toBe('checked');
    expect(by('c-status:2')).toBe('waiting');
    expect(by('c-other-run:2')).toBe('waiting');
  });

  it('orders an unchecked subject again, and reports it lost after the last attempt without ordering it more', async () => {
    const adapter = await database();
    work(adapter, 'c-stuck', [
      { revision: 1, set: { title: 'Stuck' }, createdAt: 1 },
      closed(SINCE + 10),
    ]);
    const h = harness(adapter);
    for (let attempt = 1; attempt <= UPKEEP_MAX_ATTEMPTS; attempt += 1) {
      h.orders.tick('close');
      expect(h.accepted).toHaveLength(attempt);
      h.orders.onLost(h.finish(attempt - 1), 'the run failed');
      h.advance(1);
    }
    expect(h.events.filter((event) => event.type === 'waiting')).toHaveLength(
      UPKEEP_MAX_ATTEMPTS - 1
    );
    expect(h.events.at(-1)).toMatchObject({
      type: 'lost',
      subject: 'c-stuck:2',
      attempt: UPKEEP_MAX_ATTEMPTS,
    });
    h.orders.tick('close');
    expect(h.accepted).toHaveLength(UPKEEP_MAX_ATTEMPTS);
  });

  it('leaves a subject older than the attempt window alone', async () => {
    const adapter = await database();
    work(adapter, 'c-old', [
      { revision: 1, set: { title: 'Old' }, createdAt: 1 },
      closed(SINCE + 10),
    ]);
    const h = harness(adapter, SINCE + 10 + 8 * 24 * 60 * 60 * 1000);
    h.orders.tick('close');
    expect(h.accepted).toHaveLength(0);
  });
});
