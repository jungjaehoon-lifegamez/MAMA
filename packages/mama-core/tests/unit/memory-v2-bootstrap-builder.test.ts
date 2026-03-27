import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';

import { buildMemoryAgentBootstrap } from '../../src/memory-v2/bootstrap-builder.js';
import { createAuditFinding } from '../../src/memory-v2/finding-store.js';
import { appendMemoryEvent } from '../../src/memory-v2/event-store.js';
import { projectMemoryTruth } from '../../src/memory-v2/truth-store.js';
import { upsertChannelSummary } from '../../src/memory-v2/channel-summary-store.js';

const TEST_DB = '/tmp/test-memory-v2-bootstrap-builder.db';

describe('memory agent bootstrap builder', () => {
  beforeAll(() => {
    [TEST_DB, `${TEST_DB}-journal`, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((file) => {
      try {
        fs.unlinkSync(file);
      } catch {
        /* cleanup */
      }
    });

    process.env.MAMA_DB_PATH = TEST_DB;
  });

  afterAll(async () => {
    const { closeDB } = await import('../../src/db-manager.js');
    await closeDB();
    delete process.env.MAMA_DB_PATH;

    [TEST_DB, `${TEST_DB}-journal`, `${TEST_DB}-wal`, `${TEST_DB}-shm`].forEach((file) => {
      try {
        fs.unlinkSync(file);
      } catch {
        /* cleanup */
      }
    });
  });

  it('should include truth snapshot and open findings', async () => {
    await projectMemoryTruth({
      memory_id: 'decision_bootstrap_1',
      topic: 'memory_bootstrap',
      truth_status: 'active',
      effective_summary: 'Use pnpm in this repo',
      effective_details: 'Repo standard',
      trust_score: 0.9,
      scope_refs: [{ kind: 'project', id: '/repo' }],
      supporting_event_ids: ['evt_bootstrap'],
    });

    await appendMemoryEvent({
      event_type: 'save',
      actor: 'memory_agent',
      topic: 'memory_bootstrap',
      scope_refs: [{ kind: 'project', id: '/repo' }],
      created_at: Date.now(),
    });

    await createAuditFinding({
      kind: 'memory_conflict',
      severity: 'high',
      summary: 'conflict found',
      evidence_refs: ['evt_bootstrap'],
      affected_memory_ids: ['decision_bootstrap_1'],
      recommended_action: 'consult_memory',
    });

    const packet = await buildMemoryAgentBootstrap({
      scopes: [{ kind: 'project', id: '/repo' }],
      currentGoal: 'stabilize memory agent',
    });

    expect(packet.current_goal).toBe('stabilize memory agent');
    expect(packet.truth_snapshot.some((row) => row.topic === 'memory_bootstrap')).toBe(true);
    expect(packet.open_audit_findings.some((finding) => finding.summary === 'conflict found')).toBe(
      true
    );
    expect(packet.recent_memory_events.some((event) => event.topic === 'memory_bootstrap')).toBe(
      true
    );
  });

  it('should include channel summary when channel scope is provided', async () => {
    await upsertChannelSummary({
      channelKey: 'telegram:7026976631',
      summaryMarkdown: '## Channel Summary\n- Current DB direction: PostgreSQL',
      deltaHash: 'db:postgres',
    });

    const packet = await buildMemoryAgentBootstrap({
      scopes: [{ kind: 'channel', id: 'telegram:7026976631' }],
      channelKey: 'telegram:7026976631',
    });

    expect(packet.channel_summary_markdown).toContain('PostgreSQL');
  });
});
