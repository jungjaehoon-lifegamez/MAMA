import crypto from 'node:crypto';

import { MODEL_NAME, cosineSimilarity } from '../embeddings.js';
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

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return 10;
  }
  return Math.max(0, Math.floor(limit));
}

function pageIdForSourceLocator(sourceLocator: string): string {
  const digest = crypto.createHash('sha256').update(sourceLocator).digest('hex').slice(0, 24);
  return `wiki_page_${digest}`;
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

function selectByLocator(
  adapter: AdapterLike,
  schema: WikiPageIndexSchema,
  sourceLocator: string
): WikiPageIndexRecord | null {
  const sql = schema.hasIdColumn
    ? 'SELECT * FROM wiki_page_index WHERE source_locator = ?'
    : 'SELECT rowid AS id, * FROM wiki_page_index WHERE source_locator = ?';

  const row = adapter.prepare(sql).get(sourceLocator) as WikiPageIndexRow | undefined;
  return row ? rowToRecord(row) : null;
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

function vectorToBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
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

function upsertEmbedding(
  adapter: AdapterLike,
  schema: WikiPageIndexSchema,
  record: WikiPageIndexRecord,
  input: UpsertWikiPageIndexInput
): void {
  if (!input.embedding) {
    return;
  }

  const vector = vectorToBuffer(input.embedding);
  const model = input.embedding_model ?? MODEL_NAME;
  const dim = input.embedding.length;

  if (schema.embeddingUsesWikiPageId && schema.embeddingUsesVector) {
    adapter
      .prepare(
        `
          INSERT INTO wiki_page_embeddings(wiki_page_id, vector, model, dim, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(wiki_page_id) DO UPDATE SET
            vector = excluded.vector,
            model = excluded.model,
            dim = excluded.dim
        `
      )
      .run(record.id, vector, model, dim, nowIso());
    return;
  }

  adapter
    .prepare(
      `
        INSERT INTO wiki_page_embeddings(page_id, embedding)
        VALUES (?, ?)
        ON CONFLICT(page_id) DO UPDATE SET
          embedding = excluded.embedding
      `
    )
    .run(pageIdForSourceLocator(record.source_locator), vector);
}

function buildFtsQuery(query: string): string {
  const tokens = query
    .toLowerCase()
    .match(/[\p{L}\p{N}_]+/gu)
    ?.filter((token) => token.length > 0);

  if (!tokens || tokens.length === 0) {
    return query;
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

export function upsertWikiPageIndexEntry(
  adapter: AdapterLike,
  input: UpsertWikiPageIndexInput
): { id: number; created: boolean } {
  const schema = readSchema(adapter);
  const existing = selectByLocator(adapter, schema, input.source_locator);
  const updatedAt = nowIso();

  return adapter.transaction(() => {
    if (schema.hasIdColumn) {
      adapter
        .prepare(
          `
            INSERT INTO wiki_page_index (
              source_locator, page_type, title, content, case_id, source_ids,
              confidence, entity_refs, compiled_at, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_locator) DO UPDATE SET
              page_type = excluded.page_type,
              title = excluded.title,
              content = excluded.content,
              case_id = excluded.case_id,
              source_ids = excluded.source_ids,
              confidence = excluded.confidence,
              entity_refs = excluded.entity_refs,
              compiled_at = excluded.compiled_at,
              updated_at = excluded.updated_at
          `
        )
        .run(
          input.source_locator,
          input.page_type,
          input.title,
          input.content,
          input.case_id ?? null,
          JSON.stringify(input.source_ids),
          input.confidence,
          JSON.stringify(input.entity_refs),
          input.compiled_at,
          updatedAt,
          updatedAt
        );
    } else {
      adapter
        .prepare(
          `
            INSERT INTO wiki_page_index (
              page_id, source_type, source_locator, case_id, title, page_type,
              content, confidence, compiled_at, updated_at
            )
            VALUES (?, 'wiki_page', ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_type, source_locator) DO UPDATE SET
              case_id = excluded.case_id,
              title = excluded.title,
              page_type = excluded.page_type,
              content = excluded.content,
              confidence = excluded.confidence,
              compiled_at = excluded.compiled_at,
              updated_at = excluded.updated_at
          `
        )
        .run(
          pageIdForSourceLocator(input.source_locator),
          input.source_locator,
          input.case_id ?? null,
          input.title,
          input.page_type,
          input.content,
          input.confidence,
          input.compiled_at,
          updatedAt
        );
    }

    const saved = selectByLocator(adapter, schema, input.source_locator);
    if (!saved) {
      throw new Error(`Failed to load wiki_page_index row for ${input.source_locator}.`);
    }

    upsertEmbedding(adapter, schema, saved, input);

    return {
      id: saved.id,
      created: existing === null,
    };
  });
}

export function deleteWikiPageIndexEntry(
  adapter: AdapterLike,
  source_locator: string
): { deleted: boolean } {
  const result = adapter
    .prepare('DELETE FROM wiki_page_index WHERE source_locator = ?')
    .run(source_locator);
  return { deleted: result.changes > 0 };
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
    .all(buildFtsQuery(query), boundedLimit) as Array<{ page_id: unknown; raw: unknown }>;

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

export function searchWikiPages(input: {
  adapter: AdapterLike;
  query: string;
  queryEmbedding?: Float32Array | null;
  limit: number;
}): WikiPageSearchHit[] {
  const ftsHits = ftsSearchWikiPages(input.adapter, input.query, input.limit);
  const vectorHits = input.queryEmbedding
    ? vectorSearchWikiPages(input.adapter, input.queryEmbedding, input.limit)
    : [];

  const merged = new Map<number, WikiPageSearchHit>();
  for (const hit of [...ftsHits, ...vectorHits]) {
    const existing = merged.get(hit.record.id);
    if (!existing || hit.raw_score > existing.raw_score) {
      merged.set(hit.record.id, hit);
    }
  }

  return Array.from(merged.values())
    .sort((left, right) => right.raw_score - left.raw_score)
    .slice(0, normalizeLimit(input.limit))
    .map((hit, rank) => ({ ...hit, rank }));
}
