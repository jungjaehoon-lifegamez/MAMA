/**
 * TG-05/TG-06 structural wiring tests (design Decision 1).
 *
 * A later report path must not bypass the coordinator: the operator layer may
 * not call Telegram directly, and production assembly must wire the
 * ReportDeliveryPort - never the legacy OutputSink report path.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const SRC = join(__dirname, '../../src');

function operatorSources(): Array<{ name: string; text: string }> {
  return readdirSync(join(SRC, 'operator'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ name, text: readFileSync(join(SRC, 'operator', name), 'utf8') }));
}

describe('owner-report delivery wiring (structural)', () => {
  it('keeps the operator layer free of direct Telegram sends except the V2 compat module', () => {
    const offenders = operatorSources()
      .filter(({ name }) => name !== 'report-carry-delivery.ts')
      .filter(({ text }) => text.includes('.sendSystemMessage(') || text.includes('sendMessage('))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it('wires the trigger loop to the coordinator port, not the legacy output sink', () => {
    const start = readFileSync(join(SRC, 'cli/commands/start.ts'), 'utf8');
    expect(start).toContain('reportDelivery,');
    expect(start).toContain('reportTarget,');
    expect(start).not.toContain('output: reportOutput');
    expect(start).not.toContain('persistLastFullReport:');
    expect(start).not.toContain('createTelegramReportOutput');
    expect(start).not.toContain('createTelegramReportCarryDelivery');
  });

  it('constructs exactly one report context store on the shared messenger connection', () => {
    const start = readFileSync(join(SRC, 'cli/commands/start.ts'), 'utf8');
    const constructions = start.match(/new TelegramReportContextStore\(/g) ?? [];
    expect(constructions).toHaveLength(1);
    expect(start).toContain('new TelegramReportContextStore(db,');
  });

  it('reconciles ledger pins from SQLite truth during startup assembly', () => {
    const start = readFileSync(join(SRC, 'cli/commands/start.ts'), 'utf8');
    expect(start).toContain('listPinReconciliation()');
    expect(start).toContain('reconcilePins(');
  });

  it('does not wire the V2 carry reader in production (Decision 8: no component reads V2 after migration)', () => {
    const start = readFileSync(join(SRC, 'cli/commands/start.ts'), 'utf8');
    expect(start).not.toContain('reportCarry: new FileReportCarryStore()');
  });

  it('exposes the operator recovery surface for definite rejections (review finding #2)', () => {
    const routes = readFileSync(join(SRC, 'cli/runtime/api-routes-init.ts'), 'utf8');
    expect(routes).toContain('/api/operator/report-delivery/reactivate');
    expect(routes).toContain('/api/operator/report-delivery/cancel');
    const start = readFileSync(join(SRC, 'cli/commands/start.ts'), 'utf8');
    expect(start).toMatch(/registerApiRoutes\(\{[\s\S]*?reportContextStore,/);
  });

  it('routes every loop-side delivery through the single deliverPendingReport executor', () => {
    const loop = readFileSync(join(SRC, 'operator/operator-trigger-loop.ts'), 'utf8');
    const portCalls =
      loop.match(/reportDelivery\b[\s\S]{0,40}?deliverPrepared\(|port\.deliverPrepared\(/g) ?? [];
    expect(portCalls).toHaveLength(1);
  });
});
