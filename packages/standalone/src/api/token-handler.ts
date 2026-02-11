/**
 * Token Usage API router for /api/tokens endpoints
 *
 * Tracks token usage per channel/agent and provides summary endpoints.
 * Uses mama-sessions.db for storage.
 */

import { Router } from 'express';
import type Database from 'better-sqlite3';
import { asyncHandler } from './error-handler.js';

/**
 * Token usage record for insertion
 */
export interface TokenUsageRecord {
  channel_key: string;
  agent_id?: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cost_usd?: number;
}

/**
 * Initialize token_usage table in the sessions database
 */
export function initTokenUsageTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_key TEXT NOT NULL,
      agent_id TEXT,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER DEFAULT 0,
      cost_usd REAL,
      created_at INTEGER NOT NULL
    )
  `);
  // Index for time-range queries
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_usage_created_at ON token_usage(created_at)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_usage_agent ON token_usage(agent_id)
  `);
}

/**
 * Insert a token usage record
 */
export function insertTokenUsage(db: Database.Database, record: TokenUsageRecord): void {
  const stmt = db.prepare(`
    INSERT INTO token_usage (channel_key, agent_id, input_tokens, output_tokens, cache_read_tokens, cost_usd, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    record.channel_key,
    record.agent_id || null,
    record.input_tokens,
    record.output_tokens,
    record.cache_read_tokens || 0,
    record.cost_usd || null,
    Date.now()
  );
}

/**
 * Create token usage API router
 */
export function createTokenRouter(db: Database.Database): Router {
  const router = Router();

  // GET /api/tokens/summary — today / 7d / 30d totals
  router.get(
    '/summary',
    asyncHandler(async (_req, res) => {
      const now = Date.now();
      const dayMs = 86_400_000;

      const sumQuery = db.prepare(`
        SELECT
          COALESCE(SUM(input_tokens), 0) as input_tokens,
          COALESCE(SUM(output_tokens), 0) as output_tokens,
          COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
          COALESCE(SUM(cost_usd), 0) as cost_usd,
          COUNT(*) as request_count
        FROM token_usage
        WHERE created_at >= ?
      `);

      const today = sumQuery.get(now - dayMs) as {
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cost_usd: number;
        request_count: number;
      };
      const week = sumQuery.get(now - 7 * dayMs) as typeof today;
      const month = sumQuery.get(now - 30 * dayMs) as typeof today;

      res.json({ today, week, month });
    })
  );

  // GET /api/tokens/by-agent — per-agent totals (last 30 days)
  router.get(
    '/by-agent',
    asyncHandler(async (_req, res) => {
      const now = Date.now();
      const thirtyDaysAgo = now - 30 * 86_400_000;

      const rows = db
        .prepare(
          `
        SELECT
          COALESCE(agent_id, 'unknown') as agent_id,
          SUM(input_tokens) as input_tokens,
          SUM(output_tokens) as output_tokens,
          SUM(cache_read_tokens) as cache_read_tokens,
          COALESCE(SUM(cost_usd), 0) as cost_usd,
          COUNT(*) as request_count
        FROM token_usage
        WHERE created_at >= ?
        GROUP BY agent_id
        ORDER BY (input_tokens + output_tokens) DESC
      `
        )
        .all(thirtyDaysAgo) as Array<{
        agent_id: string;
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cost_usd: number;
        request_count: number;
      }>;

      res.json({ agents: rows });
    })
  );

  // GET /api/tokens/daily — daily breakdown (default 30 days)
  router.get(
    '/daily',
    asyncHandler(async (req, res) => {
      const days = Math.min(parseInt(req.query.days as string) || 30, 90);
      const now = Date.now();
      const since = now - days * 86_400_000;

      const rows = db
        .prepare(
          `
        SELECT
          date(created_at / 1000, 'unixepoch', 'localtime') as date,
          SUM(input_tokens) as input_tokens,
          SUM(output_tokens) as output_tokens,
          SUM(cache_read_tokens) as cache_read_tokens,
          COALESCE(SUM(cost_usd), 0) as cost_usd,
          COUNT(*) as request_count
        FROM token_usage
        WHERE created_at >= ?
        GROUP BY date(created_at / 1000, 'unixepoch', 'localtime')
        ORDER BY date ASC
      `
        )
        .all(since) as Array<{
        date: string;
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cost_usd: number;
        request_count: number;
      }>;

      res.json({ daily: rows, days });
    })
  );

  return router;
}
