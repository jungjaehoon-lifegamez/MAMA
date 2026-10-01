import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCatalog, createDispatcher, type ActionContext } from '@jungjaehoon/mama-core';
import { saveObservationEmbedding } from '@jungjaehoon/mama-core/knowledge';
import { meaningSearchRaw } from '../../src/connectors/framework/raw-query.js';
import { upsertConnectorEventIndex } from '../../src/connectors/framework/event-index.js';
import type { UpsertConnectorEventIndexInput } from '../../src/connectors/framework/connector-event-types.js';
import { createStoredSourceReader } from '../../src/api/stored-source-reader.js';
import { sourceActionRegistrations } from '../../src/api/source-actions.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';

// Synthetic unit vectors stand in for e5: the Japanese message and the Korean query share a
// direction, as the model places one meaning in two languages; the unrelated message does not.
const SAME_MEANING = new Float32Array([1, 0, 0]);
const OTHER_MEANING = new Float32Array([0, 1, 0]);
const KOREAN_QUERY = new Float32Array([1, 0, 0]);

const access: ActionContext['access'] = {
  principalId: 'owner-test',
  agentId: 'agent-test',
  actions: ['source.search'],
  connectors: ['connector-test'],
  scopes: [],
};

describe('meaning search over stored observations', () => {
  let root: string;
  let database: Awaited<ReturnType<typeof openCoreDatabase>>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'raw-meaning-'));
    database = await openCoreDatabase({ path: join(root, 'core.db') });
  });

  afterEach(async () => {
    await database?.close();
    rmSync(root, { recursive: true, force: true });
  });

  function seed(
    sourceId: string,
    vector: Float32Array | null,
    overrides: Partial<UpsertConnectorEventIndexInput> = {}
  ) {
    const saved = upsertConnectorEventIndex(database.adapter, {
      source_connector: 'connector-test',
      source_type: 'message',
      source_id: sourceId,
      channel: 'channel-test',
      content: '修正版を送りました',
      event_datetime: 100,
      observation: { observed_at: 2_000 },
      ...overrides,
    });
    if (vector) saveObservationEmbedding(database.adapter, saved.current_observation_id!, vector);
    return saved;
  }

  // Unrelated messages the query is measured against: a hit must stand out from them.
  function background(count: number, overrides: Partial<UpsertConnectorEventIndexInput> = {}) {
    for (let index = 0; index < count; index += 1) {
      seed(`background-${index}`, OTHER_MEANING, { content: `会議 ${index}`, ...overrides });
    }
  }

  const search = (input: Partial<Parameters<typeof meaningSearchRaw>[1]> = {}) =>
    meaningSearchRaw(database.adapter, { connectors: ['connector-test'], ...input }, KOREAN_QUERY, {
      limit: 10,
      minZ: 2.5,
    });

  it('finds a Japanese-only message for a Korean query no term of which matches as text', () => {
    const japanese = seed('japanese', SAME_MEANING);
    background(9);
    seed('not-embedded', null);

    expect(search()).toMatchObject([
      { source_id: 'japanese', raw_id: japanese.current_observation_id, score: 1 },
    ]);
  });

  it('keeps the replay ceiling, time, channel and one-connector filters', () => {
    seed('readable', SAME_MEANING, { event_datetime: 150 });
    background(9, { event_datetime: 130 });
    seed('after-ceiling', SAME_MEANING, { event_datetime: 151 });
    seed('other-channel', SAME_MEANING, { channel: 'channel-other' });
    seed('other-connector', SAME_MEANING, { source_connector: 'connector-other' });

    expect(
      search({ maxSourceMs: 150, fromMs: 120, channels: ['channel-test'] }).map(
        (hit) => hit.source_id
      )
    ).toEqual(['readable']);
    expect(() => search({ connectors: ['connector-test', 'connector-other'] })).toThrow(
      /exactly one connector/
    );
    expect(() => search({ connectors: [] })).toThrow(/exactly one connector/);
  });

  it('searches the current version only and leaves out the text hits', () => {
    const first = seed('edited', SAME_MEANING);
    const edited = seed('edited', OTHER_MEANING, { content: '会議は明日です' });
    expect(edited.current_observation_id).not.toBe(first.current_observation_id);
    const kept = seed('kept', SAME_MEANING);
    background(9);

    expect(search().map((hit) => hit.source_id)).toEqual(['kept']);
    expect(
      meaningSearchRaw(database.adapter, { connectors: ['connector-test'] }, KOREAN_QUERY, {
        limit: 10,
        minZ: 2.5,
        exclude: new Set([kept.current_observation_id!]),
      })
    ).toEqual([]);
  });

  it("keeps a hit only where it stands out from the query's other scores", () => {
    // Every message here scores 0.8 or more; only the one well above the rest is a hit.
    for (let index = 0; index < 10; index += 1) {
      seed(`close-${index}`, new Float32Array([0.8, 0.6, 0]));
    }
    seed('closest', new Float32Array([0.95, Math.sqrt(1 - 0.95 ** 2), 0]));
    expect(search().map((hit) => hit.source_id)).toEqual(['closest']);
  });

  it('refuses a stored vector of another dimension instead of skipping it', () => {
    seed('other-model', new Float32Array([1, 0]));
    expect(() => search()).toThrow(/2 dimensions; the query has 3/);
  });

  it('returns text hits first, then meaning hits labelled with their similarity', async () => {
    const textHit = seed('text-hit', SAME_MEANING, { content: 'revised draft sent' });
    const meaningHit = seed('meaning-hit', SAME_MEANING);
    background(20);
    const queries: string[] = [];
    const reader = createStoredSourceReader({
      adapter: database.adapter,
      ownerPrincipalId: () => 'owner-test',
    });
    const dispatch = createDispatcher(
      createCatalog(
        sourceActionRegistrations({
          stored: reader,
          timeZone: createTimeZoneSetting('UTC'),
          embedQuery: async (text) => {
            queries.push(text);
            return KOREAN_QUERY;
          },
        })
      )
    );

    const first = await dispatch(
      { action: 'source.search', input: { source: 'connector-test', query: 'revised' } },
      { access }
    );
    expect(queries).toEqual(['revised']);
    expect(first).toMatchObject({
      status: 'completed',
      data: {
        hits: [
          { observationRef: textHit.current_observation_id, match: 'text' },
          { observationRef: meaningHit.current_observation_id, match: 'meaning', similarity: 1 },
        ],
      },
    });
    const { hits, coverage } = (
      first as {
        data: { hits: Array<Record<string, unknown>>; coverage: Record<string, unknown> };
      }
    ).data;
    expect(hits).toHaveLength(2);
    expect(coverage).toMatchObject({ returned: 2 });
    expect(hits[0]).not.toHaveProperty('similarity');

    // A later page continues the text hits only.
    seed('second-text-hit', OTHER_MEANING, {
      content: 'revised draft checked',
      event_datetime: 50,
    });
    const page = await dispatch(
      { action: 'source.search', input: { source: 'connector-test', query: 'revised', limit: 1 } },
      { access }
    );
    const cursor = (page as { data: { next_cursor: string | null } }).data.next_cursor;
    expect(cursor).toEqual(expect.any(String));
    queries.length = 0;
    const next = await dispatch(
      {
        action: 'source.search',
        input: { source: 'connector-test', query: 'revised', limit: 1, cursor },
      },
      { access }
    );
    expect(queries).toEqual([]);
    expect(
      (next as { data: { hits: Array<Record<string, unknown>> } }).data.hits.map((hit) => hit.match)
    ).toEqual(['text']);
  });

  it('returns text hits only when the embedder is in its no-vector mode', async () => {
    seed('meaning-hit', SAME_MEANING);
    const dispatch = createDispatcher(
      createCatalog(
        sourceActionRegistrations({
          stored: createStoredSourceReader({
            adapter: database.adapter,
            ownerPrincipalId: () => 'owner-test',
          }),
          timeZone: createTimeZoneSetting('UTC'),
          embedQuery: async () => null,
        })
      )
    );
    expect(
      await dispatch(
        { action: 'source.search', input: { source: 'connector-test', query: 'revised' } },
        { access }
      )
    ).toMatchObject({ status: 'completed', data: { hits: [] } });
  });
});
