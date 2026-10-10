import { createRequire, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createPrincipalRepository,
  type ActionResult,
  type JudgmentAccess,
} from '@jungjaehoon/mama-core';
import type { ActionIpcServerOptions } from '@jungjaehoon/mama-core/client/ipc';
import type { IModelRunner } from '@jungjaehoon/mama-core/runtime/drivers/types';
import { SessionPool } from '@jungjaehoon/mama-core/runtime/session-pool';
import { createOwnerRuntime } from '../../src/runtime/owner-runtime.js';
import { createNativeSession } from '../../src/runtime/native-session.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';
import {
  memberPaths,
  memberClaudeTmpDir,
  otherMemberReadPaths,
} from '../../src/runtime/member-paths.js';

const ipc = createRequire(import.meta.url)('@jungjaehoon/mama-core/client/ipc');
const close: Array<() => Promise<void>> = [];
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const stop of close.splice(0).reverse()) await stop();
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
  vi.unstubAllEnvs();
});

async function fixture(backend: 'codex' | 'claude' = 'codex', withMembers = true) {
  // Only the unavailable socket listener is replaced; dispatcher, sessions and stores are real.
  vi.spyOn(ipc, 'createActionIpcServer').mockImplementation(async (_: ActionIpcServerOptions) => ({
    close: async () => {},
  }));
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'lifecycle-home-')));
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'lifecycle-members-')));
  roots.push(home, root);
  vi.stubEnv('HOME', home);
  vi.stubEnv('MAMA_DB_PATH', join(home, 'state.db'));
  // Fixture records need no vector: partition reads and session resets use real storage/actions.
  vi.stubEnv('MAMA_FORCE_TIER_3', 'true');
  const seed = await openCoreDatabase({ path: join(home, 'state.db') });
  const repo = createPrincipalRepository(seed.adapter);
  repo.ensureOwner({
    principalId: 'owner',
    connector: 'telegram',
    namespace: 'private',
    externalId: 'fixture-owner',
    now: 1,
  });
  repo.bindIdentity('owner', 'telegram', 'private', 'fixture-co-owner', 2);
  const member = withMembers
    ? repo.registerMember({
        connector: 'telegram',
        namespace: 'private',
        externalId: 'fixture-member',
        now: 3,
      })
    : 'unused-member';
  await seed.close();
  const pool = new SessionPool();
  const natives = new Map<string, ReturnType<typeof createNativeSession>>();
  const turns: Array<{
    principal: string;
    session: string;
    fresh: boolean;
    prompt: string;
    standing: string;
    access: JudgmentAccess;
  }> = [];
  const stopped: string[] = [];
  let pendingAction: { action: string; input: unknown } | undefined;
  let actionResult: ActionResult | undefined;
  let gate: Promise<void> | undefined;
  let memberGate: Promise<void> | undefined;
  let readIds: string[] = [];
  const reads: ActionResult[][] = [];
  let sequence = 0;
  const runtime = await createOwnerRuntime({
    backend,
    model: 'fixture',
    databasePath: join(home, 'state.db'),
    rawPath: join(home, 'raw'),
    socketPath: join(home, 'socket'),
    credentialPath: join(home, 'runtime', 'credential'),
    runtimeRoot: home,
    workspaceDir: join(home, 'workspace'),
    memberRoot: root,
    ownerPrincipalId: 'owner',
    agentId: 'owner-agent',
    scopes: [],
    connectors: [],
    timeZone: createTimeZoneSetting('UTC'),
    timeout: 1_000,
    maxTurns: 10,
    embedder: { embed: async () => new Float32Array(1024).fill(0.25) },
    ownerPolicyProvider: () => ({
      content: 'FIXTURE_OWNER_POLICY',
      fingerprint: 'fixture',
      loaded: true,
    }),
    memberEnrollment: {
      ownerUserIds: ['fixture-owner', 'fixture-co-owner'],
      requestSelection: async () => {},
    },
    createSession: (options) => {
      const principal = options.principal?.principalId ?? 'owner';
      let session: string | undefined;
      let fresh = true;
      const model: IModelRunner = {
        backendType: backend,
        reportsModelRuns: true,
        supportsNativeSubagents: true,
        prompt: async (content, callbacks, opts) => {
          session ??= `fixture-session-${++sequence}`;
          callbacks?.onInputDispatch?.({
            backend,
            sessionId: session,
            inputId: opts?.nativeInputId ?? 'fixture-input',
          });
          callbacks?.onAccepted?.(
            backend === 'codex'
              ? { backend, sessionId: session, turnId: `fixture-turn-${sequence}` }
              : { backend, sessionId: session, inputId: opts?.nativeInputId ?? 'fixture-input' }
          );
          const prepared = await opts?.preparePrompt?.({ sessionId: session, isNewSession: fresh });
          turns.push({
            principal,
            session,
            fresh,
            prompt: JSON.stringify(prepared ?? content),
            standing: opts?.systemPrompt ?? '',
            access: (opts?.toolExecutionContext as { access: JudgmentAccess }).access,
          });
          fresh = false;
          if (principal === 'owner' && gate) await gate;
          if (principal !== 'owner' && memberGate) await memberGate;
          const call = async (action: string, input: unknown): Promise<ActionResult> => {
            const operationId = `fixture-call-${++sequence}`;
            if (backend === 'codex') {
              const result = await opts!.hostToolBridge!.execute({
                callId: operationId,
                name: action,
                input,
              });
              const parsed = JSON.parse(result.content);
              return parsed.success ? { status: 'completed', data: parsed.data } : parsed;
            }
            return natives
              .get(principal)!
              .callAction(
                { action, input, operationId },
                { session_id: session!, tool_use_id: operationId }
              );
          };
          if (principal === 'owner' && pendingAction) {
            const action = pendingAction;
            pendingAction = undefined;
            actionResult = await call(action.action, action.input);
          } else if (principal !== 'owner') {
            reads.push(
              await Promise.all(readIds.map((id) => call('memory.read:record', { memory_id: id })))
            );
          }
          return {
            response: 'fixture answer',
            session_id: session,
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
        resetSession: async () => {
          session = undefined;
          fresh = true;
        },
        setSessionId: () => {},
        setSystemPrompt: () => {},
        isHealthy: () => true,
        getMetrics: () => ({
          requestCount: 0,
          failureCount: 0,
          avgLatencyMs: 0,
          lastRequestAt: null,
        }),
        stop: async () => {
          stopped.push(principal);
        },
      };
      const native = createNativeSession({
        ...options,
        sessionPool: pool,
        createAgent: () => model,
      });
      natives.set(principal, native);
      return native;
    },
  });
  close.push(async () => {
    await runtime.stop();
    pool.dispose();
  });
  const message = (principal: string, text = 'fixture input') => {
    const id = `telegram:fixture:message-${++sequence}`;
    (principal === 'owner' ? runtime.intake : runtime.serveMember(principal)).acceptOwnerMessage({
      id,
      channelKey: 'fixture',
      occurredAt: sequence,
      text,
    });
    return id;
  };
  const settled = async (id: string, principal = 'owner') => {
    await vi.waitFor(() =>
      expect(runtime.runtime.mailbox!.readInput(id, principal)?.status).toBe('acked')
    );
  };
  const manage = async (change: string, input: unknown = { principalId: member }) => {
    actionResult = undefined;
    pendingAction = { action: `manage.member.${change}`, input };
    const id = message('owner');
    await settled(id);
    expect(actionResult).toBeDefined();
    return actionResult!;
  };
  return {
    runtime,
    member,
    home,
    root,
    turns,
    stopped,
    reads,
    message,
    settled,
    manage,
    blockOwner: (promise: Promise<void> | undefined) => {
      gate = promise;
    },
    blockMember: (promise: Promise<void> | undefined) => {
      memberGate = promise;
    },
    read: (ids: string[]) => {
      readIds = ids;
    },
  };
}

const partition = (principalId: string, scopeId = 'fixture-partition') => ({
  principalId,
  scopeKind: 'project',
  scopeId,
});
const data = (result: ActionResult) => {
  expect(result.status, JSON.stringify(result)).toBe('completed');
  return (result as { data: Record<string, unknown> }).data;
};

it.each(['codex', 'claude'] as const)(
  'grants real partition reads, revokes in a fresh session and keeps other grants, personal context and files (%s)',
  async (backend) => {
    const f = await fixture(backend);
    data(await f.manage('grant', partition(f.member, 'fixture-other')));
    const save = async (scope: { kind: 'project' | 'user'; id: string }, summary: string) => {
      const result = await f.runtime.surface.hostToolCall(
        'memory.save',
        {
          topic: summary,
          kind: 'decision',
          summary,
          details: summary,
          scopes: [scope],
          source: { package: 'fixture', source_type: 'test' },
        },
        `save-${summary}`,
        {
          access:
            scope.kind === 'user'
              ? {
                  ...f.runtime.surface.ownerAccess,
                  principalId: f.member,
                  scopes: [scope],
                  defaultScopes: [scope],
                }
              : f.runtime.surface.ownerAccess,
        }
      );
      return data(result).id as string;
    };
    data(await f.manage('grant', partition(f.member)));
    const ids = await Promise.all([
      save({ kind: 'project', id: 'fixture-partition' }, 'PARTITION_RECORD'),
      save({ kind: 'project', id: 'fixture-other' }, 'OTHER_RECORD'),
      save({ kind: 'user', id: f.member }, 'PERSONAL_RECORD'),
    ]);
    f.read(ids);
    const personalMessage = f.message(f.member, 'PERSONAL_CHAT');
    await f.settled(personalMessage, f.member);
    f.runtime.serveMember(f.member).recordOwnerReply({
      messageRef: personalMessage,
      text: 'PERSONAL_ANSWER',
      occurredAt: Date.now(),
      deliveryVerified: true,
      author: 'agent',
    });
    expect(f.reads[0].map((r) => Boolean(data(r).record))).toEqual([true, true, true]);
    const before = f.turns.at(-1)!;
    const file = join(memberPaths(f.root, f.member).workspaceDir, 'copy.txt');
    fs.writeFileSync(file, 'fixture copy');
    const receipt = data(await f.manage('revoke', partition(f.member)));
    expect(receipt).toMatchObject({
      principalId: f.member,
      change: 'revoke',
      sessionReset: true,
      cancelledInputs: 0,
    });
    await f.settled(f.message(f.member), f.member);
    expect(f.reads[1].map((r) => Boolean(data(r).record))).toEqual([false, true, true]);
    const after = f.turns.at(-1)!;
    expect(after.session).not.toBe(before.session);
    expect(after.fresh).toBe(true);
    expect(after.access.scopes).toEqual([{ kind: 'user', id: f.member }]);
    expect(after.access.readScopes).toEqual([{ kind: 'project', id: 'fixture-other' }]);
    expect(after.prompt).toContain('PERSONAL_RECORD');
    expect(after.prompt).toContain('PERSONAL_CHAT');
    expect(fs.readFileSync(file, 'utf8')).toBe('fixture copy');
    const session = after.session;
    data(await f.manage('grant', partition(f.member)));
    await f.settled(f.message(f.member), f.member);
    expect(f.turns.at(-1)!.session).not.toBe(session);
  }
);

it('suspends and resumes with preserved grants in fresh directories, then offboards terminally without unbinding identity', async () => {
  const f = await fixture();
  data(await f.manage('grant', partition(f.member)));
  const intake = f.runtime.serveMember(f.member);
  await f.settled(f.message(f.member), f.member);
  const paths = memberPaths(f.root, f.member);
  const temp = memberClaudeTmpDir(f.member);
  roots.push(temp);
  fs.mkdirSync(temp, { recursive: true });
  fs.writeFileSync(join(paths.workspaceDir, 'old.txt'), 'old workspace');
  fs.writeFileSync(join(temp, 'old.txt'), 'old temp');
  const receipt = data(await f.manage('suspend'));
  expect(receipt).toMatchObject({
    principalId: f.member,
    change: 'suspend',
    sessionEnded: true,
    setAside: true,
    cancelledInputs: 0,
  });
  expect(f.stopped).toContain(f.member);
  expect(f.runtime.runtime.servesPrincipal(f.member)).toBe(false);
  expect(fs.existsSync(paths.runtimeRoot)).toBe(false);
  expect(fs.existsSync(temp)).toBe(false);
  const archives = fs.readdirSync(f.root).filter((name) => name !== f.member);
  expect(
    archives.some((name) => fs.existsSync(join(f.root, name, 'runtime', 'workspace', 'old.txt')))
  ).toBe(true);
  // The temp archive stays beside the temp dir, so the move never crosses filesystems.
  const tempArchives = fs
    .readdirSync(dirname(temp))
    .filter((name) => name.startsWith(`.retired-${basename(temp)}-`))
    .map((name) => join(dirname(temp), name));
  for (const archive of tempArchives) roots.push(archive);
  expect(tempArchives.some((path) => fs.existsSync(join(path, 'old.txt')))).toBe(true);
  const deniedPaths = otherMemberReadPaths(f.root, f.member, [f.member]);
  expect(deniedPaths).toEqual(
    expect.arrayContaining([
      ...archives.map((name) => join(f.root, name)),
      ...tempArchives.map((path) => fs.realpathSync(path)),
    ])
  );
  const count = f.runtime.database.adapter
    .prepare('SELECT count(*) AS n FROM connector_event_index')
    .get();
  expect(() =>
    intake.acceptOwnerMessage({
      id: 'refused-suspended',
      channelKey: 'fixture',
      occurredAt: 30,
      text: 'refused',
    })
  ).toThrow(/suspended|served/);
  expect(
    f.runtime.database.adapter.prepare('SELECT count(*) AS n FROM connector_event_index').get()
  ).toEqual(count);
  expect(data(await f.manage('list', {})).members).toEqual([
    {
      principalId: f.member,
      status: 'suspended',
      grants: [{ kind: 'memory', scopeKind: 'project', scopeId: 'fixture-partition' }],
    },
  ]);
  data(await f.manage('resume'));
  expect(f.runtime.runtime.servesPrincipal(f.member)).toBe(true);
  expect(fs.existsSync(join(paths.workspaceDir, 'old.txt'))).toBe(false);
  await f.settled(f.message(f.member), f.member);
  expect(f.turns.at(-1)!.fresh).toBe(true);
  expect(f.turns.at(-1)!.access.readScopes).toEqual([{ kind: 'project', id: 'fixture-partition' }]);
  // Offboard must also revoke retained source grants, although P8 offers no source grant action.
  const repo = createPrincipalRepository(f.runtime.database.adapter);
  repo.grantScope({
    targetPrincipalId: f.member,
    ownerPrincipalId: 'owner',
    scope: { kind: 'source', connector: 'fixture', channelId: 'fixture-source' },
    now: 40,
  });
  data(await f.manage('offboard'));
  expect(repo.findById(f.member)?.status).toBe('offboarded');
  expect(
    f.runtime.database.adapter
      .prepare(
        'SELECT count(*) AS n FROM principal_scope_grants WHERE principal_id=? AND revoked_at IS NULL'
      )
      .get(f.member)
  ).toEqual({ n: 0 });
  expect(repo.resolveByExternal('telegram', 'private', 'fixture-member')?.principalId).toBe(
    f.member
  );
  expect(() => f.runtime.serveMember(f.member)).toThrow(/offboarded/);
  const ref = f.message('owner');
  await f.settled(ref);
  const enrollment = await f.runtime.completeMemberEnrollment({
    sourceMessageRef: ref,
    ownerUserId: 'fixture-owner',
    userId: 'fixture-member',
  });
  expect(data(enrollment)).toMatchObject({ status: 'refused', principalId: f.member });
});

it.each(['grant', 'revoke', 'suspend', 'resume', 'offboard'])(
  'cancels pending and claimed member inputs with a host reason at %s',
  async (change) => {
    const f = await fixture();
    data(await f.manage('grant', partition(f.member)));
    if (change === 'resume') data(await f.manage('suspend'));
    let release!: () => void;
    f.blockOwner(
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    const before = f.turns.length;
    const action = f.manage(
      change,
      change === 'grant' || change === 'revoke'
        ? partition(f.member, change === 'grant' ? 'fixture-new' : 'fixture-partition')
        : { principalId: f.member }
    );
    await vi.waitFor(() => expect(f.turns).toHaveLength(before + 1));
    const mailbox = f.runtime.runtime.mailbox!;
    mailbox.enqueue({
      id: 'queued-claimed',
      kind: 'owner_message',
      principalId: f.member,
      channelKey: 'fixture',
      occurredAt: 50,
      refs: [],
      payload: { text: 'queued' },
    });
    mailbox.claimNext();
    mailbox.enqueue({
      id: 'queued-pending',
      kind: 'owner_message',
      principalId: f.member,
      channelKey: 'fixture',
      occurredAt: 51,
      refs: [],
      payload: { text: 'queued' },
    });
    try {
      release();
      expect(data(await action).cancelledInputs).toBe(2);
      for (const id of ['queued-claimed', 'queued-pending']) {
        const row = mailbox.readInput(id, f.member)!;
        expect(row.status).toBe('dead');
        expect(
          f.runtime.database.adapter
            .prepare('SELECT last_error FROM mailbox_inputs WHERE id=?')
            .get(row.id)
        ).toEqual({ last_error: `member_${change}` });
      }
      expect(f.turns.filter((turn) => turn.principal === f.member)).toHaveLength(0);
    } finally {
      release();
    }
  }
);

it('waits for an executing member, then prevents already waiting native deliveries after revoke', async () => {
  const f = await fixture();
  data(await f.manage('grant', partition(f.member)));
  let release!: () => void;
  f.blockMember(
    new Promise<void>((resolve) => {
      release = resolve;
    })
  );
  const running = f.message(f.member);
  await vi.waitFor(() => expect(f.turns.at(-1)?.principal).toBe(f.member));
  const action = f.manage('revoke', partition(f.member));
  const queued = f.message(f.member);
  await vi.waitFor(() =>
    expect(f.runtime.runtime.mailbox!.readInput(queued, f.member)?.status).toBe('claimed')
  );
  try {
    expect(
      createPrincipalRepository(f.runtime.database.adapter).listActiveGrants(f.member)
    ).toHaveLength(1);
    release();
    expect(data(await action).cancelledInputs).toBe(1);
    await f.settled(running, f.member);
    await vi.waitFor(() =>
      expect(f.runtime.runtime.mailbox!.readInput(queued, f.member)?.status).toBe('dead')
    );
    expect(f.turns.filter((turn) => turn.principal === f.member)).toHaveLength(1);
    expect(
      f.runtime.database.adapter
        .prepare('SELECT last_error FROM mailbox_inputs WHERE stimulus_id=?')
        .get(queued)
    ).toEqual({ last_error: 'member_revoke' });
  } finally {
    release();
  }
});

it('rejects owner/co-owner and unknown targets, invalid grants and illegal transitions without mutations', async () => {
  const f = await fixture();
  for (const principalId of ['owner', 'unknown']) {
    for (const action of ['grant', 'revoke', 'suspend', 'resume', 'offboard']) {
      expect(
        (
          await f.manage(
            action,
            action === 'grant' || action === 'revoke' ? partition(principalId) : { principalId }
          )
        ).status
      ).toBe('failed');
    }
  }
  const before = JSON.stringify(f.runtime.surface.ownerAccess);
  expect((await f.manage('grant', partition(f.member, 'system'))).status).toBe('completed'); // project:system is not global:system
  for (const input of [
    { ...partition(f.member), scopeKind: 'source' },
    partition(f.member, ' '),
    { ...partition(f.member), connector: 'fixture' },
  ]) {
    const r = await f.manage('grant', input);
    expect(r.status).toBe('failed');
  }
  expect((await f.manage('resume')).status).toBe('failed');
  data(await f.manage('offboard'));
  for (const action of ['suspend', 'resume', 'grant'])
    expect(
      (await f.manage(action, action === 'grant' ? partition(f.member) : { principalId: f.member }))
        .status
    ).toBe('failed');
  expect(createPrincipalRepository(f.runtime.database.adapter).findById('owner')).toEqual({
    principalId: 'owner',
    kind: 'owner',
    status: 'active',
  });
  expect(JSON.parse(before).defaultScopes).toEqual(f.runtime.surface.ownerAccess.defaultScopes);
});

it('rolls an owner-default overlap grant back before it can break the next turn or boot', async () => {
  const f = await fixture();
  // Same configured connector partition that resolvePrincipalAccess refuses.
  f.runtime.surface.ownerAccess.defaultScopes!.push({ kind: 'project', id: 'fixture-default' });
  const result = await f.manage('grant', partition(f.member, 'fixture-default'));
  expect(result.status).toBe('failed');
  expect((result as { error: { message: string } }).error.message).toContain(
    'overlaps owner default'
  );
  expect(createPrincipalRepository(f.runtime.database.adapter).listActiveGrants(f.member)).toEqual(
    []
  );
  await f.settled(f.message(f.member), f.member);
});

it.each(['delta', 'scheduled', 'report', 'replay', 'member', 'subagent'])(
  'denies every management action from %s with no change',
  async (origin) => {
    const f = await fixture();
    const mailbox = f.runtime.runtime.mailbox!;
    mailbox.enqueue({
      id: 'fixture-owner-ref',
      principalId: 'owner',
      kind: 'owner_message',
      channelKey: 'fixture',
      occurredAt: 1,
      refs: [],
    });
    mailbox.enqueue({
      id: 'fixture-other-ref',
      principalId: 'owner',
      kind: origin === 'delta' ? 'source_delta' : 'scheduled',
      channelKey: 'fixture',
      occurredAt: 2,
      refs: [],
    });
    const access =
      origin === 'member'
        ? { ...f.runtime.surface.ownerAccess, principalId: f.member }
        : f.runtime.surface.ownerAccess;
    const session = {
      sourceMessageRef:
        origin === 'member' || origin === 'replay'
          ? 'fixture-owner-ref'
          : origin === 'subagent'
            ? 'subagent:fixture'
            : 'fixture-other-ref',
      ...(origin === 'replay' ? { replaySourceEndMs: 10 } : {}),
    };
    for (const action of ['grant', 'revoke', 'suspend', 'resume', 'offboard', 'list']) {
      const result = await f.runtime.surface.dispatch(
        {
          action: `manage.member.${action}`,
          input:
            action === 'list'
              ? {}
              : action === 'grant' || action === 'revoke'
                ? partition(f.member)
                : { principalId: f.member },
        },
        { access, session }
      );
      expect(result).toMatchObject({ status: 'failed', error: { kind: 'denied', code: 'denied' } });
    }
    expect(createPrincipalRepository(f.runtime.database.adapter).findById(f.member)?.status).toBe(
      'active'
    );
    expect(
      createPrincipalRepository(f.runtime.database.adapter).listActiveGrants(f.member)
    ).toEqual([]);
    expect(fs.existsSync(memberPaths(f.root, f.member).credentialPath)).toBe(true);
  }
);

it('keeps resume suspended after a crash between runtime and temp moves, and retry completes from fresh paths', async () => {
  const f = await fixture();
  data(await f.manage('suspend'));
  const paths = memberPaths(f.root, f.member);
  const temp = memberClaudeTmpDir(f.member);
  roots.push(temp);
  fs.mkdirSync(paths.runtimeRoot, { recursive: true });
  fs.mkdirSync(temp, { recursive: true });
  fs.writeFileSync(join(paths.runtimeRoot, 'stale.txt'), 'stale runtime');
  fs.writeFileSync(join(temp, 'stale.txt'), 'stale temp');
  const rename = fs.renameSync;
  const crash = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (from === temp) throw new Error('fixture crash after runtime move');
    rename(from, to);
  });
  syncBuiltinESMExports();
  expect((await f.manage('resume')).status).toBe('failed');
  expect(createPrincipalRepository(f.runtime.database.adapter).findById(f.member)?.status).toBe(
    'suspended'
  );
  expect(f.runtime.runtime.servesPrincipal(f.member)).toBe(false);
  expect(fs.existsSync(paths.runtimeRoot)).toBe(false);
  expect(fs.existsSync(temp)).toBe(true);
  crash.mockRestore();
  syncBuiltinESMExports();
  data(await f.manage('resume'));
  expect(fs.existsSync(join(paths.runtimeRoot, 'stale.txt'))).toBe(false);
  expect(fs.existsSync(join(temp, 'stale.txt'))).toBe(false);
  await f.settled(f.message(f.member), f.member);
  expect(f.turns.at(-1)?.fresh).toBe(true);
});

it('lists only principal ids, statuses and grants, and leaves owner-only session/access input unchanged', async () => {
  const f = await fixture('codex', false);
  await f.settled(f.message('owner', 'fixture identical input'));
  const before = f.turns.at(-1)!;
  const access = JSON.stringify(before.access);
  const result = data(await f.manage('list', {}));
  expect(result).toEqual({ members: [] });
  await f.settled(f.message('owner', 'fixture identical input'));
  expect(f.turns.at(-1)!.session).toBe(before.session);
  expect(f.turns.at(-1)!.access).toBe(before.access);
  expect(JSON.stringify(f.turns.at(-1)!.access)).toBe(access);
  expect(f.turns.at(-1)!.prompt).toContain('fixture identical input');
  expect(f.runtime.surface.ownerAccess.actions).toEqual(
    expect.arrayContaining([
      'manage.member.grant',
      'manage.member.revoke',
      'manage.member.suspend',
      'manage.member.resume',
      'manage.member.offboard',
      'manage.member.list',
    ])
  );
});

it('lists retained source-channel grants without revealing their transport identifiers', async () => {
  const f = await fixture();
  const repo = createPrincipalRepository(f.runtime.database.adapter);
  repo.grantScope({
    targetPrincipalId: f.member,
    ownerPrincipalId: 'owner',
    scope: { kind: 'source', connector: 'chat', channelId: 'telegram:fixture-private-channel' },
    now: 4,
  });
  const result = data(await f.manage('list', {}));
  expect(result.members).toEqual([
    { principalId: f.member, status: 'active', grants: [{ kind: 'source', connector: 'chat' }] },
  ]);
  expect(JSON.stringify(result)).not.toContain('fixture-private-channel');
  expect(JSON.stringify(result)).not.toContain('fixture-member');
});

it('retries terminal offboard cleanup after runtime move succeeds and temp move fails', async () => {
  const f = await fixture();
  data(await f.manage('grant', partition(f.member)));
  const paths = memberPaths(f.root, f.member);
  const temp = memberClaudeTmpDir(f.member);
  roots.push(temp);
  fs.mkdirSync(temp, { recursive: true });
  fs.writeFileSync(join(temp, 'remaining.txt'), 'fixture temp');
  const rename = fs.renameSync;
  const crash = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (from === temp) throw new Error('fixture offboard crash after runtime move');
    rename(from, to);
  });
  syncBuiltinESMExports();
  expect((await f.manage('offboard')).status).toBe('failed');
  const repo = createPrincipalRepository(f.runtime.database.adapter);
  expect(repo.findById(f.member)?.status).toBe('offboarded');
  expect(repo.listRetainedGrants(f.member)).toEqual([]);
  expect(f.runtime.runtime.servesPrincipal(f.member)).toBe(false);
  expect(fs.existsSync(paths.runtimeRoot)).toBe(false);
  expect(fs.existsSync(temp)).toBe(true);
  crash.mockRestore();
  syncBuiltinESMExports();
  expect(data(await f.manage('offboard'))).toMatchObject({
    principalId: f.member,
    status: 'offboarded',
    sessionEnded: true,
    setAside: true,
  });
  expect(fs.existsSync(temp)).toBe(false);
  expect(repo.resolveByExternal('telegram', 'private', 'fixture-member')?.status).toBe(
    'offboarded'
  );
  expect(() => f.runtime.serveMember(f.member)).toThrow(/offboarded/);
  expect((await f.manage('resume')).status).toBe('failed');
});
