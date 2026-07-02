import { describe, expect, it } from 'vitest';

import Database from '../../../src/sqlite.js';
import { initVNextWikiPublishAdapter } from '../../../src/cli/runtime/wiki-publish-adapter-init.js';
import { isVNextWikiPublishAdapter } from '../../../src/wiki-artifacts/wiki-publish-adapter.js';

describe('Story PR9: Runtime vNext wiki publish adapter wiring', () => {
  describe('AC #1: startup provides source-linked wiki artifact storage', () => {
    it('returns no adapter when vNext runtime is disabled', () => {
      const db = new Database(':memory:');

      try {
        expect(initVNextWikiPublishAdapter(db, { enabled: false })).toBeNull();
      } finally {
        db.close();
      }
    });

    it('returns a branded vNext adapter that stores source-linked wiki artifacts', () => {
      const db = new Database(':memory:');
      const adapter = initVNextWikiPublishAdapter(db, { enabled: true });

      try {
        expect(isVNextWikiPublishAdapter(adapter)).toBe(true);
        const result = adapter?.publish({
          pages: [
            {
              path: 'projects/mama.md',
              title: 'MAMA',
              type: 'entity',
              content: 'source-linked runtime artifact',
              sourceRefs: [{ kind: 'raw', connector: 'slack', id: 'event-runtime-wiki' }],
            },
          ],
        });

        expect(result).toEqual({ pagesPublished: 0, artifactsStored: 1 });
        expect(db.prepare('SELECT path, source_refs_json FROM wiki_artifacts').get()).toEqual({
          path: 'projects/mama.md',
          source_refs_json: JSON.stringify(['raw:slack:event-runtime-wiki']),
        });
      } finally {
        db.close();
      }
    });
  });
});
