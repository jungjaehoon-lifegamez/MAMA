import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';

import { getAdapter } from '../../src/db-manager.js';
import { cleanupTestDB, initTestDB } from '../../src/test-utils.js';

function getFixturePath(name: string): string {
  return path.join(__dirname, '..', 'fixtures', name);
}

function clearPhase8Tables(): void {
  const adapter = getAdapter();
  const tables = adapter
    .prepare(
      `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('entity_policy', 'entity_role_bindings', 'entity_policy_proposals', 'memory_events')
      `
    )
    .all() as Array<{ name: string }>;

  for (const table of tables.map((row) => row.name)) {
    adapter.prepare(`DELETE FROM ${table}`).run();
  }
}

describe('Story E1.24: Phase 8 policy substrate', () => {
  let testDbPath = '';

  beforeAll(async () => {
    testDbPath = await initTestDB('entity-policy-store');
  });

  beforeEach(() => {
    clearPhase8Tables();
  });

  afterAll(async () => {
    await cleanupTestDB(testDbPath);
  });

  describe('AC #1: migrations create the required Phase 8 tables', () => {
    it('should create the entity policy tables', () => {
      const adapter = getAdapter();
      const tables = adapter
        .prepare(
          `
            SELECT name
            FROM sqlite_master
            WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
            ORDER BY name
          `
        )
        .all() as Array<{ name: string }>;
      const tableNames = tables.map((row) => row.name);

      expect(tableNames).toContain('entity_policy');
      expect(tableNames).toContain('entity_role_bindings');
      expect(tableNames).toContain('entity_policy_proposals');
    });
  });

  describe('AC #2: bootstrap only seeds empty Phase 8 state', () => {
    it('bootstraps policy rows and role bindings from ontology.json only when the tables are empty', async () => {
      const { ensureEntityPolicyBootstrap, listEntityPolicies, resolveEntityRoleForActor } =
        await import('../../src/entities/policy-store.js');

      await ensureEntityPolicyBootstrap({
        bootstrapPath: getFixturePath('entity-policy-bootstrap.json'),
        now: () => 1_710_000_000_000,
      });

      expect(listEntityPolicies()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ policy_key: 'merge_guardrails.default', version: 1 }),
          expect.objectContaining({ policy_key: 'review_thresholds.default', version: 1 }),
        ])
      );
      expect(resolveEntityRoleForActor('local:viewer')).toBe('admin');
      expect(resolveEntityRoleForActor('actor:unknown')).toBe('viewer');
    });

    it('skips bootstrap when entity_policy already contains rows', async () => {
      const { ensureEntityPolicyBootstrap, getEntityPolicy } =
        await import('../../src/entities/policy-store.js');
      const adapter = getAdapter();

      await ensureEntityPolicyBootstrap({
        bootstrapPath: getFixturePath('entity-policy-bootstrap.json'),
        now: () => 1_710_000_000_000,
      });

      const alternatePath = path.join(
        path.dirname(getFixturePath('entity-policy-bootstrap.json')),
        'entity-policy-bootstrap-alt.json'
      );
      adapter
        .prepare(
          `
            UPDATE entity_policy
            SET value_json = ?
            WHERE policy_key = 'merge_guardrails.default'
          `
        )
        .run(JSON.stringify({ max_false_merge_rate: 0.5 }));

      await ensureEntityPolicyBootstrap({
        bootstrapPath: alternatePath,
        now: () => 1_710_000_123_000,
      });

      expect(getEntityPolicy('merge_guardrails.default')?.value).toEqual({
        max_false_merge_rate: 0.5,
      });
    });
  });

  describe('AC #3: role resolution and proposal approval use durable tables', () => {
    it('resolves the bound max role for an actor in O(1) table lookup style', async () => {
      const { upsertEntityRoleBinding, resolveEntityRoleForActor } =
        await import('../../src/entities/policy-store.js');

      upsertEntityRoleBinding({
        actor_id: 'actor:operator',
        role: 'operator',
      });

      expect(resolveEntityRoleForActor('actor:operator')).toBe('operator');
      expect(resolveEntityRoleForActor('actor:missing')).toBe('viewer');
    });

    it('bumps the policy version when an approved proposal is applied', async () => {
      const {
        ensureEntityPolicyBootstrap,
        createEntityPolicyProposal,
        approveEntityPolicyProposal,
        getEntityPolicy,
      } = await import('../../src/entities/policy-store.js');

      await ensureEntityPolicyBootstrap({
        bootstrapPath: getFixturePath('entity-policy-bootstrap.json'),
        now: () => 1_710_000_000_000,
      });

      const proposalId = createEntityPolicyProposal({
        policy_key: 'review_thresholds.default',
        policy_kind: 'review_thresholds',
        proposed_value: {
          approve_score_min: 0.95,
          defer_score_min: 0.8,
        },
        proposer_actor: 'actor:admin-a',
        reason: 'Raise the approval threshold',
      });

      const approved = approveEntityPolicyProposal({
        proposal_id: proposalId,
        approver_actor: 'actor:admin-b',
      });

      expect(approved.status).toBe('approved');
      expect(getEntityPolicy('review_thresholds.default')?.version).toBe(2);
      expect(getEntityPolicy('review_thresholds.default')?.value).toEqual({
        approve_score_min: 0.95,
        defer_score_min: 0.8,
      });
    });

    it('stores proposal payloads separately from the memory_events audit trail', async () => {
      const { createEntityPolicyProposal } = await import('../../src/entities/policy-store.js');
      const adapter = getAdapter();

      createEntityPolicyProposal({
        policy_key: 'merge_guardrails.default',
        policy_kind: 'merge_guardrails',
        proposed_value: {
          max_false_merge_rate: 0.01,
        },
        proposer_actor: 'actor:admin-a',
        reason: 'Tighten guardrails',
      });

      const proposalCount = adapter
        .prepare('SELECT COUNT(*) AS total FROM entity_policy_proposals')
        .get() as { total: number };
      const eventCount = adapter.prepare('SELECT COUNT(*) AS total FROM memory_events').get() as {
        total: number;
      };

      expect(proposalCount.total).toBe(1);
      expect(eventCount.total).toBe(0);
    });
  });
});
