import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createSecurityMiddleware,
  formatSecurityAlert,
  flushSecurityMonitor,
  getCloudflareCustomListCsvPath,
  getCloudflareWafExpressionPath,
  getDenylistJsonPath,
  getDenylistTxtPath,
  getTarpitDelayMs,
  getSecurityLogPath,
  recordSecurityEvent,
  resetSecurityMonitorForTests,
  setSecurityAlertSender,
} from '../../src/security/security-monitor.js';

describe('security-monitor', () => {
  const originalHome = process.env.HOME;
  const originalDelay = process.env.MAMA_HONEYPOT_DELAY_MS;
  let testHome: string;

  beforeEach(async () => {
    testHome = await mkdtemp(join(tmpdir(), 'mama-security-monitor-'));
    process.env.HOME = testHome;
    process.env.MAMA_HONEYPOT_DELAY_MS = '1';
    resetSecurityMonitorForTests();
    setSecurityAlertSender(null);
  });

  afterEach(async () => {
    await flushSecurityMonitor();
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    if (originalDelay === undefined) {
      delete process.env.MAMA_HONEYPOT_DELAY_MS;
    } else {
      process.env.MAMA_HONEYPOT_DELAY_MS = originalDelay;
    }

    resetSecurityMonitorForTests();
    await rm(testHome, { recursive: true, force: true });
  });

  async function waitForFile(filePath: string): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 5_000) {
      try {
        await access(filePath);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new Error(`Timed out waiting for file: ${filePath}`);
  }

  it('returns 404 for remote honeypot paths', async () => {
    const app = express();
    app.use(createSecurityMiddleware());
    app.get('/.env', (_req, res) => {
      res.status(200).send('should not reach');
    });

    const res = await request(app)
      .get('/.env')
      .set('x-forwarded-for', '198.51.100.22')
      .set('host', 'mama.local');

    expect(res.status).toBe(404);
    expect(res.text).toBe('Not Found');
  });

  it('applies tarpit delay score to suspicious clients', () => {
    recordSecurityEvent({
      type: 'unauthorized_request',
      severity: 'warn',
      message: 'Unauthorized request blocked',
      clientAddress: '198.51.100.23',
    });
    recordSecurityEvent({
      type: 'unauthorized_request',
      severity: 'warn',
      message: 'Unauthorized request blocked',
      clientAddress: '198.51.100.23',
    });

    expect(getTarpitDelayMs('198.51.100.23')).toBeGreaterThan(0);
  });

  it('preserves evidence bundle and abuse report draft', async () => {
    const event = {
      type: 'honeypot_hit',
      severity: 'critical' as const,
      message: 'Honeypot path accessed',
      clientAddress: '198.51.100.24',
      path: '/.env',
      method: 'GET',
      details: { delayMs: 1 },
    };

    recordSecurityEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const securityLog = await readFile(getSecurityLogPath(), 'utf8');
    expect(securityLog).toContain('"honeypot_hit"');

    const alert = formatSecurityAlert(event);
    const evidencePath = alert
      .split('\n')
      .find((line) => line.startsWith('evidence: '))
      ?.replace('evidence: ', '');
    const abuseReportPath = alert
      .split('\n')
      .find((line) => line.startsWith('abuse_draft: '))
      ?.replace('abuse_draft: ', '');

    expect(evidencePath).toBeTruthy();
    expect(abuseReportPath).toBeTruthy();

    await waitForFile(evidencePath!);
    await waitForFile(abuseReportPath!);
    await waitForFile(getDenylistJsonPath());
    await waitForFile(getDenylistTxtPath());
    await waitForFile(getCloudflareCustomListCsvPath());
    await waitForFile(getCloudflareWafExpressionPath());

    const evidence = await readFile(evidencePath!, 'utf8');
    const abuseDraft = await readFile(abuseReportPath!, 'utf8');
    const denylistJson = await readFile(getDenylistJsonPath(), 'utf8');
    const denylistTxt = await readFile(getDenylistTxtPath(), 'utf8');
    const cloudflareCsv = await readFile(getCloudflareCustomListCsvPath(), 'utf8');
    const cloudflareExpr = await readFile(getCloudflareWafExpressionPath(), 'utf8');

    expect(evidence).toContain('"clientAddress": "198.51.100.24"');
    expect(abuseDraft).toContain('Abuse Report Draft');
    expect(abuseDraft).toContain('198.51.100.24');
    expect(abuseDraft).toContain('Review denylist candidates');
    expect(abuseDraft).toContain('Cloudflare custom list CSV');
    expect(denylistJson).toContain('"ip": "198.51.100.24"');
    expect(denylistTxt).toContain('198.51.100.24');
    expect(cloudflareCsv).toContain('198.51.100.24,critical:Honeypot path accessed (honeypot_hit)');
    expect(cloudflareExpr).toContain('ip.src in $mama_security_blocklist');
  });
});
