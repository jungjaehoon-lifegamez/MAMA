/** Recent delivered chat exchanges, the checkpoint and the latest decisions for a new session. */
import type { MemoryRecord } from '@jungjaehoon/mama-core';
import type { SessionStartExchange, SessionStartInput } from './turn-orders.js';

const RECENT = 10;

export async function readSessionStartInput(ports: {
  exchanges: readonly SessionStartExchange[];
  /** The owner's active memory records, without amendments (as recall shows them), in any order. */
  records: () => Promise<readonly MemoryRecord[]>;
  /** The latest session checkpoint the agent saved, if any; `createdAt` in epoch ms. */
  checkpoint: () => Promise<{ summary: string; nextSteps: string; createdAt: number } | null>;
  now: number;
}): Promise<SessionStartInput> {
  const records = [...(await ports.records())];
  const checkpoint = await ports.checkpoint();
  const createdAt = (value: number | string): number =>
    typeof value === 'number' ? value : Date.parse(value);
  return {
    exchanges: [...ports.exchanges],
    decisions: records
      .sort((a, b) => createdAt(b.created_at) - createdAt(a.created_at))
      .slice(0, RECENT)
      .map((record) => ({
        topic: record.topic,
        summary: record.summary,
        ageHours: (ports.now - createdAt(record.created_at)) / 3_600_000,
      })),
    checkpoint:
      checkpoint === null
        ? null
        : {
            summary: checkpoint.summary,
            nextSteps: checkpoint.nextSteps,
            ageHours: (ports.now - checkpoint.createdAt) / 3_600_000,
          },
  };
}
