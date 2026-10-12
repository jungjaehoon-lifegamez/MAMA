import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCatalog,
  createDispatcher,
  createKnowledge,
  createPrincipalRepository,
} from '@jungjaehoon/mama-core';
import { TelegramGateway } from '../../src/gateways/telegram.js';
import { createActionSurface } from '../../src/runtime/action-surface.js';
import { createMemberEnrollment } from '../../src/api/member-enrollment.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';
import { memberClaudeTmpDir, memberPaths } from '../../src/runtime/member-paths.js';
import { resolvePrincipalAccess } from '../../src/runtime/principal-access.js';

const transport = vi.hoisted(() => ({
  send: vi.fn().mockResolvedValue({ message_id: 1 }),
  handler: undefined as undefined | ((ctx: unknown) => Promise<void>),
}));
vi.mock('grammy', async (original) => ({
  InputFile: (await original<typeof import('grammy')>()).InputFile,
  Bot: vi.fn(() => ({
    on: (_event: string, handler: (ctx: unknown) => Promise<void>) => {
      transport.handler = handler;
    },
    catch: () => {},
    init: async () => {},
    stop: async () => {},
    botInfo: { id: 1, username: 'fixture_bot' },
    api: {
      sendMessage: transport.send,
      editMessageText: async () => {},
      deleteMessage: async () => {},
    },
  })),
}));

const id = (key: string) => String(createHash('sha256').update(key).digest().readUInt32BE(0));
const ownerId = id('enrollment-owner');
const selectedId = id('enrollment-selected');
const commonRoom = id('enrollment-common-room');
const roots: string[] = [];
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  transport.send.mockClear();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'enrollment-home-')));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'enrollment-members-')));
  roots.push(home, root);
  vi.stubEnv('HOME', home);
  vi.stubEnv('MAMA_DB_PATH', join(home, 'state.db'));
  const database = await openCoreDatabase({ path: join(home, 'state.db') });
  cleanup.push(() => database.close());
  const repo = createPrincipalRepository(database.adapter);
  repo.ensureOwner({ principalId: 'common', now: 1 });
  const owner = repo.registerMember({
    connector: 'telegram',
    namespace: 'private',
    externalId: ownerId,
    now: 2,
  });
  repo.grantRole({ principalId: owner, role: 'owner', now: 3 });
  const intake = {
    acceptOwnerMessage: vi.fn().mockReturnValue({ inputId: 'fixture-input', state: 'accepted' }),
    recordOwnerReply: () => {},
  };
  const selected = vi.fn();
  const surface = createActionSurface({
    runtimeRoot: home,
    configPath: join(home, 'config.yaml'),
    adapter: database.adapter,
    knowledge: createKnowledge({ adapter: database.adapter, embedder: null }),
    ownerPrincipalId: 'common',
    agentId: 'common-agent',
    timeZone: createTimeZoneSetting('UTC'),
    isOwnerMessageTurn: () => true,
    memberEnrollment: {
      memberRoot: root,
      requestSelection: (ref) => gateway.requestMemberEnrollment(ref),
    },
  });
  const gateway = new TelegramGateway({
    token: 'fixture-token',
    registry: repo,
    intake,
    memberIntake: () => intake,
    principalPaths: (principalId) => memberPaths(root, principalId),
    messageLedgerPath: join(home, 'ledger.json'),
    config: { allowedChats: [commonRoom], ownerChatId: commonRoom, polling: false },
    onMemberSelection: selected,
  });
  await gateway.start();
  cleanup.push(() => gateway.stop());
  const personalAccess = () =>
    resolvePrincipalAccess(owner, {
      adapter: database.adapter,
      ownerAccess: surface.ownerAccess,
      agentId: 'person-agent',
    });
  return { home, root, database, repo, owner, intake, selected, gateway, surface, personalAccess };
}

describe('P10.1 enrollment waits for owner DM administration', () => {
  it.each(['common', 'owner DM'] as const)(
    'refuses %s enrollment without requesting a keyboard or registering a person',
    async (room) => {
      const f = await fixture();
      const result = await f.surface.dispatch(
        { action: 'manage.member.enroll', input: {}, operationId: 'fixture-enroll' },
        {
          access: room === 'common' ? f.surface.ownerAccess : f.personalAccess(),
          session: { sourceMessageRef: `telegram:${room === 'common' ? commonRoom : ownerId}:1` },
        }
      );
      expect(result).toMatchObject({ status: 'failed', error: { code: 'action_not_granted' } });
      expect(result.status === 'failed' && result.error.message).toBe(
        `principal ${room === 'common' ? 'common' : f.owner} may not call manage.member.enroll`
      );
      expect(transport.send).not.toHaveBeenCalled();
      expect(f.selected).not.toHaveBeenCalled();
      expect(f.repo.listMembers()).toHaveLength(1);
      expect(f.repo.resolveByExternal('telegram', 'private', selectedId)).toBeNull();
    }
  );

  it('does not expose enrollment in common or personal help', async () => {
    const f = await fixture();
    for (const access of [f.surface.ownerAccess, f.personalAccess()]) {
      const result = await f.surface.dispatch({ action: 'help', input: {} }, { access });
      expect(result.status).toBe('completed');
      expect(result.status === 'completed' && result.data).not.toContain('manage.member.enroll');
    }
  });

  it('refuses a late host selection through the product dispatcher', async () => {
    const f = await fixture();
    expect(
      await f.surface.completeMemberEnrollment({
        sourceMessageRef: `telegram:${ownerId}:1`,
        ownerUserId: ownerId,
        userId: selectedId,
      })
    ).toMatchObject({ status: 'failed', error: { code: 'action_not_granted' } });
    expect(f.repo.resolveByExternal('telegram', 'private', selectedId)).toBeNull();
  });
});

describe('host enrollment factory kept for owner DM administration', () => {
  const factory = (f: Awaited<ReturnType<typeof fixture>>) => {
    // An isolated internal factory contract; production action grants above expose no enrollment.
    const ownerAccess = { ...f.surface.ownerAccess, actions: ['manage.member.enroll'] };
    const enrollment = createMemberEnrollment({
      adapter: f.database.adapter,
      ownerPrincipalId: 'common',
      ownerAccess: () => ownerAccess,
      isOwnerMessageTurn: () => true,
      ports: { memberRoot: f.root, requestSelection: async () => {} },
    });
    const dispatch = createDispatcher(createCatalog([enrollment.registration]));
    return () =>
      enrollment.complete(
        { sourceMessageRef: `telegram:${ownerId}:1`, ownerUserId: ownerId, userId: selectedId },
        dispatch
      );
  };

  it('moves an old common identity and clears smoke state once while preserving existing member state on repeat', async () => {
    const f = await fixture();
    f.repo.bindIdentity('common', 'telegram', 'private', selectedId, 4);
    let member = '';
    try {
      f.database.adapter.transaction(() => {
        member = f.repo.moveIdentityToMember({
          expectedPrincipalId: 'common',
          connector: 'telegram',
          namespace: 'private',
          externalId: selectedId,
          now: 5,
        });
        throw new Error('fixture rollback');
      });
    } catch {
      /* only prediction */
    }
    expect(member).toMatch(/^principal_/);
    const paths = memberPaths(f.root, member);
    const temp = memberClaudeTmpDir(member);
    roots.push(temp);
    mkdirSync(paths.runtimeRoot, { recursive: true });
    mkdirSync(temp, { recursive: true });
    const smoke = join(paths.runtimeRoot, 'smoke');
    const tmpSmoke = join(temp, 'smoke');
    writeFileSync(smoke, 'fixture');
    writeFileSync(tmpSmoke, 'fixture');
    const complete = factory(f);
    const created = await complete();
    expect(created, JSON.stringify(created)).toMatchObject({
      status: 'completed',
      data: { status: 'created', principalId: member },
    });
    expect(existsSync(smoke)).toBe(false);
    expect(existsSync(tmpSmoke)).toBe(false);
    expect(existsSync(paths.workspaceDir)).toBe(true);
    writeFileSync(smoke, 'retained');
    writeFileSync(tmpSmoke, 'retained');
    expect(await complete()).toMatchObject({
      status: 'completed',
      data: { status: 'exists', principalId: member },
    });
    expect(existsSync(smoke)).toBe(true);
    expect(existsSync(tmpSmoke)).toBe(true);
  });

  it('rolls back identity registration when the smoke path is a symlink', async () => {
    const f = await fixture();
    const member = `principal_${createHash('sha256')
      .update(JSON.stringify(['member', 'telegram', 'private', selectedId]))
      .digest('hex')}`;
    const paths = memberPaths(f.root, member);
    symlinkSync(f.home, paths.runtimeRoot);
    expect(await factory(f)()).toMatchObject({ status: 'failed' });
    expect(f.repo.resolveByExternal('telegram', 'private', selectedId)).toBeNull();
    expect(f.repo.listMembers()).toHaveLength(1);
  });
});
