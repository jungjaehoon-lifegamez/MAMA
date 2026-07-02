import { describe, expect, it, vi } from 'vitest';

process.env.MAMA_FORCE_TIER_3 ||= 'true';

import Database from '../../src/sqlite.js';
import { applyWikiArtifactsMigration } from '../../src/db/migrations/wiki-artifacts.js';
import { WikiArtifactStore } from '../../src/wiki-artifacts/wiki-artifact-store.js';

function tableExists(db: Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return row !== undefined;
}

describe('Story PR4.1: Wiki Artifact Store', () => {
  describe('AC #1: schema, persistence, listing, and validation', () => {
    it('exposes the wiki artifact schema through a standalone migration', () => {
      const db = new Database(':memory:');

      applyWikiArtifactsMigration(db);
      applyWikiArtifactsMigration(db);

      expect(tableExists(db, 'wiki_artifacts')).toBe(true);
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
          .get('idx_wiki_artifacts_updated_at')
      ).toEqual({ name: 'idx_wiki_artifacts_updated_at' });

      db.close();
    });

    it('creates the wiki artifact table idempotently', () => {
      const db = new Database(':memory:');
      const store = new WikiArtifactStore(db);

      store.ensureSchema();
      store.ensureSchema();

      expect(tableExists(db, 'wiki_artifacts')).toBe(true);
      db.close();
    });

    it('installs the schema only once per store instance', () => {
      const db = new Database(':memory:');
      const store = new WikiArtifactStore(db);
      const execSpy = vi.spyOn(db, 'exec');

      store.ensureSchema();
      store.ensureSchema();
      store.upsertArtifact({
        path: 'projects/api.md',
        title: 'API',
        type: 'entity',
        content: 'content',
        confidence: 'medium',
        compiledAt: '2026-07-02T00:00:00.000Z',
        sourceRefs: [{ kind: 'raw', connector: 'slack', id: 'event-1' }],
      });
      store.listArtifactPaths();

      expect(execSpy).toHaveBeenCalledTimes(1);

      db.close();
    });

    it('stores wiki artifacts with serialized source refs', () => {
      const db = new Database(':memory:');
      const store = new WikiArtifactStore(db);

      const artifact = store.upsertArtifact({
        path: 'projects/api.md',
        title: 'API',
        type: 'entity',
        content: '## API\n\nContract notes.',
        confidence: 'high',
        compiledAt: '2026-07-02T00:00:00.000Z',
        sourceRefs: [{ kind: 'raw', connector: 'slack', id: 'event-1' }],
        nowMs: 1000,
      });

      expect(artifact).toMatchObject({
        path: 'projects/api.md',
        title: 'API',
        type: 'entity',
        sourceRefs: ['raw:slack:event-1'],
        sourceIds: ['raw:slack:event-1'],
        compiledAt: '2026-07-02T00:00:00.000Z',
        createdAtMs: 1000,
        updatedAtMs: 1000,
      });
      expect(store.getByPath('projects/api.md')).toMatchObject({
        path: 'projects/api.md',
        sourceRefs: ['raw:slack:event-1'],
      });

      db.close();
    });

    it('updates same-path artifacts without changing identity or created time', () => {
      const db = new Database(':memory:');
      const store = new WikiArtifactStore(db);

      const first = store.upsertArtifact({
        path: 'projects/api.md',
        title: 'API',
        type: 'entity',
        content: 'first content',
        confidence: 'medium',
        compiledAt: '2026-07-02T00:00:00.000Z',
        sourceRefs: [{ kind: 'raw', connector: 'slack', id: 'event-1' }],
        nowMs: 1000,
      });
      const second = store.upsertArtifact({
        path: 'projects/api.md',
        title: 'API Updated',
        type: 'lesson',
        content: 'second content',
        confidence: 'high',
        compiledAt: '2026-07-02T01:00:00.000Z',
        sourceRefs: [{ kind: 'raw', connector: 'slack', id: 'event-2' }],
        nowMs: 2000,
      });

      expect(second).toMatchObject({
        artifactId: first.artifactId,
        createdAtMs: 1000,
        updatedAtMs: 2000,
        title: 'API Updated',
        type: 'lesson',
        content: 'second content',
        sourceRefs: ['raw:slack:event-2'],
      });
      expect(store.listArtifacts()).toHaveLength(1);

      db.close();
    });

    it('dedupes same-path artifacts in batch writes with the last artifact winning', () => {
      const db = new Database(':memory:');
      const store = new WikiArtifactStore(db);

      const records = store.upsertArtifacts([
        {
          path: 'projects/api.md',
          title: 'API',
          type: 'entity',
          content: 'first content',
          confidence: 'medium',
          compiledAt: '2026-07-02T00:00:00.000Z',
          sourceRefs: [{ kind: 'raw', connector: 'slack', id: 'event-1' }],
          nowMs: 1000,
        },
        {
          path: './projects/api.md',
          title: 'API Updated',
          type: 'lesson',
          content: 'second content',
          confidence: 'high',
          compiledAt: '2026-07-02T01:00:00.000Z',
          sourceRefs: [{ kind: 'raw', connector: 'slack', id: 'event-2' }],
          nowMs: 2000,
        },
      ]);

      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        path: 'projects/api.md',
        title: 'API Updated',
        type: 'lesson',
        content: 'second content',
        sourceRefs: ['raw:slack:event-2'],
      });
      expect(store.listArtifacts()).toHaveLength(1);

      db.close();
    });

    it('lists artifact paths without materializing content', () => {
      const db = new Database(':memory:');
      const store = new WikiArtifactStore(db);

      store.upsertArtifact({
        path: 'projects/a.md',
        title: 'A',
        type: 'entity',
        content: 'A',
        confidence: 'medium',
        compiledAt: '2026-07-02T00:00:00.000Z',
        sourceRefs: [{ kind: 'raw', connector: 'slack', id: 'event-1' }],
        nowMs: 1000,
      });
      store.upsertArtifact({
        path: 'projects/b.md',
        title: 'B',
        type: 'entity',
        content: 'B',
        confidence: 'medium',
        compiledAt: '2026-07-02T00:00:00.000Z',
        sourceRefs: [{ kind: 'raw', connector: 'slack', id: 'event-2' }],
        nowMs: 2000,
      });

      expect(store.listArtifactPaths()).toEqual(['projects/b.md', 'projects/a.md']);
      expect(store.listArtifacts({ offset: 1 }).map((record) => record.path)).toEqual([
        'projects/a.md',
      ]);
      expect(store.listArtifactPaths({ offset: 1 })).toEqual(['projects/a.md']);
      expect(store.listArtifactPaths({ limit: 1, offset: 1 })).toEqual(['projects/a.md']);

      db.close();
    });

    it('loads artifacts by path in the requested order', () => {
      const db = new Database(':memory:');
      const store = new WikiArtifactStore(db);

      store.upsertArtifact({
        path: 'projects/a.md',
        title: 'A',
        type: 'entity',
        content: 'A',
        confidence: 'medium',
        compiledAt: '2026-07-02T00:00:00.000Z',
        sourceRefs: [{ kind: 'raw', connector: 'slack', id: 'event-1' }],
        nowMs: 1000,
      });
      store.upsertArtifact({
        path: 'projects/b.md',
        title: 'B',
        type: 'entity',
        content: 'B',
        confidence: 'medium',
        compiledAt: '2026-07-02T00:00:00.000Z',
        sourceRefs: [{ kind: 'raw', connector: 'slack', id: 'event-2' }],
        nowMs: 2000,
      });

      expect(store.getByPaths(['projects/b.md', 'projects/missing.md', 'projects/a.md'])).toEqual([
        expect.objectContaining({ path: 'projects/b.md' }),
        expect.objectContaining({ path: 'projects/a.md' }),
      ]);
      expect(store.getByPaths([])).toEqual([]);

      db.close();
    });

    it('rejects artifacts without source refs', () => {
      const db = new Database(':memory:');
      const store = new WikiArtifactStore(db);

      expect(() =>
        store.upsertArtifact({
          path: 'projects/api.md',
          title: 'API',
          type: 'entity',
          content: 'content',
          confidence: 'medium',
          compiledAt: '2026-07-02T00:00:00.000Z',
          sourceRefs: [],
        })
      ).toThrow(/source refs/i);

      db.close();
    });

    it('rejects artifact paths that would escape the wiki directory', () => {
      const db = new Database(':memory:');
      const store = new WikiArtifactStore(db);

      for (const path of [
        '../outside.md',
        'projects/../index.md',
        'index.md',
        'log.md',
        './',
        'projects',
        'projects/',
        'lessons',
        'synthesis',
      ]) {
        expect(() =>
          store.upsertArtifact({
            path,
            title: 'API',
            type: 'entity',
            content: 'content',
            confidence: 'medium',
            compiledAt: '2026-07-02T00:00:00.000Z',
            sourceRefs: [{ kind: 'raw', connector: 'slack', id: 'event-1' }],
          })
        ).toThrow(/parent-directory|reserved wiki files|directories|directory/i);
      }

      db.close();
    });
  });
});
