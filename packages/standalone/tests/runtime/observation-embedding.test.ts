import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readObservationEmbeddings } from '@jungjaehoon/mama-core/knowledge';
import { upsertConnectorEventIndex } from '../../src/connectors/framework/event-index.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import {
  countPendingObservations,
  embedPendingObservations,
  startObservationEmbedder,
  type ObservationEmbeddingEvent,
} from '../../src/runtime/observation-embedding.js';

describe('observation embedding', () => {
  let root: string;
  let database: Awaited<ReturnType<typeof openCoreDatabase>>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'observation-embedding-'));
    database = await openCoreDatabase({ path: join(root, 'core.db') });
  });

  afterEach(async () => {
    await database?.close();
    rmSync(root, { recursive: true, force: true });
  });

  function seed(sourceId: string, content: string, eventMs: number) {
    return upsertConnectorEventIndex(database.adapter, {
      source_connector: 'connector-test',
      source_type: 'message',
      source_id: sourceId,
      channel: 'channel-test',
      content,
      event_datetime: eventMs,
      observation: { observed_at: eventMs },
    });
  }

  it('embeds current observations newest first, once each', async () => {
    seed('old', 'older message', 100);
    const superseded = seed('edited', 'first wording', 200);
    const current = seed('edited', 'second wording', 200);
    seed('new', 'newest message', 300);
    const embedded: string[] = [];
    const embed = async (text: string) => {
      embedded.push(text);
      return new Float32Array([1, 0]);
    };

    expect(countPendingObservations(database.adapter)).toBe(3);
    expect(await embedPendingObservations(database.adapter, embed, 2)).toBe(2);
    expect(embedded).toEqual(['newest message', 'second wording']);
    expect(await embedPendingObservations(database.adapter, embed, 2)).toBe(1);
    expect(await embedPendingObservations(database.adapter, embed, 2)).toBe(0);
    expect(embedded).toEqual(['newest message', 'second wording', 'older message']);

    const vectors = readObservationEmbeddings(database.adapter, [
      superseded.current_observation_id!,
      current.current_observation_id!,
    ]);
    expect([...vectors.keys()]).toEqual([current.current_observation_id]);
  });

  it('fails loudly when the embedder is in its no-vector mode', async () => {
    seed('message', 'some text', 100);
    await expect(embedPendingObservations(database.adapter, async () => null, 8)).rejects.toThrow(
      /no-vector mode/
    );
  });

  it('reports the backlog, works through it, and reports when it has caught up', async () => {
    for (let index = 0; index < 5; index += 1) seed(`m-${index}`, `message ${index}`, index);
    const events: ObservationEmbeddingEvent[] = [];
    let caughtUp!: () => void;
    const done = new Promise<void>((resolve) => (caughtUp = resolve));
    const embedder = startObservationEmbedder({
      adapter: database.adapter,
      embed: async () => new Float32Array([1]),
      everyMs: 60_000,
      batch: 2,
      onEvent: (event) => {
        events.push(event);
        if (event.kind === 'caught_up') caughtUp();
      },
    });
    await done;
    await embedder.stop();

    expect(events).toMatchObject([
      { kind: 'backlog', pending: 5 },
      { kind: 'caught_up', embedded: 5 },
    ]);
    expect(countPendingObservations(database.adapter)).toBe(0);
  });

  it('reports a failure and keeps running', async () => {
    seed('message', 'some text', 100);
    const events: ObservationEmbeddingEvent[] = [];
    let failed!: () => void;
    const done = new Promise<void>((resolve) => (failed = resolve));
    const embedder = startObservationEmbedder({
      adapter: database.adapter,
      embed: async () => {
        throw new Error('model unavailable');
      },
      everyMs: 60_000,
      batch: 2,
      onEvent: (event) => {
        events.push(event);
        if (event.kind === 'failed') failed();
      },
    });
    await done;
    await embedder.stop();
    expect(events.at(-1)).toMatchObject({ kind: 'failed', error: new Error('model unavailable') });
  });
});
