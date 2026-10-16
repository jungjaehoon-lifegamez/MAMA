import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Mailbox } from '@jungjaehoon/mama-core/runtime/mailbox';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { hasWaitingInput } from '../../src/runtime/owner-runtime.js';

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
