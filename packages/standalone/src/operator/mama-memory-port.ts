/**
 * createMamaMemoryPort - the real OperatorMemoryPort binding (M1-T0).
 *
 * recall -> mama-core recallMemory (memory/api.ts:1118), mapping RecallBundle.memories
 * (MemoryRecord: topic + summary) into the port's {topic, content} shape.
 * save -> mama-core saveMemory (operator-authored notes; decision kind, global scope).
 *
 * Pure adapter: no judgment, no filtering beyond the mechanical mapping. The agent's
 * memoryQuery decides what is recalled (trigger-fire.ts).
 */

import { recallMemory, saveMemory } from '@jungjaehoon/mama-core';
import type { OperatorMemoryPort } from './operator-interfaces.js';

export function createMamaMemoryPort(): OperatorMemoryPort {
  return {
    async recall(query, opts) {
      const bundle = await recallMemory(query, { limit: opts?.limit ?? 5 });
      return bundle.memories.map((m) => ({ topic: m.topic, content: m.summary }));
    },

    async save(input) {
      await saveMemory({
        topic: input.topic,
        kind: 'decision',
        summary: input.content,
        details: input.content,
        scopes: (input.scopes as { kind: 'project' | 'user' | 'channel' | 'global'; id: string }[] | undefined) ?? [
          { kind: 'global', id: 'global' },
        ],
        source: { package: 'standalone', source_type: 'operator-trigger-loop' },
      });
    },
  };
}
