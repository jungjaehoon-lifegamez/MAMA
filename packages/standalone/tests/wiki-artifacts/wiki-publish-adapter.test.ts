import { describe, expect, it, vi } from 'vitest';

process.env.MAMA_FORCE_TIER_3 ||= 'true';

import Database from '../../src/sqlite.js';
import { WikiArtifactStore } from '../../src/wiki-artifacts/wiki-artifact-store.js';
import { createWikiPublishAdapter } from '../../src/wiki-artifacts/wiki-publish-adapter.js';

describe('STORY-VNEXT-PR4-WIKI-ARTIFACTS: wiki publish adapter', () => {
  it('keeps legacy wiki_publish compatible while preserving supplied source IDs', () => {
    const publisher = vi.fn();
    const adapter = createWikiPublishAdapter({
      mode: 'legacy',
      publisher,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });

    const result = adapter.publish({
      pages: [
        {
          path: 'projects/api.md',
          title: 'API',
          type: 'entity',
          content: 'content',
          sourceIds: ['decision:d_1'],
        },
      ],
    });

    expect(result).toEqual({ pagesPublished: 1, artifactsStored: 0 });
    expect(publisher).toHaveBeenCalledWith([
      {
        path: 'projects/api.md',
        title: 'API',
        type: 'entity',
        content: 'content',
        sourceIds: ['decision:d_1'],
        sourceRefs: [],
        compiledAt: '2026-07-02T00:00:00.000Z',
        confidence: 'medium',
      },
    ]);
  });

  it('rejects vNext wiki_publish pages that do not carry source refs', () => {
    const db = new Database(':memory:');
    const store = new WikiArtifactStore(db);
    const adapter = createWikiPublishAdapter({ mode: 'vnext', store });

    expect(() =>
      adapter.publish({
        pages: [
          {
            path: 'projects/api.md',
            title: 'API',
            type: 'entity',
            content: 'content',
          },
        ],
      })
    ).toThrow(/source refs/i);

    db.close();
  });

  it('rejects vNext publishing when no artifact store is configured', () => {
    const publisher = vi.fn();
    const adapter = createWikiPublishAdapter({ mode: 'vnext', publisher });

    expect(() =>
      adapter.publish({
        pages: [
          {
            path: 'projects/api.md',
            title: 'API',
            type: 'entity',
            content: 'content',
            sourceRefs: [{ kind: 'raw', connector: 'slack', id: 'event-1' }],
          },
        ],
      })
    ).toThrow(/store not configured/i);
    expect(publisher).not.toHaveBeenCalled();
  });

  it('rejects malformed page fields before invoking the publisher', () => {
    const publisher = vi.fn();
    const adapter = createWikiPublishAdapter({ mode: 'legacy', publisher });

    expect(() =>
      adapter.publish({
        pages: [
          {
            path: '   ',
            title: 'API',
            type: 'entity',
            content: 'content',
            sourceIds: ['decision:d_1'],
          },
        ],
      })
    ).toThrow(/path must not be empty/i);
    expect(() =>
      adapter.publish({
        pages: [
          {
            path: 'projects/api.md',
            title: 'API',
            type: 'entity',
            content: 'content',
            sourceIds: ['   '],
          },
        ],
      })
    ).toThrow(/sourceIds/i);
    expect(publisher).not.toHaveBeenCalled();
  });

  it('rejects page paths that would escape the wiki directory', () => {
    const publisher = vi.fn();
    const adapter = createWikiPublishAdapter({ mode: 'legacy', publisher });

    for (const path of [
      '../outside.md',
      'projects/../index.md',
      'projects/../../outside.md',
      '/tmp/outside.md',
      'index.md',
      'log.md',
      './',
      'projects',
      'projects/',
      'lessons',
      'synthesis',
    ]) {
      expect(() =>
        adapter.publish({
          pages: [
            {
              path,
              title: 'API',
              type: 'entity',
              content: 'content',
              sourceIds: ['decision:d_1'],
            },
          ],
        })
      ).toThrow(/wiki directory|parent-directory|reserved wiki files|directories|directory/i);
    }
    expect(publisher).not.toHaveBeenCalled();
  });

  it('rejects unsupported explicit type and confidence values before invoking the publisher', () => {
    const publisher = vi.fn();
    const adapter = createWikiPublishAdapter({ mode: 'legacy', publisher });

    expect(() =>
      adapter.publish({
        pages: [
          {
            path: 'projects/api.md',
            title: 'API',
            type: 'not-a-type',
            content: 'content',
            sourceIds: ['decision:d_1'],
          },
        ],
      })
    ).toThrow(/type/i);
    expect(() =>
      adapter.publish({
        pages: [
          {
            path: 'projects/api.md',
            title: 'API',
            type: 'entity',
            content: 'content',
            confidence: 'certain',
            sourceIds: ['decision:d_1'],
          },
        ],
      })
    ).toThrow(/confidence/i);
    expect(publisher).not.toHaveBeenCalled();
  });

  it('rejects non-string page fields before invoking the publisher', () => {
    const publisher = vi.fn();
    const adapter = createWikiPublishAdapter({ mode: 'legacy', publisher });

    expect(() =>
      adapter.publish({
        pages: [
          {
            path: 123 as never,
            title: 'API',
            type: 'entity',
            content: 'content',
          },
        ],
      })
    ).toThrow(/path must be a string/i);
    expect(publisher).not.toHaveBeenCalled();
  });

  it('rejects oversized wiki_publish requests before invoking the publisher', () => {
    const publisher = vi.fn();
    const adapter = createWikiPublishAdapter({ mode: 'legacy', publisher });

    expect(() =>
      adapter.publish({
        pages: Array.from({ length: 101 }, (_, index) => ({
          path: `projects/api-${index}.md`,
          title: `API ${index}`,
          type: 'entity',
          content: 'content',
          sourceIds: [`decision:d_${index}`],
        })),
      })
    ).toThrow(/at most 100 pages/i);
    expect(() =>
      adapter.publish({
        pages: [
          {
            path: 'projects/api.md',
            title: 'API',
            type: 'entity',
            content: 'x'.repeat(200_001),
            sourceIds: ['decision:d_1'],
          },
        ],
      })
    ).toThrow(/must not exceed 200000 characters/i);
    expect(publisher).not.toHaveBeenCalled();
  });

  it('dedupes same-path pages before publishing or storing artifacts', () => {
    const db = new Database(':memory:');
    const store = new WikiArtifactStore(db);
    const publisher = vi.fn();
    const adapter = createWikiPublishAdapter({
      mode: 'vnext',
      store,
      publisher,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
      nowMs: () => 2000,
    });

    const result = adapter.publish({
      pages: [
        {
          path: 'projects/api.md',
          title: 'API',
          type: 'entity',
          content: 'first content',
          sourceRefs: [{ kind: 'raw', connector: 'slack', id: 'event-1' }],
        },
        {
          path: './projects/api.md',
          title: 'API Updated',
          type: 'lesson',
          content: 'second content',
          sourceRefs: [{ kind: 'raw', connector: 'slack', id: 'event-2' }],
        },
      ],
    });

    expect(result).toEqual({ pagesPublished: 1, artifactsStored: 1 });
    expect(publisher).toHaveBeenCalledWith([
      expect.objectContaining({
        path: 'projects/api.md',
        title: 'API Updated',
        content: 'second content',
        sourceRefs: ['raw:slack:event-2'],
      }),
    ]);
    expect(store.getByPath('projects/api.md')).toMatchObject({
      title: 'API Updated',
      type: 'lesson',
      content: 'second content',
      sourceRefs: ['raw:slack:event-2'],
    });

    db.close();
  });

  it('persists vNext artifacts before publishing so failed vault writes remain retryable', () => {
    const db = new Database(':memory:');
    const store = new WikiArtifactStore(db);
    const publisher = vi.fn(() => {
      throw new Error('vault write failed');
    });
    const adapter = createWikiPublishAdapter({
      mode: 'vnext',
      store,
      publisher,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
      nowMs: () => 2000,
    });

    expect(() =>
      adapter.publish({
        pages: [
          {
            path: 'projects/api.md',
            title: 'API',
            type: 'entity',
            content: 'content',
            sourceRefs: [{ kind: 'raw', connector: 'slack', id: 'event-1' }],
          },
        ],
      })
    ).toThrow(/vault write failed/i);

    expect(store.getByPath('projects/api.md')).toMatchObject({
      path: 'projects/api.md',
      sourceRefs: ['raw:slack:event-1'],
    });

    db.close();
  });

  it('stores vNext wiki artifacts and publishes source-linked pages', () => {
    const db = new Database(':memory:');
    const store = new WikiArtifactStore(db);
    const publisher = vi.fn();
    const adapter = createWikiPublishAdapter({
      mode: 'vnext',
      store,
      publisher,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
      nowMs: () => 2000,
    });

    const result = adapter.publish({
      pages: [
        {
          path: 'projects/api.md',
          title: 'API',
          type: 'entity',
          content: 'content',
          confidence: 'high',
          sourceRefs: [{ kind: 'raw', connector: 'slack', id: 'event-1' }],
        },
      ],
    });

    expect(result).toEqual({ pagesPublished: 1, artifactsStored: 1 });
    expect(store.getByPath('projects/api.md')).toMatchObject({
      path: 'projects/api.md',
      sourceRefs: ['raw:slack:event-1'],
    });
    expect(publisher).toHaveBeenCalledWith([
      expect.objectContaining({
        path: 'projects/api.md',
        sourceIds: ['raw:slack:event-1'],
        sourceRefs: ['raw:slack:event-1'],
      }),
    ]);

    db.close();
  });
});
