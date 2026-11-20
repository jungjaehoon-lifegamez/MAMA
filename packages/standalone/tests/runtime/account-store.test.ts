import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createAccountStore, personalAccountsDir } from '../../src/runtime/account-store.js';
import { credentialReadPaths } from '../../src/runtime/backend-security.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function store() {
  const root = mkdtempSync(join(tmpdir(), 'mama-accounts-'));
  roots.push(root);
  return { root, accounts: createAccountStore(personalAccountsDir(root)) };
}

const account = { token: 'fixture-token-a', accountId: '7', name: 'account-a' };

describe('personal account store (approvals.md, P1)', () => {
  it('keeps each person’s accounts apart, readable only by this user', () => {
    const { root, accounts } = store();
    accounts.set('person-a', 'chatwork', account);
    expect(accounts.get('person-a', 'chatwork')).toMatchObject(account);
    expect(accounts.get('person-b', 'chatwork')).toBeNull();
    expect(accounts.get('person-a', 'slack')).toBeNull();
    const dir = personalAccountsDir(root);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const [file] = readdirSync(dir);
    expect(statSync(join(dir, file!)).mode & 0o777).toBe(0o600);
    // The file is named by a hash: a principal id never becomes a path.
    expect(file).toMatch(/^[0-9a-f]{64}\.json$/);
  });

  it('lists accounts without their tokens', () => {
    const { accounts } = store();
    accounts.set('person-a', 'chatwork', account);
    accounts.set('person-a', 'slack', { token: 'xoxp-fixture', accountId: 'U1', name: 'person-a' });
    const listed = accounts.list('person-a');
    expect(listed.map(({ service }) => service)).toEqual(['chatwork', 'slack']);
    expect(JSON.stringify(listed)).not.toContain('fixture-token-a');
    expect(JSON.stringify(listed)).not.toContain('xoxp-fixture');
  });

  it('removes one account, then every account of a person', () => {
    const { root, accounts } = store();
    accounts.set('person-a', 'chatwork', account);
    accounts.set('person-a', 'slack', { token: 'xoxp-fixture', accountId: 'U1', name: 'p' });
    expect(accounts.remove('person-a', 'chatwork')).toBe(true);
    expect(accounts.remove('person-a', 'chatwork')).toBe(false);
    expect(accounts.get('person-a', 'chatwork')).toBeNull();
    accounts.removeAll('person-a');
    expect(accounts.list('person-a')).toEqual([]);
    expect(readdirSync(personalAccountsDir(root))).toEqual([]);
  });

  it('reads the file at each use: a removal holds without a restart', () => {
    const { root, accounts } = store();
    accounts.set('person-a', 'chatwork', account);
    const other = createAccountStore(personalAccountsDir(root));
    other.remove('person-a', 'chatwork');
    expect(accounts.get('person-a', 'chatwork')).toBeNull();
  });

  it('lives under runtime/, which both backends deny', () => {
    const { root } = store();
    const dir = personalAccountsDir(root);
    expect(dir.startsWith(join(root, 'runtime'))).toBe(true);
    expect(credentialReadPaths(root).some((denied) => dir.startsWith(denied))).toBe(true);
  });

  it('lists no secret of a multi-field kind (#590 review)', () => {
    const { accounts } = store();
    accounts.set('person-a', 'trello', {
      token: 'fixture-trello-token',
      fields: { key: 'fixture-trello-key' },
      accountId: 'm1',
      name: 'a',
    });
    const listed = JSON.stringify(accounts.list('person-a'));
    expect(listed).not.toContain('fixture-trello-key');
    expect(listed).not.toContain('fixture-trello-token');
    expect(listed).not.toContain('fields');
  });
});
