import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryRecord } from '@jungjaehoon/mama-core';
import type { JsonValue } from '@jungjaehoon/mama-core/knowledge';
import { Mailbox, type StimulusKind } from '@jungjaehoon/mama-core/runtime/mailbox';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { TelegramMessageLedger } from '../../src/gateways/telegram-message-ledger.js';
import {
  ownerExchangesBetween,
  readSessionStartInput,
} from '../../src/runtime/session-start-context.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'session-start-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const database = await openCoreDatabase({ path: join(root, 'state.db') });
  cleanup.push(() => database.close());
  const mailbox = new Mailbox(database.adapter);
  const ledgerPath = join(root, 'ledger.json');
  const ledger = new TelegramMessageLedger(ledgerPath);
  const add = (
    ref: string,
    kind: StimulusKind,
    payload: JsonValue,
    response: string,
    options: {
      principalId?: string;
      delivered?: 'delivered' | 'ready' | null;
      finished?: boolean;
    } = {}
  ) => {
    const principalId = options.principalId ?? 'owner';
    const id = mailbox.enqueue({
      id: ref,
      kind,
      principalId,
      channelKey: kind === 'scheduled' ? 'operator:record' : 'room',
      occurredAt: Number(ref.replace(/\D/g, '')) || 1,
      payload,
    })!;
    if (options.finished === false) return mailbox.readInput(ref, principalId)!;
    const delivery = mailbox.nativeInputs.prepare(id);
    const dispatch = {
      backend: 'claude' as const,
      sessionId: 'native',
      inputId: delivery.invocationId!,
    };
    mailbox.nativeInputs.dispatch(id, dispatch);
    mailbox.nativeInputs.accept(id, dispatch);
    mailbox.nativeInputs.storeResult(id, {
      response,
      turns: 1,
      history: [],
      totalUsage: { input_tokens: 1, output_tokens: 1 },
      stopReason: 'end_turn',
      modelRunId: null,
      modelRunProvenance: 'backend_no_run',
    });
    mailbox.nativeInputs.settle(id);
    mailbox.ack(id);
    if (kind === 'owner_message' && options.delivered !== null) {
      ledger.claim(ref);
      ledger.markReady(ref, response);
      if ((options.delivered ?? 'delivered') === 'delivered') ledger.markDelivered(ref);
    }
    return mailbox.readInput(ref, principalId)!;
  };
  return { database, mailbox, ledgerPath, add };
}

const liveDelta = (text: string) => ({
  refs: [
    {
      connector: 'chat',
      channelName: 'client room',
      author: 'sender',
      contentPreview: text,
      observationRef: `obs-${text}`,
      sourceAt: new Date().toISOString(),
    },
  ],
});

describe('owner exchanges by span', () => {
  it("reads the owner's messages in a span with their replies, oldest first", async () => {
    const f = await fixture();
    f.add('telegram:owner:100', 'owner_message', { text: 'before the span' }, 'early');
    f.add('telegram:owner:200', 'owner_message', { text: 'decide the page rule' }, 'noted');
    f.add('telegram:owner:250', 'owner_message', { text: 'still running' }, '', {
      finished: false,
    });
    f.add('record:batch:1', 'scheduled', { order: 'record' }, '[ack]');
    f.add('telegram:owner:300', 'owner_message', { text: 'after the span' }, 'late');
    f.add('telegram:other:220', 'owner_message', { text: 'another principal' }, 'x', {
      principalId: 'someone-else',
    });
    expect(ownerExchangesBetween(f.mailbox, f.database.adapter, 'owner', 150, 300)).toEqual([
      { at: 200, owner: 'decide the page rule', reply: 'noted' },
      { at: 250, owner: 'still running', reply: null },
    ]);
  });
});

describe('session start context', () => {
  it('gathers the last delivered owner exchanges, the checkpoint and the latest decisions', async () => {
    const f = await fixture();
    f.add('owner:1', 'owner_message', { text: 'request 1' }, '<b>answer 1</b>');
    f.add('owner:2', 'owner_message', { text: 'request 2' }, 'answer 2', { delivered: 'ready' });
    f.add('owner:3', 'owner_message', { text: 'request 3' }, 'answer 3', {
      principalId: 'someone-else',
    });
    f.add('delta:4', 'source_delta', liveDelta('files sent'), '[ack]');
    f.add(
      'replay:5',
      'source_delta',
      // A replay window carries message text in its refs too; it is still not a live change.
      { ...liveDelta('replayed history'), replay: { windowStartMs: 1, windowEndMs: 2 } },
      'window done'
    );
    f.add('record:6', 'scheduled', { order: 'record' }, '[ack]');
    f.add('delta:7', 'source_delta', liveDelta('pending'), '[notify] x', { finished: false });
    const current = f.add('owner:8', 'owner_message', { text: 'now' }, 'answer 8');
    const records = [
      { topic: 'older', summary: 'old decision', created_at: 1_000 },
      { topic: 'newer', summary: 'new decision', created_at: 3_600_000 * 2 },
    ] as unknown as MemoryRecord[];
    const input = await readSessionStartInput({
      mailbox: f.mailbox,
      deliveredRefs: new TelegramMessageLedger(f.ledgerPath).recentDeliveredMessageRefs(),
      current,
      records: async () => records,
      checkpoint: async () => ({
        summary: 'Mid full report',
        nextSteps: 'publish the board',
        createdAt: 3_600_000,
      }),
      now: 3_600_000 * 3,
    });
    // Only delivered owner exchanges of this principal, the current one left out, oldest first;
    // messenger markup is stripped and source changes, record orders and replays are not carried.
    expect(input.exchanges).toEqual([{ at: 1, owner: 'request 1', answer: 'answer 1' }]);
    expect(input.checkpoint).toEqual({
      summary: 'Mid full report',
      nextSteps: 'publish the board',
      ageHours: 2,
    });
    expect(input.decisions).toEqual([
      { topic: 'newer', summary: 'new decision', ageHours: 1 },
      { topic: 'older', summary: 'old decision', ageHours: (3_600_000 * 3 - 1_000) / 3_600_000 },
    ]);
  });
});
