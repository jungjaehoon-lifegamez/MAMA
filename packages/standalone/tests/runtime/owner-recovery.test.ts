import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { createOwnerRuntime, type OwnerRuntime } from '../../src/runtime/owner-runtime.js';
import type { NativeTurnResult } from '@jungjaehoon/mama-core/runtime/native-turn';
import type { NativeSessionHandle } from '@jungjaehoon/mama-core/runtime/runtime';
import type { MailboxRow } from '@jungjaehoon/mama-core/runtime/mailbox';
import { createStimulusDelivery } from '../../src/runtime/stimulus-delivery.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';

vi.mock('@jungjaehoon/mama-core', async (original) => ({
  ...(await original<typeof import('@jungjaehoon/mama-core')>()),
  readMemoryRecordsInScopes: async () => [],
}));
const ipc = createRequire(import.meta.url)('@jungjaehoon/mama-core/client/ipc');
const roots: string[] = [];
const owners: OwnerRuntime[] = [];
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.stop();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const result: NativeTurnResult = {
  response: 'Stored answer',
  turns: 1,
  history: [],
  totalUsage: { input_tokens: 0, output_tokens: 0 },
  stopReason: 'end_turn',
  modelRunId: 'fixture-run',
  modelRunProvenance: 'available',
};

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'owner-recovery-'));
  roots.push(root);
  vi.spyOn(ipc, 'createActionIpcServer').mockResolvedValue({ close: async () => {} });
  let ready = false;
  const delivered: string[] = [];
  const failures: string[] = [];
  const uncertain: string[] = [];
  const runTurn = vi.fn<NonNullable<NativeSessionHandle['runTurn']>>(async (_content, request) => {
    const nativeInputId = request?.nativeInputId;
    if (!nativeInputId) throw new Error('test run is missing its native input id');
    request?.streamCallbacks?.onInputDispatch?.({
      backend: 'codex',
      sessionId: 'fixture-session',
      inputId: nativeInputId,
    });
    request?.streamCallbacks?.onAccepted?.({
      backend: 'codex',
      sessionId: 'fixture-session',
      turnId: `turn-${nativeInputId}`,
    });
    return result;
  });
  const options = {
    backend: 'codex' as const,
    model: 'fixture-model',
    rawPath: join(root, 'raw'),
    databasePath: join(root, 'state.db'),
    socketPath: join(root, 'runtime.sock'),
    credentialPath: join(root, 'credential'),
    runtimeRoot: root,
    timeZone: createTimeZoneSetting('UTC'),
    workspaceDir: join(root, 'workspace'),
    ownerPrincipalId: 'owner',
    agentId: 'agent',
    scopes: [],
    timeout: 1000,
    maxTurns: 10,
    nativeSession: { stop: async () => {}, runTurn },
    deliveryReady: () => ready,
    onOwnerResult: async (_row: MailboxRow, answer: NativeTurnResult) => {
      delivered.push(answer.response);
    },
    onSourceResult: async (_row: MailboxRow, answer: NativeTurnResult) => {
      delivered.push(answer.response);
    },
    onStimulusFailed: async (_row: MailboxRow, reason: string) => {
      failures.push(reason);
    },
    onStimulusUncertain: async (row: MailboxRow, reason: string) => {
      uncertain.push(`${row.kind}:${reason}`);
    },
  };
  let owner = await createOwnerRuntime(options);
  owners.push(owner);
  // Turns other than the record orders a delta leaves behind.
  const inputTurns = () =>
    runTurn.mock.calls.filter(
      ([content]) => !(content[0]?.type === 'text' && content[0].text?.includes('[delta_record]'))
    ).length;
  return {
    inputTurns,
    get owner() {
      return owner;
    },
    delivered,
    failures,
    uncertain,
    runTurn,
    restart: async () => {
      await owner.stop();
      owner = await createOwnerRuntime(options);
      owners.push(owner);
      ready = true;
      await owner.runtime.drainOnce();
    },
  };
}

const deltaPayload = () => ({
  refs: [
    {
      connector: 'fixture',
      observationRef: 'obs-1',
      contentPreview: 'the files arrived',
      sourceAt: new Date().toISOString(),
    },
  ],
});

describe('owner input recovery', () => {
  it.each(['source_delta'] as const)(
    'redelivers a claimed %s with no native dispatch after restart',
    async (kind) => {
      const ctx = await setup();
      ctx.owner.intake.accept({
        id: 'input',
        kind,
        principalId: 'owner',
        channelKey: 'fixture',
        occurredAt: 1,
        payload: deltaPayload(),
      });
      expect(ctx.owner.runtime.mailbox!.claimNext()).toMatchObject({
        stimulusId: 'input',
        status: 'claimed',
      });
      expect(ctx.runTurn).not.toHaveBeenCalled();

      await ctx.restart();

      expect(ctx.inputTurns()).toBe(1);
      expect(ctx.delivered).toEqual(['Stored answer']);
      // The record order is durable before the notify reply is routed.
      expect(ctx.owner.runtime.mailbox!.readInput('record:input:1', 'owner')).toMatchObject({
        kind: 'scheduled',
        channelKey: 'operator:record',
      });
      expect(ctx.owner.runtime.mailbox!.readInput('input', 'owner')).toMatchObject({
        status: 'acked',
        nativeDelivery: { state: 'settled' },
      });
    }
  );

  it.each(['owner_message', 'source_delta'] as const)(
    'delivers the stored %s result after restart without rerunning the model',
    async (kind) => {
      const ctx = await setup();
      ctx.owner.intake.accept({
        id: 'input',
        kind,
        principalId: 'owner',
        channelKey: 'fixture',
        occurredAt: 1,
        payload: kind === 'source_delta' ? deltaPayload() : { text: 'request' },
      });
      const mailbox = ctx.owner.runtime.mailbox!;
      const row = mailbox.claimNext()!;
      const native = mailbox.nativeInputs.prepare(row.id);
      mailbox.nativeInputs.dispatch(row.id, {
        backend: 'codex',
        sessionId: 'fixture-session',
        inputId: native.invocationId!,
      });
      mailbox.nativeInputs.accept(row.id, {
        backend: 'codex',
        sessionId: 'fixture-session',
        turnId: 'fixture-turn',
      });
      mailbox.nativeInputs.storeResult(row.id, result);
      mailbox.nativeInputs.uncertain(row.id, 'delivery interrupted');
      await ctx.restart();
      expect(ctx.delivered).toEqual(['Stored answer']);
      expect(ctx.owner.runtime.mailbox!.readInput('input', 'owner')?.nativeDelivery?.state).toBe(
        'settled'
      );
      expect(ctx.inputTurns()).toBe(0);
    }
  );

  it.each(['owner_message', 'source_delta'] as const)(
    'parks and logs an orphaned %s with no result',
    async (kind) => {
      const ctx = await setup();
      ctx.owner.intake.accept({
        id: 'input',
        kind,
        principalId: 'owner',
        channelKey: 'fixture',
        occurredAt: 1,
      });
      const mailbox = ctx.owner.runtime.mailbox!;
      const row = mailbox.claimNext()!;
      const native = mailbox.nativeInputs.prepare(row.id);
      mailbox.nativeInputs.dispatch(row.id, {
        backend: 'codex',
        sessionId: 'fixture-session',
        inputId: native.invocationId!,
      });
      await ctx.restart();
      expect(ctx.owner.runtime.mailbox!.readInput('input', 'owner')?.nativeDelivery?.state).toBe(
        'uncertain'
      );
      expect(ctx.owner.intake.isPending!('input')).toBe(false);
      expect(ctx.failures).toHaveLength(1);
      expect(ctx.uncertain).toHaveLength(1);
      expect(ctx.runTurn).not.toHaveBeenCalled();
    }
  );
});

describe('row-owned replay ceiling', () => {
  it('takes each ceiling from its durable payload when an owner input runs first', async () => {
    const delivery = createStimulusDelivery({
      backend: 'codex',
      timeZone: createTimeZoneSetting('UTC'),
    });
    const seen: Array<number | undefined> = [];
    const base = {
      id: 1,
      stimulusId: 'input',
      principalId: 'owner',
      channelKey: 'fixture',
      occurredAt: 1,
      refs: [],
      preview: [],
      status: 'claimed' as const,
      attempts: 1,
      createdAt: 1,
      coalesceKey: null,
    };
    const context = {
      run: async (_content: unknown, request: { replaySourceEndMs?: number }) => {
        seen.push(request.replaySourceEndMs);
        expect(delivery.getReplaySourceEndMs()).toBe(request.replaySourceEndMs);
        return result;
      },
    };
    await delivery.deliver(
      { ...base, kind: 'owner_message', payload: { text: 'owner first' } },
      context as never
    );
    await delivery.deliver(
      {
        ...base,
        kind: 'source_delta',
        payload: { replay: { windowStartMs: 1000, windowEndMs: 1501 } },
      },
      context as never
    );
    await delivery.deliver(
      {
        ...base,
        kind: 'source_delta',
        payload: { replay: { windowStartMs: 1501, windowEndMs: 2001 } },
      },
      context as never
    );
    expect(seen).toEqual([undefined, 1500, 2000]);
    expect(delivery.getReplaySourceEndMs()).toBeUndefined();
  });
});
