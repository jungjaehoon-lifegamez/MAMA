import crypto from 'node:crypto';

import { getAdapter, initDB } from '../db-manager.js';
import type { MemoryEventRecord } from './types.js';

function deserializeEvent(row: Record<string, unknown>): MemoryEventRecord {
  return {
    event_id: String(row.event_id),
    event_type: row.event_type as MemoryEventRecord['event_type'],
    actor: row.actor as MemoryEventRecord['actor'],
    source_turn_id:
      typeof row.source_turn_id === 'string' && row.source_turn_id.length > 0
        ? row.source_turn_id
        : undefined,
    memory_id:
      typeof row.memory_id === 'string' && row.memory_id.length > 0 ? row.memory_id : undefined,
    topic: typeof row.topic === 'string' && row.topic.length > 0 ? row.topic : undefined,
    scope_refs: JSON.parse(String(row.scope_refs)) as MemoryEventRecord['scope_refs'],
    evidence_refs:
      typeof row.evidence_refs === 'string'
        ? (JSON.parse(row.evidence_refs) as string[])
        : undefined,
    reason: typeof row.reason === 'string' ? row.reason : undefined,
    created_at: Number(row.created_at),
  };
}

export async function appendMemoryEvent(
  input: Omit<MemoryEventRecord, 'event_id'>
): Promise<string> {
  await initDB();
  const adapter = getAdapter();
  const eventId = `evt_${crypto.randomUUID().replace(/-/g, '')}`;

  adapter
    .prepare(
      `
        INSERT INTO memory_events (
          event_id, event_type, actor, source_turn_id, memory_id, topic,
          scope_refs, evidence_refs, reason, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      eventId,
      input.event_type,
      input.actor,
      input.source_turn_id ?? null,
      input.memory_id ?? null,
      input.topic ?? null,
      JSON.stringify(input.scope_refs),
      input.evidence_refs ? JSON.stringify(input.evidence_refs) : null,
      input.reason ?? null,
      input.created_at
    );

  return eventId;
}

export async function listMemoryEventsForTopic(topic: string): Promise<MemoryEventRecord[]> {
  await initDB();
  const adapter = getAdapter();

  const rows = adapter
    .prepare(
      `
        SELECT event_id, event_type, actor, source_turn_id, memory_id, topic,
               scope_refs, evidence_refs, reason, created_at
        FROM memory_events
        WHERE topic = ?
        ORDER BY created_at DESC
      `
    )
    .all(topic) as Record<string, unknown>[];

  return rows.map(deserializeEvent);
}

export async function listRecentMemoryEvents(limit = 10): Promise<MemoryEventRecord[]> {
  await initDB();
  const adapter = getAdapter();

  const rows = adapter
    .prepare(
      `
        SELECT event_id, event_type, actor, source_turn_id, memory_id, topic,
               scope_refs, evidence_refs, reason, created_at
        FROM memory_events
        ORDER BY created_at DESC
        LIMIT ?
      `
    )
    .all(limit) as Record<string, unknown>[];

  return rows.map(deserializeEvent);
}
