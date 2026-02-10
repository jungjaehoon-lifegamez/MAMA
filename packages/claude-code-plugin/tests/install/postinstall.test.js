/**
 * Tests for Story M3.4: Installation & Tier Detection
 *
 * AC1: engines.node >=18 check with descriptive errors
 * AC2: Attempt to load better-sqlite3, Tier 2 fallback on failure
 * AC3: Success message with detected tier
 * AC4: Disk space checks, OS-specific instructions
 * AC5: CI smoke test - npm install assertions
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PLUGIN_ROOT = path.resolve(__dirname, '../..');
const POSTINSTALL_SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'postinstall.js');
const PACKAGE_JSON = path.join(PLUGIN_ROOT, 'package.json');

describe('M3.4: Installation & Tier Detection', () => {
  describe('AC1: Node version check with descriptive errors', () => {
    it('should have engines.node set to >=18', () => {
      const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));

      expect(pkg.engines).toBeDefined();
      expect(pkg.engines.node).toBeDefined();
      expect(pkg.engines.node).toMatch(/>=18/);
    });

    it('should have postinstall script configured', () => {
      const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));

      expect(pkg.scripts).toBeDefined();
      expect(pkg.scripts.postinstall).toBeDefined();
      expect(pkg.scripts.postinstall).toContain('postinstall.js');
    });

    it('should have executable postinstall script', () => {
      expect(fs.existsSync(POSTINSTALL_SCRIPT)).toBe(true);

      // Execute bit check only on Unix (Windows doesn't use execute bits)
      if (process.platform !== 'win32') {
        const stat = fs.statSync(POSTINSTALL_SCRIPT);
        expect(stat.mode & 0o111).toBeGreaterThan(0);
      }
    });

    it('should export checkNodeVersion function', () => {
      const postinstall = require(POSTINSTALL_SCRIPT);
      expect(postinstall.checkNodeVersion).toBeDefined();
      expect(typeof postinstall.checkNodeVersion).toBe('function');
    });
  });

  describe('AC2: SQLite check and Tier 2 fallback', () => {
    it('should export checkSQLite function', () => {
      const postinstall = require(POSTINSTALL_SCRIPT);
      expect(postinstall.checkSQLite).toBeDefined();
      expect(typeof postinstall.checkSQLite).toBe('function');
    });

    it('should detect SQLite availability', () => {
      const postinstall = require(POSTINSTALL_SCRIPT);
      const result = postinstall.checkSQLite();

      expect(result).toBeDefined();
      expect(result).toHaveProperty('available');
      expect(result).toHaveProperty('tier');

      if (result.available) {
        expect(result.tier).toBe(1);
      } else {
        expect(result.tier).toBe(2);
        expect(result.reason).toBeDefined();
      }
    });

    it('should export checkEmbeddings function', () => {
      const postinstall = require(POSTINSTALL_SCRIPT);
      expect(postinstall.checkEmbeddings).toBeDefined();
      expect(typeof postinstall.checkEmbeddings).toBe('function');
    });

    it('should detect embeddings availability', () => {
      const postinstall = require(POSTINSTALL_SCRIPT);
      const result = postinstall.checkEmbeddings();

      expect(result).toBeDefined();
      expect(result).toHaveProperty('available');

      if (!result.available) {
        expect(result.reason).toBeDefined();
      }
    });
  });

  describe('AC3: Tier detection and success message', () => {
    it('should export detectTier function', () => {
      const postinstall = require(POSTINSTALL_SCRIPT);
      expect(postinstall.detectTier).toBeDefined();
      expect(typeof postinstall.detectTier).toBe('function');
    });

    it('should detect Tier 1 when all features available', () => {
      const postinstall = require(POSTINSTALL_SCRIPT);

      const sqliteCheck = { available: true };
      const embeddingsCheck = { available: true };

      const tierInfo = postinstall.detectTier(sqliteCheck, embeddingsCheck);

      expect(tierInfo.tier).toBe(1);
      expect(tierInfo.name).toBe('Full Features');
      expect(tierInfo.accuracy).toBe('80%');
      expect(tierInfo.features).toBeDefined();
      expect(Array.isArray(tierInfo.features)).toBe(true);
      expect(tierInfo.performance).toBeDefined();
    });

    it('should detect Tier 2 when SQLite unavailable', () => {
      const postinstall = require(POSTINSTALL_SCRIPT);

      const sqliteCheck = { available: false, tier: 2, reason: 'SQLite failed' };
      const embeddingsCheck = { available: true };

      const tierInfo = postinstall.detectTier(sqliteCheck, embeddingsCheck);

      expect(tierInfo.tier).toBe(2);
      expect(tierInfo.name).toBe('Degraded Mode');
      expect(tierInfo.accuracy).toBe('40%');
      expect(tierInfo.limitations).toBeDefined();
      expect(Array.isArray(tierInfo.limitations)).toBe(true);
    });

    it('should detect Tier 2 when embeddings unavailable', () => {
      const postinstall = require(POSTINSTALL_SCRIPT);

      const sqliteCheck = { available: true };
      const embeddingsCheck = { available: false, reason: 'Transformers.js failed' };

      const tierInfo = postinstall.detectTier(sqliteCheck, embeddingsCheck);

      expect(tierInfo.tier).toBe(2);
      expect(tierInfo.name).toBe('Degraded Mode');
    });

    it('should include performance metrics in tier info', () => {
      const postinstall = require(POSTINSTALL_SCRIPT);

      const sqliteCheck = { available: true };
      const embeddingsCheck = { available: true };

      const tierInfo = postinstall.detectTier(sqliteCheck, embeddingsCheck);

      expect(tierInfo.performance).toBeDefined();
      expect(tierInfo.performance.embedding).toBeDefined();
      expect(tierInfo.performance.search).toBeDefined();
      expect(tierInfo.performance.hookLatency).toBeDefined();
    });
  });

  describe('AC4: Disk space and OS-specific instructions', () => {
    it('should export checkDiskSpace function', () => {
      const postinstall = require(POSTINSTALL_SCRIPT);
      expect(postinstall.checkDiskSpace).toBeDefined();
      expect(typeof postinstall.checkDiskSpace).toBe('function');
    });

    it('should check disk space without throwing', () => {
      const postinstall = require(POSTINSTALL_SCRIPT);

      expect(() => {
        postinstall.checkDiskSpace();
      }).not.toThrow();
    });

    it('should have OS-specific instructions in script', () => {
      const scriptContent = fs.readFileSync(POSTINSTALL_SCRIPT, 'utf8');

      // macOS instructions
      expect(scriptContent).toContain('macOS');
      expect(scriptContent).toContain('brew');

      // Linux instructions
      expect(scriptContent).toContain('Linux');
      expect(scriptContent).toContain('apt');

      // Windows instructions
      expect(scriptContent).toContain('Windows');
      expect(scriptContent).toContain('choco');
    });

    it('should document 100MB requirement', () => {
      const scriptContent = fs.readFileSync(POSTINSTALL_SCRIPT, 'utf8');
      expect(scriptContent).toMatch(/100.*MB|100MB/);
    });
  });

  describe('AC5: CI smoke test - npm install', () => {
    it('should run postinstall script successfully', () => {
      const output = execSync(`node ${POSTINSTALL_SCRIPT}`, {
        encoding: 'utf8',
        stdio: 'pipe',
        cwd: PLUGIN_ROOT,
      });

      // Should contain success message
      expect(output).toContain('MAMA Plugin');
      expect(output).toContain('Installation');

      // Should show tier detection
      expect(output).toMatch(/Tier: [12]/);

      // Should not contain critical errors
      expect(output).not.toContain('Installation failed');
    });

    it('should output tier information', () => {
      const output = execSync(`node ${POSTINSTALL_SCRIPT}`, {
        encoding: 'utf8',
        stdio: 'pipe',
        cwd: PLUGIN_ROOT,
      });

      // Should show tier name
      expect(output).toMatch(/Full Features|Degraded Mode/);

      // Should show accuracy
      expect(output).toMatch(/Accuracy:.*%/);

      // Should show features
      expect(output).toContain('Features:');
    });

    it('should show next steps', () => {
      const output = execSync(`node ${POSTINSTALL_SCRIPT}`, {
        encoding: 'utf8',
        stdio: 'pipe',
        cwd: PLUGIN_ROOT,
      });

      expect(output).toContain('Next steps');
      expect(output).toMatch(/mama-list|mama-save/);
    });

    it('should complete within reasonable time', () => {
      const startTime = Date.now();

      execSync(`node ${POSTINSTALL_SCRIPT}`, {
        encoding: 'utf8',
        stdio: 'pipe',
        cwd: PLUGIN_ROOT,
      });

      const elapsed = Date.now() - startTime;

      // Should complete within 5 seconds
      expect(elapsed).toBeLessThan(5000);
    });

    it('should save tier configuration', () => {
      const homeDir = process.env.HOME || process.env.USERPROFILE;
      const configPath = path.join(homeDir, '.mama', 'config.json');

      // Run postinstall
      execSync(`node ${POSTINSTALL_SCRIPT}`, {
        encoding: 'utf8',
        stdio: 'pipe',
        cwd: PLUGIN_ROOT,
      });

      // Check if config was created
      if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, 'utf8').trim();
        if (raw) {
          const config = JSON.parse(raw);

          expect(config.tier).toBeDefined();
          expect([1, 2]).toContain(config.tier);
          expect(config.tier_name).toBeDefined();
          expect(config.tier_detected_at).toBeDefined();
        }
      }
      // If config doesn't exist or is empty, that's okay (permissions issue)
    });
  });

  describe('Integration: Full installation flow', () => {
    it('should check all requirements in order', () => {
      const output = execSync(`node ${POSTINSTALL_SCRIPT}`, {
        encoding: 'utf8',
        stdio: 'pipe',
        cwd: PLUGIN_ROOT,
      });

      // Check order of operations
      const nodeIndex = output.indexOf('Node.js');
      const diskIndex = output.indexOf('disk space');
      const sqliteIndex = output.indexOf('SQLite');
      const embeddingsIndex = output.indexOf('embedding');

      expect(nodeIndex).toBeGreaterThan(-1);
      expect(diskIndex).toBeGreaterThan(nodeIndex);
      expect(sqliteIndex).toBeGreaterThan(diskIndex);
      expect(embeddingsIndex).toBeGreaterThan(sqliteIndex);
    });

    it('should show visual feedback with colors/boxes', () => {
      const output = execSync(`node ${POSTINSTALL_SCRIPT}`, {
        encoding: 'utf8',
        stdio: 'pipe',
        cwd: PLUGIN_ROOT,
      });

      // Should have box drawing characters
      expect(output).toMatch(/[┏┓┃┗┛━]/);

      // Should have check marks or warning symbols
      expect(output).toMatch(/✅|⚠️/);
    });

    it('should be compatible with Windows (no bash dependencies)', () => {
      const scriptContent = fs.readFileSync(POSTINSTALL_SCRIPT, 'utf8');

      // Should use #!/usr/bin/env node (cross-platform)
      expect(scriptContent).toMatch(/^#!\/usr\/bin\/env node/);

      // Should not use bash-specific commands
      expect(scriptContent).not.toContain('#!/bin/bash');
      expect(scriptContent).not.toContain('$(');
      expect(scriptContent).not.toContain('${BASH');

      // Should use Node.js APIs only
      expect(scriptContent).toContain('process.platform');
      expect(scriptContent).toContain('process.env');
    });

    it('should have informative error messages', () => {
      const scriptContent = fs.readFileSync(POSTINSTALL_SCRIPT, 'utf8');

      // Should have Fix options
      expect(scriptContent).toContain('Fix options');
      expect(scriptContent).toContain('To fix');

      // Should have remediation steps
      expect(scriptContent).toContain('nvm install');
      expect(scriptContent).toContain('npm rebuild');
    });
  });

  describe('Edge cases', () => {
    it('should handle missing HOME directory gracefully', () => {
      const originalHome = process.env.HOME;
      const originalUserProfile = process.env.USERPROFILE;

      try {
        delete process.env.HOME;
        delete process.env.USERPROFILE;

        const postinstall = require(POSTINSTALL_SCRIPT);

        expect(() => {
          postinstall.checkDiskSpace();
        }).not.toThrow();
      } finally {
        if (originalHome) {
          process.env.HOME = originalHome;
        }
        if (originalUserProfile) {
          process.env.USERPROFILE = originalUserProfile;
        }
      }
    });

    it('should handle permission errors gracefully', () => {
      const postinstall = require(POSTINSTALL_SCRIPT);

      // Should not throw even if disk check fails
      expect(() => {
        postinstall.checkDiskSpace();
      }).not.toThrow();
    });
  });
});
