/**
 * Each person's own send accounts (approvals.md, P1): a Chatwork token, a Slack user token. A
 * person's approved write posts with the account that person connected, never the install's
 * (auth.env) and never another person's. The store lives under runtime/, which every backend's
 * native reads deny with the other credentials, and it is read at each use, so a removal holds
 * without a restart. Tokens never enter the environment: native children would inherit them.
 * Not in backups: a restored install reconnects its people's accounts.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PERSONAL_ACCOUNT_SERVICES = ['chatwork', 'slack'] as const;
export type AccountService = (typeof PERSONAL_ACCOUNT_SERVICES)[number];

export interface StoredAccount {
  token: string;
  /** The service's own id for the account (Chatwork account_id, Slack user id). */
  accountId: string;
  name: string;
  connectedAt?: number;
}

export type AccountSummary = Omit<StoredAccount, 'token'> & { service: AccountService };

export function personalAccountsDir(mamaRoot: string): string {
  return join(mamaRoot, 'runtime', 'accounts');
}

export interface AccountStore {
  get(principalId: string, service: AccountService): StoredAccount | null;
  set(principalId: string, service: AccountService, account: StoredAccount): void;
  remove(principalId: string, service: AccountService): boolean;
  list(principalId: string): AccountSummary[];
  removeAll(principalId: string): void;
}

export function createAccountStore(dir: string): AccountStore {
  const file = (principalId: string) =>
    join(dir, `${createHash('sha256').update(principalId).digest('hex')}.json`);
  const read = (principalId: string): Partial<Record<AccountService, StoredAccount>> => {
    const path = file(principalId);
    return existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8')) as Partial<Record<AccountService, StoredAccount>>)
      : {};
  };
  const write = (principalId: string, accounts: Partial<Record<AccountService, StoredAccount>>) => {
    const path = file(principalId);
    if (Object.keys(accounts).length === 0) {
      rmSync(path, { force: true });
      return;
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const staged = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(staged, `${JSON.stringify(accounts)}\n`, { mode: 0o600 });
    renameSync(staged, path);
  };
  return {
    get: (principalId, service) => read(principalId)[service] ?? null,
    set(principalId, service, account) {
      write(principalId, {
        ...read(principalId),
        [service]: { ...account, connectedAt: account.connectedAt ?? Date.now() },
      });
    },
    remove(principalId, service) {
      const accounts = read(principalId);
      if (accounts[service] === undefined) return false;
      delete accounts[service];
      write(principalId, accounts);
      return true;
    },
    list(principalId) {
      const accounts = read(principalId);
      return PERSONAL_ACCOUNT_SERVICES.flatMap((service) => {
        const stored = accounts[service];
        if (!stored) return [];
        const { token: _token, ...summary } = stored;
        return [{ service, ...summary }];
      });
    },
    removeAll(principalId) {
      rmSync(file(principalId), { force: true });
    },
  };
}
