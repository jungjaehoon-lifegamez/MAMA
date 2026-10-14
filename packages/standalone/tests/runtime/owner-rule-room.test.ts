import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createKnowledge,
  createPrincipalRepository,
  type ActionResult,
  type ActionContext,
} from '@jungjaehoon/mama-core';
import { createActionSurface } from '../../src/runtime/action-surface.js';
import {
  resolvePrincipalAccess,
  memberRoomSessionKey,
} from '../../src/runtime/principal-access.js';
import { ownerRuleIds, guardOwnerRules } from '../../src/runtime/owner-authority.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';
import { RawStore } from '../../src/storage/source-archive.js';
import { ChatSources } from '../../src/storage/chat-sources.js';
import { createStoredSourceReader } from '../../src/api/stored-source-reader.js';

const OWNER = 'owner-test';
const PARTITION = { kind: 'project' as const, id: 'partition-test' };
let root: string;
let db: Awaited<ReturnType<typeof openCoreDatabase>>;
let surface: ReturnType<typeof createActionSurface>;
let member: string;
let raw: RawStore;
let chat: ChatSources;
let reader: ReturnType<typeof createStoredSourceReader>;
let sequence: number;
const data = (r: ActionResult) => {
  if (r.status !== 'completed') throw new Error(JSON.stringify(r.error));
  return r.data as Record<string, unknown>;
};
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'rule-room-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('MAMA_DB_PATH', join(root, 'core.db'));
  vi.stubEnv('MAMA_FORCE_TIER_3', 'true');
  db = await openCoreDatabase({ path: process.env.MAMA_DB_PATH! });
  const repository = createPrincipalRepository(db.adapter);
  repository.ensureOwner({
    principalId: OWNER,
    connector: 'telegram',
    namespace: 'private',
    externalId: '20001',
    now: 1,
  });
  member = repository.registerMember({
    connector: 'telegram',
    namespace: 'private',
    externalId: '20002',
    now: 2000,
  });
  repository.grantScope({
    targetPrincipalId: member,
    ownerPrincipalId: OWNER,
    now: 2001,
    scope: { kind: 'memory', scopeKind: 'project', scopeId: PARTITION.id },
  });
  raw = new RawStore(join(root, 'raw'));
  chat = new ChatSources(raw, db.adapter, OWNER, 'owner-agent');
  reader = createStoredSourceReader({ adapter: db.adapter, rawStore: () => raw });
  surface = createActionSurface({
    adapter: db.adapter,
    knowledge: createKnowledge({ adapter: db.adapter, embedder: null }),
    runtimeRoot: root,
    configPath: join(root, 'config.yaml'),
    ownerPrincipalId: OWNER,
    commonChannelId: '-100',
    agentId: 'owner-agent',
    timeZone: createTimeZoneSetting('UTC'),
    isOwnerMessageTurn: () => true,
    storedSourceReader: reader,
  });
  sequence = 0;
});
afterEach(async () => {
  raw?.close();
  await db?.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
const owner = (): ActionContext => ({
  access: surface.ownerAccess,
  session: { sourceMessageRef: 'telegram:-100:1' },
});
const room = (channel = '-100'): ActionContext => ({
  access: resolvePrincipalAccess(member, {
    adapter: db.adapter,
    ownerAccess: surface.ownerAccess,
    agentId: 'member-agent',
    sessionKey: memberRoomSessionKey(member, channel),
  }),
  session: { sourceMessageRef: `telegram:${channel}:2` },
});
const input = (extra: Record<string, unknown> = {}) => ({
  topic: 'rule',
  kind: 'lesson',
  summary: 'Rule',
  details: 'Rule',
  appliesWhen: 'always',
  source: { package: 'fixture', source_type: 'fixture' },
  ...extra,
});
const call = (action: string, body: unknown, context = room()) =>
  surface.dispatch({ action, input: body, operationId: `operation-${++sequence}` }, context);
const save = async (extra = {}, context = owner()) =>
  data(await call('memory.save', input(extra), context)).id as string;
const replace = (id: string) => ({ id, reason: 'correct it' });

// Regression for the independent piggyback exploit: a rule never lends authority to a sibling.
it('refuses mixed rule/non-rule replacements and leaves the common non-rule active', async () => {
  const rule = await save();
  const common = await save({ kind: 'decision' });
  for (const ids of [[common], [rule, common]]) {
    expect(
      (await call('memory.save', input({ scopes: [PARTITION], replaces: ids.map(replace) }))).status
    ).toBe('failed');
  }
  expect(
    db.adapter.prepare('SELECT status, superseded_by FROM decisions WHERE id=?').get(common)
  ).toEqual({ status: 'active', superseded_by: null });
});

it('refuses a non-rule kind and forces a valid correction into exactly the common rule scope', async () => {
  const rule = await save();
  expect(
    (
      await call(
        'memory.save',
        input({
          kind: 'decision',
          scopes: [{ kind: 'user', id: OWNER }],
          replaces: [replace(rule)],
        })
      )
    ).status
  ).toBe('failed');
  const corrected = await save(
    { scopes: [PARTITION, { kind: 'user', id: member }], replaces: [replace(rule)] },
    room()
  );
  expect(
    db.adapter
      .prepare(
        'SELECT s.kind, s.external_id FROM memory_scope_bindings b JOIN memory_scopes s ON s.id=b.scope_id WHERE b.memory_id=?'
      )
      .all(corrected)
  ).toEqual([{ kind: 'user', external_id: OWNER }]);
  expect([...ownerRuleIds(db.adapter, [corrected], OWNER)]).toEqual([corrected]);
  expect(
    (await call('memory.retire', { memory_id: corrected, reason: 'withdrawn', status: 'stale' }))
      .status
  ).toBe('completed');
});

it.each([true, false])(
  'does not lend the common scope to links, including edges (partition grant: %s)',
  async (grantedPartition) => {
    if (!grantedPartition)
      createPrincipalRepository(db.adapter).revokeScope({
        targetPrincipalId: member,
        ownerPrincipalId: OWNER,
        now: 2002,
        scope: { kind: 'memory', scopeKind: 'project', scopeId: PARTITION.id },
      });
    const rule = await save();
    const hidden = await save({ kind: 'decision' });
    const linked = await save({
      kind: 'decision',
      links: [{ relation: 'mentions', target: { kind: 'memory', id: hidden } }],
    });
    const edge = db.adapter
      .prepare('SELECT edge_id FROM twin_edges WHERE subject_id=? AND object_id=?')
      .get(linked, hidden) as { edge_id: string };
    for (const target of [
      { kind: 'memory', id: hidden },
      { kind: 'edge', id: edge.edge_id },
    ]) {
      expect(
        (
          await call(
            'memory.save',
            input({ replaces: [replace(rule)], links: [{ relation: 'mentions', target }] })
          )
        ).status
      ).toBe('failed');
    }
    if (!grantedPartition) return;
    const granted = await save({ kind: 'decision', scopes: [PARTITION] });
    expect(
      (
        await call(
          'memory.save',
          input({
            replaces: [replace(rule)],
            links: [{ relation: 'mentions', target: { kind: 'memory', id: granted } }],
          })
        )
      ).status
    ).toBe('completed');
  }
);

it('does not widen amendment targets when the guard wraps an internal registration', async () => {
  const rule = await save();
  const hidden = await save({ kind: 'decision' });
  const exec = vi.fn(async () => ({}));
  const guard = guardOwnerRules(
    { contract: { name: 'memory.save', summary: 'fixture', inputSchema: {} }, exec },
    db.adapter,
    OWNER,
    '-100'
  );
  await expect(
    guard.exec(
      input({
        replaces: [replace(rule)],
        amends: [{ target: { kind: 'memory', id: hidden }, set: { summary: 'injected' } }],
      }),
      room()
    )
  ).rejects.toThrow();
  expect(exec).not.toHaveBeenCalled();
});

it('refuses rule replacement and retirement from another allowed group', async () => {
  const rule = await save();
  expect(
    (await call('memory.save', input({ replaces: [replace(rule)] }), room('-200'))).status
  ).toBe('failed');
  expect(
    (
      await call(
        'memory.retire',
        { memory_id: rule, status: 'stale', reason: 'other group' },
        room('-200')
      )
    ).status
  ).toBe('failed');
});

it('does not identify a DM lesson shared into common by an owner-role member as an owner rule', async () => {
  createPrincipalRepository(db.adapter).grantRole({
    principalId: member,
    role: 'owner',
    now: 2001,
  });
  const personal: ActionContext = {
    access: resolvePrincipalAccess(member, {
      adapter: db.adapter,
      ownerAccess: surface.ownerAccess,
      agentId: 'member-agent',
    }),
    session: { sourceMessageRef: 'telegram:20002:1' },
  };
  const lesson = await save({}, personal);
  const shared = data(
    await call('memory.share', { memory_id: lesson, reason: 'share lesson' }, personal)
  ).id as string;
  // Sharing a lesson is a fact today; a rule-kind share still must not gain owner authority.
  db.adapter.prepare("UPDATE decisions SET kind='lesson' WHERE id=?").run(shared);
  expect(ownerRuleIds(db.adapter, [lesson, shared], OWNER).size).toBe(0);
});

it.each(['memory.save', 'memory.retire'])(
  'refuses a room superseding an unbound record with %s',
  async (action) => {
    const unbound = await save({ kind: 'decision' });
    db.adapter.prepare('DELETE FROM memory_scope_bindings WHERE memory_id=?').run(unbound);
    const body =
      action === 'memory.save'
        ? input({ scopes: [PARTITION], replaces: [replace(unbound)] })
        : { memory_id: unbound, status: 'stale', reason: 'unbound' };
    expect((await call(action, body)).status).toBe('failed');
    expect(db.adapter.prepare('SELECT status FROM decisions WHERE id=?').get(unbound)).toEqual({
      status: 'active',
    });
  }
);

it('bounds room chat overview, search, recent and direct/batch reads by enrollment time', async () => {
  const refs = [1999, 2000, 2001].map((at) =>
    chat.saveOwnerMessage({
      id: `telegram:-100:${at}`,
      channelKey: '-100',
      occurredAt: at,
      text: `history marker ${at}`,
    })
  );
  chat.saveReply({
    messageRef: 'telegram:-100:1999',
    text: 'PRE_ENROLLMENT_COMMON_ANSWER',
    occurredAt: 1999,
    deliveryVerified: true,
  });
  const context = room();
  expect(reader.overview('chat', context.access).count).toBe(2);
  for (const query of ['', 'history']) {
    const result = reader.search('chat', { query, from: 0, detail: 'full' }, context.access);
    expect(
      (result.hits as Array<{ source_id: string }>).map((hit) => hit.source_id).sort()
    ).toEqual(['telegram:-100:2000', 'telegram:-100:2001']);
  }
  for (const body of [{ source: 'chat', observationRef: refs[0] }, { observationRef: refs[0] }]) {
    expect((await call('source.read', body)).status).toBe('failed');
  }
  expect(
    JSON.stringify(
      data(await call('source.recent', { since: 0, channels: ['chat:telegram:-100'] }))
    )
  ).not.toContain('1999');
  const batch = reader.read('chat', { observationRefs: refs }, context.access);
  expect((batch.results as Array<{ status: string }>).map((item) => item.status)).toEqual([
    'failed',
    'completed',
    'completed',
  ]);
  expect(() => reader.readObservation(refs[0]!, context.access)).toThrow();
  expect(reader.readObservation(refs[1]!, context.access).content).toContain('2000');
  expect(JSON.stringify(reader.search('chat', { query: '' }, context.access))).not.toContain(
    'PRE_ENROLLMENT_COMMON_ANSWER'
  );
});

it('refuses a common rule correction that links an observation the room cannot read', async () => {
  const [before, after] = [1999, 2001].map((at) =>
    chat.saveOwnerMessage({
      id: `telegram:-100:${at}`,
      channelKey: '-100',
      occurredAt: at,
      text: `marker ${at}`,
    })
  );
  const rule = await save();
  const correct = (id: string) =>
    call(
      'memory.save',
      input({
        replaces: [replace(rule)],
        links: [{ relation: 'mentions', target: { kind: 'observation', id } }],
      })
    );
  // Core only checks that an observation exists; the room's enrollment floor still applies.
  expect(await correct(before!)).toMatchObject({ status: 'failed', error: { code: 'denied' } });
  expect((await correct(after!)).status).toBe('completed');
});

it('refuses room work evidence the room cannot read, in sources and link targets', async () => {
  const [before, after] = [1999, 2001].map((at) =>
    chat.saveOwnerMessage({
      id: `telegram:-100:${at}`,
      channelKey: '-100',
      occurredAt: at,
      text: `work marker ${at}`,
    })
  );
  const create = (sourceRefs: string[]) =>
    call('work.create', {
      topic: 'room-work',
      summary: 'room work',
      scopes: [PARTITION],
      set: { title: 'room work' },
      sourceRefs,
    });
  // Core stores sourceRefs that merely exist; a room cites only what its own reads reach.
  expect(await create([before!])).toMatchObject({ status: 'failed' });
  expect(
    await call('work.create', {
      topic: 'room-work',
      summary: 'room work',
      scopes: [PARTITION],
      set: { title: 'room work' },
      links: [{ relation: 'derived_from', target: { kind: 'observation', id: before! } }],
    })
  ).toMatchObject({ status: 'failed' });
  const work = data(await create([after!])) as { commitmentId: string };
  const link = (id: string) =>
    call('work.link', {
      from: work.commitmentId,
      to: { kind: 'observation', id },
      relation: 'mentions',
      reason: 'cites the room message',
    });
  expect(await link(before!)).toMatchObject({ status: 'failed' });
  expect((await link(after!)).status).toBe('completed');
});

it('changes a shared record from a room only when every binding is within its grants', async () => {
  const wide = await save({
    kind: 'decision',
    scopes: [PARTITION, { kind: 'user', id: OWNER }],
  });
  const own = await save({ kind: 'decision', scopes: [PARTITION] });
  const retire = (id: string) =>
    call('memory.retire', { memory_id: id, reason: 'withdrawn', status: 'stale' });
  // Retiring changes the record for its common readers too.
  expect(await retire(wide)).toMatchObject({ status: 'failed', error: { code: 'denied' } });
  expect((await retire(own)).status).toBe('completed');
});

it('checks room evidence in every link and nested evidence field', async () => {
  const [before, after] = [1999, 2001].map((at) =>
    chat.saveOwnerMessage({
      id: `telegram:-100:${at}`,
      channelKey: '-100',
      occurredAt: at,
      text: `nested marker ${at}`,
    })
  );
  // A plain partition record, not an owner-rule correction.
  const link = (id: string) =>
    call(
      'memory.save',
      input({
        kind: 'decision',
        scopes: [PARTITION],
        links: [{ relation: 'derived_from', target: { kind: 'observation', id } }],
      })
    );
  expect(await link(before!)).toMatchObject({ status: 'failed' });
  expect((await link(after!)).status).toBe('completed');
  const role = (id: string) =>
    call('work.create', {
      topic: 'room-work',
      summary: 'room work',
      scopes: [PARTITION],
      set: {
        title: 'room work',
        roles: [{ personRef: 'person-a', role: 'owner', evidenceRefs: [id], confirmed: true }],
      },
    });
  expect(await role(before!)).toMatchObject({ status: 'failed' });
  expect((await role(after!)).status).toBe('completed');
});

it('keeps a corrected partition rule in its partition and has no graph-backed link view', async () => {
  // A lesson saved in a partition from the common channel counts as an owner rule.
  const rule = await save({ scopes: [PARTITION] }, room());
  expect([...ownerRuleIds(db.adapter, [rule], OWNER)]).toEqual([rule]);
  const corrected = data(
    await call('memory.save', input({ replaces: [replace(rule)], scopes: [PARTITION] }))
  ).id as string;
  // Its correction stays in the partition instead of becoming a common rule.
  expect(
    db.adapter
      .prepare(
        'SELECT s.kind, s.external_id FROM memory_scope_bindings b JOIN memory_scopes s ON s.id=b.scope_id WHERE b.memory_id=?'
      )
      .all(corrected)
  ).toEqual([{ kind: 'project', external_id: PARTITION.id }]);
  expect(await call('work.list', { view: 'links', ids: ['work-fixture'] })).toMatchObject({
    status: 'failed',
    error: { code: 'invalid_input' },
  });
});
