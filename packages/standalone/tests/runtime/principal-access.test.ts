import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createKnowledge,
  createPrincipalRepository,
  type ActionContext,
  type ActionResult,
  type PrincipalScopeGrantRef,
} from '@jungjaehoon/mama-core';
import { createActionSurface, ownerMemoryScopes } from '../../src/runtime/action-surface.js';
import { resolvePrincipalAccess } from '../../src/runtime/principal-access.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';
import { ownerMessageItem } from '../../src/storage/chat-sources.js';
import { ownerRuleIds } from '../../src/runtime/owner-authority.js';

const ROLE = [
  'skill.list',
  'skill.read',
  'document.render',
  'schedule.job.create',
  'schedule.job.list',
  'schedule.job.update',
  'schedule.job.delete',
  'graph.query',
  'work.list',
  'work.show',
  'memory.search',
  'memory.read:provenance',
  'memory.read:record',
  'memory.read:timeline',
  'source.search',
  'source.read',
  'source.recent',
  'source.attachment.list',
  'source.attachment.download',
  'deliver.telegram.file',
  'trello.read',
  'schedule.upcoming',
  'judge',
  'memory.save',
  'memory.share',
  'records.export',
  'records.erase',
  'memory.retire',
  'memory.checkpoint.list',
  'memory.checkpoint.save',
  'help',
  'code_act',
];
const OWNER = 'owner-test';
const DM = '20002';
const PARTITION = { kind: 'project' as const, id: 'partition-test' };

function data(result: ActionResult): unknown {
  if (result.status !== 'completed') throw new Error(JSON.stringify(result.error));
  return result.data;
}

describe('P1 principal access through the product dispatcher', () => {
  let root: string;
  let db: Awaited<ReturnType<typeof openCoreDatabase>>;
  let repository: ReturnType<typeof createPrincipalRepository>;
  let surface: ReturnType<typeof createActionSurface>;
  let knowledge: ReturnType<typeof createKnowledge>;
  let member: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'principal-access-'));
    vi.stubEnv('HOME', root);
    vi.stubEnv('MAMA_DB_PATH', join(root, 'core.db'));
    vi.stubEnv('MAMA_FORCE_TIER_3', 'true');
    db = await openCoreDatabase({ path: process.env.MAMA_DB_PATH! });
    repository = createPrincipalRepository(db.adapter);
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
      externalId: DM,
      now: 2,
    });
    repository.grantScope({
      targetPrincipalId: member,
      ownerPrincipalId: OWNER,
      now: 3,
      scope: { kind: 'memory', scopeKind: 'project', scopeId: PARTITION.id },
    });
    knowledge = createKnowledge({ adapter: db.adapter, embedder: null });
    surface = createActionSurface({
      adapter: db.adapter,
      knowledge,
      runtimeRoot: root,
      configPath: join(root, 'config.yaml'),
      ownerPrincipalId: OWNER,
      commonChannelId: '-100',
      agentId: 'agent-owner-test',
      timeZone: createTimeZoneSetting('UTC'),
      isOwnerMessageTurn: () => true,
      attachmentPorts: { telegram: () => null },
      judge: { ask: async () => ({}) },
      ownerMessages: { exchanges: () => [] },
      helpTopics: { 'fixture-procedure': 'Owner procedure text.' },
    });
  });

  afterEach(async () => {
    await db?.close();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const resolve = (id: string = member) =>
    resolvePrincipalAccess(id, {
      adapter: db.adapter,
      ownerAccess: surface.ownerAccess,
      agentId: 'agent-member-test',
    });
  const grant = (scope: PrincipalScopeGrantRef) =>
    repository.grantScope({
      targetPrincipalId: member,
      ownerPrincipalId: OWNER,
      scope,
      now: 4,
    });
  const ruleTurn = (principalId: string): ActionContext => ({
    access: resolve(principalId),
    session: { sourceMessageRef: 'telegram:fixture-dm:fixture-message' },
  });
  const saveRule = (principalId: string, operationId: string, replaces?: string) =>
    surface.dispatch(
      {
        action: 'memory.save',
        operationId,
        input: {
          topic: 'fixture-rule',
          kind: 'lesson',
          summary: 'Keep fixture replies brief.',
          details: 'A fixture standing instruction.',
          appliesWhen: 'When answering fixture messages.',
          source: { package: 'fixture', source_type: 'fixture' },
          ...(replaces ? { replaces: [{ id: replaces, reason: 'A fixture correction.' }] } : {}),
        },
      },
      ruleTurn(principalId)
    );
  // Also exercise existing handlers before the resolver exists, to expose their current leaks.
  const memberAccess = (): ActionContext['access'] => ({
    principalId: member,
    agentId: 'agent-member-test',
    scopes: [{ kind: 'user', id: member }],
    defaultScopes: [{ kind: 'user', id: member }],
    readScopes: [PARTITION],
    connectors: ['chat'],
    channels: { chat: [`telegram:${DM}`] },
    destinations: [{ kind: 'telegram', id: DM }],
    actions: ROLE,
  });

  it('isolates room access and permits attributed partition work and common policy', async () => {
    const access = resolvePrincipalAccess(member, {
      adapter: db.adapter,
      ownerAccess: surface.ownerAccess,
      agentId: 'agent-member-test',
      sessionKey: `member:${member}:room:telegram:-100`,
    });
    expect(access.scopes).toEqual([PARTITION]);
    expect(access.readScopes).toEqual([PARTITION]);
    expect(access.defaultScopes).toEqual([]);
    expect(access.channels?.chat).toEqual(['telegram:-100']);
    expect(access.destinations).toEqual([{ kind: 'telegram', id: '-100' }]);
    const context = { access, session: { sourceMessageRef: 'telegram:-100:1', channelId: '-100' } };
    const call = (action: string, input: unknown, operationId: string) =>
      surface.dispatch({ action, input, operationId }, context);
    expect(
      (
        await call(
          'work.create',
          { topic: 'room-work', summary: 'change', set: { title: 'room work' } },
          'unscoped'
        )
      ).status
    ).not.toBe('completed');
    expect(
      (
        await call(
          'work.create',
          {
            topic: 'room-work',
            summary: 'change',
            scopes: [{ kind: 'project', id: 'ungranted' }],
            set: { title: 'room work' },
          },
          'ungranted'
        )
      ).status
    ).not.toBe('completed');
    const work = data(
      await call(
        'work.create',
        { topic: 'room-work', summary: 'change', scopes: [PARTITION], set: { title: 'room work' } },
        'room-work'
      )
    ) as { commitmentId: string };
    expect(
      data(
        await call(
          'work.revise',
          {
            commitmentId: work.commitmentId,
            summary: 'correction',
            set: { title: 'corrected room work' },
          },
          'room-revise'
        )
      )
    ).toMatchObject({ revision: 2 });
    const policy = data(await call('manage.policy.read', {}, 'policy-read')) as {
      fingerprint: string;
    };
    const revision = data(
      await call(
        'manage.policy.update',
        {
          text: 'Room standing correction.',
          reason: 'member correction',
          fingerprint: policy.fingerprint,
        },
        'room-policy'
      )
    ) as { revisionId: string };
    expect(
      db.adapter
        .prepare('SELECT principal_id FROM command_bindings WHERE receipt_key=?')
        .all(revision.revisionId)
    ).toContainEqual({ principal_id: member });
    const record = db.adapter
      .prepare('SELECT agent_id FROM decisions WHERE id=?')
      .get(revision.revisionId);
    expect(record).toEqual({ agent_id: 'agent-member-test' });
    expect(
      db.adapter
        .prepare(
          'SELECT s.kind, s.external_id FROM memory_scope_bindings b JOIN memory_scopes s ON s.id=b.scope_id WHERE b.memory_id=?'
        )
        .all(revision.revisionId)
    ).toEqual([{ kind: 'user', external_id: OWNER }]);
    expect(
      (
        await surface.dispatch(
          {
            action: 'manage.policy.update',
            operationId: 'dm-policy',
            input: { text: 'private correction', reason: 'private', fingerprint: 'any' },
          },
          ruleTurn(member)
        )
      ).status
    ).not.toBe('completed');
  });

  it('lets a room correct an owner rule with common scope and member authorship, while its DM is refused', async () => {
    const rule = data(await saveRule(OWNER, 'common-standing-rule')) as { id: string };
    const access = resolvePrincipalAccess(member, {
      adapter: db.adapter,
      ownerAccess: surface.ownerAccess,
      agentId: 'agent-member-test',
      sessionKey: `member:${member}:room:telegram:-100`,
    });
    const result = await surface.dispatch(
      {
        action: 'memory.save',
        operationId: 'room-standing-rule',
        input: {
          topic: 'fixture-rule',
          kind: 'lesson',
          summary: 'Room standing correction',
          details: 'Room standing correction',
          appliesWhen: 'When answering fixture messages.',
          source: { package: 'fixture', source_type: 'fixture' },
          replaces: [{ id: rule.id, reason: 'group correction' }],
        },
      },
      { access, session: { sourceMessageRef: 'telegram:-100:1' } }
    );
    const revised = data(result) as { id: string };
    expect(ownerRuleIds(db.adapter, [revised.id], OWNER).has(revised.id)).toBe(true);
    expect(
      db.adapter
        .prepare('SELECT principal_id FROM command_bindings WHERE receipt_key=?')
        .get(revised.id)
    ).toEqual({ principal_id: member });
    expect((await saveRule(member, 'dm-standing-rule', revised.id)).status).not.toBe('completed');
    const retired = await surface.dispatch(
      {
        action: 'memory.retire',
        operationId: 'room-retire-rule',
        input: { memory_id: revised.id, status: 'stale', reason: 'Group withdrew the rule' },
      },
      { access, session: { sourceMessageRef: 'telegram:-100:2' } }
    );
    expect(retired.status, JSON.stringify(retired)).toBe('completed');
  });

  it.each([false, true])(
    'refuses DM policy and owner-rule changes (owner role: %s)',
    async (ownerRole) => {
      if (ownerRole) repository.grantRole({ principalId: member, role: 'owner', now: 4 });
      const context = ruleTurn(member);
      const input = { text: 'Private correction.', reason: 'DM request', fingerprint: 'fixture' };
      for (const action of ['manage.policy.read', 'manage.policy.update']) {
        expect(
          await surface.dispatch({ action, input: action.endsWith('read') ? {} : input }, context)
        ).toMatchObject({ status: 'failed', error: { code: 'action_not_granted' } });
      }
      // The policy handler also refuses DM authority independently of the action grant.
      await expect(
        surface.catalog.entry('manage.policy.update').exec(input, context)
      ).rejects.toMatchObject({
        name: 'denied',
        message: expect.stringContaining('common channel'),
      });
      const rule = data(await saveRule(OWNER, 'dm-protected-rule')) as { id: string };
      expect(await saveRule(member, 'dm-replace-rule', rule.id)).toMatchObject({
        status: 'failed',
        error: { message: expect.stringContaining('common channel') },
      });
      expect(
        await surface.dispatch(
          {
            action: 'memory.retire',
            operationId: 'dm-retire-rule',
            input: { memory_id: rule.id, status: 'stale', reason: 'DM request' },
          },
          context
        )
      ).toMatchObject({
        status: 'failed',
        error: { message: expect.stringContaining('common channel') },
      });
    }
  );

  it('resolves personal writes, granted reads and the bound private Telegram DM', () => {
    expect(resolve()).toEqual(memberAccess());
    const item = ownerMessageItem(
      {
        id: `telegram:${DM}:1`,
        channelKey: DM,
        occurredAt: 1,
        text: 'Fixture message',
      },
      member
    );
    expect(resolve().channels?.chat).toEqual([item.channel]);
  });

  it('reuses the exact owner object, including its unchanged defaults and actions', () => {
    const owner = resolve(OWNER);
    expect(owner).toBe(surface.ownerAccess);
    expect(owner).toEqual(surface.ownerAccess);
    expect(owner.defaultScopes).toEqual(ownerMemoryScopes(OWNER));
  });

  it('classifies rules saved through dispatch by their authenticated writer, not their shared ref shape', async () => {
    const ownerRule = data(await saveRule(OWNER, 'fixture-owner-rule')) as { id: string };
    const memberRule = data(await saveRule(member, 'fixture-member-rule')) as { id: string };
    expect(
      db.adapter
        .prepare(
          `SELECT j.record_id AS id, b.principal_id AS principal
        FROM judgment_commands j JOIN command_bindings b USING (command_id)
        ORDER BY b.command_id`
        )
        .all()
    ).toEqual([
      { id: memberRule.id, principal: member },
      { id: ownerRule.id, principal: OWNER },
    ]);
    expect([...ownerRuleIds(db.adapter, [ownerRule.id, memberRule.id], OWNER)]).toEqual([
      ownerRule.id,
    ]);
  });

  it.each(['memory.save', 'memory.retire'] as const)(
    'allows a member %s of its own rule while protecting owner rules',
    async (action) => {
      const ownerRule = data(await saveRule(OWNER, 'fixture-owner-rule')) as { id: string };
      const memberRule = data(await saveRule(member, 'fixture-member-rule')) as { id: string };
      const change = (id: string, principalId: string, operationId: string) =>
        action === 'memory.save'
          ? saveRule(principalId, operationId, id)
          : surface.dispatch(
              {
                action,
                operationId,
                input: { memory_id: id, status: 'stale', reason: 'Fixture.' },
              },
              ruleTurn(principalId)
            );
      expect(await change(memberRule.id, member, 'fixture-member-change')).toMatchObject({
        status: 'completed',
      });
      expect(
        db.adapter.prepare('SELECT status FROM decisions WHERE id = ?').get(memberRule.id)
      ).toEqual({ status: action === 'memory.save' ? 'superseded' : 'stale' });
      expect(await change(ownerRule.id, member, 'fixture-member-owner-change')).toMatchObject({
        status: 'failed',
        error: { code: 'denied' },
      });
      expect(
        db.adapter.prepare('SELECT status FROM decisions WHERE id = ?').get(ownerRule.id)
      ).toEqual({ status: 'active' });
      expect(await change(ownerRule.id, OWNER, 'fixture-owner-change')).toMatchObject({
        status: 'completed',
      });
      expect(
        db.adapter.prepare('SELECT status FROM decisions WHERE id = ?').get(ownerRule.id)
      ).toEqual({ status: action === 'memory.save' ? 'superseded' : 'stale' });
    }
  );

  it('binds an unscoped member memory.save only to its user scope', async () => {
    const saved = data(
      await surface.dispatch(
        {
          action: 'memory.save',
          operationId: 'member-save-test',
          input: {
            topic: 'fixture-memory',
            kind: 'fact',
            summary: 'Personal fixture memory',
            details: 'Fixture details',
            source: { package: 'fixture-consumer', source_type: 'fixture' },
          },
        },
        { access: resolve() }
      )
    ) as { id: string };
    expect(
      db.adapter
        .prepare(
          `
      SELECT s.kind, s.external_id AS id FROM memory_scope_bindings b
      JOIN memory_scopes s ON s.id = b.scope_id WHERE b.memory_id = ?
    `
        )
        .all(saved.id)
    ).toEqual([{ kind: 'user', id: member }]);
  });

  it('refuses a member memory.save that names no scope, which would be readable by everyone', async () => {
    expect(
      await surface.dispatch(
        {
          action: 'memory.save',
          operationId: 'member-unbound-save-test',
          input: {
            topic: 'fixture-memory',
            kind: 'fact',
            summary: 'Unbound fixture memory',
            details: 'Fixture details',
            source: { package: 'fixture-consumer', source_type: 'fixture' },
            scopes: [],
          },
        },
        { access: resolve() }
      )
    ).toMatchObject({ status: 'failed', error: { code: 'INVALID_SCOPE' } });
  });

  it.each([
    [
      'work.revise',
      { commitmentId: 'commitment-test', summary: 'Fixture revision', set: { title: 'Changed' } },
    ],
    ['owner.messages', { since: 0 }],
  ])('denies member %s before its handler runs', async (action, input) => {
    expect(await surface.dispatch({ action, input }, { access: resolve() })).toMatchObject({
      status: 'failed',
      error: { kind: 'denied', code: 'action_not_granted' },
    });
  });

  it('lists only granted and unbound work, with no owner rows or hidden counts', async () => {
    // Seed a legacy unbound row through core; product writes require a nonempty binding.
    const writer = { ...surface.ownerAccess };
    delete writer.defaultScopes;
    for (const [commandId, scopes] of [
      ['owner-work-test', surface.ownerAccess.defaultScopes!],
      ['shared-work-test', [PARTITION]],
      ['unbound-work-test', []],
    ] as const) {
      await knowledge.createWork(
        {
          commandId,
          topic: 'fixture-work',
          summary: commandId,
          set: { title: commandId },
          scopes: [...scopes],
        },
        writer
      );
    }
    const listed = data(
      await surface.dispatch(
        { action: 'work.list', input: { view: 'items' } },
        {
          access: resolve(),
        }
      )
    ) as { tasks: Array<{ title: string }>; total: number; returned: number };
    expect(listed.total).toBe(2);
    expect(listed.returned).toBe(2);
    expect(listed.tasks.map((task) => task.title).sort()).toEqual([
      'shared-work-test',
      'unbound-work-test',
    ]);
  });

  it('lists exactly the member role in help, without the code_act wrapper', async () => {
    const text = data(
      await surface.dispatch({ action: 'help', input: {} }, { access: memberAccess() })
    ) as string;
    expect(
      text
        .split('\n')
        .slice(2)
        .map((line) => line.split(' — ')[0])
        .sort()
    ).toEqual(ROLE.filter((name) => name !== 'code_act').sort());
    expect(data(await surface.dispatch({ action: 'help', input: {} }, { access: resolve() }))).toBe(
      text
    );
  });

  it('keeps the owner procedures out of member help', async () => {
    const ownerTopic = await surface.dispatch(
      { action: 'help', input: { topic: 'fixture-procedure' } },
      { access: surface.ownerAccess }
    );
    expect(data(ownerTopic)).toContain('Owner procedure text.');
    const memberList = data(
      await surface.dispatch({ action: 'help', input: {} }, { access: resolve() })
    ) as string;
    expect(memberList).not.toContain('fixture-procedure');
    expect(
      await surface.dispatch(
        { action: 'help', input: { topic: 'fixture-procedure' } },
        { access: resolve() }
      )
    ).toMatchObject({ status: 'failed' });
  });

  it('refuses help for an ungranted action even by its Codex spelling', async () => {
    expect(
      await surface.dispatch(
        { action: 'help', input: { actions: ['owner_messages'] } },
        {
          access: memberAccess(),
        }
      )
    ).toMatchObject({ status: 'failed', error: { kind: 'invalid_input', code: 'invalid_input' } });
  });

  it('resolves only active source grants and keeps the own DM beside granted chat channels', () => {
    grant({ kind: 'source', connector: 'slack', channelId: 'room-granted-test' });
    grant({ kind: 'source', connector: 'chat', channelId: 'room-shared-test' });
    grant({ kind: 'source', connector: 'trello', channelId: 'board-revoked-test' });
    repository.revokeScope({
      targetPrincipalId: member,
      ownerPrincipalId: OWNER,
      now: 5,
      scope: { kind: 'source', connector: 'trello', channelId: 'board-revoked-test' },
    });
    const access = resolve();
    expect(access.connectors).toEqual(['chat', 'slack']);
    expect(access.channels).toEqual({
      chat: [`telegram:${DM}`, 'room-shared-test'],
      slack: ['room-granted-test'],
    });
    expect(access.destinations).toEqual([{ kind: 'telegram', id: DM }]);
    expect(access).not.toHaveProperty('connectorWideRead');
    repository.revokeScope({
      targetPrincipalId: member,
      ownerPrincipalId: OWNER,
      now: 6,
      scope: { kind: 'memory', scopeKind: 'project', scopeId: PARTITION.id },
    });
    expect(resolve().readScopes).toEqual([]);
  });

  it.each(ownerMemoryScopes(OWNER).filter((scope) => scope.kind !== 'user'))(
    'refuses a grant on the owner default scope $kind:$id',
    (scope) => {
      grant({
        kind: 'memory',
        scopeKind: scope.kind as 'project' | 'channel' | 'global',
        scopeId: scope.id,
      });
      expect(() => resolve()).toThrow(`${scope.kind}:${scope.id}`);
    }
  );

  it.each(['suspended', 'offboarded', 'unknown'] as const)(
    'fails loudly for a %s principal',
    (status) => {
      if (status === 'suspended') repository.suspend(member, 4);
      if (status === 'offboarded') repository.offboard(member, 4);
      expect(() => resolve(status === 'unknown' ? 'principal-unknown-test' : member)).toThrow(
        status
      );
    }
  );

  it.each(['absent', 'wrong namespace', 'ambiguous'] as const)(
    'refuses an %s private Telegram identity',
    (mode) => {
      if (mode === 'ambiguous') repository.bindIdentity(member, 'telegram', 'private', '20003', 4);
      else
        db.adapter
          .prepare('UPDATE external_identities SET namespace = ? WHERE principal_id = ?')
          .run(mode === 'absent' ? 'absent-test' : 'group', member);
      expect(() => resolve()).toThrow(/exactly one.*Telegram.*private/i);
    }
  );

  it('does not expose owner or other-member checkpoints and binds member checkpoints personally', async () => {
    const save = (access: ActionContext['access'], summary: string) =>
      surface.dispatch(
        {
          action: 'memory.checkpoint.save',
          input: { summary },
        },
        { access }
      );
    data(await save(surface.ownerAccess, 'Owner checkpoint fixture'));
    data(
      await save(
        { ...memberAccess(), principalId: 'member-other-test' },
        'Other checkpoint fixture'
      )
    );
    const access = memberAccess();
    const saved = data(await save(access, 'Personal checkpoint fixture')) as { id: string };
    const listed = data(
      await surface.dispatch({ action: 'memory.checkpoint.list', input: {} }, { access })
    );
    expect(listed).toMatchObject({
      count: 1,
      checkpoints: [{ summary: 'Personal checkpoint fixture' }],
    });
    expect(
      db.adapter
        .prepare(
          `
      SELECT s.kind, s.external_id AS id FROM checkpoint_scope_bindings b
      JOIN memory_scopes s ON s.id = b.scope_id WHERE b.checkpoint_id = ?
    `
        )
        .all(saved.id)
    ).toEqual([{ kind: 'user', id: member }]);
    expect(
      data(
        await surface.dispatch(
          { action: 'memory.checkpoint.list', input: {} },
          {
            access: surface.ownerAccess,
          }
        )
      )
    ).toMatchObject({ count: 1, checkpoints: [{ summary: 'Owner checkpoint fixture' }] });
  });
});
