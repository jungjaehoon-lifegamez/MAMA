import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DatabaseInstance } from '../../src/db-manager.js';
import { cjkQueryWords, wordSearch, type QueryWord } from '../../src/knowledge/search.js';

/**
 * Korean writes particles onto the word and Japanese writes no spaces, so the word index matched a
 * Korean or Japanese query word only where the text held it alone. Migration 100 adds a trigram
 * index of decisions; a query's Korean and Japanese words are looked up there, words led by a
 * Latin letter or digit stay in the word index, and the records are scored word by word.
 */

// Korean text lives in a fixture: the pre-commit guard keeps it out of .ts files.
const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/cjk-word-search.json', import.meta.url), 'utf8')
) as {
  words: { query: string; expected: QueryWord[] };
  records: Record<string, string>;
  queries: Record<string, string>;
  updatedText: string;
  boundaries: { records: Record<string, string>; queries: Record<string, string> };
  idf: { visible: Record<string, string>; superseded: string; query: string };
};

const MIGRATIONS = join(__dirname, '../../db/migrations');
const migration = (file: string) => readFileSync(join(MIGRATIONS, file), 'utf8');

/** A decisions table with 092's word index, the given records, then migration 100. */
function openLedger(records: Record<string, string>): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE schema_version(version INTEGER PRIMARY KEY, description TEXT);
    CREATE TABLE decisions (
      id TEXT PRIMARY KEY, topic TEXT, decision TEXT, reasoning TEXT,
      kind TEXT, status TEXT, payload_json TEXT
    );
  `);
  db.exec(migration('092-restore-decision-fts.sql'));
  for (const [id, text] of Object.entries(records)) insertRecord(db, id, text);
  db.exec(migration('100-decision-trigram-index.sql'));
  return db;
}

function insertRecord(db: Database.Database, id: string, text: string, status = 'active') {
  db.prepare(
    "INSERT INTO decisions(id, topic, decision, reasoning, kind, status) VALUES (?, ?, ?, '', 'decision', ?)"
  ).run(id, `topic_${id}`, text, status);
}

async function search(
  db: Database.Database,
  query: string,
  exclude?: { statuses?: readonly string[] }
): Promise<string[]> {
  const rows = await wordSearch(
    db as unknown as DatabaseInstance,
    cjkQueryWords(query),
    10,
    undefined,
    exclude
  );
  return rows.map((row) => row.id);
}

describe('Korean and Japanese query words', () => {
  it('splits Japanese at the script, drops particles, strips Korean endings, picks the index', () => {
    expect(cjkQueryWords(fixture.words.query)).toEqual(fixture.words.expected);
  });

  it('has no word for a query without Korean, Japanese or Chinese text', () => {
    expect(cjkQueryWords('client feedback 2026-10-04')).toEqual([]);
  });
});

describe('word search over the trigram index', () => {
  let db: Database.Database;
  const records = Object.fromEntries(
    Object.entries(fixture.records).filter(([id]) => id !== 'added')
  );

  beforeEach(() => {
    db = openLedger(records);
  });

  afterEach(() => db.close());

  it('finds a word that carries a particle in the text', async () => {
    expect(await search(db, fixture.queries.bareWord)).toEqual(['attached']);
  });

  it('finds a two-character word at the start and at the end of a text', async () => {
    // One record holds the word only before another character, the other only after one.
    expect((await search(db, fixture.queries.particleOnTwoCharacters)).sort()).toEqual([
      'rejectEnd',
      'rejectStart',
    ]);
  });

  it('finds the words of a Japanese sentence written without spaces', async () => {
    expect(await search(db, fixture.queries.japaneseSentence)).toEqual(['japanese']);
  });

  it('ranks the record holding more of the words above repeated forms and short records', async () => {
    const ids = await search(db, fixture.queries.countWithParticle);
    // "long" holds two of the three words; "repeated" holds one word in six forms, "short" one.
    expect(ids[0]).toBe('long');
    expect(ids).toEqual(expect.arrayContaining(['repeated', 'short', 'attached']));
  });

  it('follows insert, update and delete through the triggers', async () => {
    const indexed = (text: string) =>
      db
        .prepare('SELECT rowid FROM decisions_trigram WHERE decisions_trigram MATCH ?')
        .all(`"${text}"`);
    insertRecord(db, 'added', fixture.records.added);
    expect(await search(db, fixture.queries.added)).toEqual(['added']);
    db.prepare('UPDATE decisions SET decision = ? WHERE id = ?').run(fixture.updatedText, 'added');
    expect(await search(db, fixture.queries.added)).toEqual([]);
    expect(await search(db, fixture.queries.updated)).toEqual(['added']);
    db.prepare('DELETE FROM decisions WHERE id = ?').run('added');
    // Read the index itself: a join on decisions would hide an entry the delete left behind.
    expect(indexed(fixture.queries.updated)).toEqual([]);
    expect(db.prepare('SELECT version FROM schema_version WHERE version = 100').get()).toBeTruthy();
  });

  it('answers trigram words with no rows before the index exists, and word-index words still', async () => {
    db.exec(`
      DROP TRIGGER decisions_trigram_ai; DROP TRIGGER decisions_trigram_ad;
      DROP TRIGGER decisions_trigram_au; DROP TRIGGER decisions_trigram_au2;
      DROP TABLE decisions_trigram_vocab; DROP TABLE decisions_trigram;
    `);
    insertRecord(db, 'latin', 'ab 1234 note');
    expect(await search(db, fixture.queries.bareWord)).toEqual([]);
    expect(
      (
        await wordSearch(
          db as unknown as DatabaseInstance,
          [{ index: 'decisions_fts', forms: ['1234'] }],
          10
        )
      ).map((row) => row.id)
    ).toEqual(['latin']);
  });
});

describe('word search at the start of a word', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openLedger(fixture.boundaries.records);
  });

  afterEach(() => db.close());

  it('does not find a count, a month or an acronym inside a longer word', async () => {
    // The trigram index found these inside "14", "11" and "email" with the same score.
    expect(await search(db, fixture.boundaries.queries.count)).toEqual(['four']);
    expect(await search(db, fixture.boundaries.queries.month)).toEqual(['jan']);
    expect(await search(db, fixture.boundaries.queries.acronym)).toEqual(['ai']);
  });
});

describe('word search idf', () => {
  it('counts the records the search may return, not the ones it leaves out', async () => {
    const db = openLedger(fixture.idf.visible);
    try {
      for (let index = 0; index < 200; index += 1) {
        insertRecord(db, `old${index}`, fixture.idf.superseded, 'superseded');
      }
      // Among the six visible records the one rare word outweighs two common ones; counted against
      // 206 records, the two common words would win.
      expect((await search(db, fixture.idf.query, { statuses: ['superseded'] }))[0]).toBe('y');
    } finally {
      db.close();
    }
  });
});
