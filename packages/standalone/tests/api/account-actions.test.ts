import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCatalog, createDispatcher, type ActionContext } from '@jungjaehoon/mama-core';

import { accountActionRegistrations } from '../../src/api/account-actions.js';
import { createAccountStore, type AccountStore } from '../../src/runtime/account-store.js';

let root: string;
let accounts: AccountStore;
const ask = vi.fn();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mama-account-actions-'));
  accounts = createAccountStore(root);
  ask.mockReset();
  ask.mockResolvedValue({ expiresAt: Date.UTC(2026, 10, 17, 13, 0) });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function call(action: string, input: Record<string, unknown>, principalId = 'person-a') {
  const access: ActionContext['access'] = {
    principalId,
    agentId: 'agent',
    scopes: [],
    actions: ['account.connect', 'account.disconnect', 'account.list'],
  };
  return createDispatcher(
    createCatalog(accountActionRegistrations({ ownerPrincipalId: 'owner', accounts, ask }))
  )({ action, input }, { access });
}

describe('account.connect, account.disconnect, account.list (approvals.md, P1, P2)', () => {
  it('asks in the person’s own DM and never takes a token as input', async () => {
    const result = await call('account.connect', { service: 'chatwork' });
    expect(ask).toHaveBeenCalledWith('person-a', 'chatwork');
    expect(result).toMatchObject({ status: 'completed', data: { asked: true } });
    const withToken = await call('account.connect', { service: 'chatwork', token: 'x' });
    expect(withToken).toMatchObject({ status: 'failed' });
  });

  it('is refused in the common session, whose accounts are the install’s', async () => {
    const result = await call('account.connect', { service: 'slack' }, 'owner');
    expect(result.error?.message).toMatch(/install’s accounts.*mama secret set/);
    expect(ask).not.toHaveBeenCalled();
  });

  it('lists the person’s accounts without tokens, and removes one', async () => {
    accounts.set('person-a', 'chatwork', { token: 'fixture-token', accountId: '8', name: 'a' });
    const listed = await call('account.list', {});
    expect(listed).toMatchObject({
      data: { accounts: [{ service: 'chatwork', accountId: '8', name: 'a' }] },
    });
    expect(JSON.stringify(listed)).not.toContain('fixture-token');
    expect(await call('account.disconnect', { service: 'chatwork' })).toMatchObject({
      data: { removed: true },
    });
    expect(accounts.get('person-a', 'chatwork')).toBeNull();
    expect(await call('account.list', {}, 'person-b')).toMatchObject({ data: { accounts: [] } });
  });
});
