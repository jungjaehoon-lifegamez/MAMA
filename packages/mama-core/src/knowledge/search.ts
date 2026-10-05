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

    if (!decision) {
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
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(` ${join} `);
}

/** The words of free text, for a match that needs every one of them. */
export function ftsWords(text: string): string[] {
  return text.match(/[\p{L}\p{N}_]+/gu) ?? [];
}

const CJK_CHARACTER = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HANGUL_ONLY = /^\p{Script=Hangul}+$/u;
const HIRAGANA_ONLY = /^\p{Script=Hiragana}+$/u;
// Japanese has no spaces: a word changes where the script does. Kanji and katakana runs carry the
// words; the hiragana between them are particles and verb endings. U+30FC (the long-vowel mark)
// belongs to katakana words but its own script is Common. Korean and Latin text stay together;
// an underscore separates, as it does in the word index.
const SCRIPT_RUN =
  /\p{Script=Han}+|[\p{Script=Katakana}\u30FC]+|\p{Script=Hiragana}+|[^\p{Script=Han}\p{Script=Katakana}\p{Script=Hiragana}\u30FC_]+/gu;
// Korean particles and endings take one or two syllables.
const HANGUL_ENDING_SYLLABLES = 2;

/**
 * The words of the Korean and Japanese words of free text, lower-cased: each with the forms that
 * count as it, in the trigram index.
 *
 * A Japanese word written without spaces is split where its script changes and its hiragana
 * runs are left out, unless the word is hiragana alone; Latin letters and digits split off it
 * are a word of the word index (a card name with its code attached). A Korean word also counts
 * without its last one or two syllables, where particles and endings attach (a noun with its
 * object particle also looks up the noun). Forms of one character are not looked up. Measured on
 * the agent's 762 distinct Korean and Japanese queries: dropping the last syllable found 355 of
 * 925 Korean words that matched no record, and splitting at the script found 124 of 327 longer
 * words.
 */
export function cjkQueryWords(text: string): QueryWord[] {
  const words = new Map<string, QueryWord>();
  for (const word of ftsWords(text.toLowerCase())) {
    if (!CJK_CHARACTER.test(word)) continue;
    const runs = word.match(SCRIPT_RUN) ?? [];
    for (const run of runs.length > 1 ? runs.filter((r) => !HIRAGANA_ONLY.test(r)) : runs) {
      if (characterCount(run) < 2) continue;
      if (!CJK_CHARACTER.test(run)) {
        words.set(`decisions_fts:${run}`, { index: 'decisions_fts', forms: [run] });
        continue;
      }
      const characters = Array.from(run);
      const forms = [run];
      for (let cut = 1; cut <= HANGUL_ENDING_SYLLABLES; cut += 1) {
        const ending = characters.slice(characters.length - cut).join('');
        if (!HANGUL_ONLY.test(ending) || characters.length - cut < 2) break;
        forms.push(characters.slice(0, characters.length - cut).join(''));
      }
      words.set(`decisions_trigram:${run}`, { index: 'decisions_trigram', forms });
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
  const kinds = Array.isArray(kind) ? kind : kind === undefined ? [] : [kind];
  const kindClause = kinds.length === 0 ? '' : `AND d.kind IN (${kinds.map(() => '?').join(', ')})`;
  // Excluded rows are left out before LIMIT, so they cannot fill the pool ahead of rows that stay.
  const statuses = exclude?.statuses ?? [];
  const statusClause =
    statuses.length === 0
      ? ''
      : `AND (d.status IS NULL OR d.status NOT IN (${statuses.map(() => '?').join(', ')}))`;
  const amendmentClause = exclude?.amendments
    ? "AND json_extract(d.payload_json, '$.amended') IS NULL"
    : '';
  const stmt = adapter.prepare(`
    SELECT d.id, rank
    FROM ${index}
    JOIN decisions d ON ${index}.rowid = d.rowid
    WHERE ${index} MATCH ?
      ${kindClause}
      ${statusClause}
      ${amendmentClause}
    ORDER BY rank
    LIMIT ?
  `);
  return stmt.all(query, ...kinds, ...statuses, limit) as {
    id: string;
    rank: number;
  }[];
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
 * starts or ends with it. A record scores the idf (BM25's) of each query word it holds, so records
 * holding more and rarer words come first; the word's bm25 only orders records holding the same
 * words. On the owner ledger, FTS5's bm25 over one expression weighed each of a common word's 44
 * trigram forms as a word of its own and filled the top 50 with it, and bm25 as the weight put an
 * item's long closing revision, the record a similar-case question looks for, 374th of the 440
 * records holding one of its words, under short records holding a single rare word.
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

  const { total } = adapter.prepare('SELECT count(*) AS total FROM decisions').get() as {
    total: number;
  };
  const scores = new Map<string, number>();
  // A word given twice weighs once.
  const distinct = new Map(words.map((word) => [`${word.index}:${word.forms.join('|')}`, word]));
  for (const word of distinct.values()) {
    const terms = word.forms.flatMap((form) =>
      word.index === 'decisions_trigram' && characterCount(form) === 2
        ? (trigramsOfPair.get(form) ?? [])
        : [form]
    );
    const expression = ftsMatchTerms([...new Set(terms)], 'OR');
    if (expression === null) continue;
    // Every record holding the word: the idf counts them, and the cut comes after the sum.
    const matches = await fts5Search(adapter, expression, total, kind, exclude, word.index);
    if (matches.length === 0) continue;
    const idf = Math.log(1 + (total - matches.length + 0.5) / (matches.length + 0.5));
    const best = Math.max(...matches.map((match) => Math.abs(match.rank)));
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
