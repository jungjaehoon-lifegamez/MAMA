import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';

import { buildMemoryAgentBootstrap } from '../../src/memory/bootstrap-builder.js';
import { createAuditFinding } from '../../src/memory/finding-store.js';
import { appendMemoryEvent } from '../../src/memory/event-store.js';
import { saveMemory } from '../../src/memory/api.js';
import { getAdapter } from '../../src/db-manager.js';
import { upsertChannelSummary } from '../../src/memory/channel-summary-store.js';

const TEST_DB = '/tmp/test-memory-v2-bootstrap-builder.db';
const PROJECT_SCOPE = { kind: 'project' as const, id: '/repo' };

function insertContradictoryTruthRow(memoryId: string, truthStatus: 'active' | 'superseded'): void {
  const now = Date.now();
  getAdapter()
    .prepare(
      `
        INSERT OR REPLACE INTO memory_truth (
          memory_id, topic, truth_status, effective_summary, effective_details, trust_score,
          scope_refs, supporting_event_ids, superseded_by, contradicted_by, created_at, updated_at
        ) VALUES (?, 'memory_bootstrap', ?, 'stale projection', 'stale projection details', 1,
          ?, '[]', NULL, NULL, ?, ?)
      `
    )
    .run(memoryId, truthStatus, JSON.stringify([PROJECT_SCOPE]), now, now);
}

describe('memory agent bootstrap builder', () => {
  const originalForceTier3 = process.env.MAMA_FORCE_TIER_3;

  beforeAll(() => {
    [TEST_DB, `${TEST_DB}-journal`, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((file) => {
      try {
        fs.unlinkSync(file);
      } catch {
        /* cleanup */
      }
    });

    process.env.MAMA_DB_PATH = TEST_DB;
    process.env.MAMA_FORCE_TIER_3 = 'true';
  });

  afterAll(async () => {
    const { closeDB } = await import('../../src/db-manager.js');
    await closeDB();
    delete process.env.MAMA_DB_PATH;
    if (originalForceTier3 === undefined) delete process.env.MAMA_FORCE_TIER_3;
    else process.env.MAMA_FORCE_TIER_3 = originalForceTier3;

    [TEST_DB, `${TEST_DB}-journal`, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((file) => {
      try {
        fs.unlinkSync(file);
      } catch {
        /* cleanup */
      }
    });
  });

  it('builds its truth snapshot from current decisions rather than stale projections', async () => {
    const superseded = await saveMemory({
      topic: 'memory_bootstrap',
      kind: 'decision',
      summary: 'Use npm in this repo',
      details: 'Historical repository standard',
      confidence: 0.3,
      scopes: [PROJECT_SCOPE],
      source: { package: 'mama-core', source_type: 'test', project_id: PROJECT_SCOPE.id },
    });
    const active = await saveMemory({
      topic: 'memory_bootstrap',
      kind: 'decision',
      summary: 'Use pnpm in this repo',
      details: 'Current repository standard',
      confidence: 0.9,
      scopes: [PROJECT_SCOPE],
      source: { package: 'mama-core', source_type: 'test', project_id: PROJECT_SCOPE.id },
    });
    insertContradictoryTruthRow(superseded.id, 'active');
    insertContradictoryTruthRow(active.id, 'superseded');

    await appendMemoryEvent({
      event_type: 'save',
      actor: 'memory_agent',
      topic: 'memory_bootstrap',
      scope_refs: [PROJECT_SCOPE],
      created_at: Date.now(),
    });

    await createAuditFinding({
      kind: 'memory_conflict',
      severity: 'high',
      summary: 'conflict found',
      evidence_refs: ['evt_bootstrap'],
      affected_memory_ids: [active.id],
      recommended_action: 'consult_memory',
    });

    const packet = await buildMemoryAgentBootstrap({
      scopes: [PROJECT_SCOPE],
      currentGoal: 'stabilize memory agent',
    });

    expect(packet.current_goal).toBe('stabilize memory agent');
    expect(packet.truth_snapshot.map((row) => row.id)).toEqual([active.id]);
    expect(packet.open_audit_findings.some((finding) => finding.summary === 'conflict found')).toBe(
      true
    );
    expect(packet.recent_memory_events.some((event) => event.topic === 'memory_bootstrap')).toBe(
      true
    );
  });

  it('should include channel summary when channel scope is provided', async () => {
    await upsertChannelSummary({
      channelKey: 'telegram:tg_test_001',
      summaryMarkdown: '## Channel Summary\n- Current DB direction: PostgreSQL',
      deltaHash: 'db:postgres',
    });

    const packet = await buildMemoryAgentBootstrap({
      scopes: [{ kind: 'channel', id: 'telegram:tg_test_001' }],
      channelKey: 'telegram:tg_test_001',
    });

    expect(packet.channel_summary_markdown).toContain('PostgreSQL');
  });
});
