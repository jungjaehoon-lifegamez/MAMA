/**
 * MetricsStore — SQLite-backed metrics storage (STORY-019)
 *
 * Provides record()/query()/cleanup() for operational metrics.
 * Singleton per database path; uses WAL mode for concurrent reads.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

export interface MetricRecord {
  name: string;
  value: number;
  labels?: Record<string, string>;
  timestamp?: number;
}

export interface MetricRow {
  id: number;
  name: string;
  value: number;
  labels: string | null;
  timestamp: number;
}

export interface MetricQueryOptions {
  name: string;
  startTs?: number;
  endTs?: number;
  labels?: Record<string, string>;
  limit?: number;
}

export interface MetricAggregation {
  name: string;
  count: number;
  sum: number;
  avg: number;
  min: number;
  max: number;
}

export class MetricsStore {
  private static instances: Map<string, MetricsStore> = new Map<string, MetricsStore>();
  private db: Database.Database;
  private insertStmt: Database.Statement;

  private constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 3000');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        value REAL NOT NULL,
        labels TEXT,
        timestamp INTEGER NOT NULL
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_metrics_name_ts ON metrics(name, timestamp)
    `);

    this.insertStmt = this.db.prepare(
      'INSERT INTO metrics (name, value, labels, timestamp) VALUES (?, ?, ?, ?)'
    );
  }

  static getInstance(dbPath: string): MetricsStore {
    let instance: MetricsStore | undefined = MetricsStore.instances.get(dbPath);
    if (!instance) {
      instance = new MetricsStore(dbPath);
      MetricsStore.instances.set(dbPath, instance);
    }
    return instance;
  }

  /** For testing: reset all singleton instances */
  static resetInstances(): void {
    for (const instance of MetricsStore.instances.values()) {
      try {
        instance.db.close();
      } catch {
        /* ignore */
      }
    }
    MetricsStore.instances.clear();
  }

  record(metric: MetricRecord): void {
    try {
      const ts = metric.timestamp ?? Date.now();
      const labelsJson = metric.labels ? JSON.stringify(metric.labels) : null;
      this.insertStmt.run(metric.name, metric.value, labelsJson, ts);
    } catch {
      // Fire-and-forget: never throw from metrics recording
    }
  }

  recordBatch(metrics: MetricRecord[]): void {
    try {
      const tx = this.db.transaction((items: MetricRecord[]) => {
        for (const m of items) {
          const ts = m.timestamp ?? Date.now();
          const labelsJson = m.labels ? JSON.stringify(m.labels) : null;
          this.insertStmt.run(m.name, m.value, labelsJson, ts);
        }
      });
      tx(metrics);
    } catch {
      // Fire-and-forget: never throw from metrics recording
    }
  }

  query(options: MetricQueryOptions): MetricRow[] {
    const conditions = ['name = ?'];
    const params: (string | number)[] = [options.name];

    if (options.startTs !== undefined) {
      conditions.push('timestamp >= ?');
      params.push(options.startTs);
    }
    if (options.endTs !== undefined) {
      conditions.push('timestamp <= ?');
      params.push(options.endTs);
    }

    let sql = `SELECT id, name, value, labels, timestamp FROM metrics WHERE ${conditions.join(' AND ')} ORDER BY timestamp DESC`;
    // Only apply SQL LIMIT when there's no post-filter, otherwise limit after filtering
    if (options.limit !== undefined && !options.labels) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }

    let rows = this.db.prepare(sql).all(...params) as MetricRow[];

    // Post-filter by labels if specified
    if (options.labels) {
      const filterEntries = Object.entries(options.labels);
      rows = rows.filter((row) => {
        if (!row.labels) {
          return false;
        }
        try {
          const parsed = JSON.parse(row.labels) as Record<string, string>;
          return filterEntries.every(([k, v]) => parsed[k] === v);
        } catch {
          return false;
        }
      });
      if (options.limit !== undefined) {
        rows = rows.slice(0, options.limit);
      }
    }

    return rows;
  }

  aggregate(name: string, startTs?: number, endTs?: number): MetricAggregation | null {
    const conditions = ['name = ?'];
    const params: (string | number)[] = [name];

    if (startTs !== undefined) {
      conditions.push('timestamp >= ?');
      params.push(startTs);
    }
    if (endTs !== undefined) {
      conditions.push('timestamp <= ?');
      params.push(endTs);
    }

    const sql = `SELECT COUNT(*) as count, SUM(value) as sum, AVG(value) as avg, MIN(value) as min, MAX(value) as max FROM metrics WHERE ${conditions.join(' AND ')}`;
    const row = this.db.prepare(sql).get(...params) as {
      count: number;
      sum: number | null;
      avg: number | null;
      min: number | null;
      max: number | null;
    };

    if (!row || row.count === 0) {
      return null;
    }

    return {
      name,
      count: row.count,
      sum: row.sum ?? 0,
      avg: row.avg ?? 0,
      min: row.min ?? 0,
      max: row.max ?? 0,
    };
  }

  cleanup(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    const result = this.db.prepare('DELETE FROM metrics WHERE timestamp < ?').run(cutoff);
    return result.changes;
  }

  count(name?: string): number {
    if (name) {
      const row = this.db
        .prepare('SELECT COUNT(*) as cnt FROM metrics WHERE name = ?')
        .get(name) as { cnt: number };
      return row.cnt;
    }
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM metrics').get() as { cnt: number };
    return row.cnt;
  }

  countSince(startTs: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as cnt FROM metrics WHERE timestamp >= ?')
      .get(startTs) as { cnt: number };
    return row.cnt;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
    // Remove from instances map
    for (const [path, inst] of MetricsStore.instances) {
      if (inst === this) {
        MetricsStore.instances.delete(path);
        break;
      }
    }
  }
}
