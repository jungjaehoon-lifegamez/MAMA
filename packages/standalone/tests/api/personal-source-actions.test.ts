import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCatalog, createDispatcher, type ActionContext } from '@jungjaehoon/mama-core';

import { personalSourceActionRegistrations } from '../../src/api/personal-source-actions.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { createAccountStore, type AccountStore } from '../../src/runtime/account-store.js';
import {
  createPersonalSourceStore,
  type PersonalSourceStore,
} from '../../src/runtime/personal-source-store.js';

let root: string;
let database: Awaited<ReturnType<typeof openCoreDatabase>>;
let store: PersonalSourceStore;
let accounts: AccountStore;
const ask = vi.fn();
const start = vi.fn();
const stop = vi.fn();
const deleteData = vi.fn();
const channels = vi.fn();

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mama-personal-actions-'));
  database = await openCoreDatabase({ path: join(root, 'state.db') });
  store = createPersonalSourceStore(database.adapter);
  accounts = createAccountStore(join(root, 'accounts'));
  for (const fn of [ask, start, stop, deleteData, channels]) fn.mockReset();
  ask.mockResolvedValue({ expiresAt: Date.UTC(2026, 10, 20, 13) });
  channels.mockResolvedValue([
    { id: '111', name: 'room-one' },
    { id: '222', name: 'room-two' },
  ]);
});
afterEach(async () => {
  await database.close();
  rmSync(root, { recursive: true, force: true });
});

function call(action: string, input: Record<string, unknown>, principalId = 'person-a') {
  const access: ActionContext['access'] = {
    principalId,
    agentId: 'agent',
    scopes: [],
    actions: [
      'source.connect',
      'source.channels',
      'source.bind',
      'source.disconnect',
      'source.list',
    ],
  };
  return createDispatcher(
    createCatalog(
      personalSourceActionRegistrations({
        ownerPrincipalId: 'owner',
        store,
        accounts,
        channels: (kind, secrets) => channels(kind, secrets),
        ask,
        sources: () => ({ start, stop }),
        deleteData,
      })
    )
  )({ action, input }, { access });
}

describe('personal source actions (personal-connectors.md, C2)', () => {
  it("asks in the person's DM and never takes a secret as input", async () => {
    expect(await call('source.connect', { connector: 'chatwork' })).toMatchObject({
      status: 'completed',
      data: { asked: true },
    });
    expect(ask).toHaveBeenCalledWith('person-a', 'chatwork');
    expect(await call('source.connect', { connector: 'chatwork', token: 'x' })).toMatchObject({
      status: 'failed',
    });
    expect(await call('source.connect', { connector: 'gmail' })).toMatchObject({
      status: 'failed',
    });
  });

  it('lists the channels the stored credential reads, and refuses without one', async () => {
    expect((await call('source.channels', { connector: 'chatwork' })).error?.message).toMatch(
      /not connected.*source.connect chatwork/
    );
    accounts.set('person-a', 'chatwork', { token: 'p-token', accountId: '7', name: 'a' });
    expect(await call('source.channels', { connector: 'chatwork' })).toMatchObject({
      data: {
        channels: [
          { id: '111', name: 'room-one' },
          { id: '222', name: 'room-two' },
        ],
      },
    });
    expect(channels).toHaveBeenCalledWith('chatwork', { token: 'p-token' });
  });

  it('binds only channels the credential lists, starts collecting and says to agree a cadence', async () => {
    accounts.set('person-a', 'chatwork', { token: 'p-token', accountId: '7', name: 'a' });
    expect(
      (await call('source.bind', { connector: 'chatwork', channels: ['111', '999'] })).error
        ?.message
    ).toMatch(/999/);
    expect(start).not.toHaveBeenCalled();
    const bound = await call('source.bind', { connector: 'chatwork', channels: ['111'] });
    expect(bound).toMatchObject({
      status: 'completed',
      data: {
        bound: [{ id: '111', name: 'room-one' }],
        next: expect.stringMatching(/how often.*personal job/),
      },
    });
    expect(store.get('person-a', 'chatwork')!.channels).toEqual([{ id: '111', name: 'room-one' }]);
    expect(start).toHaveBeenCalledWith('person-a', 'chatwork', { fromStart: false });
  });

  it('lists and disconnects only the caller’s sources, deleting what was collected', async () => {
    store.bind('person-a', 'chatwork', [{ id: '111', name: 'room-one' }]);
    store.bind('person-b', 'chatwork', [{ id: '111', name: 'room-one' }]);
    expect(await call('source.list', {})).toMatchObject({
      data: { sources: [{ connector: 'chatwork', channels: [{ id: '111', name: 'room-one' }] }] },
    });
    expect(await call('source.disconnect', { connector: 'chatwork' })).toMatchObject({
      data: { disconnected: true },
    });
    expect(stop).toHaveBeenCalledWith('person-a', 'chatwork');
    expect(deleteData).toHaveBeenCalledWith('person-a', 'chatwork');
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(deleteData.mock.invocationCallOrder[0]!);
    expect(store.get('person-a', 'chatwork')).toBeNull();
    expect(store.get('person-b', 'chatwork')).not.toBeNull();
  });

  it('is refused in the common session, whose sources are the install’s', async () => {
    for (const action of [
      'source.connect',
      'source.channels',
      'source.bind',
      'source.disconnect',
    ]) {
      const input =
        action === 'source.bind'
          ? { connector: 'chatwork', channels: ['111'] }
          : { connector: 'chatwork' };
      const result = await call(action, input, 'owner');
      expect(result.error?.message).toMatch(/install’s sources/);
    }
    expect(ask).not.toHaveBeenCalled();
  });

  it('keeps channels already bound when the service no longer lists them, and reads added ones from the start (#590 review)', async () => {
    accounts.set('person-a', 'telegram', { token: 'bot', accountId: 'B', name: 'b' });
    store.bind('person-a', 'telegram', [{ id: '-100', name: 'group' }]);
    // A bot lists only chats with pending updates; the bound group's were already read.
    channels.mockResolvedValue([{ id: '-200', name: 'other' }]);
    const bound = await call('source.bind', { connector: 'telegram', channels: ['-100', '-200'] });
    expect(bound).toMatchObject({ status: 'completed' });
    expect(store.get('person-a', 'telegram')!.channels.map((c) => c.id)).toEqual(['-100', '-200']);
    expect(start).toHaveBeenLastCalledWith('person-a', 'telegram', { fromStart: true });
    // Rebinding the same channels keeps the cursor.
    await call('source.bind', { connector: 'telegram', channels: ['-100', '-200'] });
    expect(start).toHaveBeenLastCalledWith('person-a', 'telegram', { fromStart: false });
  });
});
