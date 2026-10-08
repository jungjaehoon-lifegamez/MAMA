import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createKnowledge,
  createPrincipalRepository,
  createNode,
  type ActionResult,
  type ActionContext,
} from '@jungjaehoon/mama-core';
import type { WorkGraphPage } from '@jungjaehoon/mama-core/knowledge';
import type { IModelRunner } from '@jungjaehoon/mama-core/runtime/drivers/types';
import { createActionSurface, ownerMemoryScopes } from '../../src/runtime/action-surface.js';
import { resolvePrincipalAccess } from '../../src/runtime/principal-access.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';
import { createNativeSession } from '../../src/runtime/native-session.js';

const OWNER = 'owner-fixture';
const PARTITION = { kind: 'project' as const, id: 'partition-fixture' };

type WorkReceipt = { commitmentId: string; recordRef: { kind: 'memory'; id: string } };
type ActionData = {
  'work.create': WorkReceipt;
  'work.revise': WorkReceipt;
  'work.show': { items: Array<{ chain: Array<{ summary: string }> }> };
  'work.list': { tasks: Array<{ commitmentId: string }>; missingIds: Array<string | number> };
  'graph.query': WorkGraphPage;
  'memory.search': { query: string; results: Array<{ id: string }> };
};

function data<T>(result: ActionResult): T {
  expect(result.status, JSON.stringify(result)).toBe('completed');
  if (result.status !== 'completed') throw new Error('Action failed');
  return result.data as T;
}

describe('P2a owner partitions through the catalog and dispatcher', () => {
  let root: string;
  let db: Awaited<ReturnType<typeof openCoreDatabase>>;
  let repository: ReturnType<typeof createPrincipalRepository>;
  let surface: ReturnType<typeof createActionSurface>;
  let member: string;
  let outsider: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'owner-partitions-'));
    vi.stubEnv('HOME', root);
    vi.stubEnv('MAMA_DB_PATH', join(root, 'core.db'));
    vi.stubEnv('MAMA_FORCE_TIER_3', 'true');
    db = await openCoreDatabase({ path: process.env.MAMA_DB_PATH! });
    repository = createPrincipalRepository(db.adapter);
    repository.ensureOwner({
      principalId: OWNER,
      connector: 'telegram',
      namespace: 'private',
      externalId: '30001',
      now: 1,
    });
    member = repository.registerMember({
      connector: 'telegram',
      namespace: 'private',
      externalId: '30002',
      now: 2,
    });
    outsider = repository.registerMember({
      connector: 'telegram',
      namespace: 'private',
      externalId: '30003',
      now: 3,
    });
    surface = createActionSurface({
      adapter: db.adapter,
      knowledge: createKnowledge({ adapter: db.adapter, embedder: null }),
      runtimeRoot: root,
      configPath: join(root, 'config.yaml'),
      ownerPrincipalId: OWNER,
      agentId: 'agent-owner-fixture',
      timeZone: createTimeZoneSetting('UTC'),
      isOwnerMessageTurn: () => true,
      connectors: ['fixture'],
    });
  });
  afterEach(async () => {
    await db?.close();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  const grant = (scopeId = PARTITION.id) =>
    repository.grantScope({
      targetPrincipalId: member,
      ownerPrincipalId: OWNER,
      now: 4,
      scope: { kind: 'memory', scopeKind: 'project', scopeId },
    });
  const access = (principalId = OWNER) =>
    resolvePrincipalAccess(principalId, {
      adapter: db.adapter,
      ownerAccess: surface.ownerAccess,
      agentId: 'agent-member-fixture',
    });
  const call = async <K extends keyof ActionData>(action: K, input: unknown, caller = access()) =>
    data<ActionData[K]>(
      await surface.dispatch(
        { action, input, operationId: `fixture:${counter++}` },
        { access: caller }
      )
    );
  let counter = 0;
  const create = (title: string) =>
    call('work.create', {
      topic: 'fixture-work',
      summary: title,
      set: { title, status: 'pending' },
    });
  const bindings = (id: string) =>
    db.adapter
      .prepare(
        `
    SELECT s.kind, s.external_id AS id FROM memory_scope_bindings b
    JOIN memory_scopes s ON s.id = b.scope_id WHERE b.memory_id = ?
    ORDER BY b.is_primary DESC, b.rowid`
      )
      .all(id);

  it('uses a post-boot grant on the next owner call and keeps omitted writes on exact defaults', async () => {
    expect(surface.ownerAccess.scopes).not.toContainEqual(PARTITION);
    grant();
    expect(surface.ownerAccess.scopes).toContainEqual(PARTITION);
    expect(surface.ownerAccess.defaultScopes).toEqual(ownerMemoryScopes(OWNER, ['fixture']));
    const saved = data<{ id: string }>(
      await surface.hostToolCall(
        'memory.save',
        {
          topic: 'fixture-memory',
          kind: 'fact',
          summary: 'Fixture fact',
          details: 'Fixture details',
          source: { package: 'fixture-consumer', source_type: 'fixture' },
        },
        'fixture-save'
      )
    );
    const item = await create('Fixture default task');
    expect(bindings(saved.id)).toEqual(ownerMemoryScopes(OWNER, ['fixture']));
    expect(bindings(item.recordRef.id)).toEqual(ownerMemoryScopes(OWNER, ['fixture']));
    expect(access(member).readScopes).toEqual([PARTITION]);
    expect((await call('work.list', { view: 'items' }, access(member))).tasks).toEqual([]);
    repository.revokeScope({
      targetPrincipalId: member,
      ownerPrincipalId: OWNER,
      now: 5,
      scope: { kind: 'memory', scopeKind: 'project', scopeId: PARTITION.id },
    });
    // The owner keeps writing to a partition its work is bound to after the last grant ends.
    expect(surface.ownerAccess.scopes).toContainEqual(PARTITION);
  });

  it('lets the owner revise shared work without scopes after the last grant on its partition ends', async () => {
    const item = await create('Fixture shared then unshared');
    grant();
    await call('work.revise', {
      commitmentId: item.commitmentId,
      summary: 'Fixture shared',
      set: { status: 'in_progress' },
      scopes: [...ownerMemoryScopes(OWNER, ['fixture']), PARTITION],
    });
    repository.revokeScope({
      targetPrincipalId: member,
      ownerPrincipalId: OWNER,
      now: 6,
      scope: { kind: 'memory', scopeKind: 'project', scopeId: PARTITION.id },
    });
    const revised = await call('work.revise', {
      commitmentId: item.commitmentId,
      summary: 'Fixture revised after revoke',
      set: { status: 'done' },
    });
    expect(bindings(revised.recordRef.id)).toContainEqual(PARTITION);
    expect(access(member).readScopes).toEqual([]);
    expect((await call('work.list', { view: 'items' }, access(member))).tasks).toEqual([]);
  });

  it('accepts a partition already in owner write scopes but refuses an owner default grant', () => {
    grant();
    const expanded = {
      ...surface.ownerAccess,
      scopes: [...surface.ownerAccess.scopes, PARTITION],
      defaultScopes: ownerMemoryScopes(OWNER, ['fixture']),
    };
    const resolve = () =>
      resolvePrincipalAccess(member, {
        adapter: db.adapter,
        ownerAccess: expanded,
        agentId: 'agent-member-fixture',
      });
    expect(resolve().readScopes).toEqual([PARTITION]);
    grant('fixture');
    expect(resolve).toThrow('overlaps owner default scope: project:fixture');
  });

  it('shares the whole revision chain and graph without admitting linked private records', async () => {
    const item = await create('Fixture original');
    const secret = await create('Fixture private neighbor');
    grant();
    const bound = await call('work.revise', {
      commitmentId: item.commitmentId,
      summary: 'Fixture shared',
      set: { status: 'in_progress' },
      scopes: [...ownerMemoryScopes(OWNER, ['fixture']), PARTITION],
      links: [
        { relation: 'builds_on', target: item.recordRef },
        { relation: 'mentions', target: secret.recordRef },
      ],
    });
    const last = await call('work.revise', {
      commitmentId: item.commitmentId,
      summary: 'Fixture completed',
      set: { status: 'done' },
      links: [{ relation: 'builds_on', target: bound.recordRef }],
    });
    expect(bindings(last.recordRef.id)).toEqual([
      ...ownerMemoryScopes(OWNER, ['fixture']),
      PARTITION,
    ]);
    const caller = access(member);
    expect(
      (await call('work.list', { view: 'items' }, caller)).tasks.map((task) => task.commitmentId)
    ).toEqual([item.commitmentId]);
    const shown = await call('work.show', { commitmentId: item.commitmentId }, caller);
    expect(shown.items[0].chain.map((entry) => entry.summary)).toEqual([
      'Fixture original',
      'Fixture shared',
      'Fixture completed',
    ]);
    const graph = await call(
      'graph.query',
      {
        view: 'neighbors',
        seeds: [item.recordRef],
        history: 'all',
        maxDepth: 3,
      },
      caller
    );
    expect(graph.nodes.map((node) => node.ref.id).sort()).toEqual(
      [item.recordRef.id, bound.recordRef.id, last.recordRef.id].sort()
    );
    expect(graph.edges.map((edge) => edge.relation)).toEqual(['builds_on', 'builds_on']);
    expect(
      (await call('work.list', { view: 'links', ids: [item.commitmentId] }, caller)).missingIds
    ).toEqual([]);
    expect((await call('work.list', { view: 'items' }, access(outsider))).tasks).toEqual([]);
    expect(
      (await call('work.show', { commitmentId: item.commitmentId }, access(outsider))).items
    ).toEqual([]);
    for (const [ref, deniedCaller] of [
      [secret.recordRef, caller],
      [item.recordRef, access(outsider)],
    ] as const) {
      expect(
        await surface.dispatch(
          {
            action: 'graph.query',
            input: {
              view: 'detail',
              seeds: [ref],
              history: 'all',
            },
          },
          { access: deniedCaller }
        )
      ).toMatchObject({ status: 'failed', error: { kind: 'denied' } });
    }
  });

  it.each(['chain', 'graph', 'links'] as const)(
    'opens a shared item through the %s read path',
    async (path) => {
      const item = await create('Fixture original');
      grant();
      const writer = {
        ...surface.ownerAccess,
        scopes: [...ownerMemoryScopes(OWNER, ['fixture']), PARTITION],
        defaultScopes: ownerMemoryScopes(OWNER, ['fixture']),
      };
      const bound = await call(
        'work.revise',
        {
          commitmentId: item.commitmentId,
          summary: 'Fixture shared',
          set: { status: 'in_progress' },
          scopes: writer.scopes,
          links: [{ relation: 'builds_on', target: item.recordRef }],
        },
        writer
      );
      // Isolate history admission from owner partition resolution, which has its own tests.
      const caller = resolvePrincipalAccess(member, {
        adapter: db.adapter,
        ownerAccess: { ...writer, scopes: writer.defaultScopes },
        agentId: 'agent-member-fixture',
      });
      if (path === 'chain') {
        const shown = await call('work.show', { commitmentId: item.commitmentId }, caller);
        expect(shown.items[0].chain.map((entry) => entry.summary)).toEqual([
          'Fixture original',
          'Fixture shared',
        ]);
      } else if (path === 'graph') {
        const graph = await call(
          'graph.query',
          {
            view: 'neighbors',
            seeds: [item.recordRef],
            history: 'all',
          },
          caller
        );
        expect(graph.nodes.map((node) => node.ref.id).sort()).toEqual(
          [item.recordRef.id, bound.recordRef.id].sort()
        );
      } else {
        expect(
          (await call('work.list', { view: 'links', ids: [item.commitmentId] }, caller)).missingIds
        ).toEqual([]);
      }
    }
  );

  it('matches the pre-partition owner board, overview and search byte for byte', async () => {
    await create('Fixture board alpha');
    await create('Fixture board beta');
    createNode(db.adapter, {
      kind: 'item',
      name: 'Fixture board anchor',
      scopes: ownerMemoryScopes(OWNER, ['fixture']),
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-09T00:00:00Z'));
    const legacy: ActionContext['access'] = {
      ...surface.ownerAccess,
      scopes: ownerMemoryScopes(OWNER, ['fixture']),
    };
    delete legacy.defaultScopes;
    const queries = [
      ['work.list', { view: 'items' }],
      ['graph.query', { view: 'overview', asOf: Date.now() }],
      ['memory.search', { query: 'Fixture board', includeRelated: false, disableRecency: true }],
    ] as const;
    for (const [action, input] of queries) {
      expect(JSON.stringify(await call(action, input))).toBe(
        JSON.stringify(await call(action, input, legacy))
      );
    }
    expect((await call('graph.query', { view: 'overview' })).nodes).toHaveLength(1);
    const search = await call('memory.search', {
      query: 'Fixture board',
      includeRelated: false,
      disableRecency: true,
    });
    expect(search.query).toBe('Fixture board');
    expect(search.results).toHaveLength(2);
    expect(surface.ownerAccess.defaultScopes).toEqual(legacy.scopes);
  });

  it('revises with a new partition on the next native owner turn without rebuilding the surface', async () => {
    const item = await create('Fixture native task');
    let turn = 0;
    const model: IModelRunner = {
      backendType: 'codex',
      supportsNativeSubagents: false,
      reportsModelRuns: false,
      prompt: async (_content, _callbacks, options) => {
        const result = await options!.hostToolBridge!.execute({
          callId: `fixture-native-call-${++turn}`,
          name: 'work.revise',
          input: {
            commitmentId: item.commitmentId,
            summary: `Fixture native revision ${turn}`,
            set: { stage: `fixture-stage-${turn}` },
            ...(turn === 1
              ? {}
              : { scopes: [...ownerMemoryScopes(OWNER, ['fixture']), PARTITION] }),
          },
        });
        expect(JSON.parse(result.content)).toMatchObject({ success: true });
        return {
          response: 'Fixture completion',
          session_id: 'fixture-session',
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
      setSessionId: () => {},
      setSystemPrompt: () => {},
      isHealthy: () => true,
      getMetrics: () => ({
        requestCount: turn,
        failureCount: 0,
        avgLatencyMs: 0,
        lastRequestAt: null,
      }),
      stop: () => {},
    };
    const session = createNativeSession({
      backend: 'codex',
      model: 'fixture-model',
      agent: model,
      actionSurface: surface,
      workspaceDir: join(root, 'workspace'),
      runtimeRoot: root,
      maxTurns: 10,
      timeout: 1_000,
    });
    try {
      await session.runTurn([{ type: 'text', text: 'Fixture first turn' }]);
      grant();
      await session.runTurn([{ type: 'text', text: 'Fixture second turn' }]);
      expect(
        (
          await call('work.show', { commitmentId: item.commitmentId }, access(member))
        ).items[0].chain.map((entry) => entry.summary)
      ).toEqual(['Fixture native task', 'Fixture native revision 1', 'Fixture native revision 2']);
    } finally {
      await session.stop();
    }
  });
});
