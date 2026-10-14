import { expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { createPrincipalRepository, type ActionResult } from '@jungjaehoon/mama-core';
import { fixture, roots } from '../helpers/member-runtime.js';
import { memberRoomClaudeTmpDir } from '../../src/runtime/member-paths.js';
import {
  memberRoomSessionKey,
  resolvePrincipalAccess,
} from '../../src/runtime/principal-access.js';

const partition = { kind: 'project' as const, id: 'fixture-room-partition' };
function data(result: ActionResult): Record<string, unknown> {
  expect(result.status, JSON.stringify(result)).toBe('completed');
  return (result as { data: Record<string, unknown> }).data;
}

it.each(['codex', 'claude'] as const)(
  'keeps room context separate and persistent, writes attributed work, and exposes it to the next common delta (%s)',
  async (backend) => {
    const f = await fixture(backend);
    const repository = createPrincipalRepository(f.runtime.database.adapter);
    repository.grantScope({
      targetPrincipalId: f.member,
      ownerPrincipalId: 'owner',
      now: 4,
      scope: { kind: 'memory', scopeKind: 'project', scopeId: partition.id },
    });
    const save = async (scope: typeof partition | { kind: 'user'; id: string }, marker: string) =>
      data(
        await f.runtime.surface.hostToolCall(
          'memory.save',
          {
            topic: marker,
            kind: 'decision',
            summary: marker,
            details: marker,
            scopes: [scope],
            source: { package: 'fixture', source_type: 'fixture' },
          },
          `save-${marker}`,
          { access: { ...f.runtime.surface.ownerAccess, scopes: [scope] } }
        )
      ).id as string;
    const personal = await save({ kind: 'user', id: f.member }, 'PRIVATE_ROOM_MARKER');
    const denied = await save({ kind: 'project', id: 'ungranted' }, 'DENIED_ROOM_MARKER');
    const granted = await save(partition, 'GRANTED_ROOM_MARKER');
    await f.settled(f.message(f.member, 'PRIVATE_DM_MESSAGE'), f.member);
    const dm = f.turns.at(-1)!;
    f.read([personal, denied, granted]);
    const first = f.roomMessage('Create shared work', {
      action: 'work.create',
      input: {
        topic: 'room-case',
        summary: 'ROOM_WORK_CHANGE',
        scopes: [partition],
        set: { title: 'Room work' },
      },
    });
    await f.settled(first, f.member);
    const work = data(f.resultFor(first)!);
    const room = f.turns.at(-1)!;
    expect(room.access.scopes).toEqual([partition]);
    expect(room.access.defaultScopes).toEqual([]);
    expect(room.prompt).not.toContain('PRIVATE_ROOM_MARKER');
    expect(room.prompt).not.toContain('PRIVATE_DM_MESSAGE');
    expect(room.prompt).not.toContain('DENIED_ROOM_MARKER');
    expect(room.session).not.toBe(dm.session);
    expect(f.drivers.get(f.member)!.workspaceDir).not.toBe(
      f.runtime.principalPaths(f.member).workspaceDir
    );
    expect(f.drivers.get(f.member)!.deniedReadPaths).toContain(join(f.root, f.member, 'workspace'));
    expect(f.drivers.get(f.member)!.deniedReadPaths).toContain(join(f.root, f.member, 'downloads'));
    const key = memberRoomSessionKey(f.member, '-100');
    expect(f.pool.peekSession(key).sessionId).toBeDefined();
    const roomTemp = memberRoomClaudeTmpDir(f.member, '-100');
    mkdirSync(roomTemp, { recursive: true });
    roots.push(roomTemp);
    const deniedBefore = [...f.drivers.get(f.member)!.deniedReadPaths!];
    const second = f.roomMessage('Read permitted work');
    await f.settled(second, f.member);
    expect(f.drivers.get(f.member)!.deniedReadPaths).toEqual(deniedBefore);
    expect(f.turns.at(-1)!.policyFingerprint).toBe(room.policyFingerprint);
    expect(f.turns.at(-1)!.session).toBe(room.session);
    expect(f.turns.at(-1)!.fresh).toBe(false);
    expect(f.drivers.get(f.member)!.deniedReadPaths).not.toContain(realpathSync(roomTemp));
    const reads = f.reads.at(-1)!;
    expect(data(reads[0]).record).toBeNull();
    expect(data(reads[1]).record).toBeNull();
    expect(data(reads[2]).record).toBeTruthy();
    const search = f.roomMessage('Find ungranted project', {
      action: 'memory.search',
      input: { query: 'DENIED_ROOM_MARKER', includeRelated: false },
    });
    await f.settled(search, f.member);
    expect(data(f.resultFor(search)!).results).toEqual([]);
    const rows = f.runtime.database.adapter
      .prepare(
        'SELECT b.principal_id, d.agent_id FROM command_bindings b JOIN decisions d ON d.id=b.receipt_key WHERE d.summary=?'
      )
      .all('ROOM_WORK_CHANGE');
    expect(rows).toEqual([{ principal_id: f.member, agent_id: `member-agent:${f.member}` }]);
    expect(
      f.runtime.database.adapter
        .prepare(
          "SELECT json_extract(r.input_refs_json, '$.principalId') AS principal, r.agent_id FROM tool_traces t JOIN model_runs r ON r.model_run_id=t.model_run_id WHERE t.tool_name=?"
        )
        .all('work.create')
    ).toEqual([{ principal: f.member, agent_id: `member-agent:${f.member}` }]);
    const at = Date.now();
    const delta = await f.actDelta(
      'work.show',
      { commitmentId: work.commitmentId },
      {
        kind: 'source_delta',
        collector: 'fixture',
        channel: 'fixture-source',
        coalesceKey: 'room-delta',
        preview: ['Next source update'],
        refs: [
          {
            connector: 'fixture',
            sourceId: 'next',
            sourceEntityId: 'next',
            observationRef: 'fixture-next',
            sourceAt: new Date(at).toISOString(),
            observedAt: new Date(at).toISOString(),
            contentHash: null,
          },
        ],
      }
    );
    expect(JSON.stringify(data(delta))).toContain('Room work');
    const commonTurn = f.turns.find((turn) => turn.principal === 'owner')!;
    expect(commonTurn.prompt).toContain('ROOM_WORK_CHANGE');
    expect(
      f.runtime.database.adapter
        .prepare('SELECT author, memory_scope_id FROM connector_event_index WHERE source_id=?')
        .get(first)
    ).toEqual({ author: f.member, memory_scope_id: 'owner' });
  }
);

it.each(['codex', 'claude'] as const)(
  'accepts room policy with member attribution but refuses the member DM (%s)',
  async (backend) => {
    const f = await fixture(backend);
    const policy = data(
      await f.runtime.surface.hostToolCall('manage.policy.read', {}, 'read-policy')
    );
    const input = {
      text: 'Room policy correction.',
      fingerprint: policy.fingerprint,
      reason: 'Member common-channel correction',
    };
    const ref = f.roomMessage('Correct standing policy', { action: 'manage.policy.update', input });
    await f.settled(ref, f.member);
    const revision = data(f.resultFor(ref)!);
    expect(
      f.runtime.database.adapter
        .prepare(
          'SELECT b.principal_id, d.agent_id FROM command_bindings b JOIN decisions d ON d.id=b.receipt_key WHERE d.id=?'
        )
        .get(revision.revisionId)
    ).toEqual({ principal_id: f.member, agent_id: `member-agent:${f.member}` });
    const dm = await f.act('manage.policy.update', input);
    expect(dm.result.status).not.toBe('completed');
  }
);

it('recovers a queued room input after restart in the same room with current grants', async () => {
  const f = await fixture();
  let release!: () => void;
  const block = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.blockMember(block);
  const first = f.roomMessage('first room message');
  await vi.waitFor(() => expect(f.turns.at(-1)?.principal).toBe(f.member));
  const pending = f.roomMessage('pending room message');
  const restarting = f.restart();
  release();
  await restarting;
  f.blockMember(undefined);
  await f.settled(pending, f.member);
  const row = f.runtime.runtime.mailbox!.readInput(pending, f.member)!;
  expect(row.payload).toMatchObject({ roomChannel: '-100', senderPrincipalId: f.member });
  expect(f.turns.at(-1)!.access.channels?.chat).toEqual(['telegram:-100']);
  expect(f.runtime.runtime.mailbox!.readInput(first, 'owner')).toBeNull();
});

it('resolves action socket calls in the active room and rechecks revoked grants', async () => {
  const f = await fixture();
  const repository = createPrincipalRepository(f.runtime.database.adapter);
  repository.grantScope({
    targetPrincipalId: f.member,
    ownerPrincipalId: 'owner',
    now: 4,
    scope: { kind: 'memory', scopeKind: 'project', scopeId: partition.id },
  });
  let release!: () => void;
  f.blockMember(
    new Promise<void>((resolve) => {
      release = resolve;
    })
  );
  const ref = f.roomMessage('active room');
  await vi.waitFor(() => expect(f.turns.at(-1)?.principal).toBe(f.member));
  const access = resolvePrincipalAccess(f.member, {
    adapter: f.runtime.database.adapter,
    ownerAccess: f.runtime.surface.ownerAccess,
    agentId: `member-agent:${f.member}`,
  });
  const facts = f.socketOptions.sessionFacts!(access, { session: {}, credential: '' } as never);
  expect(facts).toMatchObject({ sourceMessageRef: ref, channelId: '-100' });
  const input = {
    topic: 'socket-room',
    summary: 'socket room write',
    scopes: [partition],
    set: { title: 'Socket room work' },
  };
  try {
    data(
      await f.socketOptions.dispatch(
        { action: 'work.create', input, operationId: 'socket-room-work' },
        { access, session: facts }
      )
    );
    repository.revokeScope({
      targetPrincipalId: f.member,
      ownerPrincipalId: 'owner',
      now: 5,
      scope: { kind: 'memory', scopeKind: 'project', scopeId: partition.id },
    });
    expect(
      (
        await f.socketOptions.dispatch(
          { action: 'work.create', input, operationId: 'socket-room-revoked' },
          { access, session: facts }
        )
      ).status
    ).not.toBe('completed');
  } finally {
    release();
  }
  await f.settled(ref, f.member);
  f.blockMember(undefined);
  const next = f.roomMessage('After grant revocation');
  await f.settled(next, f.member);
  expect(f.turns.at(-1)!.fresh).toBe(true);
  expect(f.turns.at(-1)!.access.scopes).toEqual([]);
});

it('protects a future peer room temp directory without discarding the running room context', async () => {
  const f = await fixture('claude');
  const peer = createPrincipalRepository(f.runtime.database.adapter).registerMember({
    connector: 'telegram',
    namespace: 'private',
    externalId: 'fixture-room-peer',
    now: 4,
  });
  await f.runtime.serveMember(peer);
  const first = f.roomMessage('First room turn');
  await f.settled(first, f.member);
  const before = f.turns.at(-1)!;
  const denies = [...f.drivers.get(f.member)!.deniedReadPaths!];
  const peerPaths = f.runtime.principalPaths(peer, '-101');
  const settings = JSON.parse(
    readFileSync(join(peerPaths.workspaceDir, '.claude', 'settings.json'), 'utf8')
  );
  mkdirSync(settings.env.CLAUDE_CODE_TMPDIR, { recursive: true });
  const peerTemp = realpathSync(settings.env.CLAUDE_CODE_TMPDIR);
  roots.push(peerTemp);
  expect(denies.some((path) => peerTemp === path || peerTemp.startsWith(`${path}/`))).toBe(true);
  const second = f.roomMessage('Second room turn');
  await f.settled(second, f.member);
  expect(f.turns.at(-1)!.session).toBe(before.session);
  expect(f.drivers.get(f.member)!.deniedReadPaths).toEqual(denies);
});

it.each(['codex', 'claude'] as const)(
  'keeps the first room session when a second configured group starts (%s)',
  async (backend) => {
    const f = await fixture(backend);
    const first = f.roomMessage('first group');
    await f.settled(first, f.member);
    const session = f.turns.at(-1)!.session;
    const denies = [...f.drivers.get(f.member)!.deniedReadPaths!];
    const other = f.roomMessage('second group', undefined, '-200');
    await f.settled(other, f.member);
    const latestDriver = f.drivers.get(f.member);
    const otherRoot = f.runtime.principalPaths(f.member, '-200').workspaceDir;
    expect(denies.some((path) => otherRoot.startsWith(`${path}/`))).toBe(true);
    const again = f.roomMessage('first group again');
    await f.settled(again, f.member);
    expect(f.turns.at(-1)!.session).toBe(session);
    expect(f.turns.at(-1)!.fresh).toBe(false);
    expect(f.drivers.get(f.member)).toBe(latestDriver);
  }
);

it('refuses policy changes from another allowed group and describes room capabilities', async () => {
  const f = await fixture();
  const policy = data(
    await f.runtime.surface.hostToolCall('manage.policy.read', {}, 'policy-before')
  );
  const ref = f.roomMessage(
    'change policy in another group',
    {
      action: 'manage.policy.update',
      input: { text: 'Other policy', fingerprint: policy.fingerprint, reason: 'Other room' },
    },
    '-200'
  );
  await f.settled(ref, f.member);
  // Another allowed group's room is not granted owner policy at all.
  expect(f.resultFor(ref)).toMatchObject({
    status: 'failed',
    error: { code: 'action_not_granted' },
  });
  expect(
    data(await f.runtime.surface.hostToolCall('manage.policy.read', {}, 'policy-after')).fingerprint
  ).toBe(policy.fingerprint);
  expect(f.turns.at(-1)!.standing).toContain('Partition work');
  expect(f.turns.at(-1)!.standing).not.toContain('owner rules may be corrected');
});

it('durably reroutes a queued common message after owner role loss, once across restart', async () => {
  const f = await fixture();
  let releaseRoom!: () => void;
  f.blockPrincipal(
    f.managingOwner,
    new Promise<void>((resolve) => {
      releaseRoom = resolve;
    })
  );
  let release!: () => void;
  f.blockOwner(
    new Promise<void>((resolve) => {
      release = resolve;
    })
  );
  const blocker = f.message('owner', 'block common');
  await vi.waitFor(() => expect(f.turns.at(-1)?.principal).toBe('owner'));
  // The queued common message carries a file in the common downloads.
  const ref = 'telegram:fixture:queued-with-file';
  const original = join(f.home, 'downloads', 'telegram', 'queued_fixture.txt');
  mkdirSync(join(f.home, 'downloads', 'telegram'), { recursive: true });
  writeFileSync(original, 'fixture attachment');
  f.runtime.intake.acceptOwnerMessage({
    id: ref,
    channelKey: 'fixture',
    occurredAt: Date.now(),
    text: 'queued before role loss',
    senderPrincipalId: f.managingOwner,
    payload: {
      attachments: [{ path: original, name: 'queued_fixture.txt', size: 18 }],
    },
  });
  f.ledger.claim(ref);
  f.runtime.database.adapter
    .prepare("DELETE FROM principal_roles WHERE principal_id=? AND role='owner'")
    .run(f.managingOwner);
  release();
  f.blockOwner(undefined);
  await f.settled(blocker);
  await f.settled(ref);
  await vi.waitFor(() => expect(f.turns.at(-1)?.principal).toBe(f.managingOwner));
  expect(f.runtime.intake.isPending?.(ref)).toBe(true);
  releaseRoom();
  f.blockPrincipal(f.managingOwner, undefined);
  await f.settled(ref, f.managingOwner);
  const row = f.runtime.runtime.mailbox!.readInput(ref, f.managingOwner)!;
  expect(row.payload).toMatchObject({ roomChannel: 'fixture', senderPrincipalId: f.managingOwner });
  // The reply follows the member's room, not the common archive.
  expect(f.ledger.get(ref)?.principalId).toBe(f.managingOwner);
  // The room session reads the file from its own downloads, not the common ones.
  const [moved] = (row.payload as { input: { attachments: Array<{ path: string }> } }).input
    .attachments;
  expect(moved!.path).not.toBe(original);
  expect(moved!.path.startsWith(join(f.root, f.managingOwner))).toBe(true);
  expect(readFileSync(moved!.path, 'utf8')).toBe('fixture attachment');
  expect(
    f.turns
      .filter((turn) => turn.prompt.includes('queued before role loss'))
      .map((turn) => turn.principal)
  ).toEqual([f.managingOwner]);
  // Crash window: the member append is durable; the common skip has neither settled nor acked.
  f.runtime.database.adapter
    .prepare(
      "DELETE FROM native_input_deliveries WHERE input_id IN (SELECT id FROM mailbox_inputs WHERE principal_id='owner' AND stimulus_id=?)"
    )
    .run(ref);
  f.runtime.database.adapter
    .prepare(
      "UPDATE mailbox_inputs SET status='pending', claimed_at=NULL, acked_at=NULL WHERE principal_id='owner' AND stimulus_id=?"
    )
    .run(ref);
  await f.restart();
  await vi.waitFor(() => {
    const state = f.runtime.database.adapter
      .prepare(
        "SELECT status, attempts, last_error, retry_after FROM mailbox_inputs WHERE principal_id='owner' AND stimulus_id=?"
      )
      .get(ref);
    expect(f.runtime.runtime.mailbox!.readInput(ref, 'owner')?.status, JSON.stringify(state)).toBe(
      'acked'
    );
  });
  expect(
    f.runtime.database.adapter
      .prepare(
        'SELECT COUNT(*) AS count FROM mailbox_inputs WHERE principal_id=? AND stimulus_id=?'
      )
      .get(f.managingOwner, ref)
  ).toEqual({ count: 1 });
  expect(f.turns.filter((turn) => turn.prompt.includes('queued before role loss'))).toHaveLength(1);
});

it('still skips a queued common message from a suspended sender', async () => {
  const f = await fixture();
  let release!: () => void;
  f.blockOwner(
    new Promise<void>((resolve) => {
      release = resolve;
    })
  );
  const first = f.message('owner');
  await vi.waitFor(() => expect(f.turns.length).toBe(1));
  const ref = f.message('owner', 'suspended queued input');
  createPrincipalRepository(f.runtime.database.adapter).suspend(f.managingOwner, Date.now());
  release();
  await f.settled(first);
  await f.settled(ref);
  expect(f.runtime.runtime.mailbox!.readInput(ref, f.managingOwner)).toBeNull();
  expect(
    f.runtime.database.adapter
      .prepare("SELECT last_error FROM mailbox_inputs WHERE principal_id='owner' AND stimulus_id=?")
      .get(ref)
  ).toEqual({ last_error: 'inactive_owner_sender' });
});
