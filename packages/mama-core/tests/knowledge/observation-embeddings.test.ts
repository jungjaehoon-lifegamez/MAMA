import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getAdapter } from '../../src/db-manager.js';
import { appendObservationVersion } from '../../src/knowledge/observations.js';
import {
  readObservationEmbeddings,
  saveObservationEmbedding,
} from '../../src/knowledge/observation-embeddings.js';
import { cleanupTestDB, initTestDB } from '../helpers/test-utils.js';

function observe(sourceId: string) {
  return appendObservationVersion(getAdapter(), {
    source: 'chat',
    sourceType: 'message',
    sourceId,
    sourceEntityId: sourceId,
    channel: 'chat:room-1',
    author: 'member',
    bodyLocation: { kind: 'raw', connectorName: 'chat', revisionSourceId: sourceId },
    producerVersionId: sourceId,
    sourceAt: null,
    observedAt: 100,
    contentHash: `hash-${sourceId}`,
  });
}

describe('observation embeddings', () => {
  let path = '';
  beforeAll(async () => {
    path = await initTestDB('observation-embeddings');
  });
  beforeEach(() => {
    getAdapter().prepare('DELETE FROM observation_embeddings').run();
    getAdapter().prepare('DELETE FROM observation_versions').run();
  });
  afterAll(async () => cleanupTestDB(path));

  it('stores one vector per observation and reads back only those that have one', () => {
    const a = observe('m-1');
    const b = observe('m-2');
    saveObservationEmbedding(getAdapter(), a.observationId, new Float32Array([0.6, 0.8]), 5);
    saveObservationEmbedding(getAdapter(), a.observationId, new Float32Array([1, 0]), 6);

    const read = readObservationEmbeddings(getAdapter(), [a.observationId, b.observationId]);
    expect([...read.keys()]).toEqual([a.observationId]);
    expect([...read.get(a.observationId)!]).toEqual([1, 0]);
  });

  it('reads more ids than one statement can bind', () => {
    const ids = Array.from({ length: 1200 }, (_, index) => observe(`m-${index}`).observationId);
    for (const id of ids) saveObservationEmbedding(getAdapter(), id, new Float32Array([1]));
    expect(readObservationEmbeddings(getAdapter(), ids).size).toBe(1200);
  });

  it('refuses a vector for an observation that does not exist', () => {
    getAdapter().prepare('PRAGMA foreign_keys = ON').run();
    expect(() =>
      saveObservationEmbedding(getAdapter(), 'obs_missing', new Float32Array([1]))
    ).toThrow();
  });
});
