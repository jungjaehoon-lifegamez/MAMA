import { randomUUID } from 'node:crypto';

import { canonicalizeJSON } from '../canonicalize.js';
import type { DatabaseAdapter } from '../db-manager.js';
import { runImmediateTransaction, type ImmediateTransactionAdapter } from './sqlite-transaction.js';
import type { CaseMembershipSourceType } from './types.js';

export interface SweepStaleCaseMembershipsOptions {
  now?: string;
  limit?: number;
}

export interface SweepStaleCaseMembershipsResult {
  scanned_count: number;
  stale_count: number;
  locked_stale_count: number;
  audit_event_ids: string[];
}

type SweptSourceType = Exclude<CaseMembershipSourceType, 'artifact'>;

type TombstoneSweeperAdapter = Pick<DatabaseAdapter, 'prepare' | 'transaction'> &
  Partial<Pick<ImmediateTransactionAdapter, 'exec'>>;

interface CandidateSourceRow {
  source_type: string;
  source_id: string;
}

interface CountRow {
  count: number;
  locked_count: number | null;
}

interface SourceRow {
  id: string;
}

interface RunResultLike {
  changes: number;
}

const SWEEP_SOURCE_TYPES: SweptSourceType[] = ['decision', 'event', 'observation'];

const SOURCE_EXISTS_SQL: Record<SweptSourceType, string> = {
  decision: 'SELECT 1 AS id FROM decisions WHERE id = ?',
  event: 'SELECT 1 AS id FROM entity_timeline_events WHERE id = ?',
  observation: 'SELECT 1 AS id FROM entity_observations WHERE id = ?',
};

function normalizeNow(value?: string): string {
  return value ?? new Date().toISOString();
}

function createdAtMs(now: string): number {
  const parsed = Date.parse(now);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function isSweptSourceType(value: string): value is SweptSourceType {
  return (SWEEP_SOURCE_TYPES as string[]).includes(value);
}

function readCandidates(
  adapter: TombstoneSweeperAdapter,
  limit: number | undefined
): CandidateSourceRow[] {
  const sql = `
    SELECT source_type, source_id
      FROM case_memberships
     WHERE status IN ('active', 'candidate', 'removed', 'excluded')
       AND source_type IN ('decision', 'event', 'observation')
     GROUP BY source_type, source_id
     ORDER BY source_type ASC, source_id ASC
     ${limit === undefined ? '' : 'LIMIT ?'}
  `;

  const stmt = adapter.prepare(sql);
  return (limit === undefined ? stmt.all() : stmt.all(limit)) as CandidateSourceRow[];
}

function sourceExists(
  adapter: TombstoneSweeperAdapter,
  sourceType: SweptSourceType,
  sourceId: string
): boolean {
  const row = adapter.prepare(SOURCE_EXISTS_SQL[sourceType]).get(sourceId) as SourceRow | undefined;
  return row !== undefined;
}

function countTransitionTargets(
  adapter: TombstoneSweeperAdapter,
  sourceType: SweptSourceType,
  sourceId: string
): CountRow {
  return adapter
    .prepare(
      `
        SELECT COUNT(*) AS count,
               SUM(CASE WHEN user_locked = 1 THEN 1 ELSE 0 END) AS locked_count
          FROM case_memberships
         WHERE status <> 'stale'
           AND source_type = ?
           AND source_id = ?
      `
    )
    .get(sourceType, sourceId) as CountRow;
}

function markSourceStale(
  adapter: TombstoneSweeperAdapter,
  sourceType: SweptSourceType,
  sourceId: string,
  now: string
): number {
  const result = adapter
    .prepare(
      `
        UPDATE case_memberships
           SET status = 'stale',
               updated_at = ?
         WHERE status <> 'stale'
           AND source_type = ?
           AND source_id = ?
           AND NOT EXISTS (${SOURCE_EXISTS_SQL[sourceType]})
      `
    )
    .run(now, sourceType, sourceId, sourceId) as RunResultLike;

  return result.changes;
}

function insertTombstoneAuditEvent(input: {
  adapter: TombstoneSweeperAdapter;
  now: string;
  stale_count: number;
  locked_stale_count: number;
  sources: CandidateSourceRow[];
}): string {
  const eventId = `me_${randomUUID()}`;

  input.adapter
    .prepare(
      `
        INSERT INTO memory_events (
          event_id, event_type, actor, source_turn_id, memory_id, topic,
          scope_refs, evidence_refs, reason, created_at
        )
        VALUES (?, 'case.membership_tombstoned', 'system', NULL, NULL, ?, ?, ?, ?, ?)
      `
    )
    .run(
      eventId,
      'case:tombstone-sweeper',
      canonicalizeJSON([{ kind: 'project', id: 'case-first' }]),
      canonicalizeJSON(input.sources),
      canonicalizeJSON({
        stale_count: input.stale_count,
        locked_stale_count: input.locked_stale_count,
      }),
      createdAtMs(input.now)
    );

  return eventId;
}

export function sweepStaleCaseMemberships(
  adapter: DatabaseAdapter,
  options: SweepStaleCaseMembershipsOptions = {}
): SweepStaleCaseMembershipsResult {
  const sweepAdapter = adapter as unknown as TombstoneSweeperAdapter;

  return runImmediateTransaction(sweepAdapter, () => {
    const now = normalizeNow(options.now);
    const candidates = readCandidates(sweepAdapter, options.limit);
    let staleCount = 0;
    let lockedStaleCount = 0;
    const tombstonedSources: CandidateSourceRow[] = [];

    for (const candidate of candidates) {
      if (!isSweptSourceType(candidate.source_type)) {
        continue;
      }

      if (sourceExists(sweepAdapter, candidate.source_type, candidate.source_id)) {
        continue;
      }

      const before = countTransitionTargets(
        sweepAdapter,
        candidate.source_type,
        candidate.source_id
      );
      if (before.count === 0) {
        continue;
      }

      const changes = markSourceStale(
        sweepAdapter,
        candidate.source_type,
        candidate.source_id,
        now
      );
      if (changes === 0) {
        continue;
      }

      staleCount += changes;
      lockedStaleCount += Math.min(changes, before.locked_count ?? 0);
      tombstonedSources.push(candidate);
    }

    const auditEventIds =
      staleCount > 0
        ? [
            insertTombstoneAuditEvent({
              adapter: sweepAdapter,
              now,
              stale_count: staleCount,
              locked_stale_count: lockedStaleCount,
              sources: tombstonedSources,
            }),
          ]
        : [];

    return {
      scanned_count: candidates.length,
      stale_count: staleCount,
      locked_stale_count: lockedStaleCount,
      audit_event_ids: auditEventIds,
    };
  });
}
