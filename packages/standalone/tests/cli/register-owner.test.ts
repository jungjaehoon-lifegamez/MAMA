import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdapter, createPrincipalRepository } from '@jungjaehoon/mama-core';
import Database from 'better-sqlite3';
import { CodexThreadRegistry } from '@jungjaehoon/mama-core/runtime/drivers/codex-thread-registry';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OWNER_PRINCIPAL_ID } from '../../src/cli/commands/daemon.js';
import { runRegisterOwner } from '../../src/cli/commands/register-owner.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { ChatSources, ownerMessageItem } from '../../src/storage/chat-sources.js';
import { RawStore } from '../../src/storage/source-archive.js';
import { createCoreRawIndexSink, drainRawProjections } from '../../src/replay/import-manifest.js';
import { memberPaths, memberClaudeTmpDir } from '../../src/runtime/member-paths.js';
import { OwnerMessageLedger } from '../../src/gateways/telegram-message-ledger.js';
const firstId = '1001',
  secondId = '1002',
  group = '-1001';
describe('owner person cutover', () => {
  let root: string, home: string, dbPath: string, configPath: string, members: string;
  const temps: string[] = [];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'owner-cutover-'));
    home = join(root, 'home');
    members = join(root, 'members');
    mkdirSync(join(home, '.mama'), { recursive: true });
    dbPath = join(home, 'core.db');
    configPath = join(home, '.mama', 'config.yaml');
    vi.stubEnv('HOME', home);
    vi.stubEnv('MAMA_DB_PATH', dbPath);
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        member_root: members,
        agent: {
          backend: 'codex',
          model: 'fixture-model',
          effort: 'medium',
          max_turns: 20,
          timeout: 1000,
        },
        database: { path: dbPath },
        logging: { level: 'info', file: join(home, 'fixture.log') },
        telegram: {
          enabled: false,
          allowed_chats: [group, firstId],
          owner_chat_id: group,
          polling: false,
        },
        jev: {
          enabled: false,
          keyFile: join(home, 'fixture.key'),
          vocabFile: join(home, 'vocab.json'),
        },
      })
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const p of temps.splice(0)) rmSync(p, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  const register = (id = firstId) => runRegisterOwner([id], { home, configPath });
  const open = () => openCoreDatabase({ path: dbPath });
  function snapshot() {
    const db = createAdapter({ dbPath });
    db.connect();
    try {
      return Object.fromEntries(
        [
          'principals',
          'external_identities',
          'principal_roles',
          'connector_event_index',
          'observation_versions',
          'checkpoints',
          'checkpoint_scope_bindings',
          'memory_scopes',
          'memory_scope_bindings',
        ].map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])
      );
    } finally {
      db.disconnect();
    }
  }
  it('initializes a fresh install and reruns without changing registry, files or threads', async () => {
    expect(await register()).toMatchObject({
      principalsCreated: 1,
      membersCreated: 1,
      rolesGranted: 1,
    });
    const rows = snapshot();
    expect(rows.principals).toHaveLength(2);
    const person = (rows.external_identities[0] as { principal_id: string }).principal_id;
    expect(person).not.toBe(OWNER_PRINCIPAL_ID);
    expect(rows.principal_roles).toEqual([
      expect.objectContaining({ principal_id: person, role: 'owner' }),
    ]);
    temps.push(memberClaudeTmpDir(person));
    const file = join(memberPaths(members, person).workspaceDir, 'keep.txt');
    writeFileSync(file, 'personal');
    const threadRoot = join(home, '.mama', 'codex-runtime', 'threads');
    mkdirSync(join(home, '.mama', 'codex-runtime'), { recursive: true, mode: 0o700 });
    const threads = new CodexThreadRegistry({ rootDir: threadRoot });
    threads.save({
      sessionKey: 'owner:runtime',
      threadId: 'new-common-thread',
      model: 'fixture',
      cwd: home,
      systemPromptFingerprint: 'p',
      mcpConfigFingerprint: 'm',
    });
    const thread = threads.load('owner:runtime');
    expect(Object.values(await register()).every((count) => count === 0)).toBe(true);
    expect(snapshot()).toEqual(rows);
    expect(readFileSync(file, 'utf8')).toBe('personal');
    expect(threads.load('owner:runtime')).toEqual(thread);
    expect(vi.mocked(console.log).mock.calls.flat().join(' ')).not.toContain(firstId);
  });
  it('moves all first DM chat stores and only first unscoped checkpoints; two owners keep common and other records', async () => {
    const database = await open(),
      db = database.adapter,
      repo = createPrincipalRepository(db);
    for (const id of [firstId, secondId])
      repo.ensureOwner({
        principalId: OWNER_PRINCIPAL_ID,
        connector: 'telegram',
        namespace: 'private',
        externalId: id,
        now: 1,
      });
    const rawPath = join(home, '.mama', 'connectors'),
      store = new RawStore(rawPath),
      chat = new ChatSources(store, db, OWNER_PRINCIPAL_ID, 'common-agent');
    for (const [room, text] of [
      [firstId, 'personal'],
      [group, 'common'],
    ]) {
      const ref = `telegram:${room}:1`;
      chat.saveOwnerMessage({ id: ref, channelKey: room, text, occurredAt: 2 });
      chat.saveReply({
        messageRef: ref,
        text: `${text} answer`,
        occurredAt: 3,
        author: 'agent',
        deliveryVerified: true,
      });
    }
    store.save(
      'chat',
      [
        ownerMessageItem(
          {
            id: `telegram:${firstId}:receipt`,
            channelKey: firstId,
            text: 'host enrollment receipt',
            occurredAt: 4,
          },
          OWNER_PRINCIPAL_ID
        ),
      ],
      { collectOnly: true }
    );
    db.prepare(
      "INSERT INTO checkpoints(timestamp,summary) VALUES (1,'personal checkpoint'),(2,'other checkpoint')"
    ).run();
    db.prepare(
      "INSERT INTO memory_scopes(id,kind,external_id,created_at) VALUES ('user:other','user','other',1)"
    ).run();
    db.prepare(
      "INSERT INTO checkpoint_scope_bindings(checkpoint_id,scope_id,created_at) VALUES (2,'user:other',1)"
    ).run();
    const groupIndex = db
        .prepare('SELECT * FROM connector_event_index WHERE channel=?')
        .all(`telegram:${group}`),
      groupObs = db
        .prepare('SELECT * FROM observation_versions WHERE channel=?')
        .all(`telegram:${group}`);
    store.close();
    await database.close();
    const threadRoot = join(home, '.mama', 'codex-runtime', 'threads');
    mkdirSync(join(home, '.mama', 'codex-runtime'), { recursive: true, mode: 0o700 });
    const threads = new CodexThreadRegistry({ rootDir: threadRoot });
    for (const key of ['owner:runtime', 'owner:replay', 'fixture:keep'])
      threads.save({
        sessionKey: key,
        threadId: 'fixture-thread',
        model: 'fixture',
        cwd: home,
        systemPromptFingerprint: 'p',
        mcpConfigFingerprint: 'm',
      });
    expect(await register()).toMatchObject({
      identitiesMoved: 1,
      rolesGranted: 1,
      rawItems: 3,
      pendingProjections: 1,
      indexRows: 2,
      checkpoints: 1,
      threadsCleared: 2,
    });
    const db2 = await open(),
      person = createPrincipalRepository(db2.adapter).resolveByExternal(
        'telegram',
        'private',
        firstId
      )!.principalId;
    temps.push(memberClaudeTmpDir(person));
    expect(
      db2.adapter
        .prepare('SELECT * FROM connector_event_index WHERE channel=?')
        .all(`telegram:${group}`)
    ).toEqual(groupIndex);
    expect(
      db2.adapter
        .prepare('SELECT * FROM observation_versions WHERE channel=?')
        .all(`telegram:${group}`)
    ).toEqual(groupObs);
    const copies = db2.adapter
      .prepare('SELECT memory_scope_id,author FROM connector_event_index WHERE channel=?')
      .all(`telegram:${firstId}`);
    expect(copies).toEqual([
      { memory_scope_id: person, author: person },
      { memory_scope_id: person, author: 'common-agent' },
    ]);
    expect(
      db2.adapter
        .prepare('SELECT memory_scope_id FROM observation_versions WHERE channel=?')
        .all(`telegram:${firstId}`)
    ).toEqual([{ memory_scope_id: person }, { memory_scope_id: person }]);
    const raw = new RawStore(rawPath),
      moved = raw.exportScope('chat', 'user', person);
    expect(moved.raw_items).toHaveLength(3);
    expect(moved.pending_core_projections).toHaveLength(1);
    expect(JSON.parse(moved.pending_core_projections[0].payload_json as string)).toMatchObject({
      memoryScopeId: person,
      author: person,
    });
    raw.close();
    expect(threads.load('owner:runtime')).toBeUndefined();
    expect(threads.load('owner:replay')).toBeUndefined();
    expect(threads.load('fixture:keep')).toBeDefined();
    await db2.close();
    expect((await register(secondId)).checkpoints).toBe(0);
    const db3 = await open(),
      person2 = createPrincipalRepository(db3.adapter).resolveByExternal(
        'telegram',
        'private',
        secondId
      )!.principalId;
    temps.push(memberClaudeTmpDir(person2));
    expect(
      db3.adapter.prepare("SELECT * FROM principal_roles WHERE role='owner'").all()
    ).toHaveLength(2);
    expect(
      db3.adapter
        .prepare(
          'SELECT s.external_id FROM checkpoint_scope_bindings b JOIN memory_scopes s ON s.id=b.scope_id ORDER BY b.checkpoint_id'
        )
        .all()
    ).toEqual([{ external_id: person }, { external_id: 'other' }]);
    await db3.close();
    const before = snapshot();
    expect(Object.values(await register(secondId)).every((count) => count === 0)).toBe(true);
    expect(snapshot()).toEqual(before);
  });
  it.each(['pending', 'claimed', 'uncertain'])(
    'refuses an in-flight common DM input: %s',
    async (state) => {
      const database = await open(),
        db = database.adapter;
      createPrincipalRepository(db).ensureOwner({
        principalId: OWNER_PRINCIPAL_ID,
        connector: 'telegram',
        namespace: 'private',
        externalId: firstId,
        now: 1,
      });
      db.prepare(
        "INSERT INTO mailbox_inputs(stimulus_id,kind,principal_id,channel_key,occurred_at,created_at,status) VALUES (?,'owner_message',?,?,1,1,?)"
      ).run(
        `telegram:${firstId}:1`,
        OWNER_PRINCIPAL_ID,
        firstId,
        state === 'uncertain' ? 'acked' : state
      );
      if (state === 'uncertain')
        db.prepare(
          "INSERT INTO native_input_deliveries(input_id,state,updated_at) VALUES (1,'uncertain',1)"
        ).run();
      await database.close();
      const before = snapshot();
      await expect(register()).rejects.toThrow(/DM input.*(pending|claimed|uncertain)/);
      expect(snapshot()).toEqual(before);
    }
  );
  it.each(['processing', 'ready'] as const)(
    'refuses a %s DM message ledger entry',
    async (state) => {
      const database = await open();
      await database.close();
      const path = join(home, '.mama', 'runtime', 'owner-message-ledger.json');
      const ledger = new OwnerMessageLedger(path);
      const ref = `telegram:${firstId}:1`;
      ledger.claim(ref);
      if (state === 'ready') ledger.markReady(ref, 'Undelivered personal answer');
      const before = snapshot();
      const ledgerBefore = readFileSync(path);
      await expect(register()).rejects.toThrow(new RegExp(`DM.*${state}`));
      expect(snapshot()).toEqual(before);
      expect(readFileSync(path)).toEqual(ledgerBefore);
    }
  );
  it('reuses an active member without clearing its state; refuses a suspended binding', async () => {
    const database = await open(),
      repo = createPrincipalRepository(database.adapter),
      person = repo.registerMember({
        connector: 'telegram',
        namespace: 'private',
        externalId: firstId,
        now: 1,
      });
    const paths = memberPaths(members, person);
    const files = [
      join(paths.workspaceDir, 'keep.txt'),
      join(paths.claudeConfigDir, 'session.json'),
      join(paths.codexHome, 'keep.json'),
      join(paths.registryRoot, 'member-thread.json'),
      join(memberClaudeTmpDir(person), 'keep.txt'),
    ];
    for (const file of files) {
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, 'personal');
    }
    temps.push(memberClaudeTmpDir(person));
    const other = repo.registerMember({
      connector: 'telegram',
      namespace: 'private',
      externalId: secondId,
      now: 1,
    });
    repo.suspend(other, 2);
    await database.close();
    expect(await register()).toMatchObject({ membersCreated: 0, rolesGranted: 1 });
    for (const file of files) expect(readFileSync(file, 'utf8')).toBe('personal');
    const before = snapshot();
    await expect(register(secondId)).rejects.toThrow('suspended');
    expect(snapshot()).toEqual(before);
  });
  it('leaves member files and common threads unchanged when the database commit fails', async () => {
    const database = await open();
    const db = database.adapter;
    const person = createPrincipalRepository(db).registerMember({
      connector: 'telegram',
      namespace: 'private',
      externalId: firstId,
      now: 1,
    });
    const file = join(memberPaths(members, person).workspaceDir, 'keep.txt');
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, 'personal');
    temps.push(memberClaudeTmpDir(person));
    const rawPath = join(home, '.mama', 'connectors');
    const raw = new RawStore(rawPath);
    new ChatSources(raw, db, OWNER_PRINCIPAL_ID, 'fixture-agent').saveOwnerMessage({
      id: `telegram:${firstId}:1`,
      channelKey: firstId,
      text: 'personal',
      occurredAt: 2,
    });
    const rawBefore = raw.exportScope('chat', 'user', OWNER_PRINCIPAL_ID);
    raw.close();
    db.exec(`CREATE TABLE cutover_commit_failure (
      principal_id TEXT REFERENCES principals(principal_id) DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TRIGGER cutover_deferred_failure AFTER UPDATE OF memory_scope_id ON connector_event_index
    BEGIN INSERT INTO cutover_commit_failure VALUES ('missing-fixture-principal'); END;`);
    await database.close();
    const threadRoot = join(home, '.mama', 'codex-runtime', 'threads');
    mkdirSync(join(threadRoot, '..'), { recursive: true, mode: 0o700 });
    const threads = new CodexThreadRegistry({ rootDir: threadRoot });
    threads.save({
      sessionKey: 'owner:runtime',
      threadId: 'fixture-thread',
      model: 'fixture',
      cwd: home,
      systemPromptFingerprint: 'p',
      mcpConfigFingerprint: 'm',
    });
    const thread = threads.load('owner:runtime');
    const before = snapshot();
    await expect(register()).rejects.toThrow(/FOREIGN KEY/);
    expect(snapshot()).toEqual(before);
    expect(readFileSync(file, 'utf8')).toBe('personal');
    expect(threads.load('owner:runtime')).toEqual(thread);
    const after = new RawStore(rawPath);
    expect(after.exportScope('chat', 'user', OWNER_PRINCIPAL_ID)).toEqual(rawBefore);
    after.close();
  });
  it('rolls back raw snapshots, roles and scope copies when the product index move fails', async () => {
    const database = await open();
    const db = database.adapter;
    createPrincipalRepository(db).ensureOwner({
      principalId: OWNER_PRINCIPAL_ID,
      connector: 'telegram',
      namespace: 'private',
      externalId: firstId,
      now: 1,
    });
    const rawPath = join(home, '.mama', 'connectors'),
      raw = new RawStore(rawPath);
    new ChatSources(raw, db, OWNER_PRINCIPAL_ID, 'fixture-agent').saveOwnerMessage({
      id: `telegram:${firstId}:1`,
      channelKey: firstId,
      text: 'personal',
      occurredAt: 2,
    });
    const rawBefore = raw.exportScope('chat', 'user', OWNER_PRINCIPAL_ID);
    raw.close();
    db.exec(
      "CREATE TRIGGER cutover_fixture_fail BEFORE UPDATE OF memory_scope_id ON connector_event_index BEGIN SELECT RAISE(ABORT,'fixture index failure'); END"
    );
    await database.close();
    const before = snapshot();
    await expect(register()).rejects.toThrow('fixture index failure');
    expect(snapshot()).toEqual(before);
    const after = new RawStore(rawPath);
    expect(after.exportScope('chat', 'user', OWNER_PRINCIPAL_ID)).toEqual(rawBefore);
    after.close();
  });
  it('coalesces relocated queued snapshots for a reused member, keeping earliest sequence and distinct payloads', async () => {
    const database = await open(),
      db = database.adapter;
    const person = createPrincipalRepository(db).registerMember({
      connector: 'telegram',
      namespace: 'private',
      externalId: firstId,
      now: 1,
    });
    const rawPath = join(home, '.mama', 'connectors'),
      raw = new RawStore(rawPath);
    const item = ownerMessageItem(
      {
        id: `telegram:${firstId}:queued`,
        channelKey: firstId,
        text: 'queued personal message',
        occurredAt: 2,
      },
      OWNER_PRINCIPAL_ID
    );
    raw.save('chat', [item], { collectOnly: true });
    raw.save('chat', [{ ...item, memoryScopeId: person }], { collectOnly: true });
    raw.save('chat', [item], { collectOnly: true });
    // This distinct projection identity must remain separate from the original snapshot.
    raw.save('chat', [{ ...item, memoryScopeId: person, tenantId: 'fixture-tenant' }], {
      collectOnly: true,
    });
    raw.save('chat', [item], { collectOnly: true });
    const before = raw.listPendingProjections('chat', 100);
    expect(before).toHaveLength(4);
    const earliest = [before[0], before[2]];
    raw.close();
    await database.close();
    expect(await register()).toMatchObject({
      membersCreated: 0,
      rolesGranted: 1,
      rawItems: 1,
      pendingProjections: 4,
    });
    temps.push(memberClaudeTmpDir(person));
    const reopened = new RawStore(rawPath),
      pending = reopened.listPendingProjections('chat', 100);
    expect(pending.map((p) => p.pendingProjectionId)).toEqual(
      earliest.map((p) => p.pendingProjectionId)
    );
    expect(pending.map((p) => p.tenantId ?? null)).toEqual([null, 'fixture-tenant']);
    expect(pending.map((p) => p.observedAt)).toEqual(earliest.map((p) => p.observedAt));
    expect(pending.every((p) => p.memoryScopeId === person && p.author === person)).toBe(true);
    reopened.close();
    const unchanged = snapshot();
    expect(Object.values(await register()).every((count) => count === 0)).toBe(true);
    expect(snapshot()).toEqual(unchanged);
  });
  it('replays the retained earliest sequence even when it was projected in the destination scope before its ack', async () => {
    const database = await open(),
      db = database.adapter;
    const person = createPrincipalRepository(db).registerMember({
      connector: 'telegram',
      namespace: 'private',
      externalId: firstId,
      now: 1,
    });
    const rawPath = join(home, '.mama', 'connectors'),
      raw = new RawStore(rawPath);
    const item = ownerMessageItem(
      {
        id: `telegram:${firstId}:processed`,
        channelKey: firstId,
        text: 'processed personal message',
        occurredAt: 2,
      },
      OWNER_PRINCIPAL_ID
    );
    const [earliest] = raw.save('chat', [{ ...item, memoryScopeId: person }], {
      collectOnly: true,
    });
    const [projected] = createCoreRawIndexSink(db)('chat', [earliest]);
    raw.save('chat', [item], { collectOnly: true });
    raw.close();
    await database.close();
    expect(await register()).toMatchObject({ membersCreated: 0, pendingProjections: 2 });
    temps.push(memberClaudeTmpDir(person));
    const db2 = await open(),
      raw2 = new RawStore(rawPath);
    try {
      expect(
        db2.adapter
          .prepare('SELECT memory_scope_id,author FROM connector_event_index WHERE source_id=?')
          .get(item.sourceId)
      ).toEqual({ memory_scope_id: person, author: person });
      expect(raw2.listPendingProjections('chat', 100).map((p) => p.pendingProjectionId)).toEqual([
        earliest.pendingProjectionId,
      ]);
      expect(await drainRawProjections(raw2, createCoreRawIndexSink(db2.adapter))).toBe(1);
      expect(raw2.pendingProjectionCount('chat')).toBe(0);
      expect(
        db2.adapter
          .prepare('SELECT current_observation_id FROM connector_event_index WHERE source_id=?')
          .get(item.sourceId)
      ).toEqual({ current_observation_id: projected.observationRef });
    } finally {
      raw2.close();
      await db2.close();
    }
  });
  it('restores deleted duplicate snapshots when a later index move fails', async () => {
    const database = await open(),
      db = database.adapter,
      repo = createPrincipalRepository(db);
    repo.ensureOwner({ principalId: OWNER_PRINCIPAL_ID, now: 1 });
    const person = repo.registerMember({
      connector: 'telegram',
      namespace: 'private',
      externalId: firstId,
      now: 1,
    });
    const rawPath = join(home, '.mama', 'connectors'),
      raw = new RawStore(rawPath);
    const input = {
      id: `telegram:${firstId}:rollback`,
      channelKey: firstId,
      text: 'rollback personal message',
      occurredAt: 2,
    };
    new ChatSources(raw, db, OWNER_PRINCIPAL_ID, 'fixture-agent').saveOwnerMessage(input);
    const item = ownerMessageItem(input, OWNER_PRINCIPAL_ID);
    raw.save('chat', [{ ...item, memoryScopeId: person }], { collectOnly: true });
    raw.save('chat', [item], { collectOnly: true });
    const pendingBefore = raw.listPendingProjections('chat', 100);
    expect(pendingBefore).toHaveLength(2);
    const rawBefore = raw.exportScope('chat', 'user', OWNER_PRINCIPAL_ID);
    raw.close();
    db.exec(
      "CREATE TRIGGER cutover_fixture_fail BEFORE UPDATE OF memory_scope_id ON connector_event_index BEGIN SELECT RAISE(ABORT,'fixture index failure'); END"
    );
    await database.close();
    const before = snapshot();
    await expect(register()).rejects.toThrow('fixture index failure');
    expect(snapshot()).toEqual(before);
    const reopened = new RawStore(rawPath);
    expect(reopened.listPendingProjections('chat', 100)).toEqual(pendingBefore);
    expect(reopened.exportScope('chat', 'user', OWNER_PRINCIPAL_ID)).toEqual(rawBefore);
    reopened.close();
  });
  it.each(['common', 'person'])(
    'relocates queued old-scope snapshots when the raw row is already personal with %s author',
    async (storedAuthor) => {
      const database = await open(),
        db = database.adapter;
      const person = createPrincipalRepository(db).registerMember({
        connector: 'telegram',
        namespace: 'private',
        externalId: firstId,
        now: 1,
      });
      const rawPath = join(home, '.mama', 'connectors'),
        raw = new RawStore(rawPath);
      const item = ownerMessageItem(
        {
          id: `telegram:${firstId}:already-personal`,
          channelKey: firstId,
          text: 'already personal raw message',
          occurredAt: 2,
        },
        OWNER_PRINCIPAL_ID
      );
      raw.save('chat', [item], { collectOnly: true });
      raw.save('chat', [{ ...item, memoryScopeId: person }], { collectOnly: true });
      const earliest = raw.listPendingProjections('chat', 100)[0];
      expect(raw.listPendingProjections('chat', 100)).toHaveLength(2);
      raw.close();
      await database.close();
      if (storedAuthor === 'person') {
        // A previously relocated raw author can coexist with stale, unacknowledged snapshots.
        const rawDb = new Database(join(rawPath, 'chat', 'raw.db'));
        try {
          rawDb
            .prepare('UPDATE raw_items SET author=? WHERE source_id=?')
            .run(person, item.sourceId);
        } finally {
          rawDb.close();
        }
      }
      expect(await register()).toMatchObject({
        membersCreated: 0,
        rawItems: storedAuthor === 'person' ? 0 : 1,
        pendingProjections: 2,
      });
      temps.push(memberClaudeTmpDir(person));
      const db2 = await open(),
        raw2 = new RawStore(rawPath);
      try {
        const pending = raw2.listPendingProjections('chat', 100);
        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({
          memoryScopeKind: 'user',
          memoryScopeId: person,
          author: person,
          pendingProjectionId: earliest.pendingProjectionId,
          observedAt: earliest.observedAt,
        });
        expect(
          raw2.withChatCutover(db2.adapter, (move) =>
            move({
              channel: item.channel,
              fromPrincipalId: OWNER_PRINCIPAL_ID,
              toPrincipalId: person,
            })
          )
        ).toEqual({ rawItems: 0, pendingProjections: 0 });
        expect(raw2.listPendingProjections('chat', 100)).toEqual(pending);
        expect(await drainRawProjections(raw2, createCoreRawIndexSink(db2.adapter))).toBe(1);
        expect(
          db2.adapter
            .prepare('SELECT memory_scope_id,author FROM connector_event_index WHERE source_id=?')
            .get(item.sourceId)
        ).toEqual({ memory_scope_id: person, author: person });
      } finally {
        raw2.close();
        await db2.close();
      }
      expect(Object.values(await register()).every((count) => count === 0)).toBe(true);
    }
  );
  it.each([[], ['1001', '1002'], ['not-an-id']])('requires one Telegram id %#', async (args) => {
    await expect(runRegisterOwner(args, { home, configPath })).rejects.toThrow(
      'mama register-owner <telegram id>'
    );
  });
});
