import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RawStore } from '../../../src/connectors/framework/raw-store.js';
import type { NormalizedItem } from '../../../src/connectors/framework/types.js';

function makeItem(overrides: Partial<NormalizedItem> = {}): NormalizedItem {
  return {
    source: 'slack',
    sourceId: `msg-${Math.random().toString(36).slice(2)}`,
    channel: 'general',
    author: 'alice',
    content: 'hello world',
    timestamp: new Date('2026-04-07T10:00:00Z'),
    type: 'message',
    ...overrides,
  };
}

describe('RawStore', () => {
  let tmpDir: string;
  let store: RawStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raw-store-test-'));
    store = new RawStore(tmpDir);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('save and query', () => {
    it('saves items and retrieves them', () => {
      const item = makeItem({ timestamp: new Date('2026-04-07T10:00:00Z') });
      store.save('slack', [item]);

      const results = store.query('slack', new Date('2026-04-07T00:00:00Z'));
      expect(results).toHaveLength(1);
      expect(results[0]?.sourceId).toBe(item.sourceId);
      expect(results[0]?.content).toBe('hello world');
      expect(results[0]?.type).toBe('message');
    });

    it('saves items with metadata', () => {
      const item = makeItem({
        metadata: { threadId: 'T001', reactions: ['👍'] },
      });
      store.save('slack', [item]);

      const results = store.query('slack', new Date(0));
      expect(results[0]?.metadata).toEqual({ threadId: 'T001', reactions: ['👍'] });
    });

    it('returns items ordered by timestamp ascending', () => {
      const t1 = new Date('2026-04-07T08:00:00Z');
      const t2 = new Date('2026-04-07T09:00:00Z');
      const t3 = new Date('2026-04-07T10:00:00Z');

      store.save('slack', [
        makeItem({ sourceId: 'c', timestamp: t3 }),
        makeItem({ sourceId: 'a', timestamp: t1 }),
        makeItem({ sourceId: 'b', timestamp: t2 }),
      ]);

      const results = store.query('slack', new Date(0));
      expect(results.map((r) => r.sourceId)).toEqual(['a', 'b', 'c']);
    });

    it('returns an empty array when no items match since filter', () => {
      store.save('slack', [makeItem({ timestamp: new Date('2026-04-07T10:00:00Z') })]);
      const results = store.query('slack', new Date('2026-04-07T11:00:00Z'));
      expect(results).toHaveLength(0);
    });

    it('handles empty items array without error', () => {
      expect(() => store.save('slack', [])).not.toThrow();
      expect(store.query('slack', new Date(0))).toHaveLength(0);
    });
  });

  describe('deduplication', () => {
    it('deduplicates items by sourceId (INSERT OR IGNORE)', () => {
      const item = makeItem({ sourceId: 'fixed-id', content: 'original' });
      const duplicate = makeItem({ sourceId: 'fixed-id', content: 'duplicate' });

      store.save('slack', [item]);
      store.save('slack', [duplicate]);

      const results = store.query('slack', new Date(0));
      expect(results).toHaveLength(1);
      expect(results[0]?.content).toBe('original');
    });

    it('saves only unique items in a single batch', () => {
      const item1 = makeItem({ sourceId: 'same-id', content: 'first' });
      const item2 = makeItem({ sourceId: 'same-id', content: 'second' });

      store.save('slack', [item1, item2]);

      const results = store.query('slack', new Date(0));
      expect(results).toHaveLength(1);
    });
  });

  describe('timestamp filtering', () => {
    it('includes items exactly at the since boundary', () => {
      const since = new Date('2026-04-07T10:00:00Z');
      store.save('slack', [makeItem({ sourceId: 'exact', timestamp: since })]);

      const results = store.query('slack', since);
      expect(results).toHaveLength(1);
    });

    it('excludes items before the since boundary', () => {
      const before = new Date('2026-04-07T09:59:59Z');
      const after = new Date('2026-04-07T10:00:01Z');
      store.save('slack', [
        makeItem({ sourceId: 'before', timestamp: before }),
        makeItem({ sourceId: 'after', timestamp: after }),
      ]);

      const results = store.query('slack', new Date('2026-04-07T10:00:00Z'));
      expect(results).toHaveLength(1);
      expect(results[0]?.sourceId).toBe('after');
    });
  });

  describe('separate DBs per connector', () => {
    it('keeps items isolated between connectors', () => {
      store.save('slack', [makeItem({ sourceId: 'slack-1', source: 'slack' })]);
      store.save('notion', [makeItem({ sourceId: 'notion-1', source: 'notion' })]);

      const slackResults = store.query('slack', new Date(0));
      const notionResults = store.query('notion', new Date(0));

      expect(slackResults).toHaveLength(1);
      expect(slackResults[0]?.source).toBe('slack');

      expect(notionResults).toHaveLength(1);
      expect(notionResults[0]?.source).toBe('notion');
    });

    it('creates separate db files per connector', () => {
      store.save('connA', [makeItem({ sourceId: 'a1' })]);
      store.save('connB', [makeItem({ sourceId: 'b1' })]);

      // No cross-contamination
      expect(store.query('connA', new Date(0))).toHaveLength(1);
      expect(store.query('connB', new Date(0))).toHaveLength(1);
      expect(store.query('connA', new Date(0))[0]?.sourceId).toBe('a1');
      expect(store.query('connB', new Date(0))[0]?.sourceId).toBe('b1');
    });
  });

  describe('timestamp round-trip', () => {
    it('stores and retrieves timestamps as Date objects', () => {
      const ts = new Date('2026-04-07T15:30:00.000Z');
      store.save('slack', [makeItem({ timestamp: ts })]);

      const results = store.query('slack', new Date(0));
      expect(results[0]?.timestamp).toBeInstanceOf(Date);
      expect(results[0]?.timestamp.getTime()).toBe(ts.getTime());
    });
  });
});
