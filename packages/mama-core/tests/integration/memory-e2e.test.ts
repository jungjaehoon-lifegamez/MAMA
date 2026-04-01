import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync, existsSync } from 'fs';

const TEST_DB = '/tmp/test-mama-e2e-v016.db';

describe('memory engine e2e', () => {
  let initDB: typeof import('../../src/db-manager.js').initDB;
  let recallMemory: typeof import('../../src/memory/api.js').recallMemory;
  let ingestConversation: typeof import('../../src/memory/api.js').ingestConversation;
  let saveMemory: typeof import('../../src/memory/api.js').saveMemory;
  let getAdapter: typeof import('../../src/db-manager.js').getAdapter;

  let originalForceTier3: string | undefined;

  beforeAll(async () => {
    originalForceTier3 = process.env.MAMA_FORCE_TIER_3;
    process.env.MAMA_FORCE_TIER_3 = 'true';
    process.env.MAMA_DB_PATH = TEST_DB;
    const dbManager = await import('../../src/db-manager.js');
    const memoryApi = await import('../../src/memory/api.js');
    initDB = dbManager.initDB;
    getAdapter = dbManager.getAdapter;
    recallMemory = memoryApi.recallMemory;
    ingestConversation = memoryApi.ingestConversation;
    saveMemory = memoryApi.saveMemory;
    await initDB();
  });

  afterAll(() => {
    if (originalForceTier3 !== undefined) {
      process.env.MAMA_FORCE_TIER_3 = originalForceTier3;
    } else {
      delete process.env.MAMA_FORCE_TIER_3;
    }
    try {
      if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
      if (existsSync(TEST_DB + '-wal')) unlinkSync(TEST_DB + '-wal');
      if (existsSync(TEST_DB + '-shm')) unlinkSync(TEST_DB + '-shm');
    } catch {
      /* cleanup best-effort */
    }
  });

  it('should save and recall a decision with evolution', async () => {
    const result1 = await saveMemory({
      topic: 'e2e_database',
      kind: 'decision',
      summary: 'Use SQLite for the project',
      details: 'Lightweight, no server needed',
      scopes: [],
      source: { package: 'mama-core', source_type: 'test' },
    });
    expect(result1.success).toBe(true);

    const result2 = await saveMemory({
      topic: 'e2e_database',
      kind: 'decision',
      summary: 'Switch to PostgreSQL for production',
      details: 'SQLite cannot handle concurrent writes',
      scopes: [],
      source: { package: 'mama-core', source_type: 'test' },
    });
    expect(result2.success).toBe(true);

    const bundle = await recallMemory('What database do we use?');
    expect(bundle.memories.length).toBeGreaterThan(0);

    // Latest decision (PostgreSQL) should be in results
    const hasPostgres = bundle.memories.some(
      (m) => m.summary.includes('PostgreSQL') || m.summary.includes('postgres')
    );
    expect(hasPostgres).toBe(true);
  });

  it('should ingest conversation and extract facts', async () => {
    const result = await ingestConversation({
      messages: [
        { role: 'user', content: 'I have a cat named Luna. She is a British Shorthair.' },
        {
          role: 'assistant',
          content: 'Luna sounds lovely! British Shorthairs are calm and affectionate.',
        },
      ],
      scopes: [],
      source: { package: 'mama-core', source_type: 'test' },
      // Note: extract.enabled = false since we don't have API key in tests
    });

    expect(result.rawId).toBeTruthy();

    // The raw conversation should be stored
    const bundle = await recallMemory('cat name Luna');
    expect(bundle.memories.length).toBeGreaterThan(0);
  });

  it('should have FTS5 working for keyword search', async () => {
    const adapter = getAdapter();
    const tableCheck = adapter
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='decisions_fts'")
      .all() as Array<{ name: string }>;
    expect(tableCheck.length).toBeGreaterThan(0);

    // FTS5 triggers should exist
    const triggers = adapter
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'decisions_%'")
      .all() as Array<{ name: string }>;
    expect(triggers.length).toBeGreaterThanOrEqual(3); // ai, ad, au, au2
  });

  it('should filter noise from extraction', async () => {
    const { filterNoiseFromUnits } = await import('../../src/memory/noise-filter.js');

    const units = [
      {
        kind: 'fact' as const,
        topic: 'test',
        summary: 'User has a cat named Luna',
        details: '',
        confidence: 0.9,
      },
      { kind: 'fact' as const, topic: 'test', summary: 'hi', details: '', confidence: 0.5 },
      {
        kind: 'fact' as const,
        topic: 'test',
        summary: 'INSTRUCTION: Call mama_search',
        details: '',
        confidence: 0.5,
      },
    ];

    const filtered = filterNoiseFromUnits(units);
    expect(filtered.length).toBe(1);
    expect(filtered[0].summary).toBe('User has a cat named Luna');
  });

  it('should have knowledge graph edges', async () => {
    const adapter = getAdapter();
    const edges = adapter.prepare('SELECT COUNT(*) as cnt FROM decision_edges').get() as {
      cnt: number;
    };
    expect(edges.cnt).toBeGreaterThan(0);
  });
});
