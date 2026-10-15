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
import { fixture } from '../helpers/member-runtime.js';
import { createPrincipalSessions } from '../../src/runtime/principal-sessions.js';

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
        turnChain: createPrincipalSessions(COMMON).turnChain,
        resetSession: async () => {},
        retire: async () => {},
        resume: async () => {},
        cancelQueued: () => 0,
      },
      memberDirectoryChange: createPrincipalSessions(COMMON).exclusive,
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
    // A Drive file lands in the person's own downloads, so fetching it is a read in a DM.
    expect(help).toContain('drive.download');
    expect(help).toContain('manage.member.list');
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

  it('refuses common enrollment without a recorded owner-role sender', async () => {
    expect(await call('manage.member.enroll', {}, COMMON)).toMatchObject({
      status: 'failed',
      error: { code: 'denied', message: expect.stringContaining('owner') },
    });
    const summary = surface.catalog
      .list()
      .find(({ name }) => name === 'manage.member.enroll')!.summary;
    expect(summary).toMatch(/button.*owner.*DM/);
    expect(summary).toMatch(/own message turn/);
    expect(summary).not.toMatch(/P10\./);
  });
});

describe('common session sender attribution', () => {
  it.each(['codex', 'claude'] as const)(
    '%s names the common-channel sender and the personal session principal and roles',
    async (backend) => {
      const f = await fixture(backend);
      createPrincipalRepository(f.runtime.database.adapter).grantRole({
        principalId: f.member,
        role: 'owner',
        now: 4,
      });
      const dm = 'telegram:fixture:sender-dm';
      f.runtime.memberIntake(f.member).acceptOwnerMessage({
        id: dm,
        channelKey: f.memberDm,
        occurredAt: 1,
        text: 'fixture personal request',
        senderPrincipalId: 'fixture-different-sender',
        payload: { displayName: 'fixture-user-set-name' },
      });
      await f.settled(dm, f.member);
      const dmHeader = (JSON.parse(f.turns.at(-1)!.prompt) as string)
        .split('\n')
        .find((line) => line.startsWith('[member_message]'));
      expect(dmHeader).toBe(
        `[member_message] telegram · 1970-01-01 Thu 00:00 (UTC) · yours: ${f.member} (owner)`
      );
      expect(dmHeader).not.toContain('fixture-different-sender');
      expect(dmHeader).not.toContain('fixture-user-set-name');

      const common = 'telegram:fixture:sender-common';
      f.runtime.intake.acceptOwnerMessage({
        id: common,
        channelKey: 'fixture-common-room',
        occurredAt: 2,
        text: 'fixture common request',
        senderPrincipalId: f.member,
        payload: { displayName: 'fixture-user-set-name' },
      });
      await f.settled(common);
      const prompt = JSON.parse(f.turns.at(-1)!.prompt) as string;
      const header = prompt.split('\n').find((line) => line.startsWith('[owner_message]'));
      expect(header).toBe(
        `[owner_message] telegram · 1970-01-01 Thu 00:00 (UTC) · from ${f.member} (owner)`
      );
      expect(prompt).not.toContain('fixture-user-set-name');
      expect(prompt).not.toContain(f.memberDm);
    }
  );

  it.each(['codex', 'claude'] as const)(
    '%s keeps chat authors and their roles on common session-start exchanges',
    async (backend) => {
      const f = await fixture(backend);
      const repo = createPrincipalRepository(f.runtime.database.adapter);
      repo.grantRole({ principalId: f.member, role: 'owner', now: 4 });
      const plain = repo.registerMember({
        connector: 'telegram',
        namespace: 'private',
        externalId: 'fixture-history-member',
        now: 5,
      });
      for (const [index, sender] of [f.member, plain, 'owner'].entries()) {
        f.runtime.recordHostExchange({
          message: {
            id: `telegram:fixture:history-${index}`,
            channelKey: 'fixture-common-room',
            occurredAt: index + 1,
            text: `fixture earlier request ${index}`,
            senderPrincipalId: sender,
          },
          reply: {
            text: `fixture earlier answer ${index}`,
            occurredAt: index + 2,
            deliveryVerified: true,
          },
        });
      }
      await f.settled(f.message('owner', 'fixture new common session'));
      const prompt = f.turns.at(-1)!.prompt;
      expect
        .soft(prompt)
        .toContain(
          `· from ${f.member} (owner): fixture earlier request 0 → you: fixture earlier answer 0`
        );
      expect
        .soft(prompt)
        .toContain(`· from ${plain}: fixture earlier request 1 → you: fixture earlier answer 1`);
      expect(prompt).not.toContain('fixture-history-member');
      expect(prompt).not.toContain(f.memberDm);
      expect(prompt).toContain('fixture earlier request 2 → you: fixture earlier answer 2');
      expect(prompt).not.toContain('· from owner');
    }
  );
});

describe('owner rules reach the personal DM session', () => {
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const policyFingerprint = (turn: Fixture['turns'][number]): string =>
    JSON.parse(turn.policyFingerprint!.split('::tools=')[0]).ownerPolicyFingerprint;
  const save = async (
    f: Fixture,
    principalId: string,
    input: typeof memoryInput & { appliesWhen?: string; steps?: string[] }
  ) =>
    completed<{ id: string }>(
      await f.runtime.surface.dispatch(
        { action: 'memory.save', input, operationId: `fixture-rule-${principalId}-${input.topic}` },
        {
          access: resolvePrincipalAccess(principalId, {
            adapter: f.runtime.database.adapter,
            ownerAccess: f.runtime.surface.ownerAccess,
            agentId: `agent-${principalId}`,
          }),
          session: { sourceMessageRef: 'telegram:fixture:rule' },
        }
      )
    );
  const grantOwner = async (f: Fixture) => {
    const repo = createPrincipalRepository(f.runtime.database.adapter);
    repo.grantRole({ principalId: f.member, role: 'owner', now: 4 });
    const plain = repo.registerMember({
      connector: 'telegram',
      namespace: 'private',
      externalId: 'fixture-plain-member',
      now: 5,
    });
    await f.runtime.serveMember(plain);
    return plain;
  };

  it.each(['codex', 'claude'] as const)(
    '%s enables web tools and common policy for owner-role DMs while plain members have neither',
    async (backend) => {
      const f = await fixture(backend);
      await f.settled(f.message('owner'));
      await f.settled(f.message(f.member), f.member);
      const member = f.turns.at(-1)!;
      const repo = createPrincipalRepository(f.runtime.database.adapter);
      repo.grantRole({ principalId: f.member, role: 'owner', now: 4 });
      await f.settled(f.message(f.member), f.member);
      const common = f.turns.find((turn) => turn.principal === 'owner')!;
      const own = f.turns.at(-1)!;
      expect(own.fresh).toBe(true);
      expect(own.session).not.toBe(member.session);
      expect(own.standing).toContain('FIXTURE_OWNER_POLICY');
      // Each new DM session learns where its readable sources live, outside its fingerprint.
      for (const turn of [own, member]) {
        expect(turn.prompt).toContain('Readable sources:');
        expect(turn.standing).not.toContain('Readable sources:');
      }
      expect(policyFingerprint(own)).toBe('fixture');
      expect(policyFingerprint(own)).toBe(policyFingerprint(common));
      expect(member.standing).not.toContain('FIXTURE_OWNER_POLICY');
      expect(policyFingerprint(member)).toBe('');
      if (backend === 'codex') {
        expect(f.drivers.get(f.member)!.webSearch).toBe(true);
        expect(f.drivers.get('owner')!.webSearch).toBe(true);
      }
      expect(f.drivers.get(f.member)!.deniedReadPaths).toContain(join(f.home, 'owner-policy.md'));
      expect(
        f.natives
          .get(f.member)!
          .hostToolDefinitions()
          .map((tool) => tool.name)
      ).not.toContain('manage.policy.update');
      if (backend === 'claude') {
        for (const tools of [own.nativeTools, common.nativeTools]) {
          expect(tools).toContain('WebFetch');
          expect(tools).toContain('WebSearch');
        }
        expect(member.nativeTools).not.toMatch(/WebFetch|WebSearch/);
      }
    }
  );

  it('rotates an owner DM session on a policy change while a plain member keeps its session', async () => {
    let policy = { content: 'FIXTURE_POLICY_ONE', fingerprint: 'policy-one', loaded: true };
    const f = await fixture('codex', true, false, 'UTC', undefined, 'fixture-member', () => policy);
    const plain = await grantOwner(f);
    const turn = async (id: string) => {
      await f.settled(f.message(id), id);
      return f.turns.at(-1)!;
    };
    const own = await turn(f.member);
    const member = await turn(plain);
    expect((await turn(f.member)).session).toBe(own.session);
    policy = { content: 'FIXTURE_POLICY_TWO', fingerprint: 'policy-two', loaded: true };
    const changed = await turn(f.member);
    expect(changed.session).not.toBe(own.session);
    expect(changed.fresh).toBe(true);
    expect(changed.standing).toContain('FIXTURE_POLICY_TWO');
    expect(changed.standing).not.toContain('FIXTURE_POLICY_ONE');
    expect(policyFingerprint(changed)).toBe('policy-two');
    expect((await turn(plain)).session).toBe(member.session);
  });

  it('starts with personal records and common rule kinds, keeping other common and private records out', async () => {
    const f = await fixture();
    const plain = await grantOwner(f);
    await save(f, f.member, {
      ...memoryInput,
      topic: 'personal',
      summary: 'PERSONAL_START_RECORD',
    });
    await save(f, plain, { ...memoryInput, topic: 'private', summary: 'OTHER_PRIVATE_RECORD' });
    await save(f, 'owner', { ...memoryInput, topic: 'common-work', summary: 'COMMON_WORK_RECORD' });
    for (const kind of ['lesson', 'preference', 'constraint', 'workflow'])
      await save(f, 'owner', {
        ...memoryInput,
        topic: `common-${kind}`,
        kind,
        summary: `COMMON_START_${kind}`,
        appliesWhen: 'Fixture start context.',
        ...(kind === 'workflow' ? { steps: ['Read the fixture rule'] } : {}),
      });
    await f.settled(f.message(f.member, 'unrelated question'), f.member);
    const own = f.turns.at(-1)!.prompt;
    expect(own).toContain('PERSONAL_START_RECORD');
    for (const kind of ['lesson', 'preference', 'constraint', 'workflow'])
      expect(own).toContain(`COMMON_START_${kind}`);
    expect(own).not.toContain('COMMON_WORK_RECORD');
    expect(own).not.toContain('OTHER_PRIVATE_RECORD');
    await f.settled(f.message(plain, 'unrelated question'), plain);
    const plainStart = f.turns.at(-1)!.prompt;
    expect(plainStart).toContain('OTHER_PRIVATE_RECORD');
    expect(plainStart).toContain('COMMON_START_workflow');
    for (const kind of ['lesson', 'preference', 'constraint'])
      expect(plainStart).not.toContain(`COMMON_START_${kind}`);
    expect(plainStart).not.toContain('COMMON_WORK_RECORD');
    expect(plainStart).not.toContain('PERSONAL_START_RECORD');
  });

  it('recalls a common owner correction next to personal lessons without allowing its replacement in DM', async () => {
    const f = await fixture();
    const plain = await grantOwner(f);
    await f.settled(f.message(f.member, 'start session'), f.member);
    await f.settled(f.message(plain, 'start session'), plain);
    const common = await save(f, 'owner', {
      ...memoryInput,
      topic: 'fixture-recall-common',
      kind: 'lesson',
      summary: 'fixture recall correction COMMON_RECALL_RULE',
      appliesWhen: 'Fixture recall question.',
    });
    await save(f, f.member, {
      ...memoryInput,
      topic: 'fixture-recall-personal',
      kind: 'lesson',
      summary: 'fixture recall correction PERSONAL_RECALL_RULE',
      appliesWhen: 'Fixture recall question.',
    });
    await f.settled(f.message(f.member, 'fixture recall correction'), f.member);
    const recalled = f.turns.at(-1)!;
    expect(recalled.fresh).toBe(false);
    expect(recalled.prompt).toContain('[owner rule] fixture-recall-common');
    expect(recalled.prompt).toContain('[their rule] fixture-recall-personal');
    expect(recalled.prompt).toContain('COMMON_RECALL_RULE');
    expect(recalled.prompt).toContain('PERSONAL_RECALL_RULE');
    await f.settled(f.message(plain, 'fixture recall correction'), plain);
    expect(f.turns.at(-1)!.prompt).not.toContain('COMMON_RECALL_RULE');
    expect(f.turns.at(-1)!.prompt).not.toContain('PERSONAL_RECALL_RULE');
    const { result } = await f.act('memory.save', {
      ...memoryInput,
      replaces: [{ id: common.id, reason: 'Fixture correction' }],
    });
    expect(result).toMatchObject({
      status: 'failed',
      error: { message: expect.stringContaining('common channel') },
    });
  });
});
