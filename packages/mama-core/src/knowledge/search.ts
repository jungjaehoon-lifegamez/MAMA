/**
 * Knowledge search: what the corpus can be asked for by meaning and by word.
 *
 * Both functions take the adapter they read through, so a caller cannot run a
 * search against a database it did not open.
 *
 * @module knowledge/search
 */

import type { DatabaseInstance, DecisionRecord } from '../db-manager.js';
import type { MemoryKindFilter } from '../memory/types.js';

/** Statuses default recall leaves out; history (`includeHistory`) shows them. */
export const RECALL_EXCLUDED_STATUSES = ['superseded', 'contradicted', 'stale'] as const;

/**
 * Brute-force cosine similarity search over stored embeddings.
 *
 * Errors are not swallowed: an empty array means the corpus held nothing above
 * `threshold`, never that the search failed.
 *
 * @param adapter - Database to read through
 * @param queryEmbedding - Query embedding (1024-dim)
 * @param limit - Max results to return
 * @param threshold - Minimum similarity
 * @param topicPrefix - Optional topic prefix pre-filter
 * @param excludeStatuses - Optional decision statuses to pre-filter out
 * @param kind - Optional memory kind pre-filter
 */
export async function vectorSearch(
  adapter: DatabaseInstance,
  queryEmbedding: Float32Array | number[],
  limit = 5,
  threshold = 0.7,
  topicPrefix?: string,
  excludeStatuses?: readonly string[],
  kind?: MemoryKindFilter
): Promise<DecisionRecord[]> {
  const results = await adapter.vectorSearch(
    queryEmbedding,
    limit * 3,
    topicPrefix,
    excludeStatuses,
    kind
  );

  if (!results || results.length === 0) {
    return [];
  }

  const stmt = adapter.prepare(`SELECT * FROM decisions WHERE rowid = ?`);
  const decisions: (DecisionRecord & { similarity: number; distance: number })[] = [];

  for (const row of results) {
    const decision = stmt.get(row.rowid) as DecisionRecord | undefined;

    if (!decision || typeof decision.erased_at === 'number') {
      continue;
    }

    const similarity = row.similarity ?? Math.max(0, 1.0 - (row.distance ?? 1));
    const distance = row.distance ?? Math.max(0, 1.0 - similarity);

    if (similarity >= threshold) {
      decisions.push({
        ...decision,
        distance,
        similarity,
      });
    }

    if (decisions.length >= limit) {
      break;
    }
  }

  return decisions;
}

/**
 * A MATCH expression that reads every term as text. Unquoted, a hyphen or a date is a column filter
 * or a subtraction to FTS5 ("no such column: 10") and AND, OR and NOT are operators; quoted, each
 * term is a phrase the table's tokenizer splits as it split the stored text.
 */
export function ftsMatchTerms(terms: readonly string[], join: 'AND' | 'OR'): string | null {
  if (terms.length === 0) return null;
  return terms.map(ftsPhrase).join(` ${join} `);
}

function ftsPhrase(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

/** The words of free text, for a match that needs every one of them. */
export function ftsWords(text: string): string[] {
  return text.match(/[\p{L}\p{N}_]+/gu) ?? [];
}

const CJK_CHARACTER = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HANGUL_ONLY = /^\p{Script=Hangul}+$/u;
// The long-vowel mark (U+30FC, halfwidth U+FF70) and the halfwidth voiced marks (U+FF9E, U+FF9F)
// belong to kana words, but their own script is Common.
const KANA_MARKS = '\\u30FC\\uFF70\\uFF9E\\uFF9F';
const HIRAGANA_ONLY = new RegExp(`^[\\p{Script=Hiragana}${KANA_MARKS}]+$`, 'u');
// Japanese has no spaces: a word changes where the script does. Kanji and katakana runs carry the
// words; the hiragana between them are particles and verb endings. Korean and Latin text stay
// together; an underscore separates, as it does in the word index.
const SCRIPT_RUN = new RegExp(
  `\\p{Script=Han}+|[\\p{Script=Katakana}${KANA_MARKS}]+|[\\p{Script=Hiragana}${KANA_MARKS}]+|` +
    `[^\\p{Script=Han}\\p{Script=Katakana}\\p{Script=Hiragana}${KANA_MARKS}_]+`,
  'gu'
);
// Korean particles and endings take one or two syllables.
const HANGUL_ENDING_SYLLABLES = 2;

/**
 * The words of free text that hold Korean or Japanese text, lower-cased, each with the forms that
 * count as it and the index that holds them.
 *
 * A Japanese word written without spaces is split where its script changes and its hiragana
 * runs are left out, unless the word is hiragana alone; a word of one kanji with kana (a verb
 * noun) leaves no form, since without a dictionary its kanji stand alone. A Korean word also
 * counts without its last one or two syllables, where particles and endings attach (a noun with
 * its object particle also looks up the noun). Forms of one character are not looked up. Measured
 * on the agent's 762 distinct Korean and Japanese queries: dropping the last syllable found 355 of
 * 925 Korean words that matched no record, and splitting at the script found 124 of 327 longer
 * words.
 *
 * A word led by a Latin letter or digit (a count, a month, an acronym with a particle, a code
 * split off a Japanese word) is looked up in the word index, which anchors the start of a word;
 * in the trigram index a count of 4 rounds matched inside 14 rounds, January inside November
 * (the month numbers 1 and 11 with their Korean counter) and "ai" inside "email".
 */
export function cjkQueryWords(text: string): QueryWord[] {
  const words = new Map<string, QueryWord>();
  for (const word of ftsWords(text.toLowerCase())) {
    if (!CJK_CHARACTER.test(word)) continue;
    const runs = word.match(SCRIPT_RUN) ?? [];
    for (const run of runs.length > 1 ? runs.filter((r) => !HIRAGANA_ONLY.test(r)) : runs) {
      const characters = Array.from(run);
      if (characters.length < 2) continue;
      const forms = [run];
      for (let cut = 1; cut <= HANGUL_ENDING_SYLLABLES; cut += 1) {
        const ending = characters.slice(characters.length - cut).join('');
        if (!HANGUL_ONLY.test(ending) || characters.length - cut < 2) break;
        forms.push(characters.slice(0, characters.length - cut).join(''));
      }
      const index = CJK_CHARACTER.test(characters[0]!) ? 'decisions_trigram' : 'decisions_fts';
      words.set(`${index}:${run}`, { index, forms });
    }
  }
  return [...words.values()];
}

function characterCount(text: string): number {
  return Array.from(text).length;
}

/** The full-text indexes of decisions: words (`unicode61`) and Korean and Japanese text (trigram). */
export type DecisionTextIndex = 'decisions_fts' | 'decisions_trigram';

/**
 * FTS5 keyword search on the decisions table.
 *
 * @param adapter - Database to read through
 * @param query - FTS5 MATCH expression
 * @param limit - Max rows to return
 * @param index - The full-text index to match in
 * @returns Matching decision IDs with BM25 rank scores
 */
export async function fts5Search(
  adapter: DatabaseInstance,
  query: string,
  limit = 10,
  kind?: MemoryKindFilter,
  exclude?: { statuses?: readonly string[]; amendments?: boolean },
  index: DecisionTextIndex = 'decisions_fts'
): Promise<{ id: string; rank: number }[]> {
  // An absent FTS table is a real answer - no rows. A failing adapter is not,
  // so this lookup is left unguarded and its errors reach the caller.
  const tableCheck = adapter
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(index) as { name: string } | undefined;
  if (!tableCheck) return [];

  // Query execution - let errors propagate to the caller
  // Excluded rows are left out before LIMIT, so they cannot fill the pool ahead of rows that stay.
  const filters = decisionFilters(kind, exclude);
  const stmt = adapter.prepare(`
    SELECT d.id, rank
    FROM ${index}
    JOIN decisions d ON ${index}.rowid = d.rowid
    WHERE ${index} MATCH ?
      ${filters.sql}
    ORDER BY rank
    LIMIT ?
  `);
  return stmt.all(query, ...filters.params, limit) as {
    id: string;
    rank: number;
  }[];
}

/** SQL conditions on `decisions d` for a kind filter and the excluded statuses and amendments. */
function decisionFilters(
  kind: MemoryKindFilter | undefined,
  exclude: { statuses?: readonly string[]; amendments?: boolean } | undefined
): { sql: string; params: string[] } {
  const kinds = Array.isArray(kind) ? kind : kind === undefined ? [] : [kind];
  const kindClause = kinds.length === 0 ? '' : `AND d.kind IN (${kinds.map(() => '?').join(', ')})`;
  const statuses = exclude?.statuses ?? [];
  const statusClause =
    statuses.length === 0
      ? ''
      : `AND (d.status IS NULL OR d.status NOT IN (${statuses.map(() => '?').join(', ')}))`;
  const amendmentClause = exclude?.amendments
    ? "AND json_extract(d.payload_json, '$.amended') IS NULL"
    : '';
  return {
    sql: `AND d.erased_at IS NULL ${kindClause} ${statusClause} ${amendmentClause}`,
    params: [...kinds, ...statuses],
  };
}

// Far below the smallest difference between the idf sums of two different sets of words.
const BM25_TIE_BREAK = 1e-6;

/** A word of a query: the forms that count as it and the index that holds them. */
export interface QueryWord {
  index: DecisionTextIndex;
  forms: readonly string[];
}

/**
 * Lexical search scored word by word, for a query with Korean, Japanese or Chinese words.
 *
 * A word's matches are the records holding any of its forms in its index. In the trigram index a
 * form of two characters, which no trigram holds alone, matches as every indexed trigram that
 * starts or ends with it. In the word index a form holding Korean or Japanese text matches as the
 * start of a word, where a particle may follow it (a count matches with its particle attached); a
 * form of Latin letters and digits matches a whole word. A record scores the idf (BM25's) of each
 * query word it holds, so records holding more and rarer words come first; the word's bm25 only
 * orders records holding the same words. On the owner ledger, FTS5's bm25 over one expression
 * weighed each of a common word's 44 trigram forms as a word of its own and filled the top 50 with
 * it, and bm25 as the weight put an item's long closing revision, the record a similar-case
 * question looks for, 374th of the 440 records holding one of its words, under short records
 * holding a single rare word.
 *
 * @returns Matching decision IDs, best first, with the negated score as `rank` (bm25's sign)
 */
export async function wordSearch(
  adapter: DatabaseInstance,
  words: readonly QueryWord[],
  limit = 10,
  kind?: MemoryKindFilter,
  exclude?: { statuses?: readonly string[]; amendments?: boolean }
): Promise<{ id: string; rank: number }[]> {
  const pairs = [
    ...new Set(
      words
        .filter((word) => word.index === 'decisions_trigram')
        .flatMap((word) => word.forms.filter((form) => characterCount(form) === 2))
    ),
  ];
  const trigramsOfPair = new Map<string, string[]>(pairs.map((pair) => [pair, []]));
  // Migration 100 waits for a full decisions table, as 092 does; until then there is no
  // vocabulary, and fts5Search answers the trigram index with no rows.
  const vocabulary = adapter
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='decisions_trigram_vocab'")
    .get() as { name: string } | undefined;
  if (pairs.length > 0 && vocabulary) {
    // One pass over the vocabulary for every pair: a suffix cannot use the term order.
    const marks = pairs.map(() => '?').join(', ');
    const rows = adapter
      .prepare(
        `SELECT term FROM decisions_trigram_vocab
          WHERE substr(term, 1, 2) IN (${marks}) OR substr(term, 2, 2) IN (${marks})`
      )
      .all(...pairs, ...pairs) as { term: string }[];
    for (const { term } of rows) {
      const characters = Array.from(term);
      trigramsOfPair.get(characters.slice(0, 2).join(''))?.push(term);
      trigramsOfPair.get(characters.slice(1).join(''))?.push(term);
    }
  }

  // The records the search may return: the idf counts holders among them, not among excluded ones.
  const filters = decisionFilters(kind, exclude);
  const { total } = adapter
    .prepare(`SELECT count(*) AS total FROM decisions d WHERE 1 = 1 ${filters.sql}`)
    .get(...filters.params) as { total: number };
  const scores = new Map<string, number>();
  // A word given twice weighs once.
  const distinct = new Map(words.map((word) => [`${word.index}:${word.forms.join('|')}`, word]));
  for (const word of distinct.values()) {
    const terms = [
      ...new Set(
        word.forms.flatMap((form) => {
          if (word.index === 'decisions_fts') {
            return [CJK_CHARACTER.test(form) ? `${ftsPhrase(form)}*` : ftsPhrase(form)];
          }
          const trigrams = characterCount(form) === 2 ? (trigramsOfPair.get(form) ?? []) : [form];
          return trigrams.map(ftsPhrase);
        })
      ),
    ];
    if (terms.length === 0) continue;
    // Every record holding the word: the idf counts them, and the cut comes after the sum.
    const matches = await fts5Search(adapter, terms.join(' OR '), total, kind, exclude, word.index);
    if (matches.length === 0) continue;
    const idf = Math.log(1 + (total - matches.length + 0.5) / (matches.length + 0.5));
    // A loop, not Math.max(...): the matches are every holder, past what a spread can take.
    let best = 0;
    for (const match of matches) best = Math.max(best, Math.abs(match.rank));
    for (const match of matches) {
      const order = best > 0 ? Math.abs(match.rank) / best : 1;
      scores.set(match.id, (scores.get(match.id) ?? 0) + idf + order * BM25_TIE_BREAK);
    }
  }
  return [...scores]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([id, score]) => ({ id, rank: -score }));
}
