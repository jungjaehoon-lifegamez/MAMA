import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { constants, homedir } from 'node:os';
import * as yaml from 'js-yaml';
import { dirname, join } from 'node:path';
import { LOADABLE_CONNECTORS } from '../../connectors/index.js';
import { resolvePackageVersion } from '../../package-version.js';
import { CONFIG_KEYS } from '../../runtime/config.js';
import { CliInputError } from '../prompt.js';
import { CRASH_LOG_NAME } from '../launch-files.js';
import { BOOT_STAGES } from './daemon.js';
import { runDiagnostics, type Check, type DiagnosticsOptions } from '../runtime/diagnostics.js';

export interface DoctorOptions extends DiagnosticsOptions {
  write?: (line: string) => void;
}

const LOG_TAIL_BYTES = 2 * 1024 * 1024;
const ERROR_CODES = new Set(Object.keys(constants.errno));
const CONNECTORS = new Set<string>(LOADABLE_CONNECTORS);
const STAGES = new Set<string>(BOOT_STAGES);

/** The log's last lines; an unreadable log gives none (the logs check names the fault). */
function logTail(path: string): string[] | null {
  if (!existsSync(path)) return [];
  try {
    return readTail(path);
  } catch {
    return null;
  }
}

function readTail(path: string): string[] {
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

/** The config's top-level settings MAMA reads; names only, and a count of the rest. */
function configKeys(configPath: string): string {
  let value: unknown;
  try {
    value = yaml.load(readFileSync(configPath, 'utf8'));
  } catch {
    return '(config.yaml does not parse)';
  }
  if (value === null || typeof value !== 'object') return '(none)';
  const keys = Object.keys(value);
  const known = keys.filter((key) => (CONFIG_KEYS as readonly string[]).includes(key));
  const others = keys.length - known.length;
  return [
    known.join(', ') || '(none)',
    ...(others > 0 ? [`and ${others} other top-level key(s) it ignores`] : []),
  ].join(' ');
}

function enabledSources(root: string): string {
  const path = join(root, 'connectors.json');
  if (!existsSync(path)) return '(none)';
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, { enabled?: unknown }>;
    const names = Object.entries(value)
      .filter(([name, connector]) => CONNECTORS.has(name) && connector?.enabled === true)
      .map(([name]) => name);
    return names.join(', ') || '(none)';
  } catch {
    return '(connectors.json does not parse)';
  }
}

/** A boot stage record as daemon boot writes it, naming one of its stages; anything else is not. */
function bootStage(line: string): { name: string; failed: boolean } | null {
  const match = /\bboot stage=([a-z_:]+)(?: (failed) error=|\s*$)/.exec(line);
  return match && STAGES.has(match[1]) ? { name: match[1], failed: match[2] === 'failed' } : null;
}

/**
 * One log line reduced to what the program itself names: a failed boot stage, a known connector,
 * system error codes and an HTTP status. Message text, ids, names and paths never pass, whatever
 * their shape; so do log tags, since a continued message line can start with a bracketed word.
 */
function errorShape(line: string): string {
  const stage = bootStage(line);
  const connector = /\bconnector ([a-z][a-z0-9-]*)\b/.exec(line)?.[1];
  const codes = [
    ...new Set(
      (line.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) ?? []).filter((word) => ERROR_CODES.has(word))
    ),
  ];
  const http = /\b(?:HTTP|status) ([1-5]\d\d)\b/.exec(line)?.[1];
  return [
    stage?.failed && `boot stage=${stage.name} failed`,
    connector && CONNECTORS.has(connector) && `connector ${connector}`,
    ...codes,
    http && `HTTP ${http}`,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * A summary to attach to a bug report. It carries only what doctor and the program name: versions,
 * platform, setting and source names, the checks in doctor's own words, the last boot's stages and
 * the shape of recent errors. Paths, values, tokens, ids and message text are never read into it.
 */
export function doctorReport(checks: readonly Check[], options: DoctorOptions = {}): string {
  const home = options.home ?? homedir();
  const configPath = options.configPath ?? join(home, '.mama', 'config.yaml');
  const root = dirname(configPath);
  const tail = logTail(join(root, 'logs', 'daemon.log'));
  const lines = tail ?? [];
  const lastBoot = lines
    .map((line, index) => (/\bboot stage=config\b/.test(line) ? index : -1))
    .filter((index) => index >= 0)
    .at(-1);
  const bootStages =
    lastBoot === undefined
      ? []
      : lines.slice(lastBoot).flatMap((line) => {
          const stage = bootStage(line);
          return stage ? [`boot stage=${stage.name}${stage.failed ? ' failed' : ''}`] : [];
        });
  // A config that does not load, or a crash before the daemon writes its own log, is in the crash log.
  const crash = logTail(join(root, 'logs', CRASH_LOG_NAME)) ?? [];
  const errors = new Map<string, number>();
  for (const line of [...lines, ...crash].filter((line) =>
    /error|failed|fatal|uncaught/i.test(line)
  )) {
    const shape = errorShape(line) || '(no tag or code)';
    errors.set(shape, (errors.get(shape) ?? 0) + 1);
  }
  return [
    "MAMA doctor report (doctor's own words only; no paths, values, ids or message text)",
    `mama-os ${resolvePackageVersion()} on ${process.platform} ${process.arch}; doctor ran on node ${process.version} (the service's Node is in the node check)`,
    `config keys: ${configKeys(configPath)}`,
    `enabled sources: ${enabledSources(root)}`,
    '',
    'checks:',
    ...checks.map((check) => `  ${check.status} ${check.name}: ${check.detail}`),
    '',
    'last boot:',
    ...(bootStages.length > 0 ? bootStages.map((stage) => `  ${stage}`) : ['  (none in the log)']),
    '',
    tail === null
      ? 'recent errors: (daemon.log cannot be read)'
      : `recent errors (last ${LOG_TAIL_BYTES / 1024 / 1024} MB of daemon.log and crash.log):`,
    ...(tail === null
      ? []
      : errors.size > 0
        ? [...errors].map(([shape, count]) => `  ${count}x ${shape}`)
        : ['  (none)']),
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
    offline: flags.has('--offline'),
  });
  if (flags.has('--report')) {
    write(doctorReport(checks, options));
  } else if (flags.has('--json')) {
    write(JSON.stringify({ checks }));
  } else {
    for (const check of checks) {
      write(
        `${check.status.padEnd(4)} ${check.name}: ${check.detail}${check.context ? ` (${check.context})` : ''}`
      );
      if (check.fix && check.status !== 'ok') write(`     fix: ${check.fix}`);
    }
  }
  return checks.some((check) => check.status === 'fail') ? 1 : 0;
}
