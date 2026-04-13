import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAdapter } from '../../src/db-manager.js';
import { queryCanonicalEntities } from '../../src/entities/recall-bridge.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';

describe('Story E1.8: Canonical entity recall bridge', () => {
  let testDbPath = '';

  beforeAll(async () => {
    testDbPath = await initTestDB('entity-recall-bridge');
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  it('returns empty when no canonical entities exist', async () => {
    const rows = await queryCanonicalEntities('Project Alpha', [
      { kind: 'project', id: 'scope-alpha' },
    ]);
    expect(rows).toEqual([]);
  });

  it('returns canonical entities scoped to the caller', async () => {
    const adapter = getAdapter();
    adapter
      .prepare(
        `INSERT INTO entity_nodes (id, kind, preferred_label, status, scope_kind, scope_id, merged_into, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'entity_project_alpha',
        'project',
        'Project Alpha',
        'active',
        'project',
        'scope-alpha',
        null,
        1710000000000,
        1710000001000
      );
    adapter
      .prepare(
        `INSERT INTO entity_aliases (id, entity_id, label, normalized_label, lang, script, label_type, source_type, source_ref, confidence, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'alias_alpha_ja',
        'entity_project_alpha',
        '\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u30A2\u30EB\u30D5\u30A1',
        '\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u30A2\u30EB\u30D5\u30A1',
        'ja',
        'Jpan',
        'alt',
        'slack',
        'slack:C123',
        0.9,
        'active',
        1710000002000
      );
    adapter
      .prepare(
        `INSERT INTO entity_timeline_events (id, entity_id, event_type, valid_from, valid_to, observed_at, source_ref, summary, details, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'timeline_alpha',
        'entity_project_alpha',
        'status_update',
        1710000003000,
        null,
        1710000003000,
        'slack:C123:1710000000.000100',
        'Launch status updated',
        'Moved from planning to active execution.',
        1710000003000
      );

    const rows = await queryCanonicalEntities(
      'Project Alpha',
      [{ kind: 'project', id: 'scope-alpha' }],
      {
        limit: 10,
      }
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.source.source_type).toBe('entity_canonical');
    expect(rows[0]?.summary).toBe('Project Alpha');
  });

  it('does not treat wildcard characters in the query as match-all patterns', async () => {
    const rows = await queryCanonicalEntities('%', [{ kind: 'project', id: 'scope-alpha' }], {
      limit: 10,
    });

    expect(rows).toEqual([]);
  });

  it('filters out merged or non-active entities from recall results', async () => {
    const adapter = getAdapter();
    adapter
      .prepare(
        `INSERT INTO entity_nodes (id, kind, preferred_label, status, scope_kind, scope_id, merged_into, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'entity_project_alpha_merged',
        'project',
        'Project Alpha Legacy',
        'merged',
        'project',
        'scope-alpha',
        'entity_project_alpha',
        1710000000000,
        1710000001000
      );

    const rows = await queryCanonicalEntities(
      'Project Alpha',
      [{ kind: 'project', id: 'scope-alpha' }],
      {
        limit: 10,
      }
    );

    expect(rows.map((row) => row.id)).not.toContain('entity_project_alpha_merged');
  });

  it('follows the merged_into chain when searching by a merged source label', async () => {
    // Regression for Codex finding #1 on PR #82: after merging source→target,
    // searching by the source's old label must still return the canonical
    // target via chain walking. Without chain walk, the alias of the merged
    // source is orphaned in recall because the n.status='active' AND
    // n.merged_into IS NULL filter drops the source row.
    const adapter = getAdapter();
    adapter
      .prepare(
        `INSERT INTO entity_nodes (id, kind, preferred_label, status, scope_kind, scope_id, merged_into, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'entity_legacy_source',
        'project',
        'Project Legacy Name',
        'merged',
        'project',
        'scope-alpha',
        'entity_project_alpha',
        1710000000000,
        1710000001000
      );
    adapter
      .prepare(
        `INSERT INTO entity_aliases (id, entity_id, label, normalized_label, lang, script, label_type, source_type, source_ref, confidence, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'alias_legacy_unique',
        'entity_legacy_source',
        'Alpha Prime Codename',
        'alpha prime codename',
        'en',
        'Latn',
        'alt',
        'slack',
        'slack:C123',
        0.9,
        'active',
        1710000002000
      );

    const rows = await queryCanonicalEntities(
      'Alpha Prime Codename',
      [{ kind: 'project', id: 'scope-alpha' }],
      { limit: 10 }
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('entity_project_alpha');
  });
});
