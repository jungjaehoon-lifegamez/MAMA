import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createKnowledge, createPrincipalRepository } from '@jungjaehoon/mama-core';

import { createActionSurface } from '../../src/runtime/action-surface.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';
import {
  memberRoomSessionKey,
  resolvePrincipalAccess,
} from '../../src/runtime/principal-access.js';
import {
  createPersonalSourceStore,
  personalChannelKey,
  personalConnectorName,
} from '../../src/runtime/personal-source-store.js';

const COMMON = 'common-fixture';
const SOURCE_ACTIONS = [
  'source.connect',
  'source.channels',
  'source.bind',
  'source.disconnect',
  'source.list',
];

/** Who reads a personal source (personal-connectors.md, C4): its person only. */
describe('personal source access', () => {
  let root: string;
  let db: Awaited<ReturnType<typeof openCoreDatabase>>;
  let surface: ReturnType<typeof createActionSurface>;
  let plain: string;
  let ownerRole: string;
  let otherOwner: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'google-read-access-'));
    vi.stubEnv('HOME', root);
    vi.stubEnv('MAMA_DB_PATH', join(root, 'core.db'));
    vi.stubEnv('MAMA_FORCE_TIER_3', 'true');
    // The gws stand-in the daemon finds on its PATH.
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'gws'),
      `#!/bin/sh\necho '{"messages":[{"id":"m1","threadId":"t1"}],"resultSizeEstimate":1}'\n`
    );
    chmodSync(join(bin, 'gws'), 0o755);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
    db = await openCoreDatabase({ path: process.env.MAMA_DB_PATH! });
    const repo = createPrincipalRepository(db.adapter);
    repo.ensureOwner({ principalId: COMMON, now: 1 });
    plain = repo.registerMember({
      connector: 'telegram',
      namespace: 'private',
      externalId: 'fixture-plain-dm',
      now: 2,
    });
    ownerRole = repo.registerMember({
      connector: 'telegram',
      namespace: 'private',
      externalId: 'fixture-owner-dm',
      now: 3,
    });
    repo.grantRole({ principalId: ownerRole, role: 'owner', now: 4 });
    otherOwner = repo.registerMember({
      connector: 'telegram',
      namespace: 'private',
      externalId: 'fixture-other-dm',
      now: 5,
    });
    repo.grantRole({ principalId: otherOwner, role: 'owner', now: 6 });
    const sources = createPersonalSourceStore(db.adapter);
    for (const principalId of [ownerRole, otherOwner, plain])
      sources.bind(principalId, 'chatwork', [{ id: '111', name: 'room-one' }]);
    surface = createActionSurface({
      adapter: db.adapter,
      knowledge: createKnowledge({ adapter: db.adapter, embedder: null }),
      runtimeRoot: join(root, 'mama'),
      configPath: join(root, 'mama', 'config.yaml'),
      ownerPrincipalId: COMMON,
      agentId: 'common-agent',
      timeZone: createTimeZoneSetting('UTC'),
      isOwnerMessageTurn: () => true,
    });
  });
  afterEach(async () => {
    await db?.close();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const access = (principalId: string, sessionKey?: string) =>
    resolvePrincipalAccess(principalId, {
      adapter: db.adapter,
      ownerAccess: surface.ownerAccess,
      agentId: `agent-${principalId}`,
      ...(sessionKey === undefined ? {} : { sessionKey }),
    });

  it('an owner-role person reads only their own personal channels, and manages them', () => {
    const mine = access(ownerRole);
    const own = personalConnectorName(ownerRole, 'chatwork');
    expect(mine.connectors).toContain(own);
    expect(mine.channels?.[own]).toEqual([personalChannelKey(ownerRole, '111')]);
    expect(mine.connectorWideRead ?? []).not.toContain(own);
    expect(mine.connectors).not.toContain(personalConnectorName(otherOwner, 'chatwork'));
    for (const action of SOURCE_ACTIONS) expect(mine.actions).toContain(action);
    const theirs = access(otherOwner);
    expect(theirs.channels?.[personalConnectorName(otherOwner, 'chatwork')]).toEqual([
      personalChannelKey(otherOwner, '111'),
    ]);
  });

  it('the common session, rooms and members without the role read none', () => {
    const common = surface.ownerAccess;
    const personal = (connectors: readonly string[] | undefined) =>
      (connectors ?? []).filter((name) => name.startsWith('personal-'));
    expect(personal(common.connectors)).toEqual([]);
    expect(personal(common.connectorWideRead)).toEqual([]);
    expect(personal(access(plain).connectors)).toEqual([]);
    expect(
      personal(access(ownerRole, memberRoomSessionKey(ownerRole, 'fixture-room')).connectors)
    ).toEqual([]);
    expect(common.connectors ?? []).not.toContain('personal-chatwork');
    expect(common.connectorWideRead ?? []).not.toContain('personal-chatwork');
    for (const action of SOURCE_ACTIONS) expect(common.actions).not.toContain(action);
    const member = access(plain);
    expect(member.connectors ?? []).not.toContain('personal-chatwork');
    for (const action of SOURCE_ACTIONS) expect(member.actions).not.toContain(action);
    const room = access(ownerRole, memberRoomSessionKey(ownerRole, 'fixture-room'));
    expect(room.connectors ?? []).not.toContain('personal-chatwork');
    for (const action of SOURCE_ACTIONS) expect(room.actions).not.toContain(action);
  });
});
