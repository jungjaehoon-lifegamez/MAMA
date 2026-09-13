import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { getAdapter } from '../../src/db-manager.js';
import {
  getConnectorEventIndexRecord,
  upsertConnectorEventIndex,
} from '../../src/connectors/event-index.js';
import {
  appendObservationVersion,
  readObservationVersion,
  searchOwnerObservationVersions,
} from '../../src/connectors/observation-versions.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import { isObservationVersionVisible } from '../../src/connectors/observation-visibility.js';

function input(sourceId: string, body: string, observedAt: number) {
  return {
    source_connector: 'trello',
    source_type: 'kanban_card',
    source_id: sourceId,
    source_entity_id: 'card-1',
    channel: 'trello:board-1',
    author: 'owner',
    content: body,
    event_datetime: 1_700_000_000_000,
    source_timestamp_ms: 1_700_000_000_000,
    observation: {
      producer_version_id: sourceId,
      body_location: {
        kind: 'raw' as const,
        connectorName: 'trello',
        revisionSourceId: sourceId,
      },
      observed_at: observedAt,
      source_at: null,
    },
  };
}

describe('immutable observation versions', () => {
  let path = '';

  beforeAll(async () => {
    path = await initTestDB('observation-versions');
  });

  it('exports observation and correction helpers from the package contract', async () => {
    const core = await import('../../src/index.js');
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    ) as { exports: Record<string, string> };

    expect(typeof core.appendObservationVersion).toBe('function');
    expect(typeof core.appendIdentityCorrection).toBe('function');
    expect(packageJson.exports['./connectors/observation-versions']).toBe(
      './dist/connectors/observation-versions.js'
    );
    expect(packageJson.exports['./registry/corrections']).toBe('./dist/registry/corrections.js');
  });
  beforeEach(() => {
    const adapter = getAdapter();
    adapter.prepare('DELETE FROM connector_event_index').run();
    adapter.prepare('DELETE FROM observation_versions').run();
  });
  afterAll(async () => cleanupTestDB(path));

  it('reuses one identity on retry and keeps A to B to A as three captured versions', () => {
    const adapter = getAdapter();
    const a1 = upsertConnectorEventIndex(adapter, input('card-1', 'A', 100));
    const retry = upsertConnectorEventIndex(adapter, input('card-1', 'A', 100));
    const b = upsertConnectorEventIndex(adapter, input('card-1:revision:b:2', 'B', 200));
    const a2 = upsertConnectorEventIndex(adapter, input('card-1:revision:a:3', 'A', 300));

    expect(retry.current_observation_id).toBe(a1.current_observation_id);
    expect(
      new Set([a1.current_observation_id, b.current_observation_id, a2.current_observation_id])
    ).toHaveLength(3);
    const rows = adapter
      .prepare('SELECT observed_at, source_at FROM observation_versions ORDER BY observed_at')
      .all() as Array<{ observed_at: number; source_at: number | null }>;
    expect(rows).toEqual([
      { observed_at: 100, source_at: null },
      { observed_at: 200, source_at: null },
      { observed_at: 300, source_at: null },
    ]);
  });

  it('keeps same mutable locator A to B to A distinct and never backdates implicit capture', () => {
    const adapter = getAdapter();
    const mutable = (body: string, observedAt: number) => ({
      ...input('card-1', body, observedAt),
      observation: { observed_at: observedAt, source_at: null },
    });
    const a1 = upsertConnectorEventIndex(adapter, mutable('A', 100));
    const retry = upsertConnectorEventIndex(adapter, mutable('A', 100));
    const b = upsertConnectorEventIndex(adapter, mutable('B', 100));
    const a2 = upsertConnectorEventIndex(adapter, mutable('A', 100));
    expect(retry.current_observation_id).toBe(a1.current_observation_id);
    expect(
      new Set([a1.current_observation_id, b.current_observation_id, a2.current_observation_id])
    ).toHaveLength(3);

    const before = Date.now();
    const legacy = upsertConnectorEventIndex(adapter, {
      source_connector: 'slack',
      source_type: 'message',
      source_id: 'legacy-direct',
      content: 'captured now',
      source_timestamp_ms: 1,
      indexed_at: '2001-01-01T00:00:00.000Z',
    });
    const read = readObservationVersion(adapter, legacy.current_observation_id!);
    expect(read.status).toBe('available');
    if (read.status === 'available') {
      expect(read.observation.observedAt).toBeGreaterThanOrEqual(before);
      expect(read.observation.observedAt).toBeLessThanOrEqual(Date.now());
    }
  });

  it('reports reader absence, missing version and hash mismatch without latest-body fallback', () => {
    const record = upsertConnectorEventIndex(getAdapter(), input('card-1', 'A', 100));
    expect(readObservationVersion(getAdapter(), record.current_observation_id!)).toMatchObject({
      status: 'version_unavailable',
      reason: 'BODY_READER_UNAVAILABLE',
    });
    expect(
      readObservationVersion(getAdapter(), record.current_observation_id!, {
        readVersion: () => ({ status: 'version_unavailable', reason: 'VERSION_NOT_FOUND' }),
      })
    ).toMatchObject({ status: 'version_unavailable', reason: 'VERSION_NOT_FOUND' });
    expect(
      readObservationVersion(getAdapter(), record.current_observation_id!, {
        readVersion: () => ({ status: 'version_unavailable', reason: 'HASH_MISMATCH' }),
      })
    ).toMatchObject({ status: 'version_unavailable', reason: 'HASH_MISMATCH' });
  });

  it('rolls observation back when the companion index write fails', () => {
    const adapter = getAdapter();
    adapter
      .prepare(
        `CREATE TRIGGER fail_index BEFORE INSERT ON connector_event_index BEGIN SELECT RAISE(ABORT, 'forced index failure'); END`
      )
      .run();
    expect(() => upsertConnectorEventIndex(adapter, input('card-1', 'A', 100))).toThrow(
      /forced index failure/
    );
    adapter.prepare('DROP TRIGGER fail_index').run();
    const count = adapter.prepare('SELECT COUNT(*) AS count FROM observation_versions').get() as {
      count: number;
    };
    expect(count.count).toBe(0);
  });

  it('retains observation metadata after current index retention deletes the row', () => {
    const record = upsertConnectorEventIndex(getAdapter(), input('card-1', 'A', 100));
    getAdapter()
      .prepare('DELETE FROM connector_event_index WHERE event_index_id = ?')
      .run(record.event_index_id);
    expect(readObservationVersion(getAdapter(), record.current_observation_id!)).toMatchObject({
      status: 'version_unavailable',
      observation: { observedAt: 100, sourceAt: null },
    });
  });

  it('rejects replay unless the complete immutable payload is byte-equivalent after canonicalization', () => {
    const adapter = getAdapter();
    const original = {
      sourceConnector: 'synthetic',
      sourceId: 'message-1',
      producerVersionId: 'version-1',
      body: 'exact body',
      author: 'synthetic-author',
      sourceAt: 10,
      observedAt: 20,
      contentHash: 'synthetic-content-hash',
      metadata: { nested: { a: 1, b: 2 } },
      scope: { visibility: 'owner', principalId: 'principal-1', agentId: 'agent-1' },
    } as const;
    const first = appendObservationVersion(adapter, original);
    expect(
      appendObservationVersion(adapter, {
        ...original,
        metadata: { nested: { b: 2, a: 1 } },
      })
    ).toEqual(first);

    const conflicts = [
      { body: 'changed body' },
      { author: 'other-author' },
      { sourceAt: 11 },
      { observedAt: 21 },
      { metadata: { nested: { a: 1, b: 3 } } },
      { scope: { visibility: 'owner', principalId: 'principal-2', agentId: 'agent-1' } },
    ];
    for (const changed of conflicts) {
      expect(() => appendObservationVersion(adapter, { ...original, ...changed })).toThrowError(
        /observation.*conflict/i
      );
    }

    const located = {
      ...original,
      sourceId: 'message-2',
      body: undefined,
      bodyLocation: {
        kind: 'raw' as const,
        connectorName: 'synthetic',
        revisionSourceId: 'revision-1',
      },
    };
    appendObservationVersion(adapter, located);
    expect(() =>
      appendObservationVersion(adapter, {
        ...located,
        bodyLocation: { ...located.bodyLocation, revisionSourceId: 'revision-2' },
      })
    ).toThrowError(/observation.*conflict/i);
  });

  it('binds producer identity independently of a recomputed content hash', () => {
    const adapter = getAdapter();
    const original = {
      sourceConnector: 'synthetic',
      sourceId: 'message-producer',
      producerVersionId: 'delivery-1',
      body: 'first body',
      observedAt: 40,
      contentHash: 'hash-first',
    } as const;
    const first = appendObservationVersion(adapter, original);

    expect(() =>
      appendObservationVersion(adapter, {
        ...original,
        body: 'changed body',
        contentHash: 'hash-changed',
      })
    ).toThrowError(/observation.*conflict/i);
    expect(adapter.prepare('SELECT COUNT(*) AS count FROM observation_versions').get()).toEqual({
      count: 1,
    });
    expect(first.observationId).toMatch(/^obs_/);
  });

  it('keeps content-addressed versions when the producer supplies no version identity', () => {
    const adapter = getAdapter();
    const first = appendObservationVersion(adapter, {
      sourceConnector: 'synthetic',
      sourceId: 'mutable-message',
      body: 'A',
      observedAt: 50,
      contentHash: 'hash-a',
    });
    const second = appendObservationVersion(adapter, {
      sourceConnector: 'synthetic',
      sourceId: 'mutable-message',
      body: 'B',
      observedAt: 51,
      contentHash: 'hash-b',
    });

    expect(second.observationId).not.toBe(first.observationId);
  });

  it('rejects an available body reader response whose hash differs from the observation', () => {
    const record = upsertConnectorEventIndex(getAdapter(), input('card-reader-hash', 'A', 100));
    expect(
      readObservationVersion(getAdapter(), record.current_observation_id!, {
        readVersion: () => ({ status: 'available', body: 'different', contentHash: 'wrong-hash' }),
      })
    ).toMatchObject({ status: 'version_unavailable', reason: 'HASH_MISMATCH' });
  });

  it('searches owner observations by both signed principal and agent', () => {
    const adapter = getAdapter();
    for (const principalId of ['principal-a', 'principal-b']) {
      appendObservationVersion(adapter, {
        sourceConnector: 'owner-message:slack',
        sourceId: `message-${principalId}`,
        producerVersionId: `delivery-${principalId}`,
        body: 'same searchable text',
        observedAt: principalId === 'principal-a' ? 60 : 61,
        contentHash: `hash-${principalId}`,
        scope: {
          visibility: 'owner',
          principalId,
          agentId: 'agent-1',
          channel: 'channel-1',
        },
      });
    }

    const result = searchOwnerObservationVersions(adapter, {
      query: 'searchable',
      principalId: 'principal-a',
      agentId: 'agent-1',
    });
    expect(result.items.map((item) => item.sourceId)).toEqual(['message-principal-a']);
    expect(result.items[0]).not.toHaveProperty('body');
    expect(result.items[0]).not.toHaveProperty('scope');
  });

  it.each([null, 7, ['cursor']])('rejects a decoded non-object owner cursor: %j', (decoded) => {
    expect(() =>
      searchOwnerObservationVersions(getAdapter(), {
        query: 'searchable',
        principalId: 'principal-a',
        agentId: 'agent-1',
        cursor: Buffer.from(JSON.stringify(decoded)).toString('base64url'),
      })
    ).toThrow('Invalid owner observation cursor.');
  });

  it('enforces connector and channel authority alongside principal, agent, and scope', () => {
    const adapter = getAdapter();
    const raw = appendObservationVersion(adapter, {
      sourceConnector: 'slack',
      sourceId: 'channel-denied',
      producerVersionId: 'delivery-channel-denied',
      body: 'same project, different channel',
      observedAt: 70,
      contentHash: 'hash-channel-denied',
      scope: {
        channel: 'channel-b',
        memoryScopeKind: 'project',
        memoryScopeId: 'project-a',
      },
    });
    const authority = {
      principalId: 'principal-a',
      agentId: 'agent-a',
      scopes: [{ kind: 'project' as const, id: 'project-a' }],
      connectors: ['slack'],
      channels: { slack: ['channel-a'] },
    };
    expect(isObservationVersionVisible(adapter, raw.observationId, authority)).toBe(false);

    const owner = appendObservationVersion(adapter, {
      sourceConnector: 'owner-message:slack',
      sourceId: 'owner-channel-a',
      producerVersionId: 'owner-delivery-a',
      body: 'owner body',
      observedAt: 71,
      contentHash: 'hash-owner-channel-a',
      scope: {
        visibility: 'owner',
        principalId: 'principal-a',
        agentId: 'agent-a',
        channel: 'channel-a',
      },
    });
    expect(isObservationVersionVisible(adapter, owner.observationId, authority)).toBe(true);
    expect(
      isObservationVersionVisible(adapter, owner.observationId, {
        ...authority,
        principalId: 'principal-b',
      })
    ).toBe(false);
  });

  it('fails explicitly when stored metadata or scope JSON is malformed', () => {
    const adapter = getAdapter();
    const record = appendObservationVersion(adapter, {
      sourceConnector: 'synthetic',
      sourceId: 'message-corrupt',
      body: 'body',
      observedAt: 30,
      contentHash: 'synthetic-hash-corrupt',
      metadata: { safe: true },
      scope: { memoryScopeKind: 'project', memoryScopeId: 'project-1' },
    });
    adapter
      .prepare('UPDATE observation_versions SET metadata_json = ? WHERE observation_id = ?')
      .run('{invalid', record.observationId);
    expect(() => readObservationVersion(adapter, record.observationId)).toThrowError(
      /metadata_json/i
    );
    adapter
      .prepare(
        'UPDATE observation_versions SET metadata_json = ?, scope_json = ? WHERE observation_id = ?'
      )
      .run('{}', '[]', record.observationId);
    expect(() => readObservationVersion(adapter, record.observationId)).toThrowError(/scope_json/i);
  });

  it('fails explicitly when a current event ref points at no observation', () => {
    const adapter = getAdapter();
    const record = upsertConnectorEventIndex(adapter, input('card-inconsistent', 'A', 100));
    adapter.exec('PRAGMA foreign_keys = OFF');
    adapter
      .prepare(
        'UPDATE connector_event_index SET current_observation_id = ? WHERE event_index_id = ?'
      )
      .run('obs-missing', record.event_index_id);
    adapter.exec('PRAGMA foreign_keys = ON');
    expect(() =>
      getConnectorEventIndexRecord(adapter, record.source_connector, record.source_id)
    ).toThrowError(/inconsistent current observation ref/);
  });
});
