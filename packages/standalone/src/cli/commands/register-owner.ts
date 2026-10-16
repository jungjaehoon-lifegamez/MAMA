import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createPrincipalRepository, moveRecordsUserScope } from '@jungjaehoon/mama-core';
import { CodexThreadRegistry } from '@jungjaehoon/mama-core/runtime/drivers/codex-thread-registry';
import { loadConfig, defaultConfigPath } from '../../runtime/config.js';
import { openCoreDatabase } from '../../runtime/core-db.js';
import { clearMemberSmokeState } from '../../api/member-smoke-state.js';
import { OwnerMessageLedger } from '../../gateways/telegram-message-ledger.js';
import { holdsOwnerRole } from '../../runtime/owner-authority.js';
import { RawStore } from '../../storage/source-archive.js';
import { CliInputError } from '../prompt.js';
import { OWNER_PRINCIPAL_ID } from './daemon.js';
import {
  acquireInstallLock,
  daemonControlPaths,
  refuseWhileRestoring,
} from '../runtime/daemon-control.js';

export interface OwnerCutoverCounts {
  principalsCreated: number;
  membersCreated: number;
  identitiesMoved: number;
  rolesGranted: number;
  rawItems: number;
  pendingProjections: number;
  indexRows: number;
  observations: number;
  checkpoints: number;
  threadsCleared: number;
}
const emptyCounts = (): OwnerCutoverCounts => ({
  principalsCreated: 0,
  membersCreated: 0,
  identitiesMoved: 0,
  rolesGranted: 0,
  rawItems: 0,
  pendingProjections: 0,
  indexRows: 0,
  observations: 0,
  checkpoints: 0,
  threadsCleared: 0,
});

/** One explicitly named person; core retains its identity-free common principal. */
export async function runRegisterOwner(
  args: readonly string[] = [],
  options: { home?: string; configPath?: string } = {}
): Promise<OwnerCutoverCounts> {
  if (args.length !== 1 || !/^[1-9][0-9]*$/.test(args[0]))
    throw new CliInputError('Usage: mama register-owner <telegram id>');
  const externalId = args[0];
  const home = options.home ?? homedir();
  const configPath = options.configPath ?? defaultConfigPath(home);
  const config = loadConfig({ home, path: configPath });
  const memberRoot = config.member_root;
  if (!memberRoot) throw new CliInputError('Set member_root before mama register-owner');
  const root = dirname(configPath);
  // The cutover writes the daemon's database and raw stores, so no daemon may run beside it.
  const lock = acquireInstallLock(daemonControlPaths(root), 'register-owner');
  try {
    refuseWhileRestoring(root);
    return await registerOwnerHolding(root, config, memberRoot, externalId);
  } finally {
    lock.release();
  }
}

/** The cutover itself, for a caller that already holds the install lock (`mama init`). */
export async function registerOwnerHolding(
  root: string,
  config: ReturnType<typeof loadConfig>,
  memberRoot: string,
  externalId: string
): Promise<OwnerCutoverCounts> {
  const ledgerPath = join(root, 'runtime', 'owner-message-ledger.json');
  if (existsSync(ledgerPath)) {
    const entry = new OwnerMessageLedger(ledgerPath)
      .listForTelegramDm(externalId)
      .find(({ state }) => state === 'processing' || state === 'ready');
    if (entry)
      throw new CliInputError(`Cutover refused: DM message ledger entry is ${entry.state}`);
  }
  const database = await openCoreDatabase({ path: config.database.path });
  const adapter = database.adapter;
  const rawStore = new RawStore(join(root, 'connectors'));
  let counts: OwnerCutoverCounts;
  try {
    const repo = createPrincipalRepository(adapter);
    // Include terminal mailbox rows when native delivery remains uncertain.
    const inFlight = adapter
      .prepare(
        `SELECT m.status,n.state FROM mailbox_inputs m LEFT JOIN native_input_deliveries n ON n.input_id=m.id
       WHERE m.principal_id=? AND m.kind='owner_message' AND m.channel_key=?
         AND m.stimulus_id LIKE 'telegram:%'
         AND (m.status IN ('pending','claimed') OR n.state='uncertain') LIMIT 1`
      )
      .get(OWNER_PRINCIPAL_ID, externalId) as { status: string; state: string | null } | undefined;
    if (inFlight)
      throw new CliInputError(
        `Cutover refused: DM input is ${inFlight.state === 'uncertain' ? 'uncertain' : inFlight.status}`
      );
    const current = repo.resolveByExternal('telegram', 'private', externalId);
    if (current && current.status !== 'active')
      throw new CliInputError(`Cutover refused: the identity's principal is ${current.status}`);
    if (current?.kind === 'member' && holdsOwnerRole(repo, current.principalId)) {
      counts = emptyCounts();
    } else {
      const firstOwner =
        repo.listActiveMembersWithRole('owner').length === 0 &&
        !repo.listMembers().some((p) => holdsOwnerRole(repo, p.principalId));
      const now = Date.now();
      const channel = `telegram:${externalId}`;
      counts = rawStore.withChatCutover(adapter, (moveRaw) => {
        const result = emptyCounts();
        const common = repo.ensureOwner({ principalId: OWNER_PRINCIPAL_ID, now });
        if (common === 'conflict')
          throw new CliInputError(
            'Cutover refused: common principal conflicts with the existing registry'
          );
        result.principalsCreated = common === 'created' ? 1 : 0;
        let person: string;
        if (current?.principalId === OWNER_PRINCIPAL_ID) {
          person = repo.moveIdentityToMember({
            connector: 'telegram',
            namespace: 'private',
            externalId,
            expectedPrincipalId: OWNER_PRINCIPAL_ID,
            now,
          });
          result.membersCreated = 1;
          result.identitiesMoved = 1;
        } else if (!current) {
          person = repo.registerMember({
            connector: 'telegram',
            namespace: 'private',
            externalId,
            now,
          });
          result.membersCreated = 1;
        } else if (current.kind === 'member') {
          person = current.principalId;
        } else {
          throw new CliInputError('Cutover refused: identity belongs to another common principal');
        }
        result.rolesGranted =
          repo.grantRole({ principalId: person, role: 'owner', now }) === 'created' ? 1 : 0;
        Object.assign(
          result,
          moveRaw({ channel, fromPrincipalId: OWNER_PRINCIPAL_ID, toPrincipalId: person })
        );
        const observations = adapter
          .prepare(
            "SELECT observation_id FROM observation_versions WHERE source='chat' AND channel=? AND memory_scope_kind='user' AND (memory_scope_id=? OR (memory_scope_id=? AND author=?))"
          )
          .all(channel, OWNER_PRINCIPAL_ID, person, OWNER_PRINCIPAL_ID) as Array<{
          observation_id: string;
        }>;
        const checkpoints = firstOwner
          ? (adapter
              .prepare(
                `SELECT c.id FROM checkpoints c WHERE c.timestamp <= ? AND (
            NOT EXISTS (SELECT 1 FROM checkpoint_scope_bindings b WHERE b.checkpoint_id=c.id)
            OR EXISTS (SELECT 1 FROM checkpoint_scope_bindings b JOIN memory_scopes s ON s.id=b.scope_id
              WHERE b.checkpoint_id=c.id AND s.kind='user' AND s.external_id=?))`
              )
              .all(now, OWNER_PRINCIPAL_ID) as Array<{ id: number }>)
          : [];
        const moved = moveRecordsUserScope(adapter, {
          recordIds: [
            ...observations.map((row) => row.observation_id),
            ...checkpoints.map((row) => row.id),
          ],
          fromPrincipalId: OWNER_PRINCIPAL_ID,
          toPrincipalId: person,
          authorPrincipalId: person,
          bindUnscoped: firstOwner,
        });
        result.observations = moved.records.observations;
        result.checkpoints = moved.records.checkpoints;
        result.indexRows = adapter
          .prepare(
            "UPDATE connector_event_index SET memory_scope_id=?, author=CASE WHEN author=? THEN ? ELSE author END WHERE source_connector='chat' AND channel=? AND memory_scope_kind='user' AND (memory_scope_id=? OR (memory_scope_id=? AND author=?))"
          )
          .run(
            person,
            OWNER_PRINCIPAL_ID,
            person,
            channel,
            OWNER_PRINCIPAL_ID,
            person,
            OWNER_PRINCIPAL_ID
          ).changes;
        // Run both idempotent filesystem cleanups before commit: cleanup errors roll back the
        // database, and a commit failure after cleanup lets a rerun repeat the whole cutover.
        if (result.membersCreated > 0) clearMemberSmokeState(memberRoot, person);
        // First cutover discards the mixed DM/common history. Later registrations preserve it.
        const threadRoot = join(root, 'codex-runtime', 'threads');
        if (firstOwner && existsSync(threadRoot)) {
          const threads = new CodexThreadRegistry({ rootDir: threadRoot });
          for (const key of ['owner:runtime', 'owner:replay']) {
            if (threads.load(key)) {
              threads.remove(key);
              result.threadsCleared++;
            }
          }
        }
        return result;
      });
    }
  } finally {
    rawStore.close();
    await database.close();
  }
  console.log(
    Object.entries(counts)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ')
  );
  return counts;
}
