import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrincipalRepository, type ActionContext } from '@jungjaehoon/mama-core';
import { Mailbox, type MailboxRow } from '@jungjaehoon/mama-core/runtime/mailbox';
import type { NativeDeliveryContext } from '@jungjaehoon/mama-core/runtime/runtime';
import type { NativeTurnResultRecord } from '@jungjaehoon/mama-core/runtime/native-input-journal';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';
import {
  createPersonalJobScheduler,
  createPersonalJobStore,
  deliverPersonalJobResult,
} from '../../src/runtime/personal-jobs.js';
import {
  createStimulusDelivery,
  type ScheduledInput,
} from '../../src/runtime/stimulus-delivery.js';
import { MEMBER_VOICE } from '../../src/runtime/turn-orders.js';

const at = (iso: string) => Date.parse(iso);
const START = at('2026-01-01T00:05:00Z');
const DUE = at('2026-01-01T01:00:00Z');
describe('personal job scheduling and final settlement', () => {
  let root: string;
  let db: Awaited<ReturnType<typeof openCoreDatabase>>;
  let repo: ReturnType<typeof createPrincipalRepository>;
  let store: ReturnType<typeof createPersonalJobStore>;
  let mailbox: Mailbox;
  let person: string;
  let sequence = 0;
  const clock = (now: number) => vi.mocked(Date.now).mockReturnValue(now);
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'job-scheduler-'));
    vi.stubEnv('HOME', root);
    vi.stubEnv('MAMA_DB_PATH', join(root, 'core.db'));
    vi.stubEnv('MAMA_FORCE_TIER_3', 'true');
    db = await openCoreDatabase({ path: join(root, 'core.db') });
    repo = createPrincipalRepository(db.adapter);
    person = repo.registerMember({
      connector: 'telegram',
      namespace: 'private',
      externalId: 'fixture-job-person',
      now: START,
    });
    store = createPersonalJobStore(db.adapter, createTimeZoneSetting('UTC'));
    mailbox = new Mailbox(db.adapter);
    vi.spyOn(Date, 'now').mockReturnValue(START);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  const context = (id = person): ActionContext => ({
    access: {
      principalId: id,
      agentId: 'fixture-agent',
      scopes: [{ kind: 'user', id }],
      actions: [],
    },
    operationId: `fixture-job-command-${++sequence}`,
  });
  const create = (cron = '0 * * * *', id = person) =>
    store.create({ cron, instruction: 'Check changes' }, context(id));
  const intake = async (id: string) => ({
    acceptScheduled: (input: ScheduledInput) => {
      const inputId = mailbox.enqueue({ ...input, kind: 'scheduled', principalId: id });
      return {
        state: inputId === null ? ('duplicate' as const) : ('accepted' as const),
        inputId: inputId === null ? null : String(inputId),
      };
    },
  });
  const scheduler = (errors: unknown[] = [], serve = intake) =>
    createPersonalJobScheduler({
      adapter: db.adapter,
      store,
      mailbox,
      intake: serve,
      blocked: () => false,
      onError: (error) => errors.push(error),
    });
  const rowFor = (id: string, due = DUE, principal = person) =>
    mailbox.readInput(`job:${id}:${due}`, principal)!;
  const delivery = (
    response: string | null,
    sent: string[],
    failures: string[],
    reject?: unknown
  ) =>
    createStimulusDelivery({
      backend: 'codex',
      timeZone: createTimeZoneSetting('UTC'),
      member: { principalId: person, sessionKey: 'fixture-person-session', voice: MEMBER_VOICE },
      personalJobs: store,
      readResult: () =>
        response === null
          ? null
          : ({ response, modelRunId: 'fixture-run' } as NativeTurnResultRecord),
      onFailed: (_row, reason) => {
        failures.push(reason);
      },
      onScheduledResult: (row, result) =>
        deliverPersonalJobResult(row, result, {
          store,
          access: () => context().access,
          chat: { saveJobExchange: () => {}, hasJobExchange: () => false },
          delivered: () => false,
          send: async (_access, text) => {
            sent.push(text);
            if (reject) throw reject;
            return true;
          },
        }),
    });

  it.each(['[ack]', '', null])(
    'keeps an occurrence closed by %s after a newer completion, without repeating its effects',
    async (response) => {
      const { id } = await create();
      clock(DUE);
      await scheduler().tick(new Date(Date.now()));
      const older = rowFor(id);
      const sent: string[] = [];
      const failures: string[] = [];
      const port = delivery(response, sent, failures);
      expect(await port.reconcile!(older)).toBe('settled');
      const firstFailures = [...failures];
      clock(DUE + 3_600_000);
      await scheduler().tick(new Date(Date.now()));
      const newer = rowFor(id, Date.now());
      expect(await delivery('[ack]', sent, failures).reconcile!(newer)).toBe('settled');
      expect(store.isClosed(older)).toBe(true);
      expect(await port.reconcile!(older)).toBe('settled');
      expect(sent).toEqual([]);
      expect(failures).toEqual(firstFailures);
      expect(store.find(person, id)).toMatchObject({
        lastClosedAt: newer.occurredAt,
        lastCompletedAt: newer.occurredAt,
      });
    }
  );
  it('reports a superseded occurrence without a stored result once and preserves the newer anchors', async () => {
    const { id } = await create();
    clock(DUE);
    await scheduler().tick(new Date(Date.now()));
    const older = rowFor(id);
    clock(DUE + 3_600_000);
    await scheduler().tick(new Date(Date.now()));
    const newer = rowFor(id, Date.now());
    expect(await delivery('[ack]', [], []).reconcile!(newer)).toBe('settled');
    expect(store.isClosed(older)).toBe(false);
    const sent: string[] = [];
    const failures: string[] = [];
    const port = delivery(null, sent, failures);
    expect(await port.reconcile!(older)).toBe('settled');
    expect(await port.reconcile!(older)).toBe('settled');
    expect(sent).toEqual([]);
    expect(failures).toEqual([expect.stringMatching(/superseded/i)]);
    expect(store.isClosed(older)).toBe(true);
    expect(store.find(person, id)).toMatchObject({
      lastClosedAt: newer.occurredAt,
      lastCompletedAt: newer.occurredAt,
    });
  });

  it.each(['empty', 'rejected', 'suspended', 'offboarded', 'changed', 'deleted'])(
    'closes a stored result once after %s without advancing the completion anchor',
    async (failure) => {
      const { id } = await create();
      clock(DUE);
      await scheduler().tick(new Date(Date.now()));
      const row = rowFor(id);
      if (failure === 'suspended') repo.suspend(person, DUE);
      if (failure === 'offboarded') repo.offboard(person, DUE);
      if (failure === 'changed')
        await store.update({ id, instruction: 'Changed instruction' }, context());
      if (failure === 'deleted') await store.delete(id, context());
      const sent: string[] = [];
      const failures: string[] = [];
      const rejection =
        failure === 'rejected'
          ? Object.assign(new Error('Forbidden'), { error_code: 403 })
          : undefined;
      const port = delivery(failure === 'empty' ? '   ' : 'A result', sent, failures, rejection);
      expect(await port.reconcile!(row)).toBe('settled');
      // Once core has settled the input it never reconciles it again.
      mailbox.ack(row.id);
      for (let n = 0; n < 3; n++) await scheduler().tick(new Date(Date.now()));
      expect(sent).toHaveLength(failure === 'rejected' ? 1 : 0);
      expect(failures).toHaveLength(1);
      if (failure !== 'deleted') expect(store.find(person, id)!.lastCompletedAt).toBeNull();
      if (failure === 'suspended') {
        repo.resume(person, DUE + 1);
        await scheduler().tick(new Date(Date.now()));
        expect(mailbox.depth().pending).toBe(0);
        expect(sent).toEqual([]);
      }
    }
  );
  it('skips a pending shutdown occurrence and runs only the latest due row at restart', async () => {
    const { id } = await create();
    clock(at('2026-01-01T10:00:00Z'));
    await scheduler().tick(new Date(Date.now()));
    const pending = rowFor(id, Date.now());
    clock(at('2026-01-01T13:05:00Z'));
    await scheduler().tick(new Date(Date.now()));
    const latest = rowFor(id, at('2026-01-01T13:00:00Z'));
    let runs = 0;
    const native = {
      run: async () => {
        runs++;
        return { response: '[ack]', history: [], modelRunId: 'fixture-run' };
      },
    } as unknown as NativeDeliveryContext;
    const port = delivery('[ack]', [], []);
    await port.deliver(pending, native);
    await port.deliver(latest, native);
    expect(runs).toBe(1);
    expect(store.find(person, id)!.lastCompletedAt).toBe(latest.occurredAt);
  });
  it('checks staleness when a turn leaves a busy personal chain', async () => {
    const { id } = await create();
    clock(DUE);
    await scheduler().tick(new Date(Date.now()));
    let release!: () => void;
    const busy = new Promise<void>((resolve) => {
      release = resolve;
    });
    let runs = 0;
    const port = createStimulusDelivery({
      backend: 'codex',
      timeZone: createTimeZoneSetting('UTC'),
      personalJobs: store,
      member: { principalId: person, sessionKey: 'fixture-session', voice: MEMBER_VOICE },
      turnChain: async (task) => {
        await busy;
        return task();
      },
    });
    const waiting = port.deliver(rowFor(id), {
      run: async () => {
        runs++;
        throw new Error('stale turn ran');
      },
    } as unknown as NativeDeliveryContext);
    clock(at('2026-01-01T13:05:00Z'));
    release();
    await waiting;
    expect(runs).toBe(0);
    expect(store.find(person, id)!.lastCompletedAt).toBeNull();
  });
  it('does not enqueue an interrupted monthly occurrence after mailbox retention expires', async () => {
    const { id } = await create('0 8 1 * *');
    clock(at('2026-01-01T08:00:00Z'));
    await scheduler().tick(new Date(Date.now()));
    const row = rowFor(id, Date.now());
    const interrupted = {
      ...row,
      nativeDelivery: { state: 'accepted' } as MailboxRow['nativeDelivery'],
    };
    expect(await delivery(null, [], []).reconcile!(interrupted)).toBe('settled');
    mailbox.ack(row.id);
    // 31 days later, the February occurrence is not due yet; both retention windows elapsed.
    clock(at('2026-02-01T07:59:00Z'));
    mailbox.replayStaleDetailed(60_000, Date.now());
    expect(mailbox.readInput(row.stimulusId, person)).toBeNull();
    await scheduler().tick(new Date(Date.now()));
    expect(mailbox.depth().pending).toBe(0);
    expect(store.find(person, id)!.lastCompletedAt).toBeNull();
  });
  it('reports one person’s intake failure and still schedules the next person', async () => {
    const other = repo.registerMember({
      connector: 'telegram',
      namespace: 'private',
      externalId: 'fixture-other-job-person',
      now: START,
    });
    const first = repo.listMembers()[0]!.principalId;
    const next = first === person ? other : person;
    await create('0 * * * *', first);
    const { id } = await create('0 * * * *', next);
    clock(DUE);
    const errors: unknown[] = [];
    await expect(
      scheduler(errors, async (id) => {
        if (id === first) throw new Error('fixture serve failed');
        return intake(id);
      }).tick(new Date(Date.now()))
    ).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(rowFor(id, DUE, next)).not.toBeNull();
  });
});
