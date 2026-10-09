import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPrincipalRepository } from '@jungjaehoon/mama-core';
import type { ActionResult } from '@jungjaehoon/mama-core';
import { TelegramGateway } from '../../src/gateways/telegram.js';
import { createActionSurface, MEMBER_ACTIONS } from '../../src/runtime/action-surface.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';
import { memberClaudeTmpDir, memberPaths } from '../../src/runtime/member-paths.js';
import { resolvePrincipalAccess } from '../../src/runtime/principal-access.js';
import { createOwnerRuntime, type OwnerRuntimeOptions } from '../../src/runtime/owner-runtime.js';

const seams = vi.hoisted(() => ({
  send: vi.fn().mockResolvedValue({ message_id: 1 }),
  handler: undefined as undefined | ((ctx: unknown) => Promise<void>),
}));
vi.mock('grammy', async (original) => ({
  InputFile: (await original<typeof import('grammy')>()).InputFile,
  Bot: vi.fn(() => ({
    on: (_event: string, handler: (ctx: unknown) => Promise<void>) => {
      seams.handler = handler;
    },
    catch: vi.fn(),
    init: async () => {},
    stop: async () => {},
    botInfo: { id: 1, username: 'fixture_bot' },
    api: {
      sendMessage: seams.send,
      editMessageText: async () => {},
      deleteMessage: async () => {},
    },
  })),
}));

// Synthetic transport ids derived from fixture keys, never live identities.
const id = (key: string) => String(createHash('sha256').update(key).digest().readUInt32BE(0));
const ownerId = id('enrollment-owner');
const selectedId = id('enrollment-selected');
const roots: string[] = [];
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  seams.send.mockClear();
  vi.unstubAllEnvs();
});

async function fixture(
  options: {
    noRoot?: boolean;
    noTelegram?: boolean;
    listed?: boolean;
    groupDestination?: boolean;
  } = {}
) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'enrollment-home-')));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'enrollment-members-')));
  roots.push(home, root);
  vi.stubEnv('HOME', home);
  vi.stubEnv('MAMA_DB_PATH', join(home, 'state.db'));
  const database = await openCoreDatabase({ path: join(home, 'state.db') });
  cleanup.push(() => database.close());
  const repo = createPrincipalRepository(database.adapter);
  repo.ensureOwner({
    principalId: 'owner',
    connector: 'telegram',
    namespace: 'private',
    externalId: ownerId,
    now: 1,
  });
  const refs = new Set<string>();
  const inputs: unknown[] = [];
  const completions: ActionResult[] = [];
  const surface = createActionSurface({
    runtimeRoot: home,
    configPath: join(home, 'config.yaml'),
    adapter: database.adapter,
    knowledge: {} as never,
    ownerPrincipalId: 'owner',
    agentId: 'owner-agent',
    timeZone: createTimeZoneSetting('UTC'),
    isOwnerMessageTurn: (ref) => refs.has(ref),
    ...(options.noTelegram
      ? {}
      : {
          memberEnrollment: {
            memberRoot: options.noRoot ? undefined : root,
            ownerUserIds: options.listed ? [ownerId, selectedId] : [ownerId],
            requestSelection: (ref: string) => gateway.requestMemberEnrollment(ref),
          },
        }),
  });
  let complete = surface.completeMemberEnrollment;
  const gateway = new TelegramGateway({
    token: 'fixture-token',
    messageLedgerPath: join(home, 'ledger.json'),
    config: {
      allowedChats: [ownerId],
      ownerUserIds: [ownerId],
      ownerChatId: options.groupDestination ? id('fixture-group') : ownerId,
      polling: false,
    },
    intake: {
      acceptOwnerMessage: (input) => {
        refs.add(input.id);
        inputs.push(input);
        return { inputId: input.id, state: 'accepted' };
      },
    },
    onMemberSelection: async (selection) => {
      const result = await complete(selection);
      completions.push(result);
      return result;
    },
  });
  await gateway.start();
  cleanup.push(() => gateway.stop());
  let messageId = 1;
  const message = async (extra: object, sender = ownerId, privateChat = true) => {
    await seams.handler!({
      message: {
        message_id: messageId++,
        date: 1,
        chat: {
          id: Number(privateChat ? ownerId : id('fixture-group')),
          type: privateChat ? 'private' : 'group',
        },
        from: { id: Number(sender), is_bot: false },
        ...extra,
      },
    });
  };
  const sourceRef = `telegram:${ownerId}:1`;
  await message({ text: 'fixture enrollment request' });
  seams.send.mockClear();
  const request = () =>
    surface.hostToolCall('manage.member.enroll', {}, 'fixture-request', {
      session: { sourceMessageRef: sourceRef },
    });
  const share = (requestId: number, userId = selectedId) =>
    message({ users_shared: { request_id: requestId, users: [{ user_id: Number(userId) }] } });
  const requestId = () =>
    seams.send.mock.calls.find((call) => call[2]?.reply_markup?.keyboard)?.[2].reply_markup
      .keyboard[0][0].request_users.request_id as number;
  return {
    home,
    root,
    database,
    repo,
    surface,
    gateway,
    inputs,
    completions,
    request,
    requestId,
    share,
    message,
    refs,
    sourceRef,
    completeWith: (port: typeof complete) => {
      complete = port;
    },
  };
}

describe('P7 owner DM enrollment through the real dispatcher', () => {
  it('sends one request_users keyboard and registers a host-selected identity with an owner receipt', async () => {
    const f = await fixture();
    expect(await f.request()).toMatchObject({ status: 'completed', data: { status: 'pending' } });
    expect(seams.send).toHaveBeenCalledTimes(1);
    expect(seams.send.mock.calls[0]).toMatchObject([
      Number(ownerId),
      expect.any(String),
      {
        reply_markup: {
          one_time_keyboard: true,
          keyboard: [
            [
              {
                request_users: {
                  user_is_bot: false,
                  max_quantity: 1,
                  request_id: expect.any(Number),
                },
              },
            ],
          ],
        },
      },
    ]);
    await f.share(f.requestId());
    expect(f.completions.at(-1)).toMatchObject({
      status: 'completed',
      data: { status: 'created' },
    });
    const member = f.repo.resolveByExternal('telegram', 'private', selectedId)!;
    expect(member).toMatchObject({ kind: 'member', status: 'active' });
    expect(f.completions[0]).toMatchObject({
      status: 'completed',
      data: {
        status: 'created',
        principalId: member.principalId,
        connector: 'telegram',
        namespace: 'private',
      },
    });
    expect(f.repo.listActiveGrants(member.principalId)).toEqual([]);
    expect(seams.send.mock.calls.at(-1)).toMatchObject([
      Number(ownerId),
      expect.stringContaining(member.principalId),
      { reply_markup: { remove_keyboard: true } },
    ]);
    expect(
      JSON.stringify([f.completions, f.inputs, f.surface.catalog.describe('manage.member.enroll')])
    ).not.toContain(selectedId);
    const traces = f.database.adapter
      .prepare(
        "SELECT actor_principal_id, input_summary, output_summary FROM tool_traces WHERE tool_name='manage.member.enroll'"
      )
      .all();
    expect(traces).toHaveLength(2);
    expect(f.completions[0]?.operationId).toMatch(/^member-enrollment:/);
    expect(traces).toEqual(
      expect.arrayContaining([expect.objectContaining({ actor_principal_id: 'owner' })])
    );
    expect(JSON.stringify(traces)).not.toContain(selectedId);
    expect(MEMBER_ACTIONS).not.toContain('manage.member.enroll');
    await f.message({ text: 'fixture unadmitted input' }, selectedId);
    expect(f.inputs).toHaveLength(1);
  });

  it.each(['delta', 'scheduled', 'report', 'replay', 'member', 'subagent'])(
    'denies %s without database or directory changes',
    async (turn) => {
      const f = await fixture();
      const result = await f.surface.hostToolCall('manage.member.enroll', {}, 'fixture-denial', {
        access:
          turn === 'member'
            ? { ...f.surface.ownerAccess, principalId: 'member', actions: MEMBER_ACTIONS }
            : f.surface.ownerAccess,
        session: {
          sourceMessageRef:
            turn === 'replay' || turn === 'member' ? f.sourceRef : `${turn}:fixture`,
          ...(turn === 'replay' ? { replaySourceEndMs: 1 } : {}),
        },
      });
      expect(result).toMatchObject({ status: 'failed', error: { kind: 'denied' } });
      expect(f.repo.listMembers()).toEqual([]);
      expect(readdirSync(f.root)).toEqual([]);
      expect(seams.send).not.toHaveBeenCalled();
    }
  );

  it.each([
    { noRoot: true, key: 'member_root' },
    { noTelegram: true, key: 'Telegram' },
  ])('refuses unavailable host prerequisites: $key', async ({ key, ...options }) => {
    const f = await fixture(options);
    expect(await f.request()).toMatchObject({
      status: 'failed',
      error: { message: expect.stringContaining(key) },
    });
    expect(seams.send).not.toHaveBeenCalled();
    expect(f.repo.listMembers()).toEqual([]);
  });

  it.each(['own', 'listed', 'suspended', 'offboarded'])('refuses %s identities', async (kind) => {
    const f = await fixture({ listed: kind === 'listed' });
    if (kind === 'suspended' || kind === 'offboarded') {
      const member = f.repo.registerMember({
        connector: 'telegram',
        namespace: 'private',
        externalId: selectedId,
        now: 2,
      });
      if (kind === 'suspended') f.repo.suspend(member, 3);
      else f.repo.offboard(member, 3);
    }
    const before = f.repo.listMembers();
    await f.request();
    await f.share(f.requestId(), kind === 'own' ? ownerId : selectedId);
    expect(f.completions[0]).toMatchObject({ status: 'completed', data: { status: 'refused' } });
    expect(f.repo.listMembers()).toEqual(before);
    if (kind === 'listed') expect(JSON.stringify(f.completions)).toContain('owner_user_ids');
    expect(JSON.stringify(f.completions)).not.toContain(selectedId);
  });

  it('consumes completion once; wrong, replaced and restart requests cannot register', async () => {
    const f = await fixture();
    await f.request();
    const old = f.requestId();
    await f.request();
    const current =
      seams.send.mock.calls.at(-1)![2].reply_markup.keyboard[0][0].request_users.request_id;
    expect(current).not.toBe(old);
    await f.share(old);
    await f.share(current + 1);
    expect(f.repo.listMembers()).toEqual([]);
    await f.share(current);
    await f.share(current);
    expect(f.completions).toHaveLength(1);
    expect(seams.send.mock.calls.at(-1)![1]).toMatch(/again/);
    await f.request();
    const lost =
      seams.send.mock.calls.at(-1)![2].reply_markup.keyboard[0][0].request_users.request_id;
    await f.gateway.stop();
    await f.gateway.start();
    await f.share(lost);
    expect(f.completions).toHaveLength(1);
  });

  it('moves the removed owner alias and clears smoke state only on first enrollment', async () => {
    const f = await fixture();
    f.repo.bindIdentity('owner', 'telegram', 'private', selectedId, 2);
    const seed = f.repo.registerMember({
      connector: 'fixture',
      namespace: 'private',
      externalId: 'seed',
      now: 2,
    });
    const predictor = f.repo.moveIdentityToMember;
    // Predict the stable member id using an independent temporary transaction, then roll it back.
    let member = '';
    try {
      f.database.adapter.transaction(() => {
        member = predictor({
          expectedPrincipalId: 'owner',
          connector: 'telegram',
          namespace: 'private',
          externalId: selectedId,
          now: 3,
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
    await f.request();
    await f.share(f.requestId());
    expect(f.completions.at(-1)).toMatchObject({
      status: 'completed',
      data: { status: 'created' },
    });
    expect(f.repo.resolveByExternal('telegram', 'private', selectedId)?.principalId).toBe(member);
    expect(f.repo.resolveByExternal('telegram', 'private', ownerId)?.principalId).toBe('owner');
    expect(f.repo.findById('owner')?.status).toBe('active');
    expect(f.repo.findById(seed)).not.toBeNull();
    expect(existsSync(smoke)).toBe(false);
    expect(existsSync(tmpSmoke)).toBe(false);
    expect(existsSync(paths.workspaceDir)).toBe(true);
    expect(existsSync(temp)).toBe(true);
    writeFileSync(smoke, 'retained');
    writeFileSync(tmpSmoke, 'retained');
    await f.request();
    await f.share(
      seams.send.mock.calls.at(-1)![2].reply_markup.keyboard[0][0].request_users.request_id
    );
    expect(f.completions.at(-1)).toMatchObject({ data: { status: 'exists', principalId: member } });
    expect(existsSync(smoke)).toBe(true);
    expect(existsSync(tmpSmoke)).toBe(true);
    expect(
      resolvePrincipalAccess(member, {
        adapter: f.database.adapter,
        ownerAccess: f.surface.ownerAccess,
        agentId: 'member-agent',
      }).principalId
    ).toBe(member);
  });

  it('rolls back registration when member paths cannot be validated', async () => {
    const f = await fixture();
    const candidate = `principal_${createHash('sha256')
      .update(JSON.stringify(['member', 'telegram', 'private', selectedId]))
      .digest('hex')}`;
    const paths = memberPaths(f.root, candidate);
    symlinkSync(f.home, paths.runtimeRoot);
    await f.request();
    await f.share(f.requestId());
    expect(f.completions[0]).toMatchObject({ status: 'failed' });
    expect(f.repo.resolveByExternal('telegram', 'private', selectedId)).toBeNull();
    expect(f.repo.listMembers()).toEqual([]);
  });

  it('rejects person/chat/request/grants input fields at the dispatcher schema', async () => {
    const f = await fixture();
    for (const key of ['user_id', 'chat_id', 'request_id', 'grants']) {
      expect(
        await f.surface.hostToolCall(
          'manage.member.enroll',
          { [key]: 'fixture' },
          'fixture-invalid'
        )
      ).toMatchObject({ status: 'failed', error: { kind: 'invalid_input' } });
    }
    expect(seams.send).not.toHaveBeenCalled();
  });

  it('uses the requesting owner DM when the configured delivery destination is a group', async () => {
    const f = await fixture({ groupDestination: true });
    expect(await f.request()).toMatchObject({ data: { status: 'pending' } });
    await f.share(f.requestId());
    expect(f.completions[0]).toMatchObject({ data: { status: 'created' } });
    expect(seams.send.mock.calls.at(-1)![0]).toBe(Number(ownerId));
  });

  it.each(['telegram:fixture-group:1', 'slack:fixture:1'])(
    'rejects enrollment outside the owner DM (%s)',
    async (ref) => {
      const f = await fixture();
      f.refs.add(ref);
      expect(
        await f.surface.hostToolCall('manage.member.enroll', {}, 'fixture-wrong-chat', {
          session: { sourceMessageRef: ref },
        })
      ).toMatchObject({ status: 'failed', error: { kind: 'denied' } });
      expect(seams.send).not.toHaveBeenCalled();
      expect(f.repo.listMembers()).toEqual([]);
    }
  );

  it('completes on the existing serial turn chain and serves a member immediately', async () => {
    const f = await fixture();
    const ipc = createRequire(import.meta.url)('@jungjaehoon/mama-core/client/ipc');
    vi.spyOn(ipc, 'createActionIpcServer').mockResolvedValue({ close: async () => {} });
    let started = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = await createOwnerRuntime({
      backend: 'codex',
      model: 'fixture',
      runtimeRoot: f.home,
      workspaceDir: join(f.home, 'workspace'),
      rawPath: join(f.home, 'raw'),
      databasePath: join(f.home, 'state.db'),
      socketPath: join(f.home, 'runtime.sock'),
      credentialPath: join(f.home, 'runtime', 'credential'),
      memberRoot: f.root,
      memberEnrollment: {
        ownerUserIds: [ownerId],
        requestSelection: (ref) => f.gateway.requestMemberEnrollment(ref),
      },
      ownerPrincipalId: 'owner',
      agentId: 'owner-agent',
      scopes: [],
      timeZone: createTimeZoneSetting('UTC'),
      maxTurns: 5,
      timeout: 1000,
      lessons: async () => [],
      embedder: { embed: async () => new Float32Array(1024).fill(0.25) },
      createSession: () =>
        ({
          stop: async () => {},
          runTurn: async () => {
            started = true;
            await gate;
            return { response: 'fixture', modelRunId: null } as never;
          },
        }) as never,
    });
    cleanup.push(() => runtime.stop());
    f.completeWith(runtime.completeMemberEnrollment);
    try {
      runtime.intake.acceptOwnerMessage({
        id: f.sourceRef,
        channelKey: ownerId,
        occurredAt: 1,
        text: 'fixture enrollment request',
      });
      await vi.waitFor(() => expect(started).toBe(true));
      expect(
        await runtime.surface.hostToolCall('manage.member.enroll', {}, 'fixture-request', {
          session: { sourceMessageRef: f.sourceRef },
        })
      ).toMatchObject({ data: { status: 'pending' } });
      const selecting = f.share(f.requestId());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(f.repo.listMembers()).toEqual([]);
      expect(seams.send.mock.calls.at(-1)![2]).toMatchObject({
        reply_markup: { remove_keyboard: true },
      });
      release();
      await selecting;
      const member = f.repo.resolveByExternal('telegram', 'private', selectedId)!;
      expect(runtime.runtime.servesPrincipal(member.principalId)).toBe(true);
      expect(f.completions.at(-1)).toMatchObject({ data: { status: 'created' } });
    } finally {
      release();
    }
  });

  it('reports a runtime activation failure through the dispatcher and can serve on repeat', async () => {
    const f = await fixture();
    const ipc = createRequire(import.meta.url)('@jungjaehoon/mama-core/client/ipc');
    vi.spyOn(ipc, 'createActionIpcServer').mockResolvedValue({ close: async () => {} });
    let fail = true;
    const runtime = await createOwnerRuntime({
      backend: 'codex',
      model: 'fixture',
      runtimeRoot: f.home,
      workspaceDir: join(f.home, 'workspace'),
      rawPath: join(f.home, 'raw'),
      databasePath: join(f.home, 'state.db'),
      socketPath: join(f.home, 'runtime.sock'),
      credentialPath: join(f.home, 'runtime', 'credential'),
      memberRoot: f.root,
      memberEnrollment: {
        ownerUserIds: [ownerId],
        requestSelection: (ref) => f.gateway.requestMemberEnrollment(ref),
      },
      ownerPrincipalId: 'owner',
      agentId: 'owner-agent',
      scopes: [],
      timeZone: createTimeZoneSetting('UTC'),
      deliveryReady: () => false,
      maxTurns: 5,
      timeout: 1000,
      embedder: { embed: async () => new Float32Array(1024).fill(0.25) },
      createSession: (input) => {
        if (input.principal && fail) throw new Error('fixture activation failure');
        return { stop: async () => {} } as never;
      },
    });
    cleanup.push(() => runtime.stop());
    f.completeWith(runtime.completeMemberEnrollment);
    runtime.intake.acceptOwnerMessage({
      id: f.sourceRef,
      channelKey: ownerId,
      occurredAt: 1,
      text: 'fixture enrollment request',
    });
    await runtime.surface.hostToolCall('manage.member.enroll', {}, 'fixture-request', {
      session: { sourceMessageRef: f.sourceRef },
    });
    await expect(f.share(f.requestId())).resolves.toBeUndefined();
    expect(f.completions.at(-1)).toMatchObject({
      status: 'failed',
      error: { message: expect.stringContaining('fixture activation failure') },
    });
    const member = f.repo.resolveByExternal('telegram', 'private', selectedId)!;
    expect(runtime.runtime.servesPrincipal(member.principalId)).toBe(false);
    fail = false;
    await runtime.surface.hostToolCall('manage.member.enroll', {}, 'fixture-request', {
      session: { sourceMessageRef: f.sourceRef },
    });
    await f.share(
      seams.send.mock.calls.at(-1)![2].reply_markup.keyboard[0][0].request_users.request_id
    );
    expect(f.completions.at(-1)).toMatchObject({ data: { status: 'exists' } });
    expect(runtime.runtime.servesPrincipal(member.principalId)).toBe(true);
  });

  it('keeps owner-only access, system prompt and session input identical with the enrollment port', async () => {
    const ipc = createRequire(import.meta.url)('@jungjaehoon/mama-core/client/ipc');
    vi.spyOn(ipc, 'createActionIpcServer').mockResolvedValue({ close: async () => {} });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const snapshots: unknown[] = [];
    try {
      for (const enrollment of [false, true]) {
        const f = await fixture();
        let input = '';
        let system = '';
        const runtime = await createOwnerRuntime({
          backend: 'codex',
          model: 'fixture',
          runtimeRoot: f.home,
          workspaceDir: join(f.home, 'workspace'),
          rawPath: join(f.home, 'raw'),
          databasePath: join(f.home, 'state.db'),
          socketPath: join(f.home, 'runtime.sock'),
          credentialPath: join(f.home, 'runtime', 'credential'),
          memberRoot: f.root,
          ...(enrollment
            ? {
                memberEnrollment: {
                  ownerUserIds: [ownerId],
                  requestSelection: (ref: string) => f.gateway.requestMemberEnrollment(ref),
                },
              }
            : {}),
          ownerPrincipalId: 'owner',
          agentId: 'owner-agent',
          scopes: [],
          timeZone: createTimeZoneSetting('UTC'),
          maxTurns: 5,
          timeout: 1000,
          lessons: async () => [],
          embedder: { embed: async () => new Float32Array(1024).fill(0.25) },
          createSession: (options) => {
            system = options.ownerSystemPrompt ?? '';
            return {
              stop: async () => {},
              runTurn: async (_content, request) => {
                const prepared = await request?.prepareSessionContent?.({
                  sessionId: 'fixture-session',
                  isNewSession: true,
                });
                input =
                  prepared?.map((block) => ('text' in block ? block.text : '')).join('\n') ?? '';
                return { response: 'fixture', modelRunId: null } as never;
              },
            } as never;
          },
        });
        cleanup.push(() => runtime.stop());
        expect(runtime.surface.ownerAccess.actions).toContain('manage.member.enroll');
        runtime.intake.acceptOwnerMessage({
          id: f.sourceRef,
          channelKey: ownerId,
          occurredAt: 1,
          text: 'fixture owner request',
        });
        await vi.waitFor(() => expect(input).toContain('fixture owner request'));
        snapshots.push({
          access: JSON.parse(JSON.stringify(runtime.surface.ownerAccess)),
          system,
          input,
        });
        await runtime.stop();
      }
      expect(snapshots[1]).toEqual(snapshots[0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('boots after enrollment and serves the member without altering owner access', async () => {
    const f = await fixture();
    expect(await f.request()).toMatchObject({ data: { status: 'pending' } });
    await f.share(f.requestId());
    expect(f.completions.at(-1)).toMatchObject({
      status: 'completed',
      data: { status: 'created' },
    });
    const member = f.repo.resolveByExternal('telegram', 'private', selectedId)!;
    const ipc = createRequire(import.meta.url)('@jungjaehoon/mama-core/client/ipc');
    vi.spyOn(ipc, 'createActionIpcServer').mockResolvedValue({ close: async () => {} });
    const created: string[] = [];
    const options: OwnerRuntimeOptions = {
      backend: 'codex',
      model: 'fixture',
      runtimeRoot: f.home,
      workspaceDir: join(f.home, 'workspace'),
      rawPath: join(f.home, 'raw'),
      databasePath: join(f.home, 'state.db'),
      socketPath: join(f.home, 'runtime.sock'),
      credentialPath: join(f.home, 'runtime', 'credential'),
      memberRoot: f.root,
      ownerPrincipalId: 'owner',
      agentId: 'owner-agent',
      timeZone: createTimeZoneSetting('UTC'),
      scopes: [],
      maxTurns: 5,
      timeout: 1000,
      embedder: { embed: async () => new Float32Array(1024).fill(0.25) },
      createSession: (input) => {
        created.push(input.principal?.principalId ?? 'owner');
        return { stop: async () => {} } as never;
      },
    };
    const runtime = await createOwnerRuntime(options);
    cleanup.push(() => runtime.stop());
    expect(created).toContain(member.principalId);
    expect(runtime.serveMember(member.principalId)).toBeDefined();
    const normalize = (access: typeof f.surface.ownerAccess) => ({
      ...access,
      actions: access.actions.filter((name) => name !== 'manage.member.enroll'),
    });
    expect(normalize(runtime.surface.ownerAccess)).toEqual(normalize(f.surface.ownerAccess));
  });
});
