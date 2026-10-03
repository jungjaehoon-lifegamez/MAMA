/**
 * Short words in Korean, Japanese and Chinese reach lexical search. A two-character word is
 * common in those languages, a Korean count of rounds is two characters, and so is an acronym
 * such as "FB". Dropping every token of two characters or fewer lost the one word that told one
 * record from another: a query for four feedback rounds returned the one-round records first.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDB, getAdapter, initDB } from '../../src/db-manager.js';
import { getLexicalQueryTokens, recallMemory, saveJudgmentRecord } from '../../src/memory/api.js';
import type { MemoryScopeRef } from '../../src/memory/types.js';

// Korean text lives in a fixture: the pre-commit guard keeps it out of .ts files.
const CJK = JSON.parse(
  fs.readFileSync(new URL('../fixtures/cjk-short-tokens.json', import.meta.url), 'utf8')
) as {
  roundQuery: string;
  roundQueryTokens: string[];
  roundRecords: { four: string; one: string; two: string };
  singleCharacterQuery: string;
  singleCharacterTokens: string[];
};

const TEST_DB = path.join(os.tmpdir(), `test-recall-cjk-short-${randomUUID()}.db`);
const PROJECT: MemoryScopeRef = { kind: 'project', id: 'repo:cjk-short' };

describe('lexical query tokens', () => {
  it('keeps two-character Korean words, counts and acronyms', () => {
    expect(getLexicalQueryTokens(CJK.roundQuery)).toEqual(CJK.roundQueryTokens);
  });

  it('keeps two-character Japanese and Chinese words and letter-digit tokens', () => {
    expect(getLexicalQueryTokens('修正 FB v2')).toEqual(['修正', 'fb', 'v2']);
  });

  it('still drops two-letter English words and single characters', () => {
    expect(getLexicalQueryTokens('we go up to the gym')).toEqual(['gym']);
    expect(getLexicalQueryTokens(CJK.singleCharacterQuery)).toEqual(CJK.singleCharacterTokens);
  });
});

describe('recall with short CJK words', () => {
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

  async function save(topic: string, summary: string) {
    return saveJudgmentRecord(
      getAdapter(),
      {
        topic,
        kind: 'decision',
        summary,
        details: summary,
        scopes: [PROJECT],
        source: { package: 'mama-core', source_type: 'test' },
      },
      { principalId: 'test-principal', agentId: 'main_agent', scopes: [PROJECT] },
      `cmd-${randomUUID()}`
    );
  }

  it('ranks the record with the asked round count first', async () => {
    // The three texts differ only in the count. Saved first, the four-round record comes last
    // on recency when the count is not searched.
    const four = await save('work/item-four', CJK.roundRecords.four);
    await save('work/item-one', CJK.roundRecords.one);
    await save('work/item-two', CJK.roundRecords.two);

    const bundle = await recallMemory(getAdapter(), CJK.roundQuery, {
      scopes: [PROJECT],
      includeRelated: false,
    });

    expect(bundle.memories[0]?.id).toBe(four.id);
  });

  it('ranks the stronger lexical match first', async () => {
    // FTS5 returns a more negative bm25 for a better match. Saved first, the strong match comes
    // last on recency if the lexical order is lost or reversed.
    const strong = await save('release/deploy-window', 'Deploy window moved to Friday evening.');
    await save(
      'notes/weekly',
      'Weekly notes covering hiring, the office move, budget review, travel plans, a supplier ' +
        'contract and one deploy question that is still open.'
    );

    const bundle = await recallMemory(getAdapter(), 'deploy window friday', {
      scopes: [PROJECT],
      includeRelated: false,
    });

    expect(bundle.memories[0]?.id).toBe(strong.id);
  });
});
