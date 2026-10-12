import { createPrincipalRepository } from '@jungjaehoon/mama-core';
import { join } from 'node:path';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import type { TurnIntake } from '../../src/gateways/turn-contract.js';

const databases: Array<Awaited<ReturnType<typeof openCoreDatabase>>> = [];

/** Existing transport regressions use a common group and a real owner-role member sender. */
export async function telegramPrincipalFixture(root: string, intake: TurnIntake, externalId = '9') {
  const database = await openCoreDatabase({ path: join(root, 'telegram-principals.db') });
  databases.push(database);
  const registry = createPrincipalRepository(database.adapter);
  const principalId = registry.registerMember({
    connector: 'telegram',
    namespace: 'private',
    externalId,
    now: 1,
  });
  registry.grantRole({ principalId, role: 'owner', now: 2 });
  return {
    registry,
    memberIntake: () => intake,
    principalPaths: () => ({ downloadsDir: join(root, 'downloads') }),
  };
}

export async function closeTelegramPrincipalFixtures(): Promise<void> {
  for (const database of databases.splice(0)) await database.close();
}
