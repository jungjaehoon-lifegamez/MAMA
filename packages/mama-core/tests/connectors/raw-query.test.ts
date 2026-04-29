import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getAdapter } from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import { upsertConnectorEventIndex } from '../../src/connectors/event-index.js';
import { searchAllRaw, searchRaw } from '../../src/connectors/raw-query.js';

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
});
