/**
 * RawStore — per-connector SQLite evidence storage.
 * Creates basePath/<connectorName>/raw.db for each connector.
 * Uses the project's existing Database wrapper (sqlite.ts).
 */

import { existsSync, mkdirSync } from 'fs';
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
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);
CREATE INDEX IF NOT EXISTS idx_raw_items_timestamp ON raw_items(timestamp);
`;

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
    this.dbs.set(connectorName, db);
    return db;
  }

  private getDbPath(connectorName: string): string {
    return join(this.basePath, connectorName, 'raw.db');
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

    return rows.map((row) => ({
      source: row.source,
      sourceId: row.source_id,
      channel: row.channel,
      author: row.author,
      content: row.content,
      timestamp: new Date(row.timestamp),
      type: row.type as NormalizedItem['type'],
      metadata:
        row.metadata !== null ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
    }));
  }

  hasConnector(connectorName: string): boolean {
    return this.dbs.has(connectorName) || existsSync(this.getDbPath(connectorName));
  }

  getRecent(connectorName: string, count: number): NormalizedItem[] {
    if (!this.hasConnector(connectorName)) return [];
    const db = this.getDb(connectorName);
    const rows = db
      .prepare('SELECT * FROM raw_items ORDER BY timestamp DESC LIMIT ?')
      .all(count) as RawRow[];

    return rows.map((row) => ({
      source: row.source,
      sourceId: row.source_id,
      channel: row.channel,
      author: row.author,
      content: row.content,
      timestamp: new Date(row.timestamp),
      type: row.type as NormalizedItem['type'],
      metadata:
        row.metadata !== null ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
    }));
  }

  close(): void {
    for (const db of this.dbs.values()) {
      db.close();
    }
    this.dbs.clear();
  }
}
