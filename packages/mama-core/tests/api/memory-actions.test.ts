import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import { getAdapter } from '../../src/db-manager.js';
import { createKnowledge, type Knowledge } from '../../src/knowledge/index.js';
import { saveCheckpoint } from '../../src/mama-api.js';
import { cleanupTestDB, initTestDB } from '../helpers/test-utils.js';
import type { MemoryScopeRef } from '../../src/memory/types.js';
import { createCatalog, coreActionRegistrations } from '../../src/api/catalog.js';
import { createDispatcher, type ActionDispatcher } from '../../src/api/dispatch.js';
import { appendOperationToolTrace } from '../../src/runtime/tool-trace-store.js';
import { appendObservationVersion } from '../../src/knowledge/observations.js';
import { Mailbox } from '../../src/runtime/mailbox.js';
import { resolveMemoryProvenanceLive } from '../../src/memory/provenance-live.js';
import { listDecisionsInAdapter } from '../../src/memory/api.js';

const ACCESS = {
  principalId: 'principal-test',
  agentId: 'agent-test',
  scopes: [{ kind: 'project' as const, id: 'scope-test' }] as MemoryScopeRef[],
  // The grant this test stands on: exactly the actions it calls.
  actions: [
    'memory.checkpoint.load',
    'memory.checkpoint.save',
    'memory.read:experience',
    'memory.read:provenance',
    'memory.read:topic',
    'memory.save',
    'memory.search',
    'memory.update',
    'source.ingest',
  ],
};

describe('Story M1: memory.save through the unified action path', () => {
  let dbPath = '';
  let knowledge: Knowledge;
  let dispatch: ActionDispatcher;

  beforeAll(async () => {
    dbPath = await initTestDB('memory-actions');
    knowledge = createKnowledge({ adapter: getAdapter(), embedder: null });
    dispatch = createDispatcher(createCatalog(coreActionRegistrations(knowledge, getAdapter())));
  });

  beforeEach(() => {
    const db = getAdapter();
    db.prepare('DELETE FROM twin_edges').run();
    db.prepare('DELETE FROM source_commands').run();
    db.prepare('DELETE FROM observation_versions').run();
    db.prepare('DELETE FROM judgment_commands').run();
    db.prepare('DELETE FROM command_bindings').run();
    db.prepare('DELETE FROM memory_events').run();
    db.prepare('DELETE FROM memory_scope_bindings').run();
    db.prepare('DELETE FROM memory_scopes').run();
    db.prepare('DELETE FROM embeddings').run();
    db.prepare('DELETE FROM decisions').run();
    db.prepare('DELETE FROM checkpoints').run();
  });

  afterAll(async () => cleanupTestDB(dbPath));

  const saveVia = async (
    summary: string,
    scopes: MemoryScopeRef[],
    operationId: string,
    access = ACCESS
  ) => {
    const saved = await dispatch(
      {
        action: 'memory.save',
        operationId,
        input: {
          topic: `topic-${operationId}`,
          kind: 'decision',
          summary,
          details: `details for ${summary}`,
          scopes,
          source: { package: 'mama-core', source_type: 'test' },
        },
      },
      { access }
    );
    expect(saved.status).toBe('completed');
    return saved;
  };

  it('accepts a package name the core has never heard of', async () => {
    // The completion criterion for consumer neutrality, in one call. `package` was a
    // union of the four packages that existed when it was written, so a second product
    // installing this core had to be added to the core's own type before it could save
    // anything. A core that must be edited to admit a consumer is not neutral about them.
    const saved = await dispatch(
      {
        action: 'memory.save',
        operationId: 'op-unknown-package',
        input: {
          topic: 'topic-unknown-package',
          kind: 'decision',
          summary: 'a product the core does not know about saves a memory',
          details: 'details',
          scopes: ACCESS.scopes,
          source: { package: 'nh', source_type: 'test' },
        },
      },
      { access: ACCESS }
    );

    expect(saved.error).toBeUndefined();
    expect(saved.status).toBe('completed');
  });

  it('appends a judgment record with provenance composed from access and session facts', async () => {
    const result = await dispatch(
      {
        action: 'memory.save',
        operationId: 'op-save-1',
        input: {
          topic: 'deploy_window',
          kind: 'decision',
          summary: 'Deploys happen Tuesday 10:00 KST',
          details: 'Owner confirmed the fixed window.',
          confidence: 0.9,
          scopes: ACCESS.scopes,
          source: { package: 'mama-core', source_type: 'test' },
        },
      },
      {
        access: ACCESS,
        session: {
          actor: 'main_agent',
          modelRunId: 'mr-1',
          toolName: 'mama_save',
          gatewayCallId: 'gw-1',
          envelopeHash: 'env-1',
          sourceRefs: ['message:test-1'],
        },
      }
    );

    expect(result.status).toBe('completed');
    const id = String((result as { data: { id: string } }).data.id);
    const row = getAdapter()
      .prepare(
        `SELECT model_run_id, gateway_call_id, envelope_hash, source_refs_json
         FROM decisions WHERE id = ?`
      )
      .get(id) as Record<string, unknown>;
    expect(row).toMatchObject({
      model_run_id: 'mr-1',
      gateway_call_id: 'gw-1',
      envelope_hash: 'env-1',
    });
    expect(JSON.parse(String(row.source_refs_json))).toEqual(['message:test-1']);
  });

  it('replaces an incorrect memory through the public action and preserves its history', async () => {
    const first = await saveVia('the old claim', ACCESS.scopes, 'op-correction-old');
    const oldId = String((first as { data: { id: string } }).data.id);
    const captured = await dispatch(
      {
        action: 'source.ingest',
        operationId: 'op-correction-source',
        input: { content: 'preserved original', source: { connector: 'conversation:test' } },
      },
      { access: ACCESS }
    );
    expect(captured.status).toBe('completed');
    const observationRef = String(
      (captured as { data: { observationRef: string } }).data.observationRef
    );
    const correctionInput = {
      topic: 'corrected_claim',
      kind: 'fact',
      summary: 'the original can be read',
      details: 'A source.read receipt proved the prior access claim false.',
      scopes: ACCESS.scopes,
      source: { package: 'mama-core', source_type: 'test' },
      replaces: [{ id: oldId, reason: 'the preserved source was read successfully' }],
      links: [
        { relation: 'refines', target: { kind: 'memory', id: oldId } },
        { relation: 'derived_from', target: { kind: 'observation', id: observationRef } },
      ],
    };
    const corrected = await dispatch(
      { action: 'memory.save', operationId: 'op-correction-new', input: correctionInput },
      { access: ACCESS }
    );
    expect(corrected.status).toBe('completed');
    const newId = String((corrected as { data: { id: string } }).data.id);
    expect(
      getAdapter().prepare('SELECT status, superseded_by FROM decisions WHERE id = ?').get(oldId)
    ).toMatchObject({ status: 'superseded', superseded_by: newId });
    expect(
      getAdapter()
        .prepare('SELECT edge_type FROM twin_edges WHERE subject_id = ? ORDER BY edge_type')
        .all(newId)
    ).toEqual([
      { edge_type: 'derived_from' },
      { edge_type: 'refines' },
      { edge_type: 'supersedes' },
    ]);

    const replay = await dispatch(
      { action: 'memory.save', operationId: 'op-correction-new', input: correctionInput },
      { access: ACCESS }
    );
    expect(replay.status).toBe('completed');
    expect((replay as { data: { id: string } }).data.id).toBe(newId);
    expect(
      getAdapter().prepare('SELECT COUNT(*) AS n FROM twin_edges WHERE subject_id = ?').get(newId)
    ).toEqual({ n: 3 });
  });

  it('refuses an inaccessible replacement without changing either memory', async () => {
    const first = await saveVia('private claim', ACCESS.scopes, 'op-private-old');
    const oldId = String((first as { data: { id: string } }).data.id);
    const anotherAccess = {
      ...ACCESS,
      principalId: 'another-principal',
      scopes: [{ kind: 'project' as const, id: 'another-scope' }],
    };
    const denied = await dispatch(
      {
        action: 'memory.save',
        operationId: 'op-private-correction',
        input: {
          topic: 'private_claim',
          kind: 'fact',
          summary: 'attempted correction',
          details: 'not visible to this principal',
          scopes: anotherAccess.scopes,
          source: { package: 'mama-core', source_type: 'test' },
          replaces: [{ id: oldId, reason: 'attempted correction' }],
        },
      },
      { access: anotherAccess }
    );
    expect(denied.status).toBe('failed');
    expect(
      getAdapter().prepare('SELECT status, superseded_by FROM decisions WHERE id = ?').get(oldId)
    ).toMatchObject({ status: 'active', superseded_by: null });
    expect(getAdapter().prepare('SELECT COUNT(*) AS n FROM decisions').get()).toEqual({ n: 1 });
  });

  it('denies a record scope outside the admitted access', async () => {
    const result = await dispatch(
      {
        action: 'memory.save',
        operationId: 'op-save-denied',
        input: {
          topic: 'denied',
          kind: 'decision',
          summary: 'outside',
          details: 'outside the admitted scope',
          scopes: [{ kind: 'project', id: 'scope-other' }],
          source: { package: 'mama-core', source_type: 'test' },
        },
      },
      { access: ACCESS }
    );

    expect(result.status).toBe('failed');
    expect((result as { error: { code: string } }).error.code).toBe('SCOPE_DENIED');
    expect(
      getAdapter().prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number }
    ).toEqual({ n: 0 });
  });

  it('replays the same operationId to the same record and conflicts on a changed payload', async () => {
    const input = {
      topic: 'idempotent_save',
      kind: 'decision',
      summary: 'same input replays',
      details: 'operationId is the command id',
      scopes: ACCESS.scopes,
      source: { package: 'mama-core', source_type: 'test' },
    };
    const first = await dispatch(
      { action: 'memory.save', operationId: 'op-save-retry', input },
      { access: ACCESS }
    );
    const retry = await dispatch(
      { action: 'memory.save', operationId: 'op-save-retry', input },
      { access: ACCESS }
    );
    expect(first.status).toBe('completed');
    expect(retry.status).toBe('completed');
    expect((retry as { data: { id: string } }).data.id).toBe(
      (first as { data: { id: string } }).data.id
    );
    expect(
      getAdapter().prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number }
    ).toEqual({ n: 1 });

    const conflict = await dispatch(
      {
        action: 'memory.save',
        operationId: 'op-save-retry',
        input: { ...input, summary: 'a different payload under the same operationId' },
      },
      { access: ACCESS }
    );
    expect(conflict.status).toBe('failed');
  });

  it('rejects malformed input before any write', async () => {
    const result = await dispatch(
      {
        action: 'memory.save',
        operationId: 'op-save-invalid',
        input: { kind: 'decision', summary: 'no topic' },
      },
      { access: ACCESS }
    );

    expect(result.status).toBe('failed');
    expect((result as { error: { kind: string } }).error.kind).toBe('invalid_input');
  });

  describe('Story M2: memory.search / memory.checkpoint.load through dispatch', () => {
    it('fills an empty-query search page after excluding recent tombstones in SQL', async () => {
      for (let i = 0; i < 3; i++) {
        await saveVia(`live-${i}`, ACCESS.scopes, `page-live-${i}`);
      }
      for (let i = 0; i < 3; i++) {
        await saveVia(`erased-${i}`, ACCESS.scopes, `page-erased-${i}`);
      }
      getAdapter()
        .prepare(
          "UPDATE decisions SET erased_at=200, created_at=200, topic='', decision='', summary=NULL WHERE topic LIKE 'topic-page-erased-%'"
        )
        .run();
      getAdapter()
        .prepare("UPDATE decisions SET created_at=100 WHERE topic LIKE 'topic-page-live-%'")
        .run();
      const result = await dispatch(
        { action: 'memory.search', input: { limit: 3 } },
        { access: ACCESS }
      );
      expect(result).toMatchObject({ status: 'completed', data: { count: 3 } });
      const data = (result as { data: { results: Array<{ summary: string }> } }).data;
      expect(data.results.map((r) => r.summary).sort()).toEqual(['live-0', 'live-1', 'live-2']);
      expect(
        await listDecisionsInAdapter(getAdapter(), { limit: 3, excludeErased: true })
      ).toHaveLength(3);
    });

    const OTHER_ACCESS = {
      ...ACCESS,
      scopes: [{ kind: 'project' as const, id: 'scope-other' }] as MemoryScopeRef[],
    };

    it('lists only records inside the admitted scopes when no query is given', async () => {
      await saveVia('visible scoped decision', ACCESS.scopes, 'op-search-list-1');
      await saveVia(
        'hidden other-scope decision',
        OTHER_ACCESS.scopes,
        'op-search-list-2',
        OTHER_ACCESS
      );

      const result = await dispatch(
        { action: 'memory.search', input: { limit: 10 } },
        { access: ACCESS }
      );

      expect(result.status).toBe('completed');
      const data = (result as { data: { results: Array<{ summary?: string }> } }).data;
      expect(data.results.map((row) => row.summary)).toEqual(['visible scoped decision']);
    });

    it('keeps the topic prefix on the no-query ledger read', async () => {
      // Measured 2026-09-11 00:49: an owner turn asked for eleven different
      // item keys with {topicPrefix, limit} and got the SAME result set every
      // time - the no-query branch listed recent records and dropped the
      // prefix, so the turn concluded the ledger could not answer per item.
      // A prefix read is a ledger lookup, not a similarity search.
      //
      // The host tool that carried this pin is deleted; the routing it pinned
      // is memory.search's own, so the pin belongs beside it. The reader half
      // is pinned separately in unit/list-decisions-topic-prefix.test.ts.
      await dispatch(
        {
          action: 'memory.save',
          operationId: 'op-prefix-a',
          input: {
            topic: 'item_0001 round two',
            kind: 'decision',
            summary: 'the first item moved',
            details: 'details',
            scopes: ACCESS.scopes,
            source: { package: 'mama-core', source_type: 'test' },
          },
        },
        { access: ACCESS }
      );
      await dispatch(
        {
          action: 'memory.save',
          operationId: 'op-prefix-b',
          input: {
            topic: 'item_0002 round one',
            kind: 'decision',
            summary: 'a different item moved',
            details: 'details',
            scopes: ACCESS.scopes,
            source: { package: 'mama-core', source_type: 'test' },
          },
        },
        { access: ACCESS }
      );

      const result = await dispatch(
        { action: 'memory.search', input: { topicPrefix: 'item_0001', limit: 30 } },
        { access: ACCESS }
      );

      expect(result.status).toBe('completed');
      const data = (result as { data: { results: Array<{ summary?: string }> } }).data;
      expect(data.results.map((row) => row.summary)).toEqual(['the first item moved']);
    });

    it('answers a query through the semantic search path under the same bound', async () => {
      await saveVia('deploys freeze over the holiday', ACCESS.scopes, 'op-search-query-1');
      await saveVia(
        'holiday deploy freeze elsewhere',
        OTHER_ACCESS.scopes,
        'op-search-query-2',
        OTHER_ACCESS
      );

      const result = await dispatch(
        { action: 'memory.search', input: { query: 'holiday deploy freeze', limit: 10 } },
        { access: ACCESS }
      );

      expect(result.status).toBe('completed');
      const data = result.data as { success?: boolean; results?: Array<{ decision?: string }> };
      expect(data.success).not.toBe(false);
      // A search row carries the text as `decision`; reading `summary` compared undefined values.
      const summaries = (data.results ?? []).map((row) => row.decision);
      // The in-scope record is found, so the other scope's absence is the bound, not an empty page.
      expect(summaries).toContain('deploys freeze over the holiday');
      expect(summaries).not.toContain('holiday deploy freeze elsewhere');
    });

    it('denies a requested scope outside the admitted access', async () => {
      const result = await dispatch(
        {
          action: 'memory.search',
          input: { limit: 5, scopes: [{ kind: 'project', id: 'scope-other' }] },
        },
        { access: ACCESS }
      );

      expect(result.status).toBe('failed');
      expect((result as { error: { code: string } }).error.code).toBe('SCOPE_DENIED');
    });

    it('reads a scope the grant admits for reading only, and refuses to write it', async () => {
      // The channel mirror: a run allowed to read a channel's raw events may
      // recall what was extracted from it. That is a READING grant — it rides
      // `readScopes`, which a read consults and a write never does. The rule
      // lived in the envelope enforcer's `readScopeMirror` option; it is the
      // access's own shape now, so it is pinned against the real actions.
      const mirrorScope = { kind: 'channel' as const, id: 'trello:board-alpha' };
      const readOnlyAccess = { ...ACCESS, readScopes: [mirrorScope] };

      await saveVia('a memory in the mirrored channel', [mirrorScope], 'op-mirror-seed', {
        ...ACCESS,
        scopes: [mirrorScope],
      });

      const read = await dispatch(
        { action: 'memory.search', input: { limit: 5, scopes: [mirrorScope] } },
        { access: readOnlyAccess }
      );
      expect(read.status).toBe('completed');

      const write = await dispatch(
        {
          action: 'memory.save',
          operationId: 'op-mirror-write',
          input: {
            kind: 'decision',
            topic: 'mirror_write',
            summary: 'a write into a read-only scope',
            details: 'must not bind',
            source: { package: 'mama-core', source_type: 'mama_save' },
            scopes: [mirrorScope],
          },
        },
        { access: readOnlyAccess }
      );
      expect(write.status).toBe('failed');
      expect((write as { error: { code: string } }).error.code).toBe('SCOPE_DENIED');
    });

    it('scrubs and narrows what a recall answers with', async () => {
      // memory.read:topic returned recallMemory's records verbatim; the scrub
      // and the narrowing lived in the standalone tool case that wrapped it, so
      // a caller naming the action got unredacted full records.
      await saveVia('a recalled record', ACCESS.scopes, 'op-recall-shape-1');

      const result = await dispatch(
        { action: 'memory.read:topic', input: { query: 'recalled record' } },
        { access: ACCESS }
      );

      expect(result.status).toBe('completed');
      const bundle = (result as { data: Record<string, unknown> }).data;
      expect(bundle).toHaveProperty('profile');
      expect(bundle).toHaveProperty('memories');
      expect(bundle).toHaveProperty('graph_context');
      // The narrowing: a recalled memory answers with these fields and no
      // others, so `details` never reaches the model through this surface.
      for (const memory of bundle.memories as Array<Record<string, unknown>>) {
        expect(Object.keys(memory).sort()).toEqual(
          Object.keys(memory)
            .filter((key) =>
              ['memoryId', 'topic', 'kind', 'summary', 'confidence', 'status'].includes(key)
            )
            .sort()
        );
      }
    });

    it('returns an honest empty page for a caller with no admitted scopes', async () => {
      await saveVia(
        'scoped record invisible to no-scope callers',
        ACCESS.scopes,
        'op-search-empty-1'
      );

      const result = await dispatch(
        { action: 'memory.search', input: { query: 'scoped record', limit: 10 } },
        { access: { ...ACCESS, scopes: [] } }
      );

      expect(result.status).toBe('completed');
      expect((result as { data: { results: unknown[] } }).data.results).toEqual([]);
    });

    it('loads the latest active checkpoint through the read action', async () => {
      await saveCheckpoint('resume the migration', ['catalog.ts'], 'finish M2');

      const result = await dispatch(
        { action: 'memory.checkpoint.load', input: {} },
        { access: ACCESS }
      );

      expect(result.status).toBe('completed');
      expect((result as { data: { summary?: string } }).data).toMatchObject({
        summary: 'resume the migration',
      });
    });

    it('rejects unknown properties before the read runs', async () => {
      const result = await dispatch(
        { action: 'memory.search', input: { query: 'x', bogus: 1 } },
        { access: ACCESS }
      );

      expect(result.status).toBe('failed');
      expect((result as { error: { kind: string } }).error.kind).toBe('invalid_input');
    });
  });

  describe('Story M3a: memory.read:topic through dispatch', () => {
    const OTHER_ACCESS = {
      ...ACCESS,
      scopes: [{ kind: 'project' as const, id: 'scope-other' }] as MemoryScopeRef[],
    };

    it('returns the topic bundle for a query under the admitted scopes', async () => {
      await saveVia('recall-visible scoped decision', ACCESS.scopes, 'op-recall-1');
      await saveVia(
        'recall-hidden other-scope decision',
        OTHER_ACCESS.scopes,
        'op-recall-2',
        OTHER_ACCESS
      );

      const result = await dispatch(
        { action: 'memory.read:topic', input: { query: 'recall-visible' } },
        { access: ACCESS }
      );

      expect(result.status).toBe('completed');
      const data = result.data as {
        profile?: unknown;
        memories?: Array<{ summary?: string }>;
      };
      // `search_meta` is not in the answer: the action narrows to the fields a
      // read may return, which is what the deleted host wrapper did and what
      // the agent has always received. recallMemory still reports it to a
      // direct caller (unit/memory-v2-recall-ranking.test.ts reads it there).
      expect(data.profile).toBeDefined();
      const summaries = (data.memories ?? []).map((row) => row.summary ?? '');
      expect(summaries).toContain('recall-visible scoped decision');
      expect(summaries).not.toContain('recall-hidden other-scope decision');
    });

    it('denies a requested scope outside the admitted access', async () => {
      const result = await dispatch(
        {
          action: 'memory.read:topic',
          input: { query: 'x', scopes: [{ kind: 'project', id: 'scope-other' }] },
        },
        { access: ACCESS }
      );

      expect(result.status).toBe('failed');
      expect((result as { error: { code: string } }).error.code).toBe('SCOPE_DENIED');
    });

    it('fails honestly for an empty query instead of listing the corpus', async () => {
      const result = await dispatch(
        { action: 'memory.read:topic', input: { query: '   ' } },
        { access: ACCESS }
      );

      expect(result.status).toBe('failed');
      expect((result as { error: { code: string } }).error.code).toBe('INVALID_INPUT');
    });
  });

  describe('Story M3b: memory.read:provenance through dispatch', () => {
    it('lists an observation once when both a source ref and a derived_from link name it', async () => {
      const observation = appendObservationVersion(getAdapter(), {
        source: 'source-test',
        sourceId: 'message-test',
        body: 'Original evidence',
        observedAt: Date.now(),
        contentHash: createHash('sha256').update('Original evidence').digest('hex'),
      });
      const access = { ...ACCESS, connectors: ['source-test'], connectorWideRead: ['source-test'] };
      const saved = await dispatch(
        {
          action: 'memory.save',
          operationId: 'op-dedupe-test',
          input: {
            topic: 'dedupe-test',
            kind: 'fact',
            summary: 'A supported claim',
            details: 'Evidence',
            source: { package: 'test-product', source_type: 'test' },
            links: [
              {
                relation: 'derived_from',
                target: { kind: 'observation', id: observation.observationId },
              },
            ],
          },
        },
        { access, session: { sourceRefs: [observation.observationId] } }
      );
      expect(saved.status).toBe('completed');
      const result = await dispatch(
        {
          action: 'memory.read:provenance',
          input: { memory_id: (saved.data as { id: string }).id },
        },
        { access }
      );
      expect(result.status).toBe('completed');
      expect((result.data as { events: unknown[] }).events).toEqual([
        expect.objectContaining({ eventIndexId: observation.observationId }),
      ]);
    });

    it('keeps resolving supports when one indexed body is unavailable, but throws for fatal reads', async () => {
      const observations = ['available-test', 'missing-test'].map((sourceId) =>
        appendObservationVersion(getAdapter(), {
          source: 'source-test',
          sourceId,
          observedAt: Date.now(),
          bodyLocation: { kind: 'raw', connectorName: 'source-test', revisionSourceId: sourceId },
          contentHash: createHash('sha256').update(sourceId).digest('hex'),
        })
      );
      const access = { ...ACCESS, connectors: ['source-test'], connectorWideRead: ['source-test'] };
      const saved = await saveVia(
        'External evidence',
        ACCESS.scopes,
        'op-external-provenance',
        access
      );
      const memoryId = (saved.data as { id: string }).id;
      getAdapter()
        .prepare('UPDATE decisions SET source_refs_json = ? WHERE id = ?')
        .run(
          JSON.stringify(observations.map((observation) => observation.observationId)),
          memoryId
        );
      const options = {
        scopes: ACCESS.scopes,
        connectors: ['source-test'],
        wideConnectors: ['source-test'],
      };
      const result = await resolveMemoryProvenanceLive(getAdapter(), memoryId, {
        ...options,
        readObservationBody: (ref) =>
          ref === observations[0]!.observationId
            ? 'Exact original'
            : { status: 'body_unavailable' as const },
      });
      expect(result).toMatchObject({
        status: 'partial',
        events: [{ eventIndexId: observations[0]!.observationId, excerpt: 'Exact original' }],
        unresolved: [{ eventIndexId: observations[1]!.observationId, reason: 'body_unavailable' }],
      });
      await expect(resolveMemoryProvenanceLive(getAdapter(), memoryId, options)).rejects.toThrow(
        'External observation body reader is required'
      );
      for (const reason of ['HASH_MISMATCH', 'stored_source_out_of_scope']) {
        await expect(
          resolveMemoryProvenanceLive(getAdapter(), memoryId, {
            ...options,
            readObservationBody: () => {
              throw new Error(reason);
            },
          })
        ).rejects.toThrow(reason);
      }
    });

    it('resolves the owner-readable observation edges and scheduled cause of a new memory', async () => {
      const content = 'A preserved Chatwork correction was checked before the memory was saved';
      const observation = appendObservationVersion(getAdapter(), {
        source: 'chatwork',
        sourceId: 'room-1:message-1',
        body: content,
        channel: 'room-1',
        sourceAt: Date.now(),
        observedAt: Date.now(),
        contentHash: createHash('sha256').update(content).digest('hex'),
      });
      const inputId = 'owner-stimulus:cron:review-1';
      new Mailbox(getAdapter()).enqueue({
        id: inputId,
        kind: 'scheduled',
        principalId: ACCESS.principalId,
        channelKey: 'cron',
        occurredAt: Date.now(),
      });
      const ownerAccess = {
        ...ACCESS,
        connectors: ['chatwork'],
        connectorWideRead: ['chatwork'],
        projectRefs: [{ kind: 'project' as const, id: 'scope-test' }],
      };
      const saved = await dispatch(
        {
          action: 'memory.save',
          operationId: 'op-owner-provenance-edges',
          input: {
            topic: 'chatwork-correction',
            kind: 'fact',
            summary: 'The correction happened',
            details: 'The original was read and compared with the prior claim.',
            scopes: ACCESS.scopes,
            source: { package: 'mama-core', source_type: 'test' },
            links: [
              {
                relation: 'derived_from',
                target: { kind: 'observation', id: observation.observationId },
              },
            ],
          },
        },
        { access: ownerAccess, session: { sourceRefs: [`message:${inputId}`] } }
      );
      expect(saved.status).toBe('completed');
      const memoryId = String((saved as { data: { id: string } }).data.id);

      const provenance = await dispatch(
        { action: 'memory.read:provenance', input: { memory_id: memoryId } },
        { access: ownerAccess }
      );
      expect(provenance.status).toBe('completed');
      expect(provenance.data).toMatchObject({
        status: 'resolved',
        events: [{ connector: 'chatwork', eventIndexId: observation.observationId }],
        supports: [{ kind: 'message', id: inputId }],
      });

      const withoutWideRead = await dispatch(
        { action: 'memory.read:provenance', input: { memory_id: memoryId } },
        { access: { ...ownerAccess, connectorWideRead: [] } }
      );
      expect(withoutWideRead.status).toBe('completed');
      expect((withoutWideRead.data as { events: unknown[] }).events).toEqual([]);

      const member = await dispatch(
        { action: 'memory.read:provenance', input: { memory_id: memoryId } },
        {
          access: {
            ...ownerAccess,
            principalId: 'another-principal',
            connectorWideRead: [],
            channels: { chatwork: ['room-1'] },
            tenantId: 'member-tenant',
          },
        }
      );
      expect(member.status).toBe('completed');
      expect(member.data).toMatchObject({
        events: [{ connector: 'chatwork', eventIndexId: observation.observationId }],
        supports: [],
      });
      const otherChannel = await dispatch(
        { action: 'memory.read:provenance', input: { memory_id: memoryId } },
        {
          access: {
            ...ownerAccess,
            principalId: 'another-principal',
            connectorWideRead: [],
            channels: { chatwork: ['another-room'] },
            tenantId: 'member-tenant',
          },
        }
      );
      expect((otherChannel.data as { events: unknown[] }).events).toEqual([]);
    });

    it('resolves a saved record under the admitted scopes and fails closed without a readAllowance', async () => {
      const saved = await saveVia('provenance-visible record', ACCESS.scopes, 'op-prov-1');
      const memoryId = (saved as { data: { id: string } }).data.id;

      const result = await dispatch(
        { action: 'memory.read:provenance', input: { memory_id: memoryId } },
        { access: ACCESS }
      );

      expect(result.status).toBe('completed');
      // No readAllowance means no connector grant: the citation answers what it
      // can (the record exists) while raw events stay invisible - never all.
      const data = result.data as { memoryId?: string; events?: unknown[] };
      expect(data.memoryId).toBe(memoryId);
      expect(data.events ?? []).toEqual([]);
    });

    it('denies a requested scope outside the admitted access', async () => {
      const result = await dispatch(
        {
          action: 'memory.read:provenance',
          input: { memory_id: 'mem_x', scopes: [{ kind: 'project', id: 'scope-other' }] },
        },
        { access: ACCESS }
      );

      expect(result.status).toBe('failed');
      expect((result as { error: { code: string } }).error.code).toBe('SCOPE_DENIED');
    });

    it('fails honestly for an empty memory_id', async () => {
      const result = await dispatch(
        { action: 'memory.read:provenance', input: { memory_id: '  ' } },
        { access: ACCESS }
      );

      expect(result.status).toBe('failed');
      // The contract refuses it now, before exec: memory_id is pattern \S.
      expect((result as { error: { kind: string } }).error.kind).toBe('invalid_input');
    });
  });

  describe('Story M4: memory.update / memory.checkpoint.save through dispatch', () => {
    it('appends an outcome amendment and moves the maintained projection', async () => {
      const saved = await saveVia('outcome-target record', ACCESS.scopes, 'op-upd-1');
      const memoryId = (saved as { data: { id: string } }).data.id;

      const updated = await dispatch(
        {
          action: 'memory.update',
          input: { id: memoryId, outcome: 'failed', failure_reason: 'missed the freeze' },
        },
        { access: ACCESS }
      );

      expect(updated.status).toBe('completed');
      expect(updated.data).toMatchObject({ id: memoryId, outcome: 'FAILED' });
      const row = getAdapter()
        .prepare('SELECT outcome, failure_reason FROM decisions WHERE id = ?')
        .get(memoryId) as { outcome: string; failure_reason: string } | undefined;
      expect(row?.outcome).toBe('FAILED');
      expect(row?.failure_reason).toBe('missed the freeze');
    });

    it('rejects an outcome outside the enum and a missing id', async () => {
      const badOutcome = await dispatch(
        { action: 'memory.update', input: { id: 'mem_x', outcome: 'maybe' } },
        { access: ACCESS }
      );
      expect(badOutcome.status).toBe('failed');
      expect((badOutcome as { error: { code: string } }).error.code).toBe('INVALID_INPUT');

      const missingId = await dispatch(
        { action: 'memory.update', input: { outcome: 'success' } },
        { access: ACCESS }
      );
      expect(missingId.status).toBe('failed');
      expect((missingId as { error: { kind: string } }).error.kind).toBe('invalid_input');
    });

    it('writes a checkpoint row that memory.checkpoint.load reads back', async () => {
      const saved = await dispatch(
        {
          action: 'memory.checkpoint.save',
          input: {
            summary: 'Goal: finish the action surface',
            open_files: ['catalog.ts'],
            next_steps: 'convert mcp-server',
          },
        },
        { access: ACCESS }
      );

      expect(saved.status).toBe('completed');
      const { id } = saved.data as { id: string };
      expect(id.length).toBeGreaterThan(0);

      const loaded = await dispatch(
        { action: 'memory.checkpoint.load', input: {} },
        { access: ACCESS }
      );
      expect(loaded.status).toBe('completed');
      expect(loaded.data).toMatchObject({
        summary: 'Goal: finish the action surface',
        next_steps: 'convert mcp-server',
      });
    });

    it('refuses a blank summary rather than storing an empty hand-off', async () => {
      const result = await dispatch(
        { action: 'memory.checkpoint.save', input: { summary: '   ' } },
        { access: ACCESS }
      );

      expect(result.status).toBe('failed');
      expect((result as { error: { code: string } }).error.code).toBe('INVALID_INPUT');
      const count = getAdapter().prepare('SELECT COUNT(*) AS n FROM checkpoints').get() as {
        n: number;
      };
      expect(count.n).toBe(0);
    });
  });
});

describe('Story M5: source.ingest through the unified action path', () => {
  let dbPath = '';
  let knowledge: Knowledge;
  let dispatch: ActionDispatcher;

  beforeAll(async () => {
    dbPath = await initTestDB('source-ingest-actions');
    knowledge = createKnowledge({ adapter: getAdapter(), embedder: null });
    dispatch = createDispatcher(createCatalog(coreActionRegistrations(knowledge, getAdapter())));
  });

  beforeEach(() => {
    const db = getAdapter();
    db.prepare('DELETE FROM source_commands').run();
    db.prepare('DELETE FROM command_bindings').run();
    db.prepare('DELETE FROM observation_versions').run();
    db.prepare('DELETE FROM memory_events').run();
    db.prepare('DELETE FROM memory_scope_bindings').run();
    db.prepare('DELETE FROM memory_scopes').run();
  });

  afterAll(async () => cleanupTestDB(dbPath));

  it('stores one observation for a whole conversation and replays on retransmission', async () => {
    const input = {
      messages: [
        { role: 'user', content: 'ship on Friday?' },
        { role: 'assistant', content: 'yes, after the freeze lifts' },
      ],
      source: { connector: 'conversation:mcp_ingest_conversation' },
      session_date: '2026-09-10',
    };

    const first = await dispatch(
      { action: 'source.ingest', operationId: 'op-ingest-1', input },
      { access: ACCESS }
    );
    expect(first.status).toBe('completed');
    const receipt = first.data as {
      commandId: string;
      observationId: string;
      observationRef: string;
    };
    expect(receipt.commandId).toBe('op-ingest-1');
    expect(receipt.observationRef).toBe(receipt.observationId);

    // The same call retransmitted replays the receipt — one call is one observation.
    const replay = await dispatch(
      { action: 'source.ingest', operationId: 'op-ingest-1', input },
      { access: ACCESS }
    );
    expect(replay.status).toBe('completed');
    expect((replay.data as { observationId: string }).observationId).toBe(receipt.observationId);

    const count = getAdapter().prepare('SELECT COUNT(*) AS n FROM observation_versions').get() as {
      n: number;
    };
    expect(count.n).toBe(1);
  });

  it('fails closed when the same command id carries a different payload', async () => {
    const first = await dispatch(
      {
        action: 'source.ingest',
        operationId: 'op-ingest-2',
        input: { content: 'original body' },
      },
      { access: ACCESS }
    );
    expect(first.status).toBe('completed');

    const conflict = await dispatch(
      {
        action: 'source.ingest',
        operationId: 'op-ingest-2',
        input: { content: 'a different body under the same command id' },
      },
      { access: ACCESS }
    );
    expect(conflict.status).toBe('failed');
    expect((conflict as { error: { code: string } }).error.code).toBe('COMMAND_CONFLICT');
  });

  it('requires exactly one of content or messages and a parseable session_date', async () => {
    const neither = await dispatch(
      { action: 'source.ingest', operationId: 'op-ingest-3', input: {} },
      { access: ACCESS }
    );
    expect(neither.status).toBe('failed');
    expect((neither as { error: { code: string } }).error.code).toBe('INVALID_INPUT');

    const both = await dispatch(
      {
        action: 'source.ingest',
        operationId: 'op-ingest-4',
        input: { content: 'x', messages: [{ role: 'user', content: 'y' }] },
      },
      { access: ACCESS }
    );
    expect(both.status).toBe('failed');
    expect((both as { error: { code: string } }).error.code).toBe('INVALID_INPUT');

    const badDate = await dispatch(
      {
        action: 'source.ingest',
        operationId: 'op-ingest-5',
        input: { content: 'x', session_date: 'not-a-date' },
      },
      { access: ACCESS }
    );
    expect(badDate.status).toBe('failed');
    expect((badDate as { error: { code: string } }).error.code).toBe('INVALID_INPUT');
  });
});

describe('memory.read:experience through the unified action path', () => {
  let dbPath = '';
  let dispatch: ActionDispatcher;

  const OWNER_ACCESS = {
    actions: ['memory.read:experience'],
    principalId: 'owner:runtime',
    agentId: 'agent-test',
    scopes: [{ kind: 'project' as const, id: 'proj-exp' }] as MemoryScopeRef[],
  };
  // The run this read answers to. The host states it; the action never derives
  // it from the caller's memory scopes.
  const OWNER_SESSION = {
    runEvidenceScope: { ownerScope: 'owner:runtime', projectId: 'proj-exp' },
  };
  const MEMBER_SESSION = {
    runEvidenceScope: { ownerScope: 'member:m', projectId: 'proj-exp', channelId: 'ch-1' },
  };
  const MEMBER_ACCESS = {
    actions: ['memory.read:experience'],
    principalId: 'member:m',
    agentId: 'agent-test',
    scopes: [
      { kind: 'project' as const, id: 'proj-exp' },
      { kind: 'channel' as const, id: 'ch-1' },
    ] as MemoryScopeRef[],
  };

  beforeAll(async () => {
    dbPath = await initTestDB('experience-read-actions');
    const knowledge = createKnowledge({ adapter: getAdapter(), embedder: null });
    dispatch = createDispatcher(createCatalog(coreActionRegistrations(knowledge, getAdapter())));
  });

  beforeEach(() => {
    getAdapter().prepare('DELETE FROM tool_traces').run();
  });

  afterAll(async () => cleanupTestDB(dbPath));

  const seedTrace = (overrides: Record<string, unknown> = {}) =>
    appendOperationToolTrace(getAdapter(), {
      operation_id: `op-${Math.random().toString(36).slice(2, 10)}`,
      actor_principal_id: 'owner:runtime',
      tool_name: 'code_act',
      execution_status: 'completed',
      owner_scope: 'owner:runtime',
      project_id: 'proj-exp',
      created_at: 1_700_000_000_000 + Math.floor(Math.random() * 1000),
      ...overrides,
    });

  it('lists only the caller-scoped traces and pages them honestly', async () => {
    seedTrace({ tool_name: 'code_act' });
    seedTrace({ tool_name: 'tool_search' });
    seedTrace({ project_id: 'proj-other' });
    seedTrace({ owner_scope: 'member:other' });

    const page = await dispatch(
      { action: 'memory.read:experience', input: {} },
      { access: OWNER_ACCESS, session: OWNER_SESSION }
    );
    expect(page.status).toBe('completed');
    const data = (page as { data: { traces: Array<{ tool_name: string }>; next_cursor: unknown } })
      .data;
    expect(data.traces.map((row) => row.tool_name).sort()).toEqual(['code_act', 'tool_search']);
    expect(data.next_cursor).toBeNull();
    // List rows carry the field nulled — evidence bodies only move through explicit trace reads.
    expect(data.traces[0].evidence_json).toBeNull();
  });

  it('reads one trace as bounded content under the same scope', async () => {
    const evidence = JSON.stringify({ input: { code: 'tool_search({})' }, result: { ok: true } });
    const seeded = seedTrace({ evidence_json: evidence });
    const outside = seedTrace({ project_id: 'proj-other', evidence_json: evidence });

    const read = await dispatch(
      { action: 'memory.read:experience', input: { trace_id: seeded.trace_id, chars: 10 } },
      { access: OWNER_ACCESS, session: OWNER_SESSION }
    );
    expect(read.status).toBe('completed');
    const data = (
      read as {
        data: {
          trace: { evidence_json: unknown };
          content: string;
          total_chars: number;
          next_offset: number | null;
        };
      }
    ).data;
    expect(data.trace.evidence_json).toBeNull();
    expect(data.content).toBe(evidence.slice(0, 10));
    expect(data.total_chars).toBe(evidence.length);
    expect(data.next_offset).toBe(10);

    // A trace id is not a capability: an out-of-scope id is just absent.
    const denied = await dispatch(
      { action: 'memory.read:experience', input: { trace_id: outside.trace_id } },
      { access: OWNER_ACCESS, session: OWNER_SESSION }
    );
    expect(denied.status).toBe('failed');
    expect((denied as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('fails closed when the host states no run evidence for the call', async () => {
    // "no or ambiguous admitted project scope" stood here, asked of `access`.
    // The caller's memory scopes are not this read's authority any more: the run
    // is, and a host that cannot name the run says nothing rather than one of
    // several projects.
    const unattributed = await dispatch(
      { action: 'memory.read:experience', input: {} },
      { access: OWNER_ACCESS }
    );
    expect(unattributed.status).toBe('failed');
    expect((unattributed as { error: { code: string } }).error.code).toBe('SCOPE_DENIED');
  });

  it('requires a member read to carry its channel and binds it exactly', async () => {
    seedTrace({ owner_scope: 'member:m', channel_id: 'ch-1', tool_name: 'code_act' });
    seedTrace({ owner_scope: 'member:m', channel_id: 'ch-2', tool_name: 'tool_search' });

    const noChannel = await dispatch(
      { action: 'memory.read:experience', input: {} },
      {
        access: MEMBER_ACCESS,
        session: { runEvidenceScope: { ownerScope: 'member:m', projectId: 'proj-exp' } },
      }
    );
    expect(noChannel.status).toBe('failed');
    expect((noChannel as { error: { code: string } }).error.code).toBe('SCOPE_DENIED');

    const memberPage = await dispatch(
      { action: 'memory.read:experience', input: {} },
      { access: MEMBER_ACCESS, session: MEMBER_SESSION }
    );
    expect(memberPage.status).toBe('completed');
    const data = (memberPage as { data: { traces: Array<{ tool_name: string }> } }).data;
    expect(data.traces.map((row) => row.tool_name)).toEqual(['code_act']);
  });

  it('rejects caller-supplied scope fields and out-of-bound read windows', async () => {
    const widened = await dispatch(
      {
        action: 'memory.read:experience',
        input: { owner_scope: 'owner:runtime' },
      },
      { access: OWNER_ACCESS, session: OWNER_SESSION }
    );
    expect(widened.status).toBe('failed');
    expect((widened as { error: { kind: string } }).error.kind).toBe('invalid_input');

    const unbounded = await dispatch(
      { action: 'memory.read:experience', input: { trace_id: 'tr_x', chars: 9000 } },
      { access: OWNER_ACCESS, session: OWNER_SESSION }
    );
    expect(unbounded.status).toBe('failed');
    expect((unbounded as { error: { code: string } }).error.code).toBe('INVALID_INPUT');
  });
});
