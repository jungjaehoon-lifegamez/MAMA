import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCatalog, createDispatcher } from '@jungjaehoon/mama-core';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { sourceActionRegistrations } from '../../src/api/source-actions.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';
import { describe, expect, it, vi } from 'vitest';
import { createStoredSourceReader } from '../../src/api/stored-source-reader.js';

describe('stored source reader', () => {
  it('fails source.read of erased observations through dispatch without returning content', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stored-erased-observation-'));
    const handle = await openCoreDatabase({ path: join(root, 'state.db') });
    try {
      handle.adapter
        .prepare(
          'INSERT INTO observation_versions (observation_id, observed_at, metadata_json, scope_json, erased_at) VALUES (\'erased-observation\', 1, \'{}\', \'{"scopes":[{"kind":"user","id":"test-principal"}]}\', 2)'
        )
        .run();
      const readVersion = vi.fn(() => {
        throw new Error('Erased content must never be read');
      });
      const reader = createStoredSourceReader({
        adapter: handle.adapter,
        rawStore: () => ({ readVersion }),
      });
      const dispatch = createDispatcher(
        createCatalog(
          sourceActionRegistrations({ stored: reader, timeZone: createTimeZoneSetting('UTC') })
        )
      );
      const access = {
        principalId: 'test-principal',
        agentId: 'test-agent',
        actions: ['source.read'],
        connectors: ['test-source'],
        connectorWideRead: ['test-source'],
        scopes: [{ kind: 'user', id: 'test-principal' }],
      };
      for (const input of [
        { source: 'test-source', observationRef: 'erased-observation' },
        { observationRef: 'erased-observation' },
      ]) {
        const result = await dispatch({ action: 'source.read', input }, { access });
        expect(result).toMatchObject({
          status: 'failed',
          error: { code: 'internal_error', message: 'observation_erased' },
        });
        expect(result).not.toHaveProperty('data');
      }
      const batch = await dispatch(
        { action: 'source.read', input: { observationRefs: ['erased-observation'] } },
        { access }
      );
      expect(batch).toMatchObject({
        status: 'completed',
        data: {
          results: [
            { observationRef: 'erased-observation', status: 'failed', error: 'observation_erased' },
          ],
        },
      });
      expect(readVersion).not.toHaveBeenCalled();
    } finally {
      handle.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the owner connector grant to read a bounded stored page', () => {
    const reader = createStoredSourceReader({
      adapter: {
        prepare: (sql: string) => ({
          get: () => (sql.includes('COUNT(*)') ? { count: 0, channel_count: 0 } : undefined),
          all: () => [],
        }),
      } as never,
    });
    const result = reader.search(
      'connector-test',
      { query: 'term', limit: 10 },
      {
        principalId: 'owner-test',
        agentId: 'agent-test',
        actions: ['source.search'],
        connectors: ['connector-test'],
        connectorWideRead: ['connector-test'],
        scopes: [],
      }
    );

    expect(result).toMatchObject({
      source: 'connector-test',
      mode: 'stored',
      hits: [],
      coverage: { returned: 0, pageComplete: true },
    });
    expect(result.coverage).not.toHaveProperty('sourceComplete');
  });

  it('returns one result per batch ref when replay ceiling hides a future observation', () => {
    const rows = new Map<string, Record<string, unknown>>([
      [
        'observation-readable',
        {
          observation_id: 'observation-readable',
          source: 'connector-test',
          source_id: 'source-readable',
          producer_version_id: null,
          body: 'readable source body',
          body_location_json: null,
          author: 'author-test',
          source_at: 1_000,
          observed_at: 1_100,
          content_hash: 'hash-readable',
          metadata_json: '{}',
          scope_json: '{}',
          source_type: null,
          source_locator: null,
          title: null,
          artifact_locator: null,
          artifact_title: null,
          event_date: null,
          source_entity_id: null,
          channel: 'channel-test',
          project_id: null,
          tenant_id: null,
          memory_scope_kind: null,
          memory_scope_id: null,
        },
      ],
      [
        'observation-future',
        {
          observation_id: 'observation-future',
          source: 'connector-test',
          source_id: 'source-future',
          producer_version_id: null,
          body: 'future source body',
          body_location_json: null,
          author: 'author-test',
          source_at: 2_000,
          observed_at: 2_100,
          content_hash: 'hash-future',
          metadata_json: '{}',
          scope_json: '{}',
          source_type: null,
          source_locator: null,
          title: null,
          artifact_locator: null,
          artifact_title: null,
          event_date: null,
          source_entity_id: null,
          channel: 'channel-test',
          project_id: null,
          tenant_id: null,
          memory_scope_kind: null,
          memory_scope_id: null,
        },
      ],
    ]);
    const reader = createStoredSourceReader({
      adapter: {
        prepare: (sql: string) => ({
          get: (...args: unknown[]) => {
            const ref = String(args[0]);
            const row = rows.get(ref);
            if (sql.includes('SELECT o.channel')) {
              const ceiling = args[2];
              if (
                !row ||
                row.source !== args[1] ||
                (typeof ceiling === 'number' && Number(row.source_at) > ceiling)
              ) {
                return undefined;
              }
              return { channel: row.channel };
            }
            if (sql.includes('SELECT * FROM observation_versions')) return row;
            return undefined;
          },
          all: () => [],
        }),
      } as never,
    });

    const result = reader.read(
      'connector-test',
      {
        observationRefs: ['observation-readable', 'observation-future'],
        content_limit: 100,
      },
      {
        principalId: 'owner-test',
        agentId: 'agent-test',
        actions: ['source.read'],
        connectors: ['connector-test'],
        connectorWideRead: ['connector-test'],
        scopes: [],
      },
      { maxSourceMs: 1_500 }
    );

    expect(result).toMatchObject({
      source: 'connector-test',
      mode: 'stored',
      results: [
        {
          observationRef: 'observation-readable',
          status: 'completed',
          data: { content: 'readable source body' },
        },
        {
          observationRef: 'observation-future',
          status: 'failed',
          error: {
            code: 'stored_source_not_found',
            message: 'No stored observation exists for this source and reference',
          },
        },
      ],
    });
  });
});
