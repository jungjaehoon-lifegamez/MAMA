/**
 * The batch a bounded run was handed becomes the cause of what it changes.
 *
 * This is the difference between MAMA and the peer system it is modelled on, measured:
 * the peer produced 1,099 durable effects over five weeks and 100% of them name their
 * cause, because its job is defined as one channel's delta and every effect inherits that
 * batch. MAMA's projected attribution was 32%, and 375 of the 381 unattributed changes
 * were task updates - because the system flattened the batch into prompt text and then
 * asked the AGENT to restate an id it already knew.
 *
 * The ids were never missing. Measured on the live ledger: all 616 reconcile workorders
 * carry them, 2,017 in total, inside `deltaLines` as `[id:evt_...]` headers that only
 * prose-parsing could recover. Nothing read them back.
 *
 * Synthetic data only; in-memory sqlite.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { TaskLedger } from '../../src/operator/task-ledger.js';
import { listEffects, changeCoverage } from '../../src/evidence/effects.js';

describe('a bounded run attributes what it changes to its batch', () => {
  let db: SQLiteDatabase;
  let ledger: TaskLedger;
  const adapter = () => db as never;
  const BATCH = ['evt_a', 'evt_b', 'evt_c'];

  beforeEach(() => {
    db = new Database(':memory:');
    ledger = new TaskLedger(db);
  });

  // The case that was 375 of 381 unattributed: an update where the agent said nothing.
  it('attributes an update to the batch without the agent naming anything', () => {
    const task = ledger.create({ title: 'follow up' });
    ledger.update(task.id, { status: 'done' }, { runId: 'mr_1', causeEventIds: BATCH });

    const update = listEffects(adapter()).find((e) => e.kind === 'task_update');
    expect(update).toMatchObject({ causeState: 'attributed', sourceEventIds: BATCH });
  });

  it('attributes a create the same way', () => {
    ledger.create({ title: 'new work' }, { runId: 'mr_1', causeEventIds: BATCH });

    expect(listEffects(adapter())[0]).toMatchObject({
      kind: 'task_create',
      causeState: 'attributed',
      sourceEventIds: BATCH,
    });
  });

  // The precedence was the other way around at first: a named source event is more PRECISE
  // than the batch, so it won. Review pointed out what precision costs here - source_event_id
  // arrives on agent-authored task_create input, so preferring it handed the agent the power
  // to choose its own attribution, and any 1-200 character string passes the shape check.
  // The host batch is the unforgeable channel, so the host batch wins.
  it('prefers the host batch over the agent-supplied source event', () => {
    ledger.create(
      { title: 'from one message', source_channel: 'chat:C001', source_event_id: 'evt_forged' },
      { runId: 'mr_1', causeEventIds: BATCH }
    );

    expect(listEffects(adapter())[0]).toMatchObject({ sourceEventIds: BATCH });
  });

  // Weaker evidence is not worthless: an unbounded run has nothing else to offer.
  it('falls back to the source event when the run was handed no batch', () => {
    ledger.create(
      { title: 'from one message', source_channel: 'chat:C001', source_event_id: 'evt_b' },
      { runId: 'mr_1' }
    );

    expect(listEffects(adapter())[0]).toMatchObject({
      causeState: 'attributed',
      sourceEventIds: ['evt_b'],
    });
  });

  // A run that was handed no batch is still honest about it rather than inventing one.
  it('leaves a change unattributed when the run had no batch', () => {
    const task = ledger.create({ title: 'unbounded' });
    ledger.update(task.id, { status: 'done' }, { runId: 'mr_1' });

    expect(listEffects(adapter()).find((e) => e.kind === 'task_update')).toMatchObject({
      causeState: 'unattributed',
      sourceEventIds: [],
    });
  });

  // The number this exists to move.
  it('turns a whole reconcile run attributed', () => {
    const created = ledger.create({ title: 'a' }, { runId: 'mr_1', causeEventIds: BATCH });
    ledger.update(created.id, { status: 'in_progress' }, { runId: 'mr_1', causeEventIds: BATCH });
    ledger.create({ title: 'b' }, { runId: 'mr_1', causeEventIds: BATCH });

    expect(changeCoverage(adapter())).toEqual({ attributed: 3, unattributed: 0 });
  });

  // A batch of unusable ids is not a batch. The change is still recorded, truthfully.
  it('does not let a malformed batch become a false attribution', () => {
    const task = ledger.create({ title: 'x' });
    ledger.update(
      task.id,
      { status: 'done' },
      { runId: 'mr_1', causeEventIds: ['   ', '', 'e'.repeat(400)] }
    );

    expect(listEffects(adapter()).find((e) => e.kind === 'task_update')).toMatchObject({
      causeState: 'unattributed',
    });
  });
});
