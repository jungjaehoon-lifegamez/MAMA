import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getAdapter, type DatabaseAdapter } from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import { assembleCase } from '../../src/cases/store.js';
import { sweepStaleCaseMemberships } from '../../src/cases/tombstone-sweeper.js';

const NOW = '2026-04-18T03:00:00.000Z';

function resetTables(): void {
  const adapter = getAdapter();
  adapter.prepare('DELETE FROM memory_events').run();
  adapter.prepare('DELETE FROM case_corrections').run();
  adapter.prepare('DELETE FROM case_memberships').run();
  adapter.prepare('DELETE FROM case_truth').run();
  adapter.prepare('DELETE FROM decision_entity_sources').run();
  adapter.prepare('DELETE FROM decisions').run();
  adapter.prepare('DELETE FROM entity_timeline_events').run();
  adapter.prepare('DELETE FROM entity_observations').run();
  adapter.prepare('DELETE FROM entity_nodes').run();
}

function insertCase(caseId: string): void {
  getAdapter()
    .prepare(
      `
        INSERT INTO case_truth (case_id, title, status, created_at, updated_at)
        VALUES (?, ?, 'active', ?, ?)
      `
    )
    .run(caseId, caseId, NOW, NOW);
}

function insertDecision(decisionId: string): void {
  getAdapter()
    .prepare(
      `
        INSERT INTO decisions (
          id, topic, decision, reasoning, confidence, user_involvement, status, created_at,
          updated_at
        )
        VALUES (?, 'case/tombstone', 'Seed decision', 'test', 0.9, 'approved', 'active', ?, ?)
      `
    )
    .run(decisionId, NOW, NOW);
}

function insertEntityNode(): void {
  getAdapter()
    .prepare(
      `
        INSERT OR IGNORE INTO entity_nodes (
          id, kind, preferred_label, status, created_at, updated_at
        )
        VALUES ('ent-sweep', 'project', 'Sweep', 'active', unixepoch() * 1000, unixepoch() * 1000)
      `
    )
    .run();
}

function insertEvent(eventId: string): void {
  insertEntityNode();
  getAdapter()
    .prepare(
      `
        INSERT INTO entity_timeline_events (
          id, entity_id, event_type, summary, observed_at, created_at
        )
        VALUES (?, 'ent-sweep', 'decision_made', 'Seed event', unixepoch() * 1000,
                unixepoch() * 1000)
      `
    )
    .run(eventId);
}

function insertObservation(observationId: string): void {
  getAdapter()
    .prepare(
      `
        INSERT INTO entity_observations (
          id, surface_form, normalized_form, related_surface_forms, extractor_version,
          source_connector, source_raw_record_id, source_locator, created_at
        )
        VALUES (?, 'Sweep observation', 'sweep observation', '[]', 'test', 'slack', ?, ?,
                unixepoch() * 1000)
      `
    )
    .run(observationId, `raw-${observationId}`, `slack://sweep/${observationId}`);
}

function insertMembership(input: {
  case_id: string;
  source_type: 'decision' | 'event' | 'observation' | 'artifact';
  source_id: string;
  status?: 'active' | 'candidate' | 'removed' | 'excluded' | 'stale';
  user_locked?: 0 | 1;
  updated_at?: string;
}): void {
  getAdapter()
    .prepare(
      `
        INSERT INTO case_memberships (
          case_id, source_type, source_id, role, confidence, reason, status, added_by,
          added_at, updated_at, user_locked
        )
        VALUES (?, ?, ?, 'supporting', 0.8, 'seeded', ?, 'wiki-compiler', ?, ?, ?)
      `
    )
    .run(
      input.case_id,
      input.source_type,
      input.source_id,
      input.status ?? 'active',
      NOW,
      input.updated_at ?? NOW,
      input.user_locked ?? 0
    );
}

function membershipRow(
  caseId: string,
  sourceId: string
): { status: string; updated_at: string; user_locked: number } {
  return getAdapter()
    .prepare(
      `
        SELECT status, updated_at, user_locked
          FROM case_memberships
         WHERE case_id = ?
           AND source_id = ?
      `
    )
    .get(caseId, sourceId) as { status: string; updated_at: string; user_locked: number };
}

function interceptStaleUpdate(onUpdate: (args: unknown[]) => void): DatabaseAdapter {
  const base = getAdapter() as unknown as {
    prepare: DatabaseAdapter['prepare'];
    transaction: DatabaseAdapter['transaction'];
    exec?: (sql: string) => void;
  };

  return {
    prepare(sql: string) {
      const stmt = base.prepare(sql);
      if (sql.includes('UPDATE case_memberships') && sql.includes("status = 'stale'")) {
        return {
          all: (...args: unknown[]) => stmt.all(...args),
          get: (...args: unknown[]) => stmt.get(...args),
          run: (...args: unknown[]) => {
            onUpdate(args);
            return stmt.run(...args);
          },
        };
      }
      return stmt;
    },
    transaction: base.transaction.bind(base),
    exec: base.exec?.bind(base),
  } as unknown as DatabaseAdapter;
}

describe('Story CF2.8: stale case membership tombstone sweeper', () => {
  let testDbPath = '';

  beforeAll(async () => {
    process.env.MAMA_FORCE_TIER_3 = 'true';
    testDbPath = await initTestDB('case-tombstone-sweeper');
  });

  beforeEach(resetTables);

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  it('deleted decision membership becomes stale and emits an audit event', () => {
    insertCase('case-decision');
    insertDecision('dec-deleted');
    insertMembership({
      case_id: 'case-decision',
      source_type: 'decision',
      source_id: 'dec-deleted',
    });
    getAdapter().prepare('DELETE FROM decisions WHERE id = ?').run('dec-deleted');

    const result = sweepStaleCaseMemberships(getAdapter(), { now: NOW });

    expect(result).toMatchObject({ scanned_count: 1, stale_count: 1, locked_stale_count: 0 });
    expect(result.audit_event_ids).toHaveLength(1);
    expect(membershipRow('case-decision', 'dec-deleted')).toMatchObject({
      status: 'stale',
      user_locked: 0,
      updated_at: NOW,
    });
    expect(getAdapter().prepare('SELECT event_type FROM memory_events').get()).toMatchObject({
      event_type: 'case.membership_tombstoned',
    });
  });

  it('deleted event membership becomes stale', () => {
    insertCase('case-event');
    insertEvent('evt-deleted');
    insertMembership({ case_id: 'case-event', source_type: 'event', source_id: 'evt-deleted' });
    getAdapter().prepare('DELETE FROM entity_timeline_events WHERE id = ?').run('evt-deleted');

    const result = sweepStaleCaseMemberships(getAdapter(), { now: NOW });

    expect(result.stale_count).toBe(1);
    expect(membershipRow('case-event', 'evt-deleted').status).toBe('stale');
  });

  it('deleted observation membership becomes stale', () => {
    insertCase('case-observation');
    insertObservation('obs-deleted');
    insertMembership({
      case_id: 'case-observation',
      source_type: 'observation',
      source_id: 'obs-deleted',
    });
    getAdapter().prepare('DELETE FROM entity_observations WHERE id = ?').run('obs-deleted');

    const result = sweepStaleCaseMemberships(getAdapter(), { now: NOW });

    expect(result.stale_count).toBe(1);
    expect(membershipRow('case-observation', 'obs-deleted').status).toBe('stale');
  });

  it('artifact memberships are ignored in Phase 2', () => {
    insertCase('case-artifact');
    insertMembership({
      case_id: 'case-artifact',
      source_type: 'artifact',
      source_id: 'artifact-missing',
    });

    const result = sweepStaleCaseMemberships(getAdapter(), { now: NOW });

    expect(result).toMatchObject({ scanned_count: 0, stale_count: 0 });
    expect(membershipRow('case-artifact', 'artifact-missing').status).toBe('active');
  });

  it('preserves user_locked when tombstoning a locked membership', () => {
    insertCase('case-locked');
    insertMembership({
      case_id: 'case-locked',
      source_type: 'decision',
      source_id: 'dec-locked-missing',
      user_locked: 1,
    });

    const result = sweepStaleCaseMemberships(getAdapter(), { now: NOW });

    expect(result.locked_stale_count).toBe(1);
    expect(membershipRow('case-locked', 'dec-locked-missing')).toMatchObject({
      status: 'stale',
      user_locked: 1,
    });
  });

  it('already stale rows do not churn updated_at', () => {
    insertCase('case-idempotent');
    insertMembership({
      case_id: 'case-idempotent',
      source_type: 'decision',
      source_id: 'dec-already-stale',
      status: 'stale',
      updated_at: '2026-04-17T00:00:00.000Z',
    });

    const result = sweepStaleCaseMemberships(getAdapter(), { now: NOW });

    expect(result).toMatchObject({ scanned_count: 0, stale_count: 0 });
    expect(membershipRow('case-idempotent', 'dec-already-stale').updated_at).toBe(
      '2026-04-17T00:00:00.000Z'
    );
  });

  it('case_assemble no longer surfaces stale rows', () => {
    insertCase('case-assemble-stale');
    insertDecision('dec-stale-assemble');
    insertMembership({
      case_id: 'case-assemble-stale',
      source_type: 'decision',
      source_id: 'dec-stale-assemble',
    });
    getAdapter().prepare('DELETE FROM decisions WHERE id = ?').run('dec-stale-assemble');

    sweepStaleCaseMemberships(getAdapter(), { now: NOW });

    const assembly = assembleCase(getAdapter(), 'case-assemble-stale');
    expect(assembly.memberships).toEqual([]);
    expect(assembly.decisions).toEqual([]);
  });

  it('source restored between candidate read and UPDATE is protected by NOT EXISTS', () => {
    insertCase('case-race-restore');
    insertMembership({
      case_id: 'case-race-restore',
      source_type: 'decision',
      source_id: 'dec-race-restore',
    });

    let restored = false;
    const adapter = interceptStaleUpdate((args) => {
      if (!restored && args[2] === 'dec-race-restore') {
        insertDecision('dec-race-restore');
        restored = true;
      }
    });

    const result = sweepStaleCaseMemberships(adapter, { now: NOW });

    expect(restored).toBe(true);
    expect(result.stale_count).toBe(0);
    expect(membershipRow('case-race-restore', 'dec-race-restore').status).toBe('active');
  });

  it('restoring a source after tombstone does not auto-reactivate membership', () => {
    insertCase('case-restore-after');
    insertMembership({
      case_id: 'case-restore-after',
      source_type: 'decision',
      source_id: 'dec-restore-after',
    });

    sweepStaleCaseMemberships(getAdapter(), { now: NOW });
    insertDecision('dec-restore-after');
    const second = sweepStaleCaseMemberships(getAdapter(), { now: '2026-04-18T04:00:00.000Z' });

    expect(second.stale_count).toBe(0);
    expect(membershipRow('case-restore-after', 'dec-restore-after')).toMatchObject({
      status: 'stale',
      updated_at: NOW,
    });
  });

  it('compiler-style upsert during sweep is deterministic and never clears a lock', () => {
    insertCase('case-race-upsert');
    insertMembership({
      case_id: 'case-race-upsert',
      source_type: 'decision',
      source_id: 'dec-race-upsert',
      user_locked: 1,
    });

    let compilerRan = false;
    const adapter = interceptStaleUpdate((args) => {
      if (!compilerRan && args[2] === 'dec-race-upsert') {
        insertDecision('dec-race-upsert');
        getAdapter()
          .prepare(
            `
              INSERT INTO case_memberships (
                case_id, source_type, source_id, role, confidence, reason, status, added_by,
                added_at, updated_at, user_locked
              )
              VALUES ('case-race-upsert', 'decision', 'dec-race-upsert', 'primary', 1,
                      'compiler restored', 'active', 'wiki-compiler', ?, ?, 0)
              ON CONFLICT(case_id, source_type, source_id) DO UPDATE SET
                role = excluded.role,
                confidence = excluded.confidence,
                reason = excluded.reason,
                status = 'active',
                added_by = 'wiki-compiler',
                updated_at = excluded.updated_at
              WHERE case_memberships.user_locked = 0
            `
          )
          .run(NOW, NOW);
        compilerRan = true;
      }
    });

    const result = sweepStaleCaseMemberships(adapter, { now: NOW });

    expect(result.stale_count).toBe(0);
    expect(membershipRow('case-race-upsert', 'dec-race-upsert')).toMatchObject({
      status: 'active',
      user_locked: 1,
    });
  });
});
