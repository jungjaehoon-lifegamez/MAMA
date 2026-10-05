import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { ftsMatchTerms, ftsWords } from '../../src/knowledge/search.js';

/**
 * Unquoted, a hyphen or a date in a query is an FTS5 column filter ("no such column: 10") and AND,
 * OR and NOT are operators, so a memory search for "2026-10-04" raised an error that the caller
 * swallowed and answered from a slower in-memory scan instead.
 */
// The adapter's own driver: better-sqlite3 carries FTS5.
const Database = createRequire(import.meta.url)('better-sqlite3') as new (path: string) => {
  exec(sql: string): void;
  prepare(sql: string): { run(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] };
};

describe('FTS5 literal terms', () => {
  const db = new Database(':memory:');
  db.exec("CREATE VIRTUAL TABLE t USING fts5(body, tokenize='unicode61')");
  for (const body of [
    'report on 2026-10-04 delivery',
    'ex-1234 revision done',
    'near the AND gate',
  ]) {
    db.prepare('INSERT INTO t(body) VALUES (?)').run(body);
  }
  const match = (expression: string) =>
    db
      .prepare('SELECT body FROM t WHERE t MATCH ? ORDER BY body')
      .all(expression)
      .map((row) => (row as { body: string }).body);

  it('reads dates, hyphens and operator words as text', () => {
    expect(() => match('2026-10-04 OR ex-1234')).toThrow(/no such column/);
    expect(match(ftsMatchTerms(['2026-10-04', 'ex-1234', 'AND'], 'OR')!)).toEqual([
      'ex-1234 revision done',
      'near the AND gate',
      'report on 2026-10-04 delivery',
    ]);
    expect(match(ftsMatchTerms(['say "hi"', 'a:b'], 'OR')!)).toEqual([]);
  });

  it('needs every word of free text when joined with AND, and has no expression for none', () => {
    expect(ftsWords('the AND gate, near?')).toEqual(['the', 'AND', 'gate', 'near']);
    expect(match(ftsMatchTerms(ftsWords('AND gate'), 'AND')!)).toEqual(['near the AND gate']);
    expect(ftsMatchTerms([], 'AND')).toBeNull();
  });
});
