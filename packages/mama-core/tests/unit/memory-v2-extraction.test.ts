import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ingestConversation, ingestMemory } from '../../src/memory/api.js';
import fs from 'node:fs';

const TEST_DB = '/tmp/test-memory-v2-extraction.db';

/**
 * PR4B: conversation ingestion stores exactly one immutable source observation
 * per request and no judgment record. The removed extraction option is
 * rejected before any write so a raw observation can never be mistaken for an
 * extracted judgment.
 */
describe('ingestConversation (source.ingest boundary)', () => {
  beforeAll(() => {
    [TEST_DB, `${TEST_DB}-journal`, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((file) => {
      try {
        fs.unlinkSync(file);
      } catch {
        /* cleanup */
      }
    });
    process.env.MAMA_DB_PATH = TEST_DB;
  });

  afterAll(async () => {
    const { closeDB } = await import('../../src/db-manager.js');
    await closeDB();
    delete process.env.MAMA_DB_PATH;
    [TEST_DB, `${TEST_DB}-journal`, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((file) => {
      try {
        fs.unlinkSync(file);
      } catch {
        /* cleanup */
      }
    });
  });

  it('stores exactly one raw observation and zero judgments', async () => {
    const { getAdapter, initDB } = await import('../../src/db-manager.js');
    await initDB();
    const adapter = getAdapter();
    const before = {
      observations: (
        adapter.prepare('SELECT COUNT(*) AS n FROM observation_versions').get() as { n: number }
      ).n,
      decisions: (adapter.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number }).n,
    };
    const result = await ingestConversation({
      messages: [
        { role: 'user', content: 'I like using TypeScript.' },
        { role: 'assistant', content: 'TypeScript is great for type safety.' },
      ],
      scopes: [{ kind: 'project', id: 'test:extraction' }],
      source: { package: 'mama-core', source_type: 'test' },
    });

    expect(result.rawId).toBeTruthy();
    expect(result.extractedMemories).toEqual([]);

    const observation = adapter
      .prepare('SELECT * FROM observation_versions WHERE observation_id = ?')
      .get(result.rawId) as { body: string; source_connector: string } | undefined;
    expect(observation).toBeDefined();
    expect(observation!.body).toContain('I like using TypeScript.');
    // rawId is an observation id, so matching it against decisions.id can never
    // fail. Compare whole-table counts instead: one new observation, no new judgment.
    const after = {
      observations: (
        adapter.prepare('SELECT COUNT(*) AS n FROM observation_versions').get() as { n: number }
      ).n,
      decisions: (adapter.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number }).n,
    };
    expect(after.observations).toBe(before.observations + 1);
    expect(after.decisions).toBe(before.decisions);
  });

  it('rejects the extract option before any write', async () => {
    const { getAdapter, initDB } = await import('../../src/db-manager.js');
    await initDB();
    const adapter = getAdapter();
    const before = {
      observations: (
        adapter.prepare('SELECT COUNT(*) AS n FROM observation_versions').get() as {
          n: number;
        }
      ).n,
      decisions: (adapter.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number }).n,
    };

    await expect(
      ingestConversation({
        messages: [{ role: 'user', content: 'Some conversation content.' }],
        scopes: [],
        source: { package: 'mama-core', source_type: 'test' },
        extract: { enabled: true },
      })
    ).rejects.toThrow(/extract/);

    const after = {
      observations: (
        adapter.prepare('SELECT COUNT(*) AS n FROM observation_versions').get() as {
          n: number;
        }
      ).n,
      decisions: (adapter.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number }).n,
    };
    expect(after).toEqual(before);
  });

  it('rejects extract even when disabled', async () => {
    await expect(
      ingestConversation({
        messages: [{ role: 'user', content: 'Some conversation content.' }],
        scopes: [],
        source: { package: 'mama-core', source_type: 'test' },
        extract: { enabled: false },
      })
    ).rejects.toThrow(/extract/);
  });

  it('replays the same observation receipt for an identical request', async () => {
    const input = {
      messages: [
        { role: 'user' as const, content: 'Idempotent replay body.' },
        { role: 'assistant' as const, content: 'Acknowledged.' },
      ],
      scopes: [{ kind: 'project' as const, id: 'test:replay' }],
      source: { package: 'mama-core', source_type: 'test' },
    };
    const first = await ingestConversation(input);
    const second = await ingestConversation(input);
    expect(second.rawId).toBe(first.rawId);
  });

  it('stores ingestMemory payloads as one observation with no judgment', async () => {
    const { getAdapter } = await import('../../src/db-manager.js');
    const adapter = getAdapter();
    const before = {
      observations: (
        adapter.prepare('SELECT COUNT(*) AS n FROM observation_versions').get() as { n: number }
      ).n,
      decisions: (adapter.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number }).n,
    };
    const result = await ingestMemory({
      content: 'Raw ingested evidence body.',
      scopes: [{ kind: 'project', id: 'test:ingest-memory' }],
      source: { package: 'mama-core', source_type: 'test' },
    });
    expect(result.success).toBe(true);
    const observation = adapter
      .prepare('SELECT * FROM observation_versions WHERE observation_id = ?')
      .get(result.id) as { body: string } | undefined;
    expect(observation?.body).toBe('Raw ingested evidence body.');
    // result.id is an observation id, so matching it against decisions.id can
    // never fail. Compare whole-table counts instead.
    const after = {
      observations: (
        adapter.prepare('SELECT COUNT(*) AS n FROM observation_versions').get() as { n: number }
      ).n,
      decisions: (adapter.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number }).n,
    };
    expect(after.observations).toBe(before.observations + 1);
    expect(after.decisions).toBe(before.decisions);
  });

  it('should throw when messages array is empty', async () => {
    await expect(
      ingestConversation({
        messages: [],
        scopes: [],
        source: { package: 'mama-core', source_type: 'test' },
      })
    ).rejects.toThrow('messages array must not be empty');
  });
});
