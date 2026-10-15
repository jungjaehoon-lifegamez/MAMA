import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import * as yaml from 'js-yaml';
import { dirname, join } from 'node:path';
import { resolvePackageVersion } from '../../package-version.js';
import { CliInputError } from '../prompt.js';
import {
  redact,
  runDiagnostics,
  type Check,
  type DiagnosticsOptions,
} from '../runtime/diagnostics.js';

export interface DoctorOptions extends DiagnosticsOptions {
  write?: (line: string) => void;
}

const LOG_TAIL_BYTES = 2 * 1024 * 1024;

function logTail(path: string): string[] {
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  const length = Math.min(size, LOG_TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buffer, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  return buffer.toString('utf8').split('\n');
}

/** The config's top-level key names; values never enter the report. */
function configKeys(configPath: string): string[] {
  try {
    const value = yaml.load(readFileSync(configPath, 'utf8'));
    return value !== null && typeof value === 'object' ? Object.keys(value) : [];
  } catch {
    return ['(config.yaml does not parse)'];
  }
}

function enabledConnectors(root: string): string[] {
  const path = join(root, 'connectors.json');
  if (!existsSync(path)) return [];
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, { enabled?: unknown }>;
    return Object.entries(value)
      .filter(([, connector]) => connector?.enabled === true)
      .map(([name]) => name);
  } catch {
    return ['(connectors.json does not parse)'];
  }
}

/**
 * A summary to attach to a bug report: versions, platform, which settings and sources exist, the
 * checks, the last boot and recent errors. No values, tokens, ids or message text.
 */
export function doctorReport(checks: readonly Check[], options: DoctorOptions = {}): string {
  const home = options.home ?? homedir();
  const configPath = options.configPath ?? join(home, '.mama', 'config.yaml');
  const root = dirname(configPath);
  const lines = logTail(join(root, 'logs', 'daemon.log'));
  const lastBoot = lines
    .map((line, index) => (/boot stage=config\b/.test(line) ? index : -1))
    .filter((i) => i >= 0)
    .at(-1);
  const bootLines =
    lastBoot === undefined
      ? []
      : lines.slice(lastBoot).filter((line) => /boot stage=|document toolkit:/.test(line));
  const errors = lines.filter((line) => /error|failed|fatal|uncaught/i.test(line)).slice(-20);
  return [
    'MAMA doctor report (values, tokens, ids and message text removed)',
    `mama-os ${resolvePackageVersion()}, node ${process.version}, ${process.platform} ${process.arch}`,
    `config keys: ${configKeys(configPath).join(', ') || '(none)'}`,
    `enabled sources: ${enabledConnectors(root).join(', ') || '(none)'}`,
    '',
    'checks:',
    ...checks.map((check) => `  ${check.status} ${check.name}: ${redact(check.detail, home)}`),
    '',
    'last boot:',
    ...(bootLines.length > 0
      ? bootLines.map((line) => `  ${redact(line, home)}`)
      : ['  (none in the log)']),
    '',
    'recent errors:',
    ...(errors.length > 0 ? errors.map((line) => `  ${redact(line, home)}`) : ['  (none)']),
    '',
  ].join('\n');
}

/** `mama doctor [--json] [--offline] [--report]`: exits 1 when a check fails. */
export async function runDoctor(
  args: readonly string[],
  options: DoctorOptions = {}
): Promise<number> {
  const flags = new Set(args);
  for (const flag of flags) {
    if (!['--json', '--offline', '--report'].includes(flag)) {
      throw new CliInputError('Usage: mama doctor [--json] [--offline] [--report]');
    }
  }
  const write = options.write ?? ((line: string) => console.log(line));
  const checks = await runDiagnostics({
    ...options,
    ...(flags.has('--offline') ? { telegramCall: null } : {}),
  });
  if (flags.has('--report')) {
    write(doctorReport(checks, options));
  } else if (flags.has('--json')) {
    write(JSON.stringify({ checks }));
  } else {
    for (const check of checks) {
      write(`${check.status.padEnd(4)} ${check.name}: ${check.detail}`);
      if (check.fix && check.status !== 'ok') write(`     fix: ${check.fix}`);
    }
  }
  return checks.some((check) => check.status === 'fail') ? 1 : 0;
}
