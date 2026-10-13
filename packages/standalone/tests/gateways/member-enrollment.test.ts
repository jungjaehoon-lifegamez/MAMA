import { createRequire } from 'node:module';
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
  type ActionResult,
} from '@jungjaehoon/mama-core';
import { TelegramGateway } from '../../src/gateways/telegram.js';
import { createActionSurface } from '../../src/runtime/action-surface.js';
import { createMemberEnrollment } from '../../src/api/member-enrollment.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';
import { memberClaudeTmpDir, memberPaths } from '../../src/runtime/member-paths.js';
import { createOwnerRuntime, type OwnerRuntimeOptions } from '../../src/runtime/owner-runtime.js';
import { ChatSources } from '../../src/storage/chat-sources.js';
import { RawStore } from '../../src/storage/source-archive.js';
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
  const completions: ActionResult[] = [];
  const refs = new Map<string, string>();
  const raw = new RawStore(join(home, 'raw'));
  cleanup.push(async () => raw.close());
  let complete: (
    selection: import('../../src/api/member-enrollment.js').MemberSelection
  ) => Promise<ActionResult>;
  let record = (exchange: import('../../src/gateways/turn-contract.js').OwnerHostExchangeInput) => {
    const person = repo.resolveByExternal('telegram', 'private', exchange.message.channelKey)!;
    const chat = new ChatSources(
      raw,
      database.adapter,
      person.principalId,
      `member-agent:${person.principalId}`
    );
    chat.saveOwnerMessage(exchange.message);
    chat.saveReply({ ...exchange.reply, messageRef: exchange.message.id, author: 'host' });
  };
  const selected = vi.fn(async (selection) => {
    const result = await complete(selection);
    completions.push(result);
    return result;
  });
  const surface = createActionSurface({
    runtimeRoot: home,
    configPath: join(home, 'config.yaml'),
    adapter: database.adapter,
    knowledge: createKnowledge({ adapter: database.adapter, embedder: null }),
    ownerPrincipalId: 'common',
    agentId: 'common-agent',
    connectors: [],
    timeZone: createTimeZoneSetting('UTC'),
    isOwnerMessageTurn: (ref, principalId) => refs.get(ref) === principalId,
    memberEnrollment: {
      memberRoot: root,
      requestSelection: (ref, callerDm) => gateway.requestMemberEnrollment(ref, callerDm),
    },
  });
  complete = surface.completeMemberEnrollment;
  let memberIntake = (principalId: string) => ({
    ...intake,
    acceptOwnerMessage: (
      input: import('../../src/gateways/turn-contract.js').OwnerMessageInput
    ) => {
      refs.set(input.id, principalId);
      return intake.acceptOwnerMessage();
    },
  });
  const gateway = new TelegramGateway({
    token: 'fixture-token',
    registry: repo,
    intake,
    memberIntake: (principalId) => memberIntake(principalId),
    recordMemberSelection: (exchange) => record(exchange),
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
  let messageId = 0;
  const message = async (extra: object, sender = ownerId) => {
    const current = ++messageId;
    await transport.handler!({
      message: {
        message_id: current,
        date: current,
        chat: { id: Number(sender), type: 'private' },
        from: { id: Number(sender), is_bot: false },
        ...extra,
      },
    });
    return `telegram:${sender}:${current}`;
  };
  const sourceRef = await message({ text: 'fixture enrollment request' });
  transport.send.mockClear();
  let operation = 0;
  const request = (ref = sourceRef, actions = surface) =>
    actions.hostToolCall('manage.member.enroll', {}, `fixture-request-${++operation}`, {
      access: personalAccess(),
      session: { sourceMessageRef: ref },
    });
  const requestId = () =>
    transport.send.mock.calls.at(-1)![2].reply_markup.keyboard[0][0].request_users
      .request_id as number;
  const share = (requestId: number, userId = selectedId) =>
    message({ users_shared: { request_id: requestId, users: [{ user_id: Number(userId) }] } });
  const boot = async (extra: Partial<OwnerRuntimeOptions> = {}) => {
    const ipc = createRequire(import.meta.url)('@jungjaehoon/mama-core/client/ipc');
    vi.spyOn(ipc, 'createActionIpcServer').mockResolvedValue({ close: async () => {} });
    const runtime = await createOwnerRuntime({
      backend: 'codex',
      model: 'fixture',
      runtimeRoot: home,
      workspaceDir: join(home, 'workspace'),
      rawPath: join(home, 'runtime-raw'),
      databasePath: join(home, 'state.db'),
      socketPath: join(home, 'socket'),
      credentialPath: join(home, 'runtime', 'credential'),
      memberRoot: root,
      memberEnrollment: {
        requestSelection: (ref, callerDm) => gateway.requestMemberEnrollment(ref, callerDm),
        cancelSelection: (principalId) => gateway.cancelMemberEnrollment(principalId),
      },
      ownerPrincipalId: 'common',
      agentId: 'common-agent',
      connectors: [],
      scopes: [],
      timeZone: createTimeZoneSetting('UTC'),
      maxTurns: 5,
      timeout: 1000,
      embedder: { embed: async () => new Float32Array(1024).fill(0.25) },
      createSession: () =>
        ({
          stop: async () => {},
          resetSession: async () => {},
          runTurn: async () => ({ response: 'fixture answer', modelRunId: null }),
        }) as never,
      ...extra,
    });
    cleanup.push(() => runtime.stop());
    complete = runtime.completeMemberEnrollment;
    record = runtime.recordHostExchange;
    memberIntake = (principalId) => runtime.serveMember(principalId) as never;
    return runtime;
  };
  return {
    home,
    root,
    database,
    repo,
    owner,
    intake,
    selected,
    gateway,
    surface,
    personalAccess,
    completions,
    message,
    sourceRef,
    request,
    requestId,
    share,
    boot,
    completeWith: (port: typeof complete) => {
      complete = port;
    },
  };
}

describe('P10.3 enrollment from owner-role DMs', () => {
  it('routes a common-channel owner request to its DM and completes in that requesting room authority', async () => {
    const f = await fixture();
    const runtime = await f.boot({ deliveryReady: () => false });
    const ref = `telegram:${commonRoom}:fixture-common-request`;
    runtime.intake.acceptOwnerMessage({
      id: ref,
      channelKey: commonRoom,
      senderPrincipalId: f.owner,
      occurredAt: 10,
      text: 'fixture enrollment request',
    });
    expect(
      await runtime.surface.hostToolCall('manage.member.enroll', {}, 'fixture-common-enroll', {
        session: { sourceMessageRef: ref },
      })
    ).toMatchObject({ data: { status: 'pending' } });
    expect(transport.send.mock.calls.at(-1)![0]).toBe(Number(ownerId));
    const selectionRef = await f.share(f.requestId());
    expect(f.completions.at(-1)).toMatchObject({ data: { status: 'created' } });
    expect(
      f.database.adapter
        .prepare('SELECT memory_scope_id FROM connector_event_index WHERE source_id=?')
        .get(`${selectionRef}:reply`)
    ).toEqual({ memory_scope_id: f.owner });
    const commonList = await runtime.surface.hostToolCall(
      'manage.member.list',
      {},
      'fixture-common-list',
      {
        session: { sourceMessageRef: ref },
      }
    );
    expect(commonList).toMatchObject({
      data: {
        recentEnrollments: [
          expect.objectContaining({ receipt: expect.stringContaining('Enrollment created') }),
        ],
      },
    });
  });

  it('keeps each owner pending selection independent and refuses an existing owner identity without registering it again', async () => {
    const f = await fixture();
    expect(await f.request()).toMatchObject({ data: { status: 'pending' } });
    const first = f.requestId();
    const otherDm = id('fixture-other-owner');
    const other = f.repo.registerMember({
      connector: 'telegram',
      namespace: 'private',
      externalId: otherDm,
      now: 4,
    });
    f.repo.grantRole({ principalId: other, role: 'owner', now: 4 });
    const ref = await f.message({ text: 'fixture other owner' }, otherDm);
    const access = resolvePrincipalAccess(other, {
      adapter: f.database.adapter,
      ownerAccess: f.surface.ownerAccess,
      agentId: 'fixture-other',
    });
    expect(
      await f.surface.hostToolCall('manage.member.enroll', {}, 'fixture-other-enroll', {
        access,
        session: { sourceMessageRef: ref },
      })
    ).toMatchObject({ data: { status: 'pending' } });
    const second = f.requestId();
    await f.share(first);
    expect(f.completions.at(-1)).toMatchObject({ data: { status: 'created' } });
    await f.message(
      { users_shared: { request_id: second, users: [{ user_id: Number(ownerId) }] } },
      otherDm
    );
    expect(f.completions.at(-1)).toMatchObject({
      data: { status: 'exists', principalId: f.owner },
    });
    expect(f.repo.listMembers()).toHaveLength(3);
  });
  it('enrolls end to end and lists common receipts from either owner DM', async () => {
    const f = await fixture();
    const runtime = await f.boot({ deliveryReady: () => false });
    const requestingRef = await f.message({ text: 'fixture enrollment request' });
    const request = () => f.request(requestingRef, runtime.surface);
    expect(await request()).toMatchObject({ data: { status: 'pending' } });
    expect(transport.send.mock.calls.at(-1)![0]).toBe(Number(ownerId));
    const ref = await f.share(f.requestId());
    expect(f.completions.at(-1)).toMatchObject({
      status: 'completed',
      data: { status: 'created' },
    });
    const member = f.repo.resolveByExternal('telegram', 'private', selectedId)!;
    expect(member.kind).toBe('member');
    expect(f.repo.listActiveGrants(member.principalId)).toEqual([]);
    const rows = f.database.adapter
      .prepare(
        'SELECT memory_scope_id, content FROM connector_event_index WHERE source_id IN (?, ?)'
      )
      .all(ref, `${ref}:reply`);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memory_scope_id: f.owner,
          content: expect.stringContaining('Enrollment created'),
        }),
      ])
    );
    const listed = await f.surface.hostToolCall('manage.member.list', {}, 'fixture-list', {
      access: f.personalAccess(),
      session: { sourceMessageRef: f.sourceRef },
    });
    expect(listed).toMatchObject({
      data: {
        recentEnrollments: [
          expect.objectContaining({ receipt: expect.stringContaining('Enrollment created') }),
        ],
      },
    });
    const other = f.repo.registerMember({
      connector: 'telegram',
      namespace: 'private',
      externalId: id('fixture-other-owner'),
      now: 4,
    });
    f.repo.grantRole({ principalId: other, role: 'owner', now: 4 });
    const otherRef = await f.message({ text: 'fixture other owner' }, id('fixture-other-owner'));
    const otherAccess = resolvePrincipalAccess(other, {
      adapter: f.database.adapter,
      ownerAccess: f.surface.ownerAccess,
      agentId: 'fixture-other',
    });
    // Bind the fixture turn to its actual session, as the daemon mailbox does.
    const otherList = await runtime.surface.hostToolCall(
      'manage.member.list',
      {},
      'fixture-other-list',
      {
        access: otherAccess,
        session: { sourceMessageRef: otherRef },
      }
    );
    expect(otherList).toMatchObject({ data: { recentEnrollments: expect.any(Array) } });
    expect(
      otherList.status === 'completed' &&
        (otherList.data as { recentEnrollments: unknown }).recentEnrollments
    ).toEqual(
      listed.status === 'completed' &&
        (listed.data as { recentEnrollments: unknown }).recentEnrollments
    );
    await request();
    const refusedRef = await f.share(f.requestId(), ownerId);
    const refused = await runtime.surface.hostToolCall(
      'manage.member.list',
      {},
      'fixture-refused-list',
      {
        access: otherAccess,
        session: { sourceMessageRef: otherRef },
      }
    );
    expect(refused).toMatchObject({
      data: {
        recentEnrollments: [
          expect.objectContaining({ receipt: expect.stringContaining('Enrollment refused') }),
          expect.objectContaining({ receipt: expect.stringContaining('Enrollment created') }),
        ],
      },
    });
    expect(
      f.database.adapter
        .prepare('SELECT author, memory_scope_id FROM connector_event_index WHERE source_id=?')
        .get(`host:management:${refusedRef}`)
    ).toEqual({ author: f.owner, memory_scope_id: 'common' });
    await request();
    await f.share(f.requestId());
    expect(f.completions.at(-1)).toMatchObject({
      data: { status: 'exists', principalId: member.principalId },
    });
    expect(f.repo.listMembers()).toHaveLength(3);
  });

  it('refuses an owner selecting its own identity in the enrollment picker', async () => {
    const f = await fixture();
    await f.request();
    await f.share(f.requestId(), ownerId);
    expect(f.completions.at(-1)).toMatchObject({
      status: 'completed',
      data: {
        status: 'refused',
        principalId: f.owner,
        message: expect.stringContaining('own identity'),
      },
    });
    expect(f.repo.listMembers()).toHaveLength(1);
  });

  it('clears an owner pending picker on suspension so its old selection is refused after resume', async () => {
    const f = await fixture();
    const runtime = await f.boot({ deliveryReady: () => false });
    const otherDm = id('fixture-managing-owner');
    const other = f.repo.registerMember({
      connector: 'telegram',
      namespace: 'private',
      externalId: otherDm,
      now: 4,
    });
    f.repo.grantRole({ principalId: other, role: 'owner', now: 4 });
    const otherRef = await f.message({ text: 'fixture management' }, otherDm);
    const access = resolvePrincipalAccess(other, {
      adapter: runtime.database.adapter,
      ownerAccess: runtime.surface.ownerAccess,
      agentId: 'fixture-manager',
    });
    const manage = (change: string) =>
      runtime.surface.hostToolCall(
        `manage.member.${change}`,
        { principalId: f.owner },
        `fixture-${change}`,
        { access, session: { sourceMessageRef: otherRef } }
      );
    const ownerRef = await f.message({ text: 'fixture enrollment request' });
    await f.request(ownerRef, runtime.surface);
    const oldRequest = f.requestId();
    const suspended = await manage('suspend');
    expect(suspended, JSON.stringify(suspended)).toMatchObject({ status: 'completed' });
    const resumed = await manage('resume');
    expect(resumed, JSON.stringify(resumed)).toMatchObject({ status: 'completed' });
    await f.share(oldRequest);
    expect(f.completions).toHaveLength(0);
    expect(transport.send.mock.calls.at(-1)![1]).toContain('No matching pending request');
  });

  it('consumes once and refuses wrong, replaced, repeated and lost-at-restart requests', async () => {
    const f = await fixture();
    expect(await f.request()).toMatchObject({ data: { status: 'pending' } });
    const old = f.requestId();
    await f.request();
    const current = f.requestId();
    await f.share(old);
    await f.share(current + 1);
    expect(f.repo.resolveByExternal('telegram', 'private', selectedId)).toBeNull();
    await f.share(current);
    await f.share(current);
    expect(f.completions).toHaveLength(1);
    expect(transport.send.mock.calls.at(-1)![1]).toMatch(/again/);
    await f.request();
    const lost = f.requestId();
    await f.gateway.stop();
    await f.gateway.start();
    await f.share(lost);
    expect(f.completions).toHaveLength(1);
  });

  it('tells the owner the outcome and stores it personally when completion rejects', async () => {
    const f = await fixture();
    expect(await f.request()).toMatchObject({ data: { status: 'pending' } });
    f.completeWith(async () => {
      throw new Error('fixture completion failure');
    });
    const ref = await f.share(f.requestId());
    const row = f.database.adapter
      .prepare('SELECT memory_scope_id, content FROM connector_event_index WHERE source_id=?')
      .get(`${ref}:reply`);
    expect(row).toMatchObject({
      memory_scope_id: f.owner,
      content: expect.stringContaining('fixture completion failure'),
    });
    expect(f.repo.resolveByExternal('telegram', 'private', selectedId)).toBeNull();
  });

  it('keeps a receipt in its owner chat even if that owner becomes suspended before delivery', async () => {
    const f = await fixture();
    const runtime = await f.boot({ deliveryReady: () => false });
    const ref = await f.message({ text: 'fixture request' });
    expect(
      await runtime.surface.hostToolCall('manage.member.enroll', {}, 'fixture-request', {
        access: f.personalAccess(),
        session: { sourceMessageRef: ref },
      })
    ).toMatchObject({ data: { status: 'pending' } });
    f.completeWith(async (selection) => {
      const result = await runtime.completeMemberEnrollment(selection);
      f.repo.suspend(f.owner, Date.now());
      return result;
    });
    const receiptRef = await f.share(f.requestId());
    expect(
      f.database.adapter
        .prepare('SELECT memory_scope_id FROM connector_event_index WHERE source_id=?')
        .get(`${receiptRef}:reply`)
    ).toEqual({ memory_scope_id: f.owner });
  });

  it('completes on the shared serial chain and serves the selected member immediately', async () => {
    const f = await fixture();
    let release!: () => void;
    let started = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = await f.boot({
      createSession: () =>
        ({
          stop: async () => {},
          runTurn: async () => {
            started = true;
            await gate;
            return { response: 'fixture', modelRunId: null };
          },
        }) as never,
    });
    const ref = await f.message({ text: 'fixture request' });
    await vi.waitFor(() => expect(started).toBe(true));
    try {
      const request = await runtime.surface.hostToolCall(
        'manage.member.enroll',
        {},
        'fixture-chain-request',
        { access: f.personalAccess(), session: { sourceMessageRef: ref } }
      );
      expect(request).toMatchObject({ data: { status: 'pending' } });
      const pending = f.share(f.requestId());
      await vi.waitFor(() =>
        expect(transport.send.mock.calls.at(-1)![1]).toBe('Enrollment selection received.')
      );
      expect(f.repo.resolveByExternal('telegram', 'private', selectedId)).toBeNull();
      release();
      await pending;
      const member = f.repo.resolveByExternal('telegram', 'private', selectedId)!;
      expect(runtime.runtime.servesPrincipal(member.principalId)).toBe(true);
    } finally {
      release();
    }
  });

  it('reports activation failure and serves an existing registration on repeat', async () => {
    const f = await fixture();
    let fail = true;
    const runtime = await f.boot({
      deliveryReady: () => false,
      createSession: (input) => {
        if (input.principal && input.principal.principalId !== f.owner && fail)
          throw new Error('fixture activation failure');
        return { stop: async () => {} } as never;
      },
    });
    const ref = await f.message({ text: 'fixture request' });
    const request = async () =>
      runtime.surface.hostToolCall('manage.member.enroll', {}, 'fixture-activation', {
        access: f.personalAccess(),
        session: { sourceMessageRef: ref },
      });
    expect(await request()).toMatchObject({ data: { status: 'pending' } });
    await f.share(f.requestId());
    expect(f.completions.at(-1)).toMatchObject({
      status: 'failed',
      error: { message: expect.stringContaining('fixture activation failure') },
    });
    const member = f.repo.resolveByExternal('telegram', 'private', selectedId)!;
    expect(runtime.runtime.servesPrincipal(member.principalId)).toBe(false);
    fail = false;
    await request();
    await f.share(f.requestId());
    expect(f.completions.at(-1)).toMatchObject({ data: { status: 'exists' } });
    expect(runtime.runtime.servesPrincipal(member.principalId)).toBe(true);
  });

  it('boots after enrollment with the registered member served and common authority unchanged', async () => {
    const f = await fixture();
    expect(await f.request()).toMatchObject({ data: { status: 'pending' } });
    await f.share(f.requestId());
    const member = f.repo.resolveByExternal('telegram', 'private', selectedId)!;
    const runtime = await f.boot();
    expect(runtime.runtime.servesPrincipal(member.principalId)).toBe(true);
    expect(runtime.surface.ownerAccess.principalId).toBe('common');
    expect(runtime.surface.ownerAccess.defaultScopes).toEqual(f.surface.ownerAccess.defaultScopes);
  });
});

describe('host enrollment factory kept for owner DM administration', () => {
  const factory = (f: Awaited<ReturnType<typeof fixture>>) => {
    const ownerAccess = f.surface.ownerAccess;
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
