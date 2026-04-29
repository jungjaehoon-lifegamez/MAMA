/**
 * RawStore — per-connector SQLite evidence storage.
 * Creates basePath/<connectorName>/raw.db for each connector.
 * Uses the project's existing Database wrapper (sqlite.ts).
 */

import { existsSync, mkdirSync } from 'fs';
import { createHash } from 'node:crypto';
import { join } from 'path';

import Database from '../../sqlite.js';
import type { NormalizedItem } from './types.js';

interface RawRow {
  source_id: string;
  source: string;
  channel: string;
  author: string;
  content: string;
  timestamp: number;
  type: string;
  metadata: string | null;
  content_hash: string | null;
  source_cursor: string | null;
  tenant_id: string | null;
  project_id: string | null;
  memory_scope_kind: string | null;
  memory_scope_id: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS raw_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  channel TEXT NOT NULL,
  author TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  type TEXT NOT NULL,
  metadata TEXT,
  content_hash TEXT,
  source_cursor TEXT,
  tenant_id TEXT,
  project_id TEXT,
  memory_scope_kind TEXT,
  memory_scope_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);
CREATE INDEX IF NOT EXISTS idx_raw_items_timestamp ON raw_items(timestamp);
`;

const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/;

export interface RawStoreBackfillOptions {
  sourceCursor?: string;
  tenantId?: string;
  projectId?: string;
  memoryScopeKind?: string;
  memoryScopeId?: string;
}

function ensureRawItemsProvenanceColumns(db: Database): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(raw_items)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
  for (const [column, type] of [
    ['content_hash', 'TEXT'],
    ['source_cursor', 'TEXT'],
    ['tenant_id', 'TEXT'],
    ['project_id', 'TEXT'],
    ['memory_scope_kind', 'TEXT'],
    ['memory_scope_id', 'TEXT'],
  ] as const) {
    if (!columns.has(column)) {
      db.exec(`ALTER TABLE raw_items ADD COLUMN ${column} ${type}`);
      columns.add(column);
    }
  }
}

function canonicalizeRawContent(item: NormalizedItem): string {
  return JSON.stringify({
    source: item.source,
    sourceId: item.sourceId,
    channel: item.channel,
    author: item.author,
    content: item.content,
    timestamp: item.timestamp.getTime(),
    type: item.type,
    metadata: item.metadata ?? null,
  });
}

function normalizeContentHash(item: NormalizedItem): string {
  if (item.contentHash !== undefined) {
    if (!CONTENT_HASH_PATTERN.test(item.contentHash)) {
      throw new Error('raw_items.content_hash must be a lowercase 64-character SHA-256 hex string');
    }
    return item.contentHash;
  }
  return createHash('sha256').update(canonicalizeRawContent(item), 'utf8').digest('hex');
}

export class RawStore {
  private dbs = new Map<string, Database>();
  private readonly basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  private getDb(connectorName: string): Database {
    const existing = this.dbs.get(connectorName);
    if (existing) return existing;

    const dir = join(this.basePath, connectorName);
    mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, 'raw.db'));
    db.exec(SCHEMA);
    ensureRawItemsProvenanceColumns(db);
    this.dbs.set(connectorName, db);
    return db;
  }

  private getDbPath(connectorName: string): string {
    return join(this.basePath, connectorName, 'raw.db');
  }

  private mapRawRowToNormalizedItem(row: RawRow): NormalizedItem {
    return {
      source: row.source,
      sourceId: row.source_id,
      channel: row.channel,
      author: row.author,
      content: row.content,
      timestamp: new Date(row.timestamp),
      type: row.type as NormalizedItem['type'],
      contentHash: row.content_hash ?? undefined,
      sourceCursor: row.source_cursor ?? undefined,
      tenantId: row.tenant_id ?? undefined,
      projectId: row.project_id ?? undefined,
      memoryScopeKind: row.memory_scope_kind ?? undefined,
      memoryScopeId: row.memory_scope_id ?? undefined,
      metadata:
        row.metadata !== null ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
    };
  }

  save(connectorName: string, items: NormalizedItem[]): void {
    if (items.length === 0) return;
    const db = this.getDb(connectorName);
    const stmt = db.prepare(`
      INSERT INTO raw_items
        (
          source_id, source, channel, author, content, timestamp, type, metadata, content_hash,
          source_cursor, tenant_id, project_id, memory_scope_kind, memory_scope_id
        )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        content_hash = excluded.content_hash,
        source_cursor = COALESCE(excluded.source_cursor, raw_items.source_cursor),
        tenant_id = COALESCE(excluded.tenant_id, raw_items.tenant_id),
        project_id = COALESCE(excluded.project_id, raw_items.project_id),
        memory_scope_kind = COALESCE(excluded.memory_scope_kind, raw_items.memory_scope_kind),
        memory_scope_id = COALESCE(excluded.memory_scope_id, raw_items.memory_scope_id)
    `);
    const existingStmt = db.prepare('SELECT * FROM raw_items WHERE source_id = ? LIMIT 1');
    for (const item of items) {
      const existing = existingStmt.get(item.sourceId) as RawRow | undefined;
      const contentHash = existing
        ? existing.content_hash && CONTENT_HASH_PATTERN.test(existing.content_hash)
          ? existing.content_hash
          : normalizeContentHash({
              ...this.mapRawRowToNormalizedItem(existing),
              contentHash: undefined,
            })
        : normalizeContentHash(item);
      stmt.run(
        item.sourceId,
        item.source,
        item.channel,
        item.author,
        item.content,
        item.timestamp.getTime(),
        item.type,
        item.metadata !== undefined ? JSON.stringify(item.metadata) : null,
        contentHash,
        item.sourceCursor ?? null,
        item.tenantId ?? null,
        item.projectId ?? null,
        item.memoryScopeKind ?? null,
        item.memoryScopeId ?? null
      );
    }
  }

  query(connectorName: string, since: Date): NormalizedItem[] {
    const db = this.getDb(connectorName);
    const rows = db
      .prepare('SELECT * FROM raw_items WHERE timestamp >= ? ORDER BY timestamp ASC')
      .all(since.getTime()) as RawRow[];

    return rows.map((row) => this.mapRawRowToNormalizedItem(row));
  }

  hasConnector(connectorName: string): boolean {
    return this.dbs.has(connectorName) || existsSync(this.getDbPath(connectorName));
  }

  getRecent(connectorName: string, count: number): NormalizedItem[] {
    if (!this.hasConnector(connectorName)) {
      return [];
    }
    const sanitizedCount = Math.min(1000, Math.max(0, Math.floor(count)));
    if (sanitizedCount === 0) {
      return [];
    }
    const db = this.getDb(connectorName);
    const rows = db
      .prepare('SELECT * FROM raw_items ORDER BY timestamp DESC LIMIT ?')
      .all(sanitizedCount) as RawRow[];

    return rows.map((row) => this.mapRawRowToNormalizedItem(row));
  }

  backfillProvenance(connectorName: string, options: RawStoreBackfillOptions = {}): number {
    const db = this.getDb(connectorName);
    const rows = db.prepare('SELECT * FROM raw_items').all() as RawRow[];
    const stmt = db.prepare(`
      UPDATE raw_items
      SET
        content_hash = ?,
        source_cursor = ?,
        tenant_id = ?,
        project_id = ?,
        memory_scope_kind = ?,
        memory_scope_id = ?
      WHERE source_id = ?
    `);

    let updated = 0;
    for (const row of rows) {
      const item = this.mapRawRowToNormalizedItem(row);
      const contentHash =
        row.content_hash && CONTENT_HASH_PATTERN.test(row.content_hash)
          ? row.content_hash
          : normalizeContentHash({ ...item, contentHash: undefined });
      const next = {
        contentHash,
        sourceCursor: row.source_cursor ?? options.sourceCursor ?? null,
        tenantId: row.tenant_id ?? options.tenantId ?? null,
        projectId: row.project_id ?? options.projectId ?? null,
        memoryScopeKind: row.memory_scope_kind ?? options.memoryScopeKind ?? null,
        memoryScopeId: row.memory_scope_id ?? options.memoryScopeId ?? null,
      };

      if (
        next.contentHash === row.content_hash &&
        next.sourceCursor === row.source_cursor &&
        next.tenantId === row.tenant_id &&
        next.projectId === row.project_id &&
        next.memoryScopeKind === row.memory_scope_kind &&
        next.memoryScopeId === row.memory_scope_id
      ) {
        continue;
      }

      const result = stmt.run(
        next.contentHash,
        next.sourceCursor,
        next.tenantId,
        next.projectId,
        next.memoryScopeKind,
        next.memoryScopeId,
        row.source_id
      );
      updated += result.changes;
    }

    return updated;
  }

  close(): void {
    for (const db of this.dbs.values()) {
      db.close();
    }
    this.dbs.clear();
  }
}
