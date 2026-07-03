import { createHash } from 'crypto';

import {
  assertNonEmptySourceRefs,
  serializeSourceRef,
} from '@jungjaehoon/mama-core/provenance/source-ref';

import type { SQLiteDatabase } from '../sqlite.js';
import { applyWikiArtifactsMigration } from '../db/migrations/wiki-artifacts.js';
import {
  normalizeWikiConfidence,
  normalizeWikiPageType,
  normalizeWikiPagePath,
  requiredWikiString,
} from './normalization.js';
import type {
  WikiArtifactInput,
  WikiArtifactListOptions,
  WikiArtifactPathListOptions,
  WikiArtifactRecord,
} from './types.js';

interface WikiArtifactRow {
  artifact_id: string;
  path: string;
  title: string;
  type: string;
  content: string;
  confidence: string;
  compiled_at: string;
  source_refs_json: string;
  source_ids_json: string;
  created_at_ms: number;
  updated_at_ms: number;
}

function parseStringArrayJson(value: string, field: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error(`Wiki artifact ${field} must be a string array`);
  }
  return parsed;
}

function createArtifactId(path: string): string {
  const digest = createHash('sha256').update(path).digest('hex').slice(0, 24);
  return `wiki_artifact:${digest}`;
}

function runPaginated<T>(
  db: SQLiteDatabase,
  sql: string,
  limit: number | undefined,
  offset: number
): T[] {
  if (limit === undefined && offset === 0) {
    return db.prepare(sql).all() as T[];
  }
  if (limit === undefined) {
    return db.prepare(`${sql} LIMIT -1 OFFSET ?`).all(offset) as T[];
  }
  return db.prepare(`${sql} LIMIT ? OFFSET ?`).all(limit, offset) as T[];
}

function rowToRecord(row: WikiArtifactRow): WikiArtifactRecord {
  return {
    artifactId: row.artifact_id,
    path: row.path,
    title: row.title,
    type: normalizeWikiPageType(row.type, 'Wiki artifact'),
    content: row.content,
    confidence: normalizeWikiConfidence(row.confidence, 'Wiki artifact'),
    compiledAt: row.compiled_at,
    sourceRefs: parseStringArrayJson(row.source_refs_json, 'sourceRefs'),
    sourceIds: parseStringArrayJson(row.source_ids_json, 'sourceIds'),
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

export class WikiArtifactStore {
  private schemaEnsured = false;
  private hasSchemaStatement: ReturnType<SQLiteDatabase['prepare']> | undefined;

  constructor(private readonly db: SQLiteDatabase) {}

  private hasSchema(): boolean {
    this.hasSchemaStatement ??= this.db.prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table' AND name = 'wiki_artifacts'`
    );
    return this.hasSchemaStatement.get() !== undefined;
  }

  ensureSchema(): void {
    if (this.schemaEnsured && this.hasSchema()) {
      return;
    }
    applyWikiArtifactsMigration(this.db);
    this.schemaEnsured = true;
  }

  private normalizeInput(input: WikiArtifactInput): Omit<
    WikiArtifactRecord,
    'artifactId' | 'createdAtMs' | 'updatedAtMs'
  > & {
    artifactId: string;
    nowMs: number;
  } {
    const path = normalizeWikiPagePath(input.path, 'Wiki artifact path');
    const title = requiredWikiString(input.title, 'title', 'Wiki artifact');
    const type = normalizeWikiPageType(input.type, 'Wiki artifact');
    const content = requiredWikiString(input.content, 'content', 'Wiki artifact');
    const confidence = normalizeWikiConfidence(input.confidence, 'Wiki artifact');
    const compiledAt = input.compiledAt ?? new Date().toISOString();
    const nowMs = input.nowMs ?? Date.now();
    const artifactId = input.artifactId ?? createArtifactId(path);

    assertNonEmptySourceRefs(input.sourceRefs);
    const sourceRefs = input.sourceRefs.map((ref) => serializeSourceRef(ref));
    const sourceIds =
      input.sourceIds && input.sourceIds.length > 0
        ? input.sourceIds.map((id) => requiredWikiString(id, 'sourceIds[]', 'Wiki artifact'))
        : sourceRefs;

    return {
      artifactId,
      path,
      title,
      type,
      content,
      confidence,
      compiledAt,
      sourceRefs,
      sourceIds,
      nowMs,
    };
  }

  private validateListOptions(options: WikiArtifactListOptions | WikiArtifactPathListOptions): {
    limit: number | undefined;
    offset: number;
  } {
    const limit = options.limit;
    const offset = options.offset ?? 0;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
      throw new Error('Wiki artifact limit must be a non-negative integer');
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error('Wiki artifact offset must be a non-negative integer');
    }
    return { limit, offset };
  }

  upsertArtifact(input: WikiArtifactInput): WikiArtifactRecord {
    return this.upsertArtifacts([input])[0];
  }

  upsertArtifacts(inputs: readonly WikiArtifactInput[]): WikiArtifactRecord[] {
    this.ensureSchema();

    const normalizedByPath = new Map<string, ReturnType<WikiArtifactStore['normalizeInput']>>();
    for (const input of inputs) {
      const normalized = this.normalizeInput(input);
      normalizedByPath.set(normalized.path, normalized);
    }
    const normalizedInputs = [...normalizedByPath.values()];
    const upsert = this.db.prepare(
      `INSERT INTO wiki_artifacts (
          artifact_id, path, title, type, content, confidence, compiled_at,
          source_refs_json, source_ids_json, created_at_ms, updated_at_ms
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
        ON CONFLICT(path) DO UPDATE SET
          title = excluded.title,
          type = excluded.type,
          content = excluded.content,
          confidence = excluded.confidence,
          compiled_at = excluded.compiled_at,
          source_refs_json = excluded.source_refs_json,
          source_ids_json = excluded.source_ids_json,
          updated_at_ms = excluded.updated_at_ms`
    );
    const select = this.db.prepare(
      `SELECT
        artifact_id, path, title, type, content, confidence, compiled_at,
        source_refs_json, source_ids_json, created_at_ms, updated_at_ms
      FROM wiki_artifacts
      WHERE path = ?`
    );

    const writeBatch = this.db.transaction(() => {
      const records: WikiArtifactRecord[] = [];
      for (const input of normalizedInputs) {
        upsert.run(
          input.artifactId,
          input.path,
          input.title,
          input.type,
          input.content,
          input.confidence,
          input.compiledAt,
          JSON.stringify(input.sourceRefs),
          JSON.stringify(input.sourceIds),
          input.nowMs,
          input.nowMs
        );
        const row = select.get(input.path) as WikiArtifactRow | undefined;
        if (!row) {
          throw new Error(`Wiki artifact was not stored: ${input.path}`);
        }
        records.push(rowToRecord(row));
      }
      return records;
    });

    return writeBatch();
  }

  getByPath(path: string): WikiArtifactRecord | null {
    this.ensureSchema();
    const normalizedPath = normalizeWikiPagePath(path, 'Wiki artifact path');
    const row = this.db
      .prepare(
        `SELECT
          artifact_id, path, title, type, content, confidence, compiled_at,
          source_refs_json, source_ids_json, created_at_ms, updated_at_ms
        FROM wiki_artifacts
        WHERE path = ?`
      )
      .get(normalizedPath) as WikiArtifactRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  getByPaths(paths: readonly string[]): WikiArtifactRecord[] {
    this.ensureSchema();
    if (paths.length === 0) {
      return [];
    }
    const normalizedPaths = paths.map((path) => normalizeWikiPagePath(path, 'Wiki artifact path'));
    const placeholders = normalizedPaths.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT
          artifact_id, path, title, type, content, confidence, compiled_at,
          source_refs_json, source_ids_json, created_at_ms, updated_at_ms
        FROM wiki_artifacts
        WHERE path IN (${placeholders})`
      )
      .all(...normalizedPaths) as WikiArtifactRow[];
    const byPath = new Map(rows.map((row) => [row.path, rowToRecord(row)]));
    return normalizedPaths.flatMap((path) => {
      const record = byPath.get(path);
      return record ? [record] : [];
    });
  }

  listArtifacts(options: WikiArtifactListOptions = {}): WikiArtifactRecord[] {
    this.ensureSchema();
    const { limit, offset } = this.validateListOptions(options);

    const sql = `SELECT
            artifact_id, path, title, type, content, confidence, compiled_at,
            source_refs_json, source_ids_json, created_at_ms, updated_at_ms
          FROM wiki_artifacts
          ORDER BY updated_at_ms DESC, path ASC`;
    const rows = runPaginated<WikiArtifactRow>(this.db, sql, limit, offset);
    return rows.map((row) => rowToRecord(row));
  }

  listArtifactPaths(options: WikiArtifactPathListOptions = {}): string[] {
    this.ensureSchema();
    const { limit, offset } = this.validateListOptions(options);
    const sql = `SELECT path
          FROM wiki_artifacts
          ORDER BY updated_at_ms DESC, path ASC`;
    const rows = runPaginated<{ path: string }>(this.db, sql, limit, offset);
    return rows.map((row) => row.path);
  }
}
