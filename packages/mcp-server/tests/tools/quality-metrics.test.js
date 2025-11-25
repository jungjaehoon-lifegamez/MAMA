/**
 * Integration Tests: Quality Metrics & Observability (Epic 4 - Story 4.1)
 *
 * Tests coverage and quality measurement functions:
 * - calculateCoverage()
 * - calculateQuality()
 * - generateQualityReport()
 * - generate_quality_report MCP tool
 *
 * @date 2025-11-25
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { generateQualityReportTool } from '../../src/tools/quality-metrics-tools.js';
// eslint-disable-next-line no-unused-vars
import { saveDecisionTool } from '../../src/tools/save-decision.js';
import { initDB, getAdapter, closeDB } from '../../src/mama/memory-store.js';
import mama from '../../src/mama/mama-api.js';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Test database path (isolated from production)
const TEST_DB_PATH = path.join(os.tmpdir(), `mama-test-quality-metrics-${Date.now()}.db`);

// Mock tool context
const mockContext = {
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
  },
};

describe('Story 4.1: Quality Metrics & Observability', () => {
  beforeAll(async () => {
    // Clean up any existing database files
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    [TEST_DB_PATH + '-wal', TEST_DB_PATH + '-shm'].forEach((file) => {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    });

    // Set test database path
    process.env.MAMA_DB_PATH = TEST_DB_PATH;

    // Initialize test database
    await initDB();
  });

  afterAll(async () => {
    // Clean up test database
    await closeDB();
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    // Clean up WAL files
    [TEST_DB_PATH + '-wal', TEST_DB_PATH + '-shm'].forEach((file) => {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    });

    // Clean up environment
    delete process.env.MAMA_DB_PATH;
  });

  beforeEach(async () => {
    // Re-initialize DB to ensure clean state
    // This is necessary because closeDB() in one test can affect other tests
    try {
      // First try to get adapter (if initialized)
      getAdapter();
    } catch (error) {
      // If not initialized, initialize it
      if (error.message.includes('not initialized')) {
        await initDB();
      } else {
        throw error;
      }
    }

    // Now clear all test data
    const adapter = getAdapter();
    try {
      await adapter.prepare('DELETE FROM decision_edges').run();
      await adapter.prepare('DELETE FROM decisions').run();
      // Clear vector embeddings to prevent rowid conflicts
      if (adapter.vectorSearchEnabled) {
        await adapter.prepare('DELETE FROM vss_memories').run();
      }
    } catch (error) {
      console.warn('Error clearing test data:', error.message);
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // AC-4.1.1: Coverage Metrics Calculation
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('AC-4.1.1: calculateCoverage() with various datasets', () => {
    it('should return 0% coverage for empty database', async () => {
      // Explicitly ensure DB is initialized for this test
      await initDB();

      const coverage = mama.calculateCoverage();

      expect(coverage.narrativeCoverage).toBe('0.0%');
      expect(coverage.linkCoverage).toBe('0.0%');
      expect(coverage.totalDecisions).toBe(0);
      expect(coverage.completeNarratives).toBe(0);
      expect(coverage.decisionsWithLinks).toBe(0);
    });

    it('should calculate 100% narrative coverage when all fields are complete', async () => {
      // Explicitly ensure DB is initialized for this test
      await initDB();

      // Create 5 decisions with complete narrative fields
      const adapter = getAdapter();
      const db = adapter.db;

      for (let i = 0; i < 5; i++) {
        const decisionId = `decision_test_${Date.now()}_${i}`;
        db.prepare(
          `INSERT INTO decisions (id, topic, decision, reasoning, evidence, alternatives, risks, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          decisionId,
          `topic_${i}`,
          `Decision ${i}`,
          `Reasoning ${i}`,
          `Evidence: file.js:123`,
          `Alternative: Option A, Option B`,
          `Risk: Performance degradation`,
          Date.now()
        );
      }

      const coverage = mama.calculateCoverage();

      expect(coverage.narrativeCoverage).toBe('100.0%');
      expect(coverage.totalDecisions).toBe(5);
      expect(coverage.completeNarratives).toBe(5);
    });

    it('should calculate partial narrative coverage when some fields are missing', async () => {
      // Explicitly ensure DB is initialized for this test
      await initDB();

      // Create 4 decisions: 2 complete, 2 incomplete
      const adapter = getAdapter();
      const db = adapter.db;

      // Complete narratives
      for (let i = 0; i < 2; i++) {
        db.prepare(
          `INSERT INTO decisions (id, topic, decision, reasoning, evidence, alternatives, risks, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          `decision_complete_${i}`,
          `topic_${i}`,
          `Decision ${i}`,
          `Reasoning ${i}`,
          `Evidence: file.js:${i}`,
          `Alternative: ${i}`,
          `Risk: ${i}`,
          Date.now()
        );
      }

      // Incomplete narratives (missing evidence)
      for (let i = 0; i < 2; i++) {
        db.prepare(
          `INSERT INTO decisions (id, topic, decision, reasoning, alternatives, risks, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          `decision_incomplete_${i}`,
          `topic_incomplete_${i}`,
          `Decision ${i}`,
          `Reasoning ${i}`,
          `Alternative: ${i}`,
          `Risk: ${i}`,
          Date.now()
        );
      }

      const coverage = mama.calculateCoverage();

      expect(coverage.narrativeCoverage).toBe('50.0%'); // 2/4 = 50%
      expect(coverage.totalDecisions).toBe(4);
      expect(coverage.completeNarratives).toBe(2);
    });

    it('should calculate link coverage correctly', async () => {
      // Explicitly ensure DB is initialized for this test
      await initDB();

      // Create 4 decisions: 2 with links, 2 without
      const adapter = getAdapter();
      const db = adapter.db;

      const decisionIds = [];
      for (let i = 0; i < 4; i++) {
        const id = `decision_link_test_${i}`;
        db.prepare(
          `INSERT INTO decisions (id, topic, decision, reasoning, created_at)
           VALUES (?, ?, ?, ?, ?)`
        ).run(id, `topic_${i}`, `Decision ${i}`, `Reasoning ${i}`, Date.now());
        decisionIds.push(id);
      }

      // Add links for first 2 decisions
      db.prepare(
        `INSERT INTO decision_edges (from_id, to_id, relationship, reason, created_at)
         VALUES (?, ?, 'refines', 'Test link', ?)`
      ).run(decisionIds[0], decisionIds[1], Date.now());

      const coverage = mama.calculateCoverage();

      expect(coverage.linkCoverage).toBe('50.0%'); // 2/4 = 50%
      expect(coverage.decisionsWithLinks).toBe(2);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // AC-4.1.2: Quality Metrics Calculation
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('AC-4.1.2: calculateQuality() narrative and link quality', () => {
    it('should calculate narrative quality per field', async () => {
      await initDB();
      // Create 4 decisions with varying completeness
      const adapter = getAdapter();
      const db = adapter.db;

      // All have evidence (4/4 = 100%)
      // 3 have alternatives (3/4 = 75%)
      // 2 have risks (2/4 = 50%)
      const testData = [
        { evidence: 'e1', alternatives: 'a1', risks: 'r1' },
        { evidence: 'e2', alternatives: 'a2', risks: 'r2' },
        { evidence: 'e3', alternatives: 'a3', risks: null },
        { evidence: 'e4', alternatives: null, risks: null },
      ];

      testData.forEach((data, i) => {
        db.prepare(
          `INSERT INTO decisions (id, topic, decision, reasoning, evidence, alternatives, risks, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          `decision_quality_${i}`,
          `topic_${i}`,
          `Decision ${i}`,
          `Reasoning ${i}`,
          data.evidence,
          data.alternatives,
          data.risks,
          Date.now()
        );
      });

      const quality = mama.calculateQuality();

      expect(quality.narrativeQuality.evidence).toBe('100.0%');
      expect(quality.narrativeQuality.alternatives).toBe('75.0%');
      expect(quality.narrativeQuality.risks).toBe('50.0%');
    });

    it('should calculate link quality - rich reason ratio', async () => {
      await initDB();

      // Create decisions and links with varying reason quality
      const adapter = getAdapter();
      const db = adapter.db;

      // Create 2 decisions
      for (let i = 0; i < 2; i++) {
        db.prepare(
          `INSERT INTO decisions (id, topic, decision, reasoning, created_at)
           VALUES (?, ?, ?, ?, ?)`
        ).run(
          `decision_link_quality_${i}`,
          `topic_${i}`,
          `Decision ${i}`,
          `Reasoning ${i}`,
          Date.now()
        );
      }

      // Add 3 links: 2 with rich reasons (>50 chars), 1 with short reason
      const richReason =
        'This is a detailed reason with more than 50 characters explaining the relationship clearly.';
      const shortReason = 'Brief';

      db.prepare(
        `INSERT INTO decision_edges (from_id, to_id, relationship, reason, created_at, created_by, approved_by_user)
         VALUES (?, ?, 'refines', ?, ?, 'llm', 1)`
      ).run('decision_link_quality_0', 'decision_link_quality_1', richReason, Date.now());

      db.prepare(
        `INSERT INTO decision_edges (from_id, to_id, relationship, reason, created_at, created_by, approved_by_user)
         VALUES (?, ?, 'refines', ?, ?, 'llm', 1)`
      ).run('decision_link_quality_1', 'decision_link_quality_0', richReason, Date.now());

      db.prepare(
        `INSERT INTO decision_edges (from_id, to_id, relationship, reason, created_at, created_by, approved_by_user)
         VALUES (?, ?, 'contradicts', ?, ?, 'user', 0)`
      ).run('decision_link_quality_0', 'decision_link_quality_1', shortReason, Date.now());

      const quality = mama.calculateQuality();

      expect(quality.linkQuality.totalLinks).toBe(3);
      expect(quality.linkQuality.richLinks).toBe(2);
      expect(quality.linkQuality.richReasonRatio).toBe('66.7%'); // 2/3
    });

    it('should calculate approved link ratio', async () => {
      await initDB();

      // Create decisions and links with varying approval status
      const adapter = getAdapter();
      const db = adapter.db;

      // Create 2 decisions
      for (let i = 0; i < 2; i++) {
        db.prepare(
          `INSERT INTO decisions (id, topic, decision, reasoning, created_at)
           VALUES (?, ?, ?, ?, ?)`
        ).run(
          `decision_approval_${i}`,
          `topic_${i}`,
          `Decision ${i}`,
          `Reasoning ${i}`,
          Date.now()
        );
      }

      // Add 4 links: 3 approved, 1 not approved
      // Note: decision_edges has PRIMARY KEY (from_id, to_id, relationship)
      // So we need unique combinations
      db.prepare(
        `INSERT INTO decision_edges (from_id, to_id, relationship, reason, created_at, created_by, approved_by_user)
         VALUES (?, ?, 'refines', 'Approved link 1', ?, 'llm', 1)`
      ).run('decision_approval_0', 'decision_approval_1', Date.now());

      db.prepare(
        `INSERT INTO decision_edges (from_id, to_id, relationship, reason, created_at, created_by, approved_by_user)
         VALUES (?, ?, 'refines', 'Approved link 2', ?, 'llm', 1)`
      ).run('decision_approval_1', 'decision_approval_0', Date.now());

      // Create a new decision pair for the 3rd approved link
      db.prepare(
        `INSERT INTO decisions (id, topic, decision, reasoning, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run('decision_approval_2', 'topic_2', 'Decision 2', 'Reasoning 2', Date.now());

      db.prepare(
        `INSERT INTO decision_edges (from_id, to_id, relationship, reason, created_at, created_by, approved_by_user)
         VALUES (?, ?, 'refines', 'Approved link 3', ?, 'llm', 1)`
      ).run('decision_approval_0', 'decision_approval_2', Date.now());

      db.prepare(
        `INSERT INTO decision_edges (from_id, to_id, relationship, reason, created_at, created_by, approved_by_user)
         VALUES (?, ?, 'contradicts', 'Not approved', ?, 'llm', 0)`
      ).run('decision_approval_1', 'decision_approval_0', Date.now());

      const quality = mama.calculateQuality();

      expect(quality.linkQuality.totalLinks).toBe(4);
      expect(quality.linkQuality.approvedLinks).toBe(3);
      expect(quality.linkQuality.approvedRatio).toBe('75.0%'); // 3/4
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // AC-4.1.3: Report Generation and Recommendations
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('AC-4.1.3: generateQualityReport() with recommendations', () => {
    it('should generate JSON format report', async () => {
      await initDB();
      // Create minimal test data
      const adapter = getAdapter();
      const db = adapter.db;

      db.prepare(
        `INSERT INTO decisions (id, topic, decision, reasoning, evidence, alternatives, risks, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'decision_report_test',
        'topic_test',
        'Decision',
        'Reasoning',
        'Evidence',
        'Alt',
        'Risk',
        Date.now()
      );

      const report = mama.generateQualityReport({ format: 'json' });

      expect(report).toBeDefined();
      expect(report.generated_at).toBeDefined();
      expect(report.coverage).toBeDefined();
      expect(report.quality).toBeDefined();
      expect(report.thresholds).toBeDefined();
      expect(report.recommendations).toBeDefined();
      expect(Array.isArray(report.recommendations)).toBe(true);
    });

    it('should generate Markdown format report', async () => {
      await initDB();

      const adapter = getAdapter();
      const db = adapter.db;

      db.prepare(
        `INSERT INTO decisions (id, topic, decision, reasoning, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run('decision_markdown', 'topic', 'Decision', 'Reasoning', Date.now());

      const report = mama.generateQualityReport({ format: 'markdown' });

      expect(typeof report).toBe('string');
      expect(report).toMatch(/MAMA Quality Report/);
      expect(report).toMatch(/Coverage Metrics/);
      expect(report).toMatch(/Quality Metrics/);
    });

    it('should generate recommendations when below threshold', async () => {
      await initDB();

      // Create data that falls below thresholds
      const adapter = getAdapter();
      const db = adapter.db;

      // Create 10 decisions: only 5 with complete narratives (50% < 80%)
      for (let i = 0; i < 5; i++) {
        db.prepare(
          `INSERT INTO decisions (id, topic, decision, reasoning, evidence, alternatives, risks, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          `decision_complete_${i}`,
          `topic_${i}`,
          `Decision ${i}`,
          `Reasoning ${i}`,
          'E',
          'A',
          'R',
          Date.now()
        );
      }

      for (let i = 0; i < 5; i++) {
        db.prepare(
          `INSERT INTO decisions (id, topic, decision, reasoning, created_at)
           VALUES (?, ?, ?, ?, ?)`
        ).run(
          `decision_incomplete_${i}`,
          `topic_inc_${i}`,
          `Decision ${i}`,
          `Reasoning ${i}`,
          Date.now()
        );
      }

      const report = mama.generateQualityReport();

      expect(report.recommendations.length).toBeGreaterThan(0);

      // Should have narrative coverage recommendation
      const narrativeRec = report.recommendations.find((r) => r.type === 'narrative_coverage');
      expect(narrativeRec).toBeDefined();
      expect(narrativeRec.target).toBe('80%');
      expect(narrativeRec.current).toBe('50.0%');
    });

    it('should not generate recommendations when above threshold', async () => {
      await initDB();

      // Create data that exceeds thresholds
      const adapter = getAdapter();
      const db = adapter.db;

      // Create 10 decisions with complete narratives (100% > 80%)
      for (let i = 0; i < 10; i++) {
        db.prepare(
          `INSERT INTO decisions (id, topic, decision, reasoning, evidence, alternatives, risks, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          `decision_good_${i}`,
          `topic_${i}`,
          `Decision ${i}`,
          `Reasoning ${i}`,
          'E',
          'A',
          'R',
          Date.now()
        );
      }

      // Add links for all (100% > 70%)
      for (let i = 0; i < 9; i++) {
        db.prepare(
          `INSERT INTO decision_edges (from_id, to_id, relationship, reason, created_at, created_by, approved_by_user)
           VALUES (?, ?, 'refines', ?, ?, 'llm', 1)`
        ).run(
          `decision_good_${i}`,
          `decision_good_${i + 1}`,
          'This is a rich reason with more than 50 characters describing the relationship.',
          Date.now()
        );
      }

      const report = mama.generateQualityReport();

      expect(report.recommendations.length).toBe(0);
    });

    it('should support custom thresholds', async () => {
      await initDB();

      const adapter = getAdapter();
      const db = adapter.db;

      // Create 10 decisions with 80% narrative coverage
      for (let i = 0; i < 8; i++) {
        db.prepare(
          `INSERT INTO decisions (id, topic, decision, reasoning, evidence, alternatives, risks, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          `decision_custom_${i}`,
          `topic_${i}`,
          `Decision ${i}`,
          `Reasoning ${i}`,
          'E',
          'A',
          'R',
          Date.now()
        );
      }

      for (let i = 0; i < 2; i++) {
        db.prepare(
          `INSERT INTO decisions (id, topic, decision, reasoning, created_at)
           VALUES (?, ?, ?, ?, ?)`
        ).run(
          `decision_custom_incomplete_${i}`,
          `topic_${i}`,
          `Decision ${i}`,
          `Reasoning ${i}`,
          Date.now()
        );
      }

      // With default threshold (0.8): 80% should pass for narrative, but link thresholds will fail (no links)
      // Expected: 2 recommendations (link_coverage, link_quality)
      const reportDefault = mama.generateQualityReport();
      expect(reportDefault.recommendations.length).toBe(2);
      expect(reportDefault.recommendations.some((r) => r.type === 'link_coverage')).toBe(true);
      expect(reportDefault.recommendations.some((r) => r.type === 'link_quality')).toBe(true);

      // With custom threshold (0.9): 80% should fail (has recommendations)
      const reportCustom = mama.generateQualityReport({
        thresholds: { narrativeCoverage: 0.9 },
      });
      expect(reportCustom.recommendations.length).toBeGreaterThan(0);
      const narrativeRec = reportCustom.recommendations.find(
        (r) => r.type === 'narrative_coverage'
      );
      expect(narrativeRec).toBeDefined();
      expect(narrativeRec.target).toBe('90%');
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // MCP Tool Integration Tests
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('MCP Tool: generate_quality_report', () => {
    it('should work with JSON format (default)', async () => {
      await initDB();
      const adapter = getAdapter();
      const db = adapter.db;

      db.prepare(
        `INSERT INTO decisions (id, topic, decision, reasoning, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run('decision_mcp_test', 'topic', 'Decision', 'Reasoning', Date.now());

      const result = await generateQualityReportTool.handler({}, mockContext);

      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe('text');

      const reportText = result.content[0].text;
      const report = JSON.parse(reportText);

      expect(report.coverage).toBeDefined();
      expect(report.quality).toBeDefined();
    });

    it('should work with Markdown format', async () => {
      await initDB();

      const adapter = getAdapter();
      const db = adapter.db;

      db.prepare(
        `INSERT INTO decisions (id, topic, decision, reasoning, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run('decision_mcp_md', 'topic', 'Decision', 'Reasoning', Date.now());

      const result = await generateQualityReportTool.handler({ format: 'markdown' }, mockContext);

      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toMatch(/MAMA Quality Report/);
    });

    it('should handle errors gracefully', async () => {
      // Close database to simulate error
      await closeDB();

      const result = await generateQualityReportTool.handler({}, mockContext);

      expect(result.content).toBeDefined();
      expect(result.content[0].text).toMatch(/Failed to generate quality report/);

      // Reinitialize for cleanup
      await initDB();
    });
  });
});
