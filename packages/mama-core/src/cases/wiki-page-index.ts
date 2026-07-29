import { cosineSimilarity } from '../embeddings.js';
import type { DatabaseAdapter as DBManagerAdapter } from '../db-manager.js';

export type AdapterLike = Pick<DBManagerAdapter, 'prepare' | 'transaction'>;

export interface WikiPageIndexRecord {
  id: number;
  source_locator: string;
  page_type: 'entity' | 'lesson' | 'synthesis' | 'process' | 'case';
  title: string;
  content: string;
  case_id: string | null;
  source_ids: string[];
  entity_refs: string[];
  confidence: 'high' | 'medium' | 'low' | null;
  compiled_at: string;
  created_at: string;
  updated_at: string;
}

export interface WikiPageSearchHit {
  record: WikiPageIndexRecord;
  rank: number;
  raw_score: number;
}

export interface UpsertWikiPageIndexInput {
  source_locator: string;
  page_type: WikiPageIndexRecord['page_type'];
  title: string;
  content: string;
  case_id?: string | null;
  source_ids: string[];
  entity_refs: string[];
  confidence: WikiPageIndexRecord['confidence'];
  compiled_at: string;
  embedding?: Float32Array | null;
  embedding_model?: string;
}

interface WikiPageIndexSchema {
  hasIdColumn: boolean;
  hasPageIdColumn: boolean;
  hasSourceTypeColumn: boolean;
  hasSourceIdsColumn: boolean;
  hasEntityRefsColumn: boolean;
  hasCreatedAtColumn: boolean;
  embeddingUsesWikiPageId: boolean;
  embeddingUsesVector: boolean;
  embeddingHasModel: boolean;
  embeddingHasDim: boolean;
  embeddingHasCreatedAt: boolean;
}

interface WikiPageIndexRow {
  id?: unknown;
  page_id?: unknown;
  source_locator?: unknown;
  page_type?: unknown;
  title?: unknown;
  content?: unknown;
  case_id?: unknown;
  source_ids?: unknown;
  entity_refs?: unknown;
  confidence?: unknown;
  compiled_at?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

interface WikiPageEmbeddingRow extends WikiPageIndexRow {
  vector?: unknown;
  embedding?: unknown;
}

function tableColumns(adapter: AdapterLike, tableName: string): Set<string> {
  const rows = adapter.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function readSchema(adapter: AdapterLike): WikiPageIndexSchema {
  const indexColumns = tableColumns(adapter, 'wiki_page_index');
  const embeddingColumns = tableColumns(adapter, 'wiki_page_embeddings');

  if (!indexColumns.has('id') && !indexColumns.has('page_id')) {
    throw new Error('wiki_page_index schema is missing both id and page_id columns.');
  }

  return {
    hasIdColumn: indexColumns.has('id'),
    hasPageIdColumn: indexColumns.has('page_id'),
    hasSourceTypeColumn: indexColumns.has('source_type'),
    hasSourceIdsColumn: indexColumns.has('source_ids'),
    hasEntityRefsColumn: indexColumns.has('entity_refs'),
    hasCreatedAtColumn: indexColumns.has('created_at'),
    embeddingUsesWikiPageId: embeddingColumns.has('wiki_page_id'),
    embeddingUsesVector: embeddingColumns.has('vector'),
    embeddingHasModel: embeddingColumns.has('model'),
    embeddingHasDim: embeddingColumns.has('dim'),
    embeddingHasCreatedAt: embeddingColumns.has('created_at'),
  };
}

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return 10;
  }
  return Math.max(0, Math.floor(limit));
}

function parseJsonArray(value: unknown): string[] {
  if (value === null || value === undefined || value === '') {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map(String);
  }

  if (typeof value !== 'string') {
    return [];
  }

  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('wiki_page_index JSON array column decoded to a non-array value.');
  }

  return parsed.map(String);
}

function normalizeConfidence(value: unknown): WikiPageIndexRecord['confidence'] {
  if (value === 'high' || value === 'medium' || value === 'low') {
    return value;
  }
  return null;
}

function rowToRecord(row: WikiPageIndexRow): WikiPageIndexRecord {
  const id = Number(row.id);
  if (!Number.isFinite(id)) {
    throw new Error('wiki_page_index row is missing a numeric id/rowid.');
  }

  return {
    id,
    source_locator: String(row.source_locator ?? ''),
    page_type: row.page_type as WikiPageIndexRecord['page_type'],
    title: String(row.title ?? ''),
    content: String(row.content ?? ''),
    case_id: row.case_id === null || row.case_id === undefined ? null : String(row.case_id),
    source_ids: parseJsonArray(row.source_ids),
    entity_refs: parseJsonArray(row.entity_refs),
    confidence: normalizeConfidence(row.confidence),
    compiled_at: String(row.compiled_at ?? ''),
    created_at: String(row.created_at ?? row.updated_at ?? row.compiled_at ?? ''),
    updated_at: String(row.updated_at ?? row.created_at ?? row.compiled_at ?? ''),
  };
}

function selectByFtsPageId(
  adapter: AdapterLike,
  schema: WikiPageIndexSchema,
  pageId: unknown
): WikiPageIndexRecord | null {
  const sql = schema.hasIdColumn
    ? 'SELECT * FROM wiki_page_index WHERE id = ?'
    : 'SELECT rowid AS id, * FROM wiki_page_index WHERE page_id = ?';

  const lookup = schema.hasIdColumn ? Number(pageId) : String(pageId);
  const row = adapter.prepare(sql).get(lookup) as WikiPageIndexRow | undefined;
  return row ? rowToRecord(row) : null;
}

function blobToVector(value: unknown): Float32Array | null {
  if (!(value instanceof Uint8Array)) {
    return null;
  }

  if (value.byteLength % 4 !== 0) {
    return null;
  }

  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new Float32Array(arrayBuffer);
}

function buildFtsQuery(query: string): string {
  const tokens = query
    .toLowerCase()
    .match(/[\p{L}\p{N}_]+/gu)
    ?.filter((token) => token.length > 0);

  if (!tokens || tokens.length === 0) {
    return '';
  }

  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ');
}

function normalizeBm25Score(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return 0;
  }

  if (value < 0) {
    return 1 + Math.abs(value);
  }

  return 1 / (1 + value);
}

function searchTableExists(adapter: AdapterLike, tableName: string): boolean {
  const row = adapter
    .prepare("SELECT name FROM sqlite_master WHERE name = ? AND type IN ('table','virtual table')")
    .get(tableName) as { name: string } | undefined;
  return row !== undefined;
}

export function ftsSearchWikiPages(
  adapter: AdapterLike,
  query: string,
  limit: number
): WikiPageSearchHit[] {
  const boundedLimit = normalizeLimit(limit);
  if (boundedLimit === 0 || !query.trim()) {
    return [];
  }

  if (!searchTableExists(adapter, 'wiki_pages_fts')) {
    return [];
  }

  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) {
    return [];
  }

  const schema = readSchema(adapter);
  const rows = adapter
    .prepare(
      `
        SELECT page_id, bm25(wiki_pages_fts) AS raw
        FROM wiki_pages_fts
        WHERE wiki_pages_fts MATCH ?
        ORDER BY raw
        LIMIT ?
      `
    )
    .all(ftsQuery, boundedLimit) as Array<{ page_id: unknown; raw: unknown }>;

  const hits: WikiPageSearchHit[] = [];
  for (const row of rows) {
    const record = selectByFtsPageId(adapter, schema, row.page_id);
    if (!record) {
      continue;
    }

    hits.push({
      record,
      rank: hits.length,
      raw_score: normalizeBm25Score(row.raw),
    });
  }

  return hits;
}

export function vectorSearchWikiPages(
  adapter: AdapterLike,
  queryEmbedding: Float32Array,
  limit: number
): WikiPageSearchHit[] {
  const boundedLimit = normalizeLimit(limit);
  if (boundedLimit === 0) {
    return [];
  }

  const schema = readSchema(adapter);
  const rows = schema.embeddingUsesWikiPageId
    ? (adapter
        .prepare(
          `
            SELECT i.*, e.vector
            FROM wiki_page_embeddings e
            JOIN wiki_page_index i ON i.id = e.wiki_page_id
          `
        )
        .all() as WikiPageEmbeddingRow[])
    : (adapter
        .prepare(
          `
            SELECT i.rowid AS id, i.*, e.embedding
            FROM wiki_page_embeddings e
            JOIN wiki_page_index i ON i.page_id = e.page_id
          `
        )
        .all() as WikiPageEmbeddingRow[]);

  const scored: Array<{ record: WikiPageIndexRecord; score: number }> = [];
  for (const row of rows) {
    const candidate = blobToVector(schema.embeddingUsesVector ? row.vector : row.embedding);
    if (!candidate || candidate.length !== queryEmbedding.length) {
      continue;
    }

    const score = cosineSimilarity(candidate, queryEmbedding);
    if (!Number.isFinite(score)) {
      continue;
    }

    scored.push({ record: rowToRecord(row), score });
  }

  return scored
    .sort((left, right) => right.score - left.score)
    .slice(0, boundedLimit)
    .map((entry, rank) => ({
      record: entry.record,
      rank,
      raw_score: entry.score,
    }));
}
