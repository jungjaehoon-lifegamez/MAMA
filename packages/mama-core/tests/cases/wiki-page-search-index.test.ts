import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import { getAdapter } from '../../src/db-manager.js';
import { upsertWikiPageIndexEntry } from '../../src/cases/wiki-page-index.js';

function insertPage(
  overrides: Partial<{
    page_id: string;
    source_type: string;
    source_locator: string;
    case_id: string | null;
    title: string;
    page_type: string;
    content: string;
    confidence: string | null;
    compiled_at: string;
    updated_at: string;
  }> = {}
): void {
  const adapter = getAdapter();
  const now = new Date().toISOString();
  adapter
    .prepare(
      `INSERT INTO wiki_page_index
         (page_id, source_type, source_locator, case_id, title, page_type,
          content, confidence, compiled_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      overrides.page_id ?? 'page-1',
      overrides.source_type ?? 'wiki_page',
      overrides.source_locator ?? 'cases/foo.md',
      overrides.case_id ?? null,
      overrides.title ?? 'Foo case',
      overrides.page_type ?? 'case',
      overrides.content ?? 'original content alpha',
      overrides.confidence ?? null,
      overrides.compiled_at ?? now,
      overrides.updated_at ?? now
    );
}

describe('case-first substrate — wiki_page_search_index schema', () => {
  let testDbPath = '';

  beforeAll(async () => {
    testDbPath = await initTestDB('wiki-page-search-index');
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  it('creates wiki_page_index, wiki_page_embeddings, and wiki_pages_fts', () => {
    const adapter = getAdapter();
    const tables = adapter
      .prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('table','virtual table') AND name IN ('wiki_page_index','wiki_page_embeddings','wiki_pages_fts')"
      )
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name).sort();
    // virtual tables show up as type='table' in sqlite_master
    expect(names).toEqual(['wiki_page_embeddings', 'wiki_page_index', 'wiki_pages_fts'].sort());
  });

  it('source_type is constrained to wiki_page', () => {
    const adapter = getAdapter();
    const now = new Date().toISOString();
    expect(() =>
      adapter
        .prepare(
          `INSERT INTO wiki_page_index
             (page_id, source_type, source_locator, title, page_type, content, compiled_at, updated_at)
           VALUES ('page-bad-type', 'decision', 'cases/x.md', 't', 'case', 'c', ?, ?)`
        )
        .run(now, now)
    ).toThrow(/CHECK constraint/i);
  });

  it('(source_type, source_locator) is unique', () => {
    insertPage({ page_id: 'page-uniq-1', source_locator: 'cases/dup.md' });
    expect(() => insertPage({ page_id: 'page-uniq-2', source_locator: 'cases/dup.md' })).toThrow(
      /UNIQUE constraint/i
    );
  });

  it('page_type accepts every spec §5.6 enum value', () => {
    const kinds: Array<'entity' | 'lesson' | 'synthesis' | 'process' | 'case'> = [
      'entity',
      'lesson',
      'synthesis',
      'process',
      'case',
    ];
    for (const kind of kinds) {
      expect(() =>
        insertPage({
          page_id: `page-pt-${kind}`,
          source_locator: `cases/pt-${kind}.md`,
          page_type: kind,
        })
      ).not.toThrow();
    }
  });

  it('page_type rejects a value outside spec §5.6 enum', () => {
    expect(() =>
      insertPage({
        page_id: 'page-pt-bad',
        source_locator: 'cases/pt-bad.md',
        page_type: 'not_a_page_type',
      })
    ).toThrow(/CHECK constraint/i);
  });

  it('FTS returns an inserted page by content keyword', () => {
    const adapter = getAdapter();
    insertPage({
      page_id: 'page-fts-1',
      source_locator: 'cases/fts1.md',
      title: 'FTS Insert Test',
      content: 'SearchableKeyword inside body',
    });
    const rows = adapter
      .prepare("SELECT page_id FROM wiki_pages_fts WHERE wiki_pages_fts MATCH 'SearchableKeyword'")
      .all() as Array<{ page_id: string }>;
    const ids = rows.map((r) => r.page_id);
    expect(ids).toContain('page-fts-1');
  });

  it('FTS reflects UPDATE: old keyword no longer matches, new keyword matches', () => {
    const adapter = getAdapter();
    insertPage({
      page_id: 'page-upd',
      source_locator: 'cases/upd.md',
      title: 'Updatable',
      content: 'OldKeyword zebra',
    });
    // Confirm baseline
    const before = adapter
      .prepare(
        "SELECT page_id FROM wiki_pages_fts WHERE wiki_pages_fts MATCH 'OldKeyword' AND page_id = 'page-upd'"
      )
      .all();
    expect(before.length).toBe(1);

    // Update content via a regular UPDATE (NOT INSERT OR REPLACE)
    const now = new Date().toISOString();
    adapter
      .prepare(
        `UPDATE wiki_page_index SET content = 'NewKeyword tiger', updated_at = ? WHERE page_id = 'page-upd'`
      )
      .run(now);

    const oldAfter = adapter
      .prepare(
        "SELECT page_id FROM wiki_pages_fts WHERE wiki_pages_fts MATCH 'OldKeyword' AND page_id = 'page-upd'"
      )
      .all();
    expect(oldAfter.length).toBe(0);

    const newAfter = adapter
      .prepare(
        "SELECT page_id FROM wiki_pages_fts WHERE wiki_pages_fts MATCH 'NewKeyword' AND page_id = 'page-upd'"
      )
      .all();
    expect(newAfter.length).toBe(1);
  });

  it('FTS returns 0 hits after DELETE', () => {
    const adapter = getAdapter();
    insertPage({
      page_id: 'page-del',
      source_locator: 'cases/del.md',
      title: 'Deletable',
      content: 'DeleteMeToken content',
    });
    const before = adapter
      .prepare(
        "SELECT page_id FROM wiki_pages_fts WHERE wiki_pages_fts MATCH 'DeleteMeToken' AND page_id = 'page-del'"
      )
      .all();
    expect(before.length).toBe(1);

    adapter.prepare(`DELETE FROM wiki_page_index WHERE page_id = 'page-del'`).run();

    const after = adapter
      .prepare(
        "SELECT page_id FROM wiki_pages_fts WHERE wiki_pages_fts MATCH 'DeleteMeToken' AND page_id = 'page-del'"
      )
      .all();
    expect(after.length).toBe(0);
  });

  it('ON CONFLICT(page_id) DO UPDATE keeps FTS consistent (idempotent re-insert)', () => {
    const adapter = getAdapter();
    const now = new Date().toISOString();
    // First write
    insertPage({
      page_id: 'page-upsert',
      source_locator: 'cases/upsert.md',
      title: 'Upsertable',
      content: 'UpsertAlpha initial',
    });
    // UPSERT with same page_id but new content — MUST NOT use INSERT OR REPLACE
    adapter
      .prepare(
        `INSERT INTO wiki_page_index
           (page_id, source_type, source_locator, title, page_type, content, compiled_at, updated_at)
         VALUES ('page-upsert', 'wiki_page', 'cases/upsert.md', 'Upsertable',
                 'case', 'UpsertBeta revised', ?, ?)
         ON CONFLICT(page_id) DO UPDATE SET
           title = excluded.title,
           content = excluded.content,
           source_locator = excluded.source_locator,
           updated_at = excluded.updated_at`
      )
      .run(now, now);

    const alphaHits = adapter
      .prepare(
        "SELECT page_id FROM wiki_pages_fts WHERE wiki_pages_fts MATCH 'UpsertAlpha' AND page_id = 'page-upsert'"
      )
      .all();
    expect(alphaHits.length).toBe(0);

    const betaHits = adapter
      .prepare(
        "SELECT page_id FROM wiki_pages_fts WHERE wiki_pages_fts MATCH 'UpsertBeta' AND page_id = 'page-upsert'"
      )
      .all();
    expect(betaHits.length).toBe(1);
  });

  it('wiki_page_embeddings cascade-deletes when wiki_page_index row is deleted', () => {
    const adapter = getAdapter();
    insertPage({
      page_id: 'page-cascade',
      source_locator: 'cases/cascade.md',
      title: 'Cascade',
      content: 'cascade content',
    });
    adapter
      .prepare(`INSERT INTO wiki_page_embeddings (page_id, embedding) VALUES (?, ?)`)
      .run('page-cascade', Buffer.alloc(16, 0x7f));
    const before = adapter
      .prepare(`SELECT page_id FROM wiki_page_embeddings WHERE page_id = 'page-cascade'`)
      .all();
    expect(before.length).toBe(1);

    adapter.prepare(`DELETE FROM wiki_page_index WHERE page_id = 'page-cascade'`).run();

    const after = adapter
      .prepare(`SELECT page_id FROM wiki_page_embeddings WHERE page_id = 'page-cascade'`)
      .all();
    expect(after.length).toBe(0);
  });

  it('persists source_ids and entity_refs through the page_id schema path', () => {
    const record = upsertWikiPageIndexEntry(getAdapter(), {
      source_locator: 'cases/provenance.md',
      page_type: 'case',
      title: 'Provenance Case',
      content: 'case provenance content',
      case_id: null,
      source_ids: ['decision:1', 'checkpoint:2'],
      entity_refs: ['entity:alpha'],
      confidence: 'high',
      compiled_at: '2026-04-18T00:00:00.000Z',
    });

    const row = getAdapter()
      .prepare(
        `
          SELECT source_ids, entity_refs
          FROM wiki_page_index
          WHERE rowid = ?
        `
      )
      .get(record.id) as { source_ids: string | null; entity_refs: string | null };

    expect(JSON.parse(row.source_ids ?? '[]')).toEqual(['decision:1', 'checkpoint:2']);
    expect(JSON.parse(row.entity_refs ?? '[]')).toEqual(['entity:alpha']);
  });
});
