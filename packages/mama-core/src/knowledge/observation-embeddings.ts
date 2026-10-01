/**
 * Vectors for observations, so a search can match meaning as well as text.
 *
 * The consumer decides which observations to embed and what text stands for each; core only
 * stores one passage vector per observation and reads them back. Search over them belongs to the
 * consumer, which already holds the filters (source, channel, time) a hit must pass.
 */
import type { DatabaseAdapter } from '../db-manager.js';

type EmbeddingAdapter = Pick<DatabaseAdapter, 'prepare'>;

/** Store (or replace) the vector for one observation. The observation must exist. */
export function saveObservationEmbedding(
  adapter: EmbeddingAdapter,
  observationId: string,
  vector: Float32Array,
  embeddedAt: number = Date.now()
): void {
  if (observationId.trim() === '') throw new Error('Observation embedding needs an observation id');
  if (vector.length === 0) throw new Error('Observation embedding needs a vector');
  adapter
    .prepare(
      `INSERT OR REPLACE INTO observation_embeddings (observation_id, embedding, embedded_at)
       VALUES (?, ?, ?)`
    )
    .run(
      observationId,
      Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
      embeddedAt
    );
}

/** The stored vectors of these observations; ids without one are absent from the map. */
export function readObservationEmbeddings(
  adapter: EmbeddingAdapter,
  observationIds: readonly string[]
): Map<string, Float32Array> {
  const vectors = new Map<string, Float32Array>();
  // SQLite's default bound-parameter limit is 999 in older builds; read in pages below it.
  for (let start = 0; start < observationIds.length; start += 500) {
    const page = observationIds.slice(start, start + 500);
    const rows = adapter
      .prepare(
        `SELECT observation_id, embedding FROM observation_embeddings
          WHERE observation_id IN (${page.map(() => '?').join(',')})`
      )
      .all(...page) as Array<{ observation_id: string; embedding: Uint8Array }>;
    for (const row of rows) {
      // A fresh copy starts at offset 0, which a Float32Array view requires.
      const bytes = new Uint8Array(row.embedding);
      vectors.set(row.observation_id, new Float32Array(bytes.buffer));
    }
  }
  return vectors;
}
