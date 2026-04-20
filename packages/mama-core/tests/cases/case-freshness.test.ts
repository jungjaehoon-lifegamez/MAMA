import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canonicalizeJSON } from '../../src/canonicalize.js';
import { getAdapter } from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';
import {
  calculateCaseFreshness,
  listDriftedCases,
  sweepCaseFreshness,
} from '../../src/cases/freshness.js';
import { insertCaseCorrectionLock } from '../../src/cases/corrections.js';
import { buildCaseFieldTargetRef } from '../../src/cases/target-ref.js';

function resetCaseTables(): void {
  const adapter = getAdapter();
  adapter.prepare('DELETE FROM memory_events').run();
  adapter.prepare('DELETE FROM wiki_page_embeddings').run();
  adapter.prepare('DELETE FROM wiki_page_index').run();
  adapter.prepare('DELETE FROM case_links').run();
  adapter.prepare('DELETE FROM case_corrections').run();
  adapter.prepare('DELETE FROM case_memberships').run();
  adapter.prepare('DELETE FROM case_truth').run();
}

function insertCase(
  overrides: Partial<{
    case_id: string;
    title: string;
    status: string;
    current_wiki_path: string | null;
    last_activity_at: string | null;
    state_updated_at: string | null;
    compiled_at: string | null;
    status_reason: string | null;
    canonical_case_id: string | null;
    created_at: string;
    updated_at: string;
  }>
): void {
  const now = '2026-04-18T00:00:00.000Z';
  getAdapter()
    .prepare(
      `
        INSERT INTO case_truth (
          case_id, current_wiki_path, title, status, status_reason, last_activity_at,
          state_updated_at, compiled_at, canonical_case_id, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      overrides.case_id,
      overrides.current_wiki_path ?? null,
      overrides.title ?? overrides.case_id,
      overrides.status ?? 'active',
      overrides.status_reason ?? null,
      overrides.last_activity_at ?? null,
      overrides.state_updated_at ?? null,
      overrides.compiled_at ?? null,
      overrides.canonical_case_id ?? null,
      overrides.created_at ?? now,
      overrides.updated_at ?? now
    );
}

function insertWikiIndex(caseId: string, updatedAt = '2026-04-18T02:00:00.000Z'): void {
  getAdapter()
    .prepare(
      `
        INSERT INTO wiki_page_index (
          page_id, source_type, source_locator, case_id, title, page_type,
          content, confidence, compiled_at, updated_at
        )
        VALUES (?, 'wiki_page', ?, ?, ?, 'case', 'content', 'high', ?, ?)
      `
    )
    .run(`page-${caseId}`, `Cases/${caseId}.md`, caseId, `Case ${caseId}`, updatedAt, updatedAt);
}

function freshnessRow(caseId: string): {
  freshness_score: number | null;
  freshness_state: string | null;
  freshness_score_is_drifted: number;
  freshness_drift_threshold: number | null;
  freshness_checked_at: string | null;
  freshness_reason_json: string | null;
  status_reason: string | null;
} {
  return getAdapter()
    .prepare(
      `
        SELECT freshness_score, freshness_state, freshness_score_is_drifted,
               freshness_drift_threshold, freshness_checked_at, freshness_reason_json,
               status_reason
        FROM case_truth
        WHERE case_id = ?
      `
    )
    .get(caseId) as {
    freshness_score: number | null;
    freshness_state: string | null;
    freshness_score_is_drifted: number;
    freshness_drift_threshold: number | null;
    freshness_checked_at: string | null;
    freshness_reason_json: string | null;
    status_reason: string | null;
  };
}

describe('Task 15: Wiki freshness core helper', () => {
  let testDbPath = '';

  beforeAll(async () => {
    process.env.MAMA_FORCE_TIER_3 = 'true';
    testDbPath = await initTestDB('case-freshness');
  });

  beforeEach(() => {
    resetCaseTables();
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  it('classifies fresh when compile is after activity', () => {
    const result = calculateCaseFreshness({
      last_activity_at: '2026-04-18T00:00:00.000Z',
      state_updated_at: '2026-04-18T00:30:00.000Z',
      compiled_at: '2026-04-18T01:00:00.000Z',
      wiki_index_updated_at: '2026-04-18T01:05:00.000Z',
      current_wiki_path: 'Cases/Fresh.md',
    });

    expect(result).toMatchObject({
      freshness_score: 1,
      freshness_state: 'fresh',
      freshness_score_is_drifted: 0,
    });
  });

  it('classifies stale when activity is after compile', () => {
    const result = calculateCaseFreshness({
      last_activity_at: '2026-04-18T02:00:00.000Z',
      state_updated_at: '2026-04-18T00:30:00.000Z',
      compiled_at: '2026-04-18T01:00:00.000Z',
      wiki_index_updated_at: '2026-04-18T01:05:00.000Z',
      current_wiki_path: 'Cases/Stale.md',
    });

    expect(result).toMatchObject({
      freshness_score: 0.65,
      freshness_state: 'stale',
      freshness_score_is_drifted: 0,
    });
  });

  it('classifies drifted below the default threshold', () => {
    const result = calculateCaseFreshness({
      last_activity_at: '2026-04-18T02:00:00.000Z',
      state_updated_at: '2026-04-18T02:30:00.000Z',
      compiled_at: '2026-04-18T01:00:00.000Z',
      wiki_index_updated_at: null,
      current_wiki_path: 'Cases/Drifted.md',
    });

    expect(result).toMatchObject({
      freshness_score: 0.15,
      freshness_state: 'drifted',
      freshness_score_is_drifted: 1,
      freshness_drift_threshold: 0.5,
    });
  });

  it('custom drift_threshold changes classification', () => {
    const baseInput = {
      last_activity_at: '2026-04-18T02:00:00.000Z',
      state_updated_at: '2026-04-18T00:30:00.000Z',
      compiled_at: '2026-04-18T01:00:00.000Z',
      wiki_index_updated_at: '2026-04-18T01:05:00.000Z',
      current_wiki_path: 'Cases/Threshold.md',
    };

    expect(calculateCaseFreshness({ ...baseInput, drift_threshold: 0.7 }).freshness_state).toBe(
      'drifted'
    );
    expect(calculateCaseFreshness({ ...baseInput, drift_threshold: 0.5 }).freshness_state).toBe(
      'stale'
    );
  });

  it('persisted freshness_score_is_drifted changes with distinct thresholds', () => {
    insertCase({
      case_id: 'case-threshold',
      current_wiki_path: 'Cases/case-threshold.md',
      compiled_at: '2026-04-18T01:00:00.000Z',
      last_activity_at: '2026-04-18T02:00:00.000Z',
      state_updated_at: '2026-04-18T00:00:00.000Z',
    });
    insertWikiIndex('case-threshold');

    sweepCaseFreshness(getAdapter(), {
      case_ids: ['case-threshold'],
      drift_threshold: 0.7,
      now: '2026-04-18T03:00:00.000Z',
    });
    expect(freshnessRow('case-threshold').freshness_score_is_drifted).toBe(1);

    sweepCaseFreshness(getAdapter(), {
      case_ids: ['case-threshold'],
      drift_threshold: 0.5,
      now: '2026-04-18T04:00:00.000Z',
    });
    expect(freshnessRow('case-threshold').freshness_score_is_drifted).toBe(0);
  });

  it('classifies unknown when timestamps are absent', () => {
    const result = calculateCaseFreshness({
      last_activity_at: null,
      state_updated_at: null,
      compiled_at: null,
      wiki_index_updated_at: null,
      current_wiki_path: null,
    });

    expect(result.freshness_state).toBe('unknown');
    expect(result.freshness_score_is_drifted).toBe(0);
    expect(result.reasons.map((reason) => reason.code)).toContain('timestamps_absent');
  });

  it('rejects invalid now timestamps instead of silently falling back', () => {
    insertCase({
      case_id: 'case-invalid-now',
      current_wiki_path: 'Cases/case-invalid-now.md',
      compiled_at: '2026-04-18T01:00:00.000Z',
      last_activity_at: '2026-04-18T00:00:00.000Z',
      state_updated_at: '2026-04-18T00:30:00.000Z',
    });
    insertWikiIndex('case-invalid-now');

    expect(() =>
      sweepCaseFreshness(getAdapter(), {
        case_ids: ['case-invalid-now'],
        now: 'not-a-real-timestamp',
      })
    ).toThrow('invalid now timestamp');
  });

  it('sweeper refreshes freshness_checked_at even when the calculated state is unchanged', () => {
    insertCase({
      case_id: 'case-idempotent',
      current_wiki_path: 'Cases/case-idempotent.md',
      compiled_at: '2026-04-18T01:00:00.000Z',
      last_activity_at: '2026-04-18T00:00:00.000Z',
      state_updated_at: '2026-04-18T00:30:00.000Z',
    });
    insertWikiIndex('case-idempotent');

    sweepCaseFreshness(getAdapter(), {
      case_ids: ['case-idempotent'],
      now: '2026-04-18T02:00:00.000Z',
    });
    const first = freshnessRow('case-idempotent');

    const secondSweep = sweepCaseFreshness(getAdapter(), {
      case_ids: ['case-idempotent'],
      now: '2026-04-18T03:00:00.000Z',
    });
    const second = freshnessRow('case-idempotent');

    expect(secondSweep.results[0].changed).toBe(false);
    expect(second.freshness_checked_at).toBe('2026-04-18T03:00:00.000Z');
    expect(second.freshness_checked_at).not.toBe(first.freshness_checked_at);
    expect(secondSweep.results[0]?.freshness_checked_at).toBe('2026-04-18T03:00:00.000Z');
  });

  it('sweeper emits drift memory event on transition into drifted', () => {
    insertCase({
      case_id: 'case-transition',
      current_wiki_path: 'Cases/case-transition.md',
      compiled_at: '2026-04-18T01:00:00.000Z',
      last_activity_at: '2026-04-18T02:00:00.000Z',
      state_updated_at: '2026-04-18T00:30:00.000Z',
    });
    insertWikiIndex('case-transition');

    sweepCaseFreshness(getAdapter(), {
      case_ids: ['case-transition'],
      now: '2026-04-18T03:00:00.000Z',
    });
    expect(freshnessRow('case-transition').freshness_state).toBe('stale');

    getAdapter().prepare('DELETE FROM wiki_page_index WHERE case_id = ?').run('case-transition');

    sweepCaseFreshness(getAdapter(), {
      case_ids: ['case-transition'],
      now: '2026-04-18T04:00:00.000Z',
    });

    const event = getAdapter()
      .prepare(
        `
          SELECT event_type, topic
          FROM memory_events
          WHERE event_type = 'case.freshness_drifted'
        `
      )
      .get() as { event_type: string; topic: string } | undefined;

    expect(event).toEqual({
      event_type: 'case.freshness_drifted',
      topic: 'case:case-transition',
    });
  });

  it('single-case sweep resolves loser to terminal survivor', () => {
    insertCase({
      case_id: 'case-survivor',
      current_wiki_path: 'Cases/case-survivor.md',
      compiled_at: '2026-04-18T01:00:00.000Z',
      last_activity_at: '2026-04-18T00:00:00.000Z',
      state_updated_at: '2026-04-18T00:30:00.000Z',
    });
    insertCase({
      case_id: 'case-loser',
      status: 'merged',
      canonical_case_id: 'case-survivor',
    });
    insertWikiIndex('case-survivor');

    const result = sweepCaseFreshness(getAdapter(), {
      case_ids: ['case-loser'],
      now: '2026-04-18T02:00:00.000Z',
    });

    expect(result.results[0]).toMatchObject({
      case_id: 'case-loser',
      terminal_case_id: 'case-survivor',
      resolved_via_case_id: 'case-loser',
      chain: ['case-loser', 'case-survivor'],
    });
    expect(freshnessRow('case-survivor').freshness_state).toBe('fresh');
  });

  it('batch explicit case_ids reports terminal cases in rejected output', () => {
    insertCase({
      case_id: 'case-active',
      current_wiki_path: 'Cases/case-active.md',
      compiled_at: '2026-04-18T01:00:00.000Z',
      last_activity_at: '2026-04-18T00:00:00.000Z',
    });
    insertCase({
      case_id: 'case-archived',
      status: 'archived',
    });
    insertWikiIndex('case-active');

    const result = sweepCaseFreshness(getAdapter(), {
      case_ids: ['case-active', 'case-archived'],
      now: '2026-04-18T02:00:00.000Z',
    });

    expect(result.rejected).toEqual(
      expect.arrayContaining([
        {
          case_id: 'case-archived',
          code: 'case.terminal_status',
          message: 'Freshness cannot be written to terminal case status archived.',
        },
      ])
    );
  });

  it('response includes terminal_case_id, resolved_via_case_id, and chain', () => {
    insertCase({
      case_id: 'case-response',
      current_wiki_path: 'Cases/case-response.md',
      compiled_at: '2026-04-18T01:00:00.000Z',
      last_activity_at: '2026-04-18T00:00:00.000Z',
    });
    insertWikiIndex('case-response');

    const result = sweepCaseFreshness(getAdapter(), { case_ids: ['case-response'] });

    expect(result.results[0]).toMatchObject({
      case_id: 'case-response',
      terminal_case_id: 'case-response',
      resolved_via_case_id: null,
      chain: ['case-response'],
    });
  });

  it('listDriftedCases orders by freshness_score ASC, case_id ASC', () => {
    insertCase({
      case_id: 'case-b',
      current_wiki_path: 'Cases/case-b.md',
      compiled_at: '2026-04-18T01:00:00.000Z',
      last_activity_at: '2026-04-18T02:00:00.000Z',
      state_updated_at: '2026-04-18T02:30:00.000Z',
    });
    insertCase({
      case_id: 'case-a',
      current_wiki_path: 'Cases/case-a.md',
      compiled_at: '2026-04-18T01:00:00.000Z',
      last_activity_at: '2026-04-18T02:00:00.000Z',
      state_updated_at: '2026-04-18T02:30:00.000Z',
    });
    insertCase({
      case_id: 'case-c',
      current_wiki_path: 'Cases/case-c.md',
      compiled_at: '2026-04-18T01:00:00.000Z',
      last_activity_at: '2026-04-18T02:00:00.000Z',
      state_updated_at: '2026-04-18T00:30:00.000Z',
    });

    sweepCaseFreshness(getAdapter(), {
      case_ids: ['case-b', 'case-a', 'case-c'],
      now: '2026-04-18T03:00:00.000Z',
    });

    expect(listDriftedCases(getAdapter()).map((row) => row.case_id)).toEqual([
      'case-a',
      'case-b',
      'case-c',
    ]);
  });

  it('listDriftedCases excludes terminal cases that still carry stale drift metadata', () => {
    insertCase({
      case_id: 'case-terminal-drifted',
      status: 'merged',
      current_wiki_path: 'Cases/case-terminal-drifted.md',
      compiled_at: '2026-04-18T01:00:00.000Z',
      last_activity_at: '2026-04-18T02:00:00.000Z',
      state_updated_at: '2026-04-18T02:30:00.000Z',
    });
    insertCase({
      case_id: 'case-live-drifted',
      current_wiki_path: 'Cases/case-live-drifted.md',
      compiled_at: '2026-04-18T01:00:00.000Z',
      last_activity_at: '2026-04-18T02:00:00.000Z',
      state_updated_at: '2026-04-18T02:30:00.000Z',
    });

    getAdapter()
      .prepare(
        `
          UPDATE case_truth
          SET freshness_state = 'drifted',
              freshness_score = 0.1,
              freshness_score_is_drifted = 1
          WHERE case_id IN (?, ?)
        `
      )
      .run('case-terminal-drifted', 'case-live-drifted');

    expect(listDriftedCases(getAdapter()).map((row) => row.case_id)).toEqual(['case-live-drifted']);
  });

  it('coexists with active correction locks without touching protected live fields', () => {
    insertCase({
      case_id: 'case-lock-coexist',
      current_wiki_path: 'Cases/case-lock-coexist.md',
      compiled_at: '2026-04-18T01:00:00.000Z',
      last_activity_at: '2026-04-18T02:00:00.000Z',
      state_updated_at: '2026-04-18T00:30:00.000Z',
      status_reason: 'locked status reason',
    });
    insertWikiIndex('case-lock-coexist');

    insertCaseCorrectionLock(getAdapter(), {
      correction_id: 'corr-status-reason-lock',
      case_id: 'case-lock-coexist',
      target_kind: 'case_field',
      target_ref: buildCaseFieldTargetRef('status_reason'),
      field_name: 'status_reason',
      old_value_json: canonicalizeJSON('locked status reason'),
      new_value_json: canonicalizeJSON('user corrected status reason'),
      reason: 'protect status reason',
      applied_by: 'user:test',
      applied_at: '2026-04-18T01:30:00.000Z',
      is_lock_active: 1,
    });

    sweepCaseFreshness(getAdapter(), {
      case_ids: ['case-lock-coexist'],
      now: '2026-04-18T03:00:00.000Z',
    });

    const row = freshnessRow('case-lock-coexist');
    expect(row.freshness_state).toBe('stale');
    expect(row.status_reason).toBe('locked status reason');

    const correction = getAdapter()
      .prepare('SELECT is_lock_active FROM case_corrections WHERE correction_id = ?')
      .get('corr-status-reason-lock') as { is_lock_active: number };
    expect(correction.is_lock_active).toBe(1);

    const correctionEvents = getAdapter()
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM memory_events
          WHERE event_type LIKE 'case.correction_%'
        `
      )
      .get() as { count: number };
    expect(correctionEvents.count).toBe(0);
  });
});
