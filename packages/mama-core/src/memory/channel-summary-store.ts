import { getAdapter, initDB } from '../db-manager.js';
import type { ChannelSummaryRecord } from './types.js';

function toChannelSummary(row: Record<string, unknown>): ChannelSummaryRecord {
  return {
    channel_key: String(row.channel_key),
    summary_markdown: String(row.summary_markdown),
    delta_hash: typeof row.delta_hash === 'string' ? row.delta_hash : undefined,
    updated_at: Number(row.updated_at),
  };
}

export async function upsertChannelSummary(input: {
  channelKey: string;
  summaryMarkdown: string;
  deltaHash?: string;
}): Promise<void> {
  await initDB();
  const adapter = getAdapter();

  adapter
    .prepare(
      `
        INSERT OR REPLACE INTO channel_summaries (
          channel_key,
          summary_markdown,
          delta_hash,
          updated_at
        )
        VALUES (?, ?, ?, ?)
      `
    )
    .run(input.channelKey, input.summaryMarkdown, input.deltaHash ?? null, Date.now());
}

export async function getChannelSummary(channelKey: string): Promise<ChannelSummaryRecord | null> {
  await initDB();
  const adapter = getAdapter();

  const row = adapter
    .prepare(
      `
        SELECT channel_key, summary_markdown, delta_hash, updated_at
        FROM channel_summaries
        WHERE channel_key = ?
      `
    )
    .get(channelKey) as Record<string, unknown> | undefined;

  return row ? toChannelSummary(row) : null;
}
