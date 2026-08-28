import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Command } from 'commander';

import { getMAMAHome } from '../config/config-manager.js';
import { API_PORT } from '../runtime/utilities.js';
import { isDaemonRunning } from '../utils/pid-manager.js';

type WriteLine = (line: string) => void;

export interface ReportNowOptions {
  mamaHome?: string;
  daemonRunning?: () => Promise<unknown>;
  fetchImpl?: typeof fetch;
  writeOut?: WriteLine;
  maxWaitMs?: number;
  pollIntervalMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readConfirmedAt(markerPath: string): string | null {
  if (!existsSync(markerPath)) {
    return null;
  }
  try {
    const value = JSON.parse(readFileSync(markerPath, 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || typeof (value as { at?: unknown }).at !== 'string') {
      throw new Error('expected a non-empty string "at"');
    }
    const at = (value as { at: string }).at;
    if (!at) {
      throw new Error('expected a non-empty string "at"');
    }
    return at;
  } catch (error) {
    throw new Error(
      `Invalid first-report marker ${markerPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function reportNowCommand(options: ReportNowOptions = {}): Promise<void> {
  const running = await (options.daemonRunning ?? isDaemonRunning)();
  if (!running) {
    throw new Error('MAMA daemon is not running. Run: mama start');
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const headers = new Headers({ 'content-type': 'application/json' });
  const authToken = process.env.MAMA_AUTH_TOKEN || process.env.MAMA_SERVER_TOKEN;
  if (authToken) {
    headers.set('authorization', `Bearer ${authToken}`);
  }
  const response = await fetchImpl(`http://127.0.0.1:${API_PORT}/api/operator/report`, {
    method: 'POST',
    headers,
    body: '{}',
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const reason = typeof body.reason === 'string' ? body.reason : `HTTP ${response.status}`;
    throw new Error(`Report request was not accepted: ${reason}`);
  }

  const writeOut = options.writeOut ?? console.log;
  writeOut('✓ Report request accepted. Waiting for confirmed delivery...');
  const markerPath = join(options.mamaHome ?? getMAMAHome(), 'state', 'first-report.json');
  const maxWaitMs = options.maxWaitMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const deadline = Date.now() + maxWaitMs;
  let confirmedAt = readConfirmedAt(markerPath);
  let remaining = deadline - Date.now();
  while (!confirmedAt && remaining > 0) {
    await sleep(Math.min(pollIntervalMs, remaining));
    confirmedAt = readConfirmedAt(markerPath);
    remaining = deadline - Date.now();
  }
  if (confirmedAt) {
    writeOut(`✓ first report delivery confirmed at ${confirmedAt}`);
    return;
  }
  writeOut('report is still being generated — check Telegram shortly, or re-run: mama status');
}

export function createReportCommand(): Command {
  const report = new Command('report').description('Request and observe owner reports');
  report
    .command('now')
    .description('Request a full report and wait for confirmed delivery evidence')
    .action(async () => {
      await reportNowCommand();
    });
  return report;
}
