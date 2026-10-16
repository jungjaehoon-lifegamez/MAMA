import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Mailbox } from '@jungjaehoon/mama-core/runtime/mailbox';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { countInputsNotDone, hasWaitingInput } from '../../src/runtime/owner-runtime.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('counts an input about to run or running, not one waiting out a retry or parked (/new)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mama-waiting-input-'));
  roots.push(root);
  const database = await openCoreDatabase({ path: join(root, 'core.db') });
  try {
    const adapter = database.adapter;
    let now = 1_000_000;
    const mailbox = new Mailbox(adapter, () => now);
    const person = 'fixture-waiting-person';
    const enqueue = (id: string) =>
      mailbox.enqueue({
        id,
        kind: 'source_delta',
        principalId: person,
        channelKey: 'fixture-channel',
        refs: [{ refId: `${id}-ref`, observationRef: null }],
        occurredAt: 1,
      })!;
    expect(hasWaitingInput(adapter, person, now)).toBe(false);
    const first = enqueue('fixture-due');
    expect(hasWaitingInput(adapter, person, now)).toBe(true);
    expect(hasWaitingInput(adapter, 'fixture-someone-else', now)).toBe(false);
    // Claimed: its turn is running or about to.
    expect(mailbox.claimNext()?.id).toBe(first);
    expect(hasWaitingInput(adapter, person, now)).toBe(true);
    // A failed delivery waits out its backoff; it is not about to run.
    expect(mailbox.retry(first, 'fixture failure')).toBe('pending');
    expect(hasWaitingInput(adapter, person, now)).toBe(false);
    now += 24 * 60 * 60 * 1000;
    expect(hasWaitingInput(adapter, person, now)).toBe(true);
    // A claimed input parked as uncertain waits for reconciliation, not for a turn.
    expect(mailbox.claimNext()?.id).toBe(first);
    adapter
      .prepare(
        "INSERT INTO native_input_deliveries (input_id, state, updated_at) VALUES (?, 'uncertain', ?)"
      )
      .run(first, now);
    expect(hasWaitingInput(adapter, person, now)).toBe(false);
  } finally {
    await database.close();
  }
});

it("counts inputs not yet done for everyone, one person, or one person's group (/status)", async () => {
  const root = mkdtempSync(join(tmpdir(), 'mama-pending-count-'));
  roots.push(root);
  const database = await openCoreDatabase({ path: join(root, 'core.db') });
  try {
    const adapter = database.adapter;
    const mailbox = new Mailbox(adapter, () => 1_000_000);
    const add = (id: string, principalId: string, channelKey: string) =>
      mailbox.enqueue({
        id,
        kind: 'source_delta',
        principalId,
        channelKey,
        refs: [{ refId: `${id}-ref`, observationRef: null }],
        occurredAt: 1,
      });
    add('fixture-dm', 'fixture-member-a', 'fixture-dm-chat');
    add('fixture-room', 'fixture-member-a', '-7001');
    add('fixture-other-room', 'fixture-member-a', '-7002');
    add('fixture-common', 'fixture-common-principal', '-7001');
    expect(countInputsNotDone(adapter, {})).toBe(4);
    expect(countInputsNotDone(adapter, { principalId: 'fixture-member-a' })).toBe(3);
    // A group reads the reply: only that member's inputs in that group.
    expect(countInputsNotDone(adapter, { principalId: 'fixture-member-a', channel: '-7001' })).toBe(
      1
    );
    expect(countInputsNotDone(adapter, { principalId: 'fixture-common-principal' })).toBe(1);
    // A claimed input queued behind another conversation's turn is not done either.
    mailbox.claimNext();
    expect(countInputsNotDone(adapter, {})).toBe(4);
  } finally {
    await database.close();
  }
});
