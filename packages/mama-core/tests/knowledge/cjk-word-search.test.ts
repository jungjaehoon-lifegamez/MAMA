import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DatabaseInstance } from '../../src/db-manager.js';
import { cjkQueryWords, wordSearch, type QueryWord } from '../../src/knowledge/search.js';

/**
 * Korean writes particles onto the word and Japanese writes no spaces, so the word index matched a
 * Korean or Japanese query word only where the text held it alone. Migration 100 adds a trigram
 * index of decisions; a query's Korean and Japanese words are looked up there and the records are
 * scored word by word.
 */

// Korean text lives in a fixture: the pre-commit guard keeps it out of .ts files.
const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/cjk-word-search.json', import.meta.url), 'utf8')
) as {
  words: { query: string; expected: QueryWord[] };
  records: Record<string, string>;
  queries: Record<string, string>;
  updatedText: string;
};

const MIGRATIONS = join(__dirname, '../../db/migrations');
const migration = (file: string) => readFileSync(join(MIGRATIONS, file), 'utf8');

describe('Korean and Japanese query words', () => {
  it('splits Japanese at the script, drops particles, and strips Korean endings', () => {
    expect(cjkQueryWords(fixture.words.query)).toEqual(fixture.words.expected);
  });

  it('has no word for a query without Korean, Japanese or Chinese text', () => {
    expect(cjkQueryWords('client feedback 2026-10-04')).toEqual([]);
  });
});

describe('word search over the trigram index', () => {
  let db: Database.Database;
  const adapter = () => db as unknown as DatabaseInstance;
  const insert = (id: string, text: string) =>
    db
      .prepare(
        "INSERT INTO decisions(id, topic, decision, reasoning, kind, status) VALUES (?, ?, ?, '', 'decision', 'active')"
      )
      .run(id, `topic_${id}`, text);
  const search = async (query: string) =>
    (await wordSearch(adapter(), cjkQueryWords(query), 10)).map((row) => row.id);

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE schema_version(version INTEGER PRIMARY KEY, description TEXT);
      CREATE TABLE decisions (
        id TEXT PRIMARY KEY, topic TEXT, decision TEXT, reasoning TEXT,
        kind TEXT, status TEXT, payload_json TEXT
      );
    `);
    db.exec(migration('092-restore-decision-fts.sql'));
    for (const [id, text] of Object.entries(fixture.records)) {
      if (id !== 'added') insert(id, text);
    }
    db.exec(migration('100-decision-trigram-index.sql'));
  });

  afterEach(() => db.close());

  it('finds a word that carries a particle in the text', async () => {
    expect(await search(fixture.queries.bareWord)).toEqual(['attached']);
  });

  it('finds a two-character word through a query word that carries a particle', async () => {
    expect(await search(fixture.queries.particleOnTwoCharacters)).toEqual(['bare']);
  });

  it('finds the words of a Japanese sentence written without spaces', async () => {
    expect(await search(fixture.queries.japaneseSentence)).toEqual(['japanese']);
  });

  it('ranks the record holding more of the words above repeated forms and short records', async () => {
    const ids = await search(fixture.queries.countWithParticle);
    // "long" holds two of the three words; "repeated" holds one word in six forms, "short" one.
    expect(ids[0]).toBe('long');
    expect(ids).toEqual(expect.arrayContaining(['repeated', 'short', 'attached']));
  });

  it('follows insert, update and delete through the triggers', async () => {
    insert('added', fixture.records.added);
    expect(await search(fixture.queries.added)).toEqual(['added']);
    db.prepare('UPDATE decisions SET decision = ? WHERE id = ?').run(fixture.updatedText, 'added');
    expect(await search(fixture.queries.added)).toEqual([]);
    expect(await search(fixture.queries.updated)).toEqual(['added']);
    db.prepare('DELETE FROM decisions WHERE id = ?').run('added');
    expect(await search(fixture.queries.updated)).toEqual([]);
    expect(db.prepare('SELECT version FROM schema_version WHERE version = 100').get()).toBeTruthy();
  });

  it('answers trigram words with no rows before the index exists, and word-index words still', async () => {
    db.exec(`
      DROP TRIGGER decisions_trigram_ai; DROP TRIGGER decisions_trigram_ad;
      DROP TRIGGER decisions_trigram_au; DROP TRIGGER decisions_trigram_au2;
      DROP TABLE decisions_trigram_vocab; DROP TABLE decisions_trigram;
    `);
    insert('latin', 'ab 1234 note');
    expect(await search(fixture.queries.bareWord)).toEqual([]);
    expect(
      (await wordSearch(adapter(), [{ index: 'decisions_fts', forms: ['1234'] }], 10)).map(
        (row) => row.id
      )
    ).toEqual(['latin']);
  });
});
