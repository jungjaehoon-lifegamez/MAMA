import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { NodeSQLiteAdapter } from '../../src/db-adapter/node-sqlite-adapter.js';
import type { DatabaseAdapter } from '../../src/db-manager.js';
import { createCatalog } from '../../src/api/catalog.js';
import { createDispatcher } from '../../src/api/dispatch.js';
import { startRuntime, type StimulusDelivery } from '../../src/runtime/runtime.js';

vi.mock('../../src/client/ipc.js', () => ({
  createActionIpcServer: async () => ({ close: async () => {} }),
}));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0)) await stop();
  vi.restoreAllMocks();
});

it.each(['delivered', 'reconciled'] as const)(
  'announces each %s input once after ack',
  async (path) => {
    const root = fs.mkdtempSync(join(tmpdir(), 'settled-hook-'));
    const db = new NodeSQLiteAdapter({ dbPath: join(root, 'db') }) as unknown as DatabaseAdapter;
    db.connect();
    db.runMigrations(join(__dirname, '../../db/migrations'));
    const catalog = createCatalog([]);
    const seen: number[] = [];
    const delivery: StimulusDelivery = {
      intervalMs: 0,
      deliver: async (_row, context) => {
        context.onInputDispatch({
          backend: 'codex',
          sessionId: 'fixture-session',
          inputId: context.nativeInputId,
        });
        context.onAccepted({
          backend: 'codex',
          sessionId: 'fixture-session',
          turnId: 'fixture-turn',
        });
      },
      reconcile: async () => 'settled',
      onSettled: (row) => {
        expect(runtime.mailbox!.inputStatus(row.id)).toBe('acked');
        seen.push(row.id);
      },
    };
    const runtime = await startRuntime({
      paths: { socketPath: join(root, 'socket') },
      catalog,
      dispatch: createDispatcher(catalog),
      principals: [
        {
          access: { principalId: 'owner', agentId: 'fixture-agent', scopes: [], actions: [] },
          credentialPath: join(root, 'credential'),
        },
      ],
      mailbox: { adapter: db },
      delivery,
    });
    cleanup.push(async () => {
      await runtime.stop();
      db.disconnect();
      fs.rmSync(root, { recursive: true, force: true });
    });
    runtime.accept({
      id: 'fixture-input',
      principalId: 'owner',
      kind: 'owner_message',
      channelKey: 'fixture',
      occurredAt: Date.now(),
    });
    if (path === 'reconciled') {
      const row = runtime.mailbox!.claimNext()!;
      const input = runtime.mailbox!.nativeInputs.prepare(row.id);
      runtime.mailbox!.nativeInputs.dispatch(row.id, {
        backend: 'codex',
        sessionId: 'fixture-session',
        inputId: input.invocationId!,
      });
      runtime.mailbox!.nativeInputs.accept(row.id, {
        backend: 'codex',
        sessionId: 'fixture-session',
        turnId: 'fixture-turn',
      });
    }
    await runtime.drainOnce();
    expect(seen).toHaveLength(1);
    await runtime.drainOnce();
    expect(seen).toHaveLength(1);
    const loud = vi.spyOn(console, 'error').mockImplementation(() => {});
    delivery.onSettled = () => {
      throw new Error('fixture hook failure');
    };
    runtime.accept({
      id: 'fixture-throw',
      principalId: 'owner',
      kind: 'owner_message',
      channelKey: 'fixture',
      occurredAt: Date.now(),
    });
    expect(await runtime.drainOnce()).toMatchObject({ delivered: 1, failed: 0 });
    expect(runtime.mailbox!.readInput('fixture-throw', 'owner')?.status).toBe('acked');
    expect(loud).toHaveBeenCalledWith(expect.stringContaining('onSettled'), expect.anything());
  }
);

it('does not invoke a native turn or reject the drain when a cancelled waiting row is erased', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'erased-waiter-'));
  const db = new NodeSQLiteAdapter({ dbPath: join(root, 'db') }) as unknown as DatabaseAdapter;
  db.connect();
  db.runMigrations(join(__dirname, '../../db/migrations'));
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let waiting = false;
  const turn = vi.fn(async () => ({ response: 'fixture' }));
  const catalog = createCatalog([]);
  const runtime = await startRuntime({
    paths: { socketPath: join(root, 'socket') },
    catalog,
    dispatch: createDispatcher(catalog),
    principals: [
      {
        access: { principalId: 'owner', agentId: 'fixture-agent', scopes: [], actions: [] },
        credentialPath: join(root, 'credential'),
      },
    ],
    mailbox: { adapter: db },
    nativeSession: { runTurn: turn, stop: async () => {} },
    delivery: {
      intervalMs: 0,
      deliver: async (_row, context) => {
        waiting = true;
        await wait;
        await context.run([{ type: 'text', text: 'fixture' }]);
      },
    },
  });
  cleanup.push(async () => {
    release();
    await runtime.stop();
    db.disconnect();
    fs.rmSync(root, { recursive: true, force: true });
  });
  runtime.accept({
    id: 'fixture-waiter',
    principalId: 'owner',
    kind: 'owner_message',
    channelKey: 'fixture',
    occurredAt: Date.now(),
  });
  const waitingInputId = runtime.mailbox!.readInput('fixture-waiter', 'owner')!.id;
  const logged = vi.spyOn(console, 'info').mockImplementation(() => {});
  const drain = runtime.drainOnce();
  await vi.waitFor(() => expect(waiting).toBe(true));
  runtime.mailbox!.cancelQueued('owner', 'fixture_cancel');
  db.prepare('DELETE FROM native_input_deliveries').run();
  db.prepare('DELETE FROM mailbox_inputs').run();
  release();
  await expect(drain).resolves.toEqual({ delivered: 0, failed: 0, dead: 0 });
  expect(turn).not.toHaveBeenCalled();
  expect(logged).toHaveBeenCalledTimes(1);
  expect(logged).toHaveBeenCalledWith(expect.stringContaining(`input=${waitingInputId}`));
  expect(logged.mock.calls[0][0]).toContain('deleted');
  expect(runtime.mailbox!.readInput('fixture-waiter', 'owner')).toBeNull();
});

it('keeps queued inputs when readiness closes during an asynchronous reconcile', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'ready-reconcile-'));
  const db = new NodeSQLiteAdapter({ dbPath: join(root, 'db') }) as unknown as DatabaseAdapter;
  db.connect();
  db.runMigrations(join(__dirname, '../../db/migrations'));
  let resume!: () => void,
    reconciling = false,
    ready = true;
  const gate = new Promise<void>((r) => {
    resume = r;
  });
  const delivered = vi.fn(async (_row, context) => {
    context.onInputDispatch({
      backend: 'codex',
      sessionId: 'fixture-session',
      inputId: context.nativeInputId,
    });
    context.onAccepted({
      backend: 'codex',
      sessionId: 'fixture-session',
      turnId: 'fixture-turn-next',
    });
  });
  const catalog = createCatalog([]);
  const runtime = await startRuntime({
    paths: { socketPath: join(root, 'socket') },
    catalog,
    dispatch: createDispatcher(catalog),
    principals: [
      {
        access: { principalId: 'owner', agentId: 'fixture-agent', scopes: [], actions: [] },
        credentialPath: join(root, 'credential'),
      },
    ],
    mailbox: { adapter: db },
    delivery: {
      intervalMs: 0,
      ready: () => ready,
      deliver: delivered,
      reconcile: async () => {
        reconciling = true;
        await gate;
        return 'settled';
      },
    },
  });
  cleanup.push(async () => {
    resume();
    await runtime.stop();
    db.disconnect();
    fs.rmSync(root, { recursive: true, force: true });
  });
  runtime.accept({
    id: 'fixture-accepted',
    principalId: 'owner',
    kind: 'owner_message',
    channelKey: 'fixture',
    occurredAt: Date.now(),
  });
  const row = runtime.mailbox!.claimNext()!,
    prepared = runtime.mailbox!.nativeInputs.prepare(row.id);
  runtime.mailbox!.nativeInputs.dispatch(row.id, {
    backend: 'codex',
    sessionId: 'fixture-session',
    inputId: prepared.invocationId!,
  });
  runtime.mailbox!.nativeInputs.accept(row.id, {
    backend: 'codex',
    sessionId: 'fixture-session',
    turnId: 'fixture-turn',
  });
  const drain = runtime.drainOnce();
  await vi.waitFor(() => expect(reconciling).toBe(true));
  ready = false;
  runtime.accept({
    id: 'fixture-queued',
    principalId: 'owner',
    kind: 'owner_message',
    channelKey: 'fixture',
    occurredAt: Date.now(),
  });
  resume();
  await drain;
  expect(runtime.mailbox!.readInput('fixture-queued', 'owner')?.status).toBe('pending');
  expect(delivered).not.toHaveBeenCalled();
});
