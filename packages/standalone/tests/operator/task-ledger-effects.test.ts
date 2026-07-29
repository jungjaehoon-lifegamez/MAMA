/**
 * The task ledger writing to the effect ledger.
 *
 * The measurement that motivated this: over ten days the operator ran 1,471 workorders and
 * closed 1,169 of them `done`, while five durable effect receipts existed in total. Nothing
 * downstream could tell a run that changed something from a run that merely finished. These
 * tests hold the boundary where that distinction is now made.
 *
 * Synthetic data only; in-memory sqlite.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database, { type SQLiteDatabase } from '../../src/sqlite.js';
import { TaskLedger } from '../../src/operator/task-ledger.js';
import { occurrenceKeyForTask } from '../../src/operator/task-temporal.js';
import { changeCoverage, listEffects } from '../../src/evidence/effects.js';

describe('task ledger effect recording', () => {
  let db: SQLiteDatabase;
  let ledger: TaskLedger;
  const adapter = () => db as never;

  beforeEach(() => {
    db = new Database(':memory:');
    ledger = new TaskLedger(db);
  });

  it('records a create together with the event it came from', () => {
    const task = ledger.create(
      {
        title: 'follow up on the delivery date',
        source_channel: 'chat:C001',
        source_event_id: 'evt_1',
      },
      { runId: 'mr_7' }
    );

    const [effect] = listEffects(adapter());
    expect(effect).toMatchObject({
      runId: 'mr_7',
      channelId: 'chat:C001',
      causeState: 'attributed',
      sourceEventIds: ['evt_1'],
      kind: 'task_create',
      targetType: 'task',
      targetId: String(task.id),
    });
  });

  // task_update now takes `caused_by`, so this is the shape of an update that supplies
  // none - still the common case, and still counted as unexplained rather than quietly
  // attributed to the event the row was created from, which would claim a causal link
  // nobody established.
  it('records an update with no supplied cause as unattributed', () => {
    const task = ledger.create({
      title: 'follow up',
      source_channel: 'chat:C001',
      source_event_id: 'evt_1',
    });
    ledger.update(task.id, { status: 'done' }, { runId: 'mr_8' });

    const updates = listEffects(adapter(), { targetType: 'task' }).filter(
      (e) => e.kind === 'task_update'
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ causeState: 'unattributed', sourceEventIds: [] });
    expect(changeCoverage(adapter())).toEqual({ attributed: 1, unattributed: 1 });
  });

  // The other half of the same rule, now that a cause can be supplied: a citation only
  // means something if a change happened to attach it to.
  it('records a supplied cause on an update that actually changed', () => {
    const task = ledger.create({ title: 'follow up' });
    ledger.update(task.id, { status: 'done' }, { runId: 'mr_8', causeEventId: 'evt_cited' });

    const updates = listEffects(adapter()).filter((e) => e.kind === 'task_update');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      causeState: 'attributed',
      sourceEventIds: ['evt_cited'],
    });
  });

  // `done` must mean "changed". A call that sets a field to what it already held is not a
  // change and must leave no trace, or the ledger inherits the exact defect it replaces.
  it('records nothing when an update changes nothing', () => {
    const task = ledger.create({ title: 'already done', status: 'done' });
    const before = listEffects(adapter()).length;

    ledger.update(task.id, { status: 'done', title: 'already done' }, { runId: 'mr_9' });

    expect(listEffects(adapter())).toHaveLength(before);
  });

  // Redelivery of the same upstream event is an update whose cause genuinely is known.
  it('attributes the upsert path to the event the row is keyed on', () => {
    ledger.create({
      title: 'first delivery',
      source_channel: 'chat:C001',
      source_event_id: 'evt_1',
    });
    ledger.create({
      title: 'first delivery',
      source_channel: 'chat:C001',
      source_event_id: 'evt_1',
      status: 'in_progress',
    });

    const updates = listEffects(adapter()).filter((e) => e.kind === 'task_update');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ causeState: 'attributed', sourceEventIds: ['evt_1'] });
  });

  // The change and its cause commit together or not at all. Tested from the side that can
  // actually fail: if the ledger row cannot be written, the task must not exist either -
  // otherwise the system can change something the ledger will never account for.
  it('rolls the task write back when its effect cannot be recorded', () => {
    db.exec(`
      CREATE TRIGGER refuse_effect BEFORE INSERT ON evidence_effects
      WHEN NEW.effect_kind = 'task_create'
      BEGIN SELECT RAISE(ABORT, 'ledger unavailable'); END
    `);

    expect(() => ledger.create({ title: 'must not survive' })).toThrow(/ledger unavailable/);

    db.exec('DROP TRIGGER refuse_effect');
    expect(ledger.list().filter((t) => t.title === 'must not survive')).toHaveLength(0);
    expect(listEffects(adapter())).toHaveLength(0);
  });

  // Host-internal writes are real changes; inventing a run id for them would be a lie, and
  // dropping them would understate what the system did.
  it('records a change no model run produced', () => {
    ledger.create({ title: 'host-made' });
    const [effect] = listEffects(adapter());
    expect(effect?.runId).toBeNull();
    expect(effect?.causeState).toBe('unattributed');
  });

  // The trusted channel exists precisely because the tool-supplied one is agent-authored.
  // A spread of an absent caller field once erased it, leaving only the forgeable path
  // working - the opposite of the intent.
  it('keeps a host-supplied cause the tool input does not carry', () => {
    ledger.create({ title: 'host knows why' }, { runId: 'mr_host', causeEventId: 'evt_real' });
    expect(listEffects(adapter())[0]).toMatchObject({
      causeState: 'attributed',
      sourceEventIds: ['evt_real'],
    });
  });

  // The canonical case: a scheduled run closing a work item. This path writes owner rows
  // with its own SQL, so it was invisible to the ledger while filing a receipt in a second
  // table - the exact split this design exists to end.
  it('records the change a temporal run makes to an owner task', () => {
    const at = Date.parse('2026-07-21T15:00:00Z');
    db.close();
    db = new Database(':memory:');
    ledger = new TaskLedger(db, { now: () => at, timeZone: 'Asia/Seoul' });

    const task = ledger.create({ title: 'due owner task', due_at: '2026-07-22T00:00:00+09:00' });
    const occurrenceKey = occurrenceKeyForTask(task)!;
    const generationKey = `task:${task.id}:${occurrenceKey}:check:${at}`;
    ledger.enqueueTemporalGeneration({
      generationKey,
      taskId: task.id,
      temporalEpoch: task.temporalEpoch,
      occurrenceKey,
      checkAt: at,
      sourceChannel: task.sourceChannel,
      sourceEventId: task.sourceEventId,
      priority: 'high',
    });
    const claimed = ledger.claimNextWorkOrder()!;
    const context = ledger.loadTemporalWorkContext(claimed.id);

    ledger.applyTemporalEffect(
      context,
      {
        expected_revision: context.revision,
        outcome: 'resolved',
        status: 'done',
        reason: 'Fresh source evidence confirms completion',
      },
      { contextPacketId: 'ctxp_test', contextPacketSha256: 'a'.repeat(64) },
      at
    );

    const recorded = listEffects(adapter(), { targetId: String(task.id) });
    expect(recorded.map((e) => e.kind)).toEqual(['task_update', 'task_create']);
    // Unattributed on purpose: a clock advanced, no event arrived.
    expect(recorded[0]).toMatchObject({ causeState: 'unattributed', runId: null });
  });

  // Found by the existing suite, which already asserts that legacy 400-character source
  // identifiers do not abort a scan. The ledger must degrade the attribution, never the
  // work: enforcement here would let a malformed upstream id block the operator.
  it('degrades a malformed cause to unattributed instead of blocking the write', () => {
    const task = ledger.create({
      title: 'legacy identifiers',
      source_channel: `channel-${'x'.repeat(400)}`,
      source_event_id: `event-${'y'.repeat(400)}`,
    });

    expect(ledger.getById(task.id)).not.toBeNull();
    expect(listEffects(adapter())[0]).toMatchObject({
      kind: 'task_create',
      causeState: 'unattributed',
      sourceEventIds: [],
    });
  });

  // A receipt that cannot tell two materially different writes apart is not a receipt.
  it('hashes everything the create wrote, not a subset of it', () => {
    ledger.create({ title: 'same', assignee: 'alice', deadline: '2026-08-01' });
    ledger.create({ title: 'same', assignee: 'bob', deadline: '2026-09-01', confirmed: true });
    const [second, first] = listEffects(adapter());
    expect(second?.payloadHash).not.toBe(first?.payloadHash);
  });
});
