/**
 * Story SEC-2: security telemetry must be redirectable away from live logs
 *
 * Fixture events (sessionId=test-session, TEST-NET IPs) once outnumbered real
 * signal ~30:1 in the live ~/.mama/logs/security-events.jsonl because tests
 * wrote through the production path. MAMA_SECURITY_LOG_DIR is the single
 * choke point that redirects events, incidents, and denylist artifacts.
 */

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { statSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushSecurityMonitor, recordSecurityEvent } from '../../src/security/security-monitor.js';

describe('Story SEC-2: security log dir redirection', () => {
  let originalDir: string | undefined;
  let testDir: string;

  beforeEach(() => {
    originalDir = process.env.MAMA_SECURITY_LOG_DIR;
    testDir = mkdtempSync(join(tmpdir(), 'mama-sec-redirect-'));
    process.env.MAMA_SECURITY_LOG_DIR = testDir;
  });

  afterEach(() => {
    if (originalDir === undefined) {
      delete process.env.MAMA_SECURITY_LOG_DIR;
    } else {
      process.env.MAMA_SECURITY_LOG_DIR = originalDir;
    }
  });

  describe('AC #1: events land in MAMA_SECURITY_LOG_DIR, not the live log', () => {
    it('writes security-events.jsonl inside the override dir', async () => {
      const livePath = join(homedir(), '.mama', 'logs', 'security-events.jsonl');
      const liveSizeBefore = existsSync(livePath) ? statSync(livePath).size : -1;

      recordSecurityEvent({
        type: 'dangerous_bash_blocked',
        severity: 'critical',
        message: 'redirect proof event',
        details: { sessionId: 'test-session', commandPreview: 'rm -rf /tmp/x' },
      });
      await flushSecurityMonitor();

      const redirected = join(testDir, 'security-events.jsonl');
      expect(existsSync(redirected)).toBe(true);
      expect(readFileSync(redirected, 'utf8')).toContain('redirect proof event');

      const liveSizeAfter = existsSync(livePath) ? statSync(livePath).size : -1;
      expect(liveSizeAfter).toBe(liveSizeBefore);
    });
  });

  describe('AC #2: incident evidence lands in the override dir', () => {
    it('creates security-incidents under the override dir', async () => {
      recordSecurityEvent({
        type: 'unauthorized_request',
        severity: 'warn',
        message: 'redirect proof incident',
        clientAddress: '198.51.100.99',
        path: '/redirect-proof',
      });
      await flushSecurityMonitor();

      expect(existsSync(join(testDir, 'security-incidents'))).toBe(true);
    });
  });

  describe('AC #3: the test suite always runs with the redirect active', () => {
    it('tests/setup.ts pinned MAMA_SECURITY_LOG_DIR before this file ran', () => {
      // originalDir captured in beforeEach is what setup.ts assigned globally.
      expect(originalDir).toBeTruthy();
      expect(originalDir).not.toContain(join('.mama', 'logs'));
    });
  });
});
