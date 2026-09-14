/**
 * Tests for Story M3.4: Installation & Tier Detection
 *
 * AC1: engines.node >=22 check with descriptive errors
 * AC2: Attempt to load node:sqlite and the embedding stack
 * AC3: Readiness report
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
    it('should have engines.node set to >=22', () => {
      const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));

      expect(pkg.engines).toBeDefined();
      expect(pkg.engines.node).toBeDefined();
      expect(pkg.engines.node).toMatch(/>=22/);
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

  describe('AC2: SQLite and embedding stack checks', () => {
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

      if (result.available) {
        expect(result.driver).toBe('node:sqlite');
      } else {
        // A failed check has to carry what it breaks and how to fix it, because
        // the report is the only thing standing between a broken install and a
        // user who thinks it worked.
        expect(result.reason).toBeDefined();
        expect(result.breaks).toBeDefined();
        expect(result.fix).toBeDefined();
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

  describe('AC3: readiness reporting', () => {
    it('should export assessReadiness function', () => {
      const postinstall = require(POSTINSTALL_SCRIPT);
      expect(postinstall.assessReadiness).toBeDefined();
      expect(typeof postinstall.assessReadiness).toBe('function');
    });

    it('reports ready when both requirements are present', () => {
      const postinstall = require(POSTINSTALL_SCRIPT);

      const readiness = postinstall.assessReadiness({ available: true }, { available: true });

      expect(readiness.ready).toBe(true);
      expect(readiness.missing).toEqual([]);
    });

    // There is no degraded mode. Without node:sqlite the database cannot open;
    // without the embedding stack every save and search throws. An install
    // missing either one is not usable, and the report has to say so.
    it('reports not ready, and why, when SQLite is unavailable', () => {
      const postinstall = require(POSTINSTALL_SCRIPT);

      const sqliteCheck = {
        available: false,
        reason: 'node:sqlite unavailable (boom)',
        breaks: 'the database cannot be opened; no memory is saved or read',
        fix: 'use Node 22.13 or newer, which ships node:sqlite',
      };

      const readiness = postinstall.assessReadiness(sqliteCheck, { available: true });

      expect(readiness.ready).toBe(false);
      expect(readiness.missing).toHaveLength(1);
      expect(readiness.missing[0].reason).toContain('node:sqlite');
      expect(readiness.missing[0].breaks).toBeTruthy();
      expect(readiness.missing[0].fix).toBeTruthy();
    });

    it('reports not ready, and why, when the embedding stack is unavailable', () => {
      const postinstall = require(POSTINSTALL_SCRIPT);

      const embeddingsCheck = {
        available: false,
        reason: 'embedding stack unavailable via mama-core (boom)',
        breaks: 'every save and search throws; there is no exact-match fallback',
        fix: 'reinstall so @huggingface/transformers resolves from @jungjaehoon/mama-core',
      };

      const readiness = postinstall.assessReadiness({ available: true }, embeddingsCheck);

      expect(readiness.ready).toBe(false);
      expect(readiness.missing[0].breaks).toContain('throws');
    });

    it('lists both requirements when both are missing', () => {
      const postinstall = require(POSTINSTALL_SCRIPT);

      const readiness = postinstall.assessReadiness(
        { available: false, reason: 'a', breaks: 'b', fix: 'c' },
        { available: false, reason: 'd', breaks: 'e', fix: 'f' }
      );

      expect(readiness.ready).toBe(false);
      expect(readiness.missing).toHaveLength(2);
    });

    it('never advertises a degraded mode or an accuracy number', () => {
      const script = fs.readFileSync(POSTINSTALL_SCRIPT, 'utf8');

      expect(script).not.toMatch(/40%/);
      expect(script).not.toMatch(/fully functional/i);
      expect(script).not.toMatch(/Tier 2/);
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

      // Should say plainly whether this install can run
      expect(output).toMatch(/MAMA Plugin Installed( But Not Usable)?/);

      // Should not contain critical errors
      expect(output).not.toContain('Installation failed');
    });

    it('describes what search does rather than a quality level', () => {
      const output = execSync(`node ${POSTINSTALL_SCRIPT}`, {
        encoding: 'utf8',
        stdio: 'pipe',
        cwd: PLUGIN_ROOT,
      });

      // Which report prints depends on the machine running the suite. Either way it
      // must describe what is there or what is missing, never a quality level.
      if (output.includes('But Not Usable')) {
        expect(output).toContain('Missing:');
        expect(output).toMatch(/breaks:/);
        expect(output).toMatch(/fix:/);
      } else {
        expect(output).toContain('Vector search');
      }
      expect(output).not.toMatch(/Accuracy:/);
      expect(output).not.toMatch(/Tier: [12]/);
    });

    it('tells the reader what to do next, and never to try it when it cannot run', () => {
      const output = execSync(`node ${POSTINSTALL_SCRIPT}`, {
        encoding: 'utf8',
        stdio: 'pipe',
        cwd: PLUGIN_ROOT,
      });

      if (output.includes('But Not Usable')) {
        // Pointing someone at /mama-list when the install cannot open its database
        // is the same false reassurance this change removed.
        expect(output).toMatch(/Fix the above/);
        expect(output).not.toMatch(/mama-list|mama-save/);
      } else {
        expect(output).toContain('Next steps');
        expect(output).toMatch(/mama-list|mama-save/);
      }
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
      expect(scriptContent).toContain('process.version');
      expect(scriptContent).toContain('process.env');
    });

    it('should have informative error messages', () => {
      const scriptContent = fs.readFileSync(POSTINSTALL_SCRIPT, 'utf8');

      // Should have Fix options
      expect(scriptContent).toContain('Fix options');
      expect(scriptContent).toContain('To fix');

      // Should have remediation steps
      expect(scriptContent).toContain('nvm install');
      expect(scriptContent).toContain('node:sqlite');
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
