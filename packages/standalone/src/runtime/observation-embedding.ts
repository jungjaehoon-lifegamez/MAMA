/**
 * Passage vectors for stored source observations, so `source.search` can find a message by
 * meaning: a Korean query reaches a Japanese message about the same thing (W32.1).
 *
 * Only an index row's current observation is embedded; a superseded version is not searched.
 * The newest messages are embedded first, so live traffic is findable before the backfill ends.
 */
import { saveObservationEmbedding } from '@jungjaehoon/mama-core/knowledge';
import type { DatabaseAdapter } from '@jungjaehoon/mama-core/db-manager';

type EmbedPassage = (text: string) => Promise<Float32Array | null>;

export type ObservationEmbeddingEvent =
  | { kind: 'backlog'; pending: number }
  | { kind: 'caught_up'; embedded: number; elapsedMs: number }
  | { kind: 'failed'; error: unknown };

export interface ObservationEmbedderOptions {
  adapter: Pick<DatabaseAdapter, 'prepare'>;
  embed: EmbedPassage;
  /** Wait between checks once the backlog is empty. */
  everyMs: number;
  batch: number;
  onEvent?: (event: ObservationEmbeddingEvent) => void;
}

const PENDING_FROM = `FROM connector_event_index e
  LEFT JOIN observation_embeddings v ON v.observation_id = e.current_observation_id
  WHERE e.current_observation_id IS NOT NULL AND v.observation_id IS NULL
    AND trim(coalesce(e.content, '')) != ''`;

export function countPendingObservations(adapter: Pick<DatabaseAdapter, 'prepare'>): number {
  const row = adapter.prepare(`SELECT COUNT(*) AS n ${PENDING_FROM}`).get() as { n: number };
  return Number(row.n);
}

/** Embed up to `batch` current observations that have no vector; returns how many it embedded. */
export async function embedPendingObservations(
  adapter: Pick<DatabaseAdapter, 'prepare'>,
  embed: EmbedPassage,
  batch: number
): Promise<number> {
  const rows = adapter
    .prepare(
      `SELECT e.current_observation_id AS id, e.content ${PENDING_FROM}
        ORDER BY COALESCE(e.event_datetime, e.source_timestamp_ms) DESC
        LIMIT ?`
    )
    .all(batch) as Array<{ id: string; content: string }>;
  for (const row of rows) {
    const vector = await embed(row.content);
    if (vector === null) {
      throw new Error('Observation embedding needs vectors, but the embedder is in no-vector mode');
    }
    saveObservationEmbedding(adapter, row.id, vector);
  }
  return rows.length;
}

/**
 * Embed the backlog, then keep up with new observations. Batches run back to back while a
 * backlog remains; a failure is reported and retried on the next check.
 */
export function startObservationEmbedder(options: ObservationEmbedderOptions): {
  stop(): Promise<void>;
} {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let backlogStartedAt: number | null = null;
  let embeddedInBacklog = 0;

  const tick = async (): Promise<void> => {
    let full = false;
    try {
      if (backlogStartedAt === null) {
        const pending = countPendingObservations(options.adapter);
        if (pending > 0) {
          backlogStartedAt = Date.now();
          embeddedInBacklog = 0;
          options.onEvent?.({ kind: 'backlog', pending });
        }
      }
      if (backlogStartedAt !== null) {
        const embedded = await embedPendingObservations(
          options.adapter,
          options.embed,
          options.batch
        );
        embeddedInBacklog += embedded;
        full = embedded === options.batch;
        if (!full) {
          options.onEvent?.({
            kind: 'caught_up',
            embedded: embeddedInBacklog,
            elapsedMs: Date.now() - backlogStartedAt,
          });
          backlogStartedAt = null;
        }
      }
    } catch (error) {
      options.onEvent?.({ kind: 'failed', error });
    }
    if (!stopped) schedule(full ? 0 : options.everyMs);
  };

  const schedule = (delayMs: number): void => {
    timer = setTimeout(() => {
      running = tick();
    }, delayMs);
    timer.unref();
  };

  schedule(0);
  return {
    stop: async () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await running;
    },
  };
}
