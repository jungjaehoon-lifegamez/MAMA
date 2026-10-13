import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPrincipalRepository, erasePrincipalRecords } from '@jungjaehoon/mama-core';
import { TelegramGateway } from '../../src/gateways/telegram.js';
import { ChatSources } from '../../src/storage/chat-sources.js';
import { RawStore } from '../../src/storage/source-archive.js';
import { join } from 'node:path';
import { fixture } from '../helpers/member-runtime.js';
const transport = vi.hoisted(() => ({
  sent: [] as Array<{ chatId: number; text: string }>,
  fail: false,
  unavailable: false,
  attempts: 0,
}));
vi.mock('grammy', () => ({
  Bot: vi.fn(() => ({
    on: vi.fn(),
    catch: vi.fn(),
    init: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    api: {
      sendMessage: async (chatId: number, text: string) => {
        transport.attempts++;
        if (transport.fail)
          throw Object.assign(new Error('fixture rejected'), {
            error_code: 403,
            description: 'Forbidden',
          });
        transport.sent.push({ chatId, text });
        return { message_id: transport.sent.length + 100 };
      },
    },
  })),
}));
let gateway: TelegramGateway | undefined;
afterEach(async () => {
  await gateway?.stop();
  gateway = undefined;
  transport.sent = [];
  transport.fail = false;
  transport.unavailable = false;
  transport.attempts = 0;
});
const body = {
  cron: '0 * * * *',
  timeZone: 'UTC',
  instruction: 'Check the readable changes since the last completed check.',
};
async function setup() {
  const f = await fixture(
    'codex',
    true,
    false,
    'UTC',
    {
      sendFile: async () => {
        throw new Error('unused');
      },
      sendMemberText: (...args) => {
        if (transport.unavailable) throw new Error('fixture gateway not connected');
        return gateway!.sendMemberText(...args);
      },
    },
    '21001'
  );
  const startGateway = async () => {
    gateway = new TelegramGateway({
      token: 'fixture-token',
      messageLedger: f.ledger,
      registry: createPrincipalRepository(f.runtime.database.adapter),
      intake: f.runtime.intake,
      memberIntake: f.runtime.serveMember,
      principalPaths: f.runtime.principalPaths,
      config: { enabled: true, allowedChats: ['-999'], polling: false },
    });
    await gateway.start();
    await f.runtime.runtime.drainOnce();
  };
  await startGateway();
  const create = async (principal = f.member) => {
    const { result, ref } = await f.actAs(principal, 'schedule.job.create', body);
    await f.settled(ref, principal);
    expect(result.status, JSON.stringify(result)).toBe('completed');
    return (result as { data: { id: string } }).data.id;
  };
  const due = Math.ceil((Date.now() + 1) / 3_600_000) * 3_600_000;
  const tick = (at = due) => f.runtime.personalJobs.tick(new Date(at));
  const jobRows = () =>
    f.runtime.database.adapter
      .prepare(
        "SELECT stimulus_id, principal_id, occurred_at, status FROM mailbox_inputs WHERE kind='scheduled' AND channel_key LIKE 'job:%' ORDER BY id"
      )
      .all() as Array<{
      stimulus_id: string;
      principal_id: string;
      occurred_at: number;
      status: string;
    }>;
  return { f, create, due, tick, jobRows, startGateway };
}
describe('personal scheduled turns and P10.2 recovery', () => {
  it('runs once as that person with fresh context/current access, own rules, DM ledger and host/agent job chat', async () => {
    const { f, create, due, tick, jobRows } = await setup();
    const correction = await f.act('memory.save', {
      topic: 'fixture-job-rule',
      kind: 'preference',
      appliesWhen: 'When reporting readable changes',
      summary: 'Keep the report brief',
      details: 'Only the relevant facts',
      source: { package: 'fixture', source_type: 'fixture' },
    });
    await f.settled(correction.ref, f.member);
    expect(correction.result.status, JSON.stringify(correction.result)).toBe('completed');
    const id = await create();
    const dmSession = f.turns.at(-1)!.session;
    const commonTurns = f.turns.filter((turn) => turn.principal === 'owner').length;
    f.memberResponse('A readable change matters.');
    await tick();
    const accepted = f.runtime.runtime.mailbox!.readInput(jobRows()[0]!.stimulus_id, f.member)!;
    expect(
      f.runtime.memberIntake(f.member).acceptScheduled({
        id: accepted.stimulusId,
        channelKey: accepted.channelKey,
        occurredAt: accepted.occurredAt,
        payload: accepted.payload!,
      })
    ).toEqual({ state: 'duplicate', inputId: null });
    await tick();
    await vi.waitFor(() => expect(jobRows()).toHaveLength(1));
    await f.settled(jobRows()[0]!.stimulus_id, f.member);
    const jobTurn = f.turns.at(-1)!;
    expect(jobTurn).toMatchObject({
      principal: f.member,
      fresh: true,
      access: {
        scopes: [{ kind: 'user', id: f.member }],
        destinations: [{ kind: 'telegram', id: '21001' }],
      },
    });
    expect(jobTurn.session).not.toBe(dmSession);
    expect(jobTurn.prompt).toContain(body.instruction);
    expect(jobTurn.prompt).toContain('last completed');
    expect(jobTurn.prompt).toContain('[ack]');
    expect(jobTurn.prompt).toContain('Keep the report brief');
    expect(f.turns.filter((turn) => turn.principal === 'owner')).toHaveLength(commonTurns);
    expect(transport.sent).toEqual([{ chatId: 21001, text: 'A readable change matters.' }]);
    expect(f.ledger.listForTelegramDm('21001')).toEqual([
      expect.objectContaining({ state: 'delivered', idempotencyKey: `job:${id}:${due}` }),
    ]);
    expect(
      f.runtime.database.adapter
        .prepare(
          "SELECT author, content, memory_scope_id, json_extract(metadata_json, '$.kind') AS kind FROM connector_event_index WHERE json_extract(metadata_json, '$.kind') IN ('job_instruction', 'job_reply') ORDER BY rowid"
        )
        .all()
    ).toEqual([
      {
        author: 'host',
        content: body.instruction,
        memory_scope_id: f.member,
        kind: 'job_instruction',
      },
      {
        author: `member-agent:${f.member}`,
        content: 'A readable change matters.',
        memory_scope_id: f.member,
        kind: 'job_reply',
      },
    ]);
    const raw = new RawStore(join(f.home, 'raw'));
    const chat = new ChatSources(
      raw,
      f.runtime.database.adapter,
      f.member,
      `member-agent:${f.member}`
    );
    expect(chat.exchanges(due, due + 1)).toEqual([]);
    expect(
      chat.recentExchanges('unrelated').some((exchange) => exchange.owner === body.instruction)
    ).toBe(false);
    raw.close();
    await tick();
    expect(jobRows()).toHaveLength(1);
    await tick(due + 3_600_000);
    await vi.waitFor(() => expect(jobRows()).toHaveLength(2));
    await f.settled(jobRows()[1]!.stimulus_id, f.member);
    expect(f.turns.at(-1)!.fresh).toBe(true);
    expect(f.turns.at(-1)!.session).not.toBe(jobTurn.session);
    const dm = f.message(f.member);
    await f.settled(dm, f.member);
    expect(f.turns.at(-1)!.session).toBe(dmSession);
  });
  it('[ack] sends nothing and advances the completed occurrence', async () => {
    const { f, create, due, tick, jobRows } = await setup();
    await create();
    f.memberResponse(' [ack] ');
    await tick();
    await vi.waitFor(() => expect(jobRows()).toHaveLength(1));
    await f.settled(jobRows()[0]!.stimulus_id, f.member);
    expect(transport.sent).toEqual([]);
    const listed = await f.act('schedule.job.list');
    expect(listed.result).toMatchObject({
      status: 'completed',
      data: {
        jobs: [
          expect.objectContaining({
            lastCompletedOccurrence: expect.stringContaining(
              new Date(due).toISOString().slice(0, 10)
            ),
          }),
        ],
      },
    });
    await tick();
    expect(jobRows()).toHaveLength(1);
  });
  it('after downtime spanning three occurrences runs only the latest, and restart does not repeat it', async () => {
    const { f, create, due, tick, jobRows, startGateway } = await setup();
    await create();
    await tick(due + 2 * 3_600_000 + 600_000);
    await vi.waitFor(() => expect(jobRows()).toHaveLength(1));
    expect(jobRows()[0]!.occurred_at).toBe(due + 2 * 3_600_000);
    await f.settled(jobRows()[0]!.stimulus_id, f.member);
    await gateway!.stop();
    await f.restart();
    await startGateway();
    await tick(due + 2 * 3_600_000 + 600_000);
    expect(jobRows()).toHaveLength(1);
    expect(transport.sent).toHaveLength(1);
  });
  it('recovers a result before delivery without another model turn', async () => {
    const { f, create, tick, jobRows, startGateway } = await setup();
    await create();
    transport.unavailable = true;
    await tick();
    await vi.waitFor(() =>
      expect(
        f.runtime.runtime.mailbox!.readInput(jobRows()[0]!.stimulus_id, f.member)?.nativeDelivery
          ?.state
      ).toBe('uncertain')
    );
    const turns = f.turns.length;
    expect(transport.sent).toEqual([]);
    await gateway!.stop();
    transport.unavailable = false;
    await f.restart();
    await startGateway();
    await vi.waitFor(async () => {
      await f.runtime.runtime.drainOnce();
      expect(
        f.runtime.runtime.mailbox!.readInput(jobRows()[0]!.stimulus_id, f.member)?.status
      ).toBe('acked');
    });
    await f.settled(jobRows()[0]!.stimulus_id, f.member);
    expect(f.turns).toHaveLength(turns);
    expect(transport.sent).toHaveLength(1);
    expect(
      f.runtime.database.adapter
        .prepare(
          "SELECT COUNT(*) AS n FROM connector_event_index WHERE json_extract(metadata_json, '$.kind')='job_reply'"
        )
        .get()
    ).toEqual({ n: 1 });
  });
  it('suspend cancels queued job inputs and never enqueues that person while the other person’s job runs', async () => {
    const { f, create, tick, jobRows } = await setup();
    await create();
    await create(f.managingOwner);
    const suspend = await f.manage('suspend');
    expect(suspend.status).toBe('completed');
    await tick();
    await vi.waitFor(() => expect(jobRows()).toHaveLength(1));
    expect(jobRows()[0]!.principal_id).toBe(f.managingOwner);
    await f.settled(jobRows()[0]!.stimulus_id, f.managingOwner);
    expect(f.turns.filter((turn) => turn.principal === f.member).at(-1)!.prompt).not.toContain(
      'personal_job'
    );
  });
  it('resume starts jobs from the resume time without catching up a suspended daily occurrence', async () => {
    const { f } = await setup();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now');
    const day = Math.floor(now / 86_400_000) * 86_400_000 + 86_400_000;
    const created = await f.act('schedule.job.create', { ...body, cron: '0 8 * * *' });
    await f.settled(created.ref, f.member);
    expect(created.result.status).toBe('completed');
    clock.mockReturnValue(day + 7 * 3_600_000);
    expect((await f.manage('suspend')).status).toBe('completed');
    clock.mockReturnValue(day + 15 * 3_600_000);
    expect((await f.manage('resume')).status).toBe('completed');
    await f.runtime.personalJobs.tick(new Date(Date.now()));
    expect(
      f.runtime.database.adapter
        .prepare("SELECT COUNT(*) AS n FROM mailbox_inputs WHERE channel_key LIKE 'job:%'")
        .get()
    ).toEqual({ n: 0 });
  });
  it('never delivers an old stored result after suspension and resume', async () => {
    const { f, create, tick, jobRows } = await setup();
    await create();
    let release!: () => void;
    f.holdMemberCompletion(
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    transport.unavailable = true;
    await tick();
    await vi.waitFor(() => expect(f.turns.at(-1)!.prompt).toContain('<personal_job>'));
    // Suspension owns the directory lane but must wait for the running job to finish.
    const suspension = f.manage('suspend');
    try {
      await vi.waitFor(() =>
        expect(
          f.runtime.database.adapter
            .prepare(
              "SELECT 1 FROM mailbox_inputs WHERE principal_id=? AND kind='host_job' AND status IN ('pending','claimed')"
            )
            .get(f.member)
        ).toBeDefined()
      );
    } finally {
      f.holdMemberCompletion(undefined);
      release();
    }
    await vi.waitFor(() =>
      expect(
        f.runtime.runtime.mailbox!.readInput(jobRows()[0]!.stimulus_id, f.member)?.nativeDelivery
          ?.state
      ).toBe('uncertain')
    );
    expect((await suspension).status).toBe('completed');
    transport.unavailable = false;
    expect((await f.manage('resume')).status).toBe('completed');
    await f.runtime.runtime.drainOnce();
    expect(transport.sent).toEqual([]);
    expect(f.runtime.surface.personalJobs.list(f.member)[0]!.lastCompletedAt).toBeNull();
  });
  it('settles a definitive Telegram rejection once, including across gateway restart', async () => {
    const { f, create, tick, jobRows, startGateway } = await setup();
    await create();
    transport.fail = true;
    await tick();
    await vi.waitFor(() => expect(jobRows()).toHaveLength(1));
    await f.settled(jobRows()[0]!.stimulus_id, f.member);
    for (let n = 0; n < 3; n++) await f.runtime.runtime.drainOnce();
    expect(transport.attempts).toBe(1);
    expect(f.runtime.surface.personalJobs.list(f.member)[0]!.lastCompletedAt).toBeNull();
    await gateway!.stop();
    await f.restart();
    await startGateway();
    expect(transport.attempts).toBe(1);
    expect(transport.sent).toEqual([]);
  });
  it('serves an unserved person through the member directory lane, after running member turns', async () => {
    const { f, create, tick, jobRows } = await setup();
    await create();
    let release!: () => void;
    f.blockPrincipal(f.managingOwner, new Promise<void>((resolve) => (release = resolve)));
    const running = f.message(f.managingOwner);
    await vi.waitFor(() => expect(f.turns.at(-1)?.principal).toBe(f.managingOwner));
    f.runtime.runtime.unservePrincipal(f.member);
    let ticked = false;
    const ticking = tick().then(() => {
      ticked = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ticked).toBe(false);
    expect(f.runtime.runtime.servesPrincipal(f.member)).toBe(false);
    expect(jobRows()).toHaveLength(0);
    f.blockPrincipal(f.managingOwner, undefined);
    release();
    await ticking;
    expect(f.runtime.runtime.servesPrincipal(f.member)).toBe(true);
    expect(jobRows().map((row) => row.principal_id)).toEqual([f.member]);
    await f.settled(running, f.managingOwner);
    await f.settled(jobRows()[0]!.stimulus_id, f.member);
  });
  it('recovers chat storage after the DM was delivered, without sending it twice', async () => {
    const { f, create, tick, jobRows, startGateway } = await setup();
    await create();
    const save = vi.spyOn(ChatSources.prototype, 'saveJobExchange').mockImplementation(() => {
      throw new Error('fixture archive write failed');
    });
    await tick();
    await vi.waitFor(() =>
      expect(
        f.runtime.runtime.mailbox!.readInput(jobRows()[0]!.stimulus_id, f.member)?.nativeDelivery
          ?.state
      ).toBe('uncertain')
    );
    expect(transport.sent).toHaveLength(1);
    const turns = f.turns.length;
    save.mockRestore();
    await gateway!.stop();
    await f.restart();
    await startGateway();
    // The daemon holds delivery until its gateways connect; this fixture does not, so its boot
    // pass reconciled against the stopped gateway. The next pass settles the stored result.
    await f.runtime.runtime.drainOnce();
    await f.settled(jobRows()[0]!.stimulus_id, f.member);
    expect(f.turns).toHaveLength(turns);
    expect(transport.sent).toHaveLength(1);
    expect(
      f.runtime.database.adapter
        .prepare(
          "SELECT COUNT(*) AS n FROM connector_event_index WHERE json_extract(metadata_json, '$.kind')='job_reply'"
        )
        .get()
    ).toEqual({ n: 1 });
  });
  it.each(['suspend', 'offboard'])(
    '%s cancels a queued scheduled input using the existing principal cancellation',
    async (action) => {
      const { f, create, tick, jobRows } = await setup();
      await create();
      // The person's own chain holds a running DM, so the change waits there as a host job and
      // the job occurrence queues behind it; the change cancels it before dispatch.
      let release!: () => void;
      f.blockPrincipal(f.member, new Promise<void>((resolve) => (release = resolve)));
      const running = f.message(f.member);
      await vi.waitFor(() => expect(f.turns.at(-1)?.principal).toBe(f.member));
      const management = f.message('owner', 'fixture lifecycle', f.managingOwner, {
        action: `manage.member.${action}`,
        input: { principalId: f.member },
      });
      await f.settled(management);
      await tick();
      expect(jobRows()).toHaveLength(1);
      f.blockPrincipal(f.member, undefined);
      release();
      await f.settled(running, f.member);
      await vi.waitFor(() =>
        expect(
          f.runtime.runtime.mailbox!.readInput(jobRows()[0]!.stimulus_id, f.member)?.status
        ).toBe('dead')
      );
      expect(transport.sent).toEqual([]);
      await tick();
      expect(jobRows()).toHaveLength(1);
      expect(f.turns.filter((turn) => turn.principal === f.member).at(-1)!.prompt).not.toContain(
        '<personal_job>'
      );
    }
  );
  it('applies current grants at execution and keeps owner-role/common sessions separate', async () => {
    const { f, create, tick, jobRows } = await setup();
    await create();
    await create(f.managingOwner);
    const repo = createPrincipalRepository(f.runtime.database.adapter);
    repo.grantScope({
      targetPrincipalId: f.member,
      ownerPrincipalId: 'owner',
      now: Date.now(),
      scope: { kind: 'memory', scopeKind: 'project', scopeId: 'fixture-job-project' },
    });
    await tick();
    await vi.waitFor(() => expect(jobRows()).toHaveLength(2));
    for (const row of jobRows()) await f.settled(row.stimulus_id, row.principal_id);
    const personal = f.turns.filter((turn) => turn.principal === f.member).at(-1)!;
    const owner = f.turns.filter((turn) => turn.principal === f.managingOwner).at(-1)!;
    expect(personal.access.readScopes).toContainEqual({
      kind: 'project',
      id: 'fixture-job-project',
    });
    expect(owner.access.scopes).toEqual([{ kind: 'user', id: f.managingOwner }]);
    expect(owner.standing).toContain('FIXTURE_OWNER_POLICY');
    expect(personal.standing).not.toContain('FIXTURE_OWNER_POLICY');
    expect(f.turns.filter((turn) => turn.principal === 'owner')).toEqual([]);
  });
  it.each(['disable', 'update', 'delete', 'erase'])(
    'does not execute a queued job after %s',
    async (change) => {
      const { f, create, tick, jobRows } = await setup();
      const id = await create();
      const pending =
        change === 'erase'
          ? undefined
          : f.act(
              `schedule.job.${change === 'delete' ? 'delete' : 'update'}`,
              change === 'delete'
                ? { id }
                : change === 'disable'
                  ? { id, enabled: false }
                  : { id, instruction: 'Revised queued instruction' }
            );
      await tick();
      if (change === 'erase') {
        // The product P9 flow cancels waiters and removes its raw projection before core erasure.
        f.runtime.runtime.mailbox!.cancelQueued(f.member, 'member_erase');
        f.runtime.database.adapter
          .prepare(
            "DELETE FROM connector_event_index WHERE source_connector='chat' AND memory_scope_kind='user' AND memory_scope_id=?"
          )
          .run(f.member);
        erasePrincipalRecords(f.runtime.database.adapter, {
          principalId: f.member,
          commandId: 'fixture-erase-queued-job',
        });
      }
      if (pending) expect((await pending).result.status).toBe('completed');
      if (change !== 'erase') await f.settled(jobRows()[0]!.stimulus_id, f.member);
      expect(transport.sent).toEqual([]);
      await tick();
      expect(jobRows()).toHaveLength(change === 'erase' ? 0 : 1);
    }
  );

  it('resets context after a failed native job and keeps the last completed anchor unchanged', async () => {
    const { f, create, due, tick, jobRows } = await setup();
    await create();
    f.finishMemberTurn('after_acceptance');
    await tick();
    await vi.waitFor(() => expect(jobRows()).toHaveLength(1));
    await f.settled(jobRows()[0]!.stimulus_id, f.member);
    const failedSession = f.turns.at(-1)!.session;
    expect(f.runtime.surface.personalJobs.list(f.member)[0]!.lastCompletedAt).toBeNull();
    await tick(due + 3_600_000);
    await vi.waitFor(() => expect(jobRows()).toHaveLength(2));
    await f.settled(jobRows()[1]!.stimulus_id, f.member);
    expect(f.turns.at(-1)!.fresh).toBe(true);
    expect(f.turns.at(-1)!.session).not.toBe(failedSession);
    expect(f.runtime.surface.personalJobs.list(f.member)[0]!.lastCompletedAt).toBe(due + 3_600_000);
  });
  it('a fresh job does not consume lessons that the existing DM context has not seen', async () => {
    const { f, create, tick, jobRows } = await setup();
    await create();
    const saved = await f.runtime.surface.hostToolCall(
      'memory.save',
      {
        topic: 'fixture-later-guidance',
        kind: 'lesson',
        summary: 'LATER_PERSONAL_GUIDANCE',
        details: 'Check readable changes carefully.',
        appliesWhen: 'When checking readable changes.',
        source: { package: 'fixture', source_type: 'fixture' },
      },
      'fixture-later-guidance',
      { access: f.turns.at(-1)!.access }
    );
    expect(saved.status, JSON.stringify(saved)).toBe('completed');
    await tick();
    await vi.waitFor(() => expect(jobRows()).toHaveLength(1));
    await f.settled(jobRows()[0]!.stimulus_id, f.member);
    expect(f.turns.at(-1)!.prompt).toContain('LATER_PERSONAL_GUIDANCE');
    const dm = f.message(f.member, body.instruction);
    await f.settled(dm, f.member);
    expect(f.turns.at(-1)!.fresh).toBe(false);
    expect(f.turns.at(-1)!.prompt).toContain('LATER_PERSONAL_GUIDANCE');
  });
});
