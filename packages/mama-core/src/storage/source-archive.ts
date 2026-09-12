/**
 * RawStore — per-connector SQLite evidence storage.
 * Creates basePath/<connectorName>/raw.db for each connector.
 * Uses the project's existing Database wrapper (sqlite.ts).
 */

import { existsSync, mkdirSync } from 'fs';
import { createHash } from 'node:crypto';
import { join } from 'path';

import Database from './sqlite.js';
import { applyRawItemRevisionsMigration } from './migrations/raw-item-revisions.js';

export interface NormalizedItem {
  source: string;
  /** Immutable stored observation locator; collectors may initially supply the upstream ID. */
  sourceId: string;
  /** Stable upstream entity across revisions (page, event, file, card). */
  sourceEntityId?: string;
  channel: string;
  author: string;
  content: string;
  timestamp: Date;
  contentHash?: string;
  sourceCursor?: string;
  tenantId?: string;
  projectId?: string;
  memoryScopeKind?: string;
  memoryScopeId?: string;
  type:
    | 'message'
    | 'email'
    | 'event'
    | 'document'
    | 'note'
    | 'spreadsheet_row'
    | 'kanban_card'
    | 'file_change';
  /**
   * Arbitrary structured facts. Reserved key: `observedAt` means observation-time bookkeeping and is
   * excluded from the stored content-identity/revision hash (a re-poll that only moves observedAt is
   * not a new version). Do NOT put a semantic datum under `observedAt`; use `sourceCursor` or another
   * field for last-seen values that must be tracked.
   */
  metadata?: Record<string, unknown>;
}

interface ConnectorEventIndexInput {
  source_connector: string;
  source_type: string;
  source_id: string;
  source_entity_id: string;
  source_locator: string;
  channel: string;
  author: string;
  content: string;
  event_datetime: number;
  source_timestamp_ms: number;
  source_cursor: string | null;
  tenant_id: string | null;
  project_id: string | null;
  memory_scope_kind: string | null;
  memory_scope_id: string | null;
  metadata: Record<string, unknown> | null;
  content_hash: Buffer;
}

interface RawRow {
  id: number;
  source_id: string;
  origin_source_id: string;
  source_entity_id: string;
  revision_hash: string | null;
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
const RAW_STORE_BACKFILL_BATCH_SIZE = 500;

export interface RawStoreBackfillOptions {
  sourceCursor?: string;
  tenantId?: string;
  projectId?: string;
  memoryScopeKind?: string;
  memoryScopeId?: string;
}

export type RawIndexSink = (connectorName: string, items: NormalizedItem[]) => void | Promise<void>;

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

// Reserved observation-bookkeeping metadata keys: keys a collector stamps on every poll to record
// WHEN it looked, never WHAT changed. They are excluded from the identity hash so a re-poll of
// unchanged content is one version, while genuine content/metadata changes still produce a new
// revision. Full metadata (including these) is preserved on the stored row and in the index; only
// the identity/revision hash ignores them. `metadata.observedAt` is a codebase-wide convention for
// observation-time (calendar, trello/kagemusha query-tools) - treat it as reserved and do not put a
// semantic datum under this name. This is intentionally a small central set, not a per-connector
// declaration: only calendar relies on it today, so a collector-declared mechanism would be
// speculative generality. Introduce that mechanism when a second connector needs a DIFFERENT key.
const OBSERVATION_METADATA_KEYS = new Set(['observedAt']);

function contentIdentityMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | null {
  if (!metadata) return null;
  const entries = Object.entries(metadata).filter(([key]) => !OBSERVATION_METADATA_KEYS.has(key));
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function canonicalizeRawContent(item: NormalizedItem): string {
  return JSON.stringify(
    {
      source: item.source,
      sourceId: item.sourceId,
      channel: item.channel,
      author: item.author,
      content: item.content,
      timestamp: item.timestamp.getTime(),
      type: item.type,
      metadata: contentIdentityMetadata(item.metadata),
    },
    (_key, value: unknown) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const object = value as Record<string, unknown>;
        return Object.fromEntries(
          Object.keys(object)
            .sort()
            .map((key) => [key, object[key]])
        );
      }
      return value;
    }
  );
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

export function mapNormalizedItemsToConnectorEventIndexInputs(
  connectorName: string,
  items: NormalizedItem[]
): ConnectorEventIndexInput[] {
  return items.map((item) => ({
    source_connector: connectorName,
    source_type: item.type,
    source_id: item.sourceId,
    source_entity_id: item.sourceEntityId ?? item.sourceId,
    source_locator: `${connectorName}:${item.channel}:${item.sourceId}`,
    channel: item.channel,
    author: item.author,
    content: item.content,
    event_datetime: item.timestamp.getTime(),
    source_timestamp_ms: item.timestamp.getTime(),
    source_cursor: item.sourceCursor ?? null,
    tenant_id: item.tenantId ?? null,
    project_id: item.projectId ?? null,
    memory_scope_kind: item.memoryScopeKind ?? null,
    memory_scope_id: item.memoryScopeId ?? null,
    metadata: { ...item.metadata, sourceEntityId: item.sourceEntityId ?? item.sourceId },
    content_hash: Buffer.from(normalizeContentHash(item), 'hex'),
  }));
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
    applyRawItemRevisionsMigration(db);
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
      sourceEntityId: row.source_entity_id,
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

  /**
   * Atomically persist a batch and return the stored row for each input (1:1). The returned rows carry
   * the corrected sourceId/sourceEntityId so the store and the index share one locator; an unchanged
   * re-poll or a re-listed immutable version returns the existing row instead of forging a new one.
   */
  save(connectorName: string, items: NormalizedItem[]): NormalizedItem[] {
    if (items.length === 0) return [];
    const db = this.getDb(connectorName);
    const find = db.prepare('SELECT * FROM raw_items WHERE source_id = ?');
    const findRevision = db.prepare(
      'SELECT * FROM raw_items WHERE origin_source_id = ? ORDER BY id DESC LIMIT 1'
    );
    const insert = db.prepare(`
      INSERT INTO raw_items (
        source_id, origin_source_id, source_entity_id, revision_hash,
        source, channel, author, content, timestamp, type, metadata, content_hash,
        source_cursor, tenant_id, project_id, memory_scope_kind, memory_scope_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updateProvenance = db.prepare(`
      UPDATE raw_items SET revision_hash = ?, source_entity_id = ?,
        content_hash = COALESCE(content_hash, ?),
        source_cursor = COALESCE(?, source_cursor), tenant_id = COALESCE(?, tenant_id),
        project_id = COALESCE(?, project_id), memory_scope_kind = COALESCE(?, memory_scope_kind),
        memory_scope_id = COALESCE(?, memory_scope_id)
      WHERE source_id = ?
    `);
    db.exec('BEGIN IMMEDIATE');
    try {
      const saved: NormalizedItem[] = [];
      for (const item of items) {
        const contentHash = normalizeContentHash(item);
        const original = find.get(item.sourceId) as RawRow | undefined;
        const originSourceId = item.sourceEntityId ?? original?.origin_source_id ?? item.sourceId;
        const revisionHash = createHash('sha256')
          .update(canonicalizeRawContent({ ...item, sourceId: originSourceId }))
          .digest('hex');
        // Redelivery of an already-stored immutable version address. When an upstream re-lists its
        // version history (calendar `${eventId}:${hash}`, a file version id), the exact sourceId is a
        // versioned address distinct from the entity base (source_id !== origin_source_id) with matching
        // content. Re-inserting it would forge a change. The mutable base row (source_id === origin) is
        // never treated this way, so a genuine A->B->A on one locator is still recorded.
        if (
          original &&
          original.revision_hash === revisionHash &&
          original.source_id !== originSourceId
        ) {
          // Same immutable version re-listed: do not forge a new observation, but advance last-seen
          // provenance (source_cursor / scope) so a re-poll still records that we looked - a missing
          // poll must stay distinguishable from an unchanged one.
          updateProvenance.run(
            revisionHash,
            item.sourceEntityId ?? original.source_entity_id,
            contentHash,
            item.sourceCursor ?? null,
            item.tenantId ?? null,
            item.projectId ?? null,
            item.memoryScopeKind ?? null,
            item.memoryScopeId ?? null,
            original.source_id
          );
          const refreshed = find.get(original.source_id) as RawRow | undefined;
          if (!refreshed) throw new Error('Persisted raw revision is missing');
          saved.push(this.mapRawRowToNormalizedItem(refreshed));
          continue;
        }
        // Existing locators are immutable. A legacy row receives its own hash, never the incoming body's hash.
        if (original && (!original.revision_hash || original.origin_source_id !== originSourceId)) {
          const originalItem = this.mapRawRowToNormalizedItem(original);
          const hash = createHash('sha256')
            .update(canonicalizeRawContent({ ...originalItem, sourceId: originSourceId }))
            .digest('hex');
          db.prepare(
            'UPDATE raw_items SET revision_hash = ?, content_hash = COALESCE(content_hash, ?), origin_source_id = ?, source_entity_id = ? WHERE source_id = ?'
          ).run(
            hash,
            normalizeContentHash(originalItem),
            originSourceId,
            originSourceId,
            original.source_id
          );
        }
        const latest = findRevision.get(originSourceId) as RawRow | undefined;
        const matching = latest?.revision_hash === revisionHash ? latest : undefined;
        const nextId = (
          db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS next FROM raw_items').get() as {
            next: number;
          }
        ).next;
        const sourceId =
          matching?.source_id ??
          (original ? `${originSourceId}:revision:${revisionHash}:${nextId}` : item.sourceId);
        if (!matching) {
          insert.run(
            sourceId,
            originSourceId,
            // source_entity_id must equal origin_source_id so every revision of one entity shares a
            // key; using item.sourceId here would orphan a revision from a legacy/derived origin.
            originSourceId,
            revisionHash,
            item.source,
            item.channel,
            item.author,
            item.content,
            item.timestamp.getTime(),
            item.type,
            item.metadata === undefined ? null : JSON.stringify(item.metadata),
            contentHash,
            item.sourceCursor ?? null,
            item.tenantId ?? null,
            item.projectId ?? null,
            item.memoryScopeKind ?? null,
            item.memoryScopeId ?? null
          );
        } else {
          updateProvenance.run(
            revisionHash,
            item.sourceEntityId ?? matching.source_entity_id,
            contentHash,
            item.sourceCursor ?? null,
            item.tenantId ?? null,
            item.projectId ?? null,
            item.memoryScopeKind ?? null,
            item.memoryScopeId ?? null,
            sourceId
          );
        }
        const persisted = find.get(sourceId) as RawRow | undefined;
        if (!persisted) throw new Error('Persisted raw revision is missing');
        saved.push(this.mapRawRowToNormalizedItem(persisted));
      }
      db.exec('COMMIT');
      return saved;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Stable, bounded traversal of an entity's stored revisions. Cursor is the last row ID. */
  getRevisions(
    connectorName: string,
    entityId: string,
    options: { limit?: number; cursor?: number } = {}
  ): {
    items: NormalizedItem[];
    nextCursor: number | null;
  } {
    const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 20)));
    const cursor = options.cursor ?? 0;
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isFinite(limit)) {
      throw new Error('Invalid raw revision pagination');
    }
    const rows = this.getDb(connectorName)
      .prepare(
        'SELECT * FROM raw_items WHERE source_entity_id = ? AND id > ? ORDER BY id ASC LIMIT ?'
      )
      .all(entityId, cursor, limit + 1) as RawRow[];
    return {
      items: rows.slice(0, limit).map((row) => this.mapRawRowToNormalizedItem(row)),
      nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
    };
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
    const rowsStmt = db.prepare(`
      SELECT * FROM raw_items
      WHERE id > ?
      ORDER BY id ASC
      LIMIT ?
    `);
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
    let lastId = 0;
    let hasMoreRows = true;

    while (hasMoreRows) {
      const rows = rowsStmt.all(lastId, RAW_STORE_BACKFILL_BATCH_SIZE) as RawRow[];
      if (rows.length === 0) {
        hasMoreRows = false;
        continue;
      }

      for (const row of rows) {
        lastId = row.id;
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
