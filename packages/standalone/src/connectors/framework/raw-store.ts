/**
 * RawStore — per-connector SQLite evidence storage.
 * Creates basePath/<connectorName>/raw.db for each connector.
 * Uses the project's existing Database wrapper (sqlite.ts).
 */

import { mkdirSync } from 'fs';
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
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  extracted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_raw_items_timestamp ON raw_items(timestamp);
`;

export class RawStore {
  private dbs = new Map<string, Database>();
  private migrated = new Set<string>();
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

    // Migrate existing DBs: add extracted_at column if missing
    if (!this.migrated.has(connectorName)) {
      try {
        db.exec('ALTER TABLE raw_items ADD COLUMN extracted_at INTEGER');
      } catch {
        // Column already exists — expected for new DBs
      }
      this.migrated.add(connectorName);
    }

    this.dbs.set(connectorName, db);
    return db;
  }

  save(connectorName: string, items: NormalizedItem[]): void {
    if (items.length === 0) return;
    const db = this.getDb(connectorName);
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO raw_items
        (source_id, source, channel, author, content, timestamp, type, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of items) {
      stmt.run(
        item.sourceId,
        item.source,
        item.channel,
        item.author,
        item.content,
        item.timestamp.getTime(),
        item.type,
        item.metadata !== undefined ? JSON.stringify(item.metadata) : null
      );
    }
  }

  query(connectorName: string, since: Date): NormalizedItem[] {
    const db = this.getDb(connectorName);
    const rows = db
      .prepare('SELECT * FROM raw_items WHERE timestamp >= ? ORDER BY timestamp ASC')
      .all(since.getTime()) as RawRow[];

    return rows.map((row) => toNormalizedItem(row));
  }

  /**
   * Returns only items not yet sent through extraction, preventing duplicate LLM calls across restarts.
   */
  queryUnextracted(connectorName: string, since: Date): NormalizedItem[] {
    const db = this.getDb(connectorName);
    const rows = db
      .prepare(
        'SELECT * FROM raw_items WHERE timestamp >= ? AND extracted_at IS NULL ORDER BY timestamp ASC'
      )
      .all(since.getTime()) as RawRow[];

    return rows.map((row) => toNormalizedItem(row));
  }

  markExtracted(connectorName: string, sourceIds: string[]): void {
    if (sourceIds.length === 0) return;
    const db = this.getDb(connectorName);
    const now = Date.now();
    db.exec('BEGIN');
    try {
      const stmt = db.prepare('UPDATE raw_items SET extracted_at = ? WHERE source_id = ?');
      for (const id of sourceIds) {
        stmt.run(now, id);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    for (const db of this.dbs.values()) {
      db.close();
    }
    this.dbs.clear();
  }
}

function toNormalizedItem(row: RawRow): NormalizedItem {
  return {
    source: row.source,
    sourceId: row.source_id,
    channel: row.channel,
    author: row.author,
    content: row.content,
    timestamp: new Date(row.timestamp),
    type: row.type as NormalizedItem['type'],
    metadata:
      row.metadata !== null ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
  };
}
