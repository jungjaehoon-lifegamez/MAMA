import { CliInputError } from '../prompt.js';
import { lockHolder, type LockOwner } from '../runtime/daemon-control.js';
import {
  askDaemon,
  bootoutLaunchdService,
  installControlPaths,
  launchdServiceLoaded,
} from './daemon.js';

/** `mama status` exits 0 while the daemon runs and 3 when nothing serves the install. */
export const STATUS_STOPPED_EXIT = 3;

interface ControlOptions {
  home?: string;
  configPath?: string;
  write?: (line: string) => void;
  /** Milliseconds between checks while waiting for a stop; tests shorten it. */
  pollMs?: number;
}

function localTime(ms: unknown): string {
  return typeof ms === 'number' ? new Date(ms).toLocaleString('sv-SE') : 'unknown';
}

function holderLine(holder: LockOwner): string {
  return `${holder.command} (pid ${holder.pid}) holds the install`;
}

function statusLines(status: Record<string, unknown>): string[] {
  const lines = [
    `running: ${String(status.command)} (pid ${String(status.pid)}, version ${String(status.version)}, since ${localTime(status.startedAt)})`,
  ];
  if (status.stage !== 'running') lines.push(`boot stage: ${String(status.stage)}`);
  const turns = Array.isArray(status.runningTurns)
    ? (status.runningTurns as Array<{ session: string; count: number }>)
    : [];
  lines.push(
    turns.length === 0
      ? 'turns running: none'
      : `turns running: ${turns.map((turn) => `${turn.session} ${turn.count}`).join(', ')}`
  );
  const inputs = Array.isArray(status.inputs)
    ? (status.inputs as Array<{ status: string; count: number }>)
    : [];
  lines.push(
    inputs.length === 0
      ? 'inputs waiting: none'
      : `inputs waiting: ${inputs.map((input) => `${input.status} ${input.count}`).join(', ')}`
  );
  const connectors = Array.isArray(status.connectors)
    ? (status.connectors as Array<{
        name: string;
        healthy: boolean;
        lastPoll: string | null;
        error: string | null;
      }>)
    : [];
  for (const connector of connectors) {
    const poll = connector.lastPoll ? localTime(Date.parse(connector.lastPoll)) : 'not yet';
    lines.push(
      `connector ${connector.name}: ${connector.healthy ? 'ok' : 'failing'}, last poll ${poll}` +
        (connector.error ? `, error: ${connector.error}` : '')
    );
  }
  const lastError = status.lastError as { at: number; line: string } | null | undefined;
  if (lastError) lines.push(`last error ${localTime(lastError.at)}: ${lastError.line}`);
  return lines;
}

export async function runStatus(
  args: readonly string[],
  options: ControlOptions = {}
): Promise<number> {
  const json = args.length === 1 && args[0] === '--json';
  if (args.length > 1 || (args.length === 1 && !json)) {
    throw new CliInputError('Usage: mama status [--json]');
  }
  const write = options.write ?? ((line: string) => console.log(line));
  const service = launchdServiceLoaded() ? 'launchd' : null;
  const reply = await askDaemon('status', options);
  if (reply.state === 'stopped') {
    if (json) {
      write(JSON.stringify({ state: 'stopped', holder: reply.holder, service }));
    } else {
      write(reply.holder ? `stopped; ${holderLine(reply.holder)}` : 'stopped');
      if (service) write('service: launchd (loaded)');
    }
    return STATUS_STOPPED_EXIT;
  }
  if (reply.reply.ok !== true) {
    throw new CliInputError(`The daemon refused status: ${String(reply.reply.error)}`);
  }
  const status = reply.reply.status as Record<string, unknown>;
  if (json) {
    write(JSON.stringify({ state: 'running', status, service }));
  } else {
    for (const line of statusLines(status)) write(line);
    if (service) write('service: launchd (loaded)');
  }
  return 0;
}

async function waitUntilReleased(
  options: ControlOptions,
  write: (line: string) => void
): Promise<void> {
  const paths = installControlPaths(options);
  const pollMs = options.pollMs ?? 500;
  let waited = 0;
  for (;;) {
    const holder = lockHolder(paths);
    if (holder === null) return;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    waited += pollMs;
    if (waited % 30_000 < pollMs) write(`still stopping: ${holderLine(holder)}`);
  }
}

/**
 * Stop the install's daemon. A loaded LaunchAgent is unloaded, so KeepAlive does not restart it;
 * otherwise the control socket asks the daemon to stop. A running turn ends with the stop and its
 * input is requeued at the next start.
 */
export async function runStop(
  args: readonly string[],
  options: ControlOptions = {}
): Promise<number> {
  if (args.length !== 0) throw new CliInputError('Usage: mama stop');
  const write = options.write ?? ((line: string) => console.log(line));
  const status = await askDaemon('status', options);
  if (status.state === 'running' && status.reply.ok === true) {
    const turns = (status.reply.status as { runningTurns?: Array<{ count: number }> }).runningTurns;
    const count = (turns ?? []).reduce((sum, turn) => sum + turn.count, 0);
    if (count > 0) {
      write(`${count} turn(s) running; they end with the stop and are requeued at the next start`);
    }
  }
  if (launchdServiceLoaded()) {
    bootoutLaunchdService();
    await waitUntilReleased(options, write);
    write('stopped (launchd service unloaded; launchctl bootstrap starts it again)');
    return 0;
  }
  const reply = await askDaemon('stop', options);
  if (reply.state === 'stopped') {
    if (reply.holder) {
      write(`not stopped: ${holderLine(reply.holder)} and stops when it finishes`);
      return 1;
    }
    write('already stopped');
    return 0;
  }
  if (reply.reply.ok !== true) {
    write(`not stopped: ${String(reply.reply.error)}`);
    return 1;
  }
  write('stopping');
  await waitUntilReleased(options, write);
  write('stopped');
  return 0;
}
