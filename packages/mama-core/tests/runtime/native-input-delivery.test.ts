import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeSQLiteAdapter } from '../../src/db-adapter/node-sqlite-adapter.js';
import type { DatabaseAdapter } from '../../src/db-manager.js';
import { createCatalog } from '../../src/api/catalog.js';
import { createDispatcher } from '../../src/api/dispatch.js';
import { beginModelRun, listModelRunNativeInputs } from '../../src/runtime/model-run-store.js';
import { Mailbox } from '../../src/runtime/mailbox.js';
import { NativeInputJournal } from '../../src/runtime/native-input-journal.js';
import { NativeSteeringTargetUnavailableError } from '../../src/runtime/drivers/types.js';
import {
  startRuntime,
  type StimulusDelivery,
  type NativeSessionHandle,
} from '../../src/runtime/runtime.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function boot(
  delivery: StimulusDelivery,
  directory?: string,
  nativeSession?: NativeSessionHandle
) {
  const dir = directory ?? fs.mkdtempSync(join(os.tmpdir(), 'native-delivery-'));
  if (!directory) cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new NodeSQLiteAdapter({ dbPath: join(dir, 'core.db') }) as unknown as DatabaseAdapter;
  db.connect();
  db.runMigrations(join(__dirname, '../../db/migrations'));
  const catalog = createCatalog([]);
  const runtime = await startRuntime({
    paths: { socketPath: join(dir, 'runtime.sock') },
    catalog,
    dispatch: createDispatcher(catalog),
    principals: [
      {
        access: { principalId: 'owner', agentId: 'agent', scopes: [], actions: [] },
        credentialPath: join(dir, 'credential'),
      },
    ],
    mailbox: { adapter: db },
    nativeSession,
    delivery: { ...delivery, intervalMs: 0 },
  });
  const close = async () => {
    await runtime.stop();
    db.disconnect();
  };
  cleanup.push(close);
  const read = () => runtime.mailbox!.readInput('input-1', 'owner');
  const accept = () =>
    runtime.accept({
      id: 'input-1',
      kind: 'owner_message',
      principalId: 'owner',
      channelKey: 'channel',
      occurredAt: Date.now(),
      payload: { text: 'request' },
    });
  return { runtime, db, dir, close, accept, read };
}

describe('v7 R2: native acceptance is durable and separate from adapter completion', () => {
  it('keeps a native-accepted input claimed until delivery settles', () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'native-accepted-claim-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const db = new NodeSQLiteAdapter({
      dbPath: join(dir, 'core.db'),
    }) as unknown as DatabaseAdapter;
    db.connect();
    try {
      db.runMigrations(join(__dirname, '../../db/migrations'));
      const mailbox = new Mailbox(db);
      const id = mailbox.enqueue({
        id: 'input-accepted',
        kind: 'owner_message',
        principalId: 'owner',
        channelKey: 'channel',
        occurredAt: Date.now(),
      })!;
      expect(mailbox.claimNext()?.id).toBe(id);
      const prepared = mailbox.nativeInputs.prepare(id);
      mailbox.nativeInputs.dispatch(id, {
        backend: 'codex',
        sessionId: 'thread',
        inputId: prepared.invocationId!,
      });
      mailbox.nativeInputs.accept(id, {
        backend: 'codex',
        sessionId: 'thread',
        turnId: 'turn',
      });

      expect(mailbox.readInput('input-accepted', 'owner')?.status).toBe('claimed');
      mailbox.nativeInputs.settle(id);
      expect(mailbox.readInput('input-accepted', 'owner')?.status).toBe('acked');
    } finally {
      db.disconnect();
    }
  });

  it('does not demote an acknowledged settled input to uncertain after a late error', () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'native-settled-monotonic-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const db = new NodeSQLiteAdapter({
      dbPath: join(dir, 'core.db'),
    }) as unknown as DatabaseAdapter;
    db.connect();
    try {
      db.runMigrations(join(__dirname, '../../db/migrations'));
      const mailbox = new Mailbox(db);
      const id = mailbox.enqueue({
        id: 'scheduled-once',
        kind: 'scheduled',
        principalId: 'owner',
        channelKey: 'operator:scheduled',
        occurredAt: Date.now(),
      })!;
      const prepared = mailbox.nativeInputs.prepare(id);
      mailbox.nativeInputs.dispatch(id, {
        backend: 'codex',
        sessionId: 'thread',
        inputId: prepared.invocationId!,
      });
      mailbox.nativeInputs.accept(id, {
        backend: 'codex',
        sessionId: 'thread',
        turnId: 'turn',
      });
      mailbox.nativeInputs.settle(id);
      mailbox.nativeInputs.uncertain(id, 'late observer failure');
      expect(mailbox.nativeInputs.get(id)).toMatchObject({ state: 'settled', error: null });
      expect(mailbox.readInput('scheduled-once', 'owner')?.status).toBe('acked');
    } finally {
      db.disconnect();
    }
  });

  it('keeps a background reply origin after its mailbox row is pruned', () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'native-primary-kind-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'core.db');
    const db = new NodeSQLiteAdapter({ dbPath: path }) as unknown as DatabaseAdapter;
    db.connect();
    db.runMigrations(join(__dirname, '../../db/migrations'));
    const mailbox = new Mailbox(db);
    const id = mailbox.enqueue({
      id: 'delta-1',
      kind: 'source_delta',
      principalId: 'owner',
      channelKey: 'slack:channel',
      occurredAt: Date.now(),
    })!;
    const prepared = mailbox.nativeInputs.prepare(id);
    const receipt = { backend: 'codex' as const, sessionId: 'thread', turnId: 'turn' };
    mailbox.nativeInputs.dispatch(id, {
      backend: 'codex',
      sessionId: 'thread',
      inputId: prepared.invocationId!,
    });
    mailbox.nativeInputs.accept(id, receipt);
    mailbox.nativeInputs.storeResult(id, {
      response: 'response after owner correction',
      turns: 1,
      history: [],
      totalUsage: { input_tokens: 2, output_tokens: 2 },
      stopReason: 'end_turn',
      modelRunId: null,
      modelRunProvenance: 'backend_no_run',
    });
    db.prepare('DELETE FROM mailbox_inputs WHERE id=?').run(id);
    db.disconnect();

    const reopened = new NodeSQLiteAdapter({ dbPath: path }) as unknown as DatabaseAdapter;
    reopened.connect();
    try {
      reopened.runMigrations(join(__dirname, '../../db/migrations'));
      expect(new NativeInputJournal(reopened).resultForReceipt(receipt, 'owner')).toMatchObject({
        primaryStimulusId: 'delta-1',
        primaryKind: 'source_delta',
        response: 'response after owner correction',
      });
    } finally {
      reopened.disconnect();
    }
  });

  it('keeps a child completion accepted during native stop for the next runtime', async () => {
    const deliveredBeforeRestart = vi.fn(async () => {});
    const first = await boot({ deliver: deliveredBeforeRestart }, undefined, {
      stop: async () => {
        first.runtime.accept({
          id: 'subagent:child-on-stop',
          kind: 'native_event',
          principalId: 'owner',
          channelKey: 'subagent',
          occurredAt: Date.now(),
          payload: { schema: 'native-event-v1', content: 'child was interrupted' },
        });
      },
    });

    await first.runtime.stop();
    expect(first.runtime.mailbox!.readInput('subagent:child-on-stop', 'owner')?.status).toBe(
      'pending'
    );
    expect(deliveredBeforeRestart).not.toHaveBeenCalled();

    const deliveredAfterRestart = vi.fn(async (_row, context) => {
      context.onInputDispatch({
        backend: 'codex',
        sessionId: 'owner-thread',
        inputId: context.nativeInputId,
      });
      context.onAccepted({ backend: 'codex', sessionId: 'owner-thread', turnId: 'turn-next' });
    });
    const second = await boot({ deliver: deliveredAfterRestart }, first.dir);
    await second.runtime.drainOnce();
    expect(deliveredAfterRestart).toHaveBeenCalledTimes(1);
    expect(
      second.runtime.mailbox!.readInput('subagent:child-on-stop', 'owner')?.nativeDelivery
    ).toMatchObject({ state: 'settled' });
  });

  it('waits for an active durable-result reconciliation before closing the runtime', async () => {
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let reading = false;
    const h = await boot({
      deliver: async () => {
        throw new Error('Must not replay the accepted input');
      },
      reconcile: async () => {
        reading = true;
        await held;
        return 'settled';
      },
    });
    h.accept();
    const row = h.runtime.mailbox!.claimNext()!;
    const input = h.runtime.mailbox!.nativeInputs.prepare(row.id);
    h.runtime.mailbox!.nativeInputs.dispatch(row.id, {
      backend: 'codex',
      sessionId: 'thread',
      inputId: input.invocationId!,
    });
    h.runtime.mailbox!.nativeInputs.accept(row.id, {
      backend: 'codex',
      sessionId: 'thread',
      turnId: 'turn',
    });
    const drain = h.runtime.drainOnce();
    let stopped = false;
    let stopping: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(reading).toBe(true));
      stopping = h.runtime.stop().then(() => {
        stopped = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(stopped).toBe(false);
    } finally {
      finish();
      await drain;
      await stopping;
    }
    expect(h.read()?.nativeDelivery?.state).toBe('settled');
  });

  it('admits the next input after native ACK while the first result is still running', async () => {
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const accepted: string[] = [];
    const reconcile = vi.fn(async () => 'settled' as const);
    const h = await boot({
      maxPerTick: 1,
      reconcile,
      deliver: async (row, context) => {
        context.onInputDispatch({
          backend: 'codex',
          sessionId: 'thread',
          inputId: context.nativeInputId,
        });
        context.onAccepted({ backend: 'codex', sessionId: 'thread', turnId: row.stimulusId });
        accepted.push(row.stimulusId);
        if (row.stimulusId === 'input-1') await held;
      },
    });
    h.accept();
    const firstDrain = h.runtime.drainOnce();
    try {
      await vi.waitFor(() => expect(accepted).toEqual(['input-1']));
      h.runtime.accept({
        id: 'input-2',
        kind: 'owner_message',
        principalId: 'owner',
        channelKey: 'channel',
        occurredAt: Date.now(),
        payload: { text: 'correction while running' },
      });
      await vi.waitFor(() => expect(accepted).toEqual(['input-1', 'input-2']));
      expect(h.read()?.nativeDelivery?.state).toBe('accepted');
      expect(reconcile).not.toHaveBeenCalled();
    } finally {
      finish();
      await firstDrain;
    }
    expect(h.read()?.nativeDelivery?.state).toBe('settled');
  });

  it('claims up to maxPendingInputs for each principal while another waits for native ACK', async () => {
    // This test exercises the claim window, not socket binding. Keep the runtime and mailbox real.
    const listener = vi
      .spyOn(await import('../../src/client/ipc.js'), 'createActionIpcServer')
      .mockResolvedValue({ close: async () => {} } as never);
    cleanup.push(() => {
      listener.mockRestore();
    });
    let finish!: () => void;
    const held = new Promise<void>((resolve) => (finish = resolve));
    const started: string[] = [];
    const h = await boot({
      maxPendingInputs: 2,
      maxPerTick: 2,
      deliver: async (row, context) => {
        started.push(row.stimulusId);
        await held;
        context.onInputDispatch({
          backend: 'codex',
          sessionId: row.principalId,
          inputId: context.nativeInputId,
        });
        context.onAccepted({
          backend: 'codex',
          sessionId: row.principalId,
          turnId: row.stimulusId,
        });
      },
    });
    h.runtime.servePrincipal({
      access: { principalId: 'other', agentId: 'other-agent', scopes: [], actions: [] },
      credentialPath: join(h.dir, 'other-credential'),
    });
    try {
      for (const principalId of ['owner', 'other'])
        for (let n = 1; n <= 3; n++)
          h.runtime.accept({
            id: `${principalId}-${n}`,
            kind: 'owner_message',
            principalId,
            channelKey: 'fixture',
            occurredAt: n,
            payload: { text: 'fixture input' },
          });
      await vi.waitFor(() => expect(started).toHaveLength(4));
      expect(started).toEqual(['owner-1', 'owner-2', 'other-1', 'other-2']);
      for (const principalId of ['owner', 'other']) {
        expect(h.runtime.mailbox!.readInput(`${principalId}-2`, principalId)?.status).toBe(
          'claimed'
        );
        expect(h.runtime.mailbox!.readInput(`${principalId}-3`, principalId)?.status).toBe(
          'pending'
        );
      }
      finish();
      await vi.waitFor(() => expect(started).toHaveLength(6));
      for (const principalId of ['owner', 'other'])
        await vi.waitFor(() =>
          expect(h.runtime.mailbox!.readInput(`${principalId}-3`, principalId)?.status).toBe(
            'acked'
          )
        );
    } finally {
      finish();
    }
  });

  it('defers and recovers an unserved principal host job without native delivery or a retry attempt', async () => {
    const listener = vi
      .spyOn(await import('../../src/client/ipc.js'), 'createActionIpcServer')
      .mockResolvedValue({ close: async () => {} } as never);
    cleanup.push(() => listener.mockRestore());
    let ready = false;
    let jobs = 0;
    const h = await boot({
      ready: () => false,
      hostReady: () => true,
      deliver: async () => {
        throw new Error('Host job reached native delivery');
      },
      deliverHost: async () => {
        if (!ready) return 'deferred';
        jobs++;
        return 'handled';
      },
    });
    const id = h.runtime.mailbox!.enqueue({
      id: 'host-1',
      kind: 'host_job',
      principalId: 'unserved',
      channelKey: 'host',
      occurredAt: 1,
    })!;
    await h.runtime.drainOnce();
    expect(h.runtime.mailbox!.readInput('host-1', 'unserved')).toMatchObject({
      status: 'pending',
      attempts: 0,
    });
    ready = true;
    await h.runtime.drainOnce();
    expect(h.runtime.mailbox!.readInput('host-1', 'unserved')).toMatchObject({
      status: 'acked',
      attempts: 0,
    });
    expect(h.runtime.mailbox!.nativeInputs.get(id)).toBeNull();
    expect(jobs).toBe(1);
  });

  it('journals a second input steered into the same native turn under its own mailbox row', async () => {
    let finishFirst!: () => void;
    const firstResult = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const receipt = { backend: 'codex' as const, sessionId: 'owner-thread', turnId: 'turn-1' };
    const runTurn = vi.fn(async (_content, request) => {
      request!.streamCallbacks!.onInputDispatch!({
        backend: 'codex',
        sessionId: receipt.sessionId,
        inputId: request!.nativeInputId!,
      });
      request!.streamCallbacks!.onAccepted!(receipt);
      await firstResult;
      return {
        response: 'one answer after correction',
        turns: 1,
        history: [],
        totalUsage: { input_tokens: 1, output_tokens: 1 },
        stopReason: 'end_turn' as const,
        modelRunId: null,
        modelRunProvenance: 'backend_no_run' as const,
      };
    });
    const steer = vi.fn(
      async (
        _text: string,
        target: typeof receipt,
        sessionKey: string,
        beforeSend?: () => void
      ) => {
        expect(target).toEqual(receipt);
        expect(sessionKey).toBe('owner:runtime');
        beforeSend?.();
        return receipt;
      }
    );
    const h = await boot(
      {
        maxPerTick: 1,
        deliver: async (row, context) => {
          if (row.stimulusId === 'input-1') {
            await context.run([{ type: 'text', text: 'first request' }], {
              sessionKey: 'owner:runtime',
            });
          } else {
            await context.steer('correction', receipt, 'owner:runtime');
          }
        },
      },
      undefined,
      { runTurn, steer, stop: async () => {} }
    );
    h.accept();
    const firstDrain = h.runtime.drainOnce();
    try {
      await vi.waitFor(() => expect(h.read()?.nativeDelivery?.state).toBe('accepted'));
      h.runtime.accept({
        id: 'input-2',
        kind: 'owner_message',
        principalId: 'owner',
        channelKey: 'channel',
        occurredAt: Date.now(),
        payload: { text: 'correction' },
      });
      await vi.waitFor(() =>
        expect(h.runtime.mailbox!.readInput('input-2', 'owner')?.nativeDelivery?.state).toBe(
          'settled'
        )
      );
      const first = h.read()!.nativeDelivery!;
      const second = h.runtime.mailbox!.readInput('input-2', 'owner')!.nativeDelivery!;
      expect(first.receipt).toEqual(receipt);
      expect(second.receipt).toEqual(receipt);
      expect(second.dispatch?.inputId).not.toBe(first.dispatch?.inputId);
      expect(runTurn).toHaveBeenCalledTimes(1);
      expect(steer).toHaveBeenCalledTimes(1);
      const firstPage = h.runtime.mailbox!.nativeInputs.listByReceipt(receipt, 'owner', {
        limit: 1,
      });
      expect(firstPage).toEqual({ inputIds: [h.read()!.id], nextCursor: h.read()!.id });
      expect(
        h.runtime.mailbox!.nativeInputs.listByReceipt(receipt, 'owner', {
          afterId: firstPage.nextCursor!,
          limit: 1,
        })
      ).toEqual({
        inputIds: [h.runtime.mailbox!.readInput('input-2', 'owner')!.id],
        nextCursor: null,
      });
      expect(h.runtime.mailbox!.nativeInputs.listByReceipt(receipt, 'other').inputIds).toEqual([]);
      const group = h.runtime.mailbox!.readNativeTurnInputs('input-1', 'owner', { limit: 1 });
      expect(group.items.map((item) => item.stimulusId)).toEqual(['input-1']);
      expect(group.nextCursor).toBe(h.read()!.id);
      expect(
        h.runtime
          .mailbox!.readNativeTurnInputs('input-1', 'owner', {
            afterId: group.nextCursor!,
            limit: 1,
          })
          .items.map((item) => item.stimulusId)
      ).toEqual(['input-2']);
      expect(() => h.runtime.mailbox!.readNativeTurnInputs('input-1', 'other')).toThrow(
        'not visible'
      );
      const run = beginModelRun(h.db, {
        model_run_id: 'mr_native_cohort',
        model_provider: 'codex',
        agent_id: 'agent',
        input_refs: { sourceMessageRef: 'input-1', principalId: 'owner' },
      });
      const runPage = listModelRunNativeInputs(h.db, run.model_run_id, 'owner', { limit: 1 });
      expect(runPage.items.map((item) => item.stimulusId)).toEqual(['input-1']);
      expect(
        listModelRunNativeInputs(h.db, run.model_run_id, 'owner', {
          afterId: runPage.nextCursor!,
          limit: 1,
        }).items.map((item) => item.stimulusId)
      ).toEqual(['input-2']);
      const byNativeInput = beginModelRun(h.db, {
        model_run_id: 'mr_native_occurrence_cohort',
        model_provider: 'codex',
        agent_id: 'mama-owner',
        input_refs: {
          principalId: 'owner',
          nativeInputId: first.dispatch!.inputId,
          sourceMessageRef: 'effect-occurrence-not-a-mailbox-stimulus',
        },
      });
      expect(
        listModelRunNativeInputs(h.db, byNativeInput.model_run_id, 'owner').items.map(
          (item) => item.stimulusId
        )
      ).toEqual(['input-1', 'input-2']);
      const wrongNativeInput = beginModelRun(h.db, {
        model_run_id: 'mr_wrong_native_identity',
        model_provider: 'codex',
        agent_id: 'mama-owner',
        input_refs: {
          principalId: 'owner',
          nativeInputId: 'not-an-accepted-native-input',
          sourceMessageRef: 'input-1',
        },
      });
      expect(() => listModelRunNativeInputs(h.db, wrongNativeInput.model_run_id, 'owner')).toThrow(
        'accepted native turn receipt'
      );
      expect(() => listModelRunNativeInputs(h.db, run.model_run_id, 'other')).toThrow('principal');
      const historical = beginModelRun(h.db, {
        model_run_id: 'mr_unbound_historical',
        input_refs: { sourceMessageRef: 'input-1' },
      });
      expect(() => listModelRunNativeInputs(h.db, historical.model_run_id, 'owner')).toThrow(
        'principal-bound'
      );
    } finally {
      finishFirst();
      await firstDrain;
    }
    expect(h.runtime.mailbox!.nativeInputs.resultForReceipt(receipt, 'owner')).toMatchObject({
      primaryStimulusId: 'input-1',
      primaryKind: 'owner_message',
      response: 'one answer after correction',
      modelRunId: null,
      modelRunProvenance: 'backend_no_run',
    });
    expect(h.runtime.mailbox!.nativeInputs.resultForReceipt(receipt, 'other')).toBeNull();
    const reopened = new NodeSQLiteAdapter({
      dbPath: join(h.dir, 'core.db'),
    }) as unknown as DatabaseAdapter;
    reopened.connect();
    try {
      reopened.runMigrations(join(__dirname, '../../db/migrations'));
      expect(new NativeInputJournal(reopened).resultForReceipt(receipt, 'owner')).toMatchObject({
        response: 'one answer after correction',
      });
    } finally {
      reopened.disconnect();
    }
    expect(() =>
      h.runtime.mailbox!.nativeInputs.storeResult(h.read()!.id, {
        response: 'different answer for the same native turn',
        turns: 1,
        history: [],
        totalUsage: { input_tokens: 1, output_tokens: 1 },
        stopReason: 'end_turn',
        modelRunId: null,
        modelRunProvenance: 'backend_no_run',
      })
    ).toThrow('conflicts');
    h.db.prepare('DELETE FROM mailbox_inputs WHERE id=?').run(h.read()!.id);
    expect(h.runtime.mailbox!.nativeInputs.resultForReceipt(receipt, 'owner')?.response).toBe(
      'one answer after correction'
    );
  });

  it('refuses an unaccepted steering target before native dispatch', async () => {
    const steer = vi.fn(async () => {
      throw new Error('Steering requires the matching active turn');
    });
    const h = await boot(
      {
        deliver: async (_row, context) => {
          await context.steer(
            'correction',
            { backend: 'codex', sessionId: 'owner-thread', turnId: 'stale-turn' },
            'owner:runtime'
          );
        },
      },
      undefined,
      { steer, stop: async () => {} }
    );
    h.accept();
    const result = await h.runtime.drainOnce();

    expect(result.failed).toBe(1);
    expect(steer).not.toHaveBeenCalled();
    expect(h.read()?.status).toBe('pending');
    expect(h.read()?.nativeDelivery?.state).toBe('prepared');
  });

  it('can start one fresh turn after a stale steer is rejected before dispatch', async () => {
    const target = { backend: 'codex' as const, sessionId: 'owner-thread', turnId: 'old-turn' };
    const steer = vi.fn(async () => {
      throw new NativeSteeringTargetUnavailableError();
    });
    const runTurn = vi.fn(async (_content, request) => {
      request!.streamCallbacks!.onInputDispatch!({
        backend: 'codex',
        sessionId: 'new-thread',
        inputId: request!.nativeInputId!,
      });
      request!.streamCallbacks!.onAccepted!({
        backend: 'codex',
        sessionId: 'new-thread',
        turnId: 'new-turn',
      });
      return {
        response: 'fresh answer',
        turns: 1,
        history: [],
        totalUsage: { input_tokens: 1, output_tokens: 1 },
        stopReason: 'end_turn' as const,
        modelRunId: null,
        modelRunProvenance: 'backend_no_run' as const,
      };
    });
    const h = await boot(
      {
        deliver: async (_row, context) => {
          await expect(context.steer('correction', target, 'owner:runtime')).rejects.toBeInstanceOf(
            NativeSteeringTargetUnavailableError
          );
          expect(context.wasDispatched()).toBe(false);
          await context.run([{ type: 'text', text: 'correction' }]);
        },
      },
      undefined,
      { steer, runTurn, stop: async () => {} }
    );
    const anchorId = h.runtime.mailbox!.enqueue({
      id: 'anchor',
      kind: 'owner_message',
      principalId: 'owner',
      channelKey: 'channel',
      occurredAt: Date.now(),
      payload: { text: 'earlier input' },
    });
    expect(anchorId).not.toBeNull();
    const anchor = h.runtime.mailbox!.claimNext()!;
    const prepared = h.runtime.mailbox!.nativeInputs.prepare(anchor.id);
    h.runtime.mailbox!.nativeInputs.dispatch(anchor.id, {
      backend: 'codex',
      sessionId: target.sessionId,
      inputId: prepared.invocationId!,
    });
    h.runtime.mailbox!.nativeInputs.accept(anchor.id, target);

    h.accept();
    expect(await h.runtime.drainOnce()).toMatchObject({ delivered: 1, failed: 0 });
    expect(steer).toHaveBeenCalledOnce();
    expect(runTurn).toHaveBeenCalledOnce();
    expect(h.read()?.nativeDelivery?.state).toBe('settled');
    expect(h.read()?.status).toBe('acked');
  });

  it("does not steer an owner input into another principal's accepted turn", async () => {
    const steer = vi.fn(async () => ({
      backend: 'codex' as const,
      sessionId: 'shared-thread',
      turnId: 'foreign-turn',
    }));
    const h = await boot(
      {
        deliver: async (_row, context) => {
          await context.steer(
            'owner correction',
            { backend: 'codex', sessionId: 'shared-thread', turnId: 'foreign-turn' },
            'owner:runtime'
          );
        },
      },
      undefined,
      { steer, stop: async () => {} }
    );
    h.runtime.mailbox!.enqueue({
      id: 'foreign-input',
      kind: 'owner_message',
      principalId: 'other',
      channelKey: 'channel',
      occurredAt: Date.now(),
      payload: { text: 'foreign request' },
    });
    const foreign = h.runtime.mailbox!.claimNext()!;
    const prepared = h.runtime.mailbox!.nativeInputs.prepare(foreign.id);
    h.runtime.mailbox!.nativeInputs.dispatch(foreign.id, {
      backend: 'codex',
      sessionId: 'shared-thread',
      inputId: prepared.invocationId!,
    });
    h.runtime.mailbox!.nativeInputs.accept(foreign.id, {
      backend: 'codex',
      sessionId: 'shared-thread',
      turnId: 'foreign-turn',
    });

    h.accept();
    const result = await h.runtime.drainOnce();
    expect(result.failed).toBe(1);
    expect(steer).not.toHaveBeenCalled();
    expect(h.read()?.nativeDelivery?.state).toBe('prepared');
  });

  it('does not replay a steer whose native acknowledgement was lost after dispatch', async () => {
    const steer = vi.fn(async (_text, _target, _sessionKey, beforeSend?: () => void) => {
      beforeSend?.();
      throw new Error('steer transport lost');
    });
    const deliver = vi.fn(async (_row, context) => {
      await context.steer(
        'correction',
        { backend: 'codex', sessionId: 'owner-thread', turnId: 'turn-1' },
        'owner:runtime'
      );
    });
    const h = await boot({ deliver }, undefined, { steer, stop: async () => {} });
    const anchorId = h.runtime.mailbox!.enqueue({
      id: 'anchor',
      kind: 'owner_message',
      principalId: 'owner',
      channelKey: 'channel',
      occurredAt: Date.now(),
      payload: { text: 'active owner request' },
    });
    expect(anchorId).not.toBeNull();
    const anchor = h.runtime.mailbox!.claimNext()!;
    const prepared = h.runtime.mailbox!.nativeInputs.prepare(anchor.id);
    h.runtime.mailbox!.nativeInputs.dispatch(anchor.id, {
      backend: 'codex',
      sessionId: 'owner-thread',
      inputId: prepared.invocationId!,
    });
    h.runtime.mailbox!.nativeInputs.accept(anchor.id, {
      backend: 'codex',
      sessionId: 'owner-thread',
      turnId: 'turn-1',
    });
    h.accept();
    await h.runtime.drainOnce();
    h.db.prepare('UPDATE mailbox_inputs SET claimed_at = 0, retry_after = 0').run();
    h.runtime.mailbox!.replayStale(0);
    await h.runtime.drainOnce();

    expect(steer).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(h.read()).toMatchObject({ nativeDelivery: { state: 'uncertain', receipt: null } });
  });

  it('does not reclaim a live pre-dispatch admission when its lease expires', async () => {
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const deliver = vi.fn(async () => {
      await held;
    });
    const h = await boot({ leaseMs: 1, maxPerTick: 1, deliver });
    h.accept();
    const firstDrain = h.runtime.drainOnce();
    try {
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
      h.db.prepare('UPDATE mailbox_inputs SET claimed_at=0 WHERE id=?').run(h.read()!.id);
      h.runtime.accept({
        id: 'input-2',
        kind: 'scheduled',
        principalId: 'owner',
        channelKey: 'channel',
        occurredAt: Date.now(),
        payload: { text: 'waiting for admission' },
      });
      const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
      try {
        await h.runtime.drainOnce();
        expect(deliver).toHaveBeenCalledOnce();
        expect(h.read()?.attempts).toBe(0);
        expect(h.read()?.status).toBe('claimed');
        expect(h.runtime.mailbox!.readInput('input-2', 'owner')?.status).toBe('pending');
        expect(
          (
            h.db.prepare('SELECT claimed_at FROM mailbox_inputs WHERE id=?').get(h.read()!.id) as {
              claimed_at: number;
            }
          ).claimed_at
        ).toBeGreaterThan(0);
      } finally {
        now.mockRestore();
      }
    } finally {
      finish();
      await firstDrain;
    }
  });

  it('keeps the result writer alive through shutdown and leaves later intake durable', async () => {
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let accepted = false;
    const h = await boot({
      deliver: async (_row, context) => {
        context.onInputDispatch({
          backend: 'codex',
          sessionId: 'thread',
          inputId: context.nativeInputId,
        });
        context.onAccepted({ backend: 'codex', sessionId: 'thread', turnId: 'turn' });
        accepted = true;
        await held;
      },
    });
    h.accept();
    const drain = h.runtime.drainOnce();
    let stopped = false;
    let stopping: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(accepted).toBe(true));
      stopping = h.runtime.stop().then(() => {
        stopped = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(stopped).toBe(false);
      expect(h.read()?.nativeDelivery?.state).toBe('accepted');
      h.runtime.accept({
        id: 'input-after-stop',
        kind: 'owner_message',
        principalId: 'owner',
        channelKey: 'channel',
        occurredAt: Date.now(),
        payload: { text: 'kept for the next boot' },
      });
      expect(h.runtime.mailbox!.readInput('input-after-stop', 'owner')?.status).toBe('pending');
    } finally {
      finish();
      await drain;
      await stopping;
    }
    expect(h.read()?.nativeDelivery?.state).toBe('settled');
  });

  it('executes only a currently claimed input through the runtime-owned native session', async () => {
    let calls = 0;
    let invokedId = '';
    let returned = false;
    const native: NativeSessionHandle = {
      stop: async () => {},
      runTurn: async (_content, request) => {
        calls++;
        invokedId = request!.nativeInputId!;
        request!.streamCallbacks!.onInputDispatch!({
          backend: 'codex',
          sessionId: 'thread',
          inputId: invokedId,
        });
        request!.streamCallbacks!.onAccepted!({
          backend: 'codex',
          sessionId: 'thread',
          turnId: 'turn',
        });
        return {
          response: 'native answer',
          turns: 1,
          history: [],
          totalUsage: { input_tokens: 1, output_tokens: 1 },
          stopReason: 'end_turn',
          modelRunId: null,
          modelRunProvenance: 'backend_no_run',
        };
      },
    };
    const h = await boot(
      {
        deliver: async (_row, context) => {
          expect(context.wasDispatched()).toBe(false);
          const response = await h.runtime.runNative(
            context.nativeInputId,
            [{ type: 'text', text: 'request' }],
            {
              nativeInputId: 'caller-cannot-replace-it',
              streamCallbacks: { onAccepted: () => expect(h.read()?.status).toBe('claimed') },
            }
          );
          expect(response.response).toBe('native answer');
          expect(context.wasDispatched()).toBe(true);
          await expect(context.run([{ type: 'text', text: 'second' }])).rejects.toThrow(
            /already invoked/
          );
          returned = true;
        },
      },
      undefined,
      native
    );
    expect(h.runtime.nativeSession).not.toHaveProperty('runTurn');
    await expect(
      h.runtime.runNative('unclaimed', [{ type: 'text', text: 'bypass' }])
    ).rejects.toThrow(/active input/);
    h.accept();
    await h.runtime.drainOnce();
    expect(returned).toBe(true);
    expect(calls).toBe(1);
    expect(invokedId).not.toBe('caller-cannot-replace-it');
    expect(h.read()?.nativeDelivery?.invocationId).toBe(invokedId);
    await expect(h.runtime.runNative(invokedId, [{ type: 'text', text: 'stale' }])).rejects.toThrow(
      /active input/
    );
  });

  it('owns an invoked native run even if the adapter returns before awaiting it', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    let drained = false;
    const h = await boot(
      {
        deliver: async (_row, context) => {
          void context.run([{ type: 'text', text: 'request' }]);
        },
      },
      undefined,
      {
        stop: async () => {},
        runTurn: async (_content, request) => {
          request!.streamCallbacks!.onInputDispatch!({
            backend: 'codex',
            sessionId: 'thread',
            inputId: request!.nativeInputId!,
          });
          request!.streamCallbacks!.onAccepted!({
            backend: 'codex',
            sessionId: 'thread',
            turnId: 'turn',
          });
          started = true;
          await held;
          return {
            response: 'done',
            turns: 1,
            history: [],
            totalUsage: { input_tokens: 1, output_tokens: 1 },
            stopReason: 'end_turn',
            modelRunId: null,
            modelRunProvenance: 'backend_no_run',
          };
        },
      }
    );
    h.accept();
    const draining = h.runtime.drainOnce().then(() => {
      drained = true;
    });
    try {
      await vi.waitFor(() => expect(started).toBe(true));
      expect(drained).toBe(false);
      expect(h.read()?.nativeDelivery?.state).toBe('accepted');
    } finally {
      release();
      await draining;
    }
    expect(h.read()?.nativeDelivery?.state).toBe('settled');
  });

  it('keeps a native receipt claimed before the result or reply is ready', async () => {
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let started = false;
    const h = await boot({
      deliver: async (_row, context) => {
        context?.onInputDispatch({
          backend: 'claude',
          sessionId: 'session',
          inputId: context.nativeInputId,
        });
        context?.onAccepted({
          backend: 'claude',
          sessionId: 'session',
          inputId: context.nativeInputId,
        });
        started = true;
        await held;
      },
    });
    h.accept();
    const drain = h.runtime.drainOnce();
    try {
      await vi.waitFor(() => expect(started).toBe(true));
      expect(h.read()).toMatchObject({
        status: 'claimed',
        nativeDelivery: { state: 'accepted', receipt: { backend: 'claude', sessionId: 'session' } },
      });
    } finally {
      finish();
      await drain;
    }
    expect(h.read()).toMatchObject({ nativeDelivery: { state: 'settled' } });
  });

  it('reopens an accepted input and reconciles its result without another model dispatch', async () => {
    const first = await boot({
      deliver: async (_row, context) => {
        context?.onInputDispatch({
          backend: 'codex',
          sessionId: 'thread',
          inputId: context.nativeInputId,
        });
        context?.onAccepted({ backend: 'codex', sessionId: 'thread', turnId: 'turn' });
        throw new Error('reply preparation interrupted');
      },
    });
    first.accept();
    await first.runtime.drainOnce();
    const before = first.read();
    await first.close();
    let dispatched = 0;
    let reconciled = 0;
    const second = await boot(
      {
        deliver: async () => {
          dispatched++;
        },
        reconcile: async (row) => {
          expect(row.nativeDelivery?.receipt).toEqual({
            backend: 'codex',
            sessionId: 'thread',
            turnId: 'turn',
          });
          reconciled++;
          return 'settled';
        },
      },
      first.dir
    );
    await second.runtime.drainOnce();
    expect(before).toMatchObject({ status: 'claimed', nativeDelivery: { state: 'uncertain' } });
    expect(dispatched).toBe(0);
    expect(reconciled).toBe(1);
    expect(second.read()).toMatchObject({ nativeDelivery: { state: 'settled' } });
  });

  it('does not replay a dispatch whose native acknowledgement was lost', async () => {
    let calls = 0;
    const h = await boot({
      deliver: async (_row, context) => {
        calls++;
        context?.onInputDispatch({
          backend: 'claude',
          sessionId: 'session',
          inputId: context.nativeInputId,
        });
        throw new Error('transport lost before acknowledgement');
      },
    });
    h.accept();
    await h.runtime.drainOnce();
    h.db.prepare('UPDATE mailbox_inputs SET claimed_at = 0, retry_after = 0').run();
    h.runtime.mailbox!.replayStale(0);
    await h.runtime.drainOnce();
    expect(calls).toBe(1);
    expect(h.read()).toMatchObject({ nativeDelivery: { state: 'uncertain', receipt: null } });
  });

  it('keeps an unresolved accepted input beyond ordinary ACK retention', async () => {
    const h = await boot({
      deliver: async (_row, context) => {
        context?.onInputDispatch({
          backend: 'codex',
          sessionId: 'thread',
          inputId: context.nativeInputId,
        });
        context?.onAccepted({ backend: 'codex', sessionId: 'thread', turnId: 'turn' });
        throw new Error('result unavailable');
      },
    });
    h.accept();
    await h.runtime.drainOnce();
    h.db.prepare('UPDATE mailbox_inputs SET acked_at = 0').run();
    h.db.prepare('UPDATE mailbox_seen SET seen_at = 0').run();
    h.runtime.mailbox!.replayStale(0);
    expect(h.read()).not.toBeNull();
    expect(h.accept().state).toBe('duplicate');
  });
  it('retains the first receipt and rejects a different session or second dispatch', async () => {
    const h = await boot({ deliver: async () => {} });
    h.accept();
    const row = h.runtime.mailbox!.claimNext()!;
    const journal = h.runtime.mailbox!.nativeInputs;
    const record = journal.prepare(row.id);
    const dispatch = {
      backend: 'claude',
      sessionId: 'session',
      inputId: record.invocationId!,
    } as const;
    journal.dispatch(row.id, dispatch);
    expect(() => journal.dispatch(row.id, dispatch)).toThrow(/already dispatched/);
    expect(() => journal.accept(row.id, { ...dispatch, sessionId: 'foreign' })).toThrow(
      /does not match/
    );
    expect(h.read()?.status).toBe('claimed');
    journal.accept(row.id, dispatch);
    expect(() => journal.accept(row.id, { ...dispatch, inputId: 'foreign' })).toThrow(
      /does not match/
    );
    expect(h.read()?.nativeDelivery?.receipt).toEqual(dispatch);
    h.db
      .prepare('UPDATE native_input_deliveries SET receipt_json=? WHERE input_id=?')
      .run(JSON.stringify({ ...dispatch, sessionId: 'corrupt' }), row.id);
    expect(() => h.read()).toThrow(/corrupt/i);
    h.db
      .prepare("UPDATE native_input_deliveries SET receipt_json='false' WHERE input_id=?")
      .run(row.id);
    expect(() => h.read()).toThrow(/corrupt/i);
  });

  it('migrates old claims as unknown, without fabricating a native identity or replaying them', async () => {
    const h = await boot({ deliver: async () => {} });
    h.accept();
    h.runtime.mailbox!.claimNext();
    h.db.exec('DROP TABLE native_input_deliveries');
    h.db.exec(
      fs.readFileSync(join(__dirname, '../../db/migrations/088-native-input-journal.sql'), 'utf8')
    );
    const mailbox = new Mailbox(h.db);
    mailbox.replayStale(0);
    expect(mailbox.claimNext()).toBeNull();
    expect(mailbox.readInput('input-1', 'owner')?.nativeDelivery).toMatchObject({
      state: 'uncertain',
      invocationId: null,
      dispatch: null,
      receipt: null,
    });
  });

  it('retries a definite failure before native dispatch using the same durable identity', async () => {
    const identities: string[] = [];
    const h = await boot({
      deliver: async (_row, context) => {
        identities.push(context.nativeInputId);
        if (identities.length === 1) throw new Error('workspace not ready before dispatch');
        context.onInputDispatch({
          backend: 'codex',
          sessionId: 'thread',
          inputId: context.nativeInputId,
        });
        context.onAccepted({ backend: 'codex', sessionId: 'thread', turnId: 'turn' });
      },
    });
    h.accept();
    await h.runtime.drainOnce();
    expect(h.read()?.nativeDelivery?.state).toBe('prepared');
    h.db.prepare('UPDATE mailbox_inputs SET retry_after=0').run();
    await h.runtime.drainOnce();
    expect(identities).toHaveLength(2);
    expect(identities[1]).toBe(identities[0]);
    expect(h.read()?.nativeDelivery?.state).toBe('settled');
  });
});
