import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createKnowledge,
  createPrincipalRepository,
  type ActionResult,
} from '@jungjaehoon/mama-core';
import { createActionSurface } from '../../src/runtime/action-surface.js';
import { resolvePrincipalAccess } from '../../src/runtime/principal-access.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';
import { ChatSources } from '../../src/storage/chat-sources.js';
import { RawStore } from '../../src/storage/source-archive.js';
import { createStoredSourceReader } from '../../src/api/stored-source-reader.js';
import { createReportStore } from '../../src/api/report-handler.js';

const COMMON = 'common-fixture';
const OWN_DM = 'fixture-person-dm';
const OTHER_DM = 'fixture-other-dm';
const COMMON_CHANNEL = 'telegram:fixture-common-room';
const memoryInput = {
  topic: 'fixture-memory',
  kind: 'fact',
  summary: 'Fixture memory',
  details: 'Fixture details',
  source: { package: 'fixture', source_type: 'fixture' },
};

function completed<T = unknown>(result: ActionResult): T {
  expect(result.status, JSON.stringify(result)).toBe('completed');
  return (result as { data: T }).data;
}

describe('P10.1 owner authority in a personal member DM', () => {
  let root: string;
  let db: Awaited<ReturnType<typeof openCoreDatabase>>;
  let raw: RawStore;
  let repo: ReturnType<typeof createPrincipalRepository>;
  let surface: ReturnType<typeof createActionSurface>;
  let person: string;
  let other: string;
  let operation = 0;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'owner-member-access-'));
    vi.stubEnv('HOME', root);
    vi.stubEnv('MAMA_DB_PATH', join(root, 'core.db'));
    vi.stubEnv('MAMA_FORCE_TIER_3', 'true');
    db = await openCoreDatabase({ path: process.env.MAMA_DB_PATH! });
    repo = createPrincipalRepository(db.adapter);
    repo.ensureOwner({ principalId: COMMON, now: 1 });
    person = repo.registerMember({
      connector: 'telegram',
      namespace: 'private',
      externalId: OWN_DM,
      now: 2,
    });
    other = repo.registerMember({
      connector: 'telegram',
      namespace: 'private',
      externalId: OTHER_DM,
      now: 3,
    });
    repo.grantRole({ principalId: person, role: 'owner', now: 4 });
    repo.grantRole({ principalId: other, role: 'owner', now: 5 });
    raw = new RawStore(join(root, 'raw'));
    const store = createReportStore();
    surface = createActionSurface({
      adapter: db.adapter,
      knowledge: createKnowledge({ adapter: db.adapter, embedder: null }),
      runtimeRoot: join(root, 'runtime'),
      configPath: join(root, 'config.yaml'),
      ownerPrincipalId: COMMON,
      agentId: 'common-agent',
      connectors: ['trello', 'drive', 'slack'],
      timeZone: createTimeZoneSetting('UTC'),
      isOwnerMessageTurn: () => true,
      storedSourceReader: createStoredSourceReader({ adapter: db.adapter, rawStore: () => raw }),
      reportStore: store,
      helpTopics: { sources: 'Fixture source procedure.' },
      attachmentPorts: { telegram: () => null, discord: () => null, slack: () => null },
      memberLifecycle: {
        resetSession: async () => {},
        retire: async () => {},
        resume: async () => {},
        cancelQueued: () => 0,
      },
    });
    const chats = [
      [person, OWN_DM],
      [other, OTHER_DM],
      [COMMON, 'fixture-common-room'],
    ] as const;
    for (const [id, channel] of chats) {
      new ChatSources(raw, db.adapter, id, `agent-${id}`).saveOwnerMessage({
        id: `telegram:${channel}:message`,
        channelKey: channel,
        occurredAt: 10,
        text: `Chat for ${channel}`,
      });
    }
  });
  afterEach(async () => {
    raw?.close();
    await db?.close();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  const access = (principalId = person) =>
    resolvePrincipalAccess(principalId, {
      adapter: db.adapter,
      ownerAccess: surface.ownerAccess,
      agentId: `agent-${principalId}`,
    });
  const call = (action: string, input: unknown, principalId = person) =>
    surface.dispatch(
      { action, input, operationId: `fixture-${++operation}-${action}` },
      { access: access(principalId), session: { sourceMessageRef: 'telegram:fixture:message' } }
    );
  const scopes = (id: string) =>
    db.adapter
      .prepare(
        `
    SELECT s.kind, s.external_id AS id FROM memory_scope_bindings b
    JOIN memory_scopes s ON s.id = b.scope_id WHERE b.memory_id = ?
    ORDER BY s.kind, s.external_id`
      )
      .all(id);

  it('adds common reads while preserving personal default writes and the own DM destination', () => {
    const resolved = access();
    expect(resolved.scopes).toEqual([{ kind: 'user', id: person }]);
    expect(resolved.defaultScopes).toEqual([{ kind: 'user', id: person }]);
    expect(resolved.readScopes).toEqual(
      expect.arrayContaining([
        { kind: 'user', id: COMMON },
        { kind: 'global', id: 'system' },
        { kind: 'project', id: 'trello' },
      ])
    );
    expect(resolved.connectors).toEqual(
      expect.arrayContaining(['chat', 'drive', 'trello', 'slack'])
    );
    expect(resolved.connectorWideRead).toEqual(['trello', 'drive', 'slack']);
    expect(resolved.channels?.chat).toEqual([`telegram:${OWN_DM}`, COMMON_CHANNEL]);
    expect(resolved.destinations).toEqual([{ kind: 'telegram', id: OWN_DM }]);
  });

  it('reads own and common chat sources and refuses another owner member DM source', async () => {
    for (const dm of [OWN_DM, 'fixture-common-room']) {
      const row = db.adapter
        .prepare(
          `SELECT current_observation_id AS ref FROM connector_event_index
        WHERE source_connector='chat' AND channel=?`
        )
        .get(`telegram:${dm}`) as { ref: string };
      expect(
        completed<{ content: string }>(
          await call('source.read', {
            source: 'chat',
            view: 'stored',
            observationRef: row.ref,
          })
        ).content
      ).toBe(`Chat for ${dm}`);
    }
    const row = db.adapter
      .prepare(
        `SELECT current_observation_id AS ref FROM connector_event_index
      WHERE source_connector='chat' AND channel=?`
      )
      .get(`telegram:${OTHER_DM}`) as { ref: string };
    expect(
      await call('source.read', {
        source: 'chat',
        view: 'stored',
        observationRef: row.ref,
      })
    ).toMatchObject({ status: 'failed', error: { code: 'stored_source_out_of_scope' } });
  });

  it('reads common work and help topics without gaining common write actions', async () => {
    const saved = completed<{ id: string }>(await call('memory.save', memoryInput, COMMON));
    expect(
      completed<{ record: { id: string } }>(
        await call('memory.read:record', { memory_id: saved.id })
      ).record.id
    ).toBe(saved.id);
    expect(completed(await call('report.read', {}))).toMatchObject({ slots: [] });
    expect(completed(await call('help', { topic: 'sources' }))).toBe('Fixture source procedure.');
    const help = completed(await call('help', {})) as string;
    expect(help).toContain('drive.read');
    expect(help).toContain('report.read');
    expect(help).not.toContain('drive.download');
    expect(help).not.toContain('manage.member');
  });

  it('binds an unscoped owner member save personally and a common delta save only to common scopes', async () => {
    const own = completed<{ id: string }>(await call('memory.save', memoryInput));
    expect(scopes(own.id)).toEqual([{ kind: 'user', id: person }]);
    const common = completed<{ id: string }>(
      await surface.dispatch(
        {
          action: 'memory.save',
          input: memoryInput,
          operationId: 'fixture-delta-save',
        },
        { access: surface.ownerAccess }
      )
    );
    expect(scopes(common.id)).toEqual(expect.arrayContaining([{ kind: 'user', id: COMMON }]));
    expect(scopes(common.id)).not.toEqual(expect.arrayContaining([{ kind: 'user', id: person }]));
    expect(scopes(common.id)).not.toEqual(expect.arrayContaining([{ kind: 'user', id: other }]));
  });

  it.each([
    ['manage.policy.update', { text: 'Fixture policy', fingerprint: 'fixture', reason: 'Fixture' }],
    ['manage.policy.read', {}],
    ['work.create', { topic: 'fixture', summary: 'Fixture', set: { title: 'Fixture' } }],
    ['work.revise', { commitmentId: 'fixture-work', summary: 'Fixture' }],
    [
      'work.link',
      {
        from: 'fixture-work',
        to: { kind: 'memory', id: 'fixture-memory' },
        relation: 'builds_on',
        reason: 'Fixture',
      },
    ],
    ['work.no_update', { reason: 'Fixture', observationRefs: ['fixture-observation'] }],
    ['drive.download', { file: 'fixture-file' }],
    ['owner.timezone.set', { timeZone: 'UTC' }],
    ['report.publish', { slots: { briefing: '<p>Fixture</p>' } }],
    [
      'manage.wiki.publish',
      { pages: [{ path: 'fixture.md', title: 'Fixture', type: 'entity', content: 'Fixture' }] },
    ],
    [
      'manage.wiki.update',
      { path: 'fixture.md', edits: [{ section: '## Fixture', append: 'Fixture' }] },
    ],
    ['manage.wiki.move', { moves: [{ from: 'fixture.md', to: 'fixture-next.md' }] }],
    ['manage.wiki.read', {}],
    ['deliver.discord.file', { path: 'fixture.pdf' }],
    ['deliver.slack.file', { path: 'fixture.pdf' }],
    ['manage.member.enroll', {}],
    ['manage.member.list', {}],
    ['manage.member.suspend', { principalId: 'fixture-person' }],
  ])('records the unmodified action-boundary refusal for DM %s', async (action, input) => {
    expect(await call(action as string, input)).toMatchObject({
      status: 'failed',
      error: { code: 'action_not_granted', message: `principal ${person} may not call ${action}` },
    });
  });

  it('refuses explicit common scopes and common rule revisions with the common-channel instruction', async () => {
    const common = completed<{ id: string }>(
      await call(
        'memory.save',
        {
          ...memoryInput,
          kind: 'lesson',
          appliesWhen: 'When handling fixture work.',
        },
        COMMON
      )
    );
    expect(
      await call('memory.save', { ...memoryInput, scopes: [{ kind: 'user', id: COMMON }] })
    ).toMatchObject({ status: 'failed', error: { code: 'SCOPE_DENIED' } });
    expect(
      await call('memory.save', {
        ...memoryInput,
        replaces: [{ id: common.id, reason: 'Fixture correction' }],
      })
    ).toMatchObject({
      status: 'failed',
      error: { message: expect.stringContaining('common channel') },
    });
  });

  it.each(['grant', 'revoke', 'suspend', 'resume', 'offboard'])(
    'refuses an owner-role target of common manage.member.%s',
    async (change) => {
      expect(
        await call(
          `manage.member.${change}`,
          {
            principalId: person,
            ...(['grant', 'revoke'].includes(change)
              ? { scopeKind: 'project', scopeId: 'fixture-project' }
              : {}),
          },
          COMMON
        )
      ).toMatchObject({
        status: 'failed',
        error: { code: 'denied', message: expect.stringContaining('owner') },
      });
      expect(repo.findById(person)?.status).toBe('active');
    }
  );

  it('refuses enrollment from the common room because the button requires an owner DM', async () => {
    expect(await call('manage.member.enroll', {}, COMMON)).toMatchObject({
      status: 'failed',
      error: {
        code: 'action_not_granted',
        message: `principal ${COMMON} may not call manage.member.enroll`,
      },
    });
    const summary = surface.catalog
      .list()
      .find(({ name }) => name === 'manage.member.enroll')!.summary;
    expect(summary).toMatch(/button.*owner.*DM/);
    expect(summary).toMatch(/not available now/);
    expect(summary).not.toMatch(/P10\./);
  });
});
