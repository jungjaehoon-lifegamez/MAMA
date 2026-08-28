import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Command } from 'commander';

import { getMAMAHome } from '../config/config-manager.js';
import { API_PORT } from '../runtime/utilities.js';
import { isDaemonRunning } from '../utils/pid-manager.js';

type WriteLine = (line: string) => void;
const writeStdout: WriteLine = (line) => process.stdout.write(`${line}\n`);

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
  const markerPath = join(options.mamaHome ?? getMAMAHome(), 'state', 'first-report.json');
  const existingFirstReportAt = readConfirmedAt(markerPath);
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
  let body: Record<string, unknown>;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    if (response.ok) {
      throw new Error('Report request returned invalid JSON');
    }
    body = {};
  }
  if (!response.ok) {
    const reason = typeof body.reason === 'string' ? body.reason : `HTTP ${response.status}`;
    throw new Error(`Report request was not accepted: ${reason}`);
  }
  if (body.ok !== true || body.status !== 'accepted') {
    throw new Error('Report request returned an invalid acceptance response');
  }

  const writeOut = options.writeOut ?? writeStdout;
  writeOut('✓ Report request accepted. Waiting for confirmed delivery...');
  if (existingFirstReportAt) {
    writeOut(`✓ first report was already confirmed at ${existingFirstReportAt}`);
    writeOut('current request delivery is not individually tracked; check Telegram for arrival.');
    return;
  }
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
