/**
 * Story SEC-3: hourly audit is deterministic code, not an LLM loop
 *
 * Lands owner decision 2026-04-22 (mama_conductor_audit_code_based_read_only).
 * The audit collects facts read-only and preserves the 24h MAJOR-alert dedup
 * contract from the 2026-07-11 owner verdict.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runCodeAudit, type AuditFinding } from '../../src/observability/code-audit.js';

function makeMamaDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mama-audit-'));
  mkdirSync(join(dir, 'state'), { recursive: true });
  mkdirSync(join(dir, 'logs'), { recursive: true });
  writeFileSync(join(dir, 'config.yaml'), 'version: 1\n');
  writeFileSync(join(dir, 'config.json'), '{"ok": true}\n');
  return dir;
}

const NOW = new Date('2026-07-17T10:00:00.000Z');

describe('Story SEC-3: deterministic code audit', () => {
  let mamaDir: string;

  beforeEach(() => {
    mamaDir = makeMamaDir();
  });

  const run = (overrides: Partial<Parameters<typeof runCodeAudit>[0]> = {}, at: Date = NOW) =>
    runCodeAudit({
      mamaDir,
      healthUrl: '',
      now: () => at,
      ...overrides,
    });

  describe('AC #1: broken config produces a MAJOR finding and a new-alert', () => {
    it('flags invalid yaml and alerts with reason "new"', async () => {
      writeFileSync(join(mamaDir, 'config.yaml'), 'a: [unclosed\n  b: ::: {{\n');
      const alerts: Array<[AuditFinding, string]> = [];
      const report = await run({ alert: (f, r) => void alerts.push([f, r]) });

      const finding = report.findings.find((f) => f.id === 'config-parse-config.yaml');
      expect(finding?.severity).toBe('MAJOR');
      expect(alerts).toHaveLength(1);
      expect(alerts[0][1]).toBe('new');
      expect(report.alerted).toContain('config-parse-config.yaml');
    });
  });

  describe('AC #2: same MAJOR finding within 24h is not re-alerted', () => {
    it('suppresses the second alert', async () => {
      writeFileSync(join(mamaDir, 'config.json'), '{broken');
      const alerts: string[] = [];
      await run({ alert: (f) => void alerts.push(f.id) });
      await run({ alert: (f) => void alerts.push(f.id) }, new Date(NOW.getTime() + 60 * 60 * 1000));
      expect(alerts).toEqual(['config-parse-config.json']);
    });
  });

  describe('AC #3: MAJOR finding older than 24h is re-alerted', () => {
    it('re-alerts with reason "re-alert"', async () => {
      writeFileSync(join(mamaDir, 'config.json'), '{broken');
      const alerts: Array<[string, string]> = [];
      await run({ alert: (f, r) => void alerts.push([f.id, r]) });
      await run(
        { alert: (f, r) => void alerts.push([f.id, r]) },
        new Date(NOW.getTime() + 25 * 60 * 60 * 1000)
      );
      expect(alerts).toEqual([
        ['config-parse-config.json', 'new'],
        ['config-parse-config.json', 're-alert'],
      ]);
    });
  });

  describe('AC #4: MINOR findings are recorded but never alerted', () => {
    it('flags an oversized WAL without alerting', async () => {
      writeFileSync(join(mamaDir, 'mama-metrics.db-wal'), 'x'.repeat(6 * 1024 * 1024));
      const alert = vi.fn();
      const report = await run({ alert });

      const finding = report.findings.find((f) => f.id === 'metrics-db-wal');
      expect(finding?.severity).toBe('MINOR');
      expect(alert).not.toHaveBeenCalled();
    });
  });

  describe('AC #5: healthy environment yields zero findings and a state file', () => {
    it('writes pass_items and empty findings', async () => {
      const report = await run();
      expect(report.findings).toEqual([]);
      expect(report.pass_items.length).toBeGreaterThan(0);

      const state = JSON.parse(
        await readFile(join(mamaDir, 'state', 'audit-findings.json'), 'utf8')
      );
      expect(state.checklist_version).toContain('code');
      expect(state.findings).toEqual([]);
      expect(state.pass_items.length).toBeGreaterThan(0);
    });
  });

  describe('AC #6: resolved findings move to resolved_since_last_run', () => {
    it('reports the id after the cause is fixed', async () => {
      writeFileSync(join(mamaDir, 'config.json'), '{broken');
      await run({ alert: () => {} });
      writeFileSync(join(mamaDir, 'config.json'), '{"ok": true}\n');
      const report = await run({}, new Date(NOW.getTime() + 60 * 60 * 1000));
      expect(report.resolved_since_last_run).toContain('config-parse-config.json');
    });
  });

  describe('AC #7: open telegram inbound is a MAJOR finding', () => {
    it('flags telegram enabled without allowed_chats', async () => {
      const report = await run({
        config: { telegram: { enabled: true } },
        alert: () => {},
      });
      const finding = report.findings.find((f) => f.id === 'telegram-open-inbound');
      expect(finding?.severity).toBe('MAJOR');
    });

    it('passes when allowed_chats is set', async () => {
      const report = await run({
        config: { telegram: { enabled: true, allowed_chats: ['1'] } },
      });
      expect(report.findings.find((f) => f.id === 'telegram-open-inbound')).toBeUndefined();
      expect(report.pass_items.join('\n')).toContain('telegram inbound allowlist');
    });
  });

  describe('AC #8: alert delivery failure is loud and retried next run', () => {
    it('records the failure and re-alerts on the next run', async () => {
      writeFileSync(join(mamaDir, 'config.json'), '{broken');
      const failing = vi.fn().mockRejectedValue(new Error('gateway down'));
      const first = await run({ alert: failing });
      expect(first.alerted).toEqual([]);
      expect(first.alert_delivery_failures.join('\n')).toContain('gateway down');

      const succeeding = vi.fn();
      const second = await run({ alert: succeeding }, new Date(NOW.getTime() + 60 * 60 * 1000));
      expect(second.alerted).toContain('config-parse-config.json');
    });
  });

  describe('AC #9: missing persona files are INFO when multi-agent is disabled, MINOR when enabled', () => {
    it('grades by multi_agent.enabled', async () => {
      const config = {
        multi_agent: {
          enabled: false,
          agents: { conductor: { persona_file: join(mamaDir, 'nope.md') } },
        },
      };
      const infoReport = await run({ config });
      expect(infoReport.findings.find((f) => f.id === 'persona-missing-conductor')?.severity).toBe(
        'INFO'
      );

      const minorReport = await run({
        config: { multi_agent: { ...config.multi_agent, enabled: true } },
      });
      expect(minorReport.findings.find((f) => f.id === 'persona-missing-conductor')?.severity).toBe(
        'MINOR'
      );
    });
  });
});
