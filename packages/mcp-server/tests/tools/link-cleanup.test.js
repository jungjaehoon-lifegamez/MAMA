/**
 * Link Cleanup Tools Integration Tests (Epic 5 - Stories 5.1 & 5.2)
 *
 * Story 5.1: Verifies scan/backup/report/restore flows for auto-link cleanup migration.
 * Tests AC-5.1.1 (scanning), AC-5.1.2 (backup), AC-5.1.3 (reporting).
 *
 * Story 5.2: Verifies deletion execution and validation flows.
 * Tests AC-5.2.1 (deletion logic), AC-5.2.2 (validation), AC-5.2.3 (audit logging).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import {
  scanAutoLinksTool,
  createLinkBackupTool,
  generateCleanupReportTool,
  restoreLinkBackupTool,
  executeLinkCleanupTool,
  validateCleanupResultTool,
} from '../../src/tools/link-tools.js';
import mama from '../../src/mama/mama-api.js';
import { initDB, getAdapter, closeDB } from '../../src/mama/memory-store.js';

const TEST_DB_PATH = path.join(os.tmpdir(), `mama-link-cleanup-${Date.now()}.db`);
const BACKUP_DIR = path.join(process.env.HOME, '.claude', 'mama-backups');

function cleanupDbFiles() {
  [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`].forEach((file) => {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  });
}

function cleanupBackupFiles() {
  if (fs.existsSync(BACKUP_DIR)) {
    const files = fs.readdirSync(BACKUP_DIR);
    files.forEach((file) => {
      if (
        file.includes('links-backup') ||
        file.includes('backup-manifest') ||
        file.includes('pre-cleanup-report')
      ) {
        fs.unlinkSync(path.join(BACKUP_DIR, file));
      }
    });
  }
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

function createAutoLink(fromId, toId, relationship = 'refines') {
  const adapter = getAdapter();
  const now = Date.now();

  // Auto link: approved_by_user = 0, created_by = NULL, decision_id = NULL
  adapter
    .prepare(
      `
      INSERT INTO decision_edges (from_id, to_id, relationship, reason, created_by, approved_by_user, decision_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
    )
    .run(fromId, toId, relationship, 'Generic auto-generated link', null, 0, null, now);
}

function createProtectedLink(fromId, toId, relationship = 'refines') {
  const adapter = getAdapter();
  const now = Date.now();

  // Protected link: approved_by_user = 1, decision_id IS NOT NULL
  const decisionId = `decision_link_context_${Date.now()}`;
  adapter
    .prepare(
      `
      INSERT INTO decision_edges (from_id, to_id, relationship, reason, created_by, approved_by_user, decision_id, evidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    )
    .run(
      fromId,
      toId,
      relationship,
      'User-approved link with context',
      'llm',
      1,
      decisionId,
      'test evidence',
      now
    );
}

describe('Epic 5.1: Link Cleanup Tools', () => {
  beforeAll(async () => {
    cleanupDbFiles();
    cleanupBackupFiles();
    process.env.MAMA_DB_PATH = TEST_DB_PATH;
    await initDB();
  });

  afterAll(async () => {
    await closeDB();
    cleanupDbFiles();
    cleanupBackupFiles();
    delete process.env.MAMA_DB_PATH;
  });

  beforeEach(async () => {
    await initDB();
    const adapter = getAdapter();
    adapter.prepare('DELETE FROM link_audit_log').run();
    adapter.prepare('DELETE FROM decision_edges').run();
    adapter.prepare('DELETE FROM decisions').run();
    if (adapter.vectorSearchEnabled) {
      adapter.prepare('DELETE FROM vss_memories').run();
    }
  });

  describe('AC-5.1.1: Auto-Link Identification', () => {
    it('scanAutoLinks identifies auto-generated links correctly', () => {
      const d1 = createDecision('scan_test_1');
      const d2 = createDecision('scan_test_2');
      const d3 = createDecision('scan_test_3');

      // Create 2 auto links
      createAutoLink(d1, d2, 'refines');
      createAutoLink(d2, d3, 'contradicts');

      // Create 1 protected link
      createProtectedLink(d1, d3, 'refines');

      const scanResult = mama.scanAutoLinks();

      expect(scanResult.total_links).toBe(3);
      expect(scanResult.auto_links).toBe(2);
      expect(scanResult.protected_links).toBe(1);
      expect(scanResult.deletion_targets).toBe(2);
      expect(scanResult.deletion_target_list.length).toBe(2);
    });

    it('scanAutoLinks handles empty database', () => {
      const scanResult = mama.scanAutoLinks();

      expect(scanResult.total_links).toBe(0);
      expect(scanResult.auto_links).toBe(0);
      expect(scanResult.protected_links).toBe(0);
      expect(scanResult.deletion_targets).toBe(0);
    });

    it('scanAutoLinks excludes protected links from deletion targets', () => {
      const d1 = createDecision('protect_test_1');
      const d2 = createDecision('protect_test_2');

      createAutoLink(d1, d2, 'refines');
      createProtectedLink(d1, d2, 'contradicts'); // Same nodes, different relationship

      const scanResult = mama.scanAutoLinks();

      expect(scanResult.total_links).toBe(2);
      expect(scanResult.deletion_targets).toBe(1); // Only the auto link
    });

    it('scan_auto_links tool returns formatted output', async () => {
      const d1 = createDecision('tool_test_1');
      const d2 = createDecision('tool_test_2');

      createAutoLink(d1, d2, 'refines');

      const result = await scanAutoLinksTool.handler({ include_samples: true });

      expect(result.content).toBeTruthy();
      expect(result.content[0].text).toContain('Auto-Link Scan Results');
      expect(result.content[0].text).toContain('Total Links: 1');
      expect(result.content[0].text).toContain('Deletion Targets: 1');
    });
  });

  describe('AC-5.1.2: Backup File Creation', () => {
    it('createLinkBackup generates backup with checksum', () => {
      const d1 = createDecision('backup_test_1');
      const d2 = createDecision('backup_test_2');

      createAutoLink(d1, d2, 'refines');

      const scanResult = mama.scanAutoLinks();
      const backupResult = mama.createLinkBackup(scanResult.deletion_target_list);

      expect(backupResult.backup_file).toBeTruthy();
      expect(backupResult.manifest_file).toBeTruthy();
      expect(backupResult.checksum).toBeTruthy();
      expect(backupResult.link_count).toBe(1);

      // Verify backup file exists
      expect(fs.existsSync(backupResult.backup_file)).toBe(true);
      expect(fs.existsSync(backupResult.manifest_file)).toBe(true);

      // Verify backup content
      const backupJson = fs.readFileSync(backupResult.backup_file, 'utf8');
      const backupData = JSON.parse(backupJson);

      expect(backupData.link_count).toBe(1);
      expect(backupData.links.length).toBe(1);
      expect(backupData.links[0].from_id).toBe(d1);
      expect(backupData.links[0].to_id).toBe(d2);
    });

    it('createLinkBackup includes all metadata fields', () => {
      const d1 = createDecision('metadata_test_1');
      const d2 = createDecision('metadata_test_2');

      createAutoLink(d1, d2, 'refines');

      const scanResult = mama.scanAutoLinks();
      const backupResult = mama.createLinkBackup(scanResult.deletion_target_list);

      const backupJson = fs.readFileSync(backupResult.backup_file, 'utf8');
      const backupData = JSON.parse(backupJson);
      const link = backupData.links[0];

      // Verify all metadata fields are present
      expect(link).toHaveProperty('from_id');
      expect(link).toHaveProperty('to_id');
      expect(link).toHaveProperty('relationship');
      expect(link).toHaveProperty('reason');
      expect(link).toHaveProperty('created_by');
      expect(link).toHaveProperty('approved_by_user');
      expect(link).toHaveProperty('decision_id');
      expect(link).toHaveProperty('evidence');
      expect(link).toHaveProperty('created_at');
    });

    it('createLinkBackup checksum verification succeeds', () => {
      const d1 = createDecision('checksum_test_1');
      const d2 = createDecision('checksum_test_2');

      createAutoLink(d1, d2, 'refines');

      const scanResult = mama.scanAutoLinks();
      const backupResult = mama.createLinkBackup(scanResult.deletion_target_list);

      // Recalculate checksum and verify
      const backupJson = fs.readFileSync(backupResult.backup_file, 'utf8');
      const calculatedChecksum = crypto.createHash('sha256').update(backupJson).digest('hex');

      expect(calculatedChecksum).toBe(backupResult.checksum);
    });

    it('create_link_backup tool creates backup successfully', async () => {
      const d1 = createDecision('tool_backup_1');
      const d2 = createDecision('tool_backup_2');

      createAutoLink(d1, d2, 'refines');

      const result = await createLinkBackupTool.handler({ include_protected: false });

      expect(result.content).toBeTruthy();
      expect(result.content[0].text).toContain('Backup Created Successfully');
      expect(result.content[0].text).toContain('Links Backed Up:** 1');
    });
  });

  describe('AC-5.1.3: Pre-Cleanup Report Generation', () => {
    it('generatePreCleanupReport calculates risk level HIGH', () => {
      const d1 = createDecision('risk_high_1');
      const d2 = createDecision('risk_high_2');
      const d3 = createDecision('risk_high_3');

      // 2 auto links, 1 protected = 2/3 = 66% deletion ratio (HIGH)
      createAutoLink(d1, d2, 'refines');
      createAutoLink(d2, d3, 'refines');
      createProtectedLink(d1, d3, 'refines');

      const reportResult = mama.generatePreCleanupReport();

      expect(reportResult.report.risk_assessment.level).toBe('HIGH');
      expect(reportResult.report.statistics.deletion_ratio).toContain('66.7%');
      expect(reportResult.markdown).toContain('HIGH RISK');
    });

    it('generatePreCleanupReport calculates risk level MEDIUM', () => {
      const d1 = createDecision('risk_medium_1');
      const d2 = createDecision('risk_medium_2');
      const d3 = createDecision('risk_medium_3');
      const d4 = createDecision('risk_medium_4');

      // 2 auto links, 3 protected = 2/5 = 40% deletion ratio (MEDIUM)
      createAutoLink(d1, d2, 'refines');
      createAutoLink(d2, d3, 'refines');
      createProtectedLink(d1, d3, 'refines');
      createProtectedLink(d2, d4, 'refines');
      createProtectedLink(d3, d4, 'refines');

      const reportResult = mama.generatePreCleanupReport();

      expect(reportResult.report.risk_assessment.level).toBe('MEDIUM');
      expect(reportResult.report.statistics.deletion_ratio).toContain('40.0%');
      expect(reportResult.markdown).toContain('MEDIUM RISK');
    });

    it('generatePreCleanupReport calculates risk level LOW', () => {
      const d1 = createDecision('risk_low_1');
      const d2 = createDecision('risk_low_2');
      const d3 = createDecision('risk_low_3');
      const d4 = createDecision('risk_low_4');

      // 1 auto link, 4 protected = 1/5 = 20% deletion ratio (LOW)
      createAutoLink(d1, d2, 'refines');
      createProtectedLink(d1, d3, 'refines');
      createProtectedLink(d2, d3, 'refines');
      createProtectedLink(d2, d4, 'refines');
      createProtectedLink(d3, d4, 'refines');

      const reportResult = mama.generatePreCleanupReport();

      expect(reportResult.report.risk_assessment.level).toBe('LOW');
      expect(reportResult.report.statistics.deletion_ratio).toContain('20.0%');
      expect(reportResult.markdown).toContain('LOW RISK');
    });

    it('generatePreCleanupReport includes sample links', () => {
      const decisions = [];
      for (let i = 1; i <= 12; i++) {
        decisions.push(createDecision(`sample_test_${i}`));
      }

      // Create 12 auto links (report should show max 10 samples)
      for (let i = 0; i < 12; i++) {
        createAutoLink(decisions[i], decisions[(i + 1) % 12], 'refines');
      }

      const reportResult = mama.generatePreCleanupReport();

      expect(reportResult.report.deletion_target_samples.length).toBe(10);
      expect(reportResult.markdown).toContain('Sample Deletion Targets');
    });

    it('generatePreCleanupReport saves report file', () => {
      const d1 = createDecision('report_file_1');
      const d2 = createDecision('report_file_2');

      createAutoLink(d1, d2, 'refines');

      const reportResult = mama.generatePreCleanupReport();

      expect(reportResult.report_file).toBeTruthy();
      expect(fs.existsSync(reportResult.report_file)).toBe(true);

      const reportContent = fs.readFileSync(reportResult.report_file, 'utf8');
      expect(reportContent).toContain('Pre-Cleanup Report');
      expect(reportContent).toContain('Statistics');
      expect(reportContent).toContain('Risk Assessment');
    });

    it('generate_cleanup_report tool generates markdown report', async () => {
      const d1 = createDecision('tool_report_1');
      const d2 = createDecision('tool_report_2');

      createAutoLink(d1, d2, 'refines');

      const result = await generateCleanupReportTool.handler({ format: 'markdown' });

      expect(result.content).toBeTruthy();
      expect(result.content[0].text).toContain('Pre-Cleanup Report Generated');
      expect(result.content[0].text).toContain('Statistics');
    });

    it('generate_cleanup_report tool generates JSON report', async () => {
      const d1 = createDecision('tool_json_1');
      const d2 = createDecision('tool_json_2');

      createAutoLink(d1, d2, 'refines');

      const result = await generateCleanupReportTool.handler({ format: 'json' });

      expect(result.content).toBeTruthy();
      const jsonData = JSON.parse(result.content[0].text);
      expect(jsonData).toHaveProperty('generated_at');
      expect(jsonData).toHaveProperty('statistics');
      expect(jsonData).toHaveProperty('risk_assessment');
    });
  });

  describe('Rollback: Restore Link Backup', () => {
    it('restoreLinkBackup restores links from backup', () => {
      const d1 = createDecision('restore_test_1');
      const d2 = createDecision('restore_test_2');

      createAutoLink(d1, d2, 'refines');

      const scanResult = mama.scanAutoLinks();
      const backupResult = mama.createLinkBackup(scanResult.deletion_target_list);

      // Delete the link
      const adapter = getAdapter();
      adapter.prepare('DELETE FROM decision_edges WHERE from_id = ? AND to_id = ?').run(d1, d2);

      // Verify link is deleted
      const beforeRestore = adapter.prepare('SELECT COUNT(*) as count FROM decision_edges').get();
      expect(beforeRestore.count).toBe(0);

      // Restore from backup
      const restoreResult = mama.restoreLinkBackup(backupResult.backup_file);

      expect(restoreResult.total_links).toBe(1);
      expect(restoreResult.restored).toBe(1);
      expect(restoreResult.failed).toBe(0);

      // Verify link is restored
      const afterRestore = adapter.prepare('SELECT COUNT(*) as count FROM decision_edges').get();
      expect(afterRestore.count).toBe(1);
    });

    it('restoreLinkBackup verifies checksum before restore', () => {
      const d1 = createDecision('checksum_fail_1');
      const d2 = createDecision('checksum_fail_2');

      createAutoLink(d1, d2, 'refines');

      const scanResult = mama.scanAutoLinks();
      const backupResult = mama.createLinkBackup(scanResult.deletion_target_list);

      // Corrupt the backup file
      const backupJson = fs.readFileSync(backupResult.backup_file, 'utf8');
      const corruptedJson = backupJson.replace(d1, 'corrupted_id');
      fs.writeFileSync(backupResult.backup_file, corruptedJson, 'utf8');

      // Attempt restore (should fail due to checksum mismatch)
      expect(() => {
        mama.restoreLinkBackup(backupResult.backup_file);
      }).toThrow('checksum mismatch');
    });

    it('restore_link_backup tool restores backup successfully', async () => {
      const d1 = createDecision('tool_restore_1');
      const d2 = createDecision('tool_restore_2');

      createAutoLink(d1, d2, 'refines');

      const scanResult = mama.scanAutoLinks();
      const backupResult = mama.createLinkBackup(scanResult.deletion_target_list);

      // Delete the link
      const adapter = getAdapter();
      adapter.prepare('DELETE FROM decision_edges WHERE from_id = ? AND to_id = ?').run(d1, d2);

      // Restore via tool
      const result = await restoreLinkBackupTool.handler({ backup_file: backupResult.backup_file });

      expect(result.content).toBeTruthy();
      expect(result.content[0].text).toContain('Backup Restored');
      expect(result.content[0].text).toContain('Restored:** 1');
      expect(result.content[0].text).toContain('Failed:** 0');
    });
  });

  describe('Integration: Scan → Backup → Report → Restore', () => {
    it('full workflow completes successfully', async () => {
      // Setup: Create mixed links
      const d1 = createDecision('workflow_1');
      const d2 = createDecision('workflow_2');
      const d3 = createDecision('workflow_3');

      createAutoLink(d1, d2, 'refines');
      createAutoLink(d2, d3, 'contradicts');
      createProtectedLink(d1, d3, 'refines');

      // Step 1: Scan
      const scanResult = await scanAutoLinksTool.handler({ include_samples: true });
      expect(scanResult.content[0].text).toContain('Deletion Targets: 2');

      // Step 2: Backup
      const backupResult = await createLinkBackupTool.handler({ include_protected: false });
      expect(backupResult.content[0].text).toContain('Links Backed Up:** 2');

      // Step 3: Report
      const reportResult = await generateCleanupReportTool.handler({ format: 'markdown' });
      expect(reportResult.content[0].text).toContain('Statistics');

      // Step 4: Delete auto links (simulate cleanup)
      const adapter = getAdapter();
      adapter.prepare('DELETE FROM decision_edges WHERE approved_by_user = 0').run();

      const afterCleanup = adapter.prepare('SELECT COUNT(*) as count FROM decision_edges').get();
      expect(afterCleanup.count).toBe(1); // Only protected link remains

      // Step 5: Restore (rollback)
      const backupFilePath = backupResult.content[0].text.match(
        /\*\*Backup File:\*\* (.+\.json)/
      )[1];
      const restoreResult = await restoreLinkBackupTool.handler({ backup_file: backupFilePath });
      expect(restoreResult.content[0].text).toContain('Restored:** 2');

      // Verify all links restored
      const afterRestore = adapter.prepare('SELECT COUNT(*) as count FROM decision_edges').get();
      expect(afterRestore.count).toBe(3); // All links back
    });
  });

  describe('Story 5.2: AC-5.2.1 - Deletion Execution Logic', () => {
    it('verifyBackupExists succeeds with recent backup', () => {
      // Clean up any existing backups first
      cleanupBackupFiles();

      const d1 = createDecision('backup_verify_1');
      const d2 = createDecision('backup_verify_2');
      createAutoLink(d1, d2, 'refines');

      const scanResult = mama.scanAutoLinks();
      mama.createLinkBackup(scanResult.deletion_target_list);

      // Verify backup exists and is recent
      const verifyResult = mama.verifyBackupExists(24);

      expect(verifyResult).toBeTruthy();
      expect(verifyResult.backup_file).toContain('links-backup-');
      expect(verifyResult.age_hours).toBeLessThan(1);
      expect(verifyResult.link_count).toBe(1);
    });

    it('verifyBackupExists fails with no backup', () => {
      // Clean up any existing backups first
      cleanupBackupFiles();

      expect(() => {
        mama.verifyBackupExists(24);
      }).toThrow('No recent backup found');
    });

    it('verifyBackupExists fails with old backup', () => {
      const d1 = createDecision('old_backup_1');
      const d2 = createDecision('old_backup_2');
      createAutoLink(d1, d2, 'refines');

      const scanResult = mama.scanAutoLinks();
      const backupResult = mama.createLinkBackup(scanResult.deletion_target_list);

      // Manually set backup file timestamp to 25 hours ago
      const backupAgeHours = 25 * 60 * 60 * 1000; // 25 hours in milliseconds
      const oldTimestamp = Date.now() - backupAgeHours;
      fs.utimesSync(backupResult.backup_file, new Date(oldTimestamp), new Date(oldTimestamp));

      expect(() => {
        mama.verifyBackupExists(24);
      }).toThrow('Most recent backup is too old');
    });

    it('deleteAutoLinks dry-run mode does not delete', () => {
      const d1 = createDecision('dry_run_1');
      const d2 = createDecision('dry_run_2');
      const d3 = createDecision('dry_run_3');

      createAutoLink(d1, d2, 'refines');
      createAutoLink(d2, d3, 'refines');
      createProtectedLink(d1, d3, 'refines');

      // Create backup first
      const scanResult = mama.scanAutoLinks();
      mama.createLinkBackup(scanResult.deletion_target_list);

      // Execute dry-run (default)
      const deleteResult = mama.deleteAutoLinks(100, true);

      expect(deleteResult.dry_run).toBe(true);
      expect(deleteResult.would_delete).toBe(2);
      expect(deleteResult.deleted).toBe(0);

      // Verify nothing was deleted
      const adapter = getAdapter();
      const afterDryRun = adapter.prepare('SELECT COUNT(*) as count FROM decision_edges').get();
      expect(afterDryRun.count).toBe(3); // All links still present
    });

    it('deleteAutoLinks executes actual deletion', () => {
      const d1 = createDecision('actual_delete_1');
      const d2 = createDecision('actual_delete_2');
      const d3 = createDecision('actual_delete_3');

      createAutoLink(d1, d2, 'refines');
      createAutoLink(d2, d3, 'refines');
      createProtectedLink(d1, d3, 'refines');

      // Create backup first
      const scanResult = mama.scanAutoLinks();
      mama.createLinkBackup(scanResult.deletion_target_list);

      // Execute actual deletion
      const deleteResult = mama.deleteAutoLinks(100, false);

      expect(deleteResult.dry_run).toBe(false);
      expect(deleteResult.deleted).toBe(2);
      expect(deleteResult.failed).toBe(0);
      expect(deleteResult.success_rate).toBe(100);

      // Verify only protected link remains
      const adapter = getAdapter();
      const afterDelete = adapter.prepare('SELECT COUNT(*) as count FROM decision_edges').get();
      expect(afterDelete.count).toBe(1);

      // Verify audit log entries
      const auditLogs = adapter
        .prepare('SELECT COUNT(*) as count FROM link_audit_log WHERE action = ?')
        .get('deprecated');
      expect(auditLogs.count).toBe(2);
    });

    it('deleteAutoLinks batch processing handles large datasets', () => {
      const decisions = [];
      for (let i = 1; i <= 150; i++) {
        decisions.push(createDecision(`batch_test_${i}`));
      }

      // Create 150 auto links
      for (let i = 0; i < 150; i++) {
        createAutoLink(decisions[i], decisions[(i + 1) % 150], 'refines');
      }

      // Create backup
      const scanResult = mama.scanAutoLinks();
      mama.createLinkBackup(scanResult.deletion_target_list);

      // Execute with batch size 50
      const deleteResult = mama.deleteAutoLinks(50, false);

      expect(deleteResult.deleted).toBe(150);
      expect(deleteResult.batches_processed).toBeGreaterThan(1);
      expect(deleteResult.success_rate).toBe(100);
    });

    it('deleteAutoLinks warns on large deletion (>1000 links)', () => {
      const decisions = [];
      for (let i = 1; i <= 1001; i++) {
        decisions.push(createDecision(`large_deletion_${i}`));
      }

      // Create 1001 auto links
      for (let i = 0; i < 1001; i++) {
        createAutoLink(decisions[i], decisions[(i + 1) % 1001], 'refines');
      }

      // Create backup
      const scanResult = mama.scanAutoLinks();
      mama.createLinkBackup(scanResult.deletion_target_list);

      // Execute dry-run
      const deleteResult = mama.deleteAutoLinks(100, true);

      expect(deleteResult.dry_run).toBe(true);
      expect(deleteResult.would_delete).toBe(1001);
      expect(deleteResult.large_deletion_warning).toBe(true);
      expect(deleteResult.warning_message).toContain('1000 links');
    });

    it('deleteAutoLinks requires backup verification', () => {
      // Clean up any existing backups first
      cleanupBackupFiles();

      const d1 = createDecision('no_backup_1');
      const d2 = createDecision('no_backup_2');

      createAutoLink(d1, d2, 'refines');

      // Attempt deletion without backup
      expect(() => {
        mama.deleteAutoLinks(100, false);
      }).toThrow('No recent backup found');
    });

    it('execute_link_cleanup tool dry-run mode', async () => {
      const d1 = createDecision('tool_dry_run_1');
      const d2 = createDecision('tool_dry_run_2');

      createAutoLink(d1, d2, 'refines');

      // Create backup
      const scanResult = mama.scanAutoLinks();
      mama.createLinkBackup(scanResult.deletion_target_list);

      // Execute tool in dry-run mode
      const result = await executeLinkCleanupTool.handler({ batch_size: 100, dry_run: true });

      expect(result.content).toBeTruthy();
      expect(result.content[0].text).toContain('DRY RUN MODE');
      expect(result.content[0].text).toContain('**Would Delete:** 1');
    });

    it('execute_link_cleanup tool actual execution', async () => {
      const d1 = createDecision('tool_execute_1');
      const d2 = createDecision('tool_execute_2');

      createAutoLink(d1, d2, 'refines');

      // Create backup
      const scanResult = mama.scanAutoLinks();
      mama.createLinkBackup(scanResult.deletion_target_list);

      // Execute tool
      const result = await executeLinkCleanupTool.handler({ batch_size: 100, dry_run: false });

      expect(result.content).toBeTruthy();
      expect(result.content[0].text).toContain('Cleanup Execution Complete');
      expect(result.content[0].text).toContain('Deleted: 1');
      expect(result.content[0].text).toContain('Success Rate: 100%');
    });
  });

  describe('Story 5.2: AC-5.2.2 - Post-Cleanup Validation', () => {
    it('validateCleanupResult reports SUCCESS (<5% remaining)', () => {
      // Create 100 links total
      const decisions = [];
      for (let i = 1; i <= 100; i++) {
        decisions.push(createDecision(`validate_success_${i}`));
      }

      // Create 96 auto links, 4 protected
      for (let i = 0; i < 96; i++) {
        createAutoLink(decisions[i], decisions[(i + 1) % 100], 'refines');
      }
      for (let i = 96; i < 100; i++) {
        createProtectedLink(decisions[i], decisions[(i + 1) % 100], 'refines');
      }

      // Create backup and delete
      const scanResult = mama.scanAutoLinks();
      mama.createLinkBackup(scanResult.deletion_target_list);
      mama.deleteAutoLinks(100, false);

      // Validate
      const validateResult = mama.validateCleanupResult();

      expect(validateResult.status).toBe('SUCCESS');
      expect(validateResult.total_links_before).toBe(4); // Only protected links remain
      expect(validateResult.auto_links_remaining).toBe(0);
      expect(validateResult.remaining_ratio).toBe(0);
    });

    it('validateCleanupResult reports PARTIAL (5-10% remaining)', () => {
      // For PARTIAL status, we need remaining auto links to be 5-10% of total links
      // Create 100 total links: 95 protected + 5 auto (to start with only 5% auto)
      const decisions = [];
      for (let i = 1; i <= 100; i++) {
        decisions.push(createDecision(`validate_partial_${i}`));
      }

      // Create 92 protected links (using 'refines')
      for (let i = 0; i < 92; i++) {
        createProtectedLink(decisions[i], decisions[(i + 1) % 100], 'refines');
      }
      // Create 8 auto links using different relationships to avoid duplicates (8/100 = 8% PARTIAL)
      for (let i = 92; i < 100; i++) {
        createAutoLink(decisions[i], decisions[(i + 1) % 100], 'contradicts');
      }

      // Create backup but don't delete any auto links (simulate partial cleanup failure)
      const scanResult = mama.scanAutoLinks();
      mama.createLinkBackup(scanResult.deletion_target_list);

      // Don't delete anything - leave all 8 auto links (8/103 total = 7.8% PARTIAL)
      const validateResult = mama.validateCleanupResult();

      expect(validateResult.status).toBe('PARTIAL');
      expect(validateResult.auto_links_remaining).toBe(8);
      expect(validateResult.remaining_ratio).toBeGreaterThan(5);
      expect(validateResult.remaining_ratio).toBeLessThanOrEqual(10);
    });

    it('validateCleanupResult reports FAILED (>10% remaining)', () => {
      // Create links
      const decisions = [];
      for (let i = 1; i <= 20; i++) {
        decisions.push(createDecision(`validate_failed_${i}`));
      }

      // Create 15 auto links, 5 protected
      for (let i = 0; i < 15; i++) {
        createAutoLink(decisions[i], decisions[(i + 1) % 20], 'refines');
      }
      for (let i = 15; i < 20; i++) {
        createProtectedLink(decisions[i], decisions[(i + 1) % 20], 'refines');
      }

      // Create backup but don't delete anything (simulate complete failure)
      const scanResult = mama.scanAutoLinks();
      mama.createLinkBackup(scanResult.deletion_target_list);

      // Validate (all 15 auto links remain = 100%)
      const validateResult = mama.validateCleanupResult();

      expect(validateResult.status).toBe('FAILED');
      expect(validateResult.auto_links_remaining).toBe(15);
      expect(validateResult.remaining_ratio).toBeGreaterThan(10);
    });

    it('validateCleanupResult includes rollback instructions', () => {
      // Create scenario where cleanup fails (remaining > 10%)
      const decisions = [];
      for (let i = 1; i <= 20; i++) {
        decisions.push(createDecision(`rollback_test_${i}`));
      }

      // Create 15 auto links, 5 protected (75% auto links)
      for (let i = 0; i < 15; i++) {
        createAutoLink(decisions[i], decisions[(i + 1) % 20], 'refines');
      }
      for (let i = 15; i < 20; i++) {
        createProtectedLink(decisions[i], decisions[(i + 1) % 20], 'refines');
      }

      // Create backup but DON'T delete (simulate failure, all 15 auto links remain = 75% FAILED)
      const scanResult = mama.scanAutoLinks();
      // eslint-disable-next-line no-unused-vars
      const backupResult = mama.createLinkBackup(scanResult.deletion_target_list);

      // Validate without deleting (FAILED status will show rollback instructions)
      const validateResult = mama.validateCleanupResult();

      expect(validateResult.status).toBe('FAILED');
      expect(validateResult.markdown).toContain('Rollback Instructions');
      expect(validateResult.markdown).toContain('restore_link_backup');
    });

    it('validate_cleanup_result tool returns markdown report', async () => {
      const d1 = createDecision('tool_validate_1');
      const d2 = createDecision('tool_validate_2');

      createAutoLink(d1, d2, 'refines');

      // Create backup and delete
      const scanResult = mama.scanAutoLinks();
      mama.createLinkBackup(scanResult.deletion_target_list);
      mama.deleteAutoLinks(100, false);

      // Validate via tool
      const result = await validateCleanupResultTool.handler({ format: 'markdown' });

      expect(result.content).toBeTruthy();
      expect(result.content[0].text).toContain('Post-Cleanup Validation');
      expect(result.content[0].text).toContain('SUCCESS');
    });

    it('validate_cleanup_result tool returns JSON report', async () => {
      const d1 = createDecision('tool_json_validate_1');
      const d2 = createDecision('tool_json_validate_2');

      createAutoLink(d1, d2, 'refines');

      // Create backup and delete
      const scanResult = mama.scanAutoLinks();
      mama.createLinkBackup(scanResult.deletion_target_list);
      mama.deleteAutoLinks(100, false);

      // Validate via tool (JSON)
      const result = await validateCleanupResultTool.handler({ format: 'json' });

      expect(result.content).toBeTruthy();
      const jsonData = JSON.parse(result.content[0].text);
      expect(jsonData).toHaveProperty('status');
      expect(jsonData).toHaveProperty('auto_links_remaining');
      expect(jsonData).toHaveProperty('remaining_ratio');
    });
  });

  describe('Story 5.2: AC-5.2.3 - Audit Logging', () => {
    it('deleteAutoLinks records audit log entries', () => {
      const d1 = createDecision('audit_test_1');
      const d2 = createDecision('audit_test_2');
      const d3 = createDecision('audit_test_3');

      createAutoLink(d1, d2, 'refines');
      createAutoLink(d2, d3, 'contradicts');

      // Create backup and delete
      const scanResult = mama.scanAutoLinks();
      mama.createLinkBackup(scanResult.deletion_target_list);
      mama.deleteAutoLinks(100, false);

      // Verify audit log
      const adapter = getAdapter();
      const auditLogs = adapter
        .prepare('SELECT * FROM link_audit_log WHERE action = ? ORDER BY created_at DESC')
        .all('deprecated');

      expect(auditLogs.length).toBe(2);
      expect(auditLogs[0].from_id).toBeTruthy();
      expect(auditLogs[0].to_id).toBeTruthy();
      expect(auditLogs[0].relationship).toBeTruthy();
      expect(auditLogs[0].reason).toContain('Auto-link cleanup');
    });

    it('audit log entries include all metadata', () => {
      const d1 = createDecision('metadata_audit_1');
      const d2 = createDecision('metadata_audit_2');

      createAutoLink(d1, d2, 'refines');

      // Create backup and delete
      const scanResult = mama.scanAutoLinks();
      mama.createLinkBackup(scanResult.deletion_target_list);
      mama.deleteAutoLinks(100, false);

      // Verify audit log metadata
      const adapter = getAdapter();
      const auditLog = adapter
        .prepare('SELECT * FROM link_audit_log WHERE action = ?')
        .get('deprecated');

      expect(auditLog).toHaveProperty('id');
      expect(auditLog).toHaveProperty('action');
      expect(auditLog).toHaveProperty('from_id');
      expect(auditLog).toHaveProperty('to_id');
      expect(auditLog).toHaveProperty('relationship');
      expect(auditLog).toHaveProperty('reason');
      expect(auditLog).toHaveProperty('created_at');
      expect(auditLog.action).toBe('deprecated');
    });
  });

  describe('Story 5.2: Integration - Full Cleanup Workflow', () => {
    it('complete cleanup workflow: scan → backup → delete → validate', async () => {
      // Setup: Create mixed links
      const decisions = [];
      for (let i = 1; i <= 20; i++) {
        decisions.push(createDecision(`full_workflow_${i}`));
      }

      // 15 auto links, 5 protected
      for (let i = 0; i < 15; i++) {
        createAutoLink(decisions[i], decisions[(i + 1) % 20], 'refines');
      }
      for (let i = 15; i < 20; i++) {
        createProtectedLink(decisions[i], decisions[(i + 1) % 20], 'refines');
      }

      // Step 1: Scan
      const scanResult = await scanAutoLinksTool.handler({ include_samples: true });
      expect(scanResult.content[0].text).toContain('Deletion Targets: 15');

      // Step 2: Backup
      const backupResult = await createLinkBackupTool.handler({ include_protected: false });
      expect(backupResult.content[0].text).toContain('Links Backed Up:** 15');

      // Step 3: Execute cleanup (dry-run first)
      const dryRunResult = await executeLinkCleanupTool.handler({ batch_size: 10, dry_run: true });
      expect(dryRunResult.content[0].text).toContain('DRY RUN MODE');
      expect(dryRunResult.content[0].text).toContain('**Would Delete:** 15');

      // Step 4: Execute cleanup (actual)
      const executeResult = await executeLinkCleanupTool.handler({
        batch_size: 10,
        dry_run: false,
      });
      expect(executeResult.content[0].text).toContain('Deleted: 15');
      expect(executeResult.content[0].text).toContain('Success Rate: 100%');

      // Step 5: Validate
      const validateResult = await validateCleanupResultTool.handler({ format: 'markdown' });
      expect(validateResult.content[0].text).toContain('SUCCESS');
      expect(validateResult.content[0].text).toContain('**Remaining Auto Links:** 0');

      // Verify final state
      const adapter = getAdapter();
      const finalLinks = adapter.prepare('SELECT COUNT(*) as count FROM decision_edges').get();
      expect(finalLinks.count).toBe(5); // Only protected links remain

      const auditLogs = adapter.prepare('SELECT COUNT(*) as count FROM link_audit_log').get();
      expect(auditLogs.count).toBe(15); // All deletions logged
    });
  });
});
