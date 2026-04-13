import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAdapter } from '../../src/db-manager.js';
import { recallMemory } from '../../src/memory/api.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';

describe('Story E1.9: Canonical entity recall modes', () => {
  let testDbPath = '';

  beforeAll(async () => {
    testDbPath = await initTestDB('entity-recall-mode');
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
  });

  afterAll(async () => {
    delete process.env.MAMA_ENTITY_PROJECTION_MODE;
    await cleanupTestDB(testDbPath);
  });

  it('keeps canonical results hidden in off mode', async () => {
    process.env.MAMA_ENTITY_PROJECTION_MODE = 'off';

    const bundle = await recallMemory('Project Alpha', {
      scopes: [{ kind: 'project', id: 'scope-alpha' }],
    });

    expect(bundle.memories.some((row) => row.source.source_type === 'entity_canonical')).toBe(
      false
    );
  });

  it('keeps canonical results hidden in shadow mode', async () => {
    process.env.MAMA_ENTITY_PROJECTION_MODE = 'shadow';

    const bundle = await recallMemory('Project Alpha', {
      scopes: [{ kind: 'project', id: 'scope-alpha' }],
    });

    expect(bundle.memories.some((row) => row.source.source_type === 'entity_canonical')).toBe(
      false
    );
  });

  it('returns canonical results in dual-write mode', async () => {
    process.env.MAMA_ENTITY_PROJECTION_MODE = 'dual-write';

    const bundle = await recallMemory('Project Alpha', {
      scopes: [{ kind: 'project', id: 'scope-alpha' }],
    });

    expect(bundle.memories.some((row) => row.source.source_type === 'entity_canonical')).toBe(true);
  });
});
