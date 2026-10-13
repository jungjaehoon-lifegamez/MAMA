import { expect, it, vi } from 'vitest';
import { createPrincipalRepository } from '@jungjaehoon/mama-core';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from '../helpers/member-runtime.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

it.each(['codex', 'claude'] as const)(
  'waits for another DM before enrollment and refreshes its next native read denies (%s)',
  async (backend) => {
    const f = await fixture(backend);
    const request = await f.actAs(f.managingOwner, 'manage.member.enroll');
    await f.settled(request.ref, f.managingOwner);
    const runningGate = gate();
    f.blockPrincipal(f.member, runningGate.promise);
    const running = f.message(f.member);
    let completion: ReturnType<typeof f.runtime.completeMemberEnrollment> | undefined;
    try {
      await vi.waitFor(() => expect(f.turns.some((t) => t.principal === f.member)).toBe(true));
      let finished = false;
      completion = f.runtime.completeMemberEnrollment({
        sourceMessageRef: request.ref,
        ownerUserId: 'fixture-manager',
        userId: 'fixture-new-member',
      });
      void completion.then(() => {
        finished = true;
      });
      // Flush the immediate host work without advancing or ending the blocked native turn.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(finished).toBe(false);
      const repo = createPrincipalRepository(f.runtime.database.adapter);
      expect(repo.resolveByExternal('telegram', 'private', 'fixture-new-member')).toBeNull();
      runningGate.release();
      await f.settled(running, f.member);
      expect(await completion).toMatchObject({ status: 'completed', data: { status: 'created' } });
      const enrolled = repo.resolveByExternal('telegram', 'private', 'fixture-new-member')!;
      const newPath = join(f.root, enrolled.principalId);
      expect(existsSync(newPath)).toBe(true);
      expect(f.drivers.get(f.member)?.deniedReadPaths).not.toContain(newPath);
      await f.settled(f.message(f.member), f.member);
      expect(f.drivers.get(f.member)?.deniedReadPaths).toContain(newPath);
      expect(f.turns.filter((t) => t.principal === f.member).at(-1)?.fresh).toBe(true);
    } finally {
      runningGate.release();
      await completion;
    }
  }
);

it('holds a new DM while an exclusive set-aside runs and then refreshes archive denies', async () => {
  const f = await fixture();
  const other = createPrincipalRepository(f.runtime.database.adapter).registerMember({
    connector: 'telegram',
    namespace: 'private',
    externalId: 'fixture-other-member',
    now: 4,
  });
  await f.runtime.serveMember(other);
  const stopping = gate();
  const entered = gate();
  const native = f.natives.get(f.member)!;
  const stop = native.stop.bind(native);
  vi.spyOn(native, 'stop').mockImplementationOnce(async () => {
    entered.release();
    await stopping.promise;
    await stop();
  });
  let request: ReturnType<typeof f.actAs> | undefined;
  try {
    request = f.actAs(f.managingOwner, 'manage.member.suspend', { principalId: f.member });
    void request.catch(() => {});
    await entered.promise;
    const before = f.turns.filter((t) => t.principal === other).length;
    const queued = f.message(other);
    await vi.waitFor(() =>
      expect(f.runtime.runtime.mailbox!.readInput(queued, other)?.status).toBe('claimed')
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.turns.filter((t) => t.principal === other)).toHaveLength(before);
    stopping.release();
    await f.settled((await request).ref, f.managingOwner);
    await f.settled(queued, other);
    const archive = readdirSync(f.root).find((name) => name.startsWith(`.retired-${f.member}-`))!;
    expect(f.drivers.get(other)?.deniedReadPaths).toContain(join(f.root, archive));
  } finally {
    stopping.release();
    await request?.catch(() => {});
  }
});

it('grants on the target chain while another principal DM is running', async () => {
  const f = await fixture();
  const runningGate = gate();
  f.blockOwner(runningGate.promise);
  const running = f.message('owner');
  try {
    await vi.waitFor(() => expect(f.turns.some((t) => t.principal === 'owner')).toBe(true));
    const request = await f.actAs(f.managingOwner, 'manage.member.grant', {
      principalId: f.member,
      scopeKind: 'project',
      scopeId: 'fixture-partition',
    });
    expect(request.result).toMatchObject({
      status: 'completed',
      data: { change: 'grant', setAside: false },
    });
    expect(
      createPrincipalRepository(f.runtime.database.adapter).listRetainedGrants(f.member)
    ).toHaveLength(1);
    expect(f.runtime.runtime.mailbox!.readInput(running, 'owner')?.status).toBe('claimed');
  } finally {
    runningGate.release();
  }
});

it('finishes a personal DM while the common turn is still running', async () => {
  const f = await fixture();
  const commonGate = gate();
  f.blockOwner(commonGate.promise);
  const common = f.message('owner');
  try {
    await vi.waitFor(() => expect(f.turns.some((t) => t.principal === 'owner')).toBe(true));
    await f.settled(f.message(f.member), f.member);
    expect(f.runtime.runtime.mailbox!.readInput(common, 'owner')?.status).toBe('claimed');
  } finally {
    commonGate.release();
    await f.settled(common);
  }
});

it('admits a personal DM even when a common backlog fills the pending input window', async () => {
  const f = await fixture();
  const commonGate = gate();
  f.blockOwner(commonGate.promise);
  const common = f.message('owner');
  const backlog: string[] = [];
  try {
    await vi.waitFor(() => expect(f.turns.some((t) => t.principal === 'owner')).toBe(true));
    for (let i = 0; i < 12; i++) backlog.push(f.message('owner'));
    await vi.waitFor(() =>
      expect(
        f.runtime.database.adapter
          .prepare(
            "SELECT count(*) AS n FROM mailbox_inputs WHERE principal_id='owner' AND status='claimed'"
          )
          .get()
      ).toEqual({ n: 9 })
    );
    await f.settled(f.message(f.member), f.member);
    expect(f.runtime.runtime.mailbox!.readInput(common, 'owner')?.status).toBe('claimed');
  } finally {
    commonGate.release();
    f.blockOwner(undefined);
    await f.settled(common);
    for (const ref of backlog) await f.settled(ref);
  }
});

it.each(['codex', 'claude'] as const)(
  'runs two personal turns concurrently with their own tool access, run and input receipts (%s)',
  async (backend) => {
    const f = await fixture(backend);
    createPrincipalRepository(f.runtime.database.adapter).grantRole({
      principalId: f.member,
      role: 'owner',
      now: 10,
    });
    const firstGate = gate();
    const secondGate = gate();
    f.blockPrincipal(f.member, firstGate.promise);
    f.blockPrincipal(f.managingOwner, secondGate.promise);
    f.observeNative(f.member, 'WebFetch', {
      url: 'https://example.test/first',
      nativeToolUseId: 'fixture-shared-call',
    });
    f.observeNative(f.managingOwner, 'WebFetch', {
      url: 'https://example.test/second',
      nativeToolUseId: 'fixture-shared-call',
    });
    const save = (summary: string) => ({
      action: 'memory.save',
      input: {
        topic: 'fixture-concurrent',
        kind: 'fact',
        summary,
        details: summary,
        source: { package: 'fixture', source_type: 'test' },
      },
    });
    const first = f.message(f.member, 'fixture first', undefined, save('FIRST_PERSONAL'));
    const second = f.message(f.managingOwner, 'fixture second', undefined, save('SECOND_PERSONAL'));
    try {
      await vi.waitFor(() =>
        expect(f.turns.map((t) => t.principal)).toEqual(
          expect.arrayContaining([f.member, f.managingOwner])
        )
      );
      firstGate.release();
      await f.settled(first, f.member);
      expect(f.runtime.runtime.mailbox!.readInput(second, f.managingOwner)?.status).toBe('claimed');
      secondGate.release();
      await f.settled(second, f.managingOwner);
      for (const [id, ref, summary] of [
        [f.member, first, 'FIRST_PERSONAL'],
        [f.managingOwner, second, 'SECOND_PERSONAL'],
      ]) {
        expect(f.resultFor(ref)?.status).toBe('completed');
        const turn = f.turns.find((t) => t.principal === id)!;
        expect(turn.access.principalId).toBe(id);
        expect(turn.access.scopes).toEqual([{ kind: 'user', id }]);
        const scopes = f.runtime.database.adapter
          .prepare(
            `SELECT s.kind, s.external_id AS id FROM memory_scope_bindings b
            JOIN memory_scopes s ON s.id=b.scope_id JOIN decisions d ON d.id=b.memory_id
            WHERE d.summary=?`
          )
          .all(summary);
        expect(scopes).toEqual([{ kind: 'user', id }]);
        const runs = f.runtime.database.adapter
          .prepare(
            "SELECT model_run_id, input_refs_json FROM model_runs WHERE json_extract(input_refs_json, '$.sourceMessageRef')=?"
          )
          .all(ref) as Array<{ model_run_id: string; input_refs_json: string }>;
        expect(runs).toHaveLength(1);
        expect(JSON.parse(runs[0].input_refs_json)).toMatchObject({
          principalId: id,
          sessionKey: `member:${id}:runtime`,
        });
        expect(f.pool.peekSession(`member:${id}:runtime`).busy).toBe(false);
        const row = f.runtime.runtime.mailbox!.readInput(ref, id)!;
        const input = f.runtime.runtime.mailbox!.nativeInputs.get(row.id)!;
        expect(JSON.parse(runs[0].input_refs_json).nativeInputId).toBe(input.invocationId);
        expect(input.state).toBe('settled');
        expect(input.receipt?.sessionId).toBe(turn.session);
        expect(
          f.runtime.runtime.mailbox!.nativeInputs.resultForReceipt(input.receipt!, id)?.response
        ).toBe('fixture answer');
        expect(
          f.runtime.runtime.mailbox!.nativeInputs.resultForReceipt(input.receipt!, id)?.modelRunId
        ).toBe(runs[0].model_run_id);
        const other = id === f.member ? f.managingOwner : f.member;
        expect(
          f.runtime.runtime.mailbox!.nativeInputs.resultForReceipt(input.receipt!, other)
        ).toBeNull();
      }
      expect(f.turns[0].session).not.toBe(f.turns[1].session);
      expect(f.pool.peekSession(`member:${f.member}:runtime`).sessionId).not.toBe(
        f.pool.peekSession(`member:${f.managingOwner}:runtime`).sessionId
      );
      expect(f.outbound).toHaveLength(2);
      expect(f.outbound).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            principalId: f.member,
            summary: 'https://example.test/first',
            class: 'web_fetch',
          }),
          expect.objectContaining({
            principalId: f.managingOwner,
            summary: 'https://example.test/second',
            class: 'web_fetch',
          }),
        ])
      );
      expect(f.outbound[0].modelRunId).not.toBe(f.outbound[1].modelRunId);
    } finally {
      firstGate.release();
      secondGate.release();
    }
  }
);

it('keeps two turns of one principal sequential while another principal finishes', async () => {
  const f = await fixture();
  const memberGate = gate();
  f.blockPrincipal(f.member, memberGate.promise);
  const first = f.message(f.member);
  try {
    await vi.waitFor(() => expect(f.turns.filter((t) => t.principal === f.member)).toHaveLength(1));
    const second = f.message(f.member);
    await f.settled(f.message(f.managingOwner), f.managingOwner);
    expect(f.turns.filter((t) => t.principal === f.member)).toHaveLength(1);
    memberGate.release();
    await f.settled(first, f.member);
    await f.settled(second, f.member);
    expect(f.turns.filter((t) => t.principal === f.member)).toHaveLength(2);
  } finally {
    memberGate.release();
  }
});

it("a suspend waits for that member's running turn but not for the common session's", async () => {
  const f = await fixture();
  const commonGate = gate();
  const memberGate = gate();
  f.blockOwner(commonGate.promise);
  f.blockPrincipal(f.member, memberGate.promise);
  const common = f.message('owner');
  const running = f.message(f.member);
  const repo = createPrincipalRepository(f.runtime.database.adapter);
  try {
    await vi.waitFor(() =>
      expect(f.turns.map((t) => t.principal)).toEqual(expect.arrayContaining(['owner', f.member]))
    );
    const request = await f.actAs(f.managingOwner, 'manage.member.suspend', {
      principalId: f.member,
    });
    expect(request.result).toMatchObject({ status: 'completed', data: { status: 'scheduled' } });
    expect(repo.findById(f.member)?.status).toBe('active');
    const queued = f.message(f.member);
    await vi.waitFor(() =>
      expect(f.runtime.runtime.mailbox!.readInput(queued, f.member)?.status).toBe('claimed')
    );
    memberGate.release();
    await f.settled(running, f.member);
    await vi.waitFor(() => expect(repo.findById(f.member)?.status).toBe('suspended'));
    expect(existsSync(join(f.root, f.member))).toBe(false);
    expect(f.runtime.runtime.mailbox!.readInput(common, 'owner')?.status).toBe('claimed');
    await vi.waitFor(() =>
      expect(f.runtime.runtime.mailbox!.readInput(queued, f.member)?.status).toBe('dead')
    );
    expect(f.turns.filter((t) => t.principal === f.member)).toHaveLength(1);
    commonGate.release();
    await f.settled(common);
  } finally {
    commonGate.release();
    memberGate.release();
  }
});

it('does not deadlock reciprocal owner suspensions and rechecks the queued caller, leaving one active owner', async () => {
  const f = await fixture();
  const repo = createPrincipalRepository(f.runtime.database.adapter);
  repo.grantRole({ principalId: f.member, role: 'owner', now: 10 });
  const finish = gate();
  f.holdMemberCompletion(finish.promise);
  const request = (caller: string, target: string) =>
    f.message(caller, 'fixture suspend', undefined, {
      action: 'manage.member.suspend',
      input: { principalId: target },
    });
  const first = request(f.managingOwner, f.member);
  const second = request(f.member, f.managingOwner);
  try {
    await vi.waitFor(() => {
      expect(f.resultFor(first)).toMatchObject({
        status: 'completed',
        data: { status: 'scheduled' },
      });
      expect(f.resultFor(second)).toMatchObject({
        status: 'completed',
        data: { status: 'scheduled' },
      });
    });
    const queuedFirst = f.message(f.managingOwner);
    const queuedSecond = f.message(f.member);
    finish.release();
    f.holdMemberCompletion(undefined);
    await vi.waitFor(() => expect(repo.listActiveMembersWithRole('owner')).toHaveLength(1));
    await f.runtime.surface.memberRecords.idle();
    const active = repo.listActiveMembersWithRole('owner')[0].principalId;
    const inactive = active === f.member ? f.managingOwner : f.member;
    const activeRef = active === f.member ? queuedSecond : queuedFirst;
    const inactiveRef = active === f.member ? queuedFirst : queuedSecond;
    await f.settled(activeRef, active);
    await vi.waitFor(() =>
      expect(f.runtime.runtime.mailbox!.readInput(inactiveRef, inactive)?.status).toBe('dead')
    );
    expect(repo.listActiveMembersWithRole('owner')).toHaveLength(1);
    const receipts = f.runtime.database.adapter
      .prepare(
        "SELECT content FROM connector_event_index WHERE source_connector='chat' AND content LIKE '%manage.member.suspend%' AND author='host'"
      )
      .all() as Array<{ content: string }>;
    expect(receipts.some((r) => r.content.includes('"change":"suspend"'))).toBe(true);
    expect(receipts.some((r) => r.content.includes('"kind":"denied"'))).toBe(true);
  } finally {
    finish.release();
    f.holdMemberCompletion(undefined);
  }
});

it('holds the next caller turn until set-aside finishes, then resumes through the same lane', async () => {
  const f = await fixture();
  const targetGate = gate();
  f.blockPrincipal(f.member, targetGate.promise);
  const running = f.message(f.member);
  const repo = createPrincipalRepository(f.runtime.database.adapter);
  try {
    await vi.waitFor(() => expect(f.turns.some((t) => t.principal === f.member)).toBe(true));
    const suspend = await f.actAs(f.managingOwner, 'manage.member.suspend', {
      principalId: f.member,
    });
    await f.settled(suspend.ref, f.managingOwner);
    const resume = f.actAs(f.managingOwner, 'manage.member.resume', {
      principalId: f.member,
    });
    targetGate.release();
    await f.settled(running, f.member);
    expect((await resume).result).toMatchObject({
      status: 'completed',
      data: { status: 'scheduled' },
    });
    await vi.waitFor(() => {
      const receipts = f.runtime.database.adapter
        .prepare(
          "SELECT content FROM connector_event_index WHERE source_entity_id LIKE 'host:management:%:reply'"
        )
        .all() as Array<{ content: string }>;
      expect(receipts).toHaveLength(2);
      expect(receipts.every((r) => JSON.parse(r.content).result.status === 'completed')).toBe(true);
      expect(repo.findById(f.member)?.status).toBe('active');
      expect(f.runtime.runtime.servesPrincipal(f.member)).toBe(true);
    });
  } finally {
    targetGate.release();
  }
});

it('applies a queued grant before a later suspend on the same busy member', async () => {
  const f = await fixture();
  const runningGate = gate();
  f.blockPrincipal(f.member, runningGate.promise);
  const running = f.message(f.member);
  const repo = createPrincipalRepository(f.runtime.database.adapter);
  try {
    await vi.waitFor(() => expect(f.turns.some((t) => t.principal === f.member)).toBe(true));
    const grant = await f.actAs(f.managingOwner, 'manage.member.grant', {
      principalId: f.member,
      scopeKind: 'project',
      scopeId: 'fixture-ordered-partition',
    });
    const suspend = await f.actAs(f.managingOwner, 'manage.member.suspend', {
      principalId: f.member,
    });
    expect(grant.result).toMatchObject({ status: 'completed', data: { status: 'scheduled' } });
    expect(suspend.result).toMatchObject({ status: 'completed', data: { status: 'scheduled' } });
    runningGate.release();
    await f.settled(running, f.member);
    await vi.waitFor(() => expect(repo.findById(f.member)?.status).toBe('suspended'));
    expect(repo.listRetainedGrants(f.member)).toHaveLength(1);
  } finally {
    runningGate.release();
  }
});
