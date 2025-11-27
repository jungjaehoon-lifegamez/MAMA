/**
 * Link Tools Integration Tests (Epic 3)
 *
 * Verifies propose/approve/reject/pending/deprecate flows and
 * ensures pending links stay out of graph queries until approved.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import {
  proposeLinkTool,
  approveLinkTool,
  rejectLinkTool,
  getPendingLinksTool,
  deprecateAutoLinksTool,
} from '../../src/tools/link-tools.js';
import { initDB, getAdapter, closeDB, queryDecisionGraph } from '../../src/mama/memory-store.js';

const TEST_DB_PATH = path.join(os.tmpdir(), `mama-link-tools-${Date.now()}.db`);
const mockContext = {
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
  },
};

function cleanupDbFiles() {
  [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`].forEach((file) => {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  });
}

function createDecision(topic) {
  const adapter = getAdapter();
  const id = `decision_${topic}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const now = Date.now();

  adapter
    .prepare(
      `
      INSERT INTO decisions (id, topic, decision, reasoning, confidence, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
    )
    .run(id, topic, `Decision for ${topic}`, 'Test reasoning', 0.8, now, now);

  return id;
}

// TODO: Link governance feature not yet implemented
describe.skip('Epic 3: Link Governance Tools', () => {
  beforeAll(async () => {
    cleanupDbFiles();
    process.env.MAMA_DB_PATH = TEST_DB_PATH;
    await initDB();
  });

  afterAll(async () => {
    await closeDB();
    cleanupDbFiles();
    delete process.env.MAMA_DB_PATH;
  });

  beforeEach(async () => {
    await initDB();
    const adapter = getAdapter();
    adapter.prepare('DELETE FROM link_audit_log').run();
    adapter.prepare('DELETE FROM decision_edges').run();
    adapter.prepare('DELETE FROM decisions').run();
    // Clear vector embeddings to prevent rowid conflicts
    if (adapter.vectorSearchEnabled) {
      adapter.prepare('DELETE FROM vss_memories').run();
    }
  });

  it('propose_link stores pending edges with audit trail', async () => {
    const fromId = createDecision('link_from');
    const toId = createDecision('link_to');
    const reason = 'Propose link from -> to for testing';

    const result = await proposeLinkTool.handler(
      { from_id: fromId, to_id: toId, relationship: 'refines', reason },
      mockContext
    );

    expect(result.content?.[0]?.text).toContain('Link Proposed');

    const adapter = getAdapter();
    const link = adapter
      .prepare(
        `
        SELECT * FROM decision_edges
        WHERE from_id = ? AND to_id = ? AND relationship = ?
      `
      )
      .get(fromId, toId, 'refines');

    expect(link).toBeTruthy();
    expect(link.approved_by_user).toBe(0);
    expect(link.created_by).toBe('llm');
    expect(link.reason).toBe(reason);

    const audit = adapter
      .prepare(`SELECT * FROM link_audit_log WHERE action = 'proposed' ORDER BY id DESC LIMIT 1`)
      .get();
    expect(audit).toBeTruthy();
    expect(audit.actor).toBe('llm');
    expect(audit.reason).toBe(reason);
  });

  it('approve_link activates links and keeps pending links out of graph queries', async () => {
    const fromId = createDecision('graph_filter_from');
    const toId = createDecision('graph_filter_to');

    const proposeResult = await proposeLinkTool.handler(
      { from_id: fromId, to_id: toId, relationship: 'refines', reason: 'Pending filter check' },
      mockContext
    );
    expect(proposeResult.content[0].text).toContain('Link Proposed');

    const pendingGraph = await queryDecisionGraph('graph_filter_from');
    const pendingEdges = pendingGraph.find((d) => d.id === fromId)?.edges || [];
    expect(pendingEdges.length).toBe(0);

    const approveResult = await approveLinkTool.handler(
      { from_id: fromId, to_id: toId, relationship: 'refines' },
      mockContext
    );
    expect(approveResult.content[0].text).toContain('Link Approved');

    const adapter = getAdapter();
    const link = adapter
      .prepare(
        `
        SELECT approved_by_user FROM decision_edges
        WHERE from_id = ? AND to_id = ? AND relationship = ?
      `
      )
      .get(fromId, toId, 'refines');
    expect(link.approved_by_user).toBe(1);

    const graph = await queryDecisionGraph('graph_filter_from');
    const edges = graph.find((d) => d.id === fromId)?.edges || [];
    expect(edges.length).toBe(1);
    expect(edges[0].relationship).toBe('refines');
  });

  it('reject_link removes pending links and records rejection reason', async () => {
    const fromId = createDecision('reject_from');
    const toId = createDecision('reject_to');
    const reason = 'Out of scope';

    await proposeLinkTool.handler(
      { from_id: fromId, to_id: toId, relationship: 'contradicts', reason: 'Check rejection' },
      mockContext
    );

    const result = await rejectLinkTool.handler(
      { from_id: fromId, to_id: toId, relationship: 'contradicts', reason },
      mockContext
    );

    expect(result.content?.[0]?.text).toContain('Link Rejected');

    const adapter = getAdapter();
    const link = adapter
      .prepare(
        `
        SELECT * FROM decision_edges
        WHERE from_id = ? AND to_id = ? AND relationship = ?
      `
      )
      .get(fromId, toId, 'contradicts');
    expect(link).toBeUndefined();

    const audit = adapter
      .prepare(`SELECT * FROM link_audit_log WHERE action = 'rejected' ORDER BY id DESC LIMIT 1`)
      .get();
    expect(audit).toBeTruthy();
    expect(audit.reason).toBe(reason);
  });

  it('get_pending_links returns only proposals awaiting approval', async () => {
    const pendingFrom = createDecision('pending_from');
    const pendingTo = createDecision('pending_to');
    const approvedFrom = createDecision('approved_from');
    const approvedTo = createDecision('approved_to');

    await proposeLinkTool.handler(
      { from_id: pendingFrom, to_id: pendingTo, relationship: 'refines', reason: 'Pending only' },
      mockContext
    );
    await proposeLinkTool.handler(
      { from_id: approvedFrom, to_id: approvedTo, relationship: 'refines', reason: 'Will approve' },
      mockContext
    );
    await approveLinkTool.handler(
      { from_id: approvedFrom, to_id: approvedTo, relationship: 'refines' },
      mockContext
    );

    const result = await getPendingLinksTool.handler({}, mockContext);
    const text = result.content?.[0]?.text || '';

    expect(text).toContain('Pending Links');
    expect(text).toContain(pendingFrom);
    expect(text).toContain(pendingTo);
    expect(text).not.toContain(approvedFrom);
    expect(text).not.toContain(approvedTo);
  });

  it('deprecate_auto_links removes legacy auto-generated links but keeps protected ones', async () => {
    const autoFrom = createDecision('auto_from');
    const autoTo = createDecision('auto_to');
    const protectedFrom = createDecision('protected_from');
    const protectedTo = createDecision('protected_to');
    const adapter = getAdapter();
    const timestamp = Date.now();

    adapter
      .prepare(
        `
        INSERT INTO decision_edges
          (from_id, to_id, relationship, reason, created_by, approved_by_user, decision_id, created_at)
        VALUES (?, ?, 'refines', 'legacy auto link', 'user', 1, NULL, ?)
      `
      )
      .run(autoFrom, autoTo, timestamp);

    adapter
      .prepare(
        `
        INSERT INTO decision_edges
          (from_id, to_id, relationship, reason, created_by, approved_by_user, decision_id, created_at)
        VALUES (?, ?, 'refines', 'protected link', 'llm', 1, 'decision_ctx', ?)
      `
      )
      .run(protectedFrom, protectedTo, timestamp);

    await deprecateAutoLinksTool.handler({ dryRun: true }, mockContext);

    const countsAfterDryRun = adapter
      .prepare(
        `SELECT COUNT(*) as count FROM decision_edges WHERE created_by = 'user' AND decision_id IS NULL`
      )
      .get();
    expect(countsAfterDryRun.count).toBe(1);

    await deprecateAutoLinksTool.handler({ dryRun: false }, mockContext);

    const autoCount = adapter
      .prepare(
        `SELECT COUNT(*) as count FROM decision_edges WHERE created_by = 'user' AND decision_id IS NULL`
      )
      .get().count;
    const protectedCount = adapter
      .prepare(`SELECT COUNT(*) as count FROM decision_edges WHERE created_by = 'llm'`)
      .get().count;

    expect(autoCount).toBe(0);
    expect(protectedCount).toBe(1);

    const audit = adapter
      .prepare(`SELECT COUNT(*) as count FROM link_audit_log WHERE action = 'deprecated'`)
      .get();
    expect(audit.count).toBe(1);
  });

  // Story 3.3: Auto-Link Deprecation Tests
  describe('AC-3.3.1: Auto-Link Identification', () => {
    it('identifies v0 auto-generated links by created_by=user AND decision_id IS NULL', async () => {
      const adapter = getAdapter();
      const timestamp = Date.now();

      // Create v0 auto-generated link
      const v0From = createDecision('v0_auto_from');
      const v0To = createDecision('v0_auto_to');
      adapter
        .prepare(
          `INSERT INTO decision_edges
          (from_id, to_id, relationship, reason, created_by, decision_id, created_at)
          VALUES (?, ?, 'refines', 'v0 auto link', 'user', NULL, ?)`
        )
        .run(v0From, v0To, timestamp);

      // Create protected link (approved + decision_id)
      const protFrom = createDecision('prot_from');
      const protTo = createDecision('prot_to');
      adapter
        .prepare(
          `INSERT INTO decision_edges
          (from_id, to_id, relationship, reason, created_by, approved_by_user, decision_id, created_at)
          VALUES (?, ?, 'refines', 'protected link', 'user', 1, 'decision_123', ?)`
        )
        .run(protFrom, protTo, timestamp);

      // Create LLM link
      const llmFrom = createDecision('llm_from');
      const llmTo = createDecision('llm_to');
      adapter
        .prepare(
          `INSERT INTO decision_edges
          (from_id, to_id, relationship, reason, created_by, created_at)
          VALUES (?, ?, 'refines', 'llm proposed', 'llm', ?)`
        )
        .run(llmFrom, llmTo, timestamp);

      const result = await deprecateAutoLinksTool.handler({ dryRun: true }, mockContext);
      const text = result.content[0].text;

      // AC-3.3.1: Identifies only v0 auto links
      expect(text).toContain('Auto-generated links: 1');
      expect(text).toContain('Protected links: 2');
    });

    it('validates that only llm and user are allowed as created_by values', async () => {
      const adapter = getAdapter();
      const timestamp = Date.now();

      // Schema constraint: created_by CHECK (created_by IN ('llm', 'user'))
      // This test documents that 'system' is NOT a valid created_by value
      // AC-3.3.1 mentions created_by='system' but schema only allows 'llm' or 'user'

      const from = createDecision('schema_from');
      const to = createDecision('schema_to');

      // This should throw due to CHECK constraint
      expect(() => {
        adapter
          .prepare(
            `INSERT INTO decision_edges
            (from_id, to_id, relationship, reason, created_by, decision_id, created_at)
            VALUES (?, ?, 'refines', 'invalid system link', 'system', NULL, ?)`
          )
          .run(from, to, timestamp);
      }).toThrow();
    });
  });

  describe('AC-3.3.2: Deprecation Execution & Protection', () => {
    it('dry-run mode previews without deleting', async () => {
      const adapter = getAdapter();
      const timestamp = Date.now();

      const autoFrom = createDecision('dryrun_from');
      const autoTo = createDecision('dryrun_to');
      adapter
        .prepare(
          `INSERT INTO decision_edges
          (from_id, to_id, relationship, reason, created_by, decision_id, created_at)
          VALUES (?, ?, 'refines', 'auto link', 'user', NULL, ?)`
        )
        .run(autoFrom, autoTo, timestamp);

      // AC-3.3.2: Dry-run mode
      const result = await deprecateAutoLinksTool.handler({ dryRun: true }, mockContext);
      const text = result.content[0].text;

      expect(text).toContain('DRY RUN');
      expect(text).toContain('Auto-generated links: 1');

      // Verify link still exists
      const link = adapter
        .prepare(`SELECT * FROM decision_edges WHERE from_id = ? AND to_id = ?`)
        .get(autoFrom, autoTo);
      expect(link).toBeTruthy();

      // Verify no audit log entry (dry-run doesn't create audit)
      const auditCount = adapter
        .prepare(`SELECT COUNT(*) as count FROM link_audit_log WHERE action = 'deprecated'`)
        .get().count;
      expect(auditCount).toBe(0);
    });

    it('execution mode deletes auto links and records audit log', async () => {
      const adapter = getAdapter();
      const timestamp = Date.now();

      const autoFrom = createDecision('exec_from');
      const autoTo = createDecision('exec_to');
      adapter
        .prepare(
          `INSERT INTO decision_edges
          (from_id, to_id, relationship, reason, created_by, decision_id, created_at)
          VALUES (?, ?, 'contradicts', 'auto link', 'user', NULL, ?)`
        )
        .run(autoFrom, autoTo, timestamp);

      // AC-3.3.2: Execution mode
      const result = await deprecateAutoLinksTool.handler({ dryRun: false }, mockContext);
      const text = result.content[0].text;

      expect(text).toContain('EXECUTION');
      expect(text).toContain('Auto-generated links have been deprecated');

      // Verify link is deleted
      const link = adapter
        .prepare(`SELECT * FROM decision_edges WHERE from_id = ? AND to_id = ?`)
        .get(autoFrom, autoTo);
      expect(link).toBeUndefined();

      // AC-3.3.2: Audit log recorded
      const audit = adapter
        .prepare(
          `SELECT * FROM link_audit_log
           WHERE from_id = ? AND to_id = ? AND action = 'deprecated'`
        )
        .get(autoFrom, autoTo);
      expect(audit).toBeTruthy();
      expect(audit.actor).toBe('system');
      expect(audit.relationship).toBe('contradicts');
      expect(audit.reason).toContain('v0 auto-generated link removed');
    });

    it('protects links with approved_by_user=1 AND decision_id', async () => {
      const adapter = getAdapter();
      const timestamp = Date.now();

      const protFrom = createDecision('protected_approved_from');
      const protTo = createDecision('protected_approved_to');
      adapter
        .prepare(
          `INSERT INTO decision_edges
          (from_id, to_id, relationship, reason, created_by, approved_by_user, decision_id, created_at)
          VALUES (?, ?, 'refines', 'explicitly approved', 'user', 1, 'decision_456', ?)`
        )
        .run(protFrom, protTo, timestamp);

      // AC-3.3.2: Protected links excluded
      await deprecateAutoLinksTool.handler({ dryRun: false }, mockContext);

      const link = adapter
        .prepare(`SELECT * FROM decision_edges WHERE from_id = ? AND to_id = ?`)
        .get(protFrom, protTo);
      expect(link).toBeTruthy();
      expect(link.approved_by_user).toBe(1);
      expect(link.decision_id).toBe('decision_456');
    });

    it('protects LLM-created links (created_by=llm)', async () => {
      const adapter = getAdapter();
      const timestamp = Date.now();

      const llmFrom = createDecision('llm_protected_from');
      const llmTo = createDecision('llm_protected_to');
      adapter
        .prepare(
          `INSERT INTO decision_edges
          (from_id, to_id, relationship, reason, created_by, created_at)
          VALUES (?, ?, 'refines', 'LLM proposed', 'llm', ?)`
        )
        .run(llmFrom, llmTo, timestamp);

      // AC-3.3.2: LLM links protected
      await deprecateAutoLinksTool.handler({ dryRun: false }, mockContext);

      const link = adapter
        .prepare(`SELECT * FROM decision_edges WHERE from_id = ? AND to_id = ?`)
        .get(llmFrom, llmTo);
      expect(link).toBeTruthy();
      expect(link.created_by).toBe('llm');
    });
  });

  describe('AC-3.3.3: Report Generation', () => {
    it('generates report with statistics (deprecated, protected, total, ratio)', async () => {
      const adapter = getAdapter();
      const timestamp = Date.now();

      // Create 3 auto links
      for (let i = 0; i < 3; i++) {
        const from = createDecision(`report_auto_from_${i}`);
        const to = createDecision(`report_auto_to_${i}`);
        adapter
          .prepare(
            `INSERT INTO decision_edges
            (from_id, to_id, relationship, reason, created_by, decision_id, created_at)
            VALUES (?, ?, 'refines', 'auto', 'user', NULL, ?)`
          )
          .run(from, to, timestamp);
      }

      // Create 2 protected links
      for (let i = 0; i < 2; i++) {
        const from = createDecision(`report_prot_from_${i}`);
        const to = createDecision(`report_prot_to_${i}`);
        adapter
          .prepare(
            `INSERT INTO decision_edges
            (from_id, to_id, relationship, reason, created_by, decision_id, created_at)
            VALUES (?, ?, 'refines', 'protected', 'llm', 'decision_xyz', ?)`
          )
          .run(from, to, timestamp);
      }

      // AC-3.3.3: Report statistics
      const result = await deprecateAutoLinksTool.handler({ dryRun: true }, mockContext);
      const text = result.content[0].text;

      expect(text).toContain('Statistics:');
      expect(text).toContain('Auto-generated links: 3');
      expect(text).toContain('Protected links: 2');
      expect(text).toContain('Total links: 5');
      expect(text).toContain('Auto-link ratio: 60.00%');
    });

    it('lists top 10 auto-generated links with details', async () => {
      const adapter = getAdapter();
      const timestamp = Date.now();

      // Create 15 auto links (should show top 10)
      const links = [];
      for (let i = 0; i < 15; i++) {
        const from = createDecision(`list_auto_from_${i}`);
        const to = createDecision(`list_auto_to_${i}`);
        links.push({ from, to });
        adapter
          .prepare(
            `INSERT INTO decision_edges
            (from_id, to_id, relationship, reason, created_by, decision_id, created_at)
            VALUES (?, ?, 'refines', 'auto link ${i}', 'user', NULL, ?)`
          )
          .run(from, to, timestamp);
      }

      // AC-3.3.3: Link list (top 10)
      const result = await deprecateAutoLinksTool.handler({ dryRun: true }, mockContext);
      const text = result.content[0].text;

      expect(text).toContain('Auto-Generated Links (15)');
      expect(text).toContain('refines:');
      expect(text).toContain('Reason: auto link');
      expect(text).toContain('and 5 more'); // Shows 10, indicates 5 more
    });

    it('distinguishes dry-run vs execution mode in report', async () => {
      const adapter = getAdapter();
      const timestamp = Date.now();

      const autoFrom = createDecision('mode_from');
      const autoTo = createDecision('mode_to');
      adapter
        .prepare(
          `INSERT INTO decision_edges
          (from_id, to_id, relationship, reason, created_by, decision_id, created_at)
          VALUES (?, ?, 'refines', 'auto', 'user', NULL, ?)`
        )
        .run(autoFrom, autoTo, timestamp);

      // AC-3.3.3: Dry-run mode indicator
      const dryRunResult = await deprecateAutoLinksTool.handler({ dryRun: true }, mockContext);
      expect(dryRunResult.content[0].text).toContain('DRY RUN (Preview Only)');
      expect(dryRunResult.content[0].text).toContain(
        'To execute deprecation, call with dryRun=false'
      );

      // AC-3.3.3: Execution mode indicator
      const execResult = await deprecateAutoLinksTool.handler({ dryRun: false }, mockContext);
      expect(execResult.content[0].text).toContain('EXECUTION');
      expect(execResult.content[0].text).toContain('Auto-generated links have been deprecated');
      expect(execResult.content[0].text).toContain('Audit trail recorded');
    });

    it('handles zero auto-links case gracefully', async () => {
      const adapter = getAdapter();
      const timestamp = Date.now();

      // Only create protected links
      const protFrom = createDecision('only_prot_from');
      const protTo = createDecision('only_prot_to');
      adapter
        .prepare(
          `INSERT INTO decision_edges
          (from_id, to_id, relationship, reason, created_by, created_at)
          VALUES (?, ?, 'refines', 'protected', 'llm', ?)`
        )
        .run(protFrom, protTo, timestamp);

      // AC-3.3.3: Zero auto-links report
      const result = await deprecateAutoLinksTool.handler({ dryRun: true }, mockContext);
      const text = result.content[0].text;

      expect(text).toContain('No auto-generated links found');
      expect(text).toContain('All links have explicit approval context');
    });
  });

  // Story 3.2: Link Metadata & Audit Tests
  describe('AC-3.2.1: Metadata Storage', () => {
    it('proposeLink stores all required metadata fields', async () => {
      const fromId = createDecision('metadata_from');
      const toId = createDecision('metadata_to');
      const decisionId = 'decision_context_123';
      const evidence = 'file: src/auth.js, line: 42';

      await proposeLinkTool.handler(
        {
          from_id: fromId,
          to_id: toId,
          relationship: 'refines',
          reason: 'Testing metadata',
          decision_id: decisionId,
          evidence,
        },
        mockContext
      );

      const adapter = getAdapter();
      const link = adapter
        .prepare(
          `
          SELECT * FROM decision_edges
          WHERE from_id = ? AND to_id = ? AND relationship = ?
        `
        )
        .get(fromId, toId, 'refines');

      // AC-3.2.1: Required metadata
      expect(link.created_by).toBe('llm');
      expect(link.approved_by_user).toBe(0);
      expect(link.decision_id).toBe(decisionId);
      expect(link.created_at).toBeTruthy();
      expect(link.approved_at).toBeNull();

      // AC-3.2.1: Optional metadata
      expect(link.evidence).toBe(evidence);
    });

    it('approveLink sets approved_by_user=1 and approved_at timestamp', async () => {
      const fromId = createDecision('approve_metadata_from');
      const toId = createDecision('approve_metadata_to');

      await proposeLinkTool.handler(
        { from_id: fromId, to_id: toId, relationship: 'refines', reason: 'Approval metadata test' },
        mockContext
      );

      const beforeApproval = Date.now();
      await approveLinkTool.handler(
        { from_id: fromId, to_id: toId, relationship: 'refines' },
        mockContext
      );
      const afterApproval = Date.now();

      const adapter = getAdapter();
      const link = adapter
        .prepare(
          `
          SELECT * FROM decision_edges
          WHERE from_id = ? AND to_id = ? AND relationship = ?
        `
        )
        .get(fromId, toId, 'refines');

      // AC-3.2.1: Approval metadata
      expect(link.approved_by_user).toBe(1);
      expect(link.approved_at).toBeGreaterThanOrEqual(beforeApproval);
      expect(link.approved_at).toBeLessThanOrEqual(afterApproval);
    });
  });

  describe('AC-3.2.2: Audit Log Recording', () => {
    it('proposeLink records "proposed" action in audit log', async () => {
      const fromId = createDecision('audit_propose_from');
      const toId = createDecision('audit_propose_to');
      const reason = 'Audit log test - propose';

      await proposeLinkTool.handler(
        { from_id: fromId, to_id: toId, relationship: 'contradicts', reason },
        mockContext
      );

      const adapter = getAdapter();
      const audit = adapter
        .prepare(
          `
          SELECT * FROM link_audit_log
          WHERE from_id = ? AND to_id = ? AND relationship = ? AND action = 'proposed'
        `
        )
        .get(fromId, toId, 'contradicts');

      expect(audit).toBeTruthy();
      expect(audit.action).toBe('proposed');
      expect(audit.actor).toBe('llm');
      expect(audit.reason).toBe(reason);
      expect(audit.created_at).toBeTruthy();
    });

    it('approveLink records "approved" action in audit log', async () => {
      const fromId = createDecision('audit_approve_from');
      const toId = createDecision('audit_approve_to');

      await proposeLinkTool.handler(
        { from_id: fromId, to_id: toId, relationship: 'refines', reason: 'Audit approve test' },
        mockContext
      );

      await approveLinkTool.handler(
        { from_id: fromId, to_id: toId, relationship: 'refines' },
        mockContext
      );

      const adapter = getAdapter();
      const audit = adapter
        .prepare(
          `
          SELECT * FROM link_audit_log
          WHERE from_id = ? AND to_id = ? AND relationship = ? AND action = 'approved'
        `
        )
        .get(fromId, toId, 'refines');

      expect(audit).toBeTruthy();
      expect(audit.action).toBe('approved');
      expect(audit.actor).toBe('user');
      expect(audit.created_at).toBeTruthy();
    });

    it('rejectLink records "rejected" action with reason in audit log', async () => {
      const fromId = createDecision('audit_reject_from');
      const toId = createDecision('audit_reject_to');
      const rejectReason = 'Not relevant for current scope';

      await proposeLinkTool.handler(
        { from_id: fromId, to_id: toId, relationship: 'refines', reason: 'Initial proposal' },
        mockContext
      );

      await rejectLinkTool.handler(
        { from_id: fromId, to_id: toId, relationship: 'refines', reason: rejectReason },
        mockContext
      );

      const adapter = getAdapter();
      const audit = adapter
        .prepare(
          `
          SELECT * FROM link_audit_log
          WHERE from_id = ? AND to_id = ? AND relationship = ? AND action = 'rejected'
        `
        )
        .get(fromId, toId, 'refines');

      expect(audit).toBeTruthy();
      expect(audit.action).toBe('rejected');
      expect(audit.actor).toBe('user');
      expect(audit.reason).toBe(rejectReason);
      expect(audit.created_at).toBeTruthy();
    });

    it('audit log is append-only (entries are never deleted)', async () => {
      const fromId = createDecision('audit_append_from');
      const toId = createDecision('audit_append_to');

      await proposeLinkTool.handler(
        { from_id: fromId, to_id: toId, relationship: 'refines', reason: 'First proposal' },
        mockContext
      );

      await rejectLinkTool.handler(
        { from_id: fromId, to_id: toId, relationship: 'refines', reason: 'First rejection' },
        mockContext
      );

      await proposeLinkTool.handler(
        { from_id: fromId, to_id: toId, relationship: 'refines', reason: 'Second proposal' },
        mockContext
      );

      await approveLinkTool.handler(
        { from_id: fromId, to_id: toId, relationship: 'refines' },
        mockContext
      );

      const adapter = getAdapter();
      const audits = adapter
        .prepare(
          `
          SELECT * FROM link_audit_log
          WHERE from_id = ? AND to_id = ? AND relationship = ?
          ORDER BY created_at ASC
        `
        )
        .all(fromId, toId, 'refines');

      // AC-3.2.2: Append-only audit log
      expect(audits.length).toBe(4); // proposed, rejected, proposed, approved
      expect(audits[0].action).toBe('proposed');
      expect(audits[1].action).toBe('rejected');
      expect(audits[2].action).toBe('proposed');
      expect(audits[3].action).toBe('approved');
    });
  });

  describe('AC-3.2.3: Link Filtering', () => {
    it('link-expander returns only approved links by default (approvedOnly=true)', async () => {
      const { expand } = await import('../../src/mama/link-expander.js');
      const fromId = createDecision('filter_from');
      const pendingTo = createDecision('filter_pending_to');
      const approvedTo = createDecision('filter_approved_to');

      await proposeLinkTool.handler(
        { from_id: fromId, to_id: pendingTo, relationship: 'refines', reason: 'Pending link' },
        mockContext
      );

      await proposeLinkTool.handler(
        { from_id: fromId, to_id: approvedTo, relationship: 'refines', reason: 'Approved link' },
        mockContext
      );

      await approveLinkTool.handler(
        { from_id: fromId, to_id: approvedTo, relationship: 'refines' },
        mockContext
      );

      // AC-3.2.3: Default filtering (approved only)
      const approvedOnlyLinks = expand(fromId, 1, true);
      expect(approvedOnlyLinks.length).toBe(1);
      expect(approvedOnlyLinks[0].to_id).toBe(approvedTo);
    });

    it('link-expander can include pending links with approvedOnly=false', async () => {
      const { expand } = await import('../../src/mama/link-expander.js');
      const fromId = createDecision('filter_all_from');
      const pendingTo = createDecision('filter_all_pending_to');
      const approvedTo = createDecision('filter_all_approved_to');

      await proposeLinkTool.handler(
        { from_id: fromId, to_id: pendingTo, relationship: 'refines', reason: 'Pending' },
        mockContext
      );

      await proposeLinkTool.handler(
        { from_id: fromId, to_id: approvedTo, relationship: 'refines', reason: 'Approved' },
        mockContext
      );

      await approveLinkTool.handler(
        { from_id: fromId, to_id: approvedTo, relationship: 'refines' },
        mockContext
      );

      // AC-3.2.3: Include pending links
      const allLinks = expand(fromId, 1, false);
      expect(allLinks.length).toBe(2);

      const toIds = allLinks.map((l) => l.to_id).sort();
      expect(toIds).toEqual([approvedTo, pendingTo].sort());
    });

    it('queryDecisionGraph excludes pending links from semantic edges', async () => {
      const fromId = createDecision('graph_query_from');
      const pendingTo = createDecision('graph_query_pending_to');
      const approvedTo = createDecision('graph_query_approved_to');

      await proposeLinkTool.handler(
        { from_id: fromId, to_id: pendingTo, relationship: 'refines', reason: 'Pending' },
        mockContext
      );

      await proposeLinkTool.handler(
        { from_id: fromId, to_id: approvedTo, relationship: 'refines', reason: 'Approved' },
        mockContext
      );

      await approveLinkTool.handler(
        { from_id: fromId, to_id: approvedTo, relationship: 'refines' },
        mockContext
      );

      // AC-3.2.3: Graph queries filter approved only
      const graph = await queryDecisionGraph('graph_query_from');
      const edges = graph.find((d) => d.id === fromId)?.edges || [];

      expect(edges.length).toBe(1);
      expect(edges[0].to_id).toBe(approvedTo);
    });
  });

  describe('Edge Cases and Validation', () => {
    it('prevents duplicate link proposals', async () => {
      const fromId = createDecision('duplicate_from');
      const toId = createDecision('duplicate_to');

      // First proposal should succeed
      const firstResponse = await proposeLinkTool.handler(
        { from_id: fromId, to_id: toId, relationship: 'refines', reason: 'Initial proposal' },
        mockContext
      );
      expect(firstResponse.content[0].text).toContain('Link Proposed');

      // Second identical proposal should fail with UNIQUE constraint error
      const secondResponse = await proposeLinkTool.handler(
        { from_id: fromId, to_id: toId, relationship: 'refines', reason: 'Duplicate proposal' },
        mockContext
      );
      expect(secondResponse.content[0].text).toContain('Failed to propose link');
      expect(secondResponse.content[0].text).toContain('UNIQUE constraint');

      // Verify only one link exists
      const adapter = getAdapter();
      const links = adapter
        .prepare(
          `SELECT * FROM decision_edges WHERE from_id = ? AND to_id = ? AND relationship = ?`
        )
        .all(fromId, toId, 'refines');

      expect(links.length).toBe(1);
    });

    it('allows same nodes with different relationships', async () => {
      const fromId = createDecision('multi_rel_from');
      const toId = createDecision('multi_rel_to');

      // Different relationships between same nodes should be allowed
      await proposeLinkTool.handler(
        { from_id: fromId, to_id: toId, relationship: 'refines', reason: 'Refines relationship' },
        mockContext
      );

      await proposeLinkTool.handler(
        {
          from_id: fromId,
          to_id: toId,
          relationship: 'contradicts',
          reason: 'Contradicts relationship',
        },
        mockContext
      );

      const adapter = getAdapter();
      const links = adapter
        .prepare(`SELECT * FROM decision_edges WHERE from_id = ? AND to_id = ?`)
        .all(fromId, toId);

      expect(links.length).toBe(2);
      const relationships = links.map((l) => l.relationship).sort();
      expect(relationships).toEqual(['contradicts', 'refines']);
    });
  });
});
