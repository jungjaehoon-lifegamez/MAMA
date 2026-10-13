import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createKnowledge,
  createPrincipalRepository,
  erasePrincipalRecords,
  exportPrincipalRecords,
  type ActionContext,
  type ActionResult,
} from '@jungjaehoon/mama-core';
import { createActionSurface } from '../../src/runtime/action-surface.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { resolvePrincipalAccess } from '../../src/runtime/principal-access.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';

const NOW = Date.parse('2026-01-01T00:00:00Z');
const input = { cron: '0 8 * * *', instruction: 'Check readable work and tell me what matters.' };
function data<T>(result: ActionResult): T {
  expect(result.status, JSON.stringify(result)).toBe('completed');
  return (result as { data: T }).data;
}
describe('personal jobs through the product catalog', () => {
  let root: string;
  let db: Awaited<ReturnType<typeof openCoreDatabase>>;
  let repo: ReturnType<typeof createPrincipalRepository>;
  let surface: ReturnType<typeof createActionSurface>;
  let owner: string;
  let member: string;
  let sequence = 0;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'job-actions-'));
    vi.stubEnv('HOME', root);
    vi.stubEnv('MAMA_DB_PATH', join(root, 'core.db'));
    vi.stubEnv('MAMA_FORCE_TIER_3', 'true');
    db = await openCoreDatabase({ path: join(root, 'core.db') });
    repo = createPrincipalRepository(db.adapter);
    repo.ensureOwner({ principalId: 'fixture-common', now: 1 });
    [owner, member] = ['fixture-owner-dm', 'fixture-member-dm'].map((externalId) =>
      repo.registerMember({ connector: 'telegram', namespace: 'private', externalId, now: 2 })
    );
    repo.grantRole({ principalId: owner, role: 'owner', now: 3 });
    surface = createActionSurface({
      adapter: db.adapter,
      knowledge: createKnowledge({ adapter: db.adapter, embedder: null }),
      runtimeRoot: root,
      configPath: join(root, 'config.yaml'),
      ownerPrincipalId: 'fixture-common',
      agentId: 'fixture-common-agent',
      timeZone: createTimeZoneSetting('Asia/Seoul'),
      isOwnerMessageTurn: (ref) => ref === 'telegram:fixture-dm:message',
    });
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db?.close();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  const context = (principalId = owner): ActionContext => ({
    access:
      principalId === 'fixture-common'
        ? surface.ownerAccess
        : resolvePrincipalAccess(principalId, {
            adapter: db.adapter,
            ownerAccess: surface.ownerAccess,
            agentId: `fixture-agent:${principalId}`,
          }),
    session: { sourceMessageRef: 'telegram:fixture-dm:message' },
  });
  const call = (action: string, body: unknown = {}, ctx = context()) =>
    surface.dispatch(
      { action: `schedule.job.${action}`, input: body, operationId: `fixture-job-${++sequence}` },
      ctx
    );
  it.each(['owner', 'member'])(
    'creates, lists, revises and retires only the caller’s job in a %s DM',
    async (role) => {
      const person = role === 'owner' ? owner : member;
      const ctx = context(person);
      const created = data<{ id: string }>(await call('create', input, ctx));
      const record = db.adapter
        .prepare("SELECT id FROM decisions WHERE json_extract(payload_json, '$.jobId')=?")
        .get(created.id) as { id: string };
      for (const reader of [person === owner ? member : owner, 'fixture-common']) {
        expect(
          await surface.dispatch(
            { action: 'memory.read:record', input: { memory_id: record.id } },
            context(reader)
          )
        ).toMatchObject({ status: 'completed', data: { record: null } });
      }

      expect(data<{ jobs: unknown[] }>(await call('list', {}, ctx)).jobs).toEqual([
        expect.objectContaining({
          id: created.id,
          ...input,
          enabled: true,
          timeZone: 'Asia/Seoul',
          nextOccurrence: '2026-01-02 Fri 08:00 Asia/Seoul',
          lastCompletedOccurrence: null,
        }),
      ]);
      expect(
        data<{ jobs: unknown[] }>(
          await call('list', {}, context(person === owner ? member : owner))
        ).jobs
      ).toEqual([]);
      data(
        await call(
          'update',
          {
            id: created.id,
            cron: '0 10 * * *',
            timeZone: 'UTC',
            instruction: 'Revised check',
            enabled: false,
          },
          ctx
        )
      );
      expect(data<{ jobs: unknown[] }>(await call('list', {}, ctx)).jobs).toEqual([
        expect.objectContaining({
          id: created.id,
          cron: '0 10 * * *',
          timeZone: 'UTC',
          instruction: 'Revised check',
          enabled: false,
          nextOccurrence: null,
        }),
      ]);
      expect(
        db.adapter
          .prepare(
            "SELECT status FROM decisions WHERE json_extract(payload_json, '$.jobId')=? ORDER BY rowid"
          )
          .all(created.id)
      ).toEqual([{ status: 'superseded' }, { status: 'active' }]);
      data(await call('delete', { id: created.id }, ctx));
      expect(data<{ jobs: unknown[] }>(await call('list', {}, ctx)).jobs).toEqual([]);
      expect(
        db.adapter
          .prepare(
            "SELECT status FROM decisions WHERE json_extract(payload_json, '$.jobId')=? ORDER BY rowid DESC LIMIT 1"
          )
          .get(created.id)
      ).toEqual({ status: 'stale' });
    }
  );
  it.each(['create', 'list', 'update', 'delete'])(
    'refuses %s in the common channel',
    async (action) => {
      const body = action === 'create' ? input : action === 'list' ? {} : { id: 'fixture-job' };
      expect(await call(action, body, context('fixture-common'))).toMatchObject({
        status: 'failed',
        error: { kind: 'denied' },
      });
    }
  );
  it.each(['delta', 'scheduled', 'replay', 'subagent', 'missing', 'suspended'])(
    'refuses an apparent DM in a %s turn',
    async (kind) => {
      const ctx = context();
      if (kind === 'delta' || kind === 'scheduled')
        ctx.session!.sourceMessageRef = `${kind}:fixture`;
      if (kind === 'replay') ctx.session!.replaySourceEndMs = NOW;
      if (kind === 'subagent') ctx.session!.sourceMessageRef = 'subagent:fixture';
      if (kind === 'missing') ctx.session = undefined;
      if (kind === 'suspended') repo.suspend(owner, NOW);
      expect(await call('create', input, ctx)).toMatchObject({
        status: 'failed',
        error: { kind: 'denied' },
      });
    }
  );
  it.each(['bad cron', '60 * * * *', '* * * * *', '0,30 * * * *'])(
    'refuses malformed or too frequent cron %s with a plain reason',
    async (cron) => {
      expect(await call('create', { ...input, cron })).toMatchObject({
        status: 'failed',
        error: { message: expect.stringMatching(/cron|60 minutes/i) },
      });
      expect(data<{ jobs: unknown[] }>(await call('list')).jobs).toEqual([]);
    }
  );
  it('validates zones and schedule changes, and refuses an eleventh enabled job including re-enabling', async () => {
    expect(await call('create', { ...input, timeZone: 'Invalid/Fixture' })).toMatchObject({
      status: 'failed',
      error: { kind: 'invalid_input' },
    });
    const jobs = [];
    for (let n = 0; n < 10; n++) jobs.push(data<{ id: string }>(await call('create', input)));
    expect(await call('create', input)).toMatchObject({
      status: 'failed',
      error: { message: expect.stringMatching(/ten|10/i) },
    });
    expect(await call('update', { id: jobs[0]!.id, cron: '*/15 * * * *' })).toMatchObject({
      status: 'failed',
      error: { kind: 'invalid_input' },
    });
    data(await call('update', { id: jobs[0]!.id, enabled: false }));
    data(await call('create', input));
    expect(await call('update', { id: jobs[0]!.id, enabled: true })).toMatchObject({
      status: 'failed',
      error: { message: expect.stringMatching(/ten|10/i) },
    });
    data(await call('create', input, context(member)));
  });
  it('does not admit a principal input or another person’s job id', async () => {
    const job = data<{ id: string }>(await call('create', input));
    expect(await call('create', { ...input, principalId: member })).toMatchObject({
      status: 'failed',
    });
    for (const action of ['update', 'delete'])
      expect(await call(action, { id: job.id }, context(member))).toMatchObject({
        status: 'failed',
      });
    expect(data<{ jobs: unknown[] }>(await call('list')).jobs).toHaveLength(1);
  });
  it('P9 exports and erases the sole personal binding while keeping the other person’s job', async () => {
    const job = data<{ id: string }>(await call('create', input));
    data(await call('create', input, context(member)));
    expect(
      db.adapter
        .prepare(
          "SELECT s.kind, s.external_id AS id FROM memory_scope_bindings b JOIN memory_scopes s ON s.id=b.scope_id JOIN decisions d ON d.id=b.memory_id WHERE json_extract(d.payload_json, '$.jobId')=?"
        )
        .all(job.id)
    ).toEqual([{ kind: 'user', id: owner }]);
    expect(JSON.stringify(exportPrincipalRecords(db.adapter, owner))).toContain(input.instruction);
    erasePrincipalRecords(db.adapter, { principalId: owner, commandId: 'fixture-job-erasure' });
    expect(data<{ jobs: unknown[] }>(await call('list')).jobs).toEqual([]);
    expect(data<{ jobs: unknown[] }>(await call('list', {}, context(member))).jobs).toHaveLength(1);
  });
});
