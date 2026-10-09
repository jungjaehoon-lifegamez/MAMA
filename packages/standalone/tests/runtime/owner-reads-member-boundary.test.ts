import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import {
  createKnowledge,
  createPrincipalRepository,
  type JudgmentAccess,
} from '@jungjaehoon/mama-core';
import { Mailbox } from '@jungjaehoon/mama-core/runtime/mailbox';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { createActionSurface } from '../../src/runtime/action-surface.js';
import { resolvePrincipalAccess } from '../../src/runtime/principal-access.js';
import { createStimulusIntake } from '../../src/runtime/stimulus-delivery.js';
import { createStoredSourceReader } from '../../src/api/stored-source-reader.js';
import { createViewerServer } from '../../src/api/viewer-server.js';
import { readViewerMemoryStats } from '../../src/api/viewer-data.js';
import { storedSourceFamilies } from '../../src/connectors/framework/stored-index-read.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';
import { ChatSources } from '../../src/storage/chat-sources.js';
import { RawStore } from '../../src/storage/source-archive.js';
import { createCoreRawIndexSink } from '../../src/replay/import-manifest.js';

let home: string;
let database: Awaited<ReturnType<typeof openCoreDatabase>>;
let raw: RawStore;
let surface: ReturnType<typeof createActionSurface>;
let member: JudgmentAccess;
const refs: Record<string, string> = {};
const rooms = ['fixture-owner-dm', 'fixture-owner-group', 'fixture-member-dm'];
const bodies = ['BOUNDARY owner direct', 'BOUNDARY owner group', 'BOUNDARY MEMBER_SENTINEL'];

type BoundaryData = {
  id: string;
  content: string;
  results: Array<{ status: string; error: { code: string } }>;
  hits: Array<{ observationRef: string }>;
  next_cursor: string | null;
  channels: Array<{ channel: string }>;
  nodes: Array<{ ref: { id: string } }>;
  events: Array<{ eventIndexId: string }>;
  checkpoints: Array<{ summary: string }>;
};

async function invoke(action: string, input: unknown, access = surface.ownerAccess) {
  return surface.dispatch(
    { action, input, operationId: `fixture:${action}:${JSON.stringify(input)}` },
    { access }
  );
}

async function data(action: string, input: unknown, access = surface.ownerAccess) {
  const result = await invoke(action, input, access);
  expect(result.status).toBe('completed');
  return (result as { data: BoundaryData }).data;
}

function accept(principal: string, room: string, text: string, suffix = 'message') {
  const mailbox = new Mailbox(database.adapter);
  const intake = createStimulusIntake(
    {
      mailbox,
      accept: (stimulus) => ({ inputId: mailbox.enqueue(stimulus)!, state: 'accepted' }),
    },
    principal,
    new ChatSources(raw, database.adapter, principal, 'fixture-agent')
  );
  const id = `telegram:${room}:${suffix}`;
  intake.acceptOwnerMessage({ id, channelKey: room, occurredAt: 1_000, text });
  return mailbox.readInput(id, principal)!.refs[0]!.observationRef!;
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'owner-member-boundary-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('MAMA_DB_PATH', join(home, 'state.db'));
  database = await openCoreDatabase({ path: join(home, 'state.db') });
  raw = new RawStore(join(home, 'raw'));
  const principals = createPrincipalRepository(database.adapter);
  principals.ensureOwner({
    principalId: 'fixture-owner',
    connector: 'telegram',
    namespace: 'private',
    externalId: 'fixture-owner-dm',
    now: 1,
  });
  const memberId = principals.registerMember({
    connector: 'telegram',
    namespace: 'private',
    externalId: 'fixture-member-dm',
    now: 2,
  });
  surface = createActionSurface({
    adapter: database.adapter,
    knowledge: createKnowledge({ adapter: database.adapter, embedder: null }),
    ownerPrincipalId: 'fixture-owner',
    agentId: 'fixture-agent',
    connectors: ['slack'],
    timeZone: createTimeZoneSetting('UTC'),
    runtimeRoot: home,
    configPath: join(home, 'config.yaml'),
    isOwnerMessageTurn: () => true,
    storedSourceReader: createStoredSourceReader({
      adapter: database.adapter,
      rawStore: () => raw,
    }),
  });
  member = resolvePrincipalAccess(memberId, {
    adapter: database.adapter,
    ownerAccess: surface.ownerAccess,
    agentId: 'fixture-member-agent',
  });
  for (const [index, room] of rooms.entries()) {
    refs[room] = accept(index === 2 ? memberId : 'fixture-owner', room, bodies[index]!);
  }
});

afterEach(async () => {
  raw.close();
  await database.close();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('owner action reads stop at member records', () => {
  it('preserves non-chat source bytes and errors under connector-wide access regardless of principal', async () => {
    const saved = raw.save('slack', [
      {
        source: 'slack',
        sourceId: 'fixture-source',
        channel: 'fixture-source-room',
        content: 'Fixture source body',
        author: 'fixture-author',
        timestamp: new Date(1_000),
        type: 'message',
      },
    ]);
    const [indexed] = createCoreRawIndexSink(database.adapter)('slack', saved);
    const wideReader = {
      ...surface.ownerAccess,
      principalId: 'fixture-wide-reader',
      connectors: ['slack'],
      connectorWideRead: ['slack'],
    };
    const observationRef = indexed!.observationRef;
    for (const input of [
      { source: 'slack', observationRef },
      { observationRef },
      { source: 'slack', observationRefs: [observationRef] },
      { observationRefs: [observationRef] },
      { source: 'slack', observationRef, content_offset: 2, content_limit: 5 },
    ]) {
      expect(JSON.stringify(await data('source.read', input, wideReader))).toBe(
        JSON.stringify(await data('source.read', input))
      );
    }
    expect((await data('source.read', { source: 'slack', observationRef })).content).toBe(
      'Fixture source body'
    );
    for (const [action, input] of [
      ['source.search', { source: 'slack', query: 'Fixture', limit: 1 }],
      ['source.recent', { since: 0 }],
      [
        'graph.query',
        { view: 'detail', asOf: Date.now(), seeds: [{ kind: 'observation', id: observationRef }] },
      ],
    ] as const) {
      expect(JSON.stringify(await data(action, input, wideReader))).toBe(
        JSON.stringify(await data(action, input))
      );
    }
    for (const input of [
      { source: 'slack', observationRef: 'fixture-missing' },
      { observationRef: 'fixture-missing' },
    ]) {
      expect(await invoke('source.read', input, wideReader)).toMatchObject({
        status: 'failed',
        error: { code: 'stored_source_not_found' },
      });
      expect(await invoke('source.read', input)).toMatchObject({
        status: 'failed',
        error: { code: 'stored_source_not_found' },
      });
    }
  });
  it.each(['single', 'ref-only', 'batch'] as const)(
    'denies member chat in %s source.read and preserves owner rooms',
    async (mode) => {
      const inputs = (ref: string) =>
        mode === 'single'
          ? { source: 'chat', observationRef: ref }
          : mode === 'batch'
            ? { observationRefs: [ref] }
            : { observationRef: ref };
      const denied = await invoke('source.read', inputs(refs[rooms[2]!]!));
      if (mode === 'batch')
        expect(denied).toMatchObject({
          status: 'completed',
          data: {
            results: [
              {
                status: 'failed',
                error: 'Stored source requires a granted connector and channel scope',
              },
            ],
          },
        });
      else
        expect(denied).toMatchObject({
          status: 'failed',
          error: { code: 'stored_source_out_of_scope' },
        });
      const wide = { ...surface.ownerAccess, connectorWideRead: ['slack', 'chat'] };
      for (const room of rooms.slice(0, 2)) {
        expect(JSON.stringify(await data('source.read', inputs(refs[room]!)))).toBe(
          JSON.stringify(await data('source.read', inputs(refs[room]!), wide))
        );
        const window = {
          source: 'chat',
          observationRef: refs[room],
          content_offset: 4,
          content_limit: 7,
        };
        expect(JSON.stringify(await data('source.read', window))).toBe(
          JSON.stringify(await data('source.read', window, wide))
        );
      }
      expect(await data('source.read', inputs(refs[rooms[2]!]!), member)).toBeDefined();
      for (const room of rooms.slice(0, 2)) {
        const result = await invoke('source.read', inputs(refs[room]!), member);
        if (mode === 'batch')
          expect(result).toMatchObject({
            data: {
              results: [{ error: 'Stored source requires a granted connector and channel scope' }],
            },
          });
        else
          expect(result).toMatchObject({
            status: 'failed',
            error: { code: 'stored_source_out_of_scope' },
          });
      }
      const mixed = await data('source.read', { observationRefs: rooms.map((room) => refs[room]) });
      expect(mixed.results.map((row) => row.status)).toEqual(['completed', 'completed', 'failed']);
      const sourced = await data('source.read', {
        source: 'chat',
        observationRefs: rooms.map((room) => refs[room]),
      });
      expect(sourced.results.map((row) => row.status)).toEqual([
        'completed',
        'completed',
        'failed',
      ]);
      expect(sourced.results[2].error.code).toBe('stored_source_out_of_scope');
    }
  );

  it('filters source.search before paging and resolves newly stored owner channels without caching', async () => {
    expect(
      (await data('source.search', { source: 'chat', query: 'BOUNDARY', limit: 2 })).hits
        .map((hit) => hit.observationRef)
        .sort()
    ).toEqual(
      rooms
        .slice(0, 2)
        .map((room) => refs[room])
        .sort()
    );
    expect(
      (await data('source.search', { source: 'chat', query: 'BOUNDARY' }, member)).hits.map(
        (hit) => hit.observationRef
      )
    ).toEqual([refs[rooms[2]!]]);
    const firstPage = await data('source.search', { source: 'chat', query: 'BOUNDARY', limit: 1 });
    expect(firstPage.next_cursor).not.toBeNull();
    const lastPage = await data('source.search', {
      source: 'chat',
      query: 'BOUNDARY',
      limit: 1,
      cursor: firstPage.next_cursor,
    });
    expect(lastPage.next_cursor).toBeNull();
    expect([...firstPage.hits, ...lastPage.hits].map((hit) => hit.observationRef).sort()).toEqual(
      rooms
        .slice(0, 2)
        .map((room) => refs[room])
        .sort()
    );
    expect(
      await invoke('source.search', {
        source: 'chat',
        channel: 'telegram:fixture-empty',
        query: 'BOUNDARY',
      })
    ).toMatchObject({ status: 'failed', error: { code: 'stored_source_out_of_scope' } });
    expect(
      await invoke('source.search', {
        source: 'chat',
        channel: `telegram:${rooms[2]}`,
        query: 'BOUNDARY',
      })
    ).toMatchObject({ status: 'failed', error: { code: 'stored_source_out_of_scope' } });
    const added = accept('fixture-owner', 'fixture-added-room', 'BOUNDARY added');
    expect((await data('source.read', { observationRef: added })).content).toBe('BOUNDARY added');
    accept('fixture-owner', rooms[0]!, 'BOUNDARY duplicate room', 'second');
    expect(surface.ownerAccess.channels!.chat!.sort()).toEqual(
      ['telegram:fixture-added-room', ...rooms.slice(0, 2).map((room) => `telegram:${room}`)].sort()
    );
    database.adapter
      .prepare(
        "UPDATE connector_event_index SET memory_scope_id = ? WHERE channel = 'telegram:fixture-added-room'"
      )
      .run(member.principalId);
    expect(await invoke('source.read', { observationRef: added })).toMatchObject({
      status: 'failed',
      error: { code: 'stored_source_out_of_scope' },
    });
    const shared = accept(
      member.principalId,
      rooms[1]!,
      'BOUNDARY shared group message',
      'member-shared'
    );
    expect((await data('source.read', { observationRef: shared })).content).toBe(
      'BOUNDARY shared group message'
    );
    expect(await invoke('source.read', { observationRef: shared }, member)).toMatchObject({
      status: 'failed',
      error: { code: 'stored_source_out_of_scope' },
    });
  });

  it('filters source.recent chat rows for both principals before the scan limit', async () => {
    const input = { since: 0, channels: rooms.map((room) => `chat:telegram:${room}`) };
    expect(await invoke('source.recent', input)).toMatchObject({
      status: 'failed',
      error: { code: 'invalid_input' },
    });
    for (const [access, allowed] of [
      [surface.ownerAccess, rooms.slice(0, 2)],
      [member, rooms.slice(2)],
    ] as const) {
      const recent = await data(
        'source.recent',
        { since: 0, channels: allowed.map((room) => `chat:telegram:${room}`) },
        access
      );
      expect(JSON.stringify(recent)).not.toContain(
        access === member ? 'owner direct' : 'MEMBER_SENTINEL'
      );
      expect(recent.channels.map((row) => row.channel).sort()).toEqual(
        allowed.map((room) => `telegram:${room}`).sort()
      );
    }
    database.adapter
      .prepare(
        `WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM rows WHERE n < 20001)
      INSERT INTO connector_event_index (event_index_id, source_connector, source_type, source_id, channel, content, source_timestamp_ms, content_hash, metadata_json, indexed_at, updated_at, current_observation_id, memory_scope_kind, memory_scope_id)
      SELECT 'fixture-hidden-' || n, 'chat', 'message', 'fixture-hidden-' || n, ?, 'MEMBER_SENTINEL', 1000, zeroblob(32), '{}', 'fixture', 'fixture', ?, 'user', ? FROM rows`
      )
      .run(`telegram:${rooms[2]}`, refs[rooms[2]!], member.principalId);
    expect(await invoke('source.recent', input)).toMatchObject({
      status: 'failed',
      error: {
        code: 'invalid_input',
        message: expect.stringContaining('channels without changes since then'),
      },
    });
  });

  it('omits member observations from graph.query while preserving both owner rooms', async () => {
    for (const [access, allowed] of [
      [surface.ownerAccess, rooms.slice(0, 2)],
      [member, rooms.slice(2)],
    ] as const) {
      for (const room of rooms)
        for (const kind of ['raw', 'observation']) {
          const input = { view: 'detail', seeds: [{ kind, id: refs[room] }] };
          if (allowed.includes(room)) {
            const graph = await data('graph.query', input, access);
            expect(graph.nodes.map((node) => node.ref.id)).toEqual([refs[room]]);
          } else {
            expect(await invoke('graph.query', input, access)).toMatchObject({
              status: 'failed',
              error: { kind: 'denied' },
            });
          }
        }
    }
  });

  it('omits member evidence in memory.read:provenance without losing owner evidence', async () => {
    const saved = await data('memory.save', {
      topic: 'fixture-boundary',
      kind: 'fact',
      summary: 'Fixture supports',
      details: 'Fixture supports',
      source: { package: 'fixture', source_type: 'test' },
      links: rooms.map((room) => ({
        relation: 'derived_from',
        target: { kind: 'observation', id: refs[room] },
      })),
    });
    const provenance = await data('memory.read:provenance', { memory_id: saved.id });
    expect(provenance.events.map((event) => event.eventIndexId).sort()).toEqual(
      rooms
        .slice(0, 2)
        .map((room) => refs[room])
        .sort()
    );
    expect(JSON.stringify(provenance)).not.toContain('MEMBER_SENTINEL');
    const personal = await data(
      'memory.save',
      {
        topic: 'fixture-personal',
        kind: 'fact',
        summary: 'Personal supports',
        details: 'Personal supports',
        source: { package: 'fixture', source_type: 'test' },
        links: [{ relation: 'derived_from', target: { kind: 'observation', id: refs[rooms[2]!] } }],
      },
      member
    );
    expect(
      (await data('memory.read:provenance', { memory_id: personal.id }, member)).events.map(
        (event) => event.eventIndexId
      )
    ).toEqual([refs[rooms[2]!]]);
  });

  it('denies an erased member observation for explicit, ref-only and batch reads', async () => {
    database.adapter
      .prepare(
        'UPDATE observation_versions SET erased_at = 2, source = NULL, source_id = NULL, body = NULL, body_location_json = NULL, content_hash = NULL, scope_json = ? WHERE observation_id = ?'
      )
      .run(JSON.stringify({ scopes: [{ kind: 'user', id: member.principalId }] }), refs[rooms[2]!]);
    for (const input of [
      { source: 'chat', observationRef: refs[rooms[2]!] },
      { source: 'slack', observationRef: refs[rooms[2]!] },
      { observationRef: refs[rooms[2]!] },
    ]) {
      expect(await invoke('source.read', input)).toMatchObject({
        status: 'failed',
        error: { code: 'stored_source_out_of_scope' },
      });
      if (input.source !== 'slack') {
        expect(await invoke('source.read', input, member)).toMatchObject({
          status: 'failed',
          error: { message: 'observation_erased' },
        });
      }
    }
    expect(
      await data('source.read', { source: 'chat', observationRefs: [refs[rooms[2]!]] })
    ).toMatchObject({ results: [{ error: { code: 'stored_source_out_of_scope' } }] });
  });

  async function checkpoints() {
    database.adapter
      .prepare('INSERT INTO checkpoints (timestamp, summary) VALUES (1, ?)')
      .run('LEGACY_CHECKPOINT');
    for (const [access, summary, timestamp] of [
      [surface.ownerAccess, 'OWNER_CHECKPOINT', 2],
      [member, 'MEMBER_CHECKPOINT', 3],
    ] as const) {
      const saved = await data('memory.checkpoint.save', { summary, next_steps: summary }, access);
      database.adapter
        .prepare('UPDATE checkpoints SET timestamp = ? WHERE id = ?')
        .run(timestamp, saved.id);
    }
  }

  it('keeps legacy and owner checkpoints while excluding newer member rows before LIMIT', async () => {
    await checkpoints();
    expect((await data('memory.checkpoint.list', { limit: 1 })).checkpoints).toMatchObject([
      { summary: 'OWNER_CHECKPOINT' },
    ]);
    expect(
      (await data('memory.checkpoint.list', {})).checkpoints.map((row) => row.summary)
    ).toEqual(['OWNER_CHECKPOINT', 'LEGACY_CHECKPOINT']);
    expect((await data('memory.checkpoint.list', {}, member)).checkpoints).toMatchObject([
      { summary: 'MEMBER_CHECKPOINT' },
    ]);
    expect(
      database.adapter.prepare('SELECT COUNT(*) AS count FROM checkpoint_scope_bindings').get()
    ).toEqual({ count: 1 });
  });

  it('counts source inventory under access, without member-only chat rows', () => {
    expect(
      storedSourceFamilies(database.adapter, surface.ownerAccess.connectors!, surface.ownerAccess)
    ).toEqual([{ source: 'chat', family: null, count: 2 }]);
    expect(storedSourceFamilies(database.adapter, member.connectors!, member)).toEqual([
      { source: 'chat', family: null, count: 1 },
    ]);
    accept(member.principalId, 'fixture-other-member-room', 'MEMBER_SENTINEL other');
    expect(
      storedSourceFamilies(database.adapter, surface.ownerAccess.connectors!, surface.ownerAccess)
    ).toEqual([{ source: 'chat', family: null, count: 2 }]);
  });

  it('counts viewer memories under live owner scopes, retaining unbound legacy records', async () => {
    const save = (access: JudgmentAccess, topic: string) =>
      data(
        'memory.save',
        {
          topic,
          kind: 'fact',
          summary: topic,
          details: topic,
          source: { package: 'fixture', source_type: 'test' },
        },
        access
      );
    const owner = await save(surface.ownerAccess, 'fixture-owner-memory');
    const hidden = await save(member, 'fixture-member-memory');
    database.adapter
      .prepare('UPDATE decisions SET created_at = 100 WHERE id IN (?, ?)')
      .run(owner.id, hidden.id);
    database.adapter
      .prepare(
        "INSERT INTO decisions (id, topic, decision, reasoning, created_at) VALUES ('fixture-legacy', 'legacy', 'legacy', '', 100)"
      )
      .run();
    expect(readViewerMemoryStats(database.adapter, 100, surface.ownerAccess)).toEqual({
      total: 2,
      thisWeek: 2,
    });
    await save(member, 'fixture-member-extra');
    expect(readViewerMemoryStats(database.adapter, 100, surface.ownerAccess)).toEqual({
      total: 2,
      thisWeek: 2,
    });
  });

  it('serves owner checkpoint and stats routes through the real dispatcher and live access', async () => {
    await checkpoints();
    for (const [access, topic] of [
      [surface.ownerAccess, 'fixture-viewer-owner'],
      [member, 'fixture-viewer-member'],
    ] as const) {
      await data(
        'memory.save',
        {
          topic,
          kind: 'fact',
          summary: topic,
          details: topic,
          source: { package: 'fixture', source_type: 'test' },
        },
        access
      );
    }
    const server = createViewerServer({
      dispatch: surface.dispatch,
      ownerAccess: surface.ownerAccess,
      port: 0,
      timeZone: createTimeZoneSetting('UTC'),
      getMemoryStats: () =>
        readViewerMemoryStats(database.adapter, Date.now(), surface.ownerAccess),
    });
    await server.start();
    try {
      const get = (path: string) =>
        new Promise<{ status: number; body: string }>((resolve, reject) => {
          request({ host: '127.0.0.1', port: server.port, path }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () =>
              resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString('utf8') })
            );
          })
            .on('error', reject)
            .end();
        });
      for (const path of ['/checkpoints', '/api/checkpoints']) {
        const response = await get(path);
        expect(response.status).toBe(200);
        expect(response.body).not.toContain('MEMBER_CHECKPOINT');
        expect(response.body).toContain('OWNER_CHECKPOINT');
        expect(response.body).toContain('LEGACY_CHECKPOINT');
      }
      const stats = await get('/api/dashboard/status');
      expect(stats.status).toBe(200);
      expect(JSON.parse(stats.body)).toEqual({ memory: { total: 1, thisWeek: 1 } });
    } finally {
      await server.stop();
    }
  });
});
