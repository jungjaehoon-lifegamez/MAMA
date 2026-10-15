import { CliInputError } from '../prompt.js';
import { lockHolder, type LockOwner } from '../runtime/daemon-control.js';
import { askDaemon, bootoutLaunchdService, installControlPaths, launchdService } from './daemon.js';

/** `mama status` exits 0 while the daemon runs and 3 when nothing serves the install. */
export const STATUS_STOPPED_EXIT = 3;

interface ControlOptions {
  home?: string;
  configPath?: string;
  write?: (line: string) => void;
  /** Milliseconds between checks while waiting for a stop; tests shorten it. */
  pollMs?: number;
  /** How long `mama stop` waits for the install to be released. */
  timeoutMs?: number;
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
  const service = launchdService().loaded ? 'launchd' : null;
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

type StopOutcome =
  | { kind: 'released' }
  | { kind: 'replaced'; holder: LockOwner }
  | { kind: 'timeout'; holder: LockOwner };

/**
 * Wait until the stopped holder's lock is gone. A different holder appearing means something
 * started in its place, such as a service manager restarting the daemon; that is not a stop.
 */
async function waitForRelease(
  stopping: LockOwner,
  options: ControlOptions,
  write: (line: string) => void
): Promise<StopOutcome> {
  const paths = installControlPaths(options);
  const pollMs = options.pollMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const started = Date.now();
  let reported = started;
  for (;;) {
    const holder = lockHolder(paths);
    if (holder === null) return { kind: 'released' };
    if (holder.nonce !== stopping.nonce) return { kind: 'replaced', holder };
    if (Date.now() - started >= timeoutMs) return { kind: 'timeout', holder };
    if (Date.now() - reported >= 30_000) {
      write(`still stopping: ${holderLine(holder)}`);
      reported = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function finish(outcome: StopOutcome, write: (line: string) => void, done: string): number {
  if (outcome.kind === 'released') {
    write(done);
    return 0;
  }
  if (outcome.kind === 'replaced') {
    write(`stopped, but ${holderLine(outcome.holder)} now: something started it again`);
    return 1;
  }
  write(`not stopped yet: ${holderLine(outcome.holder)}; check mama status`);
  return 1;
}

/**
 * Stop the install's daemon. A daemon run by a loaded LaunchAgent is unloaded, so KeepAlive does
 * not restart it; any other daemon is asked through the control socket. A replay, backfill or
 * register-owner is left to finish. A running turn is interrupted; at the next start MAMA delivers
 * its stored result or tells its sender that it was interrupted.
 */
export async function runStop(
  args: readonly string[],
  options: ControlOptions = {}
): Promise<number> {
  if (args.length !== 0) throw new CliInputError('Usage: mama stop');
  const write = options.write ?? ((line: string) => console.log(line));
  const holder = lockHolder(installControlPaths(options));
  const service = launchdService();
  if (holder === null) {
    if (service.loaded) {
      // Loaded but holding nothing: unload it so it does not start again.
      bootoutLaunchdService();
      write('stopped (launchd service unloaded)');
      return 0;
    }
    write('already stopped');
    return 0;
  }
  if (holder.command !== 'daemon') {
    write(`not stopped: ${holderLine(holder)} and stops when it finishes`);
    return 1;
  }
  if (service.loaded && service.pid === holder.pid) {
    bootoutLaunchdService();
    return finish(
      await waitForRelease(holder, options, write),
      write,
      'stopped (launchd service unloaded; launchctl bootstrap starts it again)'
    );
  }
  const reply = await askDaemon('stop', options);
  if (reply.state === 'stopped') {
    write(`not stopped: ${holderLine(holder)} does not answer on its control socket`);
    return 1;
  }
  if (reply.reply.ok !== true) {
    write(`not stopped: ${String(reply.reply.error)}`);
    return 1;
  }
  write('stopping');
  return finish(await waitForRelease(holder, options, write), write, 'stopped');
}
