import type { MemoryRecord, ProfileSnapshot } from './types.js';

function isStaticMemory(record: MemoryRecord): boolean {
  return record.kind === 'preference' || record.kind === 'constraint';
}

export function classifyProfileEntries(records: MemoryRecord[]): ProfileSnapshot {
  const active = records.filter((record) => record.status === 'active');
  const staticEntries = active.filter(isStaticMemory);
  const dynamicEntries = active.filter((record) => !isStaticMemory(record));

  return {
    static: staticEntries,
    dynamic: dynamicEntries,
    evidence: active.map((record) => ({
      memory_id: record.id,
      topic: record.topic,
      why_included: isStaticMemory(record)
        ? 'Long-term preference or constraint'
        : 'Current active context',
    })),
  };
}
