import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createPrincipalRepository } from '@jungjaehoon/mama-core';
import type { JudgmentAccess } from '@jungjaehoon/mama-core';
import type { ActionIpcServerOptions } from '@jungjaehoon/mama-core/client/ipc';
import type { IModelRunner } from '@jungjaehoon/mama-core/runtime/drivers/types';
import { SessionPool } from '@jungjaehoon/mama-core/runtime/session-pool';
import { createOwnerRuntime, type OwnerRuntimeOptions } from '../../src/runtime/owner-runtime.js';
import {
  createNativeSession,
  type NativeSessionOptions,
  type NativeDriverOptions,
} from '../../src/runtime/native-session.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';
import { memberPaths } from '../../src/runtime/member-paths.js';

// Only the unavailable socket transport is replaced. Core intake, credentials, mailbox,
// native runner, records, model_runs and traces stay real.
const ipc = createRequire(import.meta.url)('@jungjaehoon/mama-core/client/ipc');
const roots: string[] = [];
let socket: ActionIpcServerOptions;
beforeEach(() => {
  vi.spyOn(ipc, 'createActionIpcServer').mockImplementation(
    async (options: ActionIpcServerOptions) => {
      socket = options;
      return { close: async () => {} };
    }
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

async function fixture(backend: 'codex' | 'claude' = 'codex', withRoot = true) {
  const home = mkdtempSync('/private/tmp/fixture-owner-');
  roots.push(home);
  vi.stubEnv('HOME', home);
  const root = mkdtempSync('/private/tmp/fixture-members-');
  roots.push(root);
  const db = await openCoreDatabase({ path: join(home, 'state.db') });
  const repo = createPrincipalRepository(db.adapter);
  repo.ensureOwner({
    principalId: 'owner',
    connector: 'telegram',
    namespace: 'private',
    externalId: 'fixture-owner',
    now: 1,
  });
  const member = repo.registerMember({
    connector: 'telegram',
    namespace: 'private',
    externalId: 'fixture-member',
    now: 2,
  });
  const inactive = repo.registerMember({
    connector: 'telegram',
    namespace: 'private',
    externalId: 'fixture-inactive',
    now: 3,
  });
  db.adapter
    .prepare("UPDATE principals SET status = 'suspended' WHERE principal_id = ?")
    .run(inactive);
  await db.close();
  const turns: Array<{
    principal: string;
    prompt: string;
    standing: string;
    key: string;
    context?: unknown;
  }> = [];
  const drivers = new Map<string, NativeDriverOptions>();
  const natives = new Map<string, ReturnType<typeof createNativeSession>>();
  const pool = new SessionPool();
  const stopped: string[] = [];
  let failMember = false;
  let ownerGate: Promise<void> | undefined;
  const options: OwnerRuntimeOptions = {
    backend,
    model: 'fixture',
    rawPath: join(home, 'raw'),
    databasePath: join(home, 'state.db'),
    socketPath: join(home, 'runtime.sock'),
    credentialPath: join(home, 'runtime', 'session-credential'),
    runtimeRoot: home,
    workspaceDir: join(home, 'workspace'),
    timeZone: createTimeZoneSetting('UTC'),
    ownerPrincipalId: 'owner',
    agentId: 'owner-agent',
    scopes: [],
    maxTurns: 10,
    timeout: 1_000,
    embedder: { embed: async () => new Float32Array(1024).fill(0.25) },
    ownerPolicyProvider: () => ({
      content: 'OWNER_POLICY_SENTINEL',
      fingerprint: 'fixture-policy',
      loaded: true,
    }),
    ...(withRoot ? { memberRoot: root } : {}),
    createSession: (nativeOptions: NativeSessionOptions) => {
      const principal = nativeOptions.principal?.principalId ?? 'owner';
      const started = new Set<string>();
      const model: IModelRunner = {
        backendType: backend,
        reportsModelRuns: true,
        supportsNativeSubagents: true,
        prompt: async (content, callbacks, opts) => {
          if (principal !== 'owner' && failMember)
            throw new Error('Not logged in · fixture backend');
          const sessionId = `fixture-session:${principal}:${turns.length}`;
          callbacks?.onInputDispatch?.({
            backend,
            sessionId,
            inputId: opts?.nativeInputId ?? 'fixture-input',
          });
          callbacks?.onAccepted?.(
            backend === 'codex'
              ? { backend, sessionId, turnId: `fixture-turn:${turns.length}` }
              : { backend, sessionId, inputId: opts?.nativeInputId ?? 'fixture-input' }
          );
          const prepared = await opts?.preparePrompt?.({
            sessionId,
            isNewSession: !started.has(opts.sessionKey!),
          });
          started.add(opts?.sessionKey ?? '');
          turns.push({
            principal,
            prompt: JSON.stringify(prepared ?? content),
            standing: opts?.systemPrompt ?? '',
            key: opts?.sessionKey ?? '',
            context: opts?.toolExecutionContext,
          });
          if (principal === 'owner' && ownerGate) await ownerGate;
          if (backend === 'codex') {
            await opts?.hostToolBridge?.execute({
              callId: `fixture-call:${turns.length}`,
              name: 'memory.checkpoint.list',
              input: { limit: 1 },
            });
          } else {
            await natives.get(principal)!.callAction(
              {
                action: 'memory.checkpoint.list',
                input: { limit: 1 },
                operationId: `fixture-call:${turns.length}`,
              },
              { session_id: sessionId, tool_use_id: `fixture-call:${turns.length}` }
            );
          }
          return {
            response: 'fixture answer',
            session_id: sessionId,
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
        resetSession: async (_id, key) => {
          started.delete(key!);
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
        ...nativeOptions,
        sessionPool: pool,
        createAgent: (driver) => {
          drivers.set(principal, driver);
          return model;
        },
      });
      natives.set(principal, native);
      return native;
    },
  };
  return {
    home,
    root,
    member,
    inactive,
    options,
    turns,
    drivers,
    natives,
    pool,
    stopped,
    blockOwner: (gate: Promise<void>) => {
      ownerGate = gate;
    },
    fail: () => {
      failMember = true;
    },
  };
}

it.each(['codex', 'claude'] as const)(
  'serves active members with separate turns, personal starts and run/trace attribution (%s)',
  async (backend) => {
    const f = await fixture(backend);
    const runtime = await createOwnerRuntime(f.options);
    try {
      expect(runtime.runtime.servesPrincipal(f.member)).toBe(true);
      expect(runtime.runtime.servesPrincipal(f.inactive)).toBe(false);
      expect(() => runtime.serveMember(f.inactive)).toThrow(/active|suspended/);
      const memberIntake = runtime.serveMember(f.member);
      const memberAccess = () =>
        socket.resolveAccess(
          readFileSync(memberPaths(f.root, f.member).credentialPath, 'utf8').trim()
        );
      const save = async (access: JudgmentAccess, label: string) => {
        const result = await runtime.surface.hostToolCall(
          'memory.save',
          {
            topic: label,
            kind: 'decision',
            summary: label,
            details: label,
            source: { package: 'standalone', source_type: 'test' },
          },
          `fixture-save:${label}`,
          { access }
        );
        expect(result.status).toBe('completed');
      };
      await save(runtime.surface.ownerAccess, 'OWNER_RECORD_SENTINEL');
      await save(memberAccess(), 'MEMBER_RECORD_SENTINEL');
      for (const [access, summary] of [
        [runtime.surface.ownerAccess, 'OWNER_CHECKPOINT_SENTINEL'],
        [memberAccess(), 'MEMBER_CHECKPOINT_SENTINEL'],
      ] as const) {
        expect(
          (
            await runtime.surface.hostToolCall(
              'memory.checkpoint.save',
              { summary, next_steps: summary },
              `fixture-checkpoint:${summary}`,
              { access }
            )
          ).status
        ).toBe('completed');
      }
      for (const [intake, principal, label] of [
        [runtime.intake, 'owner', 'OWNER_EXCHANGE_SENTINEL'],
        [memberIntake, f.member, 'MEMBER_EXCHANGE_SENTINEL'],
      ] as const) {
        intake.acceptOwnerMessage({
          id: `telegram:${principal}:history`,
          channelKey: `fixture:${principal}`,
          occurredAt: 1,
          text: label,
        });
        intake.recordOwnerReply({
          messageRef: `telegram:${principal}:history`,
          occurredAt: 2,
          text: 'delivered fixture reply',
          deliveryVerified: true,
          author: 'agent',
        });
      }
      await vi.waitFor(() => expect(f.turns).toHaveLength(2));
      await vi.waitFor(() => {
        expect(runtime.intake.isPending!('telegram:owner:history')).toBe(false);
        expect(memberIntake.isPending!(`telegram:${f.member}:history`)).toBe(false);
      });
      await runtime.runtime.nativeSession!.resetSession!(`member:${f.member}:runtime`);
      await runtime.runtime.nativeSession!.resetSession!('owner:runtime');
      memberIntake.acceptOwnerMessage({
        id: 'telegram:fixture:member-next',
        channelKey: 'fixture:member',
        occurredAt: 3,
        text: 'member question',
      });
      runtime.intake.acceptSourceDelta({
        kind: 'source_delta',
        collector: 'fixture',
        channel: 'fixture:replay',
        coalesceKey: 'fixture-replay',
        refs: [],
        preview: [],
        replay: {
          runId: 'fixture-run',
          windowId: 'fixture-window',
          windowStartMs: 10,
          windowEndMs: 20,
        },
        occurredAt: 10,
      } as never);
      runtime.intake.acceptOwnerMessage({
        id: 'telegram:fixture:owner-next',
        channelKey: 'fixture:owner',
        occurredAt: 30,
        text: 'owner question',
      });
      await vi.waitFor(() => expect(f.turns).toHaveLength(5));
      const memberTurns = f.turns.filter((turn) => turn.principal === f.member);
      const ownerTurns = f.turns.filter((turn) => turn.principal === 'owner');
      for (const turn of memberTurns) {
        expect(turn.prompt + turn.standing).not.toMatch(/OWNER_|\[owner_message\]|owner:/);
        expect(turn.standing).toContain("this person's personal agent");
      }
      expect(memberTurns.map((turn) => turn.prompt).join()).toContain('MEMBER_CHECKPOINT_SENTINEL');
      expect(memberTurns.map((turn) => turn.prompt).join()).toContain('MEMBER_EXCHANGE_SENTINEL');
      expect(ownerTurns.map((turn) => turn.prompt).join()).toContain('OWNER_EXCHANGE_SENTINEL');
      // P6 scopes the owner's checkpoint reads (core lists them unscoped for the owner today); no
      // member turn can write one before admission (P10), which comes after P6.
      for (const turn of ownerTurns)
        expect(
          (turn.prompt + turn.standing).replaceAll('MEMBER_CHECKPOINT_SENTINEL', '')
        ).not.toContain('MEMBER_');
      const runs = runtime.database.adapter
        .prepare('SELECT agent_id, input_refs_json FROM model_runs')
        .all() as Array<{ agent_id: string; input_refs_json: string }>;
      expect(runs).toHaveLength(5);
      for (const run of runs) {
        const refs = JSON.parse(run.input_refs_json);
        expect(run.agent_id).toBe(
          refs.principalId === 'owner' ? 'owner-agent' : `member-agent:${f.member}`
        );
        expect(refs.sessionKey).toBe(
          refs.principalId === 'owner'
            ? refs.sourceMessageRef.startsWith('source_delta:')
              ? 'owner:replay'
              : 'owner:runtime'
            : `member:${f.member}:runtime`
        );
      }
      expect(
        runtime.database.adapter
          .prepare('SELECT COUNT(*) AS n FROM tool_traces WHERE model_run_id IS NOT NULL')
          .get()
      ).toMatchObject({ n: 5 });
      expect(f.drivers.get(f.member)?.processEnv.CLAUDE_CONFIG_DIR).toBe(
        memberPaths(f.root, f.member).claudeConfigDir
      );
      expect(f.drivers.get('owner')?.processEnv.CLAUDE_CONFIG_DIR).toBeUndefined();
      expect(f.drivers.get(f.member)?.cwd).not.toBe(f.drivers.get('owner')?.cwd);
      expect(f.drivers.get(f.member)?.deniedReadPaths).toContain(f.home);
      expect(f.drivers.get(f.member)?.registryRoot).toBe(
        memberPaths(f.root, f.member).registryRoot
      );
      expect(runtime.intake.isPending!('telegram:fixture:member-next')).toBe(false);
    } finally {
      await runtime.stop();
      f.pool.dispose();
    }
    expect(f.stopped.sort()).toEqual(['owner', f.member].sort());
  }
);

it('fails boot naming member_root with an active member, before starting a backend', async () => {
  const f = await fixture('codex', false);
  f.options.nativeSession = { stop: async () => {} };
  await expect(createOwnerRuntime(f.options)).rejects.toThrow('member_root');
  expect(f.natives.size).toBe(0);
  f.pool.dispose();
});

it('fails an unauthenticated member turn loudly without constructing an owner-path retry', async () => {
  const f = await fixture();
  const errors: string[] = [];
  const runtime = await createOwnerRuntime({
    ...f.options,
    onStimulusFailed: (_row, reason) => {
      errors.push(reason);
    },
  });
  try {
    f.fail();
    runtime.serveMember(f.member).acceptOwnerMessage({
      id: 'telegram:fixture:login',
      channelKey: 'fixture',
      occurredAt: 1,
      text: 'fixture request',
    });
    await vi.waitFor(() => expect(errors.join()).toContain('Not logged in'));
    expect(f.natives.size).toBe(2);
    expect(f.turns).toHaveLength(0);
    expect(f.drivers.get(f.member)?.codexHome).toBe(memberPaths(f.root, f.member).codexHome);
  } finally {
    await runtime.stop();
    f.pool.dispose();
  }
});

it('requires no root with no active members and serves a newly enrolled member only on serveMember', async () => {
  const f = await fixture('codex', false);
  const db = await openCoreDatabase({ path: f.options.databasePath });
  db.adapter.prepare("UPDATE principals SET status = 'suspended' WHERE kind = 'member'").run();
  await db.close();
  f.options.nativeSession = { stop: async () => {} };
  const withoutRoot = await createOwnerRuntime(f.options);
  expect(withoutRoot.runtime.servesPrincipal(f.member)).toBe(false);
  await withoutRoot.stop();
  f.options.memberRoot = f.root;
  const runtime = await createOwnerRuntime(f.options);
  try {
    const id = createPrincipalRepository(runtime.database.adapter).registerMember({
      connector: 'telegram',
      namespace: 'private',
      externalId: 'fixture-enrolled',
      now: 5,
    });
    expect(runtime.runtime.servesPrincipal(id)).toBe(false);
    const intake = runtime.serveMember(id);
    expect(runtime.runtime.servesPrincipal(id)).toBe(true);
    expect(runtime.serveMember(id)).toBe(intake);
    expect(f.drivers.get(id)?.cwd).toBe(memberPaths(f.root, id).workspaceDir);
  } finally {
    await runtime.stop();
    f.pool.dispose();
  }
});

it('refreshes authenticated member socket authority while preserving the ownerAccess instance', async () => {
  const f = await fixture();
  const runtime = await createOwnerRuntime(f.options);
  try {
    const db = runtime.database.adapter;
    const credential = readFileSync(memberPaths(f.root, f.member).credentialPath, 'utf8').trim();
    const bound = socket.resolveAccess(credential);
    expect(bound.readScopes).toEqual([]);
    createPrincipalRepository(db).grantScope({
      targetPrincipalId: f.member,
      ownerPrincipalId: 'owner',
      scope: { kind: 'memory', scopeKind: 'project', scopeId: 'fixture-granted' },
      now: 10,
    });
    const real = runtime.surface.dispatch;
    const access: JudgmentAccess[] = [];
    vi.spyOn(runtime.surface, 'dispatch').mockImplementation((call, context) => {
      access.push(context.access);
      return real(call, context);
    });
    await socket.dispatch(
      {
        action: 'memory.checkpoint.list',
        input: { limit: 1 },
        operationId: 'fixture-socket-member',
      },
      { access: bound }
    );
    expect(access[0].readScopes).toEqual([{ kind: 'project', id: 'fixture-granted' }]);
    await socket.dispatch(
      {
        action: 'memory.checkpoint.list',
        input: { limit: 1 },
        operationId: 'fixture-socket-owner',
      },
      { access: runtime.surface.ownerAccess }
    );
    expect(access[1]).toBe(runtime.surface.ownerAccess);
    db.prepare("UPDATE principals SET status='suspended' WHERE principal_id=?").run(f.member);
    await expect(
      socket.dispatch({ action: 'memory.checkpoint.list', input: {} }, { access: bound })
    ).rejects.toThrow('suspended');
  } finally {
    await runtime.stop();
    f.pool.dispose();
  }
});

it('resolves grants after waiting on the shared owner chain and rejects member replay turns', async () => {
  const f = await fixture();
  const runtime = await createOwnerRuntime(f.options);
  let release!: () => void;
  f.blockOwner(
    new Promise<void>((resolve) => {
      release = resolve;
    })
  );
  try {
    const repo = createPrincipalRepository(runtime.database.adapter);
    const grant = {
      targetPrincipalId: f.member,
      ownerPrincipalId: 'owner',
      scope: { kind: 'memory' as const, scopeKind: 'project' as const, scopeId: 'fixture-queued' },
      now: 10,
    };
    repo.grantScope(grant);
    runtime.intake.acceptOwnerMessage({
      id: 'telegram:fixture:queue-owner',
      channelKey: 'fixture',
      occurredAt: 1,
      text: 'fixture owner wait',
    });
    await vi.waitFor(() => expect(f.turns).toHaveLength(1));
    runtime.serveMember(f.member).acceptOwnerMessage({
      id: 'telegram:fixture:queue-member',
      channelKey: 'fixture',
      occurredAt: 2,
      text: 'fixture queued member',
    });
    repo.revokeScope({ ...grant, now: 11 });
    release();
    await vi.waitFor(() => expect(f.turns).toHaveLength(2));
    expect((f.turns[1].context as { access: JudgmentAccess }).access.readScopes).toEqual([]);
    const errors: string[] = [];
    // Member producer kinds are bounded by its own role; a replay must not acquire owner instructions.
    runtime.serveMember(f.member).accept({
      id: 'fixture-member-replay',
      kind: 'source_delta',
      principalId: f.member,
      channelKey: 'fixture',
      occurredAt: 3,
      refs: [],
      payload: { replay: { windowEndMs: 4 } },
    });
    await vi.waitFor(() => {
      const row = runtime.runtime.mailbox!.readInput('fixture-member-replay', f.member);
      const stored = row
        ? (runtime.database.adapter
            .prepare('SELECT last_error FROM mailbox_inputs WHERE id = ?')
            .get(row.id) as { last_error: string })
        : undefined;
      errors.push(stored?.last_error ?? '');
      expect(errors.join()).toContain('Member turn does not support');
    });
    expect(f.turns).toHaveLength(2);
  } finally {
    release();
    await runtime.stop();
    f.pool.dispose();
  }
});
