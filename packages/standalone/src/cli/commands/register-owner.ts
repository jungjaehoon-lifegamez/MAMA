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

/** Rolls back every binding when one owner id belongs to someone else. */
class OwnerConflict extends Error {}

/** Register against the daemon's existing schema, without starting its runtime or collectors. */
export async function runRegisterOwner(
  args: readonly string[] = [],
  options: { home?: string; configPath?: string } = {}
): Promise<OwnerResult> {
  if (args.length !== 0) throw new CliInputError('Usage: mama register-owner');
  const home = options.home ?? homedir();
  const config = loadConfig({ home, ...(options.configPath ? { path: options.configPath } : {}) });
  // Every id the gateway admits as the owner (explicit, or derived from a single allowed chat) is
  // an identity of the one owner, so each binds to the owner principal. An id bound to anyone else
  // is a conflict, and then nothing is written.
  const ownerIds = config.telegram.owner_user_ids;
  if (ownerIds.length === 0) {
    throw new CliInputError('telegram.owner_user_ids must contain at least one user id');
  }
  const adapter = createAdapter({ dbPath: config.database.path });
  let result: OwnerResult;
  let counts: { principals: number; identities: number };
  try {
    adapter.connect();
    try {
      result = adapter.transaction(() => {
        const repository = createPrincipalRepository(adapter);
        const now = Date.now();
        const results = ownerIds.map((externalId) =>
          repository.ensureOwner({
            principalId: OWNER_PRINCIPAL_ID,
            connector: 'telegram',
            namespace: 'private',
            externalId,
            now,
          })
        );
        if (results.includes('conflict')) throw new OwnerConflict();
        return results.includes('created') ? 'created' : 'exists';
      });
    } catch (error) {
      if (!(error instanceof OwnerConflict)) throw error;
      result = 'conflict';
    }
    counts = {
      principals: (
        adapter.prepare('SELECT COUNT(*) AS count FROM principals').get() as { count: number }
      ).count,
      identities: (
        adapter.prepare('SELECT COUNT(*) AS count FROM external_identities').get() as {
          count: number;
        }
      ).count,
    };
  } finally {
    adapter.disconnect();
  }
  console.log(`${result} principals=${counts.principals} identities=${counts.identities}`);
  return result;
}
