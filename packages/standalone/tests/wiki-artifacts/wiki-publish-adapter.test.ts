import { describe, expect, it, vi } from 'vitest';

process.env.MAMA_FORCE_TIER_3 ||= 'true';

import { createWikiPublishAdapter } from '../../src/wiki-artifacts/wiki-publish-adapter.js';

describe('Story PR4.2: Wiki Publish Adapter', () => {
  describe('AC #1: publish compatibility and validation', () => {
    it('keeps legacy wiki_publish compatible while preserving supplied source IDs', () => {
      const publisher = vi.fn();
      const adapter = createWikiPublishAdapter({
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

    it('rejects malformed page fields before invoking the publisher', () => {
      const publisher = vi.fn();
      const adapter = createWikiPublishAdapter({ publisher });

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
      const adapter = createWikiPublishAdapter({ publisher });

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
      const adapter = createWikiPublishAdapter({ publisher });

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
      const adapter = createWikiPublishAdapter({ publisher });

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
      const adapter = createWikiPublishAdapter({ publisher });

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

    it('dedupes same-path pages before publishing', () => {
      const publisher = vi.fn();
      const adapter = createWikiPublishAdapter({
        publisher,
        now: () => new Date('2026-07-02T00:00:00.000Z'),
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

      expect(result).toEqual({ pagesPublished: 1, artifactsStored: 0 });
      expect(publisher).toHaveBeenCalledWith([
        expect.objectContaining({
          path: 'projects/api.md',
          title: 'API Updated',
          content: 'second content',
          sourceRefs: ['raw:slack:event-2'],
        }),
      ]);
    });
  });
});
