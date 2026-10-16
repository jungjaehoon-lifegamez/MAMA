import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendJudgment,
  createPrincipalRepository,
  exportPrincipalRecords,
  recallMemory,
} from '@jungjaehoon/mama-core';
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fixture } from '../helpers/member-runtime.js';
import { TelegramGateway } from '../../src/gateways/telegram.js';
import { RawStore } from '../../src/storage/source-archive.js';
import { ChatSources } from '../../src/storage/chat-sources.js';
import { createCoreRawIndexSink } from '../../src/replay/import-manifest.js';
import { sourceDeltaStimulusId } from '../../src/runtime/stimulus-delivery.js';

const transport = vi.hoisted(() => ({
  sent: [] as Array<{ chatId: number; text: string }>,
  unavailable: false,
  reject: false,
}));
vi.mock('grammy', () => ({
  Bot: vi.fn(() => ({
    on: vi.fn(),
    catch: vi.fn(),
    init: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    api: {
      setMyCommands: vi.fn(async () => true),
      sendMessage: async (chatId: number, text: string) => {
        if (transport.reject)
          throw Object.assign(new Error('fixture rejected'), {
            error_code: 403,
            description: 'Forbidden',
          });
        transport.sent.push({ chatId, text });
        return { message_id: 100 + transport.sent.length };
      },
    },
  })),
}));
let gateway: TelegramGateway | undefined;
afterEach(async () => {
  await gateway?.stop();
  gateway = undefined;
  transport.sent = [];
  transport.unavailable = false;
  transport.reject = false;
});

async function setup(ownerRole = true) {
  const failures: string[] = [];
  const uploads: Buffer[] = [];
  let exportGate: Promise<void> | undefined;
  const f = await fixture(
    'codex',
    true,
    false,
    'UTC',
    {
      sendFile: async (path) => {
        const bytes = readFileSync(path);
        uploads.push(bytes);
        await exportGate;
        return { sentAs: 'document', size: bytes.length, messageId: 'fixture-export' };
      },
      sendMemberText: (...args) => {
        if (transport.unavailable) throw new Error('fixture disconnected');
        return gateway!.sendMemberText(...args);
      },
      memberTextDelivered: (...args) => gateway!.memberTextDelivered(...args),
      retireMemberJobText: (key) => gateway!.retireMemberJobText(key),
    },
    '21001',
    undefined,
    (_row, reason) => {
      failures.push(reason);
    },
    ['slack']
  );
  const repo = () => createPrincipalRepository(f.runtime.database.adapter);
  if (ownerRole) repo().grantRole({ principalId: f.member, role: 'owner' });
  const startGateway = async () => {
    gateway = new TelegramGateway({
      token: 'fixture-token',
      messageLedger: f.ledger,
      registry: repo(),
      intake: f.runtime.intake,
      memberIntake: f.runtime.serveMember,
      principalPaths: f.runtime.principalPaths,
      config: { enabled: true, allowedChats: ['-999'], polling: false },
    });
    await gateway.start();
    await f.runtime.runtime.drainOnce();
  };
  await startGateway();
  const raw = new RawStore(join(f.home, 'raw'));
  const [item] = raw.save(
    'slack',
    [
      {
        source: 'slack',
        sourceId: 'fixture-event',
        channel: 'fixture-room',
        author: 'fixture-author',
        content: `Assigned to ${f.member}.`,
        timestamp: new Date(),
        type: 'message',
      },
    ],
    { collectOnly: true }
  );
  const [projection] = createCoreRawIndexSink(f.runtime.database.adapter)('slack', [item!]);
  raw.acknowledgeProjection('slack', item!.sourceId, item!.pendingProjectionId!);
  raw.close();
  const observationRef = projection!.observationRef;
  const delta = {
    kind: 'source_delta' as const,
    collector: 'slack',
    channel: 'fixture-room',
    coalesceKey: 'fixture-event',
    preview: [],
    occurredAt: Date.now(),
    refs: [
      {
        connector: 'slack',
        sourceId: item!.sourceId,
        sourceEntityId: item!.sourceEntityId!,
        observationRef,
        sourceAt: item!.timestamp.toISOString(),
        observedAt: new Date().toISOString(),
        contentHash: null,
        author: 'fixture-author',
        contentPreview: `Assigned to ${f.member}. COMMON_PRIVATE_PREVIEW`,
      },
    ],
  };
  const rows = () =>
    f.runtime.database.adapter
      .prepare(
        "SELECT stimulus_id, principal_id, status, payload_json FROM mailbox_inputs WHERE channel_key='notice' ORDER BY id"
      )
      .all() as Array<{
      stimulus_id: string;
      principal_id: string;
      status: string;
      payload_json: string;
    }>;
  const archive = () =>
    f.runtime.database.adapter
      .prepare(
        "SELECT author, content, memory_scope_id, json_extract(metadata_json, '$.kind') AS kind FROM connector_event_index WHERE json_extract(metadata_json, '$.kind') IN ('notice_refs', 'notice_reply') ORDER BY rowid"
      )
      .all();
  const record = (attempt = 1) => ({
    id: `record:fixture-delta:${attempt}`,
    channelKey: 'operator:record',
    occurredAt: Date.now(),
    payload: {
      order: 'record',
      deltaStimulusId: 'fixture-delta',
      source: 'slack',
      channel: 'fixture-room',
      observationRefs: [observationRef],
      lines: [
        {
          observationRef,
          sourceAt: new Date().toISOString(),
          author: 'fixture-author',
          text: 'COMMON_PRIVATE_PREVIEW',
        },
      ],
      attempt,
    },
  });
  const notice = (refs: unknown[] = [{ observationRef }], attempt = 1) =>
    f.actScheduled(record(attempt), 'member.notice', { principalId: f.member, refs });
  let operations = 0;
  const call = async (principalId: string, refs: unknown[], sourceMessageRef?: string) => {
    const ref = sourceMessageRef ?? f.message('owner', 'COMMON NOTICE SOURCE');
    if (!sourceMessageRef) await f.settled(ref);
    return f.runtime.surface.hostToolCall(
      'member.notice',
      { principalId, refs },
      `op-${++operations}`,
      { session: { sourceMessageRef: ref } }
    );
  };
  const grant = (scopeId: string) =>
    repo().grantScope({
      targetPrincipalId: f.member,
      ownerPrincipalId: 'owner',
      scope: { kind: 'memory', scopeKind: 'project', scopeId },
      now: Date.now(),
    });
  const fact = async (scopeId: string) => {
    const scopes = [{ kind: 'project' as const, id: scopeId }];
    const receipt = await appendJudgment(
      {
        commandId: `fixture-fact-${scopeId}`,
        topic: 'fixture-work',
        recordKind: 'judgment',
        summary: 'A partition fact',
        payload: { assignee: f.member },
        record: { kind: 'fact', status: 'active' },
        scopes,
      },
      { ...f.runtime.surface.ownerAccess, scopes, defaultScopes: scopes },
      { adapter: f.runtime.database.adapter, embedder: null }
    );
    return { memory_id: receipt.recordId };
  };
  return {
    f,
    repo,
    startGateway,
    observationRef,
    rows,
    archive,
    record,
    notice,
    call,
    failures,
    grant,
    fact,
    uploads,
    holdExport: (gate: Promise<void> | undefined) => {
      exportGate = gate;
    },
    delta,
  };
}

describe('personal event notices', () => {
  it.each(['memory', 'source'] as const)(
    'reconciliation closes an undelivered result after a %s grant is revoked',
    async (kind) => {
      const { f, repo, fact, call, observationRef, rows, archive, failures, startGateway } =
        await setup(false);
      const scope =
        kind === 'memory'
          ? { kind: 'memory' as const, scopeKind: 'project' as const, scopeId: 'fixture-recovery' }
          : { kind: 'source' as const, connector: 'slack', channelId: 'fixture-room' };
      repo().grantScope({
        targetPrincipalId: f.member,
        ownerPrincipalId: 'owner',
        scope,
        now: Date.now(),
      });
      const ref = kind === 'memory' ? await fact('fixture-recovery') : { observationRef };
      repo().grantScope({
        targetPrincipalId: f.member,
        ownerPrincipalId: 'owner',
        scope: { kind: 'memory', scopeKind: 'project', scopeId: 'fixture-still-readable' },
        now: Date.now(),
      });
      const kept = await fact('fixture-still-readable');
      transport.unavailable = true;
      await call(f.member, [ref, kept]);
      await vi.waitFor(() =>
        expect(
          f.runtime.runtime.mailbox!.readInput(rows()[0]!.stimulus_id, f.member)?.nativeDelivery
            ?.state
        ).toBe('uncertain')
      );
      const turns = f.turns.length;
      repo().revokeScope({
        targetPrincipalId: f.member,
        ownerPrincipalId: 'owner',
        scope,
        now: Date.now(),
      });
      await gateway!.stop();
      await f.restart();
      transport.unavailable = false;
      await startGateway();
      await f.settled(rows()[0]!.stimulus_id, f.member);
      expect(transport.sent).toEqual([]);
      expect(archive()).toEqual([]);
      expect(f.turns).toHaveLength(turns);
      expect(failures).toEqual([
        'fixture disconnected',
        expect.stringContaining('Personal notice ref is no longer readable'),
      ]);
      expect(
        f.runtime.surface.personalNotices.isClosed(
          f.runtime.runtime.mailbox!.readInput(rows()[0]!.stimulus_id, f.member)!
        )
      ).toBe(true);
    }
  );

  it('reconciliation closes an old result after suspension and resume, including equal timestamps', async () => {
    const { f, repo, notice, rows, archive, failures, startGateway } = await setup();
    transport.unavailable = true;
    await notice();
    await vi.waitFor(() =>
      expect(
        f.runtime.runtime.mailbox!.readInput(rows()[0]!.stimulus_id, f.member)?.nativeDelivery
          ?.state
      ).toBe('uncertain')
    );
    const row = f.runtime.runtime.mailbox!.readInput(rows()[0]!.stimulus_id, f.member)!;
    const turns = f.turns.length;
    repo().suspend(f.member, row.createdAt);
    repo().resume(f.member, row.createdAt);
    await gateway!.stop();
    await f.restart();
    transport.unavailable = false;
    await startGateway();
    await f.settled(row.stimulusId, f.member);
    expect(transport.sent).toEqual([]);
    expect(archive()).toEqual([]);
    expect(f.turns).toHaveLength(turns);
    expect(failures).toEqual([
      'fixture disconnected',
      expect.stringContaining('Personal notice person lifecycle changed'),
    ]);
    expect(f.runtime.surface.personalNotices.isClosed(row)).toBe(true);
  });

  it('checks refs before the initial send when access changes during the model turn', async () => {
    const { f, repo, fact, grant, call, rows, failures } = await setup(false);
    grant('fixture-during-turn');
    const ref = await fact('fixture-during-turn');
    let release!: () => void;
    f.holdMemberCompletion(
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    try {
      await call(f.member, [ref]);
      await vi.waitFor(() =>
        expect(f.turns.some((turn) => turn.principal === f.member)).toBe(true)
      );
      repo().revokeScope({
        targetPrincipalId: f.member,
        ownerPrincipalId: 'owner',
        scope: { kind: 'memory', scopeKind: 'project', scopeId: 'fixture-during-turn' },
        now: Date.now(),
      });
    } finally {
      release();
      f.holdMemberCompletion(undefined);
    }
    await f.settled(rows()[0]!.stimulus_id, f.member);
    expect(transport.sent).toEqual([]);
    expect(failures).toEqual([
      expect.stringContaining('Personal notice ref is no longer readable'),
    ]);
  });

  it('eleven close receipts stay in export but out of recall and a fresh session', async () => {
    const { f, call, rows, observationRef } = await setup(false);
    const scopes = [{ kind: 'user' as const, id: f.member }];
    await appendJudgment(
      {
        commandId: 'fixture-personal-fact',
        topic: 'fixture-personal',
        recordKind: 'judgment',
        summary: 'PERSONAL_FACT_RETAINED',
        payload: {},
        scopes,
        record: { kind: 'fact', status: 'active' },
      },
      { principalId: f.member, agentId: 'fixture-agent', actions: [], scopes },
      { adapter: f.runtime.database.adapter, embedder: null }
    );
    createPrincipalRepository(f.runtime.database.adapter).grantScope({
      targetPrincipalId: f.member,
      ownerPrincipalId: 'owner',
      scope: { kind: 'source', connector: 'slack', channelId: 'fixture-room' },
      now: Date.now(),
    });
    f.memberResponse('[ack]');
    for (let n = 0; n < 11; n++) {
      expect(await call(f.member, [{ observationRef }])).toMatchObject({
        status: 'completed',
        data: { queued: true },
      });
      await f.settled(rows()[n]!.stimulus_id, f.member);
    }
    const exported = exportPrincipalRecords(f.runtime.database.adapter, f.member);
    expect(
      exported.stores.decisions.filter(
        (record) => JSON.parse(String(record.payload_json)).type === 'personal-notice-close'
      )
    ).toHaveLength(11);
    const recall = await recallMemory(f.runtime.database.adapter, 'Personal notice closed', {
      scopes,
      includeProfile: false,
      limit: 20,
    });
    expect(JSON.stringify(recall)).not.toContain('personal-notice/closed');
    await f.restart();
    const dm = f.message(f.member);
    await f.settled(dm, f.member);
    const prompt = f.turns.findLast((turn) => turn.principal === f.member)!.prompt;
    expect(prompt).toContain('PERSONAL_FACT_RETAINED');
    expect(prompt).not.toContain('Personal notice closed');
  });

  it('a ref store error reaches the enqueue caller instead of no_readable_refs', async () => {
    const { f, call, observationRef, rows } = await setup();
    const read = f.runtime.surface.catalog.entry('source.read').exec;
    f.runtime.surface.catalog.entry('source.read').exec = () => {
      throw new Error('fixture raw store failure');
    };
    try {
      expect(await call(f.member, [{ observationRef }])).toMatchObject({
        status: 'failed',
        error: { message: expect.stringContaining('fixture raw store failure') },
      });
      expect(rows()).toEqual([]);
    } finally {
      f.runtime.surface.catalog.entry('source.read').exec = read;
    }
  });

  it('a ref store error before the notice turn stays retryable and never closes it', async () => {
    const { f, notice, rows } = await setup();
    let release!: () => void;
    f.blockMember(
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    const blocker = f.message(f.member);
    await vi.waitFor(() => expect(f.turns.some((turn) => turn.principal === f.member)).toBe(true));
    const read = f.runtime.surface.catalog.entry('source.read').exec;
    try {
      await notice();
      f.runtime.surface.catalog.entry('source.read').exec = () => {
        throw new Error('fixture raw store retry');
      };
      release();
      f.blockMember(undefined);
      await f.settled(blocker, f.member);
      await vi.waitFor(() =>
        expect(f.runtime.runtime.mailbox!.readInput(rows()[0]!.stimulus_id, f.member)?.status).toBe(
          'pending'
        )
      );
      const row = f.runtime.runtime.mailbox!.readInput(rows()[0]!.stimulus_id, f.member)!;
      expect(row.attempts).toBeGreaterThan(0);
      expect(f.runtime.surface.personalNotices.isClosed(row)).toBe(false);
      expect(transport.sent).toEqual([]);
    } finally {
      release();
      f.blockMember(undefined);
      f.runtime.surface.catalog.entry('source.read').exec = read;
    }
    f.runtime.database.adapter
      .prepare("UPDATE mailbox_inputs SET retry_after=0 WHERE channel_key='notice'")
      .run();
    await f.runtime.runtime.drainOnce();
    await f.settled(rows()[0]!.stimulus_id, f.member);
    expect(transport.sent).toHaveLength(1);
  });

  it('a record order delivers one stateless co-owner DM and archives only refs and the agent reply', async () => {
    const { f, rows, archive, observationRef, delta } = await setup();
    const dm = f.message(f.member);
    await f.settled(dm, f.member);
    const dmSession = f.turns.findLast((t) => t.principal === f.member)!.session;
    f.memberResponse('The assignment needs your attention.');
    expect(
      await f.actRecordDelta(
        'member.notice',
        { principalId: f.member, refs: [{ observationRef }] },
        delta
      )
    ).toMatchObject({ status: 'completed', data: { queued: true } });
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    await f.settled(rows()[0]!.stimulus_id, f.member);
    expect(transport.sent).toEqual([
      { chatId: 21001, text: 'The assignment needs your attention.' },
    ]);
    const turn = f.turns.findLast((t) => t.principal === f.member)!;
    expect(turn.fresh).toBe(true);
    expect(turn.session).not.toBe(dmSession);
    expect(turn.prompt).toContain(observationRef);
    expect(turn.prompt).not.toContain('COMMON_PRIVATE_PREVIEW');
    expect(rows()[0]!.payload_json).not.toContain('COMMON_PRIVATE_PREVIEW');
    expect(archive()).toEqual([
      {
        author: 'host',
        content: JSON.stringify([{ observationRef }]),
        memory_scope_id: f.member,
        kind: 'notice_refs',
      },
      {
        author: `member-agent:${f.member}`,
        content: 'The assignment needs your attention.',
        memory_scope_id: f.member,
        kind: 'notice_reply',
      },
    ]);
    expect(f.ledger.listForTelegramDm('21001')).toHaveLength(1);
    const next = f.message(f.member);
    await f.settled(next, f.member);
    expect(f.turns.findLast((t) => t.principal === f.member)!.session).toBe(dmSession);
  });

  it('directory works in a delta, exposes partitions and no transport identities, and is absent for members', async () => {
    const { f, repo } = await setup(false);
    repo().grantScope({
      targetPrincipalId: f.member,
      ownerPrincipalId: 'owner',
      scope: { kind: 'memory', scopeKind: 'project', scopeId: 'fixture-partition' },
      now: Date.now(),
    });
    const result = await f.actDelta(
      'member.directory',
      {},
      {
        kind: 'source_delta',
        collector: 'slack',
        channel: 'fixture-room',
        coalesceKey: 'directory',
        preview: [],
        occurredAt: Date.now(),
        refs: [
          {
            connector: 'slack',
            sourceId: 'directory-ref',
            sourceEntityId: 'directory-ref',
            observedAt: new Date().toISOString(),
            contentHash: null,
            observationRef: 'directory-obs',
            sourceAt: new Date().toISOString(),
            author: 'fixture-author',
            contentPreview: 'A current fact.',
          },
        ],
      }
    );
    expect(result).toMatchObject({
      status: 'completed',
      data: {
        members: expect.arrayContaining([
          expect.objectContaining({
            principalId: f.member,
            status: 'active',
            roles: [],
            grants: [{ kind: 'memory', scopeKind: 'project', scopeId: 'fixture-partition' }],
          }),
        ]),
      },
    });
    expect(JSON.stringify(result)).not.toContain('21001');
    expect(JSON.stringify(result)).not.toContain('recentEnrollments');
    const denied = await f.act('member.directory');
    await f.settled(denied.ref, f.member);
    expect(denied.result.status).not.toBe('completed');
  });

  it('[ack] closes privately without a DM or chat exchange', async () => {
    const { f, notice, rows, archive } = await setup();
    f.memberResponse(' [ack] ');
    expect(await notice()).toMatchObject({ status: 'completed', data: { queued: true } });
    await f.settled(rows()[0]!.stimulus_id, f.member);
    expect(transport.sent).toEqual([]);
    expect(archive()).toEqual([]);
    expect(
      f.runtime.surface.personalNotices.isClosed(
        f.runtime.runtime.mailbox!.readInput(rows()[0]!.stimulus_id, f.member)!
      )
    ).toBe(true);
    expect(
      f.runtime.database.adapter
        .prepare(
          "SELECT 1 FROM decisions d JOIN memory_scope_bindings b ON b.memory_id=d.id JOIN memory_scopes s ON s.id=b.scope_id WHERE json_extract(d.payload_json, '$.type')='personal-notice-close' AND s.external_id='owner'"
        )
        .get()
    ).toBeUndefined();
  });

  it('[ack] closes and settles without a Telegram gateway; receipts retire through the ledger', async () => {
    const { f, notice, rows } = await setup();
    await gateway!.stop();
    gateway = undefined; // Telegram off: any call through the gateway port would throw here.
    f.memberResponse('[ack]');
    expect(await notice()).toMatchObject({ status: 'completed', data: { queued: true } });
    await f.settled(rows()[0]!.stimulus_id, f.member);
    expect(f.runtime.runtime.mailbox!.readInput(rows()[0]!.stimulus_id, f.member)?.status).toBe(
      'acked'
    );
    expect(transport.sent).toEqual([]);
  });

  it('plain members get only granted partition refs; all unreadable refs queue nothing', async () => {
    const { f, grant, fact, call, rows, observationRef, archive } = await setup(false);
    grant('fixture-readable');
    const readable = await fact('fixture-readable');
    const unreadable = await fact('fixture-outside');
    expect(await call(f.member, [unreadable, { observationRef }])).toMatchObject({
      status: 'completed',
      data: { queued: false, reason: 'no_readable_refs' },
    });
    expect(rows()).toEqual([]);
    f.read([readable.memory_id, unreadable.memory_id]);
    f.memberResponse('A granted fact needs attention.');
    expect(await call(f.member, [unreadable, readable, { observationRef }])).toMatchObject({
      status: 'completed',
      data: { queued: true },
    });
    await f.settled(rows()[0]!.stimulus_id, f.member);
    expect(JSON.parse(rows()[0]!.payload_json).refs).toEqual([readable]);
    const turn = f.turns.findLast((t) => t.principal === f.member)!;
    expect(turn.prompt).toContain(readable.memory_id);
    expect(turn.prompt).not.toContain(unreadable.memory_id);
    expect(turn.prompt).not.toContain(observationRef);
    expect(f.reads.at(-1)![0]!.status).toBe('completed');
    expect(f.reads.at(-1)![1]).toMatchObject({ status: 'completed', data: { record: null } });
    expect(transport.sent).toEqual([{ chatId: 21001, text: 'A granted fact needs attention.' }]);
    expect(archive()).toHaveLength(2);
  });

  it('refuses personal memory and the recipient DM even when the recipient can read them', async () => {
    const { f, call, rows, archive } = await setup(false);
    const personalScopes = [{ kind: 'user' as const, id: f.member }];
    const receipt = await appendJudgment(
      {
        commandId: 'fixture-personal-fact',
        topic: 'fixture-personal',
        recordKind: 'judgment',
        summary: 'A private fact',
        payload: {},
        record: { kind: 'fact', status: 'active' },
        scopes: personalScopes,
      },
      {
        principalId: f.member,
        agentId: `member-agent:${f.member}`,
        scopes: personalScopes,
        actions: [],
      },
      { adapter: f.runtime.database.adapter, embedder: null }
    );
    const raw = new RawStore(join(f.home, 'raw'));
    const chat = new ChatSources(
      raw,
      f.runtime.database.adapter,
      f.member,
      `member-agent:${f.member}`
    );
    const observationRef = chat.saveOwnerMessage({
      id: 'telegram:fixture:private',
      channelKey: f.memberDm,
      occurredAt: Date.now(),
      text: 'A private DM',
    });
    raw.close();
    const privateRefs = [{ memory_id: receipt.recordId }, { observationRef }];
    for (const ref of privateRefs) {
      const read = await f.act('observationRef' in ref ? 'source.read' : 'memory.read:record', ref);
      await f.settled(read.ref, f.member);
      expect(read.result).toMatchObject({ status: 'completed' });
      if ('memory_id' in ref)
        expect((read.result as { data: { record: unknown } }).data.record).not.toBeNull();
    }
    const source = f.message('owner');
    await f.settled(source);
    for (const ref of [
      ...privateRefs,
      { memory_id: 'fixture-missing' },
      { observationRef: 'fixture-missing' },
    ])
      expect(await call(f.member, [ref], source)).toMatchObject({
        status: 'completed',
        data: { queued: false, reason: 'no_readable_refs' },
      });
    expect(rows()).toEqual([]);
    expect(archive()).toEqual([]);
    expect(transport.sent).toEqual([]);
  });

  it('drops already-noticed observations when a failed record batch rides the next delta', async () => {
    const { f, delta, observationRef, call, rows, grant, fact } = await setup();
    expect(
      await f.actRecordDelta(
        'member.notice',
        {
          principalId: f.member,
          refs: [{ observationRef }],
        },
        delta
      )
    ).toMatchObject({ status: 'completed', data: { queued: true } });
    const previousDelta = sourceDeltaStimulusId(delta);
    await f.settled(`record:${previousDelta}:1`);
    await f.settled(rows()[0]!.stimulus_id, f.member);
    // No work revision or no-update was written: the real record checker carries this batch.
    const raw = new RawStore(join(f.home, 'raw'));
    const [item] = raw.save(
      'slack',
      [
        {
          source: 'slack',
          sourceId: 'fixture-next-event',
          channel: 'fixture-room',
          author: 'fixture-author',
          content: 'A new common fact',
          timestamp: new Date(),
          type: 'message',
        },
      ],
      { collectOnly: true }
    );
    const [projection] = createCoreRawIndexSink(f.runtime.database.adapter)('slack', [item!]);
    raw.acknowledgeProjection('slack', item!.sourceId, item!.pendingProjectionId!);
    raw.close();
    const nextRef = projection!.observationRef;
    const nextDelta = {
      ...delta,
      coalesceKey: 'fixture-next-event',
      refs: [
        {
          ...delta.refs[0]!,
          sourceId: item!.sourceId,
          sourceEntityId: item!.sourceEntityId!,
          observationRef: nextRef,
          sourceAt: item!.timestamp.toISOString(),
        },
      ],
    };
    expect(
      await f.actRecordDelta(
        'member.notice',
        {
          principalId: f.member,
          refs: [{ source: 'slack', observationRef }],
        },
        nextDelta
      )
    ).toMatchObject({
      status: 'completed',
      data: { queued: false, reason: 'already_queued' },
    });
    const nextOrder = `record:${sourceDeltaStimulusId(nextDelta)}:1`;
    await f.settled(nextOrder);
    expect(f.runtime.runtime.mailbox!.readInput(nextOrder, 'owner')!.payload).toMatchObject({
      carried: [{ deltaStimulusId: previousDelta, observationRefs: [observationRef], attempt: 2 }],
    });
    expect(rows()).toHaveLength(1);
    grant('fixture-new-record');
    const memory = await fact('fixture-new-record');
    expect(
      await call(f.member, [{ observationRef }, { observationRef: nextRef }, memory], nextOrder)
    ).toMatchObject({ status: 'completed', data: { queued: true } });
    await f.settled(rows()[1]!.stimulus_id, f.member);
    expect(JSON.parse(rows()[1]!.payload_json).refs).toEqual([{ observationRef: nextRef }, memory]);
    const prompt = f.turns.findLast((turn) => turn.principal === f.member)!.prompt;
    expect(prompt).not.toContain(observationRef);
    expect(prompt).toContain(nextRef);
    expect(prompt).toContain(memory.memory_id);
    expect(transport.sent).toHaveLength(2);
  });

  it('marks a carried batch first noticed on a later delta and suppresses it on the next carry', async () => {
    const { f, delta, observationRef, rows, call, startGateway } = await setup();
    const nextDelta = (id: string) => {
      const raw = new RawStore(join(f.home, 'raw'));
      const [item] = raw.save(
        'slack',
        [
          {
            source: 'slack',
            sourceId: id,
            channel: 'fixture-room',
            author: 'fixture-author',
            content: 'A later common fact',
            timestamp: new Date(),
            type: 'message',
          },
        ],
        { collectOnly: true }
      );
      const [projection] = createCoreRawIndexSink(f.runtime.database.adapter)('slack', [item!]);
      raw.acknowledgeProjection('slack', item!.sourceId, item!.pendingProjectionId!);
      raw.close();
      return {
        ...delta,
        coalesceKey: id,
        refs: [
          {
            ...delta.refs[0]!,
            sourceId: id,
            sourceEntityId: item!.sourceEntityId!,
            observationRef: projection!.observationRef,
          },
        ],
      };
    };
    // The first batch fails the real record checker without ever queueing a notice.
    await f.actRecordDelta('member.directory', {}, delta);
    await f.settled(`record:${sourceDeltaStimulusId(delta)}:1`);
    const second = nextDelta('fixture-second-carry');
    expect(
      await f.actRecordDelta(
        'member.notice',
        { principalId: f.member, refs: [{ observationRef }] },
        second
      )
    ).toMatchObject({ status: 'completed', data: { queued: true } });
    await f.settled(`record:${sourceDeltaStimulusId(second)}:1`);
    await f.settled(rows()[0]!.stimulus_id, f.member);
    // Restart proves the marker survives, including the recipient's closed notice.
    await gateway!.stop();
    await f.restart();
    await startGateway();
    const third = nextDelta('fixture-third-carry');
    const thirdOrder = `record:${sourceDeltaStimulusId(third)}:1`;
    expect(
      await f.actRecordDelta(
        'member.notice',
        // A work record id cited with the already-noticed observation does not reopen it.
        {
          principalId: f.member,
          refs: [{ source: 'slack', observationRef }, { memory_id: 'mem_fixture_carried_work' }],
        },
        third
      )
    ).toMatchObject({ status: 'completed', data: { queued: false, reason: 'already_queued' } });
    await f.settled(thirdOrder);
    expect(f.runtime.runtime.mailbox!.readInput(thirdOrder, 'owner')!.payload).toMatchObject({
      carried: expect.arrayContaining([
        expect.objectContaining({
          deltaStimulusId: sourceDeltaStimulusId(delta),
          observationRefs: [observationRef],
        }),
      ]),
    });
    expect(rows()).toHaveLength(1);
    expect(transport.sent).toHaveLength(1);
    // Marking the carried batch must not consume the new delta's unrelated observation.
    expect(
      await call(
        f.member,
        [{ observationRef }, { observationRef: third.refs[0]!.observationRef }],
        thirdOrder
      )
    ).toMatchObject({ status: 'completed', data: { queued: true } });
    await f.settled(rows()[1]!.stimulus_id, f.member);
    expect(JSON.parse(rows()[1]!.payload_json).refs).toEqual([
      { observationRef: third.refs[0]!.observationRef },
    ]);
  });

  it('atomically marks every included carried batch without consuming the mailbox ref budget', async () => {
    const { f, record, observationRef, rows } = await setup();
    const order = record();
    const carried = Array.from({ length: 500 }, (_, n) => ({
      ...order.payload,
      deltaStimulusId: `fixture-carried-${n}`,
      attempt: 2,
    }));
    f.memberResponse('[ack]');
    expect(
      await f.actScheduled({ ...order, payload: { ...order.payload, carried } }, 'member.notice', {
        principalId: f.member,
        refs: [{ observationRef }],
      })
    ).toMatchObject({ status: 'completed', data: { queued: true } });
    await f.settled(rows()[0]!.stimulus_id, f.member);
    const input = f.runtime.runtime.mailbox!.readInput(rows()[0]!.stimulus_id, f.member)!;
    expect(input.refs).toHaveLength(501);
    expect(
      f.runtime.database.adapter
        .prepare(
          "SELECT COUNT(*) AS n FROM mailbox_seen WHERE principal_id=? AND ref_id LIKE 'notice:%'"
        )
        .get(f.member)
    ).toEqual({ n: 501 });
  });

  it('a plain member can receive and read a delta observation granted by source channel', async () => {
    const { f, repo, observationRef, rows, delta } = await setup(false);
    repo().grantScope({
      targetPrincipalId: f.member,
      ownerPrincipalId: 'owner',
      now: Date.now(),
      scope: { kind: 'source', connector: 'slack', channelId: 'fixture-room' },
    });
    // The recipient's actual native turn calls source.read, rather than trusting prompt text.
    f.memberResponse('A granted source fact needs attention.');
    f.onMemberAction('source.read', { observationRef });
    expect(
      await f.actRecordDelta(
        'member.notice',
        {
          principalId: f.member,
          refs: [{ observationRef }],
        },
        delta
      )
    ).toMatchObject({ status: 'completed', data: { queued: true } });
    await f.settled(rows()[0]!.stimulus_id, f.member);
    expect(JSON.parse(rows()[0]!.payload_json).refs).toEqual([{ observationRef }]);
    expect(f.turns.findLast((turn) => turn.principal === f.member)!.prompt).toContain(
      observationRef
    );
    expect(f.memberActionResult()).toMatchObject({
      status: 'completed',
      data: expect.stringContaining('Assigned to'),
    });
    expect(transport.sent).toEqual([
      { chatId: 21001, text: 'A granted source fact needs attention.' },
    ]);
  });

  it.each([
    { kind: 'memory' as const, keepReadable: false },
    { kind: 'memory' as const, keepReadable: true },
    { kind: 'source' as const, keepReadable: false },
    { kind: 'source' as const, keepReadable: true },
  ])(
    'rechecks revoked $kind refs before the recipient turn (remaining ref: $keepReadable)',
    async ({ kind, keepReadable }) => {
      const { f, repo, grant, fact, call, rows, archive, observationRef } = await setup(false);
      const scope =
        kind === 'memory'
          ? { kind: 'memory' as const, scopeKind: 'project' as const, scopeId: 'fixture-revoked' }
          : { kind: 'source' as const, connector: 'slack', channelId: 'fixture-room' };
      repo().grantScope({
        targetPrincipalId: f.member,
        ownerPrincipalId: 'owner',
        now: Date.now(),
        scope,
      });
      const revoked = kind === 'memory' ? await fact('fixture-revoked') : { observationRef };
      const revokedId = 'memory_id' in revoked ? revoked.memory_id : revoked.observationRef;
      grant('fixture-kept');
      const kept = await fact('fixture-kept');
      let release!: () => void;
      f.blockMember(
        new Promise<void>((resolve) => {
          release = resolve;
        })
      );
      const blocker = f.message(f.member);
      await vi.waitFor(() =>
        expect(f.turns.some((turn) => turn.principal === f.member)).toBe(true)
      );
      const before = f.turns.filter((turn) => turn.principal === f.member).length;
      try {
        expect(await call(f.member, keepReadable ? [revoked, kept] : [revoked])).toMatchObject({
          status: 'completed',
          data: { queued: true },
        });
        repo().revokeScope({
          targetPrincipalId: f.member,
          ownerPrincipalId: 'owner',
          now: Date.now(),
          scope,
        });
        f.read([kept.memory_id]);
        f.memberResponse('Only the readable fact needs attention.');
      } finally {
        release();
        f.blockMember(undefined);
      }
      await f.settled(blocker, f.member);
      await f.settled(rows()[0]!.stimulus_id, f.member);
      expect(f.turns.filter((turn) => turn.principal === f.member)).toHaveLength(
        before + (keepReadable ? 1 : 0)
      );
      if (keepReadable) {
        const prompt = f.turns.findLast((turn) => turn.principal === f.member)!.prompt;
        expect(prompt).toContain(kept.memory_id);
        expect(prompt).not.toContain(revokedId);
        expect(f.reads.at(-1)![0]).toMatchObject({
          status: 'completed',
          data: { record: expect.any(Object) },
        });
        expect(transport.sent).toHaveLength(1);
      } else {
        expect(transport.sent).toEqual([]);
        expect(archive()).toEqual([]);
      }
      expect(
        f.runtime.surface.personalNotices.isClosed(
          f.runtime.runtime.mailbox!.readInput(rows()[0]!.stimulus_id, f.member)!
        )
      ).toBe(true);
    }
  );

  it('duplicate calls and retried record orders with different refs and operation ids never open another notice', async () => {
    const { f, notice, call, rows, observationRef } = await setup();
    await notice();
    await f.settled(rows()[0]!.stimulus_id, f.member);
    expect(
      await call(f.member, [{ memory_id: 'unreadable-new-ref' }], 'record:fixture-delta:1')
    ).toMatchObject({ status: 'completed', data: { queued: false, reason: 'already_queued' } });
    expect(await notice([{ observationRef }], 2)).toMatchObject({
      status: 'completed',
      data: { queued: false, reason: 'already_queued' },
    });
    expect(rows()).toHaveLength(1);
    expect(transport.sent).toHaveLength(1);
  });

  it('keeps deduplication after mailbox input and seen retention ends', async () => {
    const { f, notice, call, rows, observationRef } = await setup();
    await notice();
    await f.settled(rows()[0]!.stimulus_id, f.member);
    const id = rows()[0]!.stimulus_id;
    f.runtime.database.adapter.prepare('DELETE FROM mailbox_inputs WHERE stimulus_id=?').run(id);
    f.runtime.database.adapter.prepare('DELETE FROM mailbox_seen WHERE ref_id=?').run(id);
    expect(await call(f.member, [{ observationRef }], 'record:fixture-delta:1')).toMatchObject({
      status: 'completed',
      data: { queued: false, reason: 'already_queued' },
    });
    expect(rows()).toEqual([]);
    expect(transport.sent).toHaveLength(1);
  });

  it('a backfill record order marked replay queues nothing even without its old delta row', async () => {
    const { f, record, rows, observationRef } = await setup();
    const input = record();
    expect(
      await f.actScheduled(
        { ...input, payload: { ...input.payload, replay: true } },
        'member.notice',
        { principalId: f.member, refs: [{ observationRef }] }
      )
    ).toMatchObject({ status: 'completed', data: { queued: false, reason: 'replay' } });
    expect(rows()).toEqual([]);
  });

  it('returns while the recipient is in a long turn and delivers after it finishes', async () => {
    const { f, notice, rows } = await setup();
    let release!: () => void;
    f.blockPrincipal(
      f.member,
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    const dm = f.message(f.member);
    await vi.waitFor(() => expect(f.turns.some((t) => t.principal === f.member)).toBe(true));
    try {
      expect(await notice()).toMatchObject({ status: 'completed', data: { queued: true } });
      expect(rows()).toHaveLength(1);
      expect(transport.sent).toEqual([]);
    } finally {
      release();
      f.blockPrincipal(f.member, undefined);
    }
    await f.settled(dm, f.member);
    await f.settled(rows()[0]!.stimulus_id, f.member);
    expect(transport.sent).toHaveLength(1);
  });

  it('serves an active unserved recipient without waiting in the common action', async () => {
    const { f, repo, call, rows, observationRef } = await setup();
    const target = repo().registerMember({
      connector: 'telegram',
      namespace: 'private',
      externalId: '22002',
      now: Date.now(),
    });
    repo().grantRole({ principalId: target, role: 'owner' });
    expect(await call(target, [{ observationRef }])).toMatchObject({
      status: 'completed',
      data: { queued: true },
    });
    await f.settled(rows()[0]!.stimulus_id, target);
    expect(transport.sent).toEqual([{ chatId: 22002, text: 'fixture answer' }]);
  });

  it('keeps one unserved recipient notice waiting while the directory lane waits for another long turn', async () => {
    const { f, repo, call, rows, observationRef } = await setup();
    const target = repo().registerMember({
      connector: 'telegram',
      namespace: 'private',
      externalId: '22002',
      now: Date.now(),
    });
    repo().grantRole({ principalId: target, role: 'owner' });
    const source = f.message('owner');
    await f.settled(source);
    let release!: () => void;
    f.blockPrincipal(
      f.member,
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    const busy = f.message(f.member);
    await vi.waitFor(() => expect(f.turns.some((turn) => turn.principal === f.member)).toBe(true));
    try {
      expect(await call(target, [{ observationRef }], source)).toMatchObject({
        status: 'completed',
        data: { queued: true },
      });
      await f.runtime.runtime.drainOnce();
      expect(['pending', 'claimed']).toContain(rows()[0]!.status);
      expect(
        f.runtime.runtime.mailbox!.readInput(rows()[0]!.stimulus_id, target)?.nativeDelivery
      ).toBeUndefined();
      expect(
        f.runtime.database.adapter
          .prepare('SELECT COUNT(*) AS n FROM mailbox_inputs WHERE principal_id=?')
          .get(target)
      ).toEqual({ n: 1 });
      expect(transport.sent).toEqual([]);
    } finally {
      release();
      f.blockPrincipal(f.member, undefined);
    }
    await f.settled(busy, f.member);
    await f.settled(rows()[0]!.stimulus_id, target);
    expect(transport.sent).toEqual([{ chatId: 22002, text: 'fixture answer' }]);
  });

  it.each(['before-send', 'after-send-before-archive'])(
    'restart %s delivers and archives once',
    async (point) => {
      const { f, notice, rows, archive, startGateway } = await setup();
      let save: ReturnType<typeof vi.spyOn> | undefined;
      if (point === 'before-send') transport.unavailable = true;
      else {
        const original = ChatSources.prototype.savePersonalExchange;
        save = vi
          .spyOn(ChatSources.prototype, 'savePersonalExchange')
          .mockImplementation(function (input) {
            if (input.kind === 'notice') throw new Error('fixture archive interrupted');
            return original.call(this, input);
          });
      }
      await notice();
      await vi.waitFor(() =>
        expect(
          f.runtime.runtime.mailbox!.readInput(rows()[0]!.stimulus_id, f.member)?.nativeDelivery
            ?.state
        ).toBe('uncertain')
      );
      expect(transport.sent).toHaveLength(point === 'before-send' ? 0 : 1);
      const turns = f.turns.length;
      save?.mockRestore();
      await gateway!.stop();
      transport.unavailable = false;
      await f.restart();
      await startGateway();
      await vi.waitFor(async () => {
        await f.runtime.runtime.drainOnce();
        expect(rows()[0]!.status).toBe('acked');
      });
      expect(transport.sent).toHaveLength(1);
      expect(archive()).toHaveLength(2);
      expect(f.turns).toHaveLength(turns);
      await gateway!.stop();
      await f.restart();
      await startGateway();
      expect(transport.sent).toHaveLength(1);
      expect(archive()).toHaveLength(2);
    }
  );

  it('replay windows and their record-order attempts queue nothing', async () => {
    const { f, observationRef, rows, record } = await setup();
    const now = Date.now();
    const replay = {
      kind: 'source_delta' as const,
      collector: 'slack',
      channel: 'fixture-room',
      coalesceKey: 'replay',
      preview: [],
      occurredAt: now,
      refs: [
        {
          connector: 'slack',
          sourceId: 'fixture-event',
          sourceEntityId: 'fixture-event',
          observationRef,
          sourceAt: new Date(now).toISOString(),
          observedAt: new Date(now).toISOString(),
          contentHash: null,
          contentPreview: 'Assigned to a member.',
        },
      ],
      replay: {
        runId: 'fixture-replay',
        windowId: 'window',
        windowStartMs: now - 1000,
        windowEndMs: now + 1,
      },
    };
    expect(
      await f.actDelta(
        'member.notice',
        { principalId: f.member, refs: [{ observationRef }] },
        replay
      )
    ).toMatchObject({ status: 'completed', data: { queued: false, reason: 'replay' } });
    const replayRow = f.runtime.database.adapter
      .prepare("SELECT stimulus_id FROM mailbox_inputs WHERE kind='source_delta'")
      .get() as { stimulus_id: string };
    const order = record();
    order.id = `record:${replayRow.stimulus_id}:1`;
    order.payload.deltaStimulusId = replayRow.stimulus_id;
    expect(
      await f.actScheduled(order, 'member.notice', {
        principalId: f.member,
        refs: [{ observationRef }],
      })
    ).toMatchObject({ status: 'completed', data: { queued: false, reason: 'replay' } });
    expect(rows()).toEqual([]);
  });

  it.each(['suspended', 'offboarded', 'common'])('refuses %s recipients', async (status) => {
    const { f, repo, call, rows, observationRef } = await setup(false);
    if (status === 'suspended') repo().suspend(f.member, Date.now());
    if (status === 'offboarded') repo().offboard(f.member, Date.now());
    expect(
      await call(status === 'common' ? 'owner' : f.member, [{ observationRef }])
    ).toMatchObject({
      status: 'completed',
      data: { queued: false, reason: 'recipient_not_active_member' },
    });
    expect(rows()).toEqual([]);
    expect(transport.sent).toEqual([]);
  });

  it('a queued notice suspended before its turn closes without sending', async () => {
    const { f, repo, notice, rows } = await setup();
    const source = f.message('owner');
    await f.settled(source);
    f.runtime.runtime.unservePrincipal(f.member);
    // Hold the real directory lane so the durable row exists before serving can start.
    let release!: () => void;
    const busy = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.blockPrincipal(f.managingOwner, busy);
    const blocker = f.message(f.managingOwner);
    await vi.waitFor(() => expect(f.turns.some((t) => t.principal === f.managingOwner)).toBe(true));
    try {
      await notice();
      repo().suspend(f.member, Date.now());
    } finally {
      release();
      f.blockPrincipal(f.managingOwner, undefined);
    }
    await f.settled(blocker, f.managingOwner);
    await vi.waitFor(async () => {
      await f.runtime.runtime.drainOnce();
      expect(rows()[0]!.status).toBe('dead');
    });
    expect(transport.sent).toEqual([]);
    expect(
      f.runtime.surface.personalNotices.isClosed(
        f.runtime.runtime.mailbox!.readInput(rows()[0]!.stimulus_id, f.member)!
      )
    ).toBe(true);
  });

  it('definitive rejection closes and retires the notice ledger receipt; restart sends nothing', async () => {
    const { f, notice, rows, archive, failures, startGateway } = await setup();
    transport.reject = true;
    await notice();
    await f.settled(rows()[0]!.stimulus_id, f.member);
    expect(failures).toEqual([expect.stringContaining('Personal notice DM delivery was rejected')]);
    expect(f.ledger.listForTelegramDm('21001')).toEqual([]);
    expect(archive()).toEqual([]);
    transport.reject = false;
    await gateway!.stop();
    await f.restart();
    await startGateway();
    expect(transport.sent).toEqual([]);
  });

  it('P9 exports and erases notice exchanges as personal host/agent records', async () => {
    const { f, notice, rows, archive, uploads } = await setup();
    await notice();
    await f.settled(rows()[0]!.stimulus_id, f.member);
    const exported = exportPrincipalRecords(f.runtime.database.adapter, f.member);
    expect(JSON.stringify(exported)).toContain('notice_refs');
    expect(JSON.stringify(exported)).toContain('notice_reply');
    expect(JSON.stringify(exported)).toContain('personal-notice-close');
    const preview = await f.act('records.erase');
    await f.settled(preview.ref, f.member);
    expect(preview.result.status).toBe('completed');
    const confirmationToken = (preview.result as { data: { confirmationToken: string } }).data
      .confirmationToken;
    const confirmed = await f.act('records.erase', { confirmationToken });
    expect(confirmed.result.status).toBe('completed');
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    const zip = unzipSync(uploads[0]!);
    const contents = Object.values(zip)
      .map((bytes) => new TextDecoder().decode(bytes))
      .join('\n');
    expect(contents).toContain('notice_refs');
    expect(contents).toContain('notice_reply');
    expect(contents).toContain('personal-notice-close');
    await vi.waitFor(() => expect(archive()).toEqual([]));
    expect(rows()).toEqual([]);
    expect(
      f.runtime.database.adapter
        .prepare(
          "SELECT 1 FROM decisions WHERE json_extract(payload_json, '$.type') IN ('personal-notice-close', 'personal-notice-input') AND erased_at IS NULL"
        )
        .get()
    ).toBeUndefined();
    const raw = new RawStore(join(f.home, 'raw'));
    expect(
      raw
        .query('chat', new Date(0))
        .some((item) => ['notice_refs', 'notice_reply'].includes(String(item.metadata?.kind)))
    ).toBe(false);
    raw.close();
  });

  it('waits behind erasure and never sends the notice that the completed erasure removes', async () => {
    const { f, call, rows, observationRef, holdExport, uploads } = await setup();
    const source = f.message('owner');
    await f.settled(source);
    const preview = await f.act('records.erase');
    await f.settled(preview.ref, f.member);
    const confirmationToken = (preview.result as { data: { confirmationToken: string } }).data
      .confirmationToken;
    let release!: () => void;
    holdExport(
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    await f.act('records.erase', { confirmationToken });
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    try {
      expect(await call(f.member, [{ observationRef }], source)).toMatchObject({
        status: 'completed',
        data: { queued: true },
      });
      expect(rows()[0]!.status).toBe('pending');
      await f.runtime.runtime.drainOnce();
      expect(rows()[0]!.status).toBe('pending');
      expect(transport.sent).toEqual([]);
    } finally {
      release();
      holdExport(undefined);
    }
    await vi.waitFor(() => expect(rows()).toEqual([]));
    expect(
      transport.sent.every((sent) =>
        sent.text.includes('Your personal records and files were erased')
      )
    ).toBe(true);
  });

  it('erasure prevents recovery from sending an earlier undelivered notice result', async () => {
    const { f, notice, rows } = await setup();
    transport.unavailable = true;
    f.memberResponse('OLD NOTICE RESULT');
    await notice();
    await vi.waitFor(() =>
      expect(
        f.runtime.runtime.mailbox!.readInput(rows()[0]!.stimulus_id, f.member)?.nativeDelivery
          ?.state
      ).toBe('uncertain')
    );
    f.memberResponse('fixture answer');
    const preview = await f.act('records.erase');
    await f.settled(preview.ref, f.member);
    const confirmationToken = (preview.result as { data: { confirmationToken: string } }).data
      .confirmationToken;
    await f.act('records.erase', { confirmationToken });
    await vi.waitFor(() =>
      expect(
        f.runtime.database.adapter
          .prepare('SELECT 1 FROM principal_erasure_receipts WHERE principal_id=?')
          .get(f.member)
      ).toBeDefined()
    );
    transport.unavailable = false;
    await f.runtime.runtime.drainOnce();
    expect(transport.sent.some((sent) => sent.text === 'OLD NOTICE RESULT')).toBe(false);
  });

  it('retires a ready notice after suspension on restart without gateway recovery sending it', async () => {
    const { f, notice, rows, repo, startGateway } = await setup();
    transport.unavailable = true;
    await notice();
    await vi.waitFor(() =>
      expect(
        f.runtime.runtime.mailbox!.readInput(rows()[0]!.stimulus_id, f.member)?.nativeDelivery
          ?.state
      ).toBe('uncertain')
    );
    const id = rows()[0]!.stimulus_id;
    const row = f.runtime.runtime.mailbox!.readInput(id, f.member)!;
    const access = f.turns.findLast((t) => t.principal === f.member)!.access;
    const ledgerKey = `outbound:${createHash('sha256').update(`text\0${id}`).digest('hex')}`;
    f.ledger.claim(ledgerKey, {
      deliveryTarget: 'telegram:21001',
      payloadIdentity: 'a'.repeat(64),
      idempotencyKey: id,
    });
    f.ledger.markReady(ledgerKey, 'Must not send after suspension', 'html-v1');
    repo().suspend(f.member, Date.now());
    // Cancelled native results can be reconciled by the still-served personal callback.
    transport.unavailable = false;
    await f.runtime.runtime.drainOnce();
    await f.settled(id, f.member);
    expect(f.runtime.surface.personalNotices.isClosed(row)).toBe(true);
    expect(f.ledger.get(ledgerKey)).toBeNull();
    expect(gateway!.memberTextDelivered(access, id)).toBe(false);
    await gateway!.stop();
    await f.restart();
    await startGateway();
    expect(transport.sent).toEqual([]);
  });
});
