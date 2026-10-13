import { expect, it } from 'vitest';
import { createPrincipalRepository, type ActionResult } from '@jungjaehoon/mama-core';
import { fixture } from '../helpers/member-runtime.js';
import { resolvePrincipalAccess } from '../../src/runtime/principal-access.js';

function completed(result: ActionResult) {
  expect(result.status, JSON.stringify(result)).toBe('completed');
  return (result as { data: Record<string, unknown> }).data;
}

it.each(['codex', 'claude'] as const)(
  'an owner names itself in its DM and a member in the common channel (%s)',
  async (backend) => {
    const f = await fixture(backend);
    completed(
      (
        await f.actAs(f.managingOwner, 'manage.member.name', {
          principalId: f.managingOwner,
          name: '  Fixture owner  ',
        })
      ).result
    );
    completed(await f.manage('name', { principalId: f.member, name: 'Fixture member' }));
    const repo = createPrincipalRepository(f.runtime.database.adapter);
    expect(repo.findById(f.managingOwner)).toMatchObject({ displayName: 'Fixture owner' });
    expect(repo.findById(f.member)).toMatchObject({ displayName: 'Fixture member' });
    const receipts = f.runtime.database.adapter
      .prepare(
        `SELECT m.author, m.memory_scope_id AS scope, r.content
     FROM connector_event_index m JOIN connector_event_index r
       ON r.source_id = m.source_id || ':reply'
     WHERE json_extract(m.metadata_json, '$.input.managementAction') = 'manage.member.name'`
      )
      .all() as Array<{ author: string; scope: string; content: string }>;
    expect(receipts).toHaveLength(2);
    expect(
      receipts.every(({ author, scope }) => author === f.managingOwner && scope === 'owner')
    ).toBe(true);
    expect(receipts.map(({ content }) => JSON.parse(content).result.status)).toEqual([
      'completed',
      'completed',
    ]);
    const list = completed((await f.actAs(f.managingOwner, 'manage.member.list')).result);
    expect(list.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          principalId: f.managingOwner,
          displayName: 'Fixture owner',
          roles: ['owner'],
        }),
        expect.objectContaining({ principalId: f.member, displayName: 'Fixture member' }),
      ])
    );
  }
);

it.each(['plain DM', 'plain common', 'delta', 'scheduled', 'replay', 'subagent', 'wrong DM'])(
  'refuses naming from %s even with stale owner grants',
  async (origin) => {
    const f = await fixture();
    const access = resolvePrincipalAccess(f.managingOwner, {
      adapter: f.runtime.database.adapter,
      ownerAccess: f.runtime.surface.ownerAccess,
      agentId: 'fixture-agent',
    });
    const common = ['plain common', 'delta', 'scheduled'].includes(origin);
    const principal = common ? 'owner' : origin === 'plain DM' ? f.member : f.managingOwner;
    const ref = f.message(
      principal,
      'fixture request',
      origin === 'plain common' ? f.member : f.managingOwner
    );
    await f.settled(ref, principal);
    if (origin === 'delta' || origin === 'scheduled')
      f.runtime.database.adapter
        .prepare('UPDATE mailbox_inputs SET kind=? WHERE stimulus_id=?')
        .run(origin === 'delta' ? 'source_delta' : 'scheduled', ref);
    const result = await f.runtime.surface.dispatch(
      {
        action: 'manage.member.name',
        input: { principalId: f.member, name: 'Refused name' },
      },
      {
        access: common ? f.runtime.surface.ownerAccess : { ...access, principalId: principal },
        session: {
          sourceMessageRef:
            origin === 'subagent'
              ? 'subagent:fixture'
              : origin === 'wrong DM'
                ? f.message(f.member)
                : ref,
          ...(origin === 'replay' ? { replaySourceEndMs: 1 } : {}),
        },
      }
    );
    expect(result).toMatchObject({ status: 'failed', error: { kind: 'denied' } });
    expect(
      createPrincipalRepository(f.runtime.database.adapter).findById(f.member)
    ).not.toHaveProperty('displayName');
  }
);

it('refuses naming the common principal and unknown principals, and rejects invalid names', async () => {
  const f = await fixture();
  completed(await f.manage('name', { principalId: f.member, name: 'Kept name' }));
  for (const principalId of ['owner', 'missing']) {
    const result = await f.manage('name', { principalId, name: 'Refused name' });
    expect(result.status).toBe('failed');
  }
  for (const name of ['', '   ', 'x'.repeat(121)])
    expect((await f.manage('name', { principalId: f.member, name })).status).toBe('failed');
  expect(createPrincipalRepository(f.runtime.database.adapter).findById(f.member)).toMatchObject({
    displayName: 'Kept name',
  });
});

it.each(['codex', 'claude'] as const)(
  'shows registry names in DM and common headers, and exchange authors; keeps unnamed ids (%s)',
  async (backend) => {
    const f = await fixture(backend);
    const repo = createPrincipalRepository(f.runtime.database.adapter);
    repo.grantRole({ principalId: f.member, role: 'owner', now: 4 });
    f.runtime.database.adapter
      .prepare('UPDATE principals SET display_name=? WHERE principal_id=?')
      .run('Fixture second owner', f.member);
    f.runtime.database.adapter
      .prepare('UPDATE principals SET display_name=? WHERE principal_id=?')
      .run('Fixture common session', 'owner');
    const dm = f.message(f.member, 'fixture personal request');
    await f.settled(dm, f.member);
    const dmPrompt = JSON.parse(f.turns.at(-1)!.prompt) as string;
    expect(dmPrompt).toContain(`yours: Fixture second owner (${f.member}, owner)`);
    f.runtime.serveMember(f.member).recordOwnerReply({
      messageRef: dm,
      text: 'fixture delivered answer',
      occurredAt: 10,
      author: 'agent',
      deliveryVerified: true,
    });
    const nextDm = f.message(f.member, 'fixture next personal request');
    await f.settled(nextDm, f.member);
    await f.natives.get(f.member)!.resetSession(`member:${f.member}:runtime`);
    await f.settled(f.message(f.member, 'fixture fresh personal session'), f.member);
    expect(JSON.parse(f.turns.at(-1)!.prompt) as string).toContain(
      `person · from Fixture second owner (${f.member}, owner): fixture personal request`
    );
    for (const [index, sender] of [f.member, f.managingOwner, 'owner'].entries())
      f.runtime.recordHostExchange({
        message: {
          id: `telegram:fixture:named-history-${index}`,
          channelKey: 'fixture',
          occurredAt: index + 1,
          text: `fixture history ${index}`,
          senderPrincipalId: sender,
        },
        reply: { text: 'fixture reply', occurredAt: index + 2, deliveryVerified: true },
      });
    await f.settled(f.message('owner', 'fixture common request', f.member));
    const commonPrompt = JSON.parse(f.turns.at(-1)!.prompt) as string;
    expect(commonPrompt).toContain(`from Fixture second owner (${f.member}, owner)`);
    expect(commonPrompt).toContain(
      `from Fixture second owner (${f.member}, owner): fixture history 0`
    );
    expect(commonPrompt).toContain(`from ${f.managingOwner} (owner): fixture history 1`);
    expect(commonPrompt).not.toContain('from owner');
    expect(commonPrompt).not.toContain('Fixture common session');
    const list = completed((await f.actAs(f.managingOwner, 'manage.member.list')).result);
    expect(list.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ principalId: f.member, displayName: 'Fixture second owner' }),
        expect.objectContaining({ principalId: f.managingOwner, roles: ['owner'] }),
      ])
    );
    const unnamed = (list.members as Array<Record<string, unknown>>).find(
      ({ principalId }) => principalId === f.managingOwner
    )!;
    expect(unnamed).not.toHaveProperty('displayName');
  }
);
