import fs from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createPrincipalRepository, type ActionResult } from '@jungjaehoon/mama-core';
import { fixture } from '../helpers/member-runtime.js';
import { memberPaths } from '../../src/runtime/member-paths.js';
import { upsertConnectorEventIndex } from '../../src/connectors/framework/event-index.js';
import { resolvePrincipalAccess } from '../../src/runtime/principal-access.js';

function completed(result: ActionResult) {
  expect(result.status, JSON.stringify(result)).toBe('completed');
  return (result as { data: Record<string, unknown> }).data;
}

it.each(['codex', 'claude'] as const)(
  'manages from an owner DM and an owner-sent common turn (%s)',
  async (backend) => {
    const f = await fixture(backend);
    completed((await f.actAs(f.managingOwner, 'manage.member.list')).result);
    const plain = resolvePrincipalAccess(f.member, {
      adapter: f.runtime.database.adapter,
      ownerAccess: f.runtime.surface.ownerAccess,
      agentId: 'fixture-agent',
    });
    expect(plain.actions.some((name) => name.startsWith('manage.member.'))).toBe(false);
    completed(
      await f.manage('grant', {
        principalId: f.member,
        scopeKind: 'project',
        scopeId: 'fixture-partition',
      })
    );
    const repo = createPrincipalRepository(f.runtime.database.adapter);
    expect(
      f.runtime.database.adapter
        .prepare('SELECT granted_by_principal_id FROM principal_scope_grants WHERE principal_id=?')
        .all(f.member)
    ).toEqual([{ granted_by_principal_id: 'owner' }]);
    const traces = f.runtime.database.adapter
      .prepare("SELECT input_summary FROM tool_traces WHERE tool_name='manage.member.grant'")
      .all();
    expect(JSON.stringify(traces)).toContain(f.managingOwner);
    const dm = await f.actAs(f.managingOwner, 'manage.member.revoke', {
      principalId: f.member,
      scopeKind: 'project',
      scopeId: 'fixture-partition',
    });
    completed(dm.result);
    expect(repo.listActiveGrants(f.member)).toEqual([]);
  }
);

it.each([
  'plain DM',
  'plain common sender',
  'delta',
  'scheduled',
  'replay',
  'subagent',
  'wrong DM',
  'discord common',
  'slack common',
])('refuses management from %s even with stale action grants', async (origin) => {
  const f = await fixture();
  const positive = await f.actAs(f.managingOwner, 'manage.member.list');
  completed(positive.result);
  await f.settled(positive.ref, f.managingOwner);
  const ownerAccess = resolvePrincipalAccess(f.managingOwner, {
    adapter: f.runtime.database.adapter,
    ownerAccess: f.runtime.surface.ownerAccess,
    agentId: 'fixture-agent',
  });
  const unattributed = origin === 'discord common' || origin === 'slack common';
  const common =
    origin === 'plain common sender' ||
    origin === 'delta' ||
    origin === 'scheduled' ||
    unattributed;
  const ref = common
    ? f.message('owner', 'fixture common', f.member)
    : origin === 'plain DM'
      ? f.message(f.member)
      : positive.ref;
  if (common || origin === 'plain DM') await f.settled(ref, common ? 'owner' : f.member);
  let sourceRef = ref;
  if (unattributed) {
    sourceRef = `${origin.split(' ')[0]}:fixture:message`;
    f.runtime.database.adapter
      .prepare('UPDATE mailbox_inputs SET stimulus_id=?, payload_json=? WHERE stimulus_id=?')
      .run(sourceRef, JSON.stringify({ text: 'fixture common' }), ref);
  }
  const context = {
    access: common
      ? f.runtime.surface.ownerAccess
      : {
          ...ownerAccess,
          principalId: origin === 'plain DM' ? f.member : f.managingOwner,
        },
    session: {
      sourceMessageRef:
        origin === 'subagent'
          ? 'subagent:fixture'
          : origin === 'wrong DM'
            ? f.message(f.member)
            : sourceRef,
      ...(origin === 'replay' ? { replaySourceEndMs: 1 } : {}),
    },
  };
  if (origin === 'delta' || origin === 'scheduled') {
    f.runtime.database.adapter
      .prepare('UPDATE mailbox_inputs SET kind=? WHERE stimulus_id=?')
      .run(origin === 'delta' ? 'source_delta' : 'scheduled', ref);
  }
  for (const action of ['manage.member.list', 'manage.member.suspend', 'manage.member.enroll']) {
    const result = await f.runtime.surface.dispatch(
      {
        action,
        input: action.endsWith('suspend') ? { principalId: f.member } : {},
      },
      context
    );
    expect(result).toMatchObject({ status: 'failed', error: { kind: 'denied' } });
    if (unattributed)
      expect(result).toMatchObject({
        error: { message: expect.stringContaining("registered person's message turn") },
      });
  }
  expect(createPrincipalRepository(f.runtime.database.adapter).findById(f.member)?.status).toBe(
    'active'
  );
});

it('suspends another owner, denies its next DM, and resumes it with roles, grants and a fresh environment', async () => {
  const f = await fixture();
  const repo = createPrincipalRepository(f.runtime.database.adapter);
  repo.grantScope({
    targetPrincipalId: f.member,
    ownerPrincipalId: 'owner',
    now: 3,
    scope: { kind: 'memory', scopeKind: 'project', scopeId: 'fixture-partition' },
  });
  repo.grantRole({ principalId: f.member, role: 'owner', now: 4 });
  const prior = f.message(f.member);
  await f.settled(prior, f.member);
  const oldSession = f.turns.at(-1)!.session;
  const intake = f.runtime.serveMember(f.member);
  const path = join(memberPaths(f.root, f.member).workspaceDir, 'old.txt');
  fs.writeFileSync(path, 'fixture old file');
  completed(
    (await f.actAs(f.managingOwner, 'manage.member.suspend', { principalId: f.member })).result
  );
  expect(repo.findById(f.member)?.status).toBe('suspended');
  expect(repo.listRoles(f.member)).toMatchObject([{ role: 'owner' }]);
  expect(repo.listRetainedGrants(f.member)).toHaveLength(1);
  const turns = f.turns.length;
  expect(() =>
    intake.acceptOwnerMessage({
      id: 'telegram:fixture:refused',
      channelKey: 'fixture',
      occurredAt: 10,
      text: 'fixture',
    })
  ).toThrow(/suspended|served/);
  expect(f.turns).toHaveLength(turns);
  completed(
    (await f.actAs(f.managingOwner, 'manage.member.resume', { principalId: f.member })).result
  );
  expect(fs.existsSync(path)).toBe(false);
  await f.settled(f.message(f.member), f.member);
  expect(f.turns.at(-1)).toMatchObject({ principal: f.member, fresh: true });
  expect(f.turns.at(-1)!.session).not.toBe(oldSession);
  expect(repo.listActiveGrants(f.member)).toHaveLength(1);
});

it('refuses self-suspend, owner offboard, grant/revoke and every common-principal target with plain reasons', async () => {
  const f = await fixture();
  const repo = createPrincipalRepository(f.runtime.database.adapter);
  repo.grantRole({ principalId: f.member, role: 'owner', now: 4 });
  completed((await f.actAs(f.managingOwner, 'manage.member.list')).result);
  for (const [change, target, reason] of [
    ['suspend', f.managingOwner, /yourself/],
    ['offboard', f.member, /owner/],
    ['grant', f.member, /owner/],
    ['revoke', f.member, /owner/],
    ...['suspend', 'resume', 'offboard', 'grant', 'revoke'].map((change) => [
      change,
      'owner',
      /common/,
    ]),
  ] as Array<[string, string, RegExp]>) {
    const result = (
      await f.actAs(f.managingOwner, `manage.member.${change}`, {
        principalId: target,
        ...(['grant', 'revoke'].includes(change)
          ? { scopeKind: 'project', scopeId: 'fixture-partition' }
          : {}),
      })
    ).result;
    expect(result).toMatchObject({
      status: 'failed',
      error: { kind: 'denied', message: expect.stringMatching(reason) },
    });
  }
  expect(repo.findById(f.managingOwner)?.status).toBe('active');
  expect(repo.findById(f.member)?.status).toBe('active');
});

it('rechecks the caller on the shared chain when two owners concurrently suspend each other', async () => {
  const f = await fixture();
  const repo = createPrincipalRepository(f.runtime.database.adapter);
  repo.grantRole({ principalId: f.member, role: 'owner', now: 4 });
  completed((await f.actAs(f.managingOwner, 'manage.member.list')).result);
  const first = f.manage('suspend', { principalId: f.member }, f.managingOwner);
  const second = f.message('owner', 'fixture concurrent suspension', f.member, {
    action: 'manage.member.suspend',
    input: { principalId: f.managingOwner },
  });
  completed(await first);
  await f.settled(second);
  expect(
    f.runtime.database.adapter
      .prepare('SELECT last_error FROM mailbox_inputs WHERE stimulus_id=?')
      .get(second)
  ).toEqual({ last_error: 'inactive_owner_sender' });
  expect(
    [f.managingOwner, f.member].filter((id) => repo.findById(id)?.status === 'active')
  ).toHaveLength(1);
});

it('skips pending and claimed common messages from a suspended owner while another owner messages still run', async () => {
  const f = await fixture();
  createPrincipalRepository(f.runtime.database.adapter).grantRole({
    principalId: f.member,
    role: 'owner',
    now: 4,
  });
  let release!: () => void;
  f.blockOwner(
    new Promise<void>((resolve) => {
      release = resolve;
    })
  );
  const before = f.turns.length;
  const suspend = f.manage('suspend', { principalId: f.member });
  try {
    await vi.waitFor(() => expect(f.turns).toHaveLength(before + 1));
    const claimed = f.message('owner', 'SUSPENDED_GROUP_CLAIMED', f.member);
    const mailbox = f.runtime.runtime.mailbox!;
    await vi.waitFor(() => expect(mailbox.readInput(claimed, 'owner')?.status).toBe('claimed'));
    for (const [id, senderPrincipalId, text] of [
      ['telegram:fixture:pending', f.member, 'SUSPENDED_GROUP_PENDING'],
      ['telegram:fixture:active', f.managingOwner, 'ACTIVE_OWNER_GROUP'],
    ])
      mailbox.enqueue({
        id,
        kind: 'owner_message',
        principalId: 'owner',
        channelKey: 'fixture',
        occurredAt: 50,
        refs: [],
        payload: { text, senderPrincipalId },
      });
    expect(mailbox.readInput('telegram:fixture:pending', 'owner')?.status).toBe('pending');
    release();
    f.blockOwner(undefined);
    completed(await suspend);
    await Promise.all(
      [claimed, 'telegram:fixture:pending', 'telegram:fixture:active'].map((ref) => f.settled(ref))
    );
    for (const ref of [claimed, 'telegram:fixture:pending']) {
      expect(
        f.runtime.database.adapter
          .prepare('SELECT last_error FROM mailbox_inputs WHERE stimulus_id=?')
          .get(ref)
      ).toEqual({ last_error: 'inactive_owner_sender' });
      expect(
        f.runtime.database.adapter
          .prepare(
            "SELECT 1 FROM model_runs WHERE json_extract(input_refs_json, '$.sourceMessageRef')=?"
          )
          .get(ref)
      ).toBeUndefined();
    }
    expect(f.turns.some(({ prompt }) => prompt.includes('SUSPENDED_GROUP_'))).toBe(false);
    expect(f.turns.some(({ prompt }) => prompt.includes('ACTIVE_OWNER_GROUP'))).toBe(true);
  } finally {
    release();
    f.blockOwner(undefined);
  }
});

it('sets common timezone only for the recorded active owner sender and keeps DM administration out of common config', async () => {
  const f = await fixture();
  completed((await f.actAs(f.managingOwner, 'manage.member.list')).result);
  fs.writeFileSync(join(f.home, 'config.yaml'), 'version: 1\ntimezone: UTC\n');
  const ownerRef = f.message('owner');
  await f.settled(ownerRef);
  completed(
    await f.runtime.surface.hostToolCall(
      'owner.timezone.set',
      { timeZone: 'Europe/Paris' },
      'fixture-timezone',
      {
        session: { sourceMessageRef: ownerRef },
      }
    )
  );
  const plainRef = f.message('owner', 'fixture timezone', f.member);
  await f.settled(plainRef);
  const denied = await f.runtime.surface.hostToolCall(
    'owner.timezone.set',
    { timeZone: 'UTC' },
    'fixture-plain-timezone',
    {
      session: { sourceMessageRef: plainRef },
    }
  );
  expect(denied).toMatchObject({ status: 'failed', error: { code: 'denied' } });
  expect(
    (await f.actAs(f.managingOwner, 'owner.timezone.set', { timeZone: 'UTC' })).result
  ).toMatchObject({ status: 'failed' });
  expect(fs.readFileSync(join(f.home, 'config.yaml'), 'utf8')).toContain('Europe/Paris');
});

it('reads an owner DM share and its history in the next common delta turn', async () => {
  const f = await fixture();
  const input = {
    topic: 'fixture-shared-history',
    kind: 'fact',
    summary: 'Initial personal finding',
    details: 'Fixture initial evidence',
    source: { package: 'fixture', source_type: 'fixture' },
  };
  const first = completed((await f.actAs(f.managingOwner, 'memory.save', input)).result)
    .id as string;
  const second = completed(
    (
      await f.actAs(f.managingOwner, 'memory.save', {
        ...input,
        summary: 'Current personal finding',
        replaces: [{ id: first, reason: 'Fixture correction' }],
      })
    ).result
  ).id as string;
  const shared = completed(
    (
      await f.actAs(f.managingOwner, 'memory.share', {
        memory_id: second,
        reason: 'Share the finding with common work',
      })
    ).result
  ).id as string;
  const deltaAt = Date.now();
  upsertConnectorEventIndex(f.runtime.database.adapter, {
    source_connector: 'fixture',
    source_type: 'message',
    source_id: 'fixture-share-delta',
    channel: 'fixture-common-source',
    content: 'Fixture delta',
    source_timestamp_ms: deltaAt,
  });
  const observation = f.runtime.database.adapter
    .prepare('SELECT current_observation_id AS ref FROM connector_event_index WHERE source_id=?')
    .get('fixture-share-delta') as { ref: string };
  const result = completed(
    await f.actDelta(
      'memory.read:record',
      { memory_id: shared },
      {
        kind: 'source_delta',
        collector: 'fixture',
        channel: 'fixture-common-source',
        coalesceKey: 'fixture-share-delta',
        occurredAt: deltaAt,
        preview: ['Fixture delta'],
        refs: [
          {
            connector: 'fixture',
            observationRef: observation.ref,
            sourceId: 'fixture-share-delta',
            sourceEntityId: 'fixture-share-delta',
            channel: 'fixture-common-source',
            sourceAt: new Date(deltaAt).toISOString(),
            observedAt: new Date(deltaAt + 1).toISOString(),
            contentHash: null,
          },
        ],
      }
    )
  );
  const record = result.record as { summary: string; details: string };
  expect(f.turns.at(-1)!.principal).toBe('owner');
  expect(record.summary).toBe('Current personal finding');
  expect(JSON.parse(record.details)).toMatchObject({
    current: { id: second },
    revisions: [{ id: first, summary: 'Initial personal finding' }],
  });
});
