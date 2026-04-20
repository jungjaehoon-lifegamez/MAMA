import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/embeddings.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/embeddings.js')>('../../src/embeddings.js');
  return {
    ...actual,
    generateEmbedding: vi.fn(async () => deterministicVector()),
  };
});

import { getAdapter } from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import { upsertWikiPageIndexEntry } from '../../src/cases/wiki-page-index.js';
import { suggest } from '../../src/mama-api.js';

let testDbPath = '';
let originalTier3: string | undefined;
let originalProjectionMode: string | undefined;

function deterministicVector(): Float32Array {
  const vector = new Float32Array(1024);
  vector.fill(0.1);
  return vector;
}

function nowIso(): string {
  return new Date().toISOString();
}

function cleanupRows(): void {
  const adapter = getAdapter();
  adapter.prepare('DELETE FROM wiki_page_index').run();
  adapter.prepare('DELETE FROM embeddings').run();
  adapter.prepare('DELETE FROM decisions').run();
}

describe('Task 11: vector-only wiki page search path', () => {
  beforeAll(async () => {
    originalTier3 = process.env.MAMA_FORCE_TIER_3;
    originalProjectionMode = process.env.MAMA_ENTITY_PROJECTION_MODE;
    delete process.env.MAMA_FORCE_TIER_3;
    process.env.MAMA_ENTITY_PROJECTION_MODE = 'off';
    testDbPath = await initTestDB('mama-search-case-rollup-vector');
  });

  afterEach(() => {
    cleanupRows();
  });

  afterAll(async () => {
    if (originalTier3 === undefined) {
      delete process.env.MAMA_FORCE_TIER_3;
    } else {
      process.env.MAMA_FORCE_TIER_3 = originalTier3;
    }

    if (originalProjectionMode === undefined) {
      delete process.env.MAMA_ENTITY_PROJECTION_MODE;
    } else {
      process.env.MAMA_ENTITY_PROJECTION_MODE = originalProjectionMode;
    }

    await cleanupTestDB(testDbPath);
  });

  it('returns a wiki page whose text does not match FTS but whose stored vector matches the query', async () => {
    const adapter = getAdapter();
    upsertWikiPageIndexEntry(adapter, {
      source_locator: 'wiki/vector-only.md',
      page_type: 'entity',
      title: 'Vector Only Page',
      content: 'plain compiled markdown without the needle term',
      case_id: null,
      source_ids: [],
      entity_refs: [],
      confidence: 'medium',
      compiled_at: nowIso(),
      embedding: deterministicVector(),
    });

    const result = await suggest('spectralneedle', { limit: 5 });
    const rows = result.results as Array<Record<string, unknown>>;

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({
      id: 'wiki/vector-only.md',
      source_type: 'wiki_page',
      case_id: null,
    });
    expect(String(rows[0].decision)).toContain('plain compiled markdown');
  });
});
