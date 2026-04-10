/**
 * Connector Feed API router for /api/connectors endpoints
 *
 * Provides activity summaries and per-connector feed endpoints
 * backed by the RawStore evidence storage.
 */

import { Router } from 'express';
import { asyncHandler } from './error-handler.js';
import type { RawStore } from '../connectors/framework/raw-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RawFeedItem {
  connector: string;
  channel: string;
  author: string;
  content: string;
  timestamp: number;
  type?: string;
  metadata?: Record<string, unknown>;
}

export interface ActivitySummary {
  connector: string;
  channel: string;
  content: string;
  timestamp: string;
  status: 'active' | 'idle' | 'disconnected' | 'error';
}

// ---------------------------------------------------------------------------
// Pure business-logic functions
// ---------------------------------------------------------------------------

const MAX_CONTENT_LENGTH = 80;

/**
 * Build activity summaries from raw feed items.
 *
 * - Picks the latest item per connector
 * - Sorts by timestamp descending
 * - Truncates content to 80 chars (with ellipsis)
 * - Sets status to 'active'
 */
export function buildActivitySummaries(items: RawFeedItem[]): ActivitySummary[] {
  if (items.length === 0) return [];

  // Pick the latest item per connector
  const latest = new Map<string, RawFeedItem>();
  for (const item of items) {
    const existing = latest.get(item.connector);
    if (!existing || item.timestamp > existing.timestamp) {
      latest.set(item.connector, item);
    }
  }

  // Sort by timestamp desc and build summaries
  return Array.from(latest.values())
    .sort((a, b) => b.timestamp - a.timestamp)
    .map((item) => ({
      connector: item.connector,
      channel: item.channel,
      content: truncateContent(item.content),
      timestamp: new Date(item.timestamp).toISOString(),
      status: 'active' as const,
    }));
}

/**
 * Truncate content to MAX_CONTENT_LENGTH chars, appending ellipsis if needed.
 */
function truncateContent(content: string): string {
  if (content.length <= MAX_CONTENT_LENGTH) return content;
  return content.slice(0, MAX_CONTENT_LENGTH - 3) + '...';
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Create the connector feed API router.
 *
 * Routes:
 *   GET /activity          — summary of latest activity per enabled connector
 *   GET /:name/feed        — paginated feed for a specific connector
 */
export function createConnectorFeedRouter(rawStore: RawStore, enabledConnectors: string[]): Router {
  const router = Router();

  // GET /api/connectors/activity
  // For each enabled connector, query rawStore for last 24h,
  // run buildActivitySummaries(), add idle/disconnected entries.
  router.get(
    '/activity',
    asyncHandler(async (_req, res) => {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const allItems: RawFeedItem[] = [];

      const connectorsWithData = new Set<string>();
      const errorConnectors = new Map<string, string>();

      for (const name of enabledConnectors) {
        try {
          const normalized = rawStore.query(name, since);
          if (normalized.length > 0) {
            connectorsWithData.add(name);
            for (const item of normalized) {
              allItems.push({
                connector: name,
                channel: item.channel,
                author: item.author,
                content: item.content,
                timestamp: item.timestamp.getTime(),
                type: item.type,
                metadata: item.metadata,
              });
            }
          }
        } catch (err) {
          connectorsWithData.add(name);
          errorConnectors.set(name, err instanceof Error ? err.message : 'DB not available');
        }
      }

      const summaries = buildActivitySummaries(allItems);

      // Add error entries for connectors that failed
      for (const [name, errMsg] of errorConnectors) {
        summaries.push({
          connector: name,
          channel: '',
          content: `Error: ${errMsg}`,
          timestamp: '',
          status: 'error',
        });
      }

      // Add idle/disconnected entries for connectors with no data
      for (const name of enabledConnectors) {
        if (!connectorsWithData.has(name)) {
          summaries.push({
            connector: name,
            channel: '',
            content: '',
            timestamp: '',
            status: 'idle',
          });
        }
      }

      res.json({ connectors: summaries });
    })
  );

  // GET /api/connectors/:name/feed?limit=20&since=<ISO>
  // Query rawStore for specific connector, sort desc, limit, group by channel.
  router.get(
    '/:name/feed',
    asyncHandler(async (req, res) => {
      const name = req.params.name as string;
      if (!enabledConnectors.includes(name)) {
        res.status(404).json({ error: `Connector '${name}' is not enabled` });
        return;
      }
      const rawLimit = parseInt((req.query.limit as string) || '20', 10);
      const limit = Math.min(isNaN(rawLimit) || rawLimit < 1 ? 20 : rawLimit, 200);
      const sinceRaw = req.query.since;
      const sinceParam = typeof sinceRaw === 'string' ? sinceRaw : undefined;
      let since: Date;
      if (sinceParam) {
        since = new Date(sinceParam);
        if (isNaN(since.getTime())) {
          res.status(400).json({ error: 'Invalid since parameter' });
          return;
        }
      } else {
        since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      }

      let normalized;
      try {
        normalized = rawStore.query(name, since);
      } catch (err) {
        res.status(500).json({
          error: `Error querying connector ${name}: ${err instanceof Error ? err.message : 'unknown'}`,
        });
        return;
      }

      // Sort descending by timestamp and limit
      const sorted = normalized
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
        .slice(0, limit);

      // Group by channel
      const channelMap = new Map<
        string,
        Array<{
          author: string;
          content: string;
          timestamp: string;
          type: string;
        }>
      >();

      for (const item of sorted) {
        const arr = channelMap.get(item.channel) ?? [];
        arr.push({
          author: item.author,
          content: item.content,
          timestamp: item.timestamp.toISOString(),
          type: item.type,
        });
        channelMap.set(item.channel, arr);
      }

      const feed = Array.from(channelMap.entries()).map(([channel, items]) => ({
        channel,
        items,
      }));

      res.json({ connector: name, feed, itemCount: sorted.length });
    })
  );

  return router;
}
