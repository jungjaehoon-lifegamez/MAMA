import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getAdapter } from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import {
  connectorEventIndexId,
  upsertConnectorEventIndex,
} from '../../src/connectors/event-index.js';
import {
  getRawById,
  getRawHistory,
  getRawWindow,
  searchAllRaw,
  searchRaw,
} from '../../src/connectors/raw-query.js';

const KOREAN_RISK_TOKEN = '\ud504\ub85c\uc81d\ud2b8\uc704\ud5d8';
const KOREAN_MEETING_TEXT = `${KOREAN_RISK_TOKEN} \uc77c\uc815 \uc870\uc815 \ud68c\uc758\ub85d`;
const JAPANESE_RISK_TOKEN = '\u30ea\u30ea\u30fc\u30b9\u5371\u967a';
const JAPANESE_MEETING_TEXT = `${JAPANESE_RISK_TOKEN} \u3092\u78ba\u8a8d\u3059\u308b\u8b70\u4e8b\u9332`;

function seedRawEvent(overrides: {
  connector?: string;
  sourceId: string;
  channel?: string;
  author?: string;
  content: string;
  timestampMs: number;
  observedAt?: number;
  scopeKind?: string | null;
  scopeId?: string | null;
  metadata?: Record<string, unknown>;
}): void {
  upsertConnectorEventIndex(getAdapter(), {
    source_connector: overrides.connector ?? 'slack',
    source_type: 'message',
    source_id: overrides.sourceId,
    source_locator: `${overrides.connector ?? 'slack'}:${overrides.channel ?? 'general'}:${overrides.sourceId}`,
    channel: overrides.channel ?? 'general',
    author: overrides.author ?? 'alice',
    content: overrides.content,
    event_datetime: overrides.timestampMs,
    source_timestamp_ms: overrides.timestampMs,
    memory_scope_kind: overrides.scopeKind ?? 'project',
    memory_scope_id: overrides.scopeId ?? 'alpha',
    metadata: overrides.metadata ?? { seeded: true },
    observation: { observed_at: overrides.observedAt ?? overrides.timestampMs },
  });
}

describe('Story M4: Raw unified search over connector_event_index', () => {
  let testDbPath = '';

  beforeAll(async () => {
    testDbPath = await initTestDB('raw-query');
  });

  beforeEach(() => {
    const adapter = getAdapter();
    adapter.prepare('DELETE FROM connector_event_index_cursors').run();
    adapter.prepare('DELETE FROM connector_event_index').run();
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  it('TG-03 returns a compact search hit then the complete scoped source on explicit detail access', () => {
    const content = `deepraw ${'source detail '.repeat(80)}END OF ORIGINAL`;
    seedRawEvent({ sourceId: 'long-document', content, timestampMs: Date.now() });
    const visibility = {
      connectors: ['slack'],
      scopes: [{ kind: 'project' as const, id: 'alpha' }],
    };
    const hit = searchAllRaw(getAdapter(), { query: 'deepraw', ...visibility }).hits[0]!;
    expect(hit.content_preview.length).toBeLessThanOrEqual(240);
    expect(hit).not.toHaveProperty('content');
    expect(getRawById(getAdapter(), hit.raw_id, visibility)).toMatchObject({
      content,
      source_at: hit.source_at,
      observed_at: hit.observed_at,
    });
    expect(
      getRawById(getAdapter(), hit.raw_id, {
        ...visibility,
        scopes: [{ kind: 'project', id: 'other' }],
      })
    ).toBeNull();
  });

  describe('AC #1: raw.search searches one connector through FTS', () => {
    it('returns Korean and Japanese FTS hits with raw hit fields', () => {
      const koreanTime = Date.parse('2026-04-20T10:00:00.000Z');
      const japaneseTime = Date.parse('2026-04-20T09:00:00.000Z');
      seedRawEvent({
        sourceId: 'slack-ko',
        content: KOREAN_MEETING_TEXT,
        timestampMs: koreanTime,
        metadata: { language: 'ko' },
      });
      seedRawEvent({
        sourceId: 'slack-ja',
        content: JAPANESE_MEETING_TEXT,
        timestampMs: japaneseTime,
        metadata: { language: 'ja' },
      });

      const korean = searchRaw(getAdapter(), {
        query: KOREAN_RISK_TOKEN,
        connectors: ['slack'],
        limit: 5,
      });
      const japanese = searchRaw(getAdapter(), {
        query: JAPANESE_RISK_TOKEN,
        connectors: ['slack'],
        limit: 5,
      });

      expect(korean.hits).toHaveLength(1);
      expect(korean.hits[0]).toMatchObject({
        connector: 'slack',
        source_id: 'slack-ko',
        channel_id: 'general',
        author_label: 'alice',
        created_at: new Date(koreanTime).toISOString(),
        source_at: new Date(koreanTime).toISOString(),
        observed_at: new Date(koreanTime).toISOString(),
        metadata: { language: 'ko' },
      });
      expect(korean.hits[0]?.content_preview).toContain(KOREAN_RISK_TOKEN);
      expect(korean.hits[0]?.score).toBeGreaterThan(0);
      expect(korean.next_cursor).toBeNull();

      expect(japanese.hits).toHaveLength(1);
      expect(japanese.hits[0]?.source_id).toBe('slack-ja');
    });

    it('treats FTS query syntax as literal content', () => {
      seedRawEvent({
        sourceId: 'literal-special-syntax',
        content: 'owner:alice escalation note',
        timestampMs: Date.parse('2026-04-20T10:00:00.000Z'),
      });

      expect(() =>
        searchRaw(getAdapter(), {
          query: 'owner:alice',
          connectors: ['slack'],
          limit: 5,
        })
      ).not.toThrow();

      const results = searchRaw(getAdapter(), {
        query: 'owner:alice',
        connectors: ['slack'],
        limit: 5,
      });

      expect(results.hits.map((hit) => hit.source_id)).toEqual(['literal-special-syntax']);
    });
  });

  describe('AC #2: raw.searchAll merges connector results with stable cursors', () => {
    it('sorts multi-connector hits by score then recency and resumes after the cursor', () => {
      seedRawEvent({
        connector: 'slack',
        sourceId: 'slack-newer',
        content: 'needle shared term',
        timestampMs: Date.parse('2026-04-20T12:00:00.000Z'),
      });
      seedRawEvent({
        connector: 'discord',
        sourceId: 'discord-older',
        content: 'needle shared term',
        timestampMs: Date.parse('2026-04-20T11:00:00.000Z'),
      });
      seedRawEvent({
        connector: 'notion',
        sourceId: 'notion-strong',
        content: 'needle needle needle shared term',
        timestampMs: Date.parse('2026-04-20T10:00:00.000Z'),
      });

      const firstPage = searchAllRaw(getAdapter(), {
        query: 'needle',
        connectors: ['slack', 'discord', 'notion'],
        limit: 2,
      });

      expect(firstPage.hits.map((hit) => hit.source_id)).toEqual(['notion-strong', 'slack-newer']);
      expect(firstPage.next_cursor).toEqual(expect.any(String));

      const secondPage = searchAllRaw(getAdapter(), {
        query: 'needle',
        connectors: ['slack', 'discord', 'notion'],
        cursor: firstPage.next_cursor ?? undefined,
        limit: 2,
      });

      expect(secondPage.hits.map((hit) => hit.source_id)).toEqual(['discord-older']);
      expect(secondPage.next_cursor).toBeNull();
    });

    it('uses current observation capture time for recency while preserving source time', () => {
      seedRawEvent({
        connector: 'slack',
        sourceId: 'old-source-new-capture',
        content: 'captureorder shared',
        timestampMs: 100,
        observedAt: 5_000,
      });
      seedRawEvent({
        connector: 'slack',
        sourceId: 'new-source-old-capture',
        content: 'captureorder shared',
        timestampMs: 4_000,
        observedAt: 4_500,
      });

      const result = searchAllRaw(getAdapter(), {
        query: 'captureorder',
        connectors: ['slack'],
        fromMs: 4_400,
        toMs: 5_100,
      });

      expect(result.hits.map((hit) => hit.source_id)).toEqual([
        'old-source-new-capture',
        'new-source-old-capture',
      ]);
      expect(result.hits[0]).toMatchObject({
        created_at: new Date(5_000).toISOString(),
        source_at: new Date(100).toISOString(),
        observed_at: new Date(5_000).toISOString(),
      });

      const targetId = connectorEventIndexId('slack', 'new-source-old-capture');
      const window = getRawWindow(getAdapter(), targetId, {
        connectors: ['slack'],
        scopes: [{ kind: 'project', id: 'alpha' }],
        before: 1,
        after: 1,
      });
      expect(window?.items.map((item) => item.source_id)).toEqual([
        'new-source-old-capture',
        'old-source-new-capture',
      ]);
    });
  });

  describe('AC #3: connector, scope, time, and cursor filters happen before LIMIT', () => {
    it('does not lose in-scope rows behind earlier out-of-scope rows', () => {
      for (let i = 0; i < 8; i += 1) {
        seedRawEvent({
          sourceId: `out-${i}`,
          content: 'limitneedle out of scope',
          timestampMs: Date.parse('2026-04-20T12:00:00.000Z') - i,
          scopeKind: 'project',
          scopeId: 'other',
        });
      }
      seedRawEvent({
        sourceId: 'in-scope',
        content: 'limitneedle in scope',
        timestampMs: Date.parse('2026-04-20T10:00:00.000Z'),
        scopeKind: 'project',
        scopeId: 'alpha',
      });

      const results = searchAllRaw(getAdapter(), {
        query: 'limitneedle',
        connectors: ['slack'],
        scopes: [{ kind: 'project', id: 'alpha' }],
        limit: 1,
      });

      expect(results.hits.map((hit) => hit.source_id)).toEqual(['in-scope']);
    });

    it('rejects invalid scope kinds before building the SQL filter', () => {
      expect(() =>
        searchAllRaw(getAdapter(), {
          query: 'limitneedle',
          scopes: [{ kind: 'workspace' as never, id: 'alpha' }],
        })
      ).toThrow('Invalid raw search scope kind');
    });
  });

  describe("AC #4: getRawHistory returns an entity's revisions, grant-bounded and paged", () => {
    function seedRevision(o: {
      sourceId: string;
      entityId: string;
      content: string;
      timestampMs: number;
      connector?: string;
      scopeId?: string;
      observedAt?: number;
    }): void {
      upsertConnectorEventIndex(getAdapter(), {
        source_connector: o.connector ?? 'calendar',
        source_type: 'event',
        source_id: o.sourceId,
        source_entity_id: o.entityId,
        source_locator: `${o.connector ?? 'calendar'}:cal:${o.sourceId}`,
        channel: 'cal',
        author: 'org',
        content: o.content,
        event_datetime: o.timestampMs,
        source_timestamp_ms: o.timestampMs,
        memory_scope_kind: 'project',
        memory_scope_id: o.scopeId ?? 'alpha',
        observation: { observed_at: o.observedAt ?? o.timestampMs },
      });
    }

    it('returns only the entity revisions in order, excludes out-of-scope, and pages', () => {
      const t = Date.parse('2026-09-07T00:00:00.000Z');
      seedRevision({ sourceId: 'evt:v1', entityId: 'evt', content: 'A', timestampMs: t });
      seedRevision({ sourceId: 'evt:v2', entityId: 'evt', content: 'B', timestampMs: t + 1000 });
      seedRevision({ sourceId: 'evt:v3', entityId: 'evt', content: 'C', timestampMs: t + 2000 });
      seedRevision({ sourceId: 'other:v1', entityId: 'other', content: 'X', timestampMs: t + 500 });
      seedRevision({
        sourceId: 'evt:secret',
        entityId: 'evt',
        content: 'S',
        timestampMs: t + 1500,
        scopeId: 'beta',
      });

      const visibility = {
        connectors: ['calendar'],
        scopes: [{ kind: 'project' as const, id: 'alpha' }],
      };
      const p1 = getRawHistory(getAdapter(), { entityId: 'evt', ...visibility, limit: 2 });
      expect(p1.hits.map((h) => h.source_id)).toEqual(['evt:v1', 'evt:v2']);
      expect(p1.next_cursor).toEqual(expect.any(String));

      const p2 = getRawHistory(getAdapter(), {
        entityId: 'evt',
        ...visibility,
        limit: 2,
        cursor: p1.next_cursor ?? undefined,
      });
      expect(p2.hits.map((h) => h.source_id)).toEqual(['evt:v3']);
      expect(p2.next_cursor).toBeNull();

      const all = [...p1.hits, ...p2.hits].map((h) => h.source_id);
      expect(all).not.toContain('evt:secret');
      expect(all).not.toContain('other:v1');
    });

    it('resolves the entity from a visible rawId anchor', () => {
      const t = Date.parse('2026-09-07T00:00:00.000Z');
      seedRevision({ sourceId: 'evt:v1', entityId: 'evt', content: 'A', timestampMs: t });
      seedRevision({ sourceId: 'evt:v2', entityId: 'evt', content: 'B', timestampMs: t + 1000 });
      const anchorId = connectorEventIndexId('calendar', 'evt:v2');
      const res = getRawHistory(getAdapter(), {
        rawId: anchorId,
        connectors: ['calendar'],
        scopes: [{ kind: 'project', id: 'alpha' }],
      });
      expect(res.hits.map((h) => h.source_id)).toEqual(['evt:v1', 'evt:v2']);
    });

    it('pages history by observation capture time and retains source occurrence time', () => {
      seedRevision({
        sourceId: 'evt:v1',
        entityId: 'evt',
        content: 'A',
        timestampMs: 4_000,
        observedAt: 5_000,
      });
      seedRevision({
        sourceId: 'evt:v2',
        entityId: 'evt',
        content: 'B',
        timestampMs: 100,
        observedAt: 6_000,
      });
      const visibility = {
        connectors: ['calendar'],
        scopes: [{ kind: 'project' as const, id: 'alpha' }],
      };

      const first = getRawHistory(getAdapter(), {
        entityId: 'evt',
        ...visibility,
        fromMs: 4_900,
        limit: 1,
      });
      const second = getRawHistory(getAdapter(), {
        entityId: 'evt',
        ...visibility,
        fromMs: 4_900,
        limit: 1,
        cursor: first.next_cursor ?? undefined,
      });

      expect(first.hits.map((hit) => hit.source_id)).toEqual(['evt:v1']);
      expect(second.hits.map((hit) => hit.source_id)).toEqual(['evt:v2']);
      expect(second.hits[0]).toMatchObject({
        source_at: new Date(100).toISOString(),
        observed_at: new Date(6_000).toISOString(),
      });
    });

    it('returns nothing for a rawId anchor the caller may not see', () => {
      const t = Date.parse('2026-09-07T00:00:00.000Z');
      seedRevision({
        sourceId: 'evt:v1',
        entityId: 'evt',
        content: 'A',
        timestampMs: t,
        scopeId: 'beta',
      });
      const anchorId = connectorEventIndexId('calendar', 'evt:v1');
      const res = getRawHistory(getAdapter(), {
        rawId: anchorId,
        connectors: ['calendar'],
        scopes: [{ kind: 'project', id: 'alpha' }],
      });
      expect(res.hits).toEqual([]);
    });
  });
});
