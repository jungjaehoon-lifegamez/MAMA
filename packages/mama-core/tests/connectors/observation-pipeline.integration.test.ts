import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getAdapter } from '../../src/db-manager.js';
import { upsertConnectorEventIndex } from '../../src/connectors/event-index.js';
import { readObservationVersion } from '../../src/connectors/observation-versions.js';
import { getRawById } from '../../src/connectors/raw-query.js';
import { readRawCandidates } from '../../src/context-compile/source-readers.js';
import {
  mapNormalizedItemsToConnectorEventIndexInputs,
  RawStore,
} from '../../src/storage/source-archive.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';

describe('TG-03/TG-05 immutable observation pipeline', () => {
  let dbPath = '';
  let rawDir = '';

  beforeAll(async () => {
    dbPath = await initTestDB('observation-pipeline');
    rawDir = mkdtempSync(join(tmpdir(), 'mama-observation-pipeline-'));
  });

  afterAll(async () => {
    await cleanupTestDB(dbPath);
    rmSync(rawDir, { recursive: true, force: true });
  });

  it('keeps one exact raw ref through pending projection, current readers, and restart', async () => {
    const scope = { kind: 'project' as const, id: 'project-observation' };
    let store = new RawStore(rawDir);
    const [saved] = store.save('slack', [
      {
        source: 'slack',
        sourceId: 'message-1',
        sourceEntityId: 'message-1',
        channel: 'channel-1',
        author: 'synthetic-author',
        content: 'immutable source body',
        timestamp: new Date(1_700_000_000_000),
        type: 'message',
        projectId: scope.id,
        memoryScopeKind: scope.kind,
        memoryScopeId: scope.id,
        metadata: { topic: 'synthetic' },
        observedAt: 1_700_000_000_100,
      },
    ]);
    expect(saved).toBeDefined();
    const [input] = mapNormalizedItemsToConnectorEventIndexInputs('slack', [saved!]);
    const indexed = upsertConnectorEventIndex(getAdapter(), input!);
    store.acknowledgeProjection('slack', saved!.sourceId, saved!.pendingProjectionId!);
    const observationRef = indexed.current_observation_id;
    expect(observationRef).toMatch(/^obs_/);

    const raw = getRawById(getAdapter(), indexed.event_index_id);
    expect(raw?.observation_ref).toBe(observationRef);
    const context = await readRawCandidates(getAdapter(), {
      task: 'read immutable source',
      connectors: ['slack'],
      scopes: [scope],
      limit: 10,
    });
    expect(context.source_refs).toContainEqual(
      expect.objectContaining({
        kind: 'raw',
        raw_id: indexed.event_index_id,
        observation_ref: observationRef,
      })
    );

    store.close();
    store = new RawStore(rawDir);
    const read = readObservationVersion(getAdapter(), observationRef!, {
      readVersion: ({ connectorName, revisionSourceId, expectedContentHash }) =>
        store.readVersion(connectorName, revisionSourceId, expectedContentHash) as
          | { status: 'available'; body: string; contentHash: string }
          | {
              status: 'version_unavailable';
              reason: 'VERSION_NOT_FOUND' | 'HASH_MISMATCH';
            },
    });
    expect(read).toMatchObject({ status: 'available', body: 'immutable source body' });
    expect(store.listPendingProjections('slack')).toEqual([]);
    store.close();
  });

  it('snapshots each changed provenance payload across a core-success crash before acknowledgement', () => {
    const store = new RawStore(rawDir);
    const base = {
      source: 'slack',
      sourceId: 'message-scope-change',
      sourceEntityId: 'message-scope-change',
      channel: 'channel-a',
      author: 'synthetic-author',
      content: 'same immutable body',
      timestamp: new Date(1_700_000_000_000),
      type: 'message' as const,
      sourceCursor: 'cursor-a',
      projectId: 'project-a',
      memoryScopeKind: 'project',
      memoryScopeId: 'project-a',
      observedAt: 1_700_000_000_100,
    };
    try {
      const [first] = store.save('slack', [base]);
      expect(first).toBeDefined();
      const [firstInput] = mapNormalizedItemsToConnectorEventIndexInputs('slack', [first!]);
      upsertConnectorEventIndex(getAdapter(), firstInput!);
      // Simulate core commit followed by process death before pending acknowledgement.
      const [second] = store.save('slack', [
        {
          ...base,
          sourceCursor: 'cursor-b',
          projectId: 'project-b',
          memoryScopeId: 'project-b',
          observedAt: 1_700_000_000_200,
        },
      ]);
      expect(second).toBeDefined();

      const pending = store.listPendingProjections('slack');
      expect(pending).toHaveLength(2);
      expect(
        pending.map((item) => ({
          channel: item.channel,
          cursor: item.sourceCursor,
          project: item.projectId,
          scope: item.memoryScopeId,
          observedAt: item.observedAt,
        }))
      ).toEqual([
        {
          channel: 'channel-a',
          cursor: 'cursor-a',
          project: 'project-a',
          scope: 'project-a',
          observedAt: 1_700_000_000_100,
        },
        {
          channel: 'channel-a',
          cursor: 'cursor-b',
          project: 'project-b',
          scope: 'project-b',
          observedAt: 1_700_000_000_200,
        },
      ]);
      expect(() =>
        (
          store.acknowledgeProjection as (
            connectorName: string,
            revisionSourceId: string,
            pendingProjectionId?: number
          ) => void
        )('slack', pending[0]!.sourceId)
      ).toThrow(/pending projection id/i);
      expect(store.listPendingProjections('slack')).toHaveLength(2);
      expect(() =>
        store.acknowledgeProjection('slack', 'wrong-source', pending[0]!.pendingProjectionId)
      ).toThrow(/exactly one row/i);
      expect(() =>
        store.acknowledgeProjections('slack', [
          {
            revisionSourceId: pending[0]!.sourceId,
            pendingProjectionId: pending[0]!.pendingProjectionId,
          },
          {
            revisionSourceId: 'wrong-source',
            pendingProjectionId: pending[1]!.pendingProjectionId,
          },
        ])
      ).toThrow(/exactly one row/i);
      expect(store.listPendingProjections('slack')).toHaveLength(2);

      const firstPendingInput = mapNormalizedItemsToConnectorEventIndexInputs('slack', [
        pending[0]!,
      ])[0]!;
      upsertConnectorEventIndex(getAdapter(), firstPendingInput);
      store.acknowledgeProjection('slack', pending[0]!.sourceId, pending[0]!.pendingProjectionId);
      expect(() =>
        store.acknowledgeProjection('slack', pending[0]!.sourceId, pending[0]!.pendingProjectionId)
      ).toThrow(/exactly one row/i);
      for (const projection of pending.slice(1)) {
        const [projectionInput] = mapNormalizedItemsToConnectorEventIndexInputs('slack', [
          projection,
        ]);
        upsertConnectorEventIndex(getAdapter(), projectionInput!);
        store.acknowledgeProjection('slack', projection.sourceId, projection.pendingProjectionId);
      }
      expect(store.listPendingProjections('slack')).toEqual([]);
      const observations = getAdapter()
        .prepare(
          `SELECT observation_id FROM observation_versions
           WHERE source_connector = 'slack' AND source_id = ? ORDER BY observed_at`
        )
        .all(base.sourceId) as Array<{ observation_id: string }>;
      expect(observations).toHaveLength(2);
      for (const observation of observations) {
        expect(
          readObservationVersion(getAdapter(), observation.observation_id, {
            readVersion: ({ connectorName, revisionSourceId, expectedContentHash }) =>
              store.readVersion(connectorName, revisionSourceId, expectedContentHash) as
                | { status: 'available'; body: string; contentHash: string }
                | {
                    status: 'version_unavailable';
                    reason: 'VERSION_NOT_FOUND' | 'HASH_MISMATCH';
                  },
          })
        ).toMatchObject({ status: 'available', body: 'same immutable body' });
      }
      expect(
        getAdapter()
          .prepare(
            `SELECT memory_scope_id, current_observation_id FROM connector_event_index
             WHERE source_connector = 'slack' AND source_id = ?`
          )
          .get(base.sourceId)
      ).toMatchObject({
        memory_scope_id: 'project-b',
        current_observation_id: expect.stringMatching(/^obs_/),
      });
    } finally {
      store.close();
    }
  });

  it('rejects an immutable producer source id replay with a changed source timestamp', () => {
    const store = new RawStore(rawDir);
    const version = {
      source: 'slack',
      sourceId: 'message-version:1',
      sourceEntityId: 'message-version',
      channel: 'channel-a',
      author: 'synthetic-author',
      content: 'immutable body',
      timestamp: new Date(1_700_000_000_000),
      type: 'message' as const,
    };
    try {
      store.save('slack', [version]);
      expect(() =>
        store.save('slack', [
          { ...version, timestamp: new Date(version.timestamp.getTime() + 1_000) },
        ])
      ).toThrowError(/immutable raw producer replay conflict/i);
    } finally {
      store.close();
    }
  });
});
