import { homedir } from 'node:os';

import {
  createAdapter,
  createPrincipalRepository,
  type PrincipalRepository,
} from '@jungjaehoon/mama-core';

import { loadConfig } from '../../runtime/config.js';
import { CliInputError } from '../prompt.js';
import { OWNER_PRINCIPAL_ID } from './daemon.js';

type OwnerResult = ReturnType<PrincipalRepository['ensureOwner']>;

/** Register against the daemon's existing schema, without starting its runtime or collectors. */
export async function runRegisterOwner(
  args: readonly string[] = [],
  options: { home?: string; configPath?: string } = {}
): Promise<OwnerResult> {
  if (args.length !== 0) throw new CliInputError('Usage: mama register-owner');
  const home = options.home ?? homedir();
  const config = loadConfig({ home, ...(options.configPath ? { path: options.configPath } : {}) });
  // The ids the gateway admits as the owner, including the one config derives from a single
  // allowed chat. Several ids would be several senders, not one identity.
  if (config.telegram.owner_user_ids.length !== 1) {
    throw new CliInputError('telegram.owner_user_ids must contain exactly one user id');
  }
  const adapter = createAdapter({ dbPath: config.database.path });
  let receipt: { result: OwnerResult; principals: number; identities: number };
  try {
    adapter.connect();
    receipt = adapter.transaction(() => {
      const result = createPrincipalRepository(adapter).ensureOwner({
        principalId: OWNER_PRINCIPAL_ID,
        connector: 'telegram',
        namespace: 'private',
        externalId: config.telegram.owner_user_ids[0]!,
        now: Date.now(),
      });
      const principals = adapter.prepare('SELECT COUNT(*) AS count FROM principals').get() as {
        count: number;
      };
      const identities = adapter
        .prepare('SELECT COUNT(*) AS count FROM external_identities')
        .get() as { count: number };
      return { result, principals: principals.count, identities: identities.count };
    });
  } finally {
    adapter.disconnect();
  }
  console.log(
    `${receipt.result} principals=${receipt.principals} identities=${receipt.identities}`
  );
  return receipt.result;
}
