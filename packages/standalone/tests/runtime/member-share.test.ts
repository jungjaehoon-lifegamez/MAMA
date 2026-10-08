import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDispatcher,
  createKnowledge,
  createPrincipalRepository,
  erasePrincipalRecords,
  type ActionContext,
  type ActionResult,
  type MemoryScopeRef,
} from '@jungjaehoon/mama-core';
import { createActionSurface } from '../../src/runtime/action-surface.js';
import { resolvePrincipalAccess } from '../../src/runtime/principal-access.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';

const OWNER = 'fixture-owner';
const PARTITION = { kind: 'project' as const, id: 'fixture-partition' };
const REASON = 'Share the complete review history with the project.';
type Revision = { id: string; createdAt: number; summary: string; details: string };
type Snapshot = {
  memoryId: string;
  partitionId: string;
  reason: string;
  current: Revision;
  revisions: Revision[];
};

function data<T>(result: ActionResult): T {
  expect(result.status, JSON.stringify(result)).toBe('completed');
  if (result.status !== 'completed') throw new Error('Action failed');
  return result.data as T;
}

describe('P2b member share through the product catalog and real dispatcher', () => {
  let root: string;
  let db: Awaited<ReturnType<typeof openCoreDatabase>>;
  let repository: ReturnType<typeof createPrincipalRepository>;
  let surface: ReturnType<typeof createActionSurface>;
  let dispatch: ReturnType<typeof createDispatcher>;
  let a: string;
  let b: string;
  let c: string;
  let original: string;
  let earlier: string[];
  let sequence: number;

  const access = (principalId = a) =>
    resolvePrincipalAccess(principalId, {
      adapter: db.adapter,
      ownerAccess: surface.ownerAccess,
      agentId: 'fixture-agent',
    });
  const turn = (principalId = a): ActionContext => ({
    access: access(principalId),
    session: { sourceMessageRef: 'telegram:fixture-dm:fixture-message' },
  });
  const call = (
    action: string,
    input: unknown,
    context = turn(),
    operationId = `fixture-${sequence++}`
  ) => dispatch({ action, input, operationId }, context);
  const share = (input: unknown = {}, context = turn(), operationId?: string) =>
    call(
      'memory.share',
      { memory_id: original, partition_id: PARTITION.id, reason: REASON, ...(input as object) },
      context,
      operationId
    );
  const save = async (
    summary: string,
    details: string,
    principalId = a,
    replaces?: string,
    scopes?: MemoryScopeRef[]
  ) =>
    data<{ id: string }>(
      await call(
        'memory.save',
        {
          topic: 'fixture-review',
          kind: 'fact',
          summary,
          details,
          source: { package: 'fixture', source_type: 'fixture' },
          ...(scopes ? { scopes } : {}),
          ...(replaces ? { replaces: [{ id: replaces, reason: 'A new review revision.' }] } : {}),
        },
        scopes
          ? { ...turn(principalId), access: { ...access(principalId), scopes } }
          : turn(principalId)
      )
    ).id;
  const read = async (id: string, principalId = a) =>
    data<{ record: (Revision & { status: string }) | null }>(
      await call('memory.read:record', { memory_id: id }, turn(principalId))
    ).record;
  const stored = (id: string) => db.adapter.prepare('SELECT * FROM decisions WHERE id = ?').get(id);
  const bindings = (id: string) =>
    db.adapter
      .prepare(
        `
    SELECT s.kind, s.external_id AS id FROM memory_scope_bindings b
    JOIN memory_scopes s ON s.id = b.scope_id WHERE b.memory_id = ?
    ORDER BY b.is_primary DESC, b.rowid`
      )
      .all(id);
  // No observer is configured here: total_changes proves even transient writes are absent.
  // Production's separate tool-trace observer still records denied calls.
  const changes = () =>
    (db.adapter.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
  const refused = async (run: () => Promise<ActionResult>, kind = 'denied') => {
    const before = changes();
    const result = await run();
    expect(changes()).toBe(before);
    expect(result).toMatchObject({ status: 'failed', error: { kind } });
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'member-share-'));
    vi.stubEnv('HOME', root);
    vi.stubEnv('MAMA_DB_PATH', join(root, 'core.db'));
    vi.stubEnv('MAMA_FORCE_TIER_3', 'true');
    db = await openCoreDatabase({ path: process.env.MAMA_DB_PATH! });
    repository = createPrincipalRepository(db.adapter);
    repository.ensureOwner({
      principalId: OWNER,
      connector: 'telegram',
      namespace: 'private',
      externalId: 'fixture-owner-dm',
      now: 1,
    });
    [a, b, c] = ['fixture-a', 'fixture-b', 'fixture-c'].map((externalId) =>
      repository.registerMember({ connector: 'telegram', namespace: 'private', externalId, now: 2 })
    );
    for (const targetPrincipalId of [a, b]) {
      repository.grantScope({
        targetPrincipalId,
        ownerPrincipalId: OWNER,
        now: 3,
        scope: { kind: 'memory', scopeKind: 'project', scopeId: PARTITION.id },
      });
    }
    surface = createActionSurface({
      adapter: db.adapter,
      knowledge: createKnowledge({ adapter: db.adapter, embedder: null }),
      runtimeRoot: root,
      configPath: join(root, 'config.yaml'),
      ownerPrincipalId: OWNER,
      agentId: 'fixture-owner-agent',
      connectors: ['fixture'],
      timeZone: createTimeZoneSetting('UTC'),
      isOwnerMessageTurn: () => true,
    });
    dispatch = createDispatcher(surface.catalog);
    sequence = 0;
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const first = await save('Initial review', 'First complete review text.');
    vi.mocked(Date.now).mockReturnValue(2000);
    const second = await save('Updated review', 'Second complete review text.', a, first);
    vi.mocked(Date.now).mockReturnValue(3000);
    original = await save('Current review', 'Current complete review text.', a, second);
    earlier = [first, second];
    vi.restoreAllMocks();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db?.close();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  // Relationships are asserted on their own; the content comparisons leave them out.
  const withoutReplaces = <T extends { replaces?: unknown }>({ replaces: _replaces, ...rest }: T) =>
    rest;
  const snapshot = async (id: string, principalId: string) => {
    const record = await read(id, principalId);
    expect(record).not.toBeNull();
    const parsed = JSON.parse(record!.details) as Snapshot & {
      current: Revision & { replaces?: Array<{ id: string; reason: string | null }> };
      revisions: Array<Revision & { replaces?: Array<{ id: string; reason: string | null }> }>;
    };
    return {
      ...parsed,
      current: withoutReplaces(parsed.current),
      revisions: parsed.revisions.map(withoutReplaces),
      relations: {
        current: parsed.current.replaces,
        revisions: parsed.revisions.map((revision) => revision.replaces),
      },
    };
  };
  const expected = (): Snapshot => ({
    memoryId: original,
    partitionId: PARTITION.id,
    reason: REASON,
    current: {
      id: original,
      createdAt: 3000,
      summary: 'Current review',
      details: 'Current complete review text.',
    },
    revisions: [
      {
        id: earlier[0]!,
        createdAt: 1000,
        summary: 'Initial review',
        details: 'First complete review text.',
      },
      {
        id: earlier[1]!,
        createdAt: 2000,
        summary: 'Updated review',
        details: 'Second complete review text.',
      },
    ],
  });

  it('shares current text and every earlier revision with owner and B, keeps C out and original unchanged', async () => {
    const before = stored(original);
    const beforeBindings = bindings(original);
    const caller = turn();
    const ordinary = structuredClone(caller.access);
    const saved = data<{ id: string }>(await share({}, caller));
    expect(await snapshot(saved.id, OWNER)).toMatchObject(expected());
    expect(await snapshot(saved.id, b)).toMatchObject(expected());
    expect(await read(saved.id, c)).toBeNull();
    expect(await read(original, OWNER)).toBeNull();
    expect(await read(original, b)).toBeNull();
    expect(bindings(saved.id)).toEqual([{ kind: 'user', id: a }, PARTITION]);
    expect(stored(original)).toEqual(before);
    expect(bindings(original)).toEqual(beforeBindings);
    expect(caller.access).toEqual(ordinary);
    expect(
      db.adapter
        .prepare(
          `SELECT edge_type, object_kind, object_id, reason_text
      FROM twin_edges WHERE subject_id = ?`
        )
        .all(saved.id)
    ).toEqual([
      { edge_type: 'mentions', object_kind: 'memory', object_id: original, reason_text: REASON },
    ]);
  });

  it('lists memory.share in member help with whole-history consent and subsequent-share guidance', async () => {
    const help = data<string>(await call('help', {}));
    expect(help).toContain('memory.share');
    const summary = surface.catalog.describe('memory.share').summary;
    expect(summary).toMatch(/whole revision history/i);
    expect(summary).toMatch(/later private revision.*another share/i);
  });

  it('replays the same operation id as the same record after a later private revision', async () => {
    const first = data<{ id: string }>(await share({}, turn(), 'fixture-share-operation'));
    await save('Later private review', 'Private text written after consent.', a, original);
    const before = changes();
    const repeated = data<{ id: string }>(await share({}, turn(), 'fixture-share-operation'));
    expect(repeated.id).toBe(first.id);
    expect(changes()).toBe(before);
    expect(await snapshot(first.id, b)).toMatchObject(expected());
  });

  it('keeps the share and its history after B1 erasure and tombstones the cited original', async () => {
    const saved = data<{ id: string }>(await share());
    erasePrincipalRecords(db.adapter, { principalId: a, commandId: 'fixture-erasure' });
    expect(await snapshot(saved.id, b)).toMatchObject(expected());
    expect(await snapshot(saved.id, OWNER)).toMatchObject(expected());
    expect(stored(original)).toMatchObject({
      decision: '',
      reasoning: null,
      erased_at: expect.any(Number),
    });
    expect(bindings(original)).toEqual([{ kind: 'user', id: a }]);
    expect(
      db.adapter.prepare('SELECT id FROM decisions WHERE id IN (?, ?)').all(...earlier)
    ).toEqual([]);
  });

  it('copies every replaces branch and includes a common ancestor only once', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(4000);
    const branch = await save('Branch review', 'Branch review text.', a, earlier[0]);
    vi.mocked(Date.now).mockReturnValue(5000);
    const merged = data<{ id: string }>(
      await call('memory.save', {
        topic: 'fixture-review',
        kind: 'fact',
        summary: 'Merged review',
        details: 'Merged review text.',
        source: { package: 'fixture', source_type: 'fixture' },
        replaces: [
          { id: original, reason: 'Include the current review.' },
          { id: branch, reason: 'Include the branch review.' },
        ],
      })
    ).id;
    vi.restoreAllMocks();
    const saved = data<{ id: string }>(await share({ memory_id: merged }));
    const shared = await snapshot(saved.id, b);
    expect(shared.current).toEqual({
      id: merged,
      createdAt: 5000,
      summary: 'Merged review',
      details: 'Merged review text.',
    });
    expect(shared.revisions).toEqual([
      ...expected().revisions,
      expected().current,
      { id: branch, createdAt: 4000, summary: 'Branch review', details: 'Branch review text.' },
    ]);
    expect([...(shared.relations.current ?? [])].sort((x, y) => x.id.localeCompare(y.id))).toEqual(
      [
        { id: original, reason: 'Include the current review.' },
        { id: branch, reason: 'Include the branch review.' },
      ].sort((x, y) => x.id.localeCompare(y.id))
    );
  });

  it('refuses a replaced revision so readers never receive an obsolete record as live', async () => {
    await refused(() => share({ memory_id: earlier[0] }), 'invalid_input');
  });

  it('records the share under the caller operation id so operation.get can recover it', async () => {
    const saved = data<{ id: string }>(await share({}, turn(), 'fixture-share-recovery'));
    expect(
      db.adapter
        .prepare(
          `SELECT j.record_id FROM command_bindings b
           JOIN judgment_commands j ON j.command_id = b.command_id WHERE b.command_id = ?`
        )
        .get('fixture-share-recovery')
    ).toEqual({ record_id: saved.id });
  });

  it('orders legacy text timestamps by time', async () => {
    // Time order is set opposite to id order, so an id fallback cannot pass by chance.
    const [byIdFirst, byIdSecond] = [earlier[0]!, earlier[1]!].sort();
    const setTime = (id: string, ms: number) =>
      db.adapter
        .prepare('UPDATE decisions SET created_at = ? WHERE id = ?')
        .run(new Date(ms).toISOString(), id);
    setTime(byIdSecond!, 500);
    setTime(byIdFirst!, 1500);
    const saved = data<{ id: string }>(await share());
    const shared = await snapshot(saved.id, b);
    expect(shared.revisions.map((revision) => revision.id)).toEqual([byIdSecond, byIdFirst]);
  });

  it('refuses an unreadable earlier revision instead of sharing an incomplete history', async () => {
    const other = await save('Other review', 'Other private text.', b);
    db.adapter
      .prepare(
        `UPDATE memory_scope_bindings SET scope_id =
      (SELECT scope_id FROM memory_scope_bindings WHERE memory_id = ? LIMIT 1)
      WHERE memory_id = ?`
      )
      .run(other, earlier[0]);
    await refused(() => share());
  });

  it('refuses another reason under the same operation id without writing', async () => {
    data(await share({}, turn(), 'fixture-share-operation'));
    await refused(
      () => share({ reason: 'A different consent.' }, turn(), 'fixture-share-operation'),
      // The command id replays only the same request; core refuses another as a conflict.
      'failed'
    );
  });

  it('refuses a record also bound to another scope without writing', async () => {
    const broad = await save('Broad record', 'Broad text.', a, undefined, [
      { kind: 'user', id: a },
      PARTITION,
    ]);
    await refused(() => share({ memory_id: broad }));
  });
  it('refuses another member record without writing', async () => {
    const other = await save('Other review', 'Other private text.', b);
    await refused(() => share({ memory_id: other }));
  });
  it('refuses a partition without a grant even if access claims read authority', async () => {
    const caller = turn();
    caller.access = {
      ...caller.access,
      readScopes: [...caller.access.readScopes!, { kind: 'project', id: 'fixture-ungranted' }],
    };
    await refused(() => share({ partition_id: 'fixture-ungranted' }, caller));
  });
  it('refuses a revoked grant even when the turn still holds its old access', async () => {
    const caller = turn();
    repository.revokeScope({
      targetPrincipalId: a,
      ownerPrincipalId: OWNER,
      now: 4,
      scope: { kind: 'memory', scopeKind: 'project', scopeId: PARTITION.id },
    });
    await refused(() => share({}, caller));
  });
  it('refuses an owner default scope even with an active grant', async () => {
    const caller = turn();
    repository.grantScope({
      targetPrincipalId: a,
      ownerPrincipalId: OWNER,
      now: 4,
      scope: { kind: 'memory', scopeKind: 'project', scopeId: 'fixture' },
    });
    await refused(() => share({ partition_id: 'fixture' }, caller));
  });
  it('refuses a non-project grant without writing', async () => {
    repository.grantScope({
      targetPrincipalId: a,
      ownerPrincipalId: OWNER,
      now: 4,
      scope: { kind: 'memory', scopeKind: 'channel', scopeId: 'fixture-channel' },
    });
    await refused(() => share({ partition_id: 'fixture-channel' }));
  });
  it.each(['suspended', 'offboarded'] as const)(
    'refuses a %s member with stale active access',
    async (status) => {
      const caller = turn();
      if (status === 'suspended') repository.suspend(a, 4);
      else repository.offboard(a, 4);
      await refused(() => share({}, caller));
    }
  );
  it.each([
    undefined,
    'delta:fixture',
    'report:fixture',
    'subagent:fixture',
    'telegram:incomplete',
  ])('refuses non-chat turn %s without writing', async (sourceMessageRef) => {
    await refused(() => share({}, { access: access(), session: { sourceMessageRef } }));
  });
  it('refuses a replay turn with a valid chat ref without writing', async () => {
    const caller = turn();
    caller.session!.replaySourceEndMs = 0;
    await refused(() => share({}, caller));
  });
  it('refuses B sharing A record in B own turn without writing', async () => {
    await refused(() => share({}, turn(b)));
  });
  it('refuses the owner even if supplied the share action grant', async () => {
    const caller = turn(OWNER);
    caller.access = { ...caller.access, actions: [...caller.access.actions, 'memory.share'] };
    await refused(() => share({}, caller));
  });
  it('refuses a missing record without writing', async () => {
    await refused(() => share({ memory_id: 'fixture-missing' }));
  });
  it.each(['memory_id', 'partition_id', 'reason'])(
    'refuses a blank %s without writing',
    async (field) => {
      await refused(() => share({ [field]: '  ' }), 'invalid_input');
    }
  );
  it('refuses an absent operation id without writing', async () => {
    await refused(
      () =>
        dispatch(
          {
            action: 'memory.share',
            input: { memory_id: original, partition_id: PARTITION.id, reason: REASON },
          },
          turn()
        ),
      'invalid_input'
    );
  });
});
