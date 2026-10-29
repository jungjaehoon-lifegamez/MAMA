import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beginModelRun, type DatabaseInstance, type Knowledge } from '@jungjaehoon/mama-core';
import { readReceiptEvidence } from '../../src/api/source-actions.js';
import type { StoredSourceReader } from '../../src/api/stored-source-reader.js';
import { createActionSurface } from '../../src/runtime/action-surface.js';
import { createTimeZoneSetting } from '../../src/runtime/timezone.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';

describe('readReceiptEvidence', () => {
  it('keeps every search hit, beyond the output_summary 40-item bound', () => {
    const hits = Array.from({ length: 45 }, (_, index) => ({ observationRef: `obs_${index}` }));
    const evidence = readReceiptEvidence('source.search', { hits });
    expect(JSON.parse(evidence!)).toEqual({
      observationRefs: hits.map((hit) => hit.observationRef),
    });
    expect((JSON.parse(evidence!) as { observationRefs: string[] }).observationRefs).toHaveLength(
      45
    );
  });

  it('records only the refs a batch read opened, and dedupes a single read', () => {
    const batch = readReceiptEvidence('source.read', {
      results: [
        { observationRef: 'obs_a', status: 'completed' },
        { observationRef: 'obs_b', status: 'failed' },
        { observationRef: 'obs_c', status: 'completed' },
      ],
    });
    expect(JSON.parse(batch!)).toEqual({ observationRefs: ['obs_a', 'obs_c'] });
    const single = readReceiptEvidence('source.read', { observationRef: 'obs_a' });
    expect(JSON.parse(single!)).toEqual({ observationRefs: ['obs_a'] });
  });

  it('is undefined for other actions and for a read that opened nothing', () => {
    expect(readReceiptEvidence('work.revise', { observationRef: 'obs_a' })).toBeUndefined();
    expect(readReceiptEvidence('source.read', { results: [] })).toBeUndefined();
    expect(readReceiptEvidence('source.search', { hits: [] })).toBeUndefined();
  });
});

describe('source reads record their refs in tool_traces.evidence_json', () => {
  const homes: string[] = [];
  const databases: Array<Awaited<ReturnType<typeof openCoreDatabase>>> = [];
  afterEach(async () => {
    for (const database of databases.splice(0).reverse()) await database.close();
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  it('stores all hits in full when a search returns more than forty', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mama-receipt-'));
    homes.push(home);
    const db = await openCoreDatabase({ path: join(home, 'state.db') });
    databases.push(db);
    const adapter = db.adapter as unknown as DatabaseInstance;
    const hits = Array.from({ length: 45 }, (_, index) => ({
      raw_id: `obs_${index}`,
      source_at: '2026-10-20T00:00:00Z',
      content_preview: 'hit',
      metadata: {},
    }));
    const storedSourceReader = {
      has: () => true,
      overview: () => ({}),
      search: () => ({ hits }),
      read: () => ({}),
      readObservation: () => ({}),
    } as unknown as StoredSourceReader;
    const surface = createActionSurface({
      timeZone: createTimeZoneSetting('UTC'),
      runtimeRoot: join(home, 'runtime'),
      configPath: join(home, 'config.yaml'),
      isOwnerMessageTurn: () => true,
      adapter,
      knowledge: {} as Knowledge,
      ownerPrincipalId: 'owner-test',
      agentId: 'agent-test',
      connectors: ['slack'],
      storedSourceReader,
    });
    const run = await beginModelRun(adapter, { model_id: 'fixture' });
    const result = await surface.dispatch(
      { action: 'source.search', input: { source: 'slack', query: 'term' } },
      { access: surface.ownerAccess, session: { modelRunId: run.model_run_id } }
    );
    expect(result.status).toBe('completed');
    const trace = adapter
      .prepare(
        `SELECT evidence_json FROM tool_traces WHERE model_run_id = ? AND tool_name = 'source.search'`
      )
      .get(run.model_run_id) as { evidence_json: string | null };
    const stored = JSON.parse(trace.evidence_json!) as { observationRefs: string[] };
    expect(stored.observationRefs).toHaveLength(45);
    expect(stored.observationRefs).toEqual(hits.map((hit) => hit.raw_id));
  });
});
