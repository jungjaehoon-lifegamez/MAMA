/**
 * Search shows history honestly (W31.3, W31.4): what a record replaced is shown only inside the
 * reader's scopes and marked as replaced, and a retirement record is not returned as a fact.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDB, getAdapter, initDB } from '../../src/db-manager.js';
import { recallMemory, retireMemoryRecord, saveJudgmentRecord } from '../../src/memory/api.js';
import type { MemoryScopeRef } from '../../src/memory/types.js';

const TEST_DB = path.join(os.tmpdir(), `test-recall-honest-history-${randomUUID()}.db`);
const PROJECT_A: MemoryScopeRef = { kind: 'project', id: 'repo:history-a' };
const PROJECT_B: MemoryScopeRef = { kind: 'project', id: 'repo:history-b' };

function access(scopes: MemoryScopeRef[]) {
  return { principalId: 'test-principal', agentId: 'main_agent', scopes };
}

async function save(
  topic: string,
  summary: string,
  scopes: MemoryScopeRef[],
  replaces?: Array<{ id: string; reason: string }>
) {
  return saveJudgmentRecord(
    getAdapter(),
    {
      topic,
      kind: 'decision',
      summary,
      details: summary,
      scopes,
      source: { package: 'mama-core', source_type: 'test' },
      ...(replaces ? { replaces } : {}),
    },
    access([PROJECT_A, PROJECT_B]),
    `cmd-${randomUUID()}`
  );
}

describe('search shows history honestly', () => {
  const originalForceTier3 = process.env.MAMA_FORCE_TIER_3;
  beforeEach(async () => {
    await closeDB();
    fs.rmSync(TEST_DB, { force: true });
    process.env.MAMA_DB_PATH = TEST_DB;
    process.env.MAMA_FORCE_TIER_3 = 'true';
    await initDB();
  });

  afterEach(async () => {
    await closeDB();
    delete process.env.MAMA_DB_PATH;
    if (originalForceTier3 === undefined) delete process.env.MAMA_FORCE_TIER_3;
    else process.env.MAMA_FORCE_TIER_3 = originalForceTier3;
    for (const suffix of ['', '-journal', '-wal', '-shm'])
      fs.rmSync(`${TEST_DB}${suffix}`, { force: true });
  });

  it('shows what a record replaced only inside the reader scopes, marked as replaced', async () => {
    const old = await save('rule/cut', 'Cut rule for every client from the oldsheet', [PROJECT_B]);
    const current = await save(
      'rule/cut',
      'Cut rule for one client only',
      [PROJECT_A],
      [{ id: old.id, reason: 'the owner narrowed it' }]
    );

    const inA = await recallMemory(getAdapter(), 'cut rule client', { scopes: [PROJECT_A] });
    const shownInA = inA.memories.find((memory) => memory.id === current.id);
    expect(shownInA).toBeDefined();
    expect(shownInA?.details ?? '').not.toContain('oldsheet');

    const inBoth = await recallMemory(getAdapter(), 'cut rule client', {
      scopes: [PROJECT_A, PROJECT_B],
    });
    const shownInBoth = inBoth.memories.find((memory) => memory.id === current.id);
    expect(shownInBoth?.details).toContain(
      '[Replaced by this record] Cut rule for every client from the oldsheet'
    );
  });

  it('does not return a retirement as a fact, and records who retired', async () => {
    const backup = await save('ops/backup', 'Nightly backup runs at two', [PROJECT_A]);
    await retireMemoryRecord(
      getAdapter(),
      { memoryId: backup.id, status: 'stale', reason: 'moved to the zebra schedule' },
      access([PROJECT_A]),
      `cmd-${randomUUID()}`,
      { sourceMessageRef: 'telegram:-100:7', modelRunId: 'mr_retire' }
    );
    const topic = `judgment/${backup.id}`;

    const byDefault = await recallMemory(getAdapter(), 'zebra schedule', { scopes: [PROJECT_A] });
    expect(byDefault.memories.map((memory) => memory.topic)).not.toContain(topic);

    const withHistory = await recallMemory(getAdapter(), 'zebra schedule', {
      scopes: [PROJECT_A],
      includeHistory: true,
    });
    expect(withHistory.memories.map((memory) => memory.topic)).toContain(topic);

    const row = getAdapter()
      .prepare('SELECT provenance_json, model_run_id FROM decisions WHERE topic = ?')
      .get(topic) as { provenance_json: string | null; model_run_id: string | null };
    expect(JSON.parse(row.provenance_json ?? '{}')).toMatchObject({
      source_message_ref: 'telegram:-100:7',
    });
    expect(row.model_run_id).toBe('mr_retire');
  });

  it('keeps retirements from crowding an active record out of the text-search pool', async () => {
    // More retirements than the lexical pool (50) holds, each denser in the query words than the
    // active record, whose match sits in a long body and ranks below them all.
    const filler = Array.from({ length: 300 }, (_, n) => `note${n}`).join(' ');
    const active = await saveJudgmentRecord(
      getAdapter(),
      {
        topic: 'ops/pager',
        kind: 'decision',
        summary: `Pager duty ${filler} follows the walrus rota`,
        details: filler,
        scopes: [PROJECT_A],
        source: { package: 'mama-core', source_type: 'test' },
      },
      access([PROJECT_A]),
      `cmd-${randomUUID()}`
    );
    for (let n = 0; n < 55; n += 1) {
      const retired = await save(`ops/draft-${n}`, `Draft ${n}`, [PROJECT_A]);
      await retireMemoryRecord(
        getAdapter(),
        { memoryId: retired.id, status: 'stale', reason: 'walrus rota walrus rota walrus rota' },
        access([PROJECT_A]),
        `cmd-${randomUUID()}`
      );
    }
    const found = await recallMemory(getAdapter(), 'walrus rota', { scopes: [PROJECT_A] });
    expect(found.memories.map((memory) => memory.id)).toContain(active.id);
  });
});
